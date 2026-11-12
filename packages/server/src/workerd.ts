// 以 ServerWorkerd 命名空间 re-export 本模块
export * as ServerWorkerd from "./workerd"

// 引入 Effect 与 Layer（依赖注入层）
import { Effect, Layer } from "effect"
// 引入配置插件源模块（插件发现方式）
import { ConfigPluginSource } from "@opencode/core/config/plugin/source"
// 引入数据库模块
import { Database } from "@opencode/core/database/database"
// 引入 workerd 专用的 SQLite 层实现
import { sqliteLayer } from "@opencode/core/database/sqlite.workerd"
// 引入 DurableObjectStorage 类型（仅类型导入）
import type { DurableObjectStorage } from "@opencode/core/database/sqlite.workerd"
// 引入"环境不可用"错误层
import { EnvironmentUnavailable } from "@opencode/core/environment/unavailable"
// 引入文件系统服务
import { FileSystem } from "@opencode/core/filesystem"
// 引入文件系统搜索服务
import { FileSystemSearch } from "@opencode/core/filesystem/search"
// 引入 PTY（伪终端）服务
import { Pty } from "@opencode/core/pty"
// 引入快照（Snapshot）服务
import { Snapshot } from "@opencode/core/snapshot"
// 引入版本控制（VCS）服务
import { Vcs } from "@opencode/core/vcs"
// 引入跨平台进程启动器
import { CrossSpawnSpawner } from "@opencode/util/cross-spawn-spawner"
// 引入 LayerNode 类型（层的替换图定义）
import type { LayerNode } from "@opencode/util/effect/layer-node"
// 引入 npm 包安装服务
import { Npm } from "@opencode/util/npm"
// 引入服务端 fetch 入口构建器
import { ServerFetch } from "./fetch"
// 引入服务器选项类型（仅类型导入）
import type { ServerOptions } from "./options"

// workerd 运行时配置：在 Cloudflare Durable Object 内启动 opencode 核心与服务器，
// 所有刻意依赖本地环境的服务都被替换或禁用。
// - 数据库运行在注入的 `DurableObjectStorage` SQLite 之上。
// - 通过既有选项关闭 watcher 与 fff；pty、fff 与 photon 原生模块在 `workerd`
//   bundle 条件下解析为惰性占位（stub）。
// - 裸 Location 使用不执行进程的类型化启动器；FileSystem、FileSystemSearch 与 Pty
//   在远程沙箱接入前以明确的缺陷（defect）失败；Npm 以类型化的 workerd 错误终止
//   包安装；Snapshot 与 Vcs 退化为空操作。
// - 配置以字符串注入（无文件系统）；插件发现仅限预编译，stdio MCP 与 Shell 一样
//   报告"无执行平面"错误。
// - 需以 `workerd` 条件打包（见下方英文说明）。
/**
 * The workerd runtime profile: boots opencode core and server inside a
 * Cloudflare Durable Object, with every intentionally-local service replaced
 * or disabled.
 *
 * - Database runs on the injected `DurableObjectStorage` SQLite.
 * - Watcher and fff are disabled through their existing option flags; pty, fff,
 *   and photon native modules resolve to inert stubs under the `workerd` bundle
 *   condition.
 * - Bare locations use a typed no-execution-plane process spawner; FileSystem,
 *   FileSystemSearch, and Pty fail with a clear defect until a remote sandbox
 *   backs them; Npm fails package installs with a typed workerd error; Snapshot
 *   and Vcs degrade to no-op results.
 * - Config is injected as a string (no filesystem); plugin discovery is
 *   precompiled-only, and stdio MCP reports the same no-plane failure as Shell.
 *
 * Bundle with the `workerd` condition, e.g.
 * `bun build src/workerd.ts --conditions=workerd --target=node`
 * (see `script/workerd-probe.ts`).
 */
// workerd 运行时的启动选项
export interface Options {
  // 其 SQLite 数据库作为 opencode 数据库后端的 Durable Object 存储
  /** Durable Object storage whose SQLite database backs the opencode database. */
  readonly storage: DurableObjectStorage
  // 应用信息块（透传给 ServerOptions.app）
  readonly app?: ServerOptions["app"]
  // 访问密码
  readonly password?: string
  // 内联 opencode 配置内容（JSON）
  /** Inline opencode config content (JSON), same as `ServerOptions.config.content`. */
  readonly config?: { readonly content?: string }
  // models.dev 目录选项；无论哪种情况，打包内置的快照都是启动时的最低保证
  /** models.dev catalog options; the bundled snapshot is the boot-time floor either way. */
  readonly models?: ServerOptions["models"]
  // 替换 OpenCode 自身 HTTP 请求所用的 fetch，例如经由 Service Binding 路由
  /** Replaces `globalThis.fetch` for OpenCode's own HTTP requests, e.g. to route them through a Service Binding. */
  readonly fetch?: ServerOptions["fetch"]
}

