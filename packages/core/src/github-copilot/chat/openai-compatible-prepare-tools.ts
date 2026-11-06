// 从 AI SDK provider 包导入类型与错误类：调用选项、共享警告类型、不支持功能错误
import { type LanguageModelV3CallOptions, type SharedV3Warning, UnsupportedFunctionalityError } from "@ai-sdk/provider"

// 导出 prepareTools：把 AI SDK 的工具定义转换为 OpenAI 兼容的请求字段，并收集警告
export function prepareTools({
  tools,
  toolChoice,
}: {
  // tools：统一格式的工具列表
  tools: LanguageModelV3CallOptions["tools"]
  // toolChoice：工具选择策略（自动/指定工具等）
  toolChoice?: LanguageModelV3CallOptions["toolChoice"]
}): {
  // 转换后的 tools 字段：无工具时为 undefined
  tools:
    | undefined
    | Array<{
        type: "function"
        function: {
          name: string
          description: string | undefined
          parameters: unknown
        }
      }>
  // 转换后的 toolChoice 字段
  toolChoice: { type: "function"; function: { name: string } } | "auto" | "none" | "required" | undefined
  // 转换过程中产生的兼容性警告
  toolWarnings: SharedV3Warning[]
} {
  // 原有注释：当 tools 数组为空时改为 undefined，以避免请求报错：
  // when the tools array is empty, change it to undefined to prevent errors:
  tools = tools?.length ? tools : undefined

  // 警告收集列表
  const toolWarnings: SharedV3Warning[] = []

  // 没有任何工具：直接返回空结果（toolChoice 也一并丢弃）
  if (tools == null) {
    return { tools: undefined, toolChoice: undefined, toolWarnings }
  }

  // 转换结果的累积列表
  const openaiCompatTools: Array<{
    type: "function"
    function: {
      name: string
      description: string | undefined
      parameters: unknown
    }
  }> = []

  // 逐个转换工具定义
  for (const tool of tools) {
    // provider 专属工具不受 OpenAI 兼容接口支持：记警告
    if (tool.type === "provider") {
      toolWarnings.push({ type: "unsupported", feature: `tool type: ${tool.type}` })
    } else {
      // 普通工具：映射为 OpenAI 的 function 工具结构
      openaiCompatTools.push({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      })
    }
  }

  // 未指定工具选择策略：只返回工具列表
  if (toolChoice == null) {
    return { tools: openaiCompatTools, toolChoice: undefined, toolWarnings }
  }

  // 取策略类型
  const type = toolChoice.type

  // 按策略类型分支
  switch (type) {
    // auto/none/required 直接透传
    case "auto":
    case "none":
    case "required":
      return { tools: openaiCompatTools, toolChoice: type, toolWarnings }
    // 指定工具：转换为 OpenAI 的 function 选择结构
    case "tool":
      return {
        tools: openaiCompatTools,
        toolChoice: {
          type: "function",
          function: { name: toolChoice.toolName },
        },
        toolWarnings,
      }
    // 穷尽性检查：未知策略说明类型系统被绕过，直接报错
    default: {
      const _exhaustiveCheck: never = type
      throw new UnsupportedFunctionalityError({
        functionality: `tool choice type: ${_exhaustiveCheck}`,
      })
    }
  }
}
