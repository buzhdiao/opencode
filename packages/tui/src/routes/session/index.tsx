// 会话路由页（Session）：TUI 中单个会话的主界面——负责渲染消息转录流（transcript）、
// 权限/表单提示、输入框（Composer/Prompt）、时间线导航、导出、分叉（fork）等全部会话内交互。
// 它是终端 UI 的"会话容器"：数据来自 useData（客户端同步状态），通过 rows/mount-budget 做
// 按需挂载（虚拟化），把各条消息委托给 message-parts / group-view 等子组件绘制。
import {
  // batch：将多个信号更新合并为一次批量刷新，避免中间态重复渲染
  batch,
  // createEffect：创建响应式副作用
  createEffect,
  // createMemo：创建派生只读信号（带缓存）
  createMemo,
  // createSignal：创建响应式信号
  createSignal,
  // For/Index：列表渲染组件（Index 按索引、For 按引用）
  For,
  Index,
  // Match/Show/Switch：条件渲染组件
  Match,
  on,
  onCleanup,
  Show,
  Switch,
  // Accessor：只读信号（() => T）的类型别名
  type Accessor,
} from "solid-js"
// node:path：路径拼接/解析（导出文件、附件路径处理用）
import path from "node:path"
import { EOL } from "node:os"
import { mkdir, writeFile } from "node:fs/promises"
// 路由上下文：读取路由数据与编程式导航
import { useRoute, useRouteData } from "../../context/route"
// createStore：SolidJS store，用于细粒度可变状态对象
import { createStore } from "solid-js/store"
// useData：全局数据上下文（会话、消息、权限等客户端同步状态）
import { useData } from "../../context/data"
// SplitBorder：分屏边框绘制组件
import { SplitBorder } from "../../ui/border"
import { useSessionLinks } from "../../ui/session-link"
import { useTuiPaths, useTuiTerminalEnvironment } from "../../context/runtime"
import { Spinner, SPINNER_FRAMES } from "../../component/spinner"
// PatchDiff：diff 补丁渲染组件
import { PatchDiff } from "../../component/patch-diff"
// 主题上下文：读取当前主题色与全部主题
import { useTheme, useThemes } from "../../context/theme"
import {
  // BoxRenderable：opentui 基础盒子节点
  BoxRenderable,
  // ScrollBoxRenderable：可滚动盒子（转录区容器）
  ScrollBoxRenderable,
  // addDefaultParsers：注册默认内容解析器（代码块高亮等）
  addDefaultParsers,
  // TextAttributes：文本样式属性
  TextAttributes,
  // RGBA：颜色值类型
  RGBA,
  // MouseEvent：终端鼠标事件类型
  MouseEvent,
} from "@opentui/core"
// Prompt：底层输入框组件及其 ref 类型（光标、编辑缓冲等能力）
import { Prompt, type PromptRef } from "../../component/prompt"
import {
  // mediaHashFromUri：从附件 URI 计算媒体哈希（去重/定位缓存用）
  mediaHashFromUri,
  // 以下为客户端 SDK 的消息/会话/模型类型定义
  type PromptAttachment,
  type SessionMessageInfo,
  type SessionMessageAssistant,
  type SessionMessageAssistantReasoning,
  type SessionMessageAssistantText,
  type SessionMessageAssistantTool,
  type SessionMessageUser,
  type SessionInfo,
  type ModelInfo,
} from "@opencode/client"
// useLocal：本地 UI 状态上下文（如权限自动接受模式）
import { useLocal } from "../../context/local"
// Locale：本地化文案/截断工具
import { Locale } from "../../util/locale"
// FilePath：文件路径展示组件
import { FilePath } from "../../ui/file-path"
import {
  // canonicalToolName：工具名规范化（别名映射）
  canonicalToolName,
  // executeCalls/executeCallSummary：工具调用执行与摘要
  executeCalls,
  executeCallSummary,
  // finiteNumber：仅接受有限数字（过滤 NaN/Infinity）
  finiteNumber,
  // primitiveInputSummary：把原始输入参数压缩成一行摘要
  primitiveInputSummary,
  // 工具展示内容/元数据提取
  toolDisplayContent,
  toolDisplayMetadata,
  // ExecuteCall：单条工具调用描述类型
  type ExecuteCall,
} from "../../util/tool-display"
// DialogExecute：工具执行对话框
import { DialogExecute } from "./dialog-execute"
// RetryProvider：请求重试的上下文提供者
import { RetryProvider } from "../../component/retry-provider"
// opentui/solid：渲染器与终端尺寸 hooks、JSX 类型
import { useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid"
// useClient：opencode 客户端（与 server 通信的 SDK）
import { useClient } from "../../context/client"
// 编辑器上下文：外部编辑器集成信息
import { useEditorContext } from "../../context/editor"
// useDialog：通用对话框控制
import { useDialog } from "../../ui/dialog"
// DialogSelect：选项列表对话框
import { DialogSelect } from "../../ui/dialog-select"
// 会话重命名对话框
import { DialogSessionRename } from "../../component/dialog-session-rename"
// TodoItem：待办列表项组件
import { TodoItem } from "../../component/todo-item"
// 图片预览对话框
import { DialogImagePreview } from "../../component/dialog-image-preview"
// createMediaSource：为图片/媒体附件创建渲染数据源
import { createMediaSource } from "../../component/media-source"
// statusLabel：工作区文件变更状态的文案标签
import { statusLabel } from "../../component/dialog-workspace-file-changes"
// 本会话相关的消息/分叉/时间线对话框
import { DialogMessage } from "./dialog-message"
import { DialogFork } from "./dialog-fork"
import { DialogTimeline } from "./dialog-timeline"
// Go 版本升级推广对话框
import { DialogGoUpsell } from "../../component/dialog-go-upsell"
// 用量提醒：额度提示条、限额通知与用量告警 hooks
import { UsageLimitNotice, useLimitNotice, useUsageAlerts } from "../../component/usage"
// useStorage：本地持久化存储上下文
import { useStorage } from "../../context/storage"
// Composer：消息输入组合器（多行编辑、附件等）
import { Composer } from "./composer"
// filetype：按扩展名判断文件类型
import { filetype } from "../../util/filetype"
// parsers-config：语法高亮解析器配置
import parsers from "../../parsers-config"
// errorMessage：把未知异常转成可展示文案
import { errorMessage } from "../../util/error"
// useToast：轻提示（toast）控制
import { useToast } from "../../ui/toast"
// stripAnsi：去除 ANSI 转义序列
import stripAnsi from "strip-ansi"
// usePromptRef：获取 Prompt 组件的全局 ref
import { usePromptRef } from "../../context/prompt"
// usePromptRestore：恢复历史提示输入
import { usePromptRestore } from "../../prompt/restore"
// appendToSessionPrompt：把文本追加进当前会话输入框（草稿暂存互通）
import { appendToSessionPrompt } from "../../component/prompt/draft-stash"
// ProjectedPrompt：投影后的提示数据类型
import type { ProjectedPrompt } from "../../prompt/codec"
// deduplicateVisibleImages：对可见图片附件去重
import { deduplicateVisibleImages } from "../../prompt/attachment"
// useEpilogue：终端退出后的尾注（标题等回显）上下文
import { useEpilogue } from "../../context/epilogue"
// normalizePath：路径规范化
import { normalizePath } from "../../util/path"
// PermissionPrompt：权限请求提示组件
import { PermissionPrompt } from "./permission"
// FormPrompt：表单（questions）提示组件
import { FormPrompt } from "./form"
// 导出选项与导出结果对话框
import { DialogExportOptions } from "../../ui/dialog-export-options"
import { DialogExportResult } from "../../ui/dialog-export-result"
// useConfig：配置状态；useNewDesigns：新 UI 设计开关
import { useConfig, useNewDesigns } from "../../config"
// useClipboard：剪贴板上下文
import { useClipboard } from "../../context/clipboard"
// 思考模式（thinking）切换工具与类型
import { nextThinkingMode, type ThinkingMode } from "../../context/thinking"
// getScrollAcceleration：滚轮加速曲线
import { getScrollAcceleration } from "../../util/scroll"
// 折叠过长的 shell/工具输出
import { collapseShellOutput, collapseToolOutput } from "../../util/collapse-tool-output"
// Keymap：快捷键映射上下文
import { Keymap, type KeymapCommand } from "../../context/keymap"
// 路径展示格式化（绝对/相对）上下文
import { usePathFormatter } from "../../context/path-format"
// useLocation：当前工作目录位置上下文
import { useLocation } from "../../context/location"
// Slot：插件渲染插槽；usePlugin：插件上下文
import { Slot } from "../../plugin/render"
import { usePlugin } from "../../plugin/context"
import {
  // cacheReuseDrop：提示缓存复用/失效的展示数据
  cacheReuseDrop,
  // completeGroupBoundary：补全分组边界（首尾消息对齐）
  completeGroupBoundary,
  // createSessionRows：把消息列表折叠成可渲染行
  createSessionRows,
  // messageBoundaryIDs：消息边界 ID 集合
  messageBoundaryIDs,
  // resolvePart：按 ID 在行中定位消息分片
  resolvePart,
  // sessionRowID：行唯一 ID
  sessionRowID,
  // 类型：缓存用量、分片引用、会话行
  type CacheUsage,
  type PartRef,
  type SessionRow,
} from "./rows"
// switchLabel：模型切换提示文案
import { switchLabel } from "../../util/model"
// 消息边界查找与导航缓冲计算
import { findMessageBoundary, messageNavigationSlack } from "./message-navigation"
// stringWidth：计算字符串的终端显示宽度（含宽字符）
import { stringWidth } from "../../util/string-width"
// useArgs：命令行参数上下文
import { useArgs } from "../../context/args"
// 会话标题生成失败时的兜底（带时间戳）
import { withTimestampedFallback } from "@opencode/util/session-title-fallback"
// SessionTurn：会话轮次分析（区分新旧协议消息）
import { SessionTurn } from "@opencode/util/session-turn"
// 会话标签页上下文与滚动锚点类型
import { useSessionTabs, type ScrollAnchor } from "../../context/session-tabs"
// createSingleFlight：并发去重工具（同一时刻只跑一个）
import { createSingleFlight } from "../../util/single-flight"
// createDelayedPresence：延迟出现的"进行中"标记
import { createDelayedPresence } from "../../util/delayed-presence"
// 会话位置缺失的占位视图
import { SessionLocationMissing } from "./location-missing"
// isRecord：判断值是否为普通对象
import { isRecord } from "../../util/record"
// parseTodos：解析 todo 工具产出的待办数据
import { parseTodos } from "../../util/todo"
// createHistoryPrepend：向上翻页时向历史缓冲区头部补充行
import { createHistoryPrepend } from "./history"
// 渲染上下文：会话内部共享的 context/use 与待处理动作类型
import { context, use, type PendingAction } from "./render-context"
// 消息分片渲染件：内联工具行、推理块、文本块与展示选择器
import { INLINE_TOOL_ICON_WIDTH, InlineToolRow, ReasoningPart, TextPart, toolDisplay } from "./message-parts"
// 分组模块：默认详略级别、分组类型与会话条目类型
import { defaultVerbosity, type GroupKind, type SessionEntry } from "./grouping/session"
// SessionGroupView：分组视图组件
import { SessionGroupView } from "./group-view"
// useEntryAnchor：条目锚点 hook
import { useEntryAnchor } from "./anchor-view"
// 时间线锚点：包含判断、构建与分组 ID
import { containsAnchor, createTimelineAnchors, groupID } from "./anchors"
// 挂载预算：向上/向下取行与行权重
import { rowsAfter, rowsBefore, rowWeight } from "./mount-budget"
// 转发导出：外部可直接从本模块取这两个成员
export { InlineToolRow } from "./message-parts"
export { toolDisplay } from "./message-parts"

// 注册默认的语法解析器（代码块高亮依赖）
addDefaultParsers(parsers.parsers)

// 测量转录区真实高度时要排除底部临时占位（导航缓冲区）。
const NAVIGATION_SLACK_ID = "session-navigation-slack"
// 后台工具运行提示延迟出现的毫秒数
const BACKGROUND_TOOL_HINT_DELAY = 3_000

// 挂载预算按"渲染条目数"计（见 mount-budget.ts），折叠分组算 1 条。
// 尾部 40 行足以填满高视口；读者向上滚动时更老的行按块补充挂载。
const TRANSCRIPT_TAIL_ROWS = 40
// 每次向历史回填的行数
const TRANSCRIPT_BACKFILL_CHUNK = 60

/**
 * Session 会话路由组件：整个终端界面的核心容器。
 *
 * 职责：
 * - 订阅当前会话的消息、权限请求、表单、待处理用户输入等数据，折叠成可渲染行并按预算挂载；
 * - 渲染转录流（用户/助手消息、推理、工具行、分组）、头部状态条与底部输入区；
 * - 处理键盘快捷键（翻页、跳转、复制、导出、分叉等）、鼠标滚动与拖拽分隔条；
 * - 弹出各类对话框（重命名、时间线、消息详情、图片预览、导出、执行命令等）。
 *
 * 设计要点：
 * - 转录区使用 ScrollBoxRenderable + 挂载预算（TRANSCRIPT_TAIL_ROWS/BACKFILL_CHUNK）做增量渲染，
 *   避免长会话全量挂载；滚动位置由锚点（anchors）机制在行增删时保持稳定；
 * - 权限/表单提示与输入框互斥（disabled），子会话的权限不在本页处理。
 */
export function Session(props: {
  // scrollRef：把转录滚动容器实例暴露给父组件
  scrollRef?: (scroll: ScrollBoxRenderable | undefined) => void
  // verticalTabsWidth：垂直会话标签栏占用的宽度
  verticalTabsWidth: number
  // promptMuted：是否静音输入区（父级有覆盖 UI 时）
  promptMuted?: boolean
  // sidebarVisible：侧边栏是否可见
  sidebarVisible: boolean
  // onToggleSidebar：切换侧边栏回调
  onToggleSidebar: () => void
  // terminals：是否显示终端标签页
  terminals?: boolean
  // visibleTerminalID：当前可见终端的 ID
  visibleTerminalID?: string
  // onTerminalPicker：向父级注册"打开终端选择器"的回调（卸载时传 undefined 注销）
  onTerminalPicker?: (show: (() => void) | undefined) => void
  // width：覆盖容器宽度（分屏时由父级给定）
  width?: number
}) {
  // 尾注上下文：退出终端时回显会话标题等信息
  const epilogue = useEpilogue()
  // 剪贴板上下文：复制文本/图片
  const clipboard = useClipboard()
  const paths = useTuiPaths()
  const writeExport = async (file: string, content: string) => {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, content)
  }
  // 读取路由数据中的会话 ID
  const route = useRouteData("session")
  const sessionID = route.sessionID
  // navigate：跳转到其他会话/页面
  const { navigate } = useRoute()
  // 全局数据上下文（会话、消息、权限等）
  const data = useData()
  // 本地 UI 状态（权限模式等）
  const local = useLocal()
  // 命令行参数
  const args = useArgs()
  // 配置状态与其中的数据快照
  const configState = useConfig()
  const config = configState.data
  // 当前主题
  const theme = useTheme()
  // 底层输入框 Prompt 的 ref
  const promptRef = usePromptRef()
  // 当前会话信息（按路由会话 ID 派生）
  const session = createMemo(() => data.session.get(route.sessionID))
  // 消息列表访问器（保持函数形式以便响应式追踪）
  const messages = () => data.session.message.list(route.sessionID)
  // 消息 ID -> 数组下标的索引表，便于 O(1) 定位
  const messageIndexes = createMemo(() => new Map(messages().map((message, index) => [message.id, index])))
  // 是否处于"遗留协议"消息形态（旧版 server 数据）
  const legacy = createMemo(() => SessionTurn.legacy(messages()))
  // 回滚（revert）点之前的消息：用于撤销后展示旧状态
  const messagesBeforeRevert = () => {
    const messageID = session()?.revert?.messageID
    // 没有回滚点则返回全部消息
    if (!messageID) return messages()
    // 找到回滚锚点消息，截取其之前的部分
    const index = messages().findIndex((message) => message.id === messageID)
    return index === -1 ? messages() : messages().slice(0, index)
  }
  // 回滚点之后（含锚点）的消息：被撤销的内容，折叠在"已撤销"提示里
  const messagesFromRevert = () => {
    const messageID = session()?.revert?.messageID
    if (!messageID) return []
    const index = messages().findIndex((message) => message.id === messageID)
    return index === -1 ? [] : messages().slice(index)
  }
  // 当前工作目录位置上下文
  const currentLocation = useLocation()
  // 会话绑定的目录优先，否则用当前全局位置
  const location = createMemo(() => session()?.location ?? currentLocation.ref)

  // 把会话目录同步回全局位置上下文
  createEffect(() => currentLocation.set(location()))

  // 把会话标题（截断到 50 字符）写入尾注，退出终端时可见
  createEffect(() => {
    const title = Locale.truncate(session()?.title ?? "", 50)
    epilogue.session({ title, sessionID: session()?.id })
  })
  // 组件卸载时清空尾注中的会话信息
  onCleanup(() => epilogue.session())
  // 子会话 ID 列表：仅当本会话是父会话时才有子代
  const descendantSessionIDs = createMemo(() => {
    if (session()?.parentID) return []
    return data.session.family(route.sessionID).filter((id) => id !== route.sessionID)
  })
  // 权限请求列表：聚合本会话与全部子会话的待处理权限
  const permissions = createMemo(() => {
    if (session()?.parentID) return []
    return [route.sessionID, ...descendantSessionIDs()].flatMap(
      (sessionID) => data.session.permission.list(sessionID) ?? [],
    )
  })
  // 实际要弹出提示的权限：自动接受模式下不弹
  const promptedPermissions = createMemo(() => (local.permission.mode === "autoaccept" ? [] : permissions()))
  // 待填表单：合并全局表单与（父会话及子会话的）会话级表单
  const forms = createMemo(() => {
    const global = data.session.form.list("global", location()) ?? []
    if (session()?.parentID) return global
    return [route.sessionID, ...descendantSessionIDs()]
      .flatMap((sessionID) => data.session.form.list(sessionID) ?? [])
      .concat(global)
  })
  // 待处理的用户输入项（类型为 user 的 pending）
  const pendingUsers = createMemo(() =>
    data.session.pending.list(route.sessionID).flatMap((item) => (item.type === "user" ? [item] : [])),
  )
  // pending ID -> 投递方式的映射（立即/排队）
  const pendingDeliveries = createMemo(() => new Map(pendingUsers().map((item) => [item.id, item.delivery])))
  // 排队等待发送的提示词列表
  const queuedPrompts = createMemo(() =>
    pendingUsers().flatMap((item) =>
      item.delivery === "queue" ? [{ id: item.id, text: item.payload.text, payload: item.payload }] : [],
    ),
  )
  // 输入组合器（composer）状态：是否打开、当前标签
  const [composer, setComposer] = createStore({
    open: false,
    tab: undefined as string | undefined,
  })
  // 向父级注册打开终端选择器的回调
  props.onTerminalPicker?.(() => setComposer({ open: true, tab: "terminals" }))
  // 卸载时注销回调
  onCleanup(() => props.onTerminalPicker?.(undefined))
  // 输入区被静音时强制关闭 composer，避免与覆盖 UI 抢焦点
  createEffect(() => {
    if (props.promptMuted && composer.open) setComposer("open", false)
  })
  // 存在待处理权限或表单时，输入区进入禁用态
  const disabled = createMemo(() => promptedPermissions().length > 0 || forms().length > 0)

  // 终端渲染器与尺寸
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  // 思考内容展示模式（hide/inline/...），默认隐藏
  const thinkingMode = createMemo<ThinkingMode>(() => config.session?.thinking ?? "hide")
  // 是否显示滚动条
  const showScrollbar = createMemo(() => config.session?.scrollbar ?? false)
  // Markdown 呈现方式（渲染/原文），默认渲染
  const markdownMode = createMemo(() => config.session?.markdown ?? "rendered")
  // diff 换行模式（word/char），默认按词
  const diffWrapMode = createMemo(() => config.diffs?.wrap ?? "word")
  // 是否按探索/指令对消息分组，"none" 表示关闭
  const groupExploration = createMemo(() => config.session?.grouping !== "none")
  // 分组摘要详略级别
  const verbosity = createMemo(() => config.session?.verbosity ?? defaultVerbosity)
  // High 级别默认展开探索与指令摘要，其余级别默认折叠。
  // 判断某分组是否展开：优先取标签页记住的状态；未记住时 high 级别默认展开探索/指令分组
  const groupExpanded = (groupID: string, kind: GroupKind) =>
    sessionTabs.groupExpanded(sessionID, groupID) ??
    (verbosity() === "high" && (kind === "exploration" || kind === "instructions"))
  // 判断某类分组是否参与分组展示：推理组取决于思考模式是否隐藏，探索组取决于开关，其余恒开
  const groupedKind = (kind: GroupKind) =>
    kind === "reasoning" ? thinkingMode() === "hide" : kind === "exploration" ? groupExploration() : true

  // 注册会话级快捷键层：窄屏且侧边栏可见时允许用 esc/ctrl+c 关闭侧边栏
  Keymap.createLayer(() => ({
    priority: 10,
    enabled: () => props.sidebarVisible && dimensions().width - props.verticalTabsWidth <= 120 && !disabled(),
    commands: [{ bind: "escape,ctrl+c", title: "Close sidebar", group: "Session", run: props.onToggleSidebar }],
  }))
  // 内容区宽度：容器宽度（或终端宽减去标签栏）再减去左右内边距 4
  const contentWidth = createMemo(() => (props.width ?? dimensions().width - props.verticalTabsWidth) - 4)
  // 当前目录可用的模型列表
  const models = createMemo(() => data.location.model.list(location()) ?? [])

  // 滚动加速度配置（惯性滚动曲线）
  const scrollAcceleration = createMemo(() => getScrollAcceleration(config))
  // toast 提示、提示词恢复、客户端实例
  const toast = useToast()
  const restorePrompt = usePromptRestore()
  const client = useClient()
  // 已自动批准的权限请求 ID 集合，防止重复批复
  const autoApproved = new Set<string>()
  // 自动接受模式下：批量把所有待处理权限以"仅本次"批复掉
  createEffect(() => {
    if (local.permission.mode !== "autoaccept") return
    permissions().forEach((request) => {
      // 已处理过的请求跳过
      if (autoApproved.has(request.id)) return
      autoApproved.add(request.id)
      void data.session.permission
        .reply({
          sessionID: request.sessionID,
          decision: "once",
          requestID: request.id,
        })
        .catch((error) => {
          // 批复失败则回退记录并弹错误提示，允许下次重试
          autoApproved.delete(request.id)
          toast.error(error)
        })
    })
  })
  // 编辑器上下文（外部编辑器连接状态）
  const editor = useEditorContext()
  // 行数据是否已完成首轮同步
  const [rowsSynced, setRowsSynced] = createSignal(false)
  // 创建会话行：把消息流折叠为行，监听会话同步完成与上方分页钉住点
  const rows = createSessionRows(
    () => route.sessionID,
    (id) => {
      if (id === sessionID) setRowsSynced(true)
    },
    // 滚动触发的历史加载会并入这个边界加载，而不是单独发布一页。
    () => pinAbove(),
  )
  // 消息边界 ID 集合（用于消息级跳转）
  const boundaries = createMemo(() => messageBoundaryIDs(rows, messages()))
  // 时间线锚点仓库
  const anchors = createTimelineAnchors()
  // 当前导航聚焦的消息 ID
  const [navigationMessage, setNavigationMessage] = createSignal<string>()
  // 导航缓冲高度（顶部/底部预留空间）
  const [navigationSlack, setNavigationSlack] = createSignal(0)
  // 首次跳转函数（跳到第一条消息）
  const [firstJump, setFirstJump] = createSignal<() => void>()
  // 会话数据是否同步完成
  const [synced, setSynced] = createSignal(false)
  // 会话标签页上下文
  const sessionTabs = useSessionTabs()
  // 视口是否已离开底部（用于"回到最新"提示）
  const [awayFromBottom, setAwayFromBottom] = createSignal(false)
  // 鼠标是否悬停在最新消息附近
  const [latestHovered, setLatestHovered] = createSignal(false)
  // 等待"挂载全部行"完成的回调队列
  let ensureAllRowsPending: (() => void)[] | undefined
  // 回到底部后取消"最新"悬停态
  createEffect(() => {
    if (!awayFromBottom()) setLatestHovered(false)
  })

  // 清理消息导航状态：取消挂起的挂载任务、取消历史预置、执行并清空首次跳转
  const clearMessageNavigation = () => {
    ensureAllRowsPending?.splice(0)
    prependHistory.cancel()
    firstJump()?.()
    setFirstJump(undefined)
    setNavigationSlack(0)
    setNavigationMessage(undefined)
  }

  // 终端尺寸或标签栏宽度变化时：清理消息导航并重算"是否离开底部"
  createEffect(
    on(
      () => [dimensions().width, dimensions().height, props.verticalTabsWidth] as const,
      (_, previous) => {
        // 首次运行没有旧值，跳过
        if (!previous) return
        clearMessageNavigation()
        if (scroll && !scroll.isDestroyed) updateAwayFromBottom()
      },
    ),
  )

  // 连接建立后，补同步所有子会话的权限与表单（Promise.allSettled 容忍单个失败）
  createEffect(
    on([descendantSessionIDs, () => client.connection.status()], ([sessionIDs, status]) => {
      if (status !== "connected") return
      void Promise.allSettled(
        sessionIDs.flatMap((sessionID) => [data.session.permission.sync(sessionID), data.session.form.sync(sessionID)]),
      )
    }),
  )

  // 连接建立后拉取本会话的完整数据（含子会话、权限、表单），完成后标记 synced
  createEffect(() => {
    if (client.connection.status() !== "connected") return
    setSynced(false)
    const sessionID = route.sessionID
    void (async () => {
      // 并行同步会话（含子会话）、权限与表单（权限/表单失败不阻塞）
      await Promise.all([
        data.session.sync(sessionID, { children: true }),
        data.session.permission.sync(sessionID).catch(() => undefined),
        data.session.form.sync(sessionID).catch(() => undefined),
      ])
      const info = data.session.get(sessionID)
      // 会话不存在（可能已被删除）：提示并关闭标签页或回主页
      if (!info) {
        toast.show({
          message: `Session not found: ${sessionID}`,
          variant: "error",
          duration: 5000,
        })
        sessionTabs.enabled() ? sessionTabs.close(sessionID) : navigate({ type: "home" })
        return
      }
      // 让外部编辑器重新连接到会话目录
      editor.reconnect(info.location.directory)
      setSynced(true)
    })().catch((error) => {
      // 路由已切走则忽略过期错误
      if (route.sessionID !== sessionID) return
      toast.show({
        message: errorMessage(error),
        variant: "error",
        duration: 5000,
      })
      sessionTabs.enabled() ? sessionTabs.close(sessionID) : navigate({ type: "home" })
    })
  })

  // 组件级一次性标记：是否已播种、已发送、已恢复滚动
  let seeded = false
  let sent = false
  let restored = false
  // 转录区滚动容器实例（JSX 中绑定）
  let scroll: ScrollBoxRenderable
  // 会话与行数据都就绪后，恢复上次滚动位置（只执行一次）
  createEffect(() => {
    if (restored || !synced() || !rowsSynced() || !scroll || scroll.isDestroyed) return
    restored = true
    // 初次同步可能完成于读者已经手动导航之后，此时不打扰。
    if (!isAwayFromBottom()) restoreScrollPosition()
  })
  // "离开底部"提示的定时器
  let awayTimer: ReturnType<typeof setTimeout> | undefined
  // 卸载清理：清定时器、解除滚动引用、取消挂起任务、保存滚动锚点
  onCleanup(() => {
    if (awayTimer) clearTimeout(awayTimer)
    props.scrollRef?.(undefined)
    prependHistory.cancel()
    firstJump()?.()
    if (!scroll || scroll.isDestroyed) return
    scroll.verticalScrollBar.off("change", updateAwayFromBottom)
    saveScrollAnchor(true)
  })
  // 底层 Prompt 组件实例信号
  const [prompt, setPrompt] = createSignal<PromptRef>()
  // 绑定 Prompt ref：同步到本地信号与全局 promptRef 上下文
  const bind = (r: PromptRef | undefined) => {
    setPrompt(r)
    promptRef.set(r)
    // 初次绑定且路由带有预填提示词时，播种进输入框（只做一次）
    if (seeded || !route.prompt || !r) return
    seeded = true
    r.set(route.prompt)
  }

  /** 在下一帧布局完成后、绘制前执行回调；转录区已被销毁则静默跳过。 */
  const afterLayout = (continuation: () => void) => {
    if (!scroll || scroll.isDestroyed) return
    scroll.afterLayout(() => {
      if (!scroll.isDestroyed) continuation()
    })
  }

  // 在新内容发布前钉住已有行：流式输出会加在读者视口下方，
  // 若不锚定，旧行上方新增高度到来时视口内容会被顶走。
  const pinAbove = () => {
    if (!scroll || scroll.isDestroyed) return
    // 已处于吸底滚动时无需钉住
    if (scroll.stickyScroll && scroll.scrollTop >= scroll.scrollHeight - scroll.viewport.height) return
    // 找到视口顶部横跨的第一个非零高度子节点并锚定它
    const node = scroll.getChildren().find((node) => node.height > 0 && node.y + node.height > scroll.viewport.y)
    if (node) afterLayout(scroll.anchor(node))
  }

  // 尾部优先的转录挂载：打开会话时只挂载最新若干行；更老的行在接近顶部时按需挂载，
  // 让非活跃标签页的开销与卸载成本都保持低廉。读者停在底部时隐藏区间跟随追加增长；
  // 一旦离开底部就固定区间，保证视口不跳动。
  const [hiddenRows, setHiddenRows] = createSignal<number>()
  const [visibleRowsEnd, setVisibleRowsEnd] = createSignal<number>()
  // 计算每行的"权重"（渲染代价），供预算函数使用
  const weights = createMemo(() =>
    rows.map((row) =>
      rowWeight(row, {
        expanded: groupExpanded,
        grouped: groupedKind,
      }),
    ),
  )
  // 隐藏区上界：取手动设置的隐藏数与"尾部 40 行预算"的较小者
  const hidden = createMemo(() =>
    Math.min(hiddenRows() ?? Infinity, rowsBefore(weights(), rows.length, TRANSCRIPT_TAIL_ROWS)),
  )
  // 可见区结束下界：默认到最后一行
  const visibleEnd = createMemo(() => Math.max(hidden(), Math.min(visibleRowsEnd() ?? rows.length, rows.length)))
  // 当前实际挂载的行切片（隐藏区之后到可见结束之间）
  const visibleRows = createMemo(() => rows.slice(hidden(), visibleEnd()))
  // 向上翻页的历史预置器：加载更早消息并保持视口稳定
  const prependHistory = createHistoryPrepend({
    sessionID: () => route.sessionID,
    // 是否还有更早消息可加载
    more: (id) => data.session.message.more(id),
    // 加载一页更早的消息；发布前先钉住视口，随后补齐分组边界
    loadMore: async (id) => {
      const beforePublish = () => {
        if (route.sessionID === id) pinAbove()
      }
      await data.session.message.loadMore(id, { beforePublish })
      await completeGroupBoundary({
        rows,
        messages: () => data.session.message.list(id).length,
        more: () => data.session.message.more(id),
        loadMore: () => data.session.message.loadMore(id, { beforePublish }),
        active: () => route.sessionID === id,
      })
    },
    afterLayout,
    // 仅当本会话活跃且滚动容器健在时才允许加载
    active: (id) => route.sessionID === id && Boolean(scroll && !scroll.isDestroyed),
    // 加载后的补偿滚动，保持视口内容不跳
    scrollBy: (amount) => {
      scroll.scrollBy(amount)
      updateAwayFromBottom()
    },
  })
  // 正在展开更老行的标志（防止重入）
  let revealingOlderRows = false
  // 向顶部方向展开更老的行；已在顶部附近时改为加载历史页
  const revealOlderRows = (scrollBy = 0) => {
    const current = hidden()
    // 正在展开、容器失效或视口已离开顶部两屏以上时放弃
    if (revealingOlderRows || !scroll || scroll.isDestroyed || scroll.scrollTop > scroll.viewport.height) return false
    // 没有可展开的隐藏行时，转为预置历史
    if (current === 0) return prependHistory(scrollBy)
    revealingOlderRows = true
    // 展开期间关闭吸底并钉住视口，再按块扩大可见范围
    scroll.stickyScroll = false
    pinAbove()
    setHiddenRows(rowsBefore(weights(), current, TRANSCRIPT_BACKFILL_CHUNK))
    afterLayout(() => {
      // 布局完成后补偿滚动并恢复吸底状态
      scroll.scrollBy(scrollBy)
      scroll.stickyScroll = !navigationMessage()
      revealingOlderRows = false
    })
    return true
  }
  // 正在展开更新行的标志
  let revealingNewerRows = false
  // 向底部方向展开更多行（向下翻页时用）
  const revealNewerRows = (scrollBy = 0) => {
    const current = visibleEnd()
    if (
      revealingNewerRows ||
      current === rows.length ||
      !scroll ||
      scroll.isDestroyed ||
      scroll.scrollTop + scroll.viewport.height < scroll.scrollHeight - scroll.viewport.height
    )
      return false
    revealingNewerRows = true
    // 按块计算新的可见结束位置；到达末尾则解除限制
    const next = rowsAfter(weights(), current, TRANSCRIPT_BACKFILL_CHUNK)
    setVisibleRowsEnd(next === rows.length ? undefined : next)
    afterLayout(() => {
      revealingNewerRows = false
      scroll.scrollBy(scrollBy)
      updateAwayFromBottom()
    })
    return true
  }
  /** 消息导航（逐条/跳转）需要全量转录行已挂载后再执行。 */
  const ensureAllRows = (continuation: () => void) => {
    // 已有首次跳转挂起时先清理导航状态
    if (firstJump()) clearMessageNavigation()
    // 全部行均已挂载则直接执行
    if (!ensureAllRowsPending && hidden() === 0 && visibleEnd() === rows.length) return continuation()
    // 已有挂起批次则排队等待
    if (ensureAllRowsPending) {
      ensureAllRowsPending.push(continuation)
      return
    }
    // 首个请求：解除隐藏区间限制，等布局完成后统一执行排队的回调
    const pending = [continuation]
    ensureAllRowsPending = pending
    setHiddenRows(0)
    setVisibleRowsEnd(undefined)
    afterLayout(() => {
      if (ensureAllRowsPending === pending) ensureAllRowsPending = undefined
      pending.forEach((continuation) => continuation())
      updateAwayFromBottom()
    })
  }

  // 判断视口是否已离开底部（任何展开/导航状态或滚动位置不在底部都算）
  function isAwayFromBottom() {
    if (
      revealingOlderRows ||
      revealingNewerRows ||
      ensureAllRowsPending ||
      navigationMessage() ||
      navigationSlack() ||
      firstJump()
    )
      return true
    if (visibleEnd() < rows.length) return true
    return scroll.scrollTop < Math.max(0, scroll.scrollHeight - scroll.viewport.height)
  }
  // 更新"离开底部"状态（去抖：状态变化延后一拍，避免滚动抖动）
  function updateAwayFromBottom() {
    // 这些进行中的操作要求保持当前挂载窗口
    const preserveWindow = revealingOlderRows || revealingNewerRows || !!ensureAllRowsPending || !!firstJump()
    if (isAwayFromBottom()) setHiddenRows((current) => current ?? hidden())
    if (awayTimer) clearTimeout(awayTimer)
    awayTimer = setTimeout(() => {
      awayTimer = undefined
      if (!scroll || scroll.isDestroyed) return
      const away = preserveWindow || isAwayFromBottom()
      setAwayFromBottom(away)
      if (!away) {
        // 回到底部：无文本选区时清掉隐藏行限制并恢复吸底
        if (!renderer.getSelection()) setHiddenRows(undefined)
        scroll.stickyScroll = true
      }
      saveScrollAnchor()
    })
  }
  // 保存滚动锚点：记录视口顶部可见的行目标，供切换标签页后恢复
  function saveScrollAnchor(unmounting = false) {
    // 初次布局不得在同步恢复之前覆盖已保存的位置。
    if (!restored) return
    const mounted = anchors.list()
    // Solid 会在路由清理之前先销毁子组件的注册；子组件都已消失时
    // 保留最后一次滚动事件写入的锚点，避免误清。
    if (unmounting && !mounted.length) return
    if (!isAwayFromBottom()) {
      // 在底部则清除锚点（下次打开直接吸底）
      sessionTabs.setScrollAnchor(sessionID, undefined)
      return
    }
    let first: ScrollAnchor | undefined
    let anchor: ScrollAnchor | undefined
    // 遍历已挂载的锚点子项，找视口顶部之上最贴近顶部的那个
    for (const child of mounted) {
      const item = {
        target: child.target,
        screenY: child.node.y - scroll.viewport.y,
      }
      first ??= item
      // 分组与助手消息允许 1 行的内边距，其余要求完全在视口顶之上
      const inset =
        item.target.type === "group" ||
        data.session.message.get(sessionID, item.target.ref.messageID)?.type === "assistant"
          ? 1
          : 0
      if (item.screenY <= inset && (!anchor || item.screenY > anchor.screenY)) anchor = item
    }
    // 没有合格的就用最上面的那个兜底
    anchor ??= first
    if (anchor) sessionTabs.setScrollAnchor(sessionID, anchor)
    else sessionTabs.setScrollAnchor(sessionID, undefined)
  }
  // 恢复上次滚动位置（切回标签页时）
  function restoreScrollPosition() {
    const anchor = sessionTabs.scrollAnchor(sessionID)
    const index = anchor ? rows.findIndex((row) => containsAnchor(row, anchor.target)) : -1
    // 没有锚点或行已不存在：直接滚到底部
    if (!anchor || index === -1) {
      scroll.scrollTo(scroll.scrollHeight)
      setAwayFromBottom(false)
      return
    }
    // 以锚点为中心展开前后各一块可见区间
    setHiddenRows(rowsBefore(weights(), index, TRANSCRIPT_BACKFILL_CHUNK))
    const end = rowsAfter(weights(), index, TRANSCRIPT_BACKFILL_CHUNK)
    setVisibleRowsEnd(end === rows.length ? undefined : end)
    // 恢复期间关闭吸底，等布局后精确对位
    scroll.stickyScroll = false
    // restore：布局完成后把锚点行对齐到记录时的屏幕位置；可能需要多轮展开才能到达
    const restore = () =>
      afterLayout(() => {
        const boundary = anchors.get(anchor.target)
        // 锚点行已不存在：清锚点并回到底部
        if (!boundary) {
          sessionTabs.setScrollAnchor(sessionID, undefined)
          scroll.stickyScroll = true
          scroll.scrollTo(scroll.scrollHeight)
          setAwayFromBottom(false)
          return
        }
        // 计算目标滚动位置：锚点内容坐标减去记录时的屏幕偏移
        const contentY = scroll.scrollTop + boundary.node.y - scroll.viewport.y
        const target = contentY - anchor.screenY
        const maximum = Math.max(0, scroll.scrollHeight - scroll.viewport.height)
        // 目标超出最大滚动且下方还有未挂载行：继续向下展开后再试
        if (target > maximum && visibleEnd() < rows.length) {
          const next = rowsAfter(weights(), visibleEnd(), TRANSCRIPT_BACKFILL_CHUNK)
          setVisibleRowsEnd(next === rows.length ? undefined : next)
          restore()
          return
        }
        // 仍超出最大滚动：临时加高导航缓冲（slack）撑出可滚动空间
        if (target > maximum) {
          setNavigationSlack(
            messageNavigationSlack({
              top: target,
              viewportHeight: scroll.viewport.height,
              scrollHeight: scroll.scrollHeight,
              currentSlack: scroll.getRenderable(NAVIGATION_SLACK_ID)?.height ?? 0,
            }),
          )
          restore()
          return
        }
        // 精确滚动到目标位置
        scroll.scrollTo(target)
        updateAwayFromBottom()
      })
    restore()
  }

  // 命令行带 -p/--prompt 时：模型与代理就绪且输入框内容一致，自动提交发送（只发一次）
  createEffect(() => {
    const current = prompt()
    if (sent || !current || !synced() || !local.model.ready || !local.model.catalogReady) return
    if (!local.agent.current() || !local.model.current()) return
    if (!args.prompt || route.prompt?.text !== args.prompt || current.current.text !== args.prompt) return
    sent = true
    current.submit()
  })
  // 对话框与本地存储上下文
  const dialog = useDialog()
  const storage = useStorage()
  // Go 推广的持久化展示状态（最近展示时间、不再显示）
  const [goUpsell, updateGoUpsell] = storage.store<{ lastSeenAt?: number; dontShow?: boolean }>("go-upsell", {
    initial: {},
  })
  // 同一 key 的内存态副本：持久层写入失败时的回退
  const [goUpsellMemory, updateGoUpsellMemory] = storage.memory<{ lastSeenAt?: number; dontShow?: boolean }>(
    "go-upsell",
    { initial: {} },
  )
  // 已处理过限额事件的助手消息 ID，防止重复弹窗
  const handledLimits = new Set<string>()
  // 订阅用量告警（限额接近时提示）
  useUsageAlerts(() => route.sessionID)
  // 会话是否已被销毁（卸载标记）
  let sessionDisposed = false
  onCleanup(() => {
    sessionDisposed = true
  })
  // 免费额度或 OpenCode Go 限额阻断时：把被拦下的提示词恢复回输入框，
  // 并在当天首次触发免费额度时推荐 OpenCode Go。
  onCleanup(
    data.on("session.step.failed", async (event) => {
      const type = event.data.error.type
      // 只处理本会话的失败事件
      if (event.data.sessionID !== route.sessionID) return
      // 只关心免费额度与 Go 限额两类错误
      if (type !== "provider.free-limit" && type !== "provider.go-limit") return
      if (handledLimits.has(event.data.assistantMessageID)) return
      handledLimits.add(event.data.assistantMessageID)
      // empty：判断输入框是否为空（无文本/文件/代理/技能/粘贴内容）
      const empty = (ref: PromptRef | undefined): ref is PromptRef =>
        !!ref &&
        !ref.current.text.trim() &&
        !ref.current.files?.length &&
        !ref.current.agents?.length &&
        !ref.current.skills?.length &&
        !ref.current.pasted.length
      // 输入框非空说明用户已在编辑，不打扰
      if (!empty(prompt())) return
      // 从失败消息向前找最近一条尚未投递的用户消息作为"被拦下的提示词"
      const list = messages()
      const end = list.findIndex((item) => item.id === event.data.assistantMessageID)
      let recalled: SessionMessageUser | undefined
      for (let i = end - 1; i >= 0 && !recalled; i--) {
        const item = list[i]
        // 遇到 shell/idle 等边界即停止回溯
        if (!item || item.type === "shell" || item.type === "idle") break
        if (item.type === "user" && !data.session.input.has(route.sessionID, item.id)) recalled = item
      }
      // 恢复该用户消息到草稿态；失败则提示并不弹推荐
      const restored = recalled
        ? await restorePrompt(recalled).catch((error) => {
            toast.show({ message: errorMessage(error), variant: "error", duration: 5000 })
            return null
          })
        : undefined
      // 媒体引用先于提示词回填加载；期间用户打字或执行 shell 命令则保留现状并跳过推荐。
      // 恢复失败、会话已销毁或路由已切走：放弃本次推荐
      if (restored === null || sessionDisposed || route.sessionID !== event.data.sessionID) return
      const current = prompt()
      // 输入框非空或不在普通模式：不覆盖用户输入
      if (!empty(current) || current.mode !== "normal") return
      // 有恢复内容则写回输入框
      if (restored) current.set(restored)
      // Go 限额或已有对话框打开：不再叠加推荐
      if (type === "provider.go-limit" || dialog.stack.length > 0) return
      if (goUpsell.dontShow || goUpsellMemory.dontShow) return
      const now = Date.now()
      // 24 小时内已展示过则跳过（取持久层与内存层的较新时间）
      const seen = Math.max(goUpsell.lastSeenAt ?? 0, goUpsellMemory.lastSeenAt ?? 0)
      if (seen > 0 && now - seen < 86_400_000) return
      // 记录当前输入框内容的指纹，用于判断弹窗期间内容是否被改动
      const expectedText = current.current.text
      const expectedFiles = current.current.files?.length ?? 0
      const expectedAgents = current.current.agents?.length ?? 0
      const expectedSkills = current.current.skills?.length ?? 0
      const expectedPasted = current.current.pasted.length
      // hasRecalledPrompt：输入框内容仍与恢复时完全一致（未被用户改动）
      const hasRecalledPrompt = () => {
        const active = prompt()
        return Boolean(
          !sessionDisposed &&
            route.sessionID === event.data.sessionID &&
            active &&
            active.current.text === expectedText &&
            (active.current.files?.length ?? 0) === expectedFiles &&
            (active.current.agents?.length ?? 0) === expectedAgents &&
            (active.current.skills?.length ?? 0) === expectedSkills &&
            active.current.pasted.length === expectedPasted,
        )
      }
      // 弹窗条件：提示词未被改动、无其他对话框、未被永久关闭
      const canOpen = () =>
        Boolean(hasRecalledPrompt() && dialog.stack.length === 0 && !goUpsell.dontShow && !goUpsellMemory.dontShow)
      const previousSeen = goUpsellMemory.lastSeenAt
      // 先在内存层记录展示时间，防止持久层失败导致重复弹
      updateGoUpsellMemory((draft) => {
        draft.lastSeenAt = now
      })
      let claimed = false
      void updateGoUpsell((draft) => {
        // 持久层已标记不再显示：同步到内存层
        if (draft.dontShow) {
          updateGoUpsellMemory((mem) => {
            mem.dontShow = true
            mem.lastSeenAt = draft.lastSeenAt ?? previousSeen
          })
          return
        }
        // 24 小时内展示过：只同步时间戳
        if ((draft.lastSeenAt ?? 0) > 0 && now - (draft.lastSeenAt ?? 0) < 86_400_000) {
          updateGoUpsellMemory((mem) => {
            mem.lastSeenAt = draft.lastSeenAt
          })
          return
        }
        // 不满足弹窗条件：回滚内存层时间戳
        if (!canOpen()) {
          updateGoUpsellMemory((mem) => {
            mem.lastSeenAt = previousSeen
          })
          return
        }
        // 抢占本次展示权并记录时间
        draft.lastSeenAt = now
        claimed = true
      })
        .catch(() => {
          // 持久层失败也允许展示（内存层已兜底）
          claimed = true
        })
        .then(() => {
          // 获得展示权且条件仍满足时打开 Go 推荐对话框
          if (!claimed || !canOpen()) return
          dialog.replace(() => (
            <DialogGoUpsell
              reset={freeLimitReset(event.data.error.retryAfterMs, event.created)}
              canContinue={hasRecalledPrompt}
              onDontShowAgain={() => {
                // 两层都写入"不再显示"
                updateGoUpsellMemory((draft) => {
                  draft.dontShow = true
                })
                void updateGoUpsell((draft) => {
                  draft.dontShow = true
                }).catch(() => undefined)
              }}
              onSubscribe={() => {
                // 直接重新提交被拦下的提示词
                prompt()?.submit()
              }}
            />
          ))
        })
    }),
  )
  // 待处理提示词操作的单飞控制器：同一 inboxID 同时只执行一个动作
  const runPendingAction = createSingleFlight<string>()
  // 使用闭包捕获的 sessionID：await 之后 route.sessionID 可能已指向别的标签页或为空。
  const requestPending = async (action: PendingAction, inboxID: string, failureLabel?: string) => {
    // steer：立即插队；queue：加入队列；cancel：撤销删除
    const request =
      action === "steer"
        ? client.api.session.inbox.update({ sessionID, inboxID, delivery: "steer" })
        : action === "queue"
          ? client.api.session.inbox.update({ sessionID, inboxID, delivery: "queue" })
          : client.api.session.inbox.cancel({ sessionID, inboxID })
    // 请求失败不抛出，把错误带回统一处理
    const error = await request.then(
      () => undefined,
      (error) => error,
    )
    if (!error) return true
    const label = failureLabel ?? (action === "cancel" ? "delete" : action)
    toast.show({ title: `Failed to ${label} pending prompt`, message: errorMessage(error), variant: "error" })
    return false
  }
  // 修改待处理提示词（steer/queue），失败返回 false
  const mutatePending = async (action: PendingAction, inboxID: string) =>
    (await runPendingAction(inboxID, () => requestPending(action, inboxID))) ?? false
  // 撤销排队提示词：先把内容回填草稿（媒体引用需先加载，因为取消后不再有引用方），
  // 成功返回写入的 composer；取消失败或动作已在执行则返回 undefined。
  const undoPending = (inboxID: string, message: ProjectedPrompt, failureLabel?: string) =>
    runPendingAction(inboxID, async () => {
      const restored = await restorePrompt(message)
      if (!(await requestPending("cancel", inboxID, failureLabel))) return
      return { composer: appendToSessionPrompt(sessionID, restored, renderer.widthMethod) }
    })
  // 打开"排队提示词"管理对话框：可 steer 插队、删除或撤销
  const openQueuedPrompts = () =>
    dialog.replace(() => (
      <DialogSelect
        title="Queued prompts"
        searchInTitle
        titlePlaceholder="Search queued prompts"
        options={queuedPrompts().map((prompt, index) => ({
          title: prompt.text,
          value: prompt.id,
          footer: `${index + 1} of ${queuedPrompts().length}`,
        }))}
        onSelect={(option) => {
          // 选中即 steer（插队立即执行），成功后关闭对话框
          void mutatePending("steer", option.value).then((steered) => {
            if (steered) dialog.clear()
          })
        }}
        actions={[
          {
            // 删除动作：撤销该排队提示词；删到最后一条时顺带关闭对话框
            command: "queued_prompt.delete",
            title: "delete",
            onTrigger: (option) => {
              const last = queuedPrompts().length === 1
              void mutatePending("cancel", option.value).then((cancelled) => {
                if (cancelled && last) dialog.clear()
              })
            },
          },
          {
            // 撤销动作：把排队内容放回输入框编辑
            command: "queued_prompt.undo",
            title: "undo",
            onTrigger: (option) => {
              const target = prompt()
              const queued = queuedPrompts().find((item) => item.id === option.value)
              if (!target || !queued) return
              // shell 模式且有内容时先退出 shell 模式才能撤销
              if (target.mode === "shell" && target.current.text) {
                toast.show({ message: "Leave shell mode before undoing a queued prompt", variant: "error" })
                return
              }
              void undoPending(queued.id, queued.payload, "undo")
                .then((undone) => {
                  if (!undone || sessionDisposed) return
                  dialog.clear()
                  undone.composer?.focus()
                })
                .catch((error) =>
                  toast.show({
                    title: "Failed to undo pending prompt",
                    message: errorMessage(error),
                    variant: "error",
                  }),
                )
            },
          },
        ]}
        footerHints={[{ title: "steer", label: "enter", group: "primary" }]}
      />
    ))
  // 对齐某条消息到视口顶部：关闭吸底、记录导航焦点、必要时撑高导航缓冲
  const alignMessage = (messageID: string, top: number) => {
    scroll.stickyScroll = false
    setNavigationMessage(messageID)
    updateAwayFromBottom()
    setNavigationSlack(
      messageNavigationSlack({
        top,
        viewportHeight: scroll.viewport.height,
        scrollHeight: scroll.scrollHeight,
        currentSlack: scroll.getRenderable(NAVIGATION_SLACK_ID)?.height ?? 0,
      }),
    )
    afterLayout(() => {
      // 布局完成时导航焦点已变则放弃滚动
      if (navigationMessage() !== messageID) return
      scroll.scrollTo(top)
    })
  }

  // 按方向跳到上一条/下一条消息边界；userOnly 时只跳用户消息
  const scrollToMessage = (direction: "next" | "prev", dialog: ReturnType<typeof useDialog>, userOnly = false) =>
    ensureAllRows(() => {
      const target = findMessageBoundary({
        direction,
        children: anchors.messagePositions(),
        messages: messages(),
        scrollTop: scroll.scrollTop,
        viewportY: scroll.viewport.y,
        currentID: navigationMessage(),
        userOnly,
      })

      if (target) {
        // 找到目标消息：跳转并关闭对话框
        jumpToMessage(target.id)
        dialog.clear()
        return
      }
      // 向上没有更近的边界但还有更早消息：加载历史后重试
      if (direction === "prev" && data.session.message.more(route.sessionID)) {
        prependHistory(0, () => scrollToMessage(direction, dialog, userOnly))
        return
      }
      dialog.clear()
    })

  // 跳转到指定消息：先确保行全部挂载，再按锚点计算位置并对齐
  const jumpToMessage = (messageID: string) =>
    ensureAllRows(() => {
      const child = anchors.forMessage(messageID)
      if (!child) return
      const y = scroll.scrollTop + child.node.y - scroll.viewport.y
      const message = data.session.message.get(route.sessionID, messageID)
      // 助手消息多留 1 行边距，避免顶部裁切
      alignMessage(messageID, Math.max(0, y - (message?.type === "assistant" ? 1 : 0)))
    })

  // 回到底部：清理导航状态并恢复吸底
  function toBottom() {
    clearMessageNavigation()
    ensureAllRowsPending = undefined
    if (awayTimer) clearTimeout(awayTimer)
    awayTimer = undefined
    setAwayFromBottom(false)
    sessionTabs.setScrollAnchor(route.sessionID, undefined)
    // 解除隐藏/可见区间限制，挂载全部行
    setHiddenRows(undefined)
    setVisibleRowsEnd(undefined)
    // 稍等一拍再吸底并滚到最底部，等布局稳定
    setTimeout(() => {
      if (!scroll || scroll.isDestroyed) return
      scroll.stickyScroll = true
      scroll.scrollTo(scroll.scrollHeight)
    }, 50)
  }

  // 相对滚动转录区 delta 行：优先用增量展开（避免全量挂载），否则普通滚动
  function moveTranscript(delta: number) {
    clearMessageNavigation()
    if (delta < 0 && revealOlderRows(delta)) {
      dialog.clear()
      return
    }
    if (delta > 0 && revealNewerRows(delta)) {
      dialog.clear()
      return
    }
    scroll.scrollBy(delta)
    updateAwayFromBottom()
    dialog.clear()
  }

  // 全局滚动类命令（上/下翻页、逐行、半页），不出现在命令面板
  const globalCommands = [
    {
      id: "session.page.up",
      title: "Page up",
      group: "Session",
      palette: undefined,
      run: () => moveTranscript(-scroll.height / 2),
    },
    {
      id: "session.page.down",
      title: "Page down",
      group: "Session",
      palette: undefined,
      run: () => moveTranscript(scroll.height / 2),
    },
    {
      id: "session.line.up",
      title: "Line up",
      group: "Session",
      palette: undefined,
      run: () => moveTranscript(-1),
    },
    {
      id: "session.line.down",
      title: "Line down",
      group: "Session",
      palette: undefined,
      run: () => moveTranscript(1),
    },
    {
      id: "session.half.page.up",
      title: "Half page up",
      group: "Session",
      palette: undefined,
      run: () => moveTranscript(-scroll.height / 4),
    },
    {
      id: "session.half.page.down",
      title: "Half page down",
      group: "Session",
      palette: undefined,
      run: () => moveTranscript(scroll.height / 4),
    },
  ]

  // 基础命令 + 输入框未聚焦时可用的命令（跳首条消息等）
  const baseAndUnfocusedCommands = [
    {
      // 跳到第一条消息：需要加载全部历史并挂载头部预算内的行
      id: "session.first",
      title: "First message",
      group: "Session",
      palette: undefined,
      run: () => {
        // 已有跳转在进行则忽略
        if (firstJump()) return
        clearMessageNavigation()
        // 用 AbortController 支持中途取消（按 esc）
        const request = new AbortController()
        const cancel = () => request.abort()
        setFirstJump(() => cancel)
        const start = () => {
          if (firstJump() !== cancel || scroll.isDestroyed) return
          // 有展开/挂载任务未完成：等下一帧布局再试
          if (revealingOlderRows || revealingNewerRows || ensureAllRowsPending) return afterLayout(start)
          // 记住当前挂载窗口，失败时恢复
          const previous = { start: hiddenRows(), end: visibleRowsEnd() }
          const restore = () => {
            cancel()
            batch(() => {
              setHiddenRows(previous.start)
              setVisibleRowsEnd(previous.end)
            })
          }
          const commit = () => {
            if (firstJump() !== restore || scroll.isDestroyed) return
            scroll.stickyScroll = false
            // 头部预算与历史加载同批提交：先挂载第一块行
            batch(() => {
              setHiddenRows(0)
              setVisibleRowsEnd(TRANSCRIPT_BACKFILL_CHUNK)
              setFirstJump(() => cancel)
            })
          }
          // 两端先钉住当前窗口，直到头部预算与历史同批提交。
          batch(() => {
            setFirstJump(() => restore)
            setHiddenRows(hidden())
            setVisibleRowsEnd(visibleEnd())
          })
          void data.session.message
            .loadMore(route.sessionID, {
              all: true,
              signal: request.signal,
              beforePublish: commit,
            })
            .then(
              () => {
                // 加载成功：提交头部窗口并滚到顶
                commit()
                if (firstJump() !== cancel || scroll.isDestroyed) return
                if (rows.length <= TRANSCRIPT_BACKFILL_CHUNK) setVisibleRowsEnd(undefined)
                scroll.scrollTo(0)
                afterLayout(() => {
                  if (firstJump() !== cancel) return
                  // 布局后再确认一次滚动位置，然后解除跳转状态
                  scroll.scrollTo(0)
                  setFirstJump(undefined)
                  updateAwayFromBottom()
                })
              },
              (error) => {
                // 失败或被取消：恢复原窗口并提示
                if (firstJump() !== restore || scroll.isDestroyed) return
                clearMessageNavigation()
                toast.error(error)
                updateAwayFromBottom()
              },
            )
        }
        // 等待挂起的历史预置完成后再开始
        prependHistory.after(start)
        dialog.clear()
      },
    },
    {
      id: "session.last",
      title: "Last message",
      group: "Session",
      palette: undefined,
      run: () => {
        toBottom()
        dialog.clear()
      },
    },
  ]

  // 会话基础命令：重命名/时间线/分叉/压缩/撤销重做/视图切换/复制导出等
  const baseCommands = createMemo(() => [
    {
      // 重命名会话：无参数打开对话框；带参数则直接更新（空串触发自动生成标题）
      title: "Rename session",
      id: "session.rename",
      group: "Session",
      slash: { name: "rename", arguments: true as const },
      run: (input?: string) => {
        if (input === undefined) return DialogSessionRename.show(dialog, route.sessionID, session()?.title)
        const title = input.trim()
        void (
          title
            ? client.api.session.update({ sessionID: route.sessionID, title })
            : data.session.title.generate(route.sessionID)
        ).catch((error) => toast.error(error))
      },
    },
    {
      // 打开时间线对话框，选择消息后跳转
      title: "Jump to message",
      id: "session.timeline",
      group: "Session",
      slash: { name: "timeline" },
      run: () => {
        dialog.replace(() => <DialogTimeline sessionID={route.sessionID} onMove={jumpToMessage} />)
      },
    },
    {
      // 打开分叉对话框：从某条消息创建会话副本
      title: "Fork session",
      id: "session.fork",
      group: "Session",
      slash: { name: "fork" },
      run: () => {
        dialog.replace(() => (
          <DialogFork
            sessionID={route.sessionID}
            onMove={(messageID) => {
              if (!messageID) return
              jumpToMessage(messageID)
            }}
          />
        ))
      },
    },
    {
      // 压缩会话：把历史汇总成摘要以缩短上下文；带上当前选中的模型
      title: "Compact session",
      id: "session.compact",
      group: "Session",
      slash: {
        name: "compact",
      },
      run: () => {
        const selection = local.model.current()
        void data.session
          .compact({
            sessionID: route.sessionID,
            model: selection
              ? {
                  providerID: selection.providerID,
                  id: selection.modelID,
                  variant: local.model.variant.current(),
                }
              : undefined,
          })
          .catch((error) => toast.show({ message: errorMessage(error), variant: "error" }))
        dialog.clear()
      },
    },
    {
      // 撤销上一条消息：排队中的直接撤销；已发送的中断等待后标记回滚并回填草稿
      title: "Undo previous message",
      id: "session.undo",
      group: "Session",
      slash: { name: "undo" },
      run: () => {
        const message = messagesBeforeRevert().findLast(
          (message): message is SessionMessageUser => message.type === "user" && !!message.text.trim(),
        )
        if (!message) {
          toast.show({ message: "Nothing to undo", variant: "error", duration: 3000 })
          dialog.clear()
          return
        }
        const undo = pendingDeliveries().has(message.id)
          ? undoPending(message.id, message)
          : (async () => {
              const restored = await restorePrompt(message)
              // 中断当前运行并等待其停止，再把该消息标记为回滚点
              await client.api.session.interrupt({ sessionID })
              await client.api.experimental.session.wait({ sessionID })
              await client.api.session.revert.stage({ sessionID, messageID: message.id })
              appendToSessionPrompt(sessionID, restored, renderer.widthMethod)
            })()
        void undo.catch((error) => toast.show({ message: errorMessage(error), variant: "error", duration: 5000 }))
        dialog.clear()
      },
    },
    {
      // 重做：清除回滚标记，恢复被撤销的消息
      title: "Redo",
      id: "session.redo",
      group: "Session",
      enabled: !!session()?.revert?.messageID,
      slash: { name: "redo" },
      run: () => {
        void (async () => {
          const error = await client.api.session.revert.clear({ sessionID: route.sessionID }).then(
            () => undefined,
            (error) => error,
          )
          if (error) toast.show({ message: errorMessage(error), variant: "error", duration: 5000 })
          dialog.clear()
        })()
      },
    },
    {
      // 切换思考内容的显示/隐藏（标题随当前状态变化）
      title: (() => {
        const next = nextThinkingMode(thinkingMode())
        if (next === "hide") return "Collapse thinking"
        return "Expand thinking"
      })(),
      id: "session.toggle.thinking",
      group: "Session",
      palette: undefined,
      run: () => {
        void configState
          .update((draft) => {
            draft.session = { ...draft.session, thinking: nextThinkingMode(thinkingMode()) }
          })
          .catch(toast.error)
        dialog.clear()
      },
    },
    {
      // 切换会话滚动条显示
      title: "Toggle session scrollbar",
      id: "session.toggle.scrollbar",
      group: "Session",
      palette: undefined,
      run: () => {
        void configState
          .update((draft) => {
            draft.session = { ...draft.session, scrollbar: !showScrollbar() }
          })
          .catch(toast.error)
        dialog.clear()
      },
    },
    {
      // 切换工具调用分组（分组展示/逐条展示）
      title: groupExploration() ? "Show tool calls individually" : "Group related tool calls",
      id: "session.toggle.exploration_grouping",
      group: "Session",
      palette: undefined,
      run: () => {
        void configState
          .update((draft) => {
            draft.session = { ...draft.session, grouping: groupExploration() ? "none" : "auto" }
          })
          .catch(toast.error)
        dialog.clear()
      },
    },
    {
      // 循环切换分组摘要详略级别（low -> medium -> high）
      title: `Verbosity: ${Locale.titlecase(verbosity())}`,
      id: "session.verbosity.cycle",
      group: "Session",
      run: () => {
        const levels = ["low", "medium", "high"] as const
        const next = levels[(levels.indexOf(verbosity()) + 1) % levels.length]
        void configState
          .update((draft) => {
            draft.session = { ...draft.session, verbosity: next }
          })
          .catch(toast.error)
        dialog.clear()
      },
    },
    {
      // 跳到最后一条用户消息
      title: "Jump to last user message",
      id: "session.messages_last_user",
      group: "Session",
      palette: undefined,
      run: () => {
        const messages = data.session.message.list(route.sessionID)
        if (!messages || !messages.length) return

        // 从尾向前找最近一条有非空文本的用户消息
        for (let i = messages.length - 1; i >= 0; i--) {
          const message = messages[i]
          if (!message || message.type !== "user" || !message.text.trim()) continue
          {
            jumpToMessage(message.id)
            break
          }
        }
      },
    },
    {
      // 下一条消息
      title: "Next message",
      id: "session.message.next",
      group: "Session",
      palette: undefined,
      run: () => scrollToMessage("next", dialog),
    },
    {
      // 上一条消息
      title: "Previous message",
      id: "session.message.previous",
      group: "Session",
      palette: undefined,
      run: () => scrollToMessage("prev", dialog),
    },
    {
      // 下一条用户消息
      title: "Next user message",
      id: "session.message.user.next",
      group: "Session",
      palette: undefined,
      run: () => scrollToMessage("next", dialog, true),
    },
    {
      // 上一条用户消息
      title: "Previous user message",
      id: "session.message.user.previous",
      group: "Session",
      palette: undefined,
      run: () => scrollToMessage("prev", dialog, true),
    },
    {
      // 复制最后一条助手消息的文本（或已完成压缩摘要）
      title: "Copy last assistant message",
      id: "messages.copy",
      group: "Session",
      slash: {
        name: "copy",
      },
      run: () => {
        const lastAssistantMessage = messagesBeforeRevert().findLast(
          (msg) => msg.type === "assistant" || (msg.type === "compaction" && msg.status === "completed" && msg.summary.trim() !== ""),
        )
        if (!lastAssistantMessage) {
          toast.show({ message: "No assistant messages found", variant: "error" })
          dialog.clear()
          return
        }

        // 助手消息取全部 text 分片拼接；压缩消息取其摘要
        const text =
          lastAssistantMessage.type === "assistant"
            ? lastAssistantMessage.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n")
                .trim()
            : lastAssistantMessage.type === "compaction" && lastAssistantMessage.status === "completed"
              ? lastAssistantMessage.summary.trim()
              : ""
        if (!text) {
          toast.show({
            message: "No text content found in last assistant message",
            variant: "error",
          })
          dialog.clear()
          return
        }

        clipboard
          .write(text)
          .then(() => toast.show({ message: "Message copied to clipboard!", variant: "success" }))
          .catch(() => toast.show({ message: "Failed to copy to clipboard", variant: "error" }))
        dialog.clear()
      },
    },
    {
      // 复制会话 ID
      title: "Copy session ID",
      id: "session.copy.id",
      group: "Session",
      run: () => {
        clipboard
          .write(route.sessionID)
          .then(() => toast.show({ message: "Session ID copied to clipboard!", variant: "success" }))
          .catch(() => toast.show({ message: "Failed to copy session ID", variant: "error" }))
        dialog.clear()
      },
    },
    {
      // 复制完整会话转录文本
      title: "Copy session transcript",
      id: "session.copy",
      group: "Session",
      run: async () => {
        try {
          const sessionData = session()
          if (!sessionData) return
          const transcript = await client.api.experimental.session.export({ sessionID: sessionData.id })
          const content = formatSessionTranscript(transcript.info, transcript.messages, true)
          await clipboard.write(content)
          toast.show({ message: "Session transcript copied to clipboard!", variant: "success" })
        } catch {
          toast.show({ message: "Failed to copy session transcript", variant: "error" })
        }
        dialog.clear()
      },
    },
    {
      // 导出会话转录到文件（可选格式与脱敏）
      title: "Export session transcript",
      id: "session.export",
      group: "Session",
      slash: {
        name: "export",
      },
      run: async () => {
        try {
          const sessionData = session()
          if (!sessionData) return

          // 先让用户选择导出格式/脱敏选项；取消则退出
          const options = await DialogExportOptions.show(dialog, true)

          if (options === null) return

          const transcript = await client.api.experimental.session.export({
            sessionID: sessionData.id,
            sanitize: options.format === "json" ? options.sanitize : undefined,
          })
          // markdown 用格式化器（可含思考/工具内容）；json 直接序列化并补换行
          const content =
            options.format === "markdown"
              ? formatSessionTranscript(transcript.info, transcript.messages, options.thinking, options.tools)
              : JSON.stringify(transcript, null, 2) + EOL

          if (options.action === "copy") {
            // 选择复制：写剪贴板后结束
            await clipboard.write(content)
            dialog.clear()
            toast.show({ message: "Copied to clipboard", variant: "success" })
            return
          }

          // 选择保存：写入系统临时目录下的随机文件名，再展示结果对话框
          const filepath = path.join(
            paths.cwd,
            `session-${crypto.randomUUID()}.${options.format === "markdown" ? "md" : "json"}`,
          )
          await writeExport(filepath, content)
          await DialogExportResult.show(dialog, filepath)
        } catch {
          toast.show({ message: "Failed to export session", variant: "error" })
        }
        dialog.clear()
      },
    },
    {
      // 把阻塞中的工具调用转入后台继续运行
      title: "Background blocking tools",
      id: "session.background",
      group: "Session",
      palette: undefined,
      run: () => {
        void client.api.session.background({ sessionID: route.sessionID })
        dialog.clear()
      },
    },
    {
      // 打开/关闭子代理选择标签
      title: "Toggle subagent picker",
      id: "session.child.first",
      group: "Session",
      run: (tab?: string) => {
        if (tab === "shell" || tab === "subagents") setComposer({ open: true, tab })
        else if (composer.open || session()?.parentID) setComposer("open", false)
        else setComposer({ open: true, tab: "subagents" })
        dialog.clear()
      },
    },
    {
      // 查看排队提示词（有排队内容时可用）
      title: "View queued prompts",
      id: "session.queued_prompts",
      group: "Prompt",
      enabled: queuedPrompts().length > 0,
      run: openQueuedPrompts,
    },
    {
      // 跳转到父会话（仅子会话可用）
      title: "Go to parent session",
      id: "session.parent",
      group: "Session",
      palette: undefined,
      enabled: !!session()?.parentID,
      run: () => {
        const parentID = session()?.parentID
        if (parentID) {
          navigate({
            type: "session",
            sessionID: parentID,
          })
        }
        dialog.clear()
      },
    },
  ])

  // 汇总全部命令并补上默认字段（不直接绑定按键、可在面板中显示）
  const commands = createMemo(() =>
    [...globalCommands, ...baseAndUnfocusedCommands, ...baseCommands()].map(
      (command) =>
        ({
          bind: false,
          palette: true as const,
          ...command,
        }) satisfies KeymapCommand,
    ),
  )

  // 快捷键层 1：全局模式，注册所有命令，全局命令直接绑定按键
  Keymap.createLayer(() => ({
    mode: "global",
    commands: commands(),
    bindings: globalCommands.map((command) => command.id),
  }))

  // 快捷键层 2：仅当没有编辑器聚焦时启用（避免与输入框按键冲突）
  Keymap.createLayer(() => ({
    mode: "composer",
    enabled: () => renderer.currentFocusedEditor === null,
    bindings: baseAndUnfocusedCommands.map((command) => command.id),
  }))

  // 快捷键层 3：基础与未聚焦命令的绑定（面板可见）
  Keymap.createLayer(() => ({
    bindings: [...baseAndUnfocusedCommands, ...baseCommands()].map((command) => command.id),
  }))

  // 切换会话时：关闭 composer 并清理消息导航状态
  createEffect(
    on(
      () => route.sessionID,
      () => {
        setComposer("open", false)
        clearMessageNavigation()
      },
    ),
  )

  // 按轴分别 memo 化：宽度的读者不会因纯高度变化而重跑（dimensions() 是同一对象引用相等），
  // 反之亦然。
  const terminalWidth = createMemo(() => dimensions().width)
  const terminalHeight = createMemo(() => dimensions().height)

  // 渲染会话主界面：外层提供渲染上下文，内部为横向布局（转录区 + 侧边栏插槽）
  return (
    <context.Provider
      value={{
        // 时间线锚点仓库
        anchors,
        // 查询分组展开状态
        groupExpanded,
        setGroupExpanded: (id, expanded, anchor) => {
          // 以转录结尾的分组在读者跟随底部时会展开到屏幕外。
          const last = rows.findLast((row) => row.type !== "assistant-footer" && row.type !== "turn-usage")
          const ending = last?.type === "group" && groupID(last, 0) === id
          // 让被切换的折叠头在下次布局中保持在原视口行上。
          if (anchor && !(ending && !isAwayFromBottom())) afterLayout(scroll.anchor(anchor))
          sessionTabs.setGroupExpanded(sessionID, id, expanded)
          afterLayout(saveScrollAnchor)
        },
        // 内容区宽度
        get width() {
          return contentWidth()
        },
        // 终端尺寸（按轴 memo）
        terminal: {
          get width() {
            return terminalWidth()
          },
          get height() {
            return terminalHeight()
          },
        },
        // 其余上下文字段透传
        sessionID: route.sessionID,
        thinkingMode,
        markdownMode,
        groupExploration,
        diffWrapMode,
        models,
        messageIndex: (messageID) => messageIndexes().get(messageID),
        legacyTurns: legacy,
        config,
        mutatePending,
        pendingDelivery: (inboxID) => pendingDeliveries().get(inboxID),
      }}
    >
      {/* 横向布局：主内容区 + 右侧内容 */}
      <box flexDirection="row" flexGrow={1} minHeight={0}>
        <box
          flexGrow={1}
          minHeight={0}
          paddingBottom={1}
          paddingLeft={dimensions().width < 44 ? 1 : 2}
          paddingRight={dimensions().width < 44 ? 1 : 2}
        >
          <Show when={session()}>
            {/* 相对定位容器包住滚动转录区 */}
            <box flexGrow={1} minHeight={0} position="relative">
              <scrollbox
                ref={(r) => {
                  // 绑定滚动实例：记录本地引用、暴露给父级、监听滚动条变化
                  scroll = r
                  props.scrollRef?.(r)
                  scroll.verticalScrollBar.on("change", updateAwayFromBottom)
                }}
                viewportOptions={{
                  paddingRight: showScrollbar() ? 1 : 0,
                }}
                verticalScrollbarOptions={{
                  paddingLeft: 1,
                  visible: showScrollbar(),
                  trackOptions: {
                    backgroundColor: theme.decrease(theme.background.raised.base),
                    foregroundColor: theme.border.base,
                  },
                }}
                // 无导航焦点且无导航缓冲时吸底滚动（新消息自动跟随）
                stickyScroll={!navigationMessage() && !navigationSlack()}
                stickyStart="bottom"
                flexGrow={1}
                scrollAcceleration={scrollAcceleration()}
                onMouseScroll={(event) => {
                  // 滚动即取消首次跳转状态
                  if (firstJump()) clearMessageNavigation()
                  // 向上/向下优先走增量展开，未触发则普通滚动并更新状态
                  if (event.scroll?.direction === "up" && revealOlderRows()) return
                  if (event.scroll?.direction === "down" && revealNewerRows()) return
                  updateAwayFromBottom()
                }}
              >
                {/* 渲染当前挂载窗口内的行 */}
                <For each={visibleRows()}>
                  {(row, index) => (
                    <SessionRowView
                      row={row}
                      message={(messageID) => data.session.message.get(route.sessionID, messageID)}
                      boundaryID={boundaries()[index() + hidden()]}
                    />
                  )}
                </For>
                {/* 后台运行工具的提示条 */}
                <BackgroundToolHint messages={messages()} />
                {/* 撤销（revert）提示：显示被撤销的用户消息数与文件 */}
                <Show when={session()?.revert?.messageID}>
                  <RevertMessage
                    count={messagesFromRevert().filter((message) => message.type === "user").length}
                    files={session()!.revert!.files ?? []}
                  />
                </Show>
                {/* 导航缓冲占位：为跳转到接近底部的内容撑出滚动空间 */}
                <Show when={navigationSlack()}>
                  {(height) => <box id={NAVIGATION_SLACK_ID} height={height()} flexShrink={0} />}
                </Show>
              </scrollbox>
            </box>
            <box height={1} flexShrink={0} flexDirection="row" justifyContent="flex-end">
              <Show when={firstJump()}>
                <text fg={theme.text.feedback.info.base}>Loading session history…</text>
              </Show>
              {/* 不在首次跳转且离开底部时：显示"跳到最新"悬浮按钮 */}
              <Show when={!firstJump() && awayFromBottom()}>
                <box
                  id="session-jump-to-latest"
                  paddingLeft={1}
                  onMouseOver={() => setLatestHovered(true)}
                  onMouseOut={() => setLatestHovered(false)}
                  onMouseUp={toBottom}
                >
                  <text
                    fg={latestHovered() ? theme.text.action.secondary.hovered : theme.text.action.secondary.base}
                  >
                    Jump to latest ↓
                  </text>
                </box>
              </Show>
            </box>
            {/* 底部区域：排队提示坞、插件插槽、Composer 与覆盖式提示 */}
            <box flexShrink={0}>
              {/* 无 composer 且未禁用时显示排队提示坞 */}
              <Show when={!composer.open && !disabled() && queuedPrompts().length > 0}>
                <QueuedPromptDock prompts={queuedPrompts()} onOpen={openQueuedPrompts} />
              </Show>
              {/* 插件插槽：composer 顶部的扩展注入点 */}
              <Slot path="session.composer.top" input={{ sessionID: route.sessionID }} />
              <Composer
                sessionID={route.sessionID}
                // 子会话且无表单时默认展开 composer
                open={composer.open || (!!session()?.parentID && forms().length === 0)}
                defaultTab={composer.tab ?? (session()?.parentID ? "subagents" : undefined)}
                onClose={() => {
                  // 子会话关闭时回到父会话，否则收起 composer
                  const parent = session()?.parentID
                  if (parent) {
                    navigate({ type: "session", sessionID: parent })
                    return
                  }
                  setComposer("open", false)
                }}
                terminals={props.terminals}
                visibleTerminalID={props.visibleTerminalID}
              />
              <Switch>
                {/* composer 打开时不渲染任何覆盖提示 */}
                <Match when={composer.open || (!!session()?.parentID && forms().length === 0)}>{null}</Match>
                {/* 有待批权限：渲染第一个权限请求提示 */}
                <Match when={promptedPermissions().length > 0}>
                  <Show when={promptedPermissions()[0]?.id} keyed>
                    {(_) => {
                      const request = promptedPermissions()[0]
                      return request ? (
                        <PermissionPrompt request={request} directory={session()?.location.directory} />
                      ) : null
                    }}
                  </Show>
                </Match>
                {/* 有待填表单：渲染第一个表单 */}
                <Match when={forms().length > 0}>
                  <Show when={forms()[0]?.id} keyed>
                    {(_) => {
                      const form = forms()[0]
                      return form ? <FormPrompt form={form} /> : null
                    }}
                  </Show>
                </Match>
                {/* 会话目录不存在：渲染位置缺失提示 */}
                <Match
                  when={
                    session() &&
                    currentLocation.error?.location.directory === session()!.location.directory
                  }
                >
                  <SessionLocationMissing
                    directory={session()!.location.directory}
                    projectID={session()!.projectID}
                    sessionID={route.sessionID}
                  />
                </Match>
                {/* 默认：渲染标准输入框 */}
                <Match when={!disabled()}>
                  <Prompt
                    visible={true}
                    ref={bind}
                    muted={props.promptMuted}
                    onSubmit={() => {
                      // 提交后回到底部（除非配置要求保持滚动位置）
                      if (config.session?.submit_scroll !== "keep") toBottom()
                    }}
                    onEmptySubmit={async () => {
                      // 空提交时把第一条排队提示 steer 立即执行
                      const next = queuedPrompts()[0]
                      if (!next) return false
                      return mutatePending("steer", next.id)
                    }}
                    sessionID={route.sessionID}
                  />
                </Match>
              </Switch>
            </box>
          </Show>
        </box>
      </box>
    </context.Provider>
  )
}

