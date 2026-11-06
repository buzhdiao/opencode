// 将本模块以命名空间 `ProjectSchema` 全量导出
export * as ProjectSchema from "./schema.js"

// 引入 Effect 的 Schema 模块（用于派生类型）
import { Schema } from "effect"
// 引入项目领域 schema
import { Project } from "@opencode/schema/project"
// 引入绝对路径 schema
import { AbsolutePath } from "../schema.js"

// 导出项目 ID schema
export const ID = Project.ID
// 派生 ID 的 TypeScript 类型
export type ID = typeof ID.Type

// 导出"当前项目"标识 schema
export const Current = Project.Current
// 派生 Current 的类型
export type Current = typeof Current.Type

// 导出项目信息 schema
export const Info = Project.Info
// 派生 Info 的结构类型
export interface Info extends Schema.Schema.Type<typeof Info> {}

// 导出项目更新输入 schema
export const UpdateInput = Project.UpdateInput
// 派生 UpdateInput 的类型
export type UpdateInput = typeof UpdateInput.Type

// 导出项目事件 schema
export const Event = Project.Event

// 本地 VCS 状态 schema：版本控制类型与其元数据存储路径
export const Vcs = Schema.Struct({
  // VCS 类型（git/hg 等）
  type: Project.Vcs,
  // 元数据存储目录（绝对路径）
  store: AbsolutePath,
})
// 派生 Vcs 的类型
export type Vcs = typeof Vcs.Type
