// 将本文件的所有导出聚合到命名空间 ConfigCommandV1 下，供统一引入
export * as ConfigCommandV1 from "./command.js"

// effect 库：Schema 数据校验
import { Schema } from "effect"

// 自定义命令（Command）配置 Schema
export const Info = Schema.Struct({
  // 命令模板（提示词模板）
  template: Schema.String,
  // 命令描述（可选）
  description: Schema.optional(Schema.String),
  // 指定使用的代理（可选）
  agent: Schema.optional(Schema.String),
  // 指定使用的模型（可选）
  model: Schema.optional(Schema.String),
  // 指定模型变体（可选）
  variant: Schema.optional(Schema.String),
  // 是否作为子任务执行（可选）
  subtask: Schema.optional(Schema.Boolean),
})
// Info 的 TypeScript 类型
export type Info = Schema.Schema.Type<typeof Info>
