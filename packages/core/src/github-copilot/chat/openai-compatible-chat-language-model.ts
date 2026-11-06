// 从 AI SDK provider 包导入类型与错误类：API 调用错误、无效响应错误、
// V3 语言模型接口、调用选项、流片段、共享元数据与警告类型
import {
  APICallError,
  InvalidResponseDataError,
  type LanguageModelV3,
  type LanguageModelV3CallOptions,
  type LanguageModelV3StreamPart,
  type SharedV3ProviderMetadata,
  type SharedV3Warning,
} from "@ai-sdk/provider"
// 从 provider-utils 导入工具：合并请求头、SSE 响应处理器、JSON 错误响应处理器、
// fetch 类型、ID 生成器、JSON 可解析判断、provider 选项解析、解析结果与响应处理器类型、POST JSON 工具
import {
  combineHeaders,
  createEventSourceResponseHandler,
  createJsonErrorResponseHandler,
  type FetchFunction,
  generateId,
  isParsableJson,
  parseProviderOptions,
  type ParseResult,
  postJsonToApi,
  type ResponseHandler,
} from "@ai-sdk/provider-utils"
// 导入 zod v4：定义流式数据块的校验 schema
import { z } from "zod/v4"
// 导入同目录的各辅助模块：消息转换、响应元数据、完成原因映射、模型选项
import { convertToOpenAICompatibleChatMessages } from "./convert-to-openai-compatible-chat-messages.js"
import { getResponseMetadata } from "./get-response-metadata.js"
import { mapOpenAICompatibleFinishReason } from "./map-openai-compatible-finish-reason.js"
import { type OpenAICompatibleChatModelId, openaiCompatibleProviderOptions } from "./openai-compatible-chat-options.js"
// 导入默认错误结构与错误结构类型（解析 provider 的错误响应）
import { defaultOpenAICompatibleErrorStructure, type ProviderErrorStructure } from "../openai-compatible-error.js"
// 仅作类型导入：流式元数据提取器接口
import type { MetadataExtractor } from "./openai-compatible-metadata-extractor.js"
// 导入工具准备函数（tools/toolChoice 转换）
import { prepareTools } from "./openai-compatible-prepare-tools.js"

// OpenAICompatibleChatConfig：构造聊天模型所需的配置
export type OpenAICompatibleChatConfig = {
  // provider：提供商标识字符串
  provider: string
  // headers：每次请求时动态生成请求头
  headers: () => Record<string, string | undefined>
  // url：根据模型 ID 与路径拼接请求 URL
  url: (options: { modelId: string; path: string }) => string
  // fetch：可选的自定义 fetch 实现
  fetch?: FetchFunction
  // includeUsage：是否请求服务端返回用量统计（stream_options.include_usage）
  includeUsage?: boolean
  // errorStructure：provider 错误响应的解析结构
  errorStructure?: ProviderErrorStructure<any>
  // metadataExtractor：可选的响应元数据提取器
  metadataExtractor?: MetadataExtractor

  /**
   * Whether the model supports structured outputs.
   *
   * 中文说明：模型是否支持结构化输出（json_schema 形式的 response_format）。
   */
  supportsStructuredOutputs?: boolean

  /**
   * The supported URLs for the model.
   *
   * 中文说明：该模型支持的 URL 列表（供 AI SDK 校验服务端工具回调等）。
   */
  supportedUrls?: () => LanguageModelV3["supportedUrls"]
}

// OpenAICompatibleChatLanguageModel：OpenAI 兼容聊天协议的语言模型实现（仅支持流式）
export class OpenAICompatibleChatLanguageModel implements LanguageModelV3 {
  // 规范版本号：AI SDK V3
  readonly specificationVersion = "v3"

  // 是否支持结构化输出（构造时确定）
  readonly supportsStructuredOutputs: boolean

  // 模型 ID
  readonly modelId: OpenAICompatibleChatModelId
  // 私有配置
  private readonly config: OpenAICompatibleChatConfig
  // 失败响应处理器：把错误响应解析为 APICallError
  private readonly failedResponseHandler: ResponseHandler<APICallError>
  // 数据块校验 schema（类型经由构造器推断）
  private readonly chunkSchema // type inferred via constructor

