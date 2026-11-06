// 将本模块以命名空间 Instance 的形式再导出
export * as Instance from "./service.js"
// 转发导出 Services 类型
export type { Services } from "../instance.js"

// 引入 Effect 的上下文（Context）与 Effect 类型
import { Context, type Effect } from "effect"
// 引入会话信息类型
import type { Session } from "@opencode/schema/session"
// 引入全局节点标签
import { Node } from "@opencode/util/effect/app-node"
// 引入层级节点工具
import { LayerNode } from "@opencode/util/effect/layer-node"
// 引入服务集合与错误类型
import type { Services, Error } from "../instance.js"

/** Selects Session capabilities; implementations own caching and lifetime. */
// 实例服务接口：为会话选择能力（capabilities），缓存与生命周期由实现方负责
export interface Interface {
  readonly provide: (
    session: Session.Info,
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | Error, Exclude<R, Services>>
  /** Whether `provide` would reuse built or booting capabilities. Selectors without it are assumed live. */
  // 可选：判断 provide 是否会复用已构建/启动中的能力；未实现的调用方默认视为“常驻”
  readonly live?: (session: Session.Info) => Effect.Effect<boolean>
}

// 实例服务类：以标记字符串 "@opencode/Instance" 注册到 Effect 上下文
export class Service extends Context.Service<Service, Interface>()("@opencode/Instance") {}

// 服务对应的层级节点：未绑定实现，挂在全局标签下
export const node = LayerNode.unbound(Service, Node.tags.values.global)
