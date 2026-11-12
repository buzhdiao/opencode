import { isDeepStrictEqual } from "node:util"
import { Duration, Effect, Equal, FiberHandle, Option, Schema, Scope, Semaphore, Stream } from "effect"
// 导入集成 OAuth 方式注册类型（仅类型）
import type { IntegrationOAuthMethodRegistration } from "@opencode/plugin/effect/integration"
// 导入插件定义辅助函数 define
import { define } from "@opencode/plugin/effect/plugin"
// 导入会话 HTTP 响应类型（仅类型）
import type { SessionHttpResponse } from "@opencode/plugin/effect/session"
// 从 effect/http 导入 HTTP 客户端全家族
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
  HttpMethod,
} from "effect/http"
// 导入应用信息工具（User-Agent）
import { App } from "../../app.js"
// 导入事件总线服务
import { Bus } from "../../bus.js"
// 导入配置服务
import { Config } from "../../config.js"
// 导入集成配置文档工具
import { ConfigIntegration } from "../../config/integration.js"
// 导入配置提供商插件（把集成文档合并进提供商目录）
import { ConfigProviderPlugin } from "../../config/plugin/provider.js"
// 导入 SKILL.md 解析工具
import { SkillFile } from "../../config/plugin/skill-file.js"
// 导入 Console 访问辅助（服务器地址、请求头等）
import { ConsoleAccess } from "../../console-access.js"
// 导入凭据模块
import { Credential } from "../../credential.js"
import { Flag } from "../../flag.js"
import { InstructionDiscovery } from "../../instruction-discovery.js"
// 导入集成模块
import { Integration } from "../../integration.js"
// 导入集成连接工具
import { IntegrationConnection } from "../../integration/connection.js"
// 导入 Provider 服务与 ID 常量
import { Provider } from "../../provider.js"
// 导入绝对路径 Schema
import { AbsolutePath } from "../../schema.js"
// 导入跨 Location 共享缓存服务
import { SharedCache } from "../../shared-cache.js"
// 导入技能模块
import { Skill } from "../../skill.js"
// 导入技能发现工具（路径安全校验）
import { SkillDiscovery } from "../../skill/discovery.js"
// 导入网页搜索模块
import { WebSearch } from "../../websearch.js"
import { OpencodeWatches } from "./opencode-watches.js"
import { ProviderRefresh } from "./refresh.js"

// Console OAuth 设备码流程的客户端 ID
const clientID = "opencode-cli"
// 设备码登录方式的 ID
const methodID = Integration.MethodID.make("device")
// 设备码申请响应 Schema
const Device = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri_complete: Schema.String,
  expires_in: Schema.Number,
  interval: Schema.Number,
})
// 令牌接口响应 Schema（org_id 可空）
const Token = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
  expires_in: Schema.Number,
  org_id: Schema.optional(Schema.NullOr(Schema.String)),
})
// 设备码尚未批准时的响应 Schema
const TokenPending = Schema.Struct({ error: Schema.String })
// 令牌响应 = 成功令牌或“待授权”错误
const DeviceToken = Schema.Union([Token, TokenPending])
// 用户信息 Schema
const User = Schema.Struct({ id: Schema.String, email: Schema.String })
// 组织信息 Schema
const Org = Schema.Struct({ id: Schema.String, name: Schema.String })
// Console's 403 when the organization enforces SSO and the user's SSO proof is missing or expired.
// Console 的 403：组织强制 SSO 而用户的 SSO 凭证缺失或已过期
const SsoRequired = Schema.Struct({
  _tag: Schema.Literal("SsoRequired"),
  orgId: Schema.String,
  connectionId: Schema.String,
})
// 刷新令牌已失效的标准响应
const InvalidGrant = Schema.Struct({ error: Schema.Literal("invalid_grant") })
// Console's 401 when the session behind the access token was revoked or expired.
// Console 的 401：访问令牌背后的会话已被吊销或过期
const Unauthorized = Schema.Struct({ _tag: Schema.Literal("Unauthorized") })
// The workspace's instructions arrive whole, its skills as versions whose files download separately.
const ConsoleInstructions = Schema.Struct({
  instructions: Schema.Array(Schema.Struct({ id: Schema.String, content: Schema.String })),
})
/** The `GET /api/v2/config` response header Console sends while the caller has workspace instructions and skills. */
const listsHeader = "x-opencode-instructions-skills"
const ConsoleSkills = Schema.Struct({
  skills: Schema.Array(Schema.Struct({ slug: Schema.String, version: Schema.String })),
})
// 技能下载包 Schema：slug + 文件列表
const SkillBundle = Schema.Struct({
  slug: Schema.String,
  files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
})
type ConsoleSkill = { readonly skill: Skill.Info; readonly files: Record<string, string> }
type ConsoleConfig = NonNullable<Effect.Success<ReturnType<typeof fetchConfig>>> & {
  readonly instructions: (typeof ConsoleInstructions.Type)["instructions"]
  readonly skills: (typeof ConsoleSkills.Type)["skills"]
}
const signedOutMessage = "Reconnect OpenCode Console to continue"
// 需要重新 SSO 登录的提示文案
const ssoMessage = (organization: string | undefined) =>
  `Sign in with SSO again to use ${organization ?? "your OpenCode Console organization"}`

// 需要重新 SSO 登录的错误（带组织与跳转 URL）
class SsoRequiredError extends Schema.TaggedError<SsoRequiredError>()("OpencodeConsole.SsoRequired", {
  organization: Schema.optional(Schema.String),
  url: Schema.String,
}) {
  // 错误消息
  override get message() {
    return `${ssoMessage(this.organization)}.`
  }
}

// The Console session or refresh token was revoked or expired; only a new device login recovers.
// Console 会话或刷新令牌已被吊销/过期；只能重新走设备码登录恢复
class SignedOutError extends Schema.TaggedError<SignedOutError>()("OpencodeConsole.SignedOut", {}) {
  // 错误消息
  override get message() {
    return `${signedOutMessage}.`
  }
}

