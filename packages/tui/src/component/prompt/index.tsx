// 输入框组件（Prompt）：TUI 会话底部的消息输入区。
// 职责：多行文本编辑（opentui Textarea）、@文件/技能/代理与 /斜杠命令的自动补全、
// shell 模式切换、粘贴（文本/图片/路径）处理、草稿暂存与历史记录、
// 外部编辑器调用、ESC 双击中断、用量限额提示、排队/steer 投递等。
// 它通过 PromptRef 把"当前输入/模式/提交"等能力暴露给上层（会话页、全局快捷键）。
import {
  // BoxRenderable：基础盒子节点
  BoxRenderable,
  // RGBA：颜色类型
  RGBA,
  // TextareaRenderable：可编辑多行文本节点
  TextareaRenderable,
  // 终端鼠标与粘贴事件类型
  MouseEvent,
  PasteEvent,
  // decodePasteBytes：按编码解码粘贴的字节
  decodePasteBytes,
  // measureEditText：测量编辑文本宽度
  measureEditText,
  // stripAnsiSequences：去 ANSI 序列
  stripAnsiSequences,
  type KeyEvent,
} from "@opentui/core"
// SolidJS 响应式原语与控制流组件
import { createEffect, createMemo, onMount, createSignal, onCleanup, on, Show, Switch, Match, For } from "solid-js"
// path：路径处理（附件、目录）
import path from "path"
// 本地状态上下文（模型/代理/权限模式）
import { useLocal } from "../../context/local"
// 主题上下文（当前主题与全部主题）
import { useTheme, useThemes } from "../../context/theme"
// tint：颜色插值
import { tint } from "../../theme/color"
// 动画：可动画值与补间
import { createAnimatable, tween } from "../../ui/animation"
// 边框样式（空边框/分屏边框）
import { EmptyBorder, SplitBorder } from "../../ui/border"
// 运行时路径与终端环境
import { useTuiPaths, useTuiTerminalEnvironment } from "../../context/runtime"
// 剪贴板上下文
import { useClipboard } from "../../context/clipboard"
// Spinner：加载指示
import { Spinner } from "../spinner"
// 客户端/路由/输入框引用/会话标签/事件流等上下文
import { useClient } from "../../context/client"
import { useRoute } from "../../context/route"
import { usePromptRef } from "../../context/prompt"
import { useSessionTabs } from "../../context/session-tabs"
import { useEvent } from "../../context/event"
// 编辑器上下文与选区类型（外部编辑器集成）
import { editorSelectionKey, useEditorContext, type EditorSelection } from "../../context/editor"
// normalizePromptContent：规整输入内容；openEditor：调用外部编辑器
import { normalizePromptContent, openEditor } from "../../editor"
// 退出确认上下文
import { useExit } from "../../context/exit"
// @ 提及：展开粘贴文本与重排提及
import { expandPromptInputPastedText, realignPromptInputMentions } from "../../prompt/mention"
// parseSlashHead：解析斜杠命令头
import { parseSlashHead } from "../../prompt/parse"
// store 工具：createStore/produce/unwrap
import { createStore, produce, unwrap } from "solid-js/store"
// 输入历史：空输入构造、历史 hook 与类型
import { emptyPrompt, usePromptHistory, type PromptInfo, type PromptPartRef } from "../../prompt/history"
// 草稿暂存：注册 composer、保存/取回草稿
import { registerComposer, saveDraft, takeDraft } from "./draft-stash"
// Skill schema 类型
import { Skill } from "@opencode/schema/skill"
// computePromptTraits：计算输入特征（是否带附件等）
import { computePromptTraits } from "../../prompt/traits"
// 粘贴文本占位符展开
import { expandPastedTextPlaceholders, expandTrackedPastedText } from "../../prompt/part"
// 提示暂存箱（prompt stash）
import { usePromptStash } from "../../prompt/stash"
// 暂存箱对话框
import { DialogStash } from "../dialog-stash"
// 自动补全组件与选项类型
import { type AutocompleteOption, type AutocompleteRef, Autocomplete } from "./autocomplete"
// opentui/solid：渲染器与终端尺寸
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
// 文案与错误信息工具
import { Locale } from "../../util/locale"
import { errorMessage } from "../../util/error"
// spinner 颜色与帧
import { createColors, createFrames } from "../../ui/spinner"
// 对话框控制与集成登录对话框
import { useDialog } from "../../ui/dialog"
import { DialogIntegration } from "../dialog-integration"
// useConnected：连接状态
import { useConnected } from "../use-connected"
// toast 提示
import { useToast } from "../../ui/toast"
// createFadeIn：淡入信号
import { createFadeIn } from "../../util/signal"
// 技能详情对话框
import { DialogSkill } from "../dialog-skill"
// 配置与光标样式
import { useConfig, useCursorStyle } from "../../config"
// usePromptMove：输入框上下移动（多行导航）
import { usePromptMove } from "./move"
// 本地附件：服务端文件列表与粘贴附件解析
import { promptFilesForServer, resolvePastedAttachments } from "./local-attachment"
// 数据上下文（locationKey 标识目录）
import { locationKey, useData } from "../../context/data"
// 当前目录位置上下文
import { useLocation } from "../../context/location"
// 命令行参数
import { useArgs } from "../../context/args"
// 快捷键映射
import { Keymap, type KeymapCommand } from "../../context/keymap"
// 交互性上下文（鼠标可用性等）
import { useInteractivity } from "../../context/interactivity"
// abbreviateHome：把 HOME 缩写为 ~
import { abbreviateHome } from "../../runtime"
// 插件渲染插槽
import { Slot } from "../../plugin/render"
import type { SessionInbox } from "@opencode/schema/session-inbox"
// 附件工具：图片去重、无提及附件保留、附件标签
import {
  deduplicatePromptImages,
  preserveMentionlessPromptAttachments,
  promptAttachmentLabel,
} from "../../prompt/attachment"
// 图片预览对话框
import { DialogImagePreview } from "../dialog-image-preview"
// 目录最近记录（cd 补全）
import { useDirectoryRecents } from "../../prompt/directory-recents"
import { directoryRecentValue } from "../../prompt/directory-completion"
// 工作目录操作
import { useWorkingDirectoryActions } from "../../ui/working-directory-actions"
// truncateFilePath：按宽度截断路径
import { truncateFilePath } from "../../ui/file-path"
// 输入框元信息行（模型/代理/提示词）
import { PromptMetadataRow } from "./metadata"
// 用量限额提示
import { limitLabel, useUsageLimits } from "../usage"

// Prompt 组件属性
export type PromptProps = {
  // 绑定的会话 ID
  sessionID?: string
  // 是否可见
  visible?: boolean
  // 是否禁用（有覆盖 UI 时）
  disabled?: boolean
  // 是否静音（不抢焦点）
  muted?: boolean
  // 提交回调
  onSubmit?: () => void
  // 空提交回调（返回 true 表示已处理）
  onEmptySubmit?: () => boolean | Promise<boolean>
  // ref 暴露回调
  ref?: (ref: PromptRef | undefined) => void
  // 占位提示文案（普通/shell 模式）
  placeholders?: {
    normal?: string[]
    shell?: string[]
  }
}

// PromptRef：对外暴露的输入框能力（全局 promptRef 上下文持有）
export type PromptRef = {
  // 是否聚焦
  focused: boolean
  // 当前输入内容
  current: PromptInfo
  // 当前模式：普通/shell
  mode: "normal" | "shell"
  setMode(mode: "normal" | "shell"): void
  // 覆盖当前输入
  set(prompt: PromptInfo): void
  // 清空输入
  reset(): void
  blur(): void
  focus(): void
  // 提交当前输入
  submit(): void
}

// 草稿保留的最小字符数（太短的草稿不值得暂存）
const DRAFT_RETENTION_MIN_CHARS = 20
// 已展示过元信息行的输入对象集合（WeakSet，避免重复展示）
const revealedPromptMetadata = new WeakSet<object>()

// randomIndex：0..count-1 的随机索引（count<=0 时返回 0）
function randomIndex(count: number) {
  if (count <= 0) return 0
  return Math.floor(Math.random() * count)
}

/**
 * PromptInterruptStatus：esc 中断提示。
 * 第一次 esc 进入 armed（再按一次即中断），armed 触发时颜色闪光回落。
 */
export function PromptInterruptStatus(props: {
  armed: boolean
  animations?: boolean
  text: RGBA
  subdued: RGBA
  warning: RGBA
  flash?: RGBA
}) {
  // ignition：armed 触发时的"点火"动画值（0.75 -> 0）
  const ignition = createAnimatable(
    { level: 0 },
    { enabled: () => props.animations ?? false, transition: tween({ duration: 0.22 }) },
  )
  createEffect(
    on(
      () => props.armed,
      (armed) => {
        // 未开动画直接跳到 0；armed 时先跳高再回落，形成闪光
        if (!armed || !props.animations) return ignition.jump({ level: 0 })
        ignition.jump({ level: 0.75 })
        ignition.animate({ level: 0 })
      },
      { defer: true },
    ),
  )
  // armed 颜色：warning 与 flash 按 level 插值
  const armedColor = createMemo(() => {
    const level = ignition.value().level
    if (level === 0 || !props.flash) return props.warning
    return tint(props.warning, props.flash, level)
  })

  return (
    <text fg={props.armed ? armedColor() : props.text} wrapMode="none" truncate flexShrink={1}>
      esc{" "}
      <span style={{ fg: props.armed ? armedColor() : props.subdued }}>
        {props.armed ? "again to interrupt" : "interrupt"}
      </span>
    </text>
  )
}

// hasEditorRangeSelection：编辑器选区是否为真正的范围选择（跨行或跨字符）
function hasEditorRangeSelection(selection: EditorSelection["ranges"][number]) {
  return (
    selection.selection.start.line !== selection.selection.end.line ||
    selection.selection.start.character !== selection.selection.end.character
  )
}

