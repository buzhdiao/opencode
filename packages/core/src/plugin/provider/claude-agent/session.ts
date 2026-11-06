// 导出 ClaudeSessionHooks 命名空间，供其他模块引用本文件内容
export * as ClaudeSessionHooks from "./session.js"

// 导入助手消息、工具消息类型与工具结果块类型
import { AssistantMessage, ToolMessage, type ToolResultPart } from "@opencode/ai/effect"
// 导入插件上下文类型
import type { Context } from "@opencode/plugin/effect/plugin"
// 从 effect 库导入 Effect 与 Schema
import { Effect, Schema } from "effect"
// 导入请求类型（请求头常量）
import { RequestKind } from "./language-model/request-kind.js"
// 导入 Claude Provider（用于匹配 providerID）
import { ClaudeProvider } from "./provider.js"

// OpenCode 用这个结构化错误来记录被停止的工具（包括普通的权限拒绝）
// OpenCode records stopped tools (including a plain permission rejection) with this structured error.
const isAborted = Schema.is(Schema.Struct({ error: Schema.Struct({ type: Schema.Literal("aborted") }) }))

// 给工具结果块打错误标记：在 providerMetadata 上记录工具出错与是否被中止
const flagToolError = (part: ToolResultPart): ToolResultPart => {
  // 非错误类型的结果原样返回
  if (part.result.type !== "error") return part
  // 组装标记：保留已有的 providerMetadata 字段，并附加 toolError 与 toolAborted
  const flags = {
    ...part.providerMetadata?.[ClaudeProvider.ID],
    // 标记工具出错
    toolError: true,
    // 标记是否为“被中止”（含权限拒绝）
    toolAborted: isAborted(part.result.value),
  }
  // 返回带更新后 providerMetadata 的结果块
  return { ...part, providerMetadata: { ...part.providerMetadata, [ClaudeProvider.ID]: flags } }
}

// 注册会话钩子：请求头注入、上下文预处理、重试决策
export const register = Effect.fn("ClaudeSessionHooks.register")(function* (ctx: Context) {
  // 注册 model.request 钩子：仅为 claude 供应商生效
  yield* ctx.session.hook(
    "model.request",
    (event) =>
      Effect.gen(function* () {
        // 在请求头上标记本次请求的类型（primary/其他）
        event.headers[RequestKind.HEADER] = event.kind
        // 非主请求（如子任务）不做额外处理
        if (event.kind !== "primary") return
        // 读取会话信息；失败则中止
        const session = yield* ctx.session.get({ sessionID: event.sessionID }).pipe(Effect.orDie)
        // 若该会话是分叉（fork）出来的，在请求头上标记其来源会话 ID
        if (session.fork) event.headers[RequestKind.FORK_HEADER] = session.fork.sessionID
      }),
    { providerID: ClaudeProvider.ID },
  )
  // 注册 context 钩子：在请求发出前调整上下文
  yield* ctx.session.hook(
    "context",
    (event) =>
      Effect.sync(() => {
        // 删除 maxTokens 限制，让 Claude 选择其常规的输出预算；后续钩子仍可显式设置 maxTokens。
        // 压缩（compaction）有自己的钩子，因此会保留 OpenCode 的摘要预算。
        // Let Claude choose its normal output budget. Later hooks can still set an explicit maxTokens.
        // Compaction has its own hook, so it keeps OpenCode's summary budget.
        delete event.options.maxTokens
        // 在 AI SDK 桥接把错误结果压平成纯文本之前，先保留工具的错误状态
        // Preserve tool error status before the AI SDK bridge flattens error results to plain text.
        event.messages = event.messages.map((message) => {
          // 工具消息：对每个内容块打错误标记
          if (message.role === "tool")
            return new ToolMessage({ ...message, content: message.content.map(flagToolError) })
          // 非助手消息原样返回
          if (message.role !== "assistant") return message
          // 助手消息：对其中的工具结果块打错误标记
          const content = message.content.map((part) => (part.type === "tool-result" ? flagToolError(part) : part))
          // 重建助手消息
          return new AssistantMessage({ ...message, content })
        })
      }),
    { providerID: ClaudeProvider.ID },
  )
  // Claude Code 已经会重试 API 失败；如果这里再重放整轮，连永久性的计费错误也会被反复重试
  // Claude Code already retries API failures. Replaying the whole turn here also retries permanent billing errors.
  yield* ctx.session.hook(
    "retry",
    (event) =>
      Effect.sync(() => {
        // 决策：不再重试（交给 Claude Code 自身的重试机制）
        event.decision = { retry: false }
      }),
    { providerID: ClaudeProvider.ID },
  )
})
