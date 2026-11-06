// 将本模块以命名空间 `WebSearchTinyFish` 全量导出
export * as WebSearchTinyFish from "./tinyfish.js"

// 引入插件定义工具 define
import { define } from "@opencode/plugin/effect/plugin"
// 引入 Effect 原语：Duration、Effect、Option、Schema、Scope
import { Duration, Effect, Option, Schema, Scope } from "effect"
// 引入 HTTP 客户端与请求构造器
import { HttpClient, HttpClientRequest } from "effect/http"
// 引入 App 工具（生成 User-Agent）
import { App } from "../../app.js"
// 引入受限响应体收集工具
import { collectBoundedResponseBody } from "../../tool/http-body.js"
// 引入 MCP 调用工具
import { WebSearchMcp } from "./mcp.js"
// 引入搜索提供方注册工具
import { WebSearchProvider } from "./provider.js"

// TinyFish 的 MCP 服务端点
export const endpoint = "https://agent.tinyfish.ai/mcp"

// MCP 工具的输入 schema：仅查询词
const McpInput = Schema.Struct({
  // 查询词
  query: Schema.String,
})

// MCP 工具的输出 schema：文本内容数组
const McpOutput = Schema.Struct({
  // 内容数组
  content: Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })),
})

// TinyFish 搜索结果的 JSON schema
const SearchResponse = Schema.fromJsonString(
  Schema.Struct({
    // 结果数组
    results: Schema.Array(
      Schema.Struct({
        // 结果 URL
        url: Schema.String,
        // 标题
        title: Schema.String,
        // 摘要片段
        snippet: Schema.String,
      }),
    ),
  }),
)
// 宽松解码器：解析失败返回 None
const decodeSearchResponse = Schema.decodeUnknownOption(SearchResponse)

// MCP initialize 请求 schema
const InitializeRequest = Schema.Struct({
  // 协议版本
  jsonrpc: Schema.Literal("2.0"),
  // 固定请求 ID
  id: Schema.Literal(1),
  // 方法为 initialize
  method: Schema.Literal("initialize"),
  // 参数：协议版本、能力与客户端信息
  params: Schema.Struct({
    // MCP 协议版本
    protocolVersion: Schema.String,
    // 客户端能力（空）
    capabilities: Schema.Struct({}),
    // 客户端名称与版本
    clientInfo: Schema.Struct({ name: Schema.String, version: Schema.String }),
  }),
})

// MCP initialize 完成通知 schema
const InitializedNotification = Schema.Struct({
  // 协议版本
  jsonrpc: Schema.Literal("2.0"),
  // 通知方法
  method: Schema.Literal("notifications/initialized"),
})

// 定义 TinyFish 网页搜索插件：注册为 WebSearch 提供方
export const Plugin = define<HttpClient.HttpClient | Scope.Scope>({
  // 插件唯一标识
  id: "opencode.websearch.tinyfish",
  // 插件副作用主体
  effect: Effect.fn("WebSearchTinyFish.Plugin")(function* (ctx) {
    // 获取 HTTP 客户端
    const http = yield* HttpClient.HttpClient
    // 向注册表登记 tinyfish 提供方
    yield* WebSearchProvider.register(ctx, {
      // 提供方 id
      id: "tinyfish",
      // 显示名称
      name: "TinyFish",
      // 凭据环境变量名
      env: "TINYFISH_API_KEY",
      // 执行搜索：先按需建立 MCP 会话，再调用 search 工具
      execute: (input, credential) =>
        Effect.gen(function* () {
          // 组装公共请求头：统一 User-Agent 与凭据头（有密钥用 X-API-Key，否则走 keyless）
          const headers = {
            // 统一 User-Agent
            "User-Agent": App.useragent(ctx.app),
            // 密钥型凭据用 X-API-Key；无密钥用 keyless 模式头
            ...(credential?.type === "key" ? { "X-API-Key": credential.key } : { "X-TinyFish-Access-Mode": "keyless" }),
          }
          // Keyed requests are rejected without the `Mcp-Session-Id` returned by `initialize`; keyless ones are not.
          // 带密钥的请求必须先 initialize 获取 Mcp-Session-Id；keyless 请求不需要
          const session = credential?.type === "key" ? yield* initialize(http, headers) : undefined
          // 调用 search MCP 工具（带会话头，若有）
          const result = yield* WebSearchMcp.call(
            http,
            endpoint,
            "search",
            { input: McpInput, output: McpOutput },
            { query: input.query },
            { ...headers, ...(session === undefined ? {} : { "Mcp-Session-Id": session }) },
          )
          // 取第一段非空文本内容
          const content = result?.content.find((item) => item.text)
          // 按 JSON schema 解码结果文本
          const response = content ? Option.getOrUndefined(decodeSearchResponse(content.text)) : undefined
          // 映射为统一结果结构；无响应时返回空数组
          return (
            response?.results.map((item) => ({
              url: item.url,
              title: item.title,
              // 摘要非空时映射为 content
              ...(item.snippet ? { content: item.snippet } : {}),
              // TinyFish 不提供时间信息
              time: {},
            })) ?? []
          )
        }),
    })
  }),
})

