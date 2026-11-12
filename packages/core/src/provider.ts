// 末尾自导出：便于 `import { Provider } from "./provider.js"` 引用命名空间
export * as Provider from "./provider.js"

// 从 effect 库导入：Context（上下文）、Effect（效果）、Layer（层）、Option（可选值）、
// Schema（模式）、Stream（流）、Struct（结构工具）
import { Context, Effect, Layer, Option, Schema, Stream, Struct } from "effect"
// 导入 Provider 模式（供应商的 ID、信息、设置等定义）
import { Provider } from "@opencode/schema/provider"
// 导入 Model 模式（模型的设置等定义）
import { Model } from "@opencode/schema/model"
// 导入 makeLocationNode：位置（location）节点工厂
import { makeLocationNode } from "@opencode/util/effect/app-node"
// 导入 HttpTimeout 模式与 ProviderPackage 类型（AI SDK 侧定义）
import { HttpTimeout, type ProviderPackage } from "@opencode/ai/effect"
import { Npm } from "@opencode/util/npm"
// 仅导入 DeepMutable 类型工具
import type { DeepMutable } from "./schema.js"
// 导入运行时模块导入工具：importModule（导入）、resolveModule（解析路径）
import { importModule, resolveModule } from "@opencode/util/runtime-import"
// 导入 Bus（事件总线）服务
import { Bus } from "./bus.js"
// 导入 Integration 服务：集成（integration）连接管理
import { Integration } from "./integration.js"
// 导入 State（状态管理）模块
import { State } from "./state.js"
// 导入 IntegrationConnection：连接信息与键计算
import { IntegrationConnection } from "./integration/connection.js"
// 导入 Credential 模式：凭证（credential）切换事件
import { Credential } from "@opencode/schema/credential"
// 导入 Location（位置）服务
import { Location } from "./location.js"
// 从 immer 导入 freeze：深度冻结对象
import { freeze } from "immer"
// 导入 AISDKNative：原生 AI SDK 提供商识别与重写
import { AISDKNative } from "./aisdk-native.js"

export { AISDK_PREFIX, aisdk, isAISDK, mergeHeaders, mergeOverlay, packageName } from "./aisdk-native.js"

export const ID = Provider.ID
// 导出 ID 类型别名
export type ID = typeof ID.Type

export class LoadError extends Schema.TaggedError<LoadError>()("Provider.LoadError", {
  // 包名
  package: Schema.String,
  // 失败原因
  cause: Schema.Defect(),
}) {}

