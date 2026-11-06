// 将本文件的所有导出聚合到命名空间 ReadToolFileSystem 下，供插件系统统一引入
export * as ReadToolFileSystem from "./read-filesystem.js"

// Node 的 path 模块：路径拼接与解析
import path from "path"
// 把文件路径转成 file:// URL
import { pathToFileURL } from "url"
// 构建 effect 分层应用中的 Location 节点
import { makeLocationNode } from "@opencode/util/effect/app-node"
// effect 库核心：Context 依赖注入、Effect 编排、Layer 分层、Schema 校验
import { Context, Effect, Layer, Schema } from "effect"
// mime-types 库：按扩展名查 MIME 类型
import { lookup } from "mime-types"
// 环境服务：文件系统访问的抽象层
import { Environment } from "../environment/index.js"
// Files 接口类型（来自环境服务）
import type { Files } from "../environment/index.js"
// 文件系统相关的共享 Schema（如 Content）
import { FileSystem } from "../filesystem.js"
// Mime：字节内容嗅探 MIME 类型
import { Mime } from "../mime.js"
// 通用 Schema：绝对路径、非负整数、正整数、相对路径
import { AbsolutePath, NonNegativeInt, PositiveInt, RelativePath } from "../schema.js"

// 读取文本时默认的最大行数
export const MAX_READ_LINES = 2_000
// 读取文本时默认的最大字节数（50KB）
export const MAX_READ_BYTES = 50 * 1024
// 媒体文件（图片/PDF）允许摄取的最大字节数（20MB）
export const MAX_MEDIA_INGEST_BYTES = 20 * 1024 * 1024
// 首次读取的分块大小（256KB）
const FIRST_CHUNK = 256 * 1024
// 单行文本的最大长度（超出会被截断）
const MAX_LINE_LENGTH = 2_000
// 构建分支节点时的扇出基数（用于 rope 树）
const TREE_BASE = 6
// 行截断时的提示后缀
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`
// 可作为媒体（base64）直接返回的 MIME 集合
export const MEDIA_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"])

// 错误：尝试读取二进制文件
export class BinaryFileError extends Schema.TaggedError<BinaryFileError>()("ReadTool.BinaryFileError", {
  // 出错的资源路径
  resource: Schema.String,
}) {
  // 错误信息文案
  override get message() {
    return `Cannot read binary file: ${this.resource}`
  }
}

// 错误：媒体文件超出摄取大小上限
export class MediaIngestLimitError extends Schema.TaggedError<MediaIngestLimitError>()(
  "ReadTool.MediaIngestLimitError",
  {
    // 出错的资源路径
    resource: Schema.String,
    // 允许的最大字节数
    maximumBytes: Schema.Number,
  },
) {
  // 错误信息文案
  override get message() {
    return `Media exceeds ${this.maximumBytes} byte ingestion limit: ${this.resource}`
  }
}

// 错误：分页 offset 超出文件行数范围
export class OffsetOutOfRangeError extends Schema.TaggedError<OffsetOutOfRangeError>()(
  "ReadTool.OffsetOutOfRangeError",
  // 请求的 offset 与文件总行数
  { offset: Schema.Number, lines: Schema.Number },
) {
  // 错误信息文案
  override get message() {
    return `Offset ${this.offset} is out of range for this file (${this.lines} ${this.lines === 1 ? "line" : "lines"})`
  }
}

// 错误：路径类型不符合预期（不是文件/目录）
export class PathKindError extends Schema.TaggedError<PathKindError>()("ReadTool.PathKindError", {
  // 出错的资源路径
  resource: Schema.String,
  // 期望的路径类型
  expected: Schema.Literals(["a file", "a file or directory"]),
}) {
  // 错误信息文案
  override get message() {
    return `Path is not ${this.expected}: ${this.resource}`
  }
}

// 读取操作可能产生的所有错误类型的联合
export type ReadError =
  // 资源不存在
  | Environment.NotFound
  // 环境操作失败
  | Environment.Failed
  // 二进制文件
  | BinaryFileError
  // 媒体超限
  | MediaIngestLimitError
  // offset 越界
  | OffsetOutOfRangeError
  // 路径类型错误
  | PathKindError

// 分页入参 Schema：起始行（1 起）与行数
export const PageInput = Schema.Struct({
  // offset：从第几行开始读（非负整数）
  offset: Schema.optionalKey(NonNegativeInt),
  // limit：本次最多读多少行
  limit: Schema.optionalKey(NonNegativeInt),
})
// PageInput 的 TypeScript 类型
export type PageInput = typeof PageInput.Type

// 文件内容（base64 媒体）结果的 Schema：在通用 Content 字段上加上 type 标记
export const FileContent = Schema.Struct({
  // 类型标记：file
  type: Schema.Literal("file"),
  // 展开通用文件内容字段（uri/name/content/encoding/mime）
  ...FileSystem.Content.fields,
}).annotate({ identifier: "ReadTool.FileContent" })
// FileContent 的 TypeScript 类型
export type FileContent = typeof FileContent.Type

// 文本分页结果：一行一段返回，可带下一页 offset
export class TextPage extends Schema.Class<TextPage>("ReadTool.TextPage")({
  // 类型标记：text-page
  type: Schema.Literal("text-page"),
  // 本页文本内容（按行拼接）
  content: Schema.String,
  // 内容的 MIME 类型
  mime: Schema.String,
  // 本页起始行号（正整数）
  offset: PositiveInt,
  // 是否还有更多内容被截断
  truncated: Schema.Boolean,
  // 下一页的起始行号（可选）
  next: Schema.optionalKey(PositiveInt),
}) {}

// 目录列表条目（声明合并：接口 + Schema 定义）
export interface ListEntry extends Schema.Schema.Type<typeof ListEntry> {}
// 列表条目 Schema：相对路径与条目类型
export const ListEntry = Schema.Struct({
  // 条目的相对路径（目录带分隔符结尾）
  path: RelativePath,
  // 条目类型：文件/目录/符号链接
  type: Schema.Literals(["file", "directory", "symlink"]),
}).annotate({ identifier: "ReadTool.ListEntry" })

// 目录列表分页结果
export class ListPage extends Schema.Class<ListPage>("ReadTool.ListPage")({
  // 类型标记：list-page
  type: Schema.Literal("list-page"),
  // 本页条目
  entries: Schema.Array(ListEntry),
  // 是否被截断
  truncated: Schema.Boolean,
  // 下一页的起始 offset（可选）
  next: Schema.optionalKey(PositiveInt),
}) {}

// 本服务对外提供的接口：列目录与读文件
export interface Interface {
  // 列出目录内容
  readonly list: (path: AbsolutePath) => ReturnType<Files["list"]>
  // 读取文件/目录：按内容自动返回媒体、文本页或目录列表
  readonly read: (
    path: AbsolutePath,
    resource: string,
    page?: PageInput,
  ) => Effect.Effect<FileContent | TextPage | ListPage, ReadError>
}

// effect 服务定义（Context.Service）：以标签 "@opencode/ReadToolFileSystem" 注入
export class Service extends Context.Service<Service, Interface>()("@opencode/ReadToolFileSystem") {}

// 由扩展名推断 MIME 类型，未知类型回退为 application/octet-stream
const mimeType = (value: string) => lookup(value) || "application/octet-stream"

// 核心读取逻辑：读文件（或目录），自动区分媒体、文本分页与目录列表
export const read = Effect.fn("ReadTool.read")(function* (
  // 文件访问接口
  files: Files,
  // 要读取的绝对路径
  input: AbsolutePath,
  // 面向用户的资源标识（可能是 skill:// 虚拟路径）
  resource: string,
  // 分页参数，默认整读
  page: PageInput = {},
) {
  // 判断是否为 skill:// 开头的虚拟资源
  const virtual = resource.startsWith("skill://")
  // 先读取首个分块；若目标其实是目录则转为目录列表
  const first = yield* files.read(input, { offset: 0, length: FIRST_CHUNK }).pipe(
    // 捕获"路径类型不符"错误
    Effect.catchTag("Environment.WrongKind", (error) => {
      // 不是目录说明是其它非法类型（如设备文件），报路径类型错误
      if (error.actual !== "directory")
        return Effect.fail(new PathKindError({ resource, expected: "a file or directory" }))
      // 是目录则列出其内容并分页
      return files.list(input).pipe(
        // 把目录条目转为 ListPage（虚拟资源用 "/" 作分隔符）
        Effect.map((entries) => list(entries, page, virtual ? "/" : path.sep)),
        // 列表阶段又发现类型不符（竞态）时同样报错
        Effect.catchTag("Environment.WrongKind", () =>
          Effect.fail(new PathKindError({ resource, expected: "a file or directory" })),
        ),
      )
    }),
  )
  // 是目录列表则直接返回
  if (first instanceof ListPage) return first

  // 用字节嗅探判断 MIME 类型
  const media = Mime.detect(first.bytes)
  // 命中可摄取的媒体类型（图片/PDF）
  if (MEDIA_MIMES.has(media)) {
    // 超过媒体大小上限则报错
    if (first.info.size > MAX_MEDIA_INGEST_BYTES)
      return yield* new MediaIngestLimitError({ resource, maximumBytes: MAX_MEDIA_INGEST_BYTES })
    // 一次性读取完整文件内容
    const whole = yield* readFile(files, input, resource)
    // 返回 base64 编码的媒体文件内容
    return {
      // 类型标记：file
      type: "file" as const,
      // 虚拟资源用其 skill:// 地址，否则转 file:// URL
      uri: virtual ? resource : pathToFileURL(input).href,
      // 文件名：虚拟资源取 POSIX 基名，否则取本地基名
      name: virtual ? path.posix.basename(input) : path.basename(input),
      // 内容转 base64
      content: Buffer.from(whole.bytes).toString("base64"),
      // 编码标记：base64
      encoding: "base64" as const,
      // 嗅探到的 MIME 类型
      mime: media,
    }
  }

  // 判断是否需要分页：文件超过单页字节限制，或显式指定了 offset/limit
  const paged = first.info.size > MAX_READ_BYTES || page.offset !== undefined || page.limit !== undefined
  // 不分页：直接整读返回
  if (!paged) {
    // 首块中出现 NUL 字节则判定为二进制文件
    if (first.bytes.includes(0)) return yield* new BinaryFileError({ resource })
    // 返回完整文本内容
    return {
      // 类型标记：file
      type: "file" as const,
      // 资源 URI（虚拟或 file://）
      uri: virtual ? resource : pathToFileURL(input).href,
      // 文件名
      name: virtual ? path.posix.basename(input) : path.basename(input),
      // 解码文本并逐行截断超长行
      content: new TextDecoder().decode(first.bytes).split("\n").map(clampLine).join("\n"),
      // 编码标记：utf8
      encoding: "utf8" as const,
      // 按扩展名推断的 MIME
      mime: mimeType(input),
    }
  }

  // 首块已覆盖整个文件（文件不大只是行数/字节超限的场景）
  if (first.bytes.length >= first.info.size) {
    // 直接在完整字节上做文本分页
    const result = textPage(first.bytes, true, page)
    // 完整文件理应能确定分页结果，否则属内部错误
    if (result === undefined) return yield* Effect.die("Read page did not settle for a complete first chunk")
    // 构造文本页：附带二进制检测与总行数
    return yield* makeTextPage(
      // 目标路径
      input,
      // 资源标识
      resource,
      // 分页结果
      result,
      // 首块消费范围内是否含 NUL（二进制检测）
      first.bytes.subarray(0, result.consumed).includes(0),
      // 文件总行数（依据换行数与末字节）
      lineCount(textLeaf(first.bytes).summary.lines, first.bytes.at(-1)),
    )
  }

  // 大文件流式分页：从第 offset 行开始，最多 limit 行
  const offset = page.offset || 1
  // 行数上限：入参 limit 与 MAX_READ_LINES 取小
  const limit = Math.min(page.limit || MAX_READ_LINES, MAX_READ_LINES)
  // 用 rope（绳子结构）叶子保存已读分块
  const leaves = [textLeaf(first.bytes)]
  // 已读取的总字节数
  let bytes = first.bytes.length
  // 已读取的总行数（换行数）
  let lines = leaves[0].summary.lines
  // 是否已确认读到文件末尾
  let ended = false
  // 循环读取分块直到凑齐目标行
  while (true) {
    // 是否已到文件末尾
    const eof = ended || bytes >= first.info.size
    // 已跳过足够行数（offset 之前）或已到 EOF 时，可以切片返回
    if (lines >= offset - 1 || eof) {
      // 把所有叶子构建成一棵 rope 树
      const tree = textTree(leaves)
      // 定位第 offset-1 个换行后的字节偏移（即第 offset 行的起点）
      const start = textOffset(tree, offset - 1)
      // 已遍历过的叶子累计字节
      let position = 0
      // 从各叶子中拼接出从 start 起的所有字节
      const selected = Buffer.concat(
        leaves.flatMap((leaf) => {
          // 记录当前叶子的起始偏移
          const leafStart = position
          // 累加当前叶子的字节数
          position += leaf.summary.bytes
          // 该叶子整体在 start 之前则跳过
          if (position <= start) return []
          // 截取该叶子中 start 之后的部分
          return [leaf.bytes.subarray(Math.max(0, start - leafStart))]
        }),
      )
      // 在选中字节上做分页切片
      const result = textPage(selected, eof, { limit })
      // 能确定本页结果时返回
      if (result !== undefined) {
        // 修正 offset/next 为全局行号
        const translated = {
          // 展开本页基础结果
          ...result,
          // 全局起始行号
          offset,
          // next 同样平移为全局行号；无 next 时显式置空
          ...(result.next === undefined ? { next: undefined } : { next: offset + result.next - 1 }),
        }
        // 计算本页实际消费到的全局字节位置
        const consumed = start + result.consumed
        // 已检查过的叶子字节
        let checked = 0
        // 检查消费范围内是否含 NUL（二进制检测）
        const binary = leaves.some((leaf) => {
          // 该叶子中被消费的字节数
          const length = Math.min(leaf.summary.bytes, consumed - checked)
          // 累加已检查字节
          checked += leaf.summary.bytes
          // 该叶子消费段含 NUL 即判定二进制
          return length > 0 && leaf.bytes.subarray(0, length).includes(0)
        })
        // 构造并返回文本页
        return yield* makeTextPage(input, resource, translated, binary, lineCount(lines, leaves.at(-1)?.bytes.at(-1)))
      }
    }

    // 继续读取下一个分块
    const next = yield* readFile(files, input, resource, { offset: bytes, length: FIRST_CHUNK })
    // 读到空内容说明已到 EOF
    if (next.bytes.length === 0) {
      // 标记结束并在下一轮完成切片
      ended = true
      // 进入下一轮循环
      continue
    }
    // 把新分块包装为 rope 叶子
    const leaf = textLeaf(next.bytes)
    // 追加到叶子列表
    leaves.push(leaf)
    // 累加字节数
    bytes += leaf.summary.bytes
    // 累加行数
    lines += leaf.summary.lines
  }
})

// 读取文件内容；若路径不是文件（如目录）则报路径类型错误
const readFile = (
  // 文件访问接口
  files: Files,
  // 绝对路径
  input: AbsolutePath,
  // 资源标识（用于错误信息）
  resource: string,
  // 可选的读取范围（offset/length）
  range?: { readonly offset: number; readonly length: number },
) =>
  files
    // 执行读取
    .read(input, range)
    .pipe(
      // 类型不符时转为 PathKindError（期望是文件）
      Effect.catchTag("Environment.WrongKind", () => Effect.fail(new PathKindError({ resource, expected: "a file" }))),
    )

// 构造 TextPage 结果：先做二进制与 offset 越界检查
const makeTextPage = Effect.fnUntraced(function* (
  // 绝对路径（用于 MIME 推断）
  input: AbsolutePath,
  // 资源标识（用于错误信息）
  resource: string,
  // textPage 的分页结果
  result: NonNullable<ReturnType<typeof textPage>>,
  // 消费范围内是否检出二进制
  binary: boolean,
  // 文件总行数（用于越界错误信息）
  lines: number,
) {
  // 检出二进制则报错
  if (binary) return yield* new BinaryFileError({ resource })
  // 没取到任何行且 offset 不是第一页，说明 offset 越界
  if (result.entries.length === 0 && result.offset !== 1)
    return yield* new OffsetOutOfRangeError({ offset: result.offset, lines })
  // 组装 TextPage
  return new TextPage({
    // 类型标记
    type: "text-page",
    // 行内容以换行拼接
    content: result.entries.join("\n"),
    // MIME 类型
    mime: mimeType(input),
    // 起始行号
    offset: result.offset,
    // 有 next 即视为截断
    truncated: result.next !== undefined,
    // 有 next 时附带下一页行号
    ...(result.next === undefined ? {} : { next: result.next }),
  })
})

// 目录列表分页：排序、切片并生成 ListPage
const list = (items: ReadonlyArray<Environment.DirEntry>, page: PageInput, sep = path.sep) => {
  // 起始位置（1 起）
  const offset = page.offset || 1
  // 行数上限（与全局上限取小）
  const limit = Math.min(page.limit || MAX_READ_LINES, MAX_READ_LINES)
  // 过滤并转换条目，然后按"目录优先、同类按名称"排序
  const visible = items
    // 过滤掉其它类型（socket 等不可列出的条目）
    .flatMap((item) =>
      item.type === "other"
        ? []
        : [
            // 构造列表条目：目录名后加分隔符
            ListEntry.make({
              // 路径：目录以分隔符结尾便于识别
              path: RelativePath.make(item.name + (item.type === "directory" ? sep : "")),
              // 条目类型
              type: item.type,
            }),
          ],
    )
    // 排序：目录在前，其余按路径字典序
    .sort((a, b) =>
      a.type === "directory"
        ? b.type === "directory"
          ? a.path.localeCompare(b.path)
          : -1
        : b.type === "directory"
          ? 1
          : a.path.localeCompare(b.path),
    )
  // 切出当前页条目
  const selected = visible.slice(offset - 1, offset - 1 + limit)
  // 是否还有剩余条目未展示
  const truncated = offset - 1 + selected.length < visible.length
  // 构造 ListPage
  return new ListPage({
    // 类型标记
    type: "list-page",
    // 本页条目
    entries: selected,
    // 是否截断
    truncated,
    // 截断时给出下一页 offset
    ...(truncated ? { next: offset + selected.length } : {}),
  })
}

// 在字节上做文本分页：返回本页行、起始行、下一页与消费字节数
const textPage = (bytes: Uint8Array, eof: boolean, page: PageInput) => {
  // 起始行（1 起）
  const offset = page.offset || 1
  // 行数上限
  const limit = Math.min(page.limit || MAX_READ_LINES, MAX_READ_LINES)
  // 按 UTF-8 解码字节
  const decoded = new TextDecoder().decode(bytes)
  // 按换行拆分为行数组
  const split = decoded.split("\n")
  // 确定"完整行"范围：EOF 时保留末行（末元素为空串说明以换行结尾）；否则丢弃可能不完整的末行
  const complete = eof ? (split.at(-1) === "" ? split.slice(0, -1) : split) : split.slice(0, -1)
  // 统一去掉行尾 \r（兼容 CRLF）
  const available = complete.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))

  // 本页收集到的行
  const entries: string[] = []
  // 本页累计字节
  let size = 0
  // 下一页起始行
  let next: number | undefined
  // 从 offset 行开始遍历可用行
  for (const [index, value] of available.slice(offset - 1).entries()) {
    // 当前行号
    const line = offset + index
    // 行数或字节数达到上限时记录下一页起点并停止
    if (entries.length >= limit || size >= MAX_READ_BYTES) {
      // 记录下一页起始行
      next = line
      // 结束遍历
      break
    }
    // 截断超长行
    const text = clampLine(value)
    // 该行字节开销（含行间换行符）
    const lineSize = Buffer.byteLength(text, "utf-8") + (entries.length > 0 ? 1 : 0)
    // 加入该行会超出字节上限时同样分页
    if (size + lineSize > MAX_READ_BYTES) {
      // 记录下一页起始行
      next = line
      // 结束遍历
      break
    }
    // 收集该行
    entries.push(text)
    // 累加字节
    size += lineSize
  }
  // 非循环中断但行数已满且后面还有内容时，也标记下一页
  if (next === undefined && entries.length >= limit && (!eof || offset - 1 + entries.length < available.length))
    // 下一页从当前末行之后开始
    next = offset + entries.length
  // 未到 EOF 却无法确定分页结果时返回 undefined（需要更多数据）
  if (!eof && next === undefined) return

  // 本页消费的总行数（无 next 表示读到末尾）
  const consumedLines = next === undefined ? available.length : next - 1
  // 换算为字节偏移：找第 consumedLines 个换行位置；找不到则视为全部字节
  const consumed = consumedLines === 0 ? 0 : (nthNewline(bytes, consumedLines) ?? bytes.length)
  // 返回分页结果
  return { entries, offset, next, consumed }
}

// 单行超长时截断并附加省略提示
const clampLine = (line: string) =>
  line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX : line

// A trailing newline ends the last line instead of starting an empty one.
// 由换行数与末字节推断总行数：末尾无换行时补一（最后一行未闭合）
const lineCount = (newlines: number, last: number | undefined) => newlines + (last === undefined || last === 10 ? 0 : 1)

// 文本节点的权重摘要：字节数与换行（行）数
type TextSummary = { readonly bytes: number; readonly lines: number }
// Request-local augmented rope. Subtree byte and newline weights locate a line
// like an order-statistic query without repeatedly decoding the accumulated text.
// https://doi.org/10.1002/spe.4380251203
// 请求内使用的加权 rope（绳子）树：叶子存原始字节，分支节点聚合权重，
// 可像顺序统计查询一样按换行号定位字节偏移，避免反复解码全文
type TextNode =
  // 叶子节点：原始字节与其摘要
  | { readonly type: "leaf"; readonly bytes: Uint8Array; readonly summary: TextSummary }
  // 分支节点：子节点列表与聚合摘要
  | { readonly type: "branch"; readonly children: ReadonlyArray<TextNode>; readonly summary: TextSummary }

// 由一段字节构造叶子节点（统计换行数）
const textLeaf = (bytes: Uint8Array): Extract<TextNode, { readonly type: "leaf" }> => {
  // 换行计数
  let lines = 0
  // 逐字节统计 0x0A（\n）
  for (const byte of bytes) if (byte === 10) lines++
  // 返回叶子及其摘要
  return { type: "leaf", bytes, summary: { bytes: bytes.length, lines } }
}

// 把叶子列表两两向上聚合成一棵平衡的 rope 树
const textTree = (nodes: ReadonlyArray<TextNode>): TextNode => {
  // 只剩一个节点即为根
  if (nodes.length === 1) return nodes[0]
  // 每层把 2*TREE_BASE 个节点合并为一个分支，递归建树
  return textTree(
    Array.from({ length: Math.ceil(nodes.length / (TREE_BASE * 2)) }, (_, index) => {
      // 取当前分支覆盖的子节点区间
      const children = nodes.slice(index * TREE_BASE * 2, (index + 1) * TREE_BASE * 2)
      // 构造分支节点并汇总权重
      return {
        // 节点类型：分支
        type: "branch" as const,
        // 子节点
        children,
        // 汇总字节与行数
        summary: {
          // 累加子节点的字节数
          bytes: children.reduce((total, child) => total + child.summary.bytes, 0),
          // 累加子节点的行数
          lines: children.reduce((total, child) => total + child.summary.lines, 0),
        },
      }
    }),
  )
}

// 在 rope 树中定位第 newline 个换行之后的字节偏移
const textOffset = (tree: TextNode, newline: number) => {
  // 第 0 个换行前即文件开头
  if (newline === 0) return 0
  // 自根向下查找
  let node = tree
  // 还需跳过的换行数
  let remaining = newline
  // 已跳过的字节偏移
  let offset = 0
  // 沿分支节点下行
  while (node.type === "branch") {
    // 找到累计换行数能覆盖 remaining 的子节点
    const child = node.children.find((candidate) => {
      // 该子节点包含目标换行则进入
      if (remaining <= candidate.summary.lines) return true
      // 否则扣除其行数与字节数后继续
      remaining -= candidate.summary.lines
      offset += candidate.summary.bytes
      // 继续找
      return false
    })
    // 没找到说明目标在末尾之后，返回总字节数
    if (!child) return tree.summary.bytes
    // 进入该子节点
    node = child
  }
  // 在叶子内查找第 remaining 个换行的位置
  const end = nthNewline(node.bytes, remaining)
  // 找不到则返回总字节数，否则返回累计偏移
  return end === undefined ? tree.summary.bytes : offset + end
}

// 查找字节序列中第 count 个换行符的位置（返回换行后的下标）
const nthNewline = (bytes: Uint8Array, count: number) => {
  // 已找到的换行数
  let found = 0
  // 遍历字节
  for (const [index, byte] of bytes.entries()) {
    // 非换行则跳过
    if (byte !== 10) continue
    // 计数
    found++
    // 命中目标序号时返回其后位置
    if (found === count) return index + 1
  }
}

// 构建 effect 分层：把环境服务的文件接口适配为本服务实现
const layer = Layer.effect(
  // 目标服务标签
  Service,
  // 服务实现的构造 effect
  Effect.gen(function* () {
    // 获取环境服务
    const environment = yield* Environment.Service
    // 返回服务实现
    return Service.of({
      // 列目录：直接复用环境服务的 list
      list: environment.files.list,
      // 读文件：绑定环境文件接口后委托给核心 read
      read: (path, resource, page) => read(environment.files, path, resource, page),
    })
  }),
)

// 导出 Location 节点：声明服务、分层与依赖（Environment 节点）
export const node = makeLocationNode({ service: Service, layer, deps: [Environment.node] })
