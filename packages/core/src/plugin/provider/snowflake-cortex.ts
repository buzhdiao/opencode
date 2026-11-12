// 导入插件定义辅助函数 define
import { define } from "@opencode/plugin/effect/plugin"
// 导入表单字段构造工具
import { Form } from "@opencode/schema/form"
// 从 effect 库导入所需原语
import { Clock, Deferred, Effect, Option, Schema } from "effect"
// 从 effect/http 导入 HTTP 客户端工具
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
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
// 导入用户配置的提供商设置读取函数
import { configuredSettings } from "./configured.js"
// 导入提供商刷新辅助工具
import { ProviderRefresh } from "./refresh.js"

// 提供商 ID
const providerID = Provider.ID.make("snowflake-cortex")
// 关联的集成 ID（与提供商同名）
const integrationID = Integration.ID.make(providerID)
// 浏览器 OAuth 登录方式的 ID
const methodID = Integration.MethodID.make("browser")
// Snowflake 内置的公共 OAuth 客户端 ID（本地应用流程）
const clientID = "LOCAL_APPLICATION"
// 登录表单：必填的 Snowflake 账号（org-account 形式）
const accountForm = Form.Fields.make([
  {
    type: "string",
    key: "account",
    title: "Snowflake account",
    placeholder: "myorg-myaccount",
    required: true,
  },
])
// 令牌接口响应 Schema：访问令牌、可选刷新令牌与过期秒数
const Token = Schema.Struct({
  access_token: Schema.NonEmptyString,
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
})
// 错误响应的解码 Schema（message/error 均为未知类型）
const decodeError = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ message: Schema.optional(Schema.Unknown), error: Schema.optional(Schema.Unknown) }),
  ),
)

