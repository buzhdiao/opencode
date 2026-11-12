// 引入 AI 错误、工具失败与完成原因详情类型
import { AIError, ToolFailure, type FinishReasonDetails } from "@opencode/ai/effect"
// 引入工具（Tool）schema
import { Tool } from "@opencode/schema/tool"
// 引入会话错误（SessionError）schema
import { SessionError } from "@opencode/schema/session-error"
// 引入权限错误类型
import { Permission } from "../permission.js"
// 引入集成（Integration）错误类型
import { Integration } from "../integration.js"
// 引入会话模块的错误类型（代理不存在、步骤失败）
import { AgentNotFoundError, StepFailedError } from "./error.js"
// 引入模型解析器错误
import { ModelResolver } from "../model-resolver.js"
// 引入模型重试判定工具
import { ModelRetry } from "../model-retry.js"
// 引入运行器模型错误
import { SessionRunnerModel } from "./runner/model.js"

// ChatGPT token 共享错误码到用户可读文案的映射
const tokenSharingMessages = {
  subscription_sharing_user_not_eligible:
    "ChatGPT token sharing isn't available for this account. Connect with an API key or choose another provider.",
  subscription_sharing_usage_limit_exceeded:
    "ChatGPT usage limit reached. Check ChatGPT Settings → Usage for details.",
  subscription_sharing_workplace_individual_usage_limit_exceeded:
    "You've reached the usage limit your ChatGPT workspace admin set for you. Ask them to raise it in the OpenAI Admin Console.",
  subscription_sharing_usage_unavailable: "ChatGPT usage can't be checked right now. Try again later.",
  subscription_sharing_unsupported_capability:
    "This request uses a feature ChatGPT token sharing doesn't support. Remove the unsupported feature and try again.",
  subscription_sharing_route_not_supported:
    "ChatGPT token sharing doesn't support this API route. Check the configured endpoint and HTTP method.",
  subscription_sharing_invalid_user: "This ChatGPT connection is no longer valid. Reconnect to ChatGPT.",
  subscription_sharing_user_unavailable: "Your ChatGPT account is temporarily unavailable. Try again later.",
  chatpass_v2_scope_not_authorized:
    "This ChatGPT connection isn't authorized for this request. Reconnect to ChatGPT or choose another connection.",
  chatpass_v2_invalid_authorization_context:
    "This ChatGPT connection isn't authorized for this request. Reconnect to ChatGPT or choose another connection.",
}

// 免费额度用尽的文案
const FREE_USAGE_LIMIT_MESSAGE =
  "Free usage limit reached. Connect a provider or subscribe to OpenCode Go to keep going, or switch models."
// 工作区用量预算用尽的文案
const BUDGET_LIMIT_MESSAGE = "Workspace usage limit reached. Model use is paused until the limit resets."
// 单个模型花费上限用尽的文案
const MODEL_BUDGET_LIMIT_MESSAGE = "You've reached the spend limit for this model. Switch models to keep going."

// 将任意抛出的原因归一化为会话错误（SessionError），供前端与日志统一消费
export function toSessionError(cause: unknown): SessionError.Error {
  // AI SDK 抛出的错误：按错误原因（reason）细分映射
  if (cause instanceof AIError) {
    // ChatGPT's usage limit arrives in HTTP and stream errors alike, whatever their reason, so its code decides the type.
    // ChatGPT 的用量超限可能出现在任意原因的 HTTP 或流错误中：按响应体关键字优先判定
    if (cause.reason.body?.includes("subscription_sharing_usage_limit_exceeded"))
      return providerError("provider.chatgpt-limit", cause.reason)
    // 按错误原因的标签（_tag）分发
    switch (cause.reason._tag) {
      case "RateLimit":
        // 速率限制
        return providerError("provider.rate-limit", cause.reason)
      case "Authentication":
        // 认证失败
        return providerError("provider.auth", cause.reason)
      case "QuotaExceeded":
        // 配额超限：进一步细分免费额度/预算/Go 限额
        if (cause.reason.body?.includes("FreeUsageLimitError"))
          // 免费额度用尽：替换为固定引导文案
          return { ...providerError("provider.free-limit", cause.reason), message: FREE_USAGE_LIMIT_MESSAGE }
        // 预算限额用尽
        if (cause.reason.body?.includes("BudgetLimitError")) return budgetLimit(cause.reason)
        // OpenCode Go 限额用尽
        if (cause.reason.body?.includes("GoUsageLimitError")) return goLimit(cause.reason)
        // 其余配额错误
        return providerError("provider.quota", cause.reason)
      case "ContentPolicy":
        // 内容策略拦截
        return providerError("provider.content-filter", cause.reason)
      case "Transport":
        // 传输错误：进一步区分网络不可达
        if (ModelRetry.isUnreachable(cause)) return unreachable(cause.reason)
        // 一般传输错误
        return providerError("provider.transport", cause.reason)
      case "ProviderInternal":
        // 供应商内部错误
        return providerError("provider.internal", cause.reason)
      case "InvalidProviderOutput":
        // 供应商返回内容无法解析
        return providerError("provider.invalid-output", cause.reason)
      case "InvalidRequest":
        // 请求不合法
        return providerError("provider.invalid-request", cause.reason)
      case "UnsupportedOperation":
        // 不支持的操作
        return providerError("provider.unsupported-operation", cause.reason)
      case "UnknownProvider":
        // 未知供应商
        return providerError("provider.unknown", cause.reason)
      case "Timeout":
        // 请求超时
        return providerError("provider.timeout", cause.reason)
      default: {
        // 穷尽性检查：出现新的错误标签时让编译期报错
        const exhaustive: never = cause.reason
        return exhaustive
      }
    }
  }
  // 权限被拒绝
  if (cause instanceof Permission.BlockedError) return { type: "permission.rejected", message: cause.message }
  // 用户纠正了工具调用：同样视为权限拒绝，消息用用户反馈
  if (cause instanceof Permission.CorrectedError) return { type: "permission.rejected", message: cause.feedback }
  // 工具执行失败（本地 ToolFailure 或 schema 的 Tool.Error）
  if (cause instanceof ToolFailure || cause instanceof Tool.Error) {
    // 没有底层错误：直接使用工具自身的消息
    if (cause.error === undefined) return { type: "tool.execution", message: cause.message }
    // The canonical error is the sole model-visible representation, so a cause
    // with no message must not erase the tool's curated failure message.
    // 递归归一化底层错误
    const unwrapped = toSessionError(cause.error)
    // 底层错误没有消息时，保留工具精心组织的失败文案并归为工具执行错误
    return unwrapped.message === "" ? { ...unwrapped, type: "tool.execution", message: cause.message } : unwrapped
  }
  // 步骤失败：其内部错误已是会话错误，直接透出
  if (cause instanceof StepFailedError) return cause.error
  // 模型不支持压缩（compaction）操作
  if (cause instanceof ModelResolver.UnsupportedCompactionError)
    return { type: "provider.unsupported-operation", message: cause.message }
  // 找不到代理：归为未知错误
  if (cause instanceof AgentNotFoundError) return { type: "unknown", message: cause.message }
  // 各类模型选择/解析失败（未选模型、模型不可用、变体不可用、包不支持、配置错误、初始化失败、变量未解析）：统一归为无可用路由
  if (
    cause instanceof SessionRunnerModel.ModelNotSelectedError ||
    cause instanceof SessionRunnerModel.ModelUnavailableError ||
    cause instanceof ModelResolver.VariantUnavailableError ||
    cause instanceof ModelResolver.UnsupportedPackageError ||
    cause instanceof ModelResolver.ModelConfigurationError ||
    cause instanceof ModelResolver.ModelInitializationError ||
    cause instanceof ModelResolver.UnresolvedProviderVariablesError
  )
    return { type: "provider.no-route", message: cause.message }
  // 集成授权失败
  if (cause instanceof Integration.AuthorizationError) return { type: "provider.auth", message: cause.message }
  // 兜底：Error 取其消息，否则转字符串
  return { type: "unknown", message: cause instanceof Error ? cause.message : String(cause) }
}

