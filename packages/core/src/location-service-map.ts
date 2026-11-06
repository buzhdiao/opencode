// 从 effect 引入 Context(上下文)、Effect(效果)、Exit(结果)、Layer(层)、LayerMap(层映射)、RcMap(引用计数资源缓存)
import { Context, Effect, Exit, Layer, LayerMap, RcMap } from "effect"
// 引入 LayerNode：用于声明“待绑定依赖”的服务节点
import { LayerNode } from "@opencode/util/effect/layer-node"
// 引入全局节点注册表 Node 及其 tags 标签
import { Node } from "@opencode/util/effect/app-node"
// 引入 AbsolutePath 模式类型：经过校验的绝对路径
import { AbsolutePath } from "@opencode/schema/schema"
// 引入 Node.js 的 path 模块，用于路径规范化（含 posix/win32 两种风格）
import path from "path"
// 引入 Location 服务与类型
import { Location } from "./location.js"
// 仅引入类型：Instance（实例）的服务集合与错误类型
import type { Instance } from "./instance.js"

// 定义 LocationServiceMap 服务：以 Location.Ref 为键、按需构建实例服务层的资源缓存映射
export class Service extends Context.Service<
  Service,
  LayerMap.LayerMap<Location.Ref, Instance.Services, Instance.Error>
>()("@opencode/example/LocationServiceMap") {
  // 静态辅助方法：取出服务实例并按 ref 获取对应的位置服务层，包装成可直接使用的 Layer
  static get(ref: Location.Ref) {
    return Layer.unwrap(Effect.map(Service, (locations) => locations.get(ref)))
  }
}

// 导出未绑定的全局节点：挂到 tags.values.global 标签，等待依赖注入
export const node = LayerNode.unbound(Service, Node.tags.values.global)

// reload：重载所有已缓存的位置服务——先全部失效，再重新引导（boot），任一失败则整体报错
export const reload = Effect.fn("LocationServiceMap.reload")(function* () {
  // 获取本服务实例
  const locations = yield* Service
  // 取出资源缓存（rcMap）当前持有的全部键（即所有 Location.Ref），转为数组
  const refs = Array.from(yield* RcMap.keys(locations.rcMap))
  // 逐个失效（invalidate）每个位置以释放其资源；不收集结果、并发不受限
  yield* Effect.forEach(refs, (ref) => locations.invalidate(ref), {
    discard: true,
    concurrency: "unbounded",
  })
  // Boot every replacement now and let all builds settle even if one fails.
  // 立即引导所有替代层：每个 ref 在独立作用域内构建上下文，并把结果收集为 Exit（成功或失败都算数）
  const results = yield* Effect.forEach(
    refs,
    (ref) => Effect.scoped(locations.contextEffect(ref)).pipe(Effect.asVoid, Effect.exit),
    { concurrency: "unbounded" },
  )
  // 查找第一个失败的结果
  const failure = results.find(Exit.isFailure)
  // 若存在失败，以其 cause 作为整体错误失败退出
  if (failure) return yield* Effect.failCause(failure.cause)
  // 全部成功后记录日志：位置服务已重载及其数量
  yield* Effect.logInfo("location services reloaded", { count: refs.length })
})

/** Normalize equivalent placements before they become resource-cache keys. */
// canonical：规范化等价的位置引用，避免同一位置在缓存中产生不同的键
export function canonical(ref: Location.Ref) {
  // Workspace refs can hold remote POSIX paths even on a Windows host.
  // Windows 主机上也可能出现以 “/” 开头的远端 POSIX 路径，此时用 posix 风格，否则按平台选 win32/posix
  const flavor = process.platform === "win32" && !ref.directory.startsWith("/") ? path.win32 : path.posix
  // 用选定的路径风格做规范化
  const normalized = flavor.normalize(ref.directory)
  // 判断是否存在可去除的尾部分隔符：以分隔符结尾，且去掉后不会只剩根路径（如 “C:\” 或 “/”）
  const trailing = normalized.endsWith(flavor.sep) && normalized.length > flavor.parse(normalized).root.length
  // 重建 Ref：必要时去掉尾部多余分隔符，保留原 workspaceID
  return Location.Ref.make({
    directory: AbsolutePath.make(trailing ? normalized.slice(0, -1) : normalized),
    workspaceID: ref.workspaceID,
  })
}

// 将本模块以命名空间 LocationServiceMap 的形式整体再导出
export * as LocationServiceMap from "./location-service-map.js"