// oauth：构造 OpenCode Console 的设备码 OAuth 登录方式定义
function oauth(http: HttpClient.HttpClient) {
  return {
    // 所属集成 ID
    integrationID: Integration.ID.make("opencode"),
    // 方式定义：设备码 OAuth
    method: {
      id: methodID,
      type: "oauth",
      label: "OpenCode Console account",
      // 隐藏表单字段：Console 服务器地址（默认官方地址）
      form: [
        {
          key: "server",
          type: "string",
          format: "uri",
          hidden: true,
          default: ConsoleAccess.defaultServer,
        },
      ],
    },
    // 授权流程：申请设备码并轮询
    authorize: (answer) =>
      Effect.gen(function* () {
        // 规范化服务器地址（表单缺省用官方地址）
        const server = yield* normalizeServer(answer.server ?? ConsoleAccess.defaultServer)
        // 申请设备码
        const device = yield* post(
          http,
          `${server}/auth/device/code`,
          { client_id: clientID, supports_org_scope: true },
          Device,
        )
        // 校验验证 URL 的协议与格式
        const verification = yield* Effect.try({
          try: () => {
            // 相对地址按服务器为基解析
            const url = new URL(device.verification_uri_complete, `${server}/`)
            // 只允许 http/https
            if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("expected HTTP(S)")
            return url
          },
          // 非法 URL 转为可读错误
          catch: (cause) =>
            new Error(`Invalid device verification URL: ${cause instanceof Error ? cause.message : String(cause)}`),
        })
        // 返回授权结果描述
        return {
          // 自动模式：插件自己轮询
          mode: "auto" as const,
          // 用户需要访问的验证地址
          url: verification.href,
          // 给用户看的说明文案
          instructions: `Enter code: ${device.user_code}`,
          // 回调：按建议间隔轮询令牌
          callback: poll(http, server, device.device_code, Duration.seconds(device.interval)),
        }
      }),
    // 刷新逻辑：用刷新令牌换取新令牌
    refresh: (credential) =>
      Effect.gen(function* () {
        // 向凭据对应的服务器发起刷新请求
        const response = yield* send(http, `${ConsoleAccess.server(credential)}/auth/device/token`, {
          grant_type: "refresh_token",
          refresh_token: credential.refresh,
          client_id: clientID,
        })
        // 400 且为 invalid_grant 时表示已登出
        if (response.status === 400) {
          // 尝试按 InvalidGrant 解码
          const body = yield* HttpClientResponse.schemaBodyJson(InvalidGrant)(response).pipe(Effect.option)
          // 命中则抛出 SignedOut 错误
          if (Option.isSome(body)) return yield* new SignedOutError()
        }
        // 其余情况要求 2xx 并解码令牌
        const token = yield* HttpClientResponse.filterStatusOk(response).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(Token)),
        )
        // Persist rotated tokens without depending on discovery requests.
        // 返回轮换后的凭据（不依赖后续发现请求来持久化）
        return {
          ...credential,
          // 新访问令牌
          access: token.access_token,
          // 新刷新令牌
          refresh: token.refresh_token,
          // 新过期时间
          expires: Date.now() + token.expires_in * 1000,
          // 组织信息：令牌未带 org_id 时保留原元数据，否则更新（orgName 变化时保留旧名）
          metadata:
            token.org_id == null
              ? credential.metadata
              : {
                  ...credential.metadata,
                  orgID: token.org_id,
                  orgName:
                    credential.metadata?.orgID === token.org_id && typeof credential.metadata.orgName === "string"
                      ? credential.metadata.orgName
                      : token.org_id,
                },
        }
      }),
    // 登录条目显示组织名
    label: (credential) => (typeof credential.metadata?.orgName === "string" ? credential.metadata.orgName : undefined),
  } satisfies IntegrationOAuthMethodRegistration
}

// 导出 OpenCode Console 插件：设备码登录、远程配置分发、Library 指令/技能与网页搜索
export const OpencodePlugin = define<
  // 插件声明的环境依赖服务
  | HttpClient.HttpClient
  | Bus.Service
  | Config.Service
  | Flag.Service
  | InstructionDiscovery.Service
  | SharedCache.Service
  | Skill.Service
  | Scope.Scope
