// 以命名空间形式导出 Variant 模块
export * as Variant from "./variant.js"

// 引入配置中提供方推理能力 schema
import { ConfigProvider } from "@opencode/schema/config/provider"
// 引入模型服务（Info 类型与 VariantID）
import { Model } from "./model.js"
// 引入提供方服务（aisdk 包名映射）
import { Provider } from "./provider.js"

// 推理控制能力描述：档位（effort）/ 开关（toggle）/ 令牌预算（budget_tokens）
export type Support =
  | { readonly type: "effort"; readonly values?: readonly string[] }
  | { readonly type: "toggle" }
  | { readonly type: "budget_tokens"; readonly min?: number; readonly max?: number }

/** Reasoning controls in models.dev v2's shape, where `default` is the provider default rather than a variant. */
// （中文）把 models.dev v2 形状的推理控制转换为 Support 列表；其中 `default` 是提供方默认值而非一个变体
export function supports(reasoning: ConfigProvider.Reasoning): readonly Support[] {
  // 不支持推理则没有任何变体
  if (!reasoning.supported) return []
  // 按能力逐项拼装：开关、档位（过滤掉 default 值）、令牌预算
  return [
    ...(reasoning.toggle ? [{ type: "toggle" as const }] : []),
    ...(reasoning.effort
      ? [{ type: "effort" as const, values: reasoning.effort.filter((value) => value !== "default") }]
      : []),
    ...(reasoning.budget ? [{ type: "budget_tokens" as const, ...reasoning.budget }] : []),
  ]
}

// 变体列表类型别名
type Variants = Model.Info["variants"]
// 变体覆盖项：除 id 外的字段（settings/body 等）
type Overlay = Omit<Variants[number], "id">

// 协议函数类型：给定模型与能力，产出变体列表
type Protocol = (model: Model.Info, support: Support) => Variants

// （中文）由模型与其推理能力解析出可用变体；默认按“档位”能力处理
export function resolve(model: Model.Info, supports: readonly Support[] = [{ type: "effort" }]): Variants {
  // 按模型所属协议包名查找对应的协议函数
  const protocol = model.package === undefined ? undefined : PROTOCOLS[model.package]
  // 未知包则没有变体
  if (!protocol) return []
  // 有开关能力时生成开关变体（none/thinking）
  const toggle = supports.some((support) => support.type === "toggle") ? protocol(model, { type: "toggle" }) : []
  // 找出档位与预算两种能力
  const effort = supports.find((support) => support.type === "effort")
  const budget = supports.find((support) => support.type === "budget_tokens")
  // 主变体优先按档位生成，其次按预算，最后退回开关
  const main = effort ? protocol(model, effort) : budget ? protocol(model, budget) : toggle
  // 把开关生成的 "none" 变体排在最前，便于表达“关闭思考”
  const variants = [...toggle.filter((variant) => variant.id === "none"), ...main]
  // 按 id 去重（保留首次出现）
  return variants.filter((variant, index) => variants.findIndex((other) => other.id === variant.id) === index)
}

// 通用档位取值
const EFFORTS = ["low", "medium", "high"]
// Responses API 的加密推理包含项
const ENCRYPTED_REASONING = ["reasoning.encrypted_content"]
// 自适应思考配置（摘要式展示）
const ADAPTIVE_THINKING = { type: "adaptive", display: "summarized" }
// Anthropic 的输出 token 上限
const ANTHROPIC_OUTPUT_TOKEN_MAX = 32_000
// Alibaba thinking budget variants stay under 64k instead of reaching the model's whole output limit.
// （中文）Alibaba 的思考预算变体保持在 64k 以下，而不是顶到模型的全部输出上限
const ALIBABA_THINKING_BUDGET_MAX = 64_000

// 构造变体的便捷函数：ID + 覆盖项
const variant = (id: string, overlay: Overlay): Variants[number] => ({ id: Model.VariantID.make(id), ...overlay })

// 为一组档位值生成变体
const efforts = (values: readonly string[], spell: (effort: string) => Overlay): Variants =>
  values.map((effort) => variant(effort, spell(effort)))

// 生成一对开关变体：off（"none"）与 on（"thinking"）
const toggle = (off: Overlay, on: Overlay): Variants => [variant("none", off), variant("thinking", on)]

// （中文）按令牌预算生成 high/max 两个变体；预算上限可由调用方覆盖
function budgets(
  model: Model.Info,
  support: Extract<Support, { type: "budget_tokens" }>,
  spell: (tokens: number) => Overlay,
  ceiling = model.limit.output,
): Variants {
  // 预算上限：取支持的上限、模型输出上限（各留 1）中的最小值
  const maximum = Math.min(support.max ?? ceiling - 1, model.limit.output - 1, ceiling - 1)
  // 没有有效预算则不生成变体
  if (maximum <= 0) return []
  // high 档：在不低于支持的下限、不超过上限的前提下取半数
  const high = Math.min(Math.max(support.min ?? 0, Math.floor((maximum + 1) / 2)), maximum)
  // 生成 high 与 max 两个变体
  return [variant("high", spell(high)), variant("max", spell(maximum))]
}

// 取模型的可读 ID（modelID 优先于完整 id）
const modelID = (model: Model.Info) => model.modelID ?? model.id

// （中文）解析 Claude 模型的家族与版本信息
function claudeInfo(model: Model.Info) {
  // 模型 ID
  const id = modelID(model)
  // 家族在前：如 opus-4-5 / claude-opus-4.5
  const familyFirst = /(?:claude-)?(opus|sonnet|haiku|fable|mythos)-(\d+)(?:[.-](\d+))?/i.exec(id)
  // 版本在前：如 claude-3-7-sonnet
  const versionFirst = /claude-(\d+)(?:[.-](\d+))?-(opus|sonnet|haiku|fable|mythos)/i.exec(id)
  // 家族名（小写）
  const family = (familyFirst?.[1] ?? versionFirst?.[3])?.toLowerCase()
  // 主版本号
  const major = Number(familyFirst?.[2] ?? versionFirst?.[1])
  // 次版本号（缺省 0）
  const minor = Number(familyFirst?.[3] ?? versionFirst?.[2] ?? 0)
  return {
    family,
    major,
    minor,
    // 需要手动（budgetTokens 式）思考的旧版本：3.7 与 4.6 之前的 4.x
    manual: (major === 3 && minor === 7) || (major === 4 && minor < 6),
    // 始终开启思考的家族：fable / mythos（含 mythos-preview）
    always: family === "fable" || family === "mythos" || id.toLowerCase().includes("mythos-preview"),
  }
}

