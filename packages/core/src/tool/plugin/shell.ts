// =====================================================================
// 文件角色：ShellTool —— shell 命令执行工具（“bash”类工具的代表实现）。
// 管线：参数 schema → 目录/命令解析与外部目录授权 → 权限断言 → 生成 shell
// → 以“作业（Job）”形式执行（可前台阻塞等待/后台通知）→ 结果截断与通知。
// 亮点：前台命令可被用户“转为后台”；后台命令完成后自动发合成消息唤醒会话。
// =====================================================================
export * as ShellTool from "./shell.js"

// ToolFailure：ai 包里的工具失败类型。
import { ToolFailure } from "@opencode/ai/effect"
// 插件上下文与各钩子的类型。
import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import type { ShellCreateBefore } from "@opencode/plugin/effect/shell"
import type { Tool } from "@opencode/schema/tool"
// effect：Deferred（一次性异步结果）、Schema、Scope（作用域）。
import { Deferred, Effect, Schema, Scope } from "effect"
// 环境服务（文件系统类型校验）。
import { Environment } from "../../environment/index.js"
// 作业系统。
import { Job } from "../../job.js"
// 文件访问控制（目录解析与外部目录授权）。
import { FileAccess } from "../../file-access.js"
// 权限系统。
import { Permission } from "../../permission.js"
// 非负整数 Schema。
import { NonNegativeInt } from "../../schema.js"
// 会话服务（发合成消息）。
import { Session } from "../../session.js"
import { SessionSchema } from "../../session/schema.js"
// shell 服务与解析/选择/结果工具。
import { Shell } from "../../shell.js"
import { ShellParse } from "../../shell/parse.js"
import { ShellSelect } from "../../shell/select.js"
import { ShellResult } from "../../shell/result.js"

// 工具名与默认超时（2 分钟）。
export const name = "shell"
export const DEFAULT_TIMEOUT_MS = 2 * 60 * 1_000

// BACKGROUND_INSTRUCTION：后台命令返回时附带的指令——别轮询，干别的活，
// 完成后会自动通知你。
const BACKGROUND_INSTRUCTION =
  "You will be notified automatically when the command finishes. The notification will include the command's output. Unless the user explicitly asks otherwise, DO NOT poll for completion, even if you need the final result to continue. Repeatedly sleeping and reading or searching the output file is polling, not useful work. You may read the current output if it lets you do useful work now, but do not repeatedly check it while waiting for the command to finish. Keep working on anything that does not depend on the result. If you have nothing else to do, end your response; you will be resumed automatically when the command finishes."
// 当前操作系统的友好名（放进工具描述）。
const OS =
  process.platform === "darwin"
    ? "macOS"
    : process.platform === "win32"
      ? "Windows"
      : process.platform === "linux"
        ? "Linux"
        : process.platform
// description：动态生成工具描述（可附带实际使用的 shell）。
const description = (shell?: string) =>
  [
    "Execute a shell command and return its output.",
    ...(shell ? [`Commands run on ${OS} using ${shell}.`] : []),
    "Quote file paths containing spaces or special characters.",
    "Prefer dedicated tools over shell commands when possible.",
    "When output is large, the full result is saved to a file and a truncated preview is returned.",
    "Rely on automatic truncation unless filtering the output is more useful.",
    "Commands accept an optional timeout, background commands have no timeout by default.",
    "Background commands return immediately, and you will be notified when they complete.",
  ].join(" ")

// 输入 Schema：command / workdir / timeout / background。
export const Input = Schema.Struct({
  command: Schema.String.annotate({ description: "Shell command string to execute" }),
  workdir: Schema.optionalKey(Schema.String).annotate({
    description:
      "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead.",
  }),
  timeout: Schema.optionalKey(NonNegativeInt).annotate({
    description: `Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to ${DEFAULT_TIMEOUT_MS} for foreground commands. Background commands have no timeout by default.`,
  }),
  background: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion.",
  }),
})

// 结构化输出（不含正文）：退出码/信号/shell ID/是否截断/是否超时。
const StructuredOutput = Schema.Struct({
  exit: Schema.optionalKey(Schema.Number),
  signal: Schema.optionalKey(Schema.String),
  shellID: Schema.optionalKey(Schema.String),
  truncated: Schema.Boolean,
  timeout: Schema.optionalKey(Schema.Boolean),
})

// 完整输出：结构化字段 + 正文 output + status（completed/running）。
const Output = Schema.Struct({
  ...StructuredOutput.fields,
  output: Schema.String,
  status: Schema.optionalKey(Schema.Literals(["completed", "running"])),
})

type Output = typeof Output.Type

// resultMessages：正文 + 附带说明（后台指令或结果提示）。
const resultMessages = (output: Output) => {
  const notice = output.status === "running" ? BACKGROUND_INSTRUCTION : ShellResult.notice(output)
  return [...(output.output ? [output.output] : []), ...(notice ? [notice] : [])]
}

