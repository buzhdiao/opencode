// 导入集成 OAuth 方法注册类型
import type { IntegrationOAuthMethodRegistration } from "@opencode/plugin/effect/integration"
// 导入会话请求类型（请求种类）与会话标题类型
import type { SessionRequestKind, SessionTitle } from "@opencode/plugin/effect/session"
// 导入“是否为普通对象”的判断工具
import { isRecord } from "@opencode/util/record"
import { Clock, Effect, Option, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { IntegrationConnection } from "../../integration/connection.js"
// 导入凭据模块
import { Credential } from "../../credential.js"
// 导入 Copilot 模型列表加载/派生工具
import { CopilotModels } from "../../github-copilot/models.js"
// 导入应用信息（User-Agent 用）
import { App } from "../../app.js"
// 导入集成模块
import { Integration } from "../../integration.js"
// 导入模型模块
import { Model } from "../../model.js"
// 导入代理（Agent）模块
import { Agent } from "../../agent.js"
// 导入插件定义工具 define
import { define } from "@opencode/plugin/effect/plugin"
// 导入 Provider 模块
import { Provider } from "../../provider.js"
// 导入会话亲和性工具（交互 ID）
import { SessionAffinity } from "../../session/affinity.js"
import type { Session } from "@opencode/schema/session"
import { SharedCache } from "../../shared-cache.js"
import { activeCredential, credentialSettings } from "./credential-settings.js"
import { ProviderRefresh } from "./refresh.js"
// 导入插件内部类型
import type { PluginInternal } from "../internal.js"

// OAuth 应用的 client ID
const clientID = "Ov23li8tweQw6odWQebz"
// Copilot API 的版本头
const apiVersion = "2026-08-01"
// 用户信息 API 的版本头
const userApiVersion = "2025-04-01"
// 设备码轮询的安全余量（毫秒），避免服务器时钟偏差导致请求过快
const pollingSafetyMargin = 3000
// 登录方法 ID：设备码（device flow）
const methodID = Integration.MethodID.make("device")

// 设备码响应的 Schema：验证 URI、用户码、设备码与轮询间隔
const Device = Schema.Struct({
  verification_uri: Schema.String,
  user_code: Schema.String,
  device_code: Schema.String,
  interval: Schema.Number,
})
// 令牌响应的 Schema：访问令牌或错误与建议间隔
const Token = Schema.Struct({
  access_token: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  interval: Schema.optional(Schema.Number),
})
// 用户信息响应的 Schema：Copilot 权限标志与 API 端点
const User = Schema.Struct({
  // 是否启用聊天（Copilot 权限）
  chat_enabled: Schema.optional(Schema.Boolean),
  // 是否可注册受限版 Copilot
  can_signup_for_limited: Schema.optional(Schema.Boolean),
  // 各 API 端点
  endpoints: Schema.optional(
    Schema.Struct({
      // API 根端点（可选）
      api: Schema.optional(Schema.String),
    }),
  ),
})
// 用户信息解码器
const decodeUser = Schema.decodeUnknownOption(User)
const AutoRoute = Schema.Struct({
  session_token: Schema.String,
  expires_at: Schema.Number,
  selected_model: Schema.Struct({ id: Schema.String }),
})
const JsonBody = Schema.fromJsonString(Schema.Unknown)
// 请求体解码器
const decodeBody = Schema.decodeUnknownOption(JsonBody)

// 构造 OAuth 登录方法注册（依赖应用信息）
const oauth = (app: App.Info) =>
  ({
    // 所属集成
    integrationID: Integration.ID.make("github-copilot"),
    // 方法描述
    method: {
      // 方法 ID
      id: methodID,
      // 类型：OAuth
      type: "oauth",
      // 标签
      label: "Login with GitHub Copilot",
      // 登录表单：部署类型 + 企业 URL
      form: [
        {
          // 字符串型选择字段
          type: "string",
          // 键名
          key: "deploymentType",
          // 标题
          title: "Select GitHub deployment type",
          // 必填
          required: true,
          // 选项：GitHub.com（公有）或 GitHub Enterprise（数据驻留/自托管）
          options: [
            { label: "GitHub.com", value: "github.com", description: "Public" },
            { label: "GitHub Enterprise", value: "enterprise", description: "Data residency or self-hosted" },
          ],
        },
        {
          // 字符串型输入字段
          type: "string",
          // 键名
          key: "enterpriseUrl",
          // 标题
          title: "Enter your GitHub Enterprise URL or domain",
          // 占位提示
          placeholder: "company.ghe.com or https://company.ghe.com",
          // 必填
          required: true,
          // 仅当部署类型选了 enterprise 时显示
          when: [{ key: "deploymentType", op: "eq", value: "enterprise" }],
        },
      ],
    },
    // 授权流程（拿到表单答案后执行）
    authorize: (answer) =>
      Effect.gen(function* () {
        // 是否为企业版部署
        const enterprise = answer.deploymentType === "enterprise"
        // 提取企业 URL（字符串才有效）
        const enterpriseUrl = typeof answer.enterpriseUrl === "string" ? answer.enterpriseUrl : undefined
        // 企业部署但没填 URL：失败
        if (enterprise && !enterpriseUrl) return yield* Effect.fail(new Error("Enterprise URL is required"))
        // 计算认证域名：企业域名规范化或 github.com
        const domain = enterprise ? normalizeDomain(enterpriseUrl ?? "") : "github.com"
        // 构造设备码与令牌端点
        const urls = oauthURLs(domain)
        // 请求设备码
        const device = yield* request(urls.device, {
          // POST 方法
          method: "POST",
          // 通用请求头
          headers: headers(app),
          // 请求体：client ID 与只读用户信息 scope
          body: JSON.stringify({ client_id: clientID, scope: "read:user" }),
        }).pipe(Effect.map(Schema.decodeUnknownSync(Device)))
        // 计算轮询间隔（毫秒），至少 1 秒
        const interval = Math.max(device.interval, 1) * 1000

        // 轮询令牌端点（wait 为当前轮询间隔）
        const poll = (wait: number): Effect.Effect<Credential.OAuth, unknown> =>
          request(urls.token, {
            // POST 方法
            method: "POST",
            // 通用请求头
            headers: headers(app),
            // 设备码授权请求体
            body: JSON.stringify({
              client_id: clientID,
              device_code: device.device_code,
              grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            }),
          }).pipe(
            // 解码令牌响应
            Effect.map(Schema.decodeUnknownSync(Token)),
            Effect.flatMap((token) => {
              // 拿到访问令牌：查询用户信息以确认 Copilot 权限
              if (token.access_token) {
                // 提取令牌
                const access = token.access_token
                return request(userURL(enterprise ? domain : undefined), {
                  headers: {
                    Accept: "application/json",
                    Authorization: `Bearer ${access}`,
                    "User-Agent": App.useragent(app),
                    "X-GitHub-Api-Version": userApiVersion,
                  },
                }).pipe(
                  Effect.map((user) => Option.getOrUndefined(decodeUser(user))),
                  // 只有明确的权限否定才阻止登录；查询失败或格式错误不能把 GitHub 的小故障变成拒绝登录。
                  // Only an explicit entitlement answer blocks login; a failed
                  // or malformed lookup must not turn a GitHub hiccup into a denial.
                  Effect.orElseSucceed(() => undefined),
                  Effect.flatMap((user) => {
                    // 检查权限错误
                    const denied = user && copilotEntitlementError(user)
                    // 有则失败并返回错误消息
                    if (denied) return Effect.fail(new Error(denied))
                    // 提取用户级 API 端点（去掉尾部斜杠）
                    const apiEndpoint = user?.endpoints?.api?.replace(/\/+$/, "")
                    // 构造 OAuth 凭据
                    return Effect.succeed(
                      Credential.OAuth.make({
                        // 类型
                        type: "oauth",
                        // 方法 ID
                        methodID,
                        // 设备流无刷新令牌，这里以 access 令牌兼作 refresh
                        refresh: access,
                        // 访问令牌
                        access,
                        // 过期时间 0 表示需另行处理
                        expires: 0,
                        // 企业 URL 或 API 端点存入元数据
                        ...((enterprise || apiEndpoint) && {
                          metadata: {
                            ...(enterprise ? { enterpriseUrl: domain } : {}),
                            ...(apiEndpoint ? { apiEndpoint } : {}),
                          },
                        }),
                      }),
                    )
                  }),
                )
              }
              // 授权仍在等待用户完成：按建议间隔继续轮询
              if (token.error === "authorization_pending")
                return Effect.sleep(wait + pollingSafetyMargin).pipe(Effect.andThen(poll(wait)))
              // 服务器要求放慢：使用新的间隔继续轮询
              if (token.error === "slow_down") {
                // 新间隔取服务器建议或 +5 秒
                const next = token.interval && token.interval > 0 ? token.interval * 1000 : wait + 5000
                return Effect.sleep(next + pollingSafetyMargin).pipe(Effect.andThen(poll(next)))
              }
              // 其他错误：设备授权失败
              return Effect.fail(new Error(`Device authorization failed${token.error ? `: ${token.error}` : ""}`))
            }),
          )

        // 返回授权描述
        return {
          // 模式：自动打开浏览器
          mode: "auto" as const,
          // 用户访问的验证 URI
          url: device.verification_uri,
          // 提示用户输入设备码
          instructions: `Enter code: ${device.user_code}`,
          // 回调：开始轮询令牌
          callback: poll(interval),
        }
      }),
  }) satisfies IntegrationOAuthMethodRegistration

// 定义 GitHub Copilot 插件
export const GithubCopilotPlugin = define({
  // 插件唯一标识
  id: "opencode.provider.github.copilot",
  // 插件主逻辑（Effect 生成器）
  effect: Effect.fn(function* (ctx) {
    // 获取 Provider 服务
    const providers = yield* Provider.Service
    // 获取共享缓存服务
    const cache = yield* SharedCache.Service
    // 获取 Effect 的 HTTP 客户端
    const http = yield* HttpClient.HttpClient
    // 获取底层 fetch 实例（供直连请求使用）
    const outbound = yield* FetchHttpClient.Fetch
    // Each Session keeps the model Copilot's Auto router picked until its token nears expiry, the Session is compacted,
    // or the account changes. The token unlocks the pick and its Auto discount; Copilot rejects it for any other model.
    const routes = new Map<Session.ID, { model: string; account: string; token?: string; until: number }>()
    // The endpoint saved at login serves requests until the first refresh reads the account's current one, so an
    // Enterprise login doesn't send its token to the public host while that refresh is still running.
    const login = yield* credentialSettings(ctx, "github-copilot", (value) =>
      value.type === "oauth" ? { baseURL: copilotBaseURL(value.metadata) } : {},
    )
    const discovered = yield* ProviderRefresh.start({
      // 所属集成
      integrationID: "github-copilot",
      // 初始值为空
      initial: {} as {
        // Copilot API 的 baseURL
        readonly baseURL?: string
        // 访问令牌
        readonly token?: string
        // 模型列表快照
        readonly models?: CopilotModels.Snapshot
        // 激活连接
        readonly connection?: Effect.Success<ReturnType<typeof ctx.integration.connection.active>>
      },
      // 激活连接的 Effect
      active: ctx.integration.connection.active("github-copilot"),
      // 供应商重载 Effect
      reload: ctx.provider.reload(),
      // 加载函数
      load: Effect.fn("GithubCopilotPlugin.load")(function* (_, options) {
        // 解析激活连接与凭据
        const { connection, credential } = yield* activeCredential(ctx, "github-copilot")
        // 无连接或凭据非 OAuth：返回空值
        if (!connection || credential?.type !== "oauth") return { connection, value: {} }
        // The account's API endpoint changes with its plan, so read it again on every refresh; the one stored at
        // login is the fallback.
        const endpoint = yield* cache
          .get({
            key: `github-copilot-endpoint:${IntegrationConnection.key(connection)}`,
            ...options,
            load: ctx.integration.connection.resolve(connection).pipe(
              Effect.flatMap((current) =>
                current?.type === "oauth"
                  ? HttpClient.filterStatusOk(http)
                      .execute(
                        HttpClientRequest.get(
                          userURL(
                            typeof current.metadata?.enterpriseUrl === "string"
                              ? current.metadata.enterpriseUrl
                              : undefined,
                          ),
                        ).pipe(
                          HttpClientRequest.setHeaders({
                            Accept: "application/json",
                            Authorization: `Bearer ${current.refresh}`,
                            "User-Agent": App.useragent(ctx.app),
                            "X-GitHub-Api-Version": userApiVersion,
                          }),
                        ),
                      )
                      .pipe(
                        Effect.flatMap(HttpClientResponse.schemaBodyJson(User)),
                        Effect.map((user) => user.endpoints?.api?.replace(/\/+$/, "")),
                        Effect.timeout("5 seconds"),
                      )
                  : Effect.fail(new Error("GitHub Copilot connection has no OAuth credential")),
              ),
            ),
          })
          .pipe(Effect.orElseSucceed(() => undefined))
        const url = endpoint || copilotBaseURL(credential.metadata)
        const headers = (yield* providers.get(Provider.ID.githubCopilot))?.headers ?? {}
        // 通过共享缓存加载模型列表（按连接+URL+请求头指纹缓存）
        const models = yield* cache
          .get({
            // 缓存键
            key: modelsKey(connection, url, headers),
            // 刷新选项透传
            ...options,
            // 实际加载逻辑：重新解析连接后请求模型列表
            load: ctx.integration.connection.resolve(connection).pipe(
              Effect.flatMap((current) =>
                current?.type === "oauth"
                  ? CopilotModels.load(http, url, {
                      // 合并请求头
                      ...headers,
                      // Bearer 授权
                      Authorization: `Bearer ${current.refresh}`,
                      // User-Agent
                      "User-Agent": App.useragent(ctx.app),
                      // API 版本
                      "X-GitHub-Api-Version": apiVersion,
                    })
                  // 非 OAuth 凭据：失败
                  : Effect.fail(new Error("GitHub Copilot connection has no OAuth credential")),
              ),
            ),
          })
          // 加载失败时回退为 undefined
          .pipe(Effect.orElseSucceed(() => undefined))
        // 返回加载结果
        return { connection, value: { baseURL: url, token: credential.refresh, models, connection } }
      }),
    })

    // 注册集成转换：移除 key 登录方法，注册 OAuth 设备流
    yield* ctx.integration.transform((editor) => {
      // 移除旧的 key 方法
      editor.method.remove("github-copilot", { type: "key" })
      // 注册 OAuth 方法
      editor.method.update(oauth(ctx.app))
    })
    // 注册供应商转换：用发现的模型列表刷新模型注册
    yield* ctx.provider.transform((evt) => {
      // 获取 githubCopilot 供应商配置
      const item = evt.get(Provider.ID.githubCopilot)
      // 无配置则跳过
      if (!item) return
      // 取当前发现的加载结果
      const loaded = discovered.current
      const url = loaded.baseURL ?? (typeof login.settings.baseURL === "string" ? login.settings.baseURL : baseURL())
      if (loaded.models) {
        const router = CopilotModels.autoModel(url, loaded.models)
        evt.add({
          // 供应商信息
          info: item.provider,
          models: [
            ...CopilotModels.derive(url, loaded.models, Array.from(item.models.values())).values(),
            ...(router ? [router] : []),
          ],
          sourceConnection: loaded.connection,
        })
        return
      }
      // 没有实时模型列表时，models.dev 的包声明了每个模型走哪条 Copilot API：
      // Anthropic Messages 保持原生；OpenAI 意味着走 Responses；其余走捆绑 Copilot SDK 的模型 ID 回退。
      // Without the live model list, the models.dev package says which Copilot API serves
      // each model: Anthropic means Messages, OpenAI means Responses, and anything else
      // falls back to the model ID.
      for (const id of item.models.keys()) {
        // 逐个模型调整
        evt.models.update(item.provider.id, id, (model) => {
          const route = CopilotModels.routeFor(
            model.modelID ?? model.id,
            model.package === "@opencode/ai/providers/anthropic"
              ? "messages"
              : model.package === "@opencode/ai/providers/openai"
                ? "responses"
                : undefined,
            url,
          )
          model.package = route.package
          model.settings = Provider.mergeOverlay(model.settings, { baseURL: route.baseURL })
        })
      }
    })
    // 注册模型转换：隐藏与 Copilot 路由冲突的模型别名
    yield* ctx.model.transform((models) => {
      // 检查 gpt-5-chat-latest 是否注册
      if (models.get(Provider.ID.githubCopilot, Model.ID.make("gpt-5-chat-latest"))) {
        // 更新该模型
        models.update(Provider.ID.githubCopilot, Model.ID.make("gpt-5-chat-latest"), (model) => {
          // 这个纯聊天别名与 Copilot 的 GPT-5 Responses 路由冲突，因此只对 Copilot 隐藏，而不是在每个供应商目录里隐藏。
          // This chat-only alias conflicts with the Copilot GPT-5 Responses route,
          // so hide it only for Copilot rather than for every provider catalog.
          model.enabled = false
        })
      }
    })
    yield* ctx.session.hook(
      "model.request",
      (evt) =>
        Effect.gen(function* () {
          // 读取会话（失败则视为无会话）
          const session = yield* ctx.session
            .get({ sessionID: evt.sessionID })
            .pipe(Effect.orElseSucceed(() => undefined))
          // 计算交互类型（标题/压缩/子代理/普通代理）
          const interaction = interactionType(evt.kind, session?.parentID !== undefined)
          // 注入交互类型头
          evt.headers["X-Interaction-Type"] = interaction
          // 注入交互 ID：优先会话的亲和 ID，否则用会话 ID
          evt.headers["X-Interaction-Id"] = session ? SessionAffinity.get(session) : evt.sessionID
          // 非普通对话的请求标记为 agent 发起
          if (interaction !== "conversation-agent") evt.headers["x-initiator"] = "agent"
          const route = routes.get(evt.sessionID)
          if (route?.token && route.model === evt.model.id) evt.headers["Copilot-Session-Token"] = route.token
        }),
      { providerID: Provider.ID.githubCopilot },
    )
    const route = Effect.fn("GithubCopilotPlugin.route")(function* (sessionID: Session.ID) {
      const loaded = discovered.current
      if (!loaded.baseURL || !loaded.token || !loaded.models) return
      const user = yield* ctx.session.context({ sessionID }).pipe(
        Effect.map((messages) => messages.findLast((message) => message.type === "user")),
        Effect.orElseSucceed(() => undefined),
      )
      const headers = (yield* providers.get(Provider.ID.githubCopilot))?.headers ?? {}
      const picked = yield* HttpClient.filterStatusOk(http)
        .execute(
          HttpClientRequest.post(`${loaded.baseURL}/auto`).pipe(
            HttpClientRequest.setHeaders({
              ...headers,
              Authorization: `Bearer ${loaded.token}`,
              "User-Agent": App.useragent(ctx.app),
              "X-GitHub-Api-Version": apiVersion,
            }),
            HttpClientRequest.bodyJsonUnsafe({
              prompt: user?.text ?? "",
              ...(user?.files?.some((file) => file.mime.startsWith("image/")) ? { has_image: true } : {}),
            }),
          ),
        )
        .pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(AutoRoute)),
          Effect.timeout("5 seconds"),
          Effect.tapError((cause) => Effect.logWarning("Copilot Auto routing failed", { cause })),
          Effect.option,
        )
      const now = yield* Clock.currentTimeMillis
      if (Option.isSome(picked) && loaded.models.has(picked.value.selected_model.id))
        return {
          model: picked.value.selected_model.id,
          account: loaded.token,
          token: picked.value.session_token,
          // Route again before the token can expire mid-request.
          until: picked.value.expires_at * 1000 - 5 * 60_000,
        }
      const models = Array.from(loaded.models.values())
      const fallback =
        models.find((model) => model.is_chat_fallback) ?? models.find((model) => model.billing?.auto_discount)
      // Retry routing soon when the router fails or picks a model this client cannot serve.
      return fallback && { model: fallback.id, account: loaded.token, until: now + 5 * 60_000 }
    })
    yield* ctx.session.hook(
      "experimental.model.resolve",
      (evt) =>
        Effect.gen(function* () {
          // Titles use Copilot's utility model, so they never route.
          if (evt.model.id !== CopilotModels.auto || evt.kind === "title") return
          const now = yield* Clock.currentTimeMillis
          const cached = routes.get(evt.sessionID)
          const current =
            cached && cached.until > now && cached.account === discovered.current.token
              ? cached
              : yield* route(evt.sessionID)
          if (!current) return
          for (const [id, route] of routes) if (route.until <= now) routes.delete(id)
          routes.set(evt.sessionID, current)
          evt.model = Model.Ref.make({ providerID: Provider.ID.githubCopilot, id: Model.ID.make(current.model) })
        }),
      { providerID: Provider.ID.githubCopilot },
    )
    // Compaction rewrites the prompt, so the request after it routes again, like Copilot's own clients. The compaction
    // request itself still carries the current pick's token.
    yield* ctx.session.hook(
      "compaction",
      (evt) =>
        Effect.sync(() => {
          const route = routes.get(evt.sessionID)
          if (route) route.until = 0
        }),
      // 仅对 githubCopilot 供应商生效
      { providerID: Provider.ID.githubCopilot },
    )
    // GitHub 的集成指南把会话命名指定为由免费、限流的 utility 模型承担的工具型场景。
    // 任何失败都让 result 保持未设置，这样常规的计费标题生成路径仍会运行。
    // GitHub's integration guide designates session naming as a utility scenario served by
    // free, rate-limited utility models. Any failure leaves the result unset so the normal
    // billable title path still runs.
    yield* ctx.session.hook(
      "title",
      (evt) =>
        Effect.gen(function* () {
          // 取当前加载结果
          const loaded = discovered.current
          // 缺少 baseURL/令牌/模型列表则跳过
          if (!loaded.baseURL || !loaded.token || !loaded.models) return
          // 读取 title 代理配置
          const agent = yield* ctx.agent
            .get({ agentID: Agent.ID.make("title") })
            .pipe(Effect.orElseSucceed(() => undefined))
          // 用户为 title 代理配置了模型：走常规路径
          if (agent?.data.model) return
          // 从可用的 utility 标题模型中选择第一个已存在的
          const model = utilityTitleModels.find((id) => loaded.models?.has(id))
          // 无可用模型则跳过
          if (!model) return
          // 用 utility 模型生成标题并写入结果
          evt.result = yield* utilityTitle(
            { baseURL: loaded.baseURL, token: loaded.token, model, app: ctx.app, fetch: outbound },
            evt,
          ).pipe(
            // 失败只记调试日志
            Effect.tapError((cause) => Effect.logDebug("Copilot utility title failed", { model, cause })),
            // 失败回退为 undefined（保持常规路径）
            Effect.orElseSucceed(() => undefined),
          )
        }),
      // 仅对 githubCopilot 供应商生效
      { providerID: Provider.ID.githubCopilot },
    )
    // 注册 http.request 钩子：为本地 HTTP 服务器代理的请求注入 Copilot 头
    yield* ctx.session.hook(
      "http.request",
      (evt) =>
        Effect.gen(function* () {
          // The Messages route sends the token as `x-api-key`, the OpenAI routes as a bearer token.
          const token =
            evt.request.headers.get("x-api-key") ?? evt.request.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
          if (!token) return
          // 读取请求体文本（clone 避免消费原请求）
          const text = yield* Effect.promise(() => evt.request.clone().text())
          // 解析请求体
          const body = Option.getOrUndefined(decodeBody(text))
          applyHeaders(evt.request.headers, token, ctx.app, requestMetadata(evt.request.url, body))
        }),
      // 仅对 githubCopilot 供应商生效
      { providerID: Provider.ID.githubCopilot },
    )
  }),
} satisfies PluginInternal.InternalPlugin)

