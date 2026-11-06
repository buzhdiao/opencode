// 引入 PTY 进程类型（仅类型）
import type { Proc } from "./pty.js"

// 重导出 PTY 相关类型
export type { Disp, Exit, Opts, Proc } from "./pty.js"

// workerd cannot spawn processes; the Pty service surfaces this as a defect if
// a terminal is ever requested on this runtime.
// workerd 运行时无法启动子进程；若在该运行时上请求终端，Pty 服务会以此缺陷（defect）形式暴露
export function spawn(): Proc {
  // 一律抛错：该运行时不支持伪终端
  throw new Error("Pseudo-terminals are unavailable on the workerd runtime")
}
