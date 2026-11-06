// 将本模块以命名空间 LocationLifecycle 的形式整体再导出
export * as LocationLifecycle from "./location-lifecycle.js"

// 从 effect 引入 Context、Deferred(一次性完成信号)、Effect、Layer、Schema、Scope(作用域)
import { Context, Deferred, Effect, Layer, Schema, Scope } from "effect"
// 引入 makeLocationNode：构造挂到位置标签下的服务节点
import { makeLocationNode } from "@opencode/util/effect/app-node"
// 引入位置事件（LocationEvent）模式定义
import { LocationEvent } from "@opencode/schema/location-event"
// 以下引入依赖的各服务：总线、表单、位置、位置服务映射、权限、项目、RPC、会话事件
import { Bus } from "./bus.js"
import { Form } from "./form.js"
import { Location } from "./location.js"
import { LocationServiceMap } from "./location-service-map.js"
import { Permission } from "./permission.js"
import { Project } from "./project.js"
import { Rpc } from "./rpc.js"
import { SessionEvent } from "./session/event.js"

// 构造类型守卫：判断未知事件是否为持久化（Durable）会话事件
const isSessionEvent = Schema.is(SessionEvent.Durable)
// 收集所有持久化会话事件的类型名，组成只读集合用于快速过滤
const durableSessionEventTypes: ReadonlySet<string> = new Set(
  SessionEvent.DurableDefinitions.map((definition) => definition.type),
)

// 定义 LocationLifecycle（位置生命周期）服务接口
// Completes once shutdown has run. Long-lived holders release the Location on it so its scope can close.
export class Service extends Context.Service<
  Service,
  {
    // 查询是否已进入关闭流程
    readonly isClosed: () => boolean
    // 触发关闭（幂等）
    readonly shutdown: Effect.Effect<void>
    /** Completes once shutdown has run. Long-lived holders release the Location on it so its scope can close. */
    // awaitShutdown：关闭流程执行完毕后完成；长期持有者会在其上释放 Location，使其作用域得以关闭
    readonly awaitShutdown: Effect.Effect<void>
    /** Keeps the idle sweep from evicting the Location for the calling scope, for open client connections. */
    // retain：在调用方作用域存活期间阻止空闲清理（idle sweep）驱逐该 Location，用于已打开的客户端连接
    readonly retain: Effect.Effect<void, never, Scope.Scope>
    // 查询当前是否存在任何保留者
    readonly isRetained: () => boolean
  }
>()("@opencode/LocationLifecycle") {}

// 构建服务实现层：负责 Location 的关闭流程与保留计数
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 依次获取依赖服务：事件总线、位置、权限、表单、RPC、项目
    const bus = yield* Bus.Service
    const location = yield* Location.Service
    const permission = yield* Permission.Service
    const forms = yield* Form.Service
    const rpc = yield* Rpc.Service
    const project = yield* Project.Service
    // 取当前作用域（scope），稍后用于把项目激活效果挂到本 Location 的生命周期上
    const scope = yield* Effect.scope
    // 用本位置的目录与 workspaceID 构造引用并规范化，得到自身的规范标识
    const self = LocationServiceMap.canonical(
      Location.Ref.make({ directory: location.directory, workspaceID: location.workspaceID }),
    )
    // 激活本 Location 对应的项目（持久化项目记录）
    yield* project.activate(location.project.id)
    // 订阅事件总线，返回取消订阅效果
    const unsubscribe = yield* bus.listen((event) => {
      // 无位置信息或不是持久化会话事件类型时直接忽略
      if (!event.location || !durableSessionEventTypes.has(event.type)) return Effect.void
      // 把事件携带的位置引用规范化，用于判断是否属于本位置
      const ref = LocationServiceMap.canonical(event.location)
      // 目录或 workspaceID 不一致则忽略（事件属于其他 Location）
      if (ref.directory !== self.directory || ref.workspaceID !== self.workspaceID) return Effect.void
      // 不是持久化的会话事件则忽略
      if (!isSessionEvent(event)) return Effect.void
      // Listeners run inside publish; keep the write and its Project event off that path.
      // 监听器在发布（publish）路径内运行；把写入与项目事件 fork 到本作用域，避免阻塞发布路径
      return project.activate(location.project.id, { forkIn: scope })
    })
    // 注册终结器（finalizer）：作用域关闭时取消事件订阅
    yield* Effect.addFinalizer(() => unsubscribe)
    // 关闭标志：是否已进入关闭流程
    let closed = false
    // 保留计数：有多少个作用域要求不驱逐本 Location
    let retained = 0
    // 创建一次性 Deferred，关闭完成时用它通知所有等待者
    const done = yield* Deferred.make<void>()
    // shutdown 效果：用 suspend 延迟求值实现幂等——只有首次调用执行真正的关闭逻辑
    const shutdown = Effect.suspend(() => {
      // 已关闭则直接等待完成信号
      if (closed) return Deferred.await(done)
      // 首次进入：置为已关闭，防止重复执行
      closed = true
      return Effect.gen(function* () {
        // 依次关闭权限、表单、RPC 子服务
        yield* permission.close
        yield* forms.close
        yield* rpc.close
        // 向总线发布本位置的 Shutdown 事件，携带位置引用
        yield* bus.publish(
          LocationEvent.Shutdown,
          {},
          {
            location: Location.Ref.make({ directory: location.directory, workspaceID: location.workspaceID }),
          },
        )
        // ensuring：无论上面成功或失败，都完成 done，让等待者不再阻塞
      }).pipe(Effect.ensuring(Deferred.succeed(done, undefined)))
    }).pipe(Effect.uninterruptible)
    // 返回服务实现对象
    return Service.of({
      // isClosed：返回关闭标志
      isClosed: () => closed,
      // shutdown：上文定义的关闭效果
      shutdown,
      // awaitShutdown：等待关闭完成的 Deferred
      awaitShutdown: Deferred.await(done),
      // retain：acquireRelease 效果对——进入时计数加一，作用域结束自动减一
      retain: Effect.acquireRelease(
        Effect.sync(() => {
          // 进入保留状态：计数加一
          retained++
        }),
        () =>
          Effect.sync(() => {
            // 释放保留状态：计数减一
            retained--
          }),
      ),
      // isRetained：保留计数是否大于零
      isRetained: () => retained > 0,
    })
  }),
)

// 导出位置节点：装配本层及其全部依赖（总线、位置、权限、项目、表单、RPC）
export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Bus.node, Location.node, Permission.node, Project.node, Form.node, Rpc.node],
})
