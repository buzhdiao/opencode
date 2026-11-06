// 导入插件定义辅助函数 define
import { define } from "@opencode/plugin/effect/plugin"
// 导入配置条目类型（仅类型）
import type { Entry } from "@opencode/schema/config"
// 从 effect 库导入所需原语：时长、Effect、Option、调度器、信号量、Stream 等
import { Duration, Effect, Option, Schedule, type Schema, Semaphore, Stream } from "effect"
// 从 effect/http 导入 HTTP 客户端相关工具
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
// 导入 photon WASM 占位模块（用于判断当前运行环境）
import photonWasm from "#photon-wasm"
// 导入配置服务
import { Config } from "../../config.js"
// 导入环境服务
import { Environment } from "../../environment/index.js"
// 导入“环境不可用”标记
import { EnvironmentUnavailable } from "../../environment/unavailable.js"
// 导入 Location 服务
import { Location } from "../../location.js"
// 导入 Model（模型 ID/家族工具）
import { Model } from "../../model.js"
// 导入内部插件类型声明（仅类型）
import type { PluginInternal } from "../internal.js"
// 导入设置折叠辅助函数
import { foldSettings } from "./configured.js"

// 本地模型描述：发现逻辑产出的统一形状
export type LocalModel = {
  // 模型 ID
  readonly id: string
  // 展示名称（可选）
  readonly name?: string
  // 模型家族（可选）
  readonly family?: string | null
  // 是否支持工具调用（可选）
  readonly tools?: boolean
  // 是否支持视觉输入（可选）
  readonly vision?: boolean
  // 上下文长度（可选）
  readonly context?: number | null
}

// 本地发现客户端类型：由 createClient 的返回值推导
export type LocalDiscoveryClient = ReturnType<typeof createClient>

