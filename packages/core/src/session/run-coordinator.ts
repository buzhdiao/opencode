// 将本模块以命名空间形式整体导出为 SessionRunCoordinator
export * as SessionRunCoordinator from "./run-coordinator.js"

// effect：Deferred 一次性结果、Effect 运行时、Exit 结束值、Fiber 轻量线程、FiberSet 托管集合、Scope 作用域
import { Deferred, Effect, Exit, Fiber, FiberSet, Scope } from "effect"
// Promotable：收件箱中的提升级别（如 "input"/"steer"）
import type { Promotable } from "./inbox.js"

/** Serializes execution for each key while allowing different keys to run concurrently. */
// 协调器（Coordinator）：对每个 key 串行化执行，同时允许不同 key 并发运行
export interface Coordinator<Key, E, Reason = never> {
  /** Snapshots keys with an execution owned by this coordinator. */
  // 快照当前有执行占用的 key 集合
  readonly active: Effect.Effect<ReadonlySet<Key>>
  /** Snapshots keys genuinely draining: owned and not stopping. Settlement windows are excluded. */
  readonly draining: Effect.Effect<ReadonlySet<Key>>
  /** Checks ownership for one key, including cleanup and terminal settlement. */
  // 检查某个 key 是否仍被占用（含清理与终态结算阶段）
  readonly isActive: (key: Key) => Effect.Effect<boolean>
  /** Starts an execution while idle, or joins the active execution and returns its exit. */
  // 空闲则启动一次执行；已有执行则加入等待并得到其结束结果
  readonly run: (key: Key) => Effect.Effect<void, E>
  /** Rings the doorbell: an idle key starts an execution; an active one drains again before settling. */
  // 按门铃（doorbell）：空闲的 key 立即开始执行；进行中的 key 会在结算前再清空（drain）一轮
  readonly wake: (key: Key, scope?: Promotable) => Effect.Effect<void>
  /**
   * Stops the active execution and clears its doorbell. No-op when idle. Resolves once the
   * interruption is accepted, not when cleanup settles: the execution fiber finishes its
   * finalizers and settled hook on its own time. Returns whether an active execution was
   * interrupted.
   */
  // 中断执行并清掉门铃；空闲时是空操作。中断被接受即返回，不等待清理完成：
  // 执行 Fiber 会自行完成终结器与 settled 钩子。返回是否确有执行被中断
  readonly interrupt: (key: Key, reason?: Reason) => Effect.Effect<boolean>
  /** Why the key's execution is being stopped, once `interrupt` stopped it; undefined for teardown or when running. */
  readonly interruption: (key: Key) => Reason | undefined
  /** Resolves once no execution is active for the key. Returns immediately when already idle and never starts work. */
  // 等待 key 空闲；本就空闲时立即返回，绝不主动启动工作
  readonly awaitIdle: (key: Key) => Effect.Effect<void>
}

/**
 * One execution is a busy period for one key: one fiber that drains from the first wake
 * until the key would stay idle. `pendingWake` is the doorbell: work recorded during the
 * execution rings it with the scope that work needs, and the execution loop drains again
 * instead of ending. The doorbell closes the gap between a drain's last eligibility check
 * and the idle transition, since those cannot be one atomic step. `done` resolves joiners
 * with this execution's exit.
 */
// 一次执行（execution）就是某个 key 的一段忙碌期：一个 Fiber 从第一次唤醒开始清空，
// 直到 key 真正空闲。pendingWake 是门铃：执行期间进来的工作带着所需的作用域按铃，
// 执行循环会再清空一轮而不是结束。门铃弥补了「最后一次资格检查」与「转入空闲」之间
// 无法原子化的空档。done 用于把本次执行的结束结果交给所有加入等待者
type Execution<E, Reason> = {
  // 一次性结束结果：等待者用它获取本次执行的 exit
  readonly done: Deferred.Deferred<void, E>
  // 当前执行的所有者 Fiber（结算窗口期为 undefined）
  owner?: Fiber.Fiber<void>
  // 本轮清空使用的作用域
  scope: Promotable
  // 门铃：执行期间记录的待处理唤醒
  pendingWake?: Promotable
  // 是否正在停止（被中断）
  stopping: boolean
  // 中断原因
  interruptionReason?: Reason
}

