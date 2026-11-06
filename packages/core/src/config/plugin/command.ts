// 配置命令插件（Config Command Plugin）：从配置与 command(s) 目录的 Markdown 文件加载自定义命令。
export * as ConfigCommandPlugin from "./command.js"

// 导入插件定义工具。
import { define } from "@opencode/plugin/effect/plugin"
// 导入配置条目（Entry）类型。
import type { Entry } from "@opencode/schema/config"
// 导入命令配置模式。
import { ConfigCommand } from "@opencode/schema/config/command"
// 导入应用进程服务。
import { AppProcess } from "@opencode/util/process"
// 导入 Node 的 path 模块。
import path from "path"
// 导入 Effect、Option 与 Schema 工具。
import { Effect, Option, Schema } from "effect"
// 导入 Effect 的子进程工具。
import { ChildProcess } from "effect/process"
// 导入代理服务。
import { Agent } from "../../agent.js"
// 导入配置服务。
import { Config } from "../../config.js"
// 导入位置服务。
import { Location } from "../../location.js"
// 导入会话（session）服务。
import { Session } from "../../session.js"
// 导入子代理任务服务。
import { SubagentJob } from "../../session/subagent-job.js"
// 导入 shell 选择服务。
import { ShellSelect } from "../../shell/select.js"
// 导入文件系统工具服务。
import { FSUtil } from "@opencode/util/fs-util"
// 导入 Markdown 解析工具。
import { ConfigMarkdown } from "../markdown.js"
// 导入配置条目观察器。
import { ConfigEntryObserver } from "./entry-observer.js"

// V2 命令模式的解码器。
const decodeCommand = Schema.decodeUnknownOption(ConfigCommand.Info)