// 创建“本地提供商插件”的工厂：LM Studio、vLLM、Ollama 等共用这套发现/刷新逻辑
export function createLocalProviderPlugin<Discovered>(input: {
  // 插件唯一标识符
  readonly id: string
  // 目录中提供商的 ID
  readonly providerID: string
  // 展示名称
  readonly name: string
  // 本地服务默认地址
  readonly origin: string
  // 可选的 baseURL 后缀剥离规则
  readonly stripPathSuffix?: RegExp
  // 发现函数：给定客户端返回发现到的模型列表
  readonly discover: (client: LocalDiscoveryClient) => Effect.Effect<readonly Discovered[], unknown>
  // 模型映射函数：把发现的条目转成统一的 LocalModel
  readonly model: (item: NoInfer<Discovered>) => LocalModel
}) {
  // 发现结果缓存：按服务根地址记录上次检查时间、凭据与模型列表
  const discovery = new Map<string, { checked: number; apiKey?: string; models?: readonly Discovered[] }>()
  // 串行化发现流程的信号量
  const discoveryLock = Semaphore.makeUnsafe(1)
  // baseURL 后缀剥离规则，默认剥掉 /v1
  const suffix = input.stripPathSuffix ?? /\/v1$/

  // 返回 make 函数：可覆盖 origin 与轮询间隔
  return function make(origin?: string, interval: Duration.Input = "30 seconds") {
    // 定义并返回插件
    return define({
      // 插件唯一标识符
      id: input.id,
      // 插件主流程生成器
      effect: Effect.fn(function* (ctx) {
        // 获取 HTTP 客户端并过滤掉非 2xx 响应（让请求直接失败）
        const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
        // 获取配置服务实例
        const config = yield* Config.Service
        // 可选地获取环境服务（某些运行环境没有）
        const environment = yield* Effect.serviceOption(Environment.Service)
        // 可选地获取 Location 服务
        const location = yield* Effect.serviceOption(Location.Service)
        // 计算默认服务地址：显式传入优先；photon 环境为空、处于工作区、或环境不可用时不自动探测
        const defaultOrigin =
          origin ??
          (photonWasm === "" ||
          (Option.isSome(location) && location.value.workspaceID !== undefined) ||
          (Option.isSome(environment) && environment.value.spawner === EnvironmentUnavailable.spawner)
            ? undefined
            : input.origin)
        // source：当前生效的端点/凭据配置（随配置更新而变）
        const source = { current: configured(yield* config.entries(), input.providerID, defaultOrigin, suffix) }
        // loaded：最近一次成功加载的模型列表与其序列化哈希
        const loaded = { models: [] as readonly Discovered[], hash: "[]" }

        // 集成目录变换：尚未发现模型时先移除该集成占位
        yield* ctx.integration.transform((integrations) => {
          // 没有模型就不注册集成
          if (loaded.models.length === 0) return
          // 移除该提供商对应的集成条目
          integrations.remove(input.providerID)
        })

        // 提供商目录变换：把发现的模型写入目录
        yield* ctx.provider.transform((providers) => {
          // 尚无模型时不发布该提供商
          if (loaded.models.length === 0) return
          // 先移除目录里已有的旧模型
          for (const model of providers.get(input.providerID)?.models.values() ?? []) {
            providers.models.remove(input.providerID, model.id)
          }
          // 更新提供商基础信息
          providers.update(input.providerID, (provider) => {
            // 展示名称
            provider.name = input.name
            // 显式启用
            provider.activation = "enabled"
            // 走 openai-compatible 通用包
            provider.package = "@opencode/ai/providers/openai-compatible"
            // 写入端点与凭据设置
            provider.settings = {
              baseURL: source.current.baseURL,
              provider: input.providerID,
              apiKey: source.current.apiKey ?? "",
            }
            // 本地提供商不属于任何集成
            provider.integrationID = undefined
          })
          // 逐个写入发现的模型
          for (const item of loaded.models) {
            // 映射为统一模型描述
            const spec = input.model(item)
            // 按模型 ID 更新
            providers.models.update(input.providerID, spec.id, (model) => {
              // 真实 API ID
              model.modelID = Model.ID.make(spec.id)
              // 展示名回退到 ID
              model.name = spec.name || spec.id
              // 模型家族（有值才设置）
              model.family = spec.family ? Model.Family.make(spec.family) : undefined
              // 能力：工具、输入（视觉可选）、输出
              model.capabilities = {
                tools: spec.tools ?? false,
                input: ["text", ...(spec.vision ? ["image"] : [])],
                output: ["text"],
              }
              // 上下文长度为正数时才写入限制
              if (typeof spec.context === "number" && spec.context > 0) model.limit.context = spec.context
            })
          }
        })

        // discover：带缓存的发现流程（同凭据且未过期时直接复用）
        const discover = Effect.fn("LocalProviderPlugin.discover")(function* () {
          // 读取当前配置
          const current = source.current
          // 端点不可用（如无默认地址）时返回 undefined
          if (!current.endpoint) return undefined
          // 在信号量保护下执行，避免并发重复探测
          return yield* discoveryLock.withPermit(
            Effect.gen(function* () {
              // 读取缓存
              const cached = discovery.get(current.root)
              // 缓存存在、凭据一致且未超过间隔时直接返回
              if (
                cached &&
                cached.apiKey === current.apiKey &&
                Date.now() - cached.checked < Duration.toMillis(interval)
              )
                return { source: current, models: cached.models }
              // 先占位记录检查时间（探活开始），凭据一致时保留旧模型
              discovery.set(current.root, {
                checked: Date.now(),
                apiKey: current.apiKey,
                models: cached && cached.apiKey === current.apiKey ? cached.models : undefined,
              })
              // 真正调用子插件的发现函数
              const models = yield* input.discover(createClient(http, current.root, current.apiKey, current.endpoint))
              // 成功后写入新缓存
              discovery.set(current.root, { checked: Date.now(), apiKey: current.apiKey, models })
              // 返回发现结果
              return { source: current, models }
            }),
          )
        })

        // refresh：发现一次并在结果变化时重载目录
        const refresh = Effect.fn("LocalProviderPlugin.refresh")(function* () {
          // 执行发现
          const result = yield* discover()
          // 没有模型或配置已过期（source 已变化）时跳过
          if (!result?.models || result.source !== source.current) return
          // 序列化模型列表作为指纹
          const hash = JSON.stringify(result.models)
          // 指纹未变则无需重载
          if (hash === loaded.hash) return
          // 更新已加载的模型与指纹
          loaded.models = result.models
          loaded.hash = hash
          // 重载集成与提供商目录
          yield* ctx.integration.reload()
          yield* ctx.provider.reload()
        })

        // Keep the last successful inventory through transient outages instead of flickering model availability.
        // 周期性刷新：失败被忽略，服务短暂不可用时不闪烁模型可用性
        yield* refresh().pipe(Effect.ignore, Effect.repeat(Schedule.spaced(interval)), Effect.forkScoped)
        // reload：配置更新后重新计算端点/凭据
        const reload = Effect.fn("LocalProviderPlugin.reload")(function* () {
          // 重新折叠配置得到新设置
          const next = configured(yield* config.entries(), input.providerID, defaultOrigin, suffix)
          // 端点、凭据、根地址都未变时无需处理
          if (
            next.baseURL === source.current.baseURL &&
            next.apiKey === source.current.apiKey &&
            next.root === source.current.root
          )
            return
          // 切换到新配置并清空已加载模型
          source.current = next
          loaded.models = []
          loaded.hash = "[]"
          // 重载目录后立即刷新一次
          yield* ctx.integration.reload()
          yield* ctx.provider.reload()
          yield* refresh().pipe(Effect.ignore)
        })
        // 订阅配置更新事件：每次更新都触发 reload
        yield* ctx.event
          .subscribe({ types: ["config.updated"] })
          .pipe(Stream.runForEach(reload), Effect.forkScoped({ startImmediately: true }))
      }),
    } satisfies PluginInternal.InternalPlugin)
  }
}

