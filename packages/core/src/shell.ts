// 以命名空间形式导出 Shell 模块
export * as Shell from "./shell.js"

// 引入 Node 的 path 模块，用于拼接输出文件路径
import path from "path"
import {
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Latch,
  Layer,
  Option,
  Schema,
  Schedule,
  Stream,
} from "effect"
import { ChildProcess } from "effect/process"
// 引入 immer 的 produce，用于不可变地更新命令信息快照
import { produce } from "immer"
// 引入 Shell 相关 schema（ID、Info、事件等定义）
import { Shell } from "@opencode/schema/shell"
// 引入应用内进程错误类型
import { AppProcess } from "@opencode/util/process"
// 引入跨平台 spawn 封装（含“被信号杀死”等错误类型）
import { CrossSpawnSpawner } from "@opencode/util/cross-spawn-spawner"
// 引入全局/位置级服务节点构造工具
import { makeGlobalNode, makeLocationNode } from "@opencode/util/effect/app-node"
// 引入文件系统工具服务
import { FSUtil } from "@opencode/util/fs-util"
// 引入内部模块：事件总线
import { Bus } from "./bus.js"
// 引入环境（Environment）服务，负责实际拉起进程
import { Environment } from "./environment/index.js"
// 引入按保留期清理文件的工具
import { FileRetention } from "./file-retention.js"
// 引入位置（Location）服务，提供项目/目录信息
import { Location } from "./location.js"
// 引入全局数据目录服务
import { Global } from "@opencode/util/global"
import { PersistentPty } from "./persistent-pty.js"
import { ShellSelect } from "./shell/select.js"
// 引入插件在 shell 创建前可修改的调用入参类型
import type { ShellCreateBefore } from "@opencode/plugin/effect/shell"
// 引入插件钩子服务
import { PluginHooks } from "./plugin/hooks.js"
// 引入会话级环境变量服务
import { SessionEnvironment } from "./session/environment.js"
// 引入会话 schema（用于校验会话 ID）
import { SessionSchema } from "./session/schema.js"
// 引入配置服务（读取 tool_output 限制）
import { Config } from "./config.js"
// 引入工具输出服务（默认行数/字节限制）
import { ToolOutput } from "./tool-output.js"
// 引入 shell 结果类型（终态 + 有界尾部输出）
import { ShellResult } from "./shell/result.js"

// 定义“找不到 shell 命令”的标签错误
export class NotFoundError extends Schema.TaggedError<NotFoundError>()("Shell.NotFoundError", {
  // 错误体携带 shell 的 ID
  id: Shell.ID,
}) {}

// Keep recent exited processes observable in memory, including their file-backed output.
// The process-local cap complements the time-based sweep, which also cleans files left by restarts.
// （中文）让最近退出的进程仍在内存中可观察（包括其落盘输出）。进程数上限与按时间清理互补，
// 后者还会清理重启遗留的文件。
// 内存中保留的已退出命令数量上限
const EXITED_LIMIT = 25
// 已退出进程的保留时长：7 天
export const RETENTION = Duration.days(7)
// 输出文件在数据目录下的子目录名
export const DIRECTORY = "shell"
const SPAN_COMMAND_LIMIT = 200
const STOP_GRACE = Duration.seconds(3)
const LOST = "Command was killed: the process daemon stopped"
// Bounds the reads a result needs when the daemon did not report the line count, so stopping a call stays quick.
const COUNT_NEWLINES_LIMIT = 16 * 1024 * 1024
const LINE_START_SCAN_LIMIT = 1024 * 1024

// Info 的类型别名
type Info = Shell.Info
export type StopReason = "timeout" | "killed"
/** The tool call that started a command, so a server that took over can settle it. */
export const ToolCall = Schema.Struct({
  sessionID: Schema.String,
  assistantMessageID: Schema.String,
  callID: Schema.String,
})
export type ToolCall = typeof ToolCall.Type

type CreateInput = Shell.CreateInput & {
  shell?: string
  toolCall?: ToolCall
  // A call waits on the command. A server that takes the command over moves it to the background, which clears
  // its timeout, so its deadline is not kept for a restart.
  waited?: boolean
}

// What a server needs to take a daemon-run command back after a restart, kept in the daemon's metadata.
const Stored = Schema.Struct({
  id: Shell.ID,
  command: Schema.String,
  shell: Schema.String,
  location: Schema.Struct({ directory: Schema.String, workspaceID: Schema.optionalKey(Schema.String) }),
  metadata: Shell.Metadata,
  toolCall: Schema.optional(ToolCall),
  timeoutDeadline: Schema.optional(Schema.Number),
  stopReason: Schema.optional(Schema.Literals(["timeout", "killed"])),
})
type Stored = typeof Stored.Type
const decodeStored = Schema.decodeUnknownOption(Stored)

// A command this server spawned itself. It dies with its Location.
type Spawned = {
  kind: "spawned"
  // Immutable snapshot; lifecycle updates replace it via immer `produce`.
  // （中文）不可变的信息快照；生命周期更新通过 immer `produce` 生成新对象整体替换
  info: Info
  size: number
  // 目前已写入文件的换行符数量（用于截断提示，避免重扫输出文件）
  newlines: number
  // Byte offsets where the last two lines start, so a truncation notice can size a cut-off line.
  lineStarts: [number, number]
  // Resolves with the terminal Info once the command exits, times out, or is killed. A wait
  // started after termination resolves immediately from the already-completed deferred.
  // （中文）命令退出、超时或被杀后以最终 Info 完成（resolve）；终止后发起的等待会立即从
  // 已完成的 Deferred 拿到结果
  done: Deferred.Deferred<Info, NotFoundError>
  // 当前超时定时器纤程（若已设置）
  timeoutFiber?: Fiber.Fiber<void>
  // 重新设置超时的函数（由 create 内部实现后注入）
  timeout?: (duration: number) => Effect.Effect<void>
  stop?: (reason: StopReason) => Effect.Effect<void>
}

// A command the process daemon runs. The daemon writes and counts its output file. It belongs to the server, not
// to the Location that started it, so a Location closing or reloading never stops or forgets it.
type Run = {
  kind: "daemon"
  info: Info
  process: number
  toolCall?: ToolCall
  // When a restart should stop it. Unset while a call waits on it: that call's timeout dies with this server.
  timeoutDeadline?: number
  stopReason?: StopReason
  // From the exit: newlines in the file, and why the daemon stopped writing it early.
  outputLines?: number
  outputError?: string
  // Why it was killed without a signal of its own.
  killed?: string
  done: Deferred.Deferred<Info, NotFoundError>
  timeoutFiber?: Fiber.Fiber<void>
  stopping?: Fiber.Fiber<void>
  wait?: Fiber.Fiber<void>
}

type Command = Spawned | Run

type Ended = {
  status: "exited" | StopReason
  exit?: number
  // 终止信号（若被信号杀死）
  signal?: string
  // 记录终态的时间戳
  completed: number
}

