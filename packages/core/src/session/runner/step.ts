// =====================================================================
// 文件角色：SessionStep —— 单次“步”（Step）的执行器。
// 一步 = 一次向 provider 的流式请求 + 流内工具调用的并发执行 + 结果落库。
// 与 llm.ts 的分工：llm.ts 管“步与步之间的策略”（重试、压缩、续跑），
// 本文件管“一步内部的工程细节”（流、fiber、中断语义、事件投影）。
// =====================================================================
export * as SessionStep from "./step.js"

// AIError 及其分类：provider 故障的统一类型；isContextOverflowFailure 判断
// 是否为“上下文太长”被拒；ToolCall 是流里解析出的工具调用事件。
import {
  AIError,
  InvalidProviderOutputError,
  LLMClient,
  isContextOverflowFailure,
  type ToolCall,
} from "@opencode/ai/effect"
// Agent 的 Schema 类型（ID 等）。
import type { Agent } from "@opencode/schema/agent"
// Clock（时间）、Exit（结果）、Fiber（轻量线程）、Option、Stream（流）。
import { Cause, Clock, Data, Effect, Exit, Fiber, Option, Stream } from "effect"
import { SessionError } from "@opencode/schema/session-error"
// 事件总线。
import { Bus } from "../../bus.js"
// 权限系统（DeclinedError：用户拒绝授权）。
import { Permission } from "../../permission.js"
// 文件快照服务。
import { Snapshot } from "../../snapshot.js"
// 工具类型定义。
import { Tool } from "../../tool.js"
// 工具输出截断服务。
import { ToolOutput } from "../../tool-output.js"
// question 工具（用户取消提问也算一种“拒绝”）。
import { QuestionTool } from "../../tool/plugin/question.js"
// 步骤失败错误。
import { StepFailedError } from "../error.js"
import { SessionEvent } from "../event.js"
import { SessionMessage } from "../message.js"
import { SessionModelRequest } from "../model-request.js"
import { SessionSchema } from "../schema.js"
import { toSessionError } from "../to-session-error.js"
// 用量记录（token/费用）。
import { SessionUsage } from "../usage.js"
// 已解析模型。
import { SessionRunnerModel } from "./model.js"
// 把 LLM 流事件投影成会话事件/消息更新的发布器。
import { createLLMEventPublisher } from "./publish-llm-event.js"
// 重试策略。
import { SessionRunnerRetry } from "./retry.js"

// Outcome：一次 attempt 的六种结果，供 llm.ts 的 runStep 分类处理。
export type Outcome = Data.TaggedEnum<{
  // Completed：正常完成；needsContinuation=还有工具结果要喂回。
  Completed: { readonly needsContinuation: boolean }
  // Retry：未输出即失败，整体重试。
  Retry: { readonly error: SessionError.Error; readonly decision: SessionRunnerRetry.Decision }
  // Continue：已有部分输出后断流，续写。
  Continue: {
    readonly error: SessionError.Error
    readonly decision: SessionRunnerRetry.Decision
  }
  // RecoverFull：传输层要求整段重试。
  RecoverFull: {}
  // Compacted：上下文溢出，已触发压缩。
  Compacted: {}
  // OutputLimit：命中输出 token 上限。
  OutputLimit: { readonly needsContinuation: boolean }
}>
// 生成 $match/$is 等伴生工具。
export const Outcome = Data.taggedEnum<Outcome>()

// attempt 的输入参数。
interface Input {
  readonly isLocationClosed: () => boolean
  readonly sessionID: SessionSchema.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly agent: Agent.ID
  readonly model: SessionRunnerModel.Resolved
  // prepared：请求钩子处理后的请求、选项、重试钩子与工具执行器。
  readonly prepared: Omit<SessionModelRequest.Prepared, "event">
  readonly retry: (
    cause: AIError,
    error: SessionError.Error,
    retry: boolean,
  ) => Effect.Effect<{ readonly retry: false } | SessionRunnerRetry.Decision>
  readonly recoverContinuation: boolean
  /** The runner owns compaction policy; the attempt invokes it only before durable output. */
  // 溢出恢复由 runner 拥有策略；attempt 只在“持久化输出之前”调用它。
  readonly recoverOverflow: Effect.Effect<boolean>
}