// SessionRowView 的属性类型：行数据、按 ID 取消息、可选边界 ID
type SessionRowViewProps = {
  row: SessionRow
  message: (messageID: string) => SessionMessageInfo | undefined
  boundaryID?: string
}

/** 单个会话行的视图：注册锚点并按行类型分派到分组视图或条目视图。 */
function SessionRowView(props: SessionRowViewProps) {
  // 行对应的渲染节点（用于锚点注册）
  const [target, setTarget] = createSignal<BoxRenderable>()
  // 非分组行注册为时间线锚点，供滚动保存/恢复与消息导航使用
  useEntryAnchor({
    entry: () => (props.row.type === "group" ? undefined : props.row),
    node: target,
  })
  return (
    // 行容器：唯一 ID（含边界）、上边距 1 行分隔
    <box ref={setTarget} id={sessionRowID(props.row, props.boundaryID)} marginTop={1} flexShrink={0}>
      <Switch>
        {/* 分组行：交给分组视图，内部递归渲染条目与工具图片 */}
        <Match when={props.row.type === "group" ? props.row : undefined}>
          {(row) => (
            <SessionGroupView
              row={row()}
              message={props.message}
              entry={(entry, images) => <SessionEntryView row={entry} message={props.message} images={images} />}
              images={(parts) => <ToolImages parts={parts} />}
            />
          )}
        </Match>
        {/* 非分组行：直接渲染条目视图 */}
        <Match when={props.row.type !== "group" ? props.row : undefined}>
          {(row) => <SessionEntryView row={row()} message={props.message} />}
        </Match>
      </Switch>
    </box>
  )
}

