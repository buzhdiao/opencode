// 导入集成 OAuth 方式注册类型（仅类型）
import type { IntegrationOAuthMethodRegistration } from "@opencode/plugin/effect/integration"
// 导入插件定义辅助函数 define
import { define } from "@opencode/plugin/effect/plugin"
// 导入会话请求类型（仅类型）
import type { SessionRequest } from "@opencode/plugin/effect/session"
// 从 effect 库导入所需原语
import { Deferred, Effect, Option, Schema, Semaphore } from "effect"
// 导入 node:http 的服务器类型（仅类型）
import type { Server } from "node:http"
// 导入应用信息工具（User-Agent）
import { App } from "../../app.js"
// 导入凭据模块
import { Credential } from "../../credential.js"
// 导入集成模块
import { Integration } from "../../integration.js"
// 导入 OAuth 回调页面渲染工具
import { OauthCallbackPage } from "../../oauth/page.js"
import { OauthRedirect } from "../../oauth/redirect.js"
import { Provider } from "../../provider.js"
// 导入会话亲和性工具（提示缓存路由）
import { SessionAffinity } from "../../session/affinity.js"
// 导入内部插件类型声明（仅类型）
import type { PluginInternal } from "../internal.js"
// 导入用户配置的提供商设置读取函数
import { configuredSettings } from "./configured.js"
// 导入“当前生效凭据”读取辅助函数
import { activeCredential } from "./credential-settings.js"
// 导入提供商刷新辅助工具
import { ProviderRefresh } from "./refresh.js"

// OpenAI 官方分配给 OpenCode 的 OAuth 客户端 ID
const clientID = "app_EMoamEEZ73f0CkXaXp7hrann"
// OAuth 签发方地址
const issuer = "https://auth.openai.com"
// 浏览器登录回调的主端口
const callbackPort = 1455
// 主端口被占用时的备用端口
const callbackFallbackPort = 1457
// 端口绑定重试次数
const callbackBindAttempts = 10
// 端口绑定重试间隔（毫秒）
const callbackBindRetryDelay = 200
// 设备码轮询的安全余量（毫秒）
const pollingSafetyMargin = 3000
// ChatGPT 登录使用的 Codex 后端地址
const codexBaseURL = "https://chatgpt.com/backend-api/codex"
// 浏览器登录方式的 ID
const browserMethodID = Integration.MethodID.make("chatgpt-browser")
// 无头设备码登录方式的 ID
const headlessMethodID = Integration.MethodID.make("chatgpt-headless")
// Codex rejects gpt-5.5 and older models, including gpt-5.3-codex-spark, for ChatGPT accounts.
// ChatGPT 账号下 Codex 不允许调用的模型（gpt-5.5 及更早）
const codexDisallowed = new Set(["gpt-5.6"])
// The image models the Codex client generates and edits with on the Codex login.
// Codex 登录下用于生成/编辑图像的模型
const codexImageModels = new Set(["gpt-image-2"])

// PKCE 参数：校验器与挑战值
type Pkce = {
  verifier: string
  challenge: string
}

// 令牌接口响应形状
type TokenResponse = {
  id_token: string
  access_token: string
  refresh_token: string
  expires_in?: number
}

// JWT 声明（claims）的解码 Schema：用于提取 ChatGPT 账号 ID
const Claims = Schema.fromJsonString(
  Schema.Struct({
    chatgpt_account_id: Schema.optional(Schema.String),
    organizations: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String }))),
    "https://api.openai.com/auth": Schema.optional(
      Schema.Struct({ chatgpt_account_id: Schema.optional(Schema.String) }),
    ),
  }),
)
// 声明的解码器
const decodeClaims = Schema.decodeUnknownOption(Claims)

