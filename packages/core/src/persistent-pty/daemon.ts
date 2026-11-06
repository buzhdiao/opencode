// 引入 Node 的子进程模块（spawn：派生守护进程）
import { spawn } from "node:child_process"
// 引入文件系统 Promise API：mkdir（建目录）、readFile（读文件）、rename（重命名）
import { mkdir, readFile, rename } from "node:fs/promises"
// 引入 Node 的 net 模块（Unix socket 通信）
import net from "node:net"
// 引入 Node 的 path 模块（路径拼接与解析）
import path from "node:path"
// 引入 Effect 核心模块：Cause（错误原因）、Data（数据类型）、Duration（时长）、Effect（副作用容器）、Schema（校验）、Semaphore（信号量）
import { Cause, Data, Duration, Effect, Schema, Semaphore } from "effect"
// 引入持久化 PTY 的交接（Handoff）类型（仅类型引用）
import type { Handoff } from "@opencode/schema/persistent-pty"
// 引入会话 ID schema（终端归属的会话）
import { Session } from "@opencode/schema/session"

// 守护进程协议版本号（客户端与守护进程两端必须一致）
const ProtocolVersion = 7
// 单帧最大字节数：8MB（超出即视为协议错误）
const MaxFrameBytes = 8 * 1024 * 1024

// 终端生命周期（lifecycle）schema：运行中 / 已退出（带退出码）/ 失败（带消息）
const Lifecycle = Schema.Union([
  // 运行中
  Schema.Struct({ status: Schema.Literal("running") }),
  // 已退出：exit_code 可为 null（被信号杀死等）
  Schema.Struct({ status: Schema.Literal("exited"), exit_code: Schema.NullOr(Schema.Number) }),
  // 失败：附错误消息
  Schema.Struct({ status: Schema.Literal("failed"), message: Schema.String }),
])

// 线路格式（wire format）的终端信息 schema：客户端与守护进程间传输的终端状态
export const WireTerminal = Schema.Struct({
  // 终端数字 ID
  id: Schema.Number,
  // 终端进程 PID（可为 null）
  pid: Schema.NullOr(Schema.Number),
  // 终端标题
  title: Schema.String,
  // 用户自定义标题（可选）
  user_title: Schema.optional(Schema.NullOr(Schema.String)),
  // 前台进程名称（可为 null）
  foreground_process: Schema.NullOr(Schema.String),
  // 归属的会话 ID
  group_id: Session.ID,
  // 启动命令及参数
  command: Schema.Array(Schema.String),
  // 工作目录
  cwd: Schema.String,
  // 终端列数
  cols: Schema.Number,
  // 终端行数
  rows: Schema.Number,
  // 生命周期状态
  lifecycle: Lifecycle,
  // 输出缓冲区的头部偏移
  output_head: Schema.Number,
  // 输出缓冲区的尾部偏移
  output_tail: Schema.Number,
})
// WireTerminal 的 TypeScript 类型
export type WireTerminal = typeof WireTerminal.Type

// 注册信息 schema：守护进程写入 service.json 的自我描述
const Registration = Schema.Struct({
  // 实例 ID
  instance_id: Schema.String,
  // 守护进程 PID
  pid: Schema.Number,
  // 协议版本
  protocol: Schema.Number,
  // Unix socket 路径
  socket: Schema.String,
  // 通信令牌（token）
  token: Schema.String,
  // 支持的特性列表（可选，老版本没有）
  features: Schema.optional(Schema.Array(Schema.String)),
})
// Registration 的 TypeScript 类型
type Registration = typeof Registration.Type

