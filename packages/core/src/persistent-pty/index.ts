// 以命名空间方式整体导出本模块
export * as PersistentPty from "./index.js"

// 引入文件系统 stat（检查工作目录）
import { stat } from "node:fs/promises"
// 引入 Node 的 path 模块（路径拼接与解析）
import path from "node:path"
// 引入 Effect 核心模块：Context（服务上下文）、Effect（副作用容器）、Layer（依赖注入层）、Schema（校验）、Stream（流）
import { Context, Effect, Layer, Schema, Stream } from "effect"
// 引入"全局单例节点"构造工具
import { makeGlobalNode } from "@opencode/util/effect/app-node"
// 引入持久化 PTY 的 schema：Added/Updated/Removed 事件、Handoff 交接、ReadLines 行数限制、ReadResult 读取结果
import {
  Added,
  Handoff,
  PersistentPty,
  ReadLines,
  Removed,
  Updated,
  type ReadResult,
} from "@opencode/schema/persistent-pty"
// 引入会话 ID schema
import { Session } from "@opencode/schema/session"
// 引入会话事件 schema（订阅会话删除）
import { SessionEvent } from "@opencode/schema/session-event"
// 引入事件总线服务
import { Bus } from "../bus.js"
// 引入 PTY 相关 schema（Pty.ID、Pty.Info）
import { Pty } from "@opencode/schema/pty"
// 引入全局状态服务（state 目录、bin 路径）
import { Global } from "@opencode/util/global"
// 引入 shell 选择逻辑（默认终端程序）
import { ShellSelect } from "../shell/select.js"
// 引入守护进程传输层及其相关类型
import {
  makeDaemonTransport,
  type DaemonAttachment,
  type DaemonError,
  type DaemonTransport,
  type Exited,
  type Metadata,
  type ProcessInfo,
  type Role,
  type Signal,
  type SubscribeInput,
  type WireResponse,
} from "./daemon.js"
// 引入按运行时解析 PTY 二进制路径的函数（Bun/Node/workerd 各有实现）
import { resolveBinary } from "#persistent-pty-binary"

export type { Metadata, Role, Signal, StreamEvent } from "./daemon.js"
export { Handoff } from "@opencode/schema/persistent-pty"
// 再导出当前运行时是否支持持久化 PTY 的标记
export { available } from "#persistent-pty-binary"

// 服务选项 schema
export const Options = Schema.Struct({
  // 可选：重启时的交接信息
  handoff: Schema.optional(Handoff),
  /** Parent of per-server daemon runtime directories; defaults to `<state>/pty`. */
  // 可选：守护进程运行时目录的父目录，默认为 <state>/pty
  root: Schema.optional(Schema.String),
})
// Options 的 TypeScript 类型
export type Options = typeof Options.Type

// 终端信息类型（复用 schema 包中的定义）
export type Info = PersistentPty.Info

// 终端快照类型（复用 schema 包中的定义）
export type Snapshot = PersistentPty.Snapshot

// 附件类型：面向上层的订阅句柄（终端信息、角色、世代、重放数据、激活/分离操作）
export type Attachment = {
  readonly info: Info
  readonly role: Role
  readonly generation: number
  readonly replay: DaemonAttachment["replay"]
  readonly activate: () => void
  readonly detach: () => void
}

/** The daemon could not be reached or started; the request never ran. */
export class UnavailableError extends Schema.TaggedError<UnavailableError>()("PersistentPty.UnavailableError", {
  message: Schema.String,
}) {}

/** The daemon rejected the request, or its reply was lost after it was sent, so it may have run. */
export class RequestError extends Schema.TaggedError<RequestError>()("PersistentPty.RequestError", {
  message: Schema.String,
}) {}

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("PersistentPty.NotFoundError", {
  ptyID: Pty.ID,
}) {}

export class ProcessNotFoundError extends Schema.TaggedError<ProcessNotFoundError>()(
  "PersistentPty.ProcessNotFoundError",
  { processID: Schema.Number },
) {}

