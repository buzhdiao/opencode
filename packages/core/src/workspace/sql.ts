// Workspace Schema：工作区 ID 类型
import { Workspace } from "@opencode/schema/workspace"
// drizzle-orm 的 SQLite 表定义工具：整型/表/文本列
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
// 工作区驱动类型（binding 字段的类型）
import type { WorkspaceDriver } from "./driver.js"

// 工作区表：记录每个逻辑工作区的提供商与绑定
export const WorkspaceTable = sqliteTable("workspace", {
  // 主键：工作区 ID
  id: text().$type<Workspace.ID>().primaryKey(),
  // 提供商名称（非空）
  provider: text().notNull(),
  // 驱动绑定（JSON 文本列，可为 null）
  binding: text({ mode: "json" }).$type<WorkspaceDriver.Binding>(),
  // 创建时间戳（非空）
  created_at: integer().notNull(),
  // 最近使用时间戳（非空）
  last_used_at: integer().notNull(),
})
