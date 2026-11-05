// =====================================================================
// 文件角色：SessionCompaction —— 上下文压缩（compaction）核心。
// 当会话接近模型上下文窗口时，把“旧对话”总结成一份结构化摘要（摘要 +
// 最近 keep 个 token 原文），替换掉冗长历史；也支持 provider 原生压缩
// （native）与后台预计算（precompute）。本文件同时包含：压缩触发时机
// 判定、请求尺寸预算、收缩重试策略、token 估算与费用记账。
// =====================================================================
export * as SessionCompaction from "./compaction.js"

// @opencode/ai/effect：与 LLM 相关的统一抽象（请求/事件/错误/用量）。
import {
  ai,
  AIError,
  type ContentPart,
  InvalidProviderOutputError,
  isContextOverflowFailure,
  LLMClient,
  LLMEvent,
  type LLMRequest,
  Message,
  type ToolEntry,
  UnknownProviderError,
  type Usage,
} from "@opencode/ai/effect"
// StreamOptions：流式请求选项类型。
import type { StreamOptions } from "@opencode/ai/route"
// 插件可提供的压缩结果类型（钩子可自己给摘要）。
import type { SessionCompactionResult } from "@opencode/plugin/effect/session"
// 会话错误的 Schema 类型。
import type { SessionError } from "@opencode/schema/session-error"
// 把 Layer 包装成 Node 的工具。
import { makeLocationNode } from "@opencode/util/effect/app-node"
// effect 核心：Clock（时间）、DateTime（日期）、Scope（作用域，承载后台 fiber）、
// Fiber（轻量线程）、Result（Result/Either 风格返回）、Stream（流）。
import { Clock, Context, DateTime, Effect, Exit, Fiber, Layer, Result, Scope, Stream } from "effect"
// Agent 服务（取 "compaction" agent 的配置）。
import { Agent } from "../agent.js"
// 事件总线。
import { Bus } from "../bus.js"
// 数据库。
import { Database } from "../database/database.js"
// LLM 客户端节点。
import { llmClient } from "../effect/app-node-platform.js"
// 指令（AGENTS.md 等）拼接工具。
import { Instructions } from "../instructions/index.js"
// 模型目录服务。
import { Model } from "../model.js"
// 可配置状态（Settings/Editor 模式）。
import { State } from "../state.js"
// token 估算工具。
import { Token } from "../util/token.js"
// 只导入 SessionContext 的类型。
import type { SessionContext } from "./context.js"
// 会话事件。
import { SessionEvent } from "./event.js"
// 会话历史读取。
import { SessionHistory } from "./history.js"
// 只导入 SessionMessage 类型。
import type { SessionMessage } from "./message.js"
// 模型请求组装服务。
import { SessionModelRequest } from "./model-request.js"
// 模型解析服务。
import { SessionRunnerModel } from "./runner/model.js"
// 重试策略。
import { SessionRunnerRetry } from "./runner/retry.js"
// 会话消息 → LLM 消息的转换器。
import { toLLMMessages } from "./runner/to-llm-message.js"
// “最近原文”工具：摘要旁保留的逐字文本。
import { SessionRecentText } from "./recent-text.js"
// 错误转换与内容过滤错误。
import { contentFilterError, toSessionError } from "./to-session-error.js"
// 用量记录。
import { SessionUsage } from "./usage.js"

// 压缩配置项。
export type Settings = {
  // 是否开启自动压缩（手动 /compact 始终可用）。
  auto: boolean
  /** Room kept free below the model's limits before compacting: a share such as "20%", or tokens. Unset keeps 15%, and at least 16k, free. */
  // buffer：压缩前在模型上限之下保留的空隙（"20%" 或 token 数）；
  // 未设置时默认 15% 且至少 16k。
  buffer?: number | string
  /** Tokens of recent conversation kept verbatim beside the summary. */
  // keep：摘要旁逐字保留的最近对话 token 数。
  keep: number
  /** Summarize in the background as the context nears the threshold, so automatic compaction can swap it in. */
  // precompute：接近阈值时在后台先算摘要，等自动压缩触发时直接换入。
  precompute: boolean
}

// Editor：可编辑配置的接口（State 模式的更新器）。
export type Editor = {
  configure: (settings: Partial<Settings>) => void
}

/** A prompt's size: `measured` is what the provider reported at the latest response, `estimated` is the text since. */
// Estimate：prompt 规模 = measured（provider 最近一次上报的实测值）+
// estimated（那之后新增文本的估算值）。
export type Estimate = { readonly measured: number; readonly estimated: number }

// Trigger：压缩的触发方式。
export type Trigger =
  /** `overflow`: the provider just rejected this context as too long. `estimate` is `estimatePrompt(context)`. */
  // auto：自动触发；overflow：provider 刚刚拒绝“上下文太长”。
  | { readonly reason: "auto" | "overflow"; readonly context: SessionContext.Loaded; readonly estimate?: Estimate }
  /** `inputID` is the `/compact` inbox item, whose message shows the outcome. */
  // manual：用户执行 /compact；inputID 是收件箱消息（用于回写结果）。
  | { readonly reason: "manual"; readonly context: SessionContext.Loaded; readonly inputID: SessionMessage.ID }

// Outcome：compact 的三种结果（跳过/完成/失败）。
export type Outcome =
  /** Only `auto` skips: the context fits, or automatic compaction is off. */
  // skipped 只有 auto 会返回：上下文还够用或自动压缩被关闭。
  | { readonly status: "skipped" }
  | { readonly status: "completed" }
  | { readonly status: "failed"; readonly error: SessionError.Error }

// 服务接口：compact（执行压缩）与 precompute（后台预摘要）。
export interface Interface extends State.Transformable<Editor> {
  readonly compact: (trigger: Trigger) => Effect.Effect<Outcome>
  /**
   * Starts a background summary when the context nears the threshold. Never waits for it. Loads `context` only when
   * background summaries are on. `estimate`, when given, is `estimatePrompt` of the loaded context.
   */
  // precompute：接近阈值时启动后台摘要；绝不等待；只在开关开启时才加载上下文。
  readonly precompute: <E>(
    context: Effect.Effect<SessionContext.Loaded, E>,
    estimate?: Estimate,
  ) => Effect.Effect<void, E>
}

// Effect 服务标识。
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCompaction") {}

/**
 * A summary fills `text`, and references the messages it keeps verbatim with `metadata.keepID`; history
 * rebuilds their text from that. A native compaction fills `native.messages` with its replacement window.
 */
// Result：摘要结果。text=摘要正文；metadata.keepID 指向逐字保留区间的起始
// 消息（历史重建时用）；native.messages 是原生压缩返回的替换窗口。
type Result = {
  readonly text: string
  readonly native?: SessionMessage.Native
  readonly metadata?: Record<string, unknown>
}

// Failure：失败 = 一条会话错误。
type Failure = {
  readonly error: SessionError.Error
}

// Prepared：SessionModelRequest.compaction 的成功返回类型（请求+选项等）。
type Prepared = Effect.Success<ReturnType<SessionModelRequest.Interface["compaction"]>>

// Streamed：流式过程中的累积状态（目前只有文本）。
type Streamed = {
  readonly text: string
}

/** A summary run off the critical path: it covers only `messages`, streams no deltas, and bills into `usage`. */
// Background：跑在关键路径之外的摘要：只覆盖指定 messages、不推送增量、
// 用量计入 usage 回调。
type Background = {
  readonly messages: ReadonlyArray<SessionMessage.Info>
  readonly usage: (usage: SessionUsage.Recorded) => void
}

/** A background summary of everything before `keepID`, held until automatic compaction is due. */
// Precomputed：一份后台摘要“存票”：涵盖 keepID 之前的全部内容，等自动
// 压缩到期时换入。
type Precomputed = {
  readonly firstID: SessionMessage.ID | undefined
  readonly keepID: SessionMessage.ID
  readonly model: SessionContext.Loaded["model"]["ref"]
  readonly initial: string
  /** The longest tail since `keepID` that compaction still accepts beside this summary. */
  // tailLimit：换入时仍可接受的、keepID 之后“尾部”的最大 token 数。
  readonly tailLimit: number
  /** Background summaries that failed since the last compaction, this one included once it has. */
  // failures：自上次压缩以来失败的后台摘要次数。
  readonly failures: number
  readonly usage: SessionUsage.Recorded[]
  readonly fiber: Fiber.Fiber<Result, Failure>
}

// “还没东西可压”的失败常量。
const NOTHING_TO_COMPACT: Failure = { error: { type: "compaction.unavailable", message: "Nothing to compact yet" } }
/** After each "too long" rejection, the next attempt aims at this share of the first rejected request's size. */
// 每次“太长”被拒后，下一次尝试瞄准首次被拒请求尺寸的对应比例。
const SHRINK_STEPS = [0.85, 0.7, 0.5, 0.35]
// The least of the window kept free for the last reply before compaction and for the summary itself.
// 压缩前给最后一次回复、以及摘要本身保留的最小窗口。
const RESERVE_MIN = 16_000
/**
 * Share of the window kept free before automatic compaction. Above `RESERVE_MIN`, the margin between it and
 * `summaryRoom` absorbs a large step past the trigger, so the whole conversation still goes out unchanged and reuses
 * the cache. Single steps grew by up to ~22k tokens at p99 in real sessions.
 */
