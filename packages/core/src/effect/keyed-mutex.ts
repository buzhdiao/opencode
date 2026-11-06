// 以命名空间形式整体导出本模块（放在顶部是为了与其他模块风格一致，避免循环引用时的初始化顺序问题）
export * as KeyedMutex from "./keyed-mutex.js"

// 从 effect 库导入 Effect（效果类型）与 Semaphore（信号量，用于互斥/限并发）
import { Effect, Semaphore } from "effect"

// KeyedMutex 接口：按键（key）加锁的互斥器类型定义
export interface KeyedMutex<in Key> {
  // 只读属性 size：一个返回当前锁条目数量的 Effect
  readonly size: Effect.Effect<number>
  // withLock：给定 key，返回一个高阶函数，把传入的 Effect 包裹成“持锁执行”的 Effect
  readonly withLock: (key: Key) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

/**
 * Creates an in-memory mutex with one lock per key. Entries are removed when no
 * holder or waiter remains.
 *
 *   same key      -> queue
 *   different key -> run independently
 *
 * `users` counts holders and waiters so an entry is not removed while a waiter
 * will reuse it.
 *
 * 中文说明：创建一个内存中的互斥器，每个 key 对应一把锁；当某个 key 既无持有者也无等待者时，
 * 其条目会从映射中移除。相同 key 排队串行执行，不同 key 互不影响独立运行；
 * `users` 同时统计持有者与等待者，确保还有等待者将来会复用该条目时不会被提前删除。
 */
export const makeUnsafe = <Key>(): KeyedMutex<Key> => {
  // 锁表：key -> { semaphore: 该 key 的二元信号量（容量 1，即互斥锁）, users: 持有者+等待者计数 }
  const locks = new Map<Key, { readonly semaphore: Semaphore.Semaphore; users: number }>()

  // withLock 高阶函数：对给定 key 包裹需要互斥执行的 effect
  const withLock =
    (key: Key) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      // 用 suspend 延迟到 effect 实际运行时才查表/建表，保证每次运行都取到最新状态
      Effect.suspend(() => {
        // 先查找该 key 已有的锁条目
        const current = locks.get(key)
        // 若不存在则新建条目（信号量容量为 1，即互斥锁），否则复用现有条目
        const entry = current ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 }
        // 新建的条目要写入锁表，供后续相同 key 的调用者复用（排队）
        if (!current) locks.set(key, entry)
        // 用户计数 +1（本调用现在是持有者或等待者），防止条目在等待期间被清理
        entry.users++
        // 用信号量的 withPermit 包裹 effect：同一时刻只允许一个 permit 持有者运行
        return entry.semaphore.withPermit(effect).pipe(
          // ensuring：无论 effect 成功、失败还是被中断，都会执行清理逻辑
          Effect.ensuring(
            Effect.sync(() => {
              // 用户计数 -1，表示本调用已结束
              entry.users--
              // 若再无持有者与等待者，则从锁表中删除该条目，避免内存无限增长
              if (entry.users === 0) locks.delete(key)
            }),
          ),
        )
      })

  // 返回接口实现：size 用 Effect.sync 惰性读取当前锁表大小；withLock 即上面的加锁函数
  return { size: Effect.sync(() => locks.size), withLock }
}

// 在 Effect 工作流内创建一个内存按键互斥器（把 makeUnsafe 包成 Effect）。
/** Creates an in-memory keyed mutex inside an Effect workflow. */
export const make = <Key>(): Effect.Effect<KeyedMutex<Key>> => Effect.sync(makeUnsafe<Key>)
