// 以命名空间形式整体再导出本模块
export * as InstancePlugins from "./instance.js"

// Plugin：插件类型
import type { Plugin } from "@opencode/plugin/effect/plugin"
// Context/Layer：Effect 的依赖注入容器与层（Layer）构造
import { Context, Layer } from "effect"
// makeLocationNode：按位置（location）构建服务节点的辅助函数
import { makeLocationNode } from "@opencode/util/effect/app-node"
// Generation：插件生成（注册后的最终形态）类型
import type { Generation } from "../plugin.js"

/**
 * Holds the plugins one instance is born with. Unlike the host-global
 * `SdkPlugins` store, this list is a birth argument of a single instance:
 * `Instance.layer` binds it through the replacement mechanism, so two
 * instances in one process can carry different plugins. The list is immutable
 * for the instance's lifetime; runtime dynamism lives inside plugins through
 * the container transform/reload APIs.
 *
 * Config plugin operations may disable instance plugins by id, matching
 * `SdkPlugins` behavior.
 */
// 类型别名：一个实例自带的只读插件列表
export type List = readonly Plugin[]

// 服务接口：暴露获取全部插件的方法
export interface Interface {
  // all：返回该实例拥有的所有插件代目（Generation）
  readonly all: () => readonly Generation[]
}

// 声明 Effect 服务（Context.Service），标签为实例插件服务
export class Service extends Context.Service<Service, Interface>()("@opencode/InstancePlugins") {}

// 位置节点：为每个 location 提供该服务的默认实现（空列表），无额外依赖
export const node = makeLocationNode({
  // 绑定的服务类
  service: Service,
  // 默认层：绑定空插件列表
  layer: bound([]),
  // 依赖的服务节点列表：无
  deps: [],
})

// The constant revision is load-bearing: the plugin registry treats an
// unchanged (id, revision) pair as the same plugin across activations, which
// is only correct because a bound list never changes after creation.
// `source: "sdk"` means host-contributed; an instance list is the
// per-instance form of the same channel.
// 把一组插件绑定成一个实例级服务层（Layer）
export function bound(plugins: List) {
  // 找出 id 重复的插件：对每个插件在原列表中再查一次首次出现的下标，不相等即重复
  const duplicates = plugins.filter((plugin, index) => plugins.findIndex((other) => other.id === plugin.id) !== index)
  // 存在重复 id 时直接报错，避免插件注册冲突
  if (duplicates.length > 0) {
    // 抛出包含所有重复 id 的错误信息
    throw new Error(`duplicate instance plugin ids: ${duplicates.map((plugin) => plugin.id).join(", ")}`)
  }
  // 为每个插件打上固定的 revision 标记 "instance" 并标记来源为 sdk（宿主注入）
  const stamped = plugins.map((plugin): Generation => ({ ...plugin, revision: "instance", source: { type: "sdk" } }))
  // 构建一个始终返回该插件快照的服务层
  return Layer.succeed(Service, Service.of({ all: () => stamped }))
}
