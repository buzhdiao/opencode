// 引入 AI SDK 的语言模型完成原因（finish reason）类型
import type { LanguageModelV3FinishReason } from "@ai-sdk/provider"

// 将 OpenAI Responses API 的完成原因映射为 AI SDK 的统一完成原因
export function mapOpenAIResponseFinishReason({
  finishReason,
  hasFunctionCall,
}: {
  // 原始完成原因字符串（可能缺失）
  finishReason: string | null | undefined
  // flag that checks if there have been client-side tool calls (not executed by openai)
  hasFunctionCall: boolean
}): LanguageModelV3FinishReason["unified"] {
  // 按原始完成原因逐类映射
  switch (finishReason) {
    // 原因缺失时：若有客户端侧工具调用则视为工具调用，否则视为正常停止
    case undefined:
    case null:
      return hasFunctionCall ? "tool-calls" : "stop"
    // 达到最大输出 token 数 -> 映射为“长度截断”
    case "max_output_tokens":
      return "length"
    // 命中内容过滤
    case "content_filter":
      return "content-filter"
    // 其他未知原因：有工具调用则映射为工具调用，否则归为 other
    default:
      return hasFunctionCall ? "tool-calls" : "other"
  }
}