// getEditorRangeLabel：范围选择的展示标签（#行 或 #起-止）
function getEditorRangeLabel(selection: EditorSelection["ranges"][number]) {
  if (!hasEditorRangeSelection(selection)) return
  if (selection.selection.start.line === selection.selection.end.line) return `#${selection.selection.start.line}`
  return `#${selection.selection.start.line}-${selection.selection.end.line}`
}

// formatEditorContext：把外部编辑器中打开/选中的内容格式化为 system-reminder 附加上下文。
function formatEditorContext(selection: EditorSelection) {
  const selected = selection.ranges.filter(hasEditorRangeSelection)
  // 无范围选择：只提示用户打开了该文件
  if (selected.length === 0)
    return `<system-reminder>Note: The user opened the file "${selection.filePath}". This may or may not be relevant to the current task.</system-reminder>\n`

  // 有范围选择：逐个列出选中文本
  const ranges = selected.map((range, index) => {
    const prefix = selected.length > 1 ? `Selection ${index + 1}: ` : ""
    return `Note: The user selected ${prefix}${getEditorRangeLabel(range)} from "${selection.filePath}". \`\`\`${range.text}\`\`\`\n\n`
  })

  return `<system-reminder>${ranges.join("\n")} This may or may not be relevant to the current task.</system-reminder>\n`
}

// argumentSlash：解析 "/命令 参数" 形式输入——返回匹配的带参命令与参数串
function argumentSlash(input: string, commands: readonly KeymapCommand[]) {
  const head = parseSlashHead(input, /\s/)
  if (!head) return
  const command = commands.find(
    (command) =>
      command.slash?.arguments &&
      (command.slash.name === head.name || command.slash.aliases?.includes(head.name) === true),
  )
  if (!command) return
  return { command, input: head.arguments }
}

/**
 * Prompt：终端输入框主组件。
 * 组合底层 Textarea（编辑）、Autocomplete（补全）、历史/草稿/暂存、
 * 附件与粘贴处理、shell 模式、cd 命令、外部编辑器上下文、限额提示等。
 * 通过 props.ref 把 PromptRef 暴露给上层。
 */
