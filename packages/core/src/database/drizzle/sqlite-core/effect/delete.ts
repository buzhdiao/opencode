/* oxlint-disable */
// 仅导入类型：Effect（效果类型）
import type * as Effect from "effect/Effect"
// 导入 applyEffectWrapper（混入 Effect 能力）与 QueryEffectHKTBase（查询效果 HKT 基接口）
import { applyEffectWrapper, type QueryEffectHKTBase } from "drizzle-orm/effect-core/query-effect"
// 导入 entityKind：drizzle 实体类型标识符号
import { entityKind } from "drizzle-orm/entity"
// 仅导入类型：SelectResultFields（把选中字段映射为结果字段类型）
import type { SelectResultFields } from "drizzle-orm/query-builders/select.types"
// 仅导入类型：RunnableQuery（可运行查询接口）
import type { RunnableQuery } from "drizzle-orm/runnable-query"
// 导入 SelectionProxyHandler：表列的字段选择代理
import { SelectionProxyHandler } from "drizzle-orm/selection-proxy"
// 仅导入类型：Placeholder（占位符）、Query（查询对象）、SQL（SQL 片段）、SQLWrapper
import type { Placeholder, Query, SQL, SQLWrapper } from "drizzle-orm/sql/sql"
// 仅导入类型：SQLiteDialect（SQLite 方言）
import type { SQLiteDialect } from "drizzle-orm/sqlite-core/dialect"
// 仅导入类型：删除查询配置
import type { SQLiteDeleteConfig } from "drizzle-orm/sqlite-core/query-builders/delete"
// 仅导入类型：SelectedFieldsFlat（扁平字段集合）
import type { SelectedFieldsFlat } from "drizzle-orm/sqlite-core/query-builders/select.types"
// 仅导入类型：PreparedQueryConfig（预编译查询配置）
import type { PreparedQueryConfig } from "drizzle-orm/sqlite-core/session"
// 导入 SQLiteTable（SQLite 表实体）
import { SQLiteTable } from "drizzle-orm/sqlite-core/table"
// 导入 extractUsedTable：提取查询涉及的表名集合
import { extractUsedTable } from "drizzle-orm/sqlite-core/utils"
// 仅导入类型：Subquery（子查询实体）
import type { Subquery } from "drizzle-orm/subquery"
// 仅导入类型：DrizzleTypeError（语义错误提示类型）、ValueOrArray（值或数组）
import { type DrizzleTypeError, type ValueOrArray } from "drizzle-orm/utils"
// 仅导入类型：SQLiteColumn（SQLite 列）
import type { SQLiteColumn } from "drizzle-orm/sqlite-core/columns/common"
// 导入内部工具：运行时列映射与字段排序展平
import { getTableColumnsRuntime, orderSelectedFields } from "../../internal/drizzle-utils.js"
// 仅导入类型：预编译查询与会话
import type { SQLiteEffectPreparedQuery, SQLiteEffectSession } from "./session.js"

// 从删除类型中排除已调用过的方法（非动态模式下防止重复调用）
export type SQLiteEffectDeleteWithout<
  T extends AnySQLiteEffectDelete,
  TDynamic extends boolean,
  K extends keyof T & string,
> = TDynamic extends true
  ? T
  : Omit<
      SQLiteEffectDeleteBase<
        T["_"]["table"],
        T["_"]["runResult"],
        T["_"]["returning"],
        TDynamic,
        T["_"]["excludedMethods"] | K,
        T["_"]["effectHKT"]
      >,
      T["_"]["excludedMethods"] | K
    >

// returning()（无参，返回全部列）之后的删除类型
export type SQLiteEffectDeleteReturningAll<
  T extends AnySQLiteEffectDelete,
  TDynamic extends boolean,
> = SQLiteEffectDeleteWithout<
  SQLiteEffectDeleteBase<
    T["_"]["table"],
    T["_"]["runResult"],
    T["_"]["table"]["$inferSelect"],
    T["_"]["dynamic"],
    T["_"]["excludedMethods"],
    T["_"]["effectHKT"]
  >,
  TDynamic,
  "returning"
>

// returning(指定字段) 之后的删除类型：结果变为所选字段
export type SQLiteEffectDeleteReturning<
  T extends AnySQLiteEffectDelete,
  TDynamic extends boolean,
  TSelectedFields extends SelectedFieldsFlat,
> = SQLiteEffectDeleteWithout<
  SQLiteEffectDeleteBase<
    T["_"]["table"],
    T["_"]["runResult"],
    SelectResultFields<TSelectedFields>,
    T["_"]["dynamic"],
    T["_"]["excludedMethods"],
    T["_"]["effectHKT"]
  >,
  TDynamic,
  "returning"
>

// 删除的执行结果类型：未用 returning 时为运行结果，否则为返回行数组
export type SQLiteEffectDeleteExecute<T extends AnySQLiteEffectDelete> = T["_"]["returning"] extends undefined
  ? T["_"]["runResult"]
  : T["_"]["returning"][]

