// 将本模块以命名空间方式重新导出为 ScheduleTools
export * as ScheduleTools from "./schedule.js"

// 导入 Effect 化的工具失败类型（ToolFailure）
import { ToolFailure } from "@opencode/ai/effect"
// 导入插件上下文类型（Context）
import type { Context } from "@opencode/plugin/effect/plugin"
// 导入 optional 标注：把字段标记为可选
import { optional } from "@opencode/schema/schema"
// 导入会话 ID 类型
import type { Session } from "@opencode/schema/session"
// 导入 Effect 原语：DateTime、Effect、Option、Schema
import { DateTime, Effect, Option, Schema } from "effect"
// 导入配置服务
import { Config } from "../../config.js"
// 导入配置条目观察器：监听配置变化
import { ConfigEntryObserver } from "../../config/plugin/entry-observer.js"
// 导入功能开关（Flag）服务
import { Flag } from "../../flag.js"
// 导入 /schedule 命令的提示词文本
import PROMPT_SCHEDULE from "../../plugin/command/schedule.txt"
// 导入定时任务（Schedule）服务
import { Schedule } from "../../schedule.js"

/** A schedule as the model reads it, with times in the schedule's own zone. */
// 面向模型的定时任务视图（View）：时间以任务自身时区表示
export const View = Schema.Struct({
  // 任务 ID
  id: Schedule.ID,
  // 可选的任务名称
  name: Schema.String.pipe(optional),
  // 触发规则（in/at/every/cron）
  when: Schedule.When,
  // 时区
  tz: Schema.String,
  // 可选的触发前置条件（if）
  if: Schedule.Condition.pipe(optional),
  // 可选的终止条件（until）
  until: Schedule.Condition.pipe(optional),
  // 到点执行的提示词
  prompt: Schema.String,
  // 任务状态
  status: Schedule.Status,
  // 可选的下次触发时间（ISO 字符串）
  nextDueAt: Schema.String.pipe(optional),
  // 可选的结束时间
  endsAt: Schema.String.pipe(optional),
  // 可选的剩余执行次数
  remainingRuns: Schema.Number.pipe(optional),
  // 已执行次数
  runCount: Schema.Number,
  // 可选的上次触发时间
  lastFiredAt: Schema.String.pipe(optional),
  // 可选的上次执行结果
  lastOutcome: Schedule.Outcome.pipe(optional),
  // 可选的上次输出
  lastOutput: Schema.String.pipe(optional),
})
// 视图的静态类型
export type View = typeof View.Type

// schedule_list 的输出 Schema：当前 UTC 时间 + 任务视图列表
const ListOutput = Schema.Struct({
  // 当前时间（UTC）
  now: Schema.String.annotate({ description: "The current time, in UTC." }),
  // 定时任务列表
  schedules: Schema.Array(View),
})

// 以任务 ID 为参数的通用输入 Schema
export const IDInput = Schema.Struct({
  // 任务 ID（来自 schedule_list）
  id: Schedule.ID.annotate({ description: "Schedule id from schedule_list." }),
})

// schedule_delete 的输出 Schema：被删 ID 与删除标记
const RemoveOutput = Schema.Struct({ id: Schedule.ID, removed: Schema.Boolean })

