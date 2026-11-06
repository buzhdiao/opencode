// 导出 RequestKind 命名空间，供其他模块以 RequestKind.xxx 的方式引用本文件内容
export * as RequestKind from "./request-kind.js"

// 自定义请求头名称：用于标记本次请求属于哪种类型（普通对话、fork 等）
export const HEADER = "x-opencode-claude-agent-kind"
// 自定义请求头名称：携带 OpenCode 的会话 ID，便于服务端/代理识别会话
export const SESSION_HEADER = "x-opencode-session-id"
// 自定义请求头名称：标记该请求源自哪个 fork（分叉）来源会话
export const FORK_HEADER = "x-opencode-claude-agent-fork-source"
