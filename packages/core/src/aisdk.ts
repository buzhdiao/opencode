// 将本模块以命名空间 AISDK 的形式整体导出，外部通过 `AISDK.xxx` 访问
export * as AISDK from "./aisdk.js"

// 导入“位置节点”工厂：把服务与实现层打包成可被应用装配树引用的节点
import { makeLocationNode } from "@opencode/util/effect/app-node"
// 导入平台层的 HTTP fetch 依赖节点（作为默认出站请求实现）
import { httpFetch } from "@opencode/util/effect/app-node-platform"
// 导入 AI SDK 的 APICallError：用于识别提供方 API 错误
import { APICallError } from "@ai-sdk/provider"
// 导入 AI SDK 提供者侧的类型：JSON Schema、语言模型 V3 的消息/流部件/调用参数等
import type {
  JSONSchema7,
  JSONValue,
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3FinishReason,
  LanguageModelV3FunctionTool,
  LanguageModelV3Message,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
  LanguageModelV3ToolChoice,
  SharedV3ProviderOptions,
} from "@ai-sdk/provider"
// 导入本仓库统一的大模型（LLM）抽象：事件、错误、语言模型、提供者标识、传输错误、工具结果等
import {
  FinishReason,
  LLMEvent,
  AIError,
  LanguageModel,
  ProviderID,
  ProviderMetadata,
  TransportError,
  ToolResultValue,
  type ContentPart,
  type LLMRequest,
  type Media,
  type ToolDefinition,
  type ToolMessage,
  type UsageInput,
} from "@opencode/ai/effect"
// 导入路由层：认证、端点、共享工具、请求执行器与路由/中间件类型
import { Auth, Endpoint, ProviderShared, RequestExecutor, type AnyRoute, type HttpMiddleware } from "@opencode/ai/route"
// 导入“是否为普通对象”的类型守卫
import { isRecord } from "@opencode/util/record"
// 导入 Effect 核心：Cause、Context、Effect、Layer、Option、Schema、Scope、Stream、Struct
import { Cause, Context, Effect, Layer, Option, Schema, Scope, Stream, Struct } from "effect"
// 导入 SSE 解析器工厂（流式解析 server-sent events）
import { makeParser } from "effect/encoding/Sse"
// 导入 Effect 的 HTTP 客户端：默认出站 fetch、请求/响应的 Web 转换
import { FetchHttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
// 导入异步本地存储：把当前 HTTP 中间件挂在异步上下文中传递
import { AsyncLocalStorage } from "node:async_hooks"
// 导入模型的 ID 与运行时信息类型
import type { ID, RuntimeInfo } from "./model.js"
// 导入 Provider 模块：包名归一化、设置归一化、超时解析等
import { Provider } from "./provider.js"
// 导入有状态服务封装（State）
import { State } from "./state.js"
// 导入工具结果的稳定字符串化函数
import { stringify } from "./tool/runtime.js"

// SDK 实例类型（任意 AI SDK 提供者对象）
type SDK = any
// 用户消息内容类型
type UserContent = Extract<LanguageModelV3Message, { role: "user" }>["content"]
// 助手消息内容类型
type AssistantContent = Extract<LanguageModelV3Message, { role: "assistant" }>["content"]
// 助手消息中的工具结果部件类型
type ToolResultContent = Extract<AssistantContent[number], { type: "tool-result" }>

// 解码“JSON 字符串 → 字符串键 JSON 记录”的校验器（用于合并字符串请求体）
const decodeJsonRecord = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)))

// SDK 级事件：让插件在创建 AI SDK 提供者实例前查看/修改选项
export interface SDKEvent {
  readonly model: RuntimeInfo
  readonly package: string
  readonly options: Record<string, unknown>
  // 钩子可以回填的 SDK 实例
  sdk?: SDK
}

// 语言模型级事件：让插件基于 SDK 产出（或替换）语言模型
export interface LanguageEvent {
  readonly model: RuntimeInfo
  readonly sdk: SDK
  readonly options: Record<string, unknown>
  // 钩子可以回填的语言模型实例
  language?: LanguageModelV3
}

// 为 SSE 响应包一层“按事件续期”的读取超时：每收到一个完整事件就重置最后期限
function wrapSSE(res: Response, ms: number, ctl: AbortController) {
  // 未配置或非正数超时不包装
  if (typeof ms !== "number" || ms <= 0) return res
  // 无响应体时不包装
  if (!res.body) return res
  // 非 text/event-stream 响应不做分块超时
  if (!res.headers.get("content-type")?.includes("text/event-stream")) return res

  // 底层流的读取器
  const reader = res.body.getReader()
  // 流式字节解码器
  const decoder = new TextDecoder()
  // 当前读取的最后期限（毫秒时间戳），初始未设置
  let deadline: number | undefined
  // SSE 解析器：每解析出一个完整事件就续期 deadline
  const parser = makeParser((event) => {
    if (event._tag === "Event") deadline = Date.now() + ms
  })
  // 重新包装的响应体流：在 pull 中施加“事件间隔”超时
  const body = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      // 计算本次读取的期限（无历史则按当前时间起算）
      const expires = deadline ?? Date.now() + ms
      deadline = expires
      // 读一块数据：在剩余时间内未到达则判超时
      const part = await new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
        const remaining = Math.max(0, expires - Date.now())
        // 超时定时器：触发时中止请求控制器并取消底层读取，然后拒绝
        const id = setTimeout(() => {
          const err = new Error("SSE read timed out")
          ctl.abort(err)
          void reader.cancel(err)
          reject(err)
        }, remaining)

        // 正常读取完成：清掉定时器并 resolve
        reader.read().then(
          (part) => {
            clearTimeout(id)
            resolve(part)
          },
          (err) => {
            clearTimeout(id)
            reject(err)
          },
        )
      })

      // 流结束：关闭包装流
      if (part.done) {
        ctrl.close()
        return
      }

      // 把数据喂给解析器（用于续期判断），同时原样转发给下游
      parser.feed(decoder.decode(part.value, { stream: true }))
      ctrl.enqueue(part.value)
    },
    // 下游取消：中止外部控制器并取消底层读取
    async cancel(reason) {
      ctl.abort(reason)
      await reader.cancel(reason)
    },
  })

  // 用包装后的流重建响应（保留原状态与头）
  return new Response(body, {
    headers: new Headers(res.headers),
    status: res.status,
    statusText: res.statusText,
  })
}

