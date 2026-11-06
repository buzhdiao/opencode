// 将本模块整体导出为 SessionContext 命名空间
export * as SessionContext from "./context.js"

// 导入模型服务
import { Model } from "../model.js"
// 导入权限辅助（合并规则等）
import { Permission } from "../permission.js"
// 导入 effect 核心
import { Context, Effect, Layer } from "effect"
// 导入 Agent 服务
import { Agent } from "../agent.js"
// 导入 Code Mode 的说明注入
import { CodeModeInstructions } from "../codemode/instructions.js"
// 导入数据库服务
import { Database } from "../database/database.js"
// 导入 Location 级依赖注入节点构造工具
import { makeLocationNode } from "@opencode/util/effect/app-node"
// 导入指令发现服务
import { InstructionDiscovery } from "../instruction-discovery.js"
// 导入指令列表基础设施
import { Instructions } from "../instructions/index.js"
// 导入内建指令源
import { InstructionBuiltIns } from "../instructions/builtins.js"
// 导入 Location 服务
import { Location } from "../location.js"
// 导入 MCP 说明注入
import { McpInstructions } from "../mcp/instructions.js"
// 导入 MCP 工具服务
import { McpTool } from "../tool/mcp.js"
// 导入项目引用说明注入
import { ReferenceInstructions } from "../reference/instructions.js"
// 导入技能说明注入
import { SkillInstructions } from "../skill/instructions.js"
// 导入工具服务
import { Tool } from "../tool.js"
// 导入会话相关错误类型
import { AgentNotFoundError } from "./error.js"
// 导入会话历史服务
import { SessionHistory } from "./history.js"
// 导入指令条目服务
import { InstructionEntry } from "./instruction-entry.js"
// 导入会话消息模块
import { SessionMessage } from "./message.js"
// 导入模型请求辅助
import { SessionModelRequest } from "./model-request.js"
// 导入运行器模型解析服务
import { SessionRunnerModel } from "./runner/model.js"
// 导入会话 schema 类型
import { SessionSchema } from "./schema.js"
// 导入会话存储服务
import { SessionStore } from "./store.js"

// 选择（select）阶段的结果：会话、agent（含详情）、指令列表与工具快照
export interface Selection {
  readonly session: SessionSchema.Info
  readonly agent: Agent.Selection & { readonly info: Agent.Info }
  readonly instructions: Instructions.List
  readonly tools: Tool.Snapshot
}

// 加载（load）阶段的结果：在选择基础上追加解析出的模型与历史消息
export interface Loaded {
  readonly session: SessionSchema.Info
  readonly agent: Agent.Selection & { readonly info: Agent.Info }
  readonly model: SessionRunnerModel.Resolved
  readonly initial: ReadonlyArray<Instructions.Rendered>
  readonly messages: ReadonlyArray<SessionMessage.Info>
  readonly tools: Tool.Snapshot
}

/**
 * Resolves model-request state in two phases: `select` fixes the Session,
 * agent, instruction sources, and tool snapshot; `load` adds the model and
 * active history for that selection. Auxiliary operations resolve only the
 * capabilities they need; request preparation stays separate from selection.
 */
// 服务接口：两阶段解析模型请求状态——select 固定会话/agent/指令源/工具快照，load 再补模型与历史；辅助操作只解析各自所需的能力
export interface Interface {
  /** Selects the Session, agent, instructions, and tools used by subsequent work. */
  // 选择后续工作使用的会话、agent、指令与工具
  readonly select: (sessionID: SessionSchema.ID) => Effect.Effect<Selection, AgentNotFoundError>
  /** Resolves the model and active history for that selection. */
  // 为该选择解析模型与活跃历史
  readonly load: (selection: Selection) => Effect.Effect<Loaded, SessionRunnerModel.Error>
  // 仅解析会话使用的模型
  readonly resolveModel: (
    session: SessionSchema.Info,
  ) => Effect.Effect<SessionRunnerModel.Resolved, SessionRunnerModel.Error>
  /** Selects auxiliary title capabilities without instruction or tool preflight. */
  // 选择生成标题用的能力（跳过指令与工具预检）
  readonly selectTitle: (session: SessionSchema.Info) => Effect.Effect<
    | {
        readonly agent: Agent.Info
        readonly primary: SessionRunnerModel.Resolved | undefined
        readonly selected: SessionRunnerModel.Resolved
      }
    | undefined
  >
  // 模型请求辅助接口（透传）
  readonly request: SessionModelRequest.Interface
}

