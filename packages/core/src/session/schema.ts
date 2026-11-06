// 转发导出 @opencode/schema/session 作为本模块的命名空间
export * as SessionSchema from "@opencode/schema/session"

// 会话模式定义
import { Session } from "@opencode/schema/session"

// 会话 ID 的值与类型别名
export const ID = Session.ID
export type ID = typeof ID.Type

// 会话信息（Info）的值与类型别名
export const Info = Session.Info
export type Info = Session.Info
