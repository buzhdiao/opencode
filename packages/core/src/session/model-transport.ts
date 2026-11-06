// 会话模型传输（SessionModelTransport）模块：管理每个会话与模型后端之间的
// WebSocket 长连接通道（channel）——连接复用与轮换、单次交换（exchange）的
// 帧流、空闲超时、降级到 HTTP 的策略，以及协议级错误的归因。
export * as SessionModelTransport from "./model-transport.js"

// AI 路由层：WebSocket 传输与通道相关类型
import {
  WebSocketTransport,
  type ChannelObservation,
  type ChannelCheckpoint,
  type WebSocketChannelExchange,
  type WebSocketChannelExecution,
  type WebSocketChannelExecutor,
  type WebSocketConnection,
  type WebSocketConnector,
} from "@opencode/ai/route"
// AI 错误模型与传输错误类型
import { AIError, AIErrorReason, TransportError, type TransportOperation } from "@opencode/ai/effect"
// 哈希工具（亲和键计算用）
import { Hash } from "@opencode/util/hash"
// Effect 核心：Cause、Clock、Context、Duration、Effect、Fiber、Layer、Metric、Queue、Scope、Semaphore、Stream
import { Cause, Clock, Context, Duration, Effect, Fiber, Layer, Metric, Queue, Scope, Semaphore, Stream } from "effect"
// HTTP 头工具（把钩子给的头转换为连接头）
import { Headers } from "effect/http"
// Socket 工具（取 WebSocket 构造器）
import { Socket } from "effect/socket"
// 全局单例节点构造工具
import { makeGlobalNode } from "@opencode/util/effect/app-node"
// 会话领域 Schema（会话 ID 类型）
import { SessionSchema } from "./schema.js"
// 平台相关的 WebSocket 构造器节点
import { webSocketConstructor } from "../effect/app-node-platform.js"

// 连接轮换的时限：使用超过 55 分钟后换新连接（避开常见的 1 小时限额/断连）
const ROTATE_AFTER_MS = 55 * 60 * 1000
// 建立连接的超时时间
const CONNECT_TIMEOUT = "15 seconds"
// Reasoning models can stream nothing for several minutes while still working.
// 空闲超时：推理类模型可能几分钟没有任何输出但仍在工作
const IDLE_TIMEOUT = "30 minutes"
/** Consecutive exchanges lost to the socket before the Session stays on HTTP. */
// 连续多少次交换（exchange）因 socket 问题失败后，该会话固定降级到 HTTP
const MAX_STREAM_FAILURES = 5
// 生命周期事件计数器（指标）
const events = Metric.counter("opencode_session_websocket_events_total", {
  description: "Session WebSocket lifecycle events",
  incremental: true,
})
// metric：记录一个生命周期事件（可附带属性）
const metric = (event: string, attributes: Record<string, string> = {}) =>
  Metric.update(events.pipe(Metric.withAttributes({ event, ...attributes })), 1)

// Active：一次进行中的交换（活跃期）——帧队列与投递（delivery）阶段标记
interface Active {
  // 入站帧队列（失败原因为 AIError）
  readonly queue: Queue.Queue<string, AIError>
  // 投递阶段：已尝试发送 -> provider 已确认收到 -> 已到终态
  delivery: "send-attempted" | "provider-observed" | "terminal"
}

// Channel：一条 WebSocket 连接通道的状态
interface Channel {
  // 亲和键：URL + 排序后头的哈希，头变了连接要重开
  readonly affinity: string
  // 底层连接
  readonly connection: WebSocketConnection
  // 建立时间（用于按年龄轮换）
  readonly openedAt: number
  // 当前活跃的交换（可选）
  active?: Active
  // 是否正在关闭（防止重复关闭）
  closing: boolean
  // 已提交的检查点（checkpoint），用于续传
  checkpoint?: ChannelCheckpoint
  // 待提交的检查点（带 token 防串扰）
  pending?: { readonly token: object; readonly checkpoint: ChannelCheckpoint }
  // 读循环的 Fiber
  reader?: Fiber.Fiber<unknown, unknown>
}

