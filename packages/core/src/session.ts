// 将本模块以命名空间（namespace）形式导出为 Session
export * as Session from "./session.js"
// 同时转发导出 session/schema.js 的全部内容
export * from "./session/schema.js"

// 从 effect 导入日期时间、Effect、Layer、上下文、Option、Stream
import { DateTime, Effect, Layer, Context, Option, Stream } from "effect"
// 导入 LLM 客户端服务
import { LLMClient } from "@opencode/ai/effect"
// 导入会话列表的锚点、游标与过滤器类型
import { ListAnchor, ListCursor, ListFilter } from "@opencode/schema/session"
// 导入 drizzle 查询操作符
import { and, desc, eq } from "drizzle-orm"
// 导入项目（Project）服务
import { Project } from "./project.js"
// 导入模型（Model）引用类型
import { Model } from "@opencode/schema/model"
// 导入位置（Location）服务
import { Location } from "./location.js"
// 导入文件系统异常类型
import type { FileSystem } from "./filesystem.js"
// 导入会话消息模块
import { SessionMessage } from "./session/message.js"
// 导入提示输入 schema
import { PromptInput } from "@opencode/schema/prompt-input"
// 导入事件总线（Bus）服务
import { Bus } from "./bus.js"
// 导入实例（Instance）服务
import { Instance } from "./instance/service.js"
// 导入数据库服务
import { Database } from "./database/database.js"
// 导入会话投影器（projector）
import { SessionProjector } from "./session/projector.js"
// 导入会话消息表
import { SessionMessageTable } from "./session/sql.js"
// 导入会话二进制大对象（blob）模块
import { SessionBlob } from "./session/blob.js"
// 导入会话 schema
import { SessionSchema } from "./session/schema.js"
// 导入相对路径 schema
import { RelativePath } from "./schema.js"
// 导入代理（Agent）类型
import { Agent } from "@opencode/schema/agent"
// 导入权限规则集类型
import type { Permission } from "@opencode/schema/permission"
// 导入应用元数据
import { App } from "./app.js"
// 导入短 ID（slug）生成器
import { Slug } from "./util/slug.js"
// 导入路径工具
import path from "path"
// 导入会话运行器
import { SessionRunner } from "./session/runner/index.js"
// 导入会话存储服务
import { SessionStore } from "./session/store.js"
// 导入会话执行服务
import { SessionExecution } from "./session/execution.js"
// 导入会话相关的各类错误类型
import {
  AttachmentError,
  BusyError,
  CompactionConflictError,
  ForkEmptyError,
  InboxConflictError,
  InvalidListCursorError,
  MessageDecodeError,
  MessageNotFoundError,
  NotFoundError,
  PromptConflictError,
  SkillNotFoundError,
  SyntheticConflictError,
} from "./session/error.js"
// 导入节点工具
import { Node } from "@opencode/util/effect/app-node"
// 导入 LayerNode 类型
import { LayerNode } from "@opencode/util/effect/layer-node"
// 导入会话持久事件定义
import { SessionEvent } from "./session/event.js"
// 导入会话收件箱模块
import { SessionInbox } from "./session/inbox.js"
// 导入指令（instruction）状态模块
import { InstructionState } from "./session/instruction-state.js"
// 导入会话文本生成模块
import { SessionGenerate } from "./session/generate.js"
// 导入会话命令执行模块
import { SessionCommand } from "./session/command.js"
// 导入会话移动（move）服务及其错误
import {
  SessionMove,
  DestinationNotFoundError,
  DestinationNotDirectoryError,
  DestinationUnavailableError,
} from "./session/move.js"
// 导入会话模型传输服务
import { SessionModelTransport } from "./session/model-transport.js"
// 导入 LLM 客户端节点
import { llmClient } from "./effect/app-node-platform.js"
// 导入快照（snapshot）模块
import { Snapshot } from "./snapshot.js"
// 导入底层会话（Handle）实现
import { Session } from "./session/session.js"
// 导入会话差异（diff）模块
import { SessionDiff, TurnRangeError } from "./session/diff.js"
// 导入位置-服务映射
import { LocationServiceMap } from "./location-service-map.js"
// 导入文件系统工具
import { FSUtil } from "@opencode/util/fs-util"
// 导入事件日志类型
import type { EventLog } from "@opencode/schema/event-log"
// 导入文件差异类型
import type { FileDiff } from "@opencode/schema/file-diff"
// 导入作业（Job）服务
import { Job } from "./job.js"
// 导入命令类型
import type { Command } from "./command.js"
// 导入会话环境变量服务
import { SessionEnvironment } from "./session/environment.js"
// 导入指令条目模块
import { InstructionEntry } from "./session/instruction-entry.js"

