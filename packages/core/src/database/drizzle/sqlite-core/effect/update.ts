/* oxlint-disable */
// 仅导入类型：Effect（效果类型）
import type * as Effect from "effect/Effect"
// 导入 applyEffectWrapper（混入 Effect 能力）与 QueryEffectHKTBase（查询效果 HKT 基接口）
import { applyEffectWrapper, type QueryEffectHKTBase } from "drizzle-orm/effect-core/query-effect"
// 导入 entityKind 与 is：实体类型标识与运行时类型判断
import { entityKind, is } from "drizzle-orm/entity"
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
// 仅导入类型：字段集合与 SQLite 连接配置
import type { SelectedFields, SQLiteSelectJoinConfig } from "drizzle-orm/sqlite-core/query-builders/select.types"
// 仅导入类型：更新配置与更新 SET 值来源
import type { SQLiteUpdateConfig, SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core/query-builders/update"
// 仅导入类型：PreparedQueryConfig（预编译查询配置）
import type { PreparedQueryConfig } from "drizzle-orm/sqlite-core/session"
// 导入 SQLiteTable（SQLite 表实体）
import { SQLiteTable } from "drizzle-orm/sqlite-core/table"
// 导入 extractUsedTable：提取查询涉及的表名集合
import { extractUsedTable } from "drizzle-orm/sqlite-core/utils"
// 导入 SQLiteViewBase（SQLite 视图基类）
import { SQLiteViewBase } from "drizzle-orm/sqlite-core/view-base"
// 导入 Subquery（子查询实体）
import { Subquery } from "drizzle-orm/subquery"
// 仅导入类型：DrizzleTypeError（语义错误提示）、UpdateSet（更新集合）、ValueOrArray（值或数组）
import { type DrizzleTypeError, type UpdateSet, type ValueOrArray } from "drizzle-orm/utils"
// 仅导入类型：SQLiteColumn（SQLite 列）
import type { SQLiteColumn } from "drizzle-orm/sqlite-core/columns/common"
// 导入内部工具：运行时列映射、表类实体命名、视图字段读取、SET 值映射、字段排序展平
import {
  getTableColumnsRuntime,
  getTableLikeName,
  getViewSelectedFieldsRuntime,
  mapUpdateSet,
  orderSelectedFields,
} from "../../internal/drizzle-utils.js"
// 仅导入类型：预编译查询与会话
import type { SQLiteEffectPreparedQuery, SQLiteEffectSession } from "./session.js"

// 从更新类型中排除已调用过的方法（非动态模式下防止重复调用）
export type SQLiteEffectUpdateWithout<
  T extends AnySQLiteEffectUpdate,
  TDynamic extends boolean,
  K extends keyof T & string,
> = TDynamic extends true
  ? T
  : Omit<
      SQLiteEffectUpdateBase<
        T["_"]["table"],
        T["_"]["runResult"],
        T["_"]["from"],
        T["_"]["returning"],
        TDynamic,
        T["_"]["excludedMethods"] | K,
        T["_"]["effectHKT"]
      >,
      T["_"]["excludedMethods"] | K
    >

// 调用 from() 之后的更新类型：允许使用各连接方法（LEFT/RIGHT/INNER/FULL JOIN）
export type SQLiteEffectUpdateWithJoins<
  T extends AnySQLiteEffectUpdate,
  TDynamic extends boolean,
  TFrom extends SQLiteTable | Subquery | SQLiteViewBase | SQL,
> = TDynamic extends true
  ? T
  : Omit<
      SQLiteEffectUpdateBase<
        T["_"]["table"],
        T["_"]["runResult"],
        TFrom,
        T["_"]["returning"],
        TDynamic,
        Exclude<T["_"]["excludedMethods"] | "from", "leftJoin" | "rightJoin" | "innerJoin" | "fullJoin">,
        T["_"]["effectHKT"]
      >,
      Exclude<T["_"]["excludedMethods"] | "from", "leftJoin" | "rightJoin" | "innerJoin" | "fullJoin">
    >

// returning()（无参，返回全部列）之后的更新类型
export type SQLiteEffectUpdateReturningAll<
  T extends AnySQLiteEffectUpdate,
  TDynamic extends boolean,
> = SQLiteEffectUpdateWithout<
  SQLiteEffectUpdateBase<
    T["_"]["table"],
    T["_"]["runResult"],
    T["_"]["from"],
    T["_"]["table"]["$inferSelect"],
    TDynamic,
    T["_"]["excludedMethods"],
    T["_"]["effectHKT"]
  >,
  TDynamic,
  "returning"
>

// returning(指定字段) 之后的更新类型：结果变为所选字段
export type SQLiteEffectUpdateReturning<
  T extends AnySQLiteEffectUpdate,
  TDynamic extends boolean,
  TSelectedFields extends SelectedFields,
> = SQLiteEffectUpdateWithout<
  SQLiteEffectUpdateBase<
    T["_"]["table"],
    T["_"]["runResult"],
    T["_"]["from"],
    SelectResultFields<TSelectedFields>,
    TDynamic,
    T["_"]["excludedMethods"],
    T["_"]["effectHKT"]
  >,
  TDynamic,
  "returning"
>

// 更新的执行结果类型：未用 returning 时为运行结果，否则为返回行数组
export type SQLiteEffectUpdateExecute<T extends AnySQLiteEffectUpdate> = T["_"]["returning"] extends undefined
  ? T["_"]["runResult"]
  : T["_"]["returning"][]

// 更新的预编译结果类型：未用 returning 时 all/get/values 给出语义错误类型提示
export type SQLiteEffectUpdatePrepare<
  T extends AnySQLiteEffectUpdate,
  TEffectHKT extends QueryEffectHKTBase = T["_"]["effectHKT"],
> = SQLiteEffectPreparedQuery<
  PreparedQueryConfig & {
    run: T["_"]["runResult"]
    all: T["_"]["returning"] extends undefined
      ? DrizzleTypeError<".all() cannot be used without .returning()">
      : T["_"]["returning"][]
    get: T["_"]["returning"] extends undefined
      ? DrizzleTypeError<".get() cannot be used without .returning()">
      : T["_"]["returning"]
    values: T["_"]["returning"] extends undefined
      ? DrizzleTypeError<".values() cannot be used without .returning()">
      : any[][]
    execute: SQLiteEffectUpdateExecute<T>
  },
  TEffectHKT
>

// 动态模式类型：解除方法排除限制
export type SQLiteEffectUpdateDynamic<T extends AnySQLiteEffectUpdate> = SQLiteEffectUpdate<
  T["_"]["table"],
  T["_"]["runResult"],
  T["_"]["from"],
  T["_"]["returning"],
  T["_"]["effectHKT"]
>

// 完整更新类型（动态模式）
export type SQLiteEffectUpdate<
  TTable extends SQLiteTable = SQLiteTable,
  TRunResult = unknown,
  TFrom extends SQLiteTable | Subquery | SQLiteViewBase | SQL | undefined = undefined,
  TReturning extends Record<string, unknown> | undefined = Record<string, unknown> | undefined,
  TEffectHKT extends QueryEffectHKTBase = QueryEffectHKTBase,
> = SQLiteEffectUpdateBase<TTable, TRunResult, TFrom, TReturning, true, never, TEffectHKT>

// 任意泛型参数的更新类型
export type AnySQLiteEffectUpdate = SQLiteEffectUpdateBase<any, any, any, any, any, any, any>

// 连接回调的类型别名：接收更新表与 from 来源的字段映射，返回连接条件
export type SQLiteEffectUpdateJoinFn<T extends AnySQLiteEffectUpdate> = <
  TJoinedTable extends SQLiteTable | Subquery | SQLiteViewBase | SQL,
>(
  table: TJoinedTable,
  on:
    | ((
        updateTable: T["_"]["table"]["_"]["columns"],
        from: T["_"]["from"] extends SQLiteTable
          ? T["_"]["from"]["_"]["columns"]
          : T["_"]["from"] extends Subquery | SQLiteViewBase
            ? T["_"]["from"]["_"]["selectedFields"]
            : never,
      ) => SQL | undefined)
    | SQL
    | undefined,
) => T

// 更新构建器：update(table) 与 .set(values) 之间的中间对象
export class SQLiteEffectUpdateBuilder<
  in out TTable extends SQLiteTable,
  out TRunResult,
  out TEffectHKT extends QueryEffectHKTBase = QueryEffectHKTBase,
> {
  // 实体类型标记
  static readonly [entityKind]: string = "SQLiteEffectUpdateBuilder"

  // 幻影类型字段：记录目标表类型
  declare readonly _: {
    readonly table: TTable
  }

  // 构造：保存目标表、会话、方言及可选的 WITH 子查询列表
  constructor(
    protected table: TTable,
    protected session: SQLiteEffectSession<TEffectHKT, TRunResult, any>,
    protected dialect: SQLiteDialect,
    private withList?: Subquery[],
  ) {}

  // set：设置要更新的列值，创建更新对象（set 值先映射为驱动参数）
  set(
    values: SQLiteUpdateSetSource<TTable>,
  ): SQLiteEffectUpdateWithout<
    SQLiteEffectUpdateBase<TTable, TRunResult, undefined, undefined, false, never, TEffectHKT>,
    false,
    "leftJoin" | "rightJoin" | "innerJoin" | "fullJoin"
  > {
    // 创建更新对象：mapUpdateSet 过滤 undefined 并把普通值包装为 Param
    return new SQLiteEffectUpdateBase(
      this.table,
      mapUpdateSet(this.table, values),
      this.session,
      this.dialect,
      this.withList,
    ) as any
  }
}

// 更新对象接口：同时是 SQLWrapper、可运行查询与 Effect
export interface SQLiteEffectUpdateBase<
  out TTable extends SQLiteTable = SQLiteTable,
  out TRunResult = unknown,
  out TFrom extends SQLiteTable | Subquery | SQLiteViewBase | SQL | undefined = undefined,
  out TReturning = undefined,
  out TDynamic extends boolean = false,
  _TExcludedMethods extends string = never,
  out TEffectHKT extends QueryEffectHKTBase = QueryEffectHKTBase,
> extends SQLWrapper,
    RunnableQuery<TReturning extends undefined ? TRunResult : TReturning[], "sqlite">,
    Effect.Effect<
      TReturning extends undefined ? TRunResult : TReturning[],
      TEffectHKT["error"],
      TEffectHKT["context"]
    > {
  // 幻影类型字段：记录方言、表、来源、结果形态等类型信息
  readonly _: {
    readonly dialect: "sqlite"
    readonly table: TTable
    readonly resultType: "async"
    readonly runResult: TRunResult
    readonly from: TFrom
    readonly returning: TReturning
    readonly dynamic: TDynamic
    readonly excludedMethods: _TExcludedMethods
    readonly result: TReturning extends undefined ? TRunResult : TReturning[]
    readonly effectHKT: TEffectHKT
  }
}

// 更新对象实现：持有更新配置，提供 from/连接/where/orderBy/limit/returning 与执行
export class SQLiteEffectUpdateBase<
    out TTable extends SQLiteTable = SQLiteTable,
    out TRunResult = unknown,
    out TFrom extends SQLiteTable | Subquery | SQLiteViewBase | SQL | undefined = undefined,
    out TReturning = undefined,
    out TDynamic extends boolean = false,
    _TExcludedMethods extends string = never,
    out TEffectHKT extends QueryEffectHKTBase = QueryEffectHKTBase,
  >
  implements RunnableQuery<TReturning extends undefined ? TRunResult : TReturning[], "sqlite">, SQLWrapper
{
  // 实体类型标记
  static readonly [entityKind]: string = "SQLiteEffectUpdate"

  /** @internal */
  // 更新配置：set 值、目标表、WITH 列表、连接列表、条件、排序、限制、返回字段、from 来源
  config: SQLiteUpdateConfig

  // 构造：把 set 值与表、会话、方言、WITH 列表写入配置（joins 初始化为空）
  constructor(
    table: TTable,
    set: UpdateSet,
    private effectSession: SQLiteEffectSession<TEffectHKT, TRunResult, any>,
    private effectDialect: SQLiteDialect,
    withList?: Subquery[],
  ) {
    // 初始化更新配置
    this.config = { set, table, withList, joins: [] }
  }

  // from：UPDATE ... FROM 来源（SQLite 支持从其他表/子查询更新）
  from<TFrom extends SQLiteTable | Subquery | SQLiteViewBase | SQL>(
    source: TFrom,
  ): SQLiteEffectUpdateWithJoins<this, TDynamic, TFrom> {
    // 写入 from 来源
    this.config.from = source
    // 返回自身（类型层面解锁连接方法）
    return this as any
  }

  // 连接工厂：生成指定类型的连接方法（供 leftJoin 等复用）
  private createJoin<TJoinType extends SQLiteSelectJoinConfig["joinType"]>(
    joinType: TJoinType,
  ): SQLiteEffectUpdateJoinFn<this> {
    // 返回实际执行的连接函数
    return ((
      table: SQLiteTable | Subquery | SQLiteViewBase | SQL,
      on: ((updateTable: TTable, from: TFrom) => SQL | undefined) | SQL | undefined,
    ) => {
      // 解析连接目标的名称（别名/表名/视图名）
      const tableName = getTableLikeName(table)

      // 同名别名已存在则报错，避免歧义
      if (typeof tableName === "string" && this.config.joins.some((join) => join.alias === tableName)) {
        throw new Error(`Alias "${tableName}" is already used in this query`)
      }

      // 连接条件为回调形式：为更新表与 from 来源分别构建字段代理后调用回调
      if (typeof on === "function") {
        // 仅在已设置 from 时提供第二个参数：按目标类型取列映射/选中字段
        const from = this.config.from
          ? is(table, SQLiteTable)
            ? getTableColumnsRuntime(table)
            : is(table, Subquery)
              ? table._.selectedFields
              : is(table, SQLiteViewBase)
                ? getViewSelectedFieldsRuntime(table).selectedFields
                : undefined
          : undefined
        // 调用回调生成连接条件：更新表与来源都包装成可直接引用字段的代理
        on = on(
          new Proxy(
            getTableColumnsRuntime(this.config.table),
            new SelectionProxyHandler({ sqlAliasedBehavior: "sql", sqlBehavior: "sql" }),
          ) as any,
          from &&
            (new Proxy(from, new SelectionProxyHandler({ sqlAliasedBehavior: "sql", sqlBehavior: "sql" })) as any),
        )
      }

      // 把连接（条件、目标、类型、别名）加入配置
      this.config.joins.push({ on, table, joinType, alias: tableName })

      // 返回自身支持链式调用
      return this as any
    }) as any
  }

  // 左连接方法
  leftJoin = this.createJoin("left")

  // 右连接方法
  rightJoin = this.createJoin("right")

  // 内连接方法
  innerJoin = this.createJoin("inner")

  // 全连接方法
  fullJoin = this.createJoin("full")

  // where：设置更新过滤条件
  where(where: SQL | undefined): SQLiteEffectUpdateWithout<this, TDynamic, "where"> {
    // 写入过滤条件
    this.config.where = where
    // 返回自身
    return this as any
  }

  // orderBy 重载：以回调指定排序
  orderBy(
    builder: (updateTable: TTable) => ValueOrArray<SQLiteColumn | SQL | SQL.Aliased>,
  ): SQLiteEffectUpdateWithout<this, TDynamic, "orderBy">
  // orderBy 重载：直接传入列/SQL/别名
  orderBy(...columns: (SQLiteColumn | SQL | SQL.Aliased)[]): SQLiteEffectUpdateWithout<this, TDynamic, "orderBy">
  // orderBy 实现：支持回调与直接传参两种形式
  orderBy(
    ...columns:
      | [(updateTable: TTable) => ValueOrArray<SQLiteColumn | SQL | SQL.Aliased>]
      | (SQLiteColumn | SQL | SQL.Aliased)[]
  ): SQLiteEffectUpdateWithout<this, TDynamic, "orderBy"> {
    // 回调形式：用列代理调用回调取得排序项
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

  // limit：限制更新行数（SQLite 支持 UPDATE ... LIMIT）
  limit(limit: number | Placeholder): SQLiteEffectUpdateWithout<this, TDynamic, "limit"> {
    // 写入限制行数
    this.config.limit = limit
    // 返回自身
    return this as any
  }

  // returning 重载：无参返回全部列
  returning(): SQLiteEffectUpdateReturningAll<this, TDynamic>
  // returning 重载：指定返回字段
  returning<TSelectedFields extends SelectedFields>(
    fields: TSelectedFields,
  ): SQLiteEffectUpdateReturning<this, TDynamic, TSelectedFields>
  // returning 实现：展平排序后写入配置
  returning(
    fields: SelectedFields = getTableColumnsRuntime(this.config.table),
  ): SQLiteEffectUpdateWithout<AnySQLiteEffectUpdate, TDynamic, "returning"> {
    // 默认取表全部列；记录到 returning 配置
    this.config.returning = orderSelectedFields<SQLiteColumn>(fields)
    // 返回自身
    return this as any
  }

  /** @internal */
  // 生成更新语句的 SQL 片段（内部使用）
  getSQL(): SQL {
    // 委托给方言构建 update 查询
    return this.effectDialect.buildUpdateQuery(this.config)
  }

  // 导出编译后的查询（sql 与参数）
  toSQL(): Query {
    // 用方言把 SQL 编译为查询对象
    return this.effectDialect.sqlToQuery(this.getSQL())
  }

  /** @internal */
  // 预编译更新语句：配置了 returning 用 "all"，否则用 "run"
  _prepare(isOneTimeQuery = true): SQLiteEffectUpdatePrepare<this, TEffectHKT> {
    // 按一次性/可复用选择准备方法，附带查询元数据
    return this.effectSession[isOneTimeQuery ? "prepareOneTimeQuery" : "prepareQuery"](
      this.effectDialect.sqlToQuery(this.getSQL()),
      this.config.returning,
      this.config.returning ? "all" : "run",
      undefined,
      {
        type: "update",
        tables: extractUsedTable(this.config.table),
      },
    ) as SQLiteEffectUpdatePrepare<this, TEffectHKT>
  }

  // 对外的 prepare：以可复用方式预编译
  prepare(): SQLiteEffectUpdatePrepare<this, TEffectHKT> {
    // isOneTimeQuery 传 false
    return this._prepare(false)
  }

  // run：以 "run" 方式执行更新
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
  $dynamic(): SQLiteEffectUpdateDynamic<this> {
    // 类型层面转换即可
    return this as any
  }
}

// 为更新对象混入 Effect 包装能力
applyEffectWrapper(SQLiteEffectUpdateBase)