// 插件定义：注册定时任务相关工具与命令
export const Plugin = {
  // 插件唯一标识
  id: "opencode.tool.schedule",
  // 插件的 Effect 主体
  effect: Effect.fn("ScheduleTools.Plugin")(function* (ctx: Context) {
    // 注入配置服务
    const config = yield* Config.Service
    // 注入定时任务服务
    const schedules = yield* Schedule.Service
    // Internal plugins are not re-run on config changes, so reload the tools and the command instead.
    // 观察配置变化：变化时同时重载工具与命令注册
    const loaded = yield* ConfigEntryObserver.observe(
      config,
      ctx.event,
      Effect.andThen(ctx.tool.reload(), ctx.command.reload()),
    )
    const flags = yield* Flag.Service
    const enabled = () => flags.resolve(loaded.entries).schedules.enabled

    // A request keeps the tools it started with after config reloads, so each call rechecks the flag.
    // 检查会话级开关：未启用则以 DisabledError 失败（配置重载不会换掉已注册工具，故每次调用再查）
    const allowed = (sessionID: Session.ID) =>
      schedules
        .enabled(sessionID)
        .pipe(Effect.flatMap((on) => (on ? Effect.void : Effect.fail(new Schedule.DisabledError()))))
    // Tools act only on the calling Session's schedules.
    // 取任务并校验归属：只允许操作调用会话自己的任务，否则按不存在处理
    const owned = (id: Schedule.ID, sessionID: Session.ID) =>
      allowed(sessionID).pipe(
        // 先查任务
        Effect.andThen(schedules.get(id)),
        // 校验任务属于调用会话，否则报“不存在”
        Effect.filterOrFail(
          (info) => info.sessionID === sessionID,
          () => new Schedule.NotFoundError({ scheduleID: id }),
        ),
      )
    // 把服务层错误映射为工具失败的辅助函数
    const failure = (error: { readonly message: string }) => new ToolFailure({ message: error.message, error })

    // 向工具注册中心批量注册 schedule 工具
    yield* ctx.tool
      .transform((editor) => {
        // 功能未启用则不注册
        if (!enabled()) return
        // 注册 schedule_create：创建定时任务
        editor.add({
          // 工具名
          name: "schedule_create",
          // 工具描述：支持的触发方式与返回语义
          description:
            "Schedule a prompt that wakes this session later: once after a delay, at a time, every interval, on a cron, or gated by an `if` / `until` shell (`{ run }`) or Code Mode (`{ code }`) check. Returns the schedule with its next run (or `done` immediately if `until` already matches).",
          // 输入：调度请求 Schema
          input: Schedule.Request,
          // 输出：任务视图
          output: View,
          // 选项：opencode 命名空间 + codemode
          options: { namespace: "opencode", codemode: true },
          // 执行体
          execute: (input, context) =>
            // 以调用会话创建任务
            schedules.create(Schedule.toCreateInput(context.sessionID, input)).pipe(
              // 成功后生成视图与摘要
              Effect.map((info) => {
                // 转成视图
                const view = toView(info)
                // until 立即命中则显示“立即匹配”，否则“已排程”
                const prefix =
                  view.status === "done" && view.until !== undefined ? "Matched immediately" : "Scheduled"
                // 返回输出与内容
                return { output: view, content: `${prefix}: ${summary(view)}` }
              }),
              // 失败映射
              Effect.mapError(failure),
            ),
        })
        // 注册 schedule_list：列出本会话的定时任务
        editor.add({
          name: "schedule_list",
          description: "List this session's schedules with their status and next run, and the current time.",
          // 无输入参数
          input: Schema.Struct({}),
          // 输出：时间 + 任务列表
          output: ListOutput,
          options: { namespace: "opencode", codemode: true },
          execute: (_, context) =>
            Effect.gen(function* () {
              // 检查会话级开关
              yield* allowed(context.sessionID)
              // 当前时间（ISO 格式）
              const now = DateTime.formatIso(yield* DateTime.now)
              // 取任务列表并转为视图
              const list = (yield* schedules.list({ sessionID: context.sessionID })).map(toView)
              // 返回输出与逐行摘要
              return {
                output: { now, schedules: list },
                content: [`Now: ${now}`, ...(list.length === 0 ? ["No schedules."] : list.map(summary))].join("\n"),
              }
            }).pipe(Effect.mapError(failure)),
        })
        // 注册 schedule_pause：暂停任务
        editor.add({
          name: "schedule_pause",
          description: "Pause a schedule. It keeps its settings and does not fire until resumed.",
          input: IDInput,
          output: View,
          options: { namespace: "opencode", codemode: true },
          execute: (input, context) =>
            // 校验归属后暂停
            owned(input.id, context.sessionID).pipe(
              Effect.andThen(schedules.pause(input.id)),
              // 成功后返回视图与摘要
              Effect.map((info) => ({ output: toView(info), content: `Paused: ${summary(toView(info))}` })),
              Effect.mapError(failure),
            ),
        })
        // 注册 schedule_resume：恢复任务
        editor.add({
          name: "schedule_resume",
          description:
            "Resume a paused schedule. A one-shot that fell due while paused fires once now; a repeating one resumes at its next slot.",
          input: IDInput,
          output: View,
          options: { namespace: "opencode", codemode: true },
          execute: (input, context) =>
            // 校验归属后恢复
            owned(input.id, context.sessionID).pipe(
              Effect.andThen(schedules.resume(input.id)),
              Effect.map((info) => ({ output: toView(info), content: `Resumed: ${summary(toView(info))}` })),
              Effect.mapError(failure),
            ),
        })
        // 注册 schedule_delete：彻底删除任务
        editor.add({
          name: "schedule_delete",
          description: "Delete a schedule for good.",
          input: IDInput,
          output: RemoveOutput,
          options: { namespace: "opencode", codemode: true },
          execute: (input, context) =>
            // 校验归属后删除
            owned(input.id, context.sessionID).pipe(
              Effect.andThen(schedules.remove(input.id)),
              // 成功后返回删除结果
              Effect.as({ output: { id: input.id, removed: true }, content: `Deleted schedule ${input.id}.` }),
              Effect.mapError(failure),
            ),
        })
      })
      // 注册出错则直接中断
      .pipe(Effect.orDie)

    // 注册 /schedule 命令：把参数替换进提示词后发起会话消息
    yield* ctx.command.transform((editor) => {
      // 功能未启用则不注册
      if (!enabled()) return
      editor.add({
        // 命令名
        name: "schedule",
        // 命令描述
        description: "schedule a prompt for later, or list, pause and delete this session's schedules",
        execute: (input) =>
          // 以用户会话发送合成提示
          ctx.session
            .prompt({
              // 展开原提示参数
              ...input.prompt,
              // 所属会话
              sessionID: input.sessionID,
              // 把模板中的 $ARGUMENTS 替换为用户输入文本（用函数替换避免 "$" 特殊含义）
              text: PROMPT_SCHEDULE.replaceAll("$ARGUMENTS", () => input.prompt.text.trim()),
              // 传递送达方式
              delivery: input.delivery,
            })
            // 忽略返回值
            .pipe(Effect.asVoid),
      })
    })
  }),
}

