// 将本模块以命名空间（namespace）形式整体导出；WellKnown 指通过 /.well-known/opencode 路径发现集成源的机制
export * as WellKnown from "./wellknown.js"

// 导入集成（Integration）模式，主要用于其 ID 类型
import { Integration } from "@opencode/schema/integration"
// 导入 Effect 的核心工具：Context（依赖注入上下文）、Effect（效果）、Layer（层）、Ref（可变引用）、Schema（模式校验）、Semaphore（信号量）
import { Context, Effect, Layer, Ref, Schema, Semaphore } from "effect"
// 导入 Effect 的 HTTP 客户端三件套：HttpClient（客户端服务）、HttpClientRequest（构造请求）、HttpClientResponse（解析响应）
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
// 导入 Node 的深度相等比较函数，用于判断刷新前后条目集合是否变化
import { isDeepStrictEqual } from "node:util"
// 导入"全局单例服务节点"构造工具（makeGlobalNode），用于把本服务注册为进程级全局服务
import { makeGlobalNode } from "@opencode/util/effect/app-node"
// 导入预配置好的 HTTP 客户端层（httpClient），作为本服务层的依赖
import { httpClient } from "@opencode/util/effect/app-node-platform"
// 导入事件总线（Bus），用于发布"源已更新"事件
import { Bus } from "./bus.js"
// 导入键值存储（KV）服务，用于持久化已注册源、清单与配置快照
import { KV } from "./kv.js"

// Auth（认证方式）的接口声明：类型由下方同名 Schema 结构派生
export interface Auth extends Schema.Schema.Type<typeof Auth> {}
// 定义 Auth 模式：command 为完成认证所需执行的命令数组，env 为认证所需环境变量的说明
export const Auth = Schema.Struct({
  // command：认证命令（字符串数组）
  command: Schema.Array(Schema.String),
  // env：认证需要的环境变量描述
  env: Schema.String,
}).annotate({ identifier: "WellKnown.Auth" })

// RemoteConfig（远程配置）的接口声明：类型由下方同名 Schema 派生
export interface RemoteConfig extends Schema.Schema.Type<typeof RemoteConfig> {}
// 定义 RemoteConfig 模式：url 指向远程配置端点，headers 为可选的请求头（值可含 {env:XXX} 占位符）
export const RemoteConfig = Schema.Struct({
  // url：远程配置的地址
  url: Schema.String,
  // headers：可选的请求头键值对
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}).annotate({ identifier: "WellKnown.RemoteConfig" })

// Config（配置）的接口声明：一个任意键值对的 JSON 对象
export interface Config extends Schema.Schema.Type<typeof Config> {}
// 定义 Config 模式：字符串键到任意 JSON 值的记录
export const Config = Schema.Record(Schema.String, Schema.Json).annotate({ identifier: "WellKnown.Config" })

// Manifest（清单）的接口声明：类型由下方同名 Schema 派生
export interface Manifest extends Schema.Schema.Type<typeof Manifest> {}
// 定义 Manifest 模式：well-known 清单内容，三部分均可选
export const Manifest = Schema.Struct({
  // auth：可选的认证方式说明
  auth: Schema.optional(Auth),
  // config：可选的内联配置（可为 null）
  config: Schema.optional(Schema.NullOr(Config)),
  // remote_config：可选的远程配置描述（从远端 URL 拉取）
  remote_config: Schema.optional(RemoteConfig),
}).annotate({ identifier: "WellKnown.Manifest" })

// 定义解析配置时的输入：origin 为源地址，variables 为替换占位符用的变量表
export interface ResolveInput {
  // 只读的源地址（origin）
  readonly origin: string
  // 可选的只读变量表，用于填充 {env:NAME} 之类的占位符
  readonly variables?: Readonly<Record<string, string>>
}

// 定义 Entry（条目）：一个已注册源及其拉取到的清单
export interface Entry {
  // 源地址
  readonly origin: string
  // 对应集成的 ID
  readonly integrationID: Integration.ID
  // 该源的清单内容
  readonly manifest: Manifest
}

