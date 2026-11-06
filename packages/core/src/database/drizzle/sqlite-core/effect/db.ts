/* oxlint-disable */
// 导入 Effect（效果运行时）
import { Effect } from "effect"
// 仅导入类型：SqlError（SQL 执行错误）
import type { SqlError } from "effect/sql/SqlError"
// 仅导入类型：EffectCacheShape（Effect 缓存服务形状）
import type { EffectCacheShape } from "drizzle-orm/cache/core/cache-effect"
// 仅导入类型：MutationOption（缓存失效时的变更描述）
import type { MutationOption } from "drizzle-orm/cache/core/cache"
// 仅导入类型：QueryEffectHKTBase（查询效果 HKT 基接口）
import type { QueryEffectHKTBase } from "drizzle-orm/effect-core/query-effect"
// 导入 entityKind：drizzle 实体类型标识符号
import { entityKind } from "drizzle-orm/entity"
// 仅导入类型：TypedQueryBuilder（带类型的查询构建器）
import type { TypedQueryBuilder } from "drizzle-orm/query-builders/query-builder"
// 仅导入类型：AnyRelations（任意关系）、EmptyRelations（空关系）
import type { AnyRelations, EmptyRelations } from "drizzle-orm/relations"
// 导入 SelectionProxyHandler：查询结果字段选择代理
import { SelectionProxyHandler } from "drizzle-orm/selection-proxy"
// 导入类型与工具：ColumnsSelection（列选择）、SQL（SQL 片段）、sql 模板、SQLWrapper
import { type ColumnsSelection, type SQL, sql, type SQLWrapper } from "drizzle-orm/sql/sql"
// 仅导入类型：SQLiteDialect（SQLite 方言）
import type { SQLiteDialect } from "drizzle-orm/sqlite-core/dialect"
// 导入 QueryBuilder：不带会话的轻量查询构建器（用于 $with 内构造子查询）
import { QueryBuilder } from "drizzle-orm/sqlite-core/query-builders/query-builder"
// 仅导入类型：SelectedFields（选中字段集合）
import type { SelectedFields } from "drizzle-orm/sqlite-core/query-builders/select.types"
// 仅导入类型：SQLiteTransactionConfig（SQLite 事务配置）
import type { SQLiteTransactionConfig } from "drizzle-orm/sqlite-core/session"
// 仅导入类型：SQLiteTable（SQLite 表）
import type { SQLiteTable } from "drizzle-orm/sqlite-core/table"
// 仅导入类型：SQLiteViewBase（SQLite 视图基类）
import type { SQLiteViewBase } from "drizzle-orm/sqlite-core/view-base"
// 导入 WithSubquery：WITH 子句的子查询实体
import { WithSubquery } from "drizzle-orm/subquery"
// 仅导入类型：WithBuilder（$with 的构建器类型）
import type { WithBuilder } from "drizzle-orm/sqlite-core/subquery"
// 导入计数构建器
import { SQLiteEffectCountBuilder } from "./count.js"
// 导入删除构建器基类
import { SQLiteEffectDeleteBase } from "./delete.js"
// 导入插入构建器
import { SQLiteEffectInsertBuilder } from "./insert.js"
// 导入关系型查询构建器
import { SQLiteEffectRelationalQueryBuilder } from "./query.js"
// 导入原始 SQL 执行器
import { SQLiteEffectRaw } from "./raw.js"
// 导入查询构建器与查询基类类型
import { SQLiteEffectSelectBuilder } from "./select.js"
import type { SQLiteEffectSelectBase } from "./select.js"
// 仅导入类型：会话与事务
import type { SQLiteEffectSession, SQLiteEffectTransaction } from "./session.js"
// 导入更新构建器
import { SQLiteEffectUpdateBuilder } from "./update.js"

// Effect 版 SQLite 数据库类：组合方言与会话，暴露 select/insert/update/delete/原始执行/事务等入口
export class SQLiteEffectDatabase<
  TEffectHKT extends QueryEffectHKTBase,
  TRunResult,
  TRelations extends AnyRelations = EmptyRelations,
