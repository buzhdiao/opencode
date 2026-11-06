/* oxlint-disable */
// 仅导入类型：Effect（效果类型，仅作类型使用）
import type * as Effect from "effect/Effect"
// 导入 applyEffectWrapper（为查询构建器混入 Effect 能力）与 QueryEffectHKTBase（查询效果 HKT 基接口）
import { applyEffectWrapper, type QueryEffectHKTBase } from "drizzle-orm/effect-core/query-effect"
// 导入 entityKind：drizzle 实体类型标识符号
import { entityKind } from "drizzle-orm/entity"
// 导入 SQL 类型、sql 标签模板与 SQLWrapper 接口
import { SQL, sql, type SQLWrapper } from "drizzle-orm/sql/sql"
// 仅导入类型：SQLiteTable（SQLite 表）
import type { SQLiteTable } from "drizzle-orm/sqlite-core/table"
// 仅导入类型：SQLiteView（SQLite 视图）
import type { SQLiteView } from "drizzle-orm/sqlite-core/view"
// 仅导入类型：SQLiteEffectSession（Effect 版 SQLite 会话）
import type { SQLiteEffectSession } from "./session.js"

// 构造可嵌入其他查询的计数片段：返回形如 (select count(*) from 源 where 过滤) 的 SQL 子表达式
function buildSQLiteEmbeddedCount(source: SQLiteTable | SQLiteView | SQL | SQLWrapper, filters?: SQL<unknown>) {
  // 用 sql 模板拼接：源、可选的 " where "（仅有过滤条件时）以及过滤条件本身
  return sql<number>`(select count(*) from ${source}${sql.raw(" where ").if(filters)}${filters})`
}

// 构造独立的计数查询：返回形如 select count(*) from 源 where 过滤 的完整 SQL
function buildSQLiteCount(source: SQLiteTable | SQLiteView | SQL | SQLWrapper, filters?: SQL<unknown>) {
  // 与嵌入版同构，但不含外层括号，可作为独立语句执行
  return sql<number>`select count(*) from ${source}${sql.raw(" where ").if(filters)}${filters}`
}

// 计数构建器接口：同时是 SQL 数字片段、SQLWrapper 与可执行的 Effect（产出数字）
export interface SQLiteEffectCountBuilder<TEffectHKT extends QueryEffectHKTBase = QueryEffectHKTBase>
  extends SQL<number>,
    SQLWrapper<number>,
    Effect.Effect<number, TEffectHKT["error"], TEffectHKT["context"]> {}

// 计数构建器实现类：继承 SQL 使其可嵌入查询，同时具备 Effect 执行能力
export class SQLiteEffectCountBuilder<TEffectHKT extends QueryEffectHKTBase = QueryEffectHKTBase> extends SQL<number> {
  // 实体类型标记
  static override readonly [entityKind]: string = "SQLiteEffectCountBuilder"

  // 私有保存可独立执行的完整计数 SQL
  private sql: SQL<number>
  // 私有保存会话引用，用于准备与执行查询
  private session: SQLiteEffectSession<TEffectHKT, any, any>

  // 构造：接收计数源（表/视图/SQL）、可选过滤条件与会话
  constructor(params: {
    source: SQLiteTable | SQLiteView | SQL | SQLWrapper
    filters?: SQL<unknown>
    session: SQLiteEffectSession<TEffectHKT, any, any>
  }) {
    // 调用父类构造：以嵌入版片段的查询块初始化，使本对象本身可作为子表达式嵌入
    super(buildSQLiteEmbeddedCount(params.source, params.filters).queryChunks)

    // 保存会话引用
    this.session = params.session
    // 保存独立执行的完整计数 SQL
    this.sql = buildSQLiteCount(params.source, params.filters)
  }

  // 执行计数查询：准备查询并以 "all" 方式执行，取第一行第一列并转换为数字
  execute(placeholderValues?: Record<string, unknown>) {
    // 准备查询：把内部 SQL 编译为查询对象，自定义结果映射取首行首列
    return this.session
      .prepareQuery<{
        type: "async"
        execute: number
        run: unknown
        all: unknown
        get: unknown
        values: unknown
      }>(this.session.dialect.sqlToQuery(this.sql), undefined, "all", (rows) => {
        // 取第一行第一列的原始值
        const v = rows[0]?.[0]
        // 已经是数字则直接返回
        if (typeof v === "number") return v
        // 其他真值转为数字；空值/0 统一返回 0
        return v ? Number(v) : 0
      })
      // 携带占位符取值执行查询
      .execute(placeholderValues)
  }
}

// 为构建器混入 Effect 包装能力（如 map/pipe 等 Effect 语义）
applyEffectWrapper(SQLiteEffectCountBuilder)
