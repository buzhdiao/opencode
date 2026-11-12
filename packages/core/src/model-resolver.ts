// 将本模块以命名空间 ModelResolver 的形式整体再导出
export * as ModelResolver from "./model-resolver.js"

// 引入 makeLocationNode：构造挂到位置标签下的服务节点
import { makeLocationNode } from "@opencode/util/effect/app-node"
// 从 AI 层引入：决策模型、决策模型兼容性、其模式、图像模型、其模式、语言模型、提供商配置错误与包类型
import {
  DecisionModel,
  DecisionModelCompatibility,
  DecisionModelSchema,
  ImageModel,
  ImageModelSchema,
  LanguageModel,
  ProviderConfigurationError,
  type ProviderPackage,
} from "@opencode/ai/effect"
// 引入认证方式与传输层合并工具
import { Auth, mergeTransport } from "@opencode/ai/route"
// 引入 effect 的 Context、Effect、Layer、Schema(模式) 与 Struct(结构工具)
import { Context, Effect, Layer, Schema, Struct } from "effect"
// 引入 AI SDK 服务（加载语言模型运行时）
import { AISDK } from "./aisdk.js"
// 引入凭据（Credential）服务与类型
import { Credential } from "./credential.js"
// 引入集成（Integration）服务
import { Integration } from "./integration.js"
// 引入模型目录相关类型：能力、兼容性、ID、信息、模型、引用、变体 ID
import { Capabilities, Compatibility, ID, Info, Model, Ref, VariantID } from "./model.js"
// 仅引入类型：运行时信息（RuntimeInfo）
import type { RuntimeInfo } from "./model.js"
// 引入 Npm 服务（包安装/加载）
import { Npm } from "@opencode/util/npm"
// 引入提供商（Provider）服务与工具
import { Provider } from "./provider.js"

// 变体不可用错误：所请求的模型变体不存在
export class VariantUnavailableError extends Schema.TaggedError<VariantUnavailableError>()(
  "SessionRunnerModel.VariantUnavailableError",
  {
    // 提供商 ID
    providerID: Provider.ID,
    // 模型 ID
    modelID: ID,
    // 变体 ID
    variant: VariantID,
  },
) {
  // 错误消息：拼接提供商/模型与变体名
  override get message() {
    return `Variant unavailable for ${this.providerID}/${this.modelID}: ${this.variant}`
  }
}

// 不受支持的包错误：模型所需的提供商包不受支持
export class UnsupportedPackageError extends Schema.TaggedError<UnsupportedPackageError>()(
  "SessionRunnerModel.UnsupportedPackageError",
  {
    // 提供商 ID
    providerID: Provider.ID,
    // 模型 ID
    modelID: ID,
    // 包名
    package: Schema.String,
  },
) {
  // 错误消息：说明该提供商/模型不支持该包
  override get message() {
    return `Unsupported package for ${this.providerID}/${this.modelID}: ${this.package}`
  }
}

// 初始化阶段字面量：加载（load）、初始化（init）、构造（construct）
export const InitializationPhase = Schema.Literals(["load", "init", "construct"])
// 导出初始化阶段的静态类型
export type InitializationPhase = typeof InitializationPhase.Type

/** Provider settings are missing, conflicting, or unsupported; the provider's own message tells the user what to fix. */
// 模型配置错误：提供商设置缺失、冲突或不受支持；错误详情来自提供商自身的消息
export class ModelConfigurationError extends Schema.TaggedError<ModelConfigurationError>()(
  "SessionRunnerModel.ModelConfigurationError",
  {
    // 提供商 ID
    providerID: Provider.ID,
    // 模型 ID
    modelID: ID,
    // 包名
    package: Schema.String,
    // 错误详情
    detail: Schema.String,
  },
) {
  // 错误消息：无法初始化该提供商/模型及详情
  override get message() {
    return `Cannot initialize ${this.providerID}/${this.modelID}: ${this.detail}`
  }
}

/** A supported package failed unexpectedly while loading or constructing the model. */
// 模型初始化错误：受支持的包在加载或构造模型时意外失败
export class ModelInitializationError extends Schema.TaggedError<ModelInitializationError>()(
  "SessionRunnerModel.ModelInitializationError",
  {
    // 提供商 ID
    providerID: Provider.ID,
    // 模型 ID
    modelID: ID,
    // 包名
    package: Schema.String,
    // 失败发生的初始化阶段
    phase: InitializationPhase,
    // 错误详情
    detail: Schema.String,
  },
) {
  // 错误消息：无法初始化该提供商/模型及详情
  override get message() {
    return `Cannot initialize ${this.providerID}/${this.modelID}: ${this.detail}`
  }
}

