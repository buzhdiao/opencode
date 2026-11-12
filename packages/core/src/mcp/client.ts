// 将本模块以命名空间 McpClient 整体再导出（barrel 模式）
export * as McpClient from "./client.js"

// 引入 node 的 pathToFileURL：把目录转成 file:// URL（roots/list 回答用）
import { pathToFileURL } from "node:url"
// 引入 MCP SDK：客户端、协议错误、SDK 错误与错误码、HTTP 错误、Streamable HTTP 传输、
// 未授权错误、不支持的协议版本错误，以及若干类型
import {
  type AuthProvider,
  Client,
  InsufficientScopeError,
  OAuthError,
  OAuthErrorCode,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  UnsupportedProtocolVersionError,
  type CallToolRequestOptions,
  type CallToolResult as SdkCallToolResult,
  type ElicitRequestFormParams,
  type ElicitRequestParams,
  type ElicitRequestURLParams,
  type ElicitResult,
  type GetPromptResult,
  type Implementation,
  type Prompt,
  type ReadResourceResult,
  type Resource,
  type ResourceTemplateType,
  type Transport,
  type VersionNegotiationOptions,
} from "@modelcontextprotocol/client"
import { Cause, Clock, Duration, Effect, Exit, PlatformError, Queue, Schedule, Schema, Stream } from "effect"
import { ConfigMCP } from "@opencode/schema/config/mcp"
// 仅引入类型：会话 ID
import type { Session } from "@opencode/schema/session"
// 引入判断普通对象（record）的辅助
import { isRecord } from "@opencode/util/record"
// 引入 stdio 传输
import { McpStdio } from "./stdio.js"
import { EventStreamRejectedError, EventStreamTerminatedError } from "./event-errors.js"

export { EventStreamRejectedError, EventStreamTerminatedError }

// 默认启动（握手）超时：30 秒
const DEFAULT_STARTUP_TIMEOUT = 30_000
// 默认目录列举超时：30 秒
const DEFAULT_CATALOG_TIMEOUT = 30_000
// 默认单次执行超时：12 小时
const DEFAULT_EXECUTION_TIMEOUT = 12 * 60 * 60 * 1_000 // 12 hours
// 附着（attached）连接的执行超时：10 分钟
const ATTACHED_EXECUTION_TIMEOUT = 10 * 60 * 1_000 // 10 minutes
// 会话终止（terminate）超时：1 秒
const TERMINATE_TIMEOUT = 1_000
// SEP-2243 HeaderMismatch; the SDK does not export the constant.
// 头不匹配（HeaderMismatch）的协议错误码；SDK 未导出该常量
const HEADER_MISMATCH = -32020
// 统一把未知错误转成 Error 实例
const toError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)))

// HTTP statuses and network error codes live on error properties and are lost once flattened to a message.
// 补充错误描述：HTTP 状态码与网络错误码存于错误属性上，拍平成消息后会丢失
const describe = (error: unknown) => {
  // 非 Error 直接转字符串
  if (!(error instanceof Error)) return String(error)
  // 提取细节：HTTP 错误带状态码；非普通 SDK 错误但带字符串 code 的取 code
  const detail =
    error instanceof SdkHttpError
      ? `HTTP ${error.status}`
      : !(error instanceof SdkError) && "code" in error && typeof error.code === "string"
        ? error.code
        : undefined
  // 细节存在且消息里尚未包含时追加到括号里，避免重复
  return detail && !error.message.includes(detail) ? `${error.message} (${detail})` : error.message
}

// Overloaded or restarting servers and dropped connections usually recover within a second.
// Fetch reports network failures as a TypeError carrying a system error code.
// 501 means the server will never support the request.
// 瞬时（transient）错误判定：过载/重启中的服务器与掉线通常一秒内恢复
const isTransient = (error: unknown) =>
  // HTTP 408（超时）、429（过载）、5xx（除 501 永不支持外）视为瞬时
  error instanceof SdkHttpError
    ? error.status === 408 || error.status === 429 || (error.status >= 500 && error.status !== 501)
    // fetch 把网络失败报告为携带系统错误码的 TypeError
    : error instanceof TypeError && "code" in error

// MCP Events (SEP-3415), a draft extension. Every `notifications/events/*` names its stream by the JSON-RPC id of
// the `events/stream` request that opened it.
const EVENTS = "io.modelcontextprotocol/events"
const SUBSCRIPTION_ID = "io.modelcontextprotocol/subscriptionId"
// Servers send a heartbeat at least every 30 seconds; twice that in silence means the stream is dead.
const EVENT_STREAM_IDLE = Duration.seconds(60)
const EVENT_LIST_PAGES = 100

/** Experimental: MCP Events is a draft extension; may change without compatibility guarantees. */
const EventType = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  /** Any of "poll", "push" and "webhook". */
  delivery: Schema.optional(Schema.Array(Schema.String)),
  inputSchema: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  payloadSchema: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})
export type EventType = typeof EventType.Type
const EventError = Schema.Struct({ code: Schema.Number, message: Schema.String, data: Schema.optional(Schema.Json) })
export type EventError = typeof EventError.Type
// An absent cursor means null: the event type has no replay.
const Cursor = Schema.optional(Schema.NullOr(Schema.String))
const Subscribed = { _meta: Schema.Struct({ [SUBSCRIPTION_ID]: Schema.Union([Schema.String, Schema.Number]) }) }
const EventList = Schema.toStandardSchemaV1(
  Schema.Struct({ events: Schema.Array(EventType), nextCursor: Schema.optional(Schema.String) }),
)
const StreamResult = Schema.toStandardSchemaV1(Schema.Unknown)
const ActiveNotification = Schema.toStandardSchemaV1(
  Schema.Struct({ cursor: Cursor, truncated: Schema.optional(Schema.Boolean), ...Subscribed }),
)
const EventNotification = Schema.toStandardSchemaV1(
  Schema.Struct({
    eventId: Schema.String,
    name: Schema.String,
    timestamp: Schema.String,
    data: Schema.Json,
    cursor: Cursor,
    ...Subscribed,
  }),
)
const HeartbeatNotification = Schema.toStandardSchemaV1(Schema.Struct({ cursor: Cursor, ...Subscribed }))
const ErrorNotification = Schema.toStandardSchemaV1(Schema.Struct({ error: EventError, ...Subscribed }))