// 定义插件：加载命令定义并注册到命令注册表。
export const Plugin = define({
  // 插件 ID。
  id: "opencode.config.command",
  // 插件主流程。
  effect: Effect.fn(function* (ctx) {
    // 获取配置服务。
    const config = yield* Config.Service
    // 获取文件系统工具服务。
    const fs = yield* FSUtil.Service
    // 加载单个条目：文档取其 commands；目录则扫描 Markdown 命令文件。
    const loadEntry = Effect.fnUntraced(function* (entry: Entry) {
      // 文档条目：直接取配置中的命令映射。
      if (entry.type === "document") return [{ commands: entry.info.commands }]
      // 非目录条目忽略。
      if (entry.type !== "directory") return []
      // 扫描并解码目录下的命令文件。
      const commands = yield* loadDirectory(fs, entry.path)
      // 转成 名称 → 命令信息 的映射。
      return [{ commands: Object.fromEntries(commands.map((command) => [command.name, command.info])) }]
    })
    // 获取位置服务。
    const location = yield* Location.Service
    // 获取应用进程服务。
    const processes = yield* AppProcess.Service
    // 获取 shell 选择服务。
    const shell = yield* ShellSelect.Service
    // 获取会话服务。
    const sessions = yield* Session.Service
    // 获取代理服务。
    const agents = yield* Agent.Service
    // 获取子代理任务服务。
    const subagents = yield* SubagentJob.Service
    // 加载全部配置条目的命令并摊平。
    const load = Effect.fn("ConfigCommandPlugin.load")(function* () {
      return yield* Effect.forEach(yield* config.entries(), loadEntry).pipe(Effect.map((documents) => documents.flat()))
    })
    // 观察配置来源：更新或文件变化时自动重载。
    const loaded = yield* ConfigEntryObserver.observeSources({
      config,
      event: ctx.event,
      directories: sourceDirectories,
      load,
      reload: ctx.command.reload(),
    })
    // 把命令写入命令编辑器。
    yield* ctx.command.transform((editor) => {
      // 遍历每个文档中的命令。
      for (const document of loaded.documents) {
        for (const [name, command] of Object.entries(document.commands ?? {})) {
          // 旧字段 subtask 作为 subagent 的别名。
          const subagent = command.subagent ?? command.subtask
          // 注册命令及其执行逻辑。
          editor.add({
            name,
            description: command.description,
            execute: (input) =>
              Effect.gen(function* () {
                // 命令指定的代理 ID。
                const agent = command.agent === undefined ? undefined : Agent.ID.make(command.agent)
                // 取出该代理的运行时数据。
                const commandAgent = agent === undefined ? undefined : (yield* ctx.agent.get({ agentID: agent })).data
                // 模型选择：优先命令指定，其次代理默认。
                const model =
                  command.model === undefined
                    ? commandAgent?.model
                    : {
                        id: command.model.model,
                        providerID: command.model.providerID,
                        ...(command.model.variant === undefined ? {} : { variant: command.model.variant }),
                      }
                // 渲染命令模板（替换参数占位符与 shell 插值）。
                const text = yield* evaluateTemplate(command.template, input.prompt.text, {
                  location,
                  processes,
                  shell,
                })
                // 子代理命令：在新的子会话中执行。
                if (subagent ?? commandAgent?.mode === "subagent") {
                  // 取父会话。
                  const parent = yield* sessions.get(input.sessionID)
                  // 选择要使用的代理（命令指定或继承父会话）。
                  const selected = yield* agents.select(agent ?? parent.agent)
                  // 创建子会话（标题取命令描述或命令名）。
                  const child = yield* sessions.create({
                    parentID: parent.id,
                    title: command.description ?? name,
                    agent: selected.id,
                    model: model ?? selected.info?.model ?? parent.model,
                  })
                  // 向子会话发送提示词（注明由其他会话派生）。
                  yield* sessions.prompt({
                    ...input.prompt,
                    sessionID: child.id,
                    text: ["You are a subagent spawned by another session.", text].join("\n"),
                    resume: false,
                  })
                  // 记录子代理任务的恢复信息。
                  const recovery = {
                    kind: "subagent" as const,
                    parentSessionID: parent.id,
                    childSessionID: child.id,
                    agent: selected.id,
                    description: command.description ?? name,
                  }
                  // 启动任务跟踪。
                  yield* subagents.start(recovery)
                  // 标记为后台任务。
                  yield* subagents.background(recovery)
                  // 子代理流程结束。
                  return
                }
                // 命令指定了代理时切换当前会话的代理。
                if (agent !== undefined) {
                  const session = yield* ctx.session.get({ sessionID: input.sessionID })
                  // 代理不同才切换。
                  if (session.agent !== agent) yield* ctx.session.switchAgent({ sessionID: input.sessionID, agent })
                }
                // 有模型选择时切换会话模型。
                if (model !== undefined) yield* ctx.session.switchModel({ sessionID: input.sessionID, model })
                // 向当前会话投递渲染后的提示词。
                yield* ctx.session.prompt({
                  ...input.prompt,
                  sessionID: input.sessionID,
                  text,
                  delivery: input.delivery,
                })
              }).pipe(Effect.asVoid),
          })
        }
      }
    })
  }),
})

// Keep in sync with the loadDirectory scan pattern and the name-strip regex in decode.
// 与 loadDirectory 的扫描模式及 decode 中剥离目录名的正则保持同步。
const sourceDirectories = ["command", "commands"] as const

// 扫描目录下 command(s) 的 Markdown 命令文件并解码。
function loadDirectory(fs: FSUtil.Interface, directory: string) {
  return Effect.gen(function* () {
    // 扫描文件（失败返回空列表）。
    const files = yield* fs
      .scan("{command,commands}/**/*.md", { cwd: directory, absolute: true, dot: true, symlink: true })
      .pipe(Effect.orElseSucceed(() => [] as string[]))
    // 排序后逐个读取并解码，失败项忽略。
    return yield* Effect.forEach(files.toSorted(), (filepath) =>
      fs.readFileStringSafe(filepath).pipe(
        // 读取成功才解码。
        Effect.map((content) => (content === undefined ? undefined : decode(directory, filepath, content))),
        // 错误吞掉并返回 undefined。
        Effect.orElseSucceed(() => undefined),
      ),
    ).pipe(
      // 过滤掉解码失败的项。
      Effect.map((commands) =>
        commands.filter((command): command is { name: string; info: ConfigCommand.Info } => command !== undefined),
      ),
    )
  })
}