/** 会话条目视图：按条目类型（消息/压缩排队/分片/助手页脚/轮次用量）分派渲染。 */
function SessionEntryView(props: { row: SessionEntry; message: SessionRowViewProps["message"]; images?: boolean }) {
  return (
    <Switch>
      {/* 普通消息行：取到消息后交给消息视图 */}
      <Match when={props.row.type === "message" ? props.row : undefined}>
        {(row) => (
          <Show when={props.message(row().messageID)}>{(message) => <SessionMessageView message={message()} />}</Show>
        )}
      </Match>
      {/* 压缩排队占位 */}
      <Match when={props.row.type === "compaction-queued"}>
        <CompactionQueued />
      </Match>
      {/* 消息分片行：按分片引用渲染 */}
      <Match when={props.row.type === "part" ? props.row : undefined}>
        {(row) => <SessionPartView partRef={row().ref} message={props.message} images={props.images} />}
      </Match>
      {/* 助手页脚行：仅助手消息渲染 */}
      <Match when={props.row.type === "assistant-footer" ? props.row : undefined}>
        {(row) => (
          <Show when={props.message(row().messageID)}>
            {(message) => (
              <Show when={message().type === "assistant"}>
                <AssistantFooter message={message() as SessionMessageAssistant} />
              </Show>
            )}
          </Show>
        )}
      </Match>
      {/* 轮次 token 用量行 */}
      <Match when={props.row.type === "turn-usage" ? props.row : undefined}>
        {(row) => (
          <TurnTokenUsage messageIDs={row().messageIDs} previousCache={row().previousCache} message={props.message} />
        )}
      </Match>
    </Switch>
  )
}