export class InvalidCwdError extends Schema.TaggedError<InvalidCwdError>()("PersistentPty.InvalidCwdError", {
  cwd: Schema.String,
  message: Schema.String,
}) {}

/** A non-PTY process run by the daemon, its output written to `outputPath`. */
export type PipeInfo = {
  readonly id: number
  readonly pid: number | undefined
  readonly command: readonly string[]
  readonly cwd: string
  readonly groupID: string
  readonly lifecycle:
    | { readonly status: "running" }
    | { readonly status: "exited"; readonly exitCode: number | undefined; readonly signal: string | undefined }
    | { readonly status: "failed"; readonly message: string }
  /** Bytes counted so far; the file can hold a little more. Pair only bytes up to here with `outputLines`. */
  readonly outputTail: number
  readonly outputLines: number
  readonly outputPath: string
  readonly outputError: string | undefined
  readonly metadata: Metadata
  readonly startedAt: number
  readonly exitedAt: number | undefined
}

export type PipeExit = {
  readonly exitCode: number | undefined
  readonly signal: string | undefined
  /** Runs past the file's size when `outputError` is set; use the file's real size instead. */
  readonly finalOffset: number
  readonly outputLines: number
  readonly outputError: string | undefined
  readonly exitedAt: number
}

export type CreatePipeInput = {
  readonly program: string
  readonly args: readonly string[]
  /** Absolute. */
  readonly cwd: string
  /** The child's whole environment; the daemon's own is not inherited. */
  readonly env: Readonly<Record<string, string>>
  readonly groupID: string
  /** Absolute; truncated on open, symlinks refused. */
  readonly outputPath: string
  readonly metadata: Metadata
}

// 服务接口：持久化终端的全部操作
export interface Interface {
  // list：列出终端（可按会话过滤）
  readonly list: (sessionID?: Session.ID) => Effect.Effect<Info[], UnavailableError>
  // get：按 ID 获取终端
  readonly get: (id: Pty.ID) => Effect.Effect<Info, NotFoundError | UnavailableError>
  // create：在会话中创建新终端
  readonly create: (
    sessionID: Session.ID,
    input: {
      readonly command?: string
      readonly args: readonly string[]
      readonly cwd?: string
      readonly title: string
      readonly env: Readonly<Record<string, string>>
      readonly cols?: number
      readonly rows?: number
    },
  ) => Effect.Effect<Info, InvalidCwdError | UnavailableError>
  // write：向终端写入数据
  readonly write: (
    id: Pty.ID,
    data: string,
    attachmentID?: string,
  ) => Effect.Effect<void, NotFoundError | UnavailableError>
  // resize：调整终端尺寸
  readonly resize: (
    id: Pty.ID,
    cols: number,
    rows: number,
    attachmentID?: string,
  ) => Effect.Effect<void, NotFoundError | UnavailableError>
  // control：控制器专用的尺寸调整
  readonly control: (
    id: Pty.ID,
    attachmentID: string,
    cols: number,
    rows: number,
  ) => Effect.Effect<void, NotFoundError | UnavailableError>
  // input：写入输入数据并同步尺寸（控制者路径）
  readonly input: (
    id: Pty.ID,
    attachmentID: string,
    cols: number,
    rows: number,
    data: Uint8Array,
  ) => Effect.Effect<void, NotFoundError | UnavailableError>
  readonly rename: (id: Pty.ID, title: string | null) => Effect.Effect<Info, NotFoundError | UnavailableError>
  readonly snapshot: (id: Pty.ID) => Effect.Effect<Snapshot, NotFoundError | UnavailableError>
  // read：读取会话当前终端的屏幕行
  readonly read: (sessionID: Session.ID, lines?: number) => Effect.Effect<ReadResult | null, UnavailableError>
  // remove：终止并移除终端
  readonly remove: (id: Pty.ID) => Effect.Effect<void, NotFoundError | UnavailableError>
  // shutdown：关闭守护进程
  readonly shutdown: () => Effect.Effect<void, UnavailableError>
  // handoff：申请重启交接票据
  readonly handoff: () => Effect.Effect<Handoff | null, UnavailableError>
  /**
   * Whether a handoff to the next server is prepared and its ticket still valid: this server is being replaced, so
   * the daemon's processes should be left running for the next one. A shutdown clears it.
   */
  readonly handoffPrepared: () => boolean
  readonly attach: (id: Pty.ID, input: SubscribeInput) => Effect.Effect<Attachment, NotFoundError | UnavailableError>
  /** Starts the daemon if needed. Fall back to another spawner only on `UnavailableError`. */
  readonly createPipe: (input: CreatePipeInput) => Effect.Effect<PipeInfo, UnavailableError | RequestError>
  /** Resolves when the process exits, on its own connection with no timeout; interrupting closes it. */
  readonly waitPipe: (id: number) => Effect.Effect<PipeExit, UnavailableError | RequestError>
  /** `ProcessNotFoundError` for an unknown id, a PTY, or when no daemon is running. */
  readonly getPipe: (id: number) => Effect.Effect<PipeInfo, ProcessNotFoundError | UnavailableError>
  /** Signals the process group without forgetting the process; `waitPipe` then reports the signal. */
  readonly signalPipe: (id: number, signal: Signal) => Effect.Effect<void, UnavailableError | RequestError>
  /** Replaces the stored metadata. */
  readonly setPipeMetadata: (id: number, metadata: Metadata) => Effect.Effect<void, UnavailableError | RequestError>
  /** Kills the process if it still runs and forgets it; the output file is left alone. */
  readonly terminatePipe: (id: number) => Effect.Effect<void, UnavailableError | RequestError>
  /** Never starts the daemon; empty when none is running. */
  readonly listPipes: () => Effect.Effect<PipeInfo[], UnavailableError | RequestError>
}

