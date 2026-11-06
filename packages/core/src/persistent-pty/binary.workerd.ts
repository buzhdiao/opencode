// 标记当前运行时（workerd / Cloudflare Workers）不支持持久化 PTY
export const available = false

// 在该运行时下无法解析 PTY 二进制，调用即抛错
export async function resolveBinary(): Promise<string> {
  throw new Error("Persistent PTYs are unavailable in this runtime")
}
