// =====================================================================
// 文件角色：SessionRunnerLLM —— agent 主循环的真正实现。
// drain() 负责“把收件箱里的待办输入排空”：选上下文 → 晋升输入 → 跑一步
// LLM（runStep → SessionStep.attempt）→ 处理工具调用 → 必要时压缩上下文
// → 循环直到空闲。所有状态都持久化在数据库里，进程重启后可续跑。
// Effect 风格：整段逻辑是一棵可中断、可重试、可追踪的 Effect 树。
// =====================================================================
export * as SessionRunnerLLM from "./llm.js"

// Message：与 provider 无关的消息构造器（Message.user/assistant 等）。
import { Message } from "@opencode/ai/effect"
// drizzle-orm：SQL 查询构建器，用于直接查消息表。
import { and, desc, eq, inArray, sql } from "drizzle-orm"
// Cause（错误原因树）、Exit（Effect 的运行结果）、FiberMap（按 key 去重的
// fiber 表）、Layer（依赖注入层）均来自 effect 核心库。
import { Cause, Effect, Exit, FiberMap, Layer } from "effect"
// SQLite 数据库。
import { Database } from "../../database/database.js"
// 进程内事件总线（发布/订阅）。
import { Bus } from "../../bus.js"
// Location（工作目录实例）生命周期。
import { LocationLifecycle } from "../../location-lifecycle.js"
// AGENTS.md 等指令的就绪状态。
import { InstructionState } from "../instruction-state.js"
// 上下文压缩（compaction）服务。
import { SessionCompaction } from "../compaction.js"
// 会话上下文（agent/model/tools 的选定与加载）。
import { SessionContext } from "../context.js"
// 会话事件定义（用于 Bus 发布）。
import { SessionEvent } from "../event.js"
// 会话收件箱：排队中的用户输入/控制项。
import { SessionInbox } from "../inbox.js"
// 后台任务统计（后台 shell 等）。
import { SessionBackground } from "../background.js"
// 作业系统（后台命令、通知）。
import { Job } from "../../job.js"
// 会话历史的读取/解码。
import { SessionHistory } from "../history.js"
// 组装发往模型的请求。
import { SessionModelRequest } from "../model-request.js"
// 模型传输层的开/关。
import { SessionModelTransport } from "../model-transport.js"
// 消息模型与 ID 生成。
import { SessionMessage } from "../message.js"
// 会话基础 Schema。
import { SessionSchema } from "../schema.js"
// 会话存储服务。
import { SessionStore } from "../store.js"
// drizzle 消息表定义。
import { SessionMessageTable } from "../sql.js"
// 会话标题自动生成。
import { SessionTitle } from "../title.js"
// 各种错误 → 会话错误。
import { toSessionError } from "../to-session-error.js"
// 本服务的接口与类型。
import { DrainResult, Service, type Interface } from "./index.js"
// 文件快照（记录一步改动了哪些文件）。
import { Snapshot } from "../../snapshot.js"
// 把 Layer 包装成可组合的 Node。
import { makeLocationNode } from "@opencode/util/effect/app-node"
// LLM 客户端节点。
import { llmClient } from "../../effect/app-node-platform.js"
// 步骤失败错误。
import { StepFailedError } from "../error.js"
// 重试策略（退避/轮换 key）。
import { SessionRunnerRetry } from "./retry.js"
// 单步执行（流式请求+工具 fiber）。
import { SessionStep } from "./step.js"
// 工具输出截断/落盘。
import { ToolOutput } from "../../tool-output.js"
// 插件系统。
import { Plugin } from "../../plugin.js"
// 插件钩子触发器。
import { PluginHooks } from "../../plugin/hooks.js"
// 达到步数上限时注入的提示词。
import { MAX_STEPS_PROMPT } from "./max-steps.js"

// 流被中断后追加的合成用户消息：让模型“从断点继续、不要重复已输出内容”。
const CONTINUE_AFTER_INCOMPLETE_STREAM =
  "The previous response was interrupted. Continue from where you left off without repeating completed content."

