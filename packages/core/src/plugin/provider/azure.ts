// Effect 生态：时钟、效果、相等性、纤维句柄、Option、Schema、信号量、流
import { Clock, Effect, Equal, FiberHandle, Option, Schema, Semaphore, Stream } from "effect"
// HTTP 客户端相关
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
// ChildProcess：子进程构造
import { ChildProcess } from "effect/process"
// define：插件定义辅助函数
import { define } from "@opencode/plugin/effect/plugin"
// Form：表单字段 Schema
import { Form } from "@opencode/schema/form"
// AppProcess：子进程运行服务
import { AppProcess } from "@opencode/util/process"
// App：应用元信息
import { App } from "../../app.js"
// Credential：凭据服务与类型
import { Credential } from "../../credential.js"
// Integration：集成服务与类型
import { Integration } from "../../integration.js"
// IntegrationConnection：连接类型与辅助
import { IntegrationConnection } from "../../integration/connection.js"
// Model：模型类型
import { Model } from "../../model.js"
// Provider：提供商服务与 ID
import { Provider } from "../../provider.js"
// SharedCache：共享缓存服务
import { SharedCache } from "../../shared-cache.js"
// which：在 PATH 中查找可执行文件
import { which } from "../../util/which.js"
// PluginInternal：内部插件类型
import type { PluginInternal } from "../internal.js"
// configuredSettings：读取提供商的用户配置
import { configuredSettings } from "./configured.js"
// activeCredential：读取当前活跃凭据
import { activeCredential } from "./credential-settings.js"
// ProviderRefresh：提供商切换刷新辅助
import { ProviderRefresh } from "./refresh.js"

// Cognitive Services API 的 OAuth 作用域（scope）
const cognitiveScope = "https://cognitiveservices.azure.com/.default"
// Azure AI Foundry 的 OAuth 作用域
const foundryScope = "https://ai.azure.com/.default"
// Azure 资源管理 API 的 OAuth 作用域
const managementScope = "https://management.azure.com/.default"
// Azure CLI 外部认证方式的 ID
const methodID = Integration.MethodID.make("azure-cli")
// A resource name becomes a hostname label and a query literal, so anything else never leaves the process. Azure
// allows only letters, digits, and hyphens in it.
// https://learn.microsoft.com/azure/ai-services/cognitive-services-custom-subdomains
// 资源名会拼进主机名与查询字面量，必须严格校验：仅允许字母、数字、连字符。
const resourcePattern = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/
// JSON 字符串解码器
const decodeJSON = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))
// az CLI 令牌输出的解码器
const decodeToken = Schema.decodeUnknownEffect(
  // 结构：accessToken 必填，两种过期时间字段可选
  Schema.Struct({
    // 访问令牌
    accessToken: Schema.NonEmptyString,
    // 秒级过期时间戳（可选）
    expires_on: Schema.optional(Schema.Number),
    // 字符串过期时间（可选）
    expiresOn: Schema.optional(Schema.NonEmptyString),
  }),
)
// 资源面（data-plane）部署列表响应结构
const ResourceDeployments = Schema.Struct({ data: Schema.Array(Schema.Unknown) })
// 单条资源部署的解码器（Option 形态，失败不抛错）
const decodeResourceDeployment = Schema.decodeUnknownOption(
  // 结构：id/model/status
  Schema.Struct({ id: Schema.NonEmptyString, model: Schema.NonEmptyString, status: Schema.String }),
)
// 管理面部署列表响应结构（分页）
const ManagementDeployments = Schema.Struct({
  // 当前页数据
  value: Schema.Array(Schema.Unknown),
  // 下一页链接（可选）
  nextLink: Schema.optional(Schema.NonEmptyString),
})
// 单条管理面部署的解码器
const decodeManagementDeployment = Schema.decodeUnknownOption(
  // 结构：name + properties(model.name, provisioningState)
  Schema.Struct({
    // 部署名
    name: Schema.NonEmptyString,
    // 属性
    properties: Schema.Struct({
      // 模型名
      model: Schema.Struct({ name: Schema.NonEmptyString }),
      // 预配状态
      provisioningState: Schema.String,
    }),
  }),
)
// Resource Graph 查询请求体结构
const ResourceQuery = Schema.Struct({ query: Schema.String })
// 资源查询响应结构
const Resources = Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.NonEmptyString })) })

// Deployment：一个已部署模型的最小描述
type Deployment = { readonly name: string; readonly model: string }

