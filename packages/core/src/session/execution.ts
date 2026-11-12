// 将本模块整体导出为 SessionExecution 命名空间
export * as SessionExecution from "./execution.js"

// 导入 effect 核心：Cause（错误因）、Context、Effect、Exit、Layer
import { Cause, Context, Effect, Exit, Layer } from "effect"
// 导入事件总线服务
import { Bus } from "../bus.js"
// 导入数据库服务
import { Database } from "../database/database.js"
// 导入任务系统服务
import { Job } from "../job.js"
// 导入实例服务
import { Instance } from "../instance/service.js"
// 导入全局依赖注入节点构造工具
import { makeGlobalNode } from "@opencode/util/effect/app-node"
// 导入会话事件定义
import { SessionEvent } from "./event.js"
import { SessionInbox } from "./inbox.js"
import { SubagentReport } from "./execution/subagent-report.js"
import { SessionRunCoordinator } from "./run-coordinator.js"
// 导入会话运行器
import { SessionRunner } from "./runner/index.js"
// 导入会话 schema 类型
import { SessionSchema } from "./schema.js"
// 导入会话存储服务
import { SessionStore } from "./store.js"
// 导入错误转换辅助（内部错误 → 会话错误）
import { toSessionError } from "./to-session-error.js"

// 服务接口：管理本进程拥有的会话执行
export interface Interface {
  /** Snapshots active execution owned by this process. */
  // 快照：本进程当前活跃执行的会话 ID 集合
  readonly active: Effect.Effect<ReadonlySet<SessionSchema.ID>>
  /** Checks process-local ownership, including interruption cleanup and terminal settlement. */
  // 检查进程内是否拥有该会话的执行（含中断清理与终结结算期间）
  readonly isActive: (sessionID: SessionSchema.ID) => Effect.Effect<boolean>
  /** Starts execution while idle or joins the active execution. */
  // 空闲时启动执行，活跃时加入现有执行
  readonly resume: (sessionID: SessionSchema.ID) => Effect.Effect<void, SessionRunner.RunError>
  /** Registers newly recorded work. Repeated wakeups may coalesce. */
  // 唤醒：登记新记录的工作；重复唤醒可能被合并
  readonly wake: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  /**
   * Interrupt active work owned by this process. Idle interruption is a no-op. Resolves once
   * the interruption is accepted; cleanup settles asynchronously in the execution fiber.
   * Returns whether an active execution was interrupted. Compose with `awaitIdle` when
   * settlement matters.
   */
  // 中断本进程拥有的活跃工作；空闲中断是空操作；中断被接受即返回（清理在执行 fiber 中异步结算）；返回是否真的中断了执行；需要等待结算时配合 awaitIdle 使用
  readonly interrupt: (
    sessionID: SessionSchema.ID,
    options?: {
      // 中断后是否恢复 steer 类输入的处理
      readonly resume?: boolean
    },
  ) => Effect.Effect<boolean>
  /** Resolves once this process owns no active execution for the Session. Returns immediately when idle and never starts work. */
  // 等待本进程不再拥有该会话的活跃执行；空闲时立即返回，且绝不启动新工作
  readonly awaitIdle: (sessionID: SessionSchema.ID) => Effect.Effect<void>
}

/** Routes execution from a Session ID to its selected instance's runner. */
// 服务标签：把会话 ID 的执行路由到其所属实例的运行器
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionExecution") {}

// 中断原因类型：用户主动停止或系统关闭
type InterruptReason = "user" | "shutdown"

// 把运行器出口（Exit）映射为终结结果：成功 / 被中断（带原因）/ 失败（带会话错误）
export function terminal(exit: Exit.Exit<void, SessionRunner.RunError>, reason?: InterruptReason) {
  // 成功出口
  if (Exit.isSuccess(exit)) return { type: "succeeded" as const }
  // 出口原因中含中断：视为被中断，默认原因是 shutdown
  if (Cause.hasInterrupts(exit.cause)) return { type: "interrupted" as const, reason: reason ?? "shutdown" }
  // 其余视为失败：把原因压平成会话错误
  return { type: "failed" as const, error: toSessionError(Cause.squash(exit.cause)) }
}