>({
  // 插件唯一标识符
  id: "opencode.provider.opencode",
  // 插件主流程生成器
  effect: Effect.fn(function* (ctx) {
    // 是否通过环境变量禁用免费模型
    const disableFree = ["1", "true"].includes(process.env.OPENCODE_DISABLE_FREE_MODELS?.toLowerCase() ?? "")
    // 原始 HTTP 客户端
    const client = yield* HttpClient.HttpClient
    // Every request here goes to the Console, which reads the User-Agent to tell which OpenCode a member runs
    // and whether it evaluates the policies it is being sent.
    // 所有请求都发往 Console；Console 通过 User-Agent 识别成员使用的 OpenCode 版本与策略执行情况
    const http = HttpClient.mapRequest(client, HttpClientRequest.setHeader("User-Agent", App.useragent(ctx.app)))
    // 获取配置服务实例
    const config = yield* Config.Service
    const flags = yield* Flag.Service
    const discovery = yield* InstructionDiscovery.Service
    // 获取技能服务实例
    const skills = yield* Skill.Service
    // 获取共享缓存服务实例
    const cache = yield* SharedCache.Service
    // 获取当前作用域
    const scope = yield* Scope.Scope
    const loading = Semaphore.makeUnsafe(1)
    // 活跃连接类型别名
    type ActiveConnection = Effect.Success<ReturnType<typeof ctx.integration.connection.active>>
    // snapshot：当前应用的快照状态
    let snapshot: {
      // The Console's regular OpenCode config, merged as an integration config layer.
      remote: ConsoleConfig | undefined
      connection: ActiveConnection
      // 组织名
      organization: string | undefined
    } = { remote: undefined, connection: undefined, organization: undefined }
    let instructions: InstructionDiscovery.File[] = []
    // Tagged with the account and workspace they were downloaded for, so a switch hides them right away.
    let consoleSkills: { owner: string; items: ConsoleSkill[] } = { owner: "", items: [] }
    const owner = (from: typeof snapshot) =>
      `${IntegrationConnection.key(from.connection) ?? ""}:${from.organization ?? ""}`
    // A newer config's skill download replaces one still in flight.
    // skillDownload：技能下载 Fiber 句柄，新配置的下载会取代进行中的旧下载
    const skillDownload = yield* FiberHandle.make<void, never>()
    // Status last reported for the active connection, so inference failures can name the fix.
    // reported：活跃连接最近上报的状态，供推理失败时说明修复方式
    let reported: IntegrationConnection.Status | undefined
    // explainers：已注册的响应解释钩子（连接变化时重建）
    let explainers: Effect.Success<ReturnType<typeof ctx.session.hook>>[] = []
    const watches = yield* OpencodeWatches.make(ctx, http)

    // Every project signed in to the same workspace shares one fetch, reused while it is younger than `maxAge`.
    const load = Effect.fn("OpencodePlugin.load")(function* (maxAge: Duration.Input = Duration.minutes(1)) {
      const connection = yield* ctx.integration.connection.active("opencode")
      // 未连接：清空上报状态并返回空快照
      if (!connection) {
        reported = undefined
        return { remote: undefined, connection, organization: undefined }
      }
      // status：上报连接状态并记录到 reported
      const status = (status: IntegrationConnection.Status | undefined) => {
        reported = status
        return ctx.integration.connection.status({ integrationID: "opencode", connection, status })
      }
      // 解析连接凭据并经共享缓存拉取配置
      return yield* ctx.integration.connection.resolve(connection).pipe(
        Effect.flatMap((credential) => {
          // 无凭据或外部凭据：视为未登录
          if (!credential || credential.type === "external")
            return Effect.succeed({ remote: undefined, connection, organization: undefined })
          const workspace = workspaceKey(connection, credential)
          // Each list has its own cache entry, so a failing or malformed one keeps its last copy, or none, and never
          // holds back the config and its policies. `SharedCache` already logs the failure.
          const list = <A>(name: string, load: Effect.Effect<ReadonlyArray<A>, unknown>) =>
            cache
              .get({ key: `opencode-console-${name}:${workspace}`, interval: maxAge, load })
              .pipe(Effect.orElseSucceed((): ReadonlyArray<A> => []))
          return cache
            .get({
              key: `opencode-console:${workspace}`,
              interval: maxAge,
              // A sign-in error is Console's answer for this sign-in, so it is shared like a config rather than
              // replaced by the last config, as a network failure is.
              // 登录类错误是 Console 对本次登录的答复，按配置一样共享缓存，而不像网络错误那样被旧配置顶替
              load: fetchConfig(http, credential).pipe(
                Effect.map((remote) => ({ remote })),
                // 命中连接状态类错误时把失败一并缓存
                Effect.catch((cause) =>
                  connectionStatus(cause) ? Effect.succeed({ failed: cause }) : Effect.fail(cause),
                ),
              ),
            })
            .pipe(
              // 缓存结果是失败时重新抛出
              Effect.flatMap((result) =>
                "failed" in result ? Effect.fail(result.failed) : Effect.succeed(result.remote),
              ),
              Effect.flatMap((remote) =>
                remote?.lists
                  ? Effect.all(
                      {
                        instructions: list(
                          "instructions",
                          fetchList(http, credential, "/api/v2/instructions", ConsoleInstructions).pipe(
                            Effect.map((body) => body?.instructions ?? []),
                          ),
                        ),
                        skills: list(
                          "skills",
                          fetchList(http, credential, "/api/v2/skills", ConsoleSkills).pipe(
                            Effect.map((body) => body?.skills ?? []),
                          ),
                        ),
                      },
                      { concurrency: 2 },
                    ).pipe(Effect.map((lists): ConsoleConfig => ({ ...remote, ...lists })))
                  : Effect.succeed(remote && { ...remote, instructions: [], skills: [] }),
              ),
              Effect.map((remote) => ({
                remote,
                connection,
                organization: organizationName(credential),
              })),
            )
        }),
        // 成功时清除之前上报的错误状态
        Effect.tap(() => status(undefined)),
        Effect.catch((cause) =>
          Effect.gen(function* () {
            // Only well-formed Console errors change the connection status; anything else may be transient.
            // 只有结构化的 Console 错误才改变连接状态；其余可能是暂时性故障
            const next = connectionStatus(cause)
            if (next) yield* status(next)
            yield* Effect.logWarning("failed to load OpenCode provider config", { cause })
            // A load that fails for the connection already in place keeps its last config: dropping it
            // would lift organization policy while personal credentials keep working.
            return IntegrationConnection.key(connection) === IntegrationConnection.key(snapshot.connection)
              ? { remote: snapshot.remote, connection, organization: snapshot.organization }
              : { remote: undefined, connection, organization: undefined }
          }),
        ),
      )
    })
    // The Console document as config layered it. Its providers apply at this plugin's position in the provider chain,
    // while the rest of the document merges through config.
    // integrated：Console 文档作为配置层合并后的引用；其提供商在本插件的位置生效，其余通过 config 合并
    let integrated: ConfigIntegration.Document | undefined
    // integrate：把文档交给 config 服务合并，并记住合并后的文档引用
    const integrate = Effect.fnUntraced(function* (document: ConfigIntegration.Document | undefined) {
      // 交给配置服务登记该集成文档
      yield* config.integration?.(Integration.ID.make("opencode"), document) ?? Effect.void
      // 从配置条目里找出刚合并的 Console 文档
      integrated = (yield* config.entries()).find(
        (entry): entry is ConfigIntegration.Document =>
          entry instanceof ConfigIntegration.Document && entry.integrationID === Integration.ID.make("opencode"),
      )
    })
    // Policies and providers ride on the snapshot, so a credential switch, disconnect, or 404 replaces them too.
    // publish：把快照落成配置文档并同步 Library（凭据切换、断连、404 都会替换策略与提供商）
    const publish = Effect.fnUntraced(function* (next: typeof snapshot) {
      // The config merges as one integration document, which config loads right after managed policies.
      // 组装集成配置文档（紧随托管策略之后加载）
      const document =
        next.remote &&
        next.connection &&
        ConfigIntegration.make({
          integrationID: Integration.ID.make("opencode"),
          // 连接信息（凭据 ID 规范化）
          connection:
            next.connection.type === "credential"
              ? { ...next.connection, id: Credential.ID.make(next.connection.id) }
              : next.connection,
          // 组织名
          organization: next.organization,
          // `make` keeps only the standard config keys, so instructions and skills stay here.
          info: next.remote,
        })
      // 登记文档
      yield* integrate(document)
      // Managed `integration.use: deny` makes config layer a policies-only copy, which withholds instructions,
      // skills and event watches too. Config keeps the document it holds when handed a deep-equal one, so compare by
      // content.
      const allowed = document !== undefined && (!config.integration || isDeepStrictEqual(integrated, document))
      yield* syncInstructionsAndSkills(next, allowed)
      const watching = allowed && next.remote?.watches === true && (yield* flags.enabled("console_watches"))
      yield* syncWatches(watching ? next.connection : undefined)
    })
    // Watching starts when the console_watches flag is on and the Console's config says the workspace has event watches,
    // and stops when either no longer holds.
    const syncWatches = Effect.fnUntraced(
      function* (connection: ActiveConnection) {
        const credential = connection && (yield* ctx.integration.connection.resolve(connection))
        if (!connection || !credential || credential.type === "external") return yield* watches.sync(undefined)
        yield* watches.sync({
          key: workspaceKey(connection, credential),
          server: yield* normalizeServer(ConsoleAccess.server(credential)),
          headers: ctx.integration.connection
            .resolve(connection)
            .pipe(
              Effect.flatMap((current) =>
                current && current.type !== "external"
                  ? Effect.succeed(ConsoleAccess.headers(current))
                  : Effect.fail(new Error("OpenCode Console is not connected")),
              ),
            ),
        })
      },
      Effect.catch((cause) => Effect.logWarning("failed to start Console event watches", { cause })),
    )
    const syncInstructionsAndSkills = (next: typeof snapshot, allowed: boolean) => {
      const remote = allowed ? next.remote : undefined
      instructions = (remote?.instructions ?? []).map(
        (item) =>
          new InstructionDiscovery.File({ path: `OpenCode Console instruction ${item.id}`, content: item.content }),
      )
      if (!allowed) consoleSkills = { owner: "", items: [] }
      // Skills download in the background, so startup and config changes never wait on them. The current ones stay
      // until the download replaces them.
      // 技能在后台下载，启动与配置变更都不等待；当前技能保留到新下载替换为止
      return FiberHandle.run(
        skillDownload,
        loadSkills(next.connection, remote?.skills ?? []).pipe(
          Effect.flatMap((loaded) => {
            // A failed load keeps the skills already shown.
            // 下载失败时保留现有技能
            if (!loaded) return Effect.void
            consoleSkills = { owner: owner(next), items: loaded }
            return skills.reload()
          }),
        ),
      )
    }
    // loadSkills：按列表并发下载技能包（经共享缓存去重）
    const loadSkills = Effect.fnUntraced(
      function* (
        // 来源连接
        connection: ActiveConnection,
        // Library 列出的技能（slug + 版本）
        listed: ReadonlyArray<{ readonly slug: string; readonly version: string }>,
      ) {
        // 列表为空或未连接时返回空
        if (listed.length === 0 || !connection) return []
        // 解析连接凭据
        const credential = yield* ctx.integration.connection.resolve(connection)
        // 无凭据则无技能
        if (!credential || credential.type === "external") return []
        // 规范化服务器地址
        const server = yield* normalizeServer(ConsoleAccess.server(credential))
        // 工作区键（缓存键的一部分）
        const workspace = workspaceKey(connection, credential)
        // 并发 8 路下载每个技能
        const loaded = yield* Effect.forEach(
          listed,
          (item) => {
            // 缓存条目：键按工作区 + slug，永不过期
            const input = {
              key: `opencode-console-skill:${workspace}:${item.slug}`,
              interval: Duration.infinity,
              load: downloadSkill(http, server, item.slug, ConsoleAccess.headers(credential)).pipe(
                Effect.map((skill) => ({ version: item.version, skill })),
              ),
            }
            // Every project shares one download per skill. Any other version, or a failure, downloads again; a failed
            // download keeps the last copy that loaded.
            // 每个技能各项目共享一次下载；版本不符或失败时强制重下，再失败则保留上次成功的副本
            return cache.get(input).pipe(
              // 校验缓存版本与列表一致
              Effect.filterOrFail((cached) => cached.version === item.version),
              // 不一致时强制刷新一次
              Effect.catch(() => cache.get({ ...input, force: true })),
              // 取出技能
              Effect.map((cached) => cached.skill),
              // 单个技能失败只记警告
              Effect.catch((cause) =>
                Effect.logWarning("failed to load Console skill", { slug: item.slug, cause }).pipe(
                  Effect.as(undefined),
                ),
              ),
            )
          },
          { concurrency: 8 },
        )
        // 过滤掉失败的条目
        return loaded.filter((item) => item !== undefined)
      },
      // 整体失败也只记警告
      Effect.catch((cause) => Effect.logWarning("failed to load Console skills", { cause }).pipe(Effect.as(undefined))),
    )
    // search：构造 OpenCode 网页搜索提供器（走 Console 的 /api/websearch）
    const search = (providerID: WebSearch.ID, connection: NonNullable<ActiveConnection>) => ({
      // 提供器 ID
      id: providerID,
      // 显示名
      name: "OpenCode Web Search",
      // 执行一次搜索
      execute: (input: WebSearch.ProviderInput) =>
        Effect.gen(function* () {
          // 读取当前活跃连接
          const active = yield* ctx.integration.connection.active("opencode")
          // 连接已切换则失败
          if (!active || IntegrationConnection.key(active) !== IntegrationConnection.key(connection))
            return yield* Effect.fail(new Error("OpenCode Console connection changed"))
          // 解析凭据
          const credential = yield* ctx.integration.connection.resolve(active)
          // 未连接则失败
          if (!credential || credential.type === "external")
            return yield* Effect.fail(new Error("OpenCode Console is not connected"))
          // 读取元数据
          const metadata = credential.metadata
          // 组织 ID（字符串才有效）
          const orgID = typeof metadata?.orgID === "string" ? metadata.orgID : undefined
          // 鉴权令牌：OAuth 用访问令牌，key 型用密钥
          const token = credential.type === "oauth" ? credential.access : credential.key
          // 规范化服务器地址
          const server = yield* normalizeServer(ConsoleAccess.server(credential))
          // 构造搜索请求
          const request = yield* HttpClientRequest.post(`${server}/api/websearch`).pipe(
            HttpClientRequest.acceptJson,
            HttpClientRequest.bearerToken(token),
            // 有组织时附加组织头
            HttpClientRequest.setHeaders(orgID ? { "x-org-id": orgID } : {}),
            HttpClientRequest.schemaBodyJson(WebSearch.Input)({
              query: input.query,
              providerID,
            }),
          )
          // 手动跟随重定向地发送请求（25 秒超时）
          const response = yield* follow(http, request).pipe(
            Effect.flatMap(HttpClientResponse.schemaBodyJson(WebSearch.Response)),
            Effect.scoped,
            Effect.timeoutOrElse({
              duration: Duration.seconds(25),
              orElse: () => Effect.fail(new Error("OpenCode web search request timed out")),
            }),
          )
          // 返回的提供器与请求不符视为错误
          if (response.providerID !== providerID) {
            return yield* Effect.fail(
              new Error(`OpenCode web search returned provider ${response.providerID} instead of ${providerID}`),
            )
          }
          // 返回搜索结果
          return response.results
        }),
    })

    // 注册集成名称与登录方式
    yield* ctx.integration.transform((editor) => {
      // 更新 opencode 集成的展示名
      editor.update("opencode", (integration) => {
        integration.name = "OpenCode Console"
      })
      // 注册设备码 OAuth 登录方式
      editor.method.update(oauth(http))
      // 注册服务账号 API key 登录方式
      editor.method.update({ integrationID: "opencode", method: { type: "key", label: "API key (service account)" } })
    })

    snapshot = yield* load()
    yield* publish(snapshot)
    // 提供商目录变换：把 Console 文档中的提供商合并进来
    yield* ctx.provider.transform((providers) => {
      if (integrated) ConfigProviderPlugin.integrate(providers, integrated)
    })
    // 提供商目录变换：无凭据时启用免费公开访问
    yield* ctx.provider.transform((providers) => {
      // 取 opencode 提供商条目
      const item = providers.get(Provider.ID.opencode)
      // 不存在则跳过
      if (!item) return
      // 是否已有可用凭据（环境变量、连接或配置的 key）
      const hasKey = Boolean(process.env.OPENCODE_API_KEY || snapshot.connection || item.provider.settings?.apiKey)
      // 更新提供商
      providers.update(item.provider.id, (provider) => {
        // 没有任何凭据且未禁用免费模型时启用并使用公共 key
        if (!hasKey && !disableFree) {
          provider.activation = "enabled"
          provider.settings = { ...provider.settings, apiKey: "public" }
        }
      })
    })
    // 模型目录变换：无凭据时隐藏付费模型
    yield* ctx.model.transform((models) => {
      // 取 opencode 提供商条目
      const item = models.provider.get(Provider.ID.opencode)
      // 不存在则跳过
      if (!item) return
      // 是否已有真凭据（public key 不算）
      const hasKey = Boolean(
        process.env.OPENCODE_API_KEY ||
          snapshot.connection ||
          (item.provider.settings?.apiKey && item.provider.settings.apiKey !== "public"),
      )
      // 有凭据则不做限制
      if (hasKey) return
      // 遍历模型，隐藏所有有输入费用的模型
      for (const model of models.list(item.provider.id)) {
        // 免费模型保持可用
        if (!model.cost.some((cost) => cost.input > 0)) continue
        // 禁用付费模型
        models.update(item.provider.id, model.id, (draft) => {
          draft.enabled = false
        })
      }
    })
    // The Console's config selects its provider only when the workspace enabled hosted search and the member's policy
    // allows it; otherwise its searches fail, so the provider is offered only then. The selection still merges as
    // config, where the user's own choice wins.
    // 网页搜索目录变换：仅当工作区开启托管搜索且策略允许时才提供 OpenCode 搜索器
    yield* ctx.websearch.transform((editor) => {
      // 目标提供器 ID
      const provider = WebSearch.ID.make("opencode")
      // Console 配置选中了该提供器且已连接时注册
      if (snapshot.remote?.websearch && snapshot.remote.websearch.provider === provider && snapshot.connection)
        editor.add(search(provider, snapshot.connection))
    })
    // 指令发现变换：注册 Console 下发的指令文件
    yield* discovery.transform((editor) => instructions.forEach((file) => editor.add(file)))
    // 技能目录变换：仅当技能归属与当前快照一致时注册
    yield* skills.transform((editor) => {
      if (consoleSkills.owner !== owner(snapshot)) return
      consoleSkills.items.forEach((item) => editor.add(item.skill, item.files))
    })

    // apply：应用新快照并重建受影响的目录
    const apply = Effect.fn("OpencodePlugin.apply")(function* (next: typeof snapshot) {
      // 更新当前快照
      snapshot = next
      // 发布配置与 Library
      yield* publish(next)
      // 重建响应解释钩子
      yield* guard(next)
      // 并发重载提供商、搜索、MCP、指令与技能目录
      yield* Effect.all(
        [ctx.provider.reload(), ctx.websearch.reload(), ctx.mcp.reload(), discovery.reload(), skills.reload()],
        { concurrency: 5, discard: true },
      )
    })
    const refresh = () => loading.withPermit(load().pipe(Effect.andThen(apply)))
    // Annotated: `apply` re-registers the hooks that call `check`, which would otherwise make inference circular.
    const check = (maxAge?: Duration.Input): Effect.Effect<void> =>
      loading.withPermit(
        Effect.gen(function* () {
          const next = yield* load(maxAge)
          if (!Equal.equals(snapshot, next)) yield* apply(next)
        }),
      )

    // Console inference rejects a missing SSO sign-in with a generic 401/403. Re-check the Console config, which
    // reports the reason, and replace the response with instructions when the connection needs the user.
    // A client retrying rejected inference would otherwise send one config request per failed response.
    // explain：推理返回 401/403 时复查配置，并用连接状态信息替换响应体
    const explain = (event: SessionHttpResponse) =>
      Effect.gen(function* () {
        // 只处理 401/403
        if (event.response.status !== 401 && event.response.status !== 403) return
        // 复查一次 Console 配置
        yield* check(Duration.seconds(30))
        // 取最近上报的连接状态
        const status = reported
        // 没有结构化状态时不改写响应
        if (!status) return
        // 取消原响应体
        void event.response.body?.cancel()
        // 改写为带说明的认证错误响应
        event.response = Response.json(
          {
            error: {
              type: "authentication_error",
              message: `${status.message}.`,
            },
          },
          { status: event.response.status },
        )
      })
    // Hooks are scoped per provider so requests to unrelated providers skip the HTTP hook path.
    // guard：按当前快照涉及的提供商重挂响应解释钩子
    const guard = Effect.fn("OpencodePlugin.guard")(function* (next: typeof snapshot) {
      // 先释放旧的钩子注册
      yield* Effect.forEach(explainers, (registration) => registration.dispose, { discard: true })
      // 重新注册：已连接时覆盖 opencode 提供商与远程配置声明的所有提供商
      explainers = yield* Effect.forEach(
        next.connection ? new Set([Provider.ID.opencode, ...Object.keys(next.remote?.providers ?? {})]) : [],
        (providerID) => ctx.session.hook("http.response", explain, { providerID }).pipe(Scope.provide(scope)),
      )
    })
    // 启动时挂一次钩子
    yield* guard(snapshot)

    // Console config can change independently of local credential activity, so re-fetch
    // periodically and only rebuild the catalog and search providers when the snapshot differs.
    // Only while connected: a signed-out location runs no timer and no credential lookups.
    const polling = yield* FiberHandle.make<void, never>()
    // poll：按开关启停轮询循环
    const poll = Effect.fnUntraced(function* () {
      if (!snapshot.connection) return yield* FiberHandle.clear(polling)
      yield* FiberHandle.run(polling, Effect.sleep(Duration.minutes(1)).pipe(Effect.andThen(check()), Effect.forever), {
        onlyIfMissing: true,
      })
    })
    yield* ProviderRefresh.onSwitch("opencode", refresh().pipe(Effect.andThen(poll())))
    yield* poll()
  }),
})

