// LLM 事件、提供方元数据与工具结果值的类型
import { type LLMEvent, type ProviderMetadata, type ToolResultValue } from "@opencode/ai/effect"
// 判断值是否为普通对象
import { isRecord } from "@opencode/util/record"
// 代理 ID 类型
import type { Agent } from "@opencode/schema/agent"
// 模型引用类型
import type { Model } from "@opencode/schema/model"
// 相对路径类型
import type { RelativePath } from "@opencode/schema/schema"
// 快照 ID 类型
import type { Snapshot } from "@opencode/schema/snapshot"
// 令牌用量类型
import type { TokenUsage } from "@opencode/schema/token-usage"
// effect：Effect 运行时、Fiber 轻量线程、Iterable 工具
import { Effect, Fiber, Iterable } from "effect"
// 判断只读数组是否非空
import { isReadonlyArrayNonEmpty } from "effect/Array"
// 事件总线
import { Bus } from "../../bus.js"
// 会话事件定义
import { SessionEvent } from "../event.js"
// 会话消息类型
import { SessionMessage } from "../message.js"
// 会话 Schema：ID 类型
import { SessionSchema } from "../schema.js"
// 会话错误类型
import { SessionError } from "@opencode/schema/session-error"
// 金额类型（美元）
import { Money } from "@opencode/schema/money"
// 内容过滤（content filter）错误构造
import { contentFilterError } from "../to-session-error.js"
// 工具类型（仅类型引用）
import type { Tool } from "../../tool.js"
// 工具运行时的序列化函数
import { stringify } from "../../tool/runtime.js"

// 发布器的输入：会话/代理/模型标识、提供方元数据键、待定快照与时间
type Input = {
  readonly sessionID: SessionSchema.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly providerMetadataKey: string
  /** The start snapshot, awaited before `Step.Started` so its capture can overlap the provider request. */
  // 起始快照：在 Step.Started 前等待，使快照捕获可与提供方请求重叠进行
  readonly pendingSnapshot?: Effect.Effect<Snapshot.ID | undefined>
  readonly started: number
  readonly assistantMessageID: SessionMessage.ID
}

// 把任意值归一为对象：非普通对象时包一层 { value }
const asRecord = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : { value })

// 工具入参摘录的最大字符数
const INPUT_EXCERPT_LIMIT = 2048

// 工具入参摘录：截断文本与原始总长度
type InputExcerpt = {
  readonly text: string
  readonly length: number
}

// 入参失败原因：JSON 解析失败 / 被 token 上限截断 / 参数未写完
type InputFailureReason = "malformed" | "length" | "incomplete"

// 各失败原因对应的错误定义（类型与提示信息）
const INPUT_FAILURES = {
  malformed: {
    type: "tool.input-json",
    message:
      "The tool input could not be parsed as JSON, so the call was not executed. Reissue the call with valid JSON arguments.",
  },
  length: {
    type: "tool.input-incomplete",
    message:
      "The tool call was not executed because the output token limit (stop reason: length) was reached before you could complete the arguments. Break large payloads into smaller tool calls and reissue the call with complete arguments.",
  },
  incomplete: {
    type: "tool.input-incomplete",
    message: "Tool call arguments were not completed and were not executed. Reissue the call with complete arguments.",
  },
} satisfies Record<InputFailureReason, SessionError.Error>

/** Immutable fold of the durable facts a step's writer has recorded so far. */
// 步骤（step）记录：写入方已记录的持久事实的不可变汇总
export interface StepRecord {
  /** The model produced visible output this attempt, which bars transparent retries and overflow recovery. */
  // 模型本次尝试已产生可见输出，因此禁止透明重试与溢出恢复
  readonly outputStarted: boolean
  // 提供方侧是否已失败
  readonly providerFailed: boolean
  /** The step's recorded assistant failure, if any. */
  // 步骤记录的助手失败（如有）
  readonly failure?: SessionError.Error
  /** Present once the provider finished the step normally. */
  // 提供方正常结束步骤后才有值：结束原因、原始原因、原生元数据与用量
  readonly finish?: {
    readonly finish: Extract<LLMEvent, { type: "step-finish" }>["reason"]["normalized"]
    readonly rawFinish?: string
    readonly native?: SessionMessage.Native
    readonly usage: Extract<LLMEvent, { type: "step-finish" }>["usage"]
  }
  // 是否需要续写（存在本地执行的工具调用）
  readonly needsContinuation: boolean
}

