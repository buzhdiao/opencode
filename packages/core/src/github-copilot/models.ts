// 将本模块整体以命名空间 CopilotModels 的形式再导出，方便外部统一引用
export * as CopilotModels from "./models.js"

// 引入 Money 类型，用于以“美元/百万 token”为单位建模价格
import { Money } from "@opencode/schema/money"
// 引入 Effect 副作用编排库以及 Option、Schema（数据建模与校验）工具
import { Effect, Option, Schema } from "effect"
// 引入 Effect HTTP 能力：请求头输入、HTTP 客户端、请求构造器与响应工具
import { Headers, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
// 引入模型信息类型 Model
import { Model } from "../model.js"
// 引入提供商类型 Provider，用于标识 GitHub Copilot
import { Provider } from "../provider.js"

// 远端 /models 接口中单个模型条目的结构定义（用 Schema 做运行时校验）
const RemoteModel = Schema.Struct({
  // 是否在模型选择器（model picker）中启用
  model_picker_enabled: Schema.Boolean,
  is_chat_fallback: Schema.optional(Schema.Boolean),
  id: Schema.String,
  // 展示名称
  name: Schema.String,
  // 版本字符串
  version: Schema.String,
  // 支持的 API 端点路径列表（可选）
  supported_endpoints: Schema.optional(Schema.Array(Schema.String)),
  // 访问策略（可选），state 可能是 disabled 等状态
  policy: Schema.optional(Schema.Struct({ state: Schema.optional(Schema.String) })),
  // 计费信息（可选）
  billing: Schema.optional(
    Schema.Struct({
      auto_discount: Schema.optional(Schema.Number),
      token_prices: Schema.optional(
        Schema.Struct({
          // 计费批次大小（换算单价用）
          batch_size: Schema.Number,
          // 默认价格档
          default: Schema.Struct({
            // API version 2026-08-01 renamed cache_price to cache_read_price.
            // 旧字段：缓存价格（可选，新版本已改名为 cache_read_price）
            cache_price: Schema.optional(Schema.Number),
            // 新字段：缓存读取价格（可选）
            cache_read_price: Schema.optional(Schema.Number),
            // 输入 token 单价
            input_price: Schema.Number,
            // 输出 token 单价
            output_price: Schema.Number,
          }),
        }),
      ),
    }),
  ),
  // 模型能力描述
  capabilities: Schema.Struct({
    // 所属模型家族
    family: Schema.String,
    // 各类 token 限制（可选）
    limits: Schema.optional(
      Schema.Struct({
        // 最大上下文窗口 token 数（可选）
        max_context_window_tokens: Schema.optional(Schema.Number),
        // 最大输出 token 数（可选）
        max_output_tokens: Schema.optional(Schema.Number),
        // 最大提示词 token 数（可选）
        max_prompt_tokens: Schema.optional(Schema.Number),
        // 视觉能力限制（可选）
        vision: Schema.optional(
          Schema.Struct({
            // 单张提示图片的最大尺寸
            max_prompt_image_size: Schema.Number,
            // 提示中允许的图片数量上限
            max_prompt_images: Schema.Number,
            // 支持的媒体类型（MIME）列表
            supported_media_types: Schema.Array(Schema.String),
          }),
        ),
      }),
    ),
    // 功能开关集合
    supports: Schema.Struct({
      // 是否支持自适应思考（adaptive thinking，可选）
      adaptive_thinking: Schema.optional(Schema.Boolean),
      // 思考预算上限（可选）
      max_thinking_budget: Schema.optional(Schema.Number),
      // 思考预算下限（可选）
      min_thinking_budget: Schema.optional(Schema.Number),
      // 支持的推理力度（reasoning effort）等级列表（可选）
      reasoning_effort: Schema.optional(Schema.Array(Schema.String)),
      // 是否支持流式输出（可选）
      streaming: Schema.optional(Schema.Boolean),
      // 是否支持结构化输出（可选）
      structured_outputs: Schema.optional(Schema.Boolean),
      // 是否支持工具调用（可选）
      tool_calls: Schema.optional(Schema.Boolean),
      // 是否支持视觉输入（可选）
      vision: Schema.optional(Schema.Boolean),
    }),
  }),
})

// 响应外层结构：data 是任意条目的数组（先宽松校验，再逐项解码）
const Response = Schema.Struct({ data: Schema.Array(Schema.Unknown) })
// 构造“未知数据 -> RemoteModel”的解码器，失败时转换为 undefined
const decodeModel = Schema.decodeUnknownOption(RemoteModel)

// 由 Schema 推导出的远端模型 TS 类型
type RemoteModel = typeof RemoteModel.Type
// “可用模型”类型：在 RemoteModel 之上要求关键能力字段必定存在（输入/输出上限、工具调用）
type UsableModel = RemoteModel & {
  capabilities: RemoteModel["capabilities"] & {
    limits: NonNullable<RemoteModel["capabilities"]["limits"]> & {
      max_output_tokens: number
      max_prompt_tokens: number
    }
    supports: RemoteModel["capabilities"]["supports"] & { tool_calls: boolean }
  }
}

// 获取模型快照并与本地已有模型合并：先拉取远端列表，再交给 derive 合成
export function get(
  http: HttpClient.HttpClient,
  baseURL: string,
  headers: Headers.Input,
  existing: readonly Model.Info[],
) {
  // load 拉取远端快照，随后在 map 中用 derive 将远端事实与本地 existing 模板合并
  return load(http, baseURL, headers).pipe(Effect.map((remote) => derive(baseURL, remote, existing)))
}

// 快照类型：API 模型 ID 到可用模型的只读映射
export type Snapshot = ReadonlyMap<string, UsableModel>

// 拉取远端模型列表的 Effect 生成器：GET /models，整体限时 5 秒，成功后构建 ID->模型 映射
export const load = Effect.fn("CopilotModels.load")(function* (
  http: HttpClient.HttpClient,
  baseURL: string,
  headers: Headers.Input,
) {
  // 发起带鉴权头的 GET {baseURL}/models 请求；filterStatusOk 过滤非 2xx 状态；schemaBodyJson 按 Response 解码响应体；timeout 限时 5 秒
  const response = yield* HttpClient.filterStatusOk(http)
    .execute(HttpClientRequest.get(`${baseURL}/models`).pipe(HttpClientRequest.setHeaders(headers)))
    .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(Response)), Effect.timeout("5 seconds"))
  // 逐项解码 data 数组，仅保留“可用”的模型，聚合成 Map
  return new Map(
    response.data.flatMap((raw) => {
      // 解码单个原始条目，非法数据会得到 undefined
      const model = Option.getOrUndefined(decodeModel(raw))
      // 仅当解码成功且通过 usable 检查时产出键值对，否则折叠为空数组被 flatMap 丢弃
      return model && usable(model) ? ([[model.id, model]] as const) : []
    }),
  )
})

