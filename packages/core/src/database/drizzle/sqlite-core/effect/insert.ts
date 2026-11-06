/* oxlint-disable */
// 仅导入类型：Effect（效果类型）
import type * as Effect from "effect/Effect"
// 导入 applyEffectWrapper（混入 Effect 能力）与 QueryEffectHKTBase（查询效果 HKT 基接口）
import { applyEffectWrapper, type QueryEffectHKTBase } from "drizzle-orm/effect-core/query-effect"
// 导入 entityKind 与 is：实体类型标识与运行时类型判断
import { entityKind, is } from "drizzle-orm/entity"
// 仅导入类型：SelectResultFields（把选中字段映射为结果字段类型）
import type { SelectResultFields } from "drizzle-orm/query-builders/select.types"
// 仅导入类型：TypedQueryBuilder（带类型的查询构建器）
import type { TypedQueryBuilder } from "drizzle-orm/query-builders/query-builder"
// 仅导入类型：RunnableQuery（可运行查询接口）
import type { RunnableQuery } from "drizzle-orm/runnable-query"
// 仅导入类型：Query（查询对象）与 SQLWrapper
import type { Query, SQLWrapper } from "drizzle-orm/sql/sql"
// 导入 SQL 与 sql：SQL 片段实体与标签模板
import { SQL, sql } from "drizzle-orm/sql/sql"
// 仅导入类型：SQLiteDialect（SQLite 方言）
import type { SQLiteDialect } from "drizzle-orm/sqlite-core/dialect"
// 仅导入类型：IndexColumn（可作索引/主键的列类型）
import type { IndexColumn } from "drizzle-orm/sqlite-core/indexes"
// 仅导入类型：插入配置、插入字段选择、单条插入值
import type {
  SQLiteInsertConfig,
  SQLiteInsertSelection,
  SQLiteInsertValue,
} from "drizzle-orm/sqlite-core/query-builders/insert"
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
// 导入类型与工具：DrizzleTypeError（语义错误提示类型）、haveSameKeys（键集合是否一致）
import { type DrizzleTypeError, haveSameKeys } from "drizzle-orm/utils"
// 仅导入类型：SQLiteColumn（SQLite 列）
import type { SQLiteColumn } from "drizzle-orm/sqlite-core/columns/common"
// 导入 QueryBuilder：轻量查询构建器（用于 insert ... select）
import { QueryBuilder } from "drizzle-orm/sqlite-core/query-builders/query-builder"
// 仅导入类型：SQLiteUpdateSetSource（更新 SET 值来源）
import type { SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core/query-builders/update"
// 导入内部工具：运行时列映射、SET 值映射、字段排序展平
import { getTableColumnsRuntime, mapUpdateSet, orderSelectedFields } from "../../internal/drizzle-utils.js"
// 仅导入类型：预编译查询与会话
import type { SQLiteEffectPreparedQuery, SQLiteEffectSession } from "./session.js"

// 从插入类型中排除已调用过的方法（非动态模式下防止重复调用同一方法）
export type SQLiteEffectInsertWithout<
  T extends AnySQLiteEffectInsert,
  TDynamic extends boolean,
  K extends keyof T & string,
> = TDynamic extends true
  ? T
  : Omit<
      SQLiteEffectInsertBase<
        T["_"]["table"],
        T["_"]["runResult"],
        T["_"]["returning"],
        TDynamic,
        T["_"]["excludedMethods"] | K,
        T["_"]["effectHKT"]
      >,
      T["_"]["excludedMethods"] | K
    >

// returning(指定字段) 之后的插入类型：结果类型变为所选字段，且不允许再次调用 returning
export type SQLiteEffectInsertReturning<
  T extends AnySQLiteEffectInsert,
  TDynamic extends boolean,
  TSelectedFields extends SelectedFieldsFlat,
> = SQLiteEffectInsertWithout<
  SQLiteEffectInsertBase<
    T["_"]["table"],
    T["_"]["runResult"],
    SelectResultFields<TSelectedFields>,
    TDynamic,
    T["_"]["excludedMethods"],
    T["_"]["effectHKT"]
  >,
  TDynamic,
  "returning"
>

// returning()（无参，返回全部列）之后的插入类型
export type SQLiteEffectInsertReturningAll<
  T extends AnySQLiteEffectInsert,
  TDynamic extends boolean,
> = SQLiteEffectInsertWithout<
  SQLiteEffectInsertBase<
    T["_"]["table"],
    T["_"]["runResult"],
    T["_"]["table"]["$inferSelect"],
    TDynamic,
    T["_"]["excludedMethods"],
    T["_"]["effectHKT"]
  >,
  TDynamic,
  "returning"
>

// 动态模式类型：解除方法排除限制，允许重复/任意顺序调用方法
export type SQLiteEffectInsertDynamic<T extends AnySQLiteEffectInsert> = SQLiteEffectInsert<
  T["_"]["table"],
  T["_"]["runResult"],
  T["_"]["returning"],
  T["_"]["effectHKT"]
>

// onConflictDoUpdate 的配置类型：冲突目标列、可选的目标/设置侧过滤条件（where 已废弃）与要更新的值
export type SQLiteEffectInsertOnConflictDoUpdateConfig<T extends AnySQLiteEffectInsert> = {
  target: IndexColumn | IndexColumn[]
  /** @deprecated - use either `targetWhere` or `setWhere` */
  where?: SQL
  targetWhere?: SQL
  setWhere?: SQL
  set: SQLiteUpdateSetSource<T["_"]["table"]>
}

// 插入的执行结果类型：未调用 returning 时为运行结果，调用后为返回行数组
export type SQLiteEffectInsertExecute<T extends AnySQLiteEffectInsert> = T["_"]["returning"] extends undefined
  ? T["_"]["runResult"]
  : T["_"]["returning"][]

// 插入的预编译结果类型：未用 returning 时 all/get/values 会给出语义错误类型提示
export type SQLiteEffectInsertPrepare<
  T extends AnySQLiteEffectInsert,
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
    execute: SQLiteEffectInsertExecute<T>
  },
  TEffectHKT
