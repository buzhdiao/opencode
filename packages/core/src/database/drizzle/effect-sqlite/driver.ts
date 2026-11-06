/* oxlint-disable */
// 以命名空间方式导入 Effect（效果运行时）
import * as Effect from "effect/Effect"
// 以命名空间方式导入 Layer（层的构建与组合）
import * as Layer from "effect/Layer"
// 导入 SqlClient：Effect 的通用 SQL 客户端服务接口
import { SqlClient } from "effect/sql/SqlClient"
// 导入 EffectCache：drizzle 的 Effect 版查询缓存服务
import { EffectCache } from "drizzle-orm/cache/core/cache-effect"
// 导入 EffectLogger：drizzle 的 Effect 版日志服务
import { EffectLogger } from "drizzle-orm/effect-core"
// 导入 entityKind：drizzle 实体类型标识符号（用于运行时类型标记）
import { entityKind } from "drizzle-orm/entity"
// 仅导入类型：AnyRelations（任意关系定义）、EmptyRelations（空关系定义）
import type { AnyRelations, EmptyRelations } from "drizzle-orm/relations"
// 导入 SQLiteDialect：drizzle 的 SQLite 方言（负责把查询对象编译成 SQL）
import { SQLiteDialect } from "drizzle-orm/sqlite-core/dialect"
// 导入 SQLiteEffectDatabase：Effect 版 SQLite 数据库基类
import { SQLiteEffectDatabase } from "../sqlite-core/effect/db.js"
// 仅导入类型：DrizzleConfig（drizzle 通用配置）
import type { DrizzleConfig } from "drizzle-orm/utils"
// 导入 jitCompatCheck：检测当前环境是否可用 JIT 映射器的兼容性检查
import { jitCompatCheck } from "../internal/drizzle-utils.js"
// 导入本目录 session 模块：查询效果 HKT 类型、执行结果类型与会话实现
import { type EffectSQLiteQueryEffectHKT, type EffectSQLiteRunResult, EffectSQLiteSession } from "./session.js"

// Effect 版 SQLite 数据库类：继承自 SQLiteEffectDatabase，泛型参数为查询 HKT、执行结果与关系定义
export class EffectSQLiteDatabase<TRelations extends AnyRelations = EmptyRelations> extends SQLiteEffectDatabase<
  EffectSQLiteQueryEffectHKT,
  EffectSQLiteRunResult,
  TRelations
> {
  // 覆盖父类的实体类型标记，供 drizzle 内部按实体类型分发
  static override readonly [entityKind]: string = "EffectSQLiteDatabase"
}

// Effect 版 drizzle 配置类型：基于通用 DrizzleConfig，移除 cache / logger / schema 三项（由本驱动内部管理）
export type EffectDrizzleSQLiteConfig<TRelations extends AnyRelations = EmptyRelations> = Omit<
  DrizzleConfig<Record<string, never>, TRelations>,
  "cache" | "logger" | "schema"
>

// 默认服务层：把 EffectCache 与 EffectLogger 的默认实现合并为一个 Layer，供 make 使用
export const DefaultServices = Layer.merge(EffectCache.Default, EffectLogger.Default)

/**
 * Creates an EffectSQLiteDatabase instance.
 *
 * Requires a generic Effect `SqlClient`, `EffectLogger`, and `EffectCache` services to be provided.
 * Drizzle only depends on the generic `SqlClient`; install and provide a compatible SQLite provider such as
 * `@effect/sql-sqlite-node`, `@effect/sql-sqlite-bun`, or another package that exposes `SqlClient`.
 *
 * @example
 * ```ts
 * import { SqliteClient } from "@effect/sql-sqlite-node"
 * import { EffectDrizzleSqlite } from "@opencode/core/database/drizzle"
 * import { Effect } from "effect"
 *
 * const db = yield* EffectDrizzleSqlite.make({ relations }).pipe(
 *   Effect.provide(EffectDrizzleSqlite.DefaultServices),
 *   Effect.provide(SqliteClient.layer({ filename: "sqlite.db" })),
 * )
 * ```
 */
// 数据库构建工厂：生成器函数，从上下文取 SqlClient / EffectCache / EffectLogger 并组装出数据库实例
export const make = Effect.fn("SQLiteDrizzle.make")(function* <TRelations extends AnyRelations = EmptyRelations>(
  config: EffectDrizzleSQLiteConfig<TRelations> = {},
) {
  // 从 Effect 上下文取出通用 SQL 客户端
  const client = yield* SqlClient
  // 从 Effect 上下文取出查询缓存服务
  const cache = yield* EffectCache
  // 从 Effect 上下文取出日志服务
  const logger = yield* EffectLogger

  // 判断是否启用 JIT 映射器（取决于环境兼容性与配置）
  const useJitMappers = jitCompatCheck(config.jit)
  // 创建 SQLite 方言实例，携带是否使用 JIT 映射器的标记
  const dialect = new SQLiteDialect({ useJitMappers })
  // 取配置中的关系定义，缺省为空对象（强转为泛型关系类型）
  const relations = config.relations ?? ({} as TRelations)
  // 创建 Effect 版 SQLite 会话：绑定客户端、方言、关系及日志/缓存/JIT 配置
  const session = new EffectSQLiteSession(client, dialect, relations, {
    logger,
    cache,
    useJitMappers,
  })
  // 用方言与会话组装数据库实例，并附上 $client 属性的类型（drizzle 约定的逃生舱口）
  const db = new EffectSQLiteDatabase(dialect, session, relations) as EffectSQLiteDatabase<TRelations> & {
    $client: SqlClient
  }
  // 把底层客户端挂到 db.$client，便于运行时探测（如判断是否原生管理事务）
  db.$client = client
  // 把缓存失效钩子接到缓存服务的 onMutate：写入时使相关查询缓存失效
  db.$cache.invalidate = cache.onMutate

  // 返回组装完成的数据库实例
  return db
})

/**
 * Convenience function that creates an EffectSQLiteDatabase with `DefaultServices` already provided.
 */
// 便捷工厂：等价于 make，但自动提供 DefaultServices（默认缓存与日志服务）
export const makeWithDefaults = <TRelations extends AnyRelations = EmptyRelations>(
  config: EffectDrizzleSQLiteConfig<TRelations> = {},
) => make(config).pipe(Effect.provide(DefaultServices))