// `outbound` sends requests for providers whose settings name no `fetch` of their own.
// （outbound 用于设置里没有自带 fetch 的提供者：为其组装 SDK 选项并注入自定义 fetch）
function prepareOptions(model: RuntimeInfo, pkg: string, outbound: Fetch) {
  // 把模型级配置投影为提供者选项（含 forceReasoning 等规范化）
  const projected = mapBodyToProviderOptions(model, pkg)
  const settings = model.settings ?? {}
  // 组装 SDK 构造选项：名称、原生设置、请求头、请求体
  const options: Record<string, unknown> = {
    name: model.canonical ?? model.providerID,
    ...Provider.nativeSettings(settings),
    headers: model.headers,
    body: projected.body,
  }

  // 用户自带的 fetch（存在则覆盖默认出站实现）
  const customFetch = settings.fetch
  // 解析各档超时配置
  const timeouts = Provider.timeouts(settings)
  // 注入自定义 fetch：包装出站请求，叠加中止信号、请求体合并与超时
  options.fetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    // 复制一份请求初始化参数（避免改动调用方对象）
    const opts = { ...(init ?? {}) }
    // A plain AbortSignal.timeout would keep running into the body stream, so the header limit uses
    // a timer that is cleared once headers arrive. The whole-request limit is meant to span the body.
    // （响应头阶段的超时用可清除的计时器实现，避免波及后续 body 流；整请求级别的超时才覆盖 body 阶段）
    const headers = new AbortController()
    // 头部超时计时器：设为 false 表示禁用
    const headerTimer =
      timeouts.headerTimeout === false
        ? undefined
        : setTimeout(() => headers.abort(new Error(HEADER_TIMEOUT_MESSAGE)), timeouts.headerTimeout)
    // 分块（chunk）超时的中止控制器
    const chunks = new AbortController()
    // 合并所有中止信号：外部传入 + 头部超时 + 分块超时 + 整请求超时
    opts.signal = AbortSignal.any(
      [
        opts.signal,
        headers.signal,
        chunks.signal,
        timeouts.timeout ? AbortSignal.timeout(timeouts.timeout) : undefined,
      ].filter((item): item is AbortSignal => item !== undefined && item !== null),
    )

    // 请求体为字符串且配置了模型级 body 时：解析后按提供者叠加规则合并
    if (typeof opts.body === "string" && model.body !== undefined) {
      const decoded = Option.getOrUndefined(decodeJsonRecord(opts.body))
      if (decoded) {
        opts.body = JSON.stringify(Provider.mergeOverlay(decoded, model.body))
      }
    }

    // 实际发送函数：用户自带 fetch 优先，否则用默认出站
    const send: Fetch = isFetch(customFetch) ? customFetch : outbound
    // 异步上下文中存在 HTTP 中间件则经其发送，否则直连；无论成败都清除头部计时器
    const middleware = httpMiddleware.getStore()
    const res = await (
      middleware
        ? throughMiddleware(middleware, send, input, { ...opts, timeout: false })
        : send(input, { ...opts, timeout: false })
    ).finally(() => clearTimeout(headerTimer))
    // 分块超时禁用时直接返回原始响应
    if (timeouts.chunkTimeout === false) return res
    // 否则为 SSE 响应包上按事件续期的分块超时
    return wrapSSE(res, timeouts.chunkTimeout, chunks)
  }

  return options
}

// 出站 fetch 的函数签名
type Fetch = (input: Parameters<typeof fetch>[0], init?: BunFetchRequestInit) => Promise<Response>

// 判断某值是否是可调用的 fetch 函数
const isFetch = (value: unknown): value is Fetch => typeof value === "function"

// HTTP hook middleware is scoped to one model request, but the SDK's fetch is baked into the
// cached language model, so the active middleware rides along in async context instead.
// （HTTP 钩子中间件本应作用于单次模型请求，但 SDK 的 fetch 被固化在缓存的语言模型里，
// 因此把当前中间件放进异步上下文（AsyncLocalStorage）随调用链传递）
const httpMiddleware = new AsyncLocalStorage<{ http: HttpMiddleware; context: Context.Context<never> }>()

// 经由 Effect 语义把一次 fetch 送入 HTTP 中间件链，并把响应还原为 Web Response
function throughMiddleware(
  store: { http: HttpMiddleware; context: Context.Context<never> },
  send: Fetch,
  input: Parameters<typeof fetch>[0],
  init: BunFetchRequestInit,
) {
  // 把任意抛出的值规范化为 Error
  const toError = (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause)))
  // 构造 Web Request（合并 URL 与初始化参数）
  const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init)
  // 在中间件携带的上下文中运行 Effect，并透传外部中止信号
  return Effect.runPromiseWith(store.context)(
    Effect.gen(function* () {
      // Hooks see a byte body like on the native route, so they may convert it to a web Request
      // as many times as they like without contending for one stream.
      // （钩子看到的是字节形式的 body，与原生路由一致：它们可以反复构造 Web Request 而不必争抢同一个流）
      const body = request.body ? new Uint8Array(yield* Effect.promise(() => request.arrayBuffer())) : undefined
      // 以字节 body 交给中间件；回调里把中间件改写后的请求真正发出去
      const response = yield* store.http(
        body
          ? HttpClientRequest.bodyUint8Array(
              HttpClientRequest.fromWeb(request),
              body,
              request.headers.get("content-type") ?? undefined,
            )
          : HttpClientRequest.fromWeb(request),
        (sent) =>
          Effect.gen(function* () {
            // 把中间件处理后的请求转回 Web 形态
            const web = yield* HttpClientRequest.toWeb(sent)
            // 用底层 send 发送（body 读为字节）
            const response = yield* Effect.tryPromise(async () =>
              send(web.url, {
                ...init,
                method: web.method,
                headers: web.headers,
                body: web.body ? await web.arrayBuffer() : undefined,
              }),
            )
            // 还原为 Effect 的 HttpClientResponse
            return HttpClientResponse.fromWeb(sent, response)
          }).pipe(Effect.mapError(toError)),
      )
      // 204/205/304 无响应体；其余把 Effect 流转成 Web 可读流
      const stream = [204, 205, 304].includes(response.status)
        ? null
        : yield* Stream.toReadableStreamEffect(response.stream)
      // 重建 Web Response 返回给调用方
      return new Response(stream, { status: response.status, headers: response.headers })
    }),
    { signal: init.signal ?? undefined },
  )
}

// 头部超时的统一错误文案
const HEADER_TIMEOUT_MESSAGE = "Response headers timed out"

// 初始化错误：AI SDK 包初始化失败（携带提供者 ID 与根因）
export class InitError extends Schema.TaggedError<InitError>()("AISDK.InitError", {
  providerID: Provider.ID,
  cause: Schema.Defect(),
}) {}

// 把底层失败统一包装为 InitError（便于按提供者上报）
function initError(providerID: Provider.ID) {
  return Effect.catchCause((cause) => Effect.fail(new InitError({ providerID, cause: Cause.squash(cause) })))
}

