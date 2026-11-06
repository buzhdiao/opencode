// 以命名空间形式整体导出本模块
export * as Watcher from "./watcher.js"

// 导入 @parcel/watcher 的包装器工厂（把原生绑定包装成统一 API）
// @ts-ignore
import { createWrapper } from "@parcel/watcher/wrapper.js"
// 仅作类型导入：Parcel watcher 的类型定义
import type ParcelWatcher from "@parcel/watcher"
// 导入 makeGlobalNode：声明全局单例图层节点的辅助函数
import { makeGlobalNode } from "@opencode/util/effect/app-node"
// 导入 FSUtil：路径包含关系判断等文件系统工具
import { FSUtil } from "@opencode/util/fs-util"
// 导入 isRecord：判断未知值是否为对象记录的工具
import { isRecord } from "@opencode/util/record"
// 从 effect 库导入所需模块：Cause、Context、Effect、Layer、PubSub（发布订阅）、
// RcMap（引用计数映射）、Stream（流）
import { Cause, Context, Effect, Layer, PubSub, RcMap, Stream } from "effect"
// 导入 lazy：惰性单例求值工具
import { lazy } from "../util/lazy.js"
// 导入 Node 的 watch（fs.watch，作为无原生绑定时的回退）与 path 模块
import { watch } from "node:fs"
import path from "path"
// 导入原生绑定加载器（按平台/libc 选择 @parcel/watcher 变体）
import loadBinding from "./watcher-binding.js"

// SUBSCRIBE_TIMEOUT_MS：原生订阅建立的最长等待时间（10 秒），超时放弃
const SUBSCRIBE_TIMEOUT_MS = 10_000

// watcher：惰性加载的原生 watcher 实例；加载失败时为 undefined（回退到 fs.watch）
const watcher = lazy((): typeof ParcelWatcher | undefined => {
  try {
    // 加载平台绑定并用官方 wrapper 包装
    return createWrapper(loadBinding()) as typeof ParcelWatcher
  } catch {
    // 任何加载错误都降级为“无原生绑定”
    return
  }
})

// getBackend：按平台返回 parcel watcher 的后端类型名
function getBackend() {
  if (process.platform === "win32") return "windows"
  if (process.platform === "darwin") return "fs-events"
  if (process.platform === "linux") return "inotify"
}

// hasNativeBinding：原生绑定是否成功加载
export const hasNativeBinding = () => !!watcher()
// Update：单条文件更新事件（parcel 的事件类型）
export type Update = ParcelWatcher.Event

// WatchInput：订阅请求的三种形态——单文件、指定名称集合、整个目录（可带忽略规则）
export type WatchInput =
  | { readonly path: string; readonly type: "file" }
  | { readonly path: string; readonly type: "entries"; readonly names: readonly string[] }
  | { readonly path: string; readonly type: "directory"; readonly ignore?: readonly string[] }

// Subscription：一个原生订阅的句柄
type Subscription = {
  readonly unsubscribe: () => Promise<void>
  /** 原有注释：用于日志的后端名称，例如 "node" 或 "fs-events"。 */
  /** Backend name for logging, e.g. "node" or "fs-events". */
  readonly backend?: string
}

// Target：RcMap 的键——去重后的监视目标（路径 + 忽略列表 + 可选名称集合）
type Target = {
  readonly target: string
  readonly ignore: readonly string[]
} & (
  | { readonly type: "entries"; readonly names: readonly string[] }
  | { readonly type: "file" | "directory"; readonly names?: readonly string[] }
)

// NativeInterface：原生监视服务的契约——按目标建立订阅并回传更新
export interface NativeInterface {
  readonly subscribe: (
    input: Target & { readonly publish: (update: Update) => void },
  ) => Effect.Effect<Subscription | undefined>
}

/** 原有注释：对即时条目（file/entries）用 fs.watch，对递归目录用 Parcel watcher。 */
/** Uses fs.watch for immediate entries and Parcel for recursive directories. */
export class Native extends Context.Service<Native, NativeInterface>()("@opencode/Watcher/Native") {}

// Interface：Watcher 服务的能力——订阅并返回事件流
export interface Interface {
  /** 原有注释：onReady 在原生订阅建立且监听注册完成后、流被消费时执行。 */
  /** onReady runs after native acquisition and listener registration, when the stream is consumed. */
  readonly subscribe: (input: WatchInput, onReady?: Effect.Effect<void>) => Effect.Effect<Stream.Stream<Update>>
}

