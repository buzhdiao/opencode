// 以命名空间形式整体再导出本模块
export * as ClaudeQueryOptions from "./query-options.js"

// AI SDK 的函数工具类型
import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider"
// Options：Claude Agent SDK 选项类型
import type { Options } from "@anthropic-ai/claude-agent-sdk"
// ToolHooks：工具事件钩子构造
import { ToolHooks } from "../tools/hooks.js"
// PendingTools：待处理工具请求接口类型
import type { PendingTools } from "../tools/pending.js"
// ToolServer：OpenCode 工具的 MCP 服务器
import { ToolServer } from "../tools/server.js"
// ClaudeIO：外部环境访问接口类型
import type { ClaudeIO } from "./io.js"

// Claude Code features that duplicate opencode's. opencode's version wins (specs/v2/claude-agent-provider.md, "Turned Off").
// 隔离环境变量：关闭与 opencode 重复的 Claude Code 功能（由 opencode 版本接管）。
const ISOLATION_ENV = {
  // 禁用 CLAUDE.md 加载
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
  // 禁用自动记忆
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  // 禁用自动压缩
  DISABLE_AUTO_COMPACT: "1",
  // 禁用离开摘要
  CLAUDE_CODE_ENABLE_AWAY_SUMMARY: "0",
  // 关闭工具搜索
  ENABLE_TOOL_SEARCH: "false",
  // 禁用 advisor 工具
  CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1",
  // 禁用非流式回退
  CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: "1",
  // 禁用拒绝回退
  CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: "1",
  // Raised so opencode's own truncation applies instead
  // 提高 MCP 输出上限，让 opencode 自己的截断逻辑生效
  MAX_MCP_OUTPUT_TOKENS: "200000",
  // Skips OAuth, so the subscription would not be used
  // 删除该变量以跳过 OAuth 简易模式（避免订阅被意外使用）
  CLAUDE_CODE_SIMPLE: undefined,
  // A shell-level effort override would take precedence over OpenCode's live effort settings.
  // 删除 shell 级 effort 覆盖，避免其压过 OpenCode 的动态 effort 设置
  CLAUDE_CODE_EFFORT_LEVEL: undefined,
  // Caps every OpenCode tool call, which would fail subagents and permission prompts that run longer
  // 删除 MCP 工具超时上限，避免长时运行的子代理与权限询问被误杀
  MCP_TOOL_TIMEOUT: undefined,
}

// connectionEnv：把模型设置/请求头/请求体转换为 Claude 进程的环境变量
export function connectionEnv(connection: {
  // 模型设置
  readonly settings?: Readonly<Record<string, unknown>>
  // 自定义请求头
  readonly headers?: Readonly<Record<string, string>>
  // 附加请求体
  readonly body?: Readonly<Record<string, unknown>>
}): Record<string, string> {
  // 结果环境变量表
  const env: Record<string, string> = {}
  // 读取设置（可缺省）
  const settings = connection.settings ?? {}
  // 配置了 baseURL 时映射为 ANTHROPIC_BASE_URL
  if (typeof settings.baseURL === "string") env.ANTHROPIC_BASE_URL = settings.baseURL
  // 配置了 apiKey 时映射为 ANTHROPIC_API_KEY
  if (typeof settings.apiKey === "string") env.ANTHROPIC_API_KEY = settings.apiKey
  // 配置了 authToken 时映射为 ANTHROPIC_AUTH_TOKEN
  if (typeof settings.authToken === "string") env.ANTHROPIC_AUTH_TOKEN = settings.authToken
  // 头部超时映射为 API_TIMEOUT_MS
  if (typeof settings.headerTimeout === "number") env.API_TIMEOUT_MS = String(settings.headerTimeout)
  // 分块超时映射为流空闲超时
  if (typeof settings.chunkTimeout === "number") env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = String(settings.chunkTimeout)
  // 收集自定义头
  const headers: string[] = []
  // 遍历请求头
  for (const [name, value] of Object.entries(connection.headers ?? {})) {
    // 组装 "Name: value" 形式
    headers.push(`${name}: ${value}`)
  }
  // 有自定义头时以换行连接写入
  if (headers.length > 0) env.ANTHROPIC_CUSTOM_HEADERS = headers.join("\n")
  // 有附加请求体时序列化为 JSON 写入
  if (connection.body !== undefined && Object.keys(connection.body).length > 0) {
    // JSON 序列化写入
    env.CLAUDE_CODE_EXTRA_BODY = JSON.stringify(connection.body)
  }
  // 返回环境变量
  return env
}