// Effect 服务类：以 Context.Tag 标识为 "@opencode/PersistentPty"
export class Service extends Context.Service<Service, Interface>()("@opencode/PersistentPty") {}

// 构建服务层（Layer）的工厂函数：注入依赖并实现全部操作
const makeLayer = (options: Options = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      // 获取事件总线服务
      const bus = yield* Bus.Service
      // 获取全局状态服务（state 目录、bin 路径）
      const global = yield* Global.Service
      // 获取当前 Effect 上下文
      const context = yield* Effect.context()
      // 用该上下文构造"立即在后台运行"的 fork 函数
      const runFork = Effect.runForkWith(context)
      // PTY 二进制路径解析的惰性缓存（失败时会重置以便重试）
      let binary: Promise<string> | undefined
      // 创建守护进程传输层；运行时目录默认 <state>/pty/<uuid>；错误统一转为 UnavailableError
      const daemon = yield* makeDaemonTransport(
        options.root ?? path.join(global.state, "pty"),
        crypto.randomUUID(),
        () =>
          // 惰性解析二进制路径；失败时重置缓存以便下次重试
          (binary ??= resolveBinary(global.bin).catch((error) => {
            binary = undefined
            throw error
          })),
        options.handoff,
      ).pipe(Effect.mapError(unavailable))
      // 正在移除的终端 ID 集合（防止重复触发移除）
      const removing = new Set<Pty.ID>()
      // Controller activity selects a terminal; observer reads and pane visibility do not.
      // 各会话当前选中的终端（仅控制器活动会更新；观察者读取与面板可见性不会）
      const current = new Map<Session.ID, Pty.ID>()

      // list：列出持久化终端（可按会话过滤）；守护进程未运行时返回空数组
      const list = Effect.fn("PersistentPty.list")(function* (sessionID?: Session.ID) {
        const response = yield* optionalRequest(daemon, { op: "list", mode: "pty" })
        if (!response) return []
        if (response.type !== "processes") return yield* unexpected(response)
        return response.processes
          .map(toInfo)
          .filter((terminal) => sessionID === undefined || terminal.sessionID === sessionID)
      })

      // get：按 ID 获取单个终端信息
      const get = Effect.fn("PersistentPty.get")(function* (id: Pty.ID) {
        // Any ID that is not one of ours names no terminal; every other method looks the terminal up here first.
        const parsed = parseID(id)
        const found =
          parsed === undefined ? undefined : yield* lookup(daemon, parsed).pipe(Effect.mapError(unavailable))
        if (found?.mode !== "pty") return yield* new NotFoundError({ ptyID: id })
        return toInfo(found)
      })

      // create：在会话中创建新的持久化终端
      const create = Effect.fn("PersistentPty.create")(function* (
        sessionID: Session.ID,
        input: Parameters<Interface["create"]>[1],
      ) {
        // 解析工作目录（缺省为根目录）
        const cwd = path.resolve(input.cwd ?? "/")
        // opencode-pty's PTY library silently falls back to $HOME when the cwd is not a directory.
        // 预先检查 cwd 是否为目录（否则守护进程的 PTY 库会静默回退到 $HOME）
        const directory = yield* Effect.promise(() =>
          stat(cwd).then(
            (info) => info.isDirectory(),
            () => false,
          ),
        )
        // 不是目录则抛出无效工作目录错误
        if (!directory) return yield* new InvalidCwdError({ cwd, message: `cwd is not a directory: ${cwd}` })
        // 请求守护进程创建终端（允许按需启动守护进程）；默认尺寸 80x24
        const response = yield* request(
          daemon,
          {
            op: "create_pty",
            program: input.command ?? ShellSelect.environment(global.bin),
            args: input.args,
            cwd,
            title: input.title,
            group_id: sessionID,
            env: input.env,
            cols: input.cols ?? 80,
            rows: input.rows ?? 24,
          },
          true,
        )
        // 应答类型必须是 created
        if (response.type !== "created") return yield* unexpected(response)
        const terminal = toInfo(response.process)
        yield* bus.publish(Added, { sessionID, terminal })
        // 返回新终端信息
        return terminal
      })

      // Sends a terminal command that answers "ok"; `select` marks the terminal as its session's current one.
      // command：发送一个应答为 "ok" 的终端命令；select 为真时把该终端标记为其会话的当前终端
      const command = (id: Pty.ID, op: string, body: object, select: boolean) =>
        Effect.gen(function* () {
          // 先确认终端存在
          const terminal = yield* get(id)
          // 发送命令
          const response = yield* request(daemon, { op, id: fromID(id), ...body })
          // 应答必须是 ok
          if (response.type !== "ok") return yield* unexpected(response)
          // 按需更新会话的当前终端映射
          if (select) current.set(terminal.sessionID, id)
        })

      // write：向终端写入数据（base64 编码传输）；不改变会话选中状态
      const write = Effect.fn("PersistentPty.write")((id: Pty.ID, data: string, attachmentID?: string) =>
        command(
          id,
          "write",
          { attachment_id: attachmentID ?? null, data_base64: Buffer.from(data).toString("base64") },
          false,
        ),
      )

      const resize = Effect.fn("PersistentPty.resize")(
        (id: Pty.ID, cols: number, rows: number, attachmentID?: string) =>
          command(id, "resize", { attachment_id: attachmentID ?? null, cols, rows }, true),
      )

      // control：控制器（controller）专用的尺寸调整（必须携带附件 ID）
      const control = Effect.fn("PersistentPty.control")(
        (id: Pty.ID, attachmentID: string, cols: number, rows: number) =>
          command(id, "control", { attachment_id: attachmentID, cols, rows }, true),
      )

      // input：写入输入数据并同步调整尺寸（控制者路径）
      const input = Effect.fn("PersistentPty.input")(
        (id: Pty.ID, attachmentID: string, cols: number, rows: number, data: Uint8Array) =>
          command(
            id,
            "input",
            { attachment_id: attachmentID, cols, rows, data_base64: Buffer.from(data).toString("base64") },
            true,
          ),
      )

      // rename：重命名终端标题（null 表示恢复默认）
      const rename = Effect.fn("PersistentPty.rename")(function* (id: Pty.ID, title: string | null) {
        // 先确认终端存在
        const terminal = yield* get(id)
        const response = yield* request(daemon, { op: "rename", id: fromID(id), title })
        // 应答必须是 ok
        if (response.type !== "ok") return yield* unexpected(response)
        // 重新获取重命名后的终端信息
        const renamed = yield* get(id)
        // 发布"终端已更新"事件
        yield* bus.publish(Updated, { sessionID: terminal.sessionID, terminal: renamed })
        // 返回重命名后的信息
        return renamed
      })

      // snapshot：获取终端快照（屏幕文本、检查点与光标位置）
      const snapshot = Effect.fn("PersistentPty.snapshot")(function* (id: Pty.ID) {
        // 确认终端存在
        yield* get(id)
        // 请求快照
        const response = yield* request(daemon, { op: "snapshot", id: fromID(id) })
        // 应答类型必须是 snapshot
        if (response.type !== "snapshot") return yield* unexpected(response)
        // 组装快照结果（base64 检查点解码为字节）
        return {
          info: toInfo(response.process),
          text: response.text,
          checkpoint: Buffer.from(response.checkpoint_base64, "base64"),
          cursor: { x: response.cursor_x, y: response.cursor_y },
        }
      })

      // read：读取会话当前终端的屏幕行（供 AI/界面读取）
      const read = Effect.fn("PersistentPty.read")(function* (sessionID: Session.ID, lines?: number) {
        // lines 必须是 1..65535 的整数（ReadLines schema 校验）
        if (lines !== undefined && !Schema.is(ReadLines)(lines))
          return yield* new UnavailableError({ message: "lines must be an integer between 1 and 65535" })
        // 取会话当前选中的终端
        const id = current.get(sessionID)
        // 没有选中终端则返回 null
        if (!id) return null
        // 获取终端信息；已被删除时按 null 处理
        const terminal = yield* get(id).pipe(Effect.catchTag("PersistentPty.NotFoundError", () => Effect.succeed(null)))
        // 终端不存在或不属于该会话：清理映射并返回 null
        if (!terminal || terminal.sessionID !== sessionID) {
          // 映射仍指向该终端时删除
          if (current.get(sessionID) === id) current.delete(sessionID)
          return null
        }
        // Let the daemon choose the live height in the same snapshot when lines is omitted.
        // 请求读取屏幕行；lines 缺省时由守护进程按当前快照的实时高度决定
        const response = yield* request(daemon, { op: "read_rows", id: fromID(id), rows: lines })
        // 应答类型必须是 rows
        if (response.type !== "rows") return yield* unexpected(response)
        const info = toInfo(response.process)
        return {
          ptyID: info.id,
          title: info.title,
          cwd: info.cwd,
          foregroundProcess: info.foregroundProcess,
          screen: {
            text: response.lines.join("\n"),
            cols: info.size.cols,
            rows: info.size.rows,
            cursor: { x: response.cursor_x, y: response.cursor_y },
          },
        }
      })

      // remove：终止并移除终端
      const remove = Effect.fn("PersistentPty.remove")(function* (id: Pty.ID) {
        // 确认终端存在
        const terminal = yield* get(id)
        // 发送终止请求
        const response = yield* request(daemon, { op: "terminate", id: fromID(id) })
        // 应答必须是 ok
        if (response.type !== "ok") return yield* unexpected(response)
        // 清理会话选中映射（若指向被移除的终端）
        if (current.get(terminal.sessionID) === id) current.delete(terminal.sessionID)
        // 发布"终端已移除"事件
        yield* bus.publish(Removed, { sessionID: terminal.sessionID, ptyID: id })
        return undefined
      })

      // When the prepared handoff's ticket expires; 0 when none is prepared.
      let handoffExpiresAt = 0

      const shutdown = Effect.fn("PersistentPty.shutdown")(function* () {
        handoffExpiresAt = 0
        const response = yield* daemon.shutdown.pipe(Effect.mapError(unavailable))
        // 清空会话选中映射
        current.clear()
        // 本来就没运行，直接完成
        if (!response) return
        // 应答必须是 ok
        if (response.type !== "ok") return yield* unexpected(response)
      })

      const handoff = Effect.fn("PersistentPty.handoff")(function* () {
        const prepared = yield* daemon.handoff.pipe(Effect.mapError(unavailable))
        if (prepared) handoffExpiresAt = prepared.expiresAt
        return prepared
      })

      // removeVisibleExit：移除"已退出但界面仍可见"的终端（后台执行，按 ID 去重）
      const removeVisibleExit = (id: Pty.ID) => {
        // 已在移除中则跳过
        if (removing.has(id)) return
        // 标记为移除中
        removing.add(id)
        // 在后台 fork 执行移除
        runFork(
          remove(id).pipe(
            // 未找到视为已经移除；不可用则记警告日志
            Effect.catchTags({
              "PersistentPty.NotFoundError": () => Effect.void,
              "PersistentPty.UnavailableError": (error) =>
                Effect.logWarning("failed to remove visible exited terminal", { id, error: error.message }),
            }),
            // 无论成败都清除"移除中"标记
            Effect.ensuring(Effect.sync(() => removing.delete(id))),
          ),
        )
      }

      // removeSession：移除某个会话名下的全部终端
      const removeSession = (sessionID: Session.ID) =>
        list(sessionID).pipe(
          // 逐个移除该会话的终端
          Effect.flatMap((terminals) =>
            Effect.forEach(
              terminals,
              (terminal) =>
                remove(terminal.id).pipe(
                  // 未找到视为已移除；不可用则记警告
                  Effect.catchTags({
                    "PersistentPty.NotFoundError": () => Effect.void,
                    "PersistentPty.UnavailableError": (error) =>
                      Effect.logWarning("failed to remove deleted session's terminal", {
                        sessionID,
                        id: terminal.id,
                        error: error.message,
                      }),
                  }),
                ),
              { discard: true },
            ),
          ),
          // 列表失败仅记警告（守护进程可能已不可用）
          Effect.catchTag("PersistentPty.UnavailableError", (error) =>
            Effect.logWarning("failed to list deleted session's terminals", { sessionID, error: error.message }),
          ),
          // 最后清空该会话的选中映射
          Effect.ensuring(Effect.sync(() => current.delete(sessionID))),
        )

      // Errors are handled per event so one failed cleanup does not end the subscription.
      // 订阅"会话删除"事件：级联移除该会话的终端（错误在单个事件内消化，不会终止订阅）
      yield* bus.subscribe(SessionEvent.Deleted).pipe(
        Stream.runForEach((event) => removeSession(event.data.sessionID)),
        // 立即启动并绑定当前作用域
        Effect.forkScoped({ startImmediately: true }),
      )

      // attach：订阅终端输出流并返回附件
      const attach = Effect.fn("PersistentPty.attach")(function* (
        id: Pty.ID,
        input: Parameters<Interface["attach"]>[1],
      ) {
        // 确认终端存在
        yield* get(id)
        // 向守护进程订阅；包装事件回调以处理退出清理
        const attachment = yield* daemon
          .subscribe(fromID(id), {
            ...input,
            onEvent: (event) => {
              // 退出事件：安排移除界面上的已退出终端
              if (event.type === "exited") removeVisibleExit(id)
              // 继续转发事件给客户端回调
              input.onEvent(event)
            },
          })
          .pipe(Effect.mapError(unavailable))
        const info = toInfo(attachment.terminal)
        if (attachment.role === "controller") current.set(info.sessionID, id)
        return {
          info,
          role: attachment.role,
          generation: attachment.generation,
          replay: attachment.replay,
          activate: attachment.activate,
          detach: attachment.detach,
        }
      })

      const createPipe = Effect.fn("PersistentPty.createPipe")(function* (input: CreatePipeInput) {
        const response = yield* daemon
          .request(
            {
              op: "create_pipe",
              program: input.program,
              args: input.args,
              cwd: input.cwd,
              env: input.env,
              group_id: input.groupID,
              output_path: input.outputPath,
              metadata: input.metadata,
            },
            true,
          )
          .pipe(Effect.mapError(pipeError))
        if (response.type !== "created") return yield* unexpectedPipe(response)
        return toPipeInfo(response.process)
      })

      const waitPipe = Effect.fn("PersistentPty.waitPipe")(function* (id: number) {
        return toPipeExit(yield* daemon.wait(id).pipe(Effect.mapError(pipeError)))
      })

      const getPipe = Effect.fn("PersistentPty.getPipe")(function* (id: number) {
        const found = yield* lookup(daemon, id).pipe(Effect.mapError(unavailable))
        if (found?.mode !== "pipe") return yield* new ProcessNotFoundError({ processID: id })
        return toPipeInfo(found)
      })

      const pipeCommand = (value: object) =>
        Effect.gen(function* () {
          const response = yield* daemon.request(value).pipe(Effect.mapError(pipeError))
          if (response.type !== "ok") return yield* unexpectedPipe(response)
        })

      const signalPipe = Effect.fn("PersistentPty.signalPipe")((id: number, signal: Signal) =>
        pipeCommand({ op: "signal", id, signal }),
      )

      const setPipeMetadata = Effect.fn("PersistentPty.setPipeMetadata")((id: number, metadata: Metadata) =>
        pipeCommand({ op: "set_metadata", id, metadata }),
      )

      const terminatePipe = Effect.fn("PersistentPty.terminatePipe")((id: number) =>
        pipeCommand({ op: "terminate", id }),
      )

      const listPipes = Effect.fn("PersistentPty.listPipes")(function* () {
        const response = yield* daemon.requestIfRunning({ op: "list", mode: "pipe" }).pipe(Effect.mapError(pipeError))
        if (!response) return []
        if (response.type !== "processes") return yield* unexpectedPipe(response)
        return response.processes.map(toPipeInfo)
      })

      return Service.of({
        list,
        get,
        create,
        write,
        resize,
        control,
        input,
        rename,
        snapshot,
        read,
        remove,
        shutdown,
        handoff,
        handoffPrepared: () => Date.now() < handoffExpiresAt,
        attach,
        createPipe,
        waitPipe,
        getPipe,
        signalPipe,
        setPipeMetadata,
        terminatePipe,
        listPipes,
      })
    }),
  )