// （中文）手动思考的覆盖项：预算取 16k 与输出上限中的较小者（至少 1024）
function manualThinking(model: Model.Info): Overlay | undefined {
  // 计算预算
  const tokens = Math.min(16_000, model.limit.output - 1)
  // 预算太小则不提供
  if (tokens < 1024) return
  // 返回开启思考的设置
  return { settings: { thinking: { type: "enabled", budgetTokens: tokens } } }
}

// OpenAI Chat 协议：仅支持档位，映射为 reasoningEffort 设置
const openaiChat: Protocol = (_, support) => {
  // 非档位能力不支持
  if (support.type !== "effort") return []
  // 按给定档位值（缺省 low/medium/high）生成变体
  return efforts(support.values ?? EFFORTS, (effort) => ({ settings: { reasoningEffort: effort } }))
}

// Vertex MaaS models switch thinking through the chat template. DeepSeek names the flag `thinking`; the
// others (GLM, Gemma) use `enable_thinking`.
// （中文）Vertex MaaS 模型通过聊天模板开关思考。DeepSeek 的旗标叫 `thinking`；其余（GLM、Gemma）用 `enable_thinking`
const vertexChat: Protocol = (model, support) => {
  // 非开关能力时退回 OpenAI Chat 处理
  if (support.type !== "toggle") return openaiChat(model, support)
  // 按模型选择模板旗标名
  const key = modelID(model).toLowerCase().includes("deepseek") ? "thinking" : "enable_thinking"
  // 生成开/关两个模板参数变体
  return toggle(
    { body: { chat_template_kwargs: { [key]: false } } },
    { body: { chat_template_kwargs: { [key]: true } } },
  )
}

// OpenAI Responses 协议：档位含 none/minimal 到 xhigh
const openaiResponses: Protocol = (_, support) => {
  // 非档位能力不支持
  if (support.type !== "effort") return []
  // 按给定档位值生成变体（缺省 none/minimal/low/medium/high/xhigh）
  return efforts(support.values ?? ["none", "minimal", ...EFFORTS, "xhigh"], responsesEffort)
}

// Responses 协议的档位覆盖项：推理档位 + 自动摘要 + 加密推理
const responsesEffort = (effort: string): Overlay => ({
  settings: { reasoningEffort: effort, reasoningSummary: "auto", include: ENCRYPTED_REASONING },
})

// 通用 OpenAI Responses 兼容协议：仅常规档位
const openResponses: Protocol = (_, support) => {
  // 非档位能力不支持
  if (support.type !== "effort") return []
  // 按给定档位值生成变体
  return efforts(support.values ?? EFFORTS, responsesEffort)
}

// Google Interactions 协议：thinkingLevel + 自动思考摘要
const googleInteractions: Protocol = (_, support) => {
  // 非档位能力不支持
  if (support.type !== "effort") return []
  // 按给定档位值生成变体
  return efforts(support.values ?? EFFORTS, (effort) => ({
    settings: { thinkingLevel: effort, thinkingSummaries: "auto" },
  }))
}

// Cloudflare AI 网关：按模型前缀分流到对应协议
const cloudflareAIGateway: Protocol = (model, support) => {
  // 模型 ID
  const id = modelID(model)
  // openai/ 前缀走 Responses 协议
  if (id.startsWith("openai/")) return openaiResponses(model, support)
  // anthropic/ 前缀走 Anthropic 协议
  if (id.startsWith("anthropic/")) return anthropicMessages(model, support)
  // 其余走 OpenAI Chat 协议
  return openaiChat(model, support)
}

// DeepSeek Chat 协议：档位/开关；预算不支持
const deepseekChat: Protocol = (_, support) => {
  // 按能力类型分发
  switch (support.type) {
    case "effort":
      // none 关思考，其余开思考并设置档位
      return efforts(support.values ?? ["low", "high", "max"], (effort) => {
        if (effort === "none") return { body: { thinking: { type: "disabled" } } }
        return { settings: { reasoningEffort: effort }, body: { thinking: { type: "enabled" } } }
      })
    case "toggle":
      // 开关变体：body.thinking 禁用/启用
      return toggle({ body: { thinking: { type: "disabled" } } }, { body: { thinking: { type: "enabled" } } })
    case "budget_tokens":
      // 预算不支持
      return []
  }
}

// NVIDIA 模板参数覆盖项
const nvidiaTemplate = (chat_template_kwargs: Record<string, unknown>): Overlay => ({
  body: { chat_template_kwargs },
})

// NVIDIA 开关变体（按给定旗标名）
const nvidiaToggle = (key: string): Variants =>
  toggle(nvidiaTemplate({ [key]: false }), nvidiaTemplate({ [key]: true }))

