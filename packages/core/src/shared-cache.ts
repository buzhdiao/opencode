// 以命名空间（namespace）形式整体导出本模块，供其他模块以 SharedCache.xxx 的方式引用
export * as SharedCache from "./shared-cache.js"

// 引入 Effect 核心原语：Cause（错误原因）、Clock（时钟）、Context（依赖上下文）、Duration（时长）、
// Effect（受控程序）、Exit（执行结果）、Fiber（纤程）、FiberSet（纤程集合）、Layer（层）、Schedule（重试调度）
import { Cause, Clock, Context, Duration, Effect, Exit, Fiber, FiberSet, Layer, Schedule } from "effect"
// 引入 HTTP 客户端错误工具，用于识别可重试的瞬态错误
import { HttpClientError } from "effect/http"
// 引入哈希工具，用于把密钥转换成指纹
import { Hash } from "@opencode/util/hash"
// 引入构建全局单例服务节点的工具函数
import { makeGlobalNode } from "@opencode/util/effect/app-node"

// （中文）缓存结果默认的保鲜（fresh）时长，同时也是调用方默认的刷新周期；调用方也可以传入自己的周期。
/** How long a result stays fresh, and how often callers refresh, unless a caller passes its own. */
export const interval = Duration.minutes(10)

// 缓存读取的输入参数接口
export interface Input<A, E> {
  /** Everything that changes the answer, such as the connection and base URL. Never a raw secret: see `fingerprint`. */
  // 决定答案取值的全部要素（如连接、基础 URL）；绝不能放原始密钥——密钥请改用 `fingerprint` 指纹
  readonly key: string
  // 实际执行加载的效果（Effect），成功类型 A、失败类型 E
  readonly load: Effect.Effect<A, E>
  /** How long a result stays fresh. Defaults to `interval`; a caller refreshing on a timer uses the same value. */
  // 结果保鲜时长，默认取 `interval`；按定时器刷新的调用方应使用相同值
  readonly interval?: Duration.Input
  /** Skips the age check, but still joins a running load. */
  // 跳过新鲜度检查强制重新加载，但仍会合并（join）到已在进行的加载上
  readonly force?: boolean
}

// 缓存服务对外的接口定义
export interface Interface {
  /**
   * Returns the last result for `key` while it is fresh, otherwise joins the running load or starts one, so loads
   * never overlap per key. A load retries `transient` failures 3 times. A failure keeps the last good value, or
   * without one is returned, until the next interval. Interrupts and defects are never kept. Entries nobody asked
   * for in 24 hours, or in two of their intervals if longer, are dropped.
   */
  // （中文）`key` 的结果仍新鲜时直接返回上一次的结果；否则合并到正在进行的加载或启动一次新加载，
  // 保证同一 key 的加载绝不重叠。加载会对 `transient`（瞬态）失败重试 3 次。失败时保留上一次的好值
  // （若没有旧值则直接返回失败），直到下一个周期。中断与缺陷（defect）不会被保留。
  // 24 小时无人问津（或按其保鲜周期算更久）的条目会被丢弃。
  readonly get: <A, E>(input: Input<A, E>) => Effect.Effect<A, E>
}

// 定义 Effect 服务标记（tag）类，标签为 "@opencode/SharedCache"，用于从环境中请求该服务
export class Service extends Context.Service<Service, Interface>()("@opencode/SharedCache") {}

// 为缓存 key 中的密钥生成简短的单向指纹（取 SHA-256 前 16 位）：密钥原地更换后指纹变化，从而触发重新加载
/** A short, one-way stand-in for a secret in a cache key, so a secret changed in place loads again. */
export const fingerprint = (secret: string) => Hash.sha256(secret).slice(0, 16)

// （中文）判断是否为瞬态错误：超时，或 HTTP 408/429/500/502/503/504——口径与 Effect 的
// `HttpClient.retryTransient` 保持一致。
/** Network errors, timeouts and HTTP 408, 429, 500, 502, 503 or 504, as Effect's `HttpClient.retryTransient` counts them. */
export const transient = (error: unknown) =>
  Cause.isTimeoutError(error) ||
  (HttpClientError.isHttpClientError(error) &&
    (error.reason._tag === "TransportError" ||
      (error.reason._tag === "StatusCodeError" &&
        [408, 429, 500, 502, 503, 504].includes(error.reason.response.status))))

// 单个缓存条目的内部结构
interface Entry {
  // 最近一次完成的加载结果（exit）及其时间戳
  last?: { readonly exit: Exit.Exit<unknown, unknown>; readonly time: number }
  // 正在进行的加载纤程（fiber），空闲时为 undefined
  loading?: Fiber.Fiber<unknown, unknown>
  // 最近一次被读取的时间戳（毫秒）
  read: number
  // 无人读取多久（毫秒）后可以丢弃
  unread: number
}

