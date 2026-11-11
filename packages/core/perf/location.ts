// The Location service graph, loaded and kept the way a server keeps one per directory a client opens.
// strobe's script host loads this module once per block and calls its exports (perf/location.bench.ts).
// Everything runs against a temporary home: its own global folders and database, no filesystem
// watchers and no network, so it never touches a live server, database or user configuration.
// （上方英文注释原样保留：Location 服务图——按服务器"每打开一个目录持有一份"的方式加载与常驻。
// strobe 的脚本宿主每个 block 加载本模块一次并调用其导出（供 perf/location.bench.ts 测量）。
// 一切都跑在临时 HOME 上：独立的全局目录与数据库，无文件系统 watcher、无网络，
// 因此不会触碰真实的 server、数据库或用户配置。）
// 脚本宿主导出的操作：load（加载目录图）、invalidate（失效缓存）、keepLocation/keepPlugin（常驻成本）
// 导入 fs/promises：建临时目录、真实路径解析
import fs from "fs/promises"
// 导入 rmSync：进程退出时同步清理临时目录
import { rmSync } from "fs"
// 导入 os：取系统临时目录
import os from "os"
// 导入 path：拼接临时目录内各路径
import path from "path"
// 导入 Effect 栈：Effect/Layer 组合，Logger 关日志，ManagedRuntime 承载服务运行时，Scope 手工持有生命周期
import { Effect, Layer, Logger, ManagedRuntime, Scope } from "effect"
// 导入 Global 服务：进程级全局目录（HOME/data/cache/config 等）
import { Global } from "@opencode/util/global"
// 导入 LayerNode：Effect Layer 的分组/替换抽象（AppNodeBuilder 的输入）
import { LayerNode } from "@opencode/util/effect/layer-node"
// 导入 LayerNodePlatform：平台能力层（http fetch 等），用于替换为离线实现
import { LayerNodePlatform } from "@opencode/util/effect/app-node-platform"
// 导入 AppNodeBuilder：按服务分组 + 替换清单组装应用节点层的构建器
import { AppNodeBuilder } from "../src/effect/app-node-builder"
// 导入 Bus：事件总线服务
import { Bus } from "../src/bus"
// 导入 Database：SQLite 数据库服务
import { Database } from "../src/database/database"
// 导入 Integration：集成（MCP/插件提供方）服务
import { Integration } from "../src/integration"
// 导入 Location：目录服务（每个打开目录一份服务图）
import { Location } from "../src/location"
// 导入 LocationServiceMap：目录 → 服务实例的映射（缓存与失效逻辑所在）
import { LocationServiceMap } from "../src/location-service-map"
// 导入 ModelsDev：models.dev 目录服务（提供商/模型定义来源）
import { ModelsDev } from "../src/models-dev"
// 导入 Model：模型读模型服务
import { Model } from "../src/model"
// 导入 Plugin：插件激活服务
import { Plugin } from "../src/plugin"
// 导入 ModelsDevPlugin：models.dev 目录插件（把目录物化为 Provider/Model）
import { ModelsDevPlugin } from "../src/plugin/models-dev"
// 导入 SdkPlugins：SDK 插件服务
import { SdkPlugins } from "../src/plugin/sdk"
// 导入 Provider：提供商服务
import { Provider } from "../src/provider"
// 导入 AbsolutePath 品牌类型：绝对路径
import { AbsolutePath } from "../src/schema"
// 导入 Watcher：文件系统 watcher（bench 中禁用）
import { Watcher } from "../src/filesystem/watcher"
// 导入 location 测试夹具：构造 Location.Service 的桩（keepPlugin 用）
import { location } from "../test/fixture/location"
// 导入测试插件宿主：构造 provider/integration 的桩宿主（keepPlugin 用）
import { providerHost, host, integrationHost } from "../test/plugin/host"

// 本轮 bench 的临时根目录：mkdtemp 后取真实路径（macOS 的 /var/folders 是符号链接，见 snapshot.ts 同款处理）
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "opencode-location-bench-")))
// 进程退出时递归删除临时根目录（无论成败）
process.on("exit", () => rmSync(root, { recursive: true, force: true }))

