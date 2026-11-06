// 以命名空间形式整体导出本模块
export * as FileSystemSearch from "./search.js"

// 导入 makeLocationNode：按位置构建图层节点的辅助函数
import { makeLocationNode } from "@opencode/util/effect/app-node"
// 导入 Node 的 path 模块（判断目录分隔符后缀）
import path from "path"
// 从 effect 库导入所需模块：Clock（时钟）、Context、Deferred（一次性 promises）、
// Duration、Effect、Layer、Scope
import { Clock, Context, Deferred, Duration, Effect, Layer, Scope } from "effect"
// 导入 Fff：按运行时选择的原生文件查找后端（bun/node/workerd）
import { Fff } from "#fff"
// 导入 fuzzysort：模糊匹配库（ripgrep 降级路径使用）
import fuzzysort from "fuzzysort"
// 导入 FileSystem schema：搜索输入与条目类型
import { FileSystem } from "@opencode/schema/filesystem"
// 导入内部依赖：位置、ripgrep 服务、相对路径 schema、受保护目录名单
import { Location } from "../location.js"
import { Ripgrep } from "../ripgrep.js"
import { RelativePath } from "../schema.js"
import { Protected } from "./protected.js"

// Interface：文件系统搜索服务的能力——按输入查找并列出条目
export interface Interface {
  readonly find: (input: FileSystem.FindInput) => Effect.Effect<FileSystem.Entry[]>
}

// Options：图层选项——fff 为 false 时强制使用 ripgrep 后端
export interface Options {
  readonly fff?: boolean
}

// 声明 FileSystemSearch 服务标签
export class Service extends Context.Service<Service, Interface>()("@opencode/FileSystem/Search") {}

// REFRESH_INTERVAL：索引两次全量扫描之间的最小间隔（10 秒）
const REFRESH_INTERVAL = Duration.toMillis("10 seconds")
// Prepared：fuzzysort 预处理后的可搜索条目类型
type Prepared = ReturnType<typeof fuzzysort.prepare>

// emptyIndex：构造空索引——文件与目录两张“相对路径 -> 预处理条目”的映射表
function emptyIndex() {
  return { files: new Map<string, Prepared>(), directories: new Map<string, Prepared>() }
}

// search：在给定索引上执行模糊搜索并映射为统一条目
function search(index: ReturnType<typeof emptyIndex>, input: FileSystem.FindInput) {
  // 依据请求类型挑选候选集：仅文件 / 仅目录 / 两者混合
  const items =
    input.type === "file"
      ? Array.from(index.files.values())
      : input.type === "directory"
        ? Array.from(index.directories.values())
        : [...index.files.values(), ...index.directories.values()]
  // 执行模糊匹配，limit 限制返回条数（默认 50）
  const result = fuzzysort.go(input.query, items, { limit: input.limit ?? 50 })
  // 原有注释：匹配目标由当前位置的索引持有；fuzzysort 仅剩的全局状态是它的查询缓存，
  // 不能让所有历史查询永久驻留，因此每次搜索后清理。
  // Targets are owned by the current location index. The only global fuzzysort
  // state left is its query cache, which must not retain every query forever.
  fuzzysort.cleanup()
  // 把匹配结果映射为 FileSystem.Entry：以路径分隔符结尾的视为目录
  return result.map((item) => {
    const relative = item.target
    const type = relative.endsWith(path.sep) ? ("directory" as const) : ("file" as const)
    return FileSystem.Entry.make({
      path: RelativePath.make(relative),
      type,
    })
  })
}

