/* oxlint-disable */
// 以命名空间方式导入 Context（Effect 上下文管理）
import * as Context from "effect/Context"
// 以命名空间方式导入 Effect（效果运行时）
import * as Effect from "effect/Effect"
// 以命名空间方式导入 Exit（Effect 的退出结果，成功/失败包装）
import * as Exit from "effect/Exit"
// 以命名空间方式导入 Scope（资源作用域，用于连接等资源的清理）
import * as Scope from "effect/Scope"
// 仅导入类型：SqlClient（通用 SQL 客户端接口）
import type { SqlClient } from "effect/sql/SqlClient"
// 仅导入类型：SqlError（SQL 执行错误类型）
import type { SqlError } from "effect/sql/SqlError"
// 仅导入类型：EffectCacheShape（Effect 缓存服务的形状）
import type { EffectCacheShape } from "drizzle-orm/cache/core/cache-effect"
// 仅导入类型：WithCacheConfig（查询缓存的配置）
import type { WithCacheConfig } from "drizzle-orm/cache/core/types"
// 仅导入类型：EffectDrizzleQueryError（drizzle Effect 版查询错误）
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core/errors"
// 仅导入类型：EffectLoggerShape（Effect 日志服务的形状）
import type { EffectLoggerShape } from "drizzle-orm/effect-core/logger"
// 仅导入类型：QueryEffectHKTBase（查询效果高阶类型的基础接口）
import type { QueryEffectHKTBase } from "drizzle-orm/effect-core/query-effect"
// 导入 entityKind：drizzle 实体类型标识符号
import { entityKind } from "drizzle-orm/entity"
// 仅导入类型：AnyRelations（任意关系定义）
import type { AnyRelations } from "drizzle-orm/relations"
// 仅导入类型：RelationalQueryMapperConfig（关系型查询映射器配置）
import type { RelationalQueryMapperConfig } from "drizzle-orm/relations"
// 仅导入类型：Query（drizzle 查询对象）
import type { Query } from "drizzle-orm/sql/sql"
// 仅导入类型：SQLiteDialect（SQLite 方言）
import type { SQLiteDialect } from "drizzle-orm/sqlite-core/dialect"
// 导入 Effect 版 SQLite 的核心会话基类：预编译查询、会话、事务
import {
  SQLiteEffectPreparedQuery,
  SQLiteEffectSession,
  SQLiteEffectTransaction,
} from "../sqlite-core/effect/session.js"
// 仅导入类型：SelectedFieldsOrdered（查询选中的字段列表）
import type { SelectedFieldsOrdered } from "drizzle-orm/sqlite-core/query-builders/select.types"
// 仅导入类型：预编译查询配置、SQLite 执行方法、事务配置
import type { PreparedQueryConfig, SQLiteExecuteMethod, SQLiteTransactionConfig } from "drizzle-orm/sqlite-core/session"

// 查询效果 HKT 接口：声明错误分支为 EffectDrizzleQueryError，上下文为空（never）
export interface EffectSQLiteQueryEffectHKT extends QueryEffectHKTBase {
  readonly error: EffectDrizzleQueryError
  readonly context: never
}

/**
 * A SqlClient whose runtime rejects SQL transaction statements (BEGIN/COMMIT/SAVEPOINT) and
 * manages transactions natively instead — Cloudflare Durable Object SQLite. Producers set
 * `transactionStatements: false` (see `database/sqlite.workerd.ts`) and the session delegates
 * to the client's `withTransaction` rather than issuing transaction statements.
 */
// 原生管理事务的 SqlClient：运行时拒绝 SQL 事务语句（BEGIN/COMMIT/SAVEPOINT），
// 改由客户端自身的 withTransaction 管理事务（如 Cloudflare Durable Object SQLite）
export interface NativeTransactionSqlClient extends SqlClient {
  readonly transactionStatements: false
}

