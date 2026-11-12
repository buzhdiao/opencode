// Client data layer: apply server events and cache API reads into a Solid store.
// Prefer straightforward projection. Invalidated reads revalidate serially so an older
// response cannot commit after its replacement. Reconnect invalidates cached reads;
// active UI owners decide what to sync again.
// 模块职责：客户端数据层——把服务端事件应用到本地缓存、把 API 读取结果写入 Solid store。
// 关键设计：采用直观的投影（projection）方案；失效的读取串行重新验证，确保旧响应不会晚于
// 新响应提交；断线重连使所有缓存读取失效，由活跃的 UI 持有方自行决定重新同步哪些数据。
// 在系统中的位置：client 包的数据中枢，UI 组件通过 createData 返回的 result 读写全部领域数据。

// 集中导入客户端 API 的各类信息与输入/输出类型（Agent/命令/配置/表单/集成/位置/模型等）
import type {
  AgentInfo,
  CommandInfo,
  ConfigEntry,
  SessionFormCancelInput,
  FormInfo,
  SessionFormReplyInput,
  IntegrationInfo,
  LocationRef,
  LocationGetOutput,
  McpResource,
  McpServer,
  ModelInfo,
  ModelRef,
  PermissionSavedInfo,
  PermissionRequest,
  PermissionReplyInput,
  Project,
  ProviderInfo,
  ReferenceInfo,
  SessionMessageInfo,
  SessionMessageAssistant,
  SessionMessageAssistantReasoning,
  SessionMessageAssistantText,
  SessionMessageAssistantTool,
  SessionInfo,
  SessionListInput,
  SessionInboxInfo,
  SessionInboxCompaction,
  ShellInfo,
  SkillInfo,
  ToolContent,
  UsageLimitsInfo,
  VcsInfo,
  OpenCodeEvent,
  OpenCodeClient,
  WebSearchProvider,
} from "../promise"
// Worktree（工作树）Schema：worktree.resolved 事件里做工作树归属判断
import { Worktree } from "@opencode/schema/worktree"
// SessionID：会话 ID 的生成工具（乐观创建会话时客户端自行铸造 ID）
import { SessionID } from "@opencode/schema/session-id"
// SessionMessage：消息 ID 工具（fromEvent 把事件 ID 确定性地映射为消息 ID）
import { SessionMessage } from "@opencode/schema/session-message"
// 各类"资源不存在/已处理"错误的判断工具，以及发送提示的输入类型
import {
  isFormAlreadySettledError,
  isFormNotFoundError,
  isMessageNotFoundError,
  isPermissionNotFoundError,
  isSessionNotFoundError,
  type SessionPromptInput,
} from "../promise"
// solid-js/store：createStore 创建响应式 store、produce 草稿式修改、reconcile 整体替换以精确定位变更
import { createStore, produce, reconcile } from "solid-js/store"
// SessionInbox：会话收件箱（待处理输入）的类型与投递方式定义
import type { SessionInbox } from "@opencode/schema/session-inbox"
// solid-js 核心：batch 批量更新、createEffect 副作用、createMemo 计算属性、createSignal 信号、onCleanup 清理
import { batch, createEffect, createMemo, createSignal, onCleanup } from "solid-js"

// 会话运行状态：idle 空闲 / running 执行中
export type DataSessionStatus = "idle" | "running"
/**
 * Where a pending user prompt stands relative to the runner: `starting` is promoted at the next idle boundary,
 * `steering` waits for the next step boundary of an execution that already delivered input, `stranded` outlived an
 * execution that ended without delivering it, and `queued` waits for every steer to drain.
 */
// 待处理用户提示相对执行器的状态：`starting` 在下一个空闲边界被提升执行；
// `steering` 等待"已收到输入的执行"的下个步骤边界；`stranded` 表示所依附的执行已结束而输入未被消费；
// `queued` 表示排在所有插队（steer）之后等待
export type DataPendingStatus = "starting" | "steering" | "stranded" | "queued"
// 事件类型映射表：按 type 字面量取出 OpenCodeEvent 对应的子类型（供事件订阅回调做精确类型收窄）
type OpenCodeEventMap = { [Type in OpenCodeEvent["type"]]: Extract<OpenCodeEvent, { type: Type }> }

// createData 的入参定义
export type CreateDataInput = {
  // 返回 API 客户端的取值函数（惰性获取连接，避免模块加载期依赖网络）
  readonly api: () => OpenCodeClient
  // 默认工作目录（作为默认位置引用）
  readonly directory: string
  /** Raw-message window used for an initial transcript read. Older pages retain their normal size. */
  // 首次读取消息记录（transcript）时使用的原始消息窗口大小；更早的历史分页仍用常规页大小
  readonly initialMessageLimit?: () => number
  // 事件订阅接口：按类型订阅或全量监听，返回取消订阅函数
  readonly event: {
    readonly on: <Type extends OpenCodeEvent["type"]>(
      type: Type,
      handler: (event: OpenCodeEventMap[Type]) => void,
    ) => () => void
    readonly listen: (handler: (event: { name: OpenCodeEvent["type"]; details: OpenCodeEvent }) => void) => () => void
  }
  // 可选的连接状态探针：用于在断线期间抑制刷新，避免过期响应污染缓存
  readonly connection?: {
    readonly status: () => "connected" | "connecting" | "reconnecting"
  }
  /** Receives failed event-driven reads. Explicit reads still reject to their caller. */
  // 接收"事件驱动读取"失败的回调；显式调用的读取仍会把错误抛给调用方
  readonly onError?: (error: unknown) => void
  /**
   * Drops the payload of inline `data:` files in tool results before they enter the store. For clients that never
   * render tool-result files: a session full of screenshots otherwise keeps hundreds of MB of base64 alive.
   */
  // 在工具结果进入 store 之前，丢弃内联 `data:` 文件的 base64 载荷；
  // 适用于从不渲染工具结果文件的客户端：否则一个满是截图的会话会让数百 MB 的 base64 常驻内存
  readonly omitToolFileData?: boolean
}

// 消息分页的默认每页条数
const messagePageLimit = 20
// Trailing window for event bursts that each ask for the same refetch.
// 事件风暴（多个事件各自要求同一份重取）的收尾窗口：去抖等待时长（毫秒）
export const settleMs = 150

// Global MCP elicitations temporarily use "global" instead of a real session ID, so the
// server cannot recover their Location when settling them. Preserve the event Location
// until MCP elicitations carry session ownership.
// 全局 MCP 询问（elicitation）暂时用 "global" 代替真实会话 ID，服务端在处理它们时无法恢复其
// Location；在 MCP 询问携带会话归属之前，先在本地保留事件自带的 Location
export type FormWithLocation = FormInfo & { readonly location?: LocationRef }
// 带位置引用的 shell 信息（本地补充 Location，便于按目录定位）
type ShellWithLocation = ShellInfo & { readonly location: LocationRef }

// 单个位置（Location）的缓存数据：各类目录/清单 + 使用额度 + 运行中的 shell
type LocationData = {
  // 位置自身的信息（canonical 目录、项目 ID 等）
  info?: LocationGetOutput
  // VCS（Git）信息：分支、提供方等
  vcs?: VcsInfo
  // 可用 agent 列表
  agent?: AgentInfo[]
  // 可用命令列表
  command?: CommandInfo[]
  // 配置条目列表
  config?: ConfigEntry[]
  // 集成列表
  integration?: IntegrationInfo[]
  // MCP 服务器列表
  mcpServer?: McpServer[]
  // MCP 资源列表
  mcpResource?: McpResource[]
  // 模型列表
  model?: ModelInfo[]
  // 提供商列表
  provider?: ProviderInfo[]
  // 引用列表
  reference?: ReferenceInfo[]
  // 网页搜索提供商列表
  websearch?: WebSearchProvider[]
  // The Go allowance and Console budgets of the OpenCode Console workspace the location is signed in to; null when it
  // isn't signed in.
  // 该位置登录的 OpenCode Console 工作区的 Go 额度与 Console 预算；未登录时为 null
  usageLimits?: UsageLimitsInfo | null
  // Currently running shell commands for this location, keyed by shell id. Entries are removed
  // once the command exits or is deleted, so this only ever holds in-flight shells.
  // 此位置当前运行中的 shell 命令，按 shell id 索引；命令退出或被删除即移除条目，
  // 因此这里只保存进行中的 shell
  shell?: Record<string, ShellWithLocation>
  // 可用技能列表
  skill?: SkillInfo[]
}

// 整个数据 store 的形状：会话/项目/位置三大块
type Store = {
  session: {
    // 会话基本信息，按会话 ID 索引
    info: Record<string, SessionInfo>
    // 已确认被删除（404）的会话 ID 集合，用于把 UI 指向"已消失"状态
    missing: Record<string, true | undefined>
    // Family index keyed by a family's root (or furthest-known-ancestor when the
    // true root is not yet loaded). The value is a flat deduplicated list of every
    // session ID in that family, including the key itself once its info arrives.
    // 家族索引：键为家族根会话（真正的根未加载时为其最远已知祖先）；
    // 值是该家族内全部会话 ID 的去重平铺列表（根信息到达后包含键自身）
    family: Record<string, string[]>
    // 会话运行状态（idle/running）
    active: Record<string, DataSessionStatus>
    // 每个会话的消息列表
    message: Record<string, SessionMessageInfo[]>
    // 每个会话的消息分页游标（更早一页的取数锚点）
    messageCursor: Record<string, string | undefined>
    // 每个会话的消息分页"加载中"标记
    messageLoading: Record<string, boolean>
    // 每个会话的待处理输入（收件箱条目）
    pending: Record<string, SessionInboxInfo[]>
    // 每个会话待答复的权限请求
    permission: Record<string, PermissionRequest[]>
    // Pending forms keyed by owner: a session ID or the temporary "global" elicitation sentinel.
    // 待处理表单，按归属者索引：真实会话 ID，或临时的 "global"（全局 MCP 询问哨兵）
    form: Record<string, FormWithLocation[]>
  }
  project: {
    // 项目基本信息
    info: Record<string, Project>
    // 项目下已保存的权限规则
    permission: Record<string, PermissionSavedInfo[]>
  }
  // 各位置的缓存数据，按 locationKey（目录+工作区的 JSON 序列化）索引
  location: Record<string, LocationData>
}

// 把位置引用序列化为唯一字符串键（目录 + 工作区 ID）
export function locationKey(location: LocationRef) {
  // JSON 序列化二元组：workspaceID 缺失时为 null，保证键稳定可逆
  return JSON.stringify([location.directory, location.workspaceID])
}

// 构造发送给服务端的位置查询参数（只带目录；工作区由服务端解析）
function locationQuery(ref: LocationRef) {
  return { directory: ref.directory }
}

// 从提示的附件里提取可立即渲染的内联文件：把 data: URI 拆成 base64 载荷 + MIME，
// 用于乐观渲染用户消息；文件 URI 与技能等需要服务端解析的类型直接跳过
function optimisticFiles(files: SessionPromptInput["files"]) {
  const items = files?.flatMap((file) => {
    // 不是 data: URI 的附件（文件引用等）不参与乐观渲染
    if (!file.uri.startsWith("data:")) return []
    // data URI 的头与载荷以第一个逗号分隔
    const comma = file.uri.indexOf(",")
    // 没有载荷分隔符则无法拆分，跳过
    if (comma < 0) return []
    // 头部形如 "data:<mime>;base64"：截掉 "data:" 前缀（5 个字符）
    const header = file.uri.slice(5, comma)
    // 按分号拆出 MIME 与参数
    const parts = header.split(";")
    // 只接受 base64 编码的载荷
    if (!parts.slice(1).some((part) => part.toLowerCase() === "base64")) return []
    const item: NonNullable<Extract<SessionInboxInfo, { type: "user" }>["payload"]["files"]>[number] = {
      // 载荷：第一个逗号之后的 base64 内容
      data: file.uri.slice(comma + 1),
      // MIME 类型；缺失时回退为通用二进制类型
      mime: parts[0] || "application/octet-stream",
      source: { type: "inline" },
    }
    // 名称/描述/提及信息可选携带
    if (file.name !== undefined) item.name = file.name
    if (file.description !== undefined) item.description = file.description
    if (file.mention !== undefined) item.mention = { ...file.mention }
    return [item]
  })
  // 没有任何可内联的文件时返回 undefined（保持 payload 字段缺省）
  return items?.length ? items : undefined
}

// Keeps an empty `data:<mime>;base64,` URI so the item still says what it was. It is built from `mime` because any
// slice of the original URI is a V8 sliced string that keeps the whole payload alive.
// 保留一个空的 `data:<mime>;base64,` URI，使条目仍能表明自己是什么文件。用 `mime` 重新拼装而非
// 截取原 URI：原 URI 的任何切片都是 V8 的 sliced string，会连带保住整个 base64 载荷，无法释放内存
function omitFileData(content: [ToolContent, ...ToolContent[]]): [ToolContent, ...ToolContent[]] {
  // 单条内容处理：文件类型且 URI 是 data: 时替换为空载荷 URI，其余原样保留
  const omit = (item: ToolContent): ToolContent =>
    item.type === "file" && item.uri.startsWith("data:") ? { ...item, uri: `data:${item.mime};base64,` } : item
  // 首条内容与其他条目分别做同样的脱敏
  return [omit(content[0]), ...content.slice(1).map(omit)]
}