// 自动压缩前保留的窗口比例。单步增长 p99 约 22k token，这段余量让
// “整段对话原样发出、复用缓存”成为可能。
const RESERVE_SHARE = 0.15
/** A common window size, assumed for the compaction request when the model's window is unknown. */
// 模型窗口未知时假设的常见窗口大小。
const UNKNOWN_WINDOW = 200_000
/** A summary gets at least this much output, or the room left if less, even when the estimate margin leaves less. */
// 摘要输出至少给这么多 token（窗口装不下才缩减）。
const SUMMARY_OUTPUT_FLOOR = 32_000
/**
 * How far one exchange of a summary transcript is shortened, in the order the levels apply: whole; tool outputs cut;
 * tool outputs left out and tool inputs cut; only the user's text, cut; omitted.
 */
// 摘要转写（transcript）里一段交互的缩短等级，按序应用：
// 完整 → 裁剪工具输出 → 去掉工具输出并裁剪工具输入 → 只留用户文本（裁剪）→ 省略。
const OUTPUTS_CLIPPED = 1
const OUTPUTS_REMOVED = 2
const USER_ONLY = 3
const OMITTED = 4
// 等级序列：0 表示不缩短。
const TRANSCRIPT_LEVELS = [0, OUTPUTS_CLIPPED, OUTPUTS_REMOVED, USER_ONLY, OMITTED]
/** Characters kept, from the start and end, of a cut tool input, tool output, or user message. */
// 裁剪文本时首尾各保留的字符数。
const TRANSCRIPT_CLIP = 2_000
// 图片/附件的 token 估算常数。
const IMAGE_TOKEN_ESTIMATE = 1_500
const PDF_TOKEN_ESTIMATE = 2_000
/**
 * Tokens before the ceiling at which a background summary starts. Writing one takes 30–60 s, and in that time the
 * conversation grows by a few thousand tokens at the median but by 25k or more one time in twenty, when large file
 * reads arrive together. How far ahead to start depends on that growth, not on the window, so the lead is fixed.
 */
// 提前量：距上限还有 60k token 就开始后台摘要。写一份摘要要 30-60 秒，
// 期间对话还会增长（中位数几千，1/20 概率超 25k）。
const PRECOMPUTE_LEAD = 60_000
/** Prompt caches expire this long after their last use unless the model sets `cache.ttl`. */
// prompt 缓存默认 5 分钟过期（除非模型配置了 cache.ttl）。
const CACHE_LIFETIME = 5 * 60_000
/** A background summary starts only while this much of the latest response's cache lifetime is left. */
// 缓存剩余寿命不足 30 秒时不再启动后台摘要（收益太低）。
const CACHE_MARGIN = 30_000
/**
 * The most text a swapped-in summary keeps verbatim beside it, and the tail at which a held summary is replaced, as a
 * share of the budget. Tails are usually far shorter; the limit is there for bursts of large tool inputs or pasted
 * text. At 40%, a swapped-in context stays under about two thirds of the budget even with Claude's tokenizer, so the
 * next cycle keeps room; a longer tail makes compaction summarize from scratch instead.
 */
// 换入摘要时允许保留的“尾部”上限（占预算 40%）；超限则丢弃存票重新摘要。
const PRECOMPUTED_TAIL_SHARE = 0.4
/** Failed background summaries after which no new one starts until the next compaction. */
// 连续失败 2 次后台摘要后，暂停预计算直到下次压缩。
const PRECOMPUTE_MAX_FAILURES = 2

// 摘要的输出模板：目标/需求/决策/工作状态/下一步/相关文件/重要上下文。
const SUMMARY_TEMPLATE = `You MUST use this format for your response (you may omit sections that aren't applicable). Do not include the <template> tags in your response.
<template>
## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Requirements
- [constraints, preferences, requirements, and scope boundaries stated by the user, or "(none)"]

## Decisions
- [decisions already made and why, or "(none)"]

## Work State
Break the objective into smaller goals and report which are completed, which are being worked on, and which are blocked.
### Completed
- [goals that have been completed; otherwise "(none)"]

### Active
- [goals currently being worked on; otherwise "(none)"]

### Blocked
- [anything blocking progress, and why; otherwise "(none)"]

## Next Move
1. [ordered list of next actions, or "(none)"]

## Relevant Files
List the files and directories, other than the current working directory, that another agent would need to open to continue this work. Include at most 15, most important first. Do not list every file that was read or changed. Include paths outside the current working directory when relevant. If none, write "(none)".
- \`[file or directory path]\`: [brief reason it matters]

## Important Context
- [facts the next agent cannot continue without and cannot easily find on its own; or "(none)"]
</template>`

// 摘要写作规则：简明、保留精确路径/命令/报错原文、不重复已回答的问题、
// 保留工作流状态（未提交/已提交/已推送）、不提及压缩这件事本身。
const SUMMARY_RULES = `Rules:
- Keep each section concise. Use terse, single-line bullets, not prose paragraphs or nested lists.
- Prefer short references over detailed restatement. It is fine to leave out information the next agent can recover from the code or the files listed above.
- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers.
- Carry forward only user questions or requests that remain unanswered or require further action. Do not repeat ones that newer history has answered or resolved. Preserve exact wording when carrying one forward.
- Preserve consequential workflow state, including whether changes are uncommitted, committed, pushed, under review, or merged.
- Do not mention the summary process or that context was compacted.`

// buildPrompt：组装摘要请求的用户提示。
// update=false：全新摘要；update=true：在既有检查点上更新（含合并规则）。
export const buildPrompt = (update: boolean, legacy = false) => {
  // 两种模式共享的指令：只总结用户与助手说过/做过的事；不要复述
  // AGENTS.md 等环境信息（下一个 agent 会单独拿到它们的最新版本）。
  const shared = [
    "Summarize only what the user and the assistant said and did. Leave out instructions and setup the assistant was given rather than told by the user: repository conventions, instruction files such as AGENTS.md, and environment details like the session ID. The next agent receives current versions of all of these separately.",
    SUMMARY_TEMPLATE,
    SUMMARY_RULES,
    "Do not continue the task or call tools.",
    "Return only the structured summary in the requested format. Do not include a preamble, explanation, or other commentary.",
  ]
  // 全新摘要：一句话说明任务后接共享段。
  if (!update) {
    return [
      "You MUST summarize the conversation above into a structured summary that will be given to another agent to resume the work.",
      ...shared,
    ].join("\n\n")
  }
  // 更新模式：新历史优先；合并工作状态；不输出旧的包装标签。
  return [
    "Update the existing checkpoint in the conversation above into one consolidated summary.",
    // Before #48058 (Sep 2026), summaries kept nearly everything: every file touched, per-edit changelogs,
    // restated AGENTS.md conventions, and an "Additional Context" section that grew on every update. The
    // preserve-first update prompt would carry that detail forward indefinitely, so a checkpoint from that
    // template is rewritten once at the current level of detail. The rewrite uses the new headings, so later
    // updates skip this. Remove once no session still in use has a latest checkpoint older than #48058.
    // legacy：旧模板的检查点信息过载，更新时要求按新详略重写一次。
    ...(legacy
      ? [
          "The existing checkpoint was written with an earlier format that recorded far more detail than this one asks for. Rewrite it at the level of detail described below rather than carrying its detail forward. Keep its requirements, decisions, and open questions; they came from earlier conversation with the user.",
        ]
      : []),
    "Newer history always takes precedence over the existing checkpoint. Preserve previous information unless newer history clearly contradicts, supersedes, resolves, or makes it stale. If something is no longer relevant to continuing the work, you may remove it.",
    "Incorporate newer requirements, decisions, progress, and context. Reconcile Work State and Next Move: move completed work out of Active, remove resolved blockers and answered questions, and preserve unresolved or pending work.",
    "Return only the updated Markdown sections. Do not reproduce the `<conversation-checkpoint>`, `<summary>`, or `<recent-context>` wrapper tags from the previous checkpoint.",
    ...shared,
  ].join("\n\n")
}

// NUDGE：模型回复不符合模板时的唯一一次提醒。
const NUDGE =
  "The previous response did not fill in the required summary template. Do not call tools. Return the summary as text using the exact section headings from the template."

/** Summaries written with the previous template carry this catch-all heading. */
// 旧模板摘要的特征标题（用于识别 legacy）。
const LEGACY_HEADING = "## Additional Context"