// Options：图层选项——enabled 为 false 时完全禁用监视
export interface Options {
  readonly enabled?: boolean
}

// 声明 Watcher 服务标签
export class Service extends Context.Service<Service, Interface>()("@opencode/Watcher") {}

// TestInterface：测试专用扩展——手动注入事件、列出订阅记录
interface TestInterface extends Interface {
  /** 原有注释：把一条更新投递给所有目标覆盖 `update.path` 的活跃监视。 */
  /** Delivers one update to every active watch whose target covers `update.path`. */
  readonly emit: (update: Update) => Effect.Effect<void>
  /** 原有注释：按顺序返回迄今观察到的所有 subscribe 调用。 */
  /** Returns every subscribe call observed so far, in order. */
  readonly subscriptions: () => Effect.Effect<readonly WatchInput[]>
}

// 声明测试专用服务标签
export class Test extends Context.Service<Test, TestInterface>()("@opencode/Watcher/Test") {}

// layer：构建 Watcher 主服务——共享的原生订阅按目标去重，事件经 PubSub 分发给订阅者
export const layer = (options?: Options) =>
  Layer.effect(
    // 提供的服务标签
    Service,
    Effect.gen(function* () {
      // 显式禁用：subscribe 返回空流
      if (options?.enabled === false) {
        return Service.of({ subscribe: () => Effect.succeed(Stream.empty) })
      }
      // 取出原生监视服务
      const native = yield* Native

      // 原有注释：键按结构相等（effect 的 Equal）比较，因此等价的监视共享同一个条目。
      // Keys compare structurally (effect Equal), so equivalent watches share one entry.
      const watchers = yield* RcMap.make({
        // lookup：为某个目标首次创建共享的 PubSub 与原生订阅
        lookup: (key: Target) =>
          Effect.gen(function* () {
            // 创建无界 PubSub 作为事件分发点；释放时关闭它
            const pubsub = yield* Effect.acquireRelease(PubSub.unbounded<Update>(), (pubsub) => PubSub.shutdown(pubsub))
            // 建立原生订阅；释放时退订并记录日志
            const subscription = yield* Effect.acquireRelease(
              native.subscribe({
                ...key,
                // 原生回调把更新发布到 PubSub
                publish: (update) => PubSub.publishUnsafe(pubsub, update),
              }),
              (subscription) =>
                subscription
                  ? Effect.promise(() => subscription.unsubscribe()).pipe(
                      // 退订失败也不影响关闭流程
                      Effect.ignoreCause,
                      Effect.andThen(Effect.logInfo("watcher stopped", { path: key.target, type: key.type })),
                    )
                  : Effect.void,
              // 原有注释：原生订阅可能最长挂起 SUBSCRIBE_TIMEOUT_MS；
              // 作用域关闭不能排在一次不可中断的获取之后，因此允许中断。
              // Native subscription may stay pending up to SUBSCRIBE_TIMEOUT_MS;
              // scope shutdown must not wait behind an uninterruptible acquisition.
              { interruptible: true },
            )
            // 原生侧不可用：直接关闭 PubSub，让订阅方的流立即结束而不是悬挂
            if (!subscription) {
              // 原有注释：不支持的后端——结束订阅方流而非让它们悬挂。
              // Unsupported backend: end subscriber streams instead of hanging them.
              yield* PubSub.shutdown(pubsub)
              return pubsub
            }
            // 记录订阅启动日志（含后端与忽略条数）
            yield* Effect.logInfo("watcher started", {
              path: key.target,
              type: key.type,
              backend: subscription.backend,
              ignores: key.ignore.length,
            })
            // 返回共享的 PubSub
            return pubsub
          }),
      })

      // subscribe：把 WatchInput 归一为目标键，返回从共享 PubSub 派生的事件流
      const subscribe = Effect.fnUntraced(function* (input: WatchInput, onReady: Effect.Effect<void> = Effect.void) {
        // 目标路径解析为绝对路径
        const target = path.resolve(input.path)
        // 忽略列表去重排序（仅目录模式有意义）
        const ignore = [...new Set(input.type === "directory" ? (input.ignore ?? []) : [])].toSorted()
        // 名称集合去重排序（仅 entries 模式有意义）
        const names = [...new Set(input.type === "entries" ? input.names : [])].toSorted()
        // 记录订阅日志
        yield* Effect.logInfo("watcher subscribe", {
          path: target,
          type: input.type,
          ignores: ignore.length,
        })
        // unwrap：流的具体来源延迟到被消费时才确定
        return Stream.unwrap(
          Effect.gen(function* () {
            // 获取（或创建）该目标的共享订阅
            const pubsub = yield* RcMap.get(watchers, { type: input.type, target, ignore, names })
            // 在 PubSub 上建立本订阅者的订阅
            const subscription = yield* PubSub.subscribe(pubsub)
            // PubSub 已被关闭（后端不可用）：返回空流
            if (yield* PubSub.isShutdown(pubsub)) return Stream.empty
            // 流被消费时触发 onReady 钩子
            yield* onReady
            // 把订阅包装为流
            return Stream.fromSubscription(subscription)
          }),
        )
      })

      // 返回服务实现
      return Service.of({ subscribe })
    }),
  )

