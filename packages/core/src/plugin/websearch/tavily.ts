// 将本模块以命名空间 `WebSearchTavily` 全量导出
export * as WebSearchTavily from "./tavily.js"

// 引入插件定义工具 define
import { define } from "@opencode/plugin/effect/plugin"
// 引入 Effect 原语：Duration、Effect、Schema、Scope
import { Duration, Effect, Schema, Scope } from "effect"
// 引入 HTTP 客户端、请求构造器与响应工具
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
// 引入 App 工具（生成 User-Agent）
import { App } from "../../app.js"
// 引入搜索提供方注册工具
import { WebSearchProvider } from "./provider.js"

// Tavily 的搜索 API 端点
export const endpoint = "https://api.tavily.com/search"

// 搜索请求体 schema
const SearchRequest = Schema.Struct({
  // 查询词
  query: Schema.String,
  // 搜索深度（此处固定 basic）
  search_depth: Schema.Literal("basic"),
  // 每来源的片段数
  chunks_per_source: Schema.Number,
  // 最大结果数
  max_results: Schema.Number,
})

// 搜索响应体 schema
const SearchResponse = Schema.Struct({
  // 结果数组
  results: Schema.Array(
    Schema.Struct({
      // 标题
      title: Schema.String,
      // URL
      url: Schema.String,
      // 正文内容
      content: Schema.String,
    }),
  ),
})

// 定义 Tavily 网页搜索插件：注册为 WebSearch 提供方
export const Plugin = define<HttpClient.HttpClient | Scope.Scope>({
  // 插件唯一标识
  id: "opencode.websearch.tavily",
  // 插件副作用主体
  effect: Effect.fn("WebSearchTavily.Plugin")(function* (ctx) {
    // 获取 HTTP 客户端
    const http = yield* HttpClient.HttpClient
    // 向注册表登记 tavily 提供方
    yield* WebSearchProvider.register(ctx, {
      // 提供方 id
      id: "tavily",
      // 显示名称
      name: "Tavily",
      // 凭据环境变量名
      env: "TAVILY_API_KEY",
      // 执行搜索：直接调用 REST API（非 MCP）
      execute: (input, credential) =>
        Effect.gen(function* () {
          // 构造搜索请求：POST + JSON + 头 + 请求体
          const request = yield* HttpClientRequest.post(endpoint).pipe(
            // 接受 JSON 响应
            HttpClientRequest.acceptJson,
            // 设置请求头
            HttpClientRequest.setHeaders({
              // 统一 User-Agent
              "User-Agent": App.useragent(ctx.app),
              // 客户端标识
              "X-Client-Name": "opencode2",
              // 有密钥用 Bearer；无密钥走 keyless 模式
              ...(credential?.type === "key"
                ? { Authorization: `Bearer ${credential.key}` }
                : { "X-Tavily-Access-Mode": "keyless" }),
            }),
            // 按序列化请求体（固定深度、片段数与结果数）
            HttpClientRequest.schemaBodyJson(SearchRequest)({
              query: input.query,
              search_depth: "basic",
              chunks_per_source: 3,
              max_results: 8,
            }),
          )
          // 执行请求并按 schema 解析 JSON 响应
          const response = yield* HttpClient.withScope(HttpClient.filterStatusOk(http))
            .execute(request)
            .pipe(
              // 响应体按 schema 解码
              Effect.flatMap(HttpClientResponse.schemaBodyJson(SearchResponse)),
              // 请求作用域到此结束
              Effect.scoped,
              // 25 秒超时
              Effect.timeoutOrElse({
                duration: Duration.seconds(25),
                orElse: () => Effect.fail(new Error("Tavily web search request timed out")),
              }),
            )
          // 映射为统一结果结构
          return response.results.map((item) => ({
            url: item.url,
            title: item.title,
            // 内容非空时附加
            ...(item.content ? { content: item.content } : {}),
            // Tavily 不提供时间信息
            time: {},
          }))
        }),
    })
  }),
})