// NVIDIA NIM 协议：按模型家族选择思考控制方式
const nvidiaChat: Protocol = (model, support) => {
  // 小写模型 ID
  const id = modelID(model).toLowerCase()
  // DeepSeek V4：开关或档位（none 关思考）
  if (id.includes("deepseek-v4")) {
    // 开关变体
    if (support.type === "toggle") return nvidiaToggle("thinking")
    // 非档位能力不支持
    if (support.type !== "effort") return []
    // none 关思考，其余开思考并设置档位
    return efforts(support.values ?? ["none", "high", "max"], (effort) =>
      effort === "none"
        ? nvidiaTemplate({ thinking: false })
        : nvidiaTemplate({ thinking: true, reasoning_effort: effort }),
    )
  }
  // Kimi K2.6 仅支持开关
  if (id.includes("kimi-k2.6") || id.includes("kimi-k2-6")) return nvidiaToggle("thinking")
  // Kimi K3：开关或档位
  if (id.includes("kimi-k3")) {
    // 开关变体
    if (support.type === "toggle") return nvidiaToggle("thinking")
    // 非档位能力不支持
    if (support.type !== "effort") return []
    // 档位映射为 reasoningEffort 设置
    return efforts(support.values ?? ["low", "high", "max"], (effort) => ({
      settings: { reasoningEffort: effort },
    }))
  }
  // MiniMax M3：thinking_mode 开关
  if (id.includes("minimax-m3"))
    return toggle(nvidiaTemplate({ thinking_mode: "disabled" }), nvidiaTemplate({ thinking_mode: "enabled" }))
  // GLM：enable_thinking 开关，并附带 clear_thinking: false
  if (id.includes("glm"))
    return toggle(
      nvidiaTemplate({ enable_thinking: false }),
      nvidiaTemplate({ enable_thinking: true, clear_thinking: false }),
    )
  // Qwen/Gemma/Nemotron 仅支持开关式
  const toggleOnly = id.includes("qwen") || id.includes("gemma") || id.includes("nemotron")
  // 按能力类型分发
  switch (support.type) {
    case "effort":
      // 仅开关型模型且未指定档位值时退化为开关；否则走 OpenAI Chat
      return toggleOnly && support.values === undefined ? nvidiaToggle("enable_thinking") : openaiChat(model, support)
    case "toggle":
      // 默认 enable_thinking 开关
      return nvidiaToggle("enable_thinking")
    case "budget_tokens":
      // 预算经模板参数与 reasoning_budget 传递
      return budgets(model, support, (tokens) => ({
        body: { chat_template_kwargs: { enable_thinking: true }, reasoning_budget: tokens },
      }))
  }
}

// Workers AI ignores or rejects `reasoning_effort: "none"` on most models. Kimi's chat template reads
// `thinking`; the others read `enable_thinking`, so both are sent.
// （中文）Workers AI 在多数模型上会忽略或拒绝 `reasoning_effort: "none"`。Kimi 的聊天模板读取 `thinking`；
// 其余读取 `enable_thinking`，因此两者都发送
const workersAITemplate = (thinking: boolean): Overlay => ({
  body: { chat_template_kwargs: { enable_thinking: thinking, thinking } },
})

// Workers AI 协议：档位/开关；预算不支持
const workersAIChat: Protocol = (_, support) => {
  // 按能力类型分发
  switch (support.type) {
    case "effort":
      // none 关思考，其余用标准档位设置
      return efforts(support.values ?? EFFORTS, (effort) =>
        effort === "none" ? workersAITemplate(false) : { settings: { reasoningEffort: effort } },
      )
    case "toggle":
      // 开关变体：同时发送两个旗标
      return toggle(workersAITemplate(false), workersAITemplate(true))
    case "budget_tokens":
      // 预算不支持
      return []
  }
}

// Baseten 模板参数覆盖项
const basetenTemplate = (enable_thinking: boolean): Overlay => ({
  body: { chat_template_args: { enable_thinking } },
})

// Baseten 协议：档位/开关
const basetenChat: Protocol = (model, support) => {
  // 小写模型 ID
  const id = modelID(model).toLowerCase()
  // 按能力类型分发
  switch (support.type) {
    case "effort": {
      // GLM 5.2 系列需要模板参数同步开关
      const glm = id.includes("glm-5.2") || id.includes("glm-5-2") || id.includes("glm-5p2")
      // 档位映射为 reasoningEffort，并按需附加模板参数
      return efforts(support.values ?? EFFORTS, (effort) => ({
        settings: { reasoningEffort: effort },
        ...(glm ? basetenTemplate(effort !== "none") : {}),
        ...(id.includes("deepseek-v4-pro-0813") && effort !== "none"
          ? { body: { thinking: { type: "enabled" } } }
          : {}),
      }))
    }
    case "toggle":
      // 开关变体：模板参数
      return toggle(basetenTemplate(false), basetenTemplate(true))
    case "budget_tokens":
      // 预算不支持
      return []
  }
}

// DeepInfra 协议；K2.7-code 不支持思考变体
const deepinfraChat: Protocol = (model, support) => {
  // K2.7-code 直接不生成
  if (/kimi[-.]?k2[.-]7-code/i.test(modelID(model))) return []
  // 按能力类型分发
  switch (support.type) {
    case "effort":
      // 档位映射为 reasoningEffort 设置
      return efforts(support.values ?? EFFORTS, (effort) => ({ settings: { reasoningEffort: effort } }))
    case "toggle":
      // 开关变体：body.reasoning
      return toggle({ body: { reasoning: { enabled: false } } }, { body: { reasoning: { enabled: true } } })
    case "budget_tokens":
      // 预算不支持
      return []
  }
}

// 通用 OpenAI 兼容协议：NVIDIA 走专用逻辑，其余走标准 OpenAI Chat
const openaiCompatible: Protocol = (model, support) => {
  // NVIDIA 提供方特判
  if (model.providerID === "nvidia") return nvidiaChat(model, support)
  // 其余走标准 OpenAI Chat
  return openaiChat(model, support)
}

// Venice 协议：档位用 reasoningEffort，开关用 reasoning.enabled
const veniceChat: Protocol = (_, support) => {
  // 档位变体
  if (support.type === "effort")
    return efforts(support.values ?? EFFORTS, (effort) => ({ settings: { reasoningEffort: effort } }))
  // 开关变体
  if (support.type === "toggle")
    return toggle({ settings: { reasoning: { enabled: false } } }, { settings: { reasoning: { enabled: true } } })
  // 预算不支持
  return []
}

