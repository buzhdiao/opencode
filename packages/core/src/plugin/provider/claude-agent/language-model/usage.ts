// 导出 ClaudeUsage 命名空间，供其他模块引用本文件内容
export * as ClaudeUsage from "./usage.js"

// 导入 AI SDK 的用量类型定义
import type { LanguageModelV3Usage } from "@ai-sdk/provider"

// Claude 侧用量数据的内部结构（各字段均可选/可为 null）
interface Usage {
  // 输入 token 数
  readonly input_tokens?: number | null
  // 缓存读取的输入 token 数
  readonly cache_read_input_tokens?: number | null
  // 缓存写入（创建）的输入 token 数
  readonly cache_creation_input_tokens?: number | null
  // 输出 token 数
  readonly output_tokens?: number
  // 输出明细：其中可能包含思考（thinking）token 数
  readonly output_tokens_details?: { readonly thinking_tokens?: number } | null
}

// 工厂函数：聚合一次会话轮次中的 token 用量
export function make() {
  // 按消息 ID 记录各次调用的计数（输入/缓存读/缓存写/输出/推理）
  const messages = new Map<string, { input: number; read: number; write: number; output: number; reasoning: number }>()
  // 记录最近一次更新的消息 ID
  let last: string | undefined

  // 更新某个消息 ID 的用量：每个字段都取历史最大值（Claude 会在重试中重复上报）
  function update(id: string, usage: Usage) {
    // 取已保存的计数
    const saved = messages.get(id)
    // 没有则从零开始
    const counts = saved ?? { input: 0, read: 0, write: 0, output: 0, reasoning: 0 }
    // 若是首次出现该 ID，则登记并把它标记为“最近一次”
    if (!saved) {
      messages.set(id, counts)
      last = id
    }
    // 各字段取最大值（避免重复上报导致重复累加）
    counts.input = Math.max(counts.input, usage.input_tokens ?? 0)
    counts.read = Math.max(counts.read, usage.cache_read_input_tokens ?? 0)
    counts.write = Math.max(counts.write, usage.cache_creation_input_tokens ?? 0)
    counts.output = Math.max(counts.output, usage.output_tokens ?? 0)
    counts.reasoning = Math.max(counts.reasoning, usage.output_tokens_details?.thinking_tokens ?? 0)
  }

  // 返回对外接口
  return {
    // 暴露 update 供流式事件调用
    update,
    // 处理最终 result 消息携带的用量
    result(usage: Usage) {
      // result 里的用量汇总的是整个轮次；只有单次模型调用时才直接应用它
      // Result usage sums the whole turn; only apply it when there was a single model call.
      if (messages.size <= 1) update(last ?? "result", usage)
    },
    // 生成符合 AI SDK 规范的用量快照
    snapshot(): LanguageModelV3Usage {
      // 累计输出 token
      let output = 0
      // 累计推理（思考）token
      let reasoning = 0
      // 遍历所有消息的计数
      for (const counts of messages.values()) {
        // 累加输出
        output += counts.output
        // 累加推理
        reasoning += counts.reasoning
      }
      // 上下文占用取最后一次 API 调用的输入，而不是各次重复上下文的总和
      // Context occupancy is the last API call's input, not the sum of repeated contexts.
      const lastCall = last === undefined ? undefined : messages.get(last)
      // 输入总量 = 最后一次调用的 输入 + 缓存读 + 缓存写
      const inputTotal = lastCall ? lastCall.input + lastCall.read + lastCall.write : undefined
      // 组装并返回用量快照
      return {
        inputTokens: {
          // 输入总量
          total: inputTotal,
          // 无缓存的输入
          noCache: lastCall?.input,
          // 缓存读取量
          cacheRead: lastCall?.read,
          // 缓存写入量
          cacheWrite: lastCall?.write,
        },
        outputTokens: { total: output, reasoning, text: output - reasoning },
      }
    },
  }
}
