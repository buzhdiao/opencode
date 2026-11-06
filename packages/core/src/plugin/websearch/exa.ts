// 将本模块以命名空间 `WebSearchExa` 全量导出
export * as WebSearchExa from "./exa.js"

// 引入插件定义工具 define
import { define } from "@opencode/plugin/effect/plugin"
// 引入 Effect 原语、Schema 与 Scope（作用域）
import { Effect, Schema, Scope } from "effect"
// 引入 Effect 的 HTTP 客户端
import { HttpClient } from "effect/http"
// 引入 MCP（Model Context Protocol）调用工具
import { WebSearchMcp } from "./mcp.js"
// 引入搜索提供方注册工具
import { WebSearchProvider } from "./provider.js"

// Exa 的 MCP 服务端点
export const endpoint = "https://mcp.exa.ai/mcp"

// MCP 工具的输入 schema：查询词与可选的结果数量
const McpInput = Schema.Struct({
  // 查询词
  query: Schema.String,
  // 结果数量（可选）
  numResults: Schema.Number.pipe(Schema.optional),
})

// MCP 工具的输出 schema：文本内容数组（含可选搜索耗时元数据）
const McpOutput = Schema.Struct({
  // 内容数组
  content: Schema.Array(
    Schema.Struct({
      // 内容类型固定为 text
      type: Schema.Literal("text"),
      // 文本内容
      text: Schema.String,
      // 元数据（可选）
      _meta: Schema.Struct({ searchTime: Schema.Number }).pipe(Schema.optional),
    }),
  ),
})

// 定义 Exa 网页搜索插件：注册为 WebSearch 提供方
export const Plugin = define<HttpClient.HttpClient | Scope.Scope>({
  // 插件唯一标识
  id: "opencode.websearch.exa",
  // 插件副作用主体
  effect: Effect.fn("WebSearchExa.Plugin")(function* (ctx) {
    // 获取 HTTP 客户端
    const http = yield* HttpClient.HttpClient
    // 向注册表登记 exa 提供方
    yield* WebSearchProvider.register(ctx, {
      // 提供方 id
      id: "exa",
      // 显示名称
      name: "Exa",
      // 凭据环境变量名
      env: "EXA_API_KEY",
      // 执行搜索：调用 Exa 的 MCP 工具并解析结果
      execute: (input, credential) =>
        Effect.gen(function* () {
          // 构造端点 URL
          const url = new URL(endpoint)
          // 密钥型凭据通过查询参数传递
          if (credential?.type === "key") url.searchParams.set("exaApiKey", credential.key)
          // 调用 web_search_exa MCP 工具（固定取 8 条结果）
          const result = yield* WebSearchMcp.call(
            http,
            url.toString(),
            "web_search_exa",
            { input: McpInput, output: McpOutput },
            { query: input.query, numResults: 8 },
          )
          // 取第一段非空文本内容
          const content = result?.content.find((item) => item.text)
          // 解析结果文本；无内容时返回空数组
          return content ? parseResults(content.text) : []
        }),
    })
  }),
})

// 解析 Exa 返回的分块文本（块之间以 "\n\n---\n\n" 分隔）
function parseResults(text: string) {
  // 逐块提取字段
  return text.split(/\n\n---\n\n/).flatMap((block) => {
    // 提取 URL 行
    const url = block.match(/^URL:\s*(.+)$/m)?.[1]?.trim()
    // 无 URL 的块直接跳过
    if (!url) return []
    // 提取标题行（可选）
    const title = block.match(/^Title:\s*(.+)$/m)?.[1]?.trim()
    // 提取发布时间行（可选）
    const publishedText = block.match(/^Published:\s*(.+)$/m)?.[1]?.trim()
    // "N/A" 视为无时间，否则解析为时间戳
    const published = publishedText && publishedText !== "N/A" ? Date.parse(publishedText) : undefined
    // 提取正文（Highlights 或 Text 段）
    const content = block.match(/^(?:Highlights|Text):\s*\n?([\s\S]*)$/m)?.[1]?.trim()
    // 组装单条结果
    return [
      {
        url,
        // 标题存在且非 "N/A" 时附加
        ...(title && title !== "N/A" ? { title } : {}),
        // 正文存在时附加
        ...(content ? { content } : {}),
        // 时间信息（仅在有有效发布时间时携带）
        time: { ...(published !== undefined && Number.isFinite(published) ? { published } : {}) },
      },
    ]
  })
}
