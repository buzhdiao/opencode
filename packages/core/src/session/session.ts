// 将本模块以命名空间形式整体导出为 Session
export * as Session from "./session.js"

// effect：DateTime 时间、Effect 运行时、Fiber 轻量线程、Scope 作用域
import { DateTime, Effect, Fiber, Scope } from "effect"
// 代理 ID 类型
import type { Agent } from "@opencode/schema/agent"
// 模型引用类型
import type { Model } from "@opencode/schema/model"
// 权限规则类型
import type { Permission } from "@opencode/schema/permission"
// 事件 ID 工具
import { Event } from "@opencode/schema/event"
// 文件系统服务
import { FSUtil } from "@opencode/util/fs-util"
// 事件总线
import { Bus } from "../bus.js"
// 数据库服务
import { Database } from "../database/database.js"
// 实例服务
import { Instance } from "../instance/service.js"
// Shell 结果类型与用户通知构造
import { ShellResult } from "../shell/result.js"
// 技能 ID 类型
import type { Skill } from "../skill.js"
// 会话相关错误：忙碌、各类冲突与未找到
import {
  BusyError,
  CompactionConflictError,
  InboxConflictError,
  NotFoundError,
  PromptConflictError,
  SyntheticConflictError,
} from "./error.js"
// 会话事件定义
import { SessionEvent } from "./event.js"
// 会话执行服务：唤醒/中断/等待空闲
import { SessionExecution } from "./execution.js"
// 会话收件箱服务：准入与生命周期变更
import { SessionInbox } from "./inbox.js"
// 会话消息 ID 类型
import { SessionMessage } from "./message.js"
// 提示词准备服务
import { SessionPrompt } from "./prompt.js"
// 回退服务
import { SessionRevert } from "./revert.js"
// 会话 Shell 启动服务
import { SessionShell } from "./shell.js"
// 会话技能服务
import { SessionSkill } from "./skill.js"
// 会话 Schema：ID/Metadata 类型
import { SessionSchema } from "./schema.js"
// 会话存储服务：读取会话与消息
import { SessionStore } from "./store.js"

// 提示请求：在普通输入之上允许指定消息 ID 与是否唤醒（resume）
type PromptRequest = SessionPrompt.Input & {
  id?: SessionMessage.ID
  resume?: boolean
}

/**
 * Build once in the host Scope: `const sessions = yield* Session.make()`.
 * Use `sessions.forSession(id)` for handles that share host services and reload current state.
 */