  // 构造函数：保存配置并初始化错误处理
  constructor(modelId: OpenAICompatibleChatModelId, config: OpenAICompatibleChatConfig) {
    // 记录模型 ID
    this.modelId = modelId
    // 记录配置
    this.config = config

    // 原有注释：初始化错误处理：
    // initialize error handling:
    // 使用注入的错误结构，缺省用 OpenAI 兼容的默认结构
    const errorStructure = config.errorStructure ?? defaultOpenAICompatibleErrorStructure
    // 用错误 schema 组装数据块校验 schema（数据块与错误二选一）
    this.chunkSchema = createOpenAICompatibleChatChunkSchema(errorStructure.errorSchema)
    // 创建 JSON 错误响应处理器
    this.failedResponseHandler = createJsonErrorResponseHandler(errorStructure)

    // 结构化输出支持默认关闭
    this.supportsStructuredOutputs = config.supportsStructuredOutputs ?? false
  }

  // provider 访问器：返回提供商标识
  get provider(): string {
    return this.config.provider
  }

  // 私有访问器：provider 选项的键名（取 provider 字符串第一段并去空白）
  private get providerOptionsName(): string {
    return this.config.provider.split(".")[0].trim()
  }

  // supportedUrls 访问器：返回配置的受支持 URL（缺省空对象）
  get supportedUrls() {
    return this.config.supportedUrls?.() ?? {}
  }

  // getArgs：把统一的调用选项转换为 OpenAI 兼容的请求参数与警告列表
  private async getArgs({
    prompt,
    maxOutputTokens,
    temperature,
    topP,
    topK,
    frequencyPenalty,
    presencePenalty,
    providerOptions,
    stopSequences,
    responseFormat,
    seed,
    toolChoice,
    tools,
  }: LanguageModelV3CallOptions) {
    // 警告收集列表
    const warnings: SharedV3Warning[] = []

    // 原有注释：解析 provider 选项
    // Parse provider options
    // 同时接受 "copilot" 键与 provider 自身键名下的选项，后者优先（Object.assign 合并）
    const compatibleOptions = Object.assign(
      (await parseProviderOptions({
        provider: "copilot",
        providerOptions,
        schema: openaiCompatibleProviderOptions,
      })) ?? {},
      (await parseProviderOptions({
        provider: this.providerOptionsName,
        providerOptions,
        schema: openaiCompatibleProviderOptions,
      })) ?? {},
    )

    // topK 在 OpenAI 兼容接口中不受支持：记警告
    if (topK != null) {
      warnings.push({ type: "unsupported", feature: "topK" })
    }

    // JSON 响应格式带 schema 但模型不支持结构化输出：记警告（会被降级处理）
    if (responseFormat?.type === "json" && responseFormat.schema != null && !this.supportsStructuredOutputs) {
      warnings.push({
        type: "unsupported",
        feature: "responseFormat",
        details: "JSON response format schema is only supported with structuredOutputs",
      })
    }

    // 转换工具定义与选择策略，收集工具相关警告
    const {
      tools: openaiTools,
      toolChoice: openaiToolChoice,
      toolWarnings,
    } = prepareTools({
      tools,
      toolChoice,
    })

    // 返回请求参数与合并后的警告
    return {
      args: {
        // 原有注释：模型 ID：
        // model id:
        model: this.modelId,

        // 原有注释：模型专属设置：
        // model specific settings:
        // 终端用户标识（滥用监测用）
        user: compatibleOptions.user,

        // 原有注释：标准化设置：
        // standardized settings:
        // 最大输出 token 数
        max_tokens: maxOutputTokens,
        // 采样温度
        temperature,
        // 核采样阈值
        top_p: topP,
        // 频率惩罚
        frequency_penalty: frequencyPenalty,
        // 存在惩罚
        presence_penalty: presencePenalty,
        // 响应格式：JSON 模式下按是否支持结构化输出选择 json_schema 或 json_object
        response_format:
          responseFormat?.type === "json"
            ? this.supportsStructuredOutputs === true && responseFormat.schema != null
              ? {
                  type: "json_schema",
                  json_schema: {
                    schema: responseFormat.schema,
                    name: responseFormat.name ?? "response",
                    description: responseFormat.description,
                  },
                }
              : { type: "json_object" }
            : undefined,

        // 停止序列
        stop: stopSequences,
        // 随机种子
        seed,
        // 透传 provider 选项中未被标准 schema 定义的自定义键（原样发给服务端）
        ...Object.fromEntries(
          Object.entries(providerOptions?.[this.providerOptionsName] ?? {}).filter(
            ([key]) => !Object.keys(openaiCompatibleProviderOptions.shape).includes(key),
          ),
        ),

        // 推理力度选项
        reasoning_effort: compatibleOptions.reasoningEffort,
        // 文本详细程度选项
        verbosity: compatibleOptions.textVerbosity,

        // 原有注释：消息：
        // messages:
        // 把统一提示词转换为 OpenAI 兼容消息
        messages: convertToOpenAICompatibleChatMessages(prompt),

        // 原有注释：工具：
        // tools:
        tools: openaiTools,
        tool_choice: openaiToolChoice,

        // 原有注释：thinking_budget（Anthropic 系模型的思考预算）
        // thinking_budget
        thinking_budget: compatibleOptions.thinking_budget,
      },
      // 合并通用警告与工具警告
      warnings: [...warnings, ...toolWarnings],
    }
  }