// 线路应答 schema：客户端与守护进程之间所有应答/事件类型的联合
export const WireResponse = Schema.Union([
  // pong：ping 应答，带实例 ID、PID、协议版本与特性
  Schema.Struct({
    type: Schema.Literal("pong"),
    instance_id: Schema.String,
    pid: Schema.Number,
    protocol: Schema.Number,
    features: Schema.optional(Schema.Array(Schema.String)),
  }),
  // created：终端创建成功
  Schema.Struct({ type: Schema.Literal("created"), terminal: WireTerminal }),
  // terminals：终端列表
  Schema.Struct({ type: Schema.Literal("terminals"), terminals: Schema.Array(WireTerminal) }),
  // ok：通用成功应答
  Schema.Struct({ type: Schema.Literal("ok") }),
  // owned：属主（ownership）握手成功
  Schema.Struct({ type: Schema.Literal("owned") }),
  // handoff：交接应答，带票据与过期时间
  Schema.Struct({ type: Schema.Literal("handoff"), ticket: Schema.String, expires_at: Schema.Number }),
  // snapshot：终端快照（文本 + 检查点 + 光标位置）
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    terminal: WireTerminal,
    text: Schema.String,
    checkpoint_base64: Schema.String,
    cursor_x: Schema.Number,
    cursor_y: Schema.Number,
  }),
  // rows：按行输出的屏幕内容
  Schema.Struct({
    type: Schema.Literal("rows"),
    terminal: WireTerminal,
    lines: Schema.Array(Schema.String),
    cursor_x: Schema.Number,
    cursor_y: Schema.Number,
  }),
  // attached：订阅成功，带角色、世代、偏移与重放数据
  Schema.Struct({
    type: Schema.Literal("attached"),
    terminal: WireTerminal,
    role: Schema.Literals(["controller", "observer"]),
    generation: Schema.Number,
    requested_offset: Schema.Number,
    available_offset: Schema.Number,
    end_offset: Schema.Number,
    truncated: Schema.Boolean,
    replay_base64: Schema.String,
  }),
  // resized：终端尺寸调整，带世代与检查点
  Schema.Struct({
    type: Schema.Literal("resized"),
    cols: Schema.Number,
    rows: Schema.Number,
    generation: Schema.Number,
    checkpoint_base64: Schema.String,
  }),
  // exited：终端退出，带退出码与最终偏移
  Schema.Struct({
    type: Schema.Literal("exited"),
    exit_code: Schema.NullOr(Schema.Number),
    final_offset: Schema.Number,
  }),
  // controller_changed：控制者变更
  Schema.Struct({
    type: Schema.Literal("controller_changed"),
    attachment_id: Schema.NullOr(Schema.String),
    generation: Schema.Number,
  }),
  // title_changed：终端标题变更
  Schema.Struct({ type: Schema.Literal("title_changed"), title: Schema.String }),
  // foreground_process_changed：前台进程变更
  Schema.Struct({ type: Schema.Literal("foreground_process_changed"), process: Schema.NullOr(Schema.String) }),
  // error：错误应答
  Schema.Struct({ type: Schema.Literal("error"), message: Schema.String }),
])
// WireResponse 的 TypeScript 类型
export type WireResponse = typeof WireResponse.Type

// 附件角色类型：controller（控制者，可写入）或 observer（观察者，只读）
export type Role = "controller" | "observer"

// 流事件类型：订阅后通过回调推送给客户端的事件
export type StreamEvent =
  // output：一段输出字节及其在缓冲区中的起止偏移
  | { readonly type: "output"; readonly start: number; readonly end: number; readonly data: Uint8Array }
  // resized：尺寸调整，带世代与终端检查点
  | {
      readonly type: "resized"
      readonly cols: number
      readonly rows: number
      readonly generation: number
      readonly checkpoint: Uint8Array
    }
  // exited：终端退出，带可选退出码与最终偏移
  | { readonly type: "exited"; readonly exitCode?: number; readonly finalOffset: number }
  // controller_changed：控制者变更
  | { readonly type: "controller_changed"; readonly attachmentID?: string; readonly generation: number }
  // title_changed：标题变更
  | { readonly type: "title_changed"; readonly title: string }
  // foreground_process_changed：前台进程变更
  | { readonly type: "foreground_process_changed"; readonly process: string | null }

// 订阅入参：起始游标偏移、附件 ID、角色、是否接管，以及事件/结束回调
export type SubscribeInput = {
  readonly cursor: number
  readonly attachmentID: string
  readonly role: Role
  readonly takeover?: boolean
  readonly onEvent: (event: StreamEvent) => void
  readonly onEnd: () => void
}

// 终端附件（attachment）：订阅成功后返回的句柄，含重放数据与激活/分离操作
export type DaemonAttachment = {
  readonly terminal: WireTerminal
  readonly role: Role
  readonly generation: number
  // 重放数据：请求偏移、可用偏移、结束偏移、是否截断、数据本体
  readonly replay: {
    readonly requestedOffset: number
    readonly availableOffset: number
    readonly endOffset: number
    readonly truncated: boolean
    readonly data: Uint8Array
  }
  // 激活：开始接收实时事件
  readonly activate: () => void
  // 分离：断开订阅连接
  readonly detach: () => void
}

// 守护进程通信错误：按类别（连接/应答/注册/协议/派生）区分，附消息与可选 PID
export class DaemonError extends Data.TaggedError("PersistentPty.DaemonError")<{
  readonly kind: "connect" | "response" | "registration" | "protocol" | "spawn"
  readonly message: string
  readonly pid?: number
}> {}

// 守护进程传输层（transport）接口：上层持久化 PTY 服务通过它与守护进程通信
export interface DaemonTransport {
  readonly request: (value: object, start?: boolean) => Effect.Effect<WireResponse, DaemonError>
  readonly requestIfRunning: (value: object) => Effect.Effect<WireResponse | undefined, DaemonError>
  readonly supports: (feature: string) => Effect.Effect<boolean, DaemonError>
  readonly shutdown: Effect.Effect<WireResponse | undefined, DaemonError>
  readonly handoff: Effect.Effect<Handoff | null, DaemonError>
  readonly subscribe: (
    id: number,
    input: SubscribeInput,
  ) => Effect.Effect<DaemonAttachment, DaemonError>
}

