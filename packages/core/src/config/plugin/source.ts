// 配置插件来源（Config Plugin Source）模块：汇总自动发现与配置声明的插件（plugin）加载目标。
export * as ConfigPluginSource from "./source.js"

// 导入配置目录/文档/条目类型。
import { Directory, Document, type Entry } from "@opencode/schema/config"
// 导入插件配置模式。
import { ConfigPlugin } from "@opencode/schema/config/plugin"
// 导入文件系统工具服务。
import { FSUtil } from "@opencode/util/fs-util"
// 导入宿主入口解析工具。
import { Host } from "@opencode/plugin/host"
// 导入位置节点构造工具。
import { makeLocationNode } from "@opencode/util/effect/app-node"
// 导入 Effect 的上下文/分层/并发工具。
import { Context, Effect, Layer, Option, PubSub, Scope, Stream } from "effect"
// 导入 Node 的 path 模块。
import path from "path"
// 导入 URL 与路径互转工具。
import { fileURLToPath, pathToFileURL } from "url"
// 导入配置服务。
import { Config } from "../../config.js"
// 导入文件监视器服务。
import { Watcher } from "../../filesystem/watcher.js"
// 导入位置服务。
import { Location } from "../../location.js"
// 导入插件目录发现工具。
import { PluginSourceDirectory } from "../../plugin/source-directory.js"
// 导入配置条目观察器。
import { ConfigEntryObserver } from "./entry-observer.js"

// 插件加载操作：新增（含选项与可选的 mtime）或移除。
export type Operation =
  | {
      // 新增操作。
      readonly type: "add"
      // 加载目标（目录或文件路径）。
      readonly target: string
      // 插件选项。
      readonly options: Record<string, unknown>
      // 目标的最新修改时间（用于失效判断）。
      readonly mtime?: number
    }
  | {
      // 移除操作。
      readonly type: "remove"
      // 要移除的目标。
      readonly target: string
    }

// 服务接口：列出当前操作与订阅变更流。
export interface Interface {
  // 列出当前全部插件加载操作。
  readonly operations: () => Effect.Effect<readonly Operation[], never, Scope.Scope>
  // 配置或目标变化时的通知流。
  readonly changes: () => Stream.Stream<void>
}

// 定义服务标签。
export class Service extends Context.Service<Service, Interface>()("@opencode/ConfigPluginSource") {}