// 提供商变量未解析错误：baseURL 中的 ${VAR} 变量无法从环境或设置中解析
export class UnresolvedProviderVariablesError extends Schema.TaggedError<UnresolvedProviderVariablesError>()(
  "SessionRunnerModel.UnresolvedProviderVariablesError",
  {
    // 提供商 ID
    providerID: Provider.ID,
    // 模型 ID
    modelID: ID,
    // 未解析的变量名列表
    variables: Schema.Array(Schema.String),
  },
) {
  // 错误消息：列出需要哪些变量才能解析提供商端点（单复数动词自动匹配）
  override get message() {
    return `Cannot initialize ${this.providerID}/${this.modelID}: ${this.variables.join(", ")} ${this.variables.length === 1 ? "is" : "are"} required to resolve the provider endpoint`
  }
}

// 不支持压缩错误：该提供商/模型不支持其配置所要求的原生压缩（compaction）
export class UnsupportedCompactionError extends Schema.TaggedError<UnsupportedCompactionError>()(
  "SessionRunnerModel.UnsupportedCompactionError",
  {
    // 提供商 ID
    providerID: Provider.ID,
    // 模型 ID
    modelID: ID,
    // 路由标识
    route: Schema.String,
  },
) {
  // 错误消息：说明提供商压缩不受该模型支持
  override get message() {
    return `Provider compaction is not supported by ${this.providerID}/${this.modelID} (${this.route})`
  }
}

// 联合类型：本模块所有可能的错误
export type Error =
  | VariantUnavailableError
  | UnsupportedPackageError
  | ModelConfigurationError
  | ModelInitializationError
  | UnresolvedProviderVariablesError
  | UnsupportedCompactionError
  | Integration.AuthorizationError

// 已解析模型的接口：包含运行时模型与其目录（catalog）元数据
export interface Resolved {
  /** Route-level model for provider requests; its id is the provider API model id, which may differ from the catalog id. */
  // model：路由级语言模型，其 id 为提供商 API 模型 id（可能与目录 id 不同）
  readonly model: LanguageModel
  /** Selected catalog identity. Durable records and displays must use this, never the API model id. */
  // ref：选定的目录标识；持久化记录与展示必须用它，绝不能用 API 模型 id
  readonly ref: Ref
  /** Catalog capabilities used to shape requests before provider lowering. */
  // capabilities：目录能力，用于在降级到提供商之前塑造请求
  readonly capabilities: Capabilities
  /** Catalog pricing in dollars per million tokens. */
  // cost：目录定价（每百万 token 的美元数）
  readonly cost: Info["cost"]
  /** Catalog token limits used by Core for context management. */
  // limit：目录 token 上限，供 Core 做上下文管理
  readonly limit: Info["limit"]
  /** Model policy overrides the provider policy; omitted means summary compaction. */
  // compaction：模型级压缩策略（覆盖提供商策略）；未设置表示摘要式压缩
  readonly compaction?: Provider.Compaction
  /** Prompt-cache settings from the provider, model and variant; omitted keeps the provider defaults. */
  // cache：来自提供商、模型与变体的提示缓存（prompt cache）设置；未设置则保持提供商默认
  readonly cache?: Provider.Cache
  /** Provider transport policy; omitted means HTTP. */
  // transport：提供商传输策略；未设置表示 HTTP
  readonly transport?: Provider.Transport
  /** Milliseconds without streamed data before a WebSocket exchange fails; `false` disables the limit. */
  // chunkTimeout：WebSocket 交换在无流式数据多少毫秒后失败；false 表示不限制
  readonly chunkTimeout?: number | false
}

// 媒体模型（图像/决策）解析时的错误联合类型
export type MediaError =
  | VariantUnavailableError
  | UnsupportedPackageError
  | ModelConfigurationError
  | ModelInitializationError
  | UnresolvedProviderVariablesError
  | Integration.AuthorizationError

// 解析器服务接口：解析默认/指定模型、图像模型与决策模型
export interface Interface {
  readonly resolve: (requested?: Ref) => Effect.Effect<Resolved | undefined, Error>
  /** The model used when nothing is selected: the configured default, or the first available text model. */
  readonly fallback: () => Effect.Effect<Info | undefined>
  readonly resolveModel: (model: Info, variant?: VariantID) => Effect.Effect<Resolved, Error>
  /** An enabled image model by ref, or undefined when no image model has that ref. */
  // resolveImage：按引用取已启用的图像模型；不存在则返回 undefined
  readonly resolveImage: (ref: Ref) => Effect.Effect<ImageModel | undefined, MediaError>
  /** An enabled decision model by ref, or undefined when no decision model has that ref. */
  // resolveDecision：按引用取已启用的决策模型；不存在则返回 undefined
  readonly resolveDecision: (ref: Ref) => Effect.Effect<DecisionModel | undefined, MediaError>
}

