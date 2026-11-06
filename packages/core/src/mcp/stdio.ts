// 将本模块以命名空间 McpStdio 整体再导出（barrel 模式）
export * as McpStdio from "./stdio.js"

// 引入 MCP SDK：消息反序列化/序列化、JSON-RPC 消息与传输（Transport）接口
import { deserializeMessage, serializeMessage, type JSONRPCMessage, type Transport } from "@modelcontextprotocol/client"
// 引入 Effect 核心构件：原因、时长、Effect、Fiber、Option、队列、结果、作用域、流
import { Cause, Duration, Effect, Fiber, Option, Queue, Result, Scope, Stream } from "effect"
// 引入子进程（ChildProcess）构建工具
import { ChildProcess } from "effect/process"
// 仅引入类型：子进程句柄
import type { ChildProcessHandle } from "effect/process/ChildProcessSpawner"
// 引入环境（Environment）服务：决定进程在哪里执行
import { Environment } from "../environment/index.js"
// 引入文件路径访问辅助
import { FileAccess } from "../file-access.js"

/** Mirrors StdioClientTransport: wait this long for a graceful exit after stdin closes. */
// 关闭宽限期：stdin 关闭后等待进程优雅退出的时长（对齐 SDK 的 StdioClientTransport 行为）
const CLOSE_GRACE = Duration.seconds(2)

/** Mirrors StdioClientTransport: escalate SIGTERM to SIGKILL after this long. */
// 强杀时限：SIGTERM 之后超过此时长升级为 SIGKILL（对齐 SDK 行为）
const FORCE_KILL_AFTER = Duration.seconds(2)
// 出站帧队列容量上限（背压控制）
const OUTGOING_CAPACITY = 64
// 单帧最大字节数：16 MiB，超出视为协议错误
const MAX_FRAME_BYTES = 16 * 1024 * 1024
// An unexpected exit is reported with its exit code and the end of stderr, which usually names the cause.
// 意外退出时等待退出码与 stderr 尾部的时限（用于收集报错线索）
const EXIT_WAIT = Duration.seconds(1)
// 报告中保留的 stderr 尾部长度（字符数）
const STDERR_TAIL = 1_000

// stdio 传输的配置项
export interface Options {
  /** Server name; only used to attribute logs. */
  // 服务器名（仅用于日志标注）
  readonly server: string
  // 启动命令
  readonly command: string
  // 命令参数
  readonly args: ReadonlyArray<string>
  // 工作目录
  readonly cwd: string
  /**
   * Environment declared by the server config, and nothing else.
   *
   * The host environment is merged in by the spawner via `extendEnv`, which keeps the merge on the
   * side that actually runs the process: the local driver extends with the host's `process.env`
   * (what the MCP SDK's transport did), while a workspace driver extends with the sandbox's own
   * environment. Host variables therefore never cross the seam into a remote workspace.
   */
  // 服务器配置声明的环境变量（仅此而已；宿主环境的合并由 spawner 通过 extendEnv 完成）
  readonly environment: Record<string, string>
}

/**
 * Resolves a local server's configured `cwd` against the workspace directory, expanding `~` to the
 * opencode host's home. Environments do not expose their own home, so a workspace-backed location
 * gets the host's home too.
 */
// 解析本地服务器的 cwd：相对路径按工作区目录解析，`~` 展开为宿主家目录；未配置则直接用工作区目录
export const resolveCwd = (directory: string, cwd: string | undefined) =>
  cwd ? FileAccess.resolvePath(directory, cwd) : directory

/**
 * MCP stdio transport that spawns its server through the location's `Environment` instead of the
 * SDK's host-bound `StdioClientTransport`, so a workspace-backed location runs its MCP servers
 * wherever the rest of its execution happens.
 *
 * The process is acquired in the calling scope: closing the scope kills it (the spawner kills the
 * whole process group, so descendants go too) regardless of whether the transport was closed.
 */
