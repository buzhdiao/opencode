// 将本模块以命名空间（namespace）形式整体导出；Workspace 表示一个逻辑工作区（workspace）抽象
export * as Workspace from "./workspace.js"

// 导入工作区相关的 Schema 定义（含 ID 类型）
import { Workspace } from "@opencode/schema/workspace"
// 导入"全局单例服务节点"构造工具
import { makeGlobalNode } from "@opencode/util/effect/app-node"
// 导入 drizzle-orm 的 eq 比较函数，用于构造 SQL WHERE 条件
import { eq } from "drizzle-orm"
// 导入 Effect 的核心工具：Clock（时钟）、Context、Deferred（一次性结果）、Duration（时长）、Effect、Exit（退出结果）、FiberSet（纤程集合）、Layer、Ref、Schedule（调度计划）、Schema、Scope（作用域）
import { Clock, Context, Deferred, Duration, Effect, Exit, FiberSet, Layer, Ref, Schedule, Schema, Scope } from "effect"
// 导入 systemError：构造平台无关的系统错误
import { systemError } from "effect/PlatformError"
// 导入子进程 spawner 的 make 构造器，用于把 Effect 包装成可 spawn 的进程接口
import { make } from "effect/process/ChildProcessSpawner"
// 导入环境驱动（EnvironmentDriver）的类型
import type { EnvironmentDriver } from "./environment/driver.js"
// 导入默认文件操作工厂 makeFiles
import { makeFiles } from "./environment/exec-defaults.js"
// 导入 Failed 错误类型及 Files / FilesImpl 类型
import { Failed, type Files, type FilesImpl } from "./environment/files.js"
// 导入数据库服务
import { Database } from "./database/database.js"
// 导入键互斥锁（KeyedMutex）：按 key 串行化操作
import { KeyedMutex } from "./effect/keyed-mutex.js"
// 导入工作区驱动（WorkspaceDriver）：真正创建/销毁底层资源的提供方
import { WorkspaceDriver } from "./workspace/driver.js"
// 导入工作区数据库表定义
import { WorkspaceTable } from "./workspace/sql.js"

// 重导出工作区 ID 类型和类型别名，方便外部统一从本模块引用
export const ID = Workspace.ID
export type ID = Workspace.ID

// 定义 Info 类：工作区的展示信息（id、提供方、绑定、创建与最近使用时间）
export class Info extends Schema.Class<Info>("Workspace.Info")({
  // 工作区 ID
  id: ID,
  // 提供方（provider）名称，例如某种沙箱实现
  provider: Schema.String,
  // 绑定（binding）：指向底层已创建资源的持久化句柄
  binding: WorkspaceDriver.Binding,
  // 创建时间（毫秒时间戳）
  createdAt: Schema.Number,
  // 最近使用时间（毫秒时间戳）
  lastUsedAt: Schema.Number,
}) {}

// 定义 NotFound 错误：指定的工作区不存在
export class NotFound extends Schema.TaggedError<NotFound>()("Workspace.NotFound", { workspaceID: ID }) {}

// 定义 CreateConflict 错误：同一 ID 已存在但由不同提供方持有
export class CreateConflict extends Schema.TaggedError<CreateConflict>()("Workspace.CreateConflict", {
  workspaceID: ID,
  provider: Schema.String,
  existingProvider: Schema.String,
}) {}

// 定义服务接口：创建 / 供给（provision）/ 连接 / 销毁工作区
export interface Interface {
  /** Instantly commits a logical workspace ID. No provider work happens here. */
  // create：仅登记逻辑工作区 ID，不做任何提供方侧的实际创建
  readonly create: (input: {
    readonly id?: ID
    readonly provider: string
  }) => Effect.Effect<ID, CreateConflict | WorkspaceDriver.ProviderNotFound>
  /** Starts or joins the shared attempt that makes the backing resource real, then returns it. */
  // provision：发起或加入"把底层资源真正建出来"的共享尝试，完成后返回信息
  readonly provision: (
    workspaceID: ID,
  ) => Effect.Effect<Info, NotFound | WorkspaceDriver.Error | WorkspaceDriver.ProviderNotFound>
  // connect：连接到工作区，返回其环境驱动与文件/spawner 能力
  readonly connect: (
    workspaceID: ID,
  ) => Effect.Effect<EnvironmentDriver.Driver, NotFound | WorkspaceDriver.Error | WorkspaceDriver.ProviderNotFound>
  /** Makes the workspace absent; reports whether this call destroyed an existing workspace. */
  // destroy：销毁工作区，返回本次调用是否真的删除了已存在的工作区
  readonly destroy: (
    workspaceID: ID,
  ) => Effect.Effect<Workspace.DestroyResult, WorkspaceDriver.Error | WorkspaceDriver.ProviderNotFound>
}

