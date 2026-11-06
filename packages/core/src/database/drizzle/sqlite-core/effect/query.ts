/* oxlint-disable */
// 仅导入类型：Effect（效果类型）
import type * as Effect from "effect/Effect"
// 导入 applyEffectWrapper（混入 Effect 能力）与 QueryEffectHKTBase（查询效果 HKT 基接口）
import { applyEffectWrapper, type QueryEffectHKTBase } from "drizzle-orm/effect-core/query-effect"
// 导入 entityKind：drizzle 实体类型标识符号
import { entityKind } from "drizzle-orm/entity"
// 导入关系查询的核心类型与工具：构建结果、关系构建结果、查询配置、默认映射器、表关系配置
import {
  type BuildQueryResult,
  type BuildRelationalQueryResult,
  type DBQueryConfig,
  makeDefaultRqbMapper,
  type TableRelationalConfig,
  type TablesRelationalConfig,
} from "drizzle-orm/relations"
// 仅导入类型：RunnableQuery（可运行查询接口）
import type { RunnableQuery } from "drizzle-orm/runnable-query"
// 导入类型与工具：Query（查询对象）、SQL（SQL 片段）、sql 模板、SQLWrapper
import { type Query, type SQL, sql, type SQLWrapper } from "drizzle-orm/sql/sql"
// 仅导入类型：KnownKeysOnly（约束泛型键的工具类型）
import type { KnownKeysOnly } from "drizzle-orm/utils"
// 仅导入类型：SQLiteDialect（SQLite 方言）
import type { SQLiteDialect } from "drizzle-orm/sqlite-core/dialect"
// 仅导入类型：PreparedQueryConfig（预编译查询配置）
import type { PreparedQueryConfig } from "drizzle-orm/sqlite-core/session"
// 仅导入类型：SQLiteTable（SQLite 表）
import type { SQLiteTable } from "drizzle-orm/sqlite-core/table"
// 仅导入类型：预编译查询与会话
import type { SQLiteEffectPreparedQuery, SQLiteEffectSession } from "./session.js"

// 关系型查询构建器：面向单个表的关系查询入口，支持 findMany/findFirst
export class SQLiteEffectRelationalQueryBuilder<
  out TSchema extends TablesRelationalConfig,
  TFields extends TableRelationalConfig,
  out TEffectHKT extends QueryEffectHKTBase = QueryEffectHKTBase,
> {
  // 实体类型标记（V2 版关系查询构建器）
  static readonly [entityKind]: string = "SQLiteEffectRelationalQueryBuilderV2"

  // 构造：保存关系全表配置、目标表、单表配置、方言、会话及可选的行模式与 jsonb 禁用标记
  constructor(
    private schema: TSchema,
    private table: SQLiteTable,
    private tableConfig: TableRelationalConfig,
    private dialect: SQLiteDialect,
    private session: SQLiteEffectSession<TEffectHKT, any, any>,
    private rowMode?: boolean,
    private forbidJsonb?: boolean,
  ) {}

  // findMany：按配置查询多条记录，返回关系型查询对象
  findMany<TConfig extends DBQueryConfig<"many", TSchema, TFields>>(
    config?: KnownKeysOnly<TConfig, DBQueryConfig<"many", TSchema, TFields>>,
  ): SQLiteEffectRelationalQuery<BuildQueryResult<TSchema, TFields, TConfig>[], TEffectHKT> {
    // 创建关系型查询：配置缺省为 true（全量），模式为 many
    return new SQLiteEffectRelationalQuery(
      this.schema,
      this.table,
      this.tableConfig,
      this.dialect,
      this.session,
      (config as DBQueryConfig<"many"> | undefined) ?? true,
      "many",
      this.rowMode,
      this.forbidJsonb,
    )
  }

  // findFirst：按配置查询单条记录，结果可能为 undefined
  findFirst<TConfig extends DBQueryConfig<"one", TSchema, TFields>>(
    config?: KnownKeysOnly<TConfig, DBQueryConfig<"one", TSchema, TFields>>,
  ): SQLiteEffectRelationalQuery<BuildQueryResult<TSchema, TFields, TConfig> | undefined, TEffectHKT> {
    // 创建关系型查询：配置缺省为 true，模式为 first
    return new SQLiteEffectRelationalQuery(
      this.schema,
      this.table,
      this.tableConfig,
      this.dialect,
      this.session,
      (config as DBQueryConfig<"one"> | undefined) ?? true,
      "first",
      this.rowMode,
      this.forbidJsonb,
    )
  }
}

// 关系型查询接口：同时是 Effect、可运行查询与 SQLWrapper
export interface SQLiteEffectRelationalQuery<TResult, TEffectHKT extends QueryEffectHKTBase = QueryEffectHKTBase>
  extends Effect.Effect<TResult, TEffectHKT["error"], TEffectHKT["context"]>,
    RunnableQuery<TResult, "sqlite">,
    SQLWrapper {}

