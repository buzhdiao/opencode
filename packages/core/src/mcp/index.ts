// 将本模块以命名空间 Mcp 整体再导出（barrel 模式）
export * as Mcp from "./index.js"

// 引入 MCP 服务器 schema（状态、服务器信息、资源目录等）
import { Mcp } from "@opencode/schema/mcp"
// 引入 MCP 事件 schema（工具/资源变化）
import { McpEvent } from "@opencode/schema/mcp-event"
// 引入瞬时（ephemeral）事件构造器
import { ephemeral } from "@opencode/schema/event"
// 仅引入类型：会话
import type { Session } from "@opencode/schema/session"
// 仅引入类型：MCP 传输
import type { Transport } from "@modelcontextprotocol/client"
// 引入 node 的 SHA1 哈希（集成 ID 生成）
import { createHash } from "node:crypto"
// 引入深度相等比较（配置对比）
import { isDeepStrictEqual } from "node:util"
// 引入 Effect 核心构件（时钟、上下文、Effect、Exit、纤程、闭锁、层、Schema、作用域、信号量、流等）
import {
  Clock,
  Context,
  Effect,
  Exit,
  Fiber,
  FiberMap,
  FiberSet,
  Latch,
  Layer,
  Schedule,
  Schema,
  Scope,
  Semaphore,
  Stream,
  Types,
} from "effect"
// 引入 Effect 的 fetch HTTP 客户端标记
import { FetchHttpClient } from "effect/http"
// 引入应用节点定位辅助
import { makeLocationNode } from "@opencode/util/effect/app-node"
// 引入 http fetch 节点
import { httpFetch } from "@opencode/util/effect/app-node-platform"
// 引入凭证（Credential）服务
import { Credential } from "../credential.js"
// 引入事件总线（Bus）服务
import { Bus } from "../bus.js"
// 引入环境（Environment）服务
import { Environment } from "../environment/index.js"
import { Flag } from "../flag.js"
import { Form } from "../form.js"
// 引入集成（Integration）服务
import { Integration } from "../integration.js"
// 引入键控互斥（KeyedMutex）
import { KeyedMutex } from "../effect/keyed-mutex.js"
// 引入位置（Location）服务
import { Location } from "../location.js"
import { Hash } from "@opencode/util/hash"
import { waitForAbort } from "@opencode/util/process"
// 引入状态（State）模块
import { State } from "../state.js"
// 仅引入类型：MCP 客户端
import type { McpClient } from "./client.js"
import { EventStreamRejectedError, EventStreamTerminatedError } from "./event-errors.js"
import { canonicalJson } from "../util/canonical-json.js"
import { McpConnection } from "./connection.js"
// 引入 MCP 连接池
import { McpPool } from "./pool.js"

// 服务器名：带品牌（brand）的字符串类型
export const ServerName = Schema.String.pipe(Schema.brand("MCP.ServerName"))
// 服务器名类型
export type ServerName = typeof ServerName.Type
// 提示词变化事件（瞬时事件，不持久化）
export const PromptsChanged = ephemeral({ type: "mcp.prompts.changed", schema: { server: Schema.String } })

// 服务器状态：复用 schema 定义
export const Status = Mcp.Status
// 服务器状态类型
export type Status = Mcp.Status
// 服务器信息类型
export type ServerInfo = Mcp.Server

// 服务器指令：服务器名与说明文本
export interface ServerInstructions {
  // 服务器名
  readonly server: ServerName
  // 说明文本
  readonly instructions: string
}

/** Checked MCP tool definition tagged with the server that owns it. */
// 工具类型：已校验的工具定义，附加所属服务器名与可选 codemode 标记
export type Tool = McpClient.Tool & { readonly server: ServerName; readonly codemode?: boolean }
// 工具调用内容片段类型
export type ToolResultContent = McpClient.CallToolContent
// 工具调用结果类型
export type ToolResult = McpClient.CallToolResult
// 提示词类型（附加服务器名）
export type Prompt = McpClient.Prompt & { readonly server: ServerName }
// 提示词结果类型
export type PromptResult = McpClient.GetPromptResult

// 资源及其类型（转发 schema）
export const Resource = Mcp.Resource
export type Resource = Mcp.Resource
// 资源模板及其类型（转发 schema）
export const ResourceTemplate = Mcp.ResourceTemplate
export type ResourceTemplate = Mcp.ResourceTemplate
// 资源目录及其类型（转发 schema）
export const ResourceCatalog = Mcp.ResourceCatalog
export type ResourceCatalog = Mcp.ResourceCatalog
// 资源内容及其类型（转发 schema）
export const ResourceContent = Mcp.ResourceContent
export type ResourceContent = Mcp.ResourceContent

// 服务器未找到错误
export class NotFoundError extends Schema.TaggedError<NotFoundError>()("MCP.NotFoundError", {
  // 服务器名
  server: ServerName,
}) {
  // 错误消息
  override get message() {
    return `MCP server not found: ${this.server}`
  }
}

// 工具调用错误
export class ToolCallError extends Schema.TaggedError<ToolCallError>()("MCP.ToolCallError", {
  // 服务器名
  server: ServerName,
  // 工具名
  tool: Schema.String,
  // 错误消息
  message: Schema.String,
}) {}

// unavailable：按状态生成“服务器不可用”的提示文案
const unavailable = (server: ServerName, status: Status) => {
  // 按状态种类分发
  switch (status.status) {
    // 失败：提示重连入口
    case "failed":
      return `MCP server "${server}" is not connected: ${status.error}. Reconnect it from /mcps.`
    // 需要认证：提示登录入口
    case "needs_auth":
      return `MCP server "${server}" needs authentication: ${status.error}. Sign in from /mcps.`
    // 已禁用
    case "disabled":
      return `MCP server "${server}" is disabled.`
    // 其他状态：通用文案
    default:
      return `MCP server "${server}" is not connected.`
  }
}

// 服务器条目：一个已注册服务器的配置、状态与连接
type ServerEntry = {
  // 配置（不可变）
  readonly config: Mcp.ServerConfig
  // 当前状态（可变）
  status: Status
  // 启动闭锁：连接首次结算后打开
  readonly startup: Latch.Latch
  // The connection attempt in flight: when it began and a latch that opens once it settles.
  // 进行中的连接尝试：开始时间与结算后打开的闭锁
  attempt?: { readonly started: number; readonly settled: Latch.Latch }
  // 底层连接
  readonly connection: McpConnection.Connection
  // The connection's tool list tagged for this server, rebuilt only when the connection lists again.
  // 已为本服务器打标的工具列表缓存（仅在连接重新列出时重建）
  tagged?: { readonly source: ReadonlyArray<McpClient.Tool>; readonly tools: ReadonlyArray<Tool> }
  // Set when a remote server is registered as an OAuth integration; the credential lives in the global store.
  // 远程服务器注册为 OAuth 集成时的集成 ID（凭证存全局存储）
  integrationID?: Integration.ID
  // 注册的清理句柄
  registration?: State.Registration
}

// A client-hosted MCP server attached over a connection the client opened. Internal: never listed,
// never reconciled against config, and removed entirely once its scope or connection closes.
// Connections attached under one name stack; the most recent live one serves the name's tools.
// 附着条目：客户端自托管、经由其打开的连接接入的 MCP 服务器；同名附着可叠加，最新存活者服务该名
type AttachedEntry = {
  // 附着作用域（关闭即拆除）
  readonly scope: Scope.Closeable
  // 客户端连接
  readonly client: McpClient.Connection
  // 打标的工具列表（可刷新）
  tools: ReadonlyArray<Tool>
}

// How long a model call may wait for a server that is still connecting, counted from when it began.
const STARTUP_GRACE_MS = 2_000

// Bounds re-listing the tools of an attached connection that takes over the top of its stack.
// 接管的附着连接重新列工具的超时上限
const FALLBACK_LIST_TIMEOUT = "5 seconds"

// MCP elicitations are Location-scoped, not Session-scoped: the server cannot attribute them to a
// persisted session row, so their forms are owned by this opaque sentinel session identifier.
// 交互表单按 Location 归属而非会话：用这个哨兵会话 ID 作为所有者
const GLOBAL_ELICITATION_SESSION_ID = "global"
// URL 交互表单的外部链接字段键
const URL_ELICITATION_FIELD_KEY = "elicitation"

