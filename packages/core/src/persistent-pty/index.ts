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
  type DaemonTransport,
  type Role,
  type SubscribeInput,
  type WireResponse,
  type WireTerminal,
} from "./daemon.js"
// 引入按运行时解析 PTY 二进制路径的函数（Bun/Node/workerd 各有实现）
import { resolveBinary } from "#persistent-pty-binary"

// 再导出守护进程模块的角色与流事件类型
export type { Role, StreamEvent } from "./daemon.js"
// 再导出交接（Handoff）类型
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

// 不可用错误：当前运行时或守护进程不可用
export class UnavailableError extends Schema.TaggedError<UnavailableError>()("PersistentPty.UnavailableError", {
  message: Schema.String,
}) {}

// 未找到错误：指定 ID 的持久化终端不存在
export class NotFoundError extends Schema.TaggedError<NotFoundError>()("PersistentPty.NotFoundError", {
  ptyID: Pty.ID,
}) {}

// 无效工作目录错误：创建终端时 cwd 不是目录
export class InvalidCwdError extends Schema.TaggedError<InvalidCwdError>()("PersistentPty.InvalidCwdError", {
  cwd: Schema.String,
  message: Schema.String,
}) {}

// 特性不支持错误：守护进程版本过旧，缺少所需特性
export class UnsupportedError extends Schema.TaggedError<UnsupportedError>()("PersistentPty.UnsupportedError", {
  feature: Schema.String,
}) {}

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
  // rename：重命名终端标题
  readonly rename: (
    id: Pty.ID,
    title: string | null,
  ) => Effect.Effect<Info, NotFoundError | UnsupportedError | UnavailableError>
  // snapshot：获取终端屏幕快照
  readonly snapshot: (id: Pty.ID) => Effect.Effect<Snapshot, NotFoundError | UnavailableError>
  // read：读取会话当前终端的屏幕行
  readonly read: (sessionID: Session.ID, lines?: number) => Effect.Effect<ReadResult | null, UnavailableError>
  // remove：终止并移除终端
  readonly remove: (id: Pty.ID) => Effect.Effect<void, NotFoundError | UnavailableError>
  // shutdown：关闭守护进程
  readonly shutdown: () => Effect.Effect<void, UnavailableError>
  // handoff：申请重启交接票据
  readonly handoff: () => Effect.Effect<Handoff | null, UnavailableError>
  // attach：订阅终端输出流
  readonly attach: (
    id: Pty.ID,
    input: SubscribeInput,
  ) => Effect.Effect<Attachment, NotFoundError | UnavailableError>
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
        // 向守护进程请求终端列表（未运行则得到 undefined）
        const response = yield* optionalRequest(daemon, { op: "list" })
        // 守护进程未运行：返回空列表
        if (!response) return []
        // 应答类型不符则报错
        if (response.type !== "terminals") return yield* unexpected(response)
        // 转换为 Info 并按会话 ID 过滤
        return response.terminals
          .map(toInfo)
          .filter((terminal) => sessionID === undefined || terminal.sessionID === sessionID)
      })

      // get：按 ID 获取单个终端信息
      const get = Effect.fn("PersistentPty.get")(function* (id: Pty.ID) {
        // 从列表中查找目标终端
        const found = (yield* list()).find((terminal) => terminal.id === id)
        // 不存在则抛出未找到错误
        if (!found) return yield* new NotFoundError({ ptyID: id })
        // 返回找到的终端
        return found
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
            op: "create",
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
        // 转换终端信息
        const terminal = toInfo(response.terminal)
        // 发布"终端已添加"事件
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

      // resize：调整终端尺寸；更新会话选中状态
      const resize = Effect.fn("PersistentPty.resize")((id: Pty.ID, cols: number, rows: number, attachmentID?: string) =>
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
        // Daemons without the feature drop the connection on unknown requests.
        // 守护进程不支持 rename 特性时（旧版本会直接断连）先探测，避免误伤
        if (!(yield* daemon.supports("rename").pipe(Effect.mapError(unavailable))))
          return yield* new UnsupportedError({ feature: "rename" })
        // 发送重命名请求
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
          info: toInfo(response.terminal),
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
        // 转换终端信息
        const info = toInfo(response.terminal)
        // 组装读取结果：屏幕文本（按行拼接）与尺寸/光标
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

      // shutdown：关闭守护进程并清空会话选中映射
      const shutdown = Effect.fn("PersistentPty.shutdown")(function* () {
        // 请求关闭（守护进程未运行则得到 undefined）
        const response = yield* daemon.shutdown.pipe(Effect.mapError(unavailable))
        // 清空会话选中映射
        current.clear()
        // 本来就没运行，直接完成
        if (!response) return
        // 应答必须是 ok
        if (response.type !== "ok") return yield* unexpected(response)
      })

      // handoff：获取交接票据（服务重启时转移终端所有权）
      const handoff = Effect.fn("PersistentPty.handoff")(() => daemon.handoff.pipe(Effect.mapError(unavailable)))

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
        // 控制者附件会更新会话的当前终端映射
        if (attachment.role === "controller") current.set(attachment.terminal.group_id, id)
        // 组装上层附件对象
        return {
          info: toInfo(attachment.terminal),
          role: attachment.role,
          generation: attachment.generation,
          replay: attachment.replay,
          activate: attachment.activate,
          detach: attachment.detach,
        }
      })

      // 用上述实现组装服务实例
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
        attach,
      })
    }),
  )

