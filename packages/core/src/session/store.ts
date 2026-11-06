// 将本模块以命名空间 `SessionStore` 全量导出
export * as SessionStore from "./store.js"

// 引入 drizzle-orm 的条件与排序构造器及 SQL 类型
import { and, asc, desc, eq, gt, isNotNull, isNull, like, lt, notInArray, or, sql, type SQL } from "drizzle-orm"
// 引入 Effect 原语：服务容器、核心原语、层与 Schema
import { Context, Effect, Layer, Schema } from "effect"
// 引入项目（Project）schema
import { Project } from "@opencode/schema/project"
// 引入工作区（Workspace）schema
import { Workspace } from "@opencode/schema/workspace"
// 引入绝对路径、正整数、相对路径等基础 schema
import { AbsolutePath, PositiveInt, RelativePath } from "@opencode/schema/schema"
// 引入数据库服务
import { Database } from "../database/database.js"
// 引入全局服务节点构造工具
import { makeGlobalNode } from "@opencode/util/effect/app-node"
// 引入会话历史（消息行解码）模块
import { SessionHistory } from "./history.js"
// 引入消息解码错误类型
import { MessageDecodeError } from "./error.js"
// 引入会话消息模块
import { SessionMessage } from "./message.js"
// 引入会话 schema
import { Session } from "@opencode/schema/session"
// 引入会话表与消息表定义
import { SessionMessageTable, SessionTable } from "./sql.js"
// 引入数据库行到会话信息的转换函数
import { fromRow } from "./info.js"

// 列表输入的公共字段：工作区/搜索/分页/排序/父会话/归档/锚点
const ListInputBase = {
  // 按工作区过滤（可选）
  workspaceID: Workspace.ID.pipe(Schema.optional),
  // 按标题模糊搜索（可选）
  search: Schema.String.pipe(Schema.optional),
  // 分页大小（正整数，可选）
  limit: PositiveInt.pipe(Schema.optional),
  // 排序方向：asc/desc（可选）
  order: Schema.Literals(["asc", "desc"]).pipe(Schema.optional),
  // 按父会话过滤；null 表示仅顶层会话（可选）
  parentID: Schema.NullOr(Session.ID).pipe(Schema.optional),
  // 按归档状态过滤（可选）
  archived: Schema.Boolean.pipe(Schema.optional),
  // 稳定分页锚点：更新时间 + 会话 ID（可选）
  anchor: Session.ListAnchor.pipe(Schema.optional),
}

// 按目录列出会话的输入：公共字段 + 绝对路径目录
const ListDirectoryInput = Schema.Struct({
  ...ListInputBase,
  directory: AbsolutePath,
})

// 按项目列出会话的输入：公共字段 + 项目 ID（可带子路径）
const ListProjectInput = Schema.Struct({
  ...ListInputBase,
  project: Project.ID,
  subpath: RelativePath.pipe(Schema.optional),
})

// 全量列出会话的输入：仅公共字段
const ListAllInput = Schema.Struct(ListInputBase)

// 三种列表输入的联合 schema
export const ListInput = Schema.Union([ListDirectoryInput, ListProjectInput, ListAllInput])
// ListInput 的解码后类型
export type ListInput = typeof ListInput.Type

// 消息查询输入：会话、分页、排序与类型过滤
export type MessagesInput = {
  // 目标会话 ID
  sessionID: Session.ID
  // 分页大小（可选）
  limit?: number
  // 排序方向（可选）
  order?: "asc" | "desc"
  // 按消息类型过滤（可选）
  type?: SessionMessage.Type
  // 游标：以某条消息为锚向前/向后翻页（可选）
  cursor?: {
    id: SessionMessage.ID
    direction: "previous" | "next"
  }
}

