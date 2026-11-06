// 引入事件 Schema（Event）：事件类型与事件 ID 生成
import { Event } from "@opencode/schema/event"
// 引入 Effect 与 Stream（流）：用于构建服务器推送（SSE）响应
import { Effect, Stream } from "effect"
// 引入 HTTP 服务端响应工具
import { HttpServerResponse } from "effect/http"
// 引入 HTTP API 构建器
import { HttpApiBuilder } from "effect/http-api"
// 引入本服务 API 定义
import { Api } from "../api"
// 引入 EventFeed：服务器内部的事件总线订阅源
import { EventFeed } from "../event-feed"

// 导出 EventHandler：注册 "server.event" 分组，提供事件订阅（SSE）端点
export const EventHandler = HttpApiBuilder.group(Api, "server.event", (handlers) =>
  Effect.gen(function* () {
    // 获取事件订阅源服务
    const feed = yield* EventFeed.Service
    // handleRaw：直接控制原始 HTTP 响应（这里是流式 SSE）
    return handlers.handleRaw("event.subscribe", (ctx) =>
      Effect.gen(function* () {
        // 构造连接成功后立即下发的 "server.connected" 初始事件
        const connected = {
          // 每个连接一个唯一事件 ID
          id: Event.ID.create(),
          // 事件类型：服务器已连接
          type: "server.connected",
          // 无附加数据
          data: {},
        } as const
        // Stream.unwrap：先执行订阅动作（按客户端要求的类型过滤），再把实时事件流与初始事件拼接
        const output = Stream.unwrap(
          feed
            // 订阅事件源；ctx.query.types 指定客户端关心的事件类型
            .subscribe(ctx.query.types)
            // 订阅成功后，把初始连接事件帧放在实时流前面
            .pipe(Effect.map((live) => Stream.make(EventFeed.frame(connected)).pipe(Stream.concat(live)))),
        )
        // 心跳流：每 15 秒发送一条 SSE 注释行（": heartbeat"），防止代理/连接超时断开
        const heartbeat = Stream.tick("15 seconds").pipe(Stream.map(() => ": heartbeat\n\n"))
        // 以 text/event-stream 响应返回；主事件流与心跳合并，主流结束（haltStrategy: "left"）即整体结束
        return HttpServerResponse.stream(
          output.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }), Stream.encodeText),
          {
            // 响应内容类型必须是 text/event-stream
            contentType: "text/event-stream",
            headers: {
              // 禁止缓存与中间件改写（no-transform）
              "Cache-Control": "no-cache, no-transform",
              // 告诉 Nginx 等反代不要缓冲该响应，保证事件实时下发
              "X-Accel-Buffering": "no",
              // 禁止浏览器嗅探内容类型（nosniff）
              "X-Content-Type-Options": "nosniff",
            },
          },
        )
      }),
    )
  }),
)
