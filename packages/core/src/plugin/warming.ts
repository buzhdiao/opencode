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
import { Cause, Clock, Data, Deferred, Duration, Effect, FiberMap, Option, Schema, Stream } from "effect"
import { Config } from "../config.js"
// 引入模型解析函数（读取模型的缓存设置）
import { resolveModel } from "./optimize.js"

// 预热配置的宽松解码器：非法配置返回 None 而不报错
const decodeWarming = Schema.decodeUnknownOption(ConfigWarming.Warming)

// 预热默认值：保活提示词、间隔与总时长
const defaults = {
  // 保活请求使用的固定提示词
  prompt: "This is a keep-alive request. Do not perform any work or use tools. Reply with exactly: OK",
  interval: "auto" as "auto" | Duration.Duration,
  duration: Duration.minutes(30),
}

/** `ttl` is how long the provider keeps a cache entry after the request that last sent it. */
type Settings = typeof defaults & { interval: Duration.Duration; ttl: Duration.Duration }

/** Whether a session is warmed after a request, and why not. */
type Decision = Data.TaggedEnum<{
  Warm: { readonly settings: Settings }
  /** Neither the top-level `warming` nor the model's `cache.warming` turns it on. */
  Off: {}
  /** `"auto"` timing on a cache that lasts longer than `duration`, so no ping is needed before the window closes. */
  CacheOutlivesWindow: {}
  /** An explicit interval that isn't positive and shorter than a finite `duration`. */
  InvalidInterval: { readonly interval: Duration.Duration; readonly duration: Duration.Duration }
}>
const Decision = Data.taggedEnum<Decision>()

// The interval for "auto" when the model has no cache.ttl, a little under the five minutes most explicit caches last.
const fallbackInterval = Duration.minutes(4)
const fallbackTTL = Duration.minutes(5)

