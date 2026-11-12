// 将本模块以命名空间形式整体导出为 DatabaseMigration，供其他模块以 DatabaseMigration.xxx 引用
export * as DatabaseMigration from "./migration.js"

// 从 drizzle-orm 导入 sql 标签模板：用于构造类型安全的 SQL 片段
import { sql } from "drizzle-orm"
// 从 effect 导入 Effect：函数式效果运行时
import { Effect } from "effect"
// 仅导入类型：effect/sql 的 SqlClient（SQL 客户端接口）
import type { SqlClient } from "effect/sql"
// 导入 supportsForeignKeyToggle：当前运行时是否支持切换外键（foreign keys）开关
import { supportsForeignKeyToggle } from "#sqlite"
// 导入基于 drizzle 的 Effect SQLite 封装
import { EffectDrizzleSqlite } from "./drizzle.js"
// 导入自动生成的迁移列表（按时间戳排序）
import { migrations } from "./migration.gen.js"
import legacyCredentials from "./migration/20260805200742_import_legacy_credentials.js"
import schema from "./schema.gen.js"
// 导入全局服务 Global：迁移过程中可能读取（如 v1 数据导入需要数据目录）
import { Global } from "@opencode/util/global"

// 数据库类型：Effect SQLite 数据库，且可选携带 $client（底层 SQL 客户端）
type Database = EffectDrizzleSqlite.EffectSQLiteDatabase & { readonly $client?: SqlClient.SqlClient }
// 事务类型：取 Database.transaction 回调首参的类型（事务句柄）
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0]

// 单个迁移的定义：id 为时间戳+名称的唯一标识；
// foreignKeys 为 false 时执行前放宽外键约束；up 为在事务中执行的升级逻辑
export type Migration = {
  id: string
  foreignKeys?: boolean
  up: (tx: Transaction) => Effect.Effect<void, unknown, Global.Service>
}

// Not serialized here: the Database layer holds a lock scoped to the database
// it is bootstrapping, since two instances over one file must not race.
// 在数据库上应用迁移的总入口：空库走全新引导（bootstrap），已有库走增量应用
export function apply(db: Database) {
  // 用 Effect.gen 编排整个引导/迁移流程
  return Effect.gen(function* () {
    // OpenCode owns the unprefixed table namespace. Embedders sharing this
    // database may own underscore-prefixed tables, which bootstrap ignores.
    // 查询当前库中已有的用户表名：排除 SQLite 内部表（sqlite_%）和下划线前缀表（嵌入方专属，引导时忽略）
    const tables = yield* db.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND substr(name, 1, 1) <> '_'`,
    )
    // 若已存在 session 或 session_v2 表，说明是本项目的旧库，只做增量迁移即可
    if (tables.some((table) => table.name === "session" || table.name === "session_v2"))
      // 走增量应用路径，避免重复建表
      return yield* applyOnly(db, migrations)
    // 若库中已有其他表但没有 session 表，说明这不是本项目的库，属于不可恢复错误
    if (tables.length > 0) return yield* Effect.die(new Error("Database is not empty and has no session table"))
    // 记录引导开始时间，用于统计耗时
    const started = Date.now()
    // 输出引导开始的日志（含迁移总数）
    yield* Effect.logInfo("database schema bootstrap started", { migrations: migrations.length })
    // 在单个事务中完成“建表 + 建迁移日志表 + 预登记全部迁移”，保证原子性
    yield* db.transaction((tx) =>
      Effect.gen(function* () {
        // 先用生成的 schema 一次性建出全部表结构
        yield* schema.up(tx)
        yield* legacyCredentials.up(tx)
        yield* tx.run(
          sql`CREATE TABLE ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`,
        )
        // 全新引导时所有迁移视为已完成：把每个迁移的 id 逐条登记进日志表
        yield* Effect.forEach(migrations, (migration) =>
          tx.run(
            sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${migration.id}, ${Date.now()})`,
          ),
        )
      }),
    )
    // 输出引导完成日志（含迁移总数与耗时）
    yield* Effect.logInfo("database schema bootstrap completed", {
      migrations: migrations.length,
      durationMs: Date.now() - started,
    })
  })
}