// 定义 ModelResolver 服务类：标识为 "@opencode/ModelResolver" 的上下文服务
export class Service extends Context.Service<Service, Interface>()("@opencode/ModelResolver") {}

// Variant resolution adds request-local overlays without changing the committed model snapshot.
// withVariant：在已提交的模型快照之上叠加请求级的变体覆盖，不改动快照本身
export const withVariant = (
  model: Info,
  variantID: VariantID | undefined,
): Effect.Effect<Info, VariantUnavailableError> => {
  // “default” 视为无变体（用模型默认配置）
  const id = variantID === "default" ? undefined : variantID
  // 在模型的变体列表中查找指定 id 的变体
  const variant = model.variants?.find((item) => item.id === id)
  // 指定了变体但找不到：返回变体不可用错误
  if (!variant && id !== undefined)
    return Effect.fail(
      new VariantUnavailableError({
        providerID: model.providerID,
        modelID: model.id,
        variant: id,
      }),
    )
  // 有变体则把其设置/请求头/请求体合并进模型；没有则原样返回
  return Effect.succeed(
    variant
      ? {
          ...model,
          // Config accepts unknown variant keys, so drop `cache` here too; a variant can't change the prompt cache.
          // settings：合并变体设置（剔除 cache 键——配置允许未知键，且变体不能改动提示缓存）
          settings: Provider.mergeOverlay(
            model.settings,
            Provider.modelSettings(variant.settings && Struct.omit(variant.settings, ["cache"])),
          ),
          // headers：合并变体的请求头
          headers: Provider.mergeHeaders(model.headers, variant.headers),
          // body：合并变体的请求体覆盖
          body: Provider.mergeOverlay(model.body, variant.body),
        }
      : model,
  )
}

// 可注入的依赖接口：便于测试时替换包加载与 AI SDK 初始化
export interface Dependencies {
  readonly loadPackage?: (specifier: string) => Effect.Effect<ProviderPackage.Definition, Provider.LoadError>
  readonly loadAISDK?: (model: RuntimeInfo) => Effect.Effect<LanguageModel, AISDK.InitError>
}

// fromCatalogModel：从目录模型信息构建可用的语言模型（校验变量与压缩支持）
export const fromCatalogModel = (
  model: RuntimeInfo,
  credential?: Credential.Value,
  dependencies?: Dependencies,
): Effect.Effect<
  LanguageModel,
  | UnsupportedPackageError
  | ModelConfigurationError
  | ModelInitializationError
  | UnresolvedProviderVariablesError
  | UnsupportedCompactionError
> =>
  resolveCatalogModel(model, credential, dependencies).pipe(
    // 先校验提供商端点变量是否都能解析
    Effect.flatMap((resolved) => validateProviderVariables(model, resolved)),
    Effect.flatMap((resolved) => {
      // Reject provider compaction policies up front so the misconfiguration surfaces before any step runs.
      // 提前拒绝不支持的提供商压缩策略，让配置错误在任何步骤运行前就暴露
      if (
        model.settings?.compaction?.type !== "native" ||
        resolved.route.compact?.trigger ||
        resolved.route.compact?.endpoint
      )
        // 非原生压缩或路由未启用压缩端点：配置合法，直接通过
        return Effect.succeed(resolved)
      // 配置了原生压缩但模型不支持：返回不支持压缩错误
      return Effect.fail(
        new UnsupportedCompactionError({ providerID: model.providerID, modelID: model.id, route: resolved.route.id }),
      )
    }),
  )

