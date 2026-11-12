// 导入插件定义辅助函数 define
import { define } from "@opencode/plugin/effect/plugin"
// 从 effect 库导入时钟、Deferred、Effect、Option、Schema
import { Clock, Deferred, Effect, Option, Schema } from "effect"
// 从 effect/http 导入 HTTP 客户端工具
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
// 导入 node:http 的响应类型（仅类型）
import type { ServerResponse } from "node:http"
// 导入凭据模块
import { Credential } from "../../credential.js"
// 导入集成模块
import { Integration } from "../../integration.js"
// 导入 OAuth 回调页面渲染工具
import { OauthCallbackPage } from "../../oauth/page.js"
import { OauthRedirect } from "../../oauth/redirect.js"

// Poe 集成的 ID
const integrationID = Integration.ID.make("poe")
// 浏览器 OAuth 登录方式的 ID
const methodID = Integration.MethodID.make("browser")
// Poe 官方分配给 OpenCode 的 OAuth 客户端 ID
const clientID = "client_728290227fc048cc9262091a1ea197ea"
// OAuth 签发方地址
const issuer = "https://poe.com"
// 过期时间上限（约 100 天），防止异常巨大的过期值
const maxExpiry = 8_640_000_000_000_000
// 令牌接口响应 Schema：API key（非空、无空白）与可选的过期秒数
const Token = Schema.Struct({
  api_key: Schema.Trim.check(Schema.isNonEmpty(), Schema.isPattern(/^\S+$/)),
  api_key_expires_in: Schema.optional(Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))),
})
// 错误响应的解码 Schema（error 与 error_description 均可选）
const decodeError = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ error: Schema.optional(Schema.String), error_description: Schema.optional(Schema.String) }),
  ),
)

// 导出 Poe 提供商插件：注册浏览器 OAuth 登录方式（PKCE + 本地回调服务器）
export const PoePlugin = define({
  // 插件唯一标识符
  id: "opencode.provider.poe",
  // 插件主流程生成器
  effect: Effect.fn(function* (ctx) {
    // 获取 HTTP 客户端实例
    const http = yield* HttpClient.HttpClient
    // 注册集成登录方式
    yield* ctx.integration.transform((editor) => {
      // 更新/创建 Poe 的 OAuth 方式定义
      editor.method.update({
        // 所属集成
        integrationID,
        // 方式定义：浏览器 OAuth
        method: { id: methodID, type: "oauth", label: "Login with Poe (browser)" },
        // Poe-issued API keys remain usable until expiry, then require another login.
        // 刷新逻辑：Poe 签发的 key 在到期前一直可用，到期后只能重新登录（不支持静默刷新）
        refresh: (value) =>
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((now) =>
              value.expires > now
                ? Effect.succeed(value)
                : Effect.fail(new Error("Poe API key expired. Log in with Poe again.")),
            ),
          ),
        // 授权流程：启动本地回调服务器并跳转浏览器
        authorize: () =>
          Effect.gen(function* () {
            // 生成 PKCE 校验器（32 随机字节的 base64url）
            const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
            // 由校验器计算 SHA-256 挑战值
            const challenge = Buffer.from(
              yield* Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
            ).toString("base64url")
            // 生成随机 state 防 CSRF
            const state = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
            // `response` is the browser's pending callback request; a pasted redirect has none.
            const callback = yield* Deferred.make<{ code: string; response?: ServerResponse }, Error>()
            const { createServer } = yield* Effect.promise(() => import("node:http"))
            // 惰性加载 node:events（用于等待 listening 事件）
            const { EventEmitter } = yield* Effect.promise(() => import("node:events"))
            // 创建回调服务器：只接受 /callback 的 GET 请求
            const server = createServer((request, response) => {
              // 解析请求 URL
              const url = new URL(request.url ?? "/", "http://127.0.0.1")
              // 非 GET 或路径不对返回 404
              if (request.method !== "GET" || url.pathname !== "/callback") {
                response.writeHead(404).end()
                return
              }
              // 校验 state/error/code，得到错误信息（若有）
              const error = callbackError(url.searchParams, state)
              if (error) {
                // 出错时渲染错误页并让 Deferred 失败
                response
                  .writeHead(400, { "Content-Type": "text/html" })
                  .end(OauthCallbackPage.error(error, { provider: "Poe" }))
                // 同步地让 callback Deferred 失败
                Effect.runSync(Deferred.fail(callback, new Error(error)))
                return
              }
              // 成功时完成 Deferred；若已被占用则返回 409
              if (!Effect.runSync(Deferred.succeed(callback, { code: url.searchParams.get("code") ?? "", response })))
                response.writeHead(409).end("OAuth callback already received")
            })
            // 注册清理器：作用域结束时关闭服务器及其连接
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                server.close()
                server.closeAllConnections()
              }),
            )
            // 在随机端口上监听并等待 listening 事件
            yield* Effect.tryPromise(() => EventEmitter.once(server.listen(0, "127.0.0.1"), "listening"))
            // 读取实际监听地址
            const address = server.address()
            // 地址异常则失败
            if (!address || typeof address === "string")
              return yield* Effect.fail(new Error("Missing OAuth callback port"))
            // 回调地址使用动态端口
            const redirect = `http://127.0.0.1:${address.port}/callback`
            // 返回授权结果描述
            return {
              // 自动模式：插件自己等待回调
              mode: "auto" as const,
              // 拼接 Poe 的授权页 URL（含 PKCE 与 state）
              url: `${issuer}/oauth/authorize?${new URLSearchParams({
                response_type: "code",
                client_id: clientID,
                redirect_uri: redirect,
                scope: "apikey:create",
                code_challenge: challenge,
                code_challenge_method: "S256",
                state,
              }).toString()}`,
              // 给用户看的说明文案
              instructions: "Complete authorization in your browser. This window will close automatically.",
              // 回调处理：等待授权码并换取令牌
              callback: Effect.gen(function* () {
                // 等待回调服务器收到授权码
                const request = yield* Deferred.await(callback)
                // respond：向浏览器回写成功/失败页面
                const respond = (error?: string) =>
                  Effect.sync(() =>
                    request.response
                      ?.writeHead(error ? 400 : 200, { "Content-Type": "text/html" })
                      .end(
                        error
                          ? OauthCallbackPage.error(error, { provider: "Poe" })
                          : OauthCallbackPage.success({ provider: "Poe" }),
                      ),
                  )
                // 用授权码换取 Poe 令牌；无论成败都回写页面
                return yield* exchangeCode(http, { code: request.code, redirect, verifier }).pipe(
                  Effect.tap(() => respond()),
                  Effect.tapError((error) => respond(error.message)),
                  // Bun's server.closeAllConnections() leaves an unanswered callback response pending.
                  Effect.onInterrupt(() => Effect.sync(() => request.response?.destroy())),
                )
              }),
              // Not `OauthRedirect.submit`: a pasted redirect also has to pass Poe's issuer check.
              submit: (pasted: string) =>
                OauthRedirect.pasted(pasted, state).pipe(
                  Effect.flatMap((result) => {
                    const error = callbackError(result.params, state)
                    return error
                      ? Deferred.fail(callback, new Error(error))
                      : Deferred.succeed(callback, { code: result.params.get("code") ?? "" })
                  }),
                  Effect.asVoid,
                ),
            }
          }),
      })
    })
  }),
})