  // doGenerate：非流式生成不受支持——Copilot 模型只支持流式
  async doGenerate(_options: LanguageModelV3CallOptions): Promise<never> {
    throw new Error("GitHub Copilot models only support streaming")
  }

  // doStream：发起流式聊天请求，并把 SSE 数据块转换为统一的流片段
  async doStream(options: LanguageModelV3CallOptions) {
    // 先把调用选项转换为请求参数与警告
    const { args, warnings } = await this.getArgs({ ...options })

    // 请求体：在参数之上叠加流式开关
    const body = {
      ...args,
      stream: true,

      // 原有注释：仅在严格兼容模式下附带 stream_options：
      // only include stream_options when in strict compatibility mode:
      // includeUsage 为 true 时请求服务端返回用量
      stream_options: this.config.includeUsage ? { include_usage: true } : undefined,
    }

    // 创建流式元数据提取器（若配置了）
    const metadataExtractor = this.config.metadataExtractor?.createStreamExtractor()

    // 发送 POST 请求：成功走 SSE 处理器，失败走 JSON 错误处理器
    const { responseHeaders, value: response } = await postJsonToApi({
      url: this.config.url({
        path: "/chat/completions",
        modelId: this.modelId,
      }),
      headers: combineHeaders(this.config.headers(), options.headers),
      body,
      failedResponseHandler: this.failedResponseHandler,
      successfulResponseHandler: createEventSourceResponseHandler(this.chunkSchema),
      abortSignal: options.abortSignal,
      fetch: this.config.fetch,
    })

    // 工具调用的累积状态：按 index 记录，含完成标记
    const toolCalls: Array<{
      id: string
      function: {
        name: string
        arguments: string
      }
      hasFinished: boolean
    }> = []

    // 完成原因：统一值 + 原始字符串
    let finishReason: {
      unified: ReturnType<typeof mapOpenAICompatibleFinishReason>
      raw: string | undefined
    } = {
      unified: "other",
      raw: undefined,
    }
    // 用量统计：各字段在流中逐步填充
    const usage: {
      completionTokens: number | undefined
      completionTokensDetails: {
        reasoningTokens: number | undefined
        acceptedPredictionTokens: number | undefined
        rejectedPredictionTokens: number | undefined
      }
      promptTokens: number | undefined
      promptTokensDetails: {
        cachedTokens: number | undefined
      }
      totalTokens: number | undefined
    } = {
      completionTokens: undefined,
      completionTokensDetails: {
        reasoningTokens: undefined,
        acceptedPredictionTokens: undefined,
        rejectedPredictionTokens: undefined,
      },
      promptTokens: undefined,
      promptTokensDetails: {
        cachedTokens: undefined,
      },
      totalTokens: undefined,
    }
    // 是否为第一个数据块（用于发送一次响应元数据）
    let isFirstChunk = true
    // 缓存 provider 选项键名
    const providerOptionsName = this.providerOptionsName
    // 推理段是否已开始（用于正确发送 start/end 事件）
    let isActiveReasoning = false
    // 文本段是否已开始
    let isActiveText = false
    // 最近一次收到的不透明推理令牌
    let reasoningOpaque: string | undefined

    // 返回流式结果：原始响应经 TransformStream 转换为统一片段
    return {
      stream: response.pipeThrough(
        new TransformStream<ParseResult<z.infer<typeof this.chunkSchema>>, LanguageModelV3StreamPart>({
          // start：流开始时先发出 stream-start 与警告
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings })
          },

          // 原有注释：TODO Chunk 上的类型安全丢失了，多半是错误 schema 所致。必须修复。
          // TODO we lost type safety on Chunk, most likely due to the error schema. MUST FIX
          // transform：逐块转换
          transform(chunk, controller) {
            // 原有注释：若请求了原始块，先于其他事件发出
            // Emit raw chunk if requested (before anything else)
            if (options.includeRawChunks) {
              controller.enqueue({ type: "raw", rawValue: chunk.rawValue })
            }

            // 原有注释：处理解析/校验失败的块：
            // handle failed chunk parsing / validation:
            // 标记错误完成原因并发出 error 事件
            if (!chunk.success) {
              finishReason = {
                unified: "error",
                raw: undefined,
              }
              controller.enqueue({ type: "error", error: chunk.error })
              return
            }
            // 取校验通过的数据
            const value = chunk.value

            // 交由元数据提取器处理原始块（若有）
            metadataExtractor?.processChunk(chunk.rawValue)

            // 原有注释：处理错误块：
            // handle error chunks:
            // 服务端在流中报告错误：发出 error 事件
            if ("error" in value) {
              finishReason = {
                unified: "error",
                raw: undefined,
              }
              controller.enqueue({ type: "error", error: value.error.message })
              return
            }

            // 第一个块：发出一次响应元数据（ID/模型/时间戳）
            if (isFirstChunk) {
              isFirstChunk = false

              controller.enqueue({
                type: "response-metadata",
                ...getResponseMetadata(value),
              })
            }

            // 块携带用量统计时：逐项填入 usage 结构
            if (value.usage != null) {
              const {
                prompt_tokens,
                completion_tokens,
                total_tokens,
                prompt_tokens_details,
                completion_tokens_details,
              } = value.usage

              // 提示 token 数
              usage.promptTokens = prompt_tokens ?? undefined
              // 补全 token 数
              usage.completionTokens = completion_tokens ?? undefined
              // 总 token 数
              usage.totalTokens = total_tokens ?? undefined
              // 推理 token 数（可选明细）
              if (completion_tokens_details?.reasoning_tokens != null) {
                usage.completionTokensDetails.reasoningTokens = completion_tokens_details?.reasoning_tokens
              }
              // 被接受的预测 token 数
              if (completion_tokens_details?.accepted_prediction_tokens != null) {
                usage.completionTokensDetails.acceptedPredictionTokens =
                  completion_tokens_details?.accepted_prediction_tokens
              }
              // 被拒绝的预测 token 数
              if (completion_tokens_details?.rejected_prediction_tokens != null) {
                usage.completionTokensDetails.rejectedPredictionTokens =
                  completion_tokens_details?.rejected_prediction_tokens
              }
              // 缓存命中的提示 token 数
              if (prompt_tokens_details?.cached_tokens != null) {
                usage.promptTokensDetails.cachedTokens = prompt_tokens_details?.cached_tokens
              }
            }

            // 取第一个 choice（聊天接口只关心一个）
            const choice = value.choices[0]

            // 块携带完成原因时：映射为统一枚举并记录原始值
            if (choice?.finish_reason != null) {
              finishReason = {
                unified: mapOpenAICompatibleFinishReason(choice.finish_reason),
                raw: choice.finish_reason ?? undefined,
              }
            }

            // 没有 delta 的块：无需进一步处理
            if (choice?.delta == null) {
              return
            }

            // 取增量内容
            const delta = choice.delta

            // 原有注释：交错思考（Claude）会在每个工具调用前发送新的 reasoning_opaque。
            // 与 Copilot 的 VS Code 客户端一致，只保留最新的那一个。
            // Interleaved thinking (Claude) sends a new reasoning_opaque before each tool call.
            // Keep the latest, matching the Copilot VS Code client, which replays only that one.
            if (delta.reasoning_opaque) reasoningOpaque = delta.reasoning_opaque

            // 原有注释：在文本增量之前发送推理（Copilot 使用 reasoning_text）：
            // enqueue reasoning before text deltas (Copilot uses reasoning_text):
            const reasoningContent = delta.reasoning_text
            if (reasoningContent) {
              // 推理段首次出现：先发 reasoning-start
              if (!isActiveReasoning) {
                controller.enqueue({
                  type: "reasoning-start",
                  id: "reasoning-0",
                })
                isActiveReasoning = true
              }

              // 发出推理增量
              controller.enqueue({
                type: "reasoning-delta",
                id: "reasoning-0",
                delta: reasoningContent,
              })
            }

            // 文本增量处理
            if (delta.content) {
              // 原有注释：若推理段仍活跃且文本即将开始，先结束推理段。
              // 这处理了 reasoning_opaque 与 content 出现在同一块中的情况。
              // If reasoning was active and we're starting text, end reasoning first
              // This handles the case where reasoning_opaque and content come in the same chunk
              if (isActiveReasoning && !isActiveText) {
                controller.enqueue({
                  type: "reasoning-end",
                  id: "reasoning-0",
                  providerMetadata: reasoningOpaque ? { copilot: { reasoningOpaque } } : undefined,
                })
                isActiveReasoning = false
              }

              // 文本段首次出现：发 text-start 并携带推理令牌
              if (!isActiveText) {
                controller.enqueue({
                  type: "text-start",
                  id: "txt-0",
                  providerMetadata: reasoningOpaque ? { copilot: { reasoningOpaque } } : undefined,
                })
                isActiveText = true
              }

              // 发出文本增量
              controller.enqueue({
                type: "text-delta",
                id: "txt-0",
                delta: delta.content,
              })
            }

            // 工具调用增量处理
            if (delta.tool_calls != null) {
              // 原有注释：若推理段仍活跃且即将开始工具调用，先结束推理段。
              // 这处理了推理直接进入工具调用、中间没有文本内容的情况。
              // If reasoning was active and we're starting tool calls, end reasoning first
              // This handles the case where reasoning goes directly to tool calls with no content
              if (isActiveReasoning) {
                controller.enqueue({
                  type: "reasoning-end",
                  id: "reasoning-0",
                  providerMetadata: reasoningOpaque ? { copilot: { reasoningOpaque } } : undefined,
                })
                isActiveReasoning = false
              }
              // 逐个处理工具调用增量
              for (const toolCallDelta of delta.tool_calls) {
                // 取该调用的序号
                const index = toolCallDelta.index

                // 尚无该序号的调用：这是一个新工具调用的开始
                if (toolCalls[index] == null) {
                  // 新调用必须带 id，否则响应非法
                  if (toolCallDelta.id == null) {
                    throw new InvalidResponseDataError({
                      data: toolCallDelta,
                      message: `Expected 'id' to be a string.`,
                    })
                  }

                  // 新调用必须带函数名，否则响应非法
                  if (toolCallDelta.function?.name == null) {
                    throw new InvalidResponseDataError({
                      data: toolCallDelta,
                      message: `Expected 'function.name' to be a string.`,
                    })
                  }

                  // 发出工具输入开始事件
                  controller.enqueue({
                    type: "tool-input-start",
                    id: toolCallDelta.id,
                    toolName: toolCallDelta.function.name,
                  })

                  // 登记新的调用状态（参数可能为空字符串起步）
                  toolCalls[index] = {
                    id: toolCallDelta.id,
                    function: {
                      name: toolCallDelta.function.name,
                      arguments: toolCallDelta.function.arguments ?? "",
                    },
                    hasFinished: false,
                  }

                  const toolCall = toolCalls[index]

                  if (toolCall.function?.name != null && toolCall.function?.arguments != null) {
                    // 原有注释：若参数文本已开始，发送增量：
                    // send delta if the argument text has already started:
                    if (toolCall.function.arguments.length > 0) {
                      controller.enqueue({
                        type: "tool-input-delta",
                        id: toolCall.id,
                        delta: toolCall.function.arguments,
                      })
                    }

                    // 原有注释：检查工具调用是否已完整
                    // （某些 provider 会在单个块中发送完整调用）：
                    // check if tool call is complete
                    // (some providers send the full tool call in one chunk):
                    if (isParsableJson(toolCall.function.arguments)) {
                      // 先结束输入，再发出完整调用
                      controller.enqueue({
                        type: "tool-input-end",
                        id: toolCall.id,
                      })

                      controller.enqueue({
                        type: "tool-call",
                        toolCallId: toolCall.id ?? generateId(),
                        toolName: toolCall.function.name,
                        input: toolCall.function.arguments,
                        providerMetadata: reasoningOpaque ? { copilot: { reasoningOpaque } } : undefined,
                      })
                      // 标记已完成
                      toolCall.hasFinished = true
                    }
                  }

                  // 处理完新调用，继续下一个增量
                  continue
                }

                // 原有注释：已存在的调用，未完成则合并增量
                // existing tool call, merge if not finished
                const toolCall = toolCalls[index]

                // 已完成的调用忽略后续增量
                if (toolCall.hasFinished) {
                  continue
                }

                // 追加参数文本增量
                if (toolCallDelta.function?.arguments != null) {
                  toolCall.function!.arguments += toolCallDelta.function?.arguments ?? ""
                }

                // 原有注释：发送增量
                // send delta
                controller.enqueue({
                  type: "tool-input-delta",
                  id: toolCall.id,
                  delta: toolCallDelta.function.arguments ?? "",
                })

                // 原有注释：检查工具调用是否已完整
                // check if tool call is complete
                if (
                  toolCall.function?.name != null &&
                  toolCall.function?.arguments != null &&
                  isParsableJson(toolCall.function.arguments)
                ) {
                  // 参数可解析为完整 JSON：结束输入并发出完整调用
                  controller.enqueue({
                    type: "tool-input-end",
                    id: toolCall.id,
                  })

                  controller.enqueue({
                    type: "tool-call",
                    toolCallId: toolCall.id ?? generateId(),
                    toolName: toolCall.function.name,
                    input: toolCall.function.arguments,
                    providerMetadata: reasoningOpaque ? { copilot: { reasoningOpaque } } : undefined,
                  })
                  // 标记已完成
                  toolCall.hasFinished = true
                }
              }
            }
          },

          // flush：流结束时收尾——关闭未完的推理/文本段，补发未完成的工具调用与 finish 事件
          flush(controller) {
            // 推理段仍活跃：发送 reasoning-end 并携带推理令牌
            if (isActiveReasoning) {
              controller.enqueue({
                type: "reasoning-end",
                id: "reasoning-0",
                // 原有注释：为 Copilot 多轮推理携带 reasoning_opaque
                // Include reasoning_opaque for Copilot multi-turn reasoning
                providerMetadata: reasoningOpaque ? { copilot: { reasoningOpaque } } : undefined,
              })
            }

            // 文本段仍活跃：发送 text-end
            if (isActiveText) {
              controller.enqueue({
                type: "text-end",
                id: "txt-0",
                providerMetadata: reasoningOpaque ? { copilot: { reasoningOpaque } } : undefined,
              })
            }

            // 原有注释：遍历所有工具调用，补发尚未完成者
            // go through all tool calls and send the ones that are not finished
            for (const toolCall of toolCalls.filter((toolCall) => !toolCall.hasFinished)) {
              // 先结束输入
              controller.enqueue({
                type: "tool-input-end",
                id: toolCall.id,
              })

              // 再发出完整调用（不再带推理元数据）
              controller.enqueue({
                type: "tool-call",
                toolCallId: toolCall.id ?? generateId(),
                toolName: toolCall.function.name,
                input: toolCall.function.arguments,
              })
            }

            // 组装最终 provider 元数据：provider 键 + 推理令牌 + 提取器结果
            const providerMetadata: SharedV3ProviderMetadata = {
              [providerOptionsName]: {},
              // 原有注释：为 Copilot 多轮推理携带 reasoning_opaque
              // Include reasoning_opaque for Copilot multi-turn reasoning
              ...(reasoningOpaque ? { copilot: { reasoningOpaque } } : {}),
              ...metadataExtractor?.buildMetadata(),
            }
            // 有被接受的预测 token 明细时写入元数据
            if (usage.completionTokensDetails.acceptedPredictionTokens != null) {
              providerMetadata[providerOptionsName].acceptedPredictionTokens =
                usage.completionTokensDetails.acceptedPredictionTokens
            }
            // 有被拒绝的预测 token 明细时写入元数据
            if (usage.completionTokensDetails.rejectedPredictionTokens != null) {
              providerMetadata[providerOptionsName].rejectedPredictionTokens =
                usage.completionTokensDetails.rejectedPredictionTokens
            }

            // 发出 finish 事件：完成原因、标准化用量与原始用量
            controller.enqueue({
              type: "finish",
              finishReason,
              usage: {
                inputTokens: {
                  total: usage.promptTokens,
                  noCache:
                    usage.promptTokens != undefined && usage.promptTokensDetails.cachedTokens != undefined
                      ? usage.promptTokens - usage.promptTokensDetails.cachedTokens
                      : undefined,
                  cacheRead: usage.promptTokensDetails.cachedTokens,
                  cacheWrite: undefined,
                },
                outputTokens: {
                  total: usage.completionTokens,
                  text: undefined,
                  reasoning: usage.completionTokensDetails.reasoningTokens,
                },
                raw: {
                  prompt_tokens: usage.promptTokens ?? null,
                  completion_tokens: usage.completionTokens ?? null,
                  total_tokens: usage.totalTokens ?? null,
                },
              },
              providerMetadata,
            })
          },
        }),
      ),
      // 附带原始请求体（便于调试/日志）
      request: { body },
      // 附带响应头
      response: { headers: responseHeaders },
    }
  }
}