// resolveCatalogModel：按包类型分派——AI SDK 包走 loadAISDK，其余走目录包加载
const resolveCatalogModel = Effect.fn("ModelResolver.resolveCatalogModel")(function* (
  model: RuntimeInfo,
  credential?: Credential.Value,
  dependencies?: Dependencies,
) {
  // AI SDK 内置包的特殊路径
  if (Provider.isAISDK(model.package)) {
    // 先准备运行时模型信息（清理空 apiKey 等）
    const resolved = prepareRuntimeModel(model)
    // 取注入的 loadAISDK 依赖；没有则视为不受支持的包
    const loadAISDK = dependencies?.loadAISDK
    if (!loadAISDK) return yield* unsupported(resolved)
    // 合并模型设置与凭据的原生设置，并预处理端点变量
    const settings = yield* prepareProviderSettings(
      resolved,
      Provider.mergeOverlay(
        resolved.settings,
        nativeCredentialSettings(resolved, resolved.package ?? "", credential),
      ) ?? {},
    )
    // 加载 AI SDK 语言模型；失败时映射为 init 阶段的初始化错误
    return yield* loadAISDK({ ...resolved, settings }).pipe(
      Effect.mapError((error) => initialization(resolved, "init", error.cause)),
    )
  }
  // 通用路径：加载目录包及其设置
  const { resolved, configured, module, settings } = yield* loadCatalogPackage(model, credential, dependencies)
  // 用 try/catch 语义构造模型运行时；抛错映射为构造错误
  return yield* Effect.try({
    try: () => {
      // 调用包的 model 工厂：传入模型 ID（可能指定 modelID 覆盖）与设置
      const runtime = module.model(resolved.modelID ?? resolved.id, settings)
      // 读取提供商配置中的超时策略
      const timeouts = Provider.timeouts(configured)
      // 更新语言模型的元数据：规范提供商名、能力与兼容性覆盖
      return LanguageModel.update(runtime, {
        provider: resolved.canonical ?? resolved.providerID,
        capabilities: resolved.compatibility
          ? capabilities(runtime.capabilities, resolved.compatibility)
          : runtime.capabilities,
        compatibility: resolved.compatibility
          ? Object.assign({}, runtime.compatibility, Struct.omit(resolved.compatibility, CAPABILITY_KEYS))
          : runtime.compatibility,
        // Timeouts and body encoding are transport policy, so they land on the model's options instead of package settings.
        options: {
          ...runtime.options,
          ...mergeTransport(runtime.options, {
            timeout: { total: timeouts.timeout, headers: timeouts.headerTimeout, chunk: timeouts.chunkTimeout },
            http: { encoding: Provider.encoding(configured) },
          }),
        },
      })
    },
    catch: (cause) => constructionError(resolved, cause),
  })
})

// Config `compatibility` keys the AI package reads as model capabilities.
// CAPABILITY_KEYS：配置 compatibility 中会被 AI 包当作模型能力读取的键
const CAPABILITY_KEYS = ["supportsPromptCacheKey", "streamUsage", "supportsEffortUpdates"] as const

// capabilities：把兼容性覆盖合并进基础能力（提示缓存键、流式用量、推理更新开关）
const capabilities = (base: LanguageModel["capabilities"], compatibility: Compatibility) => ({
  ...base,
  // 覆盖 promptCacheKey 支持开关
  ...("supportsPromptCacheKey" in compatibility ? { promptCacheKey: compatibility.supportsPromptCacheKey } : {}),
  // 覆盖 streamUsage（流式用量统计）开关
  ...("streamUsage" in compatibility ? { streamUsage: compatibility.streamUsage } : {}),
  // 覆盖推理（reasoning）更新开关，保留原有推理能力字段
  ...("supportsEffortUpdates" in compatibility
    ? { reasoning: { ...base?.reasoning, updates: compatibility.supportsEffortUpdates } }
    : {}),
})

/** Settings and package loading shared by every model type: credentials, variables, canonical provider, overlays. */
// loadCatalogPackage：所有模型类型共享的加载逻辑——解析设置、加载包、组装最终设置
const loadCatalogPackage = Effect.fn("ModelResolver.loadCatalogPackage")(function* (
  model: RuntimeInfo,
  credential?: Credential.Value,
  dependencies?: Dependencies,
) {
  // 准备运行时模型信息
  const resolved = prepareRuntimeModel(model)
  // 用户配置的原始设置（可能为空对象）
  const configured = resolved.settings ?? {}
  // 解析包名标识符（specifier）
  const specifier = Provider.packageName(resolved.package)
  // 无包名或又是 AI SDK 包：不受支持（AI SDK 包应在上面分支处理）
  if (!specifier || Provider.isAISDK(specifier)) return yield* unsupported(resolved)
  // 用提供商原生设置预处理端点变量
  const mapped = yield* prepareProviderSettings(resolved, Provider.nativeSettings(configured))
  // 加载提供商包模块；失败映射为 load 阶段错误
  const module = yield* (dependencies?.loadPackage ?? Provider.loadPackage)(specifier).pipe(
    Effect.mapError((error) => initialization(resolved, "load", error.cause)),
  )
  // 组装最终传给包的设置
  const settings = {
    // 有凭据时剔除可能来自配置的敏感键，避免被存储凭据之外的值污染
    ...(credential ? Struct.omit(mapped, ["accessToken", "apiKey", "authToken"]) : mapped),
    // 有规范提供商名时注入 provider 字段
    ...(resolved.canonical === undefined ? {} : { provider: resolved.canonical }),
    // 注入凭据对应的原生设置（apiKey/authToken/accessToken 等）
    ...nativeCredentialSettings(resolved, specifier, credential),
    // 附加模型的请求头与请求体覆盖
    headers: resolved.headers,
    body: resolved.body,
  }
  // 返回解析结果、原始配置、模块与最终设置
  return { resolved, configured, module, settings }
})