// Moonshot Chat 协议：K2.5/K2.6 可开关；固定思考型无变体
const moonshotChat: Protocol = (model, support) => {
  // 小写模型 ID
  const id = modelID(model).toLowerCase()
  // 可开关的型号
  const toggleable = id.includes("k2.5") || id.includes("k2-5") || id.includes("k2.6") || id.includes("k2-6")
  // 思考固定的型号
  const fixed = id.includes("k2-thinking") || id.includes("k2.7-code") || id.includes("k2-7-code")
  // 固定思考型不生成变体
  if (fixed) return []
  // 可开关型号且为纯开关/未指定档位值时，生成开/关变体
  if (toggleable && (support.type === "toggle" || (support.type === "effort" && support.values === undefined)))
    return toggle({ settings: { thinking: { type: "disabled" } } }, { settings: { thinking: { type: "enabled" } } })
  // 其余可开关型号或非档位能力不生成变体
  if (toggleable || support.type !== "effort") return []
  // 档位映射为 reasoningEffort 设置
  return efforts(support.values ?? ["low", "high", "max"], (effort) => ({
    settings: { reasoningEffort: effort },
  }))
}

// Alibaba Chat 协议：enableThinking 设置
const alibabaChat: Protocol = (model, support) => {
  // 小写模型 ID
  const id = modelID(model).toLowerCase()
  // 思考固定的型号（不可调）
  const fixed =
    id.includes("-thinking") || id.includes("qwq") || id.includes("deepseek-r1") || id.includes("minimax-m2")
  // 按能力类型分发
  switch (support.type) {
    case "effort": {
      // 固定思考型且未显式给档位值时不生成
      if (fixed && support.values === undefined) return []
      // 托管的 GLM/DeepSeek 仅提供 high/max
      const hosted = id.includes("glm") || id.includes("deepseek")
      // 解析档位值
      const values = support.values ?? (hosted ? ["high", "max"] : ["low", "medium", "xhigh"])
      // none 关思考，其余开思考并设置档位
      return efforts(values, (effort) => {
        if (effort === "none") return { settings: { enableThinking: false } }
        return { settings: { enableThinking: true, reasoningEffort: effort } }
      })
    }
    case "toggle":
      // 开关变体：enableThinking
      return toggle({ settings: { enableThinking: false } }, { settings: { enableThinking: true } })
    case "budget_tokens":
      // 预算受 Alibaba 特有的 64k 上限约束
      return budgets(
        model,
        support,
        (tokens) => ({ settings: { enableThinking: true, thinkingBudget: tokens } }),
        ALIBABA_THINKING_BUDGET_MAX,
      )
  }
}

// Zai（智谱）Chat 协议：按 GLM 版本与套餐区分
const zaiChat: Protocol = (model, support) => {
  // 小写模型 ID
  const id = modelID(model).toLowerCase()
  // 解析 GLM 主/次版本
  const version = /glm-?(\d+)(?:(?:[.-]|p)(\d+))?/.exec(id)
  const major = Number(version?.[1])
  const minor = Number(version?.[2] ?? 0)
  // 是否为编码套餐
  const coding = model.package?.includes("zai-coding-plan") ?? false
  // 最新形态（编码套餐、未知版本或 GLM 5.3+）：思考始终开启，无需开关
  const latest = coding || !Number.isFinite(major) || major > 5 || (major === 5 && minor >= 3)
  // 5.2 版本用 effort 字段
  const effort = major === 5 && minor === 2
  // 开关请求，或旧版本且未指定档位值的档位请求
  if (support.type === "toggle" || (!latest && !effort && support.type === "effort" && support.values === undefined)) {
    // 最新形态没有关思考的变体
    if (latest) return []
    // 旧版本提供开/关变体
    return toggle(
      { settings: { thinking: { type: "disabled" } } },
      { settings: { thinking: { type: "enabled", clear_thinking: false } } },
    )
  }
  // 非档位能力不支持
  if (support.type !== "effort") return []
  // 档位值：最新形态 low/high/max，旧版 high/max
  return efforts(support.values ?? (latest ? ["low", "high", "max"] : ["high", "max"]), (value) => {
    // none/minimal 关思考
    if (value === "none" || value === "minimal") return { settings: { thinking: { type: "disabled" } } }
    // 其余开思考（附带 clear_thinking: false）并设置档位
    return {
      settings: { thinking: { type: "enabled", clear_thinking: false }, reasoningEffort: value },
    }
  })
}

// Anthropic Messages 协议：自适应思考与手动预算
const anthropicMessages: Protocol = (model, support) => {
  // 解析 Claude 家族信息
  const info = claudeInfo(model)
  // Opus 4.5 需要特殊处理（手动预算思考）
  const opus45 = info.family === "opus" && info.major === 4 && info.minor === 5
  // 按能力类型分发
  switch (support.type) {
    case "effort": {
      // 旧版本（manual）且非 Opus 4.5 时退化为预算式
      if (info.manual && !opus45) return anthropicMessages(model, { type: "budget_tokens", min: 1024 })
      // Opus 4.5 用手动预算思考，其余用自适应思考
      const thinking = opus45 ? manualThinking(model) : { settings: { thinking: ADAPTIVE_THINKING } }
      // 无法提供思考时无变体
      if (!thinking) return []
      // 默认档位：4.6 为 low~max，其他为 low~xhigh+max
      const defaults = info.major === 4 && info.minor === 6 ? [...EFFORTS, "max"] : [...EFFORTS, "xhigh", "max"]
      // 始终思考的家族过滤掉 none
      const values = (support.values ?? defaults).filter((effort) => !info.always || effort !== "none")
      // none 关思考，其余在思考设置上叠加档位
      return efforts(values, (effort) =>
        effort === "none"
          ? { settings: { thinking: { type: "disabled" } } }
          : { settings: { ...thinking.settings, effort } },
      )
    }
    case "toggle": {
      // 始终思考的家族没有开关
      if (info.always) return []
      // 手动预算或自适应思考
      const thinking = info.manual ? manualThinking(model) : { settings: { thinking: ADAPTIVE_THINKING } }
      // 无法提供思考时无变体
      if (!thinking) return []
      // 开/关变体
      return toggle({ settings: { thinking: { type: "disabled" } } }, thinking)
    }
    case "budget_tokens":
      // 预算受 Anthropic 32k 输出上限约束
      return budgets(
        model,
        support,
        (tokens) => ({ settings: { thinking: { type: "enabled", budgetTokens: tokens } } }),
        ANTHROPIC_OUTPUT_TOKEN_MAX,
      )
  }
}

