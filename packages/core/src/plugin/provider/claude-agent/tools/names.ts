// 导出 ToolNames 命名空间，供其他模块引用本文件内容
export * as ToolNames from "./names.js"

// 导入 Node 的哈希工具（用于生成名称的短指纹）
import { createHash } from "node:crypto"
// 导入 AI SDK 的函数工具类型定义
import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider"

// OpenCode 工具在 MCP 命名空间中的统一前缀
export const PREFIX = "mcp__opencode__"

// 把工具名压缩成符合 Claude/MCP 命名限制的短名称（必要时加哈希保证唯一）
export function short(name: string) {
  // 名称长度上限 = 64 减去前缀长度
  const limit = 64 - PREFIX.length
  // 若名称已足够短且只含合法字符（字母数字下划线连字符），直接返回原名
  if (name.length <= limit && /^[a-zA-Z0-9_-]+$/.test(name)) return name
  // 否则计算名称的 SHA-256 哈希，取前 10 个十六进制字符作为指纹
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 10)
  // 将非法字符替换为下划线、截断后附上指纹，保证唯一且不超长（-11 为下划线+哈希长度）
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, limit - 11) + "_" + hash
}

// 根据带前缀的 MCP 工具名反查原始工具名；若不是我们提供的工具则返回 undefined——
// 这类调用 Claude Code 会自行应答，不经过我们的钩子或服务器
// Undefined for a tool we did not offer. Claude Code answers those calls itself, without our hooks or server.
export function original(name: string, tools: readonly LanguageModelV3FunctionTool[]) {
  // 在工具列表中查找“前缀 + 短名”与之匹配的工具，返回其原始名称
  return tools.find((tool) => PREFIX + short(tool.name) === name)?.name
}

// Claude Code 会把每个 MCP 工具的描述截断到这个字符数
// Claude Code cuts each MCP tool description at this many characters.
const DESCRIPTION_LIMIT = 2048

// 计算提供给 Claude 的工具描述文本（带截断处理）
export function description(tool: LanguageModelV3FunctionTool) {
  // 取工具描述；没有则视为空字符串
  const text = tool.description ?? ""
  // 非 subagent 工具或描述未超限时，直接按上限截断
  if (tool.name !== "subagent" || text.length <= DESCRIPTION_LIMIT) return text.slice(0, DESCRIPTION_LIMIT)
  // subagent 的列表位于长描述末尾，因此把它移到最前，确保截断后仍保留这份列表
  // The subagent list comes last in a long description, so move it first to keep it after the cut.
  const agents = text.indexOf("Available subagents:")
  // 找不到该标记时，退回普通的按上限截断
  if (agents === -1) return text.slice(0, DESCRIPTION_LIMIT)
  // 把“子代理列表”段挪到描述开头，再整体截断到上限
  return (text.slice(agents) + "\n\n" + text.slice(0, agents)).slice(0, DESCRIPTION_LIMIT)
}