// browser：构造 Codex 浏览器 OAuth 登录方式定义（PKCE + 本地回调服务器）
const browser = (app: App.Info) =>
  ({
    // 所属集成 ID
    integrationID: Integration.ID.make("openai"),
    // 方式定义：浏览器 OAuth（旧版）
    method: {
      id: browserMethodID,
      type: "oauth",
      label: "Codex browser (legacy)",
    },
    // 授权流程
    authorize: () =>
      Effect.gen(function* () {
        // 生成 PKCE 校验器与挑战值
        const pkce = yield* Effect.promise(generatePKCE)
        // 生成随机 state 防 CSRF
        const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer)
        // Deferred 用于等待回调服务器收到授权码
        const code = yield* Deferred.make<string, Error>()
        // Lazy so runtimes without a loopback listener (workerd) never evaluate node:http.
        // 惰性加载 node:http，让不支持环回监听的运行时（workerd）不会触碰它
        const { createServer } = yield* Effect.promise(() => import("node:http"))
        // 创建回调服务器：只接受 /auth/callback 的请求
        const server = createServer((request, response) => {
          // 解析请求 URL
          const url = new URL(request.url ?? "/", "http://localhost")
          // 路径不对返回 404
          if (url.pathname !== "/auth/callback") {
            response.writeHead(404).end("Not found")
            return
          }
          // 读取错误参数与授权码
          const error = url.searchParams.get("error_description") ?? url.searchParams.get("error")
          const value = url.searchParams.get("code")
          if (error) {
            // 授权方报错：后台让 Deferred 失败并回写错误页
            Effect.runFork(Deferred.fail(code, new Error(error)))
            response
              .writeHead(400, { "Content-Type": "text/html" })
              .end(OauthCallbackPage.error(error, { provider: "ChatGPT" }))
            return
          }
          if (!value || url.searchParams.get("state") !== state) {
            // 缺授权码或 state 不匹配
            const message = value ? "Invalid OAuth state" : "Missing authorization code"
            // 后台让 Deferred 失败并回写错误页
            Effect.runFork(Deferred.fail(code, new Error(message)))
            response
              .writeHead(400, { "Content-Type": "text/html" })
              .end(OauthCallbackPage.error(message, { provider: "ChatGPT" }))
            return
          }
          // 校验通过：后台完成 Deferred 并回写成功页
          Effect.runFork(Deferred.succeed(code, value))
          response
            .writeHead(200, { "Content-Type": "text/html" })
            .end(OauthCallbackPage.success({ provider: "ChatGPT" }))
        })
        // 绑定端口（带端口占用重试）
        const port = yield* listen(server)
        // 注册清理器：作用域结束时关闭服务器
        yield* Effect.addFinalizer(() => Effect.sync(() => server.close()))
        // 回调地址使用实际绑定的端口
        const redirect = `http://localhost:${port}/auth/callback`
        // 返回授权结果描述
        return {
          // 自动模式：插件自己等待回调
          mode: "auto" as const,
          // 授权页 URL（含 PKCE 与 state）
          url: authorizeURL(redirect, pkce, state),
          // 给用户看的说明文案
          instructions: "Complete authorization in your browser. This window will close automatically.",
          // 回调处理：等待授权码并换取令牌
          callback: Deferred.await(code).pipe(
            Effect.flatMap((value) => exchange(value, redirect, pkce, app)),
            Effect.map((tokens) => credential(browserMethodID, tokens)),
          ),
          submit: OauthRedirect.submit({ state, callback: code, received: (value) => value }),
        }
      }),
    // 刷新逻辑：用刷新令牌换新令牌
    refresh: (value) => refresh(browserMethodID, value, app),
  }) satisfies IntegrationOAuthMethodRegistration