/**
 * Builds an image or decision model from its catalog package. The entrypoint (`providers/<P>/images`) exports the
 * same `model(modelID, settings)` as chat; a package that returns another kind of model cannot serve this type.
 */
// fromCatalogMedia：从目录包构建图像或决策模型；包的 model 工厂必须返回对应类型的模型
const fromCatalogMedia = Effect.fn("ModelResolver.fromCatalogMedia")(function* <Runtime>(
  model: RuntimeInfo,
  is: (value: unknown) => value is Runtime,
  credential?: Credential.Value,
  dependencies?: Dependencies,
) {
  // 复用共享的包加载逻辑
  const { resolved, module, settings } = yield* loadCatalogPackage(model, credential, dependencies)
  // 调用包的 model 工厂；抛错映射为构造错误
  const runtime: unknown = yield* Effect.try({
    try: () => module.model(resolved.modelID ?? resolved.id, settings),
    catch: (cause) => constructionError(resolved, cause),
  })
  // Catalog and config compatibility tell a decision route how its host takes media, as chat does above.
  // 读取兼容性中的 mediaInput：告诉决策模型其宿主如何接收媒体输入
  const mediaInput = resolved.compatibility?.mediaInput
  // 决策模型且指定了 mediaInput：重建一个带该兼容性设置的 DecisionModel
  const adapted =
    runtime instanceof DecisionModel && mediaInput !== undefined
      ? new DecisionModel({
          ...runtime,
          compatibility: DecisionModelCompatibility.make({ ...runtime.compatibility, mediaInput }),
        })
      : runtime
  // 用类型守卫确认产物是请求的模型类型；否则视为不受支持的包
  if (!is(adapted)) return yield* unsupported(resolved)
  // 返回适配后的模型
  return adapted
})

// constructionError：把构造阶段的异常归类——提供商配置错误单列，其余算初始化错误
const constructionError = (model: RuntimeInfo, cause: unknown) =>
  cause instanceof ProviderConfigurationError
    ? new ModelConfigurationError({
        providerID: model.providerID,
        modelID: model.id,
        package: model.package ?? "unknown",
        detail: cause.message,
      })
    : initialization(model, "construct", cause)

// 图像模型类型守卫
const isImageModel = Schema.is(ImageModelSchema)
// 决策模型类型守卫
const isDecisionModel = Schema.is(DecisionModelSchema)

// prepareRuntimeModel：apiKey 为空字符串时从设置中剔除该键（视为未配置）
function prepareRuntimeModel(model: RuntimeInfo) {
  if (model.settings?.apiKey !== "") return model
  return { ...model, settings: Struct.omit(model.settings, ["apiKey"]) }
}

// validateProviderVariables：校验路由端点 URL 中的变量是否都已解析
function validateProviderVariables(
  model: RuntimeInfo,
  resolved: LanguageModel,
): Effect.Effect<LanguageModel, UnresolvedProviderVariablesError> {
  // 读取端点 baseURL
  const baseURL = resolved.route.endpoint.baseURL
  // 不是字符串（如自定义端点对象）则跳过校验
  if (typeof baseURL !== "string") return Effect.succeed(resolved)
  // 检查是否残留未解析变量
  const failure = unresolvedProviderVariables(model, baseURL)
  // 有残留则失败，否则通过
  return failure ? Effect.fail(failure) : Effect.succeed(resolved)
}

// prepareProviderSettings：对设置中的 baseURL 做变量预处理
function prepareProviderSettings(
  model: RuntimeInfo,
  settings: Readonly<Record<string, unknown>>,
): Effect.Effect<Readonly<Record<string, unknown>>, UnresolvedProviderVariablesError> {
  // 读取设置里的 baseURL
  const baseURL = settings.baseURL
  // 不是字符串则原样返回
  if (typeof baseURL !== "string") return Effect.succeed(settings)
  // 预处理 URL；若结果与原值相同则直接返回原设置对象
  return prepareProviderURL(model, baseURL, settings).pipe(
    Effect.map((prepared) => (prepared === baseURL ? settings : { ...settings, baseURL: prepared })),
  )
}