/**
 * TurnTokenUsage：一轮对话的 token 用量统计。
 * 默认折叠为一行摘要；点击展开逐步明细表（新增/缓存/总量），再点收起。
 * 仅在 debug.turn_tokens 配置开启且有数据时渲染。
 */
function TurnTokenUsage(props: {
  // 本轮各步骤对应的助手消息 ID
  messageIDs: string[]
  // 上一步的缓存用量（用于判断缓存失效）
  previousCache?: CacheUsage
  // 按 ID 取消息
  message: (messageID: string) => SessionMessageInfo | undefined
}) {
  const config = useConfig()
  const theme = useTheme()
  const renderer = useRenderer()
  // 默认折叠：整轮只显示一行摘要。点击打开逐步明细表，再点关闭。
  const [expanded, setExpanded] = createSignal(false)
  // 鼠标悬停状态（用于高亮）
  const [hover, setHover] = createSignal(false)
  // verbose 模式下明细中还会列出每步调用的工具
  const verbose = () => config.data.debug?.turn_tokens === "verbose"
  // 每个助手消息折叠成一个步骤记录：完成方式、token 明细、缓存复用变化
  const steps = createMemo(() => {
    let previousCache = props.previousCache
    return props.messageIDs.flatMap((messageID) => {
      const message = props.message(messageID)
      // 只要带 token 统计的助手消息
      if (message?.type !== "assistant" || !message.tokens) return []
      // 总量 = 输入 + 输出 + 推理 + 缓存读 + 缓存写
      const total =
        message.tokens.input +
        message.tokens.output +
        message.tokens.reasoning +
        message.tokens.cache.read +
        message.tokens.cache.write
      if (total === 0) return []
      // 新 token = 总量减去缓存读（真正消耗的部分）
      const newTokens = total - message.tokens.cache.read
      const currentCache = { read: message.tokens.cache.read, model: message.model }
      // 与上一步对比缓存复用下降量（提示可能的缓存失效）
      const reuseDrop = cacheReuseDrop(previousCache, currentCache)
      previousCache = currentCache
      return [
        {
          finish: message.finish === "tool-calls" ? "tool-call" : (message.finish ?? "unknown"),
          tools: verbose() ? message.content.filter((part) => part.type === "tool") : [],
          newTokens,
          cached: message.tokens.cache.read,
          total,
          reuseDrop,
        },
      ]
    })
  })
  // 各列宽度：取表头与数据中的最大宽度，保证对齐
  const columns = createMemo(() => ({
    step: Math.max("Step".length, ...steps().map((item) => item.finish.length)),
    newTokens: Math.max("New".length, ...steps().map((item) => item.newTokens.toLocaleString().length)),
    cached: Math.max("Cached".length, ...steps().map((item) => item.cached.toLocaleString().length)),
    total: Math.max("Total".length, ...steps().map((item) => item.total.toLocaleString().length)),
  }))
  // 一行摘要数据：步数与最后一步的 token 数据、缓存失效次数
  const summary = createMemo(() => {
    const items = steps()
    const latest = items.at(-1)
    return {
      count: items.length,
      latestNewTokens: latest?.newTokens ?? 0,
      latestCached: latest?.cached ?? 0,
      latestTotal: latest?.total ?? 0,
      reuseDrops: items.filter((item) => item.reuseDrop !== undefined).length,
    }
  })
  return (
    <Show when={Boolean(config.data.debug?.turn_tokens) && steps().length > 0}>
      <box paddingLeft={3} flexDirection="column">
        {/* 可点击的摘要行：切换展开态（有文本选区时忽略点击） */}
        <box
          flexDirection="row"
          onMouseOver={() => setHover(true)}
          onMouseOut={() => setHover(false)}
          onMouseUp={() => {
            if (renderer.getSelection()?.getSelectedText()) return
            setExpanded((value) => !value)
          }}
        >
          <text fg={hover() ? theme.text.base : theme.text.muted} wrapMode="none">
            <span>{expanded() ? "- " : "+ "}</span>
            <span style={{ attributes: TextAttributes.BOLD }}>Tokens</span>
            <span>
              : {summary().count} {summary().count === 1 ? "step" : "steps"} · latest:{" "}
              {summary().latestNewTokens.toLocaleString()} new · {summary().latestCached.toLocaleString()} cached ·{" "}
              {summary().latestTotal.toLocaleString()} total
            </span>
            <Show when={summary().reuseDrops > 0}>
              <span style={{ fg: theme.text.feedback.warning.base }}>
                {" "}
                · ! {summary().reuseDrops} likely cache {summary().reuseDrops === 1 ? "bust" : "busts"}
              </span>
            </Show>
          </text>
        </box>
        <Show when={expanded()}>
          {/* 展开后的表头行 */}
          <box paddingLeft={INLINE_TOOL_ICON_WIDTH}>
            <text fg={theme.text.muted} attributes={TextAttributes.ITALIC}>
              {"Step".padEnd(columns().step + 2)}
              {"New".padStart(columns().newTokens)}
              {"  "}
              {"Cached".padStart(columns().cached)}
              {"  "}
              {"Total".padStart(columns().total)}
            </text>
          </box>
          <For each={steps()}>
            {(item) => (
              <box paddingLeft={INLINE_TOOL_ICON_WIDTH} flexDirection="column">
                <text fg={verbose() && item.finish === "tool-call" ? undefined : theme.text.muted}>
                  {item.finish.padEnd(columns().step + 2)}
                  <span style={{ attributes: TextAttributes.BOLD }}>
                    {item.newTokens.toLocaleString().padStart(columns().newTokens)}
                  </span>
                  {"  "}
                  {item.cached.toLocaleString().padStart(columns().cached)}
                  {"  "}
                  {item.total.toLocaleString().padStart(columns().total)}
                </text>
                {/* verbose 模式下列出该步调用的工具 */}
                <TurnTokenToolCalls tools={item.tools} />
                <Show when={item.reuseDrop !== undefined}>
                  <text fg={theme.text.feedback.warning.base}>
                    ! Likely cache bust: {item.reuseDrop?.toLocaleString()} fewer cached tokens than the previous step
                  </text>
                </Show>
              </box>
            )}
          </For>
        </Show>
      </box>
    </Show>
  )
}