// packages：已加载模块的进程级缓存（入口点 -> Promise）
const packages = new Map<string, Promise<unknown>>()
// builtins：内置提供商包的惰性导入表（包名 -> 动态 import 函数）
const builtins = new Map<string, () => Promise<unknown>>([
  // 阿里云（alibaba）默认入口点
  ["@opencode/ai/providers/alibaba", () => import("@opencode/ai/providers/alibaba")],
  // 阿里云 chat 入口点
  ["@opencode/ai/providers/alibaba/chat", () => import("@opencode/ai/providers/alibaba/chat")],
  // 阿里云 messages 入口点
  ["@opencode/ai/providers/alibaba/messages", () => import("@opencode/ai/providers/alibaba/messages")],
  // 阿里云 responses 入口点
  ["@opencode/ai/providers/alibaba/responses", () => import("@opencode/ai/providers/alibaba/responses")],
  // 阿里云 images 入口点
  ["@opencode/ai/providers/alibaba/images", () => import("@opencode/ai/providers/alibaba/images")],
  ["@opencode/ai/providers/alibaba/embeddings", () => import("@opencode/ai/providers/alibaba/embeddings")],
  ["@opencode/ai/providers/amazon-bedrock", () => import("@opencode/ai/providers/amazon-bedrock")],
  // Amazon Bedrock mantle 入口点
  ["@opencode/ai/providers/amazon-bedrock/mantle", () => import("@opencode/ai/providers/amazon-bedrock/mantle")],
  // Amazon Bedrock mantle chat 入口点
  [
    "@opencode/ai/providers/amazon-bedrock/mantle/chat",
    () => import("@opencode/ai/providers/amazon-bedrock/mantle/chat"),
  ],
  // Amazon Bedrock mantle messages 入口点
  [
    "@opencode/ai/providers/amazon-bedrock/mantle/messages",
    () => import("@opencode/ai/providers/amazon-bedrock/mantle/messages"),
  ],
  // Amazon Bedrock mantle responses 入口点
  [
    "@opencode/ai/providers/amazon-bedrock/mantle/responses",
    () => import("@opencode/ai/providers/amazon-bedrock/mantle/responses"),
  ],
  // Anthropic 默认入口点
  ["@opencode/ai/providers/anthropic", () => import("@opencode/ai/providers/anthropic")],
  // Anthropic 兼容入口点
  ["@opencode/ai/providers/anthropic-compatible", () => import("@opencode/ai/providers/anthropic-compatible")],
  // Azure 默认入口点
  ["@opencode/ai/providers/azure", () => import("@opencode/ai/providers/azure")],
  // Azure chat 入口点
  ["@opencode/ai/providers/azure/chat", () => import("@opencode/ai/providers/azure/chat")],
  // Azure responses 入口点
  ["@opencode/ai/providers/azure/responses", () => import("@opencode/ai/providers/azure/responses")],
  // Azure images 入口点
  ["@opencode/ai/providers/azure/images", () => import("@opencode/ai/providers/azure/images")],
  ["@opencode/ai/providers/azure/embeddings", () => import("@opencode/ai/providers/azure/embeddings")],
  ["@opencode/ai/providers/azure/messages", () => import("@opencode/ai/providers/azure/messages")],
  // Baseten 默认入口点
  ["@opencode/ai/providers/baseten", () => import("@opencode/ai/providers/baseten")],
  // Baseten 决策（decisions）入口点
  ["@opencode/ai/providers/baseten/decisions", () => import("@opencode/ai/providers/baseten/decisions")],
  // Cerebras 默认入口点
  ["@opencode/ai/providers/cerebras", () => import("@opencode/ai/providers/cerebras")],
  // Cloudflare AI Gateway 默认入口点
  ["@opencode/ai/providers/cloudflare-ai-gateway", () => import("@opencode/ai/providers/cloudflare-ai-gateway")],
  // Cloudflare AI Gateway 决策入口点
  [
    "@opencode/ai/providers/cloudflare-ai-gateway/decisions",
    () => import("@opencode/ai/providers/cloudflare-ai-gateway/decisions"),
  ],
  // Cloudflare Workers AI 默认入口点
  ["@opencode/ai/providers/cloudflare-workers-ai", () => import("@opencode/ai/providers/cloudflare-workers-ai")],
  // Cloudflare Workers AI 决策入口点
  [
    "@opencode/ai/providers/cloudflare-workers-ai/decisions",
    () => import("@opencode/ai/providers/cloudflare-workers-ai/decisions"),
  ],
  // Cloudflare Workers AI 图像入口点
  [
    "@opencode/ai/providers/cloudflare-workers-ai/images",
    () => import("@opencode/ai/providers/cloudflare-workers-ai/images"),
  ],
  // Cohere 默认入口点
  ["@opencode/ai/providers/cohere", () => import("@opencode/ai/providers/cohere")],
  // Cohere chat 入口点
  ["@opencode/ai/providers/cohere/chat", () => import("@opencode/ai/providers/cohere/chat")],
  ["@opencode/ai/providers/cohere/embeddings", () => import("@opencode/ai/providers/cohere/embeddings")],
  ["@opencode/ai/providers/deepinfra", () => import("@opencode/ai/providers/deepinfra")],
  ["@opencode/ai/providers/deepinfra/embeddings", () => import("@opencode/ai/providers/deepinfra/embeddings")],
  ["@opencode/ai/providers/deepseek", () => import("@opencode/ai/providers/deepseek")],
  // DigitalOcean 默认入口点
  ["@opencode/ai/providers/digitalocean", () => import("@opencode/ai/providers/digitalocean")],
  // DigitalOcean 决策入口点
  ["@opencode/ai/providers/digitalocean/decisions", () => import("@opencode/ai/providers/digitalocean/decisions")],
  ["@opencode/ai/providers/digitalocean/embeddings", () => import("@opencode/ai/providers/digitalocean/embeddings")],
  ["@opencode/ai/providers/digitalocean/images", () => import("@opencode/ai/providers/digitalocean/images")],
  // DigitalOcean responses 入口点
  ["@opencode/ai/providers/digitalocean/responses", () => import("@opencode/ai/providers/digitalocean/responses")],
  // Fireworks 默认入口点
  ["@opencode/ai/providers/fireworks", () => import("@opencode/ai/providers/fireworks")],
  ["@opencode/ai/providers/fireworks/embeddings", () => import("@opencode/ai/providers/fireworks/embeddings")],
  ["@opencode/ai/providers/google", () => import("@opencode/ai/providers/google")],
  ["@opencode/ai/providers/google/decisions", () => import("@opencode/ai/providers/google/decisions")],
  ["@opencode/ai/providers/google/interactions", () => import("@opencode/ai/providers/google/interactions")],
  ["@opencode/ai/providers/google/embeddings", () => import("@opencode/ai/providers/google/embeddings")],
  ["@opencode/ai/providers/google/images", () => import("@opencode/ai/providers/google/images")],
  // Google Vertex 默认入口点
  ["@opencode/ai/providers/google-vertex", () => import("@opencode/ai/providers/google-vertex")],
  // Google Vertex chat 入口点
  ["@opencode/ai/providers/google-vertex/chat", () => import("@opencode/ai/providers/google-vertex/chat")],
  // Google Vertex gemini 入口点
  ["@opencode/ai/providers/google-vertex/gemini", () => import("@opencode/ai/providers/google-vertex/gemini")],
  // Google Vertex interactions 入口点
  [
    "@opencode/ai/providers/google-vertex/interactions",
    () => import("@opencode/ai/providers/google-vertex/interactions"),
  ],
  // Google Vertex messages 入口点
  ["@opencode/ai/providers/google-vertex/messages", () => import("@opencode/ai/providers/google-vertex/messages")],
  // Google Vertex mistral 入口点
  ["@opencode/ai/providers/google-vertex/mistral", () => import("@opencode/ai/providers/google-vertex/mistral")],
  // Google Vertex responses 入口点
  ["@opencode/ai/providers/google-vertex/responses", () => import("@opencode/ai/providers/google-vertex/responses")],
  ["@opencode/ai/providers/google-vertex/embeddings", () => import("@opencode/ai/providers/google-vertex/embeddings")],
  ["@opencode/ai/providers/google-vertex/images", () => import("@opencode/ai/providers/google-vertex/images")],
  // Google Vertex 独立 messages 包入口点
  ["@opencode/ai/providers/google-vertex-messages", () => import("@opencode/ai/providers/google-vertex-messages")],
  // Groq 默认入口点
  ["@opencode/ai/providers/groq", () => import("@opencode/ai/providers/groq")],
  // Meta 默认入口点
  ["@opencode/ai/providers/meta", () => import("@opencode/ai/providers/meta")],
  // Meta chat 入口点
  ["@opencode/ai/providers/meta/chat", () => import("@opencode/ai/providers/meta/chat")],
  // Meta 图像入口点
  ["@opencode/ai/providers/meta/images", () => import("@opencode/ai/providers/meta/images")],
  // Meta messages 入口点
  ["@opencode/ai/providers/meta/messages", () => import("@opencode/ai/providers/meta/messages")],
  // Meta responses 入口点
  ["@opencode/ai/providers/meta/responses", () => import("@opencode/ai/providers/meta/responses")],
  // MiniMax 默认入口点
  ["@opencode/ai/providers/minimax", () => import("@opencode/ai/providers/minimax")],
  // MiniMax chat 入口点
  ["@opencode/ai/providers/minimax/chat", () => import("@opencode/ai/providers/minimax/chat")],
  // MiniMax 图像入口点
  ["@opencode/ai/providers/minimax/images", () => import("@opencode/ai/providers/minimax/images")],
  // MiniMax messages 入口点
  ["@opencode/ai/providers/minimax/messages", () => import("@opencode/ai/providers/minimax/messages")],
  // MiniMax responses 入口点
  ["@opencode/ai/providers/minimax/responses", () => import("@opencode/ai/providers/minimax/responses")],
  // Mistral 默认入口点
  ["@opencode/ai/providers/mistral", () => import("@opencode/ai/providers/mistral")],
  // Moonshot 默认入口点
  ["@opencode/ai/providers/moonshot", () => import("@opencode/ai/providers/moonshot")],
  // Moonshot chat 入口点
  ["@opencode/ai/providers/moonshot/chat", () => import("@opencode/ai/providers/moonshot/chat")],
  // Moonshot messages 入口点
  ["@opencode/ai/providers/moonshot/messages", () => import("@opencode/ai/providers/moonshot/messages")],
  // Moonshot responses 入口点
  ["@opencode/ai/providers/moonshot/responses", () => import("@opencode/ai/providers/moonshot/responses")],
  // OpenAI 默认入口点
  ["@opencode/ai/providers/openai", () => import("@opencode/ai/providers/openai")],
  // OpenAI chat 入口点
  ["@opencode/ai/providers/openai/chat", () => import("@opencode/ai/providers/openai/chat")],
  // OpenAI responses 入口点
  ["@opencode/ai/providers/openai/responses", () => import("@opencode/ai/providers/openai/responses")],
  // OpenAI 图像入口点
  ["@opencode/ai/providers/openai/images", () => import("@opencode/ai/providers/openai/images")],
  ["@opencode/ai/providers/openai/embeddings", () => import("@opencode/ai/providers/openai/embeddings")],
  ["@opencode/ai/providers/openai-compatible", () => import("@opencode/ai/providers/openai-compatible")],
  // OpenAI 兼容 responses 入口点
  [
    "@opencode/ai/providers/openai-compatible/responses",
    () => import("@opencode/ai/providers/openai-compatible/responses"),
  ],
  // OpenAI 兼容图像入口点
  ["@opencode/ai/providers/openai-compatible/images", () => import("@opencode/ai/providers/openai-compatible/images")],
  // OpenAI 兼容独立 responses 包入口点
  [
    "@opencode/ai/providers/openai-compatible/decisions",
    () => import("@opencode/ai/providers/openai-compatible/decisions"),
  ],
  [
    "@opencode/ai/providers/openai-compatible/embeddings",
    () => import("@opencode/ai/providers/openai-compatible/embeddings"),
  ],
  [
    "@opencode/ai/providers/openai-compatible-responses",
    () => import("@opencode/ai/providers/openai-compatible-responses"),
  ],
  // OpenCode 决策入口点
  ["@opencode/ai/providers/opencode/decisions", () => import("@opencode/ai/providers/opencode/decisions")],
  // OpenRouter 默认入口点
  ["@opencode/ai/providers/openrouter", () => import("@opencode/ai/providers/openrouter")],
  // OpenRouter 决策入口点
  ["@opencode/ai/providers/openrouter/decisions", () => import("@opencode/ai/providers/openrouter/decisions")],
  ["@opencode/ai/providers/openrouter/embeddings", () => import("@opencode/ai/providers/openrouter/embeddings")],
  ["@opencode/ai/providers/openrouter/images", () => import("@opencode/ai/providers/openrouter/images")],
  // OpenRouter responses 入口点
  ["@opencode/ai/providers/openrouter/responses", () => import("@opencode/ai/providers/openrouter/responses")],
  // TogetherAI 默认入口点
  ["@opencode/ai/providers/togetherai", () => import("@opencode/ai/providers/togetherai")],
  // Typesafe AI 决策入口点
  ["@opencode/ai/providers/typesafe-ai/decisions", () => import("@opencode/ai/providers/typesafe-ai/decisions")],
  // Venice 默认入口点
  ["@opencode/ai/providers/venice", () => import("@opencode/ai/providers/venice")],
  // Venice responses 入口点
  ["@opencode/ai/providers/venice/responses", () => import("@opencode/ai/providers/venice/responses")],
  // Vercel AI Gateway 默认入口点
  ["@opencode/ai/providers/vercel-ai-gateway", () => import("@opencode/ai/providers/vercel-ai-gateway")],
  // Vercel AI Gateway chat 入口点
  ["@opencode/ai/providers/vercel-ai-gateway/chat", () => import("@opencode/ai/providers/vercel-ai-gateway/chat")],
  // Vercel AI Gateway messages 入口点
  [
    "@opencode/ai/providers/vercel-ai-gateway/messages",
    () => import("@opencode/ai/providers/vercel-ai-gateway/messages"),
  ],
  // Vercel AI Gateway responses 入口点
  [
    "@opencode/ai/providers/vercel-ai-gateway/responses",
    () => import("@opencode/ai/providers/vercel-ai-gateway/responses"),
  ],
  // Vercel AI Gateway 决策入口点
  [
    "@opencode/ai/providers/vercel-ai-gateway/decisions",
    () => import("@opencode/ai/providers/vercel-ai-gateway/decisions"),
  ],
  // Vercel AI Gateway 图像入口点
  ["@opencode/ai/providers/vercel-ai-gateway/images", () => import("@opencode/ai/providers/vercel-ai-gateway/images")],
  [
    "@opencode/ai/providers/vercel-ai-gateway/embeddings",
    () => import("@opencode/ai/providers/vercel-ai-gateway/embeddings"),
  ],
  ["@opencode/ai/providers/xai", () => import("@opencode/ai/providers/xai")],
  // xAI 图像入口点
  ["@opencode/ai/providers/xai/images", () => import("@opencode/ai/providers/xai/images")],
  // Z.ai 默认入口点
  ["@opencode/ai/providers/zai", () => import("@opencode/ai/providers/zai")],
  // Z.ai chat 入口点
  ["@opencode/ai/providers/zai/chat", () => import("@opencode/ai/providers/zai/chat")],
  // Z.ai 图像入口点
  ["@opencode/ai/providers/zai/images", () => import("@opencode/ai/providers/zai/images")],
  // Z.ai Coding Plan 默认入口点
  ["@opencode/ai/providers/zai-coding-plan", () => import("@opencode/ai/providers/zai-coding-plan")],
  // Z.ai Coding Plan chat 入口点
  ["@opencode/ai/providers/zai-coding-plan/chat", () => import("@opencode/ai/providers/zai-coding-plan/chat")],
  // Z.ai Coding Plan messages 入口点
  ["@opencode/ai/providers/zai-coding-plan/messages", () => import("@opencode/ai/providers/zai-coding-plan/messages")],
  // Z.ai Coding Plan responses 入口点
  [
    "@opencode/ai/providers/zai-coding-plan/responses",
    () => import("@opencode/ai/providers/zai-coding-plan/responses"),
  ],
])