// 对整条消息做内联文件脱敏：只处理助手消息，遍历其内容部件，
// 把工具状态里的文件内容数组全部替换为空载荷版本
function omitMessageFileData(message: SessionMessageInfo): SessionMessageInfo {
  // 仅助手消息携带工具结果
  if (message.type !== "assistant") return message
  return {
    ...message,
    // 逐部件替换：工具部件且其状态带内容数组时才处理
    content: message.content.map((part) =>
      part.type === "tool" && "content" in part.state && part.state.content
        ? { ...part, state: { ...part.state, content: omitFileData(part.state.content) } }
        : part,
    ),
  }
}

// 构造表单请求的附加选项：仅当处理 "global" 全局询问且带位置引用时，
// 通过自定义头告知服务端目标目录
function formRequestOptions(sessionID: string, ref?: LocationRef) {
  // 非全局表单或不带位置时无需附加头
  if (sessionID !== "global" || !ref) return undefined
  return {
    headers: {
      // 目录需 URL 编码后放入请求头
      "x-opencode-directory": encodeURIComponent(ref.directory),
    },
  }
}

// 创建"同步协调器"：按 key 跟踪每个缓存读取的状态，串行重验证并防止过期响应提交。
// 这是整个数据层"旧响应不得晚于新响应提交"承诺的核心实现
function createSync() {
  // `started` is false while a reload waits for the load it replaces. Invalidations that land in
  // that window are already covered, since the reload has not read anything yet.
  // Pending 状态：in-flight 的读取记录。`started` 为 false 表示该重载还在等待它要替换的旧读取；
  // 落在这个窗口内的失效已被覆盖——因为该重载还没有真正发起任何读取
  type Pending = { promise: Promise<void>; invalidated: boolean; started: boolean }
  // 状态表：key -> true（已完成且有效）| Pending（进行中）；无条目 = 需要读取
  const state = new Map<string, true | Pending>()
  // 启动一次读取：可选地先等待旧读取结束（wait），并按 invalidated 标记决定是否把结果记为有效
  const start = (key: string, load: () => Promise<void>, wait?: Promise<void>) => {
    const entry: Pending = { promise: Promise.resolve(), invalidated: false, started: !wait }
    state.set(key, entry)
    const run = () => {
      // 真正发起读取前才置 started：等待窗口内的失效不重复排队
      entry.started = true
      return load()
    }
    entry.promise = (wait ? wait.catch(() => undefined).then(run) : run())
      .then(() => {
        // 读取成功且期间未被失效：登记为"已完成且有效"
        if (state.get(key) === entry && !entry.invalidated) state.set(key, true)
      })
      .finally(() => {
        // 无论成败，只要仍是当前条目就清空（失败即回到"未读取"状态）
        if (state.get(key) === entry) state.delete(key)
      })
    return entry.promise
  }
  return {
    // 发起一次同步：已完成直接返回；无记录则启动；进行中且未失效则复用其 promise；
    // 已失效则在旧读取结束后串行地再读一次（保证顺序，防止旧响应后提交）
    run(key: string, load: () => Promise<void>) {
      const active = state.get(key)
      if (active === true) return Promise.resolve()
      if (!active) return start(key, load)
      if (!active.invalidated) return active.promise
      return start(key, load, active.promise)
    },
    // 直接标记某 key 为"已完成"：跳过读取（例如新会话的空集合，无需向服务端取数）
    complete(key: string) {
      if (state.has(key)) return
      state.set(key, true)
    },
    // 该 key 是否已有登记（完成或进行中）
    has(key: string) {
      return state.has(key)
    },
    // 该 key 是否处于进行中的读取
    pending(key: string) {
      const active = state.get(key)
      return active !== undefined && active !== true
    },
    // 失效：带 key 只失效一项；不带 key 全部失效（断线重连场景）。
    // 已完成项直接删除；已启动的进行中读取打上 invalidated 标记，结束后不再记为有效
    invalidate(key?: string) {
      if (key) {
        const active = state.get(key)
        if (active === true) state.delete(key)
        if (active !== undefined && active !== true && active.started) active.invalidated = true
        return
      }
      state.forEach((active, current) => {
        if (active === true) state.delete(current)
        if (active !== true && active.started) active.invalidated = true
      })
    },
  }
}

// 家族子会话列表的分页大小
const CHILD_PAGE = 200
// 已删除会话的"墓碑"缓存上限：防止长期运行下 deletedAt 映射无限增长
const DELETED_SESSION_LIMIT = 512

