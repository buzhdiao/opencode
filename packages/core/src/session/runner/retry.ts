// 将本模块以命名空间形式整体导出为 SessionRunnerRetry
export * as SessionRunnerRetry from "./retry.js"

// AI 错误类型与可重试（retryable）判定函数
import { AIError, isRetryable } from "@opencode/ai/effect"
// 代理 ID 类型
import { Agent } from "@opencode/schema/agent"
// 模型引用类型
import { Model } from "@opencode/schema/model"
// 会话错误类型
import { SessionError } from "@opencode/schema/session-error"
// effect：Clock 时钟、Duration 时长、Effect 运行时
import { Clock, Duration, Effect } from "effect"
// 事件总线：发布重试调度事件
import { Bus } from "../../bus.js"
// 模型重试策略：内置的判定逻辑
import { ModelRetry } from "../../model-retry.js"
// 插件钩子类型（仅类型引用）
import type { PluginHooks } from "../../plugin/hooks.js"
// 会话事件定义
import { SessionEvent } from "../event.js"
// 会话消息 ID 类型
import { SessionMessage } from "../message.js"
// 会话 Schema：ID 类型
import { SessionSchema } from "../schema.js"

// 转发导出可重试判定函数
export { isRetryable }

// 重试决策的输入：原始 AI 错误、规范化错误、代理/模型、钩子回调与是否允许重试
interface Input {
  readonly cause: AIError
  readonly error: SessionError.Error
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly hook: (event: PluginHooks.Domains["session"]["retry"]) => Effect.Effect<void>
  readonly retry: boolean
}

// 重试决策：确认重试时的第几次尝试与延迟毫秒数
export interface Decision {
  readonly retry: true
  readonly attempt: number
  readonly delay: number
}

// 构建重试策略：先走内置模型重试策略，再交给插件钩子修正
export const policy = (sessionID: SessionSchema.ID) =>
  Effect.gen(function* () {
    // 取得内置决策函数
    const decide = yield* ModelRetry.policy
    // 返回针对单个输入的决策函数
    return (input: Input) =>
      Effect.gen(function* () {
        // 内置策略判定；无建议则不重试
        const next = yield* decide(input)
        if (!next) return { retry: false as const }
        // 组装插件钩子事件：包含会话、代理、模型、错误、尝试序号与内置决策
        const event: PluginHooks.Domains["session"]["retry"] = {
          sessionID,
          agent: input.agent,
          model: input.model,
          error: input.error,
          attempt: next.attempt,
          decision: next.retry ? { retry: true, delay: next.delay } : { retry: false },
        }
        // 触发钩子：插件可修改 event.decision
        yield* input.hook(event)
        // 钩子否决重试则采纳钩子决策
        if (!event.decision.retry) return event.decision
        // 归一化钩子给出的延迟：有限且非负时向上取整为毫秒，否则退回内置延迟
        const normalized =
          Number.isFinite(event.decision.delay) && event.decision.delay >= 0
            ? Math.ceil(event.decision.delay)
            : next.delay
        // 返回最终的重试决策
        return { retry: true as const, attempt: next.attempt, delay: normalized }
      })
  })

// 创建重试工具：决策函数 + 等待函数（发布调度事件并睡到重试时刻）
export const make = (bus: Bus.Interface, sessionID: SessionSchema.ID) =>
  Effect.gen(function* () {
    // 获取本会话的重试决策函数
    const decide = yield* policy(sessionID)
    // 等待重试：先发布 RetryScheduled 事件，再睡到计划时刻
    const wait = (input: {
      readonly decision: Decision
      readonly assistantMessageID: SessionMessage.ID
      readonly error: SessionError.Error
    }) =>
      Effect.gen(function* () {
        // 记录调度决策的当前时间（毫秒）
        const scheduled = yield* Clock.currentTimeMillis
        // 发布重试调度事件：包括助手消息 ID、尝试序号、计划时间与错误
        yield* bus.publish(SessionEvent.RetryScheduled, {
          sessionID,
          assistantMessageID: input.assistantMessageID,
          attempt: input.decision.attempt,
          at: scheduled + input.decision.delay,
          error: input.error,
        })
        // 计算剩余等待时间（发布事件可能已消耗时间，钳制为非负）
        const remaining = Math.max(0, scheduled + input.decision.delay - (yield* Clock.currentTimeMillis))
        // 睡到重试时刻
        yield* Effect.sleep(Duration.millis(remaining))
      })
    // 返回决策与等待两个工具
    return { decide, wait }
  })
