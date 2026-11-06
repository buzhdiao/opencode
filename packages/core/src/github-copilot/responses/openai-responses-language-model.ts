// 引入 AI SDK 的通用类型：JSON 值、语言模型接口、调用选项、流片段、提供商元数据与警告
import {
  type JSONValue,
  type LanguageModelV3,
  type LanguageModelV3CallOptions,
  type LanguageModelV3StreamPart,
  type SharedV3ProviderMetadata,
  type SharedV3Warning,
} from "@ai-sdk/provider"
// 引入提供商工具库：请求头合并、SSE 响应处理、ID 生成、提供商选项解析等
import {
  combineHeaders,
  createEventSourceResponseHandler,
  generateId,
  parseProviderOptions,
  type ParseResult,
  postJsonToApi,
} from "@ai-sdk/provider-utils"
// 引入 zod 校验库
import { z } from "zod/v4"
// 引入提供商配置类型
import type { OpenAIConfig } from "./openai-config.js"
// 引入统一的失败响应处理器
import { openaiFailedResponseHandler } from "./openai-error.js"
// 引入代码解释器工具的输入/输出 schema
import { codeInterpreterInputSchema, codeInterpreterOutputSchema } from "./tool/code-interpreter.js"
// 引入文件搜索工具的输出 schema
import { fileSearchOutputSchema } from "./tool/file-search.js"
// 引入图像生成工具的输出 schema
import { imageGenerationOutputSchema } from "./tool/image-generation.js"
// 引入提示词转换函数
import { convertToOpenAIResponsesInput } from "./convert-to-openai-responses-input.js"
// 引入完成原因映射函数
import { mapOpenAIResponseFinishReason } from "./map-openai-responses-finish-reason.js"
// 引入 include 选项类型
import type { OpenAIResponsesIncludeOptions, OpenAIResponsesIncludeValue } from "./openai-responses-api-types.js"
// 引入工具准备函数与托管工具类型
import { prepareResponsesTools, type ResponsesHostedTool } from "./openai-responses-prepare-tools.js"
// 引入模型 ID 类型
import type { OpenAIResponsesModelId } from "./openai-responses-settings.js"

// 联网搜索调用条目的 schema：动作可为搜索/打开页面/页内查找
const webSearchCallItem = z.object({
  type: z.literal("web_search_call"),
  id: z.string(),
  status: z.string(),
  action: z
    .discriminatedUnion("type", [
      z.object({
        type: z.literal("search"),
        query: z.string().nullish(),
      }),
      z.object({
        type: z.literal("open_page"),
        url: z.string(),
      }),
      z.object({
        type: z.literal("find"),
        url: z.string(),
        pattern: z.string(),
      }),
    ])
    .nullish(),
})

// 文件搜索调用条目的 schema：查询列表与带得分的结果数组
const fileSearchCallItem = z.object({
  type: z.literal("file_search_call"),
  id: z.string(),
  queries: z.array(z.string()),
  results: z
    .array(
      z.object({
        attributes: z.record(z.string(), z.unknown()),
        file_id: z.string(),
        filename: z.string(),
        score: z.number(),
        text: z.string(),
      }),
    )
    .nullish(),
})

// 代码解释器调用条目的 schema：代码、容器 ID 与日志/图片输出
const codeInterpreterCallItem = z.object({
  type: z.literal("code_interpreter_call"),
  id: z.string(),
  code: z.string().nullable(),
  container_id: z.string(),
  outputs: z
    .array(
      z.discriminatedUnion("type", [
        z.object({ type: z.literal("logs"), logs: z.string() }),
        z.object({ type: z.literal("image"), url: z.string() }),
      ]),
    )
    .nullable(),
})

// 图像生成调用条目的 schema：生成的结果（base64/URL 字符串）
const imageGenerationCallItem = z.object({
  type: z.literal("image_generation_call"),
  id: z.string(),
  result: z.string(),
})

/**
 * `top_logprobs` request body argument can be set to an integer between
 * 0 and 20 specifying the number of most likely tokens to return at each
 * token position, each with an associated log probability.
 *
 * @see https://platform.openai.com/docs/api-reference/responses/create#responses_create-top_logprobs
 */
// top_logprobs 的最大允许值（0-20 之间的整数）
const TOP_LOGPROBS_MAX = 20

// token 对数概率（logprobs）的结构：每个 token 的对数概率及其 top 候选
const LOGPROBS_SCHEMA = z.array(
  z.object({
    token: z.string(),
    logprob: z.number(),
    top_logprobs: z.array(
      z.object({
        token: z.string(),
        logprob: z.number(),
      }),
    ),
  }),
)

// OpenAI Responses API 的语言模型实现（GitHub Copilot 复用）
export class OpenAIResponsesLanguageModel implements LanguageModelV3 {
  // 符合的 AI SDK 规范版本
  readonly specificationVersion = "v3"

  // 模型 ID
  readonly modelId: OpenAIResponsesModelId

  // 提供商配置（URL/请求头/fetch 等）
  private readonly config: OpenAIConfig

  constructor(modelId: OpenAIResponsesModelId, config: OpenAIConfig) {
    // 记录模型 ID
    this.modelId = modelId
    // 记录配置
    this.config = config
  }

  // 支持通过 URL 传递的输入类型：图片与 PDF（任意 http/https 链接）
  readonly supportedUrls: Record<string, RegExp[]> = {
    "image/*": [/^https?:\/\/.*$/],
    "application/pdf": [/^https?:\/\/.*$/],
  }

  // 提供商名称来自配置
  get provider(): string {
    return this.config.provider
  }

