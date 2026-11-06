// 引入 AI SDK 的自定义 fetch 函数类型
import type { FetchFunction } from "@ai-sdk/provider-utils"

// OpenAI 兼容提供商的通用配置类型
export type OpenAIConfig = {
  // 提供商名称标识
  provider: string
  // 根据模型 ID 与 API 路径拼接请求 URL
  url: (options: { modelId: string; path: string }) => string
  // 返回请求头的工厂函数（值为 undefined 表示移除该头）
  headers: () => Record<string, string | undefined>
  // 可选：自定义 fetch 实现
  fetch?: FetchFunction
  // 可选：自定义 ID 生成器
  generateId?: () => string
  /**
   * File ID prefixes used to identify file IDs in Responses API.
   * When undefined, all file data is treated as base64 content.
   *
   * Examples:
   * - OpenAI: ['file-'] for IDs like 'file-abc123'
   * - Azure OpenAI: ['assistant-'] for IDs like 'assistant-abc123'
   */
  // 可选：用于识别 Responses API 中文件 ID 的前缀集合；未定义时所有文件数据按 base64 内容处理
  fileIdPrefixes?: readonly string[]
}
