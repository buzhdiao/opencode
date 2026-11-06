// OAuth 方式注册类型
import type { IntegrationOAuthMethodRegistration } from "@opencode/plugin/effect/integration"
// 插件上下文类型
import type { Context } from "@opencode/plugin/effect/plugin"
// define：插件定义辅助函数
import { define } from "@opencode/plugin/effect/plugin"
// import { Deferred, Duration, Effect, Option, Schema, Semaphore, Stream } from "effect"
// Effect 生态：延迟值、效果、相等性、Option、Schema、信号量
import { Deferred, Effect, Equal, Option, Schema, Semaphore } from "effect"
// HTTP 客户端相关
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
// node:http 类型
import type { Server, ServerResponse } from "node:http"
// App：应用元信息
import { App } from "../../app.js"
// Credential：凭据服务与类型
import { Credential } from "../../credential.js"
// Integration：集成 ID 等类型
import { Integration } from "../../integration.js"
// import { IntegrationConnection } from "../../integration/connection.js"
// Model：模型类型
import { Model } from "../../model.js"
// OAuth 回调页面渲染
import { OauthCallbackPage } from "../../oauth/page.js"
// Provider：提供商 ID
import { Provider } from "../../provider.js"
// SessionAffinity：会话亲和键计算
import { SessionAffinity } from "../../session/affinity.js"
// PluginInternal：内部插件类型
import type { PluginInternal } from "../internal.js"
// configuredSettings：读取提供商的用户配置
import { configuredSettings } from "./configured.js"
// activeCredential：读取当前活跃凭据
import { activeCredential } from "./credential-settings.js"
// ProviderRefresh：提供商切换刷新辅助
import { ProviderRefresh } from "./refresh.js"

// First-time sign-in registers a user-owned client; OpenAI returns its issued client ID on the callback.
// 首次登录用该占位 ID 注册用户自有客户端；OpenAI 在回调中返回实际签发的 client ID。
const registrationClientID = "dynamic_agent_client"
// OAuth 注册时声明的 agent 名称
const agentName = "OpenCode"
// OpenAI 授权服务器 issuer
const issuer = "https://auth.openai.com"
// 令牌端点
const tokenURL = `${issuer}/api/accounts/oauth/token`
// 令牌的目标资源（API 根）
const resource = "https://api.openai.com/v1"
// 令牌共享（token sharing）所需的 OAuth 作用域
const tokenSharingScope = "chatgpt.tokens.use.direct"
// 提供商 ID：OpenAI
const providerID = Provider.ID.openai
// 集成 ID：openai
const integrationID = Integration.ID.make("openai")
// 认证方式 ID：ChatGPT 令牌共享
const methodID = Integration.MethodID.make("chatgpt-token-sharing")
// 模型列表缓存的存储键
const modelCacheKey = (clientID: string) => `models:${clientID}`
// 令牌共享模式下可用的兜底模型集合
const fallbackModels = new Set([
  // 逐一列出兜底模型 ID
  "gpt-5.5",
  "gpt-5.5-fast",
  "gpt-5.6-luna",
  "gpt-5.6-luna-fast",
  "gpt-5.6-sol",
  "gpt-5.6-sol-fast",
  "gpt-5.6-terra",
  "gpt-5.6-terra-fast",
  "gpt-6-astra",
  "gpt-6-astra-fast",
  "gpt-6-luna",
  "gpt-6-luna-fast",
  "gpt-6-sol",
  "gpt-6-sol-fast",
  "gpt-6.1-sol",
  "gpt-6.1-sol-fast",
  "gpt-6.1-terra",
  "gpt-6.1-terra-fast",
])
// 这些错误码不可重试：令牌共享配额/资格/能力类问题
const nonRetryableSharingCodes = [
  // 逐一列出错误码
  "subscription_sharing_usage_limit_exceeded",
  "subscription_sharing_user_not_eligible",
  "subscription_sharing_unsupported_capability",
  "subscription_sharing_route_not_supported",
  "subscription_sharing_invalid_user",
  "chatpass_v2_scope_not_authorized",
  "chatpass_v2_invalid_authorization_context",
]
// Pkce：PKCE 校验对（验证串与挑战值）
type Pkce = {
  // 验证串
  verifier: string
  // 挑战值
  challenge: string
}

