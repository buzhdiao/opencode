// 以命名空间形式导出 WebSearch 模块
export * as WebSearch from "./websearch.js"

// 引入 WebSearch schema
import { WebSearch } from "@opencode/schema/websearch"
// 仅引入会话类型（session ID）
import type { Session } from "@opencode/schema/session"
// 引入会话事件
import { SessionEvent } from "@opencode/schema/session-event"
// 引入 Effect 原语（含 Option）
import { Clock, Context, Effect, Layer, Option, Schema, Stream } from "effect"
// 引入 HTTP 错误工具（识别 429）
import { HttpClientError } from "effect/http"
// 引入位置级节点构造工具
import { makeLocationNode } from "@opencode/util/effect/app-node"
// 引入内部模块：事件总线
import { Bus } from "./bus.js"
// 引入 KV 存储
import { KV } from "./kv.js"
// 引入状态框架
import { State } from "./state.js"

// 重新导出 ID
export const ID = WebSearch.ID
export type ID = WebSearch.ID

// 重新导出提供方类型
export const Provider = WebSearch.Provider
export type Provider = WebSearch.Provider

// 重新导出事件
export { Event } from "@opencode/schema/websearch"

// 重新导出输入类型
export const Input = WebSearch.Input
export type Input = WebSearch.Input
export type ProviderInput = WebSearch.ProviderInput

// 重新导出结果类型
export const Result = WebSearch.Result
export type Result = WebSearch.Result

// 重新导出响应类型
export const Response = WebSearch.Response
export type Response = WebSearch.Response

// KV 中保存默认提供方选择的键
export const ProviderKey = "websearch:provider"
// 选择 schema：具体 ID / 随机（random）/ 关闭（false）
export const Selection = Schema.Union([ID, Schema.Literal("random"), Schema.Literal(false)])
export type Selection = typeof Selection.Type

// 提供方实现：在描述之上附加执行函数
export interface ProviderImplementation extends Provider {
  readonly execute: (input: ProviderInput) => Effect.Effect<readonly Result[], unknown>
}

// 未选择提供方错误
export class ProviderRequiredError extends Schema.TaggedError<ProviderRequiredError>()(
  "WebSearch.ProviderRequired",
  {},
) {}

// 提供方不存在错误
export class ProviderNotFoundError extends Schema.TaggedError<ProviderNotFoundError>()("WebSearch.ProviderNotFound", {
  providerID: ID,
}) {}

// 功能被禁用错误
export class DisabledError extends Schema.TaggedError<DisabledError>()("WebSearch.Disabled", {}) {}

// 请求失败错误（带根因）
export class RequestError extends Schema.TaggedError<RequestError>()("WebSearch.Request", {
  providerID: ID,
  cause: Schema.Defect(),
}) {}

// 错误联合类型
export type Error = ProviderRequiredError | ProviderNotFoundError | DisabledError | RequestError

// 服务接口（含状态变换能力）
export interface Interface extends State.Transformable<Editor> {
  // 列出已注册提供方
  readonly providers: () => Effect.Effect<readonly Provider[]>
  // 当前默认提供方（禁用时报 DisabledError）
  readonly default: () => Effect.Effect<Provider | undefined, DisabledError>
  // 保存默认选择
  readonly select: (selection: Selection) => Effect.Effect<void>
  // 执行搜索查询
  readonly query: (
    input: Input,
    options?: {
      readonly sessionID?: Session.ID
      readonly onProvider?: (provider: Provider) => Effect.Effect<void>
    },
  ) => Effect.Effect<Response, Error>
}

// 定义 WebSearch 服务标记类
export class Service extends Context.Service<Service, Interface>()("@opencode/WebSearch") {}

// 领域状态：提供方表与选择
type Data = {
  readonly providers: Map<ID, ProviderImplementation>
  selection?: Selection
}

// 状态编辑器：增删与默认选择读写
export type Editor = {
  add: (provider: ProviderImplementation) => void
  list: () => readonly ProviderImplementation[]
  remove: (id: ID) => void
  default: {
    get: () => Selection | undefined
    set: (selection: Selection) => void
  }
}