// 执行 MCP initialize 握手并返回会话 ID
const initialize = (http: HttpClient.HttpClient, headers: Record<string, string>) =>
  Effect.gen(function* () {
    // 构造仅接受 2xx 的客户端（带独立作用域）
    const client = HttpClient.withScope(HttpClient.filterStatusOk(http))
    // 构造 initialize 请求
    const request = yield* HttpClientRequest.post(endpoint).pipe(
      // 接受 JSON/事件流
      HttpClientRequest.accept("application/json, text/event-stream"),
      // 注入请求头
      HttpClientRequest.setHeaders(headers),
      // 按序列化请求体
      HttpClientRequest.schemaBodyJson(InitializeRequest)({
        // 协议版本
        jsonrpc: "2.0",
        // 请求 ID
        id: 1,
        // 方法名
        method: "initialize",
        // 握手参数
        params: {
          // 协议版本
          protocolVersion: "2025-06-18",
          // 空能力集
          capabilities: {},
          // 客户端信息
          clientInfo: { name: "opencode", version: "1.0" },
        },
      }),
    )
    // 执行握手请求
    const response = yield* client.execute(request)
    // 收集响应体并施加字节上限（响应体本身不使用，仅约束尺寸）
    yield* collectBoundedResponseBody(
      response,
      WebSearchMcp.MAX_RESPONSE_BYTES,
      () => new Error(`initialize response exceeded ${WebSearchMcp.MAX_RESPONSE_BYTES} bytes`),
    )
    // 从响应头读取会话 ID
    const session = response.headers["mcp-session-id"]
    // 缺少会话头则报错
    if (session === undefined)
      return yield* Effect.fail(new Error("TinyFish MCP initialize did not return an Mcp-Session-Id header"))
    // 构造"已初始化"通知请求（携带会话 ID）
    const notification = yield* HttpClientRequest.post(endpoint).pipe(
      // 接受 JSON/事件流
      HttpClientRequest.accept("application/json, text/event-stream"),
      // 注入请求头与会话头
      HttpClientRequest.setHeaders({ ...headers, "Mcp-Session-Id": session }),
      // 按序列化通知体
      HttpClientRequest.schemaBodyJson(InitializedNotification)({
        // 协议版本
        jsonrpc: "2.0",
        // 通知方法
        method: "notifications/initialized",
      }),
    )
    // 发送完成通知
    yield* client.execute(notification)
    // 返回会话 ID
    return session
  }).pipe(
    // 作用域到此结束
    Effect.scoped,
    // 25 秒超时
    Effect.timeoutOrElse({
      duration: Duration.seconds(25),
      orElse: () => Effect.fail(new Error("TinyFish initialize request timed out")),
    }),
  )