// 服务接口：会话与消息的持久化读取，以及执行声明（claim）的记账
export interface Interface {
  // 按 ID 读取单个会话
  readonly get: (sessionID: Session.ID) => Effect.Effect<Session.Info | undefined>
  // 按条件列出会话（支持锚点分页）
  readonly list: (input?: ListInput) => Effect.Effect<Session.Info[]>
  // 读取会话消息（媒体已内联展开）
  readonly messages: (input: MessagesInput) => Effect.Effect<SessionMessage.Info[], MessageDecodeError>
  // 加载会话的最新上下文消息
  readonly context: (sessionID: Session.ID) => Effect.Effect<SessionMessage.Info[], MessageDecodeError>
  // 按消息 ID 读取单条消息（附带所属会话 ID）
  readonly message: (
    messageID: SessionMessage.ID,
  ) => Effect.Effect<{ readonly sessionID: Session.ID; readonly message: SessionMessage.Info } | undefined>
  /** {@link Interface.messages} for clients that fetch media themselves: files stored in `blob` stay `media:` refs. */
  readonly messagesWithRefs: (input: MessagesInput) => Effect.Effect<SessionMessage.MediaInfo[], MessageDecodeError>
  /** {@link Interface.message} for clients that fetch media themselves. */
  readonly messageWithRefs: (
    messageID: SessionMessage.ID,
  ) => Effect.Effect<{ readonly sessionID: Session.ID; readonly message: SessionMessage.MediaInfo } | undefined>
  /**
   * Top-level Sessions holding an execution claim. Recoverable background
   * children are resumed separately through their durable Job records.
   */
  readonly listSuspended: () => Effect.Effect<ReadonlyArray<Session.ID>>
  /**
   * Records the execution claim: the durable write-ahead intent that a turn is
   * (or was) in flight. Set when execution starts; a claim that survives to the
   * next boot marks a turn that never completed — its process crashed or shut
   * down mid-turn.
   */
  readonly claim: (sessionID: Session.ID) => Effect.Effect<void>
  /** Releases the claim and resets resume accounting. Terminal events call this on commit. */
  readonly release: (sessionID: Session.ID) => Effect.Effect<void>
  /**
   * Clears orphaned child claims except children owned by recoverable
   * background subagent jobs.
   */
  readonly releaseChildClaims: (recoverable: ReadonlyArray<Session.ID>) => Effect.Effect<void>
  /**
   * Durably counts one more resume of an orphaned claim, returning the new
   * total — or undefined when the Session no longer exists.
   */
  readonly countResume: (sessionID: Session.ID) => Effect.Effect<number | undefined>
}

// 定义可注入的服务标识（Context.Tag）
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionStore") {}