/** Native `@opencode/ai/providers/*` entrypoints bundled with Core and loadable by name from config. */
// builtinPackages：随核心打包的原生入口点集合（可由配置按名加载）
export const builtinPackages: ReadonlySet<string> = new Set(builtins.keys())

// loadPackage：按说明符加载提供商包——内置表、运行时解析、必要时 npm 安装
export const loadPackage = Effect.fn("Provider.loadPackage")(function* (input: string, npm?: Npm.Interface) {
  const specifier = AISDKNative.packageName(input)
  const builtin = builtins.get(specifier)
  // 内置存在则直接导入
  if (builtin) return yield* importPackage(specifier, specifier, builtin)
  // 运行时解析模块说明符：file:// 与 @opencode/ai/ 前缀直接用原值
  const resolved = yield* Effect.sync(() => {
    // 这两类不需要 import.meta.resolve
    if (specifier.startsWith("file://") || specifier.startsWith("@opencode/ai/")) return specifier
    // 其他说明符尝试解析；失败返回 undefined
    try {
      // 用运行时的 resolve 解析
      return import.meta.resolve(specifier)
    } catch {
      // 解析失败
      return undefined
    }
  })
  // 已解析到入口点则导入
  if (resolved) return yield* importPackage(specifier, resolved)
  // 没有 npm 安装能力时直接报错
  if (!npm) {
    // 抛 LoadError
    return yield* new LoadError({
      // 包名
      package: specifier,
      // 原因：未安装
      cause: new Error(`Provider package ${specifier} is not installed`),
    })
  }
  // 计算 npm 包根名：scope 包取前两段，普通包取首段
  const parts = specifier.split("/")
  // scope 包（@xxx/yyy）取两段拼接
  const root = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier)
  // 用 npm 安装包根
  const installed = yield* npm.add(root).pipe(Effect.mapError((cause) => new LoadError({ package: specifier, cause })))
  // 在安装目录内解析入口点
  const entrypoint = yield* Effect.try({
    // 尝试解析
    try: () => resolveModule(specifier, installed.directory),
    // 失败转 LoadError
    catch: (cause) => new LoadError({ package: specifier, cause }),
  })
  // 导入入口点
  return yield* importPackage(specifier, entrypoint)
})