// make：工厂函数（endpoints 可注入以便测试）
export function make(
  // 默认的资源端点与管理端点
  endpoints = {
    // 由资源名构造资源数据面端点
    resource: (name: string) => `https://${name}.openai.azure.com/openai`,
    // 管理面端点
    management: "https://management.azure.com",
  },
) {
  // 返回插件定义
  return define({
    // 插件唯一标识
    id: "opencode.provider.azure",
    // 插件激活时执行的生成器主体
    effect: Effect.fn(function* (ctx) {
      // 读取用户对 Azure 的配置
      const configured = yield* configuredSettings(Provider.ID.azure)
      // 子进程运行服务
      const processes = yield* AppProcess.Service
      // 凭据服务
      const credentials = yield* Credential.Service
      // 提供商服务
      const providers = yield* Provider.Service
      // 共享缓存服务
      const cache = yield* SharedCache.Service
      // HTTP 客户端（仅放行 2xx 状态）
      const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
      // 按作用域缓存的令牌表
      const tokens = new Map<string, { access: string; expires: number }>()
      // A resource keeps its Azure Resource Manager ID until it is deleted, so discovery looks it up once.
      // 资源在其删除前保有固定的 ARM ID，发现流程只需查询一次。
      const resourceIDs = new Map<string, string>()
      // 容量为 1 的信号量：串行化绑定/发布流程
      const loading = Semaphore.makeUnsafe(1)
      // 发现流程的后台纤维句柄
      const discovery = yield* FiberHandle.make<void, never>()
      // 内存中的当前加载状态
      const loaded: {
        // 当前凭据对应的资源名
        resource?: string
        // 当前的部署列表 URL
        url?: string
        // 当前部署清单
        deployments?: readonly Deployment[]
        // 当前活跃连接
        connection?: Effect.Success<ReturnType<typeof ctx.integration.connection.active>>
        // 显式类型标注
      } = {}

      // command：运行 az CLI 命令并解析 JSON 输出
      const command = (args: string[]) =>
        // 运行子进程
        processes
          .run(ChildProcess.make("az", args, { extendEnv: true, stdin: "ignore" }), { timeout: "10 seconds" })
          .pipe(
            // 要求命令成功退出
            Effect.flatMap(AppProcess.requireSuccess),
            // 输出按 JSON 解析
            Effect.flatMap((result) => decodeJSON(result.stdout.toString("utf8"))),
          )

      // token：获取（带缓存的）指定作用域的 Azure CLI 令牌
      const token = Effect.fn("AzurePlugin.token")(function* (scope: string) {
        // 取当前时间
        const now = yield* Clock.currentTimeMillis
        // 查缓存
        const cached = tokens.get(scope)
        // 缓存剩余有效期大于 5 分钟则复用
        if (cached && cached.expires - now > 5 * 60_000) return cached
        // 调用 az CLI 获取访问令牌并解码
        const result = yield* command(["account", "get-access-token", "--scope", scope, "--output", "json"]).pipe(
          // 解码令牌结构
          Effect.flatMap(decodeToken),
        )
        // 计算过期毫秒时间戳：expires_on 为秒级；expiresOn 为字符串
        const expires = result.expires_on !== undefined ? result.expires_on * 1000 : Date.parse(result.expiresOn ?? "")
        // 无法解析过期时间则失败
        if (!Number.isFinite(expires))
          // 返回错误
          return yield* Effect.fail(new Error("Azure CLI returned an invalid token expiration"))
        // 组装刷新后的令牌
        const refreshed = { access: result.accessToken, expires }
        // 写入缓存
        tokens.set(scope, refreshed)
        // 返回令牌
        return refreshed
      })

      // management：带管理面令牌执行 HTTP 请求
      const management = (request: HttpClientRequest.HttpClientRequest) =>
        // 先取令牌
        token(managementScope).pipe(
          // 携带令牌发送请求
          Effect.flatMap((current) =>
            // 执行请求
            http.execute(
              // 对请求做加工
              request.pipe(
                // 附加 Bearer 令牌
                HttpClientRequest.bearerToken(current.access),
                // 要求 JSON 响应
                HttpClientRequest.acceptJson,
                // 附加 User-Agent
                HttpClientRequest.setHeader("User-Agent", App.useragent(ctx.app)),
              ),
            ),
          ),
        )

      // 本机是否存在 az CLI
      const available = Boolean(which("az"))
      // 用户是否已配置资源名或自定义 baseURL
      const configuredResource = Boolean(resolveResourceName(configured) || typeof configured?.baseURL === "string")

      // 登记集成的认证方式
      yield* ctx.integration.transform((editor) => {
        // The retired azure-cognitive-services provider's env var still connects Azure.
        // 已退役的 azure-cognitive-services 提供商的环境变量仍然可用于连接 Azure。
        editor.method.update({
          // 集成 ID：Azure
          integrationID: Provider.ID.azure,
          // 环境变量方式：两个候选变量
          method: { type: "env", names: ["AZURE_API_KEY", "AZURE_COGNITIVE_SERVICES_API_KEY"] },
        })
        // 登记密钥方式
        editor.method.update({
          // 集成 ID
          integrationID: Provider.ID.azure,
          // 密钥方式：已配置资源时无需再询问资源名
          method: {
            // 类型：密钥
            type: "key",
            // 标签
            label: "API key",
            // 表单：未配置资源时询问资源名
            form: configuredResource
              // 已配置则无表单
              ? undefined
              // 未配置则询问
              : Form.Fields.make([
                  {
                    // 字符串字段
                    type: "string",
                    // 字段键
                    key: "resourceName",
                    // 标题
                    title: "Enter Azure Resource Name",
                    // 占位符
                    placeholder: "e.g. my-models",
                    // 必填
                    required: true,
                  },
                ]),
          },
        })
        // 本机没有 az CLI 时不登记外部方式
        if (!available) return
        // 登记外部方式：Azure CLI（Microsoft Entra ID）
        editor.method.update({
          // 集成 ID
          integrationID: Provider.ID.azure,
          // 外部方式定义
          method: {
            // 方式 ID
            id: methodID,
            // 类型：外部
            type: "external",
            // 标签
            label: "Microsoft Entra ID (Azure CLI)",
            // 表单：未配置资源时询问（带格式校验）
            form: configuredResource
              // 已配置则无表单
              ? undefined
              // 未配置则询问
              : Form.Fields.make([
                  {
                    // 字符串字段
                    type: "string",
                    // 字段键
                    key: "resourceName",
                    // 标题
                    title: "Azure resource",
                    // 占位符
                    placeholder: "e.g. my-models",
                    // 必填
                    required: true,
                    // 校验模式：资源名合法字符
                    pattern: resourcePattern.source,
                    // 描述说明
                    description: "Enter the name of your Azure OpenAI or AI Services resource.",
                  },
                ]),
          },
        })
      })

      // load：读取当前连接与凭据中的资源名
      const load = Effect.fn("AzurePlugin.load")(function* () {
        // 取当前活跃连接
        const connection = yield* ctx.integration.connection.active(Provider.ID.azure)
        // Startup awaits this, so it reads the stored credential: resolving the connection would refresh an
        // expired token through the Azure CLI.
        // 启动会等待本读取，因此只读存储的凭据：解析连接会经 Azure CLI 刷新过期令牌。
        const stored =
          // 连接为凭据型时读取凭据
          connection?.type === "credential" ? yield* credentials.get(Credential.ID.make(connection.id)) : undefined
        // 返回连接与资源名
        return { connection, resource: credentialResource(stored?.value) }
      })

      // Resource Graph searches every subscription the Azure CLI account can read, not only the selected one.
      // https://learn.microsoft.com/rest/api/azureresourcegraph/resourcegraph/resources/resources
      // Resource Graph 会在 CLI 账户可读的全部订阅中搜索，不限于当前订阅。
      const findResource = Effect.fn("AzurePlugin.findResource")(function* (resource: string) {
        // 发起 Resource Graph 查询
        const response = yield* HttpClientRequest.post(
          // 管理面 Resource Graph 端点
          `${endpoints.management}/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01`,
        ).pipe(
          // 请求体为 KQL 查询
          HttpClientRequest.schemaBodyJson(ResourceQuery)({ query: resourceQuery(resource) }),
          // 携带管理面令牌发送
          Effect.flatMap(management),
          // 解析响应
          Effect.flatMap(HttpClientResponse.schemaBodyJson(Resources)),
          // 10 秒超时
          Effect.timeout("10 seconds"),
        )
        // 取第一条结果的资源 ID
        const id = response.data[0]?.id
        // 未找到则失败
        if (!id) return yield* Effect.fail(new Error(`Azure resource "${resource}" was not found`))
        // 返回资源 ID
        return id
      })

      // managementDeployments：经管理面分页列出某资源的部署
      const managementDeployments = Effect.fn("AzurePlugin.managementDeployments")(function* (resource: string) {
        // 缓存键用小写资源名
        const key = resource.toLowerCase()
        // 优先用缓存的资源 ID，否则查询一次
        const id = resourceIDs.get(key) ?? (yield* findResource(resource))
        // 记录资源 ID 缓存
        resourceIDs.set(key, id)
        // 管理面端点的 origin，用于校验分页链接
        const origin = new URL(endpoints.management).origin
        // 以 paginate 驱动分页流
        return yield* Stream.paginate(`${endpoints.management}${id}/deployments?api-version=2024-10-01`, (url) =>
          // 请求当前页
          management(HttpClientRequest.get(url)).pipe(
            // 解析响应结构
            Effect.flatMap(HttpClientResponse.schemaBodyJson(ManagementDeployments)),
            // 10 秒超时
            Effect.timeout("10 seconds"),
            // 校验并转换当前页
            Effect.flatMap((response) =>
              // Every page carries the management token, so a page link must stay on the management endpoint.
              // https://learn.microsoft.com/rest/api/aiservices/accountmanagement/deployments/list
              // 每页都携带管理面令牌，因此下一页链接必须仍在管理面端点上。
              response.nextLink !== undefined && URL.parse(response.nextLink)?.origin !== origin
                // 跨端点的分页链接视为异常
                ? Effect.fail(new Error("Azure returned a deployment page outside the management endpoint"))
                // 正常：返回本页数据与下一页 Option
                : Effect.succeed([
                    // 将本页原始条目转成 Deployment 列表（仅保留预配成功的）
                    response.value.flatMap((raw): Deployment[] => {
                      // 解码单条（失败得 undefined）
                      const item = Option.getOrUndefined(decodeManagementDeployment(raw))
                      // 仅保留预配成功的部署
                      return item?.properties.provisioningState === "Succeeded"
                        // 成功：映射为 { name, model }
                        ? [{ name: item.name, model: item.properties.model.name }]
                        // 其余丢弃
                        : []
                    }),
                    // 下一页链接（可能不存在）
                    Option.fromNullishOr(response.nextLink),
                    // 元组形态
                  ] as const),
            ),
          ),
        ).pipe(
          // 收集全部分页结果
          Stream.runCollect,
          // A moved or recreated resource has a new ID, so the next discovery looks it up again.
          // 资源被移动或重建后 ID 会变；出错时清除缓存，下次重新查询。
          Effect.tapError(() => Effect.sync(() => resourceIDs.delete(key))),
        )
      })

      // resourceDeployments：经资源数据面列出部署（API key 或资源级令牌）
      const resourceDeployments = Effect.fn("AzurePlugin.resourceDeployments")(function* (
        // 资源部署端点 URL
        url: string,
        // 凭据：密钥或外部（CLI）
        credential: Credential.Key | Credential.External,
      ) {
        // 返回部署列表
        return yield* http
          // 发送请求
          .execute(
            // GET 请求并按凭据类型附加认证
            HttpClientRequest.get(url).pipe(
              // 要求 JSON
              HttpClientRequest.acceptJson,
              // 附加 User-Agent
              HttpClientRequest.setHeader("User-Agent", App.useragent(ctx.app)),
              // 密钥型：api-key 头；外部型：先取认知服务作用域令牌
              credential.type === "key"
                ? HttpClientRequest.setHeader("api-key", credential.key)
                : HttpClientRequest.bearerToken((yield* token(cognitiveScope)).access),
            ),
          )
          .pipe(
            // 解析响应
            Effect.flatMap(HttpClientResponse.schemaBodyJson(ResourceDeployments)),
            // 10 秒超时
            Effect.timeout("10 seconds"),
            // 仅保留成功的部署
            Effect.map((response) =>
              // 转换原始条目
              response.data.flatMap((raw): Deployment[] => {
                // 解码单条（失败得 undefined）
                const item = Option.getOrUndefined(decodeResourceDeployment(raw))
                // 状态成功才保留
                return item?.status === "succeeded" ? [{ name: item.id, model: item.model }] : []
              }),
            ),
          )
      })

      // Azure documents the management API as the deployment inventory, but only an Azure CLI session can reach it:
      // Azure Resource Manager accepts Entra ID tokens, never resource keys.
      // https://learn.microsoft.com/rest/api/aiservices/accountmanagement/deployments/list
      // The resource's own inventory serves API keys and identities without Azure Resource Manager read access. Only
      // data-plane version 2022-12-01 has it; later versions dropped `/deployments` and keep `/models`, which lists
      // models the resource can deploy rather than its deployments.
      // https://github.com/Azure/azure-rest-api-specs/blob/main/specification/cognitiveservices/data-plane/OpenAIAuthoring/stable/2022-12-01/azureopenai.json
      // deployments：按凭据类型选择清单来源；外部（CLI）优先管理面，失败回退数据面。
      const deployments = (url: string, resource: string, credential: Credential.Key | Credential.External) =>
        // 外部凭据走管理面
        credential.type === "external"
          ? managementDeployments(resource).pipe(
              // 管理面失败时回退到数据面（保留原错误）
              Effect.catch((error) => resourceDeployments(url, credential).pipe(Effect.mapError(() => error))),
            )
          // 密钥凭据只能走数据面
          : resourceDeployments(url, credential)

      // Local and quick, so a switch rebinds the provider before discovery for the new connection calls Azure.
      // rebind：本地且快速；切换连接时先重绑提供商，再对新连接发起 Azure 发现。
      const rebind = () =>
        // 信号量保护，避免并发绑定
        loading.withPermit(
          // 组织逻辑
          Effect.gen(function* () {
            // 读取当前连接与资源
            const current = yield* load()
            // 连接与资源都未变化则无需重绑
            if (
              IntegrationConnection.key(current.connection) === IntegrationConnection.key(loaded.connection) &&
              current.resource === loaded.resource
            )
              // 无变化直接返回
              return
            // 更新内存状态，并清空 URL 与部署缓存
            Object.assign(loaded, current, { url: undefined, deployments: undefined })
            // 触发提供商重载
            yield* ctx.provider.reload()
          }),
        )

      // discover：发现当前连接的部署清单（带缓存）
      const discover = Effect.fn("AzurePlugin.discover")(function* (options: ProviderRefresh.Options) {
        // 当前连接
        const connection = loaded.connection
        // 读取提供商当前设置
        const settings = (yield* providers.get(Provider.ID.azure))?.settings
        // 资源名：凭据优先，其次配置
        const name = loaded.resource ?? resolveResourceName(settings)
        // A custom endpoint may expose other deployments than the resource does, so it keeps the catalog.
        // 自定义端点暴露的部署可能与资源不同，因此保留完整目录。
        const url =
          // 需连接、资源名合法、且未配置自定义 baseURL 时才构造清单 URL
          connection && name !== undefined && resourcePattern.test(name) && typeof settings?.baseURL !== "string"
            // 数据面 2022-12-01 版本的部署端点
            ? `${endpoints.resource(name)}/deployments?api-version=2022-12-01`
            // 否则不发现
            : undefined
        // 连接已切换则放弃本轮发现
        if (loaded.connection !== connection) return
        // Keep the last inventory through transient failures only for the same connection and resource.
        // URL 变化时清空旧清单；仅在连接与资源不变时才在暂时性失败后保留旧清单。
        if (loaded.url !== url) {
          // 记录新 URL
          loaded.url = url
          // 存在旧清单则清空
          if (loaded.deployments) {
            // 清空清单
            loaded.deployments = undefined
            // 触发模型重载
            yield* ctx.model.reload()
          }
        }
        // 缺连接、资源名或 URL 时无法发现
        if (!connection || !name || !url) return
        // 解析连接为凭据（失败得 undefined）
        const credential = yield* ctx.integration.connection
          // 解析连接
          .resolve(connection)
          // 失败时以 undefined 继续
          .pipe(Effect.orElseSucceed(() => undefined))
        // 凭据不可用则无法发现
        if (!usable(credential)) return
        // 经共享缓存加载部署清单（带键与刷新选项）
        const found = yield* cache
          // 缓存读取
          .get({
            // 缓存键：连接+凭据+URL
            key: deploymentsKey(connection, credential, url),
            // 透传刷新选项
            ...options,
            // 实际加载逻辑
            load: ctx.integration.connection.resolve(connection).pipe(
              // 重新解析凭据（缓存加载时可能已过期）
              Effect.flatMap((current) =>
                // 凭据可用则拉取部署
                usable(current)
                  ? deployments(url, name, current)
                  // 不可用则失败
                  : Effect.fail(new Error("Azure connection has no usable credential")),
              ),
              // Azure promises no order; normalize it so a reordered response does not rebuild the model list.
              // Azure 不保证顺序；统一排序，避免响应顺序变化导致重建模型列表。
              Effect.map((list) => list.toSorted((a, b) => a.name.localeCompare(b.name))),
            ),
          })
          // 缓存/加载失败时以 undefined 继续
          .pipe(Effect.orElseSucceed(() => undefined))
        // 成功时返回连接与清单
        return found && { connection, found }
      })

      // apply：把发现结果发布出去（不可中断）
      const apply = (next: { connection: typeof loaded.connection; found: readonly Deployment[] } | undefined) =>
        // 有结果时在信号量保护下发布
        next ? loading.withPermit(publish(next.connection, next.found)).pipe(Effect.uninterruptible) : Effect.void

      // publish：校验后把部署清单写入内存并触发模型重载
      const publish = Effect.fn("AzurePlugin.publish")(function* (
        // 目标连接
        connection: typeof loaded.connection,
        // 部署清单
        found: readonly Deployment[],
      ) {
        // 连接已变化或不再是当前活跃连接则放弃
        if (
          loaded.connection !== connection ||
          IntegrationConnection.key(connection) !==
            IntegrationConnection.key(yield* ctx.integration.connection.active(Provider.ID.azure))
        )
          // 放弃发布
          return
        // 清单未变化则跳过
        if (Equal.equals(found, loaded.deployments)) return
        // 构建目录模型的小写映射（小写 id -> 原始 id）
        const catalog = new Map(
          Array.from((yield* providers.snapshot()).records.get(Provider.ID.azure)?.models.keys() ?? [], (id) => [
            // 小写键
            id.toLowerCase(),
            // 原始 ID
            id,
          ]),
        )
        // 找出目录中不存在对应模型的部署
        const unmatched = found.filter((deployment) => !catalogModel(catalog, deployment))
        // 存在未匹配部署时记录警告
        if (unmatched.length > 0)
          // 记录警告日志
          yield* Effect.logWarning("Azure deployments of models outside the catalog need explicit configuration", {
            // 列出未匹配部署名
            deployments: unmatched.map((deployment) => deployment.name),
          })
        // 更新内存清单
        loaded.deployments = found
        // 触发模型重载
        yield* ctx.model.reload()
      })

      // refresh：执行一次发现并发布结果
      const refresh = discover({}).pipe(Effect.flatMap(apply))

      // The connection's resource wins over configured settings for Azure itself.
      // resourceFor：计算某提供商应使用的资源名；Azure 本身以连接凭据优先。
      const resourceFor = (provider: Provider.Info) =>
        // Azure 自身：凭据资源优先
        provider.id === Provider.ID.azure
          ? (loaded.resource ?? resolveResourceName(provider.settings))
          // 其他 Azure 兼容包：设置优先，凭据资源作回退
          : resolveResourceName(provider.settings, loaded.resource)

      // 启动时同步加载一次连接与资源
      Object.assign(loaded, yield* load())

      // 调整 Azure 提供商的设置
      yield* ctx.provider.transform((evt) => {
        // 遍历所有提供商
        for (const item of evt.list()) {
          // 非 Azure 系提供商跳过
          if (!azureProvider(item.provider)) continue
          // 计算资源名
          const resourceName = resourceFor(item.provider)
          // 判断是否支持 responses WebSocket 传输
          const websocket = responsesWebSocketCapable(item.provider)
          // 两者都不满足则不改
          if (!resourceName && !websocket) continue
          // 更新提供商设置
          evt.update(item.provider.id, (provider) => {
            // 合并设置
            provider.settings = {
              // 展开现有设置
              ...provider.settings,
              // 有资源名则写入
              ...(resourceName === undefined ? {} : { resourceName }),
              // 支持 WebSocket 且未显式配置传输时启用
              ...(websocket ? { transport: provider.settings?.transport ?? "websocket" } : {}),
              // 有资源名且 baseURL 为字符串时展开占位符
              ...(resourceName !== undefined && typeof provider.settings?.baseURL === "string"
                ? { baseURL: expandResourceName(provider.settings.baseURL, resourceName) }
                : {}),
            }
          })
        }
        // 取 Azure 提供商
        const item = evt.get(Provider.ID.azure)
        // 不存在则结束
        if (!item) return
        // Bind resource settings and discovery to their account, so a switch hides them until the rebind.
        // Keep the full templates here for explicit configuration; the model transform narrows the visible list.
        // 把资源设置与发现绑定到当前账户：切换后先隐藏，重绑后再出现；这里保留完整目录模板供显式配置。
        evt.add({
          // 提供商信息
          info: item.provider,
          // 全部目录模型
          models: Array.from(item.models.values()),
          // 绑定到当前连接
          sourceConnection: loaded.connection,
        })
      })
      // 调整 Azure 系模型设置
      yield* ctx.model.transform((models) => {
        // 遍历每个提供商的模型组
        for (const item of models.provider.list()) {
          // 非 Azure 系跳过
          if (!azureProvider(item.provider)) continue
          // 计算资源名
          const resourceName = resourceFor(item.provider)
          // 无资源名则不改
          if (!resourceName) continue
          // 遍历该提供商的模型
          for (const model of item.models.values()) {
            // baseURL 不是字符串则跳过
            if (typeof model.settings?.baseURL !== "string") continue
            // 展开占位符（模型自身设置的资源名优先）
            const baseURL = expandResourceName(
              // 原始 baseURL
              model.settings.baseURL,
              // 资源名：模型设置优先，回退提供商资源名
              resolveResourceName(model.settings, resourceName) ?? resourceName,
            )
            // 未变化则跳过
            if (baseURL === model.settings.baseURL) continue
            // 写回模型设置
            models.update(item.provider.id, model.id, (draft) => {
              // baseURL 仍为字符串时更新
              if (typeof draft.settings?.baseURL === "string") draft.settings.baseURL = baseURL
            })
          }
        }
        // 无部署清单时结束（保留完整目录）
        if (!loaded.deployments) return
        // Narrowing here rather than in the provider catalog keeps every catalog model available as the base
        // of a model the user configures explicitly; those are applied after this transform.
        // 在模型层裁剪而非目录层，保证用户显式配置的模型仍能以目录模型为基底；显式配置在本 transform 之后生效。
        const catalog = models.list(Provider.ID.azure)
        // 计算已部署模型映射
        const deployed = deployedModels(loaded.deployments, catalog)
        // 移除未部署的目录模型
        for (const model of catalog) {
          // 不在已部署集合中则移除
          if (!deployed.has(model.id)) models.remove(Provider.ID.azure, model.id)
        }
        // 应用部署模型的信息
        for (const [id, model] of deployed) {
          // 用部署信息覆盖模型
          models.update(Provider.ID.azure, id, (draft) => Object.assign(draft, model))
        }
      })

      // A switch interrupts discovery for the previous connection instead of waiting for its Azure calls.
      // 切换连接时打断旧连接的发现流程，而非等待其 Azure 调用完成。
      yield* ProviderRefresh.onSwitch(
        // 插件名
        "azure",
        // 切换时：先重绑，再以新连接启动发现
        rebind().pipe(Effect.andThen(FiberHandle.run(discovery, ProviderRefresh.switched(discover, apply)))),
      )
      // Deployments load in the background so startup never waits on Azure; the catalog serves until they arrive.
      // 部署在后台加载，启动不等待 Azure；清单到达前以目录目录顶替。
      yield* rebind().pipe(Effect.andThen(FiberHandle.run(discovery, refresh)), Effect.forkScoped)
      // 周期性刷新：每次共享缓存间隔后重新发现
      yield* Effect.sleep(SharedCache.interval).pipe(
        // 唤醒后执行刷新（仅在无进行中的刷新时）
        Effect.andThen(FiberHandle.run(discovery, refresh, { onlyIfMissing: true })),
        // 永续循环
        Effect.forever,
        // 后台运行
        Effect.forkScoped,
      )

      // Entra bearer tokens are minted per request from the target URL's scope, so they are injected
      // at the transport hooks rather than stored as a credential.
      // Entra Bearer 令牌按请求依据目标 URL 作用域现取，因此在传输钩子注入，而非作为凭据存储。
      const bearer = Effect.fn("AzurePlugin.bearer")(function* (url: string) {
        // 读取当前活跃凭据
        const { credential } = yield* activeCredential(ctx, Provider.ID.azure)
        // 仅 Azure CLI 外部凭据才注入 Bearer
        if (credential?.type !== "external" || credential.methodID !== methodID) return
        // 解析目标 URL
        const target = new URL(url)
        // 依据主机名与路径选择作用域：Foundry 端点或认知服务
        const scope =
          // Foundry 主机且非 /models 路径
          target.hostname.endsWith(".services.ai.azure.com") && !target.pathname.startsWith("/models")
            // 使用 Foundry 作用域
            ? foundryScope
            // 其余使用认知服务作用域
            : cognitiveScope
        // 获取令牌（失败转为缺陷）
        const current = yield* token(scope).pipe(Effect.orDie)
        // 返回 Authorization 头值
        return `Bearer ${current.access}`
      })
      // 注册 HTTP 请求钩子：为 Azure 请求注入认证头
      yield* ctx.session.hook(
        // 钩子名：http.request
        "http.request",
        // 钩子实现
        (evt) =>
          // 组织逻辑
          Effect.gen(function* () {
            // 计算 Bearer 值（可能为空）
            const authorization = yield* bearer(evt.request.url)
            // 空则不改写
            if (!authorization) return
            // 移除静态密钥头
            evt.request.headers.delete("api-key")
            // 移除另一形态的密钥头
            evt.request.headers.delete("x-api-key")
            // 写入 Bearer 头
            evt.request.headers.set("authorization", authorization)
            // 附加 User-Agent
            evt.request.headers.set("user-agent", App.useragent(ctx.app))
          }),
        // 仅对 Azure 提供商生效
        { providerID: Provider.ID.azure },
      )
      // 注册 WebSocket 握手钩子：同样注入认证头
      yield* ctx.session.hook(
        // 钩子名：ws 握手
        "experimental.ws.handshake",
        // 钩子实现
        (evt) =>
          // 组织逻辑
          Effect.gen(function* () {
            // 计算 Bearer 值
            const authorization = yield* bearer(evt.url)
            // 空则不改写
            if (!authorization) return
            // 移除静态密钥头
            delete evt.headers["api-key"]
            // 移除另一形态的密钥头
            delete evt.headers["x-api-key"]
            // 写入 Bearer 头
            evt.headers.authorization = authorization
            // 附加 User-Agent
            evt.headers["user-agent"] = App.useragent(ctx.app)
          }),
        // 仅对 Azure 提供商生效
        { providerID: Provider.ID.azure },
      )
    }),
    // 满足内部插件类型
  } satisfies PluginInternal.InternalPlugin)
}

