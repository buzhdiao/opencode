// 从 effect 引入 Context、Duration、Effect、Exit、Layer、LayerMap(层映射)、MutableHashMap(可变哈希表)、Option、Scope(作用域)
import { Context, Duration, Effect, Exit, Layer, LayerMap, MutableHashMap, Option, Scope } from "effect"
// 引入 LayerNode 及其 Replacements(依赖替换项)类型
import { LayerNode } from "@opencode/util/effect/layer-node"
// 引入 Instance（实例）服务：每个位置对应的应用实例
import { Instance } from "./instance.js"
// 引入位置、位置生命周期与位置服务映射模块
import { Location } from "./location.js"
import { LocationLifecycle } from "./location-lifecycle.js"
import { LocationServiceMap } from "./location-service-map.js"

// 再导出 LocationServiceMap，方便调用方统一从本模块取用
export { LocationServiceMap } from "./location-service-map.js"

// 类型别名：位置内部的服务集合与实例（Instance）服务集合一致
export type LocationServices = Instance.Services

// 关闭后仍被占用的告警阈值：30 秒
const HELD_WARNING_AFTER = "30 seconds"

// 构建 LocationServiceMap 服务层：可传入 LayerNode.Replacements（依赖替换项）定制内部构建
export function buildLocationServiceMap(
  replacements: LayerNode.Replacements = [],
): Layer.Layer<LocationServiceMap.Service> {
  return Layer.effect(
    LocationServiceMap.Service,
    Effect.gen(function* () {
      // 获取所有者作用域（owner scope），用于托管后台清理协程
      const owner = yield* Effect.scope
      // 登记表：键为 Location.Ref，值为对应构建载体对象（close 保存其关闭效果）
      const builds = MutableHashMap.empty<Location.Ref, { close?: Effect.Effect<void> }>()
      // 创建底层 LayerMap：按 ref 构建实例服务层，支持失效与重试
      const inner: LayerMap.LayerMap<Location.Ref, LocationServices, Instance.Error> = yield* LayerMap.make(
        // 构建函数：给定 ref 返回构建该位置服务层的 Layer
        (ref: Location.Ref) => {
          // 为本次构建创建载体对象
          const build: { close?: Effect.Effect<void> } = {}
          // 把载体对象登记进 builds 表
          MutableHashMap.set(builds, ref, build)
          // Layer.fromBuild：参与共享 memoMap 与给定 scope 的底层构建过程
          return Layer.fromBuild((memoMap, scope) =>
            Effect.suspend(() =>
              // 用实例层（带依赖替换项 bindings）在共享 memoMap 与给定 scope 中构建
              Layer.buildWithMemoMap(Instance.layer(ref, { replacements: bindings }), memoMap, scope),
            ).pipe(
              // 构建退出时（无论成败）执行清理判断
              Effect.onExit((exit) => {
                const finish = Effect.suspend(() => {
                  // 构建成功的分支
                  if (Exit.isSuccess(exit)) {
                    return Effect.gen(function* () {
                      // 从构建结果的上下文中取出生命周期服务
                      const lifecycle = Context.get(exit.value, LocationLifecycle.Service)
                      // A boot detached while in flight still needs shutdown and cancellation.
                      // 若 builds 中该 ref 已指向别的构建对象，说明本次构建已被抛弃：直接执行关闭
                      if (Option.getOrUndefined(MutableHashMap.get(builds, ref)) !== build)
                        return yield* lifecycle.shutdown
                      // 否则把本构建的关闭效果登记为生命周期关闭
                      build.close = lifecycle.shutdown
                    })
                  }
                  // An explicitly invalidated build must not evict its replacement.
                  // 若本次构建已被显式失效并被替代，则不做清理（避免误删替代者）
                  if (Option.getOrUndefined(MutableHashMap.get(builds, ref)) !== build) return Effect.void
                  // 否则从 builds 表移除本次构建的登记
                  MutableHashMap.remove(builds, ref)
                  // Evict once per failed build, before its result reaches borrowers.
                  // 失败的构建要在结果被借用方看到之前先失效一次
                  return Exit.isFailure(exit) ? inner.invalidate(ref) : Effect.void
                })
                // With no borrowers, invalidation closes the entry's scope and
                // joins this lookup fiber. Let the owner finish that cleanup.
                // 失败路径下失效可能关闭条目作用域并阻塞当前查找协程：把清理 fork 给所有者立即执行
                return Exit.isFailure(exit)
                  ? finish.pipe(Effect.forkIn(owner, { startImmediately: true }), Effect.asVoid)
                  : finish
              }),
            ),
          )
        },
        // Retain healthy graphs. Boot failures, not local filesystem probes,
        // decide whether a location (including workspace placement) can retry.
        // 健康的实例图永不过期（idleTimeToLive 无穷大）；能否重试只由引导失败决定
        { idleTimeToLive: Duration.infinity },
      )
      // RcMap closes entries one at a time on shutdown. Close every Location
      // (borrowed ones too) concurrently first; RcMap then finds them closed.
      // 注册终结器：整体关闭时先并发关闭所有 Location（含被借用的），RcMap 随后会看到它们已关闭
      yield* Effect.addFinalizer(() =>
        Effect.suspend(() =>
          // 底层 rcMap 已整体关闭则无事可做
          inner.rcMap.state._tag === "Closed"
            ? Effect.void
            : Effect.forEach(inner.rcMap.state.map, ([, entry]) => Effect.exit(Scope.close(entry.scope, Exit.void)), {
                concurrency: "unbounded",
                discard: true,
              }),
        ),
      )
      // 组装对外暴露的 map 对象：转发 inner 的能力，并在操作前规范化 ref
      const map = {
        ...inner,
        // get：按规范化后的 ref 获取服务层
        get: (ref: Location.Ref) => inner.get(LocationServiceMap.canonical(ref)),
        // contextEffect：在规范化 ref 上构建上下文效果
        contextEffect: (ref: Location.Ref) => inner.contextEffect(LocationServiceMap.canonical(ref)),
        // contextEffectOption：同上，但位置未加载时返回 None
        contextEffectOption: (ref: Location.Ref) => inner.contextEffectOption(LocationServiceMap.canonical(ref)),
        // invalidate：失效某个位置——先断开路由，再取消交互并通知客户端
        invalidate: (ref: Location.Ref) =>
          Effect.suspend(() => {
            // 规范化得到缓存键
            const key = LocationServiceMap.canonical(ref)
            // 取出该键当前的构建对象，并从 builds 表移除登记（先断开路由）
            const build = Option.getOrUndefined(MutableHashMap.get(builds, key))
            MutableHashMap.remove(builds, key)
            // 读取底层 rcMap 状态，判断该键是否仍在缓存中打开
            const state = inner.rcMap.state
            const held = state._tag === "Open" ? Option.getOrUndefined(MutableHashMap.get(state.map, key)) : undefined
            // Detach routing first, then cancel interactions and notify clients. Running
            // steps retain their borrowed graph until they can hand off at a boundary.
            // Do not await a boot here: failed/in-flight builds have their own cleanup path.
            // 依次执行：失效缓存条目，再调用被移除构建的 close（关闭生命周期）；不等待进行中的构建
            return inner.invalidate(key).pipe(
              Effect.andThen(build?.close ?? Effect.void),
              Effect.andThen(
                // Borrowers release on shutdown; one that does not keeps every service of this Location running.
                // The timer lives in the Location's scope, so it stops as soon as the last borrower lets go
                // (forking into an already closed scope never starts it).
                // 若关闭后条目仍被借用方持有：在该条目作用域内起 30 秒定时器，届时记录“仍被占用”告警
                held
                  ? Effect.sleep(HELD_WARNING_AFTER).pipe(
                      Effect.andThen(
                        Effect.suspend(() =>
                          Effect.logWarning("location still held after shutdown", {
                            directory: key.directory,
                            workspaceID: key.workspaceID,
                            holders: held.refCount,
                          }),
                        ),
                      ),
                      Effect.forkIn(held.scope),
                      Effect.asVoid,
                    )
                  : Effect.void,
              ),
            )
          }).pipe(Effect.uninterruptible),
      }
      // Cached instances borrow their owner instead of retaining its Layer scope.
      // 依赖替换项 bindings：缓存实例改为借用所有者，而不是保留其 Layer 作用域
      const bindings: LayerNode.Replacements = [
        // 把 Instance.node 替换为固定实现：provide 时借出对应位置的实例服务
        Instance.node.replace(
          Layer.succeed(Instance.Service, {
            provide: (session) => Effect.provide(map.get(session.location)),
          }),
        ),
        // 追加调用方传入的替换项
        ...replacements,
        // 把 LocationServiceMap.node 替换为已构建好的 map 本身
        LocationServiceMap.node.replace(Layer.succeed(LocationServiceMap.Service, map)),
      ]
      // 返回服务实现 map
      return map
    }),
  )
}