// prepareProviderURL：把 baseURL 中的 ${VAR} 占位符替换为环境变量或设置值
function prepareProviderURL(
  model: RuntimeInfo,
  baseURL: string,
  settings: Readonly<Record<string, unknown>>,
): Effect.Effect<string, UnresolvedProviderVariablesError> {
  // 不含占位符则无需处理
  if (!baseURL.includes("${")) return Effect.succeed(baseURL)
  // Catalog Bedrock URLs are model settings while `region` is a provider setting, so they only meet here.
  // 替换占位符：AWS_REGION 优先取设置里的 region（目录里它是模型设置而 region 是提供商设置，只有在此相遇），其余读环境变量
  const prepared = baseURL.replace(
    /\$\{([^}]+)\}/g,
    (placeholder, name: string) =>
      (name === "AWS_REGION" && typeof settings.region === "string" ? settings.region : process.env[name]) ??
      placeholder,
  )
  // 替换后仍有残留变量的则报错
  const failure = unresolvedProviderVariables(model, prepared)
  return failure ? Effect.fail(failure) : Effect.succeed(prepared)
}

// unresolvedProviderVariables：提取 baseURL 中残留的 ${VAR} 变量，存在则构造错误
function unresolvedProviderVariables(model: RuntimeInfo, baseURL: string) {
  // 用正则全局匹配占位符名并去重
  const variables = new Set(Array.from(baseURL.matchAll(/\$\{([^}]+)\}/g), (match) => match[1]))
  // 没有残留变量则返回 undefined
  if (variables.size === 0) return
  // 构造未解析变量错误
  return new UnresolvedProviderVariablesError({
    providerID: model.providerID,
    modelID: model.id,
    variables: Array.from(variables),
  })
}

// nativeCredentialSettings：把存储凭据转换为对应包的原生设置字段
const nativeCredentialSettings = (model: RuntimeInfo, specifier: string, credential: Credential.Value | undefined) => {
  // 无凭据则不注入任何字段
  if (!credential) return {}
  // API key 凭据：注入 apiKey
  if (credential.type === "key") return { apiKey: credential.key }
  // OAuth 凭据：按包名选择令牌字段
  if (credential.type === "oauth") return tokenSettings(specifier, credential.access)
  // The Bedrock plugin projects the saved profile into settings; SigV4 keeps an ambient bearer token from taking over.
  // Bedrock 插件会把保存的配置投射进设置；用 SigV4 防止环境中的临时令牌抢占
  if (specifier.startsWith("@opencode/ai/providers/amazon-bedrock")) return { auth: "sigv4" }
  // The Azure plugin's request hooks replace this with an Entra ID token from the Azure CLI; it only gets the
  // request past the package's own credential check.
  // Azure 插件的请求钩子会用 Azure CLI 的 Entra ID 令牌替换该占位值，只为通过包自身的凭据检查
  if (model.providerID === Provider.ID.azure) return tokenSettings(specifier, "azure-cli")
  // 其他情况不注入
  return {}
}

// tokenSettings：按包名选择令牌的注入字段名（authToken/accessToken/apiKey）
const tokenSettings = (specifier: string, token: string) => {
  // Anthropic 系包使用 authToken
  if (specifier === "@opencode/ai/providers/anthropic" || specifier === "@opencode/ai/providers/anthropic-compatible")
    return { authToken: token }
  // Google Vertex 系包使用 accessToken
  if (
    specifier === "@opencode/ai/providers/google-vertex" ||
    specifier.startsWith("@opencode/ai/providers/google-vertex/")
  )
    return { accessToken: token }
  // 其余包统一用 apiKey
  return { apiKey: token }
}

// unsupported：构造“不受支持的包”错误
const unsupported = (model: RuntimeInfo) =>
  new UnsupportedPackageError({
    providerID: model.providerID,
    modelID: model.id,
    package: model.package ?? "unknown",
  })

// initialization：构造初始化错误，附带阶段与尽可能有用的详情
const initialization = (model: RuntimeInfo, phase: InitializationPhase, cause: unknown) =>
  new ModelInitializationError({
    providerID: model.providerID,
    modelID: model.id,
    package: model.package ?? "unknown",
    phase,
    detail: causeMessage(cause) ?? `${phase} failed for ${model.package ?? "unknown"}`,
  })

