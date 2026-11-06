// 引入 Effect 的 Option（可选值容器）与 Schema（数据建模与校验）工具
import { Option, Schema } from "effect"

// models.dev v1 catalogs (`/api.json`), still accepted from OPENCODE_MODELS_PATH and custom
// OPENCODE_MODELS_URL mirrors. They are converted to the v2 shape, then decoded like any v2 catalog.
// v1 can't say everything v2 does (one API per model, broad modality kinds), so a converted catalog
// behaves as v1 did.
// 本文件负责 models.dev 的 v1 目录格式（/api.json）：仍支持从 OPENCODE_MODELS_PATH 与自定义
// OPENCODE_MODELS_URL 镜像读取；先转换为 v2 结构，再按普通 v2 目录一样解码。
// v1 表达不了 v2 的全部信息（每个模型只有一种 API、模态种类较粗），因此转换后的目录行为与 v1 一致。

// 价格字段的基础 schema：必须是有限数字（Finite）
const Price = Schema.Finite
// v1 的费用（cost）结构 schema：输入/输出/缓存读写价格，以及按上下文大小分档的 tiers
const Cost = Schema.Struct({
  // 输入（提示词）单价
  input: Schema.optional(Price),
  // 输出（补全）单价
  output: Schema.optional(Price),
  // 缓存读取单价
  cache_read: Schema.optional(Price),
  // 缓存写入单价
  cache_write: Schema.optional(Price),
  // 价格分档列表：上下文超过某阈值后采用不同价格
  tiers: Schema.optional(
    Schema.Array(
      Schema.Struct({
        // 分档条件：上下文大小阈值
        tier: Schema.Struct({ size: Schema.Finite }),
        // 该档位的输入单价
        input: Schema.optional(Price),
        // 该档位的输出单价
        output: Schema.optional(Price),
        // 该档位的缓存读取单价
        cache_read: Schema.optional(Price),
        // 该档位的缓存写入单价
        cache_write: Schema.optional(Price),
      }),
    ),
  ),
})
// Cost schema 对应的 TypeScript 类型
type Cost = typeof Cost.Type

// v1 的模型（model）结构 schema
const Model = Schema.Struct({
  // 模型唯一标识
  id: Schema.String,
  // 显示名称
  name: Schema.String,
  // 模型类型（如 chat）
  type: Schema.optional(Schema.String),
  // 模型家族
  family: Schema.optional(Schema.String),
  // 发布日期
  release_date: Schema.String,
  // 状态（如 deprecated）
  status: Schema.optional(Schema.String),
  // 是否支持推理（reasoning）
  reasoning: Schema.optional(Schema.Boolean),
  // 推理选项列表：类型（effort/budget_tokens/toggle）、候选值、最小/最大预算
  reasoning_options: Schema.optional(
    Schema.Array(
      Schema.Struct({
        // 选项类型
        type: Schema.String,
        // 候选值列表（可空字符串）
        values: Schema.optional(Schema.Array(Schema.NullOr(Schema.String))),
        // 预算下限（用于 budget_tokens 类型）
        min: Schema.optional(Schema.Finite),
        // 预算上限
        max: Schema.optional(Schema.Finite),
      }),
    ),
  ),
  // 是否支持温度（temperature）参数
  temperature: Schema.optional(Schema.Boolean),
  // 是否支持工具调用（tool call）
  tool_call: Schema.optional(Schema.Boolean),
  // 是否支持交错推理：布尔值、字段名字符串、或指定字段名的对象
  interleaved: Schema.optional(Schema.Union([Schema.Boolean, Schema.String, Schema.Struct({ field: Schema.String })])),
  // 费用信息
  cost: Schema.optional(Cost),
  // 长度限制：字符串键 -> 有限数字（如 context、output）
  limit: Schema.optional(Schema.Record(Schema.String, Schema.Finite)),
  // 输入/输出模态列表
  modalities: Schema.optional(
    Schema.Struct({ input: Schema.Array(Schema.String), output: Schema.Array(Schema.String) }),
  ),
  // 实验性配置：各模式（mode）下的费用与供应商覆盖项
  experimental: Schema.optional(
    Schema.Struct({
      // 模式名 -> 模式配置
      modes: Schema.optional(
        Schema.Record(
          Schema.String,
          Schema.Struct({
            // 该模式下的费用
            cost: Schema.optional(Cost),
            // 该模式下的供应商覆盖：额外请求体与请求头
            provider: Schema.optional(
              Schema.Struct({
                // 额外请求体字段
                body: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
                // 额外请求头
                headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
              }),
            ),
          }),
        ),
      ),
    }),
  ),
  // 模型级别的供应商覆盖：npm 包、API 地址、协议形态
  provider: Schema.optional(
    Schema.Struct({
      // 指定使用的 AI SDK npm 包
      npm: Schema.optional(Schema.String),
      // 指定 API 地址
      api: Schema.optional(Schema.String),
      // 指定协议形态（如 responses）
      shape: Schema.optional(Schema.String),
    }),
  ),
})
// Model schema 对应的 TypeScript 类型
type Model = typeof Model.Type

