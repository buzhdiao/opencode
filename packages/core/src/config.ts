// 配置（Config）服务：发现、加载、合并各来源配置文档，监听文件变化并支持热重载与更新。
export * as Config from "./config.js"

import { makeLocationNode } from "@opencode/util/effect/app-node"
import path from "path"
import { isDeepStrictEqual } from "node:util"
// jsonc-parser：JSONC 的解析与修改工具
import { applyEdits, modify, type ParseError, parse } from "jsonc-parser"
import { Context, Effect, FiberMap, Layer, Option, PubSub, Schema, Semaphore, Stream } from "effect"
import { Directory, Document, Info, type Patch, type Entry, Event } from "@opencode/schema/config"
import { Credential } from "./credential.js"
import { Bus } from "./bus.js"
import { Watcher } from "./filesystem/watcher.js"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Location } from "./location.js"
import { AbsolutePath } from "./schema.js"
import { ConfigVariable } from "./config/variable.js"
import { ConfigNormalize } from "./config/normalize.js"
import { ConfigDiscovery } from "./config/discovery.js"
import { ConfigWatch } from "./config/watch.js"
import { ConfigIntegration } from "./config/integration.js"
import { ConfigManaged } from "./config/managed.js"
import { ManagedPolicy } from "./managed-policy.js"
import { Connection } from "@opencode/schema/connection"
import { WellKnown } from "./wellknown.js"
import { AppProcess } from "@opencode/util/process"
import { ChildProcess } from "effect/process"

// 取配置条目中某字段的最高优先级值：从后往前找最后一个设置了该字段的文档
export function latest<K extends keyof Info>(entries: readonly Entry[], key: K): Info[K] | undefined {
  return entries.findLast((entry): entry is Document => entry.type === "document" && entry.info[key] !== undefined)
    ?.info[key]
}

// 配置服务接口
export interface Interface {
  /** Returns location config documents and discovery sources from lowest to highest priority. */
  // 返回位置配置文档与发现来源，按优先级从低到高排列
  readonly entries: () => Effect.Effect<Entry[]>
  /**
   * The entries `entries()` returns, read synchronously. Transforms read this, so a reload that runs right after a
   * config change, such as an integration replacing its document, sees the change before `config.updated` arrives.
   */
  // 同步读取 entries() 的当前结果；重载转换器用它，确保配置变更后立即可见
  readonly snapshot: () => Entry[]
  /** Compatibility roots consumed by internal compatibility plugins. */
  // 供内部兼容插件消费的兼容根目录（claude/agents）
  readonly compatibility?: () => Effect.Effect<{
    readonly claude: readonly AbsolutePath[]
    readonly agents: readonly AbsolutePath[]
  }>
  /**
   * Streams raw filesystem updates under config roots. Config owns root
   * topology and watch reconciliation; domain owners filter this feed for the
   * source files they parse and rebuild their own state.
   */
  // 订阅配置根目录下的原始文件系统更新流；各域自行过滤并重建自己的状态
  readonly changes: () => Stream.Stream<Watcher.Update>
  /** Updates supported global config fields while preserving unrelated JSONC content. */
  // 更新支持的全局配置字段，同时保留无关的 JSONC 内容
  readonly update?: (patch: Patch) => Effect.Effect<void, FSUtil.Error>
  /**
   * Replaces, or clears with `undefined`, the document an integration connection contributes. It loads right after
   * managed policies: its settings layer below remote, user, and project config, while its policies outrank theirs.
   * Changing it reloads config like any other source.
   */
  // 替换（或传 undefined 清除）某集成连接贡献的配置文档；变更会像其他来源一样触发重载
  readonly integration?: (
    integrationID: ConfigIntegration.Document["integrationID"],
    document: ConfigIntegration.Document | undefined,
  ) => Effect.Effect<void>
}