// 服务接口：钩子注册、钩子运行、语言模型获取与统一模型包装
export interface Interface {
  readonly hook: {
    // 注册 SDK 级钩子（随 Scope 关闭自动注销）
    readonly sdk: (
      callback: (event: SDKEvent) => Effect.Effect<void> | void,
    ) => Effect.Effect<State.Registration, never, Scope.Scope>
    // 注册语言模型级钩子
    readonly language: (
      callback: (event: LanguageEvent) => Effect.Effect<void> | void,
    ) => Effect.Effect<State.Registration, never, Scope.Scope>
  }
  // 运行全部 SDK 钩子
  readonly runSDK: (event: SDKEvent) => Effect.Effect<SDKEvent>
  // 运行全部语言模型钩子
  readonly runLanguage: (event: LanguageEvent) => Effect.Effect<LanguageEvent>
  // 获取（或构建并缓存）AI SDK 语言模型实例
  readonly language: (model: RuntimeInfo) => Effect.Effect<LanguageModelV3, InitError>
  // 把 AI SDK 语言模型包装成本仓库统一的 LanguageModel
  readonly model: (model: RuntimeInfo) => Effect.Effect<LanguageModel, InitError>
}

// 定义服务标识（Effect 依赖注入的 Tag）
export class Service extends Context.Service<Service, Interface>()("@opencode/AISDK") {}

// 服务实现层：维护 SDK/语言模型缓存、钩子注册与运行
export const locationLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 默认出站 fetch（Effect 的 HTTP 客户端）
    const outbound = yield* FetchHttpClient.Fetch
    // SDK 级钩子列表（注册/注销时整体替换）
    let sdkHooks: ((event: SDKEvent) => Effect.Effect<void> | void)[] = []
    // 语言模型级钩子列表
    let languageHooks: ((event: LanguageEvent) => Effect.Effect<void> | void)[] = []
    // 语言模型缓存：键为序列化后的配置
    const languages = new Map<string, LanguageModelV3>()
    // SDK 实例缓存
    const sdks = new Map<string, SDK>()
    // 函数 → 自增 ID 的弱映射：让含函数的对象可被稳定序列化
    const functionIDs = new WeakMap<object, number>()
    // 下一个可分配的函数 ID
    let nextFunctionID = 0
    // 缓存键：把输入 JSON 序列化，函数值替换为占位符 `function:<id>`（同一函数引用得到同一 ID）
    const cacheKey = (input: unknown) =>
      JSON.stringify(input, (_key, value: unknown) => {
        if (typeof value !== "function") return value
        const existing = functionIDs.get(value)
        if (existing !== undefined) return `function:${existing}`
        const id = nextFunctionID++
        functionIDs.set(value, id)
        return `function:${id}`
      }) ?? ""

    // 通用钩子注册：把回调加入列表，并在当前 Scope 关闭时自动移除
    const register = <Event>(
      hooks: () => ((event: Event) => Effect.Effect<void> | void)[],
      update: (hooks: ((event: Event) => Effect.Effect<void> | void)[]) => void,
    ) =>
      Effect.fn("AISDK.hook")(function* (callback: (event: Event) => Effect.Effect<void> | void) {
        // 拿到当前作用域（Scope）
        const scope = yield* Scope.Scope
        // 防重复清理的标志
        let active = true
        // 追加回调
        update([...hooks(), callback])
        // 清理动作：只执行一次
        const dispose = Effect.sync(() => {
          if (!active) return
          active = false
          update(hooks().filter((item) => item !== callback))
        })
        // 注册为作用域的 finalizer
        yield* Scope.addFinalizer(scope, dispose)
        return { dispose }
      })

    // 运行钩子链：同步回调直接调用，返回 Effect 的依序执行；最后原样返回事件
    const run = Effect.fnUntraced(function* <Event>(
      hooks: readonly ((event: Event) => Effect.Effect<void> | void)[],
      event: Event,
    ) {
      for (const hook of hooks) {
        const result = hook(event)
        if (Effect.isEffect(result)) yield* result
      }
      return event
    })

    // 组装服务
    const service = Service.of({
      // 钩子注册入口：SDK 级与语言模型级
      hook: {
        sdk: register(
          () => sdkHooks,
          (next) => (sdkHooks = next),
        ),
        language: register(
          () => languageHooks,
          (next) => (languageHooks = next),
        ),
      },
      // 运行 SDK 钩子
      runSDK: (event) => run(sdkHooks, event),
      // 运行语言模型钩子
      runLanguage: (event) => run(languageHooks, event),
      // language：按模型配置取（或构建并缓存）AI SDK 语言模型实例
      language: Effect.fn("AISDK.language")(function* (model) {
        // 计算模型级缓存键（覆盖全部影响行为的配置）
        const key = cacheKey({
          providerID: model.providerID,
          canonical: model.canonical,
          id: model.id,
          modelID: model.modelID,
          package: model.package,
          settings: model.settings,
          headers: model.headers,
          body: model.body,
          limit: model.limit,
        })
        // 命中缓存直接返回
        const existing = languages.get(key)
        if (existing) return existing
        // 非 AI SDK 包直接报初始化错误
        if (!Provider.isAISDK(model.package))
          return yield* new InitError({
            providerID: model.providerID,
            cause: new Error(`Unsupported package ${model.package}`),
          })

        // 归一化包名
        const packageName = Provider.packageName(model.package)
        // 组装 SDK 选项（含自定义 fetch 与超时）
        const options = prepareOptions(model, packageName, outbound)
        // SDK 级缓存键（不含模型 ID / limit 等模型级字段）
        const sdkKey = cacheKey({
          providerID: model.providerID,
          canonical: model.canonical,
          package: packageName,
          settings: model.settings,
          headers: model.headers,
          body: model.body,
        })
        // 取缓存中的 SDK，或先跑 SDK 钩子让插件生成
        const sdk =
          sdks.get(sdkKey) ??
          (yield* service.runSDK({ model, package: packageName, options }).pipe(initError(model.providerID))).sdk
        // 没有任何插件返回 SDK 则报错
        if (!sdk)
          return yield* new InitError({
            providerID: model.providerID,
            cause: new Error("No AISDK provider plugin returned an SDK"),
          })
        // 缓存 SDK
        sdks.set(sdkKey, sdk)
        // 跑语言模型钩子，让钩子产出或调整语言模型
        const result = yield* service.runLanguage({ model, sdk, options }).pipe(initError(model.providerID))
        // 钩子未给出 language 时用 SDK 默认的 languageModel 工厂
        const language = yield* Effect.sync(() => result.language ?? sdk.languageModel(model.modelID ?? model.id)).pipe(
          initError(model.providerID),
        )
        // 缓存并返回
        languages.set(key, language)
        return language
      }),
      // model：把 AI SDK 语言模型包装成本仓库统一的 LanguageModel
      model: Effect.fn("AISDK.model")(function* (model) {
        return modelFromLanguage(model, yield* service.language(model))
      }),
    })
    return service
  }),
)