/** TurnTokenToolCalls：逐步明细中列出的工具调用清单（名称 + 参数摘要）。 */
function TurnTokenToolCalls(props: { tools: SessionMessageAssistantTool[] }) {
  const theme = useTheme()
  // 名称列宽：所有工具名的最大长度 + 2 间距
  const nameWidth = () => Math.max(0, ...props.tools.map((tool) => tool.name.length)) + 2
  return (
    <Show when={props.tools.length > 0}>
      <box paddingLeft={2} flexDirection="column">
        <For each={props.tools}>
          {(tool) => (
            <box flexDirection="row">
              <text width={nameWidth()} flexShrink={0} fg={theme.text.muted} attributes={TextAttributes.BOLD}>
                {tool.name}
              </text>
              <text fg={theme.text.muted} attributes={TextAttributes.DIM} wrapMode="word" flexGrow={1} minWidth={0}>
                {turnTokenToolSummary(tool)}
              </text>
            </box>
          )}
        </For>
      </box>
    </Show>
  )
}

// turnTokenToolSummary：把工具输入压缩成一行摘要。
// 优先取主键（command/path/url 等按序匹配），其余原始类型字段以 "key: value" 形式拼接。
function turnTokenToolSummary(tool: SessionMessageAssistantTool) {
  const data = tool.state.input
  // 输入本身就是字符串则直接返回
  if (typeof data === "string") return data
  // 按优先级找出主键字段
  const primaryKey = ["command", "id", "pattern", "url", "query", "path", "description", "code"].find(
    (key) => key in data,
  )
  // 只保留 string/number/boolean 的原始值字段
  const input = Object.entries(data).filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
  const primary = input.find(([key]) => key === primaryKey)?.[1]
  const details = input.filter(([key]) => key !== primaryKey).map(([key, value]) => `${key}: ${String(value)}`)
  // 主值在前、明细在后，双空格分隔，过滤空段
  return [primary === undefined ? "" : String(primary), ...details].filter(Boolean).join("  ")
}

/**
 * BackgroundToolHint：后台工具提示条。
 * 当最新助手消息里有正在运行的 shell/subagent 工具且快捷键可用时，
 * 延迟 3 秒显示"按 XX 移入后台"提示。
 */
function BackgroundToolHint(props: { messages: SessionMessageInfo[] }) {
  const theme = useTheme()
  // 读取 session.background 快捷键（未绑定时为空，不显示提示）
  const shortcut = Keymap.useShortcut("session.background")
  // 当前正在运行的可后台化工具（shell 或 subagent）
  const running = createMemo(() => {
    if (!shortcut()) return
    const current = props.messages.findLast(
      (message): message is SessionMessageAssistant => message.type === "assistant" && !message.time.completed,
    )
    const part = current?.content.find((part): part is SessionMessageAssistantTool => {
      if (part.type !== "tool" || part.state.status !== "running") return false
      return canonicalToolName(part.name) === "shell"
    })
    if (!current || !part) return
    // key 用于区分不同工具实例，started 用于计算剩余延迟
    return { key: `${current.id}:${part.id}`, started: part.time.ran ?? part.time.created }
  })
  // 延迟出现：工具已运行的时间抵扣 3 秒延迟，key 不变时保持原状态
  const visible = createDelayedPresence(
    running,
    (tool) => Math.max(0, BACKGROUND_TOOL_HINT_DELAY - (Date.now() - tool.started)),
    (previous, next) => previous.key === next.key && previous.started === next.started,
  )
  return (
    <Show when={visible() && shortcut()}>
      {(value) => (
        <box marginTop={1} paddingLeft={3} flexShrink={0}>
          <text fg={theme.text.muted}>
            Press <span style={{ fg: theme.text.base }}>{value()}</span> to move running work to the background
          </text>
        </box>
      )}
    </Show>
  )
}

/** SessionMessageView：按消息类型分派到对应的消息视图组件。 */
function SessionMessageView(props: { message: SessionMessageInfo }) {
  return (
    <Switch>
      {/* 用户消息 */}
      <Match when={props.message.type === "user"}>
        <UserMessage message={props.message as SessionMessageUser} />
      </Match>
      {/* 用户直接执行的 shell 命令 */}
      <Match when={props.message.type === "shell"}>
        <ShellMessage message={props.message as Extract<SessionMessageInfo, { type: "shell" }>} />
      </Match>
      {/* 代理/模型/位置切换类系统消息 */}
      <Match
        when={
          props.message.type === "agent-switched" ||
          props.message.type === "model-switched" ||
          props.message.type === "location-switched"
        }
      >
        <SessionSwitchMessageV2 message={props.message} />
      </Match>
      {/* 系统/合成/技能消息：技能单独渲染，其余走通知视图 */}
      <Match
        when={props.message.type === "system" || props.message.type === "synthetic" || props.message.type === "skill"}
      >
        <Show when={props.message.type === "skill"} fallback={<SessionNoticeMessageV2 message={props.message} />}>
          <SessionSkillMessage message={props.message as Extract<SessionMessageInfo, { type: "skill" }>} />
        </Show>
      </Match>
      {/* 压缩（compaction）消息 */}
      <Match when={props.message.type === "compaction"}>
        <CompactionMessage message={props.message as Extract<SessionMessageInfo, { type: "compaction" }>} />
      </Match>
      {/* 空闲消息带错误：渲染执行错误 */}
      <Match when={props.message.type === "idle" ? props.message.error : undefined}>
        {(error) => <ExecutionError error={error()} />}
      </Match>
    </Switch>
  )
}

/** ExecutionError：执行失败的红色错误行。 */
function ExecutionError(props: { error: NonNullable<Extract<SessionMessageInfo, { type: "idle" }>["error"]> }) {
  const theme = useTheme()
  return (
    <box paddingLeft={3}>
      <text fg={theme.text.feedback.error.base}>Error: {errorMessage(props.error)}</text>
    </box>
  )
}

/** SessionPartView：按分片引用定位并渲染文本/推理/工具分片。 */
function SessionPartView(props: {
  partRef: PartRef
  message: (messageID: string) => SessionMessageInfo | undefined
  images?: boolean
}) {
  // 分片所属的消息
  const message = createMemo(() => props.message(props.partRef.messageID))
  // 从助手消息内容中解析出目标分片
  const part = createMemo(() => {
    const item = message()
    if (item?.type !== "assistant") return
    return resolvePart(item, props.partRef.partID)
  })
  return (
    <Show when={part()}>
      {(item) => (
        <Switch>
          {/* 文本分片 */}
          <Match when={item().type === "text"}>
            <TextPart
              part={item() as SessionMessageAssistantText}
              message={message() as SessionMessageAssistant}
              last={false}
            />
          </Match>
          {/* 推理分片 */}
          <Match when={item().type === "reasoning"}>
            <ReasoningPart
              part={item() as SessionMessageAssistantReasoning}
              message={message() as SessionMessageAssistant}
              last={false}
            />
          </Match>
          {/* 工具分片 */}
          <Match when={item().type === "tool"}>
            <ToolPart part={item() as SessionMessageAssistantTool} images={props.images} />
          </Match>
        </Switch>
      )}
    </Show>
  )
}

/** AssistantFooter：助手消息页脚——错误提示、重试条与"代理 · 模型 · 耗时 · 速度"元信息。 */
function AssistantFooter(props: { message: SessionMessageAssistant }) {
  // 会话渲染上下文
  const ctx = use()
  const config = useConfig()
  const data = useData()
  const local = useLocal()
  const theme = useTheme()
  // 模型展示名：在可用列表中找显示名，找不到就用 provider/model 拼接
  const model = createMemo(
    () =>
      ctx
        .models()
        .find((model) => model.providerID === props.message.model.providerID && model.id === props.message.model.id)
        ?.name ?? `${props.message.model.providerID}/${props.message.model.id}`,
  )
  const messages = createMemo(() => data.session.message.list(ctx.sessionID))
  // 轮次信息：消息序号 + 是否遗留协议
  const turn = () => ({ index: ctx.messageIndex(props.message.id), legacy: ctx.legacyTurns() })
  // 本轮耗时与每秒 token 数
  const duration = createMemo(() => SessionTurn.duration(messages(), props.message, turn()))
  const tokensPerSecond = createMemo(() => SessionTurn.tokensPerSecond(messages(), props.message, turn()))
  const timeToFirstToken = createMemo(() => SessionTurn.timeToFirstToken(messages(), props.message, turn()))
  const interrupted = createMemo(() => props.message.error?.message === "Step interrupted")
  // 是否触发免费额度限制
  const freeLimit = createMemo(() => props.message.error?.type === "provider.free-limit")
  // 用量限额通知（如供应商 429）
  const limitNotice = useLimitNotice(() => props.message)
  return (
    <>
      {/* 有错误且非中断/非重试中：展示限额或通用错误 */}
      <Show when={props.message.error && !interrupted() && !props.message.retry}>
        <Switch
          fallback={
            <box paddingLeft={3}>
              <text fg={theme.text.feedback.error.base}>Error: {errorMessage(props.message.error)}</text>
            </box>
          }
        >
          <Match when={freeLimit()}>
            <FreeLimitNotice message={props.message} />
          </Match>
          <Match when={limitNotice()}>{(notice) => <UsageLimitNotice notice={notice()} />}</Match>
        </Switch>
      </Show>
      {/* 自动重试进度条 */}
      <AssistantRetry retry={props.message.retry} />
      {/* 元信息行：代理名 · 模型 · 耗时 · tok/s · interrupted，按终端宽度裁剪 */}
      <box paddingLeft={3} marginTop={props.message.retry || (props.message.error && !interrupted()) ? 1 : 0}>
        <text>
          <span style={{ fg: props.message.error ? theme.text.muted : local.agent.color(props.message.agent) }}>
            {Locale.titlecase(props.message.agent)}
          </span>
          <Show when={ctx.terminal.width >= 28}>
            <span style={{ fg: theme.text.muted }}> · {model()}</span>
          </Show>
          <Show when={duration() && (ctx.terminal.width < 28 || ctx.terminal.width >= 36)}>
            <span style={{ fg: theme.text.muted }}> · {Locale.duration(duration())}</span>
          </Show>
          <Show when={config.data.session.tps && tokensPerSecond()}>
            {(value) => <span style={{ fg: theme.text.muted }}> · {value().toFixed(1)} tok/s</span>}
          </Show>
          <Show when={config.data.session.tps && ctx.terminal.width >= 36 && timeToFirstToken()}>
            {(value) => <span style={{ fg: theme.text.muted }}> · {Locale.duration(value())} ttft</span>}
          </Show>
          <Show when={interrupted()}>
            <span style={{ fg: theme.text.muted }}> · interrupted</span>
          </Show>
        </text>
      </box>
    </>
  )
}

/** SessionSwitchMessageV2：代理/模型/位置切换提示行。 */
function SessionSwitchMessageV2(props: { message: SessionMessageInfo }) {
  const ctx = use()
  const theme = useTheme()
  // 位置切换：显示"已移动到 <目录>"
  if (props.message.type === "location-switched")
    return (
      <box paddingLeft={3}>
        <text>
          <span style={{ fg: theme.text.muted }}>↳ Moved to </span>
          <span style={{ fg: theme.text.feedback.info.base }}>{props.message.location.directory}</span>
        </text>
      </box>
    )
  // 代理切换（可带旧名）或模型切换文案
  const text = () => {
    if (props.message.type === "agent-switched") {
      const agent = Locale.titlecase(props.message.agent)
      if (props.message.previous && props.message.previous !== props.message.agent)
        return `Switched agent from ${Locale.titlecase(props.message.previous)} to ${agent}`
      return `Switched agent to ${agent}`
    }
    if (props.message.type === "model-switched")
      return switchLabel(props.message.model, ctx.models(), props.message.previous)
    return ""
  }
  return (
    <box paddingLeft={3}>
      <text fg={theme.text.muted}>{text()}</text>
    </box>
  )
}

/** SessionNoticeMessageV2：系统/合成通知行——子代理/shell 完成状态、指令更新等。 */
function SessionNoticeMessageV2(props: { message: SessionMessageInfo }) {
  const ctx = use()
  const theme = useTheme()
  const renderer = useRenderer()
  const { navigate } = useRoute()
  const [hover, setHover] = createSignal(false)
  // 合成消息的元数据（来源、子代理 ID、状态等）
  const metadata = () => (props.message.type === "synthetic" ? props.message.metadata : undefined)
  const source = () => stringValue(metadata()?.source)
  // 子代理/shell 的完成通知有专门的展示形态
  const completion = () => source() === "subagent" || source() === "shell"
  const childID = () => (source() === "subagent" ? stringValue(metadata()?.childID) : undefined)
  const state = () => stringValue(metadata()?.state)
  // 执行者名称：shell 或代理名
  const actor = () => (source() === "shell" ? "Shell" : Locale.titlecase(stringValue(metadata()?.agent) ?? "Subagent"))
  const text = () => {
    if (props.message.type === "system") return props.message.description ?? "Instructions updated"
    if (props.message.type === "synthetic") return props.message.description ?? ""
    return ""
  }
  // shell 来源的通知把换行折叠成空格
  const description = () => (source() === "shell" ? text().replace(/\s+/g, " ").trim() : text())
  // 状态文案归一化
  const status = () => {
    if (state() === "completed") return "finished"
    if (state() === "error") return "failed"
    return state() ?? "finished"
  }
  const heading = () => `${state() === "completed" ? "↳" : "!"} ${actor()} ${status()}`
  // 按剩余宽度截断描述
  const suffix = () => Locale.truncateWidth(` · ${description()}`, Math.max(0, ctx.width - 3 - stringWidth(heading())))
  // 颜色：错误红、取消黄、悬停高亮、其余信息蓝
  const color = () => {
    if (state() === "error") return theme.text.feedback.error.base
    if (state() === "cancelled") return theme.text.feedback.warning.base
    if (hover() && childID()) return theme.text.base
    return theme.text.feedback.info.base
  }
  return (
    <Show
      when={completion()}
      fallback={
        // 非完成类通知：渲染为内联工具行样式
        <InlineToolRow icon={source() === "goal" ? "◎" : "◈"} color={theme.text.muted} pending="Notice" complete={true}>
          {text()}
        </InlineToolRow>
      }
    >
      <box
        marginLeft={3}
        onMouseOver={() => childID() && setHover(true)}
        onMouseOut={() => setHover(false)}
        onMouseUp={() => {
          // 点击跳转到子代理会话（有文本选区时不触发）
          if (renderer.getSelection()?.getSelectedText()) return
          const id = childID()
          if (id) navigate({ type: "session", sessionID: id })
        }}
      >
        <text wrapMode="none">
          <span style={{ fg: color() }}>{heading()}</span>
          <span style={{ fg: theme.text.muted }}>{suffix()}</span>
        </text>
      </box>
    </Show>
  )
}

/** SessionSkillMessage：技能加载提示行。 */
function SessionSkillMessage(props: { message: Extract<SessionMessageInfo, { type: "skill" }> }) {
  const theme = useTheme()
  return (
    <InlineToolRow icon="→" color={theme.text.muted} pending="Skill" complete={true}>
      Skill {props.message.name}
    </InlineToolRow>
  )
}