// 计算模型列表的缓存键：连接 + URL + 请求头指纹
function modelsKey(
  connection: Parameters<typeof IntegrationConnection.key>[0],
  url: string,
  headers: Record<string, string>,
) {
  // 对排序后的请求头做指纹
  const fingerprint = SharedCache.fingerprint(JSON.stringify(Object.entries(headers).toSorted()))
  // 拼接缓存键
  return `github-copilot:${IntegrationConnection.key(connection)}:${url}:${fingerprint}`
}

// 规范化域名：去掉协议前缀与尾部斜杠
function normalizeDomain(input: string) {
  return input.replace(/^https?:\/\//, "").replace(/\/$/, "")
}

// 构造 OAuth 端点（设备码与令牌）
function oauthURLs(domain: string) {
  return {
    // 设备码端点
    device: `https://${domain}/login/device/code`,
    // 令牌端点
    token: `https://${domain}/login/oauth/access_token`,
  }
}

function userURL(enterprise?: string) {
  return `${enterprise ? `https://api.${normalizeDomain(enterprise)}` : "https://api.github.com"}/copilot_internal/user`
}

function baseURL(enterprise?: string) {
  return enterprise ? `https://copilot-api.${normalizeDomain(enterprise)}` : "https://api.githubcopilot.com"
}

// GitHub 在 /copilot_internal/user 上报告 Copilot 权限；OAuth 本身对任何 GitHub 账号都会成功，
// 所以这是账号能否聊天的唯一信号。
// GitHub reports Copilot access on /copilot_internal/user; OAuth itself succeeds
// for any GitHub account, so this is the only signal that the account can chat.
export function copilotEntitlementError(user: { chat_enabled?: boolean; can_signup_for_limited?: boolean }) {
  // chat_enabled 未明确为 false：无错误
  if (user.chat_enabled !== false) return
  // 可注册受限版：提示注册 Copilot Free
  if (user.can_signup_for_limited)
    return "This GitHub account is not signed up for GitHub Copilot. Sign up for Copilot Free at https://github.com/features/copilot/plans and connect again."
  // 无权限：提示需要订阅或组织席位
  return "This GitHub account does not have GitHub Copilot access. It needs an active Copilot subscription or a seat assigned by an organization."
}

// 从凭据元数据计算 Copilot baseURL
export function copilotBaseURL(metadata?: Readonly<Record<string, unknown>>) {
  // 优先使用 API 端点元数据
  const endpoint = metadata?.apiEndpoint
  if (typeof endpoint === "string" && endpoint) return endpoint
  // 其次使用企业 URL
  const enterprise = metadata?.enterpriseUrl
  return baseURL(typeof enterprise === "string" ? enterprise : undefined)
}

// 构造 OAuth 流程的通用请求头
function headers(app: App.Info) {
  return {
    // 接受 JSON
    Accept: "application/json",
    // 内容类型 JSON
    "Content-Type": "application/json",
    // User-Agent
    "User-Agent": App.useragent(app),
  }
}

// 发起 HTTP 请求并解析 JSON（失败返回原始原因）
function request(url: string, init: RequestInit) {
  return Effect.tryPromise({
    try: async (signal) => {
      // 发起请求（带中止信号）
      const response = await fetch(url, { ...init, signal })
      // 非 2xx 状态：抛错
      if (!response.ok) throw new Error(`Request failed: ${response.status}`)
      // 解析 JSON
      return response.json()
    },
    // 错误原样传递
    catch: (cause) => cause,
  })
}

// fetch 函数类型别名
type Fetch = (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>

// 与 Copilot 客户端一致：gpt-4o-mini 是“小型 utility”模型；账号没有它时，
// 请求回退到常规标题路径，而不是继续猜别的模型。
// Matches the Copilot client: gpt-4o-mini is the "small utility" model; when an account
// lacks it the request falls through to the regular title path instead of another guess.
export const utilityTitleModels = ["gpt-4o-mini"]

// utility 标题响应的 Schema：choices[0].message.content（字符串或 null）
const UtilityCompletion = Schema.Struct({
  choices: Schema.Array(Schema.Struct({ message: Schema.Struct({ content: Schema.NullOr(Schema.String) }) })),
})
// utility 响应解码器（JSON 字符串 -> 结构）
const decodeUtilityCompletion = Schema.decodeUnknownEffect(Schema.fromJsonString(UtilityCompletion))

// 这个函数自己发起 /chat/completions 调用，而不是引导 core 的标题请求。
// `session.title` 钩子中的 `model` 是只读的，指向另一个模型意味着扩宽契约并在 SessionModelRequest 里重新解析；
// 在 `http.request` 里改写请求体更糟，因为端点（GPT-5 走 /responses，Claude 走 /v1/messages）在该钩子运行前就已固定，
// 而 gpt-4o-mini 只服务 /chat/completions。Utility 标题是 Copilot 专属、无状态、非流式且免费的，
// 所以这里的小请求比给 core 开缝代价更低。代价：标题步骤没有会话用量记录（该调用不计费），
// 且对 `http.*` 钩子不可见。
// This issues its own /chat/completions call instead of steering core's title request.
// The `session.title` hook exposes `model` read-only, so pointing core at another model
// would mean widening that contract and re-resolving inside SessionModelRequest; rewriting
// the body in `http.request` is worse still, since the endpoint (/responses for GPT-5,
// /v1/messages for Claude) is fixed before that hook runs and gpt-4o-mini only serves
// /chat/completions. Utility titles are Copilot-specific, stateless, non-streaming, and
// free, so a small request here costs less than a core seam. Trade-offs: no session
// usage record for the title step (the call bills nothing) and no `http.*` hook visibility.
export function utilityTitle(
  // 输入：baseURL、令牌、模型、应用信息与可选 fetch
  input: { baseURL: string; token: string; model: string; app: App.Info; fetch?: Fetch },
  // 标题请求：会话 ID、系统提示、消息与选项
  request: Pick<SessionTitle, "sessionID" | "system" | "messages" | "options">,
) {
  // 使用传入的 fetch 或全局 fetch
  const send = input.fetch ?? fetch
  // 把消息内容部件压平为纯文本
  const text = (parts: ReadonlyArray<{ type: string; text?: string | null }>) =>
    parts.flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : [])).join("\n")
  // 组装消息列表：可选 system + 历史消息
  const messages = [
    ...(request.system.length ? [{ role: "system", content: text(request.system) }] : []),
    ...request.messages.map((message) => ({ role: message.role, content: text(message.content) })),
  ]
  // 发起请求的 Effect
  return Effect.tryPromise({
    try: async (signal) => {
      // POST /chat/completions
      const response = await send(`${input.baseURL}/chat/completions`, {
        // POST 方法
        method: "POST",
        // 中止信号
        signal,
        // Copilot 要求的请求头
        headers: {
          // Bearer 授权
          Authorization: `Bearer ${input.token}`,
          // JSON 内容类型
          "Content-Type": "application/json",
          // User-Agent
          "User-Agent": App.useragent(input.app),
          // API 版本
          "X-GitHub-Api-Version": apiVersion,
          // 意图标记
          "Openai-Intent": "conversation-edits",
          // 交互类型：会话命名
          "X-Interaction-Type": "agent-session-name-generation",
          // 交互 ID：会话 ID
          "X-Interaction-Id": request.sessionID,
          // 发起者：agent
          "x-initiator": "agent",
        },
        // 请求体：模型、消息、非流式、可选 max_tokens
        body: JSON.stringify({
          model: input.model,
          messages,
          stream: false,
          ...(typeof request.options.maxTokens === "number" ? { max_tokens: request.options.maxTokens } : {}),
        }),
      })
      // 非 2xx：抛错
      if (!response.ok) throw new Error(`Utility title request failed: ${response.status}`)
      // 返回响应文本
      return response.text()
    },
    // 错误原样传递
    catch: (cause) => cause,
  }).pipe(
    // 20 秒超时
    Effect.timeout("20 seconds"),
    // 解码响应
    Effect.flatMap(decodeUtilityCompletion),
    // 提取标题
    Effect.flatMap((completion) => {
      // 取第一个选择的文本内容并去空白
      const title = completion.choices[0]?.message.content?.trim()
      // 有标题则成功，否则失败
      return title ? Effect.succeed(title) : Effect.fail(new Error("Utility title response was empty"))
    }),
  )
}