// State：每个会话的传输状态（互斥锁、关闭标记、降级标记、连续失败计数、当前通道）
interface State {
  // 串行化各交换启动的信号量
  readonly lock: Semaphore.Semaphore
  // 服务是否已关闭
  closed: boolean
  // 是否已固定降级到 HTTP
  httpFallback: boolean
  // 连续流式失败次数
  streamFailures: number
  // 当前打开的通道
  channel?: Channel
}

/** Selects the connection for one exchange. Its output feeds the affinity key, so changed headers reopen the socket. */
// Handshake：为一次交换选择连接（钩子可改 URL/头；输出参与亲和键计算）
export interface Handshake {
  readonly url: string
  readonly headers: Record<string, string>
}

/**
 * Per-exchange taps. `handshake` runs before the connection is selected; `send` sees each outbound
 * frame after the driver builds it; `receive` sees each inbound frame before the driver observes it.
 */
// Interceptor：单次交换的拦截点（握手前、出站帧、入站帧各可改写）
export interface Interceptor {
  readonly handshake?: (connect: Handshake) => Effect.Effect<Handshake>
  readonly send?: (frame: string) => Effect.Effect<string>
  readonly receive?: (frame: string) => Effect.Effect<string>
}

// 服务接口：bind 绑定某会话的通道执行器；close/closeAll 关闭连接
export interface Interface {
  readonly bind: (
    sessionID: SessionSchema.ID,
    interceptor?: Interceptor,
    idleTimeout?: number | false,
  ) => WebSocketChannelExecutor
  readonly close: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly closeAll: Effect.Effect<void>
}

// 服务标识：Effect Context 中用于定位本服务的 Tag
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionModelTransport") {}

// transportError：构造一个传输类 AI 错误（统一 transport: websocket）
const transportError = (
  message: string,
  input: {
    readonly operation: TransportOperation
    readonly url?: string
    readonly code?: string
    readonly phase?: TransportError["phase"]
    readonly delivery?: TransportError["delivery"]
  },
) =>
  new AIError({
    reason: new TransportError({ message, transport: "websocket", ...input }),
  })

// annotate：在既有 AI 错误上补充阶段（phase）与投递（delivery）信息（非传输错误原样返回）
const annotate = (
  error: AIError,
  input: { readonly phase: TransportError["phase"]; readonly delivery: TransportError["delivery"] },
) => {
  if (error.reason._tag !== "Transport") return error
  return new AIError({
    reason: new TransportError({
      ...error.reason,
      message: error.message,
      cause: error.reason.cause,
      ...input,
    }),
  })
}

// affinity：计算通道亲和键 = URL + 头按名排序后的 JSON SHA-256（头不同则键不同）
const affinity = (exchange: WebSocketChannelExchange) =>
  `${exchange.connect.url}:${Hash.sha256(JSON.stringify(Object.entries(exchange.connect.headers).sort(([a], [b]) => a.localeCompare(b))))}`

// observationFrame：把通道观察转为帧——帧/完成/不完整都带帧，其余（错误）直接失败
const observationFrame = (observation: ChannelObservation) => {
  if (observation.type === "frame" || observation.type === "completed" || observation.type === "incomplete")
    return Effect.succeed(observation.frame)
  return Effect.fail(observation.error)
}

// observationTerminal：观察是否为终态（非普通帧即终态）
const observationTerminal = (observation: ChannelObservation) => observation.type !== "frame"

