// 将本模块以命名空间 Job 的形式整体再导出
export * as Job from "./job.js"

// 从 drizzle-orm 引入查询辅助：asc(升序)、eq(等于)、or(或条件)
import { asc, eq, or } from "drizzle-orm"
import {
  Array,
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Layer,
  Ref,
  Schema,
  Scope,
  SynchronizedRef,
} from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
// 引入数据库服务
import { Database } from "./database/database.js"
// 引入任务列表（JobList）读取工具
import { JobList } from "./job/list.js"
// 引入恢复（Recovery）类型与其模式定义
import { type Recovery, RecoverySchema } from "./job/recovery.js"
// 引入任务表（JobTable）定义
import { JobTable } from "./job/sql.js"
// 引入会话消息 ID 类型
import { SessionMessage } from "./session/message.js"
// 引入会话模式（含 ID 类型）
import { SessionSchema } from "./session/schema.js"

// 再导出 Recovery 类型
export type { Recovery }

// 后台任务（Background）模式：持久化后台任务的结构定义
const Background = Schema.Struct({
  // 任务 ID
  id: Schema.String,
  // 关联的通知 ID（完成后用于匹配通知）
  notificationID: SessionMessage.ID,
  // 恢复信息（用于重启后恢复任务）
  recovery: RecoverySchema,
  // 状态：运行中/已完成/出错/已取消
  status: Schema.Literals(["running", "completed", "error", "cancelled"]),
  // 可选的输出文本
  output: Schema.optionalKey(Schema.String),
  // 可选的错误文本
  error: Schema.optionalKey(Schema.String),
})

// 导出后台任务的静态类型与状态类型别名
export type Background = typeof Background.Type
export type Status = Background["status"]

export type SubagentReportState =
  | {
      readonly mode: "background"
      readonly notificationID: SessionMessage.ID
      readonly recovery: Extract<Recovery, { kind: "subagent" }>
      readonly startedAt: number
    }
  | { readonly mode: "none" }

export type SubagentOutboxReport = {
  readonly notificationID: SessionMessage.ID
  readonly recovery: Extract<Recovery, { kind: "subagent" }>
  readonly status: Exclude<Status, "running">
  readonly output?: string
  readonly error?: string
  readonly startedAt?: number
}

const decodeBackground = Schema.decodeUnknownResult(Background)
// 已完成任务在内存中的保留上限：25 条
const COMPLETED_LIMIT = 25

// 任务信息（Info）：对外暴露的任务快照结构
export type Info = {
  id: string
  type: string
  title?: string
  status: Status
  started_at: number
  completed_at?: number
  output?: string
  error?: string
  metadata?: Record<string, unknown>
  notificationID?: SessionMessage.ID
}

// 进程内活跃任务记录：info 之外还有完成信号、后台信号、作用域、阻塞会话计数等
type Active = {
  info: Info
  done: Deferred.Deferred<Info>
  backgrounded: Deferred.Deferred<Info>
  scope: Scope.Closeable
  generation: number
  blockingSessions: Map<SessionSchema.ID, number>
  isBackgrounded: boolean
  settling: boolean
  consumed: boolean
  reported: boolean
  cancelledByCaller: boolean
  recovery?: Recovery
  cancel?: Effect.Effect<void>
}

// 服务内部状态：任务表（SynchronizedRef 保证并发安全）与所有者作用域
type State = {
  jobs: SynchronizedRef.SynchronizedRef<Map<string, Active>>
  generations: Ref.Ref<number>
  scope: Scope.Scope
}

// finish 类操作的返回：任务快照、完成信号、要关闭的作用域与代际
type FinishResult = {
  info?: Info
  done?: Deferred.Deferred<Info>
  cancel?: Effect.Effect<void>
  scope?: Scope.Closeable
  generation?: Scope.Closeable
}

// 后台化操作的返回：任务快照与后台信号
type BackgroundResult = {
  info?: Info
  backgrounded?: Deferred.Deferred<Info>
}

type StartResult = { info: Info } | { info: Info; job: Active }

// 阻塞等待所需的一组句柄：完成信号、后台信号与代际作用域
type BlockWait = {
  done: Deferred.Deferred<Info>
  backgrounded: Deferred.Deferred<Info>
  generation: Scope.Closeable
}

// block 的四种起始状态：任务不存在/已完成/已后台化/需要等待
type BlockStart =
  | { type: "missing" }
  | { type: "finished"; info: Info; generation: Scope.Closeable }
  | { type: "backgrounded"; info: Info }
  | { type: "wait"; wait: BlockWait }

