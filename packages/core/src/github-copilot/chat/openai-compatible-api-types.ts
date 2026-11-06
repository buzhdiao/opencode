// 仅作类型导入：JSON 值类型（用于扩展元数据字段）
import type { JSONValue } from "@ai-sdk/provider"

// OpenAICompatibleChatPrompt：一次聊天请求的完整消息数组类型
export type OpenAICompatibleChatPrompt = Array<OpenAICompatibleMessage>

// OpenAICompatibleMessage：四种角色消息的联合类型
export type OpenAICompatibleMessage =
  | OpenAICompatibleSystemMessage
  | OpenAICompatibleUserMessage
  | OpenAICompatibleAssistantMessage
  | OpenAICompatibleToolMessage

// 原有注释：允许携带任意附加属性，用于通用目的的 provider 元数据扩展。
// Allow for arbitrary additional properties for general purpose
// provider-metadata-specific extensibility.
// JsonRecord：在 JSON 值之上允许叠加 T 类型的扩展字段
type JsonRecord<T = never> = Record<string, JSONValue | JSONValue[] | T | T[] | undefined>

// 系统消息：content 为字符串或文本部分数组
export interface OpenAICompatibleSystemMessage extends JsonRecord<OpenAICompatibleSystemContentPart> {
  role: "system"
  content: string | Array<OpenAICompatibleSystemContentPart>
}

// 系统消息的文本部分
export interface OpenAICompatibleSystemContentPart extends JsonRecord {
  type: "text"
  text: string
}

// 用户消息：content 为字符串或内容部分数组
export interface OpenAICompatibleUserMessage extends JsonRecord<OpenAICompatibleContentPart> {
  role: "user"
  content: string | Array<OpenAICompatibleContentPart>
}

// 用户内容部分：文本或图片的联合
export type OpenAICompatibleContentPart = OpenAICompatibleContentPartText | OpenAICompatibleContentPartImage

// 图片部分：OpenAI 风格的 image_url 结构
export interface OpenAICompatibleContentPartImage extends JsonRecord {
  type: "image_url"
  image_url: { url: string }
}

// 文本部分
export interface OpenAICompatibleContentPartText extends JsonRecord {
  type: "text"
  text: string
}

// 助手消息：可携带文本（可为 null）、工具调用与 Copilot 专属推理字段
export interface OpenAICompatibleAssistantMessage extends JsonRecord<OpenAICompatibleMessageToolCall> {
  role: "assistant"
  content?: string | null
  tool_calls?: Array<OpenAICompatibleMessageToolCall>
  // 原有注释：Copilot 专属的推理字段
  // Copilot-specific reasoning fields
  // reasoning_text：人类可读的推理文本
  reasoning_text?: string
  // reasoning_opaque：服务端不透明的推理回放令牌
  reasoning_opaque?: string
}

// 工具调用项：函数名与 JSON 字符串形式的参数
export interface OpenAICompatibleMessageToolCall extends JsonRecord {
  type: "function"
  id: string
  function: {
    arguments: string
    name: string
  }
}

// 工具结果消息：内容为字符串，并通过 tool_call_id 关联到调用
export interface OpenAICompatibleToolMessage extends JsonRecord {
  role: "tool"
  content: string
  tool_call_id: string
}