// 把 AI SDK 的 LanguageModelV3 适配为本仓库统一的 LanguageModel（含路由与默认请求参数）
function modelFromLanguage(info: RuntimeInfo, language: LanguageModelV3) {
  // 归一化包名（package 在此处必然存在）
  const packageName = Provider.packageName(info.package!)
  // 把模型级配置投影为提供者选项
  const projected = mapBodyToProviderOptions(info, packageName)
  // 提供者标识：优先规范名
  const providerID = info.canonical ?? info.providerID
  // 计算提供者选项键（providerOptions 的命名空间）
  const optionKey = providerOptionKey(packageName, providerID)
  // 构造 AI SDK 协议的路由描述
  const route: AnyRoute = {
    compact: undefined,
    id: `ai-sdk:${packageName}`,
    provider: ProviderID.make(providerID),
    providerMetadataKey: optionKey,
    protocol: "ai-sdk",
    // AI SDK providers convert tool schemas themselves, so model-family sanitizers stay off here.
    // （AI SDK 提供者自行转换工具 schema，因此这里关闭模型族清洗器）
    sanitizer: "none",
    endpoint: Endpoint.path("/", { baseURL: "https://ai-sdk.local" }),
    auth: Auth.none,
    // 传输层为空实现：实际发送由 streamPrepared 直接驱动 AI SDK
    transport: {
      id: "ai-sdk",
      prepare: (input) => Effect.succeed(input.body),
      execute: () => Effect.succeed({ frames: Stream.empty }),
    },
    // 默认参数：请求头、模型级 body、提供者设置
    defaults: {
      headers: info.headers,
      http: projected.body === undefined ? undefined : { body: { ...projected.body } },
      providerOptions: projected.settings,
    },
    // 请求体转换：LLMRequest → AI SDK 调用参数
    body: {
      schema: Schema.Unknown,
      from: (request) =>
        Effect.try({
          try: () => callOptions(request, packageName, info.modelID ?? info.id, optionKey),
          catch: (cause) =>
            cause instanceof AIError ? cause : ProviderShared.invalidRequest("Invalid AI SDK request", cause),
        }),
    },
    // 路由复用：返回自身
    with: () => route,
    // 用给定输入构造模型；未显式指定提供者时带上本路由的提供者
    model: (input) =>
      LanguageModel.make({ ...input, provider: "provider" in input ? input.provider : providerID, route }),
    // 传输准备直通
    prepareTransport: (body) => Effect.succeed(body),
    // 实际流式执行：直接驱动 AI SDK 语言模型
    streamPrepared: (prepared, _request, _runtime, options) =>
      streamLanguage(language, prepared as LanguageModelV3CallOptions, options?.http),
  }
  // 产出统一的 LanguageModel 实例
  return LanguageModel.make({
    id: info.modelID ?? info.id,
    provider: providerID,
    route,
    compatibility: info.compatibility,
  })
}

// 为 Vercel AI 网关整理 providerOptions：gateway 子配置与模型级键拆分/合并到对应命名空间
function gatewayProviderOptions(modelID: ID, settings: Readonly<Record<string, JSONValue>>) {
  // 取出 gateway 子配置
  const gateway = isRecord(settings.gateway) ? { ...settings.gateway } : undefined
  // 其余键作为模型级配置
  const model = Object.fromEntries(Object.entries(settings).filter(([key]) => key !== "gateway"))
  // 没有模型级配置：只保留 gateway（可能整体为 undefined）
  if (Object.keys(model).length === 0) return gateway === undefined ? undefined : { gateway }

  // 模型 ID 形如 "prefix/model" 时，把模型级配置挂到对应前缀（amazon 映射为 bedrock）
  const separator = modelID.indexOf("/")
  const prefix = separator > 0 ? modelID.slice(0, separator) : undefined
  if (prefix)
    return { ...(gateway === undefined ? {} : { gateway }), [prefix === "amazon" ? "bedrock" : prefix]: model }
  // 无前缀但有 gateway：把模型级配置并入 gateway
  if (gateway !== undefined) return { gateway: { ...gateway, ...model } }
  // 只有模型级配置：整体作为 gateway
  return { gateway: model }
}

// 计算提供者选项键（providerOptions 的命名空间）：按包名映射，特殊包用专属短名
function providerOptionKey(packageName: string | undefined, providerID: Provider.ID) {
  if (packageName === "@ai-sdk/google") return "google"
  if (packageName === "@ai-sdk/google-vertex") return "vertex"
  if (packageName === "@ai-sdk/google-vertex/anthropic") return "anthropic"
  if (packageName === "@ai-sdk/amazon-bedrock") return "bedrock"
  // Mantle 走 openai 兼容形态
  if (packageName === "@ai-sdk/amazon-bedrock/mantle") return "openai"
  if (packageName === "@ai-sdk/azure") return "azure"
  if (packageName === "@ai-sdk/github-copilot") return "copilot"
  if (packageName === "@jerome-benoit/sap-ai-provider-v2") return "sap-ai"
  // openai-compatible 包用提供者 ID 的首段作为键（不同主机互不冲突）
  if (packageName === "@ai-sdk/openai-compatible") return providerID.split(".")[0]
  if (packageName === "@openrouter/ai-sdk-provider") return "openrouter"
  if (packageName === "ai-gateway-provider") return "openaiCompatible"
  // 其余 @ai-sdk/ 包直接去掉前缀作为键
  if (packageName?.startsWith("@ai-sdk/")) return packageName.slice("@ai-sdk/".length)
  // 兜底：用提供者 ID 本身
  return providerID
}

// 抽取随请求传递的设置：剔除仅用于构造 SDK 提供者的键
function requestSettings(settings: Provider.Settings | undefined) {
  if (settings === undefined) return undefined
  // These configure the SDK provider when it is created, not each request.
  // （这些键在创建 SDK 提供者时生效，而非作用于每次请求）
  const result = Struct.omit(Provider.nativeSettings(settings), [
    "accessToken",
    "apiKey",
    "authToken",
    "baseURL",
    "fetch",
  ])
  // 全部被剔除时返回 undefined（避免携带空对象）
  return Object.keys(result).length === 0 ? undefined : result
}

// 把模型级配置投影为提供者选项：区分“设置”与“body”，并对 pro 推理模式做特殊处理
function mapBodyToProviderOptions(model: RuntimeInfo, packageName: string) {
  // 请求级设置（剔除构造期键）
  const settings = requestSettings(model.settings)
  // body 中是否声明了 pro 推理模式
  const pro = Schema.is(Schema.Struct({ mode: Schema.Literal("pro") }))(model.body?.reasoning)
  // 特定包在显式推理配置（pro / effort / summary）时需要强制开启 reasoning
  const forceReasoning =
    ["@ai-sdk/openai", "@ai-sdk/azure", "@ai-sdk/amazon-bedrock/mantle"].includes(packageName) &&
    (pro || settings?.reasoningEffort !== undefined || settings?.reasoningSummary !== undefined)
  // 需要时把 forceReasoning 合入设置
  const normalized = forceReasoning ? Provider.mergeOverlay(settings, { forceReasoning: true }) : settings
  // 非 pro：body 原样返回
  if (!pro) return { settings: normalized, body: model.body }
  // pro 模式：从 body 中移除 reasoning 标记，改以 reasoningMode 设置传递
  const body = { ...model.body }
  delete body.reasoning
  return {
    settings: Provider.mergeOverlay(normalized, { reasoningMode: "pro" }),
    // body 为空对象时归一化为 undefined
    body: Object.keys(body).length === 0 ? undefined : body,
  }
}

