// 将本模块以命名空间 `SubagentCompletion` 全量导出
export * as SubagentCompletion from "./subagent-completion.js"

// 引入 Effect 原语
import { Effect } from "effect"
// 引入后台任务（Job）类型（仅类型）
import type { Job } from "../job.js"
// 引入会话（Session）类型（仅类型）
import type { Session } from "../session.js"
// 引入会话消息类型（仅类型）
import type { SessionMessage } from "./message.js"

// 子代理没有文本回复时的兜底文案
export const NO_TEXT = "Subagent completed without a text response."

// 从子代理的最后一条消息中提取文本回复
export function text(message: SessionMessage.Info | undefined) {
  // 消息缺失或不是助手消息：视为无回复
  if (message?.type !== "assistant") return NO_TEXT
  // 拼接所有非空文本段作为回复；结果为空则回退到兜底文案
  return (
    message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .filter((text) => text.length > 0)
      .join("\n\n") || NO_TEXT
  )
}

// 将子代理任务的终态以合成（synthetic）消息投递给父会话
export const deliver = Effect.fnUntraced(function* (
  sessions: Pick<Session.Interface, "synthetic">,
  jobs: Pick<Job.Interface, "completeBackground">,
  input: Pick<Job.Info, "status" | "output" | "error" | "notificationID"> & {
    recovery: Extract<Job.Recovery, { kind: "subagent" }>
    resume?: boolean
  },
) {
  // 任务仍在运行：无需投递
  if (input.status === "running") return
  // 取出恢复信息（recovery，含父/子会话、代理与描述）
  const recovery = input.recovery
  // 依据终态选择投递文本：完成取输出、出错取错误信息、取消给固定文案
  const text =
    input.status === "completed"
      ? (input.output ?? NO_TEXT)
      : input.status === "error"
        ? (input.error ?? "Subagent failed")
        : "Subagent cancelled"
  // 向父会话发布合成消息：文本包裹在 <subagent> 标签中并附带来源元数据
  yield* sessions.synthetic({
    ...(input.notificationID ? { id: input.notificationID } : {}),
    sessionID: recovery.parentSessionID,
    ...(input.resume === false ? { resume: false } : {}),
    description: recovery.description,
    text: `<subagent sessionID="${recovery.childSessionID}" state="${input.status}" description="${recovery.description}">\n${text}\n</subagent>`,
    metadata: { source: "subagent", childID: recovery.childSessionID, agent: recovery.agent, state: input.status },
  })
  // 消息带通知 ID 时，标记对应的后台任务已完成
  if (input.notificationID) yield* jobs.completeBackground(input.notificationID)
})
