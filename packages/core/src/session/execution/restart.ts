// 将本模块整体导出为 SessionRestart 命名空间
export * as SessionRestart from "./restart.js"

// 导入 effect 核心
import { Context, Effect, Layer } from "effect"
// 导入全局依赖注入节点构造工具
import { makeGlobalNode } from "@opencode/util/effect/app-node"
// 导入事件总线服务
import { Bus } from "../../bus.js"
// 导入任务系统服务
import { Job } from "../../job.js"
// 导入会话服务
import { Session } from "../../session.js"
// 导入会话事件定义
import { SessionEvent } from "../event.js"
// 导入会话执行服务
import { SessionExecution } from "../execution.js"
// 导入会话 schema 类型
import { SessionSchema } from "../schema.js"
// 导入会话存储服务
import { SessionStore } from "../store.js"
// 导入图片生成通知辅助
import { ImageNotice } from "../../image/notice.js"
// 导入 shell 结果通知辅助
import { ShellResult } from "../../shell/result.js"
// 导入子代理完成通知辅助
import { SubagentCompletion } from "../subagent-completion.js"

// 服务器重启后注入的续作提示文本
const CONTINUE_AFTER_SERVER_RESTART =
  "The server restarted while you were working. Continue from where you left off without repeating completed work."

// 恢复预算耗尽时的终结结果：不再自动恢复
const RESUME_EXHAUSTED = {
  type: "aborted",
  message: "Execution was interrupted repeatedly and will not be resumed automatically.",
} as const

// 恢复选项
export interface Options {
  /**
   * Times a single turn may be resumed before it is terminalized instead.
   * The counter is durable and only a terminal event resets it, so a turn
   * that keeps dying cannot crash-loop across restarts. Turns that complete
   * never accumulate: the budget is per-turn, not per-session.
   */
  // 单个回合可被恢复的最大次数，超过则终结；计数持久化，仅终结事件重置，防止崩溃循环跨重启
  readonly maxAttempts?: number
}

// 默认恢复次数上限
const DEFAULT_MAX_ATTEMPTS = 10

// 服务接口
export interface Interface {
  /**
   * Resumes Sessions whose execution claim was never released — turns orphaned
   * by a process that died without teardown, or interrupted by a graceful
   * shutdown (which preserves the claim on purpose). The claim is never
   * cleared here: only a terminal event releases it, so a death anywhere in
   * the resume path leaves the same orphaned claim for the next boot.
   */
  // 恢复执行声明从未被释放的会话（进程异常死亡或优雅关闭遗留的孤儿回合）；本服务从不直接清除声明——只有终结事件会释放它
  readonly resumeSuspendedSessions: Effect.Effect<void>
}

/**
 * Recovery for orphaned executions. Claims are written at turn start by
 * SessionExecution, so this sweep needs no cooperation from the previous
 * process: crash, SIGKILL, isolate eviction, and graceful restart all leave
 * the same durable signature.
 *
 * Recovery is at-least-once: local coordination prevents concurrent drains,
 * not repeated external side effects after a crash.
 *
 * The sweep assumes every orphaned claim's owner is dead. The managed-server
 * protocol guarantees this: a successor is only spawned after the previous
 * process is confirmed dead (client service `kill`/`evict` poll the PID), the
 * registration lock admits one managed server at a time, and unregistered
 * servers sharing the database never sweep. The service is inert until called
 * — the managed server invokes it at boot; embedders may call it from their
 * own start-up.
 */
// 服务标签：孤儿执行的恢复服务（清扫未被释放的执行声明并恢复回合）
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRestart") {}

