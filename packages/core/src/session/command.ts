// 将本模块整体导出为 SessionCommand 命名空间
export * as SessionCommand from "./command.js"

// 导入提示输入相关类型（文件/agent/技能列表）
import type { PromptInput } from "@opencode/schema/prompt-input"
// 导入会话类型
import type { Session } from "@opencode/schema/session"
// 导入会话收件箱的投递方式类型
import type { SessionInbox } from "@opencode/schema/session-inbox"
// 导入 effect 核心
import { Effect } from "effect"
// 导入命令服务
import { Command } from "../command.js"
// 导入实例服务（提供按会话注入依赖的作用域）
import { Instance } from "../instance/service.js"
// 导入插件服务
import { Plugin } from "../plugin/service.js"

// 在指定会话上执行一条命令（如 /commit 之类的用户自定义命令）
export const execute = Effect.fn("SessionCommand.execute")(function* (input: {
  // 目标会话
  session: Session.Info
  // 命令名（不带斜杠前缀）
  command: string
  // 随命令附带的文本提示
  text: string
  // 附带的文件列表（可选）
  files?: PromptInput.Prompt["files"]
  // 附带的 agent 列表（可选）
  agents?: PromptInput.Prompt["agents"]
  // 附带的技能列表（可选）
  skills?: PromptInput.Prompt["skills"]
  // 投递方式（可选，如 steer/follow-up）
  delivery?: SessionInbox.Delivery
}) {
  // 取出实例服务
  const instances = yield* Instance.Service
  // 在会话对应的实例作用域内执行命令
  yield* Effect.gen(function* () {
    // 等待插件激活完成
    yield* Plugin.awaitActivation
    // 取出命令服务
    const commands = yield* Command.Service
    // 调用命令执行：传入名称、调用上下文（会话 ID、提示内容）与投递方式
    yield* commands.execute({
      name: input.command,
      invocation: {
        sessionID: input.session.id,
        prompt: {
          text: input.text,
          files: input.files,
          agents: input.agents,
          skills: input.skills,
        },
        delivery: input.delivery ?? "steer",
      },
    })
  }).pipe(instances.provide(input.session))
})
