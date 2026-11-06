// 以命名空间方式整体导出本模块
export * as CommandPlugin from "./command.js"

// 引入插件定义工具（define）
import { define } from "@opencode/plugin/effect/plugin"
// 引入 Effect 与 Stream（副作用容器与流）
import { Effect, Stream } from "effect"
// 引入事件总线服务
import { Bus } from "../bus.js"
// 引入位置服务（项目目录）
import { Location } from "../location.js"
// 引入 MCP（Model Context Protocol）服务
import { Mcp } from "../mcp/index.js"
// 引入 /init 命令的提示词模板（构建期内联文本）
import PROMPT_INITIALIZE from "./command/initialize.txt"
// 引入 /review 命令的提示词模板
import PROMPT_REVIEW from "./command/review.txt"

// 插件定义：opencode.command，注册内置命令与 MCP 提示词命令
export const Plugin = define({
  // 插件 ID
  id: "opencode.command",
  // 插件主体
  effect: Effect.fn(function* (ctx) {
    // 获取位置服务实例
    const location = yield* Location.Service
    // 获取 MCP 服务实例
    const mcp = yield* Mcp.Service
    // 获取事件总线实例
    const bus = yield* Bus.Service
    // 已加载的 MCP 提示词缓存（可变容器）
    const loaded = { prompts: [] as Mcp.Prompt[] }
    // 订阅"MCP 提示词变更"事件：刷新缓存并触发命令重载（fork 为独立作用域）
    yield* bus.subscribe(Mcp.PromptsChanged).pipe(
      // 每个事件执行：重新拉取提示词 -> 更新缓存 -> 重载命令
      Stream.runForEach(() =>
        mcp.prompts().pipe(
          // 拉取完成后同步更新缓存
          Effect.tap((prompts) => Effect.sync(() => (loaded.prompts = prompts))),
          // 然后触发命令表重载
          Effect.andThen(ctx.command.reload()),
        ),
      ),
      // 立即启动并绑定当前作用域
      Effect.forkScoped({ startImmediately: true }),
    )
    // 初始化时先同步加载一次提示词
    loaded.prompts = yield* mcp.prompts()
    // 向命令编辑器注册各命令
    yield* ctx.command.transform((editor) => {
      // 注册 /init 命令：引导生成 AGENTS.md
      editor.add({
        // 命令名
        name: "init",
        // 描述
        description: "guided AGENTS.md setup",
        // 执行：把初始化模板（替换项目路径占位符）与用户输入拼接后作为会话提示
        execute: (input) =>
          ctx.session
            .prompt({
              // 展开原提示的其他字段
              ...input.prompt,
              // 目标会话 ID
              sessionID: input.sessionID,
              // 模板中的 ${path} 替换为项目目录，再把用户输入并入
              text: append(PROMPT_INITIALIZE.replace("${path}", location.project.directory), input.prompt.text),
              // 投递方式沿用原输入
              delivery: input.delivery,
            })
            .pipe(Effect.asVoid),
      })
      // 注册 /review 命令：代码审查（可选 commit/branch/pr，默认审查未提交改动）
      editor.add({
        // 命令名
        name: "review",
        // 描述
        description: "review changes [commit|branch|pr], defaults to uncommitted",
        // 执行：与 /init 相同的模板拼接逻辑
        execute: (input) =>
          ctx.session
            .prompt({
              // 展开原提示的其他字段
              ...input.prompt,
              // 目标会话 ID
              sessionID: input.sessionID,
              // 审查模板替换路径后与用户输入拼接
              text: append(PROMPT_REVIEW.replace("${path}", location.project.directory), input.prompt.text),
              // 投递方式沿用原输入
              delivery: input.delivery,
            })
            .pipe(Effect.asVoid),
      })
      // 为每个已加载的 MCP 提示词注册一个命令
      for (const prompt of loaded.prompts) {
        editor.add({
          // 命令名：server:prompt（经字符清洗）
          name: mcpCommandName(prompt.server, prompt.name),
          // 描述沿用提示词描述
          description: prompt.description,
          // 执行：调用 MCP 提示词并把结果作为会话提示发送
          execute: (input) =>
            Effect.gen(function* () {
              // 解析用户输入的参数列表
              const args = parseArguments(input.prompt.text)
              // 调用 MCP 提示词：按声明顺序把参数映射为 { 名称: 值 }
              const result = yield* mcp.prompt({
                server: prompt.server,
                name: prompt.name,
                args: Object.fromEntries(
                  (prompt.arguments ?? []).map((argument, index) => [argument.name, args[index] ?? ""]),
                ),
              })
              // 提示词不存在则报错
              if (!result) return yield* Effect.fail(new Error(`MCP prompt not found: ${prompt.server}:${prompt.name}`))
              // 把各消息的文本内容拼接为会话提示发送
              yield* ctx.session.prompt({
                // 展开原提示的其他字段
                ...input.prompt,
                // 目标会话 ID
                sessionID: input.sessionID,
                // 提取每条消息的文本并按行拼接、去首尾空白
                text: result.messages
                  .map((message) => promptMessageText(message.content))
                  .join("\n")
                  .trim(),
                // 投递方式沿用原输入
                delivery: input.delivery,
              })
            }).pipe(Effect.asVoid),
        })
      }
    })
  }),
})

// append：把用户输入并入模板；模板含 $ARGUMENTS 占位符时原位替换，否则追加在模板之后
function append(template: string, input: string) {
  // 去除输入首尾空白
  const value = input.trim()
  // 含占位符时全部替换（用函数形式，避免 "$&" 等特殊替换序列被解释）
  if (template.includes("$ARGUMENTS")) return template.replaceAll("$ARGUMENTS", () => value)
  // 否则用空行拼接模板与输入（过滤空串）
  return [template, value].filter(Boolean).join("\n\n")
}

// parseArguments：按正则把输入切分为参数数组（支持引号包裹与图片占位符）
function parseArguments(input: string) {
  // 匹配所有参数并去掉首尾引号
  return (input.match(argsRegex) ?? []).map((argument) => argument.replace(quoteTrimRegex, ""))
}

// promptMessageText：从 MCP 消息内容中提取纯文本（非文本类型返回空串）
function promptMessageText(content: unknown) {
  // 字符串内容直接返回
  if (typeof content === "string") return content
  // 非对象（含 null/undefined）返回空串
  if (!content || typeof content !== "object") return ""
  // 不是 text 类型返回空串
  if (!("type" in content) || content.type !== "text") return ""
  // text 字段不是字符串返回空串
  if (!("text" in content) || typeof content.text !== "string") return ""
  // 返回文本内容
  return content.text
}

// mcpCommandName：生成 "server:prompt" 形式的命令名（两端都经清洗）
function mcpCommandName(server: string, prompt: string) {
  return `${sanitize(server)}:${sanitize(prompt)}`
}

// sanitize：把字母数字下划线连字符之外的字符替换为下划线
function sanitize(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_")
}

// 参数切分正则：匹配 [Image N] 占位符、双引号串、单引号串或普通非空白词
const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
// 去除参数首尾引号的正则
const quoteTrimRegex = /^["']|["']$/g