// 把统一的 LLM 请求转换为 AI SDK 的调用参数（LanguageModelV3CallOptions）
function callOptions(
  request: LLMRequest,
  packageName: string | undefined,
  modelID: ID,
  optionKey: string,
): LanguageModelV3CallOptions {
  // 展平工具请求（拆出工具定义与消息）
  const flattened = ProviderShared.flattenToolRequest(request)
  return {
    // 消息提示（系统 + 历史消息）
    prompt: prompt(flattened.request),
    // 以下为采样与输出控制参数，直接透传
    maxOutputTokens: request.maxTokens,
    temperature: request.temperature,
    stopSequences: request.stop === undefined ? undefined : [...request.stop],
    topP: request.topP,
    topK: request.topK,
    presencePenalty: request.presencePenalty,
    frequencyPenalty: request.frequencyPenalty,
    seed: request.seed,
    // 工具定义列表
    tools: flattened.tools.map(tool),
    // 工具选择策略
    toolChoice: toolChoice(request.toolChoice),
    headers: request.headers,
    // 提供者专属选项
    providerOptions: requestProviderOptions(request.providerOptions, packageName, modelID, optionKey),
  }
}

// 构造 AI SDK 的提示（prompt）：系统提示 + 逐条消息；工具结果中的媒体收集到后续 user 消息
function prompt(request: LLMRequest): LanguageModelV3Prompt {
  // 系统提示：各段文本过滤空值后以双换行拼接
  const system = request.system
    .map((part) => part.text)
    .filter(Boolean)
    .join("\n\n")
  // 暂存待附媒体的缓冲（来自工具结果）
  const pending: UserContent = []
  const messages = request.messages.flatMap((input, index) => {
    // 非工具消息直接转换
    if (input.role !== "tool") return message(input)
    // 工具消息：拆出可附着的媒体与工具结果内容
    const lowered = toolMessage(input)
    pending.push(...lowered.media)
    // 还有下一条工具消息（媒体继续累积）或没有媒体时，仅返回工具消息本身
    if (request.messages[index + 1]?.role === "tool" || pending.length === 0) return lowered.messages
    // 否则把累积的媒体作为一条“附带媒体”的 user 消息追加在工具消息后
    const media = [...pending]
    pending.length = 0
    return [
      ...lowered.messages,
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "Attached media from tool result:" }, ...media],
      },
    ]
  })
  // 无系统提示时直接返回消息列表
  if (!system.length) return messages
  // 有系统提示时插入在最前
  return [{ role: "system", content: system }, ...messages]
}

// 单条消息转换：system 用“包装后的 user 消息”降级；user/assistant 分别转换内容部件
function message(input: Exclude<LLMRequest["messages"][number], ToolMessage>): LanguageModelV3Message[] {
  switch (input.role) {
    case "system":
      // The initial privileged prompt lives in `request.system` and is prepended above. A system message here is a
      // chronological instruction update, but opaque AI SDK providers do not uniformly allow the system role after
      // conversation history, so preserve its position using the safe wrapped-user fallback.
      // （这里的 system 消息是过程中途的指令更新；部分 AI SDK 提供者不允许历史之后再出现 system 角色，
      // 因此用“包装成 user 消息”的安全降级保持其时间顺序）
      return [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: ProviderShared.wrapSystemUpdate(input.content.filter((part) => part.type === "text")),
            },
          ],
        },
      ]
    case "user":
      return [{ role: "user", content: input.content.flatMap(userPart) }]
    case "assistant":
      return [{ role: "assistant", content: input.content.flatMap(assistantPart) }]
  }
}

// 工具消息转换：工具结果保留为 tool 消息；其中的图片/PDF 媒体抽出并放到随后的 user 消息
function toolMessage(input: ToolMessage) {
  // 收集需要附着到 user 消息的媒体
  const media: UserContent = []
  const content = input.content.flatMap((part) => {
    // 非工具结果或结果不是内容列表：按普通部件转换
    if (part.type !== "tool-result" || part.result.type !== "content") return toolResultPart(part)
    // 从内容列表中抽出图片与 PDF，其余保留
    const value = part.result.value.filter((item) => {
      if (item.type !== "file") return true
      // 非图片/PDF 的文件保留在结果里
      if (!item.mime.startsWith("image/") && item.mime !== "application/pdf") return true
      // 图片/PDF 转成 AI SDK 的文件部件并收集
      media.push({
        type: "file",
        mediaType: item.mime,
        data: fileData(ProviderShared.toolFileMedia(item).media),
        filename: item.name,
      })
      return false
    })
    // 被抽空时用占位文本说明媒体已在下一条 user 消息中
    return toolResultPart({
      ...part,
      result:
        value.length === 0
          ? { type: "text", value: "Media attached in the following user message." }
          : { ...part.result, value },
    })
  })
  return {
    // 有内容才输出 tool 消息，否则跳过
    messages: content.length ? ([{ role: "tool", content }] satisfies LanguageModelV3Message[]) : [],
    media,
  }
}

// 用户消息部件转换：文本原样；媒体转为文件部件；其余类型忽略
function userPart(part: ContentPart): UserContent {
  if (part.type === "text") return [{ type: "text", text: part.text }]
  if (part.type === "media")
    return [{ type: "file", mediaType: part.media.mediaType, data: fileData(part.media), filename: part.filename }]
  return []
}

// 助手消息部件转换：按类型映射；compaction 与 effort 不受支持（抛错）
function assistantPart(part: ContentPart): AssistantContent {
  switch (part.type) {
    case "compaction":
      // 压缩（compaction）状态无法在 AI SDK 路由上重放
      throw ProviderShared.unsupportedOperation({
        operation: "compaction-replay",
        provider: part.provider,
        message: "AI SDK routes cannot replay native provider compaction state",
      })
    case "text":
      return [{ type: "text", text: part.text, providerOptions: metadataProviderOptions(part.providerMetadata) }]
    case "media":
      return [{ type: "file", mediaType: part.media.mediaType, data: fileData(part.media), filename: part.filename }]
    case "reasoning":
      return [{ type: "reasoning", text: part.text, providerOptions: metadataProviderOptions(part.providerMetadata) }]
    case "tool-call":
      return [
        {
          type: "tool-call",
          toolCallId: part.id,
          toolName: part.name,
          input: part.input,
          providerExecuted: part.providerExecuted,
          providerOptions: metadataProviderOptions(part.providerMetadata),
        },
      ]
    case "tool-result":
      return toolResultPart(part)
    case "effort":
      // effort 部件不受支持
      throw ProviderShared.unsupportedContent("AI SDK", "assistant", [
        "text",
        "media",
        "reasoning",
        "tool-call",
        "tool-result",
      ])
  }
}

// 媒体数据提取：字节/base64 直接返回；URL 转成 URL 对象；提供者媒体引用（ref）不受支持
function fileData(media: Media.Asset) {
  const source = media.source
  if (source.type === "bytes" || source.type === "base64") return source.data
  if (source.type === "url") return new URL(source.url)
  throw ProviderShared.unsupportedOperation({
    operation: "media-ref",
    provider: source.provider,
    message: "AI SDK routes cannot forward provider media references",
  })
}