/** 原有注释：测试图层——真实的订阅生命周期，但事件投递改为内存中的路径过滤。 */
/** Real subscription lifecycle with in-memory, path-filtered event delivery. */
export const testLayer = Layer.effectContext(
  Effect.gen(function* () {
    // 记录所有 subscribe 调用（按顺序）
    const subscriptions: WatchInput[] = []
    // 活跃监视表：发布回调 -> 该目标的路径匹配函数
    const active = new Map<(update: Update) => void, (path: string) => boolean>()
    // 构造模拟的 Native 服务
    const native = Native.of({
      subscribe: (input) =>
        Effect.sync(() => {
          // 把目标归一为 WatchInput 记录下来
          subscriptions.push(
            input.type === "file"
              ? { path: input.target, type: "file" }
              : input.type === "entries"
                ? { path: input.target, type: "entries", names: input.names }
                : input.ignore.length > 0
                  ? { path: input.target, type: "directory", ignore: input.ignore }
                  : { path: input.target, type: "directory" },
          )
          // 原有注释：字面忽略项像 parcel 包装器一样基于目标路径解析；glob 忽略项会解析成
          // 没有路径能落在其下的位置，因此在这里天然失效，而不会像 parcel 那样编译成 glob。
          // Ignore entries resolve against the target like the parcel wrapper's
          // literal paths. Glob entries resolve to paths nothing lives under, so
          // they are inert here rather than compiled the way parcel compiles them.
          const ignored = input.ignore.map((entry) => path.resolve(input.target, entry))
          // 登记路径匹配函数：文件要求全等；entries 要求同目录且名称命中；目录要求包含且不被忽略
          active.set(input.publish, (target) => {
            if (input.type === "file") return target === input.target
            if (input.type === "entries")
              return path.dirname(target) === input.target && input.names.includes(path.basename(target))
            return FSUtil.contains(input.target, target) && !ignored.some((entry) => FSUtil.contains(entry, target))
          })
          // 返回订阅句柄：退订即从活跃表移除
          return {
            unsubscribe: () => {
              active.delete(input.publish)
              return Promise.resolve()
            },
          }
        }),
    })
    // 用模拟 Native 装配出真实的 Watcher 图层并构建其上下文
    const context = yield* Layer.build(layer().pipe(Layer.provide(Layer.succeed(Native, native))))
    // 构造测试服务：订阅复用真实实现，emit 手动分发，subscriptions 读取记录
    const test = Test.of({
      subscribe: Context.get(context, Service).subscribe,
      emit: (update) =>
        Effect.sync(() => {
          // 把更新路径解析为绝对路径后，逐个检查活跃监视是否命中
          const target = path.resolve(update.path)
          active.forEach((matches, publish) => {
            if (matches(target)) publish(update)
          })
        }),
      subscriptions: () => Effect.sync(() => [...subscriptions]),
    })
    // 同时以 Service 与 Test 两个标签提供同一个实现
    return Context.empty().pipe(Context.add(Service, test), Context.add(Test, test))
  }),
)