// get project -> project.locations
//
// get all sessions
//

// - by project
//   - by subpath
// - by workspace (home is special)
// 设计草图注释：按项目取 project.locations；取全部会话；
// 分组维度：按项目（project）-> 按子路径（subpath）；按工作空间（workspace，home 为特例）

// 转发导出列表锚点与游标类型
export { ListAnchor, ListCursor }

// 转发导出列表输入类型
export const ListInput = SessionStore.ListInput
export type ListInput = SessionStore.ListInput

// 列表的默认分页上限
const DefaultListLimit = 50

// 创建会话的基础输入
type CreateBaseInput = {
  // 可选指定会话 ID
  id?: SessionSchema.ID
  // 可选标题
  title?: string
  // 可选代理
  agent?: Agent.ID
  // 可选模型
  model?: Model.Ref
  // 可选元数据
  metadata?: SessionSchema.Metadata
  // 可选权限规则集
  permissions?: Permission.Ruleset
}
// 创建输入：要么给位置（location），要么给父会话 ID，二者互斥
type CreateInput = CreateBaseInput &
  ({ location: Location.Ref; parentID?: never } | { parentID: SessionSchema.ID; location?: never })

// 压缩（compact）输入：底层 compact 参数 + 会话 ID
type CompactInput = Parameters<Session.Handle["compact"]>[0] & { sessionID: SessionSchema.ID }

// 分叉（fork）输入：源会话与可选的消息边界
type ForkInput = {
  sessionID: SessionSchema.ID
  before?: SessionMessage.ID
}

// 转发导出全部会话错误类型
export {
  AttachmentError,
  BusyError,
  CompactionConflictError,
  ForkEmptyError,
  InboxConflictError,
  InvalidListCursorError,
  MessageDecodeError,
  MessageNotFoundError,
  NotFoundError,
  PromptConflictError,
  SkillNotFoundError,
  SyntheticConflictError,
}
// 收件箱条目引用：会话 ID + 收件箱消息 ID
type InboxItemRef = { readonly sessionID: SessionSchema.ID; readonly inboxID: SessionMessage.ID }

// 转发导出移动相关的错误类型
export { DestinationNotFoundError, DestinationNotDirectoryError, DestinationUnavailableError }
// 转发导出回合范围错误
export { TurnRangeError }

