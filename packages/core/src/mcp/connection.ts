// 将本模块以命名空间 McpConnection 整体再导出（barrel 模式）
export * as McpConnection from "./connection.js"

import type { AuthProvider } from "@modelcontextprotocol/client"
import type { Mcp } from "@opencode/schema/mcp"
// 引入 Effect：原因、Effect、Exit、作用域
import { Cause, Effect, Exit, Scope } from "effect"
// 引入 Effect 的 fetch HTTP 客户端标记（可替换的 fetch 实现）
import { FetchHttpClient } from "effect/http"
// 引入环境（Environment）服务：stdio 服务器在其上执行
import { Environment } from "../environment/index.js"
// 引入键控互斥（KeyedMutex）：按 key 串行化
import { KeyedMutex } from "../effect/keyed-mutex.js"
// 仅引入类型：MCP 客户端连接
import type { McpClient } from "./client.js"

// 失败类型：failed（连接失败）或 needs_auth（需要认证）两种状态之一
export type Failure = Extract<Mcp.Status, { readonly status: "failed" | "needs_auth" }>

/** A catalog the server can change: its tools, prompts or resources. */
// 目录（catalog）类别：工具、提示词或资源
export type Kind = "tools" | "prompts" | "resources"

// Unshared connections to one remote endpoint, from any number of Locations, take turns at their
// handshake so the endpoint does not receive a startup burst.
// 端点级互斥：来自任意多个 Location、指向同一远程端点的未共享连接按序握手，避免启动风暴
const endpointLoads = KeyedMutex.makeUnsafe<string>()

/**
 * What a connection reports to its owner. Each runs inline, in order, so the owner can keep its own
 * state and publish in step with the connection.
 */
// 连接事件回调集合：按序内联执行，拥有者据此维护自身状态并与连接保持同步
export interface Events {
  /** An attempt is about to connect. */
  // 一次连接尝试即将开始
  readonly connecting: Effect.Effect<void>
  /** The attempt connected and listed its tools. */
  // 本次尝试已连接并列出工具
  readonly connected: Effect.Effect<void>
  /** `answered` is true when the server was reached but refused or broke the handshake. */
  // 连接失败；answered 为 true 表示服务器可达但拒绝/中断了握手
  readonly failed: (failure: Failure, answered: boolean) => Effect.Effect<void>
  /** The attempt ended, however it ended. */
  // 本次尝试结束（无论结局如何）
  readonly settled: Effect.Effect<void>
  /** The live connection closed on its own. Runs under the lock; the owner decides how to stop. */
  // 活跃连接自行关闭（在锁下运行；如何停止由拥有者决定）
  readonly closed: (reason: string) => Effect.Effect<void>
  /** A catalog changed: the server said so, or the connection was torn down and every catalog emptied. */
  // 某类目录变化：服务器主动通知，或连接被拆除而全部清空
  readonly changed: (kind: Kind) => Effect.Effect<void>
  /**
   * Shared connections only: the server negotiated an older protocol than 2026-07-28, so the attempt closed
   * right after the handshake, without listing tools. Reported instead of `connected` or `failed`.
   */
  // 仅共享连接使用：服务器协商到 2026-07-28 之前的旧协议版本（代替 connected/failed 上报）
  readonly legacy?: (version: string | undefined) => Effect.Effect<void>
}

// 创建连接所需的输入
export interface Input {
  // 服务器名
  readonly name: string
  // 服务器配置
  readonly config: Mcp.ServerConfig
  // 工作目录
  readonly directory: string
  /**
   * Serves several Locations: it answers no `roots/list`, since no one directory owns it, and skips the
   * per-endpoint handshake turn, since it is already the only connection for its key.
   */
  // 共享连接：服务多个 Location；不回应 roots/list，也跳过按端点排队的握手
  readonly shared?: boolean
  // 客户端标识（名称 + 版本），用于 initialize 握手
  readonly clientInfo?: { readonly name: string; readonly version: string }
  /** Declares MCP Events; see `McpClient.ConnectOptions.events`. */
  readonly mcpEvents?: boolean
  /** Read on every attempt, so a credential change applies to the next one. */
  readonly authProvider: Effect.Effect<AuthProvider | undefined>
  readonly elicitation: McpClient.ElicitationHandler
  /** A stdio server is spawned on this execution plane. */
  // stdio 服务器在该执行平面上生成
  readonly environment: Environment.Interface
  /** A remote server is reached with this fetch. */
  // 远程服务器通过此 fetch 访问
  readonly fetch: typeof globalThis.fetch
  /** Each attempt's scope is forked from this one. */
  // 每次尝试的作用域都从它分叉
  readonly scope: Scope.Scope
  /** Serializes lifecycle work. Callbacks and recovery take it; `start` and `stop` expect the caller to hold it. */
  // 生命周期互斥锁：回调与恢复会获取它；start/stop 要求调用方已持有
  readonly lock: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>
  /** Runs callbacks from the live connection. */
  // 运行活跃连接的回调
  readonly callbacks: (effect: Effect.Effect<void>) => unknown
  /** Runs recovery that a background request triggered. */
  // 运行后台请求触发的恢复
  readonly fork: (effect: Effect.Effect<void>) => unknown
  // 事件回调集合
  readonly events: Events
}

