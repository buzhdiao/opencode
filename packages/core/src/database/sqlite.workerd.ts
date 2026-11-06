// 从 effect 导入核心构件：Context（服务上下文）、Effect（效果运行时）、
// Exit（效果结束值）、Layer（服务层）、Semaphore（信号量）、Stream（流）
import { Context, Effect, Exit, Layer, Semaphore, Stream } from "effect"
// 导入 Reactivity：effect 的响应式（reactivity）服务，供 SQL 客户端通知数据变化
import { Reactivity } from "effect/reactivity"
// 导入 SqlClient 与 Statement：effect/sql 的客户端抽象与语句编译工具
import { SqlClient, Statement } from "effect/sql"
// 仅导入类型 Connection：单个数据库连接的最小接口
import type { Connection } from "effect/sql/SqlConnection"
// 导入 SQL 错误工具：classifySqliteError 归类 SQLite 错误，SqlError/UnknownError 为错误类型
import { classifySqliteError, SqlError, UnknownError } from "effect/sql/SqlError"
// 仅导入类型 NativeTransactionSqlClient：本适配器需满足的原生事务客户端契约
import type { NativeTransactionSqlClient } from "./drizzle/effect-sqlite/session.js"

// 常量：可观测性（telemetry）属性名，标记数据库系统名称
const ATTR_DB_SYSTEM_NAME = "db.system.name"

// 常量 TypeId：本适配器的唯一类型标识字符串
const TypeId = "~@opencode/core/database/SqliteWorkerd" as const
// 与常量同名的类型：把 TypeId 提升为字面量类型，用于品牌化（branding）
type TypeId = typeof TypeId

// Durable Object SQLite only allowlists introspection pragmas; journal_mode,
// synchronous, busy_timeout, cache_size, and wal_checkpoint all throw, and
// foreign keys are already enforced by default (SQLITE_DEFAULT_FOREIGN_KEYS=1).
// supportsTuningPragmas：Durable Object 的 SQLite 只允许内省类 PRAGMA，
// 调优类 PRAGMA 会直接抛错，故标记为不支持
export const supportsTuningPragmas = false

// Durable Object SQLite rejects `PRAGMA foreign_keys`: enforcement is always
// on (SQLITE_DEFAULT_FOREIGN_KEYS=1) and only `defer_foreign_keys` is
// allowlisted for migrations that must relax checking inside a transaction.
// supportsForeignKeyToggle：Durable Object SQLite 拒绝 PRAGMA foreign_keys，
// 外键（foreign keys）始终强制开启，无法按连接切换
export const supportsForeignKeyToggle = false

// Minimal structural types for the Durable Object storage API so this adapter
// does not depend on @cloudflare/workers-types (whose ambient globals conflict
// with @types/bun). Shapes match the SqlStorage and DurableObjectStorage docs.
// SqlStorageValue：Durable Object SQL 存储中单个值的类型（二进制/文本/数字/空）
type SqlStorageValue = ArrayBuffer | string | number | null

// SqlStorageCursor：查询游标的最小结构类型——列名列表加两种取行方式
interface SqlStorageCursor {
  // 查询结果各列的名称
  readonly columnNames: Array<string>
  // raw：按行迭代原始值数组（不含列名映射）
  raw(): IterableIterator<Array<SqlStorageValue>>
  // toArray：把结果收集为“列名 -> 值”的记录数组
  toArray(): Array<Record<string, SqlStorageValue>>
}

// SqlStorage：Durable Object SQL 存储的最小接口——exec 执行 SQL 并返回游标
export interface SqlStorage {
  // 第一个参数为 SQL 文本，其余为绑定的参数值
  exec(query: string, ...bindings: Array<unknown>): SqlStorageCursor
}

// DurableObjectStorage：Durable Object 存储的最小接口——含 SQL 存储与事务
export interface DurableObjectStorage {
  // sql：底层 SQL 存储句柄
  readonly sql: SqlStorage
  // transaction：异步事务，闭包内可通过 txn.rollback() 回滚
  transaction<T>(closure: (txn: { rollback(): void }) => Promise<T>): Promise<T>
  // transactionSync：同步版本的事务
  transactionSync<T>(closure: () => T): T
}

