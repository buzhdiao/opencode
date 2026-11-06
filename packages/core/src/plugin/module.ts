// 以命名空间形式整体再导出本模块
export * as PluginModule from "./module.js"

// Plugin：插件类型
import type { Plugin } from "@opencode/plugin/effect/plugin"
// Host：插件宿主（加载入口、包 ID 等能力）
import { Host } from "@opencode/plugin/host"
// GuiBundle/Source：GUI 打包项与插件来源类型
import { GuiBundle, type Source } from "@opencode/schema/plugin"
// createPluginSources：创建插件源（读取/加载入口的抽象）
import { createPluginSources } from "@opencode/plugin/source"
// Hash：哈希工具
import { Hash } from "@opencode/util/hash"
// Npm：npm 安装/解析服务
import { Npm } from "@opencode/util/npm"
// Effect 生态：延迟值、效果、纤维集合、发布订阅、Schema、流
import { Deferred, Effect, FiberSet, PubSub, Schema, Stream } from "effect"
// path：Node 路径处理
import path from "path"
// readFile/stat：Node 文件读取与状态查询
import { readFile, stat } from "node:fs/promises"
// fileURLToPath/pathToFileURL：文件 URL 与路径互转
import { fileURLToPath, pathToFileURL } from "url"
// ConfigPluginSource：配置中插件来源操作类型
import type { ConfigPluginSource } from "../config/plugin/source.js"
// Generation：插件注册后的最终形态
import type { Generation } from "../plugin.js"
// PluginPromise：Promise 风格插件适配器
import { PluginPromise } from "./promise.js"
// Config：配置服务
import { Config } from "../config.js"
// ManagedPolicy：托管策略（受管理策略）判定
import { ManagedPolicy } from "../managed-policy.js"
// Watcher：文件系统监听服务
import { Watcher } from "../filesystem/watcher.js"

// make：构建插件模块服务（加载、监听变更）
export const make = Effect.fn("PluginModule.make")(function* () {
  // 获取配置服务
  const config = yield* Config.Service
  // 获取文件监听服务
  const watcher = yield* Watcher.Service
  // 获取当前作用域（Scope），用于托管后台资源
  const scope = yield* Effect.scope
  // 构建运行时 Promise 执行器（在正确上下文中运行 Effect）
  const runPromise = yield* FiberSet.makeRuntimePromise()
  // 无界发布订阅通道：向调用方广播插件文件变更
  const changes = yield* PubSub.unbounded<void>()
  // 已监听文件集合，避免重复订阅
  const watched = new Set<string>()
  // watch：订阅单个插件文件（或其最近存在祖先）的变更
  const watch = Effect.fn("PluginModule.watch")(function* (file: string) {
    // 已监听过则直接返回
    if (watched.has(file)) return
    // 标记为已监听
    watched.add(file)
    // 创建延迟值：监听就绪信号
    const ready = yield* Deferred.make<void>()
    // 解析实际监听目标（文件不存在则退到最近存在的祖先目录）
    const target = yield* Effect.promise(() => watchTarget(file))
    // 订阅目标变更，并把"就绪"信号传给监听器
    const updates = yield* watcher.subscribe(target, Deferred.succeed(ready, undefined))
    // 每次变更发布到 changes 通道
    yield* updates.pipe(
      // 每条更新发布一次
      Stream.runForEach(() => PubSub.publish(changes, undefined)),
      // 无论成功失败都补发就绪信号，保证等待方不悬挂
      Effect.ensuring(Deferred.succeed(ready, undefined)),
      // 在当前作用域内派生后台纤维并立即启动
      Effect.forkIn(scope, { startImmediately: true }),
    )
    // 等待监听真正就绪后再返回
    yield* Deferred.await(ready)
  })
  // 获取插件源对象；释放时调用其 dispose 清理
  const sources = yield* Effect.acquireRelease(
    // 创建插件源，文件回调触发监听
    Effect.sync(() => createPluginSources((file) => runPromise(watch(file)))),
    // 释放时同步清理
    (sources) => Effect.sync(() => sources.dispose()),
  )
  // 返回服务接口
  return {
    // load：加载一个"添加插件"操作
    load: (
      // 操作描述（含目标包/路径与选项）
      operation: Extract<ConfigPluginSource.Operation, { type: "add" }>,
      // 可选参数：是否允许安装
      options?: { readonly install?: boolean },
    ) =>
      // Effect.gen 组织逻辑
      Effect.gen(function* () {
        // 查找包名中最后一个 @ 的位置（用于拆分版本号）
        const version = operation.target.lastIndexOf("@")
        // 绝对路径或无版本号时保持原样；否则截去 @version 部分
        const target =
          // 判断是否绝对路径或不存在版本分隔
          path.isAbsolute(operation.target) || version <= 0 ? operation.target : operation.target.slice(0, version)
        // 托管策略禁止使用该插件时返回 blocked
        if (ManagedPolicy.decision(ManagedPolicy.statements(yield* config.entries()), "plugin.use", target) === "deny")
          // 阻止加载
          return { blocked: true as const }
        // 否则交给内部 load 完成真正加载
        return yield* load(operation, sources, watch, options)
      }),
    // changes：暴露变更流（Stream）供调用方订阅
    changes: () => Stream.fromPubSub(changes),
  }
})