/**
 * Location-owned non-interactive shell command process service.
 *
 * Each `create` starts one shell command, captures combined stdout/stderr to a
 * file, and returns an ID. Clients poll `get` for status and `output` for
 * file-backed output by cursor. No session, message, or permission state lives
 * here; callers (e.g. `ShellTool`) own that association and store the shell ID.
 *
 * Local commands run in the process daemon when it is available (`Daemon`), so they outlive a planned server
 * restart: the next server takes them back. Remote workspaces and an unavailable daemon keep spawning them from
 * the server.
 */
// （中文）由 Location 持有的非交互式 shell 命令进程服务。每次 `create` 拉起一条 shell 命令，
// 把合并的 stdout/stderr 捕获到文件并返回一个 ID。客户端轮询 `get` 获取状态，按游标（cursor）
// 用 `output` 读取落盘输出。此处不持有会话/消息/权限状态；调用方（如 `ShellTool`）负责该关联并保存 shell ID。
export interface Interface {
  // 创建并启动一条 shell 命令；可选的 before 钩子在真正拉起前执行（可携带调用方自定义的效果类型）
  readonly create: <E = never, R = never>(
    input: CreateInput,
    before?: (input: ShellCreateBefore) => Effect.Effect<void, E, R>,
  ) => Effect.Effect<Shell.Info, E | AppProcess.AppProcessError, R>
  // Currently running commands only; exited shells are retained for get/output but excluded here.
  // （中文）仅列出仍在运行的命令；已退出的 shell 仍可用于 get/output，但不包含在此列表中
  readonly list: () => Effect.Effect<Shell.Info[]>
  // 按 ID 获取命令信息；未知 ID 报 NotFoundError
  readonly get: (id: Shell.ID) => Effect.Effect<Shell.Info, NotFoundError>
  // Resolves once the command reaches a terminal status, returning its final Info. Fails with
  // NotFoundError if the command is unknown or is removed before it terminates.
  // （中文）等待命令到达终态并返回其最终 Info；命令不存在或在终止前被移除则报 NotFoundError
  readonly wait: (id: Shell.ID) => Effect.Effect<Shell.Info, NotFoundError>
  // A known shell's terminal state and bounded tail. Missing capture remains distinct from its exit status.
  // With `wait`, stops waiting for the exit after that long and returns the output so far, still running.
  readonly result: (
    started: Shell.Info,
    options?: { readonly wait?: Duration.Input },
  ) => Effect.Effect<ShellResult.Result>
  // Replaces the running command's timeout from now; zero clears it. Ignored once the command has
  // ended or timed out, even while its process is still being killed or its output captured.
  // （中文）从现在起替换运行中命令的超时；0 表示清除。命令已结束或已超时后忽略，
  // 即便进程还在被杀死或输出还在捕获中
  readonly timeout: (id: Shell.ID, duration: number) => Effect.Effect<Shell.Info, NotFoundError>
  // Stops a running command gracefully (SIGTERM, then SIGKILL after 3 s) without forgetting it: it ends
  // with the given status and stays observable, file included, until retention evicts it. Returns at
  // once; `wait` observes the exit. Ignored once the command has ended or is already stopping.
  readonly stop: (id: Shell.ID, reason: StopReason) => Effect.Effect<Shell.Info, NotFoundError>
  // The daemon command a tool call started, while it is known here (including one taken back after a restart).
  readonly byToolCall: (call: ToolCall) => Effect.Effect<Shell.Info | undefined>
  readonly output: (id: Shell.ID, input?: Shell.OutputInput) => Effect.Effect<Shell.Output, NotFoundError>
  // 移除命令记录并删除其输出文件
  readonly remove: (id: Shell.ID) => Effect.Effect<void, NotFoundError>
  /** Runs `effect` until it ends or the server stops, outliving this Location (e.g. a job's completion notice). */
  readonly watch: DaemonInterface["watch"]
  /** Whether the server is handing its daemon commands over to the next one, which takes them over. */
  readonly handoffPrepared: () => boolean
}

// 定义 Shell 服务标记类
export class Service extends Context.Service<Service, Interface>()("@opencode/Shell") {}

// （中文）清理过期的 shell 输出文件：遍历数据目录 shell/<项目>/ 下匹配 sh_<12位十六进制>*.out 的文件，按保留期删除
export const cleanup = Effect.fn("Shell.cleanup")(function* () {
  // 获取文件系统工具服务
  const fs = yield* FSUtil.Service
  // 获取全局数据目录服务
  const global = yield* Global.Service
  const pty = yield* PersistentPty.Service
  const directory = path.join(global.data, DIRECTORY)
  // 读取根目录下的项目子目录；目录不存在等错误一律按空数组处理
  const projects = yield* fs.readDirectoryEntries(directory).pipe(
    Effect.map((entries) => entries.filter((entry) => entry.type === "Directory")),
    Effect.orElseSucceed(() => []),
  )
  // 并发度 8 地枚举每个项目目录下符合输出文件命名的绝对路径
  const files = yield* Effect.forEach(
    projects,
    (project) =>
      fs.readDirectoryEntries(path.join(directory, project.name)).pipe(
        Effect.map((entries) =>
          entries.flatMap((entry) =>
            entry.type === "File" && /^sh_[0-9a-f]{12}.*\.out$/.test(entry.name)
              ? [path.join(directory, project.name, entry.name)]
              : [],
          ),
        ),
        Effect.orElseSucceed(() => []),
      ),
    { concurrency: 8 },
  )
  // Never starts the daemon. A command it still runs keeps its file; a finished one whose file expired is forgotten
  // below.
  const processes = new Map(
    (yield* pty.listPipes().pipe(Effect.orElseSucceed(() => []))).map((process) => [process.outputPath, process]),
  )
  yield* FileRetention.cleanup(
    fs,
    files.flat().filter((file) => processes.get(file)?.lifecycle.status !== "running"),
    RETENTION,
  )
  // Finished processes whose file is gone, or that ended long ago, are of no use to any Location: forget them.
  const cutoff = Date.now() - Duration.toMillis(RETENTION)
  yield* Effect.forEach(
    processes.values(),
    (process) =>
      Effect.gen(function* () {
        if (process.lifecycle.status === "running") return
        const stale = (process.exitedAt ?? process.startedAt) < cutoff
        if (!stale && (yield* fs.exists(process.outputPath).pipe(Effect.orElseSucceed(() => true)))) return
        yield* pty.terminatePipe(process.id).pipe(Effect.ignore)
      }),
    { concurrency: 8, discard: true },
  )
})

// 清理层：每小时重复执行一次 cleanup，并 fork 为随作用域存活的后台纤程
const cleanupLayer = Layer.effectDiscard(
  cleanup().pipe(Effect.repeat(Schedule.spaced(Duration.hours(1))), Effect.forkScoped),
)

// 注册全局清理节点，依赖 FSUtil 与 Global
const cleanupNode = makeGlobalNode({
  name: "shell-output-cleanup",
  layer: cleanupLayer,
  deps: [FSUtil.node, Global.node, PersistentPty.node],
})

