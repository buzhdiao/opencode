// 导入 CrossSpawnSpawner 节点：跨平台子进程派生器的图层节点
import { CrossSpawnSpawner } from "@opencode/util/cross-spawn-spawner"
// 导入 makeLocationNode：按“位置（location）”构建全局图层节点的辅助函数
import { makeLocationNode } from "@opencode/util/effect/app-node"
// 从 effect 库导入 Context（依赖上下文）、Effect（效果类型）与 Layer（图层组合）
import { Context, Effect, Layer } from "effect"
// 导入 ChildProcessSpawner：Effect 的子进程派生器服务
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
// 仅作类型导入：Files 文件操作接口
import type { Files } from "./files.js"
// 导入 makeFiles：根据 Driver 组装 Files 实现（exec 默认实现 + 驱动覆盖项）
import { makeFiles } from "./exec-defaults.js"
// 导入 makeLocalDriver：本地环境的驱动器构造函数
import { makeLocalDriver } from "./local.js"
// 导入 Location 服务：描述当前运行位置（含 workspaceID 等）
import { Location } from "../location.js"
// 导入 Workspace 服务：工作区连接/管理能力
import { Workspace } from "../workspace.js"

// Interface 定义环境服务对外暴露的能力集合
export interface Interface {
  // files：文件读写、列目录、删除、移动、建目录等操作
  readonly files: Files
  // spawner：子进程派生器，供执行命令
  readonly spawner: ChildProcessSpawner["Service"]
}

// 声明 Environment 服务标签：把 Interface 绑定到 "@opencode/Environment" 标识上
export class Service extends Context.Service<Service, Interface>()("@opencode/Environment") {}

// 构建环境服务的图层：根据当前位置决定使用远程工作区驱动还是本地驱动
const layer = Layer.effect(
  // 提供的服务标签：Service
  Service,
  Effect.gen(function* () {
    // 从上下文取出子进程派生器
    const spawner = yield* ChildProcessSpawner
    // 从上下文取出位置信息
    const location = yield* Location.Service
    // 从上下文取出工作区服务
    const workspace = yield* Workspace.Service
    // 若位置带有 workspaceID 则连接远程工作区作为驱动；否则退回本地驱动
    const driver = location.workspaceID
      ? yield* workspace.connect(location.workspaceID).pipe(
          // 原有注释：Environment 的错误通道刻意不保留——未知或已销毁的 placement 属于配置缺陷，这里直接把错误转为普通 Error。
          // Environment has no error channel; an unknown or destroyed placement is a configuration defect by design.
          Effect.mapError(
            (cause) => new Error(`Failed to bind Environment to workspace ${location.workspaceID}`, { cause }),
          ),
          // orDie：把剩余错误视为致命缺陷（defect），失败即崩溃而非进入错误通道
          Effect.orDie,
        )
      // 无 workspaceID 时构造本地驱动
      : makeLocalDriver(spawner)
    // 返回服务实现：文件操作由驱动组装，子进程派生器直接来自驱动
    return Service.of({ files: makeFiles(driver), spawner: driver.spawner })
  }),
)

// 导出环境服务的图层节点：声明其依赖派生器、位置、工作区三个节点
export const node = makeLocationNode({
  // 提供的服务标签
  service: Service,
  // 图层实现
  layer,
  // 依赖列表
  deps: [CrossSpawnSpawner.node, Location.node, Workspace.node],
})

// 以命名空间形式整体导出本模块
export * as EnvironmentService from "./environment.js"