  // 私有：把通用调用选项转换为 Responses API 请求参数
  private async getArgs({
    maxOutputTokens,
    temperature,
    stopSequences,
    topP,
    topK,
    presencePenalty,
    frequencyPenalty,
    seed,
    prompt,
    providerOptions,
    tools,
    toolChoice,
    responseFormat,
  }: LanguageModelV3CallOptions) {
    // 警告收集列表
    const warnings: SharedV3Warning[] = []

    // 以下参数 Responses API 不支持，出现即记录警告
    if (topK != null) {
      warnings.push({ type: "unsupported", feature: "topK" })
    }

    if (seed != null) {
      warnings.push({ type: "unsupported", feature: "seed" })
    }

    if (presencePenalty != null) {
      warnings.push({
        type: "unsupported",
        feature: "presencePenalty",
      })
    }

    if (frequencyPenalty != null) {
      warnings.push({
        type: "unsupported",
        feature: "frequencyPenalty",
      })
    }

    if (stopSequences != null) {
      warnings.push({ type: "unsupported", feature: "stopSequences" })
    }

    // 解析 copilot 提供商专属选项
    const openaiOptions = await parseProviderOptions({
      provider: "copilot",
      providerOptions,
      schema: openaiResponsesProviderOptionsSchema,
    })
    // 是否使用服务端存储（默认关闭）
    const store = openaiOptions?.store ?? false

    // 把通用提示词转换为 Responses 输入
    const { input, warnings: inputWarnings } = await convertToOpenAIResponsesInput({
      prompt,
      systemMessageMode: "system",
      fileIdPrefixes: this.config.fileIdPrefixes,
      store,
    })

    // 合并转换过程中产生的警告
    warnings.push(...inputWarnings)

    // 是否强制 JSON Schema 严格模式
    const strictJsonSchema = openaiOptions?.strictJsonSchema ?? false

    // include 选项：请求响应额外附带的数据，初始来自提供商选项
    let include: OpenAIResponsesIncludeOptions = openaiOptions?.include

    // 向 include 中追加一项（已存在则忽略）
    function addInclude(key: OpenAIResponsesIncludeValue) {
      if (include?.includes(key)) return
      include = include != null ? [...include, key] : [key]
    }

    // 始终请求加密的推理内容，便于多轮回传
    addInclude("reasoning.encrypted_content")

    // 判断是否包含某个 OpenAI 提供商工具
    function hasOpenAITool(id: string) {
      return tools?.find((tool) => tool.type === "provider" && tool.id === id) != null
    }

    // when logprobs are requested, automatically include them:
    // 请求对数概率时自动附带：布尔 true 表示取最大档，数字表示具体 top n
    const topLogprobs =
      typeof openaiOptions?.logprobs === "number"
        ? openaiOptions?.logprobs
        : openaiOptions?.logprobs === true
          ? TOP_LOGPROBS_MAX
          : undefined

    if (topLogprobs) {
      // 请求文本输出附带 logprobs
      addInclude("message.output_text.logprobs")
    }

    // 转换工具定义与工具选择
    const {
      tools: openaiTools,
      toolChoice: openaiToolChoice,
      hostedTools,
      selectedHostedTool,
      toolWarnings,
    } = prepareResponsesTools({
      tools,
      toolChoice,
      strictJsonSchema,
    })
    // 由响应类型反查托管工具的展示名称（找不到时直接用类型名）
    const getHostedToolName = (responseType: ResponsesHostedTool["responseType"]) => {
      if (selectedHostedTool?.responseType === responseType) return selectedHostedTool.name
      return hostedTools.find((tool) => tool.responseType === responseType)?.name ?? responseType
    }

    if (hostedTools.some((tool) => tool.responseType === "web_search")) {
      // 有联网搜索工具时附带搜索动作的来源信息
      addInclude("web_search_call.action.sources")
    }

    // when a code interpreter tool is present, automatically include the outputs:
    // 有代码解释器工具时自动附带其输出
    if (hasOpenAITool("openai.code_interpreter")) {
      addInclude("code_interpreter_call.outputs")
    }

    // 请求体基础参数
    const baseArgs = {
      // 模型 ID
      model: this.modelId,
      // 输入条目
      input,
      // 采样温度
      temperature,
      // 核采样参数
      top_p: topP,
      // 最大输出 token 数
      max_output_tokens: maxOutputTokens,

      // JSON 响应格式与输出冗长度（二者至少其一才输出 text 字段）
      ...((responseFormat?.type === "json" || openaiOptions?.textVerbosity) && {
        text: {
          ...(responseFormat?.type === "json" && {
            format:
              // 有 schema 时用 json_schema 模式，否则用 json_object 模式
              responseFormat.schema != null
                ? {
                    type: "json_schema",
                    strict: strictJsonSchema,
                    name: responseFormat.name ?? "response",
                    description: responseFormat.description,
                    schema: responseFormat.schema,
                  }
                : { type: "json_object" },
          }),
          ...(openaiOptions?.textVerbosity && {
            verbosity: openaiOptions.textVerbosity,
          }),
        },
      }),

      // provider options:
      // 内建工具调用次数上限
      max_tool_calls: openaiOptions?.maxToolCalls,
      // 附加元数据
      metadata: openaiOptions?.metadata,
      // 是否允许并行工具调用
      parallel_tool_calls: openaiOptions?.parallelToolCalls,
      // 上一次响应 ID（多轮对话续接）
      previous_response_id: openaiOptions?.previousResponseId,
      // 是否服务端存储
      store,
      // 终端用户标识
      user: openaiOptions?.user,
      // 系统指令
      instructions: openaiOptions?.instructions,
      // 服务层级
      service_tier: openaiOptions?.serviceTier,
      // 额外附带的数据
      include,
      // 提示缓存键
      prompt_cache_key: openaiOptions?.promptCacheKey,
      // 安全标识
      safety_identifier: openaiOptions?.safetyIdentifier,
      // top n 对数概率
      top_logprobs: topLogprobs,

      // 推理参数：力度与摘要模式（二者至少其一才输出 reasoning 字段）
      ...((openaiOptions?.reasoningEffort != null || openaiOptions?.reasoningSummary != null) && {
        reasoning: {
          ...(openaiOptions?.reasoningEffort != null && {
            effort: openaiOptions.reasoningEffort,
          }),
          ...(openaiOptions?.reasoningSummary != null && {
            summary: openaiOptions.reasoningSummary,
          }),
        },
      }),
    }

    // 返回最终参数、工具与警告
    return {
      getHostedToolName,
      args: {
        ...baseArgs,
        tools: openaiTools,
        tool_choice: openaiToolChoice,
      },
      warnings: [...warnings, ...toolWarnings],
    }
  }

  // 非流式生成不支持：GitHub Copilot 模型仅支持流式
  async doGenerate(_options: LanguageModelV3CallOptions): Promise<never> {
    throw new Error("GitHub Copilot models only support streaming")
  }

