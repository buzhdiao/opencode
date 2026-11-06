// 将本模块以命名空间 InstructionBuiltIns 的形式再导出
export * as InstructionBuiltIns from "./builtins.js"

// 引入构建位置节点（Location Node）的工具
import { makeLocationNode } from "@opencode/util/effect/app-node"
// 引入 Effect 的上下文、日期时间、副作用、层级与 Schema 工具
import { Context, DateTime, Effect, Layer, Schema } from "effect"
// 引入全局服务（含临时目录等信息）
import { Global } from "@opencode/util/global"
// 引入位置（Location）服务
import { Location } from "../location.js"
// 引入指令（Instructions）模块
import { Instructions } from "./index.js"

// 内建指令服务接口：加载内建指令列表
export interface Interface {
  readonly load: () => Effect.Effect<Instructions.List>
}

// 内建指令服务类：以标记字符串注册到 Effect 上下文
export class Service extends Context.Service<Service, Interface>()("@opencode/InstructionBuiltIns") {}

// 服务实现层级：依赖全局与位置服务，构造 load 方法
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 获取全局服务实例
    const global = yield* Global.Service
    // 获取位置服务实例
    const location = yield* Location.Service
    // 构造服务实例
    return Service.of({
      load: () =>
        Effect.succeed(
          // 组合所有内建指令
          Instructions.combine([
            // 内建指令：今天的日期（变化时提示“现在”的日期）
            Instructions.make({
              key: Instructions.Key.make("core/date"),
              codec: Schema.toCodecJson(Schema.String),
              read: DateTime.nowAsDate.pipe(Effect.map((date) => date.toDateString())),
              render: {
                initial: (date) => `Today's date: ${date}`,
                changed: (_previous, date) => `Today's date is now: ${date}`,
              },
            }),
            // 内建指令：运行环境信息（目录、git、平台、临时目录）
            Instructions.make({
              key: Instructions.Key.make("core/environment"),
              codec: Schema.toCodecJson(Schema.String),
              read: Effect.sync(() =>
                [
                  "<env>",
                  `  Working directory: ${location.directory}`,
                  `  Workspace root folder: ${location.project.directory}`,
                  `  Is directory a git repo: ${location.vcs?.type === "git" ? "yes" : "no"}`,
                  `  Platform: ${process.platform}`,
                  `  Prefer ${global.tmp} over generic system temporary directories such as /tmp; it is pre-created and approved for external access.`,
                  "</env>",
                ].join("\n"),
              ),
              render: {
                initial: (environment) =>
                  ["Here is some useful information about the environment you are running in:", environment].join("\n"),
                changed: (_previous, environment) =>
                  ["The environment you are running in is now:", environment].join("\n"),
              },
            }),
          ]),
        ),
    })
  }),
)

// 导出位置节点：依赖全局与位置两个服务节点
export const node = makeLocationNode({ service: Service, layer, deps: [Global.node, Location.node] })
