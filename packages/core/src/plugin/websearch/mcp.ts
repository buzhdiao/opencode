// 将本模块以命名空间 `WebSearchMcp` 全量导出
export * as WebSearchMcp from "./mcp.js"

// 引入 Effect 原语：Duration、Effect、Schema
import { Duration, Effect, Schema } from "effect"
// 引入 HTTP 客户端与请求构造器
import { HttpClient, HttpClientRequest } from "effect/http"
// 引入受限响应体收集工具（防止超大响应）
import { collectBoundedResponseBody } from "../../tool/http-body.js"

// MCP 响应体的最大字节数：256 KB
export const MAX_RESPONSE_BYTES = 256 * 1024

// 解析 MCP 响应体：支持普通 JSON 与 SSE（text/event-stream）两种形态
export const parseResponse = <F extends Schema.Struct.Fields>(body: string, result: Schema.Struct<F>) => {
  // 构造解码器：外层为 { result: <输出 schema> } 的 JSON
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ result })))
  // 单次解析尝试：非 JSON 对象开头直接返回 undefined
  const parse = (payload: string) => {
    // 去除首尾空白
    const trimmed = payload.trim()
    // 不以 "{" 开头则视为非 JSON
    if (!trimmed.startsWith("{")) return Effect.undefined
    // 解码并只取 result 字段
    return decode(trimmed).pipe(Effect.map((response) => response.result))
  }
  // 主解析流程
  return Effect.gen(function* () {
    // 先尝试整体作为 JSON 解析
    const trimmed = body.trim()
    // 空体时 direct 为 undefined
    const direct = trimmed ? yield* parse(trimmed) : undefined
    // 直接命中则返回
    if (direct) return direct
    // 否则按 SSE 逐行扫描
    for (const line of body.split("\n")) {
      // 只处理 "data: " 开头的事件行
      if (!line.startsWith("data: ")) continue
      // 解析事件负载
      const data = yield* parse(line.substring(6))
      // 第一个解析成功的负载即为结果
      if (data) return data
    }
  })
}

// 发起一次 MCP tools/call 请求并解析响应
export const call = <F extends Schema.Struct.Fields, R extends Schema.Struct.Fields>(
  // HTTP 客户端
  http: HttpClient.HttpClient,
  // 服务端点 URL
  url: string,
  // 要调用的工具名
  tool: string,
  // 输入/输出 schema 对
  schema: { readonly input: Schema.Struct<F>; readonly output: Schema.Struct<R> },
  // 工具参数
  value: Schema.Struct.Type<F>,
  // 额外请求头（默认为空）
  headers: Record<string, string> = {},
) =>
  Effect.gen(function* () {
    // 构造 JSON-RPC 请求：POST + 接受 JSON/事件流 + 注入额外头
    const request = yield* HttpClientRequest.post(url).pipe(
      HttpClientRequest.accept("application/json, text/event-stream"),
      HttpClientRequest.setHeaders(headers),
      HttpClientRequest.schemaBodyJson(
        Schema.Struct({
          // JSON-RPC 协议版本
          jsonrpc: Schema.Literal("2.0"),
          // 固定请求 ID
          id: Schema.Literal(1),
          // 固定方法为 tools/call
          method: Schema.Literal("tools/call"),
          // 参数：工具名与输入 schema
          params: Schema.Struct({ name: Schema.String, arguments: schema.input }),
        }),
      )({
        // 请求体：协议版本
        jsonrpc: "2.0",
        // 请求 ID
        id: 1,
        // 方法名
        method: "tools/call",
        // 工具名与实际参数
        params: { name: tool, arguments: value },
      }),
    )
    // 执行请求并限时
    return yield* Effect.gen(function* () {
      // 在专用作用域内执行：仅接受 2xx 状态
      const response = yield* HttpClient.withScope(HttpClient.filterStatusOk(http)).execute(request)
      // 收集响应体并施加字节上限
      const body = yield* collectBoundedResponseBody(
        response,
        MAX_RESPONSE_BYTES,
        () => new Error(`${tool} response exceeded ${MAX_RESPONSE_BYTES} bytes`),
      )
      // 按输出 schema 解析响应体
      return yield* parseResponse(body.toString("utf8"), schema.output)
    }).pipe(
      // 请求作用域到此结束
      Effect.scoped,
      // 25 秒超时，超时返回专用错误
      Effect.timeoutOrElse({
        duration: Duration.seconds(25),
        orElse: () => Effect.fail(new Error(`${tool} request timed out`)),
      }),
    )
  })