// 用量字段的 zod schema：各字段均可为 null/缺失
const openaiCompatibleTokenUsageSchema = z
  .object({
    prompt_tokens: z.number().nullish(),
    completion_tokens: z.number().nullish(),
    total_tokens: z.number().nullish(),
    prompt_tokens_details: z
      .object({
        cached_tokens: z.number().nullish(),
      })
      .nullish(),
    completion_tokens_details: z
      .object({
        reasoning_tokens: z.number().nullish(),
        accepted_prediction_tokens: z.number().nullish(),
        rejected_prediction_tokens: z.number().nullish(),
      })
      .nullish(),
  })
  .nullish()

// 原有注释：schema 的精简版，只聚焦实现所需的部分——
// 这种做法在 API 变化时限制破坏面并提高效率
// limited version of the schema, focussed on what is needed for the implementation
// this approach limits breakages when the API changes and increases efficiency
// createOpenAICompatibleChatChunkSchema：用错误 schema 组装“数据块或错误”的联合校验
const createOpenAICompatibleChatChunkSchema = <ERROR_SCHEMA extends z.core.$ZodType>(errorSchema: ERROR_SCHEMA) =>
  z.union([
    z.object({
      id: z.string().nullish(),
      created: z.number().nullish(),
      model: z.string().nullish(),
      choices: z.array(
        z.object({
          delta: z
            .object({
              role: z.enum(["assistant"]).nullish(),
              content: z.string().nullish(),
              // 原有注释：Copilot 专属的推理字段
              // Copilot-specific reasoning fields
              reasoning_text: z.string().nullish(),
              reasoning_opaque: z.string().nullish(),
              tool_calls: z
                .array(
                  z.object({
                    index: z.number(),
                    id: z.string().nullish(),
                    function: z.object({
                      name: z.string().nullish(),
                      arguments: z.string().nullish(),
                    }),
                  }),
                )
                .nullish(),
            })
            .nullish(),
          finish_reason: z.string().nullish(),
        }),
      ),
      usage: openaiCompatibleTokenUsageSchema,
    }),
    errorSchema,
  ])