// Layer：压缩服务的依赖装配与实现。
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 依赖注入：agent 配置、事件总线、LLM 客户端、模型目录、模型解析、
    // 数据库、模型请求组装。
    const agents = yield* Agent.Service
    const bus = yield* Bus.Service
    const llm = yield* LLMClient.Service
    const catalog = yield* Model.Service
    const models = yield* SessionRunnerModel.Service
    const db = (yield* Database.Service).db
    const requests = yield* SessionModelRequest.Service

    // 当前作用域：后台摘要 fiber 都 fork 进它，Location 关闭时统一回收。
    const scope = yield* Scope.Scope
    // 每个会话至多持有一份后台预摘要。
    const precomputed = new Map<SessionContext.Loaded["session"]["id"], Precomputed>()

    // State.create：可配置状态 + 编辑器（configure）的模式化封装。
    const state = State.create<Settings, Editor>({
      name: "session-compaction",
      // 默认：自动压缩开、保留 15k token 原文、预计算关。
      initial: () => ({ auto: true, keep: 15_000, precompute: false }),
      editor: (settings) => ({
        configure: (update) => {
          Object.assign(settings, update)
        },
      }),
    })

    /** The model that writes the summary, and the request size it aims for. */
    // selectModel：决定“用哪个模型写摘要”。优先取 compaction agent 配置的
    // 模型；否则用当前会话模型。cap 是本次请求的尺寸目标。
    const selectModel = Effect.fnUntraced(function* (
      context: SessionContext.Loaded,
      buffer: Settings["buffer"],
      native: boolean,
    ) {
      // 原生压缩不需要 compaction agent（由 provider 自己做）。
      const agent = native ? undefined : yield* agents.get(Agent.ID.make("compaction"))
      // 依次尝试：agent 配置的模型 → 会话当前模型。
      const model =
        (agent?.model &&
          (yield* models
            .resolve({ ...context.session, model: agent.model }, catalog.available)
            .pipe(Effect.orElseSucceed(() => undefined)))) ??
        context.model
      const ceiling = calculateCeiling(model.limit, buffer)
      // An unknown window never triggers auto compaction, but the compaction request still needs a size to aim for.
      // 窗口未知时按 UNKNOWN_WINDOW 假设算一个目标尺寸。
      const cap = Number.isFinite(ceiling)
        ? ceiling
        : calculateCeiling({ ...model.limit, context: UNKNOWN_WINDOW }, buffer)
      return { context: model === context.model ? context : { ...context, model }, cap }
    })

    // compact：压缩主入口。按 Trigger 分派：auto/overflow/manual。
    const compact = Effect.fn("SessionCompaction.compact")(function* (trigger: Trigger): Effect.fn.Return<Outcome> {
      const settings = state.get()
      const context = trigger.context

      // Only the user compacts when automatic compaction is off, overflow included.
      // 自动压缩关闭时只有用户（manual）能压缩，overflow 也不例外。
      if (trigger.reason !== "manual" && !settings.auto) return { status: "skipped" }
      // auto 触发但还不到阈值 → 跳过。
      if (
        trigger.reason === "auto" &&
        !due(context, calculateCeiling(context.model.limit, settings.buffer), trigger.estimate)
      )
        return { status: "skipped" }
      // 取出（并清掉）该会话的后台预摘要存票。
      const held = precomputed.get(context.session.id)
      precomputed.delete(context.session.id)
      // provider 是否支持原生压缩。
      const native = context.model.compaction?.type === "native"
      const model = yield* selectModel(context, settings.buffer, native)
      // The provider just rejected this context, so the estimate ran low; the first attempt already aims below it.
      // overflow 触发时：估算偏低已被证实，第一枪直接瞄准被拒尺寸的 85%。
      const budget =
        trigger.reason === "overflow"
          ? Math.min(model.cap, Math.floor(total(trigger.estimate ?? estimatePrompt(context)) * SHRINK_STEPS[0]))
          : model.cap

      // 若 selectModel 换了模型，同步替换 trigger 里的上下文。
      const selected = model.context === context ? trigger : { ...trigger, context: model.context }
      // The runner opened the manual compaction's message when it delivered the `/compact` item. An automatic one
      // opens here, before any wait, so a background summary still being written shows as a running compaction.
      // 手动压缩的消息由 runner 打开；自动压缩在这里广播“开始”（等待期间
      // UI 也能显示 running 状态）。
      if (trigger.reason !== "manual")
        yield* bus.publish(SessionEvent.Compaction.Started, { sessionID: context.session.id, reason: "auto" })
      // 三选一：换入预摘要 / 原生压缩 / 自己总结。
      const swapped = held ? yield* usePrecomputed(selected, held, budget, settings) : undefined
      const compaction = swapped
        ? Effect.succeed(swapped)
        : native
          ? compactNatively(selected, budget, settings.keep)
          : summarize(selected, budget, settings.keep)
      // 成功或失败都通过 publish 广播事件并落库。
      return yield* compaction.pipe(
        Effect.matchEffect({
          onSuccess: (result) => publish(selected, result),
          onFailure: (failure) => publish(selected, failure),
        }),
      )
    })

    /**
     * Once the context is within `PRECOMPUTE_LEAD` of the ceiling, summarizes everything before the latest response
     * in the background. That is the prefix the provider just processed, so the summary request reads it from the
     * prompt cache. The summary is held, not applied: swapping it in now would rewrite the prefix and throw away the
     * cache for every step until compaction is actually due. One summary is held per Session until compaction takes
     * it, or until it fails or falls too far behind, when a newer response replaces it.
     *
     * On a small window the lead is at most half the room the cycle started with, so the summary still covers more
     * than the previous one.
     */
    // precompute：后台预摘要。接近上限时，把“最近一次响应之前”的内容先
    // 摘要出来存着——那正是 provider 刚处理过的前缀，能吃到 prompt 缓存。
    // 摘要只“持有”不“应用”：现在换入会改写前缀、白白丢掉每一步的缓存。
    const precompute = Effect.fn("SessionCompaction.precompute")(function* <E>(
      load: Effect.Effect<SessionContext.Loaded, E>,
      given?: Estimate,
    ) {
      const settings = state.get()
      // 开关未开（precompute 或 auto）→ 不做。
      if (!settings.precompute || !settings.auto) return
      const context = yield* load
      // 原生压缩模型没有“自己总结”这回事。
      if (context.model.compaction?.type === "native") return
      const ceiling = calculateCeiling(context.model.limit, settings.buffer)
      // 窗口未知 → 不做。
      if (!Number.isFinite(ceiling)) return
      const estimate = given ?? estimatePrompt(context)
      // 已经到期该压缩了 → 直接等 compact 处理，不预计算。
      if (due(context, ceiling, estimate)) return
      // 找最近一条有实测 token 的助手消息（缓存锚点）。
      const first = context.messages.find((message) => hasMeasuredPrompt(message, context.model.ref))
      const cycleStart = first?.type === "assistant" && first.tokens ? promptTokens(first.tokens) : 0
      // 还没到“提前量”窗口（且提前量不超过本轮剩余空间的一半）→ 不做。
      if (total(estimate) < ceiling - Math.min(PRECOMPUTE_LEAD, (ceiling - cycleStart) / 2)) return

      // 锚点：最近一次带实测 token 的响应，摘要覆盖它之前的所有消息。
      const anchorIndex = context.messages.findLastIndex((message) => hasMeasuredPrompt(message, context.model.ref))
      const anchor = context.messages[anchorIndex]
      // 没有可用的锚点 → 不做。
      if (anchorIndex <= 0 || anchor?.type !== "assistant" || !anchor.tokens) return

      const sessionID = context.session.id
      // 检查既有的存票：失败了吗？尾部超限了吗？
      const existing = precomputed.get(sessionID)
      const exit = existing?.fiber.pollUnsafe()
      const failed = exit !== undefined && Exit.isFailure(exit)
      const failures = (existing?.failures ?? 0) + (failed ? 1 : 0)
      if (existing) {
        const index = heldIndex(existing, context)
        // 存票仍然有效且尾部足够短 → 继续等它，什么都不做。
        if (index >= 0 && !failed && tailTokens(context, index) <= existing.tailLimit) return
        // Summarizing up to the same response again would repeat the same request.
        // 锚点没动却要重摘（或失败次数超限）→ 放弃，避免重复同一请求。
        if (index >= 0 && (existing.keepID === anchor.id || failures >= PRECOMPUTE_MAX_FAILURES)) return
        // 否则中断旧 fiber、删除存票，准备重摘。
        yield* Fiber.interrupt(existing.fiber)
        precomputed.delete(sessionID)
      }
      // After a model switch nothing is cached for the new model yet; wait until its first response has written it.
      // 换了模型（或 variant）后缓存为空 → 等新模型的首个响应写入缓存再摘。
      if (anchor.model.id !== context.model.ref.id || anchor.model.variant !== context.model.ref.variant) return
      // The same once the latest response is older than the cache lifetime, as when the user comes back from a
      // break: the summary would write the whole prefix again, at the same time as the next request.
      // 锚点太旧（缓存已过期）同理：摘要会与下一次请求同时重写整个前缀。
      const age = (yield* Clock.currentTimeMillis) - DateTime.toEpochMillis(anchor.time.created)
      if (age > cacheLifetime(context.model.cache?.ttl) - CACHE_MARGIN) return

      // 用（可能不同的）摘要模型 fork 一个后台摘要 fiber。
      const model = yield* selectModel(context, settings.buffer, false)
      const usage: SessionUsage.Recorded[] = []
      const fiber = yield* summarize({ reason: "auto", context: model.context }, model.cap, settings.keep, {
        messages: context.messages.slice(0, anchorIndex),
        usage: (recorded) => usage.push(recorded),
      }).pipe(Effect.forkIn(scope))
      // 登记存票。
      precomputed.set(sessionID, {
        firstID: context.messages[0]?.id,
        keepID: anchor.id,
        model: context.model.ref,
        initial: Instructions.join(context.initial),
        tailLimit: tailLimit(model.cap),
        failures,
        usage,
        fiber,
      })
    })

    /**
     * The held summary plus everything since it, kept verbatim, when it still describes this conversation and that
     * tail is short. Waits for a summary still being written. Undefined, after stopping the background work, when it
     * cannot be used; compaction then summarizes as usual.
     */
    // usePrecomputed：尝试用存票。条件：开关开、非 overflow、非原生、
    // 存票仍描述本会话、尾部够短。不可用则中断后台 fiber 返回 undefined。
    const usePrecomputed = Effect.fnUntraced(function* (
      trigger: Trigger,
      held: Precomputed,
      budget: number,
      settings: Settings,
    ): Effect.fn.Return<Result | undefined> {
      const context = trigger.context
      const index = heldIndex(held, context)
      const usable =
        settings.precompute &&
        trigger.reason !== "overflow" &&
        context.model.compaction?.type !== "native" &&
        index >= 0 &&
        tailTokens(context, index) <= tailLimit(budget)
      if (!usable) {
        yield* Fiber.interrupt(held.fiber)
        return undefined
      }

      // 等后台摘要写完（被中断时把 fiber 一并取消）。
      const exit = yield* Fiber.await(held.fiber).pipe(Effect.onInterrupt(() => Fiber.interrupt(held.fiber)))
      if (Exit.isFailure(exit)) return undefined
      // Background calls were billed as they finished; the compaction's message still shows what it cost.
      // 后台调用在各自完成时已记账；压缩消息汇总显示总花费。
      held.usage.forEach((usage) => addSpent(context.session.id, usage))
      return { ...exit.value, metadata: { keepID: held.keepID, ...exit.value.metadata } }
    })

    // due：自动压缩是否到期。三种豁免：刚完成过压缩、原生加密窗口还没有
    // 实测值、估算总量未达上限。
    const due = (context: SessionContext.Loaded, ceiling: number, estimate?: Estimate) => {
      const messages = context.messages
      // A compaction just completed; let the runner rebuild the request from it first.
      const last = messages.at(-1)
      if (last?.type === "compaction" && last.status === "completed") return false
      // An encrypted native window estimates as nothing, so wait for a response to measure it.
      const measured = messages.findLastIndex((message) => hasMeasuredPrompt(message, context.model.ref))
      if (measured < messages.findLastIndex(SessionHistory.isNativeCompaction)) return false
      return total(estimate ?? estimatePrompt(context)) >= ceiling
    }

    /**
     *   first:  [E1 … E8][E9 E10]                  →  [S1 + "E9 E10"]
     *   again:  [S1 + "E9 E10"][E11 … E18][E19]    →  [S2 + "E19"]      S2 covers the whole current conversation
     *
     * The model is sent the whole conversation, including the tail kept beside the summary, then the summary prompt.
     * Keeping the normal request's prefix intact lets the summary reuse its prompt cache:
     *
     *   [system][S1 + "E9 E10"][E11 … E18][E19][prompt]    plus one nudge if the reply skips the template
     *
     * Later requests open with the checkpoint as one user message:
     *
     *   <conversation-checkpoint>
     *     <summary>S2</summary>
     *     <recent-context>E19</recent-context>
     *   </conversation-checkpoint>
     *   [new messages…]
     *
     * E = one exchange: a user message and the replies to it. S = a summary. [S + "…"] = one checkpoint: a summary
     * plus the newest `keep` tokens of messages, referenced by their first message and sent as text.
     */
    // summarize：自己总结。发送“完整对话（含保留的尾部）+ 摘要提示词”，
    // 前缀与正常请求一致 → 复用 prompt 缓存；之后的新请求以检查点开头。
    const summarize = Effect.fnUntraced(function* (
      trigger: Trigger,
      budget: number,
      keep: number,
      background?: Background,
    ): Effect.fn.Return<Result, Failure> {
      const context = trigger.context
      // 后台摘要只覆盖指定 messages；正式压缩覆盖全部。
      const messages = background?.messages ?? context.messages
      // 切分：决定 keepID（保留区起点）。
      const split = splitConversation(messages, keep)
      if (split === undefined) return yield* Effect.fail(NOTHING_TO_COMPACT)
      // A background summary covers all of its messages; what follows them is kept when it is swapped in.
      const keepID = background ? undefined : split.keepID

      // 是否存在上一个压缩检查点 → 用“更新模式”的提示词。
      const previous = previousCompaction(messages)
      const prompt = buildPrompt(previous !== undefined, previous?.summary.includes(LEGACY_HEADING) ?? false)
      // 模板的所有 "##" 标题，用于校验回复是否套用了模板。
      const headings = SUMMARY_TEMPLATE.split("\n").filter((line) => line.startsWith("##"))
      const filled = (text: string) => text.split("\n").some((line) => headings.includes(line.trim()))
      // 组装请求（走钩子）。
      const prepared = yield* prepare(context, messages, budget)
      // Size the unchanged request with the number that decided to compact: the last response's count plus an
      // estimate of what came after it. Characters overstate a conversation whose old reasoning the provider drops.
      // A hook can still make this request larger than that count; the provider then rejects it and it is resent as
      // text. An overflow already proved the count low, so it keeps the character estimate.
      // 尺寸依据：优先用 provider 的实测值（overflow 时只有字符估算）。
      const measured = trigger.reason === "overflow" ? undefined : measuredPrompt({ ...context, messages })

      // Hooks saw the request without the summary prompt, so it is appended here. A reply that ignores the
      // template gets one reminder before it counts as a failure.
      // send：把摘要提示词追加到请求末尾再发（钩子看到的是没有提示词的版本）。
      // 回复不符合模板 → 追加 NUDGE 再试一次；仍不行 → 失败。
      const send = (request: LLMRequest, size?: Estimate) =>
        Effect.gen(function* () {
          // fitOutput：按窗口给 maxTokens 留出合理余量。
          const prompted = fitOutput(
            { ...request, messages: [...request.messages, Message.user(prompt)] },
            context.model.limit,
            size && { ...size, estimated: size.estimated + Token.estimate(prompt) },
          )
          const reply = yield* stream(context, prompted, prepared.options, background)
          if (filled(reply.text)) return reply

          // 一次 NUDGE 重试。
          const nudged = fitOutput(
            { ...prompted, messages: [...prompted.messages, Message.user(NUDGE)] },
            context.model.limit,
            size && { ...size, estimated: size.estimated + Token.estimate(prompt) + Token.estimate(NUDGE) },
          )
          const retry = yield* stream(context, nudged, prepared.options, background)
          if (filled(retry.text)) return retry
          return yield* Effect.fail<Failure>({
            error: {
              type: "compaction.failed",
              message: retry.text.trim()
                ? "Compaction summary did not match the required template"
                : "Compaction produced no summary",
            },
          })
        })

      // 提示词与 NUDGE 的开销（从预算中扣除）。
      const overhead = Token.estimate(prompt) + Token.estimate(NUDGE)
      // Automatic compaction starts past the ceiling, so the whole conversation is sent unchanged while the window can
      // still fit the summary. Below that, the history before the tail is sent instead, as before: unchanged when it fits,
      // which still reuses the cache for that shorter prefix, and as text otherwise. Dropping exchanges to make room
      // for the tail would leave them in neither the summary nor the tail. Where 15% of the window is under
      // `RESERVE_MIN`, the ceiling equals `summaryRoom`, so automatic compaction always takes this fallback.
      // fit：本次请求允许的尺寸目标。
      const fit =
        trigger.reason === "overflow"
          ? budget
          : Math.max(budget, summaryRoom(context.model.limit, prepared.request.maxTokens))
      // deliver：按收缩策略真正发送。
      const result = yield* deliver(
        trigger,
        prepared,
        budget - overhead,
        send,
        {
          fit: fit - overhead,
          // history：去掉保留尾部的请求版本（尾部已逐字保留，无需再摘）。
          history: withoutTail(prepared.request, keepID),
          measured,
          // The provider just rejected this conversation, so sending it unchanged again would be rejected too.
          // overflow 场景：原样重发必被拒，直接按文本发。
          text: trigger.reason === "overflow",
        },
        background,
      )
      if (!keepID) return result
      // A compaction hook may choose its own kept range.
      // 正式压缩把 keepID 写进 metadata（历史重建时定位保留区间）。
      return { ...result, metadata: { keepID, ...result.metadata } }
    })

    /**
     *   endpoint:  [window]                      →  [U U][item]    the provider picks which messages to keep
     *   trigger:   [window][compaction_trigger]  →  [item]
     *                                            →  [U U][item]    we add the newest user messages within `keep`
     *
     * Later requests open with that replacement window in place of the history it covers:
     *
     *   [U U][item][new messages…]
     *
     * window = the previous compaction and everything since. item = one encrypted compaction item, which only
     * replays on the model that made it. U = a user message as typed.
     */
    // compactNatively：原生压缩。两种机制：
    // - trigger：请求带上 compaction_trigger，provider 返回 checkpoint；
    // - endpoint：provider 端点直接给替换窗口。
    const compactNatively = Effect.fnUntraced(function* (
      trigger: Trigger,
      budget: number,
      keep: number,
    ): Effect.fn.Return<Result, Failure> {
      const context = trigger.context
      // 没有任何可转成文本的消息 → 无可压缩。
      if (!context.messages.some(SessionRecentText.messageToText)) return yield* Effect.fail(NOTHING_TO_COMPACT)
      // 不支持的机制 → 报 provider.unsupported-operation。
      const unsupported = (message: string) =>
        Effect.fail<Failure>({ error: { type: "provider.unsupported-operation", message } })
      // 组装请求（走钩子）。
      const prepared = yield* prepare(context, context.messages, budget, "session")

      // 把返回窗口 + 用量包装成 Result（记账后返回）。
      const toResult = (window: ReadonlyArray<Message>, usage: Usage | undefined) =>
        spend(context.session.id, usage && SessionUsage.record(usage, context.model.cost)).pipe(
          Effect.as<Result>({
            text: "",
            // Plain JSON, not the schema encoder: provider metadata can hold undefined entries, which it rejects.
            // 用普通 JSON 深拷贝（schema 编码器会拒绝 metadata 里的 undefined）。
            native: { messages: JSON.parse(JSON.stringify(window)) },
          }),
        )

      // send：先试 trigger 机制，再试 endpoint 机制，都不行则报不支持。
      const send = (request: LLMRequest) => {
        if (ai.canCompact(request, { mechanism: "trigger" })) {
          return Effect.gen(function* () {
            // 读本地历史，取 keep 范围内的真实用户消息，与 checkpoint 一起返回。
            const history = yield* SessionHistory.load(db, context.session.id, "local").pipe(Effect.orDie)
            const retained = recentUserMessages(history, context.model, keep)
            const response = yield* llm.compact(request, { ...prepared.options, mechanism: "trigger" })
            return yield* toResult([...retained, Message.assistant(response.checkpoint)], response.usage)
          })
        }
        if (ai.canCompact(request)) {
          return llm
            .compact(request, { mechanism: "endpoint", http: prepared.options.http })
            .pipe(Effect.flatMap((response) => toResult(response.replacement, response.usage)))
        }
        return unsupported(`Native compaction is not supported for ${request.model.provider}/${request.model.route.id}`)
      }

      // 复用同一套收缩/重试策略发送。
      return yield* deliver(trigger, prepared, budget, send)
    })

    /**
     * Sends the request as-is if it is estimated to fit `shrink.fit`, else `shrink.history` as-is if it fits `target`,
     * and otherwise `shrink.history` as text aimed at `target` (see `flattenAndDropOldest`). `shrink.measured`, when
     * given, sizes the unchanged request until the provider rejects it; after that it is only sent as text.
     * Limits and estimates can be wrong, so until the provider rejects something as too long, a request that cannot
     * be made to fit is sent whole: unchanged, or as text once its media has to go. A "too long" rejection means the
     * estimate ran low, so the next attempts aim at 85%, 70%, 50%, then 35% of the first rejected request's estimate,
     * each shortening the transcript again from scratch, and a rejection after those gives up. A "payload too large"
     * rejection is about bytes, which inline media almost always accounts for, so one on the unchanged request resends
     * it as text, which carries no media, without counting; one on text counts as "too long". Other provider errors
     * resend the same request under the session's retry policy. A `Failure` from `send` is a reply that cannot be
     * used, and is never retried.
     */
    // deliver：压缩请求的发送策略核心。
    // 优先级：原样请求（装得下）→ history 版本（装得下）→ 文本转写（不断
    // 收缩）→ 按 SHRINK_STEPS 逐级瞄准更小目标。“payload too large”多为内联
    // 媒体超字节 → 改发文本（不计入收缩步数）；“too long”才计入收缩。
    // 其他 provider 错误走会话重试策略；send 的 Failure 不重试。
    const deliver = Effect.fnUntraced(function* (
      trigger: Trigger,
      prepared: Prepared,
      target: number,
      send: (request: LLMRequest, size?: Estimate) => Effect.Effect<Result, AIError | Failure>,
      shrink: {
        readonly fit: number
        readonly history: LLMRequest
        readonly measured?: Estimate
        readonly text?: boolean
      } = {
        fit: target,
        history: prepared.request,
      },
      background?: Background,
    ): Effect.fn.Return<Result, Failure> {
      const context = trigger.context
      // 钩子直接给了结果 → 不再调模型。
      if (prepared.event.result) return yield* fromHook(context, prepared.event.result, background)

      // 会话级重试策略。
      const policy = yield* SessionRunnerRetry.policy(context.session.id)
      // “too long”被拒次数。
      let rejections = 0
      // 首次被拒时的尺寸。
      let rejected: number | undefined
      // 是否已改为纯文本发送。
      let asText = shrink.text ?? false
      // 当前“原样发送”的尺寸上限。
      let fit = shrink.fit

      while (true) {
        // measured 只在第一次循环有效（之后一律字符估算）。
        const measured = rejections === 0 ? shrink.measured : undefined
        // 依次尝试：原样 → history → 文本收缩版。
        const unchanged = asText
          ? undefined
          : (measured ? total(measured) : estimateRequest(prepared.request)) <= fit
            ? prepared.request
            : estimateRequest(shrink.history) <= target
              ? shrink.history
              : undefined
        const request =
          unchanged ??
          flattenAndDropOldest(shrink.history, context, target) ??
          // 首轮失败兜底：把 history 转写为文本（不设目标上限）。
          (rejections > 0
            ? undefined
            : asText
              ? flattenAndDropOldest(shrink.history, context, Number.POSITIVE_INFINITY)
              : shrink.history)
        // 实在压不下去（会丢最新交互/检查点）→ 失败。
        if (!request) {
          return yield* Effect.fail<Failure>({
            error: {
              type: "compaction.failed",
              message:
                "The compaction request cannot be reduced further without losing the latest exchange or checkpoint",
            },
          })
        }

        const size = request === prepared.request ? measured : undefined
        // 发送（Result 风格捕获错误，不中断）。
        const attempt = yield* Effect.result(send(request, size))
        if (Result.isSuccess(attempt)) return attempt.success
        const cause = attempt.failure
        // 非 AI 错误（如钩子 Failure）→ 直接失败。
        if (!(cause instanceof AIError)) return yield* Effect.fail(cause)
        const error = toSessionError(cause)
        // payload-too-large：字节超限（多为内联媒体）。
        const tooLarge = cause.reason._tag === "InvalidRequest" && cause.reason.classification === "payload-too-large"

        // 对“原样/history”版本的字节超限 → 改为纯文本重发（不计收缩步数）。
        if (tooLarge && (request === prepared.request || request === shrink.history)) {
          asText = true
          continue
        }

        // “too long”（或文本版字节超限）→ 进入收缩循环。
        if (tooLarge || isContextOverflowFailure(cause)) {
          const step = SHRINK_STEPS[rejections]
          // 步数用尽 → 放弃。
          if (step === undefined) return yield* Effect.fail<Failure>({ error })
          rejected ??= size ? total(size) : estimateRequest(request)
          // The characters can still say the rejected request fits, so it only goes out again as text.
          // 字符估算可能仍然“装得下”，所以被拒后强制改文本。
          if (size) asText = true
          // 新目标 = 首次被拒尺寸 × 收缩比例。
          target = Math.floor(rejected * step)
          fit = target
          rejections++
          continue
        }

        // 其他 provider 错误 → 走会话重试策略（等待后重发同一请求）。
        const decision = yield* policy({
          cause,
          error,
          agent: context.agent.id,
          model: context.model.ref,
          hook: prepared.retry,
          retry: SessionRunnerRetry.isRetryable(cause),
        })
        if (!decision.retry) return yield* Effect.fail<Failure>({ error })
        yield* Effect.sleep(decision.delay)
      }
    })

    /**
     * History that has to change is sent as text rather than as edited messages: `[previous compaction][transcript]`,
     * the conversation since that compaction as one text message. A previous summary always stays in front, while
     * its verbatim recent part becomes the oldest transcript entry; a previous native window stays exactly as the
     * provider made it. The transcript has no tool definitions, which the summary does not need and which no longer
     * share a cached prefix, and leaves out reasoning, media, and instruction updates.
     *
     * When the whole transcript does not fit, exchanges are shortened oldest first, one level at a time, until it
     * does (see `flattenMessage` for the levels): every exchange reaches a level before any reaches the next, so
     * detail is lost from the oldest history first and whole exchanges are omitted only as a last resort. The newest
     * exchange is never omitted; undefined when the transcript cannot fit even so.
     */
    // flattenAndDropOldest：把要改动的历史压成一条文本消息。
    // 结构：[上一个压缩检查点][转写文本]。转写按“交换”（一次用户消息及其
    // 回复）分组，从旧到新逐级缩短（每个交换先到一级，才轮到下一个级别），
    // 最新交换绝不省略；装不下时返回 undefined。
    const flattenAndDropOldest = (request: LLMRequest, context: SessionContext.Loaded, target: number) => {
      // 上一个压缩检查点。
      const previous = previousCompaction(context.messages)
      // 原始请求里检查点（或压缩片段）结束的位置。
      const end =
        request.messages.findLastIndex(
          (message) =>
            (previous !== undefined && message.id === previous.id) ||
            message.content.some((part) => part.type === "compaction"),
        ) + 1
      // 非原生的摘要检查点保留在前面。
      const summary = previous !== undefined && !SessionHistory.isNativeCompaction(previous) ? previous : undefined
      // TODO: Read the previous summary from the hooked request once it no longer merges summary and recent into one
      // message. Until then it is rebuilt from storage, which drops a compaction hook's edits to that message.
      // lead：前置的摘要消息（recent 部分并入转写，置空）。
      const lead = summary
        ? toLLMMessages([{ ...summary, metadata: { ...summary.metadata, recent: "" } }], context.model.ref)
        : request.messages.slice(0, end)
      const recent = summary ? SessionRecentText.kept(summary) : ""

      // A user message and everything after it, up to the next one, is one exchange. Each is rendered at every level
      // once, so shortening is running arithmetic over these sizes. The previous summary's recent part is already
      // shortened text: whole until it is omitted.
      // exchanges：每个交换在每一级的渲染结果（预渲染一次，后面只是算术）。
      const exchanges = [
        // 上一摘要的 recent 文本作为最老的条目。
        ...(recent ? [TRANSCRIPT_LEVELS.map((level) => (level === OMITTED ? "" : recent))] : []),
        // 按 user 消息分组（user 之前的内容并入上一组）。
        ...request.messages
          .slice(end)
          .reduce<Message[][]>((groups, message) => {
            if (message.role === "user" || groups.length === 0) groups.push([message])
            else groups[groups.length - 1].push(message)
            return groups
          }, [])
          // 每组在每个级别渲染一遍。
          .map((group) =>
            TRANSCRIPT_LEVELS.map((level) =>
              group
                .map((message) => flattenMessage(message, level))
                .filter(Boolean)
                .join("\n"),
            ),
          )
          // 完整级别渲染为空的组直接丢弃。
          .filter((renders) => renders[0]),
      ]
      if (exchanges.length === 0) return undefined
      // “[N 条更早交互省略]”的提示文本。
      const note = (omitted: number) =>
        omitted ? `[${omitted} older ${omitted === 1 ? "exchange" : "exchanges"} omitted]\n\n` : ""
      // 一条文本的 token 估算（非空至少 +1）。
      const size = (text: string) => (text ? Token.estimate(text) + 1 : 0)
      // Room for the longest possible note is set aside before choosing what to keep.
      // room：扣除前置与提示文本后的可用空间。
      const room =
        target -
        estimateRequest({ system: request.system, tools: [], messages: lead }) -
        Token.estimate(note(exchanges.length))

      // levels：每个交换当前的缩短级别；total：当前总 token。
      const levels = exchanges.map(() => 0)
      let total = exchanges.reduce((sum, renders) => sum + size(renders[0]), 0)
      const newest = exchanges.length - 1
      // 逐级收缩：从旧到新，把交换降到下一级，直到总量装进 room。
      for (const level of TRANSCRIPT_LEVELS.slice(1)) {
        for (let index = 0; index < exchanges.length && total > room; index++) {
          // The newest exchange is what the summary most needs; it is shortened but never left out.
          // 最新交换：可以缩短，但绝不省略。
          if (index === newest && !exchanges[index][level]) continue
          total += size(exchanges[index][level]) - size(exchanges[index][levels[index]])
          levels[index] = level
        }
      }
      // 全部级别用完仍装不下 → 放弃。
      if (total > room) return undefined

      // Includes exchanges with no user text, which are already gone at `USER_ONLY`.
      // 统计被省略的交换数，拼接最终文本。
      const omitted = levels.filter((level, index) => !exchanges[index][level]).length
      const text = exchanges
        .map((renders, index) => renders[levels[index]])
        .filter(Boolean)
        .join("\n\n")
      // 返回：无工具定义、消息 = [lead..., 一条文本消息]。
      return { ...request, tools: [], messages: [...lead, Message.user(note(omitted) + text)] }
    }

    // stream：消费 LLM 流。文本增量累积（后台模式不推送）；每步 finish 记账；
    // 最终 finish 按原因分类：unknown/error → AIError；length/content-filter
    // → 不可用；正常 → 返回累计文本。
    const stream = (
      context: SessionContext.Loaded,
      request: LLMRequest,
      options: StreamOptions,
      background?: Background,
    ) => {
      const sessionID = context.session.id
      const unusable = (error: SessionError.Error) => Effect.fail<Failure>({ error })

      return llm.stream(request, options).pipe(
        // runFoldEffect：带状态折叠地消费流。
        Stream.runFoldEffect(
          (): Streamed => ({ text: "" }),
          (streamed, event): Effect.Effect<Streamed, AIError | Failure> => {
            // 文本增量：累积；前台压缩还要向 UI 推送 Delta。
            if (LLMEvent.is.textDelta(event)) {
              const next = { ...streamed, text: streamed.text + event.text }
              if (background) return Effect.succeed(next)
              return bus.publish(SessionEvent.Compaction.Delta, { sessionID, text: event.text }).pipe(Effect.as(next))
            }

            // 步内 finish：记录用量。
            if (LLMEvent.is.stepFinish(event)) {
              return spend(sessionID, SessionUsage.record(event.usage, context.model.cost), background?.usage).pipe(
                Effect.as(streamed),
              )
            }

            // 其余事件直接跳过，直到最终 finish。
            if (!LLMEvent.is.finish(event)) return Effect.succeed(streamed)
            switch (event.reason.normalized) {
              case "unknown":
                // 未知 finish：视为无效输出。
                return Effect.fail(
                  new AIError({
                    reason: new InvalidProviderOutputError({
                      message: "The provider response ended with an unknown finish reason.",
                      classification: "incomplete-stream",
                    }),
                  }),
                )
              case "error":
                // provider 报错。
                return Effect.fail(
                  new AIError({ reason: new UnknownProviderError({ message: "Compaction generation failed" }) }),
                )
              case "length":
                // 摘要写满输出上限 → 不可用。
                return unusable({
                  type: "compaction.failed",
                  message: "Compaction summary reached the output token limit",
                })
              case "content-filter":
                // 内容过滤拦截。
                return unusable(contentFilterError("Compaction summary was blocked by the provider", event.reason))
              default:
                return Effect.succeed(streamed)
            }
          },
        ),
      )
    }

    /**
     * The conversation as the runner would send it, after request hooks.
     *
     * The output limit leaves room for `budget`, the most `deliver` sends. The request prepared here can be larger
     * when the conversation overshot the threshold, and is only shrunk to fit after hooks have seen it, so sizing the
     * output to it would leave next to no room. A prompt the estimate undersells is rejected and shrunk like any
     * other.
     */
    // prepare：按“runner 会怎么发”组装请求（走钩子）。输出上限为 budget 留位。
    const prepare = (
      context: SessionContext.Loaded,
      messages: ReadonlyArray<SessionMessage.Info>,
      budget: number,
      webSocket?: "session",
    ) => {
      // 基础转写（system + 消息）。
      const base = transcript(context, messages)
      return requests.compaction({
        session: context.session,
        agent: context.agent.id,
        model: context.model,
        tools: context.tools,
        system: base.system,
        messages: base.messages,
        webSocket,
        // 声称的输入规模 = budget（estimated 置 0，让输出上限直接以 budget 计）。
        inputTokens: { measured: budget, estimated: 0 },
      })
    }

    /** A request hook supplied the summary itself, so no model call happens. */
    // fromHook：钩子自带摘要 → 记账后直接返回，不调模型。
    const fromHook = (context: SessionContext.Loaded, supplied: SessionCompactionResult, background?: Background) => {
      const usage = supplied.tokens && {
        tokens: supplied.tokens,
        cost: SessionUsage.calculateCost(context.model.cost, supplied.tokens),
      }
      return spend(context.session.id, usage, background?.usage).pipe(
        Effect.as<Result>({
          text: supplied.summary,
          native: supplied.native,
          metadata: supplied.metadata,
        }),
      )
    }

    /**
     * Each model call is billed as soon as it finishes, so failed and interrupted compactions are billed too. The
     * compaction's message shows the total across all of its calls. A session never runs two compactions at once;
     * a background summary keeps its own total until a compaction takes it.
     */
    // 记账：每次模型调用一完成就计费（失败/中断也计）。spent 按会话累计，
    // publish 时随事件广播。
    const spent = new Map<SessionContext.Loaded["session"]["id"], SessionUsage.Recorded>()
    const addSpent = (sessionID: SessionContext.Loaded["session"]["id"], usage: SessionUsage.Recorded) => {
      const total = spent.get(sessionID)
      spent.set(sessionID, total ? SessionUsage.add(total, usage) : usage)
    }
    // spend：登记用量并广播 UsageRecorded 事件；record 参数允许后台摘要重定向记账。
    const spend = (
      sessionID: SessionContext.Loaded["session"]["id"],
      usage: SessionUsage.Recorded | undefined,
      record = (recorded: SessionUsage.Recorded) => addSpent(sessionID, recorded),
    ) =>
      Effect.gen(function* () {
        if (!usage) return
        record(usage)
        yield* bus.publish(SessionEvent.UsageRecorded, { sessionID, source: "compaction", ...usage })
      })

    // publish：把成功/失败结果广播为 Compaction.Ended/Failed 事件，并返回 Outcome。
    const publish = Effect.fnUntraced(function* (
      trigger: Trigger,
      outcome: Result | Failure,
    ): Effect.fn.Return<Outcome> {
      const context = trigger.context
      const sessionID = context.session.id
      const reason = trigger.reason === "manual" ? "manual" : "auto"
      const usage = spent.get(sessionID)

      // 失败：广播 Compaction.Failed（带上 inputID 供 /compact 消息回写）。
      if ("error" in outcome) {
        yield* bus.publish(SessionEvent.Compaction.Failed, {
          sessionID,
          reason,
          inputID: trigger.reason === "manual" ? trigger.inputID : undefined,
          error: outcome.error,
          ...usage,
        })
        return { status: "failed", error: outcome.error }
      }

      // 成功：广播 Compaction.Ended（含摘要文本、模型、用量、metadata）。
      yield* bus.publish(
        SessionEvent.Compaction.Ended,
        {
          sessionID,
          reason,
          model: context.model.ref,
          native: outcome.native,
          text: outcome.text,
          ...usage,
        },
        { metadata: outcome.metadata },
      )
      return { status: "completed" }
    })

    // 服务实现：compact 外面包两件收尾事——
    // onInterrupt：非手动压缩被中断时广播 interrupted 失败；
    // ensuring：无论成败清掉本会话的累计记账。
    return Service.of({
      transform: state.transform,
      reload: state.reload,
      // A manual compaction settles through its `/compact` inbox item, which the runner owns.
      compact: (trigger) =>
        compact(trigger).pipe(
          Effect.onInterrupt(() =>
            trigger.reason === "manual"
              ? Effect.void
              : publish(trigger, { error: { type: "compaction.interrupted", message: "Compaction was interrupted" } }),
          ),
          Effect.ensuring(Effect.sync(() => spent.delete(trigger.context.session.id))),
        ),
      precompute,
    })
  }),
)