// nativeLayer：真实的原生监视实现——即时目标走 fs.watch，目录走 parcel watcher
export const nativeLayer = Layer.succeed(
  // 提供的服务标签
  Native,
  Native.of({
    subscribe: (input) => {
      // 单文件与名称集合：目标是一个具体文件，退化为监听其所在目录
      if (input.type === "file" || input.type === "entries") {
        // 单文件监听其父目录；entries 直接监听目标目录
        const directory = input.type === "file" ? path.dirname(input.target) : input.target
        // 需要放行的文件名集合
        const names = new Set(input.type === "file" ? [path.basename(input.target)] : input.names)
        return Effect.try({
          try: () =>
            // fs.watch 非递归监听目录，回调按名称过滤
            watch(directory, { recursive: false }, (_event, file) => {
              // 名称不在集合内的事件直接丢弃
              if (file && !names.has(file)) return
              // 对命中的名称发布 update 事件（无文件名时对整个集合各发一条）
              for (const name of file ? [file] : names) {
                input.publish({ path: path.join(directory, name), type: "update" })
              }
            }),
          catch: (error) => error,
        }).pipe(
          Effect.map((subscription): Subscription => {
            // 监听器内部错误只记日志，不让进程崩溃
            subscription.on("error", (error: unknown) =>
              Effect.runFork(Effect.logError("watcher callback failed", { path: directory, error })),
            )
            // 返回订阅句柄（backend 标记为 node）
            return { unsubscribe: () => Promise.resolve(subscription.close()), backend: "node" }
          }),
          // 原有注释：目录不存在（ENOENT）时结束订阅方流，而不是让监视崩溃。
          // A missing directory (ENOENT) ends subscriber streams instead of crashing the watch.
          Effect.catch((error) =>
            isRecord(error) && error.code === "ENOENT"
              ? Effect.undefined
              : Effect.logError("failed to watch directory", { path: directory, error }).pipe(Effect.as(undefined)),
          ),
        )
      }
      // 目录目标：交给 parcel watcher 的原生订阅流程
      return subscribeDirectory(watcher(), getBackend(), input.target, input.ignore, input.publish)
    },
  }),
)

// nativeNode：把原生监视实现注册为全局节点
const nativeNode = makeGlobalNode({ service: Native, layer: nativeLayer, deps: [] })

// configured：构建 Watcher 主服务节点（依赖原生节点）
export function configured(options?: Options) {
  return makeGlobalNode({ service: Service, layer: layer(options), deps: [nativeNode] })
}

// 导出默认配置的节点实例
export const node = configured()

// subscribeDirectory：建立 parcel watcher 的目录订阅，包装超时、中断与错误处理
function subscribeDirectory(
  // 惰性解析出的原生 watcher（可能为 undefined）
  native: typeof ParcelWatcher | undefined,
  // 平台后端类型（可能为 undefined）
  backend: ParcelWatcher.BackendType | undefined,
  // 要监视的目录
  directory: string,
  // 忽略规则列表
  ignore: readonly string[],
  // 事件发布回调
  publish: (update: Update) => void,
): Effect.Effect<Subscription | undefined> {
  // 无原生绑定或平台不支持：记日志并返回 undefined（订阅方流会立即结束）
  if (!native || !backend) {
    return Effect.logError("watcher backend not supported", { directory, platform: process.platform }).pipe(
      Effect.as(undefined),
    )
  }
  // 原生回调：出错只记日志；每条更新转发给发布回调
  const callback: ParcelWatcher.SubscribeCallback = (error, updates) => {
    if (error) Effect.runFork(Effect.logError("watcher callback failed", { error }))
    for (const update of updates) publish(update)
  }
  // 原有注释：复制 `ignore`——它引用了 RcMap 的键，而键的结构哈希已被缓存，
  // 交给原生代码的数组绝不能是可变的原始引用。
  // Copy `ignore`: it aliases the RcMap key, whose structural hash is cached,
  // so the array handed to native code must never be the mutable original.
  const pending = native.subscribe(directory, callback, { ignore: [...ignore], backend })
  return Effect.promise(() => pending).pipe(
    // 订阅就绪后包装成句柄
    Effect.map((subscription) => ({ unsubscribe: () => subscription.unsubscribe(), backend })),
    // 原有注释：被中断（包括下方的超时）时会放弃等待中的原生订阅，
    // 因此待其最终完成后要补一次退订。
    // Interruption (including the timeout below) abandons the pending native
    // subscription, so close it once it eventually resolves.
    Effect.onInterrupt(() =>
      Effect.sync(() => {
        pending.then((subscription) => subscription.unsubscribe()).catch(() => {})
      }),
    ),
    // 订阅建立最多等待 10 秒
    Effect.timeout(SUBSCRIBE_TIMEOUT_MS),
    // 一切失败都只记日志并返回 undefined，不让调用方崩溃
    Effect.catchCause((cause) =>
      Effect.logError("failed to subscribe", {
        directory,
        cause: Cause.pretty(cause),
      }).pipe(Effect.as(undefined)),
    ),
  )
}
