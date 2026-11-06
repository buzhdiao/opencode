// 引入位置（Location）服务：当前请求的工作目录上下文
import { Location } from "@opencode/core/location"
// 引入位置服务映射：按位置解析服务集、规范化位置键
import { LocationServiceMap } from "@opencode/core/location-service-map"
// 引入 MCP 核心服务：模型上下文协议（MCP）服务器的管理、连接与附件
import { Mcp } from "@opencode/core/mcp/index"
// 引入 PTY 票据（PtyTicket）服务：一次性连接票据的签发与核销
import { PtyTicket } from "@opencode/core/pty/ticket"
// 引入协议层错误：禁止访问（403）与 MCP 服务器未找到
import { ForbiddenError, McpServerNotFoundError } from "@opencode/protocol/errors"
// 引入 PTY 连接令牌常量（自定义请求头名与值）
import { PTY_CONNECT_TOKEN_HEADER, PTY_CONNECT_TOKEN_HEADER_VALUE } from "@opencode/protocol/groups/pty"
// 引入 Effect 与 Queue（无界队列，用于出站帧缓冲）
import { Effect, Queue } from "effect"
// 引入 HTTP 服务端响应工具
import { HttpServerResponse } from "effect/http"
// 引入 HTTP API 构建器与 Schema 工具
import { HttpApiBuilder, HttpApiSchema } from "effect/http-api"
// 引入 Socket：WebSocket 套接字类型（含关闭事件）
import { Socket } from "effect/socket"
// 引入本服务 API 定义
import { Api } from "../api"
// 引入 CORS 配置与来源（origin）校验工具
import { CorsConfig, isAllowedRequestOrigin } from "../cors"
// 引入位置辅助：错误映射、请求位置引用、response 包装
import { locationErrors, requestRef, response } from "../location"
// 引入 PTY 套接字公共逻辑：holdLocation（占用 location）与 runPtySocket（收发循环）
import { holdLocation, type Outbound, runPtySocket } from "./pty-socket"

// 辅助函数：把 MCP 的 NotFoundError 映射为协议层的 McpServerNotFoundError
const notFound = <A, R>(effect: Effect.Effect<A, Mcp.NotFoundError, R>) =>
  effect.pipe(Effect.mapError((error) => new McpServerNotFoundError({ server: error.server, message: error.message })))

