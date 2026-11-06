// 以命名空间方式整体导出本模块
export * as GoalPlugin from "./goal.js"

// 引入 AI SDK 相关工具：上下文溢出判断（isContextOverflowFailure）与消息构造（Message）
import { isContextOverflowFailure, Message } from "@opencode/ai/effect"
// 引入插件定义工具（define）
import { define } from "@opencode/plugin/effect/plugin"
// 引入"会话空闲后台任务"事件类型（仅类型引用）
import type { SessionIdleBackground } from "@opencode/plugin/effect/session"
// 引入 Goal（目标）schema
import { Goal } from "@opencode/schema/goal"
// 引入 Session schema
import { Session } from "@opencode/schema/session"
// 引入"标题为根级占位"的判断工具（用于给会话命名）
import { isExactRootFallback } from "@opencode/util/session-title-fallback"
// 引入 Effect 核心模块：Cause（错误原因）、Clock（时钟）、DateTime（时间）、Duration（时长）、Effect（副作用容器）、FiberMap（纤程映射）、Option（可选值）、Schema（校验）、Stream（流）
import { Cause, Clock, DateTime, Duration, Effect, FiberMap, Option, Schema, Stream } from "effect"
// 引入续写（continuation）提示词模板（构建期内联文本）
import CONTINUATION from "./goal/continuation.txt"
// 引入评审（judge）提示词模板
import JUDGE from "./goal/judge.txt"
// 引入启动（kickoff）提示词模板
import KICKOFF from "./goal/kickoff.txt"
// 引入提醒（reminder）提示词模板
import REMINDER from "./goal/reminder.txt"

// 目标描述的最大字符数
export const MAX_OBJECTIVE = 4_000
// 单个目标最多允许的循环轮数
export const MAX_ROUNDS = 50
// 连续"无进展"（stall）的最大次数，超过即暂停
export const MAX_STALLS = 3
/** How long an active goal may sit idle, waiting on background work that never reports, before it pauses. */
// 活跃目标最多可空闲等待后台工作的时长（30 分钟），超时自动暂停
export const WAIT_LIMIT = Duration.minutes(30)
// Identifies this server process. A goal armed by an earlier process comes back paused instead of resuming on its own.
// Created on first use: Workers forbid random values while a module loads.
// 标识当前服务进程：更早进程设置的目标会回到"暂停"而不是自行恢复
let processBoot: string | undefined
// 惰性生成本进程的 boot 标识（首次使用时创建：Workers 禁止模块加载期产生随机值）
const boot = () => (processBoot ??= crypto.randomUUID())

// 目标状态类型（复用 schema）
type State = Goal.State
// 目标状态的宽容解码函数（失败返回 undefined）
const decodeState = Schema.decodeUnknownOption(Goal.State)
// Storage key prefix of a Session's goal. Plugin storage is the plugin's own, so children and forks start without one.
// 会话目标在插件存储中的键前缀：插件存储是插件私有的，子会话与分叉（fork）天然不含目标
const PREFIX = "session:"

// 评审结论（verdict）schema：done/continue/blocked/paused/wait 五种裁决 + 原因 + 可选的下一步
const Verdict = Schema.Struct({
  verdict: Schema.Literals(["done", "continue", "blocked", "paused", "wait"]),
  reason: Schema.String,
  next_step: Schema.optionalKey(Schema.String),
})
// Verdict 的 TypeScript 类型
type Verdict = typeof Verdict.Type
// 从 JSON 字符串宽容解码评审结论（失败返回 undefined）
const decodeVerdict = Schema.decodeUnknownOption(Schema.fromJsonString(Verdict))

// /goal 命令的用法提示
const USAGE = "Usage: /goal <objective> | pause | resume | clear"

