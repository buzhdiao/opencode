// 将本模块整体导出为 SessionErrors 命名空间
export * as SessionErrors from "./error.js"

// 导入 effect 的 Schema
import { Schema } from "effect"
// 导入 Agent ID 类型
import { Agent } from "@opencode/schema/agent"
// 导入 Skill ID 类型
import { Skill } from "@opencode/schema/skill"
// 导入会话消息模块
import { SessionMessage } from "./message.js"
// 导入会话 schema 类型
import { SessionSchema } from "./schema.js"
// 导入通用会话错误结构
import { SessionError } from "@opencode/schema/session-error"

// 会话不存在错误：携带会话 ID
export class NotFoundError extends Schema.TaggedError<NotFoundError>()("Session.NotFoundError", {
  sessionID: SessionSchema.ID,
}) {}

// 列表游标非法错误：无附加字段，提供固定错误消息
export class InvalidListCursorError extends Schema.TaggedError<InvalidListCursorError>()(
  "Session.InvalidListCursorError",
  {},
) {
  // 覆写默认消息
  override get message() {
    return "Invalid cursor"
  }
}

// 消息不存在错误：携带会话 ID 与消息 ID
export class MessageNotFoundError extends Schema.TaggedError<MessageNotFoundError>()("Session.MessageNotFoundError", {
  sessionID: SessionSchema.ID,
  messageID: SessionMessage.ID,
}) {}

// fork 空会话错误：会话没有任何消息时无法 fork
export class ForkEmptyError extends Schema.TaggedError<ForkEmptyError>()("Session.ForkEmptyError", {
  sessionID: SessionSchema.ID,
}) {
  // 覆写默认消息，指出是哪个会话
  override get message() {
    return `Cannot fork empty session: ${this.sessionID}`
  }
}

// 消息解码失败错误：存储的消息无法按 schema 解码
export class MessageDecodeError extends Schema.TaggedError<MessageDecodeError>()("Session.MessageDecodeError", {
  sessionID: SessionSchema.ID,
  messageID: SessionMessage.ID,
}) {
  // 覆写默认消息，包含会话与消息 ID
  override get message() {
    return `Failed to decode message ${this.messageID} in session ${this.sessionID}`
  }
}

// Agent 未找到错误：会话引用的 agent 不存在
export class AgentNotFoundError extends Schema.TaggedError<AgentNotFoundError>()("Session.AgentNotFoundError", {
  sessionID: SessionSchema.ID,
  agent: Agent.ID,
}) {
  // 覆写默认消息，指出缺失的 agent
  override get message() {
    return `Agent not found: "${this.agent}"`
  }
}

// 步骤失败错误：携带结构化的会话错误详情
export class StepFailedError extends Schema.TaggedError<StepFailedError>()("Session.StepFailedError", {
  error: SessionError.Error,
}) {
  // 覆写默认消息：直接使用内部错误的 message
  override get message() {
    return this.error.message
  }
}

// prompt 冲突错误：同一条消息的 prompt 状态冲突
export class PromptConflictError extends Schema.TaggedError<PromptConflictError>()("Session.PromptConflictError", {
  sessionID: SessionSchema.ID,
  messageID: SessionMessage.ID,
}) {}

// 合成消息冲突错误：synthetic 输入 ID 冲突
export class SyntheticConflictError extends Schema.TaggedError<SyntheticConflictError>()(
  "Session.SyntheticConflictError",
  {
    sessionID: SessionSchema.ID,
    inputID: SessionMessage.ID,
  },
) {}

// 附件错误：携带出错的 URI 与说明
export class AttachmentError extends Schema.TaggedError<AttachmentError>()("Session.AttachmentError", {
  uri: Schema.String,
  message: Schema.String,
}) {}

// 压缩（compaction）冲突错误：压缩输入 ID 冲突
export class CompactionConflictError extends Schema.TaggedError<CompactionConflictError>()(
  "Session.CompactionConflictError",
  {
    sessionID: SessionSchema.ID,
    inputID: SessionMessage.ID,
  },
) {}

// 会话忙错误：会话正在执行中拒绝新请求
export class BusyError extends Schema.TaggedError<BusyError>()("Session.BusyError", {
  sessionID: SessionSchema.ID,
}) {}

// 收件箱冲突错误：inbox 条目 ID 冲突
export class InboxConflictError extends Schema.TaggedError<InboxConflictError>()("Session.InboxConflictError", {
  sessionID: SessionSchema.ID,
  inboxID: SessionMessage.ID,
}) {}

// 技能未找到错误：引用的 skill 不存在
export class SkillNotFoundError extends Schema.TaggedError<SkillNotFoundError>()("Session.SkillNotFoundError", {
  skill: Skill.ID,
}) {}
