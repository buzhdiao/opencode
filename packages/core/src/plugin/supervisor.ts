// 将本模块以命名空间 `PluginSupervisor` 全量导出
export * as PluginSupervisor from "./supervisor.js"

// 引入配置事件 schema（Event.Updated 等用于订阅配置变化）
import { Event } from "@opencode/schema/config"
// 引入 Effect 原语：Cause（错误因由）、Layer、Queue（队列）、Stream（流）
import { Cause, Effect, Layer, Queue, Stream } from "effect"
// 引入配置中插件来源（ConfigPluginSource）服务：提供操作序列与变更流
import { ConfigPluginSource } from "../config/plugin/source.js"
// 引入 Location 级节点工厂：把服务注册为每个 Location 作用域的单例
import { makeLocationNode } from "@opencode/util/effect/app-node"
// 引入事件总线服务
import { Bus } from "../bus.js"
// 引入 Npm 工具节点（作为依赖声明）
import { Npm } from "@opencode/util/npm"
// 引入插件注册表服务（Plugin.Service）
import { Plugin } from "../plugin.js"
// 引入实例级插件服务：宿主实例显式选择的插件
import { InstancePlugins } from "./instance.js"
// 引入内部（内置）插件清单
import { PluginInternal } from "./internal.js"
// 引入插件模块加载器：按操作加载/安装插件
import { PluginModule } from "./module.js"
// 引入 SDK 插件注册表（嵌入方贡献的插件）
import { SdkPlugins } from "./sdk.js"
// 引入插件更新服务：检查/跟踪包更新状态
import { PluginUpdate } from "./update.js"
// 引入文件系统监听器节点（作为依赖声明）
import { Watcher } from "../filesystem/watcher.js"