// 构建守护进程传输层的 Effect 生成器：管理发现、派生、认领、请求与订阅
export const makeDaemonTransport = Effect.fn("PersistentPty.makeDaemonTransport")(function* (
  root: string,
  initialID: string,
  binary: () => Promise<string> = () => Promise.resolve(process.env.OPENCODE_PTY_BIN || "opencode-pty"),
  inherited?: Handoff,
) {
  // 创建并发度为 1 的信号量（semaphore）：串行化启动/交接等关键区段
  const startup = Semaphore.makeUnsafe(1)
  // Each daemon owns the runtime directory `<root>/<id>`.
  // 当前守护进程实例 ID（即运行时目录名）
  let id = initialID
  // 当前已发现的注册信息（未连接时为空）
  let registration: Registration | undefined
  // 当前持有的属主（ownership）连接
  let owner: Awaited<ReturnType<typeof openOwner>> | undefined
  // 作用域是否已关闭
  let closed = false
  // 注册作用域终结器（finalizer）：标记关闭并销毁属主连接
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      // 标记作用域已关闭
      closed = true
      // 销毁属主 socket
      owner?.socket.destroy()
    }),
  )

  // claim：与守护进程建立属主连接并认领所有权（整体 5 秒超时）
  const claim = (current: Registration, ticket?: string) =>
    Effect.tryPromise({
      // try：建立连接并记录为当前属主
      try: async (signal) => {
        // 打开属主连接（可携带交接票据）
        const connection = await openOwner(current, ticket, signal)
        // 作用域已关闭或请求已中止时，销毁刚建立的连接并报错
        if (closed || signal.aborted) {
          connection.socket.destroy()
          throw new Error("PTY owner scope is closed")
        }
        // 记录为当前属主连接
        owner = connection
        // 记录当前注册信息
        registration = current
        // 连接关闭时清空属主状态（若仍是当前连接）
        connection.socket.once("close", () => {
          // 已被其他连接取代则不处理
          if (owner !== connection) return
          // 清空属主
          owner = undefined
          // 清空注册信息
          registration = undefined
        })
      },
      // 连接失败统一转为 connect 类型的 DaemonError
      catch: (cause) => failure("connect", cause),
    }).pipe(
      // 超过 5 秒未完成认领则失败
      Effect.timeoutOrElse({
        duration: Duration.seconds(5),
        orElse: () => Effect.fail(new DaemonError({ kind: "connect", message: "PTY ownership claim timed out" })),
      }),
    )

  // discover：从运行时目录读取 service.json，校验协议版本并 ping 确认守护进程确实存活
  const discover = Effect.fn("PersistentPty.daemon.discover")(function* (directory = path.join(root, id)) {
    // 读取 service.json 内容（失败转为 connect 错误）
    const value = yield* Effect.tryPromise({
      try: () => readFile(path.join(directory, "service.json"), "utf8"),
      catch: (cause) => failure("connect", cause),
    })
    // 把 JSON 字符串解码为 Registration（失败转为 protocol 错误）
    const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Registration))(value).pipe(
      Effect.mapError((cause) => failure("protocol", cause)),
    )
    // 协议版本不匹配则失败（提示两端各自的版本）
    if (decoded.protocol !== ProtocolVersion)
      return yield* Effect.fail(
        new DaemonError({
          kind: "protocol",
          message: `opencode-pty protocol mismatch: daemon=${decoded.protocol}, client=${ProtocolVersion}`,
          pid: decoded.pid,
        }),
      )
    // 用一次性连接 ping 守护进程，确认它真的活着
    const response = yield* oneShot(decoded, { op: "ping" })
    // pong 应答与注册文件不一致说明注册信息已过期
    if (
      response.type !== "pong" ||
      response.instance_id !== decoded.instance_id ||
      response.pid !== decoded.pid ||
      response.protocol !== ProtocolVersion
    )
      return yield* Effect.fail(new DaemonError({ kind: "protocol", message: "opencode-pty registration mismatch" }))
    // Daemons older than the features list omit it; trust the live daemon's answer over the file.
    // 以存活进程的应答为准补齐特性列表（老版本注册文件中没有 features 字段）
    return { ...decoded, features: response.features ?? [] }
  })

  // spawnDaemon：派生新的 opencode-pty 守护进程子进程，并轮询等待其就绪
  const spawnDaemon = Effect.fn("PersistentPty.daemon.spawn")(function* () {
    // 解析可执行文件路径（binary 回调，失败转为 spawn 错误）
    const executable = yield* Effect.tryPromise({ try: binary, catch: (cause) => failure("spawn", cause) })
    // 以 detached 模式派生守护进程（隐藏窗口、忽略标准输入输出）
    const child = yield* Effect.tryPromise({
      try: () =>
        new Promise<ReturnType<typeof spawn>>((resolve, reject) => {
          // 派生进程：daemon 子命令 + 运行时目录与实例名参数
          const child = spawn(
            executable,
            ["daemon", "--runtime-dir", root, "--name", id],
            { detached: true, windowsHide: true, stdio: "ignore" },
          )
          // 派生成功后解除引用（unref）让父进程可独立退出，并完成 Promise
          child.once("spawn", () => {
            child.unref()
            resolve(child)
          })
          // 派生失败则拒绝 Promise
          child.once("error", reject)
        }),
      catch: (cause) => failure("spawn", cause),
    })
    // 轮询等待守护进程完成注册（最多 5 秒）；整体失败时终止子进程
    return yield* Effect.gen(function* () {
      // 截止时间：当前时间 + 5 秒
      const deadline = Date.now() + 5_000
      // 记录最后一次发现的错误
      let last: DaemonError | undefined
      // 未超时且子进程尚未退出时继续轮询
      while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
        // 尝试发现注册信息；失败记录错误后继续等待
        const found = yield* discover().pipe(
          Effect.map((value) => ({ value })),
          Effect.catch((error) => {
            last = error
            return Effect.succeed(undefined)
          }),
        )
        // 发现成功：认领所有权并返回注册信息
        if (found) {
          yield* claim(found.value)
          return found.value
        }
        // 每轮间隔 50 毫秒
        yield* Effect.sleep(50)
      }
      // 超时或子进程提前退出：返回最后一次错误（或默认提示）
      return yield* Effect.fail(
        last ?? new DaemonError({ kind: "connect", message: "opencode-pty did not become ready" }),
      )
    }).pipe(
      // 启动流程出错时，终止刚派生的守护进程子进程
      Effect.onError(() =>
        Effect.sync(() => {
          child.kill("SIGTERM")
        }),
      ),
    )
  })

  // An unreachable daemon can still hold this directory's lock, so retry once in a fresh directory.
  // start：启动守护进程；失败时放弃当前目录并换一个全新目录重试一次
  const start = () =>
    spawnDaemon().pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          // 记录警告日志：说明为什么换目录
          yield* Effect.logWarning("Starting opencode-pty in a fresh runtime directory", { cause: error.message })
          // 放弃当前运行时目录（换新 ID）
          abandon()
          // 在全新目录重试启动
          return yield* spawnDaemon()
        }),
      ),
    )

  // abandon：销毁当前连接与注册信息，并改用全新的实例 ID（旧守护进程留在原目录自生自灭）
  const abandon = () => {
    // 销毁属主连接
    owner?.socket.destroy()
    // 清空属主
    owner = undefined
    // 清空注册信息
    registration = undefined
    // 生成全新实例 ID
    id = crypto.randomUUID()
  }

  // connect：确保已连接到守护进程并返回注册信息；必要时启动它（信号量保证串行）
  const connect = Effect.fn("PersistentPty.daemon.connect")(function* (shouldStart: boolean) {
    // 作用域已关闭则直接失败
    if (closed) return yield* Effect.fail(new DaemonError({ kind: "connect", message: "PTY owner scope is closed" }))
    // 已有注册信息则直接返回（快速路径）
    if (registration) return registration
    // 加信号量进入关键区，避免并发重复发现/启动
    return yield* startup.withPermit(
      Effect.gen(function* () {
        // 双重检查：等待期间可能已被其他协程连接
        if (registration) return registration
        // 尝试发现现有守护进程；不可达且允许启动时转而启动
        const found = yield* discover().pipe(
          Effect.catch((error) => {
            if (shouldStart && error.kind === "connect") return start()
            return Effect.fail(error)
          }),
        )
        // 尚未持有属主连接时认领所有权
        if (!owner) yield* claim(found)
        // 缓存注册信息
        registration = found
        // 返回注册信息
        return found
      }),
    )
  })

  // Runs against the live registration and forgets it when the daemon rejects it as stale.
  // withRegistration：基于当前注册信息执行操作；守护进程判定注册过期时清空缓存
  const withRegistration = <A>(shouldStart: boolean, run: (current: Registration) => Effect.Effect<A, DaemonError>) =>
    Effect.gen(function* () {
      // 先确保已连接并拿到注册信息
      const current = yield* connect(shouldStart)
      // 执行操作；registration 类错误且注册未变时清空缓存（下次重新发现）
      return yield* run(current).pipe(
        Effect.catch((error) => {
          if (error.kind === "registration" && registration === current) registration = undefined
          return Effect.fail(error)
        }),
      )
    })

  // attempt：单次请求尝试（在 withRegistration 保护下发送一次性请求）
  const attempt = Effect.fn("PersistentPty.daemon.request-attempt")((value: object, shouldStart: boolean) =>
    withRegistration(shouldStart, (current) => oneShot(current, value)),
  )

  // request：对守护进程发起请求，带注册失效与连接失败的自动重试逻辑
  const request = Effect.fn("PersistentPty.daemon.request")(function* (value: object, shouldStart = false) {
    // 首次尝试；失败时按错误类别处理
    return yield* attempt(value, shouldStart).pipe(
      Effect.catch((error) => {
        // 注册失效：立即重试一次
        if (error.kind === "registration") return attempt(value, shouldStart)
        // 非连接类错误直接失败
        if (error.kind !== "connect") return Effect.fail(error)
        // 连接失败：清空注册缓存
        registration = undefined
        // 不允许启动守护进程时直接失败
        if (!shouldStart) return Effect.fail(error)
        // 允许启动：重新发起（触发守护进程启动）
        return attempt(value, true)
      }),
    )
  })

  // requestIfRunning：仅在守护进程已运行时发送请求；连接失败返回 undefined（不报错）
  const requestIfRunning = (value: object) =>
    request(value).pipe(
      Effect.catch((error) => (error.kind === "connect" ? Effect.succeed(undefined) : Effect.fail(error))),
    )

  // supports：查询守护进程是否支持某个特性（只连接不启动）
  const supports = Effect.fn("PersistentPty.daemon.supports")(function* (feature: string) {
    // 连接现有守护进程
    const current = yield* connect(false)
    // 特性列表包含该特性则 true，缺省 false
    return current.features?.includes(feature) ?? false
  })

  // shutdown：请求守护进程退出，并轮询确认其真正停止
  const shutdown = Effect.gen(function* () {
    // 发送 shutdown 请求（守护进程未运行则得到 undefined）
    const response = yield* requestIfRunning({ op: "shutdown" })
    // 清空注册缓存
    registration = undefined
    // 本来就没在运行，直接完成
    if (!response) return undefined
    // 等待退出的截止时间：5 秒
    const deadline = Date.now() + 5_000
    // 轮询直到超时
    while (Date.now() < deadline) {
      // 还能发现注册信息说明守护进程仍在运行
      const running = yield* discover().pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      )
      // 已停止则返回 shutdown 应答
      if (!running) return response
      // 每轮间隔 50 毫秒
      yield* Effect.sleep(50)
    }
    // 超时仍未停止则失败
    return yield* Effect.fail(new DaemonError({ kind: "connect", message: "opencode-pty did not stop" }))
  })

  // handoff：向守护进程申请交接票据（服务重启前转移终端所有权），信号量串行化
  const handoff = startup.withPermit(
    Effect.gen(function* () {
      // 当前属主连接
      const current = owner
      // 当前注册信息
      const registered = registration
      // 未持有属主连接或注册信息时无事可交接
      if (!current || !registered) return null
      // 请求守护进程准备交接（整体 5 秒超时）
      const response = yield* Effect.tryPromise({
        try: (signal) => current.exchange({ op: "prepare_handoff" }, signal),
        catch: (cause) => failure("response", cause),
      }).pipe(
        Effect.timeoutOrElse({
          duration: Duration.seconds(5),
          orElse: () =>
            Effect.fail(new DaemonError({ kind: "response", message: "PTY handoff preparation timed out" })),
        }),
      )
      // 应答类型不符说明守护进程未给出交接票据
      if (response.type !== "handoff")
        return yield* Effect.fail(new DaemonError({ kind: "protocol", message: "Expected PTY handoff ticket" }))
      // 返回交接信息：运行时目录、实例 ID、票据与过期时间
      return {
        directory: path.join(root, id),
        instanceID: registered.instance_id,
        ticket: response.ticket,
        expiresAt: response.expires_at,
      }
    }),
  )

  // subscribe：订阅某终端的输出流并返回附件句柄；注册失效时自动重试一次
  const subscribe = Effect.fn("PersistentPty.daemon.subscribe")(function* (
    terminalID: number,
    input: SubscribeInput,
  ) {
    // 单次订阅尝试（基于当前注册信息建立专属连接）
    const attempt = withRegistration(false, (current) =>
      Effect.tryPromise({
        try: () => subscribePromise(current, terminalID, input),
        catch: (cause) => (cause instanceof DaemonError ? cause : failure("connect", cause)),
      }),
    )
    // 执行订阅；registration 类错误时重试一次
    return yield* attempt.pipe(Effect.catch((error) => (error.kind === "registration" ? attempt : Effect.fail(error))))
  })

  // A replacement must own its inherited daemon before the server becomes ready. Terminals are
  // best-effort: any failure abandons the old daemon so the restart itself always succeeds.
  // 处理重启交接（inherited）：接管上一次服务实例留下的守护进程
  if (inherited) {
    // 发现的注册信息
    let found: Registration | undefined
    // 执行交接流程；任何失败都放弃旧守护进程，保证重启总能继续
    yield* Effect.gen(function* () {
      // 交接票据已过期则失败
      if (inherited.expiresAt <= Date.now())
        return yield* Effect.fail(new DaemonError({ kind: "registration", message: "PTY restart handoff expired" }))
      // Older releases put the daemon directory outside the root; its directory name is still the ID.
      // 用交接目录名作为实例 ID（兼容把目录放在根目录之外的旧版本）
      id = path.basename(inherited.directory)
      // 在交接目录中发现守护进程
      found = yield* discover(inherited.directory)
      // 实例 ID 与票据不符说明守护进程已被更换，交接失效
      if (found.instance_id !== inherited.instanceID)
        return yield* Effect.fail(new DaemonError({ kind: "registration", message: "PTY restart daemon changed" }))
      // 旧目录不在规范位置时，把注册文件迁移到根目录下的标准位置
      if (path.resolve(inherited.directory) !== path.resolve(root, id))
        yield* migrate(inherited.directory, path.join(root, id))
      // 用交接票据认领所有权
      yield* claim(found, inherited.ticket)
    }).pipe(
      // 交接失败的处理：记录警告并尽力关闭旧守护进程
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          // 纯中断（被取消）则原样向上传播
          if (Cause.hasInterruptsOnly(cause)) return yield* Effect.failCause(cause)
          // 记录警告：放弃交接，持久终端将重新开始
          yield* Effect.logWarning("Discarding PTY restart handoff; persistent terminals will start fresh", {
            cause: Cause.pretty(cause),
          })
          // 尽力关闭旧守护进程（失败也忽略）
          if (found) yield* oneShot(found, { op: "shutdown" }).pipe(Effect.ignore)
          // 放弃旧实例并换新 ID
          abandon()
        }),
      ),
    )
  }

  // 返回传输层实现对象（满足 DaemonTransport 接口）
  return { request, requestIfRunning, supports, shutdown, handoff, subscribe } satisfies DaemonTransport
})

