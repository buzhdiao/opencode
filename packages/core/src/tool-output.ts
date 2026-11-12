// 以命名空间形式导出 ToolOutput 模块
export * as ToolOutput from "./tool-output.js"

// 引入 Node path，用于拼接文件路径
import path from "path"
// 仅引入 Tool 类型（内容与结果结构）
import type { Tool } from "./tool.js"
// 引入 Effect 原语：Context、Duration、Effect、Layer（层）、Schedule（调度）
import { Context, Duration, Effect, Layer, Schedule } from "effect"
// 引入全局/位置级服务节点构造工具
import { makeGlobalNode, makeLocationNode } from "@opencode/util/effect/app-node"
// 引入文件系统工具服务
import { FSUtil } from "@opencode/util/fs-util"
// 引入全局数据目录服务
import { Global } from "@opencode/util/global"
// 引入标识符生成器（用于文件名）
import { Identifier } from "@opencode/schema/identifier"
// 引入按保留期清理文件的工具
import { FileRetention } from "./file-retention.js"
// 引入状态框架
import { State } from "./state.js"

// 模型可见输出的默认最大行数
export const MAX_LINES = 2_000
// 默认最大字节数：50 KiB
export const MAX_BYTES = 50 * 1024 // 50 KiB
// 落盘输出的保留时长：7 天
export const RETENTION = Duration.days(7)
// 输出文件存放的数据子目录名
export const DIRECTORY = "tool-output"

// 生成输出文件名：tool_ + 唯一标识符（可带时间戳）
export const fileName = (timestamp?: number) => "tool_" + Identifier.create(false, timestamp)

// 结果类型别名（规范化后的工具结果）
type Result = Tool.NormalizedResult

// 行数/字节限制
type Limits = {
  maxLines: number
  maxBytes: number
}

// 状态编辑器：部分更新限制
export type Editor = {
  configure: (limits: Partial<Limits>) => void
}

// 服务接口（含状态变换能力）
export interface Interface extends State.Transformable<Editor> {
  // 截断超限的结果内容
  readonly truncate: (result: Result) => Effect.Effect<Result>
  /** Writes bytes the model cannot receive inline to a retained file and returns its path. */
  // （中文）把无法内联返回给模型的字节写入保留文件，并返回其路径
  readonly save: (bytes: Uint8Array, extension: string) => Effect.Effect<string>
  // 立即执行一次过期文件清理
  readonly cleanup: () => Effect.Effect<void>
}

// 定义 ToolOutput 服务标记类
export class Service extends Context.Service<Service, Interface>()("@opencode/ToolOutput") {}

// （中文）清理目录中过期的 tool_ 前缀输出文件
const cleanup = Effect.fn("ToolOutput.cleanup")(function* (fs: FSUtil.Interface, directory: string) {
  // 读取目录并筛出合法的输出文件名；目录不存在等错误按空数组处理
  const entries = yield* fs.readDirectory(directory).pipe(
    Effect.map((entries) => entries.filter((entry) => /^tool_[0-9a-f]{12}/.test(entry))),
    Effect.orElseSucceed(() => []),
  )
  // 按保留期删除过期文件
  yield* FileRetention.cleanup(
    fs,
    entries.map((entry) => path.join(directory, entry)),
    RETENTION,
  )
})

