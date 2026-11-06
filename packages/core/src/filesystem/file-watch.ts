// 以命名空间形式整体导出本模块
export * as FileWatch from "./file-watch.js"

// 导入 makeGlobalNode：声明全局单例图层节点的辅助函数
import { makeGlobalNode } from "@opencode/util/effect/app-node"
// 导入 FSUtil：带错误归一的文件系统工具服务
import { FSUtil } from "@opencode/util/fs-util"
// 导入 FileSystem schema：文件系统变更事件的定义
import { FileSystem } from "@opencode/schema/filesystem"
// 仅作类型导入：Location.Ref 位置引用类型
import type { Location } from "@opencode/schema/location"
// 从 effect 库导入所需的各模块：Cause（原因）、Clock（时钟）、Context（依赖上下文）、
// Duration（时长）、Effect（效果类型）、Exit（结果）、Layer（图层）、Schedule（调度）、
// Schema（校验）、Scope（作用域）、Semaphore（信号量）、Stream（流）
import {
  Cause,
  Clock,
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  Schedule,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect"
// 导入 Bus 服务：进程内事件总线
import { Bus } from "../bus.js"
// 导入 Watcher 服务：底层文件监听（subscribe）能力
import { Watcher } from "./watcher.js"

// TTL：单个文件监视的存活时间——超过 24 小时未被“续期”就过期
export const TTL = Duration.hours(24)
// SWEEP_INTERVAL：过期清理的轮询间隔——每 5 分钟扫一次
export const SWEEP_INTERVAL = Duration.minutes(5)
// MAX_PER_LOCATION：单个位置允许的最大监视文件数，超出时替换最早过期的条目
export const MAX_PER_LOCATION = 256

// DisabledError：文件监视功能被显式禁用时抛出的错误
export class DisabledError extends Schema.TaggedError<DisabledError>()("FileWatch.DisabledError", {}) {
  // 错误消息：文件监视已禁用
  override get message() {
    return "File watching is disabled"
  }
}

// Input：watch/unwatch 的入参——位置引用 + 要监视的文件
export type Input = {
  readonly location: Location.Ref
  /** 原有注释：要监视的文件的绝对路径。 */
  /** Absolute path of the file to watch. */
  readonly file: string
}

// Interface：文件监视服务对外暴露的能力
export interface Interface {
  /** 原有注释：开始监视某文件；若已在监视则重置其过期时间。 */
  /** Starts watching a file, or resets its expiry when it is already watched. */
  readonly watch: (input: Input) => Effect.Effect<void, DisabledError>
  // unwatch：停止监视某文件
  readonly unwatch: (input: Input) => Effect.Effect<void>
}

// 声明 FileWatch 服务标签
export class Service extends Context.Service<Service, Interface>()("@opencode/FileWatch") {}

// Options：图层配置项——enabled 为 false 时禁用监视
export const Options = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
})
export type Options = typeof Options.Type

// Entry：单个文件监视的内部条目——过期时间戳 + 持有监视 fiber 的可关闭作用域
type Entry = { expires: number; scope: Scope.Closeable }