// fetchConfig：从 Console 拉取该凭据对应的配置文档
function fetchConfig(http: HttpClient.HttpClient, value: Credential.Key | Credential.OAuth) {
  // Scoped so responses whose body is never read (404, errors) are released here instead of by a GC-time abort.
  // 每次请求用独立作用域，未读的响应体（404/错误）在这里释放，而不是等 GC 时中断
  return HttpClient.withScope(http)
    .execute(
      HttpClientRequest.get(`${ConsoleAccess.server(value)}/api/v2/config`).pipe(
        HttpClientRequest.acceptJson,
        // 附带该凭据的 Console 请求头
        HttpClientRequest.setHeaders(ConsoleAccess.headers(value)),
      ),
    )
    .pipe(
      Effect.flatMap((response) =>
        Effect.gen(function* () {
          // 404 表示该工作区没有下发配置
          if (response.status === 404) return undefined
          // 401：会话已被吊销或过期
          if (response.status === 401) {
            const body = yield* HttpClientResponse.schemaBodyJson(Unauthorized)(response).pipe(Effect.option)
            if (Option.isSome(body)) return yield* new SignedOutError()
          }
          // 403：需要重新 SSO 登录
          if (response.status === 403) {
            const body = yield* HttpClientResponse.schemaBodyJson(SsoRequired)(response).pipe(Effect.option)
            if (Option.isSome(body))
              return yield* new SsoRequiredError({
                organization: organizationName(value),
                // 计算重新登录的跳转地址
                url: yield* ssoUrl(ConsoleAccess.server(value), body.value.connectionId),
              })
          }
          const watches = response.headers[OpencodeWatches.header] !== undefined
          const lists = response.headers[listsHeader] !== undefined
          const body = yield* HttpClientResponse.filterStatusOk(response).pipe(Effect.flatMap((ok) => ok.json))
          return { ...(yield* Schema.decodeUnknownEffect(ConfigIntegration.Remote)(body)), watches, lists }
        }),
      ),
      Effect.scoped,
      // A Console that accepts the connection but never answers would otherwise hold the load, including the one at
      // startup, indefinitely. A timeout is a transient failure, which `SharedCache` retries.
      Effect.timeout(Duration.seconds(5)),
    )
}

