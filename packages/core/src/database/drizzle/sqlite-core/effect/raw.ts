/* oxlint-disable */
// 仅导入类型：Effect（效果类型）
import type * as Effect from "effect/Effect"
// 导入 applyEffectWrapper（混入 Effect 能力）与 QueryEffectHKTBase（查询效果 HKT 基接口）
import { applyEffectWrapper, type QueryEffectHKTBase } from "drizzle-orm/effect-core/query-effect"
// 导入 entityKind：drizzle 实体类型标识符号
import { entityKind } from "drizzle-orm/entity"
// 仅导入类型：RunnableQuery（可运行查询接口）
import type { RunnableQuery } from "drizzle-orm/runnable-query"
// 仅导入类型：PreparedQuery（预编译查询接口）
import type { PreparedQuery } from "drizzle-orm/session"
// 仅导入类型：Query（查询对象）、SQL（SQL 片段）、SQLWrapper（SQL 包装接口）
import type { Query, SQL, SQLWrapper } from "drizzle-orm/sql/sql"
// 仅导入类型：SQLiteDialect（SQLite 方言）
import type { SQLiteDialect } from "drizzle-orm/sqlite-core/dialect"

// 原始 SQL 的执行动作类型：all（全部行）/ get（单行）/ values（原始行数据）/ run（执行）
type SQLiteEffectRawAction = "all" | "get" | "values" | "run"

// Effect 版原始 SQL 接口：同时是 Effect、可运行查询与 SQLWrapper
export interface SQLiteEffectRaw<TResult, TEffectHKT extends QueryEffectHKTBase = QueryEffectHKTBase>
  extends Effect.Effect<TResult, TEffectHKT["error"], TEffectHKT["context"]>,
    RunnableQuery<TResult, "sqlite">,
    SQLWrapper {}

// Effect 版原始 SQL 实现类：包装任意 SQL 片段，支持按动作执行与批处理结果映射
export class SQLiteEffectRaw<TResult, TEffectHKT extends QueryEffectHKTBase = QueryEffectHKTBase>
  implements RunnableQuery<TResult, "sqlite">, SQLWrapper, PreparedQuery
{
  // 实体类型标记
  static readonly [entityKind]: string = "SQLiteEffectRaw"

  // 声明幻影类型字段：标记方言为 sqlite、结果类型为 TResult（仅类型层面存在）
  declare readonly _: {
    readonly dialect: "sqlite"
    readonly result: TResult
  }

  // 构造：execute 为执行体；getSQL 返回 SQL 片段（内部用）；action 决定执行方式；
  // dialect 用于编译 SQL；mapBatchResult 用于批处理场景的结果转换
  constructor(
    public execute: () => Effect.Effect<TResult, TEffectHKT["error"], TEffectHKT["context"]>,
    /** @internal */
    public getSQL: () => SQL,
    private action: SQLiteEffectRawAction,
    private dialect: SQLiteDialect,
    private mapBatchResult: (result: unknown) => unknown,
  ) {}

  // 获取编译后的查询对象：把 SQL 片段编译为 { sql, params } 并附上执行动作
  getQuery(): Query & { method: SQLiteEffectRawAction } {
    // 用方言把 SQL 编译为查询，再补上 method 字段
    return { ...this.dialect.sqlToQuery(this.getSQL()), method: this.action }
  }

  // 映射结果：来自批处理时用注入的映射函数转换，否则原样返回
  mapResult(result: unknown, isFromBatch?: boolean) {
    // 按是否来自批处理分支处理
    return isFromBatch ? this.mapBatchResult(result) : result
  }

  // 预编译钩子：原始查询无需真正准备，直接返回自身
  _prepare(): PreparedQuery {
    // 自身即是 PreparedQuery
    return this
  }
}

// 为原始查询混入 Effect 包装能力
applyEffectWrapper(SQLiteEffectRaw)