/** Derives canonical model content from a provider-hosted tool result. */
// 非空内容元组：至少一个 Tool.Content
type NonEmptyContent = readonly [Tool.Content, ...Tool.Content[]]

// 把提供方托管（hosted）的工具结果转成规范内容：内容数组原样，其他序列化为文本
const hostedContent = (result: ToolResultValue): NonEmptyContent => {
  // 结果本身就是内容数组且非空时直接使用
  if (result.type === "content" && isReadonlyArrayNonEmpty(result.value)) return result.value
  // 其他值序列化为文本片段
  return [{ type: "text", text: stringify(result.value) }]
}

/**
 * Persist one step without executing tools or starting a continuation step.
 *
 * Concurrency invariant: the provider loop and each owned tool fiber call these methods
 * concurrently without a lock. Two rules keep that safe, and every method must preserve
 * them. (1) Commit state marks synchronously before the first await: never a yield
 * between a check (`tool.settled`, `stepStarted`, ...) and its mark, so check-and-mark
 * stays atomic under cooperative scheduling. Provider-event publication remains
 * uninterruptible through its writes so cancellation cannot strand a mark without
 * its durable event. (2) Never require a cross-source event
 * order: each publishing fiber is sequential, so per-source order holds by construction,
 * and consumers fold by id/ordinal rather than global position.
 */
