// 以命名空间形式整体导出本模块
export * as LocationWatcher from "./location-watcher.js"

// 导入 makeLocationNode：按位置构建全局图层节点的辅助函数
import { makeLocationNode } from "@opencode/util/effect/app-node"
// 从 effect 库导入所需模块：Cause、Context、Effect、Exit、Layer、Scope、Semaphore、Stream
import { Cause, Context, Effect, Exit, Layer, Scope, Semaphore, Stream } from "effect"
// 导入 FileSystem schema：文件系统变更事件
import { FileSystem } from "@opencode/schema/filesystem"
// 导入 Node 的 path 模块（拼接版本控制目录路径）
import path from "path"
// 导入内部依赖：事件总线、文件系统工具、Git、位置、插件、监听策略、底层监听器
import { Bus } from "../bus.js"
import { FSUtil } from "@opencode/util/fs-util"
import { Git } from "../git.js"
import { Location } from "../location.js"
import { Plugin } from "../plugin.js"
import { LocationWatcherPolicy } from "./location-watcher-policy.js"
import { Watcher } from "./watcher.js"

// Interface：本服务当前不暴露方法（仅作为副作用型服务存在）
export interface Interface {}

// 声明 LocationWatcher 服务标签
export class Service extends Context.Service<Service, Interface>()("@opencode/LocationWatcher") {}

// 构建图层：为单个位置维持“版本控制头文件（HEAD/branch）”的监视，据此感知分支切换
const layer = Layer.effect(
  // 提供的服务标签
  Service,
  Effect.gen(function* () {
    // 依次取出依赖：位置、底层监听器、事件总线、文件系统工具、Git、监听策略
    const location = yield* Location.Service
    const watcher = yield* Watcher.Service
    const bus = yield* Bus.Service
    const fs = yield* FSUtil.Service
    const git = yield* Git.Service
    const policy = yield* LocationWatcherPolicy.Service
    // publish：把底层监听事件映射为总线上的文件变更事件（create/update/delete -> add/change/unlink）
    const publish = (update: { type: "create" | "update" | "delete"; path: string }) =>
      bus.publish(FileSystem.Event.Changed, {
        file: update.path,
        event: update.type === "create" ? "add" : update.type === "update" ? "change" : "unlink",
      })
    // target：懒缓存地解析监视目标——Git 仓库的 HEAD 文件或 Mercurial 的 branch 文件，
    // 同时携带用于忽略匹配的别名列表（如 ".git"、真实路径、解析前路径）
    const target = yield* Effect.cached(
      Effect.gen(function* () {
        // Git 仓库：发现 .git 目录并解析为真实路径
        if (location.vcs?.type === "git") {
          const resolved = (yield* git.repo.discover(location.directory))?.gitDirectory
          const vcs = resolved ? yield* fs.realPath(resolved).pipe(Effect.orElseSucceed(() => resolved)) : undefined
          // 目标为 HEAD 文件；别名含 ".git"、真实路径及原始发现路径
          if (vcs) return { path: path.join(vcs, "HEAD"), aliases: [".git", vcs, ...(resolved ? [resolved] : [])] }
        }
        // Mercurial 仓库：store 即 .hg 目录，监视其 branch 文件
        if (location.vcs?.type === "hg") {
          const store = location.vcs.store
          const vcs = yield* fs.realPath(store).pipe(Effect.orElseSucceed(() => store))
          return { path: path.join(vcs, "branch"), aliases: [".hg", vcs] }
        }
        // 无版本控制：返回 undefined
      }).pipe(
        // 打上诊断 span，便于追踪解析过程
        Effect.withSpan("LocationWatcher.target", { attributes: { directory: location.directory } }),
        // 解析失败只记日志并退化为无目标，不让服务崩溃
        Effect.catchCause((cause) =>
          Effect.logError("failed to resolve location watcher target", { cause }).pipe(Effect.as(undefined)),
        ),
      ),
    )
    // lock：二元信号量（unsafe 版），串行化 reconcile 与关闭逻辑
    const lock = Semaphore.makeUnsafe(1)
    // stopped：终结器已运行的标志，防止关闭后再重启
    let stopped = false
    // active：当前生效的监视（路径 + 承载 fiber 的作用域）
    let active: { path: string; scope: Scope.Closeable } | undefined
    // reconcile：让监视状态向“目标解析结果 + 当前忽略策略”对齐——必要时停旧启新
    const reconcile = () =>
      lock.withPermit(
        Effect.gen(function* () {
          // 已停止则不再做任何事
          if (stopped) return
          // 读取解析好的目标与最新忽略列表
          const resolved = yield* target
          const ignore = policy.current()
          // 目标存在且其任一别名未被策略忽略时才启用监视
          const next = resolved && !resolved.aliases.some((alias) => ignore.includes(alias)) ? resolved.path : undefined
          // 目标没变化：无需动作
          if (active?.path === next) return
          // 关闭旧的监视作用域
          if (active) yield* Scope.close(active.scope, Exit.void)
          active = undefined
          // 无新目标：到此为止
          if (!next) return
          // 为新监视创建作用域并登记
          const scope = yield* Scope.make()
          active = { path: next, scope }
          yield* Effect.gen(function* () {
            // 订阅目标文件（HEAD/branch）的变更流
            const updates = yield* watcher.subscribe({ path: next, type: "file" })
            // 每条变更直接转发到总线
            yield* Stream.runForEach(updates, publish)
          }).pipe(
            // 非中断类失败只记日志，避免监视循环崩溃
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterrupts(cause),
              (cause) => Effect.logError("location watcher subscription failed", { path: next, cause }),
            ),
            // 立即启动并挂到该作用域
            Effect.forkIn(scope, { startImmediately: true }),
          )
        }).pipe(Effect.withSpan("LocationWatcher.reconcile", { attributes: { directory: location.directory } })),
      )
    // 注册图层终结器：标记停止并关闭尚在生效的监视
    yield* Effect.addFinalizer(() =>
      lock.withPermit(
        Effect.gen(function* () {
          stopped = true
          if (active) yield* Scope.close(active.scope, Exit.void)
          active = undefined
        }),
      ),
    )
    // 监听忽略策略的变化，实时重新对齐监视状态
    yield* policy.observe(reconcile)
    // 后台启动：等插件系统激活完成后执行首次 reconcile
    yield* Effect.gen(function* () {
      yield* Plugin.awaitActivation
      yield* reconcile()
    }).pipe(
      // 启动失败只记日志
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterrupts(cause),
        (cause) => Effect.logError("failed to start location watcher", { cause }),
      ),
      // 立即启动，挂在当前作用域
      Effect.forkScoped({ startImmediately: true }),
    )
    // 返回服务实现（无方法）
    return Service.of({})
  }),
)

// 导出位置节点：声明全部依赖节点
export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Watcher.node, FSUtil.node, Location.node, Git.node, Bus.node, Plugin.node, LocationWatcherPolicy.node],
})