// 导出默认构造的 Azure 插件实例
export const AzurePlugin = make()

// deploymentsKey：构造部署清单的缓存键
function deploymentsKey(
  // 连接
  connection: Parameters<typeof IntegrationConnection.key>[0],
  // 凭据
  credential: Credential.Key | Credential.External,
  // 清单 URL
  url: string,
) {
  // 密钥型凭据附带其指纹（不泄露明文）
  const access = credential.type === "key" ? `:${SharedCache.fingerprint(credential.key)}` : ""
  // 组合连接键、凭据指纹与 URL
  return `azure:${IntegrationConnection.key(connection)}${access}:${url}`
}

// resolveResourceName：从设置/环境变量解析资源名（支持回退值）
function resolveResourceName(settings: Readonly<Record<string, unknown>> | undefined, fallback?: string) {
  // 读取设置中的 resourceName
  const configured = settings?.resourceName
  // 为非空字符串时直接使用
  if (typeof configured === "string" && configured.trim() !== "") return configured
  // 依次回退：调用方回退值、两个环境变量
  return fallback ?? process.env.AZURE_RESOURCE_NAME ?? process.env.AZURE_COGNITIVE_SERVICES_RESOURCE_NAME
}

// expandResourceName：把 baseURL 中的资源名占位符替换为实际值
function expandResourceName(baseURL: string, resourceName: string) {
  // 替换两种占位符
  return baseURL
    // 替换 AZURE_RESOURCE_NAME 占位符
    .replaceAll("${AZURE_RESOURCE_NAME}", resourceName)
    // 替换旧变量占位符
    .replaceAll("${AZURE_COGNITIVE_SERVICES_RESOURCE_NAME}", resourceName)
}