// The system error message ("ENOSPC: no space left on device, write") without the stack or wrapper text.
const describe = (error: FSUtil.Error) => {
  const cause = error._tag === "PlatformError" ? error.reason.cause : error.cause
  return cause instanceof Error ? cause.message.split("\n")[0] : error.message
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 获取文件系统工具服务
    const fs = yield* FSUtil.Service
    // 获取全局数据目录
    const global = yield* Global.Service
    // 输出目录：数据目录/tool-output
    const directory = path.join(global.data, DIRECTORY)
    // 限制状态（可通过编辑器配置）
    const state = State.create<Limits, Editor>({
      name: "tool-output",
      // 默认限制
      initial: () => ({ maxLines: MAX_LINES, maxBytes: MAX_BYTES }),
      editor: (editor) => ({
        configure: (limits) => {
          // 更新行数限制（若提供）
          if (limits.maxLines !== undefined) editor.maxLines = limits.maxLines
          // 更新字节限制（若提供）
          if (limits.maxBytes !== undefined) editor.maxBytes = limits.maxBytes
        },
      }),
    })

    // （中文）截断实现：把超限输出裁剪到限制内，全量文本落盘并在模型可见内容中插入提示
    const truncate = Effect.fnUntraced(function* (result: Result) {
      // 已处理过（带 truncated 标记）的结果直接返回
      if (result.metadata?.truncated !== undefined) return result
      // 原始内容块
      const content = result.content
      // A line break joins text parts unless the text before already ends in one.
      const text = content.reduce(
        (joined, item) =>
          item.type !== "text"
            ? joined
            : joined === "" || joined.endsWith("\n")
              ? joined + item.text
              : `${joined}\n${item.text}`,
        "",
      )
      const limits = state.get()
      const totalLines = countLines(text)
      if (totalLines <= limits.maxLines && Buffer.byteLength(text, "utf-8") <= limits.maxBytes)
        return { ...result, metadata: { ...result.metadata, truncated: false } }

      // Cut once, at the line or byte limit, whichever comes first, so a line too long for the space left shows its
      // start. The preview never ends on a line break.
      const end = Math.min(afterLines(text, limits.maxLines), byteBoundary(text, limits.maxBytes))
      const shown = text.slice(0, text.endsWith("\r\n", end) ? end - 2 : text.endsWith("\n", end) ? end - 1 : end)
      const file = path.join(directory, fileName())
      const failure = yield* fs.ensureDir(directory).pipe(
        Effect.andThen(fs.writeFileString(file, text)),
        Effect.as(undefined),
        Effect.catch((error) =>
          Effect.logWarning("failed to save full tool output", { file, cause: error }).pipe(Effect.as(describe(error))),
        ),
      )
      // Counted before the final line break is stripped, so a blank last line still counts.
      const shownLines = countLines(text.slice(0, end))
      const lastLineCut =
        shownLines > 0 &&
        shown.length < text.length &&
        !text.startsWith("\n", shown.length) &&
        !text.startsWith("\r\n", shown.length)
      const range = shownLines === 0 ? "0 lines" : `lines 1-${shownLines}`
      const marker = `[showing ${range} of ${totalLines}${lastLineCut ? " (last line cut)" : ""}; ${
        failure === undefined ? `full output saved to ${file}` : `full output could not be saved: ${failure}`
      }]`
      const bounded: Tool.Content[] = []
      let remaining = shown.length
      let separator = false
      let marked = false
      // 按预算裁剪各文本块
      for (const item of content) {
        // 文件块原样保留
        if (item.type === "file") {
          bounded.push(item)
          continue
        }
        if (separator && remaining > 0) remaining--
        separator = item.text !== "" && !item.text.endsWith("\n")
        if (!marked && remaining >= item.text.length) {
          bounded.push(item)
          remaining -= item.text.length
          continue
        }
        // 剩余预算不够整块时截短该块（尚有剩余才放入）
        if (remaining > 0) bounded.push({ ...item, text: item.text.slice(0, remaining) })
        // 在首次截断处插入提示
        if (!marked) bounded.push({ type: "text", text: marker })
        // 预算用尽
        remaining = 0
        marked = true
      }
      // 全程未插入过提示时补在末尾
      if (!marked) bounded.push({ type: "text", text: marker })
      // 返回截断结果（带输出路径与标记）
      return {
        ...result,
        content: bounded,
        metadata: { ...result.metadata, truncated: true, ...(failure === undefined && { outputPath: file }) },
      }
    })

    // （中文）把二进制字节保存为保留文件并返回路径
    const save = Effect.fnUntraced(function* (bytes: Uint8Array, extension: string) {
      // 目标文件名（追加扩展名）
      const file = path.join(directory, fileName() + extension)
      // 写入文件（必要时创建目录）
      yield* fs.writeWithDirs(file, bytes).pipe(Effect.orDie)
      // 返回文件路径
      return file
    })

    // 组装服务实例
    return Service.of({
      transform: state.transform,
      reload: state.reload,
      truncate,
      save,
      cleanup: () => cleanup(fs, directory),
    })
  }),
)

// 周期清理层：每小时清理一次过期输出文件（随作用域后台运行）
const cleanupLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    // 获取文件系统工具服务
    const fs = yield* FSUtil.Service
    // 获取全局数据目录
    const global = yield* Global.Service
    // 重复执行清理
    yield* cleanup(fs, path.join(global.data, DIRECTORY)).pipe(
      Effect.repeat(Schedule.spaced(Duration.hours(1))),
      Effect.forkScoped,
    )
  }),
)

// 注册全局清理节点
const cleanupNode = makeGlobalNode({
  name: "tool-output-cleanup",
  layer: cleanupLayer,
  deps: [FSUtil.node, Global.node],
})

// 导出位置级服务节点
export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Global.node, cleanupNode],
})

/** How many lines `text` has, not counting an empty one after a final line break. Counts without splitting. */
function countLines(text: string) {
  if (text === "") return 0
  let count = 1
  for (let index = text.indexOf("\n"); index !== -1 && index < text.length - 1; index = text.indexOf("\n", index + 1))
    count++
  return count
}

/** Where the line after the first `count` lines starts, or the end of `text`. */
function afterLines(text: string, count: number) {
  let index = 0
  for (let line = 0; line < count; line++) {
    const next = text.indexOf("\n", index)
    if (next === -1) return text.length
    index = next + 1
  }
  return index
}

const encoder = new TextEncoder()
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** The longest start of `text` that fits in `budget` UTF-8 bytes without splitting a character, emoji included. */
function byteBoundary(text: string, budget: number) {
  // encodeInto only encodes what fits in the buffer, and stops at a whole code point.
  const index = encoder.encodeInto(text, new Uint8Array(Math.max(0, budget))).read
  if (index === text.length || index === 0) return index
  const before = text.charCodeAt(index - 1)
  const after = text.charCodeAt(index)
  // Two ASCII characters always have a boundary between them, except the two halves of \r\n.
  if (before < 0x80 && after < 0x80) return before === 13 && after === 10 ? index - 1 : index
  // Otherwise back off to the start of the grapheme the cut is in. A line break always ends one, so segmenting from the
  // start of the line keeps flag pairs and long emoji sequences exact; one code point past the cut gives the context.
  const start = text.lastIndexOf("\n", index - 1) + 1
  return start + (graphemes.segment(text.slice(start, index + 2)).containing(index - start)?.index ?? index - start)
}
