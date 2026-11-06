// 将本模块以命名空间 ModelRetry 的形式整体再导出
export * as ModelRetry from "./model-retry.js"

// 引入 AI 错误类型与“是否可重试”判断函数
import { AIError, isRetryable } from "@opencode/ai/effect"
// 引入 effect 的 Clock(时钟)、Duration(时长)、Effect、Pull(拉取迭代) 与 Schedule(调度) 工具
import { Clock, Duration, Effect, Pull, Schedule } from "effect"

// 定义决策输入接口：cause 为 AI 错误，retry 表示是否允许重试
interface Input {
  readonly cause: AIError
  readonly retry: boolean
}

/** Bound provider-requested delays so a hostile or buggy retry-after cannot stall a call for hours. */
// 限制提供商要求的重试延迟上限，防止恶意或有缺陷的 retry-after 把调用拖延数小时
const RETRY_AFTER_MAX = Duration.toMillis("15 minutes")

// retryAfter：读取提供商要求的重试等待毫秒数（仅限流/提供商内部错误才有），并夹在上限内
const retryAfter = (input: Input) => {
  // 只有 RateLimit（限流）或 ProviderInternal（提供商内部错误）会携带 retryAfterMs
  if (input.cause.reason._tag === "RateLimit" || input.cause.reason._tag === "ProviderInternal")
    // 未提供 retryAfterMs 返回 undefined；否则取其与上限中的较小值
    return input.cause.reason.retryAfterMs === undefined
      ? undefined
      : Math.min(input.cause.reason.retryAfterMs, RETRY_AFTER_MAX)
  // 其他错误类型没有 retry-after 信息
  return undefined
}

// Exponential from 2s capped at 10s per gap, for 10 retries: 2, 4, 8, then 10 × 7, about 84s of
// waiting when every attempt fails (67–101s with jitter). `min` takes the faster schedule, so the
// cap applies per gap; `max` with `recurs` bounds the count.
// 通用重试调度：间隔从 2 秒指数增长、每个间隔上限 10 秒，最多重试 10 次；全部失败约等 84 秒（含抖动 67-101 秒）
const schedule = Schedule.max([
  // min 取更快的调度：指数增长与 10 秒固定间隔取较小者，因此上限作用于每个间隔
  Schedule.min([Schedule.exponential("2 seconds"), Schedule.spaced("10 seconds")]),
  // recurs 把重试次数限制在 10 次
  Schedule.recurs(10),
]).pipe(
  // 给间隔加随机抖动（jitter），避免重试请求同步形成风暴
  Schedule.jittered,
  // 声明调度的输入类型为 Input
  Schedule.setInputType<Input>(),
  // 修改延迟：提供商要求更长的 retry-after 时取两者较大者
  Schedule.modifyDelay(({ input, duration: delay }) => {
    // 读取本次错误要求的最小等待毫秒数
    const minimum = retryAfter(input)
    // 无要求用原延迟；有要求则取原延迟与要求中的较大者
    const duration = minimum === undefined ? delay : Duration.max(delay, Duration.millis(minimum))
    // 返回向上取整后的毫秒延迟
    return Effect.succeed(Duration.millis(Math.ceil(Duration.toMillis(duration))))
  }),
)

// This machine has no network path to the provider: the host name didn't resolve, or there is no route or interface.
// While that lasts every attempt fails before reaching the provider, and the outage behind it (a router restart, a
// dropped VPN, a laptop between networks) usually outlasts the general allowance, so these retry on their own budget:
// exponential from 2s capped at 30s per gap, for up to an hour after the first one. A refused connection is left out:
// something answered, so it is the server's state.
// 本机到提供商没有网络路径（域名解析失败、无路由或无网卡）时单独用更长的重试预算：2 秒起指数增长、单次上限 30 秒、窗口 1 小时
const UNREACHABLE_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "ENETDOWN"])
// 导出不可达（unreachable）重试窗口：1 小时
export const UNREACHABLE_WINDOW = Duration.hours(1)
// 不可达重试的单次间隔上限：30 秒
const UNREACHABLE_GAP_MAX = 30_000

/** Whether the failure says this machine has no network path to the provider's host. */
// isUnreachable：判断错误是否表示本机无法连通提供商主机（传输层错误且错误码在集合中）
export const isUnreachable = (error: AIError) =>
  error.reason._tag === "Transport" && error.reason.code !== undefined && UNREACHABLE_CODES.has(error.reason.code)

// 不可达专用调度：同样 2 秒起指数增长，但单次间隔上限 30 秒
const unreachableSchedule = Schedule.max([
  // 指数增长与 30 秒固定间隔取较小者
  Schedule.min([Schedule.exponential("2 seconds"), Schedule.spaced(Duration.millis(UNREACHABLE_GAP_MAX))]),
  // 用 during 限定：只有失败发生在 1 小时窗口内才继续重试
  Schedule.during(UNREACHABLE_WINDOW),
]).pipe(
  // 给间隔加随机抖动
  Schedule.jittered,
  // 声明输入类型为 Input
  Schedule.setInputType<Input>(),
  // Jitter scales the capped gap by up to 1.2, so cap it again after.
  // 抖动可能把已达上限的间隔再放大 1.2 倍，因此修改延迟时再夹一次上限
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.millis(Math.min(Math.ceil(Duration.toMillis(duration)), UNREACHABLE_GAP_MAX))),
  ),
)

// A timed-out attempt already waited minutes before failing, so the general allowance would let a
// dead provider hold a call for most of an hour. Cap those attempts well below it.
// 超时的尝试本身已等了数分钟才失败；为避免死掉的提供商占住调用大半小时，把超时重试次数限制在远低于通用预算的水平
const MAX_TIMEOUT_RETRIES = 3

