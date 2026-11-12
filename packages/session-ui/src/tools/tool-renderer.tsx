// 会话工具展示（Web 版）：当前会话中各工具调用的 UI 渲染，按视觉形态分组
// （行内工具、文件读取、diff 补丁、shell 输出、子代理等）。
// 本模块是 session-ui 的"工具渲染中枢"：接收工具分片（part），解码宽松的输入/元数据，
// 分派到对应的展示组件；数据容错优先——单字段损坏只丢该字段，不影响整体渲染。
import {
  // Component：类组件基类
  Component,
  // batch：合并多次信号更新
  batch,
  // createComputed：创建计算信号
  createComputed,
  createEffect,
  createMemo,
  createSignal,
  // createUniqueId：生成组件内唯一 ID
  createUniqueId,
  For,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
  // Index：按索引渲染列表
  Index,
  on,
  // untrack：脱离响应式追踪执行读取
  untrack,
  type JSX,
} from "solid-js"
// createStore：细粒度可变状态对象
import { createStore } from "solid-js/store"
// createResizeObserver：监听 DOM 尺寸变化
import { createResizeObserver } from "@solid-primitives/resize-observer"
// effect 库：Effect 组合、Option 可选值、Schema 校验
import { Effect, Option, Schema } from "effect"
// diff 库：两文件 patch 生成与逐行 diff
import { createTwoFilesPatch, diffLines } from "diff"
// Dynamic：动态渲染 HTML 标签或组件
import { Dynamic } from "solid-js/web"
// 会话数据上下文与摘要类型
import { type SessionSummary, useData } from "../context"
// 文件组件上下文（可替换的文件链接渲染）
import { useFileComponent } from "@opencode/ui/context/file"
// i18n 上下文与类型
import { type UiI18n, useI18n } from "@opencode/ui/context/i18n"
// BasicTool/GenericTool：工具行与通用工具的基座组件
import { BasicTool, GenericTool } from "../components/basic-tool"
// createDisclosure：展开/收起状态
import { createDisclosure } from "../components/disclosure"
// FileIcon/Icon：文件图标与通用图标
import { FileIcon } from "@opencode/ui/file-icon"
import { Icon } from "@opencode/ui/icon"
// ToolErrorCard：工具错误卡片
import { ToolErrorCard } from "../components/tool-error-card"
// DiffChanges：增删行数统计徽标
import { DiffChanges } from "@opencode/ui/diff-changes"
// Markdown 渲染与图片提取、图片预览
import { Markdown } from "../components/markdown"
import { createMarkdownImages } from "../components/markdown-image"
import { createImagePreview } from "../components/image-preview"
// markdown 渲染上下文
import { useMarkdown } from "../context/markdown"
// 路径工具：取目录/文件名
import { getDirectory, getFilename } from "@opencode/util/path"
// checksum：内容校验和（缓存键）
import { checksum } from "@opencode/util/encode"
import { formatExecuteOutput } from "@opencode/util/execute-output"
import { Tooltip } from "@opencode/ui/tooltip"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@opencode/ui/dialog"
// IconButton：图标按钮
import { IconButton } from "@opencode/ui/icon-button"
// TextShimmer：微光加载占位
import { TextShimmer } from "@opencode/ui/text-shimmer"
// AnimatedNumber：数字滚动动画
import { AnimatedNumber } from "@opencode/ui/animated-number"
// apply-patch 文件分组与变更 diff
import { changedFileDiff, patchFileGroups } from "../components/apply-patch-file"
// animate：弹簧动画
import { animate } from "@kitlangton/solid-motion"
// 会话进度指示器（V2 设计）
import { SessionProgressIndicatorV2 } from "../v2/components/session-progress-indicator-v2"
import type {
  FileDiffInfo,
  SessionMessageAssistantReasoning,
  SessionMessageAssistantTool,
  SessionMessageShell,
} from "@opencode/client/promise"
import {
  // 工具状态读取器：错误/分组读/输入/元数据/输出
  currentToolError,
  currentToolGroupedRead,
  currentToolInput,
  currentToolMetadata,
  currentToolOutput,
  // execute 工具的子调用参数/列表/副标题
  executeToolCallArgs,
  executeToolCalls,
  executeToolSubtitle,
  // 图片读取路径
  readImagePath,
  type ExecuteToolCall,
} from "../message/current-tool-state"
// 助手推理内容组件
import { AssistantReasoningContent } from "../message/message-content"
// 复制反馈 hook
import { createCopyFeedback } from "../components/copy"
// stripAnsi：去 ANSI 转义
import { stripAnsi } from "./ansi"
// createShellFollower：跟随 shell 输出流
import { createShellFollower } from "./shell-output"
// 运行状态机：shell/subagent 的运行态与视图映射
import {
  createShellRunState,
  shellRunProps,
  subagentRunProps,
  transitionShellRun,
  transitionSubagentRun,
  viewShellRun,
  viewSubagentRun,
  INITIAL_SUBAGENT_RUN_STATE,
  stoppedShell,
  type ShellRunEvent,
  type SubagentRunState,
} from "./run-machine"
// LinkedText：自动识别链接/文件路径的文本
import { LinkedText } from "../components/linked-text"