// 定义服务接口：列出 / 快照 / 刷新 / 增删源 / 解析与读取配置
export interface Interface {
  // 返回当前全部条目（必要时触发加载）
  readonly entries: () => Effect.Effect<readonly Entry[], Error>
  // 同步返回当前内存缓存的条目快照（不发请求）
  readonly snapshot: () => readonly Entry[]
  // 刷新全部源，返回是否有变化
  readonly refresh: () => Effect.Effect<boolean, Error>
  // 注册一个新源并返回其条目
  readonly add: (origin: string) => Effect.Effect<Entry, Error>
  // 移除一个源
  readonly remove: (origin: string) => Effect.Effect<void>
  /** Resolves and caches the configuration for a registered source. */
  // 解析某个已注册源的配置并缓存结果
  readonly resolve: (entry: Entry, variables: Readonly<Record<string, string>>) => Effect.Effect<Config[], Error>
  /** Returns the last configuration resolved for an origin, kept until it is cleared or the source is removed. */
  readonly cached: (origin: string) => Effect.Effect<Config[]>
  /** Drops the last configuration resolved for an origin while keeping the source registered. */
  readonly clearCached: (origin: string) => Effect.Effect<void>
}

// 定义 Effect 服务（Service）标记类：以 "@opencode/WellKnown" 为标签，承载上面的 Interface
export class Service extends Context.Service<Service, Interface>()("@opencode/WellKnown") {}

// 定义事件集合：Updated 是一个"临时"（ephemeral，不落库）事件，通知各处 well-known 源已更新
export const Event = {
  // 发布时的负载为空对象，监听方收到后自行重新读取
  Updated: Bus.ephemeral({ type: "wellknown.updated", schema: {} }),
}

// 请求超时时长：15 秒（Effect 时长字符串）
const requestTimeout = "15 seconds"

// 定义 inspect 函数：抓取并校验某个源的 well-known 清单
export const inspect = Effect.fn("WellKnown.inspect")(function* (origin: string) {
  // 拼接清单 URL：去掉源地址末尾的斜杠后追加 /.well-known/opencode
  const url = `${origin.replace(/\/+$/, "")}/.well-known/opencode`
  // 从上下文取出 HTTP 客户端，并过滤掉非 2xx 状态（使其转为失败）
  const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
  // 发起 GET 请求并接受 JSON，随后把响应体按 Manifest 模式解析，限时 15 秒，失败时包装错误信息
  return yield* http.execute(HttpClientRequest.get(url).pipe(HttpClientRequest.acceptJson)).pipe(
    // 用 Manifest 模式解析 JSON 响应体
    Effect.flatMap(HttpClientResponse.schemaBodyJson(Manifest)),
    // 限制整个请求在 15 秒内完成
    Effect.timeout(requestTimeout),
    // 把任何失败映射为带 URL 上下文的 Error
    Effect.mapError((cause) => new Error(`Failed to load wellknown manifest from ${url}`, { cause })),
  )
})

// 定义 resolve 函数：抓取源清单并解析出其中的配置（供直接调用，不经服务缓存）
export const resolve = Effect.fn("WellKnown.resolve")(function* (input: ResolveInput) {
  // 先抓取该源的清单
  const manifest = yield* inspect(input.origin)
  // 构造条目（以源地址作为集成 ID）并解析配置，未传变量时用空对象
  return yield* resolveEntry(
    { origin: input.origin, integrationID: Integration.ID.make(input.origin.replace(/\/+$/, "")), manifest },
    input.variables ?? {},
  )
})

// 定义 resolveEntry：把清单中的内联配置与远程配置合并为最终配置数组
const resolveEntry = Effect.fnUntraced(function* (entry: Entry, variables: Readonly<Record<string, string>>) {
  // 内联配置存在则作为初始配置数组，否则为空
  const configs = entry.manifest.config ? [entry.manifest.config] : []
  // 没有远程配置时直接返回内联配置
  if (!entry.manifest.remote_config) return configs

  // 定义替换函数：把字符串里的 {env:NAME} 占位符换成变量表或进程环境变量中的值，找不到则替换为空串
  const substitute = (value: string) =>
    value.replace(/\{env:([^}]+)\}/g, (_, name: string) => variables[name] ?? process.env[name] ?? "")
  // 对远程配置 URL 做占位符替换
  const url = substitute(entry.manifest.remote_config.url)
  // 构造请求头：对每个头的值也做占位符替换
  const headers = Object.fromEntries(
    Object.entries(entry.manifest.remote_config.headers ?? {}).map(([key, value]) => [key, substitute(value)]),
  )
  // 取出 HTTP 客户端并过滤非 2xx 状态
  const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
  // 带 headers 请求远程配置端点，响应体按 Config 模式解析，限时 15 秒，失败时包装错误
  const remote = yield* http
    .execute(HttpClientRequest.get(url).pipe(HttpClientRequest.acceptJson, HttpClientRequest.setHeaders(headers)))
    .pipe(
      // 用 Config 模式解析响应体
      Effect.flatMap(HttpClientResponse.schemaBodyJson(Config)),
      // 限制请求时长为 15 秒
      Effect.timeout(requestTimeout),
      // 失败时包装为带 URL 的错误
      Effect.mapError((cause) => new Error(`Failed to load wellknown remote config from ${url}`, { cause })),
    )
  // 若响应对象里带 config 字段且符合 Config 结构，则使用该字段与内联配置合并
  if (Schema.is(Config)(remote.config)) return [...configs, remote.config]
  // 否则把整个响应对象视为配置，与内联配置合并返回
  return [...configs, remote]
})