// MiniMax Messages 协议：M2 固定思考，其余仅开关（自适应）
const minimaxMessages: Protocol = (model, support) => {
  // M2 系列固定思考，不生成变体
  if (/minimax[-.]?m2(?:[.-]|$)/i.test(modelID(model))) return []
  // 仅开关、或未指定档位值的档位请求可配置
  const configurable = support.type === "toggle" || (support.type === "effort" && support.values === undefined)
  // 其余不支持
  if (!configurable) return []
  // 开/关变体：关闭或自适应思考
  return toggle({ settings: { thinking: { type: "disabled" } } }, { settings: { thinking: { type: "adaptive" } } })
}

// Moonshot Messages 协议：effort 字段；K2 系列除外
const moonshotMessages: Protocol = (model, support) => {
  // 非档位能力或 K2 系列不支持
  if (support.type !== "effort" || /kimi[-.]?k2/i.test(modelID(model))) return []
  // 档位映射为 effort 设置
  return efforts(support.values ?? ["low", "high", "max"], (effort) => ({ settings: { effort } }))
}

// Alibaba Messages 协议：thinking + effort 字段
const alibabaMessages: Protocol = (model, support) => {
  // 小写模型 ID
  const id = modelID(model).toLowerCase()
  // 按能力类型分发
  switch (support.type) {
    case "effort": {
      // 托管的 GLM/DeepSeek 仅提供 high/max
      const hosted = id.includes("glm") || id.includes("deepseek")
      // 解析档位值
      const values = support.values ?? (hosted ? ["high", "max"] : ["low", "medium", "xhigh"])
      // none 关思考，其余开思考并设置档位
      return efforts(values, (effort) => {
        if (effort === "none") return { settings: { thinking: { type: "disabled" } } }
        return { settings: { thinking: { type: "enabled" }, effort } }
      })
    }
    case "toggle":
      // 开关变体：thinking 禁用/启用
      return toggle({ settings: { thinking: { type: "disabled" } } }, { settings: { thinking: { type: "enabled" } } })
    case "budget_tokens":
      // 预算受 Alibaba 特有的 64k 上限约束
      return budgets(
        model,
        support,
        (tokens) => ({ settings: { thinking: { type: "enabled", budgetTokens: tokens } } }),
        ALIBABA_THINKING_BUDGET_MAX,
      )
  }
}

// Zai Messages 协议：GLM 5.3 始终思考
const zaiMessages: Protocol = (model, support) => {
  // 小写模型 ID
  const id = modelID(model).toLowerCase()
  // GLM 5.3 强制思考
  const forced = id.includes("glm-5.3") || id.includes("glm-5-3") || id.includes("glm-5p3")
  // 按能力类型分发
  switch (support.type) {
    case "effort":
      // 档位映射为 thinking.enabled + effort
      return efforts(support.values ?? (forced ? ["low", "high", "max"] : ["high", "max"]), (effort) => ({
        settings: {
          thinking: { type: effort === "none" || effort === "minimal" ? "disabled" : "enabled" },
          effort,
        },
      }))
    case "toggle":
      // 强制思考型没有开关
      return forced
        ? []
        : toggle({ settings: { thinking: { type: "disabled" } } }, { settings: { thinking: { type: "enabled" } } })
    case "budget_tokens":
      // 预算不支持
      return []
  }
}

// Gemini 协议：thinkingConfig 控制
const gemini: Protocol = (model, support) => {
  // 按能力类型分发
  switch (support.type) {
    case "effort":
      // 档位映射为 thinkingLevel
      return efforts(support.values ?? EFFORTS, (effort) => ({
        settings: { thinkingConfig: { includeThoughts: true, thinkingLevel: effort } },
      }))
    case "toggle":
      // 0 关思考，-1 动态预算
      return toggle(
        { settings: { thinkingConfig: { includeThoughts: false, thinkingBudget: 0 } } },
        { settings: { thinkingConfig: { includeThoughts: true, thinkingBudget: -1 } } },
      )
    case "budget_tokens":
      // 显式令牌预算
      return budgets(model, support, (tokens) => ({
        settings: { thinkingConfig: { includeThoughts: true, thinkingBudget: tokens } },
      }))
  }
}

// OpenRouter 协议：reasoning 统一设置
const openrouter: Protocol = (model, support) => {
  // 按能力类型分发
  switch (support.type) {
    case "effort":
      // 档位映射为 reasoning.effort
      return efforts(support.values ?? EFFORTS, (effort) => ({ settings: { reasoning: { effort } } }))
    case "toggle":
      // 开关变体：reasoning.enabled
      return toggle({ settings: { reasoning: { enabled: false } } }, { settings: { reasoning: { enabled: true } } })
    case "budget_tokens":
      // 预算映射为 reasoning.max_tokens
      return budgets(model, support, (tokens) => ({ settings: { reasoning: { max_tokens: tokens } } }))
  }
}

