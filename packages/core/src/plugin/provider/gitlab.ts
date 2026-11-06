// 导入 os 模块（拼接 User-Agent 中的平台信息）
import os from "os"
// 导入应用信息工具（User-Agent）
import { App } from "../../app.js"
// 从 effect 库导入所需原语
import { Clock, Deferred, Effect, Equal, Exit, Option, Schema, Semaphore } from "effect"
// 从 effect/http 导入 HTTP 客户端工具
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
// 导入 node:http 的服务器与响应类型（仅类型）
import type { Server, ServerResponse } from "node:http"
// 导入插件定义辅助函数 define
import { define } from "@opencode/plugin/effect/plugin"
// 导入表单字段构造工具
import { Form } from "@opencode/schema/form"
// 导入 GitLab 工作流模型的发现类型（仅类型）
import type { DiscoveredWorkflowModel } from "gitlab-ai-provider"
// 导入凭据模块
import { Credential } from "../../credential.js"
// 导入集成模块
import { Integration } from "../../integration.js"
// 导入集成连接工具
import { IntegrationConnection } from "../../integration/connection.js"
// 导入 Model（模型信息默认值等）
import { Model } from "../../model.js"
// 导入 OAuth 回调页面渲染工具
import { OauthCallbackPage } from "../../oauth/page.js"
// 导入 Provider 服务与 ID 常量
import { Provider } from "../../provider.js"
// 导入内部插件类型声明（仅类型）
import type { PluginInternal } from "../internal.js"
// 导入凭据设置与元数据设置辅助函数
import { credentialSettings, metadataSettings } from "./credential-settings.js"
// 导入提供商刷新辅助工具
import { ProviderRefresh } from "./refresh.js"

// 提供商 ID
const providerID = Provider.ID.gitlab
// 集成 ID
const integrationID = Integration.ID.make("gitlab")
// PKCE 登录方式的 ID
const methodID = Integration.MethodID.make("pkce")
// Instance-owned, trusted GitLab OAuth application for OpenCode. Registered with
// redirect URI http://127.0.0.1:8080/callback on gitlab.com. Self-managed instances
// need their own application; override with GITLAB_OAUTH_CLIENT_ID in that case.
// OpenCode 官方维护的 GitLab OAuth 应用（注册于 gitlab.com，回调 127.0.0.1:8080/callback）；
// 自管实例需要自己的应用，此时用 GITLAB_OAUTH_CLIENT_ID 覆盖。
const bundledClientID = "fd180700a8f9c5d5557aca231632dd0611a1135a3bb510a741d5a988a3394fa7"
// Application used by every opencode-gitlab-auth release (and gitlab-ai-provider's
// OPENCODE_GITLAB_AUTH_CLIENT_ID). Refresh tokens stay bound to the issuing
// application, so credentials created by that plugin must refresh with it.
// 旧版 opencode-gitlab-auth 插件使用的应用 ID；刷新令牌与签发应用绑定，
// 由它创建的凭据必须继续用它刷新。
const legacyClientID = "1d89f9fdb23ee96d4e603201f6861dab6e143c5c3c00469a018a2d94bdc03d4e"
// gitlab.com 主机名（判断是否可用内置应用）
const gitlabComHost = "gitlab.com"
// OAuth 作用域
const oauthScope = "api"
// 回调服务器绑定主机
const callbackHost = "127.0.0.1"
// 回调服务器固定端口（GitLab 要求 redirect_uri 精确匹配，端口不能随机）
const callbackPort = 8080
// 完整回调地址
const redirectURI = `http://${callbackHost}:${callbackPort}/callback`

// 令牌接口响应 Schema：访问/刷新令牌必填，过期秒数可选
const Token = Schema.Struct({
  access_token: Schema.NonEmptyString,
  refresh_token: Schema.NonEmptyString,
  expires_in: Schema.optional(Schema.Number),
})
// 错误响应的解码 Schema
const decodeError = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ error: Schema.optional(Schema.String), error_description: Schema.optional(Schema.String) }),
  ),
)
// 发现流程的超时时间
const discoveryTimeout = "10 seconds"
// GitLab rotates the refresh token on every refresh, so concurrent refreshes of the same
// credential (e.g. discovery in several Locations plus a request) must share one exchange.
// Successful refreshes are kept briefly: a caller that read the credential just before the
// rotated one was stored would otherwise spend the already-used refresh token again.
// GitLab 每次刷新都会轮换刷新令牌，因此同一凭据的并发刷新必须共享一次交换；
// 成功结果会短暂保留，避免刚读过旧凭据的调用方重复使用已作废的刷新令牌。
const refreshing = new Map<string, { attempt: Deferred.Deferred<Credential.OAuth, Error>; until: number }>()
// 成功刷新结果的保留时长（毫秒）
const refreshRetention = 60_000

