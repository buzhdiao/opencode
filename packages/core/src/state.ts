// 以命名空间形式导出 State 模块
export * as State from "./state.js"

// 引入 Effect 原语：Cause（错误原因）、Context、Effect、Exit（执行结果）、Fiber（纤程）、Scope（作用域）
import { Cause, Context, Effect, Exit, Fiber, Scope } from "effect"

/**
 * A synchronous, replayable edit to the current domain state.
 *
 * Domain editors expose readable and writable state while preserving concise
 * plugin/config code. Transforms synchronously rebuild derived state.
 */
// （中文）对当前领域状态的一次同步、可重放的编辑。领域编辑器（editor）在保持插件/配置代码简洁的同时
// 暴露可读写的状态；变换（transform）会同步重建派生状态。
// 变换回调类型：拿到编辑器后就地修改
type TransformCallback<Editor> = (editor: Editor) => void
// 由基础状态构造编辑器的工厂类型
export type MakeEditor<State, Editor> = (state: State) => Editor

// 注册句柄：dispose 用于撤销注册
export interface Registration {
  readonly dispose: Effect.Effect<void>
}

/**
 * Registers a scoped transform. Reads rebuild by applying every registered transform in order.
 * Closing the owning Scope removes the transform and invalidates the current value.
 */
// （中文）注册一个带作用域的变换。读取时按注册顺序应用所有变换来重建；关闭所属 Scope（作用域）
// 即移除该变换并使当前值失效。
// 变换类型：接收编辑器回调，返回注册句柄（要求调用方提供 Scope）
export type Transform<Editor> = (
  transform: TransformCallback<Editor>,
) => Effect.Effect<Registration, never, Scope.Scope>

/** Invalidates the current value after captured inputs change and notifies like a registration would. */
// 重载（reload）类型：捕获的输入变化后使当前值失效，并像一次注册变更那样发出通知
export type Reload = () => Effect.Effect<void>

// 可变换接口：提供 transform 与 reload
export interface Transformable<Editor> {
  readonly transform: Transform<Editor>
  readonly reload: Reload
}

// 失败报告：状态名与原因
export interface Failure {
  readonly state: string
  readonly cause: unknown
}

// 组内注册项：移除函数与通知效果
type GroupedRegistration = {
  readonly remove: () => boolean
  readonly notify: Effect.Effect<void>
}

// 注册组：失败标记、成员集合与上报回调
type RegistrationGroup = {
  failed: boolean
  readonly registrations: Set<GroupedRegistration>
  readonly report: (failure: Failure, refresh: Effect.Effect<void>) => void
}

// “当前注册组”的 Context 引用，默认 undefined
const CurrentGroup = Context.Reference<RegistrationGroup | undefined>("@opencode/State/CurrentGroup", {
  defaultValue: () => undefined,
})

/**
 * Groups registrations without coupling State to plugin identity or asynchronous cleanup.
 * A failed group is detached synchronously; its supervisor must run refresh and close its scope.
 */
// （中文）把注册分组，避免 State 与插件身份或异步清理耦合。失败的组会被同步剥离；
// 由其监督方负责执行刷新并关闭作用域。
// （中文）创建一个注册组，并在 effect 执行期间以服务形式注入
export function group(report: RegistrationGroup["report"]) {
  // 组实例：初始无失败，成员为空
  const group: RegistrationGroup = { failed: false, registrations: new Set(), report }
  // 返回把 effect 放入该组上下文的包装函数
  return <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provideService(effect, CurrentGroup, group)
}

// （中文）同步停用一个组：移除其全部注册并汇总通知，交由上报方处理
function disable(group: RegistrationGroup, failure: Failure) {
  // 已停用则跳过
  if (group.failed) return
  // 标记组失败
  group.failed = true
  // 收集各注册的通知效果
  const notifications = new Set<Effect.Effect<void>>()
  // 遍历组内注册
  for (const registration of group.registrations) {
    // 移除注册
    registration.remove()
    // 记录其通知
    notifications.add(registration.notify)
  }
  // 上报失败与合并后的刷新通知
  group.report(
    failure,
    Effect.forEach(notifications, (notify) => notify, { discard: true }),
  )
}

// 通知批处理（batch）的内部状态
type Batch = {
  active: boolean
  readonly shutdown: boolean
  readonly notifications: Set<Effect.Effect<void>>
}

// “当前批处理”的 Context 引用，默认 undefined
const CurrentBatch = Context.Reference<Batch | undefined>("@opencode/State/CurrentBatch", {
  defaultValue: () => undefined,
})
/** Coalesces notifications until the effect completes. Reads inside stay fresh; nothing is rolled back. */
// （中文）批处理：把通知合并到 effect 结束时统一发出；内部的读取保持新鲜，不做任何回滚
export function batch<A, E, R>(effect: Effect.Effect<A, E, R>) {
  // 以非关停模式运行
  return run(effect, false)
}

