// 配置条目观察器（Entry Observer）：在配置更新时触发重载的共用工具集。
export * as ConfigEntryObserver from "./entry-observer.js"

// 导入事件域类型。
import type { EventDomain } from "@opencode/plugin/effect/event"
// 导入配置条目（Entry）类型。
import type { Entry } from "@opencode/schema/config"
// 导入文件系统工具。
import { FSUtil } from "@opencode/util/fs-util"
// 导入 Effect 的并发与流工具。
import { Effect, PubSub, Stream } from "effect"
// 导入 Node 的 path 模块。
import path from "path"
// 导入配置服务。
import { Config } from "../../config.js"

export const observe = Effect.fnUntraced(function* (
  config: Config.Interface,
  event: EventDomain,
  reload: Effect.Effect<void>,
) {
  const loaded = { entries: yield* config.entries() }
  const refresh = config.entries().pipe(
    Effect.tap((entries) => Effect.sync(() => (loaded.entries = entries))),
    Effect.andThen(reload),
  )
  yield* event.subscribe({ types: ["config.updated"] }).pipe(
    Stream.runForEach(() => refresh),
    Effect.forkScoped({ startImmediately: true }),
  )
  // Close the race between the first read and establishing the subscription.
  loaded.entries = yield* config.entries()
  return loaded
})

/**
 * Loads documents from config entries and reloads them when config is updated or a file changes
 * under one of `directories` in a config directory.
 */
// 来源观察：加载配置文档，并在配置更新或配置目录下 `directories` 中的文件变化时重载。
export const observeSources = Effect.fnUntraced(function* <A>(input: {
  // 配置服务。
  readonly config: Config.Interface
  // 事件域。
  readonly event: EventDomain
  // 需要监视的配置子目录名。
  readonly directories: readonly string[]
  // 文档加载函数。
  readonly load: () => Effect.Effect<A[]>
  // 文档加载完成后的外部重载动作。
  readonly reload: Effect.Effect<void>
}) {
  // 配置服务引用。
  const config = input.config
  // 可变的已加载文档容器。
  const loaded = { documents: [] as A[] }
  // 重载流程：先重新加载文档，再触发调用方提供的 reload。
  const reload = input.load().pipe(
    // 加载完成后把文档写入容器。
    Effect.tap((documents) => Effect.sync(() => (loaded.documents = documents))),
    // 然后执行外部 reload。
    Effect.andThen(input.reload),
  )
  // One trigger feed serializes reloads and shares one debounce window;
  // subscribing before the initial scan means updates racing the scan still
  // trigger a rebuild. Each source is subscribed eagerly on its own fiber
  // (Stream.merge and Stream.debounce both open upstream a fiber hop later)
  // so no update slips through while the debounce starts its pull.
  // 单一触发通道串行化重载并共享一个去抖窗口；先订阅再初扫，与扫描赛跑的更新仍会触发重建。
  // 每个来源在各自的 fiber 上先行订阅（Stream.merge 与 Stream.debounce 都会晚一拍才打开上游），
  // 避免去抖启动拉取时漏掉更新。
  const changes = yield* PubSub.sliding<void>(1)
  // 发布一次触发信号。
  const notify = () => PubSub.publish(changes, undefined)
  // 配置变化：仅当变化路径落在指定目录来源之下才触发。
  yield* config.changes().pipe(
    Stream.filterEffect((update) =>
      Effect.map(config.entries(), (entries) => isDirectorySource(entries, update.path, input.directories)),
    ),
    Stream.runForEach(notify),
    Effect.forkScoped({ startImmediately: true }),
  )
  // 订阅 config.updated 事件并触发。
  yield* input.event
    .subscribe({ types: ["config.updated"] })
    .pipe(Stream.runForEach(notify), Effect.forkScoped({ startImmediately: true }))
  // 订阅触发通道。
  const updates = yield* PubSub.subscribe(changes)
  // 去抖 100ms 后重载。
  yield* Stream.fromSubscription(updates).pipe(
    Stream.debounce("100 millis"),
    Stream.runForEach(() => reload),
    Effect.forkScoped({ startImmediately: true }),
  )
  // 初始加载一次文档。
  loaded.documents = yield* input.load()
  // 返回可变容器。
  return loaded
})

// Matches anything at or under <root>/<name> for a config directory. No file-suffix
// check: directory-level events such as renames carry no per-file paths.
// 判断文件是否位于某配置目录的 <目录>/<名> 之下。不检查文件后缀：重命名等目录级事件不携带具体文件路径。
export function isDirectorySource(entries: readonly Entry[], file: string, names: readonly string[]) {
  return entries.some(
    (entry) => entry.type === "directory" && names.some((name) => FSUtil.contains(path.join(entry.path, name), file)),
  )
}