// 启动任务的输入：ID、类型、标题、元数据、恢复信息、通知 ID 与实际运行的效果
export type StartInput = {
  id: string
  type: string
  title?: string
  metadata?: Record<string, unknown>
  recovery?: Recovery
  notificationID?: SessionMessage.ID
  background?: boolean
  run: Effect.Effect<string, unknown>
  // Runs when the job is cancelled (`cancel`, `cancelSession`), before its work is interrupted. Teardown, such as
  // a server shutdown, interrupts the work without it.
  cancel?: Effect.Effect<void>
}

// 等待任务的输入：任务 ID 与可选超时毫秒数
export type WaitInput = {
  id: string
  timeout?: number
}

// 等待结果：任务快照（可能为空）与是否超时
export type WaitResult = {
  info?: Info
  timedOut: boolean
}

// 阻塞（block）输入：任务 ID 与发起阻塞的会话 ID
export type BlockInput = {
  id: string
  sessionID: SessionSchema.ID
}

// 阻塞结果：任务最终完成或被后台化
export type BlockResult = { type: "finished"; info: Info } | { type: "backgrounded"; info: Info }

// 批量后台化的输入：会话 ID 与可选的任务类型过滤
export type BackgroundAllInput = {
  sessionID: SessionSchema.ID
  type?: string
}

// 任务服务接口：查询、启动、等待、阻塞、后台化、取消、后台队列管理等
export interface Interface {
  readonly get: (id: string) => Effect.Effect<Info | undefined>
  readonly start: (input: StartInput) => Effect.Effect<Info>
  readonly wait: (input: WaitInput) => Effect.Effect<WaitResult>
  readonly block: (input: BlockInput) => Effect.Effect<BlockResult | undefined>
  readonly background: (id: string) => Effect.Effect<Info | undefined>
  readonly backgroundAll: (input: BackgroundAllInput) => Effect.Effect<Info[]>
  readonly cancel: (id: string) => Effect.Effect<Info | undefined>
  readonly cancelSession: (sessionID: SessionSchema.ID) => Effect.Effect<Info[]>
  readonly pendingBackground: Effect.Effect<readonly Background[]>
  readonly runningBackground: Effect.Effect<readonly Recovery[]>
  readonly backgroundJobs: Effect.Effect<readonly JobList.Item[]>
  readonly completeBackground: (notificationID: SessionMessage.ID) => Effect.Effect<void>
  /** Whether an explicit caller cancellation stopped this job (not shutdown teardown). */
  readonly isCancelled: (id: string) => Effect.Effect<boolean>
  readonly currentGeneration: (
    id: string,
  ) => Effect.Effect<{ readonly generation: number; readonly running: boolean } | undefined>
  readonly prepareSubagentReport: (id: string, boundGeneration?: number) => Effect.Effect<SubagentReportState>
  readonly recordSubagentReport: (report: SubagentOutboxReport) => Effect.Effect<void>
  readonly deleteBackgroundRow: (notificationID: SessionMessage.ID) => Effect.Effect<void>
}

// 定义 Job 服务类：标识为 "@opencode/Job" 的上下文服务
export class Service extends Context.Service<Service, Interface>()("@opencode/Job") {}

// snapshot：生成任务信息快照（深拷贝 metadata，避免外部改动内部状态）
function snapshot(job: Active): Info {
  return {
    ...job.info,
    ...(job.info.metadata ? { metadata: { ...job.info.metadata } } : {}),
  }
}

// ownerSessionID：恢复信息的属主会话——子代理任务属主是父会话，其余是任务自身会话
function ownerSessionID(recovery: Recovery): SessionSchema.ID {
  return recovery.kind === "subagent" ? recovery.parentSessionID : recovery.sessionID
}

// recoveryTitle：恢复记录的标题——优先用任务标题，其次按恢复类型取命令/描述/路径
function recoveryTitle(job: Active, recovery: Recovery): string | null {
  if (job.info.title !== undefined) return job.info.title
  if (recovery.kind === "shell") return recovery.command
  if (recovery.kind === "subagent") return recovery.description
  return recovery.path
}

// matchesSession：判断任务是否与某会话相关（元数据、阻塞者或恢复信息的任一关联会话）
function matchesSession(job: Active, sessionID: SessionSchema.ID) {
  if (job.info.metadata?.sessionID === sessionID) return true
  if (job.blockingSessions.has(sessionID)) return true
  if (!job.recovery) return false
  if (job.recovery.kind === "subagent")
    return job.recovery.parentSessionID === sessionID || job.recovery.childSessionID === sessionID
  return job.recovery.sessionID === sessionID
}