export function ShellSubmessage(props: { text: string; animate?: boolean }) {
  let widthRef: HTMLSpanElement | undefined
  let valueRef: HTMLSpanElement | undefined

  onMount(() => {
    if (!props.animate) return
    requestAnimationFrame(() => {
      // 宽度从 0 弹簧展开到 auto
      if (widthRef) {
        animate(widthRef, { width: "auto" }, { type: "spring", visualDuration: 0.25, bounce: 0 })
      }

      // 文本值做透明度+模糊淡入
      if (valueRef) {
        valueRef.animate?.(
          { opacity: [0, 1], filter: ["blur(2px)", "blur(0px)"] },
          { duration: 320, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
        )
        valueRef.style.opacity = "1"
        valueRef.style.filter = "blur(0px)"
      }
    })
  })

  return (
    <span data-component="shell-submessage" dir="ltr">
      <span ref={widthRef} data-slot="shell-submessage-width" style={{ width: props.animate ? "0px" : undefined }}>
        <span data-slot="basic-tool-tool-subtitle">
          <span
            ref={valueRef}
            data-slot="shell-submessage-value"
            style={props.animate ? { opacity: 0, filter: "blur(2px)" } : undefined}
          >
            {props.text}
          </span>
        </span>
      </span>
    </span>
  )
}

// 工具输入与元数据是所有工具共享的开放记录。每个字段独立解码，
// 某个字段损坏只会丢弃该字段；插件工具运行时无类型，非对象记录按空处理而不是渲染失败。
function optional<S extends Schema.ConstraintCodec<unknown, unknown>>(schema: S) {
  const field = Schema.optional(schema)

  // 解码失败的字段返回 none，等于该字段缺失
  return Schema.catchDecoding<typeof field>(() => Effect.succeed(Option.none()))(field)
}

export const toolInput = Schema.decodeUnknownSync(
  Schema.Struct({
    path: optional(Schema.String),
    pattern: optional(Schema.String),
    include: optional(Schema.String),
    offset: optional(Schema.Number),
    limit: optional(Schema.Number),
    url: optional(Schema.String),
    query: optional(Schema.String),
    agent: optional(Schema.String),
    description: optional(Schema.String),
    command: optional(Schema.String),
    code: optional(Schema.String),
    oldString: optional(Schema.String),
    newString: optional(Schema.String),
    content: optional(Schema.String),
    id: optional(Schema.String),
    name: optional(Schema.String),
    questions: optional(Schema.Array(Schema.Unknown)),
  }).pipe(Schema.catchDecoding(() => Effect.succeed(Option.some({})))),
)

export const toolMetadata = Schema.decodeUnknownSync(
  Schema.Struct({
    name: optional(Schema.String),
    provider: optional(Schema.String),
    sessionID: optional(Schema.String),
    command: optional(Schema.String),
    shellID: optional(Schema.String),
    status: optional(Schema.String),
    interrupted: optional(Schema.Boolean),
    notice: optional(Schema.String),
    count: optional(Schema.Finite),
    matches: optional(Schema.Finite),
    files: optional(Schema.Array(Schema.Unknown)),
    loaded: optional(Schema.Array(Schema.Unknown)),
    answers: optional(Schema.Array(Schema.Unknown)),
    diagnostics: optional(Schema.Record(Schema.String, Schema.Array(Schema.Unknown))),
  }).pipe(Schema.catchDecoding(() => Effect.succeed(Option.some({})))),
)

type ToolInput = ReturnType<typeof toolInput>

type ToolMetadata = ReturnType<typeof toolMetadata>

// decodeString：未知值安全解为字符串（失败返回 none）
const decodeString = Schema.decodeUnknownOption(Schema.String)

// decodeQuestion：问题结构 { question: string } 的安全解码
const decodeQuestion = Schema.decodeUnknownOption(Schema.Struct({ question: Schema.String }))

// decodeAnswer：答案数组（字符串列表）的安全解码
const decodeAnswer = Schema.decodeUnknownOption(Schema.Array(Schema.String))

// decodeDiagnostic：诊断结构（位置区间 + 消息 + 可选严重级别）的安全解码
const decodeDiagnostic = Schema.decodeUnknownOption(
  Schema.Struct({
    range: Schema.Struct({ start: Schema.Struct({ line: Schema.Number, character: Schema.Number }) }),
    message: Schema.String,
    severity: Schema.optional(Schema.Number),
  }),
)

type Diagnostic = Option.Option.Value<ReturnType<typeof decodeDiagnostic>>

// questions：从工具输入解析问题列表（解码失败的问题被丢弃）
function questions(input: ToolInput) {
  return (input.questions ?? []).flatMap((question) => Option.toArray(decodeQuestion(question)))
}

// getDiagnostics：按文件路径取诊断，只保留 error 级（severity===1），最多 3 条
function getDiagnostics(diagnosticsByFile: ToolMetadata["diagnostics"], filePath: string | undefined) {
  if (!filePath) return []

  return (diagnosticsByFile?.[filePath] ?? [])
    .flatMap((value) => Option.toArray(decodeDiagnostic(value)).filter((diagnostic) => diagnostic.severity === 1))
    .slice(0, 3)
}

/** DiagnosticsDisplay：诊断错误列表展示（标签 + 行列位置 + 消息）。 */
function DiagnosticsDisplay(props: { diagnostics: readonly Diagnostic[] }): JSX.Element {
  const i18n = useI18n()

  return (
    <Show when={props.diagnostics.length > 0}>
      <div data-component="diagnostics">
        <For each={props.diagnostics}>
          {(diagnostic) => (
            <div data-slot="diagnostic">
              <span data-slot="diagnostic-label">{i18n.t("ui.messagePart.diagnostic.error")}</span>
              <span data-slot="diagnostic-location">
                [{diagnostic.range.start.line + 1}:{diagnostic.range.start.character + 1}]
              </span>
              <span data-slot="diagnostic-message">{diagnostic.message}</span>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}

// relativizeProjectPath：把绝对路径转为相对项目目录的展示路径。
// 目录为空/根目录时原样返回；路径即目录本身时返回空串；不在目录前缀下则原样返回。
function relativizeProjectPath(path: string, directory?: string) {
  if (!path) return ""

  if (!directory) return path

  if (directory === "/") return path

  if (directory === "\\") return path

  if (path === directory) return ""

  // 依据目录中出现的分隔符判断平台风格
  const separator = directory.includes("\\") ? "\\" : "/"
  const prefix = directory.endsWith(separator) ? directory : directory + separator

  if (!path.startsWith(prefix)) return path

  return path.slice(prefix.length)
}

export function displayDirectory(path: string | undefined) {
  const data = useData()

  return relativizeProjectPath(getDirectory(path), data.directory)
}

import { resolveFileDiff } from "../components/session-diff"

// taskAgentName：把代理原始名匹配到已知代理列表的显示名；无匹配则首字母大写兜底。
export function taskAgentName(raw: string | undefined, list?: readonly { name: string }[]) {
  if (!raw) return undefined
  const key = raw.toLowerCase()

  return (
    list?.find((entry) => entry.name === raw || entry.name.toLowerCase() === key)?.name ??
    `${raw[0].toUpperCase()}${raw.slice(1)}`
  )
}

// 网页搜索服务商的显示名映射
const webSearchProviderNames = new Map([
  ["tinyfish", "TinyFish"],
  ["opencode", "OpenCode"],
])

// webSearchProviderLabel：服务商名转可读标签（i18n），无服务商时用通用文案
function webSearchProviderLabel(provider: string | undefined, i18n: ReturnType<typeof useI18n>) {
  if (!provider) return i18n.t("ui.tool.websearch")
  const name = webSearchProviderNames.get(provider) ?? `${provider[0].toUpperCase()}${provider.slice(1)}`

  return i18n.t("ui.tool.websearch.provider", { provider: name })
}

// readArgs：把读取的 offset/limit 参数格式化为摘要片段
function readArgs(input: ToolInput) {
  return [
    ...(input.offset === undefined ? [] : [`offset=${input.offset}`]),
    ...(input.limit === undefined ? [] : [`limit=${input.limit}`]),
  ]
}

// skillToolName：技能工具的名称——元数据优先，其次输入的 id/name
function skillToolName(input: ToolInput, metadata: ToolMetadata) {
  return metadata.name ?? input.id ?? input.name
}

export function currentSkillName(tool: SessionMessageAssistantTool) {
  return skillToolName(toolInput(currentToolInput(tool)), toolMetadata(currentToolMetadata(tool)))
}

// toolTitle：分组标题只为工具命名一次；详细副标题属于具体的工具行。
function toolTitle(tool: SessionMessageAssistantTool, i18n: UiI18n) {
  switch (tool.name) {
    case "read":
      return i18n.t("ui.tool.read")
    case "list":
      return i18n.t("ui.tool.list")
    case "glob":
      return i18n.t("ui.tool.glob")
    case "grep":
      return i18n.t("ui.tool.grep")
    case "browser":
      return i18n.t("ui.tool.browser")
    case "webfetch":
      return i18n.t("ui.tool.webfetch")
    case "websearch":
      // 网页搜索带服务商名
      return webSearchProviderLabel(toolMetadata(currentToolMetadata(tool)).provider, i18n)
    case "subagent":
      return i18n.t("ui.tool.agent.default")
    case "shell":
      return i18n.t("ui.tool.shell")
    case "execute":
      return i18n.t("ui.tool.execute")
    case "edit":
      return i18n.t("ui.messagePart.title.edit")
    case "write":
      return i18n.t("ui.messagePart.title.write")
    case "patch":
      return i18n.t("ui.tool.patch")
    case "question":
      return i18n.t("ui.tool.questions")
    case "skill":
      return i18n.t("ui.tool.skill")
    default:
      // 未知工具直接显示原始名
      return tool.name
  }
}

export function urls(text: string | undefined) {
  if (!text) return []

  return [
    ...new Set(Array.from(text.matchAll(/https?:\/\/[^\s<>"'`)\]]+/g), (item) => item[0].replace(/[),.;:!?]+$/g, ""))),
  ]
}

export function sessionLink(id: string | undefined, href?: (id: string) => string | undefined) {
  if (!id) return undefined

  return href?.(id)
}

// taskSession：按描述与父会话 ID 找子代理会话——取最新创建且未归档的匹配项。
function taskSession(
  description: string | undefined,
  parentID: string | undefined,
  sessions: SessionSummary[] | undefined,
) {
  if (!parentID) return undefined

  return (sessions ?? [])
    .filter((session) => session.parentID === parentID && !session.time?.archived)
    .filter((session) => (description ? session.title?.startsWith(description) : true))
    .sort((a, b) => (b.time.created ?? 0) - (a.time.created ?? 0))[0]?.id
}

export function ExaOutput(props: { output?: string }) {
  const i18n = useI18n()
  const [showAll, setShowAll] = createSignal(false)
  // "查看更多"展开后的第一个链接（用于聚焦）
  let firstRevealedRef: HTMLAnchorElement | undefined
  const links = createMemo(() => urls(props.output))

  // 可见链接：默认只显示前 10 条
  const visibleLinks = createMemo(() => {
    const all = links()

    if (showAll() || all.length <= 10) return all

    return all.slice(0, 10)
  })

  const remaining = createMemo(() => Math.max(0, links().length - 10))

  const expand = (event: MouseEvent) => {
    event.stopPropagation()
    setShowAll(true)
    requestAnimationFrame(() => {
      firstRevealedRef?.focus()
    })
  }

  return (
    <Show when={links().length > 0}>
      <div data-component="exa-tool-output">
        <div data-slot="exa-tool-links">
          <For each={visibleLinks()}>
            {(url, index) => (
              <a
                ref={(el) => {
                  if (index() === 10) firstRevealedRef = el
                }}
                data-slot="exa-tool-link"
                class="webfetch-link"
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(event) => event.stopPropagation()}
              >
                <span data-slot="webfetch-link-text">{url}</span>
                <Icon name="outline-square-arrow" class="webfetch-link-icon" />
              </a>
            )}
          </For>
          <Show when={!showAll() && remaining() > 0}>
            <button type="button" data-slot="exa-tool-more" onClick={expand}>
              {i18n.plural("ui.common.moreCount", remaining())}
            </button>
          </Show>
        </div>
      </div>
    </Show>
  )
}

// 上下文分组条目类型：工具分片 / 推理分片（带 id 与流式标记）/ 通知或 shell 或文本（自带渲染函数）
export type ContextGroupPart =
  | SessionMessageAssistantTool
  | (SessionMessageAssistantReasoning & { id: string; streaming?: boolean })
  | { type: "notice" | "shell" | "text"; id: string; render: () => JSX.Element }

/**
 * CurrentContextToolGroup：当前上下文工具分组（折叠条）。
 * 把一次回合中的工具/推理/通知折叠成一行"N used X"，展开后逐条渲染；
 * 相邻的文件修改/读取/技能调用会聚合展示；运行中显示 Thinking/计时状态。
 */
export function CurrentContextToolGroup(props: {
  parts: ContextGroupPart[]
  busy: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  onSizeChange?: () => void
  reasoningDefaultOpen?: boolean
  reasoningOpen?: (id: string) => boolean | undefined
  onReasoningOpenChange?: (id: string, open: boolean) => void
  toolDefaultOpen?: (tool: SessionMessageAssistantTool) => boolean | undefined
  toolOpen?: (id: string) => boolean | undefined
  onToolOpenChange?: (id: string, open: boolean) => void
  fileOpen?: (path: string) => boolean | undefined
  onFileOpenChange?: (path: string, open: boolean) => void
  patchGroupKey?: (tools: SessionMessageAssistantTool[]) => string
}) {
  const i18n = useI18n()
  // 纯工具分片列表
  const tools = createMemo(() => props.parts.filter((part) => part.type === "tool"))

  // 是否有进行中的工作：父级忙碌或任一工具在流式/运行
  const pending = createMemo(
    () => props.busy || tools().some((tool) => tool.state.status === "streaming" || tool.state.status === "running"),
  )

  // 分组内出现过的工具名（去重后 i18n 列表化）
  const names = createMemo(() =>
    i18n.list([
      ...new Set(
        props.parts.flatMap((part) => {
          if (part.type !== "tool" && part.type !== "shell") return []

          return [part.type === "tool" ? toolTitle(part, i18n) : i18n.t("ui.tool.shell")]
        }),
      ),
    ]),
  )

  const reasoning = createMemo(() => props.parts.flatMap((part) => (part.type === "reasoning" ? [part] : [])))
  // 只有思考还不算已完成的工作，因此进行中的分组显示 Thinking 而不是 Working，
  // 也不会显示"用了 1 次思考"。
  const thinking = createMemo(() => props.busy && reasoning().length > 0 && reasoning().length === props.parts.length)
  // 当前时间信号（驱动思考计时）
  const [now, setNow] = createSignal(Date.now())

  createEffect(() => {
    if (!thinking()) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })

  // 思考耗时文案（秒/分秒/时分，本地化数字格式）
  const elapsed = createMemo(() => {
    const started = reasoning()[0]?.time?.created

    if (!thinking() || started === undefined) return ""
    const total = Math.max(0, Math.floor((now() - started) / 1000))
    const numfmt = new Intl.NumberFormat(i18n.locale())

    if (total < 60) return i18n.t("ui.message.duration.seconds", { count: numfmt.format(total) })

    if (total < 3600)
      return i18n.t("ui.message.duration.minutesSeconds", {
        minutes: numfmt.format(Math.floor(total / 60)),
        seconds: numfmt.format(total % 60),
      })

    return i18n.t("ui.message.duration.hoursMinutes", {
      hours: numfmt.format(Math.floor(total / 3600)),
      minutes: numfmt.format(Math.floor(total / 60) % 60),
    })
  })

  // 分组标题的拆分：把 i18n 文案拆成 前缀 + 数字 + 中缀 + 标题 + 后缀，便于分段渲染样式
  const label = createMemo(() => {
    const thoughts = reasoning().length

    if (thinking()) {
      const text = i18n.t("ui.sessionTurn.status.thinking")

      return { text, title: text, before: "", count: undefined, between: "", after: "" }
    }

    if (!names() && !thoughts) {
      const text = i18n.t("ui.messagePart.context.updates")

      return { text, title: "", before: text, count: undefined, between: "", after: "" }
    }

    const title = names() || i18n.plural("ui.messagePart.context.thought", thoughts)
    const count = props.parts.filter((part) => part.type === "tool" || part.type === "shell").length || thoughts
    const text = i18n.plural("ui.messagePart.tools.used", count, { tools: title })
    const index = text.indexOf(title)
    const before = text.slice(0, index).trim()
    const countText = String(count)
    const countIndex = before.indexOf(countText)
    const after = text.slice(index + title.length).trim()

    if (countIndex === -1) return { text, title, before, count: undefined, between: "", after }

    return {
      text,
      title,
      before: before.slice(0, countIndex).trim(),
      count,
      between: before.slice(countIndex + countText.length).trim(),
      after,
    }
  })

  // 展开时把分片聚合为渲染条目：相邻的文件修改/分组读取/同名技能合并成数组，其余单独成条
  const items = createMemo(() =>
    (props.open ? props.parts : []).reduce<
      (SessionMessageAssistantTool[] | Exclude<ContextGroupPart, SessionMessageAssistantTool>)[]
    >((groups, tool) => {
      // 非工具条目直接进列表
      if (tool.type !== "tool") {
        groups.push(tool)

        return groups
      }

      const previous = groups.at(-1)

      // 相邻文件修改工具合并
      if (isFileChangeTool(tool) && Array.isArray(previous) && previous[0] && isFileChangeTool(previous[0])) {
        previous.push(tool)

        return groups
      }

      // 相邻可分组的读取工具合并
      if (
        currentToolGroupedRead(tool) &&
        Array.isArray(previous) &&
        previous[0] &&
        currentToolGroupedRead(previous[0])
      ) {
        previous.push(tool)

        return groups
      }

      // 相邻同名技能（非错误）合并
      if (
        tool.name === "skill" &&
        tool.state.status !== "error" &&
        currentSkillName(tool) &&
        Array.isArray(previous) &&
        previous?.[0]?.name === "skill" &&
        previous[0].state.status !== "error" &&
        currentSkillName(previous[0])
      ) {
        previous.push(tool)

        return groups
      }

      groups.push([tool])

      return groups
    }, []),
  )

  // 文件修改组的键（供外层 diff 组渲染对齐）
  const patchKeys = createMemo(() => {
    const keys = new Map<SessionMessageAssistantTool, string>()
    items().forEach((item) => {
      if (!Array.isArray(item) || !item[0] || !isFileChangeTool(item[0])) return
      const key = props.patchGroupKey?.(item) ?? item[0].id
      item.forEach((tool) => keys.set(tool, key))
    })

    return keys
  })

  let root: HTMLDivElement | undefined

  // change：切换展开状态。从吸顶（stuck）头部收起时，先把视口滚回首部位置，
  // 否则内容变短会先钳制滚动位置，导致视口停在离分组很远的地方。
  const change = (open: boolean) => {
    const trigger = root?.querySelector(':scope > [data-component="collapsible"] > [data-slot="collapsible-trigger"]')
    const stuck = !open && root && trigger ? trigger.getBoundingClientRect().top - root.getBoundingClientRect().top : 0

    if (stuck > 0 && root) scrollParent(root)?.scrollBy({ top: -stuck, behavior: "instant" })
    props.onOpenChange(open)
    props.onSizeChange?.()
  }

  return (
    <div
      ref={root}
      data-component="collapsed-tool-group"
      data-timeline-part-ids={props.parts.map((part) => part.id).join(",")}
    >
      {/* 折叠条本体：眼镜图标 + 状态 + 标题触发行 */}
      <BasicTool
        icon="glasses"
        status={pending() ? "running" : "completed"}
        compact
        hasContent
        allowOpenWhilePending
        open={props.open}
        onOpenChange={change}
        trigger={
          <div data-component="context-tool-group-trigger" aria-label={label().text}>
            <span data-slot="context-tool-group-title">
              <Show when={label().before || label().count || label().between}>
                <span data-slot="context-tool-group-usage">
                  <Show when={label().before}>
                    {(before) => <span data-slot="context-tool-group-prefix">{before()}</span>}
                  </Show>
                  <Show when={label().count}>
                    {(count) => (
                      // 数字滚动动画
                      <span data-slot="context-tool-group-count">
                        <AnimatedNumber value={count()} />
                      </span>
                    )}
                  </Show>
                  <Show when={label().between}>
                    {(between) => <span data-slot="context-tool-group-prefix">{between()}</span>}
                  </Show>
                </span>
              </Show>
              <Show when={label().title}>
                {(title) => (
                  <span data-slot="basic-tool-tool-title">
                    {/* 思考中标题做微光效果 */}
                    <Show when={thinking()} fallback={title()}>
                      <TextShimmer text={title()} active />
                    </Show>
                  </span>
                )}
              </Show>
              <Show when={elapsed()}>{(value) => <span data-slot="basic-tool-tool-subtitle">{value()}</span>}</Show>
              <Show when={label().after}>
                {(after) => <span data-slot="context-tool-group-prefix">{after()}</span>}
              </Show>
            </span>
          </div>
        }
      >
        <div data-component="context-tool-group-list">
          <Index each={items()}>
            {(item) => {
              // 三类条目：工具组 / 推理 / 回调渲染
              const group = createMemo(() => {
                const value = item()

                return Array.isArray(value) ? value : undefined
              })

              const reasoning = createMemo(() => {
                const value = item()

                return !Array.isArray(value) && value.type === "reasoning" ? value : undefined
              })

              const callback = createMemo(() => {
                const value = item()

                return !Array.isArray(value) &&
                  (value.type === "notice" || value.type === "shell" || value.type === "text")
                  ? value
                  : undefined
              })

              return (
                <Show
                  when={group()}
                  fallback={
                    <Show
                      when={reasoning()}
                      fallback={
                        // 回调条目：直接调用其 render 函数
                        <Show when={callback()}>
                          {(part) => <div data-slot="context-tool-group-item">{part().render()}</div>}
                        </Show>
                      }
                    >
                      {(part) => (
                        <div data-slot="context-tool-group-item">
                          <AssistantReasoningContent
                            id={part().id}
                            content={part()}
                            streaming={part().streaming ?? false}
                            // 分组标题已表达"Thinking"，展开即显示思考内容本身。
                            defaultOpen={thinking() || props.reasoningDefaultOpen}
                            open={props.reasoningOpen?.(part().id)}
                            onOpenChange={(open) => props.onReasoningOpenChange?.(part().id, open)}
                            onContentRendered={props.onSizeChange}
                          />
                        </div>
                      )}
                    </Show>
                  }
                >
                  {(group) => {
                    // 工具组：以第一个工具为代表
                    const tool = createMemo(() => group()[0]!)
                    const trigger = createMemo(() => currentContextToolTrigger(tool(), i18n))

                    const skills = createMemo(() =>
                      group().flatMap((item) => {
                        const name = currentSkillName(item)

                        return name ? [name] : []
                      }),
                    )

                    // i18n 文案中的占位标记（用于拆分前后缀）
                    const marker = "__OPENCODE_LOADED_SKILL__"

                    const loaded = createMemo(() =>
                      i18n.plural("ui.tool.loadedSkills", skills().length, { name: marker }),
                    )

                    return (
                      <div data-slot="context-tool-group-item">
                        <Show
                          when={!currentToolGroupedRead(tool())}
                          fallback={
                            // 可分组的读取：渲染为读取工具组
                            <CurrentReadToolGroup
                              tools={group()}
                              open={props.toolOpen?.(tool().id)}
                              onOpenChange={(open) => props.onToolOpenChange?.(tool().id, open)}
                              onSizeChange={props.onSizeChange}
                            />
                          }
                        >
                          <Show
                            when={tool().state.status !== "error" && ["glob", "grep", "list"].includes(tool().name)}
                            fallback={
                              <Show
                                when={
                                  tool().name === "skill" && group().length > 1 && skills().length === group().length
                                }
                                fallback={
                                  <Show
                                    when={isFileChangeTool(tool())}
                                    fallback={
                                      // 普通单个工具：直接渲染 ToolDisplay
                                      <ToolDisplay
                                        id={tool().id}
                                        tool={tool().name}
                                        input={currentToolInput(tool())}
                                        metadata={currentToolMetadata(tool())}
                                        output={currentToolOutput(tool())}
                                        error={currentToolError(tool())}
                                        status={tool().state.status}
                                        defaultOpen={props.toolDefaultOpen?.(tool()) ?? false}
                                        open={props.toolOpen?.(tool().id) ?? props.toolDefaultOpen?.(tool())}
                                        onOpenChange={(open) => props.onToolOpenChange?.(tool().id, open)}
                                        deferContent
                                        virtualizeDiff={false}
                                        onContentRendered={props.onSizeChange}
                                      />
                                    }
                                  >
                                    {/* 文件修改组：渲染文件级折叠组（键前缀保证状态对齐） */}
                                    <CurrentFileToolGroup
                                      tools={group()}
                                      fileOpen={
                                        props.fileOpen &&
                                        ((path) => props.fileOpen?.(`${patchKeys().get(tool())}:${path}`))
                                      }
                                      onFileOpenChange={
                                        props.onFileOpenChange &&
                                        ((path, open) =>
                                          props.onFileOpenChange?.(`${patchKeys().get(tool())}:${path}`, open))
                                      }
                                      onSizeChange={props.onSizeChange}
                                    />
                                  </Show>
                                }
                              >
                                {/* 多技能加载：显示"Loaded skills: a, b, c"样式行 */}
                                <div
                                  data-component="tool-loaded-item"
                                  data-timeline-part-ids={group()
                                    .map((item) => item.id)
                                    .join(",")}
                                  aria-label={i18n.plural("ui.tool.loadedSkills", skills().length, {
                                    name: skills().join(", "),
                                  })}
                                >
                                  <span data-slot="tool-loaded-label" aria-hidden="true">
                                    {loaded().split(marker)[0]?.trim()}
                                  </span>
                                  <span data-slot="tool-loaded-value" aria-hidden="true">
                                    <For each={skills()}>
                                      {(name, index) => (
                                        <>
                                          <Show when={index() > 0}>, </Show>
                                          <TextShimmer
                                            as="span"
                                            text={name}
                                            active={["streaming", "running"].includes(group()[index()]!.state.status)}
                                          />
                                        </>
                                      )}
                                    </For>
                                  </span>
                                  <Show when={loaded().split(marker)[1]?.trim()}>
                                    {(suffix) => (
                                      <span data-slot="tool-loaded-kind" aria-hidden="true">
                                        {suffix()}
                                      </span>
                                    )}
                                  </Show>
                                </div>
                              </Show>
                            }
                          >
                            {/* glob/grep/list 组的触发行：标题 + 副标题 + 参数 + 命中数 */}
                            <div data-component="tool-trigger">
                              <div data-slot="basic-tool-tool-trigger-content">
                                <div data-slot="basic-tool-tool-info">
                                  <div data-slot="basic-tool-tool-info-structured">
                                    <div data-slot="basic-tool-tool-info-main">
                                      <span data-slot="basic-tool-tool-title">
                                        <TextShimmer
                                          text={trigger().title}
                                          active={
                                            tool().state.status === "streaming" || tool().state.status === "running"
                                          }
                                        />
                                      </span>
                                      <Show when={trigger().subtitle}>
                                        {(subtitle) => <span data-slot="basic-tool-tool-subtitle">{subtitle()}</span>}
                                      </Show>
                                      <For each={trigger().args}>
                                        {(arg) => <span data-slot="basic-tool-tool-arg">{arg}</span>}
                                      </For>
                                    </div>
                                    <Show when={trigger().matches}>
                                      {(matches) => (
                                        <>
                                          <span data-slot="context-tool-group-dot" />
                                          <span data-slot="context-tool-group-matches">{matches()}</span>
                                        </>
                                      )}
                                    </Show>
                                  </div>
                                </div>
                              </div>
                            </div>
                          </Show>
                        </Show>
                      </div>
                    )
                  }}
                </Show>
              )
            }}
          </Index>
        </div>
      </BasicTool>
    </div>
  )
}

/**
 * CurrentReadToolGroup：读取工具组——一行列出本次读取的多个文件名（含 offset/limit 参数）。
 * 单行放不下时显示箭头，点击展开完整列表；运行中标题带微光动画。
 */
export function CurrentReadToolGroup(props: {
  tools: SessionMessageAssistantTool[]
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onSizeChange?: () => void
}) {
  const i18n = useI18n()
  const [state, setState] = createStore({ truncated: false })
  const disclosure = createDisclosure({ open: () => props.open, onOpenChange: (open) => props.onOpenChange?.(open) })
  const open = disclosure.open
  const expandable = () => open() || state.truncated

  const pending = createMemo(() =>
    props.tools.some((tool) => tool.state.status === "streaming" || tool.state.status === "running"),
  )

  // 每个工具解析出 { id, 文件名, 参数摘要 }
  const files = createMemo(() =>
    props.tools.flatMap((tool) => {
      const input = toolInput(currentToolInput(tool))
      const name = getFilename(input.path ?? "")

      return name ? [{ id: tool.id, name, args: readArgs(input) }] : []
    }),
  )

  let list: HTMLSpanElement | undefined

  // measure：检测文件名列表是否溢出（scrollWidth > clientWidth）
  const measure = () => {
    if (!list || open()) return
    setState("truncated", list.scrollWidth > list.clientWidth)
  }

  createResizeObserver(() => list, measure)
  createEffect(on(files, measure))

  const toggle = () => {
    if (!expandable()) return
    disclosure.toggle()
    props.onSizeChange?.()
  }

  return (
    <div
      data-component="read-tool-group"
      data-timeline-part-ids={props.tools.map((tool) => tool.id).join(",")}
      data-expanded={open() ? "true" : undefined}
      role={expandable() ? "button" : undefined}
      tabIndex={expandable() ? 0 : undefined}
      aria-expanded={expandable() ? open() : undefined}
      onClick={toggle}
      onKeyDown={(event) => {
        // 键盘可达：Enter/空格切换展开
        if (event.key !== "Enter" && event.key !== " ") return
        event.preventDefault()
        toggle()
      }}
    >
      <div data-component="tool-trigger">
        <div data-slot="basic-tool-tool-trigger-content">
          <div data-slot="basic-tool-tool-info">
            <div data-slot="basic-tool-tool-info-structured">
              <div data-slot="basic-tool-tool-info-main">
                <span data-slot="basic-tool-tool-title">
                  <TextShimmer text={i18n.t("ui.tool.read")} active={pending()} />
                </span>
                <span ref={list} data-slot="basic-tool-tool-subtitle">
                  <Index each={files()}>
                    {(file, index) => (
                      <>
                        <Show when={index > 0}> </Show>
                        <span data-slot="read-tool-group-file" data-timeline-part-id={file().id}>
                          {file().name}
                          <For each={file().args}>
                            {(arg) => <span data-slot="basic-tool-tool-arg">{` ${arg}`}</span>}
                          </For>
                          <Show when={index < files().length - 1}>,</Show>
                        </span>
                      </>
                    )}
                  </Index>
                </span>
              </div>
            </div>
          </div>
        </div>
        <Show when={expandable()}>
          <span data-slot="read-tool-group-arrow" aria-hidden="true">
            <Icon name="fill-triangle-down" size="small" />
          </span>
        </Show>
      </div>
    </div>
  )
}

/**
 * CurrentFileToolGroup：文件修改工具组（edit/write/patch）——
 * 汇总各工具涉及的文件 diff，交给注册的 patch 渲染器统一展示。
 * 文件信息优先取元数据；元数据缺失时从输入参数现算 patch（edit 的新旧串、write 的全文）。
 */
export function CurrentFileToolGroup(props: {
  tools: SessionMessageAssistantTool[]
  fileOpen?: (path: string) => boolean | undefined
  onFileOpenChange?: (path: string, open: boolean) => void
  onSizeChange?: () => void
}) {
  // files：带记忆的 memo——增量合并新旧文件条目，避免滚动或局部更新时重建整个列表。
  const files = createMemo((previous: { key: string; toolID: string; value: FileDiffInfo }[]) => {
    const next = props.tools.flatMap((tool) => {
      const files = toolMetadata(currentToolMetadata(tool)).files ?? []

      // 无效条目不渲染，但元数据里的 files 仍会替换基于输入的预览。
      if (files.length > 0)
        return files.flatMap((value, index) =>
          changedFileDiff(value) ? [{ key: `${tool.id}:${index}`, toolID: tool.id, value }] : [],
        )
      const input = toolInput(currentToolInput(tool))

      if (input.path === undefined) return []

      // edit：由新旧字符串现算 diff 与增删行数
      if (tool.name === "edit" && input.oldString !== undefined && input.newString !== undefined) {
        const changes = diffLines(input.oldString, input.newString)

        const additions = changes
          .filter((change) => change.added)
          .reduce((total, change) => total + (change.count ?? 0), 0)

        const deletions = changes
          .filter((change) => change.removed)
          .reduce((total, change) => total + (change.count ?? 0), 0)

        if (additions === 0 && deletions === 0) return []

        return [
          {
            key: `${tool.id}:0`,
            toolID: tool.id,
            value: {
              file: input.path,
              patch: createTwoFilesPatch(input.path, input.path, input.oldString, input.newString),
              additions,
              deletions,
              status: "modified" as const,
            },
          },
        ]
      }

      // write：内容全量新增
      if (tool.name !== "write" || !input.content) return []

      return [
        {
          key: `${tool.id}:0`,
          toolID: tool.id,
          value: {
            file: input.path,
            patch: createTwoFilesPatch(input.path, input.path, "", input.content),
            additions: input.content.split("\n").length - Number(input.content.endsWith("\n")),
            deletions: 0,
            status: "modified" as const,
          },
        },
      ]
    })

    const updates = new Map(next.map((entry) => [entry.key, entry.value]))
    const existing = new Set(previous.map((entry) => entry.key))
    const owners = new Set(props.tools.map((tool) => tool.id))

    const result = [
      ...previous.flatMap((entry) => {
        // 只保留仍属于当前工具集的旧条目
        if (!owners.has(entry.toolID)) return []
        const value = updates.get(entry.key)

        if (!value || samePatchFile(value, entry.value)) return [entry]

        return [{ ...entry, value }]
      }),
      ...next.filter((entry) => !existing.has(entry.key)),
    ]

    // 完全一致时返回旧引用，避免下游重渲染
    return result.length === previous.length && result.every((entry, index) => entry === previous[index])
      ? previous
      : result
  }, [])

  const metadata = createMemo(() => ({
    files: files().map((entry) => entry.value),
  }))

  const pending = createMemo(() =>
    props.tools.some((tool) => tool.state.status === "streaming" || tool.state.status === "running"),
  )

  // patch 渲染器：注册了专用组件就用它，否则退回通用渲染
  const render = ToolRegistry.render("patch") ?? GenericTool

  const tool = createMemo(() => {
    const name = props.tools[0]?.name

    return name === "edit" || name === "write" ? name : "patch"
  })

  return (
    <div
      data-component="tool-part-wrapper"
      data-timeline-part-id={props.tools.length === 1 ? props.tools[0]?.id : undefined}
      data-timeline-part-ids={props.tools.length > 1 ? props.tools.map((tool) => tool.id).join(",") : undefined}
    >
      <Dynamic
        component={render}
        tool={tool()}
        input={{}}
        metadata={metadata()}
        status={pending() ? "running" : "completed"}
        fileOpen={props.fileOpen}
        onFileOpenChange={props.onFileOpenChange}
        deferContent
        virtualizeDiff={false}
        onContentRendered={props.onSizeChange}
      />
    </div>
  )
}

export function scrollParent(element: HTMLElement): HTMLElement | undefined {
  const parent = element.parentElement

  if (!parent) return

  if (/auto|scroll/.test(getComputedStyle(parent).overflowY)) return parent

  return scrollParent(parent)
}

// isFileChangeTool：非错误的 edit/write/patch 工具算文件修改类
function isFileChangeTool(tool: SessionMessageAssistantTool) {
  return tool.state.status !== "error" && (tool.name === "edit" || tool.name === "write" || tool.name === "patch")
}

export function samePatchFile(a: FileDiffInfo, b: FileDiffInfo) {
  return (
    a === b ||
    (a.file === b.file &&
      a.patch === b.patch &&
      a.additions === b.additions &&
      a.deletions === b.deletions &&
      a.status === b.status)
  )
}

// currentContextToolTrigger：list/glob/grep 组触发行的标题/副标题/参数/命中数
function currentContextToolTrigger(tool: SessionMessageAssistantTool, i18n: ReturnType<typeof useI18n>) {
  const input = toolInput(currentToolInput(tool))
  const metadata = toolMetadata(currentToolMetadata(tool))
  const subtitle = displayDirectory(input.path ?? "/")

  const matches = (count: number | undefined) =>
    count ? i18n.plural("ui.messagePart.context.match", count) : undefined

  if (tool.name === "list") return { title: i18n.t("ui.tool.list"), subtitle, args: [], matches: undefined }

  if (tool.name === "glob")
    return {
      title: i18n.t("ui.tool.glob"),
      subtitle,
      args: input.pattern ? [`pattern=${input.pattern}`] : [],
      matches: matches(metadata.count),
    }

  return {
    title: i18n.t("ui.tool.grep"),
    subtitle,
    args: [
      ...(input.pattern ? [`pattern=${input.pattern}`] : []),
      ...(input.include ? [`include=${input.include}`] : []),
    ],
    matches: matches(metadata.matches),
  }
}

// SAFETY: 工具输入与元数据是各工具共享的开放记录。GenericTool 会展示任意输入键，
// 各渲染器用 `toolInput`/`toolMetadata` 解码自己关心的字段。
export interface ToolProps {
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- see SAFETY above
  input: Record<string, unknown>
  error?: string
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- see SAFETY above
  metadata: Record<string, unknown>
  tool: string
  sessionID?: string
  output?: string
  status?: string
  hideDetails?: boolean
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  fileOpen?: (path: string) => boolean | undefined
  onFileOpenChange?: (path: string, open: boolean) => void
  deferContent?: boolean
  virtualizeDiff?: boolean
  onContentRendered?: () => void
  /** patch 视图改为列出这些路径（不含变更统计与 diff），替代 `metadata.files`。 */
  pendingFiles?: readonly string[]
  forceOpen?: boolean
  locked?: boolean
}

type ToolComponent = Component<ToolProps>

// 工具注册表：名称 -> 渲染组件
const state: Record<
  string,
  {
    name: string
    render?: ToolComponent
  }
> = {}

// registerTool：登记工具渲染器
function registerTool(input: { name: string; render?: ToolComponent }) {
  state[input.name] = input

  return input
}

// getTool：按名称取渲染器
function getTool(name: string) {
  return state[name]?.render
}

// ToolRegistry：对外暴露注册与查询
export const ToolRegistry = {
  register: registerTool,
  render: getTool,
}

export function FileTool(props: ToolProps & { title: string; count: number; children?: JSX.Element }) {
  const i18n = useI18n()

  return (
    <BasicTool
      {...props}
      open
      onOpenChange={undefined}
      locked
      icon="code-lines"
      hasContent
      defer={false}
      rail={false}
      trigger={{
        title: props.title,
        subtitle: props.count > 0 ? `${props.count} ${i18n.plural("ui.common.file", props.count)}` : "",
      }}
    >
      {props.children}
    </BasicTool>
  )
}

export function FileAccordionGroup(props: { children: JSX.Element }) {
  return (
    <div
      data-component="accordion"
      data-scope="apply-patch"
      onKeyDown={(event) => {
        // 已被处理或带修饰键时不拦截
        if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return

        if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return

        // 只响应组内的手风琴触发按钮
        if (!(event.target instanceof HTMLButtonElement) || event.target.dataset.slot !== "accordion-trigger") return

        if (event.target.closest('[data-component="accordion"]') !== event.currentTarget) return

        const triggers = [
          ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
            ':scope > [data-slot="accordion-item"] > [data-slot="accordion-header"] > [data-slot="accordion-trigger"]',
          ),
        ]

        const index = triggers.indexOf(event.target)

        if (index < 0) return
        event.preventDefault()

        if (event.key === "Home") return triggers[0]?.focus()

        if (event.key === "End") return triggers.at(-1)?.focus()
        // 环形移动焦点
        triggers[(index + (event.key === "ArrowDown" ? 1 : -1) + triggers.length) % triggers.length]?.focus()
      }}
    >
      {props.children}
    </div>
  )
}

/** FileAccordionItem：单个手风琴项——可粘性吸顶的头部按钮 + 按需渲染的内容区。 */
function FileAccordionItem(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  type?: string
  header: JSX.Element
  children: JSX.Element
}) {
  const id = createUniqueId()

  return (
    <div
      data-slot="accordion-item"
      data-type={props.type}
      data-expanded={props.open ? "" : undefined}
      data-closed={!props.open ? "" : undefined}
    >
      <h3
        data-slot="accordion-header"
        data-component="sticky-accordion-header"
        data-expanded={props.open ? "" : undefined}
        data-closed={!props.open ? "" : undefined}
      >
        <button
          type="button"
          id={`${id}-trigger`}
          data-slot="accordion-trigger"
          data-expanded={props.open ? "" : undefined}
          data-closed={!props.open ? "" : undefined}
          aria-expanded={props.open}
          aria-controls={props.open ? `${id}-content` : undefined}
          onClick={() => batch(() => props.onOpenChange(!props.open))}
        >
          {props.header}
        </button>
      </h3>
      <Show when={props.open}>
        <div
          id={`${id}-content`}
          role="region"
          aria-labelledby={`${id}-trigger`}
          data-slot="accordion-content"
          data-expanded=""
        >
          {props.children}
        </div>
      </Show>
    </div>
  )
}

/** ToolFileAccordion：工具文件的手风琴包装——文件图标 + 目录/文件名头部，支持延迟挂载内容。 */
function ToolFileAccordion(props: {
  path: string
  actions?: JSX.Element
  children: JSX.Element
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  forceOpen?: boolean
  defer?: boolean
}) {
  const disclosure = createDisclosure({
    open: () => props.open,
    defaultOpen: () => props.defaultOpen ?? false,
    forceOpen: () => props.forceOpen ?? false,
    defer: () => props.defer ?? false,
    onOpenChange: (open) => props.onOpenChange?.(open),
  })

  return (
    <FileAccordionGroup>
      <FileAccordionItem
        open={disclosure.open()}
        onOpenChange={disclosure.setOpen}
        header={
          <div data-slot="apply-patch-trigger-content">
            <div data-slot="apply-patch-file-info">
              <FileIcon node={{ path: props.path, type: "file" }} />
              <div data-slot="apply-patch-file-name-container">
                <Show when={props.path.includes("/")}>
                  {/* \u202A/\u202C：LRM 控制字符包裹目录，防止 RTL 文本反向渲染 */}
                  <span data-slot="apply-patch-directory">{`\u202A${displayDirectory(props.path)}\u202C`}</span>
                </Show>
                <span data-slot="apply-patch-filename">{getFilename(props.path)}</span>
              </div>
            </div>
            <div data-slot="apply-patch-trigger-actions">
              {props.actions}
              <Icon name="chevron-grabber-vertical" size="small" />
            </div>
          </div>
        }
      >
        {/* defer 模式下只有首次展开后才挂载内容 */}
        <Show when={!props.defer || disclosure.mounted()}>{props.children}</Show>
      </FileAccordionItem>
    </FileAccordionGroup>
  )
}

/**
 * ToolDisplay：单个工具分片的对外渲染入口。
 * todowrite 不展示；运行中的 question 隐藏；有错误渲染错误卡片（可跳转子代理会话），
 * 否则交给注册的工具渲染器。
 */
export function ToolDisplay(
  props: ToolProps & {
    id: string
    error?: string
  },
) {
  const data = useData()
  const i18n = useI18n()

  if (props.tool === "todowrite") return null
  const hideQuestion = () => props.tool === "question" && (props.status === "streaming" || props.status === "running")

  // 子代理会话 ID（用于错误卡片跳转）
  const taskId = createMemo(() => {
    if (props.tool !== "subagent") return undefined

    return toolMetadata(props.metadata).sessionID || undefined
  })

  const taskHref = createMemo(() => sessionLink(taskId(), data.sessionHref))

  const taskSubtitle = createMemo(() => {
    if (props.tool !== "subagent") return undefined

    return toolInput(props.input).description || taskId()
  })

  const errorSubtitle = createMemo(() => toolErrorSubtitle(props, i18n))
  const error = createMemo(() => toolDisplayError(props))
  const stopped = createMemo(() => stoppedShell({ ...props, metadata: toolMetadata(props.metadata) }))
  const render = createMemo(() => ToolRegistry.render(props.tool) ?? GenericTool)

  return (
    <Show when={!hideQuestion()}>
      <div data-component="tool-part-wrapper" data-timeline-part-id={props.id}>
        <Switch>
          <Match when={stopped()}>
            {(stopped) => (
              <>
                <Dynamic component={render()} {...props} output={stopped().output} />
                <ToolErrorCard tool={props.tool} error={stopped().notice} subtitle={errorSubtitle()} />
              </>
            )}
          </Match>
          <Match when={error()}>
            {(error) => {
              const cleaned = error().replace("Error: ", "")

              // 用户关闭的提问：渲染为右侧的弱化文案而不是错误卡
              if (props.tool === "question" && cleaned.includes("dismissed this question")) {
                return (
                  <div style="width: 100%; display: flex; justify-content: flex-end;">
                    <span class="text-13-regular text-v2-text-text-faint cursor-default">
                      {i18n.t("ui.messagePart.questions.dismissed")}
                    </span>
                  </div>
                )
              }

              return (
                <ToolErrorCard
                  tool={props.tool}
                  error={error()}
                  title={
                    props.tool === "websearch"
                      ? webSearchProviderLabel(toolMetadata(props.metadata).provider, i18n)
                      : undefined
                  }
                  defaultOpen={props.defaultOpen}
                  open={props.open}
                  onOpenChange={props.onOpenChange}
                  subtitle={taskSubtitle() ?? errorSubtitle()}
                  href={taskHref()}
                  onSubtitleClick={(event) => {
                    // 仅左键且无修饰键时跳转到子代理会话
                    if (!data.navigateToSession) return

                    if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
                    const id = taskId()

                    if (!id) return
                    event.preventDefault()
                    data.navigateToSession(id)
                  }}
                />
              )
            }}
          </Match>
          <Match when={true}>
            <Dynamic component={render()} {...props} />
          </Match>
        </Switch>
      </div>
    </Show>
  )
}

// Each branch must stay in sync with its tool trigger's subtitle expression so
// failed rows read like their non-error counterparts ("Shell sleep 30").
export function toolErrorSubtitle(props: ToolProps, i18n: UiI18n) {
  const input = toolInput(props.input)
  const metadata = toolMetadata(props.metadata)

  if (props.tool === "shell") return input.command || metadata.command || undefined

  if (props.tool === "read" || props.tool === "edit" || props.tool === "write") return getFilename(input.path ?? "")

  if (props.tool === "list" || props.tool === "glob" || props.tool === "grep")
    return displayDirectory(input.path || "/")

  if (props.tool === "webfetch") return input.url || undefined

  if (props.tool === "websearch") return input.query || undefined

  if (props.tool === "skill") return skillToolName(input, metadata)

  if (props.tool === "patch") {
    const count = new Set((metadata.files ?? []).flatMap((file) => (changedFileDiff(file) ? [file.file] : []))).size

    if (count === 0) return undefined

    return `${count} ${i18n.plural("ui.common.file", count)}`
  }

  if (props.tool === "question") {
    const count = questions(input).length

    if (count === 0) return undefined

    return `${count} ${i18n.plural("ui.common.question", count)}`
  }

  return undefined
}

export function toolDisplayError(props: ToolProps & { error?: string }) {
  // Code Mode failures render inline in the execution's call list.
  if (props.tool === "execute") return undefined

  if (props.status === "error") return props.error

  return undefined
}

// 注册 read 工具渲染：读取的图片内容 + 附加加载文件列表
ToolRegistry.register({
  name: "read",
  render(props) {
    const data = useData()
    const i18n = useI18n()
    // 完成态才解析图片路径
    const image = createMemo(() => (props.status === "completed" ? readImagePath(props.input) : undefined))

    const loaded = createMemo(() => {
      if (props.status !== "completed") return []

      return (toolMetadata(props.metadata).loaded ?? []).flatMap((path) => Option.toArray(decodeString(path)))
    })

    // 相对化展示路径（去掉开头的分隔符）
    const paths = createMemo(() =>
      loaded().map((filepath) => {
        const relative = relativizeProjectPath(filepath, data.directory)

        return relative === filepath ? relative : relative.replace(/^[/\\]/, "")
      }),
    )

    const marker = "__OPENCODE_LOADED_PATH__"
    const parts = createMemo(() => i18n.t("ui.tool.loadedFile", { path: marker }).split(marker))

    return (
      <>
        <BasicTool
          {...props}
          icon="glasses"
          hasContent={!!image()}
          defer
          onOpenChange={(open) => {
            props.onOpenChange?.(open)
            props.onContentRendered?.()
          }}
          trigger={{
            title: i18n.t("ui.tool.read"),
            subtitle: getFilename(toolInput(props.input).path ?? ""),
            args: readArgs(toolInput(props.input)),
          }}
        >
          <Show when={image()} keyed>
            {(path) => <ReadImage path={path} onContentRendered={props.onContentRendered} />}
          </Show>
        </BasicTool>
        <Show when={paths().length > 0}>
          <div
            data-component="tool-loaded-item"
            aria-label={i18n.t("ui.tool.loadedFile", { path: paths().join(", ") })}
          >
            <span data-slot="tool-loaded-label" aria-hidden="true">
              {parts()[0]?.trim()}
            </span>
            <span data-slot="tool-loaded-value" aria-hidden="true">
              {paths().join(", ")}
            </span>
            <Show when={parts()[1]?.trim()}>
              {(suffix) => (
                <span data-slot="tool-loaded-kind" aria-hidden="true">
                  {suffix()}
                </span>
              )}
            </Show>
          </div>
        </Show>
      </>
    )
  },
})

function ReadImage(props: { path: string; onContentRendered?: () => void }) {
  const markdown = useMarkdown()
  const previewImages = createImagePreview()
  let root!: HTMLDivElement
  createEffect(() => {
    previewImages(root)

    if (!markdown?.readImage) return
    const images = createMarkdownImages(markdown.readImage)
    images.update(root)
    onCleanup(() => images.dispose())
  })
  onMount(() => props.onContentRendered?.())

  return (
    <div ref={root} data-component="read-image">
      <img
        data-local-image={props.path}
        alt={getFilename(props.path)}
        onLoad={() => props.onContentRendered?.()}
        onError={() => props.onContentRendered?.()}
      />
    </div>
  )
}

// 注册 list 工具渲染：目录列表，输出用 markdown 展示（可滚动区域）
ToolRegistry.register({
  name: "list",
  render(props) {
    const i18n = useI18n()

    return (
      <BasicTool
        {...props}
        icon="bullet-list"
        hasContent={!!props.output}
        trigger={{
          title: i18n.t("ui.tool.list"),
          subtitle: displayDirectory(toolInput(props.input).path ?? "/"),
        }}
      >
        <Show when={props.output}>
          <div
            data-component="tool-output"
            data-scrollable
            tabIndex={0}
            role="region"
            aria-label={i18n.t("ui.scrollView.ariaLabel")}
          >
            <Markdown text={props.output!} />
          </div>
        </Show>
      </BasicTool>
    )
  },
})

// 注册 glob 工具渲染：模式匹配的文件列表
ToolRegistry.register({
  name: "glob",
  render(props) {
    const i18n = useI18n()
    const input = createMemo(() => toolInput(props.input))

    return (
      <BasicTool
        {...props}
        icon="magnifying-glass-menu"
        hasContent={!!props.output}
        trigger={{
          title: i18n.t("ui.tool.glob"),
          subtitle: displayDirectory(input().path ?? "/"),
          args: input().pattern === undefined ? [] : ["pattern=" + input().pattern],
        }}
      >
        <Show when={props.output}>
          <div
            data-component="tool-output"
            data-scrollable
            tabIndex={0}
            role="region"
            aria-label={i18n.t("ui.scrollView.ariaLabel")}
          >
            <Markdown text={props.output!} />
          </div>
        </Show>
      </BasicTool>
    )
  },
})

// 注册 grep 工具渲染：内容搜索（pattern/include 参数）
ToolRegistry.register({
  name: "grep",
  render(props) {
    const i18n = useI18n()
    const input = createMemo(() => toolInput(props.input))

    const args = () => [
      ...(input().pattern === undefined ? [] : ["pattern=" + input().pattern]),
      ...(input().include === undefined ? [] : ["include=" + input().include]),
    ]

    return (
      <BasicTool
        {...props}
        icon="magnifying-glass-menu"
        hasContent={!!props.output}
        trigger={{
          title: i18n.t("ui.tool.grep"),
          subtitle: displayDirectory(input().path ?? "/"),
          args: args(),
        }}
      >
        <Show when={props.output}>
          <div
            data-component="tool-output"
            data-scrollable
            tabIndex={0}
            role="region"
            aria-label={i18n.t("ui.scrollView.ariaLabel")}
          >
            <Markdown text={props.output!} />
          </div>
        </Show>
      </BasicTool>
    )
  },
})

// 注册 webfetch 工具渲染：标题 + 可点击的 URL 链接（新窗口打开）
ToolRegistry.register({
  name: "webfetch",
  render(props) {
    const i18n = useI18n()
    const pending = createMemo(() => props.status === "streaming" || props.status === "running")

    const url = createMemo(() => toolInput(props.input).url ?? "")

    return (
      <BasicTool
        {...props}
        hideDetails
        icon="window-cursor"
        trigger={
          <div data-slot="basic-tool-tool-info-structured">
            <div data-slot="basic-tool-tool-info-main">
              <span data-slot="basic-tool-tool-title">
                <TextShimmer text={i18n.t("ui.tool.webfetch")} active={pending()} />
              </span>
              <Show when={props.status !== "streaming" && url()}>
                <a
                  data-slot="basic-tool-tool-subtitle"
                  class="webfetch-link"
                  href={url()}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(event) => event.stopPropagation()}
                >
                  <span data-slot="webfetch-link-text">{url()}</span>
                  <Icon name="outline-square-arrow" class="webfetch-link-icon" />
                </a>
              </Show>
            </div>
          </div>
        }
      />
    )
  },
})

// 注册 websearch 工具渲染：搜索查询 + 服务商标题，输出展示为链接列表
ToolRegistry.register({
  name: "websearch",
  render(props) {
    const i18n = useI18n()

    const query = createMemo(() => toolInput(props.input).query ?? "")

    const title = createMemo(() => webSearchProviderLabel(toolMetadata(props.metadata).provider, i18n))

    return (
      <BasicTool
        {...props}
        icon="window-cursor"
        trigger={{
          title: title(),
          subtitle: query(),
          subtitleClass: "exa-tool-query",
        }}
      >
        <ExaOutput output={props.output} />
      </BasicTool>
    )
  },
})

// 注册 subagent 工具渲染：子代理卡片——代理名/描述/会话链接，
// 用状态机区分委托中/运行中/后台/完成等视图。
ToolRegistry.register({
  name: "subagent",
  render(props) {
    const data = useData()
    const i18n = useI18n()

    const input = createMemo(() => toolInput(props.input))
    const metadata = createMemo(() => toolMetadata(props.metadata))

    // 子代理会话 ID：元数据优先；缺失时按"描述 + 父会话"在会话列表里推断
    const childSessionId = createMemo(
      () => metadata().sessionID || taskSession(input().description, data.sessionID, data.store.session),
    )

    const title = createMemo(() => taskAgentName(input().agent, data.store.agent) ?? i18n.t("ui.tool.agent.default"))

    // 运行状态机：结合工具状态与子会话忙碌状态推导
    const run = createMemo((state: SubagentRunState) => {
      const id = childSessionId()
      const childBusy = !!id && (data.store.session_status[id]?.type ?? "idle") !== "idle"

      return transitionSubagentRun(state, {
        type: "sync",
        props: subagentRunProps({ status: props.status, metadata: metadata() }, childBusy),
      })
    }, INITIAL_SUBAGENT_RUN_STATE)

    const view = createMemo(() => viewSubagentRun(run()))

    const subtitle = createMemo(() => input().description || childSessionId())

    const href = createMemo(() => sessionLink(childSessionId(), data.sessionHref))
    const clickable = createMemo(() => !!(childSessionId() && (data.navigateToSession || href())))

    const open = () => {
      const id = childSessionId()

      if (!id) return
      data.navigateToSession?.(id)
    }

    const navigate = (event: MouseEvent) => {
      // 仅左键且无修饰键时跳转
      if (!data.navigateToSession) return

      if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      event.preventDefault()
      open()
    }

    const navigateKey = (event: KeyboardEvent) => {
      if (!clickable() || href()) return

      if (event.key !== "Enter" && event.key !== " ") return
      event.preventDefault()
      open()
    }

    const trigger = () => (
      <div data-component="task-tool-card">
        <div data-component="task-tool-surface">
          <div data-slot="basic-tool-tool-info-structured">
            <div data-slot="basic-tool-tool-info-main">
              <Show when={view().running}>
                <SessionProgressIndicatorV2 />
              </Show>
              <span data-component="task-tool-title">{title()}</span>
              <Show when={subtitle()}>
                <span data-slot="basic-tool-tool-subtitle">{subtitle()}</span>
              </Show>
            </div>
            <Show when={clickable()}>
              <div data-component="task-tool-action">
                <Icon name="chevron-right" size="normal" />
              </div>
            </Show>
          </div>
        </div>
      </div>
    )

    return (
      <Show
        when={view().delegating}
        fallback={
          <BasicTool
            icon="task"
            status={view().basicStatus}
            trigger={trigger()}
            hideDetails
            triggerAsLink
            triggerHref={href()}
            clickable={clickable()}
            onTriggerClick={navigate}
            onTriggerKeyDown={navigateKey}
          />
        }
      >
        <div
          data-component="task-tool-delegating"
          class="flex h-9 w-fit max-w-full items-center gap-2 rounded-[8px] bg-v2-background-bg-layer-02 px-3 text-[13px] font-[530] leading-text-compact tracking-[-0.04px] text-v2-text-text-base"
        >
          <SessionProgressIndicatorV2 />
          <span class="min-w-0 truncate">{i18n.t("ui.tool.agent.delegating")}</span>
        </div>
      </Show>
    )
  },
})

export function ConsoleOutput(props: { command?: string; output: string }) {
  const i18n = useI18n()

  return (
    <div data-component="bash-output" data-variant="shell" dir="ltr">
      <div
        data-slot="bash-scroll"
        data-scrollable
        tabIndex={0}
        role="region"
        aria-label={i18n.t("ui.scrollView.ariaLabel")}
      >
        <Show when={props.command}>
          {(command) => (
            <div data-slot="bash-command">
              <ConsoleCopy text={command()} label={i18n.t("ui.message.copy")} />
              <pre data-slot="bash-pre">
                <code>{command()}</code>
              </pre>
            </div>
          )}
        </Show>
        <Show when={props.output}>
          {(output) => (
            <div data-slot="bash-result">
              <ConsoleCopy text={output()} label={i18n.t("ui.message.copyOutput")} />
              <pre data-slot="bash-pre">
                <code>
                  <LinkedText text={output()} />
                </code>
              </pre>
            </div>
          )}
        </Show>
      </div>
    </div>
  )
}

// The button sits beside its section's <pre>, not inside it, so selecting and copying text never picks it up.
export function ConsoleCopy(props: { text: string; label: string }) {
  const i18n = useI18n()
  const copy = createCopyFeedback()
  const label = () => (copy.copied() ? i18n.t("ui.message.copied") : props.label)

  return (
    <div data-slot="bash-copy">
      <Tooltip value={label()} placement="top">
        <IconButton
          icon={<Icon name={copy.copied() ? "check" : "outline-copy"} size="small" />}
          size="normal"
          variant="ghost-muted"
          // 阻止按钮获得焦点，避免破坏文本选择
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => copy.copy(props.text)}
          aria-label={label()}
        />
      </Tooltip>
    </div>
  )
}

// 注册 execute 工具渲染（Code Mode 脚本执行）：
// 行内显示脚本标题与子调用列表；运行失败时错误归属到失败的调用行。
ToolRegistry.register({
  name: "execute",
  render(props) {
    const i18n = useI18n()
    const dialog = useDialog()
    const pending = () => props.status === "streaming" || props.status === "running"
    const calls = createMemo(() => executeToolCalls(props.metadata))
    const subtitle = createMemo(() => executeToolSubtitle(calls()))
    const code = createMemo(() => (toolInput(props.input).code ?? "").trimEnd())

    // 运行时失败把输出显示在失败行；成功的脚本把结果显示在调用列表下方。
    const error = createMemo(() => {
      if (props.status !== "error" && props.metadata.error !== true) return undefined
      const fallback = i18n.t("ui.toolErrorCard.failed")
      const text = stripAnsi((props.status === "error" ? props.error : undefined) || props.output || fallback)

      return text.replace(/^Error:\s*/, "").trim() || fallback
    })

    const output = createMemo(() =>
      error()
        ? ""
        : stripAnsi(props.output ?? "")
            .replace(/\r\n?/g, "\n")
            .trim(),
    )

    // 运行时失败归属于抛出它的那个调用；脚本也可能在所有调用之外失败。
    const owner = createMemo(() => calls().findLastIndex((call) => call.status === "error"))

    const sawPending = pending()

    // 调用一旦离开 streaming 脚本就算已成形，对话框可以在运行期间展示它。
    const viewable = () => props.status !== "streaming" && !!code()

    const openDetails = () =>
      dialog.show(() => (
        <ExecuteDetails code={code()} output={output()} error={error()} calls={calls().length} status={props.status} />
      ))

    return (
      <BasicTool
        {...props}
        icon="console"
        rail={false}
        hasContent={calls().length > 0 || !!error() || !!output()}
        compact
        allowOpenWhilePending
        trigger={(open) => (
          <div data-slot="basic-tool-tool-info-structured">
            <div data-slot="basic-tool-tool-info-main">
              <span data-slot="basic-tool-tool-title">
                <TextShimmer text={i18n.t("ui.tool.execute")} active={pending()} />
              </span>
              <Show when={!open() && subtitle()}>
                {(text) => <ShellSubmessage text={text()} animate={sawPending} />}
              </Show>
            </div>
          </div>
        )}
        action={
          viewable() ? (
            <Tooltip value={i18n.t("ui.tool.execute.viewCode")} placement="top">
              <IconButton
                icon={<Icon name="code-slash" size="small" />}
                size="normal"
                variant="ghost"
                aria-label={i18n.t("ui.tool.execute.viewCode")}
                aria-haspopup="dialog"
                onClick={openDetails}
              />
            </Tooltip>
          ) : undefined
        }
      >
        <div data-component="execute-tool-calls">
          <Index each={calls()}>
            {(call, index) => <ExecuteCallRow call={call()} error={index === owner() ? error() : undefined} />}
          </Index>
          <Show when={owner() === -1 && error()}>{(text) => <ExecuteCallRow error={text()} />}</Show>
          <Show when={output()}>{(value) => <ExecuteOutputRow output={value()} />}</Show>
        </div>
      </BasicTool>
    )
  },
})

function ExecuteDetails(props: { code: string; output: string; error?: string; calls: number; status?: string }) {
  const i18n = useI18n()
  const fileComponent = useFileComponent()
  const lineCount = (text: string) => text.split("\n").length
  const lines = (text: string) => i18n.plural("ui.tool.execute.lines", lineCount(text))

  // Code Mode returns structured results as compact JSON; show those indented, and highlight a bare JSON result.
  const output = createMemo(() => formatExecuteOutput(props.output))

  // Code and output share one number gutter, sized to the longer block, so their content starts on the same column.
  const numberDigits = () =>
    String(Math.max(lineCount(props.code), props.output && !props.error ? lineCount(output().text) : 0)).length

  return (
    <Dialog fit containerClass="!w-[min(calc(100vw_-_32px),720px)] max-h-[calc(100vh_-_92px)]">
      <DialogHeader>
        <div data-slot="execute-details-title">
          <DialogTitle>{i18n.t("ui.tool.execute")}</DialogTitle>
          <span data-slot="execute-details-status" data-status={props.error ? "error" : props.status}>
            {props.error
              ? i18n.t("ui.toolErrorCard.failed")
              : props.status === "running"
                ? i18n.t("ui.tool.execute.running")
                : i18n.t("ui.tool.execute.completed")}
          </span>
          <span data-slot="execute-details-meta">{i18n.plural("ui.tool.execute.calls", props.calls)}</span>
        </div>
      </DialogHeader>
      <DialogBody class="min-h-0 flex-none overflow-y-auto">
        <div data-component="execute-details" style={{ "--execute-details-number-width": `${numberDigits()}ch` }}>
          <ExecuteDetailsSection
            label={i18n.t("ui.tool.execute.code")}
            meta={lines(props.code)}
            copy={props.code}
            copyLabel={i18n.t("ui.tool.execute.copyCode")}
          >
            <Dynamic
              component={fileComponent}
              mode="text"
              file={{ name: "execute.js", contents: props.code, cacheKey: checksum(props.code) }}
              overflow="wrap"
            />
          </ExecuteDetailsSection>
          <Show
            when={props.error}
            fallback={
              <Show when={props.output}>
                <ExecuteDetailsSection
                  label={i18n.t("ui.tool.execute.output")}
                  meta={lines(output().text)}
                  copy={output().text}
                  copyLabel={i18n.t("ui.tool.execute.copyOutput")}
                >
                  <Dynamic
                    component={fileComponent}
                    mode="text"
                    file={{
                      name: output().json !== undefined && output().rest === undefined ? "output.json" : "output.txt",
                      contents: output().text,
                      cacheKey: checksum(output().text),
                    }}
                    overflow="wrap"
                  />
                </ExecuteDetailsSection>
              </Show>
            }
          >
            {(error) => (
              <ExecuteDetailsSection
                label={i18n.t("ui.tool.execute.error")}
                copy={error()}
                copyLabel={i18n.t("ui.toolErrorCard.copyError")}
              >
                <pre data-slot="execute-details-error">{error()}</pre>
              </ExecuteDetailsSection>
            )}
          </Show>
        </div>
      </DialogBody>
    </Dialog>
  )
}

/** ExecuteDetailsSection：详情对话框的单个区块——标签/元信息/复制按钮 + 内容。 */
function ExecuteDetailsSection(props: {
  label: string
  meta?: string
  copy: string
  copyLabel: string
  children: JSX.Element
}) {
  const i18n = useI18n()
  const copy = createCopyFeedback()

  return (
    <section data-slot="execute-details-section">
      <header data-slot="execute-details-section-header">
        <span data-slot="execute-details-section-label">{props.label}</span>
        <Show when={props.meta}>{(meta) => <span data-slot="execute-details-section-meta">{meta()}</span>}</Show>
        <Tooltip value={copy.copied() ? i18n.t("ui.message.copied") : props.copyLabel} placement="top">
          <IconButton
            icon={<Icon name={copy.copied() ? "check" : "outline-copy"} size="small" />}
            size="normal"
            variant="ghost-muted"
            aria-label={copy.copied() ? i18n.t("ui.message.copied") : props.copyLabel}
            onClick={() => copy.copy(props.copy)}
          />
        </Tooltip>
      </header>
      <div data-slot="execute-details-source">{props.children}</div>
    </section>
  )
}

function ExecuteOutputRow(props: { output: string }) {
  const i18n = useI18n()
  const [open, setOpen] = createSignal(false)
  const text = createMemo(() => formatExecuteOutput(props.output).text)

  const toggle = () => {
    if (window.getSelection()?.toString()) return
    setOpen((value) => !value)
  }

  return (
    <div data-slot="execute-tool-call-item">
      <div
        data-slot="execute-tool-call"
        data-kind="output"
        role="button"
        tabIndex={0}
        aria-expanded={open()}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return
          event.preventDefault()
          toggle()
        }}
      >
        <span data-slot="execute-tool-call-marker">
          <span data-slot="execute-tool-call-arrow">›</span>
        </span>
        <span data-slot="execute-tool-call-name">{i18n.t("ui.tool.execute.output")}</span>
        <span data-slot="execute-tool-call-args">
          {i18n.plural("ui.tool.execute.lines", text().split("\n").length)}
        </span>
      </div>
      <Show when={open()}>
        <div data-slot="execute-tool-output">
          <ConsoleOutput output={text()} />
        </div>
      </Show>
    </div>
  )
}

/** ExecuteCallRow：execute 的单条子调用行——折叠显示工具名与参数摘要，可展开输入/错误。 */
function ExecuteCallRow(props: { call?: ExecuteToolCall; error?: string }) {
  const [open, setOpen] = createSignal(false)
  const args = createMemo(() => (props.call ? executeToolCallArgs(props.call) : []))
  const input = createMemo(() => Object.entries(props.call?.input ?? {}))
  // 无调用（纯错误）或调用出错都算失败
  const failed = () => !props.call || props.call.status === "error"
  const expandable = () => input().length > 0 || !!props.error
  const summary = () => (props.call ? args().join(", ") : props.error?.split("\n", 1)[0])

  const toggle = () => {
    // 有文本选区时不切换（用户在复制内容）
    if (!expandable() || window.getSelection()?.toString()) return
    setOpen((value) => !value)
  }

  return (
    <div data-slot="execute-tool-call-item">
      <div
        data-slot="execute-tool-call"
        data-status={failed() ? "error" : props.call?.status}
        data-expanded={open() ? "true" : undefined}
        dir="ltr"
        role={expandable() ? "button" : undefined}
        tabIndex={expandable() ? 0 : undefined}
        aria-expanded={expandable() ? open() : undefined}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return
          event.preventDefault()
          toggle()
        }}
      >
        <Show when={failed()} fallback={<span data-slot="execute-tool-call-marker">›</span>}>
          <span data-slot="execute-tool-call-marker">
            <Icon name="outline-hexagonal-warning" size="small" />
          </span>
        </Show>
        <Show when={props.call}>
          {(call) => (
            <span data-slot="execute-tool-call-name">
              <TextShimmer text={call().tool} active={call().status === "running"} />
            </span>
          )}
        </Show>
        <Show when={!open() && summary()}>
          {(text) => (
            <span data-slot="execute-tool-call-args" title={text()}>
              {props.call ? `[${text()}]` : text()}
            </span>
          )}
        </Show>
        <Show when={props.error}>
          <span data-slot="execute-tool-call-arrow">›</span>
        </Show>
      </div>
      <Show when={open()}>
        <Show when={input().length > 0}>
          <dl data-slot="execute-tool-call-input" dir="ltr">
            <For each={input()}>
              {([key, value]) => (
                <div data-slot="execute-tool-call-input-entry">
                  <dt>{key}:</dt>
                  <dd>{Option.getOrElse(decodeString(value), () => JSON.stringify(value, null, 2))}</dd>
                </div>
              )}
            </For>
          </dl>
        </Show>
        <Show when={props.error}>
          {(error) => (
            <div data-slot="execute-tool-error" dir="ltr">
              <LinkedText text={error()} />
            </div>
          )}
        </Show>
      </Show>
    </div>
  )
}