/** Combine remote facts with source templates, never a previously transformed model result. */
export function derive(baseURL: string, remote: Snapshot, existing: readonly Model.Info[]) {
  // 结果映射先以本地 existing 列表（按其 id）初始化
  const result = new Map(existing.map((model) => [model.id, model]))

  // Keep aliases and local metadata, but only when their advertised API model
  // still exists. A partial or malformed item cannot create a broken model.
  // 遍历本地条目：仅当其指向的 API 模型仍存在于远端时才保留，否则删除
  for (const [id, model] of result) {
    // 在远端快照中查找该模型当前声明
    const current = remote.get(model.modelID)
    // 远端已不存在该模型，说明已下线，删除本地别名
    if (!current) {
      result.delete(id)
      continue
    }
    // 用远端数据配合本地模板重建模型信息
    result.set(id, build(id, current, baseURL, model))
  }

  // 再遍历远端快照：补充本地没有的新模型
  for (const [id, model] of remote) {
    // 生成规范化的模型 ID 键
    const key = Model.ID.make(id)
    // 已存在（上面处理过）则跳过，避免覆盖
    if (result.has(key)) continue
    // 没有本地模板的远端模型直接构建
    result.set(key, build(key, model, baseURL))
  }

  // 返回合并完成的模型映射
  return result
}

/** Copilot's Auto model. Copilot's router picks the model that serves each Session from the account's Auto pool. */
export const auto = Model.ID.make("auto")

