// 以 ServerProcess 命名空间 re-export 本模块
export * as ServerProcess from "./process"

// 引入 Effect 平台的 Node HTTP 服务器集成
import { NodeHttpServer } from "@effect/platform-node"
// 引入核心事件总线（Bus）
import { Bus } from "@opencode/core/bus"
// 引入会话执行重启服务：恢复执行声明未释放的会话
import { SessionRestart } from "@opencode/core/session/execution/restart"
// 引入调度（Schedule）服务
import { Schedule } from "@opencode/core/schedule"
// 引入安装事件 Schema（更新可用/已完成更新）
import { InstallationEvent } from "@opencode/schema/installation-event"
// 引入判别函数：URL 是否为带票据的 PTY 连接
import { hasPtyConnectTicketURL } from "@opencode/protocol/groups/pty"
// 引入判别函数：URL 是否为带票据的持久化 PTY 连接
import { hasPersistentPtyConnectTicketURL } from "@opencode/protocol/groups/persistent-pty"
// 引入判别函数：URL 是否为带票据的 MCP 客户端连接
import { hasMcpClientTicketURL } from "@opencode/protocol/groups/mcp"
// 引入判别函数：URL 是否为配对连接
import { isPairingConnectURL } from "@opencode/protocol/groups/server"
// 引入全局路径工具（如临时目录）
import { Global } from "@opencode/util/global"
// 引入 Effect 核心：Cause（原因）、Context、Effect、Exit（结果）、Latch（闩锁）、Layer、Option、Ref（可变引用）、Scope（作用域）
import { Cause, Context, Effect, Exit, Latch, Layer, Option, Ref, Scope } from "effect"
// 引入 HTTP 中间件、路由、请求与响应工具
import { HttpMiddleware, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
// 引入网络地址类型
import { NetAddress } from "effect/net"
// 引入 Node 原生 http.createServer
import { createServer } from "node:http"
// 引入服务端认证配置与校验
import { ServerAuth } from "./auth"
// 引入 CORS 来源白名单判断
import { isAllowedCorsOrigin } from "./cors"
// 引入请求认证函数与 401 响应构造
import { authorizedRequest, unauthorizedResponse } from "./middleware/authorization"
// 引入"去除父级 Span"的追踪工具
import { withoutParentSpan } from "./request-tracing"
import { RequestSite } from "./request-site"
import { createRoutes } from "./routes"
// 引入服务器信息（连接 URL 等）服务
import { ServerInfo } from "./server-info"
// 引入服务状态（starting/ready/stopping/failed）服务
import { Status } from "./service-status"
// 引入服务器选项类型（仅类型导入）
import type { ServerOptions } from "./options"

// 生命周期钩子接口：服务器开始监听后回调，调用方可在回调中启动自身逻辑并返回清理函数
export interface Lifecycle<E = never, R = never> {
  readonly onListen: (
    // 实际监听地址
    address: NetAddress.SocketAddress,
    // 可用于触发服务器关停的 effect
    shutdown: Effect.Effect<void>,
  ) => Effect.Effect<Effect.Effect<void>, E, R>
}

// 应用类型：从请求环境读取、产出 HTTP 响应、错误类型不限、依赖请求与作用域
type App = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  unknown,
  HttpServerRequest.HttpServerRequest | Scope.Scope
>

// 变换器（Transform）类型：接收应用并返回包装后的应用
export type Transform = (app: App) => App

// 错误响应日志中间件：只对状态码 >= 400 的响应记录请求日志
const errorResponseLogger = HttpMiddleware.make((app) =>
  // 借用 HttpMiddleware.logger，但按响应状态决定是否真正输出
  HttpMiddleware.logger(
    // 对响应做 tap：成功响应（<400）禁用日志，失败响应保持默认记录
    Effect.tap(app, (response) =>
      response.status < 400 ? HttpMiddleware.withLoggerDisabled(Effect.void) : Effect.void,
    ),
  ),
)

// 启动服务器进程：绑定端口、装配请求分发、处理生命周期与后台服务引导
export const start = Effect.fn("ServerProcess.start")(function* <E, R>(
  // 服务器选项
  options: ServerOptions,
  // 可选的生命周期钩子
  lifecycle?: Lifecycle<E, R>,
  // 可选的应用变换器
  transform?: Transform,
  // 可选的远程 URL 列表提供者
  remoteURLs?: () => ReadonlyArray<string>,
) {
  // 读取访问密码
  const password = options.password
  // 没有密码则直接失败：服务器必须设置密码
  if (!password) return yield* Effect.fail(new Error("Missing server password"))
  // 主机名缺省为本机回环 127.0.0.1
  const hostname = options.hostname ?? "127.0.0.1"
  // 端口包装为 Option（可能未指定）
  const port = Option.fromNullishOr(options.port)
  // 创建关停闩锁：open 触发关停，await 等待关停信号
  const shutdown = yield* Latch.make()
  // 创建服务状态追踪器（starting/ready/stopping/failed）
  const status = yield* Status.make()
  // 绑定监听端口（未指定时从 4096 起自动寻找可用端口）
  const bound = yield* listen({ hostname, port })
  // 计算本机可用的连接 URL 列表
  const localURLs = () => {
    // 读取实际绑定的地址
    const address = bound.server.address()
    // 地址为空或 Unix socket 字符串时给不出 HTTP URL
    if (address === null || typeof address === "string") return []
    // IPv6 地址在 URL 中需要加方括号
    const host = address.family === "IPv6" ? `[${address.address}]` : address.address
    // 基于实际地址与端口生成所有连接 URL
    return ServerInfo.connectionURLs(`http://${host}:${address.port}`, hostname)
  }
  // 完整 URL 列表 = 本机 URL + 远程 URL
  const urls = () => [...localURLs(), ...(remoteURLs?.() ?? [])]
  // 用 Ref 保存应用 effect：初始为空，后台引导完成后才填入
  const application = yield* Ref.make(Option.none<App>())
  // 构建请求分发器：认证 + 就绪检查 + 转发到真实应用
  const app = dispatch(password, status, application, options.app?.version ?? "unknown", urls, Global.Path.tmp)
  // 请求 fiber 可以继续携带入站追踪上下文，但不得继承服务器启动期的父级 Span。
  // Request fibers may continue inbound trace context, but must not inherit the server startup parent.
  // 启动 HTTP 服务：应用可先经 transform 包装，再叠加压缩与 CORS 中间件，外层套错误响应日志
  yield* bound.http
    .serve(
      // transform 存在则先包装应用
      (transform ? transform(app) : app).pipe(
        RequestSite.middleware(options),
        HttpMiddleware.compression(),
        // 启用 CORS：按选项中的白名单判断来源，预检结果缓存 24 小时
        HttpMiddleware.cors({ allowedOrigins: (origin) => isAllowedCorsOrigin(origin, options), maxAge: 86_400 }),
      ),
      // 附加错误响应日志中间件
      errorResponseLogger,
    )
    // 提供 Node HTTP 服务层依赖，并剥离启动阶段的父级 Span
    .pipe(Effect.provide(NodeHttpServer.layerHttpServices), withoutParentSpan)
  // 提供了生命周期钩子时：监听成功后回调
  if (lifecycle)
    yield* lifecycle.onListen(bound.http.address, shutdown.open.pipe(Effect.asVoid)).pipe(
      // 回调返回一个清理 effect，需要注册为 finalizer（终局器）
      Effect.flatMap((cleanup) =>
        // 注册 finalizer：先关闭服务器作用域，再执行调用方的清理
        Effect.addFinalizer(() => Scope.close(bound.scope, Exit.void).pipe(Effect.andThen(cleanup))),
      ),
      // 回调过程不可被中断，保证生命周期语义完整
      Effect.uninterruptible,
    )

  // 获取当前作用域（start 的调用方作用域）
  const parentScope = yield* Scope.Scope
  // 从父作用域派生应用作用域：承载后台服务与应用路由的生存期
  const applicationScope = yield* Scope.fork(parentScope)
  // 注册 finalizer：关停时先把状态置为 stopping、清空应用引用，并立即断开所有连接
  yield* Effect.addFinalizer(() =>
    status.beginStopping.pipe(
      // 清空应用引用，让后续请求得到 503 而不是继续路由
      Effect.andThen(Ref.set(application, Option.none())),
      // 主动关闭所有已建立的 TCP 连接，加快退出
      Effect.andThen(Effect.sync(() => bound.server.closeAllConnections())),
    ),
  )

  // 后台服务引导：构建路由层并填充应用引用。
  // 构建时剥离启动 Span：路由处理器与后台 fiber 会捕获该上下文，否则进程生命周期内
  // 的每个请求与会话轮次都会嵌套在同一条追踪（trace）之下。
  // Built without the startup span: route handlers and background fibers capture this context, and would
  // otherwise nest every request and session turn for the life of the process under one trace.
  const boot = Effect.gen(function* () {
    // 在应用作用域内构建 createRoutes 层，并与 Node HTTP 服务层合并共享
    const context = yield* Layer.buildWithScope(
      createRoutes(
        {
          // 透传全部选项（此时密码已确保存在）
          ...options,
          password,
        },
        // 连接 URL 提供者
        urls,
      ).pipe(Layer.provideMerge(NodeHttpServer.layerHttpServices)),
      // 构建所用的应用作用域
      applicationScope,
    )
    // 提供了生命周期钩子时：安装会话重启连续性
    if (lifecycle) {
      // 从构建出的上下文取出 SessionRestart 服务并安装恢复逻辑
      yield* installRestartContinuity(Context.get(context, SessionRestart.Service)).pipe(
        // 在应用作用域内运行（其后台任务随应用生存）
        Effect.provideService(Scope.Scope, applicationScope),
      )
    }
    // 调度可从任意服务进程触发（service、opencode serve 或 --standalone）；其状态全部保存在表中。
    // Schedules fire from any server process (`service`, `opencode serve`, or `--standalone`); the table holds all their state.
    // 在应用作用域内启动调度服务
    yield* Effect.forkIn(Context.get(context, Schedule.Service).run, applicationScope)
    // 取出 HTTP 路由并转为可执行的 HTTP effect，填入应用引用
    yield* Ref.set(application, Option.some(Context.get(context, HttpRouter.HttpRouter).asHttpEffect()))
    // 标记服务已就绪
    yield* status.ready
    // 取出事件总线
    const bus = Context.get(context, Bus.Service)
    // 返回启动结果：监听地址、关停等待与更新事件发布器
    return {
      // 实际监听地址
      address: bound.http.address,
      // 等待关停信号的 effect
      shutdown: shutdown.await,
      // 发布"有更新可用"事件
      updateAvailable: (version: string) =>
        bus.publish(InstallationEvent.UpdateAvailable, { version }).pipe(Effect.asVoid),
      // 发布"已完成更新"事件
      updated: (version: string) => bus.publish(InstallationEvent.Updated, { version }).pipe(Effect.asVoid),
    }
  }).pipe(
    withoutParentSpan,
    // 引导失败时的兜底处理
    Effect.catchCause((cause) => {
      // 无生命周期钩子，或失败仅由中断引起：原样向上传递
      if (!lifecycle || Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
      // 有生命周期钩子的后台服务模式：标记状态为失败
      return status.fail.pipe(
        // 关闭应用作用域以释放后台资源
        Effect.andThen(
          Scope.close(applicationScope, Exit.failCause(cause)).pipe(
            // 清理自身的失败只记日志，不掩盖原始错误
            Effect.catchCause((cleanupCause) =>
              Effect.logError("failed to clean up background service boot", { cause: cleanupCause }),
            ),
          ),
        ),
        // 记录引导失败的错误日志
        Effect.andThen(Effect.logError("background service boot failed", { cause })),
        // 永不完成：保持进程存活，等待外部重启或关停
        Effect.andThen(Effect.never),
      )
    }),
  )
  // 无生命周期钩子：直接等待引导完成并返回结果
  if (!lifecycle) return yield* boot
  // 有生命周期钩子：引导完成与关停信号赛跑，先到者决定结束方式
  return yield* Effect.raceFirst(boot, shutdown.await.pipe(Effect.andThen(Effect.interrupt)))
})

// 绑定监听：指定了端口就直接绑定，否则从 4096 起逐个尝试直到找到可用端口
function listen(options: { readonly hostname: string; readonly port: Option.Option<number> }) {
  // 指定端口：直接绑定该端口
  if (Option.isSome(options.port)) return bind(options.hostname, options.port.value)
  // 递归尝试下一个端口的辅助函数
  const next = (port: number): ReturnType<typeof bind> =>
    bind(options.hostname, port).pipe(
      // 绑定失败且是端口占用（EADDRINUSE）且未超出 65535 上限时，尝试下一个端口
      Effect.catch((error) => (port < 65_535 && addressInUse(error) ? next(port + 1) : Effect.fail(error))),
    )
  // 从 4096 开始尝试
  return next(4096)
}

// 在指定主机与端口上创建并启动 Node HTTP 服务器
function bind(hostname: string, port: number) {
  return Effect.gen(function* () {
    // 获取父级作用域
    const parentScope = yield* Scope.Scope
    // 为服务器派生独立作用域，便于单独释放其资源
    const serverScope = yield* Scope.fork(parentScope)
    // 创建裸 Node HTTP 服务器实例（暂不监听）
    const server = createServer()
    // 组装 Effect 平台的 HTTP 服务器
    return yield* Effect.gen(function* () {
      // 用该 server 创建 Effect HTTP 服务器并监听指定端口与主机
      const http = yield* NodeHttpServer.make(() => server, { port, host: hostname })
      // 注册 finalizer：作用域关闭时立即断开所有连接
      yield* Effect.addFinalizer(() => Effect.sync(() => server.closeAllConnections()))
      // 返回 HTTP 服务器、裸 server 与所属作用域
      return { http, server, scope: serverScope }
    }).pipe(
      // 在服务器作用域内运行
      Effect.provideService(Scope.Scope, serverScope),
      // 启动失败时关闭该作用域，回滚已注册的 finalizer
      Effect.onError((cause) => Scope.close(serverScope, Exit.failCause(cause))),
    )
  })
}

// 判断一个错误是否为端口占用（EADDRINUSE）
function addressInUse(error: unknown) {
  // 非对象或没有 cause 字段时不视为端口占用
  if (typeof error !== "object" || error === null || !("cause" in error)) return false
  // 取出内层 cause（Node 的系统错误包装在外层 Error 的 cause 中）
  const cause = error.cause
  // cause 是对象且其 code 为 EADDRINUSE 才算端口占用
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EADDRINUSE"
}

// 请求分发器：应用就绪前后统一走这里（认证、/api/info、就绪检查、转发）
function dispatch(
  // 访问密码
  password: string,
  // 服务状态接口
  status: Status.Interface,
  // 应用引用（就绪后才有值）
  application: Ref.Ref<Option.Option<App>>,
  // 应用版本号
  version: string,
  // 连接 URL 列表提供者
  urls: () => ReadonlyArray<string>,
  // 临时目录路径
  tmp: string,
): App {
  // 构造认证配置：用户名固定 opencode，密码为启动时传入的值
  const auth = ServerAuth.Config.of({ password: Option.some(password), username: "opencode" })
  return Effect.gen(function* () {
    // 读取当前请求
    const request = yield* HttpServerRequest.HttpServerRequest
    // 用占位 base 解析请求 URL，便于取路径与查询参数
    const url = new URL(request.url, "http://localhost")
    // 读取当前服务状态
    const state = yield* status.current
    // 读取当前应用引用
    const app = yield* Ref.get(application)
    // 就绪 = 状态为 ready 且应用引用有值
    const ready = state.type === "ready" && Option.isSome(app)
    // 就绪前的 GET /api/info 也要先认证，然后返回服务器状态信息
    if (request.method === "GET" && url.pathname === "/api/info" && !ready) {
      // 未认证：返回 401
      if (!(yield* authorizedRequest(request, auth))) return unauthorizedResponse(request)
      // 已认证：返回版本/URL/路径等状态信息
      return yield* infoResponse(status, version, urls, tmp)
    }
    // 非配对连接、且（未就绪或不是带票据的 PTY/MCP 连接）的请求，必须先通过认证
    if (
      !isPairingConnectURL(url) &&
      (!ready ||
        (!hasPtyConnectTicketURL(url) && !hasPersistentPtyConnectTicketURL(url) && !hasMcpClientTicketURL(url))) &&
      !(yield* authorizedRequest(request, auth))
    )
      // 认证失败：返回 401
      return unauthorizedResponse(request)
    // 已就绪：交给真实应用处理
    if (ready) return yield* app.value
    // 未就绪：返回 503 服务不可用响应
    return unavailable(state)
  })
}

// /api/info 的响应：版本、进程号、连接 URL 与临时目录；状态决定状态码与重试提示
const infoResponse = Effect.fnUntraced(function* (
  status: Status.Interface,
  version: string,
  urls: () => ReadonlyArray<string>,
  tmp: string,
) {
  // 读取当前服务状态
  const state = yield* status.current
  // 返回 JSON 响应
  return HttpServerResponse.jsonUnsafe(
    // 响应体：版本、PID、全部连接 URL、路径信息
    { version, pid: process.pid, urls: urls(), paths: { tmp } },
    {
      // ready 为 200，failed 为 500，其余（starting/stopping）为 503
      status: state.type === "ready" ? 200 : state.type === "failed" ? 500 : 503,
      // 启动中或停止中时附带"1 秒后重试"提示头
      headers: state.type === "starting" || state.type === "stopping" ? { "retry-after": "1" } : undefined,
    },
  )
})

// 未就绪时的 503 响应：区分启动失败、停止中与启动中
function unavailable(status: Status.State) {
  // 后台服务启动失败：给出错误码、说明与建议操作
  if (status.type === "failed")
    return HttpServerResponse.jsonUnsafe(
      {
        // 错误码：服务启动失败
        code: "service_failed",
        // 说明文案
        message: "The background service could not start.",
        // 建议操作：查日志后执行 service restart
        action: "Run `opencode service restart` after checking the service logs.",
      },
      // 状态码 503
      { status: 503 },
    )
  // 其余情况：停止中或启动中，同样 503 并建议稍后重试
  return HttpServerResponse.jsonUnsafe(
    // 错误码区分 service_stopping / service_starting
    { code: status.type === "stopping" ? "service_stopping" : "service_starting" },
    // 状态码 503 + 1 秒重试提示
    { status: 503, headers: { "retry-after": "1" } },
  )
}

/**
 * 受管服务器（managed server）负责重启连续性：启动时恢复那些执行声明（claim）从未被释放的
 * 会话。声明在执行开始时写入（见 SessionExecution），因此恢复同时覆盖优雅重启与异常死亡——
 * 全程不依赖任何关停钩子。
 * The managed server owns restart continuity: at boot it resumes Sessions whose execution claim was
 * never released. Claims are written when execution starts (see SessionExecution), so recovery covers
 * graceful restarts and unclean deaths alike — no shutdown hook participates.
 */
// 安装重启连续性：派生后台任务恢复被挂起的会话
const installRestartContinuity = Effect.fnUntraced(function* (restart: SessionRestart.Interface) {
  // 在当前作用域内 fork：恢复那些执行声明未释放的会话
  yield* Effect.forkScoped(restart.resumeSuspendedSessions)
})