  // 流式生成：POST /responses 并把 SSE 事件转换为 AI SDK 流片段
  async doStream(options: LanguageModelV3CallOptions) {
    // 先构造请求参数与警告
    const { args: body, warnings, getHostedToolName } = await this.getArgs(options)

    // 发起 JSON POST 请求，响应按 SSE 事件流解析
    const { responseHeaders, value: response } = await postJsonToApi({
      url: this.config.url({
        path: "/responses",
        modelId: this.modelId,
      }),
      // 合并配置请求头与调用方请求头
      headers: combineHeaders(this.config.headers(), options.headers),
      body: {
        ...body,
        // 强制流式
        stream: true,
      },
      // 失败响应统一处理
      failedResponseHandler: openaiFailedResponseHandler,
      // 成功响应按 chunk schema 校验的 SSE 处理器
      successfulResponseHandler: createEventSourceResponseHandler(openaiResponsesChunkSchema),
      // 透传中止信号
      abortSignal: options.abortSignal,
      // 可选的自定义 fetch
      fetch: this.config.fetch,
    })

    // oxlint-disable-next-line no-this-alias -- needed for closure scope inside generator
    // 保存 this 引用，供生成器闭包内使用
    const self = this

    // 完成原因：统一映射值与原始字符串
    let finishReason: {
      unified: ReturnType<typeof mapOpenAIResponseFinishReason>
      raw: string | undefined
    } = {
      unified: "other",
      raw: undefined,
    }
    // 用量统计（初始均未知）
    const usage: {
      inputTokens: number | undefined
      outputTokens: number | undefined
      totalTokens: number | undefined
      reasoningTokens: number | undefined
      cachedInputTokens: number | undefined
    } = {
      inputTokens: undefined,
      outputTokens: undefined,
      totalTokens: undefined,
      reasoningTokens: undefined,
      cachedInputTokens: undefined,
    }
    // 收集到的 token 对数概率
    const logprobs: Array<z.infer<typeof LOGPROBS_SCHEMA>> = []
    // 服务端响应 ID
    let responseId: string | null = null
    // 进行中的工具调用表：按输出下标记录工具调用 ID（代码解释器另存容器 ID）
    const ongoingToolCalls: Record<
      number,
      | {
          toolCallId: string
          codeInterpreter?: {
            containerId: string
          }
        }
      | undefined
    > = {}

    // flag that checks if there have been client-side tool calls (not executed by openai)
    // 标记：是否出现过客户端侧的工具调用（非 OpenAI 执行）
    let hasFunctionCall = false

    // Track reasoning by output_index instead of item_id
    // GitHub Copilot rotates encrypted item IDs on every event
    // 按输出下标（而非 item_id）跟踪推理条目：Copilot 每个事件都会轮换加密 ID
    const activeReasoning: Record<
      number,
      {
        canonicalId: string // the item.id from output_item.added
        encryptedContent?: string | null
        summaryParts: Record<number, "active" | "can-conclude" | "concluded">
      }
    > = {}

    // Track current active reasoning output_index for correlating summary events
    // 记录当前活跃推理的输出下标，用于关联摘要事件
    let currentReasoningOutputIndex: number | null = null

    // Track a stable text part id for the current assistant message.
    // Copilot may change item_id across text deltas; normalize to one id.
    // 跟踪当前助手消息的稳定文本片段 ID：Copilot 可能在增量间改变 item_id，需归一为同一 ID
    let currentTextId: string | null = null

    // 服务层级（响应中返回时记录）
    let serviceTier: string | undefined

    return {
      stream: response.pipeThrough(
        // 用转换流把 SSE chunk 逐个映射为 AI SDK 流片段
        new TransformStream<ParseResult<z.infer<typeof openaiResponsesChunkSchema>>, LanguageModelV3StreamPart>({
          start(controller) {
            // 流开始：先发出警告
            controller.enqueue({ type: "stream-start", warnings })
          },

          transform(chunk, controller) {
            if (options.includeRawChunks) {
              // 需要原始块时透传原始值
              controller.enqueue({ type: "raw", rawValue: chunk.rawValue })
            }

            // handle failed chunk parsing / validation:
            // chunk 解析/校验失败：标记错误完成原因并发出错误
            if (!chunk.success) {
              finishReason = {
                unified: "error",
                raw: undefined,
              }
              controller.enqueue({ type: "error", error: chunk.error })
              return
            }

            // 取校验通过的事件值
            const value = chunk.value

            if (isResponseOutputItemAddedChunk(value)) {
              if (value.item.type === "function_call") {
                // 登记进行中的函数调用
                ongoingToolCalls[value.output_index] = {
                  toolCallId: value.item.call_id,
                }

                controller.enqueue({
                  type: "tool-input-start",
                  id: value.item.call_id,
                  toolName: value.item.name,
                })
              } else if (value.item.type === "web_search_call") {
                // 登记进行中的联网搜索调用
                ongoingToolCalls[value.output_index] = {
                  toolCallId: value.item.id,
                }

                controller.enqueue({
                  type: "tool-input-start",
                  id: value.item.id,
                  toolName: getHostedToolName("web_search"),
                })
              } else if (value.item.type === "computer_call") {
                // 登记进行中的计算机操作调用
                ongoingToolCalls[value.output_index] = {
                  toolCallId: value.item.id,
                }

                controller.enqueue({
                  type: "tool-input-start",
                  id: value.item.id,
                  toolName: "computer_use",
                })
              } else if (value.item.type === "code_interpreter_call") {
                // 登记进行中的代码解释器调用（附带容器 ID）
                ongoingToolCalls[value.output_index] = {
                  toolCallId: value.item.id,
                  codeInterpreter: {
                    containerId: value.item.container_id,
                  },
                }

                controller.enqueue({
                  type: "tool-input-start",
                  id: value.item.id,
                  toolName: getHostedToolName("code_interpreter"),
                })

                controller.enqueue({
                  type: "tool-input-delta",
                  id: value.item.id,
                  delta: `{"containerId":"${value.item.container_id}","code":"`,
                })
              } else if (value.item.type === "file_search_call") {
                // 文件搜索：开始即发出一个服务端执行的工具调用
                controller.enqueue({
                  type: "tool-call",
                  toolCallId: value.item.id,
                  toolName: getHostedToolName("file_search"),
                  input: "{}",
                  providerExecuted: true,
                })
              } else if (value.item.type === "image_generation_call") {
                // 图像生成：同样立即发出工具调用
                controller.enqueue({
                  type: "tool-call",
                  toolCallId: value.item.id,
                  toolName: getHostedToolName("image_generation"),
                  input: "{}",
                  providerExecuted: true,
                })
              } else if (value.item.type === "message") {
                // Start a stable text part for this assistant message
                // 为该助手消息开启稳定的文本片段
                currentTextId = value.item.id
                controller.enqueue({
                  type: "text-start",
                  id: value.item.id,
                  providerMetadata: {
                    copilot: {
                      itemId: value.item.id,
                    },
                  },
                })
              } else if (isResponseOutputItemAddedReasoningChunk(value)) {
                if (activeReasoning[value.output_index]) {
                  // 同一下标的推理已存在：仅更新活跃下标
                  currentReasoningOutputIndex = value.output_index
                  return
                }
                // 新推理条目：登记规范 ID、加密内容与首段摘要
                activeReasoning[value.output_index] = {
                  canonicalId: value.item.id,
                  encryptedContent: value.item.encrypted_content,
                  summaryParts: { 0: "active" },
                }
                currentReasoningOutputIndex = value.output_index

                controller.enqueue({
                  type: "reasoning-start",
                  id: `${value.item.id}:0`,
                  providerMetadata: {
                    copilot: {
                      itemId: value.item.id,
                      reasoningEncryptedContent: value.item.encrypted_content ?? null,
                    },
                  },
                })
              }
            } else if (isResponseOutputItemDoneChunk(value)) {
              if (value.item.type === "function_call") {
                // 函数调用完成：清理登记并标记存在客户端工具调用
                ongoingToolCalls[value.output_index] = undefined
                hasFunctionCall = true

                controller.enqueue({
                  type: "tool-input-end",
                  id: value.item.call_id,
                })

                controller.enqueue({
                  type: "tool-call",
                  toolCallId: value.item.call_id,
                  toolName: value.item.name,
                  input: value.item.arguments,
                  providerMetadata: {
                    copilot: {
                      itemId: value.item.id,
                    },
                  },
                })
              } else if (value.item.type === "web_search_call") {
                // 联网搜索完成：发出输入结束、工具调用与结果
                ongoingToolCalls[value.output_index] = undefined

                controller.enqueue({
                  type: "tool-input-end",
                  id: value.item.id,
                })

                controller.enqueue({
                  type: "tool-call",
                  toolCallId: value.item.id,
                  toolName: getHostedToolName("web_search"),
                  input: JSON.stringify({ action: value.item.action }),
                  providerExecuted: true,
                })

                controller.enqueue({
                  type: "tool-result",
                  toolCallId: value.item.id,
                  toolName: getHostedToolName("web_search"),
                  result: { status: value.item.status },
                })
              } else if (value.item.type === "computer_call") {
                // 计算机操作完成：发出输入结束、工具调用与结果
                ongoingToolCalls[value.output_index] = undefined

                controller.enqueue({
                  type: "tool-input-end",
                  id: value.item.id,
                })

                controller.enqueue({
                  type: "tool-call",
                  toolCallId: value.item.id,
                  toolName: "computer_use",
                  input: "",
                  providerExecuted: true,
                })

                controller.enqueue({
                  type: "tool-result",
                  toolCallId: value.item.id,
                  toolName: "computer_use",
                  result: {
                    type: "computer_use_tool_result",
                    status: value.item.status || "completed",
                  },
                })
              } else if (value.item.type === "file_search_call") {
                // 文件搜索完成：清理登记并发出查询与结果
                ongoingToolCalls[value.output_index] = undefined

                controller.enqueue({
                  type: "tool-result",
                  toolCallId: value.item.id,
                  toolName: getHostedToolName("file_search"),
                  result: {
                    queries: value.item.queries,
                    results:
                      value.item.results?.map((result) => ({
                        attributes: result.attributes as Record<string, JSONValue>,
                        fileId: result.file_id,
                        filename: result.filename,
                        score: result.score,
                        text: result.text,
                      })) ?? null,
                  } satisfies z.infer<typeof fileSearchOutputSchema>,
                })
              } else if (value.item.type === "code_interpreter_call") {
                // 代码解释器完成：清理登记并发出输出
                ongoingToolCalls[value.output_index] = undefined

                controller.enqueue({
                  type: "tool-result",
                  toolCallId: value.item.id,
                  toolName: getHostedToolName("code_interpreter"),
                  result: {
                    outputs: value.item.outputs,
                  } satisfies z.infer<typeof codeInterpreterOutputSchema>,
                })
              } else if (value.item.type === "image_generation_call") {
                // 图像生成完成：发出结果
                controller.enqueue({
                  type: "tool-result",
                  toolCallId: value.item.id,
                  toolName: getHostedToolName("image_generation"),
                  result: {
                    result: value.item.result,
                  } satisfies z.infer<typeof imageGenerationOutputSchema>,
                })
              } else if (value.item.type === "message") {
                // 消息完成：关闭对应的文本片段
                if (currentTextId) {
                  controller.enqueue({
                    type: "text-end",
                    id: currentTextId,
                  })
                  currentTextId = null
                }
              } else if (isResponseOutputItemDoneReasoningChunk(value)) {
                // 推理条目完成：结束所有未收尾的摘要段并清理状态
                const activeReasoningPart = activeReasoning[value.output_index]
                if (activeReasoningPart) {
                  for (const [summaryIndex, status] of Object.entries(activeReasoningPart.summaryParts)) {
                    if (status === "concluded") continue
                    controller.enqueue({
                      type: "reasoning-end",
                      id: `${activeReasoningPart.canonicalId}:${summaryIndex}`,
                      providerMetadata: {
                        copilot: {
                          itemId: value.item.id,
                          reasoningEncryptedContent: value.item.encrypted_content ?? null,
                        },
                      },
                    })
                  }
                  delete activeReasoning[value.output_index]
                  if (currentReasoningOutputIndex === value.output_index) {
                    currentReasoningOutputIndex = null
                  }
                }
              }
            } else if (isResponseFunctionCallArgumentsDeltaChunk(value)) {
              // 函数调用参数增量：转发给对应进行中的调用
              const toolCall = ongoingToolCalls[value.output_index]

              if (toolCall != null) {
                controller.enqueue({
                  type: "tool-input-delta",
                  id: toolCall.toolCallId,
                  delta: value.delta,
                })
              }
            } else if (isResponseImageGenerationCallPartialImageChunk(value)) {
              // 图像生成的部分图片：作为中间工具结果发出
              controller.enqueue({
                type: "tool-result",
                toolCallId: value.item_id,
                toolName: getHostedToolName("image_generation"),
                result: {
                  result: value.partial_image_b64,
                } satisfies z.infer<typeof imageGenerationOutputSchema>,
              })
            } else if (isResponseCodeInterpreterCallCodeDeltaChunk(value)) {
              const toolCall = ongoingToolCalls[value.output_index]

              if (toolCall != null) {
                controller.enqueue({
                  type: "tool-input-delta",
                  id: toolCall.toolCallId,
                  // The delta is code, which is embedding in a JSON string.
                  // To escape it, we use JSON.stringify and slice to remove the outer quotes.
                  delta: JSON.stringify(value.delta).slice(1, -1),
                })
              }
            } else if (isResponseCodeInterpreterCallCodeDoneChunk(value)) {
              const toolCall = ongoingToolCalls[value.output_index]

              if (toolCall != null) {
                controller.enqueue({
                  type: "tool-input-delta",
                  id: toolCall.toolCallId,
                  // 代码结束：补上 JSON 字符串的收尾引号与花括号
                  delta: '"}',
                })

                controller.enqueue({
                  type: "tool-input-end",
                  id: toolCall.toolCallId,
                })

                // immediately send the tool call after the input end:
                // 输入结束后立即发出工具调用（服务端已执行）
                controller.enqueue({
                  type: "tool-call",
                  toolCallId: toolCall.toolCallId,
                  toolName: getHostedToolName("code_interpreter"),
                  input: JSON.stringify({
                    code: value.code,
                    containerId: toolCall.codeInterpreter!.containerId,
                  } satisfies z.infer<typeof codeInterpreterInputSchema>),
                  providerExecuted: true,
                })
              }
            } else if (isResponseCreatedChunk(value)) {
              // 响应创建：记录响应 ID 并发出元数据
              responseId = value.response.id
              controller.enqueue({
                type: "response-metadata",
                id: value.response.id,
                timestamp: new Date(value.response.created_at * 1000),
                modelId: value.response.model,
              })
            } else if (isTextDeltaChunk(value)) {
              // Ensure a text-start exists, and normalize deltas to a stable id
              // 确保已有 text-start，并把增量统一到稳定 ID
              if (!currentTextId) {
                currentTextId = value.item_id
                controller.enqueue({
                  type: "text-start",
                  id: currentTextId,
                  providerMetadata: {
                    copilot: { itemId: value.item_id },
                  },
                })
              }

              controller.enqueue({
                type: "text-delta",
                id: currentTextId,
                delta: value.delta,
              })

              if (options.providerOptions?.copilot?.logprobs && value.logprobs) {
                // 请求了 logprobs 时收集每段的对数概率
                logprobs.push(value.logprobs)
              }
            } else if (isResponseReasoningSummaryPartAddedChunk(value)) {
              // 取当前活跃的推理条目
              const activeItem =
                currentReasoningOutputIndex !== null ? activeReasoning[currentReasoningOutputIndex] : null

              // the first reasoning start is pushed in isResponseOutputItemAddedReasoningChunk.
              // 首段摘要在 output_item.added 中已开启；这里处理后续新增的摘要段
              if (activeItem && value.summary_index > 0 && activeItem.summaryParts[value.summary_index] === undefined) {
                // 先收尾所有待结束（can-conclude）的摘要段
                for (const [summaryIndex, status] of Object.entries(activeItem.summaryParts)) {
                  if (status !== "can-conclude") continue
                  controller.enqueue({
                    type: "reasoning-end",
                    id: `${activeItem.canonicalId}:${summaryIndex}`,
                    providerMetadata: {
                      copilot: { itemId: activeItem.canonicalId },
                    },
                  })
                  activeItem.summaryParts[Number(summaryIndex)] = "concluded"
                }
                // 开启新的摘要段
                activeItem.summaryParts[value.summary_index] = "active"

                controller.enqueue({
                  type: "reasoning-start",
                  id: `${activeItem.canonicalId}:${value.summary_index}`,
                  providerMetadata: {
                    copilot: {
                      itemId: activeItem.canonicalId,
                      reasoningEncryptedContent: activeItem.encryptedContent ?? null,
                    },
                  },
                })
              }
            } else if (isResponseReasoningSummaryPartDoneChunk(value)) {
              // 摘要段完成：定位活跃推理条目
              const activeItem =
                currentReasoningOutputIndex !== null ? activeReasoning[currentReasoningOutputIndex] : null
              if (!activeItem || activeItem.summaryParts[value.summary_index] !== "active") return
              if (body.store === false) {
                // 非 store 模式：暂不结束，等推理整体完成时再收尾（保持加密内容最新）
                activeItem.summaryParts[value.summary_index] = "can-conclude"
                return
              }
              controller.enqueue({
                type: "reasoning-end",
                id: `${activeItem.canonicalId}:${value.summary_index}`,
                providerMetadata: {
                  copilot: { itemId: activeItem.canonicalId },
                },
              })
              // 标记该摘要段已结束
              activeItem.summaryParts[value.summary_index] = "concluded"
            } else if (isResponseReasoningSummaryTextDeltaChunk(value)) {
              // 摘要文本增量：转发给对应推理条目的对应摘要段
              const activeItem =
                currentReasoningOutputIndex !== null ? activeReasoning[currentReasoningOutputIndex] : null

              if (activeItem) {
                controller.enqueue({
                  type: "reasoning-delta",
                  id: `${activeItem.canonicalId}:${value.summary_index}`,
                  delta: value.delta,
                  providerMetadata: {
                    copilot: {
                      itemId: activeItem.canonicalId,
                    },
                  },
                })
              }
            } else if (isResponseFinishedChunk(value)) {
              // 响应结束：映射完成原因
              finishReason = {
                unified: mapOpenAIResponseFinishReason({
                  finishReason: value.response.incomplete_details?.reason,
                  hasFunctionCall,
                }),
                raw: value.response.incomplete_details?.reason ?? undefined,
              }
              // 记录各项用量
              usage.inputTokens = value.response.usage.input_tokens
              usage.outputTokens = value.response.usage.output_tokens
              usage.totalTokens = value.response.usage.input_tokens + value.response.usage.output_tokens
              usage.reasoningTokens = value.response.usage.output_tokens_details?.reasoning_tokens ?? undefined
              usage.cachedInputTokens = value.response.usage.input_tokens_details?.cached_tokens ?? undefined
              if (typeof value.response.service_tier === "string") {
                // 记录服务层级
                serviceTier = value.response.service_tier
              }
            } else if (isResponseAnnotationAddedChunk(value)) {
              // 输出文本的引用标注
              if (value.annotation.type === "url_citation") {
                // URL 引用：生成来源片段
                controller.enqueue({
                  type: "source",
                  sourceType: "url",
                  id: self.config.generateId?.() ?? generateId(),
                  url: value.annotation.url,
                  title: value.annotation.title,
                })
              } else if (value.annotation.type === "file_citation") {
                // 文件引用：生成文档来源片段
                controller.enqueue({
                  type: "source",
                  sourceType: "document",
                  id: self.config.generateId?.() ?? generateId(),
                  mediaType: "text/plain",
                  title: value.annotation.quote ?? value.annotation.filename ?? "Document",
                  filename: value.annotation.filename ?? value.annotation.file_id,
                })
              }
            } else if (isErrorChunk(value)) {
              // 服务端错误事件：透传为错误片段
              controller.enqueue({ type: "error", error: value })
            }
          },

          flush(controller) {
            // Close any dangling text part
            // 流结束：关闭未收尾的文本片段
            if (currentTextId) {
              controller.enqueue({ type: "text-end", id: currentTextId })
              currentTextId = null
            }
            // 关闭所有仍未结束的推理摘要段
            for (const activeItem of Object.values(activeReasoning)) {
              for (const [summaryIndex, status] of Object.entries(activeItem.summaryParts)) {
                if (status === "concluded") continue
                controller.enqueue({
                  type: "reasoning-end",
                  id: `${activeItem.canonicalId}:${summaryIndex}`,
                  providerMetadata: { copilot: { itemId: activeItem.canonicalId } },
                })
              }
            }

            // 汇总提供商元数据（响应 ID 等）
            const providerMetadata: SharedV3ProviderMetadata = {
              copilot: {
                responseId,
              },
            }

            if (logprobs.length > 0) {
              // 有收集到 logprobs 时附加
              providerMetadata.copilot.logprobs = logprobs
            }

            if (serviceTier !== undefined) {
              // 有服务层级时附加
              providerMetadata.copilot.serviceTier = serviceTier
            }

            controller.enqueue({
              type: "finish",
              finishReason,
              usage: {
                inputTokens: {
                  total: usage.inputTokens,
                  noCache:
                    usage.inputTokens != null && usage.cachedInputTokens != null
                      ? usage.inputTokens - usage.cachedInputTokens
                      : undefined,
                  cacheRead: usage.cachedInputTokens,
                  cacheWrite: undefined,
                },
                outputTokens: {
                  total: usage.outputTokens,
                  text: undefined,
                  reasoning: usage.reasoningTokens,
                },
                raw: {
                  input_tokens: usage.inputTokens,
                  output_tokens: usage.outputTokens,
                  total_tokens: usage.totalTokens,
                },
              },
              providerMetadata,
            })
          },
        }),
      ),
      request: { body },
      response: { headers: responseHeaders },
    }
  }
}