// settingsKeys：Provider.Settings 模式的全部字段名
const settingsKeys = Struct.keys(Provider.Settings.schema.fields)
// providerOnlyKeys：仅属于供应商（模型不继承）的设置键
const providerOnlyKeys = settingsKeys.filter((key) => !(key in Model.Settings.schema.fields))

/** The provider options: every settings key OpenCode doesn't read itself. */
// nativeSettings：返回供应商的"原生"选项——OpenCode 自己不读取的全部设置键
export function nativeSettings(settings: Settings) {
  // 剔除 OpenCode 认识的键后返回
  return Struct.omit(settings, settingsKeys)
}

/** Settings a model inherits from its provider. */
// modelSettings：模型可从供应商继承的那部分设置
export function modelSettings(settings: Settings | undefined) {
  // 剔除仅供应商专属的键；settings 缺失时返回 undefined
  return settings && Struct.omit(settings, providerOnlyKeys)
}

// decodeTimeout：超时设置解码器（Option）
const decodeTimeout = Schema.decodeUnknownOption(HttpTimeout)

/** Applied to `headerTimeout` when provider settings leave it unset or invalid. */
// 默认响应头超时：300 秒
export const DEFAULT_TIMEOUT_MS = 300_000

/**
 * Applied to `chunkTimeout` when provider settings leave it unset or invalid. Some providers, such as DeepSeek, have
 * specifically asked clients to allow at least 15 minutes, because their models can stream nothing for minutes while
 * they reason.
 */
