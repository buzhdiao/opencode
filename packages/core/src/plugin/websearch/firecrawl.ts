// 将本模块以命名空间 `WebSearchFirecrawl` 全量导出
export * as WebSearchFirecrawl from "./firecrawl.js"

// 引入插件定义工具 define
import { define } from "@opencode/plugin/effect/plugin"
// 引入 Effect 原语、Option、Schema 与 Scope
import { Effect, Option, Schema, Scope } from "effect"
// 引入 HTTP 客户端
import { HttpClient } from "effect/http"
// 引入 App 工具（生成 User-Agent）
import { App } from "../../app.js"
// 引入 MCP 调用工具
import { WebSearchMcp } from "./mcp.js"
// 引入搜索提供方注册工具
import { WebSearchProvider } from "./provider.js"

// Firecrawl 的 MCP 服务端点
export const endpoint = "https://mcp.firecrawl.dev/v2/mcp"

// MCP 工具的输入 schema：查询词与可选的结果数量上限
const McpInput = Schema.Struct({
  // 查询词
  query: Schema.String,
  // 数量上限（可选）
  limit: Schema.Number.pipe(Schema.optional),
})

// MCP 工具的输出 schema：文本内容数组
const McpOutput = Schema.Struct({
  // 内容数组
  content: Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })),
})

// Firecrawl 搜索结果的 JSON schema：success 标志与 web 结果数组
const SearchResponse = Schema.fromJsonString(
  Schema.Struct({
    // 是否成功
    success: Schema.Boolean,
    // 数据载荷
    data: Schema.Struct({
      // 网页结果数组
      web: Schema.Array(
        Schema.Struct({
          // 结果 URL
          url: Schema.String,
          // 标题（可空可选）
          title: Schema.NullOr(Schema.String).pipe(Schema.optional),
          // 描述（可空可选）
          description: Schema.NullOr(Schema.String).pipe(Schema.optional),
        }),
      ),
    }),
  }),
)
// 宽松解码器：解析失败返回 None
const decodeSearchResponse = Schema.decodeUnknownOption(SearchResponse)

// 定义 Firecrawl 网页搜索插件：注册为 WebSearch 提供方
export const Plugin = define<HttpClient.HttpClient | Scope.Scope>({
  // 插件唯一标识
  id: "opencode.websearch.firecrawl",
  // 插件副作用主体
  effect: Effect.fn("WebSearchFirecrawl.Plugin")(function* (ctx) {
    // 获取 HTTP 客户端
    const http = yield* HttpClient.HttpClient
    // 向注册表登记 firecrawl 提供方
    yield* WebSearchProvider.register(ctx, {
      // 提供方 id
      id: "firecrawl",
      // 显示名称
      name: "Firecrawl",
      // 凭据环境变量名
      env: "FIRECRAWL_API_KEY",
      // 执行搜索：调用 firecrawl_search MCP 工具
      execute: (input, credential) =>
        Effect.gen(function* () {
          // 调用 MCP 工具（固定取 8 条），附带 User-Agent 与可选 Bearer 凭据
          const result = yield* WebSearchMcp.call(
            http,
            endpoint,
            "firecrawl_search",
            { input: McpInput, output: McpOutput },
            { query: input.query, limit: 8 },
            {
              // 应用统一的 User-Agent
              "User-Agent": App.useragent(ctx.app),
              // 密钥型凭据放入 Authorization 头
              ...(credential?.type === "key" ? { Authorization: `Bearer ${credential.key}` } : {}),
            },
          )
          // 取第一段非空文本内容
          const content = result?.content.find((item) => item.text)
          // 把文本按 JSON schema 解码；失败为 undefined
          const response = content ? Option.getOrUndefined(decodeSearchResponse(content.text)) : undefined
          // 映射为统一的结果结构；无响应时返回空数组
          return (
            response?.data.web.map((item) => ({
              url: item.url,
              // 标题存在时附加
              ...(item.title ? { title: item.title } : {}),
              // 描述存在时映射为 content
              ...(item.description ? { content: item.description } : {}),
              // Firecrawl 不提供时间信息
              time: {},
            })) ?? []
          )
        }),
    })
  }),
})