// SqliteClient：本适配器产出的客户端类型——在通用 SqlClient 基础上
// 附加品牌标识、配置与（不支持的）updateValues 能力
interface SqliteClient extends SqlClient.SqlClient {
  // 品牌标识：编译期区分本适配器与其他 SQL 客户端
  readonly [TypeId]: TypeId
  // 创建本客户端时使用的配置
  readonly config: Config
  // updateValues：本适配器不支持，恒为 never
  readonly updateValues: never
}

// Config：创建客户端所需的配置项
interface Config {
  // 必需：Durable Object 的存储句柄
  readonly storage: DurableObjectStorage
  // 可选：附加到遥测 span 上的自定义属性
  readonly spanAttributes?: Record<string, unknown>
  // 可选：把结果列名做名称转换（如蛇形转驼峰）的函数
  readonly transformResultNames?: (str: string) => string
  // 可选：把查询中的标识符做名称转换的函数
  readonly transformQueryNames?: (str: string) => string
}

// sql.exec() rejects BEGIN/COMMIT/SAVEPOINT, so SqlClient.make's default
// transaction SQL can never run. withTransaction is replaced below with a
// DurableObjectStorage.transaction-backed implementation; this service only
// tracks the active transaction connection for statements and nesting checks.
// WorkerdTransaction：事务连接的上下文服务标签——本适配器用 Durable Object
// 原生事务替代 SQL 事务语句，该服务仅用于记录当前事务连接与嵌套检测
const WorkerdTransaction = Context.Service<SqlClient.TransactionConnection, SqlClient.TransactionConnection.Service>(
  "@opencode/core/database/SqliteWorkerdTransaction",
)

// transactionError：构造一个操作类型为 transaction 的 SqlError（SQL 错误）
const transactionError = (message: string) =>
  new SqlError({
    // 用 UnknownError 包装原始原因，附带消息与操作类型
    reason: new UnknownError({ cause: new Error(message), message, operation: "transaction" }),
  })

// makeWithTransaction：构造自定义的 withTransaction 实现——基于
// DurableObjectStorage.transaction（而非 BEGIN/COMMIT 语句），并保证互斥
const makeWithTransaction =
  (
    // storage：执行原生事务的存储句柄
    storage: DurableObjectStorage,
    // connection：事务内语句使用的连接
    connection: Connection,
    // semaphore：保证事务串行执行的信号量（semaphore）
    semaphore: Semaphore.Semaphore,
  ): SqlClient.SqlClient["withTransaction"] =>
  // 泛型入口：接收一个效果（effect），返回包裹了事务语义的效果
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | SqlError, R> =>
    // withFiber：拿到当前 fiber（纤程），以便访问其上下文
    Effect.withFiber((fiber) => {
      // services：当前 fiber 的服务上下文
      const services = fiber.context
      // 若上下文中已存在事务服务，说明发生了事务嵌套
      if (Context.getOption(services, WorkerdTransaction)._tag === "Some")
        // Durable Object 存储不支持嵌套事务，直接失败
        return Effect.fail(
          transactionError("Nested transactions are not supported by Cloudflare Durable Object SQLite storage"),
        )
      // effectWithTxn：为内部效果注入事务服务（连接句柄），供语句感知事务
      const effectWithTxn = Effect.provideContext(
        effect,
        Context.add(services, WorkerdTransaction, [connection, 0] as const),
      )
      // 用信号量许可(1)包裹回调式效果，确保同一时刻只有一个事务在运行
      return semaphore.withPermits(1)(
        // Effect.callback：把基于 Promise 的原生事务包装成可中断的效果
        Effect.callback((resume) => {
          // interrupted：标记事务是否已被中断（取消）
          let interrupted = false
          // 启动 Durable Object 原生事务；promise 在事务完成后结算
          const promise = storage
            .transaction(
              // 事务闭包：返回一个手工控制的 Promise
              (txn) =>
                new Promise<void>((resolve) => {
                  // 若事务在闭包执行前已被中断，直接完成
                  if (interrupted) return resolve()
                  // resume：把内部效果的结束值回传给 effect 运行时
                  resume(
                    // onExit：在内部效果结束时执行收尾逻辑
                    Effect.onExit(effectWithTxn, (exit) => {
                      // 内部效果失败则回滚（rollback）整个原生事务
                      if (Exit.isFailure(exit)) txn.rollback()
                      // 无论成败，结束事务闭包的 Promise
                      resolve()
                      // wait for the transaction to complete
                      // 等待原生事务自身彻底完成后再结束收尾效果
                      return Effect.promise(() => promise)
                    }),
                  )
                }),
            )
            // 原生事务抛错时：归类为 SQLite 错误并以失败结果回传
            .catch((cause) =>
              resume(
                Effect.fail(
                  new SqlError({
                    reason: classifySqliteError(cause, { message: "Failed transaction", operation: "transaction" }),
                  }),
                ),
              ),
            )
          // 返回中断处理器：效果被取消时置位标记并等待事务 Promise 落定
          return Effect.suspend(() => {
            // 标记已中断，事务闭包会据此提前结束
            interrupted = true
            // 等待底层的 promise 完成后再继续
            return Effect.promise(() => promise)
          })
        }),
      )
    })