// node：依赖装配（Agent/Bus/DB/LLM/Model/请求/模型解析）。
export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Agent.node, Bus.node, Database.node, llmClient, Model.node, SessionModelRequest.node, SessionRunnerModel.node],
})

/**
 * Where the messages kept beside a held summary start, or -1 when the summary no longer describes this
 * conversation: a compaction or revert since replaced its start, or the model or instructions changed.
 */
// heldIndex：存票是否仍描述当前会话。首条消息、指令、模型、variant 任一
// 变化都判失效（-1）；否则返回 keepID 在当前消息里的下标。
const heldIndex = (held: Precomputed, context: SessionContext.Loaded) => {
  if (held.firstID !== context.messages[0]?.id || held.initial !== Instructions.join(context.initial)) return -1
  if (held.model.providerID !== context.model.ref.providerID || held.model.id !== context.model.ref.id) return -1
  if (held.model.variant !== context.model.ref.variant) return -1
  return context.messages.findIndex((message) => message.id === held.keepID)
}

/** Estimated text a swapped-in summary keeps verbatim: every message from `index` on. */
// tailTokens：换入时保留尾部的 token 估算（index 起的所有消息文本）。
const tailTokens = (context: SessionContext.Loaded, index: number) =>
  Token.estimate(context.messages.slice(index).map(SessionRecentText.messageToText).filter(Boolean).join("\n\n"))