/**
 * ```text
 *              wake | run
 *      idle ──────────────▶ execution (one fiber)
 *                             drain ⟲ doorbell rung mid-drain
 *                             │ exit (settled hook runs)
 *      doorbell quiet ◀───────┴───────▶ doorbell rung
 *      idle, waiters get exit          successor execution,
 *                                      waiters get this exit
 * ```
 */
// 创建协调器：drain 是每次清空的实现；started 在忙碌期开始时跑一次；settled 在结束时跑
export const make = <Key, E, Reason = never>(options: {
  readonly drain: (key: Key, force: boolean, scope: Promotable) => Effect.Effect<void, E>
  /** Runs once when a process-local busy period begins, before its first drain. */
  readonly started?: (key: Key) => Effect.Effect<void>
  /**
   * Runs in the execution fiber for every exit, including interruption, after the final
   * drain and before the execution settles (waiters resolve after it completes).
   */
  readonly settled?: (key: Key, exit: Exit.Exit<void, E>, reason?: Reason) => Effect.Effect<void>
}): Effect.Effect<Coordinator<Key, E, Reason>, never, Scope.Scope> =>
  Effect.gen(function* () {
    // 每个 key 当前/最近一次执行的登记表
    const executions = new Map<Key, Execution<E, Reason>>()
    // 托管 Fiber 运行时：fork 出的 Fiber 归当前作用域管理
    const fork = yield* FiberSet.makeRuntime<never, void, never>()

    // 执行循环：清空一轮 → 门铃响过则换新作用域并跳板式再来一轮，否则结束
    const loop = (key: Key, execution: Execution<E, Reason>, force: boolean): Effect.Effect<void, E> =>
      Effect.suspend(() => options.drain(key, force, execution.scope)).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            // 正在停止或门铃未响则结束循环
            if (execution.stopping || execution.pendingWake === undefined) return Effect.void
            // 换用门铃记录的作用域并清空门铃
            execution.scope = execution.pendingWake
            execution.pendingWake = undefined
            // Trampoline so drains that complete synchronously cannot grow the stack.
            // 跳板（trampoline）：先 yield 让出调用栈，防止同步完成的 drain 无限压栈
            return Effect.yieldNow.pipe(Effect.andThen(loop(key, execution, false)))
          }),
        ),
      )

    // 启动一次执行：登记执行并 fork 所有者 Fiber
    const start = (key: Key, force: boolean, scope: Promotable) => {
      // 创建执行记录
      const execution: Execution<E, Reason> = {
        done: Deferred.makeUnsafe<void, E>(),
        scope,
        stopping: false,
      }
      // 登记到表中，key 进入忙碌状态
      executions.set(key, execution)
      // The leading yield lets `owner` be assigned before the drain can settle, and keeps
      // failing self-waking executions from growing the stack across successor starts.
      // Drains start one tick after wake; callers observe progress through events or run.
      // 开头的 yield 确保 owner 在 drain 可能结算前完成赋值，也让自唤醒失败的执行
      // 不会跨后继启动无限压栈；drain 在唤醒后一拍才启动，调用方通过事件或 run 观察进度
      execution.owner = fork(
        Effect.yieldNow.pipe(
          // 先以不可中断方式跑 started 钩子
          Effect.andThen(Effect.uninterruptible(options.started?.(key) ?? Effect.void)),
          // 进入执行循环
          Effect.andThen(loop(key, execution, force)),
          // 第一段 onExit：清空 owner 并跑 settled 钩子
          Effect.onExit((exit) =>
            Effect.sync(() => {
              execution.owner = undefined
            }).pipe(Effect.andThen(options.settled?.(key, exit, execution.interruptionReason) ?? Effect.void)),
          ),
          // 第二段 onExit：结算执行（启动后继或转空闲），把结果交给等待者
          Effect.onExit((exit) => Effect.sync(() => settle(key, execution, exit))),
          Effect.exit,
          Effect.asVoid,
        ),
      )
      // 返回执行记录
      return execution
    }

    // A doorbell that survives the execution loop (rung after the loop decided to end, or
    // during failure or interruption cleanup) starts a fresh execution for the remaining work.
    // 活过执行循环的门铃（循环决定结束后、失败或中断清理期间按响）会为剩余工作启动全新执行
    const settle = (key: Key, execution: Execution<E, Reason>, exit: Exit.Exit<void, E>) => {
      // 门铃仍响着 → 用其作用域启动后继执行；否则把 key 移出表（转空闲）
      if (execution.pendingWake) start(key, false, execution.pendingWake)
      else executions.delete(key)
      // 把本次执行的结束结果交给所有等待者
      Deferred.doneUnsafe(execution.done, exit)
    }

    // key 是否在执行表中（含清理/结算窗口期）
    const isActive = (key: Key) => Effect.sync(() => executions.has(key))

    // run：空闲则强制启动一次执行并等待其结束；忙则加入等待
    const run = (key: Key): Effect.Effect<void, E> =>
      Effect.suspend(() => {
        // 查看当前执行
        const execution = executions.get(key)
        if (execution !== undefined) {
          // A stopping execution refuses joiners: wait out its cleanup, then run fresh.
          // 正在停止的执行拒绝加入者：等它清理完再全新运行
          if (execution.stopping)
            return Deferred.await(execution.done).pipe(Effect.ignoreCause, Effect.andThen(run(key)))
          // 加入当前执行：等待其结束结果
          return Deferred.await(execution.done)
        }
        // 空闲：以 "input" 作用域强制启动并等待结束
        return Deferred.await(start(key, true, "input").done)
      })

    // wake：按门铃。空闲立即启动；忙碌则记录待处理唤醒
    const wake = (key: Key, scope: Promotable = "input") =>
      Effect.sync(() => {
        // 查看当前执行
        const execution = executions.get(key)
        if (execution !== undefined) {
          // Coalesced wakes keep the widest scope: "input" subsumes "steer".
          // 合并唤醒时保留最宽作用域："input" 涵盖 "steer"
          execution.pendingWake = execution.pendingWake === "input" ? "input" : scope
          return
        }
        // 空闲：直接以给定作用域启动
        start(key, false, scope)
      })

    // interrupt：中断当前执行；返回是否确有执行被中断
    const interrupt = (key: Key, reason?: Reason): Effect.Effect<boolean> =>
      Effect.sync(() => {
        // 查看当前执行
        const execution = executions.get(key)
        // 空闲或已在停止中：无需中断
        if (execution === undefined || execution.stopping) return false
        if (execution.owner === undefined) {
          // Settlement window: the owner exited but the settled hook has not finished. The
          // terminal outcome is already decided, so no reason attaches — but the interrupt
          // still claims the recorded wakes so settle does not start a dead-intent successor.
          // 结算窗口期：owner 已退出但 settled 钩子未完成。终局已定故不附加原因，
          // 但中断仍要收走已记录的唤醒，避免 settle 启动一个已死意图的后继
          execution.pendingWake = undefined
          return false
        }
        // 标记停止中
        execution.stopping = true
        // Wakes recorded so far belong to the interrupted intent; the interrupt claims them.
        // Wakes arriving during cleanup are new admissions and restart normally at settle.
        // 此前记录的唤醒属于被中断的意图，由中断收走；
        // 清理期间新来的唤醒是新的准入，会在 settle 时正常重启
        execution.pendingWake = undefined
        // 记录中断原因
        execution.interruptionReason = reason
        // Fire and forget: nobody benefits from waiting out cleanup here, and callers like
        // the interrupt endpoint must acknowledge immediately even when finalizers are slow.
        // 发出即忘（fire and forget）：此处等待清理毫无收益，中断端点等调用方必须立即确认
        fork(Fiber.interrupt(execution.owner))
        // 已接受中断
        return true
      })

    // One execution's `done` already spans coalesced continuations; re-check after it
    // settles to cover a successor execution started by a late doorbell.
    // 一次执行的 done 已涵盖合并的后续；结算后需再检查，以覆盖迟到门铃启动的后继执行
    const awaitIdle = (key: Key): Effect.Effect<void> =>
      Effect.suspend(() => {
        // 查看当前执行
        const execution = executions.get(key)
        // 已空闲则直接返回
        if (execution === undefined) return Effect.void
        // 等待本次执行结束（忽略结果），再递归确认没有后继
        return Deferred.await(execution.done).pipe(Effect.ignoreCause, Effect.andThen(awaitIdle(key)))
      })

    const interruption = (key: Key) => executions.get(key)?.interruptionReason

    const draining = Effect.sync(
      () =>
        new Set(
          [...executions.entries()].flatMap(([key, execution]) =>
            execution.owner !== undefined && !execution.stopping ? [key] : [],
          ),
        ),
    )

    return {
      active: Effect.sync(() => new Set(executions.keys())),
      draining,
      isActive,
      run,
      wake,
      interrupt,
      interruption,
      awaitIdle,
    }
  })
