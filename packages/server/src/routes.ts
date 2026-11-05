// =====================================================================
// 文件角色：server 路由装配层 —— 把 effect 的 HttpApi（OpenAPI 驱动）与
// 全部应用服务接在一起。createRoutes（独立 server，带密码鉴权）与
// createEmbeddedRoutes（嵌入式，如桌面/TUI 内嵌，无密码）共用 makeRoutes。
// 核心：applicationServiceNodes 列出全部业务服务 Node → AppNodeBuilder
// 构建依赖图 → HttpApiBuilder.layer(Api) 挂载 handlers 与中间件。
// =====================================================================
// 以下导入按组排列：核心服务节点、HTTP 基建、中间件与配置。
import { Database } from "@opencode/core/database/database"
// v1 → v2 数据库迁移层（与 API 一起挂载）。
import { V1Migration } from "@opencode/core/database/v1-migration"
import { App } from "@opencode/core/app"
// LayerNode：可替换（replace）的 Layer 节点；Node：服务节点基类。
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Node } from "@opencode/util/effect/app-node"
// HTTP 客户端与 fetch 层。
import { fetchLayer, httpClient, httpFetch } from "@opencode/util/effect/app-node-platform"
// 依赖图构建器。
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
// 事件总线与事件日志。
import { Bus } from "@opencode/core/bus"
import { EventLogger } from "@opencode/core/event-logger"
// 文件系统搜索（fff）。
import { FileSystemSearch } from "@opencode/core/filesystem/search"
// 凭据存储。
import { Credential } from "@opencode/core/credential"
// 配置系统。
import { Config } from "@opencode/core/config"
// 已保存的权限规则。
import { PermissionSaved } from "@opencode/core/permission/saved"
// PTY 票据与持久 PTY。
import { PtyTicket } from "@opencode/core/pty/ticket"
import { PersistentPty } from "@opencode/core/persistent-pty"
// 项目/工作树/会话三大领域服务。
import { Project } from "@opencode/core/project"
import { Worktree } from "@opencode/core/worktree"
import { Session } from "@opencode/core/session"
// 实例（Location）服务与相关。
import { Instance } from "@opencode/core/instance/service"
import { SessionTransfer } from "@opencode/core/session/transfer"
import { InstructionEntry } from "@opencode/core/session/instruction-entry"
// shell 选择。
import { ShellSelect } from "@opencode/core/shell/select"
// 作业系统与 KV 存储。
import { Job } from "@opencode/core/job"
import { KV } from "@opencode/core/kv"
// MCP 客户端。
import { Mcp } from "@opencode/core/mcp/index"
// 全局状态与文件工具。
import { Global } from "@opencode/util/global"
import { FSUtil } from "@opencode/util/fs-util"
// 指令发现（AGENTS.md 等）。
import { InstructionDiscovery } from "@opencode/core/instruction-discovery"
// Location 级服务映射与活动跟踪。
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { LocationActivity } from "@opencode/core/location-activity"
// 模型目录（models.dev）与控制台访问。
import { ModelsDev } from "@opencode/core/models-dev"
import { ConsoleAccess } from "@opencode/core/console-access"
// 会话重启与调度。
import { SessionRestart } from "@opencode/core/session/execution/restart"
import { Schedule } from "@opencode/core/schedule"
// 插件更新与 SDK 插件。
import { PluginUpdate } from "@opencode/core/plugin/update"
import { SdkPlugins } from "@opencode/core/plugin/sdk"
// well-known 与工作区。
import { WellKnown } from "@opencode/core/wellknown"
import { Workspace } from "@opencode/core/workspace"
// 文件系统监听。
import { Watcher } from "@opencode/core/filesystem/watcher"
import { FileWatch } from "@opencode/core/filesystem/file-watch"
// effect 的 HTTP 路由与 API 构建。
import { HttpRouter } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { Context, Effect, Layer, Option } from "effect"
// Api：effect HttpApi 定义（OpenAPI 由它生成）；auth：鉴权配置。
import { Api } from "./api"
import { ServerAuth } from "./auth"
// CORS 配置。
import { CorsConfig } from "./cors"
// 全部端点处理器。
import { handlers } from "./handlers"
// 中间件：鉴权/schema 错误/表单与会的 Location 归属。
import { authorizationLayer } from "./middleware/authorization"
import { schemaErrorLayer } from "./middleware/schema-error"
import { ServerPairing } from "./pairing"
import { layer } from "./location"
import { formLocationLayer } from "./middleware/form-location"
import { sessionLocationLayer } from "./middleware/session-location"
// 服务器信息与选项。
import { ServerInfo } from "./server-info"
import type { ServerOptions } from "./options"