// 定义服务可调参数：空闲阈值与轮询间隔
export interface Options {
  // 空闲多久后挂起工作区（默认 20 分钟）
  readonly idleThreshold?: Duration.Input
  // 空闲检查的轮询间隔（默认 1 分钟）
  readonly pollInterval?: Duration.Input
}

// 定义 Effect 服务标记类：以 "@opencode/Workspace" 为标签
export class Service extends Context.Service<Service, Interface>()("@opencode/Workspace") {}

// 定义 Connection（连接）：某个工作区在内存中的活跃连接状态
interface Connection {
  // 工作区驱动接口
  readonly driver: WorkspaceDriver.Interface
  // 环境驱动（实际执行命令/文件操作的能力）
  readonly environment: EnvironmentDriver.Driver
  // 文件操作门面
  readonly files: Files
  // 保存新绑定到数据库的回调
  readonly saveBinding: (binding: WorkspaceDriver.Binding) => Effect.Effect<void>
  // 最近活动时间的可变引用
  readonly lastActivity: Ref.Ref<number>
  // 当前活跃引用计数的可变引用
  readonly active: Ref.Ref<number>
  // 本连接私有的可关闭作用域，退出时统一清理资源
  readonly scope: Scope.Closeable
}

// 定义就绪（readiness）阶段可能出现的错误联合类型
type ReadinessError = NotFound | WorkspaceDriver.Error | WorkspaceDriver.ProviderNotFound

// 导出 configured：按可选参数构建全局服务节点
export const configured = (options: Options = {}) =>
  makeGlobalNode({
    service: Service,
    layer: layer(options),
    deps: [Database.node, WorkspaceDriver.node],
  })