// A 404 (none in the workspace) or a 403 other than SSO (the sign-in may not read them) is an empty list. Any other
// error, including a malformed body, fails so the caller keeps the last list.
function fetchList<A>(
  http: HttpClient.HttpClient,
  value: Credential.Key | Credential.OAuth,
  path: string,
  schema: Schema.Decoder<A>,
) {
  return HttpClient.withScope(http)
    .execute(
      HttpClientRequest.get(`${ConsoleAccess.server(value)}${path}`).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.setHeaders(ConsoleAccess.headers(value)),
      ),
    )
    .pipe(
      Effect.flatMap((response) =>
        Effect.gen(function* () {
          if (response.status === 404) return undefined
          if (
            response.status === 403 &&
            Option.isNone(yield* HttpClientResponse.schemaBodyJson(SsoRequired)(response).pipe(Effect.option))
          )
            return undefined
          return yield* HttpClientResponse.schemaBodyJson(schema)(yield* HttpClientResponse.filterStatusOk(response))
        }),
      ),
      Effect.scoped,
      Effect.timeout(Duration.seconds(5)),
    )
}

// ssoUrl：构造 SSO 重新登录的跳转地址
function ssoUrl(server: string, connectionID: string) {
  return normalizeServer(server).pipe(
    Effect.map((base) => {
      // Console only redirects to paths under its own base path after SSO.
      // SSO 完成后 Console 只跳回自己基路径之下，因此 redirectTo 用基路径
      const redirectTo = `${new URL(base).pathname.replace(/\/+$/, "")}/`
      // 拼接 SSO 启动地址
      return `${base}/auth/sso/${encodeURIComponent(connectionID)}/start?redirectTo=${encodeURIComponent(redirectTo)}`
    }),
  )
}