// 构建服务层
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 获取事件总线
    const bus = yield* Bus.Service
    // 获取 KV 存储
    const kv = yield* KV.Service
    // 结果数组的解码器
    const decodeResults = Schema.decodeUnknownEffect(Schema.Array(Result))
    // 各提供方的冷却状态（限流后暂避一段时间）
    const cooldowns = new Map<ID, { until: number; error: RequestError }>()
    // 会话 -> 偏好提供方（随机模式的亲和性；undefined 键用于无会话场景）
    const preferred = new Map<Session.ID | undefined, { provider?: ID }>()
    // 注册终结器：层关闭时清空偏好表
    yield* Effect.addFinalizer(() => Effect.sync(() => preferred.clear()))
    // 订阅会话删除/移动事件，清理对应偏好
    yield* bus.subscribe([SessionEvent.Deleted, SessionEvent.Moved]).pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          preferred.delete(event.data.sessionID)
        }),
      ),
      // 立即启动并随作用域终止
      Effect.forkScoped({ startImmediately: true }),
    )
    // 把提供方映射转成按名称排序的摘要列表
    const providers = (data: Data) =>
      Array.from(data.providers.values(), (provider) => ({
        id: provider.id,
        name: provider.name,
      })).toSorted((a, b) => a.name.localeCompare(b.name))

    // 创建提供方注册状态；变化时发布 Updated 事件
    const state = State.create<Data, Editor>({
      // 初始为空表
      initial: () => ({ providers: new Map() }),
      editor: (editor) => ({
        // 注册提供方
        add: (provider) => editor.providers.set(provider.id, provider),
        // 列出实现
        list: () => Array.from(editor.providers.values()),
        // 注销提供方
        remove: (id) => editor.providers.delete(id),
        // 默认选择读写
        default: {
          get: () => editor.selection,
          set: (selection) => (editor.selection = selection),
        },
      }),
      // 序列化投影去重后发布更新事件
      notify: State.changes(providers, () => bus.publish(WebSearch.Event.Updated, {}).pipe(Effect.asVoid)),
    })

    // 按 ID 取提供方，否则报“不存在”
    const requireProvider = (providers: Map<ID, ProviderImplementation>, providerID: ID) => {
      // 查表
      const provider = providers.get(providerID)
      return provider ? Effect.succeed(provider) : Effect.fail(new ProviderNotFoundError({ providerID }))
    }

    // 解析当前选择：内存中的显式选择优先；否则读 KV（非法存量值会被清理）
    const selection = Effect.fn("WebSearch.selection")(function* () {
      // 读取状态
      const data = state.get()
      // 显式选择有效（关闭/随机/已注册 ID）时直接使用
      if (
        data.selection === false ||
        data.selection === "random" ||
        (data.selection && data.providers.has(data.selection))
      )
        return data.selection
      // 读取持久化的选择
      const stored = yield* kv.get(ProviderKey)
      // 校验存量值
      const decoded = Schema.decodeUnknownOption(Selection)(stored)
      // 存量值非法且非空时移除
      if (stored !== undefined && Option.isNone(decoded)) yield* kv.remove(ProviderKey)
      // 返回解析结果（可能 undefined）
      return Option.getOrUndefined(decoded)
    })

    // （中文）随机挑一个可用提供方（考虑冷却与已尝试集合），并写入亲和性
    const randomProvider = (now: number, affinity: { provider?: ID }, attempted?: Set<ID>) => {
      // 当前提供方表
      const providers = state.get().providers
      // 先清理已过期或已注销的冷却
      cooldowns.forEach((cooldown, id) => {
        if (cooldown.until <= now || !providers.has(id)) cooldowns.delete(id)
      })
      // 偏好的提供方仍可用则优先
      const current = affinity.provider === undefined ? undefined : providers.get(affinity.provider)
      if (current && !cooldowns.has(current.id) && !attempted?.has(current.id)) return current
      // 否则从可用集合中随机挑
      const available = Array.from(providers.values()).filter(
        (provider) => !cooldowns.has(provider.id) && !attempted?.has(provider.id),
      )
      const provider = available[Math.floor(Math.random() * available.length)]
      // 记住选择以保持会话亲和
      if (provider) affinity.provider = provider.id
      return provider
    }

    // 根据选择解析提供方实例
    const defaultProvider = Effect.fn("WebSearch.default")(function* (choice: Selection | undefined) {
      // 关闭则报 DisabledError
      if (choice === false) return yield* new DisabledError()
      if (choice === "random") {
        // Inspection must not select a provider or reopen consent when every provider is cooling down.
        // （中文）检查类用途不得借此选定提供方或重新触发同意：全体冷却时沿用无会话偏好或注册顺序第一个
        const active = preferred.get(undefined)?.provider
        return (
          (active === undefined ? undefined : state.get().providers.get(active)) ??
          state.get().providers.values().next().value
        )
      }
      // 指定 ID 时查表
      return choice ? state.get().providers.get(choice) : undefined
    })

    // 组装服务实现
    return Service.of({
      transform: state.transform,
      reload: state.reload,
      // 列出提供方摘要
      providers: Effect.fn("WebSearch.providers")(function* () {
        return providers(state.get())
      }),
      // 查询当前默认提供方
      default: Effect.fn("WebSearch.defaultInfo")(function* () {
        // 先解析选择再解析提供方
        const provider = yield* defaultProvider(yield* selection())
        return provider && { id: provider.id, name: provider.name }
      }),
      // 保存选择到 KV
      select: Effect.fn("WebSearch.select")(function* (selection) {
        yield* kv.set(ProviderKey, selection)
      }),
      // （中文）执行查询（含随机选择与 429 冷却重试逻辑）
      query: Effect.fn("WebSearch.query")(function* (input, options) {
        // 显式指定提供方时无需解析选择
        const choice = input.providerID ? undefined : yield* selection()
        // 解析初始提供方：显式 ID 优先，否则按默认选择
        let provider = input.providerID
          ? yield* requireProvider(state.get().providers, input.providerID)
          : yield* defaultProvider(choice)
        // 无可用提供方报错
        if (!provider) return yield* new ProviderRequiredError()
        // Keep the cell for this query so deletion/movement cannot reinsert an in-flight session's entry.
        // （中文）为本次查询保留偏好槽位，这样会话删除/移动不会重新插入进行中会话的条目
        const affinity = preferred.get(options?.sessionID) ?? { provider: undefined }
        // 随机模式下登记偏好并随机选择
        if (choice === "random") {
          preferred.set(options?.sessionID, affinity)
          provider = randomProvider(yield* Clock.currentTimeMillis, affinity) ?? provider
        }
        // 已尝试集合，避免重复撞同一个 429 的提供方
        const attempted = new Set<ID>()
        // 重试循环
        while (true) {
          // 通知调用方本次使用的提供方
          if (options?.onProvider) yield* options.onProvider({ id: provider.id, name: provider.name })
          // 仅随机模式查看冷却
          let cooldown = choice === "random" ? cooldowns.get(provider.id) : undefined
          // 无冷却或冷却已过期才尝试
          if (!cooldown || cooldown.until <= (yield* Clock.currentTimeMillis)) {
            // 记入已尝试
            attempted.add(provider.id)
            // 执行搜索并解码结果（捕获为结果而非直接失败）
            const result = yield* provider
              .execute({ query: input.query })
              .pipe(Effect.flatMap(decodeResults), Effect.result)
            // 成功即返回响应
            if (result._tag === "Success") return new Response({ providerID: provider.id, results: result.success })
            // 失败构造请求错误
            const cause = result.failure
            const error = new RequestError({ providerID: provider.id, cause })
            // 非随机模式、非 HTTP 错误或非 429：直接失败
            if (choice !== "random" || !HttpClientError.isHttpClientError(cause) || cause.response?.status !== 429)
              return yield* error
            // 429：登记冷却（依据 Retry-After 头计算时长）
            const now = yield* Clock.currentTimeMillis
            cooldown = { until: now + cooldownMillis(cause.response.headers["retry-after"], now), error }
            cooldowns.set(provider.id, cooldown)
          }
          // 换一个未尝试且未冷却的提供方
          provider = randomProvider(yield* Clock.currentTimeMillis, affinity, attempted)
          // 全部尝试完则返回最后一次冷却对应的错误
          if (!provider) return yield* cooldown.error
        }
      }),
    })
  }),
)

// （中文）由 Retry-After 头计算冷却毫秒数（缺省 60 秒）
function cooldownMillis(value: string | undefined, now: number) {
  // 空值按 60 秒
  if (!value?.trim()) return 60_000
  // 先按秒数解析
  const seconds = Number(value)
  // 非负秒数换算为毫秒；负数按 60 秒
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : 60_000
  // 再按 HTTP 日期解析，取距今的毫秒数（不小于 0）
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - now) : 60_000
}

// 导出位置级服务节点
export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Bus.node, KV.node],
})