// 核心解析流程：按操作序列逐条处理插件启停/安装，产出最终应激活的插件集合
const resolve = Effect.fn("PluginSupervisor.resolve")(function* (
  // 已构建的插件模块加载器
  modules: Effect.Success<ReturnType<typeof PluginModule.make>>,
  // 前置插件（内部+SDK+实例），激活顺序在前
  pre: readonly Plugin.Generation[],
  // 后置插件，激活顺序在后
  post: readonly Plugin.Generation[],
  // 配置驱动的操作序列（enable/disable/remove/install 等）
  operations: readonly ConfigPluginSource.Operation[],
  // 是否允许安装缺失的包（第二遍解析时为 true）
  install: boolean,
  // 当前正在运行的包插件映射，用于失败时保留旧版本
  running: ReadonlyMap<string, Plugin.Generation>,
) {
  // 选择器匹配函数："*"匹配全部；"foo.*"按前缀匹配；否则要求完全相等
  const matches = (selector: string, target: string) =>
    selector === "*" || (selector.endsWith(".*") ? target.startsWith(selector.slice(0, -1)) : selector === target)
  // 合并前置与后置插件为完整定义列表
  const definitions = [...pre, ...post]
  // 启用集合：当前被视为启用的插件 id
  const enabled = new Set(definitions.map((plugin) => plugin.id))
  // 包插件映射：target -> 已加载成功的插件代
  const packages = new Map<string, Plugin.Generation>()
  // 待安装集合：包尚未安装、等待第二遍处理
  const pending = new Set<string>()
  // 失败映射：target -> 加载/激活失败信息
  const failures = new Map<string, Plugin.Failure>()
  // 汇总当前全部插件（定义 + 已加载的包插件）
  const plugins = () => [...definitions, ...packages.values()]

  // 逐条执行配置操作
  for (const operation of operations) {
    // remove 操作：禁用匹配的插件
    if (operation.type === "remove") {
      // 目标为 "*" 时清空全部失败记录
      if (operation.target === "*") failures.clear()
      // 匹配到且不受内部保护（guarded）的插件全部从启用集合移除
      plugins()
        .filter((plugin) => matches(operation.target, plugin.id) && !PluginInternal.guarded.has(plugin.id))
        .forEach((plugin) => enabled.delete(plugin.id))
      // 处理下一条操作
      continue
    }

    // 其余操作：先找出与目标匹配的现有插件
    const matched = plugins().filter((plugin) => matches(operation.target, plugin.id))
    // 判断目标是否指向插件而非包名：有匹配、全匹配、通配前缀或内置 opencode. 前缀
    const selectsPlugins =
      matched.length > 0 ||
      operation.target === "*" ||
      operation.target.endsWith(".*") ||
      operation.target.startsWith("opencode.")
    // 若是插件选择操作：把匹配的插件加入启用集合并继续
    if (selectsPlugins) {
      matched.forEach((plugin) => enabled.add(plugin.id))
      continue
    }

    // 否则视为包操作：尝试加载（必要时安装）该包插件
    const plugin = yield* modules.load(operation, { install }).pipe(
      // 加载失败时记录警告并生成错误引用，而不是中断整个解析
      Effect.catchCause((cause) => {
        // 生成短随机引用，便于日志与失败信息互相关联
        const ref = `err_${crypto.randomUUID().slice(0, 8)}`
        // 从 Cause 中提取实际错误对象
        const error = Cause.squash(cause)
        // 记录警告日志，返回带错误消息与引用的失败结果
        return Effect.logWarning("failed to load plugin", { target: operation.target, ref, cause }).pipe(
          Effect.as({ error: error instanceof PluginModule.LoadError ? error.message : "Plugin failed to load", ref }),
        )
      }),
    )
    // 结果标记为 blocked（如受保护的内置包）：撤销该目标旧插件的启用并移除记录
    if ("blocked" in plugin) {
      // 取出之前的包插件代
      const previous = packages.get(operation.target)
      // 若存在则从启用集合移除其 id
      if (previous) enabled.delete(previous.id)
      // 删除该目标的包插件记录
      packages.delete(operation.target)
      // 同时清掉其失败记录
      failures.delete(operation.target)
      // 处理下一条操作
      continue
    }
    // 结果标记为 pending：包尚未就绪（如需下载），加入待安装集合
    if ("pending" in plugin) {
      pending.add(operation.target)
      continue
    }
    // 结果为 error：记录失败信息
    if ("error" in plugin) {
      // 写入失败映射：来源、失败状态（含错误与引用）、默认服务端特性
      failures.set(operation.target, {
        source: PluginModule.source(operation.target),
        state: { status: "failed", error: plugin.error, ref: plugin.ref },
        features: { server: true },
      })
      // The new revision never became a generation, so the one already running keeps its place.
      // 新修订未能成为可用"代"，已在运行的旧版本继续保留其位置
      const retained = packages.get(operation.target) ?? running.get(operation.target)
      // 若没有任何可保留的旧版本则直接跳过
      if (!retained) continue
      // 把旧版本写回包映射并保持启用
      packages.set(operation.target, retained)
      enabled.add(retained.id)
      // 处理下一条操作
      continue
    }
    // 加载成功：清除该目标的失败记录
    failures.delete(operation.target)
    // 取出旧版本的插件代
    const previous = packages.get(operation.target)
    // 若存在则先从启用集合移除，避免新旧并存
    if (previous) enabled.delete(previous.id)
    // 写入新加载的插件代
    packages.set(operation.target, plugin)
    // 将其 id 加入启用集合
    enabled.add(plugin.id)
  }

  // 按启动顺序组装最终列表：前置 -> 包插件 -> 后置，全部经启用集合过滤
  const ordered = [
    ...pre.filter((plugin) => enabled.has(plugin.id)),
    ...[...packages.values()].filter((plugin) => enabled.has(plugin.id)),
    ...post.filter((plugin) => enabled.has(plugin.id)),
  ]
  // Registry activation dies on a duplicate ID, which would drop the whole generation including builtins.
  // Keep the first occurrence in boot order and report later ones like any other plugin setup failure.
  // 注册表激活遇到重复 ID 会整体失败（连内置插件一起丢失）；保留启动顺序中的首次出现，把后续重复按插件失败上报
  const duplicate = (plugin: Plugin.Generation, index: number) =>
    ordered.findIndex((other) => other.id === plugin.id) !== index
  // 返回解析结果：去重后的插件列表、按启用过滤的包映射、失败清单与待安装集合
  return {
    // plugins：过滤掉重复 ID 后的最终激活列表
    plugins: ordered.filter((plugin, index) => !duplicate(plugin, index)),
    // packages：仅保留仍在启用集合中的包插件
    packages: new Map([...packages].filter(([, plugin]) => enabled.has(plugin.id))),
    // failures：既有加载失败，也包含重复 ID 产生的失败记录
    failures: [
      ...failures.values(),
      // 把每个重复插件转换为一条失败记录
      ...ordered.filter(duplicate).map((plugin) => ({
        // 插件 ID
        id: Plugin.ID.make(plugin.id),
        // 来源缺省记为 builtin
        source: plugin.source ?? { type: "builtin" as const },
        // 失败状态：错误信息指出 ID 重复
        state: { status: "failed" as const, error: `Duplicate plugin ID: ${plugin.id}` },
        // 特性缺省为服务端
        features: plugin.features ?? { server: true as const },
      })),
    ],
    // pending：待安装的包目标列表
    pending: [...pending],
  }
})

