// 将本模块以命名空间 `PluginUpdate` 全量导出
export * as PluginUpdate from "./update.js"

// 引入 Effect 原语：Clock（时钟）、Context、Layer、Exit、PubSub（发布/订阅）、Stream（流）
import { Clock, Context, Effect, Exit, Layer, Option, PubSub, Stream } from "effect"
// 引入 Npm 服务：负责检查与更新插件包
import { Npm } from "@opencode/util/npm"
// 引入 EffectFlock：提供跨进程文件锁的错误类型
import { EffectFlock } from "@opencode/util/effect-flock"
// 引入全局节点工厂：把服务注册为宿主级全局单例
import { makeGlobalNode } from "@opencode/util/effect/app-node"
// 引入按键互斥锁（KeyedMutex）：按 target 键串行化操作
import { KeyedMutex } from "../effect/keyed-mutex.js"

// 更新检查的最小间隔：24 小时（毫秒），缓存期内不重复查询 registry
const interval = 24 * 60 * 60 * 1_000

// 变更事件：描述某个包目标的过时/更新中状态
interface Change {
  // 包目标（如 npm 包名）
  readonly target: string
  // 是否有可用更新（过时）
  readonly outdated: boolean
  // 是否正在执行更新
  readonly updating: boolean
}

// 插件更新服务接口：检查、更新与订阅变更
export interface Interface {
  // check：查询某包是否有可用更新（可强制刷新缓存）
  readonly check: (target: string, options?: { readonly refresh?: boolean }) => Effect.Effect<boolean>
  // update：执行包更新；可能因 npm 安装失败或锁失败而报错
  readonly update: (target: string) => Effect.Effect<void, Npm.InstallFailedError | EffectFlock.LockError>
  // changes：返回状态变更流
  readonly changes: () => Stream.Stream<Change>
}

// 定义服务标签，供依赖注入系统识别本服务
export class Service extends Context.Service<Service, Interface>()("@opencode/PluginUpdate") {}

// 构建服务层：组装 npm 服务、按键锁、状态缓存与变更发布订阅
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 获取 Npm 服务实例
    const npm = yield* Npm.Service
    // 创建按键互斥锁：保证同一 target 的检查/更新串行
    const locks = KeyedMutex.makeUnsafe<string>()
    // 检查结果缓存：target -> { 是否过时, 检查时间 }
    const status = new Map<string, { readonly outdated: boolean; readonly checkedAt: number }>()
    // 无界发布订阅通道：广播状态变更
    const changes = yield* PubSub.unbounded<Change>()

    // 组装服务实现
    return Service.of({
      // check 实现：持锁检查某包是否过时
      check: (target, options) =>
        locks.withLock(target)(
          Effect.gen(function* () {
            // 读取当前时间作为检查时间戳
            const checkedAt = yield* Clock.currentTimeMillis
            // 读取缓存结果
            const current = status.get(target)
            // 缓存未过期且未要求刷新：直接返回缓存的过时标记
            if (!options?.refresh && current && checkedAt - current.checkedAt < interval) return current.outdated
            // 调用 npm 检查更新；失败时记录警告并把错误折叠为 None
            const outdated = yield* npm.check(target).pipe(
              Effect.tapCause((cause) => Effect.logWarning("failed to check plugin update", { target, cause })),
              Effect.option,
            )
            // 检查成功用新值，失败时回退到旧缓存值（都没有则 false）
            const value = Option.getOrElse(outdated, () => current?.outdated ?? false)
            // 写入缓存
            status.set(target, { outdated: value, checkedAt })
            // 若过时状态发生变化则广播变更事件
            if ((current?.outdated ?? false) !== value)
              yield* PubSub.publish(changes, { target, outdated: value, updating: false })
            // 返回最终过时标记
            return value
          }),
        ),
      // Serialize per target so a concurrent update cannot clear the in-progress flag of another still running.
      // update 实现：按 target 串行执行，避免并发更新互相清除"进行中"标记
      update: (target) =>
        locks.withLock(target)(
          Effect.gen(function* () {
            // 读取当前过时状态（无缓存视为 false）
            const outdated = status.get(target)?.outdated ?? false
            // 广播"开始更新"事件
            yield* PubSub.publish(changes, { target, outdated, updating: true })
            // 执行 npm 更新；成功后删除缓存以强制下次重新检查
            yield* npm.update(target).pipe(
              Effect.tap(() => Effect.sync(() => status.delete(target))),
              // 无论成功失败，在退出时广播"更新结束"事件
              Effect.onExit((exit) =>
                PubSub.publish(changes, {
                  target,
                  // 成功则视为不再过时；失败则保持原过时状态
                  outdated: Exit.isSuccess(exit) ? false : outdated,
                  // 更新结束，清除"进行中"标记
                  updating: false,
                }),
              ),
            )
          }),
        ),
      // changes 实现：把发布订阅通道转换为流
      changes: () => Stream.fromPubSub(changes),
    })
  }),
)

// 创建全局节点：以更新服务为核心，依赖 Npm 节点
export const node = makeGlobalNode({ service: Service, layer, deps: [Npm.node] })
