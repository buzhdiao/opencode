// 可释放资源的通用接口（如事件监听器的取消句柄）
export type Disp = {
  // 释放资源
  dispose(): void
}

// PTY 进程退出事件
export type Exit = {
  // 退出码
  exitCode: number
  // 终止信号（数字或名称，可选）
  signal?: number | string
}

// 启动 PTY 的选项
export type Opts = {
  // 终端名称（TERM 类型）
  name: string
  // 列数（可选）
  cols?: number
  // 行数（可选）
  rows?: number
  // 工作目录（可选）
  cwd?: string
  // 环境变量（可选）
  env?: Record<string, string>
}

// 伪终端进程的统一接口：各运行时实现（bun/node/workerd）共同遵守
export type Proc = {
  // 进程 ID
  pid: number
  // 订阅输出数据，返回可释放的监听句柄
  onData(listener: (data: string) => void): Disp
  // 订阅退出事件，返回可释放的监听句柄
  onExit(listener: (event: Exit) => void): Disp
  // 向终端写入数据
  write(data: string): void
  // 调整终端尺寸
  resize(cols: number, rows: number): void
  // 终止进程（可选信号）
  kill(signal?: string): void
}