/**
 * One message on an event stream. Persist the latest non-null `cursor` to resume from it.
 * Experimental: MCP Events is a draft extension; may change without compatibility guarantees.
 */
export type EventMessage =
  /** The stream is live. Sent first, and again with `truncated` when the server skipped events it could not replay. */
  | { readonly type: "active"; readonly cursor: string | null; readonly truncated: boolean }
  | {
      readonly type: "event"
      readonly eventId: string
      readonly name: string
      readonly timestamp: string
      readonly data: Schema.Json
      readonly cursor: string | null
    }
  /** Nothing matched; the server has checked up to `cursor`. */
  | { readonly type: "heartbeat"; readonly cursor: string | null }
  /** A recoverable failure, such as one failed upstream fetch; the stream stays open. */
  | { readonly type: "error"; readonly error: EventError }

// JSON-RPC errors that mean an `events/stream` request can never succeed as sent: unknown method, bad arguments, and
// the events extension's NotFound, Forbidden and Unsupported.
const EVENT_STREAM_REJECTED = new Set([-32601, -32602, -32023, -32024, -32026])

export type { GetPromptResult, Prompt, ReadResourceResult, Resource }
// 资源模板类型别名
export type ResourceTemplate = ResourceTemplateType

/** A listed tool, keeping the server's fields except `icons`, each only when it has the right type. */
// 已列出的工具：保留服务器字段（除 icons 外），且各字段仅在类型正确时保留
export interface Tool {
  // 工具名
  readonly name: string
  // 可选显示标题
  readonly title?: string
  // 可选描述
  readonly description?: string
  // 输入 schema：必须为 object 类型，其余键原样保留
  readonly inputSchema: {
    readonly type: "object"
    readonly properties?: Record<string, unknown>
    readonly required?: string[]
    readonly [key: string]: unknown
  }
  // 可选输出 schema
  readonly outputSchema?: Record<string, unknown>
  // 可选注解（annotations）
  readonly annotations?: Record<string, unknown>
  // 可选执行（execution）声明
  readonly execution?: Record<string, unknown>
  // 可选元数据 _meta
  readonly _meta?: Record<string, unknown>
}

// 需要认证错误（带 server 与 message）
export class NeedsAuthError extends Schema.TaggedError<NeedsAuthError>()("MCP.NeedsAuthError", {
  // 服务器名
  server: Schema.String,
  // 错误消息
  message: Schema.String,
}) {}

// 连接错误（带 server、message，可选 answered）
export class ConnectError extends Schema.TaggedError<ConnectError>()("MCP.ConnectError", {
  // 服务器名
  server: Schema.String,
  // 错误消息
  message: Schema.String,
  /** The server was reached but refused or broke the handshake, so different connect options might succeed. */
  // answered：服务器可达但拒绝/中断握手（换连接选项也许能成）
  answered: Schema.optional(Schema.Boolean),
}) {}

/** A legacy Streamable HTTP server no longer recognizes this connection's session; the lifecycle reconnects. */
// 会话过期错误：旧版 Streamable HTTP 服务器不再认识本连接的会话；由生命周期层重连
export class SessionExpiredError extends Schema.TaggedError<SessionExpiredError>()("MCP.SessionExpiredError", {
  // 服务器名
  server: Schema.String,
}) {
  // 错误消息
  override get message() {
    return `MCP server session expired: ${this.server}`
  }
}

// 工具调用返回的内容片段：文本或媒体（媒体可带 URI）
export type CallToolContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "media"; readonly data: string; readonly mimeType: string; readonly uri?: string }

// 工具调用结果：是否错误、可选结构化输出、内容片段列表
export interface CallToolResult {
  // 服务器标记的 isError
  readonly isError: boolean
  // 可选结构化内容
  readonly structured?: unknown
  // 内容片段列表
  readonly content: ReadonlyArray<CallToolContent>
}

// 交互（elicitation）相关类型别名
export type ElicitationFormParams = ElicitRequestFormParams
// 交互请求参数类型
export type ElicitationParams = ElicitRequestParams
// 交互结果类型
export type ElicitationResult = ElicitResult

// 交互处理器：创建（应答表单/URL 交互）与完成（旧版 URL 模式的带外通知）
export interface ElicitationHandler {
  // 创建：应答一次交互请求（可由调用方自带）
  readonly create: (input: {
    // 服务器名
    readonly server: string
    // 交互参数
    readonly params: ElicitationParams
    // 中止信号
    readonly signal: AbortSignal
  }) => Effect.Effect<ElicitationResult, Error>
  /**
   * Legacy era only: the server announces that a URL-mode elicitation finished out of band. Removed in
   * 2026-07-28, where the client learns the outcome by retrying, but legacy servers still send it and
   * it lets the form settle without the user re-running the tool.
   */
  // complete：仅旧版协议；服务器通知某次 URL 交互已在带外完成
  readonly complete: (input: {
    // 服务器名
    readonly server: string
    // 交互 ID
    readonly elicitationID: ElicitRequestURLParams["elicitationId"]
  }) => Effect.Effect<void>
}

/** For a request that can come back asking for input: tool calls, prompts and resource reads. */
// 按请求附加项：可能回头要求输入的请求（工具调用、提示词、资源读取）
export interface PerRequest {
  /**
   * Answers the elicitations this request causes instead of the connection's handler, for a connection
   * that serves several callers. 2026-07-28 only.
   */
  // elicitation：改由本请求应答其引发的交互（多调用方共享连接时用）；仅 2026-07-28
  readonly elicitation?: ElicitationHandler["create"]
}