// 命中输出 token 上限（finish=length）后追加的合成消息：指示拆小步骤，而非道歉复述。
const CONTINUE_AFTER_OUTPUT_LIMIT =
  "Your last response hit the output token limit (stop reason: length). Do not apologize, recap, or repeat yourself. Break the remaining work into smaller pieces."

// 类型工具：从 Interface["drain"] 的参数里抽出输入类型，避免重复声明。
type DrainInput = Parameters<Interface["drain"]>[0]

// Layer.effect：把“构造服务实例”的过程本身建成一个 Effect 描述。
// 生成器里逐个 yield* 依赖（Effect 的依赖注入写法），最后返回服务实现。
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 事件总线。
    const bus = yield* Bus.Service
    // Location 生命周期。
    const lifecycle = yield* LocationLifecycle.Service
    // 会话存储。
    const store = yield* SessionStore.Service
    // 上下文选择/加载。
    const context = yield* SessionContext.Service
    // 模型传输。
    const modelTransport = yield* SessionModelTransport.Service
    // drizzle 数据库句柄。
    const db = (yield* Database.Service).db
    // 压缩服务。
    const compaction = yield* SessionCompaction.Service
    // 插件。
    const plugins = yield* Plugin.Service
    // 插件钩子。
    const hooks = yield* PluginHooks.Service
    // 作业系统。
    const jobs = yield* Job.Service
    // 标题生成。
    const title = yield* SessionTitle.Service
    // 单步执行器。
    const steps = yield* SessionStep.make
    // Title generation starts once input is visible and must not delay model execution.
    // 标题生成从“输入可见”就开始，且绝不能阻塞模型执行：用 FiberMap 按
    // sessionID 去重地后台并发（同一会话最多一个标题生成 fiber）。
    const titles = yield* FiberMap.make<SessionSchema.ID, void, never>()

    // Each drain is one turn and starts its own trace, whatever fiber woke it.
    // drain = 一轮对话的主循环。Effect.fn("名字", {root:true}) 会开启一个
    // 根追踪 span（无论哪个 fiber 唤醒它，都从这里起新链路）。
    const drain = Effect.fn("SessionRunner.drain", { root: true })(function* (input: DrainInput) {
      const sessionID = input.sessionID
      // force：跳过“有无可晋升输入”的检查，直接跑一步。
      let force = input.force
      // 是否为崩溃后的续跑。
      let continuing = input.continuation !== undefined
      // 当前步号（从 1 计）。
      let step = input.continuation?.step ?? 1
      // 是否刚进入（首轮把队列里的下一轮输入也放行）。
      let entering = true
      // 本轮 drain 是否已跑过至少一步。
      let stepped = input.stepped ?? false
      // 晋升模式（input/steer）。
      const promotable = input.promotable ?? "input"
      // 非强制、非续跑、未跑过步骤时，先看收件箱里有没有可晋升的输入。
      if (!force && !continuing && !stepped) {
        const pending = yield* SessionInbox.nextPromotable(db, sessionID, "input")
        // 没有输入 → 直接空闲结束。
        if (!pending) return DrainResult.Complete()
        // 控制类消息（手动压缩/move）。
        const control = pending.type === "compaction" || pending.type === "move"
        // steer 模式下不处理排队（queue）投递的普通输入，只处理控制项。
        if (promotable === "steer" && pending.delivery === "queue" && !control) return DrainResult.Complete()
      }
      // 等插件装载完（agent/tool 定义可能来自插件）。
      yield* plugins.awaitActivation
      // 把进程崩溃遗留的 running 压缩标记为失败。
      yield* settleStaleCompactions(sessionID)
      // 把崩溃时还在 running/streaming 的工具标记为中断。
      yield* settleStaleToolCalls(sessionID)

      // advanceToStep：推进到“下一步就绪”。内部是个 while 大循环，处理
      // 控制项（手动压缩/move）、空闲钩子、上下文准备，直到返回 Ready。
      const advanceToStep = Effect.fn("SessionRunner.advanceToStep")(() =>
        // uninterruptibleMask：屏蔽中断，但通过 restore() 重新开放可中断窗口。
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            while (true) {
              // Location 已关闭：关掉模型传输，把现场打包成 Reloaded 交给上层。
              if (lifecycle.isClosed()) {
                yield* restore(modelTransport.close(sessionID))
                return DrainResult.Reloaded({
                  force,
                  continuation: continuing ? { step } : undefined,
                  stepped: !continuing && stepped ? true : undefined,
                })
              }
              // Location entry and idle boundaries allow queued controls, not necessarily queued prompts.
              // serialized：把“看收件箱”串行化，避免并发 drain 竞争。
              const pending = yield* SessionInbox.serialized(
                sessionID,
                Effect.gen(function* () {
                  // entering（刚进入）或非续跑时用 "input" 模式（可拉新输入），否则只 "steer"。
                  const next = yield* SessionInbox.nextPromotable(
                    db,
                    sessionID,
                    entering || !continuing ? "input" : "steer",
                  )
                  // 拿到手动压缩请求：广播收件箱投递 + 压缩开始事件（UI 显示进度）。
                  if (next?.type === "compaction")
                    yield* bus.publishAll([
                      [SessionEvent.InboxDelivered, { sessionID, inboxID: next.id }],
                      [SessionEvent.Compaction.Started, { sessionID, reason: "manual", inputID: next.id }],
                    ])
                  // 拿到 move 请求：先关模型传输，再广播 InboxDelivered 与 Moved 事件。
                  if (next?.type === "move")
                    yield* restore(
                      Effect.gen(function* () {
                        yield* modelTransport.close(sessionID)
                        yield* bus.publishAll([
                          [SessionEvent.InboxDelivered, { sessionID, inboxID: next.id }],
                          [SessionEvent.Moved, { sessionID, ...next.payload }],
                        ])
                      }),
                    )
                  return next
                }),
              )
              // 有新输入要处理（非 steer 投递）时，重置回第 1 步、重新进入。
              if (!continuing && pending?.delivery !== "steer") {
                entering = true
                step = 1
              }
              // move：返回 Moved，让上层在新 Location 里用 continuation 续跑。
              if (pending?.type === "move")
                return DrainResult.Moved({
                  continuation: continuing ? { step } : undefined,
                  stepped: !continuing && stepped ? true : undefined,
                })
              // 手动压缩：跑 compaction.compact（reason=manual）。
              if (pending?.type === "compaction") {
                const compacted = yield* restore(
                  Effect.gen(function* () {
                    yield* plugins.awaitActivation
                    // 选定 agent/model/tools。
                    const selected = yield* context.select(sessionID)
                    const model = yield* context.resolveModel(selected.session)
                    // Preview updates without admitting them after the already-delivered compaction marker.
                    // preview 只读地取当前历史（不晋升新输入），供压缩请求使用。
                    const history = yield* SessionHistory.preview(db, sessionID, selected.instructions, model.ref)
                    return yield* compaction.compact({
                      reason: "manual",
                      inputID: pending.id,
                      context: {
                        session: selected.session,
                        agent: selected.agent,
                        tools: selected.tools,
                        model,
                        initial: history.initial,
                        messages: history.messages,
                      },
                    })
                  }).pipe(
                    // 压缩过程抛错：广播 Compaction.Failed（UI 提示失败）。
                    Effect.catch((error) =>
                      bus.publish(SessionEvent.Compaction.Failed, {
                        sessionID,
                        reason: "manual",
                        inputID: pending.id,
                        error: toSessionError(error),
                      }),
                    ),
                  ),
                ).pipe(Effect.exit)
                // 压缩整体失败（含被中断）：区分“用户取消”与真实错误再广播。
                if (Exit.isFailure(compacted)) {
                  yield* bus.publish(SessionEvent.Compaction.Failed, {
                    sessionID,
                    reason: "manual",
                    error: Cause.hasInterruptsOnly(compacted.cause)
                      ? { type: "aborted", message: "Compaction cancelled" }
                      : { type: "compaction.failed", message: Cause.pretty(compacted.cause) },
                    inputID: pending.id,
                  })
                  // 仍然向上传播失败。
                  return yield* Effect.failCause(compacted.cause)
                }
                // 压缩完成，回到循环开头继续找输入。
                force = false
                continue
              }
              // 没有 force/续跑，且没有可处理的 pending（或 steer 不吃排队输入）：
              if (!force && !continuing && (!pending || (pending.delivery === "queue" && promotable === "steer"))) {
                // Control-only drains such as a manual compaction never ran the model, so they skip the hook.
                // 本次 drain 只做过控制（或从未跑过步骤）→ 直接空闲结束，不触发 idle 钩子。
                if (pending || !stepped) return DrainResult.Complete()
                // The Session would go idle; a plugin may admit input to keep this execution working.
                // 会话即将空闲：先触发 experimental.idle 钩子（附带后台任务摘要），
                // 插件可以借此继续喂输入（例如等待后台命令完成再继续）。
                yield* restore(
                  SessionBackground.outstanding(jobs, store, sessionID).pipe(
                    Effect.flatMap((background) => hooks.trigger("session", "experimental.idle", { sessionID, background })),
                  ),
                )
                // 钩子后如果收件箱又有了输入 → 继续循环处理。
                if (!(yield* SessionInbox.has(db, sessionID, "input"))) return DrainResult.Complete()
                continue
              }
              // 走到这里说明确实要跑模型：准备上下文并晋升收件箱输入。
              const ready = yield* restore(
                Effect.gen(function* () {
                  const selected = yield* prepareContext(sessionID)
                  // promote：把收件箱输入真正写进会话历史，返回晋升的数量。
                  const promoted = yield* SessionInbox.promote(
                    db,
                    bus,
                    sessionID,
                    entering && !continuing ? promotable : "steer",
                  )
                  // A control admitted during context preparation owns this boundary.
                  // 准备上下文期间进来了控制项（压缩/move）→ 本边界让位，返回 undefined 重来。
                  if (promoted === undefined) return undefined
                  // 首次有真实输入且会话还没标题 → 后台生成标题（不阻塞主流程）。
                  if (promoted > 0 && !selected.session.parentID && SessionTitle.isUntitled(selected.session))
                    yield* FiberMap.run(titles, sessionID, title.generate(sessionID), {
                      onlyIfMissing: true,
                    })
                  // 新输入到来，步号重置。
                  if (promoted > 0) step = 1
                  return { _tag: "Ready" as const, context: yield* context.load(selected) }
                }),
              )
              // Ready → 回到 drain 的外层去 runStep。
              if (ready) return ready
            }
          }),
        ),
      )

      // 外层主循环：拿到 Ready 就跑一步；Moved/Reloaded/Complete 则结束。
      while (true) {
        const next = yield* advanceToStep()
        if (next._tag !== "Ready") return next
        // runStep 返回“是否需要继续”（例如还有未完成的工具调用需要下一轮喂回）。
        continuing = yield* runStep(next.context, step)
        stepped = true
        // 步号 +1。
        step++
        // 之后的循环走正常检查。
        force = false
        // 不再是“刚进入”。
        entering = false
      }
    })

    // prepareContext：每一步/每次重试前都重新选上下文。
    const prepareContext = Effect.fn("SessionRunner.prepareContext")(function* (sessionID: SessionSchema.ID) {
      // Plugins can reload mid-turn; each step and retry must read the settled agents, models and skills.
      // 插件可能在回合中途重载，因此每步都等待激活完成再读 agent/model/skill。
      yield* plugins.awaitActivation
      const selected = yield* context.select(sessionID)
      // A blocked initial instruction baseline must leave admitted input pending.
      // 指令（AGENTS.md 等）若被阻塞，会保持已准入输入处于待处理状态。
      yield* InstructionState.prepare(db, bus, selected.instructions, sessionID)
      return selected
    })

    /** Owns logical Step policy; each attempt owns its streaming, tools, and durable settlement. */
    // runStep：跑一个“逻辑步骤”（一次模型请求及其工具执行），内部自带
    // 重试/续流/溢出恢复循环；每次 attempt（见 step.ts）负责流、工具与落库。
    const runStep = Effect.fn("SessionRunner.runStep")(function* (first: SessionContext.Loaded, step: number) {
      const sessionID = first.session.id
      // 本逻辑步骤的助手消息 ID；重试/续流共用同一条，换内容时才换 ID。
      let assistantMessageID = SessionMessage.ID.create()
      // 重试决策器。
      const retry = yield* SessionRunnerRetry.make(bus, sessionID)
      // 首次的已加载上下文（只复用一次）。
      let initial: SessionContext.Loaded | undefined = first
      // 是否允许“上下文溢出→压缩重试”。
      let recoverOverflow = true
      // 是否允许“传输层整体重试（读前重试）”。
      let recoverContinuation = true
      while (true) {
        // Reuse boundary preparation once; retries refresh context without delivering more input.
        // 首轮复用外部传进来的 prepared 上下文；重试时重新准备（但不晋升新输入）。
        const loaded = initial ?? (yield* prepareContext(sessionID).pipe(Effect.flatMap(context.load)))
        initial = undefined
        // 估算当前 prompt 大小（实测锚点 + 之后未测文本）。
        const estimate = SessionCompaction.estimatePrompt(loaded)
        // 自动压缩检查：该压就压（reason=auto）。
        const compacted = yield* compaction.compact({ reason: "auto", context: loaded, estimate })
        if (compacted.status === "failed") return yield* new StepFailedError({ error: compacted.error })
        if (compacted.status === "completed") {
          // 压缩完成后历史已变，重新加载上下文并换一条新的助手消息再试。
          assistantMessageID = SessionMessage.ID.create()
          continue
        }
        // 后台预压缩：接近阈值时提前把摘要算好（见 compaction.ts 的 precompute）。
        yield* compaction.precompute(Effect.succeed(loaded), estimate)
        // agent 配置了 steps 上限且本步达到上限 → 本步禁用工具并注入提示词。
        const stepLimitReached = loaded.agent.info.steps !== undefined && step >= loaded.agent.info.steps
        // baseTranscript：组装 system 提示与消息列表（含指令、工具定义等）。
        const transcript = SessionModelRequest.baseTranscript({
          agent: loaded.agent.info,
          model: loaded.model,
          tools: loaded.tools,
          initial: loaded.initial,
          messages: loaded.messages,
        })
        // context.request.primary：走请求钩子（插件可改写 system/messages/工具）。
        const prepared = yield* context.request
          .primary({
            session: loaded.session,
            agent: loaded.agent.id,
            model: loaded.model,
            tools: loaded.tools,
            system: transcript.system,
            // 步数上限：追加说明消息。
            messages: stepLimitReached
              ? [...transcript.messages, Message.assistant(MAX_STEPS_PROMPT)]
              : transcript.messages,
            // Keep tool definitions on the final Step to preserve the provider's cached prefix.
            // 最后一步禁用工具（toolChoice=none），但保留工具定义以保住 provider 的前缀缓存。
            toolChoice: stepLimitReached ? "none" : undefined,
            // 走会话专属的 WebSocket 通道（如果有）。
            webSocket: "session",
            // 供输出上限计算的输入规模。
            inputTokens: estimate,
          })
          .pipe(
            // The hook event holds every message from before images are bounded, screenshots included, and is a separate
            // copy once a plugin hook has rewritten it. The step and its tool callbacks live as long as the slowest tool,
            // so they keep only what they use.
            // 钩子事件里的消息数组很大（含截图、未裁剪的图），而 step 与工具回调
            // 的生命周期取决于最慢的工具，因此这里只保留 step 真正需要的字段。
            Effect.map((prepared) => ({
              request: prepared.request,
              options: prepared.options,
              retry: prepared.retry,
              executeTool: prepared.executeTool,
            })),
          )
        // steps.attempt：真正发请求、流式解析、调度工具 fiber（详见 step.ts）。
        const outcome = yield* steps.attempt({
          isLocationClosed: lifecycle.isClosed,
          sessionID,
          assistantMessageID,
          agent: loaded.agent.id,
          model: loaded.model,
          prepared: {
            ...prepared,
            // A tool call can arrive during a reload; its permission check reads the session's agent.
            // 工具调用可能在重载期间到达：先等插件激活，再做权限检查（读到最新 agent）。
            executeTool: (call) => plugins.awaitActivation.pipe(Effect.andThen(prepared.executeTool(call))),
          },
          // 重试决策：综合错误分类、钩子意见与默认可重试性。
          retry: (cause, error, proposed) =>
            retry.decide({
              cause,
              error,
              agent: loaded.agent.id,
              model: loaded.model.ref,
              hook: prepared.retry,
              retry: proposed,
            }),
          recoverContinuation,
          // recoverOverflow：懒求值（Effect.suspend）——只有真的溢出才去压缩。
          recoverOverflow: Effect.suspend(() =>
            recoverOverflow
              ? compaction
                  .compact({ reason: "overflow", context: loaded, estimate })
                  .pipe(Effect.map((result) => result.status === "completed"))
              : Effect.succeed(false),
          ),
        })
        // 按结果分类处理：$match 对可辨识联合做穷尽匹配。
        const completed = yield* SessionStep.Outcome.$match(outcome, {
          // Completed：一步正常完成。
          Completed: Effect.fnUntraced(function* (outcome) {
            // The Session is about to go idle, which leaves the background summary time to finish.
            // 若会话即将空闲（无需续跑），提前启动后台预压缩摘要（利用空闲窗口）。
            if (!outcome.needsContinuation)
              yield* compaction.precompute(
                store.context(sessionID).pipe(Effect.map((messages) => ({ ...loaded, messages }))),
              )
            return outcome.needsContinuation
          }),
          // Retry：请求层面失败且未输出 → 按决策等待后整体重试。
          Retry: (outcome) =>
            retry.wait({
              decision: outcome.decision,
              error: outcome.error,
              assistantMessageID,
            }),
          // Continue：流中途断掉且已有部分输出 → 等待后发合成消息让模型续写。
          Continue: Effect.fnUntraced(function* (outcome) {
            yield* retry.wait({
              decision: outcome.decision,
              error: outcome.error,
              assistantMessageID,
            })
            yield* bus.publish(SessionEvent.Synthetic, { sessionID, text: CONTINUE_AFTER_INCOMPLETE_STREAM })
            // 续写内容进入新的助手消息。
            assistantMessageID = SessionMessage.ID.create()
          }),
          // OutputLimit：命中输出 token 上限 → 检查是否连续两次仍被截断。
          OutputLimit: Effect.fn("SessionRunner.continueOutputLimit")(function* (outcome) {
            // The current response is included. User input or any other finish breaks the streak.
            // 取最近 3 条 user/assistant 消息，看是否“连续 3 条助手且 finish=length”。
            const recent = yield* db
              .select({
                type: SessionMessageTable.type,
                finish: sql<string | null>`json_extract(${SessionMessageTable.data}, '$.finish')`,
              })
              .from(SessionMessageTable)
              .where(
                and(
                  eq(SessionMessageTable.session_id, sessionID),
                  inArray(SessionMessageTable.type, ["user", "assistant"]),
                ),
              )
              // 按写入顺序倒序取最新。
              .orderBy(desc(SessionMessageTable.seq))
              .limit(3)
              .all()
              // 查询错误视为不可恢复（orDie）。
              .pipe(Effect.orDie)
            // 连续截断两次仍不行 → 判定为失败，避免无限续写循环。
            const exhausted =
              recent.length === 3 && recent.every((row) => row.type === "assistant" && row.finish === "length")
            if (exhausted)
              return yield* new StepFailedError({
                error: {
                  type: "output-limit",
                  message: "Response still truncated after two output token limit continuations",
                },
              })
            // 还有未完成工具 → 下一轮继续。
            if (outcome.needsContinuation) return true
            yield* bus.publish(SessionEvent.Synthetic, { sessionID, text: CONTINUE_AFTER_OUTPUT_LIMIT })
            assistantMessageID = SessionMessage.ID.create()
          }),
          // Compacted：本步因上下文溢出被压缩 → 禁用再次溢出恢复，换新消息重试。
          Compacted: Effect.fnUntraced(function* () {
            recoverOverflow = false
            assistantMessageID = SessionMessage.ID.create()
          }),
          // RecoverFull：传输层要求“整段从头重试” → 只允许一次，防止死循环。
          RecoverFull: Effect.fnUntraced(function* () {
            recoverContinuation = false
          }),
        })
        // completed 非 undefined 表示“要继续/已完成需上抛”，结束本逻辑步骤。
        if (completed !== undefined) return completed
      }
    })

    // settleStaleCompactions：崩溃恢复——把遗留 status=running 的压缩消息判为中断。
    const settleStaleCompactions = Effect.fn("SessionRunner.settleStaleCompactions")(function* (
      sessionID: SessionSchema.ID,
    ) {
      // A process death skips compaction finalizers. Include orphans behind a
      // completed checkpoint, and settle newest first to match event projection.
      // 进程死亡会跳过压缩的收尾器：直接扫表找 running 状态的压缩消息，
      // 按最新优先处理（与事件投影顺序一致）。
      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.session_id, sessionID),
            eq(SessionMessageTable.type, "compaction"),
            // JSON 字段过滤：data->status = 'running'。
            sql`json_extract(${SessionMessageTable.data}, '$.status') = 'running'`,
          ),
        )
        .orderBy(desc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie)
      for (const row of rows) {
        // 行 → 强类型消息。
        const message = yield* SessionHistory.decodeMessageRow(row)
        if (message.type !== "compaction") continue
        // 广播 Compaction.Failed：UI 上该压缩显示为“已中断”。
        yield* bus.publish(SessionEvent.Compaction.Failed, {
          sessionID,
          reason: message.reason,
          inputID: message.id,
          error: { type: "compaction.interrupted", message: "Compaction was interrupted" },
        })
      }
    })

    // settleStaleToolCalls：崩溃恢复——把未完成（streaming/running）的工具调用判为中断。
    const settleStaleToolCalls = Effect.fn("SessionRunner.settleStaleToolCalls")(function* (
      sessionID: SessionSchema.ID,
    ) {
      // 找到所有还没收到 finish 的助手消息。
      for (const message of yield* SessionHistory.incompleteAssistants(db, sessionID)) {
        if (message.type !== "assistant") continue
        for (const tool of message.content) {
          // 只处理还处于 streaming/running 状态的工具调用块。
          if (tool.type !== "tool" || (tool.state.status !== "streaming" && tool.state.status !== "running")) continue
          const metadata = tool.state.status === "running" ? tool.state.metadata : undefined
          // subagent 工具会带子会话 ID，报错信息里一并提示。
          const childID =
            tool.name === "subagent" && typeof metadata?.sessionID === "string" ? metadata.sessionID : undefined
          yield* bus.publish(SessionEvent.Tool.Failed, {
            sessionID,
            assistantMessageID: message.id,
            id: tool.id,
            error: {
              type: "aborted",
              message: `Tool execution interrupted: ${tool.name}${childID ? ` (sessionID: ${childID})` : ""}`,
            },
            ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
            executed: tool.executed === true,
          })
        }
      }
    })

    // 返回服务实例：drain 上再挂一个 span 注解（session.id），便于链路追踪过滤。
    return Service.of({
      drain: (input) => drain(input).pipe(Effect.annotateSpans("session.id", input.sessionID)),
    })
  }),
)

// node：把服务 Layer 与其依赖（一串 Node）打包，供 Location 图装配。
// 这里的 deps 列表就是本服务运行所需的全部协作者。
export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    Bus.node,
    LocationLifecycle.node,
    llmClient,
    SessionContext.node,
    SessionModelTransport.node,
    SessionStore.node,
    SessionCompaction.node,
    Plugin.node,
    PluginHooks.node,
    Job.node,
    SessionTitle.node,
    Snapshot.node,
    ToolOutput.node,
    Database.node,
  ],
})