// 注册 shell 工具渲染：用运行状态机管理 写入中/运行中/后台/完成 各阶段，
// 后台 shell 通过 follower 持续接收输出流。
ToolRegistry.register({
  name: "shell",
  render(props) {
    const i18n = useI18n()
    const data = useData()

    // 计算当前应由状态机消费的 props（结合 shell 是否仍在注册表中运行）
    const runProps = () =>
      shellRunProps(
        {
          status: props.status,
          input: toolInput(props.input),
          metadata: toolMetadata(props.metadata),
          output: props.output,
        },
        (id) => data.shellRunning?.(id) === true,
      )

    const [run, setRun] = createSignal(createShellRunState(untrack(runProps)))

    const dispatch = (event: ShellRunEvent) => {
      const next = transitionShellRun(untrack(run), event)

      if (next !== untrack(run)) setRun(next)
    }

    // 同步派发 sync 事件，保证这一行永远不会以旧阶段渲染一帧。
    createComputed(on(runProps, (value) => dispatch({ type: "sync", props: value }), { defer: true }))
    const view = createMemo(() => viewShellRun(run()))
    // 只有当行挂载时模型还在写命令，触发行才播放命令入场动画。
    const animateCommand = untrack(run).status === "writing"

    function Output() {
      const followID = createMemo(() => view().follow?.id)
      const followRunning = createMemo(() => view().follow?.running === true)

      createEffect(() => {
        const id = followID()
        const load = data.shellOutput

        if (id === undefined || !load) return

        const follower = createShellFollower({
          id,
          directory: data.directory,
          running: untrack(followRunning),
          load,
          onOutput: (output) => dispatch({ type: "output.received", shellID: id, output }),
        })

        createEffect(on(followRunning, (running) => follower.setRunning(running), { defer: true }))
        onCleanup(follower.dispose)
      })

      return <ConsoleOutput command={view().command} output={view().output} />
    }

    return (
      <BasicTool
        {...props}
        status={view().basicStatus}
        icon="console"
        rail={false}
        hasContent
        compact
        allowOpenWhilePending
        trigger={(open) => (
          <div data-slot="basic-tool-tool-info-structured">
            <div data-slot="basic-tool-tool-info-main">
              <span data-slot="basic-tool-tool-title">
                <TextShimmer text={i18n.t("ui.tool.shell")} active={view().pending} />
              </span>
              <Show when={!open()}>
                <Show
                  when={view().command}
                  fallback={
                    <Show when={view().writingPlaceholder}>
                      <span data-slot="basic-tool-tool-subtitle">{i18n.t("ui.tool.shell.writingCommand")}</span>
                    </Show>
                  }
                >
                  {(command) => <ShellSubmessage text={command()} animate={animateCommand} />}
                </Show>
              </Show>
            </div>
          </div>
        )}
      >
        <Output />
      </BasicTool>
    )
  },
})

