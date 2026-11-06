// 导出 CatchUp 命名空间，供其他模块引用本文件内容
export * as CatchUp from "./catch-up.js"

// 导入 AI SDK 的提示词（prompt）类型定义
import type { LanguageModelV3Prompt } from "@ai-sdk/provider"
// 导入“转换为 Claude 消息”的工具模块
import { ConvertToClaudeMessage } from "../language-model/convert-to-claude-message.js"
// 导入指纹（Fingerprint）模块，用于按消息分组定位同步进度
import { Fingerprint } from "./fingerprint.js"

// 生成“补齐（catch-up）”内容块：把 OpenCode 中新出现的对话历史打包成 Claude 可见的检查点消息
export function content(prompt: LanguageModelV3Prompt, start = 0): ConvertToClaudeMessage.ContentBlock[] {
  // 从 start 下标开始截取尚未同步给 Claude 的消息
  const missed = prompt.slice(start)
  // 在漏掉的消息里按组查找最后一条非 user 角色的组，取其结束下标作为“历史部分”的边界
  const end = Fingerprint.groups(missed).findLast((group) => group.role !== "user")?.end ?? 0
  // 声明最终的内容块数组
  const blocks: ConvertToClaudeMessage.ContentBlock[] = []
  // 如果确实存在需要补齐的历史内容
  if (end > 0) {
    // 先插入一条说明文本，告诉 Claude 以下内容是它没见过的历史对话，应视为上下文而非新请求
    blocks.push({
      type: "text",
      text: "<conversation-checkpoint>\nThe following is conversation history from OpenCode that you have not seen. Treat it as prior conversation, not a new request. Continue with the user messages after this checkpoint.",
    })
    // 把边界之前的消息转换为 Claude 内容块并追加
    blocks.push(...ConvertToClaudeMessage.content(missed.slice(0, end)))
    // 追加检查点结束标记
    blocks.push({ type: "text", text: "</conversation-checkpoint>" })
  }
  // 边界之后（通常是本轮 user 的最新消息）正常转换为内容块，作为新请求
  blocks.push(...ConvertToClaudeMessage.content(missed.slice(end)))
  // 返回完整的内容块列表
  return blocks
}