// 层装配选项（Options）：控制各配置来源的开关
export const Options = Schema.Struct({
  project: Schema.optional(Schema.Boolean),
  // false skips the system and global config dirs, ~/.claude, and ~/.agents;
  // wellknown, file, and content entries still load.
  // global=false 时跳过系统与全局配置目录、~/.claude 与 ~/.agents；wellknown/file/content 条目仍会加载
  global: Schema.optional(Schema.Boolean),
  system: Schema.optional(Schema.Union([Schema.Boolean, Schema.String])),
  // false skips ~/.claude and project .claude dirs.
  // claude=false 时跳过 ~/.claude 与项目 .claude 目录
  claude: Schema.optional(Schema.Boolean),
  file: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
})
export type Options = typeof Options.Type

// Effect 服务令牌
export class Service extends Context.Service<Service, Interface>()("@opencode/Config") {}

// 测试扩展接口：可替换条目与手工注入变更
export interface TestInterface extends Interface {
  /** Replaces the entries returned by subsequent entries() calls. */
  readonly setEntries: (entries: Entry[]) => Effect.Effect<void>
  /** Emits one filesystem update to every changes() subscriber. */
  readonly emitChange: (update: Watcher.Update) => Effect.Effect<void>
}

// 测试服务令牌
export class Test extends Context.Service<Test, TestInterface>()("@opencode/Config/Test") {}

/** In-memory config for tests: static entries with replaceable state and a test-driven change feed. */
// 测试用内存配置层：静态条目 + 可替换状态 + 测试驱动的变更流
export const testLayer = (
  // 初始条目，默认为空
  initial: Entry[] = [],
  compatibility: { readonly claude: readonly AbsolutePath[]; readonly agents: readonly AbsolutePath[] } = {
    claude: [],
    agents: [],
  },
) =>
  Layer.effectContext(
    Effect.gen(function* () {
      // 可变的测试状态：静态条目与集成文档映射
      const state = { entries: initial, integrations: new Map<string, ConfigIntegration.Document>() }
      // 无界发布订阅，承载变更
      const updates = yield* PubSub.unbounded<Watcher.Update>()
      // 快照 = 集成文档 + 静态条目
      const snapshot = () => [...state.integrations.values(), ...state.entries]
      const service = Test.of({
        // 惰性取快照
        entries: () => Effect.sync(snapshot),
        snapshot,
        compatibility: () => Effect.succeed(compatibility),
        // 变更流
        changes: () => Stream.fromPubSub(updates),
        setEntries: (next) =>
          Effect.sync(() => {
            // 直接替换条目
            state.entries = next
          }),
        // 向订阅者广播一条更新
        emitChange: (update) => PubSub.publish(updates, update).pipe(Effect.asVoid),
        integration: (integrationID, document) =>
          Effect.sync(() => {
            const next = new Map(state.integrations)
            // 先移除旧文档
            next.delete(integrationID)
            // 有新文档则写入
            state.integrations = document ? next.set(integrationID, document) : next
          }),
      })
      // 同时以 Service 与 Test 两个令牌注册同一实现
      return Context.empty().pipe(Context.add(Service, service), Context.add(Test, service))
    }),
  )

