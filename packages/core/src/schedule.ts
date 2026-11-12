// 将本模块以命名空间（namespace）形式导出为 Schedule
export * as Schedule from "./schedule.js"

// 导入 UUID 生成器，用于进程内领导者（leader）所有者 ID
import { randomUUID } from "node:crypto"
// 导入 drizzle-orm 的查询构建器与操作符
import { and, asc, eq, gt, isNull, lte, min, or, sql } from "drizzle-orm"
// 从 effect 导入 Cause、时钟、上下文、Cron、日期时间、Effect、门闩、Layer 等工具
import { Cause, Clock, Context, Cron, DateTime, Effect, Latch, Layer, Option, Result, Schedule as EffectSchedule, Schema } from "effect"
// 导入分层节点工具
import { Node, makeGlobalNode } from "@opencode/util/effect/app-node"
// 导入 LayerNode 类型
import { LayerNode } from "@opencode/util/effect/layer-node"
// 导入 Schedule 领域的 schema 类型与工具
import {
  Condition,
  ConditionInput,
  CreateInput,
  durationMillis,
  type Ends,
  ID,
  Info,
  Outcome,
  Request,
  Status,
  type StoredCheck,
  toCreateInput,
  When,
} from "@opencode/schema/schedule"
import { Config } from "./config.js"
// 导入数据库服务
import { Database } from "./database/database.js"
// 导入文件系统（异常）类型
import { FileSystem } from "./filesystem.js"
// 导入特性开关（Flag）解析器
import { Flag } from "./flag.js"
// 导入实例（Instance）服务
import { Instance } from "./instance/service.js"
// 导入 KV 表（用于领导者租约）
import { KVTable } from "./kv/sql.js"
// 导入权限错误类型
import type { Permission } from "./permission.js"
// 导入会话（Session）服务
import { Session } from "./session.js"
// 导入会话执行服务
import { SessionExecution } from "./session/execution.js"
// 导入会话消息模块
import { SessionMessage } from "./session/message.js"
// 导入会话 schema
import { SessionSchema } from "./session/schema.js"
// 导入会话收件箱表
import { SessionInboxTable } from "./session/sql.js"
// 导入定时检查（ScheduleCheck）模块
import { ScheduleCheck } from "./schedule/check.js"
// 导入定时任务表
import { ScheduleTable } from "./schedule/sql.js"

// 转发导出 schema 中的核心类型与工具
export { ID, Info, CreateInput, Request, Condition, ConditionInput, When, Status, Outcome, toCreateInput }

// 定时任务不存在错误
export class NotFoundError extends Schema.TaggedError<NotFoundError>()("Schedule.NotFoundError", {
  scheduleID: ID,
}) {
  // 自定义错误消息
  override get message() {
    return `Schedule not found: ${this.scheduleID}`
  }
}

// 输入非法错误
export class InvalidError extends Schema.TaggedError<InvalidError>()("Schedule.InvalidError", {
  reason: Schema.String,
}) {
  // 消息即失败原因
  override get message() {
    return this.reason
  }
}

// 定时任务功能被禁用错误
export class DisabledError extends Schema.TaggedError<DisabledError>()("Schedule.DisabledError", {}) {
  override get message() {
    return "Scheduled tasks are disabled; set experimental.schedules in config"
  }
}

// 服务接口：定时任务的完整生命周期与运行循环
export interface Interface {
  // 创建定时任务
  readonly create: (
    input: CreateInput,
  ) => Effect.Effect<Info, InvalidError | DisabledError | Session.NotFoundError | Permission.Error>
  // 列出定时任务（可按会话过滤）
  readonly list: (input?: { readonly sessionID?: SessionSchema.ID }) => Effect.Effect<Info[]>
  // 按 ID 读取
  readonly get: (id: ID) => Effect.Effect<Info, NotFoundError>
  // 暂停
  readonly pause: (id: ID) => Effect.Effect<Info, NotFoundError>
  // 恢复
  readonly resume: (id: ID) => Effect.Effect<Info, NotFoundError>
  // 删除
  readonly remove: (id: ID) => Effect.Effect<void, NotFoundError>
  /** Whether experimental.schedules is on in the config where the Session lives. */
  // 查询某会话所在位置的配置是否开启了定时任务
  readonly enabled: (sessionID: SessionSchema.ID) => Effect.Effect<boolean, Session.NotFoundError>
  /** Fires every schedule that is due now, at most once each. */
  // 触发当前所有到期的定时任务，每个至多一次
  readonly tick: Effect.Effect<void>
  /**
   * Runs `tick` whenever a schedule falls due, until interrupted. Elects at most one active leader per SQLite
   * database via a lease row, so auxiliary processes (`opencode acp`, `--standalone`) sharing a data directory
   * never double-fire alongside a managed service.
   */
  // 在定时任务到期时运行 tick，直到被中断；通过租约行在每库选举至多一个
  // 活跃领导者，避免共享数据目录的辅助进程与托管服务重复触发
  readonly run: Effect.Effect<never>
}

// 定义 Schedule 服务
export class Service extends Context.Service<Service, Interface>()("@opencode/Schedule") {}

// 数据库行类型（由表结构推导）
type Row = typeof ScheduleTable.$inferSelect

