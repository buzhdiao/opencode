// 标记当前运行时（Node.js）下持久化 PTY 可用
export const available = true

// 解析 opencode-pty 二进制路径：环境变量显式指定时优先，否则回退到 PATH 中的 opencode-pty 命令
export async function resolveBinary() {
  return process.env.OPENCODE_PTY_BIN || "opencode-pty"
}