// Older releases kept registrations in purgeable temp directories. Renaming keeps the lock file's
// inode, so the still-running daemon keeps holding its lock in the new location.
// migrate：把注册文件迁移到新目录；rename 保留锁文件的 inode，运行中的守护进程在新位置依然持有锁
const migrate = Effect.fn("PersistentPty.daemon.migrate")(function* (directory: string, target: string) {
  // 创建目标目录并迁移锁文件与注册文件（失败转为 registration 错误）
  yield* Effect.tryPromise({
    try: async () => {
      // 创建目标目录（0700 权限）
      await mkdir(target, { recursive: true, mode: 0o700 })
      // 迁移锁文件（保持 inode，守护进程仍持有锁）
      await rename(path.join(directory, "service.lock"), path.join(target, "service.lock"))
      // 迁移注册文件
      await rename(path.join(directory, "service.json"), path.join(target, "service.json"))
    },
    catch: (cause) => failure("registration", cause),
  })
})

// openOwner：打开到守护进程的"属主"长连接，完成 own 握手后返回连接与请求函数
async function openOwner(registration: Registration, ticket: string | undefined, signal: AbortSignal) {
  // 建立到守护进程 Unix socket 的连接
  const socket = net.createConnection({ path: registration.socket })
  // 创建帧解码器（长度前缀协议）
  const frames = decoder(socket)
  // 中止回调：直接销毁 socket
  const abort = () => socket.destroy()
  // 监听外部中止信号（只触发一次）
  signal.addEventListener("abort", abort, { once: true })
  // exchange：在属主连接上发送一个请求并等待单个应答
  const exchange = async (request: object, signal: AbortSignal) => {
    // 信号已中止则直接抛错
    if (signal.aborted) throw new Error("PTY ownership request interrupted")
    // 请求期间也监听中止
    signal.addEventListener("abort", abort, { once: true })
    try {
      // 发送带令牌的请求帧
      socket.write(encode({ token: registration.token, request }))
      // 读取应答帧
      const frame = await frames.next()
      // 连接被守护进程关闭则报错
      if (frame.done) throw new Error("PTY daemon closed its ownership connection")
      // 解码应答
      const response = decode(frame.value)
      // 错误应答直接抛出
      if (response.type === "error") throw new Error(response.message)
      // 返回应答
      return response
    } finally {
      // 移除本请求注册的中止监听
      signal.removeEventListener("abort", abort)
    }
  }
  try {
    // 等待连接建立（出错或被关闭则失败）
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve)
      socket.once("error", reject)
      socket.once("close", () => reject(new Error("PTY ownership connection closed")))
    })
    // 发送 own 握手（携带实例 ID 与可选交接票据）
    const response = await exchange({ op: "own", instance_id: registration.instance_id, ticket }, signal)
    // 守护进程不支持属主机制则报错
    if (response.type !== "owned") throw new Error("PTY daemon does not support server ownership")
    // 解除引用，避免该连接阻止宿主进程退出
    socket.unref()
    // 返回连接与请求函数
    return { socket, exchange }
  } catch (error) {
    // 失败时销毁 socket 并向上抛出
    socket.destroy()
    throw error
  } finally {
    // 移除最初注册的中止监听
    signal.removeEventListener("abort", abort)
  }
}

