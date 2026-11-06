// 引入 AI SDK 的调用选项、提供商工具、警告与不支持功能错误类型
import {
  type LanguageModelV3CallOptions,
  type LanguageModelV3ProviderTool,
  type SharedV3Warning,
  UnsupportedFunctionalityError,
} from "@ai-sdk/provider"
// 引入各内建（hosted）工具的参数 schema
import { codeInterpreterArgsSchema } from "./tool/code-interpreter.js"
import { fileSearchArgsSchema } from "./tool/file-search.js"
import { webSearchArgsSchema } from "./tool/web-search.js"
import { webSearchPreviewArgsSchema } from "./tool/web-search-preview.js"
import { imageGenerationArgsSchema } from "./tool/image-generation.js"
// 引入 Responses API 工具类型定义
import type { OpenAIResponsesTool } from "./openai-responses-api-types.js"

// 托管（hosted）工具的描述：请求侧类型与响应侧类型的映射
export type ResponsesHostedTool = {
  // 工具名称
  name: string
  // 请求中使用的工具类型
  type: "file_search" | "web_search_preview" | "web_search" | "code_interpreter" | "image_generation"
  // 响应流中回传该工具输出时使用的类型
  responseType: "file_search" | "web_search" | "code_interpreter" | "image_generation"
}

// 将 AI SDK 提供商工具 ID 映射为 Responses 托管工具；不匹配则返回 undefined
export function getResponsesHostedTool(tool: LanguageModelV3ProviderTool): ResponsesHostedTool | undefined {
  // 按工具 ID 逐类映射
  switch (tool.id) {
    // 文件搜索
    case "openai.file_search":
      return { name: tool.name, type: "file_search", responseType: "file_search" }
    // 联网搜索预览（请求类型为 preview，响应类型归一为 web_search）
    case "openai.web_search_preview":
      return { name: tool.name, type: "web_search_preview", responseType: "web_search" }
    // 联网搜索
    case "openai.web_search":
      return { name: tool.name, type: "web_search", responseType: "web_search" }
    // 代码解释器
    case "openai.code_interpreter":
      return { name: tool.name, type: "code_interpreter", responseType: "code_interpreter" }
    // 图像生成
    case "openai.image_generation":
      return { name: tool.name, type: "image_generation", responseType: "image_generation" }
  }
  // 非 Responses 托管工具
  return undefined
}

