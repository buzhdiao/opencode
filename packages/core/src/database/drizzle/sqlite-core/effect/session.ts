/* oxlint-disable */
// 以命名空间方式导入 Cause：Effect 的错误成因表示（包装失败原因）
import * as Cause from "effect/Cause"
// 以命名空间方式导入 Effect（效果运行时）
import * as Effect from "effect/Effect"
// 仅导入类型：SqlError（SQL 执行错误）
import type { SqlError } from "effect/sql/SqlError"
// 仅导入类型：EffectCacheShape（Effect 缓存服务形状）
import type { EffectCacheShape } from "drizzle-orm/cache/core/cache-effect"
// 导入 NoopCache（空缓存实现）与 strategyFor（根据查询推导缓存策略）
import { NoopCache, strategyFor } from "drizzle-orm/cache/core/cache"
// 仅导入类型：WithCacheConfig（查询缓存配置）
import type { WithCacheConfig } from "drizzle-orm/cache/core/types"
// 导入 Effect 版 drizzle 错误类型：查询错误与事务回滚信号错误
import { EffectDrizzleQueryError, EffectTransactionRollbackError } from "drizzle-orm/effect-core/errors"
// 仅导入类型：EffectLoggerShape（Effect 日志服务形状）
import type { EffectLoggerShape } from "drizzle-orm/effect-core/logger"
// 仅导入类型：查询效果 HKT 基接口与查询效果类型构造器
import type { QueryEffectHKTBase, QueryEffectKind } from "drizzle-orm/effect-core/query-effect"
// 导入 entityKind 与 is：实体类型标识与运行时类型判断
import { entityKind, is } from "drizzle-orm/entity"
// 仅导入类型：关系定义相关类型（任意关系、空关系、关系映射配置、关系行映射器）
import type {
  AnyRelations,
  EmptyRelations,
  RelationalQueryMapperConfig,
  RelationalRowsMapper,
} from "drizzle-orm/relations"
// 导入 makeJitRqbMapper：为关系查询构建 JIT 行映射器
import { makeJitRqbMapper } from "drizzle-orm/relations"
// 仅导入类型：PreparedQuery（预编译查询接口）
import type { PreparedQuery } from "drizzle-orm/session"
// 导入 fillPlaceholders（填充查询占位符）与类型 Query、SQL
import { fillPlaceholders, type Query, type SQL } from "drizzle-orm/sql/sql"
// 仅导入类型：SQLiteDialect（SQLite 方言）
import type { SQLiteDialect } from "drizzle-orm/sqlite-core/dialect"
// 仅导入类型：SelectedFieldsOrdered（按序字段集合）
import type { SelectedFieldsOrdered } from "drizzle-orm/sqlite-core/query-builders/select.types"
// 仅导入类型：预编译查询配置、执行方法、事务配置
import type { PreparedQueryConfig, SQLiteExecuteMethod, SQLiteTransactionConfig } from "drizzle-orm/sqlite-core/session"
// 导入工具：assertUnreachable（穷尽检查）、makeJitQueryMapper（JIT 行映射器）、RowsMapper 类型
import { assertUnreachable, makeJitQueryMapper, type RowsMapper } from "drizzle-orm/utils"
// 导入内部工具：行结果映射与可空连接对象路径解析
import { mapResultRow, resolveNullableObjectPaths } from "../../internal/drizzle-utils.js"
// 导入 Effect 版数据库类（事务类需要继承它）
import { SQLiteEffectDatabase } from "./db.js"

// 预编译查询可用的执行方法：常规方法外加 "values"（原始行数据）
type SQLiteEffectExecuteMethod = SQLiteExecuteMethod | "values"

// Effect 版预编译查询：持有执行体与查询信息，负责执行、日志、缓存与结果映射
export class SQLiteEffectPreparedQuery<
  T extends PreparedQueryConfig,
  TEffectHKT extends QueryEffectHKTBase = QueryEffectHKTBase,
  TIsRqbV2 extends boolean = false,