// 删除的预编译结果类型：未用 returning 时 all/get/values 给出语义错误类型提示
export type SQLiteEffectDeletePrepare<
  T extends AnySQLiteEffectDelete,
  TEffectHKT extends QueryEffectHKTBase = T["_"]["effectHKT"],
> = SQLiteEffectPreparedQuery<
  PreparedQueryConfig & {
    run: T["_"]["runResult"]
    all: T["_"]["returning"] extends undefined
      ? DrizzleTypeError<".all() cannot be used without .returning()">
      : T["_"]["returning"][]
    get: T["_"]["returning"] extends undefined
      ? DrizzleTypeError<".get() cannot be used without .returning()">
      : T["_"]["returning"] | undefined
    values: T["_"]["returning"] extends undefined
      ? DrizzleTypeError<".values() cannot be used without .returning()">
      : any[][]
    execute: SQLiteEffectDeleteExecute<T>
  },
  TEffectHKT
>

// 动态模式类型：解除方法排除限制
export type SQLiteEffectDeleteDynamic<T extends AnySQLiteEffectDelete> = SQLiteEffectDelete<
  T["_"]["table"],
  T["_"]["runResult"],
  T["_"]["returning"],
  T["_"]["effectHKT"]
>

// 完整删除类型（动态模式）
export type SQLiteEffectDelete<
  TTable extends SQLiteTable = SQLiteTable,
  TRunResult = unknown,
  TReturning extends Record<string, unknown> | undefined = undefined,
  TEffectHKT extends QueryEffectHKTBase = QueryEffectHKTBase,
> = SQLiteEffectDeleteBase<TTable, TRunResult, TReturning, true, never, TEffectHKT>

// 任意泛型参数的删除类型
export type AnySQLiteEffectDelete = SQLiteEffectDeleteBase<any, any, any, any, any, any>

// 删除对象接口：同时是可运行查询、SQLWrapper 与 Effect
export interface SQLiteEffectDeleteBase<
  out TTable extends SQLiteTable,
  out TRunResult,
  out TReturning extends Record<string, unknown> | undefined = undefined,
  out TDynamic extends boolean = false,
  _TExcludedMethods extends string = never,
  out TEffectHKT extends QueryEffectHKTBase = QueryEffectHKTBase,
> extends RunnableQuery<TReturning extends undefined ? TRunResult : TReturning[], "sqlite">,
    SQLWrapper,
    Effect.Effect<
      TReturning extends undefined ? TRunResult : TReturning[],
      TEffectHKT["error"],
      TEffectHKT["context"]
    > {
  // 幻影类型字段：记录方言、表、结果形态等类型信息
  readonly _: {
    dialect: "sqlite"
    readonly table: TTable
    readonly resultType: "async"
    readonly runResult: TRunResult
    readonly returning: TReturning
    readonly dynamic: TDynamic
    readonly excludedMethods: _TExcludedMethods
    readonly result: TReturning extends undefined ? TRunResult : TReturning[]
    readonly effectHKT: TEffectHKT
  }
}

