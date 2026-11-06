// 仅导出 Claude Agent SDK 的类型（workerd 运行时不可用其实现代码）
export type * from "@anthropic-ai/claude-agent-sdk"

// workerd cannot spawn the claude process, and the Claude Agent plugin skips itself there.
// workerd 无法启动 claude 子进程；Claude Agent 插件在该运行时下会跳过自身，这里直接抛错兜底。
throw new Error("The Claude Agent SDK is unavailable on the workerd runtime")