// 默认服务层（无自定义选项）
export const layer = makeLayer()
export const layerWith = (options: Options) => makeLayer(options)
export const configured = (options?: Options) =>
  makeGlobalNode({
    service: Service,
    layer: options === undefined ? layer : makeLayer(options),
    deps: [Bus.node, Global.node],
  })
// 默认导出的全局节点
export const node = configured()

// request：向守护进程发请求（可按需启动），错误统一转为 UnavailableError
const request = (daemon: DaemonTransport, value: object, start = false) =>
  daemon.request(value, start).pipe(Effect.mapError(unavailable))

// optionalRequest：仅在守护进程已运行时发请求，错误统一转为 UnavailableError
const optionalRequest = (daemon: DaemonTransport, value: object) =>
  daemon.requestIfRunning(value).pipe(Effect.mapError(unavailable))

// `get` fails only for an unknown id, and no running daemon has no processes.
const lookup = (daemon: DaemonTransport, id: number) =>
  daemon.requestIfRunning({ op: "get", id }).pipe(
    Effect.catchIf(
      (error) => error.kind === "request",
      () => Effect.succeed(undefined),
    ),
    Effect.flatMap((response) => {
      if (!response) return Effect.succeed(undefined)
      if (response.type !== "process")
        return Effect.fail(new Error(`unexpected opencode-pty response: ${response.type}`))
      return Effect.succeed(response.process)
    }),
  )

