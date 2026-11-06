// drizzle-orm 的 SQLite 表定义工具：整型/主键/表/文本列
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
// Worktree Schema 类型
import type { Worktree } from "@opencode/schema/worktree"
// 通用列定义：规范化后的绝对路径列
import { absoluteColumn } from "../database/path.js"
// 项目 Schema（ID 类型）
import { ProjectSchema } from "../project/schema.js"
// 项目表（外键引用）
import { ProjectTable } from "../project/sql.js"

// 工作树表：记录每个项目使用的工作树目录与创建策略
export const WorktreeTable = sqliteTable(
  // 表名：worktree
  "worktree",
  {
    // 所属项目 ID（非空，级联删除）
    project_id: text()
      .$type<ProjectSchema.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    // 工作树目录（规范化绝对路径，非空）
    directory: absoluteColumn().notNull(),
    // 创建该工作树使用的策略 ID
    strategy: text().$type<Worktree.StrategyID>(),
    // 创建时间（默认当前毫秒时间戳）
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  // 复合主键：项目 + 目录
  (table) => [primaryKey({ columns: [table.project_id, table.directory] })],
)
