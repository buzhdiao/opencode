// 将本模块整体导出为 InstructionDiscovery 命名空间（自导出）
export * as InstructionDiscovery from "./instruction-discovery.js"

// 引入 Effect 的上下文、Effect、层、模式与深度可变类型工具
import { Context, Effect, Layer, Schema, Types } from "effect"
// 引入"按目录（location）装配服务节点"的辅助构造器
import { makeLocationNode } from "@opencode/util/effect/app-node"
// 引入 diff 库的补丁生成器（渲染指令变更用）
import { createPatch } from "diff"
// 引入事件总线（bus）服务
import { Bus } from "./bus.js"
// 引入指令（Instructions）体系（键、列表、渲染等）
import { Instructions } from "./instructions/index.js"
// 引入可变换状态容器（State）
import { State } from "./state.js"

// 指令文件实体：路径 + 内容
export class File extends Schema.Class<File>("InstructionDiscovery.File")({
  // An absolute file path, or the URL of a configured remote instruction.
  path: Schema.String,
  content: Schema.String,
}) {}

// 文件数组的模式
const Files = Schema.Array(File)
// 本来源在指令体系中的键（核心指令来源）
const key = Instructions.Key.make("core/instructions")

// 事件定义：指令发现更新（ephemeral，不持久化）
export const Event = {
  Updated: Bus.ephemeral({ type: "instruction-discovery.updated", schema: {} }),
}

// 状态数据：文件映射（路径 → 文件）与可用标志
export type Data = {
  files: Map<string, Types.DeepMutable<File>>
  available: boolean
}

// 编辑器类型：外部通过它维护指令文件集合
export type Editor = {
  // 列出全部文件（按 Map 插入序）
  list: () => readonly Types.DeepMutable<File>[]
  // Map insertion order is render order: config adds global then nearest-to-farthest project files;
  // sibling contributors interleave by transform registration order.
  // 新增文件（以路径为键写入映射）
  add: (file: File) => void
  // 按路径更新文件内容（原地修改）
  update: (path: string, update: (file: Types.DeepMutable<File>) => void) => void
  // 按路径移除文件
  remove: (path: string) => void
  // 标记发现不可用（如目录无权读取）
  unavailable: () => void
}

// 服务接口：继承 State.Transformable（提供 transform/reload），并暴露发现开关与列表/加载
export interface Interface extends State.Transformable<Editor> {
  // Discovery policy lives here because internal plugins have no per-composition options channel.
  // Move it into plugin config once plugins can consume their own options.
  // 是否发现项目级（AGENTS.md 等）指令
  readonly project: boolean
  // 是否发现全局级指令
  readonly global: boolean
  // 列出当前指令文件；不可用时返回 Instructions.Unavailable
  readonly list: () => Effect.Effect<File[] | Instructions.Unavailable>
  // 加载为指令来源列表（供会话渲染）
  readonly load: () => Effect.Effect<Instructions.List>
}

// 发现选项：两个开关均可选
export const Options = Schema.Struct({
  project: Schema.optional(Schema.Boolean),
  global: Schema.optional(Schema.Boolean),
})
// 选项的 TypeScript 类型
export type Options = typeof Options.Type

// Effect Context 的服务标签
export class Service extends Context.Service<Service, Interface>()("@opencode/InstructionDiscovery") {}