> {
  // 实体类型标记
  static readonly [entityKind]: string = "SQLiteEffectDatabase"

  // 声明幻影类型字段：携带关系定义与会话类型（仅类型层面存在）
  declare readonly _: {
    readonly relations: TRelations
    readonly session: SQLiteEffectSession<TEffectHKT, TRunResult, TRelations>
  }

  // 关系型查询入口：按关系名索引的关系查询构建器集合
  query: {
    [K in keyof TRelations]: SQLiteEffectRelationalQueryBuilder<TRelations, TRelations[K], TEffectHKT>
  }

  // 构造：方言与会话作为内部只读属性；relations 为关系定义；
  // rowModeRQB 启用行模式（JSON 聚合）；forbidJsonb 禁用 jsonb（仅用 json）
  constructor(
    /** @internal */
    readonly dialect: SQLiteDialect,
    /** @internal */
    readonly session: SQLiteEffectSession<TEffectHKT, TRunResult, TRelations>,
    relations: TRelations,
    readonly rowModeRQB?: boolean,
    readonly forbidJsonb?: boolean,
  ) {
    // 记录幻影类型字段的实际值
    this._ = {
      relations,
      session,
    }

    // 初始化 query 为空对象（先断言），随后逐个填充关系查询构建器
    this.query = {} as (typeof this)["query"]
    // 遍历关系定义，为每个关系创建一个关系型查询构建器
    for (const [tableName, relation] of Object.entries(relations)) {
      // 以表名为键写入构建器，传入关系全表配置、目标表、关系配置、方言、会话等
      ;(this.query as SQLiteEffectDatabase<TEffectHKT, TRunResult, AnyRelations>["query"])[tableName] =
        new SQLiteEffectRelationalQueryBuilder(
          relations,
          relations[relation.name]!.table as SQLiteTable,
          relation,
          dialect,
          session,
          rowModeRQB,
          forbidJsonb,
        )
    }

    // 初始化缓存钩子：默认 invalidate 为空 Effect，使用时由驱动替换为真正的缓存失效函数
    this.$cache = {
      invalidate: (_params: MutationOption) => Effect.void,
    }
  }

  // $with：构造 CTE（WITH 子句）子查询的入口；alias 为别名，selection 可显式指定选中字段
  $with: WithBuilder = (alias: string, selection?: ColumnsSelection) => {
    // 保存数据库自身引用，供闭包内使用
    const self = this
    // as：把给定的查询/SQL 定义为具名子查询
    const as = (
      qb:
        | TypedQueryBuilder<ColumnsSelection | undefined>
        | SQL
        | ((qb: QueryBuilder) => TypedQueryBuilder<ColumnsSelection | undefined> | SQL),
    ) => {
      // 传入函数时，用一个新的 QueryBuilder（共享方言）执行该函数得到实际查询
      if (typeof qb === "function") {
        qb = qb(new QueryBuilder(self.dialect))
      }

      // 创建 WithSubquery 并用代理包装：SQL 用作别名、直接把 SQL 当列用则报错
      return new Proxy(
        new WithSubquery(
          // 子查询的 SQL 主体
          qb.getSQL(),
          // 选中字段：显式指定优先，否则尝试调用 getSelectedFields，取不到给空对象
          selection ??
            (("getSelectedFields" in qb
              ? ((qb as { getSelectedFields(): SelectedFields | undefined }).getSelectedFields() ?? {})
              : {}) as SelectedFields),
          // 子查询别名
          alias,
          // 标记为已生成 SQL 的子查询
          true,
        ),
        // 字段选择代理：让该子查询可以像表一样按字段引用
        new SelectionProxyHandler({ alias, sqlAliasedBehavior: "alias", sqlBehavior: "error" }),
      )
    }
    // 返回 { as } 形成链式调用：db.$with("x").as(...)
    return { as }
  }

  // 缓存失效钩子：签名与 Effect 缓存服务的 onMutate 一致（由驱动在构造后赋值）
  $cache: { invalidate: EffectCacheShape["onMutate"] }

  // 计数入口：为给定源（表/视图/SQL）创建计数构建器
  $count(source: SQLiteTable | SQLiteViewBase | SQL | SQLWrapper, filters?: SQL<unknown>) {
    // 直接委托给 SQLiteEffectCountBuilder
    return new SQLiteEffectCountBuilder({ source, filters, session: this.session })
  }

  // with：以一组 WITH 子查询为基础，返回绑定这些子查询的 select/update/insert/delete 工厂
  with(...queries: WithSubquery[]) {
    // 保存自身引用供内部函数使用
    const self = this

    // select 重载签名：无字段时结果类型为 undefined 选择
    function select(): SQLiteEffectSelectBuilder<undefined, TRunResult, TEffectHKT>
    // select 重载签名：指定字段集合
    function select<TSelection extends SelectedFields>(
      fields: TSelection,
    ): SQLiteEffectSelectBuilder<TSelection, TRunResult, TEffectHKT>
    // select 实现：创建带 withList 的查询构建器
    function select(
      fields?: SelectedFields,
    ): SQLiteEffectSelectBuilder<SelectedFields | undefined, TRunResult, TEffectHKT> {
      // 传入字段、会话、方言与 WITH 子查询列表
      return new SQLiteEffectSelectBuilder({
        fields: fields ?? undefined,
        session: self.session,
        dialect: self.dialect,
        withList: queries,
      })
    }

    // selectDistinct 重载签名：无字段
    function selectDistinct(): SQLiteEffectSelectBuilder<undefined, TRunResult, TEffectHKT>
    // selectDistinct 重载签名：指定字段集合
    function selectDistinct<TSelection extends SelectedFields>(
      fields: TSelection,
    ): SQLiteEffectSelectBuilder<TSelection, TRunResult, TEffectHKT>
    // selectDistinct 实现：同 select 但开启去重
    function selectDistinct(
      fields?: SelectedFields,
    ): SQLiteEffectSelectBuilder<SelectedFields | undefined, TRunResult, TEffectHKT> {
      // 创建构建器并标记 distinct
      return new SQLiteEffectSelectBuilder({
        fields: fields ?? undefined,
        session: self.session,
        dialect: self.dialect,
        withList: queries,
        distinct: true,
      })
    }

    // update：针对指定表的更新构建器（携带 WITH 子查询）
    function update<TTable extends SQLiteTable>(
      table: TTable,
    ): SQLiteEffectUpdateBuilder<TTable, TRunResult, TEffectHKT> {
      // 委托给更新构建器
      return new SQLiteEffectUpdateBuilder(table, self.session, self.dialect, queries)
    }

    // insert：向指定表插入的构建器（携带 WITH 子查询）
    function insert<TTable extends SQLiteTable>(
      into: TTable,
    ): SQLiteEffectInsertBuilder<TTable, TRunResult, TEffectHKT> {
      // 委托给插入构建器
      return new SQLiteEffectInsertBuilder(into, self.session, self.dialect, queries)
    }

    // delete：从指定表删除的构建器（携带 WITH 子查询）；命名带下划线避免与关键字冲突
    function delete_<TTable extends SQLiteTable>(
      from: TTable,
    ): SQLiteEffectDeleteBase<TTable, TRunResult, undefined, false, never, TEffectHKT> {
      // 委托给删除构建器
      return new SQLiteEffectDeleteBase(from, self.session, self.dialect, queries)
    }

    // 返回四类操作工厂，delete 以 delete 名字对外
    return { select, selectDistinct, update, insert, delete: delete_ }
  }

  // select 重载签名：无字段
  select(): SQLiteEffectSelectBuilder<undefined, TRunResult, TEffectHKT>
  // select 重载签名：指定字段集合
  select<TSelection extends SelectedFields>(
    fields: TSelection,
  ): SQLiteEffectSelectBuilder<TSelection, TRunResult, TEffectHKT>
  // select 实现：创建查询构建器
  select(fields?: SelectedFields): SQLiteEffectSelectBuilder<SelectedFields | undefined, TRunResult, TEffectHKT> {
    // 传入字段（缺省 undefined）、会话与方言
    return new SQLiteEffectSelectBuilder({ fields: fields ?? undefined, session: this.session, dialect: this.dialect })
  }

  // selectDistinct 重载签名：无字段
  selectDistinct(): SQLiteEffectSelectBuilder<undefined, TRunResult, TEffectHKT>
  // selectDistinct 重载签名：指定字段集合
  selectDistinct<TSelection extends SelectedFields>(
    fields: TSelection,
  ): SQLiteEffectSelectBuilder<TSelection, TRunResult, TEffectHKT>
  // selectDistinct 实现：同 select 但去重
  selectDistinct(
    fields?: SelectedFields,
  ): SQLiteEffectSelectBuilder<SelectedFields | undefined, TRunResult, TEffectHKT> {
    // 创建构建器并标记 distinct
    return new SQLiteEffectSelectBuilder({
      fields: fields ?? undefined,
      session: this.session,
      dialect: this.dialect,
      distinct: true,
    })
  }

  // update：针对指定表的更新构建器
  update<TTable extends SQLiteTable>(table: TTable): SQLiteEffectUpdateBuilder<TTable, TRunResult, TEffectHKT> {
    // 委托给更新构建器
    return new SQLiteEffectUpdateBuilder(table, this.session, this.dialect)
  }

  // insert：向指定表插入的构建器
  insert<TTable extends SQLiteTable>(into: TTable): SQLiteEffectInsertBuilder<TTable, TRunResult, TEffectHKT> {
    // 委托给插入构建器
    return new SQLiteEffectInsertBuilder(into, this.session, this.dialect)
  }

  // delete：从指定表删除的构建器
  delete<TTable extends SQLiteTable>(
    from: TTable,
  ): SQLiteEffectDeleteBase<TTable, TRunResult, undefined, false, never, TEffectHKT> {
    // 委托给删除构建器
    return new SQLiteEffectDeleteBase(from, this.session, this.dialect)
  }

  // 内部统一入口：把字符串或 SQL 包装为 SQLiteEffectRaw（action 决定执行方式）
  private raw<TResult>(
    query: SQLWrapper | string,
    action: "all" | "get" | "run" | "values",
    execute: (query: SQL) => Effect.Effect<TResult, TEffectHKT["error"], TEffectHKT["context"]>,
  ): SQLiteEffectRaw<TResult, TEffectHKT> {
    // 字符串输入转为原始 SQL；SQLWrapper 取其 SQL 表示
    const sequel = typeof query === "string" ? sql.raw(query) : query.getSQL()
    // 创建原始执行器：执行体调用注入的 execute，映射函数原样透传
    return new SQLiteEffectRaw(
      () => execute(sequel),
      () => sequel,
      action,
      this.dialect,
      (result) => result,
    )
  }

  // run：执行写操作（不关心返回行）
  run(query: SQLWrapper | string): SQLiteEffectRaw<TRunResult, TEffectHKT> {
    // 以 "run" 动作委托给会话的 run
    return this.raw(query, "run", (sequel) => this.session.run(sequel))
  }

  // all：取全部行
  all<T = unknown>(query: SQLWrapper | string): SQLiteEffectRaw<T[], TEffectHKT> {
    // 以 "all" 动作委托给会话的 all
    return this.raw(query, "all", (sequel) => this.session.all(sequel))
  }

  // get：取单行
  get<T = unknown>(query: SQLWrapper | string): SQLiteEffectRaw<T | undefined, TEffectHKT> {
    // 以 "get" 动作委托给会话的 get
    return this.raw(query, "get", (sequel) => this.session.get(sequel))
  }

  // values：取原始行数据数组
  values<T extends unknown[] = unknown[]>(query: SQLWrapper | string): SQLiteEffectRaw<T[], TEffectHKT> {
    // 以 "values" 动作委托给会话的 values
    return this.raw(query, "values", (sequel) => this.session.values(sequel))
  }

  // transaction：开启事务，回调接收事务对象；config 为事务行为配置
  transaction: <A, E, R>(
    transaction: (tx: SQLiteEffectTransaction<TEffectHKT, TRunResult, TRelations>) => Effect.Effect<A, E, R>,
    config?: SQLiteTransactionConfig,
  ) => Effect.Effect<A, E | SqlError, R> = (tx, config) => this.session.transaction(tx, config)
}

// 任意泛型参数的 Effect 版 SQLite 数据库类型（放宽为 any，便于内部传递）
export type AnySQLiteEffectDatabase = SQLiteEffectDatabase<any, any, any>
// 任意泛型参数的 Effect 版查询基类类型
export type AnySQLiteEffectSelectBase = SQLiteEffectSelectBase<any, any, any, any, any, any, any, any, any, any>
