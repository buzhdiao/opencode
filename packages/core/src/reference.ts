// 将本模块以命名空间（namespace）形式导出为 Reference
export * as Reference from "./reference.js"

// 导入用于构建 Effect 分层节点的辅助函数
import { makeLocationNode } from "@opencode/util/effect/app-node"
// 从 effect 库导入上下文、Effect、Layer（层）与作用域（Scope）
import { Context, Effect, Layer, Scope } from "effect"
// 导入 Reference 的 schema 定义（数据源、信息、事件）
import { Reference } from "@opencode/schema/reference"
// 导入全局（Global）服务，提供全局数据目录
import { Global } from "@opencode/util/global"
// 导入事件总线（Bus）服务
import { Bus } from "./bus.js"
// 导入仓库（Repository）解析与路径工具
import { Repository } from "./repository.js"
// 导入仓库缓存（RepositoryCache）服务，用于物化 Git 引用
import { RepositoryCache } from "./repository-cache.js"
// 导入绝对路径 schema
import { AbsolutePath } from "./schema.js"
// 导入状态（State）模块，用于构建可编辑的持久状态
import { State } from "./state.js"

// 转发导出本地数据源（LocalSource）类型
export const LocalSource = Reference.LocalSource
export type LocalSource = Reference.LocalSource

// 转发导出 Git 数据源（GitSource）类型
export const GitSource = Reference.GitSource
export type GitSource = Reference.GitSource

// 转发导出数据源联合类型（Source）
export const Source = Reference.Source
export type Source = Reference.Source

// 转发导出 Reference 的事件定义
export { Event } from "@opencode/schema/reference"

// 转发导出引用信息（Info）类型
export const Info = Reference.Info
export type Info = Reference.Info

// 内部数据结构：名称到数据源（source）的映射
type Data = {
  sources: Map<string, Source>
}

// 编辑器（Editor）接口：对 sources 映射的增删查操作
type Editor = {
  // 添加（或覆盖）一个命名引用
  add(name: string, source: Source): void
  // 按名称删除引用
  remove(name: string): void
  // 列出全部 [名称, 数据源] 对
  list(): readonly [string, Source][]
  // 按名称读取引用
  get(name: string): Source | undefined
}

// 服务接口：支持 State 变换，并可列出引用信息
export interface Interface extends State.Transformable<Editor> {
  // 列出全部引用信息
  readonly list: () => Effect.Effect<Info[]>
}

// 定义 Reference 服务：将接口绑定到依赖注入上下文
export class Service extends Context.Service<Service, Interface>()("@opencode/Reference") {}

// 服务实现层
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 依赖：全局服务（提供全局仓库目录）
    const global = yield* Global.Service
    // 依赖：事件总线
    const bus = yield* Bus.Service
    // 依赖：仓库缓存
    const cache = yield* RepositoryCache.Service
    // 依赖：当前作用域，用于在作用域内派生后台 fiber
    const scope = yield* Scope.Scope
    // 将数据映射为引用信息列表：本地源返回本地路径，Git 源返回缓存检出（checkout）路径
    const list = (data: Data = state.get()): Info[] =>
      // 遍历每个 [名称, 数据源] 对并扁平化结果
      Array.from(data.sources).flatMap(([name, source]) => {
        // 组装基础信息字段
        const info = {
          name,
          source,
          // 描述字段仅在存在时加入
          ...(source.description === undefined ? {} : { description: source.description }),
          // 隐藏标记仅在存在时加入
          ...(source.hidden === undefined ? {} : { hidden: source.hidden }),
        }
        // 本地源：直接使用其本地路径
        if (source.type === "local") return [Info.make({ ...info, path: source.path })]
        // Git 源：解析仓库引用
        const repository = Repository.parse(source.repository)
        // 解析失败或不是远程仓库则跳过该引用
        if (!repository || !Repository.isRemote(repository)) return []
        // 指定了分支则先校验分支名合法性
        if (source.branch) {
          try {
            Repository.validateBranch(source.branch)
          } catch {
            // 分支非法则跳过该引用
            return []
          }
        }
        // 返回以缓存检出路径为 path 的引用信息
        return [
          Info.make({
            ...info,
            path: AbsolutePath.make(Repository.cachePath(global.repos, repository, source.branch)),
          }),
        ]
      })
    // 刷新操作：为每个 Git 引用确保缓存检出存在且最新
    const refresh = Effect.fn("Reference.refresh")(function* () {
      // 以并发度 4 遍历所有引用
      yield* Effect.forEach(
        list(),
        (reference) =>
          Effect.gen(function* () {
            // 非 Git 源无需物化
            if (reference.source.type !== "git") return
            // 确保缓存中有该仓库/分支的检出，按“每日”节流刷新
            yield* cache.ensure({
              reference: Repository.parseRemote(reference.source.repository),
              branch: reference.source.branch,
              refresh: "daily",
            })
          }).pipe(
            // 单个引用失败仅记录警告，不影响其他引用
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to materialize reference", { name: reference.name, cause }),
            ),
          ),
        { concurrency: 4, discard: true },
      )
    })
    // 创建引用状态：初始为空映射，编辑器暴露增删查，变更时触发刷新与事件
    const state = State.create<Data, Editor>({
      // 状态名称
      name: "reference",
      // 初始数据：空的 sources 映射
      initial: () => ({ sources: new Map() }),
      // 编辑器实现：包装对 sources 映射的操作
      editor: (editor) => ({
        add: (name, source) => editor.sources.set(name, source),
        remove: (name) => editor.sources.delete(name),
        list: () => Array.from(editor.sources),
        get: (name) => editor.sources.get(name),
      }),
      // 变更通知：在后台派生刷新任务，并发布引用更新事件
      notify: State.changes(list, () =>
        Effect.gen(function* () {
          // 在当前作用域内 fork（派生）刷新任务，不阻塞变更流程
          yield* refresh().pipe(Effect.forkIn(scope))
          // 发布引用已更新事件
          yield* bus.publish(Reference.Event.Updated, {})
        }),
      ),
    })

    // Check independently of session activity; the shared cache throttles Git work daily.
    // 独立于会话活动周期性刷新；共享缓存会把 Git 工作节流到每日一次
    yield* Effect.sleep("1 hour").pipe(Effect.andThen(refresh()), Effect.forever, Effect.forkScoped)

    // 组装并返回服务实现
    return Service.of({
      // 暴露状态变换（transform）能力
      transform: state.transform,
      // 暴露状态重载（reload）能力
      reload: state.reload,
      // 列出全部引用信息
      list: Effect.fn("Reference.list")(function* () {
        return list()
      }),
    })
  }),
)

// 构建 Reference 的分层节点，声明其依赖的节点
export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Global.node, Bus.node, RepositoryCache.node],
})