// 插件定义：opencode.goal，实现"持续工作直到目标达成"的循环
export const Plugin = define({
  // 插件 ID
  id: "opencode.goal",
  // 插件主体
  effect: Effect.fn(function* (ctx) {
    // read：从插件存储读取某会话的目标状态（无则 undefined）
    const read = Effect.fn("GoalPlugin.read")(function* (sessionID: string) {
      // 读取并宽容解码
      return Option.getOrUndefined(decodeState(yield* ctx.storage.get(PREFIX + sessionID)))
    })

    // 注册 RPC 定义：客户端可通过 get 读取目标
    const rpc = yield* ctx.rpc
      .register(Goal.Definition, {
        // get：返回目标状态，无目标时返回 null
        get: (input) => read(input.sessionID).pipe(Effect.map((goal) => goal ?? null)),
      })
      .pipe(Effect.orDie)

    // Clients read the goal through `get` and follow `changed`, so every write publishes the new value.
    // write：写入（或删除）目标状态，并发布 changed 事件（客户端经 get 读取、跟随 changed 订阅）
    const write = Effect.fn("GoalPlugin.write")(function* (sessionID: string, goal: State | undefined) {
      // 有目标则写入，无目标（undefined）则删除存储键
      yield* goal ? ctx.storage.set(PREFIX + sessionID, goal) : ctx.storage.remove(PREFIX + sessionID)
      // 发布 changed 事件；失败仅记警告（不影响写入结果）
      yield* rpc.events
        .emit("changed", { sessionID, goal: goal ?? null })
        .pipe(Effect.catchCause((cause) => Effect.logWarning("failed to publish a goal change", { sessionID, cause })))
    })

    // The loop's own writes only apply to the goal they were decided on. Storage has no compare-and-set, so this
    // re-reads first: a `/goal pause`, `clear` or new goal that landed since wins instead of being overwritten.
    // replace：循环自身的写入只在目标未被并发改动时生效；先重读校验（id/updatedAt/status 均一致）再写
    const replace = Effect.fn("GoalPlugin.replace")(function* (sessionID: Session.ID, expected: State, next: State) {
      // 读取当前存储中的目标
      const current = yield* read(sessionID)
      // 与期望状态不一致（期间用户执行了 /goal pause、clear 或设置了新目标）则放弃写入
      if (current?.id !== expected.id || current.updatedAt !== expected.updatedAt || current.status !== expected.status)
        return false
      // 校验通过才写入新状态
      yield* write(sessionID, next)
      // 写入成功
      return true
    })

    // settle：把目标置为某种终态（paused/complete），记录原因与更新时间
    const settle = Effect.fn("GoalPlugin.settle")(function* (
      sessionID: Session.ID,
      goal: State,
      status: "paused" | "complete",
      reason: string,
    ) {
      // 通过 replace 写入终态（带新的更新时间）
      yield* replace(sessionID, goal, { ...goal, status, reason, updatedAt: yield* Clock.currentTimeMillis })
    })

    // pauseActive：若会话有活跃目标则暂停（错误处理路径用）
    const pauseActive = (sessionID: Session.ID, reason: string) =>
      read(sessionID).pipe(
        // 仅当目标处于 active 时才执行 settle 暂停
        Effect.flatMap((goal) => (goal?.status === "active" ? settle(sessionID, goal, "paused", reason) : Effect.void)),
      )

    // One compaction per round when the reviewer's request is too large; a second overflow pauses instead. An entry
    // lives only until the reviewer answers or the goal pauses.
    // 每轮最多压缩一次：评审请求过大时先压缩重试；再次溢出则暂停。条目只存活到评审应答或目标暂停为止
    const compacted = new Map<Session.ID, string>()

    // Whether the model called any tool since the goal's last kickoff or continuation. Without that message in view,
    // for example after a compaction, the round counts as progress.
    // usedTools：判断自上次 kickoff/continuation 以来模型是否调用过任何工具；找不到该消息（如压缩后）则视为有进展
    const usedTools = Effect.fn("GoalPlugin.usedTools")(function* (sessionID: Session.ID, goalID: string) {
      // 获取会话的完整消息上下文
      const messages = yield* ctx.session.context({ sessionID })
      // 从后往前找最近的 kickoff/continuation 合成消息（按 goalID 匹配）
      const start = messages.findLastIndex(
        (message) => (message.type === "synthetic" || message.type === "user") && message.metadata?.goalID === goalID,
      )
      // 找不到起始消息（-1）视为有进展；否则检查其后是否有 assistant 消息包含工具调用
      return (
        start === -1 ||
        messages
          .slice(start + 1)
          .some((message) => message.type === "assistant" && message.content.some((part) => part.type === "tool"))
      )
    })

    // judge：调用评审模型，判断目标是否已完成/继续/等待/阻塞
    const judge = Effect.fn("GoalPlugin.judge")(function* (
      sessionID: Session.ID,
      goal: State,
      shells: ReadonlyArray<string>,
    ) {
      // 渲染评审提示词：注入目标（转义）、后台 shell 列表与 wait 示例
      const prompt = render(JUDGE, {
        // 目标文本（HTML 转义）
        objective: escape(goal.objective),
        // 后台任务描述：无 shell 时提示没有；有则列出并提醒仅在需要其结果时才回答 wait
        background:
          shells.length === 0
            ? "No background shells are running."
            : [
                "Background shells still running:",
                ...shells.map((command) => `- ${command}`),
                "",
                'Answer "wait" only when the goal needs the result of one of these shells. Never wait for a long-running server such as a dev server.',
              ].join("\n"),
        // wait 裁决示例（仅在有 shell 运行时提供）
        wait:
          shells.length === 0 ? "" : '{"verdict":"wait","reason":"<the running shell whose result the goal needs>"}\n',
      })
      // 单次评审尝试：生成应答并解析结论；上下文溢出时返回 "overflow"
      const attempt = ctx.session.generate({ sessionID, prompt }).pipe(
        Effect.map((result) => {
          // 解析评审结论
          const verdict = parseVerdict(result.text)
          // "wait" is only offered while a shell runs; without one, nothing would wake the Session to judge again.
          // 没有 shell 在运行时丢弃 wait 结论（否则没有任何东西能再唤醒会话重新评审）
          return verdict?.verdict === "wait" && shells.length === 0 ? undefined : verdict
        }),
        // The reviewer runs right after the last step, before the next step's automatic compaction, so a long final
        // step can leave more history than the model takes.
        // 评审可能遇到上下文溢出：捕获后返回 "overflow" 标记（而不是失败）
        Effect.catchIf(isContextOverflowFailure, () => Effect.succeed("overflow" as const)),
      )
      // 第一次尝试
      const first = yield* attempt
      // 第一次就有结果则直接返回
      if (first !== undefined) return first
      // 否则重试一次
      return yield* attempt
    })

    // Stop-hook style loop: the runner fires this only once the Session would go idle with nothing pending, and input
    // admitted here continues the same execution.
    // idle：会话空闲钩子（stop-hook 风格的续写循环）——会话即将空闲时由运行器触发，此处注入的输入延续同一执行
    const idle = Effect.fn("GoalPlugin.idle")(function* (
      sessionID: Session.ID,
      background: ReadonlyArray<SessionIdleBackground>,
    ) {
      // 读取会话目标
      const goal = yield* read(sessionID)
      // 没有活跃目标则无事可做
      if (goal?.status !== "active") return
      // boot 不匹配说明服务重启过：目标暂停而不是继续
      if (goal.boot !== boot())
        return yield* settle(sessionID, goal, "paused", "The server restarted while the goal was active")
      // The Session's own running subagent or image job wakes it with its notice, and the hook runs again then. A
      // grandchild reports to its own parent, so it would never wake this Session.
      // 本会话自己的子代理/图片任务仍在运行：它们完成时会唤醒会话并再次触发本钩子，先退出等待
      if (
        background.some((work) => (work.kind === "subagent" || work.kind === "image") && work.sessionID === sessionID)
      )
        return
      // 已达最大轮数限制：暂停
      if (goal.rounds >= goal.maxRounds)
        return yield* settle(sessionID, goal, "paused", `Reached the limit of ${goal.maxRounds} rounds`)

      // Only the Session's own shells wake it when they finish. A subagent's leftover shell wakes the subagent, so
      // waiting on it would leave this Session idle until the wait limit pauses the goal.
      // 收集本会话自己的后台 shell（子代理的 shell 不会唤醒本会话，等它只会白白空闲到超时）
      const shells = background.flatMap((work) =>
        work.kind === "shell" && work.sessionID === sessionID ? [work.command] : [],
      )
      // 请评审模型给出裁决
      const verdict = yield* judge(sessionID, goal, shells)
      // 评审成功（非溢出）时清除该轮的压缩标记
      if (verdict !== "overflow") compacted.delete(sessionID)
      // `/goal pause`, `clear` or a new goal may have landed while the reviewer ran.
      // 评审期间用户可能已执行 /goal pause、clear 或设置了新目标：重读最新状态
      const latest = yield* read(sessionID)
      // 目标已被替换或不再是活跃状态则放弃本轮
      if (latest?.id !== goal.id || latest.status !== "active") return
      // 评审请求过大：按轮次去重处理
      if (verdict === "overflow") {
        // 压缩标记键：目标 ID + 当前轮次
        const key = `${latest.id}:${latest.rounds}`
        // 本轮已压缩过一次仍溢出：暂停目标
        if (compacted.get(sessionID) === key) {
          // 清除标记
          compacted.delete(sessionID)
          return yield* settle(sessionID, latest, "paused", "The goal reviewer's request is too large for the model")
        }
        // 记录压缩标记
        compacted.set(sessionID, key)
        // The runner compacts before going idle, then runs this hook again on the smaller history.
        // 让运行器先压缩历史，随后会用更小的历史再次触发本钩子
        yield* ctx.session.compact({ sessionID })
        return
      }
      // 评审没有给出可用结论：暂停
      if (verdict === undefined)
        return yield* settle(sessionID, latest, "paused", "The goal reviewer gave no usable verdict")
      // 裁决为 wait：保持现状等待后台 shell
      if (verdict.verdict === "wait") return
      // 裁决为 done：目标完成
      if (verdict.verdict === "done") return yield* settle(sessionID, latest, "complete", verdict.reason)
      // 其他裁决（blocked/paused）：按原因暂停
      if (verdict.verdict !== "continue") return yield* settle(sessionID, latest, "paused", verdict.reason)

      // 判断是否停滞：评审原因与上次相同，或自上次续写以来没有调用过任何工具
      const stalled = sameReason(latest.reason, verdict.reason) || !(yield* usedTools(sessionID, latest.id))
      // 停滞计数：停滞则 +1，有进展则清零
      const stalls = stalled ? (latest.stalls ?? 0) + 1 : 0
      // 连续停滞达到上限：暂停并说明原因
      if (stalls >= MAX_STALLS)
        return yield* settle(sessionID, latest, "paused", `Not making progress: ${verdict.reason}`)

      // 构造下一轮状态：轮数 +1、更新停滞计数与原因
      const next = {
        ...latest,
        rounds: latest.rounds + 1,
        stalls,
        reason: verdict.reason,
        updatedAt: yield* Clock.currentTimeMillis,
      }
      // 带守卫地写入；期间被用户改动则放弃
      if (!(yield* replace(sessionID, latest, next))) return
      // No description: timelines hide the continuation, and the pinned goal shows that the loop is still running.
      // 注入合成续写消息：把评审原因与下一步反馈交给模型继续执行
      yield* ctx.session.synthetic({
        sessionID,
        text: continuation(next, [verdict.reason, verdict.next_step && `Next step: ${verdict.next_step}`]),
        // 元数据标记来源与目标 ID（供 usedTools 定位轮次起点）
        metadata: { source: "goal", goalID: next.id },
      })
    })

    // 注册"实验性空闲"钩子：驱动续写循环；错误时暂停目标而不是让会话报错
    yield* ctx.session.hook("experimental.idle", (event) =>
      idle(event.sessionID, event.background).pipe(
        Effect.catchCause((cause) =>
          // 纯中断（被取消）则原样中断
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            // 其他错误：记警告并暂停目标（暂停本身失败也吞掉）
            : Effect.logWarning("goal continuation failed", { sessionID: event.sessionID, cause }).pipe(
                Effect.andThen(pauseActive(event.sessionID, "The goal stopped after an error")),
                Effect.catchCause(() => Effect.void),
              ),
        ),
      ),
    )

    // Until the next continuation restates the objective, a compacted history may not show it. Add it near the tail,
    // without persisting it, so the cached prefix stays warm and the reminder stops once a continuation lands.
    // 注册 context 钩子：压缩后的历史可能丢失目标描述，在消息尾部附近临时（不持久化）注入提醒，
    // 保持缓存前缀有效；一旦续写消息包含目标就不再提醒
    yield* ctx.session.hook("context", (event) =>
      read(event.sessionID).pipe(
        // 读取目标并按需插入提醒消息
        Effect.map((goal) => {
          // 无活跃目标则不注入
          if (goal?.status !== "active") return
          // 构造目标文本块（转义 + untrusted 标签）
          const objective = objectiveBlock(goal.objective)
          // 已有消息包含该目标块则不重复注入
          if (event.messages.some((message) => message.role === "user" && textOf(message).includes(objective))) return
          // 插入位置：最后一条是用户消息则插在它之前，否则追加到末尾
          const at = event.messages.at(-1)?.role === "user" ? event.messages.length - 1 : event.messages.length
          // 在指定位置插入提醒消息
          event.messages.splice(at, 0, Message.user(render(REMINDER, { objective: escape(goal.objective) })))
        }),
        // 失败仅记警告（提醒是尽力而为）
        Effect.catchCause((cause) => Effect.logWarning("failed to remind the model of the goal", { cause })),
      ),
    )

    // An active goal only sits idle while it waits on background work, whose notice wakes the Session. If nothing has
    // run in the Session or below it for WAIT_LIMIT (a hung subagent, a shell that never exits, a missed wake), pause
    // instead of staying active.
    // 空闲看门狗：活跃目标只会因等待后台工作而空闲；若 WAIT_LIMIT 内会话及其子层毫无动静（挂死的子代理、
    // 永不退出的 shell、错过的唤醒），则暂停而不是一直挂着
    const timers = yield* FiberMap.make<string>()
    // watch：为目标会话启动一个 WAIT_LIMIT 的看门狗纤程（同会话重复调用会重置）
    const watch = (sessionID: Session.ID) =>
      read(sessionID).pipe(
        Effect.flatMap((goal) =>
          // 目标不是活跃状态则无事可做
          goal?.status !== "active"
            ? Effect.void
            // 在 FiberMap 中按会话 ID 运行定时器（同键重跑会替换旧定时器，实现"重置"）
            : FiberMap.run(
                timers,
                sessionID,
                Effect.sleep(WAIT_LIMIT).pipe(
                  // 超时后暂停目标，说明等待超时的原因
                  Effect.andThen(
                    settle(
                      sessionID,
                      goal,
                      "paused",
                      `Nothing ran for ${Duration.toMinutes(WAIT_LIMIT)} minutes while the goal waited on background work`,
                    ),
                  ),
                  // 暂停失败仅记警告
                  Effect.catchCause((cause) =>
                    Effect.logWarning("failed to pause a waiting goal", { sessionID, cause }),
                  ),
                ),
              ).pipe(Effect.asVoid),
        ),
      )

    // A subagent's executions carry its own Session ID, so a step anywhere below a waiting goal restarts its timer.
    // Otherwise a healthy subagent working past WAIT_LIMIT would pause the goal it works for.
    // touch：某会话有执行活动时，沿父链向上寻找正在等待的目标并重置其定时器
    // （子代理的活动携带自己的会话 ID；不向上传播的话，健康工作的子代理会导致其目标被误暂停）
    const touch = Effect.fn("GoalPlugin.touch")(function* (sessionID: Session.ID) {
      // 没有任何定时器在跑则直接返回
      if ((yield* FiberMap.size(timers)) === 0) return
      // 从当前会话开始沿父链上溯
      let current = (yield* ctx.session.get({ sessionID })).parentID
      // 还有父会话时继续
      while (current !== undefined) {
        // 父会话有看门狗定时器则重置它
        if (yield* FiberMap.has(timers, current)) return yield* watch(current)
        // 继续向上
        current = (yield* ctx.session.get({ sessionID: current })).parentID
      }
    })

    // 订阅会话执行/步骤/删除事件：维护看门狗定时器并按事件暂停目标
    yield* ctx.event
      .subscribe({
        types: [
          "session.execution.started",
          "session.execution.succeeded",
          "session.execution.interrupted",
          "session.execution.failed",
          "session.step.started",
          "session.step.ended",
          "session.deleted",
        ],
      })
      .pipe(
        // 对每个事件分发处理
        Stream.runForEach((event) => {
          // 取事件对应的会话 ID
          const sessionID = event.data.sessionID
          // 会话删除：移除定时器并删除目标存储
          if (event.type === "session.deleted")
            return FiberMap.remove(timers, sessionID).pipe(Effect.andThen(ctx.storage.remove(PREFIX + sessionID)))
          // 步骤开始/结束：视为活动，重置相关目标的看门狗
          if (event.type === "session.step.started" || event.type === "session.step.ended")
            return touch(sessionID).pipe(
              Effect.catchCause((cause) => Effect.logWarning("failed to note goal activity", { sessionID, cause })),
            )
          // 执行开始：移除该会话的看门狗（执行期间由 touch 维护）
          if (event.type === "session.execution.started") return FiberMap.remove(timers, sessionID)
          // 执行成功：可能进入空闲等待，启动看门狗
          if (event.type === "session.execution.succeeded")
            return watch(sessionID).pipe(
              Effect.catchCause((cause) => Effect.logWarning("failed to watch a waiting goal", { sessionID, cause })),
            )
          // Shutdown keeps the goal active; the next process sees the boot change and pauses it.
          // 非用户原因的中断（如服务关闭）：保持目标活跃，由下一进程的 boot 检查接管
          if (event.type === "session.execution.interrupted" && event.data.reason !== "user") return Effect.void
          // 执行失败或被用户停止：构造暂停原因
          const reason =
            event.type === "session.execution.failed"
              ? `The session failed: ${event.data.error.message}`
              : "Stopped by the user"
          // 暂停该会话的活跃目标；失败仅记警告
          return pauseActive(event.data.sessionID, reason).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to pause goal", { sessionID: event.data.sessionID, cause }),
            ),
          )
        }),
        // 立即启动并绑定当前作用域
        Effect.forkScoped({ startImmediately: true }),
      )

    // A goal an earlier process left active would show as running while nothing drives it, unless something wakes the
    // Session, so pause those now; the boot check in the hook covers any that wake first. Goals of Sessions deleted
    // while no instance listened are dropped. This assumes one server process per database: a second one would pause
    // the first one's live goals.
    // 启动时清理：把更早进程留下的活跃目标暂停（它们看起来在运行却无人驱动）；
    // 已删除会话的目标记录一并清除。前提是每个数据库只有一个服务进程
    yield* Effect.gen(function* () {
      // 分页游标
      let after: string | undefined
      // 分页扫描所有目标存储记录
      do {
        // 读取一页（100 条）
        const page = yield* ctx.storage.scan({ prefix: PREFIX, after, limit: 100 })
        // 逐条处理
        yield* Effect.forEach(
          page.entries,
          (entry) =>
            Effect.gen(function* () {
              // 尝试获取键对应的会话（按前缀长度截出会话 ID）
              const session = yield* ctx.session
                .get({ sessionID: Session.ID.make(entry.key.slice(PREFIX.length)) })
                .pipe(Effect.option)
              // 会话已不存在：删除目标记录
              if (Option.isNone(session)) return yield* ctx.storage.remove(entry.key)
              // 宽容解码目标状态
              const goal = Option.getOrUndefined(decodeState(entry.value))
              // 非活跃目标或属于本进程（boot 相同）则跳过
              if (goal?.status !== "active" || goal.boot === boot()) return
              // 更早进程留下的活跃目标：暂停
              yield* settle(session.value.id, goal, "paused", "The server restarted while the goal was active")
            }),
          { discard: true },
        )
        // 移动到下一页
        after = page.next
      } while (after !== undefined)
    }).pipe(
      // 清理失败仅记警告
      Effect.catchCause((cause) => Effect.logWarning("failed to pause goals left by an earlier process", { cause })),
      // 立即启动并绑定当前作用域
      Effect.forkScoped({ startImmediately: true }),
    )

    // 注册 /goal 命令：设置/暂停/恢复/清除目标
    yield* ctx.command.transform((editor) => {
      editor.add({
        // 命令名
        name: "goal",
        // 描述
        description: "keep working until an objective is met [pause|resume|clear]",
        // 执行逻辑
        execute: (input) =>
          Effect.gen(function* () {
            // 去引号并取命令文本
            const text = unquote(input.prompt.text.trim())
            // 小写形式的控制字（pause/resume/clear）
            const control = text.toLowerCase()
            // 读取当前目标
            const goal = yield* read(input.sessionID)
            // 空输入：报错并列出当前目标与用法
            if (text === "") return yield* Effect.fail(new Error(goal ? `${describe(goal)}\n${USAGE}` : USAGE))

            // pause：暂停活跃目标
            if (control === "pause") {
              // 没有活跃目标则报错
              if (goal?.status !== "active") return yield* Effect.fail(new Error("No active goal to pause."))
              // The user's command wins over the loop, so it writes without the loop's guard.
              // 用户命令优先于循环：绕过 replace 的并发守卫直接写入
              return yield* write(input.sessionID, {
                ...goal,
                status: "paused",
                reason: "Paused by the user",
                updatedAt: yield* Clock.currentTimeMillis,
              })
            }
            // resume：恢复暂停的目标
            if (control === "resume") {
              // 没有暂停中的目标则报错
              if (goal?.status !== "paused") return yield* Effect.fail(new Error("No paused goal to resume."))
              // 构造恢复后的状态
              const resumed: State = {
                id: goal.id,
                objective: goal.objective,
                status: "active",
                // The resume continuation is the first round of the new budget.
                // 恢复的续写算作新一轮预算的第 1 轮
                rounds: 1,
                maxRounds: goal.maxRounds,
                boot: boot(),
                updatedAt: yield* Clock.currentTimeMillis,
              }
              // 写入恢复状态
              yield* write(input.sessionID, resumed)
              // 注入"用户恢复了目标"的续写消息，驱动循环继续
              return yield* ctx.session.synthetic({
                sessionID: input.sessionID,
                text: continuation(resumed, ["The user resumed the goal."]),
                metadata: { source: "goal", goalID: resumed.id },
              })
            }
            // clear：清除目标
            if (control === "clear") {
              // 没有目标则报错
              if (!goal) return yield* Effect.fail(new Error("No goal is set."))
              // 写入 undefined 即删除
              return yield* write(input.sessionID, undefined)
            }

            // 目标描述超过长度限制则报错
            if (text.length > MAX_OBJECTIVE)
              return yield* Effect.fail(
                new Error(`A goal objective is limited to ${MAX_OBJECTIVE} characters (got ${text.length}).`),
              )
            // 构造新目标
            const created: State = {
              id: crypto.randomUUID(),
              objective: text,
              status: "active",
              rounds: 0,
              maxRounds: MAX_ROUNDS,
              boot: boot(),
              updatedAt: yield* Clock.currentTimeMillis,
            }
            // 写入新目标
            yield* write(input.sessionID, created)
            // 获取会话（用于命名）
            const session = yield* ctx.session.get({ sessionID: input.sessionID })
            // Titles come from the first user message, and a notice kickoff is not one, so name the Session here.
            // 会话标题仍是"首条用户消息"的占位时，用目标描述命名会话
            if (
              isExactRootFallback({
                title: session.title,
                time: { created: DateTime.toEpochMillis(session.time.created) },
              })
            )
              // 更新会话标题为截断后的目标描述
              yield* ctx.session.update({ sessionID: input.sessionID, title: truncate(text, 60) })
            // 渲染 kickoff 提示词
            const kickoff = render(KICKOFF, { objective: escape(text) })
            // 消息元数据：来源与目标 ID
            const metadata = { source: "goal", goalID: created.id }
            // 判断用户输入是否带有附件（文件/代理/技能）
            const attached = [input.prompt.files, input.prompt.agents, input.prompt.skills].some(
              (items) => items !== undefined && items.length > 0,
            )
            // Timelines show a described synthetic message as one notice row instead of the whole kickoff. Only a
            // prompt can carry attachments, so those still go through as the user's message.
            // 带附件时必须走 prompt 路径（只有提示消息能携带附件），以用户消息的形式发出
            if (attached)
              return yield* ctx.session.prompt({
                ...input.prompt,
                sessionID: input.sessionID,
                text: kickoff,
                metadata,
                delivery: input.delivery,
              })
            // 无附件时注入合成消息（时间线只显示一行摘要，不展开整个 kickoff）
            yield* ctx.session.synthetic({
              sessionID: input.sessionID,
              text: kickoff,
              description: `Goal: ${truncate(text, 120)}`,
              metadata,
              delivery: input.delivery,
            })
          }).pipe(Effect.asVoid),
      })
    })
  }),
})