export function Prompt(props: PromptProps) {
  // 底层文本编辑节点与锚点节点（JSX ref 绑定）
  let input: TextareaRenderable
  let anchor: BoxRenderable
  // 编辑节点信号（供自动补全/测量使用）
  const [inputTarget, setInputTarget] = createSignal<TextareaRenderable | undefined>()

  // 交互性上下文：不可交互（如管道模式）时整体禁用
  const enabled = useInteractivity()
  const disabled = () => props.disabled || !enabled()
  // leader 键激活或显式 muted 时输入框静音（不抢焦点）
  const leader = Keymap.useLeaderActive()
  const muted = () => leader() || props.muted
  // 各类上下文
  const local = useLocal()
  const paths = useTuiPaths()
  const terminalEnvironment = useTuiTerminalEnvironment()
  const clipboard = useClipboard()
  const client = useClient()
  const editor = useEditorContext()
  const route = useRoute()
  const promptRef = usePromptRef()
  const sessionTabs = useSessionTabs()
  const data = useData()
  const directoryRecents = useDirectoryRecents()
  const keymapCommands = Keymap.useCommands()
  const currentLocation = useLocation()
  const args = useArgs()
  const config = useConfig().data
  const cursorStyle = useCursorStyle()
  const dialog = useDialog()
  const toast = useToast()
  // 会话运行状态（busy/…）
  const status = createMemo(() => data.session.status(props.sessionID ?? ""))
  // 输入历史与暂存箱
  const history = usePromptHistory()
  const stash = usePromptStash()
  const keymap = Keymap.use()
  const renderer = useRenderer()
  // measure：按渲染器的宽度算法测量文本宽
  const measure = (text: string) => measureEditText(text, { widthMethod: renderer.widthMethod })
  const exit = useExit()
  const dimensions = useTerminalDimensions()
  const theme = useTheme()
  const { currentSyntax: syntax } = useThemes()
  const animationsEnabled = createMemo(() => config.animations ?? true)
  // 占位文案（普通/shell）
  const list = createMemo(() => props.placeholders?.normal ?? [])
  const shell = createMemo(() => props.placeholders?.shell ?? [])
  // 是否注入外部编辑器的文件上下文
  const fileContextEnabled = createMemo(() => config.prompt?.editor ?? true)
  // 用户已忽略的编辑器选区 key（点击 X 后不再提示同一选区）
  const [dismissedEditorSelectionKey, setDismissedEditorSelectionKey] = createSignal<string>()
  // 有效的编辑器上下文（被忽略的选区视为无）
  const editorContext = createMemo(() => {
    const selection = fileContextEnabled() ? editor.selection() : undefined
    if (!selection) return
    return editorSelectionKey(selection) === dismissedEditorSelectionKey() ? undefined : selection
  })
  const editorPath = createMemo(() => editorContext()?.filePath)
  // 选区标签：首个范围标签 + 多选时附加 +N
  const editorSelectionLabel = createMemo(() => {
    const ranges = editorContext()?.ranges
    if (!ranges) return
    const first = ranges.find(hasEditorRangeSelection) ?? ranges[0]
    if (!first) return
    return [getEditorRangeLabel(first), ranges.length > 1 ? `+${ranges.length - 1}` : undefined]
      .filter(Boolean)
      .join(" ")
  })
  // 文件标签：index 文件补上级目录名，统一分隔符并拼上选区标签
  const editorFileLabel = createMemo(() => {
    const value = editorPath()
    if (!value) return
    const filename = path.basename(value)
    const file = /^index\.[^./]+$/.test(filename)
      ? [path.basename(path.dirname(value)), filename].filter(Boolean).join("/")
      : filename
    return `${file.split(path.sep).join("/")}${editorSelectionLabel() ?? ""}`
  })
  // 按终端宽度截中展示的文件标签
  const editorFileLabelDisplay = createMemo(() => {
    const file = editorFileLabel()
    if (!file) return
    return Locale.truncateMiddle(file, Math.max(12, Math.min(48, Math.floor(dimensions().width / 3))))
  })
  const editorContextLabelState = createMemo(() => editor.labelState())
  // 自动补全 ref
  const [auto, setAuto] = createSignal<AutocompleteRef>()
  // 输入上下移动（多行时上/下键行为）
  const move = usePromptMove({
    projectID: () =>
      (props.sessionID ? data.session.get(props.sessionID)?.projectID : undefined) ?? data.location.info()?.project.id,
    sessionID: () => props.sessionID,
  })
  // cd 切换目录进行中的目标目录（用于显示加载态）
  const [pendingDirectory, setPendingDirectory] = createSignal<string>()
  // /cd 命令：无会话时切换全局位置；有会话时移动会话目录
  Keymap.createLayer(() => ({
    mode: "global",
    enabled: !disabled(),
    commands: [
      {
        id: "session.cd",
        title: "Change working directory",
        slash: { name: "cd", arguments: true },
        run: async (input) => {
          if (!input?.trim()) {
            toast.show({ message: "Directory is required", variant: "error" })
            return
          }
          const sessionID = props.sessionID
          const session = sessionID ? data.session.get(sessionID) : undefined
          const sourceProjectID = session?.projectID ?? data.location.info()?.project.id
          const value = input.trim()
          // 展开 ~ 与 ~/ 前缀为家目录
          const expanded =
            value === "~" ? paths.home : value.startsWith("~/") ? path.join(paths.home, value.slice(2)) : value
          // 相对当前会话/全局/默认目录解析为绝对路径
          const directory = path.resolve(
            session?.location.directory ?? currentLocation.current?.directory ?? data.location.default().directory,
            expanded,
          )
          // 无会话：直接切换全局位置
          if (!sessionID) {
            setPendingDirectory(directory)
            const location = await client.api.location.get({ location: { directory } }).catch((error) => {
              toast.show({ title: "Failed to change directory", message: errorMessage(error), variant: "error" })
              return undefined
            })
            if (!location) {
              setPendingDirectory(undefined)
              return
            }
            // 记入目录最近使用并应用新位置
            if (sourceProjectID) directoryRecents.touch(sourceProjectID, location.directory)
            currentLocation.set(location)
            setPendingDirectory(undefined)
            return
          }
          // 有会话：移动会话目录（服务端处理）
          const error = await client.api.session.move({ sessionID, directory: input }).then(
            () => undefined,
            (error) => error,
          )
          if (error) {
            toast.show({ title: "Failed to change directory", message: errorMessage(error), variant: "error" })
            return
          }
          if (sourceProjectID) directoryRecents.touch(sourceProjectID, directory)
        },
      },
    ],
  }))
  // 光标版本号：用于触发光标相关重算
  const [cursorVersion, setCursorVersion] = createSignal(0)
  const connected = useConnected()

  // promptModelWarning：未连接任何集成时提示无法发送
  function promptModelWarning() {
    toast.show({
      variant: "warning",
      message: "Connect an integration to send prompts",
      duration: 3000,
    })
    if (!connected()) {
      // 未连接服务器时直接打开集成登录对话框
      dialog.replace(() => <DialogIntegration />)
    }
  }

  // dismissEditorContext：忽略当前编辑器上下文并清空编辑器选区
  function dismissEditorContext() {
    setDismissedEditorSelectionKey(editorSelectionKey(editorContext()))
    editor.clearSelection()
  }
  // 各类 extmark（行内标记）的样式 ID（文件/代理/技能/粘贴占位）
  const fileStyleId = syntax().getStyleId("extmark.file")!
  const agentStyleId = syntax().getStyleId("extmark.agent")!
  const skillStyleId = syntax().getStyleId("extmark.skill")!
  const pasteStyleId = syntax().getStyleId("extmark.paste")!
  // 输入分片类型自增 ID
  let promptPartTypeId = 0
  const event = useEvent()

  // tui.prompt.append 事件：外部（如 go 版或插件）向输入框追加文本，仅限当前目录
  event.on("tui.prompt.append", (evt, { directory }) => {
    if (directory !== (currentLocation.current?.directory ?? data.location.default().directory)) return
    if (!input || input.isDestroyed) return
    input.insertText(evt.data.text)
    setTimeout(() => {
      // setTimeout 是临时方案，后续需要正式处理
      if (!input || input.isDestroyed) return
      input.invalidateIntrinsicSize()
      input.gotoBufferEnd()
      renderer.requestRender()
    }, 0)
  })

  // 光标颜色随禁用态切换（禁用时与背景同色，等于隐藏）
  createEffect(() => {
    if (!input || input.isDestroyed) return
    input.cursorColor = disabled() ? theme.background.raised.base : theme.text.base
  })

  // 输入框核心状态：内容、模式、extmark->分片映射、中断计数、占位索引
  const [store, setStore] = createStore<{
    prompt: PromptInfo
    mode: "normal" | "shell"
    extmarkToPart: Map<number, PromptPartRef>
    interrupt: number
    placeholder: number
  }>({
    placeholder: randomIndex(list().length),
    prompt: emptyPrompt(),
    mode: "normal",
    extmarkToPart: new Map(),
    interrupt: 0,
  })
  // 组件销毁标记与粘贴任务串行队列
  let disposed = false
  let pasteQueue = Promise.resolve()

  // enqueuePaste：把粘贴处理排入串行队列；changed() 在输入框状态已变时返回 true，
  // 让异步处理（如读取附件）放弃过期结果。
  function enqueuePaste(run: (changed: () => boolean) => Promise<void>) {
    pasteQueue = pasteQueue
      .then(async () => {
        if (disposed || input.isDestroyed || disabled()) return
        const before = { sessionID: props.sessionID, mode: store.mode, text: input.plainText }
        await run(
          () =>
            disposed ||
            input.isDestroyed ||
            disabled() ||
            props.sessionID !== before.sessionID ||
            store.mode !== before.mode ||
            input.plainText !== before.text,
        )
      })
      .catch((error) => {
        if (!disposed) toast.error(error)
      })
    return pasteQueue
  }

  // 图片附件（去重后仅保留 data URI 图片）
  const imageAttachments = createMemo(() =>
    (deduplicatePromptImages(store.prompt.files) ?? []).filter((file) => file.uri.startsWith("data:image/")),
  )
  // 预览缩略图尺寸（高度 4-8 行，宽高比 2:1）
  const imagePreviewHeight = createMemo(() => Math.max(4, Math.min(8, Math.floor(dimensions().height / 4))))
  const imagePreviewWidth = createMemo(() => imagePreviewHeight() * 2)
  const visibleImageAttachments = createMemo(() => imageAttachments().slice(0, 3))

  // openImagePreview：打开图片预览对话框
  function openImagePreview(initial: number) {
    const images = imageAttachments()
    if (images.length === 0) return
    dialog.replace(() => <DialogImagePreview images={images} initial={initial} />)
  }

  // 会话切换时随机换一个占位文案
  createEffect(
    on(
      () => props.sessionID,
      () => {
        setStore("placeholder", randomIndex(list().length))
      },
      { defer: true },
    ),
  )

  // 输入框相关命令（命令面板可见）
  const promptCommands = createMemo(() =>
    [
      {
        // 清空输入
        title: "Clear prompt",
        name: "prompt.clear",
        category: "Prompt",
        palette: undefined,
        run: () => {
          clearPrompt()
          dialog.clear()
        },
      },
      {
        // 提交输入
        title: "Submit prompt",
        name: "prompt.submit",
        category: "Prompt",
        palette: undefined,
        run: async (_input: string | undefined, event?: KeyEvent) => {
          event?.preventDefault()
          event?.stopPropagation()
          if (!input.focused) return
          const handled = await submit()
          if (!handled) return

          dialog.clear()
        },
      },
      {
        // 排队提交（busy 时入队）
        title: "Queue prompt",
        name: "prompt.queue",
        category: "Prompt",
        run: async (_input: string | undefined, event?: KeyEvent) => {
          event?.preventDefault()
          event?.stopPropagation()
          if (!input.focused) return
          // 自动补全可见且当前命令不可排队时不处理
          if (auto()?.visible && !auto()?.completeQueueableCommand()) return
          const handled = await submit("queue")
          if (!handled) return
          dialog.clear()
        },
      },
      {
        // 移除编辑器上下文
        title: "Remove editor context",
        name: "prompt.editor_context.clear",
        category: "Prompt",
        enabled: Boolean(editorContext()),
        run: () => {
          dismissEditorContext()
          dialog.clear()
        },
      },
      {
        // 粘贴：图片作为附件、纯文本走文本粘贴
        title: "Paste",
        name: "prompt.paste",
        category: "Prompt",
        palette: undefined,
        run: (_input: string | undefined, event?: KeyEvent) => {
          event?.preventDefault()
          event?.stopPropagation()
          return enqueuePaste(async (changed) => {
            const content = await clipboard.read()
            if (changed()) return
            if (content?.mime.startsWith("image/")) {
              pasteAttachment({
                filename: "clipboard",
                uri: `data:${content.mime};base64,${content.data}`,
              })
              return
            }
            if (content?.mime === "text/plain") {
              await pasteInputText(content.data, changed)
            }
          })
        },
      },
      {
        // 查看图片附件
        title: "View image attachments",
        name: "prompt.images.view",
        category: "Prompt",
        enabled: imageAttachments().length > 0,
        run: () => openImagePreview(0),
      },
      {
        // 中断会话：shell 模式先退回普通模式；普通模式双击 esc 触发
        title: "Interrupt session",
        name: "session.interrupt",
        category: "Session",
        palette: undefined,
        enabled: status() === "running",
        run: () => {
          if (auto()?.visible) return
          if (!input.focused) return
          // TODO: 这应该是独立的命令
          if (store.mode === "shell") {
            setStore("mode", "normal")
            return
          }
          if (!props.sessionID) return

          setStore("interrupt", store.interrupt + 1)

          // 5 秒后自动复位中断计数
          setTimeout(() => {
            setStore("interrupt", 0)
          }, 5000)

          // 5 秒内按两次即真正中断
          if (store.interrupt >= 2) {
            void client.api.session.interrupt({
              sessionID: props.sessionID,
              resume: true,
            })
            setStore("interrupt", 0)
          }
          dialog.clear()
        },
      },
      {
        // 把阻塞工具转入后台
        title: "Background blocking tools",
        name: "session.background",
        category: "Session",
        palette: undefined,
        enabled: status() === "running",
        run: () => {
          if (auto()?.visible) return
          if (!input.focused) return
          if (!props.sessionID) return

          void client.api.session.background({
            sessionID: props.sessionID,
          })
          dialog.clear()
        },
      },
      {
        // 在外部编辑器中编辑当前输入
        title: "Open editor",
        category: "Session",
        name: "prompt.editor",
        slash: { name: "editor" },
        run: async () => {
          dialog.clear()

          // 展开粘贴占位后交给编辑器
          const editorPrompt = expandPromptInputPastedText(store.prompt, store.prompt.pasted, renderer.widthMethod)
          const value = editorPrompt.text
          const content = await openEditor({
            renderer,
            value,
            cwd:
              (data.location.info()?.project.directory === "/" ? undefined : data.location.info()?.project.directory) ||
              data.location.default().directory ||
              paths.cwd,
          }).catch((error) => {
            toast.show({ title: "Failed to open editor", message: errorMessage(error), variant: "error" })
          })
          if (!content) return
          // 规整编辑结果（去尾随空白等）
          const normalized = normalizePromptContent(content)

          input.setText(normalized)

          // 按新文本重排提及并把粘贴占位清空（已在编辑器中展开）
          setStore("prompt", {
            ...realignPromptInputMentions(normalized, editorPrompt, renderer.widthMethod),
            pasted: [],
          })
          restoreExtmarksFromPrompt(store.prompt)
          input.cursorOffset = measure(normalized)
        },
      },
      {
        // 技能选择对话框：选择后插入 @skill 提及
        title: "Skills",
        name: "prompt.skills",
        category: "Prompt",
        slash: { name: "skills" },
        run: () => {
          dialog.replace(() => (
            <DialogSkill
              location={currentLocation.ref}
              onSelect={(skill) => {
                // 已存在的技能不重复添加
                if (store.prompt.skills?.some((item) => item.id === skill)) return
                const text = `@${skill}`
                const start = input.cursorOffset
                const end = start + measure(text)
                input.insertText(text + " ")
                // 创建虚拟 extmark 并登记分片映射
                const extmarkId = input.extmarks.create({
                  start,
                  end,
                  virtual: true,
                  styleId: skillStyleId,
                  typeId: promptPartTypeId,
                })
                setStore(
                  produce((draft) => {
                    draft.prompt.text = input.plainText
                    const skills = (draft.prompt.skills ??= [])
                    const index = skills.length
                    skills.push({
                      id: Skill.ID.make(skill),
                      mention: { start, end, text },
                    })
                    draft.extmarkToPart.set(extmarkId, { type: "skill", index })
                  }),
                )
              }}
            />
          ))
        },
      },
      {
        // 打开工作区（worktree）管理
        title: "Manage workspaces",
        desc: "Manage workspaces",
        name: "session.move",
        category: "Session",
        slash: { name: "worktrees" },
        run: () => {
          move.open()
        },
      },
    ].map(
      // 归一化为 KeymapCommand（id=命令名，group=类别，面板可见但不直接绑定按键）
      ({ name, category, ...command }) =>
        ({
          id: name,
          group: category,
          bind: false,
          palette: true as const,
          ...command,
        }) satisfies KeymapCommand,
    ),
  )

  // 快捷键层：全局模式注册全部输入框命令
  Keymap.createLayer(() => ({
    mode: "global",
    enabled: !disabled(),
    commands: promptCommands(),
  }))

  // 快捷键层：prompt.queue 高优先级绑定（排队提交）
  Keymap.createLayer(() => ({
    priority: 1,
    enabled: !disabled(),
    bindings: ["prompt.queue"],
  }))

  // 快捷键层：其余输入框命令的按键绑定
  Keymap.createLayer(() => ({
    enabled: !disabled(),
    bindings: [
      "prompt.submit",
      "prompt.editor",
      "prompt.editor_context.clear",
      "prompt.images.view",
      "prompt.stash",
      "prompt.stash.pop",
      "prompt.stash.list",
      "prompt.skills",
      "session.interrupt",
      "session.background",
      "session.move",
    ],
  }))

  // ref：暴露给上层的 PromptRef
  const ref: PromptRef = {
    get focused() {
      return !disabled() && input.focused
    },
    get current() {
      return store.prompt
    },
    get mode() {
      return store.mode
    },
    focus() {
      if (disabled()) return
      input.focus()
    },
    blur() {
      input.blur()
    },
    setMode(mode) {
      setStore("mode", mode)
    },
    set(prompt) {
      // 覆盖输入并重建 extmark
      input.setText(prompt.text)
      setStore("prompt", prompt)
      restoreExtmarksFromPrompt(prompt)
      input.gotoBufferEnd()
    },
    reset() {
      resetComposer()
    },
    submit() {
      void submit()
    },
  }

  // resetComposer：清空 extmark、内容与分片映射
  function resetComposer() {
    input.extmarks.clear()
    setStore("prompt", emptyPrompt())
    setStore("extmarkToPart", new Map())
    input.clear()
  }

  // 只捕获一次：会话路由以 sessionID 为键，本 Prompt 实例只属于一个标签页。
  // 若在 onCleanup 里惰性读取 props.sessionID，会读到下一条路由，把草稿存错标签。
  const stashSessionID = props.sessionID

  onMount(() => {
    // 注册到全局 composer 注册表，并在卸载时注销
    onCleanup(registerComposer(stashSessionID, ref))
    // 挂载时取回上次暂存的草稿（当前已有内容则不覆盖）
    const saved = takeDraft(stashSessionID)
    if (store.prompt.text) return
    if (saved && saved.prompt.text) {
      input.setText(saved.prompt.text)
      setStore("prompt", saved.prompt)
      restoreExtmarksFromPrompt(saved.prompt)
      input.cursorOffset = Math.min(saved.cursor, measure(saved.prompt.text))
    }
  })

  onCleanup(() => {
    disposed = true
    // 还有内容时把草稿与光标位置暂存
    if (store.prompt.text) {
      saveDraft(stashSessionID, { prompt: unwrap(store.prompt), cursor: input.cursorOffset })
    }
    setInputTarget(undefined)
    props.ref?.(undefined)
  })

  // 焦点管理：不可见/禁用/有对话框时失焦并禁止聚焦；否则自动取回焦点
  createEffect(() => {
    if (!input || input.isDestroyed) return
    if (props.visible === false || disabled() || dialog.stack.length > 0) {
      if (input.focused) input.blur()
      input.focusable = false
      return
    }

    input.focusable = true
    // 对话框打开期间，Slot/插件更新可能重挂载后台的输入框。
    // 焦点让给对话框，对话框关闭后输入框再取回。
    if (!input.focused) input.focus()
  })

  // 同步输入特征（模式/补全可见性），供快捷键层判断行为
  createEffect(() => {
    if (!input || input.isDestroyed) return
    input.traits = {
      ...input.traits,
      ...computePromptTraits({
        mode: store.mode,
        autocompleteVisible: !!auto()?.visible,
      }),
    }
  })

  // restoreExtmarksFromPrompt：按输入内容重建全部虚拟 extmark（文件/代理/技能/粘贴占位）
  function restoreExtmarksFromPrompt(prompt: PromptInfo) {
    input.extmarks.clear()
    setStore("extmarkToPart", new Map())

    // 汇总所有带提及区间的分片
    const parts = [
      ...(prompt.files ?? []).map((part, index) => ({
        mention: part.mention,
        ref: { type: "file" as const, index },
        styleId: fileStyleId,
      })),
      ...(prompt.agents ?? []).map((part, index) => ({
        mention: part.mention,
        ref: { type: "agent" as const, index },
        styleId: agentStyleId,
      })),
      ...(prompt.skills ?? []).map((part, index) => ({
        mention: part.mention,
        ref: { type: "skill" as const, index },
        styleId: skillStyleId,
      })),
      ...prompt.pasted.map((part, index) => ({
        mention: part.source,
        ref: { type: "pasted" as const, index },
        styleId: pasteStyleId,
      })),
    ]

    parts.forEach(({ mention, ref, styleId }) => {
      if (mention?.text) {
        const extmarkId = input.extmarks.create({
          start: mention.start,
          end: mention.end,
          virtual: true,
          styleId,
          typeId: promptPartTypeId,
        })
        // 映射表也用不可变更新，触发依赖响应
        setStore("extmarkToPart", (map: Map<number, PromptPartRef>) => {
          const newMap = new Map(map)
          newMap.set(extmarkId, ref)
          return newMap
        })
      }
    })
  }

  // syncExtmarksWithPromptParts：编辑后按 extmark 实际区间重排各类分片并重建映射。
  // 分片按 extmark 在文档中的顺序重新编号，文件还需保留无提及的附件。
  function syncExtmarksWithPromptParts() {
    const allExtmarks = input.extmarks.getAllForTypeId(promptPartTypeId)
    setStore(
      produce((draft) => {
        const newMap = new Map<number, PromptPartRef>()
        const fileExtmarks = new Map<number, NonNullable<PromptInfo["files"]>[number]>()
        const files: NonNullable<PromptInfo["files"]> = []
        const agents: NonNullable<PromptInfo["agents"]> = []
        const skills: NonNullable<PromptInfo["skills"]> = []
        const pasted: PromptInfo["pasted"] = []

        // 遍历所有输入分片 extmark，把分片写回对应数组并更新提及区间
        for (const extmark of allExtmarks) {
          const ref = draft.extmarkToPart.get(extmark.id)
          if (!ref) continue
          if (ref.type === "file") {
            const part = draft.prompt.files?.[ref.index]
            if (!part?.mention) continue
            part.mention.start = extmark.start
            part.mention.end = extmark.end
            files.push(part)
            fileExtmarks.set(extmark.id, part)
            continue
          }
          if (ref.type === "agent") {
            const part = draft.prompt.agents?.[ref.index]
            if (!part?.mention) continue
            part.mention.start = extmark.start
            part.mention.end = extmark.end
            const index = agents.length
            agents.push(part)
            newMap.set(extmark.id, { type: "agent", index })
            continue
          }
          if (ref.type === "skill") {
            const part = draft.prompt.skills?.[ref.index]
            if (!part?.mention) continue
            part.mention.start = extmark.start
            part.mention.end = extmark.end
            const index = skills.length
            skills.push(part)
            newMap.set(extmark.id, { type: "skill", index })
            continue
          }
          const part = draft.prompt.pasted[ref.index]
          if (!part) continue
          part.source.start = extmark.start
          part.source.end = extmark.end
          const index = pasted.length
          pasted.push(part)
          newMap.set(extmark.id, { type: "pasted", index })
        }

        // 文件分片要保留"无提及"的附件（如粘贴图片），再对齐 extmark 索引
        const nextFiles = preserveMentionlessPromptAttachments(draft.prompt.files, files)
        const fileIndices = new Map(nextFiles.map((file, index) => [file, index]))
        for (const [extmark, file] of fileExtmarks) {
          const index = fileIndices.get(file)
          if (index !== undefined) newMap.set(extmark, { type: "file", index })
        }

        // 写回映射与分片数组（文件数组只在变化时写，避免无谓刷新）
        draft.extmarkToPart = newMap
        if (
          nextFiles.length !== draft.prompt.files?.length ||
          nextFiles.some((file, index) => file !== draft.prompt.files?.[index])
        )
          draft.prompt.files = nextFiles
        draft.prompt.agents = agents
        draft.prompt.skills = skills
        draft.prompt.pasted = pasted
      }),
    )
  }

  // 暂存箱命令：存/取/列出暂存的提示
  const stashCommands = createMemo(() =>
    [
      {
        // 暂存当前输入并清空
        title: "Stash prompt",
        name: "prompt.stash",
        category: "Prompt",
        enabled: !!store.prompt.text,
        run: () => {
          if (!store.prompt.text) return
          stash.push({ prompt: store.prompt })
          resetComposer()
          dialog.clear()
        },
      },
      {
        // 弹出最近暂存
        title: "Stash pop",
        name: "prompt.stash.pop",
        category: "Prompt",
        enabled: stash.list().length > 0,
        run: () => {
          const entry = stash.pop()
          if (entry) {
            input.setText(entry.prompt.text)
            setStore("prompt", entry.prompt)
            restoreExtmarksFromPrompt(entry.prompt)
            input.gotoBufferEnd()
          }
          dialog.clear()
        },
      },
      {
        // 打开暂存列表对话框
        title: "Stash list",
        name: "prompt.stash.list",
        category: "Prompt",
        enabled: stash.list().length > 0,
        run: () => {
          dialog.replace(() => (
            <DialogStash
              onSelect={(entry) => {
                input.setText(entry.prompt.text)
                setStore("prompt", entry.prompt)
                restoreExtmarksFromPrompt(entry.prompt)
                input.gotoBufferEnd()
              }}
            />
          ))
        },
      },
    ].map(
      ({ name, category, ...command }) =>
        ({
          id: name,
          group: category,
          bind: false,
          palette: true as const,
          ...command,
        }) satisfies KeymapCommand,
    ),
  )

  // 暂存命令的快捷键层
  Keymap.createLayer(() => ({
    mode: "global",
    enabled: !disabled(),
    commands: stashCommands(),
  }))

  // 粘贴快捷键绑定到输入框节点
  Keymap.createLayer(() => {
    return {
      target: inputTarget,
      enabled: inputTarget() !== undefined && !disabled(),
      bindings: ["prompt.paste"],
    }
  })

  // 清空快捷键：仅在有内容时启用
  Keymap.createLayer(() => {
    return {
      target: inputTarget,
      enabled: inputTarget() !== undefined && !disabled() && store.prompt.text !== "",
      bindings: ["prompt.clear"],
    }
  })

  // shell 模式：光标在行首时输入 ! 进入
  Keymap.createLayer(() => {
    return {
      target: inputTarget,
      enabled: (() => {
        cursorVersion()
        return (
          inputTarget() !== undefined &&
          !disabled() &&
          store.mode === "normal" &&
          !auto()?.visible &&
          input?.visualCursor.offset === 0
        )
      })(),
      commands: [
        {
          bind: "!",
          title: "Shell mode",
          group: "Prompt",
          run: () => {
            setStore("placeholder", randomIndex(shell().length))
            setStore("mode", "shell")
          },
        },
      ],
    }
  })

  // shell 模式退出：escape 或内容为空时的 ctrl+c
  Keymap.createLayer(() => {
    return {
      priority: 1,
      target: inputTarget,
      enabled: inputTarget() !== undefined && !disabled() && store.mode === "shell",
      commands: [
        { bind: "escape", title: "Exit shell mode", group: "Prompt", run: () => setStore("mode", "normal") },
        {
          bind: "ctrl+c",
          title: "Exit shell mode",
          group: "Prompt",
          enabled: () => store.prompt.text === "",
          run: () => setStore("mode", "normal"),
        },
      ],
    }
  })

  // shell 模式：行首按退格也退出
  Keymap.createLayer(() => {
    return {
      target: inputTarget,
      enabled: (() => {
        cursorVersion()
        return inputTarget() !== undefined && !disabled() && store.mode === "shell" && input?.visualCursor.offset === 0
      })(),
      commands: [
        { bind: "backspace", title: "Exit shell mode", group: "Prompt", run: () => setStore("mode", "normal") },
      ],
    }
  })

  // 历史上一条：光标不在开头时先做光标上移（多行），在开头才翻历史
  Keymap.createLayer(() => {
    return {
      priority: 1,
      target: inputTarget,
      enabled: (() => {
        cursorVersion()
        return inputTarget() !== undefined && !disabled() && !auto()?.visible && input !== undefined
      })(),
      commands: [
        {
          id: "prompt.history.previous",
          title: "Previous prompt history",
          group: "Prompt",
          run() {
            if (input.cursorOffset !== 0) {
              // 已在首行则把光标移到文本开头，否则上移一行
              if (input.scrollY + input.visualCursor.visualRow === 0) {
                input.cursorOffset = 0
                return
              }
              input.moveCursorUp()
              return
            }

            // 光标在开头：取上一条历史
            const item = history.move(-1, input.plainText)
            if (!item) return false
            input.setText(item.text)
            setStore("prompt", item)
            setStore("mode", item.mode ?? "normal")
            restoreExtmarksFromPrompt(item)
            input.cursorOffset = 0
          },
        },
      ],
    }
  })

  // 历史下一条：光标不在末尾时先做光标下移（多行），在末尾才翻历史
  Keymap.createLayer(() => {
    return {
      priority: 1,
      target: inputTarget,
      enabled: (() => {
        cursorVersion()
        return inputTarget() !== undefined && !disabled() && !auto()?.visible && input !== undefined
      })(),
      commands: [
        {
          id: "prompt.history.next",
          title: "Next prompt history",
          group: "Prompt",
          run() {
            const end = measure(input.plainText)
            if (input.cursorOffset !== end) {
              // 已在末行则把光标移到文本末尾，否则下移一行
              if (
                input.scrollY + input.visualCursor.visualRow ===
                Math.max(0, input.editorView.getTotalVirtualLineCount() - 1)
              ) {
                input.cursorOffset = end
                return
              }
              input.moveCursorDown()
              return
            }

            const item = history.move(1, input.plainText)
            if (!item) return false
            input.setText(item.text)
            setStore("prompt", item)
            setStore("mode", item.mode ?? "normal")
            restoreExtmarksFromPrompt(item)
            input.cursorOffset = measure(item.text)
          },
        },
      ],
    }
  })

  // submit：提交入口（带重入保护）
  let submitting = false
  async function submit(delivery: SessionInbox.Delivery = "steer") {
    if (disabled()) return false
    // 防止重入（如连按两次 Enter，或输入框原生 onSubmit 与另一次派发竞争）。
    // 没有这个保护时，第二次调用会在第一次清空 store.prompt.text 之前通过空输入检查，
    // 然后等待自己的 session.create，最终读到已清空的 store——把一个幽灵空提示
    // 发给刚创建的会话。
    if (submitting) return false
    submitting = true
    try {
      return await submitInner(delivery)
    } finally {
      submitting = false
    }
  }

  // submitInner：提交的实际逻辑（模式判断/斜杠命令/附件展开/会话创建或投递）
  async function submitInner(delivery: SessionInbox.Delivery) {
    // IME：双重 defer 可能先于 onContentChange 把最后一个组合字符（如韩文）
    // 写入 store，因此直接读 plainText 并在任何下游读取之前同步。
    if (input && !input.isDestroyed && input.plainText !== store.prompt.text) {
      setStore("prompt", "text", input.plainText)
      syncExtmarksWithPromptParts()
    }
    // 工作区创建中或补全可见时不提交
    if (move.creating()) return false
    if (auto()?.visible) return false
    const trimmed = store.prompt.text.trim()
    // 空输入：steer 时交给 onEmptySubmit（如取出排队提示），其余情况忽略
    if (!trimmed && (!props.sessionID || store.mode === "shell" || delivery === "queue"))
      return delivery === "steer" ? (await props.onEmptySubmit?.()) === true : false
    // 退出词：exit/quit/:q
    const exitWord = trimmed === "exit" || trimmed === "quit" || trimmed === ":q"
    // 展开粘贴占位为真实文本
    const inputText = expandTrackedPastedText(
      store.prompt.text,
      input.extmarks.getAllForTypeId(promptPartTypeId).flatMap((extmark) => {
        const ref = store.extmarkToPart.get(extmark.id)
        if (ref?.type !== "pasted") return []
        const part = store.prompt.pasted[ref.index]
        if (!part) return []
        return [{ start: extmark.start, end: extmark.end, text: part.text }]
      }),
      renderer.widthMethod,
    )
    // 带参数的斜杠命令优先
    const slash = argumentSlash(inputText, keymapCommands())
    // shell/退出词/命令都不能排队
    if (delivery === "queue" && (store.mode === "shell" || exitWord || slash)) {
      toast.show({ message: "This prompt cannot be queued", variant: "warning" })
      return false
    }
    if (exitWord) {
      void exit()
      return true
    }
    if (slash) {
      clearPrompt()
      await slash.command.run(slash.input)
      return true
    }
    // 判断是否为自定义命令（仅用于阻止排队）
    const slashHead = parseSlashHead(inputText, /\s/)
    const isCommand =
      slashHead !== undefined &&
      (data.location.command.list(currentLocation.ref) ?? []).some((command) => command.name === slashHead.name)
    // 编辑器上下文尚未确认（pending）时不允许排队
    const editorSelection = editorContext()
    const pendingEditorSelection = editorSelection && editor.labelState() === "pending" ? editorSelection : undefined
    if (delivery === "queue" && pendingEditorSelection) {
      toast.show({ message: "Editor context cannot be queued", variant: "warning" })
      return false
    }
    const agent = local.agent.current()
    if (!agent) return false
    const selection = local.model.selection()
    if (!selection) {
      void promptModelWarning()
      return false
    }
    // shell 模式或无会话提交不用校验模型可用性；否则要求模型在本位置可用
    const usesModel = !props.sessionID || store.mode !== "shell"
    if (usesModel && !local.model.available(selection)) {
      toast.show({
        title: "Model unavailable",
        message: `${selection.providerID}/${selection.modelID} is not available in this session's location`,
        variant: "warning",
      })
      return false
    }

    // 在第一个 await 之前同步快照并清空输入框。
    // 下面全部读取快照：请求在途时输入的文字落在已清空的输入框中得以保留，
    // 历史记录的正是提交内容而不是实时 store（可能混入在途输入）。
    // 失败路径恢复快照，除非用户已开始输入新内容。
    const currentMode = store.mode
    const entry = { ...store.prompt, mode: currentMode }
    if (trimmed) {
      resetComposer()
      props.onSubmit?.()
    }
    // restoreEntry：把快照写回输入框（输入框仍为空时才恢复）
    const restoreEntry = () => {
      if (disposed || input.isDestroyed || input.plainText !== "") return
      input.setText(entry.text)
      setStore("prompt", entry)
      setStore("mode", entry.mode ?? "normal")
      restoreExtmarksFromPrompt(entry)
      input.cursorOffset = measure(entry.text)
    }
    const fail = (title: string, error: unknown) => {
      toast.show({ title, message: errorMessage(error), variant: "error" })
      restoreEntry()
    }
    // attempt：执行并吞掉错误（失败提示+恢复）
    const attempt = async (title: string, run: () => Promise<unknown>) => {
      return run().then(
        () => true,
        (error: unknown) => {
          fail(title, error)
          return false
        },
      )
    }

    const variant = selection.variant
    let sessionID = props.sessionID
    let session = sessionID ? data.session.get(sessionID) : undefined
    let finishMoveProgress = false
    // 新会话发送需要等待创建与环境设置。
    let newSession: { gate: Promise<unknown>; recover: (error: unknown) => void } | undefined
    if (sessionID == null) {
      // 等待工作区选择完成
      const directory = await move.getDirectory()
      if (move.pending() && !directory) {
        restoreEntry()
        return false
      }
      finishMoveProgress = Boolean(move.progress())
      // 位置上下文决定新会话的创建地：由主页路由播种（启动 cwd、继承的会话位置或所选项目），
      // 会话存在前可被 /cd 更新。
      const location = currentLocation.ref ?? data.location.default()

      // 乐观创建：数据层在客户端生成 ID 并同步登记本地会话记录，
      // 因而下方的导航立即发生——请求在途时回车也感觉已发送。
      // 对新会话的发送以创建请求为门闩。
      const newSessionID = args.takeNewSessionID()
      const created = data.session.create({
        id: newSessionID,
        location: directory ? { directory } : location,
        agent: agent.id,
        model: {
          providerID: selection.providerID,
          id: selection.modelID,
          variant,
        },
      })
      if (newSessionID !== undefined) created.request.catch(() => args.restoreNewSessionID(newSessionID))
      sessionID = created.id
      session = data.session.get(created.id)
      // gate：创建+环境设置完成；recover：创建失败时的善后（恢复草稿/关标签/回主页）
      newSession = {
        gate: created.request.then(async (info) => {
          if (terminalEnvironment.variables !== undefined) {
            await client.api.session.environment({ sessionID: created.id, variables: terminalEnvironment.variables })
          }
        }),
        recover: (error) => {
          toast.show({
            title: data.session.get(created.id) ? "Failed to set up session" : "Creating a session failed",
            message: errorMessage(error),
            variant: "error",
          })
          const active =
            route.data.type === "session" && route.data.sessionID === created.id ? promptRef.current : undefined
          const current = active?.current
          // 优先保留该输入框的现有内容为草稿，否则用提交快照
          const draft = current?.text
            ? { prompt: { ...unwrap(current) }, cursor: Infinity }
            : (takeDraft(created.id) ?? { prompt: entry, cursor: Infinity })
          saveDraft(undefined, draft)
          active?.reset()
          if (sessionTabs.enabled()) {
            sessionTabs.close(created.id)
          } else if (route.data.type === "session" && route.data.sessionID === created.id) {
            route.navigate({ type: "home" })
          }
        },
      }
    }

    const target = sessionID
    // prepareAgent：确保会话同步且代理与当前选择一致
    const prepareAgent = async () => {
      if (!session) {
        await data.session.sync(target)
        session = data.session.get(target)
      }
      if (session?.agent !== agent.id) {
        await client.api.session.switchAgent({ sessionID: target, agent: agent.id })
      }
    }
    // commitModel：切换会话模型（失败时回滚本地提交追踪）
    const commitModel = () => {
      const model = { providerID: selection.providerID, id: selection.modelID, variant }
      const cancelCommit = local.model.trackSessionCommit(target, model, agent.id)
      return client.api.session.switchModel({ sessionID: target, model }).catch((error) => {
        cancelCommit()
        throw new Error(`Failed to switch model: ${errorMessage(error)}`, { cause: error })
      })
    }
    // commitSelection：准备代理并提交模型选择
    const commitSelection = async () => {
      await prepareAgent()
      await commitModel()
    }
    if (!trimmed) {
      // 已有会话中的空回车：提交输入框当前的代理与模型选择，然后交给路由（提升排队提示）。
      await attempt("Failed to prepare session", async () => {
        await commitSelection()
        await props.onEmptySubmit?.()
      })
      return true
    }
    // 记入输入历史
    history.append(entry)
    if (currentMode === "shell") {
      // shell 命令：发给会话执行，完成后回到普通模式
      move.startSubmit()
      const send = () => client.api.session.shell({ sessionID: target, command: inputText })
      void (newSession ? newSession.gate.then(send) : send()).catch((error) =>
        newSession ? newSession.recover(error) : fail("Failed to run shell command", error),
      )
      setStore("mode", "normal")
    } else if (slashHead && isCommand) {
      // 自定义命令：先继承输入框的代理/模型选择，再执行命令
      const send = async () => {
        // 命令继承输入框的选择；命令特有的覆盖仍由服务端处理，在此准备之后执行。
        await commitSelection()
        return client.api.session.command({
          sessionID: target,
          name: slashHead.name,
          text: slashHead.arguments,
          files: promptFilesForServer(entry.files, terminalEnvironment.localServer === true),
          agents: entry.agents,
          skills: entry.skills?.length ? entry.skills : undefined,
          delivery,
        })
      }
      void (newSession ? newSession.gate.then(send) : send()).catch((error) =>
        newSession ? newSession.recover(error) : fail("Failed to run command", error),
      )
    } else {
      // 普通提示词发送
      move.startSubmit()
      if (!(await attempt("Failed to prepare session", prepareAgent))) return true
      // 回滚必须先于乐观准入落定：它提交后的回显会在边界处拼接本地行，
      // 可能拼掉刚准入的提示。
      if (
        session?.revert &&
        !(await attempt("Failed to commit revert", () => client.api.session.revert.commit({ sessionID: target })))
      )
        return false
      if (pendingEditorSelection) {
        // 在对应的用户提示之前准入编辑器上下文，且保持其隐藏。
        const send = () =>
          client.api.session.synthetic({
            sessionID: target,
            text: formatEditorContext(pendingEditorSelection),
            resume: false,
          })
        // 并入设置门闩：会话创建后上下文仍先于用户提示准入。
        if (newSession) newSession.gate = newSession.gate.then(send)
        else if (!(await attempt("Failed to send editor context", send))) return false
      }
      // 数据层乐观准入：提示立即渲染，服务端拒绝则回滚，提交无需等网络。
      // 拒绝时该行已回滚；除非用户开始输入新内容，否则恢复输入框。
      data.session
        .prompt({
          sessionID: target,
          text: inputText,
          files: promptFilesForServer(entry.files, terminalEnvironment.localServer === true),
          agents: entry.agents,
          skills: entry.skills?.length ? entry.skills : undefined,
          delivery,
          gate: newSession?.gate,
          // 在更早的准入（包括压缩设置）之后提交捕获的选择。
          // 缓存状态可能仍先于它们的 SSE 回显；服务端把未变化的选择视为 no-op。
          prepare: commitModel,
        })
        .catch((error) => (newSession ? newSession.recover(error) : fail("Failed to send prompt", error)))
      if (pendingEditorSelection) editor.markSelectionSent()
    }

    // 乐观准入把消息同步写入 store，会话视图随即渲染。
    if (!props.sessionID) {
      if (pendingEditorSelection) editor.preserveSelectionFromNewSession()
      // 创建在途时输入的文字住在这个（主页）输入框里，导航时它会卸载并把内容
      // 暂存到 home 键下。把它改存到新会话，让会话输入框恢复它，并在此清空，
      // 避免 onCleanup 再为 home 暂存一次。
      if (!disposed && !input.isDestroyed && store.prompt.text) {
        // 先复制再清空：unwrap 返回活动 store 对象，resetComposer 的写入会合并进同一对象。
        saveDraft(sessionID, { prompt: { ...unwrap(store.prompt) }, cursor: input.cursorOffset })
        resetComposer()
      }
      route.navigate({
        type: "session",
        sessionID,
      })
    }
    if (finishMoveProgress) move.finishSubmit()
    return true
  }

  // pasteText：把长文本粘贴为虚拟占位（extmark），真实文本存入 pasted 分片
  function pasteText(text: string, virtualText: string) {
    const currentOffset = input.cursorOffset
    const extmarkStart = currentOffset
    const extmarkEnd = extmarkStart + measure(virtualText)

    input.insertText(virtualText + " ")

    const extmarkId = input.extmarks.create({
      start: extmarkStart,
      end: extmarkEnd,
      virtual: true,
      styleId: pasteStyleId,
      typeId: promptPartTypeId,
    })

    setStore(
      produce((draft) => {
        const index = draft.prompt.pasted.length
        draft.prompt.pasted.push({
          text,
          source: { start: extmarkStart, end: extmarkEnd, text: virtualText },
        })
        draft.extmarkToPart.set(extmarkId, { type: "pasted", index })
      }),
    )
  }

  // expandPastedText：把粘贴占位展开为真实文本（再次粘贴相同内容时）
  function expandPastedText(extmarkId: number) {
    const extmark = input.extmarks.get(extmarkId)
    const ref = store.extmarkToPart.get(extmarkId)
    if (!extmark || ref?.type !== "pasted") return false
    const part = store.prompt.pasted[ref.index]
    if (!part) return false

    input.extmarks.delete(extmarkId)
    input.setSelection(extmark.start, extmark.end)
    input.insertText(part.text)
    return true
  }

  // pasteInputText：处理纯文本粘贴——识别文件/图片路径为附件，
  // 长文本折叠为占位（可再次粘贴展开），短文本直接插入。
  async function pasteInputText(text: string, changed: () => boolean) {
    const normalizedText = stripAnsiSequences(text).replace(/\r\n?/g, "\n")
    const pastedContent = normalizedText.trim()
    // 尝试把粘贴内容解析为附件（文件路径/图片）
    const attachments = await resolvePastedAttachments(pastedContent, terminalEnvironment.platform)
    if (changed()) return
    if (attachments) {
      attachments.forEach((attachment) => {
        if (attachment.type === "text") {
          pasteText(attachment.content, `[SVG: ${attachment.filename || "image"}]`)
          return
        }
        pasteAttachment(attachment)
      })
      return
    }

    // 多行或长文本：折叠为占位（配置 paste=full 时直接插入）
    const lineCount = (pastedContent.match(/\n/g)?.length ?? 0) + 1
    if ((lineCount >= 3 || pastedContent.length > 150) && config.prompt?.paste !== "full") {
      // 光标处已有相同内容的占位则展开它（用户是想重复粘贴）
      const extmark = input.extmarks.getAllForTypeId(promptPartTypeId).find((extmark) => {
        const ref = store.extmarkToPart.get(extmark.id)
        return (
          (extmark.end === input.cursorOffset || extmark.end + 1 === input.cursorOffset) &&
          ref?.type === "pasted" &&
          store.prompt.pasted[ref.index]?.text === pastedContent
        )
      })
      if (extmark && expandPastedText(extmark.id)) return
      pasteText(pastedContent, `[Pasted ~${lineCount} lines]`)
      return
    }

    input.insertText(normalizedText)

    setTimeout(() => {
      if (!input || input.isDestroyed) return
      input.invalidateIntrinsicSize()
      renderer.requestRender()
    }, 0)
  }

  // pasteAttachment：把附件（图片/文件）作为虚拟占位插入，并登记 file 分片
  function pasteAttachment(file: { filename?: string; uri: string; path?: string }) {
    const currentOffset = input.cursorOffset
    const extmarkStart = currentOffset
    // 占位文本形如 [Image 1]/[File]
    const virtualText = promptAttachmentLabel(store.prompt.files, { uri: file.uri, name: file.filename })
    const extmarkEnd = extmarkStart + virtualText.length
    const textToInsert = virtualText + " "

    input.insertText(textToInsert)

    const extmarkId = input.extmarks.create({
      start: extmarkStart,
      end: extmarkEnd,
      virtual: true,
      styleId: pasteStyleId,
      typeId: promptPartTypeId,
    })

    const part: NonNullable<PromptInfo["files"]>[number] = {
      uri: file.uri,
      name: file.filename,
      path: file.path,
      mention: {
        start: extmarkStart,
        end: extmarkEnd,
        text: virtualText,
      },
    }
    setStore(
      produce((draft) => {
        const files = (draft.prompt.files ??= [])
        const index = files.length
        files.push(part)
        draft.extmarkToPart.set(extmarkId, { type: "file", index })
      }),
    )
  }

  // clearPrompt：清空输入。内容足够多（文本/附件/代理）时先记入历史再清空。
  function clearPrompt() {
    if (
      store.prompt.text.trim().length >= DRAFT_RETENTION_MIN_CHARS ||
      store.prompt.pasted.length > 0 ||
      (store.prompt.files?.length ?? 0) > 0 ||
      (store.prompt.agents?.length ?? 0) > 0
    ) {
      history.append({
        ...store.prompt,
        mode: store.mode,
      })
    }
    resetComposer()
  }

  // promptDisplay：输入框底部的元信息（代理/模型/变体）。
  // 目标目录的目录在加载期间保持上一次解析结果可见；
  // 可用性与提交仍使用实时的按目录目录。
  const promptDisplay = createMemo<{
    agentLabel: string | undefined
    agentColor: RGBA | undefined
    modelLabel: string
    providerLabel: string
    variant: string | undefined
  }>(
    (previous) => {
      const location = currentLocation.ref ?? data.location.default()
      const sessionLocation = props.sessionID ? data.session.get(props.sessionID)?.location : location
      // 会话目录与当前目录不一致时保持旧值
      if (!sessionLocation || locationKey(sessionLocation) !== locationKey(location)) return previous

      const loading = data.location.agent.list(location) === undefined || !local.model.catalogReady
      const error = currentLocation.error
      const failed = error && locationKey(error.location) === locationKey(location)
      // 加载中且未失败：保持旧值
      if (loading && !failed) return previous

      const agent = local.agent.current()
      const model = local.model.parsed()
      return {
        agentLabel: agent ? Locale.titlecase(agent.id) : undefined,
        agentColor: agent ? local.agent.color(agent.id) : undefined,
        modelLabel: model.model,
        providerLabel: model.provider,
        variant: local.model.variant.current(),
      }
    },
    {
      agentLabel: undefined,
      agentColor: undefined,
      modelLabel: local.model.parsed().model,
      providerLabel: local.model.parsed().provider,
      variant: undefined,
    },
  )
  // 工作区限额留给所选模型的余量（接近用尽时显示）。只有 OpenCode Console 限制模型，
  // 因此只有它服务的模型才会加载限额。
  const limits = useUsageLimits()
  // 所选模型由 Console 服务时按需加载限额数据
  createEffect(() => {
    const selected = local.model.current()
    if (selected && limits.served(selected.providerID) && limits.info() === undefined) limits.load()
  })
  // 当前模型的限额展示标签
  const limit = createMemo(() => {
    const selected = local.model.current()
    const model = limits
      .models()
      .find((item) => item.providerID === selected?.providerID && item.id === selected?.modelID)
    return model ? limitLabel(limits.usage(model), model) : undefined
  })
  // 边框高亮色：静音=普通边框；shell=主操作色；否则跟随代理色
  const highlight = createMemo(() => {
    if (muted()) return theme.border.base
    if (store.mode === "shell") return theme.text.action.primary.selected
    return promptDisplay().agentColor ?? theme.border.base
  })
  const agentLabel = createMemo(() => (store.mode === "shell" ? "Shell" : promptDisplay().agentLabel))
  // 元信息淡入动画只在首次展示时播放
  const animateMetadata = !revealedPromptMetadata.has(local)
  const metadataAnimationsEnabled = () => animationsEnabled() && animateMetadata
  const agentMetaAlpha = createFadeIn(() => !!agentLabel(), metadataAnimationsEnabled)
  const modelMetaAlpha = createFadeIn(
    () => !!promptDisplay().agentLabel && store.mode === "normal",
    metadataAnimationsEnabled,
  )
  const variantMetaAlpha = createFadeIn(
    () => !!promptDisplay().agentLabel && store.mode === "normal" && !!promptDisplay().variant,
    metadataAnimationsEnabled,
  )
  createEffect(() => {
    if (agentLabel()) revealedPromptMetadata.add(local)
  })
  // 边框色 = 基础色向高亮色按代理淡入透明度插值
  const borderHighlight = createMemo(() => tint(theme.border.base, highlight(), agentMetaAlpha()))
  // 传给底部元信息行的输入
  const footerInput = () => ({
    sessionID: props.sessionID,
    mode: store.mode,
    showDetails: store.interrupt === 0 || dimensions().width >= 80,
  })

  // 占位文案：shell 模式用命令示例，普通模式用提问示例；按可用宽度截断
  const placeholderText = createMemo(() => {
    const value = (() => {
      if (store.mode === "shell") {
        if (!shell().length) return undefined
        return `Run a command… "${shell()[store.placeholder % shell().length]}"`
      }
      if (!list().length) return undefined
      return `Ask anything… "${list()[store.placeholder % list().length]}"`
    })()
    if (!value) return undefined
    const width = dimensions().width < 44 ? dimensions().width - 5 : Math.min(75, dimensions().width - 4) - 5
    return Locale.takeWidth(value, Math.max(1, width)).trimEnd()
  })
  // 底部位置：无会话时显示下个会话将创建的目录；会话空闲时显示会话目录
  const footerLocation = createMemo(() => {
    if (!props.sessionID) {
      // 还没有会话：显示下一个会话的创建位置。
      return currentLocation.ref ?? data.location.default()
    }
    if (status() !== "idle") return
    return data.session.get(props.sessionID)?.location
  })
  // 位置标签：目录（~ 缩写）+ 当前分支，cd 进行中显示目标目录
  const locationLabel = createMemo(() => {
    const pending = pendingDirectory()
    const location = pending ? { directory: pending } : footerLocation()
    if (!location) return
    const directory = abbreviateHome(location.directory, paths.home)
    const branch = data.location.vcs.info(location)?.branch.current
    return branch ? `${directory}:${branch}` : directory
  })
  const [locationWidth, setLocationWidth] = createSignal(dimensions().width)
  // 按可用宽度截断的路径展示
  const locationLabelDisplay = createMemo(() => {
    const label = locationLabel()
    if (!label) return
    return truncateFilePath(label, locationWidth())
  })
  // 位置行可用的操作（打开工作区管理等）
  const locationActions = useWorkingDirectoryActions({
    directory: () => footerLocation()?.directory,
    onMove: () => void move.open(),
  })

  // spinner 定义（blocks 风格，随代理色）
  const spinnerDef = createMemo(() => {
    const color = promptDisplay().agentColor ?? theme.border.base
    return {
      frames: createFrames({
        color,
        style: "blocks",
        inactiveFactor: 0.6,
        // enableFading: false,
        minAlpha: 0.3,
      }),
      color: createColors({
        color,
        style: "blocks",
        inactiveFactor: 0.6,
        // enableFading: false,
        minAlpha: 0.3,
      }),
    }
  })
  // 输入区最大高度：终端高的 1/3，至少 6 行
  const maxHeight = createMemo(() => Math.max(6, Math.floor(dimensions().height / 3)))

  // 输入区背景色
  const promptBg = createMemo(() => theme.decrease(theme.background.raised.base))

  return (
    <>
      <box ref={(r: BoxRenderable) => (anchor = r)} visible={props.visible !== false} width="100%">
        <box
          width="100%"
          border={["left"]}
          borderColor={borderHighlight()}
          customBorderChars={{
            ...SplitBorder.customBorderChars,
            bottomLeft: "╹",
          }}
        >
          <box
            paddingLeft={dimensions().width < 44 ? 1 : 2}
            paddingRight={dimensions().width < 44 ? 1 : 2}
            paddingTop={1}
            flexShrink={0}
            backgroundColor={promptBg()}
            flexGrow={1}
            width="100%"
          >
            <Show when={config.prompt?.image_preview && visibleImageAttachments().length > 0}>
              <box
                width="100%"
                height={imagePreviewHeight() + 1}
                flexDirection="row"
                flexShrink={0}
                justifyContent="flex-start"
                gap={1}
                paddingBottom={1}
              >
                <For each={visibleImageAttachments()}>
                  {(file, index) => {
                    const [failed, setFailed] = createSignal(false)
                    return (
                      <box
                        width={imagePreviewWidth()}
                        height={imagePreviewHeight()}
                        flexBasis={imagePreviewWidth()}
                        flexShrink={1}
                        onMouseUp={(event: MouseEvent) => {
                          if (event.button !== 0) return
                          event.stopPropagation()
                          openImagePreview(index())
                        }}
                      >
                        <Show
                          when={!failed()}
                          fallback={
                            <box width="100%" height="100%" alignItems="center" justifyContent="center">
                              <text fg={theme.text.muted}>No preview</text>
                            </box>
                          }
                        >
                          <image
                            id={`prompt-image-preview-${index()}`}
                            source={file.uri}
                            fit="cover"
                            protocol="auto"
                            width="100%"
                            height="100%"
                            onError={() => setFailed(true)}
                          />
                        </Show>
                      </box>
                    )
                  }}
                </For>
                <Show when={imageAttachments().length > visibleImageAttachments().length}>
                  <box
                    width={8}
                    height={imagePreviewHeight()}
                    flexBasis={8}
                    flexShrink={1}
                    alignItems="center"
                    justifyContent="center"
                    onMouseUp={(event: MouseEvent) => {
                      if (event.button !== 0) return
                      event.stopPropagation()
                      openImagePreview(visibleImageAttachments().length)
                    }}
                  >
                    <text fg={theme.text.muted} wrapMode="none" truncate>
                      +{imageAttachments().length - visibleImageAttachments().length} more
                    </text>
                  </box>
                </Show>
              </box>
            </Show>
            <textarea
              width="100%"
              placeholder={placeholderText()}
              placeholderColor={theme.text.muted}
              textColor={muted() ? theme.text.muted : theme.text.base}
              focusedTextColor={muted() ? theme.text.muted : theme.text.base}
              minHeight={1}
              maxHeight={maxHeight()}
              cursorStyle={cursorStyle()}
              onContentChange={() => {
                // 内容变化：同步 store、通知补全、重排分片、推进光标版本
                const value = input.plainText
                setStore("prompt", "text", value)
                auto()?.onInput(value)
                syncExtmarksWithPromptParts()
                setCursorVersion((value) => value + 1)
              }}
              onCursorChange={() => setCursorVersion((value) => value + 1)}
              onKeyDown={(e: { preventDefault(): void }) => {
                // 禁用态吞掉按键
                if (disabled()) {
                  e.preventDefault()
                  return
                }
              }}
              onSubmit={() => {
                if (disabled()) return
                // IME：双重 defer 确保最后组合的字符（如韩文）先落到 plainText 再提交。
                setTimeout(() => setTimeout(() => submit(), 0), 0)
              }}
              onPaste={(event: PasteEvent) => {
                if (disabled()) {
                  event.preventDefault()
                  return
                }

                // 在边界处统一换行符
                // Windows 的 ConPTY/终端在括号粘贴里常发送仅 CR 的换行
                // 先替换 CRLF，再替换剩余的 CR
                const normalizedText = decodePasteBytes(event.bytes).replace(/\r\n/g, "\n").replace(/\r/g, "\n")

                // Windows Terminal <1.25 会把纯图片剪贴板表现为空的括号粘贴；1.25+ 不会。
                if (event.bytes.byteLength === 0) {
                  keymap.dispatch("prompt.paste")
                  return
                }

                // 一旦跨过下面的异步边界，终端可能执行默认粘贴，
                // 因此先阻止默认行为，由我们自行插入。
                event.preventDefault()

                void enqueuePaste((changed) => pasteInputText(normalizedText, changed))
              }}
              ref={(r: TextareaRenderable) => {
                input = r
                // 复制时把粘贴占位展开为真实文本
                Object.assign(r, {
                  getClipboardText: (text: string) => expandPastedTextPlaceholders(text, store.prompt.pasted),
                })
                setInputTarget(r)
                if (promptPartTypeId === 0) {
                  promptPartTypeId = input.extmarks.registerType("prompt-part")
                }
                props.ref?.(ref)
                setTimeout(() => {
                  // setTimeout 是临时方案，后续需要正式处理
                  if (!input || input.isDestroyed) return
                  input.cursorColor = disabled() ? theme.background.raised.base : theme.text.base
                }, 0)
              }}
              onMouseDown={(r: MouseEvent) => {
                if (disabled()) {
                  r.preventDefault()
                  return
                }
                if (r.button !== 0) return
                r.target?.focus()
                // 点击粘贴占位：展开为真实文本
                const extmark = input.extmarks
                  .getAtOffset(input.cursorOffset)
                  .find((item) => store.extmarkToPart.get(item.id)?.type === "pasted")
                if (!extmark || !expandPastedText(extmark.id)) return
                r.preventDefault()
                r.stopPropagation()
              }}
              focusedBackgroundColor="transparent"
              cursorColor={disabled() ? theme.background.raised.base : theme.text.base}
              syntaxStyle={syntax()}
            />
            {/* 元信息行：模式/代理/模型/变体/限额 */}
            <box flexDirection="row" flexShrink={0} paddingTop={1} gap={1} justifyContent="space-between">
              <PromptMetadataRow
                mode={store.mode}
                agent={agentLabel()}
                auto={local.permission.mode === "autoaccept"}
                model={promptDisplay().modelLabel}
                provider={promptDisplay().providerLabel}
                variant={promptDisplay().variant}
                limit={limit()}
                muted={!!muted()}
                highlight={highlight()}
                agentAlpha={agentMetaAlpha()}
                modelAlpha={modelMetaAlpha()}
                variantAlpha={variantMetaAlpha()}
              />
            </box>
          </box>
        </box>
        {/* 左侧竖线底段与背景过渡装饰 */}
        <box
          height={1}
          border={["left"]}
          borderColor={borderHighlight()}
          customBorderChars={{
            ...EmptyBorder,
            vertical: promptBg().a !== 0 ? "╹" : " ",
          }}
        >
          <box
            height={1}
            border={["bottom"]}
            borderColor={promptBg()}
            customBorderChars={
              promptBg().a !== 0
                ? {
                    ...EmptyBorder,
                    horizontal: "▀",
                  }
                : {
                    ...EmptyBorder,
                    horizontal: " ",
                  }
            }
          />
        </box>
        {/* 底部状态行：位置/运行状态/编辑器上下文文件（插件可注入插槽） */}
        <box width="100%" flexDirection="row" justifyContent="space-between" gap={2}>
          <Slot path="prompt.footer" input={footerInput()}>
            <Slot path="prompt.footer.status" input={footerInput()}>
              <box
                flexGrow={1}
                flexShrink={1}
                minWidth={0}
                onSizeChange={function (this: BoxRenderable) {
                  // 记录状态区可用宽度，用于路径截断
                  const width = this.width
                  queueMicrotask(() => setLocationWidth(width))
                }}
              >
                <Switch>
                  {/* 运行中：spinner + esc 中断提示 */}
                  <Match when={status() === "running"}>
                    <box flexDirection="row" gap={1} flexGrow={1} justifyContent="flex-start">
                      <box marginLeft={1}>
                        <Show when={config.animations ?? true} fallback={<text fg={theme.text.muted}>[⋯]</text>}>
                          <spinner color={spinnerDef().color} frames={spinnerDef().frames} interval={40} />
                        </Show>
                      </box>
                      <PromptInterruptStatus
                        armed={store.interrupt > 0}
                        animations={animationsEnabled()}
                        text={theme.text.base}
                        subdued={theme.text.muted}
                        warning={theme.text.feedback.warning.base}
                        flash={theme.decrease(theme.text.feedback.warning.base, 2)}
                      />
                    </box>
                  </Match>
                  {/* 工作区创建进度 */}
                  <Match when={move.progress()}>
                    {(progress) => (
                      <box paddingLeft={3} height={1} minHeight={0} flexShrink={1}>
                        <Spinner color={theme.hue.accent[500]}>
                          {progress()}
                          <span style={{ fg: theme.text.muted }}>{".".repeat(move.creatingDots())}</span>
                        </Spinner>
                      </box>
                    )}
                  </Match>
                  {/* 等待新工作区名称 */}
                  <Match when={move.pendingNew()}>
                    <box paddingLeft={3} height={1} minHeight={0} flexShrink={1}>
                      <text fg={theme.hue.accent[500]} wrapMode="none" truncate>
                        (new worktree)
                      </text>
                    </box>
                  </Match>
                  {/* 默认：显示当前位置（可点击打开工作区操作） */}
                  <Match when={true}>
                    <Show when={locationLabelDisplay()} fallback={<text />}>
                      {(location) => (
                        <text
                          id="prompt.footer.location"
                          fg={locationActions.hovered() ? theme.text.base : theme.text.muted}
                          wrapMode="none"
                          truncate
                          flexGrow={1}
                          flexShrink={1}
                          onMouseOver={locationActions.onMouseOver}
                          onMouseOut={locationActions.onMouseOut}
                          onMouseUp={locationActions.onMouseUp}
                        >
                          {location()}
                        </text>
                      )}
                    </Show>
                  </Match>
                </Switch>
              </box>
            </Slot>
            {/* 编辑器上下文文件标签（pending 时用强调色） */}
            <Slot path="prompt.footer.file" input={footerInput()}>
              <Show when={editorContextLabelState() !== "none" ? editorFileLabelDisplay() : undefined}>
                {(file) => (
                  <text
                    wrapMode="none"
                    truncate
                    flexShrink={1}
                    fg={editorContextLabelState() === "pending" ? theme.hue.accent[500] : theme.text.muted}
                  >
                    {file()}
                  </text>
                )}
              </Show>
            </Slot>
          </Slot>
        </box>
      </box>
      {/* 自动补全面板 */}
      <Autocomplete
        sessionID={props.sessionID}
        // /cd 命令的参数补全类型是目录
        argumentAutocomplete={(command) => (command.id === "session.cd" ? "directory" : undefined)}
        // 空查询时列出项目最近使用的目录（支持 ctrl+d 删除记录）
        directoryOptions={(query): AutocompleteOption[] => {
          if (query !== "") return []
          const projectID =
            (props.sessionID ? data.session.get(props.sessionID)?.projectID : undefined) ??
            data.location.info()?.project.id
          if (!projectID) return []
          return directoryRecents.list(projectID).map((item) => {
            const value = directoryRecentValue(item.directory, paths.home)
            return {
              display: value,
              value,
              description: "recent",
              isDirectory: true,
              path: value,
              absolute: item.directory,
              destructive: {
                id: item.directory,
                confirm: "Press ctrl+d to confirm",
                run: () => directoryRecents.remove(projectID, item.directory),
              },
            }
          })
        }}
        ref={(r) => {
          setAuto(() => r)
        }}
        // 补全的定位锚点与输入源
        anchor={() => anchor}
        input={() => input}
        // 供补全写入提示内容与登记 extmark 映射
        setPrompt={(cb) => {
          setStore("prompt", produce(cb))
        }}
        setExtmark={(part, extmarkId) => {
          setStore("extmarkToPart", (map: Map<number, PromptPartRef>) => {
            const newMap = new Map(map)
            newMap.set(extmarkId, part)
            return newMap
          })
        }}
        value={store.prompt.text}
        // 各类提及的样式 ID 与去重判断
        fileStyleId={fileStyleId}
        agentStyleId={agentStyleId}
        skillStyleId={skillStyleId}
        hasSkill={(id) => store.prompt.skills?.some((skill) => skill.id === id) ?? false}
        promptPartTypeId={() => promptPartTypeId}
      />
    </>
  )
}