// 原有注释：采用全局（而非按位置隔离）作用域，使监视能在空闲位置被逐出后依然存活。
// Global rather than location-scoped so watches outlive idle location eviction.
export const layer = (options?: Options) =>
  Layer.effect(
    // 提供的服务标签
    Service,
    Effect.gen(function* () {
      // 显式禁用：返回桩实现——watch 一律失败，unwatch 什么都不做
      if (options?.enabled === false) {
        return Service.of({ watch: () => Effect.fail(new DisabledError()), unwatch: () => Effect.void })
      }
      // 取出依赖：底层监听器、事件总线、文件系统工具
      const watcher = yield* Watcher.Service
      const bus = yield* Bus.Service
      const fs = yield* FSUtil.Service
      // 取当前（宿主）作用域，用于派生子作用域与后台 fiber
      const scope = yield* Effect.scope
      // 创建二元信号量，串行化对监视表的所有变更
      const lock = yield* Semaphore.make(1)
      // 监视表：位置键 -> (文件路径 -> 条目)
      const locations = new Map<string, Map<string, Entry>>()
      // locationKey：把位置引用序列化为稳定的字符串键（目录 + workspaceID）
      const locationKey = (location: Location.Ref) => JSON.stringify([location.directory, location.workspaceID])

      // remove：从表中摘除指定文件的条目（并清空空掉的位置映射），返回被摘除的条目
      const remove = (key: string, file: string) => {
        const files = locations.get(key)
        const entry = files?.get(file)
        if (!files || !entry) return
        files.delete(file)
        if (files.size === 0) locations.delete(key)
        return entry
      }

      // stop：停止对指定文件的监视——摘除条目并关闭其作用域（会中断其中的监视 fiber）
      const stop = (key: string, file: string) =>
        Effect.suspend(() => {
          const entry = remove(key, file)
          if (!entry) return Effect.void
          return Scope.close(entry.scope, Exit.void)
        })

      // start：为文件启动一个新的监视 fiber，返回持有它的子作用域
      const start = Effect.fnUntraced(function* (key: string, input: Input) {
        // 从宿主作用域 fork 出子作用域，监视的生命周期由它承载
        const child = yield* Scope.fork(scope)
        yield* Effect.gen(function* () {
          // 订阅该文件的底层变更流
          const updates = yield* watcher.subscribe({ path: input.file, type: "file" })
          // 对每条变更：检查文件是否仍存在，并向总线发布对应事件
          yield* Stream.runForEach(updates, () =>
            Effect.gen(function* () {
              const exists = yield* fs.existsSafe(input.file)
              yield* bus.publish(
                FileSystem.Event.Changed,
                { file: input.file, event: exists ? "change" : "unlink" },
                { location: input.location },
              )
            }),
          )
        }).pipe(
          // 订阅异常（非中断类）只记录日志，不让监视崩溃
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterrupts(cause),
            (cause) => Effect.logError("file watch failed", { file: input.file, cause }),
          ),
          // 原有注释：监视已结束或失败（例如其所在目录被删除）时，把它从表中遗忘，
          // 让下一次 watch 能重新启动；中断不走这里。作用域由另一个 fiber 关闭，
          // 因为关闭动作本身会中断当前 fiber。
          // The watch ended or failed (e.g. its directory vanished): forget it so the next watch starts a new one.
          // Interrupts skip this. The scope closes from another fiber because closing it interrupts this one.
          Effect.andThen(
            lock.withPermit(
              Effect.suspend(() => {
                // 仅当表中登记的仍是本作用域时才清理（防止误删后来者）
                if (locations.get(key)?.get(input.file)?.scope !== child) return Effect.void
                remove(key, input.file)
                // 在宿主作用域内 fork 关闭动作，避免自中断
                return Scope.close(child, Exit.void).pipe(Effect.forkIn(scope), Effect.asVoid)
              }),
            ),
          ),
          // 立即启动并挂到子作用域中运行
          Effect.forkIn(child, { startImmediately: true }),
        )
        // 返回子作用域，供条目保存
        return child
      })

      // sweep：一次过期清理——收集所有已到期的 (位置, 文件) 并逐个 stop
      const sweep = lock.withPermit(
        Effect.gen(function* () {
          // 取当前时间
          const now = yield* Clock.currentTimeMillis
          // 展平所有位置下的条目，筛出过期者
          const expired = [...locations].flatMap(([key, files]) =>
            [...files].filter(([, entry]) => entry.expires <= now).map(([file]) => [key, file] as const),
          )
          // 逐个停止过期的监视
          yield* Effect.forEach(expired, ([key, file]) => stop(key, file), { discard: true })
        }),
      )
      // 启动周期清理：立即执行一次，此后每 5 分钟重复，挂在当前作用域
      yield* sweep.pipe(Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)), Effect.forkScoped)

      // 返回服务实现
      return Service.of({
        // watch：开始监视或续期
        watch: (input) =>
          lock.withPermit(
            Effect.gen(function* () {
              // 计算位置键与新的过期时间
              const key = locationKey(input.location)
              const expires = (yield* Clock.currentTimeMillis) + Duration.toMillis(TTL)
              // 已在监视：只刷新过期时间（续期）
              const existing = locations.get(key)?.get(input.file)
              if (existing) {
                existing.expires = expires
                return
              }
              // 位置配额已满：找到最早过期的条目并停掉，腾出名额
              const full = locations.get(key)
              if (full && full.size >= MAX_PER_LOCATION) {
                const soonest = [...full].reduce((a, b) => (b[1].expires < a[1].expires ? b : a))
                yield* stop(key, soonest[0])
              }
              // 启动新监视并登记到表中
              const entry = { expires, scope: yield* start(key, input) }
              const files = locations.get(key) ?? new Map<string, Entry>()
              files.set(input.file, entry)
              locations.set(key, files)
            }),
          ),
        // unwatch：停止监视指定文件
        unwatch: (input) => lock.withPermit(stop(locationKey(input.location), input.file)),
      })
    }),
  )

// configured：按配置构建 FileWatch 的全局图层节点（依赖 Watcher、Bus、FSUtil）
export function configured(options?: Options) {
  return makeGlobalNode({ service: Service, layer: layer(options), deps: [Watcher.node, Bus.node, FSUtil.node] })
}

// 导出默认配置的节点实例
export const node = configured()
