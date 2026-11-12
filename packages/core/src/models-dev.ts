// 从 effect 库导入核心工具：Cause（原因）、Context（上下文）、Duration（时长）、Effect（效果）、
// Layer（层）、Option（可选值）、Result（结果）、Schedule（调度）、Schema（模式）、Semaphore（信号量）
import { Cause, Context, Duration, Effect, Layer, Option, Result, Schedule, Schema, Semaphore } from "effect"
// 导入 HTTP 客户端相关：HttpClient（客户端）、HttpClientError（错误）、请求与响应构造器
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http"
// 导入供应商配置模式：含 Reasoning（推理）等字段定义
import { ConfigProvider } from "@opencode/schema/config/provider"
// 导入模型兼容性定义：MaxTokensField（最大 token 字段名）、MediaInput（媒体输入）
import { MaxTokensField, MediaInput } from "@opencode/schema/model-compatibility"
// 导入 ModelsDev 模式（models.dev 目录的事件等定义）
import { ModelsDev } from "@opencode/schema/models-dev"
// 导入 Money：按美元每百万 token 计的价格类型
import { Money } from "@opencode/schema/money"
import { FreeformFormat } from "@opencode/schema/tool"
import { App } from "./app.js"
// 导入 Hash：快速哈希与 sha256，用于缓存键与内容摘要
import { Hash } from "@opencode/util/hash"
// 导入 FSUtil：文件系统工具服务
import { FSUtil } from "@opencode/util/fs-util"
// 导入 Bus（事件总线）服务
import { Bus } from "./bus.js"
// 导入 makeGlobalNode：把服务包装成全局（global）节点
import { makeGlobalNode } from "@opencode/util/effect/app-node"
// 导入 httpClient 节点：平台级 HTTP 客户端依赖
import { httpClient } from "@opencode/util/effect/app-node-platform"
// 导入 Model 模块：模型（model）信息类型
import { Model } from "./model.js"
// 导入 AISDKNative：原生 AI SDK 提供商识别
import { AISDKNative } from "./aisdk-native.js"
// 导入 Provider 模块：供应商（provider）包名与工具
import { Provider } from "./provider.js"
// 导入 Variant 模块：模型变体（variant）解析
import { Variant } from "./variant.js"
// 导入 KV 服务：键值（key-value）持久化缓存
import { KV } from "./kv.js"
// 导入内置目录快照文本（构建期内联的多 MB 常量）
import snapshotText from "./models-dev/snapshot.txt" with { type: "text" }
// 导入 v1 目录转换：isV1（判断旧版）与 toV2（升级到新版结构）
import { isV1, toV2 } from "./models-dev/v1.js"

// Only the fields opencode reads are decoded. Unknown keys are ignored, and a model that
// doesn't match is skipped rather than failing the whole catalog.
// 只解码 opencode 会读取的字段；未知键忽略，单个模型不匹配时跳过而不是让整个目录（catalog）失败。
const Price = Money.USDPerMillionTokens
// 缓存写入价：单一价格，或按 TTL（存活时间）键分段的价格记录
const CacheWrite = Schema.Union([Price, Schema.Record(Schema.String, Price)])
// 缓存价格组：读取价、写入价、以及显式（explicit）写入价
const CachePrices = Schema.Struct({
  // 读取（read）缓存的价格
  read: Schema.optional(Price),
  // 写入（write）缓存的价格
  write: Schema.optional(CacheWrite),
  // 显式缓存写入价（部分目录用 explicit 区分）
  explicit: Schema.optional(Schema.Struct({ write: Schema.optional(CacheWrite) })),
})
// When：条件记录（键为条件名，值为任意内容），用于价格覆盖的条件匹配
const When = Schema.Record(Schema.String, Schema.Unknown)
// A number scales every price below it; an object scales only the prices it names.
// Factor：价格乘数——数字缩放其下所有价格；对象只缩放其点名的价格
type Factor = number | { readonly [key: string]: Factor }
// Factor 的编解码器：数字或按键递归的乘数记录（Schema.suspend 处理递归类型）
const Factor: Schema.Codec<Factor> = Schema.Union([
  // 有限数字形式
  Schema.Finite,
  // 对象形式：值为递归的 Factor
  Schema.Record(
    Schema.String,
    Schema.suspend((): Schema.Codec<Factor> => Factor),
  ),
])
// SourceCost：目录源数据中的费用结构（文本输入/输出价、缓存价、条件覆盖、乘数）
const SourceCost = Schema.Struct({
  // 文本（text）费用
  text: Schema.optional(
    Schema.Struct({
      // 输入价结构
      input: Schema.optional(
        Schema.Struct({
          // 计价单位（token 或其他）
          unit: Schema.optional(Schema.String),
          // 每百万 token 的输入价
          price: Price,
          // 缓存价格组
          cache: Schema.optional(CachePrices),
          // 条件覆盖列表（按 when 匹配后替换价格）
          overrides: Schema.optional(
            Schema.Array(
              Schema.Struct({ when: When, price: Schema.optional(Price), cache: Schema.optional(CachePrices) }),
            ),
          ),
        }),
      ),
      // 输出价结构
      output: Schema.optional(
        Schema.Struct({
          // 计价单位
          unit: Schema.optional(Schema.String),
          // 每百万 token 的输出价
          price: Price,
          // 条件覆盖列表
          overrides: Schema.optional(Schema.Array(Schema.Struct({ when: When, price: Schema.optional(Price) }))),
        }),
      ),
    }),
  ),
  // 服务档位乘数列表（when 匹配时按 factor 缩放价格）
  multipliers: Schema.optional(Schema.Array(Schema.Struct({ when: When, factor: Factor }))),
})
// 导出 SourceCost 的类型
type SourceCost = typeof SourceCost.Type

// API entries and modes are lists models.dev keeps adding to, so each is decoded on its own and an
// entry this version doesn't understand is skipped instead of failing the model.
// API 条目与模式（mode）列表会持续扩充，因此各自独立解码；本版本不认识的条目跳过而不使模型失败。
const SourceApi = Schema.Struct({
  // API 的基础 URL（可为空字符串，表示无 URL）
  base_url: Schema.optional(Schema.String),
  capabilities: Schema.optional(
    Schema.Struct({
      // Format names this version doesn't know are skipped when the route is built.
      tools: Schema.optional(Schema.Struct({ freeform: Schema.optional(Schema.Array(Schema.String)) })),
    }),
  ),
  sdk: Schema.optional(
    Schema.Struct({ aisdk: Schema.optional(Schema.String), opencodeai: Schema.optional(Schema.String) }),
  ),
  // 兼容性信息：推理字段、最大 token 字段、媒体输入的适配
  compatibility: Schema.optional(
    Schema.Struct({
      // 推理（reasoning）字段名
      reasoning_field: Schema.optional(Schema.String),
      // 最大 token（max tokens）字段名
      max_tokens_field: Schema.optional(Schema.String),
      // 媒体输入（media input）格式
      media_input: Schema.optional(Schema.String),
    }),
  ),
})