// ripgrepLayer：基于 ripgrep 扫描 + fuzzysort 匹配的降级搜索实现
const ripgrepLayer = Layer.effect(
  // 提供的服务标签
  Service,
  Effect.gen(function* () {
    // 取出依赖：位置与 ripgrep 服务
    const location = yield* Location.Service
    const ripgrep = yield* Ripgrep.Service
    // 取当前作用域与时钟（刷新调度与节流判断需要）
    const scope = yield* Scope.Scope
    const clock = yield* Clock.Clock
    // 当前位置是否就是用户主目录（主目录扫描需要排除大量系统目录）
    const home = Protected.isHome(location.directory)
    // 索引与状态标记
    let index = emptyIndex()
    let initialized = false
    let settledAt = Number.NEGATIVE_INFINITY
    let refreshing: Deferred.Deferred<void> | undefined
    // scan：执行一次全量扫描，重建索引
    const scan = Effect.gen(function* () {
      // 为本轮扫描准备新索引
      const next = emptyIndex()
      // 保留上一轮索引，用于复用已预处理条目
      const previous = index
      // 首次扫描：立即切换到新索引（后续条目继续填充），让等待者尽早拿到部分结果
      if (!initialized) index = next
      // 用 ripgrep 列出所有路径
      yield* ripgrep.find({
        cwd: location.directory,
        pattern: "*",
        // 有版本控制且非主目录时全量列出；否则上限 10 万条
        limit: location.vcs && !home ? Number.MAX_SAFE_INTEGER : 100_000,
        // 主目录场景按平台名单排除敏感子目录
        exclude: home ? [...Protected.names()].map((name) => `${name}/**`) : undefined,
        // 每发现一个条目就登记进新索引
        onEntry: (entry) =>
          Effect.sync(() => {
            // 文件条目：优先复用旧索引中已预处理的同一路径，避免重复 prepare
            next.files.set(entry.path, previous.files.get(entry.path) ?? fuzzysort.prepare(entry.path))
            // 同时把该路径的每一级父目录也登记为可搜索的目录条目
            const parts = entry.path.split("/")
            parts.slice(0, -1).forEach((_, offset) => {
              const directory = parts.slice(0, offset + 1).join("/") + path.sep
              if (!next.directories.has(directory))
                next.directories.set(directory, previous.directories.get(directory) ?? fuzzysort.prepare(directory))
            })
          }),
      })
      // 扫描完成后原子切换到新索引并标记已初始化
      index = next
      initialized = true
    }).pipe(Effect.orDie)
    // refresh：按需触发扫描——并发去重 + 10 秒节流；首次扫描会等待完成
    const refresh = Effect.suspend(() => {
      // 已有扫描在进行：已初始化则直接返回，否则等待该扫描结束
      if (refreshing) return initialized ? Effect.void : Deferred.await(refreshing)
      // 未到刷新间隔：跳过
      if (initialized && clock.currentTimeMillisUnsafe() < settledAt + REFRESH_INTERVAL) return Effect.void

      // 新建一个 Deferred 表示本轮扫描，登记为“进行中”
      const attempt = Deferred.makeUnsafe<void>()
      refreshing = attempt
      return scan.pipe(
        // 扫描结束时：记录落定时间、清空进行中标记、完成 Deferred
        Effect.onExit((exit) =>
          Effect.sync(() => {
            settledAt = clock.currentTimeMillisUnsafe()
            if (refreshing === attempt) refreshing = undefined
            Deferred.doneUnsafe(attempt, exit)
          }),
        ),
        // 后台运行扫描（挂到图层作用域）
        Effect.forkIn(scope),
        // 首次调用者必须等待扫描完成；后续调用者可立即用旧索引返回
        Effect.flatMap(() => (initialized ? Effect.void : Deferred.await(attempt))),
      )
    })
    // 返回服务实现：find 先确保索引新鲜，再执行搜索
    return Service.of({
      find: (input) =>
        Effect.gen(function* () {
          yield* refresh
          return search(index, input)
        }),
    })
  }),
)

// FFF_SCAN_WAIT：等待 fff 后台初始扫描的最长时间（3 秒），超时即用现有数据作答
const FFF_SCAN_WAIT = Duration.seconds(3)

// CreatePicker：fff 后端创建 Picker 的工厂签名
type CreatePicker = (options: Fff.Init) => Fff.Result<Fff.Picker>

// createPicker：包装 create 调用，把原生异常也归一为失败结果
function createPicker(
  create: CreatePicker,
  directory: string,
): { ok: true; value: Fff.Picker } | { ok: false; error: unknown } {
  try {
    return create({
      basePath: directory,
      aiMode: true,
      disableMmapCache: true,
      disableContentIndexing: true,
    })
  } catch (error) {
    return { ok: false, error }
  }
}