export const Plugin = define({
  // 插件唯一标识
  id: "opencode.warming",
  // 插件副作用主体
  effect: Effect.fn(function* (ctx) {
    // 获取配置服务
    const config = yield* Config.Service
    // A model's or provider's `cache.warming` overrides the top-level `warming`.
    const decide = Effect.fn("WarmingPlugin.decide")(function* (event: SessionHooks["context"]) {
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
      if (!(local ?? global)) return Decision.Off()
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
      const { duration } = settings
      const ttl = parseTTL(cache?.ttl)
      // "auto" pings at 90% of the cache's lifetime, so it lands before the cache expires.
      const interval =
        settings.interval === "auto" ? (ttl ? Duration.times(ttl, 0.9) : fallbackInterval) : settings.interval
      // A cache that outlives the window, such as "1h" with the 30-minute default, needs no keep-alive.
      if (
        settings.interval === "auto" &&
        Duration.isFinite(duration) &&
        Duration.isGreaterThanOrEqualTo(interval, duration)
      )
        return Decision.CacheOutlivesWindow()
      const valid =
        Duration.isFinite(duration) &&
        Duration.isGreaterThan(interval, Duration.zero) &&
        Duration.isLessThan(interval, duration)
      // Without a cache.ttl, an explicit interval longer than five minutes implies a cache that lasts at least that long.
      if (valid)
        return Decision.Warm({
          settings: { ...settings, interval, ttl: ttl ?? Duration.max(fallbackTTL, interval) },
        })
      return Decision.InvalidInterval({ interval, duration })
    })

    // Each warmed session's loop. A real request replaces it, and closing the plugin interrupts them all.
    const loops = yield* FiberMap.make<Session.ID>()
    // A ping during a model request would compete with it, which stalls single-slot local models. A request runs from
    // its context or compaction hook, because `session.step.started` waits for the first response chunk, until an end
    // event completes and removes its entry.
    const running = new Map<Session.ID, Deferred.Deferred<void>>()
    // Sessions already told their cache outlives the window; the check runs on every request.
    const outlived = new Set<Session.ID>()

    // The interval counts from when the latest request or ping was sent, since that is when the cache's lifetime starts.
    const warm = Effect.fn("WarmingPlugin.warm")(function* (sessionID: Session.ID, settings: Settings, sent: number) {
      const expires = sent + Duration.toMillis(settings.duration)
      while (true) {
        const due = Math.min(sent + Duration.toMillis(settings.interval), expires)
        yield* Effect.sleep(Duration.millis(due - (yield* Clock.currentTimeMillis)))
        if ((yield* Clock.currentTimeMillis) >= expires) return
        const request = running.get(sessionID)
        if (request) {
          // Ping as soon as the request ends, unless it outlasted the cache: then a ping would only write a new one,
          // so the next real request starts warming again.
          const remaining = sent + Duration.toMillis(settings.ttl) - (yield* Clock.currentTimeMillis)
          const ended = yield* Deferred.await(request).pipe(
            Effect.timeoutOption(Duration.millis(Math.max(0, remaining))),
          )
          if (Option.isNone(ended)) return
        }

        sent = yield* Clock.currentTimeMillis
        yield* Effect.logInfo("warming session", { sessionID })
        const result = yield* ctx.session
          .generate({ sessionID, prompt: settings.prompt })
          .pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.logWarning("failed to warm session", { sessionID, cause }).pipe(Effect.as(undefined)),
            ),
          )
        // A ping that wrote more than it read rebuilt the cache instead of keeping it, so later pings would keep
        // paying for that. Providers that report no cache usage never count as a miss.
        if (result && result.tokens.cache.read < result.tokens.cache.write)
          return yield* Effect.logInfo("stopped warming session after a cache miss", {
            sessionID,
            read: result.tokens.cache.read,
            write: result.tokens.cache.write,
          })
      }
    })

    const hook = (tracked: boolean) => (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
        const session = yield* ctx.session.get({ sessionID: event.sessionID }).pipe(Effect.orDie)
        if (session.parentID) return
        if (tracked && !running.has(event.sessionID)) running.set(event.sessionID, yield* Deferred.make<void>())
        const stop = FiberMap.remove(loops, event.sessionID)
        yield* Decision.$match(yield* decide(event), {
          Warm: ({ settings }) =>
            Effect.gen(function* () {
              // Our own ping runs these hooks too. Once generate exposes request metadata, tag it instead.
              if (text(event) === settings.prompt) return
              outlived.delete(event.sessionID)
              if (!(yield* FiberMap.has(loops, event.sessionID)))
                yield* Effect.logInfo("scheduled session warming", {
                  sessionID: event.sessionID,
                  interval: settings.interval,
                })
              // Replacing the loop restarts the interval and the window, and cancels a ping in flight.
              yield* FiberMap.run(
                loops,
                event.sessionID,
                warm(event.sessionID, settings, yield* Clock.currentTimeMillis),
              )
            }),
          Off: () => stop,
          InvalidInterval: (decision) =>
            Effect.logWarning("warming interval must be positive and shorter than a finite duration", {
              interval: decision.interval,
              duration: decision.duration,
            }).pipe(Effect.andThen(stop)),
          CacheOutlivesWindow: () =>
            Effect.gen(function* () {
              yield* stop
              if (outlived.has(event.sessionID)) return
              outlived.add(event.sessionID)
              yield* Effect.logInfo("not warming: the prompt cache outlives the warming window", {
                sessionID: event.sessionID,
                model: event.model,
              })
            }),
        })
      })
    yield* ctx.session.hook("context", hook(true))
    yield* ctx.session.hook("compaction", hook(true))
    // Generate requests report no end, so they don't count as running.
    yield* ctx.session.hook("generate", hook(false))

    // A turn always ends with an execution event and a compaction with its own, so a request that ends without its
    // own event can't stay running past them.
    yield* ctx.event
      .subscribe({
        types: [
          "session.step.streamed",
          "session.step.failed",
          "session.compaction.ended",
          "session.compaction.failed",
          "session.execution.succeeded",
          "session.execution.failed",
          "session.execution.interrupted",
          "session.deleted",
        ],
      })
      .pipe(
        // 对每个事件更新会话状态
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            const sessionID = event.data.sessionID
            const request = running.get(sessionID)
            running.delete(sessionID)
            if (request) yield* Deferred.succeed(request, undefined)
            if (event.type !== "session.deleted") return
            outlived.delete(sessionID)
            yield* FiberMap.remove(loops, sessionID)
          }),
        ),
        // 后台分支立即启动，托管于当前作用域
        Effect.forkScoped({ startImmediately: true }),
      )
  }),
})

function text(event: SessionHooks["context"]) {
  const message = event.messages.at(-1)
  if (message?.role !== "user" || message.content.length !== 1) return
  const part = message.content[0]
  return part?.type === "text" ? part.text : undefined
}

const units = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }

function parseTTL(ttl: Provider.CacheTTL | undefined) {
  const match = ttl?.match(/^([\d.]+)(ms|s|m|h|d)$/)
  if (match) return Duration.millis(Number(match[1]) * units[match[2] as keyof typeof units])
}
