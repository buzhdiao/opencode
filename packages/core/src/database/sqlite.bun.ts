// 导入 Bun 平台的 Effect SQLite 客户端实现
import { SqliteClient } from "@effect/sql-sqlite-bun"
// 导入 Layer：effect 中管理服务生命周期（依赖注入）的构造器
import { Layer } from "effect"
// 仅导入类型 SqlClient：通用 SQL 客户端接口
import type { SqlClient } from "effect/sql"

// supportsTuningPragmas：当前运行时支持通过 PRAGMA 调优（如 journal_mode 等设置）
export const supportsTuningPragmas = true

// Foreign keys default OFF and can be toggled per connection.
// supportsForeignKeyToggle：Bun 的 SQLite 默认关闭外键（foreign keys），
// 且支持按连接切换外键开关
export const supportsForeignKeyToggle = true

// Opening the database can only fail on a broken file or a lock held past
// busyTimeout; Database.layer treats both as fatal.
// sqliteLayer：构造 SQLite 客户端服务层（Layer）——config 指定数据库文件
// 与连接参数；Layer.orDie 表示打开失败（文件损坏或锁超时）直接让程序崩溃
export const sqliteLayer = (config: SqliteClient.SqliteClientConfig): Layer.Layer<SqlClient.SqlClient> =>
  Layer.orDie(SqliteClient.layer(config))