// tailLimit：预算的 40%。
const tailLimit = (budget: number) => Math.floor(budget * PRECOMPUTED_TAIL_SHARE)

// promptTokens：一次响应的实测 prompt = 输入 + 缓存读 + 缓存写。
const promptTokens = (tokens: { input: number; cache: { read: number; write: number } }) =>
  tokens.input + tokens.cache.read + tokens.cache.write

// 时长单位表（ms）。
const DURATION_UNITS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }

/** Milliseconds a prompt cache entry lives, from a `cache.ttl` such as "5m" or "1h". */
// cacheLifetime：解析 "5m"/"1h" 之类的 TTL；没有就用默认 5 分钟。
const cacheLifetime = (ttl: string | undefined) => {
  const match = ttl?.match(/^(\d+)(ms|s|m|h|d)$/)
  return match ? Number(match[1]) * DURATION_UNITS[match[2] as keyof typeof DURATION_UNITS] : CACHE_LIFETIME
}

/** History loads from the latest completed compaction, so a previous one is always the first message. */
// previousCompaction：上一个完成的压缩检查点（历史从它开始加载，所以总是第一条）。
const previousCompaction = (messages: ReadonlyArray<SessionMessage.Info>) => {
  const [first] = messages
  return first?.type === "compaction" && first.status === "completed" ? first : undefined
}