// 一分钟的毫秒数
const MINUTE = 60_000
// 一小时的毫秒数
const HOUR = 60 * MINUTE
// “每 X”重复的最小间隔：1 分钟
const MIN_INTERVAL = MINUTE
// 带条件检查时的最小重复间隔：15 秒
const MIN_CHECK_INTERVAL = 15_000
// 未指定 when 且使用 until 时的默认重复频率：每 30 秒
const DEFAULT_UNTIL_EVERY: When = { type: "every", every: "30 seconds" }
// until 模式未显式指定结束时间的默认超时时长：24 小时
const DEFAULT_UNTIL_AFTER = 24 * HOUR
/** A firing this far past its due time is marked late. */
// 比到期时间晚这么多才触发的，被标记为“迟发（late）”
const LATE_AFTER = 60_000
/** The loop re-reads the table at least this often, so clock jumps and missed doorbells are caught. */
// 循环至少隔这么久重读一次表，以捕捉时钟跳变与错过的门铃信号
const MAX_SLEEP = 30_000
// 领导者租约在 KV 表中的键
const LEADER_KEY = "schedule:leader"
// 领导者租约 TTL：两倍最大睡眠
const LEADER_TTL = 2 * MAX_SLEEP
/** How long a due schedule waits before its location's flag is read again, while schedules are off there. */
// 定时任务在其位置上被禁用时，等待多久后重读该位置开关
const DISABLED_RETRY = HOUR
/** How long a schedule whose prompt failed waits before trying again. */
// 提示（prompt）投递失败的定时任务等待多久后重试
const FAILED_RETRY = 5 * MINUTE
/** How long a schedule whose check failed waits before trying again, up to MAX_CHECK_FAILURES. */
// 条件检查失败的定时任务等待多久后重试（最多 MAX_CHECK_FAILURES 次）
const CHECK_FAILED_RETRY = MINUTE
// 条件检查允许的连续失败次数上限
const MAX_CHECK_FAILURES = 3
// 单次 tick 内并发处理的任务数上限
const TICK_CONCURRENCY = 4
// 未播种（unseeded）的检查状态：尚未匹配、无状态、0 次检查
const UNSEEDED = { matched: false as const, state: null as Schema.Json, checks: 0 }

// 解析并校验时长字符串：非法或非正数时报 InvalidError
const duration = (value: string) =>
  Option.match(durationMillis(value), {
    // 无法解析则失败
    onNone: () => Effect.fail(new InvalidError({ reason: `Invalid duration: ${value}` })),
    // 能解析但必须为正数
    onSome: (millis) =>
      millis > 0
        ? Effect.succeed(millis)
        : Effect.fail(new InvalidError({ reason: `Duration must be positive: ${value}` })),
  })

/** Stored durations were validated on create. */
// 解析已入库的时长字符串（创建时已校验，失败即抛致命错误）
const millis = (value: string) =>
  Option.getOrThrowWith(durationMillis(value), () => new Error(`Invalid duration: ${value}`))

// 匹配带 UTC 标记 z 或带时区偏移（±hh:mm）结尾的时间字符串
const OFFSET = /\d(?:z|[+-]\d{2}:?\d{2})$/i

/** Parses an instant with an offset, or a wall-clock time in `zone`. */
// 解析时间点：带偏移的按绝对时刻解析；否则按 zone 中的墙上时间（wall-clock）解析
const parseAt = (input: string, zone: DateTime.TimeZone) =>
  Option.map(
    OFFSET.test(input) ? DateTime.make(input) : DateTime.makeZoned(input, { timeZone: zone, adjustForTimeZone: true }),
    DateTime.toEpochMillis,
  )

// 将 Cron.next 包装为返回 Option 的安全函数
const cronNext = Option.liftThrowable(Cron.next)

/**
 * The first slot strictly after `now`, or undefined if the expression never matches a date. When clocks fall back,
 * Cron.next maps a repeated wall-clock time to its first occurrence, which is already past during the repeated hour,
 * so no slot fires twice: step past each such slot until one lands after `now`.
 */
// 求严格晚于 now 的第一个 cron 槽位；表达式永不相配则 undefined。
// 时钟回拨时 Cron.next 会把重复的墙上时间映射到第一次出现，而该时刻在重复小时
// 内已过去，故同一槽位不会触发两次：逐个跳过直到槽位落在 now 之后
const nextCron = (cron: Cron.Cron, now: number, from = now): number | undefined => {
  // 计算从 from 起的下一个匹配时刻
  const next = cronNext(cron, new Date(from))
  // 永不匹配则返回 undefined
  if (Option.isNone(next)) return undefined
  // 取毫秒时间戳
  const at = next.value.getTime()
  // 已晚于 now 即为目标槽位；否则跳过该槽继续向后找
  return at > now ? at : nextCron(cron, now, at + HOUR)
}

/** The first slot strictly after `now`, or undefined for one-shots. */
// 计算行的下一次到期时刻：严格晚于 now；一次性任务返回 undefined
const following = (row: Pick<Row, "when" | "tz" | "next_due_at">, now: number) => {
  // 按调度类型分支
  switch (row.when.type) {
    // 一次性任务没有“下一次”
    case "in":
    case "at":
      return undefined
    case "every": {
      // Keep the phase: skip every missed slot rather than firing them in a burst.
      // 读取重复间隔
      const every = millis(row.when.every)
      // 以记录的到期时间为相位基准，缺省用当前时间
      const due = row.next_due_at ?? now
      // 保持相位：跳过错过的槽位而不是一次性补发
      return due + (Math.floor((now - due) / every) + 1) * every
    }
    case "cron":
      // cron 类型按表达式与时区求下一次
      return nextCron(Cron.parseUnsafe(row.when.cron, row.tz), now)
  }
}

// 判断任务是否已经结束：无下一次、剩余次数用尽、或下一次超过结束时间
const finished = (row: Pick<Row, "ends_at">, next: number | undefined, remaining: number | null) =>
  next === undefined || (remaining !== null && remaining <= 0) || (row.ends_at !== null && next > row.ends_at)