// 服务接口：会话的完整操作集合
export interface Interface {
  /** A cursor carries the filters of the request that produced it, so filters passed with a cursor are ignored. */
  // 分页列出会话；游标（cursor）已内含产生它的过滤条件，因此随游标传入的过滤器会被忽略
  readonly list: (input?: ListFilter & { readonly limit?: number; readonly cursor?: ListCursor }) => Effect.Effect<
    {
      readonly data: SessionSchema.Info[]
      readonly cursor: { readonly previous?: ListCursor; readonly next?: ListCursor }
    },
    InvalidListCursorError
  >
  // 创建会话
  readonly create: (input: CreateInput) => Effect.Effect<SessionSchema.Info, NotFoundError>
  // 从现有会话分叉出新会话
  readonly fork: (
    input: ForkInput,
  ) => Effect.Effect<SessionSchema.Info, NotFoundError | MessageNotFoundError | ForkEmptyError>
  // 按 ID 读取会话
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<SessionSchema.Info, NotFoundError>
  // 读取或设置会话环境变量
  readonly environment: (input: {
    readonly sessionID: SessionSchema.ID
    readonly variables?: SessionEnvironment.Variables
  }) => Effect.Effect<SessionEnvironment.Variables | undefined, NotFoundError>
  // 查看会话（等待其进入空闲）
  readonly view: (input: { sessionID: SessionSchema.ID; idle: number }) => Effect.Effect<void, NotFoundError>
  // 删除会话（级联删除子会话）
  readonly remove: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError>
  // 读取会话消息列表
  readonly messages: (
    input: SessionStore.MessagesInput,
  ) => Effect.Effect<SessionMessage.Info[], NotFoundError | MessageDecodeError>
  // 读取单条消息
  readonly message: (input: {
    sessionID: SessionSchema.ID
    messageID: SessionMessage.ID
  }) => Effect.Effect<SessionMessage.Info | undefined>
  /** Experimental: {@link Interface.messages} with files stored in `blob` left as `media:` refs when the session's location enables `experimental.media_blob`. */
  // 实验特性：messages 的媒体引用（media:）变体，文件保留在 blob 存储中
  readonly messagesWithRefs: (
    input: SessionStore.MessagesInput,
  ) => Effect.Effect<SessionMessage.MediaInfo[], NotFoundError | MessageDecodeError>
  /** Experimental: {@link Interface.message} with files stored in `blob` left as `media:` refs when the session's location enables `experimental.media_blob`. */
  // 实验特性：message 的媒体引用变体
  readonly messageWithRefs: (input: {
    sessionID: SessionSchema.ID
    messageID: SessionMessage.ID
  }) => Effect.Effect<SessionMessage.MediaInfo | undefined>
  // 读取会话上下文（消息集合）
  readonly context: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<SessionMessage.Info[], NotFoundError | MessageDecodeError>
  /** Structured diffs of the files changed by a turn or range of turns; see `SessionDiff.turn`. */
  // 计算某个回合（turn）或回合区间所改文件的结构化差异（diff）
  readonly diff: (input: {
    readonly sessionID: SessionSchema.ID
    readonly from?: SessionMessage.ID
    readonly to?: SessionMessage.ID
    readonly context?: number
  }) => Effect.Effect<
    readonly FileDiff.Info[],
    NotFoundError | MessageNotFoundError | TurnRangeError | Snapshot.Error | FileSystem.DirectoryNotFoundError
  >
  /**
   * Durable admitted session work not yet visible in projected history,
   * ordered by admission. Includes unpromoted user and synthetic inputs and
   * unhandled compaction barriers.
   */
  // 会话收件箱：已持久化但尚未进入投影历史的准入工作，按准入顺序排列
  readonly inbox: (sessionID: SessionSchema.ID) => Effect.Effect<SessionInbox.Info[], NotFoundError>
  /** Experimental: {@link Interface.inbox} with files stored in `blob` left as `media:` refs when the session's location enables `experimental.media_blob`. */
  // 实验特性：inbox 的媒体引用变体
  readonly inboxWithRefs: (sessionID: SessionSchema.ID) => Effect.Effect<SessionInbox.MediaInfo[], NotFoundError>
  // 取消收件箱条目
  readonly cancelInbox: (input: InboxItemRef) => Effect.Effect<void, NotFoundError | InboxConflictError>
  // 将收件箱条目标记为插队（steer）
  readonly steerInbox: (input: InboxItemRef) => Effect.Effect<void, NotFoundError | InboxConflictError>
  // 将收件箱条目标记为排队（queue）
  readonly queueInbox: (input: InboxItemRef) => Effect.Effect<void, NotFoundError | InboxConflictError>
  /**
   * Durable, ordered session log read. Replays durable session bus after
   * the exclusive `after` cursor, emits a `Synced` marker at the captured
   * replay watermark, then continues live when `follow` is set.
   * The marker's seq may exceed the last emitted event because other durable
   * bus share the aggregate's sequence space.
   */
  // 会话持久日志流：先重放 after 游标之后的事件，在重放水位处发出 Synced
  // 标记，follow 开启后继续实时流；标记序号可能超过最后事件（共享序列空间）
  readonly log: (input: {
    sessionID: SessionSchema.ID
    after?: number
    follow?: boolean
  }) => Stream.Stream<SessionEvent.DurableEvent | EventLog.Synced, NotFoundError>
  // 切换会话代理
  readonly switchAgent: (input: { sessionID: SessionSchema.ID; agent: Agent.ID }) => Effect.Effect<void, NotFoundError>
  // 切换会话模型
  readonly switchModel: (input: { sessionID: SessionSchema.ID; model: Model.Ref }) => Effect.Effect<void, NotFoundError>
  // 重命名会话
  readonly rename: (input: { sessionID: SessionSchema.ID; title: string }) => Effect.Effect<void, NotFoundError>
  // 归档会话
  readonly archive: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError>
  // 取消归档
  readonly unarchive: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError>
  // 设置会话元数据
  readonly setMetadata: (input: {
    sessionID: SessionSchema.ID
    metadata: SessionSchema.Metadata
  }) => Effect.Effect<void, NotFoundError>
  // 设置会话权限规则
  readonly setPermissions: (input: {
    sessionID: SessionSchema.ID
    permissions: Permission.Ruleset
  }) => Effect.Effect<void, NotFoundError>
  // 移动会话
  readonly move: SessionMove.Interface["move"]
  // 向会话发送用户提示（prompt）
  readonly prompt: (
    input: Parameters<Session.Handle["prompt"]>[0] & { sessionID: SessionSchema.ID },
  ) => ReturnType<Session.Handle["prompt"]>
  /** Generates text from current Session context without admitting input or mutating history. */
  // 仅用当前上下文生成文本，不写入输入也不改动历史
  readonly generate: (input: {
    sessionID: SessionSchema.ID
    prompt: string
  }) => Effect.Effect<string, NotFoundError | SessionGenerate.Error>
  // 执行会话命令（command）
  readonly command: (input: {
    sessionID: SessionSchema.ID
    command: string
    text: string
    files?: PromptInput.Prompt["files"]
    agents?: PromptInput.Prompt["agents"]
    skills?: PromptInput.Prompt["skills"]
    delivery?: SessionInbox.Delivery
  }) => Effect.Effect<
    void,
    NotFoundError | Command.NotFoundError | Command.ExecutionError | FileSystem.DirectoryNotFoundError
  >
  // 在会话中执行 shell 命令
  readonly shell: (
    input: Parameters<Session.Handle["shell"]>[0] & { sessionID: SessionSchema.ID },
  ) => ReturnType<Session.Handle["shell"]>
  // 调用技能（skill）
  readonly skill: (
    input: Parameters<Session.Handle["skill"]>[0] & { sessionID: SessionSchema.ID },
  ) => ReturnType<Session.Handle["skill"]>
  // 压缩会话历史
  readonly compact: (
    input: CompactInput,
  ) => Effect.Effect<SessionInbox.Compaction, NotFoundError | CompactionConflictError>
  // 等待会话空闲
  readonly wait: (id: SessionSchema.ID) => Effect.Effect<void, NotFoundError>
  // 当前活跃（运行中）的会话集合
  readonly active: Effect.Effect<ReadonlySet<SessionSchema.ID>>
  // 将会话中正在阻塞的工作转入后台
  readonly background: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError>
  // 恢复（继续运行）会话
  readonly resume: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError | SessionRunner.RunError>
  // 中断会话，可选是否随后恢复
  readonly interrupt: (sessionID: SessionSchema.ID, options?: { readonly resume?: boolean }) => Effect.Effect<boolean>
  // 注入合成（synthetic）消息（不来自用户的系统内容）
  readonly synthetic: (
    input: Parameters<Session.Handle["synthetic"]>[0] & { sessionID: SessionSchema.ID },
  ) => ReturnType<Session.Handle["synthetic"]>
  // 回退（revert）操作集：暂存、清除、提交
  readonly revert: {
    // 暂存：回退到指定消息，可选同时还原文件
    readonly stage: (input: {
      sessionID: SessionSchema.ID
      messageID: SessionMessage.ID
      files?: boolean
    }) => Effect.Effect<
      SessionSchema.Revert,
      NotFoundError | MessageNotFoundError | BusyError | Snapshot.Error | FileSystem.DirectoryNotFoundError
    >
    // 清除回退状态
    readonly clear: (
      sessionID: SessionSchema.ID,
    ) => Effect.Effect<void, NotFoundError | BusyError | Snapshot.Error | FileSystem.DirectoryNotFoundError>
    // 提交回退（使回退永久生效）
    readonly commit: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError | BusyError>
  }
}

