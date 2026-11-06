// 引入 Effect 核心组合子
import { Effect } from "effect"
// 引入 HTTP 响应构造器
import { HttpServerResponse } from "effect/http"
// 引入 HttpApi 中间件基础设施
import { HttpApiMiddleware } from "effect/http-api"
// 引入错误类型：非法请求（客户端错误）与未知错误（服务端错误）
import { InvalidRequestError, UnknownError } from "@opencode/protocol/errors"
// 引入协议中定义的 SchemaErrorMiddleware（Schema 错误转换中间件）
import { SchemaErrorMiddleware } from "@opencode/protocol/middleware/schema-error"
// 原样 re-export 该中间件，供其他模块统一从本文件导入
export { SchemaErrorMiddleware } from "@opencode/protocol/middleware/schema-error"

// 错误原因（reason）文本的最大保留长度（字符数）
const REASON_LIMIT = 1024

// 把过长的错误原因截断到上限，并注明被省略的字符数
function truncateReason(reason: string) {
  // 未超过上限时原样返回
  if (reason.length <= REASON_LIMIT) return reason
  // 超过上限时截断并追加"还有多少字符"的提示（模板字符串内部不可插入注释）
  return reason.slice(0, REASON_LIMIT) + `... (${reason.length - REASON_LIMIT} more chars)`
}

// 构建 Schema 错误转换层：当 Effect 在编解码阶段产生 Schema 错误时，自定义其处理与响应方式
export const schemaErrorLayer = HttpApiMiddleware.layerSchemaErrorTransform(
  // 指定标识该转换的中间件
  SchemaErrorMiddleware,
  // 转换函数：error 为 Schema 错误，context 提供接口分组与端点信息
  (error, context) => {
    // 截断后的错误原因
    const reason = truncateReason(error.cause.message)
    // Effect 把响应编码错误标记为 Body 或 ResponseHeaders；请求解码错误则使用 Params、Headers、Query 或 Payload。
    // Effect tags response encoding as Body or ResponseHeaders; request decoding uses Params, Headers, Query or Payload.
    // 属于响应侧错误（服务端自己的编码失败）时：
    if (error.kind === "Body" || error.kind === "ResponseHeaders") {
      // 生成短随机引用 ID，便于把 500 响应与服务端日志一一对应（模板字符串内部不可插入注释）
      const ref = `err_${crypto.randomUUID().slice(0, 8)}`
      // 记录错误日志，并最终返回一个 500 响应
      return Effect.logError("failed to encode response").pipe(
        // 为日志附加结构化字段：引用 ID、错误类别、端点、路由、原因
        Effect.annotateLogs({
          // 随机引用 ID
          ref,
          // 错误类别
          kind: error.kind,
          // 端点标识："分组名.端点名"（模板字符串内部不可插入注释）
          endpoint: `${context.group.identifier}.${context.endpoint.name}`,
          // 路由："HTTP方法 路径"（模板字符串内部不可插入注释）
          route: `${context.endpoint.method} ${context.endpoint.path}`,
          reason,
        }),
        // 直接响应而不是以声明的错误失败，使每个端点的契约保持不变，
        // 这个 500 看起来与其他意外的服务端失败一致。
        // Respond directly rather than failing with a declared error, so every endpoint's contract stays unchanged
        // and this 500 reads like any other unexpected server failure.
        Effect.as(
          // 构造 500 JSON 响应
          HttpServerResponse.jsonUnsafe(
            {
              // 与协议中 UnknownError 的编码结构保持一致
              _tag: "UnknownError",
              // 提示用户去查看服务端日志
              message: "Server failed to encode its response. Check server logs for details.",
              // 附带引用 ID 以便日志检索
              ref,
            } satisfies typeof UnknownError.Encoded,
            // HTTP 状态码 500
            { status: 500 },
          ),
        ),
      )
    }
    // 其余类别（Params/Headers/Query/Payload）属于请求侧问题：记录告警日志
    return Effect.logWarning("schema rejection").pipe(
      // 为日志附加错误类别与原因
      Effect.annotateLogs({ kind: error.kind, reason }),
      // 以声明的 InvalidRequestError 失败，作为客户端错误返回
      Effect.andThen(Effect.fail(new InvalidRequestError({ message: reason, kind: error.kind }))),
    )
  },
)
