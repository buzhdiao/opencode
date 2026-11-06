// 导出 ClaudeAgentLanguageModel 命名空间，供其他模块引用本文件内容
export * as ClaudeAgentLanguageModel from "./claude-agent-language-model.js"

// 导入 AI SDK 的语言模型 V3 接口及相关类型
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3FunctionTool,
  LanguageModelV3StreamResult,
} from "@ai-sdk/provider"
// 导入 Claude 会话管理类型（请求结构定义在其中）
import type { ClaudeSessions } from "../claude/sessions.js"
// 导入 Claude Agent SDK 的努力等级（EffortLevel）类型
import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk"
// 导入 Provider schema（取 claudeAgent 的 ID）
import { Provider } from "@opencode/schema/provider"
// 导入 Claude 流转换器（把 SDK 消息转为 AI SDK 流部件）
import { ConvertClaudeStream } from "./convert-claude-stream.js"
// 导入请求头常量
import { RequestKind } from "./request-kind.js"
// 导入系统提示构造工具
import { ClaudeSystemPrompt } from "./system-prompt.js"

// 模型运行所需的外部依赖：执行一次 Claude 会话请求
export interface Dependencies {
  // 运行请求：给定请求描述与中止信号
  readonly run: (request: ClaudeSessions.Request, signal: AbortSignal) => Promise<void>
}

// 实现 AI SDK V3 语言模型接口：把 OpenCode 的模型请求桥接到 Claude Agent
export class Model implements LanguageModelV3 {
  // 规范版本
  readonly specificationVersion = "v3"
  // 供应商标识
  readonly provider = Provider.ID.claudeAgent
  // 不支持任何 URL 资源
  readonly supportedUrls = {}

  constructor(
    // 模型 ID（如 claude-sonnet-4）
    readonly modelId: string,
    // 运行依赖
    readonly dependencies: Dependencies,
    // 连接（凭据）环境变量，默认为空
    readonly connection: Readonly<Record<string, string>> = {},
  ) {}

  // 不支持一次性生成：只支持流式
  async doGenerate(_options: LanguageModelV3CallOptions): Promise<never> {
    throw new Error("Claude Agent models only support streaming")
  }

  // 流式生成：启动 Claude 会话任务，把 SDK 消息转换为 AI SDK 流
  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    // 创建本请求自己的中止控制器
    const abort = new AbortController()
    // 合并外部传入的中止信号与内部信号：任一触发都会中止
    const signal = options.abortSignal ? AbortSignal.any([abort.signal, options.abortSignal]) : abort.signal
    // 工具列表：工具选择为 none 时为空；否则只保留 function 类型的工具
    const tools =
      options.toolChoice?.type === "none"
        ? []
        : (options.tools ?? []).filter((tool): tool is LanguageModelV3FunctionTool => tool.type === "function")
    // 读取请求头
    const headers = options.headers ?? {}
    // 请求类型（primary/generate/compaction 等）
    const kind = headers[RequestKind.HEADER]
    // OpenCode 会话 ID
    const session = headers[RequestKind.SESSION_HEADER]
    // 读取 claudeAgent 专属的 providerOptions
    const settings = options.providerOptions?.[Provider.ID.claudeAgent]
    // 代理角色文本（来自 agent.system）
    const role = settings?.[ClaudeSystemPrompt.AGENT_OPTION]
    // 仅当角色是字符串时才使用
    const agent = typeof role === "string" ? role : undefined
    // 额外指令文本
    const loaded = settings?.[ClaudeSystemPrompt.INSTRUCTIONS_OPTION]
    // 仅当指令是字符串时才使用
    const instructions = typeof loaded === "string" ? loaded : undefined
    // 解析努力等级（effort）
    const effort = parseEffort(settings?.effort)
    // 是否为主请求（正常对话轮次）
    const primary = kind === "primary"
    // 是否为“独立分支”请求（标题生成/压缩）
    const branch = kind === "generate" || kind === "compaction"
    // 主请求沿用原会话；分支请求开新会话
    const sessionID = primary ? session : undefined
    // 会话分支会复制源会话并保留 Claude 的提示；OpenCode 把任务作为用户输入提供。
    // Conversation branches copy their source session and keep the Claude prompt. OpenCode supplies their task as user input.
    // 主请求若来自 fork，则记录 fork 源会话；分支请求则以当前会话为复制源
    const sourceID = primary ? headers[RequestKind.FORK_HEADER] : branch ? session : undefined
    // 分支请求也提供聊天工具与系统提示，让 Claude 复用聊天的提示缓存
    // Branches offer the chat's tools and system prompt so Claude reuses the chat's prompt cache.
    const offered = primary || branch ? tools : []
    // 创建流转换器（基于要提供的工具集合）
    const convert = ConvertClaudeStream.make(offered)
    // 标题生成等属于独立任务，因此用 OpenCode 的系统提示替换 Claude Code 的。
    // Titles are standalone tasks, so OpenCode's system prompt replaces Claude Code's.
    // 主/分支请求用 make（预设+角色+指令），否则用 utility（从提示词抽取 system 消息）
    const system =
      primary || branch ? ClaudeSystemPrompt.make(agent, instructions) : ClaudeSystemPrompt.utility(options.prompt)
    // 取消标记：流被取消后不再向下游发送数据
    let cancelled = false
    // 保存运行中的任务 Promise（供 cancel 时等待）
    let task: Promise<void>
    // 创建可读流
    const stream = new ReadableStream({
      // 流启动时执行
      start: (controller) => {
        // 先发出 stream-start 事件（无警告）
        controller.enqueue({ type: "stream-start", warnings: [] })
        // 启动 Claude 会话任务
        task = this.dependencies
          .run(
            {
              // 会话 ID（主请求）
              sessionID,
              // 复制源会话 ID（fork/分支）
              sourceID,
              // 是否为压缩（compaction）请求
              compaction: kind === "compaction",
              // 模型 ID
              model: this.modelId,
              // 努力等级
              effort,
              // 输出 token 上限（可能为 undefined）
              maxOutputTokens: options.maxOutputTokens,
              // 连接凭据环境
              connection: this.connection,
              // 系统提示
              system,
              // 完整提示词
              prompt: options.prompt,
              // 提供的工具列表
              tools: offered,
              // 发射回调：把 SDK 消息转换为流部件并入队
              emit: (message) => {
                // 已取消则丢弃
                if (cancelled) return
                // 逐部件入队
                for (const part of convert(message)) controller.enqueue(part)
              },
            },
            // 中止信号
            signal,
          )
          .then(
            // 成功结束：未取消时关闭流
            () => {
              if (!cancelled) controller.close()
            },
            // 失败：未取消时把错误传入流
            (error) => {
              if (!cancelled) controller.error(error)
            },
          )
      },
      // 流被取消时执行
      cancel: () => {
        // 标记取消，阻止后续入队
        cancelled = true
        // 触发中止信号，停止底层任务
        abort.abort()
        // 返回任务 Promise，让取消等待任务真正结束
        return task
      },
    })
    // 返回流式结果
    return { stream }
  }
}

// 合法的努力等级列表
const EFFORTS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"]

// 解析努力等级：未提供返回 undefined；非法值抛错
function parseEffort(value: unknown): EffortLevel | undefined {
  // 未定义直接返回
  if (value === undefined) return undefined
  // 在合法列表中查找
  const effort = EFFORTS.find((effort) => value === effort)
  // 找到则返回
  if (effort !== undefined) return effort
  // 非法值抛出错误
  throw new Error("Claude Agent effort must be low, medium, high, xhigh or max")
}
