/* oxlint-disable */
// 仅导入类型：Effect（效果类型）
import type * as Effect from "effect/Effect"
// 仅导入类型：CacheConfig（查询缓存配置）
import type { CacheConfig } from "drizzle-orm/cache/core/types"
// 导入 applyEffectWrapper（混入 Effect 能力）与 QueryEffectHKTBase（查询效果 HKT 基接口）
import { applyEffectWrapper, type QueryEffectHKTBase } from "drizzle-orm/effect-core/query-effect"
// 导入 entityKind 与 is：实体类型标识与运行时类型判断
import { entityKind, is } from "drizzle-orm/entity"
// 仅导入类型：查询构建的核心类型（子查询选择、表名/字段提取、连接可空性、选择模式、结果类型）
import type {
  BuildSubquerySelection,
  GetSelectTableName,
  GetSelectTableSelection,
  JoinNullability,
  SelectMode,
  SelectResult,
} from "drizzle-orm/query-builders/select.types"
// 导入 SQL（SQL 片段实体）
import { SQL } from "drizzle-orm/sql/sql"
// 仅导入类型：ColumnsSelection（列选择）与 SQLWrapper
import type { ColumnsSelection, SQLWrapper } from "drizzle-orm/sql/sql"
// 仅导入类型：SQLiteColumn（SQLite 列）
import type { SQLiteColumn } from "drizzle-orm/sqlite-core/columns"
// 仅导入类型：SQLiteDialect（SQLite 方言）
import type { SQLiteDialect } from "drizzle-orm/sqlite-core/dialect"
// 导入 SQLiteSelectBase：官方 select 查询基类（承载 where/join/limit 等链式方法）
import { SQLiteSelectBase } from "drizzle-orm/sqlite-core/query-builders/select"
// 仅导入类型：select 构建模式、字段集合、SQLite 查询配置与 HKT 基接口
import type {
  CreateSQLiteSelectFromBuilderMode,
  SelectedFields,
  SQLiteSelectConfig,
  SQLiteSelectHKTBase,
} from "drizzle-orm/sqlite-core/query-builders/select.types"
// 仅导入类型：SQLiteTable（SQLite 表）
import type { SQLiteTable } from "drizzle-orm/sqlite-core/table"
// 导入 SQLiteViewBase（SQLite 视图基类）
import { SQLiteViewBase } from "drizzle-orm/sqlite-core/view-base"
// 导入 Subquery（子查询实体）
import { Subquery } from "drizzle-orm/subquery"
// 导入类型与工具：Assume（类型断言工具）、getTableColumns（取表的列映射）
import { type Assume, getTableColumns } from "drizzle-orm/utils"
// 导入内部工具：读取视图字段（运行时）与字段排序展平
import { getViewSelectedFieldsRuntime, orderSelectedFields } from "../../internal/drizzle-utils.js"
// 仅导入类型：预编译查询与会话
import type { SQLiteEffectPreparedQuery, SQLiteEffectSession } from "./session.js"

// select 查询预编译结果的类型：按 run/all/get/values/execute 各自的结果形态实例化
export type SQLiteEffectSelectPrepare<
  T extends AnySQLiteEffectSelect,
  TEffectHKT extends QueryEffectHKTBase = QueryEffectHKTBase,
> = SQLiteEffectPreparedQuery<
  {
    type: "async"
    run: T["_"]["runResult"]
    all: T["_"]["result"]
    get: T["_"]["result"][number] | undefined
    values: any[][]
    execute: T["_"]["result"]
  },
  TEffectHKT
>

// Explicit variance prevents comparisons from recursively scanning Drizzle's conditional select types.
// select 构建器：select() 与 .from(source) 之间的中间对象；显式 out 型变注解避免类型比较时递归展开
export class SQLiteEffectSelectBuilder<
  out TSelection extends SelectedFields | undefined,
  out TRunResult,
  out TEffectHKT extends QueryEffectHKTBase = QueryEffectHKTBase,
  out TBuilderMode extends "db" | "qb" = "db",