// TokenResponse：令牌端点响应结构
type TokenResponse = {
  // 访问令牌
  access_token: string
  // 刷新令牌
  refresh_token: string
  // ID 令牌（可选）
  id_token?: string
  // 有效期秒数（可选）
  expires_in?: number
  // 授权作用域（可选）
  scope?: string
}

// RemoteModel：远端模型条目 Schema
const RemoteModel = Schema.Struct({
  // 模型 slug
  slug: Schema.String,
  // 显示名
  display_name: Schema.String,
  // 可见性
  visibility: Schema.String,
  // 是否 API 可用
  supported_in_api: Schema.Boolean,
  // 上下文窗口（必须大于 1）
  context_window: Schema.Int.check(Schema.isGreaterThan(1)),
  // 输入模态列表
  input_modalities: Schema.Array(Schema.String),
  // 支持的推理等级（可选）
  supported_reasoning_levels: Schema.optional(Schema.Array(Schema.Struct({ effort: Schema.String }))),
})
// 远端模型的类型形态
type RemoteModel = typeof RemoteModel.Type
// 模型列表响应结构
const RemoteModels = Schema.Struct({ models: Schema.Array(RemoteModel) })
// 缓存中模型数组的解码器（Option 形态）
const decodeCachedModels = Schema.decodeUnknownOption(Schema.Array(RemoteModel))

// 凭据元数据的解码器（clientID 必填，scopes/models 可选）
const decodeMetadata = Schema.decodeUnknownOption(
  // 元数据结构
  Schema.Struct({
    // 注册的客户端 ID
    clientID: Schema.String,
    // 授权作用域列表（可选）
    scopes: Schema.optional(Schema.Array(Schema.String)),
    // 缓存的模型列表（可选）
    models: Schema.optional(Schema.Array(RemoteModel)),
  }),
)

