// 导入 drizzle-orm 的 SQLite 表定义工具：表、文本列、整数列、索引、唯一索引
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core"
// 导入 Event schema：事件的 ID 等领域类型
import { Event } from "@opencode/schema/event"

// EventSequenceTable：事件序列表——记录每个聚合（aggregate）已分配到的最大序号，用于发号
export const EventSequenceTable = sqliteTable("event_sequence", {
  // aggregate_id：聚合 ID，主键，非空
  aggregate_id: text().notNull().primaryKey(),
  // seq：该聚合当前已使用的最大事件序号
  seq: integer().notNull(),
  // owner_id：可选的持有者 ID（记录是哪个实例在推进该序列）
  owner_id: text(),
})

// EventTable：事件表——存储按聚合组织的有序事件流
export const EventTable = sqliteTable(
  // 表名
  "event",
  {
    // id：事件 ID（Event.ID 类型），主键
    id: text().$type<Event.ID>().primaryKey(),
    // aggregate_id：所属聚合 ID，非空，外键引用序列表；聚合删除时级联删除事件
    aggregate_id: text()
      .notNull()
      .references(() => EventSequenceTable.aggregate_id, { onDelete: "cascade" }),
    // seq：事件在聚合内的序号（单调递增，决定顺序）
    seq: integer().notNull(),
    // created：创建时间戳，默认 0
    created: integer().notNull().default(0),
    // type：事件类型标识
    type: text().notNull(),
    // data：事件负载，以 JSON 模式存储为文本
    data: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
  },
  // 表级索引定义
  (table) => [
    // 唯一索引：(聚合 ID, 序号) 唯一，保证同一聚合内序号不重复
    uniqueIndex("event_aggregate_seq_idx").on(table.aggregate_id, table.seq),
    // 普通索引：按聚合 + 类型 + 序号查询（按类型拉取某聚合的事件流）
    index("event_aggregate_type_seq_idx").on(table.aggregate_id, table.type, table.seq),
  ],
)