const unexpected = (response: WireResponse) =>
  Effect.fail(new UnavailableError({ message: `unexpected opencode-pty response: ${response.type}` }))

// unavailable：把任意错误包装为 UnavailableError（保留原始消息）
const unavailable = (error: unknown) =>
  new UnavailableError({ message: error instanceof Error ? error.message : String(error) })

// Only a failure before the request was sent is safe to retry somewhere else.
const pipeError = (error: DaemonError) =>
  error.kind === "request" || error.kind === "response"
    ? new RequestError({ message: error.message })
    : new UnavailableError({ message: error.message })

const unexpectedPipe = (response: WireResponse) =>
  Effect.fail(new RequestError({ message: `unexpected opencode-pty response: ${response.type}` }))

function toInfo(value: ProcessInfo): Info {
  if (!value.pty) throw new Error(`opencode-pty process ${value.id} is not a terminal`)
  const status = value.lifecycle.status
  // 构造 Info：基础字段 + 持久化终端专有字段
  return {
    ...Pty.Info.make({
      // 对外的终端 ID
      id: toID(value.id),
      title: value.pty.title,
      command: value.command[0] || "",
      // 参数（其余元素）
      args: value.command.slice(1),
      // 工作目录
      cwd: value.cwd,
      // 状态：running 或 exited
      status: status === "running" ? "running" : "exited",
      // PID（缺失时用 0 占位）
      pid: value.pid ?? 0,
      ...(value.lifecycle.status === "exited" ? { exitCode: value.lifecycle.exit_code ?? undefined } : {}),
    }),
    // Terminals are always created with a session ID as their group.
    sessionID: Session.ID.make(value.group_id),
    userTitle: value.pty.user_title,
    foregroundProcess: value.pty.foreground_process,
    size: { cols: value.pty.cols, rows: value.pty.rows },
    output: { head: value.output_head, tail: value.output_tail },
  }
}