// 把触发条件（shell/code）格式化为可读字符串
function formatCondition(condition: Schedule.Condition): string {
  // 按条件类型分支
  switch (condition.type) {
    // shell 条件：直接 JSON 序列化命令
    case "shell":
      return JSON.stringify(condition.run)
    // code 条件：取第一行非空代码，截断到 60 字符后序列化
    case "code": {
      // 按行拆分、去空白，找第一行非空内容
      const first = condition.code
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0)
      // 输出 "code \"...\"" 形式
      return `code ${JSON.stringify(first ? first.slice(0, 60) : "")}`
    }
  }
}

/** One line per schedule, for models that read tool content rather than output (Code Mode off). */
// 把任务视图压缩成单行摘要（供非 Code Mode 的模型阅读）
function summary(view: View) {
  // 触发规则
  const when = view.when
  // 按类型生成触发描述
  const trigger =
    when.type === "in"
      ? `in ${when.in}`
      : when.type === "at"
        ? `at ${when.at}`
        : when.type === "every"
          ? `every ${when.every}`
          : `cron "${when.cron}"`
  // 门控条件：until 优先于 if 展示
  const gate =
    view.until !== undefined
      ? `until ${formatCondition(view.until)}`
      : view.if !== undefined
        ? `if ${formatCondition(view.if)}`
        : undefined
  // 提示词超过 80 字符则截断加省略号
  const prompt = view.prompt.length > 80 ? `${view.prompt.slice(0, 79)}…` : view.prompt
  // 拼装各段：ID/名称/触发/时区、门控、状态、下次时间、提示词、上次输出
  return [
    `${view.id}${view.name ? ` "${view.name}"` : ""}: ${trigger} (${view.tz})`,
    gate,
    view.status,
    view.nextDueAt && `next ${view.nextDueAt}`,
    `prompt: ${JSON.stringify(prompt)}`,
    view.lastOutput && `output: ${JSON.stringify(view.lastOutput)}`,
  ]
    // 去掉空段
    .filter(Boolean)
    // 逗号拼接
    .join(", ")
}

// 把服务端的任务信息转换为面向模型的视图（时间转任务自身时区）
function toView(info: Schedule.Info): View {
  // 本地化时间辅助函数：转成任务时区的 ISO 字符串
  const local = (time: DateTime.Utc | undefined) => {
    // 无时间直接返回 undefined
    if (time === undefined) return undefined
    // 尝试按任务时区格式化
    return Option.match(DateTime.zoneMakeNamed(info.tz), {
      // 时区不可用：回退为 UTC ISO 格式
      onNone: () => DateTime.formatIso(time),
      // 时区可用：带偏移量的 ISO 格式
      onSome: (zone) => DateTime.formatIsoOffset(DateTime.setZone(time, zone)),
    })
  }
  // 逐字段映射
  return {
    id: info.id,
    name: info.name,
    when: info.when,
    tz: info.tz,
    if: info.if,
    until: info.until,
    // 提示词来自 action
    prompt: info.action.prompt,
    status: info.status,
    // 各时间字段做本地化
    nextDueAt: local(info.nextDueAt),
    endsAt: local(info.endsAt),
    remainingRuns: info.remainingRuns,
    runCount: info.runCount,
    lastFiredAt: local(info.lastFiredAt),
    lastOutcome: info.lastOutcome,
    lastOutput: info.lastOutput,
  }
}