> implements PreparedQuery
{
  // 实体类型标记
  static readonly [entityKind]: string = "SQLiteEffectPreparedQuery"

  /** @internal */
  // 连接可空性映射：由查询对象注入，用于行映射时的空值推断
  joinsNotNullableMap?: Record<string, boolean>
  // JIT 行映射器缓存：首次映射时创建并复用
  private jitMapper?: RowsMapper<any> | RelationalRowsMapper<any>
  // 缓存配置：未启用时为 undefined
  private cacheConfig: WithCacheConfig | undefined
  // execute() 默认调用的方法名（如 run/all/get）
  private effectExecuteMethod: SQLiteExecuteMethod

  // 构造：保存执行体、查询、日志、缓存、元数据、字段、JIT 开关与各映射器配置
  constructor(
    private executor: (
      params: unknown[],
      executeMethod: SQLiteEffectExecuteMethod,
    ) => Effect.Effect<unknown, unknown, unknown>,
    protected query: Query,
    private logger: EffectLoggerShape,
    private cache: EffectCacheShape,
    private queryMetadata:
      | {
          type: "select" | "update" | "delete" | "insert"
          tables: string[]
        }
      | undefined,
    cacheConfig: WithCacheConfig | undefined,
    private fields: SelectedFieldsOrdered | undefined,
    executeMethod: SQLiteExecuteMethod,
    private useJitMappers: boolean | undefined,
    private customResultMapper?: (
      rows: TIsRqbV2 extends true ? Record<string, unknown>[] : unknown[][],
      mapColumnValue?: (value: unknown) => unknown,
    ) => unknown,
    private isRqbV2Query?: TIsRqbV2,
    private rqbConfig?: RelationalQueryMapperConfig,
    private isInTransaction: Effect.Effect<boolean> = Effect.succeed(false),
  ) {
    // 记录 execute() 分派到的方法
    this.effectExecuteMethod = executeMethod
    // 缓存策略为 "all" 且调用方未显式配置时，默认开启自动失效缓存
    this.cacheConfig =
      cache.strategy() === "all" && cacheConfig === undefined ? { enabled: true, autoInvalidate: true } : cacheConfig
    // 未启用缓存则清空配置，后续直接跳过缓存逻辑
    if (!this.cacheConfig?.enabled) {
      this.cacheConfig = undefined
    }
  }

  // run 重载签名：返回运行结果
  run(placeholderValues?: Record<string, unknown>): QueryEffectKind<TEffectHKT, T["run"]>
  // run 实现：执行写/更新语句，不做行映射
  run(placeholderValues?: Record<string, unknown>): any {
    // 以 "run" 方式走缓存包装执行
    return this.executeWithCache<T["run"]>(placeholderValues, "run")
  }

  // all 重载签名：返回全部行
  all(placeholderValues?: Record<string, unknown>): QueryEffectKind<TEffectHKT, T["all"]>
  // all 实现：按是否配置字段/映射器选择执行与映射路径
  all(placeholderValues?: Record<string, unknown>): any {
    // 关系型查询（RQB v2）走专用路径
    if (this.isRqbV2Query) return this.allRqbV2(placeholderValues)

    // 既无字段定义也无自定义映射器：原样返回全部行
    if (!this.fields && !this.customResultMapper) {
      return this.executeWithCache<T["all"]>(placeholderValues, "all")
    }

    // 以 "values" 取原始行数据后做映射
    return this.executeWithCache<T["values"], T["all"]>(
      placeholderValues,
      "values",
      (rows) => this.mapAllResult(rows) as T["all"],
    )
  }

  // get 重载签名：返回单行
  get(placeholderValues?: Record<string, unknown>): QueryEffectKind<TEffectHKT, T["get"]>
  // get 实现：按是否配置字段/映射器选择执行与映射路径
  get(placeholderValues?: Record<string, unknown>): any {
    // 关系型查询走专用路径
    if (this.isRqbV2Query) return this.getRqbV2(placeholderValues)

    // 既无字段定义也无自定义映射器：原样返回单行
    if (!this.fields && !this.customResultMapper) {
      return this.executeWithCache<T["get"]>(placeholderValues, "get")
    }

    // 以 "values" 取原始行数据后映射出单行
    return this.executeWithCache<T["values"], T["get"]>(
      placeholderValues,
      "values",
      (rows) => this.mapGetResult(rows) as T["get"],
    )
  }

  // values 重载签名：返回原始行数据
  values(placeholderValues?: Record<string, unknown>): QueryEffectKind<TEffectHKT, T["values"]>
  // values 实现：不做映射，直接返回原始行
  values(placeholderValues?: Record<string, unknown>): any {
    // 以 "values" 方式执行
    return this.executeWithCache<T["values"]>(placeholderValues, "values")
  }

  // execute 重载签名：按预设方法返回结果
  execute(placeholderValues?: Record<string, unknown>): QueryEffectKind<TEffectHKT, T["execute"]>
  // execute 实现：分派到构造时记录的执行方法
  execute(placeholderValues?: Record<string, unknown>): any {
    // 调用对应的 run/all/get 方法
    return this[this.effectExecuteMethod](placeholderValues) as QueryEffectKind<TEffectHKT, T["execute"]>
  }

  // run 结果映射：默认原样返回
  mapRunResult(result: unknown, _isFromBatch?: boolean): unknown {
    // 直接透传
    return result
  }

  // all 结果映射：把原始行数组映射为结构化结果
  mapAllResult(rows: unknown, isFromBatch?: boolean): unknown {
    // 来自批处理时结果可能是嵌套数组，统一规范化为数组
    if (isFromBatch) {
      rows = Array.isArray(rows) ? rows : []
    }

    // 无字段且无自定义映射器：原样返回
    if (!this.fields && !this.customResultMapper) {
      return rows
    }

    // 关系型查询（RQB v2）：优先用 JIT 映射器，否则用自定义映射器
    if (this.isRqbV2Query) {
      return this.useJitMappers
        ? (this.jitMapper =
            (this.jitMapper as RelationalRowsMapper<T["all"]>) ?? makeJitRqbMapper<T["all"]>(this.rqbConfig!))(
            rows as Record<string, unknown>[],
          )
        : (this.customResultMapper as (rows: Record<string, unknown>[]) => unknown)(rows as Record<string, unknown>[])
    }

    // 有自定义映射器：直接调用
    if (this.customResultMapper) {
      return (this.customResultMapper as (rows: unknown[][]) => unknown)(rows as unknown[][]) as T["all"]
    }

    // 普通查询：JIT 映射器（懒创建并缓存）或逐行 mapResultRow 映射
    return this.useJitMappers
      ? (this.jitMapper =
          (this.jitMapper as RowsMapper<T["all"]>) ??
          makeJitQueryMapper<T["all"]>(
            this.fields!,
            resolveNullableObjectPaths(this.fields!, this.joinsNotNullableMap),
          ))(rows as unknown[][])
      : (rows as unknown[][]).map((row) => mapResultRow(this.fields!, row, this.joinsNotNullableMap))
  }

  // get 结果映射：把原始数据映射为单行结果
  mapGetResult(rows: unknown, isFromBatch?: boolean): unknown {
    // 来自批处理时规范化为数组
    if (isFromBatch) {
      rows = Array.isArray(rows) ? rows : []
    }

    // 无字段且无自定义映射器：直接取首行（或原样返回）
    if (!this.fields && !this.customResultMapper) {
      return Array.isArray(rows) ? rows[0] : rows
    }

    // 取首行；无行返回 undefined
    const row = Array.isArray(rows) ? rows[0] : rows
    // 空结果直接返回 undefined
    if (!row) return undefined

    // 关系型查询（RQB v2）：以单行数组走 JIT 或自定义映射器
    if (this.isRqbV2Query) {
      return this.useJitMappers
        ? (this.jitMapper =
            (this.jitMapper as RelationalRowsMapper<T["get"][]>) ?? makeJitRqbMapper<T["get"][]>(this.rqbConfig!))([
            row as Record<string, unknown>,
          ])
        : (this.customResultMapper as (rows: Record<string, unknown>[]) => unknown)([row as Record<string, unknown>])
    }

    // 有自定义映射器：以单行数组调用
    if (this.customResultMapper) {
      return (this.customResultMapper as (rows: unknown[][]) => unknown)([row as unknown[]]) as T["get"]
    }

    // 普通查询：JIT 映射器取首条映射结果，或直接 mapResultRow 单行映射
    return this.useJitMappers
      ? (this.jitMapper =
          (this.jitMapper as RowsMapper<T["get"][]>) ??
          makeJitQueryMapper<T["get"][]>(
            this.fields!,
            resolveNullableObjectPaths(this.fields!, this.joinsNotNullableMap),
          ))([row as unknown[]])[0]
      : mapResultRow(this.fields!, row as unknown[], this.joinsNotNullableMap)
  }

  // RQB v2 的 all 路径：以 "all" 执行并映射全部行
  private allRqbV2(placeholderValues?: Record<string, unknown>) {
    // 执行后用 mapAllResult 映射
    return this.executeWithCache<unknown[], T["all"]>(
      placeholderValues,
      "all",
      (rows) => this.mapAllResult(rows) as T["all"],
    )
  }

  // RQB v2 的 get 路径：以 "get" 执行并映射单行（空结果保持 undefined）
  private getRqbV2(placeholderValues?: Record<string, unknown>) {
    // 执行后按结果是否为空分别映射
    return this.executeWithCache<unknown, T["get"] | undefined>(placeholderValues, "get", (row) =>
      row === undefined ? undefined : (this.mapGetResult(row) as T["get"]),
    )
  }

  // 带日志的执行包装：填充占位符、记录日志、再走缓存包装执行
  private executeWithCache<A, B = A>(
    placeholderValues: Record<string, unknown> | undefined,
    executeMethod: SQLiteEffectExecuteMethod,
    mapResult?: (result: A) => B,
  ) {
    // 以自身为上下文运行生成器
    return Effect.gen({ self: this }, function* () {
      // 把占位符填充进参数数组，得到最终绑定参数
      const params = fillPlaceholders(this.query.params, placeholderValues ?? {})

      // 记录查询日志（SQL 与参数）
      yield* this.logger.logQuery(this.query.sql, params)

      // 以缓存包装执行查询：Effect.suspend 延迟到实际运行时再创建执行 Effect
      return yield* this.queryWithCache(
        this.query.sql,
        params,
        Effect.suspend(() => this.executor(params, executeMethod) as Effect.Effect<A, unknown, unknown>),
        mapResult,
      )
    })
  }

  // 对缓存命中的结果应用映射函数；映射失败转为 Effect 失败
  private mapCachedResult<A, B>(result: A, mapResult: ((result: A) => B) | undefined) {
    // 无映射函数：直接成功返回
    if (!mapResult) return Effect.succeed(result as unknown as B)
    // 用 Effect.try 包裹映射，异常捕获为失败原因
    return Effect.try({
      try: () => mapResult(result),
      catch: (cause) => cause,
    })
  }

  // 缓存感知的查询执行：依据缓存策略决定读缓存/失效/直连执行
  private queryWithCache<A, E, R, B = A>(
    queryString: string,
    params: unknown[],
    query: Effect.Effect<A, E, R>,
    mapResult?: (result: A) => B,
  ) {
    // 以自身为上下文运行生成器
    return Effect.gen({ self: this }, function* () {
      // 事务中的 select 不读缓存（可见性与失效语义不可靠），直接执行
      if (this.queryMetadata?.type === "select" && this.cacheConfig?.enabled && (yield* this.isInTransaction)) {
        return yield* this.mapCachedResult(yield* query, mapResult)
      }

      // 缓存实现为 NoopCache 时跳过策略推导；否则按查询推导缓存策略
      const cacheStrat: Awaited<ReturnType<typeof strategyFor>> = !is(this.cache.cache, NoopCache)
        ? yield* Effect.tryPromise(() => strategyFor(queryString, params, this.queryMetadata, this.cacheConfig))
        : { type: "skip" as const }

      // 策略为 skip：不使用缓存，直接执行
      if (cacheStrat.type === "skip") {
        return yield* this.mapCachedResult(yield* query, mapResult)
      }

      // 策略为 invalidate：先执行变更查询，再使相关表缓存失效
      if (cacheStrat.type === "invalidate") {
        // 执行变更语句
        const result = yield* query
        // 通知缓存服务按表失效
        yield* this.cache.onMutate({ tables: cacheStrat.tables })
        // 返回执行结果（应用映射）
        return yield* this.mapCachedResult(result, mapResult)
      }

      // 策略为 try：尝试读缓存，未命中再执行并写回
      if (cacheStrat.type === "try") {
        // 事务中的读不走缓存，直接执行
        if (yield* this.isInTransaction) {
          return yield* this.mapCachedResult(yield* query, mapResult)
        }

        // 解构缓存策略参数
        const { tables, key, isTag, autoInvalidate, config } = cacheStrat
        // 先查缓存
        const fromCache: any[] | undefined = yield* this.cache.get(key, tables, isTag, autoInvalidate)

        // 命中缓存：映射后直接返回
        if (typeof fromCache !== "undefined") {
          return yield* this.mapCachedResult(fromCache as unknown as A, mapResult)
        }

        // 未命中：执行查询
        const result = yield* query

        // 写回缓存（自动失效时登记相关表）
        yield* this.cache.put(key, result, autoInvalidate ? tables : [], isTag, config)

        // 返回执行结果（应用映射）
        return yield* this.mapCachedResult(result, mapResult)
      }

      // 穷尽检查：所有策略分支都已处理，类型不满足则编译期报错
      assertUnreachable(cacheStrat)
      // 统一把错误包装为 EffectDrizzleQueryError；参数脱敏为 [redacted] 避免日志泄露敏感值
    }).pipe(Effect.mapError((e) => new EffectDrizzleQueryError({ query: queryString, params: params.map(() => "[redacted]"), cause: Cause.fail(e) })))
  }

  // 返回底层查询对象（sql 与参数）
  getQuery(): Query {
    // 直接返回保存的查询
    return this.query
  }

  // 批处理场景的结果映射入口：按执行方法分派到对应映射函数
  mapResult(response: unknown, isFromBatch?: boolean) {
    // 依据执行方法选择映射逻辑
    switch (this.effectExecuteMethod) {
      // run：无行映射
      case "run": {
        // 委托给 mapRunResult
        return this.mapRunResult(response, isFromBatch)
      }
      // all：全部行映射
      case "all": {
        // 委托给 mapAllResult
        return this.mapAllResult(response, isFromBatch)
      }
      // get：单行映射
      case "get": {
        // 委托给 mapGetResult
        return this.mapGetResult(response, isFromBatch)
      }
    }
  }
}