// 导出 Snowflake Cortex 提供商插件：注册 OAuth 登录、注入账号端点并处理会话钩子
export const SnowflakeCortexPlugin = define({
  // 插件唯一标识符
  id: "opencode.provider.snowflake.cortex",
  // 插件主流程生成器
  effect: Effect.fn(function* (ctx) {
    // 获取 HTTP 客户端实例
    const http = yield* HttpClient.HttpClient
    // 获取凭据服务实例
    const credentials = yield* Credential.Service
    // 获取集成服务实例
    const integrations = yield* Integration.Service
    // 读取用户对 snowflake-cortex 的本地配置
    const configured = yield* configuredSettings(providerID)
    // account：当前解析出的账号（可变容器）
    const account = { value: "" }
    // saved：读取当前活跃连接对应的已存凭据
    const saved = Effect.gen(function* () {
      // 获取集成当前活跃连接
      const connection = yield* integrations.connection.active(integrationID)
      // 连接为凭据类型时读取凭据详情，否则视为未登录
      return connection?.type === "credential" ? yield* credentials.get(connection.id) : undefined
    })
    // token：向 Snowflake 请求令牌（授权码或刷新令牌）
    const token = Effect.fn(function* (account: string, form: Record<string, string>) {
      // 缺少账号直接失败
      if (!account) return yield* Effect.fail(new Error("Snowflake account is required"))
      // 向该账号的 OAuth 令牌端点发起 POST
      const response = yield* http.execute(
        HttpClientRequest.post(`${issuer(account)}/oauth/token-request`).pipe(
          HttpClientRequest.setHeaders({
            Accept: "application/json",
            "User-Agent": App.useragent(ctx.app),
            // Same built-in OAuth client and Basic header as V1; this is not a user password.
            // 与 V1 相同的内置 OAuth 客户端与 Basic 头；这不是用户密码
            Authorization: `Basic ${Buffer.from(`${clientID}:${clientID}`).toString("base64")}`,
          }),
          // 携带表单参数与 client_id
          HttpClientRequest.bodyUrlParams({ ...form, client_id: clientID }),
        ),
      )
      // 非 2xx 响应直接失败并附上响应文本
      if (response.status < 200 || response.status >= 300)
        return yield* Effect.fail(
          new Error(`Snowflake token request failed (${response.status}): ${yield* response.text}`),
        )
      // 按 Token Schema 解码响应
      const tokens = yield* HttpClientResponse.schemaBodyJson(Token)(response)
      // 刷新令牌：优先响应体里的，回退到表单里带来的旧值
      const refresh = tokens.refresh_token || form.refresh_token
      // 没有刷新令牌则无法维持登录
      if (!refresh) return yield* Effect.fail(new Error("Snowflake token response did not include refresh_token"))
      // 构造 OAuth 凭据（默认 600 秒过期，记录账号到元数据）
      return Credential.OAuth.make({
        type: "oauth",
        methodID,
        access: tokens.access_token,
        refresh,
        expires: (yield* Clock.currentTimeMillis) + (tokens.expires_in ?? 600) * 1000,
        metadata: { account },
      })
    })
    // refresh：用已存凭据的刷新令牌换取新令牌
    const refresh = (value: Credential.OAuth) =>
      token(normalizeAccount(value.metadata?.account), { grant_type: "refresh_token", refresh_token: value.refresh })

    // 注册集成登录方式：粘贴令牌、环境变量与浏览器 OAuth 三种
    yield* ctx.integration.transform((editor) => {
      // 方式一：手动粘贴 PAT 或 bearer 令牌
      editor.method.update({
        integrationID,
        method: { type: "key", label: "Paste PAT or bearer token", form: accountForm },
      })
      // SNOWFLAKE_ACCOUNT configures the endpoint; it is not a token.
      // 方式二：环境变量令牌；SNOWFLAKE_ACCOUNT 只决定端点，本身不是令牌
      editor.method.update({
        integrationID,
        method: { type: "env", names: ["SNOWFLAKE_CORTEX_TOKEN", "SNOWFLAKE_CORTEX_PAT"] },
      })
      // 方式三：浏览器 OAuth（外部浏览器流程）
      editor.method.update({
        integrationID,
        method: {
          id: methodID,
          type: "oauth",
          label: "Login with Snowflake (External Browser)",
          // 表单：账号 + 可选角色
          form: [...accountForm, { type: "string", key: "role", title: "Snowflake role (optional)" }],
        },
        // An environment-token override must work even when the saved OAuth login has expired.
        // 环境变量令牌生效时跳过刷新，保证保存的 OAuth 过期后仍可用
        refresh: (value) => (envToken() ? Effect.succeed(value) : refresh(value)),
        // 登录条目显示账号名
        label: (value) => normalizeAccount(value.metadata?.account),
        // 授权流程：PKCE + 本地回调服务器
        authorize: (answer) =>
          Effect.gen(function* () {
            // 规范化用户填写的账号
            const account = normalizeAccount(answer.account)
            // 缺少账号直接失败
            if (!account) return yield* Effect.fail(new Error("Snowflake account is required"))
            // 可选角色：字符串才收，并去除首尾空白
            const role = typeof answer.role === "string" ? answer.role.trim() : ""
            // 生成 PKCE 校验器（48 随机字节）
            const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString("base64url")
            // 计算对应的 SHA-256 挑战值
            const challenge = Buffer.from(
              yield* Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
            ).toString("base64url")
            // 生成随机 state 防 CSRF
            const state = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
            // Deferred 用于等待回调服务器收到授权码
            const code = yield* Deferred.make<string, Error>()
            // 惰性加载 node:http
            const { createServer } = yield* Effect.promise(() => import("node:http"))
            // 惰性加载 node:events
            const { EventEmitter } = yield* Effect.promise(() => import("node:events"))
            // 创建回调服务器：只接受根路径请求
            const server = createServer((request, response) => {
              // 解析请求 URL
              const url = new URL(request.url ?? "/", "http://127.0.0.1")
              // 其他路径返回 404
              if (url.pathname !== "/") {
                response.writeHead(404).end()
                return
              }
              // 取授权码
              const value = url.searchParams.get("code")
              // 依次校验 state、错误参数与授权码缺失
              const error =
                url.searchParams.get("state") !== state
                  ? "Invalid OAuth state"
                  : url.searchParams.get("error_description") ||
                    url.searchParams.get("error") ||
                    (!value ? "Missing authorization code" : undefined)
              // 后台完成/失败 Deferred（不阻塞响应写出）
              Effect.runFork(error ? Deferred.fail(code, new Error(error)) : Deferred.succeed(code, value ?? ""))
              // 向浏览器回写成功/失败页面
              response
                .writeHead(error ? 400 : 200, { "Content-Type": "text/html" })
                .end(
                  error
                    ? OauthCallbackPage.error(error, { provider: "Snowflake" })
                    : OauthCallbackPage.success({ provider: "Snowflake" }),
                )
            })
            // 注册清理器：作用域结束时关闭服务器
            yield* Effect.addFinalizer(() => Effect.sync(() => server.close()))
            // 在随机端口监听并等待 listening 事件
            yield* Effect.tryPromise(() => EventEmitter.once(server.listen(0, "127.0.0.1"), "listening"))
            // 读取实际监听地址
            const address = server.address()
            // 地址异常则失败
            if (!address || typeof address === "string")
              return yield* Effect.fail(new Error("Missing OAuth callback port"))
            // 回调地址使用动态端口
            const redirect = `http://127.0.0.1:${address.port}/`
            // 返回授权结果描述
            return {
              // 自动模式：插件自己等待回调
              mode: "auto" as const,
              // 拼接 Snowflake 授权页 URL；scope 按角色构造
              url: `${issuer(account)}/oauth/authorize?${new URLSearchParams({
                client_id: clientID,
                response_type: "code",
                redirect_uri: redirect,
                state,
                scope: !role
                  ? "refresh_token"
                  : /^[-_A-Za-z0-9]+$/.test(role)
                    ? `refresh_token session:role:${role}`
                    : `refresh_token session:role-encoded:${encodeURIComponent(role)}`,
                code_challenge: challenge,
                code_challenge_method: "S256",
              }).toString()}`,
              // 给用户看的说明文案
              instructions: "Complete Snowflake sign-in in your browser.",
              // 回调处理：用授权码换取令牌
              callback: Effect.gen(function* () {
                return yield* token(account, {
                  grant_type: "authorization_code",
                  code: yield* Deferred.await(code),
                  redirect_uri: redirect,
                  code_verifier: verifier,
                })
              }),
              submit: OauthRedirect.submit({ state, callback: code, received: (value) => value }),
            }
          }),
      })
    })

    // load：重新解析当前账号（环境变量 > 已存凭据 > 本地配置），返回是否变化
    const load = Effect.gen(function* () {
      // 读取已存凭据值
      const value = (yield* saved)?.value
      // 保存旧账号用于比较
      const previous = account.value
      // 按优先级解析账号并规范化
      account.value = normalizeAccount(process.env.SNOWFLAKE_ACCOUNT ?? value?.metadata?.account ?? configured?.account)
      // 返回账号是否发生变化
      return account.value !== previous
    })
    // 启动时先执行一次 load 建立初始账号
    yield* load
    // 提供商目录变换：展开端点模板并注入令牌
    yield* ctx.provider.transform((providers) => {
      // 取 snowflake-cortex 条目
      const item = providers.get(providerID)
      // 不存在则跳过
      if (!item) return
      // 合并目录设置与用户配置
      const settings = { ...item.provider.settings, ...configured }
      // 更新提供商设置
      providers.update(providerID, (provider) => {
        provider.settings = {
          // 保留合并后的设置
          ...settings,
          // 把 ${SNOWFLAKE_ACCOUNT} 占位符替换为真实账号
          baseURL: endpoint(settings.baseURL, account.value),
          // 配置了 token 字符串时作为 apiKey 注入
          ...(typeof settings.token === "string" ? { apiKey: settings.token } : {}),
        }
      })
    })
    // 模型目录变换：调整兼容性标记并展开模型级端点
    yield* ctx.model.transform((models) => {
      // 遍历该提供商下所有模型
      for (const item of models.list(providerID)) {
        // 逐个更新模型
        models.update(providerID, item.id, (model) => {
          // Cortex 要求输出上限字段用 max_completion_tokens
          model.compatibility = { maxTokensField: "max_completion_tokens", ...model.compatibility }
          // Cortex Chat Completions caches Claude only through explicit `cache_control` breakpoints.
          // Claude 模型需要显式 cache_control 断点缓存格式
          if ((model.modelID ?? model.id).includes("claude"))
            model.compatibility = { cacheFormat: "anthropic", ...model.compatibility }
          // 模型级 baseURL 同样替换账号占位符
          if (model.settings?.baseURL !== undefined)
            model.settings.baseURL = endpoint(model.settings.baseURL, account.value)
        })
      }
    })
    // 凭据切换时重新 load，账号变化才重载提供商目录
    yield* ProviderRefresh.onSwitch(integrationID, ProviderRefresh.reloadIfChanged(load, ctx.provider.reload()))
    // 请求钩子：为发往 Cortex 的请求附加环境变量令牌与 User-Agent
    yield* ctx.session.hook(
      "http.request",
      (event) =>
        Effect.sync(() => {
          // Model resolution already supplies and refreshes stored credentials on each attempt.
          // 模型解析阶段已负责提供与刷新存储凭据，这里只处理环境变量令牌
          const token = envToken()
          // 存在环境令牌时覆盖授权头
          if (token) event.request.headers.set("authorization", `Bearer ${token}`)
          // 附加 OpenCode 的 User-Agent
          event.request.headers.set("user-agent", App.useragent(ctx.app))
        }),
      { providerID },
    )
    // 响应钩子：把 Cortex 的“会话已完成”400 错误改写为正常结束的 SSE 流
    yield* ctx.session.hook(
      "http.response",
      Effect.fn(function* (event) {
        // 只关心 400 响应
        if (event.response.status !== 400) return
        // 克隆响应读取文本并尝试解码错误结构
        const error = Option.getOrUndefined(decodeError(yield* Effect.promise(() => event.response.clone().text())))
        // oxlint-disable-next-line typescript-eslint/no-base-to-string -- Preserve V1's error-body coercion.
        // 与 V1 一致地把错误体强制转为字符串
        const message = String(error?.message || error?.error || "")
        // 不是“conversation complete”错误则放行
        if (!message.toLowerCase().includes("conversation complete")) return
        // 改写为一条正常 stop 的 SSE 响应
        event.response = new Response(
          'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" } },
        )
      }),
      { providerID },
    )
    // 重试钩子：第二次尝试遇 401 时静默刷新 OAuth 凭据并立即重试
    yield* ctx.session.hook(
      "retry",
      Effect.fn(function* (event) {
        // 仅处理第二次尝试的 401，且环境令牌未接管时
        if (event.error.status !== 401 || event.attempt !== 2 || envToken()) return
        // 读取当前已存凭据
        const current = yield* saved
        // 只处理本插件的 OAuth 凭据
        if (current?.value.type !== "oauth" || current.value.methodID !== methodID) return
        // 刷新令牌并写回凭据存储（刷新失败属于致命错误）
        yield* credentials.update(current.id, { value: yield* refresh(current.value).pipe(Effect.orDie) })
        // 决定立即重试
        event.decision = { retry: true, delay: 0 }
      }),
      { providerID },
    )
  }),
})

// normalizeAccount：把各种形式的账号输入规范化为 org-account 裸值
function normalizeAccount(value: unknown) {
  // 非字符串视为未填写
  if (typeof value !== "string") return ""
  // 去空白、去掉协议前缀、尾部斜杠与域名后缀
  return value
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .replace(/\.snowflakecomputing\.com$/i, "")
}

// issuer：由账号拼出 Snowflake 实例的基址
function issuer(account: string) {
  return `https://${account}.snowflakecomputing.com`
}

// endpoint：解析 baseURL，默认走 Cortex v2 端点，并把账号占位符替换为真实值
function endpoint(value: unknown, account: string) {
  // 配置了字符串就用它，否则用带占位符的默认端点
  const baseURL = typeof value === "string" ? value : `${issuer("${SNOWFLAKE_ACCOUNT}")}/api/v2/cortex/v1`
  // 有账号才替换占位符，没有则保留模板
  return account ? baseURL.replaceAll("${SNOWFLAKE_ACCOUNT}", account) : baseURL
}

// envToken：读取环境变量中的 Cortex 令牌（两个变量名任一）
function envToken() {
  return process.env.SNOWFLAKE_CORTEX_TOKEN ?? process.env.SNOWFLAKE_CORTEX_PAT
}