/** Location-scoped model-context loader for durable Session Steps. */
// 服务标签：Location 作用域的模型上下文加载器，服务于持久会话步骤（Session Steps）
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionContext") {}

// 构建 Layer：组装各依赖服务并实现接口
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 逐个从上下文取出依赖服务
    const agents = yield* Agent.Service
    const builtins = yield* InstructionBuiltIns.Service
    const model = yield* Model.Service
    const db = (yield* Database.Service).db
    const discovery = yield* InstructionDiscovery.Service
    const entries = yield* InstructionEntry.Service
    const location = yield* Location.Service
    const mcpInstructions = yield* McpInstructions.Service
    const mcpTools = yield* McpTool.Service
    const models = yield* SessionRunnerModel.Service
    const request = yield* SessionModelRequest.Service
    const referenceInstructions = yield* ReferenceInstructions.Service
    const skillInstructions = yield* SkillInstructions.Service
    const store = yield* SessionStore.Service
    const registry = yield* Tool.Service

    // 解析会话使用的模型（基于可用模型清单）
    const resolveModel = (session: SessionSchema.Info) => models.resolve(session, model.available)

    // 选择标题生成能力：专用的 title agent + 尽量小/便宜的模型
    const selectTitle = Effect.fn("SessionContext.selectTitle")(function* (session: SessionSchema.Info) {
      // 获取内置的 title agent；不存在则无法生成标题
      const agent = yield* agents.get(Agent.ID.make("title"))
      if (!agent) return
      // 先解析会话的主模型（失败则视为无主模型）
      const primary = yield* resolveModel(session).pipe(Effect.orElseSucceed(() => undefined))
      // 计算标题模型候选：agent 指定模型 > 供应商的小模型 > 主模型的更低推理档位
      const candidate = yield* Effect.gen(function* () {
        // agent 显式指定了模型：取其详情与变体（缺省用最小推理档）
        if (agent.model) {
          const info = yield* model.get(agent.model.providerID, agent.model.id)
          return info && { info, variant: agent.model.variant ?? minimalVariant(info) }
        }
        // 无主模型则无法降级
        if (!primary) return
        // 尝试主模型供应商的“小”模型
        const small = yield* model.small(primary.ref.providerID)
        if (small) return { info: small, variant: minimalVariant(small) }
        // Without a lower variant, the primary model at its selected variant is already the fallback.
        // 没有更小的模型时：找主模型中比当前变体更低的推理档位作为回退
        const info = yield* model.get(primary.ref.providerID, primary.ref.id)
        const variant = info && lowerVariant(info, primary.ref.variant)
        return variant && { info, variant }
      })
      // 校验候选模型确实可用（解析失败则回退）
      const preferred =
        candidate &&
        (yield* resolveModel({
          ...session,
          model: Model.Ref.make({
            providerID: candidate.info.providerID,
            id: candidate.info.id,
            ...(candidate.variant ? { variant: candidate.variant } : {}),
          }),
        }).pipe(Effect.orElseSucceed(() => undefined)))
      // 最终选择：优先专用候选，否则用主模型
      const selected = preferred ?? primary
      // 没有任何可用模型：返回 undefined
      if (!selected) return
      // 返回 title agent、主模型与最终选择的模型
      return { agent, primary, selected }
    })

    // 选择阶段：固定会话、agent、指令源与工具快照
    const select = Effect.fn("SessionContext.select")(function* (sessionID: SessionSchema.ID) {
      // 读取会话；不存在则直接终止（程序性错误）
      const session = yield* store.get(sessionID)
      if (!session) return yield* Effect.die(new Error(`Session not found: ${sessionID}`))
      // 会话所属 Location 与当前不同：中断本 Effect（调用方需切换 Location）
      if (session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID)
        return yield* Effect.interrupt

      // 刷新 MCP 工具（确保动态注册完成）
      yield* mcpTools.flush
      // 选择会话的 agent
      const agent = yield* agents.select(session.agent)
      // agent 无详情：抛出找不到 Agent 的错误
      if (!agent.info) return yield* new AgentNotFoundError({ sessionID: session.id, agent: session.agent ?? agent.id })
      // Session permissions narrow discovery the same way they narrow the tool snapshot.
      // 合并 agent 与会话级权限：会话权限与工具快照一样会收窄指令发现范围
      const permissions = Permission.merge(agent.info.permissions, session.permissions ?? [])
      // 并发加载全部指令源与工具快照
      const loaded = yield* Effect.all(
        {
          tools: registry.snapshot(permissions),
          builtins: builtins.load(),
          discovery: discovery.load(),
          skills: skillInstructions.load(permissions),
          references: referenceInstructions.load(),
          mcp: mcpInstructions.load(permissions),
          entries: entries.load(sessionID),
        },
        { concurrency: "unbounded" },
      )
      // 返回选择结果
      return {
        session,
        agent: { ...agent, info: agent.info },
        // Ordered from most to least shared across sessions so the baseline stays a reusable
        // prompt-cache prefix: user-level catalog and guidance, then project instructions, then
        // the date and environment, which vary by day and directory.
        // 按跨会话共享度从高到低排序，使基线保持为可复用的 prompt 缓存前缀：用户级目录与指引 → 项目指令 → 随日期/目录变化的环境信息
        instructions: Instructions.combine([
          CodeModeInstructions.make(loaded.tools.codeModeCatalog),
          loaded.mcp,
          loaded.references,
          loaded.skills,
          loaded.discovery,
          loaded.builtins,
          loaded.entries,
        ]),
        tools: loaded.tools,
      }
    })

    // 加载阶段：为选择解析模型与活跃历史
    const load = Effect.fn("SessionContext.load")(function* (selection: Selection) {
      // 解析模型
      const model = yield* resolveModel(selection.session)
      // 加载供运行器使用的历史条目（含初始指令渲染）
      const history = yield* SessionHistory.entriesForRunner(
        db,
        selection.session.id,
        selection.instructions,
        model.ref,
      )
      // 返回完整加载结果
      return {
        session: selection.session,
        agent: selection.agent,
        model,
        initial: history.initial,
        messages: history.entries.map((entry) => entry.message),
        tools: selection.tools,
      }
    })

    // 返回服务实现
    return Service.of({ select, load, resolveModel, selectTitle, request })
  }),
)

