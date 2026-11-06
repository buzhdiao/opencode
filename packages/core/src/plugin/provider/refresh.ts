// 以命名空间形式整体导出本模块（供外部以 ProviderRefresh.xxx 调用）
export * as ProviderRefresh from "./refresh.js"

// 从 effect 库导入所需的原语：时长、Effect、相等判断、Fiber 管理等
import { Duration, Effect, Equal, Fiber, FiberHandle, Scope, Semaphore, Stream } from "effect"
// 导入事件总线（Bus）服务
import { Bus } from "../../bus.js"
// 导入凭据（Credential）模块
import { Credential } from "../../credential.js"
// 导入集成连接工具
import { IntegrationConnection } from "../../integration/connection.js"
// 导入跨 Location 共享缓存服务
import { SharedCache } from "../../shared-cache.js"

// Connection 类型：IntegrationConnection.key 的入参类型（活跃连接或 undefined）
type Connection = Parameters<typeof IntegrationConnection.key>[0]

/** How a load asks `SharedCache.get` for its list. */
/** load 请求 SharedCache.get 时的选项：缓存有效期与是否强制刷新。 */
export type Options = { readonly interval?: Duration.Input; readonly force?: boolean }

/** Runs `effect` each time the active credential of `integrationID` switches, until the scope closes. */
/** 每当 `integrationID` 的活跃凭据发生切换时就运行一次 `effect`，作用域关闭前持续生效。 */
export const onSwitch = <E, R>(integrationID: string, effect: Effect.Effect<unknown, E, R>) =>
  Effect.gen(function* () {
    // 获取事件总线服务
    const bus = yield* Bus.Service
    // 订阅“凭据已切换”事件流：过滤出目标集成，逐事件执行 effect，并挂到当前作用域后台运行
    yield* bus.subscribe(Credential.Event.Switched).pipe(
      Stream.filter((event) => event.data.integrationID === integrationID),
      Stream.runForEach(() => effect),
      Effect.forkScoped({ startImmediately: true }),
    )
  })

/** Runs `reload` when `load` reports that the derived state changed. */
/** 当 `load` 报告派生状态发生变化时才执行 `reload`。 */
export const reloadIfChanged = <E, R>(load: Effect.Effect<boolean, E, R>, reload: Effect.Effect<void>) =>
  load.pipe(Effect.flatMap((changed) => (changed ? reload : Effect.void)))

/**
 * After an account switch, applies the account's list from the cache at once, however old, while a forced load runs
 * alongside and is applied when it finishes. With nothing cached the first step joins the forced load, so one request
 * serves both; after a failed load the forced load is the retry.
 */
/**
 * 账号切换后：先立即应用缓存里该账号的列表（无论多旧），同时并行发起一次强制加载，
 * 加载完成后再应用新结果。若缓存为空，第一步会与强制加载合并，一次请求两步共用；
 * 若上次加载失败，这次强制加载就充当重试。
 */
export const switched = <A>(load: (options: Options) => Effect.Effect<A>, apply: (next: A) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    // 后台 fork 一次强制加载（不等它完成）
    const fresh = yield* load({ force: true }).pipe(Effect.forkChild({ startImmediately: true }))
    // 用“永不过期”的 interval 读缓存并立即应用旧值
    yield* load({ interval: Duration.infinity }).pipe(Effect.flatMap(apply))
    // 等待强制加载完成后应用新值
    yield* Fiber.join(fresh).pipe(Effect.flatMap(apply))
  })

/**
 * Keeps a Location's copy of a provider's shared list current: loads in the background at startup, on an account
 * switch (see `switched`) and every `interval`, and reloads providers only when the value changed. `load` passes the
 * options it gets to `SharedCache.get`. A switch replaces a waiting load. A value loaded for a connection that is no
 * longer active is dropped.
 */
/**
 * 让某个 Location 持有的提供商共享列表保持最新：启动时、账号切换时（见 `switched`）
 * 以及每个 `interval` 周期都在后台加载，只有值真正变化时才重载提供商。`load` 收到的
 * 选项会原样传给 `SharedCache.get`。切换会取代仍在等待的加载；为已不再活跃的连接
 * 加载出的值会被丢弃。
 */
export const start = Effect.fnUntraced(function* <A>(input: {
  // 关联的集成 ID
  readonly integrationID: string
  // 初始状态值
  readonly initial: A
  // 可选的轮询间隔
  readonly interval?: Duration.Input
  // 读取当前活跃连接的 Effect
  readonly active: Effect.Effect<Connection>
  // 执行一次加载：返回来源连接与加载到的值
  readonly load: (current: A, options: Options) => Effect.Effect<{ readonly connection: Connection; readonly value: A }>
  // 状态变化时执行的重载动作
  readonly reload: Effect.Effect<void>
}): Effect.fn.Return<{ readonly current: A }, never, Bus.Service | Scope.Scope> {
  // 轮询间隔默认取共享缓存的全局默认值
  const interval = input.interval ?? SharedCache.interval
  // 创建并发数为 1 的信号量，串行化状态写入
  const lock = Semaphore.makeUnsafe(1)
  // 用于跟踪正在进行的加载 Fiber，可随时替换
  const loading = yield* FiberHandle.make<void, never>()
  // 可变状态：当前已应用的值
  const state = { current: input.initial }
  // apply：在锁与不可中断保护下应用新值
  const apply = (next: { readonly connection: Connection; readonly value: A }) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          // 加载结果对应的连接已不再活跃，丢弃该值
          if (IntegrationConnection.key(next.connection) !== IntegrationConnection.key(yield* input.active)) return
          // 值与当前状态深度相等则无需重载
          if (Equal.equals(next.value, state.current)) return
          // 更新状态并触发提供商重载
          state.current = next.value
          yield* input.reload
        }),
      )
      // 应用过程不可被中断，避免半更新状态
      .pipe(Effect.uninterruptible)
  // load：延迟执行，每次调用都读取最新的 state.current 并合并默认选项
  const load = (options: Options) => Effect.suspend(() => input.load(state.current, { interval, ...options }))
  // refresh：一次普通（非强制）加载并应用
  const refresh = load({}).pipe(Effect.flatMap(apply))
  // 账号切换时：用 switched(load, apply) 取代正在进行的加载
  yield* onSwitch(input.integrationID, FiberHandle.run(loading, switched(load, apply)))
  // 启动时立即执行一次 refresh（若当前没有加载在跑）
  yield* FiberHandle.run(loading, refresh, { onlyIfMissing: true }).pipe(Effect.forkScoped)
  // 周期性 refresh：sleep 到间隔后触发一次（不抢占进行中的加载），无限循环，后台运行
  yield* Effect.sleep(interval).pipe(
    Effect.andThen(FiberHandle.run(loading, refresh, { onlyIfMissing: true })),
    Effect.forever,
    Effect.forkScoped,
  )
  // 返回可读取当前值的 state 句柄
  return state
})
