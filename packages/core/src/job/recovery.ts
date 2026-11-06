// 引入 Effect 的 Schema（schema 定义与校验）
import { Schema } from "effect"
// 引入会话 ID schema（用于关联恢复目标会话）
import { SessionSchema } from "../session/schema.js"

// 恢复信息（Recovery）的联合 schema：描述一个可恢复的后台作业由什么构成
export const RecoverySchema = Schema.Union([
  // shell 形态：后台 shell 进程类作业
  Schema.Struct({
    // 种类字面量 "shell"
    kind: Schema.Literal("shell"),
    // 归属会话 ID
    sessionID: SessionSchema.ID,
    // shell 进程 ID
    shellID: Schema.String,
    // 执行的命令
    command: Schema.String,
  }),
  // subagent 形态：子代理类作业
  Schema.Struct({
    // 种类字面量 "subagent"
    kind: Schema.Literal("subagent"),
    // 父会话 ID
    parentSessionID: SessionSchema.ID,
    // 子会话 ID
    childSessionID: SessionSchema.ID,
    // 所用 agent 名称
    agent: Schema.String,
    // 任务描述
    description: Schema.String,
  }),
  // image 形态：图片生成类作业
  Schema.Struct({
    // 种类字面量 "image"
    kind: Schema.Literal("image"),
    // 归属会话 ID
    sessionID: SessionSchema.ID,
    // 生成图片的路径
    path: Schema.String,
    // 所用模型
    model: Schema.String,
  }),
])

// 由 schema 推导出的 Recovery 类型（运行时与类型一一对应）
export type Recovery = typeof RecoverySchema.Type
