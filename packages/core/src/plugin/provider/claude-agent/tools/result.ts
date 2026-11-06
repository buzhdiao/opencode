// 导出 ToolResult 命名空间，供其他模块引用本文件内容
export * as ToolResult from "./result.js"

// 导入 AI SDK 的文件块、提示词、工具结果输出与工具结果块类型
import type {
  LanguageModelV3FilePart,
  LanguageModelV3Prompt,
  LanguageModelV3ToolResultOutput,
  LanguageModelV3ToolResultPart,
} from "@ai-sdk/provider"
// 导入 MCP 的工具调用结果类型
import type { CallToolResult } from "@modelcontextprotocol/server"
// 导入 Provider schema（含 claudeAgent 的 providerOptions 键）
import { Provider } from "@opencode/schema/provider"
// 导入“转换为 Claude 消息”的工具
import { ConvertToClaudeMessage } from "../language-model/convert-to-claude-message.js"
// 导入指纹模块：用于按组切分工具结果消息
import { Fingerprint } from "../sync/fingerprint.js"

// 工具结果的结构：MCP 格式结果 + 可选的“替换内容块”（供 PostToolUse 钩子改写 Claude 看到的结果）
export interface Result {
  // MCP 格式的调用结果
  readonly mcp: CallToolResult
  // 替换用的内容块列表（无需替换时为 undefined）
  readonly replacement: ConvertToClaudeMessage.ContentBlock[] | undefined
}

// 把 AI SDK 的工具结果输出转换为 MCP 结果与 Claude 内容块
export function convert(
  // 工具结果输出（文本/JSON/内容列表等）
  output: LanguageModelV3ToolResultOutput,
  // 需要附带的文件列表（可选）
  files: readonly LanguageModelV3FilePart[] = [],
  // 工具是否执行失败（可选，默认 false）
  failed = false,
): Result {
  // 初始化内容块数组（文本块或文件块）
  const parts: Array<{ type: "text"; text: string } | LanguageModelV3FilePart> = []
  // 按输出类型分派
  switch (output.type) {
    // 纯文本或错误文本：直接作为文本块
    case "text":
    case "error-text":
      parts.push({ type: "text", text: output.value })
      break
    // JSON 或错误 JSON：序列化为文本块
    case "json":
    case "error-json":
      parts.push({ type: "text", text: JSON.stringify(output.value) })
      break
    // 执行被拒绝：使用拒绝原因或默认提示
    case "execution-denied":
      parts.push({ type: "text", text: output.reason ?? "Tool execution was denied by the user." })
      break
    // 内容列表：逐块转换
    case "content":
      for (const part of output.value) {
        // 文本块直接收集
        if (part.type === "text") {
          parts.push({ type: "text", text: part.text })
          continue
        }
        // 二进制图像/文件数据：作为文件块收集
        if (part.type === "image-data" || part.type === "file-data") {
          parts.push({ type: "file", mediaType: part.mediaType, data: part.data })
          continue
        }
        // URL 图像：只取图像块；URL 图像不带媒体类型发送
        if (part.type === "image-url") {
          // Only picks an image block. URL images are sent without a media type.
          parts.push({ type: "file", mediaType: "image/png", data: new URL(part.url) })
          continue
        }
        // 其余类型 Claude Code 不支持，抛错
        throw new Error(`Claude Code does not support ${part.type} tool output`)
      }
      break
  }
  // 追加需要附带的文件块
  parts.push(...files)
  // 用“单条 user 消息”的形式把所有块转换为 Claude 内容块
  const content = ConvertToClaudeMessage.content([{ role: "user", content: parts }])
  // 判断是否为错误结果：显式失败或输出类型本身表示错误/被拒
  const isError =
    failed || output.type === "error-text" || output.type === "error-json" || output.type === "execution-denied"
  // 初始化 MCP 结果（内容稍后填充）
  const mcp: CallToolResult = { content: [], isError }
  // 标记是否存在 MCP 无法承载的内容块（需要替换输出）
  let replace = false
  // 遍历 Claude 内容块，填充 MCP 结果
  for (const block of content) {
    // 文本块：直接放入 MCP 内容
    if (block.type === "text") {
      mcp.content.push({ type: "text", text: block.text })
      continue
    }
    // base64 图像块：MCP 支持以 image 形式承载
    if (block.type === "image" && block.source.type === "base64") {
      mcp.content.push({ type: "image", mimeType: block.source.media_type, data: block.source.data })
      continue
    }
    // 文档等 MCP 承载不了的内容：置替换标记，并放入占位提示文本
    replace = true
    mcp.content.push({ type: "text", text: "Attached document or image follows." })
  }
  // PostToolUse 钩子会替换 tool_result.content，因此需要的是内容块本身而非 MCP 信封。
  // The PostToolUse hook replaces tool_result.content, so it needs content blocks rather than an MCP envelope.
  return { mcp, replacement: replace ? content : undefined }
}

// 从提示词中收集从 start 开始的连续工具结果组，转换为 Result 映射
export function collect(prompt: LanguageModelV3Prompt, start: number) {
  // 结果映射：工具调用 ID -> Result
  const results = new Map<string, Result>()
  // 记录扫描到的结束位置
  let end = start
  // 标记是否出现了被中止的工具
  let aborted = false
  // 对从 start 开始的提示词按组扫描
  for (const group of Fingerprint.groups(prompt.slice(start))) {
    // 只处理连续的 tool 组；遇到其他角色即停止
    if (group.role !== "tool") break
    // 取出该组内的消息
    const messages = prompt.slice(start + group.start, start + group.end)
    // 收集该组内的工具结果块
    const tools: LanguageModelV3ToolResultPart[] = []
    // 收集该组内用户消息附带的文件
    const files: LanguageModelV3FilePart[] = []
    // 遍历组内消息
    for (const message of messages) {
      // tool 消息：收集工具结果块
      if (message.role === "tool") {
        for (const part of message.content) {
          if (part.type === "tool-result") tools.push(part)
        }
      }
      // user 消息：收集文件块
      if (message.role === "user") {
        for (const part of message.content) {
          if (part.type === "file") files.push(part)
        }
      }
    }
    // OpenCode 会把该组的媒体放在紧随其后的 user 消息里；把它们附加到该组的最后一个结果上。
    // OpenCode puts the group's media in a following user message; attach it to the group's last result.
    for (let i = 0; i < tools.length; i++) {
      // 取出当前工具结果块
      const tool = tools[i]!
      // 读取 providerOptions 中的 claudeAgent 标记
      const flags = tool.providerOptions?.[Provider.ID.claudeAgent]
      // 标记了 toolAborted：记录中止状态
      if (flags?.toolAborted === true) aborted = true
      // 判断是否为该组最后一个工具结果
      const isLast = i === tools.length - 1
      // 转换并记录：文件只附加到最后一个结果；标记过 toolError 的视为失败
      results.set(tool.toolCallId, convert(tool.output, isLast ? files : [], flags?.toolError === true))
    }
    // 更新结束位置为该组末尾
    end = start + group.end
  }
  // 返回结果映射、结束位置与中止标记
  return { results, end, aborted }
}
