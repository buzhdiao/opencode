// 引入数据库客户端类型（仅类型）
import type { EffectDrizzleSqlite } from "../database/drizzle.js"
// 引入 drizzle-orm 条件构造器：非空、为空、不等于、或
import { isNotNull, isNull, ne, or } from "drizzle-orm"
// 引入 SQLite 表定义原语：表、文本列、整数列、复合主键
import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core"
// 引入绝对路径列构造器（规范化存储路径）
import { absoluteArrayColumn, absoluteColumn } from "../database/path.js"
// 引入通用时间戳列组
import { Timestamps } from "../database/schema.sql.js"
// 引入绝对路径类型（仅类型）
import type { AbsolutePath } from "../schema.js"
// 引入项目 schema
import { ProjectSchema } from "./schema.js"

// 数据库客户端类型别名
type DatabaseClient = EffectDrizzleSqlite.EffectSQLiteDatabase
// 事务客户端类型：从 transaction 回调参数推导
type Transaction = Parameters<Parameters<DatabaseClient["transaction"]>[0]>[0]

// 项目表：主存储表，每行一个项目
export const ProjectTable = sqliteTable("project", {
  // 项目 ID（主键）
  id: text().$type<ProjectSchema.ID>().primaryKey(),
  // 规范化的工作树路径
  worktree: absoluteColumn().notNull(),
  // 版本控制类型（git/hg 等）
  vcs: text().$type<ProjectSchema.Vcs["type"]>(),
  // 项目显示名称
  name: text(),
  // 发现的图标 URL
  icon_url: text(),
  // 用户覆盖的图标 URL
  icon_url_override: text(),
  // 图标兜底颜色
  icon_color: text(),
  // 展开 createdAt/updatedAt 等通用时间戳列
  ...Timestamps,
  // 初始化完成时间
  time_initialized: integer(),
  // 最近活跃时间（非空，默认插入时刻）
  time_active: integer()
    .notNull()
    .default(0)
    .$defaultFn(() => Date.now()),
  // 归档时间
  time_archived: integer(),
  // 沙箱目录列表（非空）
  sandboxes: absoluteArrayColumn().notNull(),
  // 自定义命令（JSON 文本列，如 start 命令）
  commands: text({ mode: "json" }).$type<{ start?: string }>(),
})

/** @deprecated Use WorktreeTable from worktree/sql instead. */
// 项目目录表（已弃用，改用 worktree/sql 的 WorktreeTable）：记录项目与目录的关联
export const ProjectDirectoryTable = sqliteTable(
  "project_directory",
  {
    // 所属项目 ID（非空，级联删除）
    project_id: text()
      .$type<ProjectSchema.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    // 关联目录（绝对路径）
    directory: absoluteColumn().notNull(),
    // 目录角色：main/root/git_worktree
    type: text().$type<"main" | "root" | "git_worktree">(),
    // 发现策略说明
    strategy: text(),
    // 创建时间（非空，默认插入时刻）
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  // 复合主键：(project_id, directory)
  (table) => [primaryKey({ columns: [table.project_id, table.directory] })],
)

// 插入或更新项目：仅同步 vcs 字段，避免覆盖其他列
export function upsertProject(
  // 数据库客户端或事务
  db: DatabaseClient | Transaction,
  // 项目信息：ID、规范工作树与可选 VCS 状态
  project: { readonly id: ProjectSchema.ID; readonly canonical: AbsolutePath; readonly vcs?: ProjectSchema.Vcs },
) {
  // 提取 VCS 类型
  const vcs = project.vcs?.type
  // 执行 upsert
  return db
    // 先尝试插入
    .insert(ProjectTable)
    // 插入值：ID、工作树、VCS 类型与空沙箱列表
    .values({ id: project.id, worktree: project.canonical, vcs, sandboxes: [] })
    // ID 冲突时更新
    .onConflictDoUpdate({
      // 冲突目标为 ID 列
      target: ProjectTable.id,
      // 仅更新 vcs 字段（无 VCS 时置 null）
      set: { vcs: vcs ?? null },
      // 更新条件：vcs 有值时只在"当前为空或不相同"时写；无值时只在"当前非空"时清除
      setWhere: vcs ? or(isNull(ProjectTable.vcs), ne(ProjectTable.vcs, vcs)) : isNotNull(ProjectTable.vcs),
    })
    // 立即执行
    .run()
}
