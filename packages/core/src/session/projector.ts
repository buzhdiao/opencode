// 将本模块以命名空间形式整体导出为 SessionProjector，供其他模块按需引用
export * as SessionProjector from "./projector.js"

// immer：以「草稿（draft）」方式安全生成不可变数据的新副本
import { castDraft, produce, type WritableDraft } from "immer"
// drizzle-orm 的 SQL 构造器：and/or 逻辑组合、asc/desc 排序、eq 等值、大小比较、inArray 集合、isNull 空值、sql 原生片段
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm"
// effect：Effect 效果运行时、Layer 依赖注入层、Option 可选值、Schema 编解码、Stream 流、DateTime 时间
import { DateTime, Effect, Layer, Option, Schema, Stream } from "effect"
// Node 的 path 模块：路径解析与相对化
import path from "path"
// 配置服务：读取 experimental.part_rows 等配置项
import { Config } from "../config.js"
// 数据库服务：提供底层 SQLite 连接句柄
import { Database } from "../database/database.js"
// 数据库批量写入工具：把大数组切成合法大小的插入批次
import { DatabaseBatch } from "../database/batch.js"
// 进程内事件总线：负责事件投影（project）与订阅（subscribe）
import { Bus } from "../bus.js"
// Effect 全局节点工具：为本服务创建可组合的启动节点
import { makeGlobalNode } from "@opencode/util/effect/app-node"
// 模型引用（Model.Ref）模式：校验会话上记录的模型信息
import { Model } from "@opencode/schema/model"
// 会话事件定义：各类持久化事件的载荷与类型标识
import { SessionEvent } from "./event.js"
// 会话消息模式：消息 ID 与各类消息结构
import { SessionMessage } from "./message.js"
// 消息更新器：按事件驱动消息/部件的读写适配器
import { SessionMessageUpdater } from "./message-updater.js"
// 会话收件箱：处理排队投递到会话的消息
import { SessionInbox } from "./inbox.js"
// 指令状态：维护指令条目的应用/回退等状态
import { InstructionState } from "./instruction-state.js"
// 会话二进制大对象（Blob）存储：把内联媒体外置并登记引用
import { SessionBlob } from "./blob.js"
// 会话相关 SQL 表：会话表、消息表、部件表、收件箱表及部件数据类型
import { SessionInboxTable, SessionMessageTable, SessionPartTable, SessionTable, type SessionPartData } from "./sql.js"
// SessionStored.User：用户消息的持久化形态模式
import { SessionStored } from "./stored.js"
// 指令条目：会话创建/分叉时初始化指令
import { InstructionEntry } from "./instruction-entry.js"
// drizzle 更新语句 set 值的类型，用于强类型化的 update set
import type { SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core/query-builders/update"
// Slug：生成短随机标识（会话 slug）
import { Slug } from "../util/slug.js"
// 文件系统工具：目录包含关系等路径判断
import { FSUtil } from "@opencode/util/fs-util"
// Money：金额构造（美元）
import { Money } from "@opencode/schema/money"
// TokenUsage：令牌（token）用量统计结构
import type { TokenUsage } from "@opencode/schema/token-usage"
// 工作树（worktree）事件：目录身份重新识别时采用会话
import { Worktree } from "@opencode/schema/worktree"
// 项目（Project）模式与全局项目 ID
import { Project } from "@opencode/schema/project"
// 绝对路径/相对路径品牌类型
import { AbsolutePath, RelativePath } from "../schema.js"
// 会话自身的 Schema 定义（如 ID 类型）
import type { SessionSchema } from "./schema.js"
// 会话历史读取工具：解码消息行、按需拼装部件
import { SessionHistory } from "./history.js"
// 项目表：关联查询项目规范工作树路径
import { ProjectTable } from "../project/sql.js"

// 数据库服务类型：从 Database.Interface 中取出的 db 句柄类型
type DatabaseService = Database.Interface["db"]
// 消息类事件：排除 Forked 与 Deleted 后的持久化事件（这两类有专门的投影逻辑）
type MessageEvent = Exclude<
  SessionEvent.DurableEvent,
  typeof SessionEvent.Forked.Type | typeof SessionEvent.Deleted.Type
>

// 把 SessionMessage.Info 模式编译为同步编码器：消息对象 → 持久化 JSON 结构
const encodeMessage = Schema.encodeSync(SessionMessage.Info)
// 把 SessionStored.User 模式编译为同步编码器：用户消息 → 持久化 JSON 结构
const encodeStoredUser = Schema.encodeSync(SessionStored.User)

// 会话已被投影过（重复的 Created/Forked 事件）时抛出的错误
export class SessionAlreadyProjected extends Error {}

// 用量（Usage）结构：费用与令牌用量
type Usage = {
  cost: number
  tokens: TokenUsage.Info
}

// 分叉（fork）时每批复制的消息行数上限
const ForkBatchSize = 500

// 批量插入部件（part）行：先用 DatabaseBatch 切批，再逐批执行 insert
const insertParts = (db: DatabaseService, rows: ReadonlyArray<typeof SessionPartTable.$inferInsert>) =>
  Effect.forEach(
    DatabaseBatch.insertBatches(SessionPartTable, rows),
    // 逐批写入；数据库失败视为不可恢复的致命缺陷（orDie）
    (batch) => db.insert(SessionPartTable).values(batch).run().pipe(Effect.orDie),
    // discard: true 表示不收集每次插入的结果
    { discard: true },
  )

// 根据父会话标题生成分叉标题：已有 "(fork #n)" 后缀则 n+1，否则追加 "(fork #1)"
const forkTitle = (value?: string) => {
  // 无标题则不生成
  if (value === undefined) return
  // 匹配形如 "xxx (fork #N)" 的既有分叉标题
  const match = value.match(/^(.+) \(fork #(\d+)\)$/)
  // 命中则把分叉序号加一
  if (match) return `${match[1]} (fork #${Number.parseInt(match[2], 10) + 1})`
  // 首次分叉：标题追加 (fork #1)
  return `${value} (fork #1)`
}

// 按会话 ID 更新会话表的通用辅助函数，values 为要写入的列集合
function setSession(
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  values: SQLiteUpdateSetSource<typeof SessionTable>,
) {
  // 执行 update 并立即运行；数据库异常用 orDie 升级为致命缺陷
  return db.update(SessionTable).set(values).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
}

// 把一次用量（费用与各类 token 数）原子累加到会话表；可选 timeUpdated 指定更新时间
function applyUsage(db: DatabaseService, sessionID: SessionSchema.ID, value: Usage, timeUpdated?: number) {
  // 每个字段都用 sql 片段做「原值 + 增量」的累加
  return setSession(db, sessionID, {
    // 费用累加
    cost: sql`${SessionTable.cost} + ${value.cost}`,
    // 输入 token 累加
    tokens_input: sql`${SessionTable.tokens_input} + ${value.tokens.input}`,
    // 输出 token 累加
    tokens_output: sql`${SessionTable.tokens_output} + ${value.tokens.output}`,
    // 推理 token 累加
    tokens_reasoning: sql`${SessionTable.tokens_reasoning} + ${value.tokens.reasoning}`,
    // 缓存读 token 累加
    tokens_cache_read: sql`${SessionTable.tokens_cache_read} + ${value.tokens.cache.read}`,
    // 缓存写 token 累加
    tokens_cache_write: sql`${SessionTable.tokens_cache_write} + ${value.tokens.cache.write}`,
    // 未指定更新时间时保持原 time_updated 不变
    time_updated: timeUpdated ?? sql`${SessionTable.time_updated}`,
  })
}

// 仅刷新会话的更新时间（touch），用于标记会话有活动
function touch(db: DatabaseService, event: MessageEvent) {
  // 把 time_updated 设为事件创建时间
  return setSession(db, event.data.sessionID, { time_updated: event.created })
}

// 读取会话表中的累计用量并发布 UsageUpdated 事件（对外广播费用与 token 统计）
const publishSessionUsage = Effect.fn("SessionProjector.publishUsage")(function* (
  db: DatabaseService,
  bus: Bus.Interface,
  sessionID: SessionSchema.ID,
) {
  // 查询会话的费用与各 token 计数
  const row = yield* db
    .select({
      cost: SessionTable.cost,
      input: SessionTable.tokens_input,
      output: SessionTable.tokens_output,
      reasoning: SessionTable.tokens_reasoning,
      cacheRead: SessionTable.tokens_cache_read,
      cacheWrite: SessionTable.tokens_cache_write,
    })
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID))
    .get()
    .pipe(Effect.orDie)
  // 会话不存在则无需发布
  if (!row) return
  // 发布 UsageUpdated：费用用 Money.USD 构造，token 分输入/输出/推理/缓存
  yield* bus.publish(SessionEvent.UsageUpdated, {
    sessionID,
    cost: Money.USD.make(row.cost),
    tokens: {
      input: row.input,
      output: row.output,
      reasoning: row.reasoning,
      cache: { read: row.cacheRead, write: row.cacheWrite },
    },
  })
})

// 投影「分叉」事件：把父会话的既有历史复制为新会话的初始消息与部件
const projectFork = Effect.fn("SessionProjector.projectFork")(function* (
  db: DatabaseService,
  event: typeof SessionEvent.Forked.Type,
) {
  // 查询父会话行
  const parent = yield* db
    .select()
    .from(SessionTable)
    .where(eq(SessionTable.id, event.data.parentID))
    .get()
    .pipe(Effect.orDie)
  // 父会话缺失属于不可恢复的数据错误
  if (!parent) return yield* Effect.die(new Error(`Fork parent session not found: ${event.data.parentID}`))
  // 查询分叉边界消息的序号（seq），确定复制范围
  const boundary = yield* db
    .select({ seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, event.data.parentID),
        eq(SessionMessageTable.id, event.data.boundary.messageID),
      ),
    )
    .get()
    .pipe(Effect.orDie)
  // 边界消息缺失同样致命
  if (!boundary)
    return yield* Effect.die(new Error(`Fork boundary message not found: ${event.data.boundary.messageID}`))
  // 取被复制范围内最后一条消息的 seq：before 为严格小于，其他为小于等于
  const copied = yield* db
    .select({ seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, event.data.parentID),
        event.data.boundary.type === "before"
          ? lt(SessionMessageTable.seq, boundary.seq)
          : lte(SessionMessageTable.seq, boundary.seq),
      ),
    )
    .orderBy(desc(SessionMessageTable.seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  // 被复制范围的最大 seq；可能为 undefined（没有可复制内容）
  const copiedSeq = copied?.seq

  // 插入新会话行：继承父会话的归属与环境信息，费用与 token 归零
  const stored = yield* db
    .insert(SessionTable)
    .values({
      // 新会话使用事件携带的 ID
      id: event.data.sessionID,
      // 分叉出的会话没有父会话指针
      parent_id: null,
      // 记录来源父会话 ID，便于追溯
      fork_session_id: event.data.parentID,
      // 记录分叉边界（消息与类型）
      fork_boundary: event.data.boundary,
      // 沿用父会话的项目
      project_id: parent.project_id,
      // 沿用父会话的工作区
      workspace_id: parent.workspace_id,
      // 生成新的 slug
      slug: Slug.create(),
      // 目录与子路径沿用父会话
      directory: parent.directory,
      path: parent.path,
      // 标题按 fork #n 规则递增
      title: forkTitle(parent.title ?? undefined),
      // 代理/模型/元数据/权限/版本沿用父会话
      agent: parent.agent,
      model: parent.model,
      metadata: parent.metadata,
      permission: parent.permission,
      version: parent.version,
      // 费用与 token 从零开始统计
      cost: 0,
      tokens_input: 0,
      tokens_output: 0,
      tokens_reasoning: 0,
      tokens_cache_read: 0,
      tokens_cache_write: 0,
      // 创建/更新时间取事件时间
      time_created: event.created,
      time_updated: event.created,
    })
    // 幂等：同 ID 会话已存在则不重复插入
    .onConflictDoNothing()
    .returning({ sessionID: SessionTable.id })
    .get()
    .pipe(Effect.orDie)
  // 未插入成功说明该会话已被投影过
  if (!stored) return yield* Effect.die(new SessionAlreadyProjected())

  // 分叉事件携带指令条目时，在新会话上初始化指令
  if (event.data.instructionEntries)
    yield* InstructionEntry.initialize(db, event.data.sessionID, event.data.instructionEntries, event.created)

  // 由父消息 ID + 序号生成子会话中复制品的消息 ID
  const forkedID = (seq: number) => SessionMessage.ID.make(`${SessionMessage.ID.fromEvent(event.id)}_${seq}`)
  // The child stores the parent's inline media as blobs; the parent's rows are never rewritten.
  // 子会话把父消息的内联媒体转存为 blob；父会话的行从不改写。
  const media = yield* SessionBlob.ForkMedia
  // 游标指向上一批已复制的最大 seq，-1 表示从头开始
  let cursor = -1
  // 循环分批复制父会话消息，直到没有更多行
  while (copiedSeq !== undefined) {
    // 查询当前批次：父会话中 seq 大于游标且不超过 copiedSeq 的消息
    const rows = yield* db
      .select()
      .from(SessionMessageTable)
      .where(
        and(
          eq(SessionMessageTable.session_id, event.data.parentID),
          gt(SessionMessageTable.seq, cursor),
          lt(SessionMessageTable.seq, copiedSeq + 1),
          // Terminal events for active projections stay on the parent, so forks copy only settled history.
          // 未完成的 assistant、运行中的 shell/压缩消息留在父会话，分叉只复制已落定的历史
          sql`${SessionMessageTable.type} != 'assistant' or json_extract(${SessionMessageTable.data}, '$.time.completed') is not null`,
          sql`${SessionMessageTable.type} != 'shell' or json_extract(${SessionMessageTable.data}, '$.status') != 'running'`,
          sql`${SessionMessageTable.type} != 'compaction' or json_extract(${SessionMessageTable.data}, '$.status') != 'running'`,
        ),
      )
      // 按 seq 升序取最多 ForkBatchSize 行
      .orderBy(asc(SessionMessageTable.seq))
      .limit(ForkBatchSize)
      .all()
      .pipe(Effect.orDie)
    // 没有可复制的行了，结束循环
    if (rows.length === 0) break

    // 逐行构造复制后的插入值；对压缩摘要修正其 keepID 指向
    const values = yield* Effect.forEach(rows, (row) =>
      Effect.gen(function* () {
        // 基本字段：新 ID、新会话，类型与 seq/时间原样保留
        const copy = {
          id: forkedID(row.seq),
          session_id: event.data.sessionID,
          type: row.type,
          seq: row.seq,
          time_created: row.time_created,
          time_updated: row.time_updated,
          // Split parents' envelopes carry no content, so only unsplit parents' inline media moves here.
          // 拆分过的父消息信封不含内容，只有未拆分的内联媒体在此被外置为 blob
          data: media ? yield* SessionBlob.externalizeRow(db, row.data) : row.data,
        }
        // A summary references the first message it kept, which the fork copied under a new ID.
        // 压缩摘要引用其保留的首条消息（keepID），该消息在分叉后有了新 ID
        const keepID = row.type === "compaction" ? row.data.metadata?.keepID : undefined
        // keepID 不是合法消息 ID 时原样返回
        if (!Schema.is(SessionMessage.ID)(keepID)) return copy
        // 在父会话中查找被引用消息的 seq
        const kept = yield* db
          .select({ seq: SessionMessageTable.seq })
          .from(SessionMessageTable)
          .where(and(eq(SessionMessageTable.session_id, event.data.parentID), eq(SessionMessageTable.id, keepID)))
          .get()
          .pipe(Effect.orDie)
        // 引用不存在则保持原样
        if (!kept) return copy
        // 把 keepID 重写为复制品的新 ID
        return {
          ...copy,
          data: { ...row.data, metadata: { ...row.data.metadata, keepID: forkedID(kept.seq) } },
        }
      }),
    )
    // 分批插入复制出的消息行
    yield* Effect.forEach(
      DatabaseBatch.insertBatches(SessionMessageTable, values),
      (batch) => db.insert(SessionMessageTable).values(batch).run().pipe(Effect.orDie),
      { discard: true },
    )
    // 为每条复制消息登记 blob 引用（媒体外置后需在引用表登记归属）
    yield* Effect.forEach(
      values,
      (value) =>
        SessionBlob.recordRefs(
          db,
          { sessionID: event.data.sessionID, messageID: value.id, seq: value.seq },
          value.data,
        ),
      { discard: true },
    )

    // 取出本批中的 assistant 消息行，复制它们的部件行
    const assistantRows = rows.filter((row) => row.type === "assistant")
    if (assistantRows.length > 0) {
      // 建立「旧消息 ID → 新消息 ID」的映射
      const idMap = new Map(assistantRows.map((row) => [row.id, forkedID(row.seq)]))
      // 分批查询这些消息在父会话下的部件行，最后拍平
      const storedParts = yield* Effect.forEach(DatabaseBatch.batches([...idMap.keys()], 1, 1), (ids) =>
        db
          .select()
          .from(SessionPartTable)
          .where(and(eq(SessionPartTable.session_id, event.data.parentID), inArray(SessionPartTable.message_id, ids)))
          .orderBy(asc(SessionPartTable.message_id), asc(SessionPartTable.ordinal))
          .all()
          .pipe(Effect.orDie),
      ).pipe(Effect.map((batches) => batches.flat()))
      // 为每个部件构造插入值；媒体部件可能需要外置 blob
      const partValues: Array<typeof SessionPartTable.$inferInsert> = yield* Effect.forEach(storedParts, (part) =>
        Effect.gen(function* () {
          // 需要外置时，split 会把内联媒体拆为 blob 引用
          const data = media ? SessionBlob.split(part.data) : undefined
          // 拆出的 blob 先落库
          if (data?.moved) yield* SessionBlob.save(db, data.blobs)
          return {
            // 部件挂到新消息 ID 上，其余字段沿用
            message_id: idMap.get(part.message_id)!,
            session_id: event.data.sessionID,
            ordinal: part.ordinal,
            type: part.type,
            call_id: part.call_id,
            time_created: part.time_created,
            time_updated: part.time_updated,
            data: data?.data ?? part.data,
          }
        }),
      )
      // 批量插入部件行
      yield* insertParts(db, partValues)
      // Split parents' envelopes carry no content, so the parts' refs are recorded for each forked message here.
      // 拆分过的父消息信封无内容，因此部件的 blob 引用要按新消息逐一登记
      const partsByMessage = Map.groupBy(partValues, (part) => part.message_id)
      yield* Effect.forEach(
        assistantRows,
        (row) => {
          // 取该 assistant 消息的新 ID，聚合其部件数据作为内容
          const messageID = idMap.get(row.id)!
          const content = (partsByMessage.get(messageID) ?? []).map((part) => part.data)
          // 登记该消息内容的 blob 引用
          return SessionBlob.recordRefs(db, { sessionID: event.data.sessionID, messageID, seq: row.seq }, { content })
        },
        { discard: true },
      )
    }

    // 游标前进到本批最后一行的 seq，继续下一批
    cursor = rows.at(-1)!.seq
  }
  // 复制过历史时，把子会话的事件序列号保留到 copiedSeq，避免新事件 seq 冲突
  if (copiedSeq !== undefined) yield* Bus.reserveSequence(db, event.data.sessionID, copiedSeq)
  // 分叉事件携带指令状态时，按事件 seq 初始化
  if (event.data.instructions)
    yield* InstructionState.initialize(db, event.data.sessionID, event.durable.seq, event.data.instructions)
})

/** Reads `experimental.part_rows` from the Config in scope on every call; without one, it is off. */
// 每次调用都从当前作用域的 Config 读取 experimental.part_rows；无配置时视为关闭
const partRowsEnabled = Effect.gen(function* () {
  // 可选地获取 Config 服务（可能不存在）
  const config = yield* Effect.serviceOption(Config.Service)
  // 没有 Config 则关闭部件行
  if (Option.isNone(config)) return false
  // 读取最新的 experimental 配置并检查 part_rows 是否为 true
  return Config.latest(yield* config.value.entries(), "experimental")?.part_rows === true
})

// 消息表行类型
type MessageRow = typeof SessionMessageTable.$inferSelect
// 部件表行类型
type PartRow = typeof SessionPartTable.$inferSelect
// 两条写路径都要提供的写操作子集（更新/追加/替换 assistant 部件、shell 与压缩消息）
type Writes = Pick<
  SessionMessageUpdater.Adapter,
  | "getCurrentAssistant"
  | "getAssistant"
  | "updateAssistant"
  | "appendAssistantPart"
  | "updateAssistantPart"
  | "replaceAssistantParts"
  | "updateShell"
  | "updateCompaction"
>

// 消息类事件的统一投影入口：构建更新器适配器并驱动 SessionMessageUpdater
function run(db: DatabaseService, event: MessageEvent) {
  return Effect.gen(function* () {
    // 按 experimental.part_rows 开关选择写路径：开启用部件行路径，否则用整消息路径
    const writes = (yield* partRowsEnabled) ? partRowWrites(db, event) : messageWrites(db, event)
    // 组装完整的更新器适配器：写路径 + 会话级读取方法 + 追加消息
    const adapter: SessionMessageUpdater.Adapter = {
      // 展开所选写路径的读写方法
      ...writes,
      // 读取会话当前绑定的代理（agent），不存在则返回 undefined
      getAgent() {
        return db
          .select({ agent: SessionTable.agent })
          .from(SessionTable)
          .where(eq(SessionTable.id, event.data.sessionID))
          .get()
          .pipe(
            Effect.orDie,
            Effect.map((row) => row?.agent ?? undefined),
          )
      },
      // 读取会话当前绑定的模型引用并做模式校验
      getModel() {
        return db
          .select({ model: SessionTable.model })
          .from(SessionTable)
          .where(eq(SessionTable.id, event.data.sessionID))
          .get()
          .pipe(
            Effect.orDie,
            // 有值时用 Model.Ref 同步解码校验
            Effect.map((row) => (row?.model ? Schema.decodeUnknownSync(Model.Ref)(row.model) : undefined)),
          )
      },
      // 读取会话的位置信息：目录、工作区、项目与子路径
      getLocation() {
        return db
          .select({
            directory: SessionTable.directory,
            workspaceID: SessionTable.workspace_id,
            projectID: SessionTable.project_id,
            subpath: SessionTable.path,
          })
          .from(SessionTable)
          .where(eq(SessionTable.id, event.data.sessionID))
          .get()
          .pipe(
            Effect.orDie,
            // 把数据库行转成更新器需要的位置结构；空值归一为 undefined
            Effect.map((row) =>
              row
                ? {
                    location: {
                      directory: AbsolutePath.make(row.directory),
                      workspaceID: row.workspaceID ?? undefined,
                    },
                    projectID: row.projectID,
                    subpath: row.subpath === null ? undefined : RelativePath.make(row.subpath),
                  }
                : undefined,
            ),
          )
      },
      // 按 shellID 查找最近的 shell 消息（匹配 data.shellID）
      getShell(shellID) {
        return Effect.gen(function* () {
          const row = yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(
                eq(SessionMessageTable.session_id, event.data.sessionID),
                eq(SessionMessageTable.type, "shell"),
                sql`json_extract(${SessionMessageTable.data}, '$.shellID') = ${shellID}`,
              ),
            )
            .orderBy(desc(SessionMessageTable.seq))
            .limit(1)
            .get()
            .pipe(Effect.orDie)
          // 没有找到对应 shell 消息
          if (!row) return
          // 解码消息行并确认类型为 shell
          const message = SessionHistory.decodeMessageRowSync(row)
          return message.type === "shell" ? message : undefined
        })
      },
      // 查找正在进行的压缩（compaction）消息
      getCompaction() {
        return Effect.gen(function* () {
          const row = yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(
                eq(SessionMessageTable.session_id, event.data.sessionID),
                eq(SessionMessageTable.type, "compaction"),
                sql`json_extract(${SessionMessageTable.data}, '$.status') = 'running'`,
              ),
            )
            .orderBy(desc(SessionMessageTable.seq))
            .limit(1)
            .get()
            .pipe(Effect.orDie)
          // 没有运行中的压缩
          if (!row) return
          // 解码并确认类型为 compaction
          const message = SessionHistory.decodeMessageRowSync(row)
          return message.type === "compaction" ? message : undefined
        })
      },
      // 追加新消息：委托 insertMessage 写入消息与部件
      appendMessage: (message) => insertMessage(db, event, message),
    }
    // 由更新器按事件类型执行具体的消息更新
    yield* SessionMessageUpdater.update(adapter, event)
  })
}

