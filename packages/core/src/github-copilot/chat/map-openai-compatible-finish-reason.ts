// 仅作类型导入：AI SDK V3 的完成原因类型
import type { LanguageModelV3FinishReason } from "@ai-sdk/provider"

// 导出 mapOpenAICompatibleFinishReason：把 OpenAI 兼容的 finish_reason 字符串映射为统一枚举
export function mapOpenAICompatibleFinishReason(
  finishReason: string | null | undefined,
): LanguageModelV3FinishReason["unified"] {
  // 按原始字符串分支映射
  switch (finishReason) {
    // 正常结束
    case "stop":
      return "stop"
    // 达到最大长度限制
    case "length":
      return "length"
    // 被内容安全策略拦截
    case "content_filter":
      return "content-filter"
    // 模型发起了函数/工具调用（两种旧式写法）
    case "function_call":
    case "tool_calls":
      return "tool-calls"
    // 其余未知值统一归为 other
    default:
      return "other"
  }
}
