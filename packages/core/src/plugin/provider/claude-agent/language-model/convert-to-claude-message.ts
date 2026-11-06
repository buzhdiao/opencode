// 导出 ConvertToClaudeMessage 命名空间，供其他模块引用本文件内容
export * as ConvertToClaudeMessage from "./convert-to-claude-message.js"

// 导入 AI SDK 的文件块与提示词类型
import type { LanguageModelV3FilePart, LanguageModelV3Prompt } from "@ai-sdk/provider"
// 导入 Claude Agent SDK 的用户消息类型
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"

// 内容块类型：SDK 用户消息 content（排除字符串形式）数组中的元素类型
export type ContentBlock = Exclude<SDKUserMessage["message"]["content"], string>[number]

// Claude 无法接收之前的对话轮次，因此历史消息的角色用文本标签包裹；附件仍保持真实的内容块。
// Claude can't be given earlier turns, so their roles become text tags. Attachments stay real content blocks.
export function content(prompt: LanguageModelV3Prompt): ContentBlock[] {
  // 初始化输出内容块数组
  const blocks: ContentBlock[] = []
  // 判断提示词中是否存在 assistant 或 tool 角色（即包含历史对话）
  const history = prompt.some((message) => message.role === "assistant" || message.role === "tool")
  // 遍历每条消息
  for (const message of prompt) {
    // 系统消息直接跳过（由 Claude Code 自己的系统提示承担）
    if (message.role === "system") continue
    // 若存在历史对话，则为该消息插入角色开始标签（如 <user>）
    if (history) blocks.push({ type: "text", text: `<${message.role}>` })
    // 遍历消息中的每个内容块
    for (const part of message.content) {
      // 文本块：直接作为文本内容块输出
      if (part.type === "text") {
        blocks.push({ type: "text", text: part.text })
        continue
      }
      // 文件块：交给 file() 转换为文档/图像内容块
      if (part.type === "file") {
        blocks.push(file(part))
        continue
      }
      // 工具调用块：序列化为 JSON 并用 <tool-call> 标签包裹成文本
      if (part.type === "tool-call") {
        const call = JSON.stringify({ id: part.toolCallId, name: part.toolName, input: part.input })
        blocks.push({ type: "text", text: `<tool-call>\n${call}\n</tool-call>` })
        continue
      }
      // 工具结果块：序列化为 JSON 并用 <tool-result> 标签包裹成文本
      if (part.type === "tool-result") {
        const result = JSON.stringify({ id: part.toolCallId, name: part.toolName, output: part.output })
        blocks.push({ type: "text", text: `<tool-result>\n${result}\n</tool-result>` })
      }
    }
    // 若存在历史对话，插入该消息的角色结束标签（如 </user>）
    if (history) blocks.push({ type: "text", text: `</${message.role}>` })
  }
  // 返回转换后的内容块列表
  return blocks
}

// 把文件块转换为 Claude 支持的文档（PDF）或图像内容块
function file(part: LanguageModelV3FilePart): ContentBlock {
  // 取文件的 MIME 类型
  const type = part.mediaType
  // PDF 文件：转换为 document 类型
  if (type === "application/pdf") {
    // 数据是 URL 时使用 url 来源
    if (part.data instanceof URL) return { type: "document", source: { type: "url", url: part.data.href } }
    // 否则把二进制数据转为 base64 传入
    return { type: "document", source: { type: "base64", media_type: type, data: base64(part.data) } }
  }
  // 支持的图像类型：转换为 image 类型
  if (type === "image/png" || type === "image/jpeg" || type === "image/gif" || type === "image/webp") {
    // 数据是 URL 时使用 url 来源
    if (part.data instanceof URL) return { type: "image", source: { type: "url", url: part.data.href } }
    // 否则把二进制数据转为 base64 传入
    return { type: "image", source: { type: "base64", media_type: type, data: base64(part.data) } }
  }
  // 其余类型 Claude Code 不支持，抛出错误
  throw new Error(`Claude Code does not support ${type} attachments`)
}

// 把文件数据规范化为 base64 字符串
function base64(data: string | Uint8Array) {
  // 字符串形式视为已是 base64，直接返回
  if (typeof data === "string") return data
  // 二进制数据用 Buffer 编码为 base64
  return Buffer.from(data).toString("base64")
}