// 构建服务实现层
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 取数据库句柄
    const { db } = yield* Database.Service

    /** One page of a session's message rows, oldest first within the page when paging backwards. */
    // 查询一个会话的一页消息原始行（游标分页的公共实现）
    const messageRows = Effect.fnUntraced(function* (input: MessagesInput) {
      // 翻页方向：默认向后（next，更新的一侧）
      const direction = input.cursor?.direction ?? "next"
      // 用户请求的排序：默认新→旧（desc）
      const requestedOrder = input.order ?? "desc"
      // 实际查询排序：向前翻页时反转让 SQL 与游标语义一致
      const order = direction === "previous" ? (requestedOrder === "asc" ? "desc" : "asc") : requestedOrder
      // 有游标时：查出锚点消息的 seq 作为边界依据
      const anchor = input.cursor
        ? yield* db
            .select({ seq: SessionMessageTable.seq })
            .from(SessionMessageTable)
            .where(
              and(eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.id, input.cursor.id)),
            )
            .get()
            .pipe(Effect.orDie)
        : undefined
      // 游标指向的消息不存在：返回空页
      if (input.cursor && !anchor) return []
      // 以锚点 seq 构造边界条件：升序取其后（gt），降序取其前（lt）
      const boundary = anchor
        ? order === "asc"
          ? gt(SessionMessageTable.seq, anchor.seq)
          : lt(SessionMessageTable.seq, anchor.seq)
        : undefined
      // 组装查询：会话过滤 + 边界 + 可选的类型过滤，按 seq 排序
      const query = db
        .select()
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.session_id, input.sessionID),
            boundary,
            input.type === undefined ? undefined : eq(SessionMessageTable.type, input.type),
          ),
        )
        .orderBy(order === "asc" ? asc(SessionMessageTable.seq) : desc(SessionMessageTable.seq))
      // 执行查询（有 limit 时分页），失败视为致命
      const rows = yield* (input.limit === undefined ? query.all() : query.limit(input.limit).all()).pipe(Effect.orDie)
      // 向前翻页时把行反转回用户请求的顺序
      return direction === "previous" ? rows.toReversed() : rows
    })

    // 按消息 ID 取单条原始行（辅助函数）
    const messageRow = (messageID: SessionMessage.ID) =>
      db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, messageID)).get().pipe(Effect.orDie)

    // 组装并返回服务实现
    return Service.of({
      // 按 ID 查询单个会话并转换为 Info
      get: Effect.fnUntraced(function* (sessionID) {
        // 查询会话行
        const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
        // 行存在则转换，否则返回 undefined
        return row ? fromRow(row) : undefined
      }),
      // 按条件列出会话
      list: Effect.fn("SessionStore.list")(function* (input = {}) {
        // 翻页方向：默认向后
        const direction = input.anchor?.direction ?? "next"
        // 用户请求的排序：默认 desc
        const requestedOrder = input.order ?? "desc"
        // 实际查询排序：向前翻页时反转
        const order = direction === "previous" ? (requestedOrder === "asc" ? "desc" : "asc") : requestedOrder
        // 列表排序与锚点均基于更新时间列
        const sortColumn = SessionTable.time_updated
        // 收集过滤条件
        const conditions: SQL[] = []
        // 按目录精确过滤
        if ("directory" in input) conditions.push(eq(SessionTable.directory, input.directory))
        // 按工作区过滤
        if (input.workspaceID) conditions.push(eq(SessionTable.workspace_id, input.workspaceID))
        // 按项目过滤
        if ("project" in input) conditions.push(eq(SessionTable.project_id, input.project))
        // 项目 + 子路径时再按路径精确过滤
        if ("project" in input && input.subpath !== undefined) conditions.push(eq(SessionTable.path, input.subpath))
        // 标题 LIKE 模糊搜索
        if (input.search) conditions.push(like(SessionTable.title, `%${input.search}%`))
        // 父会话过滤：null 仅取顶层会话，否则精确匹配父 ID
        if (input.parentID !== undefined)
          conditions.push(
            input.parentID === null ? isNull(SessionTable.parent_id) : eq(SessionTable.parent_id, input.parentID),
          )
        // 归档过滤：true 取已归档（归档时间非空），false 取未归档
        if (input.archived !== undefined)
          conditions.push(input.archived ? isNotNull(SessionTable.time_archived) : isNull(SessionTable.time_archived))
        // 锚点条件：更新时间相等时用会话 ID 决胜，保证分页稳定不重不漏
        if (input.anchor) {
          conditions.push(
            order === "asc"
              ? or(
                  gt(sortColumn, input.anchor.time),
                  and(eq(sortColumn, input.anchor.time), gt(SessionTable.id, input.anchor.id)),
                )!
              : or(
                  lt(sortColumn, input.anchor.time),
                  and(eq(sortColumn, input.anchor.time), lt(SessionTable.id, input.anchor.id)),
                )!,
          )
        }
        // 组装查询：合并条件并按更新时间 + ID 两级排序
        const query = db
          .select()
          .from(SessionTable)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(
            order === "asc" ? asc(sortColumn) : desc(sortColumn),
            order === "asc" ? asc(SessionTable.id) : desc(SessionTable.id),
          )
        // 执行查询（有 limit 时分页）
        const rows = yield* (input.limit === undefined ? query.all() : query.limit(input.limit).all()).pipe(
          Effect.orDie,
        )
        // 向前翻页先反转，再统一转换为 Info
        return (direction === "previous" ? rows.toReversed() : rows).map((row) => fromRow(row))
      }),
      // 读取会话消息（媒体内联展开）
      messages: Effect.fn("SessionStore.messages")(function* (input) {
        // 取原始行后交给历史模块解码
        return yield* SessionHistory.decodeMessageRows(db, yield* messageRows(input))
      }),
      // 读取会话消息（媒体保留 media: 引用，由客户端自行取用）
      messagesWithRefs: Effect.fn("SessionStore.messagesWithRefs")(function* (input) {
        // 取原始行后交给历史模块的带引用解码
        return yield* SessionHistory.decodeMessageRowsWithRefs(db, yield* messageRows(input))
      }),
      // 加载会话的最新上下文
      context: Effect.fn("SessionStore.context")((sessionID) => SessionHistory.load(db, sessionID, "latest")),
      // 按消息 ID 查询单条消息
      message: Effect.fn("SessionStore.message")(function* (messageID) {
        // 取原始行
        const row = yield* messageRow(messageID)
        // 消息不存在
        if (!row) return undefined
        // 解码消息行（解码错误视为致命）
        const [message] = yield* SessionHistory.decodeMessageRows(db, [row]).pipe(Effect.orDie)
        // 返回消息及其所属会话（message 可能因过滤为空）
        return message && { sessionID: row.session_id, message }
      }),
      // 按消息 ID 查询单条消息（媒体保留引用）
      messageWithRefs: Effect.fn("SessionStore.messageWithRefs")(function* (messageID) {
        // 取原始行
        const row = yield* messageRow(messageID)
        // 消息不存在
        if (!row) return undefined
        // 带引用解码消息行
        const [message] = yield* SessionHistory.decodeMessageRowsWithRefs(db, [row]).pipe(Effect.orDie)
        // 返回消息及其所属会话
        return message && { sessionID: row.session_id, message }
      }),
      // 列出持有执行声明的顶层会话（可恢复的后台子会话另由 Job 记录处理）
      listSuspended: Effect.fn("SessionStore.listSuspended")(function* () {
        // 查询：声明时间非空且无父会话
        return yield* db
          .select({ sessionID: SessionTable.id })
          .from(SessionTable)
          .where(and(isNotNull(SessionTable.time_suspended), isNull(SessionTable.parent_id)))
          .all()
          .pipe(
            Effect.orDie,
            // 只保留会话 ID 列表
            Effect.map((rows) => rows.map((row) => row.sessionID)),
          )
      }),
      // 记录执行声明（execution claim）：写入声明时间戳
      claim: Effect.fn("SessionStore.claim")(function* (sessionID) {
        // The null guard makes re-claiming a still-claimed Session a zero-row
        // no-op (a resumed turn re-claims through the same started hook).
        // Claim bookkeeping never counts as user activity: time_updated is
        // pinned so session ordering only moves on real changes.
        // 更新声明时间：仅当尚未声明时生效；time_updated 原样保留，声明不扰动排序
        yield* db
          .update(SessionTable)
          .set({ time_suspended: Date.now(), time_updated: sql`${SessionTable.time_updated}` })
          .where(and(eq(SessionTable.id, sessionID), isNull(SessionTable.time_suspended)))
          .run()
          .pipe(Effect.orDie)
      }),
      // 释放执行声明并清零恢复尝试计数
      release: Effect.fn("SessionStore.release")(function* (sessionID) {
        // 更新：清空声明时间与尝试次数；time_updated 原样保留
        yield* db
          .update(SessionTable)
          .set({ time_suspended: null, resume_attempts: 0, time_updated: sql`${SessionTable.time_updated}` })
          .where(eq(SessionTable.id, sessionID))
          .run()
          .pipe(Effect.orDie)
      }),
      // 释放所有子会话的孤儿声明（可恢复的后台任务除外）
      releaseChildClaims: Effect.fn("SessionStore.releaseChildClaims")((recoverable) =>
        // 更新：有父会话且已声明的行，排除可恢复的会话 ID
        db
          .update(SessionTable)
          .set({ time_suspended: null, resume_attempts: 0, time_updated: sql`${SessionTable.time_updated}` })
          .where(
            and(
              isNotNull(SessionTable.time_suspended),
              isNotNull(SessionTable.parent_id),
              recoverable.length > 0 ? notInArray(SessionTable.id, Array.from(recoverable)) : undefined,
            ),
          )
          .run()
          .pipe(Effect.orDie, Effect.asVoid),
      ),
      // 原子地累加一次恢复尝试计数并返回新值
      countResume: Effect.fn("SessionStore.countResume")(function* (sessionID) {
        // UPDATE ... RETURNING：一条语句完成累加与读取
        const row = yield* db
          .update(SessionTable)
          .set({
            resume_attempts: sql`${SessionTable.resume_attempts} + 1`,
            time_updated: sql`${SessionTable.time_updated}`,
          })
          .where(eq(SessionTable.id, sessionID))
          .returning({ attempts: SessionTable.resume_attempts })
          .get()
          .pipe(Effect.orDie)
        // 会话不存在（未命中行）时返回 undefined
        return row?.attempts
      }),
    })
  }),
)

// 全局服务节点：声明依赖数据库节点
export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
