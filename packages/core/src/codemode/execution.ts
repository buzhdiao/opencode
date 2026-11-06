// 将本模块以命名空间（namespace）形式整体导出；CodeModeExecution 表示一次 Code Mode 程序执行的上下文
export * as CodeModeExecution from "./execution.js"

// 导入工具上下文（Context）类型：包含会话、消息、进度上报等工具执行环境信息
import type { Context as ToolContext } from "@opencode/schema/tool"
// 导入 Effect 的 Context：定义依赖注入服务
import { Context } from "effect"

/** The `execute` call a Code Mode program runs under, so extensions can act for its session like a tool does. */
// 定义服务标记类：把一次 execute 调用的工具上下文作为服务注入，扩展（extension）即可像普通工具那样代表该会话行动
export class Service extends Context.Service<Service, ToolContext>()("@opencode/CodeModeExecution") {}