// signIn：构造"Sign in with ChatGPT"的 OAuth 方式注册对象
const signIn = (app: App.Info, savedClientID: () => string | undefined, storage: Context["storage"]) =>
  ({
    // 所属集成 ID
    integrationID,
    // 方式描述
    method: {
      // 方式 ID
      id: methodID,
      // 类型：OAuth
      type: "oauth",
      // 显示标签
      label: "Sign in with ChatGPT",
    },
    // authorize：发起授权（启动本地回调服务器等）
    authorize: () =>
      // 组织逻辑
      Effect.gen(function* () {
        // 读取已存的主机 ID（标识本次安装）
        const storedHostID = yield* storage.get("chatgpt-agent-host-id")
        // 无则生成 UUID 形态的主机 ID
        const hostID = typeof storedHostID === "string" ? storedHostID : `urn:uuid:${crypto.randomUUID()}`
        // 首次生成时持久化
        if (typeof storedHostID !== "string") yield* storage.set("chatgpt-agent-host-id", hostID)
        // 生成 PKCE 校验对
        const pkce = yield* Effect.promise(generatePKCE)
        // 生成 state 防 CSRF
        const state = randomValue()
        // 生成 nonce 防 ID 令牌重放
        const nonce = randomValue()
        // 读取之前注册的客户端 ID
        const savedID = savedClientID()
        // 创建延迟值：等待回调结果
        const received = yield* Deferred.make<{ code: string; clientID?: string; response: ServerResponse }, Error>()
        // Lazy so runtimes without a loopback listener (workerd) never evaluate node:http.
        // 惰性加载 node:http，避免无回环监听能力的运行时（workerd）触碰它。
        const { createServer } = yield* Effect.promise(() => import("node:http"))
        // 创建本地回调服务器
        const server = createServer((request, response) => {
          // 解析请求 URL
          const url = new URL(request.url ?? "/", "http://127.0.0.1")
          // 非回调路径返回 404
          if (url.pathname !== "/auth/callback") {
            // 写 404 响应
            response.writeHead(404).end("Not found")
            // 结束处理
            return
          }
          // 读取错误描述或错误码
          const error = url.searchParams.get("error_description") ?? url.searchParams.get("error")
          // 读取授权码
          const authorizationCode = url.searchParams.get("code")
          // 授权方返回错误时
          if (error) {
            // 通知等待方失败
            Effect.runFork(Deferred.fail(received, new Error(error)))
            // 返回 400 错误页
            response
              .writeHead(400, { "Content-Type": "text/html" })
              .end(OauthCallbackPage.error(error, { provider: "ChatGPT" }))
            // 结束处理
            return
          }
          // 缺授权码或 state 不匹配
          if (!authorizationCode || url.searchParams.get("state") !== state) {
            // 组装错误信息
            const message = authorizationCode ? "Invalid OAuth state" : "Missing authorization code"
            // 通知等待方失败
            Effect.runFork(Deferred.fail(received, new Error(message)))
            // 返回 400 错误页
            response
              .writeHead(400, { "Content-Type": "text/html" })
              .end(OauthCallbackPage.error(message, { provider: "ChatGPT" }))
            // 结束处理
            return
          }
          // 尝试完成延迟值（已完成为 false）
          if (
            !Effect.runSync(
              Deferred.succeed(received, {
                // 授权码
                code: authorizationCode,
                // 回调返回的客户端 ID（可选）
                clientID: url.searchParams.get("client_id") ?? undefined,
                // 原始响应对象
                response,
              }),
            )
          )
            // 重复回调返回 409
            response.writeHead(409).end("OAuth callback already received")
        })
        // 启动监听并取得端口
        const port = yield* listen(server)
        // 注册清理器：作用域结束时关闭服务器
        yield* Effect.addFinalizer(() => Effect.sync(() => server.close()))
        // 组装重定向 URI
        const redirect = `http://127.0.0.1:${port}/auth/callback`
        // 返回授权描述
        return {
          // 自动模式
          mode: "auto" as const,
          // 授权 URL
          url: authorizeURL(redirect, pkce, state, nonce, savedID, hostID),
          // 用户指引
          instructions: "Complete authorization in your browser. This window will close automatically.",
          // callback：等待回调并换取令牌
          callback: Effect.gen(function* () {
            // 等待回调结果
            const result = yield* Deferred.await(received)
            // respond：向浏览器回写成功/失败页面
            const respond = (error?: string) =>
              // 同步写响应
              Effect.sync(() =>
                result.response
                  // 状态码按有无错误决定
                  .writeHead(error ? 400 : 200, { "Content-Type": "text/html" })
                  // 渲染成功或错误页
                  .end(
                    error
                      ? OauthCallbackPage.error(error, { provider: "ChatGPT" })
                      : OauthCallbackPage.success({ provider: "ChatGPT" }),
                  ),
              )
            // 主换令牌流程
            return yield* Effect.gen(function* () {
              // Reauthorization callbacks may omit the client ID; reuse the one this attempt started with.
              // 回调返回的客户端 ID 与本次尝试使用的不一致：拒绝（可能连错账号）。
              if (savedID && result.clientID && result.clientID !== savedID)
                // 返回失败
                return yield* Effect.fail(
                  new Error("ChatGPT returned a different client than this connection. Connect again."),
                )
              // 客户端 ID：优先沿用旧的，否则取回调返回的
              const clientID = savedID ?? result.clientID
              // 拿不到客户端 ID 则失败
              if (!clientID)
                // 返回失败
                return yield* Effect.fail(new Error("ChatGPT sign-in did not return a client ID. Connect again."))
              // 用授权码换取令牌
              const tokens = yield* exchange(result.code, clientID, redirect, pkce, app)
              // 授权作用域必须包含令牌共享
              if (!tokens.scope?.split(" ").includes(tokenSharingScope))
                // 返回失败
                return yield* Effect.fail(
                  new Error(
                    "ChatGPT sign-in finished without token sharing. Sign in again and allow token sharing, or connect OpenAI with an API key.",
                  ),
                )
              // 必须返回 ID 令牌
              if (!tokens.id_token) return yield* Effect.fail(new Error("ChatGPT sign-in did not return an ID token."))
              // 校验 ID 令牌（签名/受众/nonce）
              yield* verifyIDToken(tokens.id_token, clientID, nonce)
              // 构造凭据返回
              return credential(tokens, clientID)
            }).pipe(
              // 成功时回写成功页
              Effect.tap(() => respond()),
              // 失败时回写错误页
              Effect.tapError((error) => respond(error instanceof Error ? error.message : "ChatGPT sign-in failed")),
              // 被中断时销毁响应连接
              Effect.onInterrupt(() => Effect.sync(() => result.response.destroy())),
            )
          }),
        }
      }),
    // refresh：刷新 OAuth 令牌
    refresh: (value) => refresh(value, app),
    // 满足 OAuth 方式注册类型
  }) satisfies IntegrationOAuthMethodRegistration

