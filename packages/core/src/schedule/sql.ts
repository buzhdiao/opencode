// 导入 drizzle-orm 的 sql 模板标签，用于编写部分索引条件
import { sql } from "drizzle-orm"
// 导入 SQLite 表定义相关构造器：索引、整型列、表、文本列
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
// 导入 effect 的 Schema 类型（仅类型引用）
import type { Schema } from "effect"
// 导入 Schedule 的 schema 类型
import type { Schedule } from "@opencode/schema/schedule"
// 导入通用的数据库时间戳列集合
import { Timestamps } from "../database/schema.sql.js"
// 导入会话消息 ID 类型
import type { SessionMessage } from "../session/message.js"
// 导入会话 schema 类型
import type { SessionSchema } from "../session/schema.js"
// 导入会话表定义（外键引用）
import { SessionTable } from "../session/sql.js"

// 定义 schedule（计划任务）表
export const ScheduleTable = sqliteTable(
  // 表名
  "schedule",
  {
    // 主键：计划 ID
    id: text().$type<Schedule.ID>().primaryKey(),
    /** The Session a prompt action wakes. */
    // 关联的会话 ID：计划触发的 prompt 动作将唤醒该会话；删除会话时级联删除
    session_id: text()
      .$type<SessionSchema.ID>()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    // 计划名称
    name: text(),
    // 触发动作（JSON 存储）：唤醒时要执行的内容
    action: text({ mode: "json" }).$type<Schedule.Action>().notNull(),
    // 检查条件（JSON 存储，可为空）
    check: text({ mode: "json" }).$type<Schedule.StoredCheck>(),
    // 触发时机定义（JSON 存储，必填）
    when: text({ mode: "json" }).$type<Schedule.When>().notNull(),
    // 时区（必填）
    tz: text().notNull(),
    // 计划状态：默认 active
    status: text().$type<Schedule.Status>().notNull().default("active"),
    // 下次到期时间（Unix 时间戳，秒/毫秒按约定）
    next_due_at: integer(),
    // 结束时间：超过后计划不再触发
    ends_at: integer(),
    // 剩余运行次数（有限次计划）
    remaining_runs: integer(),
    // 已运行次数计数器
    run_count: integer().notNull().default(0),
    // 已执行检查次数计数器
    checks: integer().notNull().default(0),
    // 失败次数计数器
    failures: integer().notNull().default(0),
    // 上次触发时间
    last_fired_at: integer(),
    // 上次触发生成的消息 ID
    last_message_id: text().$type<SessionMessage.ID>(),
    // 上次检查结果
    last_outcome: text().$type<Schedule.Outcome>(),
    /** The loop leaves a due row alone until then, e.g. while its location has schedules turned off. */
    // 重试时间：在此之前循环调度器跳过该到期行（例如其 Location 暂时关闭了计划功能）
    retry_at: integer(),
    /** Condition state persisted across checks (e.g. previous stdout for shell `changes`). */
    // 跨检查持久化的条件状态（如 shell changes 谓词的上一次 stdout），JSON 存储
    state: text({ mode: "json" }).$type<Schema.Json>(),
    // 展开通用时间戳列（created_at 等）
    ...Timestamps,
  },
  // 定义表的索引
  (table) => [
    // 按会话 ID 的索引：加速查某会话的所有计划
    index("schedule_session_idx").on(table.session_id),
    // 部分索引：仅覆盖 active 且已设置 next_due_at 的行，加速到期扫描
    index("schedule_due_idx")
      .on(table.next_due_at)
      .where(sql`${table.status} = 'active' and ${table.next_due_at} is not null`),
  ],
)