// 三个常用的中断/缺失错误常量。
const TOOLS_INTERRUPTED = { type: "aborted", message: "Tool execution interrupted" } as const
const STEP_INTERRUPTED = { type: "aborted", message: "Step interrupted" } as const
const RESULT_MISSING = { type: "tool.result-missing", message: "Provider did not return a tool result" } as const

/** Captures Location-scoped dependencies without introducing another service or execution loop. */
// 工厂：捕获 Location 级依赖（bus/llm/快照/工具输出），返回 { attempt }。
// 不再做成独立服务，避免多一层注册与执行循环。
export const make = Effect.gen(function* () {
  const bus = yield* Bus.Service
  const llm = yield* LLMClient.Service
  const snapshots = yield* Snapshot.Service
  const toolOutput = yield* ToolOutput.Service

  // attempt：执行一步。Effect.scoped：为本次调用建立资源作用域，
  // 里面 fork 的 fiber（工具执行、快照捕获）都会在作用域结束时被清理。
  const attempt = Effect.fn("SessionStep.attempt")(function* (input: Input) {
    // The start snapshot only has to exist before local tools run, which cannot happen before Step.Started,
    // so it is captured while the provider request is in flight instead of delaying it.
    // 起始快照只要在“本地工具开跑前”存在即可（而工具最早也在 Step.Started
    // 之后才跑），所以趁 provider 请求在途时后台捕获，不阻塞请求。
    const pendingStartSnapshot = yield* snapshots.capture().pipe(Effect.forkScoped)
    // 记录开始时间（用于统计首 token 延迟等）。
    const started = yield* Clock.currentTimeMillis
    let firstOutputAt: number | undefined
    // 给当前 span 打上 provider/model 注解（gen_ai.* 是 LLM 可观测性惯例字段）。
    yield* Effect.annotateCurrentSpan({
      "gen_ai.provider.name": input.model.ref.providerID,
      "gen_ai.request.model": input.model.ref.id,
    })
    // 创建事件发布器：把 provider 流事件翻译成 Bus 上的会话事件与消息更新。
    const publisher = createLLMEventPublisher(bus, {
      sessionID: input.sessionID,
      assistantMessageID: input.assistantMessageID,
      agent: input.agent,
      model: input.model.ref,
      providerMetadataKey: input.model.model.route.providerMetadataKey ?? input.model.model.provider,
      // Fiber.join：等起始快照捕获完成（发布器在首次产出时才需要它）。
      pendingSnapshot: Fiber.join(pendingStartSnapshot),
      started,
    })
    // 收集本步的工具执行 fiber：每个工具调用一个，最后统一等待/中断。
    const toolRuns: Array<{
      readonly call: ToolCall
      readonly fiber: Fiber.Fiber<void, Permission.DeclinedError | QuestionTool.CancelledError>
    }> = []
    // interruptTools：中断所有还在跑的工具 fiber。
    const interruptTools = Effect.suspend(() => Fiber.interruptAll(toolRuns.map((run) => run.fiber)))
    // 工具执行入口：步数上限（toolChoice=none）时直接报错；否则走 prepared.executeTool。
    const executeTool = (call: ToolCall) => {
      if (input.prepared.request.toolChoice?.type === "none")
        return new Tool.Error({ message: "Tools are disabled after the maximum agent steps" })
      return input.prepared.executeTool({
        sessionID: input.sessionID,
        agent: input.agent,
        messageID: input.assistantMessageID,
        call,
        // progress 回调：工具运行中的元数据更新（如 bash 的输出流）。
        progress: (update) => publisher.progress(call.id, update),
      })
    }

    // Provider and tool fibers retain per-source order without a shared writer queue.
    // A local execution starts only after its Tool.Called publication completes.
    // Read to the end, not just the finish event, so the next request can reuse this response.
    // 设计：provider 与各工具 fiber 各自保序发布（无需共享写队列）；本地工具
    // 只在 Tool.Called 事件发布完成后才启动；流要读到末尾（而不仅是 finish
    // 事件），下一次请求才能复用这次响应（缓存友好）。
    const providerStream = llm.stream(input.prepared.request, input.prepared.options).pipe(
      // runForEach：逐事件处理，任一事件失败则整个流失败。
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          // provider 已经失败过：丢弃后续残余事件。
          if (publisher.record().providerFailed) return
          // Wait here, where cancellation still works, rather than inside the uninterruptible publish.
          // 在这里（可中断点）等起始快照完成——而不是在不可中断的 publish 内部等。
          if (!publisher.hasStarted()) yield* Fiber.join(pendingStartSnapshot)
          // 发布该事件（转成消息更新/会话事件）。
          yield* publisher.publish(event)
          // 记录首个输出的时间。
          if (firstOutputAt === undefined && publisher.record().outputStarted)
            firstOutputAt = yield* Clock.currentTimeMillis
          // 只处理“本地执行”的工具调用：providerExecuted（服务端执行）的跳过。
          if (event.type !== "tool-call" || event.providerExecuted) return
          // 为该工具调用 fork 一个 fiber：执行 → 截断输出 → 发布执行结果。
          toolRuns.push({
            call: event,
            fiber: yield* Effect.uninterruptibleMask((restore) =>
              restore(executeTool(event)).pipe(
                Effect.flatMap(toolOutput.truncate),
                Effect.flatMap((outcome) => publisher.toolExecution(event.id, event.name, outcome)),
                Effect.catchTag("Tool.Error", (error) =>
                  publisher.failTool(event.id, toSessionError(error), error.metadata).pipe(Effect.asVoid),
                ),
              ),
            ).pipe(Effect.forkScoped),
          })
        }),
      ),
      // 流结束后（无论成败）冲刷发布器（落库未完成的助手消息等）。
      Effect.ensuring(publisher.flush()),
    )

    // Keep the final tool and Step events uninterruptible, even when the work itself is cancelled.
    // uninterruptibleMask：收尾段（结算工具结果、发布 Step 事件）不可中断，
    // 即使工作本身被取消，事件也能完整落库。
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        // 跑 provider 流（可中断窗口内），拿到 Exit 结果。
        const stream = yield* restore(providerStream).pipe(Effect.exit)
        const streamFailure = Option.getOrUndefined(Exit.findErrorOption(stream))
        // 判断流是否带中断标记。
        const streamInterrupted = Exit.hasInterrupts(stream)
        // Cancelled before the start snapshot existed: record nothing, as when the capture preceded the request.
        // 请求发出前就被取消、起始快照还没落库 → 什么都不记录，原样上抛中断。
        if (
          Exit.isFailure(stream) &&
          streamInterrupted &&
          !publisher.hasStarted() &&
          !pendingStartSnapshot.pollUnsafe()
        )
          return yield* Effect.failCause(stream.cause)
        // 已产出过事件 → 通知发布器“流结束”。
        if (publisher.hasStarted()) yield* publisher.streamed()
        // 流被中断 → 中断所有工具 fiber。
        if (streamInterrupted) yield* interruptTools
        // 等所有工具 fiber 结束（restore 窗口内可被中断）。
        const joined = yield* restore(Fiber.awaitAll(toolRuns.map((run) => run.fiber))).pipe(Effect.exit)
        if (Exit.isFailure(joined)) yield* interruptTools
        // 分类工具结果：declines（用户拒绝）/ interrupted / failure。
        const tools = classifyToolExits(joined, toolRuns)

        // 一个字都没输出 + provider 判定上下文溢出 + runner 允许恢复 →
        // 返回 Compacted，由 runStep 压缩后重试。
        if (
          !publisher.record().outputStarted &&
          isContextOverflowFailure(streamFailure) &&
          (yield* restore(input.recoverOverflow))
        ) {
          yield* Effect.logWarning("provider rejected the request as too long; compacting", {
            sessionID: input.sessionID,
            model: input.model.ref,
            message: streamFailure?.message,
          })
          return Outcome.Compacted()
        }

        const recorded = publisher.record()
        // finish 原因未知（流被截断且 provider 没给正常 finish）→ 视为无效输出。
        const unknownFinish =
          Exit.isSuccess(stream) && recorded.finish?.finish === "unknown"
            ? new AIError({
                reason: new InvalidProviderOutputError({
                  message: "The provider response ended with an unknown finish reason.",
                  classification: "incomplete-stream",
                }),
              })
            : undefined
        // llmFailure：流错误或未知 finish（providerFailed 的失败除外，见下）。
        const llmFailure = streamFailure instanceof AIError ? streamFailure : unknownFinish
        const llmError = llmFailure && !recorded.providerFailed ? toSessionError(llmFailure) : undefined
        // token 用量。
        const tokens = recorded.finish?.usage
        // 给 span 追加首输出延迟、finish 原因与用量注解（可观测性）。
        yield* Effect.annotateCurrentSpan({
          ...(firstOutputAt === undefined ? {} : { "opencode.llm.first_output_ms": firstOutputAt - started }),
          ...(recorded.finish === undefined ? {} : { "gen_ai.response.finish_reasons": [recorded.finish.finish] }),
          ...(tokens?.inputTokens === undefined ? {} : { "gen_ai.usage.input_tokens": tokens.inputTokens }),
          ...(tokens?.outputTokens === undefined ? {} : { "gen_ai.usage.output_tokens": tokens.outputTokens }),
          ...(tokens?.cacheReadInputTokens === undefined
            ? {}
            : { "gen_ai.usage.cache_read.input_tokens": tokens.cacheReadInputTokens }),
          ...(llmFailure === undefined ? {} : { "error.type": llmFailure.reason._tag }),
        })
        // 传输层失败且可“整段重试”（如连接断在响应前）→ RecoverFull。
        if (
          input.recoverContinuation &&
          llmFailure?.reason._tag === "Transport" &&
          (llmFailure.reason.recovery === "retry-full" || llmFailure.reason.recovery === "rotate-and-retry-full") &&
          !recorded.outputStarted
        )
          return Outcome.RecoverFull()
        // 非溢出失败 → 问重试决策（钩子 + 默认策略）。
        const retry =
          llmFailure && llmError && !isContextOverflowFailure(llmFailure)
            ? yield* restore(
                input.retry(
                  llmFailure,
                  llmError,
                  SessionRunnerRetry.isRetryable(llmFailure) ||
                    (recorded.outputStarted && isInterruptedStream(llmFailure)),
                ),
              )
            : undefined
        if (llmFailure && llmError && retry?.retry && !recorded.outputStarted) {
          // Retry state projects onto the existing assistant, even before it has produced output.
          // 重试状态投影到既有助手消息（哪怕它还没产出内容），保持 UI 连续。
          yield* publisher.startAssistant()
          return Outcome.Retry({ error: llmError, decision: retry })
        }
        // 不重试 → 把失败写进助手消息（UI 展示错误）。
        if (llmError) yield* publisher.failAssistant(llmError)

        // 用户拒绝的工具调用：逐个发布失败事件（拒绝/取消/Location 关闭文案不同）。
        for (const decline of tools.declines)
          yield* publisher.failTool(decline.call.id, {
            type: "aborted",
            message: input.isLocationClosed()
              ? "Interaction cancelled because the location shut down"
              : decline.reason._tag === "QuestionTool.CancelledError"
                ? decline.reason.message
                : "The user declined this tool call",
          })
        // 判定本步是否被打断/失败，并统一结算未完成的工具。
        const interrupted = tools.declines.length > 0 || streamInterrupted || tools.interrupted
        const toolFailure = interrupted
          ? TOOLS_INTERRUPTED
          : tools.failure !== undefined
            ? toSessionError(Cause.squash(tools.failure))
            : recorded.providerFailed
              ? TOOLS_INTERRUPTED
              : undefined
        if (toolFailure) yield* publisher.failUnsettledTools(toolFailure)
        if (interrupted) yield* publisher.failAssistant(STEP_INTERRUPTED)

        // Parsers may leave unfinished calls without an execution event.
        // 解析器可能留下“没有执行事件”的未完成调用：补发 RESULT_MISSING。
        if (llmError || (Exit.isSuccess(stream) && !recorded.providerFailed)) {
          const missing = yield* publisher.failUnsettledTools(RESULT_MISSING, "hosted")
          if (missing && !llmError && !recorded.finish) yield* publisher.failAssistant(RESULT_MISSING)
          yield* publisher.failIncompleteTools()
        }

        // 取最终记录：有 finish 或 failure 才结算 Step 事件。
        const record = publisher.record()
        if (record.finish || record.failure) {
          // 等起始快照，再捕一次结束快照，diff 出本步改动的文件列表。
          const startSnapshot = yield* Fiber.join(pendingStartSnapshot)
          const snapshot = yield* snapshots.capture()
          const files =
            startSnapshot && snapshot
              ? startSnapshot === snapshot
                // 一步内没动任何文件。
                ? []
                : yield* snapshots
                    .files({ from: startSnapshot, to: snapshot })
                    .pipe(Effect.orElseSucceed(() => undefined))
              : undefined
          // 记录 token/费用用量。
          const usage = record.finish ? SessionUsage.record(record.finish.usage, input.model.cost) : undefined
          // 失败 → 发布 Step 失败事件；成功 → 发布 Step.Ended（含 finish 原因与用量）。
          if (record.failure) yield* publisher.publishStepFailure({ ...usage, snapshot, files })
          if (record.finish && usage && !record.failure)
            yield* bus.publish(SessionEvent.Step.Ended, {
              sessionID: input.sessionID,
              assistantMessageID: yield* publisher.startAssistant(),
              finish: record.finish.finish,
              rawFinish: record.finish.rawFinish,
              native: record.finish.native,
              ...usage,
              snapshot,
              files,
            })
        }

        // 已有部分输出 + 决定重试 + 没有拒绝/中断 → Continue（续写而不是重放）。
        if (
          llmFailure &&
          llmError &&
          retry?.retry &&
          record.outputStarted &&
          tools.declines.length === 0 &&
          !tools.interrupted
        )
          return Outcome.Continue({ error: llmError, decision: retry })

        // 流本身失败 → 原样上抛失败原因。
        if (Exit.isFailure(stream)) return yield* Effect.failCause(stream.cause)
        // 有拒绝：Location 已关则视为完成（要续跑）；否则整体中断本步。
        if (tools.declines.length > 0) {
          if (input.isLocationClosed()) return Outcome.Completed({ needsContinuation: true })
          return yield* Effect.interrupt
        }
        // 工具被打断且有真实失败 → 上抛。
        if (tools.interrupted && tools.failure) return yield* Effect.failCause(tools.failure)
        if (tools.interrupted && Exit.isFailure(joined)) return yield* Effect.failCause(joined.cause)
        // 已记录的失败 → StepFailedError。
        if (record.failure) return yield* new StepFailedError({ error: record.failure })
        // needsContinuation：还有工具结果没喂回模型 → 需要下一步。
        const needsContinuation = input.prepared.request.toolChoice?.type !== "none" && record.needsContinuation
        // finish=length → 输出上限；否则正常完成。
        if (record.finish?.finish === "length") return Outcome.OutputLimit({ needsContinuation })
        return Outcome.Completed({ needsContinuation })
      }),
    )
  }, Effect.scoped)

  return { attempt }
})