// toolResult：包装成标准工具结果（output + content + metadata）。
const toolResult = (output: Output) => {
  return {
    output,
    content: resultMessages(output).map((text) => ({ type: "text" as const, text })),
    metadata: {
      status: output.status,
      ...ShellResult.metadata(output),
      ...(output.shellID !== undefined ? { shellID: output.shellID } : {}),
    },
  }
}

// backgroundResult：后台启动时立即返回的“已转后台”提示（含输出文件路径）。
const backgroundResult = (shellID: string, file: string) => ({
  output: `Command moved to the background (shell ID: ${shellID}).\nOutput is streaming to: ${file}`,
  shellID,
  truncated: false,
  status: "running" as const,
})

// 以插件形式实现（opencode.tool.shell），随 Location 装配。
export const Plugin = {
  id: "opencode.tool.shell",
  effect: Effect.fn("ShellTool.Plugin")(function* (ctx: Context) {
    // 依赖：会话、作业、作用域、环境、文件访问、shell、兼容 shell 选择、权限。
    const sessions = yield* Session.Service
    const jobs = yield* Job.Service
    const scope = yield* Scope.Scope
    const environment = yield* Environment.Service
    const access = yield* FileAccess.Service
    const shell = yield* Shell.Service
    const shellSelect = yield* ShellSelect.Service
    // 兼容性优先的 shell（比如 Windows 上的 Git Bash）。
    const compatibleShell = shellSelect.resolve({ priority: "compat" })
    const permission = yield* Permission.Service

    // prepare：执行前检查（在 shell.create 的回调里跑）。
    const prepare = Effect.fn("ShellTool.prepare")(function* (invocation: ShellCreateBefore, context: Tool.Context) {
      // 解析并固定工作目录（授权可以活得更久，目录可能中途变化）。
      const target = yield* access.resolve({ path: invocation.cwd, kind: "directory" })
      invocation.cwd = target.absolute
      const timeout = invocation.timeout
      // 解析命令：找出涉及的目录与具体命令（含 && 等组合）。
      const parsed = yield* ShellParse.scan(invocation.command, invocation.shell, target.absolute)
      // 命令涉及的每个目录都要解析并授权（含 Location 之外的）。
      const directories = yield* Effect.forEach(parsed.directories, (directory) =>
        access.resolve({
          path: FileAccess.resolvePath(target.absolute, directory),
          kind: "directory",
        }),
      )
      yield* access.authorizeExternal([target, ...directories], context)
      // 每条具体命令都要过一次权限断言（用户逐条批准/记住）。
      if (parsed.commands.length > 0)
        yield* permission.assert({
          action: name,
          resources: parsed.commands.map((command) => command.resource),
          save: parsed.commands.map((command) => command.save),
          ...Permission.invocation(context),
        })
      // Approval can outlive the directory, so validate immediately before spawning.
      // 授权期间目录可能被删：spawn 前最后一刻再验证一次工作目录。
      const workdir = yield* Environment.typeFollowing(environment.files, target.absolute).pipe(
        Effect.catchTag("Environment.NotFound", () =>
          Effect.fail(new Error(`Working directory does not exist: ${target.absolute}`)),
        ),
      )
      if (workdir !== "directory")
        return yield* Effect.fail(new Error(`Working directory is not a directory: ${target.absolute}`))
      return timeout
    })

    // notifyWhenDone：后台命令结束后的通知 fiber。
    const notifyWhenDone = Effect.fn("ShellTool.notifyWhenDone")(
      function* (
        sessionID: SessionSchema.ID,
        id: string,
        shellID: string,
        command: string,
        settled: Deferred.Deferred<Output>,
      ) {
        // 等作业结束。
        const info = (yield* jobs.wait({ id })).info
        if (!info || info.status === "running") return
        // 成功：取结果正文；失败/取消：给对应文案。
        const output = info.status === "completed" ? yield* Deferred.await(settled) : undefined
        const text = output
          ? resultMessages(output).join("\n\n")
          : info.status === "error"
            ? (info.error ?? "Command failed")
            : "Cancelled"
        // 发合成消息（描述=命令，正文=输出），唤醒会话继续干活。
        yield* sessions.synthetic({
          ...(info.notificationID ? { id: info.notificationID } : {}),
          sessionID,
          description: command,
          ...ShellResult.notification({
            jobID: id,
            shellID,
            command,
            state: info.status,
            text,
            output,
          }),
        })
        if (info.notificationID) yield* jobs.completeBackground(info.notificationID)
      },
      // fork 进插件作用域，立即启动。
      Effect.forkIn(scope, { startImmediately: true }),
    )

    // 注册工具本体。
    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          // codemode=false：不进 Code Mode 目录，始终作为直接工具暴露。
          options: { codemode: false },
          description: description(),
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              // 超时：后台默认无超时（0），前台默认 2 分钟。
              const timeout = input.background === true ? (input.timeout ?? 0) : (input.timeout ?? DEFAULT_TIMEOUT_MS)
              let finalTimeout = timeout
              // 创建 shell；回调里注入环境变量并做 prepare 检查。
              const info = yield* shell.create(
                {
                  command: input.command,
                  cwd: input.workdir,
                  timeout,
                  shell: yield* compatibleShell,
                  metadata: { sessionID: context.sessionID },
                },
                (invocation) =>
                  Effect.gen(function* () {
                    // 给子进程打上“agent 在跑”的标记。
                    invocation.env.AGENT = "1"
                    invocation.env.OPENCODE = "1"
                    invocation.env.AI_AGENT ||= "opencode"
                    invocation.env.OPENCODE_SESSION_ID = context.sessionID
                    finalTimeout = yield* prepare(invocation, context)
                  }),
              )
              // 立刻上报 shell ID（UI 可显示/中断）。
              yield* context.progress({ shellID: info.id })

              // settled：命令完整结果的一次性信箱。
              const settled = yield* Deferred.make<Output>()
              // run：作业的执行体——等 shell 结果 → 组装输出 → 成功时填充
              // settled；被中断时清理 shell。
              const run = Effect.gen(function* () {
                const result = yield* shell.result(info)
                if (!result.capture) return yield* new Shell.NotFoundError({ id: info.id })
                const output = ShellResult.output(result)
                return {
                  ...output,
                  // 超时的输出尾部追加提示。
                  output: output.timeout
                    ? `${output.output}\n\nCommand exceeded timeout of ${finalTimeout} ms. Retry with a larger timeout if the command is expected to take longer.`
                    : output.output,
                  status: "completed" as const,
                }
              }).pipe(
                Effect.tap((output) => Deferred.succeed(settled, output)),
                Effect.map((output) => resultMessages(output).join("\n\n")),
                Effect.onInterrupt(() => shell.remove(info.id).pipe(Effect.ignore)),
              )
              // 以作业形式启动（可恢复：崩溃后按 recovery 信息找回 shell）。
              const job = yield* jobs.start({
                // CodeMode children share a tool-call ID, but each shell must own its job.
                // CodeMode 子进程共享工具调用 ID，但每个 shell 要有独立的作业 ID。
                id: info.id,
                type: name,
                title: info.command,
                metadata: { sessionID: context.sessionID, shellID: info.id },
                recovery: {
                  kind: "shell",
                  sessionID: context.sessionID,
                  shellID: info.id,
                  command: info.command,
                },
                run,
              })

              // 显式请求后台：转后台 + 注册通知 + 立即返回。
              if (input.background === true) {
                yield* jobs.background(job.id)
                yield* notifyWhenDone(context.sessionID, job.id, info.id, info.command, settled)
                return backgroundResult(info.id, info.file)
              }

              // 前台：阻塞等待作业结果；等待被中断（用户取消）时取消作业。
              const result = yield* jobs
                .block({ id: job.id, sessionID: context.sessionID })
                .pipe(Effect.onInterrupt(() => jobs.cancel(job.id).pipe(Effect.ignore)))
              // 等待期间被“转后台”→ 去掉超时，注册通知，返回后台提示。
              if (result?.type === "backgrounded") {
                yield* shell.timeout(info.id, 0)
                yield* notifyWhenDone(context.sessionID, job.id, info.id, info.command, settled)
                return backgroundResult(info.id, info.file)
              }
              // 失败/取消 → 工具失败。
              if (result?.info.status === "error")
                return yield* Effect.fail(new Error(result.info.error ?? "Command failed"))
              if (result?.info.status === "cancelled") return yield* Effect.fail(new Error("Command cancelled"))

              // 正常完成：从信箱取结果。
              return yield* Deferred.await(settled)
            }).pipe(
              // 统一包装结果/错误。
              Effect.map(toolResult),
              Effect.mapError(
                (error) => new ToolFailure({ message: `Unable to execute command: ${input.command}`, error }),
              ),
            ),
        }),
      )
      .pipe(Effect.orDie)

    // hook：会话上下文钩子——把工具描述换成带真实 shell 名的版本。
    const hook = (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
        const tool = event.tools[name]
        if (!tool) return
        tool.description = description(ShellSelect.name(yield* compatibleShell))
      })
    // 在 context/compaction/generate 三类钩子上都挂上（描述在每种请求里都正确）。
    yield* ctx.session.hook("context", hook)
    yield* ctx.session.hook("compaction", hook)
    yield* ctx.session.hook("generate", hook)
  }),
}
