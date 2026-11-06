// 引入 AI SDK 的 JSON Schema（草案 7）类型
import type { JSONSchema7 } from "@ai-sdk/provider"

// Responses API 输入的整体类型：输入条目的数组
export type OpenAIResponsesInput = Array<OpenAIResponsesInputItem>

// 输入条目的联合类型：涵盖系统/用户/助手消息与各种调用、引用条目
export type OpenAIResponsesInputItem =
  | OpenAIResponsesSystemMessage
  | OpenAIResponsesUserMessage
  | OpenAIResponsesAssistantMessage
  | OpenAIResponsesFunctionCall
  | OpenAIResponsesFunctionCallOutput
  | OpenAIResponsesComputerCall
  | OpenAIResponsesReasoning
  | OpenAIResponsesItemReference
  | OpenAIResponsesMcpApprovalResponse

// include 参数的合法取值：请求响应中额外附带的数据种类
export type OpenAIResponsesIncludeValue =
  | "web_search_call.action.sources"
  | "code_interpreter_call.outputs"
  | "computer_call_output.output.image_url"
  | "file_search_call.results"
  | "message.input_image.image_url"
  | "message.output_text.logprobs"
  | "reasoning.encrypted_content"

// include 选项：取值数组，或 undefined/null 表示不附带
export type OpenAIResponsesIncludeOptions = Array<OpenAIResponsesIncludeValue> | undefined | null

// 系统消息：角色可为 system 或 developer，内容为纯文本
export type OpenAIResponsesSystemMessage = {
  role: "system" | "developer"
  content: string
}

// 用户消息：内容为文本/图片/文件等多种输入部件
export type OpenAIResponsesUserMessage = {
  role: "user"
  content: Array<
    // 文本输入
    | { type: "input_text"; text: string }
    // 图片输入（URL 形式）
    | { type: "input_image"; image_url: string }
    // 图片输入（文件 ID 形式）
    | { type: "input_image"; file_id: string }
    // 文件输入（URL 形式）
    | { type: "input_file"; file_url: string }
    // 文件输入（文件名 + base64 数据）
    | { type: "input_file"; filename: string; file_data: string }
    // 文件输入（文件 ID 形式）
    | { type: "input_file"; file_id: string }
  >
}

// 助手消息：输出文本数组，可选条目 ID（store 模式下用于关联）
export type OpenAIResponsesAssistantMessage = {
  role: "assistant"
  content: Array<{ type: "output_text"; text: string }>
  id?: string
}

// 函数调用条目：调用 ID、函数名与 JSON 字符串参数
export type OpenAIResponsesFunctionCall = {
  type: "function_call"
  call_id: string
  name: string
  arguments: string
  id?: string
}

// 函数调用输出条目：以 call_id 关联调用并回传字符串结果
export type OpenAIResponsesFunctionCallOutput = {
  type: "function_call_output"
  call_id: string
  output: string
}

// 计算机操作调用条目（computer use）
export type OpenAIResponsesComputerCall = {
  type: "computer_call"
  id: string
  status?: string
}

// 条目引用：通过 ID 指向服务端存储的已有条目
export type OpenAIResponsesItemReference = {
  type: "item_reference"
  id: string
}

// MCP 审批响应：对应审批请求 ID 与批准与否
export type OpenAIResponsesMcpApprovalResponse = {
  type: "mcp_approval_response"
  approval_request_id: string
  approve: boolean
}

/**
 * A filter used to compare a specified attribute key to a given value using a defined comparison operation.
 */
// 文件搜索工具的比较过滤器：将指定属性键与给定值按比较操作符对比
export type OpenAIResponsesFileSearchToolComparisonFilter = {
  /**
   * The key to compare against the value.
   */
  // 用于比较的属性键
  key: string

  /**
   * Specifies the comparison operator: eq, ne, gt, gte, lt, lte.
   */
  // 比较操作符：等于/不等于/大于/大于等于/小于/小于等于
  type: "eq" | "ne" | "gt" | "gte" | "lt" | "lte"

  /**
   * The value to compare against the attribute key; supports string, number, or boolean types.
   */
  // 参与比较的值，支持字符串、数字或布尔
  value: string | number | boolean
}

/**
 * Combine multiple filters using and or or.
 */
// 文件搜索工具的复合过滤器：用 and/or 组合多个过滤器
export type OpenAIResponsesFileSearchToolCompoundFilter = {
  /**
   * Type of operation: and or or.
   */
  // 组合方式：and 或 or
  type: "and" | "or"

  /**
   * Array of filters to combine. Items can be ComparisonFilter or CompoundFilter.
   */
  // 被组合的过滤器数组，元素可以是比较过滤器或嵌套的复合过滤器
  filters: Array<OpenAIResponsesFileSearchToolComparisonFilter | OpenAIResponsesFileSearchToolCompoundFilter>
}

// Responses API 内建工具的联合类型
export type OpenAIResponsesTool =
  // 自定义函数工具：名称、描述、JSON Schema 参数与 strict 模式开关
  | {
      type: "function"
      name: string
      description: string | undefined
      parameters: JSONSchema7
      strict: boolean | undefined
    }
  // 联网搜索工具：域名过滤、搜索上下文规模与用户位置
  | {
      type: "web_search"
      filters: { allowed_domains: string[] | undefined } | undefined
      search_context_size: "low" | "medium" | "high" | undefined
      user_location:
        | {
            type: "approximate"
            city?: string
            country?: string
            region?: string
            timezone?: string
          }
        | undefined
    }
  // 联网搜索预览版工具：搜索上下文规模与用户位置
  | {
      type: "web_search_preview"
      search_context_size: "low" | "medium" | "high" | undefined
      user_location:
        | {
            type: "approximate"
            city?: string
            country?: string
            region?: string
            timezone?: string
          }
        | undefined
    }
  // 代码解释器工具：容器可以是 ID 字符串或自动创建（可附带初始文件）
  | {
      type: "code_interpreter"
      container: string | { type: "auto"; file_ids: string[] | undefined }
    }
  // 文件搜索工具：向量库 ID 列表、最大结果数、排序选项与过滤器
  | {
      type: "file_search"
      vector_store_ids: string[]
      max_num_results: number | undefined
      ranking_options: { ranker?: string; score_threshold?: number } | undefined
      filters: OpenAIResponsesFileSearchToolComparisonFilter | OpenAIResponsesFileSearchToolCompoundFilter | undefined
    }
  // 图像生成工具：背景、输入保真度、蒙版、模型、审核、压缩/格式/尺寸等参数
  | {
      type: "image_generation"
      background: "auto" | "opaque" | "transparent" | undefined
      input_fidelity: "low" | "high" | undefined
      input_image_mask:
        | {
            file_id: string | undefined
            image_url: string | undefined
          }
        | undefined
      model: string | undefined
      moderation: "auto" | undefined
      output_compression: number | undefined
      output_format: "png" | "jpeg" | "webp" | undefined
      partial_images: number | undefined
      quality: "auto" | "low" | "medium" | "high" | undefined
      size: "auto" | "1024x1024" | "1024x1536" | "1536x1024" | undefined
    }

// 推理条目：条目 ID、可选加密思考内容与摘要文本数组
export type OpenAIResponsesReasoning = {
  type: "reasoning"
  id: string
  encrypted_content?: string | null
  summary: Array<{
    type: "summary_text"
    text: string
  }>
}