// 导出 McpHandler：注册 "server.mcp" 分组处理器
export const McpHandler = HttpApiBuilder.group(Api, "server.mcp", (handlers) =>
  Effect.gen(function* () {
    // 获取位置服务映射（为 WebSocket 作用域提供依赖）
    const locations = yield* LocationServiceMap.Service
    // 获取 CORS 配置
    const cors = yield* CorsConfig
    // 获取 PTY 票据服务
    const tickets = yield* PtyTicket.Service

    return handlers
      .handle(
        // 处理 mcp.list：列出已配置的 MCP 服务器
        "mcp.list",
        Effect.fn(function* () {
          // 获取 MCP 服务
          const service = yield* Mcp.Service
          // 经 response 包装返回服务器列表
          return yield* response(service.servers())
        }),
      )
      .handle(
        // 处理 mcp.add：新增/更新一个 MCP 服务器配置
        "mcp.add",
        Effect.fn(function* (ctx) {
          // 获取 MCP 服务
          const service = yield* Mcp.Service
          // 按服务器名写入配置
          yield* service.add(ctx.params.server, ctx.payload.config)
          // 返回 204 无内容
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        // 处理 mcp.remove：移除一个 MCP 服务器
        "mcp.remove",
        Effect.fn(function* (ctx) {
          // 获取 MCP 服务
          const service = yield* Mcp.Service
          // 执行移除；不存在时经 notFound 映射错误
          yield* notFound(service.remove(ctx.params.server))
          // 返回 204 无内容
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        // 处理 mcp.connect：手动连接（启动）指定 MCP 服务器
        "mcp.connect",
        Effect.fn(function* (ctx) {
          // 获取 MCP 服务
          const service = yield* Mcp.Service
          // 执行连接；不存在时映射错误
          yield* notFound(service.connect(ctx.params.server))
          // 返回 204 无内容
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        // 处理 mcp.disconnect：断开指定 MCP 服务器
        "mcp.disconnect",
        Effect.fn(function* (ctx) {
          // 获取 MCP 服务
          const service = yield* Mcp.Service
          // 执行断开；不存在时映射错误
          yield* notFound(service.disconnect(ctx.params.server))
          // 返回 204 无内容
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        // 处理 mcp.resource.catalog：返回各 MCP 服务器暴露的资源目录
        "mcp.resource.catalog",
        Effect.fn(function* () {
          // 获取 MCP 服务
          const service = yield* Mcp.Service
          // 经 response 包装返回资源目录
          return yield* response(service.resourceCatalog())
        }),
      )
      .handle(
        // 处理 mcp.clientToken：为 MCP 客户端签发连接票据（ticket）
        "mcp.clientToken",
        Effect.fn(function* (ctx) {
          // The custom header forces a CORS preflight, so cross-origin pages cannot mint tickets.
          // 必须携带约定的自定义令牌头：该头会触发 CORS 预检，从而阻止跨源页面直接签发票据
          if (
            ctx.headers[PTY_CONNECT_TOKEN_HEADER] !== PTY_CONNECT_TOKEN_HEADER_VALUE ||
            // 同时校验请求来源（origin/host）在允许列表内
            !isAllowedRequestOrigin(ctx.request.headers.origin, ctx.request.headers.host, cors)
          )
            // 任一校验失败返回 403 禁止访问
            return yield* new ForbiddenError({ message: "Invalid client MCP connect token request" })
          // 获取当前请求的位置
          const location = yield* Location.Service
          // 签发绑定 MCP 客户端名与位置（目录/工作区）的票据
          return yield* response(
            tickets.issue({
              mcpClient: ctx.query.name,
              directory: location.directory,
              workspaceID: location.workspaceID,
            }),
          )
        }),
      )
      .handleRaw(
        // handleRaw 处理 mcp.client：升级为 WebSocket，作为 MCP 客户端的传输桥
        "mcp.client",
        Effect.fn("McpHandler.client")(function* (ctx) {
          // 校验请求来源在允许列表内，否则拒绝升级（403）
          if (!isAllowedRequestOrigin(ctx.request.headers.origin, ctx.request.headers.host, cors))
            return HttpServerResponse.empty({ status: 403 })

          // 读取查询参数中的 MCP 客户端名
          const name = ctx.query.name
          // 计算请求对应的位置键并规范化（canonical）
          const ref = LocationServiceMap.canonical(requestRef(ctx.request))
          // 若带票据则核销：票据必须匹配客户端名与位置，否则拒绝（403）
          if (
            ctx.query.ticket &&
            !(yield* tickets.consume({
              ticket: ctx.query.ticket,
              mcpClient: name,
              directory: ref.directory,
              workspaceID: ref.workspaceID,
            }))
          )
            return HttpServerResponse.empty({ status: 403 })

          return yield* Effect.gen(function* () {
            // 获取 MCP 服务
            const mcp = yield* Mcp.Service
            // 动态导入 MCP 套接字客户端（避免模块常驻加载）
            const { McpSocketClient } = yield* Effect.promise(() => import("@opencode/core/mcp/socket-client"))
            // 执行 WebSocket 升级（失败为缺陷，orDie）
            const socket = yield* Effect.orDie(ctx.request.upgrade)
            // 出站帧队列（无界）：发送给客户端的文本/关闭事件都先进队列
            const outbox = yield* Queue.unbounded<Outbound>()
            // 占用（retain）当前 location，防止空闲清理把服务逐出
            yield* holdLocation(outbox)
            // 连接状态标记：是否已附加成功、客户端是否已断开
            const state = { attached: false, disconnected: false }
            // 构造 MCP 传输适配器：把 MCP 消息桥接到 WebSocket
            const transport = McpSocketClient.make({
              // 发送：把文本帧推入出站队列
              send: (text) => Queue.offerUnsafe(outbox, text),
              // A failed attach closes the transport before reporting the error; ignore that close so the
              // socket closes with 1011 below instead of a normal 1000.
              // 关闭：附加失败时传输会先自行关闭；此处忽略那次关闭，让套接字以 1011（内部错误）而非 1000 正常关闭收尾
              close: (code, reason) => {
                if (state.attached) Queue.offerUnsafe(outbox, new Socket.CloseEvent(code, reason))
              },
            })
            // 文本解码器：把二进制帧按 UTF-8 解码
            const decoder = new TextDecoder()
            // The attachment lives in this scope, so it ends with the socket.
            // 附加（attach）到指定 MCP 客户端：其生命周期绑定当前作用域，随套接字关闭而结束
            yield* mcp.attach(name, transport).pipe(
              // 附加成功后置位 attached 标记
              Effect.tap(() =>
                Effect.sync(() => {
                  state.attached = true
                }),
              ),
              // 附加失败或客户端中途断开时的处理
              Effect.catch((error) =>
                // 客户端在初始化期间主动断开：仅记录 info 日志
                state.disconnected
                  ? Effect.logInfo("client MCP disconnected during initialize", { name, error: error.message })
                  // 附加失败：记录错误日志，并向客户端发送 1011 关闭帧
                  : Effect.logError("client MCP attach failed", { name, error: error.message }).pipe(
                      Effect.andThen(
                        Effect.sync(() => Queue.offerUnsafe(outbox, new Socket.CloseEvent(1011, "attach failed"))),
                      ),
                    ),
              ),
              // 在独立 fiber 中运行附加流程，不阻塞套接字收发循环
              Effect.forkScoped,
            )
            // 运行套接字收发循环直到任一侧结束
            yield* runPtySocket({
              socket,
              outbox,
              // Frames should be text, but binary frames are accepted and decoded as UTF-8.
              // 收到客户端消息：文本直接转发，二进制帧按 UTF-8 解码后转发
              onMessage: (message) =>
                Effect.sync(() => transport.deliver(typeof message === "string" ? message : decoder.decode(message))),
              // 客户端断开：标记断开并通知 MCP 侧传输已结束
              detach: () => {
                state.disconnected = true
                transport.ended()
              },
            })
            // 循环结束后返回空响应（实际数据已走 WebSocket）
            return HttpServerResponse.empty()
          }).pipe(Effect.scoped, Effect.provide(locations.get(ref)), locationErrors)
        }),
      )
  }),
)
