// 将本文件的所有导出聚合到命名空间 WorktreeStrategies 下，供统一引入
export * as WorktreeStrategies from "./strategies.js"

// effect 库：Context 依赖注入、Effect 编排、Layer 分层
import { Context, Effect, Layer } from "effect"
// Node 路径工具
import path from "path"
// 构建 effect 分层应用中的 Location 节点
import { makeLocationNode } from "@opencode/util/effect/app-node"
// 全局数据目录服务
import { Global } from "@opencode/util/global"
// Worktree Schema 类型
import { Worktree } from "@opencode/schema/worktree"
// 通用 Schema：绝对路径
import { AbsolutePath } from "../schema.js"
// Git 服务节点（策略依赖）
import { Git } from "../git.js"
// Location 服务：项目定位
import { Location } from "../location.js"
// State：可变状态与编辑器模式
import { State } from "../state.js"
// 内置的 git 工作树策略
import { WorktreeGit } from "./git.js"
// 文件系统工具节点
import { FSUtil } from "@opencode/util/fs-util"

// 工作树策略接口：不同实现（如 git worktree）需提供的能力
export interface Strategy {
  // 策略 ID
  readonly id: Worktree.StrategyID
  // 创建工作树：源目录、目标目录与可选分支
  readonly create: (input: {
    sourceDirectory: AbsolutePath
    directory: AbsolutePath
    branch?: string
  }) => Effect.Effect<Worktree.Info, unknown>
  // 移除工作树（可指定强制）
  readonly remove: (input: { directory: AbsolutePath; force: boolean }) => Effect.Effect<void, unknown>
  // 列出工作树
  readonly list: (directory: AbsolutePath) => Effect.Effect<readonly Worktree.ListEntry[], unknown>
}

// 状态编辑器接口：注册新策略与调整配置
export interface Editor {
  // 添加（替换）一个策略并将其设为当前选中
  readonly add: (strategy: Strategy) => void
  // 调整工作树根目录配置
  readonly configure: (settings: { readonly directory: AbsolutePath }) => void
}

// 服务接口：在可转换状态之上暴露目录与读取方法
export interface Interface extends State.Transformable<Editor> {
  // 当前 Location 的目录
  readonly directory: AbsolutePath
  // 读取当前状态快照
  readonly get: () => {
    // 工作树根目录
    readonly directory: AbsolutePath
    // 已注册的策略表
    readonly strategies: ReadonlyMap<Worktree.StrategyID, Strategy>
    // 当前选中的策略 ID
    readonly selected: Worktree.StrategyID
  }
}

// 服务定义（Context.Service）
export class Service extends Context.Service<Service, Interface>()("@opencode/WorktreeStrategies") {}

// 服务分层：组合 Location/Global 等依赖并初始化状态
const layer = Layer.effect(
  // 目标服务
  Service,
  // 构造 effect
  Effect.gen(function* () {
    // 获取 Location 服务
    const location = yield* Location.Service
    // 获取全局数据目录服务
    const global = yield* Global.Service
    // 构造内置的 git 策略
    const git = yield* WorktreeGit.make
    // 创建可转换状态：默认目录、内置策略与选中项
    const state = State.create({
      // 状态名
      name: "worktree",
      // 初始状态：按项目 ID 前缀生成默认工作树目录
      initial: () => ({
        // 全局数据下 worktree/<项目ID前6位>
        directory: AbsolutePath.make(path.join(global.data, "worktree", location.project.id.slice(0, 6))),
        // 策略表：初始只含 git 策略
        strategies: new Map<Worktree.StrategyID, Strategy>([[git.id, git]]),
        // 默认选中 git 策略
        selected: git.id,
      }),
      // 编辑器实现：配置目录与注册策略
      editor: (value): Editor => ({
        configure: (settings) => {
          // 更新工作树根目录
          value.directory = settings.directory
        },
        add: (strategy) => {
          // 先删除旧的同名策略
          value.strategies.delete(strategy.id)
          // 写入新策略
          value.strategies.set(strategy.id, strategy)
          // 新策略设为选中
          value.selected = strategy.id
        },
      }),
    })
    // 组装服务实现：状态能力 + 当前 Location 目录
    return Service.of({ ...state, directory: location.directory })
  }),
)

// 导出 Location 节点：声明依赖（Location/Global/Git/FSUtil）
export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Location.node, Global.node, Git.node, FSUtil.node],
})
