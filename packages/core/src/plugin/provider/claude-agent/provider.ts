// 导出 ClaudeProvider 命名空间，供其他模块引用本文件内容
export * as ClaudeProvider from "./provider.js"

// 导入 Claude Agent SDK 的账户信息类型
import type { AccountInfo } from "@anthropic-ai/claude-agent-sdk"
// 导入插件上下文类型
import type { Context } from "@opencode/plugin/effect/plugin"
// 从 effect 库导入 Effect、Option、Schema、Stream 与 SubscriptionRef
import { Effect, Option, Schema, Stream, SubscriptionRef } from "effect"
// 导入模型信息类型
import { Model } from "../../../model.js"
// 导入 Provider 服务
import { Provider } from "../../../provider.js"
// 导入 Claude IO 接口类型
import type { ClaudeIO } from "./claude/io.js"
// 导入探测结果类型
import type { ClaudeProbe } from "./claude/probe.js"
// 导入查询选项构造工具
import { ClaudeQueryOptions } from "./claude/query-options.js"
// 导入状态类型
import type { ClaudeStatus } from "./claude/status.js"

// 集成/供应商 ID：claudeAgent
export const ID = Provider.ID.claudeAgent
// 该供应商对应的包名
export const PACKAGE = "@opencode/claude-agent"

// 在多次启动之间保存的模型列表，这样 opencode 无需运行 `claude` 也能列出模型
// The model list we keep between starts, so opencode can list models without running `claude`
const CatalogModel = Schema.Struct({
  // 模型 ID
  id: Schema.String,
  // 显示名称
  name: Schema.String,
  // 支持的努力等级列表
  efforts: Schema.Array(Schema.String),
  // 可选：上下文窗口大小
  contextWindow: Schema.optionalKey(Schema.Number),
  // 可选：Claude Code 解析出的实际模型 ID
  resolvedModel: Schema.optionalKey(Schema.String),
})
// 目录模型类型（由 Schema 推导）
type CatalogModel = typeof CatalogModel.Type
// 目录结构：价格来源（可选）+ 模型列表
const Catalog = Schema.Struct({
  // 价格参考的供应商 ID（用于从其他供应商价格表取价）
  priceSource: Schema.optionalKey(Provider.ID),
  // 模型列表
  models: Schema.Array(CatalogModel),
})
// 目录类型（由 Schema 推导）
type Catalog = typeof Catalog.Type
// 目录在存储中的键名
const CATALOG_KEY = "models"

// Mantle 是按 Anthropic API 提供服务的 Bedrock，而 opencode 会从 Bedrock 列表里剔除大部分 `anthropic.…` ID，
// 因此它沿用 Anthropic 的价格。
// Mantle is Bedrock serving Anthropic's API, and opencode drops most of its `anthropic.…` IDs from Bedrock's list,
// so it uses Anthropic's prices.
const PRICE_SOURCES: Partial<Record<NonNullable<AccountInfo["apiProvider"]>, Provider.ID>> = {
  // 官方直连 -> Anthropic
  firstParty: Provider.ID.anthropic,
  // AWS 上的 Anthropic -> Anthropic
  anthropicAws: Provider.ID.anthropic,
  // Google Cloud 上的 Anthropic -> Anthropic
  anthropicGoogleCloud: Provider.ID.anthropic,
  // Mantle -> Anthropic
  mantle: Provider.ID.anthropic,
  // Bedrock -> Amazon Bedrock
  bedrock: Provider.ID.amazonBedrock,
  // Vertex -> Google Vertex
  vertex: Provider.ID.googleVertex,
  // Foundry -> Azure
  foundry: Provider.ID.azure,
}

// 注册 Claude Provider：加载模型目录、注册供应商转换、随状态更新目录
export const register = Effect.fn("ClaudeProvider.register")(function* (
  // 插件上下文
  ctx: Context,
  // Claude 状态机接口
  status: ClaudeStatus.Interface,
  // Claude IO 抽象
  io: ClaudeIO.Interface,
) {
  // 从存储中读取并解码已保存的模型目录
  const saved = Schema.decodeUnknownOption(Catalog)(yield* ctx.storage.get(CATALOG_KEY))
  // 当前目录：读取失败时回退为空列表
  const current = { catalog: Option.getOrElse(saved, (): Catalog => ({ models: [] })) }

  // 注册供应商转换：把 claudeAgent 供应商及其模型列表加入注册表
  yield* ctx.provider.transform((editor) => {
    // 取出价格来源供应商 ID
    const source = current.catalog.priceSource
    // 有来源则读取其模型价格表
    const prices = source ? editor.get(source)?.models : undefined
    // 添加 claudeAgent 供应商及模型
    editor.add({
      info: {
        // 供应商 ID
        id: ID,
        // 显示名称
        name: "Claude Agent",
        // 自动激活
        activation: "auto",
        // 对应的 AI SDK 包
        package: Provider.aisdk(PACKAGE),
      },
      // 把目录模型转换为 Model.Info
      models: current.catalog.models.map((model) => toModel(model, prices)),
    })
  })

  // 订阅状态变化：状态就绪时刷新模型目录
  yield* SubscriptionRef.changes(status.state).pipe(
    Stream.runForEach((state) =>
      Effect.gen(function* () {
        // 只处理“就绪”状态
        if (state.type !== "ready") return
        // 取 baseURL：优先用连接环境里的，否则用本机 claude 环境里的
        const baseURL = (yield* connection(ctx)).ANTHROPIC_BASE_URL ?? io.env().ANTHROPIC_BASE_URL
        // 构造新目录：价格来源 + 从探测结果合并出的模型列表
        const next = {
          priceSource: priceSource(state.probe.account, baseURL),
          models: fromClaude(state.probe.models, current.catalog.models),
        }
        // 目录无变化则跳过
        if (JSON.stringify(next) === JSON.stringify(current.catalog)) return
        // 更新当前目录
        current.catalog = next
        // 持久化到存储
        yield* ctx.storage.set(CATALOG_KEY, current.catalog)
        // 触发供应商重载
        yield* ctx.provider.reload()
      }),
    ),
    // 用独立 fiber 在后台运行该订阅
    Effect.forkScoped,
  )

  // 没有保存的模型列表就没有模型可选，因此第一条本该填满列表的消息永远发不出去。
  // 此时若存在激活连接，主动触发一次状态刷新。
  // Without a saved list there is no model to pick, so the first message that would fill it can never be sent.
  if (current.catalog.models.length === 0 && (yield* ctx.integration.connection.active(ID))) {
    yield* status.refresh().pipe(Effect.forkScoped)
  }
})

