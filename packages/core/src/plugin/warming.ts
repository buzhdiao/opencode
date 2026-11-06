// 将本模块以命名空间 `WarmingPlugin` 全量导出
export * as WarmingPlugin from "./warming.js"

// 引入插件定义工具 define
import { define } from "@opencode/plugin/effect/plugin"
// 引入会话钩子类型（仅类型）
import type { SessionHooks } from "@opencode/plugin/effect/session"
// 引入提供方 schema 类型（CacheTTL，仅类型）
import type { Provider } from "@opencode/schema/provider"
// 引入会话 schema 类型（仅类型）
import type { Session } from "@opencode/schema/session"
// 引入预热配置 schema
import { ConfigWarming } from "@opencode/schema/config/warming"
// 引入 Effect 原语：Clock（时钟）、Duration、Option、Schema、Scope（作用域）、Stream
import { Clock, Duration, Effect, Option, Schema, Scope, Stream } from "effect"
// 引入配置服务
import { Config } from "../config.js"
// 引入模型解析函数（读取模型的缓存设置）
import { resolveModel } from "./optimize.js"

// 预热配置的宽松解码器：非法配置返回 None 而不报错
const decodeWarming = Schema.decodeUnknownOption(ConfigWarming.Warming)

// 预热默认值：保活提示词、间隔与总时长
const defaults = {
  // 保活请求使用的固定提示词
  prompt: "This is a keep-alive request. Do not perform any work or use tools. Reply with exactly: OK",
  // 默认间隔 4 分钟
  interval: Duration.minutes(4),
  // 默认持续 30 分钟
  duration: Duration.minutes(30),
}

