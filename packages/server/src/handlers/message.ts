// 引入会话消息（SessionMessage）服务与 ID 类型
import { SessionMessage } from "@opencode/core/session/message"
// 引入会话（Session）服务
import { Session } from "@opencode/core/session"
// 引入 Effect、Option 与 Schema（数据校验/编解码）
import { Effect, Option, Schema } from "effect"
// 引入 HTTP 服务端响应工具
import { HttpServerResponse } from "effect/http"
// 引入 HTTP API 构建器
import { HttpApiBuilder } from "effect/http-api"
// 引入本服务 API 定义
import { Api } from "../api"
// 引入 wantsMediaRefs：判断客户端是否要求媒体引用（media: URI）形式
import { wantsMediaRefs } from "../media-uri"
// 引入无效游标错误（InvalidCursorError）
import { InvalidCursorError } from "@opencode/protocol/errors"
// 引入带媒体引用的消息列表响应 Schema
import { SessionMediaMessagesResponse } from "@opencode/protocol/groups/message"
// 引入会话错误的统一映射：消息解码失败、会话不存在
import { failedMessageDecode, missingSession } from "./session-error"

// 消息分页默认条数：未显式指定 limit 时取 50
const DefaultMessagesLimit = 50

// 游标（cursor）结构 Schema：锚点消息 ID、排序方向（asc/desc）、翻页方向（previous/next）
const Cursor = Schema.Struct({
  id: SessionMessage.ID,
  order: Schema.Union([Schema.Literal("asc"), Schema.Literal("desc")]),
  direction: Schema.Union([Schema.Literal("previous"), Schema.Literal("next")]),
})

// 解码器：把 JSON 字符串解析为游标结构（失败返回 None，由调用方兜底）
const decodeCursor = Schema.decodeUnknownOption(Schema.fromJsonString(Cursor))

// 游标编解码工具：在结构化对象与 base64url 字符串之间转换
const cursor = {
  // 编码：把锚点消息 ID、排序与翻页方向序列化为 base64url 令牌
  encode(message: { readonly id: SessionMessage.ID }, order: "asc" | "desc", direction: "previous" | "next") {
    return Buffer.from(JSON.stringify({ id: message.id, order, direction })).toString("base64url")
  },
  // 解码：把 base64url 令牌还原为游标结构（解析失败返回 None）
  decode(input: string) {
    return decodeCursor(Buffer.from(input, "base64url").toString("utf8"))
  },
}

// 导出 MessageHandler：注册 "server.message" 分组处理器
export const MessageHandler = HttpApiBuilder.group(Api, "server.message", (handlers) =>
  Effect.gen(function* () {
    // 获取会话服务
    const session = yield* Session.Service

    return handlers.handle(
      // 处理 session.messages：分页列出会话消息
      "session.messages",
      Effect.fn(function* (ctx) {
        // 游标与显式 order 参数互斥，同时提供则返回无效游标错误
        if (ctx.query.cursor && ctx.query.order !== undefined)
          return yield* new InvalidCursorError({ message: "Cursor cannot be combined with order" })
        // 有游标则解码；解码失败返回无效游标错误
        const decoded = ctx.query.cursor
          ? (Option.getOrUndefined(cursor.decode(ctx.query.cursor)) ??
            (yield* new InvalidCursorError({ message: "Invalid cursor" })))
          : undefined
        // 排序方向优先取游标内记录，其次取查询参数，默认倒序（desc，最新在前）
        const order = decoded?.order ?? ctx.query.order ?? "desc"
        // 组装查询输入：会话 ID、条数、排序、类型过滤与游标锚点
        const input = {
          sessionID: ctx.params.sessionID,
          limit: ctx.query.limit ?? DefaultMessagesLimit,
          order,
          type: ctx.query.type,
          cursor: decoded ? { id: decoded.id, direction: decoded.direction } : undefined,
        }
        // 分页辅助：给当前页的首/末消息生成向前后翻页的游标
        const page = <Message extends { readonly id: SessionMessage.ID }>(messages: ReadonlyArray<Message>) => {
          // 当前页第一条（用于"更早一页"的锚点）
          const first = messages[0]
          // 当前页最后一条（用于"更新一页"的锚点）
          const last = messages.at(-1)
          return {
            data: messages,
            cursor: {
              // 首条存在才生成 previous 游标
              previous: first ? cursor.encode(first, order, "previous") : undefined,
              // 末条存在才生成 next 游标
              next: last ? cursor.encode(last, order, "next") : undefined,
            },
          }
        }
        // 客户端要求媒体引用形式时，走 messagesWithRefs（媒体字段返回 media: URI 而非内联数据）
        if (wantsMediaRefs(ctx.request)) {
          const messages = yield* session
            .messagesWithRefs(input)
            .pipe(
              // 会话不存在 / 消息解码失败统一映射
              Effect.catchTag("Session.NotFoundError", missingSession),
              Effect.catchTag("Session.MessageDecodeError", failedMessageDecode),
            )
          // 用带媒体引用的响应 Schema 序列化分页结果（orDie：序列化失败视为程序缺陷）
          return yield* HttpServerResponse.schemaJson(SessionMediaMessagesResponse)(page(messages)).pipe(Effect.orDie)
        }
        // 常规路径：按输入查询消息列表
        const messages = yield* session
          .messages(input)
          .pipe(
            // 会话不存在 / 消息解码失败统一映射
            Effect.catchTag("Session.NotFoundError", missingSession),
            Effect.catchTag("Session.MessageDecodeError", failedMessageDecode),
          )
        // 返回分页结果
        return page(messages)
      }),
    )
  }),
)