// 应用级服务节点全集：这些服务在“宿主图”里只有一份，被所有请求共享。
const applicationServiceNodes = [
  Global.node,
  FSUtil.node,
  Database.node,
  KV.node,
  Bus.node,
  EventLogger.node,
  httpClient,
  Job.node,
  Project.node,
  Project.sweepNode,
  Worktree.node,
  Session.node,
  Instance.node,
  SessionTransfer.node,
  InstructionEntry.node,
  SdkPlugins.node,
  PluginUpdate.node,
  PermissionSaved.node,
  PtyTicket.node,
  PersistentPty.node,
  Credential.node,
  WellKnown.node,
  ServerPairing.node,
  LocationServiceMap.node,
  LocationActivity.node,
  SessionRestart.node,
  Schedule.node,
  Workspace.node,
  FileWatch.node,
] as const
// 分组为一组 LayerNode（可整体构建/替换）。
const applicationServices = LayerNode.group(applicationServiceNodes)

// createRoutes：独立 server 入口。有密码 → 用配置版鉴权层；否则用默认。
export function createRoutes(
  options: ServerOptions = {},
  serviceURLs: () => ReadonlyArray<string> = () => [],
  overrides: LayerNode.Replacements = [],
) {
  return makeRoutes(
    options.password
      ? ServerAuth.Config.configLayer({ password: Option.some(options.password) })
      : ServerAuth.Config.layer,
    options,
    serviceURLs,
    overrides,
  )
}

// InstanceNode：实例服务的提供者类型（嵌入式场景可替换实例解析逻辑）。
type InstanceNode = (
  replacements: () => LayerNode.Replacements,
) => LayerNode.Provider<Instance.Service, never, typeof Node.tags.values.global>

// createEmbeddedRoutes：嵌入式入口（TUI/桌面内嵌），无密码鉴权。
export function createEmbeddedRoutes(
  options: ServerOptions = {},
  overrides: LayerNode.Replacements = [],
  instances?: InstanceNode,
) {
  return makeRoutes(ServerAuth.Config.configLayer({ password: Option.none() }), options, () => [], overrides, instances)
}