// 默认块间超时：900 秒。DeepSeek 等供应商明确要求至少允许 15 分钟——
// 推理型模型可能数分钟内不输出任何流内容。
export const DEFAULT_CHUNK_TIMEOUT_MS = 900_000

/** One timeout setting without a default; invalid values are dropped. */
// timeout：读取单个超时设置（无默认值；无效值被丢弃）
export function timeout(value: unknown) {
  // 解码失败时返回 undefined
  return Option.getOrUndefined(decodeTimeout(value))
}

/** Request timeouts from provider settings, resolved for every route. `timeout` has no default. */
// timeouts：从设置解析三个请求超时；仅 timeout 无默认
export function timeouts(settings: Readonly<Record<string, unknown>>) {
  // 返回解析后的超时组
  return {
    // 总超时：无默认
    timeout: timeout(settings.timeout),
    // 首字节超时：默认 300 秒
    headerTimeout: timeout(settings.headerTimeout) ?? DEFAULT_TIMEOUT_MS,
    // 块间超时：默认 900 秒
    chunkTimeout: timeout(settings.chunkTimeout) ?? DEFAULT_CHUNK_TIMEOUT_MS,
  }
}

// decodeEncoding：请求体编码解码器（Option）
const decodeEncoding = Schema.decodeUnknownOption(Provider.Encoding)

/** Request body encoding from provider or model settings; invalid values are dropped. */
// encoding：读取请求体编码设置；无效值被丢弃
export function encoding(settings: Readonly<Record<string, unknown>>) {
  // 解码失败返回 undefined
  return Option.getOrUndefined(decodeEncoding(settings.encoding))
}

export const Request = Provider.Request
// 导出 Request 类型别名
export type Request = Provider.Request

// 导出 Compaction：上下文压缩（compaction）配置定义
export const Compaction = Provider.Compaction
// 导出 Compaction 类型别名
export type Compaction = Provider.Compaction

// 导出 Cache：提示缓存（cache）配置定义
export const Cache = Provider.Cache
// 导出 Cache 类型别名
export type Cache = Provider.Cache

// 导出 Transport：传输（transport）配置定义
export const Transport = Provider.Transport
// 导出 Transport 类型别名
export type Transport = Provider.Transport

// 导出 Settings：供应商/模型设置模式
export const Settings = Provider.Settings
// 导出 Settings 类型别名
export type Settings = Provider.Settings

// 导出 Info：供应商信息模式
export const Info = Provider.Info
// 导出 Info 类型别名
export type Info = Provider.Info

// MutableInfo：深层可变的供应商信息（编辑用）
export type MutableInfo = DeepMutable<Info>