// SourceMode：实验性模式定义（如某个服务档位下的同名模型变体）
const SourceMode = Schema.Struct({
  // 服务档位（service tier）名
  service_tier: Schema.optional(Schema.String),
  // 模式自带的费用结构
  cost: Schema.optional(SourceCost),
  // 请求体（body）覆盖
  body: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  // 请求头（headers）覆盖
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})
// 导出 SourceMode 的类型
type SourceMode = typeof SourceMode.Type

// SourceModel：目录源数据中的单个模型条目
const SourceModel = Schema.Struct({
  // 模型 ID
  id: Schema.String,
  // 模型类型（chat、image、decision…）
  type: Schema.String,
  // 展示名
  name: Schema.String,
  // 模型家族（family，可选）
  family: Schema.optional(Schema.String),
  // 发布日期
  release_date: Schema.String,
  // 状态（active/alpha/beta/deprecated，可选）
  status: Schema.optional(Schema.String),
  // 输入/输出媒体类型列表
  modalities: Schema.Struct({ input: Schema.Array(Schema.String), output: Schema.Array(Schema.String) }),
  // 能力信息
  capabilities: Schema.Struct({
    // 工具（tools）调用支持
    tools: Schema.Struct({ supported: Schema.Boolean }),
    // 推理能力配置
    reasoning: ConfigProvider.Reasoning,
    // 温度（temperature）支持（可选）
    temperature: Schema.optional(Schema.Boolean),
  }),
  // 上下文/输入/输出限制
  limit: Schema.optional(
    Schema.Struct({
      // 上下文窗口上限
      context: Schema.optional(Schema.Finite),
      // 单次输入上限
      input: Schema.optional(Schema.Finite),
      // 单次输出上限
      output: Schema.optional(Schema.Finite),
    }),
  ),
  // 费用结构
  cost: Schema.optional(SourceCost),
  // Ordered: the first API is the model's default.
  // 模型可用的 API 记录（键为协议名）；有序，第一个 API 是模型的默认选择
  api: Schema.Record(Schema.String, Schema.Unknown),
  // 实验性配置（含模式列表）
  experimental: Schema.optional(
    Schema.Struct({ modes: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)) }),
  ),
})
// 导出 SourceModel 的类型
type SourceModel = typeof SourceModel.Type

// SourceProvider：目录源数据中的单个供应商条目
const SourceProvider = Schema.Struct({
  // 供应商 ID
  id: Schema.String,
  // 展示名
  name: Schema.String,
  // 环境变量名列表（API key 所在变量）
  env: Schema.Array(Schema.String),
  // 模型记录（键为模型 ID，值待逐个解码）
  models: Schema.Record(Schema.String, Schema.Unknown),
})

// The model types opencode keeps. Only chat models are offered for sessions; the others are listed on request.
// opencode 保留的模型类型；只有 chat 模型提供给会话（session），其他类型按需列出
const TYPES: readonly string[] = ["chat", "decision", "image"]

// 上下文条件（gt/gte）：用于价格分档的上下文阈值
const ContextCondition = Schema.Struct({ gt: Schema.optional(Schema.Finite), gte: Schema.optional(Schema.Finite) })
// 各类字段的解码器：返回 Result/Option 以便失败时跳过条目
const decodeModel = Schema.decodeUnknownResult(SourceModel)
// API 条目解码器（Option）
const decodeApi = Schema.decodeUnknownOption(SourceApi)
// 模式解码器（Option）
const decodeMode = Schema.decodeUnknownOption(SourceMode)
// 供应商解码器（Option）
const decodeProvider = Schema.decodeUnknownOption(SourceProvider)
// 上下文条件解码器（Option）
const decodeContext = Schema.decodeUnknownOption(ContextCondition)
// 最大 token 字段解码器（Option）
const decodeMaxTokensField = Schema.decodeUnknownOption(MaxTokensField)
// 媒体输入解码器（Option）
const decodeMediaInput = Schema.decodeUnknownOption(MediaInput)
const knownFreeformFormat = Schema.is(FreeformFormat)
const decodeStatus = Schema.decodeUnknownOption(Schema.Literals(["alpha", "beta", "deprecated"]))

// Snapshot：规范化后的目录快照——供应商信息、模型列表、环境变量名
export type Snapshot = {
  // 供应商信息
  readonly info: Provider.Info
  // 该供应商下的模型列表
  readonly models: readonly Model.Info[]
  // API key 所在的环境变量名
  readonly environment: readonly string[]
}

// Route：模型到包的"路由"——用哪个包加载、基础 URL 与兼容性
type Route = {
  // 提供商包名（@opencode/ai/providers/... 或 aisdk:xxx）
  readonly package: string
  readonly freeform?: Model.Capabilities["freeform"]
  readonly baseURL?: string
  // 兼容性信息（可选）
  readonly compatibility?: Model.Compatibility
}

// These packages build their URL from provider settings (region, resource, account, project…), which
// only happens when no baseURL is set. The catalog's URL for them is a template or SDK default.
// 这些包会依据供应商设置（区域、资源、账号、项目…）自行构造 URL，
// 只有在未设置 baseURL 时才会发生；目录里给它们的 URL 是模板或 SDK 默认值。
const BUILDS_OWN_URL = new Set([
  // Amazon Bedrock 入口点
  "@opencode/ai/providers/amazon-bedrock",
  // Azure chat 入口点
  "@opencode/ai/providers/azure/chat",
  // Azure images 入口点
  "@opencode/ai/providers/azure/images",
  // Azure messages 入口点
  "@opencode/ai/providers/azure/messages",
  // Azure responses 入口点
  "@opencode/ai/providers/azure/responses",
  // Cloudflare AI Gateway 入口点
  "@opencode/ai/providers/cloudflare-ai-gateway",
  // Cloudflare AI Gateway 决策入口点
  "@opencode/ai/providers/cloudflare-ai-gateway/decisions",
  // Cloudflare Workers AI 入口点
  "@opencode/ai/providers/cloudflare-workers-ai",
  // Cloudflare Workers AI 决策入口点
  "@opencode/ai/providers/cloudflare-workers-ai/decisions",
  // Cloudflare Workers AI 图像入口点
  "@opencode/ai/providers/cloudflare-workers-ai/images",
  // Google Vertex Gemini 入口点
  "@opencode/ai/providers/google-vertex/gemini",
  // Google Vertex 图像入口点
  "@opencode/ai/providers/google-vertex/images",
  // Google Vertex messages 入口点
  "@opencode/ai/providers/google-vertex/messages",
  // SAP AI 提供商（社区 AI SDK 包）
  "aisdk:@jerome-benoit/sap-ai-provider-v2",
  // Watsonx AI 提供商（社区 AI SDK 包）
  "aisdk:watsonx-ai-provider",
])

