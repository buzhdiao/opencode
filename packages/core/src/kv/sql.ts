// 引入 drizzle 的 SQLite 表构建器与文本列
import { sqliteTable, text } from "drizzle-orm/sqlite-core"
// 引入公共时间戳列（创建/更新时间）
import { Timestamps } from "../database/schema.sql.js"
// 仅引入类型：KV 值类型
import type { KV } from "../kv.js"

// kv 表定义：简单的键值（key-value）存储
export const KVTable = sqliteTable("kv", {
  // 键，作为主键保证唯一
  key: text().primaryKey(),
  // 值，以 JSON 模式存储任意 KV.Value（不允许为空）
  value: text({ mode: "json" }).$type<KV.Value>().notNull(),
  // 展开公共时间戳列（time_created / time_updated）
  ...Timestamps,
})
