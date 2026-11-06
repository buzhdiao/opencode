// 将本模块以命名空间 McpSocketClient 整体再导出（barrel 模式）
export * as McpSocketClient from "./socket-client.js"

// 引入 MCP SDK：消息反序列化、JSON-RPC 消息类型与传输（Transport）接口
import { deserializeMessage, type JSONRPCMessage, type Transport } from "@modelcontextprotocol/client"
// 引入 Effect 的 Result（结果包装，替代异常路径）
import { Result } from "effect"

/** The side of an incoming WebSocket the transport writes to. */
// Socket 接口：传输层对入站 WebSocket 可执行的最小操作集合
export interface Socket {
  // 发送一段文本帧
  readonly send: (text: string) => void
  // 关闭连接（可带关闭码与原因）
  readonly close: (code?: number, reason?: string) => void
}

// SocketTransport：在 Socket 之上实现的 MCP Transport，附加两个由宿主驱动的方法
export interface SocketTransport extends Transport {
  /** Feeds one inbound text frame. */
  // 喂入一帧入站文本（宿主在收到 WebSocket 消息时调用）
  readonly deliver: (text: string) => void
  /** Reports that the socket closed; fires `onclose` once. */
  // 报告套接字已关闭；内部保证 onclose 只触发一次
  readonly ended: () => void
}

/**
 * MCP client transport over a WebSocket that a client app opened to the server. The app runs the
 * MCP server and opencode runs the MCP client, so only the connection direction is inverted: the
 * transport is only ever made for an incoming socket and never dials out.
 *
 * Framing: one JSON-RPC 2.0 message per text frame, JSON-encoded, without batching. A frame that is
 * not valid JSON or not a JSON-RPC message is reported through `onerror` and the connection stays
 * open. Frames that arrive before `start()` are buffered and delivered on start.
 *
 * Closing: `close()` closes the socket with 1000 (normal). The transport learns that the socket
 * closed for any other reason through `ended()`; which close codes the endpoint uses is its own
 * concern. Either way `onclose` fires exactly once, and nothing is replayed after a disconnect: a
 * reconnecting client starts a fresh MCP session.
 */
// 工厂：为一条客户端打开的入站 WebSocket 构造 MCP 客户端传输
export function make(socket: Socket): SocketTransport {
  // 待投递帧队列：start() 之前到达的帧先缓存，start 时按序消费
  const pending: string[] = []
  // 传输状态机：ready（未启动）/ open（运行中）/ closed（已关闭）
  let phase: "ready" | "open" | "closed" = "ready"

  // 终结流程：进入 closed、清空缓存帧并触发 onclose（幂等，只执行一次）
  const finish = () => {
    // 已关闭则直接返回，保证 onclose 只触发一次
    if (phase === "closed") return
    // 进入 closed 状态
    phase = "closed"
    // 丢弃所有尚未投递的缓存帧（断线不重放）
    pending.length = 0
    // 通知上层连接已关闭
    transport.onclose?.()
  }

  // 解析并分发一帧文本：非法帧走 onerror，合法消息走 onmessage
  const receive = (text: string) => {
    // 尝试反序列化 JSON-RPC 消息，失败时包装为错误
    const parsed = Result.try({
      try: () => deserializeMessage(text),
      catch: (cause) => new Error("Invalid MCP socket frame", { cause }),
    })
    // 解析失败：报告错误，但连接保持打开
    if (Result.isFailure(parsed)) return transport.onerror?.(parsed.failure)
    // 解析成功：把消息交给上层处理
    transport.onmessage?.(parsed.success)
  }

  const transport: SocketTransport = {
    // start：把传输置为 open 并冲刷缓存帧
    start: () => {
      // 已关闭后再启动视为未连接
      if (phase === "closed") return Promise.reject(new Error("Not connected"))
      // 不允许重复启动
      if (phase === "open") return Promise.reject(new Error("Socket transport already started"))
      // 进入 open 状态
      phase = "open"
      // 按先进先出顺序投递 start 之前缓存的帧
      while (phase === "open" && pending.length > 0) receive(pending.shift()!)
      // 启动完成
      return Promise.resolve()
    },
    // send：在 open 状态下把消息 JSON 编码后经 socket 发出
    send: (message: JSONRPCMessage) =>
      // 非 open 状态一律视为未连接
      phase !== "open"
        ? Promise.reject(new Error("Not connected"))
        // open 状态：序列化并发送
        : Promise.try(() => {
            socket.send(JSON.stringify(message))
          }),
    // close：以 1000（正常关闭）关闭底层 socket 并终结传输
    close: () => {
      // 已关闭则幂等返回
      if (phase === "closed") return Promise.resolve()
      // 尝试以正常关闭码关闭 socket（结果被捕获，不抛异常）
      const closed = Result.try(() => socket.close(1000))
      // 无论关闭是否成功都执行终结（触发 onclose）
      finish()
      // 关闭失败则拒绝该 Promise，否则正常完成
      return Result.isFailure(closed) ? Promise.reject(closed.failure) : Promise.resolve()
    },
    // deliver：宿主喂入一帧入站文本
    deliver: (text) => {
      // 已关闭后忽略任何来帧
      if (phase === "closed") return
      // Keep FIFO order when a frame arrives re-entrantly while start() is still flushing.
      // 未启动或冲刷队列进行中（重入场景）时先入队，保证先进先出
      if (phase === "ready" || pending.length > 0) {
        pending.push(text)
        return
      }
      // 正常路径：直接解析并分发
      receive(text)
    },
    // ended：宿主报告 socket 因其他原因关闭；内部即终结流程
    ended: finish,
  }

  // 返回构造好的传输实例
  return transport
}