// AWS Bedrock Converse 协议：经 additionalModelRequestFields 传参
const bedrockConverse: Protocol = (model, support) => {
  // 模型 ID
  const id = modelID(model)
  // 是否 Claude 系
  const claude = id.includes("anthropic")
  // 构造附加字段覆盖项
  const fields = (fields: Record<string, unknown>): Overlay => ({ body: { additionalModelRequestFields: fields } })
  // 按能力类型分发
  switch (support.type) {
    case "effort":
      // 档位按家族映射字段
      return efforts(support.values ?? EFFORTS, (effort) => {
        // Claude：自适应思考 + output_config.effort（manual 版不带 thinking）
        if (claude)
          return fields({
            ...(claudeInfo(model).manual ? {} : { thinking: ADAPTIVE_THINKING }),
            output_config: { effort },
          })
        // GPT-OSS 用 reasoning_effort
        if (id.includes("openai.gpt-oss")) return fields({ reasoning_effort: effort })
        // OpenAI/xAI 用 reasoning.effort
        if (id.includes("openai.") || id.includes("xai.")) return fields({ reasoning: { effort } })
        // 其余用 reasoningConfig
        return fields({ reasoningConfig: { type: "enabled", maxReasoningEffort: effort } })
      })
    case "toggle":
      // Claude 与其他提供方的开关字段不同
      return claude
        ? toggle(fields({ thinking: { type: "disabled" } }), fields({ thinking: ADAPTIVE_THINKING }))
        : toggle(fields({ reasoningConfig: { type: "disabled" } }), fields({ reasoningConfig: { type: "enabled" } }))
    case "budget_tokens":
      // 预算按家族映射字段
      return budgets(
        model,
        support,
        (tokens) =>
          // Claude's budget is a typed setting so the protocol can fit it under the output limit.
          // （中文）Claude 的预算是带类型的设置项，使协议能把它放进输出上限内
          claude
            ? { settings: { thinking: { type: "enabled", budgetTokens: tokens } } }
            : fields({ reasoningConfig: { type: "enabled", budgetTokens: tokens } }),
        // Claude 受 32k 上限，其余受模型输出上限
        claude ? ANTHROPIC_OUTPUT_TOKEN_MAX : model.limit.output,
      )
  }
}

// Cohere 协议：仅开关与预算
const cohere: Protocol = (model, support) => {
  // 按能力类型分发
  switch (support.type) {
    case "effort":
      // 档位不支持
      return []
    case "toggle":
      // 开关变体：thinking 禁用/启用
      return toggle({ settings: { thinking: { type: "disabled" } } }, { settings: { thinking: { type: "enabled" } } })
    case "budget_tokens":
      // 预算映射为 thinking.tokenBudget
      return budgets(model, support, (tokens) => ({ settings: { thinking: { type: "enabled", tokenBudget: tokens } } }))
  }
}

// Vercel AI 网关：按模型前缀分流
const vercelGateway: Protocol = (model, support) => {
  // 模型 ID
  const id = modelID(model)
  // openai/gpt- 前缀走 Responses 协议
  if (id.startsWith("openai/gpt-")) return openaiResponses(model, support)
  // spacexai/grok- 前缀走通用 Responses 协议
  if (id.startsWith("spacexai/grok-")) return openResponses(model, support)
  // 其余走 Messages 分流
  return vercelMessages(model, support)
}

// Vercel Responses 协议：OpenAI 与通用 Responses 分流
const vercelResponses: Protocol = (model, support) =>
  modelID(model).startsWith("openai/gpt-") ? openaiResponses(model, support) : openResponses(model, support)

// Vercel Messages 协议：anthropic/ 前缀走 Anthropic 协议
const vercelMessages: Protocol = (model, support) =>
  modelID(model).startsWith("anthropic/") ? anthropicMessages(model, support) : vercelChat(model, support)

// Vercel Chat 协议
const vercelChat: Protocol = (model, support) => {
  // 按能力类型分发
  switch (support.type) {
    case "effort":
      // 档位走 OpenAI Chat
      return openaiChat(model, support)
    case "toggle":
      // 开关变体：关闭或自适应思考
      return toggle({ settings: { thinking: { type: "disabled" } } }, { settings: { thinking: { type: "adaptive" } } })
    case "budget_tokens":
      // Alibaba 前缀受 64k 预算约束，其余受模型输出上限
      return budgets(
        model,
        support,
        (tokens) => ({ settings: { thinking: { type: "enabled", budgetTokens: tokens } } }),
        modelID(model).startsWith("alibaba/") ? ALIBABA_THINKING_BUDGET_MAX : model.limit.output,
      )
  }
}

// SAP AI Core 协议：统一经 modelParams 传参
const sapAICore: Protocol = (model, support) => {
  // 模型 ID
  const id = modelID(model)
  // 构造 modelParams 覆盖项
  const sap = (modelParams: Record<string, unknown>): Overlay => ({ settings: { modelParams } })
  // 按能力类型分发
  switch (support.type) {
    case "effort":
      // 档位按家族映射 modelParams
      return efforts(support.values ?? EFFORTS, (effort) => {
        // Anthropic 系：附加字段 + output_config（manual 版不带 thinking）
        if (id.includes("anthropic"))
          return sap({
            additionalModelRequestFields: {
              ...(claudeInfo(model).manual ? {} : { thinking: ADAPTIVE_THINKING }),
              output_config: { effort },
            },
          })
        // Gemini：thinkingConfig
        if (id.includes("gemini")) return sap({ thinkingConfig: { includeThoughts: true, thinkingLevel: effort } })
        // Nova：output_config
        if (id.includes("amazon--nova")) return sap({ additionalModelRequestFields: { output_config: { effort } } })
        // 其余：reasoning_effort
        return sap({ reasoning_effort: effort })
      })
    case "toggle":
      // 各家族的开关字段不同
      if (id.includes("gemini"))
        return toggle(
          sap({ thinkingConfig: { includeThoughts: false, thinkingBudget: 0 } }),
          sap({ thinkingConfig: { includeThoughts: true, thinkingBudget: -1 } }),
        )
      if (id.includes("cohere"))
        return toggle(sap({ thinking: { type: "disabled" } }), sap({ thinking: { type: "enabled" } }))
      if (id.includes("amazon--nova"))
        return toggle(
          sap({ additionalModelRequestFields: { thinking: { type: "disabled" } } }),
          sap({ additionalModelRequestFields: { thinking: { type: "enabled" } } }),
        )
      if (id.includes("anthropic"))
        return toggle(
          sap({ additionalModelRequestFields: { thinking: { type: "disabled" } } }),
          sap({ additionalModelRequestFields: { thinking: ADAPTIVE_THINKING } }),
        )
      return []
    case "budget_tokens":
      // 各家族的预算字段不同
      if (id.includes("anthropic"))
        return budgets(
          model,
          support,
          (tokens) => sap({ additionalModelRequestFields: { thinking: { type: "enabled", budget_tokens: tokens } } }),
          ANTHROPIC_OUTPUT_TOKEN_MAX,
        )
      if (id.includes("gemini"))
        return budgets(model, support, (tokens) =>
          sap({ thinkingConfig: { includeThoughts: true, thinkingBudget: tokens } }),
        )
      if (id.includes("cohere"))
        return budgets(model, support, (tokens) => sap({ thinking: { type: "enabled", token_budget: tokens } }))
      return []
  }
}

