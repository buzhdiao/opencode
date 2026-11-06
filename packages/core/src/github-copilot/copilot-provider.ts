// 仅作类型导入：AI SDK V3 语言模型接口
import type { LanguageModelV3 } from "@ai-sdk/provider"
// 从 provider-utils 导入工具：URL 去尾斜杠、附加 User-Agent 后缀、fetch 类型
import { type FetchFunction, withoutTrailingSlash, withUserAgentSuffix } from "@ai-sdk/provider-utils"
// 导入 OpenAI 兼容聊天模型实现
import { OpenAICompatibleChatLanguageModel } from "./chat/openai-compatible-chat-language-model.js"
// 导入 OpenAI Responses 协议模型实现
import { OpenAIResponsesLanguageModel } from "./responses/openai-responses-language-model.js"

// 原有注释：导入版本号或在此定义
// Import the version or define it
// VERSION：provider 的版本号（用于 User-Agent）
const VERSION = "0.1.0"

// OpenaiCompatibleModelId：模型 ID 类型（当前就是字符串）
export type OpenaiCompatibleModelId = string

// OpenaiCompatibleProviderSettings：创建 provider 实例的设置项
export interface OpenaiCompatibleProviderSettings {
  /**
   * API key for authenticating requests.
   *
   * 中文说明：用于请求鉴权的 API key。
   */
  apiKey?: string

  /**
   * Base URL for the OpenAI Compatible API calls.
   *
   * 中文说明：OpenAI 兼容 API 的基础 URL。
   */
  baseURL?: string

  /**
   * Name of the provider.
   *
   * 中文说明：provider 名称。
   */
  name?: string

  /**
   * Custom headers to include in the requests.
   *
   * 中文说明：附加到请求中的自定义请求头。
   */
  headers?: Record<string, string>

  /**
   * Custom fetch implementation.
   *
   * 中文说明：自定义 fetch 实现。
   */
  fetch?: FetchFunction
}

// OpenaiCompatibleProvider：provider 的可调用接口——直接调用、chat、responses、languageModel
export interface OpenaiCompatibleProvider {
  (modelId: OpenaiCompatibleModelId): LanguageModelV3
  // chat：创建聊天协议模型
  chat(modelId: OpenaiCompatibleModelId): LanguageModelV3
  // responses：创建 Responses 协议模型
  responses(modelId: OpenaiCompatibleModelId): LanguageModelV3
  // languageModel：创建默认语言模型（等同 chat）
  languageModel(modelId: OpenaiCompatibleModelId): LanguageModelV3

  // 原有注释：embeddingModel(modelId: any): EmbeddingModelV2
  // embeddingModel(modelId: any): EmbeddingModelV2

  // 原有注释：imageModel(modelId: any): ImageModelV2
  // imageModel(modelId: any): ImageModelV2
}

/**
 * Create an OpenAI Compatible provider instance.
 *
 * 中文说明：创建一个 OpenAI 兼容的 provider 实例。
 */
export function createOpenaiCompatible(options: OpenaiCompatibleProviderSettings = {}): OpenaiCompatibleProvider {
  // 规范化基础 URL：去掉尾部斜杠，缺省用 OpenAI 官方地址
  const baseURL = withoutTrailingSlash(options.baseURL ?? "https://api.openai.com/v1")

  // 规范化后为空：无法构造请求地址，直接报错
  if (!baseURL) {
    throw new Error("baseURL is required")
  }

  // 原有注释：合并请求头——默认头在前，用户覆盖在后
  // Merge headers: defaults first, then user overrides
  const headers = {
    // 原有注释：默认的 OpenAI 兼容请求头（可被用户覆盖）
    // Default OpenAI Compatible headers (can be overridden by user)
    // 配置了 apiKey 时附加 Bearer 鉴权头
    ...(options.apiKey && { Authorization: `Bearer ${options.apiKey}` }),
    // 用户自定义头（可覆盖默认值）
    ...options.headers,
  }

  // getHeaders：每次请求时生成带 User-Agent 后缀的请求头
  const getHeaders = () => withUserAgentSuffix(headers, `ai-sdk/openai-compatible/${VERSION}`)

  // createChatModel：构造聊天协议模型（provider 名称为 <name>.chat）
  const createChatModel = (modelId: OpenaiCompatibleModelId) => {
    return new OpenAICompatibleChatLanguageModel(modelId, {
      provider: `${options.name ?? "openai-compatible"}.chat`,
      headers: getHeaders,
      url: ({ path }) => `${baseURL}${path}`,
      fetch: options.fetch,
    })
  }

  // createResponsesModel：构造 Responses 协议模型（provider 名称为 <name>.responses）
  const createResponsesModel = (modelId: OpenaiCompatibleModelId) => {
    return new OpenAIResponsesLanguageModel(modelId, {
      provider: `${options.name ?? "openai-compatible"}.responses`,
      headers: getHeaders,
      url: ({ path }) => `${baseURL}${path}`,
      fetch: options.fetch,
    })
  }

  // createLanguageModel：默认语言模型工厂（当前等同聊天模型）
  const createLanguageModel = (modelId: OpenaiCompatibleModelId) => createChatModel(modelId)

  // provider：可调用对象——直接调用即创建聊天模型
  const provider = function (modelId: OpenaiCompatibleModelId) {
    return createChatModel(modelId)
  }

  // 把三个工厂挂到可调用对象上
  provider.languageModel = createLanguageModel
  provider.chat = createChatModel
  provider.responses = createResponsesModel

  // 以完整接口类型返回
  return provider as OpenaiCompatibleProvider
}