// oneShot：建立一次性连接，发送单个请求并取回应答（用完即销毁；整体 5 秒超时）
const oneShot = Effect.fn("PersistentPty.daemon.oneShot")(function* (registration: Registration, request: object) {
  // 编码请求载荷（带令牌；编码失败转为 protocol 错误）
  const payload = yield* Effect.try({
    try: () => encode({ token: registration.token, request }),
    catch: (cause) => failure("protocol", cause),
  })
  // 是否已发出请求（用于区分超时属于 connect 还是 response 错误）
  let dispatched = false
  // acquireUseRelease：acquire 建连接、use 收发、release 销毁
  return yield* Effect.acquireUseRelease(
    // acquire：建立到守护进程的连接（支持中止）
    Effect.tryPromise({
      try: (signal) =>
        new Promise<net.Socket>((resolve, reject) => {
          const socket = net.createConnection({ path: registration.socket, signal })
          socket.once("connect", () => resolve(socket))
          socket.once("error", reject)
        }),
      catch: (cause) => failure("connect", cause),
    }),
    // use：发送请求并等待应答
    (socket) =>
      Effect.gen(function* () {
        // 写出请求帧（成功后标记 dispatched）
        yield* Effect.try({
          try: () => {
            dispatched = true
            socket.write(payload)
          },
          catch: (cause) => failure("response", cause),
        })
        // 读取第一个应答帧（期间注册中止监听，中止时销毁连接）
        const first = yield* Effect.tryPromise({
          try: async (signal) => {
            const frames = decoder(socket)
            const abort = () => socket.destroy()
            signal.addEventListener("abort", abort, { once: true })
            try {
              const frame = await frames.next()
              if (frame.done) throw new Error("opencode-pty closed without response")
              return frame.value
            } finally {
              signal.removeEventListener("abort", abort)
            }
          },
          catch: (cause) => failure("response", cause),
        })
        // 解码应答（失败转为 protocol 错误）
        const response = yield* Effect.try({
          try: () => decode(first),
          catch: (cause) => failure("protocol", cause),
        })
        // 错误应答转为对应类别的失败
        if (response.type === "error") return yield* Effect.fail(responseError(response.message))
        // 返回成功应答
        return response
      }),
    // release：无论成败都销毁 socket
    (socket) => Effect.sync(() => socket.destroy()),
  ).pipe(
    // 整体 5 秒超时；按是否已发出请求区分错误类别
    Effect.timeoutOrElse({
      duration: Duration.seconds(5),
      orElse: () =>
        Effect.fail(
          new DaemonError({
            kind: dispatched ? "response" : "connect",
            message: "opencode-pty request timed out",
          }),
        ),
    }),
  )
})