// 监督层（supervisor layer）：装配插件监督器的全部运行逻辑
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    // 获取插件注册表服务
    const registry = yield* Plugin.Service
    // 获取 SDK 插件服务
    const sdk = yield* SdkPlugins.Service
    // 获取实例级插件服务
    const instance = yield* InstancePlugins.Service
    // 获取配置插件来源服务
    const sources = yield* ConfigPluginSource.Service
    // 构建插件模块加载器
    const modules = yield* PluginModule.make()
    // 获取事件总线服务
    const bus = yield* Bus.Service
    // 获取插件更新服务
    const updates = yield* PluginUpdate.Service
    // 读取内部插件清单（pre/post 两组）
    const internal = yield* PluginInternal.list()
    // 初始化一个"挂起"句柄：在首次激活完成前保持就绪状态为未就绪
    let release: Effect.Effect<void> | undefined = yield* registry.hold()
    // 注册终结器：作用域结束时若仍有挂起则释放
    yield* Effect.addFinalizer(() => release ?? Effect.void)
    // Built-ins capture services from this layer; unload them before those services close.
    // 内置插件会捕获本层提供的服务；必须在这些服务关闭前先注销插件
    yield* Effect.addFinalizer(registry.close)
    // 当前已知的包目标集合
    let packages = new Set<string>()
    // Last generation handed to the registry per target; a failed reload keeps it in place.
    // 每个 target 最近一次交给注册表的"代"；重载失败时旧代继续保留
    let running = new Map<string, Plugin.Generation>()
    // 已知有可用更新的包目标集合
    let outdated = new Set<string>()
    // 正在更新中的包目标集合
    const updating = new Set<string>()
    // 代计数器：每次激活递增，用于识别过期激活
    let generation = 0
    // 触发观察计数：递增以标记一次新的重载请求
    let observed = 0

    // 激活流程：解析全部来源并应用到注册表
    const activate = Effect.fn("PluginSupervisor.activate")(function* () {
      // 递增代计数，作为本次激活的标识
      const current = ++generation
      // Combine internal plugins with host-contributed plugins in boot order.
      // Instance-bound plugins come last: later activation can override earlier
      // container writes, so the instance's explicit choices win over globals.
      // 按启动顺序合并内部插件与宿主贡献的插件；实例绑定的插件放最后，后激活者可覆盖容器写入，实例的显式选择优先于全局
      const pre = [...internal.pre, ...sdk.all(), ...instance.all()]
      // 后置插件组
      const post = internal.post
      // 读取配置产生的操作序列
      const operations = yield* sources.operations()
      // Activate everything available locally before waiting on missing package installs.
      // 第一遍：install=false，先激活本地立即可用的插件，不必等待缺失包安装
      const immediate = yield* resolve(modules, pre, post, operations, false, running)
      // 装饰插件来源：为包来源附加 outdated/updating 标记
      const source = (source: Plugin.Source) =>
        source.type === "package"
          ? {
              // 展开包来源
              ...source,
              // 若该目标已知过时则附加 outdated 标记
              ...(outdated.has(source.target) ? { outdated: true as const } : {}),
              // 若该目标正在更新则附加 updating 标记
              ...(updating.has(source.target) ? { updating: true as const } : {}),
            }
          // 非包来源原样返回
          : source
      // 应用函数：把解析结果（含来源装饰）激活到注册表
      const apply = (resolved: typeof immediate) =>
        registry.activate(
          // 装饰每个插件的来源后传入
          resolved.plugins.map((plugin) => (plugin.source ? { ...plugin, source: source(plugin.source) } : plugin)),
          // 同样装饰失败记录的来源
          resolved.failures.map((failure) => ({ ...failure, source: source(failure.source) })),
        )
      // 先应用第一遍（仅本地可用）的结果
      yield* apply(immediate)
      // 若存在待安装目标：第二遍解析，允许安装缺失包
      const resolved = immediate.pending.length
        ? yield* resolve(modules, pre, post, operations, true, running)
        // 无待安装则直接复用第一遍结果
        : immediate
      // 第二遍结果与第一遍不同时再次应用
      if (resolved !== immediate) yield* apply(resolved)
      // 记录本次激活交付的包代映射，供下次失败回退使用
      running = resolved.packages
      // 收集本次激活涉及的包目标（插件与失败记录的包来源）
      const targets = new Set(
        [...resolved.plugins, ...resolved.failures].flatMap((plugin) =>
          plugin.source?.type === "package" ? [plugin.source.target] : [],
        ),
      )
      // 更新全局包目标集合
      packages = targets
      // 并发检查所有包目标的更新可用性，随后在后台对比并按需重新应用
      yield* Effect.forEach(
        targets,
        // 对每个目标调用更新检查，产出 [target, 是否有更新] 元组
        (target) => updates.check(target).pipe(Effect.map((available) => [target, available] as const)),
        // 并发数不受限
        { concurrency: "unbounded" },
      ).pipe(
        Effect.flatMap((checked) => {
          // 若期间已有更新的激活开始，则本次检查结果作废
          if (current !== generation) return Effect.void
          // 计算现在已知过时的目标集合
          const next = new Set(checked.flatMap(([target, available]) => (available ? [target] : [])))
          // 若过时集合未变化则无需重新激活
          if (next.size === outdated.size && [...next].every((target) => outdated.has(target))) return Effect.void
          // 更新过时集合并用新标记重新应用激活
          outdated = next
          return apply(resolved)
        }),
        // 在当前作用域后台分支执行（立即启动）
        Effect.forkScoped({ startImmediately: true }),
      )
    })
    // Start source consumers before activation, without an extra merge/debounce boundary delaying them.
    // Each source owns its upstream subscriptions; the queue retains the latest observed request.
    // 在激活前启动各来源消费者，避免额外的合并/去抖边界造成延迟；每个来源自持上游订阅，队列仅保留最新请求
    const triggers = yield* Queue.sliding<number>(1)
    // Make accepted work visible to awaitActivation before coalescing the burst.
    // 在合并突发请求之前，先让已接受的工作对 awaitActivation 可见
    const notify = Effect.gen(function* () {
      // 递增观察计数，标记一次新请求
      observed++
      // 若当前没有挂起句柄则重新挂起就绪状态
      if (!release) release = yield* registry.hold()
      // 把最新计数推入滑动队列（容量 1，仅保留最新）
      yield* Queue.offer(triggers, observed)
    })
    // 订阅工具：对给定流逐元素触发 notify，并在当前作用域后台运行
    const watch = <A>(stream: Stream.Stream<A>) =>
      stream.pipe(
        // 对流中每个元素执行 notify
        Stream.runForEach(() => notify),
        // 后台分支立即启动
        Effect.forkScoped({ startImmediately: true }),
      )
    // 监听配置来源变化 -> 触发重载
    yield* watch(sources.changes())
    // 监听插件模块变化（如本地插件文件变动）-> 触发重载
    yield* watch(modules.changes())
    // 每 24 小时定时触发一次重载（兜底刷新）
    yield* watch(Stream.fromEffectRepeat(Effect.sleep("24 hours")))
    // 监听配置更新与 SDK 插件更新事件 -> 触发重载
    yield* watch(bus.subscribe([Event.Updated, SdkPlugins.Updated]))
    // 监听包更新状态变化流
    yield* watch(
      updates.changes().pipe(
        // 只关心当前已安装的包目标
        Stream.filter((update) => packages.has(update.target)),
        // 按更新状态维护 outdated/updating 集合
        Stream.tap((update) =>
          Effect.sync(() => {
            // 有可用更新则加入 outdated，否则移除
            update.outdated ? outdated.add(update.target) : outdated.delete(update.target)
            // 正在更新则加入 updating，否则移除
            update.updating ? updating.add(update.target) : updating.delete(update.target)
          }),
        ),
      ),
    )
    // Run initial activation immediately; debounce only later requests. One consumer serializes both.
    // 首次激活立即执行；后续请求经 100ms 去抖合并。单一消费者保证激活串行化
    yield* Stream.concat(Stream.succeed(0), Stream.fromQueue(triggers).pipe(Stream.debounce("100 millis"))).pipe(
      Stream.runForEach((target) =>
        Effect.gen(function* () {
          // 执行激活；失败时记录错误日志而不中断消费者
          yield* activate().pipe(Effect.catchCause((cause) => Effect.logError("failed to reload plugins", { cause })))
          // 若本次处理期间又有新请求进入，则不释放就绪挂起（后续迭代会处理）
          if (observed !== target) return
          // 取出当前挂起句柄
          const settled = release
          // 清空句柄表示已消费
          release = undefined
          // 若存在挂起则执行释放，允许 awaitActivation 通过
          if (settled) yield* settled
        }),
      ),
      // 消费者在当前作用域后台立即启动
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
)

// 节点依赖列表：监督器运行所需的各服务节点与内置插件要求
const nodeDeps = [
  // 插件注册表节点
  Plugin.node,
  // SDK 插件节点
  SdkPlugins.node,
  // 实例插件节点
  InstancePlugins.node,
  // 配置插件来源节点
  ConfigPluginSource.node,
  // 插件更新节点
  PluginUpdate.node,
  // 事件总线节点
  Bus.node,
  // Npm 工具节点
  Npm.node,
  // 文件系统监听器节点
  Watcher.node,
  // 内部插件的依赖要求
  PluginInternal.requirements,
] as const

// 创建 Location 级节点：以监督层为核心，挂接全部依赖节点
export const node = makeLocationNode({ name: "plugin-supervisor", layer, deps: nodeDeps })