// errorText：把 Effect 的 Cause 渲染成多行错误文本（递归拼接 “Caused by:” 链）
function errorText(cause: Cause.Cause<unknown>) {
  const render = (error: Error): string => {
    // 先取 message，缺失时退回错误名，再退回 “Unknown error”
    const message = error.message || error.name || "Unknown error"
    // 没有底层原因就直接用该行消息
    if (!(error.cause instanceof Error)) return message
    // 递归渲染底层原因
    const detail = render(error.cause)
    // 底层详情与当前消息相同或已包含时不再重复
    return detail === message || detail.startsWith(`${message}\n`) ? detail : `${message}\nCaused by: ${detail}`
  }
  // 渲染所有 pretty 错误并按行拼接；没有内容时给 “Unknown error”
  return Cause.prettyErrors(cause).map(render).join("\n") || "Unknown error"
}

// incrementSession：返回一个新 Map，指定会话的阻塞计数加一（不可变更新）
function incrementSession(input: Map<SessionSchema.ID, number>, sessionID: SessionSchema.ID) {
  return new Map(input).set(sessionID, (input.get(sessionID) ?? 0) + 1)
}

// decrementSession：返回一个新 Map，指定会话的阻塞计数减一，减到 0 就删除该键
function decrementSession(input: Map<SessionSchema.ID, number>, sessionID: SessionSchema.ID) {
  const count = input.get(sessionID)
  // 没有计数则原样返回
  if (count === undefined) return input
  const next = new Map(input)
  // 计数不大于 1 时直接删除，否则减一
  if (count <= 1) next.delete(sessionID)
  else next.set(sessionID, count - 1)
  return next
}

/**
 * Makes one scoped, process-local registry backed by the durable SQLite `job` table for
 * backgrounded work until its completion notification is admitted.
 */