// makeRoutes：真正装配。标准替换集 standard 按 options 定制各服务；
// build() 把替换应用到应用服务组上；最后把 HTTP API 层接起来。
function makeRoutes<AuthError, AuthServices>(
  auth: Layer.Layer<ServerAuth.Config, AuthError, AuthServices>,
  options: ServerOptions,
  serviceURLs: () => ReadonlyArray<string>,
  // Runtime-profile replacements (e.g. workerd) applied after the standard set, so later entries win.
  // 运行时画像的替换（如 workerd）排在标准集之后——后写的生效。
  overrides: LayerNode.Replacements,
  instances?: InstanceNode,
) {
  // standard：按部署形态替换各服务的实现。
  const standard: LayerNode.Replacements = [
    // 数据库路径/PTY/事件持久化/应用信息。
    Database.node.replace(Database.configured(options.database)),
    PersistentPty.node.replace(PersistentPty.configured(options.pty)),
    Bus.node.replace(Bus.configured({ persist: options.events?.persist })),
    App.node.replace(App.configured(options.app)),
    // 模型目录来源。
    ModelsDev.node.replace(ModelsDev.configured(options.models)),
    // fetch 层（测试/代理可替换）。
    httpFetch.replace(fetchLayer(options.fetch)),
    // 控制台访问凭据。
    ConsoleAccess.node.replace(ConsoleAccess.configured(options.console)),
    // 文件监听开关。
    Watcher.node.replace(Watcher.configured({ enabled: options.fs?.filewatcher })),
    FileWatch.node.replace(FileWatch.configured({ enabled: options.fs?.filewatcher })),
    // 文件搜索实现。
    FileSystemSearch.node.replace(FileSystemSearch.configured({ fff: options.fs?.fff })),
    // 全局目录（配置目录可指定）。
    Global.node.replace(Global.layerWith(options.config?.directory ? { config: options.config.directory } : {})),
    // 配置来源（项目/claude/文件/内容）。
    Config.node.replace(
      Config.configured({
        project: options.config?.project,
        claude: options.config?.claude,
        file: options.config?.file,
        content: options.config?.content,
      }),
    ),
    // 指令发现范围。
    InstructionDiscovery.node.replace(InstructionDiscovery.configured({ project: options.config?.project })),
    // Windows 上的 Git Bash 支持。
    ShellSelect.node.replace(ShellSelect.configured({ gitbash: options.windows?.gitbash })),
    // MCP 客户端身份。
    Mcp.node.replace(
      Mcp.configured({
        clientInfo: {
          name: "opencode",
          version: options.app?.version ?? "unknown",
        },
      }),
    ),
  ]
  // build：把标准替换 + 外部替换合并后构建完整依赖图。
  const build = (overrides: LayerNode.Replacements) => {
    const replacements: LayerNode.Replacements = [
      ...standard,
      // Private instances resolve this list lazily so they inherit the complete host graph, including the selector.
      // 私有实例惰性解析这份列表，从而继承完整宿主图（含选择器）。
      ...(instances ? [Instance.node.replace(instances(() => replacements))] : []),
      ...overrides,
    ]
    return AppNodeBuilder.build(applicationServices, replacements)
  }
  // 模拟模式：动态加载 simulation 后端并追加其替换（测试/演示用）。
  const serviceLayer = options.simulation
    ? Layer.unwrap(
        Effect.gen(function* () {
          const { simulationReplacements } = yield* Effect.promise(() => import("@opencode/simulation/backend"))
          const simulation = yield* simulationReplacements({ version: App.make(options.app).version })
          return build([...overrides, ...simulation])
        }),
      )
    : build(overrides)
  // 在构建好的服务上下文上挂 HTTP API。
  return serviceLayer.pipe(
    Layer.flatMap((context) => {
      // services：把整张服务图变成请求可见的上下文。
      const services = Layer.succeedContext(context)
      // 每请求注入的轻量子集（避免把重服务带进请求作用域）。
      const requestServices = Layer.merge(
        Layer.succeedContext(
          Context.pick(
            Database.Service,
            Credential.Service,
            PermissionSaved.Service,
            PluginUpdate.Service,
            Project.Service,
            WellKnown.Service,
          )(context),
        ),
        ServerInfo.layer(serviceURLs, Context.get(context, Global.Service).tmp, options.app),
      )
      // HttpApiBuilder：从 Api 定义生成路由（并暴露 /openapi.json）。
      const api = HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }).pipe(
        // 处理器 + CORS 配置。
        Layer.provide(handlers.pipe(Layer.provide(services), Layer.provide(Layer.succeed(CorsConfig, options)))),
        // 表单请求的 Location 归属中间件。
        Layer.provide(formLocationLayer),
        // 会话请求的 Location 归属中间件。
        Layer.provide(sessionLocationLayer),
        Layer.provide(layer),
        // 鉴权授权中间件与 schema 错误格式化。
        Layer.provide(authorizationLayer),
        Layer.provide(schemaErrorLayer),
        // 鉴权层。
        Layer.provide(auth),
        // 请求级服务注入。
        HttpRouter.provideRequest(requestServices),
        // 合并服务上下文与路由层。
        Layer.provideMerge(services),
        Layer.provideMerge(HttpRouter.layer),
      )
      // API 与 v1 迁移层并行挂载。
      return Layer.merge(api, V1Migration.layer.pipe(Layer.provide(services)))
    }),
  )
}
