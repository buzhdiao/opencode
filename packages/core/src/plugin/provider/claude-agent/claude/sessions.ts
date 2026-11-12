// 导出 ClaudeSessions 命名空间，供其他模块引用本文件内容
export * as ClaudeSessions from "./sessions.js"

// 导入 Claude Agent SDK 的选项与消息类型
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
// 导入 AI SDK 的函数工具、提示词、文本块与工具调用块类型
import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3Prompt,
  LanguageModelV3TextPart,
  LanguageModelV3ToolCallPart,
} from "@ai-sdk/provider"
// 从 effect 库导入 Effect、Fiber 与 Semaphore（信号量）
import { Effect, Fiber, Semaphore } from "effect"
// 导入 Claude IO（进程/fork 等本地操作）
import { ClaudeIO } from "./io.js"
// 导入状态类型
import type { ClaudeStatus } from "./status.js"
// 导入查询选项构造工具
import { ClaudeQueryOptions } from "./query-options.js"
// 导入单个会话的封装
import { ClaudeSession } from "./session.js"
// 导入会话记录（持久化）模块
import { SessionRecord } from "../sync/record.js"
// 导入检查点构建模块
import { Checkpoints } from "../sync/checkpoints.js"
// 导入同步决策模块
import { SyncDecision } from "../sync/decide.js"
// 导入历史补齐模块
import { CatchUp } from "../sync/catch-up.js"
// 导入“转换为 Claude 消息”工具
import { ConvertToClaudeMessage } from "../language-model/convert-to-claude-message.js"
// 导入待处理工具协调器
import { PendingTools } from "../tools/pending.js"
// 导入工具名转换工具
import { ToolNames } from "../tools/names.js"
// 导入工具结果转换工具
import { ToolResult } from "../tools/result.js"

// 交接宽限期（毫秒）：最后一个所有者离开后，等待这么久再关闭会话进程，便于下一个插件实例接管
export const HANDOVER_MS = 10_000
// 空闲回收时间（毫秒）：会话进程空闲这么久后停止
export const IDLE_MS = 5 * 60_000

// 一次模型请求的描述
export interface Request {
  // 只有主（primary）请求才有会话 ID；辅助（side）请求在一次性进程中运行。
  // Only primary calls have one. Side calls run in a throwaway process.
  readonly sessionID?: string
  // OpenCode 原生的 fork 谱系，或提供 compaction/generate 快照的会话。
  // Native OpenCode fork lineage, or the session supplying a compaction/generate snapshot.
  readonly sourceID?: string
  readonly model: string
  // 努力等级（可选）
  readonly effort?: Options["effort"]
  // 输出 token 上限（可选）
  readonly maxOutputTokens?: number
  // 连接凭据环境变量（可选）
  readonly connection?: Readonly<Record<string, string>>
  // 系统提示配置
  readonly system: NonNullable<Options["systemPrompt"]>
  // 完整提示词
  readonly prompt: LanguageModelV3Prompt
  // 提供的工具列表
  readonly tools: readonly LanguageModelV3FunctionTool[]
  // 消息发射回调（供上层转换为流部件）
  readonly emit: (message: SDKMessage) => void
}

// 存活进程（LiveProcess）：一个正在运行的 claude 会话进程及其状态
interface LiveProcess {
  // 会话封装
  readonly session: ClaudeSession.Interface
  // 待处理工具协调器
  readonly pending: PendingTools.Interface
  // 当前模型（可在运行中的进程上切换）
  model: string
  // 当前努力等级（同上）
  effort?: Options["effort"]
  // 需要新进程才能更改的设置（模型与努力等级在运行中的进程上修改）。
  // Settings that need a new process to change. Model and effort change on the running one.
  readonly launch: string
  // 等待工具结果的调用 ID 列表（undefined 表示没有停在工具边界）
  waiting?: string[]
}

// 工具续接（ToolContinuation）：停在工具边界的轮次在拿到结果后的续跑信息
interface ToolContinuation {
  // 已消费的提示词结束下标
  readonly end: number
  // 各工具调用的结果
  readonly results: Array<{ id: string; result: ToolResult.Result }>
}