function toPipeInfo(value: ProcessInfo): PipeInfo {
  if (!value.pipe) throw new Error(`opencode-pty process ${value.id} is not a pipe process`)
  return {
    id: value.id,
    pid: value.pid ?? undefined,
    command: value.command,
    cwd: value.cwd,
    groupID: value.group_id,
    lifecycle:
      value.lifecycle.status === "exited"
        ? {
            status: "exited",
            exitCode: value.lifecycle.exit_code ?? undefined,
            signal: value.lifecycle.signal ?? undefined,
          }
        : value.lifecycle,
    outputTail: value.output_tail,
    outputLines: value.pipe.output_lines,
    outputPath: value.pipe.output_path,
    outputError: value.pipe.output_error ?? undefined,
    metadata: value.pipe.metadata,
    startedAt: value.started_at,
    exitedAt: value.exited_at ?? undefined,
  }
}

function toPipeExit(value: Exited): PipeExit {
  return {
    exitCode: value.exit_code ?? undefined,
    signal: value.signal ?? undefined,
    finalOffset: value.final_offset,
    outputLines: value.output_lines ?? 0,
    outputError: value.output_error ?? undefined,
    exitedAt: value.exited_at,
  }
}

function toID(value: number) {
  return Pty.ID.make(`pty_persistent_${value}`)
}

function parseID(value: Pty.ID) {
  if (!value.startsWith("pty_persistent_")) return undefined
  const parsed = Number(value.slice("pty_persistent_".length))
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : undefined
}

function fromID(value: Pty.ID) {
  const parsed = parseID(value)
  if (parsed === undefined) throw new Error(`invalid persistent PTY ID: ${value}`)
  return parsed
}