// policy：构造重试决策器——对每次失败返回“第几次尝试、等多久、是否还要重试”
export const policy = Effect.gen(function* () {
  // 把通用调度编译成可驱动的 step
  const step = yield* Schedule.toStep(schedule)
  // 把不可达专用调度也编译成 step
  const unreachable = yield* Schedule.toStep(unreachableSchedule)
  // 尝试计数器：首次调用记为第 1 次
  let attempt = 1
  // 超时错误次数计数器
  let timeouts = 0
  // 返回决策函数：输入失败信息，输出下一步决策
  return (input: Input) =>
    Effect.gen(function* () {
      // 取当前时间，作为调度步进的时钟基准
      const now = yield* Clock.currentTimeMillis
      // Unreachable failures don't spend the general allowance, so a flaky link that also drops streams keeps it.
      // 不可达失败走专用调度（不消耗通用预算），其余走通用调度；调度耗尽时 Pull 结束，返回 undefined
      const next = yield* (input.retry && isUnreachable(input.cause) ? unreachable : step)(now, input).pipe(
        Pull.catchDone(() => Effect.succeed(undefined)),
      )
      // 调度已耗尽：不再重试
      if (!next) return undefined
      // 解出下一次尝试的间隔时长
      const [, duration] = next
      // 尝试次数加一
      attempt++
      // 超时错误单独计数，用于限制超时重试次数
      if (input.cause.reason._tag === "Transport" && input.cause.reason.code === "Timeout") timeouts++
      // 返回决策：尝试序号、等待毫秒数，以及是否仍允许重试（超时次数未超上限）
      return {
        attempt,
        delay: Math.ceil(Duration.toMillis(duration)),
        retry: input.retry && timeouts <= MAX_TIMEOUT_RETRIES,
      }
    })
})

/** Retry a buffered model call from scratch; failed attempts never contribute to its returned output. */
// retry：从头重试一个带缓冲的模型调用；失败的尝试不会对其返回的输出有任何贡献
export const retry = <A, R>(effect: Effect.Effect<A, AIError, R>) =>
  Effect.gen(function* () {
    // 先构造重试决策器
    const decide = yield* policy
    // 无限循环：只有成功或“决定不再重试”才退出
    while (true) {
      // 执行效果并捕获结果（成功/失败都拿到，不中断）
      const result = yield* Effect.result(effect)
      // 成功则直接返回结果
      if (result._tag === "Success") return result.success
      // 失败则询问决策器：以通用可重试性作为是否允许重试的输入
      const decision = yield* decide({ cause: result.failure, retry: isRetryable(result.failure) })
      // 决策不允许重试：以原错误失败退出
      if (!decision?.retry) return yield* result.failure
      // 按决策给定的延迟等待后进入下一轮
      yield* Effect.sleep(Duration.millis(decision.delay))
    }
  })

// One-shot generations (stateless text, images, decisions) can be billed per attempt, so they retry only failures
// the provider never ran, a few times, with the same backoff and retry-after handling.
// 一次性生成（无状态文本、图片、决策）可能按尝试计费，因此只重试“提供商从未执行”的失败，且次数有限
const ONE_SHOT_RETRIES = 3
// Only codes that fail before a connection exists: a dropped interface or route can also fail a response already being read.
// 只收录“连接建立前”就失败的错误码：断网也可能让正在读取的响应失败，那种情况不能安全重试
const NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"])

// notRun：判断失败是否意味着提供商确实没有执行这次调用
const notRun = (error: AIError) => {
  // 读取提供商响应头中的 x-should-retry 覆盖标记
  const override = error.reason.http?.headers["x-should-retry"]
  // 提供商明确说可以重试
  if (override === "true") return true
  // 提供商明确说不可重试
  if (override === "false") return false
  const reason = error.reason
  // 限流错误：请求未被执行，可重试
  if (reason._tag === "RateLimit") return true
  // 提供商内部错误：仅 503（过载）或 529（容量满）可重试
  if (reason._tag === "ProviderInternal") return reason.http?.status === 503 || reason.http?.status === 529
  // 传输错误：请求未发出（not-sent）或命中“连接前失败”错误码时可重试
  if (reason._tag === "Transport")
    return reason.delivery === "not-sent" || (reason.code !== undefined && NOT_SENT_CODES.has(reason.code))
  // 其余情况一律视为已执行，不重试
  return false
}

/** Retry a one-shot call only when the provider clearly didn't run it: rate limits, overload, unreachable hosts. */
// retryOneShot：只在提供商明显未执行调用时重试一次性调用（限流、过载、主机不可达）
export const retryOneShot = <A, R>(effect: Effect.Effect<A, AIError, R>) =>
  Effect.gen(function* () {
    // 构造重试决策器
    const decide = yield* policy
    // 已用重试次数计数
    let retries = 0
    // 无限循环
    while (true) {
      // 执行并捕获结果
      const result = yield* Effect.result(effect)
      // 成功即返回
      if (result._tag === "Success") return result.success
      // 以 notRun 判定询问决策器
      const decision = yield* decide({ cause: result.failure, retry: notRun(result.failure) })
      // 决策不重试或次数已达上限：以原错误失败（注意 retries++ 是先比较后自增）
      if (!decision?.retry || retries++ >= ONE_SHOT_RETRIES) return yield* result.failure
      // 等待决策延迟后进入下一轮
      yield* Effect.sleep(Duration.millis(decision.delay))
    }
  })