// 导出 GitLab 提供商插件：OAuth 登录、工作流模型发现与 SDK 集成
export const GitLabPlugin = define({
  // 插件唯一标识符
  id: "opencode.provider.gitlab",
  // 插件主流程生成器
  effect: Effect.fn(function* (ctx) {
    // 获取提供商服务实例
    const providers = yield* Provider.Service
    // 获取 HTTP 客户端实例
    const http = yield* HttpClient.HttpClient
    // 信号量：串行化“加载 + 重载”组合
    const loading = Semaphore.makeUnsafe(1)
    // 最近一次加载的结果：发现的模型与来源连接
    const loaded: {
      models?: DiscoveredWorkflowModel[]
      connection?: Effect.Success<ReturnType<typeof ctx.integration.connection.active>>
    } = {}

    // load：读取活跃连接的凭据并发现工作流模型，返回结果是否变化
    const load = Effect.fn("GitLabPlugin.load")(function* () {
      // 获取 GitLab 集成当前活跃连接
      const connection = yield* ctx.integration.connection.active(integrationID)
      // Like v1, only stored logins drive discovery; ambient GITLAB_TOKEN users are not probed.
      // 与 v1 一致：只有存储的登录才会触发发现；环境变量 GITLAB_TOKEN 用户不主动探测
      const stored = connection?.type === "credential" ? connection : undefined
      // 解析连接得到实际凭据（失败按未登录处理）
      const credential = stored
        ? yield* ctx.integration.connection.resolve(stored).pipe(Effect.orElseSucceed(() => undefined))
        : undefined
      // 没有存储登录（或为外部凭据）时清空发现结果
      if (!stored || !credential || credential.type === "external") {
        // 判断此前是否有发现结果（决定是否需要重载）
        const changed = loaded.models !== undefined || loaded.connection !== undefined
        loaded.models = undefined
        loaded.connection = undefined
        return changed
      }

      // 读取提供商目录条目
      const provider = yield* providers.get(providerID)
      // An OAuth login pins the instance it was issued against; prefer it over ambient defaults.
      // OAuth 登录固定其签发实例；实例地址按 登录元数据 > 提供商设置 > 环境变量默认值 的优先级解析
      const instanceUrl =
        credential.type === "oauth" && typeof credential.metadata?.instanceUrl === "string"
          ? credential.metadata.instanceUrl
          : typeof provider?.settings?.instanceUrl === "string"
            ? provider.settings.instanceUrl
            : resolveDefaultInstanceUrl()
      // 构造鉴权头：OAuth 用 Bearer，令牌用 PRIVATE-TOKEN
      const headers: Record<string, string> =
        credential.type === "oauth"
          ? { Authorization: `Bearer ${credential.access}` }
          : { "PRIVATE-TOKEN": credential.key }
      // The SDK owns project detection, GraphQL discovery, caching and token limits.
      // 由 SDK 负责项目检测、GraphQL 发现、缓存与令牌限制
      const remote = yield* Effect.tryPromise({
        try: async (signal) => {
          // 惰性加载 gitlab-ai-provider 包
          const { discoverWorkflowModels } = await import("gitlab-ai-provider")
          // 执行发现：传入实例地址、动态鉴权头与可中断的 fetch
          return discoverWorkflowModels(
            {
              instanceUrl,
              getHeaders: () => headers,
              fetch: Object.assign(
                (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
                  fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal }),
                { preconnect: fetch.preconnect },
              ),
            },
            { workingDirectory: ctx.location.directory, cacheKey: stored.id },
          )
        },
        catch: (cause) => cause,
      }).pipe(
        // Discovered models are tied to this connection, so an unresponsive host would
        // otherwise keep the provider hidden and hold the permit for later switches.
        // 发现结果与该连接绑定，无响应的主机不应长期阻塞，因此加超时并降级为警告
        Effect.timeout(discoveryTimeout),
        Effect.catch((cause) =>
          Effect.logWarning("failed to discover GitLab workflow models", { cause }).pipe(Effect.as(undefined)),
        ),
      )
      // 加载期间连接已切换则丢弃本次结果
      if (
        IntegrationConnection.key(connection) !==
        IntegrationConnection.key(yield* ctx.integration.connection.active(integrationID))
      )
        return false
      // 比较：模型列表或连接是否发生变化
      const changed = !Equal.equals(remote?.models, loaded.models) || !Equal.equals(connection, loaded.connection)
      // 记录新结果
      loaded.models = remote?.models
      loaded.connection = connection
      return changed
    })

    // 注册集成登录方式：PKCE OAuth（带实例地址表单）
    yield* ctx.integration.transform((editor) => {
      // 更新/创建 GitLab 的 OAuth 方式定义
      editor.method.update({
        // 所属集成
        integrationID,
        // 方式定义
        method: {
          id: methodID,
          type: "oauth",
          label: "Login with GitLab (OAuth)",
          // 表单：可填自管实例地址
          form: Form.Fields.make([
            {
              type: "string",
              key: "instanceUrl",
              title: "GitLab instance URL",
              description: "Leave the default to use gitlab.com, or enter your self-managed GitLab URL.",
              placeholder: resolveDefaultInstanceUrl(),
              default: resolveDefaultInstanceUrl(),
              pattern: "^https?://\\S+$",
            },
          ]),
        },
        // 登录条目显示实例主机名
        label: (value) => new URL(credentialInstanceUrl(value.metadata)).host,
        // 刷新逻辑：与签发应用一致地单飞刷新
        refresh: (value) => {
          // 从元数据解析实例地址
          const instanceUrl = credentialInstanceUrl(value.metadata)
          // Refresh with the application that issued the token. Credentials without a recorded
          // client ID were issued by opencode-gitlab-auth, using GITLAB_OAUTH_CLIENT_ID or its default.
          // clientID 按凭据记录 > 环境变量 > 旧版默认 的优先级解析
          const clientID =
            (typeof value.metadata?.clientID === "string" ? value.metadata.clientID : undefined) ||
            process.env.GITLAB_OAUTH_CLIENT_ID?.trim() ||
            legacyClientID
          // 同一刷新令牌的并发刷新合并为一次请求
          return singleFlight(
            `${instanceUrl}\0${value.refresh}`,
            exchange(
              http,
              instanceUrl,
              clientID,
              { grant_type: "refresh_token", refresh_token: value.refresh, redirect_uri: redirectURI },
              describeRefreshFailure,
            ).pipe(Effect.flatMap((tokens) => credential(instanceUrl, clientID, tokens))),
          )
        },
        // 授权流程：PKCE + 本地回调服务器
        authorize: (answer) =>
          Effect.gen(function* () {
            // Capture once so the authorize request and the token exchange cannot
            // disagree if the environment changes mid-flow.
            // 一次性捕获环境变量，保证授权请求与令牌交换用同一个 clientID
            const override = process.env.GITLAB_OAUTH_CLIENT_ID?.trim()
            // 有覆盖用覆盖，否则用内置应用
            const clientID = override || bundledClientID
            // 解析用户填写的实例地址（缺省用默认值）
            const url = new URL(
              (typeof answer.instanceUrl === "string" ? answer.instanceUrl.trim() : "") || resolveDefaultInstanceUrl(),
            )
            // Keep the path so instances served under a relative URL root (e.g. /gitlab) work.
            // 保留路径部分，让挂在子路径下（如 /gitlab）的实例也能工作
            const instanceUrl = `${url.origin}${url.pathname.replace(/\/+$/, "")}`
            // 未提供覆盖 clientID 时只允许 gitlab.com
            if (!override && url.host !== gitlabComHost)
              return yield* Effect.fail(
                new Error(
                  `The bundled GitLab OAuth application only exists on ${gitlabComHost}. To sign in to ${url.host},` +
                    ` register an OAuth application there with redirect URI ${redirectURI} and the \`${oauthScope}\`` +
                    ` scope (not marked "Confidential"), then set GITLAB_OAUTH_CLIENT_ID to its application ID.`,
                ),
              )
            // 生成 PKCE 校验器
            const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
            // 计算挑战值
            const challenge = Buffer.from(
              yield* Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
            ).toString("base64url")
            // 生成随机 state 防 CSRF
            const state = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")

            // Deferred 用于等待回调服务器收到授权码
            const callback = yield* Deferred.make<{ code: string; response: ServerResponse }, Error>()
            // 惰性加载 node:http
            const { createServer } = yield* Effect.promise(() => import("node:http"))
            // 创建回调服务器：只接受 /callback 的 GET 请求
            const server = createServer((request, response) => {
              // 解析请求 URL
              const url = new URL(request.url ?? "/", `http://${callbackHost}`)
              // 非 GET 或路径不对返回 404
              if (request.method !== "GET" || url.pathname !== "/callback") {
                response.writeHead(404).end()
                return
              }
              // 校验回调参数
              const error = callbackError(url.searchParams, state)
              if (error) {
                // 出错时回写错误页并让 Deferred 失败
                response
                  .writeHead(400, { "Content-Type": "text/html" })
                  .end(OauthCallbackPage.error(error, { provider: "GitLab" }))
                Effect.runSync(Deferred.fail(callback, new Error(error)))
                return
              }
              // 成功时完成 Deferred；重复回调返回 409
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
            // 绑定固定端口 8080（GitLab 要求 redirect_uri 精确匹配）
            yield* listen(server)

            // 返回授权结果描述
            return {
              // 自动模式：插件自己等待回调
              mode: "auto" as const,
              // 拼接 GitLab 授权页 URL（含 PKCE 与 state）
              url: `${instanceUrl}/oauth/authorize?${new URLSearchParams({
                client_id: clientID,
                redirect_uri: redirectURI,
                response_type: "code",
                state,
                scope: oauthScope,
                code_challenge: challenge,
                code_challenge_method: "S256",
              }).toString()}`,
              // 给用户看的说明文案
              instructions: "Complete authorization in your browser. This window will close automatically.",
              // 回调处理：用授权码换取令牌
              callback: Effect.gen(function* () {
                // 等待回调服务器收到授权码
                const request = yield* Deferred.await(callback)
                // respond：向浏览器回写成功/失败页面
                const respond = (error?: string) =>
                  Effect.sync(() =>
                    request.response
                      .writeHead(error ? 400 : 200, { "Content-Type": "text/html" })
                      .end(
                        error
                          ? OauthCallbackPage.error(error, { provider: "GitLab" })
                          : OauthCallbackPage.success({ provider: "GitLab" }),
                      ),
                  )
                // 交换令牌；无论成败都回写页面
                return yield* exchange(
                  http,
                  instanceUrl,
                  clientID,
                  {
                    grant_type: "authorization_code",
                    code: request.code,
                    redirect_uri: redirectURI,
                    code_verifier: verifier,
                  },
                  describeGrantFailure,
                ).pipe(
                  Effect.flatMap((tokens) => credential(instanceUrl, clientID, tokens)),
                  Effect.tap(() => respond()),
                  Effect.tapError((error) => respond(error.message)),
                  // Bun's server.closeAllConnections() leaves an unanswered callback response pending.
                  // Bun 下中断时强制销毁悬空的回调响应
                  Effect.onInterrupt(() => Effect.sync(() => request.response.destroy())),
                )
              }),
            }
          }),
      })
    })

    // An OAuth login pins the instance it was issued against, so requests go there too.
    // OAuth 登录固定其签发实例，后续请求也应发往该实例
    const login = yield* credentialSettings(ctx, integrationID, (value) =>
      value.type === "oauth" ? metadataSettings(value.metadata, ["instanceUrl"]) : {},
    )
    // 提供商目录变换：注入实例设置与发现的模型
    yield* ctx.provider.transform((editor) => {
      // 已登录且目录中有该提供商时写入实例设置
      if (login.settings.instanceUrl && editor.get(providerID))
        editor.update(providerID, (provider) => {
          provider.settings = { ...provider.settings, ...login.settings }
        })
      // 取提供商条目
      const item = editor.get(providerID)
      // 未登录或没有发现模型时不发布
      if (!item || !loaded.models?.length) return
      // 追加发布：目录模型 + 发现的 Agent Platform 工作流模型
      editor.add({
        // 提供商信息
        info: item.provider,
        // 来源连接（用于凭据绑定）
        sourceConnection: loaded.connection,
        models: [
          // 保留目录里已有的模型
          ...item.models.values(),
          // 只追加目录中尚未包含的发现模型
          ...loaded.models
            .filter((model) => !item.models.has(model.id))
            .map((model) => ({
              // 以默认信息为基础
              ...Model.Info.default(providerID, Model.ID.make(model.id)),
              // 展示名
              name: `Agent Platform (${model.name})`,
              // 使用 GitLab 专用 SDK 包
              package: Provider.aisdk("gitlab-ai-provider"),
              // 工作流引用
              settings: { workflowRef: model.ref },
              // 能力：支持工具与多模态输入
              capabilities: { tools: true, input: ["text", "image", "pdf"], output: ["text"] },
              // 上下文与输出限制
              limit: { context: model.context, output: model.output },
            })),
        ],
      })
    })
    // refresh：load 报告变化才重载提供商目录
    const refresh = loading.withPermit(ProviderRefresh.reloadIfChanged(load(), ctx.provider.reload()))
    // 凭据切换时触发 refresh
    yield* ProviderRefresh.onSwitch(integrationID, refresh)
    // 启动时也后台执行一次 refresh
    yield* refresh.pipe(Effect.forkScoped)

    // 挂载 "sdk" 钩子：为 gitlab-ai-provider 创建 SDK 实例
    yield* ctx.aisdk.hook(
      "sdk",
      Effect.fn(function* (evt) {
        // 只处理 GitLab 包
        if (evt.package !== "gitlab-ai-provider") return
        // 惰性加载 SDK 包
        const mod = yield* Effect.promise(() => import("gitlab-ai-provider"))
        // 创建 SDK 实例并挂回事件
        evt.sdk = mod.createGitLab({
          ...evt.options,
          // 实例地址：选项 > 环境变量 > gitlab.com
          instanceUrl:
            typeof evt.options.instanceUrl === "string"
              ? evt.options.instanceUrl
              : (process.env.GITLAB_INSTANCE_URL ?? "https://gitlab.com"),
          // API key：选项 > 环境变量
          apiKey: typeof evt.options.apiKey === "string" ? evt.options.apiKey : process.env.GITLAB_TOKEN,
          aiGatewayHeaders: {
            // 网关用 User-Agent 识别客户端
            "User-Agent": `${App.useragent(ctx.app)} gitlab-ai-provider/${mod.VERSION} (${os.platform()} ${os.release()}; ${os.arch()})`,
            // 启用 1M 上下文 beta
            "anthropic-beta": "context-1m-2025-08-07",
            ...evt.options.aiGatewayHeaders,
          },
          featureFlags: {
            // 打开 Duo Agent Platform 相关特性
            duo_agent_platform_agentic_chat: true,
            duo_agent_platform: true,
            ...evt.options.featureFlags,
          },
        })
      }),
    )
    // 挂载 "language" 钩子：由 SDK 实例创建语言模型
    yield* ctx.aisdk.hook(
      "language",
      Effect.fn(function* (evt) {
        // 收集特性开关（缺省空对象）
        const featureFlags =
          typeof evt.options.featureFlags === "object" && evt.options.featureFlags ? evt.options.featureFlags : {}
        // 模型真实 ID
        const id = evt.model.modelID ?? evt.model.id
        // 工作流模型走 workflowChat
        if (id.startsWith("duo-workflow-")) {
          // 惰性加载 SDK 包
          const gitlab = yield* Effect.promise(() => import("gitlab-ai-provider"))
          // 读取工作流引用与定义设置
          const workflowRef =
            typeof evt.model.settings?.workflowRef === "string" ? evt.model.settings.workflowRef : undefined
          const workflowDefinition =
            typeof evt.model.settings?.workflowDefinition === "string"
              ? evt.model.settings.workflowDefinition
              : undefined
          // 创建工作流对话语言模型（ID 合法性由 SDK 判断）
          const language = evt.sdk.workflowChat(gitlab.isWorkflowModel(id) ? id : "duo-workflow", {
            featureFlags,
            workflowDefinition,
          })
          // 有引用时指定具体模型引用
          if (workflowRef) language.selectedModelRef = workflowRef
          evt.language = language
          return
        }
        // 其余模型走 agenticChat
        evt.language = evt.sdk.agenticChat(id, {
          aiGatewayHeaders: evt.options.aiGatewayHeaders,
          featureFlags,
        })
      }),
      { providerID: Provider.ID.gitlab },
    )
  }),
} satisfies PluginInternal.InternalPlugin)

// resolveDefaultInstanceUrl：默认实例地址（环境变量优先，回退 gitlab.com）
function resolveDefaultInstanceUrl() {
  return process.env.GITLAB_INSTANCE_URL ?? "https://gitlab.com"
}

// credentialInstanceUrl：从凭据元数据解析实例地址，缺省用默认值
function credentialInstanceUrl(metadata: Readonly<Record<string, unknown>> | undefined) {
  // 读取元数据里的实例地址
  const value = metadata?.instanceUrl
  // 字符串且非空才有效
  return typeof value === "string" && value ? value : resolveDefaultInstanceUrl()
}

// describeClient：生成 clientID 来源说明（截断显示前 12 位）
function describeClient(clientID: string) {
  // 按匹配关系给出来源描述
  const source =
    clientID === bundledClientID
      ? "bundled default"
      : clientID === legacyClientID
        ? "opencode-gitlab-auth application"
        : "from GITLAB_OAUTH_CLIENT_ID"
  // 拼接说明文案
  return `client_id used: ${clientID.slice(0, 12)}... (${source})`
}

// GitLab returns one generic `invalid_grant` for a reused/expired code, a PKCE
// verifier mismatch, a redirect-URI mismatch, and a missing client-secret alike.
// Surface enough context to tell those apart without leaking the verifier/code.
// GitLab 对“授权码已用/过期、PKCE 不匹配、redirect_uri 不符、缺少密钥”都返回同一个
// generic invalid_grant；这里补充足够上下文帮助区分，同时不泄漏校验器/授权码。
function describeGrantFailure(detail: string, clientID: string) {
  // 是否为用户自定义应用
  const custom = clientID !== bundledClientID
  // 常见原因提示列表
  const hints = [
    "the authorization code was already used, or came from an older login attempt. Codes are" +
      " single-use and bound to one PKCE verifier, so a stale browser tab or a reloaded callback" +
      " page fails here. Start a completely fresh login.",
    `redirect_uri sent: ${redirectURI} — the application must register this exactly`,
    describeClient(clientID),
  ]
  if (custom) {
    // 自定义应用额外提示注册要求
    hints.push(
      "confirm that application registers the redirect URI above, grants the `api` scope, and is" +
        ' NOT marked "Confidential" (PKCE requires a public client). Unset GITLAB_OAUTH_CLIENT_ID to' +
        " fall back to the bundled application.",
    )
  }
  // 拼接最终错误信息
  return `${detail}\n\nLikely causes:\n- ${hints.join("\n- ")}`
}

// describeRefreshFailure：刷新失败的统一说明（令牌被吊销/过期/应用不符）
function describeRefreshFailure(detail: string, clientID: string) {
  return (
    `${detail}\n\nThe GitLab refresh token was revoked, expired, or issued to a different OAuth` +
    ` application (${describeClient(clientID)}). Sign in to GitLab again.`
  )
}

// exchange：向实例的 /oauth/token 发起令牌交换
function exchange(
  http: HttpClient.HttpClient,
  instanceUrl: string,
  clientID: string,
  body: Record<string, string>,
  describe: (detail: string, clientID: string) => string,
) {
  return Effect.gen(function* () {
    // 发起 POST 请求（表单参数 + client_id）
    const response = yield* http
      .execute(
        HttpClientRequest.post(`${instanceUrl}/oauth/token`).pipe(
          HttpClientRequest.bodyUrlParams({ ...body, client_id: clientID }),
        ),
      )
      // 网络层错误统一转换
      .pipe(Effect.mapError(() => new Error("GitLab token exchange request failed")))
    // 非 2xx 时解析错误体
    if (response.status < 200 || response.status >= 300) {
      // 读取文本并解码错误结构
      const parsed = Option.getOrUndefined(decodeError(yield* response.text.pipe(Effect.orElseSucceed(() => ""))))
      // 优先详细描述，回退错误码或状态码
      const detail = parsed?.error_description || parsed?.error || `HTTP ${response.status}`
      // invalid_grant/invalid_client 属于可解释的拒绝，用 describe 补充上下文
      const rejected = parsed?.error === "invalid_grant" || parsed?.error === "invalid_client"
      // 失败
      return yield* Effect.fail(new Error(rejected ? describe(detail, clientID) : detail))
    }
    // 按 Token Schema 解码成功响应
    return yield* HttpClientResponse.schemaBodyJson(Token)(response).pipe(
      Effect.mapError(() => new Error("Invalid GitLab token response")),
    )
  })
}

// credential：把令牌响应构造为 OAuth 凭据（记录实例与 clientID）
function credential(instanceUrl: string, clientID: string, tokens: typeof Token.Type) {
  return Effect.map(Clock.currentTimeMillis, (now) =>
    Credential.OAuth.make({
      type: "oauth",
      methodID,
      access: tokens.access_token,
      refresh: tokens.refresh_token,
      expires: now + (tokens.expires_in ?? 7200) * 1000,
      metadata: { instanceUrl, clientID },
    }),
  )
}

// Joins refreshes of the same refresh token onto one exchange. Successes are retained so callers
// still holding the rotated token reuse the result; failures are dropped so the next caller retries.
// singleFlight：同一刷新令牌的并发刷新合并为一次交换；成功结果保留一段时间供后来者复用，失败则丢弃以便重试。
function singleFlight(key: string, effect: Effect.Effect<Credential.OAuth, Error>) {
  return Effect.gen(function* () {
    // 当前时间
    const now = yield* Clock.currentTimeMillis
    // 清理已过保留期的旧条目
    refreshing.forEach((entry, entryKey) => {
      if (entry.until < now) refreshing.delete(entryKey)
    })
    // 已有进行中/保留中的刷新则直接等待其结果
    const existing = refreshing.get(key)
    if (existing) return yield* Deferred.await(existing.attempt)
    // 新建 Deferred 作为共享结果
    const attempt = Deferred.makeUnsafe<Credential.OAuth, Error>()
    // 先登记（until 无穷大表示进行中）
    refreshing.set(key, { attempt, until: Number.POSITIVE_INFINITY })
    // 执行刷新并在结束时登记结果
    return yield* effect.pipe(
      Effect.onExit((exit) =>
        Effect.map(Clock.currentTimeMillis, (settledAt) => {
          // 成功：保留到保留期结束
          if (Exit.isSuccess(exit)) refreshing.set(key, { attempt, until: settledAt + refreshRetention })
          // 失败：立即删除，让下一个调用方重试
          if (Exit.isFailure(exit)) refreshing.delete(key)
          // 完成共享 Deferred，唤醒等待者
          Deferred.doneUnsafe(attempt, exit)
        }),
      ),
    )
  })
}

// callbackError：校验回调参数，返回错误文案（无错误时 undefined）
function callbackError(params: URLSearchParams, state: string) {
  // state 不匹配视为 CSRF 风险
  if (params.get("state") !== state) return "Invalid OAuth state"
  // 授权方返回错误时给出描述
  if (params.has("error")) return params.get("error_description") || params.get("error") || "Authorization denied"
  // 没有错误时必须携带非空授权码
  return params.get("code")?.trim() ? undefined : "Missing authorization code"
}

// GitLab matches redirect_uri exactly, so the port cannot be ephemeral.
// listen：绑定固定端口的回调服务器（GitLab 要求 redirect_uri 精确匹配，端口不能随机）
function listen(server: Server) {
  return Effect.callback<void, Error>((resume) => {
    // 监听一次 error 事件
    const onError = (error: Error) => resume(Effect.fail(error))
    server.once("error", onError)
    // 绑定成功：移除监听并恢复
    server.listen(callbackPort, callbackHost, () => {
      server.off("error", onError)
      resume(Effect.void)
    })
  }).pipe(
    // 端口被占用时给出可操作的错误信息
    Effect.mapError((cause) =>
      "code" in cause && cause.code === "EADDRINUSE"
        ? new Error(
            `GitLab login needs local port ${callbackPort}, but it is already in use. Stop the process using that port and try again.`,
          )
        : cause,
    ),
  )
}