// 离线 fetch：任何网络请求直接拒绝（bench 不碰网络），附带空 preconnect 以满足接口形状
const offline = Object.assign(() => Promise.reject(new Error("no network in the location benchmark")), {
  preconnect: () => {},
})

// 层替换清单：把生产实现换成 bench 受控实现（离线网络、临时全局目录、关目录拉取、关 watcher）
const replacements = [
  // HTTP fetch 替换为离线版：目录拉取、集成请求等全部走本地/桩
  LayerNodePlatform.httpFetch.replace(LayerNodePlatform.fetchLayer(offline)),
  // Global 替换：全部全局目录落在临时根下，与真实用户环境隔离
  Global.node.replace(
    Global.layerWith({
      // 临时 HOME
      home: path.join(root, "home"),
      // 临时数据目录
      data: path.join(root, "data"),
      // 临时缓存目录
      cache: path.join(root, "cache"),
      // 临时配置目录
      config: path.join(root, "config"),
      // 临时状态目录
      state: path.join(root, "state"),
      // 临时目录
      tmp: path.join(root, "tmp"),
      // 临时可执行文件缓存
      bin: path.join(root, "cache", "bin"),
      // 临时日志目录
      log: path.join(root, "data", "log"),
      // 临时仓库目录
      repos: path.join(root, "data", "repos"),
    }),
  ),
  // ModelsDev 替换：关闭线上目录拉取（fetch:false，用仓库内置/缓存数据）
  ModelsDev.node.replace(ModelsDev.configured({ fetch: false })),
  // Watcher 替换：禁用文件系统监听（bench 不测 watcher，也避免其干扰）
  Watcher.node.replace(Watcher.configured({ enabled: false })),
]

// 构建并启动长驻运行时：核心分组（数据库/总线/SDK 插件/目录映射/目录源）+ 上面的替换清单；
// Logger.layer([]) 静默所有日志，避免日志 IO 污染测量
const runtime = ManagedRuntime.make(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SdkPlugins.node, LocationServiceMap.node, ModelsDev.node]),
    replacements,
  ).pipe(Layer.provide(Logger.layer([]))),
)

// 运行一个依赖 LocationServiceMap 或 ModelsDev 服务的 Effect，转成 Promise
const run = <A, E>(effect: Effect.Effect<A, E, LocationServiceMap.Service | ModelsDev.Service>) =>
  runtime.runPromise(effect)

// The variant's own checkout: a real project with its config, git and instructions.
// （上方英文注释原样保留：被测目录取本仓库自身检出——一个带配置、git 与 instructions 的真实项目。）
// 被测 Location 引用：指向当前工作目录（即 opencode 仓库检出）
const ref = Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) })

// 导出 load：加载（或返回已缓存的）ref 目录的服务图——bench 的热/冷加载用例都调它
export const load = () =>
  run(
    Effect.gen(function* () {
      // 取目录服务映射
      const locations = yield* LocationServiceMap.Service
      // 在独立 scope 内构建该目录的上下文（服务图），scoped 结束即释放本次构建的资源
      yield* locations.contextEffect(ref).pipe(Effect.scoped)
    }),
  )

// 导出 invalidate：使 ref 目录的缓存失效（bench 的冷加载用例在每轮 run 后调用）
export const invalidate = () =>
  run(
    Effect.gen(function* () {
      // 取目录服务映射
      const locations = yield* LocationServiceMap.Service
      // 失效该目录的缓存
      yield* locations.invalidate(ref)
    }),
  )

// Graphs and plugin instances stay alive until the process ends, as a long-running server keeps them.
// （上方英文注释原样保留：图与插件实例存活到进程结束——正如长驻服务器保留它们。）
// 常驻用例共用的长命 scope：never 关闭，测量物化后的图/插件留在堆上的量
const kept = Effect.runSync(Scope.make())
// 已常驻的目录/插件实例计数（用于生成不重复的目录名）
let made = 0