// 构建服务层：注入数据库与工作区驱动注册表，维护连接缓存与空闲挂起循环
const layer = (options: Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      // 取出底层的 drizzle 数据库句柄
      const db = (yield* Database.Service).db
      // 取出工作区驱动注册表（按 provider 名称获取驱动）
      const registry = yield* WorkspaceDriver.RegistryService
      // 获取外层生命周期作用域：本层关闭时其中的子作用域也会被清理
      const lifetime = yield* Scope.Scope
      // 连接缓存：工作区 ID -> 活跃连接
      const connections = new Map<ID, Connection>()
      // Destroy cancels the racing provision body by settling the deferred.
      // 进行中的供给尝试：工作区 ID -> Deferred；销毁时通过结算它来取消竞争中的供给流程
      const attempts = new Map<ID, Deferred.Deferred<Info, ReadinessError>>()
      // 创建按工作区 ID 互斥的锁集合
      const locks = KeyedMutex.makeUnsafe<ID>()
      // 创建运行时纤程集合，用于在当前作用域内派生后台任务
      const fork = yield* FiberSet.makeRuntime<never, void, never>()
      // 计算空闲阈值（毫秒），未配置时默认 20 分钟
      const idleThreshold = Duration.toMillis(options.idleThreshold ?? Duration.minutes(20))

      // 定义 find：按 ID 查询工作区行，查询失败视为缺陷（orDie）
      const find = (workspaceID: ID) =>
        db.select().from(WorkspaceTable).where(eq(WorkspaceTable.id, workspaceID)).get().pipe(Effect.orDie)

      // 定义 load：读取工作区行，不存在则失败为 NotFound
      const load = Effect.fn("Workspace.load")(function* (workspaceID: ID) {
        // 查询该 ID 的行
        const row = yield* find(workspaceID)
        // 行不存在则失败为 NotFound 错误
        if (!row) return yield* new NotFound({ workspaceID })
        // 返回查到的行
        return row
      })

      // 定义 saveBinding：把新的绑定持久化到工作区行
      const saveBinding = (workspaceID: ID, binding: WorkspaceDriver.Binding) =>
        db.update(WorkspaceTable).set({ binding }).where(eq(WorkspaceTable.id, workspaceID)).run().pipe(Effect.orDie)

      // 定义 info：由数据库行和绑定组装 Info 对象
      const info = (row: typeof WorkspaceTable.$inferSelect, binding: WorkspaceDriver.Binding) =>
        new Info({
          id: row.id,
          provider: row.provider,
          binding,
          createdAt: row.created_at,
          lastUsedAt: row.last_used_at,
        })

      // 定义 provision：确保底层资源真实存在；并发调用共享同一次尝试
      const provision = Effect.fn("Workspace.provision")((workspaceID: ID) =>
        // 用 suspend 延迟执行，保证每次进入时都重新检查共享尝试
        Effect.suspend(() => {
          // 已有进行中的尝试则直接等待它的结果
          const existing = attempts.get(workspaceID)
          if (existing) return Deferred.await(existing)

          // 创建新的 Deferred 作为本次共享尝试的结果载体
          const attempt = Deferred.makeUnsafe<Info, ReadinessError>()
          // 登记到进行中映射
          attempts.set(workspaceID, attempt)
          // 后台派生实际工作：拿到锁后按需创建底层资源，并与"等待 Deferred"赛跑
          fork(
            locks
              .withLock(workspaceID)(
                // 持锁执行：读取行，若无绑定则调用驱动创建并保存绑定
                Effect.gen(function* () {
                  // 读取工作区行（不存在则 NotFound）
                  const row = yield* load(workspaceID)
                  // 已有绑定说明资源已创建，直接返回信息
                  if (row.binding) return info(row, row.binding)
                  // 取出该行提供方对应的驱动
                  const driver = yield* registry.get(row.provider)
                  // 调用驱动真正创建底层资源，得到绑定
                  const result = yield* driver.create({ workspaceID })
                  // 把绑定持久化，供后续连接复用
                  yield* saveBinding(workspaceID, result.binding)
                  // 返回组装好的信息
                  return info(row, result.binding)
                }),
              )
              .pipe(
                // 与"等待 Deferred"赛跑：销毁结算 Deferred 后会中断这里的供给流程
                Effect.raceFirst(Deferred.await(attempt)),
                // 无论成败，退出时清理登记并结算 Deferred（复用相同的退出结果）
                Effect.onExit((exit) =>
                  Effect.sync(() => {
                    // 仅当登记仍属于本次尝试时才移除，避免误删新一轮尝试
                    if (attempts.get(workspaceID) === attempt) attempts.delete(workspaceID)
                    // 以本次退出的结果结算 Deferred，唤醒所有等待者
                    Deferred.doneUnsafe(attempt, exit)
                  }),
                ),
                // 把结果收拢为 Exit（吃掉失败），等待者从 Deferred 拿到原始成败
                Effect.exit,
                // 转为无错误的 void
                Effect.asVoid,
              ),
          )
          // 等待共享尝试的结果
          return Deferred.await(attempt)
        }),
      )

      // 定义 open：为工作区打开（或复用）一条连接
      const open = Effect.fn("Workspace.open")(function* (workspaceID: ID) {
        // 已有活跃连接则直接复用
        const existing = connections.get(workspaceID)
        if (existing) return existing

        // 读取工作区行
        const row = yield* load(workspaceID)
        // Bindings are persisted before provision resolves and never nulled; a raced
        // destroy deletes the whole row and surfaces as NotFound from load above.
        // provision 成功前绑定必已持久化且不会置空；若此处仍无绑定，属于内部不变量被破坏，直接缺陷退出
        if (!row.binding) return yield* Effect.die(`workspace ${workspaceID} has no binding after provision`)
        // 取出提供方对应的驱动
        const driver = yield* registry.get(row.provider)
        // 定义持久化绑定的偏函数
        const persistBinding = (binding: WorkspaceDriver.Binding) => saveBinding(workspaceID, binding)
        // 从生命周期作用域 fork 出本连接私有的作用域
        const scope = yield* Scope.fork(lifetime)
        // 通过驱动连接到工作区环境（在私有作用域内）；失败时关闭该作用域
        const environment = yield* driver
          .connect({ workspaceID, binding: row.binding, saveBinding: persistBinding })
          .pipe(
            // 为 connect 注入私有作用域
            Effect.provideService(Scope.Scope, scope),
            // 连接失败时立即关闭刚 fork 的作用域
            Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
          )
        // 取当前时间作为初始活动时间
        const now = yield* Clock.currentTimeMillis
        // 组装连接对象
        const connection: Connection = {
          driver,
          environment,
          // 基于环境驱动构建默认文件操作实现
          files: makeFiles(environment),
          // 绑定保存回调
          saveBinding: persistBinding,
          // 初始化最近活动时间
          lastActivity: yield* Ref.make(now),
          // 初始化活跃引用计数为 0
          active: yield* Ref.make(0),
          scope,
        }
        // 登记到连接缓存
        connections.set(workspaceID, connection)
        // 更新数据库中的最近使用时间
        yield* db
          .update(WorkspaceTable)
          .set({ last_used_at: now })
          .where(eq(WorkspaceTable.id, workspaceID))
          .run()
          .pipe(Effect.orDie)
        // 返回新连接
        return connection
      })

      // 启动空闲挂起巡检循环：周期性检查并挂起无活动的连接
      yield* Effect.gen(function* () {
        // 取当前时间作为判断基准
        const now = yield* Clock.currentTimeMillis
        // 遍历当前所有连接（快照），逐个尝试空闲挂起
        yield* Effect.forEach(
          [...connections.entries()],
          ([workspaceID, expected]) =>
            // 按工作区 ID 加锁，避免与连接/销毁操作竞争
            locks.withLock(workspaceID)(
              Effect.gen(function* () {
                // 重新读取连接：与遍历时的快照比对
                const connection = connections.get(workspaceID)
                // 连接已被替换/移除，或仍有人活跃使用（active > 0），则跳过
                if (connection !== expected || (yield* Ref.get(connection.active)) > 0) return
                // 读取最近活动时间
                const lastActivity = yield* Ref.get(connection.lastActivity)
                // 距上次活动未超过空闲阈值则跳过
                if (now - lastActivity < idleThreshold) return
                // 读取工作区行以获取当前绑定
                const row = yield* load(workspaceID)
                // 无绑定（异常情况）则跳过
                if (!row.binding) return
                // Deliberate: a racing spawn blocks, then wakes cleanly. Unlocking mid-suspend could reattach a sandbox being terminated.
                // 挂起空闲的工作区：并发进来的调用会阻塞等待，随后被干净地唤醒；若挂起中途放锁，可能把正在终止的沙箱重新接回
                yield* connection.driver.suspendForIdle({
                  workspaceID,
                  binding: row.binding,
                  saveBinding: connection.saveBinding,
                })
                // 用"最近活动时间"回写 last_used_at，保留真实使用痕迹
                yield* db
                  .update(WorkspaceTable)
                  .set({ last_used_at: lastActivity })
                  .where(eq(WorkspaceTable.id, workspaceID))
                  .run()
                  .pipe(Effect.orDie)
                // 从连接缓存中移除（下次 connect 会重新唤醒并打开）
                connections.delete(workspaceID)
                // 关闭连接私有作用域，释放其资源
                yield* Scope.close(connection.scope, Exit.void)
                // 挂起过程出错只记日志，不影响巡检循环
              }).pipe(Effect.catchCause((cause) => Effect.logError("workspace idle suspension failed", cause))),
            ),
          // 无并发上限，且不收集结果
          { concurrency: "unbounded", discard: true },
        )
        // 按轮询间隔重复执行整个巡检，并放入后台纤程
      }).pipe(Effect.repeat(Schedule.spaced(options.pollInterval ?? Duration.minutes(1))), Effect.forkScoped)

      // 返回服务实现
      return Service.of({
        // create：登记逻辑工作区（仅写数据库，不创建底层资源）
        create: Effect.fn("Workspace.create")(function* (input) {
          // 未显式指定 ID 时生成新 ID
          const workspaceID = input.id ?? ID.create()
          // 先查询同 ID 是否已存在（只取 provider 字段）
          const existing = yield* db
            .select({ provider: WorkspaceTable.provider })
            .from(WorkspaceTable)
            .where(eq(WorkspaceTable.id, workspaceID))
            .get()
            .pipe(Effect.orDie)
          // 已存在时：同提供方视为幂等成功，不同提供方则报冲突
          if (existing) {
            // 同提供方：直接返回该 ID
            if (existing.provider === input.provider) return workspaceID
            // 不同提供方：抛出创建冲突错误
            return yield* new CreateConflict({
              workspaceID,
              provider: input.provider,
              existingProvider: existing.provider,
            })
          }
          // 校验提供方存在（拿不到驱动会失败）
          yield* registry.get(input.provider)
          // 取当前时间作为创建与最近使用时间
          const now = yield* Clock.currentTimeMillis
          // 插入工作区行（绑定为 null，待 provision 填充）；冲突时静默不插入并取回结果
          const inserted = yield* db
            .insert(WorkspaceTable)
            .values({ id: workspaceID, provider: input.provider, binding: null, created_at: now, last_used_at: now })
            .onConflictDoNothing()
            .returning({ id: WorkspaceTable.id })
            .get()
            .pipe(Effect.orDie)
          // 插入成功即完成
          if (inserted) return workspaceID
          // 插入冲突（并发创建了同 ID 行）：重新读取该行
          const row = yield* load(workspaceID).pipe(Effect.orDie)
          // 若已有行的提供方与请求不同则报冲突
          if (row.provider !== input.provider)
            return yield* new CreateConflict({
              workspaceID,
              provider: input.provider,
              existingProvider: row.provider,
            })
          // 提供方一致，视为幂等成功
          return workspaceID
        }),
        // provision：暴露上面的共享供给实现
        provision,
        // connect：连接到工作区，返回可用的 spawner 与文件操作覆写
        connect: Effect.fn("Workspace.connect")(function* (workspaceID) {
          // 定义 acquire/release：进入时确保供给并打开连接（计数 +1），退出时计数 -1
          const acquire = Effect.acquireRelease(
            // A live connection implies the binding is already persisted, so skip the provision hop.
            // 已有活跃连接说明绑定已持久化，跳过供给步骤直接打开
            Effect.suspend(() => (connections.has(workspaceID) ? Effect.void : provision(workspaceID))).pipe(
              // 供给完成后，持锁打开连接并更新活动状态
              Effect.andThen(
                locks.withLock(workspaceID)(
                  Effect.gen(function* () {
                    // 打开（或复用）连接
                    const connection = yield* open(workspaceID)
                    // 刷新最近活动时间
                    yield* Ref.set(connection.lastActivity, yield* Clock.currentTimeMillis)
                    // 活跃引用计数 +1
                    yield* Ref.update(connection.active, (active) => active + 1)
                    // 把连接交给使用者
                    return connection
                  }),
                ),
              ),
            ),
            // 释放阶段：持锁把活跃计数 -1 并刷新活动时间
            (connection) =>
              locks.withLock(workspaceID)(
                Effect.gen(function* () {
                  // 活跃引用计数 -1
                  yield* Ref.update(connection.active, (active) => active - 1)
                  // 刷新最近活动时间
                  yield* Ref.set(connection.lastActivity, yield* Clock.currentTimeMillis)
                }),
              ),
          )
          // 构造 spawner：每次 spawn 前先 acquire（必要时唤醒工作区），再交给环境驱动执行命令
          const spawner = make((command) =>
            acquire.pipe(
              // 把获取连接的失败包装成系统错误（systemError）
              Effect.mapError((cause) =>
                systemError({
                  _tag: "Unknown",
                  module: "Workspace",
                  method: "spawn",
                  description: `Failed to wake workspace ${workspaceID}`,
                  cause,
                }),
              ),
              // 拿到连接后由环境驱动真正 spawn 命令
              Effect.flatMap((connection) => connection.environment.spawner.spawn(command)),
            ),
          )
          // 定义 withFiles：作用域化的文件操作辅助——acquire 后用连接的文件门面执行回调
          const withFiles = <A, E>(
            path: string,
            use: (files: Files) => Effect.Effect<A, E>,
          ): Effect.Effect<A, E | Failed> =>
            // 用 Effect.scoped 确保文件操作完成后释放连接引用
            Effect.scoped(
              acquire.pipe(
                // 把获取失败映射为 Failed 错误并携带路径
                Effect.mapError((cause) => new Failed({ path, cause })),
                // 用连接的文件实现执行具体操作
                Effect.flatMap((connection) => use(connection.files)),
              ),
            )
          // 组装文件操作覆写集合：每个方法都经由 withFiles 走活跃连接
          const overrides: FilesImpl = {
            read: (path, range) => withFiles(path, (files) => files.read(path, range)),
            write: (path, bytes) => withFiles(path, (files) => files.write(path, bytes)),
            stat: (path) => withFiles(path, (files) => files.stat(path)),
            list: (path) => withFiles(path, (files) => files.list(path)),
            remove: (path) => withFiles(path, (files) => files.remove(path)),
            move: (from, to) => withFiles(from, (files) => files.move(from, to)),
            mkdir: (path) => withFiles(path, (files) => files.mkdir(path)),
          }
          // 返回 spawner 与文件覆写
          return { spawner, overrides }
        }),
        // destroy：销毁工作区（底层资源 + 数据库行 + 活跃连接）
        destroy: Effect.fn("Workspace.destroy")(function* (workspaceID) {
          // Settling the shared attempt cancels its racing provision body and fails
          // waiters with NotFound before teardown commits. Accepted tradeoffs: if the
          // locked teardown below fails, those waiters saw NotFound for a workspace
          // that still exists (the next provision retries it), and a provision racing
          // this window may briefly succeed before teardown destroys its fresh binding.
          // 若有进行中的供给尝试：先结算为 NotFound，取消竞争中的供给流程并让等待者立即失败
          const attempt = attempts.get(workspaceID)
          if (attempt) {
            // 从登记中移除，防止其退出钩子重复结算
            attempts.delete(workspaceID)
            // 以 NotFound 失败结算 Deferred
            Deferred.doneUnsafe(attempt, Exit.fail(new NotFound({ workspaceID })))
          }
          // 持锁执行销毁流程
          return yield* locks.withLock(workspaceID)(
            Effect.gen(function* () {
              // 查询工作区行
              const row = yield* find(workspaceID)
              // 行不存在：无事可做，返回"未销毁"
              if (!row) return { destroyed: false }
              // 取出活跃连接（可能为空）
              const connection = connections.get(workspaceID)
              // 先从缓存移除，防止销毁期间被复用
              connections.delete(workspaceID)
              // 存在连接则关闭其作用域，释放资源
              if (connection) yield* Scope.close(connection.scope, Exit.void)
              // Null binding still reaches the driver: an interrupted or crashed
              // provision may have created a resource that was never persisted. A
              // provider missing from the registry cannot block deleting a
              // never-provisioned row.
              // 调用驱动销毁底层资源；绑定即使为 null 也要调用，以清理"创建了但未持久化"的残留资源
              yield* registry.get(row.provider).pipe(
                // 拿到驱动后执行销毁（携带当前绑定）
                Effect.flatMap((driver) => driver.destroy({ workspaceID, binding: row.binding })),
                // 注册表里找不到提供方时：若该行从未供给过（无绑定），忽略该错误继续删行；否则照常失败
                Effect.catchTag("WorkspaceDriver.ProviderNotFound", (error) =>
                  row.binding ? Effect.fail(error) : Effect.void,
                ),
              )
              // 删除数据库行
              yield* db.delete(WorkspaceTable).where(eq(WorkspaceTable.id, workspaceID)).run().pipe(Effect.orDie)
              // 返回"已销毁"
              return { destroyed: true }
            }),
          )
        }),
      })
    }),
  )

// 导出默认全局节点（无自定义参数）
export const node = configured()

// TODO(workspace-plan): add the boot janitor and ~23h safety snapshot rotation in a later PR.
// TODO(workspace-plan): make cold wake interruptible with a re-pin loop against janitor races.
// TODO(workspace-plan): consider extracting a keyed shared-attempt helper (join/cancel, drop-on-settle) beside
// KeyedMutex at end-of-series consolidation; filesystem/search.ts and session/run-coordinator.ts hand-roll the same
// shape. Audited stdlib alternatives (rc.111): RcMap fails twice (refcount release cancels in-flight work when the
// last waiter leaves, and one finalizer path cannot express idle-suspend vs destroy); Cache interrupts the shared
// lookup when its last awaiter is interrupted and cannot fail waiters with NotFound on invalidation.