// 构建恢复 Layer（可传选项）
export const layer = (options?: Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      // 取出各依赖服务
      const store = yield* SessionStore.Service
      const execution = yield* SessionExecution.Service
      const bus = yield* Bus.Service
      const jobs = yield* Job.Service
      const sessions = yield* Session.Service
      // 当前作用域（用于把等待任务 fork 进启动生命周期）
      const scope = yield* Effect.scope
      // 恢复次数上限
      const maxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS

      // 准备恢复某个会话：检查恢复预算并注入重启提示；返回是否允许恢复
      const prepareResume = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
        // Durable before the resume runs, so a crash inside the resumed turn is
        // counted by the next sweep and the budget cannot be dodged.
        // 先持久化地递增恢复计数，恢复中的崩溃会被下次清扫计入，预算无法被绕过
        const attempts = yield* store.countResume(sessionID)
        // 没有挂起的执行声明：无需恢复
        if (attempts === undefined) return false
        // 超出预算：终结该回合
        if (attempts > maxAttempts) {
          // Terminalize instead: the release hook clears the claim and resets the
          // counter atomically with the terminal event.
          // 发布 Failed 事件，释放钩子在终结事件同事务中清除声明并重置计数
          yield* bus.publish(
            SessionEvent.Execution.Failed,
            { sessionID, error: RESUME_EXHAUSTED },
            { commit: () => store.release(sessionID) },
          )
          return false
        }
        // 注入合成消息：告知模型服务器已重启，从断点继续
        yield* bus.publish(SessionEvent.Synthetic, {
          sessionID,
          text: CONTINUE_AFTER_SERVER_RESTART,
          description: "Continuing after restart",
          metadata: { notice: "restart" },
        })
        // 允许恢复
        return true
      })

      // 生成后台任务重启后的通知消息（shell 或图片请求）
      const restartMessage = (
        background: Job.Background,
        recovery: Exclude<Job.Recovery, { kind: "subagent" }>,
      ) => {
        // 任务状态：仍在运行的视为已取消
        const state = background.status === "running" ? "cancelled" : background.status
        // shell 任务：按状态生成相应文本
        if (recovery.kind === "shell") {
          const text =
            background.status === "running"
              ? "Command cancelled because the server restarted"
              : state === "completed"
                ? (background.output ?? "Command completed")
                : state === "error"
                  ? (background.error ?? "Command failed")
                  : "Command cancelled"
          return {
            description: recovery.command,
            // 用 ShellResult 的通知格式构造消息体
            ...ShellResult.notification({
              jobID: background.id,
              shellID: recovery.shellID,
              command: recovery.command,
              state,
              text,
            }),
          }
        }
        // 图片请求：按状态生成说明文本
        const body =
          background.status === "running"
            ? `Image request for ${recovery.path} was cancelled because the server restarted.`
            : state === "completed"
              ? (background.output ?? `Image request finished. Saved image: ${recovery.path} (${recovery.model}).`)
              : state === "error"
                ? (background.error ?? `Image request failed for ${recovery.path}.`)
                : `Image request for ${recovery.path} was cancelled.`
        return {
          description: "Image generation",
          text: ImageNotice.text({ id: background.id, state, body }),
          metadata: {
            source: "experimental_image_generate",
            jobID: background.id,
            state,
            path: recovery.path,
          },
        }
      }

      // 恢复工具类后台任务（shell/图片）：写入合成通知并把任务标记完成
      const recoverToolJob = Effect.fnUntraced(function* (
        background: Job.Background,
        recovery: Exclude<Job.Recovery, { kind: "subagent" }>,
      ) {
        // 向任务归属会话写入合成消息（携带重启说明）
        yield* sessions
          .synthetic({
            id: background.notificationID,
            sessionID: recovery.sessionID,
            ...restartMessage(background, recovery),
            // Restart notices must not revive idle owners of long-lived background tools.
            // Interrupted executions resume separately after their notices are admitted.
            // 重启通知不得唤醒空闲的会话所有者；被中断的执行会在通知被接纳后单独恢复
            resume: false,
          })
          .pipe(
            // 会话已删除：忽略
            Effect.catchTag("Session.NotFoundError", () => Effect.void),
            Effect.orDie,
          )
        // 把后台任务标记为已完成
        yield* jobs.completeBackground(background.notificationID)
      })

      // 恢复子代理任务：校验父子会话关系、按状态通知或重新调度子会话执行
      const recoverSubagent = Effect.fnUntraced(function* (
        background: Job.Background,
        recovery: Extract<Job.Recovery, { kind: "subagent" }>,
        suspended: ReadonlySet<SessionSchema.ID>,
      ) {
        // 读取子会话
        const child = yield* store.get(recovery.childSessionID)
        // 子会话不存在、父子关系不匹配或父会话已删除：任务作废
        if (!child || child.parentID !== recovery.parentSessionID || !(yield* store.get(recovery.parentSessionID))) {
          yield* jobs.completeBackground(background.notificationID)
          return
        }

        // 通知父会话子代理结果
        const notify = Effect.fnUntraced(function* (result: Pick<Job.Background, "status" | "output" | "error">) {
          yield* SubagentCompletion.deliver(sessions, jobs, {
            ...result,
            recovery,
            notificationID: background.notificationID,
            // 父会话处于挂起恢复名单时通知不唤醒它
            resume: suspended.has(recovery.parentSessionID) ? false : undefined,
          }).pipe(Effect.orDie)
        })

        // 任务已结束：直接把结果通知父会话
        if (background.status !== "running") {
          yield* notify(background)
          return
        }
        // 子会话在本进程仍活跃：交给现有执行处理
        if (yield* execution.isActive(recovery.childSessionID)) return
        // 准备恢复失败（无声明或预算耗尽）：通知错误
        if (!(yield* prepareResume(recovery.childSessionID))) {
          yield* notify({ status: "error", error: RESUME_EXHAUSTED.message })
          return
        }

        // 重新登记子代理任务：运行内容为恢复子会话执行并提取最后的助手回复
        yield* jobs.start({
          id: background.id,
          type: "subagent",
          title: recovery.description,
          notificationID: background.notificationID,
          recovery,
          run: execution.resume(recovery.childSessionID).pipe(
            // 恢复完成后读取子会话上下文
            Effect.andThen(store.context(recovery.childSessionID)),
            // 从消息中找最后一条完成且无错误的助手消息，生成完成文本
            Effect.map((messages) => {
              const assistant = messages.findLast(
                (message) =>
                  message.type === "assistant" && message.time.completed !== undefined && message.error === undefined,
              )
              return SubagentCompletion.text(assistant)
            }),
          ),
        })
        // 把任务转回后台队列
        yield* jobs.background(background.id)
        // 在启动作用域内 fork 等待任务：完成后通知父会话
        yield* jobs.wait({ id: background.id }).pipe(
          Effect.flatMap((result) => (result.info ? notify(result.info) : Effect.void)),
          Effect.forkIn(scope),
        )
      })

      // 返回服务实现
      return Service.of({
        resumeSuspendedSessions: Effect.gen(function* () {
          // 本进程当前活跃执行的会话
          const active = yield* execution.active
          // 待处理的后台任务
          const pending = yield* jobs.pendingBackground
          // 其中仍在运行的子代理任务的子会话 ID
          const children = pending.flatMap((background) =>
            background.status === "running" && background.recovery.kind === "subagent"
              ? [background.recovery.childSessionID]
              : [],
          )
          // Early notices wait for recovery's accounting, including Sessions that exhaust their budget.
          // 挂起集合：存储中的挂起会话加上运行中的子会话，排除本进程已活跃的
          const suspended = new Set(
            [...(yield* store.listSuspended()), ...children].filter((sessionID) => !active.has(sessionID)),
          )
          // 释放子会话的执行声明（由本服务接管恢复）
          yield* store.releaseChildClaims(children)
          // 逐个恢复后台任务：先处理工具任务，再处理子代理
          yield* Effect.forEach(
            // Admit shell outcomes before a recovered child can start its first model request.
            // 排序让 shell 结果先于子代理被接纳（子代理恢复后才能发起首个模型请求）
            pending.toSorted((a, b) => Number(a.recovery.kind === "subagent") - Number(b.recovery.kind === "subagent")),
            Effect.fnUntraced(function* (background) {
              // 任务在本进程已被接手（仍在运行）：跳过
              if ((yield* jobs.get(background.id))?.status === "running") return
              // 取恢复信息
              const recovery = background.recovery
              // 非子代理任务：按工具任务恢复
              if (recovery.kind !== "subagent") return yield* recoverToolJob(background, recovery)
              // 子代理任务：按子代理恢复
              yield* recoverSubagent(background, recovery, suspended)
            }),
            { discard: true },
          )

          // Background completion can wake a parent, so inspect local ownership only after recovery.
          // 后台任务完成可能唤醒父会话，因此在恢复之后再检查本地所有权并恢复挂起会话
          const resumed = yield* execution.active
          yield* Effect.forEach(
            (yield* store.listSuspended()).filter((sessionID) => !resumed.has(sessionID)),
            (sessionID) =>
              execution
                .resume(sessionID)
                .pipe(Effect.ignore, Effect.forkIn(scope), Effect.when(prepareResume(sessionID))),
            { concurrency: "unbounded", discard: true },
          )
          // Async observers consult this set at delivery; later completions wake parents normally.
          // 清空挂起集合：此后完成的任务正常唤醒父会话
          suspended.clear()
        }),
      })
    }),
  )

// 创建全局依赖注入节点：使用默认选项的层
export const node = makeGlobalNode({
  service: Service,
  layer: layer(),
  deps: [SessionStore.node, SessionExecution.node, Bus.node, Job.node, Session.node],
})