> {
  // 实体类型标记
  static readonly [entityKind]: string = "SQLiteEffectSelectBuilder"

  // 保存选中的字段集合（undefined 表示全字段选择）
  private fields: TSelection
  // 会话：查询构建器模式（qb）下可能没有会话
  private session: SQLiteEffectSession<TEffectHKT, TRunResult, any> | undefined
  // 方言实例
  private dialect: SQLiteDialect
  // WITH 子查询列表（可选）
  private withList: Subquery[] | undefined
  // 是否去重（可选）
  private distinct: boolean | undefined

  // 构造：接收字段、会话、方言及可选的 withList/distinct
  constructor(config: {
    fields: TSelection
    session: SQLiteEffectSession<TEffectHKT, TRunResult, any> | undefined
    dialect: SQLiteDialect
    withList?: Subquery[]
    distinct?: boolean
  }) {
    // 逐一保存配置项
    this.fields = config.fields
    this.session = config.session
    this.dialect = config.dialect
    this.withList = config.withList
    this.distinct = config.distinct
  }

  // from：指定查询来源（表/子查询/视图/SQL），推导出结果 select 对象的完整类型
  from<TFrom extends SQLiteTable | Subquery | SQLiteViewBase | SQL>(
    source: TFrom,
  ): TBuilderMode extends "db"
    ? SQLiteEffectSelectBase<
        GetSelectTableName<TFrom>,
        TRunResult,
        TSelection extends undefined ? GetSelectTableSelection<TFrom> : TSelection,
        TSelection extends undefined ? "single" : "partial",
        GetSelectTableName<TFrom> extends string ? Record<GetSelectTableName<TFrom>, "not-null"> : {},
        false,
        never,
        SelectResult<
          TSelection extends undefined ? GetSelectTableSelection<TFrom> : TSelection,
          TSelection extends undefined ? "single" : "partial",
          GetSelectTableName<TFrom> extends string ? Record<GetSelectTableName<TFrom>, "not-null"> : {}
        >[],
        BuildSubquerySelection<
          TSelection extends undefined ? GetSelectTableSelection<TFrom> : TSelection,
          GetSelectTableName<TFrom> extends string ? Record<GetSelectTableName<TFrom>, "not-null"> : {}
        >,
        TEffectHKT
      >
    : CreateSQLiteSelectFromBuilderMode<
        TBuilderMode,
        SQLiteEffectSelectHKT<TEffectHKT>,
        GetSelectTableName<TFrom>,
        TRunResult,
        TSelection extends undefined ? GetSelectTableSelection<TFrom> : TSelection,
        TSelection extends undefined ? "single" : "partial"
      > {
    // 是否为部分选择：调用 select({...}) 指定过字段即为部分选择
    const isPartialSelect = !!this.fields

    // 解析最终的字段集合
    let fields: SelectedFields
    // 显式指定过字段：直接使用
    if (this.fields) {
      fields = this.fields
    } else if (is(source, Subquery)) {
      // 来源是子查询：按其选中字段逐个取出实际字段
      fields = Object.fromEntries(
        Object.keys(source._.selectedFields).map((key) => [
          key,
          source[key as unknown as keyof typeof source] as unknown as SelectedFields[string],
        ]),
      )
    } else if (is(source, SQLiteViewBase)) {
      // 来源是视图：从视图运行时配置取选中字段
      fields = getViewSelectedFieldsRuntime(source).selectedFields as SelectedFields
    } else if (is(source, SQL)) {
      // 来源是裸 SQL：没有字段映射，给空对象
      fields = {}
    } else {
      // 来源是表：取表全部列
      fields = getTableColumns<SQLiteTable>(source)
    }

    // 组装真正的 select 查询对象
    return new SQLiteEffectSelectBase({
      table: source,
      fields,
      isPartialSelect,
      session: this.session as any,
      dialect: this.dialect,
      withList: this.withList,
      distinct: this.distinct,
    }) as any
  }
}

// select 查询的 HKT（高阶类型）：把占位类型槽位实例化为 Effect 版 select 基类
export interface SQLiteEffectSelectHKT<TEffectHKT extends QueryEffectHKTBase = QueryEffectHKTBase>
  extends SQLiteSelectHKTBase {
  _type: SQLiteEffectSelectBase<
    this["tableName"],
    this["runResult"],
    Assume<this["selection"], ColumnsSelection>,
    this["selectMode"],
    Assume<this["nullabilityMap"], Record<string, JoinNullability>>,
    this["dynamic"],
    this["excludedMethods"],
    Assume<this["result"], any[]>,
    Assume<this["selectedFields"], ColumnsSelection>,
    TEffectHKT
  >
}

// Effect 版 select 查询接口：继承官方 select 基类，并叠加 Effect 能力
export interface SQLiteEffectSelectBase<
  out TTableName extends string | undefined,
  out TRunResult,
  out TSelection extends ColumnsSelection,
  out TSelectMode extends SelectMode = "single",
  out TNullabilityMap extends Record<string, JoinNullability> = TTableName extends string
    ? Record<TTableName, "not-null">
    : {},
  out TDynamic extends boolean = false,
  TExcludedMethods extends string = never,
  out TResult extends any[] = SelectResult<TSelection, TSelectMode, TNullabilityMap>[],
  out TSelectedFields extends ColumnsSelection = BuildSubquerySelection<TSelection, TNullabilityMap>,
  out TEffectHKT extends QueryEffectHKTBase = QueryEffectHKTBase,
> extends SQLiteSelectBase<
      SQLiteEffectSelectHKT<TEffectHKT>,
      TTableName,
      TRunResult,
      TSelection,
      TSelectMode,
      TNullabilityMap,
      TDynamic,
      TExcludedMethods,
      TResult,
      TSelectedFields
    >,
    Effect.Effect<TResult, TEffectHKT["error"], TEffectHKT["context"]> {}