// listen：在随机回环端口启动服务器并返回端口
function listen(server: Server) {
  // 以回调式效果包装
  return Effect.callback<number, Error>((resume) => {
    // 错误监听器
    const onError = (error: Error) => resume(Effect.fail(error))
    // 先挂错误监听
    server.once("error", onError)
    // 监听随机回环端口
    server.listen(0, "127.0.0.1", () => {
      // 成功后移除错误监听
      server.off("error", onError)
      // 读取监听地址
      const address = server.address()
      // 地址缺失或为管道名时失败
      if (!address || typeof address === "string") return resume(Effect.fail(new Error("Missing OAuth callback port")))
      // 恢复端口
      resume(Effect.succeed(address.port))
    })
  })
}

// 定义 ChatGPT 提供商插件
export const ChatGPTPlugin = define({
  // 插件唯一标识
  id: "opencode.provider.chatgpt",
  // 插件激活时执行的生成器主体
  effect: Effect.fn(function* (ctx) {
    // 凭据服务
    const credentials = yield* Credential.Service
    // 容量为 1 的信号量：串行化重载流程
    const loading = Semaphore.makeUnsafe(1)
    // 当前 ChatGPT OAuth 凭据
    let chatgpt: Credential.OAuth | undefined
    // let available: ReadonlyArray<RemoteModel> | undefined
    // 当前凭据来源连接
    let source: Effect.Success<ReturnType<typeof ctx.integration.connection.active>>

    // load：读取活跃凭据并更新内存状态，返回来源是否变化
    const load = Effect.fn("ChatGPTPlugin.load")(function* () {
      // const previous = IntegrationConnection.key(source)
      // 读取活跃凭据
      const { connection, credential } = yield* activeCredential(ctx, integrationID)
      // 仅 chatgpt-token-sharing 方式的 OAuth 凭据有效
      chatgpt = credential?.type === "oauth" && credential.methodID === methodID ? credential : undefined
      // 记录旧来源
      const previous = source
      // 更新当前来源
      source = chatgpt ? connection : undefined
      // if (previous !== IntegrationConnection.key(source)) {
      //   const metadata = Option.getOrUndefined(decodeMetadata(chatgpt?.metadata))
      //   const stored = metadata ? yield* ctx.storage.get(modelCacheKey(metadata.clientID)) : undefined
      //   available = Option.getOrUndefined(decodeCachedModels(stored))
      // }
      // 返回来源是否发生变化
      return !Equal.equals(previous, source)
    })

    // 登记 ChatGPT OAuth 登录方式
    yield* ctx.integration.transform((editor) => {
      // 注册 signIn 方式（客户端 ID 由闭包动态读取）
      editor.method.update(
        // 构造注册对象
        signIn(ctx.app, () => Option.getOrUndefined(decodeMetadata(chatgpt?.metadata))?.clientID, ctx.storage),
      )
    })
    // 迁移旧版 chatgpt-browser 凭据到新方式，并迁移其缓存的模型列表
    yield* Effect.forEach(
      // 列出 openai 集成的全部凭据
      yield* credentials.list(Integration.ID.make("openai")),
      (entry) => {
        // 取凭据值
        const value = entry.value
        // 只处理旧 chatgpt-browser 方式的 OAuth 凭据
        if (value.type !== "oauth" || value.methodID !== Integration.MethodID.make("chatgpt-browser"))
          // 其余跳过
          return Effect.void
        // 解码元数据
        const metadata = Option.getOrUndefined(decodeMetadata(value.metadata))
        // 无元数据则跳过
        if (!metadata) return Effect.void
        // 迁移逻辑
        return Effect.gen(function* () {
          // 读取该客户端已缓存的模型列表
          const saved = yield* ctx.storage.get(modelCacheKey(metadata.clientID))
          // 缓存缺失且元数据带模型时写入缓存
          if (!Option.isSome(decodeCachedModels(saved)) && metadata.models)
            // 写入模型缓存
            yield* ctx.storage.set(modelCacheKey(metadata.clientID), metadata.models)
          // 元数据中剔除 models 字段
          const { models: _, ...rest } = value.metadata ?? {}
          // 更新凭据为新方式 ID（保留其余元数据）
          yield* credentials.update(entry.id, {
            // 新凭据值
            value: Credential.OAuth.make({ ...value, methodID, metadata: rest }),
          })
        })
      },
      // 逐项执行不收集结果
      { discard: true },
    )
    // 初始加载一次
    yield* load()
    // 注册重试钩子：令牌共享配额类错误不重试
    yield* ctx.session.hook(
      // 钩子名：retry
      "retry",
      (event) =>
        // 同步决策
        Effect.sync(() => {
          // 无凭据或错误不匹配则不干预
          if (!chatgpt || !nonRetryableSharingCodes.some((code) => event.error.response?.body.includes(code))) return
          // 设置不重试
          event.decision = { retry: false }
        }),
      // 仅对 OpenAI 提供商生效
      { providerID },
    )
    // 注册模型请求钩子：附加会话相关请求头
    yield* ctx.session.hook(
      // 钩子名：model.request
      "model.request",
      (evt) =>
        // 组织逻辑
        Effect.gen(function* () {
          // 无凭据时不处理
          if (!chatgpt) return
          // 查询会话（失败得 undefined）
          const session = yield* ctx.session
            // 按会话 ID 获取
            .get({ sessionID: evt.sessionID })
            // 失败时以 undefined 继续
            .pipe(Effect.orElseSucceed(() => undefined))
          // Mirror the Codex client's session headers: ChatGPT derives prompt-cache affinity from session-id.
          // 镜像 Codex 客户端的会话头：ChatGPT 依据 session-id 推导提示缓存亲和。
          evt.headers["session-id"] = session ? SessionAffinity.get(session) : evt.sessionID
          // 会话线程 ID
          evt.headers["thread-id"] = evt.sessionID
          // 客户端请求 ID
          evt.headers["x-client-request-id"] = evt.sessionID
        }),
      // 仅对 OpenAI 提供商生效
      { providerID },
    )
    // Config applies after provider plugins, so read it here: a custom baseURL may not decode zstd.
    // 配置在提供商插件之后生效，这里先行读取：自定义 baseURL 可能不支持 zstd 解码。
    const configured = yield* configuredSettings(providerID)
    // 调整 OpenAI 提供商定义并按连接重新绑定
    yield* ctx.provider.transform((providers) => {
      // 读取当前提供商
      const item = providers.get(providerID)
      // 不存在则结束
      if (!item) return
      // 无凭据或来源时不处理
      if (!chatgpt || !source) return
      // 更新提供商设置
      providers.update(providerID, (provider) => {
        // 合并覆盖设置
        provider.settings = Provider.mergeOverlay(provider.settings, {
          // 指向 ChatGPT 资源端点
          baseURL: resource,
          // 强制 HTTP 传输
          transport: "http",
          // 压缩方式：摘要式
          compaction: { type: "summary" },
          // ChatGPT sign-in rejects uncompressed bodies over ~1 MiB and decodes zstd.
          // 未配置自定义 baseURL 时启用 zstd（过大未压缩体会被拒绝，且端点支持 zstd）。
          ...(configured?.baseURL === undefined ? { encoding: provider.settings?.encoding ?? "zstd" } : {}),
        })
      })
      // 重新读取更新后的提供商
      const updated = providers.get(providerID)
      // 不存在则结束
      if (!updated) return
      // 以当前连接重新绑定提供商
      providers.add({
        // 提供商信息
        info: updated.provider,
        // models: available
        //   ? deriveModels(available, Array.from(item.models.values()))
        //   : Array.from(item.models.values()).filter((model) => fallbackModels.has(model.id)),
        // 模型列表过滤为兜底集合
        models: Array.from(item.models.values()).filter((model) => fallbackModels.has(model.id)),
        // 绑定当前连接
        sourceConnection: source,
      })
    })
    // 调整令牌共享模式下的模型行为
    yield* ctx.model.transform((models) => {
      // 遍历 OpenAI 全部模型
      for (const model of models.list(providerID)) {
        // 逐个更新
        models.update(model.providerID, model.id, (draft) => {
          // 无凭据则不改
          if (!chatgpt) return
          // 令牌共享下不支持 effort 动态更新
          draft.compatibility = { ...draft.compatibility, supportsEffortUpdates: false }
          // Token sharing does not support native /responses/compact.
          // 令牌共享不支持原生压缩端点，改用摘要式压缩。
          draft.settings = { ...draft.settings, compaction: { type: "summary" } }
          // pro 推理模式的模型不开放给令牌共享
          if (Schema.is(Schema.Struct({ mode: Schema.Literal("pro") }))(draft.body?.reasoning)) {
            // 禁用该模型
            draft.enabled = false
            // 结束
            return
          }
          // if (available && !available.some((remote) => remote.slug === (draft.modelID ?? draft.id))) {
          //   draft.enabled = false
          //   return
          // }
          // 令牌共享不计费
          draft.cost = []
        })
      }
    })
    // const refreshModels = Effect.fn("ChatGPTPlugin.refreshModels")(function* () {
    //   const connection = source
    //   const credential =
    //     connection?.type === "credential"
    //       ? (yield* credentials.get(Credential.ID.make(connection.id)))?.value
    //       : undefined
    //   if (credential?.type !== "oauth" || credential.methodID !== methodID || credential.expires <= Date.now() + 60_000)
    //     return
    //   const metadata = Option.getOrUndefined(decodeMetadata(credential.metadata))
    //   if (!metadata) return
    //   const models = yield* fetchModels(credential.access, ctx.app).pipe(
    //     Effect.timeout(15_000),
    //     Effect.catch(() => Effect.logWarning("failed to refresh ChatGPT models").pipe(Effect.as(undefined))),
    //   )
    //   if (!models) return
    //   yield* loading.withPermit(
    //     Effect.gen(function* () {
    //       if (
    //         IntegrationConnection.key(connection) !== IntegrationConnection.key(source) ||
    //         IntegrationConnection.key(connection) !==
    //           IntegrationConnection.key(yield* ctx.integration.connection.active(integrationID))
    //       )
    //         return
    //       if (JSON.stringify(models) === JSON.stringify(available)) return
    //       yield* ctx.storage.set(modelCacheKey(metadata.clientID), models)
    //       available = models
    //       yield* ctx.provider.reload()
    //     }),
    //   )
    // })
    // .pipe(Effect.andThen(refreshModels().pipe(Effect.forkScoped, Effect.asVoid)))
    // 切换连接时：信号量保护下按需重载提供商
    yield* ProviderRefresh.onSwitch(
      // 所属集成
      integrationID,
      // 来源变化才重载
      loading.withPermit(ProviderRefresh.reloadIfChanged(load(), ctx.provider.reload())),
    )
    // yield* refreshModels().pipe(Effect.forkScoped)
    // yield* Effect.sleep(Duration.minutes(15)).pipe(Effect.andThen(refreshModels), Effect.forever, Effect.forkScoped)
  }),
  // 满足内部插件类型
} satisfies PluginInternal.InternalPlugin)