// "人口普查"：物化提供商快照与全部/可用模型读模型——每个常驻实例都会跑一遍，代表真实负载
const population = Effect.gen(function* () {
  // 取提供商服务
  const providers = yield* Provider.Service
  // 取模型服务
  const models = yield* Model.Service
  // 物化提供商快照
  yield* providers.snapshot()
  // 物化全部模型列表
  yield* models.all()
  // 物化可用模型列表
  yield* models.available()
})

// One more full Location graph for a new directory, with its plugins active and its read models
// materialized.
// （上方英文注释原样保留：为新目录再建一个完整 Location 图——插件激活、读模型物化。）
// 导出 keepLocation：新建一个目录的完整服务图并挂到 kept scope 常驻
export const keepLocation = () =>
  run(
    Effect.gen(function* () {
      // 新目录：临时根下 projects/location-<序号>，每个实例一个
      const directory = path.join(root, "projects", `location-${made++}`)
      // 建目录（模拟一个真实存在的项目目录）
      yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))
      // 取目录服务映射
      const locations = yield* LocationServiceMap.Service
      // 为新目录构建服务图上下文，scope 提供为 kept——不随本 Effect 结束而释放
      const context = yield* locations
        .contextEffect(Location.Ref.make({ directory: AbsolutePath.make(directory) }))
        .pipe(Scope.provide(kept))
      // 在该上下文里取插件服务
      const plugins = yield* Plugin.Service.pipe(Effect.provideContext(context))
      // 等插件全部激活（真实目录打开时也会等这个）
      yield* plugins.awaitActivation
      // 物化提供商/模型读模型（真实负载的一部分）
      yield* population.pipe(Effect.provideContext(context))
    }),
  )

// One more models.dev source plugin against its own Provider, Model and Integration states: the
// shared definitions and per-instance materialization without the rest of a Location graph.
// （上方英文注释原样保留：再起一个 models.dev 来源插件，配独立的 Provider/Model/Integration 状态：
// 即"共享定义 + 每实例物化"，不含 Location 图的其余部分。）
// 导出 keepPlugin：单独实例化一个 models.dev 插件（最小组合）并常驻
export const keepPlugin = () =>
  run(
    Effect.gen(function* () {
      // 取共享的目录源服务（所有实例共用其定义）
      const modelsDev = yield* ModelsDev.Service
      // 新实例目录：临时根下 plugins/instance-<序号>
      const directory = AbsolutePath.make(path.join(root, "plugins", `instance-${made++}`))
      // 构建最小层组合（Provider/Model/Integration/Bus），Location 用测试桩固定指向新目录；
      // 替换清单照常生效（离线/临时全局目录），scope 同样挂在 kept 上
      const context = yield* Layer.build(
        AppNodeBuilder.build(LayerNode.group([Provider.node, Model.node, Integration.node, Bus.node]), [
          // 用测试夹具的 location 桩替换 Location 服务（避免拉起完整目录图）
          Location.node.replace(
            Layer.succeed(Location.Service, Location.Service.of(location(Location.Ref.make({ directory })))),
          ),
          // 附加公共替换（离线网络、临时全局目录等）
          ...replacements,
        ]),
      ).pipe(Scope.provide(kept))
      // 在该上下文里取提供商服务
      const providers = yield* Provider.Service.pipe(Effect.provideContext(context))
      // 取集成服务
      const integration = yield* Integration.Service.pipe(Effect.provideContext(context))
      // 启动 models.dev 插件：宿主用测试桩（provider/integration 的 host 包装），注册进共享目录源与本上下文
      yield* ModelsDevPlugin.effect(
        host({ provider: providerHost(providers), integration: integrationHost(integration) }),
      ).pipe(Effect.provideService(ModelsDev.Service, modelsDev), Effect.provideContext(context), Scope.provide(kept))
      // 拉一次集成列表（物化插件产出的集成读模型）
      yield* integration.list()
      // 物化提供商/模型读模型
      yield* population.pipe(Effect.provideContext(context))
    }),
  )