/** Runs the effect as shutdown: States changed inside it close permanently and never notify again. */
// （中文）以关停（shutdown）模式运行：期间发生变更的 State 会永久关闭，且不再发出通知
export function shutdown<A, E, R>(effect: Effect.Effect<A, E, R>) {
  // 以关停模式运行
  return run(effect, true)
}

// batch/shutdown 的共同实现
function run<A, E, R>(effect: Effect.Effect<A, E, R>, shutdown: boolean) {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      // 读取当前批处理（若有）
      const current = yield* CurrentBatch
      // 已在活动批内且非关停时，直接嵌套执行即可（复用外层批）
      if (current?.active && !shutdown) return yield* restore(effect)
      // 新建批处理状态
      const batch: Batch = { active: true, shutdown, notifications: new Set() }
      // 在批上下文中执行目标 effect，并把结果捕获为 Exit
      const exit = yield* restore(effect.pipe(Effect.provideService(CurrentBatch, batch))).pipe(Effect.exit)
      // 批处理结束
      batch.active = false
      // A shutdown batch never collects notifications: changed() closes the State instead.
      // （中文）关停批从不收集通知：changed() 会直接把 State 关闭
      // 逐个执行收集到的通知（允许被中断）
      const notifications = yield* Effect.forEach(batch.notifications, (notify) => restore(notify).pipe(Effect.exit))
      // Aggregate ordinary failures across domains, while allowing cancellation to stop observer work.
      // （中文）跨领域聚合普通失败，同时允许用取消来中止观察者的工作
      yield* Exit.asVoidAll([exit, ...notifications])
      // 返回原 effect 的结果
      return yield* exit
    }),
  )
}

/**
 * A `notify` body that runs resource reconciliation in the owning layer's FiberSet and awaits it, so work
 * queued behind the layer's locks is interrupted with the layer. That interruption is not a failure.
 */
// （中文）一个 `notify` 通知体：在所属层的 FiberSet 中运行资源对账（reconcile）并等待其完成，
// 使排在层锁之后的工作随层一起被中断；这种中断不算失败。
export function reconcile(
  root: Scope.Scope,
  fork: (effect: Effect.Effect<void>) => Fiber.Fiber<void>,
  work: () => Effect.Effect<void>,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    // fork 到层内运行并等待其结束
    const exit = yield* Fiber.await(fork(work()))
    // 层已关闭且仅因中断而失败时，静默吞掉
    if (Exit.isFailure(exit) && root.state._tag === "Closed" && Cause.hasInterruptsOnly(exit.cause)) return
    // 其余结果原样传播（成功或失败）
    yield* exit
  })
}

/**
 * Runs `notify` only when the serialized projection of `project(state)` differs from the last
 * notified value. The first notification always runs so a freshly booted Location announces its
 * current catalog even when empty.
 */
// （中文）仅当 `project(state)` 的序列化投影与上次已通知的值不同时才运行 `notify`。
// 首次通知总是执行，确保新启动的 Location 即使内容为空也会广播其当前目录。
// （中文）构造带去重的通知函数
export function changes<State>(
  project: (state: State) => unknown,
  notify: (state: State) => Effect.Effect<void>,
): (state: State) => Effect.Effect<void> {
  // 上次已发布的序列化值
  let published: string | undefined
  // 返回实际的通知函数
  return (state) =>
    Effect.suspend(() => {
      // 计算当前投影的序列化值
      const next = JSON.stringify(project(state)) ?? ""
      // 与上次相同则跳过通知
      if (next === published) return Effect.void
      // 记录本次值
      published = next
      // 执行真正的通知
      return notify(state)
    })
}

// （中文）继承当前批处理上下文：返回把 effect 放入同一批的包装函数
export const inherit = Effect.fnUntraced(function* () {
  // 读取当前批
  const batch = yield* CurrentBatch
  // 返回注入批上下文的包装函数
  return <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provideService(effect, CurrentBatch, batch)
})

// 创建 State 的选项
export interface Options<State, Editor> {
  readonly name?: string
  /** Creates the empty base value for every rebuild. */
  // 每次重建时创建空的基础值
  readonly initial: () => State
  /** Wraps mutable state in a domain-specific editor API. */
  // 把可变状态包装成领域专属的编辑器 API
  readonly editor: MakeEditor<State, Editor>
  /**
   * Observes the freshly rebuilt value outside the read path. Every registration, disposal, or
   * reload notifies once it is applied; a batch coalesces them into one notification at its end.
   * Resource reconciliation owns its execution scope and coordination.
   */
  // （中文）在读取路径之外观察刚重建的值。每次注册、注销或重载都会在生效后通知一次；
  // 批处理会把它们合并为结束时的一次通知。资源对账自行负责执行作用域与协调。
  readonly notify?: (state: State) => Effect.Effect<void>
}