// 目录变化对应的各类事件
const changes = { tools: McpEvent.ToolsChanged, resources: McpEvent.ResourcesChanged, prompts: PromptsChanged }

// A broken, silent or closed event stream reopens after a delay growing from a second to this cap.
const EVENT_REOPEN = Schedule.min([Schedule.exponential("1 second"), Schedule.spaced("30 seconds")])

const isEnded = (error: Error) =>
  error instanceof EventStreamRejectedError || error instanceof EventStreamTerminatedError

type Data = {
  // 当前配置中的服务器
  servers: Map<ServerName, Types.DeepMutable<Mcp.ServerConfig>>
  // 被移除的服务器名集合
  removed: Set<ServerName>
}

// 编辑器：对状态数据的受控修改接口
export type Editor = {
  // 列出全部服务器配置
  list: () => readonly [ServerName, Types.DeepMutable<Mcp.ServerConfig>][]
  // 读取一个服务器的配置
  get: (server: ServerName | string) => Types.DeepMutable<Mcp.ServerConfig> | undefined
  // 设置一个服务器的配置
  set: (server: ServerName | string, config: Mcp.ServerConfig) => void
  // 就地更新一个服务器的配置
  update: (server: ServerName | string, update: (config: Types.DeepMutable<Mcp.ServerConfig>) => void) => void
  // 移除一个服务器
  remove: (server: ServerName | string) => void
}

// cloneConfig：深拷贝服务器配置并放宽可变性
const cloneConfig = (config: Mcp.ServerConfig) => structuredClone(config) as Types.DeepMutable<Mcp.ServerConfig>

// MCP 服务接口：服务器管理、连接、工具、提示词与资源
export interface Interface extends State.Transformable<Editor> {
  // 列出服务器信息（按名称排序）
  readonly servers: () => Effect.Effect<ServerInfo[]>
  // 添加（覆盖）一个服务器配置
  readonly add: (server: ServerName | string, config: Mcp.ServerConfig) => Effect.Effect<void>
  // 连接一个服务器
  readonly connect: (server: ServerName | string) => Effect.Effect<void, NotFoundError>
  // 断开一个服务器
  readonly disconnect: (server: ServerName | string) => Effect.Effect<void, NotFoundError>
  // 移除一个服务器
  readonly remove: (server: ServerName | string) => Effect.Effect<void, NotFoundError>
  /**
   * Attaches a client-hosted MCP server for the lifetime of the calling scope. Its tools are named after
   * `name` like any server's. Attaching a name again stacks the new connection on top: it serves the
   * name until it closes, then the most recent remaining connection takes over.
   */
  // attach：在调用方作用域生命周期内附着一条客户端自托管的连接
  readonly attach: (name: string, transport: Transport) => Effect.Effect<void, McpClient.ConnectError, Scope.Scope>
  // 列出全部可用工具
  readonly tools: () => Effect.Effect<Tool[]>
  /**
   * Waits for servers that are still connecting, each until it settles or until its startup grace
   * window ends. Servers past their window never wait.
   */
  // awaitStartup：等待仍在连接中的服务器（各自的宽限窗口内）
  readonly awaitStartup: () => Effect.Effect<void>
  // 调用一个工具
  readonly callTool: (input: {
    // 服务器名
    readonly server: ServerName | string
    // 工具名
    readonly name: string
    // 参数
    readonly args?: Record<string, unknown>
    // 会话 ID
    readonly sessionID?: Session.ID
  }) => Effect.Effect<ToolResult, NotFoundError | ToolCallError>
  // 列出服务器指令
  readonly instructions: () => Effect.Effect<ServerInstructions[]>
  // 列出提示词
  readonly prompts: () => Effect.Effect<Prompt[]>
  // 获取一个提示词
  readonly prompt: (input: {
    // 服务器名
    readonly server: ServerName | string
    // 提示词名
    readonly name: string
    // 参数
    readonly args?: Record<string, string>
  }) => Effect.Effect<PromptResult | undefined, NotFoundError>
  // 拉取全部服务器的资源目录
  readonly resourceCatalog: () => Effect.Effect<ResourceCatalog>
  // 拉取指定服务器的资源目录
  readonly resources: (input: { readonly server: ServerName | string }) => Effect.Effect<ResourceCatalog, Error>
  // 读取一个资源
  readonly readResource: (input: {
    // 服务器名
    readonly server: ServerName | string
    // 资源 URI
    readonly uri: string
  }) => Effect.Effect<ResourceContent | undefined, Error>
  /** Experimental: MCP Events of a connected server that offers them, while the `mcp_events` flag is on. */
  readonly events: (server: ServerName | string) => Effect.Effect<McpClient.Events | undefined, NotFoundError>
  /**
   * Experimental: follows an event type of a server, publishing each event as `experimental.mcp.event` while the
   * server is connected, and resuming from the last cursor after a reconnect or a broken stream. Its status changes
   * publish `experimental.mcp.subscription.changed`. Subscribing again to the same server, name and arguments returns
   * the existing subscription. Subscriptions last as long as this service, and an ended one stays until unsubscribed.
   */
  readonly subscribe: (
    server: ServerName | string,
    input: {
      readonly name: string
      readonly arguments?: Schema.JsonObject
      /** Where to start; omitted or null starts from now. */
      readonly cursor?: string | null
    },
  ) => Effect.Effect<Subscription, NotFoundError | EventsUnavailableError>
  /** Experimental: stops following a subscription. */
  readonly unsubscribe: (id: string) => Effect.Effect<void>
  /** Experimental: every subscription, with its status. */
  readonly subscriptions: () => Effect.Effect<ReadonlyArray<Subscription>>
}

// Effect 服务标识（Tag）
export class Service extends Context.Service<Service, Interface>()("@opencode/MCP") {}

/**
 * Why `subscribe` cannot follow a server's events.
 * Experimental: MCP Events is a draft extension; may change without compatibility guarantees.
 */
export class EventsUnavailableError extends Schema.TaggedError<EventsUnavailableError>()("MCP.EventsUnavailableError", {
  server: ServerName,
  message: Schema.String,
}) {}

/**
 * An event type of a server, followed onto the bus as `experimental.mcp.event`.
 * Experimental: MCP Events is a draft extension; may change without compatibility guarantees.
 */
export interface Subscription {
  /** The same for every subscribe to this server, event name and arguments, within this Location. */
  readonly id: string
  readonly server: ServerName
  readonly name: string
  readonly arguments?: Schema.JsonObject
  readonly status: Mcp.SubscriptionStatus
  /** Where it resumes from: the last cursor the server sent. */
  readonly cursor: string | null
}

export const Options = Schema.Struct({
  clientInfo: Schema.optional(
    Schema.Struct({
      // 客户端名
      name: Schema.String,
      // 版本
      version: Schema.String,
    }),
  ),
})
// 选项类型
export type Options = typeof Options.Type

