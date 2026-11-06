// 将本模块整体导出为 SessionAffinity 命名空间
export * as SessionAffinity from "./affinity.js"

// 导入会话 schema 类型
import type { SessionSchema } from "./schema.js"

// TODO: Should the `model.request` hook expose affinity so plugins stop deriving it from `ctx.session.get`?
/** The Session ID that groups model requests for provider cache routing: children share the parent's, forks the fork source's. */
// 计算用于供应商缓存路由（provider cache routing）的亲和会话 ID：子会话沿用父会话，fork 会话沿用其 fork 来源会话
export const get = (session: Pick<SessionSchema.Info, "id" | "parentID" | "fork">) =>
  session.parentID ?? session.fork?.sessionID ?? session.id
