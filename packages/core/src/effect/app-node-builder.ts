// 从 location-services 模块导入 buildLocationServiceMap，用于构建“位置 -> 服务”的映射
import { buildLocationServiceMap } from "../location-services.js"
// 导入 LocationServiceMap 服务定义，提供按位置（location）获取服务实例的能力
import { LocationServiceMap } from "../location-service-map.js"
// 导入 LayerNode：基于图层（Layer）依赖图构建应用节点的工具
import { LayerNode } from "@opencode/util/effect/layer-node"
// 导入 makeGlobalNode：声明全局单例图层节点（含 service、layer、deps 元信息）的辅助函数
import { makeGlobalNode } from "@opencode/util/effect/app-node"
// 从 effect 库导入 Effect（效果类型）、Layer（图层组合）与 RcMap（引用计数的资源映射）
import { Effect, Layer, RcMap } from "effect"
// 导入 Instance 服务：表示一个运行中的 OpenCode 实例
import { Instance } from "../instance/service.js"

// 构造一个全局节点 instances：为 Instance.Service 提供具体实现，并声明其依赖 LocationServiceMap 节点
const instances = makeGlobalNode({
  // 该节点提供的服务标识：Instance.Service（实例服务的标签/接口）
  service: Instance.Service,
  // 该节点的图层实现：通过 Effect.gen 组合各依赖后产出服务对象
  layer: Layer.effect(
    Instance.Service,
    Effect.gen(function* () {
      // 从上下文中取出 LocationServiceMap 服务，用于按位置获取/缓存具体服务
      const locations = yield* LocationServiceMap.Service
      // 返回 Instance.Service 接口的实现对象
      return Instance.Service.of({
        // provide：为给定会话（session）提供其所在位置对应的服务上下文
        provide: (session) => Effect.provide(locations.get(session.location)),
        // live：判断该会话所在位置的服务是否仍在 RcMap 中存活（被引用计数持有）
        live: (session) => RcMap.has(locations.rcMap, LocationServiceMap.canonical(session.location)),
      })
    }),
  ),
  // 声明依赖：本节点的图层构建前需要先就绪 LocationServiceMap 节点
  deps: [LocationServiceMap.node],
})

// 导出 build 函数：把根依赖图编译成可运行的 Layer
export function build<A, E>(root: LayerNode.Graph<A, E>, replacements: LayerNode.Replacements = []) {
  // 组装替换列表：先用上面构造的 instances 替换默认的 Instance.node，再拼接调用方传入的 replacements
  const bindings = [Instance.node.replace(instances), ...replacements]
  // 用这些替换项编译依赖图；其中 LocationServiceMap 节点被替换为基于 bindings 构建的服务映射
  return LayerNode.compile(root, {
    replacements: [LocationServiceMap.node.replace(buildLocationServiceMap(bindings)), ...bindings],
  })
}

// 以命名空间形式整体导出本模块，便于以 AppNodeBuilder.xxx 的方式引用
export * as AppNodeBuilder from "./app-node-builder.js"