// A local plugin's directory (or legacy standalone file), where clients resolve its other parts.
// 本地插件的目录（或旧式独立文件），客户端据此解析插件的其他部分（TUI/GUI）。
export function source(target: string, version?: string): Source {
  // 绝对路径视为本地插件来源
  if (path.isAbsolute(target)) return { type: "local", path: target }
  // 否则视为 npm 包来源，可选带版本
  return { type: "package", target, ...(version ? { version } : {}) }
}

// A missing dependency may have missing parents too. Watch the nearest existing
// ancestor recursively so creating the rest of the path can trigger recovery.
// 目标可能不存在，父目录也可能缺失；递归向上找最近存在的祖先来监听，
// 这样后续创建路径的其余部分也能触发恢复。
function watchTarget(file: string): Promise<Watcher.WatchInput> {
  // 先 stat 目标
  return stat(file).then(
    // 存在：按类型返回监听输入
    (info) => ({ path: file, type: info.isDirectory() ? "directory" : "file" }),
    // 不存在：若已是根目录则抛错，否则递归向上找父目录
    (cause) => {
      // 目录名为自身说明到达根，无法再向上
      if (path.dirname(file) === file) throw cause
      // 递归处理父目录
      return watchTarget(path.dirname(file))
    },
  )
}

// GUI 打包项的字段定义（用于校验插件传给 GUI 的选项）
const GuiOptions = GuiBundle.fields.options

// Module：插件入口模块的运行时结构校验（default 导出两种形态之一）
const Module = Schema.Struct({
  // default 导出
  default: Schema.Union([
    // 形态一：id + effect 函数（Effect 风格插件）
    Schema.Struct({
      // 字符串 ID
      id: Schema.String,
      // effect 必须是函数（自定义声明校验）
      effect: Schema.declare<Plugin["effect"]>((input): input is Plugin["effect"] => typeof input === "function"),
    }),
    // 形态二：id + setup 函数（Promise 风格插件）
    Schema.Struct({
      // 字符串 ID
      id: Schema.String,
      // setup 必须是函数（自定义声明校验）
      setup: Schema.declare<Parameters<typeof PluginPromise.fromPromise>[0]["setup"]>(
        // 类型守卫：判断是否为函数
        (input): input is Parameters<typeof PluginPromise.fromPromise>[0]["setup"] => typeof input === "function",
      ),
    }),
  ]),
})

// LoadError：插件加载失败的带标签错误
export class LoadError extends Schema.TaggedError<LoadError>()("PluginModule.LoadError", {
  // 错误信息
  message: Schema.String,
  // 可选的原始原因（缺陷）
  cause: Schema.optional(Schema.Defect()),
}) {}

