// 将本模块以命名空间 App 的形式整体导出，外部通过 `App.xxx` 访问其中所有成员
export * as App from "./app.js"

// 导入 Effect 的 Context（依赖注入引用）与 Layer（层）
import { Context, Layer } from "effect"
// 导入“全局节点”工厂：把服务注册为无需位置依赖的全局节点
import { makeGlobalNode } from "@opencode/util/effect/app-node"

// 应用信息（Info）：名称、版本与发布渠道（channel）
export interface Info {
  readonly name: string
  readonly version: string
  readonly channel: string
}

// 应用元数据的全局引用（Context.Reference）：未显式提供时用 make() 生成默认值
export const Metadata = Context.Reference<Info>("@opencode/App", {
  defaultValue: () => make(),
})

// 构造应用信息：缺省名为 "opencode"，版本与渠道缺省为 "unknown"
export function make(input: Partial<Info> = {}): Info {
  return {
    name: input.name ?? "opencode",
    version: input.version ?? "unknown",
    channel: input.channel ?? "unknown",
  }
}

// 生成 User-Agent 字符串：格式为 opencode/渠道/版本/名称
export function useragent(app: Info) {
  return `opencode/${app.channel}/${app.version}/${app.name}`
}

// 构建“提供应用元数据”的层（Layer），可选地传入部分信息覆盖默认值
export const layer = (input?: Partial<Info>) => Layer.succeed(Metadata, make(input))

// 构建带配置的全局节点：服务为 Metadata，层为上面的 layer，无其他依赖
export const configured = (input?: Partial<Info>) =>
  makeGlobalNode({ service: Metadata, layer: layer(input), deps: [] })

// 默认导出的节点：使用默认配置的应用元数据节点
export const node = configured()