// headers：令牌端点请求的公共头
function headers(app: App.Info) {
  // 表单编码与 UA
  return { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": App.useragent(app) }
}

// exchange：用授权码换取令牌
function exchange(code: string, clientID: string, redirect: string, pkce: Pkce, app: App.Info) {
  // POST 令牌端点
  return request<TokenResponse>(tokenURL, {
    // POST 方法
    method: "POST",
    // 公共头
    headers: headers(app),
    // 表单体
    body: new URLSearchParams({
      // 授权码模式
      grant_type: "authorization_code",
      // 客户端 ID
      client_id: clientID,
      // 授权码
      code,
      // PKCE 验证串
      code_verifier: pkce.verifier,
      // 重定向 URI
      redirect_uri: redirect,
      // 目标资源
      resource,
      // 序列化为表单
    }).toString(),
  })
}

// refresh：用刷新令牌换取新令牌
function refresh(value: Credential.OAuth, app: App.Info) {
  // 组织逻辑
  return Effect.gen(function* () {
    // 解码元数据
    const metadata = Option.getOrUndefined(decodeMetadata(value.metadata))
    // 缺客户端 ID 则失败
    if (!metadata)
      // 返回错误
      return yield* Effect.fail(new Error("This ChatGPT connection has no registered client ID. Connect again."))
    // POST 令牌端点
    const tokens = yield* request<TokenResponse>(tokenURL, {
      // POST 方法
      method: "POST",
      // 公共头
      headers: headers(app),
      // 表单体
      body: new URLSearchParams({
        // 刷新令牌模式
        grant_type: "refresh_token",
        // 客户端 ID
        client_id: metadata.clientID,
        // 刷新令牌
        refresh_token: value.refresh,
        // 目标资源
        resource,
        // 序列化
      }).toString(),
    })
    // 构造新凭据
    return credential(tokens, metadata.clientID, metadata.scopes)
  })
}

// fetchModels：拉取账号可用的模型列表
export function fetchModels(token: string, app: App.Info, baseURL = resource) {
  // 组织逻辑
  return Effect.gen(function* () {
    // HTTP 客户端（仅放行 2xx）
    const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
    // GET 模型列表
    const response = yield* http.execute(
      // 构造请求
      HttpClientRequest.get(`${baseURL}/models`).pipe(
        // Bearer 令牌
        HttpClientRequest.bearerToken(token),
        // UA
        HttpClientRequest.setHeader("User-Agent", App.useragent(app)),
      ),
    )
    // 解析响应
    const data = yield* HttpClientResponse.schemaBodyJson(RemoteModels)(response)
    // 过滤：可见且 API 可用
    const models = data.models.filter((model) => model.visibility === "list" && model.supported_in_api)
    // 无可用模型则失败
    if (!models.length) return yield* Effect.fail(new Error("No ChatGPT models are available for this account."))
    // 返回模型列表
    return models
  })
}

// deriveModels：把远端模型列表与本地目录合并
export function deriveModels(remote: ReadonlyArray<RemoteModel>, existing: ReadonlyArray<Model.Info>) {
  // 远端按 slug 索引
  const byID = new Map(remote.map((model) => [model.slug, model]))
  // 本地已有模型 ID 集合
  const known = new Set(existing.map((model) => model.id))
  // 合并结果
  return [
    // 先处理本地已有模型
    ...existing.flatMap((model) => {
      // 按 modelID 找远端对应项
      const found = byID.get(model.modelID)
      // 找到则派生更新
      return found ? [deriveModel(found, model)] : []
    }),
    // 再处理远端新增模型
    ...remote
      // 过滤本地未收录的
      .filter((model) => !known.has(Model.ID.make(model.slug)))
      // 以默认模型信息为基底派生
      .map((model) => deriveModel(model, Model.Info.default(Provider.ID.openai, Model.ID.make(model.slug)))),
  ]
}

// deriveModel：把远端模型条目合并进已有模型信息
function deriveModel(remote: RemoteModel, previous: Model.Info): Model.Info {
  // 返回合并后的信息
  return {
    // 保留原字段
    ...previous,
    // 原生 ID 模型采用远端显示名
    name: previous.id === previous.modelID ? remote.display_name : previous.name,
    // 包名回退到 OpenAI 官方包
    package: previous.package ?? "@opencode/ai/providers/openai",
    // 能力合并
    capabilities: {
      // 保留原能力
      ...previous.capabilities,
      // 输入模态仅保留文本与图像
      input: remote.input_modalities.filter((modality) => modality === "text" || modality === "image"),
    },
    // 变体合并
    variants: [
      // 保留非推理 effort 变体
      ...previous.variants.filter((variant) => typeof variant.settings?.reasoningEffort !== "string"),
      // 远端支持的推理等级映射为变体
      ...(remote.supported_reasoning_levels ?? []).map(
        ({ effort }) =>
          // 优先复用本地已有的同 effort 变体
          previous.variants.find(
            (variant) => variant.id === effort && variant.settings?.reasoningEffort === effort,
          ) ?? { id: Model.VariantID.make(effort), settings: { reasoningEffort: effort } },
      ),
    ],
    // 上下文窗口取远端，输出限制沿用本地
    limit: { context: remote.context_window, output: previous.limit.output },
  }
}

// verifyIDToken：校验 OpenAI 签发的 ID 令牌
export function verifyIDToken(
  // ID 令牌
  token: string,
  // 期望受众（客户端 ID）
  clientID: string,
  // 期望 nonce
  nonce: string,
  // JWKS 端点（默认 issuer 下）
  jwksURL = new URL(`${issuer}/.well-known/jwks.json`),
) {
  // 以 Promise 效果包装
  return Effect.tryPromise({
    // 校验逻辑
    try: async () => {
      // 动态加载 jose 库
      const { createRemoteJWKSet, jwtVerify } = await import("jose")
      // 校验 JWT：issuer/受众/算法/必备声明
      const { payload } = await jwtVerify(token, createRemoteJWKSet(jwksURL), {
        // 签发者
        issuer,
        // 受众
        audience: clientID,
        // 算法
        algorithms: ["RS256"],
        // 必备声明
        requiredClaims: ["exp", "nonce", "sub"],
      })
      // sub 必须为非空字符串
      if (typeof payload.sub !== "string" || !payload.sub.trim()) throw new Error("ID token subject is missing")
      // nonce 必须与本次登录一致
      if (payload.nonce !== nonce) throw new Error("ID token nonce does not match this sign-in attempt")
    },
    // 任何失败统一转为带说明的错误
    catch: (cause) => new Error("ChatGPT sign-in returned an invalid ID token.", { cause }),
  })
}

// request：通用 HTTP 请求（JSON 响应，非 2xx 报错）
function request<A>(url: string, init: RequestInit) {
  // Promise 效果包装
  return Effect.tryPromise({
    // 请求逻辑
    try: async (signal) => {
      // 发起请求（携带中断信号）
      const response = await fetch(url, { ...init, signal })
      // 非 2xx 抛错
      if (!response.ok) throw new Error(`Request failed: ${response.status}`)
      // 解析 JSON
      return response.json() as Promise<A>
    },
    // 错误原样上抛
    catch: (cause) => cause,
  })
}

// credential：把令牌响应包装成 OAuth 凭据
function credential(tokens: TokenResponse, clientID: string, scopes?: ReadonlyArray<string>) {
  // 构造凭据
  return Credential.OAuth.make({
    // 类型：OAuth
    type: "oauth",
    // 方式 ID
    methodID,
    // 刷新令牌
    refresh: tokens.refresh_token,
    // 访问令牌
    access: tokens.access_token,
    // 过期时间（默认 1 小时）
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    // 元数据：客户端 ID 与作用域
    metadata: { clientID, scopes: tokens.scope?.split(" ").filter(Boolean) ?? scopes ?? [] },
  })
}

// generatePKCE：生成 PKCE 验证串与挑战值
async function generatePKCE(): Promise<Pkce> {
  // 可用字符集（RFC 7636 unreserved）
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
  // 43 字节随机取样构造验证串
  const verifier = Array.from(crypto.getRandomValues(new Uint8Array(43)), (byte) => chars[byte % chars.length]).join("")
  // SHA-256 摘要后做 base64url 得到挑战值
  const challenge = base64UrlEncode(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))
  // 返回校验对
  return { verifier, challenge }
}