// connectionStatus：把错误映射为连接状态（仅识别结构化的 Console 错误）
function connectionStatus(cause: unknown): IntegrationConnection.Status | undefined {
  // 需要 SSO 登录
  if (cause instanceof SsoRequiredError)
    return {
      status: "needs_auth",
      message: ssoMessage(cause.organization),
      url: cause.url,
    }
  // 已登出（含被包装在授权错误里的情况）
  if (
    cause instanceof SignedOutError ||
    (cause instanceof Integration.AuthorizationError && cause.cause instanceof SignedOutError)
  )
    return { status: "needs_auth", message: signedOutMessage }
  // 其他错误不改变连接状态
  return undefined
}

// API keys carry no account or org, so the sign-in itself identifies the workspace.
// workspaceKey：工作区缓存键（API key 不带账号/组织信息，因此用登录本身来区分工作区）
function workspaceKey(
  connection: NonNullable<Parameters<typeof IntegrationConnection.key>[0]>,
  credential: Credential.Key | Credential.OAuth,
) {
  // 服务器、连接键、组织 ID 与 key 指纹共同构成键
  return JSON.stringify([
    ConsoleAccess.server(credential),
    IntegrationConnection.key(connection),
    credential.metadata?.orgID,
  ])
}

function organizationName(credential: Credential.Value) {
  return typeof credential.metadata?.orgName === "string" ? credential.metadata.orgName : undefined
}