// 用量结构 schema：输入/输出 token 数及其明细（缓存/推理）
const usageSchema = z.object({
  input_tokens: z.number(),
  input_tokens_details: z.object({ cached_tokens: z.number().nullish() }).nullish(),
  output_tokens: z.number(),
  output_tokens_details: z.object({ reasoning_tokens: z.number().nullish() }).nullish(),
})

// 文本增量事件的 schema
const textDeltaChunkSchema = z.object({
  type: z.literal("response.output_text.delta"),
  item_id: z.string(),
  delta: z.string(),
  logprobs: LOGPROBS_SCHEMA.nullish(),
})

// 错误事件的 schema
const errorChunkSchema = z.object({
  type: z.literal("error"),
  code: z.string(),
  message: z.string(),
  param: z.string().nullish(),
  sequence_number: z.number(),
})

// 响应完成/不完整事件的 schema：携带未完成原因、用量与服务层级
const responseFinishedChunkSchema = z.object({
  type: z.enum(["response.completed", "response.incomplete"]),
  response: z.object({
    incomplete_details: z.object({ reason: z.string() }).nullish(),
    usage: usageSchema,
    service_tier: z.string().nullish(),
  }),
})

// 响应创建事件的 schema：ID、时间戳与模型名
const responseCreatedChunkSchema = z.object({
  type: z.literal("response.created"),
  response: z.object({
    id: z.string(),
    created_at: z.number(),
    model: z.string(),
    service_tier: z.string().nullish(),
  }),
})

