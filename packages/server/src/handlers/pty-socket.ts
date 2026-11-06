// 引入位置生命周期（LocationLifecycle）服务：占用/释放位置引用
import { LocationLifecycle } from "@opencode/core/location-lifecycle"
// 引入 Effect 与 Queue（队列）
import { Effect, Queue } from "effect"
// 引入 Socket：WebSocket 套接字类型（含关闭事件）
import { Socket } from "effect/socket"

// 出站帧类型：文本、二进制数据或关闭事件
export type Outbound = string | Uint8Array | Socket.CloseEvent

// Outbound frames flow through one queue drained by a single writer so replay, live output, and the close
// frame keep their order. Either side closing ends the connection normally, and every exit detaches.
// runPtySocket：运行 WebSocket 的收发循环。所有出站帧经同一个队列、由单一写者消费，保证回放、实时输出与关闭帧的顺序。
// 任一侧关闭都正常结束连接；无论以何种方式退出都会执行 detach。
export function runPtySocket<R>(input: {
  // 已升级的 WebSocket 套接字
  readonly socket: Socket.Socket
  // 出站帧队列（读取端）
  readonly outbox: Queue.Dequeue<Outbound>
  // 可选：连接建立后执行的初始化（如附加到终端）
  readonly onOpen?: Effect.Effect<void, never, R>
  // 收到消息的回调（文本或二进制）
  readonly onMessage: (message: string | Uint8Array) => Effect.Effect<void, never, R>
  // 连接结束时的清理回调（如分离附件）
  readonly detach: () => void
}) {
  // 写者循环：持续从出站队列取帧写入套接字
  const drain = Effect.gen(function* () {
    // 获取套接字的写端
    const writer = yield* input.socket.writer
    while (true) {
      // 阻塞等待下一帧（队列空时挂起）
      const item = yield* Queue.take(input.outbox)
      // 把帧写入套接字
      yield* writer.write(item)
      // 关闭事件是最后一帧：写完即结束写者循环
      if (item instanceof Socket.CloseEvent) return
    }
  })
  // 读者循环：执行可选的 onOpen 初始化后，持续读取并分发入站消息
  const read = Effect.gen(function* () {
    // 获取套接字的读端
    const reader = yield* input.socket.reader
    // 连接建立后的初始化（如回放/附加），只执行一次
    if (input.onOpen) yield* input.onOpen
    // 循环：每次拉取一批消息并逐条调用 onMessage（discard 忽略结果）
    while (true) yield* Effect.forEach(yield* reader.pull, input.onMessage, { discard: true })
  })
  // raceFirst：任一循环结束即整体结束（先完成者获胜）；确保（ensuring）退出时执行 detach；
  // 套接字错误/正常关闭（SocketError/SocketCloseError）按正常结束处理；其余失败升级为缺陷（orDie）
  return Effect.raceFirst(drain, read).pipe(
    Effect.ensuring(Effect.sync(input.detach)),
    Effect.catchReason("SocketError", "SocketCloseError", () => Effect.void),
    Effect.orDie,
  )
}

// A socket borrows its Location for as long as it stays open. Its client reconnects right away when the socket
// closes, so it keeps the idle sweep from evicting the Location (eviction would only boot a fresh one). Any other
// shutdown (reload, VCS init, debug eviction) closes the socket with 1012, which releases the borrow so the
// Location's scope can close, and the client reconnects to the replacement.
// holdLocation：套接字打开期间“借用”（retain）其 Location，防止空闲清理把服务逐出。
// 其他关闭（重载、VCS 初始化、调试逐出）会以 1012 关闭套接字，从而释放借用，客户端随即重连到新实例。
export const holdLocation = Effect.fnUntraced(function* (outbox: Queue.Enqueue<Outbound>) {
  // 获取位置生命周期服务
  const lifecycle = yield* LocationLifecycle.Service
  // 增加引用计数：占用当前 Location
  yield* lifecycle.retain
  // 监听 Location 关闭：关闭时向客户端发送 1012（服务重启）关闭帧
  yield* lifecycle.awaitShutdown.pipe(
    Effect.andThen(Queue.offer(outbox, new Socket.CloseEvent(1012, "location shut down"))),
    // 作为子 fiber 运行，不阻塞当前流程
    Effect.forkChild,
  )
})