// 构造内容过滤错误：拼接摘要、类别与解释
export function contentFilterError(summary: string, reason: FinishReasonDetails): SessionError.Error {
  return {
    type: "provider.content-filter",
    // 有类别时摘要带上类别；再与解释合并为单条消息
    message: [reason.category === undefined ? summary : `${summary} (${reason.category})`, reason.explanation]
      .filter(Boolean)
      .join(": "),
  }
}

// OpenCode Console names what a refusing budget covers, in its envelope's metadata or, for Google clients, ErrorInfo.
// 解析预算限额：Console 会在响应体中标注限额覆盖的是单个模型还是整个工作区
function budgetLimit(reason: AIError["reason"]): SessionError.Error {
  // 覆盖范围是 "models"：单模型花费上限
  if (/"coverage"\s*:\s*"models"/.test(reason.body ?? ""))
    return { ...providerError("provider.model-budget-limit", reason), message: MODEL_BUDGET_LIMIT_MESSAGE }
  // 默认：工作区预算上限
  return { ...providerError("provider.budget-limit", reason), message: BUDGET_LIMIT_MESSAGE }
}

// OpenCode Console names the Go limit that refused the request (5 hour, weekly or monthly) in its envelope's metadata.
// 解析 OpenCode Go 限额：响应体元数据会给出限额名称（5 小时/每周/每月）
function goLimit(reason: AIError["reason"]): SessionError.Error {
  // 从响应体中提取限额名称（可选）
  const name = /"limitName"\s*:\s*"([^"]+)"/.exec(reason.body ?? "")?.[1]
  // 组装带限额名称的引导文案
  return {
    ...providerError("provider.go-limit", reason),
    message: `OpenCode Go ${name ? `${name} ` : ""}usage limit reached. Switch to a free model, or turn on Extra Usage on the Go page in OpenCode Console to keep going.`,
  }
}

// Names the network as the problem, so a DNS outage doesn't read like a broken model or provider.
// 网络不可达：把问题明确指向网络，避免 DNS 故障被误读为模型或供应商损坏
function unreachable(reason: AIError["reason"]): SessionError.Error {
  // 从错误携带的 URL 解析主机名（可选）
  const host = "url" in reason && reason.url !== undefined ? URL.parse(reason.url)?.hostname : undefined
  // 组装指明主机名的不可达文案
  return {
    ...providerError("provider.transport", reason),
    message: `Can't reach ${host || "the provider"}. Check the network connection. (${reason.message})`,
  }
}

// 组装供应商错误的通用结构：类型 + 消息 + 可选的状态码/响应体/重试间隔
function providerError(type: string, reason: AIError["reason"]): SessionError.Error {
  // 提取 HTTP 状态码（可选）
  const status = reason.http?.status
  // 提取重试等待毫秒数（可选）
  const retryAfterMs = "retryAfterMs" in reason ? reason.retryAfterMs : undefined
  return {
    type,
    // 消息优先用 token 共享错误码映射的用户文案，否则用原始错误消息
    message: Object.entries(tokenSharingMessages).find(([code]) => reason.body?.includes(code))?.[1] ?? reason.message,
    // 有状态码才附带
    ...(status === undefined ? {} : { status }),
    // 有响应体才附带
    ...(reason.body === undefined ? {} : { response: { body: reason.body } }),
    // 有重试间隔才附带
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  }
}