// 将毫秒时间戳转为 DateTime；null 转为 undefined
const optionalTime = (value: number | null) => (value === null ? undefined : DateTime.makeUnsafe(value))

// 组装发送给会话的文本：提示词 + 可选附加消息
const promptText = (prompt: string, message: string | undefined) => {
  // 消息为空白时只发提示词
  if (!message?.trim()) return prompt
  // 否则用空行连接
  return `${prompt}\n\n${message}`
}

// 解析并校验创建输入中的 if/until 条件，产出待存储的检查（check）配置
const resolveStoredCheck = (input: CreateInput): Effect.Effect<StoredCheck | undefined, InvalidError> => {
  // if 与 until 互斥
  if (input.if !== undefined && input.until !== undefined)
    return Effect.fail(new InvalidError({ reason: "Choose either if or until, not both" }))
  // 按输入构造检查配置：优先 if，其次 until，都没有则 undefined
  const check: StoredCheck | undefined =
    input.if !== undefined
      ? { mode: "if", condition: input.if }
      : input.until !== undefined
        ? { mode: "until", condition: input.until }
        : undefined
  // 无检查配置则直接成功
  if (check === undefined) return Effect.succeed(undefined)
  // 校验条件表达式的合法性
  const validated = ScheduleCheck.validate(check.condition)
  // 校验失败则报 InvalidError
  if (Result.isFailure(validated)) return Effect.fail(new InvalidError({ reason: validated.failure }))
  // 返回合法的检查配置
  return Effect.succeed(check)
}

// 将数据库行映射为对外的 Info 对象；可附带最后一次输出
const toInfo = (row: Row, lastOutput?: string): Info => ({
  id: row.id,
  // 关联会话 ID（可能为空）
  sessionID: row.session_id ?? undefined,
  // 任务名称（可能为空）
  name: row.name ?? undefined,
  // 调度规则
  when: row.when,
  // 时区
  tz: row.tz,
  // if 模式时输出条件
  if: row.check?.mode === "if" ? row.check.condition : undefined,
  // until 模式时输出条件
  until: row.check?.mode === "until" ? row.check.condition : undefined,
  // 动作（提示词等）
  action: row.action,
  // 状态
  status: row.status,
  // 下次到期时间
  nextDueAt: optionalTime(row.next_due_at),
  // 结束时间
  endsAt: optionalTime(row.ends_at),
  // 剩余运行次数
  remainingRuns: row.remaining_runs ?? undefined,
  // 已运行次数
  runCount: row.run_count,
  // 上次触发时间
  lastFiredAt: optionalTime(row.last_fired_at),
  // 上次结果
  lastOutcome: row.last_outcome ?? undefined,
  // 最后输出仅在存在时加入
  ...(lastOutput === undefined ? {} : { lastOutput }),
  // 创建与更新时间
  time: { created: DateTime.makeUnsafe(row.time_created), updated: DateTime.makeUnsafe(row.time_updated) },
})