/** CompactionMessage：上下文压缩分隔块——标题行（状态/用量）+ 可折叠的摘要正文。 */
function CompactionMessage(props: { message: Extract<SessionMessageInfo, { type: "compaction" }> }) {
  const ctx = use()
  const theme = useTheme()
  const { currentSyntax: syntax } = useThemes()
  const plugins = usePlugin()
  const status = () => props.message.status
  // cancelled：用户主动中止的失败（不显示为错误）
  const cancelled = () => props.message.status === "failed" && props.message.error.type === "aborted"
  // 失败显示错误信息（取消除外），否则显示摘要
  const text = () =>
    props.message.status === "failed" ? (cancelled() ? "" : props.message.error.message) : props.message.summary
  const content = createMemo(() => text().trim())
  const color = () => (status() === "failed" && !cancelled() ? theme.text.feedback.error.base : theme.text.muted)
  // 这里是压缩请求本身的用量；压缩后的上下文大小要等下一步助手输出才可见。
  const usage = () => {
    if (props.message.status === "running" || !props.message.tokens) return
    const tokens = props.message.tokens
    const input = tokens.input + tokens.cache.read + tokens.cache.write
    const output = tokens.output + tokens.reasoning
    if (input + output <= 0) return
    return `${Locale.number(input)} in · ${Locale.number(output)} out`
  }
  return (
    <box>
      {/* 标题行：两侧横线 + 状态图标 + 标题 */}
      <box flexDirection="row" alignItems="center">
        <box border={["top"]} borderColor={color()} flexGrow={1} />
        <box flexDirection="row" gap={1} paddingLeft={1} paddingRight={1}>
          <Switch>
            {/* 运行中：动画 spinner（可配置关闭动画） */}
            <Match when={status() === "running"}>
              <Show when={ctx.config.animations ?? true} fallback={<text fg={color()}>⋯</text>}>
                <spinner frames={SPINNER_FRAMES} interval={80} color={color()} />
              </Show>
            </Match>
            {/* 失败（非取消）：错误叉号 */}
            <Match when={status() === "failed" && !cancelled()}>
              <text fg={color()}>✗</text>
            </Match>
          </Switch>
          <text fg={color()}>
            {props.message.status === "completed" && props.message.native?.messages
              ? "Provider compaction"
              : "Compaction"}
          </text>
          <Show when={cancelled()}>
            <text fg={color()}>· cancelled</text>
          </Show>
          <Show when={usage()}>
            <text fg={color()}>· {usage()}</text>
          </Show>
        </box>
        <box border={["top"]} borderColor={color()} flexGrow={1} />
      </box>
      {/* 摘要正文：markdown 渲染（流式、可隐藏语法记号） */}
      <Show when={content()}>
        <box paddingTop={1} paddingLeft={3}>
          <markdown
            ref={useSessionLinks()}
            syntaxStyle={syntax()}
            renderNode={plugins.markdown()}
            streaming={true}
            internalBlockMode="top-level"
            content={content()}
            tableOptions={{ style: "grid", cellPaddingX: 1 }}
            conceal={ctx.markdownMode() === "rendered"}
            fg={theme.markdown.text}
            bg={theme.background.base}
          />
        </box>
      </Show>
    </box>
  )
}

/** CompactionQueued：压缩已排队的占位分隔条。 */
function CompactionQueued() {
  const theme = useTheme()
  return (
    <box flexDirection="row" alignItems="center">
      <box border={["top"]} borderColor={theme.border.base} flexGrow={1} />
      <box flexDirection="row" gap={1} paddingLeft={1} paddingRight={1}>
        <text fg={theme.text.muted}>◇</text>
        <text fg={theme.text.muted}>Compaction queued</text>
      </box>
      <box border={["top"]} borderColor={theme.border.base} flexGrow={1} />
    </box>
  )
}

/** RevertMessage：撤销提示块——列出被撤销的消息数与受影响文件，点击或按 redo 键恢复。 */
function RevertMessage(props: {
  count: number
  files: ReadonlyArray<{
    readonly file: string
    readonly status: "added" | "modified" | "deleted"
    readonly additions: number
    readonly deletions: number
  }>
}) {
  const ctx = use()
  const theme = useTheme()
  const route = useRouteData("session")
  const client = useClient()
  const toast = useToast()
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)
  // redo 快捷键的展示文案（如 ctrl+r）
  const redoKey = Keymap.useShortcut("session.redo")
  return (
    <box
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => {
        // 点击整个块即执行重做：清除回滚标记（有选区时不触发）
        if (renderer.getSelection()?.getSelectedText()) return
        void (async () => {
          const error = await client.api.session.revert.clear({ sessionID: route.sessionID }).then(
            () => undefined,
            (error) => error,
          )
          if (error) toast.show({ message: errorMessage(error), variant: "error", duration: 5000 })
        })()
      }}
      flexShrink={0}
      marginTop={1}
      border={["left"]}
      customBorderChars={SplitBorder.customBorderChars}
      borderColor={theme.background.raised.base}
    >
      <box
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        backgroundColor={hover() ? theme.decrease(theme.background.raised.base) : theme.background.raised.base}
      >
        <text fg={theme.text.muted}>
          {props.count} message{props.count === 1 ? "" : "s"} reverted
        </text>
        {/* 受影响文件列表：状态标签 + 路径 + 增删行数 */}
        <Show when={props.files.length > 0}>
          <box paddingTop={1} paddingBottom={1} flexDirection="column">
            <For each={props.files}>
              {(file) => (
                <box flexDirection="row" gap={1} flexShrink={0}>
                  <text fg={theme.text.muted}>{statusLabel(file.status)}</text>
                  <FilePath
                    value={file.file}
                    maxWidth={Math.max(
                      2,
                      ctx.width -
                        7 -
                        (file.additions > 0 ? stringWidth(`+${file.additions}`) + 1 : 0) -
                        (file.deletions > 0 ? stringWidth(`-${file.deletions}`) + 1 : 0),
                    )}
                    fg={theme.text.base}
                  />
                  <Show when={file.additions > 0}>
                    <text fg={theme.diff.text.added}>+{file.additions}</text>
                  </Show>
                  <Show when={file.deletions > 0}>
                    <text fg={theme.diff.text.removed}>-{file.deletions}</text>
                  </Show>
                </box>
              )}
            </For>
          </box>
        </Show>
        <text fg={theme.text.muted}>
          <span style={{ fg: theme.text.base }}>{redoKey()}</span> or /redo to restore
        </text>
      </box>
    </box>
  )
}

/** ShellMessage：用户在 TUI 直接执行的 shell 命令展示。 */
function ShellMessage(props: { message: Extract<SessionMessageInfo, { type: "shell" }> }) {
  // 归纳错误信息：被杀/超时/非零退出码
  const error = createMemo(() => {
    if (props.message.status === "killed") return "Command cancelled"
    if (props.message.status === "timeout") return "Command timed out"
    if (props.message.exit !== undefined && props.message.exit !== 0)
      return `Command exited with code ${props.message.exit}`
  })

  return (
    <ShellDisplay
      shellID={props.message.shellID}
      command={props.message.command}
      status={props.message.status === "running" ? "running" : "completed"}
      output={props.message.output?.output}
      error={error()}
    />
  )
}

/** UserMessage：用户消息气泡——左侧色条 + 文本/技能/附件徽标，点击弹出详情或待处理菜单。 */
function UserMessage(props: { message: SessionMessageUser }) {
  const ctx = use()
  const newDesigns = useNewDesigns()
  const data = useData()
  const local = useLocal()
  // 开启读取权限后文件会以 `media:` 引用存储，生成消息类型中省略了这种 PromptAttachment 变体。
  const files = createMemo(() => deduplicateVisibleImages<PromptAttachment>(props.message.files ?? []))
  const skills = createMemo(() => props.message.skills ?? [])
  // 从附件中筛出图片并转成可渲染的 uri（内联 base64 或远程 uri）
  const images = createMemo(() =>
    files().flatMap((file) =>
      file.mime.startsWith("image/")
        ? [{ uri: "uri" in file ? file.uri : `data:${file.mime};base64,${file.data}` }]
        : [],
    ),
  )
  const themes = useThemes()
  const theme = useTheme()
  const mode = themes.mode
  const [hover, setHover] = createSignal(false)
  // 左边条颜色跟随会话当前代理的主题色
  const color = createMemo(() => local.agent.color(data.session.get(ctx.sessionID)?.agent ?? "build"))
  // 该消息的投递状态（steer/queue），排队中显示中性边框
  const delivery = createMemo(() => ctx.pendingDelivery(props.message.id))
  const dialog = useDialog()
  const renderer = useRenderer()

  // 更新待处理提示词（转队列或删除），成功后关闭对话框
  const updatePendingSteer = async (action: "queue" | "cancel") => {
    if (await ctx.mutatePending(action, props.message.id)) dialog.clear()
  }

  return (
    <Show when={props.message.text.trim() || files().length || skills().length}>
      <box
        border={["left"]}
        borderColor={delivery() ? theme.border.base : color()}
        customBorderChars={SplitBorder.customBorderChars}
        backgroundColor={theme.background.raised.base}
      >
        {/* 消息内嵌图片 */}
        <SessionImages images={images()} paddingLeft={2} />
        <box
          onMouseOver={() => {
            setHover(true)
          }}
          onMouseOut={() => {
            setHover(false)
          }}
          onMouseUp={() => {
            if (renderer.getSelection()?.getSelectedText()) return
            // steer 状态的消息：弹出"转队列/删除"菜单
            if (delivery() === "steer") {
              dialog.replace(() => (
                <DialogSelect
                  title="Pending steer"
                  renderFilter={!newDesigns()}
                  options={[
                    { title: "Move to queue", value: "queue" as const },
                    { title: "Delete", value: "cancel" as const },
                  ]}
                  onSelect={(option) => {
                    void updatePendingSteer(option.value)
                  }}
                />
              ))
              return
            }
            // 对话框的生命周期长于本行，重新同步可能丢掉消息导致 props 过期，
            // 因此只传 messageID，由对话框自行取数。
            const messageID = props.message.id
            dialog.replace(() => <DialogMessage messageID={messageID} sessionID={ctx.sessionID} />)
          }}
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          paddingRight={2}
          backgroundColor={hover() ? theme.decrease(theme.background.raised.base) : theme.background.raised.base}
          flexShrink={0}
        >
          {/* 消息正文 */}
          <text fg={theme.text.base}>{props.message.text}</text>
          {/* 已引用技能徽标列表 */}
          <Show when={skills().length}>
            <box flexDirection="row" paddingTop={1} gap={1} flexWrap="wrap">
              <For each={skills()}>
                {(skill) => (
                  <text fg={theme.text.base}>
                    <span
                      style={{
                        bg: theme.hue.accent[mode() === "light" ? 300 : 200],
                        fg: theme.background.raised.base,
                        bold: true,
                      }}
                    >
                      {" skill "}
                    </span>
                    <span style={{ bg: theme.decrease(theme.background.raised.base), fg: theme.text.muted }}>
                      {` ${skill.name} `}
                    </span>
                  </text>
                )}
              </For>
            </box>
          </Show>
          {/* 附件徽标列表：目录/文件标签 + 名称或 URI */}
          <Show when={files().length}>
            <box flexDirection="row" paddingTop={1} gap={1} flexWrap="wrap">
              <For each={files()}>
                {(file) => {
                  const label = file.mime === "application/x-directory" ? "dir" : "file"
                  return (
                    <text fg={theme.text.base}>
                      <span
                        style={{
                          bg: theme.hue.accent[mode() === "light" ? 300 : 200],
                          fg: theme.background.raised.base,
                          bold: true,
                        }}
                      >
                        {` ${label} `}
                      </span>
                      <span style={{ bg: theme.decrease(theme.background.raised.base), fg: theme.text.muted }}>
                        {" "}
                        {file.name ?? (file.source.type === "uri" ? file.source.uri : "attachment")}{" "}
                      </span>
                    </text>
                  )
                }}
              </For>
            </box>
          </Show>
        </box>
      </box>
    </Show>
  )
}

/** QueuedPromptDock：排队提示坞——显示队列长度与首条内容预览，点击打开管理对话框。 */
function QueuedPromptDock(props: { prompts: { id: string; text: string }[]; onOpen: () => void }) {
  const theme = useTheme()
  const [hover, setHover] = createSignal(false)
  // 第一条排队提示的单行预览（换行替换为空格）
  const next = createMemo(() => props.prompts[0]?.text.replaceAll("\n", " "))

  return (
    <box
      marginBottom={1}
      border={["left"]}
      borderColor={theme.border.base}
      customBorderChars={SplitBorder.customBorderChars}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={props.onOpen}
    >
      <box
        width="100%"
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        backgroundColor={hover() ? theme.decrease(theme.background.raised.base) : theme.background.raised.base}
        flexDirection="row"
      >
        <text fg={theme.text.muted} wrapMode="none" truncate flexGrow={1} flexShrink={1} minWidth={0}>
          <span style={{ fg: theme.text.base }}>{props.prompts.length} queued</span>
          <Show when={next()}>{(text) => <> · {text()}</>}</Show>
        </text>
      </box>
    </box>
  )
}

// freeLimitReset：把重试延迟换算成额度重置时间的可读文案。
// 延迟非法（缺失/非有限/为负/超过 7 天）或基准时间非法时返回 undefined；
// 重置点在今天且 24 小时内则只显示时间，否则显示完整日期时间。
function freeLimitReset(delay: number | undefined, base: number) {
  if (delay === undefined || !Number.isFinite(delay) || delay < 0 || delay > 7 * 86_400_000 || !Number.isFinite(base))
    return
  const at = base + delay
  if (Number.isNaN(new Date(at).getTime())) return
  const now = Date.now()
  return new Date(at).toDateString() === new Date(now).toDateString() && at - now < 86_400_000
    ? Locale.time(at)
    : Locale.datetime(at)
}

/** FreeLimitNotice：免费额度用尽的提示块，含重置时间与升级/换模型指引。 */
function FreeLimitNotice(props: { message: Pick<SessionMessageAssistant, "error" | "time"> }) {
  const theme = useTheme()
  // 根据错误里的 retryAfterMs 计算重置时间文案
  const reset = createMemo(() =>
    freeLimitReset(props.message.error?.retryAfterMs, props.message.time.completed ?? props.message.time.created),
  )
  return (
    <box paddingLeft={3} flexDirection="column">
      <text fg={theme.text.muted}>You've used today's free messages.{reset() ? ` They reset at ${reset()}.` : ""}</text>
      <text fg={theme.text.muted}>
        Upgrade to OpenCode Go → <span style={{ fg: theme.text.base }}>/connect</span> · Switch model →{" "}
        <span style={{ fg: theme.text.base }}>/models</span>
      </text>
    </box>
  )
}

/** AssistantRetry：自动重试倒计时条——每秒刷新剩余秒数，到点显示 Retry due。 */
function AssistantRetry(props: { retry: SessionMessageAssistant["retry"] }) {
  const theme = useTheme()
  const [seconds, setSeconds] = createSignal(0)
  createEffect(() => {
    const at = props.retry?.at
    if (at === undefined) return
    const update = () => setSeconds(Math.max(0, Math.ceil((at - Date.now()) / 1_000)))
    // 已到点则不再起定时器
    if (update() === 0) return
    const timer = setInterval(() => {
      if (update() === 0) clearInterval(timer)
    }, 1_000)
    onCleanup(() => clearInterval(timer))
  })
  return (
    <Show when={props.retry}>
      {(retry) => (
        <box paddingLeft={3}>
          <text fg={theme.text.feedback.warning.base}>
            ⚠ {seconds() > 0 ? `Retrying in ${seconds()}s` : "Retry due"} · attempt {retry().attempt} ·{" "}
            {retry().error.message}
          </text>
        </box>
      )}
    </Show>
  )
}

// 待处理消息已下沉到各工具各自的 pending 渲染中

/** ToolPart：工具调用分片的统一入口——按工具显示类型分派到具体组件。 */
function ToolPart(props: { part: SessionMessageAssistantTool; images?: boolean }) {
  // 工具名到展示类型的映射
  const display = createMemo(() => toolDisplay(props.part.name))

  // 传给各工具组件的公共属性（惰性 getter，随分片状态更新）
  const toolprops = {
    get metadata() {
      // 状态元数据（耗时、路径等附加信息）
      return toolDisplayMetadata(props.part.state)
    },
    get input() {
      // 字符串形式的输入视为无效，退化为空对象
      return typeof props.part.state.input === "string" ? {} : props.part.state.input
    },
    get output() {
      // 流式输出中暂不给内容；结束后把文本/文件名拼接为一行串
      if (props.part.state.status === "streaming") return undefined
      return toolDisplayContent(props.part.state)
        .flatMap((content) => (content.type === "text" ? [content.text] : [content.name ?? content.uri]))
        .join("\n")
    },
    get tool() {
      return props.part.name
    },
    get part() {
      return props.part
    },
  }

  const content = (
    <Switch>
      {/* 按展示类型分派：shell */}
      <Match when={display() === "shell"}>
        <Shell {...toolprops} />
      </Match>
      <Match when={display() === "glob"}>
        <Glob {...toolprops} />
      </Match>
      <Match when={display() === "read"}>
        <Read {...toolprops} />
      </Match>
      <Match when={display() === "grep"}>
        <Grep {...toolprops} />
      </Match>
      <Match when={display() === "webfetch"}>
        <WebFetch {...toolprops} />
      </Match>
      <Match when={display() === "websearch"}>
        <WebSearch {...toolprops} />
      </Match>
      <Match when={display() === "write"}>
        <Write {...toolprops} />
      </Match>
      <Match when={display() === "edit"}>
        <Edit {...toolprops} />
      </Match>
      <Match when={display() === "subagent"}>
        <Subagent {...toolprops} />
      </Match>
      <Match when={display() === "execute"}>
        <Execute {...toolprops} />
      </Match>
      <Match when={display() === "patch"}>
        <ApplyPatch {...toolprops} />
      </Match>
      <Match when={display() === "todowrite"}>
        <TodoWrite {...toolprops} />
      </Match>
      <Match when={display() === "question"}>
        <Question {...toolprops} />
      </Match>
      <Match when={display() === "skill"}>
        <Skill {...toolprops} />
      </Match>
      {/* 兜底：通用工具渲染 */}
      <Match when={true}>
        <GenericTool {...toolprops} />
      </Match>
    </Switch>
  )
  // 工具内容 + 可选的工具产物图片
  return [
    content,
    <Show when={props.images !== false}>
      <ToolImages parts={[props.part]} />
    </Show>,
  ]
}

/** ToolImages：从工具分片中提取图片并交给 SessionImages 渲染。 */
function ToolImages(props: { parts: readonly SessionMessageAssistantTool[] }) {
  const images = createMemo(() => props.parts.flatMap(inlineToolImages))
  return <SessionImages images={images()} />
}

/** SessionImages：内联图片缩略图行——最多 3 张，点击打开预览对话框。 */
function SessionImages(props: { images: readonly { uri: string }[]; paddingLeft?: number }) {
  const ctx = use()
  const dialog = useDialog()
  // 配置关闭 image_preview 时不展示任何图片
  const images = createMemo(() => (ctx.config.session?.image_preview ? props.images : []))
  // 缩略图高度：终端高的 1/4，夹在 4-8 行之间
  const height = createMemo(() => Math.max(4, Math.min(8, Math.floor(ctx.terminal.height / 4))))
  const visible = createMemo(() => images().slice(0, 3))

  return (
    <Show when={visible().length > 0}>
      <box
        flexDirection="row"
        flexShrink={0}
        paddingTop={1}
        paddingLeft={props.paddingLeft ?? 3}
        paddingRight={2}
        paddingBottom={1}
        gap={1}
      >
        <For each={visible()}>
          {(image, index) => {
            // 每张图一个媒体数据源（负责加载与错误状态）
            const media = createMediaSource(() => image.uri)
            return (
              <box
                width={height() * 2}
                height={height()}
                flexBasis={height() * 2}
                flexShrink={1}
                alignItems="center"
                justifyContent="center"
                onMouseUp={(event: MouseEvent) => {
                  // 左键点击打开全量图片预览
                  if (event.button !== 0) return
                  event.stopPropagation()
                  dialog.replace(() => <DialogImagePreview images={images()} initial={index()} />)
                }}
              >
                <Show when={!media.failed()} fallback={<text>No preview</text>}>
                  <image
                    source={media.source()}
                    fit="cover"
                    protocol="auto"
                    width="100%"
                    height="100%"
                    onError={media.onError}
                  />
                </Show>
              </box>
            )
          }}
        </For>
        {/* 超过 3 张时显示 "+N more" 占位 */}
        <Show when={images().length > visible().length}>
          <box width={8} height={height()} flexShrink={1} alignItems="center" justifyContent="center">
            <text wrapMode="none" truncate>
              +{images().length - visible().length} more
            </text>
          </box>
        </Show>
      </box>
    </Show>
  )
}

// inlineToolImages：从工具状态中提取可展示的图片（file 类型 + 图片 mime + data URI 或可识别媒体哈希）
function inlineToolImages(part: SessionMessageAssistantTool) {
  return toolDisplayContent(part.state).flatMap((content) =>
    content.type === "file" &&
    content.mime.startsWith("image/") &&
    (content.uri.startsWith("data:image/") || mediaHashFromUri(content.uri))
      ? [{ uri: content.uri }]
      : [],
  )
}