// make：构造本适配器的 SQL 客户端（返回一个 Effect）
const make = (options: Config) =>
  // 用生成器写法组装客户端
  Effect.gen(function* () {
    // native：Durable Object 存储句柄的简写
    const native = options.storage

    // compiler：SQLite 语句编译器（可选套用查询名称转换）
    const compiler = Statement.makeCompilerSqlite(options.transformQueryNames)
    // transformRows：结果列名转换函数（未配置则为 undefined）
    const transformRows = options.transformResultNames
      ? Statement.defaultTransforms(options.transformResultNames).array
      : undefined

    // SqlClient.SafeIntegers is ignored: Durable Object SQLite has no bigint
    // mode and always returns integers as numbers. Blobs come back as
    // ArrayBuffer and are normalized to Uint8Array to match the other adapters.
    // runIterator：执行查询并逐行产出“列名 -> 值”的记录（生成器函数）
    function* runIterator(query: string, params: ReadonlyArray<unknown> = []) {
      // 执行 SQL，传入绑定参数，得到游标
      const cursor = native.sql.exec(query, ...params)
      // 取出结果列名
      const columns = cursor.columnNames
      // 逐行迭代原始值
      for (const row of cursor.raw()) {
        // record：把该行的原始数组映射成对象
        const record: Record<string, unknown> = {}
        // 按列下标逐个赋值
        for (let i = 0; i < columns.length; i++) {
          // value：当前列的原始值
          const value = row[i]
          // ArrayBuffer（二进制）统一转为 Uint8Array，与其他适配器行为对齐
          record[columns[i]] = value instanceof ArrayBuffer ? new Uint8Array(value) : value
        }
        // 产出一行记录
        yield record
      }
    }

    // run：执行查询并把全部行收集为数组；失败时归类为 SqlError
    const run = (query: string, params: ReadonlyArray<unknown> = []) =>
      // Effect.try：把同步代码的异常转为效果错误
      Effect.try({
        // 执行体：跑迭代器并收集结果
        try: () => Array.from(runIterator(query, params)),
        // 异常映射：交给 classifySqliteError 生成结构化 SQL 错误
        catch: (cause) =>
          new SqlError({
            reason: classifySqliteError(cause, { message: "Failed to execute statement", operation: "execute" }),
          }),
      })

    // runValues：执行查询并返回原始行值（数组套数组），同样做错误归类
    const runValues = (query: string, params: ReadonlyArray<unknown> = []) =>
      // Effect.try：捕获执行异常
      Effect.try({
        // 执行体：逐行收集原始值，并把 ArrayBuffer 规范化为 Uint8Array
        try: () =>
          Array.from(native.sql.exec(query, ...params).raw(), (row) =>
            row.map((value) => (value instanceof ArrayBuffer ? new Uint8Array(value) : value)),
          ),
        // 异常映射：生成结构化 SQL 错误
        catch: (cause) =>
          new SqlError({
            reason: classifySqliteError(cause, { message: "Failed to execute statement", operation: "execute" }),
          }),
      })

    // connection：实现 effect/sql 的 Connection 接口，把各方法接到上面的实现
    const connection: Connection = {
      // execute：执行参数化查询，可选地对结果行做名称转换
      execute: (query, params, transformRows) =>
        transformRows ? Effect.map(run(query, params), transformRows) : run(query, params),
      // executeRaw：执行查询，不做任何结果转换
      executeRaw: (query, params) => run(query, params),
      // executeValues：返回原始行值（不映射列名）
      executeValues: (query, params) => runValues(query, params),
      // executeValuesUnprepared：本适配器无预处理概念，直接等同于 executeValues
      executeValuesUnprepared: (query, params) => runValues(query, params),
      // executeUnprepared：直接执行原始语句，可选结果转换
      executeUnprepared: (query, params, transformRows) =>
        transformRows ? Effect.map(run(query, params), transformRows) : run(query, params),
      // executeStream：流式查询未实现，遇到即致命错误
      executeStream: () => Stream.die("executeStream not implemented"),
    }

    // semaphore：创建许可数为 1 的信号量，用于串行化连接与事务的获取
    const semaphore = yield* Semaphore.make(1)
    // acquirer：以许可保护的“获取连接”效果——同一时刻只有一个使用者
    const acquirer = semaphore.withPermits(1)(Effect.succeed(connection))
    // transactionAcquirer：获取事务连接的效果——不可中断地占用信号量许可
    const transactionAcquirer = Effect.uninterruptibleMask((restore) =>
      // 占用一个许可并让结果为连接本身
      Effect.as(restore(semaphore.takeScoped(1)), connection),
    )

    // client：用 SqlClient.make 组装通用客户端，再叠加本适配器专属字段
    const client = Object.assign(
      // 基础客户端：注入连接获取器、编译器、事务获取器等配置
      (yield* SqlClient.make({
        acquirer,
        compiler,
        transactionAcquirer,
        transactionService: WorkerdTransaction,
        // driver：遥测中标记的驱动名称
        driver: "sqlite-do",
        // spanAttributes：把用户附加属性展开进遥测 span
        spanAttributes: [
          ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
          [ATTR_DB_SYSTEM_NAME, "sqlite"],
        ],
        transformRows,
      })) as SqliteClient,
      {
        // 设置品牌标识字段
        [TypeId]: TypeId,
        // 保留创建配置
        config: options,
        // withTransaction：替换为基于原生事务的实现
        withTransaction: makeWithTransaction(native, connection, semaphore),
        // Durable Object SQLite rejects BEGIN/COMMIT/SAVEPOINT; consumers such
        // as the drizzle session detect this and route through withTransaction.
        // transactionStatements：标记不能直接执行事务语句，消费方需走 withTransaction
        transactionStatements: false,
      } as const,
    ) satisfies NativeTransactionSqlClient

    // 返回组装完成的客户端
    return client
  })

// Defends against the shared path-based Database.layer, which passes a
// filename instead of storage when resolved under the workerd condition.
// sqliteLayer：客户端服务层（Layer）——若配置里没有 storage（例如误传了文件
// 路径），则构造一个必然崩溃（die）的层并给出修复提示
export const sqliteLayer = (config: Config): Layer.Layer<SqlClient.SqlClient> =>
  config.storage
    // 正常路径：用 make 构造客户端并挂上 Reactivity 服务
    ? Layer.effect(SqlClient.SqlClient, make(config)).pipe(Layer.provide(Reactivity.layer))
    // 防御路径：workerd 环境不支持按路径打开数据库，直接致命错误
    : Layer.effect(
        SqlClient.SqlClient,
        Effect.die(
          new Error(
            "workerd sqlite cannot open a database from a path; use Database.layerFromClient.pipe(Layer.provide(sqliteLayer({ storage })))",
          ),
        ),
      )