// 构造服务层。
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 获取配置服务。
    const config = yield* Config.Service
    // 获取文件监视器服务。
    const watcher = yield* Watcher.Service
    // 获取文件系统工具服务。
    const fs = yield* FSUtil.Service
    // 获取位置服务。
    const location = yield* Location.Service
    // 配置声明插件变化的发布订阅通道。
    const configuredChanges = yield* PubSub.unbounded<void>()
    // 已建立直接监视的目标集合。
    const watched = new Set<string>()

    // Configured local plugins can live outside config roots, where the
    // config change feed cannot see them; watch those targets directly.
    // Watches start on first sighting and are never torn down individually:
    // a stale watch after a config edit costs one deduped fs handle and a
    // no-op activation, and every watch dies with this layer's scope.
    // 为配置声明的本地插件目标建立直接监视：它们可能位于配置根之外，配置变化流看不到它们。
    // 监视在首次发现时建立且从不单独拆除：配置编辑后一个过期监视只花一个去重的文件句柄和一次空激活，
    // 所有监视随本层的 scope 一起销毁。
    const watchConfiguredSources = Effect.fn("ConfigPluginSource.watchConfiguredSources")(function* (
      entries: readonly Entry[],
      operations: readonly Operation[],
    ) {
      // 逐个检查新增操作。
      for (const operation of operations) {
        // 只处理新增且目标为绝对路径的操作。
        if (operation.type !== "add" || !path.isAbsolute(operation.target)) continue
        // 已监视过则跳过。
        if (watched.has(operation.target)) continue
        // The config change feed already covers {plugin,plugins} directories.
        // 配置变化流已覆盖 {plugin,plugins} 目录，无需重复监视。
        if (ConfigEntryObserver.isDirectorySource(entries, operation.target, PluginSourceDirectory.names)) continue
        // 标记为已监视。
        watched.add(operation.target)
        // 按目录或文件类型订阅监视。
        const updates = yield* watcher.subscribe({
          path: operation.target,
          type: (yield* fs.isDir(operation.target)) ? "directory" : "file",
        })
        // 更新转发到配置声明变化通道（失败记错误日志）。
        yield* updates.pipe(
          Stream.runForEach(() => PubSub.publish(configuredChanges, undefined)),
          Effect.catchCause((cause) =>
            Effect.logError("configured plugin watch failed", { target: operation.target, cause }),
          ),
          Effect.forkScoped({ startImmediately: true }),
        )
      }
    })

    // 实现服务接口。
    return Service.of({
      // 列出当前操作并顺便建立直接监视。
      operations: Effect.fn("ConfigPluginSource.operations")(function* () {
        // 读取当前配置条目。
        const entries = yield* config.entries()
        // 扫描出全部操作。
        const operations = yield* scan(fs, location, entries)
        // 为配置声明的目标建立监视。
        yield* watchConfiguredSources(entries, operations)
        // 返回操作列表。
        return operations
      }),
      // 变更流：配置中插件目录的变化或被监视目标的变化。
      changes: () =>
        Stream.merge(
          // 配置变化：仅当路径落在插件目录来源之下才发出。
          config.changes().pipe(
            Stream.filterEffect((update) =>
              Effect.map(config.entries(), (entries) =>
                ConfigEntryObserver.isDirectorySource(entries, update.path, PluginSourceDirectory.names),
              ),
            ),
            Stream.map(() => undefined),
          ),
          // 配置声明目标的直接监视变化。
          Stream.fromPubSub(configuredChanges),
        ),
    })
  }),
)

// 位置服务节点：把服务层挂到 Location 依赖图。
export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Config.node, FSUtil.node, Watcher.node, Location.node],
})

// 空实现节点：无操作、永不变化（用于没有位置的场合）。
export const empty = makeLocationNode({
  service: Service,
  layer: Layer.succeed(
    Service,
    Service.of({
      // 空操作列表。
      operations: () => Effect.succeed([]),
      // 永不发出变化。
      changes: () => Stream.never,
    }),
  ),
  deps: [],
})

// 把插件配置项解析为操作：对象形式带选项；字符串以 - 开头表示移除。
function parse(input: ConfigPlugin.Plugin): Operation {
  // 对象形式：包名加选项。
  if (typeof input !== "string") {
    return { type: "add", target: input.package, options: input.options ?? {} }
  }
  // 普通字符串：新增。
  if (!input.startsWith("-")) return { type: "add", target: input, options: {} }
  // 只有 "-" 没有目标：非法。
  if (input.length === 1) throw new Error("Plugin remove operation requires a target")
  // "-目标"：移除操作。
  return { type: "remove", target: input.slice(1) }
}

