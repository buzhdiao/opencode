// 导出 Checkpoints 命名空间，供其他模块引用本文件内容
export * as Checkpoints from "./checkpoints.js"

// 导入 AI SDK 的提示词、文本块、工具调用块类型
import type { LanguageModelV3Prompt, LanguageModelV3TextPart, LanguageModelV3ToolCallPart } from "@ai-sdk/provider"
// 导入指纹（Fingerprint）模块，用于把提示词切分成组并计算哈希
import { Fingerprint } from "./fingerprint.js"
// 导入会话记录类型
import type { SessionRecord } from "./record.js"

// 构建同步历史（检查点列表）：为提示词的每一组消息记录指纹哈希，并尽量关联到 Claude 侧的消息 ID
export function build(input: {
  // 当前完整提示词
  prompt: LanguageModelV3Prompt
  // 上一次保存的会话记录（用于沿用已同步部分的 Claude 消息 ID）
  previous?: SessionRecord.Record
  // 本轮用户消息在 Claude 侧的 ID
  userID?: string
  // 本次模型回复的内容（文本块或工具调用块）
  reply: Array<LanguageModelV3TextPart | LanguageModelV3ToolCallPart>
  // 本轮回复在 Claude 侧的 ID
  messageID?: string
  // 工具调用 ID 到 Claude 侧工具结果消息 ID 的映射
  toolMessages: Map<string, string>
}) {
  // 初始化历史检查点数组
  const history: SessionRecord.Checkpoint[] = []
  // 把提示词按指纹规则切分成组（同角色的连续消息为一组）
  const groups = Fingerprint.groups(input.prompt)
  // 逐组处理
  for (let i = 0; i < groups.length; i++) {
    // 取出当前组（非空断言：索引在范围内）
    const group = groups[i]!
    // 取上次记录中同位置的历史检查点
    const previous = input.previous?.history?.[i]
    // 声明该组对应的 Claude 消息 ID（默认未知）
    let claudeMessageID: string | undefined
    // 若上次记录中同位置的组哈希一致，说明该组早已同步，沿用其 Claude 消息 ID
    if (previous && previous.hash === group.hash) claudeMessageID = previous.claudeMessageID
    // 对工具结果组做特殊处理
    if (group.role === "tool") {
      // 遍历该组内的所有消息
      for (const message of input.prompt.slice(group.start, group.end)) {
        // 只关心 tool 角色的消息
        if (message.role !== "tool") continue
        // 遍历消息内的内容块
        for (const part of message.content) {
          // 只关心工具结果块
          if (part.type !== "tool-result") continue
          // 通过工具调用 ID 查找对应的 Claude 侧消息 ID
          const toolMessage = input.toolMessages.get(part.toolCallId)
          // 找到则更新该组的 Claude 消息 ID
          if (toolMessage !== undefined) claudeMessageID = toolMessage
        }
      }
    }
    // 判断是否为最后一组
    const isLast = i === groups.length - 1
    // 最后一组若是用户消息，则记录其 Claude 消息 ID（作为最新的同步点）
    if (isLast && input.userID) claudeMessageID = input.userID
    // 把该组的检查点（哈希 + 消息 ID）写入历史
    history.push({ hash: group.hash, claudeMessageID })
  }
  // 若本轮有模型回复内容
  if (input.reply.length > 0) {
    // 把回复内容构造为单条 assistant 消息并计算指纹，取第一组
    const replyGroup = Fingerprint.groups([{ role: "assistant", content: input.reply }])[0]!
    // 追加回复检查点（记录回复哈希与 Claude 消息 ID），供下次会话恢复时比对
    history.push({ hash: replyGroup.hash, claudeMessageID: input.messageID })
  }
  // 返回完整的历史检查点列表
  return history
}