export const make = Effect.fn("Session.make")(function* () {
  // 获取各共享服务：总线、数据库、存储、实例、执行、收件箱准入、文件系统与宿主作用域
  const bus = yield* Bus.Service
  const database = yield* Database.Service
  const store = yield* SessionStore.Service
  const instances = yield* Instance.Service
  const execution = yield* SessionExecution.Service
  const admission = yield* SessionInbox.Service
  const fs = yield* FSUtil.Service
  const scope = yield* Scope.Scope

  // 读取会话；不存在则报未找到错误
  const get = Effect.fn("Session.get")(function* (sessionID: SessionSchema.ID) {
    // 从存储读取会话
    const session = yield* store.get(sessionID)
    // 未找到
    if (!session) return yield* new NotFoundError({ sessionID })
    return session
  })
  // 读取属于指定会话的消息；不属于该会话则返回 undefined
  const message = Effect.fn("Session.message")(function* (sessionID: SessionSchema.ID, messageID: SessionMessage.ID) {
    // 从存储读取消息
    const stored = yield* store.message(messageID)
    // 校验消息归属
    return stored?.sessionID === sessionID ? stored.message : undefined
  })
  // 标记会话已读：仅当 idle 观察值比已记录的更新且未被看过时发布
  const view = Effect.fn("Session.view")(function* (sessionID: SessionSchema.ID, input: { idle: number }) {
    // 读取会话
    const session = yield* get(sessionID)
    if (
      // 会话尚未空闲、观察值过旧（晚于当前空闲点）、或已被看过：都无需发布
      session.time.idle === undefined ||
      input.idle > DateTime.toEpochMillis(session.time.idle) ||
      (session.time.viewed !== undefined && DateTime.toEpochMillis(session.time.viewed) >= input.idle)
    )
      return
    // 发布查看事件
    yield* bus.publish(SessionEvent.Viewed, { sessionID, idle: input.idle })
  })
  // 重命名会话
  const rename = Effect.fn("Session.rename")(function* (sessionID: SessionSchema.ID, input: { title: string }) {
    // 确认会话存在
    yield* get(sessionID)
    // 发布重命名事件
    yield* bus.publish(SessionEvent.Renamed, { sessionID, title: input.title })
  })
  // 归档会话
  const archive = Effect.fn("Session.archive")(function* (sessionID: SessionSchema.ID) {
    // 读取会话
    const session = yield* get(sessionID)
    // 已归档则不重复
    if (session.time.archived) return
    // 发布归档事件
    yield* bus.publish(SessionEvent.Archived, { sessionID })
  })
  // 取消归档
  const unarchive = Effect.fn("Session.unarchive")(function* (sessionID: SessionSchema.ID) {
    // 读取会话
    const session = yield* get(sessionID)
    // 未归档则无事可做
    if (!session.time.archived) return
    // 发布取消归档事件
    yield* bus.publish(SessionEvent.Unarchived, { sessionID })
  })
  // 更新会话元数据
  const setMetadata = Effect.fn("Session.setMetadata")(function* (
    sessionID: SessionSchema.ID,
    input: { metadata: SessionSchema.Metadata },
  ) {
    // 确认会话存在
    yield* get(sessionID)
    // 发布元数据更新事件
    yield* bus.publish(SessionEvent.MetadataUpdated, { sessionID, metadata: input.metadata })
  })
  // 更新会话权限规则
  const setPermissions = Effect.fn("Session.setPermissions")(function* (
    sessionID: SessionSchema.ID,
    input: { permissions: Permission.Ruleset },
  ) {
    // 确认会话存在
    yield* get(sessionID)
    // 发布权限更新事件
    yield* bus.publish(SessionEvent.Permissions, { sessionID, permissions: input.permissions })
  })
  // 切换代理
  const switchAgent = Effect.fn("Session.switchAgent")(function* (
    sessionID: SessionSchema.ID,
    input: { agent: Agent.ID },
  ) {
    // 读取会话（取当前代理作为 previous）
    const session = yield* get(sessionID)
    // 发布代理选择事件
    yield* bus.publish(SessionEvent.AgentSelected, { sessionID, agent: input.agent, previous: session.agent })
  })
  // 切换模型：与当前完全一致时不发布
  const switchModel = Effect.fn("Session.switchModel")(function* (
    sessionID: SessionSchema.ID,
    input: { model: Model.Ref },
  ) {
    // 读取会话
    const session = yield* get(sessionID)
    if (
      // 提供方、模型 ID 与变体（default 归一）完全相同则视为未变化
      session.model?.providerID === input.model.providerID &&
      session.model.id === input.model.id &&
      (session.model.variant ?? "default") === (input.model.variant ?? "default")
    )
      return
    // 发布模型选择事件
    yield* bus.publish(SessionEvent.ModelSelected, { sessionID, model: input.model, previous: session.model })
  })
  // 对待处理收件箱条目执行生命周期变更；冲突时确认会话存在并转成收件箱冲突错误
  const mutatePending = (
    sessionID: SessionSchema.ID,
    inboxID: SessionMessage.ID,
    mutation: (input: {
      readonly id: SessionMessage.ID
      readonly sessionID: SessionSchema.ID
    }) => Effect.Effect<void, SessionInbox.LifecycleConflict>,
  ) =>
    mutation({ sessionID, id: inboxID }).pipe(
      Effect.catchTag("SessionInbox.LifecycleConflict", () =>
        Effect.gen(function* () {
          // 先确认会话存在（否则抛 NotFound）
          yield* get(sessionID)
          // 会话在而条目冲突：报告收件箱冲突
          return yield* new InboxConflictError({ sessionID, inboxID })
        }),
      ),
    )

  // 列出会话的收件箱条目
  const inbox = Effect.fn("Session.inbox")(function* (sessionID: SessionSchema.ID) {
    // 确认会话存在
    yield* get(sessionID)
    // 列出条目
    return yield* admission.list(sessionID)
  })
  // 取消待处理条目（不可中断）
  const cancelInbox = Effect.fn("Session.cancelInbox")(
    (sessionID: SessionSchema.ID, inboxID: SessionMessage.ID) => mutatePending(sessionID, inboxID, admission.cancel),
    Effect.uninterruptible,
  )
  // 立即转向（steer）执行中的会话（不可中断）
  const steerInbox = Effect.fn("Session.steerInbox")(function* (
    sessionID: SessionSchema.ID,
    inboxID: SessionMessage.ID,
  ) {
    // 变更条目为 steer
    yield* mutatePending(sessionID, inboxID, admission.steer)
    // 唤醒执行以消化新输入
    yield* execution.wake(sessionID)
  }, Effect.uninterruptible)
  // 把条目改为排队（queue）（不可中断）
  const queueInbox = Effect.fn("Session.queueInbox")(
    (sessionID: SessionSchema.ID, inboxID: SessionMessage.ID) => mutatePending(sessionID, inboxID, admission.queue),
    Effect.uninterruptible,
  )
  // 提交用户提示：准备 → 暂存回退提交 → 准入；幂等（重复 ID 复用已有条目）
  const prompt = Effect.fn("Session.prompt")((sessionID: SessionSchema.ID, input: PromptRequest) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        // 读取会话
        const session = yield* get(sessionID)
        // 未指定 ID 时生成新消息 ID
        const messageID = input.id ?? SessionMessage.ID.create()
        const admitted = yield* Effect.gen(function* () {
          // 先调和：同 ID 已准入则直接复用（幂等重试）
          const existing = yield* admission.reconcile({
            id: messageID,
            sessionID: session.id,
            type: "user",
            delivery: input.delivery ?? "steer",
          })
          // 已存在则返回
          if (existing) return existing
          // Preparation, the staged revert commit and admission share one acquisition of the session's location
          // services, so projections see its config whoever called prompt.
          // 准备、暂存回退提交与准入共用一次会话位置服务的获取，
          // 因此无论谁调用 prompt，投影看到的都是它的配置
          return yield* Effect.gen(function* () {
            // 准备用户提示（可恢复中断）
            const item = yield* restore(SessionPrompt.prepare({ session, messageID, input }))
            // Commit a staged revert only after preparation succeeds, before admitting new work.
            // 仅在准备成功之后、准入新工作之前提交暂存的回退
            if (session.revert) yield* SessionRevert.commit(bus, session)
            // 准入该条目
            return yield* admission.admit({
              id: messageID,
              sessionID: session.id,
              item,
            })
          }).pipe(
            // 提供会话所在实例与宿主的数据库/文件系统服务
            instances.provide(session),
            Effect.provideService(Database.Service, database),
            Effect.provideService(FSUtil.Service, fs),
          )
        }).pipe(
          // 生命周期冲突转为提示冲突错误
          Effect.catchTag("SessionInbox.LifecycleConflict", () => new PromptConflictError({ sessionID, messageID })),
        )
        // 未显式关闭 resume 时唤醒执行
        if (input.resume !== false) yield* execution.wake(sessionID)
        // 返回准入结果
        return admitted
      }),
    ),
  )
  // 启动用户 shell：在会话上下文中执行并跟踪其完成（后台 Fiber）
  const shell = Effect.fn("Session.shell")(function* (
    sessionID: SessionSchema.ID,
    input: { id?: SessionMessage.ID; command: string },
  ) {
    // 读取会话
    const session = yield* get(sessionID)
    // The server owns completion recording even if the submitting client disconnects.
    // 即使提交的客户端断开，完成记录也由服务端负责
    const running = yield* Effect.gen(function* () {
      // 启动 shell；失败时先合成一条错误说明消息再终止
      const started = yield* SessionShell.start({ session, command: input.command }).pipe(
        Effect.provideService(Instance.Service, instances),
        Effect.tapError((error) =>
          synthetic(sessionID, {
            text: `User shell command failed to start:\n${input.command}\n\n${error.message}`,
            description: input.command,
            metadata: { source: "shell", state: "error" },
            resume: false,
          }),
        ),
        Effect.orDie,
      )
      // 发布 Shell.Started（事件 ID 由消息 ID 前缀替换而来，保证关联）
      yield* bus.publish(
        SessionEvent.Shell.Started,
        {
          sessionID,
          shell: started.info,
        },
        { id: input.id ? Event.ID.make(input.id.replace(/^msg_/, "evt_")) : undefined },
      )
      // 等待 shell 结束并读取输出预览
      const terminal = yield* started.result
      const preview = yield* started.output
      // 发布 Shell.Ended
      yield* bus.publish(SessionEvent.Shell.Ended, {
        sessionID,
        shell: terminal.info,
        output: preview,
      })
      // 合成 shell 结果的用户通知（会话已删除时忽略）
      yield* synthetic(sessionID, {
        ...ShellResult.userNotification(terminal),
        resume: false,
      }).pipe(
        Effect.catchTag("Session.NotFoundError", () => Effect.void),
        Effect.orDie,
      )
    }).pipe(Effect.forkIn(scope, { startImmediately: true }))
    // 等待后台 Fiber 完成（调用方仍能看到整个过程结束）
    yield* Fiber.join(running)
  })
  // 激活技能：读取技能 → 发布激活事件 → 视情况恢复执行
  const skill = Effect.fn("Session.skill")(function* (
    sessionID: SessionSchema.ID,
    input: { messageID?: SessionMessage.ID; skill: Skill.ID; resume?: boolean },
  ) {
    // 读取会话
    const session = yield* get(sessionID)
    // 获取技能（提供会话所在实例）
    const skill = yield* SessionSkill.get({ session, skill: input.skill }).pipe(
      Effect.provideService(Instance.Service, instances),
    )
    // 发布技能激活事件（事件 ID 同样由消息 ID 派生）
    yield* bus.publish(
      SessionEvent.Skill.Activated,
      {
        sessionID,
        id: skill.id,
        name: skill.name,
        text: skill.content,
      },
      { id: input.messageID ? Event.ID.make(input.messageID.replace(/^msg_/, "evt_")) : undefined },
    )
    // 未显式关闭 resume 时，后台恢复执行（失败忽略）
    if (input.resume !== false)
      yield* execution
        .resume(sessionID)
        .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }), Effect.asVoid)
  })
  // 请求压缩（compaction）：先提交暂存回退，再准入压缩条目并唤醒
  const compact = Effect.fn("Session.compact")(function* (
    sessionID: SessionSchema.ID,
    input: { id?: SessionMessage.ID; delivery?: SessionInbox.Delivery },
  ) {
    // 读取会话
    const session = yield* get(sessionID)
    // 存在暂存回退则先提交
    if (session.revert) yield* SessionRevert.commit(bus, session)
    // 未指定 ID 时生成
    const inputID = input.id ?? SessionMessage.ID.create()
    // 准入压缩条目；冲突转为压缩冲突错误
    const admitted = yield* admission
      .admitCompaction({
        id: inputID,
        sessionID,
        delivery: input.delivery ?? "steer",
      })
      .pipe(
        Effect.catchTag("SessionInbox.LifecycleConflict", () => new CompactionConflictError({ sessionID, inputID })),
      )
    // 唤醒执行以开始压缩
    yield* execution.wake(sessionID)
    return admitted
  })
  // 等待会话执行空闲
  const wait = Effect.fn("Session.wait")(function* (sessionID: SessionSchema.ID) {
    // 确认会话存在
    yield* get(sessionID)
    // 等待空闲
    yield* execution.awaitIdle(sessionID)
  })
  // 恢复执行
  const resume = Effect.fn("Session.resume")(function* (sessionID: SessionSchema.ID) {
    // 确认会话存在
    yield* get(sessionID)
    // 恢复
    yield* execution.resume(sessionID)
  })
  // 注入合成消息：准入并视情况唤醒
  const synthetic = Effect.fn("Session.synthetic")(
    (
      sessionID: SessionSchema.ID,
      input: {
        id?: SessionMessage.ID
        text: string
        description?: string
        metadata?: Record<string, unknown>
        delivery?: SessionInbox.Delivery
        resume?: boolean
      },
    ) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          // 确认会话存在
          yield* get(sessionID)
          // 未指定 ID 时生成
          const inputID = input.id ?? SessionMessage.ID.create()
          // 构造合成条目
          const admittedInput = {
            type: "synthetic",
            payload: SessionInbox.SyntheticPayload.make({
              text: input.text,
              description: input.description,
              metadata: input.metadata,
            }),
            delivery: input.delivery ?? "steer",
          } satisfies SessionInbox.Item
          // 准入；冲突转为合成冲突错误
          const admitted = yield* admission
            .admit({
              id: inputID,
              sessionID,
              item: admittedInput,
            })
            .pipe(
              Effect.catchTag(
                "SessionInbox.LifecycleConflict",
                () => new SyntheticConflictError({ sessionID, inputID }),
              ),
            )
          // 未关闭 resume 且会话没有暂存回退时唤醒执行
          if (input.resume !== false && !(yield* get(sessionID)).revert) yield* execution.wake(sessionID)
          return admitted
        }),
      ),
  )
  // 中断执行（不可中断包装；可选后续 resume）
  const interrupt = Effect.fn("Session.interrupt")(
    (sessionID: SessionSchema.ID, options?: { readonly resume?: boolean }) =>
      Effect.uninterruptible(execution.interrupt(sessionID, options)),
  )
  // 暂存回退：忙碌时拒绝
  const stage = Effect.fn("Session.revert.stage")(function* (
    sessionID: SessionSchema.ID,
    input: { messageID: SessionMessage.ID; files?: boolean },
  ) {
    // 读取会话
    const session = yield* get(sessionID)
    // 执行中不允许回退
    if (yield* execution.isActive(sessionID)) return yield* new BusyError({ sessionID })
    // 执行暂存（提供实例/数据库/总线）
    return yield* SessionRevert.stage({ session, messageID: input.messageID, files: input.files }).pipe(
      Effect.provideService(Instance.Service, instances),
      Effect.provideService(Database.Service, database),
      Effect.provideService(Bus.Service, bus),
    )
  })
  // 清除回退：忙碌时拒绝；完成后唤醒执行
  const clear = Effect.fn("Session.revert.clear")(function* (sessionID: SessionSchema.ID) {
    // 读取会话
    const session = yield* get(sessionID)
    // 执行中不允许
    if (yield* execution.isActive(sessionID)) return yield* new BusyError({ sessionID })
    // 执行清除（提供实例/总线）
    yield* SessionRevert.clear(session).pipe(
      Effect.provideService(Instance.Service, instances),
      Effect.provideService(Bus.Service, bus),
    )
    // 唤醒执行恢复工作
    return yield* execution.wake(sessionID)
  })
  // 提交回退：忙碌时拒绝
  const commit = Effect.fn("Session.revert.commit")(function* (sessionID: SessionSchema.ID) {
    // 读取会话
    const session = yield* get(sessionID)
    // 执行中不允许
    if (yield* execution.isActive(sessionID)) return yield* new BusyError({ sessionID })
    // 提交回退
    return yield* SessionRevert.commit(bus, session)
  })
  // 汇集回退操作
  const revert = { stage, clear, commit }
  // 全部会话操作（以 sessionID 为首参的通用形态）
  const operations = {
    get,
    message,
    view,
    rename,
    archive,
    unarchive,
    setMetadata,
    setPermissions,
    switchAgent,
    switchModel,
    inbox,
    prompt,
    synthetic,
    shell,
    skill,
    compact,
    wait,
    resume,
    interrupt,
    cancelInbox,
    steerInbox,
    queueInbox,
    revert,
  }

  // 为单个会话生成预绑定 sessionID 的操作句柄
  const forSession = (sessionID: SessionSchema.ID) => {
    // 逐个把 sessionID 绑定为第一参数
    const get = operations.get.bind(undefined, sessionID)
    const message = operations.message.bind(undefined, sessionID)
    const view = operations.view.bind(undefined, sessionID)
    const rename = operations.rename.bind(undefined, sessionID)
    const archive = operations.archive.bind(undefined, sessionID)
    const unarchive = operations.unarchive.bind(undefined, sessionID)
    const setMetadata = operations.setMetadata.bind(undefined, sessionID)
    const setPermissions = operations.setPermissions.bind(undefined, sessionID)
    const switchAgent = operations.switchAgent.bind(undefined, sessionID)
    const switchModel = operations.switchModel.bind(undefined, sessionID)
    const inbox = operations.inbox.bind(undefined, sessionID)
    const prompt = operations.prompt.bind(undefined, sessionID)
    const synthetic = operations.synthetic.bind(undefined, sessionID)
    const shell = operations.shell.bind(undefined, sessionID)
    const skill = operations.skill.bind(undefined, sessionID)
    const compact = operations.compact.bind(undefined, sessionID)
    const wait = operations.wait.bind(undefined, sessionID)
    const resume = operations.resume.bind(undefined, sessionID)
    const interrupt = operations.interrupt.bind(undefined, sessionID)
    const cancelInbox = operations.cancelInbox.bind(undefined, sessionID)
    const steerInbox = operations.steerInbox.bind(undefined, sessionID)
    const queueInbox = operations.queueInbox.bind(undefined, sessionID)
    const stage = operations.revert.stage.bind(undefined, sessionID)
    const clear = operations.revert.clear.bind(undefined, sessionID)
    const commit = operations.revert.commit.bind(undefined, sessionID)
    // 会话专属的回退操作集
    const revert = { stage, clear, commit }

    // 返回该会话的句柄
    return {
      id: sessionID,
      get,
      message,
      view,
      rename,
      archive,
      unarchive,
      setMetadata,
      setPermissions,
      switchAgent,
      switchModel,
      inbox,
      prompt,
      synthetic,
      shell,
      skill,
      compact,
      wait,
      resume,
      interrupt,
      cancelInbox,
      steerInbox,
      queueInbox,
      revert,
    }
  }
  // 对外只暴露 forSession 工厂
  return { forSession }
})

// 会话句柄类型：从 make 返回的 forSession 推导
export type Handle = ReturnType<Effect.Success<ReturnType<typeof make>>["forSession"]>

// Mirrors the shell tool's in-memory preview safety limit.
// 与 shell 工具的内存预览安全上限保持一致（文件在此截断）