// 判断失败是否为“流被打断”：无效输出分类为 incomplete-stream，或传输层在读操作中失败。
const isInterruptedStream = (failure: AIError) => {
  if (failure.reason._tag === "InvalidProviderOutput") return failure.reason.classification === "incomplete-stream"
  if (failure.reason._tag === "Transport") return failure.reason.operation === "read"
  return false
}

/** Tool.Error settles in each fiber; only user declines remain in the typed error channel. */
// 分类所有工具 fiber 的 Exit 结果：
// - declines：用户拒绝/取消（类型化错误通道里只剩这类）。
// - interrupted：任意 fiber 带中断标记。
// - failure：第一个真实的 Die（不可恢复异常）原因。
const classifyToolExits = (
  settled: Exit.Exit<Array<Exit.Exit<void, Permission.DeclinedError | QuestionTool.CancelledError>>>,
  runs: ReadonlyArray<{ readonly call: ToolCall }>,
) => {
  // 外层 awaitAll 成功才有内层结果数组。
  const exits = Exit.isSuccess(settled) ? settled.value : []
  // 收集每个失败 fiber 的失败原因（连同对应的工具调用）。
  const declines = exits.flatMap((exit, index) =>
    Exit.isFailure(exit)
      ? exit.cause.reasons.flatMap((reason) =>
          Cause.isFailReason(reason) ? [{ call: runs[index].call, reason: reason.error }] : [],
        )
      : [],
  )
  // 汇总所有失败 cause（外层失败或内层任一失败）。
  const causes = Exit.isFailure(settled)
    ? [settled.cause]
    : exits.flatMap((exit) => (Exit.isFailure(exit) ? [exit.cause] : []))
  // 找第一个含 Die（崩溃类错误）的 cause 作为失败代表。
  const failure = causes
    .flatMap((cause) => {
      if (Cause.hasInterrupts(cause)) return []
      const reasons = cause.reasons.filter(Cause.isDieReason)
      return reasons.length > 0 ? [Cause.fromReasons<never>(reasons)] : []
    })
    .at(0)
  return { interrupted: causes.some(Cause.hasInterrupts), declines, failure }
}