/** One Location's daemon commands, as `Daemon.at` hands them to its `Shell`. */
interface Runs {
  readonly get: (id: Shell.ID) => Run | undefined
  readonly list: () => Run[]
  /** Fails with `UnavailableError` only when the daemon could not be reached or started: spawning instead is safe. */
  readonly create: (input: {
    readonly info: Info
    readonly args: readonly string[]
    readonly env: Readonly<Record<string, string>>
    readonly timeout: number
    readonly toolCall: ToolCall | undefined
    readonly waited: boolean
  }) => Effect.Effect<Info, PersistentPty.UnavailableError | PersistentPty.RequestError>
  readonly timeout: (run: Run, duration: number) => Effect.Effect<void>
  readonly stop: (run: Run, reason: StopReason) => Effect.Effect<void>
  readonly remove: (id: Shell.ID) => Effect.Effect<void>
}

export interface DaemonInterface {
  /** A Location's daemon commands. The first call for a Location in this server takes its commands back from the daemon. */
  readonly at: (location: Location.Interface) => Effect.Effect<Runs>
  /** Runs `effect` until it ends or the server stops, outliving the caller's Location (e.g. a job's completion notice). */
  readonly watch: (effect: Effect.Effect<void, unknown>) => Effect.Effect<void>
  readonly handoffPrepared: () => boolean
}

/** The process daemon's shell commands, owned by the server and grouped by Location. */
export class Daemon extends Context.Service<Daemon, DaemonInterface>()("@opencode/Shell/Daemon") {}