/** Assistant reads shared by both write paths; `decode` decides whether part rows are folded into `content`. */
// 两条写路径共享的 assistant 读取方法；decode 决定是否把部件行并入 content
function assistantReads(
  db: DatabaseService,
  event: MessageEvent,
  decode: (row: MessageRow) => Effect.Effect<SessionMessage.Info>,
): Pick<Writes, "getCurrentAssistant" | "getAssistant"> {
  return {
    // 获取当前未完成的 assistant 消息（流式续写时使用）
    getCurrentAssistant() {
      return Effect.gen(function* () {
        // A newer step supersedes stale incomplete rows; never resume an older assistant projection.
        // 更新的步骤会取代陈旧的未完成行；绝不恢复较旧的 assistant 投影
        const row = yield* db
          .select()
          .from(SessionMessageTable)
          .where(
            and(eq(SessionMessageTable.session_id, event.data.sessionID), eq(SessionMessageTable.type, "assistant")),
          )
          .orderBy(desc(SessionMessageTable.seq))
          .limit(1)
          .get()
          .pipe(Effect.orDie)
        // 最新 assistant 已完成或不存在则返回 undefined
        if (!row || ("completed" in row.data.time && row.data.time.completed)) return
        // 用调用方提供的解码方式读取消息
        const message = yield* decode(row)
        // 仅当确实是未完成的 assistant 消息时返回
        return message.type === "assistant" && !message.time.completed ? message : undefined
      })
    },
    // 按 ID 获取指定的 assistant 消息
    getAssistant(messageID) {
      return Effect.gen(function* () {
        const row = yield* db
          .select()
          .from(SessionMessageTable)
          .where(
            and(
              eq(SessionMessageTable.id, messageID),
              eq(SessionMessageTable.session_id, event.data.sessionID),
              eq(SessionMessageTable.type, "assistant"),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        // 消息不存在
        if (!row) return
        // 解码行数据
        const message = yield* decode(row)
        // 类型不匹配则视为不存在
        return message.type === "assistant" ? message : undefined
      })
    },
  }
}

/**
 * The write path with `experimental.part_rows` off, unchanged from before part rows were written: every assistant
 * event rewrites the whole message. A message whose parts already live in session_part (written with the flag on,
 * or by a newer release) is written into those rows, and its row keeps an empty envelope.
 */
function messageWrites(db: DatabaseService, event: MessageEvent): Writes {
  // 读取某消息已存在的部件行（按 ordinal 排序）
  const partRows = (messageID: SessionMessage.ID) =>
    db
      .select()
      .from(SessionPartTable)
      .where(eq(SessionPartTable.message_id, messageID))
      .orderBy(asc(SessionPartTable.ordinal))
      .all()
      .pipe(Effect.orDie)
  // Writes `content` over a message's existing part rows, touching only the rows that changed.
  // 把 content 覆盖写入消息已有的部件行，只改动发生变化/新增/多余的行
  const writeParts = Effect.fnUntraced(function* (
    messageID: SessionMessage.ID,
    existing: ReadonlyArray<PartRow>,
    content: ReadonlyArray<SessionPartData>,
  ) {
    // 下一个新部件的 ordinal：接在现有最大 ordinal 之后
    let next = (existing.at(-1)?.ordinal ?? -1) + 1
    // 逐个比对新 content 与已有行：缺失则插入，变化则更新
    for (const [index, part] of content.entries()) {
      // 同位置的既有部件行
      const current = existing[index]
      // 部件列值：type、工具部件的 call_id 与数据
      const columns = { type: part.type, call_id: part.type === "tool" ? part.id : null, data: part }
      // 该位置无既有行 → 插入新部件行
      if (current === undefined)
        yield* db
          .insert(SessionPartTable)
          .values({
            ...columns,
            message_id: messageID,
            session_id: event.data.sessionID,
            ordinal: next++,
            time_created: event.created,
            time_updated: event.created,
          })
          .run()
          .pipe(Effect.orDie)
      // 内容有变化 → 更新既有行
      else if (JSON.stringify(current.data) !== JSON.stringify(part))
        yield* db
          .update(SessionPartTable)
          .set({ ...columns, time_updated: event.created })
          .where(and(eq(SessionPartTable.message_id, messageID), eq(SessionPartTable.ordinal, current.ordinal)))
          .run()
          .pipe(Effect.orDie)
    }
    // content 变短时，多余的尾部行视为过期
    const stale = existing.slice(content.length).map((part) => part.ordinal)
    // 存在过期行则按 ordinal 删除
    if (stale.length > 0)
      yield* db
        .delete(SessionPartTable)
        .where(and(eq(SessionPartTable.message_id, messageID), inArray(SessionPartTable.ordinal, stale)))
        .run()
        .pipe(Effect.orDie)
  })
  // 更新一条消息：先外置 blob，再写消息行，随后同步部件行与 blob 引用
  const updateMessage = Effect.fnUntraced(function* (message: SessionMessage.Info) {
    // 把内联媒体外置为 blob；未提取任何内容时返回同一对象
    const stored = yield* SessionBlob.externalize(db, message)
    // 编码为持久化结构，去掉单独成列的 id/type
    const { id: _, type, ...data } = encodeStored(stored)
    // assistant 消息且带 content 时，读取其既有部件行
    const parts = message.type === "assistant" && "content" in data ? yield* partRows(message.id) : []
    // 更新消息行；部件行存在时消息行 content 置空（内容改存部件表）
    const updated = yield* db
      .update(SessionMessageTable)
      .set({
        type,
        time_created: DateTime.toEpochMillis(message.time.created),
        data: parts.length > 0 && "content" in data ? { ...data, content: [] } : data,
      })
      .where(and(eq(SessionMessageTable.id, message.id), eq(SessionMessageTable.session_id, event.data.sessionID)))
      .returning({ seq: SessionMessageTable.seq })
      .get()
      .pipe(Effect.orDie)
    // 消息行不存在则放弃（可能已被删除）
    if (!updated) return
    // 部件行存在则把新 content 覆盖写入部件行
    if (parts.length > 0 && "content" in data) yield* writeParts(message.id, parts, data.content)
    // 该消息 blob 引用的归属信息
    const owner = { sessionID: event.data.sessionID, messageID: message.id, seq: updated.seq }
    // Most updates only carry existing refs forward; a content rewrite may also drop some. `externalize` returns
    // the same message when it extracted nothing, so streaming updates skip the ref tables entirely.
    // 内容更新事件需要同步引用集合（可能新增也可能丢弃）；
    // externalize 未提取东西时返回同一对象，因此流式更新可完全跳过引用表
    if (event.type === SessionEvent.MessageContentUpdated.type) yield* SessionBlob.syncRefs(db, owner, data)
    // 非内容更新事件：只有确实提取出了媒体时才登记引用
    else if (stored !== message) yield* SessionBlob.recordRefs(db, owner, data)
  })
  // 读方法：读取时把部件行折叠进 content 再解码
  const reads = assistantReads(db, event, (row) =>
    SessionHistory.withParts(db, [row]).pipe(
      Effect.map(([withParts = row]) => SessionHistory.decodeMessageRowSync(withParts)),
    ),
  )
  // 以「读取 → 不可变修改 → 整体更新」的方式编辑 assistant 消息
  const editAssistant = (
    messageID: SessionMessage.ID,
    recipe: (draft: WritableDraft<SessionMessage.Assistant>) => void,
  ) =>
    Effect.gen(function* () {
      // 读取目标消息
      const assistant = yield* reads.getAssistant(messageID)
      // 不存在则无事可做
      if (!assistant) return
      // 用 produce 在草稿上应用修改并生成新消息，再整体更新
      yield* updateMessage(produce(assistant, recipe))
    })
  return {
    // 展开共享读方法
    ...reads,
    // assistant/shell/compaction 的更新统一走 updateMessage
    updateAssistant: updateMessage,
    updateShell: updateMessage,
    updateCompaction: updateMessage,
    // 追加一个部件：草稿里 push 后整体重写
    appendAssistantPart: (messageID, part) =>
      editAssistant(messageID, (draft) => {
        draft.content.push(castDraft(part))
      }),
    // 更新匹配的部件：从尾部向前查找匹配项并应用修改
    updateAssistantPart: (messageID, match, recipe) =>
      editAssistant(messageID, (draft) => {
        // findLast 优先匹配最新的部件（流式场景）
        const found = draft.content.findLast(
          (
            item,
          ): item is WritableDraft<Extract<SessionMessage.AssistantContent, { readonly type: typeof match.type }>> =>
            // 类型匹配，且 callID 未指定或相等，且（若要求未完成推理）必须是未完成的 reasoning
            item.type === match.type &&
            (match.callID === undefined || (item.type === "tool" && item.id === match.callID)) &&
            (!match.incompleteReasoning || (item.type === "reasoning" && !item.time?.completed)),
        )
        // 找到才应用修改
        if (found) recipe(found)
      }),
    // 用新部件集合整体替换 content
    replaceAssistantParts: (messageID, parts) =>
      editAssistant(messageID, (draft) => {
        draft.content = castDraft([...parts])
      }),
  }
}

/** The write path with `experimental.part_rows` on: each assistant part is its own session_part row. */
function partRowWrites(db: DatabaseService, event: MessageEvent): Writes {
  /**
   * The only place a legacy inline assistant row moves to session_part, called right before its parts are written.
   * `carry: false` drops the inline parts instead of copying them, for a write that replaces them all. Returns the
   * owner the message's part refs belong to.
   */
  const prepareAssistantParts = Effect.fnUntraced(function* (messageID: SessionMessage.ID, carry: boolean) {
    // 查消息行的 seq 与内联 content 的长度
    const row = yield* db
      .select({
        id: SessionMessageTable.id,
        seq: SessionMessageTable.seq,
        inlineCount: sql<number>`json_array_length(${SessionMessageTable.data}, '$.content')`,
      })
      .from(SessionMessageTable)
      .where(
        and(
          eq(SessionMessageTable.id, messageID),
          eq(SessionMessageTable.session_id, event.data.sessionID),
          eq(SessionMessageTable.type, "assistant"),
        ),
      )
      .get()
      .pipe(Effect.orDie)
    // 消息不存在则无需准备
    if (!row) return
    // 内联内容非空时读取完整消息行
    const full =
      row.inlineCount > 0
        ? yield* db
            .select()
            .from(SessionMessageTable)
            .where(eq(SessionMessageTable.id, messageID))
            .get()
            .pipe(Effect.orDie)
        : undefined
    // 解码完整消息
    const message = full ? SessionHistory.decodeMessageRowSync(full) : undefined
    // 只有真正的 assistant 消息才需要迁移
    if (full && message?.type === "assistant") {
      if (carry) {
        // An older build that wrote inline content while part rows existed leaves both shapes on one message.
        // Keep the rows and append the inline parts after them, so a downgrade and re-upgrade loses nothing.
        // 旧版本可能在部件行存在的同时又写了内联内容，导致两种形态并存。
        // 保留部件行并把内联部件追加到其后，保证降级再升级不丢数据
        const last = yield* db
          .select({ ordinal: sql<number | null>`max(${SessionPartTable.ordinal})` })
          .from(SessionPartTable)
          .where(eq(SessionPartTable.message_id, messageID))
          .get()
          .pipe(Effect.orDie)
        // 追加起始 ordinal 接在现有最大值之后
        const first = (last?.ordinal ?? -1) + 1
        // 把每个内联部件映射为一条部件行
        const partRows = message.content.map((part, index) => ({
          message_id: messageID,
          session_id: event.data.sessionID,
          ordinal: first + index,
          type: part.type,
          call_id: part.type === "tool" ? part.id : null,
          time_created: full.time_created,
          time_updated: event.created,
          data: SessionHistory.encodePart(part),
        }))
        // 插入这些部件行
        yield* insertParts(db, partRows)
      }
      // 编码 content 置空的消息，去掉单独成列的 id/type
      const { id: _, type: __, ...data } = encodeMessage({ ...message, content: [] })
      // 清空消息行的内联 content（完成迁移）
      yield* db
        .update(SessionMessageTable)
        .set({ data })
        .where(and(eq(SessionMessageTable.id, messageID), eq(SessionMessageTable.session_id, event.data.sessionID)))
        .run()
        .pipe(Effect.orDie)
    }
    // 返回部件 blob 引用应归属的所有者信息
    return { sessionID: event.data.sessionID, messageID, seq: row.seq } satisfies SessionBlob.Owner
  })
  // Assistant content is written only by the part methods below, which also record its blob refs. Envelope updates
  // keep whatever content the row already holds: inline for a legacy row that was never split, [] once it was.
  const updateMessage = (message: SessionMessage.Info) => {
    // assistant 消息编码时 content 置空；其他消息原样编码
    const {
      id: _,
      type: __,
      ...data
    } = encodeMessage(message.type === "assistant" ? { ...message, content: [] } : message)
    return db
      .update(SessionMessageTable)
      .set({
        // 步骤开始事件会刷新 time_created
        ...(event.type === SessionEvent.Step.Started.type
          ? { time_created: DateTime.toEpochMillis(message.time.created) }
          : {}),
        data:
          message.type === "assistant"
            // assistant：用 json_set 保留行中已有 content（内联或 []），避免覆盖部件内容
            ? sql`json_set(${JSON.stringify(data)}, '$.content', json(coalesce(${SessionMessageTable.data} -> '$.content', '[]')))`
            // 其他消息直接写入编码后的数据
            : data,
      })
      .where(and(eq(SessionMessageTable.id, message.id), eq(SessionMessageTable.session_id, event.data.sessionID)))
      .run()
      .pipe(Effect.orDie)
  }
  // 读方法：直接解码行（不并入部件行）
  const reads = assistantReads(db, event, (row) => Effect.sync(() => SessionHistory.decodeMessageRowSync(row)))
  return {
    // 展开共享读方法
    ...reads,
    // 追加一个部件：迁移旧内联行 → 外置媒体 → 计算 ordinal → 插入部件行 → 登记引用
    appendAssistantPart(messageID, part) {
      return Effect.gen(function* () {
        // 先把旧内联行迁移到部件行（carry=true 保留内容）
        const owner = yield* prepareAssistantParts(messageID, true)
        // 消息不存在则放弃
        if (!owner) return
        // 外置部件中的媒体并编码为持久化结构
        const data = SessionHistory.encodePart(yield* SessionBlob.externalizePart(db, part))
        // 计算下一个 ordinal（最大值 + 1，无行时为 0）
        const next = yield* db
          .select({ ordinal: sql<number>`coalesce(max(${SessionPartTable.ordinal}) + 1, 0)` })
          .from(SessionPartTable)
          .where(eq(SessionPartTable.message_id, messageID))
          .get()
          .pipe(Effect.orDie)
        // 插入新部件行
        yield* db
          .insert(SessionPartTable)
          .values({
            message_id: messageID,
            session_id: event.data.sessionID,
            ordinal: next?.ordinal ?? 0,
            type: part.type,
            call_id: part.type === "tool" ? part.id : null,
            time_created: event.created,
            time_updated: event.created,
            data,
          })
          .run()
          .pipe(Effect.orDie)
        // 登记该部件的 blob 引用
        yield* SessionBlob.recordRefs(db, owner, { content: [data] })
      })
    },
    // 更新匹配的部件行
    updateAssistantPart(messageID, match, recipe) {
      return Effect.gen(function* () {
        // 先迁移旧内联行（如有）
        const owner = yield* prepareAssistantParts(messageID, true)
        // 消息不存在则放弃
        if (!owner) return
        // 按匹配条件查找最新（ordinal 最大）的部件行
        const row = yield* db
          .select()
          .from(SessionPartTable)
          .where(
            and(
              eq(SessionPartTable.message_id, messageID),
              eq(SessionPartTable.session_id, event.data.sessionID),
              eq(SessionPartTable.type, match.type),
              // 指定了 callID 时还要匹配 call_id
              match.callID !== undefined ? eq(SessionPartTable.call_id, match.callID) : undefined,
              // 要求未完成推理时只匹配 time.completed 为空的行
              match.incompleteReasoning
                ? sql`json_extract(${SessionPartTable.data}, '$.time.completed') is null`
                : undefined,
            ),
          )
          .orderBy(desc(SessionPartTable.ordinal))
          .limit(1)
          .get()
          .pipe(Effect.orDie)
        // 没有匹配的部件行
        if (!row) return

        // 解码部件行并断言为匹配的类型
        const current = SessionHistory.decodePartRowSync(row) as Extract<
          SessionMessage.AssistantContent,
          { readonly type: typeof match.type }
        >
        // 在不可变草稿上应用修改；未变化则跳过写入
        const updated = produce(current, recipe)
        if (updated === current) return
        // `externalizePart` returns the same part when it moved nothing, so streaming updates skip the ref tables.
        // externalizePart 未移动任何媒体时返回同一对象，因此流式更新可跳过引用表
        const stored = yield* SessionBlob.externalizePart(db, updated)
        // 编码为持久化结构
        const data = SessionHistory.encodePart(stored)
        // 更新该部件行的数据与更新时间
        yield* db
          .update(SessionPartTable)
          .set({ data, time_updated: event.created })
          .where(and(eq(SessionPartTable.message_id, messageID), eq(SessionPartTable.ordinal, row.ordinal)))
          .run()
          .pipe(Effect.orDie)
        // 有媒体被外置时才需要登记引用
        if (stored !== updated) yield* SessionBlob.recordRefs(db, owner, { content: [data] })
      })
    },
    // 用新部件集合整体替换该消息的所有部件行
    replaceAssistantParts(messageID, parts) {
      return Effect.gen(function* () {
        // 迁移旧内联行；carry=false 表示旧内容将被全部替换
        const owner = yield* prepareAssistantParts(messageID, false)
        // 消息不存在则放弃
        if (!owner) return
        // 删除该消息现有的全部部件行
        yield* db.delete(SessionPartTable).where(eq(SessionPartTable.message_id, messageID)).run().pipe(Effect.orDie)
        // 逐个外置新部件中的媒体
        const stored = yield* Effect.forEach(parts, (part) => SessionBlob.externalizePart(db, part))
        // 按序构造部件行
        const partRows = stored.map((part, ordinal) => ({
          message_id: messageID,
          session_id: event.data.sessionID,
          ordinal,
          type: part.type,
          call_id: part.type === "tool" ? part.id : null,
          time_created: event.created,
          time_updated: event.created,
          data: SessionHistory.encodePart(part),
        }))
        // 批量插入新部件行
        yield* insertParts(db, partRows)
        // A content rewrite may drop media, so refs the new parts no longer name are released.
        // 内容重写可能丢弃媒体，新部件不再引用的 blob 会被释放
        yield* SessionBlob.syncRefs(db, owner, { content: partRows.map((part) => part.data) })
      })
    },
    // 信封类更新共用 updateMessage
    updateAssistant: updateMessage,
    updateShell: updateMessage,
    updateCompaction: updateMessage,
  }
}

// 按消息类型选择编码器：用户消息用 stored 形态，其他用 Info 形态
const encodeStored = (message: SessionMessage.Info | SessionStored.User) =>
  message.type === "user" ? encodeStoredUser(message) : encodeMessage(message)

// 插入一条新消息（含部件行与 blob 引用登记）
const insertMessage = Effect.fnUntraced(function* (
  db: DatabaseService,
  event: SessionEvent.DurableEvent,
  message: SessionMessage.Info | SessionStored.User,
) {
  // 先把内联媒体外置为 blob
  const stored = yield* SessionBlob.externalize(db, message)
  // 编码为持久化结构，去掉单独成列的 id/type
  const { id: _, type, ...data } = encodeStored(stored)
  // 创建时间转毫秒时间戳
  const timeCreated = DateTime.toEpochMillis(message.time.created)
  // Assistant content goes to session_part rows; the message row keeps an empty envelope.
  // assistant 内容写入部件行，消息行保留空信封
  const parts = stored.type === "assistant" ? stored.content : []
  // 插入消息行；有部件时 content 置空
  yield* db
    .insert(SessionMessageTable)
    .values({
      id: message.id,
      session_id: event.data.sessionID,
      type,
      // 使用事件的持久化序列号
      seq: event.durable.seq,
      time_created: timeCreated,
      data: "content" in data && parts.length > 0 ? { ...data, content: [] } : data,
    })
    .run()
    .pipe(Effect.orDie)
  // 把每个部件映射为一条部件行
  const partRows = parts.map((part, ordinal) => ({
    message_id: message.id,
    session_id: event.data.sessionID,
    ordinal,
    type: part.type,
    call_id: part.type === "tool" ? part.id : null,
    time_created: timeCreated,
    time_updated: event.created,
    data: SessionHistory.encodePart(part),
  }))
  // 批量插入部件行
  yield* insertParts(db, partRows)
  // 登记消息数据的 blob 引用
  yield* SessionBlob.recordRefs(
    db,
    { sessionID: event.data.sessionID, messageID: message.id, seq: event.durable.seq },
    data,
  )
})

// 投影执行结束事件（成功/失败/中断）：先跑通用消息投影，再更新会话空闲状态
function projectIdle(
  db: DatabaseService,
  event:
    | typeof SessionEvent.Execution.Succeeded.Type
    | typeof SessionEvent.Execution.Failed.Type
    | typeof SessionEvent.Execution.Interrupted.Type,
) {
  return Effect.gen(function* () {
    // 先处理事件对应的消息更新
    yield* run(db, event)
    // 关机（shutdown）导致的中断不算空闲转换
    if (event.type === SessionEvent.Execution.Interrupted.type && event.data.reason === "shutdown") return
    // 空闲时间点取事件创建时间
    const time = event.created
    // 根据事件类型得到空闲结果标签
    const outcome =
      event.type === SessionEvent.Execution.Succeeded.type
        ? "succeeded"
        : event.type === SessionEvent.Execution.Failed.type
          ? "failed"
          : "interrupted"
    yield* setSession(db, event.data.sessionID, {
      // Unread uses a strict timestamp comparison, so every terminal must advance even within one millisecond.
      // 未读判断用严格时间比较，因此即使同一毫秒也要保证 time_idle 严格前进
      time_idle: sql`max(${time}, coalesce(${SessionTable.time_idle} + 1, ${time}))`,
      // 记录空闲结果
      idle_outcome: outcome,
      // 保持 time_updated 不变
      time_updated: sql`${SessionTable.time_updated}`,
    })
  })
}

// 组装投影层：为每个会话事件注册对应的数据库投影逻辑
const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    // 获取事件总线与数据库句柄
    const bus = yield* Bus.Service
    const db = (yield* Database.Service).db
    // 会话创建事件：插入会话行（幂等）
    yield* bus.project(SessionEvent.Created, (event) =>
      Effect.gen(function* () {
        const stored = yield* db
          .insert(SessionTable)
          .values({
            // 会话 ID 与项目/工作区/父会话等元信息
            id: event.data.sessionID,
            project_id: event.data.projectID,
            workspace_id: event.data.location.workspaceID ?? null,
            parent_id: event.data.parentID,
            slug: event.data.slug,
            directory: event.data.location.directory,
            path: event.data.subpath,
            title: event.data.title,
            agent: event.data.agent,
            model: event.data.model,
            metadata: event.data.metadata,
            permission: event.data.permissions,
            version: event.data.version,
            // 时间取事件时间
            time_created: event.created,
            time_updated: event.created,
          })
          // 同 ID 冲突时不重复插入（幂等重放）
          .onConflictDoNothing()
          .returning({ sessionID: SessionTable.id })
          .get()
          .pipe(Effect.orDie)
        // 插入失败说明会话已存在，抛出专用错误
        if (!stored) return yield* Effect.die(new SessionAlreadyProjected())
      }),
    )
    // 会话移动事件：更新目录/子路径/项目/工作区
    yield* bus.project(SessionEvent.Moved, (event) =>
      Effect.gen(function* () {
        // 先处理事件对应的消息更新
        yield* run(db, event)
        // 更新会话的位置与归属信息
        yield* setSession(db, event.data.sessionID, {
          directory: event.data.location.directory,
          path: event.data.subpath,
          // 有新项目 ID 时才更新 project_id
          ...(event.data.projectID ? { project_id: event.data.projectID } : {}),
          workspace_id: event.data.location.workspaceID ?? null,
          time_updated: event.created,
        })
      }),
    )
    // Sessions whose ownership came from the directory's previous resolution
    // follow its new identity. Location, transcript, instructions, and recency
    // are untouched: the session did not move, its directory got identified.
    // 目录身份被重新识别时，先前按旧解析归属的会话跟随新身份；
    // 位置、转录、指令与最近使用都不动：会话没有移动，是目录被识别了
    yield* bus.project(Worktree.Event.Resolved, (event) =>
      Effect.gen(function* () {
        // 候选旧项目 ID：先前解析、全局项目与被并入的项目，排除新项目自身并去重
        const candidates = [
          ...new Set(
            [event.data.previous, Project.ID.global, ...(event.data.adopted ?? [])].filter(
              (id) => id !== event.data.projectID,
            ),
          ),
        ]
        // 没有候选项目则无事可做
        if (candidates.length === 0) return
        // 找出属于候选项目、无工作区且目录落在范围内的会话
        const rows = yield* db
          .select({
            id: SessionTable.id,
            directory: SessionTable.directory,
            projectID: SessionTable.project_id,
            canonical: ProjectTable.worktree,
          })
          .from(SessionTable)
          .innerJoin(ProjectTable, eq(SessionTable.project_id, ProjectTable.id))
          .where(
            and(
              inArray(SessionTable.project_id, candidates),
              isNull(SessionTable.workspace_id),
              or(
                // 被并入项目下的会话直接纳入
                event.data.adopted?.length ? inArray(SessionTable.project_id, event.data.adopted) : undefined,
                // 否则要求目录在 [directory, directory+\uffff] 字典序范围内（前缀匹配）
                and(
                  gte(SessionTable.directory, event.data.directory),
                  lte(SessionTable.directory, AbsolutePath.make(event.data.directory + "\uffff")),
                ),
              ),
            ),
          )
          .all()
          .pipe(Effect.orDie)
        // 逐个把命中的会话改挂到新项目
        yield* Effect.forEach(
          rows,
          (row) => {
            // 被并入的会话使用项目的规范工作树路径，其他用绝对化的目录
            const directory = event.data.adopted?.includes(row.projectID)
              ? row.canonical
              : AbsolutePath.make(path.resolve(row.directory))
            // 目录不在新目录范围内则跳过
            if (!FSUtil.contains(event.data.directory, directory)) return Effect.void
            return setSession(db, row.id, {
              // 改挂项目
              project_id: event.data.projectID,
              // 子路径重新相对化并把反斜杠统一为正斜杠
              path: RelativePath.make(path.relative(event.data.directory, directory).replaceAll("\\", "/")),
              // Self-assignment suppresses the column's $onUpdate: adoption is not activity.
              // 自赋值抑制该列的 $onUpdate 钩子：采用（adoption）不算活动
              time_updated: sql`${SessionTable.time_updated}`,
            })
          },
          { discard: true },
        )
      }),
    )
    // 会话删除事件：先释放其 blob 引用，再删会话行
    yield* bus.project(SessionEvent.Deleted, (event) =>
      Effect.gen(function* () {
        yield* SessionBlob.releaseSession(db, event.data.sessionID)
        yield* db.delete(SessionTable).where(eq(SessionTable.id, event.data.sessionID)).run().pipe(Effect.orDie)
      }),
    )
    // 代理选择事件：先跑消息投影，再更新会话的 agent
    yield* bus.project(SessionEvent.AgentSelected, (event) =>
      Effect.gen(function* () {
        yield* run(db, event)
        yield* setSession(db, event.data.sessionID, { agent: event.data.agent, time_updated: event.created })
      }),
    )
    // 模型选择事件：更新会话的 model
    yield* bus.project(SessionEvent.ModelSelected, (event) =>
      Effect.gen(function* () {
        yield* run(db, event)
        yield* setSession(db, event.data.sessionID, { model: event.data.model, time_updated: event.created })
      }),
    )
    // 重命名事件：更新标题
    yield* bus.project(SessionEvent.Renamed, (event) =>
      setSession(db, event.data.sessionID, { title: event.data.title, time_updated: event.created }),
    )
    // 元数据更新事件：写入 metadata
    yield* bus.project(SessionEvent.MetadataUpdated, (event) =>
      setSession(db, event.data.sessionID, { metadata: event.data.metadata, time_updated: event.created }),
    )
    // 权限更新事件：写入 permission
    yield* bus.project(SessionEvent.Permissions, (event) =>
      setSession(db, event.data.sessionID, { permission: event.data.permissions, time_updated: event.created }),
    )
    // 查看事件：推进已读水位（单调不回退）
    yield* bus.project(SessionEvent.Viewed, (event) => {
      // 查看者观察到的空闲时间点
      const idle = event.data.idle
      return setSession(db, event.data.sessionID, {
        // Monotone watermark: a duplicate or stale view never regresses, and a terminal event
        // committing after the viewer's observation keeps the newer idle transition unread.
        // 单调水位：重复或过期的查看不会回退；在查看者观察之后提交的终态事件仍保持未读
        time_viewed: sql`max(${idle}, coalesce(${SessionTable.time_viewed}, ${idle}))`,
        // 保持 time_updated 不变
        time_updated: sql`${SessionTable.time_updated}`,
      })
    })
    // 归档事件：记录归档时间
    yield* bus.project(SessionEvent.Archived, (event) =>
      setSession(db, event.data.sessionID, { time_archived: event.created, time_updated: event.created }),
    )
    // 取消归档事件：清空归档时间
    yield* bus.project(SessionEvent.Unarchived, (event) =>
      setSession(db, event.data.sessionID, { time_archived: null, time_updated: event.created }),
    )
    // 消息内容更新事件：走通用消息投影
    yield* bus.project(SessionEvent.MessageContentUpdated, (event) => run(db, event))
    // 用量记录事件：把费用与 token 累加到会话
    yield* bus.project(SessionEvent.UsageRecorded, (event) => applyUsage(db, event.data.sessionID, event.data))
    // 分叉事件：复制父会话历史
    yield* bus.project(SessionEvent.Forked, (event) => projectFork(db, event))
    // 收件箱投递事件：把排队的用户/合成消息真正写入消息表
    yield* bus.project(SessionEvent.InboxDelivered, (event) =>
      Effect.gen(function* () {
        // 按收件箱条目取出要投递的内容
        const input = yield* SessionInbox.projectDelivered(db, {
          id: event.data.inboxID,
          sessionID: event.data.sessionID,
        })
        // 构造消息时间
        const time = { created: DateTime.makeUnsafe(event.created) }
        // 用户消息：插入用户消息
        if (input.type === "user")
          yield* insertMessage(db, event, {
            id: input.id,
            type: "user",
            metadata: input.payload.metadata,
            text: input.payload.text,
            files: input.payload.files,
            agents: input.payload.agents,
            skills: input.payload.skills,
            time,
          })
        // 合成消息：插入合成消息
        if (input.type === "synthetic")
          yield* insertMessage(db, event, {
            id: input.id,
            type: "synthetic",
            text: input.payload.text,
            description: input.payload.description,
            metadata: input.payload.metadata,
            time,
          })
      }),
    )
    // 收件箱入队事件：登记排队条目并刷新会话时间
    yield* bus.project(SessionEvent.InboxEnqueued, (event) =>
      Effect.gen(function* () {
        yield* SessionInbox.projectAdmitted(db, {
          enqueuedSeq: event.durable.seq,
          id: event.data.inboxID,
          sessionID: event.data.sessionID,
          item: event.data.item,
          timeCreated: event.created,
        })
        // 触碰会话更新时间
        yield* touch(db, event)
      }),
    )
    // 收件箱取消事件：标记条目取消
    yield* bus.project(SessionEvent.InboxCancelled, (event) =>
      SessionInbox.projectCancelled(db, {
        id: event.data.inboxID,
        sessionID: event.data.sessionID,
      }),
    )
    // 收件箱投递状态变化事件：更新条目的投递状态
    yield* bus.project(SessionEvent.InboxDeliveryChanged, (event) =>
      SessionInbox.projectDeliveryChanged(db, {
        id: event.data.inboxID,
        sessionID: event.data.sessionID,
        delivery: event.data.delivery,
      }),
    )
    // 执行开始事件：记录忙碌时间
    yield* bus.project(SessionEvent.Execution.Started, (event) =>
      setSession(db, event.data.sessionID, {
        time_busy: event.created,
        // 保持 time_updated 不变
        time_updated: sql`${SessionTable.time_updated}`,
      }),
    )
    // 执行成功/失败/中断事件：统一走空闲投影
    yield* bus.project(SessionEvent.Execution.Succeeded, (event) => projectIdle(db, event))
    yield* bus.project(SessionEvent.Execution.Failed, (event) => projectIdle(db, event))
    yield* bus.project(SessionEvent.Execution.Interrupted, (event) => projectIdle(db, event))
    // 指令更新事件：跑消息投影并应用指令增量
    yield* bus.project(SessionEvent.InstructionsUpdated, (event) =>
      Effect.gen(function* () {
        yield* run(db, event)
        yield* InstructionState.apply(db, event.data.sessionID, event.durable.seq, event.data.delta)
      }),
    )
    // 合成消息事件：走通用消息投影
    yield* bus.project(SessionEvent.Synthetic, (event) => run(db, event))
    // 技能激活/Shell 开始/结束事件：走通用消息投影
    yield* bus.project(SessionEvent.Skill.Activated, (event) => run(db, event))
    yield* bus.project(SessionEvent.Shell.Started, (event) => run(db, event))
    yield* bus.project(SessionEvent.Shell.Ended, (event) => run(db, event))
    // 步骤开始事件：投影并触碰会话时间
    yield* bus.project(SessionEvent.Step.Started, (event) =>
      Effect.gen(function* () {
        yield* run(db, event)
        yield* touch(db, event)
      }),
    )
    // 步骤流式事件：走通用消息投影
    yield* bus.project(SessionEvent.Step.Streamed, (event) => run(db, event))
    // 步骤结束事件：投影并累加该步骤的用量
    yield* bus.project(SessionEvent.Step.Ended, (event) =>
      Effect.gen(function* () {
        yield* run(db, event)
        // 以事件时间作为 time_updated 累加用量
        yield* applyUsage(db, event.data.sessionID, event.data, event.created)
      }),
    )
    // 步骤失败事件：投影；若携带完整用量则累加，否则仅触碰会话
    yield* bus.project(SessionEvent.Step.Failed, (event) =>
      Effect.gen(function* () {
        yield* run(db, event)
        // 费用与 token 都存在才累加
        if (event.data.cost !== undefined && event.data.tokens !== undefined)
          yield* applyUsage(
            db,
            event.data.sessionID,
            { cost: event.data.cost, tokens: event.data.tokens },
            event.created,
          )
        // 没有完整用量时只刷新更新时间
        else yield* touch(db, event)
      }),
    )
    // 文本/工具/推理等各类消息事件：统一走通用消息投影
    yield* bus.project(SessionEvent.Text.Started, (event) => run(db, event))
    yield* bus.project(SessionEvent.Text.Ended, (event) => run(db, event))
    yield* bus.project(SessionEvent.Tool.Input.Started, (event) => run(db, event))
    yield* bus.project(SessionEvent.Tool.Input.Ended, (event) => run(db, event))
    yield* bus.project(SessionEvent.Tool.Called, (event) => run(db, event))
    yield* bus.project(SessionEvent.Tool.Success, (event) => run(db, event))
    yield* bus.project(SessionEvent.Tool.Failed, (event) => run(db, event))
    yield* bus.project(SessionEvent.Reasoning.Started, (event) => run(db, event))
    yield* bus.project(SessionEvent.Reasoning.Ended, (event) => run(db, event))
    // 重试调度事件：走通用消息投影
    yield* bus.project(SessionEvent.RetryScheduled, (event) => run(db, event))
    // 压缩（compaction）开始事件：走通用消息投影
    yield* bus.project(SessionEvent.Compaction.Started, (event) => run(db, event))
    // 压缩结束事件：投影并推进指令状态的纪元（epoch）
    yield* bus.project(SessionEvent.Compaction.Ended, (event) =>
      Effect.gen(function* () {
        yield* run(db, event)
        yield* InstructionState.advanceEpoch(db, event.data.sessionID, event.durable.seq)
      }),
    )
    // 压缩失败事件：走通用消息投影
    yield* bus.project(SessionEvent.Compaction.Failed, (event) => run(db, event))
    // 回退（revert）暂存事件：写入回退状态
    yield* bus.project(SessionEvent.RevertEvent.Staged, (event) =>
      setSession(db, event.data.sessionID, { revert: event.data.revert, time_updated: event.created }),
    )
    // 回退清除事件：清空回退状态
    yield* bus.project(SessionEvent.RevertEvent.Cleared, (event) =>
      setSession(db, event.data.sessionID, { revert: null, time_updated: event.created }),
    )
    // 回退提交事件：删除边界之后的消息与收件箱条目并回退相关状态
    yield* bus.project(SessionEvent.RevertEvent.Committed, (event) =>
      Effect.gen(function* () {
        // 查询回退边界消息的 seq
        const boundary = yield* db
          .select({ seq: SessionMessageTable.seq })
          .from(SessionMessageTable)
          .where(
            and(eq(SessionMessageTable.session_id, event.data.sessionID), eq(SessionMessageTable.id, event.data.to)),
          )
          .get()
          .pipe(Effect.orDie)
        // 边界消息不存在则致命错误
        if (!boundary) return yield* Effect.die(new Error(`Revert boundary message not found: ${event.data.to}`))
        // 删除 seq >= 边界的所有消息行
        yield* db
          .delete(SessionMessageTable)
          .where(
            and(eq(SessionMessageTable.session_id, event.data.sessionID), gte(SessionMessageTable.seq, boundary.seq)),
          )
          .run()
          .pipe(Effect.orDie)
        // 删除入队序号 >= 边界的收件箱条目
        yield* db
          .delete(SessionInboxTable)
          .where(
            and(
              eq(SessionInboxTable.session_id, event.data.sessionID),
              gte(SessionInboxTable.enqueued_seq, boundary.seq),
            ),
          )
          .run()
          .pipe(Effect.orDie)
        // 清空会话的回退状态
        yield* setSession(db, event.data.sessionID, { revert: null, time_updated: event.created })
        // 指令状态回退到边界 seq
        yield* InstructionState.rewind(db, event.data.sessionID, boundary.seq)
        // 释放边界之后不再被引用的 blob
        yield* SessionBlob.releaseFrom(db, event.data.sessionID, boundary.seq)
      }),
    )
    // 订阅用量相关事件：每次步骤终态/用量记录后对外发布累计用量
    yield* bus.subscribe([SessionEvent.Step.Ended, SessionEvent.Step.Failed, SessionEvent.UsageRecorded]).pipe(
      // 逐事件处理：步骤失败且无完整用量时跳过，否则发布用量
      Stream.runForEach((event) => {
        if (
          event.type === SessionEvent.Step.Failed.type &&
          (event.data.cost === undefined || event.data.tokens === undefined)
        )
          // 步骤失败但没有可用用量数据，不发布
          return Effect.void
        // 读取会话累计用量并发布 UsageUpdated
        return publishSessionUsage(db, bus, event.data.sessionID)
      }),
      // 以立即启动的独立作用域 Fiber 运行该订阅循环
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
)

// 导出全局节点：名为 session-projector 的服务层，依赖 Bus 与 Database 节点
export const node = makeGlobalNode({ name: "session-projector", layer, deps: [Bus.node, Database.node] })
