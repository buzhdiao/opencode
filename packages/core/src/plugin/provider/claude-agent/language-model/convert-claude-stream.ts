// 导出 ConvertClaudeStream 命名空间，供其他模块引用本文件内容
export * as ConvertClaudeStream from "./convert-claude-stream.js"

// 导入 AI SDK 的函数工具与流部件类型
import type { LanguageModelV3FunctionTool, LanguageModelV3StreamPart } from "@ai-sdk/provider"
// 导入 Claude Agent SDK 的消息与限流信息类型
import type { SDKMessage, SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk"
// 导入 Provider schema（取 claudeAgent 的 ID）
import { Provider } from "@opencode/schema/provider"
// 导入用量聚合器
import { ClaudeUsage } from "./usage.js"
// 导入工具名转换工具
import { ToolNames } from "../tools/names.js"
// 导入错误收集器
import { ClaudeAgentError } from "./claude-agent-error.js"

// 创建流转换器：把 Claude Agent SDK 的消息流转换为 AI SDK 的流部件
export function make(tools: readonly LanguageModelV3FunctionTool[]) {
  // 创建用量聚合器
  const usage = ClaudeUsage.make()
  // 创建错误收集器（收集到最终 result 才产出 Error）
  const failure = ClaudeAgentError.make()
  // 已流式输出过的消息 ID 集合（避免完整消息重复输出）
  const streamed = new Set<string>()
  // 内容块索引 -> 类型（text 或 reasoning）的映射
  const blocks = new Map<number, "text" | "reasoning">()
  // 当前消息 ID
  let messageID = ""
  // 本轮是否已发生工具调用
  let calledTools = false
  // 会话/消息元数据（挂在 providerMetadata 上）
  let metadata: Record<string, { sessionID: string; messageID: string }> | undefined
  // 插件从步骤元数据里读取套餐用量，而不是轮询 Anthropic。
  // Plugins read plan usage from step metadata instead of polling Anthropic for it.
  let rateLimit: SDKRateLimitInfo | undefined
  // 组装结束元数据：有限流信息时附带在 claudeAgent 键下
  const finishMetadata = () => (rateLimit ? { [Provider.ID.claudeAgent]: { rateLimit } } : undefined)

  // 返回消息处理函数：输入一条 SDK 消息，输出若干流部件
  return (message: SDKMessage): LanguageModelV3StreamPart[] => {
    // 初始化输出部件列表
    const parts: LanguageModelV3StreamPart[] = []
    // 先交给错误收集器判断；若请求失败则直接返回错误部件
    const error = failure(message)
    if (error) return [{ type: "error", error }]
    // 记录限流事件信息
    if (message.type === "rate_limit_event") rateLimit = message.rate_limit_info
    // 处理顶层（非工具子调用）的流式事件
    if (message.type === "stream_event" && message.parent_tool_use_id === null) {
      // 取出内部事件
      const event = message.event
      // 按事件类型分派
      switch (event.type) {
        // 消息开始：登记消息 ID 与用量
        case "message_start":
          // 记录 API 消息 ID
          messageID = event.message.id
          // 清空上一条的元数据
          metadata = undefined
          // 标记该消息已流式输出
          streamed.add(messageID)
          // 更新用量
          usage.update(messageID, event.message.usage)
          // 发出响应元数据部件（ID 与模型名）
          parts.push({ type: "response-metadata", id: messageID, modelId: event.message.model })
          break
        // 内容块开始
        case "content_block_start": {
          // 取出块定义
          const block = event.content_block
          // 块 ID：消息 ID + 块索引
          const id = `${messageID}:${event.index}`
          // 文本块：登记类型并发出 text-start（首段文本作为 delta）
          if (block.type === "text") {
            blocks.set(event.index, "text")
            parts.push({ type: "text-start", id })
            if (block.text) parts.push({ type: "text-delta", id, delta: block.text })
            break
          }
          // 思考块：登记为 reasoning 并发出 reasoning-start（首段思考作为 delta）
          if (block.type === "thinking") {
            blocks.set(event.index, "reasoning")
            parts.push({ type: "reasoning-start", id })
            if (block.thinking) parts.push({ type: "reasoning-delta", id, delta: block.thinking })
          }
          break
        }
        // 内容块增量
        case "content_block_delta": {
          // 块 ID
          const id = `${messageID}:${event.index}`
          // 取出增量
          const delta = event.delta
          // 文本增量：发出 text-delta
          if (delta.type === "text_delta") {
            parts.push({ type: "text-delta", id, delta: delta.text })
            break
          }
          // 思考增量：发出 reasoning-delta（空内容跳过）
          if (delta.type === "thinking_delta" && delta.thinking) {
            parts.push({ type: "reasoning-delta", id, delta: delta.thinking })
          }
          break
        }
        // 内容块结束
        case "content_block_stop": {
          // 查询该块的类型
          const kind = blocks.get(event.index)
          // 有登记则发出对应的 end 部件（附元数据）
          if (kind) parts.push({ type: `${kind}-end`, id: `${messageID}:${event.index}`, providerMetadata: metadata })
          // 移除登记
          blocks.delete(event.index)
          break
        }
        // 消息增量（含用量更新）
        case "message_delta":
          // 更新用量
          usage.update(messageID, event.usage)
          break
        // 消息结束
        case "message_stop":
          // 必须与 ClaudeSession.readStep 的工具边界一致，否则 OpenCode 的步骤会缺少 finish 事件。
          // Must match ClaudeSession.readStep's tool boundary, or OpenCode's step ends without a finish event.
          // 若本轮发生过工具调用，则在此发出 finish（原因：tool-calls）
          if (calledTools) {
            parts.push({
              type: "finish",
              finishReason: { unified: "tool-calls", raw: "tool_use" },
              usage: usage.snapshot(),
              providerMetadata: finishMetadata(),
            })
          }
          break
      }
    }
    // 处理顶层完整的助手消息
    if (message.type === "assistant" && message.parent_tool_use_id === null) {
      // 合成的 API 错误消息只是诊断信息，不是助手回答
      // Synthetic API errors are diagnostics, not assistant answers.
      if (message.error) return parts
      // 流事件携带的是 API 消息 ID；只有完整助手消息才带转录用的 UUID。
      // Stream events carry API message IDs; only the complete assistant message carries the transcript UUID.
      metadata = { [Provider.ID.claudeAgent]: { sessionID: message.session_id, messageID: message.uuid } }
      // 更新用量
      usage.update(message.message.id, message.message.usage)
      // 遍历内容块，转换工具调用
      for (const block of message.message.content) {
        // 只关心 tool_use 块
        if (block.type !== "tool_use") continue
        // 反查 OpenCode 原始工具名；不是我们提供的工具则跳过（Claude Code 自答）
        const toolName = ToolNames.original(block.name, tools)
        if (!toolName) continue
        // 标记本轮发生了工具调用
        calledTools = true
        // 发出 tool-call 部件（输入序列化为 JSON 字符串）
        parts.push({
          type: "tool-call",
          toolCallId: block.id,
          toolName,
          input: JSON.stringify(block.input),
          providerMetadata: metadata,
        })
      }
      // 完整助手消息会重复已流式输出的内容。只在没有任何流式输出时才使用它。
      // Complete assistant messages repeat the streamed content. Only use them when nothing was streamed.
      if (!streamed.has(message.message.id)) {
        // 逐块补发文本/思考内容
        for (let i = 0; i < message.message.content.length; i++) {
          // 取出块
          const block = message.message.content[i]!
          // 块 ID 用消息 UUID + 索引
          const id = `${message.uuid}:${i}`
          // 文本块：start/delta/end 三连发
          if (block.type === "text") {
            parts.push({ type: "text-start", id })
            parts.push({ type: "text-delta", id, delta: block.text })
            parts.push({ type: "text-end", id, providerMetadata: metadata })
            continue
          }
          // 思考块：reasoning 三连发
          if (block.type === "thinking") {
            parts.push({ type: "reasoning-start", id })
            parts.push({ type: "reasoning-delta", id, delta: block.thinking })
            parts.push({ type: "reasoning-end", id })
          }
        }
      }
    }
    // 处理最终 result 消息
    if (message.type === "result") {
      // 单轮任务时 result 用量即整轮用量，直接应用
      if (message.num_turns === 1) usage.result(message.usage)
      // 发出 finish 部件：停止原因统一化（max_tokens -> length，其他 -> stop）
      parts.push({
        type: "finish",
        finishReason: {
          unified: message.stop_reason === "max_tokens" ? "length" : "stop",
          raw: message.stop_reason ?? undefined,
        },
        usage: usage.snapshot(),
        providerMetadata: finishMetadata(),
      })
    }
    // 返回本条消息产生的所有流部件
    return parts
  }
}