// 定义会话预热插件：定期向空闲会话发送保活请求以维持提示词缓存
export const Plugin = define({
  // 插件唯一标识
  id: "opencode.warming",
  // 插件副作用主体
  effect: Effect.fn(function* (ctx) {
    // 获取配置服务
    const config = yield* Config.Service
    // A model's or provider's `cache.warming` overrides the top-level `warming`.
    // 读取预热设置：模型/提供方的 cache.warming 优先于顶层 warming 配置
    const loadSettings = Effect.fn("WarmingPlugin.loadSettings")(function* (event: SessionHooks["context"]) {
      // Warming must never fail the request it hooks, so an unreadable catalog falls back to the top-level setting.
      // 预热绝不能使其挂钩的请求失败：模型目录不可读时回退到顶层设置
      const cache = (yield* resolveModel(ctx, event).pipe(Effect.orElseSucceed(() => undefined)))?.settings?.cache
      // 解析模型级 warming 配置（非法时为 undefined）
      const local = cache?.warming === undefined ? undefined : Option.getOrUndefined(decodeWarming(cache.warming))
      // 模型级配置存在但非法：记录警告并回退顶层
      if (cache?.warming !== undefined && local === undefined)
        yield* Effect.logWarning("invalid cache.warming setting; using the top-level warming setting", {
          model: event.model,
        })
      // 读取顶层 warming 配置
      const global = Config.latest(yield* config.entries(), "warming")
      // 两级配置都未启用则不预热
      if (!(local ?? global)) return
      // The keep-alive prompt is only set at the top level; a model's setting changes timing.
      // 保活提示词只在顶层设置；模型级设置只调整时间参数
      const settings = {
        // 默认值打底
        ...defaults,
        // 覆盖顶层对象配置
        ...(typeof global === "object" ? global : {}),
        // 再覆盖模型级对象配置
        ...(typeof local === "object" ? local : {}),
      }
      // 间隔为 "auto" 时按缓存 TTL 推算
      const interval = settings.interval === "auto" ? autoInterval(cache?.ttl) : settings.interval
      // "auto" 在没有 cache.ttl 的模型上不预热
      // "auto" doesn't warm a model without a cache.ttl.
      if (interval === undefined) return
      // 读取持续时长
      const { duration } = settings
      // 校验：时长有限、间隔为正、间隔短于时长
      const valid =
        Duration.isFinite(duration) &&
        Duration.isGreaterThan(interval, Duration.zero) &&
        Duration.isLessThan(interval, duration)
      // 校验通过则返回最终设置
      if (valid) return { ...settings, interval }
      // 校验失败记录警告并不预热
      yield* Effect.logWarning("warming interval must be positive and shorter than a finite duration", {
        interval,
        duration,
      })
    })

    // 获取当前作用域：后台预热循环托管于此
    const scope = yield* Scope.Scope
    // 会话预热状态表：会话 ID -> 上次保活时间/过期时间/设置
    const sessions = new Map<Session.ID, { last: number; expires: number; settings: typeof defaults }>()
    // A ping during a model request would compete with the request it keeps warm, which stalls single-slot local models.
    // A request counts from its context hook, because `session.step.started` waits for the first response chunk.
    // 正在请求的会话集合：预热 ping 会与被保活的请求争抢资源，卡死单槽位本地模型；从 context 钩子开始计数，
    // 因为 session.step.started 要等第一个响应块
    const requesting = new Set<Session.ID>()
    // A turn always ends with an execution event, so a step that ends without its own event can't stay in flight.
    // 订阅执行事件：一轮总以执行事件收尾，未收到自身结束事件的步骤不可能仍在进行
    yield* ctx.event
      .subscribe({
        types: [
          "session.step.streamed",
          "session.step.failed",
          "session.execution.succeeded",
          "session.execution.failed",
          "session.execution.interrupted",
        ],
      })
      .pipe(
        // 对每个事件更新会话状态
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            // 从"请求中"集合移除该会话
            requesting.delete(event.data.sessionID)
            // Count the next interval from the end of the response, not from when a long request started.
            // 下一个间隔从响应结束起算，而不是从长请求开始起算
            const current = sessions.get(event.data.sessionID)
            // 更新该会话的 last 时间戳
            if (current) current.last = yield* Clock.currentTimeMillis
          }),
        ),
        // 后台分支立即启动，托管于当前作用域
        Effect.forkScoped({ startImmediately: true }),
      )
    // 预热循环：按设置间隔对会话发保活请求
    const loop: (sessionID: Session.ID) => Effect.Effect<void> = Effect.fn("WarmingPlugin.loop")(
      function* (sessionID) {
        // 读取会话状态
        const current = sessions.get(sessionID)
        // 状态已被移除则结束循环
        if (!current) return

        // 当前时间
        const now = yield* Clock.currentTimeMillis
        // 下次触发时间：上次保活 + 间隔，且不超过过期时间
        const next = Math.min(current.last + Duration.toMillis(current.settings.interval), current.expires)
        // 还没到时间：睡到下次触发后递归
        if (now < next) {
          yield* Effect.sleep(Duration.millis(next - now))
          return yield* loop(sessionID)
        }
        // 已过有效期：移除状态并结束循环
        if (now >= current.expires) {
          sessions.delete(sessionID)
          return
        }
        // 会话正被真实请求占用：稍后重试，避免争抢
        if (requesting.has(sessionID)) {
          yield* Effect.sleep(current.settings.interval)
          return yield* loop(sessionID)
        }

        // 记录本次保活前的 last 值
        const last = current.last
        // 记录预热日志
        yield* Effect.logInfo("warming session", { sessionID, last })
        // 发送保活请求；失败仅记警告
        yield* ctx.session
          .generate({ sessionID, prompt: current.settings.prompt })
          .pipe(Effect.catchCause((cause) => Effect.logWarning("failed to warm session", { sessionID, cause })))
        // 保活完成后更新 last：仅当状态未被并发改动（仍是同一对象且 last 未变）
        const latest = sessions.get(sessionID)
        if (latest === current && latest.last === last) latest.last = yield* Clock.currentTimeMillis
        // 继续下一轮
        return yield* loop(sessionID)
      },
    )

    // 会话钩子：登记会话预热（刷新或新建）
    const hook = (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
        // 获取会话（获取失败直接中止）
        const session = yield* ctx.session.get({ sessionID: event.sessionID }).pipe(Effect.orDie)
        // 子会话不单独预热，跟随父会话
        if (session.parentID) return

        // 现有预热状态
        const active = sessions.get(event.sessionID)
        // 读取最终设置
        const settings = yield* loadSettings(event)
        // 设置不可用：移除预热并退出
        if (!settings) {
          sessions.delete(event.sessionID)
          return
        }

        // Once generate exposes request metadata to context hooks, tag warm requests instead of matching the prompt.
        // 待 generate 向 context 钩子暴露请求元数据后，应改为打标记而非匹配提示词
        const message = event.messages.at(-1)
        // 检测最后一条用户消息是否是保活提示词（旧或新设置）
        if (
          message?.role === "user" &&
          message.content.length === 1 &&
          message.content[0]?.type === "text" &&
          (message.content[0].text === active?.settings.prompt || message.content[0].text === settings.prompt)
        ) {
          // 是保活请求：仅同步设置，不重置计时
          if (active) active.settings = settings
          return
        }

        // 当前时间
        const now = yield* Clock.currentTimeMillis
        // 有效期毫秒数
        const duration = Duration.toMillis(settings.duration)
        // 已有预热状态：刷新计时与设置
        if (active) {
          active.last = now
          active.expires = now + duration
          active.settings = settings
          return
        }
        // 新建预热状态
        sessions.set(event.sessionID, { last: now, expires: now + duration, settings })
        // 记录排期日志
        yield* Effect.logInfo("scheduled session warming", {
          sessionID: event.sessionID,
          interval: settings.interval,
          expires: now + duration,
        })
        // 在当前作用域内启动预热循环，失败仅记错误
        yield* loop(event.sessionID).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("session warming loop failed", { sessionID: event.sessionID, cause }),
          ),
          Effect.forkIn(scope),
        )
      })
    // context 钩子：先标记"请求中"再执行登记逻辑
    yield* ctx.session.hook("context", (event) =>
      Effect.sync(() => requesting.add(event.sessionID)).pipe(Effect.andThen(hook(event))),
    )
    // 压缩与生成阶段同样触发登记
    yield* ctx.session.hook("compaction", hook)
    yield* ctx.session.hook("generate", hook)
  }),
})

// 时间单位到毫秒的换算表
const units = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }

/** 90% of a cache TTL such as "5m", so the ping lands before the cache expires. */
// 按缓存 TTL（如 "5m"）的 90% 推算预热间隔，保证 ping 落在缓存过期之前
function autoInterval(ttl: Provider.CacheTTL | undefined) {
  // 匹配"数字 + 单位"格式
  const match = ttl?.match(/^([\d.]+)(ms|s|m|h|d)$/)
  // 命中则返回数值 x 单位毫秒 x 0.9 的时长
  if (match) return Duration.millis(Number(match[1]) * units[match[2] as keyof typeof units] * 0.9)
}