// 转发导出 @opencode/schema/provider 的 Event（Updated 等）
export { Event } from "@opencode/schema/provider"

/** Provider metadata owns its drafts; model definitions remain immutable inputs. */
// Definition：一份供应商定义——供应商元数据（可编辑草稿）+ 只读的模型定义集合
export type Definition = {
  // 供应商信息
  readonly provider: Info
  // 该供应商的模型映射（只读）
  readonly models: ReadonlyMap<Model.ID, Model.Info>
  // 来源连接信息（可选，OAuth/集成）
  readonly sourceConnection?: IntegrationConnection.Info
}

// Editor：状态变换期间使用的供应商编辑器
export interface Editor {
  // 列出全部定义
  readonly list: () => readonly Definition[]
  // 按 ID 取定义
  readonly get: (providerID: ID) => Definition | undefined
  // 新增一份定义（信息、模型列表、来源连接）
  readonly add: (definition: {
    // 供应商信息
    readonly info: Info
    // 模型列表
    readonly models: readonly Model.Info[]
    // 来源连接（可选）
    readonly sourceConnection?: IntegrationConnection.Info
  }) => void
  // 以回调更新供应商元数据
  readonly update: (providerID: ID, update: (provider: MutableInfo) => void) => void
  // 删除供应商
  readonly remove: (providerID: ID) => void
  // 模型集合的编辑操作
  readonly models: {
    // 整体替换模型列表
    readonly set: (providerID: ID, models: readonly Model.Info[]) => void
    // 以回调更新单个模型
    readonly update: (providerID: ID, modelID: Model.ID, update: (model: DeepMutable<Model.Info>) => void) => void
    // 删除单个模型
    readonly remove: (providerID: ID, modelID: Model.ID) => void
  }
}

// Snapshot：供应商状态快照——全部定义、可用定义、可用供应商信息
export interface Snapshot {
  // 按 ID 索引的全部定义
  readonly records: ReadonlyMap<ID, Definition>
  // 可用的定义列表
  readonly available: readonly Definition[]
  // 可用供应商的信息列表
  readonly providers: readonly Info[]
}

// Interface：Provider 服务对外接口，支持状态变换
export interface Interface extends State.Transformable<Editor> {
  // 按 ID 取供应商信息（冻结只读）
  readonly get: (providerID: ID) => Effect.Effect<Info | undefined>
  // 列出全部供应商信息
  readonly all: () => Effect.Effect<readonly Info[]>
  // 列出可用供应商信息
  readonly available: () => Effect.Effect<readonly Info[]>
  /** Internal definition/access snapshot; raw model inventories never cross the HTTP API. */
  // snapshot：内部定义/可用性快照；原始模型清单绝不跨越 HTTP API
  readonly snapshot: () => Effect.Effect<Snapshot>
}

// 定义 Provider 服务标识：标签 "@opencode/Provider"
export class Service extends Context.Service<Service, Interface>()("@opencode/Provider") {}

// Every location references the same index for a shared immutable definition array.
// definitions：模型数组 -> 按 ID 索引的模型映射缓存（弱引用），
// 让每个位置引用同一份不可变定义数组。
const definitions = new WeakMap<readonly Model.Info[], Map<ID, ReadonlyMap<Model.ID, Model.Info>>>()
// index：为指定供应商构建（或复用）模型映射
function index(providerID: ID, models: readonly Model.Info[]) {
  // 取该模型数组已有的索引表
  const indexes = definitions.get(models) ?? new Map<ID, ReadonlyMap<Model.ID, Model.Info>>()
  // 已有该供应商的映射则直接复用
  const cached = indexes.get(providerID)
  // 命中缓存返回
  if (cached) return cached
  // Model shares these definitions without copying, so a foreign definition takes this provider's identity here.
  // 构建映射：模型共享定义不复制；外来定义（providerID 不同）在此赋予本供应商身份
  const result = freeze(
    new Map(models.map((model) => [model.id, model.providerID === providerID ? model : { ...model, providerID }])),
    true,
  )
  // 登记到索引表
  indexes.set(providerID, result)
  // 写回弱映射
  definitions.set(models, indexes)
  // 返回映射
  return result
}