// 工具结果部件转换：只处理 tool-result 类型，产出 AI SDK 的 tool-result 结构
function toolResultPart(part: ContentPart): ToolResultContent[] {
  if (part.type !== "tool-result") return []
  return [
    {
      type: "tool-result",
      toolCallId: part.id,
      toolName: part.name,
      output: toolOutput(part.result),
      providerOptions: metadataProviderOptions(part.providerMetadata),
    },
  ]
}

// 工具结果值转换：文本/错误序列化为文本；内容列表按条目映射；JSON 直接规整
function toolOutput(result: ToolResultValue) {
  switch (result.type) {
    case "text":
    case "error":
      return { type: "text" as const, value: stringify(result.value) }
    case "content":
      return {
        type: "content" as const,
        value: result.value.map((item) => {
          // 文本条目原样
          if (item.type === "text") return { type: "text" as const, text: item.text }
          // 尝试从 data URL 中解出 base64 载荷
          const data = /^data:[^;,]+(?:;[^,]*)*;base64,(.*)$/s.exec(item.uri)?.[1]
          const image = item.mime.toLowerCase().startsWith("image/")
          // 有 base64 载荷：按图片/文件分别输出 data 形态
          if (data !== undefined)
            return image
              ? { type: "image-data" as const, data, mediaType: item.mime }
              : { type: "file-data" as const, data, mediaType: item.mime, filename: item.name }
          // 否则输出 URL 引用形态
          return image ? { type: "image-url" as const, url: item.uri } : { type: "file-url" as const, url: item.uri }
        }),
      }
    case "json":
      return { type: "json" as const, value: jsonValue(result.value) }
  }
}

// 工具定义转换：统一为 AI SDK 的 function 工具（输入 schema 用 JSON Schema）
function tool(input: ToolDefinition): LanguageModelV3FunctionTool {
  return {
    type: "function",
    name: input.name,
    description: input.description,
    inputSchema: input.inputSchema as JSONSchema7,
  }
}

// 工具选择转换：none/auto/required 直接映射；指定工具时要求给出名称
function toolChoice(input: LLMRequest["toolChoice"]): LanguageModelV3ToolChoice | undefined {
  if (!input) return undefined
  if (input.type === "tool") return input.name === undefined ? undefined : { type: "tool", toolName: input.name }
  return { type: input.type }
}

// 请求级提供者选项：按包名决定命名空间（网关特殊处理；Azure 同时挂 openai 与 azure 两份）
function requestProviderOptions(
  input: LLMRequest["providerOptions"],
  packageName: string | undefined,
  modelID: ID,
  optionKey: string,
): SharedV3ProviderOptions | undefined {
  if (!input) return undefined
  // 递归把值规整为合法 JSON
  const options = jsonObject(input)
  if (packageName === "@ai-sdk/gateway") return gatewayProviderOptions(modelID, options)
  if (packageName === "@ai-sdk/azure") return { openai: options, azure: options }
  // 默认：挂在包对应的选项键下
  return { [optionKey]: options }
}

// 元数据 → 提供者选项：每个键的值规整为合法 JSON
function metadataProviderOptions(input: ProviderMetadata | undefined): SharedV3ProviderOptions | undefined {
  if (!input) return undefined
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, jsonObject(value)]))
}

// 驱动 AI SDK 的 doStream 并把其流事件转为本仓库 LLM 事件流（先发 stepStart）
function streamLanguage(language: LanguageModelV3, options: LanguageModelV3CallOptions, http?: HttpMiddleware) {
  // 跨事件的流状态：步数、工具名表、打开中的片段
  const state: StreamState = { step: 0, toolNames: {}, open: {} }
  return Stream.concat(
    // 起始的 stepStart 事件
    Stream.make(LLMEvent.stepStart({ index: state.step })),
    // 剩余流在运行时构造（需要 Effect 上下文）
    Stream.unwrap(
      Effect.gen(function* () {
        const context = yield* Effect.context<never>()
        // 发起请求（可选经 HTTP 中间件），错误归一化为“request 阶段”的 AIError
        return yield* Effect.tryPromise({
          try: () =>
            http ? httpMiddleware.run({ http, context }, () => language.doStream(options)) : language.doStream(options),
          catch: (error) => llmError(error, "request"),
        })
      }).pipe(
        Effect.map((result) =>
          // 把 Web 可读流转为 Effect 流：读取错误归为“read 阶段”
          Stream.fromReadableStream({
            evaluate: () => result.stream,
            onError: (error) => llmError(error, "read"),
          }).pipe(
            // 每个流部件转成若干 LLM 事件
            Stream.mapEffect((event) => streamPartEvents(state, event)),
            // 摊平事件数组
            Stream.flatMap((events) => Stream.fromIterable(events)),
          ),
        ),
      ),
    ),
  )
}

// 片段（fragment）种类：正文文本或推理文本
type Fragment = "text" | "reasoning"

// 流转换状态：当前步数、工具调用 ID → 名称、每类片段当前打开的 ID
type StreamState = {
  step: number
  toolNames: Record<string, string>
  open: Partial<Record<Fragment, string>>
}