// 最大重定向次数
const MAX_REDIRECTS = 5
// 视为重定向的状态码集合
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
// Headers that name or authenticate the caller. They stay with the Console's origin when a redirect leaves it.
// 载明调用方身份的请求头；重定向离开 Console 源站时必须剥掉
const CREDENTIAL_HEADERS = new Set(["authorization", "cookie", "proxy-authorization", "x-org-id"])

// The Console answers skill downloads with a presigned-storage redirect and web search through a gateway that may
// redirect too, so a redirect is a normal answer. Following it here, instead of letting fetch follow it, bounds the
// hops and keeps the connection's credentials from crossing an origin boundary.
// follow：手动跟随重定向的请求执行（限制跳数并防止凭据跨源）
function follow(
  http: HttpClient.HttpClient,
  request: HttpClientRequest.HttpClientRequest,
  redirects = 0,
): Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError | Error, Scope.Scope> {
  // Scoped per hop so a caller's timeout or interruption aborts the request in flight.
  // 每一跳独立作用域，调用方超时或中断都能中止在途请求
  return HttpClient.withScope(http)
    .execute(request)
    .pipe(
      // 让 fetch 不自动跟随重定向
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.flatMap((response) => {
        // 读取 Location 头
        const location = response.headers.location
        // 非重定向或无 Location：要求 2xx 并返回
        if (!REDIRECT_STATUSES.has(response.status) || !location) return HttpClientResponse.filterStatusOk(response)
        // 超过跳数上限则失败
        if (redirects >= MAX_REDIRECTS) return Effect.fail(new Error(`Too many redirects (more than ${MAX_REDIRECTS})`))
        // 解析目标并继续
        return Effect.flatMap(redirectTarget(request, location), (target) =>
          // Release this hop's connection before the next request instead of holding it until the download ends.
          // 下一跳之前先释放本跳连接，而不是握到下载结束
          HttpClientResponse.stream(Effect.succeed(response)).pipe(
            Stream.runDrain,
            // The redirect's own body is irrelevant, so failing to read it must not fail the download.
            // 重定向响应体无关紧要，读失败不影响下载
            Effect.ignore,
            // 用改写后的请求继续下一跳
            Effect.andThen(follow(http, redirected(request, target, response.status), redirects + 1)),
          ),
        )
      }),
    )
}

// redirectTarget：解析 Location 为绝对 URL 并校验协议
function redirectTarget(request: HttpClientRequest.HttpClientRequest, location: string) {
  return Effect.try({
    try: () => {
      // 相对地址按原请求为基解析
      const target = new URL(location, request.url)
      // 只允许 http/https
      if (target.protocol !== "http:" && target.protocol !== "https:")
        throw new Error(`redirect to unsupported protocol ${target.protocol}`)
      return target
    },
    // 转为 Error
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  })
}

// redirected：按重定向语义改写下一跳请求
function redirected(request: HttpClientRequest.HttpClientRequest, target: URL, status: number) {
  // A 303 always, and a 301 or 302 after a POST, become a bodyless GET, as fetch would send them.
  // 303 总是改为 GET；POST 之后的 301/302 也改为 GET（与 fetch 行为一致）
  const get = status === 303 || ((status === 301 || status === 302) && request.method === "POST")
  // 跨源时剥掉身份头，同源保留
  const headers =
    target.origin === new URL(request.url).origin
      ? request.headers
      : Object.fromEntries(Object.entries(request.headers).filter(([name]) => !CREDENTIAL_HEADERS.has(name)))
  // `HttpClientRequest.method` is typed `string`, while `make` only accepts a known method.
  // The `href` string keeps the location's query exactly as sent: a `URL` would decode and re-encode it,
  // which breaks a presigned archive download whose signature covers the encoding.
  // 用 href 字符串保持 Location 中的查询串原样（URL 会重编码，破坏预签名签名）
  return HttpClientRequest.make(get ? "GET" : (request.method as HttpMethod.HttpMethod))(target.href, {
    headers,
    // 改为 GET 时清空请求体
    body: get ? HttpBody.empty : request.body,
  })
}

