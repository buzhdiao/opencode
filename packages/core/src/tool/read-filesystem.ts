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
const TAIL_LINES = 100
const MAX_LINE_LENGTH = 2_000
// Enough UTF-8 bytes for the clamped prefix, including a BOM and a partial code point at the end.
const LINE_BYTES = 4 * (MAX_LINE_LENGTH + 1)
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

export class DirectoryOffsetError extends Schema.TaggedError<DirectoryOffsetError>()("ReadTool.DirectoryOffsetError", {
  resource: Schema.String,
}) {
  override get message() {
    return `A negative offset only works for files, and ${this.resource} is a directory`
  }
}

export type ReadError =
  // 资源不存在
  | Environment.NotFound
  // 环境操作失败
  | Environment.Failed
  // 二进制文件
  | BinaryFileError
  // 媒体超限
  | MediaIngestLimitError
  | PathKindError
  | DirectoryOffsetError

// 分页入参 Schema：起始行（1 起）与行数
export const PageInput = Schema.Struct({
  offset: Schema.optionalKey(Schema.Int),
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
    Effect.catchTag("Environment.WrongKind", (error) =>
      Effect.gen(function* () {
        if (error.actual !== "directory") return yield* new PathKindError({ resource, expected: "a file or directory" })
        if (page.offset !== undefined && page.offset < 0) return yield* new DirectoryOffsetError({ resource })
        return yield* files.list(input).pipe(
          Effect.map((entries) => list(entries, page, virtual ? "/" : path.sep)),
          Effect.catchTag("Environment.WrongKind", () =>
            Effect.fail(new PathKindError({ resource, expected: "a file or directory" })),
          ),
        )
      }),
    ),
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

  return yield* textPage(files, input, resource, first, page)
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

// The first line ending in a chunk may have started many chunks earlier.
type Checkpoint = { byte: number; length: number; firstLine: number; start: number; lastLine: number }

const textPage = Effect.fnUntraced(function* (
  files: Files,
  input: AbsolutePath,
  // 资源标识（用于错误信息）
  resource: string,
  first: { bytes: Uint8Array; info: { size: number } },
  page: PageInput,
) {
  const requested = page.offset || 1
  const limit = Math.min(page.limit || MAX_READ_LINES, MAX_READ_LINES)
  const checkpoints: Checkpoint[] = []
  const entries: string[] = []
  let size = 0
  let from = requested
  let tail = false
  let consumed = 0
  let next: number | undefined
  let firstNul = Infinity
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true })

  const range = (offset: number, length: number) => readFile(files, input, resource, { offset, length })
  const reread = Effect.fnUntraced(function* (offset: number, length: number) {
    const { bytes } = yield* range(offset, length)
    if (bytes.length === length) return bytes
    const result = new Uint8Array(length)
    result.set(bytes)
    let filled = bytes.length
    while (filled < length) {
      const more = yield* range(offset + filled, length - filled)
      if (more.bytes.length === 0) break
      result.set(more.bytes, filled)
      filled += more.bytes.length
    }
    return result.subarray(0, filled)
  })

  // Select complete lines in this chunk. Only a split line's displayable prefix ever needs a separate read.
  const collect = Effect.fnUntraced(function* (point: Checkpoint, chunk: Uint8Array) {
    let start = point.start
    let local = Math.max(0, start - point.byte)
    for (let line = point.firstLine; line < from && local < chunk.length; local++) {
      if (chunk[local] !== 10) continue
      line++
      start = point.byte + local + 1
    }
    for (let line = Math.max(point.firstLine, from); line <= point.lastLine; line++) {
      if (!tail && (entries.length >= limit || size >= MAX_READ_BYTES)) {
        next = line
        return
      }
      const lf = chunk.indexOf(10, local)
      const end = point.byte + (lf < 0 ? chunk.length : lf)
      const length = Math.min(LINE_BYTES, end - start)
      const bytes =
        start >= point.byte
          ? chunk.subarray(start - point.byte, start - point.byte + length)
          : start + length <= first.bytes.length
            ? first.bytes.subarray(start, start + length)
            : yield* reread(start, length)
      let text = decoder.decode(bytes)
      // Single-chunk pages decode from byte zero. Streamed pages decode from the selected line,
      // except a past-end tail, whose embedded BOM remains content.
      if (
        text.startsWith("\uFEFF") &&
        (start === 0 || (!tail && line === from && first.bytes.length < first.info.size))
      )
        text = text.slice(1)
      text = clampLine(text.endsWith("\r") ? text.slice(0, -1) : text)
      const cost = Buffer.byteLength(text) + (entries.length > 0 ? 1 : 0)
      if (!tail && size + cost > MAX_READ_BYTES) {
        next = line
        return
      }
      entries.push(text)
      size += cost
      consumed = end + Number(lf >= 0)
      local = lf + 1
      start = end + 1
    }
  })

  let byte = 0
  let total = 0
  let start = 0
  let chunk = first.bytes
  let lastByte = 0
  while (chunk.length > 0) {
    lastByte = byte
    if (firstNul === Infinity) {
      const nul = chunk.indexOf(0)
      if (nul >= 0) firstNul = byte + nul
    }
    let count = 0
    for (let i = 0; i < chunk.length; i++) count += Number(chunk[i] === 10)
    if (count > 0) {
      const point = { byte, length: chunk.length, firstLine: total + 1, start, lastLine: total + count }
      checkpoints.push(point)
      total += count
      if (requested > 0 && total >= requested) yield* collect(point, chunk)
      start = byte + chunk.lastIndexOf(10) + 1
    }
    byte += chunk.length
    // Any byte after a full page starts another line, even if that line has no newline for megabytes.
    if (next === undefined && (entries.length >= limit || size >= MAX_READ_BYTES) && consumed < byte)
      next = requested + entries.length
    if (next !== undefined || byte >= first.info.size) break
    const more = yield* range(byte, FIRST_CHUNK)
    if (more.bytes.length === 0) break
    chunk = more.bytes
  }

  // EOF ends an unterminated line. A trailing newline already ended the last one.
  if (next === undefined && start < byte) {
    total++
    const point = { byte: lastByte, length: chunk.length, firstLine: total, start, lastLine: total }
    checkpoints.push(point)
    if (requested > 0 && total >= requested) yield* collect(point, chunk)
  }
  if (requested < 0 || requested > total) {
    tail = requested > total
    from = Math.max(1, total + 1 + (tail ? -Math.min(page.limit || TAIL_LINES, TAIL_LINES) : requested))
    // Each checkpoint covers disjoint line numbers. Seek to the chunk ending the first selected line;
    // chunks in the middle of a long line have no checkpoint and are never reread.
    for (const point of checkpoints) {
      if (point.lastLine < from) continue
      const bytes =
        point.byte === 0 ? first.bytes : point.byte === lastByte ? chunk : yield* reread(point.byte, point.length)
      yield* collect(point, bytes)
      if (next !== undefined) break
    }
    if (tail) {
      while (size > MAX_READ_BYTES) {
        size -= Buffer.byteLength(entries.shift() ?? "") + 1
        from++
      }
      consumed = byte
    }
  }

  if (firstNul < consumed) return yield* new BinaryFileError({ resource })
  return new TextPage({
    // 类型标记
    type: "text-page",
    content: entries.join("\n"),
    mime: mimeType(input),
    offset: from,
    truncated: next !== undefined,
    ...(next === undefined ? {} : { next }),
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

const clampLine = (line: string) => {
  if (line.length <= MAX_LINE_LENGTH) return line
  const code = line.charCodeAt(MAX_LINE_LENGTH - 1)
  const end = code >= 0xd800 && code <= 0xdbff ? MAX_LINE_LENGTH - 1 : MAX_LINE_LENGTH
  return line.slice(0, end) + MAX_LINE_SUFFIX
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
