// 导出 ToolHooks 命名空间，供其他模块引用本文件内容
export * as ToolHooks from "./hooks.js"

// 导入 Claude Agent SDK 的钩子回调与选项类型
import type { HookCallback, Options } from "@anthropic-ai/claude-agent-sdk"
// 导入待处理工具（PendingTools）的接口类型
import type { PendingTools } from "./pending.js"

// 构造 Claude Agent SDK 所需的钩子配置：用于拦截工具调用前后的事件，桥接 OpenCode 的待处理工具流程
export function make(pending: PendingTools.Interface): Options["hooks"] {
  // 定义“工具调用前”的钩子回调
  const before: HookCallback = async (input) => {
    // 当事件为 PreToolUse（工具即将执行）时，登记该工具调用 ID，标记其开始
    if (input.hook_event_name === "PreToolUse") pending.before(input.tool_use_id, input.tool_name)
    // 返回空对象表示不做额外修改
    return {}
  }

  // 定义“工具调用后”的钩子回调
  const after: HookCallback = async (input) => {
    // 只处理 PostToolUse（工具执行完毕）事件
    if (input.hook_event_name !== "PostToolUse") return {}
    // 从待处理工具记录中取出该调用对应的替换输出（由 OpenCode 侧写入）
    const replacement = pending.after(input.tool_use_id)
    // 若没有替换内容，则保持原输出
    if (!replacement) return {}
    // 返回钩子专属输出：用 OpenCode 生成的结果替换 MCP 工具的原始输出
    return { hookSpecificOutput: { hookEventName: "PostToolUse", updatedMCPToolOutput: replacement } }
  }

  // 组装并返回钩子配置：把 before/after 分别挂到 PreToolUse 与 PostToolUse 事件上
  return {
    PreToolUse: [{ hooks: [before] }],
    PostToolUse: [{ hooks: [after] }],
  }
}