// makeLayer：以给定的连接器（connector）构建服务层（便于测试注入不同的连接实现）
export const makeLayer = (connector: WebSocketConnector) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      // 获取层的作用域：读循环 Fiber 挂在其下，层关闭时自动中断
      const scope = yield* Scope.Scope
      // 各会话的状态表
      const states = new Map<SessionSchema.ID, State>()
      // state：取（或惰性创建）某会话的传输状态
      const state = (sessionID: SessionSchema.ID) => {
        const current = states.get(sessionID)
        if (current) return current
        const created = { lock: Semaphore.makeUnsafe(1), closed: false, httpFallback: false, streamFailures: 0 }
        states.set(sessionID, created)
        return created
      }

      // closeChannel：关闭一条通道——清理状态、中断读循环、关连接、让活跃队列以错误收尾
      const closeChannel = Effect.fn("SessionModelTransport.closeChannel")(function* (owner: State, channel: Channel) {
        // 该通道仍是会话的当前通道时才清空引用
        if (owner.channel === channel) owner.channel = undefined
        // 已在关闭中则避免重复关闭
        if (channel.closing) return
        channel.closing = true
        // 中断读循环 Fiber
        if (channel.reader) yield* Fiber.interrupt(channel.reader)
        // 关闭底层连接
        yield* channel.connection.close
        // 活跃交换还在：以其队列失败收尾；provider 已观察到投递则视为"已接受"，
        // 否则结果未知（ambiguous）
        if (channel.active)
          Queue.failCauseUnsafe(
            channel.active.queue,
            Cause.fail(
              transportError("Session WebSocket closed", {
                operation: "read",
                code: "close",
                phase: "close",
                delivery:
                  channel.active.delivery === "provider-observed" || channel.active.delivery === "terminal"
                    ? "accepted"
                    : "ambiguous",
              }),
            ),
          )
        yield* metric("close")
      })

      // poison：通道发生协议级损坏——踢出当前通道、记录日志、令活跃队列失败并计入流式失败
      const poison = Effect.fn("SessionModelTransport.poison")(function* (
        owner: State,
        channel: Channel,
        error: AIError,
      ) {
        if (owner.channel === channel) owner.channel = undefined
        if (channel.closing) return
        channel.closing = true
        yield* Effect.logDebug("session websocket poisoned", {
          sessionTransport: "websocket",
          code: error.reason._tag === "Transport" ? error.reason.code : error.reason._tag,
          active: channel.active !== undefined,
        })
        if (channel.active) {
          // 活跃队列以该错误失败
          Queue.failCauseUnsafe(channel.active.queue, Cause.fail(error))
          // 计入连续流式失败
          yield* streamFailure(owner)
        }
        yield* metric("protocol_failure")
        yield* channel.connection.close
      })

      // A socket that keeps dying mid-exchange costs a retry every step; after enough consecutive
      // losses the Session stays on HTTP.
      // streamFailure：累计连续流式失败；达到上限则把会话固定降级到 HTTP
      const streamFailure = Effect.fn("SessionModelTransport.streamFailure")(function* (owner: State) {
        owner.streamFailures++
        if (owner.streamFailures < MAX_STREAM_FAILURES) return
        owner.httpFallback = true
        yield* Effect.logWarning("session websocket failed repeatedly; using http", {
          sessionTransport: "websocket",
          failures: owner.streamFailures,
        })
        yield* metric("fallback", { reason: "stream_failures" })
      })

      // open：建立新连接并启动读循环（不可中断的连接过程，读循环挂到层作用域）
      const open = Effect.fn("SessionModelTransport.open")(function* (
        owner: State,
        exchange: WebSocketChannelExchange,
        key: string,
      ) {
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            // 打开连接：限时 15 秒，超时转成传输错误
            const connection = yield* restore(
              connector.open(exchange.connect).pipe(
                Effect.timeoutOrElse({
                  duration: CONNECT_TIMEOUT,
                  orElse: () =>
                    transportError("Timed out opening the Session WebSocket", {
                      url: exchange.connect.url,
                      operation: "request",
                      code: "connect-timeout",
                      phase: "connect",
                      delivery: "not-sent",
                    }),
                }),
                Effect.withSpan("SessionModelTransport.connect"),
              ),
            )
            // 连接建立期间会话服务被关闭：立即关掉连接并报错
            if (owner.closed) {
              yield* connection.close
              return yield* transportError("Session WebSocket owner closed while connecting", {
                operation: "request",
                code: "owner-closed",
                phase: "connect",
                delivery: "not-sent",
              })
            }
            // 组装通道对象并登记为当前通道
            const channel: Channel = {
              affinity: key,
              connection,
              openedAt: yield* Clock.currentTimeMillis,
              closing: false,
            }
            owner.channel = channel
            // 启动读循环：逐条消息投递到活跃队列
            channel.reader = yield* connection.messages.pipe(
              Stream.runForEach((message) =>
                Effect.gen(function* () {
                  const active = channel.active
                  // 无活跃交换时收到数据属于协议异常
                  if (!active)
                    return yield* transportError("WebSocket data arrived without an active exchange", {
                      url: exchange.connect.url,
                      operation: "read",
                      code: "idle-data",
                      phase: "receive",
                    })
                  // 收到数据说明 provider 已观察到本次投递
                  active.delivery = "provider-observed"
                  // 只支持文本帧
                  if (typeof message !== "string")
                    return yield* transportError("Unsupported binary WebSocket frame", {
                      url: exchange.connect.url,
                      operation: "read",
                      code: "message",
                      phase: "receive",
                    })
                  // 入队（可能因队列已关闭而失败）
                  Queue.offerUnsafe(active.queue, message)
                }),
              ),
              // 读循环失败：正在关闭则忽略，否则毒化通道（按阶段/投递归因）
              Effect.catch((error) =>
                channel.closing
                  ? Effect.void
                  : poison(
                      owner,
                      channel,
                      annotate(error, {
                        phase:
                          error.reason._tag === "Transport" && error.reason.phase === "close" ? "close" : "receive",
                        delivery:
                          channel.active?.delivery === "provider-observed" || channel.active?.delivery === "terminal"
                            ? "accepted"
                            : error.reason._tag === "Transport" && error.reason.code === "1009"
                              ? "rejected"
                              : "ambiguous",
                      }),
                    ),
              ),
              // 挂到层作用域（startImmediately 立即开始读）
              Effect.forkIn(scope, { startImmediately: true }),
            )
            yield* Effect.logDebug("session websocket connected", {
              sessionTransport: "websocket",
              phase: "connect",
            })
            yield* metric("connect")
            return channel
          }),
        )
      })

      // fallback：降级路径——直接用交换自带的 HTTP 兜底，complete 为空操作
      const fallback = (exchange: WebSocketChannelExchange): WebSocketChannelExecution => ({
        frames: exchange.fallback(),
        complete: Effect.void,
      })

      // start：启动一次 WebSocket 交换（轮换/复用连接、发送首帧、构造帧流）
      const start = Effect.fn("SessionModelTransport.start")(function* (
        owner: State,
        input: WebSocketChannelExchange,
        interceptor?: Interceptor,
        idleTimeout?: number | false,
      ) {
        // 服务已关闭则报错
        if (owner.closed)
          return yield* transportError("Session WebSocket owner is closed", {
            operation: "request",
            code: "owner-closed",
            phase: "queue",
            delivery: "not-sent",
          })
        // 已固定降级则直接走 HTTP 兜底
        if (owner.httpFallback) return fallback(input)
        // 有握手钩子则先让它选择连接（复制头避免被原交换共享）
        const selected = interceptor?.handshake
          ? yield* interceptor.handshake({ url: input.connect.url, headers: { ...input.connect.headers } })
          : undefined
        // 应用钩子改写后的连接参数
        const exchange: WebSocketChannelExchange = selected
          ? { ...input, connect: { ...input.connect, url: selected.url, headers: Headers.fromInput(selected.headers) } }
          : input
        // 计算本次交换的亲和键
        const key = affinity(exchange)
        const now = yield* Clock.currentTimeMillis
        const current = owner.channel
        // 轮换时限可由连接参数覆盖
        const rotateAfterMs = exchange.connect.rotateAfterMs ?? ROTATE_AFTER_MS
        // 判定轮换原因：亲和键变化 或 连接年龄超限
        const rotation = current
          ? current.affinity !== key
            ? "affinity"
            : now - current.openedAt >= rotateAfterMs
              ? "age"
              : undefined
          : undefined
        // 需要轮换：记录日志与指标并关闭旧通道
        if (current && rotation) {
          yield* Effect.logDebug("session websocket rotating", {
            sessionTransport: "websocket",
            phase: "connect",
            reason: rotation,
          })
          yield* metric("rotation", { reason: rotation })
          yield* metric("reconnect")
          yield* closeChannel(owner, current)
        }

        // 复用现有通道：记录日志与指标
        if (owner.channel)
          yield* Effect.logDebug("session websocket reused", {
            sessionTransport: "websocket",
            phase: "connect",
          })
        if (owner.channel) yield* metric("reuse")
        // 复用现有通道或打开新通道；打开失败时按"固定降级"处理
        const channel = owner.channel
          ? owner.channel
          : yield* open(owner, exchange, key).pipe(
              Effect.catch((error) => {
                // 会话已关闭的错误原样上抛（不应降级）
                if (error.reason._tag === "Transport" && error.reason.code === "owner-closed") return Effect.fail(error)
                // Any connect failure, transient or not, pins the Session to HTTP until restart or move:
                // a network that refuses the upgrade would otherwise charge every step for a failed connect.
                // 任何连接失败（无论是否瞬时）都把会话固定到 HTTP，直到重启或迁移：
                // 否则拒绝升级的网络会让每一步都为失败的连接付费
                owner.httpFallback = true
                return Effect.logWarning("session websocket connect failed; using http", {
                  sessionTransport: "websocket",
                  phase: "connect",
                  delivery: "not-sent",
                  code: error.reason._tag === "Transport" ? error.reason.code : error.reason._tag,
                }).pipe(
                  Effect.andThen(metric("connect_failure")),
                  Effect.andThen(metric("fallback")),
                  Effect.as(undefined),
                )
              }),
            )
        // 打开失败已降级：走 HTTP 兜底
        if (!channel) return fallback(exchange)

        // 上次交换留下了待提交检查点但未被确认：清空（不跨交换复用）
        if (channel.pending) {
          channel.pending = undefined
          channel.checkpoint = undefined
        }

        // 让驱动基于检查点创建首帧（full 或 resume 模式）；出错或被中断都关通道
        const create = yield* exchange.driver.create(channel.checkpoint).pipe(
          Effect.tapError(() => closeChannel(owner, channel)),
          Effect.onInterrupt(() => closeChannel(owner, channel)),
        )
        // 全量模式意味着没有可续传的检查点
        if (create.mode === "full") channel.checkpoint = undefined
        // 发送拦截器改写首帧；被中断同样关通道
        const message = interceptor?.send
          ? yield* interceptor.send(create.message).pipe(Effect.onInterrupt(() => closeChannel(owner, channel)))
          : create.message
        yield* Effect.logDebug("session websocket sending", {
          sessionTransport: "websocket",
          phase: "send",
          mode: create.mode,
        })
        // 创建活跃交换：无界帧队列 + 投递阶段标记为"已尝试发送"
        const active: Active = {
          queue: yield* Queue.unbounded<string, AIError>(),
          delivery: "send-attempted",
        }
        channel.active = active
        // 发送首帧；被中断时关通道，并用 result 收集失败而不中断流程
        const sent = yield* channel.connection.sendText(message).pipe(
          Effect.withSpan("SessionModelTransport.send"),
          Effect.onInterrupt(() => closeChannel(owner, channel)),
          Effect.result,
        )
        // 发送失败：补全错误信息（消息/原因/HTTP 上下文）
        if (sent._tag === "Failure") {
          const failure = new AIError({
            reason: AIErrorReason.make({
              ...sent.failure.reason,
              message: sent.failure.message,
              cause: sent.failure.reason.cause,
              http: sent.failure.reason.http ?? channel.connection.http,
            }),
          })
          // 帧确认未发出（not-sent）：请求确定未到达，安全降级到 HTTP
          const notSent = failure.reason._tag === "Transport" && failure.reason.delivery === "not-sent"
          yield* closeChannel(owner, channel)
          if (notSent) {
            yield* metric("fallback")
            return fallback(exchange)
          }
          // 帧可能已到达（ambiguous）：计入连续失败并把错误归因为"投递不明"
          yield* metric("ambiguous_delivery")
          yield* streamFailure(owner)
          return yield* annotate(failure, { phase: "send", delivery: "ambiguous" })
        }
        yield* metric("send")

        // 终态观察（在流处理中捕获）
        let terminal: ChannelObservation | undefined
        // 本次交换的令牌（对象身份），用于确认 pending 检查点归属
        const token = {}
        // frames：入站帧流——空闲超时、接收拦截、驱动观察、终态处理
        const frames = Stream.fromQueue(active.queue).pipe(
          // 空闲超时（可禁用或自定义时长）：按投递阶段归因
          Stream.timeoutOrElse({
            duration: idleTimeout === false ? Duration.infinity : (idleTimeout ?? IDLE_TIMEOUT),
            orElse: () =>
              Stream.fail(
                transportError("Timed out waiting for WebSocket data", {
                  url: exchange.connect.url,
                  operation: "read",
                  code: "idle-timeout",
                  phase: "receive",
                  delivery: active.delivery === "provider-observed" ? "accepted" : "ambiguous",
                }),
              ),
          }),
          // 接收拦截器改写入站帧
          Stream.mapEffect((frame) => (interceptor?.receive ? interceptor.receive(frame) : Effect.succeed(frame))),
          // 驱动把原始帧解析为观察（帧/完成/不完整/错误）
          Stream.mapEffect((frame) => exchange.driver.observe(create, frame)),
          // 终态处理：记录终态、投递阶段置为 terminal，管理检查点
          Stream.tap((observation) =>
            Effect.sync(() => {
              if (!observationTerminal(observation)) return
              terminal = observation
              active.delivery = "terminal"
              // 完成态携带新检查点：暂存为 pending（带令牌）
              const staged = observation.type === "completed" ? observation.checkpoint : undefined
              if (staged) channel.pending = { token, checkpoint: staged }
              // 非完成或没有新检查点：丢弃旧检查点
              if (observation.type !== "completed" || !staged) channel.checkpoint = undefined
            }),
          ),
          // 取到第一个终态为止
          Stream.takeUntil(observationTerminal),
          // 把观察转成帧（错误观察此时才失败）
          Stream.mapEffect(observationFrame),
          // 清理（无论成功失败都执行）：判断交换是否正常完结
          Stream.ensuring(
            Effect.gen(function* () {
              // 活跃交换仍是本交换时才解除登记
              if (channel.active === active) channel.active = undefined
              // 终态后队列里是否还有未消费的帧
              const pending = yield* Queue.size(active.queue)
              yield* Queue.shutdown(active.queue)
              // 正常完结：到达终态且无残留帧——重置失败计数并记录指标
              if (terminal && pending === 0) {
                owner.streamFailures = 0
                yield* metric("terminal", { type: terminal.type })
                if (terminal.type === "rejected") yield* metric("rejection", { recovery: terminal.recovery })
                // The Codex backend stops serving a connection after any error frame: the next request is
                // never answered and the socket dies with 1006. api.openai.com keeps it open, so reconnecting
                // costs one handshake there. Drop the socket after every error so retries never race that.
                // 出错后立即丢弃连接：有的后端（如 Codex）错误帧后不再服务该连接，
                // 重试若复用旧连接会一直无响应；主动重连可避免竞态
                if (terminal.type !== "completed" && terminal.type !== "incomplete") yield* closeChannel(owner, channel)
                return
              }
              // 非正常完结：被取消（未达终态）或终态后仍有残留帧——清空检查点并毒化通道
              yield* metric("cancellation")
              channel.checkpoint = undefined
              channel.pending = undefined
              // 终态后还有数据到达：数据错乱
              const error = terminal
                ? transportError("WebSocket data arrived after the terminal event", {
                    url: exchange.connect.url,
                    operation: "read",
                    code: "idle-data",
                    phase: "receive",
                    delivery: "accepted",
                  })
                // 流被取消、未达终态：按投递阶段归因
                : transportError("Session WebSocket exchange did not reach a terminal event", {
                    url: exchange.connect.url,
                    operation: "read",
                    code: "incomplete",
                    phase: "receive",
                    delivery: active.delivery === "provider-observed" ? "accepted" : "ambiguous",
                  })
              yield* poison(owner, channel, error)
            }),
          ),
          // 1009（消息过大）且被拒绝：固定降级到 HTTP，并用交换自带的 HTTP 兜底继续
          Stream.catch((error) => {
            if (
              error.reason._tag !== "Transport" ||
              error.reason.code !== "1009" ||
              error.reason.delivery !== "rejected"
            )
              return Stream.fail(error)
            owner.httpFallback = true
            return Stream.unwrap(
              Effect.logWarning("session websocket request too large; using http", {
                sessionTransport: "websocket",
                phase: "close",
                delivery: "rejected",
                code: error.reason.code,
              }).pipe(
                Effect.andThen(metric("fallback", { reason: "message_too_large" })),
                Effect.as(exchange.fallback()),
              ),
            )
          }),
        )
        // complete：交换正常收尾时提交 pending 检查点（令牌不匹配则忽略）
        const complete = Effect.sync(() => {
          if (owner.channel !== channel || channel.pending?.token !== token) return
          channel.checkpoint = channel.pending.checkpoint
          channel.pending = undefined
        })
        // 返回执行结果：帧流、收尾动作与底层 HTTP 上下文
        return { frames, complete, http: channel.connection.http }
      })

      // bind：为某会话生成通道执行器；同一会话的交换用信号量串行启动
      const bind = (
        sessionID: SessionSchema.ID,
        interceptor?: Interceptor,
        idleTimeout?: number | false,
      ): WebSocketChannelExecutor => ({
        execute: (exchange) => {
          const owner = state(sessionID)
          let execution: WebSocketChannelExecution | undefined
          return Effect.succeed({
            get http() {
              return execution?.http
            },
            frames: Stream.unwrap(
              // 先拿信号量（可被中断），启动交换后取出其帧流
              Effect.acquireRelease(owner.lock.take(1), () => owner.lock.release(1), { interruptible: true }).pipe(
                Effect.andThen(start(owner, exchange, interceptor, idleTimeout)),
                Effect.tap((started) =>
                  Effect.sync(() => {
                    execution = started
                  }),
                ),
                Effect.map((started) => started.frames),
              ),
            ),
            // complete：交换启动后才有效，否则为空操作
            complete: Effect.suspend(() => execution?.complete ?? Effect.void),
          })
        },
      })

      // close：关闭某会话的连接并删除其状态
      const close = Effect.fn("SessionModelTransport.close")(function* (sessionID: SessionSchema.ID) {
        const owner = states.get(sessionID)
        if (!owner) return
        states.delete(sessionID)
        owner.closed = true
        if (owner.channel) yield* closeChannel(owner, owner.channel)
      })
      // closeAll：关闭所有会话的连接（层终结器使用）
      const closeAll = Effect.suspend(() => {
        const owners = Array.from(states.values())
        states.clear()
        return Effect.forEach(
          owners,
          (owner) => {
            owner.closed = true
            return owner.channel ? closeChannel(owner, owner.channel) : Effect.void
          },
          { discard: true },
        )
      })

      // 层关闭时关闭全部连接
      yield* Effect.addFinalizer(() => closeAll)
      return Service.of({ bind, close, closeAll })
    }),
  )

// layer：用平台 WebSocket 构造器构建默认服务层
export const layer = Layer.unwrap(
  Effect.map(Socket.WebSocketConstructor, (constructor) =>
    makeLayer({
      open: (input) =>
        WebSocketTransport.open(input).pipe(Effect.provideService(Socket.WebSocketConstructor, constructor)),
    }),
  ),
)

// 注册为全局单例节点，依赖平台的 WebSocket 构造器节点
export const node = makeGlobalNode({ service: Service, layer, deps: [webSocketConstructor] })