// layer：Provider 服务的层实现
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 获取事件总线服务
    const bus = yield* Bus.Service
    // 获取集成服务（连接与修订号）
    const integrations = yield* Integration.Service
    // 获取位置服务（事件携带目录/工作区）
    const location = yield* Location.Service
    // 创建状态容器：ID -> {供应商草稿, 模型映射, 来源连接}
    const state = State.create<
      Map<
        ID,
        {
          // 供应商元数据草稿
          provider: MutableInfo
          // 模型映射
          models: ReadonlyMap<Model.ID, Model.Info>
          // 来源连接（可选）
          sourceConnection?: IntegrationConnection.Info
        }
      >,
      Editor
    >({
      // 状态名
      name: "provider",
      // 初始：空映射
      initial: () => new Map(),
      // editor：构建编辑视图（写时复制语义）
      editor: (records) => {
        // maps：本编辑器已接管的模型映射集合
        const maps = new WeakSet<ReadonlyMap<Model.ID, Model.Info>>()
        // models：本编辑器已接管的模型对象集合
        const models = new WeakSet<Model.Info>()
        // entry：取（或创建）供应商条目
        const entry = (id: ID) => {
          // 已存在直接返回
          const current = records.get(id)
          // 命中返回
          if (current) return current
          // 新建：空供应商信息 + 空模型映射
          const added = { provider: Info.empty(id) as MutableInfo, models: new Map<Model.ID, Model.Info>() }
          // 登记到记录表
          records.set(id, added)
          // 映射标记为已接管
          maps.add(added.models)
          // 返回条目
          return added
        }
        // writable：取可写的模型映射（首次编辑时复制）
        const writable = (id: ID) => {
          // 先确保条目存在
          const record = entry(id)
          // 已是本编辑器拥有的映射直接返回
          if (maps.has(record.models)) return record.models as Map<Model.ID, Model.Info>
          // 复制一份
          const owned = new Map(record.models)
          // 替换条目内的映射
          record.models = owned
          // 标记为已接管
          maps.add(owned)
          // 返回可写映射
          return owned
        }
        // 返回编辑器
        return {
          // list：列出全部定义
          list: () => Array.from(records.values()),
          // get：按 ID 取定义
          get: (id) => records.get(id),
          add: (definition) => {
            // 新增定义：深拷贝供应商信息，模型数组建共享索引
            records.set(definition.info.id, {
              // 结构化深拷贝供应商信息
              provider: structuredClone(definition.info) as MutableInfo,
              // 构建模型索引
              models: index(definition.info.id, definition.models),
              // 透传来源连接
              sourceConnection: definition.sourceConnection,
            })
          },
          update: (id, update) => {
            // 确保条目存在
            const record = entry(id)
            // 执行更新回调
            update(record.provider)
            // 强制回写 ID
            record.provider.id = id
            // 用 AISDKNative 重写解析字段
            AISDKNative.rewrite(record.provider, {
              builtins: builtinPackages,
              specifier: record.provider.package,
              // 供应商 ID
              providerID: id,
              // 规范名
              canonical: record.provider.canonical,
            })
          },
          remove: (id) => {
            // 删除供应商条目
            records.delete(id)
          },
          // models：模型集合的操作
          models: {
            set: (id, values) => {
              // 整体替换模型映射（建共享索引）
              entry(id).models = index(id, values)
            },
            update: (providerID, modelID, update) => {
              // 确保供应商条目存在
              const record = entry(providerID)
              // 取可写映射
              const target = writable(providerID)
              // 取当前模型定义
              const current = target.get(modelID)
              // An earlier add/set can publish and freeze an owned model within this fold.
              // 本折叠中较早的 add/set 可能已发布并冻结了模型：未冻结的已拥有对象直接改，
              // 冻结的深拷贝，不存在则用默认模板。
              const model = // An earlier add/set can publish and freeze an owned model within this fold.
                (
                  current && models.has(current) && !Object.isFrozen(current)
                    // 已拥有且未冻结：就地使用
                    ? current
                    : current
                      ? structuredClone(current)
                      : Model.Info.default(providerID, modelID)
                ) as DeepMutable<Model.Info>
              // 执行更新回调
              update(model)
              // 强制回写模型 ID
              model.id = modelID
              // 强制回写供应商 ID
              model.providerID = providerID
              // 用 AISDKNative 重写解析字段
              AISDKNative.rewrite(model, {
                builtins: builtinPackages,
                specifier: model.package ?? record.provider.package,
                // 供应商 ID
                providerID,
                // 规范名：模型自带优先，其次供应商
                canonical: model.canonical ?? record.provider.canonical,
                // 原始模型 ID
                modelID: model.modelID ?? modelID,
              })
              // 标记为已拥有
              models.add(model)
              // 写回映射
              target.set(modelID, model)
            },
            remove: (providerID, modelID) => {
              // 供应商不存在时忽略
              if (!records.has(providerID)) return
              // 从可写映射删除模型
              writable(providerID).delete(modelID)
            },
          },
        }
      },
      // notify：通知回调指向下文的 notify
      notify: () => notify,
    })
    // Registrations may outlive a borrowed service layer; their later disposal must
    // not query dependencies that have already closed.
    // 注册可能比借来的服务层活得更久；随后的销毁不得查询已关闭的依赖。
    yield* Effect.addFinalizer(() => State.shutdown(state.reload()))
    // cached：上次快照的缓存（记录引用 + 快照值）
    let cached: { records: Snapshot["records"]; value: Snapshot } | undefined
    // snapshot：构建一致性快照（含可用性过滤）
    const snapshot = Effect.fn("Provider.snapshot")(function* () {
      // 循环重试直到读取一致
      while (true) {
        // 读取集成修订号
        const revision = integrations.revision()
        // 读取状态记录
        const records = state.get()
        // Connection presence decides availability; resolving OAuth tokens belongs to execution.
        // 列出集成连接；连接的有无决定可用性，OAuth 令牌解析属于执行阶段
        const connections = yield* integrations.list()
        // Either fold can disable a plugin that also contributed to the other domain.
        // 任一折叠都可能禁用同时贡献了另一领域的插件——输入变化时重试
        if (revision !== integrations.revision() || records !== state.get()) continue
        // 按 ID 索引连接
        const byID = new Map(connections.map((integration) => [integration.id, integration]))
        // available：逐条过滤可用定义
        const available = Array.from(records.values()).filter((record) => {
          // 显式禁用的直接排除
          if (record.provider.activation === "disabled") return false
          // 查找对应的集成连接（默认用供应商 ID 作为集成 ID）
          const integration = byID.get(record.provider.integrationID ?? Integration.ID.make(record.provider.id))
          // Never combine the previous account's discovered endpoints/models with a new connection.
          // 有来源连接但与当前连接键不同（换账号）时排除——旧账号发现的端点/模型绝不与新连接混用
          if (
            record.sourceConnection &&
            IntegrationConnection.key(record.sourceConnection) !==
              IntegrationConnection.key(integration?.connections[0])
          )
            // 排除
            return false
          // 显式启用直接可用
          if (record.provider.activation === "enabled") return true
          // 集成有连接时可用
          if (integration?.connections.length) return true
          // 无集成 ID 且集成本身不存在（纯配置型供应商）时可用
          return record.provider.integrationID === undefined && !integration
        })
        // A credential change that leaves the same definitions available is not a catalog change.
        // 可用定义集合完全一致（凭证切换未改变可用性）时不算目录变化，复用缓存
        if (
          cached?.records === records &&
          cached.value.available.length === available.length &&
          cached.value.available.every((record, index) => record === available[index])
        )
          // 返回旧快照
          return cached.value
        // 构建并冻结新快照
        const value = freeze({ records, available, providers: available.map((record) => record.provider) }, true)
        // 记录缓存
        cached = { records, value }
        // 返回快照
        return value
      }
    })
    // published：上次已广播的快照
    let published: Snapshot | undefined
    // notify：快照变化时发布供应商更新事件
    const notify: Effect.Effect<void> = Effect.gen(function* () {
      // 读取最新快照
      const value = yield* snapshot()
      // 未变化则不广播
      if (value === published) return
      // 记录已广播快照
      published = value
      // 发布 Updated 事件
      yield* bus.publish(
        // 事件类型
        Provider.Event.Updated,
        // 空负载
        {},
        {
          // 携带目录与工作区
          location: { directory: location.directory, workspaceID: location.workspaceID },
        },
      )
    })
    // 订阅集成更新与凭证切换事件：触发重新通知
    yield* bus.subscribe([Integration.Event.Updated, Credential.Event.Switched]).pipe(
      // 每条事件执行 notify
      Stream.runForEach(() => notify),
      // 后台立即启动
      Effect.forkScoped({ startImmediately: true }),
    )
    // 返回服务实现
    return Service.of({
      // transform：转发状态变换
      transform: state.transform,
      // reload：转发状态重载
      reload: state.reload,
      // get：按 ID 取冻结的供应商信息
      get: Effect.fn("Provider.get")((id) => Effect.sync(() => freeze(state.get().get(id)?.provider, true))),
      // all：列出全部冻结的供应商信息
      all: Effect.fn("Provider.all")(() =>
        Effect.sync(() => Array.from(state.get().values(), (record) => freeze(record.provider, true))),
      ),
      // available：返回可用供应商信息
      available: Effect.fn("Provider.available")(() => snapshot().pipe(Effect.map((value) => value.providers))),
      // snapshot：完整快照
      snapshot,
    })
  }),
)