// azureProvider：判断提供商是否为 Azure 系（官方 ID 或 Azure 包前缀）
function azureProvider(provider: { readonly id: string; readonly package: string }) {
  // 官方 Azure ID 或包名前缀匹配
  return provider.id === Provider.ID.azure || provider.package.startsWith("@opencode/ai/providers/azure/")
}

// API keys and Azure CLI sessions can list deployments; other sign-ins cannot.
// usable：判定凭据能否用于列部署：API key 或 Azure CLI 外部凭据。
function usable(credential: Credential.Value | undefined): credential is Credential.Key | Credential.External {
  // 密钥型，或外部型且方式为 azure-cli
  return credential?.type === "key" || (credential?.type === "external" && credential.methodID === methodID)
}

// Both the API key and Azure CLI methods store their resource form answer as credential metadata.
// credentialResource：从凭据元数据提取资源名。
function credentialResource(credential: Credential.Value | undefined) {
  // 仅密钥型或 azure-cli 外部型的元数据含 resourceName
  const resource =
    credential?.type === "key" || (credential?.type === "external" && credential.methodID === methodID)
      // 读取元数据字段
      ? credential.metadata?.resourceName
      // 其余无资源名
      : undefined
  // 非空字符串才有效
  return typeof resource === "string" && resource.trim() !== "" ? resource : undefined
}