// 默认服务层（无自定义选项）
export const layer = makeLayer()
// configured：按选项构建全局单例节点（依赖 Bus 与 Global 节点）
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

// unexpected：构造"意外应答类型"的失败 Effect
const unexpected = (response: WireResponse) =>
  Effect.fail(new UnavailableError({ message: `unexpected opencode-pty response: ${response.type}` }))

// unavailable：把任意错误包装为 UnavailableError（保留原始消息）
const unavailable = (error: unknown) =>
  new UnavailableError({ message: error instanceof Error ? error.message : String(error) })

// toInfo：把守护进程的终端描述（WireTerminal）转换为上层 Info
function toInfo(value: WireTerminal): Info {
  // 取生命周期状态
  const status = value.lifecycle.status
  // 构造 Info：基础字段 + 持久化终端专有字段
  return {
    ...Pty.Info.make({
      // 对外的终端 ID
      id: toID(value.id),
      // 终端标题
      title: value.title,
      // 命令本体（第一个元素）
      command: value.command[0] || "",
      // 参数（其余元素）
      args: value.command.slice(1),
      // 工作目录
      cwd: value.cwd,
      // 状态：running 或 exited
      status: status === "running" ? "running" : "exited",
      // PID（缺失时用 0 占位）
      pid: value.pid ?? 0,
      // 已退出时带上退出码（null 视为 undefined）
      ...(status === "exited" ? { exitCode: value.lifecycle.exit_code ?? undefined } : {}),
    }),
    // 归属会话 ID
    sessionID: value.group_id,
    // 用户自定义标题（缺省 null）
    userTitle: value.user_title ?? null,
    // 前台进程名称
    foregroundProcess: value.foreground_process,
    // 终端尺寸
    size: { cols: value.cols, rows: value.rows },
    // 输出缓冲区的头尾偏移
    output: { head: value.output_head, tail: value.output_tail },
  }
}

// toID：把数字终端 ID 转换为对外的 Pty.ID 字符串（加固定前缀）
function toID(value: number) {
  return Pty.ID.make(`pty_persistent_${value}`)
}

// fromID：把 Pty.ID 解析回数字终端 ID（校验前缀与数值合法性）
function fromID(value: Pty.ID) {
  // 前缀不符则非法
  if (!value.startsWith("pty_persistent_")) throw new Error(`invalid persistent PTY ID: ${value}`)
  // 截取数字部分解析
  const parsed = Number(value.slice("pty_persistent_".length))
  // 必须是安全正整数
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`invalid persistent PTY ID: ${value}`)
  // 返回数字 ID
  return parsed
}