// normalize：把原始目录 JSON 规范化成快照列表；解析失败的条目记录并跳过
const normalize = Effect.fnUntraced(function* (catalog: Record<string, unknown>) {
  // failed：解析失败的模型记录（名称 + 问题），用于日志
  const failed: { readonly model: string; readonly issue: unknown }[] = []
  // unknown：本版本不认识的 @opencode/ai 入口点集合，用于调试日志
  const unknown = new Set<string>()
  // 遍历目录中的每个供应商（v1 目录先升级为 v2 结构），逐个解码
  const snapshots = Object.values(isV1(catalog) ? toV2(catalog) : catalog).flatMap((value) => {
    // 解码供应商条目；失败则跳过
    const item = Option.getOrUndefined(decodeProvider(value))
    // 无法解码为供应商时返回空
    if (!item) return []
    // 构造供应商 ID
    const providerID = Provider.ID.make(item.id)
    // sources：解码该供应商下的每个模型，并解析其路由
    const sources = Object.entries(item.models).flatMap(([key, value]) => {
      // 解码模型条目
      const decoded = decodeModel(value)
      // 解码失败时记录到 failed 列表
      if (Result.isFailure(decoded)) failed.push({ model: `${item.id}/${key}`, issue: decoded.failure })
      // 解码成功则取模型，失败为 undefined
      const model = Result.isSuccess(decoded) ? decoded.success : undefined
      // The fetch already asks for these types, but custom files and v1 catalogs may hold any type.
      // 解析该模型的路由（拉取时已按类型过滤，但自定义文件与 v1 目录可能含任意类型）
      const target = model && TYPES.includes(model.type) && route(providerID, model, unknown)
      // 模型与路由都有效时保留
      return model && target ? [{ model, route: target }] : []
    })
    // 没有可用模型时跳过该供应商
    if (sources.length === 0) return []
    // v2 lists APIs per model, so the provider defaults are what most of its models use. A model that
    // builds its own URL would inherit a provider baseURL, so then every model carries its own instead.
    // 供应商默认包名取其模型中最常用的包
    const packageName = mostCommon(sources.map((source) => source.route.package))
    // 无可用包名时跳过
    if (!packageName) return []
    // 收集所有模型的基础 URL
    const urls = sources.map((source) => source.route.baseURL)
    // 仅当所有模型都有 URL 时才设置供应商级 baseURL（有模型自建 URL 时让每个模型自带）
    const baseURL = urls.every((url) => url !== undefined) ? mostCommon(urls) : undefined
    // 构造供应商信息：自动激活，附带最常见包名与 baseURL
    const info = {
      // 供应商 ID
      id: providerID,
      // 展示名
      name: item.name,
      // 激活方式：自动
      activation: "auto",
      // 供应商默认包名
      package: packageName,
      // 有 baseURL 时写入设置
      ...(baseURL ? { settings: { baseURL } } : {}),
    } satisfies Provider.Info
    // models：为每个模型生成基本信息及其模式（mode）变体
    const models = sources.flatMap((source) => {
      // 计算该模型的基础费用（含分档）
      const baseCost = cost(source.model.cost)
      // 模型 ID
      const id = Model.ID.make(source.model.id)
      // 基础模型信息
      const base = modelInfo(providerID, { packageName, baseURL }, id, source, { cost: baseCost })
      // 解析该模型支持推理时的变体（reasoning effort 等）
      const variants = Variant.resolve(
        // 以基础信息（但路由用模型自己的包）解析变体
        { ...base, package: source.route.package },
        // 该模型的推理支持配置
        Variant.supports(source.model.capabilities.reasoning),
      )
      // 返回基础模型与所有模式变体
      return [
        // 基础模型（附变体）
        { ...base, variants },
        // 为每个实验模式生成一个独立模型条目
        ...entries(source.model.experimental?.modes, decodeMode).map(([mode, options]) =>
          // 模式条目的 ID 为 "模型ID-模式名"
          modelInfo(providerID, { packageName, baseURL }, Model.ID.make(`${source.model.id}-${mode}`), source, {
            // 展示名追加首字母大写的模式名
            name: `${source.model.name} ${mode.charAt(0).toUpperCase()}${mode.slice(1)}`,
            // 模式费用（基于基础费用与档位乘数缩放）
            cost: modeCost(source.model, baseCost, mode, options),
            // 模式自带的请求覆盖
            request: options,
            // 与基础模型相同的变体
            variants,
          }),
        ),
      ]
    })
    // 返回该供应商的快照
    return [{ info, models, environment: [...item.env] }]
  })
  // 有解析失败的模型时输出警告日志（只展示前 10 个名称）
  if (failed.length > 0)
    yield* Effect.logWarning("Skipped models.dev models that failed to parse", {
      // 失败总数
      count: failed.length,
      // 前 10 个失败模型名
      models: failed.slice(0, 10).map((item) => item.model),
      // 第一个失败的原因字符串
      issue: String(failed[0]?.issue),
    })
  // 有不认识的入口点时输出调试日志
  if (unknown.size > 0)
    yield* Effect.logDebug("Skipped models.dev APIs with entrypoints this build doesn't have", {
      // 入口点名列表
      entrypoints: [...unknown],
    })
  // 返回全部快照
  return snapshots as readonly Snapshot[]
})

// entries：把可选记录逐条解码成 [键, 值] 对；解码失败的条目跳过
function entries<A>(record: Record<string, unknown> | undefined, decode: (input: unknown) => Option.Option<A>) {
  // 遍历记录条目，解码成功才保留
  return Object.entries(record ?? {}).flatMap(([key, value]) =>
    Option.match(decode(value), { onNone: () => [], onSome: (entry) => [[key, entry] as const] }),
  )
}