const daemonLayer = Layer.effect(
  Daemon,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const pty = yield* PersistentPty.Service
    const scope = yield* Effect.scope
    const context = yield* Effect.context()
    const global = yield* Global.Service
    const { unlink } = yield* Effect.promise(() => import("fs/promises"))
    // Keyed by canonical Location. `recovered` resolves once the Location's commands were taken back.
    const places = new Map<string, { runs: Runs; recovered: Deferred.Deferred<void> }>()
    // Fibers run with the server's context in its scope, so a Location closing never interrupts them. On shutdown
    // they end without settling anything: the commands keep running for the next server, and the jobs waiting on
    // them are left to the job registry, which keeps their rows for it.
    const fork = (effect: Effect.Effect<void>) =>
      effect.pipe(Effect.forkIn(scope, { startImmediately: true }), Effect.setContext(context))

    const place = (location: Location.Interface) => {
      const runs = new Map<Shell.ID, Run>()
      const exitOrder: Shell.ID[] = []
      const ref = Location.Ref.make({ directory: location.directory, workspaceID: location.workspaceID })
      const outputDir = path.join(global.data, DIRECTORY, location.project.id)

      const persisted = (run: Run): Stored => ({
        id: run.info.id,
        command: run.info.command,
        shell: run.info.shell,
        location: {
          directory: location.directory,
          ...(location.workspaceID !== undefined ? { workspaceID: location.workspaceID } : {}),
        },
        metadata: run.info.metadata,
        toolCall: run.toolCall,
        timeoutDeadline: run.timeoutDeadline,
        stopReason: run.stopReason,
      })

      // Records the command's latest timeout and stop reason in the daemon, so a restart sees them.
      const store = (run: Run) =>
        pty
          .setPipeMetadata(run.process, persisted(run))
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("failed to update shell command metadata", { id: run.info.id, error: error.message }),
            ),
          )

      const remove = Effect.fnUntraced(function* (id: Shell.ID) {
        const run = runs.get(id)
        const index = exitOrder.indexOf(id)
        if (index !== -1) exitOrder.splice(index, 1)
        if (!run) return
        runs.delete(id)
        if (run.timeoutFiber) yield* Fiber.interrupt(run.timeoutFiber)
        if (run.stopping) yield* Fiber.interrupt(run.stopping)
        // Stop waiting first, so forgetting the process is not mistaken for losing it.
        if (run.wait) yield* Fiber.interrupt(run.wait)
        // Forget the process before deleting its file. This also kills what is left of its group, even after a
        // successful exit, which a spawned command would leave running: the daemon cannot forget a process otherwise.
        yield* pty.terminatePipe(run.process).pipe(Effect.ignore)
        yield* Effect.promise(() => unlink(run.info.file).catch(() => {}))
        yield* Deferred.fail(run.done, new NotFoundError({ id }))
        // Every shell reports exactly one exit; removing a running one ends it as killed.
        if (run.info.status === "running")
          yield* bus.publish(Shell.Event.Exited, { id, status: "killed" }, { location: ref })
        yield* bus.publish(Shell.Event.Deleted, { id }, { location: ref })
      })

      const evict = Effect.fnUntraced(function* () {
        while (exitOrder.length > EXITED_LIMIT) {
          const oldest = exitOrder[0]
          if (!oldest) break
          yield* remove(oldest)
        }
      })

      const finish = Effect.fnUntraced(function* (run: Run, outcome: Ended) {
        const id = run.info.id
        // A removed command already failed its waiters and published its exit and deletion.
        if (runs.get(id) !== run) return
        run.info = produce(run.info, (draft) => {
          draft.status = outcome.status
          if (outcome.exit !== undefined) draft.exit = outcome.exit
          if (outcome.signal !== undefined) draft.signal = outcome.signal
          draft.time.completed = outcome.completed
        })
        if (run.timeoutFiber) yield* Fiber.interrupt(run.timeoutFiber)
        run.timeoutFiber = undefined
        // Resolve waiters before retention eviction, so an evicted command still reports its
        // terminal Info rather than the removal NotFoundError.
        yield* Deferred.succeed(run.done, run.info)
        yield* bus.publish(
          Shell.Event.Exited,
          { id, ...(outcome.exit !== undefined ? { exit: outcome.exit } : {}), status: outcome.status },
          { location: ref },
        )
        exitOrder.push(id)
        yield* evict()
      })

      // Graceful, like spawned commands: SIGTERM, then SIGKILL if it has not exited 3 s later. The stop is recorded
      // and the SIGTERM sent before this returns, uninterruptibly, so neither interrupting the caller (a timer being
      // retimed, removed or torn down) nor a server shutting down right after cancels it. The escalation runs on its
      // own.
      const stop = (run: Run, reason: StopReason) =>
        Effect.gen(function* () {
          if (run.stopReason !== undefined || run.info.status !== "running") return
          run.stopReason = reason
          run.timeoutDeadline = undefined
          yield* store(run)
          yield* pty.signalPipe(run.process, "SIGTERM").pipe(Effect.ignore)
          run.stopping = yield* fork(
            Effect.gen(function* () {
              const ended = yield* Deferred.await(run.done).pipe(Effect.timeoutOption(STOP_GRACE), Effect.exit)
              if (Exit.isSuccess(ended) && Option.isNone(ended.value))
                yield* pty.signalPipe(run.process, "SIGKILL").pipe(Effect.ignore)
            }),
          )
        }).pipe(Effect.uninterruptible)

      const arm = Effect.fnUntraced(function* (run: Run, duration: number) {
        run.timeoutFiber = yield* fork(
          Effect.sleep(Duration.millis(duration)).pipe(Effect.andThen(stop(run, "timeout"))),
        )
      })

      const timeout = Effect.fnUntraced(function* (run: Run, duration: number) {
        if (run.stopReason !== undefined || run.info.status !== "running") return
        if (run.timeoutFiber) yield* Fiber.interrupt(run.timeoutFiber)
        run.timeoutFiber = undefined
        run.timeoutDeadline = duration === 0 ? undefined : Date.now() + duration
        yield* store(run)
        if (duration !== 0) yield* arm(run, duration)
      })

      // Watches the exit, and the timeout (in ms from now, none if undefined).
      const attach = Effect.fnUntraced(function* (run: Run, duration: number | undefined) {
        run.wait = yield* fork(
          pty.waitPipe(run.process).pipe(
            Effect.map((exit): Ended => {
              run.outputLines = exit.outputLines
              run.outputError = exit.outputError
              // A stopped command reports its reason, and how the stopped process ended, as spawned ones do.
              return {
                status: run.stopReason ?? "exited",
                ...(exit.exitCode !== undefined ? { exit: exit.exitCode } : {}),
                ...(exit.signal !== undefined ? { signal: exit.signal } : {}),
                completed: exit.exitedAt,
              }
            }),
            // The daemon went away (and its processes with it), or forgot the process: it was killed.
            Effect.catch((error) =>
              Effect.logWarning("lost a shell command's process", { id: run.info.id, error: error.message }).pipe(
                Effect.andThen(
                  Effect.sync((): Ended => {
                    run.killed = LOST
                    return { status: "killed", completed: Date.now() }
                  }),
                ),
              ),
            ),
            // Like spawned commands: what a failed command left running in its group is stopped with it, while a
            // successful one may leave background processes (`cmd &`) behind.
            Effect.tap((outcome) =>
              outcome.status === "exited" && outcome.exit !== undefined && outcome.exit !== 0
                ? pty.signalPipe(run.process, "SIGTERM").pipe(Effect.ignore)
                : Effect.void,
            ),
            Effect.flatMap((outcome) => finish(run, outcome)),
          ),
        )
        // A stop interrupted by a restart lost its grace period: kill now.
        if (run.stopReason !== undefined) {
          run.stopping = yield* fork(pty.signalPipe(run.process, "SIGKILL").pipe(Effect.ignore))
          return
        }
        if (duration === undefined) return
        if (duration > 0) return yield* arm(run, duration)
        yield* stop(run, "timeout")
      })

      const create: Runs["create"] = Effect.fnUntraced(function* (input) {
        const run: Run = {
          kind: "daemon",
          info: input.info,
          process: 0,
          toolCall: input.toolCall,
          timeoutDeadline: !input.waited && input.timeout > 0 ? input.info.time.started + input.timeout : undefined,
          done: Deferred.makeUnsafe<Info, NotFoundError>(),
        }
        const created = yield* pty.createPipe({
          program: input.info.shell,
          args: input.args,
          cwd: input.info.cwd,
          env: input.env,
          groupID: location.project.id,
          outputPath: input.info.file,
          metadata: persisted(run),
        })
        run.process = created.id
        run.info = produce(input.info, (draft) => {
          if (created.pid !== undefined) draft.pid = created.pid
          // The daemon's clock, so the command reports the same start wherever it is read.
          draft.time.started = created.startedAt
        })
        runs.set(run.info.id, run)
        // Timed from now: starting the daemon may have taken a while.
        yield* attach(run, input.timeout > 0 ? input.timeout : undefined)
        yield* bus.publish(Shell.Event.Created, { info: run.info }, { location: ref })
        return run.info
      })

      // Takes back this Location's commands, left by a previous server. Two Locations can share a project's output
      // directory, so match the Location itself.
      const recover = Effect.fnUntraced(function* () {
        const processes = yield* pty
          .listPipes()
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("failed to list shell commands to recover", { error: error.message }).pipe(
                Effect.as([]),
              ),
            ),
          )
        const finished: Run[] = []
        for (const process of processes) {
          const stored = Option.getOrUndefined(decodeStored(process.metadata))
          if (
            !stored ||
            stored.location.directory !== location.directory ||
            stored.location.workspaceID !== location.workspaceID ||
            path.dirname(process.outputPath) !== outputDir ||
            runs.has(stored.id)
          )
            continue
          const running = process.lifecycle.status === "running"
          const exited = process.lifecycle.status === "exited" ? process.lifecycle : undefined
          const status = running ? "running" : (stored.stopReason ?? (exited ? "exited" : "killed"))
          const run: Run = {
            kind: "daemon",
            info: {
              id: stored.id,
              status,
              command: stored.command,
              cwd: process.cwd,
              shell: stored.shell,
              file: process.outputPath,
              ...(process.pid !== undefined ? { pid: process.pid } : {}),
              ...(exited?.exitCode !== undefined ? { exit: exited.exitCode } : {}),
              ...(exited?.signal !== undefined ? { signal: exited.signal } : {}),
              metadata: stored.metadata,
              time: {
                started: process.startedAt,
                ...(running ? {} : { completed: process.exitedAt ?? process.startedAt }),
              },
            },
            process: process.id,
            toolCall: stored.toolCall,
            timeoutDeadline: stored.timeoutDeadline,
            stopReason: stored.stopReason,
            ...(running ? {} : { outputLines: process.outputLines, outputError: process.outputError }),
            ...(process.lifecycle.status === "failed" && !stored.stopReason
              ? { killed: `Command was killed: ${process.lifecycle.message}` }
              : {}),
            done: Deferred.makeUnsafe<Info, NotFoundError>(),
          }
          runs.set(stored.id, run)
          if (running) {
            // A deadline that passed while no server ran fires at once.
            const deadline = stored.timeoutDeadline
            yield* attach(run, deadline === undefined ? undefined : Math.max(0, deadline - Date.now()))
            continue
          }
          yield* Deferred.succeed(run.done, run.info)
          finished.push(run)
        }
        exitOrder.push(
          ...finished
            .toSorted((a, b) => (a.info.time.completed ?? 0) - (b.info.time.completed ?? 0))
            .map((run) => run.info.id),
        )
        yield* evict()
      })

      const handle: Runs = {
        get: (id) => runs.get(id),
        list: () => Array.from(runs.values()),
        create,
        timeout,
        stop,
        remove,
      }
      return { runs: handle, recover }
    }

    const at = Effect.fnUntraced(function* (location: Location.Interface) {
      const key = `${location.directory}\0${location.workspaceID ?? ""}`
      const existing = places.get(key)
      if (existing) {
        yield* Deferred.await(existing.recovered)
        return existing.runs
      }
      const placed = place(location)
      const entry = { runs: placed.runs, recovered: Deferred.makeUnsafe<void>() }
      places.set(key, entry)
      // Uninterruptible: the entry is shared, so a caller's interrupt must not leave it half recovered.
      yield* placed
        .recover()
        .pipe(Effect.ensuring(Deferred.succeed(entry.recovered, undefined)), Effect.uninterruptible)
      return placed.runs
    })

    return Daemon.of({
      at,
      handoffPrepared: pty.handoffPrepared,
      watch: (effect) =>
        fork(effect.pipe(Effect.catch((error) => Effect.logError("shell watcher failed", { error })))).pipe(
          Effect.asVoid,
        ),
    })
  }),
)

