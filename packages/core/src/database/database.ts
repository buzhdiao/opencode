// 将本模块以命名空间形式整体导出为 Database，供其他模块以 Database.xxx 引用
export * as Database from "./database.js"

// 导入基于 drizzle 的 Effect SQLite 封装（EffectDrizzleSqlite），用于构建数据库实例
import { EffectDrizzleSqlite } from "./drizzle.js"
// 从平台适配层导入：sqliteLayer（按文件名创建 SQLite 客户端的 Layer）、
// supportsForeignKeyToggle（运行时是否支持切换外键开关）、supportsTuningPragmas（是否支持调优 PRAGMA）
import { sqliteLayer, supportsForeignKeyToggle, supportsTuningPragmas } from "#sqlite"
// 从 effect 导入核心模块：Context（服务上下文）、Effect（Effect 运行时）、Layer（层组合）、
// Schema（数据校验模式）、Semaphore（信号量，用于串行化）
import { Context, Effect, Layer, Schema, Semaphore } from "effect"
// 仅导入类型：effect/sql 的 SqlClient（SQL 客户端接口）
import type { SqlClient } from "effect/sql"
// 导入全局服务 Global：提供应用数据目录等全局信息
import { Global } from "@opencode/util/global"
// 导入 Node 文件系统同步 API：closeSync（关闭文件描述符）、existsSync（判断文件是否存在）、openSync（打开文件）
import { closeSync, existsSync, openSync } from "node:fs"
// 导入异步 chmod：修改文件权限
import { chmod } from "node:fs/promises"
// 导入路径工具：isAbsolute（判断是否绝对路径）、join（拼接路径）
import { isAbsolute, join } from "path"
// 导入数据库迁移模块 DatabaseMigration
import { DatabaseMigration } from "./migration.js"
// 导入 makeGlobalNode：把 Global 服务注入到目标服务 Layer 之前的辅助函数
import { makeGlobalNode } from "@opencode/util/effect/app-node"

// 用带默认值的工厂创建数据库实例；makeWithDefaults 返回一个 Effect，运行后得到数据库对象
const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
// 数据库实例的具体类型：即 makeDatabase 成功产出的类型（Effect.Success 取 Effect 的成功分支）
type DatabaseShape = Effect.Success<typeof makeDatabase>

// 数据库服务接口：持有构建好的数据库实例 db
export interface Interface {
  db: DatabaseShape
}

// 定义层选项的校验模式（Schema）：path 为可选字符串（数据库文件路径，缺省用内存库）
export const Options = Schema.Struct({
  path: Schema.optional(Schema.String),
})
// 由 Schema 推导出的选项类型（Options.Type 的类型别名）
export type Options = typeof Options.Type

// 声明数据库服务类：标识符为 "@opencode/storage/Database"，把 Service 映射到 Interface
export class Service extends Context.Service<Service, Interface>()("@opencode/storage/Database") {}

// The bootstrap lock is scoped to the database being built, never to this
// module: on workerd every Durable Object in an isolate shares module state, and
// releasing a shared semaphore resumes the waiting object's fiber inside the
// releasing object's I/O context, where its first storage call is rejected as
// cross-object I/O.
// 构建数据库的 Layer 工厂：lock 是提供引导锁（Semaphore）的 Effect，保证同一数据库的初始化串行执行
const databaseLayer = (lock: Effect.Effect<Semaphore.Semaphore>) =>
  // 创建一个 Layer：构建成功后产出 Service
  Layer.effect(
    Service,
    Effect.gen(function* () {
      // 运行工厂 Effect，得到数据库实例
      const db = yield* makeDatabase
      // An injected Durable Object client may run under a non-workerd module condition in tests.
      // 判断当前客户端是否由 Durable Object 原生管理事务（注入的 Durable Object 客户端在测试中可能跑在非 workerd 条件下）
      const durableObject = EffectDrizzleSqlite.managesTransactionsNatively(db.$client)

      // 仅在运行时支持调优 PRAGMA 且不是 Durable Object 时执行性能调优
      if (supportsTuningPragmas && !durableObject) {
        // 开启 WAL（预写日志）日志模式，提高并发读写性能
        yield* db.run("PRAGMA journal_mode = WAL")
        // 同步模式设为 NORMAL，在 WAL 下兼顾安全与性能
        yield* db.run("PRAGMA synchronous = NORMAL")
        // 忙等超时设为 5000ms，遇到锁冲突时等待而非立即报错
        yield* db.run("PRAGMA busy_timeout = 5000")
        // 页缓存设为约 64MB（负数表示按 KiB 计），减少磁盘 IO
        yield* db.run("PRAGMA cache_size = -64000")
        // 执行一次 PASSIVE 检查点（checkpoint），把 WAL 内容合并回主库文件
        yield* db.run("PRAGMA wal_checkpoint(PASSIVE)")
      }
      // Durable Object SQLite always enforces foreign keys and rejects the pragma.
      // 仅在支持外键开关且不是 Durable Object 时开启外键约束（Durable Object 恒定开启且拒绝该 PRAGMA）
      if (supportsForeignKeyToggle && !durableObject) yield* db.run("PRAGMA foreign_keys = ON")
      // 获取引导锁（信号量）
      const semaphore = yield* lock
      // 持锁串行地应用数据库迁移，避免并发建库竞争
      yield* semaphore.withPermit(DatabaseMigration.apply(db))

      // 返回服务实现：包含数据库实例
      return { db }
      // Effect.orDie：把失败分支转为缺陷（defect），数据库初始化失败视为不可恢复
    }).pipe(Effect.orDie),
  )

