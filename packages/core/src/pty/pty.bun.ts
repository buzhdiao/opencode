// 引入 Bun 的 FFI 动态库加载器（Windows 控制台设置用）
import { dlopen } from "bun:ffi"
// 引入 bun-pty 的 spawn 函数
import { spawn } from "bun-pty"
// 引入 PTY 选项与进程类型（仅类型）
import type { Opts, Proc } from "./pty.js"

// 重导出 PTY 相关类型
export type { Disp, Exit, Opts, Proc } from "./pty.js"

// Windows 平台：分离式服务端会忽略 Ctrl+C，ConPTY 子 shell 会继承该设置
if (process.platform === "win32") {
  // 加载 kernel32.dll 的两个控制台 API
  const library = dlopen("kernel32.dll", {
    // 设置控制台 Ctrl 处理器
    SetConsoleCtrlHandler: { args: ["ptr", "i32"], returns: "i32" },
    // 读取最近一次 Windows 错误码
    GetLastError: { args: [], returns: "u32" },
  })
  try {
    // Detached servers start with Ctrl+C ignored, and ConPTY shells inherit it.
    // Clear that attribute once before spawning shells; keep registered handlers.
    // 分离式服务端启动时忽略 Ctrl+C，且 ConPTY shell 会继承；在拉起 shell 前一次性清除该属性，
    // 同时保留已注册的处理器（第二参数 0 表示移除 IGNORE 属性而非移除处理器）
    if (library.symbols.SetConsoleCtrlHandler(null, 0) === 0)
      throw new Error(`Failed to enable PTY Ctrl+C handling: Windows error ${library.symbols.GetLastError()}`)
  } finally {
    // 无论成败都卸载动态库
    library.close()
  }
}

// 用 bun-pty 启动伪终端进程并适配为统一的 Proc 接口
function spawnPty(file: string, args: string[], opts: Opts): Proc {
  // 启动 PTY
  const pty = spawn(file, args, opts)
  // 返回适配后的进程对象
  return {
    // 进程 ID
    pid: pty.pid,
    // 订阅输出数据流
    onData(listener) {
      return pty.onData(listener)
    },
    // 订阅退出事件
    onExit(listener) {
      return pty.onExit(listener)
    },
    // 向终端写入数据
    write(data) {
      pty.write(data)
    },
    // 调整终端尺寸
    resize(cols, rows) {
      pty.resize(cols, rows)
    },
    // 终止进程（可选信号）
    kill(signal) {
      pty.kill(signal)
    },
  }
}

// 以 spawn 名称导出，与 pty.ts 的接口约定一致
export { spawnPty as spawn }
