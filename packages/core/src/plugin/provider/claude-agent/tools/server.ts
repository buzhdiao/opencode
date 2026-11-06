// 导出 ToolServer 命名空间，供其他模块引用本文件内容
export * as ToolServer from "./server.js"

// 导入 AI SDK 的函数工具类型定义
import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider"
// 导入 Claude Agent SDK 的内嵌 MCP 服务器配置类型
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk"
// 导入 MCP 协议的 Tool（工具定义）类型
import type { Tool } from "@modelcontextprotocol/server"
// 导入工具名转换工具（前缀/短名/描述）
import { ToolNames } from "./names.js"
// 导入待处理工具（PendingTools）的接口类型
import type { PendingTools } from "./pending.js"

// 构造一个内嵌的 MCP 服务器：把 OpenCode 的工具以 MCP 形式暴露给 Claude Code
export async function make(
  // OpenCode 提供的工具定义列表
  tools: readonly LanguageModelV3FunctionTool[],
  // 待处理工具接口：负责在 OpenCode 侧实际执行工具调用
  pending: PendingTools.Interface,
): Promise<McpSdkServerConfigWithInstance> {
  // MCP SDK 延迟到首次使用时才加载，这样 opencode 启动时就无需加载 MCP SDK
  // Loaded on first use, so opencode starts without loading the MCP SDK.
  const { Server } = await import("@modelcontextprotocol/server")
  // 创建 MCP 服务器实例，声明名称、版本，并声明支持 tools 能力
  const server = new Server({ name: "opencode", version: "1.0.0" }, { capabilities: { tools: {} } })
  // 把 AI SDK 的工具定义映射为 MCP 的工具定义
  const definitions = tools.map(
    (tool): Tool => ({
      // 工具名：加前缀并压缩为短名
      name: ToolNames.short(tool.name),
      // 描述：经过截断处理
      description: ToolNames.description(tool),
      // 输入参数的 JSON Schema 原样透传
      inputSchema: tool.inputSchema as Tool["inputSchema"],
      // Claude 会串行执行非只读工具，因此每个 handler 从前置钩子中取调用 ID
      // Claude serializes non-read-only tools, so each handler takes the ID from the preceding hook.
      annotations: { readOnlyHint: false },
      // 元数据：总是加载该工具；结果最大 50 万字符
      _meta: { "anthropic/alwaysLoad": true, "anthropic/maxResultSizeChars": 500_000 },
    }),
  )
  // 注册 tools/list 请求处理器：返回上述工具定义列表
  server.setRequestHandler("tools/list", async () => ({ tools: definitions }))
  // 注册 tools/call 请求处理器：把调用转交给 OpenCode 的待处理工具队列
  server.setRequestHandler("tools/call", async (request) => {
    // 还原出带前缀的完整工具名
    const name = ToolNames.PREFIX + request.params.name
    // 若该工具不是我们注册过的，说明是非法调用，抛错
    if (!ToolNames.original(name, tools)) throw new Error(`Claude Code called an unregistered OpenCode tool: ${name}`)
    // 交给待处理队列执行并返回结果
    return pending.call(name)
  })
  // Claude Agent SDK 自带一套 MCP SDK 类型；其公开的 instance 类型也叫更高层的 McpServer，因此这里做一次类型断言
  // Claude Agent SDK bundles its own MCP SDK types; its public instance type also names the higher-level McpServer.
  return { type: "sdk", name: "opencode", instance: server as unknown as McpSdkServerConfigWithInstance["instance"] }
}