// 解码单个命令 Markdown 文件。
function decode(directory: string, filepath: string, content: string) {
  // 解析 Markdown；失败忽略。
  const markdown = ConfigMarkdown.parseOption(content)
  if (!markdown) return
  // frontmatter 数据即命令字段，正文即模板。
  const info = Option.getOrUndefined(decodeCommand({ ...markdown.data, template: markdown.content.trim() }))
  // 解码失败忽略。
  if (!info) return
  // 返回命令名（相对路径去掉 command(s)/ 前缀与 .md 后缀）与命令信息。
  return {
    name: path
      .relative(directory, filepath)
      .replaceAll("\\", "/")
      .replace(/^(command|commands)\//, "")
      .replace(/\.md$/, ""),
    info,
  }
}

// 渲染命令模板：替换 $ARGUMENTS/$N 参数占位符，并执行 !`命令` shell 插值。
function evaluateTemplate(
  template: string,
  input: string,
  services: {
    readonly location: Location.Info
    readonly processes: AppProcess.Interface
    readonly shell: ShellSelect.Interface
  },
) {
  return Effect.gen(function* () {
    // 解析用户输入的参数列表。
    const args = parseArguments(input)
    // 模板中出现的 $N 占位符。
    const placeholders = template.match(placeholderRegex) ?? []
    // 最大占位符序号（决定末位参数吞并剩余参数）。
    const last = Math.max(0, ...placeholders.map((item) => Number(item.slice(1))))
    // 替换模板中的参数占位符。
    const withArguments = template.replaceAll(argumentRegex, (match, index) => {
      // $ARGUMENTS 替换为完整原始输入。
      if (match === "$ARGUMENTS") return input
      // 计算占位符序号对应的参数下标。
      const position = Number(index)
      const argIndex = position - 1
      // 超出参数数量时替换为空串。
      if (argIndex >= args.length) return ""
      // 最大序号的占位符吞并剩余全部参数。
      if (position === last) return args.slice(argIndex).join(" ")
      // 否则取对应位置的参数。
      return args[argIndex]
    })
    // 模板未使用任何占位符且输入非空时，把输入追加在模板之后。
    const text =
      placeholders.length === 0 && !template.includes("$ARGUMENTS") && input.trim()
        ? `${withArguments}\n\n${input}`.trim()
        : withArguments.trim()
    // 查找文本中的 shell 插值点。
    const matches = Array.from(text.matchAll(shellRegex))
    // 没有 shell 插值直接返回文本。
    if (matches.length === 0) return text
    // 按配置优先级解析要用的 shell。
    const shell = yield* services.shell.resolve({ priority: "config" })
    // 并发（最多 2 个）执行每个 shell 插值命令。
    const outputs = yield* Effect.forEach(
      matches,
      (match) => {
        // 插值中的命令文本。
        const source = match[1] ?? ""
        // 用所选 shell 执行命令并合并输出。
        return services.processes
          .run(
            ChildProcess.make(shell, ShellSelect.args(shell, source), {
              cwd: services.location.directory,
              stdin: "ignore",
            }),
            { combineOutput: true },
          )
          .pipe(
            // 取合并输出（兼容旧字段，缺省拼接 stdout 与 stderr）。
            Effect.map((result) => (result.output ?? Buffer.concat([result.stdout, result.stderr])).toString("utf8")),
            // 失败包装为可读错误。
            Effect.mapError(
              (error) => new Error(`Shell interpolation failed for ${JSON.stringify(source)}: ${error.message}`),
            ),
          )
      },
      { concurrency: 2 },
    )
    // 按出现顺序把命令输出填回文本。
    const iterator = outputs[Symbol.iterator]()
    return text.replace(shellRegex, () => iterator.next().value ?? "")
  })
}

// 解析输入参数：支持 [Image N]、双引号、单引号与裸词。
function parseArguments(input: string) {
  return (input.match(argsRegex) ?? []).map((arg) => arg.replace(quoteTrimRegex, ""))
}

// 参数分词正则（i 忽略大小写以匹配 [IMAGE N] 等变体）。
const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
// $N 占位符正则。
const placeholderRegex = /\$([1-9]\d*)/g
// $ARGUMENTS 或 $N 正则。
const argumentRegex = /\$(?:ARGUMENTS|([1-9]\d*))/g
// 去除参数首尾引号的正则。
const quoteTrimRegex = /^["']|["']$/g
// shell 插值正则：!`命令`。
const shellRegex = /!`([^`]+)`/g