// 未读过期时长：24 小时（换算为毫秒）
const unread = Duration.toMillis(Duration.hours(24))

// 构建服务 Layer：在这里创建并装配服务实现
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 创建带运行时的纤程集合（FiberSet runtime），用于在层内安全地启动后台加载纤程
    const run = yield* FiberSet.makeRuntime<never, unknown, unknown>()
    // 缓存主表：key -> 条目
    const entries = new Map<string, Entry>()

    // 实际执行一次加载：带指数退避重试，并按结果类别决定保留策略
    const start = Effect.fnUntraced(function* (key: string, entry: Entry, load: Effect.Effect<unknown, unknown>) {
      // 记录加载开始时间
      const time = yield* Clock.currentTimeMillis
      // 执行加载：遇到瞬态错误按指数退避（起始 1 秒）最多重试 3 次，最终结果捕获为 Exit
      const exit = yield* Effect.exit(
        Effect.retry(load, { schedule: Schedule.exponential("1 second"), times: 3, while: transient }),
      )
      // 更新条目的最近读取时间，供未读过期判断使用
      entry.read = yield* Clock.currentTimeMillis
      // 若仅因中断而失败（例如调用方被取消），原样向上传播，不保留任何值
      if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) return yield* exit
      // 普通失败时输出警告日志
      if (Exit.isFailure(exit)) yield* Effect.logWarning("failed to load shared value", { key, cause: exit.cause })
      // 若包含缺陷（defect，即非预期错误），直接抛出，不保留旧值
      if (Exit.isFailure(exit) && Cause.hasDies(exit.cause)) return yield* exit
      // 取出上一次的结果
      const previous = entry.last?.exit
      // 本次失败而上次成功时保留旧的成功值；否则记录本次结果
      entry.last = { exit: Exit.isFailure(exit) && previous && Exit.isSuccess(previous) ? previous : exit, time }
      // 返回最终保留的结果（成功或失败原样传播）
      return yield* entry.last.exit
    })

    // 对外提供的 get 实现
    const get = Effect.fnUntraced(function* <A, E>(input: Input<A, E>) {
      // 当前时间（毫秒）
      const now = yield* Clock.currentTimeMillis
      // 本次调用的新鲜期时长（毫秒），默认取全局 interval
      const age = Duration.toMillis(input.interval ?? interval)
      // 清理过期条目：不在加载中且距上次读取超过未读上限的直接删除
      for (const [key, item] of entries) if (!item.loading && now - item.read > item.unread) entries.delete(key)
      // 取出该 key 的条目；不存在则新建（未读上限默认 24 小时）
      const entry = entries.get(input.key) ?? { read: now, unread }
      // 把条目放回（或首次登记到）缓存表
      entries.set(input.key, entry)
      // 更新最近读取时间
      entry.read = now
      // A caller refreshing less often than daily must never find its entry dropped between two of its refreshes.
      // （中文）刷新周期长于半天的调用方，绝不能在两次刷新之间发现自己的条目被清理：未读上限至少取两倍新鲜期
      if (Number.isFinite(age)) entry.unread = Math.max(entry.unread, 2 * age)
      // 读取上次完成的结果
      const last = entry.last
      // The key decides the value's type, so a stored or joined result under the same key has this caller's types.
      // （中文）key 决定值的类型，因此同一 key 下存储或合并到的结果可以直接按本调用方的类型使用；
      // 非 force 且上次结果仍在新鲜期内时直接复用
      if (!input.force && last && now - last.time < age) return yield* last.exit as Exit.Exit<A, E>
      // Yield first so `entry.loading` is set before a synchronous load can finish and clear it.
      // （中文）先让出（yield）一次执行权，确保 `entry.loading` 赋值之后同步加载才可能完成并清空它
      // 仅当没有进行中的加载时才启动新的（??= 保证只启动一次）
      entry.loading ??= run(
        Effect.yieldNow.pipe(
          // 先让出一步，再执行完整的加载流程
          Effect.andThen(start(input.key, entry, input.load)),
          // 无论成败，加载结束时清空 loading 标记
          Effect.ensuring(
            Effect.sync(() => {
              entry.loading = undefined
            }),
          ),
        ),
      )
      // 合并（join）到正在进行的加载并等待其最终结果
      return yield* Fiber.join(entry.loading as Fiber.Fiber<A, E>)
    })

    // 用最终实现构造服务实例
    return Service.of({ get })
  }),
)

// 导出全局单例服务节点，供应用统一装配
export const node = makeGlobalNode({ service: Service, layer, deps: [] })