// MCP 服务层工厂
export const layer = (options?: Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      // 取回位置服务
      const location = yield* Location.Service
      // 取回环境服务
      const environment = yield* Environment.Service
      // 取回事件总线
      const bus = yield* Bus.Service
      // 取回表单服务
      const forms = yield* Form.Service
      // 取回集成服务
      const integration = yield* Integration.Service
      // 取回凭证服务
      const credentials = yield* Credential.Service
      // 取回注入的 fetch
      const fetch = yield* FetchHttpClient.Fetch
      // 取回连接池服务
      const pool = yield* McpPool.Service
      const mcpEvents = yield* Flag.enabled("mcp_events")
      const root = yield* Effect.scope
      // 运行时纤程集合
      const fork = yield* FiberSet.makeRuntime<never, void, never>()
      // Server scopes close in parallel on shutdown, so one slow server's stop grace does not delay
      // the rest past a service restart's kill deadline and leave them orphaned.
      // 服务器作用域分叉为并行：关停时一个慢服务器不会拖累其他服务器的清理
      const servers = yield* Scope.fork(root, "parallel")
      // Connection callbacks run here. Created after `servers`, so the layer scope closes this set first
      // (finalizers run in reverse): in-flight callbacks are interrupted and later ones never start, so
      // connections closing with the Location publish nothing. Clients re-fetch on MCP events, which
      // would boot the Location straight back up.
      // 回调纤程集合：晚于 servers 创建，关停时先被关闭，避免连接关闭时还发布事件
      const callbacks = yield* FiberSet.makeRuntime<never, void, never>()

      // 服务器条目表
      const entries = new Map<ServerName, ServerEntry>()
      // 附着条目栈表（同名可叠加）
      const attached = new Map<ServerName, AttachedEntry[]>()
      // Serializes lifecycle operations per server. Anything taking this lock from a connection
      // callback must stay forked: lifecycle operations close scopes while holding it, firing onClose.
      // 按服务器串行化生命周期操作的锁
      const locks = KeyedMutex.makeUnsafe<ServerName>()
      // Runs a requested lifecycle operation to the end even if its caller is interrupted, such as by a
      // client dropping the HTTP request. Stopped halfway, a server stays "pending" after a cancelled
      // connect, or "connected" with no connection after a cancelled disconnect. Location shutdown
      // still interrupts it.
      // transition：让生命周期操作跑完（调用方中断也不停半路）；Location 关停仍会打断
      const transition = <E>(effect: Effect.Effect<void, E>) =>
        Effect.forkIn(effect, root, { startImmediately: true }).pipe(Effect.flatMap(Fiber.join))
      // Attached connections lock separately so a configured server of the same name never contends.
      // 附着连接使用独立的锁（与同名配置服务器互不争用）
      const attachedLocks = KeyedMutex.makeUnsafe<ServerName>()
      // Legacy era only: pending URL-mode elicitation forms, settled by notifications/elicitation/complete.
      // 仅旧版协议：待完成的 URL 交互表单（键 -> 表单 ID）
      const urlElicitations = new Map<string, Form.ID>()

      // Experimental MCP Events subscriptions, by server. Each streams while its server is connected; the streams
      // run here, in this Location, not in a pooled connection's scope.
      type Followed = { -readonly [K in keyof Subscription]: Subscription[K] } & { gap: boolean }
      const followed = new Map<ServerName, Map<string, Followed>>()
      const streams = yield* FiberMap.make<string>()
      const runStream = yield* FiberMap.runtime(streams)<never>()
      const view = (sub: Followed): Subscription => ({
        id: sub.id,
        server: sub.server,
        name: sub.name,
        arguments: sub.arguments,
        status: sub.status,
        cursor: sub.cursor,
      })

      const setStatus = (sub: Followed, status: Mcp.SubscriptionStatus) =>
        Effect.suspend(() => {
          if (sub.status.status === status.status) return Effect.void
          sub.status = status
          return bus.publish(McpEvent.ExperimentalSubscriptionChanged, { id: sub.id })
        })

      const receive = (sub: Followed, message: McpClient.EventMessage) => {
        if (message.type === "error")
          return Effect.logWarning("mcp event stream error", {
            server: sub.server,
            name: sub.name,
            code: message.error.code,
          })
        if (message.type === "heartbeat")
          return Effect.sync(() => {
            sub.cursor = message.cursor
          })
        if (message.type === "active")
          return Effect.sync(() => {
            sub.cursor = message.cursor
            sub.gap ||= message.cursor !== null && message.truncated
          }).pipe(Effect.andThen(setStatus(sub, { status: "active" })))
        // The cursor moves past the event only once it is published.
        return bus
          .publish(McpEvent.ExperimentalEvent, {
            id: sub.id,
            server: sub.server,
            name: sub.name,
            eventId: message.eventId,
            timestamp: message.timestamp,
            data: message.data,
            cursor: message.cursor,
            ...(sub.gap ? { truncated: true } : {}),
          })
          .pipe(
            Effect.andThen(
              Effect.sync(() => {
                sub.cursor = message.cursor
                sub.gap = false
              }),
            ),
          )
      }

      // Streams until the server terminates or rejects the subscription. A clean close reopens like a broken stream.
      const follow = (sub: Followed, events: McpClient.Events) =>
        Stream.suspend(() => events.stream({ name: sub.name, arguments: sub.arguments, cursor: sub.cursor })).pipe(
          Stream.tap((message) => receive(sub, message)),
          // Stream.retry resets on output. Only a confirmed open resets the delay, not a failed attempt.
          Stream.filter((message) => message.type === "active"),
          Stream.concat(Stream.fail(new Error(`MCP server ${sub.server} closed the event stream`))),
          Stream.tapError((error) => (isEnded(error) ? Effect.void : setStatus(sub, { status: "pending" }))),
          Stream.retry(
            EVENT_REOPEN.pipe(
              Schedule.setInputType<Error>(),
              Schedule.while(({ input }) => !isEnded(input)),
            ),
          ),
          Stream.runDrain,
          Effect.catch((error) =>
            isEnded(error)
              ? setStatus(sub, {
                  status: "ended",
                  reason: error instanceof EventStreamRejectedError ? "rejected" : "terminated",
                  error: { code: error.code, message: error.message },
                })
              : Effect.void,
          ),
        )

      // Starts or stops a server's subscriptions to match its status; runs on every status change.
      const follows = Effect.fnUntraced(function* (server: ServerName) {
        const entry = entries.get(server)
        const client = entry?.status.status === "connected" ? entry.connection.client : undefined
        for (const sub of followed.get(server)?.values() ?? []) {
          if (sub.status.status === "ended") continue
          if (client?.events) {
            runStream(sub.id, follow(sub, client.events), { onlyIfMissing: true })
            continue
          }
          yield* FiberMap.remove(streams, sub.id)
          yield* setStatus(
            sub,
            !entry || entry.status.status === "disabled" || client
              ? { status: "ended", reason: "unavailable" }
              : { status: "pending" },
          )
        }
      })
      if (mcpEvents)
        yield* bus.subscribe(McpEvent.StatusChanged).pipe(
          Stream.runForEach((event) => follows(ServerName.make(event.data.server))),
          Effect.forkScoped({ startImmediately: true }),
        )

      // Register every remote server as an OAuth integration so credentials live in the global store
      // rather than in committed config. Servers that connect anonymously simply never use the method.
      // register：把远程服务器注册为 OAuth 集成（匿名连接的服务器永远不会用到该方法）
      const register = Effect.fnUntraced(function* (name: ServerName, entry: ServerEntry) {
        // 非远程或显式关闭 oauth：不注册
        if (entry.config.type !== "remote" || entry.config.oauth === false) return
        // 取远程配置
        const remote = entry.config
        // Key identity on name + url, not url alone: two configs for the same url under different names are
        // distinct logical servers that may hold different accounts, so they must not share a credential row.
        // 以 名称+URL 生成集成 ID 后缀（同一 URL 不同名的服务器视为不同逻辑服务器）
        const suffix =
          "mcp_" +
          createHash("sha1")
            .update(name + "\u0000" + remote.url)
            .digest("hex")
            .slice(0, 16)
        // 生成集成 ID
        const integrationID = Integration.ID.make(suffix)
        // 登记到条目
        entry.integrationID = integrationID
        // 生成认证方式 ID
        const methodID = Integration.MethodID.make(suffix)
        // Each registration gets its own child scope so disposal detaches it from the root scope
        // entirely; registering directly on root would accumulate a dead finalizer per replaced or
        // removed server for the lifetime of the layer.
        // 每次注册一个独立子作用域：移除时整体脱离根作用域，不在根上积累死终结器
        const scope = yield* Scope.fork(root)
        // 登记清理句柄
        entry.registration = { dispose: Scope.close(scope, Exit.void) }
        // 在该作用域内注册集成与认证方式
        yield* integration
          .transform((editor) => {
            // 更新集成条目：名称与来源元数据
            editor.update(integrationID, (ref) => {
              ref.name = name
              ref.metadata = { source: "mcp" }
            })
            // 注册 oauth 认证方式及其授权入口
            editor.method.update({
              integrationID,
              method: { id: methodID, type: "oauth", label: name },
              authorize: () =>
                Effect.gen(function* () {
                  // 懒加载 OAuth 模块
                  const { McpOAuth } = yield* Effect.promise(() => import("./oauth.js"))
                  // 执行授权（注入凭证服务与 fetch）
                  return yield* McpOAuth.authorize({ name, config: remote, integrationID, methodID }).pipe(
                    Effect.provideService(Credential.Service, credentials),
                    Effect.provideService(FetchHttpClient.Fetch, fetch),
                  )
                }),
            })
          })
          .pipe(Scope.provide(scope))
      })
      // requireServer：取条目，不存在则报 NotFoundError
      const requireServer = Effect.fnUntraced(function* (name: ServerName) {
        // 查表
        const entry = entries.get(name)
        // 缺失即失败
        if (!entry) return yield* new NotFoundError({ server: name })
        // 返回条目
        return entry
      })
      // connected：等待服务器启动闭锁并返回条目与客户端
      const connected = Effect.fnUntraced(function* (name: ServerName) {
        // 先取条目
        const entry = yield* requireServer(name)
        // 等待启动闭锁
        yield* entry.startup.await
        // 返回条目与（可能为空的）客户端
        return { entry, client: entry.connection.client }
      })

      // The credential one start connects with: the integration's latest, or none. Read it once per start and
      // pass the result along, so anything keyed on it and the provider it builds agree on the account.
      // selectCredential：选出本次 start 使用的凭证（集成的最新一条，或无）
      const selectCredential = (entry: ServerEntry) =>
        entry.config.type === "remote" && entry.integrationID
          ? credentials.list(entry.integrationID).pipe(Effect.map((rows) => rows.at(-1)))
          : Effect.succeed(undefined)

      // connectProvider：为条目与凭证构建 OAuth 提供者
      const connectProvider = Effect.fnUntraced(function* (
        name: ServerName,
        entry: ServerEntry,
        credential: Credential.Info | undefined,
      ) {
        // 非远程或无集成 ID：无提供者
        if (entry.config.type !== "remote" || !entry.integrationID) return undefined
        // 懒加载 OAuth 模块
        const { McpOAuth } = yield* Effect.promise(() => import("./oauth.js"))
        return yield* McpOAuth.connectProvider({ server: name, config: entry.config, credential }).pipe(
          Effect.provideService(Credential.Service, credentials),
          Effect.provideService(FetchHttpClient.Fetch, fetch),
        )
      })

      // elicitation：交互处理器（表单服务实现）
      const elicitation: McpClient.ElicitationHandler = {
        // create：应答一次交互请求
        create: (input: {
          // 服务器名
          readonly server: string
          // 交互参数
          readonly params: McpClient.ElicitationParams
          // 中止信号
          readonly signal: AbortSignal
        }) =>
          Effect.gen(function* () {
            // URL 模式：表单只含一个外链字段
            if (input.params.mode === "url") {
              // 创建表单 ID
              const formID = Form.ID.create()
              // Legacy only: 2026-07-28 has no elicitationId and no completion notification, so the form
              // settles when the user confirms and the SDK retries the tool call itself.
              // 取交互 ID（仅旧版协议有）
              const elicitationID = input.params.elicitationId
              // 组合待完成映射的键
              const key = elicitationID === undefined ? undefined : input.server + "\u0000" + elicitationID
              // 有键时登记待完成表单
              if (key) urlElicitations.set(key, formID)
              // 弹出表单并等待应答（与中止信号竞速）
              return yield* forms
                .ask({
                  // 表单 ID
                  id: formID,
                  // 哨兵会话（Location 级归属）
                  sessionID: GLOBAL_ELICITATION_SESSION_ID,
                  // 标题
                  title: `${input.server} is requesting input`,
                  // 元数据：种类、服务器、可选交互 ID 与消息
                  metadata: {
                    kind: "mcp-elicitation",
                    server: input.server,
                    ...(elicitationID === undefined ? {} : { elicitationID }),
                    message: input.params.message,
                  },
                  // 唯一字段：外链
                  fields: [{ key: URL_ELICITATION_FIELD_KEY, type: "external", url: input.params.url }],
                })
                .pipe(
                  // 用户中止信号抢先结束等待
                  Effect.raceFirst(waitForAbort(input.signal)),
                  // 无论结果都清理待完成登记
                  Effect.ensuring(Effect.sync(() => key && urlElicitations.delete(key))),
                  // 把表单状态映射为交互结果
                  Effect.map(
                    (state): McpClient.ElicitationResult => ({
                      action: state.status === "answered" ? "accept" : "cancel",
                    }),
                  ),
                )
            }
            // 表单模式：取参数
            const params = input.params
            // 把请求的属性映射为表单字段
            const [field, ...fields] = Object.entries(params.requestedSchema.properties).map(([key, property]) =>
              toElicitationField(key, property, params.requestedSchema.required?.includes(key) === true),
            )
            // 没有任何字段：直接接受
            if (!field) return { action: "accept" as const, content: {} }
            // 弹出表单并等待应答
            return yield* forms
              .ask({
                // 哨兵会话
                sessionID: GLOBAL_ELICITATION_SESSION_ID,
                // 标题
                title: `${input.server} is requesting input`,
                // 元数据
                metadata: { kind: "mcp-elicitation", server: input.server, message: params.message },
                // 全部字段
                fields: [field, ...fields],
              })
              .pipe(
                // 用户中止信号抢先结束
                Effect.raceFirst(waitForAbort(input.signal)),
                // 把表单应答映射为交互结果
                Effect.map((state): McpClient.ElicitationResult => {
                  // 未应答视为取消
                  if (state.status !== "answered") return { action: "cancel" }
                  return {
                    // 接受并携带内容
                    action: "accept",
                    // 把答案归一化（数组化对象值）
                    content: Object.fromEntries(
                      Object.entries(state.answer).map(
                        ([key, value]): [string, NonNullable<McpClient.ElicitationResult["content"]>[string]] =>
                          typeof value === "object" ? [key, Array.from(value)] : [key, value],
                      ),
                    ),
                  }
                }),
              )
          }).pipe(
            // A shared connection runs its handlers outside this Location; forms must still belong to it.
            // 共享连接的处理器运行在本 Location 之外，表单仍须归属本 Location
            Effect.provideService(Location.Service, location),
          ),
        // complete：旧版 URL 交互的带外完成通知
        complete: (input: { readonly server: string; readonly elicitationID: string }) =>
          Effect.gen(function* () {
            // 查待完成表单
            const formID = urlElicitations.get(input.server + "\u0000" + input.elicitationID)
            // 找不到就忽略
            if (!formID) return
            // 回复表单（字段为 true），忽略错误
            yield* forms.reply({ id: formID, answer: { [URL_ELICITATION_FIELD_KEY]: true } }).pipe(Effect.ignore)
          }),
      }

      // makeEntry：创建一个服务器条目（决定是否入池并接线全部事件）
      const makeEntry = (name: ServerName, config: Mcp.ServerConfig, started: number): ServerEntry => {
        // Local servers run on this Location's execution plane, so only Locations on the host share them.
        // 是否入池：显式开启、非旧协议、且（远程 或 本 Location 就在宿主机上）
        const pooled =
          config.pool === true &&
          config.protocol !== "legacy" &&
          (config.type === "remote" || location.workspaceID === undefined)
        // share：把连接输入交给连接池共享
        const share = (input: McpConnection.Input) =>
          pool.connection({
            // 展开输入
            ...input,
            // select：每次 start 运行一次，产出共享键与提供者
            select: Effect.gen(function* () {
              // 远程服务器：选定凭证并生成键
              if (input.config.type === "remote") {
                // 选定凭证
                const credential = yield* selectCredential(entry)
                return {
                  // 键：把凭证 ID 纳入
                  key: McpPool.key({ ...input, credential: credential?.id }),
                  authProvider: connectProvider(name, entry, credential),
                }
              }
              // Resolved exactly as the spawn resolves it, `~` included, so the key matches where the server runs.
              // 本地服务器：cwd 与 spawn 时解析方式完全一致（含 ~ 展开）
              const { McpStdio } = yield* Effect.promise(() => import("./stdio.js"))
              return {
                // 键：纳入解析后的 cwd
                key: McpPool.key({ ...input, cwd: McpStdio.resolveCwd(input.directory, input.config.cwd) }),
                // 提供者沿用输入
                authProvider: input.authProvider,
              }
            }),
          })
        // 组装条目
        const entry: ServerEntry = {
          // 配置
          config,
          // 初始状态：待连接
          status: { status: "pending" },
          // 启动闭锁
          startup: Latch.makeUnsafe(),
          // 初始尝试（开始时间由调用方给定）
          attempt: { started, settled: Latch.makeUnsafe() },
          // 连接：入池或独立创建
          connection: (pooled ? share : McpConnection.make)({
            // 服务器名
            name,
            // Pooling offers 2026-07-28, the only revision a connection can be shared on.
            // 入池且未配置协议时改用 auto（共享只在 2026-07-28 上可行）
            config: config.pool && config.protocol === undefined ? { ...config, protocol: "auto" } : config,
            // Location 目录
            directory: location.directory,
            // 客户端标识
            clientInfo: options?.clientInfo,
            mcpEvents,
            authProvider: Effect.suspend(() =>
              selectCredential(entry).pipe(Effect.flatMap((credential) => connectProvider(name, entry, credential))),
            ),
            // 交互处理器
            elicitation,
            // 环境服务
            environment,
            // fetch
            fetch,
            // 服务器作用域
            scope: servers,
            // 生命周期锁
            lock: locks.withLock(name),
            // 回调运行时
            callbacks,
            // 后台恢复运行时
            fork,
            // 事件接线
            events: {
              // connecting：登记尝试并置为待连接
              connecting: Effect.gen(function* () {
                // A server still pending from creation keeps the window that started with its entry.
                // 无进行中尝试或状态不再是 pending 时新开一轮尝试窗口
                if (!entry.attempt || entry.status.status !== "pending")
                  entry.attempt = { started: yield* Clock.currentTimeMillis, settled: Latch.makeUnsafe() }
                // Announce the handshake so connect() and credential reconnects don't show a stale
                // disabled/failed status for the duration of the connection attempt.
                // 置为 pending，避免握手期间展示陈旧的禁用/失败状态
                entry.status = { status: "pending" }
                // 广播状态变化
                yield* bus.publish(McpEvent.StatusChanged, { server: name })
              }),
              // connected：置为已连接并广播全部事件
              connected: Effect.gen(function* () {
                // 更新状态
                entry.status = { status: "connected" }
                // 记日志（含工具数）
                yield* Effect.logInfo("mcp connected", { server: name, tools: entry.connection.tools?.length })
                // Announce every list a consumer may read, since each reads them only on these events. A
                // connection another Location already holds has loaded its prompts, and no later change
                // would tell this one; prompts still loading read empty now and announce themselves later.
                // 广播工具变化
                yield* bus.publish(McpEvent.ToolsChanged, { server: name })
                // 广播资源变化
                yield* bus.publish(McpEvent.ResourcesChanged, { server: name })
                // 广播提示词变化
                yield* bus.publish(PromptsChanged, { server: name })
                // 广播状态变化
                yield* bus.publish(McpEvent.StatusChanged, { server: name })
              }),
              // failed：记录失败并广播
              failed: (failure) =>
                Effect.gen(function* () {
                  // 更新状态
                  entry.status = failure
                  // 记警告日志
                  yield* Effect.logWarning("mcp connect failed", { server: name, status: entry.status })
                  // 广播状态变化
                  yield* bus.publish(McpEvent.StatusChanged, { server: name })
                }),
              // Every start runs under the server lock, so the attempt read here is the one it began.
              // settled：结算当前尝试并打开启动闭锁
              settled: Effect.suspend(() => {
                // 取当前尝试
                const attempt = entry.attempt
                // 清空尝试
                entry.attempt = undefined
                // 打开尝试闭锁（有尝试时），并确保启动闭锁必然打开
                return (attempt ? attempt.settled.open : Effect.void).pipe(Effect.ensuring(entry.startup.open))
              }),
              // closed：活跃连接自行关闭——停止连接并广播失败
              closed: (reason) =>
                Effect.gen(function* () {
                  // 置为失败
                  entry.status = { status: "failed", error: reason }
                  // 停止底层连接
                  yield* entry.connection.stop
                  // 广播状态变化
                  yield* bus.publish(McpEvent.StatusChanged, { server: name })
                }),
              // changed：目录变化转发为对应事件
              changed: (kind) => bus.publish(changes[kind], { server: name }),
            },
          }),
        }
        // 返回条目
        return entry
      }

      // MCP.tools() runs every step and the tool registry compares tools by identity, so tag the
      // connection's list once per listing instead of on every read.
      // serverTools：为连接的工具列表打上服务器标（按列表引用缓存，避免每次读取重建）
      const serverTools = (name: ServerName, entry: ServerEntry) => {
        // 取连接的工具列表
        const source = entry.connection.tools
        // 未连接时返回空
        if (!source) return []
        // 列表引用变化时重建打标缓存
        if (entry.tagged?.source !== source)
          entry.tagged = {
            source,
            tools: source.map(
              (tool): Tool => ({
                // 展开原工具字段
                ...tool,
                // 打上服务器名
                server: name,
                // 附加 codemode 配置
                codemode: entry.config.codemode,
              }),
            ),
          }
        // 返回缓存的打标列表
        return entry.tagged.tools
      }

      // toCatalog：把底层连接的目录转换为 schema 资源目录
      const toCatalog = (name: ServerName, catalog: McpConnection.Catalog) =>
        ResourceCatalog.make({
          // 逐个转换资源
          resources: catalog.resources.map((resource) =>
            Resource.make({
              // 服务器名
              server: name,
              // 资源名
              name: resource.name,
              // URI
              uri: resource.uri,
              // 描述
              description: resource.description,
              // MIME 类型
              mimeType: resource.mimeType,
            }),
          ),
          // 逐个转换模板
          templates: catalog.templates.map((template) =>
            ResourceTemplate.make({
              // 服务器名
              server: name,
              // 模板名
              name: template.name,
              // URI 模板
              uriTemplate: template.uriTemplate,
              // 描述
              description: template.description,
              // MIME 类型
              mimeType: template.mimeType,
            }),
          ),
        })

      // disposeServer：停止连接并注销集成
      const disposeServer = Effect.fnUntraced(function* (entry: ServerEntry) {
        // 停止底层连接
        yield* entry.connection.stop
        // 有注册句柄时注销
        if (entry.registration) yield* entry.registration.dispose
      })

      // replaceServer：用新配置替换服务器（先接入新条目再清理旧的）
      const replaceServer = Effect.fnUntraced(function* (name: ServerName, serverConfig: Mcp.ServerConfig) {
        // 取旧条目
        const previous = entries.get(name)
        if (previous) yield* disposeServer(previous)
        const entry = makeEntry(name, serverConfig, yield* Clock.currentTimeMillis)
        entries.set(name, entry)
        yield* Effect.gen(function* () {
          // 注册集成
          yield* register(name, entry)
          // 禁用的服务器：置状态并广播，不启动
          if (serverConfig.disabled) {
            entry.status = { status: "disabled" }
            yield* bus.publish(McpEvent.StatusChanged, { server: name })
            return
          }
          // 启动连接
          yield* entry.connection.start
        }).pipe(
          // Settle startup even when registration fails or replacement is interrupted, so readers cannot hang.
          // 注册失败或替换被打断也要结算启动闭锁，读取者才不会悬挂
          Effect.ensuring(entry.startup.open),
        )
      })

      // removeServer：移除服务器（清理条目并广播）
      const removeServer = Effect.fnUntraced(function* (name: ServerName, entry: ServerEntry) {
        // 清理条目（连接与注册）
        yield* disposeServer(entry)
        // Credentials are keyed by name + URL and intentionally survive removal for a later re-add.
        // 从表中删除（凭证保留，供日后重新添加）
        entries.delete(name)
        // 广播状态变化
        yield* bus.publish(McpEvent.StatusChanged, { server: name })
      })

      // toAttachedTools：为附着连接的工具列表打上服务器标
      const toAttachedTools = (server: ServerName, tools: ReadonlyArray<McpClient.Tool>) =>
        tools.map((tool): Tool => ({ ...tool, server }))

      // detach：把一个附着条目从栈上摘除（栈顶关闭时由下一个接管并刷新工具）
      const detach = Effect.fnUntraced(function* (name: ServerName, entry: AttachedEntry) {
        // 取当前栈
        const stack = attached.get(name) ?? []
        // 不在栈上则无事
        if (!stack.includes(entry)) return
        // 过滤掉该条目
        const remaining = stack.filter((item) => item !== entry)
        // 栈顶候补
        const next = remaining.at(-1)
        // 栈空：整体删除并广播
        if (!next) {
          attached.delete(name)
          yield* Scope.close(entry.scope, Exit.void)
          return yield* bus.publish(McpEvent.ToolsChanged, { server: name })
        }
        // Unlocked reads must never pick a closing connection, so update the stack before closing it.
        // 先更新栈再关闭（无锁读取不会选中正在关闭的连接）
        attached.set(name, remaining)
        // 关闭该条目的作用域
        yield* Scope.close(entry.scope, Exit.void)
        // Closing an idle connection changes nothing visible.
        // 关闭的不是栈顶：可见状态不变
        if (stack.at(-1) !== entry) return
        // Idle connections ignore tool list changes, so the one taking over lists its tools again. A short
        // timeout keeps a half-open connection from holding the lock; it then keeps its stored tools.
        // 接管者重新列工具（限时 5 秒，超时沿用已存列表）
        const previous = next.tools
        yield* next.client.tools().pipe(
          Effect.timeout(FALLBACK_LIST_TIMEOUT),
          Effect.map((tools) => {
            next.tools = toAttachedTools(name, tools)
          }),
          Effect.ignore,
        )
        // Readers may have seen the stored tools in the meantime, so compare against both.
        // 工具列表有变（与关闭前或接管前任一不同）才广播
        if (!isDeepStrictEqual(entry.tools, next.tools) || !isDeepStrictEqual(previous, next.tools))
          yield* bus.publish(McpEvent.ToolsChanged, { server: name })
      })

      // The handshake runs interruptibly and outside the lock, so a stalled client never blocks detach or
      // fallback for its name; the lock only guards adding the finished connection to the stack.
      // attach：接入一条客户端自托管的连接
      const attach = Effect.fnUntraced(function* (name: ServerName, transport: Transport) {
        // 懒加载客户端模块
        const { McpClient } = yield* Effect.promise(() => import("./client.js"))
        // 分叉一个可关闭的作用域（结束时自动关闭）
        const scope = yield* Effect.acquireRelease(Scope.fork(root), (scope) => Scope.close(scope, Exit.void))
        // The client registers its own close only once initialized; closing the scope mid-handshake (caller
        // interruption or Location shutdown) must still close the transport right away.
        // 握手期间作用域被关（中断/关停）也要立即关闭传输
        yield* Scope.addFinalizer(scope, Effect.promise(() => transport.close()).pipe(Effect.ignore))
        // 连接是否已自行关闭
        let closed = false
        // 执行连接并列出工具（错误统一映射为 ConnectError）
        const result = yield* McpClient.connect({
          // 服务器名
          server: name,
          // 附着配置
          config: { type: "attached", transport },
          // 目录
          directory: location.directory,
          // 交互处理器
          elicitation,
          // 客户端标识
          clientInfo: options?.clientInfo,
        }).pipe(
          // 连接后登记“已自行关闭”标记
          Effect.tap((connection) =>
            Effect.sync(() =>
              connection.onClose(() => {
                closed = true
              }),
            ),
          ),
          // 连接成功后列出工具
          Effect.flatMap((connection) => connection.tools().pipe(Effect.map((tools) => ({ connection, tools })))),
          // 注入环境服务
          Effect.provideService(Environment.Service, environment),
          // 绑定作用域
          Scope.provide(scope),
          // 失败时关闭作用域
          Effect.onError(() => Scope.close(scope, Exit.void)),
          // 错误统一转成 ConnectError
          Effect.mapError((error) =>
            error instanceof McpClient.ConnectError
              ? error
              : new McpClient.ConnectError({ server: name, message: error.message }),
          ),
        )
        // register：把连接登记进栈（在附着锁内执行）
        const register = Effect.gen(function* () {
          // 连接已自行关闭：关闭作用域并报错
          if (closed) {
            yield* Scope.close(scope, Exit.void)
            return yield* new McpClient.ConnectError({ server: name, message: "Connection closed" })
          }
          // 组装条目
          const entry: AttachedEntry = { scope, client: result.connection, tools: toAttachedTools(name, result.tools) }
          // 压入栈
          attached.set(name, [...(attached.get(name) ?? []), entry])
          // locked：在附着锁内、经回调运行时执行
          const locked = <E>(effect: Effect.Effect<void, E>) =>
            fork(effect.pipe(attachedLocks.withLock(name), Effect.ignore))
          // 连接关闭时摘除条目
          result.connection.onClose(() => locked(detach(name, entry)))
          // Bounded like fallback so a connection that stalls after announcing a change cannot hold the lock.
          // 刷新：重新列工具并广播（限时，防止卡住的连接长期持锁）
          const refresh = result.connection.tools().pipe(
            Effect.timeout(FALLBACK_LIST_TIMEOUT),
            Effect.map((tools) => {
              entry.tools = toAttachedTools(name, tools)
            }),
            Effect.andThen(bus.publish(McpEvent.ToolsChanged, { server: name })),
          )
          // 工具变化且该条目仍是栈顶时刷新
          result.connection.onToolsChanged(() =>
            locked(Effect.suspend(() => (attached.get(name)?.at(-1) === entry ? refresh : Effect.void))),
          )
          // 记日志（含工具数）
          yield* Effect.logInfo("mcp client attached", { server: name, tools: entry.tools.length })
          // 广播工具变化
          yield* bus.publish(McpEvent.ToolsChanged, { server: name })
          // 返回条目
          return entry
        })
        // 登记并确保释放时摘除（都在附着锁内）
        yield* Effect.acquireRelease(register.pipe(attachedLocks.withLock(name)), (entry) =>
          detach(name, entry).pipe(attachedLocks.withLock(name)),
        )
      })

      // 是否已完成首次引导
      let booted = false
      // 配置覆盖表（false 表示移除）
      const overrides = new Map<ServerName, Mcp.ServerConfig | false>()
      // 协调（reconcile）串行信号量
      const reconcileLock = Semaphore.makeUnsafe(1)
      // reconcile：把状态数据中的配置同步到条目表
      const reconcile = Effect.fnUntraced(function* () {
        // 读取当前状态数据
        const servers = state.get().servers
        // 首次引导：创建全部条目并异步启动
        if (!booted) {
          booted = true
          // 统一的开始时间（所有条目同一窗口起点）
          const started = yield* Clock.currentTimeMillis
          // 逐个创建条目
          for (const [name, server] of servers) {
            entries.set(name, makeEntry(name, server, started))
          }
          // 逐个注册集成
          yield* Effect.forEach(entries, ([name, entry]) => register(name, entry), { discard: true })

          // Initial connections stay asynchronous so one slow server does not block Location startup.
          // 初始连接异步启动，避免慢服务器阻塞 Location 启动
          for (const [name, entry] of entries) {
            // 禁用的服务器：置状态、直接开锁并广播
            if (entry.config.disabled) {
              entry.status = { status: "disabled" }
              entry.startup.openUnsafe()
              yield* bus.publish(McpEvent.StatusChanged, { server: name })
              continue
            }
            fork(
              Effect.gen(function* () {
                // connect() or disconnect() may have settled the server while this startup waited to run.
                // 启动等待期间状态已不是 pending（被 connect/disconnect 处理过）时只需开锁
                if (entry.status.status !== "pending") return yield* entry.startup.open
                // 正常启动
                yield* entry.connection.start
              }).pipe(locks.withLock(name)),
            )
          }
          return
        }

        // 后续协调：变更的替换、消失的移除
        for (const [name, entry] of entries) {
          // 取新配置
          const updated = servers.get(name)
          // 配置未变：跳过
          if (isDeepStrictEqual(entry.config, updated)) continue
          // 有新配置则替换，否则移除（都在服务器锁内）
          yield* (updated ? replaceServer(name, updated) : removeServer(name, entry)).pipe(locks.withLock(name))
        }
        // 新增的服务器
        for (const [name, updated] of servers) {
          if (!entries.has(name)) yield* replaceServer(name, updated).pipe(locks.withLock(name))
        }
      })

      // Bring a server online (or back to needs_auth) when its integration's credential changes, so an
      // OAuth login takes effect without a restart. Only fires for the integrations we registered.
      // reconnect：集成凭证变化时重启对应服务器（OAuth 登录即时生效）
      const reconnect = (integrationID: Integration.ID) =>
        Effect.gen(function* () {
          // 找到使用该集成的条目
          const match = Array.from(entries).find(([, entry]) => entry.integrationID === integrationID)
          // 没有匹配则忽略
          if (!match) return
          // 取服务器名
          const name = match[0]
          yield* Effect.gen(function* () {
            // add() or remove() may have replaced or deleted the entry while we waited for the lock.
            // 拿到锁后再核对条目（期间可能已被替换或删除）
            const entry = entries.get(name)
            if (!entry || entry.integrationID !== integrationID) return
            // 禁用的服务器不自动重连
            if (entry.status.status === "disabled") return
            // 停止并重启
            yield* entry.connection.stop
            yield* entry.connection.start
          }).pipe(locks.withLock(name))
        })
      // 订阅凭证切换事件，逐个触发重连
      fork(
        bus
          .subscribe(Credential.Event.Switched)
          .pipe(Stream.runForEach((event) => Effect.sync(() => fork(reconnect(event.data.integrationID))))),
      )
      // 创建状态管理（编辑器 + 协调）
      const state: State.Interface<Data, Editor> = State.create<Data, Editor>({
        // 状态名
        name: "mcp",
        // 初始数据：由覆盖表生成
        initial: () => ({
          servers: new Map(
            Array.from(overrides).flatMap(([name, config]) =>
              config === false ? [] : [[name, cloneConfig(config)] as const],
            ),
          ),
          removed: new Set(Array.from(overrides).flatMap(([name, config]) => (config === false ? [name] : []))),
        }),
        // 编辑器实现
        editor: (editor) => ({
          // 列出全部
          list: () => Array.from(editor.servers),
          // 读取（键归一化为 ServerName）
          get: (server) => editor.servers.get(ServerName.make(server)),
          // 设置（已移除的不复活）
          set: (server, serverConfig) => {
            const name = ServerName.make(server)
            if (editor.removed.has(name)) return
            editor.servers.set(name, cloneConfig(serverConfig))
          },
          // 就地更新（不存在则忽略）
          update: (server, update) => {
            const current = editor.servers.get(ServerName.make(server))
            if (!current) return
            update(current)
          },
          // 删除
          remove: (server) => editor.servers.delete(ServerName.make(server)),
        }),
        // 变更通知：串行执行协调
        notify: () => State.reconcile(root, fork, () => reconcileLock.withPermit(reconcile())),
      })

      // 组装并返回服务实现
      return Service.of({
        // 状态变换（编辑器）
        transform: state.transform,
        // 重载状态
        reload: state.reload,
        // servers：列出服务器信息（按名称排序）
        servers: Effect.fn("MCP.servers")(function* () {
          return Array.from(entries)
            .toSorted(([a], [b]) => a.localeCompare(b))
            .map(
              ([name, entry]): ServerInfo => ({
                // 名称
                name,
                // 状态
                status: entry.status,
                // 显示标题
                title: entry.connection.client?.title,
                // 集成 ID
                integrationID: entry.integrationID,
              }),
            )
        }),
        // add：记录覆盖并重载状态
        add: Effect.fn("MCP.add")(function* (server, config) {
          // 归一化名称
          const name = ServerName.make(server)
          // 记录覆盖
          overrides.set(name, config)
          // 触发重载
          yield* state.reload()
        }),
        // connect：停止再启动（服务器锁内）
        connect: Effect.fn("MCP.connect")(function* (server) {
          const name = ServerName.make(server)
          yield* transition(
            Effect.gen(function* () {
              // 取条目
              const entry = yield* requireServer(name)
              // 先停止
              yield* entry.connection.stop
              // 再启动
              yield* entry.connection.start
            }).pipe(locks.withLock(name)),
          )
        }),
        // disconnect：停止并置为禁用
        disconnect: Effect.fn("MCP.disconnect")(function* (server) {
          const name = ServerName.make(server)
          yield* transition(
            Effect.gen(function* () {
              // 取条目
              const entry = yield* requireServer(name)
              // 停止连接
              yield* entry.connection.stop
              // 置为禁用
              entry.status = { status: "disabled" }
              // 广播状态
              yield* bus.publish(McpEvent.StatusChanged, { server: name })
            }).pipe(locks.withLock(name)),
          )
        }),
        // remove：记录移除并重载状态
        remove: Effect.fn("MCP.remove")(function* (server) {
          const name = ServerName.make(server)
          // 确认存在
          yield* requireServer(name)
          // 记录移除覆盖
          overrides.set(name, false)
          // 触发重载
          yield* state.reload()
        }),
        // attach：接入附着连接
        attach: Effect.fn("MCP.attach")(function* (client, transport) {
          yield* attach(ServerName.make(client), transport)
        }),
        // Reads report what is connected now; servers still starting contribute once they publish a change.
        // tools：列出全部可用工具
        tools: Effect.fn("MCP.tools")(function* () {
          // 先收集全部附着连接（各栈顶）的工具
          const clients = Array.from(attached.values()).flatMap((stack) => stack.at(-1)?.tools ?? [])
          // Match callTool: an attached client's tool shadows a configured server's tool of the same name.
          // 附着客户端的同名工具遮蔽配置服务器的工具
          const shadowed = new Set(clients.map((tool) => `${tool.server}\0${tool.name}`))
          return [
            ...Array.from(entries)
              .flatMap(([name, entry]) => serverTools(name, entry))
              // 过滤被遮蔽的
              .filter((tool) => !shadowed.has(`${tool.server}\0${tool.name}`)),
            // 附着客户端的工具排后
            ...clients,
          ].toSorted((a, b) => a.server.localeCompare(b.server) || a.name.localeCompare(b.name))
        }),
        // awaitStartup：等待仍在连接中的服务器
        awaitStartup: Effect.fn("MCP.awaitStartup")(function* () {
          // 当前时间
          const now = yield* Clock.currentTimeMillis
          // 并行等待各服务器的剩余窗口
          yield* Effect.all(
            Array.from(entries.values()).flatMap((entry) => {
              // 非 pending 或无进行中尝试：不等
              if (entry.status.status !== "pending" || !entry.attempt) return []
              const remaining = entry.attempt.started + STARTUP_GRACE_MS - now
              return remaining > 0 ? [entry.attempt.settled.await.pipe(Effect.raceFirst(Effect.sleep(remaining)))] : []
            }),
            { concurrency: "unbounded", discard: true },
          )
        }),
        // callTool：调用一个工具（附着客户端优先）
        callTool: Effect.fn("MCP.callTool")(function* (input) {
          // 归一化服务器名
          const server = ServerName.make(input.server)
          // call：在给定连接上调用工具
          const call = (connection: McpClient.Connection) =>
            connection.callTool({ name: input.name, args: input.args, sessionID: input.sessionID })
          // failed：把错误包装为 ToolCallError
          const failed = (owner: string) =>
            Effect.mapError(
              (error: Error) =>
                new ToolCallError({
                  server,
                  tool: input.name,
                  message: `MCP tool "${input.name}" on ${owner} "${server}" failed: ${error.message}`,
                }),
            )
          // An attached client owns the tools it lists, even when a configured server shares its name, and
          // owns its name outright when no configured server has it.
          // 取该名的附着栈顶
          const client = attached.get(server)?.at(-1)
          // 附着客户端列出了该工具，或没有同名配置服务器：走附着客户端
          if (client && (client.tools.some((tool) => tool.name === input.name) || !entries.has(server)))
            return yield* call(client.client).pipe(failed("client"))
          // 等待配置服务器就绪
          const target = yield* connected(server)
          // 未连接：按状态给出错误
          if (!target.client)
            return yield* new ToolCallError({
              server,
              tool: input.name,
              message: unavailable(server, target.entry.status),
            })
          // 走配置服务器（带会话过期恢复）
          return yield* target.entry.connection.recovering(target.client, call).pipe(failed("server"))
        }),
        // instructions：列出服务器指令
        instructions: Effect.fn("MCP.instructions")(function* () {
          return Array.from(entries)
            .flatMap(([server, entry]) => {
              // 取连接的说明文本
              const instructions = entry.connection.client?.instructions
              // 没有则跳过
              if (!instructions) return []
              // 组装条目
              return [{ server, instructions }]
            })
            // 按服务器名排序
            .toSorted((a, b) => a.server.localeCompare(b.server))
        }),
        // prompts：列出全部提示词
        prompts: Effect.fn("MCP.prompts")(function* () {
          return Array.from(entries)
            .flatMap(([server, entry]) =>
              // 打标连接的提示词列表
              (entry.connection.prompts ?? []).map((prompt): Prompt => ({ ...prompt, server })),
            )
            // 按服务器名与提示词名排序
            .toSorted((a, b) => a.server.localeCompare(b.server) || a.name.localeCompare(b.name))
        }),
        // prompt：获取一个提示词（未连接返回 undefined）
        prompt: Effect.fn("MCP.prompt")(function* (input) {
          // 等待服务器就绪
          const target = yield* connected(ServerName.make(input.server))
          // 未连接返回 undefined
          if (!target.client) return undefined
          // 执行请求（带会话过期恢复；失败按 undefined）
          return yield* target.entry.connection
            .recovering(target.client, (connection) => connection.prompt({ name: input.name, args: input.args }))
            .pipe(Effect.orElseSucceed(() => undefined))
        }),
        // resourceCatalog：合并全部服务器的资源目录
        resourceCatalog: Effect.fn("MCP.resourceCatalog")(function* () {
          // 空目录
          const empty = ResourceCatalog.make({ resources: [], templates: [] })
          // 并行拉取各服务器的目录
          const catalogs = yield* Effect.forEach(
            Array.from(entries),
            ([name, entry]) =>
              entry.connection.client
                ? entry.connection.catalog(entry.connection.client).pipe(
                    // 转换为 schema 目录
                    Effect.map((catalog) => toCatalog(name, catalog)),
                    // 失败按空目录
                    Effect.orElseSucceed(() => empty),
                  )
                : Effect.succeed(empty),
            { concurrency: "unbounded" },
          )
          // 合并返回
          return mergeCatalogs(catalogs)
        }),
        // resources：单个服务器的资源目录
        resources: Effect.fn("MCP.resources")(function* (input) {
          // 归一化名称
          const name = ServerName.make(input.server)
          // 等待就绪
          const target = yield* connected(name)
          // 未连接返回空目录
          if (!target.client) return ResourceCatalog.make({ resources: [], templates: [] })
          // 拉取并合并（单元素）
          return mergeCatalogs([toCatalog(name, yield* target.entry.connection.catalog(target.client))])
        }),
        // readResource：读取一个资源
        readResource: Effect.fn("MCP.readResource")(function* (input) {
          // 归一化名称
          const name = ServerName.make(input.server)
          // 等待就绪
          const target = yield* connected(name)
          // 未连接返回 undefined
          if (!target.client) return undefined
          // 执行读取（带会话过期恢复）
          const result = yield* target.entry.connection.recovering(target.client, (connection) =>
            connection.readResource({ uri: input.uri }),
          )
          // 没有结果（未宣告资源）返回 undefined
          if (!result) return undefined
          // 转换为内部资源内容
          return ResourceContent.make({
            // 服务器名
            server: name,
            // URI
            uri: input.uri,
            // 逐段映射内容
            contents: result.contents.map((part) =>
              "text" in part
                ? { type: "text", uri: part.uri, text: part.text, mimeType: part.mimeType }
                : { type: "blob", uri: part.uri, blob: part.blob, mimeType: part.mimeType },
            ),
          })
        }),
        events: Effect.fn("MCP.events")(function* (server) {
          return (yield* connected(ServerName.make(server))).client?.events
        }),
        subscribe: Effect.fn("MCP.subscribe")(function* (server, input) {
          const name = ServerName.make(server)
          if (!mcpEvents)
            return yield* new EventsUnavailableError({ server: name, message: "MCP events need the mcp_events flag." })
          yield* requireServer(name)
          const id = "mcpsub_" + Hash.sha256(canonicalJson([name, input.name, input.arguments ?? {}])).slice(0, 24)
          const subs = followed.get(name) ?? new Map<string, Followed>()
          followed.set(name, subs)
          const existing = subs.get(id)
          if (existing && existing.status.status !== "ended") return view(existing)
          const sub: Followed = {
            id,
            server: name,
            name: input.name,
            arguments: input.arguments,
            status: { status: "pending" },
            cursor: input.cursor ?? existing?.cursor ?? null,
            gap: false,
          }
          subs.set(id, sub)
          yield* bus.publish(McpEvent.ExperimentalSubscriptionChanged, { id })
          yield* follows(name)
          return view(sub)
        }),
        unsubscribe: Effect.fn("MCP.unsubscribe")(function* (id) {
          const subs = Array.from(followed.values()).find((subs) => subs.has(id))
          if (!subs) return
          subs.delete(id)
          yield* FiberMap.remove(streams, id)
          yield* bus.publish(McpEvent.ExperimentalSubscriptionChanged, { id })
        }),
        subscriptions: Effect.fn("MCP.subscriptions")(function* () {
          return Array.from(followed.values()).flatMap((subs) => Array.from(subs.values(), view))
        }),
      })
    }),
  )

