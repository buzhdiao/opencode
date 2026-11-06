// 引入 AI SDK 的提示词类型、共享警告类型与“不支持的功能”错误
import { type LanguageModelV3Prompt, type SharedV3Warning, UnsupportedFunctionalityError } from "@ai-sdk/provider"
// 引入 base64 转换与提供商选项解析工具
import { convertToBase64, parseProviderOptions } from "@ai-sdk/provider-utils"
// 引入 zod 校验库
import { z } from "zod/v4"
// 引入 OpenAI Responses API 的输入与推理条目类型
import type { OpenAIResponsesInput, OpenAIResponsesReasoning } from "./openai-responses-api-types.js"

/**
 * Check if a string is a file ID based on the given prefixes
 * Returns false if prefixes is undefined (disables file ID detection)
 */
// 判断字符串是否为文件 ID（按给定前缀匹配）；prefixes 未定义时禁用检测并返回 false
function isFileId(data: string, prefixes?: readonly string[]): boolean {
  // 未提供前缀集合则不做文件 ID 识别
  if (!prefixes) return false
  // 只要匹配任意一个前缀即视为文件 ID
  return prefixes.some((prefix) => data.startsWith(prefix))
}

// 将 AI SDK 的通用提示词（prompt）转换为 OpenAI Responses API 的输入条目数组
export async function convertToOpenAIResponsesInput({
  prompt,
  systemMessageMode,
  fileIdPrefixes,
  store,
}: {
  // 通用提示词（各角色消息的集合）
  prompt: LanguageModelV3Prompt
  // 系统消息处理模式：保留为 system / 转为 developer / 直接移除
  systemMessageMode: "system" | "developer" | "remove"
  // 可选：识别文件 ID 的前缀集合
  fileIdPrefixes?: readonly string[]
  // 是否使用服务端存储（store）；决定条目以引用还是完整内容发送
  store: boolean
}): Promise<{
  // 转换后的 Responses 输入条目
  input: OpenAIResponsesInput
  // 转换过程中收集的警告
  warnings: Array<SharedV3Warning>
}> {
  // 输出条目列表
  const input: OpenAIResponsesInput = []
  // 警告列表
  const warnings: Array<SharedV3Warning> = []
  // 已处理过的工具审批（approval）ID，避免重复发送审批响应
  const processedApprovalIds = new Set<string>()

  // 逐条遍历提示词消息，按角色分别转换
  for (const { role, content } of prompt) {
    // 按消息角色分发处理
    switch (role) {
      // 系统消息
      case "system": {
        // 按配置的系统消息模式处理
        switch (systemMessageMode) {
          // 模式 system：原样保留为 system 角色
          case "system": {
            input.push({ role: "system", content })
            break
          }
          // 模式 developer：转为 developer 角色
          case "developer": {
            input.push({ role: "developer", content })
            break
          }
          // 模式 remove：丢弃系统消息并记录警告
          case "remove": {
            warnings.push({
              type: "other",
              message: "system messages are removed for this model",
            })
            break
          }
          // 穷举兜底：出现未知模式立即报错
          default: {
            const _exhaustiveCheck: never = systemMessageMode
            throw new Error(`Unsupported system message mode: ${_exhaustiveCheck}`)
          }
        }
        break
      }

      // 用户消息
      case "user": {
        // 把每个内容部件映射为 Responses 的用户内容条目
        input.push({
          role: "user",
          content: content.map((part, index) => {
            // 按部件类型分发
            switch (part.type) {
              // 文本部件 -> input_text
              case "text": {
                return { type: "input_text", text: part.text }
              }
              // 文件部件：区分图片 / PDF / 其他
              case "file": {
                // 图片类媒体类型
                if (part.mediaType.startsWith("image/")) {
                  // 通配 image/* 归一化为 image/jpeg
                  const mediaType = part.mediaType === "image/*" ? "image/jpeg" : part.mediaType

                  // 依据数据形态选择传递方式：URL / 文件 ID / base64 数据 URL
                  return {
                    type: "input_image",
                    ...(part.data instanceof URL
                      ? { image_url: part.data.toString() }
                      : typeof part.data === "string" && isFileId(part.data, fileIdPrefixes)
                        ? { file_id: part.data }
                        : {
                            image_url: `data:${mediaType};base64,${convertToBase64(part.data)}`,
                          }),
                    // 透传图片细节偏好（如 high/low）
                    detail: part.providerOptions?.copilot?.imageDetail,
                  }
                } else if (part.mediaType === "application/pdf") {
                  // PDF 以 URL 提供时直接传文件链接
                  if (part.data instanceof URL) {
                    return {
                      type: "input_file",
                      file_url: part.data.toString(),
                    }
                  }
                  // PDF 以内容/文件 ID 提供时按 ID 或 base64 数据传递
                  return {
                    type: "input_file",
                    ...(typeof part.data === "string" && isFileId(part.data, fileIdPrefixes)
                      ? { file_id: part.data }
                      : {
                          filename: part.filename ?? `part-${index}.pdf`,
                          file_data: `data:application/pdf;base64,${convertToBase64(part.data)}`,
                        }),
                  }
                } else {
                  // 其他媒体类型不支持，抛出错误
                  throw new UnsupportedFunctionalityError({
                    functionality: `file part media type ${part.mediaType}`,
                  })
                }
              }
            }
          }),
        })

        break
      }

      // 助手消息
      case "assistant": {
        // 记录已输出的推理消息（按条目 ID 去重，防止同一推理重复引用/发送）
        const reasoningMessages: Record<string, OpenAIResponsesReasoning> = {}

        // 遍历助手消息的各个内容部件
        for (const part of content) {
          // 按部件类型分发
          switch (part.type) {
            // 文本部件 -> assistant 消息（output_text）；store 模式下附带条目 ID
            case "text": {
              input.push({
                role: "assistant",
                content: [{ type: "output_text", text: part.text }],
                id: store ? ((part.providerOptions?.copilot?.itemId as string) ?? undefined) : undefined,
              })
              break
            }
            // 工具调用部件
            case "tool-call": {
              // 服务端（provider）执行的工具调用无需回传
              if (part.providerExecuted) {
                break
              }

              // 客户端执行的工具调用以 function_call 条目回传
              input.push({
                type: "function_call",
                call_id: part.toolCallId,
                name: part.toolName,
                arguments: JSON.stringify(part.input),
                id: store ? ((part.providerOptions?.copilot?.itemId as string) ?? undefined) : undefined,
              })
              break
            }

            // assistant tool result parts are from provider-executed tools:
            // 工具结果部件（来自服务端执行的内建工具）
            case "tool-result": {
              if (store) {
                // use item references to refer to tool results from built-in tools
                input.push({ type: "item_reference", id: part.toolCallId })
              } else {
                warnings.push({
                  type: "other",
                  message: `Results for OpenAI tool ${part.toolName} are not sent to the API when store is false`,
                })
              }

              break
            }

            // 推理（reasoning）部件
            case "reasoning": {
              // 解析 copilot 提供商专属选项（条目 ID、加密推理内容）
              const providerOptions = await parseProviderOptions({
                provider: "copilot",
                providerOptions: part.providerOptions,
                schema: openaiResponsesReasoningProviderOptionsSchema,
              })

              // 取推理条目 ID
              const reasoningId = providerOptions?.itemId

              if (reasoningId != null) {
                // 查询该 ID 是否已被处理过
                const reasoningMessage = reasoningMessages[reasoningId]

                if (store) {
                  if (reasoningMessage === undefined) {
                    // use item references to refer to reasoning (single reference)
                    input.push({ type: "item_reference", id: reasoningId })

                    // store unused reasoning message to mark id as used
                    reasoningMessages[reasoningId] = {
                      type: "reasoning",
                      id: reasoningId,
                      summary: [],
                    }
                  }
                } else if (providerOptions?.reasoningEncryptedContent != null && reasoningMessage === undefined) {
                  // 非 store 模式：用加密内容原样重建推理条目回传
                  reasoningMessages[reasoningId] = {
                    type: "reasoning",
                    id: reasoningId,
                    encrypted_content: providerOptions.reasoningEncryptedContent,
                    summary: [],
                  }
                  input.push(reasoningMessages[reasoningId])
                }
              } else {
                // 无条目 ID 的非 OpenAI 推理部件无法回传，记录警告后跳过
                warnings.push({
                  type: "other",
                  message: `Non-OpenAI reasoning parts are not supported. Skipping reasoning part: ${JSON.stringify(part)}.`,
                })
              }
              break
            }
          }
        }

        break
      }

      // 工具消息（工具执行结果回传）
      case "tool": {
        // 遍历工具消息的各个内容部件
        for (const part of content) {
          // 工具审批响应部件（MCP 审批）
          if (part.type === "tool-approval-response") {
            // 同一审批 ID 只处理一次，避免重复发送
            if (processedApprovalIds.has(part.approvalId)) {
              continue
            }
            // 标记该审批 ID 已处理
            processedApprovalIds.add(part.approvalId)

            if (store) {
              // store 模式下先用条目引用关联原审批请求
              input.push({
                type: "item_reference",
                id: part.approvalId,
              })
            }

            // 发送审批响应：请求 ID 与批准/拒绝结论
            input.push({
              type: "mcp_approval_response",
              approval_request_id: part.approvalId,
              approve: part.approved,
            })
            continue
          }
          // 取工具输出
          const output = part.output

          if (output.type === "execution-denied") {
            // 执行被拒绝：若关联着审批 ID（说明已有审批响应发出）则跳过，避免重复
            const approvalId = (output.providerOptions?.copilot as { approvalId?: string } | undefined)?.approvalId

            if (approvalId) {
              continue
            }
          }

          // 最终要发送的字符串形式输出
          let contentValue: string
          // 按输出类型归一化为字符串
          switch (output.type) {
            // 纯文本/错误文本直接取值
            case "text":
            case "error-text":
              contentValue = output.value
              break
            // 执行被拒绝：取拒绝原因（缺省给固定文案）
            case "execution-denied":
              contentValue = output.reason ?? "Tool execution denied."
              break
            // 结构化内容/JSON/JSON 错误序列化为字符串
            case "content":
            case "json":
            case "error-json":
              contentValue = JSON.stringify(output.value)
              break
          }

          // 以 function_call_output 条目回传，通过 call_id 关联工具调用
          input.push({
            type: "function_call_output",
            call_id: part.toolCallId,
            output: contentValue,
          })
        }

        break
      }

      // 穷举兜底：未知角色立即报错
      default: {
        const _exhaustiveCheck: never = role
        throw new Error(`Unsupported role: ${_exhaustiveCheck}`)
      }
    }
  }

  // 返回转换结果与过程中收集的警告
  return { input, warnings }
}

// copilot 提供商推理部件专属选项的 schema：条目 ID 与加密推理内容（均可空）
const openaiResponsesReasoningProviderOptionsSchema = z.object({
  itemId: z.string().nullish(),
  reasoningEncryptedContent: z.string().nullish(),
})

// 推理部件提供商选项的导出类型
export type OpenAIResponsesReasoningProviderOptions = z.infer<typeof openaiResponsesReasoningProviderOptionsSchema>
