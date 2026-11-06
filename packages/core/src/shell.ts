// 以命名空间形式导出 Shell 模块
export * as Shell from "./shell.js"

// 引入 Node 的 path 模块，用于拼接输出文件路径
import path from "path"
// 引入 Effect 核心原语：Context、Deferred（一次性承诺）、Duration、Effect、Fiber（纤程）、Latch（闩锁）、
// Layer（层）、Schema、Schedule（调度）、Stream（流）
import { Context, Deferred, Duration, Effect, Fiber, Latch, Layer, Schema, Schedule, Stream } from "effect"
// 引入 Effect 的子进程抽象
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
// 引入 shell 解析选择服务
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

// Info 的类型别名
type Info = Shell.Info
// 创建输入类型：在 Shell.CreateInput 基础上允许显式指定 shell 可执行文件
type CreateInput = Shell.CreateInput & {
  shell?: string
}

// 活动（运行中或已退出待观察）命令的内部状态
type Active = {
  // Immutable snapshot; lifecycle updates replace it via immer `produce`.
  // （中文）不可变的信息快照；生命周期更新通过 immer `produce` 生成新对象整体替换
  info: Info
  // 合并输出落盘的文件路径
  file: string
  // 目前已写入文件的字节数
  size: number
  // 目前已写入文件的换行符数量（用于截断提示，避免重扫输出文件）
  newlines: number
  // Resolves with the terminal Info once the command exits, times out, or is killed. A wait
  // started after termination resolves immediately from the already-completed deferred.
  // （中文）命令退出、超时或被杀后以最终 Info 完成（resolve）；终止后发起的等待会立即从
  // 已完成的 Deferred 拿到结果
  done: Deferred.Deferred<Info, NotFoundError>
  // 当前超时定时器纤程（若已设置）
  timeoutFiber?: Fiber.Fiber<void>
  // 重新设置超时的函数（由 create 内部实现后注入）
  timeout?: (duration: number) => Effect.Effect<void>
}

// 命令终态的描述
type Ended = {
  // 结束方式：正常退出（exited）或超时（timeout）
  status: "exited" | "timeout"
  // 退出码（若以退出码结束）
  exit?: number
  // 终止信号（若被信号杀死）
  signal?: string
  // 记录终态的时间戳
  completed: number
}