// route：为模型挑选可加载的 API 入口点并生成路由
function route(providerID: Provider.ID, model: SourceModel, unknown: Set<string>): Route | undefined {
  // A chat model uses its first API with a package. Other types (image, decision…) only run through the
  // opencode entrypoint for their type (`providers/<P>/images`) that this build can load, and are skipped
  // without one: a chat entrypoint loads a chat model, which can't generate images or decisions.
  // 把模型的每个 API 条目解码，并标记其 opencodeai 入口点是否本构建可加载
  const apis = entries(model.api, decodeApi).map(
    // 返回 [协议名, 条目, 可加载的 opencodeai 包名或 undefined]
    ([protocol, entry]) => [protocol, entry, loadable(entry.sdk?.opencodeai, unknown)] as const,
  )
  // chat 模型取第一个有包的 API；其他类型只走本类型专属入口点（providers/<P>/images）
  const [protocol, api, opencodeai] =
    (model.type === "chat"
      // chat：第一个可用 opencodeai 或 aisdk 包的 API
      ? apis.find(([, entry, opencodeai]) => opencodeai || entry.sdk?.aisdk)
      // 非 chat：第一个入口点路径以 "类型s" 结尾的 API
      : apis.find(([, , opencodeai]) => opencodeai?.endsWith(`/${model.type}s`))) ?? []
  // 找不到可用 API 则无路由
  if (!protocol || !api) return undefined
  // 取 aisdk 包名（可选）
  const aisdk = api.sdk?.aisdk
  // 包名：优先 opencodeai 原生入口点；否则由 aisdk 包解析（原生识别失败回退到通用 aisdk 包名）
  const packageName =
    opencodeai ??
    (aisdk &&
      (AISDKNative.native(aisdk, {
        // 供应商 ID
        providerID,
        // 模型 ID
        modelID: model.id,
        // 请求形态：responses 协议用 responses，chat-completions 用 completions，其余未指定
        shape: protocol === "responses" ? "responses" : protocol === "chat-completions" ? "completions" : undefined,
      }) ??
        // 原生不支持时退回 "aisdk:<包名>" 形式
        Provider.aisdk(aisdk)))
  // 无法确定包名则无路由
  if (!packageName) return undefined
  // 解码最大 token 字段名（无效则 undefined）
  const maxTokensField = Option.getOrUndefined(decodeMaxTokensField(api.compatibility?.max_tokens_field))
  // 解码媒体输入格式（无效则 undefined）
  const mediaInput = Option.getOrUndefined(decodeMediaInput(api.compatibility?.media_input))
  // 汇总兼容性信息（仅保留存在的字段）
  const compatibility = {
    // 推理字段名
    ...(api.compatibility?.reasoning_field ? { reasoningField: api.compatibility.reasoning_field } : {}),
    // 最大 token 字段名
    ...(maxTokensField ? { maxTokensField } : {}),
    // 媒体输入格式
    ...(mediaInput ? { mediaInput } : {}),
  }
  // 返回路由
  return {
    // 包名
    package: packageName,
    freeform: api.capabilities?.tools?.freeform?.filter(knownFreeformFormat),
    // An empty base_url is how models.dev says it has no URL for the API.
    // 自建 URL 的包或无 base_url 时不携带 baseURL；空字符串表示目录明确无 URL
    ...(BUILDS_OWN_URL.has(packageName) || !api.base_url ? {} : { baseURL: api.base_url }),
    // 有兼容性信息时附带
    ...(Object.keys(compatibility).length > 0 ? { compatibility } : {}),
  }
}

// Newer catalogs may name @opencode/ai entrypoints that older builds don't ship, so those count as no package.
// loadable：本构建未内置的 @opencode/ai 入口点视为无包并记入 unknown 集合
function loadable(opencodeai: string | undefined, unknown: Set<string>) {
  // 解析出真实包名（去掉 aisdk 前缀等）
  const name = Provider.packageName(opencodeai)
  // 非 @opencode/ai/ 包或已内置的包视为可加载
  if (!name?.startsWith("@opencode/ai/") || Provider.builtinPackages.has(name)) return opencodeai
  // 记录未内置的入口点（用于调试日志）
  unknown.add(name)
  // 视为无包
  return undefined
}

// mostCommon：返回列表中出现次数最多的元素；空列表返回 undefined
function mostCommon<T>(values: readonly T[]) {
  // 统计每个元素的出现次数
  const counts = new Map<T, number>()
  // 累加计数
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  // 找出计数最大的元素并返回；全空时返回 undefined
  return [...counts].reduce<[T, number] | undefined>(
    // 保留计数更大的项
    (best, entry) => (!best || entry[1] > best[1] ? entry : best),
    undefined,
  )?.[0]
}

// released：把发布日期字符串解析为毫秒时间戳；无效日期返回 0（排到最后）
function released(date: string) {
  // 解析日期
  const time = Date.parse(date)
  // 有效则返回时间戳，否则 0
  return Number.isFinite(time) ? time : 0
}

// COMPATIBLE：兼容型包集合——需要被告知真实供应商 ID 的通用入口点
const COMPATIBLE = new Set(["@opencode/ai/providers/openai-compatible", "@opencode/ai/providers/anthropic-compatible"])

// zero：零价格常量（免费模型的费用占位）
const zero = Money.USDPerMillionTokens.zero

// Only per-token text prices are kept: per-image, per-second and similar prices have
// no place in opencode's cost yet. Context overrides become tiers; other conditions
// (service tier, time of day…) are left out.
// 只保留按 token 计的文本价格：按图/按秒等价格 opencode 暂不使用。
// 上下文条件覆盖转为价格分档（tier）；其他条件（服务档位、时段…）忽略。
function cost(input: SourceCost | undefined): Model.Info["cost"] {
  // 取文本费用部分
  const text = input?.text
  // perToken：单位缺失或为 "token" 才算按 token 计价
  const perToken = (unit: string | undefined) => unit === undefined || unit === "token"
  // 缺输入/输出价或单位不是 token 时返回零价格
  if (!text?.input || !text.output || !perToken(text.input.unit) || !perToken(text.output.unit))
    // 返回单档零价格（免费占位）
    return [{ input: zero, output: zero, cache: { read: zero, write: zero } }]
  // 取输入价结构
  const textInput = text.input
  // 取输出价结构
  const textOutput = text.output
  // base：基础价格档
  const base = {
    // 每百万 token 输入价
    input: textInput.price,
    // 每百万 token 输出价
    output: textOutput.price,
    // 缓存价格：读取价缺失为零；写入价取首个 TTL 或显式价
    cache: { read: textInput.cache?.read ?? zero, write: cacheWrite(textInput.cache) ?? zero },
  }
  // An override merges field by field, so a tier keeps every base price it doesn't set.
  // tiers：上下文阈值 -> 该档位的价格；覆盖按字段合并，未设置的字段沿用基础价
  const tiers = new Map<number, Model.Info["cost"][number]>()
  // tier：按 when 条件取（或创建）对应档位；非上下文条件返回 undefined
  const tier = (when: Record<string, unknown>) => {
    // 仅当条件只含一个键且是 context 时才解码阈值
    const context = Object.keys(when).length === 1 ? Option.getOrUndefined(decodeContext(when.context)) : undefined
    // 取 gt 或 gte 阈值
    const size = context?.gt ?? context?.gte
    // 无阈值则忽略该覆盖
    if (size === undefined) return undefined
    // 取已有档位或基于基础价创建新档位
    const entry = tiers.get(size) ?? { ...base, tier: { type: "context" as const, size } }
    // 写回映射
    tiers.set(size, entry)
    // 返回档位对象
    return entry
  }
  // 处理输入价的每个覆盖
  for (const override of textInput.overrides ?? []) {
    // 找到（或创建）对应档位
    const entry = tier(override.when)
    // 非上下文条件跳过
    if (!entry) continue
    // 按字段合并覆盖：价格与缓存读取/写入缺失时沿用原值
    tiers.set(entry.tier!.size, {
      // 展开原档位
      ...entry,
      // 输入价覆盖
      input: override.price ?? entry.input,
      // 缓存价覆盖
      cache: {
        // 读取价覆盖
        read: override.cache?.read ?? entry.cache.read,
        // 写入价覆盖
        write: cacheWrite(override.cache) ?? entry.cache.write,
      },
    })
  }
  // 处理输出价的每个覆盖
  for (const override of textOutput.overrides ?? []) {
    // 找到（或创建）对应档位；存在才更新
    const entry = tier(override.when)
    // 仅覆盖该档位的输出价
    if (entry) tiers.set(entry.tier!.size, { ...entry, output: override.price ?? entry.output })
  }
  // 返回基础档与所有上下文分档
  return [base, ...tiers.values()]
}