// load：加载插件的核心实现（服务端/GUI 部分解析、安装、监听）
const load = Effect.fn("PluginModule.load")(function* (
  // "添加插件"操作
  operation: Extract<ConfigPluginSource.Operation, { type: "add" }>,
  // 插件源集合
  sources: ReturnType<typeof createPluginSources>,
  // 文件监听函数
  watch: (file: string) => Effect.Effect<void>,
  // 可选安装参数
  options?: { readonly install?: boolean },
) {
  // 是否本地插件（绝对路径）
  const local = path.isAbsolute(operation.target)
  // 获取 npm 服务
  const npm = yield* Npm.Service
  // 解析安装：本地无需；install=false 只解析不安装；否则安装
  const installed = local
    // 本地插件不做 npm 处理
    ? undefined
    // 仅解析已存在的包
    : options?.install === false
      // 解析目标包
      ? yield* npm.resolve(operation.target)
      // 安装目标包
      : yield* npm.add(operation.target)
  // Legacy auto-discovery still admits standalone server sources. Configured
  // local plugins always arrive here as directories.
  // 旧式自动发现仍允许独立的服务端文件；配置声明的本地插件到这里一定是目录。
  const entrypoints: Host.Entrypoints =
    // 本地且目标是文件：把它作为服务端入口
    local && (yield* Effect.promise(() => stat(operation.target))).isFile()
      // 以文件 URL 形式给出服务端入口
      ? { server: pathToFileURL(operation.target).href }
      // 否则按目录解析各端（server/tui/gui/rpc）
      : yield* Effect.sync(() => Host.resolve(installed ?? { directory: operation.target }))
  // 取服务端入口
  const entrypoint = entrypoints.server
  // A TUI-only package is not the server's to list; the TUI loads it from its own config.
  // 仅含 TUI 的包不由服务端列出；TUI 从自己的配置加载。
  const found = entrypoint || entrypoints.gui
  // 非本地的"仅解析"模式下找不到入口：返回 pending（可能稍后出现）
  if (!local && options?.install === false && !found) return { pending: true as const }
  // 完全找不到入口：抛出加载错误
  if (!found) return yield* new LoadError({ message: `Plugin entrypoint not found: ${operation.target}` })
  // 记录加载日志
  yield* Effect.log({ msg: "loading plugin", id: operation.target, entrypoint: found })
  // A package with only a GUI part (and maybe a TUI part) has nothing to run here: its id is its package name, and its
  // other parts load from this listing.
  // 仅含 GUI（或还有 TUI）的包在服务端无事可做：以包名为 id，其余部分由该列表承载。
  const server = entrypoint
    // 有服务端入口则加载之（本地插件用 sources 读取以便监听）
    ? yield* loadServer(entrypoint, local ? sources : undefined, installed?.revision)
    // 无则 undefined
    : undefined
  // 服务端插件；没有时构造一个空效果占位插件，id 取包名
  const plugin = server?.plugin ?? {
    // 用包 ID 作为插件 ID
    id: Host.packageID(installed ?? { directory: operation.target }),
    // 空实现：激活时什么都不做
    effect: () => Effect.void,
  }
  // 版本号（revision）：由操作与（服务端版本或安装版本）序列化而成
  const revision = JSON.stringify([operation, server ? server.version : installed?.revision])
  // A local plugin's `./gui-experimental` bundle is outside the server entry's import graph: watch it, and let its
  // content change the GUI's revision, so an edit reloads the GUI like a server or TUI edit reloads theirs. A package's
  // bundle changes only with its installed version. The GUI's revision is a hash: windows receive it, and the operation
  // holds the options.
  // 本地插件的 ./gui-experimental 打包不在服务端入口的依赖图内：监听它，让内容变化改变 GUI revision，
  // 编辑 GUI 会像服务端/TUI 一样触发重载；包的 GUI 只随安装版本变化。GUI revision 是哈希值。
  const gui = local && entrypoints.gui ? fileURLToPath(entrypoints.gui) : undefined
  // 存在本地 GUI 入口则监听其文件
  if (gui) yield* watch(gui)
  // 读取 GUI 打包内容并计算哈希（无 GUI 则 undefined）
  const bundle = gui ? Hash.sha256(yield* Effect.promise(() => readFile(gui))) : undefined
  // The GUI receives the same options as the server entry; they cross to the app, so they must be JSON.
  // GUI 接收与服务端入口相同的选项；选项要跨进程传给应用，因此必须是 JSON 可序列化的。
  const guiOptions = entrypoints.gui
    // 校验选项为 JSON 兼容结构
    ? yield* Schema.decodeUnknownEffect(GuiOptions)(operation.options).pipe(
        // 校验失败转为加载错误
        Effect.mapError(
          (cause) => new LoadError({ message: "Plugin options must be JSON to reach its ./gui-experimental", cause }),
        ),
      )
    // 无 GUI 时为空对象
    : {}
  // 返回插件生成（Generation）记录
  return {
    // 插件 ID
    id: plugin.id,
    // 各端能力标志
    features: {
      // 有服务端入口则标记 server
      ...(entrypoint ? { server: true as const } : {}),
      // 有 TUI 入口则标记 tui
      ...(entrypoints.tui ? { tui: true as const } : {}),
      // 有 rpc 入口则标记 rpc
      ...(entrypoint && entrypoints.rpc ? { rpc: true as const } : {}),
      // 有 GUI 入口则标记 gui
      ...(entrypoints.gui ? { gui: true as const } : {}),
    },
    // GUI 部分信息（文件、revision 哈希、选项）
    gui: entrypoints.gui
      // 组合整体 revision 与 bundle 哈希作为 GUI revision
      ? { file: entrypoints.gui, revision: Hash.sha256(JSON.stringify([revision, bundle])), options: guiOptions }
      // 无 GUI 则 undefined
      : undefined,
    // 版本号
    revision,
    // 插件来源描述
    source: source(operation.target, installed?.version),
    // 激活效果：把操作选项注入宿主上下文
    effect: (host) => plugin.effect({ ...host, options: operation.options }),
    // 满足 Generation 类型
  } satisfies Generation
})

// loadServer：加载并校验服务端入口模块
const loadServer = Effect.fn("PluginModule.loadServer")(function* (
  // 入口（文件 URL 或路径）
  entrypoint: string,
  // 插件源集合（本地插件传入，用于监听其依赖文件）
  sources: ReturnType<typeof createPluginSources> | undefined,
  // 无 sources 时的版本回退值
  revision: string | undefined,
) {
  // 读取模块：优先用 sources（可监听依赖），否则直接 Host.load
  const loaded = yield* Effect.promise(() =>
    // 有 sources 时读取入口并附带版本
    sources ? sources.read(entrypoint) : Host.load(entrypoint).then((module) => ({ module, version: revision })),
  )
  // 校验模块结构并取 default 导出；失败抛出说明性错误
  const value = (yield* Schema.decodeUnknownEffect(Module)(loaded.module).pipe(
    // 校验失败映射为加载错误
    Effect.mapError(
      (cause) =>
        new LoadError({
          message: "Plugin must export a default definition with an id and an effect or setup function.",
          cause,
        }),
    ),
    // 取出 default 字段
  )).default
  // effect 形态直接返回；setup 形态经适配器包装；附带版本号
  return { plugin: "effect" in value ? value : PluginPromise.fromPromise(value), version: loaded.version }
})