// callbackError：校验回调参数，返回错误文案（无错误时返回 undefined）
function callbackError(params: URLSearchParams, state: string) {
  // state 不匹配视为 CSRF 风险
  if (params.get("state") !== state) return "Invalid OAuth state"
  // Poe's client pins this issuer but does not require iss; its documented callbacks may omit it.
  // Poe 客户端固定签发方但不强制要求 iss；文档中的回调可能省略该参数
  if (params.has("iss") && params.get("iss") !== issuer) return "Invalid OAuth issuer"
  // 授权方返回错误时给出描述
  if (params.has("error")) {
    // 优先取详细描述，回退到错误码
    const detail = params.get("error_description") || params.get("error") || "Authorization denied"
    // 描述中意外包含 state 时做脱敏处理
    return detail.includes(state) ? "Poe authorization failed" : detail
  }
  // 没有错误时必须携带非空授权码
  return params.get("code")?.trim() ? undefined : "Missing authorization code"
}

// exchangeCode：用授权码换取 Poe 的 API key 令牌
function exchangeCode(http: HttpClient.HttpClient, input: { code: string; redirect: string; verifier: string }) {
  return Effect.gen(function* () {
    // 向 Poe 令牌端点发起 POST（表单参数）
    const response = yield* http
      .execute(
        HttpClientRequest.post("https://api.poe.com/token").pipe(
          HttpClientRequest.bodyUrlParams({
            grant_type: "authorization_code",
            client_id: clientID,
            code: input.code,
            redirect_uri: input.redirect,
            code_verifier: input.verifier,
          }),
        ),
      )
      // 网络层错误统一转换为可读消息
      .pipe(Effect.mapError(() => new Error("Poe token exchange request failed")))
    // 非 2xx 响应时解析错误体并失败
    if (response.status < 200 || response.status >= 300) {
      // 读取响应文本并尝试解码错误结构
      const error = Option.getOrUndefined(decodeError(yield* response.text.pipe(Effect.orElseSucceed(() => ""))))
      // 优先详细描述，回退错误码
      const detail = error?.error_description || error?.error
      // 失败：细节中不含机密时展示细节，否则只给状态码
      return yield* Effect.fail(
        new Error(
          detail && ![input.code, input.verifier].some((secret) => detail.includes(secret))
            ? `Poe token exchange failed: ${detail}`
            : `Poe token exchange failed (${response.status})`,
        ),
      )
    }
    // 按 Token Schema 解码成功响应
    const token = yield* HttpClientResponse.schemaBodyJson(Token)(response).pipe(
      Effect.mapError(() => new Error("Invalid Poe token response")),
    )
    // 计算过期时间戳：未给时长时用上限值，否则当前时间加秒数
    const expires =
      token.api_key_expires_in == null ? maxExpiry : (yield* Clock.currentTimeMillis) + token.api_key_expires_in * 1000
    // 过期时间必须为安全整数且不超过上限
    if (!Number.isSafeInteger(expires) || expires > maxExpiry)
      return yield* Effect.fail(new Error("Invalid Poe API key expiry"))
    // 构造 OAuth 凭据（Poe 的 key 无刷新令牌，refresh 留空）
    return Credential.OAuth.make({ type: "oauth", methodID, access: token.api_key, refresh: "", expires })
  })
}
