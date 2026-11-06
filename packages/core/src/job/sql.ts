// 引入 drizzle 的 SQLite 表构建器：索引、表、文本列
import { index, sqliteTable, text } from "drizzle-orm/sqlite-core"
// 引入公共时间戳列（创建/更新时间）
import { Timestamps } from "../database/schema.sql.js"
// 仅引入类型：作业的状态等类型
import type { Job } from "../job.js"
// 仅引入类型：会话消息 ID
import type { SessionMessage } from "../session/message.js"
// 仅引入类型：会话 ID
import type { SessionSchema } from "../session/schema.js"

// job 表定义：持久化后台作业（主键为触发它的通知 ID）
export const JobTable = sqliteTable(
  // 表名
  "job",
  {
    // 触发该作业的通知消息 ID，作为主键保证幂等（同一通知只产生一行）
    notification_id: text().$type<SessionMessage.ID>().primaryKey(),
    // 作业自身 ID（非主键，同一作业可能多行）
    id: text().notNull(),
    // 归属会话 ID
    session_id: text().$type<SessionSchema.ID>().notNull(),
    // 子会话 ID（subagent 类作业才有）
    child_session_id: text().$type<SessionSchema.ID>(),
    // 作业种类（shell/subagent/image）
    kind: text().notNull(),
    // 可选标题
    title: text(),
    // 作业状态（Job.Status）
    status: text().$type<Job.Status>().notNull(),
    // 可选输出
    output: text(),
    // 可选错误
    error: text(),
    // 恢复信息，以 JSON 模式存储（列类型为 Job.Recovery）
    recovery: text({ mode: "json" }).$type<Job.Recovery>().notNull(),
    // 展开公共时间戳列（time_created / time_updated）
    ...Timestamps,
  },
  (table) => [
    // 按会话 ID 建索引，加速按会话查作业
    index("job_session_idx").on(table.session_id),
    // 按子会话 ID 建索引
    index("job_child_session_idx").on(table.child_session_id),
    // 按作业 ID 建索引
    index("job_id_idx").on(table.id),
  ],
)