/** Handle over a connected MCP server that keeps the SDK `Client` out of the rest of core. */
// 连接句柄：把 SDK 的 Client 封装在核心之外暴露的能力
export interface Connection {
  /** True when the connection negotiated revision 2026-07-28 or later; false is the initialize handshake. */
  // modern：协商到 2026-07-28 及以后为 true；false 表示普通 initialize 握手
  readonly modern: boolean
  /** The protocol revision the connection negotiated, such as "2025-11-25". */
  // 协商出的协议版本（如 "2025-11-25"）
  readonly protocolVersion: string | undefined
  /** Display title from `serverInfo.title`, when the server provides one. */
  // 显示标题（取自 serverInfo.title，服务器提供时才有）
  readonly title: string | undefined
  // 服务器说明文本
  readonly instructions: string | undefined
  // 列出工具
  readonly tools: () => Effect.Effect<Tool[], Error>
  // 列出提示词
  readonly prompts: () => Effect.Effect<Prompt[], Error>
  // 列出资源
  readonly resources: () => Effect.Effect<Resource[], Error>
  // 列出资源模板
  readonly resourceTemplates: () => Effect.Effect<ResourceTemplateType[], Error>
  /** Resolves to undefined when the server does not advertise resources. */
  // 读取资源：服务器未宣告资源能力时得到 undefined
  readonly readResource: (
    input: { readonly uri: string } & PerRequest,
  ) => Effect.Effect<ReadResourceResult | undefined, Error>
  // 获取提示词
  readonly prompt: (
    input: {
      readonly name: string
      readonly args?: Record<string, string>
    } & PerRequest,
  ) => Effect.Effect<GetPromptResult, Error>
  // 调用工具
  readonly callTool: (
    input: {
      readonly name: string
      readonly args?: Record<string, unknown>
      readonly sessionID?: Session.ID
    } & PerRequest,
  ) => Effect.Effect<CallToolResult, Error>
  /** MCP Events, when the connection declared them and the server offers them. Experimental; see `Events`. */
  readonly events: Events | undefined
  readonly onClose: (callback: (reason: string) => void) => void
  // 注册会话过期回调
  readonly onSessionExpired: (callback: () => void) => void
  // 注册工具列表变化回调
  readonly onToolsChanged: (callback: () => void) => void
  // 注册提示词列表变化回调
  readonly onPromptsChanged: (callback: () => void) => void
  // 注册资源变化回调
  readonly onResourcesChanged: (callback: () => void) => void
}

/** Experimental: MCP Events is a draft extension; may change without compatibility guarantees. */
export interface Events {
  /** Every event type the server offers (`events/list`). */
  readonly list: () => Effect.Effect<ReadonlyArray<EventType>, Error>
  /**
   * Push delivery (`events/stream`) from `cursor`, or from now. Ends when the server closes the stream. Fails with
   * EventStreamRejectedError when the server refuses the subscription, EventStreamTerminatedError when it ends it,
   * and with another error when the stream breaks or falls silent for a minute, after which it can be opened again
   * from the last cursor. Interrupting it cancels it.
   */
  readonly stream: (input: {
    readonly name: string
    readonly arguments?: Record<string, unknown>
    readonly cursor?: string | null
    /** Replays nothing older than this, even from an older cursor. */
    readonly maxAgeMs?: number
  }) => Stream.Stream<EventMessage, Error>
}

/** An MCP server reached over a transport someone else already opened, such as a client socket. */
// 附着（attached）配置：经由别人已打开的传输（如客户端套接字）触达的 MCP 服务器
export interface Attached {
  // 配置类型标记
  readonly type: "attached"
  // 既有的传输实例
  readonly transport: Transport
}

// connect 的选项
export interface ConnectOptions {
  // 服务器名
  readonly server: string
  // 服务器配置（普通配置或附着传输）
  readonly config: typeof ConfigMCP.Server.Type | Attached
  /** Resolves a relative stdio `cwd` and is the default one, and is the root `roots/list` answers with. */
  // 目录：解析相对 stdio cwd 的基准与默认值，也是 roots/list 回答的根
  readonly directory: string
  /** Remote only. A 401 the provider cannot recover from ends in UnauthorizedError → needs_auth. */
  readonly authProvider?: AuthProvider
  readonly elicitation?: ElicitationHandler
  // 客户端标识
  readonly clientInfo?: Implementation
  /** False declares no roots and leaves `roots/list` unanswered, for a connection no one directory owns. */
  // roots=false：声明无根且不回应 roots/list（给无所属目录的连接用）
  readonly roots?: boolean
  /** Experimental: declares MCP Events, a draft extension, and exposes `Connection.events` for a server that offers them. */
  readonly events?: boolean
}

/**
 * Connects an MCP server; closing the calling scope tears down the transport and any spawned process.
 * A stdio server is spawned through the location's `Environment`, so it runs wherever the location's
 * shell commands run rather than always on the host.
 */