function applyHeaders(headers: Headers, token: string | undefined, app: App.Info, metadata: RequestMetadata) {
  if (token) {
    // 删除其他形式的授权头
    headers.delete("authorization")
    headers.delete("x-api-key")
    // 设置 Bearer 令牌
    headers.set("Authorization", `Bearer ${token}`)
  }
  // 设置 User-Agent
  headers.set("User-Agent", App.useragent(app))
  // 设置意图标记
  headers.set("Openai-Intent", "conversation-edits")
  // 设置 API 版本
  headers.set("X-GitHub-Api-Version", apiVersion)
  // 该步骤可能已自声明为 agent 发起（子代理、标题、压缩）；
  // 请求体只能把发起者“升级”为 agent，绝不能降回 user。
  // The step may already have declared itself agent-initiated (subagent, title, compaction);
  // the body can only ever escalate to "agent", never back to "user".
  if (metadata.agent) headers.set("x-initiator", "agent")
  else if (!headers.has("x-initiator")) headers.set("x-initiator", "user")
  // 涉及图像时声明视觉请求
  if (metadata.vision) headers.set("Copilot-Vision-Request", "true")
}

// 与 Copilot 客户端的 X-Interaction-Type 词汇一致：代理循环是默认值，
// 嵌套会话是子代理，标题与压缩是两个 utility 覆盖。
// Mirrors the Copilot client's X-Interaction-Type vocabulary: the agent loop is the default,
// nested sessions are subagents, and title/compaction are the two utility overrides.
export function interactionType(kind: SessionRequestKind, child: boolean) {
  // 标题生成
  if (kind === "title") return "conversation-background"
  // 压缩
  if (kind === "compaction") return "conversation-compaction"
  // 子代理（嵌套会话）
  if (child) return "conversation-subagent"
  // 默认：代理对话
  return "conversation-agent"
}