// 注册表条目（Entry）：按 OpenCode 会话维护的进程与状态
interface Entry {
  // 串行化该会话请求的信号量
  readonly lock: Semaphore.Semaphore
  // 当前存活的进程（可能无）
  process?: LiveProcess
  // 该会话的持久化记录（可能无）
  record?: SessionRecord.Record
  // 空闲回收定时器 fiber（可能无）
  idle?: Fiber.Fiber<void, never>
  // 当前活动请求的 fiber（可能无）
  active?: Fiber.Fiber<unknown, unknown>
}

// 会话注册表对外的接口
export interface Interface {
  // 运行一次模型请求
  readonly run: (request: Request) => Effect.Effect<void, Error>
  // OpenCode 停止运行该会话，仍在等待工具结果的轮次不会等到结果了。
  // OpenCode stopped running the session, so a turn still waiting for tool results will not get them.
  readonly idle: (sessionID: string) => Effect.Effect<void>
}

// 计算“启动指纹”：这些设置变更需要新进程才能生效
const launch = (request: Request) =>
  JSON.stringify([request.maxOutputTokens, request.connection, request.system, request.tools])

// 把任意抛出的值转换为 Error
const toError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)))
// 把 Promise 运行包装为 Effect（异常转为 Error）
const attempt = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: toError })
// 把同步运行包装为 Effect（异常转为 Error）
const attemptSync = <A>(run: () => A) => Effect.try({ try: run, catch: toError })

