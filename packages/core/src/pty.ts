// 将本模块以命名空间（namespace）形式导出为 Pty
export * as Pty from "./pty.js"

// 导入用于构建 Effect 分层节点的辅助函数
import { makeLocationNode } from "@opencode/util/effect/app-node"
// 导入原生 PTY 实现的类型：Disp（可释放资源句柄）与 Proc（进程句柄）
import type { Disp, Proc } from "#pty"
// 从 effect 库导入上下文、Effect、Layer（层）、Schema 与类型工具
import { Context, Effect, Layer, Schema, Types } from "effect"
// 导入 Pty 的 schema 定义（ID、Info、事件等）
import { Pty } from "@opencode/schema/pty"
// 导入事件总线（Bus）服务，用于发布终端事件
import { Bus } from "./bus.js"
// 导入位置（Location）服务，用于获取当前工作目录
import { Location } from "./location.js"
// 导入 shell 选择服务，用于解析默认命令
import { ShellSelect } from "./shell/select.js"
// 导入惰性初始化（lazy）工具
import { lazy } from "./util/lazy.js"

// 输出缓冲区（buffer）上限：2MB，超过后裁剪旧内容
const BUFFER_LIMIT = 1024 * 1024 * 2
// Exited sessions stay observable (status, exit code, retained output) until removed explicitly.
// Cap retention so abandoned terminals do not accumulate unbounded buffers.
// 已退出的会话（session）在显式删除前保持可观察（状态、退出码、保留输出）
// 对保留数量设上限，避免被遗弃的终端无限累积缓冲
const EXITED_LIMIT = 25
// 惰性加载原生 PTY 模块（#pty），首次使用时才真正 import
const pty = lazy(() => import("#pty"))

// 订阅者（subscriber）类型：接收 PTY 输出与结束事件的回调载体
type Subscriber = {
  // 收到输出块（chunk）时的回调
  readonly onData: (chunk: string) => void
  // 会话结束时触发的回调，可能携带退出码（exitCode）
  readonly onEnd: (event: { exitCode?: number }) => void
  // 是否已激活（回放完成后开始实时推送）
  active: boolean
  // 是否已分离（detach），分离后不再接收任何数据
  detached: boolean
  // 激活前暂存的输出块队列
  pending: string[]
  // 若激活前会话已结束，缓存其结束事件以便激活时补发
  end?: { exitCode?: number }
}

// 活跃会话类型：聚合会话信息、进程与订阅状态
type Active = {
  // 对外展示的会话信息
  info: Info
  // 原生 PTY 进程句柄
  process: Proc
  // Retained output ending at cursor.
  // 以游标（cursor）为末尾保留的输出缓冲
  buffer: string
  // 输出游标：已产出的总字符数
  cursor: number
  // 订阅者表，键为不透明的 token 对象
  subscribers: Map<object, Subscriber>
  // 进程事件监听器的释放句柄列表
  listeners: Disp[]
}

// 转发导出 Pty schema 中的 ID 品牌类型（常量与类型同名惯用法）
export const ID = Pty.ID
export type ID = Pty.ID

// 转发导出会话信息 schema
export const Info = Pty.Info
// Info 的深层可变（DeepMutable）类型版本，便于内部就地更新字段
export type Info = Types.DeepMutable<typeof Info.Type>

// 转发导出创建输入 schema
export const CreateInput = Pty.CreateInput

// 创建输入的值类型
export type CreateInput = typeof CreateInput.Type

// 转发导出更新输入 schema
export const UpdateInput = Pty.UpdateInput

// 更新输入的值类型
export type UpdateInput = typeof UpdateInput.Type

// 转发导出 Pty 的事件定义
export { Event } from "@opencode/schema/pty"

// 附加（attach）输入参数类型
export type AttachInput = {
  // Absolute output cursor to replay from. -1 tails from the current end; omitted replays the full retained buffer.
  // 回放（replay）起始的绝对输出游标；-1 表示从当前末尾跟随，缺省则回放全部保留缓冲
  readonly cursor?: number
  // Callbacks fire synchronously from the native PTY data path; keep them non-blocking.
  // 数据回调会从原生 PTY 数据路径同步触发，必须保持非阻塞
  readonly onData: (chunk: string) => void
  // Fired once when the session stops producing output: process exit (exitCode set), removal, or service teardown.
  // 会话停止产出输出时触发一次：进程退出（带 exitCode）、会话被删除或服务关闭
  readonly onEnd: (event: { exitCode?: number }) => void
}

