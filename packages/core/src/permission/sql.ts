// 引入 drizzle 的 SQLite 表定义工具：sqliteTable（建表）、text（文本列）、uniqueIndex（唯一索引）
import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
// 引入项目 ID 类型（仅类型引用）
import type { Project } from "@opencode/schema/project"
// 引入通用的 created/updated 时间戳列集合
import { Timestamps } from "../database/schema.sql.js"
// 引入项目表定义（用于外键引用）
import { ProjectTable } from "../project/sql.js"
// 引入"已保存权限"的 schema 类型（仅类型引用）
import type { PermissionSaved } from "@opencode/schema/permission-saved"

// 定义权限表（表名 "permission"）：存储各项目已保存的权限规则
export const PermissionTable = sqliteTable(
  // 表名
  "permission",
  {
    // 主键：已保存权限 ID
    id: text().$type<PermissionSaved.ID>().primaryKey(),
    // 所属项目 ID：非空，外键关联项目表，项目删除时级联删除
    project_id: text()
      .$type<Project.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    // 权限动作（如 bash、edit），非空
    action: text().notNull(),
    // 权限资源（如命令模式、文件路径），非空
    resource: text().notNull(),
    // 展开通用的 created/updated 时间戳列
    ...Timestamps,
  },
  // 唯一索引：同一项目内 (project_id, action, resource) 组合不允许重复
  (table) => [uniqueIndex("permission_project_action_resource_idx").on(table.project_id, table.action, table.resource)],
)