// 创建会话注册表：管理所有存活的 claude 进程
export function registry() {
  // 按会话 ID 的常驻条目
  const entries = new Map<string, Entry>()
  // 辅助（side）调用与聊天共享启动/排空流程，但只追踪到其请求结束。
  // Side calls share startup/draining with chat, but are tracked only until their request ends.
  const temporary = new Set<Entry>()
  // 当前所有者（插件实例）数量
  let owners = 0
  // 交接（handover）定时器 fiber
  let handover: Fiber.Fiber<void, never> | undefined

  // 中断某个条目的当前轮次
  const interrupt = Effect.fn("ClaudeSessions.interrupt")(function* (entry: Entry) {
    // 取当前进程
    const process = entry.process
    // 无进程则无事可做
    if (!process) return
    // 调用会话的中断
    yield* attempt(() => process.session.interrupt())
    // 清空待处理工具（以“用户取消”收尾）
    process.pending.clear()
    // 清空等待列表
    process.waiting = undefined
  }, Effect.uninterruptible)

  // 停止某个条目的进程
  const stop = Effect.fn("ClaudeSessions.stop")(function* (entry: Entry) {
    // 取当前进程
    const process = entry.process
    // 无进程则无事可做
    if (!process) return
    // 停止会话进程，并确保 afterwards 清理待处理队列与条目状态
    yield* attempt(() => process.session.stop()).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          // 清空待处理工具
          process.pending.clear()
          // 从条目上移除进程引用
          entry.process = undefined
        }),
      ),
    )
  }, Effect.uninterruptible)

  // 重新武装空闲回收定时器
  const armIdle = Effect.fn("ClaudeSessions.armIdle")(function* (entry: Entry) {
    // 已有定时器则先中断
    if (entry.idle) yield* Fiber.interrupt(entry.idle)
    // 睡眠 IDLE_MS 后在锁内停止进程；fork 为独立 fiber
    entry.idle = yield* Effect.sleep(IDLE_MS).pipe(
      Effect.andThen(entry.lock.withPermit(stop(entry))),
      // 失败只记警告日志
      Effect.catch((error) => Effect.logWarning(error)),
      // detach fork：不等待其完成
      Effect.forkDetach,
    )
  })

  // 关闭所有条目（常驻 + 临时）
  const closeEntries = Effect.fn("ClaudeSessions.closeEntries")(function* () {
    // 遍历所有条目
    for (const entry of [...entries.values(), ...temporary]) {
      // 中断活动请求
      if (entry.active) yield* Fiber.interrupt(entry.active)
      // 活动轮次的 finalizer 可能会再安装新的空闲定时器，因此这里也中断它
      // The active turn's finalizer can install a new idle timer.
      if (entry.idle) yield* Fiber.interrupt(entry.idle)
      // 在锁内停止进程（失败只记警告）
      yield* entry.lock.withPermit(stop(entry)).pipe(Effect.catch((error) => Effect.logWarning(error)))
    }
    // 清空条目表
    entries.clear()
  })

  // 取消交接定时器
  const cancelHandover = Effect.fn("ClaudeSessions.cancelHandover")(function* () {
    // 无定时器则跳过
    if (!handover) return
    // 中断定时器 fiber
    yield* Fiber.interrupt(handover)
    // 清空引用
    handover = undefined
  })

  // 整体关闭：取消交接并关闭所有条目
  const close = Effect.fn("ClaudeSessions.close")(function* () {
    yield* cancelHandover()
    yield* closeEntries()
  })

  // 附着（attach）：把注册表绑定到一个插件实例的生命周期
  const attach = Effect.fn("ClaudeSessions.attach")(function* (input: {
    // Claude IO 抽象
    readonly io: ClaudeIO.Interface
    // 状态机接口
    readonly status: ClaudeStatus.Interface
    // 会话记录存储
    readonly storage: SessionRecord.Storage
    // 工作目录
    readonly directory: string
  }) {
    // 基于存储创建会话记录读写器
    const records = SessionRecord.make(input.storage)
    // 所有者计数 +1
    owners++
    // 新实例附着时取消待执行的交接
    yield* cancelHandover()
    // 注册 finalizer：实例销毁时
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        // 所有者计数 -1
        owners--
        // 还有其他所有者则不关闭
        if (owners !== 0) return
        // 没有任何条目则无需交接
        if (entries.size === 0 && temporary.size === 0) return
        // 启动交接：等待 HANDOVER_MS 后关闭所有条目（期间新实例可接管）
        handover = yield* Effect.sleep(HANDOVER_MS).pipe(Effect.andThen(closeEntries()), Effect.forkDetach)
      }),
    )

    // 打开（或复用）条目的进程
    const open = Effect.fn("ClaudeSessions.open")(function* (entry: Entry, request: Request) {
      // 记录本次是否为新建进程
      const starting = !entry.process
      // 取消只可能落在等待 ready 的阶段，因此已启动的进程总会被记录并停止。
      // A cancel can only land while waiting for ready, so a started process is always recorded and stopped.
      const opened = yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          // 没有进程则启动新进程
          if (!entry.process) {
            // 在 PATH 中查找 claude 可执行文件
            const executable = input.io.which()
            // 找不到：上报“未安装”状态并失败
            if (!executable) {
              yield* input.status.report({ type: "missing" })
              return yield* Effect.fail(new Error("Install Claude Code and run `claude auth login` first"))
            }
            // 创建待处理工具协调器
            const pending = PendingTools.make()
            // 启动 Claude 会话（构造选项后调用 start）
            const session = yield* attempt(async () =>
              ClaudeSession.start(
                await ClaudeQueryOptions.session({
                  // 可执行文件路径
                  executable,
                  // IO 抽象
                  io: input.io,
                  // 连接凭据环境
                  connection: request.connection,
                  // 工作目录
                  directory: input.directory,
                  // 模型
                  model: request.model,
                  // 努力等级
                  effort: request.effort,
                  // 输出上限
                  maxOutputTokens: request.maxOutputTokens,
                  // 系统提示
                  system: request.system,
                  // 工具列表
                  tools: request.tools,
                  // 待处理工具协调器
                  pending,
                  // 主请求（有会话 ID）才持久化会话
                  persist: request.sessionID !== undefined,
                  // 恢复到已记录的 Claude 会话
                  resume: entry.record?.claudeSessionID,
                }),
              ),
            )
            // 记录新进程及其启动指纹
            entry.process = { session, pending, model: request.model, effort: request.effort, launch: launch(request) }
          }
          // 取当前进程
          const process = entry.process
          // 等待初始化结果（可被取消；30 秒超时；出错时尽力停止进程）
          const probe = yield* restore(
            attempt(() => process.session.ready).pipe(
              Effect.timeoutOrElse({
                // 超时时长
                duration: "30 seconds",
                // 超时转为失败
                orElse: () => Effect.fail(new Error("claude did not start within 30 seconds")),
              }),
            ),
          ).pipe(Effect.onError(() => stop(entry).pipe(Effect.ignore)))
          // 返回进程与探测结果
          return { process, probe }
        }),
      )
      // 取出进程
      const process = opened.process
      // 新进程会报告版本、登录与模型列表，从而无需单独检查就能保持模型列表最新。
      // A new process reports its version, login and models, which keeps the model list current without a separate check.
      if (starting) yield* input.status.report({ type: "ready", probe: opened.probe })
      // 在发送输入或放行停靠的工具结果之前先应用控制项。
      // Apply controls before sending input or releasing parked tool results.
      if (process.model !== request.model) {
        // 切换模型
        yield* attempt(() => process.session.setModel(request.model))
        // 更新进程记录
        process.model = request.model
      }
      if (process.effort !== request.effort) {
        // 切换努力等级
        yield* attempt(() => process.session.setEffort(request.effort))
        // 更新进程记录
        process.effort = request.effort
      }
      // 返回就绪的进程
      return process
    })

    // 执行一轮对话（turn）：发送输入并读取一个步骤
    const turn = Effect.fn("ClaudeSessions.turn")(function* (
      // 条目
      entry: Entry,
      // 请求
      request: Request,
      // 提示词起始下标（同步决策给出）
      start: number,
      // 工具续接信息（可选）
      continuation?: ToolContinuation,
    ) {
      // 在打开进程之前先校验输入：被拒绝的重建不能把空进程与旧记录配对。
      // Validate before opening a process: a rejected rebuild must not pair an empty process with the old record.
      const content = yield* attemptSync(() => {
        // 有会话 ID 或已有记录：按“补齐”方式构造内容（从续接点或 start 开始）
        if (request.sessionID || entry.record) return CatchUp.content(request.prompt, continuation?.end ?? start)
        // 一次性请求：整段转换为 Claude 消息
        return ConvertToClaudeMessage.content(request.prompt)
      })
      // 打开进程
      const live = yield* open(entry, request)
      // 取会话封装
      const session = live.session

      // 是否会添加用户消息：续接时内容可能为空
      const addsUserMessage = !continuation || content.length > 0
      // 用户消息 ID（若发送）
      const userID = addsUserMessage ? crypto.randomUUID() : undefined

      // 收集本轮回复（文本与工具调用）
      const reply: Array<LanguageModelV3TextPart | LanguageModelV3ToolCallPart> = []
      // 工具结果 -> Claude 消息 ID 的映射
      const toolMessages = new Map<string, string>()
      // 已见过的助手消息 UUID（去重）
      const seen = new Set<string>()
      // 最新一条助手消息 ID
      let messageID: string | undefined
      // 等待结果的工具调用 ID 列表
      const waiting: string[] = []

      // 消息发射回调：转发给上层的同时收集回复/工具信息
      const emit = (message: SDKMessage) => {
        // init 系统消息：若我们提供了工具，则校验 OpenCode MCP 服务器已连接
        if (message.type === "system" && message.subtype === "init" && request.tools.length > 0) {
          // 检查 opencode 服务器是否 connected
          const connected = message.mcp_servers.some(
            (server) => server.name === "opencode" && server.status === "connected",
          )
          // 未连接：抛错终止
          if (!connected) throw new Error("The OpenCode tool server did not connect to Claude Code")
        }
        // 顶层无错误的助手消息（按 UUID 去重）
        if (
          message.type === "assistant" &&
          message.parent_tool_use_id === null &&
          !message.error &&
          !seen.has(message.uuid)
        ) {
          // 记录已见
          seen.add(message.uuid)
          // 更新最新消息 ID
          messageID = message.uuid
          // 遍历内容块
          for (const part of message.message.content) {
            // 文本块加入回复
            if (part.type === "text") {
              reply.push({ type: "text", text: part.text })
              continue
            }
            // 非工具调用块跳过
            if (part.type !== "tool_use") continue
            // 反查 OpenCode 原始工具名；非我们的工具跳过
            const name = ToolNames.original(part.name, request.tools)
            if (!name && part.name.startsWith(ToolNames.PREFIX)) {
              // A tool removed after this process started is still on its tool server; answer here so the turn goes on.
              live.pending.expect(part.id, part.name)
              live.pending.resolve(part.id, {
                mcp: { isError: true, content: [{ type: "text", text: "This tool is no longer available." }] },
                replacement: undefined,
              })
            }
            if (!name) continue
            // 在待处理协调器中预登记该调用
            live.pending.expect(part.id, part.name)
            // 加入等待列表
            waiting.push(part.id)
            // 加入回复
            reply.push({ type: "tool-call", toolCallId: part.id, toolName: name, input: part.input })
          }
        }
        // 用户消息中的工具结果：记录 tool_use_id -> 消息 UUID
        if (message.type === "user" && message.uuid && Array.isArray(message.message.content)) {
          for (const part of message.message.content) {
            if (part.type === "tool_result") toolMessages.set(part.tool_use_id, message.uuid)
          }
        }
        // 原样转发给上层
        request.emit(message)
      }

      // 步骤状态标记
      let completed = false
      // 是否被中断
      let interrupted = false
      // 是否已开始（发送过输入）
      let started = false
      // 是否停靠在工具边界
      let parked = false
      // 步骤 Effect：发送输入并读取一个步骤
      const step = Effect.gen(function* () {
        // 非续接：开始新轮次
        if (!continuation) session.begin(content, userID)
        // 续接：补发用户消息并回填工具结果
        if (continuation) {
          // 有新用户消息则追加
          if (userID !== undefined) session.addUser(content, userID)
          // 逐个回填工具结果
          for (const item of continuation.results) {
            live.pending.resolve(item.id, item.result)
          }
        }
        // 标记已开始
        started = true
        // 读取一个步骤
        const outcome = yield* attempt(() => session.readStep(emit, request.tools))
        // 停靠判定：结果为 "tools" 表示停在工具边界
        parked = outcome === "tools"
        // 标记完成
        completed = true
        // 停靠时记录等待列表，否则清空
        live.waiting = parked ? waiting : undefined
      })

      // 工具边界只结束 OpenCode 的步骤；Claude 轮次继续等待结果。其他情况一律中断并排空。
      // A tool boundary ends only the OpenCode step; the Claude turn waits for the results. Anything else interrupts and drains it.
      const interruptUnlessParked = Effect.gen(function* () {
        // 停靠则无需中断
        if (parked) return
        // 中断该条目的当前轮次（失败即中止）
        yield* interrupt(entry).pipe(Effect.orDie)
      })

      // 保存会话记录
      const saveRecord = Effect.gen(function* () {
        // 非主请求、未持久化或未开始：跳过
        if (!request.sessionID || !session.persisted || !started) return
        // 已完成或被中断时构建新的检查点历史；否则不保留历史
        const history =
          completed || interrupted
            ? Checkpoints.build({
                // 完整提示词
                prompt: request.prompt,
                // 上次记录
                previous: entry.record,
                // 用户消息 ID
                userID,
                // 仅完成时记录回复
                reply: completed ? reply : [],
                // 仅完成时记录消息 ID
                messageID: completed ? messageID : undefined,
                // 工具结果映射
                toolMessages,
              })
            : undefined
        // 更新条目记录
        entry.record = { claudeSessionID: session.id, history, interrupted: interrupted && !completed }
        // 持久化
        yield* records.set(request.sessionID, entry.record)
      })

      // 执行步骤：登记中断、确保中断非停靠轮次、确保保存记录
      yield* step.pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            // 标记中断
            interrupted = true
          }),
        ),
        Effect.ensuring(interruptUnlessParked),
        Effect.ensuring(saveRecord),
      )
    })

    // 释放条目：请求结束后清理
    const release = Effect.fn("ClaudeSessions.release")(function* (entry: Entry, request: Request) {
      // 清除活动 fiber
      entry.active = undefined
      // 一次性请求（无会话 ID）：停止进程并清理
      if (!request.sessionID) {
        // 停止进程（失败只记警告）
        yield* stop(entry).pipe(Effect.catch((error) => Effect.logWarning(error)))
        // 取一次性会话的 ID
        const sessionID = entry.record?.claudeSessionID
        // 有 ID 则从磁盘删除该会话转录
        if (sessionID)
          yield* attempt(() => input.io.remove(sessionID)).pipe(Effect.catch((error) => Effect.logWarning(error)))
        // 从临时集合移除
        temporary.delete(entry)
        return
      }
      // 仍在等待工具结果的轮次还算忙。子代理、权限确认和提问可能比 IDLE_MS 更久，
      // 因此 idle() 会在 OpenCode 停止运行会话时再启动定时器。
      // A turn waiting for tool results is still busy. Subagents, permission prompts and questions can take longer
      // than IDLE_MS, so idle() starts the timer once OpenCode stops running the session.
      if (entry.process?.waiting) return
      // 否则立即武装空闲回收
      yield* armIdle(entry)
    })

    // 分支（branch）：从源记录的安全边界分叉一个新的 Claude 转录
    const branch = Effect.fn("ClaudeSessions.branch")(function* (
      // 条目
      entry: Entry,
      // 请求
      request: Request,
      // 源记录（可选）
      source?: SessionRecord.Record,
    ) {
      // 查找安全边界
      const boundary = SyncDecision.boundary(request.prompt, source)
      // 无源记录或无安全边界：从头开始（返回 0）
      if (!source || !boundary) return 0
      // 在磁盘上创建分叉转录之前，先校验补齐输入。
      // Validate catch-up input before creating a forked transcript on disk.
      yield* attemptSync(() => CatchUp.content(request.prompt, boundary.start))
      // 分叉源会话到指定消息为止
      const fork = yield* attempt(() => input.io.fork(source.claudeSessionID, boundary.messageID))
      // 分叉失败：从头开始
      if (!fork) return 0
      // 把历史检查点的消息 ID 映射到新转录中的对应消息
      const history = boundary.history.map((checkpoint) => ({
        // 哈希不变
        hash: checkpoint.hash,
        // 消息 ID 换成分叉后的
        claudeMessageID: checkpoint.claudeMessageID ? fork.messages.get(checkpoint.claudeMessageID) : undefined,
      }))
      // 更新条目记录为分叉会话
      entry.record = { claudeSessionID: fork.sessionID, history }
      // 返回从哪里继续
      return boundary.start
    }, Effect.uninterruptible)

    // 快照（snapshot）：为 compaction/generate 请求从源会话复制状态
    const snapshot = Effect.fn("ClaudeSessions.snapshot")(function* (entry: Entry, request: Request) {
      // 取源会话 ID
      const sourceID = request.sourceID
      // 无源：从头开始
      if (!sourceID) return 0
      // 查找源条目
      const source = entries.get(sourceID)
      // 复制操作
      const copy = Effect.gen(function* () {
        const record = source?.record ?? (yield* records.get(sourceID))
        // 执行分支复制
        return yield* branch(entry, request, record)
      })
      // 只在复制已定型的前缀期间持有源锁，绝不在辅助调用的推理期间持有。
      // Hold the source only while copying its settled prefix, never during side-call inference.
      if (!source) return yield* copy
      return yield* source.lock.withPermit(copy)
    })

    // 准备（prepare）：决定起始位置与是否续接
    const prepare = Effect.fn("ClaudeSessions.prepare")(function* (entry: Entry, request: Request) {
      // 先退役已退出或不兼容的进程：一旦续接其停靠的轮次，open() 不得替换它。
      // Retire an exited or incompatible process first: once we continue its parked turn, open() must not replace it.
      // A launch change waits for a parked turn to end: stopping it makes Claude Code record the waiting tool calls as
      // refused by the user. A step without tools (the step limit) still stops it, since the old process offers them.
      if (entry.process) {
        const parked = entry.process.waiting && entry.process.session.running && request.tools.length > 0
        const needsRestart = entry.process.session.ended || (entry.process.launch !== launch(request) && !parked)
        if (needsRestart) yield* stop(entry)
      }

      // 一次性请求：只做快照
      if (!request.sessionID) {
        const start = yield* snapshot(entry, request)
        return { start, continuation: undefined }
      }

      // 常驻请求：读取记录
      if (!entry.record) entry.record = yield* records.get(request.sessionID)
      // 计算同步决策
      const decision = SyncDecision.decide(request.prompt, entry.record)
      // 根据决策计算起始位置
      const start = yield* Effect.gen(function* () {
        // 全新或历史变化：停掉旧进程重来
        if (decision.kind === "fresh" || decision.kind === "changed") {
          yield* stop(entry)
          // 保存旧记录
          const previous = entry.record
          // 清空当前记录
          entry.record = undefined
          // 历史变化：尝试从安全边界分叉
          if (decision.kind === "changed") return yield* branch(entry, request, previous)
          // 全新且无旧记录：只做快照
          if (!previous) return yield* snapshot(entry, request)
          // 全新但有旧记录：从 0 开始
          return decision.start
        }
        // 已有进程或无记录：直接按决策起点继续
        if (entry.process || !entry.record) return decision.start
        // 记录指向的 Claude 会话 ID
        const sessionID = entry.record.claudeSessionID
        // 检查该原生会话是否还存在
        const exists = yield* attempt(() => input.io.sessionExists(sessionID))
        // 存在则继续
        if (exists) return decision.start
        // 不存在（被清理）：清空记录从头开始
        entry.record = undefined
        return 0
      })

      // 取当前进程
      const live = entry.process
      // 无进程、无运行中的轮次或不在等待工具结果：无需续接
      if (!live || !live.session.running || !live.waiting) return { start, continuation: undefined }
      // 从 start 开始收集工具结果
      const collected = yield* attemptSync(() => ToolResult.collect(request.prompt, start))
      // 构造续接信息
      const continuation: ToolContinuation = { end: collected.end, results: [] }
      // 遍历等待中的调用
      for (const id of live.waiting) {
        // 查找对应结果
        const result = collected.results.get(id)
        // 缺少某个结果：无法续接，停止进程重来
        if (!result) {
          yield* stop(entry)
          entry.record = undefined
          return { start: 0, continuation: undefined }
        }
        // 收集结果
        continuation.results.push({ id, result })
      }
      // 有工具被中止时
      if (collected.aborted) {
        // 被停止的 OpenCode 轮次需要全新的 Claude 轮次；addUser 只会“引导”旧轮次。
        // A stopped OpenCode turn needs a fresh Claude turn; addUser would only steer the old one.
        // After a launch change it also needs a new process.
        yield* live.launch === launch(request) ? interrupt(entry) : stop(entry)
        return { start, continuation: undefined }
      }
      // 返回起始位置与续接信息
      return { start, continuation }
    })

    // 为请求选择（或创建）条目
    const entryFor = (request: Request) => {
      // 有会话 ID：常驻条目
      if (request.sessionID) {
        // 已存在则复用
        const existing = entries.get(request.sessionID)
        if (existing) return existing
        // 否则创建并登记
        const entry: Entry = { lock: Semaphore.makeUnsafe(1) }
        entries.set(request.sessionID, entry)
        return entry
      }
      // 无会话 ID：临时条目
      const entry: Entry = { lock: Semaphore.makeUnsafe(1) }
      temporary.add(entry)
      return entry
    }

    // 运行一次请求（对外主入口）
    const run = Effect.fn("ClaudeSessions.run")(function* (request: Request) {
      // 选择条目
      const entry = entryFor(request)
      // 在条目的锁内串行执行
      yield* entry.lock.withPermit(
        Effect.gen(function* () {
          // 已有空闲定时器则先取消
          if (entry.idle) {
            yield* Fiber.interrupt(entry.idle)
            entry.idle = undefined
          }
          // 记录当前 fiber（供关闭时中断）
          entry.active = yield* Effect.withFiber(Effect.succeed)
          // 准备（同步决策/续接）
          const prepared = yield* prepare(entry, request)
          // 执行轮次
          yield* turn(entry, request, prepared.start, prepared.continuation)
          // 结束后释放条目
        }).pipe(Effect.ensuring(release(entry, request))),
      )
    })

    // 标记会话空闲（OpenCode 侧停止运行时调用）
    const idle = Effect.fn("ClaudeSessions.idle")(function* (sessionID: string) {
      // 查找条目
      const entry = entries.get(sessionID)
      // 其他进程已有定时器；运行中的请求结束时也会启动定时器，因此只处理“停靠且无活动请求”的情况
      // Other processes already have a timer, and a running request starts one when it ends.
      if (!entry?.process?.waiting || entry.active) return
      // 武装空闲回收
      yield* armIdle(entry)
    })

    // 返回注册表接口
    return { run, idle } satisfies Interface
  })

  // 返回注册表本身：附着与关闭
  return { attach, close }
}
