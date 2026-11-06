// 以命名空间形式整体再导出本模块
export * as PlanPlugin from "./plan.js"

// Message 与 ToolFailure：消息构造器与工具失败错误类型
import { Message, ToolFailure } from "@opencode/ai/effect"
// define：插件定义辅助函数
import { define } from "@opencode/plugin/effect/plugin"
// Agent：agent（代理）Schema，含 ID 类型
import { Agent } from "@opencode/schema/agent"
// SessionEvent：会话事件类型
import type { SessionEvent } from "@opencode/schema/session-event"
// Global：全局路径服务
import { Global } from "@opencode/util/global"
// Effect/Stream：效果运行时与流
import { Effect, Stream } from "effect"
// path：Node 路径处理
import path from "path"
// Permission：权限系统（含 BlockedError）
import { Permission } from "../permission.js"

// Plan 模式专用 agent 的 ID
const plan = Agent.ID.make("plan")

// 进入 Plan 模式时注入的系统提醒模板（directory 为允许写计划文件的目录）
const enter = (directory: string) => `<system-reminder>
You are in Plan mode. Discuss the plan with the user directly in the conversation. Do not create or update plan files unless the user explicitly asks you to; when they do, write them only in:
${directory}

Do not modify any other files or ask a subagent to do so.

You remain in Plan mode until the user switches agents. If the user asks you to implement changes, do not do so. Tell them they need to switch agents.
</system-reminder>`

// 离开 Plan 模式时注入的系统提醒模板
const leave = `<system-reminder>
You are NO LONGER in Plan mode. The previous Plan restrictions no longer apply. Any Plan mode instructions from earlier in this conversation are no longer active.
</system-reminder>`