// Effect 版 select 查询实现：在官方基类之上提供预编译与各执行方法
export class SQLiteEffectSelectBase<
    out TTableName extends string | undefined,
    out TRunResult,
    out TSelection extends ColumnsSelection,
    out TSelectMode extends SelectMode = "single",
    out TNullabilityMap extends Record<string, JoinNullability> = TTableName extends string
      ? Record<TTableName, "not-null">
      : {},
    out TDynamic extends boolean = false,
    TExcludedMethods extends string = never,
    out TResult extends any[] = SelectResult<TSelection, TSelectMode, TNullabilityMap>[],
    out TSelectedFields extends ColumnsSelection = BuildSubquerySelection<TSelection, TNullabilityMap>,
    out TEffectHKT extends QueryEffectHKTBase = QueryEffectHKTBase,
  >
  extends SQLiteSelectBase<
    SQLiteEffectSelectHKT<TEffectHKT>,
    TTableName,
    TRunResult,
    TSelection,
    TSelectMode,
    TNullabilityMap,
    TDynamic,
    TExcludedMethods,
    TResult,
    TSelectedFields
  >
  implements SQLWrapper
{
  // 实体类型标记
  static override readonly [entityKind]: string = "SQLiteEffectSelect"

  // 便捷读取内部查询配置（config 在基类中为内部属性）
  private get effectConfig() {
    // 断言后访问 config
    return (this as unknown as { config: SQLiteSelectConfig }).config
  }

  /** @internal */
  // 生成 select 语句的 SQL 片段（内部使用）
  override getSQL(): SQL {
    // 委托给方言构建 select 查询
    return this.dialect.buildSelectQuery(this.effectConfig)
  }

  /** @internal */
  // 预编译 select 查询：编译 SQL、展平字段并绑定会话的准备方法
  _prepare(isOneTimeQuery = true): SQLiteEffectSelectPrepare<this, TEffectHKT> {
    // 查询构建器模式（无会话）不能执行，直接报错提示改用数据库实例
    if (!this.session) {
      throw new Error("Cannot execute a query on a query builder. Please use a database instance instead.")
    }
    // 取得会话引用
    const session = this.session as unknown as SQLiteEffectSession<TEffectHKT, TRunResult, any>
    // 按一次性/可复用选择准备方法：传入编译后的 SQL、排序展平的字段、"all" 执行方式、
    // 查询元数据（类型与涉及表）与缓存配置
    const query = session[isOneTimeQuery ? "prepareOneTimeQuery" : "prepareQuery"](
      this.dialect.sqlToQuery(this.getSQL()),
      orderSelectedFields<SQLiteColumn>(this.effectConfig.fields),
      "all",
      undefined,
      {
        type: "select",
        tables: [...this.usedTables],
      },
      this.cacheConfig,
    )
    // 把查询对象上的连接可空性映射传递给预编译查询
    query.joinsNotNullableMap = this.joinsNotNullableMap
    // 返回预编译查询
    return query as ReturnType<this["prepare"]>
  }

  // 配置查询缓存：undefined 为默认启用，false 关闭缓存，其余合并进缓存配置
  override $withCache(config?: { config?: CacheConfig; tag?: string; autoInvalidate?: boolean } | false) {
    // 依据输入组合出缓存配置写入 cacheConfig
    this.cacheConfig =
      config === undefined
        ? { config: {}, enabled: true, autoInvalidate: true }
        : config === false
          ? { enabled: false }
          : { enabled: true, autoInvalidate: true, ...config }
    // 返回自身以支持链式调用
    return this
  }

  // 对外的 prepare：以可复用方式预编译
  prepare(): SQLiteEffectSelectPrepare<this, TEffectHKT> {
    // isOneTimeQuery 传 false
    return this._prepare(false)
  }

  // run：以 "run" 方式执行（写语义），结果为运行结果
  run: ReturnType<this["prepare"]>["run"] = (placeholderValues) => {
    // 每次调用即时预编译并执行
    return this._prepare().run(placeholderValues)
  }

  // all：取全部行
  all: ReturnType<this["prepare"]>["all"] = (placeholderValues) => {
    // 即时预编译并执行
    return this._prepare().all(placeholderValues)
  }

  // get：取单行
  get: ReturnType<this["prepare"]>["get"] = (placeholderValues) => {
    // 即时预编译并执行
    return this._prepare().get(placeholderValues)
  }

  // values：取原始行数据
  values: ReturnType<this["prepare"]>["values"] = (placeholderValues) => {
    // 即时预编译并执行
    return this._prepare().values(placeholderValues)
  }

  // execute：默认执行（all 语义并做结果映射）
  execute: ReturnType<this["prepare"]>["execute"] = (placeholderValues) => {
    // 即时预编译并执行
    return this._prepare().execute(placeholderValues)
  }
}

// 为 select 查询混入 Effect 包装能力
applyEffectWrapper(SQLiteEffectSelectBase)

// 任意泛型参数的 Effect 版 select 查询类型
export type AnySQLiteEffectSelect = SQLiteEffectSelectBase<any, any, any, any, any, any, any, any, any, any>