// 单个 AI SDK 流部件 → 零或多个 LLM 事件（含片段开合的补齐逻辑）
function streamPartEvents(
  state: StreamState,
  event: LanguageModelV3StreamPart,
): Effect.Effect<ReadonlyArray<LLMEvent>, AIError> {
  switch (event.type) {
    // 这些部件不产出事件
    case "stream-start":
    case "response-metadata":
    case "raw":
    case "file":
    case "source":
    case "tool-approval-request":
      return Effect.succeed([])
    case "text-start":
      // 文本片段开始（自动关闭已打开的其他文本片段）
      return Effect.succeed(openFragment(state, "text", event.id, providerMetadata(event.providerMetadata)))
    case "text-delta":
      // 文本增量：先确保片段已打开，再发增量
      return Effect.succeed([
        ...openFragment(state, "text", event.id),
        LLMEvent.textDelta({
          id: event.id,
          text: event.delta,
          providerMetadata: providerMetadata(event.providerMetadata),
        }),
      ])
    case "text-end":
      // 文本片段结束（未打开时忽略）
      return Effect.succeed(closeFragment(state, "text", event.id, providerMetadata(event.providerMetadata)))
    case "reasoning-start":
      // 推理片段开始
      return Effect.succeed(openFragment(state, "reasoning", event.id, providerMetadata(event.providerMetadata)))
    case "reasoning-delta":
      // 推理增量：同样先确保片段已打开
      return Effect.succeed([
        ...openFragment(state, "reasoning", event.id),
        LLMEvent.reasoningDelta({
          id: event.id,
          text: event.delta,
          providerMetadata: providerMetadata(event.providerMetadata),
        }),
      ])
    case "reasoning-end":
      // 推理片段结束
      return Effect.succeed(closeFragment(state, "reasoning", event.id, providerMetadata(event.providerMetadata)))
    case "tool-input-start":
      // 工具输入开始：登记 ID → 名称并转发
      state.toolNames[event.id] = event.toolName
      return Effect.succeed([
        LLMEvent.toolInputStart({
          id: event.id,
          name: event.toolName,
          providerExecuted: event.providerExecuted,
          providerMetadata: providerMetadata(event.providerMetadata),
        }),
      ])
    case "tool-input-delta":
      // 工具输入增量：名称未知时用 "unknown"
      return Effect.succeed([
        LLMEvent.toolInputDelta({ id: event.id, name: state.toolNames[event.id] ?? "unknown", text: event.delta }),
      ])
    case "tool-input-end":
      // 工具输入结束
      return Effect.succeed([
        LLMEvent.toolInputEnd({
          id: event.id,
          name: state.toolNames[event.id] ?? "unknown",
          providerMetadata: providerMetadata(event.providerMetadata),
        }),
      ])
    case "tool-call":
      // 完整工具调用：登记名称并解析输入 JSON
      state.toolNames[event.toolCallId] = event.toolName
      return ProviderShared.parseToolInput("aisdk", event.toolName, event.input).pipe(
        Effect.map((input) => [
          LLMEvent.toolCall({
            id: event.toolCallId,
            name: event.toolName,
            input,
            providerExecuted: event.providerExecuted,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]),
        // 解析失败：提供者自执行的调用向上抛错；模型产生的调用降级为 toolInputError
        Effect.catch((error) =>
          event.providerExecuted
            ? Effect.fail(error)
            : Effect.succeed([
                LLMEvent.toolInputError({
                  id: event.toolCallId,
                  name: event.toolName,
                  raw: event.input,
                }),
              ]),
        ),
      )
    case "tool-result":
      // 工具结果（提供者执行）：清理名称表并转发
      delete state.toolNames[event.toolCallId]
      return Effect.succeed([
        LLMEvent.toolResult({
          id: event.toolCallId,
          name: event.toolName,
          result: ToolResultValue.make(event.result, event.isError ? "error" : "json"),
          providerExecuted: true,
          providerMetadata: providerMetadata(event.providerMetadata),
        }),
      ])
    case "finish": {
      // 结束事件：归一化结束原因与用量，先发 stepFinish（步数自增）再发 finish
      const finish = {
        reason: { normalized: finishReason(event.finishReason), raw: event.finishReason.raw },
        usage: usage(event.usage),
        providerMetadata: providerMetadata(event.providerMetadata),
      }
      return Effect.succeed([LLMEvent.stepFinish({ index: state.step++, ...finish }), LLMEvent.finish(finish)])
    }
    case "error":
      // 流内错误：归一化为 read 阶段错误并失败
      return Effect.fail(llmError(event.error, "read"))
  }
}

// Session persists one open text and one open reasoning fragment at a time, while AI SDK providers may overlap,
// repeat, or omit fragment boundaries. Like the native protocol lifecycles, a start or delta for another fragment
// closes the open one, repeated starts are ignored, and ends for fragments that are not open are dropped.
// （会话层一次只保留一个打开的文本片段与一个推理片段，而 AI SDK 提供者可能重叠/重复/省略片段边界：
// 与原生协议生命周期一致——另一片段的开始或增量会关闭已打开片段，重复开始被忽略，未打开片段的结束被丢弃）
// 打开片段：已是同一 ID 则无事件；否则记录 ID，先关闭旧片段（若有）再发开始事件
function openFragment(state: StreamState, kind: Fragment, id: string, providerMetadata?: ProviderMetadata) {
  const open = state.open[kind]
  if (open === id) return []
  state.open[kind] = id
  const start =
    kind === "text" ? LLMEvent.textStart({ id, providerMetadata }) : LLMEvent.reasoningStart({ id, providerMetadata })
  if (open === undefined) return [start]
  return [fragmentEnd(kind, open), start]
}

// 关闭片段：仅当该片段确实处于打开状态才发结束事件
function closeFragment(state: StreamState, kind: Fragment, id: string, providerMetadata?: ProviderMetadata) {
  if (state.open[kind] !== id) return []
  state.open[kind] = undefined
  return [fragmentEnd(kind, id, providerMetadata)]
}

// 构造片段结束事件（按种类分派文本/推理）
function fragmentEnd(kind: Fragment, id: string, providerMetadata?: ProviderMetadata) {
  return kind === "text" ? LLMEvent.textEnd({ id, providerMetadata }) : LLMEvent.reasoningEnd({ id, providerMetadata })
}

// 用量归一化：AI SDK 的用量字段映射为本仓库结构；全为 undefined 时返回 undefined
function usage(input: Extract<LanguageModelV3StreamPart, { type: "finish" }>["usage"]): UsageInput | undefined {
  const output = {
    inputTokens: input.inputTokens.total,
    nonCachedInputTokens: input.inputTokens.noCache,
    cacheReadInputTokens: input.inputTokens.cacheRead,
    cacheWriteInputTokens: input.inputTokens.cacheWrite,
    outputTokens: input.outputTokens.total,
    reasoningTokens: input.outputTokens.reasoning,
    // 总数仅在输入/输出都可得时计算
    totalTokens:
      input.inputTokens.total === undefined || input.outputTokens.total === undefined
        ? undefined
        : input.inputTokens.total + input.outputTokens.total,
  }
  return Object.values(output).some((value) => value !== undefined) ? output : undefined
}

// 结束原因归一化："other" 统一为 "unknown"
function finishReason(value: LanguageModelV3FinishReason): FinishReason {
  return value.unified === "other" ? "unknown" : value.unified
}

// 校验并返回提供者元数据（形状不符时丢弃）
function providerMetadata(value: unknown) {
  return Schema.is(ProviderMetadata)(value) ? value : undefined
}

// 把对象中每个值规整为合法 JSON
function jsonObject(input: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, jsonValue(value)]))
}

// 任意值 → JSON 值：先序列化再解析（丢弃 undefined / 函数等），失败时降级为字符串化
function jsonValue(input: unknown): JSONValue {
  try {
    const encoded = JSON.stringify(input)
    return encoded === undefined ? null : (JSON.parse(encoded) as JSONValue)
  } catch {
    return stringify(input)
  }
}

// 错误归一化：AIError 直通；APICallError 专门转换；网络故障转 TransportError；其余按 HTTP 失败包装
function llmError(error: unknown, operation: "request" | "read") {
  if (error instanceof AIError) return error
  if (APICallError.isInstance(error)) return apiCallError(error)
  // 尝试识别运行时的网络故障形状
  const network = networkFailure(error)
  if (network)
    return new AIError({
      reason: new TransportError({
        message: network.message.trim() === "" ? unknownErrorMessage(error) : network.message,
        cause: error,
        transport: "http",
        operation,
        code: network.code,
      }),
    })
  // 其余按通用 HTTP 失败包装
  return RequestExecutor.httpFailure({
    message: unknownErrorMessage(error),
    data: errorValue(error) ?? error,
    responseBody: errorBody(error),
    cause: error,
  })
}