/** Process-local execution: drains run in this process using the selected instance. */
// 进程内执行的 Layer：在本进程中用选定实例排水（drain）会话工作
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 逐个取出依赖服务
    const store = yield* SessionStore.Service
    const instances = yield* Instance.Service
    const bus = yield* Bus.Service
    const jobs = yield* Job.Service
    const inbox = yield* SessionInbox.Service
    const db = (yield* Database.Service).db
    // 发布生命周期事件时记录发布失败的日志（非纯中断的失败才记录）
    const reportLifecycle = <A>(sessionID: SessionSchema.ID, effect: Effect.Effect<A>) =>
      effect.pipe(
        Effect.tapCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logError("Failed to publish Session execution lifecycle", cause).pipe(
                Effect.annotateLogs({ sessionID }),
              ),
        ),
        Effect.asVoid,
      )
    // Write-ahead claim: starting records the durable intent that a turn is in flight, in the same
    // transaction as the started event. Terminals release it — except shutdown interruption, which
    // preserves the claim so the next server start resumes the turn. A claim that survives with no
    // terminal is the signature of a process that died without teardown (crash, SIGKILL, eviction);
    // recovery is a property of the database, never of a shutdown hook that may not run.
    // 提交时钩子：启动时在同事务中持久化“回合进行中”的声明（write-ahead claim）；终结时释放——shutdown 中断例外，保留声明以便下次启动恢复回合；无终结而残留的声明即进程异常死亡的标志
    const claimOnCommit = (sessionID: SessionSchema.ID) => ({
      commit: () => store.claim(sessionID),
    })
    // The report coordinator is built first so the run coordinator's hooks can use it, while its
    // wake and draining dependencies bind late to the coordinator the hooks belong to.
    const holder: {
      coordinator?: SessionRunCoordinator.Coordinator<SessionSchema.ID, SessionRunner.RunError, InterruptReason>
    } = {}
    const subagentReport = SubagentReport.make({
      store,
      jobs,
      inbox,
      wake: (sessionID) =>
        Effect.suspend(() => (holder.coordinator ? holder.coordinator.wake(sessionID) : Effect.void)),
      draining: Effect.suspend<ReadonlySet<SessionSchema.ID>, never, never>(() =>
        holder.coordinator ? holder.coordinator.draining : Effect.succeed(new Set<SessionSchema.ID>()),
      ),
    })
    // Why a Session's execution is being interrupted, read from the coordinator once it exists.
    let interruption: (sessionID: SessionSchema.ID) => InterruptReason | undefined = () => undefined
    const drain = Effect.fnUntraced(function* (
      sessionID: SessionSchema.ID,
      force: boolean,
      continuation?: SessionRunner.Continuation,
      promotable: SessionInbox.Promotable = "input",
      stepped = false,
    ): Effect.fn.Return<void, SessionRunner.RunError> {
      // 读取会话；不存在则直接终止
      const session = yield* store.get(sessionID)
      if (!session) return yield* Effect.die(new Error(`Session not found: ${sessionID}`))
      // 在会话对应实例的作用域内用运行器排水
      const result = yield* SessionRunner.Service.use((runner) =>
        runner.drain({
          sessionID,
          force,
          continuation,
          promotable,
          stepped,
          interruption: () => interruption(sessionID),
        }),
      ).pipe(
        instances.provide(session),
        // 非纯中断的失败记录错误日志
        Effect.tapCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logError("Failed to drain Session", cause).pipe(Effect.annotateLogs({ sessionID })),
        ),
      )
      // 按排水结果分派：完成则结束，Moved/Reloaded 携带续延递归继续
      return yield* SessionRunner.DrainResult.$match(result, {
        Complete: () => Effect.void,
        Moved: (result) => drain(sessionID, false, result.continuation, promotable, result.stepped),
        Reloaded: (result) => drain(sessionID, result.force, result.continuation, promotable, result.stepped),
      })
    })
    // 构造运行协调器：接线启动事件、排水与终结结算
    const coordinator = yield* SessionRunCoordinator.make<SessionSchema.ID, SessionRunner.RunError, InterruptReason>({
      // 启动回调：发布 Execution.Started 事件，并在同事务中登记执行声明
      started: (sessionID) =>
        reportLifecycle(
          sessionID,
          Effect.gen(function* () {
            // Bind before the started publication yields to SQLite so a cancel arriving during
            // that window still matches this generation.
            const before = yield* jobs.currentGeneration(sessionID)
            const event = yield* bus.publish(SessionEvent.Execution.Started, { sessionID }, claimOnCommit(sessionID))
            const bound = before?.running ? before : yield* jobs.currentGeneration(sessionID)
            subagentReport.started(sessionID, {
              startedSeq: event.durable.seq,
              boundGeneration: bound?.running ? bound.generation : undefined,
            })
          }),
        ),
      // 排水回调：直接调用 drain（无续延）
      drain: (sessionID, force, promotable) => drain(sessionID, force, undefined, promotable),
      // One terminal observation per busy period, covering every coalesced drain.
      // 结算回调：每个忙碌周期只产生一次终结观察，覆盖所有被合并的排水
      settled: (sessionID, exit, reason) =>
        reportLifecycle(
          sessionID,
          Effect.gen(function* () {
            // 把出口映射为终结结果
            const outcome = terminal(exit, reason)
            if (outcome.type === "interrupted" && outcome.reason === "shutdown") {
              subagentReport.clear(sessionID)
              // Shutdown keeps the claim and the running Job row for restart continuity.
              yield* bus.publish(SessionEvent.Execution.Interrupted, { sessionID, reason: "shutdown" })
              return
            }
            // Claim the Job generation before cancelling it so the settlement commit owns its outbox row.
            const settlement = yield* subagentReport.prepare(sessionID, outcome)
            if (outcome.type === "interrupted") yield* jobs.cancel(sessionID)
            yield* publishTerminal(bus, sessionID, outcome, settlement.commit)
            // Post-commit delivery is best effort: a retained outbox marker is recovered on the
            // next restart, and a delivery defect must not fail the settled hook.
            yield* settlement.deliver.pipe(
              Effect.ignoreCause({ log: "Error", message: "Subagent report delivery failed" }),
            )
          }),
        ),
    })
    holder.coordinator = coordinator

    interruption = coordinator.interruption
    return Service.of({
      active: coordinator.active,
      isActive: coordinator.isActive,
      interrupt: (sessionID, options) =>
        Effect.gen(function* () {
          // 以“user”原因中断协调器
          const interrupted = yield* coordinator.interrupt(sessionID, "user")
          // 未要求恢复：直接返回中断结果
          if (!options?.resume) return interrupted
          // Resume steering input and between-turn control work from the interrupted
          // intent. Queued next-turn prompts stay parked: a steer-scoped drain never
          // promotes them, and a control item behind a queued prompt waits its turn.
          // Interruption acknowledges before cleanup settles, so this wake usually lands
          // on the stopping execution's doorbell and starts the successor at settle.
          // Reading the inbox concurrently with the dying drain is safe: delivery consumes
          // rows inside uninterruptible publications, so a steer row is either still
          // promotable here or was fully delivered and needs no resumption.
          // 恢复 steer 输入与回合间控制工作：查找下一个可提升的收件箱条目
          const next = yield* SessionInbox.nextPromotable(db, sessionID, "input")
          // 没有待处理条目：直接返回
          if (next === undefined) return interrupted
          // steer 投递或 compaction/move 类条目：以 steer 方式唤醒协调器（排队中的下回合 prompt 保持停放）
          if (next.delivery === "steer" || next.type === "compaction" || next.type === "move")
            yield* coordinator.wake(sessionID, "steer")
          return interrupted
        }),
      resume: coordinator.run,
      wake: coordinator.wake,
      awaitIdle: coordinator.awaitIdle,
    })
  }),
)