// Explicit variance prevents comparisons from recursively scanning the full Drizzle query-builder graph.
// Effect 版 SQLite 会话抽象基类：定义预编译查询的准备与基础执行入口（显式型变注解避免类型比较开销）
export abstract class SQLiteEffectSession<
  out TEffectHKT extends QueryEffectHKTBase = QueryEffectHKTBase,
  out TRunResult = unknown,
  out TRelations extends AnyRelations = EmptyRelations,
> {
  // 实体类型标记
  static readonly [entityKind]: string = "SQLiteEffectSession"

  // 构造：保存方言（只读）
  constructor(readonly dialect: SQLiteDialect) {}

  // 抽象：准备普通查询（由具体驱动实现）
  abstract prepareQuery<T extends PreparedQueryConfig = PreparedQueryConfig>(
    query: Query,
    fields: SelectedFieldsOrdered | undefined,
    executeMethod: SQLiteExecuteMethod,
    customResultMapper?: (rows: unknown[][], mapColumnValue?: (value: unknown) => unknown) => unknown,
    queryMetadata?: {
      type: "select" | "update" | "delete" | "insert"
      tables: string[]
    },
    cacheConfig?: WithCacheConfig,
  ): SQLiteEffectPreparedQuery<T, TEffectHKT>

  // 准备一次性查询：默认实现直接复用 prepareQuery（驱动可覆写以优化）
  prepareOneTimeQuery<T extends PreparedQueryConfig = PreparedQueryConfig>(
    query: Query,
    fields: SelectedFieldsOrdered | undefined,
    executeMethod: SQLiteExecuteMethod,
    customResultMapper?: (rows: unknown[][], mapColumnValue?: (value: unknown) => unknown) => unknown,
    queryMetadata?: {
      type: "select" | "update" | "delete" | "insert"
      tables: string[]
    },
    cacheConfig?: WithCacheConfig,
  ): SQLiteEffectPreparedQuery<T, TEffectHKT> {
    // 直接委托给 prepareQuery
    return this.prepareQuery(query, fields, executeMethod, customResultMapper, queryMetadata, cacheConfig)
  }

  // 抽象：准备关系型查询（RQB v2，由具体驱动实现）
  abstract prepareRelationalQuery<T extends PreparedQueryConfig = PreparedQueryConfig>(
    query: Query,
    fields: SelectedFieldsOrdered | undefined,
    executeMethod: SQLiteExecuteMethod,
    customResultMapper: (rows: Record<string, unknown>[], mapColumnValue?: (value: unknown) => unknown) => unknown,
    config: RelationalQueryMapperConfig,
  ): SQLiteEffectPreparedQuery<T, TEffectHKT, true>

  // 准备一次性关系型查询：默认实现直接复用 prepareRelationalQuery
  prepareOneTimeRelationalQuery<T extends PreparedQueryConfig = PreparedQueryConfig>(
    query: Query,
    fields: SelectedFieldsOrdered | undefined,
    executeMethod: SQLiteExecuteMethod,
    customResultMapper: (rows: Record<string, unknown>[], mapColumnValue?: (value: unknown) => unknown) => unknown,
    config: RelationalQueryMapperConfig,
  ): SQLiteEffectPreparedQuery<T, TEffectHKT, true> {
    // 直接委托给 prepareRelationalQuery
    return this.prepareRelationalQuery(query, fields, executeMethod, customResultMapper, config)
  }

  // run 重载签名：执行 SQL 并返回运行结果
  run(query: SQL): QueryEffectKind<TEffectHKT, TRunResult>
  // run 实现：准备查询后以 "run" 执行
  run(query: SQL): any {
    // 用方言编译 SQL 并准备查询，无字段映射
    return this.prepareQuery<PreparedQueryConfig & { run: TRunResult; execute: TRunResult }>(
      this.dialect.sqlToQuery(query),
      undefined,
      "run",
    ).run()
  }

  // all 重载签名：执行 SQL 返回全部行
  all<T = unknown>(query: SQL): QueryEffectKind<TEffectHKT, T[]>
  // all 实现：准备查询后以 "all" 执行
  all<T = unknown>(query: SQL): any {
    // 用方言编译 SQL 并准备查询
    return this.prepareQuery<PreparedQueryConfig & { all: T[]; execute: T[] }>(
      this.dialect.sqlToQuery(query),
      undefined,
      "all",
    ).all()
  }

  // get 重载签名：执行 SQL 返回单行
  get<T = unknown>(query: SQL): QueryEffectKind<TEffectHKT, T | undefined>
  // get 实现：准备查询后以 "get" 执行
  get<T = unknown>(query: SQL): any {
    // 用方言编译 SQL 并准备查询
    return this.prepareQuery<PreparedQueryConfig & { get: T | undefined; execute: T | undefined }>(
      this.dialect.sqlToQuery(query),
      undefined,
      "get",
    ).get()
  }

  // values 重载签名：执行 SQL 返回原始行数据
  values<T extends unknown[] = unknown[]>(query: SQL): QueryEffectKind<TEffectHKT, T[]>
  // values 实现：以 "all" 方式准备（原始行数据形态），再调用 values
  values<T extends unknown[] = unknown[]>(query: SQL): any {
    // 用方言编译 SQL 并准备查询
    return this.prepareQuery<PreparedQueryConfig & { values: T[]; execute: T[] }>(
      this.dialect.sqlToQuery(query),
      undefined,
      "all",
    ).values()
  }

  // count 重载签名：执行计数 SQL 返回数字
  count(query: SQL): QueryEffectKind<TEffectHKT, number>
  // count 实现：以 values 执行并取首行首列（空结果为 0）
  count(query: SQL): any {
    // 用 values 取原始行，再映射为数字
    return this.values<[number]>(query).pipe(Effect.map((result) => result[0]?.[0] ?? 0))
  }

  // 抽象：开启事务（由具体驱动实现，如 BEGIN/SAVEPOINT 语义）
  abstract transaction<A, E, R>(
    transaction: (tx: SQLiteEffectTransaction<TEffectHKT, TRunResult, TRelations>) => Effect.Effect<A, E, R>,
    config?: SQLiteTransactionConfig,
  ): Effect.Effect<A, E | SqlError, R>
}

// Effect 版事务抽象基类：继承数据库类，可在事务内使用完整查询 API，并提供回滚信号
export abstract class SQLiteEffectTransaction<
  out TEffectHKT extends QueryEffectHKTBase,
  out TRunResult,
  out TRelations extends AnyRelations = EmptyRelations,
> extends SQLiteEffectDatabase<TEffectHKT, TRunResult, TRelations> {
  // 实体类型标记
  static override readonly [entityKind]: string = "SQLiteEffectTransaction"

  // 构造：把方言、会话与关系定义传给父类（事务对象本身就是一个受限的数据库视图）
  constructor(
    dialect: SQLiteDialect,
    session: SQLiteEffectSession<TEffectHKT, TRunResult, TRelations>,
    protected relations: TRelations,
  ) {
    // 调用父类构造
    super(dialect, session, relations)
  }

  // rollback：抛出回滚信号错误，框架捕获后回滚整个事务
  rollback() {
    // 返回专用的回滚错误对象
    return new EffectTransactionRollbackError()
  }
}