// v1 的供应商（provider）结构 schema
const Provider = Schema.Struct({
  // 供应商唯一标识
  id: Schema.String,
  // 显示名称
  name: Schema.String,
  // 读取 API Key 所需的环境变量名列表
  env: Schema.Array(Schema.String),
  // 使用的 AI SDK npm 包（v1 必填，v2 没有此字段）
  npm: Schema.String,
  // API 地址
  api: Schema.optional(Schema.String),
  // 模型表：模型 ID -> 任意结构（稍后逐个解码）
  models: Schema.Record(Schema.String, Schema.Unknown),
})

// 供应商的宽容解码函数：失败返回 None 而不抛错
const decodeProvider = Schema.decodeUnknownOption(Provider)
// 模型的宽容解码函数：失败返回 None 而不抛错
const decodeModel = Schema.decodeUnknownOption(Model)
// 只检查 { npm: string } 的宽容解码函数，用于识别 v1 供应商
const HasNpm = Schema.decodeUnknownOption(Schema.Struct({ npm: Schema.String }))

/** v1 providers always name an AI SDK package (`npm`); v2 providers never do. */
// 判断目录是否为 v1 格式：只要有一个供应商带 npm 字段（AI SDK 包名）就视为 v1
export function isV1(catalog: Record<string, unknown>) {
  // 遍历目录中的所有供应商，任一解码出 npm 字段即为 v1
  return Object.values(catalog).some((provider) => Option.isSome(HasNpm(provider)))
}

// 把整个 v1 目录转换为 v2 结构：逐个供应商、逐个模型地转换，无法解码的条目直接跳过
export function toV2(catalog: Record<string, unknown>): Record<string, unknown> {
  // 对目录的每个键值对做转换后重组为对象
  return Object.fromEntries(
    Object.entries(catalog).flatMap(([key, value]) => {
      // 宽容解码供应商；解不开则返回空数组（该供应商被丢弃）
      const provider = Option.getOrUndefined(decodeProvider(value))
      if (!provider) return []
      // 转换该供应商下的每个模型，解不开的模型同样被丢弃
      const models = Object.entries(provider.models).flatMap(([id, value]) => {
        // 宽容解码单个模型
        const model = Option.getOrUndefined(decodeModel(value))
        // 成功则产出 [id, v2模型] 二元组，失败则剔除
        return model ? [[id, convertModel(model, provider)] as const] : []
      })
      // 产出 v2 形态的供应商条目（只保留 v2 认识的字段）
      return [[key, { id: provider.id, name: provider.name, env: provider.env, models: Object.fromEntries(models) }]]
    }),
  )
}

// The AI SDK packages that call the Responses API unless told otherwise.
// 这些 AI SDK 包在未显式指定协议时默认调用 Responses API
const RESPONSES_BY_DEFAULT = new Set(["@ai-sdk/openai", "@ai-sdk/azure", "@ai-sdk/xai"])