// 工具组件的公共属性类型
type ToolProps = {
  input: Record<string, unknown>
  metadata: Record<string, unknown>
  tool: string
  output?: string
  part: SessionMessageAssistantTool
}
/** GenericTool：未定制的工具兜底渲染——一行摘要，展开后显示输入键值与输出。 */
function GenericTool(props: ToolProps) {
  const theme = useTheme()
  // 输出文本：去 ANSI 并 trim
  const output = createMemo(() => stripAnsi(props.output?.trim() ?? ""))
  // 输入键值对
  const input = createMemo(() => Object.entries(props.input))
  const [expanded, setExpanded] = createSignal(false)
  // 有输入或输出才可展开
  const expandable = createMemo(() => input().length > 0 || output().length > 0)
  // 流式或运行中显示 spinner
  const loading = createMemo(() => props.part.state.status === "streaming" || props.part.state.status === "running")

  return (
    <>
      <InlineTool
        icon={props.part.state.status === "error" ? "✗" : "✓"}
        complete={props.part.state.status === "completed"}
        pending={props.tool}
        spinner={loading()}
        part={props.part}
        onClick={expandable() ? () => setExpanded((value) => !value) : undefined}
      >
        {genericToolSummary(props.tool, props.input)}
      </InlineTool>
      <Show when={expanded()}>
        <box paddingLeft={3 + INLINE_TOOL_ICON_WIDTH}>
          <For each={input()}>
            {([key, value]) => (
              <box flexDirection="row">
                <text flexShrink={0} fg={theme.text.muted}>
                  {key}:{" "}
                </text>
                <text flexGrow={1} wrapMode="word" fg={theme.text.base}>
                  {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
                </text>
              </box>
            )}
          </For>
          <Show when={output()}>
            {(value) => (
              <box flexDirection="row">
                <text flexShrink={0} fg={theme.text.muted}>
                  output:{" "}
                </text>
                <text flexGrow={1} fg={theme.text.base} wrapMode="word">
                  {value()}
                </text>
              </box>
            )}
          </Show>
        </box>
      </Show>
    </>
  )
}

// genericToolSummary：工具名 + 原始参数摘要（导出供其他模块复用）
export function genericToolSummary(tool: string, input: Record<string, unknown>) {
  const args = primitiveInputSummary(input).replace(/\s+/g, " ")
  return `${tool}${args ? ` ${args}` : ""}`
}

// useToolPermission：判断某工具分片是否正处于"等待权限批复"状态。
// 自动接受模式下恒为 false；否则比对第一条权限请求是否来源于该工具。
function useToolPermission(part: () => SessionMessageAssistantTool | undefined) {
  const ctx = use()
  const data = useData()
  const local = useLocal()
  return createMemo(() => {
    if (local.permission.mode === "autoaccept") return false
    const request = data.session.permission.list(ctx.sessionID)?.[0]
    return request?.source?.type === "tool" && request.source.id === part()?.id
  })
}

/** InlineTool：内联单行工具渲染——图标/状态色/错误展开/点击回调的公共封装。 */
function InlineTool(props: {
  icon: string
  color?: RGBA
  complete: unknown
  pending: string
  spinner?: boolean
  running?: boolean
  status?: JSX.Element
  children: JSX.Element
  part: SessionMessageAssistantTool
  onClick?: () => void
  onErrorClick?: () => void
}) {
  const theme = useTheme()
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)
  const [errorExpanded, setErrorExpanded] = createSignal(false)
  // 该工具是否在等权限批复
  const permission = useToolPermission(() => props.part)

  // 错误信息：running 期间不当作错误
  const error = createMemo(() =>
    !props.running && props.part.state.status === "error" ? stripAnsi(props.part.state.error.message) : undefined,
  )

  // denied：用户拒绝/取消导致的失败（不算真正的执行错误，颜色更温和）
  const denied = createMemo(
    () =>
      error()?.includes("QuestionRejectedError") ||
      error()?.includes("rejected permission") ||
      error()?.includes("specified a rule") ||
      error()?.includes("user dismissed"),
  )

  const failed = createMemo(() => Boolean(error() && !denied()))
  const clickable = createMemo(() => Boolean(props.onClick || failed()))
  // 文字颜色优先级：外部指定 > 等权限（黄） > 失败（红） > 悬停高亮 > 默认灰
  const fg = createMemo(() => {
    if (props.color) return props.color
    if (permission()) return theme.text.feedback.warning.base
    if (failed()) return theme.text.feedback.error.base
    if (hover() && props.onClick) return theme.text.base
    return theme.text.muted
  })

  return (
    <InlineToolRow
      icon={props.icon}
      color={fg()}
      errorColor={theme.text.feedback.error.base}
      failed={failed()}
      denied={Boolean(denied())}
      error={error()}
      errorExpanded={errorExpanded()}
      complete={props.complete}
      pending={props.pending}
      spinner={props.spinner}
      status={props.status}
      onMouseOver={() => clickable() && setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return
        // 失败时点击展开错误详情（或走外部回调）
        if (failed()) {
          if (props.onErrorClick) return props.onErrorClick()
          setErrorExpanded((value) => !value)
          return
        }
        props.onClick?.()
      }}
    >
      {props.children}
    </InlineToolRow>
  )
}

/** StatusBadge：小型状态徽标（带底色的文字块）。 */
function StatusBadge(props: { children: string; raised?: boolean }) {
  const theme = useTheme()
  const background = () => (props.raised ? theme.background.raised.base : theme.background.base)
  return (
    <text flexShrink={0} bg={theme.decrease(background())} fg={theme.text.muted}>
      {" "}
      {props.children}{" "}
    </text>
  )
}

// 块状工具（BlockTool）的属性：标题/路径/头部颜色/内容/点击/分片/加载态/错误
type BlockToolProps = {
  title?: string
  path?: { label: string; value: string }
  headerColor?: RGBA
  children?: JSX.Element
  onClick?: () => void
  part?: SessionMessageAssistantTool
  spinner?: boolean
  error?: string
  errorColor?: RGBA
}