// subscribePromise：建立订阅连接，完成 attached 握手并返回终端附件句柄
async function subscribePromise(
  registration: Registration,
  id: number,
  input: SubscribeInput,
): Promise<DaemonAttachment> {
  // 建立到守护进程的连接
  const socket = net.createConnection(registration.socket)
  // 创建帧解码器
  const frames = decoder(socket)
  try {
    // 等待连接建立
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve)
      socket.once("error", reject)
    })
    // 发送订阅请求（含起始偏移、附件 ID、角色与是否接管）
    socket.write(
      encode({
        token: registration.token,
        request: {
          op: "subscribe",
          id,
          offset: input.cursor,
          attachment_id: input.attachmentID,
          role: input.role,
          takeover: input.takeover ?? false,
        },
      }),
    )
    // 读取首个应答
    const initial = await frames.next()
    // 连接在附件建立前被关闭
    if (initial.done) throw new Error("opencode-pty closed before attachment")
    // 解码应答
    const response = decode(initial.value)
    // 错误应答（如认证失败）
    if (response.type === "error") throw responseError(response.message)
    // 非预期应答类型
    if (response.type !== "attached") throw new Error(`unexpected opencode-pty response: ${response.type}`)
    // 是否已主动分离
    let detached = false
    // pump：持续读取事件帧并分发到回调，直到连接关闭或终端退出
    const pump = async () => {
      try {
        // 逐帧读取
        for await (const frame of frames) {
          // 首字节为 0 的是二进制输出帧
          if (frame[0] === 0) {
            // 输出帧至少 17 字节（1 字节类型 + 16 字节起止偏移）
            if (frame.length < 17) throw new Error("invalid opencode-pty output frame")
            // 解析起止偏移并回调输出事件（数据为剩余字节）
            input.onEvent({
              type: "output",
              start: Number(frame.readBigUInt64BE(1)),
              end: Number(frame.readBigUInt64BE(9)),
              data: frame.subarray(17),
            })
            // 继续下一帧
            continue
          }
          // 其余帧解码为 JSON 事件
          const event = decode(frame)
          // 尺寸调整事件：携带世代与检查点
          if (event.type === "resized")
            input.onEvent({
              type: "resized",
              cols: event.cols,
              rows: event.rows,
              generation: event.generation,
              checkpoint: Buffer.from(event.checkpoint_base64, "base64"),
            })
          // 控制者变更事件
          if (event.type === "controller_changed")
            input.onEvent({
              type: "controller_changed",
              attachmentID: event.attachment_id ?? undefined,
              generation: event.generation,
            })
          // 标题变更事件
          if (event.type === "title_changed") input.onEvent({ type: "title_changed", title: event.title })
          // 前台进程变更事件
          if (event.type === "foreground_process_changed")
            input.onEvent({ type: "foreground_process_changed", process: event.process })
          // 退出事件：回调后结束泵
          if (event.type === "exited") {
            input.onEvent({
              type: "exited",
              exitCode: event.exit_code ?? undefined,
              finalOffset: event.final_offset,
            })
            return
          }
        }
      } finally {
        // 非主动分离的结束都要通知客户端（连接关闭/出错/退出）
        if (!detached) input.onEnd()
      }
    }
    // 是否已激活泵
    let activated = false
    // 返回附件对象：终端状态、角色、世代、重放数据与激活/分离操作
    return {
      terminal: response.terminal,
      role: response.role,
      generation: response.generation,
      // 重放数据：把 base64 解码为字节
      replay: {
        requestedOffset: response.requested_offset,
        availableOffset: response.available_offset,
        endOffset: response.end_offset,
        truncated: response.truncated,
        data: Buffer.from(response.replay_base64, "base64"),
      },
      // activate：激活泵开始接收实时事件（仅第一次有效）
      activate() {
        // 已激活或已分离则忽略
        if (activated || detached) return
        // 标记已激活
        activated = true
        // 启动泵（错误吞掉：onEnd 已负责通知结束）
        void pump().catch(() => {})
      },
      // detach：主动分离并销毁连接（仅第一次有效）
      detach() {
        // 已分离则忽略
        if (detached) return
        // 标记已分离
        detached = true
        // 销毁 socket
        socket.destroy()
      },
    }
  } catch (error) {
    // 失败时销毁 socket 并向上抛出
    socket.destroy()
    throw error
  }
}

