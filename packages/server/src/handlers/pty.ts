// 引入 PTY（伪终端）核心服务：会话内终端的创建与附加
import { Pty } from "@opencode/core/pty"
// 引入 PTY 协议工具：帧编解码与分块
import { PtyProtocol } from "@opencode/core/pty/protocol"
// 引入 PTY 票据（PtyTicket）服务：一次性连接票据
import { PtyTicket } from "@opencode/core/pty/ticket"
// 引入位置（Location）服务
import { Location } from "@opencode/core/location"
// 引入位置服务映射：按位置解析服务集、规范化位置键
import { LocationServiceMap } from "@opencode/core/location-service-map"
// 引入 Effect 与 Queue（出站帧队列）
import { Effect, Queue } from "effect"
// 引入 HTTP 请求/响应工具
import { HttpServerRequest, HttpServerResponse } from "effect/http"
// 引入 HTTP API 构建器与 Schema 工具（204 响应）
import { HttpApiBuilder, HttpApiSchema } from "effect/http-api"
// 引入 Socket：WebSocket 套接字类型（含关闭事件）
import { Socket } from "effect/socket"
// 引入本服务 API 定义
import { Api } from "../api"
// 引入 CORS 配置与来源校验工具
import { CorsConfig, isAllowedRequestOrigin } from "../cors"
// 引入协议层错误：禁止访问（403）与 PTY 未找到
import { ForbiddenError, PtyNotFoundError } from "@opencode/protocol/errors"
// 引入 PTY 协议常量：连接票据查询参数名、连接令牌请求头名与值
import {
  PTY_CONNECT_TICKET_QUERY,
  PTY_CONNECT_TOKEN_HEADER,
  PTY_CONNECT_TOKEN_HEADER_VALUE,
} from "@opencode/protocol/groups/pty"
// 引入位置辅助：错误映射、请求位置引用、response 包装
import { locationErrors, requestRef, response } from "../location"
// 引入 PTY 套接字公共逻辑：holdLocation（占用 location）与 runPtySocket（收发循环）
import { holdLocation, type Outbound, runPtySocket } from "./pty-socket"

// 辅助函数：构造“PTY 会话未找到”错误
const notFound = (ptyID: Pty.ID) => new PtyNotFoundError({ ptyID, message: `PTY session not found: ${ptyID}` })

