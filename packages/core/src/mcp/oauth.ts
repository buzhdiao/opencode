// 将本模块以命名空间 McpOAuth 整体再导出（barrel 模式）
export * as McpOAuth from "./oauth.js"

// 引入 MCP SDK 的 OAuth 相关能力：auth 流程、最新协议版本、资源校验、服务器信息发现、
// WWW-Authenticate 参数提取、错误响应解析、资源 URL 推导、未授权错误及若干类型
import {
  auth,
  LATEST_PROTOCOL_VERSION,
  checkResourceAllowed,
  discoverAuthorizationServerMetadata,
  discoverOAuthServerInfo,
  extractWWWAuthenticateParams,
  OAuthError,
  OAuthErrorCode,
  parseErrorResponse,
  refreshAuthorization,
  resourceUrlFromServerUrl,
  UnauthorizedError,
  type AuthProvider,
  type FetchLike,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client"
// 引入 OAuth 元数据 schema（授权服务器元数据与 OpenID 发现元数据）
import { OAuthMetadataSchema, OpenIdProviderDiscoveryMetadataSchema } from "@modelcontextprotocol/core"
import { Cause, Clock, Data, Deferred, Duration, Effect, Option, Schema } from "effect"
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
import { OauthRedirect } from "../oauth/redirect.js"
import type { Integration } from "../integration.js"
// 引入错误摘要辅助
import { ErrorSummary } from "../util/error-summary.js"

/** Client ID Metadata Document: servers that support CIMD accept this URL as the client_id without registration. */
// CIMD（Client ID Metadata Document）：支持该机制的服务器直接以这个 URL 作为 client_id，无需动态注册
export const CLIENT_METADATA_URL = "https://opencode.ai/oauth/opencode/client.json"

// The authorization server refused the refresh token or the client: only a new login helps.
class RefreshRejected extends Data.TaggedError("McpOAuth.RefreshRejected")<{ readonly message: string }> {}

// Discovery named another authorization server than the one that issued the credential. Its tokens are not sent
// there; the credential stays for its own server, and a new login is needed meanwhile.
class IssuerChanged extends Data.TaggedError("McpOAuth.IssuerChanged")<{ readonly message: string }> {}

// Like other MCP clients: refreshing this close to expiry leaves short-lived tokens alone until they are due.
const REFRESH_AHEAD = Duration.seconds(30)

const rejections = new Set<string>([
  OAuthErrorCode.InvalidGrant,
  OAuthErrorCode.InvalidClient,
  OAuthErrorCode.UnauthorizedClient,
])

// loggedFetch：为某台服务器构造带日志的 fetch（请求开始/成功/失败均记录）
export const loggedFetch = (fields: { readonly server: string; readonly directory?: string }) =>
  Effect.gen(function* () {
    // 捕获上下文并把 Effect 转成 Promise 运行器
    const run = Effect.runPromiseWith(yield* Effect.context())
    const fetch = yield* FetchHttpClient.Fetch
    // Bun's idle deadline is off because a tool call can stay silent for minutes; the MCP execution timeout still
    // applies. Requests use `FetchHttpClient.Fetch`, which an embedder can replace, rather than the global fetch.
    const send: FetchLike = (url, init) => fetch(url, { ...init, timeout: false } as BunFetchRequestInit)
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
  readonly redirect: {
    readonly url: () => string
    readonly registered: string[]
    readonly state: string
    // 打开授权 URL 的动作
    readonly open: (url: URL) => void | Promise<void>
  }
  // 可选的 CIMD 客户端元数据 URL
  readonly clientMetadataUrl?: string
  readonly discovery: OAuthDiscoveryState
}

// provider：把选项组装成 SDK 的 OAuthClientProvider
const provider = (options: Options): OAuthClientProvider => {
  // 取配置的 oauth 段（可能为 undefined）
  const oauth = options.config.oauth || undefined
  // 静态客户端凭证（配置了 client_id 时）
  const client = oauth?.client_id ? { client_id: oauth.client_id, client_secret: oauth.client_secret } : undefined
  // 取 redirect 选项
  const redirect = options.redirect
  let discovery = options.discovery
  return {
    get redirectUrl() {
      return redirect.url()
    },
    discoveryState: async () => discovery,
    saveDiscoveryState: (state) => {
      discovery = state
    },
    validateResourceURL: async (_serverUrl, resource) => selectResource(options.config, resource),
    ...(options.clientMetadataUrl ? { clientMetadataUrl: options.clientMetadataUrl } : {}),
    state: () => redirect.state,
    clientMetadata: {
      redirect_uris: redirect.registered,
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
    clientInformation: async () => client ?? (await options.store.clientInformation()),
    saveClientInformation: (info) => options.store.saveClientInformation(info),
    // 读取令牌（透传存储）
    tokens: () => options.store.tokens(),
    // 保存令牌（透传存储）
    saveTokens: (tokens) => options.store.saveTokens(tokens),
    // redirectToAuthorization：跳转浏览器授权；无 redirect 或协议不合法时拒绝
    redirectToAuthorization: (url) => {
      if (url.protocol !== "http:" && url.protocol !== "https:")
        throw new Error(
          `MCP server "${options.config.url}" returned a ${url.protocol} authorization URL; only http and https are supported`,
        )
      // 执行打开动作
      return redirect.open(url)
    },
    saveCodeVerifier: (verifier) => options.store.saveCodeVerifier(verifier),
    // 读取 PKCE 校验器：缺失时报错（令牌交换需要）
    codeVerifier: async () => {
      const verifier = await options.store.codeVerifier()
      if (!verifier) throw new Error("Missing PKCE code verifier for MCP OAuth flow")
      return verifier
    },
  }
}

// The SDK sends no RFC 8707 resource when the server publishes no resource metadata; some
// authorization servers require one, so fall back to the configured URL.
const selectResource = (config: typeof ConfigMCP.Remote.Type, resource: string | undefined) => {
  const identity = new URL(config.url)
  identity.hash = ""
  if (!resource) return identity
  if (!checkResourceAllowed({ requestedResource: identity, configuredResource: resource }))
    throw new Error(`Protected resource ${resource} does not cover ${identity}`)
  const canonical = new URL(resource)
  // The transport dials the configured URL with extra query parameters and some servers echo
  // that back as the resource. Query is transport detail, not identity: the token stays bound
  // to the configured URL so a later refresh names the same resource the login did.
  if (canonical.origin === identity.origin && canonical.pathname === identity.pathname) return identity
  return canonical
}

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

// Where the login found its authorization server and which resource it named, so a refresh need not discover them.
const Discovery = Schema.Struct({ authorizationServer: Schema.String, resource: Schema.String })
const decodeDiscovery = Schema.decodeUnknownOption(Discovery)
const discoveryFromCredential = (credential: Credential.OAuth) =>
  Option.getOrUndefined(decodeDiscovery(credential.metadata?.discovery))

const toCredential = (input: {
  // 认证方式 ID
  readonly methodID: Integration.MethodID
  // 服务器 URL
  readonly serverUrl: string
  // SDK 令牌
  readonly tokens: StoredOAuthTokens
  // 已注册客户端信息（可选）
  readonly client: StoredOAuthClientInformation | undefined
  readonly discovery: typeof Discovery.Type | undefined
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
    // 0 means the server gave no lifetime, so the token is only refreshed after a 401.
    expires: input.tokens.expires_in ? Date.now() + input.tokens.expires_in * 1000 : 0,
    // 元数据：服务器 URL、令牌类型、可选的 scope/issuer/客户端信息
    metadata: {
      serverUrl: input.serverUrl,
      tokenType: input.tokens.token_type,
      ...(input.tokens.scope ? { scope: input.tokens.scope } : {}),
      ...(input.tokens.issuer ? { issuer: input.tokens.issuer } : {}),
      ...(input.discovery ? { discovery: input.discovery } : {}),
      ...(input.client ? { client: input.client } : {}),
    },
  })

/**
 * Bearer tokens for one credential the caller already selected, or none. It never looks up the active credential
 * itself: it reads and refreshes only the selected row, and one made without a credential stays anonymous. A
 * connection never starts a login, so a token the server refuses and cannot be refreshed ends in needs_auth.
 */
// connectProvider：为调用方已选定的（或没有的）一条凭证构造提供者；只读写该行，不自行查找活跃凭证
export const connectProvider = Effect.fnUntraced(function* (input: {
  readonly server: string
  readonly config: typeof ConfigMCP.Remote.Type
  // 选定的凭证（可能为 undefined）
  readonly credential: Credential.Info | undefined
}): Effect.fn.Return<AuthProvider, never, Credential.Service> {
  const found = input.credential
  // Without onUnauthorized the transport answers a 401 with UnauthorizedError.
  if (found?.value.type !== "oauth") return { token: async () => undefined }
  const id = found.id
  const credentials = yield* Credential.Service
  const fetchFn = yield* loggedFetch({ server: input.server })
  const run = Effect.runPromiseWith(yield* Effect.context())
  const read = credentials.get(id).pipe(Effect.map((row) => (row?.value.type === "oauth" ? row.value : undefined)))
  const refresh = (stale: (current: Credential.OAuth, now: number) => boolean, resourceMetadataUrl?: URL) =>
    credentials.refresh(id, {
      stale,
      refresh: (current) =>
        exchange({ config: input.config, fetchFn, current, resourceMetadataUrl }).pipe(
          Effect.tapError((error) =>
            error instanceof RefreshRejected
              ? Effect.logWarning("mcp oauth credential invalidated", { credentialID: id, reason: error.message }).pipe(
                  Effect.andThen(credentials.remove(id)),
                )
              : Effect.void,
          ),
        ),
    })
  const due = (current: Credential.OAuth, now: number) => Credential.expiring(current, now, REFRESH_AHEAD)
  const refused = () => new UnauthorizedError(`MCP server "${input.config.url}" requires user authorization`)
  // The token last sent. A 401 refreshes only while the row still holds it: another connection or process may
  // have refreshed it already.
  let presented: string | undefined
  return {
    token: () =>
      run(
        Effect.gen(function* () {
          const current = yield* read
          // Refreshing ahead needs the discovery the login saved. If it fails, the current token goes out and a
          // 401 decides.
          const ahead =
            current?.refresh && discoveryFromCredential(current) && due(current, yield* Clock.currentTimeMillis)
          const value = ahead ? yield* refresh(due).pipe(Effect.orElseSucceed(() => current)) : current
          presented = value?.access
          return presented
        }),
      ),
    onUnauthorized: (context) =>
      run(
        Effect.gen(function* () {
          const rejected = presented
          if (!(yield* read)?.refresh) return yield* Effect.fail(refused())
          const value = yield* refresh(
            (current) => current.access === rejected,
            extractWWWAuthenticateParams(context.response).resourceMetadataUrl,
          ).pipe(
            Effect.catch((error) =>
              error instanceof RefreshRejected || error instanceof IssuerChanged
                ? Effect.fail(refused())
                : // Not a lost login: keep the credential and fail this attempt so the next one tries again. An OAuth
                  // error names only its code: its description can quote the server's whole response.
                  Effect.fail(
                    new OAuthError(
                      OAuthErrorCode.TemporarilyUnavailable,
                      `Could not refresh the OAuth token: ${
                        error instanceof OAuthError
                          ? error.code
                          : error instanceof Error
                            ? error.message
                            : String(error)
                      }`,
                    ),
                  ),
            ),
          )
          if (!value) return yield* Effect.fail(refused())
        }),
      ),
  }
})

// Refreshes with the discovery the login saved, or discovers as the login did and saves the result.
const exchange = (input: {
  readonly config: typeof ConfigMCP.Remote.Type
  readonly fetchFn: FetchLike
  readonly current: Credential.OAuth
  readonly resourceMetadataUrl: URL | undefined
}) =>
  Effect.tryPromise({
    try: async (signal) => {
      const fetchFn: FetchLike = async (url, init) => {
        const response = await input.fetchFn(url, { ...init, signal })
        // A failing token endpoint says nothing about the login; report its status, not its body.
        if (init?.method === "POST" && (response.status === 429 || response.status >= 500))
          throw new Error(`HTTP ${response.status}`)
        return response
      }
      const oauth = input.config.oauth || undefined
      const client = oauth?.client_id
        ? { client_id: oauth.client_id, client_secret: oauth.client_secret }
        : clientFromCredential(input.current)
      if (!client) throw new RefreshRejected({ message: "no OAuth client information" })
      const saved = discoveryFromCredential(input.current)
      const configured = await configuredDiscovery({ config: input.config, fetchFn })
      const server =
        configured ??
        (saved
          ? {
              authorizationServerUrl: saved.authorizationServer,
              authorizationServerMetadata: await discoverAuthorizationServerMetadata(saved.authorizationServer, {
                fetchFn,
              }),
              resourceMetadata: undefined,
            }
          : await discoverOAuthServerInfo(input.config.url, {
              resourceMetadataUrl: input.resourceMetadataUrl,
              fetchFn,
            }))
      const found = server.authorizationServerMetadata?.issuer ?? server.authorizationServerUrl
      const issuer = input.current.metadata?.issuer
      if (typeof issuer === "string" && found.replace(/\/$/, "") !== issuer.replace(/\/$/, ""))
        throw new IssuerChanged({ message: `issued by ${issuer}, but discovery names ${found}` })
      const resource = saved?.resource ?? selectResource(input.config, server.resourceMetadata?.resource).toString()
      const tokens = await refreshAuthorization(server.authorizationServerUrl, {
        metadata: server.authorizationServerMetadata,
        clientInformation: client,
        refreshToken: input.current.refresh,
        resource,
        fetchFn,
      })
      return toCredential({
        methodID: input.current.methodID,
        serverUrl: input.config.url,
        tokens: {
          refresh_token: input.current.refresh,
          ...tokens,
          issuer: found,
        },
        client: clientFromCredential(input.current),
        // A configured metadata URL is read on every refresh, so changing it applies at once.
        discovery: configured ? undefined : { authorizationServer: server.authorizationServerUrl, resource },
      })
    },
    catch: (error) =>
      error instanceof RefreshRejected || error instanceof IssuerChanged
        ? error
        : error instanceof OAuthError && rejections.has(error.code)
          ? new RefreshRejected({ message: error.message })
          : error,
  })

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
    const code = yield* Deferred.make<
      { code: string; iss: string | undefined; host?: string; response?: ServerResponse },
      Error
    >()
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
          Deferred.succeed(code, {
            code: value,
            iss: url.searchParams.get("iss") ?? undefined,
            host: request.headers.host,
            response,
          }),
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

    // Some authorization servers (Clerk) rewrite a 127.0.0.1 redirect to localhost before sending the browser back,
    // and issue the code for the rewritten URI. Both are registered, and the token exchange repeats the one used.
    const loopback = (host: string) => `http://${host}:${port}${redirectPath}`
    let reached = "127.0.0.1"
    let authorizationUrl: URL | undefined
    // 组装登录用的 OAuth 提供者
    const oauthProvider = provider({
      // 配置
      config: input.config,
      // 内存存储
      store,
      clientMetadataUrl: cimd ? CLIENT_METADATA_URL : undefined,
      // 预置发现状态（含资源元数据地址）
      discovery: { ...discovery, resourceMetadataUrl: resourceMetadataUrl?.toString() },
      // redirect：本地回调地址、state 与打开动作
      redirect: {
        url: () => oauth?.redirect_uri ?? loopback(reached),
        registered: oauth?.redirect_uri ? [oauth.redirect_uri] : [loopback("127.0.0.1"), loopback("localhost")],
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
      return toCredential({
        methodID: input.methodID,
        serverUrl: input.config.url,
        tokens,
        client,
        discovery: oauth?.auth_server_metadata_url
          ? undefined
          : {
              authorizationServer: discovery.authorizationServerUrl,
              resource: selectResource(input.config, discovery.resourceMetadata?.resource).toString(),
            },
      })
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
        if (value.host === `localhost:${port}`) reached = "localhost"
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
        OauthRedirect.submit({
          state,
          callback: code,
          received: (value, params) => ({ code: value, iss: params.get("iss") ?? undefined }),
        })(pasted).pipe(Effect.tap(() => Effect.logInfo("mcp oauth redirect pasted", fields))),
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
