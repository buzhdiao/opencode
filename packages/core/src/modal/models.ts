// 以命名空间方式整体导出本目录下的 models.js 模块，外部可通过 ModalModels.xxx 访问
export * as ModalModels from "./models.js"

// 引入金额（Money）schema：用于表示"美元/每百万 token"的价格单位
import { Money } from "@opencode/schema/money"
// 引入 Effect 核心模块：Effect（副作用容器）、Option（可选值）、Schema（数据建模与校验）
import { Effect, Option, Schema } from "effect"
// 引入 Effect 的 HTTP 客户端模块：HttpClient（客户端）、HttpClientRequest（请求构造）、HttpClientResponse（响应处理）
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
// 引入内部模型信息定义（Model.Info、Model.ID 等）
import { Model } from "../model.js"
// 引入内部供应商定义（Provider.ID、Provider.mergeOverlay 等）
import { Provider } from "../provider.js"

// 定义本文件所属的供应商 ID，固定为 "modal"
const providerID = Provider.ID.make("modal")

// 定义"推理选项"（reasoning option）的 schema：type 固定为 effort（努力程度），values 为可空字符串数组
const ReasoningOption = Schema.Struct({
  // 选项类型，这里只支持 "effort"
  type: Schema.Literal("effort"),
  // 努力程度的候选值列表，元素可为 null（表示未设置）
  values: Schema.Array(Schema.NullOr(Schema.String)),
})

// 定义 Modal 远端模型的 schema：字段基本都可选，以兼容远端返回的不完整数据
const RemoteModel = Schema.Struct({
  // 模型唯一标识
  id: Schema.String,
  // 基础模型 ID（用于映射到已有的模板模型）
  base_model_id: Schema.optional(Schema.String),
  // Hugging Face 上的模型 ID（base_model_id 缺失时用于回退匹配模板）
  hugging_face_id: Schema.optional(Schema.String),
  // 显示名称
  name: Schema.optional(Schema.String),
  // 支持的输入模态（modality，如 text、image）列表
  input_modalities: Schema.optional(Schema.Array(Schema.String)),
  // 支持的输出模态列表
  output_modalities: Schema.optional(Schema.Array(Schema.String)),
  // 上下文长度上限
  context_length: Schema.optional(Schema.Number),
  // 最大输出长度上限
  max_output_length: Schema.optional(Schema.Number),
  // 定价信息（字符串或数字均可，后面统一换算）
  pricing: Schema.optional(
    Schema.Struct({
      // 输入（提示词）单价
      prompt: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
      // 输出（补全）单价
      completion: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
      // 缓存读取单价
      input_cache_read: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
    }),
  ),
  // 支持的采样参数（sampling parameters）名称列表
  supported_sampling_parameters: Schema.optional(Schema.Array(Schema.String)),
  // 支持的特性列表（如 "tools"）
  supported_features: Schema.optional(Schema.Array(Schema.String)),
  // 支持的推理选项列表
  reasoning_options: Schema.optional(Schema.Array(ReasoningOption)),
  // 是否支持交错推理（interleaved reasoning）：布尔值，或指定推理内容字段名的对象
  interleaved: Schema.optional(
    Schema.Union([
      Schema.Boolean,
      Schema.Struct({
        // 推理内容所在的响应字段名
        field: Schema.Literals(["reasoning", "reasoning_content", "reasoning_details"]),
      }),
    ]),
  ),
})

// 定义接口响应的 schema：{ data: unknown[] }，模型列表放在 data 字段中
const Response = Schema.Struct({ data: Schema.Array(Schema.Unknown) })
// 创建"宽容解码"函数：解码失败时返回 None 而不是抛错，便于逐条容错处理
const decodeModel = Schema.decodeUnknownOption(RemoteModel)

// RemoteModel schema 对应的 TypeScript 类型
type RemoteModel = typeof RemoteModel.Type

// 对外入口：加载 Modal 远端模型列表，并与本地已有模型合并，返回最终的模型信息表
export function get(http: HttpClient.HttpClient, baseURL: string, apiKey: string, existing: readonly Model.Info[]) {
  // 先调用 load 拉取远端数据，再用 derive 将其与现有模型合并
  return load(http, baseURL, apiKey).pipe(Effect.map((remote) => derive(baseURL, remote, existing)))
}