>

// 完整插入类型（动态模式：TDynamic 为 true，无排除方法）
export type SQLiteEffectInsert<
  TTable extends SQLiteTable = SQLiteTable,
  TRunResult = unknown,
  TReturning = any,
  TEffectHKT extends QueryEffectHKTBase = QueryEffectHKTBase,
> = SQLiteEffectInsertBase<TTable, TRunResult, TReturning, true, never, TEffectHKT>

// 任意泛型参数的插入类型
export type AnySQLiteEffectInsert = SQLiteEffectInsertBase<any, any, any, any, any, any>

// 插入构建器：insert(table) 与 .values()/.select() 之间的中间对象
export class SQLiteEffectInsertBuilder<
  in out TTable extends SQLiteTable,
  out TRunResult,
  out TEffectHKT extends QueryEffectHKTBase = QueryEffectHKTBase,
> {
  // 实体类型标记
  static readonly [entityKind]: string = "SQLiteEffectInsertBuilder"

  // 构造：保存目标表、会话、方言及可选的 WITH 子查询列表
  constructor(
    protected table: TTable,
    protected session: SQLiteEffectSession<TEffectHKT, TRunResult, any>,
    protected dialect: SQLiteDialect,
    private withList?: Subquery[],
  ) {}

  // values 重载：单条插入
  values(
    value: SQLiteInsertValue<TTable>,
  ): SQLiteEffectInsertBase<TTable, TRunResult, undefined, false, never, TEffectHKT>
  // values 重载：批量插入
  values(
    values: SQLiteInsertValue<TTable>[],
  ): SQLiteEffectInsertBase<TTable, TRunResult, undefined, false, never, TEffectHKT>
  // values 实现：规范化为数组并创建插入对象
  values(
    values: SQLiteInsertValue<TTable> | SQLiteInsertValue<TTable>[],
  ): SQLiteEffectInsertBase<TTable, TRunResult, undefined, false, never, TEffectHKT> {
    // 单条值包装为数组，统一处理
    values = Array.isArray(values) ? values : [values]
    // 空数组没有可插入内容，直接报错
    if (values.length === 0) {
      throw new Error("values() must be called with at least one value")
    }
    // 创建插入对象（select 标记为 false）
    return new SQLiteEffectInsertBase(this.table, values, this.session, this.dialect, this.withList)
  }

  // select 重载：以回调构造子查询插入
  select(
    selectQuery: (qb: QueryBuilder) => TypedQueryBuilder<SQLiteInsertSelection<TTable>>,
  ): SQLiteEffectInsertBase<TTable, TRunResult, undefined, false, never, TEffectHKT>
  // select 重载：以回调返回 SQL 插入
  select(
    selectQuery: (qb: QueryBuilder) => SQL,
  ): SQLiteEffectInsertBase<TTable, TRunResult, undefined, false, never, TEffectHKT>
  // select 重载：直接传 SQL 插入
  select(selectQuery: SQL): SQLiteEffectInsertBase<TTable, TRunResult, undefined, false, never, TEffectHKT>
  // select 重载：直接传查询构建器插入
  select(
    selectQuery: TypedQueryBuilder<SQLiteInsertSelection<TTable>>,
  ): SQLiteEffectInsertBase<TTable, TRunResult, undefined, false, never, TEffectHKT>
  // select 实现：INSERT INTO ... SELECT
  select(
    selectQuery:
      | SQL
      | TypedQueryBuilder<SQLiteInsertSelection<TTable>>
      | ((qb: QueryBuilder) => TypedQueryBuilder<SQLiteInsertSelection<TTable>> | SQL),
  ): SQLiteEffectInsertBase<TTable, TRunResult, undefined, false, never, TEffectHKT> {
    // 回调形式用新的 QueryBuilder 执行得到实际查询
    const select = typeof selectQuery === "function" ? selectQuery(new QueryBuilder()) : selectQuery

    // 非裸 SQL 时校验：子查询选中字段的键必须与目标表列完全一致（同序同集）
    if (!is(select, SQL) && !haveSameKeys(getTableColumnsRuntime(this.table), select._.selectedFields)) {
      // 不一致则报错，避免列错位插入
      throw new Error(
        "Insert select error: selected fields are not the same or are in a different order compared to the table definition",
      )
    }

    // 创建插入对象并标记为 select 来源
    return new SQLiteEffectInsertBase(this.table, select, this.session, this.dialect, this.withList, true)
  }
}