/** SessionShellMessage：独立的 shell 消息（用户手动执行）——复用 shell 工具渲染器。 */
export function SessionShellMessage(props: {
  message: SessionMessageShell
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const i18n = useI18n()
  const render = ToolRegistry.render("shell") ?? GenericTool

  // 归纳错误文案：超时/被取消/非零退出
  const error = createMemo(() => {
    const message = props.message

    if (message.status === "timeout") return i18n.t("ui.tool.shell.timeout")

    if (message.status === "killed") return i18n.t("ui.tool.shell.cancelled")

    if (message.status !== "exited" || message.exit === undefined || message.exit === 0) return

    return i18n.t("ui.tool.shell.exit", { code: message.exit })
  })

  return (
    <div data-component="session-shell-message" data-timeline-part-id={props.message.id}>
      {/* 以 shell 工具的形态渲染消息本体 */}
      <Dynamic
        component={render}
        tool="shell"
        input={{ command: props.message.command }}
        metadata={{
          shellID: props.message.shellID,
          status: props.message.status,
          exit: props.message.exit,
          truncated: props.message.output?.truncated,
        }}
        output={props.message.output?.output}
        status={props.message.status === "running" ? "running" : "completed"}
        defaultOpen={props.defaultOpen}
        open={props.open}
        onOpenChange={props.onOpenChange}
      />
      <Show when={error()}>
        {(error) => <ToolErrorCard tool="shell" error={error()} subtitle={props.message.command} />}
      </Show>
    </div>
  )
}

// 注册 edit 工具渲染：编辑 diff 手风琴（元数据补丁优先，缺失时回退到输入的新旧字符串）
ToolRegistry.register({
  name: "edit",
  render(props) {
    const i18n = useI18n()
    const fileComponent = useFileComponent()
    const input = createMemo(() => toolInput(props.input))
    const metadata = createMemo(() => toolMetadata(props.metadata))
    const inputPath = () => input().path ?? ""
    const diff = createMemo(() => metadata().files?.find(changedFileDiff))
    const diagnostics = createMemo(() => getDiagnostics(metadata().diagnostics, inputPath()))
    const path = createMemo(() => diff()?.file ?? inputPath())

    const pending = () => props.status === "streaming" || props.status === "running"

    // diff 数据源：只在文件或补丁文本变化时更新，避免中间态抖动
    const diffSource = createMemo(
      () => {
        const source = diff()

        if (!source) return undefined

        return { file: source.file, patch: source.patch }
      },
      undefined,
      {
        equals: (a, b) => a?.file === b?.file && a?.patch === b?.patch,
      },
    )

    // 文件组件 props：能解析补丁就用 fileDiff（部分补丁用简化分隔符），
    // 解析失败/缺失时退回 before/after 双文本。
    const fileCompProps = createMemo(() => {
      try {
        const source = diffSource()

        if (source) {
          const fileDiff = resolveFileDiff(source)

          if (fileDiff) return { fileDiff, hunkSeparators: fileDiff.isPartial ? "simple" : "line-info-basic" }
        }
      } catch {}

      return {
        before: {
          name: path(),
          contents: input().oldString ?? "",
        },
        after: {
          name: path(),
          contents: input().newString ?? "",
        },
      }
    })

    return (
      <div data-component="edit-tool">
        <FileTool {...props} title={i18n.t("ui.messagePart.title.edit")} count={path() ? 1 : 0}>
          <Show when={path()}>
            <ToolFileAccordion
              path={path()}
              defaultOpen={props.defaultOpen}
              open={props.open}
              onOpenChange={props.onOpenChange}
              forceOpen={props.forceOpen}
              defer={props.deferContent !== false}
              actions={
                // 头部操作区：完成后显示增删行数徽标
                <Show when={!pending() ? diff() : undefined}>
                  {(diff) => <DiffChanges appearance="standard" changes={diff()} />}
                </Show>
              }
            >
              <div data-component="edit-content">
                <Dynamic
                  component={fileComponent}
                  mode="diff"
                  virtualize={props.virtualizeDiff}
                  onRendered={props.onContentRendered}
                  {...fileCompProps()}
                />
              </div>
            </ToolFileAccordion>
          </Show>
          <DiagnosticsDisplay diagnostics={diagnostics()} />
        </FileTool>
      </div>
    )
  },
})

// 注册 write 工具渲染：写入的完整文件内容（文本模式）+ 诊断
ToolRegistry.register({
  name: "write",
  render(props) {
    const fileComponent = useFileComponent()
    const path = createMemo(() => toolInput(props.input).path ?? "")
    const content = createMemo(() => toolInput(props.input).content ?? "")
    const diagnostics = createMemo(() => getDiagnostics(toolMetadata(props.metadata).diagnostics, path()))

    return (
      <div data-component="write-tool">
        <Show when={content() && path()}>
          <ToolFileAccordion
            path={path()}
            defaultOpen={props.defaultOpen}
            open={props.open}
            onOpenChange={props.onOpenChange}
            forceOpen={props.forceOpen}
            defer={props.deferContent !== false}
          >
            <div data-component="write-content">
              <Dynamic
                component={fileComponent}
                mode="text"
                file={{
                  name: path(),
                  contents: content(),
                  cacheKey: checksum(content()),
                }}
                overflow="scroll"
                onRendered={props.onContentRendered}
              />
            </div>
          </ToolFileAccordion>
        </Show>
        <DiagnosticsDisplay diagnostics={diagnostics()} />
      </div>
    )
  },
})

// 注册 patch 工具渲染：多文件补丁手风琴——每个文件一项，
// 头部显示创建/删除徽标或增删统计，内容为按需挂载的 diff 视图。
ToolRegistry.register({
  name: "patch",
  render(props) {
    const i18n = useI18n()
    const fileComponent = useFileComponent()

    const files = createMemo(
      () =>
        // pendingFiles 只是待写入路径清单（无 diff），先造占位条目
        props.pendingFiles?.map((path) => ({
          path,
          type: "update" as const,
          additions: 0,
          deletions: 0,
          views: [],
        })) ?? patchFileGroups(props.metadata.files),
    )

    const title = createMemo(() => {
      if (props.tool === "edit") return i18n.t("ui.messagePart.title.edit")

      if (props.tool === "write") return i18n.t("ui.messagePart.title.write")

      return i18n.t("ui.tool.patch")
    })

    return (
      <div data-component="apply-patch-tool">
        <Show when={files().length > 0} fallback={<FileTool {...props} title={title()} count={0} />}>
          <FileAccordionGroup>
            <Index each={files()}>
              {(file) => {
                // 每个文件独立开合：有 fileOpen 时受拥有者控制，否则用自身状态。
                const disclosure = createDisclosure({
                  open: () => (props.fileOpen ? props.fileOpen(file().path) === true : undefined),
                  defer: () => props.deferContent !== false,
                  onOpenChange: (open) => props.onFileOpenChange?.(file().path, open),
                })

                return (
                  <FileAccordionItem
                    open={disclosure.open()}
                    onOpenChange={disclosure.setOpen}
                    type={file().type}
                    header={
                      <div data-slot="apply-patch-trigger-content">
                        <div data-slot="apply-patch-file-info">
                          <FileIcon node={{ path: file().path, type: "file" }} />
                          <div data-slot="apply-patch-file-name-container">
                            <Show when={file().path.includes("/")}>
                              <span data-slot="apply-patch-directory">{`\u202A${displayDirectory(file().path)}\u202C`}</span>
                            </Show>
                            <span data-slot="apply-patch-filename">{getFilename(file().path)}</span>
                          </div>
                        </div>
                        <div data-slot="apply-patch-trigger-actions">
                          <Switch>
                            <Match when={file().type === "add"}>
                              <span data-slot="apply-patch-change" data-type="added">
                                {i18n.t("ui.patch.action.created")}
                              </span>
                            </Match>
                            <Match when={file().type === "delete"}>
                              <span data-slot="apply-patch-change" data-type="removed">
                                {i18n.t("ui.patch.action.deleted")}
                              </span>
                            </Match>
                            <Match when={true}>
                              <DiffChanges
                                appearance="standard"
                                changes={{ additions: file().additions, deletions: file().deletions }}
                              />
                            </Match>
                          </Switch>
                          <Icon name="chevron-grabber-vertical" size="small" />
                        </div>
                      </div>
                    }
                  >
                    <Show when={disclosure.mounted()}>
                      <For each={file().views}>
                        {(view) => (
                          <div data-component="apply-patch-file-diff">
                            <Dynamic
                              component={fileComponent}
                              mode="diff"
                              virtualize={props.virtualizeDiff}
                              fileDiff={view.fileDiff}
                              hunkSeparators={view.fileDiff.isPartial ? "simple" : "line-info-basic"}
                              onRendered={props.onContentRendered}
                            />
                          </div>
                        )}
                      </For>
                    </Show>
                  </FileAccordionItem>
                )
              }}
            </Index>
          </FileAccordionGroup>
        </Show>
      </div>
    )
  },
})

// 注册 question 工具渲染：提问列表——完成后自动展开显示问答对
ToolRegistry.register({
  name: "question",
  render(props) {
    const i18n = useI18n()

    const items = createMemo(() => questions(toolInput(props.input)))

    const answers = createMemo(() =>
      (toolMetadata(props.metadata).answers ?? []).flatMap((answer) => Option.toArray(decodeAnswer(answer))),
    )

    const completed = createMemo(() => answers().length > 0)

    const subtitle = createMemo(() => {
      const count = items().length

      if (count === 0) return ""

      if (completed()) return i18n.t("ui.question.subtitle.answered", { count })

      return `${count} ${i18n.plural("ui.common.question", count)}`
    })

    return (
      <BasicTool
        {...props}
        defaultOpen={completed()}
        icon="bubble-5"
        trigger={{
          title: i18n.t("ui.tool.questions"),
          subtitle: subtitle(),
        }}
      >
        <Show when={completed()}>
          <div data-component="question-answers">
            <For each={items()}>
              {(q, i) => {
                const answer = () => answers()[i()] ?? []

                return (
                  <div data-slot="question-answer-item">
                    <div data-slot="question-text">
                      <LinkedText text={q.question} />
                    </div>
                    <div data-slot="answer-text">{answer().join(", ") || i18n.t("ui.question.answer.none")}</div>
                  </div>
                )
              }}
            </For>
          </div>
        </Show>
      </BasicTool>
    )
  },
})

// 注册 skill 工具渲染：技能加载行（"Loaded skill: xx"），加载中显示微光占位
ToolRegistry.register({
  name: "skill",
  render(props) {
    const i18n = useI18n()
    const name = createMemo(() => skillToolName(toolInput(props.input), toolMetadata(props.metadata)))
    const running = createMemo(() => props.status === "streaming" || props.status === "running")
    const marker = "__OPENCODE_LOADED_SKILL__"
    const parts = createMemo(() => i18n.t("ui.tool.loadedSkill", { name: marker }).split(marker))

    return (
      <Show when={name()} fallback={<TextShimmer text={i18n.t("ui.tool.skill")} active={running()} />}>
        {(name) => (
          <div data-component="tool-loaded-item" aria-label={i18n.t("ui.tool.loadedSkill", { name: name() })}>
            <span data-slot="tool-loaded-label" aria-hidden="true">
              {parts()[0].trim()}
            </span>
            <span data-slot="tool-loaded-value" aria-hidden="true">
              <TextShimmer as="span" text={name()} active={running()} />
            </span>
            <Show when={parts()[1]?.trim()}>
              {(suffix) => (
                <span data-slot="tool-loaded-kind" aria-hidden="true">
                  {suffix()}
                </span>
              )}
            </Show>
          </div>
        )}
      </Show>
    )
  },
})