// 远端模型快照（snapshot）类型：只读的 RemoteModel 数组
export type Snapshot = readonly RemoteModel[]

// 从 Modal API 拉取模型列表的 Effect 生成器函数
export const load = Effect.fn("ModalModels.load")(function* (
  http: HttpClient.HttpClient,
  baseURL: string,
  apiKey: string,
) {
  // 发起 GET 请求：过滤非 2xx 状态码、携带 Bearer Token 鉴权、把响应体按 Response schema 解析，并整体限时 3 秒
  const response = yield* HttpClient.filterStatusOk(http)
    .execute(HttpClientRequest.get(`${baseURL.replace(/\/+$/, "")}/models`).pipe(HttpClientRequest.bearerToken(apiKey)))
    .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(Response)), Effect.timeout("3 seconds"))
  // Decode each item tolerantly so one malformed entry cannot discard the
  // whole inventory. A malformed envelope still fails the fetch.
  // 对每条数据做宽容解码：某条格式错误只会被丢弃，不会拖垮整个列表
  return response.data.flatMap((raw) => {
    // 尝试解码单条记录，失败时得到 undefined
    const model = Option.getOrUndefined(decodeModel(raw))
    // 解码成功则保留该条，失败则返回空数组（在 flatMap 中被剔除）
    return model ? [model] : []
  })
})

/** Combine remote facts with source templates, never a previously transformed model result. */
// 把远端事实与"源模板"（existing 中的原始定义）合并；模板永远是原始定义，绝不会用上一次转换后的结果做二次叠加
export function derive(baseURL: string, remote: Snapshot, existing: readonly Model.Info[]) {
  // 以模型 ID 建立模板查找表（existing 中的既有模型定义）
  const templates = new Map(existing.map((model) => [model.id, model]))
  // 最终结果表：模型 ID -> 模型信息
  const result = new Map<Model.ID, Model.Info>()
  // 遍历远端返回的每个模型条目
  for (const item of remote) {
    // 依次用 base_model_id、hugging_face_id、id 查找可用的模板模型
    const template = templates.get(Model.ID.make(item.base_model_id ?? item.hugging_face_id ?? item.id))
    // 生成该条目的模型 ID
    const id = Model.ID.make(item.id)
    // 用远端数据 + 模板构建模型信息，写入结果表
    result.set(id, build(id, item, baseURL, template))
  }
  // 返回合并后的模型信息表
  return result
}

// 把远端原始价格换算为"美元/百万 token"（USDPerMillionTokens）；缺失或非法时回退到 fallback
function price(value: string | number | undefined, fallback: Money.USDPerMillionTokens) {
  // 未提供价格时直接使用回退值
  if (value === undefined) return fallback
  // 远端价格按"每 token"计，乘以 1,000,000 换算为每百万 token 的价格
  const parsed = Number(value) * 1_000_000
  // 换算结果是有限数才采用，否则回退（防止 NaN/Infinity 进入 schema）
  return Number.isFinite(parsed) ? Money.USDPerMillionTokens.make(parsed) : fallback
}

// 把远端的上下文/输出长度限制规整为非负整数；缺失或非法时回退到 fallback
function limit(value: number | undefined, fallback: number) {
  // 未提供则用回退值；提供则截断为整数
  const parsed = value === undefined ? fallback : Math.trunc(value)
  // 必须是非负整数才有效，否则使用回退值
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback
}