// 请求元数据类型：由 requestMetadata 推导
type RequestMetadata = ReturnType<typeof requestMetadata>

// 从 URL 与请求体推导元数据：是否 agent 发起、是否含图像
function requestMetadata(url: string, body: unknown) {
  // 请求体不是普通对象：默认无
  if (!isRecord(body)) return { agent: false, vision: false }
  // Responses 端点：输入在 body.input 数组
  if (Array.isArray(body.input)) {
    // 取最后一个输入项
    const last = body.input.at(-1)
    return {
      // 最后项不是 user 消息 => agent 发起
      agent: !isRecord(last) || last.role !== "user",
      // Tool results carry their images in `output`, user messages in `content`.
      vision: body.input.some(
        (item) =>
          isRecord(item) &&
          [item.content, item.output].some(
            (parts) => Array.isArray(parts) && parts.some((part) => isRecord(part) && part.type === "input_image"),
          ),
      ),
    }
  }
  // 没有 messages 数组：默认无
  if (!Array.isArray(body.messages)) return { agent: false, vision: false }
  // 取最后一条消息
  const last = body.messages.at(-1)
  // Chat Completions 端点
  if (url.includes("completions")) {
    const previous = body.messages.at(-2)
    return {
      // Chat Completions moves tool-result images into a user message after the tool messages.
      agent: !isRecord(last) || last.role !== "user" || (isRecord(previous) && previous.role === "tool"),
      vision: body.messages.some(
        (message) =>
          isRecord(message) &&
          Array.isArray(message.content) &&
          message.content.some((part) => isRecord(part) && part.type === "image_url"),
      ),
    }
  }
  // Anthropic Messages 端点：取最后一条消息的内容
  const content = isRecord(last) && Array.isArray(last.content) ? last.content : []
  return {
    // agent 判定：最后项不是 user，或其内容并非只有 tool_result（即含新输入）
    agent:
      !isRecord(last) || last.role !== "user" || !content.some((part) => isRecord(part) && part.type !== "tool_result"),
    // 视觉判定：任一消息含 image 块，或 tool_result 内嵌 image
    vision: body.messages.some(
      (message) =>
        isRecord(message) &&
        Array.isArray(message.content) &&
        message.content.some(
          (part) =>
            isRecord(part) &&
            (part.type === "image" ||
              (part.type === "tool_result" &&
                Array.isArray(part.content) &&
                part.content.some((nested) => isRecord(nested) && nested.type === "image"))),
        ),
    ),
  }
}