// 定义 Session 服务
export class Service extends Context.Service<Service, Interface>()("@opencode/Session") {}

// 服务实现层：将接口委托给底层会话句柄（Handle）与各子服务
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 依赖：应用元数据（版本号等）
    const app = yield* App.Metadata
    // 依赖：数据库服务
    const database = yield* Database.Service
    // 取底层 drizzle 实例
    const db = database.db
    // 依赖：事件总线
    const bus = yield* Bus.Service
    // 依赖：项目服务
    const projects = yield* Project.Service
    // 依赖：会话执行服务
    const execution = yield* SessionExecution.Service
    // 依赖：LLM 客户端
    const llm = yield* LLMClient.Service
    // 依赖：会话模型传输服务
    const transport = yield* SessionModelTransport.Service
    // 依赖：会话存储服务
    const store = yield* SessionStore.Service
    // 依赖：实例服务
    const instances = yield* Instance.Service
    // 依赖：会话移动服务
    const moves = yield* SessionMove.Service
    // 依赖：作业服务
    const jobs = yield* Job.Service
    // 依赖：会话环境变量服务
    const environments = yield* SessionEnvironment.Service
    // 依赖：位置-服务映射
    const locations = yield* LocationServiceMap.Service
    // 构建底层会话句柄工厂
    const sessions = yield* Session.make()
    // 判断某会话位置是否启用媒体 blob 存储
    const mediaBlob = (session: SessionSchema.Info) => SessionBlob.enabledFor(instances, app, session)
    // 判断总线日志条目是否为会话持久事件
    const isDurableSessionEvent = (item: Bus.LogItem): item is SessionEvent.DurableEvent =>
      Object.hasOwn(SessionEvent.Durable.cases, item.type)

    // 组装服务实现
    const result = Service.of({
      // 创建会话：幂等；发布 Created 事件，由投影器落库
      create: Effect.fn("Session.create")(function* (input) {
        // 使用指定 ID 或生成新 ID
        const sessionID = input.id ?? SessionSchema.ID.create()
        // 幂等：已存在则直接返回已记录的会话
        const recorded = yield* store.get(sessionID)
        if (recorded) return recorded
        // 解析父会话（子会话场景）
        const parent = input.parentID ? yield* store.get(input.parentID) : undefined
        // 指定了父会话但父会话不存在则报错
        if (input.parentID && parent === undefined) return yield* new NotFoundError({ sessionID: input.parentID })
        // 位置来源：优先父会话的位置，其次规范化的输入位置
        const location = parent?.location ?? (input.location && LocationServiceMap.canonical(input.location))
        // 两者都缺失属于编程错误
        if (location === undefined)
          return yield* Effect.die(new Error("Session.create requires either location or an existing parentID"))
        // 解析位置所属项目
        const project = yield* projects.resolve(location.directory)
        // 发布会话创建事件（含 slug、版本、项目、父子关系、子路径、标题等）
        const projected = yield* bus
          .publish(
            SessionEvent.Created,
            {
              sessionID,
              slug: Slug.create(),
              version: app.version,
              projectID: project.id,
              parentID: input.parentID,
              location,
              subpath: RelativePath.make(path.relative(project.directory, location.directory).replaceAll("\\", "/")),
              title: input.title,
              agent: input.agent,
              // Children inherit metadata and permissions the way they inherit
              // location, so host policies that read them treat the family uniformly.
              // 子会话像继承位置一样继承元数据与权限，宿主策略得以统一处理
              metadata: input.metadata ?? parent?.metadata,
              permissions: input.permissions ?? parent?.permissions,
              model: input.model,
            },
            { location },
          )
          .pipe(
            // 默认结果标记为 created
            Effect.as({ type: "created" } as const),
            // 创建事件投影失败时的兜底
            Effect.catchDefect((defect) => {
              // 非并发投影冲突的缺陷原样上抛
              if (!(defect instanceof SessionProjector.SessionAlreadyProjected)) {
                return Effect.die(defect)
              }
              // Concurrent creation lost the projection race. The existing Session identity wins.
              // 并发创建在投影竞争中落败：以已存在的会话为准
              return store
                .get(sessionID)
                .pipe(
                  Effect.flatMap((session) =>
                    session ? Effect.succeed({ type: "existing", session } as const) : Effect.die(defect),
                  ),
                )
            }),
          )
        // 投影竞争中已存在：返回既有会话
        if (projected.type === "existing") return projected.session
        // TODO: Restore recorded sessions onto replacement synchronized workspaces in a future API slice.
        // 重新读取并返回新会话
        return yield* result.get(sessionID).pipe(Effect.orDie)
      }),
      // 分叉会话：复制边界之前的父会话历史
      fork: Effect.fn("Session.fork")(function* (input) {
        // 获取源会话
        const parent = yield* result.get(input.sessionID)
        // 查找边界消息：默认取最后一条；指定 before 时取该消息
        const boundary = yield* db
          .select({ id: SessionMessageTable.id })
          .from(SessionMessageTable)
          .where(
            and(
              eq(SessionMessageTable.session_id, input.sessionID),
              input.before ? eq(SessionMessageTable.id, input.before) : undefined,
            ),
          )
          .orderBy(desc(SessionMessageTable.seq))
          .limit(1)
          .get()
          .pipe(Effect.orDie)
        // 指定的边界消息不存在
        if (!boundary && input.before)
          return yield* new MessageNotFoundError({
            sessionID: input.sessionID,
            messageID: input.before,
          })
        // 源会话没有任何消息，无法分叉
        if (!boundary) return yield* new ForkEmptyError({ sessionID: input.sessionID })
        // 生成新会话 ID
        const sessionID = SessionSchema.ID.create()
        // 读取父会话当前的指令状态与指令条目快照
        const inherited = yield* db
          .transaction(() =>
            Effect.all({
              instructions: InstructionState.current(db, parent.id),
              instructionEntries: InstructionEntry.snapshot(db, parent.id),
            }),
          )
          .pipe(Effect.orDie)
        // The fork adopts the parent's newest instruction values rather than the
        // values in effect at the boundary; copied history may contain frozen
        // instruction-update text the initial baseline already reflects.
        // 分叉采用父会话最新的指令值，而非边界时刻的值
        // The parent's location, not the caller's, decides whether the copy's media is stored as blobs.
        // 由父会话位置决定分叉副本的媒体是否存为 blob
        const media = yield* mediaBlob(parent)
        // 发布分叉事件（带边界信息与继承的指令状态）
        yield* bus
          .publish(SessionEvent.Forked, {
            sessionID,
            parentID: parent.id,
            boundary: { type: input.before ? "before" : "through", messageID: boundary.id },
            ...inherited,
          })
          .pipe(Effect.provideService(SessionBlob.ForkMedia, media))
        // 返回新会话
        return yield* result.get(sessionID).pipe(Effect.orDie)
      }),
      // 按 ID 读取会话（委托给句柄）
      get: (sessionID) => sessions.forSession(sessionID).get(),
      // 读取或设置会话环境变量
      environment: Effect.fn("Session.environment")(function* (input) {
        // 校验会话存在
        yield* result.get(input.sessionID)
        // 提供了变量则先写入
        if (input.variables !== undefined) yield* environments.set(input.sessionID, input.variables)
        // 返回当前环境变量
        return yield* environments.get(input.sessionID)
      }),
      // 查看会话（委托给句柄）
      view: (input) => sessions.forSession(input.sessionID).view(input),
      // 删除会话：中断运行、清理子会话与资源后发布删除事件
      remove: Effect.fn("Session.remove")(function* (sessionID) {
        // 校验会话存在
        yield* result.get(sessionID)
        // 中断正在执行的工作
        yield* execution.interrupt(sessionID)
        // 等待执行完全空闲
        yield* execution.awaitIdle(sessionID)
        // 取消该会话的所有作业
        yield* jobs.cancelSession(sessionID)
        // 关闭模型传输连接
        yield* transport.close(sessionID)
        // 查找全部子会话
        const children = yield* store.list({ parentID: sessionID })
        // 串行递归删除子会话
        yield* Effect.forEach(children, (child) => result.remove(child.id), { concurrency: 1, discard: true })
        // 清空环境变量
        yield* environments.clear(sessionID)
        // 发布会话删除事件
        yield* bus.publish(SessionEvent.Deleted, { sessionID })
        // 移除该会话的总线聚合
        yield* bus.remove(sessionID)
      }),
      // 分页列出会话：解析游标、查询数据并生成前后翻页游标
      list: Effect.fn("Session.list")(function* (input = {}) {
        // 无游标时直接使用输入作为过滤条件；有游标则解析出内嵌的过滤条件
        const filter =
          input.cursor === undefined
            ? input
            : yield* ListCursor.parse(input.cursor).pipe(Effect.mapError(() => new InvalidListCursorError()))
        // 查询一页数据
        const data = yield* store.list({ ...filter, limit: input.limit ?? DefaultListLimit })
        // 取本页首条与末条
        const first = data[0]
        const last = data.at(-1)
        // 返回数据与双向游标
        return {
          data,
          cursor: {
            previous: first
              ? ListCursor.make({
                  ...filter,
                  anchor: { id: first.id, time: DateTime.toEpochMillis(first.time.updated), direction: "previous" },
                })
              : undefined,
            next: last
              ? ListCursor.make({
                  ...filter,
                  anchor: { id: last.id, time: DateTime.toEpochMillis(last.time.updated), direction: "next" },
                })
              : undefined,
          },
        }
      }),
      // 读取消息列表（先校验会话存在）
      messages: Effect.fn("Session.messages")(function* (input) {
        yield* result.get(input.sessionID)
        return yield* store.messages(input)
      }),
      // 读取单条消息（委托给句柄）
      message: (input) => sessions.forSession(input.sessionID).message(input.messageID),
      // 读取消息列表的媒体引用变体：未启用 blob 存储时退回普通读取
      messagesWithRefs: Effect.fn("Session.messagesWithRefs")(function* (input) {
        const session = yield* result.get(input.sessionID)
        if (!(yield* mediaBlob(session))) return yield* store.messages(input)
        return yield* store.messagesWithRefs(input)
      }),
      // 读取单条消息的媒体引用变体：会话不存在返回 undefined；未启用则退回普通读取
      messageWithRefs: Effect.fn("Session.messageWithRefs")(function* (input) {
        const session = yield* result.get(input.sessionID).pipe(Effect.option)
        if (Option.isNone(session)) return undefined
        if (!(yield* mediaBlob(session.value))) return yield* result.message(input)
        // 从存储读取并确认消息确实属于目标会话
        const stored = yield* store.messageWithRefs(input.messageID)
        return stored?.sessionID === input.sessionID ? stored.message : undefined
      }),
      // 读取会话上下文
      context: Effect.fn("Session.context")(function* (sessionID) {
        yield* result.get(sessionID)
        return yield* store.context(sessionID)
      }),
      // 计算回合差异：委托给 SessionDiff
      diff: Effect.fn("Session.diff")(function* (input) {
        const session = yield* result.get(input.sessionID)
        const active = yield* execution.isActive(input.sessionID)
        return yield* SessionDiff.turn(db, locations, {
          session,
          active,
          from: input.from,
          to: input.to,
          context: input.context,
        })
      }),
      // 读取会话收件箱（委托给句柄）
      inbox: (sessionID) => sessions.forSession(sessionID).inbox(),
      // 收件箱的媒体引用变体：未启用 blob 时退回普通读取
      inboxWithRefs: Effect.fn("Session.inboxWithRefs")(function* (sessionID) {
        const session = yield* result.get(sessionID)
        if (!(yield* mediaBlob(session))) return yield* result.inbox(sessionID)
        return yield* SessionInbox.listWithRefs(db, sessionID)
      }),
      // 取消收件箱条目（委托给句柄）
      cancelInbox: (input) => sessions.forSession(input.sessionID).cancelInbox(input.inboxID),
      // 插队收件箱条目（委托给句柄）
      steerInbox: (input) => sessions.forSession(input.sessionID).steerInbox(input.inboxID),
      // 排队收件箱条目（委托给句柄）
      queueInbox: (input) => sessions.forSession(input.sessionID).queueInbox(input.inboxID),
      // 持久日志流：延迟解析会话后挂接总线日志，并只保留持久事件与同步标记
      log: (input) =>
        Stream.unwrap(
          result
            .get(input.sessionID)
            .pipe(Effect.as(bus.log({ aggregateID: input.sessionID, after: input.after, follow: input.follow }))),
        ).pipe(
          Stream.filter(
            (item): item is SessionEvent.DurableEvent | EventLog.Synced =>
              Bus.isSynced(item) || isDurableSessionEvent(item),
          ),
        ),
      // 发送用户提示（委托给句柄）
      prompt: (input) => sessions.forSession(input.sessionID).prompt(input),
      // 免写入的文本生成：为生成器注入所需服务
      generate: Effect.fn("Session.generate")(function* (input) {
        const session = yield* result.get(input.sessionID)
        return yield* SessionGenerate.generate({ session, prompt: input.prompt }).pipe(
          Effect.provideService(Instance.Service, instances),
          Effect.provideService(Database.Service, database),
          Effect.provideService(LLMClient.Service, llm),
        )
      }),
      // 执行会话命令：注入实例服务
      command: Effect.fn("Session.command")(function* (input) {
        const session = yield* result.get(input.sessionID)
        return yield* SessionCommand.execute({ ...input, session }).pipe(
          Effect.provideService(Instance.Service, instances),
        )
      }),
      // 在会话中执行 shell（委托给句柄）
      shell: (input) => sessions.forSession(input.sessionID).shell(input),
      // 调用技能（委托给句柄）
      skill: (input) => sessions.forSession(input.sessionID).skill(input),
      // 切换代理（委托给句柄）
      switchAgent: (input) => sessions.forSession(input.sessionID).switchAgent(input),
      // 切换模型（委托给句柄）
      switchModel: (input) => sessions.forSession(input.sessionID).switchModel(input),
      // 重命名（委托给句柄）
      rename: (input) => sessions.forSession(input.sessionID).rename(input),
      // 归档（委托给句柄）
      archive: (sessionID) => sessions.forSession(sessionID).archive(),
      // 取消归档（委托给句柄）
      unarchive: (sessionID) => sessions.forSession(sessionID).unarchive(),
      // 设置元数据（委托给句柄）
      setMetadata: (input) => sessions.forSession(input.sessionID).setMetadata(input),
      // 设置权限（委托给句柄）
      setPermissions: (input) => sessions.forSession(input.sessionID).setPermissions(input),
      // 移动会话（委托给移动服务）
      move: moves.move,
      // 压缩历史（委托给句柄）
      compact: (input) => sessions.forSession(input.sessionID).compact(input),
      // 等待空闲（委托给句柄）
      wait: (sessionID) => sessions.forSession(sessionID).wait(),
      // 活跃会话集合（委托给执行服务）
      active: execution.active,
      // 将阻塞工作转入后台，并向会话注入合成消息说明情况
      background: Effect.fn("Session.background")(function* (sessionID) {
        // 校验会话存在
        yield* result.get(sessionID)
        // 将所有可后台化的作业转入后台
        const backgrounded = yield* jobs.backgroundAll({ sessionID })
        // 没有可后台化的工作则无事可做
        if (backgrounded.length === 0) return
        // 注入合成消息告知模型：工作已转后台，不要等待或轮询
        yield* result
          .synthetic({
            sessionID,
            text: [
              "User requested that active blocking work be moved to the background.",
              "",
              "Backgrounded work:",
              ...backgrounded.map((job) => `- ${job.type}: ${job.title && job.title.length > 0 ? job.title : job.id}`),
              "",
              "The backgrounded work is still unfinished. Move on to other work if you can. If there is nothing else useful to do, finish your response. Do not wait, sleep, poll, or report the backgrounded work as complete until a later completion notification is added to the conversation.",
            ].join("\n"),
          })
          // 注入冲突属于编程错误
          .pipe(Effect.catchTag("Session.SyntheticConflictError", Effect.die))
      }),
      // 恢复运行（委托给句柄）
      resume: (sessionID) => sessions.forSession(sessionID).resume(),
      // 注入合成消息（委托给句柄）
      synthetic: (input) => sessions.forSession(input.sessionID).synthetic(input),
      // 中断会话（委托给句柄）
      interrupt: (sessionID, options) => sessions.forSession(sessionID).interrupt(options),
      // 回退操作集（委托给句柄）
      revert: {
        stage: (input) => sessions.forSession(input.sessionID).revert.stage(input),
        clear: (sessionID) => sessions.forSession(sessionID).revert.clear(),
        commit: (sessionID) => sessions.forSession(sessionID).revert.commit(),
      },
    })

    // 返回服务实现
    return result
  }),
)

// 构建 Session 的全局分层节点，声明其全部依赖节点
export const node: LayerNode.Provider<Service, never, typeof Node.tags.values.global> = Node.makeGlobalNode({
  service: Service,
  layer,
  deps: [
    Job.node,
    SessionEnvironment.node,
    Database.node,
    Bus.node,
    Project.node,
    SessionExecution.node,
    SessionModelTransport.node,
    llmClient,
    SessionStore.node,
    Instance.node,
    SessionInbox.node,
    SessionMove.node,
    SessionProjector.node,
    LocationServiceMap.node,
    FSUtil.node,
    App.node,
  ],
})