// 用远端数据构建单个模型信息；previous 是匹配到的本地模板（可能不存在）
function build(id: Model.ID, remote: RemoteModel, baseURL: string, previous?: Model.Info) {
  // 取模板中第一个价格档位，作为定价的缺省基准
  const cost = previous?.cost[0]
  // 取模板中的输入价格限制（可能未定义）
  const input = previous?.limit.input
  // 构建完整的模型信息对象
  return Model.Info.make({
    // 先展开该供应商的默认模型信息作为底座
    ...Model.Info.default(providerID, id),
    // 模型 ID
    id,
    // 远端模型 ID
    modelID: Model.ID.make(remote.id),
    // 供应商 ID（modal）
    providerID,
    // 名称优先级：远端名称 > 模板名称 > 远端 ID
    name: remote.name ?? previous?.name ?? remote.id,
    // 模型家族（family）沿用模板
    family: previous?.family,
    // 兼容性：远端声明了 interleaved 时按其推导，否则沿用模板
    compatibility:
      remote.interleaved === undefined
        ? previous?.compatibility
        : (Model.compatibility(remote.interleaved) ?? previous?.compatibility),
    // 使用的 AI SDK 适配包（openai 兼容协议）
    package: "@opencode/ai/providers/openai-compatible",
    // 设置：把 baseURL 与 provider 覆盖项合并进模板已有设置
    settings: Provider.mergeOverlay(previous?.settings, { baseURL, provider: providerID }),
    // 自定义请求头沿用模板
    headers: previous?.headers,
    // 附加请求体沿用模板
    body: previous?.body,
    // 能力集合：工具调用 / 输入模态 / 输出模态，逐项回退到模板或默认值
    capabilities: {
      // 是否支持工具调用：远端特性列表包含 "tools"，否则沿用模板，最终默认 true
      tools: remote.supported_features?.includes("tools") ?? previous?.capabilities.tools ?? true,
      // 输入模态：远端声明 > 模板 > 默认仅文本
      input: remote.input_modalities ?? previous?.capabilities.input ?? ["text"],
      // 输出模态：远端声明 > 模板 > 默认仅文本
      output: remote.output_modalities ?? previous?.capabilities.output ?? ["text"],
    },
    // 推理变体（variants）：远端给出 reasoning_options 时重新生成，否则沿用模板（默认空数组）
    variants: remote.reasoning_options === undefined ? (previous?.variants ?? []) : variants(remote),
    // 时间信息沿用模板，缺省 released 为 0
    time: previous?.time ?? { released: 0 },
    // 价格档位：输入 / 输出 / 缓存读写，逐项回退到模板或零价
    cost: [
      {
        // 输入单价：远端 pricing.prompt，缺省用模板价，再缺省为零价
        input: price(remote.pricing?.prompt, cost?.input ?? Money.USDPerMillionTokens.zero),
        // 输出单价：远端 pricing.completion，缺省用模板价，再缺省为零价
        output: price(remote.pricing?.completion, cost?.output ?? Money.USDPerMillionTokens.zero),
        // 缓存价格：读价由远端提供，写价远端未提供、沿用模板
        cache: {
          // 缓存读取单价
          read: price(remote.pricing?.input_cache_read, cost?.cache.read ?? Money.USDPerMillionTokens.zero),
          // 缓存写入单价（远端未提供，沿用模板或零价）
          write: cost?.cache.write ?? Money.USDPerMillionTokens.zero,
        },
      },
    ],
    // 状态沿用模板，默认 active（可用）
    status: previous?.status ?? "active",
    // 是否启用沿用模板，默认启用
    enabled: previous?.enabled ?? true,
    // 长度限制：上下文 / 输入 / 输出
    limit: {
      // 上下文长度上限：远端声明优先，否则用模板，再否则 0
      context: limit(remote.context_length, previous?.limit.context ?? 0),
      // 输入限制仅在模板中存在时才写入（避免覆盖为 undefined）
      ...(input === undefined ? {} : { input }),
      // 输出长度上限：远端声明优先，否则用模板，再否则 0
      output: limit(remote.max_output_length, previous?.limit.output ?? 0),
    },
  })
}

// 从远端的 reasoning_options 生成去重后的推理变体列表
function variants(remote: RemoteModel): Model.Info["variants"] {
  // 已见 effort 值 -> 变体的映射，用于去重
  const seen = new Map<string, Model.Info["variants"][number]>()
  // 遍历每个推理选项及其候选值
  for (const option of remote.reasoning_options ?? []) {
    for (const value of option.values) {
      // null 视为 "none"（不设置努力程度）
      const effort = value ?? "none"
      // 只保留第一次出现的 effort，避免生成重复变体
      if (!seen.has(effort))
        seen.set(effort, { id: Model.VariantID.make(effort), settings: { reasoningEffort: effort } })
    }
  }
  // 返回去重后的变体数组
  return [...seen.values()]
}