// 把单个 v1 模型转换为 v2 结构
function convertModel(model: Model, provider: typeof Provider.Type) {
  // 使用的 AI SDK 包：模型级覆盖优先，否则用供应商级
  const npm = model.provider?.npm ?? provider.npm
  // 模型级指定的协议形态（如 "responses"）
  const shape = model.provider?.shape
  // 推导协议：显式声明 responses、或未声明但 SDK 默认走 Responses API 时用 responses，否则用 chat-completions
  const protocol =
    shape === "responses" || (shape === undefined && RESPONSES_BY_DEFAULT.has(npm)) ? "responses" : "chat-completions"
  // 提取交错推理（interleaved）的推理内容字段名：字符串形式直接用，对象形式取 field，布尔形式无字段
  const field =
    typeof model.interleaved === "string"
      ? model.interleaved
      : typeof model.interleaved === "object"
        ? model.interleaved.field
        : undefined
  // 组装 v2 形态的模型对象
  return {
    // 模型 ID
    id: model.id,
    // 类型缺省为 chat
    type: model.type ?? "chat",
    // 显示名称
    name: model.name,
    // 模型家族
    family: model.family,
    // 发布日期
    release_date: model.release_date,
    // 状态
    status: model.status,
    // 模态缺省为纯文本输入输出
    modalities: model.modalities ?? { input: ["text"], output: ["text"] },
    // 能力集合：工具调用、推理、温度
    capabilities: {
      // 工具调用支持（v1 的 tool_call，缺省 false）
      tools: { supported: model.tool_call ?? false },
      // 推理能力：由 reasoning 与 reasoning_options 推导
      reasoning: reasoning(model),
      // 温度支持
      temperature: model.temperature,
    },
    // 长度限制原样保留
    limit: model.limit,
    // 费用：存在时才转换
    cost: model.cost && cost(model.cost),
    // API 配置：按推导出的协议生成对应键
    api: {
      [protocol]: {
        // 基础地址：模型级 > 供应商级 > 空串
        base_url: model.provider?.api ?? provider.api ?? "",
        // 使用的 AI SDK 包
        sdk: { aisdk: npm },
        // 若存在推理内容字段名，则写入兼容性配置
        ...(field ? { compatibility: { reasoning_field: field } } : {}),
      },
    },
    // 实验性模式：存在时逐个转换（费用 + 请求体/请求头覆盖）
    experimental: model.experimental?.modes && {
      modes: Object.fromEntries(
        Object.entries(model.experimental.modes).map(([name, mode]) => [
          // 模式名保持不变
          name,
          // 转换该模式的费用与供应商覆盖项
          { cost: mode.cost && cost(mode.cost), body: mode.provider?.body, headers: mode.provider?.headers },
        ]),
      ),
    },
  }
}

// 从 v1 的 reasoning 与 reasoning_options 推导出 v2 的推理能力描述
function reasoning(model: Model) {
  // 不支持推理时返回固定结构
  if (!model.reasoning) return { supported: false }
  // 推理选项列表（可能未提供）
  const options = model.reasoning_options ?? []
  // 找到 effort（努力程度）型选项
  const effort = options.find((option) => option.type === "effort")
  // 找到 budget_tokens（令牌预算）型选项
  const budget = options.find((option) => option.type === "budget_tokens")
  // 组装推理能力描述
  return {
    // 支持推理
    supported: true,
    // 存在 toggle 型选项时标记支持开关式推理
    ...(options.some((option) => option.type === "toggle") ? { toggle: true } : {}),
    // 有 effort 选项时输出候选值列表（过滤掉 null 与字面量 "null"）
    ...(effort
      ? { effort: (effort.values ?? []).filter((value): value is string => value !== null && value !== "null") }
      : {}),
    // 有 budget 选项时输出预算上下限（仅包含实际提供的字段）
    ...(budget
      ? {
          budget: {
            // 预算下限（存在时才写入）
            ...(budget.min !== undefined ? { min: budget.min } : {}),
            // 预算上限（存在时才写入）
            ...(budget.max !== undefined ? { max: budget.max } : {}),
          },
        }
      : {}),
  }
}

// v1 tiers are context bands; v2 says the same with `context` overrides.
// v1 的价格分档（tiers）是"上下文区间"；v2 用 context 条件覆盖项表达同样的语义
function cost(input: Cost) {
  // 取分档列表（可能未提供）
  const tiers = input.tiers ?? []
  // 组装 v2 形态的费用结构
  return {
    text: {
      input: {
        // 输入基础单价（缺省 0）
        price: input.input ?? 0,
        // 缓存读写价格
        cache: { read: input.cache_read, write: input.cache_write },
        // 每个分档转换为一条"上下文大于阈值时生效"的输入价覆盖项
        overrides: tiers.map((tier) => ({
          // 触发条件：上下文长度超过该档阈值
          when: { context: { gt: tier.tier.size } },
          // 该档输入单价
          price: tier.input,
          // 该档缓存读写价格
          cache: { read: tier.cache_read, write: tier.cache_write },
        })),
      },
      output: {
        // 输出基础单价（缺省 0）
        price: input.output ?? 0,
        // 每个分档转换为一条输出价覆盖项
        overrides: tiers.map((tier) => ({ when: { context: { gt: tier.tier.size } }, price: tier.output })),
      },
    },
  }
}