// AI SDK stream errors can arrive as plain objects. A gateway's type validation error keeps the provider's error
// response in `value`, which carries the message and codes.
// （AI SDK 流错误可能是普通对象：网关的类型校验错误会把提供者的错误响应放在 `value` 里，含消息与错误码）
const errorValue = (error: unknown) => (isRecord(error) ? error.value : undefined)

// Runtime-generated network failure shapes. The codes mirror the AI SDK's own
// Bun network error list in handleFetchError, plus the unreachable-host codes that list leaves out and
// ModelRetry gives a longer budget; the messages are undici's fetch
// TypeError and stream termination strings plus our header and chunk timeout errors.
// Unrecognized shapes still retry via the UnknownProvider default; this match
// only adds transport semantics (continuation eligibility, display).
// （运行时产生的网络故障形状：错误码对齐 AI SDK 自身的 Bun 网络错误清单（handleFetchError），并补充其
// 遗漏的不可达主机码以获得更长的 ModelRetry 重试预算；消息为 undici fetch 的 TypeError 与流终止字符串，
// 外加本实现的头部/分块超时错误。未识别的形状仍按 UnknownProvider 默认重试，此匹配只补充传输语义：
// 是否可续传与展示方式）
const NETWORK_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ConnectionRefused",
  "ConnectionClosed",
  "FailedToOpenSocket",
])
const NETWORK_ERROR_MESSAGES = new Set([
  "fetch failed",
  "failed to fetch",
  "terminated",
  "other side closed",
  "sse read timed out",
  HEADER_TIMEOUT_MESSAGE.toLowerCase(),
])

// 原生错误形状：{ message, code?, cause? }（宽松解码）
const NativeErrorShape = Schema.Struct({
  message: Schema.String,
  code: Schema.optionalKey(Schema.String),
  cause: Schema.optionalKey(Schema.Unknown),
})
const decodeNativeErrorShape = Schema.decodeUnknownOption(NativeErrorShape)

// 识别运行时网络故障：沿 cause 链向下找最深匹配，避免被外层包装迷惑
function networkFailure(error: unknown, depth = 0): { message: string; code?: string } | undefined {
  // 限制 cause 链深度，防循环/过长
  if (depth > 4) return undefined
  const shape = Option.getOrUndefined(decodeNativeErrorShape(error))
  if (!shape) return undefined
  // Prefer the deepest match: wrappers like undici's "fetch failed" TypeError
  // carry the specific network code on their cause.
  // （优先取最深匹配：undici 的 "fetch failed" TypeError 这类包装把具体网络码放在 cause 上）
  const cause = networkFailure(shape.cause, depth + 1)
  if (cause) return cause
  // 已知网络错误码（含 UND_ERR 前缀）视为网络故障
  if (shape.code !== undefined && (NETWORK_ERROR_CODES.has(shape.code) || shape.code.startsWith("UND_ERR")))
    return { message: shape.message, code: shape.code }
  // 已知网络错误消息（如 "fetch failed"）也视为网络故障
  if (NETWORK_ERROR_MESSAGES.has(shape.message.trim().toLowerCase()))
    return { message: shape.message, code: shape.code }
  return undefined
}

// APICallError → 本仓库 HTTP 失败：带 URL/状态码/响应体；无状态码且可重试时转为传输错误
function apiCallError(error: APICallError) {
  const failure = RequestExecutor.httpFailure({
    message: providerErrorMessage(error),
    url: error.url,
    status: error.statusCode,
    data: error.data,
    responseHeaders: error.responseHeaders,
    responseBody: error.responseBody ?? errorBody(error.data),
    cause: error,
  })
  // 有状态码或标记为不可重试：直接用 HTTP 失败
  if (error.statusCode !== undefined || !error.isRetryable) return failure
  // "Cannot connect to API" wraps the runtime's error; keep its code so retry and display can tell why.
  // （“无法连接 API”包装了运行时错误：保留其错误码，便于重试与展示判断原因）
  const code = networkFailure(error.cause)?.code
  return new AIError({
    reason: new TransportError({
      message: failure.message,
      body: failure.reason.body,
      http: failure.reason.http,
      cause: failure.reason.cause,
      transport: "http",
      operation: "request",
      url: error.url,
      ...(code === undefined ? {} : { code }),
    }),
  })
}

// 错误体提取：字符串原样；Error 或非法 JSON 返回 undefined；其余编码为 JSON 字符串
function errorBody(value: unknown) {
  if (typeof value === "string") return value
  if (value instanceof Error || !Schema.is(Schema.Json)(value)) return undefined
  return ProviderShared.encodeJson(value)
}

// 提供者错误明细：可选的 message 与 code（字符串或有限数字）
const ProviderErrorDetail = Schema.Struct({
  message: Schema.optionalKey(Schema.String),
  code: Schema.optionalKey(Schema.Union([Schema.String, Schema.Finite])),
})
// 提供者错误体：顶层明细，或嵌套在 error 字段下
const ProviderErrorBody = Schema.Struct({
  ...ProviderErrorDetail.fields,
  error: Schema.optionalKey(ProviderErrorDetail),
})
// 解码器：接受对象或 JSON 字符串两种形态
const decodeProviderError = Schema.decodeUnknownOption(
  Schema.Union([ProviderErrorBody, Schema.fromJsonString(ProviderErrorBody)]),
)

// 从未知错误中尽力提取消息：Error.message / 字符串 / 错误对象及其 value 的解码字段
function unknownErrorMessage(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : ([error, errorValue(error)]
            .map((value) => Option.getOrUndefined(decodeProviderError(value)))
            .flatMap((decoded) => [decoded?.error?.message, decoded?.message])
            .find((value) => value?.trim()) ?? "")
  // 空消息时给通用兜底文案
  return message.trim() === "" ? "Provider request failed" : message
}

// 从 APICallError 提取消息：依次尝试 data.error / data / body.error / body 的 message 与 code
function providerErrorMessage(error: APICallError) {
  const data = Option.getOrUndefined(decodeProviderError(error.data))
  const body = Option.getOrUndefined(decodeProviderError(error.responseBody))
  const details = [data?.error, data, body?.error, body]
  const message = details.map((detail) => detail?.message).find((value) => value?.trim())
  const value = details.map((detail) => detail?.code).find((value) => value !== undefined)
  const code = value === undefined ? undefined : String(value)
  // 前缀带 HTTP 状态码（若有）
  const prefix =
    error.statusCode === undefined ? "Provider request failed" : `Provider request failed with HTTP ${error.statusCode}`
  // 优先用错误自带的 message；其次解码出的 message；再次前缀 + 错误码
  return error.message.trim() !== "" ? error.message : (message ?? (code === undefined ? prefix : `${prefix}: ${code}`))
}

// 打包成节点：依赖平台层的 httpFetch 节点
export const node = makeLocationNode({ service: Service, layer: locationLayer, deps: [httpFetch] })