// createClient：构造一个带鉴权与 1 秒超时的本地发现客户端
function createClient(
  // 已过滤状态的 HTTP 客户端
  http: HttpClient.HttpClient,
  // 服务根地址
  root: string,
  // 可选的 API key
  apiKey: string | undefined,
  // 把路径拼成完整 URL 的函数
  endpoint: (path: string) => string,
) {
  // auth：给请求附加 JSON 接受头，有 key 时再加 Bearer 令牌
  const auth = (request: HttpClientRequest.HttpClientRequest) =>
    apiKey
      ? request.pipe(HttpClientRequest.acceptJson, HttpClientRequest.bearerToken(apiKey))
      : request.pipe(HttpClientRequest.acceptJson)
  // 返回客户端对象
  return {
    // 服务根地址
    root,
    // 透传 API key
    apiKey,
    // get：普通 GET 请求，1 秒超时
    get: (path: string) => http.execute(auth(HttpClientRequest.get(endpoint(path)))).pipe(Effect.timeout("1 second")),
    // getJson：GET 并按 Schema 解码响应体
    getJson: <A, I>(path: string, schema: Schema.Codec<A, I>) =>
      http
        .execute(auth(HttpClientRequest.get(endpoint(path))))
        .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)), Effect.timeout("1 second")),
    // postJson：POST JSON 请求体并按 Schema 解码响应
    postJson: <B, BI, A, AI>(
      path: string,
      bodySchema: Schema.Codec<B, BI>,
      body: B,
      responseSchema: Schema.Codec<A, AI>,
    ) =>
      auth(HttpClientRequest.post(endpoint(path))).pipe(
        HttpClientRequest.schemaBodyJson(bodySchema)(body),
        Effect.flatMap(http.execute),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(responseSchema)),
        Effect.timeout("1 second"),
      ),
  }
}

// configured：把用户配置折叠成可用的端点/凭据设置
function configured(entries: readonly Entry[], providerID: string, origin: string | undefined, suffix: RegExp) {
  // 折叠配置条目得到该提供商的设置
  const settings = foldSettings(entries, providerID, undefined)
  // baseURL：优先用户配置；否则由 origin 拼出 <origin>/v1；都没有则为空串（并统一去掉尾部斜杠）
  const baseURL = (
    typeof settings?.baseURL === "string"
      ? settings.baseURL
      : origin !== undefined
        ? `${origin.replace(/\/+$/, "")}/v1`
        : ""
  ).replace(/\/+$/, "")
  // apiKey：必须是字符串
  const apiKey = typeof settings?.apiKey === "string" ? settings.apiKey : undefined
  // baseURL 无法解析为 URL 时直接返回（无 endpoint）
  if (!URL.canParse(baseURL)) return { baseURL, apiKey }
  // 解析 URL
  const url = new URL(baseURL)
  // 只支持 http/https 协议
  if (url.protocol !== "http:" && url.protocol !== "https:") return { baseURL, apiKey }
  // 去掉路径后缀（如 /v1），得到 API 前缀
  const prefix = url.pathname.replace(/\/+$/, "").replace(suffix, "")
  // endpoint：把请求路径拼到前缀后，清空查询串与锚点
  const endpoint = (path: string) => {
    // 基于原 URL 复制
    const next = new URL(url)
    // 设置拼接后的路径
    next.pathname = `${prefix}${path}`
    // 清空查询串
    next.search = ""
    // 清空锚点
    next.hash = ""
    // 返回字符串形式
    return next.toString()
  }
  // 返回设置与根地址/端点函数（root 用于缓存键）
  return { baseURL, apiKey, root: endpoint(""), endpoint }
}
