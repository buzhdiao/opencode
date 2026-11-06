// 从 effect 库引入 Context(上下文)、Effect(效果)、Layer(层) 三个核心工具
import { Context, Effect, Layer } from "effect"
// 从 location 模式定义中引入 Info(位置信息)、Ref(位置引用) 与 response(响应构造器)
import { Info, Ref, response } from "@opencode/schema/location"
// 引入文件系统工具服务（FSUtil），用于判断路径类型等
import { FSUtil } from "@opencode/util/fs-util"
// 引入项目（Project）服务，用于解析/持久化项目信息
import { Project } from "./project.js"
// 引入 LayerNode 工具，用于构建非全局的分层服务节点
import { LayerNode } from "@opencode/util/effect/layer-node"
// 引入 makeLocationNode 与 tags：前者构造位置节点，后者是各模块共享的标签集合
import { makeLocationNode, tags } from "@opencode/util/effect/app-node"

// 将本模块以命名空间 Location 的形式整体再导出
export * as Location from "./location.js"

// 再导出 Info、Ref、response，方便调用方直接从这里取用
export { Info, Ref, response }

// 定义位置服务接口：继承 Info 的全部字段，并可选携带版本控制（VCS）信息
export interface Interface extends Info {
  readonly vcs?: Project.Vcs
}

// 定义 Location 服务类：标识为 "@opencode/Location" 的上下文服务标记
export class Service extends Context.Service<Service, Interface>()("@opencode/Location") {}

// 导出未绑定的服务节点：挂在 tags.values.location 标签下，由上层提供依赖后使用
export const node = LayerNode.unbound(Service, tags.values.location)

// 按 Ref 构建服务层（layer）：根据位置引用解析出项目信息
const layer = (ref: Ref) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      // 获取文件系统工具服务
      const fs = yield* FSUtil.Service
      // 获取项目服务
      const project = yield* Project.Service
      // Location.node builds alongside FileSystem.node, so avoid creating or unarchiving
      // a Project row for a local path that FileSystem.node is about to reject.
      // 只有当引用带 workspaceID，或本地路径确实是目录时才持久化项目记录（persist）
      const persist = ref.workspaceID !== undefined || (yield* fs.isDir(ref.directory))
      // 解析目录对应的项目；persist=false 时仅解析而不落库/解档
      const resolved = yield* project.resolve(ref.directory, { persist })
      // 返回服务实现：目录、工作区 ID、项目摘要（id/目录/是否规范化）与 VCS 信息
      return Service.of({
        directory: ref.directory,
        workspaceID: ref.workspaceID,
        project: { id: resolved.id, directory: resolved.directory, canonical: resolved.canonical },
        vcs: resolved.vcs,
      })
    }),
  )

// 导出绑定工厂：给定 Ref 生成挂好依赖（FSUtil 与 Project）的位置服务节点
export const boundNode = (ref: Ref) =>
  makeLocationNode({
    service: Service,
    layer: layer(ref),
    deps: [FSUtil.node, Project.node],
  })