// 导出 node：把 Provider 服务挂到位置节点，依赖总线/集成/位置
export const node = makeLocationNode({ service: Service, layer, deps: [Bus.node, Integration.node, Location.node] })

// importPackage：导入入口点并校验导出形态（进程内按入口点去重）
const importPackage = Effect.fn("Provider.importPackage")(function* (
  // 原始说明符（错误信息用）
  specifier: string,
  // 入口点路径（缓存键）
  entrypoint: string,
  // 加载函数（默认动态 import）
  load = () => importModule(entrypoint),
) {
  // 导入模块（进程内缓存同一入口点的 Promise，避免重复加载）
  const module = yield* Effect.tryPromise({
    // 尝试加载
    try: () => {
      // 已有缓存直接复用
      const existing = packages.get(entrypoint)
      // 命中返回
      if (existing) return existing
      // 现场加载
      const loaded = load()
      // 登记缓存
      packages.set(entrypoint, loaded)
      // 返回 Promise
      return loaded
    },
    // 加载失败转 LoadError
    catch: (cause) => new LoadError({ package: specifier, cause }),
  })
  // 校验模块形态：必须是对象且导出 model 函数
  if (typeof module !== "object" || module === null || typeof (module as { model?: unknown }).model !== "function") {
    // 形态不对时抛 LoadError
    return yield* new LoadError({
      // 包名
      package: specifier,
      // 原因说明
      cause: new Error(`Provider package ${specifier} does not export model(modelID, settings)`),
    })
  }
  // 返回类型断言后的定义
  return module as ProviderPackage.Definition
})