/** BlockTool：块状工具容器——左侧竖线 + 凸出背景，头部显示路径或标题，可整体点击。 */
function BlockTool(props: BlockToolProps) {
  const theme = useTheme()
  const background = () => theme.background.raised.base
  const ctx = use()
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)
  const error = createMemo(() =>
    stripAnsi(props.error ?? (props.part?.state.status === "error" ? props.part.state.error.message : "")),
  )
  const permission = useToolPermission(() => props.part)
  return (
    <box
      border={["left"]}
      flexShrink={0}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      gap={1}
      backgroundColor={hover() ? theme.decrease(background()) : background()}
      customBorderChars={SplitBorder.customBorderChars}
      borderColor={theme.background.base}
      onMouseOver={() => props.onClick && setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return
        props.onClick?.()
      }}
    >
      <Show
        when={props.path}
        fallback={
          // 无路径时显示普通标题；运行中标题前的 "# " 换成 spinner
          <Show when={props.title}>
            {(title) => (
              <Show
                when={props.spinner}
                fallback={
                  <text
                    fg={permission() ? theme.text.feedback.warning.base : (props.headerColor ?? theme.text.muted)}
                  >
                    {title()}
                  </text>
                }
              >
                <Spinner color={permission() ? theme.text.feedback.warning.base : theme.text.muted}>
                  {title().replace(/^# /, "")}
                </Spinner>
              </Show>
            )}
          </Show>
        }
      >
        {(path) => (
          <box flexDirection="row" gap={1} minWidth={0}>
            <Show
              when={props.spinner}
              fallback={
                <text
                  flexShrink={0}
                  fg={permission() ? theme.text.feedback.warning.base : (props.headerColor ?? theme.text.muted)}
                >
                  {path().label}
                </text>
              }
            >
              <Spinner color={permission() ? theme.text.feedback.warning.base : theme.text.muted}>
                {path().label.replace(/^# /, "")}
              </Spinner>
            </Show>
            {/* 路径按剩余宽度截断展示 */}
            <FilePath
              value={path().value}
              maxWidth={Math.max(2, ctx.width - 6 - stringWidth(path().label) - (props.spinner ? 2 : 0))}
              fg={permission() ? theme.text.feedback.warning.base : (props.headerColor ?? theme.text.muted)}
            />
          </box>
        )}
      </Show>
      {props.children}
      <Show when={error()}>
        <text fg={props.errorColor ?? theme.text.feedback.error.base}>{error()}</text>
      </Show>
    </box>
  )
}

// shell 输出展示的最大字符数（1MB），超出部分只保留尾部
const SHELL_DISPLAY_LIMIT = 1024 * 1024

/** Shell 工具渲染：转发给 ShellDisplay，带 shell 会话 ID 与后台状态。 */
function Shell(props: ToolProps) {
  const stopped = createMemo(() => stoppedShell(props.part, props.metadata))
  return (
    <ShellDisplay
      part={props.part}
      shellID={stringValue(props.metadata.shellID)}
      command={stringValue(props.input.command)}
      workdir={stringValue(props.input.workdir)}
      status={props.part.state.status}
      // 工具状态已完成但元数据显示 shell 仍在跑 => 已转后台
      background={props.part.state.status === "completed" && props.metadata.status === "running"}
      output={stopped()?.output ?? (stringValue(props.metadata.shellID) ? undefined : props.output)}
      error={stopped()?.notice}
    />
  )
}

// A call the user stopped fails with its output followed by a notice, which its metadata names. Its output shows like
// a finished call's and only the notice as the error. A plugin that rewrote the error gets it shown as is.
function stoppedShell(part: SessionMessageAssistantTool, metadata: Record<string, unknown>) {
  if (part.state.status !== "error" || metadata.interrupted !== true) return
  const notice = stringValue(metadata.notice)
  const message = part.state.error.message
  if (!notice || !message.endsWith(notice)) return
  return { output: message.slice(0, -notice.length).replace(/\n+$/, ""), notice }
}

function ShellDisplay(props: {
  part?: SessionMessageAssistantTool
  shellID?: string
  command?: string
  workdir?: string
  status: SessionMessageAssistantTool["state"]["status"]
  background?: boolean
  output?: string
  error?: string
}) {
  const theme = useTheme()
  const ctx = use()
  const client = useClient()
  const data = useData()
  const pathFormatter = usePathFormatter()
  // 会话可能已移动目录而 shell 仍在原 Location 运行，因此优先取 shell 自己的位置。
  const location = data.shell.get(props.shellID ?? "")?.location ?? data.session.get(ctx.sessionID)?.location
  const permission = useToolPermission(() => props.part)
  // 等权限时命令文字显示警告色
  const color = createMemo(() => (permission() ? theme.text.feedback.warning.base : theme.text.base))
  // 该命令是否对应一个仍在 registry 里的后台 shell
  const backgroundRunning = createMemo(() => {
    const id = props.shellID
    return Boolean(id && data.shell.get(id))
  })
  const isRunning = createMemo(() => props.status === "running" || backgroundRunning())
  const workdir = createMemo(() => pathFormatter.format(props.workdir))
  const [expanded, setExpanded] = createSignal(false)
  // 后台 shell 的增量输出缓冲
  const [backgroundOutput, setBackgroundOutput] = createSignal("")
  const [outputTruncated, setOutputTruncated] = createSignal(false)
  // 拉取循环的内部状态：是否在拉、是否请求过排水（drain）、游标、曾运行标记
  let loading = false
  let drainRequested = false
  let cursor = 0
  let wasRunning = false
  // loadBackgroundOutput：从 server 按 cursor 增量拉取 shell 输出。
  // drain=true 时一次追平全部积压（可能跳过中段并标记截断）。
  const loadBackgroundOutput = async (drain = false) => {
    if (props.status === "completed" && props.output !== undefined) return
    const id = props.shellID
    if (!id) return
    // 已有拉取在进行：只记录"需要再拉一轮"
    if (loading) {
      if (drain) drainRequested = true
      return
    }
    loading = true
    do {
      const response = await client.api.shell
        .output({
          id,
          cursor,
          limit: SHELL_DISPLAY_LIMIT,
          location: location ? { directory: location.directory } : undefined,
        })
        .catch(() => undefined)
      if (!response) break
      if (response.data.output)
        setBackgroundOutput((output) => {
          // 追加新输出；超过上限则只保留尾部并标记截断
          const next = stripAnsi(output + response.data.output)
          if (next.length <= SHELL_DISPLAY_LIMIT) return next
          setOutputTruncated(true)
          return next.slice(-SHELL_DISPLAY_LIMIT)
        })
      if (response.data.cursor <= cursor) break
      cursor = response.data.cursor
      if (!drain || cursor >= response.data.size) break
      // drain 模式：跳到能保住最后 1MB 的位置
      const tail = Math.max(cursor, response.data.size - SHELL_DISPLAY_LIMIT)
      if (tail > cursor) {
        cursor = tail
        setOutputTruncated(true)
      }
    } while (true)
    loading = false
    // 处理期间到达的新排水请求
    if (drainRequested) {
      drainRequested = false
      void loadBackgroundOutput(true)
    }
  }
  // 后台 shell 状态变化：开始运行时轮询输出；结束后排水一次
  createEffect(() => {
    const running = backgroundRunning()
    if (!running) {
      if (wasRunning) void loadBackgroundOutput(true)
      wasRunning = false
      return
    }
    wasRunning = true
    // 后台徽标模式且未展开：不自动拉取
    if (props.background && !expanded()) return
    void loadBackgroundOutput()
    const interval = setInterval(() => void loadBackgroundOutput(), 1_000)
    onCleanup(() => clearInterval(interval))
  })
  // 最终展示的输出文本
  const output = createMemo(() => {
    if (props.status === "streaming") return ""
    if (props.shellID) {
      // 后台折叠态不显示输出
      if (props.background && !expanded()) return ""
      if (props.status === "completed" && props.output !== undefined) return stripAnsi(props.output.trim())
      const text = stripAnsi((backgroundOutput() || props.output || "").trim())
      return outputTruncated() ? `[earlier output omitted]\n${text}` : text
    }
    return stripAnsi(props.output?.trim() ?? "")
  })
  // 折叠上限：10 行，按可用宽度换算字符数（运行中多留 2 列给 spinner）
  const maxLines = 10
  const maxChars = createMemo(() => maxLines * Math.max(20, ctx.width - 8 - (isRunning() ? 2 : 0)))
  const prefix = createMemo(() => (workdir() && workdir() !== "." ? `cd ${workdir()} && ` : ""))
  // 完整命令文本：运行中不带 $ 提示符
  const input = createMemo(() => (props.command ? `${isRunning() ? "" : "$ "}${prefix()}${props.command}` : ""))
  // 折叠计算：保留首尾行
  const collapsed = createMemo(() => collapseShellOutput(input(), output(), maxLines, maxChars()))
  const limitedInput = createMemo(() => (expanded() ? input() : collapsed().input))
  const limitedOutput = createMemo(() => (expanded() ? output() : collapsed().output))
  // 有后台会话或内容溢出时可展开
  const expandable = createMemo(() => Boolean(props.shellID) || collapsed().overflow)
  const toggle = () => {
    const next = !expanded()
    setExpanded(next)
    // 展开时拉一次输出（运行中只拉增量，结束后排水）
    if (next) void loadBackgroundOutput(!backgroundRunning())
  }

  return (
    <BlockTool part={props.part} error={props.error} onClick={expandable() ? toggle : undefined}>
      <box gap={1}>
        <Show
          when={props.command}
          fallback={
            // 命令尚未生成：显示占位（运行中带 spinner）
            isRunning() || props.status === "streaming" ? (
              <Spinner color={color()}>Writing command…</Spinner>
            ) : (
              <text fg={theme.text.muted}>Writing command…</text>
            )
          }
        >
          <Show
            when={isRunning()}
            fallback={
              // 非运行态：纯文本命令，折叠时最多 2 行
              <text
                fg={theme.text.base}
                wrapMode={expanded() ? "word" : "char"}
                maxHeight={expanded() ? undefined : 2}
              >
                {limitedInput()}
              </text>
            }
          >
            <box flexDirection="row" gap={1}>
              <Spinner color={color()} />
              <text
                fg={color()}
                wrapMode={expanded() ? "word" : "char"}
                maxHeight={expanded() ? undefined : 2}
                flexGrow={1}
                minWidth={0}
              >
                {limitedInput()}
              </text>
            </box>
          </Show>
          <Show when={limitedOutput()}>
            <text fg={theme.text.muted}>{limitedOutput()}</text>
          </Show>
        </Show>
        <Show when={props.background}>
          <StatusBadge raised>Background</StatusBadge>
        </Show>
      </box>
    </BlockTool>
  )
}

/** Write 工具渲染：完成后展示写入的代码块（带语法高亮与诊断），准备中显示行内占位。 */
function Write(props: ToolProps) {
  const theme = useTheme()
  const { currentSyntax: syntax } = useThemes()
  const pathFormatter = usePathFormatter()
  const code = createMemo(() => {
    return stringValue(props.input.content) ?? ""
  })

  return (
    <Switch>
      <Match when={props.part.state.status === "completed"}>
        <BlockTool
          path={{ label: "# Wrote", value: pathFormatter.format(stringValue(props.input.path)) }}
          part={props.part}
        >
          <line_number fg={theme.text.muted} minWidth={3} paddingRight={1}>
            <code
              conceal={false}
              fg={theme.text.base}
              filetype={filetype(stringValue(props.input.path))}
              syntaxStyle={syntax()}
              content={code()}
            />
          </line_number>
          <Diagnostics diagnostics={props.metadata.diagnostics} filePath={stringValue(props.input.path) ?? ""} />
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="←" pending="Preparing write…" complete={stringValue(props.input.path)} part={props.part}>
          Write {pathFormatter.format(stringValue(props.input.path))}
        </InlineTool>
      </Match>
    </Switch>
  )
}

/** Glob 工具渲染：glob 模式、范围目录与命中数摘要。 */
function Glob(props: ToolProps) {
  const pathFormatter = usePathFormatter()
  return (
    <InlineTool icon="✱" pending="Finding files…" complete={stringValue(props.input.pattern)} part={props.part}>
      Glob "{stringValue(props.input.pattern)}"{" "}
      <Show when={stringValue(props.input.path)}>in {pathFormatter.format(stringValue(props.input.path))} </Show>
      <Show when={finiteNumber(props.metadata.count)}>
        ({finiteNumber(props.metadata.count)} {finiteNumber(props.metadata.count) === 1 ? "match" : "matches"})
      </Show>
    </InlineTool>
  )
}

/** Read 工具渲染：一行"读文件"摘要 + 附加加载的文件列表。 */
function Read(props: ToolProps) {
  const theme = useTheme()
  const pathFormatter = usePathFormatter()
  const isRunning = createMemo(() => props.part.state.status === "running")
  // 元数据里记录的同批加载的其他文件路径
  const loaded = createMemo(() => {
    if (props.part.state.status !== "completed") return []
    const value = props.metadata.loaded
    if (!value || !Array.isArray(value)) return []
    return value.filter((p): p is string => typeof p === "string")
  })
  return (
    <>
      <InlineTool
        icon="→"
        pending="Reading file…"
        complete={stringValue(props.input.path)}
        spinner={isRunning()}
        part={props.part}
      >
        Read {pathFormatter.format(stringValue(props.input.path))}
        {/* 带偏移/限额时显示读取行号区间 */}
        <Show when={props.input.offset !== undefined || props.input.limit !== undefined}>
          :{finiteNumber(props.input.offset) || 1}-
          {props.input.limit ? (finiteNumber(props.input.offset) || 1) + (finiteNumber(props.input.limit) || 0) - 1 : ""}
        </Show>
      </InlineTool>
      <For each={loaded()}>
        {(filepath) => (
          <box paddingLeft={3}>
            <text paddingLeft={3} fg={theme.text.muted}>
              ↳ Loaded {pathFormatter.format(filepath)}
            </text>
          </box>
        )}
      </For>
    </>
  )
}

/** Grep 工具渲染：模式、范围目录与命中数摘要。 */
function Grep(props: ToolProps) {
  const pathFormatter = usePathFormatter()
  return (
    <InlineTool icon="✱" pending="Searching content…" complete={stringValue(props.input.pattern)} part={props.part}>
      Grep "{stringValue(props.input.pattern)}"{" "}
      <Show when={stringValue(props.input.path)}>in {pathFormatter.format(stringValue(props.input.path))} </Show>
      <Show when={finiteNumber(props.metadata.matches)}>
        ({finiteNumber(props.metadata.matches)} {finiteNumber(props.metadata.matches) === 1 ? "match" : "matches"})
      </Show>
    </InlineTool>
  )
}

/** WebFetch 工具渲染：抓取的 URL。 */
function WebFetch(props: ToolProps) {
  return (
    <InlineTool icon="%" pending="Fetching from the web…" complete={stringValue(props.input.url)} part={props.part}>
      WebFetch {stringValue(props.input.url)}
    </InlineTool>
  )
}

/** WebSearch 工具渲染：搜索服务商（带重试状态组件）与查询词。 */
function WebSearch(props: ToolProps) {
  const ctx = use()
  const provider = createMemo(() => stringValue(props.metadata.provider))
  return (
    <InlineTool icon="◈" pending="Searching web…" complete={stringValue(props.input.query)} part={props.part}>
      <Show when={provider()} fallback="Web Search">
        {(value) => (
          <>
            Web Search via{" "}
            <RetryProvider
              value={{
                id: `${ctx.sessionID}:${props.part.time.created}:${props.part.id}`,
                provider: value(),
                running: props.part.state.status === "running",
              }}
              enabled={ctx.config.animations ?? true}
            />
          </>
        )}
      </Show>{" "}
      "{stringValue(props.input.query)}"
    </InlineTool>
  )
}

/** Subagent 工具渲染：子代理委托行，显示代理名/描述/模型，点击跳转子会话。 */
function Subagent(props: ToolProps) {
  const { navigate } = useRoute()
  const data = useData()
  // 子代理会话 ID：优先元数据，其次输入；失败的续接可能携带无关会话 ID（如父会话），需排除。
  const sessionID = createMemo(
    () =>
      stringValue(props.metadata.sessionID) ??
      stringValue(props.metadata.sessionId) ??
      // 失败的续接可能携带无关会话 ID（如父会话本身）。
      (props.part.state.status === "error" ? undefined : stringValue(props.input.sessionID)),
  )
  const description = createMemo(() => stringValue(props.input.description))
  // 带会话 ID 的输入表示是"续接"已有子代理
  const continuation = createMemo(() => Boolean(stringValue(props.input.sessionID)))
  const model = createMemo(() => subagentModelLabel(stringValue(props.input.model), data.location.model.list()))
  // 工具在跑或子会话仍在运行都算运行中
  const isRunning = createMemo(() => {
    const id = sessionID()
    return props.part.state.status === "running" || Boolean(id && data.session.status(id) === "running")
  })

  return (
    <InlineTool
      icon={isRunning() ? "│" : continuation() ? "↳" : props.part.state.status === "completed" ? "✓" : "│"}
      spinner={isRunning()}
      running={isRunning()}
      complete={description()}
      pending="Delegating…"
      part={props.part}
      onClick={() => {
        const id = sessionID()
        if (id) navigate({ type: "session", sessionID: id })
      }}
    >
      {`${continuation() ? "Continue subagent" : `${Locale.titlecase(stringValue(props.input.agent) ?? stringValue(props.input.subagent_type) ?? "General")} Subagent`} — ${description() ?? "Subagent"}${model() ? ` · ${model()}` : ""}`}
    </InlineTool>
  )
}

// subagentModelLabel：把 "provider/model#variant" 引用解析成可读标签（有已知模型则用显示名）。
// 导出供分组视图等复用。
export function subagentModelLabel(
  value: string | undefined,
  models: readonly Pick<ModelInfo, "providerID" | "id" | "name">[] | undefined,
) {
  if (!value) return
  const [reference, variant] = value.split("#")
  const separator = reference.indexOf("/")
  const providerID = separator === -1 ? "" : reference.slice(0, separator)
  const modelID = separator === -1 ? reference : reference.slice(separator + 1)
  const name = models?.find((item) => item.providerID === providerID && item.id === modelID)?.name
  return `${name ?? reference}${variant ? ` (${variant})` : ""}`
}

export { executeCallSummary }

/** ExecuteCallView：execute 工具的子调用行——单行摘要，可展开输入明细。 */
function ExecuteCallView(props: { call: Accessor<ExecuteCall> }) {
  const theme = useTheme()
  const renderer = useRenderer()
  const [expanded, setExpanded] = createSignal(false)
  const [hover, setHover] = createSignal(false)
  const input = createMemo(() => Object.entries(props.call().input ?? {}))
  const expandable = createMemo(() => input().length > 0)
  const expandedColor = createMemo(() => theme.decrease(theme.text.muted))
  // 颜色：错误红 > 悬停亮 > 展开次暗 > 默认灰
  const color = createMemo(() => {
    if (props.call().status === "error") return theme.text.feedback.error.base
    if (hover()) return theme.text.base
    return expanded() ? expandedColor() : theme.text.muted
  })

  return (
    <box
      paddingLeft={3}
      onMouseOver={() => expandable() && setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => {
        if (!expandable() || renderer.getSelection()?.getSelectedText()) return
        setExpanded((value) => !value)
      }}
    >
      <box flexDirection="row">
        <box width={INLINE_TOOL_ICON_WIDTH} flexShrink={0}>
          <text fg={color()}>{props.call().status === "error" ? "✗" : "›"}</text>
        </box>
        <text flexGrow={1} wrapMode="none" truncate fg={color()}>
          {expanded() ? props.call().tool : executeCallSummary(props.call())}
        </text>
      </box>
      <Show when={expanded()}>
        <box paddingLeft={1} border={["left"]} borderColor={expandedColor()}>
          <For each={input()}>
            {([key, value]) => (
              <box flexDirection="row">
                <text flexShrink={0} fg={theme.text.muted}>
                  {key}:{" "}
                </text>
                <text flexGrow={1} wrapMode="word" fg={theme.text.base}>
                  {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>
    </box>
  )
}

// execute 工具通过元数据流式下发子工具调用，而不是像 Task 那样开子会话。
function Execute(props: ToolProps) {
  const ctx = use()
  const theme = useTheme()
  const dialog = useDialog()
  const isLoading = createMemo(() => props.part.state.status === "streaming" || props.part.state.status === "running")
  // 元数据里的子调用列表
  const calls = createMemo(() => executeCalls(props.metadata.toolCalls))
  const output = createMemo(() => stripAnsi(props.output?.trim() ?? ""))
  const hasRuntimeError = createMemo(() => props.metadata.error === true || props.part.state.status === "error")
  // 输出预览折叠为 4 行
  const outputPreview = createMemo(() => collapseToolOutput(output(), 4, 4 * Math.max(20, ctx.width - 6)).output)
  // 只有出错时才在行内显示输出预览
  const showOutput = createMemo(() => output() && hasRuntimeError())
  const openDetails = () => {
    // 对话框生命周期长于本行，重新同步可能使 props 过期，因此快照 part 传入。
    const part = props.part
    dialog.replace(() => <DialogExecute part={part} />)
  }

  return (
    <>
      <InlineTool
        icon={hasRuntimeError() ? "✗" : props.part.state.status === "completed" ? "✓" : "│"}
        color={hasRuntimeError() ? theme.text.feedback.error.base : undefined}
        spinner={isLoading()}
        pending="execute"
        complete={true}
        part={props.part}
        onClick={openDetails}
        onErrorClick={openDetails}
      >
        execute
      </InlineTool>
      {/* 逐个渲染子调用 */}
      <Index each={calls()}>{(call) => <ExecuteCallView call={call} />}</Index>
      <Show when={showOutput()}>
        <box paddingLeft={3}>
          <For each={outputPreview().split("\n")}>
            {(line, index) => (
              <text paddingLeft={3} fg={theme.text.feedback.error.base}>
                {index() === 0 ? "↳ " : "  "}
                {line}
              </text>
            )}
          </For>
        </box>
      </Show>
    </>
  )
}

/** Edit 工具渲染：编辑文件的 diff 块（统一/分栏视图），准备中显示占位标题。 */
function Edit(props: ToolProps) {
  const ctx = use()
  const theme = useTheme()
  const { currentSyntax: syntax } = useThemes()
  const pathFormatter = usePathFormatter()

  // diff 视图选择：配置优先；未配置时宽屏用分栏、窄屏用统一
  const view = createMemo(() => {
    const diffView = ctx.config.diffs?.view
    if (diffView === "unified") return "unified"
    if (diffView === "split") return "split"
    // 未配置时采用 auto 行为
    return ctx.width > 120 ? "split" : "unified"
  })

  const file = createMemo(() => parseApplyPatchFiles(props.metadata.files)[0])
  const path = createMemo(() => file()?.relativePath ?? stringValue(props.input.path))

  return (
    <Switch>
      {/* 已有补丁数据：渲染 diff */}
      <Match when={file()}>
        {(item) => (
          <BlockTool path={{ label: "← Edit", value: pathFormatter.format(path()) }} part={props.part}>
            <box paddingLeft={1} paddingRight={1}>
              <PatchDiff
                diff={item().patch}
                hunkFg={theme.diff.text.hunkHeader}
                view={view()}
                filetype={filetype(path())}
                syntaxStyle={syntax()}
                showLineNumbers={true}
                width="100%"
                wrapMode={ctx.diffWrapMode()}
                fg={theme.text.base}
                addedBg={theme.diff.background.added}
                removedBg={theme.diff.background.removed}
                contextBg={theme.diff.background.context}
                addedSignColor={theme.diff.highlight.added}
                removedSignColor={theme.diff.highlight.removed}
                lineNumberFg={theme.diff.lineNumber.text}
                lineNumberBg={theme.diff.background.context}
                addedLineNumberBg={theme.diff.lineNumber.background.added}
                removedLineNumberBg={theme.diff.lineNumber.background.removed}
              />
            </box>
            {/* 编辑后引入的诊断信息 */}
            <Diagnostics diagnostics={props.metadata.diagnostics} filePath={stringValue(props.input.path) ?? ""} />
          </BlockTool>
        )}
      </Match>
      {/* 尚无补丁：占位块，流式中显示 spinner */}
      <Match when={true}>
        <BlockTool
          path={
            stringValue(props.input.path)
              ? { label: "← Edit", value: pathFormatter.format(stringValue(props.input.path)) }
              : undefined
          }
          title={stringValue(props.input.path) ? undefined : "# Preparing edit…"}
          part={props.part}
          spinner={props.part.state.status === "streaming"}
        />
      </Match>
    </Switch>
  )
}

/** ApplyPatch 工具渲染：多文件补丁——每个目标文件一个块，删除文件只显示行数统计。 */
function ApplyPatch(props: ToolProps) {
  const ctx = use()
  const theme = useTheme()
  const { currentSyntax: syntax } = useThemes()
  const pathFormatter = usePathFormatter()
  // 元数据解析出的文件级补丁
  const files = createMemo(() => parseApplyPatchFiles(props.metadata.files))
  // 从补丁文本中提取目标文件名（Add/Update/Delete File 头）
  const targets = createMemo(() => {
    const patch = stringValue(props.input.patchText)
    if (!patch) return []
    return [...patch.matchAll(/\*\*\* (?:Add|Update|Delete) File: ([^\r\n]+)/g)].map((match) => match[1].trim())
  })
  // 已应用的资源清单（类型 + 资源标识）
  const applied = createMemo(() => {
    const applied = props.metadata.applied
    if (!Array.isArray(applied)) return []
    return applied.flatMap((value) => {
      const item = recordValue(value)
      const type = stringValue(item?.type)
      const resource = stringValue(item?.resource)
      return type && resource ? [{ type, resource }] : []
    })
  })
  // diff 视图选择：与 Edit 相同的策略
  const view = createMemo(() => {
    if (ctx.config.diffs?.view === "unified") return "unified"
    if (ctx.config.diffs?.view === "split") return "split"
    return ctx.width > 120 ? "split" : "unified"
  })

  return (
    <Switch>
      {/* 有文件级补丁：每个文件渲染一个块 */}
      <Match when={files().length > 0}>
        <box flexDirection="column" gap={1}>
          <For each={files()}>
            {(file) => (
              <BlockTool
                path={{
                  label: file.type === "add" ? "# Created" : file.type === "delete" ? "# Deleted" : "← Patched",
                  value: pathFormatter.format(file.relativePath),
                }}
                part={props.part}
              >
                <Show
                  when={file.type !== "delete"}
                  fallback={
                    // 删除文件：只显示删除行数
                    <text fg={theme.diff.text.removed}>
                      -{file.deletions} line{file.deletions !== 1 ? "s" : ""}
                    </text>
                  }
                >
                  <box paddingLeft={1} paddingRight={1}>
                    <PatchDiff
                      diff={file.patch}
                      hunkFg={theme.diff.text.hunkHeader}
                      view={view()}
                      filetype={filetype(file.relativePath)}
                      syntaxStyle={syntax()}
                      showLineNumbers={true}
                      width="100%"
                      wrapMode={ctx.diffWrapMode()}
                      fg={theme.text.base}
                      addedBg={theme.diff.background.added}
                      removedBg={theme.diff.background.removed}
                      contextBg={theme.diff.background.context}
                      addedSignColor={theme.diff.highlight.added}
                      removedSignColor={theme.diff.highlight.removed}
                      lineNumberFg={theme.diff.lineNumber.text}
                      lineNumberBg={theme.diff.background.context}
                      addedLineNumberBg={theme.diff.lineNumber.background.added}
                      removedLineNumberBg={theme.diff.lineNumber.background.removed}
                    />
                  </box>
                </Show>
              </BlockTool>
            )}
          </For>
        </box>
      </Match>
      {/* 退路：只有已应用资源清单时，按资源渲染简单块 */}
      <Match when={applied().length > 0}>
        <box flexDirection="column" gap={1}>
          <For each={applied()}>
            {(file) => (
              <BlockTool
                path={{
                  label: file.type === "add" ? "# Created" : file.type === "delete" ? "# Deleted" : "← Patched",
                  value: pathFormatter.format(file.resource),
                }}
                part={props.part}
              >
                <FilePath
                  value={file.resource}
                  maxWidth={Math.max(2, ctx.width - 5)}
                  fg={file.type === "delete" ? theme.diff.text.removed : theme.text.muted}
                />
              </BlockTool>
            )}
          </For>
        </box>
      </Match>
      {/* 补丁进行中/失败：单目标显示路径，多目标只显示标题 */}
      <Match when={true}>
        <BlockTool
          path={
            targets().length === 1
              ? {
                  label: props.part.state.status === "error" ? "# Patch failed" : "Patching",
                  value: pathFormatter.format(targets()[0]),
                }
              : undefined
          }
          title={
            targets().length === 1 ? undefined : props.part.state.status === "error" ? "# Patch failed" : "Patching"
          }
          part={props.part}
          spinner={props.part.state.status === "streaming" || props.part.state.status === "running"}
          headerColor={props.part.state.status === "error" ? theme.text.feedback.error.base : undefined}
          errorColor={props.part.state.status === "error" ? theme.text.muted : undefined}
        />
      </Match>
    </Switch>
  )
}

/** TodoWrite 工具渲染：完成后显示待办列表块，否则显示齿轮行。 */
function TodoWrite(props: ToolProps) {
  const theme = useTheme()
  const todos = createMemo(() => parseTodos(props.input.todos))
  return (
    <Switch>
      <Match when={props.part.state.status === "completed" && todos().length > 0}>
        <BlockTool title="# Todos" part={props.part}>
          <box>
            <For each={todos()}>{(todo) => <TodoItem theme={theme} todo={todo} />}</For>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool
          icon="⚙"
          pending="Updating todos…"
          complete={props.part.state.status === "completed" || props.part.state.status === "error"}
          part={props.part}
        >
          {props.part.state.status === "error" ? "Todo update failed" : "Cleared todos"}
        </InlineTool>
      </Match>
    </Switch>
  )
}

/** Question 工具渲染：已回答显示问答明细块；未回答显示提问行。 */
function Question(props: ToolProps) {
  const theme = useTheme()
  const questions = createMemo(() => parseQuestions(props.input.questions))
  const answers = createMemo(() => parseQuestionAnswers(props.metadata.answers))
  const count = createMemo(() => questions().length)

  // 答案数组转展示文案；空数组显示"(no answer)"
  function format(answer?: ReadonlyArray<string>) {
    if (!answer?.length) return "(no answer)"
    return answer.join(", ")
  }

  return (
    <Switch>
      <Match when={answers()}>
        <BlockTool title="# Questions" part={props.part}>
          <box gap={1}>
            <For each={questions()}>
              {(q, i) => (
                <box flexDirection="column">
                  <text fg={theme.text.muted}>{q.question}</text>
                  <text fg={theme.text.base}>{format(answers()?.[i()])}</text>
                </box>
              )}
            </For>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="→" pending="Asking questions…" complete={count()} part={props.part}>
          Asked {count()} question{count() !== 1 ? "s" : ""}
        </InlineTool>
      </Match>
    </Switch>
  )
}

/** Skill 工具渲染：技能加载行。 */
function Skill(props: ToolProps) {
  const name = createMemo(() => stringValue(props.metadata.name) ?? stringValue(props.input.id))
  return (
    <InlineTool icon="→" pending="Loading skill…" complete={name()} part={props.part}>
      Skill "{name()}"
    </InlineTool>
  )
}

/** Diagnostics：编辑后该文件的错误诊断列表（最多 3 条，只显示 severity=1 的错误）。 */
function Diagnostics(props: { diagnostics: unknown; filePath: string }) {
  const theme = useTheme()
  const terminalEnvironment = useTuiTerminalEnvironment()
  const errors = createMemo(() => {
    // 路径按平台归一化后作为元数据键取诊断
    const normalized = normalizePath(
      typeof props.filePath === "string" ? props.filePath : "",
      terminalEnvironment.platform,
    )
    return parseDiagnostics(props.diagnostics, normalized)
  })

  return (
    <Show when={errors().length}>
      <box>
        <For each={errors()}>
          {(diagnostic) => (
            <text fg={theme.text.feedback.error.base}>
              Error [{diagnostic.range.start.line + 1}:{diagnostic.range.start.character + 1}] {diagnostic.message}
            </text>
          )}
        </For>
      </box>
    </Show>
  )
}

// stringValue：未知值安全转字符串（非字符串返回 undefined）
function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined
}

// recordValue：未知值安全转普通对象
function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

/**
 * formatSessionTranscript：把会话导出为 markdown 文本（复制/保存共用）。
 * 用户消息为二级标题；shell 命令包代码块；助手内容拼接文本/思考/工具段。
 */
function formatSessionTranscript(
  session: SessionInfo,
  messages: SessionMessageInfo[],
  thinking: boolean,
  tools = true,
) {
  const body = messages.flatMap((message) => {
    if (message.type === "user") return [`## User\n\n${message.text}`]
    if (message.type === "shell")
      return [`## Shell\n\n\`\`\`\n$ ${message.command}\n${message.output?.output ?? ""}\n\`\`\``]
    if (message.type !== "assistant") return []
    const content = message.content.flatMap((item) => {
      if (item.type === "text") return [item.text]
      // 思考内容仅在开启时导出
      if (item.type === "reasoning") return thinking ? [`_Thinking:_\n\n${item.text}`] : []
      if (!tools) return []
      const input = typeof item.state.input === "string" ? item.state.input : JSON.stringify(item.state.input, null, 2)
      const output =
        item.state.status === "error"
          ? item.state.error.message
          : item.state.status === "streaming"
            ? ""
            : toolDisplayContent(item.state)
                .flatMap((entry) => (entry.type === "text" ? [entry.text] : [entry.name ?? entry.uri]))
                .join("\n")
      return [`**Tool: ${item.name}**\n\n**Input:**\n\`\`\`json\n${input}\n\`\`\`\n\n${output}`]
    })
    if (content.length === 0) return []
    return [`## Assistant\n\n${content.join("\n\n")}`]
  })
  // 头部：标题（失败时带时间戳兜底）、会话 ID 与创建/更新时间
  return `# ${withTimestampedFallback(session)}\n\n**Session ID:** ${session.id}\n**Created:** ${new Date(session.time.created).toLocaleString()}\n**Updated:** ${new Date(session.time.updated).toLocaleString()}\n\n---\n\n${body.join("\n\n---\n\n")}\n`
}

// parseApplyPatchFiles：从元数据解析补丁文件记录（type/path/patch/增删行数），字段不全则跳过。
export function parseApplyPatchFiles(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const file = recordValue(item)
    if (!file) return []
    const status = stringValue(file.status)
    const type =
      stringValue(file.type) ??
      (status === "added" ? "add" : status === "deleted" ? "delete" : status === "modified" ? "update" : undefined)
    const relativePath = stringValue(file.file) ?? stringValue(file.relativePath)
    const filePath = stringValue(file.filePath) ?? relativePath
    const patch = stringValue(file.patch)
    const additions = finiteNumber(file.additions)
    const deletions = finiteNumber(file.deletions)
    if (
      !type ||
      !relativePath ||
      !filePath ||
      patch === undefined ||
      additions === undefined ||
      deletions === undefined
    )
      return []
    return [{ type, relativePath, filePath, patch, additions, deletions, movePath: stringValue(file.movePath) }]
  })
}

// parseQuestions：解析问题列表（取 question 字段）
export function parseQuestions(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const question = stringValue(recordValue(item)?.question)
    return question ? [{ question }] : []
  })
}

// parseQuestionAnswers：解析答案列表——每题的答案数组只保留字符串
export function parseQuestionAnswers(value: unknown) {
  if (!Array.isArray(value)) return
  return value.map((answer) =>
    Array.isArray(answer) ? answer.filter((item): item is string => typeof item === "string") : [],
  )
}

// parseDiagnostics：按文件路径取诊断，只保留 error 级（severity=1）且带位置与消息的，最多 3 条。
export function parseDiagnostics(value: unknown, filePath: string) {
  const diagnostics = recordValue(value)?.[filePath]
  if (!Array.isArray(diagnostics)) return []
  return diagnostics
    .flatMap((item) => {
      const diagnostic = recordValue(item)
      const start = recordValue(recordValue(diagnostic?.range)?.start)
      const line = finiteNumber(start?.line)
      const character = finiteNumber(start?.character)
      const message = stringValue(diagnostic?.message)
      if (diagnostic?.severity !== 1 || line === undefined || character === undefined || !message) return []
      return [{ range: { start: { line, character } }, message }]
    })
    .slice(0, 3)
}