// gitlab-ai-provider reads `providerOptions.gitlab.thinking` (Anthropic) and
// `providerOptions.gitlab.reasoningEffort` (OpenAI Chat and Responses). Its adaptive
// thinking config carries the effort inline and always requests summarized display.
// （中文）gitlab-ai-provider 读取 `providerOptions.gitlab.thinking`（Anthropic）与
// `providerOptions.gitlab.reasoningEffort`（OpenAI Chat 与 Responses）。其自适应思考配置内联携带档位，且总是要求摘要展示
const gitlabAnthropic: Protocol = (model, support) => {
  // 解析 Claude 家族信息
  const info = claudeInfo(model)
  // 关思考覆盖项
  const disabled: Overlay = { settings: { thinking: { type: "disabled" } } }
  // 自适应思考 + 内联档位
  const adaptive = (effort: string): Overlay => ({ settings: { thinking: { type: "adaptive", effort } } })
  // 按能力类型分发
  switch (support.type) {
    case "effort": {
      // 旧版本退化为预算式
      if (info.manual) return gitlabAnthropic(model, { type: "budget_tokens", min: 1024 })
      // 默认档位与 Anthropic 一致
      const defaults = info.major === 4 && info.minor === 6 ? [...EFFORTS, "max"] : [...EFFORTS, "xhigh", "max"]
      // none 关思考，其余自适应 + 档位
      return efforts(support.values ?? defaults, (effort) => (effort === "none" ? disabled : adaptive(effort)))
    }
    case "toggle": {
      // 始终思考的家族没有开关
      if (info.always) return []
      // 手动预算或自适应（默认 high）
      const thinking = info.manual ? manualThinking(model) : adaptive("high")
      // 无法提供思考时无变体
      if (!thinking) return []
      // 开/关变体
      return toggle(disabled, thinking)
    }
    case "budget_tokens":
      // 预算受 Anthropic 32k 上限约束
      return budgets(
        model,
        support,
        (tokens) => ({ settings: { thinking: { type: "enabled", budgetTokens: tokens } } }),
        ANTHROPIC_OUTPUT_TOKEN_MAX,
      )
  }
}

// GitLab 协议：按模型族分流
const gitlab: Protocol = (model, support) => {
  // 小写模型 ID
  const id = modelID(model).toLowerCase()
  // Duo Workflow 不支持思考变体
  if (id.startsWith("duo-workflow")) return []
  // Claude 家族走 Anthropic 变体
  if (claudeInfo(model).family) return gitlabAnthropic(model, support)
  // GPT/Codex 走 OpenAI Chat
  if (id.includes("gpt") || id.includes("codex")) return openaiChat(model, support)
  // 其余不支持
  return []
}

