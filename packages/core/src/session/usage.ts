// 将本模块以命名空间 `SessionUsage` 全量导出
export * as SessionUsage from "./usage.js"

// 引入 AI SDK 的用量（Usage）类型（仅类型）
import type { Usage } from "@opencode/ai/effect"
// 引入金额（Money）schema
import { Money } from "@opencode/schema/money"
// 引入 token 用量类型（仅类型）
import type { TokenUsage } from "@opencode/schema/token-usage"
// 引入模型（Model）类型（仅类型）
import type { Model } from "@opencode/schema/model"

// 将非有限数值（NaN/Infinity）归零，避免脏数据污染统计
const finite = (value: number) => (Number.isFinite(value) ? value : 0)
// 取非负值：undefined 视为 0，负数截断为 0
const safe = (value: number | undefined) => Math.max(0, finite(value ?? 0))

// 将端点上报的用量归一化为 TokenUsage：各维度均做安全兜底
export const tokens = (usage: Usage | undefined): TokenUsage.Info => ({
  // 输入 token：未命中缓存的输入部分
  input: safe(usage?.nonCachedInputTokens),
  // 输出 token：可见输出部分
  output: safe(usage?.visibleOutputTokens),
  // 推理（reasoning）token
  reasoning: safe(usage?.reasoningTokens),
  cache: {
    // 缓存读取 token
    read: safe(usage?.cacheReadInputTokens),
    // 缓存写入 token
    write: safe(usage?.cacheWriteInputTokens),
  },
})

// Catalog pricing is the fallback for endpoints that don't report what they charged (`Usage.cost`).
export function calculateCost(costs: Model.Info["cost"], usage: TokenUsage.Info) {
  // 上下文 token 量：输入 + 缓存读 + 缓存写，用于匹配分层定价档位
  const context = usage.input + usage.cache.read + usage.cache.write
  // 在"上下文规模分层"定价中，选出当前上下文已超过、且规模最大的那一档
  const tier = costs
    .filter((cost) => cost.tier?.type === "context" && context > cost.tier.size)
    .toSorted((a, b) => (b.tier?.size ?? 0) - (a.tier?.size ?? 0))[0]
  // 命中分层则用分层价，否则退回不分层（无 tier）的目录价
  const cost = tier ?? costs.find((cost) => cost.tier === undefined)
  // 模型没有任何定价信息：返回 0 美元
  if (!cost) return Money.USD.zero
  // 按各维度 token 数 × 对应单价求和（单价按每百万 token 计）构造美元金额
  return Money.USD.make(
    (usage.input * finite(cost.input) +
      (usage.output + usage.reasoning) * finite(cost.output) +
      usage.cache.read * finite(cost.cache.read) +
      usage.cache.write * finite(cost.cache.write)) /
      1_000_000,
  )
}

// 一次已记录的用量：token 明细与美元成本
export type Recorded = {
  readonly tokens: TokenUsage.Info
  readonly cost: Money.USD
}

// 记录一次用量：归一化 token，并确定成本口径
export const record = (usage: Usage | undefined, costs: Model.Info["cost"]): Recorded => {
  // 先做 token 归一化
  const normalized = tokens(usage)
  return {
    tokens: normalized,
    // What an endpoint says it charged beats the catalog, which can't see its peak pricing, subscriptions or routing.
    // A reported zero is authoritative.
    // 端点自报的费用优先于目录价（目录价看不到峰值定价/订阅/路由）；上报为 0 也是权威值
    cost: usage?.cost === undefined ? calculateCost(costs, normalized) : Money.USD.make(usage.cost),
  }
}

// 将两条用量记录相加（成本与各 token 维度分别求和）
export const add = (a: Recorded, b: Recorded): Recorded => ({
  // 成本相加
  cost: Money.USD.make(a.cost + b.cost),
  tokens: {
    // 输入 token 累加
    input: a.tokens.input + b.tokens.input,
    // 输出 token 累加
    output: a.tokens.output + b.tokens.output,
    // 推理 token 累加
    reasoning: a.tokens.reasoning + b.tokens.reasoning,
    cache: {
      // 缓存读取 token 累加
      read: a.tokens.cache.read + b.tokens.cache.read,
      // 缓存写入 token 累加
      write: a.tokens.cache.write + b.tokens.cache.write,
    },
  },
})