// 只做增量迁移（不建初始 schema）：先同步迁移日志，再逐个执行未完成的迁移。
// db 为目标数据库，input 为待应用的迁移列表
export function applyOnly(db: Database, input: Migration[]) {
  // 用 Effect.gen 编排增量迁移流程
  return Effect.gen(function* () {
    // 确保 migration 日志表存在（不存在则创建）
    yield* db.run(
      sql`CREATE TABLE IF NOT EXISTS ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`,
    )
    // 读取已完成迁移的 id 集合，用于跳过已执行的迁移
    let completed = new Set(
      (yield* db.all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)).map((row) => row.id),
    )
    // 日志表为空时，需要处理旧版本安装的迁移历史
    if (completed.size === 0) {
      // Existing installs used Drizzle's migration journal. Seed the new
      // journal once so TypeScript migrations don't replay old SQL.
      // 若存在 Drizzle 旧的迁移日志表 __drizzle_migrations，则把它一次性播种（seed）到新日志表
      if (
        yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${"__drizzle_migrations"}`)
      ) {
        // 检查旧表结构：是否存在 name 列（新式日志带名称列）
        const named = (yield* db.all<{ name: string }>(
          sql`SELECT name FROM pragma_table_info('__drizzle_migrations')`,
        )).some((column) => column.name === "name")

        // 旧表带 name 列：直接把名称复制进新日志表
        if (named) {
          yield* db.run(sql`
            INSERT OR IGNORE INTO ${sql.identifier("migration")} (id, time_completed)
            SELECT name, ${Date.now()}
            FROM ${sql.identifier("__drizzle_migrations")}
            WHERE name IS NOT NULL
          `)
        }

        // 旧表不带 name 列：只能按 created_at 时间戳前缀匹配迁移 id
        if (!named) {
          // 读取每条旧日志的创建时间，并换算成 YYYYMMDDHHMMSS 形式的前缀
          const entries = yield* db.all<{ created_at: number; prefix: string | null }>(sql`
            SELECT created_at, strftime('%Y%m%d%H%M%S', created_at / 1000, 'unixepoch') AS prefix
            FROM ${sql.identifier("__drizzle_migrations")}
            WHERE created_at IS NOT NULL
          `)

          // 逐条把旧日志映射到已知迁移并登记
          for (const entry of entries) {
            // 按时间戳前缀在本项目迁移列表中查找对应的迁移
            const migration = input.find((item) => item.id.startsWith(`${entry.prefix}_`))
            // 找不到匹配说明旧时间戳与现有迁移对不上，属于不可恢复错误
            if (!migration) {
              return yield* Effect.die(
                new Error(`Legacy migration timestamp ${entry.created_at} does not match any known migration`),
              )
            }
            // 把匹配到的迁移 id 登记为新日志（已存在则忽略）
            yield* db.run(sql`
              INSERT OR IGNORE INTO ${sql.identifier("migration")} (id, time_completed)
              VALUES (${migration.id}, ${Date.now()})
            `)
          }
        }
        // 播种完成后重新读取已完成集合，作为后续跳过的依据
        completed = new Set(
          (yield* db.all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)).map((row) => row.id),
        )
      }
    }

    // 逐个遍历迁移，执行所有尚未完成的
    for (const migration of input) {
      // 已完成的迁移直接跳过
      if (completed.has(migration.id)) continue
      // 记录该迁移的开始时间，用于统计耗时
      const started = Date.now()
      // 输出迁移开始日志
      yield* Effect.logInfo("database migration started", { migration: migration.id })
      // 迁移的执行体：在事务中运行 up，成功后登记进日志表
      const apply = db.transaction((tx) =>
        Effect.gen(function* () {
          // 执行迁移自身的升级逻辑
          yield* migration.up(tx)
          // 登记迁移完成记录（id 与完成时间）
          yield* tx.run(
            sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${migration.id}, ${Date.now()})`,
          )
        }),
      )
      // 根据迁移声明决定是否放宽外键约束（默认放宽前置条件）
      const run =
        // foreignKeys !== false 表示该迁移不需要放宽外键，直接在事务中执行
        migration.foreignKeys !== false
          ? apply
          : Effect.gen(function* () {
              // Durable Object SQLite rejects the foreign_keys toggle; the closest
              // allowlisted relaxation is deferring enforcement to transaction commit.
              // 是否允许切换外键开关：需运行时支持，且不是原生管理事务的 Durable Object 客户端
              const toggleForeignKeys =
                supportsForeignKeyToggle &&
                !(db.$client !== undefined && EffectDrizzleSqlite.managesTransactionsNatively(db.$client))
              // 放宽外键的两种方式：可直接关闭外键，否则用 defer_foreign_keys 把检查推迟到事务提交
              const relaxForeignKeys = toggleForeignKeys
                ? db.run(sql`PRAGMA foreign_keys = OFF`)
                : db.run(sql`PRAGMA defer_foreign_keys = ON`)
              // 对应的恢复动作：可切换时重新打开外键，否则 defer 仅作用于当前事务无需恢复
              const restoreForeignKeys = toggleForeignKeys
                ? Effect.asVoid(db.run(sql`PRAGMA foreign_keys = ON`))
                : Effect.void
              // 先执行放宽动作
              yield* relaxForeignKeys
              // 再执行迁移；Effect.ensuring 保证无论成败都会恢复外键设置
              yield* apply.pipe(Effect.ensuring(restoreForeignKeys.pipe(Effect.orDie)))
            })
      // 执行迁移并在失败时记录错误日志（含迁移 id、耗时与错误内容）
      yield* run.pipe(
        Effect.tapError((error) =>
          Effect.logError("database migration failed", {
            migration: migration.id,
            durationMs: Date.now() - started,
            error,
          }),
        ),
      )
      // 输出迁移完成日志（含耗时）
      yield* Effect.logInfo("database migration completed", {
        migration: migration.id,
        durationMs: Date.now() - started,
      })
    }
  })
}