// encode：把值编码为"4 字节大端长度前缀 + JSON 载荷"的帧
function encode(value: unknown) {
  // 序列化为 JSON 字节
  const payload = Buffer.from(JSON.stringify(value))
  // 超过帧大小上限则报错
  if (payload.length > MaxFrameBytes) throw new Error("opencode-pty frame too large")
  // 分配"长度前缀 + 载荷"总长的缓冲区
  const output = Buffer.allocUnsafe(payload.length + 4)
  // 写入 4 字节大端长度前缀
  output.writeUInt32BE(payload.length)
  // 拷贝 JSON 载荷到前缀之后
  payload.copy(output, 4)
  // 返回完整帧
  return output
}

// decoder：异步生成器，把 socket 字节流切分为一帧帧完整数据（按长度前缀）
async function* decoder(socket: net.Socket) {
  // 尚未凑齐一帧的残留字节
  let pending = Buffer.alloc(0)
  // 逐块读取 socket 数据
  for await (const value of socket) {
    // 统一转换为 Buffer
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    // 追加到残留缓冲
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk])
    // 够读 4 字节长度前缀时循环切帧
    while (pending.length >= 4) {
      // 读取帧长度
      const length = pending.readUInt32BE(0)
      // 超过帧大小上限则报错
      if (length > MaxFrameBytes) throw new Error("opencode-pty frame too large")
      // 数据还不够一帧，等待下一个数据块
      if (pending.length < length + 4) break
      // 产出完整帧（去掉长度前缀）
      yield pending.subarray(4, length + 4)
      // 从缓冲中移除已消费的部分
      pending = pending.subarray(length + 4)
    }
  }
  // 流结束仍有残留字节说明最后一帧被截断
  if (pending.length !== 0) throw new Error("opencode-pty truncated frame")
}

// 同步解码器：把 JSON 字符串按 WireResponse schema 解码（失败直接抛错）
const decodeWireResponse = Schema.decodeUnknownSync(Schema.fromJsonString(WireResponse))

// decode：把字节载荷转为 UTF-8 字符串后按 schema 解码
function decode(payload: Uint8Array) {
  return decodeWireResponse(Buffer.from(payload).toString("utf8"))
}

// responseError：把错误应答映射为 DaemonError（"authentication failed" 视为注册错误，其余为协议错误）
function responseError(message: string) {
  return new DaemonError({ kind: message === "authentication failed" ? "registration" : "protocol", message })
}

// failure：把任意错误原因包装为指定类别的 DaemonError（保留原始消息）
function failure(kind: DaemonError["kind"], cause: unknown) {
  return new DaemonError({ kind, message: cause instanceof Error ? cause.message : String(cause) })
}