// （中文）协议包名 -> 协议函数 的路由表
const PROTOCOLS: Readonly<Record<string, Protocol>> = {
  // OpenAI Responses 系
  "@opencode/ai/providers/openai": openaiResponses,
  // OpenAI Responses 子路径
  "@opencode/ai/providers/openai/responses": openaiResponses,
  // Azure Responses
  "@opencode/ai/providers/azure": openaiResponses,
  // Azure Responses 子路径
  "@opencode/ai/providers/azure/responses": openaiResponses,
  // Bedrock Mantle Responses
  "@opencode/ai/providers/amazon-bedrock/mantle": openaiResponses,
  // Bedrock Mantle Responses 子路径
  "@opencode/ai/providers/amazon-bedrock/mantle/responses": openaiResponses,
  // Alibaba Responses
  "@opencode/ai/providers/alibaba/responses": openaiResponses,
  // Meta Responses
  "@opencode/ai/providers/meta": openaiResponses,
  // Meta Responses 子路径
  "@opencode/ai/providers/meta/responses": openaiResponses,
  // MiniMax Responses
  "@opencode/ai/providers/minimax/responses": openaiResponses,
  // Moonshot Responses
  "@opencode/ai/providers/moonshot/responses": openaiResponses,
  // Zai 编码套餐 Responses
  "@opencode/ai/providers/zai-coding-plan/responses": openaiResponses,

  // 通用 OpenAI Responses 兼容系
  "@opencode/ai/providers/openai-compatible/responses": openResponses,
  // 通用 OpenAI Responses 兼容（连字符命名）
  "@opencode/ai/providers/openai-compatible-responses": openResponses,
  // Google Vertex Responses
  "@opencode/ai/providers/google-vertex/responses": openResponses,
  // xAI
  "@opencode/ai/providers/xai": openResponses,
  // DigitalOcean Responses
  "@opencode/ai/providers/digitalocean/responses": openResponses,
  // OpenRouter Responses
  "@opencode/ai/providers/openrouter/responses": openResponses,
  // Venice Responses
  "@opencode/ai/providers/venice/responses": openResponses,

  // 通用 OpenAI 兼容（NVIDIA 特判）
  "@opencode/ai/providers/openai-compatible": openaiCompatible,
  // OpenAI Chat
  "@opencode/ai/providers/openai/chat": openaiChat,
  // Azure Chat
  "@opencode/ai/providers/azure/chat": openaiChat,
  // Bedrock Mantle Chat
  "@opencode/ai/providers/amazon-bedrock/mantle/chat": openaiChat,
  // Google Vertex Chat（模板开关）
  "@opencode/ai/providers/google-vertex/chat": vertexChat,
  // Alibaba
  "@opencode/ai/providers/alibaba": alibabaChat,
  // Alibaba Chat
  "@opencode/ai/providers/alibaba/chat": alibabaChat,
  // Baseten
  "@opencode/ai/providers/baseten": basetenChat,
  // Cerebras
  "@opencode/ai/providers/cerebras": openaiChat,
  // Cloudflare Workers AI
  "@opencode/ai/providers/cloudflare-workers-ai": workersAIChat,
  // Cohere Chat
  "@opencode/ai/providers/cohere/chat": openaiChat,
  // DeepInfra
  "@opencode/ai/providers/deepinfra": deepinfraChat,
  // DeepSeek
  "@opencode/ai/providers/deepseek": deepseekChat,
  // DigitalOcean
  "@opencode/ai/providers/digitalocean": openaiChat,
  // Fireworks
  "@opencode/ai/providers/fireworks": openaiChat,
  // Groq
  "@opencode/ai/providers/groq": openaiChat,
  // Meta Chat
  "@opencode/ai/providers/meta/chat": openaiChat,
  // MiniMax Chat
  "@opencode/ai/providers/minimax/chat": openaiChat,
  // Mistral
  "@opencode/ai/providers/mistral": openaiChat,
  // Google Vertex 上的 Mistral
  "@opencode/ai/providers/google-vertex/mistral": openaiChat,
  // Moonshot
  "@opencode/ai/providers/moonshot": moonshotChat,
  // Moonshot Chat
  "@opencode/ai/providers/moonshot/chat": moonshotChat,
  // TogetherAI
  "@opencode/ai/providers/togetherai": openaiChat,
  // Venice
  "@opencode/ai/providers/venice": veniceChat,
  // Zai
  "@opencode/ai/providers/zai": zaiChat,
  // Zai Chat
  "@opencode/ai/providers/zai/chat": zaiChat,
  // Zai 编码套餐
  "@opencode/ai/providers/zai-coding-plan": zaiChat,
  // Zai 编码套餐 Chat
  "@opencode/ai/providers/zai-coding-plan/chat": zaiChat,

  // Anthropic Messages 系
  "@opencode/ai/providers/anthropic": anthropicMessages,
  // Anthropic 兼容
  "@opencode/ai/providers/anthropic-compatible": anthropicMessages,
  // Bedrock Mantle Messages
  "@opencode/ai/providers/amazon-bedrock/mantle/messages": anthropicMessages,
  // Azure Messages
  "@opencode/ai/providers/azure/messages": anthropicMessages,
  // Google Vertex Messages
  "@opencode/ai/providers/google-vertex/messages": anthropicMessages,
  // Google Vertex Messages（连字符命名）
  "@opencode/ai/providers/google-vertex-messages": anthropicMessages,
  // Alibaba Messages
  "@opencode/ai/providers/alibaba/messages": alibabaMessages,
  // Meta Messages
  "@opencode/ai/providers/meta/messages": anthropicMessages,
  // MiniMax
  "@opencode/ai/providers/minimax": minimaxMessages,
  // MiniMax Messages
  "@opencode/ai/providers/minimax/messages": minimaxMessages,
  // Moonshot Messages
  "@opencode/ai/providers/moonshot/messages": moonshotMessages,
  // Zai 编码套餐 Messages
  "@opencode/ai/providers/zai-coding-plan/messages": zaiMessages,

  // Google Gemini 系
  "@opencode/ai/providers/google": gemini,
  // Google Vertex
  "@opencode/ai/providers/google-vertex": gemini,
  // Google Vertex 上的 Gemini
  "@opencode/ai/providers/google-vertex/gemini": gemini,
  // Google 图像
  "@opencode/ai/providers/google/images": gemini,
  // Google Vertex 图像
  "@opencode/ai/providers/google-vertex/images": gemini,
  // Google Interactions
  "@opencode/ai/providers/google/interactions": googleInteractions,
  // Google Vertex Interactions
  "@opencode/ai/providers/google-vertex/interactions": googleInteractions,

  // AWS Bedrock Converse
  "@opencode/ai/providers/amazon-bedrock": bedrockConverse,
  // Cohere
  "@opencode/ai/providers/cohere": cohere,
  // OpenRouter
  "@opencode/ai/providers/openrouter": openrouter,

  // Venice AI SDK 提供方
  [Provider.aisdk("venice-ai-sdk-provider")]: veniceChat,
  // Cloudflare AI 网关
  "@opencode/ai/providers/cloudflare-ai-gateway": cloudflareAIGateway,
  // Vercel AI 网关
  "@opencode/ai/providers/vercel-ai-gateway": vercelGateway,
  // Vercel AI 网关 Chat
  "@opencode/ai/providers/vercel-ai-gateway/chat": vercelChat,
  // Vercel AI 网关 Messages
  "@opencode/ai/providers/vercel-ai-gateway/messages": vercelMessages,
  // Vercel AI 网关 Responses
  "@opencode/ai/providers/vercel-ai-gateway/responses": vercelResponses,
  // AI SDK 通用网关
  [Provider.aisdk("@ai-sdk/gateway")]: vercelGateway,
  // SAP AI Core
  [Provider.aisdk("@jerome-benoit/sap-ai-provider-v2")]: sapAICore,
  // GitLab AI 提供方
  [Provider.aisdk("gitlab-ai-provider")]: gitlab,
}
