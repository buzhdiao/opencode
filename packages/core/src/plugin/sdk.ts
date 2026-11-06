// 将本模块以命名空间 `SdkPlugins` 全量导出，供其他模块以 `SdkPlugins.xxx` 形式访问
export * as SdkPlugins from "./sdk.js"

// 引入插件类型定义（仅类型导入，编译后不产生运行时代码）
import type { Plugin } from "@opencode/plugin/effect/plugin"
// 引入 Effect 的 Context（依赖注入上下文）、Effect（函数式副作用原语）与 Layer（层，用于装配服务）
import { Context, Effect, Layer } from "effect"
// 引入"全局节点"工厂：把服务注册为宿主进程级全局单例，供所有 Location 共享
import { makeGlobalNode } from "@opencode/util/effect/app-node"
// 引入事件总线（Bus）服务，用于发布插件更新事件
import { Bus } from "../bus.js"
// 引入插件"代"（Generation）类型：插件实例附带修订号等元信息的组合
import type { Generation } from "../plugin.js"

// 定义"SDK 插件已更新"临时事件（ephemeral：无持久化状态），全局广播以便各 Location 重载插件
export const Updated = Bus.ephemeral({ type: "sdk.plugin.updated", schema: {} })

/**
 * Holds the plugins an embedder (the `@opencode/sdk` host) contributes,
 * so the application loader can add them on every Location boot through its
 * ordinary generation path. Registration publishes an unlocated update so every booted Location
 * reloads its plugin generation from the shared store.
 *
 * Each host-global layer owns one private store. Location graphs reuse that
 * layer through Effect's memoization, so separate hosts remain isolated while
 * every Location in one host sees the same registrations.
 */
// 嵌入方（embedder，即 @opencode/sdk 宿主）贡献插件的注册表服务接口
export interface Interface {
  // register：注册一个插件，写入共享存储并广播更新事件
  readonly register: (plugin: Plugin) => Effect.Effect<void>
  // all：返回当前已注册的全部插件代列表
  readonly all: () => readonly Generation[]
}

// 定义服务标签（service tag）：Effect 依赖注入中唯一标识该服务的凭据
export class Service extends Context.Service<Service, Interface>()("@opencode/SdkPlugins") {}

// 构建服务层（Layer）：注入 Bus 服务后创建带私有注册表的服务实现
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 获取事件总线服务实例，用于后续发布更新事件
    const bus = yield* Bus.Service
    // 插件注册表：以插件 id 为键存储对应的"代"
    const plugins = new Map<string, Generation>()
    // 修订计数器：每次注册递增，用于生成插件代的修订号
    let revision = 0
    // 组装并返回服务实现对象
    return Service.of({
      // register 实现：同步写入插件后全局广播更新事件
      register: (plugin) =>
        Effect.sync(() => {
          // 覆盖写入该插件：附上递增后的修订号，并把来源标记为 sdk
          plugins.set(plugin.id, { ...plugin, revision: String(++revision), source: { type: "sdk" } })
        }).pipe(Effect.andThen(bus.publish(Updated, {}, { global: true })), Effect.asVoid),
      // all 实现：把注册表中的所有插件值收集为数组返回
      all: () => [...plugins.values()],
    })
  }),
)

// 创建全局节点：将本服务与层注册为宿主级全局单例，并声明依赖 Bus 节点
export const node = makeGlobalNode({ service: Service, layer, deps: [Bus.node] })