// 目录：一个服务器的资源与资源模板列表
export interface Catalog {
  // 资源列表
  readonly resources: ReadonlyArray<McpClient.Resource>
  // 资源模板列表
  readonly templates: ReadonlyArray<McpClient.ResourceTemplate>
}

/** One server connection, reconnected in place, with the catalogs it listed. */
// 一条服务器连接：可原地重连，并携带已列出的目录
export interface Connection {
  // 当前客户端连接（未连接时为 undefined）
  readonly client: McpClient.Connection | undefined
  /** The server's tool list as listed. Each refresh replaces the array. */
  // 服务器工具列表（按列出原样；每次刷新替换整个数组）
  readonly tools: ReadonlyArray<McpClient.Tool> | undefined
  // 提示词列表
  readonly prompts: ReadonlyArray<McpClient.Prompt> | undefined
  /** Connects and lists tools; a failure is reported through `failed`. */
  // 启动：连接并列出工具；失败经 failed 事件上报
  readonly start: Effect.Effect<void>
  // 停止连接
  readonly stop: Effect.Effect<void>
  /**
   * Runs a request against `client` and, if that request observed a session expiry, reconnects and
   * runs it once more against the replacement. Any other failure passes through.
   */
  // recovering：运行请求；若观测到会话过期则重连并对替换连接再跑一次；其他失败原样通过
  readonly recovering: <A, E extends Error>(
    client: McpClient.Connection,
    run: (client: McpClient.Connection) => Effect.Effect<A, E>,
  ) => Effect.Effect<A, E>
  // 拉取资源目录
  readonly catalog: (client: McpClient.Connection) => Effect.Effect<Catalog, Error>
}