// 输出条目新增事件的 schema：item 按类型判别
const responseOutputItemAddedSchema = z.object({
  type: z.literal("response.output_item.added"),
  output_index: z.number(),
  item: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("message"),
      id: z.string(),
    }),
    z.object({
      type: z.literal("reasoning"),
      id: z.string(),
      encrypted_content: z.string().nullish(),
    }),
    z.object({
      type: z.literal("function_call"),
      id: z.string(),
      call_id: z.string(),
      name: z.string(),
      arguments: z.string(),
    }),
    z.object({
      type: z.literal("web_search_call"),
      id: z.string(),
      status: z.string(),
      action: z
        .object({
          type: z.literal("search"),
          query: z.string().optional(),
        })
        .nullish(),
    }),
    z.object({
      type: z.literal("computer_call"),
      id: z.string(),
      status: z.string(),
    }),
    z.object({
      type: z.literal("file_search_call"),
      id: z.string(),
    }),
    z.object({
      type: z.literal("image_generation_call"),
      id: z.string(),
    }),
    z.object({
      type: z.literal("code_interpreter_call"),
      id: z.string(),
      container_id: z.string(),
      code: z.string().nullable(),
      outputs: z
        .array(
          z.discriminatedUnion("type", [
            z.object({ type: z.literal("logs"), logs: z.string() }),
            z.object({ type: z.literal("image"), url: z.string() }),
          ]),
        )
        .nullable(),
      status: z.string(),
    }),
  ]),
})

