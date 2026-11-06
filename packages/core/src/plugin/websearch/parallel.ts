// 将本模块以命名空间 `WebSearchParallel` 全量导出
export * as WebSearchParallel from "./parallel.js"

// 引入插件定义工具 define
import { define } from "@opencode/plugin/effect/plugin"
// 引入 Effect 原语、Schema 与 Scope
import { Effect, Schema, Scope } from "effect"
// 引入 HTTP 客户端
import { HttpClient } from "effect/http"
// 引入 App 工具（生成 User-Agent）
import { App } from "../../app.js"
// 引入 MCP 调用工具
import { WebSearchMcp } from "./mcp.js"
// 引入搜索提供方注册工具
import { WebSearchProvider } from "./provider.js"

// Parallel 的 MCP 服务端点
export const endpoint = "https://search.parallel.ai/mcp"

// MCP 工具的输入 schema：目标、查询词列表与可选模型名
const McpInput = Schema.Struct({
  // 搜索目标描述
  objective: Schema.String,
  // 搜索查询词列表
  search_queries: Schema.Array(Schema.String),
  // 模型名（最长 100 字符，可选）
  model_name: Schema.String.check(Schema.isMaxLength(100)).pipe(Schema.optional),
})

// Parallel 搜索的完整响应 schema
const SearchResponse = Schema.Struct({
  // 本次搜索的 ID
  search_id: Schema.String,
  // 结果数组
  results: Schema.Array(
    Schema.Struct({
      // 结果 URL
      url: Schema.String,
      // 标题（可空可选）
      title: Schema.NullOr(Schema.String).pipe(Schema.optional),
      // 发布日期（可空可选）
      publish_date: Schema.NullOr(Schema.String).pipe(Schema.optional),
      // 摘录列表
      excerpts: Schema.Array(Schema.String),
    }),
  ),
  // 警告列表（可空可选）
  warnings: Schema.NullOr(
    Schema.Array(
      Schema.Struct({
        // 警告类型（三种枚举）
        type: Schema.Literals(["spec_validation_warning", "input_validation_warning", "warning"]),
        // 警告消息
        message: Schema.String,
        // 详细信息（可空可选）
        detail: Schema.NullOr(Schema.Record(Schema.String, Schema.Json)).pipe(Schema.optional),
      }),
    ),
  ).pipe(Schema.optional),
  // 用量统计（可空可选）
  usage: Schema.NullOr(
    Schema.Array(
      Schema.Struct({
        // 用量项名称
        name: Schema.String,
        // 计数
        count: Schema.Int,
      }),
    ),
  ).pipe(Schema.optional),
  // 会话 ID
  session_id: Schema.String,
})
// MCP 工具的输出 schema：文本内容数组与结构化载荷
const McpOutput = Schema.Struct({
  // 文本内容数组
  content: Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })),
  // 结构化的搜索响应
  structuredContent: SearchResponse,
})

// 定义 Parallel 网页搜索插件：注册为 WebSearch 提供方
export const Plugin = define<HttpClient.HttpClient | Scope.Scope>({
  // 插件唯一标识
  id: "opencode.websearch.parallel",
  // 插件副作用主体
  effect: Effect.fn("WebSearchParallel.Plugin")(function* (ctx) {
    // 获取 HTTP 客户端
    const http = yield* HttpClient.HttpClient
    // 向注册表登记 parallel 提供方
    yield* WebSearchProvider.register(ctx, {
      // 提供方 id
      id: "parallel",
      // 显示名称
      name: "Parallel",
      // 凭据环境变量名
      env: "PARALLEL_API_KEY",
      // 执行搜索：调用 web_search MCP 工具
      execute: (input, credential) =>
        Effect.gen(function* () {
          // 调用 MCP 工具，附带 User-Agent 与可选 Bearer 凭据
          const result = yield* WebSearchMcp.call(
            http,
            endpoint,
            "web_search",
            { input: McpInput, output: McpOutput },
            {
              // 目标即查询词
              objective: input.query,
              // 查询词列表只包含该查询词
              search_queries: [input.query],
            },
            {
              // 应用统一 User-Agent
              "User-Agent": App.useragent(ctx.app),
              // 密钥型凭据放入 Authorization 头
              ...(credential?.type === "key" ? { Authorization: `Bearer ${credential.key}` } : {}),
            },
          )
          // 把结构化结果映射为统一结果结构；无结果时返回空数组
          return (
            result?.structuredContent.results.map((item) => {
              // 解析发布日期为时间戳（无则 undefined）
              const published = item.publish_date ? Date.parse(item.publish_date) : undefined
              // 组装单条结果
              return {
                url: item.url,
                // 标题存在时附加
                ...(item.title ? { title: item.title } : {}),
                // 摘录非空时以空行连接为正文
                ...(item.excerpts.length ? { content: item.excerpts.join("\n\n") } : {}),
                // 时间信息（仅在有有效发布时间时携带）
                time: { ...(published !== undefined && Number.isFinite(published) ? { published } : {}) },
              }
            }) ?? []
          )
        }),
    })
  }),
})