// mergeCatalogs：合并多个资源目录并按服务器/名称/URI 排序
function mergeCatalogs(catalogs: ReadonlyArray<ResourceCatalog>) {
  return ResourceCatalog.make({
    // 合并资源列表
    resources: catalogs
      .flatMap((catalog) => catalog.resources)
      .toSorted(
        (a, b) => a.server.localeCompare(b.server) || a.name.localeCompare(b.name) || a.uri.localeCompare(b.uri),
      ),
    // 合并模板列表
    templates: catalogs
      .flatMap((catalog) => catalog.templates)
      .toSorted(
        (a, b) =>
          a.server.localeCompare(b.server) ||
          a.name.localeCompare(b.name) ||
          a.uriTemplate.localeCompare(b.uriTemplate),
      ),
  })
}

// configured：构建带依赖信息的 MCP 节点
export function configured(options?: Options) {
  return makeLocationNode({
    service: Service,
    layer: layer(options),
    deps: [
      Location.node,
      Environment.node,
      Flag.node,
      Bus.node,
      Form.node,
      Integration.node,
      Credential.node,
      httpFetch,
      McpPool.node,
    ],
  })
}

// node：默认选项的 MCP 节点
export const node = configured()

// Schema `optional` strips undefined-valued properties on encode, so fields can assign
// optional properties directly instead of conditionally spreading them.
// toElicitationField：把 JSON Schema 属性映射为表单字段
function toElicitationField(key: string, property: ElicitationProperty, required: boolean): Form.Field {
  // Some servers emit machine titles like "string with format email"; prefer description/key over those.
  // 机器生成标题的识别模式（如 "string with format email"）
  const machineTitle = /^(boolean|string|number|integer|array|object)(\s+with\b.*|\s+in\b.*)?$/i
  // 标题：优先非机器标题的 title，其次描述，最后键名
  const title =
    property.title && !machineTitle.test(property.title.trim()) ? property.title : (property.description ?? key)
  // 公共字段
  const base = {
    // 键
    key,
    // 标题
    title,
    // 描述（与标题相同则省略）
    description: property.description === title ? undefined : property.description,
    // 是否必填（false 用 undefined 省略）
    required: required || undefined,
  }
  // 按类型分发
  switch (property.type) {
    // 布尔字段
    case "boolean":
      return { ...base, type: "boolean", default: property.default }
    // 数字字段
    case "number":
    case "integer":
      return {
        ...base,
        // 类型
        type: property.type,
        // 下界
        minimum: property.minimum,
        // 上界
        maximum: property.maximum,
        // 默认值
        default: property.default,
      }
    // 数组 → 多选字段
    case "array":
      return {
        ...base,
        // 类型
        type: "multiselect",
        // 选项：anyOf（const/title）或 enum
        options:
          "anyOf" in property.items
            ? property.items.anyOf.map((option) => ({ value: option.const, label: option.title }))
            : property.items.enum.map((value) => ({ value, label: value })),
        // 不允许自定义选项
        custom: false,
        // 最少项数
        minItems: property.minItems,
        // 最多项数
        maxItems: property.maxItems,
        // 默认值
        default: property.default,
      }
    // 字符串字段
    case "string": {
      // 选项：oneOf（const/title）或 enum（可配 enumNames 标签）
      const options =
        "oneOf" in property
          ? property.oneOf.map((option) => ({ value: option.const, label: option.title }))
          : "enum" in property
            ? property.enum.map((value, index) => ({
                value,
                label: ("enumNames" in property ? property.enumNames?.[index] : undefined) ?? value,
              }))
            : undefined
      return {
        ...base,
        // 类型
        type: "string",
        // 格式
        format: "format" in property ? property.format : undefined,
        // 最小长度
        minLength: "minLength" in property ? property.minLength : undefined,
        // 最大长度
        maxLength: "maxLength" in property ? property.maxLength : undefined,
        // 默认值
        default: property.default,
        // 选项
        options,
        // 有选项时不允许自定义
        custom: options ? false : undefined,
      }
    }
  }
}

// 交互属性的源类型（JSON Schema 的单个属性）
type ElicitationProperty = McpClient.ElicitationFormParams["requestedSchema"]["properties"][string]