// base：构造 Claude 会话的基础选项（隔离设置与功能关闭）
export function base(input: {
  // claude 可执行文件路径
  executable: string
  // 外部访问接口
  io: ClaudeIO.Interface
  // 连接环境变量
  connection?: Readonly<Record<string, string>>
}): Options {
  // 返回基础选项
  return {
    // 指定 claude 可执行文件
    pathToClaudeCodeExecutable: input.executable,
    // 自定义进程启动器（可能未定义）
    spawnClaudeCodeProcess: input.io.spawn,
    // 环境：基础环境 + 连接变量 + 隔离变量
    env: { ...input.io.env(), ...input.connection, ...ISOLATION_ENV },
    // 不加载任何外部设置来源
    settingSources: [],
    // 关闭全部钩子
    settings: { disableAllHooks: true },
    // Without summaries, OpenCode has no reasoning text to display
    // 自适应思考并以摘要展示；否则 OpenCode 没有推理文本可显示
    thinking: { type: "adaptive", display: "summarized" },
    // MCP 配置严格模式
    strictMcpConfig: true,
    // 不加载技能
    skills: [],
    // 不启用内置工具
    tools: [],
    // 权限模式：不询问
    permissionMode: "dontAsk",
    // 仅放行 opencode 提供的 MCP 工具
    allowedTools: ["mcp__opencode__*"],
    // 原样保留提示词
    verbatimPrompts: true,
  }
}

// session：构造一次会话的完整选项（在基础选项之上叠加会话特有配置）
export async function session(input: {
  // claude 可执行文件路径
  readonly executable: string
  // 外部访问接口
  readonly io: ClaudeIO.Interface
  // 连接环境变量
  readonly connection?: Readonly<Record<string, string>>
  // 工作目录
  readonly directory: string
  // 模型 ID
  readonly model: string
  // 推理 effort（可选）
  readonly effort?: Options["effort"]
  // 最大输出令牌（可选）
  readonly maxOutputTokens?: number
  // 系统提示
  readonly system: NonNullable<Options["systemPrompt"]>
  // 提供给 Claude 的工具列表
  readonly tools: readonly LanguageModelV3FunctionTool[]
  // 待处理工具请求接口
  readonly pending: PendingTools.Interface
  // Side calls run without saving a transcript
  // persist：是否持久化会话记录（边车调用不保存）
  readonly persist: boolean
  // 要恢复的会话 ID（可选）
  readonly resume?: string
}): Promise<Options> {
  // 组装选项
  const options: Options = {
    // 展开基础选项
    ...base(input),
    // 工作目录
    cwd: input.directory,
    // 模型
    model: input.model,
    // effort
    effort: input.effort,
    // 系统提示
    systemPrompt: input.system,
    // 接收部分消息（流式增量）
    includePartialMessages: true,
    // 是否持久化会话
    persistSession: input.persist,
    // 工具事件钩子
    hooks: ToolHooks.make(input.pending),
    // MCP 服务器默认为空
    mcpServers: {},
  }
  // 配置了输出上限时注入环境变量
  if (input.maxOutputTokens !== undefined) {
    // 写入最大输出令牌
    options.env = { ...options.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(input.maxOutputTokens) }
  }
  // 有工具时挂载 opencode MCP 工具服务器
  if (input.tools.length > 0) options.mcpServers = { opencode: await ToolServer.make(input.tools, input.pending) }
  // 恢复模式：直接指定要恢复的会话
  if (input.resume !== undefined) {
    // 写入 resume
    options.resume = input.resume
    // 返回选项
    return options
  }
  // 新会话：生成新的会话 ID
  options.sessionId = crypto.randomUUID()
  // 返回选项
  return options
}
