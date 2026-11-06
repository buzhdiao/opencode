// 命令（Command）服务：注册、查询与执行用户自定义命令，并通过事件总线（bus）广播命令变更。
export * as Command from "./command.js"

import { Command } from "@opencode/schema/command"
import type { PromptInput } from "@opencode/schema/prompt-input"
import type { Session } from "@opencode/schema/session"
import type { SessionInbox } from "@opencode/schema/session-inbox"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Context, Effect, Layer, Schema } from "effect"
import { Bus } from "./bus.js"
import { State } from "./state.js"

// 复用 schema 中定义的命令信息类型，作为本模块对外的 Info 类型
export const Info = Command.Info
export type Info = Command.Info
// 转发导出命令事件定义（如 Command.Event.Updated）
export { Event } from "@opencode/schema/command"

// 一次命令调用（Invocation）的上下文：所属会话（session）、用户输入与投递方式
export interface Invocation {
  // 命令所属的会话 ID
  readonly sessionID: Session.ID
  // 触发命令时的用户提示输入
  readonly prompt: PromptInput.Prompt
  // 该输入在会话收件箱中的投递方式
  readonly delivery: SessionInbox.Delivery
}

// 命令定义（Definition）：注册一条命令所需的名称、描述与执行函数
export interface Definition {
  // 命令名称，作为唯一键
  readonly name: string
  // 可选的人类可读描述
  readonly description?: string
  // 执行体，返回效果且错误类型不限
  readonly execute: (input: Invocation) => Effect.Effect<void, unknown>
}

// 编辑器（Editor）：供外部通过状态转换向命令注册表添加定义
export type Editor = {
  add: (definition: Definition) => void
}

// 找不到指定命令时抛出的标签错误（tagged error）
export class NotFoundError extends Schema.TaggedError<NotFoundError>()("Command.NotFoundError", {
  // 未命中的命令名
  command: Schema.String,
  // 错误信息
  message: Schema.String,
}) {}

// 命令执行过程中失败时抛出的标签错误
export class ExecutionError extends Schema.TaggedError<ExecutionError>()("Command.ExecutionError", {
  // 执行失败的命令名
  command: Schema.String,
  // 错误信息
  message: Schema.String,
}) {}

// 命令服务的接口：查询、列出与执行命令
export interface Interface extends State.Transformable<Editor> {
  // 按名称获取单个命令信息
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  // 列出全部已注册命令
  readonly list: () => Effect.Effect<Info[]>
  // 按名称执行一次命令调用
  readonly execute: (input: {
    readonly name: string
    readonly invocation: Invocation
  }) => Effect.Effect<void, NotFoundError | ExecutionError>
}

// Effect 上下文中的服务令牌（Service tag），用于从环境中取出命令服务
export class Service extends Context.Service<Service, Interface>()("@opencode/Command") {}

// 服务实现层（layer）：装配依赖并构造 Interface 的具体实现
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 依赖事件总线，用于广播命令变更事件
    const bus = yield* Bus.Service
    // 把内部 Definition 转换为对外的 Info 结构
    const info = (definition: Definition) =>
      Info.make({
        name: definition.name,
        description: definition.description,
      })
    // 创建可重载的命令状态：以命令名为键的 Map，并通过编辑器注册新命令
    const state = State.create<Map<string, Definition>, Editor>({
      // 状态名称，用于日志/调试
      name: "command",
      // 初始为空映射
      initial: () => new Map(),
      editor: (editor) => ({
        // 编辑器动作：按名称写入定义
        add: (definition) => editor.set(definition.name, definition),
      }),
      // 状态变更通知：把全部命令映射为 Info 列表，并广播 Updated 事件
      notify: State.changes(
        (commands) => Array.from(commands.values(), info),
        () => bus.publish(Command.Event.Updated, {}).pipe(Effect.asVoid),
      ),
    })

    // 返回满足 Interface 的服务实现
    return Service.of({
      // 重载状态
      reload: state.reload,
      // 通过编辑器批量修改状态
      transform: state.transform,
      get: Effect.fn("Command.get")((name) =>
        // 按名称查询命令信息
        Effect.sync(() => {
          // 从状态映射中取出定义
          const definition = state.get().get(name)
          // 有定义则转成 Info，否则返回 undefined
          return definition ? info(definition) : undefined
        }),
      ),
      // 同步列出所有命令信息
      list: Effect.fn("Command.list")(() => Effect.sync(() => Array.from(state.get().values(), info))),
      execute: Effect.fn("Command.execute")(function* (input) {
        // 执行指定命令
        // 查找命令定义
        const definition = state.get().get(input.name)
        // 未找到则直接失败（yield* 抛出 NotFoundError）
        if (!definition)
          return yield* new NotFoundError({ command: input.name, message: `Command not found: ${input.name}` })
        return yield* definition.execute(input.invocation).pipe(
          // 失败时记录日志
          Effect.tapError((error) => Effect.logError("command execution failed", { command: input.name, error })),
          // 把任意错误归一化为 ExecutionError
          Effect.mapError((error) => new ExecutionError({ command: input.name, message: errorMessage(error) })),
        )
      }),
    })
  }),
)

// 位置节点（Location node）：把命令服务挂到按项目位置装配的依赖图上
export const node = makeLocationNode({
  service: Service,
  layer,
  // 依赖事件总线节点
  deps: [Bus.node],
})

// 从任意抛出值中尽力提取错误信息文本
function errorMessage(error: unknown) {
  // 标准 Error 直接取 message
  if (error instanceof Error) return error.message
  // 字符串本身即信息
  if (typeof error === "string") return error
  // 带 message 字段的对象取其字符串 message
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string")
    return error.message
  // 兜底文案
  return "Command execution failed"
}
