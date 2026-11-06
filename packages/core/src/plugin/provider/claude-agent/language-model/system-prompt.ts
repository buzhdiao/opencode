// 导出 ClaudeSystemPrompt 命名空间，供其他模块引用本文件内容
export * as ClaudeSystemPrompt from "./system-prompt.js"

// 导入 Claude Agent SDK 的选项类型
import type { Options } from "@anthropic-ai/claude-agent-sdk"
// 导入 AI SDK 的提示词（prompt）类型定义
import type { LanguageModelV3Prompt } from "@ai-sdk/provider"

// 选项键名：用于标记本次请求是否使用 Claude Code 代理
export const AGENT_OPTION = "claudeCodeAgent"
// 选项键名：用于携带 OpenCode 传给代理的指令文本
export const INSTRUCTIONS_OPTION = "claudeCodeInstructions"

// 主系统提示配置：采用 Claude Code 官方预设，并附加运行时说明
const primary = {
  // 类型为预设（preset），即使用内置的提示词模板
  type: "preset",
  // 预设名称：claude_code
  preset: "claude_code",
  // Agent 变更必须在同一原生会话被恢复（resume）时立即生效，因此不使用快照
  // Agent changes must take effect when a process resumes the same native session.
  snapshot: false,
  // 追加的运行时提示：说明当前是在 OpenCode 中通过 Claude Code 宿主运行，仅在用户问起时才提
  append:
    "<runtime_info>You are running in OpenCode through the Claude Code harness. Mention this only when asked.</runtime_info>",
} satisfies Options["systemPrompt"]

// 构造最终的系统提示：把追加块、代理角色（role）与指令（instructions）拼接起来
export function make(role?: string, instructions?: string) {
  // 以基础追加文本作为起始内容块
  const blocks = [primary.append]
  // 如果传入了角色描述，则添加“来自 OpenCode 的代理角色”小节
  if (role) blocks.push("# Agent role (from OpenCode)\n" + role)
  // 如果传入了额外指令，则原样追加
  if (instructions) blocks.push(instructions)
  // 返回复制的配置对象，但把 append 替换为拼接后的完整文本（用两个空行分隔）
  return { ...primary, append: blocks.join("\n\n") }
}

// 从提示词中抽取所有 system 消息并拼接成“工具型（utility）”请求的系统提示
export function utility(prompt: LanguageModelV3Prompt) {
  // 过滤出角色为 system 的消息，并取出各自的内容
  const blocks = prompt.filter((message) => message.role === "system").map((message) => message.content)
  // 拼接内容；若为空则回退为一句通用的“文本生成助手”提示
  return blocks.join("\n\n") || "You are a text generation helper. Return only the requested output."
}