// resourceQuery：构造 Resource Graph 的 KQL 查询
function resourceQuery(resource: string) {
  // 拼接查询语句
  return [
    // 表名
    "resources",
    // 过滤认知服务账户且类型为 AIServices/OpenAI
    "| where type =~ 'microsoft.cognitiveservices/accounts' and kind in~ ('AIServices', 'OpenAI')",
    // The custom subdomain is the resource name of every endpoint, and Entra ID authentication requires one.
    // Subdomains are globally unique, so a name matches at most one resource.
    // https://learn.microsoft.com/azure/ai-services/cognitive-services-custom-subdomains
    // 自定义子域名即资源名；全局唯一，名称至多匹配一个资源。
    "| extend resourceName = tostring(properties.customSubDomainName)",
    // 按资源名匹配（不区分大小写）
    `| where resourceName =~ '${resource}'`,
    // 只输出 id
    "| project id",
    // 只取一条
    "| take 1",
  ].join(" ")
}

// A deployment's ID is its name, while limits, costs, and routes come from the catalog model it deploys. Azure compares
// names without case and may return another case, so IDs are lowercase like the catalog's.
// https://learn.microsoft.com/azure/azure-resource-manager/management/resource-name-rules
// deployedModels：把部署清单映射为可用的模型信息（ID 小写化）。
function deployedModels(deployments: readonly Deployment[], catalog: readonly Model.MutableInfo[]) {
  // 目录模型的小写索引
  const models = new Map(catalog.map((model) => [model.id.toLowerCase(), model]))
  // 构建部署 -> 模型映射
  return new Map(
    deployments.flatMap((deployment) => {
      // 找到部署对应的目录模型
      const model = catalogModel(models, deployment)
      // 无对应模型则跳过
      if (!model) return []
      // 模型 ID 用小写部署名
      const id = Model.ID.make(deployment.name.toLowerCase())
      // 构造模型信息（深拷贝目录模型）
      const info: Model.MutableInfo = {
        // 深拷贝避免污染目录
        ...structuredClone(model),
        // 覆盖 ID
        id,
        // modelID 保留原始大小写
        modelID: Model.ID.make(deployment.name),
        // ID 与目录一致时沿用原名，否则附加部署名区分
        name: id === model.id.toLowerCase() ? model.name : `${model.name} (${deployment.name})`,
      }
      // 返回键值对
      return [[id, info] as const]
    }),
  )
}