// 类型守卫：判断客户端是否原生管理事务（依据其 transactionStatements 标记是否为 false）
export function managesTransactionsNatively(client: SqlClient): client is NativeTransactionSqlClient {
  // 把客户端窄化为带可选 transactionStatements 字段的类型再比较
  return (client as SqlClient & { readonly transactionStatements?: boolean }).transactionStatements === false
}

// Effect 版 SQLite 的执行结果类型：drizzle 的 SQLite 通常不返回受影响行数，这里声明为空元组
export type EffectSQLiteRunResult = readonly never[]

// 会话选项：日志服务、缓存服务，以及是否启用 JIT 映射器（可选）
export interface EffectSQLiteSessionOptions {
  logger: EffectLoggerShape
  cache: EffectCacheShape
  useJitMappers?: boolean
}

// Effect 版 SQLite 会话：继承自 SQLiteEffectSession，泛型为查询 HKT、执行结果与关系定义
export class EffectSQLiteSession<TRelations extends AnyRelations> extends SQLiteEffectSession<
  EffectSQLiteQueryEffectHKT,
  EffectSQLiteRunResult,
  TRelations
> {
  // 覆盖实体类型标记，供 drizzle 内部识别
  static override readonly [entityKind]: string = "EffectSQLiteSession"

  // 构造函数：私有持有底层客户端与会话选项，受保护地持有关系定义，并把方言交给父类
  constructor(
    private client: SqlClient,
    dialect: SQLiteDialect,
    protected relations: TRelations,
    private options: EffectSQLiteSessionOptions,
  ) {
    // 调用父类构造，仅传方言
    super(dialect)
  }

  // 预编译普通查询：把查询对象包装为 SQLiteEffectPreparedQuery，绑定日志/缓存/映射器等
  override prepareQuery<T extends PreparedQueryConfig = PreparedQueryConfig>(
    query: Query,
    fields: SelectedFieldsOrdered | undefined,
    executeMethod: SQLiteExecuteMethod,
    customResultMapper?: (rows: unknown[][], mapColumnValue?: (value: unknown) => unknown) => unknown,
    queryMetadata?: {
      type: "select" | "update" | "delete" | "insert"
      tables: string[]
    },
    cacheConfig?: WithCacheConfig,
  ): SQLiteEffectPreparedQuery<T, EffectSQLiteQueryEffectHKT> {
    // 创建预编译查询：执行体指向本会话的 execute；依次传入日志、缓存、查询元数据、缓存配置、
    // 字段、执行方法、JIT 开关、自定义映射器，以及“是否在事务中”的探测结果
    return new SQLiteEffectPreparedQuery<T, EffectSQLiteQueryEffectHKT>(
      (params, method) => this.execute(query, params, method),
      query,
      this.options.logger,
      this.options.cache,
      queryMetadata,
      cacheConfig,
      fields,
      executeMethod,
      this.options.useJitMappers,
      customResultMapper,
      undefined,
      undefined,
      this.isInTransaction(),
    )
  }

  // 预编译关系型查询：与普通查询类似，但额外传入关系映射配置与“是关系查询”的标记
  override prepareRelationalQuery<T extends PreparedQueryConfig = PreparedQueryConfig>(
    query: Query,
    fields: SelectedFieldsOrdered | undefined,
    executeMethod: SQLiteExecuteMethod,
    customResultMapper: (rows: Record<string, unknown>[], mapColumnValue?: (value: unknown) => unknown) => unknown,
    config: RelationalQueryMapperConfig,
  ): SQLiteEffectPreparedQuery<T, EffectSQLiteQueryEffectHKT, true> {
    // 创建预编译查询：注意此路径把 queryMetadata 与 cacheConfig 位置传 undefined（关系查询不走缓存）
    return new SQLiteEffectPreparedQuery<T, EffectSQLiteQueryEffectHKT, true>(
      (params, method) => this.execute(query, params, method),
      query,
      this.options.logger,
      this.options.cache,
      undefined,
      undefined,
      fields,
      executeMethod,
      this.options.useJitMappers,
      customResultMapper,
      true,
      config,
      this.isInTransaction(),
    )
  }

  // 实际执行查询：调用底层客户端的 unsafe 执行原始 SQL 并按执行方法裁剪返回形态
  private execute(query: Query, params: unknown[], method: SQLiteExecuteMethod | "values") {
    // 用 SQL 文本与参数创建待执行语句
    const statement = this.client.unsafe(query.sql, params)
    // values 方法：只取原始行数据（不带转换），且关闭链路追踪以减少开销
    if (method === "values") return statement.values.pipe(Effect.withTracerEnabled(false))
    // get 方法：取首行（不转换），同样关闭追踪
    if (method === "get")
      return statement.withoutTransform.pipe(
        Effect.map((rows) => rows[0]),
        Effect.withTracerEnabled(false),
      )
    // 其余方法（all/run 等）：取全部行（不转换），关闭追踪
    return statement.withoutTransform.pipe(Effect.withTracerEnabled(false))
  }

  // 探测当前是否处于事务上下文中：检查上下文里是否存在客户端的事务服务
  private isInTransaction() {
    // serviceOption 取回可选服务，再判断是否为 Some（存在即处于事务内）
    return Effect.serviceOption(this.client.transactionService).pipe(Effect.map((option) => option._tag === "Some"))
  }

  // 在指定连接上执行裸事务语句（如 BEGIN/COMMIT），结果丢弃只保留成功状态
  private executeTransactionStatement(connection: Effect.Success<SqlClient["reserve"]>, query: string) {
    // executeUnprepared 绕过预编译直接执行，完成后转为 void
    return connection.executeUnprepared(query, [], undefined).pipe(Effect.asVoid)
  }

  // 事务执行的核心封装：effect 在事务语义下运行，config 为事务行为配置（如 deferred）
  private withTransaction<A, E, R>(effect: Effect.Effect<A, E, R>, config: SQLiteTransactionConfig | undefined) {
    // 客户端原生管理事务（如 Durable Object）：直接委托给客户端的 withTransaction
    if (managesTransactionsNatively(this.client)) return this.client.withTransaction(effect)
    // 其余情况自行管理事务：uninterruptibleMask 保护事务关键段不被中断，restore 允许内部可中断
    return Effect.uninterruptibleMask((restore) =>
      // withFiber 提供当前 fiber，以便读取其上下文中的事务连接
      Effect.withFiber<A, E | SqlError, R>((fiber) => {
        // 取当前 fiber 的服务上下文
        const services = fiber.context
        // 查看上下文中是否已有事务连接（嵌套事务时存在）
        const connectionOption = Context.getOption(services, this.client.transactionService)
        // 连接获取逻辑：已有事务连接则复用；否则新建作用域并从连接池预约一个连接
        const connection: Effect.Effect<
          readonly [Scope.Closeable | undefined, Effect.Success<SqlClient["reserve"]>],
          SqlError
        > =
          connectionOption._tag === "Some"
            // 已在事务中：直接复用现有连接，无需新作用域
            ? Effect.succeed([undefined, connectionOption.value[0]] as const)
            // 不在事务中：创建新作用域，在其中预约连接
            : Scope.make().pipe(
                Effect.flatMap((scope) =>
                  Scope.provide(this.client.reserve, scope).pipe(
                    // 预约成功：把作用域与连接一起返回
                    Effect.map((connection) => [scope, connection] as const),
                    // 预约失败：关闭作用域回收资源，然后把错误继续向外传递
                    Effect.catch((error) =>
                      Scope.close(scope, Exit.fail(error)).pipe(Effect.andThen(Effect.fail(error))),
                    ),
                  ),
                ),
              )
        // 计算保存点编号：嵌套事务递增（父事务编号+1），顶层事务为 0
        const id = connectionOption._tag === "Some" ? connectionOption.value[1] + 1 : 0

        // 拿到连接后开启/创建保存点，运行业务 effect，再按结果提交或回滚
        return connection.pipe(
          Effect.flatMap(([scope, connection]) => {
            // 顶层事务用 BEGIN（默认 deferred 行为），嵌套事务用 SAVEPOINT 实现部分回滚
            const transaction = this.executeTransactionStatement(
              connection,
              id === 0 ? `begin ${config?.behavior ?? "deferred"}` : `savepoint effect_sql_${id}`,
            ).pipe(
              Effect.flatMap(() =>
                Effect.provideContext(
                  restore(effect),
                  Context.add(services, this.client.transactionService, [connection, id]),
                ).pipe(
                  // 把业务 effect 的结果转为 Exit，便于统一处理成败
                  Effect.exit,
                  Effect.flatMap((exit) => {
                    // 依据成败与层级决定收尾动作：成功时顶层提交 COMMIT、嵌套层释放保存点
                    const finalize = Exit.isSuccess(exit)
                      ? id === 0
                        ? this.executeTransactionStatement(connection, "commit").pipe(
                            // SQLite keeps the transaction open after deferred constraint commit failures.
                            // 提交可能因延迟约束失败而仍停留在事务中：此时回滚并重新抛出原错误
                            Effect.catch((error) =>
                              this.executeTransactionStatement(connection, "rollback").pipe(
                                Effect.catch(() => Effect.void),
                                Effect.andThen(Effect.fail(error)),
                              ),
                            ),
                          )
                        : this.executeTransactionStatement(connection, `release savepoint effect_sql_${id}`)
                      : id === 0
                        ? this.executeTransactionStatement(connection, "rollback")
                        : this.executeTransactionStatement(connection, `rollback to savepoint effect_sql_${id}`).pipe(
                            Effect.andThen(
                              this.executeTransactionStatement(connection, `release savepoint effect_sql_${id}`),
                            ),
                          )

                    // 收尾完成后，把原始 Exit（成功值或失败错误）继续向外传递
                    return finalize.pipe(Effect.flatMap(() => exit))
                  }),
                ),
              ),
            )

            // 顶层事务新开了作用域：事务结束（无论成败）时关闭作用域以归还连接
            return scope === undefined
              ? transaction
              : transaction.pipe(Effect.onExit((exit) => Scope.close(scope, exit)))
          }),
        )
      }),
    )
  }

  // 对外的 transaction 入口：在事务中创建 EffectSQLiteTransaction 并交给回调使用
  override transaction<A, E, R>(
    transaction: (tx: EffectSQLiteTransaction<TRelations>) => Effect.Effect<A, E, R>,
    config?: SQLiteTransactionConfig,
  ): Effect.Effect<A, E | SqlError, R> {
    // 解构当前会话的方言与关系定义，供事务对象使用
    const { dialect, relations } = this

    // 用 withTransaction 包裹：创建事务对象、执行回调、按结果提交/回滚
    return this.withTransaction(
      Effect.gen({ self: this }, function* () {
        // 用闭包捕获的会话（this）创建事务对象，携带方言与关系定义
        const tx = new EffectSQLiteTransaction<TRelations>(dialect, this, relations)

        // 在事务对象上运行调用方逻辑
        return yield* transaction(tx)
      }),
      config,
    )
  }
}

// Effect 版 SQLite 事务类：继承自 SQLiteEffectTransaction，提供嵌套事务支持
export class EffectSQLiteTransaction<TRelations extends AnyRelations> extends SQLiteEffectTransaction<
  EffectSQLiteQueryEffectHKT,
  EffectSQLiteRunResult,
  TRelations
> {
  // 覆盖实体类型标记
  static override readonly [entityKind]: string = "EffectSQLiteTransaction"

  // 嵌套事务实现：直接委托给所属会话的 transaction（内部会转成 SAVEPOINT）
  override transaction: <A, E, R>(
    transaction: (
      tx: SQLiteEffectTransaction<EffectSQLiteQueryEffectHKT, EffectSQLiteRunResult, TRelations>,
    ) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, SqlError | E, R> = (tx) => this.session.transaction(tx)
}
