// 将本模块以命名空间 `Plugin` 全量导出
export * as Plugin from "./service.js"

// The service tag lives apart from the layer so Session entry points can wait on activation without
// importing the plugin host, which itself depends on Session.
// 服务标签与层分开放置，使 Session 入口能在不引入插件宿主（其自身依赖 Session）的情况下等待激活完成
import { Plugin } from "@opencode/schema/plugin"
// 引入插件定义类型（仅类型导入），代表一个可激活的插件实现
import type { Plugin as PluginDefinition } from "@opencode/plugin/effect/plugin"
// 引入 Effect 的 Context；Effect 与 Exit 在此仅作类型使用
import { Context, type Effect, type Exit } from "effect"

// 插件宿主服务接口：声明激活、查询清单、获取 GUI 包、关闭与等待激活等能力
export interface Interface {
  // activate：按给定顺序激活插件代列表，可选地携带历史失败记录
  readonly activate: (plugins: readonly Generation[], failures?: readonly Failure[]) => Effect.Effect<void>
  // list：返回当前插件清单（含每个插件的状态信息）
  readonly list: () => Effect.Effect<Plugin.Info[]>
  /** An active plugin's prebuilt `./gui-experimental` bundle, or undefined when it exports none. */
  // gui：按插件 ID 取其预构建的 GUI 包；未导出时返回 undefined
  readonly gui: (id: Plugin.ID) => Effect.Effect<Plugin.GuiBundle | undefined>
  // close：宿主关闭时把退出结果（Exit）通知插件，供其做清理
  readonly close: (exit: Exit.Exit<unknown, unknown>) => Effect.Effect<void>
  /** Wait for announced updates and activation to settle; failures remain in the inventory. */
  // awaitActivation：等待已公告的更新与激活全部完成；失败项仍保留在清单中
  readonly awaitActivation: Effect.Effect<void>
  /** Keep readiness pending while preparing an update. Run the returned Effect to release it. */
  // hold：在准备更新期间把就绪状态挂起；运行返回的 Effect 可解除挂起
  readonly hold: () => Effect.Effect<Effect.Effect<void>>
}

// 失败插件类型：在插件信息基础上收窄出"failed"状态的具体负载
export type Failure = Plugin.Info & { readonly state: Extract<Plugin.State, { readonly status: "failed" }> }

// 插件"代"（Generation）：在插件定义之上附加修订号、来源与特性标记，用于追踪每次重载
export type Generation = PluginDefinition & {
  // 修订号：插件每次重载时变化的版本标识
  readonly revision: string
  // 来源：插件来自的渠道（如内置、SDK 等）
  readonly source?: Plugin.Source
  // 特性标记：插件声明支持的功能集合
  readonly features?: Plugin.Features
  /**
   * The package's `./gui-experimental` bundle: its file URL, the plugin's options, and an opaque revision that changes
   * with the plugin, its options or the bundle's content. A change to the bundle alone reloads it in the app without
   * restarting the server entry.
   */
  // GUI 实验包：包文件的 file:// URL、插件选项，以及随插件/选项/包内容变化的不透明修订号
  readonly gui?: { readonly file: string; readonly revision: string; readonly options: Plugin.GuiBundle["options"] }
}

// 定义插件宿主服务标签，供依赖注入系统识别本服务
export class Service extends Context.Service<Service, Interface>()("@opencode/Plugin") {}

/**
 * Session entry points wait here before reading plugin-provided state such as commands, skills, hooks,
 * and the model catalog. A cold Location activates its plugins asynchronously, so without the wait an
 * early request observes an empty registry and admits or fails work the plugins would have shaped.
 */
// 便捷访问器：会话入口在读取命令、技能、钩子、模型目录等插件提供的状态前，先在此等待激活完成
export const awaitActivation = Service.use((plugins) => plugins.awaitActivation)