// KV 中存储"已注册源地址列表"的键名
const sourcesKey = "wellknown:sources"
// 校验已注册源列表的模式：字符串数组
const Sources = Schema.Array(Schema.String)
// 生成某源清单在 KV 中的存储键
const manifestKey = (origin: string) => `wellknown:manifest:${origin}`
// 生成某源配置在 KV 中的存储键
const configKey = (origin: string) => `wellknown:config:${origin}`
// 校验缓存配置数组的模式
const Configs = Schema.Array(Config)

// 构建服务层（Layer）：创建 WellKnown 服务实例并注入依赖
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 取出 HTTP 客户端实例，供后续加载清单使用
    const http = yield* HttpClient.HttpClient
    // 取出键值存储服务
    const kv = yield* KV.Service
    // 取出事件总线服务
    const bus = yield* Bus.Service
    // 创建内存缓存：源地址 -> 条目 的可变引用
    const cache = yield* Ref.make(new Map<string, Entry>())
    // 创建信号量（Semaphore）锁，保证增删刷新等操作的互斥
    const lock = Semaphore.makeUnsafe(1)
    // 定义 loadEntry：从网络加载某源的清单并组装成条目
    const loadEntry = Effect.fn("WellKnown.loadEntry")(function* (origin: string) {
      // 抓取清单：注入上面取到的 http 客户端；成功时把清单写入 KV 备份
      const manifest = yield* inspect(origin).pipe(
        // 为本次请求注入具体的 HTTP 客户端
        Effect.provideService(HttpClient.HttpClient, http),
        // 成功拿到清单后，先将其持久化到 KV
        Effect.tap((manifest) => kv.set(manifestKey(origin), manifest)),
        // An unreachable source keeps its last manifest so its remote config still loads after a restart.
        // 失败时回退到 KV 中上一次成功的清单：源暂时不可达时，重启后远程配置仍可加载
        Effect.catch((error) =>
          kv
            .get(manifestKey(origin))
            .pipe(
              // 若 KV 中存在可校验的缓存清单
              Effect.flatMap((cached) =>
                Schema.is(Manifest)(cached)
                  // 记录警告日志并以缓存清单继续
                  ? Effect.logWarning("failed to load wellknown manifest", { origin, error }).pipe(Effect.as(cached))
                  // 无有效缓存则让原错误继续传播
                  : Effect.fail(error),
              ),
            ),
        ),
      )
      // 组装并返回条目（以源地址生成集成 ID）
      return { origin, integrationID: Integration.ID.make(origin), manifest }
    })

    // 定义 readOrigins：从 KV 读取已注册源地址列表，数据不合法时按空列表处理
    const readOrigins = kv.get(sourcesKey).pipe(Effect.map((value) => (Schema.is(Sources)(value) ? value : [])))

    // 定义 load：确保缓存中包含所有已注册源的条目（只加载缺失的）
    const load = Effect.fn("WellKnown.load")(function* () {
      // 读取源地址列表
      const origins = yield* readOrigins
      // 读取当前内存缓存
      const current = yield* Ref.get(cache)
      // 对每个源：内存里已有条目则直接复用，否则从网络加载
      const entries = yield* Effect.forEach(origins, (origin) => {
        // 命中缓存则跳过加载
        const cached = current.get(origin)
        if (cached) return Effect.succeed(cached)
        // 未命中则实际加载该源
        return loadEntry(origin)
      })
      // 用最新条目整体替换缓存
      yield* Ref.set(cache, new Map(entries.map((entry) => [entry.origin, entry])))
      // 返回全部条目
      return entries
    })

    // 定义 refresh：强制重新加载所有源，仅当内容有变化时发布更新事件
    const refresh = Effect.fn("WellKnown.refresh")(
      function* () {
        // 读取源地址列表
        const origins = yield* readOrigins
        // 没有注册任何源时返回"无变化"
        if (!origins.length) return false
        // 重新逐个加载条目
        const entries = yield* Effect.forEach(origins, loadEntry)
        // 构建新的映射
        const next = new Map(entries.map((entry) => [entry.origin, entry]))
        // 与旧缓存做深度比较，判断是否有变化
        const changed = !isDeepStrictEqual(Ref.getUnsafe(cache), next)
        // 无变化则直接返回 false
        if (!changed) return false
        // 有变化则替换缓存
        yield* Ref.set(cache, next)
        // 全局广播"源已更新"事件
        yield* bus.publish(Event.Updated, {}, { global: true })
        // 返回"有变化"
        return true
      },
      // 用信号量包裹，保证刷新操作的互斥执行
      (effect) => lock.withPermit(effect),
    )

    // 返回服务实现对象
    return Service.of({
      // entries：执行懒加载并返回全部条目
      entries: load,
      // snapshot：同步读取内存缓存中的条目数组
      snapshot: () => Array.from(Ref.getUnsafe(cache).values()),
      // refresh：暴露上面的刷新实现
      refresh,
      // add：注册新源（要求该源提供认证方式，否则失败）
      add: Effect.fn("WellKnown.add")(
        function* (value) {
          // 规范化源地址：去掉末尾斜杠
          const origin = value.replace(/\/+$/, "")
          // 加载该源的清单与条目
          const entry = yield* loadEntry(origin)
          // 清单中没有认证方式则视为不可注册，报错
          if (!entry.manifest.auth) return yield* Effect.fail(new Error(`No authentication method found at ${origin}`))
          // 读取现有源列表
          const origins = yield* readOrigins
          // 把新源并入列表（Set 去重）后写回 KV
          yield* kv.set(sourcesKey, Array.from(new Set([...origins, origin])))
          // 更新内存缓存：加入新条目
          yield* Ref.update(cache, (current) => new Map(current).set(origin, entry))
          // 全局广播更新事件
          yield* bus.publish(Event.Updated, {}, { global: true })
          // 返回新条目
          return entry
        },
        // 用信号量包裹，保证注册互斥
        (effect, _value) => lock.withPermit(effect),
      ),
      // remove：注销一个源并清理其全部持久化数据
      remove: Effect.fn("WellKnown.remove")(
        function* (value) {
          // 规范化源地址：去掉末尾斜杠
          const origin = value.replace(/\/+$/, "")
          // 读取现有源列表
          const origins = yield* readOrigins
          // 从源列表中过滤掉该源后写回 KV
          yield* kv.set(
            sourcesKey,
            origins.filter((item) => item !== origin),
          )
          // 删除该源在 KV 中的清单备份
          yield* kv.remove(manifestKey(origin))
          // 删除该源在 KV 中的配置缓存
          yield* kv.remove(configKey(origin))
          // 从内存缓存中移除该源条目
          yield* Ref.update(cache, (current) => {
            // 复制一份映射再删除，避免原地修改
            const next = new Map(current)
            next.delete(origin)
            return next
          })
          // 全局广播更新事件
          yield* bus.publish(Event.Updated, {}, { global: true })
        },
        // 用信号量包裹，保证移除互斥
        (effect, _value) => lock.withPermit(effect),
      ),
      // resolve：解析指定条目的配置并写入 KV 缓存
      resolve: Effect.fn("WellKnown.resolveEntry")(function* (entry, variables) {
        // 执行配置解析（注入 http 客户端）
        const configs = yield* resolveEntry(entry, variables).pipe(Effect.provideService(HttpClient.HttpClient, http))
        // 把解析结果持久化到 KV，供离线读取
        yield* kv.set(configKey(entry.origin), configs)
        // 返回配置数组
        return configs
      }),
      // cached：读取某源最后一次解析出的配置（无有效数据时返回空数组）
      cached: Effect.fn("WellKnown.cached")(function* (origin) {
        // 从 KV 读取缓存值
        const value = yield* kv.get(configKey(origin))
        // 校验为数组结构后返回副本，否则返回空数组
        return Schema.is(Configs)(value) ? [...value] : []
      }),
      clearCached: Effect.fn("WellKnown.clearCached")(function* (origin) {
        yield* kv.remove(configKey(origin))
      }),
    })
  }),
)

// 导出全局服务节点：把 WellKnown 服务注册为全局单例，依赖 HTTP 客户端、KV 与 Bus
export const node = makeGlobalNode({ service: Service, layer, deps: [httpClient, KV.node, Bus.node] })