// connect：连接一台 MCP 服务器；关闭调用方作用域会拆除传输与生成的进程
export const connect = Effect.fnUntraced(function* (options: ConnectOptions) {
  // 服务器名（局部简写）
  const server = options.server
  // 配置（局部简写）
  const config = options.config
  // 交互处理器（局部简写）
  const elicitation = options.elicitation
  // The SDK takes list-changed handlers at construction, but consumers register after connect. On a
  // modern connection the SDK opens the subscriptions/listen stream behind these itself.
  // 计算生效的超时配置：附着连接用固定的 10 分钟执行超时，普通连接用配置
  const timeout: (typeof ConfigMCP.Server.Type)["timeout"] =
    config.type === "attached" ? { execution: ATTACHED_EXECUTION_TIMEOUT } : config.timeout
  // Attached clients run ordinary SDK servers over the initialize handshake.
  // 协议模式：附着连接按旧（legacy）握手跑普通 SDK 服务器
  const protocol = config.type === "attached" ? "legacy" : config.protocol
  // 列表变化回调表：先放空实现，消费者连接后再注册
  const changed = { tools: () => {}, prompts: () => {}, resources: () => {} }
  // 构造 SDK 的 listChanged 配置：不自动刷新、零防抖、变化时转发到回调表
  const listChanged = (key: keyof typeof changed) => ({
    autoRefresh: false,
    debounceMs: 0,
    onChanged: () => changed[key](),
  })

  // Requests that bring their own elicitation handler, keyed by the signal each passes to the SDK.
  // 自带交互处理器的请求：以各自传给 SDK 的中止信号为键
  const callers = new WeakMap<AbortSignal, ElicitationHandler["create"]>()
  // claim：登记请求自带的交互处理器并返回信号
  const claim = (signal: AbortSignal, input: PerRequest) => {
    // 有自带处理器时登记到 WeakMap
    if (input.elicitation) callers.set(signal, input.elicitation)
    // 原样返回信号
    return signal
  }

  // Open event streams, by the JSON-RPC id of their `events/stream` request.
  const streams = new Map<string, Queue.Queue<EventMessage, Error | Cause.Done>>()

  // The SDK fails pending requests with a bare "Connection closed"; the transport error before it says why.
  // 记录最近一次传输错误：SDK 只报裸的 "Connection closed"，靠它补充原因
  let lastError: string | undefined
  // explain：把错误转成带原因的描述
  const explain = (error: unknown) =>
    // 连接关闭且此前有传输错误时，把原因附加在后面
    error instanceof SdkError && error.code === SdkErrorCode.ConnectionClosed && lastError
      ? `${describe(error)}: ${lastError}`
      // 其他情况用普通描述
      : describe(error)

  // Two more attempts, 250 ms and 1 s later, while the failure is transient and the deadline has not passed.
  // retrying：对瞬时错误再试两次（250ms、1s 后），且不超过截止时间
  const retrying = <A, E>(what: string, effect: Effect.Effect<A, E>, deadline = Infinity) =>
    Effect.retry(
      effect,
      // 调度：指数退避 250ms（x4）且最多 2 次重试
      Schedule.max([Schedule.exponential("250 millis", 4), Schedule.recurs(2)]).pipe(
        // 把调度输入类型收敛为错误
        Schedule.setInputType<E>(),
        // 决定是否继续重试：非瞬时错误或已过截止时间则停
        Schedule.while(({ input, now, duration }) =>
          !isTransient(input) || now + Duration.toMillis(duration) >= deadline
            ? Effect.succeed(false)
            // 重试前记一条警告日志
            : Effect.logWarning(`retrying ${what}`, { server, error: describe(input) }).pipe(Effect.as(true)),
        ),
      ),
    )

  // initialize：在给定传输上完成 SDK 客户端构建与握手
  const initialize = Effect.fnUntraced(function* (transport: Transport) {
    // SDK callbacks run outside any fiber. They must run with this context so events they publish keep
    // the server's Location; clients drop unlocated `form.created` events and elicitations then hang.
    // 捕获当前 Effect 上下文：SDK 回调运行在任意纤程之外，必须带此上下文
    const context = yield* Effect.context()
    // 用该上下文 fork 纤程的运行器
    const runFork = Effect.runForkWith(context)
    // 用该上下文运行 Promise 的运行器
    const runPromise = Effect.runPromiseWith(context)
    // 构建 SDK 客户端
    const client = new Client(options.clientInfo ?? { name: "opencode", version: "unknown" }, {
      // 声明的能力
      capabilities: {
        // 有交互处理器时声明 elicitation 能力（form 与 url）
        ...(elicitation ? { elicitation: { form: {}, url: {} } } : {}),
        // Legacy era only: roots are deprecated as of 2026-07-28 and modern servers cannot request them.
        // Some legacy servers refuse to run without one (https://github.com/anomalyco/opencode/issues/2308).
        // roots 能力：仅旧版协议需要（部分旧服务器没有 roots 就拒绝运行）
        ...(options.roots === false ? {} : { roots: {} }),
        ...(options.events ? { extensions: { [EVENTS]: {} } } : {}),
      },
      // 版本协商策略
      versionNegotiation: negotiation(protocol),
      // 三类目录的变化回调配置
      listChanged: {
        tools: listChanged("tools"),
        prompts: listChanged("prompts"),
        resources: listChanged("resources"),
      },
    })
    // Background work such as the standalone SSE stream reports failures only here; aborts come from close.
    // onerror：后台工作（如独立 SSE 流）只在这里报错；主动关闭产生的中止直接忽略
    client.onerror = (error) => {
      // 中止错误（来自 close）不处理
      if (error.name === "AbortError") return
      // 记录最近一次错误描述
      lastError = describe(error)
      // 记一条警告日志
      runFork(Effect.logWarning("mcp transport error", { server, error: lastError }))
    }
    // 需要声明 roots 时注册 roots/list 处理器：返回目录的 file:// 根
    if (options.roots !== false)
      client.setRequestHandler("roots/list", () => ({ roots: [{ uri: pathToFileURL(options.directory).href }] }))
    if (options.events) {
      const subscribed = (params: { readonly _meta: { readonly [SUBSCRIPTION_ID]: string | number } }) =>
        streams.get(String(params._meta[SUBSCRIPTION_ID]))
      client.setNotificationHandler("notifications/events/active", { params: ActiveNotification }, (params) => {
        const queue = subscribed(params)
        if (queue)
          Queue.offerUnsafe(queue, {
            type: "active",
            cursor: params.cursor ?? null,
            truncated: params.truncated === true,
          })
      })
      client.setNotificationHandler("notifications/events/event", { params: EventNotification }, (params) => {
        const queue = subscribed(params)
        if (queue)
          Queue.offerUnsafe(queue, {
            type: "event",
            eventId: params.eventId,
            name: params.name,
            timestamp: params.timestamp,
            data: params.data,
            cursor: params.cursor ?? null,
          })
      })
      client.setNotificationHandler("notifications/events/heartbeat", { params: HeartbeatNotification }, (params) => {
        const queue = subscribed(params)
        if (queue) Queue.offerUnsafe(queue, { type: "heartbeat", cursor: params.cursor ?? null })
      })
      client.setNotificationHandler("notifications/events/error", { params: ErrorNotification }, (params) => {
        const queue = subscribed(params)
        if (queue) Queue.offerUnsafe(queue, { type: "error", error: params.error })
      })
      client.setNotificationHandler("notifications/events/terminated", { params: ErrorNotification }, (params) => {
        const queue = subscribed(params)
        if (queue) Queue.failCauseUnsafe(queue, Cause.fail(new EventStreamTerminatedError({ server, ...params.error })))
      })
    }
    if (elicitation) {
      // A 2026-07-28 server asks for input in the result of the request that needs it. Our SDK patch puts
      // that request's options on the context (`mcpReq.origin`, see patches/@modelcontextprotocol%2Fclient),
      // so its signal finds the handler it brought. Anything else goes to the connection's handler.
      // 注册 elicitation/create 处理器：优先用发起请求自带的处理器
      client.setRequestHandler("elicitation/create", (request, ctx) => {
        // 从上下文中取出发起请求的选项里的中止信号（依赖我们的 SDK 补丁）
        const origin = (ctx.mcpReq as { readonly origin?: { readonly options?: { readonly signal?: AbortSignal } } })
          .origin?.options?.signal
        // 找到该信号对应的请求自带处理器，否则退回连接级处理器
        const create = (origin && callers.get(origin)) ?? elicitation.create
        // 运行处理器并返回结果
        return runPromise(create({ server, params: request.params, signal: ctx.mcpReq.signal }))
      })
      // 注册交互完成通知（仅旧版 URL 模式）
      client.setNotificationHandler("notifications/elicitation/complete", (notification) =>
        runPromise(elicitation.complete({ server, elicitationID: notification.params.elicitationId })),
      )
    }

    // 执行连接握手（带启动超时与中止信号）
    yield* Effect.tryPromise({
      try: (signal) => client.connect(transport, { timeout: timeout?.startup ?? DEFAULT_STARTUP_TIMEOUT, signal }),
      catch: (error) => error,
    }).pipe(Effect.onError(() => Effect.promise(() => transport.close()).pipe(Effect.ignore)))
    // 返回构建好的客户端
    return client
  })

  // Legacy era only: the transport holds the Mcp-Session-Id the server minted, and the server answering
  // it with 404, or with the 400 a freshly restarted single-session server emits, means it no longer
  // knows this connection. Modern connections never carry a session id, so a modern 404 for an unknown
  // method is not mistaken for expiry. Other 400s pass through untouched.
  // 会话跟踪：旧版协议下 transport 持有服务器签发的会话 ID，用于识别会话过期
  const session: { transport?: StreamableHTTPClientTransport; expired?: () => void; reported: boolean } = {
    // 是否已报告过过期（只报一次）
    reported: false,
  }
  // failure：把底层错误映射为对外错误（必要时映射为会话过期）
  const failure = (error: unknown) => {
    // A tool call that relists first can fail with the list's already mapped expiry.
    // 已是会话过期错误则原样返回（避免重复包装）
    if (error instanceof SessionExpiredError) return error
    // 非 HTTP 错误、或旧版会话不存在时不做过期判定
    if (!(error instanceof SdkHttpError) || session.transport?.sessionId === undefined) return new Error(explain(error))
    // 过期判定：404，或刚重启的单会话服务器特有的 400 文本
    const expired =
      error.status === 404 ||
      (error.status === 400 &&
        typeof error.data.text === "string" &&
        error.data.text.includes("Bad Request: Server not initialized"))
    // 非过期错误按普通错误包装
    if (!expired) return new Error(explain(error))
    // 只报告一次过期并触发回调
    if (!session.reported) {
      session.reported = true
      session.expired?.()
    }
    // 返回会话过期错误
    return new SessionExpiredError({ server })
  }

  // 主流程：按配置类型打开传输并完成握手（收敛为 Exit）
  const exit = yield* Effect.gen(function* () {
    // 附着连接：直接在给定传输上初始化
    if (config.type === "attached") return yield* initialize(config.transport)
    // 本地（stdio）连接：spawn 服务器进程
    if (config.type === "local") {
      // 拆出命令与参数
      const [command, ...args] = config.command
      // 创建 stdio 传输（经由环境服务生成进程）
      const transport = yield* McpStdio.make({
        // 服务器名
        server,
        // 命令
        command,
        // 参数
        args,
        // 解析后的工作目录
        cwd: McpStdio.resolveCwd(options.directory, config.cwd),
        // 环境变量：opencode 自身命令附加 BUN_BE_BUN，再合并配置
        environment: {
          ...(command === "opencode" ? { BUN_BE_BUN: "1" } : {}),
          ...config.environment,
        },
      })
      // 在该传输上初始化
      return yield* initialize(transport)
    }
    // 远程连接：懒加载 OAuth 模块
    const { McpOAuth } = yield* Effect.promise(() => import("./oauth.js"))
    // 构建带日志的 fetch
    const fetch = yield* McpOAuth.loggedFetch({ server, directory: options.directory })
    // Servers that bundle their own Code Mode (Cloudflare and others) expose raw tools when asked
    // with ?codemode=false, which is what our Code Mode wants. The configured URL stays the OAuth identity.
    // 解析服务器 URL
    const url = new URL(config.url)
    // 需要附加 ?codemode=false 的条件：Code Mode 未关闭、URL 未带 codemode、服务器不拒绝未知查询参数
    const addedCodemode = config.codemode !== false && !url.searchParams.has("codemode") && !rejectsUnknownQuery(url)
    // 附加 codemode=false 查询参数
    if (addedCodemode) url.searchParams.set("codemode", "false")
    // open：用给定 URL 打开一条新的 Streamable HTTP 传输并初始化
    const open = Effect.fnUntraced(function* (url: URL) {
      // 创建传输（带配置头、OAuth 提供者与定制 fetch）
      session.transport = new StreamableHTTPClientTransport(url, {
        requestInit: config.headers ? { headers: config.headers } : undefined,
        authProvider: options.authProvider,
        fetch,
      })
      // 在该传输上初始化
      return yield* initialize(session.transport)
    })

    // Every attempt opens a fresh transport; no retry starts once the startup timeout has passed.
    // 计算启动截止时间：当前时间 + 启动超时
    const deadline = (yield* Clock.currentTimeMillis) + (timeout?.startup ?? DEFAULT_STARTUP_TIMEOUT)
    // 连接（带瞬时重试）；若服务器因 codemode 参数返回 400/404，则改用配置 URL 重试一次
    return yield* retrying(
      "MCP connect",
      open(url).pipe(
        Effect.catch((error) => {
          // 非 codemode 附加导致的 400/404 或其他错误原样失败
          if (!addedCodemode || !(error instanceof SdkHttpError) || (error.status !== 400 && error.status !== 404))
            return Effect.fail(error)
          // Servers that reject unknown query params get one retry at the configured URL.
          // 拒绝未知查询参数的服务器：改用配置的 URL 重试一次
          return open(new URL(config.url))
        }),
      ),
      deadline,
    )
  }).pipe(Effect.exit)
  // 成功路径：构建连接对象
  if (Exit.isSuccess(exit)) {
    // 取回客户端
    const client = exit.value
    // 注册清理终结器：关闭传输与会话
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        // Close only aborts streams; the legacy session lives on until the server expires it unless
        // terminated explicitly. Terminate first: close aborts the signal the DELETE shares.
        // 取出旧版协议的传输（若存在）
        const transport = session.transport
        // Termination failures are logged below; onerror would report them a second time.
        // 先摘掉 onerror：终止失败已在下面记日志，避免二次报告
        client.onerror = undefined
        // 旧版会话存在且未报告过期时，显式终止会话（DELETE）
        if (transport?.sessionId !== undefined && !session.reported)
          yield* Effect.tryPromise({ try: () => transport.terminateSession(), catch: toError }).pipe(
            Effect.timeoutOrElse({
              // 终止超时 1 秒
              duration: TERMINATE_TIMEOUT,
              // 超时时给出明确错误
              orElse: () => Effect.fail(new Error(`Timed out after ${TERMINATE_TIMEOUT}ms`)),
            }),
            // 终止失败记警告日志
            Effect.tapError((error) =>
              Effect.logWarning("failed to terminate MCP session", { server, error: error.message }),
            ),
            // 忽略最终错误（尽力而为）
            Effect.ignore,
          )
        // 关闭客户端（忽略错误）
        yield* Effect.tryPromise(() => client.close()).pipe(Effect.ignore)
      }),
    )
    // 目录列举超时配置
    const catalog = { timeout: timeout?.catalog ?? DEFAULT_CATALOG_TIMEOUT }
    // 已列出的工具缓存（按名字索引，供 callTool 传定义）
    const listed = new Map<string, Tool>()
    // 生效的执行超时
    const execution = timeout?.execution ?? DEFAULT_EXECUTION_TIMEOUT
    // request：一次性请求（不重试），失败记警告日志
    const request = <A>(what: string, run: (signal: AbortSignal) => Promise<A>) =>
      Effect.tryPromise({ try: run, catch: failure }).pipe(
        Effect.tapError((error) => Effect.logWarning(`failed to ${what}`, { server, error: error.message })),
      )
    // Listing is read-only, so a transient failure is safe to retry.
    // list：只读的列举请求，瞬时失败可安全重试
    const list = <A>(what: string, run: (signal: AbortSignal) => Promise<A>) =>
      retrying(what, Effect.tryPromise({ try: run, catch: (error) => error })).pipe(
        // 重试完成后统一映射错误
        Effect.mapError(failure),
        // 失败记警告日志
        Effect.tapError((error) => Effect.logWarning(`failed to ${what}`, { server, error: error.message })),
      )
    // The SDK answers a list for an unadvertised capability with a console.debug line plus an empty
    // result, so refreshing a tools-only server prints to stdout on every catalog load. Negotiate
    // first and leave the request unmade; the result is the same empty list without the noise.
    // advertised：服务器是否宣告了某项能力（未宣告就不发请求，避免 SDK 打印噪音）
    const advertised = (capability: "tools" | "prompts" | "resources") =>
      Boolean(client.getServerCapabilities()?.[capability])

    // Annotated rather than `satisfies`: the inferred SDK types are cyclic, so declaration emit needs the named type.
    // 组装连接对象（显式标注 Connection 类型：SDK 推断类型循环，声明产出需要具名类型）
    const connection: Connection = {
      // 是否为现代协议
      modern: client.getProtocolEra() === "modern",
      // 协商出的协议版本
      protocolVersion: client.getNegotiatedProtocolVersion(),
      // 服务器显示标题（去空白，空则 undefined）
      title: client.getServerVersion()?.title?.trim() || undefined,
      // 服务器说明文本（去空白，空则 undefined）
      instructions: client.getInstructions()?.trim() || undefined,
      events:
        options.events && client.getServerCapabilities()?.extensions?.[EVENTS]
          ? {
              list: Effect.fnUntraced(function* () {
                const events: EventType[] = []
                let cursor: string | undefined
                for (let page = 0; page < EVENT_LIST_PAGES; page++) {
                  const result = yield* list("list MCP events", (signal) =>
                    client.request(
                      { method: "events/list", params: cursor === undefined ? {} : { cursor } },
                      EventList,
                      {
                        ...catalog,
                        signal,
                      },
                    ),
                  )
                  events.push(...result.events)
                  cursor = result.nextCursor
                  if (cursor === undefined) return events
                }
                yield* Effect.logWarning("MCP event list has more pages than read", { server, pages: EVENT_LIST_PAGES })
                return events
              }),
              stream: (input) =>
                Stream.callback<EventMessage, Error>((queue) =>
                  Effect.gen(function* () {
                    yield* Effect.addFinalizer(() =>
                      Effect.sync(() => {
                        for (const [id, open] of streams) if (open === queue) streams.delete(id)
                      }),
                    )
                    // Interrupting the request cancels the stream; the server closing it resolves the request.
                    yield* Effect.tryPromise({
                      try: (signal) =>
                        client.request({ method: "events/stream", params: input }, StreamResult, {
                          signal,
                          // Heartbeats, not a request timeout, tell a quiet stream from a dead one; see below.
                          timeout: Infinity,
                          // Routes the stream's notifications, which can arrive before the request settles.
                          onRequestId: (id) => streams.set(String(id), queue),
                        }),
                      catch: (error) =>
                        error instanceof ProtocolError && EVENT_STREAM_REJECTED.has(error.code)
                          ? new EventStreamRejectedError({ server, code: error.code, message: error.message })
                          : failure(error),
                    }).pipe(
                      Effect.tapError((error) =>
                        Effect.logWarning("failed to stream MCP events", { server, error: error.message }),
                      ),
                      Effect.matchEffect({
                        onFailure: (error) => Queue.fail(queue, error),
                        onSuccess: () => Queue.end(queue),
                      }),
                      Effect.forkScoped,
                    )
                  }),
                ).pipe(
                  Stream.timeoutOrElse({
                    duration: EVENT_STREAM_IDLE,
                    orElse: () =>
                      Stream.fail(new Error(`MCP server ${server} sent nothing on the event stream for 60 seconds`)),
                  }),
                ),
            }
          : undefined,
      // Tool lists skip the SDK response cache: it re-stringifies every list, and on the first tools/call
      // re-parses it and compiles an output validator for every listed tool. Each call passes its own
      // checked definition instead, so modern Mcp-Param-* header mirroring still sees the input schema.
      // Tools are relisted on connect, list_changed and a stale header declaration; the SDK cache never
      // relisted an expired list before a call either.
      tools: () =>
        // 仅在服务器宣告 tools 能力时才请求
        advertised("tools")
          ? list("list MCP tools", (signal) =>
              client.listTools(undefined, { ...catalog, cacheMode: "bypass", signal }),
            ).pipe(
              // Our SDK patch leaves the listed tools unchecked, so one malformed tool doesn't fail the
              // whole list; each is checked here and copied, dropping fields of the wrong type.
              // 逐个校验并复制工具（跳过畸形项而不是整体失败）
              Effect.flatMap((result) => {
                // 被跳过的畸形工具及其原因
                const skipped: Array<{ tool: unknown; reason: string }> = []
                // 逐项处理服务器返回的工具
                const tools = result.tools.flatMap((tool: unknown): Tool[] => {
                  // 记录跳过原因并返回空（不产出该工具）
                  const skip = (reason: string) => {
                    skipped.push({ tool: isRecord(tool) ? tool.name : undefined, reason })
                    return []
                  }
                  // 必须是对象
                  if (!isRecord(tool)) return skip("not an object")
                  // 名字必须是非空字符串
                  if (typeof tool.name !== "string" || tool.name === "") return skip("name is not a non-empty string")
                  // inputSchema 必须是对象
                  if (!isRecord(tool.inputSchema)) return skip("inputSchema is not an object")
                  // inputSchema.type 若存在必须是 "object"
                  if (tool.inputSchema.type !== undefined && tool.inputSchema.type !== "object")
                    return skip('inputSchema type is not "object"')
                  // 拆出 properties/required，其余键原样保留
                  const { properties, required, ...inputSchema } = tool.inputSchema
                  return [
                    {
                      // 工具名
                      name: tool.name,
                      // 标题仅保留字符串类型
                      title: typeof tool.title === "string" ? tool.title : undefined,
                      // 描述仅保留字符串类型
                      description: typeof tool.description === "string" ? tool.description : undefined,
                      // Providers that check tool parameters against the JSON Schema metaschema reject the
                      // whole request over a malformed top level. Nested property schemas are left as sent.
                      // inputSchema：顶层保证合法（属性内 schema 原样透传）
                      inputSchema: {
                        // 其余键原样保留
                        ...inputSchema,
                        // type 固定为 object
                        type: "object",
                        // properties 仅在是对象时保留
                        ...(isRecord(properties) ? { properties } : {}),
                        // required 仅在全部为字符串时保留
                        ...(Array.isArray(required) && required.every((key): key is string => typeof key === "string")
                          ? { required }
                          : {}),
                      },
                      // 输出 schema 仅在是对象时保留
                      outputSchema: isRecord(tool.outputSchema) ? tool.outputSchema : undefined,
                      // 注解仅在是对象时保留
                      annotations: isRecord(tool.annotations) ? tool.annotations : undefined,
                      // 执行声明仅在是对象时保留
                      execution: isRecord(tool.execution) ? tool.execution : undefined,
                      // 元数据仅在是对象时保留
                      _meta: isRecord(tool._meta) ? tool._meta : undefined,
                    },
                  ]
                })
                // 清空并重建按名字索引的已列工具缓存
                listed.clear()
                for (const tool of tools) listed.set(tool.name, tool)
                // 逐条记录被跳过的工具（丢弃结果，仅留日志）
                return Effect.forEach(
                  skipped,
                  (entry) => Effect.logWarning("skipping invalid MCP tool", { server, ...entry }),
                  { discard: true },
                ).pipe(Effect.as(tools))
              }),
            )
          // 未宣告 tools 能力：直接返回空列表
          : Effect.succeed([]),
      // prompts：列出提示词（未宣告能力时返回空）
      prompts: () =>
        advertised("prompts")
          ? list("list MCP prompts", (signal) => client.listPrompts(undefined, { ...catalog, signal })).pipe(
              // 只取 prompts 字段
              Effect.map((r) => r.prompts),
            )
          : Effect.succeed([]),
      // resources：列出资源（未宣告能力时返回空）
      resources: () =>
        advertised("resources")
          ? list("list MCP resources", (signal) => client.listResources(undefined, { ...catalog, signal })).pipe(
              // 只取 resources 字段
              Effect.map((r) => r.resources),
            )
          : Effect.succeed([]),
      // resourceTemplates：列出资源模板（未宣告能力时返回空）
      resourceTemplates: () =>
        advertised("resources")
          ? list("list MCP resource templates", (signal) =>
              client.listResourceTemplates(undefined, { ...catalog, signal }),
            ).pipe(Effect.map((r) => r.resourceTemplates))
          : Effect.succeed([]),
      // readResource：读取一个资源（未宣告能力时返回 undefined）
      readResource: (input) => {
        // 未宣告资源能力时直接 undefined
        if (!advertised("resources")) return Effect.succeed(undefined)
        // 发起读取请求（带按请求的交互信号与执行超时）
        return request("read MCP resource", (signal) =>
          client.readResource({ uri: input.uri }, { signal: claim(signal, input), timeout: execution }),
        )
      },
      // prompt：获取一个提示词
      prompt: (input) =>
        request("get MCP prompt", (signal) =>
          client.getPrompt(
            // 名称与参数（缺省空对象）
            { name: input.name, arguments: input.args ?? {} },
            // 带按请求的交互信号与执行超时
            { signal: claim(signal, input), timeout: execution },
          ),
        ),
      // callTool：调用一个工具
      callTool: (input) => {
        // 构造工具调用请求
        const call = Effect.tryPromise({
          try: (signal) =>
            client.callTool(
              {
                // 工具名
                name: input.name,
                // 参数（缺省空对象）
                arguments: input.args ?? {},
                // 会话 ID 经 _meta 透传（未提供时省略）
                ...(input.sessionID === undefined ? {} : { _meta: { "ai.opencode/sessionID": input.sessionID } }),
              },
              {
                // 带按请求的交互信号
                signal: claim(signal, input),
                // 执行超时
                timeout: execution,
                // Only asks for a progress token: progress on the response stream can keep proxies from closing it.
                // The SDK timeout does not reset on progress; execution is the hard wall.
                // 只申请进度令牌：响应流的进度能让代理不提前断开；SDK 超时不因进度重置
                onprogress: () => {},
                // Always passed, even for a tool we haven't listed, so the SDK never falls back to listing
                // and caching the raw tools itself. Its types are narrower than what it reads (JSON values,
                // a string `$schema`); ours keep the server's values. Leaving out `outputSchema` skips the
                // SDK's output check: servers return results that miss or break their own schema (Zoom
                // answers a 204 with nothing), and failing the call would report a completed action as failed.
                toolDefinition: {
                  ...(listed.get(input.name) ?? { name: input.name, inputSchema: { type: "object" } }),
                  outputSchema: undefined,
                } as CallToolRequestOptions["toolDefinition"],
              },
            ),
          catch: (error) => error,
        })
        // A modern server rejects headers mirrored from a stale definition before running the tool,
        // so relist and retry once with the fresh definition.
        // 现代服务器因陈旧定义的头不匹配而拒绝时：重新列工具并重试一次
        return call.pipe(
          Effect.catchIf(
            // 仅现代连接的 -32020 头不匹配错误触发
            (error) => connection.modern && error instanceof ProtocolError && error.code === HEADER_MISMATCH,
            // 重新列工具后重试调用
            () => connection.tools().pipe(Effect.andThen(call)),
          ),
          // 统一错误映射（含会话过期判定）
          Effect.mapError(failure),
          // 失败记警告日志
          Effect.tapError((error) => Effect.logWarning("failed to call MCP tool", { server, error: error.message })),
          // 把 SDK 结果转换为内部结果类型
          Effect.map(toCallToolResult),
        )
      },
      // onClose：注册连接关闭回调（带最近错误原因）
      onClose: (callback) => {
        client.onclose = () => callback(lastError ? `Connection closed: ${lastError}` : "Connection closed")
      },
      // onSessionExpired：注册会话过期回调
      onSessionExpired: (callback) => {
        session.expired = callback
      },
      // onToolsChanged：注册工具变化回调
      onToolsChanged: (callback) => {
        changed.tools = callback
      },
      // onPromptsChanged：注册提示词变化回调
      onPromptsChanged: (callback) => {
        changed.prompts = callback
      },
      // onResourcesChanged：注册资源变化回调
      onResourcesChanged: (callback) => {
        changed.resources = callback
      },
    }
    // 返回连接对象
    return connection
  }

  // 失败路径：提取错误对象
  const error = Cause.squash(exit.cause)
  if (error instanceof UnauthorizedError || error instanceof InsufficientScopeError)
    return yield* new NeedsAuthError({ server, message: error.message })
  if (error instanceof UnsupportedProtocolVersionError)
    return yield* new ConnectError({
      server,
      message: `${error.message}; the server supports ${error.supported.join(", ")}. Set "protocol" for this server to one of those or to "legacy".`,
    })
  // 其余错误 → 连接错误；answered 取决于错误是否“重试也一样”
  return yield* new ConnectError({ server, message: explain(error), answered: !repeats(error) })
})