// 附加结果类型：回放内容 + 实时读写控制句柄
export type Attachment = {
  // Retained output from the requested cursor to the current end.
  // 从请求游标到当前末尾之间的保留输出
  readonly replay: string
  // Absolute output cursor after replay.
  // 回放完成后的绝对输出游标
  readonly cursor: number
  // 向终端写入数据
  readonly write: (data: string) => void
  // Starts live delivery after the caller has applied replay and cursor metadata.
  // 在调用方应用完回放与游标元数据后，开始实时投递
  readonly activate: () => void
  // 分离订阅，停止接收后续输出
  readonly detach: () => void
}

// 未找到指定终端会话时的标签错误（tagged error）
export class NotFoundError extends Schema.TaggedError<NotFoundError>()("Pty.NotFoundError", {
  ptyID: ID,
}) {}

// 会话已退出（不能再次附加）时的标签错误
export class ExitedError extends Schema.TaggedError<ExitedError>()("Pty.ExitedError", {
  ptyID: ID,
}) {}

// 服务接口：声明终端会话的全部操作能力
export interface Interface {
  // 列出所有会话信息
  readonly list: () => Effect.Effect<Info[]>
  // 按 ID 获取会话信息，未找到时报错
  readonly get: (id: ID) => Effect.Effect<Info, NotFoundError>
  // 创建新会话
  readonly create: (input: CreateInput) => Effect.Effect<Info>
  // 更新会话标题或尺寸
  readonly update: (id: ID, input: UpdateInput) => Effect.Effect<Info, NotFoundError>
  // 删除会话
  readonly remove: (id: ID) => Effect.Effect<void, NotFoundError>
  // 向会话写入数据
  readonly write: (id: ID, data: string) => Effect.Effect<void, NotFoundError>
  // 附加到会话，获得回放与实时订阅句柄
  readonly attach: (id: ID, input: AttachInput) => Effect.Effect<Attachment, NotFoundError | ExitedError>
}

// 定义 Pty 服务：将接口绑定到依赖注入上下文
export class Service extends Context.Service<Service, Interface>()("@opencode/Pty") {}

