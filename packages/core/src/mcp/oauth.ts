// 将本模块以命名空间 McpOAuth 整体再导出（barrel 模式）
export * as McpOAuth from "./oauth.js"

// 引入 MCP SDK 的 OAuth 相关能力：auth 流程、最新协议版本、资源校验、服务器信息发现、
// WWW-Authenticate 参数提取、错误响应解析、资源 URL 推导、未授权错误及若干类型
import {
  auth,
  LATEST_PROTOCOL_VERSION,
  checkResourceAllowed,
  discoverOAuthServerInfo,
  extractWWWAuthenticateParams,
  parseErrorResponse,
  resourceUrlFromServerUrl,
  UnauthorizedError,
  type FetchLike,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client"
// 引入 OAuth 元数据 schema（授权服务器元数据与 OpenID 发现元数据）
import { OAuthMetadataSchema, OpenIdProviderDiscoveryMetadataSchema } from "@modelcontextprotocol/core"
// 引入 Effect：原因、Deferred（一次性结果）、Effect
import { Cause, Deferred, Effect } from "effect"
// 引入 Effect 的 fetch HTTP 客户端标记
import { FetchHttpClient } from "effect/http"
// 仅引入类型：node 的 ServerResponse（回调 HTTP 响应）
import type { ServerResponse } from "node:http"
// 仅引入类型：node 的 AddressInfo（监听地址信息）
import type { AddressInfo } from "node:net"
// 引入 MCP 配置 schema
import { ConfigMCP } from "@opencode/schema/config/mcp"
// 引入凭证（Credential）服务
import { Credential } from "../credential.js"
// 引入 OAuth 回调页面渲染
import { OauthCallbackPage } from "../oauth/page.js"
// 仅引入类型：集成（Integration）类型
import type { Integration } from "../integration.js"
// 引入错误摘要辅助
import { ErrorSummary } from "../util/error-summary.js"

/** Client ID Metadata Document: servers that support CIMD accept this URL as the client_id without registration. */
// CIMD（Client ID Metadata Document）：支持该机制的服务器直接以这个 URL 作为 client_id，无需动态注册
export const CLIENT_METADATA_URL = "https://opencode.ai/oauth/opencode/client.json"

// Refresh tokens rotate, so concurrent refreshes of the same token share one request or the second gets invalid_grant.
// 刷新令牌会轮换：同一令牌的并发刷新必须共享一次请求，否则第二次会得到 invalid_grant
const refreshes = new Map<string, ReturnType<FetchLike>>()

// refreshKey：识别一次“刷新令牌”请求的键（URL + client_id + refresh_token）
const refreshKey = (url: string | URL, init: RequestInit | undefined) => {
  // 请求体不是 URLSearchParams 或 grant_type 不是 refresh_token 时返回 undefined
  if (!(init?.body instanceof URLSearchParams) || init.body.get("grant_type") !== "refresh_token") return undefined
  // 用 NUL 分隔拼出键
  return [String(url), init.body.get("client_id") ?? "", init.body.get("refresh_token") ?? ""].join("\u0000")
}

// Bun's and Node's fetch types both apply here and the SDK's FetchLike wants Bun's Response, so the
// overload is picked by annotation and clone() is pinned to the type it was called on. A tool call
// can stay silent for minutes, so Bun's idle deadline is off; the MCP execution timeout still applies.
// share：把进行中的请求 Promise 克隆一份响应返回，让并发等待者各拿到独立响应体
const share = (pending: ReturnType<FetchLike>) => pending.then((response) => response.clone() as typeof response)

// Requests use `FetchHttpClient.Fetch`, which an embedder can replace, rather than the global fetch.
// sender：构造 SDK 用的 fetch（走可替换的 FetchHttpClient，并合并并发刷新请求）
const sender = Effect.gen(function* () {
  // 取回注入的 fetch 实现
  const fetch = yield* FetchHttpClient.Fetch
  // 基础发送：禁用 Bun 的空闲超时（工具调用可能静默数分钟）
  const base: FetchLike = (url, init) => fetch(url, { ...init, timeout: false } as BunFetchRequestInit)
  // 实际发送：刷新令牌请求按键去重共享
  const send: FetchLike = (url, init) => {
    // 计算刷新键（非刷新请求为 undefined）
    const key = refreshKey(url, init)
    // 非刷新请求直接发送
    if (key === undefined) return base(url, init)
    // 已有进行中的同键请求则共享其结果
    const current = refreshes.get(key)
    if (current) return share(current)
    // 否则发起请求；完成后清理登记
    const pending = base(url, init).finally(() => {
      if (refreshes.get(key) === pending) refreshes.delete(key)
    })
    // 登记进行中的请求
    refreshes.set(key, pending)
    // 返回共享副本
    return share(pending)
  }
  // 返回构造好的发送函数
  return send
})

// loggedFetch：为某台服务器构造带日志的 fetch（请求开始/成功/失败均记录）
export const loggedFetch = (fields: { readonly server: string; readonly directory?: string }) =>
  Effect.gen(function* () {
    // 捕获上下文并把 Effect 转成 Promise 运行器
    const run = Effect.runPromiseWith(yield* Effect.context())
    // 取回共享去重的发送函数
    const send = yield* sender
    // 构造带日志的请求函数
    const request: FetchLike = (url, init) => {
      // 识别 grant 类型（刷新 / 授权码交换）
      const grant = init?.body instanceof URLSearchParams ? init.body.get("grant_type") : undefined
      // 映射为操作名（日志用）
      const operation = grant === "refresh_token" ? "refresh" : grant === "authorization_code" ? "exchange" : undefined
      // 记录开始时间
      const started = Date.now()
      // 在 Effect 上下文中执行请求与日志
      return run(
        Effect.gen(function* () {
          // OAuth 操作开始时记一条信息日志
          if (operation) yield* Effect.logInfo("mcp oauth request started")
          // 发起请求（错误被捕获）
          const response = yield* Effect.tryPromise({ try: () => send(url, init), catch: (error) => error })
          // 汇总状态码与耗时
          const result = { status: response.status, durationMs: Date.now() - started }
          // OAuth 操作被拒：解析错误响应体并记警告
          if (operation && !response.ok) {
            // 尝试解析错误响应（失败则 undefined）
            const error = yield* Effect.tryPromise(async () => parseErrorResponse(await response.clone().text())).pipe(
              Effect.orElseSucceed(() => undefined),
            )
            // 记录被拒详情（错误码与消息）
            yield* Effect.logWarning("mcp oauth request rejected", {
              ...result,
              error: error?.code,
              message: error?.message,
            })
          }
          // OAuth 操作成功：记信息日志
          if (operation && response.ok) {
            yield* Effect.logInfo("mcp oauth request succeeded", result)
          }
          // 非 OAuth 请求收到 401/403：记认证被拒警告
          if (!operation && (response.status === 401 || response.status === 403)) {
            yield* Effect.logWarning("mcp http authentication rejected", result)
          }
          // 返回响应
          return response
        }).pipe(
          // 请求失败：中止视为调试日志，其他记警告（含错误摘要与耗时）
          Effect.onError((cause) => {
            if (init?.signal?.aborted) return Effect.logDebug("mcp http request aborted")
            return Effect.logWarning("mcp http request failed", {
              errors: ErrorSummary.from(Cause.squash(cause)),
              durationMs: Date.now() - started,
            })
          }),
          // 日志附加服务器/目录、请求 ID、来源、方法与操作名
          Effect.annotateLogs({
            ...fields,
            requestID: crypto.randomUUID(),
            origin: new URL(url).origin,
            method: init?.method ?? "GET",
            ...(operation ? { operation } : {}),
          }),
        ),
      )
    }
    // 返回带日志的请求函数
    return request
  })

// A configured authorization server document stands in for RFC 9728 discovery: the SDK reuses this
// state instead of probing the resource server, whose well-known path may not exist.
// configuredDiscovery：用配置中声明的授权服务器文档替代 RFC 9728 发现流程
const configuredDiscovery = async (input: {
  // 远程服务器配置
  readonly config: typeof ConfigMCP.Remote.Type
  // 发送函数
  readonly fetchFn: FetchLike
}): Promise<OAuthDiscoveryState | undefined> => {
  // 取配置的元数据文档 URL（未配置则无需发现）
  const url = input.config.oauth ? input.config.oauth.auth_server_metadata_url : undefined
  if (!url) return undefined
  // 拉取元数据文档
  const response = await input.fetchFn(url, { headers: { accept: "application/json" } })
  // 拉取失败抛错
  if (!response.ok) throw new Error(`HTTP ${response.status} trying to load OAuth authorization server metadata`)
  // 解析 JSON 响应体
  const body = await response.json()
  // 先按 OAuth 元数据校验，失败则按 OpenID 发现元数据解析
  const metadata = OAuthMetadataSchema.safeParse(body).data ?? OpenIdProviderDiscoveryMetadataSchema.parse(body)
  // 组装发现状态：授权服务器地址、元数据与资源声明
  return {
    authorizationServerUrl: metadata.issuer,
    authorizationServerMetadata: metadata,
    resourceMetadata: { resource: resourceUrlFromServerUrl(input.config.url).toString() },
  }
}

// 凭证存取接口：令牌、客户端信息与 PKCE 校验器的读写
interface Store {
  // 读取令牌
  readonly tokens: () => Promise<StoredOAuthTokens | undefined>
  // 保存令牌
  readonly saveTokens: (tokens: StoredOAuthTokens) => Promise<void>
  // 读取客户端信息
  readonly clientInformation: () => Promise<StoredOAuthClientInformation | undefined>
  // 保存客户端信息
  readonly saveClientInformation: (info: StoredOAuthClientInformation) => Promise<void>
  // 读取 PKCE 校验器
  readonly codeVerifier: () => Promise<string | undefined>
  // 保存 PKCE 校验器
  readonly saveCodeVerifier: (verifier: string) => Promise<void>
}

// provider 的选项
interface Options {
  // 远程服务器配置
  readonly config: typeof ConfigMCP.Remote.Type
  // 凭证存取实现
  readonly store: Store
  // 发送函数
  readonly fetch: FetchLike
  /** Absent on connect: the provider then refuses to register a client or redirect, ending in needs_auth. */
  // redirect：连接时缺省——此时拒绝注册客户端或跳转，最终以 needs_auth 结束
  readonly redirect?: {
    // 回调地址
    readonly url: string
    // 防 CSRF 的 state 值
    readonly state: string
    // 打开授权 URL 的动作
    readonly open: (url: URL) => void | Promise<void>
  }
  // 可选的 CIMD 客户端元数据 URL
  readonly clientMetadataUrl?: string
  // 可选的预置发现状态
  readonly discovery?: OAuthDiscoveryState
  // 可选的凭证失效回调
  readonly invalidate?: OAuthClientProvider["invalidateCredentials"]
}

// provider：把选项组装成 SDK 的 OAuthClientProvider
const provider = (options: Options): OAuthClientProvider => {
  // 取配置的 oauth 段（可能为 undefined）
  const oauth = options.config.oauth || undefined
  // 静态客户端凭证（配置了 client_id 时）
  const client = oauth?.client_id ? { client_id: oauth.client_id, client_secret: oauth.client_secret } : undefined
  // 取 redirect 选项
  const redirect = options.redirect
  // A missing redirectUrl selects the client-credentials grant in the SDK, so connect still names one.
  // 回调地址：优先 redirect 选项，其次配置，最后给占位（避免 SDK 误选客户端凭证模式）
  const redirectUrl = redirect?.url ?? oauth?.redirect_uri ?? "http://127.0.0.1/callback"
  // refuse：构造“需要某物”的未授权错误
  const refuse = (what: string) => new UnauthorizedError(`MCP server "${options.config.url}" requires ${what}`)
  // 服务器身份 URL（去掉 hash）
  const identity = new URL(options.config.url)
  identity.hash = ""
  // 缓存的发现状态
  let discovery: OAuthDiscoveryState | undefined = options.discovery
  return {
    // 回调地址
    redirectUrl,
    // discoveryState：首次调用时按配置文档构建发现状态
    discoveryState: async () => {
      discovery ??= await configuredDiscovery({ config: options.config, fetchFn: options.fetch })
      return discovery
    },
    // 保存发现状态（仅内存）
    saveDiscoveryState: (state) => {
      discovery = state
    },
    // The SDK sends no RFC 8707 resource when the server publishes no resource metadata; some
    // authorization servers require one, so fall back to the configured URL.
    // validateResourceURL：校验/选择 RFC 8707 资源标识
    validateResourceURL: async (_serverUrl, resource) => {
      // 服务器未给出资源时回退到配置的 URL
      if (!resource) return identity
      // 配置的资源不覆盖服务器宣告的资源时报错
      if (!checkResourceAllowed({ requestedResource: identity, configuredResource: resource }))
        throw new Error(`Protected resource ${resource} does not cover ${identity}`)
      // 解析服务器宣告的资源
      const canonical = new URL(resource)
      // The transport dials the configured URL with extra query parameters and some servers echo
      // that back as the resource. Query is transport detail, not identity: the token stays bound
      // to the configured URL so a later refresh names the same resource the login did.
      // 同源同路径（仅查询参数差异）时视为同一身份，保持绑定到配置 URL
      if (canonical.origin === identity.origin && canonical.pathname === identity.pathname) return identity
      // 否则采用服务器宣告的资源
      return canonical
    },
    // CIMD 客户端元数据 URL（可选）
    ...(options.clientMetadataUrl ? { clientMetadataUrl: options.clientMetadataUrl } : {}),
    // state 读取器（有 redirect 时）
    ...(redirect ? { state: () => redirect.state } : {}),
    // RFC 7591 客户端元数据
    clientMetadata: {
      // 回调地址列表
      redirect_uris: [redirectUrl],
      // 客户端名
      client_name: "opencode",
      // 客户端主页
      client_uri: "https://opencode.ai",
      // 客户端 logo
      logo_uri: "https://opencode.ai/web-app-manifest-512x512.png",
      // 支持的授权类型
      grant_types: ["authorization_code", "refresh_token"],
      // 支持的响应类型
      response_types: ["code"],
      // 令牌端点认证方式：有密钥用 client_secret_post，否则公开客户端
      token_endpoint_auth_method: client?.client_secret ? "client_secret_post" : "none",
      // 配置了 scope 时附加
      ...(oauth?.scope ? { scope: oauth.scope } : {}),
    },
    // clientInformation：静态客户端优先，其次读存储；连接场景（无 redirect）缺失即拒绝
    clientInformation: async () => {
      if (client) return client
      const stored = await options.store.clientInformation()
      if (!stored && !redirect) throw refuse("a login before it can register a client")
      return stored
    },
    // 保存客户端信息（透传存储）
    saveClientInformation: (info) => options.store.saveClientInformation(info),
    // 读取令牌（透传存储）
    tokens: () => options.store.tokens(),
    // 保存令牌（透传存储）
    saveTokens: (tokens) => options.store.saveTokens(tokens),
    // redirectToAuthorization：跳转浏览器授权；无 redirect 或协议不合法时拒绝
    redirectToAuthorization: (url) => {
      // 连接场景没有 redirect：直接拒绝（最终 needs_auth）
      if (!redirect) throw refuse("user authorization")
      // 仅支持 http/https 的授权地址
      if (url.protocol !== "http:" && url.protocol !== "https:")
        throw new Error(
          `MCP server "${options.config.url}" returned a ${url.protocol} authorization URL; only http and https are supported`,
        )
      // 执行打开动作
      return redirect.open(url)
    },
    // 凭证失效回调（可选）
    ...(options.invalidate ? { invalidateCredentials: options.invalidate } : {}),
    // 保存 PKCE 校验器（透传存储）
    saveCodeVerifier: (verifier) => options.store.saveCodeVerifier(verifier),
    // 读取 PKCE 校验器：缺失时报错（令牌交换需要）
    codeVerifier: async () => {
      const verifier = await options.store.codeVerifier()
      if (!verifier) throw new Error("Missing PKCE code verifier for MCP OAuth flow")
      return verifier
    },
  }
}

// memoryStore：纯内存的凭证存取（用于匿名连接或登录流程的临时状态）
const memoryStore = (): Store => {
  // 令牌
  let tokens: StoredOAuthTokens | undefined
  // 客户端信息
  let client: StoredOAuthClientInformation | undefined
  // PKCE 校验器
  let verifier: string | undefined
  return {
    // 读取令牌
    tokens: async () => tokens,
    // 保存令牌
    saveTokens: async (value) => {
      tokens = value
    },
    // 读取客户端信息
    clientInformation: async () => client,
    // 保存客户端信息
    saveClientInformation: async (value) => {
      client = value
    },
    // 读取校验器
    codeVerifier: async () => verifier,
    // 保存校验器
    saveCodeVerifier: async (value) => {
      verifier = value
    },
  }
}

// clientFromCredential：从 OAuth 凭证的元数据中取回已注册的客户端信息
export const clientFromCredential = (credential: Credential.OAuth) =>
  credential.metadata?.client as StoredOAuthClientInformation | undefined

// toCredential：把 SDK 令牌结构转换成内部 OAuth 凭证
const toCredential = (input: {
  // 认证方式 ID
  readonly methodID: Integration.MethodID
  // 服务器 URL
  readonly serverUrl: string
  // SDK 令牌
  readonly tokens: StoredOAuthTokens
  // 已注册客户端信息（可选）
  readonly client: StoredOAuthClientInformation | undefined
}) =>
  Credential.OAuth.make({
    // 凭证类型
    type: "oauth",
    // 认证方式 ID
    methodID: input.methodID,
    // 访问令牌
    access: input.tokens.access_token,
    // 刷新令牌（缺失记空串）
    refresh: input.tokens.refresh_token ?? "",
    // 0 is non-expiring; toTokens then omits expires_in so the SDK does not force a refresh.
    // 过期时间：0 表示永不过期；有 expires_in 时换算成绝对时间戳
    expires: input.tokens.expires_in ? Date.now() + input.tokens.expires_in * 1000 : 0,
    // 元数据：服务器 URL、令牌类型、可选的 scope/issuer/客户端信息
    metadata: {
      serverUrl: input.serverUrl,
      tokenType: input.tokens.token_type,
      ...(input.tokens.scope ? { scope: input.tokens.scope } : {}),
      ...(input.tokens.issuer ? { issuer: input.tokens.issuer } : {}),
      ...(input.client ? { client: input.client } : {}),
    },
  })

// toTokens：把内部 OAuth 凭证还原成 SDK 令牌结构
const toTokens = (credential: Credential.OAuth): StoredOAuthTokens => {
  // 取元数据（可能为空对象）
  const metadata = credential.metadata ?? {}
  return {
    // 访问令牌
    access_token: credential.access,
    // 令牌类型（缺省 Bearer）
    token_type: typeof metadata.tokenType === "string" ? metadata.tokenType : "Bearer",
    // 有刷新令牌才带
    ...(credential.refresh ? { refresh_token: credential.refresh } : {}),
    // 有过期时间才带（换算回剩余秒数，不为负）
    ...(credential.expires ? { expires_in: Math.max(0, Math.floor((credential.expires - Date.now()) / 1000)) } : {}),
    // scope 仅在为字符串时带
    ...(typeof metadata.scope === "string" ? { scope: metadata.scope } : {}),
    // issuer 仅在为字符串时带
    ...(typeof metadata.issuer === "string" ? { issuer: metadata.issuer } : {}),
  }
}

/**
 * A provider for one credential the caller already selected, or none. It never looks up the active credential
 * itself: it reads and refreshes only the selected row, and a provider made without one stays anonymous.
 */
// connectProvider：为调用方已选定的（或没有的）一条凭证构造提供者；只读写该行，不自行查找活跃凭证
export const connectProvider = Effect.fnUntraced(function* (input: {
  // 远程服务器配置
  readonly config: typeof ConfigMCP.Remote.Type
  // 选定的凭证（可能为 undefined）
  readonly credential: Credential.Info | undefined
}) {
  // 取回凭证服务
  const credentials = yield* Credential.Service
  // 捕获上下文并构造 Promise 运行器
  const run = Effect.runPromiseWith(yield* Effect.context())
  // 取回共享去重的发送函数
  const fetch = yield* sender
  // 选定的凭证
  const found = input.credential
  // 无凭证或类型不是 oauth：使用内存存储的匿名提供者
  if (!found || found.value.type !== "oauth") return provider({ config: input.config, store: memoryStore(), fetch })
  // 凭证行 ID
  const id = found.id
  // 认证方式 ID
  const methodID = found.value.methodID
  // read：读取当前凭证行（仍是 oauth 类型时返回）
  const read = async () => {
    const stored = await run(credentials.get(id))
    return stored?.value.type === "oauth" ? stored.value : undefined
  }
  // Refresh tokens rotate and the row is shared across connections: only drop it while it still holds ours.
  // 记住当前持有的刷新令牌：多连接共享该行，只有仍持有 ours 时才能删
  let presented = found.value.refresh
  return provider({
    // 配置
    config: input.config,
    // 发送函数
    fetch,
    // invalidate：凭证被服务器判定失效时的回调
    invalidate: async (scope) => {
      // 校验器/发现状态的失效无需动凭证行
      if (scope === "verifier" || scope === "discovery") return
      // 读取当前行
      const oauth = await read()
      // 行已不持有我们呈现的刷新令牌（已被别的连接替换）时不动
      if (!oauth || oauth.refresh !== presented) return
      // 记警告日志
      await run(Effect.logWarning("mcp oauth credential invalidated", { credentialID: id, scope }))
      // 删除该凭证行
      await run(credentials.remove(id))
    },
    // store：把凭证行映射成 SDK 的存取接口
    store: {
      // tokens：读当前行并更新“已呈现”的刷新令牌
      tokens: async () => {
        const oauth = await read()
        if (!oauth) return undefined
        presented = oauth.refresh
        return toTokens(oauth)
      },
      // saveTokens：把新令牌写回该行（保留已有客户端信息）
      saveTokens: async (tokens) => {
        // 读取旧行（用于保留客户端信息）
        const previous = await read()
        // 组装新凭证
        const value = toCredential({
          methodID,
          serverUrl: input.config.url,
          tokens,
          client: previous ? clientFromCredential(previous) : undefined,
        })
        // 更新“已呈现”的刷新令牌
        presented = value.refresh
        // 写回该行
        await run(credentials.update(id, { value }))
      },
      // clientInformation：读当前行的客户端信息
      clientInformation: async () => {
        const oauth = await read()
        return oauth ? clientFromCredential(oauth) : undefined
      },
      // saveClientInformation：把客户端信息写回该行（无行则忽略）
      saveClientInformation: async (client) => {
        const oauth = await read()
        if (!oauth) return
        await run(credentials.update(id, { value: { ...oauth, metadata: { ...oauth.metadata, client } } }))
      },
      // 校验器：跨连接不共享，恒为空
      codeVerifier: async () => undefined,
      // 校验器写入：空实现
      saveCodeVerifier: async () => {},
    },
  })
})

// authorize：发起一次 MCP OAuth 登录（启动本地回调服务器并返回授权 URL）
export const authorize = (input: {
  // 服务器名
  readonly name: string
  // 远程服务器配置
  readonly config: typeof ConfigMCP.Remote.Type
  // 集成 ID
  readonly integrationID: Integration.ID
  // 认证方式 ID
  readonly methodID: Integration.MethodID
}) =>
  Effect.gen(function* () {
    // 日志标注字段（服务器、方式 ID、本次登录尝试 ID）
    const fields = { server: input.name, methodID: input.methodID, oauthAttemptID: crypto.randomUUID() }
    // 捕获 Effect 上下文
    const context = yield* Effect.context()
    // Promise 运行器
    const run = Effect.runPromiseWith(context)
    // 纤程运行器（回调线程里用）
    const runFork = Effect.runForkWith(context)
    // 取回凭证服务
    const credentials = yield* Credential.Service
    // 构建带日志的 fetch（附登录标注）
    const fetchFn = yield* loggedFetch({ server: input.name }).pipe(Effect.annotateLogs(fields))
    // 记录登录开始
    yield* Effect.logInfo("mcp oauth authorization started", fields)
    // 取配置的 oauth 段
    const oauth = input.config.oauth || undefined
    // 内存存储（登录过程中的临时状态）
    const store = memoryStore()
    // Reuse the client registered by an earlier login; the SDK discards it if the issuer changed.
    // 复用上次登录注册的客户端；issuer 变了 SDK 会自行丢弃
    const previous = (yield* credentials.list(input.integrationID)).at(-1)?.value
    if (previous?.type === "oauth") {
      const client = clientFromCredential(previous)
      if (client) yield* Effect.promise(() => store.saveClientInformation(client))
    }
    // Deferred：等待回调结果（授权码、iss、HTTP 响应）或失败
    const code = yield* Deferred.make<{ code: string; iss: string | undefined; response?: ServerResponse }, Error>()
    // 解析配置的回调地址
    const redirect = oauth?.redirect_uri ? new URL(oauth.redirect_uri) : undefined
    // 回调路径（缺省 /callback）
    const redirectPath = redirect?.pathname ?? "/callback"
    // 生成防 CSRF 的 state（base64url 的 32 字节随机数）
    const state = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")

    // Lazy so runtimes without a loopback listener (workerd) never evaluate node:http.
    // 懒加载 node:http（无环回监听能力的运行时永不触载）
    const { createServer } = yield* Effect.promise(() => import("node:http"))
    // 启动本地回调 HTTP 服务器
    const server = createServer((request, response) => {
      // 解析请求 URL
      const url = new URL(request.url ?? "/", "http://127.0.0.1")
      // 路径不匹配回调路径：404
      if (url.pathname !== redirectPath) {
        response.writeHead(404).end("Not found")
        return
      }
      // fail：记日志、使 Deferred 失败并回 400 页面
      const fail = (reason: string, failure: string) => {
        runFork(Effect.logWarning("mcp oauth callback rejected", { ...fields, reason: failure }))
        Effect.runSync(Deferred.fail(code, new Error(reason)))
        response
          .writeHead(400, { "Content-Type": "text/html" })
          .end(OauthCallbackPage.error(reason, { provider: input.name }))
      }
      // 授权服务器回传的错误参数
      const error = url.searchParams.get("error_description") ?? url.searchParams.get("error")
      if (error) return fail(error, "authorization_error")
      // 校验 state
      const returned = url.searchParams.get("state")
      // 取授权码
      const value = url.searchParams.get("code")
      // Browsers can reach the callback without any OAuth parameters (preflights, prefetches, reloads). Only a
      // redirect from the authorization server may end the login, so keep waiting for it.
      // 无 state 也无 code（预检/预取/刷新）时：仅回 400，继续等待真正的回调
      if (returned === null && !value) {
        response
          .writeHead(400, { "Content-Type": "text/html" })
          .end(OauthCallbackPage.error("Missing authorization code", { provider: input.name }))
        return
      }
      // state 不匹配：失败
      if (returned !== state) return fail("OAuth state mismatch", "state_mismatch")
      // 缺授权码：失败
      if (!value) return fail("Missing authorization code", "missing_code")
      // The page waits for the token exchange so the browser never reports success for a rejected code.
      // 交付回调结果；若已被占用（第二次回调）回 409
      if (
        !Effect.runSync(
          Deferred.succeed(code, { code: value, iss: url.searchParams.get("iss") ?? undefined, response }),
        )
      )
        response.writeHead(409).end("OAuth callback already received")
    })

    // callback_port, else the port pinned by redirect_uri, else ephemeral; a mismatch strands the browser.
    // 监听端口：callback_port 优先，其次 redirect_uri 钉住的端口，否则临时端口
    const redirectPort = Number(redirect?.port) || undefined
    // 启动监听（错误与成功都通过回调恢复 Effect）
    const port = yield* Effect.callback<number, Error>((resume) => {
      server.once("error", (error) => resume(Effect.fail(error)))
      server.listen(oauth?.callback_port ?? redirectPort ?? 0, "127.0.0.1", () => {
        resume(Effect.succeed((server.address() as AddressInfo).port))
      })
    })
    // 注册终结器：退出时关闭回调服务器
    yield* Effect.addFinalizer(() => Effect.sync(() => server.close()))

    // The server's 401 names where its resource metadata lives and which scopes it wants; without it
    // discovery can only guess the well-known path, which not every server layout answers.
    // 向服务器发一次 initialize 探测：从 401 的 WWW-Authenticate 里取资源元数据地址与 scope
    const challenge = yield* Effect.tryPromise((signal) =>
      fetchFn(input.config.url, {
        method: "POST",
        headers: {
          ...input.config.headers,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 0,
          method: "initialize",
          params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "opencode" } },
        }),
        signal,
      }),
    ).pipe(
      // 提取 WWW-Authenticate 参数
      Effect.map((response) => extractWWWAuthenticateParams(response)),
      // 最多等 5 秒
      Effect.timeout("5 seconds"),
      // 失败按空挑战处理
      Effect.orElseSucceed(() => ({ resourceMetadataUrl: undefined, scope: undefined })),
    )
    // 资源元数据地址
    const resourceMetadataUrl = challenge.resourceMetadataUrl
    // CIMD needs the server to advertise it and accept public clients, and our published document only
    // lists the loopback redirect; a configured client_id always wins.
    // 发现授权服务器：优先配置的元数据文档，否则按 RFC 9728 自动发现
    const discovery = yield* Effect.tryPromise({
      try: async () =>
        (await configuredDiscovery({ config: input.config, fetchFn })) ??
        discoverOAuthServerInfo(input.config.url, { resourceMetadataUrl, fetchFn }),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    })
    // 判定能否走 CIMD：无静态 client_id、无固定回调、服务器宣告支持元数据文档且接受公开客户端
    const cimd =
      !oauth?.client_id &&
      !oauth?.redirect_uri &&
      discovery.authorizationServerMetadata?.client_id_metadata_document_supported === true &&
      (discovery.authorizationServerMetadata.token_endpoint_auth_methods_supported?.includes("none") ?? false)
    // 记录选择的注册方式（static / cimd / dcr）
    yield* Effect.logInfo("mcp oauth client registration selected", {
      ...fields,
      registration: oauth?.client_id ? "static" : cimd ? "cimd" : "dcr",
    })

    // 授权 URL（open 回调时赋值）
    let authorizationUrl: URL | undefined
    // 组装登录用的 OAuth 提供者
    const oauthProvider = provider({
      // 配置
      config: input.config,
      // 内存存储
      store,
      // 带日志的发送
      fetch: fetchFn,
      // 走 CIMD 时给客户端元数据 URL
      clientMetadataUrl: cimd ? CLIENT_METADATA_URL : undefined,
      // 预置发现状态（含资源元数据地址）
      discovery: { ...discovery, resourceMetadataUrl: resourceMetadataUrl?.toString() },
      // redirect：本地回调地址、state 与打开动作
      redirect: {
        url: oauth?.redirect_uri ?? `http://127.0.0.1:${port}${redirectPath}`,
        state,
        open: (url) => {
          // 记下授权 URL
          authorizationUrl = url
          // 记录等待授权日志
          return run(Effect.logInfo("mcp oauth awaiting authorization", fields))
        },
      },
    })

    // finalize：登录完成后从内存存储取令牌并转换为凭证
    const finalize = Effect.gen(function* () {
      // 读取令牌
      const tokens = yield* Effect.promise(() => store.tokens())
      // 没拿到令牌即失败
      if (!tokens) return yield* Effect.fail(new Error(`MCP server "${input.name}" did not return OAuth tokens`))
      // 读取客户端信息
      const client = yield* Effect.promise(() => store.clientInformation())
      // 记录完成日志（是否有刷新令牌、有效期）
      yield* Effect.logInfo("mcp oauth authorization completed", {
        ...fields,
        hasRefreshToken: Boolean(tokens.refresh_token),
        expiresIn: tokens.expires_in,
      })
      // 转换为内部凭证
      return toCredential({ methodID: input.methodID, serverUrl: input.config.url, tokens, client })
    })

    // 第一步 auth：触发授权 URL 生成（内部会调用 redirect.open）
    yield* Effect.tryPromise({
      try: () => auth(oauthProvider, { serverUrl: input.config.url, scope: oauth?.scope ?? challenge.scope, fetchFn }),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    })

    // 没拿到授权 URL 即失败
    if (!authorizationUrl)
      return yield* Effect.fail(new Error(`MCP server "${input.name}" did not provide an authorization URL`))

    // Deferred：等待最终凭证（成功或失败）
    const completed = yield* Deferred.make<Credential.OAuth, Error>()
    // 后台纤程：等回调结果并完成令牌交换
    yield* Deferred.await(code).pipe(
      Effect.flatMap((value) => {
        // respond：向浏览器回调连接回 200/400 页面
        const respond = (error?: string) =>
          Effect.sync(() =>
            value.response
              ?.writeHead(error ? 400 : 200, { "Content-Type": "text/html" })
              .end(
                error
                  ? OauthCallbackPage.error(error, { provider: input.name })
                  : OauthCallbackPage.success({ provider: input.name }),
              ),
          )
        // 用授权码完成令牌交换
        return Effect.tryPromise({
          try: () =>
            auth(oauthProvider, {
              serverUrl: input.config.url,
              authorizationCode: value.code,
              iss: value.iss,
              scope: oauth?.scope ?? challenge.scope,
              fetchFn,
            }),
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        }).pipe(
          // 成功后取令牌
          Effect.flatMap(() => finalize),
          // 成功回 200 页面
          Effect.tap(() => respond()),
          // 失败回 400 页面
          Effect.tapError((error) => respond(error.message)),
          // 被中断时销毁浏览器响应连接
          Effect.onInterrupt(() => Effect.sync(() => value.response?.destroy())),
        )
      }),
      // 非中断失败记警告日志
      Effect.onErrorIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("mcp oauth authorization failed", { errors: ErrorSummary.from(Cause.squash(cause)) }),
      ),
      // 日志附加登录标注
      Effect.annotateLogs(fields),
      // 收敛为 Exit 并交付给 completed
      Effect.exit,
      Effect.flatMap((exit) => Deferred.done(completed, exit)),
      // 立即启动的后台纤程
      Effect.forkScoped({ startImmediately: true }),
    )

    // 返回登录会话：授权 URL、提示文案、模式、结果回调与手动粘贴入口
    return {
      // 浏览器打开的授权地址
      url: authorizationUrl.toString(),
      // 用户提示文案
      instructions: `Authorize ${input.name} in your browser. This window will close automatically.`,
      // 自动模式
      mode: "auto" as const,
      // 登录完成的结果
      callback: Deferred.await(completed),
      // A pasted URL is held to the same checks as the browser's redirect, but a wrong paste keeps the login waiting.
      // submit：手动粘贴回调 URL（与浏览器回调同样的校验；粘错则登录继续等待）
      submit: (pasted: string) =>
        Effect.gen(function* () {
          // 去空白
          const text = pasted.trim()
          // 必须是可解析的 URL
          if (!URL.canParse(text)) return yield* Effect.fail(new Error("Paste the full URL from the browser's address bar"))
          // 解析 URL
          const url = new URL(text)
          // state 必须匹配本次登录
          if (url.searchParams.get("state") !== state)
            return yield* Effect.fail(new Error("This URL belongs to a different sign-in"))
          // 授权服务器回传的错误
          const error = url.searchParams.get("error_description") ?? url.searchParams.get("error")
          if (error) {
            yield* Deferred.fail(code, new Error(error))
            return
          }
          // 取授权码
          const value = url.searchParams.get("code")
          // 缺授权码即失败
          if (!value) return yield* Effect.fail(new Error("The URL does not contain an authorization code"))
          // 记录粘贴重定向日志
          yield* Effect.logInfo("mcp oauth redirect pasted", fields)
          // 交付回调结果（与浏览器回调同路）
          yield* Deferred.succeed(code, { code: value, iss: url.searchParams.get("iss") ?? undefined })
        }),
    }
  }).pipe(
    // 登录初始化失败：记警告日志（含错误摘要）
    Effect.onError((cause) =>
      Effect.logWarning("mcp oauth authorization setup failed", {
        server: input.name,
        methodID: input.methodID,
        errors: ErrorSummary.from(Cause.squash(cause)),
      }),
    ),
  )