/** Publishes the terminal event with the settlement's atomic commit. */
function publishTerminal(
  bus: Bus.Interface,
  sessionID: SessionSchema.ID,
  outcome: ReturnType<typeof terminal>,
  commit: (seq: number) => Effect.Effect<void>,
) {
  if (outcome.type === "succeeded") return bus.publish(SessionEvent.Execution.Succeeded, { sessionID }, { commit })
  if (outcome.type === "interrupted") {
    return bus.publish(SessionEvent.Execution.Interrupted, { sessionID, reason: outcome.reason }, { commit })
  }
  return bus.publish(SessionEvent.Execution.Failed, { sessionID, error: outcome.error }, { commit })
}

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [SessionStore.node, Instance.node, Bus.node, Database.node, Job.node, SessionInbox.node],
})

/** Low-level compatibility layer for callers that only need durable Session recording. */
// 空实现层：给只需要持久会话记录能力的调用方（不执行任何东西）
export const noopLayer = Layer.succeed(
  Service,
  Service.of({
    // 空闲集合
    active: Effect.succeed(new Set()),
    // 永远不活跃
    isActive: () => Effect.succeed(false),
    // 恢复/唤醒为空操作
    resume: () => Effect.void,
    wake: () => Effect.void,
    // 中断永远返回“没有中断任何执行”
    interrupt: () => Effect.succeed(false),
    awaitIdle: () => Effect.void,
  }),
)
