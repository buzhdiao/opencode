// 将本模块以命名空间 `PtyProtocol` 全量导出
export * as PtyProtocol from "./protocol.js"

// Wire protocol for PTY websocket transports. The PTY domain service is transport-free; server
// routes adapt Pty.attach to websockets with these helpers so every surface speaks one protocol.
//
// Outbound frames are raw UTF-8 terminal chunks. One control frame — a 0x00 byte followed by
// UTF-8 JSON — carries the absolute output cursor after replay so clients can resume later.
//
// PTY websocket 传输的线上协议：PTY 领域服务本身与传输无关；服务端路由借助这些辅助函数把
// Pty.attach 适配到 websocket，让所有客户端使用同一协议。出站帧为原始 UTF-8 终端数据；
// 控制帧以 0x00 字节开头，后接 UTF-8 JSON，携带重放后的绝对输出游标以便客户端续传

// 文本编码器：字符串 -> UTF-8 字节
const encoder = new TextEncoder()
// 严格解码器：非法 UTF-8 直接抛错（fatal: true）
const decoder = new TextDecoder("utf-8", { fatal: true })

// Replay can be megabytes; send it in bounded frames.
// 重放数据可达数兆字节，因此按有界帧分块发送
export const REPLAY_CHUNK = 64 * 1024

// 构造控制帧：0x00 字节 + {"cursor":n} 的 UTF-8 JSON
export function metaFrame(cursor: number) {
  // 编码游标 JSON
  const bytes = encoder.encode(JSON.stringify({ cursor }))
  // 分配 1 字节标记 + JSON 负载的缓冲
  const out = new Uint8Array(bytes.length + 1)
  // 首字节 0x00 标记这是控制帧
  out[0] = 0
  // 从第 1 字节起写入 JSON
  out.set(bytes, 1)
  // 返回完整帧
  return out
}

// 把重放数据切分为固定大小的帧
export function chunks(data: string) {
  // 输出帧列表
  const out: string[] = []
  // 按 REPLAY_CHUNK 步长切片
  for (let i = 0; i < data.length; i += REPLAY_CHUNK) out.push(data.slice(i, i + REPLAY_CHUNK))
  // 返回全部帧
  return out
}

// Inbound client frames are UTF-8 text or binary; invalid UTF-8 input is dropped.
// 解码客户端入站帧：UTF-8 文本或二进制；非法 UTF-8 输入被丢弃（返回 undefined）
export function decodeInput(message: string | Uint8Array | ArrayBuffer) {
  // 文本帧直接返回
  if (typeof message === "string") return message
  try {
    // 二进制帧解码（ArrayBuffer 需先包成视图）
    return decoder.decode(message instanceof ArrayBuffer ? new Uint8Array(message) : message)
  } catch {
    // 非法 UTF-8：丢弃
    return undefined
  }
}