// 原有注释：每个 fff picker 自带 scanner、watcher 与 git 线程，因此推迟到首次搜索时才启动，
// 而不是在 Location 启动时创建。
// Each fff picker owns its own scanner, watcher and git threads, so it starts on the first search
// instead of when the Location boots.
export const makeFffLayer = (create: CreatePicker) =>
  Layer.effect(
    // 提供的服务标签
    Service,
    Effect.gen(function* () {
      // 取出当前位置
      const location = yield* Location.Service
      // 惰性持有的 picker 状态：尚未创建为 undefined；已关闭为 "closed"
      let state: { readonly result: ReturnType<typeof createPicker>; scanned: boolean } | "closed" | undefined
      // 原有注释：图层在 picker 真正存在前就拥有它——创建与登记是一个同步、不可中断的步骤，
      // 这样被中断的搜索不会遗留一个没有终结器负责的原生 picker。
      // The layer owns the picker before it exists: creating and publishing it is one synchronous,
      // uninterruptible step, so an interrupted search can't leave a native picker without this finalizer.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          // 图层关闭时销毁尚存活的 picker，并标记为已关闭
          if (typeof state === "object" && state.result.ok) state.result.value.destroy()
          state = "closed"
        }),
      )
      // acquire：不可中断地获取（或首次创建）picker
      const acquire = Effect.uninterruptible(
        Effect.sync(() => {
          // 已存在（或已关闭）：直接复用
          if (state !== undefined) return { current: state, created: false }
          // 首次调用：同步创建并登记
          state = { result: createPicker(create, location.directory), scanned: false }
          return { current: state, created: true }
        }),
      )
      // picker：解析出可用的 Picker 实例，失败/关闭时返回 undefined
      const picker = Effect.gen(function* () {
        // 获取状态
        const { current, created } = yield* acquire
        // 图层已关闭：不再可用
        if (current === "closed") return undefined
        // 创建失败：仅在本调用触发创建时记录一次警告
        if (!current.result.ok) {
          if (created) yield* Effect.logWarning("failed to initialize fff", { error: current.result.error })
          return undefined
        }
        // 首次使用：等待后台初始扫描结束（最多 3 秒），之后不再等待
        if (!current.scanned) {
          const value = current.result.value
          yield* Effect.gen(function* () {
            while (value.isScanning()) yield* Effect.sleep("20 millis")
          }).pipe(Effect.timeoutOption(FFF_SCAN_WAIT))
          current.scanned = true
        }
        // 返回可用的 picker
        return current.result.value
      })
      // 返回服务实现
      return Service.of({
        find: (input) =>
          Effect.gen(function* () {
            // 获取 picker；不可用则返回空结果
            const finder = yield* picker
            if (!finder) return []
            // 分页参数：从第一页开始，条数取 limit（默认 50）
            const options = { pageIndex: 0, pageSize: input.limit ?? 50 }
            // 按请求类型调用对应搜索；结果统一为带分数的候选列表
            const items = (() => {
              // 文件搜索
              if (input.type === "file") {
                const found = finder.fileSearch(input.query.trim(), options)
                if (!found.ok) throw found.error
                return found.value.items.map((item, index) => ({
                  path: item.relativePath,
                  type: "file" as const,
                  score: found.value.scores[index]?.total ?? 0,
                }))
              }
              // 目录搜索
              if (input.type === "directory") {
                const found = finder.directorySearch(input.query.trim(), options)
                if (!found.ok) throw found.error
                return found.value.items.map((item, index) => ({
                  path: item.relativePath,
                  type: "directory" as const,
                  score: found.value.scores[index]?.total ?? 0,
                }))
              }
              // 混合搜索（文件 + 目录）
              const found = finder.mixedSearch(input.query.trim(), options)
              if (!found.ok) throw found.error
              return found.value.items.map((item, index) => ({
                path: item.item.relativePath,
                type: item.type,
                score: found.value.scores[index]?.total ?? 0,
              }))
            })()
            // 按分数降序排序，同分时短路径优先；目录补上分隔符后缀
            return items
              .sort((a, b) => b.score - a.score || a.path.length - b.path.length)
              .map((item) => {
                // 统一路径分隔符并去掉尾部分隔符
                const relative = item.path.replaceAll("\\", "/").replace(/\/$/, "")
                return FileSystem.Entry.make({
                  path: RelativePath.make(relative + (item.type === "directory" ? path.sep : "")),
                  type: item.type,
                })
              })
          }),
      })
    }),
  )

// fffLayer：用真实的 fff 后端（按运行时选择）构建的图层
export const fffLayer = makeFffLayer(Fff.create)

// layer：按位置与配置在 fff 与 ripgrep 两个后端之间做选择
const layer = (options?: Options) =>
  Layer.unwrap(
    Effect.gen(function* () {
      // 读取当前位置
      const location = yield* Location.Service
      // 原有注释：由工作区支撑的位置运行在远程沙箱中；fff 若在本地进程内索引服务器目录会给出错误结果。
      // ripgrep 路径则经由 Location 的环境派生器执行，天然路由到正确一侧。
      // Workspace-backed Locations resolve in a remote sandbox; fff would index the local server directory
      // in-process and serve wrong results. Ripgrep routes through the Location environment spawner.
      if (location.workspaceID) return ripgrepLayer
      // 显式禁用 fff、或（未配置且在 Windows 上）、或原生后端不可用：使用 ripgrep
      if (options?.fff === false || (options?.fff === undefined && process.platform === "win32") || !Fff.available())
        return ripgrepLayer
      // 原有注释：无版本控制的位置可能包含大量仓库，避免急切地对整个聚合树做内容索引。
      // Non-VCS locations can contain many repositories, so avoid eagerly content-indexing the entire aggregate tree.
      return location.vcs && !Protected.isHome(location.directory) ? fffLayer : ripgrepLayer
    }),
  )

// configured：构建搜索服务的位置节点（依赖位置与 ripgrep）
export function configured(options?: Options) {
  return makeLocationNode({ service: Service, layer: layer(options), deps: [Location.node, Ripgrep.node] })
}

// 导出默认配置的节点实例
export const node = configured()
