// Shell 结果（result）模块：把 shell 会话的执行结果归一化为输出、通知与元数据
// 桶导出（barrel export）：将本模块聚合为命名空间 ShellResult，供外部统一引用
export * as ShellResult from "./result.js"

// Shell 协议的 Schema 类型（仅类型引入）
import type { Shell } from "@opencode/schema/shell"

// 会话结果：info 为进程信息，capture 为捕获（capture）的输出（可能尚未产生）
export type Result = {
  info: Shell.Info
  capture: { output: string; truncated: boolean } | undefined
}

// 归一化输出：output 为文本，truncated 表示是否截断（truncated），exit/signal/timeout 视情况附带
type Output = { output: string; truncated: boolean; exit?: number; signal?: string; timeout?: boolean }

// 会话输出已不可用时的占位文案（如会话数据已被清理）
const missing = "Shell command output is no longer available."
// 构造一个"输出不可用"的 Shell.Output；cursor/size 取占位文案的字节长度，保证游标语义一致
export const unavailable: Shell.Output = {
  output: missing,
  cursor: Buffer.byteLength(missing),
  size: Buffer.byteLength(missing),
  truncated: false,
}

// 把内部 Result 归一化为 Output；没有捕获内容时回退到"不可用"占位输出
export function output(result: Result): Output {
  return {
    // 优先取已捕获的输出文本
    output: result.capture?.output ?? unavailable.output,
    // 是否截断，默认 false
    truncated: result.capture?.truncated ?? false,
    // 仅在已知退出码（exit code）时附带 exit 字段（避免写入 undefined）
    ...(result.info.exit !== undefined ? { exit: result.info.exit } : {}),
    // 仅在已知信号（signal）时附带 signal 字段
    ...(result.info.signal !== undefined ? { signal: result.info.signal } : {}),
    // 状态为超时（timeout）时标记 timeout: true
    ...(result.info.status === "timeout" ? { timeout: true } : {}),
  }
}

// 依据退出信息生成一句人类可读的结束原因；正常退出（exit 为 0）返回 undefined
export function notice(output: Pick<Output, "exit" | "signal" | "timeout">) {
  // 超时优先提示
  if (output.timeout) return "Timed out before completion"
  // 被信号终止时注明信号名
  if (output.signal !== undefined) return `Killed by ${output.signal}`
  // 非零退出码给出具体值
  if (output.exit !== undefined && output.exit !== 0) return `Exited with code ${output.exit}`
}

// 提取 Output 中已定义的字段组成元数据（metadata），供消息附带
export function metadata(output: Output) {
  return {
    // 截断标记始终输出
    truncated: output.truncated,
    // exit/signal/timeout 只在存在时展开进对象
    ...(output.exit !== undefined ? { exit: output.exit } : {}),
    ...(output.signal !== undefined ? { signal: output.signal } : {}),
    ...(output.timeout !== undefined ? { timeout: output.timeout } : {}),
  }
}

// 构造一条 shell 事件通知：text 为可展示的 XML 片段，metadata 为结构化附加信息
export function notification(input: {
  shellID: string
  jobID?: string
  command: string
  state: "completed" | "cancelled" | "error"
  text: string
  output?: Output
}) {
  return {
    // 用 <shell> 标签包装正文：id 优先用后台作业 ID（jobID），否则回退会话 ID（shellID）
    text: `<shell id="${input.jobID ?? input.shellID}" state="${input.state}" command="${input.command}">\n${input.text}\n</shell>`,
    metadata: {
      // 标记消息来源为 shell
      source: "shell",
      // 始终携带 shell 会话 ID
      shellID: input.shellID,
      // 有后台作业 ID 时才附带
      ...(input.jobID !== undefined ? { jobID: input.jobID } : {}),
      // 会话最终状态
      state: input.state,
      // 有输出信息时并入其元数据（截断/退出码/信号/超时）
      ...(input.output ? metadata(input.output) : {}),
    },
  }
}

// 用户在终端手动执行 shell 命令后，构造给模型阅读的通知
export function userNotification(result: Result) {
  // 先归一化输出
  const captured = output(result)
  // 状态说明：被杀为"Cancelled"；exit 为 0 则无说明；否则取 notice 文案（无明确退出码时兜底）
  const status =
    result.info.status === "killed"
      ? "Cancelled"
      : captured.exit === 0
        ? undefined
        : (notice(captured) ?? "Exited with code unknown")
  // 组装通知：正文为输出与状态说明（空行分隔），状态按是否被杀映射
  const message = notification({
    shellID: result.info.id,
    command: result.info.command,
    state: result.info.status === "killed" ? "cancelled" : "completed",
    // 过滤掉 undefined 与空串后用双换行拼接
    text: [captured.output, status].filter((item) => item !== undefined && item !== "").join("\n\n"),
    output: captured,
  })
  // 文本前加一句说明：该命令由用户手动执行
  return { ...message, text: `The following shell command was executed by the user:\n${message.text}` }
}
