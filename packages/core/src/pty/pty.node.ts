// 引入 CommonJS require 构造器：运行时加载 node-pty 原生模块
import { createRequire } from "node:module"
// 引入 SEA（单文件可执行）检测：SEA 打包下 node-pty 的 ConPTY 需特殊处理
import { isSea } from "node:sea"
// 引入 @lydell/node-pty 的 spawn 类型（仅类型）
import type { spawn } from "@lydell/node-pty"
// 引入 PTY 选项与进程类型（仅类型）
import type { Opts, Proc } from "./pty.js"

// 重导出 PTY 相关类型
export type { Disp, Exit, Opts, Proc } from "./pty.js"

// 加载 node-pty：优先使用环境变量指定的路径（SEA 打包场景），否则按包名解析
const pty = createRequire(import.meta.url)(process.env.OPENCODE_NODE_PTY_PATH ?? "@lydell/node-pty") as {
  // 要求其导出符合 spawn 签名
  spawn: typeof spawn
}

// 用 node-pty 启动伪终端进程并适配为统一的 Proc 接口
function spawnPty(file: string, args: string[], opts: Opts): Proc {
  // Windows + SEA 打包时强制启用 useConptyDll，其余场景按原样选项
  const proc = pty.spawn(file, args, process.platform === "win32" && isSea() ? { ...opts, useConptyDll: true } : opts)
  // 返回适配后的进程对象
  return {
    // 进程 ID
    pid: proc.pid,
    // 订阅输出数据流
    onData(listener) {
      return proc.onData(listener)
    },
    // 订阅退出事件
    onExit(listener) {
      return proc.onExit(listener)
    },
    // 向终端写入数据
    write(data) {
      proc.write(data)
    },
    // 调整终端尺寸
    resize(cols, rows) {
      proc.resize(cols, rows)
    },
    // 终止进程（可选信号）
    kill(signal) {
      proc.kill(signal)
    },
  }
}

// 以 spawn 名称导出，与 pty.ts 的接口约定一致
export { spawnPty as spawn }