// State 对外接口
export interface Interface<State, Editor> extends Transformable<Editor> {
  /**
   * Rebuilds synchronously when transforms changed since the last read. Each rebuild produces a new
   * value and never touches earlier ones, so callers may retain what they read.
   */
  // （中文）自上次读取后有变换变化时同步重建。每次重建产出新值且不触碰旧值，调用方可保留读到的结果
  readonly get: () => State
  /** Marks a changed read-time dependency without scheduling another notification. */
  // 标记读取期依赖已变化，但不安排新的通知
  readonly invalidate: () => void
  /** Changes synchronously, including batched edits and grouped-registration removal. */
  // 以同步方式返回变更序号（含批内编辑与分组注册的移除）
  readonly revision: () => number
}

// （中文）创建一个 State 实例
export function create<State, Editor>(options: Options<State, Editor>): Interface<State, Editor> {
  // 当前缓存的基础状态
  let state = options.initial()
  // 已注册的变换集合（连同各自所属的组）
  const transforms = new Set<{ run: TransformCallback<Editor>; group: RegistrationGroup | undefined }>()
  // 是否需要重建
  let dirty = false
  // State 是否已永久关闭
  let closed = false
  // 变更序号（版本号）
  let version = 0

  // 使状态失效：标记脏并递增版本
  const invalidate = () => {
    dirty = true
    version++
  }

  // 读取（必要时重建）
  const get = () => {
    // 已关闭或不脏时直接返回缓存值
    if (closed || !dirty) return state
    // 重建循环：候选值在构造期间可能因嵌套读取而失效，需要重试
    while (true) {
      // 记录本轮开始的版本
      const started = version
      // 新建基础值与编辑器
      const next = options.initial()
      const editor = options.editor(next)
      // 依次应用全部变换
      for (const transform of transforms) {
        try {
          transform.run(editor)
        } catch (cause) {
          // 无组归属的变换失败直接抛出
          if (!transform.group) throw cause
          // 有组归属的失败：停用该组（其注册不再参与本轮）
          disable(transform.group, { state: options.name ?? "anonymous", cause })
        }
        // A nested read can disable a group that already contributed to this candidate.
        // （中文）嵌套读取可能停用一个已为本候选值做出贡献的组
        if (version !== started) break
      }
      // 版本发生变化则推倒重来
      if (version !== started) continue
      // Ungrouped failures still propagate; grouped failures restart from a fresh candidate.
      // （中文）无组的失败仍然向上传播；有组的失败则从新候选重来
      state = next
      dirty = false
      return state
    }
  }

  // One stable value per State, so a batch's notification Set holds it at most once.
  // （中文）每个 State 只有一个稳定的通知效果实例，因此批处理的通知集合里至多保留一次
  const notify: Effect.Effect<void> = Effect.gen(function* () {
    // 已关闭则不发通知
    if (closed) return
    // 先触发重建（如有必要）
    const value = get()
    // 调用可选的观察者
    if (options.notify) yield* options.notify(value)
  }).pipe(Effect.withSpan("State.notify"))

  // 变更入口：失效、批内合并或立即通知
  const changed = Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      // 已关闭则忽略
      if (closed) return
      // 标记失效并递增版本
      invalidate()
      // 读取当前批（若有）
      const batch = yield* CurrentBatch
      // 处于活动批内
      if (batch?.active) {
        // 关停批：本 State 永久关闭
        if (batch.shutdown) {
          closed = true
          return
        }
        // 普通批：把通知挂到批末统一执行（Set 保证去重）
        batch.notifications.add(notify)
        return
      }
      // 不在批内则立即通知
      yield* restore(notify)
    }),
  )

  // 返回接口实现
  return {
    get,
    invalidate,
    // 修订号即版本
    revision: () => version,
    // （中文）注册一个变换：加入集合、挂作用域终结器并立即通知
    transform: Effect.fn("State.transform")(function* (update) {
      // 为追踪在当前 span 上标注状态名
      yield* Effect.annotateCurrentSpan("state", options.name ?? "anonymous")
      // 取调用方作用域
      const scope = yield* Scope.Scope
      // 取当前注册组（若有）
      const group = yield* CurrentGroup
      // 组已失败则不再注册
      if (group?.failed) return { dispose: Effect.void }
      // 注册过程不可中断
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          // 构造变换记录
          const transform = { run: update, group }
          // 组内注册项：移除时同步删除并使状态失效
          const registration: GroupedRegistration = {
            remove: () => {
              if (!transforms.delete(transform)) return false
              group?.registrations.delete(registration)
              invalidate()
              return true
            },
            notify: changed,
          }
          // dispose：真正移除；若确有移除则再通知一次
          const dispose = Effect.uninterruptible(Effect.suspend(() => (registration.remove() ? changed : Effect.void)))
          // 加入变换集合
          transforms.add(transform)
          // 加入组（若有）
          group?.registrations.add(registration)
          // 作用域关闭时自动 dispose
          yield* Scope.addFinalizer(scope, dispose)
          // 注册即视为一次变更，立即通知
          yield* changed
          // 返回注册句柄
          return { dispose }
        }),
      )
    }),
    // 重载：等价于一次变更
    reload: () => changed,
  }
}
