// 将本模块以命名空间（namespace）Agent 的形式整体导出，外部通过 `Agent.xxx` 访问其中所有成员
export * as Agent from "./agent.js"

// 导入“位置节点（location node）”工厂：把服务与其实现层打包成可被应用装配树引用的节点
import { makeLocationNode } from "@opencode/util/effect/app-node"
// 导入 Effect 库原语：Array（可迭代转数组等）、Context（依赖注入上下文）、Effect、Layer（层）、Types（深度可变等类型工具）
import { Array, Context, Effect, Layer, Types } from "effect"
// 导入智能体（agent）的 schema 定义：包含 ID、Name、Color、Info 及事件等
import { Agent } from "@opencode/schema/agent"
// 导入事件总线（Bus）服务：用于向系统其他部分发布变更事件
import { Bus } from "./bus.js"
// 导入有状态服务封装（State）：提供可变草稿编辑器（editor）与变更订阅
import { State } from "./state.js"

// 重新导出智能体 ID 的 schema（既是校验器也是构造器）
export const ID = Agent.ID
// 导出 ID 的静态类型（从 schema 推导）
export type ID = typeof ID.Type
// 重新导出智能体名称的 schema
export const Name = Agent.Name
// 导出 Name 的静态类型
export type Name = Agent.Name
// 默认智能体的 ID，固定为 "build"（内置构建智能体），找不到其他可选项时回退到它
export const defaultID = ID.make("build")

// 重新导出智能体颜色 schema（供 UI 展示使用）
export const Color = Agent.Color

// 重新导出智能体信息（Info）：描述一个智能体的完整元数据
export const Info = Agent.Info
// 导出 Info 的静态类型
export type Info = Agent.Info

// 重新导出智能体相关事件（如 Updated），供订阅方使用
export { Event } from "@opencode/schema/agent"

// 选中结果（Selection）：一个智能体 ID 加上其可选的信息（未找到时为 undefined）
export interface Selection {
  // 智能体 ID
  readonly id: ID
  // 对应的智能体信息，可能不存在
  readonly info: Info | undefined
}

// 内部状态数据：全部智能体的映射表 + 用户指定的默认智能体 ID（可选）
type Data = {
  agents: Map<ID, Types.DeepMutable<Info>>
  default?: ID
}

// 编辑器（Editor）：对状态草稿的同步读写接口，供配置重载（reload）时修改智能体集合
export type Editor = {
  // 列出全部智能体
  list: () => readonly Types.DeepMutable<Info>[]
  // 按 ID 获取单个智能体
  get: (id: ID) => Types.DeepMutable<Info> | undefined
  // 设置（或清除）默认智能体 ID
  default: (id: ID | undefined) => void
  // 按 ID 更新某个智能体（不存在则先创建默认值），fn 中就地修改
  update: (id: ID, fn: (agent: Types.DeepMutable<Info>) => void) => void
  // 按 ID 删除某个智能体
  remove: (id: ID) => void
}

// 服务接口：Effect 风格的异步 API，附带状态模块的 transform / reload 能力
export interface Interface extends State.Transformable<Editor> {
  // 按 ID 异步获取智能体信息（可能不存在）
  readonly get: (id: ID) => Effect.Effect<Info | undefined>
  // 解析：给定 ID 字符串则查表；未给定则返回当前默认（可选中的）智能体
  readonly resolve: (id?: ID | string) => Effect.Effect<Info | undefined>
  // 选择：返回 {id, info}；未指定 id 时选默认智能体
  readonly select: (id?: ID) => Effect.Effect<Selection>
  // 列出智能体，默认智能体排在最前
  readonly list: () => Effect.Effect<Info[]>
}

// 定义服务标识（Effect 依赖注入的 Tag）：装配时以此定位服务
export class Service extends Context.Service<Service, Interface>()("@opencode/Agent") {}