// randomValue：32 字节随机的 base64url 字符串
function randomValue() {
  // 取随机字节并编码
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer)
}

// base64UrlEncode：把 ArrayBuffer 编码为 base64url
function base64UrlEncode(buffer: ArrayBuffer) {
  // Buffer 的 base64url 编码
  return Buffer.from(buffer).toString("base64url")
}

// authorizeURL：构造授权端点 URL
function authorizeURL(
  // 重定向 URI
  redirect: string,
  // PKCE 校验对
  pkce: Pkce,
  // state
  state: string,
  // nonce
  nonce: string,
  // 已注册客户端 ID（可选）
  savedID: string | undefined,
  // 主机 ID
  hostID: string,
) {
  // 拼接查询串
  return `${issuer}/api/accounts/authorize?${new URLSearchParams({
    client_id: savedID ?? registrationClientID,
    ...(savedID ? {} : { agent_name_hint: agentName }),
    ext_agent_host_id: hostID,
    // Enable only for user-requested consent retries after OpenAI confirms deployment;
    // ordinary sign-ins must not force reconsent.
    // force_reconsent: "true",
    response_type: "code",
    redirect_uri: redirect,
    scope: `openid profile email offline_access resource.invoke ${tokenSharingScope}`,
    resource,
    state,
    nonce,
    code_challenge_method: "S256",
    code_challenge: pkce.challenge,
  })}`
}