// 插入对象接口：同时是 SQLWrapper、可运行查询与 Effect
export interface SQLiteEffectInsertBase<
  in out TTable extends SQLiteTable,
  out TRunResult,
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
  // 幻影类型字段：记录方言、表、结果形态等类型信息
  readonly _: {
    readonly dialect: "sqlite"
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

// 插入对象实现：持有插入配置，提供 returning/冲突处理/预编译/执行
export class SQLiteEffectInsertBase<
    in out TTable extends SQLiteTable,
    out TRunResult,
    out TReturning = undefined,
    out TDynamic extends boolean = false,
    _TExcludedMethods extends string = never,
    out TEffectHKT extends QueryEffectHKTBase = QueryEffectHKTBase,
  >
  implements RunnableQuery<TReturning extends undefined ? TRunResult : TReturning[], "sqlite">, SQLWrapper
{
  // 实体类型标记
  static readonly [entityKind]: string = "SQLiteEffectInsert"

  /** @internal */
  // 插入配置：表、值/子查询、WITH 列表、是否 select 来源、returning 字段、冲突处理
  config: SQLiteInsertConfig<TTable>

  // 构造：组装配置对象；select 标记来源类型
  constructor(
    table: TTable,
    values: SQLiteInsertConfig["values"],
    private effectSession: SQLiteEffectSession<TEffectHKT, TRunResult, any>,
    private effectDialect: SQLiteDialect,
    withList?: Subquery[],
    select?: boolean,
  ) {
    // 写入内部配置
    this.config = { table, values: values as any, withList, select }
  }

  // returning 重载：无参返回全部列
  returning(): SQLiteEffectInsertReturningAll<this, TDynamic>
  // returning 重载：指定返回字段
  returning<TSelectedFields extends SelectedFieldsFlat>(
    fields: TSelectedFields,
  ): SQLiteEffectInsertReturning<this, TDynamic, TSelectedFields>
  // returning 实现：把返回字段展平排序后写入配置
  returning(
    fields: SelectedFieldsFlat = getTableColumnsRuntime(this.config.table),
  ): SQLiteEffectInsertWithout<AnySQLiteEffectInsert, TDynamic, "returning"> {
    // 默认取表全部列；记录到 returning 配置
    this.config.returning = orderSelectedFields<SQLiteColumn>(fields)
    // 返回自身（类型层面已排除再次调用 returning）
    return this as any
  }

  // 冲突时跳过插入（ON CONFLICT DO NOTHING）
  onConflictDoNothing(config: { target?: IndexColumn | IndexColumn[]; where?: SQL } = {}): this {
    // 初始化冲突处理列表
    if (!this.config.onConflict) this.config.onConflict = []

    // 未指定目标列：生成不限定目标的 DO NOTHING
    if (config.target === undefined) {
      this.config.onConflict.push(sql` on conflict do nothing`)
      // 返回自身支持链式调用
      return this
    }

    // 目标列（单列或数组）编译为目标 SQL
    const targetSql = Array.isArray(config.target) ? sql`${config.target}` : sql`${[config.target]}`
    // 可选的冲突过滤条件
    const whereSql = config.where ? sql` where ${config.where}` : sql``
    // 追加完整的 ON CONFLICT 子句
    this.config.onConflict.push(sql` on conflict ${targetSql} do nothing${whereSql}`)
    // 返回自身
    return this
  }

  // 冲突时更新（ON CONFLICT DO UPDATE）
  onConflictDoUpdate(config: SQLiteEffectInsertOnConflictDoUpdateConfig<this>): this {
    // 已废弃的 where 与新的 targetWhere/setWhere 不能混用
    if (config.where && (config.targetWhere || config.setWhere)) {
      // 违反则报错并提示迁移
      throw new Error(
        'You cannot use both "where" and "targetWhere"/"setWhere" at the same time - "where" is deprecated, use "targetWhere" or "setWhere" instead.',
      )
    }

    // 初始化冲突处理列表
    if (!this.config.onConflict) this.config.onConflict = []

    // 整体 where（已废弃形式）
    const whereSql = config.where ? sql` where ${config.where}` : undefined
    // 目标侧过滤（索引记录上的条件）
    const targetWhereSql = config.targetWhere ? sql` where ${config.targetWhere}` : undefined
    // 更新侧过滤（更新后的行上的条件）
    const setWhereSql = config.setWhere ? sql` where ${config.setWhere}` : undefined
    // 冲突目标列 SQL
    const targetSql = Array.isArray(config.target) ? sql`${config.target}` : sql`${[config.target]}`
    // 把 set 值映射为驱动参数后交给方言构建 "col = excluded.col" 形式的更新集
    const setSql = this.effectDialect.buildUpdateSet(
      this.config.table,
      mapUpdateSet(this.config.table, config.set as SQLiteUpdateSetSource<TTable>),
    )
    // 追加完整的 ON CONFLICT DO UPDATE 子句
    this.config.onConflict.push(
      sql` on conflict ${targetSql}${targetWhereSql} do update set ${setSql}${whereSql}${setWhereSql}`,
    )
    // 返回自身
    return this
  }

  /** @internal */
  // 生成插入语句的 SQL 片段（内部使用）
  getSQL(): SQL {
    // 委托给方言构建 insert 查询
    return this.effectDialect.buildInsertQuery(this.config)
  }

  // 导出编译后的查询（sql 与参数），便于调试
  toSQL(): Query {
    // 用方言把 SQL 编译为 { sql, params }
    return this.effectDialect.sqlToQuery(this.getSQL())
  }

  /** @internal */
  // 预编译插入语句：配置了 returning 用 "all"，否则用 "run"
  _prepare(isOneTimeQuery = true): SQLiteEffectInsertPrepare<this, TEffectHKT> {
    // 按一次性/可复用选择准备方法，并附带查询元数据（类型与涉及表）
    return this.effectSession[isOneTimeQuery ? "prepareOneTimeQuery" : "prepareQuery"](
      this.effectDialect.sqlToQuery(this.getSQL()),
      this.config.returning,
      this.config.returning ? "all" : "run",
      undefined,
      {
        type: "insert",
        tables: extractUsedTable(this.config.table),
      },
    ) as SQLiteEffectInsertPrepare<this, TEffectHKT>
  }

  // 对外的 prepare：以可复用方式预编译
  prepare(): SQLiteEffectInsertPrepare<this, TEffectHKT> {
    // isOneTimeQuery 传 false
    return this._prepare(false)
  }

  // run：以 "run" 方式执行插入
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
  $dynamic(): SQLiteEffectInsertDynamic<this> {
    // 类型层面转换即可
    return this as any
  }
}

// 为插入对象混入 Effect 包装能力
applyEffectWrapper(SQLiteEffectInsertBase)