// Azure spells some models unlike the catalog: a model name plus a separate version, such as `gpt-4` for GPT-4 Turbo,
// `gpt-35-turbo`, or mixed case such as `DeepSeek-V4-Flash`. A deployment named after a catalog model then stands for
// that model, as it did before discovery; any other is left to explicit configuration.
// https://learn.microsoft.com/azure/foundry/openai/concepts/retired-models
// catalogModel：部署名/模型名按小写匹配目录模型；不匹配则交由显式配置。
function catalogModel<T>(models: ReadonlyMap<string, T>, deployment: Deployment) {
  // 先按 model 名再按部署名匹配
  return models.get(deployment.model.toLowerCase()) ?? models.get(deployment.name.toLowerCase())
}

// responsesWebSocketCapable：判断提供商是否可用 responses WebSocket 传输
function responsesWebSocketCapable(provider: Provider.Info) {
  // 仅限 responses 包
  if (provider.package !== "@opencode/ai/providers/azure/responses") return false
  // 读取设置
  const settings = provider.settings
  // 显式关闭基于部署的 URL 时禁用
  if (settings?.useDeploymentBasedUrls === true) return false
  // API 版本非 v1 时禁用
  if (settings?.apiVersion !== undefined && settings.apiVersion !== "v1") return false
  // 无自定义 baseURL 时可用
  if (typeof settings?.baseURL !== "string") return true
  // baseURL 指向 openai.azure.com 域时可用
  return /^https:\/\/[^/]+\.openai\.azure\.com(?:\/|$)/i.test(settings.baseURL)
}