/** Variant IDs that minimize reasoning output, in preference order. */
// 最小化推理输出的变体 ID 列表（按优先顺序）
const MINIMAL_REASONING_VARIANTS = ["none", "minimal", "low"].map((id) => Model.VariantID.make(id))

// 找出模型支持的最小推理档位
const minimalVariant = (info: Model.Info) =>
  MINIMAL_REASONING_VARIANTS.find((id) => info.variants.some((item) => item.id === id))

/**
 * `none` and `minimal` always reduce reasoning. `low` can enable reasoning on a model whose default
 * does not reason, so it is only used when it ranks below the variant the session selected.
 */
// 找出比会话所选档位更低的推理档位：none/minimal 总能降低推理；low 可能在默认不推理的模型上开启推理，故仅当其排名低于所选档位时使用
const lowerVariant = (info: Model.Info, selected: Model.VariantID | undefined) => {
  // 计算某档位在模型变体列表中的索引（排名）
  const rank = (id: Model.VariantID | undefined) => info.variants.findIndex((item) => item.id === id)
  // 找到模型支持且满足条件的最低档位
  return MINIMAL_REASONING_VARIANTS.find((id) => rank(id) !== -1 && (id !== "low" || rank(id) < rank(selected)))
}

// 创建 Location 级依赖注入节点：声明服务、层实现及全部依赖节点
export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    Agent.node,
    Model.node,
    Database.node,
    InstructionBuiltIns.node,
    InstructionDiscovery.node,
    InstructionEntry.node,
    Location.node,
    McpInstructions.node,
    McpTool.node,
    ReferenceInstructions.node,
    SessionRunnerModel.node,
    SessionModelRequest.node,
    SessionStore.node,
    SkillInstructions.node,
    Tool.node,
  ],
})
