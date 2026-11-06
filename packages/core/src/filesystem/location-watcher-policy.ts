// 以命名空间形式整体导出本模块
export * as LocationWatcherPolicy from "./location-watcher-policy.js"

// 导入 makeLocationNode：按位置构建全局图层节点的辅助函数
import { makeLocationNode } from "@opencode/util/effect/app-node"
// 从 effect 库导入所需模块：Context（依赖上下文）、Effect、Layer、Scope（作用域）
import { Context, Effect, Layer, Scope } from "effect"
// 导入 State：可变换（transformable）的共享状态工具
import { State } from "../state.js"

// Data：策略的内部状态数据——忽略路径/别名列表
type Data = {
  ignore: string[]
}

// Editor：状态编辑器的对外视图——追加忽略项、列出当前忽略项
export type Editor = {
  add: (ignore: readonly string[]) => void
  list: () => readonly string[]
}

// Interface：策略服务的能力——可变换、可重载、读取当前值、监听变更
export interface Interface extends State.Transformable<Editor> {
  readonly current: () => readonly string[]
  readonly observe: (
    listener: (ignore: readonly string[]) => Effect.Effect<void>,
  ) => Effect.Effect<State.Registration, never, Scope.Scope>
}

// 声明 LocationWatcherPolicy 服务标签
export class Service extends Context.Service<Service, Interface>()("@opencode/LocationWatcherPolicy") {}

// 构建策略服务的图层：内部用 State 管理忽略列表并分发变更通知
const layer = Layer.effect(
  // 提供的服务标签
  Service,
  Effect.gen(function* () {
    // 监听器集合：每次策略变更都会通知它们
    const listeners = new Set<(ignore: readonly string[]) => Effect.Effect<void>>()
    // 创建状态：初始为空忽略列表；编辑器提供 add/list；通知时逐个调用监听器
    const state = State.create<Data, Editor>({
      // 状态名称（用于诊断）
      name: "location-watcher-policy",
      // 初始状态：空忽略列表
      initial: () => ({ ignore: [] }),
      // 编辑器实现：add 向列表追加，list 返回当前列表
      editor: (editor) => ({
        add: (ignore) => editor.ignore.push(...ignore),
        list: () => editor.ignore,
      }),
      // 原有注释：对每个监听器单独读取当前值——若更早的监听器在通知期间重入了 transform，后续监听器必须拿到新值。
      // Read per listener: a reentrant transform inside an earlier listener must reach later ones.
      notify: () => Effect.forEach(listeners, (listener) => listener(current()), { discard: true }),
    })
    // 原有注释：显式标注返回类型以打断经由 notify 的类型推断循环——notify 读取 current，current 又读取 state。
    // Annotated to break the inference cycle through notify: notify reads current, current reads state.
    const current = (): readonly string[] => state.get().ignore
    // observe：注册监听器；登记到集合中，并在作用域终结时自动注销
    const observe = Effect.fn("LocationWatcherPolicy.observe")(function* (
      listener: (ignore: readonly string[]) => Effect.Effect<void>,
    ) {
      // 获取调用方作用域
      const scope = yield* Scope.Scope
      // 活跃标记：防止 dispose 被重复执行
      let active = true
      // dispose：一次性注销监听器
      const dispose = Effect.sync(() => {
        if (!active) return
        active = false
        listeners.delete(listener)
      })
      // 把监听器加入集合
      listeners.add(listener)
      // 注册作用域终结器，作用域关闭时自动调用 dispose
      yield* Scope.addFinalizer(scope, dispose)
      // 返回手动注销句柄
      return { dispose }
    })
    // 返回服务实现：变换/重载委托给 State，另暴露 current 与 observe
    return Service.of({
      transform: state.transform,
      reload: state.reload,
      current,
      observe,
    })
  }),
)

// 导出策略节点：按位置隔离，无额外依赖
export const node = makeLocationNode({ service: Service, layer, deps: [] })
