// 将本模块整体导出为 ReferenceInstructions 命名空间（供依赖注入定位节点等处引用）
export * as ReferenceInstructions from "./instructions.js"

// 导入 effect 风格的应用节点构造工具与核心库
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Context, Effect, Layer, Schema } from "effect"
import { Reference } from "../reference.js"
import { Instructions } from "../instructions/index.js"

// 定义单条项目引用（reference）的摘要结构：名称、路径、可选描述
const Summary = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  description: Schema.String.pipe(Schema.optional),
})

// 把引用列表渲染成 XML 风格的 <reference> 条目行数组；description 未定义时跳过该字段
const entries = (references: ReadonlyArray<typeof Summary.Type>) =>
  references.flatMap((reference) => [
    "  <reference>",
    `    <name>${reference.name}</name>`,
    `    <path>${reference.path}</path>`,
    ...(reference.description === undefined ? [] : [`    <description>${reference.description}</description>`]),
    "  </reference>",
  ])

// 把整个引用清单渲染为注入 system prompt 的完整文本块（说明 + 条目列表）
const render = (references: ReadonlyArray<typeof Summary.Type>) =>
  [
    "Project references provide additional directories that can be accessed when relevant.",
    "<available_references>",
    ...entries(references),
    "</available_references>",
  ].join("\n")

// 构造清单差异更新器：按 name 作为唯一键，比较 path/description 是否变化，并给出增/删/改时注入的提示文案
const update = Instructions.listUpdate<typeof Summary.Type>({
  key: (reference) => reference.name,
  changed: (before, after) => before.path !== after.path || before.description !== after.description,
  entries,
  render,
  text: {
    replaced: "The available project references have changed. This list supersedes the previous reference list.",
    added: "New project references are available in addition to those previously listed:",
    changed:
      "The following project references have changed. Each entry replaces the previously listed reference with the same name:",
    removed: (names) => `The following project references are no longer available and must not be used: ${names}.`,
  },
})

// 服务接口：load 返回一个 Effect，产出渲染好的引用说明列表
export interface Interface {
  readonly load: () => Effect.Effect<Instructions.List>
}

// 声明 effect Context 服务标签（服务标识符），用于从运行环境中取回本服务
export class Service extends Context.Service<Service, Interface>()("@opencode/ReferenceInstructions") {}

// 构建 Layer（层）：依赖 Reference 服务，返回 Service 的具体实现
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 从上下文中取出引用服务
    const references = yield* Reference.Service

    return Service.of({
      // load 实现：读取当前项目引用并生成 Instructions 列表
      load: Effect.fn("ReferenceInstructions.load")(function* () {
        // 只保留带描述的引用，映射成摘要对象，并按名称排序
        const available = (yield* references.list())
          .filter((reference) => reference.description !== undefined)
          .map((reference) => ({
            name: reference.name,
            path: reference.path,
            description: reference.description,
          }))
          .toSorted((a, b) => a.name.localeCompare(b.name))
        // 组装 Instructions：唯一键、JSON 编解码器、当前值（空则表示“已移除”）、各阶段渲染函数
        return Instructions.make<ReadonlyArray<typeof Summary.Type>>({
          key: Instructions.Key.make("core/reference-guidance"),
          codec: Schema.toCodecJson(Schema.Array(Summary)),
          read: Effect.succeed(available.length === 0 ? Instructions.removed : available),
          render: {
            initial: render,
            changed: update,
            removed: () =>
              "Project reference guidance is no longer available. Do not use previously listed references.",
          },
        })
      }),
    })
  }),
)

// 创建依赖注入定位节点：声明本服务、层实现，以及依赖的 Reference 节点
export const node = makeLocationNode({ service: Service, layer, deps: [Reference.node] })