// 扫描全部插件来源：目录自动发现加文档声明。
const scan = Effect.fn("ConfigPluginSource.scan")(function* (
  fs: FSUtil.Interface,
  location: Location.Interface,
  entries: readonly Entry[],
) {
  // 自动发现：各配置目录下插件目录里的包。
  const discovered = yield* Effect.forEach(
    entries.filter((entry): entry is Directory => entry.type === "directory"),
    (entry) =>
      PluginSourceDirectory.discover(fs, entry.path).pipe(
        // 发现结果转为新增操作。
        Effect.map((targets) => targets.map((target): Operation => ({ type: "add", target, options: {} }))),
      ),
  ).pipe(Effect.map((items) => items.flat()))
  // 配置声明：文档里的 plugins 列表逐项解析并解析相对路径。
  const configured = entries
    .filter((entry): entry is Document => entry.type === "document")
    .flatMap((entry) =>
      (entry.info.plugins ?? []).map(parse).map((operation) => {
        // 移除操作不需要路径解析。
        if (operation.type === "remove") return operation
        // 相对路径的基准目录：文档所在目录，缺省为当前工作目录。
        const directory = entry.path ? path.dirname(entry.path) : location.directory
        // 目标归一化：file:// 转路径；./ 与 ../ 相对基准目录解析；其余原样。
        const target = operation.target.startsWith("file://")
          ? fileURLToPath(operation.target)
          : operation.target.startsWith("./") || operation.target.startsWith("../")
            ? path.resolve(directory, operation.target)
            : operation.target
        // 返回带解析路径的操作。
        return { ...operation, target }
      }),
    )
  // 过滤配置声明的目标：文件形式的目标非法（必须是目录）。
  const resolved = yield* Effect.forEach(configured, (operation) =>
    Effect.gen(function* () {
      // 移除操作或相对路径直接保留。
      if (operation.type === "remove" || !path.isAbsolute(operation.target)) return Option.some(operation)
      // 目标是文件：记警告并剔除。
      if (yield* fs.isFile(operation.target)) {
        yield* Effect.logWarning("configured plugin path must be a directory", { target: operation.target })
        return Option.none<Operation>()
      }
      // 保留合法目标。
      return Option.some<Operation>(operation)
    }),
  ).pipe(Effect.map((operations) => operations.flatMap(Option.toArray)))
  // Explicit config is applied last so it can remove auto-discovered packages.
  // 显式配置放在自动发现之后应用，因此可以移除自动发现的包。
  return yield* Effect.forEach([...discovered, ...resolved], (operation) =>
    Effect.gen(function* () {
      // 移除操作或相对路径直接保留。
      if (operation.type === "remove" || !path.isAbsolute(operation.target)) return [operation]
      // 目标不存在则保留原样（由加载器报告错误）。
      if (!(yield* fs.existsSafe(operation.target))) return [operation]
      // 判断目标是目录还是文件。
      const directory = yield* fs.isDir(operation.target)
      // 解析入口点：目录走 Host 解析；文件直接作为 server 入口。
      const entrypoints: Host.Entrypoints = directory
        ? yield* Effect.sync(() => Host.resolve({ directory: operation.target }))
        : { server: pathToFileURL(operation.target).href }
      // A directory without a server part still lists for its GUI part. A TUI-only directory stays the TUI's own.
      // 没有 server 入口的目录仍会因 GUI 部分而列出；纯 TUI 目录留给 TUI 自己处理。
      const entrypoint = entrypoints.server ?? entrypoints.gui
      // 没有可用入口：跳过。
      if (!entrypoint) return []
      // 目录目标：server 入口必须位于目录之内，防止越界加载。
      if (directory) {
        // 目标根。
        const root = yield* fs.resolve(operation.target)
        // 入口真实路径。
        const resolved = yield* fs.resolve(fileURLToPath(entrypoint))
        // 入口不在根内：跳过。
        if (!FSUtil.contains(root, resolved)) return []
      }
      // 收集各入口与 package.json 的修改时间，用于失效判断。
      const times = yield* Effect.forEach(
        [
          // 所有入口文件。
          ...Object.values(entrypoints)
            .filter((entry) => entry !== undefined)
            .map((entry) => fileURLToPath(entry)),
          // 目录目标用自身，文件目标用所在目录的 package.json。
          path.join(directory ? operation.target : path.dirname(operation.target), "package.json"),
        ],
        (entry) =>
          fs.stat(entry).pipe(
            // 取修改时间（缺省用纪元 0）。
            Effect.map((info) => Option.getOrElse(info.mtime, () => new Date(0)).getTime()),
            // stat 失败按 0 处理。
            Effect.orElseSucceed(() => 0),
          ),
      )
      // 返回带最新修改时间的操作。
      return [{ ...operation, mtime: Math.max(...times) }]
    }),
  ).pipe(Effect.map((operations) => operations.flat()))
})