// continuation：渲染续写提示词（目标 + 各项反馈拼接）
function continuation(goal: State, feedback: ReadonlyArray<string | undefined>) {
  return render(CONTINUATION, {
    objective: escape(goal.objective),
    // 过滤空反馈后按行拼接
    feedback: feedback.filter(Boolean).join("\n"),
  })
}

// Every goal prompt wraps the objective the same way, so this marks the objective as visible to the model.
// objectiveBlock：把目标包进统一的 untrusted 标签块（各提示词一致，用于检测历史中是否已含目标）
function objectiveBlock(objective: string) {
  return `<untrusted_objective>\n${escape(objective)}\n</untrusted_objective>`
}

// textOf：把消息中所有文本片段按行拼接（用于目标块匹配）
function textOf(message: Message) {
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
}

// sameReason：判断评审原因是否与上次相同（忽略大小写与空白差异，防止停滞误判）
function sameReason(previous: string | undefined, next: string) {
  // 归一化：去首尾空白、转小写、压缩连续空白
  const normalize = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ")
  // 上次无原因则不算相同
  return previous !== undefined && normalize(previous) === normalize(next)
}

// describe：生成目标的用户可读描述（状态 + 目标 + 原因）
function describe(goal: State) {
  // 按状态生成前缀文案
  const status = goal.status === "active" ? "Goal active" : goal.status === "paused" ? "Goal paused" : "Goal achieved"
  // 拼接目标与原因（过滤空行）
  return [`${status}: ${goal.objective}`, goal.reason].filter(Boolean).join("\n")
}