// 删除对象实现：持有删除配置，提供 where/orderBy/limit/returning 与执行
export class SQLiteEffectDeleteBase<
    out TTable extends SQLiteTable,
    out TRunResult,
    out TReturning extends Record<string, unknown> | undefined = undefined,
    out TDynamic extends boolean = false,
    _TExcludedMethods extends string = never,
    out TEffectHKT extends QueryEffectHKTBase = QueryEffectHKTBase,
  >
  implements RunnableQuery<TReturning extends undefined ? TRunResult : TReturning[], "sqlite">, SQLWrapper
{
  // 实体类型标记
  static readonly [entityKind]: string = "SQLiteEffectDelete"

  /** @internal */
  // 删除配置：目标表、WITH 列表、过滤条件、排序、限制行数、返回字段
  config: SQLiteDeleteConfig

  // 构造：保存表、会话、方言与 WITH 子查询列表，写入配置
  constructor(
    private table: TTable,
    private effectSession: SQLiteEffectSession<TEffectHKT, TRunResult, any>,
    private effectDialect: SQLiteDialect,
    withList?: Subquery[],
  ) {
    // 初始化删除配置
    this.config = { table, withList }
  }

  // where：设置删除的过滤条件（undefined 表示清除条件）
  where(where: SQL | undefined): SQLiteEffectDeleteWithout<this, TDynamic, "where"> {
    // 写入过滤条件
    this.config.where = where
    // 返回自身（类型层面排除再次调用 where）
    return this as any
  }

  // orderBy 重载：以回调函数指定排序
  orderBy(
    builder: (deleteTable: TTable) => ValueOrArray<SQLiteColumn | SQL | SQL.Aliased>,
  ): SQLiteEffectDeleteWithout<this, TDynamic, "orderBy">
  // orderBy 重载：直接传入列/SQL/别名
  orderBy(...columns: (SQLiteColumn | SQL | SQL.Aliased)[]): SQLiteEffectDeleteWithout<this, TDynamic, "orderBy">
  // orderBy 实现：支持回调与直接传参两种形式
  orderBy(
    ...columns:
      | [(deleteTable: TTable) => ValueOrArray<SQLiteColumn | SQL | SQL.Aliased>]
      | (SQLiteColumn | SQL | SQL.Aliased)[]
  ): SQLiteEffectDeleteWithout<this, TDynamic, "orderBy"> {
    // 回调形式：用列选择代理调用回调取得排序项
    if (typeof columns[0] === "function") {
      // 以代理包装表的列映射传给回调
      const orderBy = columns[0](
        new Proxy(
          getTableColumnsRuntime(this.config.table),
          new SelectionProxyHandler({ sqlAliasedBehavior: "alias", sqlBehavior: "sql" }),
        ) as any,
      )

      // 统一规范化为数组写入配置
      this.config.orderBy = Array.isArray(orderBy) ? orderBy : [orderBy]
      // 返回自身
      return this as any
    }

    // 直接传参形式：原样写入配置
    this.config.orderBy = columns as (SQLiteColumn | SQL | SQL.Aliased)[]
    // 返回自身
    return this as any
  }

  // limit：限制删除的最大行数（SQLite 支持 DELETE ... LIMIT）
  limit(limit: number | Placeholder): SQLiteEffectDeleteWithout<this, TDynamic, "limit"> {
    // 写入限制行数
    this.config.limit = limit
    // 返回自身
    return this as any
  }

  // returning 重载：无参返回全部列
  returning(): SQLiteEffectDeleteReturningAll<this, TDynamic>
  // returning 重载：指定返回字段
  returning<TSelectedFields extends SelectedFieldsFlat>(
    fields: TSelectedFields,
  ): SQLiteEffectDeleteReturning<this, TDynamic, TSelectedFields>
  // returning 实现：展平排序后写入配置
  returning(
    fields: SelectedFieldsFlat = getTableColumnsRuntime(this.table),
  ): SQLiteEffectDeleteReturning<this, TDynamic, any> | SQLiteEffectDeleteReturningAll<this, TDynamic> {
    // 默认取表全部列；记录到 returning 配置
    this.config.returning = orderSelectedFields<SQLiteColumn>(fields)
    // 返回自身
    return this as any
  }

  /** @internal */
  // 生成删除语句的 SQL 片段（内部使用）
  getSQL(): SQL {
    // 委托给方言构建 delete 查询
    return this.effectDialect.buildDeleteQuery(this.config)
  }

  // 导出编译后的查询（sql 与参数）
  toSQL(): Query {
    // 用方言把 SQL 编译为查询对象
    return this.effectDialect.sqlToQuery(this.getSQL())
  }

  /** @internal */
  // 预编译删除语句：配置了 returning 用 "all"，否则用 "run"
  _prepare(isOneTimeQuery = true): SQLiteEffectDeletePrepare<this, TEffectHKT> {
    // 按一次性/可复用选择准备方法，附带查询元数据
    return this.effectSession[isOneTimeQuery ? "prepareOneTimeQuery" : "prepareQuery"](
      this.effectDialect.sqlToQuery(this.getSQL()),
      this.config.returning,
      this.config.returning ? "all" : "run",
      undefined,
      {
        type: "delete",
        tables: extractUsedTable(this.config.table),
      },
    ) as SQLiteEffectDeletePrepare<this, TEffectHKT>
  }

  // 对外的 prepare：以可复用方式预编译
  prepare(): SQLiteEffectDeletePrepare<this, TEffectHKT> {
    // isOneTimeQuery 传 false
    return this._prepare(false)
  }

  // run：以 "run" 方式执行删除
  run: ReturnType<this["prepare"]>["run"] = (placeholderValues) => {
    // 即时预编译并执行
    return this._prepare().run(placeholderValues)
  }

  // all：取全部返回行（需 returning）
  all: ReturnType<this["prepare"]>["all"] = (placeholderValues) => {
    // 即时预编译并执行
    return this._prepare().all(placeholderValues)
  }

  // get：取单条返回行（需 returning）
  get: ReturnType<this["prepare"]>["get"] = (placeholderValues) => {
    // 即时预编译并执行
    return this._prepare().get(placeholderValues)
  }

  // values：取原始行数据（需 returning）
  values: ReturnType<this["prepare"]>["values"] = (placeholderValues) => {
    // 即时预编译并执行
    return this._prepare().values(placeholderValues)
  }

  // execute：默认执行（run 或 all 语义取决于是否 returning）
  execute: ReturnType<this["prepare"]>["execute"] = (placeholderValues) => {
    // 即时预编译并执行
    return this._prepare().execute(placeholderValues)
  }

  // $dynamic：切换到动态模式，解除方法调用限制
  $dynamic(): SQLiteEffectDeleteDynamic<this> {
    // 类型层面转换即可
    return this as any
  }
}

// 为删除对象混入 Effect 包装能力
applyEffectWrapper(SQLiteEffectDeleteBase)