// 工厂：创建基于 stdio 的 MCP 传输（进程通过 Location 的环境服务生成）
export const make = Effect.fnUntraced(function* (options: Options) {
  // 取回环境服务（决定子进程的执行平面）
  const environment = yield* Environment.Service
  // 取回调用方作用域：作用域关闭时进程随之被杀
  const scope = yield* Effect.scope
  // Outgoing frames are queued rather than written to `handle.stdin` directly: the sink closes the
  // stream it is run with, and stdin must stay open across the whole session.
  // 出站帧队列：先入队再写 stdin，避免 sink 关闭流时把整个会话的 stdin 一起关掉
  const outgoing = yield* Queue.bounded<string, Cause.Done>(OUTGOING_CAPACITY)
  // 传输状态机与进程句柄：ready/starting/open/closed 四态
  const state: { phase: "ready" | "starting" | "open" | "closed"; handle?: ChildProcessHandle } = { phase: "ready" }
  // 启动 Promise（close 时需要等待启动流程收尾）
  let startup: Promise<void> | undefined
  // 关闭 Promise（缓存首次执行结果，保证 close 幂等）
  let closing: Promise<void> | undefined
  // Bytes of the unterminated line, kept as chunk views and joined once its newline arrives.
  // 尚未凑齐一行的字节：以块视图累积，换行到达后拼接成整行
  let pending: Array<Uint8Array> = []
  // 已累积的未成行字节数
  let pendingBytes = 0
  // 文本解码器（把字节行解码为字符串）
  const decoder = new TextDecoder()
  // 累积的 stderr 输出（只保留尾部，用于错误报告）
  let stderr = ""

  // 停止进程：先给宽限期等优雅退出，再 SIGTERM（超时后升级 SIGKILL）
  const stop = Effect.fnUntraced(function* (handle: ChildProcessHandle) {
    // Exit completion can precede descendant cleanup after the capture deadline.
    // 等待退出码，最多等 CLOSE_GRACE；超时则放弃等待（Option 为 none）
    yield* Effect.timeoutOption(handle.exitCode, CLOSE_GRACE).pipe(Effect.ignore)
    // 发送 SIGTERM，并允许超时后强制 SIGKILL
    yield* handle.kill({ killSignal: "SIGTERM", forceKillAfter: FORCE_KILL_AFTER })
  }, Effect.ignore())

  // 关闭传输：幂等（closing 缓存首次执行的 Promise）
  const close = () =>
    (closing ??= Effect.runPromise(
      Effect.gen(function* () {
        // 进入 closed 状态
        state.phase = "closed"
        // 丢弃未成行的缓冲
        pending = []
        pendingBytes = 0
        // 结束出站队列（不再接受新帧）
        Queue.endUnsafe(outgoing)
        // 若启动仍在进行，等它结束（忽略其错误）
        if (startup) yield* Effect.promise(() => startup!.catch(() => undefined))
        // 取出进程句柄
        const handle = state.handle
        // 没有进程则无事可做
        if (!handle) return
        // 清空句柄引用
        state.handle = undefined
        // 停止进程
        yield* stop(handle)
      }).pipe(Effect.ensuring(Queue.shutdown(outgoing))),
    ))

  // `pid` and `stderr` match the SDK's StdioClientTransport accessors. The SDK detects stdio by their
  // presence, and only for stdio does it treat an unanswered server/discover probe as a legacy server.
  // stderr is drained into the debug log, so no stream is handed out.
  // 传输对象：额外带 pid 与 stderr 访问器以对齐 SDK 的 StdioClientTransport
  const transport: Transport & { readonly pid: number | null; readonly stderr: null } = {
    // pid：进程句柄存在时返回其 PID，否则 null
    get pid() {
      return state.handle?.pid ?? null
    },
    // stderr 不外发流（已排入调试日志），固定为 null
    stderr: null,
    // start：启动子进程并接线（只在 ready 状态可调用一次）
    start: () => {
      // 非 ready 状态说明已启动过
      if (state.phase !== "ready") return Promise.reject(new Error("Stdio transport already started"))
      // 进入 starting 状态
      state.phase = "starting"
      // 启动流程：spawn 进程、登记句柄、切换到 open 并开始读取输出
      startup = Effect.runPromise(
        Effect.gen(function* () {
          // 通过环境服务的 spawner 生成子进程（命令 + 参数 + 各项接线）
          const handle = yield* environment.spawner.spawn(
            ChildProcess.make(options.command, [...options.args], {
              // 工作目录
              cwd: options.cwd,
              // 环境变量只用配置声明的
              env: options.environment,
              // 允许 spawner 按执行平面合并环境
              extendEnv: true,
              // stdin：把出站队列编码为文本流；队列结束时关闭 stdin
              stdin: { stream: Stream.encodeText(Stream.fromQueue(outgoing)), endOnDone: true },
              // stdout 用管道读取
              stdout: "pipe",
              // stderr 用管道读取
              stderr: "pipe",
              // 强杀时限
              forceKillAfter: FORCE_KILL_AFTER,
            }),
          )
          // 登记进程句柄
          state.handle = handle
          // 若启动期间传输已被关闭，则立即停止进程并返回
          if (state.phase === "closed") {
            state.handle = undefined
            return yield* stop(handle)
          }
          // 进入 open 状态
          state.phase = "open"
          // 开始读取并处理输出流
          yield* startOutput(handle)
        }).pipe(Scope.provide(scope)),
      )
      // 返回启动 Promise（与 SDK 行为一致）
      return startup
    },
    // send：把消息序列化后放入出站队列（仅 open 状态可用）
    send: (message: JSONRPCMessage) =>
      // 非 open 状态视为未连接
      state.phase !== "open"
        ? Promise.reject(new Error("Not connected"))
        // open 状态：入队；队列已满（offer 返回 false）同样按未连接失败
        : Effect.runPromise(
            Queue.offer(outgoing, serializeMessage(message)).pipe(
              Effect.flatMap((offered) => (offered ? Effect.void : Effect.fail(new Error("Not connected")))),
            ),
          ),
    // close：见上方定义
    close,
  }

  // 处理一个 stdout 字节块：按换行切行并逐行投递
  const deliver = (chunk: Uint8Array) => {
    // 本块内当前行的起始下标
    let start = 0
    // 从 start 起找第一个换行符（10 = '\n'）
    let newline = chunk.indexOf(10)
    // 还有完整行且传输未关闭时继续处理
    while (newline !== -1 && state.phase !== "closed") {
      // 取出整行（不含换行）
      const line = chunk.subarray(start, newline)
      // 该行完成后的总字节数（含跨块累积）
      const size = pendingBytes + line.length
      // 超过单帧上限则按协议错误处理
      if (size > MAX_FRAME_BYTES) return oversized()
      // 有跨块累积则拼接后投递，否则直接投递本行
      receive(pending.length === 0 ? line : Buffer.concat([...pending, line], size))
      // 清空累积
      pending = []
      pendingBytes = 0
      // 移动到下一行的起始位置
      start = newline + 1
      // 继续找下一个换行
      newline = chunk.indexOf(10, start)
    }
    // 没有剩余不完整字节或已关闭时结束
    if (start === chunk.length || state.phase === "closed") return
    // 把剩余不完整部分计入累积字节数
    pendingBytes += chunk.length - start
    // 累积超过上限同样按协议错误处理
    if (pendingBytes > MAX_FRAME_BYTES) return oversized()
    // A view is enough: the runtime hands out a fresh buffer for every pipe read.
    // 累积块视图即可：运行时每次管道读取都会给出新缓冲
    pending.push(start === 0 ? chunk : chunk.subarray(start))
  }

  // 处理一行文本：去除尾部 \r、跳过空行、反序列化并分发
  const receive = (line: Uint8Array) => {
    // 行尾若为 \r（13）则去掉，再解码为文本
    const text = decoder.decode(line.at(-1) === 13 ? line.subarray(0, -1) : line)
    // 空白行直接忽略
    if (text.trim() === "") return
    // 尝试反序列化 JSON-RPC 消息，失败时带上服务器名包装错误
    const message = Result.try({
      try: () => deserializeMessage(text),
      catch: (cause) => new Error(`Invalid MCP stdio message from ${options.server}: ${cause}`, { cause }),
    })
    // 解析失败：报告错误（不中断连接）
    if (Result.isFailure(message)) return transport.onerror?.(message.failure)
    // 成功：交给上层
    transport.onmessage?.(message.success)
  }

  // Closing fails every pending request at once rather than leaving the one this line answered waiting.
  // 单帧超限处理：报告错误并关闭连接，让所有挂起请求立即失败
  const oversized = () => {
    // 报告超限错误（16 MiB 无消息边界）
    transport.onerror?.(
      new Error(`MCP server ${options.server} wrote more than 16 MiB to stdout without a message boundary`),
    )
    // 触发关闭
    void close()
  }

  // 启动输出处理：分别接管 stderr 与 stdout 两个管道
  const startOutput = (handle: ChildProcessHandle) =>
    Effect.gen(function* () {
      // Drain stderr into the debug log so chatty servers cannot stall on a full pipe.
      // 后台纤程：持续排空 stderr 到调试日志，防止话痨服务器因管道写满而卡住
      const drain = yield* Effect.forkScoped(
        handle.stderr.pipe(
          // 把字节流解码为文本
          Stream.decodeText(),
          // 每段输出都追加进 stderr 变量并只保留尾部
          Stream.tap((output) => Effect.sync(() => (stderr = (stderr + output).slice(-STDERR_TAIL)))),
          // 非空输出记为调试日志，空输出跳过
          Stream.runForEach((output) =>
            output.trim() === ""
              ? Effect.void
              : Effect.logDebug("mcp server stderr", { server: options.server, output }),
          ),
          // 忽略流处理中的任何错误
          Effect.ignore,
        ),
      )

      // 后台纤程：处理 stdout
      yield* Effect.forkScoped(
        Stream.runForEach(handle.stdout, (chunk) => Effect.sync(() => deliver(chunk))).pipe(
          // 出错时（中断除外）把原因报告给 onerror
          Effect.tapCause((cause) =>
            Effect.sync(() => {
              // 从原因中提取错误对象
              const error = Cause.squash(cause)
              // 统一包装为 Error 后上报
              transport.onerror?.(error instanceof Error ? error : new Error(String(error)))
            }),
          ),
          // 忽略错误（上面已上报）
          Effect.ignore,
          // stdout ending means the server is gone.
          // 清理逻辑：无论正常结束还是出错都要执行
          Effect.ensuring(
            Effect.gen(function* () {
              // 传输未被主动关闭却读到流结束，说明进程意外退出
              const unexpected = state.phase !== "closed"
              if (unexpected) {
                // stdout can end before the final stderr output has been read.
                // 等 stderr 排空并取退出码，最多等 EXIT_WAIT（超时拿不到就放弃）
                const code = yield* Fiber.await(drain).pipe(
                  Effect.andThen(handle.exitCode),
                  Effect.timeoutOption(EXIT_WAIT),
                  Effect.orElseSucceed(() => Option.none()),
                )
                // 生成退出信息：有码带码，无码则只有一句“已退出”
                const exited = Option.match(code, {
                  onNone: () => "MCP server process exited",
                  onSome: (code) => `MCP server process exited with code ${code}`,
                })
                // 取尾部 stderr 输出作为线索
                const output = stderr.trim()
                // 报告意外退出（附 stderr 线索）
                transport.onerror?.(new Error(output ? `${exited}: ${output}` : exited))
                // 关闭传输
                yield* Effect.promise(close)
              }
              // 无论如何通知上层连接已关闭
              transport.onclose?.()
            }),
          ),
        ),
      )
    })

  // 返回构造好的传输实例
  return transport
})