// 服务实现层
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 依赖：数据库服务
    const database = yield* Database.Service
    // 取底层 drizzle 实例
    const db = database.db
    // 依赖：会话服务
    const sessions = yield* Session.Service
    // 依赖：实例服务（按会话位置提供配置）
    const instances = yield* Instance.Service
    // 依赖：会话执行服务（用于唤醒会话）
    const execution = yield* SessionExecution.Service
    // 创建门铃（doorbell latch）：新建/恢复任务时唤醒循环
    const doorbell = yield* Latch.make()

    // Config is per location, so a schedule follows the config where its Session lives.
    // 读取某会话所在位置的定时任务配置：是否启用 + 时区
    const settings = (session: SessionSchema.Info) =>
      Effect.gen(function* () {
        const config = yield* Config.Service
        const flags = yield* Flag.Service
        const entries = yield* config.entries()
        return {
          enabled: flags.resolve(entries).schedules.enabled,
          timezone: Config.latest(entries, "timezone"),
        }
      }).pipe(instances.provide(session))

    // 按 ID 查询单行；不存在时报 NotFoundError
    const find = (id: ID) =>
      db
        .select()
        .from(ScheduleTable)
        .where(eq(ScheduleTable.id, id))
        .get()
        .pipe(
          // 数据库异常视为致命
          Effect.orDie,
          Effect.flatMap((row) => (row ? Effect.succeed(row) : Effect.fail(new NotFoundError({ scheduleID: id })))),
        )

    // 更新行（仅限仍为 active 状态的任务）；数据库异常视为致命
    const update = (row: Row, values: Partial<Row>) =>
      db
        .update(ScheduleTable)
        .set(values)
        .where(and(eq(ScheduleTable.id, row.id), eq(ScheduleTable.status, "active")))
        .run()
        .pipe(Effect.orDie)

    // 检查某条收件箱消息是否仍待处理（存在即视为 pending）
    const pending = (id: SessionMessage.ID) =>
      db
        .select({ id: SessionInboxTable.id })
        .from(SessionInboxTable)
        .where(eq(SessionInboxTable.id, id))
        .get()
        .pipe(
          Effect.orDie,
          Effect.map((row) => row !== undefined),
        )

    // 向会话注入（admit）一次唤醒消息，返回消息 ID
    const admitWake = Effect.fnUntraced(function* (
      row: Row,
      sessionID: SessionSchema.ID,
      run: number,
      due: number,
      late: boolean,
      text: string,
      checkMeta?: Record<string, unknown>,
    ) {
      // The id is derived from `run_count`, so retrying after a crash reconciles with the earlier admission.
      // 消息 ID 由 run_count 推导，崩溃重试后与之前的注入天然幂等
      const id = SessionMessage.ID.make(`msg_${row.id}_${run}`)
      // 以 steer 方式向会话发送提示文本与调度元数据
      yield* sessions.prompt({
        sessionID,
        id,
        text,
        delivery: "steer",
        metadata: {
          schedule: {
            id: row.id,
            name: row.name ?? undefined,
            run,
            dueAt: due,
            late,
            // 检查元数据仅在存在时加入
            ...(checkMeta === undefined ? {} : { check: checkMeta }),
          },
        },
      })
      // 返回消息 ID
      return id
    })

    // 触发单条任务：评估条件检查、决定唤醒或更新状态
    const fire = Effect.fnUntraced(function* (row: Row, session: SessionSchema.Info, due: number, now: number) {
      // 判断是否迟发（超过 LATE_AFTER）
      const late = now - due >= LATE_AFTER
      // 预计算下一次到期时刻
      const next = following(row, now)

      // 读取行的检查配置
      const check = row.check
      // 评估结果：无检查时视为直接唤醒；否则运行条件检查
      const outcome: ScheduleCheck.Outcome =
        check === null
          ? { ok: true, wake: true, state: null }
          : yield* ScheduleCheck.evaluate(session, check, row.state ?? null, {
              // 检查消息 ID（按检查次数编号）
              messageID: SessionMessage.ID.make(`msg_${row.id}_check_${row.checks + 1}`),
              now,
              checks: row.checks,
            }).pipe(instances.provide(session))

      // 检查执行失败分支
      if (!outcome.ok) {
        // 累计失败次数
        const strikes = row.failures + 1
        // 条件本身合法且未达上限：安排稍后重试
        if (!outcome.invalid && strikes < MAX_CHECK_FAILURES) {
          yield* update(row, {
            failures: strikes,
            last_outcome: "failed",
            retry_at: now + CHECK_FAILED_RETRY,
            time_updated: now,
          })
          return
        }
        // 递增运行计数（失败也会占用一次运行）
        const run = row.run_count + 1
        // 生成暂停说明：条件非法或连续失败达上限
        const note = outcome.invalid
          ? `[Schedule paused after invalid check: ${outcome.error}]`
          : `[Schedule paused after ${strikes} failed checks: ${outcome.error}]`
        // 注入带说明的唤醒消息
        const id = yield* admitWake(
          row,
          session.id,
          run,
          due,
          late,
          `${row.action.prompt}\n\n${note}`,
          { error: outcome.error, failures: strikes },
        )
        // 将任务置为 paused，并记录失败与消息信息
        yield* db
          .update(ScheduleTable)
          .set({
            status: "paused",
            failures: strikes,
            run_count: run,
            last_message_id: id,
            last_fired_at: now,
            last_outcome: "failed",
            retry_at: null,
            time_updated: now,
          })
          .where(eq(ScheduleTable.id, row.id))
          .run()
          .pipe(Effect.orDie)
        return
      }

      // 检查成功但不需要唤醒的分支（条件尚未满足）
      if (check !== null && !outcome.wake) {
        // 递增检查次数
        const checks = row.checks + 1
        // 判断是否已到终点（无下一次或下一次超过结束时间）
        const ended = next === undefined || (row.ends_at !== null && next > row.ends_at)
        // until 模式且已到终点：任务超时未匹配，记为 done/expired
        if (check.mode === "until" && ended) {
          const run = row.run_count + 1
          // 注入超时说明的唤醒消息
          const id = yield* admitWake(
            row,
            session.id,
            run,
            due,
            late,
            `${row.action.prompt}\n\n[Schedule timed out without matching: ${ScheduleCheck.describe(check.condition)}]`,
            { expired: true },
          )
          // 状态置为 done，清空到期时间与剩余次数
          yield* db
            .update(ScheduleTable)
            .set({
              status: "done",
              checks,
              failures: 0,
              state: outcome.state,
              run_count: run,
              last_message_id: id,
              last_fired_at: now,
              last_outcome: "expired",
              next_due_at: null,
              remaining_runs: 0,
              retry_at: null,
              time_updated: now,
            })
            .where(eq(ScheduleTable.id, row.id))
            .run()
            .pipe(Effect.orDie)
          return
        }
        // 未结束：记录检查结果并推进到期时间（或标记结束）
        yield* update(row, {
          checks,
          failures: 0,
          state: outcome.state,
          last_outcome: "checked",
          retry_at: null,
          ...(ended ? { status: "done" as const, next_due_at: null } : { next_due_at: next }),
          time_updated: now,
        })
        return
      }

      // 正式触发分支：注入唤醒消息
      const run = row.run_count + 1
      const id = yield* admitWake(
        row,
        session.id,
        run,
        due,
        late,
        promptText(row.action.prompt, outcome.message),
        check === null ? undefined : outcome.message === undefined ? {} : { message: outcome.message },
      )
      // 计算剩余次数：until 模式固定为 0；否则递减（null 表示不限次）
      const remaining = check?.mode === "until" ? 0 : row.remaining_runs === null ? null : row.remaining_runs - 1
      // 判断任务是否就此完成：until 模式触发即完成；或次数/时间已用尽
      const done = check?.mode === "until" || finished(row, next, remaining)
      // Record the run even if a pause landed during the prompt, or the next firing would reuse this message id.
      // 即使注入期间任务被暂停也记录本次运行，否则下次触发会复用同一消息 ID
      yield* db
        .update(ScheduleTable)
        .set({
          run_count: run,
          // 有检查时递增检查计数、清零失败并保存检查状态
          ...(check === null ? {} : { checks: row.checks + 1, failures: 0, state: outcome.state }),
          last_message_id: id,
          last_fired_at: now,
          // 迟发时记录为 late
          last_outcome: late ? "late" : "fired",
          retry_at: null,
          remaining_runs: remaining,
          // 完成则置为 done
          ...(done ? { status: "done" as const } : {}),
          // 完成时清空到期时间，否则写入下一次
          next_due_at: done ? null : next,
          time_updated: now,
        })
        .where(eq(ScheduleTable.id, row.id))
        .run()
        .pipe(Effect.orDie)
    })

    // 单条到期任务的处理步骤：租约 -> 配置 -> 防重 -> 触发
    const step = Effect.fnUntraced(function* (row: Row, now: number) {
      // 读取到期时间
      const due = row.next_due_at
      // 无到期时间或无关联会话则跳过
      if (due === null || row.session_id === null) return
      // 未抢到领导者（leader）租约则跳过（由别的进程处理）
      if (!(yield* claimLeader(yield* Clock.currentTimeMillis))) return
      // 获取关联会话
      const session = yield* sessions.get(row.session_id)
      // 会话位置上禁用了定时任务
      if (!(yield* settings(session)).enabled) {
        // Reading the flag boots the Session's location, so check again in an hour rather than every tick. The row
        // keeps its due time, so once the flag is back on it catches up like any missed slot.
        // 读开关会引导加载该位置，改为 1 小时后重试；行保留到期时间，
        // 开关恢复后按错过槽位的规则追平
        yield* update(row, { last_outcome: "disabled", retry_at: now + DISABLED_RETRY, time_updated: now })
        return
      }
      // 上次的唤醒消息仍在收件箱中待处理
      if (row.last_message_id !== null && (yield* pending(row.last_message_id))) {
        // The wake that followed admission may have been lost; waking again is harmless.
        // 重复唤醒是无害的（幂等）
        yield* execution.wake(session.id)
        // 重新计算下一次到期
        const next = following(row, now)
        // 判断是否已完成
        const done = finished(row, next, row.remaining_runs)
        // 记录为 skipped 并推进状态
        yield* update(row, {
          last_outcome: "skipped",
          retry_at: null,
          status: done ? "done" : "active",
          next_due_at: done ? null : next,
          time_updated: now,
        })
        return
      }
      // 正常触发
      yield* fire(row, session, due, now)
    })

    // 一次 tick：查询所有到期任务并并发处理
    const tickAt = Effect.fnUntraced(function* (now: number) {
      // 查询到期且允许重试的任务，按到期时间排序
      const due = yield* db
        .select()
        .from(ScheduleTable)
        .where(
          and(
            eq(ScheduleTable.status, "active"),
            lte(ScheduleTable.next_due_at, now),
            or(isNull(ScheduleTable.retry_at), lte(ScheduleTable.retry_at, now)),
          ),
        )
        .orderBy(asc(ScheduleTable.next_due_at))
        .all()
        .pipe(Effect.orDie)
      // 并发处理每条到期任务
      yield* Effect.forEach(
        due,
        (row) =>
          step(row, now).pipe(
            Effect.catchCause((cause) => {
              // 仅被中断时保持中断语义
              if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
              if (Cause.squash(cause) instanceof FileSystem.DirectoryNotFoundError) {
                // The Session's folder (e.g. a removed worktree) is gone; pause rather than retrying every 5 minutes.
                // 会话目录（如被移除的 worktree）不存在，直接暂停而不是反复重试
                return update(row, {
                  status: "paused",
                  last_outcome: "failed",
                  retry_at: null,
                  time_updated: now,
                })
              }
              // Back off rather than retrying a failing prompt on every tick.
              // 其他失败退避重试，而不是每个 tick 都重试
              return Effect.logWarning("schedule failed to fire", { scheduleID: row.id, cause }).pipe(
                Effect.andThen(
                  update(row, { last_outcome: "failed", retry_at: now + FAILED_RETRY, time_updated: now }),
                ),
              )
            }),
          ),
        { discard: true, concurrency: due.length > 1 ? TICK_CONCURRENCY : 1 },
      )
    }, Effect.withSpan("Schedule.tick"))

    // 无参 tick：取当前时间后调用 tickAt
    const tick = Effect.flatMap(Clock.currentTimeMillis, tickAt)

    // Rows due by `from` that could not fire (a failed prompt, a retry_at not yet reached) are rechecked after at most
    // MAX_SLEEP, not in a spin.
    // 计算下一次唤醒等待：取未来最近的到期时间，但最长不超过 MAX_SLEEP
    const nextWake = Effect.fnUntraced(function* (from: number) {
      // 查询 active 任务中最早的未来到期时间
      const row = yield* db
        .select({ at: min(ScheduleTable.next_due_at) })
        .from(ScheduleTable)
        .where(and(eq(ScheduleTable.status, "active"), gt(ScheduleTable.next_due_at, from)))
        .get()
        .pipe(Effect.orDie)
      // 没有未来到期任务则睡满 MAX_SLEEP
      if (row?.at == null) return MAX_SLEEP
      // 等待到期时间的剩余量，夹在 [0, MAX_SLEEP]
      return Math.max(0, Math.min(MAX_SLEEP, row.at - (yield* Clock.currentTimeMillis)))
    })

    // A crash between admitting a prompt and its Session claiming the work leaves the prompt unclaimed and the
    // Session asleep, so wake every Session whose last scheduled prompt is still pending.
    // 崩溃恢复：唤醒所有最后一次调度提示仍待处理的会话
    const rewake = db
      .selectDistinct({ sessionID: ScheduleTable.session_id })
      .from(ScheduleTable)
      .innerJoin(SessionInboxTable, eq(SessionInboxTable.id, ScheduleTable.last_message_id))
      .all()
      .pipe(
        Effect.orDie,
        Effect.flatMap((rows) =>
          // 逐个唤醒关联会话（无会话的行跳过）
          Effect.forEach(rows, (row) => (row.sessionID === null ? Effect.void : execution.wake(row.sessionID)), {
            discard: true,
          }),
        ),
      )

    // 检查是否存在 active 状态的定时任务
    const hasActiveRows = db
      .select({ id: ScheduleTable.id })
      .from(ScheduleTable)
      .where(eq(ScheduleTable.status, "active"))
      .limit(1)
      .get()
      .pipe(
        Effect.orDie,
        Effect.map((row) => row !== undefined),
      )

    // 本进程的领导者所有者 ID（每次启动随机生成）
    const ownerID = randomUUID()
    // 是否当前持有领导者身份
    let leading = false
    // 是否已经完成过一次启动检查
    let bootChecked = false

    // 抢占领导者租约：插入或更新 KV 行，仅当自己是所有者或租约过期时成功
    const claimLeader = Effect.fnUntraced(function* (now: number) {
      // 构造租约值：所有者 + 过期时间
      const value = { owner: ownerID, until: now + LEADER_TTL }
      // upsert：冲突时仅在所有者匹配或租约已过期时更新
      const claimed = yield* db
        .insert(KVTable)
        .values({ key: LEADER_KEY, value, time_created: now, time_updated: now })
        .onConflictDoUpdate({
          target: KVTable.key,
          set: { value, time_updated: now },
          where: sql`json_extract(${KVTable.value}, '$.owner') = ${ownerID} or json_extract(${KVTable.value}, '$.until') <= ${now}`,
        })
        .returning({ key: KVTable.key })
        .get()
        .pipe(Effect.orDie)
      // 有返回行即表示抢占成功
      return claimed !== undefined
    })

    // 释放领导者：清除内存标记并删除本进程持有的租约行
    const releaseLeader = Effect.sync(() => {
      leading = false
    }).pipe(
      Effect.andThen(
        db
          .delete(KVTable)
          .where(and(eq(KVTable.key, LEADER_KEY), sql`json_extract(${KVTable.value}, '$.owner') = ${ownerID}`))
          .run()
          .pipe(Effect.ignore),
      ),
    )

    // 心跳：以租约 TTL 的 1/3 周期反复续租
    const heartbeat = Clock.currentTimeMillis.pipe(
      Effect.flatMap(claimLeader),
      Effect.ignore,
      Effect.schedule(EffectSchedule.spaced(LEADER_TTL / 3)),
    )

    // 主循环单次迭代：检查任务、竞选领导、触发 tick、计算下次等待
    const loop = Effect.gen(function* () {
      // 消费掉待处理的门铃信号
      yield* doorbell.close
      // 查询是否存在 active 任务
      const active = yield* hasActiveRows
      // 无任务且已做过启动检查：释放领导权并等待门铃/超时
      if (!active && bootChecked) {
        if (leading) yield* releaseLeader
        yield* doorbell.await.pipe(Effect.timeoutOption(MAX_SLEEP))
        return
      }
      // 取当前时间
      const now = yield* Clock.currentTimeMillis
      // 尝试竞选领导者
      const isLeader = yield* claimLeader(now)
      // 竞选失败：让位并等待
      if (!isLeader) {
        leading = false
        bootChecked = true
        yield* doorbell.await.pipe(Effect.timeoutOption(MAX_SLEEP))
        return
      }
      // 首次成为领导者：执行一次崩溃恢复唤醒
      if (!leading) {
        leading = true
        bootChecked = true
        yield* rewake.pipe(Effect.catchCause((cause) => Effect.logError("schedule rewake failed", { cause })))
      }
      // 成为领导者但没有任何任务：释放租约并等待
      if (!active) {
        yield* releaseLeader
        yield* doorbell.await.pipe(Effect.timeoutOption(MAX_SLEEP))
        return
      }
      // 有任务：在作用域内同时启动心跳与本次 tick
      yield* Effect.scoped(
        Effect.forkScoped(heartbeat).pipe(
          Effect.andThen(
            tickAt(now).pipe(Effect.catchCause((cause) => Effect.logError("schedule tick failed", { cause }))),
          ),
        ),
      )
      // tick 后重新检查是否还有任务
      if (!(yield* hasActiveRows)) {
        yield* releaseLeader
        yield* doorbell.await.pipe(Effect.timeoutOption(MAX_SLEEP))
        return
      }
      // 计算下一次唤醒等待
      const wait = yield* nextWake(now)
      // 等待门铃信号或超时
      if (wait > 0) yield* doorbell.await.pipe(Effect.timeoutOption(wait))
    })

    // run：无限循环执行 loop，退出时保证释放领导者租约
    const run = Effect.forever(loop).pipe(Effect.ensuring(releaseLeader))

    // 解析时区：未指定时用本地时区；未知时区报错
    const resolveZone = (tz: string | undefined) => {
      if (tz === undefined) return Effect.succeed(DateTime.zoneMakeLocal())
      return Option.match(DateTime.zoneMakeNamed(tz), {
        onNone: () => Effect.fail(new InvalidError({ reason: `Unknown time zone: ${tz}` })),
        onSome: Effect.succeed,
      })
    }

    // 计算首次到期时间（按调度类型）
    const firstDue = Effect.fnUntraced(function* (
      when: When,
      hasCheck: boolean,
      zone: DateTime.TimeZone,
      now: number,
    ) {
      // 按类型分支
      switch (when.type) {
        // “in N”：现在加时长
        case "in":
          return now + (yield* duration(when.in))
        case "at": {
          // “at 时刻”：解析绝对时间
          const at = parseAt(when.at, zone)
          // 无法解析则报错
          if (Option.isNone(at)) return yield* new InvalidError({ reason: `Invalid time: ${when.at}` })
          // 不能是过去的时间
          if (at.value <= now) return yield* new InvalidError({ reason: `Time is in the past: ${when.at}` })
          return at.value
        }
        case "every": {
          // “every N”：解析并校验间隔
          const every = yield* duration(when.every)
          // 带检查时允许更小的间隔
          const minInterval = hasCheck ? MIN_CHECK_INTERVAL : MIN_INTERVAL
          if (every < minInterval) {
            return yield* new InvalidError({
              reason: hasCheck ? "every must be at least 15 seconds" : "every must be at least 1 minute",
            })
          }
          // 首次到期即下一个间隔
          return now + every
        }
        case "cron": {
          // “cron 表达式”：解析并校验
          const cron = Cron.parse(when.cron, zone)
          // 解析失败报错
          if (Result.isFailure(cron)) return yield* new InvalidError({ reason: cron.failure.message })
          // 秒位必须唯一，即至多每分钟触发一次
          if (cron.success.seconds.size !== 1)
            return yield* new InvalidError({ reason: "cron must fire at most once a minute" })
          // 计算首个匹配槽位
          const next = nextCron(cron.success, now)
          // 永不匹配则报错
          if (next === undefined) return yield* new InvalidError({ reason: `cron never fires: ${when.cron}` })
          return next
        }
      }
    })

    // 计算结束时间（ends）：支持 after（相对时长）与 at（绝对时刻）
    const endsAt = Effect.fnUntraced(function* (
      ends: Ends | undefined,
      isUntil: boolean,
      zone: DateTime.TimeZone,
      now: number,
    ) {
      // 解析相对结束时长
      const after = ends?.after === undefined ? undefined : now + (yield* duration(ends.after))
      // 未指定绝对结束时刻
      if (ends?.at === undefined) {
        // 有相对时长则以之为准
        if (after !== undefined) return after
        // until 模式默认 24 小时后结束；普通任务不设结束
        return isUntil ? now + DEFAULT_UNTIL_AFTER : null
      }
      // 解析绝对结束时刻
      const at = parseAt(ends.at, zone)
      // 无法解析则报错
      if (Option.isNone(at)) return yield* new InvalidError({ reason: `Invalid time: ${ends.at}` })
      // 同时指定时取较早者
      return Math.min(at.value, after ?? at.value)
    })

    // 组装并返回服务实现
    return Service.of({
      // 创建定时任务：校验输入、播种检查状态并写入数据库
      create: Effect.fn("Schedule.create")(function* (input) {
        // 获取关联会话
        const session = yield* sessions.get(input.sessionID)
        // 会话目录不存在的错误构造器
        const missingDirectory = () =>
          Effect.fail(new InvalidError({ reason: `Session directory does not exist: ${session.location.directory}` }))
        // 读取会话位置的配置（目录缺失时报错）
        const config = yield* settings(session).pipe(
          Effect.catchTag("FileSystem.DirectoryNotFoundError", missingDirectory),
        )
        // 该位置禁用定时任务
        if (!config.enabled) return yield* new DisabledError()
        // 解析 if/until 条件
        const check = yield* resolveStoredCheck(input)
        // 未指定 when 时：until 模式给默认频率，否则必填
        const when = input.when ?? (check?.mode === "until" ? DEFAULT_UNTIL_EVERY : undefined)
        if (when === undefined)
          return yield* new InvalidError({ reason: "when is required unless until is set" })
        // 解析时区：优先 when 自带，其次配置
        const zone = yield* resolveZone(when.tz ?? config.timezone)
        // 取当前时间
        const now = yield* Clock.currentTimeMillis
        // 计算首次到期时间
        const due = yield* firstDue(when, check !== undefined, zone, now)
        // 限定运行次数至少为 1
        if (input.ends?.times !== undefined && input.ends.times < 1)
          return yield* new InvalidError({ reason: "ends.times must be at least 1" })
        // 计算结束时间
        const ends = yield* endsAt(input.ends, check?.mode === "until", zone, now)
        // 结束时间必须晚于首次触发
        if (ends !== null && due > ends)
          return yield* new InvalidError({ reason: "The schedule ends before it first fires" })

        // 生成任务 ID
        const scheduleID = ID.create()
        // 播种（seed）检查状态：立即运行一次条件检查以建立基线
        const seeded =
          // 无检查配置时使用未播种状态
          check === undefined
            ? UNSEEDED
            : yield* Effect.gen(function* () {
                // 对检查条件执行权限校验
                yield* ScheduleCheck.authorize(session, input.name, when, check).pipe(
                  instances.provide(session),
                  Effect.mapError((error) => (typeof error === "string" ? new InvalidError({ reason: error }) : error)),
                  Effect.catchTag("FileSystem.DirectoryNotFoundError", missingDirectory),
                )
                // 判断是否需要播种：until / code 检查 / 开启变更检测的 shell 检查
                const shouldSeed =
                  check.mode === "until" ||
                  check.condition.type === "code" ||
                  (check.condition.type === "shell" && check.condition.changes === true)
                // 不需要播种则返回默认状态
                if (!shouldSeed) return UNSEEDED
                // 执行初始检查
                const init = yield* ScheduleCheck.evaluate(session, check, null, {
                  messageID: SessionMessage.ID.make(`msg_${scheduleID}_check_0`),
                  now,
                  checks: 0,
                }).pipe(
                  instances.provide(session),
                  Effect.catchTag("FileSystem.DirectoryNotFoundError", missingDirectory),
                )
                // 初始检查失败
                if (!init.ok) {
                  // A code check that throws or fails at creation is broken (e.g. wrong MCP response field); fail right away.
                  // 条件非法或 code 检查失败视为配置损坏，直接报错
                  if (init.invalid || check.condition.type === "code") return yield* new InvalidError({ reason: init.error })
                  // 其他失败容忍：按未播种处理
                  return UNSEEDED
                }
                // until 模式初始检查即匹配：任务创建即完成
                if (check.mode === "until" && init.wake)
                  return { matched: true as const, state: init.state, checks: 1, message: init.message }
                // 常规播种：记录初始状态与检查次数
                return { matched: false as const, state: init.state, checks: 1 }
              })

        // 插入数据库行
        const row = yield* db
          .insert(ScheduleTable)
          .values({
            id: scheduleID,
            session_id: session.id,
            name: input.name ?? null,
            check: check ?? null,
            state: seeded.state,
            checks: seeded.checks,
            action: input.action,
            when,
            tz: DateTime.zoneToString(zone),
            next_due_at: due,
            ends_at: ends,
            // until 模式剩余 1 次；否则取显式次数（可为不限）
            remaining_runs: check?.mode === "until" ? 1 : (input.ends?.times ?? null),
            time_created: now,
            time_updated: now,
            // 播种即匹配：任务立即记为完成一次
            ...(seeded.matched
              ? {
                  status: "done" as const,
                  next_due_at: null,
                  remaining_runs: 0,
                  run_count: 1,
                  last_fired_at: now,
                  last_outcome: "fired" as const,
                }
              : {}),
          })
          .returning()
          .get()
          .pipe(Effect.orDie)
        // 播种即匹配时附带初始消息返回
        if (seeded.matched) return toInfo(row, seeded.message)
        // 打开门铃，唤醒运行循环
        yield* doorbell.open
        return toInfo(row)
      }),
      // 列出任务（可按会话过滤），按创建时间与 ID 排序
      list: Effect.fn("Schedule.list")(function* (input) {
        const rows = yield* db
          .select()
          .from(ScheduleTable)
          .where(input?.sessionID === undefined ? undefined : eq(ScheduleTable.session_id, input.sessionID))
          .orderBy(asc(ScheduleTable.time_created), asc(ScheduleTable.id))
          .all()
          .pipe(Effect.orDie)
        return rows.map((row) => toInfo(row))
      }),
      // 按 ID 读取任务
      get: Effect.fn("Schedule.get")(function* (id) {
        return toInfo(yield* find(id))
      }),
      // 暂停任务（已暂停则原样返回）
      pause: Effect.fn("Schedule.pause")(function* (id) {
        const row = yield* find(id)
        if (row.status !== "active") return toInfo(row)
        const now = yield* Clock.currentTimeMillis
        yield* update(row, { status: "paused", time_updated: now })
        return toInfo(yield* find(id))
      }),
      // 恢复任务（已恢复则原样返回）
      resume: Effect.fn("Schedule.resume")(function* (id) {
        const row = yield* find(id)
        if (row.status !== "paused") return toInfo(row)
        const now = yield* Clock.currentTimeMillis
        // A one-shot that fell due while paused fires once, late; a repeating schedule resumes at its next slot.
        // 恢复时校正到期时间：过期的到期时间推进到下一个未来槽位
        const next =
          row.next_due_at === null || row.next_due_at > now ? row.next_due_at : (following(row, now) ?? row.next_due_at)
        // 判断恢复后是否应直接完成
        const done = next === null || finished(row, next, row.remaining_runs)
        // 更新为 active/done，并清零失败与重试
        yield* db
          .update(ScheduleTable)
          .set({
            status: done ? "done" : "active",
            next_due_at: done ? null : next,
            failures: 0,
            retry_at: null,
            time_updated: now,
          })
          .where(and(eq(ScheduleTable.id, id), eq(ScheduleTable.status, "paused")))
          .run()
          .pipe(Effect.orDie)
        // 打开门铃唤醒循环
        yield* doorbell.open
        return toInfo(yield* find(id))
      }),
      // 删除任务
      remove: Effect.fn("Schedule.remove")(function* (id) {
        // 先确认存在
        yield* find(id)
        // 执行删除
        yield* db.delete(ScheduleTable).where(eq(ScheduleTable.id, id)).run().pipe(Effect.orDie)
      }),
      // 查询某会话位置是否启用了定时任务
      enabled: Effect.fn("Schedule.enabled")(function* (sessionID) {
        const session = yield* sessions.get(sessionID)
        return yield* settings(session).pipe(
          Effect.map((value) => value.enabled),
          // 目录缺失视为未启用
          Effect.catchTag("FileSystem.DirectoryNotFoundError", () => Effect.succeed(false)),
        )
      }),
      // 手动触发一次到期处理
      tick,
      // 启动常驻运行循环
      run,
    })
  }),
)

// 构建 Schedule 的全局分层节点，声明其依赖的节点
export const node: LayerNode.Provider<Service, never, typeof Node.tags.values.global> = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, Session.node, SessionExecution.node, Instance.node],
})
