// 导出 ClaudeAgentError 命名空间，供其他模块引用本文件内容
export * as ClaudeAgentError from "./claude-agent-error.js"

// 导入 Claude Agent SDK 的错误码、消息与限流信息类型
import type { SDKAssistantMessageError, SDKMessage, SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk"

// 构造一个错误收集器：把请求过程中（直到最终 result）的诊断信息累积起来，最后合成一个 Error。
// 仅出现用量警告并不代表请求失败；在此之前由 Claude Code 自行负责重试。
// Keep request-local diagnostics until the terminal result. A usage warning alone
// is not a failed request, and Claude Code owns any retries before this result.
export function make() {
  // 记录助手消息中出现的错误码
  let code: SDKAssistantMessageError | undefined
  // 记录被拒绝的限流信息（rate limit info）
  let rejected: SDKRateLimitInfo | undefined
  // 返回一个处理函数：逐条消费 SDK 消息，最终在 result 消息处产出 Error（若失败）
  return (message: SDKMessage): Error | undefined => {
    // 收到限流事件时：若状态为 rejected（被拒），记录该限流信息，否则清空
    if (message.type === "rate_limit_event") {
      rejected = message.rate_limit_info.status === "rejected" ? message.rate_limit_info : undefined
    }
    // 收到顶层（非工具子调用）助手消息且带错误时，记录该错误码
    if (message.type === "assistant" && message.parent_tool_use_id === null && message.error) code = message.error
    // 尚未到达最终 result 消息时，继续等待
    if (message.type !== "result") return

    // 成功子类型时取出 API 的 HTTP 状态码（可能为 0/undefined）
    const status = message.subtype === "success" ? (message.api_error_status ?? undefined) : undefined
    // 判断是否为 HTTP 层面的错误（状态码 >= 400）
    const httpError = status !== undefined && status >= 400
    // 子类型为 success、无错误且非 HTTP 错误：请求其实成功了，不返回 Error
    if (message.subtype === "success" && !message.is_error && !httpError) return
    // 取出结果文本：成功时是 result 字段，失败时把 errors 数组用换行拼接
    const result = (message.subtype === "success" ? message.result : message.errors.join("\n")).replaceAll(
      // 把 SDK 提示的 /login 指令替换为更通用的 claude 登录命令提示
      "Please run /login",
      "Run `claude auth login` in a terminal",
    )
    // 若是 5xx 级错误，给出服务端故障提示；否则使用原始结果文本
    const failure =
      status !== undefined && status >= 500
        ? (status === 529 ? "Anthropic is overloaded (529)." : `Anthropic returned HTTP ${status}.`) +
          " Claude Code exhausted its retries. Try again shortly."
        : result
    // 判断是否为限流：助手消息报了 rate_limit，或限流被拒且 HTTP 状态为 429
    const limited = code === "rate_limit" || (rejected && status === 429)
    // 把限流窗口类型中的下划线换成空格，便于阅读（如 "five_hour" -> "five hour"）
    const window = rejected?.rateLimitType?.replaceAll("_", " ")
    // 若确属限流且没有更具体的失败文本，生成“订阅额度已达上限”的提示（附窗口说明）
    const limit =
      limited && !failure ? `Claude Code subscription limit reached${window ? ` (${window})` : ""}.` : failure
    // 若有限流信息且记录了重置时间，附加具体的重置时间点（ISO 格式）
    const reset = limited && rejected?.resetsAt ? ` Resets at ${new Date(rejected.resetsAt * 1000).toISOString()}.` : ""
    // 若是计费错误，附加检查订阅与额外用量的提示
    const billing = code === "billing_error" ? " Check your Claude plan and extra-usage settings." : ""
    // 拼接最终的错误文本
    const text = limit + reset + billing

    // 有具体文本时，返回包含该文本的 Error
    if (text) return new Error(text)
    // 有 HTTP 状态码但没有文本时，返回带状态码的笼统失败信息
    if (status) return new Error(`Claude Code could not finish its reply (HTTP ${status})`)
    // 兜底：返回最笼统的失败信息
    return new Error("Claude Code could not finish its reply")
  }
}