// listen：优先绑定主端口；被占用时先请求占用者取消，再依次重试主端口与备用端口
function listen(server: Server) {
  return bind(server, callbackPort).pipe(
    // 成功时以主端口为结果
    Effect.as(callbackPort),
    // 主端口被占用时的恢复流程
    Effect.catchIf(addressInUse, () =>
      cancel(callbackPort).pipe(
        // 通知占用进程自行退出（失败也无所谓）
        Effect.ignore,
        // 等待一小段时间让它释放端口
        Effect.andThen(Effect.sleep(callbackBindRetryDelay)),
        // 再次以重试预算绑定主端口
        Effect.andThen(bindWithRetry(server, callbackPort, callbackBindAttempts - 1)),
        // 成功时仍以主端口为结果
        Effect.as(callbackPort),
        // 主端口最终仍被占用则尝试备用端口
        Effect.catchIf(addressInUse, () =>
          bindWithRetry(server, callbackFallbackPort, callbackBindAttempts).pipe(
            // 成功时以备用端口为结果
            Effect.as(callbackFallbackPort),
            // 备用端口也被占用则失败并给出操作指引
            Effect.catchIf(addressInUse, () =>
              Effect.fail(
                new Error(
                  `OpenAI browser login needs local port ${callbackPort} or ${callbackFallbackPort}, but both are already in use. Stop the processes using those ports or choose Codex device code (legacy), then try again.`,
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  )
}

// bindWithRetry：绑定端口，遇到 EADDRINUSE 时按剩余次数延迟重试
function bindWithRetry(server: Server, port: number, attempts: number): Effect.Effect<void, Error> {
  return bind(server, port).pipe(
    Effect.catchIf(
      // 仅在端口被占用且还有重试预算时重试
      (error) => addressInUse(error) && attempts > 1,
      () => Effect.sleep(callbackBindRetryDelay).pipe(Effect.andThen(bindWithRetry(server, port, attempts - 1))),
    ),
  )
}

// bind：把 node:http 的 listen 包装成回调式 Effect
function bind(server: Server, port: number) {
  return Effect.callback<void, Error>((resume) => {
    // 监听一次 error 事件（绑定失败时恢复）
    const onError = (error: Error) => resume(Effect.fail(error))
    server.once("error", onError)
    // 绑定成功：移除错误监听并恢复
    server.listen(port, "localhost", () => {
      server.off("error", onError)
      resume(Effect.void)
    })
  })
}

// cancel：请求占用回调端口的本地进程自行退出（OpenCode 各实例间的协调）
function cancel(port: number) {
  return Effect.tryPromise({
    // 带中断信号与 2 秒超时
    try: (signal) =>
      fetch(`http://localhost:${port}/cancel`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
      }),
    // 失败原因原样保留
    catch: (cause) => cause,
  })
}

// addressInUse：判断错误是否为端口被占用（EADDRINUSE）
function addressInUse(error: Error) {
  return "code" in error && error.code === "EADDRINUSE"
}

// headless：构造 Codex 无头设备码 OAuth 登录方式定义（无本地服务器）
const headless = (app: App.Info) =>
  ({
    // 所属集成 ID
    integrationID: Integration.ID.make("openai"),
    // 方式定义：设备码 OAuth（旧版）
    method: {
      id: headlessMethodID,
      type: "oauth",
      label: "Codex device code (legacy)",
    },
    // 授权流程：申请设备授权并轮询
    authorize: () =>
      Effect.gen(function* () {
        // 申请设备授权 ID 与用户码
        const device = yield* request<{ device_auth_id: string; user_code: string; interval: string }>(
          `${issuer}/api/accounts/deviceauth/usercode`,
          {
            method: "POST",
            headers: headers("application/json", app),
            body: JSON.stringify({ client_id: clientID }),
          },
        )
        // 轮询间隔：解析服务建议值，至少 1 秒
        const interval = Math.max(Number.parseInt(device.interval) || 5, 1) * 1000
        // 返回授权结果描述
        return {
          // 自动模式：插件自己轮询
          mode: "auto" as const,
          // 用户需要访问的设备授权页
          url: `${issuer}/codex/device`,
          // 给用户看的说明文案
          instructions: `Enter code: ${device.user_code}`,
          // 回调处理：轮询直到用户完成授权
          callback: Effect.gen(function* () {
            // 无限轮询直到成功或失败
            while (true) {
              // 查询设备授权令牌（带中断信号）
              const response = yield* Effect.tryPromise({
                try: (signal) =>
                  fetch(`${issuer}/api/accounts/deviceauth/token`, {
                    method: "POST",
                    headers: headers("application/json", app),
                    body: JSON.stringify({ device_auth_id: device.device_auth_id, user_code: device.user_code }),
                    signal,
                  }),
                catch: (cause) => cause,
              })
              if (response.ok) {
                // 授权完成：拿到授权码与校验器
                const data = (yield* Effect.promise(() => response.json())) as {
                  authorization_code: string
                  code_verifier: string
                }
                // 用授权码换取令牌并构造凭据
                return credential(
                  headlessMethodID,
                  yield* exchange(
                    data.authorization_code,
                    `${issuer}/deviceauth/callback`,
                    { verifier: data.code_verifier, challenge: "" },
                    app,
                  ),
                )
              }
              // 403/404 表示用户尚未完成授权，继续轮询；其他状态码直接失败
              if (response.status !== 403 && response.status !== 404) {
                return yield* Effect.fail(new Error(`Device authorization failed: ${response.status}`))
              }
              // 等待建议间隔加安全余量后再轮询
              yield* Effect.sleep(interval + pollingSafetyMargin)
            }
          }),
        }
      }),
    // 刷新逻辑：用刷新令牌换新令牌
    refresh: (value) => refresh(headlessMethodID, value, app),
  }) satisfies IntegrationOAuthMethodRegistration

// 导出 OpenAI 提供商插件：ChatGPT 登录时切换到 Codex 后端并调整目录/请求
export const OpenAIPlugin = define({
  // 插件唯一标识符
  id: "opencode.provider.openai",
  // 插件主流程生成器
  effect: Effect.fn(function* (ctx) {
    // 信号量：串行化“加载 + 重载”组合
    const loading = Semaphore.makeUnsafe(1)
    // 当前生效的 ChatGPT OAuth 凭据（未登录为 undefined）
    let chatgpt: Credential.OAuth | undefined

    // load：读取当前凭据并判断 ChatGPT 登录态/账号是否变化
    const load = Effect.fn("OpenAIPlugin.load")(function* () {
      // 读取 openai 集成当前生效的凭据
      const { credential } = yield* activeCredential(ctx, "openai")
      // 保存上一次的凭据
      const previous = chatgpt
      // 仅 OAuth 且方式为浏览器/无头之一才算 ChatGPT 登录
      chatgpt =
        credential?.type === "oauth" &&
        (credential.methodID === browserMethodID || credential.methodID === headlessMethodID)
          ? credential
          : undefined
      // 登录态从无到有/从有到无，或账号 ID 变化时返回 true
      return (
        (previous === undefined) !== (chatgpt === undefined) ||
        previous?.metadata?.accountID !== chatgpt?.metadata?.accountID
      )
    })

    // 注册两种 OAuth 登录方式
    yield* ctx.integration.transform((editor) => {
      editor.method.update(browser(ctx.app))
      editor.method.update(headless(ctx.app))
    })
    // 启动时先执行一次 load 建立初始登录态
    yield* load()
    // Config applies after provider plugins, so read it here: a custom baseURL may not decode zstd.
    // 配置在 provider 插件之后才生效，所以在这里先读：自定义 baseURL 可能不支持 zstd 解码
    const configured = yield* configuredSettings(Provider.ID.openai)
    // 提供商目录变换：ChatGPT 登录时切到 Codex 后端
    yield* ctx.provider.transform((providers) => {
      // 取 openai 提供商条目
      const item = providers.get(Provider.ID.openai)
      // 不存在则跳过
      if (!item) return
      // 当前账号 ID（未登录为 undefined）
      const account = chatgpt?.metadata?.accountID
      // 更新提供商设置
      providers.update(item.provider.id, (provider) => {
        provider.settings = Provider.mergeOverlay(provider.settings, {
          // 未显式配置传输协议时默认 websocket
          transport: provider.settings?.transport ?? "websocket",
          // 登录后把请求指向 Codex 后端
          ...(chatgpt ? { baseURL: codexBaseURL } : {}),
          // The ChatGPT backend rejects uncompressed bodies over ~1 MiB and decodes zstd.
          // ChatGPT 后端拒绝超过约 1 MiB 的未压缩请求体且支持 zstd，未自定义 baseURL 时启用
          ...(chatgpt && configured?.baseURL === undefined ? { encoding: provider.settings?.encoding ?? "zstd" } : {}),
        })
        // 未登录时不附加头
        if (!chatgpt) return
        // 登录后附加来源标识、beta 特性与账号头
        provider.headers = Provider.mergeHeaders(provider.headers, {
          originator: "opencode",
          "x-codex-beta-features": "remote_compaction_v2",
          ...(typeof account === "string" ? { "chatgpt-account-id": account } : {}),
        })
      })
    })
    // 模型目录变换：ChatGPT 计划下只保留 Codex 可用模型并清零费用
    yield* ctx.model.transform((models) => {
      // 遍历 openai 提供商下所有模型
      for (const model of models.list(Provider.ID.openai)) {
        // ChatGPT-plan tokens only authorize codex-eligible models, and the
        // subscription covers usage, so hide the rest and zero the cost.
        // 逐个更新模型
        models.update(model.providerID, model.id, (draft) => {
          // 未登录不做调整
          if (!chatgpt) return
          // pro 推理模式不被 Codex 支持，直接隐藏
          if (Schema.is(Schema.Struct({ mode: Schema.Literal("pro") }))(draft.body?.reasoning)) {
            draft.enabled = false
            return
          }
          // 模型的真实 API ID
          const apiID = draft.modelID ?? draft.id
          // 图像模型：仅 Codex 认可的图像模型保留且费用清零
          if (draft.type === "image") {
            if (codexImageModels.has(apiID)) draft.cost = []
            else draft.enabled = false
            return
          }
          // 解析 gpt-主版本[.次版本] 前缀
          const match = apiID.match(/^gpt-(\d+)(?:\.(\d+))?/)
          const major = Number(match?.[1])
          const minor = Number(match?.[2] ?? 0)
          // 黑名单、无法识别版本或版本过低（≤5.5）的模型全部隐藏
          if (codexDisallowed.has(apiID) || !match || !(major > 5 || (major === 5 && minor > 5))) {
            draft.enabled = false
            return
          }
          // 保留的模型费用清零（订阅已覆盖用量）
          draft.cost = []
        })
      }
    })
    // 请求钩子：重写 baseURL 并附加缓存路由头
    yield* ctx.session.hook(
      "model.request",
      (evt) =>
        Effect.gen(function* () {
          // 未登录时不干预
          if (!chatgpt) return
          // 请求仍指向官方 API 时改写为 Codex 后端
          if (evt.baseURL && URL.canParse(evt.baseURL) && new URL(evt.baseURL).origin === "https://api.openai.com")
            evt.baseURL = codexBaseURL
          // 读取请求所属会话（可能已被删除）
          const session = yield* ctx.session
            .get({ sessionID: evt.sessionID })
            .pipe(Effect.orElseSucceed(() => undefined))
          // 附加来源标识
          evt.headers.originator = "opencode"
          // ChatGPT routes its prompt cache on this header, so children share the parent's.
          // ChatGPT 按该头路由提示缓存，子会话沿用父会话的亲和 ID
          evt.headers["session-id"] = session ? SessionAffinity.get(session) : evt.sessionID
        }),
      { providerID: Provider.ID.openai },
    )
    // The ChatGPT backend rejects a requested output limit, and OpenAI counts one against rate limits.
    // omitOutputLimit：删除请求中的输出上限（后端拒绝该参数且计入限流）
    const omitOutputLimit = (evt: SessionRequest) =>
      Effect.sync(() => {
        delete evt.options.maxTokens
      })
    // 对 context 与 compaction 两个会话阶段挂载该钩子
    for (const name of ["context", "compaction"] as const)
      yield* ctx.session.hook(name, omitOutputLimit, { providerID: Provider.ID.openai })
    // 凭据切换时重新 load，登录态/账号变化才重载提供商目录
    yield* ProviderRefresh.onSwitch(
      "openai",
      loading.withPermit(ProviderRefresh.reloadIfChanged(load(), ctx.provider.reload())),
    )
  }),
} satisfies PluginInternal.InternalPlugin)

// headers：构造请求头（内容类型 + User-Agent）
function headers(contentType: string, app: App.Info) {
  return { "Content-Type": contentType, "User-Agent": App.useragent(app) }
}

// exchange：用授权码（PKCE）换取令牌
function exchange(code: string, redirect: string, pkce: Pkce, app: App.Info) {
  return request<TokenResponse>(`${issuer}/oauth/token`, {
    method: "POST",
    headers: headers("application/x-www-form-urlencoded", app),
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirect,
      client_id: clientID,
      code_verifier: pkce.verifier,
    }).toString(),
  })
}

// refresh：用刷新令牌换取新令牌，并尽量保留原元数据
function refresh(methodID: Integration.MethodID, value: Pick<Credential.OAuth, "refresh" | "metadata">, app: App.Info) {
  return request<TokenResponse>(`${issuer}/oauth/token`, {
    method: "POST",
    headers: headers("application/x-www-form-urlencoded", app),
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: value.refresh,
      client_id: clientID,
    }).toString(),
  }).pipe(
    Effect.map((tokens) => {
      // 构造新凭据
      const next = credential(methodID, tokens)
      // 新令牌未带账号信息时沿用旧元数据
      return Credential.OAuth.make({ ...next, metadata: next.metadata ?? value.metadata })
    }),
  )
}

// request：发送 fetch 请求并解析 JSON（非 2xx 抛错）
function request<A>(url: string, init: RequestInit) {
  return Effect.tryPromise({
    // 带 signal，Effect 中断时可中止请求
    try: async (signal) => {
      const response = await fetch(url, { ...init, signal })
      // 非 2xx 统一抛错
      if (!response.ok) throw new Error(`Request failed: ${response.status}`)
      return response.json() as Promise<A>
    },
    // 失败原因原样保留
    catch: (cause) => cause,
  })
}

// credential：把令牌响应构造为 OAuth 凭据（记录账号 ID）
function credential(methodID: Integration.MethodID, tokens: TokenResponse) {
  // 从 JWT 中提取 ChatGPT 账号 ID
  const accountID = extractAccountID(tokens)
  return Credential.OAuth.make({
    type: "oauth",
    methodID,
    refresh: tokens.refresh_token,
    access: tokens.access_token,
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    metadata: accountID ? { accountID } : undefined,
  })
}

// generatePKCE：生成 43 字符校验器及其 S256 挑战值
async function generatePKCE(): Promise<Pkce> {
  // PKCE 允许的字符集
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
  // 由 43 个随机字节映射到字符集组成校验器
  const verifier = Array.from(crypto.getRandomValues(new Uint8Array(43)), (byte) => chars[byte % chars.length]).join("")
  // 计算校验器的 SHA-256 并 base64url 编码为挑战值
  const challenge = base64UrlEncode(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))
  return { verifier, challenge }
}

// base64UrlEncode：把二进制缓冲编码为 base64url 字符串
function base64UrlEncode(buffer: ArrayBuffer) {
  return Buffer.from(buffer).toString("base64url")
}

// authorizeURL：拼接 OAuth 授权页 URL（含 PKCE、state 与 Codex 流程参数）
function authorizeURL(redirect: string, pkce: Pkce, state: string) {
  return `${issuer}/oauth/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: clientID,
    redirect_uri: redirect,
    scope: "openid profile email offline_access",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "opencode",
  })}`
}

// extractAccountID：优先从 id_token，其次 access_token 中提取账号 ID
function extractAccountID(tokens: TokenResponse) {
  return claim(tokens.id_token) ?? claim(tokens.access_token)
}

// claim：解码 JWT 载荷并按多个位置查找 ChatGPT 账号 ID
function claim(token: string) {
  // 取 JWT 的第二段（载荷）
  const part = token.split(".")[1]
  // 结构不完整则放弃
  if (!part) return
  // base64url 解码并校验声明结构
  const claims = Option.getOrUndefined(decodeClaims(Buffer.from(part, "base64url").toString()))
  // 解码失败则放弃
  if (!claims) return
  // 依次尝试顶层字段、auth 命名空间字段与第一个组织 ID
  return (
    claims.chatgpt_account_id ??
    claims["https://api.openai.com/auth"]?.chatgpt_account_id ??
    claims.organizations?.[0]?.id
  )
}
