// 从 AI SDK provider 包导入类型与错误类：V3 提示词类型、共享 provider 选项、不支持功能错误
import {
  type LanguageModelV3Prompt,
  type SharedV3ProviderOptions,
  UnsupportedFunctionalityError,
} from "@ai-sdk/provider"
// 仅作类型导入：OpenAI 兼容聊天消息数组的内部类型定义
import type { OpenAICompatibleChatPrompt } from "./openai-compatible-api-types.js"
// 导入 convertToBase64：把二进制数据编码为 base64 字符串
import { convertToBase64 } from "@ai-sdk/provider-utils"

// getOpenAIMetadata：提取消息上 copilot 专属的 provider 元数据（缺失时返回空对象）
function getOpenAIMetadata(message: { providerOptions?: SharedV3ProviderOptions }) {
  return message?.providerOptions?.copilot ?? {}
}

// 导出主函数：把 AI SDK 的统一提示词转换为 OpenAI 兼容的聊天消息数组
export function convertToOpenAICompatibleChatMessages(prompt: LanguageModelV3Prompt): OpenAICompatibleChatPrompt {
  // 目标消息数组
  const messages: OpenAICompatibleChatPrompt = []
  // 逐条遍历提示词消息（role/content 之外的附加字段留在 message 里作元数据来源）
  for (const { role, content, ...message } of prompt) {
    // 取该消息上的 copilot 元数据
    const metadata = getOpenAIMetadata({ ...message })
    // 按角色分支处理
    switch (role) {
      // 系统消息：直接透传内容
      case "system": {
        messages.push({
          role: "system",
          content: content,
          ...metadata,
        })
        break
      }

      // 用户消息：可能是纯文本或多部分（文本/图片）
      case "user": {
        // 快速路径：只有一段纯文本时直接以字符串作为 content
        if (content.length === 1 && content[0].type === "text") {
          messages.push({
            role: "user",
            content: content[0].text,
            ...getOpenAIMetadata(content[0]),
          })
          break
        }

        // 多部分消息：映射为 OpenAI 的 content 数组
        messages.push({
          role: "user",
          content: content.map((part) => {
            // 取该部分上的 copilot 元数据
            const partMetadata = getOpenAIMetadata(part)
            // 按部分类型分支
            switch (part.type) {
              // 文本部分：直接映射
              case "text": {
                return { type: "text", text: part.text, ...partMetadata }
              }
              // 文件部分：仅支持图片类媒体类型
              case "file": {
                // 媒体类型以 image/ 开头才可作为 image_url 发送
                if (part.mediaType.startsWith("image/")) {
                  // 通配的 image/* 统一按 image/jpeg 处理
                  const mediaType = part.mediaType === "image/*" ? "image/jpeg" : part.mediaType

                  return {
                    type: "image_url",
                    image_url: {
                      // URL 类型直接转字符串；否则把二进制编码为 data URL
                      url:
                        part.data instanceof URL
                          ? part.data.toString()
                          : `data:${mediaType};base64,${convertToBase64(part.data)}`,
                    },
                    ...partMetadata,
                  }
                } else {
                  // 非图片文件不受支持：抛出错误
                  throw new UnsupportedFunctionalityError({
                    functionality: `file part media type ${part.mediaType}`,
                  })
                }
              }
            }
          }),
          ...metadata,
        })

        break
      }

      // 助手消息：聚合文本、推理与工具调用
      case "assistant": {
        // 累积的文本内容
        let text = ""
        // 累积的推理文本
        let reasoningText: string | undefined
        // 最近一次出现的“不透明推理”标记值
        let reasoningOpaque: string | undefined
        // 收集的工具调用列表
        const toolCalls: Array<{
          id: string
          type: "function"
          function: { name: string; arguments: string }
        }> = []

        // 遍历助手消息的各个部分
        for (const part of content) {
          // 取该部分上的 copilot 元数据
          const partMetadata = getOpenAIMetadata(part)
          // 原有注释：reasoningOpaque 可能附着在任意部分上。交错思考会为每个推理段产生一个；
          // 与 Copilot 的 VS Code 客户端一致，把最新的不透明值与拼接后的推理文本一起回放。
          // reasoningOpaque may be attached to any part. Interleaved thinking yields one per
          // reasoning segment; like the Copilot VS Code client, replay the latest opaque value
          // with the concatenated reasoning text.
          const partOpaque = (part.providerOptions as { copilot?: { reasoningOpaque?: string } })?.copilot
            ?.reasoningOpaque
          // 只要出现就覆盖为最新值
          if (partOpaque) {
            reasoningOpaque = partOpaque
          }

          // 按部分类型累积
          switch (part.type) {
            // 文本部分：追加到累积文本
            case "text": {
              text += part.text
              break
            }
            // 推理部分：拼接推理文本
            case "reasoning": {
              if (part.text) reasoningText = (reasoningText ?? "") + part.text
              break
            }
            // 工具调用部分：映射为 OpenAI 的 tool_calls 项（参数序列化为 JSON 字符串）
            case "tool-call": {
              toolCalls.push({
                id: part.toolCallId,
                type: "function",
                function: {
                  name: part.toolName,
                  arguments: JSON.stringify(part.input),
                },
                ...partMetadata,
              })
              break
            }
          }
        }

        // 组装助手消息：无文本时 content 为 null；有工具调用才携带 tool_calls；
        // reasoning_text 仅在存在不透明标记时回放
        messages.push({
          role: "assistant",
          content: text || null,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
          reasoning_text: reasoningOpaque ? reasoningText : undefined,
          reasoning_opaque: reasoningOpaque,
          ...metadata,
        })

        break
      }

      // 工具结果消息：把每个工具响应映射为 OpenAI 的 tool 角色消息
      case "tool": {
        // 遍历该消息内的各个工具响应
        for (const toolResponse of content) {
          // 工具审批响应不进入对话历史，跳过
          if (toolResponse.type === "tool-approval-response") {
            continue
          }
          // 取响应输出
          const output = toolResponse.output

          // contentValue：按输出类型归一为字符串
          let contentValue: string
          switch (output.type) {
            // 纯文本与错误文本：直接取字符串值
            case "text":
            case "error-text":
              contentValue = output.value
              break
            // 执行被拒绝：取原因，缺省给固定文案
            case "execution-denied":
              contentValue = output.reason ?? "Tool execution denied."
              break
            // 结构化内容/JSON/JSON 错误：序列化为 JSON 字符串
            case "content":
            case "json":
            case "error-json":
              contentValue = JSON.stringify(output.value)
              break
          }

          // 取该响应上的 copilot 元数据
          const toolResponseMetadata = getOpenAIMetadata(toolResponse)
          // 组装 tool 消息：tool_call_id 与工具调用对应
          messages.push({
            role: "tool",
            tool_call_id: toolResponse.toolCallId,
            content: contentValue,
            ...toolResponseMetadata,
          })
        }
        break
      }

      // 穷尽性检查：出现未知角色说明类型系统被绕过，直接报错
      default: {
        const _exhaustiveCheck: never = role
        throw new Error(`Unsupported role: ${_exhaustiveCheck}`)
      }
    }
  }

  // 返回转换后的消息数组
  return messages
}