// Unexpected throws still carry the most useful diagnosis in their message; a stack or an unknown value does not.
// causeMessage：从异常中提取最有诊断价值的消息（字符串原样；Error 取 message；否则递归看 cause）
const causeMessage = (cause: unknown): string | undefined => {
  // 字符串异常：去除首尾空白，空串视为无消息
  if (typeof cause === "string") return cause.trim() || undefined
  // 不是 Error 实例（注意绕过被包覆盖的 Error）则不提取
  if (!(cause instanceof globalThis.Error)) return undefined
  // 取 message，非空则用
  const message = cause.message.trim()
  if (message) return message
  // 否则递归取底层 cause 的消息
  return causeMessage(cause.cause)
}

// resolveModel：先叠加变体，再从目录模型构建运行时模型（供无服务场景直接调用）
export const resolveModel = (
  model: Info,
  variant: VariantID | undefined,
  credential?: Credential.Value,
  dependencies?: Dependencies,
) => withVariant(model, variant).pipe(Effect.flatMap((model) => fromCatalogModel(model, credential, dependencies)))

// hasPackage：模型是否指定了提供商包
export const hasPackage = (model: Info) => Boolean(model.package)

/** Resolves catalog selections into runtime models for the current Location. */
// layer：把目录中的模型选择解析为当前 Location 可用的运行时模型
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 依次获取依赖：提供商、模型目录、集成、NPM、AI SDK 服务
    const providers = yield* Provider.Service
    const models = yield* Model.Service
    const integrations = yield* Integration.Service
    const npm = yield* Npm.Service
    const aisdk = yield* AISDK.Service
    // 组装依赖实现：包加载走 Provider（带 npm），AI SDK 初始化走 aisdk 服务
    const dependencies: Dependencies = {
      loadPackage: (specifier) => Provider.loadPackage(specifier, npm),
      loadAISDK: (model) => aisdk.model(model),
    }
    // prepare：为一次模型选择准备提供商、凭据与运行时信息
    const prepare = Effect.fn("ModelResolver.prepare")(function* (selected: Info, variant?: VariantID) {
      // 获取提供商配置（可能不存在）
      const provider = yield* providers.get(selected.providerID)
      // 激活提供商对应的集成连接（无集成时用提供商 ID 兜底构造）
      const connection = yield* integrations.connection.active(
        provider?.integrationID ?? Integration.ID.make(selected.providerID),
      )
      // 有连接则解析出凭据
      const credential = connection ? yield* integrations.connection.resolve(connection) : undefined
      // 叠加请求的变体
      const selectedVariant = yield* withVariant(selected, variant)
      // 组装运行时信息：合并提供商设置与模型设置
      const runtimeInfo: RuntimeInfo = {
        ...selectedVariant,
        settings: Provider.mergeOverlay(provider?.settings, Provider.modelSettings(selectedVariant.settings)),
      }
      // 返回准备结果
      return { provider, credential, runtimeInfo }
    })
    // load：完整的模型解析——准备、构建运行时、按需去除冗余认证
    const load = Effect.fn("ModelResolver.resolveModel")(function* (selected: Info, variant?: VariantID) {
      // 先做准备工作
      const { provider, credential, runtimeInfo } = yield* prepare(selected, variant)
      // 构建语言模型运行时
      const model = yield* fromCatalogModel(runtimeInfo, credential, dependencies)
      // 提供商已启用集成、又没有凭据、也没配置任何认证、且包用 API key 认证：
      const runtime =
        provider?.activation === "enabled" &&
        credential === undefined &&
        !hasConfiguredAuth(runtimeInfo) &&
        usesAPIKeyAuth(runtimeInfo.package)
          ? LanguageModel.update(model, { route: model.route.with({ auth: Auth.none }) })
          : model
      // 返回解析结果：模型、目录引用、能力、价格、上限、压缩/缓存/传输策略与分块超时
      return {
        model: runtime,
        ref: Ref.make({
          id: selected.id,
          providerID: selected.providerID,
          ...(variant === undefined ? {} : { variant }),
        }),
        capabilities: selected.capabilities,
        cost: selected.cost,
        limit: selected.limit,
        compaction: runtimeInfo.settings?.compaction,
        cache: runtimeInfo.settings?.cache,
        transport: provider?.settings?.transport,
        chunkTimeout: Provider.timeout(provider?.settings?.chunkTimeout),
      }
    })
    // loadMedia：按引用加载图像/决策模型（未启用或找不到则返回 undefined）
    const loadMedia = Effect.fnUntraced(function* <Runtime>(
      ref: Ref,
      type: Model.Type,
      is: (value: unknown) => value is Runtime,
    ) {
      // 在指定类型的可用模型中查找匹配提供商与 ID 的那条
      const info = (yield* models.available([type])).find(
        (model) => model.providerID === ref.providerID && model.id === ref.id,
      )
      // 找不到则返回 undefined
      if (!info) return undefined
      const { provider, credential, runtimeInfo } = yield* prepare(info, ref.variant)
      // Same no-key rule as chat in `load`. A built image or decision model can't have its auth swapped like chat,
      // so the package gets `apiKey: false` up front and builds the model without auth.
      const keyless =
        provider?.activation === "enabled" &&
        credential === undefined &&
        !hasConfiguredAuth(runtimeInfo) &&
        usesAPIKeyAuth(runtimeInfo.package)
      return yield* fromCatalogMedia(
        keyless ? { ...runtimeInfo, settings: { ...runtimeInfo.settings, apiKey: false } } : runtimeInfo,
        is,
        credential,
        dependencies,
      )
    })
    const fallback = Effect.fn("ModelResolver.fallback")(function* () {
      const model = yield* models.default()
      if (model && hasPackage(model)) return model
      return (yield* models.available()).find((model) => hasPackage(model) && Model.supportsText(model))
    })
    // 返回服务实现
    return Service.of({
      // resolve：解析默认或指定的文本模型
      resolve: Effect.fn("ModelResolver.resolve")(function* (requested) {
        const selected = requested ? yield* models.get(requested.providerID, requested.id) : yield* fallback()
        if (!selected) return undefined
        // 加载选定的模型
        return yield* load(selected, requested?.variant)
      }),
      fallback,
      resolveModel: load,
      // resolveImage：解析图像模型
      resolveImage: Effect.fn("ModelResolver.resolveImage")(function* (ref) {
        return yield* loadMedia(ref, "image", isImageModel)
      }),
      // resolveDecision：解析决策模型
      resolveDecision: Effect.fn("ModelResolver.resolveDecision")(function* (ref) {
        return yield* loadMedia(ref, "decision", isDecisionModel)
      }),
    })
  }),
)

