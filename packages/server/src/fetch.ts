// 将本文件的所有导出聚合到命名空间 ServerFetch 下，供统一引入
export * as ServerFetch from "./fetch"

// effect 库：Context、Effect、Layer
import { Context, Effect, Layer } from "effect"
// effect HTTP：HttpEffect、中间件、路由器、服务器层
import { HttpEffect, HttpMiddleware, HttpRouter, HttpServer } from "effect/http"
// 会话重启服务：恢复被中断挂起的会话
import { SessionRestart } from "@opencode/core/session/execution/restart"
// 分层节点类型（运行时服务替换）
import type { LayerNode } from "@opencode/util/effect/layer-node"
// CORS 来源判断
import { isAllowedCorsOrigin } from "./cors"
// 去除父级 tracing span 的工具
import { withoutParentSpan } from "./request-tracing"
// 路由构建
import { createRoutes } from "./routes"
// 服务器选项类型
import type { ServerOptions } from "./options"

// 启动选项
export interface BootOptions {
  /**
   * Runtime-profile service replacements, applied after the standard set so later entries
   * win — swaps services the standard graph assumes are local. See `ServerWorkerd.replacements`.
   */
  // 运行时画像的服务替换项：在标准替换之后应用，后写者优先
  readonly overrides?: LayerNode.Replacements
}

/**
 * Builds a web-standard fetch handler — `(request: Request) => Promise<Response>` — serving the
 * same HttpApi routes as the Node server process without binding a port, owning a listener, or
 * installing signal handlers. This is the entry for runtimes that hand requests to the embedder
 * instead of letting it listen: workerd (Workers and Durable Objects), Deno.serve, Bun.serve, or
 * a test harness.
 *
 * The application layer builds EAGERLY, inside the caller's `Scope`, before the handler is
 * returned. Do not convert this to a lazy first-request build: on workerd, a first request that
 * aborts mid-build interrupts the layer construction and wedges every subsequent request
 * (Effect-TS/effect#6319 class). The embedder owns the lifecycle — closing the scope releases
 * the application layer.
 *
 * Auth follows `createRoutes` semantics: `options.password` enforces Basic auth; omitting it
 * serves unauthenticated, so an embedder without a password must front the handler with its own
 * access control.
 *
 * Sessions whose execution claim was never released resume once the layer is built, exactly as
 * the Node server process does: a runtime that dies without teardown — an evicted Durable
 * Object leaves the same durable signature as a killed process — replays orphaned turns on the
 * next boot, and the sweep is a no-op when nothing is suspended.
 */
// 构建 Web 标准 fetch 处理器：与 Node 服务器同套路由，但不绑端口/不装信号处理
export const make = Effect.fn("ServerFetch.make")(function* (options: ServerOptions = {}, boot: BootOptions = {}) {
  // Handlers capture the build context; without the caller's span, each request is its own trace.
  // 立即构建应用层（在调用者的 Scope 内），处理器会捕获构建上下文
  const context = yield* Layer.build(
    // 用选项与替换项构建路由层，并附带服务器服务
    createRoutes(options, () => [], boot.overrides ?? []).pipe(Layer.provide(HttpServer.layerServices)),
  ).pipe(withoutParentSpan)
  // Forked so the returned handler is never delayed; resumed drains are already
  // logged and durably recorded by the execution layer.
  // 后台分离执行挂起会话的恢复，避免延迟返回处理器
  yield* Effect.forkDetach(Context.get(context, SessionRestart.Service).resumeSuspendedSessions)
  // 从路由器导出 HTTP effect，套上 CORS 中间件并转成 Web 处理器
  return Context.get(context, HttpRouter.HttpRouter)
    // 转为通用 HTTP effect
    .asHttpEffect()
    .pipe(
      // CORS：按来源判断放行，预检缓存 24 小时
      HttpMiddleware.cors({ allowedOrigins: (origin) => isAllowedCorsOrigin(origin, options), maxAge: 86_400 }),
      // 附带构建上下文转成标准 Web fetch 处理器
      HttpEffect.toWebHandlerWith(context),
    )
})
