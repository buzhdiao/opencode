// 将本文件的所有导出聚合到命名空间 TodoTool 下，供插件系统统一引入
export * as TodoTool from "./todo.js"

// 工具执行失败时抛出的错误类型（ToolFailure）
import { ToolFailure } from "@opencode/ai/effect"
// 插件上下文类型（Context），提供 tool/session 等扩展点
import type { Context } from "@opencode/plugin/effect/plugin"
// effect 库核心：Effect 副作用编排、Schema 数据校验
import { Effect, Schema } from "effect"
// Config 服务：读取全局配置
import { Config } from "../../config.js"
// 配置条目观察器：配置变化时触发回调
import { ConfigEntryObserver } from "../../config/plugin/entry-observer.js"
// Flag：特性开关（feature flag）解析
import { Flag } from "../../flag.js"
// Permission 服务：权限断言
import { Permission } from "../../permission.js"
// 工具描述文本（来自 todowrite.txt）
import DESCRIPTION from "../todowrite.txt"

// 工具名称：todowrite（写待办清单）
export const name = "todowrite"

// 单条待办的结构 Schema
export const Info = Schema.Struct({
  // 任务的简短描述
  content: Schema.String.annotate({ description: "Brief description of the task" }),
  // 任务状态：待办/进行中/已完成/已取消
  status: Schema.Literals(["pending", "in_progress", "completed", "cancelled"]).annotate({
    description: "Current status of the task: pending, in_progress, completed, cancelled",
  }),
})
// Info 的 TypeScript 类型
export type Info = typeof Info.Type

// 工具入参 Schema
export const Input = Schema.Struct({
  // 更新后的完整待办列表
  todos: Schema.Array(Info).annotate({ description: "The updated todo list" }),
})

// 工具出参 Schema
export const Output = Schema.Struct({
  // 返回写入的待办列表
  todos: Schema.Array(Info),
})
// Output 的 TypeScript 类型
export type Output = typeof Output.Type

// 把待办列表汇总成一句简短的状态文本（用作工具返回内容）
export const summarize = (todos: ReadonlyArray<Info>) => {
  // 列表为空表示已清空待办
  if (todos.length === 0) return "Todos cleared"
  // 统计某状态的待办数量
  const count = (status: Info["status"]) => todos.filter((todo) => todo.status === status).length
  // 拼接各状态计数（已完成数/总数在前，其余状态数量为 0 的不展示）
  const counts = [
    // 已完成数与总数的组合
    `${count("completed")}/${todos.length} completed`,
    // 遍历其余状态，按需生成"数量 + 状态"片段
    ...(["in_progress", "pending", "cancelled"] as const).flatMap((status) =>
      count(status) ? [`${count(status)} ${status.replace("_", " ")}`] : [],
    ),
  ].join(", ")
  // 收集所有进行中任务的内容（JSON 字符串形式）
  const active = todos.filter((todo) => todo.status === "in_progress").map((todo) => JSON.stringify(todo.content))
  // 返回汇总文本；存在进行中任务时附加列出
  return `Todos updated: ${counts}${active.length ? `. In progress: ${active.join(", ")}` : ""}`
}

// 插件定义：注册 todowrite 工具
export const Plugin = {
  // 插件唯一标识
  id: "opencode.tool.todo",
  // 插件主 effect：获取所需服务并完成工具注册
  effect: Effect.fn("TodoTool.Plugin")(function* (ctx: Context) {
    // 获取配置服务
    const config = yield* Config.Service
    // 获取权限服务
    const permission = yield* Permission.Service
    // Internal plugins are not re-run on config changes, so reload the tool transform instead.
    // 内部插件不会因配置变化而重跑，这里改用观察器在配置变化时重新执行工具注册
    const loaded = yield* ConfigEntryObserver.observe(config, ctx.event, ctx.tool.reload())
    // 获取特性开关解析器
    const flags = yield* Flag.resolver
    // 判断 todo 工具是否被启用
    const enabled = () => flags(loaded.entries).todo.enabled

    // 注册工具：仅在启用时写入工具定义
    yield* ctx.tool
      .transform((editor) => {
        // 未启用则不注册任何工具
        if (!enabled()) return
        // 添加工具定义
        editor.add({
          // 工具名
          name,
          // 关闭 codemode（不作为代码模式调用）
          options: { codemode: false },
          // 工具描述文本
          description: DESCRIPTION,
          // 入参 Schema
          input: Input,
          // 出参 Schema
          output: Output,
          // 工具执行体：先做权限断言，再返回待办列表与摘要
          execute: (input, context) =>
            permission
              .assert({
                // 权限动作名：todowrite
                action: name,
                // 作用资源：全部（*）
                resources: ["*"],
                // 用户允许时记住该授权
                save: ["*"],
                // 附带调用方信息（工具调用上下文）
                ...Permission.invocation(context),
              })
              .pipe(
                // 断言失败时转为工具错误
                Effect.mapError((error) => new ToolFailure({ message: "Unable to update todos", error })),
                // 断言通过后映射为工具响应
                Effect.as({
                  // 输出：写入的待办列表
                  output: { todos: input.todos },
                  // 内容：待办状态摘要文本
                  content: summarize(input.todos),
                  // 元数据：携带待办列表
                  metadata: { todos: input.todos },
                }),
              ),
        })
      })
      // 注册失败则直接终止
      .pipe(Effect.orDie)
  }),
}