// transcript：压缩请求的基础转写（复用 runner 的组装逻辑）。
const transcript = (context: SessionContext.Loaded, messages: ReadonlyArray<SessionMessage.Info>) =>
  SessionModelRequest.baseTranscript({
    agent: context.agent.info,
    model: context.model,
    tools: context.tools,
    initial: context.initial,
    messages,
  })

/**
 * The newest messages within `keep` tokens, from `keepID` on, are kept verbatim beside the summary.
 * Undefined when there is nothing to compact.
 */
// splitConversation：从哪些消息开始逐字保留。返回 keepID（起点消息 ID）。
const splitConversation = (messages: ReadonlyArray<SessionMessage.Info>, keep: number) => {
  // 把每条消息转成文本（空的跳过）。
  const entries = messages.flatMap((message) => {
    const text = SessionRecentText.messageToText(message)
    return text ? [{ message, text }] : []
  })
  if (entries.length === 0) return undefined

  // 保留起点：在 keep 预算内尽量从后往前保留。
  const first = entries[recentStart(entries, keep, previousCompaction(messages))]
  return {
    keepID: first?.message.id,
  }
}

/** The request without the retained tail, which starts at the message with ID `from`. */
// withoutTail：从请求里去掉保留尾部（keepID 起的消息）。
const withoutTail = (request: LLMRequest, from: SessionMessage.ID | undefined) => {
  const index = from === undefined ? -1 : request.messages.findIndex((message) => message.id === from)
  if (index < 0) return request
  return { ...request, messages: request.messages.slice(0, index) }
}