// 生产配置层工厂：按选项发现并加载配置，订阅变更并支持热重载
export const layer = (options?: Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      // 底层文件系统工具
      const fs = yield* FSUtil.Service
      // 当前位置服务
      const location = yield* Location.Service
      // 文件监听服务
      const watcher = yield* Watcher.Service
      // 事件总线
      const bus = yield* Bus.Service
      // 凭据服务（wellknown 需要凭据）
      const credentials = yield* Credential.Service
      // 全局路径服务
      const globalService = yield* Global.Service
      // 远端清单（wellknown）服务
      const wellknown = yield* WellKnown.Service
      // 子进程服务（MDM 偏好转换用）
      const processes = yield* AppProcess.Service
      // 集成文档登记表：集成 ID → 文档
      const integrations = new Map<string, ConfigIntegration.Document>()
      // Integrations set their documents from outside this layer, so their reloads run with its services.
      // 集成从本层之外设置文档，因此其触发的重载需要携带本层的服务上下文
      const context = yield* Effect.context<FSUtil.Service | Global.Service | Location.Service>()
      // 重载互斥信号量：同一时刻只允许一次重载
      const reloadLock = Semaphore.makeUnsafe(1)
      // 更新互斥信号量：串行化 update 调用
      const updateLock = Semaphore.makeUnsafe(1)
      // 解码选项：收集全部错误、忽略多余属性
      const decodeOptions = { errors: "all", onExcessProperty: "ignore" } as const
      // Info 的宽松解码器
      const decodeInfo = Schema.decodeUnknownOption(Info, decodeOptions)
      // parseInfo：解析文本为 Info；解析失败、规范化拒绝或最终校验失败都会记录诊断并返回 undefined
      const parseInfo = Effect.fn("Config.parseInfo")(function* (text: string, source: string) {
        const errors: ParseError[] = []
        // JSONC 解析，允许尾逗号
        const input: unknown = parse(text, errors, { allowTrailingComma: true })
        if (errors.length) {
          yield* Effect.logWarning("configuration normalization diagnostic", {
            source,
            path: "$",
            kind: "invalid",
            // 畸形文档：记录诊断后拒绝
            action: "rejected malformed JSON or JSONC document",
          })
          return
        }
        // 规范化输入（别名、弃用字段等）
        const result = ConfigNormalize.normalize(input)
        yield* Effect.forEach(result.diagnostics, (diagnostic) =>
          Effect.logWarning("configuration normalization diagnostic", {
            // 逐条记录规范化诊断
            source,
            path: diagnostic.path[0] === "$" ? "$" : `$.${diagnostic.path.join(".")}`,
            kind: diagnostic.kind,
            action: diagnostic.message,
          }),
        )
        // 规范化判定拒绝则放弃
        if (result.type === "rejected") return
        // 最终校验解码
        const info = Option.getOrUndefined(decodeInfo(result.encoded))
        if (info) return info
        yield* Effect.logWarning("configuration normalization diagnostic", {
          source,
          path: "$",
          kind: "invalid",
          // 规范化通过但最终校验失败
          action: "rejected canonical configuration after final validation",
        })
      })

      // loadFile：读取单个配置文件 → 变量替换 → 解析为文档
      const loadFile = Effect.fnUntraced(function* (filepath: string) {
        const text = yield* fs.readFileStringSafe(filepath)
        // 文件读不到（不存在/不可读）则跳过
        if (text === undefined) return
        // 展开 ${...} 变量
        const substituted = yield* ConfigVariable.substitute({ type: "path", path: filepath, text })
        const info = yield* parseInfo(substituted, filepath)
        if (!info) return
        return new Document({ type: "document", path: AbsolutePath.make(filepath), info })
      })

      // loadWellknownEntry：用凭据解析一个远端清单条目并生成文档
      const loadWellknownEntry = Effect.fnUntraced(function* (entry: WellKnown.Entry) {
        // 清单声明的认证方式
        const auth = entry.manifest.auth
        // 取该集成最新的凭据
        const credential = (yield* credentials.list(entry.integrationID)).at(-1)
        // 仅 key 型凭据能提供环境变量
        const variables = auth && credential?.value.type === "key" ? { [auth.env]: credential.value.key } : undefined
        // A failed refresh, including a missing credential, keeps the last resolved config so remote providers
        // and allowlists do not disappear; only removing the source clears it.
        // 刷新失败（含缺凭据）时保留上次解析结果，避免远端 provider 与允许列表突然消失
        const configs = yield* (
          variables ? wellknown.resolve(entry, variables) : Effect.fail(new Error("No usable wellknown credential"))
        ).pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to load wellknown config", { source: entry.origin, error }).pipe(
              // 失败时回退到缓存
              Effect.andThen(wellknown.cached(entry.origin)),
            ),
          ),
        )
        // 对每个解析出的配置做变量替换并解析为文档，最后过滤掉解析失败的
        return yield* Effect.forEach(configs, (config) =>
          ConfigVariable.substitute({
            type: "virtual",
            source: entry.origin,
            dir: entry.origin,
            text: JSON.stringify(config),
            env: variables,
          }).pipe(
            Effect.flatMap((text) => parseInfo(text, entry.origin)),
            Effect.map((info) =>
              info
                ? new ConfigIntegration.WellKnownDocument({
                    type: "document",
                    info,
                    integrationID: entry.integrationID,
                  })
                : undefined,
            ),
          ),
        ).pipe(Effect.map((documents) => documents.filter((document) => document !== undefined)))
      })

      // loadWellknown：加载全部 wellknown 条目；发现失败时按空列表处理
      const loadWellknown = Effect.fn("Config.loadWellknown")(function* () {
        const entries = yield* wellknown
          .entries()
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("failed to discover wellknown config", { error }).pipe(Effect.as([] as const)),
            ),
          )
        return yield* Effect.forEach(entries, (entry) =>
          loadWellknownEntry(entry).pipe(
            Effect.map((documents) => ({ integrationID: entry.integrationID, documents })),
          ),
        )
      })

      // `integration.use` decides whether an integration may supply anything. Only managed policies can withhold the
      // documents an integration delivers, so a project file can never strip the Console document carrying org policy.
      // A withheld document keeps its policies, so denying an integration never lifts the restrictions it carries.
      // supplies：判定某集成是否被允许贡献内容；只有托管策略（managed policy）能拦截，项目文件无权剥离 Console 文档
      const supplies = Effect.fnUntraced(function* (
        // 托管策略语句集
        lockdown: ReturnType<typeof ManagedPolicy.statements>,
        integrationID: string,
        connection?: Connection.Info,
      ) {
        const stored =
          // 凭据型连接取出存储凭据
          connection?.type === "credential" ? yield* credentials.get(Credential.ID.make(connection.id)) : undefined
        const resource = ManagedPolicy.integrationResource(
          integrationID,
          stored ? ManagedPolicy.account(stored.value) : undefined,
        )
        // 非拒绝即允许
        return ManagedPolicy.decision(lockdown, "integration.use", resource) !== "deny"
      })

      // loadPreferences：加载 macOS 托管偏好（plist）：用 plutil 转 JSON 再解析为文档
      const loadPreferences = Effect.fn("Config.loadPreferences")(function* (plist: AbsolutePath) {
        const result = yield* processes
          .run(ChildProcess.make("plutil", ["-convert", "json", "-o", "-", plist], { stdin: "ignore" }), {
            // 限 10 秒防止卡死
            timeout: "10 seconds",
          })
          // 失败归一为 None
          .pipe(Effect.flatMap(AppProcess.requireSuccess), Effect.option)
        if (Option.isNone(result)) {
          yield* Effect.logWarning("failed to convert managed preferences", { source: plist })
          return []
        }
        const text = yield* ConfigVariable.substitute({
          type: "virtual",
          source: plist,
          dir: path.dirname(plist),
          // 去除 plist 元数据字段
          text: ConfigDiscovery.stripPreferenceMetadata(result.value.stdout.toString()),
        })
        const info = yield* parseInfo(text, plist)
        return info ? [new Document({ type: "document", path: plist, info })] : []
      })

      // loadDirectory：加载目录内各命名配置文件 + 目录条目本身
      const loadDirectory = Effect.fnUntraced(function* (directory: AbsolutePath) {
        return [
          ...(yield* Effect.forEach(ConfigDiscovery.names, (file) => loadFile(path.join(directory, file))).pipe(
            Effect.map((configs) => configs.filter((config): config is Document => config !== undefined)),
          )),
          // 记录目录本身，供优先级与兼容逻辑使用
          new Directory({ type: "directory", path: directory }),
        ]
      })

      // load：加载全部来源并按优先级拼接为最终条目列表
      const load = Effect.fn("Config.load")(function* (sources: ConfigDiscovery.Sources) {
        // direct：项目内的直接文件来源
        const direct = yield* Effect.forEach(sources.direct, (filepath) => loadFile(filepath)).pipe(
          Effect.orDie,
          Effect.map((entries) => entries.filter((entry): entry is Document => entry !== undefined)),
        )

        // explicit：显式指定的单个配置文件（如 --config 参数）
        const explicit = sources.explicit
          ? yield* loadFile(sources.explicit).pipe(
              Effect.map((config) => (config ? [config] : [])),
              Effect.orDie,
            )
          : []
        // content：环境注入的内容来源（OPENCODE_CONFIG_CONTENT）
        const content =
          options?.content !== undefined
            ? yield* ConfigVariable.substitute({
                type: "virtual",
                source: "OPENCODE_CONFIG_CONTENT",
                dir: location.directory,
                text: options.content,
              }).pipe(
                Effect.flatMap((text) => parseInfo(text, "OPENCODE_CONFIG_CONTENT")),
                Effect.map((info) => (info ? [new Document({ type: "document", info })] : [])),
                Effect.orDie,
              )
            : []

        // Managed settings load last so they override everything, and MDM
        // preferences outrank the system directory as in V1. Policies evaluate
        // in reverse load order, so managed policies split off and load first
        // to keep final file-based authority.
        // 托管设置最后加载以覆盖一切；MDM 偏好高于系统目录（同 V1）；策略按加载逆序求值，因此托管策略先拆分加载以保持文件级权威
        const managed = [
          ...(sources.system?.present ? yield* loadDirectory(sources.system.path).pipe(Effect.orDie) : []),
          ...(sources.preferences ? yield* loadPreferences(sources.preferences).pipe(Effect.orDie) : []),
        ]
        // managedPolicies：提取托管来源中的策略文档并反转（策略按逆序求值，先加载者优先级最高）
        const managedPolicies = managed
          .flatMap((entry) =>
            entry.type === "document" && entry.info.policies
              ? [
                  new ConfigManaged.Document({
                    type: "document",
                    path: entry.path,
                    info: new Info({ policies: entry.info.policies }),
                  }),
                ]
              : [],
          )
          .toReversed()
        // managedSettings：托管设置剥离策略字段后仅保留设置内容
        const managedSettings = managed.map((entry) =>
          entry.type === "document"
            ? new ConfigManaged.Document({ ...entry, info: new Info({ ...entry.info, policies: undefined }) })
            : entry,
        )
        // Integration documents load right after managed policies: every remote, user, and project layer overrides
        // their settings, and since policies evaluate earliest-loaded first, only managed policies outrank theirs.
        // Global entries sit below explicit and direct files; project directories rank above them.
        // globalSupplementary：全局目录条目低于显式与直接文件；项目目录高于全局
        const globalSupplementary = sources.global ? yield* loadDirectory(sources.global).pipe(Effect.orDie) : []
        // projectSupplementary：各项目根目录的补充配置（仅存在的根）
        const projectSupplementary = yield* Effect.forEach(
          sources.project.filter((root) => root.present),
          (root) => loadDirectory(root.path),
        ).pipe(
          Effect.orDie,
          Effect.map((entries) => entries.flat()),
        )
        // 汇总托管策略语句
        const lockdown = ManagedPolicy.statements(managedPolicies)
        // integrated：逐个判定集成文档是否被允许；被拒的保留策略、剥离设置
        const integrated = yield* Effect.forEach(integrations.values(), (document) =>
          supplies(lockdown, document.integrationID, document.connection).pipe(
            Effect.map((allowed) =>
              allowed
                ? document
                : new ConfigIntegration.Document({ ...document, info: new Info({ policies: document.info.policies }) }),
            ),
          ),
        )
        // wellknownDocuments：同样对 wellknown 文档做许可判定
        const wellknownDocuments = yield* Effect.forEach(yield* loadWellknown().pipe(Effect.orDie), (entry) =>
          supplies(lockdown, entry.integrationID).pipe(
            Effect.map((allowed) =>
              allowed
                ? entry.documents
                : entry.documents.map(
                    (document) =>
                      new ConfigIntegration.WellKnownDocument({
                        ...document,
                        info: new Info({ policies: document.info.policies }),
                      }),
                  ),
            ),
          ),
        )
        // 最终优先级拼接：托管策略 → 集成 → wellknown → 全局 → 显式 → 直接 → 项目 → 内容 → 托管设置
        return [
          ...managedPolicies,
          ...integrated,
          ...wellknownDocuments.flat(),
          ...globalSupplementary,
          ...explicit,
          ...direct,
          ...projectSupplementary,
          ...content,
          ...managedSettings,
        ]
      })

      // 初次发现配置来源
      const initial = yield* ConfigDiscovery.discover(options)
      // 当前来源（可变，重载时更新）
      let sources = initial
      // 当前加载的条目（可变，重载时更新）
      let configs = yield* load(initial)
      // 对外暴露的文件系统更新流
      const updates = yield* PubSub.unbounded<Watcher.Update>()
      // 重载请求通道（滑动窗口，只保留最新）
      const reloads = yield* PubSub.sliding<void>(1)
      // Readiness rescans recover writes made before a watch attached.
      // requestReload：发布一次重载请求；就绪前的重扫能补救在监听建立前完成的写入
      const requestReload = PubSub.publish(reloads, undefined).pipe(Effect.asVoid)
      // 正在监听的目标：key → Fiber
      const watched = yield* FiberMap.make<string>()
      // reconcile：按计划调和监听——移除不再需要的，新增缺失的（幂等）
      const reconcile = Effect.fn("Config.reconcileWatches")(function* (sources: ConfigDiscovery.Sources) {
        // 计算应监听的目标集合
        const plan = ConfigWatch.plan(sources)
        for (const key of Array.from(watched, ([key]) => key)) {
          // 计划外的监听直接移除
          if (!plan.has(key)) yield* FiberMap.remove(watched, key)
        }
        for (const [key, target] of plan) {
          yield* watcher
            // 订阅目标：文件事件触发重载请求
            .subscribe(target, requestReload)
            .pipe(
              Effect.flatMap(
                // 更新同时进变更流并请求重载
                Stream.runForEach((update) => PubSub.publish(updates, update).pipe(Effect.andThen(requestReload))),
              ),
              // 已在监听的 key 不重复启动
              FiberMap.run(watched, key, { onlyIfMissing: true, startImmediately: true }),
            )
        }
      })

      // reload：重新发现并加载，若有实质变化则广播 Updated 事件；全程持重载锁
      const reload = Effect.fn("Config.reload")(
        function* () {
          // 重新发现来源
          const discovered = yield* ConfigDiscovery.discover(options)
          // 重新加载条目
          const next = yield* load(discovered)
          // 调和监听
          yield* reconcile(discovered)
          const compatibilityChanged =
            // 兼容根（claude/agents）是否变化
            !isDeepStrictEqual(sources.claude, discovered.claude) ||
            !isDeepStrictEqual(sources.agents, discovered.agents)
          // 无变化则不发事件
          if (isDeepStrictEqual(configs, next) && !compatibilityChanged) return
          // 提交新来源
          sources = discovered
          // 提交新条目
          configs = next
          // 广播配置更新事件
          yield* bus.publish(Event.Updated, {})
        },
        (effect) => reloadLock.withPermit(effect),
      )

      // Subscribe eagerly so synchronous watch readiness isn't dropped.
      // 先订阅重载通道再启动调和，避免同步就绪的监听事件被丢失
      const pendingReloads = yield* PubSub.subscribe(reloads)
      yield* Stream.fromSubscription(pendingReloads).pipe(
        // 防抖：密集变更只触发一次重载
        Stream.debounce("100 millis"),
        Stream.runForEach(() =>
          // 重载失败仅记录不崩溃
          reload().pipe(Effect.catchCause((cause) => Effect.logError("failed to reload config", { cause }))),
        ),
        // 作用域内后台运行
        Effect.forkScoped({ startImmediately: true }),
      )
      // 凭据切换事件：若该集成存在 wellknown 条目则触发重载，使新凭据生效
      yield* bus.subscribe(Credential.Event.Switched).pipe(
        Stream.filterEffect((event) =>
          wellknown.entries().pipe(
            // 只关心 wellknown 集成
            Effect.map((entries) => entries.some((entry) => entry.integrationID === event.data.integrationID)),
            // 发现失败时按"不相关"处理
            Effect.orElseSucceed(() => false),
          ),
        ),
        Stream.runForEach(() =>
          reload().pipe(Effect.catchCause((cause) => Effect.logError("failed to reload wellknown config", { cause }))),
        ),
        Effect.forkScoped({ startImmediately: true }),
      )
      // wellknown 清单更新事件直接触发重载
      yield* bus.subscribe(WellKnown.Event.Updated).pipe(
        Stream.runForEach(() =>
          reload().pipe(Effect.catchCause((cause) => Effect.logError("failed to reload wellknown sources", { cause }))),
        ),
        Effect.forkScoped({ startImmediately: true }),
      )
      // 定时任务：每 10 分钟刷新一次 wellknown 清单；内容有变化时重载配置
      yield* Effect.sleep("10 minutes").pipe(
        Effect.andThen(
          Effect.suspend(() => {
            // 没有 wellknown 条目则跳过
            if (!wellknown.snapshot().length) return Effect.void
            return Effect.gen(function* () {
              const changed = yield* wellknown
                .refresh()
                .pipe(
                  Effect.catch((error) =>
                    // 刷新失败按未变化处理
                    Effect.logWarning("failed to refresh wellknown manifests", { error }).pipe(Effect.as(false)),
                  ),
                )
              // 只有内容变化才重载
              if (!changed) yield* reload()
            }).pipe(Effect.catchCause((cause) => Effect.logWarning("failed to refresh wellknown config", { cause })))
          }),
        ),
        // 无限循环
        Effect.forever,
        Effect.forkScoped({ startImmediately: true }),
      )
      // 持锁完成初始监听调和
      yield* reloadLock.withPermit(reconcile(initial))

      // update：把补丁写进全局配置文件的 shell 字段，保留其余 JSONC 内容
      const update = Effect.fn("Config.update")(
        function* (patch: Patch) {
          // 全局配置目录
          const directory = initial.global ?? AbsolutePath.make(globalService.config)
          // 各候选文件名
          const candidates = ConfigDiscovery.names.map((name) => path.join(directory, name))
          const filepath =
            // 取最后存在的候选，否则默认 jsonc
            (yield* Effect.filter(candidates, fs.isFile)).at(-1) ?? path.join(directory, "opencode.jsonc")
          // 读现有内容，空文件按 {} 处理
          const text = (yield* fs.readFileStringSafe(filepath)) ?? "{}\n"
          const updated = yield* Effect.try({
            try: () =>
              applyEdits(
                text,
                modify(text, ["shell"], patch.shell ?? undefined, {
                  // 在 shell 路径上做 JSONC 修改
                  // 缩进格式：2 空格
                  formattingOptions: { tabSize: 2, insertSpaces: true },
                }),
              ),
            catch: (cause) => new FSUtil.FileSystemError({ method: "config.update", cause }),
          })
          // 写回并保证以换行结尾
          yield* fs.writeWithDirs(filepath, updated.endsWith("\n") ? updated : `${updated}\n`)
          // 触发重载使新配置生效
          yield* requestReload
        },
        (effect) => updateLock.withPermit(effect),
      )

      return Service.of({
        entries: Effect.fnUntraced(function* () {
          // 返回当前条目
          return configs
        }),
        // 同步快照
        snapshot: () => configs,
        compatibility: () =>
          Effect.all({
            // 过滤出真实存在的 claude 兼容目录
            claude: Effect.filter(sources.claude, fs.isDir),
            agents: Effect.filter(sources.agents, fs.isDir),
          }),
        // 文件系统更新流
        changes: () => Stream.fromPubSub(updates),
        update,
        integration: Effect.fn("Config.integration")(function* (integrationID, document) {
          // 与现状一致则无事
          if (isDeepStrictEqual(integrations.get(integrationID), document)) return
          // 先移除旧文档
          integrations.delete(integrationID)
          // 有新文档则登记
          if (document) integrations.set(integrationID, document)
          yield* reload().pipe(
            // 携带本层服务上下文执行重载
            Effect.provide(context),
            Effect.catchCause((cause) => Effect.logError("failed to reload config", { cause })),
          )
        }),
      })
    }),
  )

// configured：按选项构造位置节点，把配置服务挂到依赖图上
export function configured(options?: Options) {
  return makeLocationNode({
    service: Service,
    layer: layer(options),
    deps: [
      Watcher.node,
      Bus.node,
      FSUtil.node,
      Global.node,
      Location.node,
      Credential.node,
      WellKnown.node,
      AppProcess.node,
    ],
  })
}

// 默认位置节点（不带选项）
export const node = configured()