// opencode has one cache write price: the first TTL listed, else the explicit cache's.
// cacheWrite：opencode 只保留一个缓存写入价——首选列出的首个 TTL，否则用显式缓存价
function cacheWrite(cache: typeof CachePrices.Type | undefined) {
  // first：对象形式取第一个值（首个 TTL），数值形式原样返回
  const first = (write: typeof CacheWrite.Type | undefined) =>
    // 对象时取 Object.values 的第一个，否则原值
    typeof write === "object" ? Object.values(write)[0] : write
  // 优先取 write 的首个值，回退到 explicit.write
  return first(cache?.write) ?? first(cache?.explicit?.write)
}

// A mode without its own cost takes the base prices scaled by its service tier's
// multiplier (the mode name by default). The base context tiers are kept unscaled.
// modeCost：模式没有自带费用时，用其服务档位的乘数缩放基础价（默认用模式名当档位）。
// 基础的上下文分档保持不缩放。
function modeCost(model: SourceModel, base: Model.Info["cost"], name: string, mode: SourceMode): Model.Info["cost"] {
  // 拆出基础档与其余上下文分档
  const [baseDefault, ...baseTiers] = base
  // 模式自带费用时：取其第一档 + 沿用基础分档
  if (mode.cost) return [cost(mode.cost)[0], ...baseTiers]
  // 档位名：模式显式指定，否则用模式名
  const tier = mode.service_tier ?? name
  // 在模型乘数表中找"仅含 service_tier 条件且值等于该档位"的乘数因子
  const factor = model.cost?.multipliers?.find(
    (multiplier) =>
      // 条件必须只含一个键
      Object.keys(multiplier.when).length === 1 &&
      // 解码出的 service_tier 等于目标档位名
      Option.getOrUndefined(decodeServiceTier(multiplier.when.service_tier))?.equals === tier,
  )?.factor
  // 无乘数或无基础档时原样返回
  if (factor === undefined || !baseDefault) return base
  // scale：按因子缩放价格并保留 10 位小数（避免浮点尾差）
  const scale = (price: Money.USDPerMillionTokens, path: readonly string[]) =>
    Money.USDPerMillionTokens.make(Math.round(price * factorAt(factor, path) * 1e10) / 1e10)
  // 返回缩放后的基础档 + 未缩放的分档
  return [
    {
      // 缩放后的输入价
      input: scale(baseDefault.input, ["text", "input", "price"]),
      // 缩放后的输出价
      output: scale(baseDefault.output, ["text", "output", "price"]),
      // 缩放后的缓存价
      cache: {
        // 缓存读取价
        read: scale(baseDefault.cache.read, ["text", "input", "cache", "read"]),
        // 缓存写入价
        write: scale(baseDefault.cache.write, ["text", "input", "cache", "write"]),
      },
    },
    // 沿用未缩放的基础分档
    ...baseTiers,
  ]
}

// 服务档位条件解码器：{ equals?: string }
const decodeServiceTier = Schema.decodeUnknownOption(Schema.Struct({ equals: Schema.optional(Schema.String) }))

// Prices an object factor doesn't name keep factor 1.
// factorAt：按路径取乘数因子；对象未点名的价格保持因子 1
function factorAt(factor: Factor, path: readonly string[]): number {
  // 沿路径逐层深入；遇数字（叶子）或缺失即停
  const node = path.reduce<Factor | undefined>(
    // 当前节点是对象时按键取子节点
    (node, key) => (node === undefined || typeof node === "number" ? node : node[key]),
    factor,
  )
  // 路径不存在时因子为 1
  if (node === undefined) return 1
  // 数字叶子直接作为因子
  if (typeof node === "number") return node
  // A cache write factor is keyed by TTL; opencode keeps the first one.
  // 对象叶子（如按 TTL 键的缓存写入因子）取第一个值
  const first = Object.values(node)[0]
  // 第一个值是数字则用它，否则因子 1
  return typeof first === "number" ? first : 1
}

// v2 lists exact MIME types; opencode's capabilities use the broad kind.
// modality：把精确 MIME 类型归并为宽泛类别（opencode 能力用粗粒度类型）
function modality(value: string) {
  // PDF 单独归为 "pdf"
  if (value === "application/pdf") return "pdf"
  // 取 MIME 主类型
  const kind = value.split("/")[0]
  // 文本/图像/音频/视频直接用主类型，其余原样保留
  return kind === "text" || kind === "image" || kind === "audio" || kind === "video" ? kind : value
}

// modalities：去重后的宽泛媒体类型列表
function modalities(values: readonly string[]) {
  // 先归并再去重
  return [...new Set(values.map(modality))]
}

