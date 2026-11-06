// 将本模块以命名空间 LocationActivity 的形式整体再导出
export * as LocationActivity from "./location-activity.js"

// 从 effect 引入 Clock(时钟)、Context、Duration(时长)、Effect、Layer、Option(可选值)、RcMap(引用计数缓存)、Schema
import { Clock, Context, Duration, Effect, Layer, Option, RcMap, Schema } from "effect"
// 仅引入类型：Document（配置文档条目）
import type { Document } from "@opencode/schema/config"
// 以下引入依赖服务：总线、配置、后台任务、位置、位置生命周期、位置服务映射、会话事件/执行/存储
import { Bus } from "./bus.js"
import { Config } from "./config.js"
import { Job } from "./job.js"
import { Location } from "./location.js"
import { LocationLifecycle } from "./location-lifecycle.js"
import { LocationServiceMap } from "./location-service-map.js"
import { SessionEvent } from "./session/event.js"
import { SessionExecution } from "./session/execution.js"
import { SessionStore } from "./session/store.js"
// 引入全局节点构造器
import { makeGlobalNode } from "@opencode/util/effect/app-node"

// 构造类型守卫：判断事件是否为持久化（Durable）会话事件
const isSessionEvent = Schema.is(SessionEvent.Durable)

// 定义位置活跃度（LocationActivity）服务类：无方法，仅作为空闲清理器的标记与挂载点
export class Service extends Context.Service<Service, {}>()("@opencode/LocationActivity") {}