// Reviewers sometimes wrap the JSON in a code fence or add a sentence around it.
// parseVerdict：从评审应答文本中提取 JSON 结论（评审者可能用代码围栏或额外句子包裹）
function parseVerdict(text: string): Verdict | undefined {
  // 找第一个 "{"
  const start = text.indexOf("{")
  // 找最后一个 "}"
  const end = text.lastIndexOf("}")
  // 没有成对的花括号则无法解析
  if (start === -1 || end < start) return undefined
  // 截取花括号之间（含）的内容并宽容解码
  return Option.getOrUndefined(decodeVerdict(text.slice(start, end + 1)))
}

// `/goal "Ship the release"` and `/goal Ship the release` set the same objective.
// unquote：去掉目标描述两侧成对的引号（中英文引号均支持）
function unquote(text: string) {
  // 匹配"引号 + 内容 + 引号"的整体结构
  const quoted = /^(["'“‘])([\s\S]*)(["'”’])$/.exec(text)
  // 不匹配则原样返回
  if (!quoted) return text
  // 各开引号对应的闭引号映射
  const pairs: Record<string, string> = { '"': '"', "'": "'", "“": "”", "‘": "’" }
  // 引号成对才去引号并去空白，否则原样返回
  return pairs[quoted[1] ?? ""] === quoted[3] ? (quoted[2] ?? "").trim() : text
}

// One pass, so an objective that contains a placeholder is not expanded again.
// render：单遍模板替换（${key} -> 值），目标里含占位符也不会被二次展开
function render(template: string, values: Record<string, string>) {
  // 逐个占位符替换；未提供的键保留原文
  return template.replace(/\$\{(\w+)\}/g, (match, key: string) => values[key] ?? match)
}

// truncate：把文本压成单行并截断到指定长度（超长以省略号结尾）
function truncate(text: string, length: number) {
  // 压缩所有空白为单个空格
  const line = text.replace(/\s+/g, " ")
  // 超长则截断并加省略号
  return line.length > length ? `${line.slice(0, length - 1)}…` : line
}

// escape：HTML 转义目标文本（&、<、>），防止其被当作标记解析
function escape(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}