// 服务实现层：创建并管理所有终端会话
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 依赖注入：事件总线
    const bus = yield* Bus.Service
    // 依赖注入：位置服务
    const location = yield* Location.Service
    // 依赖注入：shell 选择服务
    const shell = yield* ShellSelect.Service
    // 捕获当前 Effect 上下文，便于在普通回调中运行 Effect
    const context = yield* Effect.context()
    // 构建可在任意回调里启动 Effect 的运行器（fork）
    const runFork = Effect.runForkWith(context)
    // 全部会话表：ID -> 活跃会话状态
    const sessions = new Map<ID, Active>()
    // 已退出会话的 ID 队列，按退出先后排序，用于淘汰最旧的
    const exitOrder: ID[] = []

    // 通知所有订阅者会话已结束
    function notifyEnd(session: Active, event: { exitCode?: number }) {
      // 遍历每个订阅者
      for (const subscriber of session.subscribers.values()) {
        // 尚未激活的订阅者先缓存结束事件，待激活时补发
        if (!subscriber.active) {
          subscriber.end = event
          continue
        }
        // 已激活的立即回调 onEnd，异常被吞掉以免影响其他订阅者
        try {
          subscriber.onEnd(event)
        } catch {}
      }
      // 清空订阅者表：会话结束后不再有订阅
      session.subscribers.clear()
    }

    // 拆除（teardown）会话：释放监听器、杀死仍在运行的进程并通知结束
    function teardown(session: Active) {
      // 逐个释放进程事件监听器
      for (const listener of session.listeners) listener.dispose()
      // 清空监听器列表
      session.listeners.length = 0
      // 若进程仍在运行则尝试杀死它
      if (session.info.status === "running") {
        try {
          session.process.kill()
        } catch {}
      }
      // 以无退出码的结束事件通知所有订阅者
      notifyEnd(session, {})
    }

    // 注册服务级终结器（finalizer）：服务停止时拆除并清空所有会话
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        // 拆除每个会话
        for (const session of sessions.values()) teardown(session)
        // 清空会话表
        sessions.clear()
        // 清空退出顺序队列
        exitOrder.length = 0
      }),
    )

    // 按 ID 查找会话的辅助 Effect；找不到则失败为 NotFoundError
    const requireSession = Effect.fn("Pty.requireSession")(function* (id: ID) {
      // 从会话表中取会话
      const session = sessions.get(id)
      // 不存在则返回未找到错误
      if (!session) return yield* new NotFoundError({ ptyID: id })
      // 返回找到的会话
      return session
    })

    // 删除会话的内部实现：清理索引、拆除进程并广播删除事件
    const removeSession = Effect.fnUntraced(function* (id: ID) {
      // 查找会话，不存在则直接返回
      const session = sessions.get(id)
      if (!session) return
      // 从会话表中移除
      sessions.delete(id)
      // 从退出顺序队列中移除（若存在）
      const index = exitOrder.indexOf(id)
      if (index !== -1) exitOrder.splice(index, 1)
      // 记录删除日志
      yield* Effect.logInfo("removing session", { id })
      // 拆除会话资源
      teardown(session)
      // 向总线发布会话已删除事件
      yield* bus.publish(Pty.Event.Deleted, { id: session.info.id })
    })

    // 对外操作：删除会话（先校验存在再执行删除）
    const remove = Effect.fn("Pty.remove")(function* (id: ID) {
      // 校验会话存在
      yield* requireSession(id)
      // 执行实际删除
      yield* removeSession(id)
    })

    // 对外操作：列出所有会话信息
    const list = Effect.fn("Pty.list")(function* () {
      return Array.from(sessions.values()).map((session) => session.info)
    })

    // 对外操作：获取单个会话信息
    const get = Effect.fn("Pty.get")(function* (id: ID) {
      return (yield* requireSession(id)).info
    })

    // 对外操作：创建新终端会话
    const create = Effect.fn("Pty.create")(function* (input: CreateInput) {
      // 生成单调递增的会话 ID
      const id = ID.ascending()
      // 命令为空时按“配置优先”解析默认 shell 命令
      const command = input.command || (yield* shell.resolve({ priority: "config" }))
      // 登录 shell 需追加 "-l" 参数以加载登录环境
      const args = ShellSelect.login(command) ? [...(input.args ?? []), "-l"] : [...(input.args ?? [])]
      // 工作目录缺省时使用当前位置目录
      const cwd = input.cwd || location.directory
      // 组装子进程环境变量：继承当前环境 + 用户覆盖 + 终端类型与标识
      const env = {
        ...process.env,
        ...input.env,
        TERM: "xterm-256color",
        OPENCODE_TERMINAL: "1",
      } as Record<string, string>
      // Windows 下显式设置 UTF-8 区域（locale），避免多字节输出乱码
      if (process.platform === "win32") {
        env.LC_ALL = "C.UTF-8"
        env.LC_CTYPE = "C.UTF-8"
        env.LANG = "C.UTF-8"
      }
      // 记录创建日志
      yield* Effect.logInfo("creating session", { id, cmd: command, args, cwd })
      // 动态加载原生 PTY 模块并取得 spawn（派生进程）函数
      const { spawn } = yield* Effect.promise(() => pty())
      // 同步启动 PTY 进程，终端类型为 xterm-256color
      const proc = yield* Effect.sync(() => spawn(command, args, { name: "xterm-256color", cwd, env }))
      // 组装对外展示的会话信息
      const info: Info = {
        id,
        // 标题缺省时用 ID 末 4 位生成
        title: input.title || `Terminal ${id.slice(-4)}`,
        command,
        args,
        cwd,
        status: "running",
        pid: proc.pid,
      }
      // 构建内部活跃会话记录
      const session: Active = {
        info,
        process: proc,
        buffer: "",
        cursor: 0,
        subscribers: new Map(),
        listeners: [],
      }
      // 登记到会话表
      sessions.set(id, session)
      // 挂接进程输出与退出监听器
      session.listeners.push(
        // 输出回调：推进游标、分发数据并维护保留缓冲
        proc.onData((chunk) => {
          // 全局游标按输出长度推进
          session.cursor += chunk.length
          // 向每个订阅者分发该输出块
          for (const [token, subscriber] of session.subscribers.entries()) {
            // 未激活的订阅者先缓存到 pending，待激活时补发
            if (!subscriber.active) {
              subscriber.pending.push(chunk)
              continue
            }
            // 已激活的直接推送；回调抛错则移除该订阅者
            try {
              subscriber.onData(chunk)
            } catch {
              session.subscribers.delete(token)
            }
          }
          // 将输出追加到保留缓冲
          session.buffer += chunk
          // 未超上限则无需裁剪
          if (session.buffer.length <= BUFFER_LIMIT) return
          // 超限时裁掉最旧内容，只保留最近 BUFFER_LIMIT 字符
          session.buffer = session.buffer.slice(session.buffer.length - BUFFER_LIMIT)
        }),
        // 退出回调：更新状态、广播事件并执行过期淘汰
        proc.onExit(({ exitCode }) => {
          // 已处理过退出则跳过（防止重复触发）
          if (session.info.status === "exited") return
          // 标记状态为已退出并记录退出码
          session.info.status = "exited"
          session.info.exitCode = exitCode
          // 通知所有订阅者会话结束
          notifyEnd(session, { exitCode })
          // 记入退出顺序队列，等待淘汰
          exitOrder.push(id)
          // 在独立 fiber 中异步执行日志、事件广播与淘汰逻辑
          runFork(
            Effect.gen(function* () {
              // 记录退出日志
              yield* Effect.logInfo("session exited", { id, exitCode })
              // 向总线发布会话已退出事件
              yield* bus.publish(Pty.Event.Exited, { id, exitCode })
              // 超出保留数量时逐个移除最旧的已退出会话
              while (exitOrder.length > EXITED_LIMIT) {
                // 取队列头部（最早退出）的会话 ID
                const oldest = exitOrder[0]
                // 队列为空则退出循环
                if (!oldest) break
                // 删除该最旧会话
                yield* removeSession(oldest)
              }
            }),
          )
        }),
      )
      // 向总线发布会话已创建事件
      yield* bus.publish(Pty.Event.Created, { info })
      // 返回新会话信息
      return info
    })

    // 对外操作：更新会话标题或终端尺寸
    const update = Effect.fn("Pty.update")(function* (id: ID, input: UpdateInput) {
      // 先定位会话
      const session = yield* requireSession(id)
      // 提供了标题则更新
      if (input.title) session.info.title = input.title
      // 提供了尺寸且进程仍在运行则调整 PTY 大小
      if (input.size && session.info.status === "running") session.process.resize(input.size.cols, input.size.rows)
      // 向总线发布会话已更新事件
      yield* bus.publish(Pty.Event.Updated, { info: session.info })
      // 返回更新后的信息
      return session.info
    })

    // 对外操作：向终端写入数据
    const write = Effect.fn("Pty.write")(function* (id: ID, data: string) {
      // 先定位会话
      const session = yield* requireSession(id)
      // 仅在进程运行中才写入
      if (session.info.status === "running") session.process.write(data)
    })

    // 对外操作：附加到会话，获得回放 + 实时订阅句柄
    const attach = Effect.fn("Pty.attach")(function* (id: ID, input: AttachInput) {
      // 先定位会话
      const session = yield* requireSession(id)
      // 仅运行中的会话可附加
      if (session.info.status !== "running") return yield* new ExitedError({ ptyID: id })
      // 记录客户端附加日志
      yield* Effect.logInfo("client attached to session", { id, directory: location.directory })
      // 生成唯一 token 作为订阅者键
      const token = {}
      // 构建订阅者记录，初始为未激活状态
      const subscriber: Subscriber = {
        onData: input.onData,
        onEnd: input.onEnd,
        active: false,
        detached: false,
        pending: [],
      }
      // 登记到会话订阅表
      session.subscribers.set(token, subscriber)
      // 记录当前末尾游标
      const end = session.cursor
      // 计算回放起点：-1 跟随末尾；非法值回退到 0；否则取 max(0, cursor)
      const from =
        input.cursor === -1
          ? end
          : input.cursor !== undefined && Number.isSafeInteger(input.cursor)
            ? Math.max(0, input.cursor)
            : 0
      // 返回附加句柄
      return {
        // 回放内容：从起点到末尾之间的保留缓冲片段
        replay: session.buffer.slice(Math.max(0, from - (end - session.buffer.length))),
        // 回放后的绝对游标
        cursor: end,
        // 写入句柄：仅运行中才写入进程
        write: (data: string) => {
          if (session.info.status === "running") session.process.write(data)
        },
        // 激活：先补发 pending 数据与缓存的结束事件，再开始实时推送
        activate: () => {
          // 已激活或已分离则忽略
          if (subscriber.active || subscriber.detached) return
          // 标记为已激活
          subscriber.active = true
          try {
            // 依次补发激活前暂存的输出块
            for (const chunk of subscriber.pending) subscriber.onData(chunk)
            // 清空暂存队列
            subscriber.pending.length = 0
            // 若激活前会话已结束，补发结束事件
            if (subscriber.end) subscriber.onEnd(subscriber.end)
          } catch {
            // 回调异常则移除订阅者
            session.subscribers.delete(token)
          }
        },
        // 分离：标记分离、丢弃暂存数据并注销订阅
        detach: () => {
          subscriber.detached = true
          subscriber.pending.length = 0
          subscriber.end = undefined
          session.subscribers.delete(token)
        },
      }
    })

    // 组装并返回服务实现
    return Service.of({ list, get, create, update, remove, write, attach })
  }),
)

// 构建 Pty 的分层节点，声明其依赖的节点
export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Bus.node, Location.node, ShellSelect.node],
})