// 构建服务层工厂：可自定义 timeToLive（空闲存活时长）与 sweepInterval（巡检间隔）
export function layer(options: { readonly timeToLive?: Duration.Input; readonly sweepInterval?: Duration.Input } = {}) {
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      // 获取时钟服务，用于读取当前时间戳
      const clock = yield* Clock.Clock
      // 获取事件总线服务
      const bus = yield* Bus.Service
      // 获取位置服务映射（缓存所有已加载位置的服务层）
      const locations = yield* LocationServiceMap.Service
      // 获取会话执行服务（查询活跃会话）
      const execution = yield* SessionExecution.Service
      // 获取后台任务服务
      const jobs = yield* Job.Service
      // 获取会话存储服务
      const sessions = yield* SessionStore.Service
      // 计算空闲存活时长：未配置时默认 60 分钟
      const timeToLive = Duration.fromInputUnsafe(options.timeToLive ?? "60 minutes")
      // 活跃度记录表：键为位置键字符串，值为位置引用与最后触碰时间 touchedAt
      const entries = new Map<string, { readonly ref: Location.Ref; touchedAt: number }>()
      // 计算位置的唯一键：规范化目录 + 空字符 \0 分隔 + workspaceID（无则空串）
      const key = (ref: Location.Ref) => `${LocationServiceMap.canonical(ref).directory}\0${ref.workspaceID ?? ""}`
      // touch：同步刷新某位置的活跃时间戳
      const touch = (ref: Location.Ref) =>
        Effect.sync(() => {
          entries.set(key(ref), { ref, touchedAt: clock.currentTimeMillisUnsafe() })
        })

      // Read per location so project config can override the global value.
      // idleTimeout：按位置读取空闲超时——允许项目级配置覆盖全局默认值
      const idleTimeout = (ref: Location.Ref) =>
        Effect.gen(function* () {
          // 尝试获取该位置的上下文（未加载时返回 None）
          const context = yield* locations.contextEffectOption(ref)
          // 没有上下文则直接使用全局默认时长
          if (Option.isNone(context)) return timeToLive
          // 读取该位置配置服务的条目列表
          const entries = yield* Context.get(context.value, Config.Service).entries()
          // 从后往前找最后一条带 location_idle_timeout 实验配置的文档条目
          const configured = entries.findLast(
            (entry): entry is Document =>
              entry.type === "document" && entry.info.experimental?.location_idle_timeout !== undefined,
          )
          // 有配置则返回配置值，否则回退到全局默认
          return configured?.info.experimental?.location_idle_timeout ?? timeToLive
        }).pipe(
          // 在独立作用域内运行，避免长期占用上下文资源
          Effect.scoped,
          // 读取配置失败时也回退到默认时长
          Effect.orElseSucceed(() => timeToLive),
        )

      // An open terminal or client MCP socket keeps its Location loaded: eviction would end the shell under the user,
      // and the client would reconnect and boot a fresh Location right away.
      // retained：判断某位置是否被客户端连接“保留”（保留者存在则禁止空闲驱逐）
      const retained = (ref: Location.Ref) =>
        locations
          .contextEffectOption(ref)
          .pipe(
            // 在位置上下文中查找生命周期服务并询问其保留状态；两层 Option.exists 表示“存在且被保留”
            Effect.map(
              Option.exists((context) =>
                Option.exists(Context.getOption(context, LocationLifecycle.Service), (lifecycle) =>
                  lifecycle.isRetained(),
                ),
              ),
            ),
            // 检查完立即释放作用域
            Effect.scoped,
          )

      // 订阅总线事件，返回取消订阅效果
      const unsubscribe = yield* bus.listen((event) => {
        // 只关心带位置信息的持久化会话事件，其余忽略
        if (!isSessionEvent(event) || !event.location) return Effect.void
        // 规范化事件携带的位置引用
        const location = LocationServiceMap.canonical(event.location)
        // 若该位置当前已被加载（缓存命中）则刷新其活跃时间
        return RcMap.has(locations.rcMap, location).pipe(
          Effect.flatMap((active) => (active ? touch(location) : Effect.void)),
        )
      })
      // 注册终结器：作用域结束时取消订阅
      yield* Effect.addFinalizer(() => unsubscribe)
      // 启动空闲巡检循环（末尾 Effect.forever 持续重复，forkScoped 在本作用域后台运行）
      yield* Effect.gen(function* () {
        // 先等待一个巡检间隔（默认 1 分钟）
        yield* Effect.sleep(options.sweepInterval ?? "1 minute")
        // 取当前缓存中的全部位置引用
        const refs = Array.from(yield* RcMap.keys(locations.rcMap))
        // 计算这些引用对应的键集合
        const cached = new Set(refs.map(key))
        // 为缓存中还没有活跃记录的位置补一条 touch 记录
        yield* Effect.forEach(refs, (ref) => (entries.has(key(ref)) ? Effect.void : touch(ref)), { discard: true })
        // 清理 entries 中已不在缓存里的陈旧键
        for (const id of entries.keys()) {
          if (!cached.has(id)) entries.delete(id)
        }
        // 记录当前时间，供过期判断使用
        const now = clock.currentTimeMillisUnsafe()
        // 过滤出已过期的条目：触碰时间 + 配置的超时毫秒数 <= 当前时间
        const expired = yield* Effect.filter(Array.from(entries.values()), (entry) =>
          idleTimeout(entry.ref).pipe(
            Effect.map((timeout) => timeout !== false && entry.touchedAt + Duration.toMillis(timeout) <= now),
          ),
        )
        // 没有过期条目则结束本轮巡检
        if (expired.length === 0) return
        // Waiting on a question, a long tool call, or a background job emits no durable activity.
        // 收集“占用中”的会话：活跃会话 + 后台任务相关会话（子代理任务同时计入父子会话）
        const owners = [
          ...(yield* execution.active),
          ...(yield* jobs.runningBackground).flatMap((recovery) =>
            recovery.kind === "subagent" ? [recovery.childSessionID, recovery.parentSessionID] : [recovery.sessionID],
          ),
        ]
        // 把占用会话换算成其所在位置的键集合
        const occupied = new Set(
          (yield* Effect.forEach(owners, (sessionID) => sessions.get(sessionID))).flatMap((session) =>
            session ? [key(session.location)] : [],
          ),
        )
        // 逐个处理过期条目
        yield* Effect.forEach(
          expired,
          (entry) =>
            Effect.gen(function* () {
              // 若该位置仍有会话占用或被客户端保留，则改为刷新活跃时间（续命）
              if (occupied.has(key(entry.ref)) || (yield* retained(entry.ref))) return yield* touch(entry.ref)
              // 否则删除活跃记录并驱逐该位置的服务
              entries.delete(key(entry.ref))
              // 记录驱逐日志：目录与 workspaceID
              yield* Effect.logInfo("location services evicted", {
                directory: entry.ref.directory,
                workspaceID: entry.ref.workspaceID,
              })
              // 使该位置的服务层失效（释放其资源）
              yield* locations.invalidate(entry.ref)
            }),
          { discard: true },
        )
      }).pipe(Effect.forever, Effect.forkScoped)

      // 返回空的服务实现：本服务只承载后台清理器的生命周期
      return Service.of({})
    }),
  )
}

// 导出全局节点：装配本层与依赖（总线、任务、位置服务映射、会话执行、会话存储）
export const node = makeGlobalNode({
  service: Service,
  layer: layer(),
  deps: [Bus.node, Job.node, LocationServiceMap.node, SessionExecution.node, SessionStore.node],
})