// 服务实现层（Layer）：构建智能体状态并对外暴露接口
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 依赖：事件总线，用于发布智能体更新事件
    const bus = yield* Bus.Service
    // 判断某智能体是否“可选择”：必须是主智能体（非子智能体 subagent）且未隐藏
    const selectable = (agent: Info | undefined) =>
      agent && agent.mode !== "subagent" && !agent.hidden ? agent : undefined
    // 计算当前默认应选中的智能体：优先用户配置的 default，其次内置 build，最后任意可选智能体兜底
    const selectedDefault = (data: Data) => {
      // 先尝试用户配置的默认智能体（需可选中）
      const configured = data.default ? selectable(data.agents.get(data.default)) : undefined
      if (configured) return configured
      // 再尝试内置的 build 智能体
      const build = selectable(data.agents.get(defaultID))
      if (build) return build
      // 最后遍历全部智能体，取第一个可选中的作为兜底
      for (const agent of data.agents.values()) {
        const fallback = selectable(agent)
        if (fallback) return fallback
      }
    }
    // 列表排序：把默认选中的智能体放到最前面，其余保持原顺序
    const list = (data: Data) => {
      const agents = Array.fromIterable(data.agents.values())
      const selected = selectedDefault(data)
      if (!selected) return agents
      return [selected, ...agents.filter((agent) => agent.id !== selected.id)]
    }
    // 创建状态：初始为空映射；编辑器提供同步修改方法；变化时经总线发布 Updated 事件
    const state = State.create<Data, Editor>({
      name: "agent",
      // 初始状态：空的智能体映射表
      initial: () => ({ agents: new Map() }),
      // 编辑器实现：直接操作草稿中的映射表
      editor: (editor) => ({
        // 列出全部智能体（把映射表值转成数组）
        list: () => Array.fromIterable(editor.agents.values()),
        // 按 ID 取草稿中的智能体
        get: (id) => editor.agents.get(id),
        // 记录用户选择的默认智能体 ID
        default: (id) => {
          editor.default = id
        },
        // 更新指定智能体：不存在则用 Info.default(id) 创建并放入映射，再执行回调就地修改，最后固定其 id
        update: (id, fn) => {
          const current = editor.agents.get(id) ?? (Info.default(id) as Types.DeepMutable<Info>)
          if (!editor.agents.has(id)) editor.agents.set(id, current)
          fn(current)
          current.id = id
        },
        // 从映射中删除指定智能体
        remove: (id) => {
          editor.agents.delete(id)
        },
      }),
      // 变更通知：用排好序的列表做差异比较，发生变化时经总线发布 Agent.Event.Updated
      notify: State.changes(list, () => bus.publish(Agent.Event.Updated, {}).pipe(Effect.asVoid)),
    })

    // 组装并返回服务实例
    return Service.of({
      // 转发状态模块的 transform / reload
      transform: state.transform,
      reload: state.reload,
      // get：按 ID 异步查询智能体信息
      get: Effect.fn("Agent.get")(function* (id) {
        return state.get().agents.get(id)
      }),
      // resolve：给了 id 则按字符串构造 ID 查询；否则返回默认可选智能体
      resolve: Effect.fnUntraced(function* (id) {
        if (id !== undefined) return state.get().agents.get(ID.make(id))
        return selectedDefault(state.get())
      }),
      // select：给了 id 直接返回；否则选默认智能体，info 缺失时 id 回退为 defaultID
      select: Effect.fn("Agent.select")(function* (id) {
        if (id !== undefined) return { id, info: state.get().agents.get(id) }
        const info = selectedDefault(state.get())
        return { id: info?.id ?? defaultID, info }
      }),
      // list：返回排序后的智能体列表（默认智能体在前）
      list: Effect.fn("Agent.list")(function* () {
        return list(state.get())
      }),
    })
  }),
)

// 把服务与实现层打包成“节点”，并声明依赖 Bus 节点，供应用装配树引用
export const node = makeLocationNode({ service: Service, layer, deps: [Bus.node] })