// Connecting again would fail the same way: the server could not be spawned or reached, did not answer in
// time, is overloaded or down for now, or refused this client's access. A failed auto probe wraps the error it hit.
// repeats：判断重连是否必然同样失败（用于 answered 标记）
function repeats(error: unknown): boolean {
  // 自动协商失败且带内因时递归看内因
  if (error instanceof SdkError && error.code === SdkErrorCode.EraNegotiationFailed && error.cause !== undefined)
    return repeats(error.cause)
  return (
    // 请求超时：再连多半还是超时
    (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) ||
    // Refused credentials, even without OAuth: any connection with them would be refused the same way.
    // 401/403：凭证被拒（有无 OAuth 都一样）
    (error instanceof SdkHttpError && (error.status === 401 || error.status === 403)) ||
    // The authorization server could not refresh the token for now; see McpOAuth.
    (error instanceof OAuthError && error.code === OAuthErrorCode.TemporarilyUnavailable) ||
    isTransient(error) ||
    // 平台错误（进程无法生成等）
    PlatformError.isPlatformError(error)
  )
}

// These servers reject any unknown query parameter and have no Code Mode of their own, so adding
// ?codemode=false only costs a failed request before the retry at the configured URL.
// rejectsUnknownQuery：这些服务器拒绝任何未知查询参数且没有自带 Code Mode，附加参数只会白白失败一次
function rejectsUnknownQuery(url: URL) {
  // Google Workspace MCP（gmailmcp、drivemcp、calendarmcp 等）返回 404
  // Google Workspace MCP (gmailmcp, drivemcp, calendarmcp, ...) returns 404.
  if (url.hostname.endsWith(".googleapis.com")) return true
  // Zoho MCP 网关（zohomcp.com、zohomcp.eu 等）返回 400
  // Zoho MCP gateways (zohomcp.com, zohomcp.eu, ...) return 400.
  if (/(^|\.)zohomcp\.[a-z.]+$/.test(url.hostname)) return true
  // Loopback servers run on this machine (Figma Desktop's Dev Mode MCP returns 404), so they are not hosted Code Mode servers.
  // 环回地址服务器跑在本机（不是托管 Code Mode 服务器），同样跳过
  return url.hostname === "localhost" || url.hostname === "[::1]" || /^127(\.\d+){3}$/.test(url.hostname)
}