// 获取当前连接的环境变量（凭据等），供运行 claude 时使用
export const connection = Effect.fn("ClaudeProvider.connection")(function* (ctx: Context) {
  // 获取 claudeAgent 供应商配置（失败时转为 none）
  const provider = yield* ctx.provider.get({ providerID: ID }).pipe(Effect.option)
  // 无配置则返回空环境
  if (Option.isNone(provider)) return {}
  // 取出供应商数据
  const info = provider.value.data
  // 从设置/请求头/请求体中构造连接环境变量
  return ClaudeQueryOptions.connectionEnv({ settings: info.settings, headers: info.headers, body: info.body })
})

// 上下文窗口大小只来自完整检查，因此聊天启动时的上报会沿用已保存的值。
// Context windows only come from the full check, so a chat's startup report keeps the saved ones.
function fromClaude(models: readonly ClaudeProbe.Model[], saved: readonly CatalogModel[]): CatalogModel[] {
  // 已知模型的上下文窗口映射
  const known = new Map<string, number | undefined>()
  // 先登记已保存模型各自的窗口大小
  for (const model of saved) known.set(model.id, model.contextWindow)
  // 结果列表
  const result: CatalogModel[] = []
  // 遍历探测到的模型
  for (const model of models) {
    // "default" 跟随 Claude Code 自身的默认值，在 opencode 会话运行期间可能变化，因此跳过
    // "default" follows Claude Code's own default, which can change under a running opencode session
    if (model.value === "default") continue
    // 转换为目录模型
    result.push({
      // 模型 ID
      id: model.value,
      // 显示名称
      name: model.displayName,
      // 支持的努力等级
      efforts: model.supportedEffortLevels ?? [],
      // 上下文窗口：优先用探测值，回退到已保存值
      contextWindow: model.contextWindow ?? known.get(model.value),
      // 解析出的实际模型 ID
      resolvedModel: model.resolvedModel,
    })
  }
  // 返回新的模型列表
  return result
}

// 订阅额度已涵盖用量，而自定义 baseURL 或企业网关可能按任意方式计费，因此这些情况不显示价格。
// A subscription covers usage, and a custom base URL or an enterprise gateway can bill anything, so they show no cost.
function priceSource(account: AccountInfo, baseURL: string | undefined) {
  // 有自定义 baseURL：不取价
  if (baseURL) return
  // API 提供方未知：不取价
  if (account.apiProvider === undefined) return
  // 官方直连且使用订阅（无 API key 来源）：订阅计费，不取价
  if (account.apiProvider === "firstParty" && account.apiKeySource === undefined) return
  // 其余按提供方映射价格来源
  return PRICE_SOURCES[account.apiProvider]
}

// 把目录模型转换为 OpenCode 的 Model.Info
function toModel(model: CatalogModel, prices: ReadonlyMap<string, Model.Info> | undefined): Model.Info {
  // 以默认信息为基础
  const defaults = Model.Info.default(ID, Model.ID.make(model.id))
  // 1M 上下文版本的价格档位挂在基础模型上，因此去掉 [1m] 后缀
  // The 1M context version's price tiers are on the base model
  const id = (model.resolvedModel ?? model.id).replace(/\[1m\]$/, "")
  // Mantle 把模型命名为 `anthropic.claude-…`，Vertex 则把现行模型列为 `claude-…@default`
  // Mantle names models `anthropic.claude-…`, and Vertex lists current models as `claude-…@default`
  const priced = prices?.get(id) ?? prices?.get(id.replace(/^anthropic\./, "")) ?? prices?.get(`${id}@default`)
  // 组装 Model.Info
  return {
    // 继承默认字段
    ...defaults,
    // 显示名称
    name: model.name,
    // SDK 会在提示前报告上下文窗口，但不报告输出上限；0 在 OpenCode 中表示未知
    // The SDK reports context windows before a prompt, but not output limits. 0 means unknown in OpenCode.
    limit: { context: model.contextWindow ?? defaults.limit.context, output: 0 },
    // OpenCode 按模型家族挑选标题生成模型（Model.small）
    // OpenCode picks the title model by family (Model.small).
    family: model.id.includes("haiku") ? Model.Family.make("claude-haiku") : undefined,
    // 能力：支持工具、接受文本/图像/PDF 输入、输出文本
    capabilities: { tools: true, input: ["text", "image", "pdf"], output: ["text"] },
    // 努力等级转换为模型变体
    variants: model.efforts.map((effort) => ({ id: Model.VariantID.make(effort), settings: { effort } })),
    // 价格：参考供应商价格表（找不到则为空）
    cost: priced?.cost ?? [],
  }
}