// downloadSkill：下载并校验一个 Library 技能包
function downloadSkill(http: HttpClient.HttpClient, server: string, slug: string, headers: Record<string, string>) {
  return Effect.gen(function* () {
    // slug 必须是安全路径片段
    if (!SkillDiscovery.isSafeSegment(slug)) return yield* Effect.fail(new Error(`unsafe skill slug: ${slug}`))
    // 请求技能包（30 秒超时，手动跟随重定向）
    const bundle = yield* follow(
      http,
      HttpClientRequest.get(`${server}/api/v2/skills/${encodeURIComponent(slug)}`).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.setHeaders(headers),
      ),
    ).pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(SkillBundle)), Effect.scoped, Effect.timeout("30 seconds"))
    // 返回的 slug 必须与请求一致
    if (bundle.slug !== slug) return yield* Effect.fail(new Error(`expected skill ${slug}, received ${bundle.slug}`))
    // 所有文件路径必须是安全相对路径
    const unsafe = bundle.files.find((file) => !SkillDiscovery.isSafeRelativePath(file.path))
    if (unsafe) return yield* Effect.fail(new Error(`unsafe skill file path: ${unsafe.path}`))
    // 必须有 SKILL.md 主文件
    const main = bundle.files.find((file) => file.path === "SKILL.md")
    if (!main) return yield* Effect.fail(new Error(`skill ${slug} has no SKILL.md`))
    // 解析 SKILL.md 内容
    const parsed = SkillFile.parse(`/${slug}`, `/${slug}/SKILL.md`, main.content)
    // 解析失败视为无效技能
    if (parsed._tag !== "Parsed") return yield* Effect.fail(new Error(`skill ${slug} has an invalid SKILL.md`))
    // 返回技能信息与附加文件内容
    return {
      // 技能信息（路径规范化为 OpenCode 技能 URI）
      skill: { ...parsed.skill, path: AbsolutePath.make(Skill.uri(slug, "SKILL.md")) },
      // SKILL.md 之外的文件映射
      files: Object.fromEntries(
        bundle.files.filter((file) => file.path !== "SKILL.md").map((file) => [file.path, file.content]),
      ),
    } satisfies ConsoleSkill
  })
}

// normalizeServer：规范化 Console 服务器地址（校验协议并去尾部斜杠）
function normalizeServer(input: unknown) {
  return Effect.try({
    try: () => {
      // 必须是字符串
      if (typeof input !== "string") throw new Error("expected string")
      // 解析 URL
      const url = new URL(input)
      // 只允许 http/https
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("expected HTTP(S)")
      // 返回 origin + 去尾斜杠的路径
      return `${url.origin}${url.pathname.replace(/\/+$/, "")}`
    },
    // 转为可读错误
    catch: (cause) =>
      new Error(`Invalid OpenCode server URL: ${cause instanceof Error ? cause.message : String(cause)}`),
  })
}

// poll：设备码轮询循环（按间隔查询令牌接口）
function poll(http: HttpClient.HttpClient, server: string, deviceCode: string, interval: Duration.Duration) {
  // loop：单次轮询逻辑
  const loop = (wait: Duration.Duration): Effect.Effect<Credential.OAuth, unknown> =>
    Effect.gen(function* () {
      // 等待建议间隔
      yield* Effect.sleep(wait)
      // 查询令牌（允许非 2xx 以读取“待授权”错误）
      const result = yield* post(
        http,
        `${server}/auth/device/token`,
        {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: deviceCode,
          client_id: clientID,
        },
        DeviceToken,
        false,
      )
      // 拿到令牌则构造凭据
      if ("access_token" in result) return yield* credential(http, server, result)
      // 用户尚未批准：按原间隔继续
      if (result.error === "authorization_pending") return yield* loop(wait)
      // 服务器要求放慢：间隔加 5 秒
      if (result.error === "slow_down") {
        return yield* loop(Duration.sum(wait, Duration.seconds(5)))
      }
      // 其余错误直接失败
      return yield* Effect.fail(new Error(`Device authorization failed: ${result.error}`))
    })
  // 从建议间隔开始轮询
  return loop(interval)
}

// credential：令牌到手后拉取用户与组织信息并构造凭据
function credential(http: HttpClient.HttpClient, server: string, token: typeof Token.Type) {
  return Effect.gen(function* () {
    // 并发请求用户信息与组织列表
    const [user, orgs] = yield* Effect.all(
      [
        get(http, `${server}/api/user`, token.access_token, User),
        get(http, `${server}/api/orgs`, token.access_token, Schema.Array(Org)),
      ],
      { concurrency: 2 },
    )
    // 选定组织：令牌带 org_id 时按其查找，否则按名称（再按 ID）取第一个
    const org =
      token.org_id == null
        ? orgs.toSorted((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))[0]
        : orgs.find((org) => org.id === token.org_id)
    // 令牌指定了组织却找不到时失败
    if (token.org_id != null && !org) {
      return yield* Effect.fail(new Error(`OpenCode organization not found: ${token.org_id}`))
    }
    // 构造 OAuth 凭据（元数据记录服务器、账号与组织）
    return Credential.OAuth.make({
      type: "oauth" as const,
      methodID,
      access: token.access_token,
      refresh: token.refresh_token,
      expires: Date.now() + token.expires_in * 1000,
      metadata: {
        server,
        accountID: user.id,
        email: user.email,
        orgID: org?.id,
        orgName: org?.name,
      },
    })
  })
}

// get：带令牌的 GET 请求并按 Schema 解码
function get<S extends Schema.Top>(http: HttpClient.HttpClient, url: string, token: string, schema: S) {
  return HttpClient.filterStatusOk(http)
    .execute(HttpClientRequest.get(url).pipe(HttpClientRequest.acceptJson, HttpClientRequest.bearerToken(token)))
    .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)))
}

// post：JSON POST 请求；statusOk 为 false 时允许非 2xx 响应进入解码
function post<S extends Schema.Top>(
  http: HttpClient.HttpClient,
  url: string,
  body: Record<string, string | boolean>,
  schema: S,
  statusOk = true,
) {
  return send(http, url, body).pipe(
    Effect.flatMap((response) => (statusOk ? HttpClientResponse.filterStatusOk(response) : Effect.succeed(response))),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
  )
}

// send：构造并发送 JSON POST 请求
function send(http: HttpClient.HttpClient, url: string, body: Record<string, string | boolean>) {
  return HttpClientRequest.post(url).pipe(
    HttpClientRequest.acceptJson,
    // 请求体限定为字符串/布尔值的键值对
    HttpClientRequest.schemaBodyJson(Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Boolean])))(body),
    Effect.flatMap((request) => http.execute(request)),
  )
}