// 关系型查询实现类：把关系配置编译成 SQL 并执行、映射结果
export class SQLiteEffectRelationalQuery<TResult, TEffectHKT extends QueryEffectHKTBase = QueryEffectHKTBase>
  implements RunnableQuery<TResult, "sqlite">, SQLWrapper
{
  // 实体类型标记（V2 版关系查询）
  static readonly [entityKind]: string = "SQLiteEffectRelationalQueryV2"

  // 声明幻影类型字段：方言、执行形态与结果类型（仅类型层面存在）
  declare readonly _: {
    readonly dialect: "sqlite"
    readonly type: "async"
    readonly result: TResult
  }

  /** @internal */
  // 查询模式：many（多条）或 first（单条）
  mode: "many" | "first"
  /** @internal */
  // 目标表（内部可被 RQB v2 流程覆写）
  table: SQLiteTable

  // 构造：保存关系配置、表配置、方言、会话、查询配置、模式及可选标记
  constructor(
    private schema: TablesRelationalConfig,
    table: SQLiteTable,
    private tableConfig: TableRelationalConfig,
    private dialect: SQLiteDialect,
    private session: SQLiteEffectSession<TEffectHKT, any, any>,
    private config: DBQueryConfig<"many" | "one"> | true,
    mode: "many" | "first",
    private rowMode?: boolean,
    private forbidJsonb?: boolean,
  ) {
    // 记录查询模式
    this.mode = mode
    // 记录目标表（构造参数是普通参数而非属性参数，因此手动赋值）
    this.table = table
  }

  /** @internal */
  // 取查询的 SQL 片段（内部使用）
  getSQL(): SQL {
    // 委托给 _getQuery 取其 sql
    return this._getQuery().sql
  }

  /** @internal */
  // 预编译关系型查询：构建 SQL 并让会话准备查询，绑定默认 RQB（关系查询构建器）映射器
  _prepare(
    isOneTimeQuery = true,
  ): SQLiteEffectPreparedQuery<
    PreparedQueryConfig & { all: TResult; get: TResult; execute: TResult },
    TEffectHKT,
    true
  > {
    // 取关系查询的构建结果与编译后的查询对象
    const { query, builtQuery } = this._toSQL()
    // 映射器配置：是否只取一条、是否解析 JSON（行模式不解析）、根层 JSON 映射、字段选择
    const mapperConfig = {
      isFirst: this.mode === "first",
      parseJson: !this.rowMode,
      parseJsonIfString: false,
      rootJsonMappers: true,
      selection: query.selection,
    }

    // 按是否一次性查询选择准备方法；单条用 "get"，多条用 "all"
    return this.session[isOneTimeQuery ? "prepareOneTimeRelationalQuery" : "prepareRelationalQuery"](
      builtQuery,
      undefined,
      this.mode === "first" ? "get" : "all",
      makeDefaultRqbMapper(mapperConfig),
      mapperConfig,
    ) as SQLiteEffectPreparedQuery<
      PreparedQueryConfig & { all: TResult; get: TResult; execute: TResult },
      TEffectHKT,
      true
    >
  }

  // 对外的 prepare：以可复用（非一次性）方式预编译
  prepare(): SQLiteEffectPreparedQuery<
    PreparedQueryConfig & { all: TResult; get: TResult; execute: TResult },
    TEffectHKT,
    true
  > {
    // isOneTimeQuery 传 false，表示预编译结果可重复执行
    return this._prepare(false)
  }

  // 构建关系查询的内部实现：把配置交给方言编译，行模式下再包一层 json_object
  private _getQuery() {
    // JSON 函数选择：禁用 jsonb 时用 json，否则用 jsonb
    const jsonb = this.forbidJsonb ? sql`json` : sql`jsonb`

    // 交给方言构建关系查询（生成嵌套 JOIN/子查询的 SQL 与字段选择）
    const query = this.dialect.buildRelationalQuery({
      schema: this.schema,
      table: this.table,
      tableConfig: this.tableConfig,
      queryConfig: this.config,
      mode: this.mode,
      isNested: this.rowMode,
      jsonb,
    })

    // 行模式：把每行结果聚合为一个 JSON 对象（列名, JSON 值）对
    if (this.rowMode) {
      // 拼接所有选中字段的 json_object 参数：键名 + 对应列（嵌套选择用 JSON 函数聚合）
      const jsonColumns = sql.join(
        query.selection.map((s) => {
          return sql`${sql.raw(this.dialect.escapeString(s.key))}, ${
            s.selection ? sql`${jsonb}(${sql.identifier(s.key)})` : sql.identifier(s.key)
          }`
        }),
        sql`, `,
      )

      // 用 json_object 包裹子查询结果，输出单列 r
      query.sql = sql`select json_object(${jsonColumns}) as ${sql.identifier("r")} from (${query.sql}) as ${sql.identifier(
        "t",
      )}`
    }

    // 返回构建结果
    return query
  }

  // 生成 SQL 的内部实现：构建查询并编译为 { sql, params }
  private _toSQL(): { query: BuildRelationalQueryResult; builtQuery: Query } {
    // 先构建关系查询
    const query = this._getQuery()

    // 用方言把 SQL 片段编译成查询对象
    const builtQuery = this.dialect.sqlToQuery(query.sql)

    // 同时返回构建结果与编译结果
    return { query, builtQuery }
  }

  // 对外导出编译后的查询（便于调试或日志）
  toSQL(): Query {
    // 返回编译后的 { sql, params }
    return this._toSQL().builtQuery
  }

  // 执行查询：单条模式用 get，多条模式用 all
  execute(placeholderValues?: Record<string, unknown>) {
    // 按模式选择执行方法
    return this.mode === "first" ? this._prepare().get(placeholderValues) : this._prepare().all(placeholderValues)
  }
}

// 为关系型查询混入 Effect 包装能力
applyEffectWrapper(SQLiteEffectRelationalQuery)