// 输出条目完成事件的 schema：item 按类型判别（含各类内建工具条目）
const responseOutputItemDoneSchema = z.object({
  type: z.literal("response.output_item.done"),
  output_index: z.number(),
  item: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("message"),
      id: z.string(),
    }),
    z.object({
      type: z.literal("reasoning"),
      id: z.string(),
      encrypted_content: z.string().nullish(),
    }),
    z.object({
      type: z.literal("function_call"),
      id: z.string(),
      call_id: z.string(),
      name: z.string(),
      arguments: z.string(),
      status: z.literal("completed"),
    }),
    codeInterpreterCallItem,
    imageGenerationCallItem,
    webSearchCallItem,
    fileSearchCallItem,
    z.object({
      type: z.literal("computer_call"),
      id: z.string(),
      status: z.literal("completed"),
    }),
  ]),
})

// 函数调用参数增量事件的 schema
const responseFunctionCallArgumentsDeltaSchema = z.object({
  type: z.literal("response.function_call_arguments.delta"),
  item_id: z.string(),
  output_index: z.number(),
  delta: z.string(),
})

// 图像生成部分图片事件的 schema
const responseImageGenerationCallPartialImageSchema = z.object({
  type: z.literal("response.image_generation_call.partial_image"),
  item_id: z.string(),
  output_index: z.number(),
  partial_image_b64: z.string(),
})