// 工厂：创建一条服务器连接
export function make(input: Input): Connection {
  // 内部可变状态：当前作用域、客户端连接、工具与提示词列表
  const state: {
    scope?: Scope.Closeable
    client?: McpClient.Connection
    tools?: ReadonlyArray<McpClient.Tool>
    prompts?: ReadonlyArray<McpClient.Prompt>
  } = {}

  // Runs a connection callback under the lock, dropping it if the connection is no longer the live
  // client, so late SDK callbacks cannot commit obsolete state.
  // 在锁下运行连接回调；若该连接已不是当前活跃客户端则丢弃，防止迟到的 SDK 回调提交过时状态
  const whenLive =
    // 捕获触发回调的客户端
    (client: McpClient.Connection) =>
    // 返回一个包装后的 Effect 执行器
    <E>(effect: Effect.Effect<void, E>) =>
      // 仅当 state.client 仍是该客户端时执行 effect，否则空操作；经锁串行并忽略错误
      input.callbacks(
        Effect.suspend(() => (state.client === client ? effect : Effect.void)).pipe(input.lock, Effect.ignore),
      )

  // 重新拉取工具列表并写入状态
  const refreshTools = (client: McpClient.Connection) =>
    client.tools().pipe(
      // 拉取成功后更新状态中的工具列表
      Effect.map((tools) => {
        state.tools = tools
      }),
    )

  // 重新拉取提示词列表并写入状态（失败按空列表处理）
  const refreshPrompts = (client: McpClient.Connection) =>
    client.prompts().pipe(
      Effect.map((prompts) => {
        state.prompts = prompts
      }),
      // 更新后发布 prompts 变化事件
      Effect.andThen(input.events.changed("prompts")),
    )

  // Re-establishes a connection whose HTTP session the server dropped, unless another path already
  // replaced it while this one waited for the lock.
  // recover：重建被服务器丢弃 HTTP 会话的连接；若等待锁期间连接已被替换则不再动作
  const recover = (client: McpClient.Connection) =>
    Effect.gen(function* () {
      // 当前客户端已不是触发恢复的那个，说明已被别的路径替换
      if (state.client !== client) return
      // 记录重连日志
      yield* Effect.logInfo("mcp session expired, reconnecting", { server: input.name })
      // 先停止旧连接
      yield* stop
      // 再启动新连接
      yield* start
    }).pipe(input.lock)

  // recovering：带会话过期恢复的请求执行
  const recovering = <A, E extends Error>(
    client: McpClient.Connection,
    run: (client: McpClient.Connection) => Effect.Effect<A, E>,
  ) =>
    // 先用原客户端执行请求
    run(client).pipe(
      Effect.catchIf(
        // The client module is loaded lazily, so match the tagged error by tag rather than class.
        // 客户端模块是懒加载的，因此按 error 的 _tag 而不是类来匹配会话过期错误
        (error) => "_tag" in error && error._tag === "MCP.SessionExpiredError",
        // 触发恢复；恢复后若仍有客户端则重试一次，否则原样失败
        (error) => recover(client).pipe(Effect.flatMap(() => (state.client ? run(state.client) : Effect.fail(error)))),
      ),
    )

  // watch：注册连接的生命周期回调（关闭、会话过期、目录变化）
  const watch = (client: McpClient.Connection) => {
    // 取一个“仅当仍活跃时执行”的回调运行器
    const live = whenLive(client)
    // 连接关闭：通知拥有者（锁下执行）
    client.onClose((reason) => live(input.events.closed(reason)))
    // Background refreshes (list-changed) can observe the expiry too; they do not retry, so
    // reconnect here for them. Foreground calls reconnect through `recovering`.
    // 会话过期：后台刷新不会重试，所以在这里代为重连；前台调用走 recovering
    client.onSessionExpired(() => input.fork(recover(client)))
    // 工具列表变化：刷新并广播
    client.onToolsChanged(() => live(refreshTools(client).pipe(Effect.andThen(input.events.changed("tools")))))
    // 提示词变化：刷新（内部自带广播）
    client.onPromptsChanged(() => live(refreshPrompts(client)))
    // 资源变化：直接广播
    client.onResourcesChanged(() => live(input.events.changed("resources")))
  }

  // start：连接服务器并列出工具（失败经 failed 事件上报）
  const start: Effect.Effect<void> = Effect.suspend(() =>
    Effect.gen(function* () {
      // 先广播“连接中”
      yield* input.events.connecting
      // Checked before the OAuth provider is built, which parses the URL too.
      // 在构建 OAuth provider（它也会解析 URL）之前先校验 URL 可解析
      if (input.config.type === "remote" && !URL.canParse(input.config.url))
        // URL 非法：直接以 failed 结束（服务器未应答）
        return yield* input.events.failed(
          { status: "failed", error: `Invalid MCP server URL: ${input.config.url}` },
          false,
        )
      // 从父作用域分叉出本次尝试的作用域
      const scope = yield* Scope.fork(input.scope)
      // 登记当前作用域
      state.scope = scope
      // 读取本次使用的 OAuth 提供者（可能为 undefined）
      const authProvider = yield* input.authProvider
      // 懒加载客户端模块
      const { McpClient } = yield* Effect.promise(() => import("./client.js"))
      // List tools as part of connect so a failure here marks the server failed rather than
      // leaving it connected with a silently empty tool list and no path to recover. A shared connection
      // decides first: it can only be shared on 2026-07-28, so an older server is never asked to list.
      // 连接后一并列工具：失败即标记 failed，避免“已连接但工具静默为空”的僵局
      const config = input.config
      // 执行连接 + 列工具；结果收敛为 Exit
      const result = yield* McpClient.connect({
        // 服务器名
        server: input.name,
        // 配置
        config,
        // 目录
        directory: input.directory,
        // OAuth 提供者
        authProvider,
        // 交互处理器
        elicitation: input.elicitation,
        // 客户端标识
        clientInfo: input.clientInfo,
        // 仅非共享连接声明 roots
        roots: !input.shared,
        events: input.mcpEvents,
      }).pipe(
        // 连接成功后继续列工具（共享且旧协议的除外）
        Effect.flatMap(
          (client): Effect.Effect<{ client: McpClient.Connection; tools?: ReadonlyArray<McpClient.Tool> }, Error> =>
            // 共享连接若是旧协议则不再列工具（只可能在 2026-07-28 上共享）
            input.shared && !client.modern
              ? Effect.succeed({ client })
              // 其他情况列出工具
              : client.tools().pipe(Effect.map((tools) => ({ client, tools }))),
        ),
        // 注入环境服务
        Effect.provideService(Environment.Service, input.environment),
        // 注入 fetch 实现
        Effect.provideService(FetchHttpClient.Fetch, input.fetch),
        // 绑定本次尝试的作用域
        Scope.provide(scope),
        // 远程且未共享时按端点 URL 排队，避免启动风暴
        (effect) => (config.type === "remote" && !input.shared ? endpointLoads.withLock(config.url)(effect) : effect),
        // 收敛为 Exit，避免失败/中断从这里外溢
        Effect.exit,
      )
      // 成功但没有工具列表：旧协议的共享连接，按 legacy 事件上报
      if (Exit.isSuccess(result) && !result.value.tools) {
        // 关闭本次作用域
        yield* Scope.close(scope, Exit.void)
        // 清空登记
        state.scope = undefined
        // 上报 legacy（未配置回调则为空操作）
        return yield* input.events.legacy?.(result.value.client.protocolVersion) ?? Effect.void
      }
      // 成功路径：登记连接与工具
      if (Exit.isSuccess(result)) {
        // 登记客户端
        state.client = result.value.client
        // 登记工具列表
        state.tools = result.value.tools
        // 提示词先置空（稍后台刷新）
        state.prompts = []
        // 注册生命周期回调
        watch(result.value.client)
        // 广播已连接
        yield* input.events.connected
        // 后台刷新一次提示词
        whenLive(result.value.client)(refreshPrompts(result.value.client))
        return
      }
      // 失败路径：关闭作用域
      yield* Scope.close(scope, Exit.void)
      // 清空登记
      state.scope = undefined
      // 从原因中提取错误对象
      const error = Cause.squash(result.cause)
      // 上报失败：需要认证或普通失败；answered 标记服务器是否有响应
      yield* input.events.failed(
        error instanceof McpClient.NeedsAuthError
          ? { status: "needs_auth", error: error.message }
          : { status: "failed", error: error instanceof Error ? error.message : String(error) },
        error instanceof McpClient.ConnectError && error.answered === true,
      )
    }).pipe(
      // 无论成败都广播“本次尝试已结束”
      Effect.ensuring(input.events.settled),
      // 日志附加服务器名、目录与连接 ID
      Effect.annotateLogs({ server: input.name, directory: input.directory, connectionID: crypto.randomUUID() }),
    ),
  )

  // stop：停止连接并清空状态
  const stop = Effect.gen(function* () {
    // 取出当前作用域
    const scope = state.scope
    // 未连接则无事可做
    if (!scope) return
    // 清空作用域登记
    state.scope = undefined
    // 清空客户端
    state.client = undefined
    // 清空工具
    state.tools = undefined
    // 清空提示词
    state.prompts = undefined
    // 关闭作用域（终结 transport、杀进程等）
    yield* Scope.close(scope, Exit.void)
    // 广播工具目录已清空
    yield* input.events.changed("tools")
    // 广播资源目录已清空
    yield* input.events.changed("resources")
    // 广播提示词目录已清空
    yield* input.events.changed("prompts")
  })

  // 返回连接对象：状态以 getter 暴露，操作以方法暴露
  return {
    // 当前客户端连接
    get client() {
      return state.client
    },
    // 当前工具列表
    get tools() {
      return state.tools
    },
    // 当前提示词列表
    get prompts() {
      return state.prompts
    },
    // 启动连接
    start,
    // 停止连接
    stop,
    // 带会话过期恢复的请求执行
    recovering,
    // 拉取资源目录（模板缺失按空处理）
    catalog: (client) =>
      recovering(client, (client) =>
        Effect.all(
          {
            // 资源列表
            resources: client.resources(),
            // Some servers declare resources without implementing template listing.
            // 模板列表：有些服务器声明了资源却不实现模板列举，失败按空处理
            templates: client.resourceTemplates().pipe(Effect.orElseSucceed(() => [])),
          },
          // 两项并行拉取
          { concurrency: "unbounded" },
        ),
      ),
  }
}