export const createLLMEventPublisher = (bus: Pick<Bus.Interface, "publish">, input: Input) => {
  // 增量（delta）批处理的发布间隔（毫秒）
  const deltaBatchInterval = 100
  // 工具调用状态：名称与各阶段标记
  type ToolState = {
    readonly name: string
    // 是否已发出 tool-call
    called: boolean
    // 是否已有终态（成功/失败）
    settled: boolean
    // 是否由提供方托管执行
    providerExecuted: boolean
    // 执行进度元数据
    progress?: Tool.Metadata
    // 入参摘录（用于恢复错误提示）
    input?: InputExcerpt
    // 入参是否为畸形 JSON
    malformed?: boolean
  }
  // 本次步骤内所有工具调用的状态表：调用 ID → 状态
  const tools = new Map<string, ToolState>()
  // 合成失败事件的进度快照：优先保留既有进度，再叠加传入元数据
  const failureSnapshot = (tool: { readonly progress?: Tool.Metadata }, metadata?: Tool.Metadata) => {
    // 双方都为空则不携带 metadata
    if (tool.progress === undefined) return metadata === undefined ? {} : { metadata }
    // 只有既有进度则沿用
    if (metadata === undefined) return { metadata: tool.progress }
    // 两者都有则合并（新元数据覆盖同名字段）
    return { metadata: { ...tool.progress, ...metadata } }
  }
  // 本步骤的助手消息 ID
  const assistantMessageID = input.assistantMessageID
  // 步骤是否已开始
  let stepStarted = false
  // 提供方侧是否失败
  let providerFailed = false
  // 是否已产生可见输出
  let outputStarted = false
  // 步骤级失败（如有）
  let stepFailure: SessionError.Error | undefined
  // 步骤的正常结束信息（如有）
  let stepSettlement: StepRecord["finish"]

  // 启动助手步骤：确保 Step.Started 只发布一次
  const startAssistant = Effect.fnUntraced(function* () {
    // 已开始则直接返回消息 ID
    if (stepStarted) return assistantMessageID
    // 等待待定快照（若提供）
    const snapshot = input.pendingSnapshot ? yield* input.pendingSnapshot : undefined
    // Check again after the await, so the check and the mark below never straddle a yield.
    // await 之后再次检查，保证下面的检查与标记之间绝不会横跨让出点
    if (stepStarted) return assistantMessageID
    // 同步标记步骤开始（检查与标记之间无 yield）
    stepStarted = true
    // 发布 Step.Started 事件
    yield* bus.publish(SessionEvent.Step.Started, {
      sessionID: input.sessionID,
      agent: input.agent,
      model: input.model,
      assistantMessageID,
      snapshot,
      started: input.started,
    })
    return assistantMessageID
  })
  // 取当前助手消息 ID：步骤未开始时属于致命错误（工具事件先于步骤）
  const currentAssistantMessageID = () =>
    stepStarted ? Effect.succeed(assistantMessageID) : Effect.die(new Error("Tool event before assistant step start"))
  // 发布 Step.Streamed（表示已有流式内容）
  const streamed = Effect.fnUntraced(function* () {
    yield* bus.publish(SessionEvent.Step.Streamed, {
      sessionID: input.sessionID,
      assistantMessageID: yield* startAssistant(),
    })
  })
  // 读取当前提供方（provider）的原生元数据
  const native = (metadata: ProviderMetadata | undefined) => metadata?.[input.providerMetadataKey]
  // 分片（fragment）管理器：跟踪多个流式块的序号、累积值与批量增量发布
  const fragments = (
    name: string,
    ended: (id: string, value: string, ordinal: number, native?: SessionMessage.Native) => Effect.Effect<void>,
    delta?: (id: string, value: string, ordinal: number) => Effect.Effect<void>,
    single = false,
  ) => {
    // 单个分片：序号、累积值列表、待发布增量、尾部刷新定时器与原生元数据
    type Fragment = {
      readonly ordinal: number
      readonly values: string[]
      pending: string
      timer?: Fiber.Fiber<void>
      native?: SessionMessage.Native
    }
    // 活跃分片表：块 ID → 分片
    const chunks = new Map<string, Fragment>()
    // 下一个分片的序号
    let nextOrdinal = 0
    // 开始一个分片；重复开始或（single 模式下）未结束就开始都属致命错误
    const start = (id: string, native?: SessionMessage.Native) =>
      Effect.suspend(() => {
        // 同 ID 重复开始
        if (chunks.has(id)) return Effect.die(new Error(`Duplicate ${name} start: ${id}`))
        // single 模式下已有未结束分片
        if (single && chunks.size > 0) return Effect.die(new Error(`${name} start before end: ${id}`))
        // 分配序号并登记
        const ordinal = nextOrdinal++
        chunks.set(id, { ordinal, values: [], pending: "", native })
        return Effect.succeed(ordinal)
      })
    // 发布一批待发增量（不可中断，保证清空与发布成对完成）
    const publishDelta = Effect.fnUntraced(function* (id: string) {
      // 未提供增量回调则不发布
      if (!delta) return undefined
      // 分片不存在说明先有增量后有开始
      const current = chunks.get(id)
      if (!current) return yield* Effect.die(new Error(`${name} delta before start: ${id}`))
      // 没有待发内容
      if (!current.pending) return undefined
      // 取出待发文本
      const value = current.pending
      // New chunks can arrive while the timer is publishing this batch.
      // 定时器发布本批期间可能有新块到达，所以先清空再发布，避免重复
      current.pending = ""
      yield* delta(id, value, current.ordinal)
      return undefined
    }, Effect.uninterruptible)
    // 追加一段内容到分片
    const append = Effect.fnUntraced(function* (id: string, value: string, native?: SessionMessage.Native) {
      // 分片不存在
      const current = chunks.get(id)
      if (!current) return yield* Effect.die(new Error(`${name} delta before start: ${id}`))
      // 累积完整值
      current.values.push(value)
      // 支持增量发布时累积待发文本
      if (delta) current.pending += value
      // 合并原生元数据
      if (native !== undefined) current.native = { ...current.native, ...native }
      // 有待发内容且尚无定时器时，启动尾部刷新定时器
      if (current.pending && !current.timer) {
        // Own the trailing flush in the provider fiber, even if no more chunks arrive.
        // 由提供方 Fiber 负责最后的刷新，即使不再有新块到达也能发出剩余增量
        current.timer = yield* Effect.gen(function* () {
          // 只要还有待发内容就按间隔反复发布
          while (current.pending) {
            yield* Effect.sleep(deltaBatchInterval)
            yield* publishDelta(id)
          }
        }).pipe(
          // 结束时清空定时器引用
          Effect.ensuring(
            Effect.sync(() => {
              current.timer = undefined
            }),
          ),
          // 立即启动的子 Fiber
          Effect.forkChild({ startImmediately: true }),
        )
      }
      // 返回分片序号
      return current.ordinal
    })
    // 结束分片：停定时器 → 发剩余增量 → 发布 ended 回调 → 移除分片
    const end = Effect.fnUntraced(function* (id: string, native?: SessionMessage.Native, value?: string) {
      // 分片不存在说明先结束后有开始
      const current = chunks.get(id)
      if (!current) return yield* Effect.die(new Error(`${name} end before start: ${id}`))
      // 有定时器则先中断
      if (current.timer) yield* Fiber.interrupt(current.timer)
      // 发出剩余增量
      yield* publishDelta(id)
      // 发布结束事件：优先用调用方给定的完整值，否则用累积值拼接
      yield* ended(
        id,
        value ?? current.values.join(""),
        current.ordinal,
        native === undefined ? current.native : { ...current.native, ...native },
      )
      // 移除分片
      chunks.delete(id)
      return undefined
    })
    // 结束所有活跃分片（收尾清理）
    const flush = Effect.fnUntraced(function* () {
      for (const id of Array.from(chunks.keys())) yield* end(id)
    })
    /** Publish batched deltas now, keeping every fragment open. */
    // 立即发布所有批处理中的增量，但保持每个分片打开
    const publishPending = Effect.fnUntraced(function* () {
      for (const [id, current] of Array.from(chunks)) {
        // 中断各自的定时器（此处手动发布）
        if (current.timer) yield* Fiber.interrupt(current.timer)
        // 发布该分片的待发增量
        yield* publishDelta(id)
      }
    })
    // 返回分片管理器的操作集
    return { start, append, end, flush, publishPending, has: (id: string) => chunks.has(id) }
  }

  // 内容分片工厂：把文本/推理的 Ended/Delta 事件接到分片管理器（single 模式）
  const contentFragments = (name: string, events: typeof SessionEvent.Text | typeof SessionEvent.Reasoning) =>
    fragments(
      name,
      // 分片结束时发布 Ended 事件（含完整文本与序号）
      (_id, value, ordinal, native) =>
        Effect.gen(function* () {
          yield* bus.publish(events.Ended, {
            sessionID: input.sessionID,
            assistantMessageID: yield* currentAssistantMessageID(),
            ordinal,
            text: value,
            native,
          })
        }),
      // 增量时发布 Delta 事件
      (_id, value, ordinal) =>
        Effect.gen(function* () {
          yield* bus.publish(events.Delta, {
            sessionID: input.sessionID,
            assistantMessageID: yield* currentAssistantMessageID(),
            ordinal,
            delta: value,
          })
        }),
      true,
    )
  // 文本分片管理器
  const text = contentFragments("text", SessionEvent.Text)
  // 推理分片管理器
  const reasoning = contentFragments("reasoning", SessionEvent.Reasoning)
  // 工具入参分片管理器：结束时记录摘录并发布 Tool.Input.Ended
  const toolInput = fragments("tool input", (id, value) =>
    Effect.gen(function* () {
      // 工具状态不存在说明入参结束先于开始
      const tool = tools.get(id)
      if (!tool) return yield* Effect.die(new Error(`Tool input end before start: ${id}`))
      // Keep a bounded excerpt for recovery errors; the full argument text is persisted below.
      // 为恢复错误保留有界摘录；完整入参文本随后单独持久化
      tool.input = inputExcerpt(value)
      yield* bus.publish(SessionEvent.Tool.Input.Ended, {
        sessionID: input.sessionID,
        assistantMessageID,
        id,
        text: value,
      })
    }),
  )

  // Deltas are batched, but block starts are not. Publishing held deltas first keeps each
  // block's content ahead of the next block, so the published order matches the model's.
  // 增量是批处理的，但块开始不是。先发布滞留的增量能让每个块的内容
  // 领先于下一个块，保证发布顺序与模型的输出顺序一致
  const publishPendingDeltas = Effect.fnUntraced(function* () {
    // 先发布文本滞留增量
    yield* text.publishPending()
    // 再发布推理滞留增量
    yield* reasoning.publishPending()
  })

  // 结束所有未结束的分片（文本、推理、工具入参）
  const flushFragments = Effect.fnUntraced(function* () {
    yield* text.flush()
    yield* reasoning.flush()
    yield* toolInput.flush()
  })

  // 记录工具入参开始：登记工具状态并发布 Tool.Input.Started
  const startToolInput = Effect.fnUntraced(function* (event: {
    readonly id: string
    readonly name: string
    readonly providerExecuted?: boolean
  }) {
    // 同 ID 重复开始属致命错误
    if (tools.has(event.id)) return yield* Effect.die(new Error(`Duplicate tool input start: ${event.id}`))
    // 确保助手步骤已开始
    yield* startAssistant()
    // 初始化工具状态
    const tool: ToolState = {
      name: event.name,
      called: false,
      settled: false,
      providerExecuted: event.providerExecuted === true,
    }
    // 登记到状态表
    tools.set(event.id, tool)
    // 打开工具入参分片
    yield* toolInput.start(event.id)
    // 先发布滞留的内容增量，保证顺序
    yield* publishPendingDeltas()
    // 发布 Tool.Input.Started
    yield* bus.publish(SessionEvent.Tool.Input.Started, {
      sessionID: input.sessionID,
      assistantMessageID,
      id: event.id,
      name: event.name,
    })
    return tool
  })

  // 结束工具入参：校验状态后结束分片
  const endToolInput = Effect.fnUntraced(function* (
    event: { readonly id: string; readonly name: string },
    value?: string,
  ) {
    // 工具状态不存在
    const tool = tools.get(event.id)
    if (!tool) return yield* Effect.die(new Error(`Tool input end before start: ${event.id}`))
    // 工具名与开始时不一致
    if (tool.name !== event.name)
      return yield* Effect.die(new Error(`Tool input name changed for ${event.id}: ${tool.name} -> ${event.name}`))
    // 分片已结束则重复结束
    if (!toolInput.has(event.id)) return yield* Effect.die(new Error(`Duplicate tool input end: ${event.id}`))
    // 结束分片（可传入解析器得到的完整值）
    yield* toolInput.end(event.id, undefined, value)
  })

  // 处理畸形（无法解析为 JSON）的工具入参
  const failMalformedToolInput = Effect.fnUntraced(function* (event: {
    readonly id: string
    readonly name: string
    readonly raw: string
  }) {
    // 状态缺失时补一次开始流程
    const tool = tools.get(event.id) ?? (yield* startToolInput(event))
    // 调用已结算后再报畸形属致命错误
    if (tool.called || tool.settled)
      return yield* Effect.die(new Error(`Malformed tool input after call settlement: ${event.id}`))
    // 工具名不一致
    if (tool.name !== event.name)
      return yield* Effect.die(new Error(`Tool input name changed for ${event.id}: ${tool.name} -> ${event.name}`))
    // 分片还开着就以原始文本结束它
    if (toolInput.has(event.id)) yield* endToolInput(event, event.raw)
    // The parser's final raw input may differ from streamed deltas; use it for the recovery excerpt.
    // 解析器得到的最终原始输入可能与流式增量不同；恢复摘录要用它
    tool.input = inputExcerpt(event.raw)
    // 标记畸形
    tool.malformed = true
  })

  // 以入参失败原因结束一个工具（length 原因视步骤结束原因而定）
  const failToolInput = (id: string, tool: ToolState, reason: Exclude<InputFailureReason, "length">) =>
    failTool(id, inputFailure(tool.input, stepSettlement?.finish === "length" ? "length" : reason))

  // 刷新（flush）：结束所有分片，并把畸形未结算的入参按失败处理
  const flush = Effect.fn("SessionRunner.flush")(function* () {
    // 先结束所有分片
    yield* flushFragments()
    // The finish reason distinguishes invalid JSON from arguments cut off by the output limit.
    // 结束原因可区分「JSON 非法」与「参数被输出上限截断」
    for (const [id, tool] of tools) {
      // 非畸形或已结算的工具跳过
      if (!tool.malformed || tool.settled) continue
      // 按畸形原因发布工具失败
      yield* failToolInput(id, tool, "malformed")
    }
  })

  // 使单个工具以错误结算：发布 Tool.Failed（可附进度元数据）
  const failTool = Effect.fnUntraced(function* (id: string, error: SessionError.Error, metadata?: Tool.Metadata) {
    // 工具不存在或已结算则无事可做
    const tool = tools.get(id)
    if (!tool || tool.settled) return false
    // 同步标记结算（检查与标记间无 yield）
    tool.settled = true
    // 发布工具失败事件；子代理被中止时补充其会话 ID 便于追踪
    yield* bus.publish(SessionEvent.Tool.Failed, {
      sessionID: input.sessionID,
      assistantMessageID,
      id,
      error:
        tool.name === "subagent" && error.type === "aborted" && typeof tool.progress?.sessionID === "string"
          ? { ...error, message: `${error.message} (sessionID: ${tool.progress.sessionID})` }
          : error,
      // 附带失败时的进度快照
      ...failureSnapshot(tool, metadata),
      // 是否由提供方执行
      executed: tool.providerExecuted,
    })
    // 表示确实失败了一个工具
    return true
  })

  // 批量失败工具：mode 选择范围（全部 / 仅提供方托管 / 仅未调用的）
  const failTools = Effect.fnUntraced(function* (error: SessionError.Error, mode: "all" | "hosted" | "uncalled") {
    // 是否至少失败了一个
    let failed = false
    for (const [id, tool] of tools) {
      // 已结算或不属于所选范围的工具跳过
      if (tool.settled || (mode === "hosted" && !tool.providerExecuted) || (mode === "uncalled" && tool.called))
        continue
      // 失败该工具并记录
      if (yield* failTool(id, error)) failed = true
    }
    return failed
  })

  // 使所有已登记但从未调用的工具以「参数未完成」失败
  const failIncompleteTools = Effect.fn("SessionRunner.failIncompleteTools")(function* () {
    for (const [id, tool] of tools) {
      // 已调用或已结算的跳过
      if (tool.called || tool.settled) continue
      // 以 incomplete 原因失败
      yield* failToolInput(id, tool, "incomplete")
    }
  })

  // 助手失败：刷新分片 → 失败未调用工具 → 确保步骤开始 → 记录步骤失败
  const failAssistant = Effect.fnUntraced(function* (error: SessionError.Error) {
    // 先把流式内容收尾
    yield* flush()
    // 未调用的工具以该错误失败
    yield* failTools(error, "uncalled")
    // 确保步骤已开始（失败事件需要挂在消息上）
    yield* startAssistant()
    // 只记录第一次失败
    if (stepFailure === undefined) stepFailure = error
  })

  // 发布 Step.Failed（存在失败时）；可附加费用/用量/快照/文件明细
  const publishStepFailure = Effect.fnUntraced(function* (details?: {
    readonly cost?: Money.USD
    readonly tokens?: TokenUsage.Info
    readonly snapshot?: Snapshot.ID
    readonly files?: readonly RelativePath[]
  }) {
    // 没有记录失败则不发布
    if (stepFailure === undefined) return
    // 确保助手步骤已开始
    const assistantMessageID = yield* startAssistant()
    // 发布步骤失败事件：内容过滤时带上 finish 标记
    yield* bus.publish(SessionEvent.Step.Failed, {
      sessionID: input.sessionID,
      assistantMessageID,
      error: stepFailure,
      finish: stepSettlement?.finish === "content-filter" ? stepSettlement.finish : undefined,
      rawFinish: stepSettlement?.rawFinish,
      native: stepSettlement?.native,
      ...details,
    })
  })

  // 失败所有未结算工具的对外入口（默认全部）
  const failUnsettledTools = Effect.fn("SessionRunner.failUnsettledTools")(
    (error: SessionError.Error, scope: "hosted" | "all" | "uncalled" = "all") => failTools(error, scope),
  )

  // 发布（publish）一个 LLM 事件：按事件类型转换成会话事件（不可中断）
  const publish = Effect.fnUntraced(function* (event: LLMEvent) {
    // 按事件类型分发
    switch (event.type) {
      // 步骤开始
      case "step-start":
        yield* startAssistant()
        return
      // 文本块开始
      case "text-start":
        // 标记已产生可见输出
        outputStarted = true
        // 打开文本分片
        const startedTextOrdinal = yield* text.start(event.id, native(event.providerMetadata))
        // 先发布滞留增量保持顺序
        yield* publishPendingDeltas()
        // 发布 Text.Started
        yield* bus.publish(SessionEvent.Text.Started, {
          sessionID: input.sessionID,
          assistantMessageID: yield* startAssistant(),
          ordinal: startedTextOrdinal,
        })
        return
      // 文本增量
      case "text-delta":
        yield* text.append(event.id, event.text, native(event.providerMetadata))
        return
      // 文本块结束
      case "text-end":
        yield* text.end(event.id, native(event.providerMetadata), event.text)
        return
      // 推理块开始
      case "reasoning-start":
        // 标记已产生可见输出
        outputStarted = true
        // 打开推理分片
        const startedReasoningOrdinal = yield* reasoning.start(event.id, native(event.providerMetadata))
        // 先发布滞留增量保持顺序
        yield* publishPendingDeltas()
        // 发布 Reasoning.Started
        yield* bus.publish(SessionEvent.Reasoning.Started, {
          sessionID: input.sessionID,
          assistantMessageID: yield* startAssistant(),
          ordinal: startedReasoningOrdinal,
          native: native(event.providerMetadata),
        })
        return
      // 推理增量
      case "reasoning-delta":
        yield* reasoning.append(event.id, event.text, native(event.providerMetadata))
        return
      // 推理块结束
      case "reasoning-end":
        yield* reasoning.end(event.id, native(event.providerMetadata), event.text)
        return
      // 工具入参开始
      case "tool-input-start":
        // 标记已产生可见输出
        outputStarted = true
        yield* startToolInput(event)
        return
      // 工具入参增量
      case "tool-input-delta": {
        // 工具状态不存在
        const tool = tools.get(event.id)
        if (!tool) return yield* Effect.die(new Error(`Tool input delta before start: ${event.id}`))
        // 工具名与开始时不一致
        if (tool.name !== event.name)
          return yield* Effect.die(new Error(`Tool input name changed for ${event.id}: ${tool.name} -> ${event.name}`))
        // 分片已结束后再来增量
        if (!toolInput.has(event.id)) return yield* Effect.die(new Error(`Tool input delta after end: ${event.id}`))
        // 追加入参文本
        yield* toolInput.append(event.id, event.text)
        return
      }
      // 工具入参结束
      case "tool-input-end":
        yield* endToolInput(event)
        return
      // 工具入参解析错误
      case "tool-input-error":
        // 标记已产生可见输出
        outputStarted = true
        // 按畸形入参处理
        yield* failMalformedToolInput(event)
        return
      // 工具调用确认
      case "tool-call": {
        // 标记已产生可见输出
        outputStarted = true
        // 状态缺失时补开始流程
        const tool = tools.get(event.id) ?? (yield* startToolInput(event))
        // 入参分片还开着就结束它
        if (toolInput.has(event.id)) yield* endToolInput(event)
        // 工具名不一致
        if (tool.name !== event.name)
          return yield* Effect.die(new Error(`Tool call name changed for ${event.id}: ${tool.name} -> ${event.name}`))
        // 重复调用
        if (tool.called) return yield* Effect.die(new Error(`Duplicate tool call: ${event.id}`))
        // 同步标记调用与执行方式
        tool.called = true
        tool.providerExecuted = event.providerExecuted === true
        // 发布 Tool.Called
        yield* bus.publish(SessionEvent.Tool.Called, {
          sessionID: input.sessionID,
          assistantMessageID,
          id: event.id,
          input: asRecord(event.input),
          executed: tool.providerExecuted,
          native: native(event.providerMetadata),
        })
        return
      }
      // 提供方托管的工具结果
      case "tool-result": {
        // Provider-hosted results only; local executions publish through `toolExecution`.
        // 仅限提供方托管的结果；本地执行通过 toolExecution 发布
        const tool = tools.get(event.id)
        // 结果先于调用
        if (!tool?.called) return yield* Effect.die(new Error(`Tool result before call: ${event.id}`))
        // 工具名不一致
        if (tool.name !== event.name)
          return yield* Effect.die(new Error(`Tool result name changed for ${event.id}: ${tool.name} -> ${event.name}`))
        // 已结算时的迟到结果
        if (tool.settled) {
          // A late error result is a benign straggler (e.g. after an abort
          // sweep); a late success would mean double execution, so it dies.
          // 迟到的错误结果是良性掉队者（如中止清扫之后）；迟到的成功意味着重复执行，必须终止
          if (event.result.type === "error") return
          return yield* Effect.die(new Error(`Duplicate tool result: ${event.id}`))
        }
        // 同步标记结算
        tool.settled = true
        // 执行方式：事件或状态任一标记托管即为托管
        const executed = event.providerExecuted === true || tool.providerExecuted
        // 错误结果：发布 Tool.Failed
        if (event.result.type === "error") {
          yield* bus.publish(SessionEvent.Tool.Failed, {
            sessionID: input.sessionID,
            assistantMessageID,
            id: event.id,
            error: { type: "tool.execution", message: stringify(event.result.value) },
            ...failureSnapshot(tool),
            executed,
            native: native(event.providerMetadata),
          })
          return
        }
        // 成功结果：发布 Tool.Success（内容来自托管结果）
        yield* bus.publish(SessionEvent.Tool.Success, {
          sessionID: input.sessionID,
          assistantMessageID,
          id: event.id,
          content: hostedContent(event.result),
          executed,
          native: native(event.providerMetadata),
        })
        return
      }
      // 步骤结束
      case "step-finish":
        // 先收尾所有分片
        yield* flushFragments()
        // 重复的步骤结束属致命错误
        if (stepSettlement) return yield* Effect.die(new Error("Duplicate step finish"))
        // 记录步骤的结束信息
        stepSettlement = {
          finish: event.reason.normalized,
          rawFinish: event.reason.raw,
          native: native(event.providerMetadata),
          usage: event.usage,
        }
        // 内容过滤：标记提供方失败并把助手置为失败
        if (event.reason.normalized === "content-filter") {
          providerFailed = true
          yield* failAssistant(contentFilterError("Provider blocked the response", event.reason))
          return
        }
        return
      // 整体结束（无需处理）
      case "finish":
        return
    }
  }, Effect.uninterruptible)

  // 工具执行进度更新：仅在调用进行中有效
  const progress = Effect.fnUntraced(function* (id: string, update: Tool.Metadata) {
    // 工具未调用或已结算时更新进度属致命错误
    const tool = tools.get(id)
    if (!tool?.called || tool.settled) return yield* Effect.die(new Error(`Tool progress outside running call: ${id}`))
    // 记录最新进度
    tool.progress = update
    // 发布 Tool.Progress
    yield* bus.publish(SessionEvent.Tool.Progress, {
      sessionID: input.sessionID,
      assistantMessageID,
      id,
      metadata: update,
    })
  })

  /** Publishes one canonical terminal event for a locally executed tool call. */
  // 为本地执行的工具调用发布唯一的终态事件（Tool.Success）
  const toolExecution = Effect.fnUntraced(function* (id: string, name: string, result: Tool.NormalizedResult) {
    // 工具状态缺失或未调用
    const tool = tools.get(id)
    if (!tool?.called) return yield* Effect.die(new Error(`Tool execution before call: ${id}`))
    // 工具名不一致
    if (tool.name !== name)
      return yield* Effect.die(new Error(`Tool execution name changed for ${id}: ${tool.name} -> ${name}`))
    // 重复执行
    if (tool.settled) return yield* Effect.die(new Error(`Duplicate tool execution: ${id}`))
    // 同步标记结算
    tool.settled = true
    // 结果内容必须非空
    const content = result.content
    if (!isReadonlyArrayNonEmpty(content)) return yield* Effect.die(new Error(`Tool execution has no content: ${id}`))
    // 发布工具成功事件（可选元数据）
    yield* bus.publish(SessionEvent.Tool.Success, {
      sessionID: input.sessionID,
      assistantMessageID,
      id,
      content,
      ...(result.metadata === undefined ? {} : { metadata: result.metadata }),
      executed: tool.providerExecuted,
    })
  })

  // 对外暴露的发布器接口
  return {
    // 发布一个 LLM 事件
    publish: (event: LLMEvent): Effect.Effect<void> => publish(event),
    // 工具进度更新
    progress,
    // 本地工具执行的终态发布
    toolExecution,
    // 刷新分片与畸形入参
    flush,
    // 助手失败处理
    failAssistant,
    // 单工具失败
    failTool,
    // 发布步骤失败事件
    publishStepFailure,
    // 失败未结算工具
    failUnsettledTools,
    // 失败未完成入参的工具
    failIncompleteTools,
    // 步骤是否已开始
    hasStarted: () => stepStarted,
    /** Immutable snapshot of everything recorded for this step so far. */
    // 迄今为止本步骤所有记录的不可变快照
    record: (): StepRecord => ({
      outputStarted,
      providerFailed,
      failure: stepFailure,
      finish: stepSettlement,
      // 存在本地执行（非托管）的工具调用时需要续写
      needsContinuation: Iterable.some(
        tools.values(),
        (tool) => !tool.providerExecuted && (tool.called || tool.settled),
      ),
    }),
    // 启动助手步骤
    startAssistant,
    // 发布流式标记
    streamed,
  }
}

// 生成有界入参摘录：截断到上限并保留原始长度
function inputExcerpt(value: string): InputExcerpt {
  return { text: value.slice(0, INPUT_EXCERPT_LIMIT), length: value.length }
}

// 按失败原因构造工具入参错误；有摘录时把截断提示附在消息里
function inputFailure(input: InputExcerpt | undefined, reason: InputFailureReason) {
  // 取该原因的错误定义
  const failure = INPUT_FAILURES[reason]
  // 没有摘录则返回基础错误
  if (!input?.length) return failure
  // 被截断时附加截断标记
  const truncated = input.length > input.text.length ? "\n[truncated]" : ""
  // 返回带摘录的错误
  return {
    ...failure,
    message: `${failure.message}\n\nInput excerpt (first ${input.text.length} of ${input.length} characters):\n${input.text}${truncated}`,
  }
}