// Absent config is legacy: the SDK sends the plain initialize handshake with no discover probe.
// negotiation：把配置的协议模式映射为 SDK 的版本协商选项（缺省即 legacy，不做发现探测）
function negotiation(protocol: ConfigMCP.Protocol | undefined): VersionNegotiationOptions | undefined {
  // 未配置或 legacy：不传协商选项
  if (protocol === undefined || protocol === "legacy") return undefined
  // auto：自动协商
  if (protocol === "auto") return { mode: "auto" }
  // 其余：钉住指定版本
  return { mode: { pin: protocol } }
}

// toCallToolResult：把 SDK 的工具调用结果转换为内部结果类型
function toCallToolResult(result: SdkCallToolResult): CallToolResult {
  return {
    // isError 仅在明确为 true 时成立
    isError: result.isError === true,
    // 结构化内容原样透传
    structured: result.structuredContent,
    // 内容片段逐个映射
    content: result.content.flatMap((part): CallToolContent[] => {
      // 文本片段 → 文本
      if (part.type === "text") return [{ type: "text", text: part.text }]
      // 图片/音频片段 → 媒体
      if (part.type === "image" || part.type === "audio")
        return [{ type: "media", data: part.data, mimeType: part.mimeType }]
      // 资源链接片段 → 以 URI 为文本
      if (part.type === "resource_link") return [{ type: "text", text: part.uri }]
      // 内嵌资源片段
      if (part.type === "resource") {
        // 取出资源本体
        const resource = part.resource
        // 文本资源 → 文本
        if ("text" in resource) return [{ type: "text", text: resource.text }]
        // blob 资源带 MIME 类型 → 媒体（附 URI）
        if ("blob" in resource && resource.mimeType !== undefined)
          return [{ type: "media", data: resource.blob, mimeType: resource.mimeType, uri: resource.uri }]
        // 其余 → 仅 URI 文本
        return [{ type: "text", text: resource.uri }]
      }
      // 未知片段丢弃
      return []
    }),
  }
}