// 定义 Plan 模式插件
export const Plugin = define({
  // 插件唯一标识
  id: "opencode.plan",
  // 插件激活时执行的生成器主体
  effect: Effect.fn(function* (ctx) {
    // 获取全局路径服务（用于确定 home 目录）
    const global = yield* Global.Service
    // 计划文件目录：~/.opencode/plan
    const directory = path.join(global.home, ".opencode", "plan")
    // 预渲染进入提醒文本
    const enterReminder = enter(directory)
    // 调整 plan agent 的定义
    yield* ctx.agent.transform((editor) => {
      // 更新 plan agent 的元数据与权限
      editor.update(plan, (item) => {
        // 显示名称设为 "Plan"
        item.name = Agent.Name.make("Plan")
        // 描述：只读探索代码库并制定计划的 agent
        item.description = "Read-only agent for exploring the codebase and planning work before implementation."
        // 主模式（primary）agent
        item.mode = "primary"
        // 允许向用户提问
        item.permissions.push({ action: "question", resource: "*", effect: "allow" })
        // 默认禁止编辑任何文件
        item.permissions.push({ action: "edit", resource: "*", effect: "deny" })
        // 仅允许编辑计划目录内的文件
        item.permissions.push({ action: "edit", resource: path.join(directory, "*"), effect: "allow" })
      })
    })

    // 工具执行后钩子：把 Plan 模式下被阻止的编辑错误改写为更友好的提示
    yield* ctx.tool.hook("execute.after", (event) => {
      // 非 plan agent 不处理
      if (event.agent !== plan) return Effect.void
      // 执行状态不是 error 不处理
      if (event.status !== "error") return Effect.void
      // 只关心 edit/write/patch 三种写入类工具
      if (event.tool !== "edit" && event.tool !== "write" && event.tool !== "patch") return Effect.void
      // 错误不是"权限被阻止"时不处理
      if (!(event.error.error instanceof Permission.BlockedError)) return Effect.void
      // 用说明性的 ToolFailure 覆盖原始错误，提示 Plan 目录边界
      event.error = new ToolFailure({
        message: `Cannot use ${event.tool} to modify files outside the Plan directory: ${directory}`,
      })
      // 钩子结束
      return Effect.void
    })

    // Compaction and committed reverts can strip reminders while the session's agent stays
    // put. Reconcile per request, appending near the tail so the cached prefix stays warm.
    // 会话上下文钩子：压缩（compaction）与提交回滚会剥掉提醒而 agent 未变，这里按请求对账；
    // 插入位置靠近尾部，保持已缓存的提示前缀不过期。
    yield* ctx.session.hook("context", (event) => {
      // 找出消息中最后一条 Plan 提醒（进入或离开）
      const reminder = lastReminder(event.messages, enterReminder)
      // 当前是 plan agent 但最后提醒不是"进入"：缺少进入提醒
      const missing = event.agent === plan && reminder !== enterReminder
      // 当前不是 plan agent 但最后提醒是"进入"：提醒已过期
      const stale = event.agent !== plan && reminder === enterReminder
      // 决定要注入的文本：缺则补进入提醒，过期则补离开提醒
      const text = missing ? enterReminder : stale ? leave : undefined
      // 无需注入则结束
      if (!text) return Effect.void
      // Before the user's prompt, matching where agent-switch reminders land.
      // 插在最后一条用户消息之前，与 agent 切换提醒的落点保持一致。
      const at = event.messages.at(-1)?.role === "user" ? event.messages.length - 1 : event.messages.length
      // 在计算出的位置插入用户消息形态的提醒
      event.messages.splice(at, 0, Message.user(text))
      // 同时持久化一条合成（synthetic）消息，失败仅记录警告
      return ctx.session
        .synthetic({ sessionID: event.sessionID, text, resume: false })
        .pipe(
          // 持久化失败不影响上下文组装，只记日志
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to persist Plan mode reminder", { sessionID: event.sessionID, cause }),
          ),
        )
    })

    // 订阅会话创建与 agent 切换事件，及时注入/移除提醒
    yield* ctx.event.subscribe({ types: ["session.created", "session.agent.selected"] }).pipe(
      // 每个事件计算需要注入的提醒
      Stream.runForEach((event) => {
        // 计算切换提醒文本
        const text = switchReminder(event, enterReminder)
        // 无需注入则结束
        if (!text) return Effect.void
        // 持久化合成消息
        return ctx.session
          .synthetic({
            // 目标会话
            sessionID: event.data.sessionID,
            // 提醒文本
            text,
            // 不恢复会话
            resume: false,
          })
          .pipe(
            // 失败仅记录警告
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to inject Plan mode reminder", { sessionID: event.data.sessionID, cause }),
            ),
          )
      }),
      // 后台纤维运行并立即启动
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})

// 根据事件类型决定进入/离开提醒文本
function switchReminder(
  // 会话创建或 agent 切换事件
  event: SessionEvent.Created | SessionEvent.AgentSelected,
  // 进入提醒文本
  enterReminder: string,
  // 返回需要注入的文本或 undefined
): string | undefined {
  // 会话创建事件
  if (event.type === "session.created") {
    // 初始 agent 不是 plan 则不注入
    if (event.data.agent !== plan) return undefined
    // 创建即为 plan 会话：注入进入提醒
    return enterReminder
  }
  // agent 未变化则不注入
  if (event.data.agent === event.data.previous) return undefined
  // 切换到 plan：注入进入提醒
  if (event.data.agent === plan) return enterReminder
  // 从 plan 切走：注入离开提醒
  if (event.data.previous === plan) return leave
  // 其余情况不注入
  return undefined
}

// 在消息列表中查找最后一条 Plan 提醒（进入或离开）
function lastReminder(messages: ReadonlyArray<Message>, enterReminder: string) {
  // 用 reduce 依次扫描，保留最后命中的提醒
  return messages.reduce<string | undefined>((found, message) => {
    // 仅当用户消息只含单段内容时取该段
    const part = message.role === "user" && message.content.length === 1 ? message.content[0] : undefined
    // 不是文本段则维持原值
    if (part?.type !== "text") return found
    // 文本恰为进入或离开提醒时更新，否则维持原值
    return part.text === enterReminder || part.text === leave ? part.text : found
    // 初始值为 undefined
  }, undefined)
}
