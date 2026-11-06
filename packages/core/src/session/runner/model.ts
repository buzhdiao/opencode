// 将本模块以命名空间形式整体导出为 SessionRunnerModel
export * as SessionRunnerModel from "./model.js"

// 按「位置（location）」组织的 Effect 服务节点工具
import { makeLocationNode } from "@opencode/util/effect/app-node"
// 语言模型（LanguageModel）抽象：实际与模型提供方通信的句柄
import { LanguageModel } from "@opencode/ai/effect"
// 模型模式：ID、Ref、能力、成本、限额等
import { Model } from "@opencode/schema/model"
// 提供方（Provider）模式：ID、压缩与传输配置
import { Provider } from "@opencode/schema/provider"
// effect：Context 依赖容器、Effect 运行时、Layer 层、Schema 编解码
import { Context, Effect, Layer, Schema } from "effect"
// 代理（Agent）服务：读取代理默认模型
import { Agent } from "../../agent.js"
// 模型解析器：把模型条目解析为可用的语言模型
import { ModelResolver } from "../../model-resolver.js"
// 会话 Schema：Info/ID 类型
import { SessionSchema } from "../schema.js"

// 会话未选择模型且无法推导默认模型时抛出的错误
export class ModelNotSelectedError extends Schema.TaggedError<ModelNotSelectedError>()(
  "SessionRunnerModel.ModelNotSelectedError",
  { sessionID: SessionSchema.ID },
) {
  // 错误信息：指明哪个会话没有可用模型
  override get message() {
    return `No model is available for session ${this.sessionID}`
  }
}

// 会话选择的模型在目录中不可用时抛出的错误
export class ModelUnavailableError extends Schema.TaggedError<ModelUnavailableError>()(
  "SessionRunnerModel.ModelUnavailableError",
  { providerID: Provider.ID, modelID: Model.ID },
) {
  // 错误信息：对已弃用的提供方给出迁移建议
  override get message() {
    // azure-cognitive-services 已弃用，建议改用 azure/
    if (this.providerID === "azure-cognitive-services")
      return `Model unavailable: ${this.providerID}/${this.modelID}. This provider has been deprecated; use azure/${this.modelID} instead.`
    // google-vertex-anthropic 已弃用，建议改用 google-vertex/
    if (this.providerID === "google-vertex-anthropic")
      return `Model unavailable: ${this.providerID}/${this.modelID}. This provider has been deprecated; use google-vertex/${this.modelID} instead.`
    // 其他提供方仅报告不可用
    return `Model unavailable: ${this.providerID}/${this.modelID}`
  }
}
// 本服务的错误联合类型
export type Error = ModelNotSelectedError | ModelUnavailableError | ModelResolver.Error
// 解析结果类型（沿用解析器的定义）
export type Resolved = ModelResolver.Resolved

// 模型解析服务接口
export interface Interface {
  /** Availability is sampled lazily for each explicitly selected model resolution. */
  // 可用性在每次显式选择的模型解析时才惰性采样（available 是惰性回调）
  readonly resolve: (
    session: SessionSchema.Info,
    available: () => Effect.Effect<ReadonlyArray<Model.Info>>,
  ) => Effect.Effect<Resolved, Error>
}

// 服务定义：基于 Context 的 tagged service
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRunnerModel") {}

/** Builds a Resolved whose catalog identity mirrors the route model. Test or embedding seam. */
// 构造一个目录身份与路由模型一致的 Resolved。测试或嵌入用接缝
export const resolved = (
  model: LanguageModel,
  options: {
    readonly capabilities: Model.Capabilities
    readonly variant?: Model.VariantID
    readonly cost: Model.Info["cost"]
    readonly limit: Model.Info["limit"]
    readonly compaction?: Provider.Compaction
    readonly transport?: Provider.Transport
  },
): Resolved => ({
  // 语言模型句柄
  model,
  // 由模型 ID/提供方/变体构造模型引用
  ref: Model.Ref.make({
    id: Model.ID.make(model.id),
    providerID: Provider.ID.make(model.provider),
    ...(options.variant === undefined ? {} : { variant: options.variant }),
  }),
  // 能力、成本、限额与可选的压缩/传输配置
  capabilities: options.capabilities,
  cost: options.cost,
  limit: options.limit,
  compaction: options.compaction,
  transport: options.transport,
})

// 构建服务实现层
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 获取模型解析器与代理服务
    const resolver = yield* ModelResolver.Service
    const agents = yield* Agent.Service
    return Service.of({
      resolve: Effect.fn("SessionRunnerModel.resolve")(function* (session, available) {
        // Location plugins populate and filter the catalog asynchronously during layer startup.
        // 位置插件在层启动期间异步填充并过滤目录
        // 会话未显式选模型时：按代理默认模型 → 全局默认的顺序解析
        if (!session.model) {
          // 读取代理默认模型（可能为空）
          const agent = (yield* agents.select(session.agent)).info?.model
          // 在可用目录中找代理默认的模型条目
          const preferred =
            agent &&
            (yield* available()).find((model) => model.providerID === agent.providerID && model.id === agent.id)
          // 有候选则按其变体解析，否则走解析器的默认解析
          const resolved = preferred
            ? yield* resolver.resolveModel(preferred, agent.variant)
            : yield* resolver.resolve()
          // 解析成功则返回
          if (resolved) return resolved
          // 仍无模型可用则报「未选择模型」
          return yield* new ModelNotSelectedError({ sessionID: session.id })
        }
        // 会话显式选了模型：在可用目录中查找匹配条目
        const selected = (yield* available()).find(
          (model) => model.providerID === session.model?.providerID && model.id === session.model.id,
        )
        // 目录中不存在则报「模型不可用」
        if (!selected)
          return yield* new ModelUnavailableError({
            providerID: session.model.providerID,
            modelID: session.model.id,
          })
        // 按会话选定的变体解析模型
        return yield* resolver.resolveModel(selected, session.model.variant)
      }),
    })
  }),
)

// 导出位置节点：服务层依赖 ModelResolver 与 Agent 节点
export const node = makeLocationNode({ service: Service, layer, deps: [ModelResolver.node, Agent.node] })