// 导出 PtyHandler：注册 "server.pty" 分组处理器
export const PtyHandler = HttpApiBuilder.group(Api, "server.pty", (handlers) =>
  Effect.gen(function* () {
    // 获取位置服务映射（为 WebSocket 作用域提供依赖）
    const locations = yield* LocationServiceMap.Service
    // 获取 PTY 票据服务
    const tickets = yield* PtyTicket.Service
    // 获取 CORS 配置
    const cors = yield* CorsConfig

    return handlers
      .handle(
        // 处理 pty.list：列出当前全部终端会话
        "pty.list",
        Effect.fn(function* () {
          // 获取 PTY 服务
          const pty = yield* Pty.Service
          // 经 response 包装返回终端列表
          return yield* response(pty.list())
        }),
      )
      .handle(
        // 处理 pty.create：创建一个新的终端会话
        "pty.create",
        Effect.fn(function* (ctx) {
          // 获取 PTY 服务
          const pty = yield* Pty.Service
          // 获取当前请求的位置
          const location = yield* Location.Service
          return yield* response(
            pty.create({
              // 透传负载字段；cwd 未指定时回退到当前位置目录
              ...ctx.payload,
              cwd: ctx.payload.cwd || location.directory,
            }),
          )
        }),
      )
      .handle(
        // 处理 pty.get：获取单个终端会话详情
        "pty.get",
        Effect.fn(function* (ctx) {
          // 获取 PTY 服务
          const pty = yield* Pty.Service
          return yield* response(
            // 查询终端；未找到时映射为 PtyNotFoundError
            pty.get(ctx.params.ptyID).pipe(Effect.catchTag("Pty.NotFoundError", () => notFound(ctx.params.ptyID))),
          )
        }),
      )
      .handle(
        // 处理 pty.update：更新终端（如调整大小/标题）
        "pty.update",
        Effect.fn(function* (ctx) {
          // 获取 PTY 服务
          const pty = yield* Pty.Service
          return yield* response(
            // 执行更新；未找到时映射为 PtyNotFoundError
            pty
              .update(ctx.params.ptyID, ctx.payload)
              .pipe(Effect.catchTag("Pty.NotFoundError", () => notFound(ctx.params.ptyID))),
          )
        }),
      )
      .handle(
        // 处理 pty.remove：移除终端会话
        "pty.remove",
        Effect.fn(function* (ctx) {
          // 获取 PTY 服务
          const pty = yield* Pty.Service
          // 执行删除；未找到时映射为 PtyNotFoundError
          yield* pty
            .remove(ctx.params.ptyID)
            .pipe(Effect.catchTag("Pty.NotFoundError", () => notFound(ctx.params.ptyID)))
          // 返回 204 无内容
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        // 处理 pty.connectToken：为 WebSocket 连接签发一次性票据
        "pty.connectToken",
        Effect.fn(function* (ctx) {
          // 获取原始 HTTP 请求（读取自定义头）
          const request = yield* HttpServerRequest.HttpServerRequest
          // The custom header forces a CORS preflight, so cross-origin browser pages cannot
          // mint tickets without passing the server's origin policy.
          // 必须携带约定令牌头：该头会触发 CORS 预检，跨源页面无法绕过服务端的来源策略签发票据
          if (
            request.headers[PTY_CONNECT_TOKEN_HEADER] !== PTY_CONNECT_TOKEN_HEADER_VALUE ||
            // 同时校验请求来源（origin/host）在允许列表内
            !isAllowedRequestOrigin(request.headers.origin, request.headers.host, cors)
          )
            // 任一校验失败返回 403
            return yield* new ForbiddenError({ message: "Invalid PTY connect token request" })
          // 获取 PTY 服务
          const pty = yield* Pty.Service
          // 获取当前请求的位置
          const location = yield* Location.Service
          // 确认终端存在（不存在则映射错误）
          yield* pty.get(ctx.params.ptyID).pipe(Effect.catchTag("Pty.NotFoundError", () => notFound(ctx.params.ptyID)))
          return yield* response(
            // 签发绑定 ptyID 与位置（目录/工作区）的票据
            tickets.issue({
              ptyID: ctx.params.ptyID,
              directory: location.directory,
              workspaceID: location.workspaceID,
            }),
          )
        }),
      )
      .handleRaw(
        // handleRaw 处理 pty.connect：升级为 WebSocket 并附加到终端
        "pty.connect",
        Effect.fn("PtyHandler.connect")(function* (ctx) {
          // 校验请求来源在允许列表内，否则拒绝升级（403）
          if (!isAllowedRequestOrigin(ctx.request.headers.origin, ctx.request.headers.host, cors))
            return HttpServerResponse.empty({ status: 403 })

          // 计算请求对应的位置键并规范化（canonical）
          const ref = LocationServiceMap.canonical(requestRef(ctx.request))
          // 解析请求 URL 的查询参数
          const url = new URL(ctx.request.url, "http://localhost")
          // 读取连接票据（可选）
          const ticket = url.searchParams.get(PTY_CONNECT_TICKET_QUERY)
          // 带票据则核销：票据必须匹配 ptyID 与位置，否则拒绝（403）
          if (
            ticket &&
            !(yield* tickets.consume({
              ticket,
              ptyID: ctx.params.ptyID,
              directory: ref.directory,
              workspaceID: ref.workspaceID,
            }))
          )
            return HttpServerResponse.empty({ status: 403 })

          return yield* Effect.gen(function* () {
            // 获取 PTY 服务
            const pty = yield* Pty.Service
            // 确认终端存在：查询失败（未找到）时置 false
            const exists = yield* pty.get(ctx.params.ptyID).pipe(
              Effect.as(true),
              Effect.catchTag("Pty.NotFoundError", () => Effect.succeed(false)),
            )
            // 终端不存在返回 404（在升级响应前拒绝）
            if (!exists) return HttpServerResponse.empty({ status: 404 })
            // 读取回放起点游标（缓存偏移量）
            const parsedCursor = url.searchParams.get("cursor")
            // 字符串转数字；未提供则为 undefined
            const cursorNumber = parsedCursor === null ? undefined : Number(parsedCursor)
            // 仅接受安全的、不小于 -1 的整数游标，否则回退为默认（全量回放）
            const cursor =
              cursorNumber !== undefined && Number.isSafeInteger(cursorNumber) && cursorNumber >= -1
                ? cursorNumber
                : undefined

            // 执行 WebSocket 升级（失败为缺陷）
            const socket = yield* Effect.orDie(ctx.request.upgrade)
            // TODO: Integrate graceful-shutdown socket tracking before clients migrate to this route.
            // 出站帧队列：回放数据、实时输出与关闭事件都经此顺序下发
            const outbox = yield* Queue.unbounded<Outbound>()
            // 占用（retain）当前 location，防止空闲清理把服务逐出
            yield* holdLocation(outbox)
            // 附加到终端：注册输出回调并获取回放数据
            const attachment = yield* pty
              .attach(ctx.params.ptyID, {
                cursor,
                // 输出回调：把数据块推入出站队列
                onData: (chunk) => Queue.offerUnsafe(outbox, chunk),
                // 终端结束：发送 1000 正常关闭帧
                onEnd: () => Queue.offerUnsafe(outbox, new Socket.CloseEvent(1000)),
              })
              .pipe(
                Effect.catchTags({
                  // 终端未找到：发送 4404（自定义“会话未找到”）关闭帧
                  "Pty.NotFoundError": () =>
                    Effect.sync(() => {
                      Queue.offerUnsafe(outbox, new Socket.CloseEvent(4404, "session not found"))
                    }),
                  // 终端已退出：发送 4404（自定义“会话已退出”）关闭帧
                  "Pty.ExitedError": () =>
                    Effect.sync(() => {
                      Queue.offerUnsafe(outbox, new Socket.CloseEvent(4404, "session exited"))
                    }),
                }),
              )
            // 附加成功时先回放：按协议分块下发历史数据，再发送元信息帧，最后激活附件
            if (attachment) {
              for (const chunk of PtyProtocol.chunks(attachment.replay)) Queue.offerUnsafe(outbox, chunk)
              Queue.offerUnsafe(outbox, PtyProtocol.metaFrame(attachment.cursor))
              attachment.activate()
            }

            // 运行套接字收发循环直到任一侧结束
            yield* runPtySocket({
              socket,
              outbox,
              // 收到客户端消息：按协议解码出输入字节并写入终端
              onMessage: (message) =>
                Effect.sync(() => {
                  // 附加失败时忽略任何输入
                  if (!attachment) return
                  // 解码输入帧（不合法则返回 undefined）
                  const decoded = PtyProtocol.decodeInput(message)
                  // 合法输入写入终端
                  if (decoded !== undefined) attachment.write(decoded)
                }),
              // 连接结束：分离（detach）附件
              detach: () => attachment?.detach(),
            })
            // 循环结束后返回空响应（实际数据已走 WebSocket）
            return HttpServerResponse.empty()
          }).pipe(Effect.scoped, Effect.provide(locations.get(ref)), locationErrors)
        }),
      )
  }),
)
