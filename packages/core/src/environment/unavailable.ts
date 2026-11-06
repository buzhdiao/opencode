// 从 effect 库导入 Effect（效果类型）、Layer（图层组合）与 PlatformError（平台错误构造）
import { Effect, Layer, PlatformError } from "effect"
// 导入 ChildProcessSpawner 服务标签及其 make 工厂
import { ChildProcessSpawner, make } from "effect/process/ChildProcessSpawner"

// spawner：一个永远失败的子进程派生器——该位置没有执行面（既未连接工作区，宿主也无法派生进程）
export const spawner = make(() =>
  Effect.fail(
    PlatformError.systemError({
      // 错误种类未知（不是具体的系统错误码）
      _tag: "Unknown",
      // 归属模块与方法，便于排查
      module: "Environment",
      method: "spawn",
      // 描述信息：说明为何无法派生进程
      description: "This location has no execution plane: no workspace is attached and the host cannot spawn processes",
    }),
  ),
)

// layer：把上述“不可用”派生器注册为 ChildProcessSpawner 服务的图层
export const layer = Layer.succeed(ChildProcessSpawner, spawner)

// 以命名空间形式整体导出本模块
export * as EnvironmentUnavailable from "./unavailable.js"