// recentStart：决定保留区的起点下标。
const recentStart = (
  entries: ReadonlyArray<{ readonly message: SessionMessage.Info; readonly text: string }>,
  keep: number,
  previous: SessionMessage.CompactionCompleted | undefined,
) => {
  // Drop the oldest entries until the rest fit the allowance, but always keep the newest one.
  // 从最旧开始丢，直到剩余部分装进 keep 预算（永远保留最新一条）。
  const dropped = Math.min(
    oldestToDrop(entries, (entry) => Token.estimate(entry.text), keep),
    entries.length - 1,
  )

  // Start at a user message so an assistant's tool calls and results stay together.
  // 起点回退到最近的 user 消息，保证工具调用与结果不拆散。
  const userBoundary = entries.findLastIndex((entry, index) => index <= dropped && entry.message.type === "user")
  if (userBoundary > 0) return userBoundary

  // Everything fits. Keep only the latest exchange rather than duplicating the whole conversation beside the summary.
  // 全都装得下：只保留最近一个交换，避免摘要旁重复整段对话。
  const latestUser = entries.findLastIndex((entry) => entry.message.type === "user")
  if (latestUser > 0) return latestUser

  // One exchange, nothing older. Summarize it all and keep nothing, unless a previous summary already
  // kept recent text, in which case keep everything and summarize only the summary before it.
  // 只有一个交换：若上一份摘要已带 recent 文本，则全保留、只摘要它之前的部分。
  return previous && SessionRecentText.kept(previous) ? 0 : entries.length
}

// oldestToDrop：贪心计算“从头可以丢掉多少条而不超预算”。
const oldestToDrop = <T>(items: ReadonlyArray<T>, size: (item: T) => number, budget: number) => {
  let total = 0
  let start = items.length
  while (start > 0) {
    const next = total + size(items[start - 1])
    if (next > budget) break
    total = next
    start--
  }
  return start
}

/** One request message as transcript lines at a shortening level. Empty for what that level leaves out. */
// flattenMessage：把一条请求消息按缩短级别渲染成转写行。
const flattenMessage = (message: Message, level: number) => {
  // system 消息与“省略”级别直接空。
  if (message.role === "system" || level === OMITTED) return ""
  // USER_ONLY 及以上：非 user 消息全部省略。
  if (level >= USER_ONLY && message.role !== "user") return ""
  return message.content
    .flatMap((part) => {
      // 文本：USER_ONLY 以上裁剪。
      if (part.type === "text") {
        if (!part.text) return []
        const text = level >= USER_ONLY ? clip(part.text) : part.text
        return [`[${message.role === "user" ? "User" : "Assistant"}]: ${text}`]
      }
      if (level >= USER_ONLY) return []
      // 媒体：只留占位符。
      if (part.type === "media") return [`[${part.media.mediaType} omitted]`]
      // 工具调用：OUTPUTS_REMOVED 以上裁剪输入。
      if (part.type === "tool-call") {
        const input = JSON.stringify(part.input) ?? ""
        return [`[Assistant tool call]: ${part.name}(${level >= OUTPUTS_REMOVED ? clip(input) : input})`]
      }
      if (part.type !== "tool-result") return []
      // 工具结果：分级处理（占位/裁剪/全文）。
      const result = part.result
      const label = result.type === "error" ? "Tool error" : "Tool result"
      if (level >= OUTPUTS_REMOVED) return [`[${label} omitted]`]
      const output =
        result.type === "content"
          ? SessionRecentText.serializeToolContent(result.value)
          : typeof result.value === "string"
            ? result.value
            : (JSON.stringify(result.value) ?? "")
      return [`[${label}]: ${level >= OUTPUTS_CLIPPED ? clip(output) : output}`]
    })
    .join("\n")
}

/** `value` cut to `TRANSCRIPT_CLIP` characters from its start and end, never splitting a surrogate pair. */
// clip：首尾各保留 TRANSCRIPT_CLIP/2 个码点，中间省略号提示；不劈开代理对。
const clip = (value: string) => {
  if (value.length <= TRANSCRIPT_CLIP) return value
  const chars = Array.from(value)
  if (chars.length <= TRANSCRIPT_CLIP) return value
  const half = TRANSCRIPT_CLIP / 2
  const omitted = chars.length - TRANSCRIPT_CLIP
  return `${chars.slice(0, half).join("")}\n[… ${omitted} characters omitted …]\n${chars.slice(-half).join("")}`
}

/** The newest whole, real user messages within `keep` tokens: no synthetic guidance, no half of an attachment. */
// recentUserMessages：原生压缩 trigger 机制要附带的用户消息——keep 预算内
// 最新的“真实”用户消息（剔除合成指导、裁掉不支持的附件）。
export const recentUserMessages = (
  messages: ReadonlyArray<SessionMessage.Info>,
  model: Pick<SessionContext.Loaded["model"], "ref" | "capabilities">,
  keep: number,
) => {
  const users = messages
    .filter((message) => message.type === "user")
    .map((message) => ({ ...message, skills: undefined }))
  // 先剔除模型不支持的部分，再按图片预算约束。
  const sendable = SessionModelRequest.boundImages(
    SessionModelRequest.unsupportedParts(toLLMMessages(users, model.ref), model.capabilities),
  )
  return sendable.slice(oldestToDrop(sendable, estimateMessage, keep))
}