// make：创建一个带作用域的进程内任务注册表，并以 SQLite job 表持久化后台任务直到其完成通知被确认
export const make = Effect.gen(function* () {
  // 获取底层数据库实例
  const db = (yield* Database.Service).db
  // 初始化内部状态：空任务表与所有者作用域
  const state: State = {
    jobs: yield* SynchronizedRef.make(new Map()),
    generations: yield* Ref.make(0),
    scope: yield* Scope.Scope,
  }

  // consume：标记任务为“已被消费”，并按上限清理历史完成任务
  const consume = (id: string, generation: Scope.Closeable) =>
    SynchronizedRef.update(state.jobs, (jobs) => {
      const job = jobs.get(id)
      // 任务不存在、代际不符、仍在运行或已被消费过：原样返回
      if (!job || job.scope !== generation || job.info.status === "running" || job.consumed) return jobs
      const next = new Map(jobs)
      // Order history by first consumption, not by start time or subsequent reads.
      // 先删除再插入，让“首次消费”的顺序成为历史排序依据
      next.delete(id)
      next.set(id, { ...job, consumed: true })
      // 找出已消费且没有通知 ID 的完成任务，作为可清理的历史
      const completed = [...next].filter(([, job]) => job.consumed && !job.info.notificationID)
      // 只保留最近 COMPLETED_LIMIT 条，其余删除
      for (const [id] of completed.slice(0, -COMPLETED_LIMIT)) next.delete(id)
      return next
    })

  // persistBackground：把后台任务写入 SQLite（upsert，以通知 ID 为冲突目标）
  const persistBackground = Effect.fnUntraced(function* (job: Active) {
    // 没有恢复信息或通知 ID 的任务不持久化
    if (!job.recovery || !job.info.notificationID) return
    // 取当前时间作为更新时间
    const now = yield* Clock.currentTimeMillis
    // 组装要写入的行数据
    const values = {
      notification_id: job.info.notificationID,
      id: job.info.id,
      session_id: ownerSessionID(job.recovery),
      child_session_id: job.recovery.kind === "subagent" ? job.recovery.childSessionID : null,
      kind: job.recovery.kind,
      title: recoveryTitle(job, job.recovery),
      status: job.info.status,
      output: job.info.output ?? null,
      error: job.info.error ?? null,
      recovery: job.recovery,
      time_created: job.info.started_at,
      time_updated: now,
    }
    // 插入或按通知 ID 更新（只刷新状态/输出/错误/恢复信息/更新时间）
    yield* db
      .insert(JobTable)
      .values(values)
      .onConflictDoUpdate({
        target: JobTable.notification_id,
        set: {
          status: values.status,
          output: values.output,
          error: values.error,
          recovery: values.recovery,
          time_updated: now,
        },
      })
      .run()
      .pipe(Effect.orDie)
  })

  const settle = Effect.fnUntraced(function* (id: string, active: Active, exit: Exit.Exit<string, unknown>) {
    const completed_at = yield* Clock.currentTimeMillis
    const status: Exclude<Status, "running"> = Exit.isSuccess(exit)
      ? "completed"
      : Cause.hasInterruptsOnly(exit.cause)
        ? "cancelled"
        : "error"
    const output = Exit.isSuccess(exit) ? exit.value : undefined
    const error = Exit.isFailure(exit) ? errorText(exit.cause) : undefined
    const terminal = (job: Active): Active => ({
      ...job,
      blockingSessions: new Map<SessionSchema.ID, number>(),
      info: {
        ...job.info,
        status,
        completed_at,
        ...(output !== undefined ? { output } : {}),
        ...(error !== undefined ? { error } : {}),
      },
    })
    const result = yield* SynchronizedRef.modifyEffect(
      state.jobs,
      Effect.fnUntraced(function* (jobs): Effect.fn.Return<readonly [FinishResult, Map<string, Active>]> {
        const job = jobs.get(id)
        // Teardown (this registry closing) is not a terminal outcome: leave the job and its durable row running for
        // the next server. The scope's own finalizer interrupts its observers. A cancel has already settled the job
        // as cancelled before interrupting its work.
        if (status === "cancelled" && active.scope.state._tag === "Closed") return [{}, jobs]
        // A newer generation may already have replaced this one in the registry. Its waiters still
        // need their deferred resolved and its scope closed, so never drop the settlement on the floor.
        if (!job || job.scope !== active.scope) {
          return [{ info: snapshot(terminal(active)), done: active.done, scope: active.scope }, jobs]
        }
        if (job.info.status !== "running") return [{ info: snapshot(job) }, jobs]
        const next = terminal(job)
        if (job.consumed) {
          const remaining = new Map(jobs)
          remaining.delete(id)
          return [{ info: snapshot(next), done: job.done, scope: job.scope }, remaining]
        }
        // A consumed job's notification row is gone; persisting here would resurrect it.
        // A settling generation's row belongs to the settlement commit; leaving it alone keeps
        // conflict-retained markers and late settlements consistent.
        if (status !== "cancelled" && !job.settling && !job.consumed) yield* persistBackground(next)
        return [{ info: snapshot(next), done: job.done, scope: job.scope }, new Map(jobs).set(id, next)]
      }),
    )
    // 有完成信号则通知所有等待者
    if (result.info && result.done) yield* Deferred.succeed(result.done, result.info)
    // 有作用域则fork到所有者作用域中异步关闭（避免阻塞结算）
    if (result.scope) {
      yield* Scope.close(result.scope, Exit.void).pipe(Effect.forkIn(state.scope, { startImmediately: true }))
    }
    // 返回任务快照
    return result.info
  })

  // get：按 ID 查询任务快照
  const get: Interface["get"] = Effect.fn("Job.get")(function* (id) {
    const job = (yield* SynchronizedRef.get(state.jobs)).get(id)
    // 不存在返回 undefined
    if (!job) return undefined
    // 返回快照
    return snapshot(job)
  })

  // start：启动任务；同 ID 任务已在运行时直接返回其快照（幂等）
  const start: Interface["start"] = Effect.fnUntraced(function* (input) {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        // 记录开始时间
        const started_at = yield* Clock.currentTimeMillis
        // 创建完成信号与后台化信号
        const done = yield* Deferred.make<Info>()
        const backgrounded = yield* Deferred.make<Info>()
        // 原子地在任务表中注册新任务
        const result = yield* SynchronizedRef.modifyEffect(
          state.jobs,
          Effect.fnUntraced(function* (jobs): Effect.fn.Return<readonly [StartResult, Map<string, Active>]> {
            const existing = jobs.get(input.id)
            // A settling generation is already reporting; new work starts a fresh generation.
            if (existing?.info.status === "running" && !existing.settling) {
              return [{ info: snapshot(existing) }, jobs]
            }
            // 从所有者作用域并行 fork 出本任务的作用域
            const scope = yield* Scope.fork(state.scope, "parallel")
            // Closing the registry interrupts the work without settling it; interrupt its observers too.
            yield* Scope.addFinalizer(scope, Deferred.interrupt(done))
            const notificationID =
              input.notificationID ?? (input.background && input.recovery ? SessionMessage.ID.create() : undefined)
            const job: Active = {
              info: {
                id: input.id,
                type: input.type,
                title: input.title,
                status: "running" as const,
                started_at,
                metadata: input.metadata,
                ...(notificationID ? { notificationID } : {}),
              },
              done,
              backgrounded,
              scope,
              generation: yield* Ref.updateAndGet(state.generations, (generation) => generation + 1),
              blockingSessions: new Map<SessionSchema.ID, number>(),
              isBackgrounded: input.background === true,
              settling: false,
              consumed: false,
              reported: false,
              cancelledByCaller: false,
              recovery: input.recovery,
              cancel: input.cancel,
            }
            // Background work becomes durable before its run is forked, so no drain can observe
            // an unmarked period.
            if (job.isBackgrounded) yield* persistBackground(job)
            return [{ info: snapshot(job), job }, new Map(jobs).set(input.id, job)]
          }),
        )
        if ("job" in result)
          yield* restore(input.run).pipe(
            Effect.exit,
            Effect.flatMap((exit) => settle(input.id, result.job, exit)),
            Effect.asVoid,
            Effect.forkIn(result.job.scope, { startImmediately: true }),
          )
        // 返回任务快照
        return result.info
      }),
    )
  })

  // wait：等待任务完成；可带超时，且等待后按规则消费任务
  const wait: Interface["wait"] = Effect.fn("Job.wait")(function* (input) {
    // 查找任务
    const job = (yield* SynchronizedRef.get(state.jobs)).get(input.id)
    // 任务不存在：不算超时，直接返回
    if (!job) return { timedOut: false }
    return yield* Effect.gen(function* () {
      // 已结束：直接返回快照
      if (job.info.status !== "running") return { info: snapshot(job), timedOut: false }
      // 无超时：无限等待完成信号
      if (input.timeout === undefined) return { info: yield* Deferred.await(job.done), timedOut: false }
      // 超时值非正：立即按超时返回当前快照
      if (input.timeout <= 0) return { info: snapshot(job), timedOut: true }
      // 带超时等待完成信号
      const info = yield* Deferred.await(job.done).pipe(Effect.timeoutOption(input.timeout))
      // 拿到结果：未超时
      if (info._tag === "Some") return { info: info.value, timedOut: false }
      // 超时：返回当前快照
      return { info: snapshot(job), timedOut: true }
    }).pipe(
      // Recoverable wait -> background is a supported handoff, even after failure.
      // 等待成功且任务仍在运行或有恢复信息时是受支持的交接，不消费；否则消费该任务
      Effect.tap((result) =>
        result.info?.status === "running" || job.recovery ? Effect.void : consume(input.id, job.scope),
      ),
    )
  })

  // removeBlock：结束等待时移除会话的阻塞计数（保证兜底执行）
  const removeBlock = Effect.fnUntraced(function* (input: BlockInput) {
    yield* SynchronizedRef.update(state.jobs, (jobs) => {
      const job = jobs.get(input.id)
      // 任务不存在、已结束或已后台化：无需移除
      if (!job || job.info.status !== "running" || job.isBackgrounded) return jobs
      // 否则递减该会话的阻塞计数
      return new Map(jobs).set(input.id, {
        ...job,
        blockingSessions: decrementSession(job.blockingSessions, input.sessionID),
      })
    })
  })

  // block：会话阻塞等待任务——完成、后台化或一直等待，并维护阻塞计数
  const block: Interface["block"] = Effect.fnUntraced(function* (input) {
    // 原子地检查任务状态并登记阻塞
    const result = yield* SynchronizedRef.modify(state.jobs, (jobs): readonly [BlockStart, Map<string, Active>] => {
      const job = jobs.get(input.id)
      // 任务不存在
      if (!job) return [{ type: "missing" }, jobs]
      // 已结束：直接给快照与代际
      if (job.info.status !== "running") return [{ type: "finished", info: snapshot(job), generation: job.scope }, jobs]
      // 已后台化：返回当前快照
      if (job.isBackgrounded) return [{ type: "backgrounded", info: snapshot(job) }, jobs]
      // 仍在运行：登记阻塞计数并返回等待句柄
      return [
        { type: "wait", wait: { done: job.done, backgrounded: job.backgrounded, generation: job.scope } },
        new Map(jobs).set(input.id, {
          ...job,
          blockingSessions: incrementSession(job.blockingSessions, input.sessionID),
        }),
      ]
    })
    // 任务不存在：返回 undefined
    if (result.type === "missing") return undefined
    // 已完成：先消费再返回结果
    if (result.type === "finished") {
      yield* consume(input.id, result.generation)
      return { type: "finished", info: result.info }
    }
    // 已后台化：直接返回
    if (result.type === "backgrounded") return { type: "backgrounded", info: result.info }
    // 等待场景：竞速“完成”与“后台化”两个信号，任一先到即返回
    return yield* Effect.raceFirst(
      Deferred.await(result.wait.done).pipe(Effect.map((info) => ({ type: "finished" as const, info }))),
      Deferred.await(result.wait.backgrounded).pipe(Effect.map((info) => ({ type: "backgrounded" as const, info }))),
    ).pipe(
      // 完成时消费任务（后台化则不消费，由后台队列接管）
      Effect.tap((outcome) => (outcome.type === "finished" ? consume(input.id, result.wait.generation) : Effect.void)),
      // 无论结果如何都移除阻塞计数
      Effect.ensuring(removeBlock(input)),
    )
  })

  // markBackground：把任务标记为后台化，并分配通知 ID 后持久化
  const markBackground = Effect.fnUntraced(function* (job: Active) {
    const next = {
      ...job,
      // 置后台标志
      isBackgrounded: true,
      // 清空阻塞会话计数
      blockingSessions: new Map<SessionSchema.ID, number>(),
      info: {
        ...job.info,
        // 有恢复信息的任务补充通知 ID（用于完成后匹配通知）
        ...(job.recovery ? { notificationID: job.info.notificationID ?? SessionMessage.ID.create() } : {}),
      },
    }
    // 持久化到 SQLite
    yield* persistBackground(next)
    // 返回更新后的记录
    return next
  })

  // background：把单个任务转为后台（可对可恢复的已结束任务补登记）
  const background: Interface["background"] = Effect.fn("Job.background")(function* (id) {
    const result = yield* SynchronizedRef.modifyEffect(
      state.jobs,
      Effect.fnUntraced(function* (jobs): Effect.fn.Return<readonly [BackgroundResult, Map<string, Active>]> {
        const job = jobs.get(id)
        // Recoverable work may finish before the caller backgrounds it.
        // 任务不存在，或已结束且不可恢复：无操作
        if (!job || (job.info.status !== "running" && !job.recovery)) return [{}, jobs]
        // 已后台化：仅返回快照
        if (job.isBackgrounded) return [{ info: snapshot(job) }, jobs]
        // 执行后台化标记并持久化
        const next = yield* markBackground(job)
        // 返回快照与后台信号，并更新任务表
        return [{ info: snapshot(next), backgrounded: job.backgrounded }, new Map(jobs).set(id, next)]
      }),
    )
    // 通知所有等待“后台化”信号的阻塞者
    if (result.info && result.backgrounded) yield* Deferred.succeed(result.backgrounded, result.info)
    // 返回快照
    return result.info
  })

  // backgroundAll：把某会话阻塞的一批任务全部转为后台
  const backgroundAll: Interface["backgroundAll"] = Effect.fn("Job.backgroundAll")(function* (input) {
    const result = yield* SynchronizedRef.modifyEffect(
      state.jobs,
      Effect.fnUntraced(function* (jobs): Effect.fn.Return<
        readonly [Required<BackgroundResult>[], Map<string, Active>]
      > {
        // 收集本轮后台化的结果
        const results: Required<BackgroundResult>[] = []
        // 复制任务表，逐个更新
        const next = new Map(jobs)
        for (const [id, job] of jobs) {
          // 只处理运行中的任务
          if (job.info.status !== "running") continue
          // 已后台化的跳过
          if (job.isBackgrounded) continue
          // 指定了类型但任务类型不符的跳过
          if (input.type !== undefined && job.info.type !== input.type) continue
          // 不被该会话阻塞的任务跳过
          if (!job.blockingSessions.has(input.sessionID)) continue
          // 执行后台化标记
          const updated = yield* markBackground(job)
          // 记录结果并更新表
          results.push({ info: snapshot(updated), backgrounded: job.backgrounded })
          next.set(id, updated)
        }
        // 返回结果与更新后的表
        return [results, next]
      }),
    )
    // 逐个通知阻塞者“任务已后台化”
    yield* Effect.forEach(result, (item) => Deferred.succeed(item.backgrounded, item.info), { discard: true })
    // 返回所有被后台化任务的快照
    return result.map((item) => item.info)
  })

  // cancelInternal：取消任务的内部实现；persist 控制是否写入持久表
  const cancelInternal = Effect.fnUntraced(function* (id: string, persist = true) {
    // 记录完成时间
    const completed_at = yield* Clock.currentTimeMillis
    // 原子地把任务置为取消状态
    const result = yield* SynchronizedRef.modifyEffect(
      state.jobs,
      Effect.fnUntraced(function* (jobs): Effect.fn.Return<readonly [FinishResult, Map<string, Active>]> {
        const job = jobs.get(id)
        // 任务不存在：无操作
        if (!job) return [{}, jobs]
        // 已结束：只返回快照与代际（用于消费）
        if (job.info.status !== "running") return [{ info: snapshot(job), generation: job.scope }, jobs]
        // 构造取消状态的任务记录（清空阻塞会话）
        const next = {
          ...job,
          blockingSessions: new Map<SessionSchema.ID, number>(),
          cancelledByCaller: persist,
          info: {
            ...job.info,
            status: "cancelled" as const,
            completed_at,
          },
        }
        // Settling work owns its outbox row: the settlement commit writes or deletes it.
        if (persist && !job.settling) yield* persistBackground(next)
        return [
          { info: snapshot(next), done: job.done, scope: job.scope, generation: job.scope, cancel: job.cancel },
          new Map(jobs).set(id, next),
        ]
      }),
    )
    if (result.cancel) yield* result.cancel
    if (result.info && result.done) yield* Deferred.succeed(result.done, result.info)
    // 关闭任务作用域（终止运行中的效果）
    if (result.scope) yield* Scope.close(result.scope, Exit.void)
    // 按代际消费任务
    if (result.generation) yield* consume(id, result.generation)
    // 返回快照
    return result.info
  })

  // cancel：取消单个任务并持久化
  const cancel: Interface["cancel"] = Effect.fn("Job.cancel")((id) => cancelInternal(id, true))

  // cancelSession：取消某会话相关的所有任务，并清理其持久化记录
  const cancelSession: Interface["cancelSession"] = Effect.fn("Job.cancelSession")(function* (sessionID) {
    // 找出与该会话相关且仍在运行的任务 ID
    const ids = [...(yield* SynchronizedRef.get(state.jobs)).values()]
      .filter((job) => job.info.status === "running" && matchesSession(job, sessionID))
      .map((job) => job.info.id)
    // 逐个取消（不单独持久化，下面统一删表）
    const cancelled = yield* Effect.forEach(ids, (id) => cancelInternal(id, false))
    // 从持久表中删除该会话（含子会话）的所有任务行
    yield* db
      .delete(JobTable)
      .where(or(eq(JobTable.session_id, sessionID), eq(JobTable.child_session_id, sessionID)))
      .run()
      .pipe(Effect.orDie)
    // 从内存任务表中移除与该会话相关的所有任务
    yield* SynchronizedRef.update(state.jobs, (jobs) => {
      const next = new Map(jobs)
      for (const [id, job] of jobs) {
        if (matchesSession(job, sessionID)) next.delete(id)
      }
      return next
    })
    // 返回被取消任务的快照列表
    return cancelled.filter((info): info is Info => info !== undefined)
  })

  // pendingBackground：读取持久表中所有后台任务（按创建时间与通知 ID 升序）
  const pendingBackground: Interface["pendingBackground"] = Effect.gen(function* () {
    const rows = yield* db
      .select()
      .from(JobTable)
      .orderBy(asc(JobTable.time_created), asc(JobTable.notification_id))
      .all()
      .pipe(Effect.orDie)
    // 逐行解码为 Background；解码失败的行被过滤掉
    return Array.filterMap(rows, (row) =>
      decodeBackground({
        id: row.id,
        notificationID: row.notification_id,
        recovery: row.recovery,
        status: row.status,
        ...(row.output !== null ? { output: row.output } : {}),
        ...(row.error !== null ? { error: row.error } : {}),
      }),
    )
  }).pipe(Effect.withSpan("Job.pendingBackground"))

  // runningBackground：当前仍在运行且已后台化的任务的恢复信息列表
  const runningBackground: Interface["runningBackground"] = SynchronizedRef.get(state.jobs).pipe(
    Effect.map((jobs) =>
      [...jobs.values()].flatMap((job) =>
        job.isBackgrounded && job.info.status === "running" && !job.settling && !job.consumed && job.recovery
          ? [job.recovery]
          : [],
      ),
    ),
    Effect.withSpan("Job.runningBackground"),
  )

  // completeBackground：完成通知被确认后，删除持久行并清理内存记录
  const completeBackground: Interface["completeBackground"] = Effect.fn("Job.completeBackground")((notificationID) =>
    SynchronizedRef.updateEffect(state.jobs, (jobs) =>
      Effect.gen(function* () {
        // 先删除持久表中该通知对应的任务行
        yield* db.delete(JobTable).where(eq(JobTable.notification_id, notificationID)).run().pipe(Effect.orDie)
        // 在内存中查找匹配通知 ID 的任务
        const entry = [...jobs].find(([, job]) => job.info.notificationID === notificationID)
        if (!entry) return jobs
        // Still-running work keeps its entry, but must not persist its row again when it settles.
        if (entry[1].info.status === "running") return new Map(jobs).set(entry[0], { ...entry[1], consumed: true })
        const next = new Map(jobs)
        next.delete(entry[0])
        return next
      }),
    ),
  )

  const currentGeneration: Interface["currentGeneration"] = Effect.fn("Job.currentGeneration")(function* (id) {
    const job = (yield* SynchronizedRef.get(state.jobs)).get(id)
    if (!job) return undefined
    return { generation: job.generation, running: job.info.status === "running" && !job.settling }
  })

  const isCancelled: Interface["isCancelled"] = Effect.fn("Job.isCancelled")(function* (id) {
    return (yield* SynchronizedRef.get(state.jobs)).get(id)?.cancelledByCaller === true
  })

  const prepareSubagentReport: Interface["prepareSubagentReport"] = Effect.fn("Job.prepareSubagentReport")(
    function* (id, boundGeneration) {
      return yield* SynchronizedRef.modify(state.jobs, (jobs): readonly [SubagentReportState, Map<string, Active>] => {
        const job = jobs.get(id)
        // A generation reports at most once, even when an earlier attempt only observed a cancel.
        if (!job?.isBackgrounded || job.reported || !job.info.notificationID || job.recovery?.kind !== "subagent") {
          return [{ mode: "none" }, jobs]
        }
        const live = job.info.status === "running" && !job.settling
        // A cancel within this busy period already consumed the live entry, but it still belongs
        // here. A creation-tick interruption never bound a generation, so any cancel matches.
        const cancelled =
          job.info.status === "cancelled" && (boundGeneration === undefined || job.generation === boundGeneration)
        if (!live && !cancelled) return [{ mode: "none" }, jobs]
        const updated: Active = {
          ...job,
          reported: true,
          ...(job.info.status === "running" ? { settling: true } : {}),
        }
        const next = new Map(jobs).set(id, updated)
        return [
          {
            mode: "background",
            notificationID: job.info.notificationID,
            recovery: job.recovery,
            startedAt: job.info.started_at,
          },
          next,
        ]
      })
    },
  )

  // Called from inside Bus.publish's BEGIN IMMEDIATE commit callback: pure SQL only, never state.jobs.
  const recordSubagentReport: Interface["recordSubagentReport"] = Effect.fn("Job.recordSubagentReport")(
    function* (report) {
      const now = yield* Clock.currentTimeMillis
      yield* db
        .insert(JobTable)
        .values({
          notification_id: report.notificationID,
          id: report.recovery.childSessionID,
          session_id: report.recovery.parentSessionID,
          child_session_id: report.recovery.childSessionID,
          kind: "subagent",
          title: report.recovery.description,
          status: report.status,
          output: report.output ?? null,
          error: report.error ?? null,
          recovery: report.recovery,
          time_created: report.startedAt ?? now,
          time_updated: now,
        })
        .onConflictDoUpdate({
          target: JobTable.notification_id,
          set: {
            status: report.status,
            output: report.output ?? null,
            error: report.error ?? null,
            recovery: report.recovery,
            time_updated: now,
          },
        })
        .run()
        .pipe(Effect.orDie)
    },
  )

  const deleteBackgroundRow: Interface["deleteBackgroundRow"] = Effect.fn("Job.deleteBackgroundRow")((notificationID) =>
    db.delete(JobTable).where(eq(JobTable.notification_id, notificationID)).run().pipe(Effect.orDie, Effect.asVoid),
  )

  return Service.of({
    get,
    start,
    wait,
    block,
    background,
    backgroundAll,
    cancel,
    cancelSession,
    pendingBackground,
    runningBackground,
    backgroundJobs: JobList.read(db, state.jobs),
    completeBackground,
    isCancelled,
    currentGeneration,
    prepareSubagentReport,
    recordSubagentReport,
    deleteBackgroundRow,
  })
})

// 用 make 构建服务层
const layer = Layer.effect(Service, make)

// 导出全局节点：依赖数据库服务
export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