export const daemonNode = makeGlobalNode({
  service: Daemon,
  layer: daemonLayer,
  deps: [Bus.node, Global.node, PersistentPty.node],
})

// 主服务层工厂
const layer = () =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      // 获取事件总线服务
      const bus = yield* Bus.Service
      // 获取位置服务
      const location = yield* Location.Service
      // 获取全局数据目录服务
      const global = yield* Global.Service
      // 获取 shell 选择服务
      const shell = yield* ShellSelect.Service
      // 获取环境服务（实际 spawn 进程）
      const environment = yield* Environment.Service
      // 获取插件钩子服务
      const hooks = yield* PluginHooks.Service
      // 获取会话环境服务
      const environments = yield* SessionEnvironment.Service
      // 获取配置服务
      const config = yield* Config.Service
      const daemon = yield* Daemon
      const context = yield* Effect.context()
      // 生成携带该上下文的 fork 函数，用于在层内启动后台纤程
      const runFork = Effect.runForkWith(context)
      // Commands this server spawned for the Location; daemon commands live in `runs`, owned by the server.
      const commands = new Map<Shell.ID, Spawned>()
      const exitOrder: Shell.ID[] = []
      // Take local commands back before returning the service so session restart recovery sees them.
      const runs =
        location.workspaceID === undefined && PersistentPty.available ? yield* daemon.at(location) : undefined

      // 本项目的输出目录：数据目录/shell/项目ID
      const outputDir = path.join(global.data, DIRECTORY, location.project.id)
      const { mkdir, unlink, stat } = yield* Effect.promise(() => import("fs/promises"))
      const { createWriteStream, createReadStream } = yield* Effect.promise(() => import("fs"))
      // 确保输出目录存在（递归创建）
      yield* Effect.promise(() => mkdir(outputDir, { recursive: true }))

      // 注册层终结器：层关闭时中断所有命令的超时纤程并打断其等待
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          // 遍历所有活动命令
          for (const command of commands.values()) {
            // 中断其超时定时器纤程
            if (command.timeoutFiber) yield* Fiber.interrupt(command.timeoutFiber)
            // Teardown interrupts pending commands; it is not a terminal command failure. Daemon commands are left
            // to the server.
            yield* Deferred.interrupt(command.done)
          }
          // 清空命令表
          commands.clear()
          // 清空退出顺序表
          exitOrder.length = 0
        }),
      )

      // 按 ID 取命令；不存在则报 NotFoundError
      const require = Effect.fnUntraced(function* (id: Shell.ID) {
        const command: Command | undefined = commands.get(id) ?? runs?.get(id)
        if (!command) return yield* new NotFoundError({ id })
        // 返回命令内部状态
        return command
      })

      // 内部移除命令：从各表删除、中断超时、让等待者失败、删文件、补发退出/删除事件
      const removeCommand = Effect.fnUntraced(function* (id: Shell.ID) {
        // 查找命令（可能已不存在）
        const command = commands.get(id)
        // 从退出顺序表中移除该 ID
        const index = exitOrder.indexOf(id)
        if (index !== -1) exitOrder.splice(index, 1)
        // 命令本就不存在则直接结束
        if (!command) return
        // 从命令表删除
        commands.delete(id)
        // 中断其超时定时器纤程
        if (command.timeoutFiber) yield* Fiber.interrupt(command.timeoutFiber)
        // Unblock any wait still pending when the command is removed before it terminated.
        // （中文）命令在终止前被移除时，让仍在等待的调用方立即以 NotFoundError 解除阻塞
        yield* Deferred.fail(command.done, new NotFoundError({ id }))
        yield* Effect.promise(() => unlink(command.info.file).catch(() => {}))
        // Every shell reports exactly one exit; removing a running one ends it as killed.
        // （中文）每个 shell 恰好上报一次退出；移除运行中的命令视作被杀（killed）结束
        if (command.info.status === "running") yield* bus.publish(Shell.Event.Exited, { id, status: "killed" })
        // 发布删除事件
        yield* bus.publish(Shell.Event.Deleted, { id })
      })

      // 对外的移除接口：先确保命令存在，再执行内部移除
      const remove = Effect.fn("Shell.remove")(function* (id: Shell.ID) {
        const command = yield* require(id)
        yield* annotate(command.info)
        if (command.kind === "daemon") return yield* runs?.remove(id) ?? Effect.void
        yield* removeCommand(id)
      })

      // 列出仍在运行的命令信息
      const list = Effect.fn("Shell.list")(function* () {
        return [...commands.values(), ...(runs?.list() ?? [])]
          .filter((command) => command.info.status === "running")
          .map((command) => command.info)
      })

      // 获取命令信息
      const get = Effect.fn("Shell.get")(function* (id: Shell.ID) {
        const { info } = yield* require(id)
        yield* annotate(info)
        return info
      })

      // 等待命令到达终态
      const wait = Effect.fn("Shell.wait")(function* (id: Shell.ID) {
        const command = yield* require(id)
        yield* annotate(command.info)
        const info = yield* Deferred.await(command.done)
        yield* annotate(info)
        return info
      })

      // 设置/替换运行中命令的超时
      const timeout = Effect.fn("Shell.timeout")(function* (id: Shell.ID, duration: number) {
        // 确保命令存在
        const command = yield* require(id)
        yield* annotate(command.info)
        if (command.kind === "daemon") yield* runs?.timeout(command, duration) ?? Effect.void
        if (command.kind === "spawned" && command.info.status === "running" && command.timeout)
          yield* command.timeout(duration)
        return command.info
      })

      const stop = Effect.fn("Shell.stop")(function* (id: Shell.ID, reason: StopReason) {
        const command = yield* require(id)
        yield* annotate(command.info)
        if (command.kind === "daemon") yield* runs?.stop(command, reason) ?? Effect.void
        if (command.kind === "spawned" && command.info.status === "running" && command.stop) yield* command.stop(reason)
        return command.info
      })

      const byToolCall = Effect.fn("Shell.byToolCall")(function* (call: ToolCall) {
        return runs
          ?.list()
          .find(
            (run) =>
              run.toolCall?.sessionID === call.sessionID &&
              run.toolCall.assistantMessageID === call.assistantMessageID &&
              run.toolCall.callID === call.callID,
          )?.info
      })

      const readRange = (file: string, start: number, length: number) =>
        length <= 0
          ? Effect.succeed(Buffer.alloc(0))
          : Effect.promise(
              () =>
                new Promise<Buffer>((resolve) => {
                  const buffer = Buffer.alloc(length)
                  const stream = createReadStream(file, { start, end: start + length - 1 })
                  let offset = 0
                  stream.on("data", (chunk: string | Buffer) => {
                    const bytes = Buffer.from(chunk)
                    bytes.copy(buffer, offset)
                    offset += bytes.length
                  })
                  stream.on("end", () => resolve(buffer.subarray(0, offset)))
                  stream.on("error", () => resolve(buffer.subarray(0, 0)))
                }),
            )

      // A daemon command's file is the only record of its output, so its size is the file's; a missing file is empty.
      const sizeOf = (command: Command) =>
        command.kind === "spawned"
          ? Effect.succeed(command.size)
          : Effect.promise(() =>
              stat(command.info.file).then(
                (info) => info.size,
                () => 0,
              ),
            )

      const output = Effect.fnUntraced(function* (id: Shell.ID, input?: Shell.OutputInput) {
        // 确保命令存在
        const command = yield* require(id)
        // 起始游标，默认 0
        const cursor = input?.cursor ?? 0
        // 单次读取上限，默认 64KiB
        const limit = input?.limit ?? 65536
        const size = yield* sizeOf(command)
        if (cursor >= size) return { output: "", cursor: size, size, truncated: false }
        const start = Math.max(0, cursor)
        const bytes = yield* readRange(command.info.file, start, Math.min(limit, size - start))
        return {
          output: bytes.toString("utf8"),
          cursor: start + bytes.length,
          size,
          truncated: false,
        }
      })

      // Only for a command whose exit report is missing (still running, or lost with the daemon); the daemon counts
      // newlines otherwise. Gives up on large files, whose line numbers then go unreported, to keep a result quick.
      const countNewlines = (file: string, size: number) =>
        Effect.promise(
          () =>
            new Promise<number | undefined>((resolve) => {
              if (size === 0) return resolve(0)
              if (size > COUNT_NEWLINES_LIMIT) return resolve(undefined)
              let count = 0
              const stream = createReadStream(file, { end: size - 1 })
              stream.on("data", (chunk: string | Buffer) => {
                const bytes = Buffer.from(chunk)
                for (let index = bytes.indexOf(10); index !== -1; index = bytes.indexOf(10, index + 1)) count++
              })
              stream.on("end", () => resolve(count))
              stream.on("error", () => resolve(count))
            }),
        )

      // Where the last two lines of a daemon command's output start, found by reading back from the end. Only needed
      // to size a single cut-off line, which the spawner tracks as it writes. A start further back than the scan
      // limit is reported as unknown.
      const lineStartsOf = Effect.fnUntraced(function* (file: string, size: number) {
        const starts: number[] = []
        let end = size
        const floor = Math.max(0, size - LINE_START_SCAN_LIMIT)
        while (end > floor && starts.length < 2) {
          const from = Math.max(floor, end - 65536)
          const chunk = yield* readRange(file, from, end - from)
          for (let index = chunk.length - 1; index >= 0 && starts.length < 2; index--)
            if (chunk[index] === 10) starts.push(from + index + 1)
          end = from
        }
        const unknown = floor > 0 ? undefined : 0
        return [starts[1] ?? unknown, starts[0] ?? unknown] as [number | undefined, number | undefined]
      })

      const result = Effect.fn("Shell.result")(function* (
        started: Shell.Info,
        options?: { readonly wait?: Duration.Input },
      ) {
        yield* annotate(started)
        const ended = wait(started.id).pipe(Effect.map(Option.some))
        const info = yield* (
          options?.wait === undefined
            ? ended
            : ended.pipe(
                Effect.timeoutOrElse({ duration: options.wait, orElse: () => Effect.succeed(Option.none<Info>()) }),
              )
        ).pipe(
          Effect.flatMap((info) => (Option.isSome(info) ? Effect.succeed(info.value) : get(started.id))),
          Effect.catchTag("Shell.NotFoundError", () =>
            Effect.succeed({ ...started, status: "killed" as const, time: { ...started.time, completed: Date.now() } }),
          ),
        )
        yield* annotate(info)
        const capture = yield* Effect.gen(function* () {
          // 读取配置中最新的 tool_output 限制
          const limits = Config.latest(yield* config.entries(), "tool_output")
          // 最大行数（配置优先，否则用默认值）
          const maxLines = limits?.max_lines ?? ToolOutput.MAX_LINES
          // 最大字节数（同上）
          const maxBytes = limits?.max_bytes ?? ToolOutput.MAX_BYTES
          const command = yield* require(info.id)
          const size = yield* sizeOf(command)
          const start = Math.max(0, size - maxBytes)
          // Read the byte before the window too, to tell whether the window starts on a line boundary.
          const before = Math.max(0, start - 1)
          const window = yield* readRange(info.file, before, size - before)
          const page = window.subarray(charBoundary(window, start - before)).toString("utf8")
          const partial = start > 0 && window[0] !== 10
          const endsWithNewline = page.endsWith("\n")
          const lines = page.split("\n")
          if (endsWithNewline) lines.pop()
          const newlines =
            command.kind === "spawned"
              ? command.newlines
              : (command.outputLines ?? (yield* countNewlines(info.file, size)))
          const total = newlines === undefined ? undefined : newlines + (endsWithNewline ? 0 : 1)
          const suffix = `full output saved to ${info.file}]`
          // After a write error the daemon kept running the command, but its file stopped early.
          const stoppedEarly =
            command.kind === "daemon" && command.outputError
              ? `\n\n[output file ${info.file} stopped early: ${command.outputError}]`
              : ""
          const killed = command.kind === "daemon" && command.killed ? { killed: command.killed } : {}
          if (partial && lines.length === 1) {
            const lineStarts = command.kind === "spawned" ? command.lineStarts : yield* lineStartsOf(info.file, size)
            const lineStart = endsWithNewline ? lineStarts[0] : lineStarts[1]
            const end = size - (endsWithNewline ? 1 : 0)
            const lineSize =
              lineStart === undefined
                ? `over ${formatSize(Math.min(end, LINE_START_SCAN_LIMIT))}`
                : formatSize(end - lineStart)
            const shownSize = Buffer.byteLength(lines[0])
            const line = total === undefined ? "the last line" : `line ${total}`
            return {
              output: `${lines[0]}\n\n[showing the last ${formatSize(shownSize)} of ${line} (${lineSize}); ${suffix}${stoppedEarly}`,
              truncated: true,
              ...killed,
            }
          }
          if (start > 0 || lines.length > maxLines) {
            // A window that starts mid-line drops that partial line so the line numbers stay exact.
            const kept = lines.slice(-Math.min(maxLines, lines.length - (partial ? 1 : 0)))
            return {
              output:
                total === undefined
                  ? `${kept.join("\n")}\n\n[showing the last ${kept.length} lines; ${suffix}${stoppedEarly}`
                  : `${kept.join("\n")}\n\n[showing lines ${total - kept.length + 1}-${total} of ${total}; ${suffix}${stoppedEarly}`,
              truncated: true,
              ...killed,
            }
          }
          // One blank line before the notice, whether or not the output ended with a newline.
          const shown = stoppedEarly && page.endsWith("\n") ? page.slice(0, -1) : page
          return { output: `${shown || "(no output)"}${stoppedEarly}`, truncated: false, ...killed }
        }).pipe(Effect.catchTag("Shell.NotFoundError", () => Effect.succeed(undefined)))
        // 返回终态信息与捕获结果
        return { info, capture }
      })

      // 创建并启动一条 shell 命令
      const create = Effect.fn("Shell.create")(function* <E = never, R = never>(
        input: CreateInput,
        before?: (input: ShellCreateBefore) => Effect.Effect<void, E, R>,
      ) {
        // 提取可选的会话（session）ID
        const sessionID = input.metadata?.sessionID
        // 工作区模式下无需注入基础环境；否则若有合法会话 ID 则取会话环境，最终退回进程环境
        const baseEnv =
          location.workspaceID !== undefined
            ? undefined
            : ((Schema.is(SessionSchema.ID)(sessionID) ? yield* environments.get(sessionID) : undefined) ?? process.env)
        // 组装插件可见的调用描述：命令、工作目录、超时、shell 及环境变量
        const invocation: ShellCreateBefore = {
          command: input.command,
          cwd: input.cwd ?? location.directory,
          timeout: input.timeout ?? 0,
          shell: input.shell ?? (yield* shell.resolve({ priority: "config" })),
          env: {
            ...baseEnv,
            TERM: "xterm-256color",
            OPENCODE_TERMINAL: "1",
          },
        }
        // 触发插件的 shell.create.before 钩子
        yield* hooks.trigger("shell", "create.before", invocation)
        // 执行调用方传入的 before 钩子（若有）
        if (before) yield* before(invocation)
        // Absolute for local commands, so the command reports the same cwd wherever it runs.
        if (location.workspaceID === undefined) invocation.cwd = path.resolve(location.directory, invocation.cwd)

        // 生成单调递增的命令 ID
        const id = Shell.ID.ascending()
        // 根据所选 shell 构造参数（如 -lc <command>）
        const args = ShellSelect.args(invocation.shell, invocation.command)
        // 输出文件路径：<输出目录>/<ID>.out
        const file = path.join(outputDir, `${id}.out`)

        // 初始信息快照（运行中）
        const info: Info = {
          id,
          status: "running",
          command: invocation.command,
          cwd: invocation.cwd,
          shell: invocation.shell,
          file,
          metadata: input.metadata ?? {},
          time: { started: Date.now() },
        }
        yield* annotate(info)

        if (runs) {
          const created = yield* runs
            .create({
              info,
              args,
              // The daemon replaces the environment, so variables removed by hooks stay removed, like the spawner.
              env: Object.fromEntries(
                Object.entries(invocation.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
              ),
              timeout: invocation.timeout,
              toolCall: input.toolCall,
              waited: input.waited === true,
            })
            .pipe(
              Effect.map(Option.some),
              Effect.catchTags({
                "PersistentPty.UnavailableError": (error) =>
                  Effect.logWarning("process daemon unavailable; spawning shell command instead", {
                    error: error.message,
                  }).pipe(Effect.as(Option.none<Info>())),
                // The daemon may have run it: never run it again here.
                "PersistentPty.RequestError": (cause) =>
                  Effect.fail(new AppProcess.AppProcessError({ command: invocation.command, cause })),
              }),
            )
          if (Option.isSome(created)) return created.value
        }

        // Spawn through the Environment and stream combined output to the file. The handle is scope-bound, so
        // the managing fiber keeps its scope open until the command terminates (it awaits `done` at the
        // end). `create` returns once `ready` resolves with the registered command.
        const ready = Deferred.makeUnsafe<Spawned, AppProcess.AppProcessError>()
        runFork(
          Effect.scoped(
            Effect.gen(function* () {
              // 通过环境服务的 spawner 拉起子进程；spawn 失败时包装为 AppProcessError
              const handle = yield* environment.spawner
                .spawn(
                  ChildProcess.make(invocation.shell, args, {
                    cwd: invocation.cwd,
                    env: invocation.env,
                    stdin: "ignore",
                    detached: process.platform !== "win32",
                    forceKillAfter: STOP_GRACE,
                  }),
                )
                .pipe(
                  Effect.mapError((cause) => new AppProcess.AppProcessError({ command: invocation.command, cause })),
                )
              const command: Spawned = {
                kind: "spawned",
                info: produce(info, (draft) => {
                  draft.pid = handle.pid
                }),
                size: 0,
                newlines: 0,
                lineStarts: [0, 0],
                done: Deferred.makeUnsafe<Info, NotFoundError>(),
              }
              // 登记命令（此后 get/output/wait 等即可使用）
              commands.set(id, command)

              // 创建输出写流
              const stream = createWriteStream(file)
              // 标记“输出捕获完成”的闩锁
              const outputDone = Latch.makeUnsafe()
              // 输出泵：把进程的合并输出逐块写入文件，并累计大小与换行数
              const pump = handle.all.pipe(
                Stream.runForEach((chunk: Uint8Array) =>
                  Effect.sync(() => {
                    stream.write(chunk)
                    // Count while streaming so truncation notices never rescan the output file.
                    for (let index = chunk.indexOf(10); index !== -1; index = chunk.indexOf(10, index + 1)) {
                      command.newlines++
                      command.lineStarts[0] = command.lineStarts[1]
                      command.lineStarts[1] = command.size + index + 1
                    }
                    command.size += chunk.length
                  }),
                ),
              )
              // 后台纤程：等输出泵结束后关闭写流并打开闩锁
              runFork(
                Effect.gen(function* () {
                  // 等泵完成（失败也吞掉）
                  yield* pump.pipe(Effect.catch(() => Effect.void))
                  // 等写流完全关闭
                  yield* Effect.promise(
                    () =>
                      new Promise<void>((resolve) => {
                        stream.end(() => resolve())
                      }),
                  )
                  // 打开闩锁，标记输出捕获完成
                  yield* outputDone.open
                }),
              )
              // 等待写流真正打开（或打开失败）后，才继续写入
              yield* Effect.promise(
                () =>
                  new Promise<void>((resolve) => {
                    stream.once("open", () => resolve())
                    stream.once("error", () => resolve())
                  }),
              )

              // The process exit and the timeout race to record how the command ended; the first wins.
              // （中文）进程退出与超时赛跑记录命令的结束方式；先到者生效。
              // 记录结束方式的一次性 Deferred
              const ended = Deferred.makeUnsafe<Ended>()
              // 记录结束方式的辅助函数：只有第一次生效
              const end = (outcome: Omit<Ended, "completed">) =>
                Effect.suspend(() => Deferred.succeed(ended, { ...outcome, completed: Date.now() }))

              // A recorded stop must always kill. The kill runs detached, so interrupting the caller (a timer
              // being retimed, removed or torn down) neither cancels it nor waits for the process to die.
              command.stop = (reason) =>
                Effect.gen(function* () {
                  if (!(yield* end({ status: reason }))) return
                  runFork(handle.kill({ forceKillAfter: STOP_GRACE }).pipe(Effect.catch(() => Effect.void)))
                }).pipe(Effect.uninterruptible)

              command.timeout = (duration) =>
                Effect.gen(function* () {
                  // 已有终态时忽略
                  if (Deferred.isDoneUnsafe(ended)) return
                  // 先中断旧的定时器纤程
                  if (command.timeoutFiber) yield* Fiber.interrupt(command.timeoutFiber)
                  command.timeoutFiber = undefined
                  // duration 为 0 表示清除超时
                  if (duration === 0) return
                  const stop = command.stop
                  if (!stop) return
                  command.timeoutFiber = runFork(
                    Effect.sleep(Duration.millis(duration)).pipe(Effect.andThen(stop("timeout"))),
                  )
                })

              // 按调用方的初始超时启动定时器
              yield* command.timeout(invocation.timeout)

              // The process exits even after a timeout kill, so this fiber always publishes the outcome.
              // （中文）即使超时强杀，进程最终也会退出，因此该纤程总会发布结束结果
              runFork(
                Effect.gen(function* () {
                  const exited = yield* handle.exitCode.pipe(
                    Effect.map((code) => ({ exit: code, signal: undefined })),
                    Effect.catch((error) =>
                      Effect.succeed({
                        exit: undefined,
                        signal:
                          error.cause instanceof CrossSpawnSpawner.KilledBySignal ? error.cause.signal : undefined,
                      }),
                    ),
                  )
                  yield* end({ status: "exited", ...exited })
                  // A stop keeps its status but still records how the killed process exited.
                  const outcome = { ...(yield* Deferred.await(ended)), ...exited }
                  // Report the terminal status only once captured output is complete, so a reader that
                  // sees it never reads a partial file.
                  // （中文）等输出捕获完全落盘后才上报终态，这样看到终态的读取者绝不会读到半个文件
                  yield* outputDone.await
                  // A removed command already failed its waiters and published its exit and deletion.
                  // （中文）命令已被移除时，其等待者早已失败、退出/删除事件也已发布，这里直接返回
                  if (commands.get(id) !== command) return
                  // 用 immer 生成新的终态信息快照
                  command.info = produce(command.info, (draft) => {
                    draft.status = outcome.status
                    if (outcome.exit !== undefined) draft.exit = outcome.exit
                    if (outcome.signal !== undefined) draft.signal = outcome.signal
                    draft.time.completed = outcome.completed
                  })
                  // Resolve waiters before retention eviction, so an evicted command still reports its
                  // terminal Info rather than the removal NotFoundError.
                  // （中文）在保留期淘汰之前先解除等待者，这样被淘汰的命令也仍能上报终态 Info 而非移除错误
                  yield* Deferred.succeed(command.done, command.info)
                  // 发布退出事件（带退出码，若有）
                  yield* bus.publish(Shell.Event.Exited, {
                    id,
                    ...(outcome.exit !== undefined ? { exit: outcome.exit } : {}),
                    status: outcome.status,
                  })
                  // 记入退出顺序表
                  exitOrder.push(id)
                  // 超过内存保留上限时逐个移除最旧的退出记录
                  while (exitOrder.length > EXITED_LIMIT) {
                    const oldest = exitOrder[0]
                    if (!oldest) break
                    yield* removeCommand(oldest)
                  }
                  // Keep exited history data-only.
                  // （中文）已退出的历史只保留数据：清掉超时能力与定时器纤程
                  const timeoutFiber = command.timeoutFiber
                  command.timeout = undefined
                  command.stop = undefined
                  command.timeoutFiber = undefined
                  if (timeoutFiber) yield* Fiber.interrupt(timeoutFiber)
                }),
              )

              // 发布创建事件
              yield* bus.publish(Shell.Event.Created, { info })
              // 通知 create 调用方：命令已登记完成
              yield* Deferred.succeed(ready, command)
              // Hold the handle's scope open until the command terminates; closing it earlier would
              // release (kill) the process before its exit is observed.
              // （中文）保持句柄作用域打开直到命令终止；提前关闭会在观察到退出之前释放（杀死）进程
              yield* Deferred.await(command.done).pipe(Effect.catch(() => Effect.void))
            }),
          ).pipe(Effect.catchTag("AppProcessError", (error) => Deferred.fail(ready, error))),
        )

        // 等待管理纤程完成登记并返回初始信息
        const command = yield* Deferred.await(ready)
        return command.info
      })

      return Service.of({
        create,
        list,
        get,
        wait,
        result,
        timeout,
        stop,
        byToolCall,
        output,
        remove,
        watch: daemon.watch,
        handoffPrepared: daemon.handoffPrepared,
      })
    }),
  )