// 为 Durable Object 的 `fetch()` 构建 Web 标准 fetch 处理器。应用层会在调用方
// 作用域内急切构建，因此把它保存在 Durable Object 实例上而不是每个请求重建。
/**
 * Builds the web-standard fetch handler for a Durable Object's `fetch()`. The
 * application layer builds eagerly in the caller's scope, so hold it in the
 * Durable Object instance rather than per request.
 */
// 创建 workerd 环境下的服务器 fetch 处理器
export function create(options: Options) {
  // 驱逐（eviction）可能在某个轮次的 Started 与终态事件之间直接杀死 isolate，且没有任何
  // 清理流程。先写入的执行声明（claim）加上 ServerFetch.make 启动时的恢复逻辑，会在下次
  // 唤醒时从持久化历史重放 drain，从而回收这些孤儿轮次。
  // Eviction can kill the isolate between a turn's Started and terminal events with no
  // teardown. The write-ahead execution claim plus ServerFetch.make's boot-time resume
  // recovers such orphaned turns by replaying the drain from durable history on the next wake.
  return ServerFetch.make(serverOptions(options), { overrides: replacements(options) })
}

// 把 workerd 选项映射为标准 ServerOptions（禁用一切依赖本地环境的能力）
export function serverOptions(options: Options): ServerOptions {
  return {
    // 透传应用信息
    app: options.app,
    // 透传访问密码
    password: options.password,
    // 禁用文件监视器与 fff：workerd 没有本地文件系统事件
    fs: { filewatcher: false, fff: false },
    // 持久化事件历史是回收"被驱逐孤儿轮次"的手段：启动时的恢复逻辑依赖它重放。
    // 没有清理流程的运行时不能选择退出，因此这里不作为选项暴露。
    // Durable event history is how a turn orphaned by eviction is recovered:
    // the boot-time resume replays it. A runtime that dies without teardown
    // cannot opt out of it, so this is not exposed as an option.
    // 强制开启事件持久化
    events: { persist: true },
    // 透传内联配置内容
    config: { content: options.config?.content },
    // 透传模型目录选项
    models: options.models,
    // 透传自定义 fetch
    fetch: options.fetch,
  }
}

// workerd 的替换图（replacements），在标准服务器替换之后追加应用
/** The workerd replacement graph, applied after the standard server replacements. */
// 返回 workerd 环境的层替换列表：把本地依赖换成 workerd 兼容实现
export function replacements(options: Options): LayerNode.Replacements {
  return [
    // 数据库：改用 DurableObjectStorage 之上的 SQLite 客户端
    Database.node.replace(Database.configuredClient(sqliteLayer({ storage: options.storage }))),
    // 进程启动器：替换为"环境不可用"失败层
    CrossSpawnSpawner.node.replace(EnvironmentUnavailable.layer),
    // 快照：替换为空操作层
    Snapshot.node.replace(Snapshot.noopLayer),
    // VCS：替换为降级实现层
    Vcs.node.replace(vcsLayer),
    // 文件系统：替换为不可用实现层
    FileSystem.node.replace(fileSystemLayer),
    // 文件系统搜索：替换为不可用实现层
    FileSystemSearch.node.replace(fileSystemSearchLayer),
    // PTY：替换为不可用实现层
    Pty.node.replace(ptyLayer),
    // npm：替换为不可用实现层
    Npm.node.replace(npmLayer),
    // 仅限预编译（内部与 SDK）插件：不做插件目录扫描、npm 安装或从磁盘导入插件代码。
    // Precompiled (internal and SDK) plugins only: no plugin-directory scan, npm
    // install, or import of plugin code from disk.
    // 插件来源：替换为空集（禁用磁盘插件发现）
    ConfigPluginSource.node.replace(ConfigPluginSource.empty),
  ]
}

// 构造一个缺陷（defect，不可恢复错误）：指定能力在 workerd 环境不可用（模板字符串内部不可插入注释）
const unavailable = (what: string) => Effect.die(new Error(`${what} is unavailable in the workerd profile`))