// modelInfo：把源模型 + 路由组装成 opencode 的 Model.Info
function modelInfo(
  // 所属供应商 ID
  providerID: Provider.ID,
  // 供应商默认包名与 baseURL
  provider: { readonly packageName: string; readonly baseURL?: string },
  // 目标模型 ID（模式变体会带后缀）
  id: Model.ID,
  // 源模型与路由
  source: { readonly model: SourceModel; readonly route: Route },
  // 可选覆盖：展示名、费用、请求覆盖、变体
  input: {
    readonly name?: string
    readonly cost?: Model.Info["cost"]
    readonly request?: { readonly body?: Provider.Settings; readonly headers?: Readonly<Record<string, string>> }
    readonly variants?: NonNullable<Model.Info["variants"]>
  } = {},
): Model.Info {
  // 取源模型
  const model = source.model
  // Per model, so it never merges into a model that overrides to a different package. Compatible
  // packages are told the real host, so requests and saved provider state carry its ID.
  // 按模型单独保存设置，避免混入改用了其他包的模型；兼容型包要被告知真实主机，
  // 这样请求与已保存的供应商状态会携带其 ID。
  const settings = {
    // 模型路由的 baseURL 与供应商默认不同（且存在）时写入模型级 baseURL
    ...(source.route.baseURL !== undefined && source.route.baseURL !== provider.baseURL
      ? { baseURL: source.route.baseURL }
      : {}),
    // 兼容型包写入真实供应商 ID
    ...(COMPATIBLE.has(source.route.package) ? { provider: providerID } : {}),
  }
  // 返回组装好的模型信息
  return {
    // 目标模型 ID
    id,
    // 原始模型 ID（不带模式后缀）
    modelID: Model.ID.make(model.id),
    // 供应商 ID
    providerID,
    // 模型类型
    type: model.type,
    // 展示名：输入覆盖优先
    name: input.name ?? model.name,
    // 路由带来的兼容性信息
    compatibility: source.route.compatibility,
    // 家族（可选）
    family: model.family ? Model.Family.make(model.family) : undefined,
    // 模型包与供应商默认包不同时记录（否则 undefined 用供应商的）
    package: source.route.package !== provider.packageName ? source.route.package : undefined,
    // 设置：为空对象时记为 undefined
    settings: Object.keys(settings).length === 0 ? undefined : settings,
    // 能力：工具支持、输入/输出媒体类型、温度
    capabilities: {
      // 工具调用支持
      tools: model.capabilities.tools.supported,
      ...(source.route.freeform && { freeform: source.route.freeform }),
      input: modalities(model.modalities.input),
      // 归并后的输出媒体类型
      output: modalities(model.modalities.output),
      // 温度支持（可选）
      temperature: model.capabilities.temperature,
    },
    // 变体列表（拷贝一份避免共享）
    variants: [...(input.variants ?? [])],
    // 时间：发布时间戳
    time: { released: released(model.release_date) },
    // 费用：逐档浅拷贝 tier 与 cache，避免共享可变引用
    cost: (input.cost ?? cost(model.cost)).map((item) => ({
      // 展开价格档
      ...item,
      // 分档对象拷贝
      tier: item.tier && { ...item.tier },
      // 缓存价格拷贝
      cache: { ...item.cache },
    })),
    // 状态：解码 alpha/beta/deprecated，缺省视为 active
    status: Option.getOrElse(decodeStatus(model.status), () => "active" as const),
    // 默认启用
    enabled: true,
    // 限制：上下文与输出缺省为 0（未知），输入限制可选
    limit: { context: model.limit?.context ?? 0, input: model.limit?.input, output: model.limit?.output ?? 0 },
    // 请求头覆盖（拷贝）
    headers: input.request?.headers ? { ...input.request.headers } : undefined,
    // 请求体覆盖（拷贝）
    body: input.request?.body ? { ...input.request.body } : undefined,
  }
}

// 转发导出 @opencode/schema/models-dev 中的 Event（刷新事件等）
export { Event } from "@opencode/schema/models-dev"

// Interface：ModelsDev 服务的对外接口
export interface Interface {
  // 获取当前快照列表
  readonly get: () => Effect.Effect<readonly Snapshot[]>
  // 刷新目录；force 为 true 时跳过 TTL 与摘要短路
  readonly refresh: (force?: boolean) => Effect.Effect<void>
}

// Options：服务可配置项（来源 URL、本地文件、是否拉取/是否用内置快照）
export const Options = Schema.Struct({
  // 自定义目录源 URL（镜像）
  url: Schema.optional(Schema.String),
  // 从本地文件读取目录（调试用）
  file: Schema.optional(Schema.String),
  // 是否允许网络拉取
  fetch: Schema.optional(Schema.Boolean),
  // 是否使用内置快照兜底
  snapshot: Schema.optional(Schema.Boolean),
})
// 导出 Options 的类型
export type Options = typeof Options.Type

// 定义 ModelsDev 服务标识：标签 "@opencode/ModelsDev"
export class Service extends Context.Service<Service, Interface>()("@opencode/ModelsDev") {}

// CatalogJson：目录 JSON 字符串 -> Record<string, unknown> 的编解码器
const CatalogJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
// decodeCatalog：把响应文本解码为目录记录
const decodeCatalog = (text: string) => Schema.decodeUnknownEffect(CatalogJson)(text)
// Cache：KV 中缓存的目录条目（更新时间 + 可选摘要 + 正文）
const Cache = Schema.Struct({
  // 上次更新的毫秒时间戳
  updatedAt: Schema.Number,
  // Digest of the raw body, persisted so refresh() can skip republishing a
  // byte-identical catalog. Optional for entries written before it existed.
  // 原始正文的摘要（digest）；refresh() 可据此跳过内容相同的目录。
  // 旧版本写入的条目没有该字段，故可选。
  digest: Schema.optional(Schema.String),
  // 目录正文（JSON 文本）
  body: CatalogJson,
})
// CacheMeta：缓存的元信息条目（更新时间、摘要、ETag）
const CacheMeta = Schema.Struct({
  // 上次更新时间
  updatedAt: Schema.Number,
  // 内容摘要
  digest: Schema.optional(Schema.String),
  // 上次响应的 ETag（条件请求用）
  etag: Schema.optional(Schema.String),
})
// 默认目录源地址
const defaultSource = "https://models.opencode.ai"

// The experimental v2 API, limited to the model types opencode keeps.
// 实验性 v2 API 路径：只请求 opencode 保留的模型类型
export const catalogPath = `/experimental/v2.0/api.json?type=${TYPES.join(",")}`

// decodeSnapshot：把文本解码成目录再做规范化
export const decodeSnapshot = (text: string) => decodeCatalog(text).pipe(Effect.flatMap(normalize))

// Bundled snapshot of the catalog at `catalogPath`, committed at
// packages/core/src/models-dev/snapshot.txt and refreshed via
// `bun run script/update-models-snapshot.ts`. Release builds bundle the live
// catalog in its place when it can be fetched. Decoded and normalized once per
// isolate: the snapshot is a multi-MB module-level constant and one isolate can
// host many runtimes (Cloudflare colocates Durable Object instances), so
// per-runtime decoding would multiply the cost.
// 内置快照说明：目录的打包快照提交于 packages/core/src/models-dev/snapshot.txt，
// 通过 `bun run script/update-models-snapshot.ts` 刷新；发布构建若能拉到线上目录会替换它。
// 每个 isolate 只解码规范化一次：快照是多 MB 的模块级常量，一个 isolate 可承载多个运行时
// （Cloudflare 会同置 Durable Object 实例），按运行时解码会成倍增加开销。
let bundledCache: readonly Snapshot[] | undefined
// bundledSnapshot：惰性解码内置快照并缓存结果
const bundledSnapshot = Effect.suspend(() =>
  // 已有缓存直接复用
  bundledCache
    ? Effect.succeed(bundledCache)
    // 否则解码快照文本并写入缓存
    : decodeSnapshot(snapshotText).pipe(
        Effect.map((snapshot) => {
          // 记录缓存
          bundledCache = snapshot
          // 返回快照
          return bundledCache
        }),
      ),
)

