// 引入主机名工具：返回服务器主机名
import { hostname } from "node:os"
// 引入 Duration（时长）与 Effect
import { Duration, Effect } from "effect"
// 引入 HTTP 请求/响应工具
import { HttpServerRequest, HttpServerResponse } from "effect/http"
// 引入 HTTP API 构建器
import { HttpApiBuilder } from "effect/http-api"
// 引入持久化终端（PersistentPty）：报告其可用性能力
import { PersistentPty } from "@opencode/core/persistent-pty"
// 引入未授权错误（UnauthorizedError）
import { UnauthorizedError } from "@opencode/protocol/errors"
// 引入本服务 API 定义
import { Api } from "../api"
// 引入服务器认证（ServerAuth）：会话令牌签发与 Cookie 工具
import { ServerAuth } from "../auth"
// 引入服务器信息服务（ServerInfo）：版本、URL、路径
import { ServerInfo } from "../server-info"
// 引入配对（ServerPairing）服务：配对码的签发与消费
import { ServerPairing } from "../pairing"

// 导出 ServerHandler：注册 "server.server" 分组处理器
export const ServerHandler = HttpApiBuilder.group(Api, "server.server", (handlers) =>
  Effect.gen(function* () {
    // 获取配对服务
    const pairing = yield* ServerPairing.Service
    // 获取认证配置
    const auth = yield* ServerAuth.Config

    return handlers
      .handle("server.info", () =>
        Effect.gen(function* () {
          // 获取服务器信息服务
          const info = yield* ServerInfo.Service
          return {
            // 应用版本（未知时显示 unknown）
            version: info.app.version ?? "unknown",
            // 服务器进程 PID（缺省 0）
            pid: process.pid ?? 0,
            // 主机名（为空时用 undefined）
            hostname: hostname() || undefined,
            // 可访问的 URL 列表
            urls: info.urls(),
            // 数据目录等路径信息
            paths: info.paths,
            // 能力标记：持久化终端是否可用
            capabilities: { persistentPty: PersistentPty.available },
          }
        }),
      )
      // 处理 server.pair：签发一个新的配对码
      .handle("server.pair", () => pairing.issue())
      .handle(
        // 处理 server.connect：用配对码换取会话令牌（或浏览器跳转登录）
        "server.connect",
        Effect.fn(function* (ctx) {
          // 获取原始 HTTP 请求（读取 Accept 头）
          const request = yield* HttpServerRequest.HttpServerRequest
          // Browser navigations ask for HTML; everything else is an API client that wants the token.
          // 浏览器导航请求的 Accept 含 text/html；其余视为想要令牌的 API 客户端
          const browser = request.headers.accept?.includes("text/html") === true
          // 消费配对码；有效则签发会话令牌，否则为 undefined
          const token = (yield* pairing.consume(ctx.params.code)) ? ServerAuth.issueSession(auth) : undefined
          // 配对码无效或已使用
          if (token === undefined) {
            // API 客户端返回 401 错误
            if (!browser) return yield* new UnauthorizedError({ message: "Pairing link expired or already used" })
            // 浏览器返回友好的 401 文本页面
            return HttpServerResponse.text(
              "This pairing link expired or was already used. Run `opencode pair` to get a new one.",
              { status: 401 },
            )
          }
          // API 客户端直接返回令牌
          if (!browser) return { token }
          // 浏览器：重定向到首页并写入 HttpOnly 会话 Cookie
          return HttpServerResponse.redirect("/").pipe(
            HttpServerResponse.setCookieUnsafe(ServerAuth.sessionCookieName(request.headers.host), token, {
              // Cookie 作用于整站
              path: "/",
              // 禁止 JavaScript 读取
              httpOnly: true,
              // sameSite=lax 缓解 CSRF
              sameSite: "lax",
              // 有效期与会话 TTL 一致
              maxAge: Duration.seconds(ServerAuth.SESSION_TTL_SECONDS),
            }),
          )
        }),
      )
  }),
)