export function autoModel(baseURL: string, remote: Snapshot) {
  const pool = Array.from(remote.values()).filter((model) => model.billing?.auto_discount !== undefined)
  if (pool.length === 0) return
  const route = routeFor(auto, "chat", baseURL)
  const limits = pool.map((model) => model.capabilities.limits)
  return Model.Info.make({
    ...Model.Info.default(Provider.ID.githubCopilot, auto),
    name: "Auto",
    package: route.package,
    settings: { baseURL: route.baseURL },
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    // Any pool model may serve a Session, so show the smallest window.
    limit: {
      context: Math.min(...limits.map((limit) => limit.max_context_window_tokens ?? limit.max_prompt_tokens)),
      input: Math.min(...limits.map((limit) => limit.max_prompt_tokens)),
      output: Math.min(...limits.map((limit) => limit.max_output_tokens)),
    },
  })
}

function usable(model: RemoteModel): model is UsableModel {
  return (
    // 策略状态不是 disabled（未被禁用）
    model.policy?.state !== "disabled" &&
    // 已声明最大输出 token 数
    model.capabilities.limits?.max_output_tokens !== undefined &&
    // 已声明最大提示词 token 数
    model.capabilities.limits.max_prompt_tokens !== undefined &&
    // 已声明是否支持工具调用
    model.capabilities.supports.tool_calls !== undefined
  )
}

// 由远端模型数据构建标准 Model.Info；previous 为本地已有模板（可选），用于保留别名与覆盖项
function build(id: Model.ID, remote: UsableModel, baseURL: string, previous?: Model.Info) {
  const route = routeFor(remote.id, endpoint(remote.supported_endpoints), baseURL)
  const image =
    (remote.capabilities.supports.vision ?? false) ||
    (remote.capabilities.limits.vision?.supported_media_types ?? []).some((item) => item.startsWith("image/"))
  // 是否支持 PDF：vision 开启且媒体类型包含 application/pdf
  const pdf =
    (remote.capabilities.supports.vision ?? false) &&
    (remote.capabilities.limits.vision?.supported_media_types.includes("application/pdf") ?? false)
  // 输入模态列表：文本为基础，按能力追加
  const input = ["text"]
  // 支持图片则加入 image 模态
  if (image) input.push("image")
  // 支持 PDF 则加入 pdf 模态
  if (pdf) input.push("pdf")
  // 读取 token 计价信息（可能缺失）
  const prices = remote.billing?.token_prices
  // Copilot reports AIC per billing batch; OpenCode stores USD per million tokens.
  // 单位换算：AIC 按计费批次报价，换算为美元/百万 token 的系数是 10000 / batch_size
  const usdPerMillion = prices && prices.batch_size > 0 ? 10_000 / prices.batch_size : 0
  // 版本号若以 "<模型ID>-" 为前缀则去掉该前缀，得到纯版本字符串
  const version = remote.version.startsWith(`${remote.id}-`)
    ? remote.version.slice(remote.id.length + 1)
    : remote.version
  // 发布时间：优先沿用本地模板记录，否则从版本字符串解析
  const released = previous?.time.released || Date.parse(version)

  // 用合并后的全部字段创建 Model.Info 实例
  return Model.Info.make({
    // 以 GitHub Copilot 提供商的默认模型信息打底
    ...Model.Info.default(Provider.ID.githubCopilot, id),
    // 对外展示/引用的模型 ID
    id,
    // 实际请求时使用的 API 模型 ID
    modelID: Model.ID.make(remote.id),
    // 提供商固定为 githubCopilot
    providerID: Provider.ID.githubCopilot,
    // 家族：优先沿用本地模板，否则取远端声明
    family: previous?.family ?? Model.Family.make(remote.capabilities.family),
    // 名称：优先沿用本地模板，否则取远端名称
    name: previous?.name ?? remote.name,
    package: route.package,
    settings: Provider.mergeOverlay(previous?.settings, { baseURL: route.baseURL }),
    headers: previous?.headers,
    // 额外请求体沿用本地模板
    body: previous?.body,
    // 能力声明：是否支持工具、输入模态集合、输出固定为文本
    capabilities: {
      tools: remote.capabilities.supports.tool_calls,
      input,
      output: ["text"],
    },
    variants: variants(remote, route.endpoint === "messages"),
    time: { released: Number.isFinite(released) ? released : 0 },
    // 价格：按美元/百万 token 换算后的单价列表
    cost: [
      {
        // 输入 token 单价（缺失时按 0 计）
        input: Money.USDPerMillionTokens.make((prices?.default.input_price ?? 0) * usdPerMillion),
        // 输出 token 单价（缺失时按 0 计）
        output: Money.USDPerMillionTokens.make((prices?.default.output_price ?? 0) * usdPerMillion),
        // 缓存价格
        cache: {
          // 读取价优先用新字段 cache_read_price，缺失时回退旧字段 cache_price
          read: Money.USDPerMillionTokens.make(
            (prices?.default.cache_read_price ?? prices?.default.cache_price ?? 0) * usdPerMillion,
          ),
          // 缓存写入不单独计费
          write: Money.USDPerMillionTokens.zero,
        },
      },
    ],
    // 状态标记为可用
    status: "active",
    // 是否在模型选择器中默认展示
    enabled: remote.model_picker_enabled,
    // 上下文/输入/输出上限；上下文未声明时回退到最大提示词 token 数
    limit: {
      context: remote.capabilities.limits.max_context_window_tokens ?? remote.capabilities.limits.max_prompt_tokens,
      input: remote.capabilities.limits.max_prompt_tokens,
      output: remote.capabilities.limits.max_output_tokens,
    },
  })
}