// Versioned so an entry cached from the v1 API is never read as v2.
// cacheKey：按来源生成带版本的缓存键，保证 v1 时代缓存的条目不会被当成 v2 读取
function cacheKey(source: string) {
  // 默认源使用固定键
  if (source === defaultSource) return "models-dev:v2:catalog"
  // 自定义源按其哈希生成独立键
  return `models-dev:v2:catalog:${Hash.fast(source)}`
}

// bodyDigest：计算目录正文的 sha256 摘要
export function bodyDigest(text: string) {
  // 直接用 Hash.sha256
  return Hash.sha256(text)
}

// layer：ModelsDev 服务层工厂（可带选项）
export const layer = (options?: Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      // 获取文件系统工具服务
      const fs = yield* FSUtil.Service
      // 获取事件总线服务
      const bus = yield* Bus.Service
      const app = yield* App.Service
      const kv = yield* KV.Service
      // 获取 HTTP 客户端并包装瞬时错误重试：最多 2 次、200ms 指数退避加抖动
      const http = (yield* HttpClient.HttpClient).pipe(
        HttpClient.retryTransient({
          // 错误与异常响应都重试
          retryOn: "errors-and-responses",
          // 最多重试 2 次
          times: 2,
          // 200ms 指数退避并加抖动
          schedule: Schedule.exponential(200).pipe(Schedule.jittered),
        }),
      )

      // 目录源：选项 URL 优先，否则默认源
      const source = options?.url || defaultSource
      // 是否允许网络拉取（默认允许）
      const fetch = options?.fetch ?? true
      // 客户端 User-Agent
      const userAgent = App.useragent(app)
      // 目录缓存键
      const key = cacheKey(source)
      // 缓存元信息键
      const metaKey = `${key}:meta`
      // 刷新节流间隔：5 分钟
      const ttl = Duration.minutes(5)
      // 单许可信号量：保证拉取/写入互斥
      const lock = Semaphore.makeUnsafe(1)
      // The v1 catalog was cached under unversioned keys; free that multi-MB row.
      // v1 目录曾缓存在无版本键下；删除这些多 MB 的旧行释放空间
      yield* kv.remove(key.replace("models-dev:v2:", "models-dev:"))
      // 同步删除旧的元信息键
      yield* kv.remove(`${key.replace("models-dev:v2:", "models-dev:")}:meta`)

      // loadFromCache：读取并校验 KV 中的目录缓存；条目损坏时清除
      const loadFromCache = Effect.fnUntraced(function* () {
        // 读取缓存值
        const value = yield* kv.get(key)
        // 校验缓存结构
        const cached = Schema.decodeUnknownOption(Cache)(value)
        // 结构合法时返回目录、更新时间与摘要
        if (Option.isSome(cached))
          return {
            // 目录正文
            catalog: cached.value.body,
            // 更新时间
            updatedAt: cached.value.updatedAt,
            // 内容摘要
            digest: cached.value.digest,
          }
        // 无缓存时返回 undefined
        if (value === undefined) return
        // 存在但结构非法：删除脏数据（正文与元信息）
        yield* kv.remove(key)
        // 删除元信息
        yield* kv.remove(metaKey)
      })

      // fetchPath：按路径拉取目录，支持 ETag 条件请求；10 秒超时
      const fetchPath = (path: string, etag?: string) =>
        // 发起 GET 请求
        HttpClientRequest.get(`${source}${path}`).pipe(
          // 设置 User-Agent
          HttpClientRequest.setHeader("User-Agent", userAgent),
          // 有 ETag 时附带 If-None-Match
          HttpClientRequest.setHeaders(etag ? { "If-None-Match": etag } : {}),
          // 执行请求
          http.execute,
          // 304 未变更且带 ETag 时返回 undefined；否则校验状态并取文本
          Effect.flatMap((res) =>
            // 条件请求命中未修改
            etag && res.status === 304
              // 返回 undefined 表示无新内容
              ? Effect.undefined
              // 过滤非 2xx 响应并提取文本与 ETag
              : HttpClientResponse.filterStatusOk(res).pipe(
                  // 提取文本与响应 ETag
                  Effect.flatMap((ok) => Effect.map(ok.text, (text) => ({ text, etag: ok.headers.etag }))),
                ),
          ),
          // 整体 10 秒超时
          Effect.timeout("10 seconds"),
        )

      // fetchApi：拉取目录主路径；自定义镜像 404 时回退 v1 路径
      const fetchApi = Effect.fn("ModelsDev.fetchApi")(function* (etag?: string) {
        // 先请求 v2 路径
        return yield* fetchPath(catalogPath, etag).pipe(
          // A custom mirror may only serve the v1 catalog, which is converted when decoded.
          // 自定义镜像可能只提供 v1 目录（解码时会被转换）
          Effect.catchIf(
            // 仅当来源非默认源、错误是 HTTP 错误且状态为 404 时回退
            (error) =>
              source !== defaultSource && HttpClientError.isHttpClientError(error) && error.response?.status === 404,
            // 回退到 v1 路径
            () => fetchPath("/api.json", etag),
          ),
        )
      })

      // loadFromFile：从本地文件读取目录（调试用）；读取/解码失败视为无文件
      const loadFromFile = options?.file
        ? fs.readJson(options.file).pipe(
            // 校验为 Record<string, unknown>
            Effect.flatMap((input) => Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Unknown))(input)),
            // 失败时静默视为无文件
            Effect.orElseSucceed(() => undefined),
          )
        // 未配置文件时恒为 undefined
        : Effect.undefined

      // The bundled snapshot is the boot-time floor for the catalog; the
      // periodic fetch below still refreshes on top.
      // 内置快照是启动时的目录下限；下方的周期性拉取仍会在其上刷新
      const loadSnapshot = options?.snapshot === false ? Effect.undefined : bundledSnapshot

      // writeMeta：写入缓存元信息（更新时间 + 可选摘要与 ETag）
      const writeMeta = (updatedAt: number, digest: string | undefined, etag: string | undefined) =>
        // 只写入存在的字段
        kv.set(metaKey, { updatedAt, ...(digest ? { digest } : {}), ...(etag ? { etag } : {}) })

      // Best-effort: a cache-write failure must never kill catalog
      // population. The payload has outgrown some KV backends' per-value
      // limits (Durable Object SQLite caps values at 2 MB and the catalog
      // passed it in Aug 2026); a boot without a cache hit just refetches.
      // writeCache：尽力而为地写缓存——写失败绝不能中断目录填充。
      // 负载已超过部分 KV 后端的单值上限（Durable Object SQLite 单值 2 MB，
      // 目录在 2026 年 8 月突破）；启动时无缓存命中只会重新拉取。
      const writeCache = Effect.fn("ModelsDev.writeCache")(function* (
        // 目录正文文本
        text: string,
        // 响应 ETag
        etag: string | undefined,
        // 内容摘要（缺省现场计算）
        digest = bodyDigest(text),
      ) {
        // 记录当前时间
        const updatedAt = Date.now()
        // 写入正文缓存，随后写元信息；非中断类失败仅记录警告
        yield* kv.set(key, { updatedAt, digest, body: text }).pipe(
          // 正文写成功后写元信息
          Effect.andThen(writeMeta(updatedAt, digest, etag)),
          // 非中断（interrupt）类失败降级为警告日志
          Effect.catchCauseIf(
            // 中断类失败不处理
            (cause) => !Cause.hasInterruptsOnly(cause),
            // 其余失败记录警告
            (cause) => Effect.logWarning("Failed to cache models.dev catalog", { cause }),
          ),
        )
      })

      // fetchAndWrite：拉取目录、解码并写入缓存；返回解码后的目录
      const fetchAndWrite = Effect.fn("ModelsDev.fetchAndWrite")(function* () {
        // 发起拉取（可能因 304 返回 undefined）
        const response = yield* fetchApi()
        // 无新内容时返回空记录
        if (!response) return {}
        // 解码目录 JSON
        const catalog = yield* decodeCatalog(response.text)
        // 写入缓存
        yield* writeCache(response.text, response.etag)
        // 返回目录
        return catalog
      })

      // populate：目录填充的主流程——文件 > 缓存 > 内置快照 > 网络拉取
      const populate = Effect.gen(function* () {
        // 先尝试本地文件
        const fromFile = yield* loadFromFile
        // 有文件则直接规范化
        if (fromFile) return yield* normalize(fromFile)
        // 其次尝试 KV 缓存（配置了 file 时不读缓存）
        const cached = options?.file ? undefined : yield* loadFromCache()
        // 缓存命中则规范化
        if (cached) return yield* normalize(cached.catalog)
        // 再尝试内置快照
        const bundled = yield* loadSnapshot
        // 快照可用则直接返回（已缓存）
        if (bundled) return bundled
        // 不允许拉取且无任何来源时返回空
        if (!fetch) return []
        // 最后加锁拉取：锁内再查一次缓存，避免并发重复下载
        const catalog = yield* lock.withPermit(
          Effect.gen(function* () {
            // 锁内复查缓存
            const stored = options?.file ? undefined : yield* loadFromCache()
            // 命中则使用
            if (stored) return stored.catalog
            // 否则拉取并写入缓存
            return yield* fetchAndWrite()
          }),
        )
        // 规范化拉取到的目录
        return yield* normalize(catalog)
        // 打上 span 并把失败转为缺陷（目录缺失不可恢复）
      }).pipe(Effect.withSpan("ModelsDev.populate"), Effect.orDie)

      // 创建带失效句柄的无限期 TTL 缓存：populate 只跑一次，invalidate 可强制重算
      const [cachedGet, invalidate] = yield* Effect.cachedInvalidateWithTTL(populate, Duration.infinity)

      // get：返回缓存的快照列表
      const get = (): Effect.Effect<readonly Snapshot[]> => cachedGet

      // refresh：周期刷新——尊重 TTL 与 ETag/摘要，内容不变时静默更新元信息
      const refresh = Effect.fn("ModelsDev.refresh")(function* (force = false) {
        // 加锁执行，防止并发刷新
        yield* lock
          .withPermit(
            Effect.gen(function* () {
              // 读取元信息（缺失时回退读正文条目）
              const stored = Option.getOrUndefined(
                Schema.decodeUnknownOption(CacheMeta)((yield* kv.get(metaKey)) ?? (yield* kv.get(key))),
              )
              // 未强制且距上次更新不足 TTL 时跳过
              if (!force && stored && Date.now() - stored.updatedAt < Duration.toMillis(ttl)) return
              // 拉取目录（有 ETag 用条件请求；强制时不用）
              const response = yield* fetchApi(force ? undefined : stored?.etag)
              // 计算新内容摘要
              const digest = response && bodyDigest(response.text)
              // models.dev rarely changes between polls; skip invalidation and
              // the Refreshed event for a byte-identical body so downstream
              // provider/model update listeners stay quiet.
              // models.dev 在两次轮询间很少变化；字节级相同的正文跳过失效与
              // Refreshed 事件，让下游的供应商/模型更新监听者保持安静。
              if (!force && stored && (!response || stored.digest === digest)) {
                // 仅更新元信息时间戳（保留旧摘要，写回最新 ETag）
                yield* writeMeta(Date.now(), stored.digest, response?.etag ?? stored.etag)
                // 结束本次刷新
                return
              }
              // 无新内容时结束
              if (!response) return
              // 先解码校验，避免缓存损坏数据
              yield* decodeCatalog(response.text)
              // 写入缓存
              yield* writeCache(response.text, response.etag, digest)
              // 使 populate 缓存失效
              yield* invalidate
              // 全局广播 Refreshed 事件
              yield* bus.publish(ModelsDev.Event.Refreshed, {}, { global: true })
            }),
          )
          .pipe(
            // 拉取失败仅记录错误日志
            Effect.tapCause((cause) => Effect.logError("Failed to fetch models.dev", { cause: cause })),
            // 吞掉失败：刷新失败不影响服务
            Effect.ignore,
          )
      })

      // 允许拉取且非 yargs 补全模式时，启动周期刷新后台任务
      if (fetch && !process.argv.includes("--get-yargs-completions")) {
        // Schedule.spaced runs the effect once, then waits between completions.
        // Schedule.spaced：先执行一次，之后在两次完成之间等待间隔
        yield* Effect.forkScoped(refresh().pipe(Effect.repeat(Schedule.spaced(ttl)), Effect.ignore))
      }

      // 返回服务实现
      return Service.of({ get, refresh })
    }),
  )

// configured：按选项构建全局节点（不随某个位置/工作区创建）
export function configured(options?: Options) {
  // 组装全局节点：依赖 FSUtil/Bus/App/KV/httpClient
  return makeGlobalNode({
    // 服务类型
    service: Service,
    // 服务层
    layer: layer(options),
    // 依赖节点
    deps: [FSUtil.node, Bus.node, App.node, KV.node, httpClient],
  })
}

// node：默认配置的 ModelsDev 节点
export const node = configured()

// 末尾自导出：便于 `import { ModelsDev } from "./models-dev.js"` 引用命名空间
export * as ModelsDev from "./models-dev.js"
