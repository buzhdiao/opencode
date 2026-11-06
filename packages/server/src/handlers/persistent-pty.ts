// 引入持久化终端（PersistentPty）核心服务：由独立守护进程管理的长期 PTY
import { PersistentPty } from "@opencode/core/persistent-pty"
// 引入 PTY 票据（PtyTicket）服务：一次性连接票据
import { PtyTicket } from "@opencode/core/pty/ticket"
// 引入协议层错误：禁止访问、无效请求、终端特性不支持、PTY 未找到、服务不可用
import {
  ForbiddenError,
  InvalidRequestError,
  PtyFeatureUnsupportedError,
  PtyNotFoundError,
  ServiceUnavailableError,
} from "@opencode/protocol/errors"
// 引入持久化 PTY 协议常量：连接票据查询参数名、连接令牌请求头名与值
import {
  PTY_CONNECT_TICKET_QUERY,
  PTY_CONNECT_TOKEN_HEADER,
  PTY_CONNECT_TOKEN_HEADER_VALUE,
} from "@opencode/protocol/groups/persistent-pty"
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
// 引入实验分组其余处理器的工厂：工件（artifact）、作业（job）、媒体（media）、计划任务（schedule）
import { makeArtifact } from "./artifact"
import { makeJob } from "./job"
import { makeMediaGet } from "./media"
// 引入 PTY 套接字公共逻辑：出站帧类型与收发循环
import { type Outbound, runPtySocket } from "./pty-socket"
import { makeSchedule } from "./schedule"