/**
 * Location-owned non-interactive shell command process service.
 *
 * Each `create` spawns one shell command, captures combined stdout/stderr to a
 * file, and returns an ID. Clients poll `get` for status and `output` for
 * file-backed output by cursor. No session, message, or permission state lives
 * here; callers (e.g. `ShellTool`) own that association and store the shell ID.
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
  // （中文）返回已知 shell 的终态与有界的尾部输出；输出捕获缺失与退出状态是两回事（分别呈现）
  readonly result: (started: Shell.Info) => Effect.Effect<ShellResult.Result>
  // Replaces the running command's timeout from now; zero clears it. Ignored once the command has
  // ended or timed out, even while its process is still being killed or its output captured.
  // （中文）从现在起替换运行中命令的超时；0 表示清除。命令已结束或已超时后忽略，
  // 即便进程还在被杀死或输出还在捕获中
  readonly timeout: (id: Shell.ID, duration: number) => Effect.Effect<Shell.Info, NotFoundError>
  // 按游标读取落盘输出（默认从头开始，单次上限 64KiB）
  readonly output: (id: Shell.ID, input?: Shell.OutputInput) => Effect.Effect<Shell.Output, NotFoundError>
  // 移除命令记录并删除其输出文件
  readonly remove: (id: Shell.ID) => Effect.Effect<void, NotFoundError>
}

// 定义 Shell 服务标记类
export class Service extends Context.Service<Service, Interface>()("@opencode/Shell") {}

// （中文）清理过期的 shell 输出文件：遍历数据目录 shell/<项目>/ 下匹配 sh_<12位十六进制>*.out 的文件，按保留期删除
export const cleanup = Effect.fn("Shell.cleanup")(function* () {
  // 获取文件系统工具服务
  const fs = yield* FSUtil.Service
  // 获取全局数据目录服务
  const global = yield* Global.Service
  // 拼出 shell 输出根目录：数据目录/shell
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
  // 交给通用保留期清理：超过 7 天的输出文件被删除
  yield* FileRetention.cleanup(fs, files.flat(), RETENTION)
})

// 清理层：每小时重复执行一次 cleanup，并 fork 为随作用域存活的后台纤程
const cleanupLayer = Layer.effectDiscard(
  cleanup().pipe(Effect.repeat(Schedule.spaced(Duration.hours(1))), Effect.forkScoped),
)

// 注册全局清理节点，依赖 FSUtil 与 Global
const cleanupNode = makeGlobalNode({
  name: "shell-output-cleanup",
  layer: cleanupLayer,
  deps: [FSUtil.node, Global.node],
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
      // 捕获当前 Effect 上下文，供后续在裸纤程中运行效果
      const context = yield* Effect.context()
      // 生成携带该上下文的 fork 函数，用于在层内启动后台纤程
      const runFork = Effect.runForkWith(context)
      // 活动命令表：ID -> 内部状态
      const commands = new Map<Shell.ID, Active>()
      // 已退出命令的 FIFO 顺序，用于按内存上限淘汰最旧的记录
      const exitOrder: Shell.ID[] = []

      // 本项目的输出目录：数据目录/shell/项目ID
      const outputDir = path.join(global.data, DIRECTORY, location.project.id)
      // 动态加载 fs/promises（mkdir、unlink）
      const { mkdir, unlink } = yield* Effect.promise(() => import("fs/promises"))
      // 动态加载 fs（createWriteStream、createReadStream）
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
            // Teardown interrupts pending commands; it is not a terminal command failure.
            // （中文）拆除（teardown）时以中断方式结束等待中的命令；这不算命令的终态失败
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
        // 查表
        const command = commands.get(id)
        // 未找到则失败
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
        // 删除输出文件，删除失败也忽略
        yield* Effect.promise(() => unlink(command.file).catch(() => {}))
        // Every shell reports exactly one exit; removing a running one ends it as killed.
        // （中文）每个 shell 恰好上报一次退出；移除运行中的命令视作被杀（killed）结束
        if (command.info.status === "running") yield* bus.publish(Shell.Event.Exited, { id, status: "killed" })
        // 发布删除事件
        yield* bus.publish(Shell.Event.Deleted, { id })
      })

      // 对外的移除接口：先确保命令存在，再执行内部移除
      const remove = Effect.fn("Shell.remove")(function* (id: Shell.ID) {
        yield* require(id)
        yield* removeCommand(id)
      })

      // 列出仍在运行的命令信息
      const list = Effect.fn("Shell.list")(function* () {
        return Array.from(commands.values())
          .filter((command) => command.info.status === "running")
          .map((command) => command.info)
      })

      // 获取命令信息
      const get = Effect.fn("Shell.get")(function* (id: Shell.ID) {
        return (yield* require(id)).info
      })

      // 等待命令到达终态
      const wait = Effect.fn("Shell.wait")(function* (id: Shell.ID) {
        return yield* Deferred.await((yield* require(id)).done)
      })

      // 设置/替换运行中命令的超时
      const timeout = Effect.fn("Shell.timeout")(function* (id: Shell.ID, duration: number) {
        // 确保命令存在
        const command = yield* require(id)
        // 已结束或尚无 timeout 能力（进程未就绪）时直接返回当前信息
        if (command.info.status !== "running" || !command.timeout) return command.info
        // 执行底层重设超时
        yield* command.timeout(duration)
        // 返回当前信息
        return command.info
      })

      // 按游标读取落盘输出
      const output = Effect.fnUntraced(function* (id: Shell.ID, input?: Shell.OutputInput) {
        // 确保命令存在
        const command = yield* require(id)
        // 起始游标，默认 0
        const cursor = input?.cursor ?? 0
        // 单次读取上限，默认 64KiB
        const limit = input?.limit ?? 65536
        // 游标已到文件末尾时返回空输出
        if (cursor >= command.size) return { output: "", cursor: command.size, size: command.size, truncated: false }
        // 计算读取起点（不允许为负）
        const start = Math.max(0, cursor)
        // 计算读取长度（不超过文件现有大小）
        const length = Math.min(limit, command.size - start)
        // 预分配读取缓冲区
        const buffer = Buffer.alloc(length)
        // 用读取流读取指定字节区间，读完或出错时以实际字节数完成
        const bytesRead = yield* Effect.promise(
          () =>
            new Promise<number>((resolve) => {
              // 创建读取流（字节闭区间 start..start+length-1）
              const stream = createReadStream(command.file, { start, end: start + length - 1 })
              // 已写入缓冲区的偏移量
              let offset = 0
              // 每个数据块拷入缓冲区并前移偏移
              stream.on("data", (chunk: string | Buffer) => {
                const bytes = Buffer.from(chunk)
                bytes.copy(buffer, offset)
                offset += bytes.length
              })
              // 读完时以实际读取的字节数完成
              stream.on("end", () => resolve(offset))
              // 出错（如文件已被清理）时按 0 字节完成
              stream.on("error", () => resolve(0))
            }),
        )
        // 把读取到的字节按 UTF-8 解码，并返回新游标与文件大小
        return {
          output: buffer.subarray(0, bytesRead).toString("utf8"),
          cursor: start + bytesRead,
          size: command.size,
          truncated: false,
        }
      })

      // （中文）汇总结果：等待终态，并给出按行数/字节限制裁剪后的尾部输出
      const result = Effect.fn("Shell.result")(function* (started: Shell.Info) {
        // 等待终态；命令已被移除时按 killed 处理并补上完成时间
        const info = yield* wait(started.id).pipe(
          Effect.catchTag("Shell.NotFoundError", () =>
            Effect.succeed({ ...started, status: "killed" as const, time: { ...started.time, completed: Date.now() } }),
          ),
        )
        // 计算捕获的尾部输出（命令记录已消失时整体为 undefined）
        const capture = yield* Effect.gen(function* () {
          // 读取配置中最新的 tool_output 限制
          const limits = Config.latest(yield* config.entries(), "tool_output")
          // 最大行数（配置优先，否则用默认值）
          const maxLines = limits?.max_lines ?? ToolOutput.MAX_LINES
          // 最大字节数（同上）
          const maxBytes = limits?.max_bytes ?? ToolOutput.MAX_BYTES
          // 先用极大游标探测输出的总大小
          const latest = yield* output(info.id, { cursor: Number.MAX_SAFE_INTEGER })
          // 再读取最后 maxBytes 字节
          const page = yield* output(info.id, { cursor: Math.max(0, latest.size - maxBytes), limit: maxBytes })
          // 按换行拆分为行
          const lines = page.output.split("\n")
          // 以换行结尾时去掉末尾的空行
          if (page.output.endsWith("\n")) lines.pop()
          // 判断是否发生截断（字节或行数超限）
          const truncated = latest.size > maxBytes || lines.length > maxLines
          // 行数超限时只保留最后 maxLines 行
          const text = lines.length > maxLines ? lines.slice(-maxLines).join("\n") : page.output
          // 计算全量输出的总行数（文件末尾无换行则补 1）
          const total = (yield* require(info.id)).newlines + (page.output.endsWith("\n") ? 0 : 1)
          // 实际展示的行数
          const shown = Math.min(lines.length, maxLines)
          // 截断时附加提示：展示的是第几行到第几行、完整输出保存在哪个文件
          const notice = truncated
            ? `\n\n[showing lines ${total - shown + 1}-${total} of ${total}; full output saved to ${info.file}]`
            : ""
          // 返回拼好的文本（无输出时显示占位符）与截断标记
          return { output: `${text || "(no output)"}${notice}`, truncated }
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

        // Spawn through the Environment and stream combined output to the file. The handle is scope-bound, so
        // the managing fiber keeps its scope open until the command terminates (it awaits `done` at the
        // end). `create` returns once `ready` resolves with the registered command.
        // （中文）经 Environment 拉起进程并把合并输出流入文件。句柄绑定在作用域上，因此管理纤程
        // 保持作用域打开直到命令终止（最后等待 `done`）。`ready` 以已登记的命令完成后，`create` 即返回。
        // 预创建的 Deferred：等待命令登记完成
        const ready = Deferred.makeUnsafe<Active, AppProcess.AppProcessError>()
        // 启动管理纤程（自带独立作用域）
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
                    forceKillAfter: Duration.seconds(3),
                  }),
                )
                .pipe(
                  Effect.mapError((cause) => new AppProcess.AppProcessError({ command: invocation.command, cause })),
                )
              // 构造活动命令状态：在 info 中补上 PID
              const command: Active = {
                info: produce(info, (draft) => {
                  draft.pid = handle.pid
                }),
                file,
                size: 0,
                newlines: 0,
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
                    command.size += chunk.length
                    // Count while streaming so truncation notices never rescan the output file.
                    // （中文）边写入边统计换行数，这样截断提示就不必重扫输出文件
                    for (let index = chunk.indexOf(10); index !== -1; index = chunk.indexOf(10, index + 1))
                      command.newlines++
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

              // 注入“重设超时”的实现
              command.timeout = (duration) =>
                Effect.gen(function* () {
                  // 已有终态时忽略
                  if (Deferred.isDoneUnsafe(ended)) return
                  // 先中断旧的定时器纤程
                  if (command.timeoutFiber) yield* Fiber.interrupt(command.timeoutFiber)
                  command.timeoutFiber = undefined
                  // duration 为 0 表示清除超时
                  if (duration === 0) return
                  // 启动新的定时器纤程
                  command.timeoutFiber = runFork(
                    Effect.sleep(Duration.millis(duration)).pipe(
                      // A recorded timeout must always kill. The kill runs detached, so interrupting this
                      // timer (retime, remove, teardown) neither cancels it nor waits for the process to die.
                      // （中文）一旦记录超时就必须杀死进程。杀进程独立运行，即使定时器被打断（重设、移除、拆除），
                      // 也既不会取消杀进程，也不会等待进程死亡
                      Effect.andThen(
                        Effect.gen(function* () {
                          // 只有本纤程抢先记录到超时才继续（否则说明进程已先结束）
                          if (!(yield* end({ status: "timeout" }))) return
                          // 在独立纤程中执行强杀（3 秒后强制）
                          runFork(
                            handle.kill({ forceKillAfter: Duration.seconds(3) }).pipe(Effect.catch(() => Effect.void)),
                          )
                        }).pipe(Effect.uninterruptible),
                      ),
                    ),
                  )
                })

              // 按调用方的初始超时启动定时器
              yield* command.timeout(invocation.timeout)

              // The process exits even after a timeout kill, so this fiber always publishes the outcome.
              // （中文）即使超时强杀，进程最终也会退出，因此该纤程总会发布结束结果
              runFork(
                Effect.gen(function* () {
                  // 等待退出码；正常退出时记录退出码
                  yield* handle.exitCode.pipe(
                    Effect.flatMap((code) => end({ status: "exited", exit: code })),
                    // 等待退出码失败（如被信号杀死）时记录信号
                    Effect.catch((error) =>
                      end({
                        status: "exited",
                        signal:
                          error.cause instanceof CrossSpawnSpawner.KilledBySignal ? error.cause.signal : undefined,
                      }),
                    ),
                  )
                  // 取回结束方式
                  const outcome = yield* Deferred.await(ended)
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

      // 组装服务实例
      return Service.of({ create, list, get, wait, result, timeout, output, remove })
    }),
  )

// 导出位置级服务节点及其依赖
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
    cleanupNode,
  ],
})