// 服务层工厂：options 控制项目/全局发现开关
export const layer = (options?: Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      // 依赖：事件总线
      const bus = yield* Bus.Service
      // 创建状态容器：初始空映射、可用；文件集合变更时发布 Updated 事件
      const state = State.create<Data, Editor>({
        name: "instruction-discovery",
        initial: () => ({ files: new Map(), available: true }),
        editor: (editor) => ({
          // list：取出映射中的全部文件
          list: () => Array.from(editor.files.values()),
          // add：以路径为键写入（构造一个新 File 实例）
          add: (file) => editor.files.set(file.path, new File(file) as Types.DeepMutable<File>),
          // update：按路径取文件，存在则执行更新回调并固定其路径
          update: (path, update) => {
            const current = editor.files.get(path)
            if (!current) return
            update(current)
            current.path = path
          },
          // remove：按路径删除
          remove: (path) => editor.files.delete(path),
          // unavailable：置不可用标志
          unavailable: () => {
            editor.available = false
          },
        }),
        // 通知：向总线发布 Updated 事件
        notify: () => bus.publish(Event.Updated, {}).pipe(Effect.asVoid),
      })

      // 把文件列表包装成指令来源；按"初始/变更/移除"三种情形渲染文本
      const source = (value: ReadonlyArray<File> | Instructions.Unavailable | Instructions.Removed) =>
        Instructions.make<ReadonlyArray<File>>({
          key,
          // 用 JSON 编解码器序列化文件列表
          codec: Schema.toCodecJson(Files),
          // 读取：直接返回给定值
          read: Effect.succeed(value),
          render: {
            initial: render,
            changed: renderUpdate,
            removed: () => "Previously loaded instructions no longer apply.",
          },
        })

      // 列出当前指令文件：不可用则返回 unavailable 标记
      const list = Effect.fn("InstructionDiscovery.list")(function* () {
        const current = state.get()
        if (!current.available) return Instructions.unavailable
        return Array.from(current.files.values())
      })

      // 暴露服务实现
      return Service.of({
        // 开关默认开启（未传或传 true 都视为开启）
        project: options?.project !== false,
        global: options?.global !== false,
        transform: state.transform,
        reload: state.reload,
        list,
        // load：把列表转成指令来源；空列表转成"已移除"，不可用原样传递
        load: Effect.fn("InstructionDiscovery.load")(function* () {
          const files = yield* list()
          if (!Array.isArray(files)) return source(files)
          return source(files.length === 0 ? Instructions.removed : files)
        }),
      })
    }),
  )

// 以给定选项构造"按目录装配"的节点（依赖事件总线）
export function configured(options?: Options) {
  return makeLocationNode({
    service: Service,
    layer: layer(options),
    deps: [Bus.node],
  })
}

// 默认配置的节点
export const node = configured()

// 渲染全部文件：每个文件一段"来源路径 + 内容"，段间空行分隔
function render(files: ReadonlyArray<File>) {
  return files.map((file) => `Instructions from: ${file.path}\n${file.content}`).join("\n\n")
}

// 渲染两次文件集合之间的变更说明
function renderUpdate(previous: ReadonlyArray<File>, current: ReadonlyArray<File>) {
  // 按路径对比前后集合，得到移除/新增/变更三组
  const changes = Instructions.diffByKey(
    previous,
    current,
    (file) => file.path,
    (before, after) => before.content !== after.content,
  )
  // 组装各部分的文本
  const parts = [
    // 移除的文件：声明其指令不再生效
    ...changes.removed.map((file) => `The instructions from ${file.path} no longer apply.`),
    // 新增的文件：渲染完整内容
    ...changes.added.map((file) => `New instructions apply from:\n${render([file])}`),
    // 变更的文件：优先给 diff（更省 token），diff 比全文还长时改用全文替换
    ...changes.changed.map(({ previous: before, current: after }) => {
      // 生成统一 diff 补丁（3 行上下文）
      const patch = createPatch(after.path, before.content, after.content, "", "", { context: 3 })
      // 拼装 diff 文本（从 @@ 头开始，去掉补丁文件头）
      const diff = [
        `The instructions from ${after.path} changed. Here's the diff:`,
        "```diff",
        patch.slice(patch.indexOf("@@")).trimEnd(),
        "```",
      ].join("\n")
      // 备选：直接给出变更后的全文
      const replacement = `The instructions changed:\n${render([after])}`
      // 取更短的一种
      return diff.length < replacement.length ? diff : replacement
    }),
  ]
  // 无变化时返回 undefined（不渲染）
  return parts.length === 0 ? undefined : parts.join("\n\n")
}