// Two instances over one file bootstrap the same schema, so file databases
// share a lock per path. Each in-memory database is its own connection.
// 按文件路径缓存信号量的注册表：同一文件的多个实例共享一把引导锁
const locks = new Map<string, Semaphore.Semaphore>()

// 返回指定文件对应的锁：已有则复用，否则创建容量为 1 的信号量并登记
function lockFor(filename: string) {
  // 查找该路径是否已存在锁
  const existing = locks.get(filename)
  // 已存在则直接返回，保证同路径共享同一把锁
  if (existing) return existing
  // 创建初值为 1 的非安全版信号量（无需 Effect 上下文）
  const lock = Semaphore.makeUnsafe(1)
  // 登记到注册表，供后续实例复用
  locks.set(filename, lock)
  // 返回新建的锁
  return lock
}

// 对外 Layer 工厂：默认使用内存数据库（":memory:"）
export function layer(options: Options = { path: ":memory:" }) {
  // Layer.unwrap：用一个 Effect 动态产出最终的 Layer
  return Layer.unwrap(
    Effect.gen(function* () {
      // 内部辅助：按文件名构建数据库 Layer
      const provide = (filename: string) =>
        // 内存库使用独立的一次性信号量；文件库使用按路径共享的锁；并注入对应文件的 sqlite 客户端 Layer
        databaseLayer(filename === ":memory:" ? Semaphore.make(1) : Effect.succeed(lockFor(filename))).pipe(
          Layer.provide(sqliteLayer({ filename })),
        )
      // 取选项中的路径，缺省为 ":memory:"
      const filename = options.path ?? ":memory:"
      // 内存库无需文件处理，直接构建并返回
      if (filename === ":memory:") return provide(filename)
      // 文件库：若是绝对路径则直接使用，否则拼接到全局数据目录下
      const file = isAbsolute(filename) ? filename : join((yield* Global.Service).data, filename)
      // 限制该数据库文件（及其附属文件）的权限为仅属主可读写
      yield* Effect.promise(() => restrictToOwner(file))
      // 用规范化后的文件路径构建数据库 Layer
      return provide(file)
    }),
  )
}

// SQLite creates new sidecars with the database's mode, but does not tighten existing sidecars.
// Windows relies on the user profile directory's inherited ACLs instead of POSIX modes.
// 把数据库文件与附属文件（-wal/-shm）的权限收紧为仅属主可读写（0o600）
async function restrictToOwner(filename: string) {
  // Windows 平台依赖用户配置目录继承的 ACL 而非 POSIX 权限，直接跳过
  if (process.platform === "win32") return
  // Opening and closing an existing database can release another connection's POSIX locks.
  // Create missing files synchronously so another fiber cannot open one before it is restricted.
  // 若文件不存在，以同步方式创建（权限 0o600），防止其他协程在收紧权限前抢先打开
  if (!existsSync(filename)) closeSync(openSync(filename, "a", 0o600))
  // 将主数据库文件权限改为 0o600（仅属主读写）
  await chmod(filename, 0o600)
  // 对两个附属文件（WAL 与 SHM）并发收紧权限
  await Promise.all(
    // 生成 "-wal" 与 "-shm" 两个附属文件路径并逐一处理
    [`${filename}-wal`, `${filename}-shm`].map((file) =>
      // 收紧权限；文件可能尚不存在（ENOENT），此时静默忽略，其他错误照常抛出
      chmod(file, 0o600).catch((error: NodeJS.ErrnoException) => {
        // 非 ENOENT 错误不属于“文件不存在”，向上抛出
        if (error.code !== "ENOENT") throw error
      }),
    ),
  )
}

// The database service over an injected SqlClient, for runtimes that receive
// database storage instead of opening a filesystem path. Any client provided
// here still goes through the pragma guards and migrations; Global is required
// because migrations may read it (the v1 import). The lock is created per build
// because every Durable Object builds this layer over its own storage.
// 基于注入 SqlClient 的数据库服务 Layer：面向由运行时下发存储而非文件路径的场景；
// 需要依赖 SqlClient 与 Global 服务
export const layerFromClient: Layer.Layer<Service, never, SqlClient.SqlClient | Global.Service> = databaseLayer(
  // 每个 Durable Object 各自构建本层，锁在每次构建时新建（容量 1）
  Semaphore.make(1),
)

// 返回已“配置好”的 Layer：在数据库 Layer 外先注入 Global 节点服务
export function configured(options?: Options) {
  // makeGlobalNode 会先为 Global 提供节点，再构建 service 对应的 layer；deps 声明其依赖 Global.node
  return makeGlobalNode({ service: Service, layer: layer(options), deps: [Global.node] })
}

/** `configured`, but over an injected SqlClient layer instead of a filesystem path. */
// configured 的变体：数据来源是注入的 SqlClient Layer，而非文件系统路径
export function configuredClient(client: Layer.Layer<SqlClient.SqlClient>) {
  // 以 layerFromClient 为基础，把调用方提供的客户端 Layer 注入进去，再套上 Global 节点
  return makeGlobalNode({
    service: Service,
    layer: layerFromClient.pipe(Layer.provide(client)),
    deps: [Global.node],
  })
}

// 导出默认节点：基于内存数据库的已配置 Layer，作为最常见的缺省数据库实现
export const node = configured({ path: ":memory:" })