// 将通用工具定义与工具选择转换为 Responses API 的 tools / tool_choice，并解析托管工具
export function prepareResponsesTools({
  tools,
  toolChoice,
  strictJsonSchema,
}: {
  // 调用选项中的工具列表
  tools: LanguageModelV3CallOptions["tools"]
  // 可选：工具选择策略
  toolChoice?: LanguageModelV3CallOptions["toolChoice"]
  // 是否强制 JSON Schema 严格模式
  strictJsonSchema: boolean
}): {
  // 转换后的 Responses 工具数组
  tools?: Array<OpenAIResponsesTool>
  // 转换后的工具选择
  toolChoice?:
    | "auto"
    | "none"
    | "required"
    | { type: "file_search" }
    | { type: "web_search_preview" }
    | { type: "web_search" }
    | { type: "function"; name: string }
    | { type: "code_interpreter" }
    | { type: "image_generation" }
  // 识别出的托管工具列表
  hostedTools: ResponsesHostedTool[]
  // 工具选择明确指定的托管工具（若有）
  selectedHostedTool?: ResponsesHostedTool
  // 转换过程中的警告
  toolWarnings: SharedV3Warning[]
} {
  // when the tools array is empty, change it to undefined to prevent errors:
  // 空数组统一改为 undefined，避免后续处理出错
  tools = tools?.length ? tools : undefined

  // 警告收集列表
  const toolWarnings: SharedV3Warning[] = []

  if (tools == null) {
    // 无工具时直接返回空结果
    return { tools: undefined, toolChoice: undefined, hostedTools: [], toolWarnings }
  }

  // 筛选出所有 provider 类型且能映射为 Responses 托管工具的项
  const hostedTools = tools.flatMap((tool) => {
    // 非提供商工具跳过
    if (tool.type !== "provider") return []
    // 尝试映射为托管工具
    const hostedTool = getResponsesHostedTool(tool)
    return hostedTool ? [hostedTool] : []
  })
  // 工具选择若指定了具体工具名则取出
  const selectedToolName = toolChoice?.type === "tool" ? toolChoice.toolName : undefined
  // 找出与选中名称匹配的所有工具定义
  const selectedTools = selectedToolName === undefined ? [] : tools.filter((tool) => tool.name === selectedToolName)
  if (selectedTools.length > 1) {
    // 同名定义多于一个会导致歧义，直接报错
    throw new UnsupportedFunctionalityError({
      functionality: `ambiguous tool choice '${selectedToolName}': multiple tool definitions share this name`,
    })
  }
  // 若选中的是 provider 工具，则得到对应的托管工具描述
  const selectedHostedTool =
    selectedTools[0]?.type === "provider" ? getResponsesHostedTool(selectedTools[0]) : undefined

  // 检查响应类型歧义：多个托管工具会产生相同 responseType 且未被显式选择时无法区分
  const ambiguousHostedResponse =
    toolChoice?.type === "none" || toolChoice?.type === "tool"
      ? undefined
      : hostedTools.find(
          (tool) =>
            new Set(
              hostedTools.filter((candidate) => candidate.responseType === tool.responseType).map((item) => item.name),
            ).size > 1,
        )
  if (ambiguousHostedResponse) {
    // 收集产生歧义的同响应类型工具名并报错
    const names = new Set(
      hostedTools.filter((tool) => tool.responseType === ambiguousHostedResponse.responseType).map((tool) => tool.name),
    )
    throw new UnsupportedFunctionalityError({
      functionality: `ambiguous ${ambiguousHostedResponse.responseType} response for hosted tools: ${[...names].join(", ")}`,
    })
  }

  if (selectedHostedTool) {
    // 指定了托管工具时，还需确保同类型工具没有同名歧义
    const names = new Set(hostedTools.filter((tool) => tool.type === selectedHostedTool.type).map((tool) => tool.name))
    if (names.size > 1) {
      throw new UnsupportedFunctionalityError({
        functionality: `ambiguous ${selectedHostedTool.type} tool choice for hosted tools: ${[...names].join(", ")}`,
      })
    }
  }

  // 转换结果的 Responses 工具数组
  const openaiTools: Array<OpenAIResponsesTool> = []

  // 逐个转换工具定义
  for (const tool of tools) {
    // 按工具类型分发
    switch (tool.type) {
      // 普通函数工具
      case "function":
        openaiTools.push({
          type: "function",
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
          strict: tool.strict ?? strictJsonSchema,
        })
        break
      // 提供商（内建托管）工具
      case "provider": {
        // 按提供商工具 ID 分发
        switch (tool.id) {
          // 文件搜索工具：解析参数并映射字段
          case "openai.file_search": {
            const args = fileSearchArgsSchema.parse(tool.args)

            openaiTools.push({
              type: "file_search",
              vector_store_ids: args.vectorStoreIds,
              max_num_results: args.maxNumResults,
              ranking_options: args.ranking
                ? {
                    ranker: args.ranking.ranker,
                    score_threshold: args.ranking.scoreThreshold,
                  }
                : undefined,
              filters: args.filters,
            })

            break
          }
          // 联网搜索预览工具
          case "openai.web_search_preview": {
            const args = webSearchPreviewArgsSchema.parse(tool.args)
            openaiTools.push({
              type: "web_search_preview",
              search_context_size: args.searchContextSize,
              user_location: args.userLocation,
            })
            break
          }
          // 联网搜索工具（带域名过滤）
          case "openai.web_search": {
            const args = webSearchArgsSchema.parse(tool.args)
            openaiTools.push({
              type: "web_search",
              filters: args.filters != null ? { allowed_domains: args.filters.allowedDomains } : undefined,
              search_context_size: args.searchContextSize,
              user_location: args.userLocation,
            })
            break
          }
          // 代码解释器工具：容器参数归一化
          case "openai.code_interpreter": {
            const args = codeInterpreterArgsSchema.parse(tool.args)
            openaiTools.push({
              type: "code_interpreter",
              container:
                args.container == null
                  ? { type: "auto", file_ids: undefined }
                  : typeof args.container === "string"
                    ? args.container
                    : { type: "auto", file_ids: args.container.fileIds },
            })
            break
          }
          // 图像生成工具
          case "openai.image_generation": {
            const args = imageGenerationArgsSchema.parse(tool.args)
            openaiTools.push({
              type: "image_generation",
              background: args.background,
              input_fidelity: args.inputFidelity,
              input_image_mask: args.inputImageMask
                ? {
                    file_id: args.inputImageMask.fileId,
                    image_url: args.inputImageMask.imageUrl,
                  }
                : undefined,
              model: args.model,
              moderation: args.moderation,
              partial_images: args.partialImages,
              quality: args.quality,
              output_compression: args.outputCompression,
              output_format: args.outputFormat,
              size: args.size,
            })
            break
          }
        }
        break
      }
      // 其他未知类型：记录不支持警告
      default:
        toolWarnings.push({ type: "unsupported", feature: "tool type" })
        break
    }
  }

  if (toolChoice == null) {
    // 未指定工具选择时原样返回
    return { tools: openaiTools, toolChoice: undefined, hostedTools, selectedHostedTool, toolWarnings }
  }

  // 取工具选择类型
  const type = toolChoice.type

  // 按类型转换为 Responses 的 tool_choice
  switch (type) {
    // auto/none/required 三种直接透传
    case "auto":
    case "none":
    case "required":
      return { tools: openaiTools, toolChoice: type, hostedTools, selectedHostedTool, toolWarnings }
    // 指定具体工具：托管工具用其类型，否则按函数名选择
    case "tool": {
      return {
        tools: openaiTools,
        toolChoice: selectedHostedTool
          ? { type: selectedHostedTool.type }
          : { type: "function", name: toolChoice.toolName },
        hostedTools,
        selectedHostedTool,
        toolWarnings,
      }
    }
    // 穷举兜底：未知选择类型报错
    default: {
      const _exhaustiveCheck: never = type
      throw new UnsupportedFunctionalityError({
        functionality: `tool choice type: ${_exhaustiveCheck}`,
      })
    }
  }
}