// 构造一个类型化的 npm 安装失败：指定能力在 workerd 环境不可用
const npmUnavailable = (what: string, pkg: string) =>
  // 以 InstallFailedError 失败，附带待安装的包
  Effect.fail(
    new Npm.InstallFailedError({
      // 待安装的包列表
      add: [pkg],
      // 目标目录为空（不会真正执行安装）
      dir: "",
      // 原始错误信息（模板字符串内部不可插入注释）
      cause: new Error(`${what} is unavailable in the workerd profile`),
    }),
  )

// npm 服务的 workerd 替代实现：安装/更新直接失败，其余返回空结果
const npmLayer = Layer.succeed(
  Npm.Service,
  Npm.Service.of({
    // 安装包：直接失败
    add: (pkg) => npmUnavailable("Npm.add", pkg),
    // 解析包：返回空目录与原名（不触网）
    resolve: (name) => Effect.succeed({ directory: "", name }),
    // 检查更新：恒返回 false
    check: () => Effect.succeed(false),
    // 更新包：直接失败
    update: (pkg) => npmUnavailable("Npm.update", pkg),
    // 查找可执行文件：返回 undefined
    which: () => Effect.undefined,
  }),
)

// Vcs 降级为空结果，与"Location 没有受支持的 VCS"时的行为一致，
// 因此只读客户端无需为该运行时做特殊处理。
// Vcs degrades to empty results, matching its behavior for locations without a
// supported VCS, so read-only clients never need to special-case this runtime.
// VCS 服务的 workerd 替代实现：一切查询返回空值
const vcsLayer = Layer.succeed(
  Vcs.Service,
  Vcs.Service.of({
    // 基线提交：无
    base: () => Effect.succeed(null),
    // 初始化：报告不支持
    initialize: () => Effect.fail(new Vcs.InitializeError({ kind: "unsupported" })),
    // 变换：返回可释放的空操作
    transform: () => Effect.succeed({ dispose: Effect.void }),
    // 重新加载：空操作
    reload: () => Effect.void,
    // 仓库信息：空分支信息
    info: () => Effect.succeed({ branch: {} }),
    // 分支列表：空
    branches: () => Effect.succeed([]),
    // 状态列表：空
    status: () => Effect.succeed([]),
    // 差异列表：空
    diff: () => Effect.succeed([]),
  }),
)

// Location 范围的文件系统在远程沙箱接入前没有本地工作树可服务。
// The Location-scoped filesystem has no local worktree to serve until a remote
// sandbox backs it.
// 文件系统服务的 workerd 替代实现：所有操作均不可用
const fileSystemLayer = Layer.succeed(
  FileSystem.Service,
  FileSystem.Service.of({
    // 读取：不可用
    read: () => unavailable("FileSystem.read"),
    // 列举：不可用
    list: () => unavailable("FileSystem.list"),
    // 查找：不可用
    find: () => unavailable("FileSystem.find"),
    // 写入：不可用
    write: () => unavailable("FileSystem.write"),
  }),
)

// 文件系统搜索服务的 workerd 替代实现：查找不可用
const fileSystemSearchLayer = Layer.succeed(
  FileSystemSearch.Service,
  FileSystemSearch.Service.of({
    // 查找：不可用
    find: () => unavailable("FileSystemSearch.find"),
  }),
)

// PTY 服务的 workerd 替代实现：列表为空，其余操作报"未找到"或不可用
const ptyLayer = Layer.succeed(
  Pty.Service,
  Pty.Service.of({
    // 列出 PTY：空列表
    list: () => Effect.succeed([]),
    // 获取：报未找到
    get: (ptyID) => Effect.fail(new Pty.NotFoundError({ ptyID })),
    // 创建：不可用（以缺陷表示环境能力缺失）
    create: () => unavailable("Pty.create"),
    // 更新：报未找到
    update: (ptyID) => Effect.fail(new Pty.NotFoundError({ ptyID })),
    // 删除：报未找到
    remove: (ptyID) => Effect.fail(new Pty.NotFoundError({ ptyID })),
    // 写入：报未找到
    write: (ptyID) => Effect.fail(new Pty.NotFoundError({ ptyID })),
    // 附加会话：报未找到
    attach: (ptyID) => Effect.fail(new Pty.NotFoundError({ ptyID })),
  }),
)