// hasConfiguredAuth：模型设置里是否配置了任一认证字段（apiKey/authToken/accessToken）
function hasConfiguredAuth(model: RuntimeInfo) {
  return [
    model.settings?.apiKey,
    model.settings?.gatewayApiKey,
    model.settings?.authToken,
    model.settings?.accessToken,
  ].some((value) => typeof value === "string" && value !== "")
}

// 使用 API key 认证的包名集合（AI SDK 与 OpenCode 提供商包）
const API_KEY_AUTH_PACKAGES: ReadonlySet<string> = new Set([
  "@ai-sdk/openai",
  "@ai-sdk/anthropic",
  "@ai-sdk/cerebras",
  "@ai-sdk/deepinfra",
  "@ai-sdk/openai-compatible",
  "@ai-sdk/google",
  "@ai-sdk/groq",
  "@ai-sdk/mistral",
  "@ai-sdk/togetherai",
  "@ai-sdk/xai",
  "@openrouter/ai-sdk-provider",
  "@ai-sdk/azure",
  "@opencode/ai/providers/openai",
  "@opencode/ai/providers/anthropic",
  "@opencode/ai/providers/anthropic-compatible",
  "@opencode/ai/providers/baseten",
  "@opencode/ai/providers/cerebras",
  "@opencode/ai/providers/cloudflare-ai-gateway",
  "@opencode/ai/providers/cloudflare-workers-ai",
  "@opencode/ai/providers/deepinfra",
  "@opencode/ai/providers/deepseek",
  "@opencode/ai/providers/fireworks",
  "@opencode/ai/providers/openai-compatible",
  "@opencode/ai/providers/openai-compatible/decisions",
  "@opencode/ai/providers/google",
  "@opencode/ai/providers/google/interactions",
  "@opencode/ai/providers/groq",
  "@opencode/ai/providers/mistral",
  "@opencode/ai/providers/togetherai",
  "@opencode/ai/providers/vercel-ai-gateway",
  "@opencode/ai/providers/xai",
  "@opencode/ai/providers/openrouter",
  "@opencode/ai/providers/azure",
])

// usesAPIKeyAuth：判断包是否依赖 API key 认证（含 openai/azure 子路径前缀）
function usesAPIKeyAuth(packageName: string | undefined) {
  // 规范化包名
  const name = Provider.packageName(packageName)
  // 无包名则不算
  if (name === undefined) return false
  // 命中集合，或属于 openai/azure 提供商的子路径包，都算
  return (
    API_KEY_AUTH_PACKAGES.has(name) ||
    name.startsWith("@opencode/ai/providers/openai/") ||
    name.startsWith("@opencode/ai/providers/azure/")
  )
}

// 导出位置节点：装配本层与全部依赖（提供商、模型、集成、NPM、AI SDK）
export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Provider.node, Model.node, Integration.node, Npm.node, AISDK.node],
})