type Endpoint = "messages" | "responses" | "chat"

const PACKAGES = {
  messages: "@opencode/ai/providers/anthropic",
  responses: "@opencode/ai/providers/openai-compatible-responses",
  chat: "@opencode/ai/providers/openai-compatible",
} as const satisfies Record<Endpoint, string>

/** The native package and base URL for the Copilot API that serves a model. */
export function routeFor(modelID: string, advertised: Endpoint | undefined, root: string) {
  const selected = advertised ?? fallbackEndpoint(modelID)
  return {
    endpoint: selected,
    package: PACKAGES[selected],
    // Copilot serves Anthropic Messages under /v1 and its OpenAI APIs at the root.
    baseURL: selected === "messages" ? `${root}/v1` : root,
  }
}

function endpoint(supported: ReadonlyArray<string> | undefined): Endpoint | undefined {
  if (supported?.includes("/v1/messages")) return "messages"
  if (supported?.includes("/responses")) return "responses"
  if (supported?.includes("/chat/completions")) return "chat"
}

// Without advertised endpoints, Copilot serves GPT-5 and later (except GPT-5 mini), Grok and MAI Code
// only on /responses, and Gemini and the rest on /chat/completions.
function fallbackEndpoint(modelID: string): Endpoint {
  const gpt = /^gpt-(\d+)/.exec(modelID)
  if (gpt !== null && Number(gpt[1]) >= 5 && !modelID.startsWith("gpt-5-mini")) return "responses"
  if (modelID.startsWith("grok-") || modelID.startsWith("mai-code-")) return "responses"
  return "chat"
}

function variants(remote: UsableModel, messages: boolean): Model.Info["variants"] {
  // 读取支持的推理力度（effort）等级，可能未声明
  const efforts = remote.capabilities.supports.reasoning_effort ?? []
  // 非 messages 端点且声明了力度等级：为每个等级生成 OpenAI Responses 风格的变体
  if (!messages && efforts.length) {
    return efforts.map((effort) => ({
      // 变体 ID 即力度等级名
      id: Model.VariantID.make(effort),
      // 变体设置：推理力度、自动生成推理摘要、并要求回传加密的思考内容
      settings: {
        reasoningEffort: effort,
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      },
    }))
  }
  // messages 端点且支持自适应思考：为每个力度生成 adaptive 思考变体
  if (efforts.length && remote.capabilities.supports.adaptive_thinking) {
    return efforts.map((effort) => ({
      // 变体 ID 即力度等级名
      id: Model.VariantID.make(effort),
      // 变体设置：自适应思考（摘要展示）+ 力度参数
      settings: {
        thinking: {
          type: "adaptive",
          display: "summarized",
        },
        effort,
      },
    }))
  }
  // 读取最大思考预算（token 数）
  const max = remote.capabilities.supports.max_thinking_budget
  // 未声明预算上限则不生成变体
  if (max === undefined) return []
  // 提供 max（预算上限减 1）与 high（约一半预算）两档固定预算变体
  return [
    {
      id: Model.VariantID.make("max"),
      settings: { thinking: { type: "enabled", budgetTokens: max - 1 } },
    },
    {
      id: Model.VariantID.make("high"),
      settings: { thinking: { type: "enabled", budgetTokens: Math.floor(max / 2) } },
    },
  ]
}
