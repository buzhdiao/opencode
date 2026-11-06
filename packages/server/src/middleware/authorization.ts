// 引入服务端认证（auth）模块：提供凭据校验与会话 Cookie 能力
import { ServerAuth } from "../auth"
// 引入协议包定义的"未授权"错误类型
import { UnauthorizedError } from "@opencode/protocol/errors"
// 引入 Effect 平台的 Authorization 中间件接口（Context Tag 定义）
import { Authorization } from "@opencode/protocol/middleware/authorization"
// 原样 re-export 该 Authorization 接口，供其他模块统一从本文件导入
export { Authorization } from "@opencode/protocol/middleware/authorization"
// 引入 PTY（伪终端）连接路径与票据（ticket）查询参数常量
import { PTY_CONNECT_PATH, PTY_CONNECT_TICKET_QUERY } from "@opencode/protocol/groups/pty"
// 引入持久化 PTY 连接路径常量
import { PERSISTENT_PTY_CONNECT_PATH } from "@opencode/protocol/groups/persistent-pty"
// 引入 MCP 客户端连接路径常量
import { MCP_CLIENT_PATH } from "@opencode/protocol/groups/mcp"
// 引入服务器配对（pairing）连接路径常量
import { PAIRING_CONNECT_PATH } from "@opencode/protocol/groups/server"
// 引入 Effect 核心：Effect 组合子、Layer（依赖注入层）、Redacted（敏感值脱敏包装）
import { Effect, Layer, Redacted } from "effect"
// 引入 Effect 的 Base64 编解码工具
import { Base64 } from "effect/encoding"
// 引入 Effect HTTP 能力：HttpEffect（响应预处理）、HttpRouter（路由上下文）、请求与响应类型
import { HttpEffect, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"

// URL 查询参数名：通过 ?auth_token=... 携带认证令牌（浏览器在 WebSocket 升级时无法设请求头）
const AUTH_TOKEN_QUERY = "auth_token"
// Basic 认证质询（challenge）头的取值，浏览器收到后会弹出原生的用户名/密码输入框
const WWW_AUTHENTICATE = 'Basic realm="Secure Area"'

// 构造一份空凭据（用户名与密码均为空字符串）
function emptyCredential() {
  // 密码用 Redacted.make 包装成脱敏值，避免在日志或错误信息中泄露明文
  return { username: "", password: Redacted.make("") }
}

// 解析 Basic 凭据：对 base64 编码的 "用户名:密码" 字符串解码并拆分
function decodeCredential(input: string) {
  // Base64.decodeString 返回 Result，fromResult 把解码失败转换为 Effect 失败分支
  return Effect.fromResult(Base64.decodeString(input)).pipe(
    // 同时匹配成功与失败两种结果
    Effect.match({
      // 解码失败时视作未提供有效认证，返回空凭据
      onFailure: emptyCredential,
      // 解码成功后按第一个冒号拆出用户名与密码
      onSuccess: (header) => {
        // 查找分隔用户名与密码的冒号位置
        const separator = header.indexOf(":")
        // 没有冒号说明格式非法，返回空凭据
        if (separator === -1) return emptyCredential()
        // 冒号前为用户名，冒号后为密码（同样用 Redacted 脱敏包装）
        return { username: header.slice(0, separator), password: Redacted.make(header.slice(separator + 1)) }
      },
    }),
  )
}

// 从请求中提取凭据：优先取 URL 查询参数中的令牌，其次取 Authorization: Basic 请求头
function credentialFromRequest(request: HttpServerRequest.HttpServerRequest) {
  // request.url 是相对路径，用占位 base 解析成完整 URL 以便读取查询参数
  const url = new URL(request.url, "http://localhost")
  // 读取 auth_token 查询参数
  const token = url.searchParams.get(AUTH_TOKEN_QUERY)
  // 存在令牌则按 Basic 凭据格式解码
  if (token) return decodeCredential(token)
  // 匹配 Authorization 头中的 "Basic <base64>"（大小写不敏感）；正则字面量内部不可插入注释
  const match = /^Basic\s+(.+)$/i.exec(request.headers.authorization ?? "")
  // 匹配成功则解码其中的 base64 部分
  if (match) return decodeCredential(match[1])
  // 两者都没有时返回空凭据（用 Effect.succeed 包装为成功值）
  return Effect.succeed(emptyCredential())
}

// 未授权时返回给客户端的固定提示文案
const UNAUTHORIZED_MESSAGE = "Authentication required"

// 浏览器即使在 fetch 请求中也会为 Basic 质询弹出原生凭据输入框，导致 Web 应用
// 卡住而无法展示自己的登录界面。因此只对非浏览器客户端与页面导航请求返回质询。
// Browsers show a native credentials prompt for a Basic challenge even on fetch, which would stall the web app
// before it can show its own sign-in screen. Only non-browser clients and page navigations get the challenge.
// 判断是否应向该请求发起 Basic 质询
function challengeRequest(request: HttpServerRequest.HttpServerRequest) {
  // 读取 sec-fetch-mode 头（浏览器自动携带，标识请求的发起模式）
  const mode = request.headers["sec-fetch-mode"]
  // 头缺失（非浏览器客户端）或为 navigate（页面导航）时返回 true，允许质询
  return mode === undefined || mode === "navigate"
}

// 与 Authorization 中间件编码出的错误保持一致，用于在 HttpApi 尚未运行前就被拒绝的请求。
// Matches what the Authorization middleware encodes, for requests rejected before the HttpApi runs.
// 构造 401 未授权响应（响应体结构与协议中的 UnauthorizedError 编码一致）
export function unauthorizedResponse(request: HttpServerRequest.HttpServerRequest) {
  // 返回 JSON 响应，_tag 标记错误类型便于客户端按协议解析
  return HttpServerResponse.jsonUnsafe(
    // 响应体：错误标签 + 提示文案
    { _tag: "UnauthorizedError", message: UNAUTHORIZED_MESSAGE },
    // 状态码 401；若应向该请求发起质询，则附带 WWW-Authenticate 头
    { status: 401, headers: challengeRequest(request) ? { "www-authenticate": WWW_AUTHENTICATE } : undefined },
  )
}

// 判断请求是否已通过认证：先校验凭据（密码/令牌），不通过再退回校验会话 Cookie
export function authorizedRequest(request: HttpServerRequest.HttpServerRequest, config: ServerAuth.Info) {
  // 提取请求凭据后交给 ServerAuth.authorized 校验
  return credentialFromRequest(request).pipe(
    // 凭据校验通过则返回 true，否则再用会话 Cookie 验一次
    Effect.map((credential) => ServerAuth.authorized(credential, config) || authorizedSessionCookie(request, config)),
  )
}

// 基于会话 Cookie 的认证校验
function authorizedSessionCookie(request: HttpServerRequest.HttpServerRequest, config: ServerAuth.Info) {
  // 按请求 Host 取对应名称的会话 Cookie 值
  const token = request.cookies[ServerAuth.sessionCookieName(request.headers.host)]
  // 没有 Cookie 直接判定未认证
  if (!token) return false
  // 同站其他端口仍会带上此 Cookie，因此仅允许同源请求使用。
  // Same-site pages on other ports still send this cookie, so only same-origin requests may use it.
  // 读取请求的 Origin 头
  const origin = request.headers.origin
  // 存在 Origin 且其主机与请求 Host 不一致时拒绝（防止 Cookie 被跨站使用）
  if (origin !== undefined && URL.parse(origin)?.host !== request.headers.host) return false
  // 校验会话令牌是否有效
  return ServerAuth.verifySession(token, config)
}

// 构建 Authorization 中间件的 Layer（依赖注入层）
export const authorizationLayer = Layer.effect(
  // 将实现绑定到 Authorization 接口 Tag
  Authorization,
  // 构建服务实现：从环境读取认证配置
  Effect.gen(function* () {
    // 取出服务端认证配置（密码等）
    const config = yield* ServerAuth.Config
    // 未要求认证时，中间件退化为恒等函数：直接放行原 effect
    if (!ServerAuth.required(config)) return Authorization.of((effect) => effect)
    // 要求认证时返回包装函数：校验通过才执行被包裹的 effect
    return Authorization.of((effect) =>
      Effect.gen(function* () {
        // 获取当前 HTTP 请求对象
        const request = yield* HttpServerRequest.HttpServerRequest
        // 获取 Effect 已匹配出的路由上下文（避免自行按路径判断与实际分发产生分歧）
        const route = yield* HttpRouter.RouteContext
        // 带票据的 PTY 与客户端 MCP 连接（浏览器在 WebSocket 升级时无法设置请求头）以及配对链接
        // 在此跳过凭据校验，由各自的处理器消费并校验票据或配对码；必须使用 Effect 选出的路由，
        // 以保证鉴权与分发不会对请求路径产生不同判断。
        // Ticketed PTY and client MCP connects (browsers cannot set headers on WebSocket upgrades) and pairing links
        // skip credential checks here; their handlers consume and validate the ticket or code. Use the
        // route selected by Effect so authorization and dispatch cannot disagree about the request path.
        const url = new URL(request.url, "http://localhost")
        // 命中三类带票据连接路径且携带票据查询参数，或命中配对连接路径时豁免
        if (
          ((route.route.path === PTY_CONNECT_PATH ||
            route.route.path === PERSISTENT_PTY_CONNECT_PATH ||
            route.route.path === MCP_CLIENT_PATH) &&
            !!url.searchParams.get(PTY_CONNECT_TICKET_QUERY)) ||
          route.route.path === PAIRING_CONNECT_PATH
        )
          // 票据/配对豁免：直接执行原 effect，安全校验由处理器完成
          return yield* effect
        // 凭据或会话 Cookie 校验通过：放行
        if (yield* authorizedRequest(request, config)) return yield* effect
        // 应对浏览器类请求发起质询时，注册响应预处理：为最终响应追加 WWW-Authenticate 头
        if (challengeRequest(request))
          yield* HttpEffect.appendPreResponseHandler((_request, response) =>
            // 在响应上设置 Basic 质询头
            Effect.succeed(HttpServerResponse.setHeader(response, "www-authenticate", WWW_AUTHENTICATE)),
          )
        // 校验失败：以未授权错误终止请求
        return yield* new UnauthorizedError({ message: UNAUTHORIZED_MESSAGE })
      }),
    )
  }),
)