// Spans carry only the command text, truncated; never env, stdin or output. Shells outlive the turn that started
// them, so the session comes from the shell's own metadata rather than the caller's span annotations.
function annotate(info: Info) {
  const sessionID = info.metadata.sessionID
  return Effect.annotateCurrentSpan({
    "opencode.shell.id": info.id,
    "opencode.shell.command": spanCommand(info.command),
    ...(typeof sessionID === "string" ? { "session.id": sessionID } : {}),
    ...(info.metadata.background === true ? { "opencode.shell.background": true } : {}),
    ...(info.status === "running" ? {} : { "opencode.shell.status": info.status }),
    ...(info.exit === undefined ? {} : { "process.exit.code": info.exit }),
  })
}

// Strict OTLP JSON parsers reject a lone surrogate, which a cut through an emoji would leave.
function spanCommand(command: string) {
  if (command.length <= SPAN_COMMAND_LIMIT) return command.toWellFormed()
  return `${command.slice(0, SPAN_COMMAND_LIMIT).toWellFormed()}…`
}

// Moves past UTF-8 continuation bytes (at most 3) so a byte cut never splits a character.
function charBoundary(bytes: Buffer, offset: number) {
  const limit = Math.min(bytes.length, offset + 3)
  for (let index = offset; index < limit; index++) if ((bytes[index] & 0xc0) !== 0x80) return index
  return limit
}

function formatSize(bytes: number) {
  const kb = bytes / 1024
  return kb > 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.round(kb)} KB`
}

export const node = makeLocationNode({
  service: Service,
  layer: layer(),
  deps: [
    Bus.node,
    Location.node,
    Global.node,
    ShellSelect.node,
    Environment.node,
    PluginHooks.node,
    SessionEnvironment.node,
    Config.node,
    daemonNode,
    cleanupNode,
  ],
})