// 代码解释器代码增量事件的 schema
const responseCodeInterpreterCallCodeDeltaSchema = z.object({
  type: z.literal("response.code_interpreter_call_code.delta"),
  item_id: z.string(),
  output_index: z.number(),
  delta: z.string(),
})

// 代码解释器代码完成事件的 schema
const responseCodeInterpreterCallCodeDoneSchema = z.object({
  type: z.literal("response.code_interpreter_call_code.done"),
  item_id: z.string(),
  output_index: z.number(),
  code: z.string(),
})

// 输出文本引用标注事件的 schema：URL 引用或文件引用
const responseAnnotationAddedSchema = z.object({
  type: z.literal("response.output_text.annotation.added"),
  annotation: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("url_citation"),
      url: z.string(),
      title: z.string(),
    }),
    z.object({
      type: z.literal("file_citation"),
      file_id: z.string(),
      filename: z.string().nullish(),
      index: z.number().nullish(),
      start_index: z.number().nullish(),
      end_index: z.number().nullish(),
      quote: z.string().nullish(),
    }),
  ]),
})

// 推理摘要段新增事件的 schema
const responseReasoningSummaryPartAddedSchema = z.object({
  type: z.literal("response.reasoning_summary_part.added"),
  item_id: z.string(),
  summary_index: z.number(),
})

// 推理摘要文本增量事件的 schema
const responseReasoningSummaryTextDeltaSchema = z.object({
  type: z.literal("response.reasoning_summary_text.delta"),
  item_id: z.string(),
  summary_index: z.number(),
  delta: z.string(),
})

// 推理摘要段完成事件的 schema
const responseReasoningSummaryPartDoneSchema = z.object({
  type: z.literal("response.reasoning_summary_part.done"),
  item_id: z.string(),
  summary_index: z.number(),
})

// SSE 事件的总联合 schema：所有已知事件类型加上未知事件的宽松兜底
const openaiResponsesChunkSchema = z.union([
  textDeltaChunkSchema,
  responseFinishedChunkSchema,
  responseCreatedChunkSchema,
  responseOutputItemAddedSchema,
  responseOutputItemDoneSchema,
  responseFunctionCallArgumentsDeltaSchema,
  responseImageGenerationCallPartialImageSchema,
  responseCodeInterpreterCallCodeDeltaSchema,
  responseCodeInterpreterCallCodeDoneSchema,
  responseAnnotationAddedSchema,
  responseReasoningSummaryPartAddedSchema,
  responseReasoningSummaryPartDoneSchema,
  responseReasoningSummaryTextDeltaSchema,
  errorChunkSchema,
  z.object({ type: z.string() }).loose(), // fallback for unknown chunks
])

// 类型工具：从联合类型中按 type 字面量提取对应成员
type ExtractByType<T, K extends T extends { type: infer U } ? U : never> = T extends { type: K } ? T : never

// 以下是一组按事件 type 字段收窄 chunk 类型的类型守卫

// 是否为文本增量事件
function isTextDeltaChunk(
  chunk: z.infer<typeof openaiResponsesChunkSchema>,
): chunk is z.infer<typeof textDeltaChunkSchema> {
  return chunk.type === "response.output_text.delta"
}

// 是否为输出条目完成事件
function isResponseOutputItemDoneChunk(
  chunk: z.infer<typeof openaiResponsesChunkSchema>,
): chunk is z.infer<typeof responseOutputItemDoneSchema> {
  return chunk.type === "response.output_item.done"
}

// 是否为“推理条目完成”事件（在完成事件基础上再收窄 item 为 reasoning）
function isResponseOutputItemDoneReasoningChunk(chunk: z.infer<typeof openaiResponsesChunkSchema>): chunk is z.infer<
  typeof responseOutputItemDoneSchema
> & {
  item: ExtractByType<z.infer<typeof responseOutputItemDoneSchema>["item"], "reasoning">
} {
  return isResponseOutputItemDoneChunk(chunk) && chunk.item.type === "reasoning"
}

// 是否为响应结束事件（完成或不完整）
function isResponseFinishedChunk(
  chunk: z.infer<typeof openaiResponsesChunkSchema>,
): chunk is z.infer<typeof responseFinishedChunkSchema> {
  return chunk.type === "response.completed" || chunk.type === "response.incomplete"
}