// 导出 PersistentPtyHandler：注册 "server.experimental" 实验分组处理器
// （该分组同时挂载媒体、作业、工件与计划任务端点）
export const PersistentPtyHandler = HttpApiBuilder.group(Api, "server.experimental", (handlers) =>
  Effect.gen(function* () {
    // 获取 PTY 票据服务
    const tickets = yield* PtyTicket.Service
    // 获取 CORS 配置
    const cors = yield* CorsConfig
    // 获取持久化终端服务
    const pty = yield* PersistentPty.Service
    // 构造各子处理器集合（依赖注入式的工厂）
    const artifact = yield* makeArtifact
    const job = yield* makeJob
    const mediaGet = yield* makeMediaGet
    const schedule = yield* makeSchedule

    return handlers
      // 处理 media.get：按哈希返回仍被引用的媒体 blob（透传给 media 处理器）
      .handleRaw("media.get", (ctx) => mediaGet(ctx.params.hash, ctx.request))
      // 处理 job.list：列出后台作业
      .handle("job.list", (ctx) => job.list(ctx.query))
      // 以下为工件（artifact）端点：供应商、列表、创建、读取、更新、删除与原始视图
      .handle("artifacts.providers", (ctx) => artifact.providers(ctx.query, ctx.request))
      .handle("artifacts.list", (ctx) => artifact.list(ctx.query, ctx.request))
      .handle("artifacts.create", (ctx) => artifact.create(ctx.query, ctx.payload, ctx.request))
      .handle("artifacts.get", (ctx) => artifact.get(ctx.params.artifactID, ctx.query, ctx.request))
      .handle("artifacts.update", (ctx) => artifact.update(ctx.params.artifactID, ctx.query, ctx.payload, ctx.request))
      .handle("artifacts.delete", (ctx) => artifact.remove(ctx.params.artifactID, ctx.query, ctx.request))
      .handleRaw("artifacts.view", (ctx) => artifact.view(ctx.params.artifactID, ctx.query, ctx.request))
      // 以下为计划任务（schedule）端点：创建、列表、读取、暂停、恢复、删除
      .handle("schedule.create", (ctx) => schedule.create(ctx.payload))
      .handle("schedule.list", (ctx) => schedule.list(ctx.query.sessionID))
      .handle("schedule.get", (ctx) => schedule.get(ctx.params.scheduleID))
      .handle("schedule.pause", (ctx) => schedule.pause(ctx.params.scheduleID))
      .handle("schedule.resume", (ctx) => schedule.resume(ctx.params.scheduleID))
      .handle("schedule.delete", (ctx) => schedule.remove(ctx.params.scheduleID))
      .handle(
        // 处理 persistentPty.read：读取某会话持久终端最近若干行
        "persistentPty.read",
        Effect.fn(function* (ctx) {
          // 读取行数由查询参数 lines 指定；守护进程不可用时映射错误
          return { data: yield* pty.read(ctx.params.sessionID, ctx.query.lines).pipe(mapUnavailable) }
        }),
      )
      .handle(
        // 处理 persistentPty.list：列出某会话下的全部持久终端
        "persistentPty.list",
        Effect.fn(function* (ctx) {
          // 列出终端；不可用时映射错误
          return { data: yield* pty.list(ctx.params.sessionID).pipe(mapUnavailable) }
        }),
      )
      .handle(
        // 处理 persistentPty.create：创建一个新的持久终端
        "persistentPty.create",
        Effect.fn(function* (ctx) {
          return {
            data: yield* pty
              // 创建参数：命令、参数、工作目录、标题、环境变量与初始行列数
              .create(ctx.params.sessionID, {
                command: ctx.payload.command,
                args: ctx.payload.args,
                cwd: ctx.payload.cwd,
                title: ctx.payload.title,
                env: ctx.payload.env,
                cols: ctx.payload.size?.cols,
                rows: ctx.payload.size?.rows,
              })
              .pipe(
                Effect.catchTags({
                  // 工作目录非法 -> InvalidRequestError（标注字段 cwd）
                  "PersistentPty.InvalidCwdError": (error) =>
                    new InvalidRequestError({ message: error.message, kind: "invalid_cwd", field: "cwd" }),
                  // 守护进程不可用 -> ServiceUnavailableError
                  "PersistentPty.UnavailableError": unavailable,
                }),
              ),
          }
        }),
      )
      .handle(
        // 处理 persistentPty.shutdown：关闭终端守护进程（全部终端一并终止）
        "persistentPty.shutdown",
        Effect.fn(function* () {
          // 执行关闭；不可用时映射错误
          yield* pty.shutdown().pipe(mapUnavailable)
          // 返回 204 无内容
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        // 处理 persistentPty.handoff：导出守护进程交接（handoff）状态，用于服务重启迁移
        "persistentPty.handoff",
        Effect.fn(function* () {
          // 返回交接数据；不可用时映射错误
          return { handoff: yield* pty.handoff().pipe(mapUnavailable) }
        }),
      )
      .handle(
        // 处理 persistentPty.get：获取单个终端的元信息
        "persistentPty.get",
        Effect.fn(function* (ctx) {
          // 按 ptyID 查询；未找到/不可用统一映射
          return { data: yield* pty.get(ctx.params.ptyID).pipe(mapTerminalError) }
        }),
      )
      .handle(
        // 处理 persistentPty.update：调整终端大小（resize）和/或重命名（rename）
        "persistentPty.update",
        Effect.fn(function* (ctx) {
          // 负载带 size 时先执行调整大小（附带附件 ID 以标识发起者）
          if (ctx.payload.size)
            yield* pty
              .resize(ctx.params.ptyID, ctx.payload.size.cols, ctx.payload.size.rows, ctx.payload.attachmentID)
              .pipe(mapTerminalError)
          // 负载未带 title（undefined 表示不改名）时，直接返回终端最新信息
          if (ctx.payload.title === undefined) return { data: yield* pty.get(ctx.params.ptyID).pipe(mapTerminalError) }
          return {
            // 执行重命名；各错误分别映射
            data: yield* pty.rename(ctx.params.ptyID, ctx.payload.title).pipe(
              Effect.catchTags({
                // 终端不存在 -> PtyNotFoundError
                "PersistentPty.NotFoundError": notFound,
                // 重命名特性暂不支持（如旧版守护进程）-> PtyFeatureUnsupportedError
                "PersistentPty.UnsupportedError": (error) =>
                  new PtyFeatureUnsupportedError({
                    feature: error.feature,
                    message: "Terminal renaming will be available after OpenCode's terminal service restarts",
                  }),
                // 守护进程不可用 -> ServiceUnavailableError
                "PersistentPty.UnavailableError": unavailable,
              }),
            ),
          }
        }),
      )
      .handle(
        // 处理 persistentPty.snapshot：获取终端内容快照（用于回放/渲染）
        "persistentPty.snapshot",
        Effect.fn(function* (ctx) {
          // 按 ptyID 取快照；未找到/不可用统一映射
          return { data: yield* pty.snapshot(ctx.params.ptyID).pipe(mapTerminalError) }
        }),
      )
      .handle(
        // 处理 persistentPty.remove：移除终端
        "persistentPty.remove",
        Effect.fn(function* (ctx) {
          // 执行删除；未找到/不可用统一映射
          yield* pty.remove(ctx.params.ptyID).pipe(mapTerminalError)
          // 返回 204 无内容
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        // 处理 persistentPty.connectToken：为 WebSocket 连接签发一次性票据
        "persistentPty.connectToken",
        Effect.fn(function* (ctx) {
          // 获取原始 HTTP 请求（读取自定义头）
          const request = yield* HttpServerRequest.HttpServerRequest
          // 必须携带约定令牌头（强制 CORS 预检，拦截跨源页面）且来源在允许列表内
          if (
            request.headers[PTY_CONNECT_TOKEN_HEADER] !== PTY_CONNECT_TOKEN_HEADER_VALUE ||
            !isAllowedRequestOrigin(request.headers.origin, request.headers.host, cors)
          )
            // 校验失败返回 403
            return yield* new ForbiddenError({ message: "Invalid persistent PTY connect token request" })
          // 确认终端存在（不存在则映射错误），再签发票据
          yield* pty.get(ctx.params.ptyID).pipe(mapTerminalError)
          // 签发绑定该 ptyID 的票据
          return { data: yield* tickets.issue({ ptyID: ctx.params.ptyID }) }
        }),
      )
      .handleRaw(
        // handleRaw 处理 persistentPty.connect：升级为 WebSocket 并附加到持久终端
        "persistentPty.connect",
        Effect.fn("PersistentPtyHandler.connect")(function* (ctx) {
          // 校验请求来源在允许列表内，否则拒绝升级（403）
          if (!isAllowedRequestOrigin(ctx.request.headers.origin, ctx.request.headers.host, cors))
            return HttpServerResponse.empty({ status: 403 })

          // 解析请求 URL 的查询参数
          const url = new URL(ctx.request.url, "http://localhost")
          // 读取连接票据（可选）
          const ticket = url.searchParams.get(PTY_CONNECT_TICKET_QUERY)
          // 带票据则核销：票据必须匹配该 ptyID，否则拒绝（403）
          if (ticket && !(yield* tickets.consume({ ticket, ptyID: ctx.params.ptyID })))
            return HttpServerResponse.empty({ status: 403 })

          // 回放缓存起点（游标偏移量），缺省 0
          const cursor = Number(url.searchParams.get("cursor") ?? "0")
          // 角色：observer 只读旁观；其余（含缺省）为 controller 可写入
          const role = url.searchParams.get("role") === "observer" ? "observer" : "controller"
          // 输入协议版本：为 "1" 时客户端输入使用带尺寸头的帧协议
          const framedInput = url.searchParams.get("input_protocol") === "1"
          // 附件 ID：客户端未提供则由服务端生成
          const attachmentID = url.searchParams.get("attachment_id") ?? crypto.randomUUID()
          // 游标必须是安全的非负整数，否则返回 400
          if (!Number.isSafeInteger(cursor) || cursor < 0) return HttpServerResponse.empty({ status: 400 })

          // 执行 WebSocket 升级（失败为缺陷）
          const socket = yield* Effect.orDie(ctx.request.upgrade)
          // 出站帧队列：回放数据、实时输出、事件 JSON、关闭事件都经此顺序下发
          const outbox = yield* Queue.unbounded<Outbound>()
          // 已建立的终端附件（附加成功前为 undefined）
          let attachment: PersistentPty.Attachment | undefined
          // Bun's native ws upgrade must start before asynchronous daemon I/O.
          // 连接建立后的初始化流程（附加到守护进程并开始回放）
          const onOpen = Effect.gen(function* () {
            // 附加到指定终端：携带游标（回放起点）、附件 ID、角色与接管（takeover）标志
            attachment = yield* pty
              .attach(ctx.params.ptyID, {
                cursor,
                attachmentID,
                role,
                takeover: url.searchParams.get("takeover") === "true",
                // 事件回调：把守护进程事件转换为出站帧
                onEvent: (event) => {
                  // 输出事件：直接作为文本帧下发
                  if (event.type === "output") Queue.offerUnsafe(outbox, event.data)
                  // 调整大小事件：检查点（二进制）转为 base64 后以 JSON 下发
                  if (event.type === "resized")
                    Queue.offerUnsafe(
                      outbox,
                      JSON.stringify({ ...event, checkpoint: Buffer.from(event.checkpoint).toString("base64") }),
                    )
                  // 其余事件：原样序列化为 JSON 下发
                  if (event.type !== "output" && event.type !== "resized")
                    Queue.offerUnsafe(outbox, JSON.stringify(event))
                },
                // 终端结束：发送 1000 正常关闭帧
                onEnd: () => Queue.offerUnsafe(outbox, new Socket.CloseEvent(1000)),
              })
              .pipe(
                Effect.catchTags({
                  // 附加失败（未找到/不可用）不使连接立即报错，稍后发 4404 关闭帧
                  "PersistentPty.NotFoundError": () => Effect.succeed(undefined),
                  "PersistentPty.UnavailableError": () => Effect.succeed(undefined),
                }),
              )
            // 附加失败：发送 4404（自定义“终端不可用”）关闭帧并结束初始化
            if (!attachment) {
              Queue.offerUnsafe(outbox, new Socket.CloseEvent(4404, "terminal unavailable"))
              return
            }

            // 发送 attached 帧报告连接元信息：附件 ID、输入协议、终端信息、角色、代数与回放区间
            Queue.offerUnsafe(
              outbox,
              JSON.stringify({
                type: "attached",
                attachmentID,
                inputProtocol: framedInput ? 1 : 0,
                info: attachment.info,
                role: attachment.role,
                generation: attachment.generation,
                replay: {
                  requestedOffset: attachment.replay.requestedOffset,
                  availableOffset: attachment.replay.availableOffset,
                  endOffset: attachment.replay.endOffset,
                  truncated: attachment.replay.truncated,
                },
              }),
            )
            // 存在回放数据时先整体下发
            if (attachment.replay.data.length > 0) Queue.offerUnsafe(outbox, attachment.replay.data)
            // 随后发送 replay_complete 帧，告知回放结束及最终偏移
            Queue.offerUnsafe(
              outbox,
              JSON.stringify({ type: "replay_complete", endOffset: attachment.replay.endOffset }),
            )
            // 激活附件：开始接收实时事件
            attachment.activate()
          })

          // 运行套接字收发循环直到任一侧结束
          yield* runPtySocket({
            socket,
            outbox,
            // 连接建立时执行上面的初始化
            onOpen,
            // 收到客户端消息的处理
            onMessage: (message) => {
              // 附件尚未建立时忽略输入
              if (!attachment) return Effect.void
              // 统一转为 Buffer（文本消息编码为 UTF-8）
              const data = typeof message === "string" ? Buffer.from(message) : message
              // 旧协议：整条消息即终端输入
              if (!framedInput)
                return pty
                  .input(ctx.params.ptyID, attachmentID, attachment.info.size.cols, attachment.info.size.rows, data)
                  .pipe(Effect.ignore)
              // 帧协议：数据不足 5 字节（1 类型 + 2 列 + 2 行）则忽略
              if (data.byteLength < 5) return Effect.void
              // 建立二进制视图读取头部字段
              const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
              // 第 0 字节：帧类型（0 控制帧 / 1 输入帧）
              const type = data[0]
              // 第 1-2 字节：列数（大端）
              const cols = view.getUint16(1)
              // 第 3-4 字节：行数（大端）
              const rows = view.getUint16(3)
              // 类型非法或行列数为 0 的帧直接忽略
              if ((type !== 0 && type !== 1) || cols === 0 || rows === 0) return Effect.void
              // 控制帧：仅调整终端尺寸
              if (type === 0) return pty.control(ctx.params.ptyID, attachmentID, cols, rows).pipe(Effect.ignore)
              // 输入帧：跳过 5 字节头，把余下数据作为终端输入
              return pty.input(ctx.params.ptyID, attachmentID, cols, rows, data.subarray(5)).pipe(Effect.ignore)
            },
            // 连接结束：分离（detach）附件，停止接收该客户端的事件
            detach: () => attachment?.detach(),
          })
          // 循环结束后返回空响应（实际数据已走 WebSocket）
          return HttpServerResponse.empty()
        }),
      )
  }),
)

// 辅助映射：把“守护进程不可用”错误映射为 ServiceUnavailableError
const mapUnavailable = <A>(effect: Effect.Effect<A, PersistentPty.UnavailableError>) =>
  effect.pipe(Effect.catchTag("PersistentPty.UnavailableError", unavailable))

// 辅助映射：把“未找到/不可用”两类错误统一映射为协议错误
const mapTerminalError = <A>(effect: Effect.Effect<A, PersistentPty.NotFoundError | PersistentPty.UnavailableError>) =>
  effect.pipe(
    Effect.catchTags({
      // 终端不存在 -> PtyNotFoundError
      "PersistentPty.NotFoundError": notFound,
      // 守护进程不可用 -> ServiceUnavailableError
      "PersistentPty.UnavailableError": unavailable,
    }),
  )

// 辅助映射：构造“PTY 会话未找到”错误
const notFound = (error: PersistentPty.NotFoundError) =>
  new PtyNotFoundError({ ptyID: error.ptyID, message: `PTY session not found: ${error.ptyID}` })

// 辅助映射：构造“终端服务不可用”错误（service 标识为 opencode-pty）
const unavailable = (error: PersistentPty.UnavailableError) =>
  new ServiceUnavailableError({ message: error.message, service: "opencode-pty" })