// total：实测 + 估算。
const total = (estimate: Estimate) => estimate.measured + estimate.estimated

// estimateContext：整个上下文的估算总量。
export const estimateContext = (context: SessionContext.Loaded) => total(estimatePrompt(context))

/** The size of the prompt `context` sends. */
// estimatePrompt：估算当前会话会发出的 prompt 大小。
// 思路：找最近一条带实测 token 的“锚点”消息，实测值只覆盖到锚点为止；
// 锚点之后（含本地工具结果）的部分逐条估算。
export const estimatePrompt = (context: SessionContext.Loaded): Estimate => {
  const anchorIndex = context.messages.findLastIndex((message) => hasMeasuredPrompt(message, context.model.ref))
  const anchor = context.messages[anchorIndex]
  const base = transcript(context, context.messages.slice(Math.max(0, anchorIndex)))
  // TODO: Pass compaction history the runner has already shaped. This and `recentUserMessages` repeat the
  // runner's unsupported-media and image-budget passes; here the image budget only sees images since the anchor,
  // so image-heavy sessions can estimate high.
  // 先做“不支持的部分剔除 + 图片预算”两道处理（与真实请求一致）。
  const sent = SessionModelRequest.boundImages(
    SessionModelRequest.unsupportedParts(base.messages, context.model.capabilities),
  )
  // The anchor's usage covers its own output, but not its local tool results, which the provider never saw.
  // 排除锚点本身（其 token 已实测），其余未测消息逐条估算。
  const unmeasured = sent.filter((message) => message.role !== "assistant" || message.id !== anchor?.id)

  // 没有锚点：全量字符估算。
  if (anchor?.type !== "assistant" || !anchor.tokens)
    return {
      measured: 0,
      estimated: estimateRequest({ system: base.system, tools: context.tools.definitions, messages: unmeasured }),
    }

  // 有锚点：实测 = 该响应的全部 token（输入+缓存+输出+推理）。
  const tokens = anchor.tokens
  return {
    measured: tokens.input + tokens.cache.read + tokens.cache.write + tokens.output + tokens.reasoning,
    estimated: unmeasured.reduce((sum, message) => sum + estimateMessage(message), 0),
  }
}

/**
 * The largest request the model takes while leaving room for its reply: `RESERVE_SHARE` of the window, or
 * `RESERVE_MIN` when that is more. A summary request that must be shrunk is aimed at the same size. A window too small
 * to give up `RESERVE_MIN` keeps `RESERVE_SHARE`.
 */
// calculateCeiling：请求上限 = 窗口 − max(15%, 窗口≥2×16k 时的 16k)。
const calculateCeiling = (limit: SessionContext.Loaded["model"]["limit"], buffer: Settings["buffer"]) => {
  // With no window at all, only a provider rejection can limit the request.
  // 窗口未知：只能靠 provider 拒绝来限制。
  const window = inputWindow(limit)
  if (window <= 0) return Number.POSITIVE_INFINITY
  // 显式 buffer 支持百分比或绝对值。
  const tokens = typeof buffer === "string" ? Math.round((window * Number.parseFloat(buffer)) / 100) : buffer
  // A buffer that leaves no room, such as one set for a larger model, is ignored.
  // 不留空间的 buffer（比如为大窗口模型配的）直接忽略。
  if (tokens !== undefined && tokens < window) return window - tokens
  return window - Math.max(Math.floor(window * RESERVE_SHARE), window >= 2 * RESERVE_MIN ? RESERVE_MIN : 0)
}

/**
 * The largest summary request that leaves `RESERVE_MIN` of the window for the summary, or less when the request
 * cannot generate that much. Zero for an unknown window.
 */
// summaryRoom：摘要请求可用的最大空间。
const summaryRoom = (limit: SessionContext.Loaded["model"]["limit"], output = RESERVE_MIN) =>
  Math.max(0, inputWindow(limit) - Math.min(RESERVE_MIN, output))

/**
 * The largest prompt the model takes, or 0 when unknown. Unknown limits are reported as 0, and an unknown input limit
 * falls back to the context window. The context window also holds the reply, so an input limit above it, as some
 * catalogs and config overrides report, cannot be used in full.
 */
// inputWindow：输入窗口 = min(输入上限, 上下文窗口)。
const inputWindow = (limit: SessionContext.Loaded["model"]["limit"]) =>
  limit.input && limit.context ? Math.min(limit.input, limit.context) : limit.input || limit.context

/**
 * Another provider's count may describe a native window this model cannot replay. History then holds the original
 * messages that window stood for, which the count leaves out, so only the current provider's counts are trusted.
 */
// hasMeasuredPrompt：该消息是否是“当前 provider 的可信实测锚点”。
// 只信当前 provider 的计数（别的 provider 的计数可能对应无法重放的原生窗口）。
const hasMeasuredPrompt = (message: SessionMessage.Info, model: SessionContext.Loaded["model"]["ref"]) =>
  message.type === "assistant" &&
  message.model.providerID === model.providerID &&
  !message.error &&
  message.tokens !== undefined &&
  promptTokens(message.tokens) > 0

/** The prompt size, only while the model, variant and agent that were measured still match; they shape the request. */
// measuredPrompt：最近一次实测值——但仅当模型/variant/agent 都没变时才可用
// （它们决定了请求的形状）。
const measuredPrompt = (context: SessionContext.Loaded) => {
  const anchor = context.messages.findLast((message) => hasMeasuredPrompt(message, context.model.ref))
  if (
    anchor?.type !== "assistant" ||
    anchor.model.id !== context.model.ref.id ||
    anchor.model.variant !== context.model.ref.variant ||
    anchor.agent !== context.agent.id
  )
    return undefined
  return estimatePrompt(context)
}

/**
 * `prepare` sizes the output limit for a request of `budget` tokens, but `deliver` can send a larger one when it
 * cannot shrink the conversation further. Lower the limit to the room the request being sent leaves in the window,
 * so the input and the requested output never exceed the window by our own estimate.
 *
 * The limit leaves the same margin for a low estimate that primary requests do. `deliver` aims at about 90% of the
 * window, so that margin alone would cut a summary near its target to the minimum; there it still gets up to
 * `SUMMARY_OUTPUT_FLOOR` of the room left without the margin.
 */
// fitOutput：把 maxTokens 压到“窗口装得下输入+输出”的范围内；
// 保底：快到目标时仍给摘要最多 32k 的输出空间。
const fitOutput = (request: LLMRequest, limit: SessionContext.Loaded["model"]["limit"], size?: Estimate) => {
  const current = request.maxTokens
  if (current === undefined) return request
  const input = size ?? { measured: 0, estimated: estimateRequest(request) }
  const maxTokens = Math.min(
    current,
    Math.max(
      SessionModelRequest.outputLimit(limit, input),
      Math.min(SUMMARY_OUTPUT_FLOOR, SessionModelRequest.outputLimit(limit, { measured: total(input), estimated: 0 })),
    ),
  )
  if (maxTokens === current) return request
  return { ...request, maxTokens }
}

// estimateRequest：请求总量 = system + 工具定义 + 消息，逐段估算。
const estimateRequest = (request: Pick<LLMRequest, "system" | "tools" | "messages">) =>
  request.system.reduce((sum, part) => sum + Token.estimate(part.text), 0) +
  request.tools.reduce((sum, tool) => sum + estimateTool(tool), 0) +
  request.messages.reduce((sum, message) => sum + estimateMessage(message), 0)

/** Only what providers receive; `metadata` and `native` stay local. */
// estimateTool：工具定义估算（嵌套的命名空间工具递归）。
const estimateTool = (tool: ToolEntry): number => {
  if (tool.type === "tool") return Token.estimate(tool.name + tool.description + JSON.stringify(tool.inputSchema))
  return (
    Token.estimate(tool.name + (tool.description ?? "")) +
    tool.tools.reduce((sum, entry) => sum + estimateTool(entry), 0)
  )
}

// estimateMessage：一条消息 = 各部分之和。
const estimateMessage = (message: Message) => message.content.reduce((sum, part) => sum + estimatePart(part), 0)

// estimatePart：单个内容块的估算规则。
const estimatePart = (part: ContentPart): number => {
  // An encrypted native compaction has no locally measurable size.
  // 加密的原生压缩块：本地无法测量，按其文本占位估算。
  if (part.type === "compaction") return Token.estimate(part.text ?? "")
  // effort（推理力度）不占空间。
  if (part.type === "effort") return 0
  if (part.type === "text" || part.type === "reasoning") return Token.estimate(part.text)
  // 媒体按固定常数估。
  if (part.type === "media") return estimateMedia(part.media.mediaType)
  if (part.type === "tool-call") return Token.estimate(part.name + (JSON.stringify(part.input) ?? ""))

  // 工具结果：content 数组逐块估，字符串/对象 JSON 估。
  if (part.result.type === "content")
    return part.result.value.reduce(
      (sum, content) => sum + (content.type === "text" ? Token.estimate(content.text) : estimateMedia(content.mime)),
      0,
    )
  const value = part.result.value
  return Token.estimate(typeof value === "string" ? value : (JSON.stringify(value) ?? ""))
}

// estimateMedia：图片 1500、PDF 2000、其他 0。
const estimateMedia = (mime: string) => {
  const type = mime.toLowerCase()
  if (type.startsWith("image/")) return IMAGE_TOKEN_ESTIMATE
  if (type === "application/pdf") return PDF_TOKEN_ESTIMATE
  return 0
}