// 是否为响应创建事件
function isResponseCreatedChunk(
  chunk: z.infer<typeof openaiResponsesChunkSchema>,
): chunk is z.infer<typeof responseCreatedChunkSchema> {
  return chunk.type === "response.created"
}

// 是否为函数调用参数增量事件
function isResponseFunctionCallArgumentsDeltaChunk(
  chunk: z.infer<typeof openaiResponsesChunkSchema>,
): chunk is z.infer<typeof responseFunctionCallArgumentsDeltaSchema> {
  return chunk.type === "response.function_call_arguments.delta"
}
// 是否为图像生成部分图片事件
function isResponseImageGenerationCallPartialImageChunk(
  chunk: z.infer<typeof openaiResponsesChunkSchema>,
): chunk is z.infer<typeof responseImageGenerationCallPartialImageSchema> {
  return chunk.type === "response.image_generation_call.partial_image"
}

// 是否为代码解释器代码增量事件
function isResponseCodeInterpreterCallCodeDeltaChunk(
  chunk: z.infer<typeof openaiResponsesChunkSchema>,
): chunk is z.infer<typeof responseCodeInterpreterCallCodeDeltaSchema> {
  return chunk.type === "response.code_interpreter_call_code.delta"
}

// 是否为代码解释器代码完成事件
function isResponseCodeInterpreterCallCodeDoneChunk(
  chunk: z.infer<typeof openaiResponsesChunkSchema>,
): chunk is z.infer<typeof responseCodeInterpreterCallCodeDoneSchema> {
  return chunk.type === "response.code_interpreter_call_code.done"
}

// 是否为输出条目新增事件
function isResponseOutputItemAddedChunk(
  chunk: z.infer<typeof openaiResponsesChunkSchema>,
): chunk is z.infer<typeof responseOutputItemAddedSchema> {
  return chunk.type === "response.output_item.added"
}

// 是否为“推理条目新增”事件（在新增事件基础上再收窄 item 为 reasoning）
function isResponseOutputItemAddedReasoningChunk(chunk: z.infer<typeof openaiResponsesChunkSchema>): chunk is z.infer<
  typeof responseOutputItemAddedSchema
> & {
  item: ExtractByType<z.infer<typeof responseOutputItemAddedSchema>["item"], "reasoning">
} {
  return isResponseOutputItemAddedChunk(chunk) && chunk.item.type === "reasoning"
}

// 是否为引用标注事件
function isResponseAnnotationAddedChunk(
  chunk: z.infer<typeof openaiResponsesChunkSchema>,
): chunk is z.infer<typeof responseAnnotationAddedSchema> {
  return chunk.type === "response.output_text.annotation.added"
}

// 是否为推理摘要段新增事件
function isResponseReasoningSummaryPartAddedChunk(
  chunk: z.infer<typeof openaiResponsesChunkSchema>,
): chunk is z.infer<typeof responseReasoningSummaryPartAddedSchema> {
  return chunk.type === "response.reasoning_summary_part.added"
}

// 是否为推理摘要段完成事件
function isResponseReasoningSummaryPartDoneChunk(
  chunk: z.infer<typeof openaiResponsesChunkSchema>,
): chunk is z.infer<typeof responseReasoningSummaryPartDoneSchema> {
  return chunk.type === "response.reasoning_summary_part.done"
}

// 是否为推理摘要文本增量事件
function isResponseReasoningSummaryTextDeltaChunk(
  chunk: z.infer<typeof openaiResponsesChunkSchema>,
): chunk is z.infer<typeof responseReasoningSummaryTextDeltaSchema> {
  return chunk.type === "response.reasoning_summary_text.delta"
}

// 是否为错误事件
function isErrorChunk(chunk: z.infer<typeof openaiResponsesChunkSchema>): chunk is z.infer<typeof errorChunkSchema> {
  return chunk.type === "error"
}

// TODO AI SDK 6: use optional here instead of nullish
// copilot 提供商专属选项的 schema（多数字段允许 null/undefined，宽松处理）
const openaiResponsesProviderOptionsSchema = z.object({
  // 请求额外附带的数据种类
  include: z
    .array(z.enum(["reasoning.encrypted_content", "file_search_call.results", "message.output_text.logprobs"]))
    .nullish(),
  // 系统级指令
  instructions: z.string().nullish(),

  /**
   * Return the log probabilities of the tokens.
   *
   * Setting to true will return the log probabilities of the tokens that
   * were generated.
   *
   * Setting to a number will return the log probabilities of the top n
   * tokens that were generated.
   *
   * @see https://platform.openai.com/docs/api-reference/responses/create
   * @see https://cookbook.openai.com/examples/using_logprobs
   */
  logprobs: z.union([z.boolean(), z.number().min(1).max(TOP_LOGPROBS_MAX)]).optional(),

  /**
   * The maximum number of total calls to built-in tools that can be processed in a response.
   * This maximum number applies across all built-in tool calls, not per individual tool.
   * Any further attempts to call a tool by the model will be ignored.
   */
  // 内建工具调用总次数上限（跨所有内建工具）
  maxToolCalls: z.number().nullish(),

  // 附加元数据
  metadata: z.any().nullish(),
  // 是否允许并行工具调用
  parallelToolCalls: z.boolean().nullish(),
  // 上一次响应 ID
  previousResponseId: z.string().nullish(),
  // 提示缓存键
  promptCacheKey: z.string().nullish(),
  // 推理力度
  reasoningEffort: z.string().nullish(),
  // 推理摘要模式
  reasoningSummary: z.string().nullish(),
  // 安全标识
  safetyIdentifier: z.string().nullish(),
  // 服务层级
  serviceTier: z.enum(["auto", "flex", "priority"]).nullish(),
  // 是否服务端存储
  store: z.boolean().nullish(),
  // 是否强制 JSON Schema 严格模式
  strictJsonSchema: z.boolean().nullish(),
  // 输出冗长度
  textVerbosity: z.enum(["low", "medium", "high"]).nullish(),
  // 终端用户标识
  user: z.string().nullish(),
})

// 提供商专属选项的导出类型
export type OpenAIResponsesProviderOptions = z.infer<typeof openaiResponsesProviderOptionsSchema>