// 数据层主入口：创建 store、注册事件处理、暴露读/写/同步的完整 API
export function createData(config: CreateDataInput) {
  const api = config.api
  // 组件卸载标记：卸载后所有刷新直接短路
  let disposed = false
  onCleanup(() => (disposed = true))

  // 统一的刷新入口：仅在已连接且未卸载时执行 load；失败按错误类型分类处理
  function refresh(load: () => Promise<unknown>) {
    // 未卸载且（若有连接探针）处于连接状态才发起读取
    if (disposed || (config.connection && config.connection.status() !== "connected")) return
    void load().catch((error) => {
      // 失败时再次校验状态：错误可能是延迟到达的，此时不必处理
      if (disposed || (config.connection && config.connection.status() !== "connected")) return
      // 会话不存在：标记删除并移除本地缓存
      if (isSessionNotFoundError(error)) {
        markDeleted(error.sessionID)
        return
      }
      // 消息不存在：静默忽略（通常已被服务端清理）
      if (isMessageNotFoundError(error)) return
      // 其余错误交给调用方注册的 onError；未注册则打印到控制台
      if (config.onError) return config.onError(error)
      console.error("Failed to refresh client data", error)
    })
  }

  // Runs `load` once a burst of same-key events goes quiet, so N events cost one refetch.
  // 同 key 事件风暴的去抖：等风暴平息后再跑一次 load，N 个事件只花一次重取的代价
  const settling = new Map<string, ReturnType<typeof setTimeout>>()
  onCleanup(() => settling.forEach((timer) => clearTimeout(timer)))
  function settle(key: string, load: () => Promise<unknown>) {
    // 重置该 key 的去抖计时器：每次事件都把执行推迟 settleMs
    clearTimeout(settling.get(key))
    settling.set(
      key,
      setTimeout(() => {
        settling.delete(key)
        refresh(load)
      }, settleMs),
    )
  }

  // 创建根 store：session / project / location 三大块，全部初始为空
  const [store, setStore] = createStore<Store>({
    session: {
      info: {},
      missing: {},
      family: {},
      active: {},
      message: {},
      messageCursor: {},
      messageLoading: {},
      pending: {},
      permission: {},
      form: {},
    },
    project: {
      info: {},
      permission: {},
    },
    location: {},
  })

  // 默认位置引用的信号：初始为配置里的工作目录
  const [defaultLocation, setDefaultLocation] = createSignal<LocationRef>({ directory: config.directory })
  // 全部会话按最近更新时间倒序的记忆列表（UI 列表用）
  const sessions = createMemo(() =>
    Object.values(store.session.info).toSorted((a, b) => b.time.updated - a.time.updated),
  )
  // 消息索引：会话 ID ->（消息 ID -> 数组下标），让事件流按 ID 精确定位消息，避免全量扫描
  const messageIndex = new Map<string, Map<string, number>>()
  // 入库前的消息加工：需要脱敏时剔除工具结果里的内联文件载荷
  const stored = (message: SessionMessageInfo) => (config.omitToolFileData ? omitMessageFileData(message) : message)
  // 同步协调器实例
  const sync = createSync()
  // 连接 hydration 期间的活动状态更新缓冲：快照到达后合并，避免覆盖事件流已给出的状态
  let activeUpdates: Map<string, DataSessionStatus | undefined> | undefined
  // 各会话 pending 读取期间的乐观更新缓冲：快照返回后先合并再落库，防止快照覆盖事件
  const pendingUpdates = new Map<string, Map<string, SessionInboxInfo | SessionInbox.Delivery | undefined>>()

  // 写入会话运行状态；若处于 hydration 窗口则同时记入缓冲
  function setSessionActive(sessionID: string, status: DataSessionStatus) {
    activeUpdates?.set(sessionID, status)
    setStore("session", "active", sessionID, status)
  }

  // 从 pending 移除一条收件箱条目（可选的 inboxID 缺省时什么都不做）
  function removePending(sessionID: string, inboxID?: string) {
    if (!inboxID) return
    // 同步记录到缓冲，保证并发的 pending 读取不会把已删除的条目带回来
    pendingUpdates.get(sessionID)?.set(inboxID, undefined)
    if (store.session.pending[sessionID]?.some((item) => item.id === inboxID))
      setStore(
        "session",
        "pending",
        sessionID,
        (store.session.pending[sessionID] ?? []).filter((item) => item.id !== inboxID),
      )
  }

  // 从权限列表移除一条请求；不存在则无操作
  function removePermission(sessionID: string, requestID: string) {
    const requests = store.session.permission[sessionID]
    if (!requests?.some((request) => request.id === requestID)) return
    setStore(
      "session",
      "permission",
      sessionID,
      requests.filter((request) => request.id !== requestID),
    )
  }

  // 从表单列表移除指定表单；全局表单需按位置过滤。返回是否真的移除了条目
  function removeForm(sessionID: string, formID: string, ref?: LocationRef) {
    const forms = store.session.form[sessionID]
    if (!forms) return false
    const location = ref && locationKey(ref)
    const next = forms.filter((form) => {
      // 非目标表单一律保留
      if (form.id !== formID) return true
      // 非全局表单（或未给位置）按 ID 直接删除
      if (sessionID !== "global" || !location) return false
      // 全局表单只删除位置匹配的那一条
      return !form.location || locationKey(form.location) !== location
    })
    // 长度未变说明没有删除任何条目
    if (next.length === forms.length) return false
    setStore("session", "form", sessionID, next)
    return true
  }

  // 表单答复/取消的统一收尾：吞掉"表单不存在/已处理"错误（服务端已代为处理），
  // 成功后移除本地条目并重新同步表单列表
  function settleForm(input: SessionFormCancelInput, ref: LocationRef | undefined, request: Promise<void>) {
    return request
      .catch((error: unknown) => {
        // 只有当错误是"表单不存在/已处理"且 ID 匹配时才吞掉；其余继续抛出
        if ((!isFormNotFoundError(error) && !isFormAlreadySettledError(error)) || error.id !== input.formID) throw error
      })
      .then(() => {
        // 本地未移除成功（可能已不在列表）则不再刷新
        if (!removeForm(input.sessionID, input.formID, ref)) return
        result.session.form.invalidate(input.sessionID, ref)
        void result.session.form.sync(input.sessionID, ref).catch(() => undefined)
      })
  }

  // 更新某条 pending 的投递方式（steer/queue）：同时记录到缓冲并精确更新 store 下标
  function updatePending(sessionID: string, inboxID: string, delivery: SessionInbox.Delivery) {
    const index = store.session.pending[sessionID]?.findIndex((item) => item.id === inboxID) ?? -1
    const item = store.session.pending[sessionID]?.[index]
    // 缓冲中记录"合并后的条目"或"仅投递方式变更"，供并发快照合并
    pendingUpdates.get(sessionID)?.set(inboxID, item ? { ...item, delivery } : delivery)
    // 本地没有该条目或投递方式没变则不必写 store
    if (index < 0 || !item || item.delivery === delivery) return
    setStore("session", "pending", sessionID, index, { ...item, delivery })
  }

  // Inbox IDs of optimistic admissions awaiting acknowledgement, so rejection
  // only rolls back unacknowledged rows and a pending re-fetch cannot wipe a
  // row the server does not know about yet. Prompts clear on their durable
  // echo, positive pending read, or rollback; compactions also reconcile the
  // POST's canonical ID.
  // 等待服务端确认的乐观收件箱条目 ID 集合：拒绝时只回滚未确认的行，
  // pending 重取也不会抹掉服务端尚不知情的行。提示（prompt）在收到持久化回声、
  // 读到正向 pending 结果或回滚时清除；压缩（compaction）还会按 POST 的正式 ID 对账
  const outbox = new Set<string>()

  // Session IDs of optimistic create admissions still awaiting acknowledgement
  // (the session.created echo or the create response itself). A failed create
  // only rolls back a session the server never acknowledged. Unlike
  // `creating`, this clears on the echo rather than request settlement.
  // 等待确认的乐观会话创建 ID 集合（等待 session.created 回声或创建响应本身）。
  // 创建失败只回滚服务端从未确认过的会话。与 `creating` 不同：
  // 这里在收到回声时清除，而非请求结束时清除
  const sessionOutbox = new Set<string>()

  // In-flight optimistic creates by session ID. prompt() gates its POST on
  // this so a prompt sent to a still-creating session waits for the session
  // to exist server-side instead of failing with "not found".
  // 进行中的乐观会话创建（按会话 ID 索引的 promise）。prompt() 的 POST 以此为闸门：
  // 发给"仍在创建中"会话的提示会等会话在服务端存在后再发，而不是报"not found"
  const creating = new Map<string, Promise<unknown>>()

  // Per-session send chain: prompts and compactions must be admitted in
  // submission order. Each waits for the previous POST to settle, so one
  // failure does not block the next.
  // 每会话的发送链：提示与压缩必须按提交顺序被受理。每次都等上一个 POST 结束，
  // 因此一次失败不会阻塞后续的发送
  const sending = new Map<string, Promise<unknown>>()
  // 进行中的消息分页加载（按会话 ID 索引），避免并发 loadMore 相互踩踏
  const messageLoads = new Map<string, Promise<unknown>>()
  // 进行中的压缩请求：记录提议 ID、已观察到的正式 ID 与请求 promise
  const compacting = new Map<string, { id: string; observed: Set<string>; request: Promise<SessionInboxCompaction> }>()
  onCleanup(() => compacting.clear())

  // Register `promise` under `key` until it settles. A later registration
  // replaces an earlier one; settlement only clears its own entry.
  // 在 map 中按 key 登记 promise 直到其结束：后登记的会替换先前的；
  // 结束时只清除自己那条（不会误删后来者）
  function track(map: Map<string, Promise<unknown>>, key: string, promise: Promise<unknown>) {
    map.set(key, promise)
    const settle = () => {
      if (map.get(key) === promise) map.delete(key)
    }
    void promise.then(settle, settle)
  }

  // Capture creation before settlement clears its entry, so dependent RPCs still see a failed create.
  // 发送受理的统一入口：先取"创建中"的 promise，再排队到该会话的发送链末尾；
  // 创建 promise 在其结束前先被捕获，即便创建失败，依赖它的后续 RPC 仍能看到它
  function sendAdmission<Value>(sessionID: string, send: () => Promise<Value>, gate?: Promise<unknown>) {
    const created = creating.get(sessionID)
    const previous = sending.get(sessionID)
    const request = Promise.resolve()
      // 依次等待可选闸门、会话创建、上一次发送全部结束后才执行本次发送
      .then(() => Promise.all([gate, created, previous]))
      .then(send)
    track(
      sending,
      sessionID,
      request.catch(() => undefined),
    )
    return request
  }

  // Upsert an admitted inbox item into pending and (for user and synthetic
  // items) the visible transcript. Used by the inbox.enqueued
  // handler and by optimistic admission; the upsert is what reconciles
  // the durable echo with an optimistic placeholder — the durable payload and
  // times replace the client's guess.
  // 把已受理的收件箱条目 upsert 进 pending，且（对 user/synthetic 条目）同步到可见消息记录。
  // inbox.enqueued 处理器与乐观受理都走这里：upsert 正是把持久化回声与乐观占位对账的机制——
  // 服务端的正式载荷与时间戳会替换客户端的猜测
  function admitLocal(item: SessionInboxInfo) {
    batch(() => {
      const pending = store.session.pending[item.sessionID] ?? []
      const at = pending.findIndex((entry) => entry.id === item.id)
      setStore(
        "session",
        "pending",
        item.sessionID,
        // 不存在则追加，已存在则原位替换（保留其他条目的顺序）
        at < 0 ? [...pending, item] : pending.map((entry, index) => (index === at ? item : entry)),
      )
      // 压缩条目不进消息记录
      if (item.type === "compaction") return
      materializeInboxMessage(item)
    })
  }

  // 把 user/synthetic 收件箱条目物化为可见的消息行：不存在则追加，已存在则替换
  // （替换时以服务端载荷为准，完成乐观占位 -> 正式数据的转变）
  function materializeInboxMessage(item: SessionInboxInfo) {
    if (item.type !== "user" && item.type !== "synthetic") return
    message.update(item.sessionID, (draft, index) => {
      const row =
        item.type === "user"
          ? { id: item.id, type: "user" as const, ...item.payload, time: { created: item.time.created } }
          : { id: item.id, type: "synthetic" as const, ...item.payload, time: { created: item.time.created } }
      const position = index.get(item.id)
      if (position === undefined) return message.append(draft, index, row)
      draft[position] = row
    })
  }

  // Remove an inbox item from pending, input, and the visible transcript.
  // Used by the inbox.cancelled handler and by optimistic rollback.
  // 把收件箱条目从 pending、输入与可见消息记录中移除。
  // inbox.cancelled 事件处理器与乐观回滚都走这里
  function retractLocal(sessionID: string, inboxID: string) {
    batch(() => {
      removePending(sessionID, inboxID)
      // 消息记录里没有该条目则到此为止
      if (!messageIndex.get(sessionID)?.has(inboxID)) return
      message.update(sessionID, (draft, index) => {
        const position = index.get(inboxID)
        if (position === undefined) return
        // 从数组中删除该消息并删除索引
        draft.splice(position, 1)
        index.delete(inboxID)
        // 从删除点起重建后续下标
        message.reindex(draft, index, position)
      })
    })
  }

  // 消息记录的底层操作集合：更新/追加/插入/按类型精确编辑/查找/重排索引
  const message = {
    // 以 produce 草稿模式更新某会话的消息数组，同时保证索引可用（不存在则惰性建）
    update(sessionID: string, fn: (messages: SessionMessageInfo[], index: Map<string, number>) => void) {
      setStore(
        "session",
        "message",
        produce((draft) => {
          fn((draft[sessionID] ??= []), index(sessionID))
        }),
      )
    },
    // 追加消息：ID 已存在则跳过；登记索引后再入数组（保持索引与数组一致）
    append(messages: SessionMessageInfo[], index: Map<string, number>, item: SessionMessageInfo) {
      if (index.has(item.id)) return
      index.set(item.id, messages.length)
      messages.push(item)
    },
    // 向会话插入一条消息（不存在的追加）
    insert(sessionID: string, item: SessionMessageInfo) {
      message.update(sessionID, (draft, index) => message.append(draft, index, item))
    },
    // Streaming events target one assistant message and, within it, the latest part of a kind.
    // A missing target means the row was never loaded or was evicted; the event is dropped.
    // 精确编辑某条助手消息。流式事件只针对一条助手消息；找不到目标说明该行从未加载
    // 或已被驱逐，事件直接丢弃
    editAssistant(sessionID: string, messageID: string, fn: (assistant: SessionMessageAssistant) => void) {
      if (!messageIndex.get(sessionID)?.has(messageID)) return
      message.update(sessionID, (draft, index) => {
        const position = index.get(messageID)
        const item = position === undefined ? undefined : draft[position]
        if (item?.type === "assistant") fn(item)
      })
    },
    // 编辑助手消息里指定 ID 的工具部件（取同类中最后一个匹配项）
    editTool(sessionID: string, messageID: string, toolID: string, fn: (tool: SessionMessageAssistantTool) => void) {
      message.editAssistant(sessionID, messageID, (assistant) => {
        const tool = assistant.content.findLast(
          (item): item is SessionMessageAssistantTool => item.type === "tool" && item.id === toolID,
        )
        if (tool) fn(tool)
      })
    },
    // 编辑助手消息里最后一个文本部件
    editText(sessionID: string, messageID: string, fn: (text: SessionMessageAssistantText) => void) {
      message.editAssistant(sessionID, messageID, (assistant) => {
        const text = assistant.content.findLast((item): item is SessionMessageAssistantText => item.type === "text")
        if (text) fn(text)
      })
    },
    // 编辑助手消息里最后一个未完成的推理部件
    editReasoning(sessionID: string, messageID: string, fn: (reasoning: SessionMessageAssistantReasoning) => void) {
      message.editAssistant(sessionID, messageID, (assistant) => {
        const reasoning = assistant.content.findLast(
          (item): item is SessionMessageAssistantReasoning => item.type === "reasoning" && !item.time?.completed,
        )
        if (reasoning) fn(reasoning)
      })
    },
    // 找出最后一条未完成的助手消息（即"活动助手"）
    activeAssistant(messages: SessionMessageInfo[]) {
      const item = messages.findLast((item) => item.type === "assistant" && !item.time.completed)
      return item?.type === "assistant" ? item : undefined
    },
    // 按 shell ID 找最后一条 shell 消息
    shell(messages: SessionMessageInfo[], shellID: string) {
      const item = messages.findLast((item) => item.type === "shell" && item.shellID === shellID)
      return item?.type === "shell" ? item : undefined
    },
    // 找最后一条运行中的压缩消息
    compaction(messages: SessionMessageInfo[]) {
      const item = messages.findLast((item) => item.type === "compaction" && item.status === "running")
      return item?.type === "compaction" ? item : undefined
    },
    // 从 start 起重建"消息 ID -> 下标"索引（删除/插入后调用）
    reindex(messages: SessionMessageInfo[], index: Map<string, number>, start: number) {
      for (let position = start; position < messages.length; position++) {
        const item = messages[position]
        if (item) index.set(item.id, position)
      }
    },
  }

  // 取某会话的消息索引映射；不存在则惰性创建并登记
  function index(sessionID: string) {
    const existing = messageIndex.get(sessionID)
    if (existing) return existing
    const created = new Map<string, number>()
    messageIndex.set(sessionID, created)
    return created
  }

  // Every direct subagent, not only the server's default first page, so a root's family cost
  // counts all of them. Pages stay newest first, the order the family index has always used.
  // 拉取全部直接子会话（不止服务端默认第一页），使根会话的家族成本统计包含所有子会话。
  // 分页保持"最新在前"——家族索引一直使用的顺序
  async function listChildren(input: SessionListInput): Promise<SessionInfo[]> {
    const page = await api().session.list(input)

    // 页未满或没有下一页游标即到头
    if (page.data.length < CHILD_PAGE || !page.cursor.next) return page.data

    return [...page.data, ...(await listChildren({ cursor: page.cursor.next, limit: CHILD_PAGE }))]
  }

  // Walk parentID upward through loaded session info to the family root. When a
  // parent's info is missing, that missing ID is the furthest-known ancestor and
  // is returned so orphan subtrees group under it until the parent arrives. A
  // seen set guards against parent cycles, stopping at the last non-repeating
  // ancestor.
  // 沿 parentID 向上遍历已加载的会话信息直到家族根。父级信息缺失时，该缺失的 ID 就是
  // 最远已知祖先并被返回——孤儿子树先挂在它下面，等父级到达后再归位。
  // seen 集合防父级环：停在最后一个不重复的祖先
  function resolveRoot(sessionID: string) {
    let current = sessionID
    let parentID = store.session.info[sessionID]?.parentID
    const seen = new Set([sessionID])
    while (parentID) {
      // 父级出现过说明存在环，立即停止
      if (seen.has(parentID)) break
      seen.add(parentID)
      current = parentID
      parentID = store.session.info[parentID]?.parentID
    }
    return current
  }

  // Register one session into the family index. Idempotent: syncing an
  // existing session never duplicates its ID. When a tentative family keyed by
  // sessionID exists (descendants arrived while sessionID's own info was
  // absent) but sessionID turns out to have a parent, fold the orphan subtree
  // into the resolved root's family and drop the tentative entry.
  // 把一个会话登记进家族索引。幂等：重复同步不会产生重复 ID。
  // 若存在以 sessionID 为键的临时家族（sessionID 自己的信息缺席时其后代先到了），
  // 而 sessionID 实际有父级，则把孤儿子树折叠进其真正根的家族并删除临时条目
  function registerSession(sessionID: string) {
    const info = store.session.info[sessionID]
    // 信息尚未加载则无从解析父级，先不登记
    if (!info) return
    const rootID = resolveRoot(sessionID)
    setStore(
      "session",
      "family",
      produce((draft) => {
        if (sessionID !== rootID && draft[sessionID]) {
          const members = (draft[rootID] ??= [])
          // 把临时家族里的全部成员并入真正的根家族（去重）
          for (const id of draft[sessionID]) {
            if (!members.includes(id)) members.push(id)
          }
          delete draft[sessionID]
        }
        const family = (draft[rootID] ??= [])
        if (!family.includes(sessionID)) family.push(sessionID)
      }),
    )
  }

  // 驱逐某个会话的重缓存（消息/pending/游标/加载状态），用于释放内存或强制重新加载。
  // 乐观待确认的提交与消息保留，避免把尚未确认的本地行清掉
  function evictSession(sessionID: string) {
    if (sessionOutbox.has(sessionID)) return
    sync.invalidate(`session.pending:${sessionID}`)
    sync.invalidate(`session.message:${sessionID}`)
    messageLoads.delete(sessionID)
    // Keep unacknowledged submissions until their echo or rollback settles them.
    // 未确认的提交要保留，直到其回声或回滚把它们结算掉
    const pending = store.session.pending[sessionID]?.filter((item) => outbox.has(item.id)) ?? []
    const messages = store.session.message[sessionID]?.filter((item) => outbox.has(item.id)) ?? []
    messageIndex.delete(sessionID)
    // 有保留的乐观消息时按新数组重建索引
    if (messages.length) messageIndex.set(sessionID, new Map(messages.map((item, index) => [item.id, index])))
    setStore(
      "session",
      produce((draft) => {
        delete draft.message[sessionID]
        delete draft.messageCursor[sessionID]
        delete draft.messageLoading[sessionID]
        delete draft.pending[sessionID]
        if (messages.length) draft.message[sessionID] = messages
        if (pending.length) draft.pending[sessionID] = pending
      }),
    )
  }

  // 删除纪元：每次标记删除都递增，用来判断"读取期间会话是否被删除"
  let deletionEpoch = 0
  // 会话 ID -> 标记删除时的纪元号（按插入序即时间序，便于淘汰最旧的墓碑）
  const deletedAt = new Map<string, number>()

  // 清除某会话的删除标记（重新创建/重新同步成功时调用）
  function clearDeleted(sessionID: string) {
    deletedAt.delete(sessionID)
    if (store.session.missing[sessionID]) setStore("session", "missing", sessionID, undefined)
  }

  // 标记会话已删除：记录纪元墓碑、淘汰超限的最旧墓碑、置 missing 并移除本地缓存
  function markDeleted(sessionID: string) {
    if (sessionOutbox.has(sessionID)) return
    batch(() => {
      deletedAt.delete(sessionID)
      deletedAt.set(sessionID, ++deletionEpoch)
      if (deletedAt.size > DELETED_SESSION_LIMIT) {
        // Map 保持插入序，队头即最旧的墓碑
        const oldest = deletedAt.keys().next().value
        if (oldest !== undefined) {
          deletedAt.delete(oldest)
          setStore("session", "missing", oldest, undefined)
        }
      }
      setStore("session", "missing", sessionID, true)
      removeSession(sessionID)
    })
  }

  // 读取失败的统一逃生口：会话不存在则标记删除，随后原样抛出让调用方感知
  function evictMissing(error: unknown): never {
    if (isSessionNotFoundError(error)) markDeleted(error.sessionID)
    throw error
  }

  // 从 store 彻底移除一个会话：失效全部相关缓存键并删除所有字段，
  // 同时把该 ID 从所有家族列表中摘除（空家族整个删除）
  function removeSession(sessionID: string) {
    activeUpdates?.set(sessionID, undefined)
    store.session.pending[sessionID]?.forEach((item) => outbox.delete(item.id))
    messageIndex.delete(sessionID)
    sync.invalidate(`session:${sessionID}`)
    sync.invalidate(`session.family:${sessionID}`)
    sync.invalidate(`session.pending:${sessionID}`)
    sync.invalidate(`session.message:${sessionID}`)
    sync.invalidate(`session.permission:${sessionID}`)
    sync.invalidate(`session.form:${sessionID}:`)
    setStore(
      "session",
      produce((draft) => {
        delete draft.info[sessionID]
        delete draft.active[sessionID]
        delete draft.message[sessionID]
        delete draft.messageCursor[sessionID]
        delete draft.messageLoading[sessionID]
        delete draft.pending[sessionID]
        delete draft.permission[sessionID]
        delete draft.form[sessionID]
        for (const [rootID, family] of Object.entries(draft.family)) {
          const next = family.filter((id) => id !== sessionID)
          if (next.length === 0) delete draft.family[rootID]
          else draft.family[rootID] = next
        }
      }),
    )
  }

  // 事件分发中枢：按事件类型把服务端事件投影到 store。
  // 这是"事件流作为真相来源"的核心：绝大多数缓存更新都在这里发生
  function handleEvent(event: OpenCodeEvent) {
    switch (event.type) {
      case "server.connected": {
        const updates = new Map<string, DataSessionStatus | undefined>()
        // 进入 hydration 窗口：此后的生命周期事件先记入缓冲
        activeUpdates = updates
        refresh(() =>
          api()
            .session.active()
            .then((active) => {
              // 缓冲已被别的连接流程替换则丢弃本次快照
              if (activeUpdates !== updates) return
              // Lifecycle events received during hydration supersede the snapshot.
              // hydration 期间收到的事件状态优先于快照：先建"全部 running"的快照，
              // 再用缓冲覆盖（undefined 表示事件已把它置为空闲）
              const snapshot = new Map<string, DataSessionStatus>(Object.keys(active).map((id) => [id, "running"]))
              updates.forEach((status, id) => {
                if (status === undefined) return snapshot.delete(id)
                snapshot.set(id, status)
              })
              activeUpdates = undefined
              setStore("session", "active", reconcile(Object.fromEntries(snapshot)))
              // Sessions created before this connection (while disconnected, or before the client started)
              // never delivered `session.created`; without their info a running child never joins its root's family.
              // 在本次连接之前创建的会话（断线期间或客户端启动前）从未发来 session.created；
              // 没有它们的信息，运行中的子会话永远无法加入其根的家族——这里补一次同步
              snapshot.forEach((status, id) => {
                if (status === "running" && !store.session.info[id]) refresh(() => result.session.sync(id))
              })
            })
            .catch(() => {
              if (activeUpdates === updates) activeUpdates = undefined
            }),
        )
        // 同步默认位置的基础信息
        refresh(() =>
          api()
            .location.get({ location: locationQuery(defaultLocation()) })
            .then((location) => {
              const key = locationKey(location)
              setStore("location", key, { info: location })
            }),
        )
        refresh(() => result.location.vcs.sync())
        refresh(() => result.project.sync())
        return
      }
      case "project.updated":
        // 项目信息整体 reconcile 替换，精确触发依赖更新
        setStore("project", "info", event.data.id, reconcile(event.data))
        return
      case "session.created":
        clearDeleted(event.data.sessionID)
        sessionOutbox.delete(event.data.sessionID)
        result.session.invalidate(event.data.sessionID)
        refresh(() => result.session.sync(event.data.sessionID))
        // Band-aid: a newly created session starts empty, so live events can be its source of truth.
        // Fetching pending inputs and projected messages separately lets promotion move an input between snapshots,
        // causing both requests to miss it and overwrite event-built state. Skip those racy initial reads until
        // hydration can load pending and projected messages atomically.
        // 权宜处理：新建会话从零开始，实时事件就是它的真相来源。分开拉取 pending 输入与投影
        // 消息会让"提升"操作把一条输入在两个快照间搬动，两次请求都错过它并覆盖事件构建的
        // 状态。在 hydration 能原子地加载 pending 与投影消息之前，跳过这些有竞态的初始读取
        sync.complete(`session.pending:${event.data.sessionID}`)
        sync.complete(`session.message:${event.data.sessionID}`)
        return
      case "session.deleted":
        markDeleted(event.data.sessionID)
        return
      case "session.usage.updated":
        // 只有已加载的会话才更新用量；未加载的等首次同步时自然带上
        if (store.session.info[event.data.sessionID])
          setStore("session", "info", event.data.sessionID, {
            cost: event.data.cost,
            tokens: event.data.tokens,
          })
        return
      case "session.agent.selected": {
        const previous = store.session.info[event.data.sessionID]?.agent
        if (store.session.info[event.data.sessionID])
          setStore("session", "info", event.data.sessionID, "agent", event.data.agent)
        // 插入一条"切换 agent"的可见消息行（ID 由事件确定性生成，保证幂等）
        message.insert(event.data.sessionID, {
          id: SessionMessage.ID.fromEvent(event.id),
          type: "agent-switched",
          agent: event.data.agent,
          previous,
          time: { created: event.created },
        })
        return
      }
      case "session.model.selected": {
        const previous = event.data.previous ?? store.session.info[event.data.sessionID]?.model
        if (store.session.info[event.data.sessionID])
          setStore("session", "info", event.data.sessionID, "model", event.data.model)
        // 消息记录尚未加载则不插入切换行（首次同步会带上完整历史）
        if (!store.session.message[event.data.sessionID]) return
        message.insert(event.data.sessionID, {
          id: SessionMessage.ID.fromEvent(event.id),
          type: "model-switched",
          model: event.data.model,
          previous,
          time: { created: event.created },
        })
        // 回读该消息的正式版本，覆盖本地投影，保证字段完整
        refresh(() =>
          api()
            .session.message.get({ sessionID: event.data.sessionID, messageID: SessionMessage.ID.fromEvent(event.id) })
            .then((item) => {
              message.update(event.data.sessionID, (draft, index) => {
                const position = index.get(item.id)
                if (position === undefined) return message.append(draft, index, item)
                draft[position] = item
              })
            }),
        )
        return
      }
      case "session.renamed": {
        // Preserve the live title when it races the session's initial read.
        // 重命名与会话初次读取竞争时，保证最终写入的是最新标题：
        // 先等会话同步（家族读取进行中则连子会话一起）完成，再写标题
        refresh(() => {
          const family = sync.pending(`session.family:${event.data.sessionID}`)
            ? result.session.sync(event.data.sessionID, { children: true })
            : Promise.resolve()
          return Promise.all([result.session.sync(event.data.sessionID), family]).then(() => {
            if (store.session.info[event.data.sessionID])
              setStore("session", "info", event.data.sessionID, "title", event.data.title)
          })
        })
        return
      }
      case "session.permissions":
        if (store.session.info[event.data.sessionID])
          setStore("session", "info", event.data.sessionID, "permissions", event.data.permissions)
        return
      case "session.metadata.updated":
        // The event carries the whole record, so keys it drops must go too.
        // 事件携带完整的元数据记录，reconcile 会把被事件删掉的键也一并移除
        if (store.session.info[event.data.sessionID])
          setStore("session", "info", event.data.sessionID, "metadata", reconcile(event.data.metadata))
        return
      case "session.archived":
        if (store.session.info[event.data.sessionID])
          setStore("session", "info", event.data.sessionID, "time", "archived", event.created)
        return
      case "session.unarchived":
        if (store.session.info[event.data.sessionID])
          setStore("session", "info", event.data.sessionID, "time", "archived", undefined)
        return
      case "session.moved": {
        const current = store.session.info[event.data.sessionID]
        if (current) {
          // 先快照旧位置，供 UI 展示"从哪搬到哪"
          const previous = {
            location: { ...current.location },
            projectID: current.projectID,
            subpath: current.subpath,
          }
          setStore("session", "info", event.data.sessionID, "location", event.data.location)
          setStore("session", "info", event.data.sessionID, "projectID", event.data.projectID)
          setStore("session", "info", event.data.sessionID, "subpath", event.data.subpath)
          message.insert(event.data.sessionID, {
            id: SessionMessage.ID.fromEvent(event.id),
            type: "location-switched",
            location: event.data.location,
            projectID: event.data.projectID,
            subpath: event.data.subpath,
            previous,
            time: { created: event.created },
          })
        }
        return
      }
      case "worktree.resolved": {
        // 工作树归属解析：遍历全部已知会话，尝试把各自的项目 ID/目录归并到新工作树
        for (const [sessionID, info] of Object.entries(store.session.info)) {
          // 项目被显式收养时用其 canonical 目录，否则用会话自身位置目录
          const explicit = event.data.adopted?.includes(info.projectID)
          const directory = explicit ? store.project.info[info.projectID]?.canonical : info.location.directory
          if (!directory) {
            // 目录缺失：失效并重新同步会话，等待下次机会
            result.session.invalidate(sessionID)
            refresh(() => result.session.sync(sessionID))
            continue
          }
          const adopted = Worktree.adopt(
            {
              projectID: info.projectID,
              directory,
            },
            event.data,
          )
          // 无法归并到该工作树的会话跳过
          if (!adopted) continue
          setStore("session", "info", sessionID, "projectID", adopted.projectID)
          setStore("session", "info", sessionID, "subpath", adopted.subpath)
        }
        return
      }
      case "session.inbox.delivered": {
        // 收件箱条目被投递：先看本地是否承认过这个乐观提交
        const admitted = result.session.input.has(event.data.sessionID, event.data.inboxID)
        removePending(event.data.sessionID, event.data.inboxID)
        message.update(event.data.sessionID, (draft, index) => {
          const position = index.get(event.data.inboxID)
          if (position === undefined) return
          const existing = draft[position]
          if (!existing || !admitted) return
          // 以服务端时间修正创建时间，并把消息移到末尾（对齐服务端的排序）
          existing.time.created = event.created
          draft.splice(position, 1)
          draft.push(existing)
          message.reindex(draft, index, position)
        })
        // 压缩请求记下"服务端已确认收到"的输入 ID
        compacting.get(event.data.sessionID)?.observed.add(event.data.inboxID)
        return
      }
      case "session.inbox.delivery.changed":
        updatePending(event.data.sessionID, event.data.inboxID, event.data.delivery)
        return
      case "session.inbox.cancelled": {
        retractLocal(event.data.sessionID, event.data.inboxID)
        compacting.get(event.data.sessionID)?.observed.add(event.data.inboxID)
        return
      }
      case "session.inbox.enqueued": {
        // 持久化回声到达：从乐观 outbox 中移除该 ID
        outbox.delete(event.data.inboxID)
        const item = {
          id: event.data.inboxID,
          sessionID: event.data.sessionID,
          time: { created: event.created },
          ...event.data.item,
        }
        pendingUpdates.get(item.sessionID)?.set(item.id, item)
        // upsert 进 pending 与消息记录：服务端载荷替换乐观占位
        admitLocal(item)
        if (event.data.item.type === "compaction") {
          const active = compacting.get(event.data.sessionID)
          active?.observed.add(event.data.inboxID)
          // 压缩被合并到另一个正式 ID：退休本地的投机行
          if (active && active.id !== event.data.inboxID && outbox.delete(active.id))
            removePending(event.data.sessionID, active.id)
        }
        return
      }
      case "session.instructions.updated":
        // Mirror the projector: the initial baseline and empty-rendering deltas carry no text
        // and produce no transcript message.
        // 与投影器保持一致：初始基线与空渲染的增量不带文本，不产生消息记录条目
        const updateText = event.data.text
        if (updateText === undefined) return
        message.insert(event.data.sessionID, {
          id: SessionMessage.ID.fromEvent(event.id),
          type: "system",
          text: updateText,
          description: `Instructions updated: ${Object.keys(event.data.delta).join(", ")}`,
          metadata: event.metadata,
          time: { created: event.created },
        })
        return
      case "session.synthetic":
        message.insert(event.data.sessionID, {
          id: SessionMessage.ID.fromEvent(event.id),
          type: "synthetic",
          text: event.data.text,
          description: event.data.description,
          metadata: event.data.metadata,
          time: { created: event.created },
        })
        return
      case "session.shell.started":
        message.insert(event.data.sessionID, {
          id: SessionMessage.ID.fromEvent(event.id),
          type: "shell",
          shellID: event.data.shell.id,
          command: event.data.shell.command,
          status: event.data.shell.status,
          exit: event.data.shell.exit,
          metadata:
            event.data.shell.metadata.background === true ? { ...event.metadata, background: true } : event.metadata,
          time: { created: event.created },
        })
        return
      case "session.shell.ended":
        if (!store.session.message[event.data.sessionID]) return
        message.update(event.data.sessionID, (draft) => {
          const match = message.shell(draft, event.data.shell.id)
          if (!match) return
          match.status = event.data.shell.status
          match.exit = event.data.shell.exit
          match.output = event.data.output
          match.time.completed = event.created
        })
        return
      case "session.step.started":
        // 一个执行步骤开始：更新或新建助手消息
        message.update(event.data.sessionID, (draft, index) => {
          const position = index.get(event.data.assistantMessageID)
          const existing = position === undefined ? undefined : draft[position]
          if (existing?.type === "assistant") {
            // 重试场景：复用同一条助手消息，重置流式相关字段
            existing.agent = event.data.agent
            existing.model = event.data.model
            existing.retry = undefined
            existing.error = undefined
            existing.finish = undefined
            existing.rawFinish = undefined
            existing.native = undefined
            existing.time.created = event.data.started
            existing.time.firstToken = undefined
            existing.time.streamed = undefined
            existing.time.completed = undefined
            if (event.data.snapshot) existing.snapshot = { ...existing.snapshot, start: event.data.snapshot }
            return
          }
          // 新步骤且存在未完成的前一个助手：将其收尾（步骤切换边界）
          const currentAssistant = message.activeAssistant(draft)
          if (currentAssistant) {
            currentAssistant.retry = undefined
            currentAssistant.time.completed = event.created
          }
          message.append(draft, index, {
            id: event.data.assistantMessageID,
            type: "assistant",
            agent: event.data.agent,
            model: event.data.model,
            metadata: event.metadata,
            content: [],
            snapshot: event.data.snapshot ? { start: event.data.snapshot } : undefined,
            time: { created: event.data.started },
          })
        })
        return
      case "session.step.streamed":
        message.editAssistant(event.data.sessionID, event.data.assistantMessageID, (assistant) => {
          assistant.time.streamed = event.created
        })
        return
      case "session.step.first-token":
        message.editAssistant(event.data.sessionID, event.data.assistantMessageID, (assistant) => {
          assistant.time.firstToken = event.created
        })
        return
      case "session.step.ended": {
        // 步骤结束：写入完成时间、结束原因、成本与 token 统计
        message.editAssistant(event.data.sessionID, event.data.assistantMessageID, (assistant) => {
          assistant.time.completed = event.created
          assistant.finish = event.data.finish
          assistant.rawFinish = event.data.rawFinish
          assistant.native = event.data.native
          assistant.cost = event.data.cost
          assistant.tokens = event.data.tokens
          if (event.data.snapshot) assistant.snapshot = { ...assistant.snapshot, end: event.data.snapshot }
        })
        return
      }
      case "session.step.failed":
        // A budget refusal means the cached usage limits are out of date, which is what the refusal sends people to.
        // 预算拒绝意味着缓存的用量额度已过期——拒绝本身就是要引导用户去更新的
        if (
          event.location &&
          (event.data.error.type === "provider.budget-limit" || event.data.error.type === "provider.model-budget-limit")
        )
          refreshUsageLimits(event.location)
        message.editAssistant(event.data.sessionID, event.data.assistantMessageID, (assistant) => {
          assistant.time.completed = event.created
          assistant.finish = event.data.finish ?? "error"
          assistant.rawFinish = event.data.rawFinish
          assistant.native = event.data.native
          assistant.error = event.data.error
          assistant.retry = undefined
          if (event.data.cost !== undefined && event.data.tokens !== undefined) {
            assistant.cost = event.data.cost
            assistant.tokens = event.data.tokens
          }
        })
        return
      case "session.text.started":
        // 文本部件开始：推入一个空的文本部件
        message.editAssistant(event.data.sessionID, event.data.assistantMessageID, (assistant) => {
          assistant.content.push({ type: "text", text: "" })
        })
        return
      case "session.text.delta":
        message.editText(event.data.sessionID, event.data.assistantMessageID, (text) => {
          text.text += event.data.delta
        })
        return
      case "session.text.ended":
        message.editText(event.data.sessionID, event.data.assistantMessageID, (text) => {
          text.text = event.data.text
        })
        return
      case "session.tool.input.started":
        // 工具调用开始：推入一个流式状态的工具部件
        message.editAssistant(event.data.sessionID, event.data.assistantMessageID, (assistant) => {
          assistant.content.push({
            type: "tool",
            id: event.data.id,
            name: event.data.name,
            time: { created: event.created },
            state: { status: "streaming", input: "" },
          })
        })
        return
      case "session.tool.input.delta":
        message.editTool(event.data.sessionID, event.data.assistantMessageID, event.data.id, (tool) => {
          if (tool.state.status === "streaming") tool.state.input += event.data.delta
        })
        return
      case "session.tool.input.ended":
        message.editTool(event.data.sessionID, event.data.assistantMessageID, event.data.id, (tool) => {
          if (tool.state.status === "streaming") tool.state.input = event.data.text
        })
        return
      case "session.tool.called":
        // 工具正式执行：从流式转为 running，写入解析后的入参
        message.editTool(event.data.sessionID, event.data.assistantMessageID, event.data.id, (tool) => {
          tool.time.ran = event.created
          tool.executed = event.data.executed
          tool.native = event.data.native
          tool.state = { status: "running", input: event.data.input, metadata: {} }
        })
        return
      case "session.tool.progress":
        message.editTool(event.data.sessionID, event.data.assistantMessageID, event.data.id, (tool) => {
          if (tool.state.status === "running") tool.state.metadata = event.data.metadata
        })
        return
      case "session.tool.success":
        // 工具成功完成：替换状态为 completed，写入输出内容与原生结果
        message.editTool(event.data.sessionID, event.data.assistantMessageID, event.data.id, (tool) => {
          if (tool.state.status !== "running") return
          tool.state = {
            status: "completed",
            input: tool.state.input,
            metadata: event.data.metadata,
            content: config.omitToolFileData ? omitFileData(event.data.content) : [...event.data.content],
          }
          tool.executed = event.data.executed || tool.executed === true
          if (event.data.native) tool.native = { ...tool.native, ...event.data.native }
          tool.time.completed = event.created
        })
        return
      case "session.tool.failed":
        // 工具失败：流式/运行中才处理，替换为 error 状态并带上错误信息
        message.editTool(event.data.sessionID, event.data.assistantMessageID, event.data.id, (tool) => {
          if (tool.state.status !== "streaming" && tool.state.status !== "running") return
          tool.state = {
            status: "error",
            error: event.data.error,
            input: typeof tool.state.input === "string" ? {} : tool.state.input,
            metadata: event.data.metadata,
            content:
              config.omitToolFileData && event.data.content ? omitFileData(event.data.content) : event.data.content,
          }
          tool.executed = event.data.executed || tool.executed === true
          if (event.data.native) tool.native = { ...tool.native, ...event.data.native }
          tool.time.completed = event.created
        })
        return
      case "session.reasoning.started":
        // 推理部件开始：推入空推理部件
        message.editAssistant(event.data.sessionID, event.data.assistantMessageID, (assistant) => {
          assistant.content.push({
            type: "reasoning",
            text: "",
            native: event.data.native,
            time: { created: event.created },
          })
        })
        return
      case "session.reasoning.delta":
        message.editReasoning(event.data.sessionID, event.data.assistantMessageID, (reasoning) => {
          reasoning.text += event.data.delta
        })
        return
      case "session.reasoning.ended":
        // 推理结束：写入完整文本与完成时间
        message.editReasoning(event.data.sessionID, event.data.assistantMessageID, (reasoning) => {
          reasoning.text = event.data.text
          reasoning.time = { created: reasoning.time?.created ?? event.created, completed: event.created }
          if (event.data.native !== undefined) reasoning.native = event.data.native
        })
        return
      case "session.retry.scheduled":
        // 记录计划中的重试（次数/时间/原因错误）
        message.editAssistant(event.data.sessionID, event.data.assistantMessageID, (assistant) => {
          assistant.retry = { attempt: event.data.attempt, at: event.data.at, error: event.data.error }
        })
        return
      case "session.execution.started":
        // 执行开始：会话进入 running
        setSessionActive(event.data.sessionID, "running")
        // Revalidate so `time.busy` follows the projected execution start.
        // 重新验证使 `time.busy` 跟上投影的执行开始；会话未加载且没有进行中的读取时直接跳过
        if (!store.session.info[event.data.sessionID] && !sync.has(`session:${event.data.sessionID}`)) return
        result.session.invalidate(event.data.sessionID)
        refresh(() => result.session.sync(event.data.sessionID))
        return
      case "session.compaction.started":
        if (event.data.inputID) removePending(event.data.sessionID, event.data.inputID)
        message.insert(event.data.sessionID, {
          id: event.data.inputID ?? SessionMessage.ID.fromEvent(event.id),
          type: "compaction",
          status: "running",
          reason: event.data.reason,
          summary: "",
          time: { created: event.created },
        })
        if (event.data.inputID) compacting.get(event.data.sessionID)?.observed.add(event.data.inputID)
        return
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
        // 执行结束（三种结局）：会话回到 idle，清除活动助手的重试标记
        setSessionActive(event.data.sessionID, "idle")
        message.update(event.data.sessionID, (draft) => {
          const currentAssistant = message.activeAssistant(draft)
          if (currentAssistant) currentAssistant.retry = undefined
        })
        // 服务端关机导致的打断不作为回合边界
        if (event.type === "session.execution.interrupted" && event.data.reason === "shutdown") return
        // Mirror the projected idle marker so turn boundaries match before the next message read.
        // 插入与投影一致的 idle 标记，让回合边界在下一次消息读取之前就对齐
        message.insert(event.data.sessionID, {
          id: SessionMessage.ID.fromEvent(event.id),
          type: "idle",
          outcome:
            event.type === "session.execution.succeeded"
              ? "succeeded"
              : event.type === "session.execution.failed"
                ? "failed"
                : "interrupted",
          ...(event.type === "session.execution.failed" ? { error: event.data.error } : {}),
          time: { created: event.created },
        })
        if (
          store.session.message[event.data.sessionID]?.some(
            (item) =>
              item.type === "assistant" &&
              item.content.some(
                (part) =>
                  part.type === "tool" && (part.state.status === "streaming" || part.state.status === "running"),
              ),
          )
        ) {
          // 仍有工具处于流式/运行中：说明本地状态与结局不符，重取消息
          sync.invalidate(`session.message:${event.data.sessionID}`)
          refresh(() => result.session.message.sync(event.data.sessionID))
        }
        // An event can overtake the first read; queue a revalidation when that read is still active.
        // 事件可能跑在首次读取前面；该读取仍在进行时排队一次重新验证
        if (!store.session.info[event.data.sessionID] && !sync.has(`session:${event.data.sessionID}`)) return
        result.session.invalidate(event.data.sessionID)
        refresh(() => result.session.sync(event.data.sessionID))
        return
      case "session.viewed":
        if (!store.session.info[event.data.sessionID] && !sync.has(`session:${event.data.sessionID}`)) return
        result.session.invalidate(event.data.sessionID)
        refresh(() => result.session.sync(event.data.sessionID))
        return
      case "session.revert.staged":
        if (store.session.info[event.data.sessionID])
          setStore("session", "info", event.data.sessionID, "revert", event.data.revert)
        return
      case "session.revert.cleared":
        if (store.session.info[event.data.sessionID])
          setStore("session", "info", event.data.sessionID, "revert", undefined)
        return
      case "session.revert.committed":
        if (store.session.info[event.data.sessionID]) {
          setStore("session", "info", event.data.sessionID, "revert", undefined)
        }
        // The projector also deletes inbox items enqueued at or after the boundary without a cancel event.
        // 投影器还会删掉在回滚边界处或之后入队、且没有取消事件的收件箱条目——本地照做
        setStore(
          "session",
          "pending",
          event.data.sessionID,
          (store.session.pending[event.data.sessionID] ?? []).filter((item) => item.id < event.data.to),
        )
        message.update(event.data.sessionID, (draft, index) => {
          const position = draft.findIndex((item) => item.id >= event.data.to)
          if (position === -1) return
          for (const item of draft.splice(position)) index.delete(item.id)
        })
        return
      case "session.compaction.delta":
        if (!store.session.message[event.data.sessionID]) return
        message.update(event.data.sessionID, (draft) => {
          const current = message.compaction(draft)
          if (current?.status === "running") current.summary += event.data.text
        })
        return
      case "session.compaction.ended":
        // 压缩结束：优先原位更新运行中的压缩消息，找不到才追加
        message.update(event.data.sessionID, (draft, index) => {
          const position = draft.findLastIndex((item) => item.type === "compaction" && item.status === "running")
          const current = draft[position]
          if (current?.type === "compaction") {
            Object.assign(current, {
              status: "completed",
              reason: event.data.reason,
              model: event.data.model,
              native: event.data.native,
              summary: event.data.text,
              cost: event.data.cost,
              tokens: event.data.tokens,
            })
            return
          }
          message.append(draft, index, {
            id: SessionMessage.ID.fromEvent(event.id),
            type: "compaction",
            status: "completed",
            reason: event.data.reason,
            model: event.data.model,
            native: event.data.native,
            summary: event.data.text,
            cost: event.data.cost,
            tokens: event.data.tokens,
            time: { created: event.created },
          })
        })
        return
      case "session.compaction.failed":
        if (event.data.inputID) removePending(event.data.sessionID, event.data.inputID)
        message.update(event.data.sessionID, (draft, index) => {
          const position = draft.findLastIndex((item) => item.type === "compaction" && item.status === "running")
          const current = draft[position]
          const failed: Extract<SessionMessageInfo, { type: "compaction"; status: "failed" }> = {
            id: current?.id ?? event.data.inputID ?? SessionMessage.ID.fromEvent(event.id),
            type: "compaction",
            status: "failed",
            reason: event.data.reason,
            error: event.data.error,
            metadata: current?.type === "compaction" ? current.metadata : event.metadata,
            cost: event.data.cost,
            tokens: event.data.tokens,
            time: current?.type === "compaction" ? current.time : { created: event.created },
          }
          if (current?.type === "compaction") {
            draft[position] = failed
            return
          }
          message.append(draft, index, failed)
        })
        if (event.data.inputID) compacting.get(event.data.sessionID)?.observed.add(event.data.inputID)
        return
      case "permission.asked":
        // 权限请求：去重后追加（同一请求可能重复到达）
        if (store.session.permission[event.data.sessionID]?.some((request) => request.id === event.data.id)) return
        setStore("session", "permission", event.data.sessionID, [
          ...(store.session.permission[event.data.sessionID] ?? []),
          event.data,
        ])
        return
      case "permission.replied":
        removePermission(event.data.sessionID, event.data.requestID)
        return
      case "form.replied":
      case "form.cancelled":
        removeForm(event.data.sessionID, event.data.id, event.location)
        return
    }

    // 凭据事件没有单一位置：遍历全部已知位置逐一处理
    if (event.type === "credential.updated" || event.type === "credential.switched") {
      Object.keys(store.location).forEach((key) => {
        const ref = JSON.parse(key) as [string, string | null]
        const location = { directory: ref[0], workspaceID: ref[1] ?? undefined }
        refreshUsageLimits(location)
        if (event.type === "credential.updated") {
          // 凭据更新影响集成列表，直接重取
          refreshLocation("integration", result.location.integration, location)
          return
        }
        if (store.location[key]?.integration)
          setStore("location", key, (data) => ({
            integration: data?.integration?.map((integration) => {
              if (integration.id !== event.data.integrationID) return integration
              const active = integration.connections.find(
                (connection) => connection.type === "credential" && connection.id === event.data.credentialID,
              )
              if (!active) return integration
              // 切换凭据：把命中的连接提到队首，本地即可反映活跃凭据
              return {
                ...integration,
                connections: [active, ...integration.connections.filter((connection) => connection !== active)],
              }
            }),
          }))
        const active =
          hasLocation("integration", location) || hasLocation("model", location) || hasLocation("provider", location)
        result.location.model.invalidate(location)
        result.location.provider.invalidate(location)
        if (active)
          refresh(() => Promise.all([result.location.model.sync(location), result.location.provider.sync(location)]))
      })
      return
    }

    // 其余事件都携带位置：没有位置则无法处理
    if (!event.location) return
    const location = event.location
    switch (event.type) {
      case "provider.updated":
        refreshLocation("provider", result.location.provider, location)
        break
      case "model.updated":
        refreshLocation("model", result.location.model, location)
        break
      case "agent.updated":
        refreshLocation("agent", result.location.agent, location)
        break
      case "command.updated":
        refreshLocation("command", result.location.command, location)
        break
      case "skill.updated":
        refreshLocation("skill", result.location.skill, location)
        break
      case "vcs.branch.updated":
        // The event names only the current branch. Reload the rest: the default branch and provider can change with
        // it, and a read served before the location's VCS provider loaded has neither.
        // 事件只点名当前分支。其余（默认分支与提供方）也可能随之改变，而且在该位置的 VCS
        // 提供方加载之前完成的读取两者都没有——所以整体重取
        refreshLocation("vcs", result.location.vcs, location)
        break
      case "form.created":
        // 表单创建：按 ID 去重后追加；全局表单要附带位置引用
        if (store.session.form[event.data.form.sessionID]?.some((form) => form.id === event.data.form.id)) break
        setStore("session", "form", event.data.form.sessionID, [
          ...(store.session.form[event.data.form.sessionID] ?? []),
          event.data.form.sessionID === "global" ? { ...event.data.form, location } : event.data.form,
        ])
        break
      case "shell.created":
        setStore("location", locationKey(location), (data) => ({
          shell: {
            ...data?.shell,
            [event.data.info.id]: { ...event.data.info, location },
          },
        }))
        break
      case "shell.exited":
      case "shell.deleted":
        // shell 退出或被删除：本地存在该条目时才从映射中移除
        if (!store.location[locationKey(location)]?.shell?.[event.data.id]) break
        setStore("location", locationKey(location), (data) => ({
          shell: Object.fromEntries(Object.entries(data?.shell ?? {}).filter(([id]) => id !== event.data.id)),
        }))
        break
      case "reference.updated":
        refreshLocation("reference", result.location.reference, location)
        break
      case "integration.updated": {
        refreshUsageLimits(location)
        const active =
          hasLocation("integration", location) || hasLocation("model", location) || hasLocation("provider", location)
        // 集成变更同时影响模型与提供商目录，三处一起失效
        result.location.integration.invalidate(location)
        result.location.model.invalidate(location)
        result.location.provider.invalidate(location)
        if (active)
          refresh(() =>
            Promise.all([
              result.location.integration.sync(location),
              result.location.model.sync(location),
              result.location.provider.sync(location),
            ]),
          )
        break
      }
      case "config.updated":
        refreshLocation("config", result.location.config, location)
        if (hasLocation("websearch", location)) refresh(() => result.location.websearch.refresh(location))
        break
      case "websearch.updated":
        if (hasLocation("websearch", location)) refresh(() => result.location.websearch.refresh(location))
        break
      // Authenticating an MCP integration reconnects its server, which emits mcp.status.changed,
      // so the mcp list syncs here rather than off integration.updated. The server emits one event
      // per MCP server as each settles, so a location booting nine servers emitted nine refetches.
      // MCP 集成认证会重连其服务器并发出 mcp.status.changed，因此 MCP 列表在这里同步，
      // 而不是挂在 integration.updated 上。服务端按每台 MCP 服务器各发一个事件，
      // 一个位置启动九台服务器就会发九次重取——所以这里用 settle 去抖
      case "mcp.status.changed": {
        const active = hasLocation("mcpServer", location)
        result.location.mcp.server.invalidate(location)
        if (active) settle(`mcp.status:${locationKey(location)}`, () => result.location.mcp.server.sync(location))
        break
      }
      case "mcp.resources.changed":
        refreshLocation("mcpResource", result.location.mcp.resource, location)
        break
    }
  }

  // 判断某字段在给定位置是否"已被使用"（已缓存或读取进行中）：
  // 未被使用过的字段不触发重取，避免无人观看的目录空耗请求
  function hasLocation<Field extends keyof LocationData>(field: Field, ref?: LocationRef) {
    const id = locationKey(ref ?? defaultLocation())
    return store.location[id]?.[field] !== undefined || sync.has(`location.${field}:${id}`)
  }

  // 位置级资源的事件驱动刷新：先失效再按需重取（仅在已被使用时）
  function refreshLocation<Field extends keyof LocationData>(
    field: Field,
    resource: { invalidate: (ref?: LocationRef) => void; sync: (ref?: LocationRef) => Promise<void> },
    location: LocationRef,
  ) {
    const active = hasLocation(field, location)
    resource.invalidate(location)
    if (active) refresh(() => resource.sync(location))
  }

  // A cached per-location catalog. `sync` loads once per invalidation, keyed by the
  // effective location, and publishes under the server's canonical location; `alias`
  // also publishes under the requested key when the two differ.
  // Reloads usage limits only where something has read them, since each load asks OpenCode Console.
  // 按位置缓存的用量额度目录。sync 在每次失效后只加载一次，以生效位置为键，
  // 并发布到服务端的 canonical 位置键下。只有已经读取过额度的位置才重载——
  // 因为每次加载都要向 OpenCode Console 发起请求
  function refreshUsageLimits(location: LocationRef) {
    const loaded =
      store.location[locationKey(location)]?.usageLimits !== undefined ||
      sync.has(`location.usageLimits:${locationKey(location)}`)
    usageLimits.invalidate(location)
    if (loaded) refresh(() => usageLimits.sync(location))
  }

  // 位置级资源的通用工厂：list 读缓存、sync 按失效键同步、invalidate 失效。
  // alias 选项：服务端 canonical 位置与请求键不同时，两个键下都发布一份
  function locationResource<Field extends keyof LocationData>(
    field: Field,
    load: (location: ReturnType<typeof locationQuery>) => Promise<{ location: LocationRef; data: LocationData[Field] }>,
    options?: { alias?: boolean },
  ) {
    const publish = (key: string, value: LocationData[Field]) => setStore("location", key, { [field]: value })
    return {
      list: (ref?: LocationRef) => store.location[locationKey(ref ?? defaultLocation())]?.[field],
      sync: (ref?: LocationRef) => {
        const location = ref ?? defaultLocation()
        const id = locationKey(location)
        return sync.run(`location.${field}:${id}`, async () => {
          const response = await load(locationQuery(location))
          const key = locationKey(response.location)
          // 以服务端返回的 canonical 位置键发布
          publish(key, response.data)
          if (options?.alias && key !== id) publish(id, response.data)
        })
      },
      invalidate: (ref?: LocationRef) => sync.invalidate(`location.${field}:${locationKey(ref ?? defaultLocation())}`),
    }
  }

  // 各位置级资源实例：VCS、用量额度、shell（shell 需要把列表转成按 ID 的映射并补位置）
  const vcs = locationResource("vcs", (location) => api().vcs.get({ location }))
  const usageLimits = locationResource("usageLimits", (location) => api().experimental.usage.limits({ location }))
  const shells = locationResource("shell", async (location) => {
    const response = await api().shell.list({ location })
    const ref = { directory: response.location.directory }
    return {
      location: response.location,
      data: Object.fromEntries(response.data.map((info) => [info.id, { ...info, location: ref }])),
    }
  })

  // 对外暴露的完整数据 API：读缓存、同步、乐观写入、失效
  const result = {
    // 事件订阅直接转发底层实现
    on: config.event.on,
    listen: config.event.listen,
    session: {
      // 全部会话按最近更新倒序的响应式列表
      list() {
        return sessions()
      },
      get(sessionID: string) {
        return store.session.info[sessionID]
      },
      // 会话是否处于"已删除/缺失"状态
      missing(sessionID: string) {
        return Boolean(store.session.missing[sessionID])
      },
      // 显式遗忘某会话：当作已删除处理
      forget(sessionID: string) {
        markDeleted(sessionID)
      },
      // 该会话是否有进行中的乐观创建
      creating(sessionID: string) {
        return creating.has(sessionID)
      },
      // 把一条会话信息"记住"进 store：清墓碑、reconcile 写入、
      // 标记会话键为已完成、登记进家族索引
      remember(info: SessionInfo) {
        batch(() => {
          clearDeleted(info.id)
          setStore("session", "info", info.id, reconcile(info))
          sync.complete(`session:${info.id}`)
          registerSession(info.id)
        })
      },
      setStatus(sessionID: string, status: DataSessionStatus) {
        setSessionActive(sessionID, status)
      },
      // 解析会话所属的家族根
      root(sessionID: string) {
        return resolveRoot(sessionID)
      },
      // 该会话家族的全部成员 ID
      family(sessionID: string) {
        return store.session.family[resolveRoot(sessionID)] ?? []
      },
      /** Clear heavy cached data for the root and all known descendants. */
      // 清除根会话与所有已知后代的重缓存数据
      evict(sessionID: string) {
        const root = resolveRoot(sessionID)
        batch(() => {
          for (const id of new Set([root, sessionID, ...(store.session.family[root] ?? [])])) evictSession(id)
        })
      },
      // 会话成本：子会话只算自己；根会话聚合整个家族
      cost(sessionID: string) {
        const session = store.session.info[sessionID]
        if (!session) return 0
        if (session.parentID) return session.cost
        return (store.session.family[sessionID] ?? [sessionID]).reduce(
          (total, id) => total + (store.session.info[id]?.cost ?? 0),
          0,
        )
      },
      // 会话当前状态（默认 idle）
      status(sessionID: string) {
        return store.session.active[sessionID] ?? "idle"
      },
      // 所有处于 running 的会话 ID
      active() {
        return Object.entries(store.session.active).flatMap(([sessionID, status]) =>
          status === "running" ? [sessionID] : [],
        )
      },
      // Inputs are the pending user and synthetic items; compactions are control items.
      // 待发送输入视图：pending 里的 user/synthetic 条目；compaction 是控制条目不算输入
      input: {
        list(sessionID: string) {
          return (store.session.pending[sessionID] ?? []).flatMap((item) =>
            item.type === "compaction" ? [] : [item.id],
          )
        },
        has(sessionID: string, inboxID: string) {
          return (
            store.session.pending[sessionID]?.some((item) => item.id === inboxID && item.type !== "compaction") ?? false
          )
        },
      },
      pending: {
        list(sessionID: string) {
          return store.session.pending[sessionID] ?? []
        },
        // An execution's idle boundary promotes every pending steer at once, so a steer only waits behind work
        // once the current execution has delivered input.
        // pending 状态推导：执行的空闲边界会一次性提升全部待处理 steer，
        // 所以只有当当前执行已消费过输入时，steer 才需要排队等活干
        status(sessionID: string, inboxID: string): DataPendingStatus | undefined {
          const pending = store.session.pending[sessionID] ?? []
          const item = pending.find((entry) => entry.id === inboxID && entry.type === "user")
          if (!item) return undefined
          // 显式排队（queue 投递）直接归为 queued
          if (item.delivery === "queue") return "queued"
          const messages = store.session.message[sessionID] ?? []
          const boundary = messages.findLastIndex((entry) => entry.type === "idle")
          // 会话空闲：条目在最近一次空闲边界之前 → stranded（被滞留）；否则 → starting
          if ((store.session.active[sessionID] ?? "idle") === "idle")
            return boundary >= 0 && item.time.created <= messages[boundary].time.created ? "stranded" : "starting"
          // 会话运行中：边界之后已有未被提升的用户消息 → steering；否则 → starting
          return messages
            .slice(boundary + 1)
            .some((entry) => entry.type === "user" && !pending.some((other) => other.id === entry.id))
            ? "steering"
            : "starting"
        },
        // 同步会话的 pending 列表：拉取快照、合并事件缓冲、保留乐观行
        sync(sessionID: string) {
          return sync.run(`session.pending:${sessionID}`, async () => {
            const started = deletionEpoch
            const updates = new Map<string, SessionInboxInfo | SessionInbox.Delivery | undefined>()
            // 登记 updates 缓冲：同步期间到达的事件先写这里
            pendingUpdates.set(sessionID, updates)
            try {
              const snapshot = await api().session.inbox.list({ sessionID }).catch(evictMissing)
              // 读取期间会话被删除：丢弃结果
              if ((deletedAt.get(sessionID) ?? 0) > started) return
              // Events can overtake this HTTP response on a remote connection.
              // Reconcile them before an older snapshot can resurrect delivered input.
              // 远程连接下事件可能先于 HTTP 响应到达。必须先把事件缓冲合并进快照，
              // 防止更旧的快照"复活"已投递的输入
              const current = new Map(snapshot.map((item) => [item.id, item]))
              updates.forEach((item, id) => {
                if (item === undefined) current.delete(id)
                else if (typeof item === "string") {
                  const existing = current.get(id)
                  if (existing) current.set(id, { ...existing, delivery: item })
                } else current.set(id, item)
              })
              const pending = [...current.values()]
              // A positive read acknowledges admission even when its SSE echo is delayed.
              // 读到的正向结果即视为受理确认，即使 SSE 回声延迟
              pending.forEach((item) => outbox.delete(item.id))
              // Compactions also coalesce by Session, not just by the proposed ID.
              // 压缩还按会话聚合（不止按提议 ID）：有正式压缩时清掉全部本地压缩乐观行
              if (pending.some((item) => item.type === "compaction"))
                store.session.pending[sessionID]
                  ?.filter((item) => item.type === "compaction")
                  .forEach((item) => outbox.delete(item.id))
              // Keep optimistic rows still awaiting their echo: this fetch may
              // have raced ahead of an in-flight admission the server does not
              // know about yet.
              // 保留仍在等回声的乐观行：这次拉取可能跑在了
              // 服务端尚不知情的受理请求前面
              const inflight = (store.session.pending[sessionID] ?? []).filter((item) => outbox.has(item.id))
              const merged = inflight.length === 0 ? pending : [...pending, ...inflight]
              batch(() => {
                setStore("session", "pending", sessionID, reconcile(merged))
                merged.forEach(materializeInboxMessage)
              })
            } finally {
              if (pendingUpdates.get(sessionID) === updates) pendingUpdates.delete(sessionID)
            }
          })
        },
        invalidate(sessionID: string) {
          sync.invalidate(`session.pending:${sessionID}`)
        },
      },
      // Optimistic session creation: admit a local record under a
      // client-minted ID so a session view can mount immediately, then create
      // the session on the server. The session.created echo re-syncs the
      // record by ID, so the durable payload replaces the client's guess.
      // Returns the ID synchronously along with the in-flight request:
      // callers gate session-dependent sends on the request (prompt() gates
      // itself on any in-flight create of its session automatically).
      // 乐观会话创建：先以客户端铸造的 ID 受理本地记录，让会话视图立即挂载，
      // 再到服务端创建。session.created 回声会按 ID 重新同步，正式载荷替换本地猜测。
      // 同步返回 ID 与进行中的请求：调用方把依赖会话的发送挂在请求上
      // （prompt() 会自动挂在本会话任何进行中的创建上）
      create(input: {
        id?: string
        title?: string
        agent?: string
        model?: ModelRef
        location?: LocationRef
        projectID?: string
      }) {
        const { projectID, ...payload } = input
        const id = payload.id ?? SessionID.create()
        const location = payload.location ?? defaultLocation()
        // 本地是否是"全新"会话（决定是否乐观渲染与登记创建闸门）
        const fresh = !store.session.info[id]
        clearDeleted(id)
        if (fresh) {
          const now = Date.now()
          sessionOutbox.add(id)
          result.session.remember({
            id,
            projectID: projectID ?? store.location[locationKey(location)]?.info?.project.id ?? "",
            agent: payload.agent,
            model: payload.model,
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: now, updated: now },
            title: payload.title,
            location,
          })
          // A mounted optimistic session must not fetch its empty collections
          // before creation settles. The session.created echo re-syncs info.
          // 已挂载的乐观会话在创建结束前不得拉取其空集合；session.created 回声会重新同步信息
          sync.complete(`session.family:${id}`)
          sync.complete(`session.pending:${id}`)
          sync.complete(`session.message:${id}`)
        }
        // Wrapped so even a synchronous client failure reaches the rollback.
        // 包一层 Promise.resolve：同步抛错的客户端故障也能走到回滚
        const request = Promise.resolve()
          .then(() => api().session.create({ ...payload, id, location }))
          .then((info) => {
            sessionOutbox.delete(id)
            result.session.remember(info)
            return info
          })
          .catch((error) => {
            // Roll back only a record this call admitted and neither the echo
            // nor the response has acknowledged: anything else is server state.
            // 只回滚本次调用受理、且回声与响应都未确认过的记录；其余都是服务端状态
            if (fresh && sessionOutbox.delete(id)) removeSession(id)
            throw error
          })
        if (fresh) track(creating, id, request)
        return { id, request }
      },
      // 发起会话压缩（历史摘要）：同会话去重（已有进行中的直接复用其请求）；
      // 乐观插入压缩控制条目，服务端受理后按正式 ID 对账
      compact(input: { sessionID: string; model?: ModelRef }) {
        const active = compacting.get(input.sessionID)
        if (active) return active.request
        // A known pending control ID may be consumed while setup waits. Propose
        // a fresh ID and let the server coalesce, without duplicating its row.
        // 等待期间已知的 pending 控制 ID 可能被消费掉。提议一个全新 ID 并交给服务端聚合，
        // 本地不重复插行
        const id = SessionMessage.ID.create()
        if (!store.session.pending[input.sessionID]?.some((item) => item.type === "compaction")) {
          outbox.add(id)
          admitLocal({
            id,
            sessionID: input.sessionID,
            time: { created: Date.now() },
            type: "compaction",
            delivery: "steer",
            payload: {},
          })
        }
        // Compaction admission can coalesce onto a different ID. Retire the
        // speculative row on an echo, and remember consumed IDs until the POST
        // settles so its older response cannot resurrect a queued row.
        // 压缩受理可能聚合到另一个 ID 上。回声到达时退休投机行；
        // 记住已被消费的 ID 直到 POST 结束，防止其更早的响应复活已排队的行
        const observed = new Set<string>()
        const request = sendAdmission(input.sessionID, async () => {
          if (input.model) await api().session.switchModel({ sessionID: input.sessionID, model: input.model })
          return api().session.compact({ sessionID: input.sessionID, id })
        })
          .then((item) => {
            batch(() => {
              outbox.delete(id)
              if (item.id !== id) removePending(input.sessionID, id)
              if (!observed.has(item.id) && !messageIndex.get(input.sessionID)?.has(item.id)) admitLocal(item)
            })
            return item
          })
          .catch((error) => {
            if (outbox.delete(id)) removePending(input.sessionID, id)
            throw error
          })
          .finally(() => {
            if (compacting.get(input.sessionID)?.request === request) compacting.delete(input.sessionID)
          })
        compacting.set(input.sessionID, { id, observed, request })
        return request
      },
      // Optimistic prompt admission: render the prompt immediately under a
      // client-minted ID, send it, and let the durable inbox.enqueued echo
      // upsert that same ID with the server's payload. Server admission is
      // idempotent per ID, so retrying with the identical payload cannot
      // double-admit.
      // 乐观提示受理：立即以客户端铸造的 ID 渲染提示并发送，持久化的 inbox.enqueued
      // 回声会用服务端载荷 upsert 同一 ID。服务端按 ID 幂等受理，
      // 相同载荷重试不会重复受理
      prompt(input: SessionPromptInput & { gate?: Promise<unknown>; prepare?: () => Promise<unknown> }) {
        const { gate, prepare, ...request } = input
        const id = request.id ?? SessionMessage.ID.create()
        // A retry may reuse an ID that is already rendered — and possibly
        // already durable. Admit optimistically only for new IDs so a failed
        // retry cannot roll back acknowledged state.
        // 重试可能复用已渲染——甚至已持久化——的 ID。只对全新 ID 乐观受理，
        // 这样失败的重试不会回滚已确认的状态
        const fresh =
          !messageIndex.get(request.sessionID)?.has(id) &&
          !store.session.pending[request.sessionID]?.some((item) => item.id === id)
        if (fresh) {
          const files = optimisticFiles(request.files)
          const payload: Extract<SessionInboxInfo, { type: "user" }>["payload"] = {
            text: request.text,
            agents: request.agents?.map((agent) => ({ ...agent })),
            metadata: request.metadata,
          }
          if (files) payload.files = files
          outbox.add(id)
          admitLocal({
            id,
            sessionID: request.sessionID,
            time: { created: Date.now() },
            type: "user",
            delivery: request.delivery ?? "steer",
            // File-URI attachments and skills stay off the optimistic row: their durable
            // forms are server-loaded (content, mime, resolution), so they
            // fill in when the echo upserts the row. Inline data URLs already carry
            // their mime and base64 payload, so they render immediately.
            // 文件 URI 附件与技能不进乐观行：它们的正式形态由服务端加载（内容、MIME、解析），
            // 回声 upsert 行时才补齐。内联 data URL 自带 MIME 与 base64 载荷，可立即渲染
            payload,
          })
        }
        return sendAdmission(
          request.sessionID,
          async () => {
            await prepare?.()
            return api().session.prompt({ ...request, id })
          },
          gate,
        ).catch((error) => {
          // Roll back only rows this call admitted and the server has not
          // acknowledged: anything else is server state.
          // 只回滚本次调用受理且服务端未确认的行；其余都是服务端状态
          if (fresh && outbox.delete(id)) retractLocal(request.sessionID, id)
          throw error
        })
      },
      // 同步会话信息：单会话或（children 选项）整个家族；读取期间被删除的会话被过滤掉
      sync(sessionID: string, options?: { children?: boolean }) {
        return sync.run(options?.children ? `session.family:${sessionID}` : `session:${sessionID}`, async () => {
          const started = deletionEpoch
          const [info, children] = await Promise.all([
            api().session.get({ sessionID }).catch(evictMissing),
            options?.children ? listChildren({ parentID: sessionID, order: "desc", limit: CHILD_PAGE }) : [],
          ])
          const sessions = [info, ...children].filter((session) => (deletedAt.get(session.id) ?? 0) <= started)
          batch(() => {
            setStore(
              "session",
              "info",
              produce((draft) => {
                for (const session of sessions) draft[session.id] = session
              }),
            )
            for (const session of sessions) {
              clearDeleted(session.id)
              sync.complete(`session:${session.id}`)
              registerSession(session.id)
            }
          })
        })
      },
      invalidate(sessionID: string) {
        sync.invalidate(`session:${sessionID}`)
      },
      // 消息记录 API：读缓存、同步、分页加载与失效
      message: {
        list(sessionID: string) {
          return store.session.message[sessionID] ?? []
        },
        // 按 ID 取单条消息（走索引，O(1)）
        get(sessionID: string, messageID: string) {
          const messages = store.session.message[sessionID]
          const position = messageIndex.get(sessionID)?.get(messageID)
          return position === undefined ? undefined : messages?.[position]
        },
        // 首次/失效后的消息同步：倒序取最近一页并反转成时间正序
        sync(sessionID: string) {
          return sync.run(`session.message:${sessionID}`, async () => {
            const started = deletionEpoch
            const response = await api()
              .message.list({
                sessionID,
                limit: config.initialMessageLimit?.() ?? messagePageLimit,
                order: "desc",
              })
              .catch(evictMissing)
            if ((deletedAt.get(sessionID) ?? 0) > started) return
            const fetched = response.data.toReversed().map(stored)
            // Same protection as the pending sync: a re-fetch racing an
            // admission must not wipe its local transcript row.
            // 与 pending 同步相同的保护：重取与受理竞争时不得抹掉本地消息行
            const ids = new Set(fetched.map((item) => item.id))
            const admitted = new Set(
              (store.session.pending[sessionID] ?? []).flatMap((item) =>
                item.type === "user" || item.type === "synthetic" ? [item.id] : [],
              ),
            )
            const local = (store.session.message[sessionID] ?? []).filter(
              (item) => !ids.has(item.id) && (outbox.has(item.id) || admitted.has(item.id)),
            )
            const messages = local.length === 0 ? fetched : [...fetched, ...local]
            // The transcript only holds delivered input, so a pending row it contains missed its
            // inbox.delivered event (and maybe its enqueued echo) while the event stream was down.
            // 消息记录只保存已投递的输入：pending 里被服务端收录的行，是事件流断线期间
            // 错过了 inbox.delivered 事件（可能还有 enqueued 回声）的——在这里补投递
            const delivered = [...admitted].filter((id) => ids.has(id))
            batch(() => {
              delivered.forEach((id) => {
                outbox.delete(id)
                removePending(sessionID, id)
              })
              messageIndex.set(sessionID, new Map(messages.map((message, index) => [message.id, index])))
              setStore("session", "message", sessionID, reconcile(messages))
              setStore("session", "messageCursor", sessionID, response.cursor.next ?? undefined)
            })
          })
        },
        // 是否还有更早的历史可加载
        more(sessionID: string) {
          return store.session.messageCursor[sessionID] !== undefined
        },
        loading(sessionID: string) {
          return store.session.messageLoading[sessionID] ?? false
        },
        // 向更早的历史分页加载。all 选项一次拉完；支持 AbortSignal；
        // 并发调用会等待进行中的加载（按其是否发布过数据决定是否继续）
        async loadMore(
          sessionID: string,
          options?: {
            all?: boolean
            signal?: AbortSignal
            /** Runs synchronously inside the store-publication batch. */
            // 在 store 发布批次内同步执行的回调
            beforePublish?: () => void
          },
        ) {
          const signal = options?.signal
          if (signal?.aborted) return
          while (messageLoads.has(sessionID)) {
            const published = await (() => {
              const pending = messageLoads.get(sessionID)
              if (!signal) return pending
              // 有取消信号时竞速：加载完成或信号触发都返回
              const aborted = Promise.withResolvers<void>()
              const cancel = () => aborted.resolve()
              signal.addEventListener("abort", cancel, { once: true })
              return Promise.race([pending, aborted.promise])
                .catch((error) => {
                  if (!signal.aborted) throw error
                })
                .finally(() => signal.removeEventListener("abort", cancel))
            })()
            // 单页模式：等到的加载若发布过数据即视为完成本页；被取消也退出
            if ((!options?.all && published) || signal?.aborted) return
          }
          const cursor = store.session.messageCursor[sessionID]
          if (!cursor || signal?.aborted) return
          setStore("session", "messageLoading", sessionID, true)
          const request = (async () => {
            const fetched: SessionMessageInfo[] = []
            let next: string | undefined = cursor
            do {
              const response = await api().message.list(
                {
                  sessionID,
                  limit: options?.all ? 200 : messagePageLimit,
                  cursor: next,
                },
                { signal },
              )
              if (signal?.aborted) return
              fetched.push(...response.data.map(stored))
              next = response.cursor.next ?? undefined
              if (!options?.all) break
            } while (next)
            // A jump through history publishes once, not once per page of offscreen messages.
            // 历史跳转只发布一次，而不是每个离屏消息页发布一次
            const existing = store.session.message[sessionID] ?? []
            const ids = new Set(existing.map((item) => item.id))
            const messages = [...fetched.reverse().filter((item) => !ids.has(item.id)), ...existing]
            batch(() => {
              options?.beforePublish?.()
              messageIndex.set(sessionID, new Map(messages.map((item, position) => [item.id, position])))
              setStore("session", "message", sessionID, reconcile(messages))
              setStore("session", "messageCursor", sessionID, next)
            })
            return true
          })()
            .catch((error) => {
              if (!signal?.aborted) throw error
            })
            .finally(() => setStore("session", "messageLoading", sessionID, false))
          track(messageLoads, sessionID, request)
          await request
        },
        invalidate(sessionID: string) {
          sync.invalidate(`session.message:${sessionID}`)
        },
      },
      // 权限请求 API：列出、同步、答复
      permission: {
        list(sessionID: string) {
          return store.session.permission[sessionID]
        },
        // 有待答复权限请求的会话 ID 列表
        sessions() {
          return Object.entries(store.session.permission).flatMap(([sessionID, requests]) =>
            requests.length > 0 ? [sessionID] : [],
          )
        },
        sync(sessionID: string) {
          return sync.run(`session.permission:${sessionID}`, async () => {
            const started = deletionEpoch
            const list = await api().permission.list({ sessionID }).catch(evictMissing)
            if ((deletedAt.get(sessionID) ?? 0) > started) return
            setStore("session", "permission", sessionID, list)
          })
        },
        invalidate(sessionID: string) {
          sync.invalidate(`session.permission:${sessionID}`)
        },
        async reply(input: PermissionReplyInput) {
          await api()
            .permission.reply(input)
            .catch((error: unknown) => {
              // 请求已不存在（可能已由他人处理）则吞掉错误
              if (!isPermissionNotFoundError(error)) throw error
            })
          removePermission(input.sessionID, input.requestID)
        },
      },
      // 表单 API：列出、同步、答复与取消
      form: {
        list(sessionID: string, ref?: LocationRef) {
          const forms = store.session.form[sessionID]
          // 非全局表单直接返回
          if (sessionID !== "global") return forms
          // 全局表单需按位置过滤
          if (!ref) return
          const key = locationKey(ref)
          return forms?.filter((form) => form.location && locationKey(form.location) === key)
        },
        // 有待处理表单的真实会话 ID 列表（排除全局哨兵）
        sessions() {
          return Object.entries(store.session.form).flatMap(([sessionID, forms]) =>
            sessionID !== "global" && forms.length > 0 ? [sessionID] : [],
          )
        },
        sync(sessionID: string, ref?: LocationRef) {
          // 全局表单的同步键附带位置；普通会话键不带
          const key = `session.form:${sessionID}:${sessionID === "global" ? locationKey(ref ?? defaultLocation()) : ""}`
          return sync.run(key, async () => {
            if (sessionID === "global") {
              const response = await api().form.list({
                location: locationQuery(ref ?? defaultLocation()),
              })
              const location = {
                directory: response.location.directory,
              }
              const locationID = locationKey(location)
              setStore("session", "form", sessionID, [
                ...(store.session.form[sessionID] ?? []).filter(
                  (form) => form.location && locationKey(form.location) !== locationID,
                ),
                ...response.data.filter((form) => form.sessionID === "global").map((form) => ({ ...form, location })),
              ])
              return
            }
            const started = deletionEpoch
            const list = await api().session.form.list({ sessionID }).catch(evictMissing)
            if ((deletedAt.get(sessionID) ?? 0) > started) return
            setStore("session", "form", sessionID, list)
          })
        },
        invalidate(sessionID: string, ref?: LocationRef) {
          sync.invalidate(
            `session.form:${sessionID}:${sessionID === "global" ? locationKey(ref ?? defaultLocation()) : ""}`,
          )
        },
        reply(input: SessionFormReplyInput, ref?: LocationRef) {
          return settleForm(input, ref, api().session.form.reply(input, formRequestOptions(input.sessionID, ref)))
        },
        cancel(input: SessionFormCancelInput, ref?: LocationRef) {
          return settleForm(input, ref, api().session.form.cancel(input, formRequestOptions(input.sessionID, ref)))
        },
      },
    },
    // 项目 API：列表（过滤已归档、按最近活跃排序）、读取、同步与已保存权限
    project: {
      list() {
        return Object.values(store.project.info)
          .filter((project) => project.time.archived === undefined)
          .toSorted((a, b) => b.time.active - a.time.active)
      },
      get(projectID: string) {
        return store.project.info[projectID]
      },
      sync() {
        return sync.run("project", async () => {
          const projects = await api().project.list()
          setStore("project", "info", reconcile(Object.fromEntries(projects.map((project) => [project.id, project]))))
        })
      },
      invalidate() {
        sync.invalidate("project")
      },
      permission: {
        list(projectID: string) {
          return store.project.permission[projectID]
        },
        sync(projectID: string) {
          return sync.run(`project.permission:${projectID}`, async () => {
            setStore("project", "permission", projectID, await api().permission.saved.list({ projectID }))
          })
        },
        invalidate(projectID: string) {
          sync.invalidate(`project.permission:${projectID}`)
        },
      },
    },
    // shell API：按位置列出、按会话筛选、按 ID 全局查找
    shell: {
      list(location?: LocationRef) {
        return Object.values(shells.list(location) ?? {})
      },
      listBySession(sessionID: string) {
        return Object.values(store.location)
          .flatMap((data) => Object.values(data.shell ?? {}))
          .filter((shell) => shell.metadata.sessionID === sessionID)
      },
      get(id: string) {
        return Object.values(store.location)
          .map((data) => data.shell?.[id])
          .find((shell) => shell !== undefined)
      },
      sync: shells.sync,
      invalidate: shells.invalidate,
    },
    // 位置 API：信息读写、全量同步/失效，以及各位置级资源
    location: {
      info(ref?: LocationRef) {
        return store.location[locationKey(ref ?? defaultLocation())]?.info
      },
      default() {
        return defaultLocation()
      },
      // 同步单个位置的基础信息；不带 ref 时把返回的 canonical 目录设为新的默认位置
      syncInfo(ref?: LocationRef) {
        const current = ref ?? defaultLocation()
        return sync.run(`location:${locationKey(current)}`, async () => {
          const location = await api().location.get({ location: locationQuery(current) })
          const key = locationKey(location)
          if (!store.location[key]) setStore("location", key, {})
          setStore("location", key, "info", location)
          if (!ref) {
            setDefaultLocation({ directory: location.directory })
          }
        })
      },
      // 全量同步一个位置：基础信息 + 全部目录资源 + shell + 全局表单
      async sync(ref?: LocationRef) {
        await result.location.syncInfo(ref)
        const location = ref ?? defaultLocation()
        await Promise.all([
          result.location.vcs.sync(location),
          result.location.agent.sync(location),
          result.location.command.sync(location),
          result.location.integration.sync(location),
          result.location.mcp.server.sync(location),
          result.location.mcp.resource.sync(location),
          result.location.model.sync(location),
          result.location.provider.sync(location),
          result.location.reference.sync(location),
          result.location.skill.sync(location),
          result.shell.sync(location),
          result.session.form.sync("global", location),
        ])
      },
      // 全量失效一个位置的全部缓存键
      invalidate(ref?: LocationRef) {
        const location = ref ?? defaultLocation()
        sync.invalidate(`location:${locationKey(location)}`)
        result.location.vcs.invalidate(location)
        result.location.agent.invalidate(location)
        result.location.command.invalidate(location)
        result.location.config.invalidate(location)
        result.location.integration.invalidate(location)
        result.location.mcp.server.invalidate(location)
        result.location.mcp.resource.invalidate(location)
        result.location.model.invalidate(location)
        result.location.provider.invalidate(location)
        result.location.reference.invalidate(location)
        result.location.skill.invalidate(location)
        result.shell.invalidate(location)
        result.session.form.invalidate("global", location)
      },
      vcs: { info: vcs.list, sync: vcs.sync, invalidate: vcs.invalidate },
      usage: { limits: usageLimits.list, sync: usageLimits.sync, invalidate: usageLimits.invalidate },
      agent: locationResource("agent", (location) => api().agent.list({ location })),
      command: locationResource("command", (location) => api().command.list({ location })),
      config: locationResource("config", async (location) => ({
        location: { directory: location.directory },
        data: await api().config.get({ location }),
      })),
      integration: locationResource("integration", (location) => api().integration.list({ location })),
      mcp: {
        server: locationResource("mcpServer", (location) => api().mcp.list({ location })),
        resource: locationResource("mcpResource", async (location) => {
          const response = await api().mcp.resource.catalog({ location })
          return { location: response.location, data: response.data.resources }
        }),
      },
      // 模型/提供商目录：canonical 键可能与请求键不同，开启 alias 双写
      model: locationResource("model", (location) => api().model.list({ location }), { alias: true }),
      provider: locationResource("provider", (location) => api().provider.list({ location }), { alias: true }),
      reference: locationResource("reference", (location) => api().reference.list({ location })),
      // 网页搜索提供商：不走 locationResource（无失效语义，只有主动刷新）
      websearch: {
        list(location?: LocationRef) {
          return store.location[locationKey(location ?? defaultLocation())]?.websearch
        },
        async refresh(ref?: LocationRef) {
          const input = { location: locationQuery(ref ?? defaultLocation()) }
          const providers = await api().websearch.providers(input)
          const key = locationKey(providers.location)
          setStore("location", key, { websearch: providers.data })
        },
      },
      skill: locationResource("skill", (location) => api().skill.list({ location })),
    },
  }

  // 断线期间全局失效所有缓存：重连后由各持有方按需重新同步
  createEffect(() => {
    if (config.connection?.status() === "connected") return
    sync.invalidate()
  })

  // 注册全量事件监听（随组件卸载自动注销）
  onCleanup(
    config.event.listen(({ details }) => {
      handleEvent(details)
    }),
  )

  return result
}

// 数据 API 的推导类型
export type Data = ReturnType<typeof createData>
