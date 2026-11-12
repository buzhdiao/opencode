// 将本模块整体导出为 SessionBlob 命名空间
export * as SessionBlob from "./blob.js"

// 导入 Node 的 crypto 模块，用于计算 blob 的 SHA-256
import { createHash } from "node:crypto"
// 导入 drizzle-orm 的 SQL 构造器：条件组合、存在性子查询、范围比较、IN 列表等
import { and, eq, exists, gte, inArray, notExists, type SQL, sql } from "drizzle-orm"
// 导入 effect 核心：Cause（错误因）、Context、Effect、Option、Schema
import { Cause, Context, Effect, Option, Schema } from "effect"
// 导入数组的 map 辅助
import { map } from "effect/Array"
// 导入附件与文件附件类型
import type { Attachment, FileAttachment } from "@opencode/schema/prompt"
// 导入工具内容类型
import type { Tool } from "@opencode/schema/tool"
import { DatabaseBatch } from "../database/batch.js"
// 导入数据库接口类型
import type { Database } from "../database/database.js"
// 导入功能开关服务
import { Flag } from "../flag.js"
// 导入实例服务类型（按会话提供作用域）
import type { Instance } from "../instance/service.js"
// 导入会话消息类型
import type { SessionMessage } from "./message.js"
// 导入会话 schema 类型
import type { SessionSchema } from "./schema.js"
// 导入本域的数据表：blob 引用表、blob 表、收件箱表、消息表
import { BlobRefTable, BlobTable, SessionInboxTable, SessionMessageTable } from "./sql.js"
// 导入会话存储的引用类型（FileRef/ToolFileRef 等）
import { SessionStored } from "./stored.js"

// 数据库服务类型（来自 Database 接口的 db 字段）
type DatabaseService = Database.Interface["db"]
// 消息表的查询结果行类型
type MessageRow = typeof SessionMessageTable.$inferSelect
// 收件箱表的查询结果行类型
type InboxRow = typeof SessionInboxTable.$inferSelect
// 消息内容单元（part）类型：从消息行 data.content 中提取元素类型
type Part = Extract<MessageRow["data"], { readonly content: unknown }>["content"][number]
/** Base64 bytes by blob hash. */
// blob 哈希到 base64 字节串的映射
type Blobs = ReadonlyMap<string, string>

// 判断某个值是否为文件引用（FileRef）的谓词
const isFileRef = Schema.is(SessionStored.FileRef)
// 判断某个值是否为工具文件引用（ToolFileRef）的谓词
const isToolFileRef = Schema.is(SessionStored.ToolFileRef)

// 提取一个 part 中已完成/出错工具状态的内容项；非工具 part 返回空数组
const toolItems = (part: Part): ReadonlyArray<Tool.Content> =>
  part.type === "tool" && (part.state.status === "completed" || part.state.status === "error")
    ? (part.state.content ?? [])
    : []

/** A stored row, one `session_part` row, or the `session_part` rows of one assistant message. */
// 可收集引用的数据形态：消息行数据、收件箱负载、单个 part、或一组 part
type Refs = MessageRow["data"] | InboxRow["payload"] | Part | { readonly content: ReadonlyArray<Part> }

// 从给定数据中收集全部文件引用的 blob 哈希，加入 hashes 集合
function collect(data: Refs, hashes: Set<string>) {
  // 顶层 files 字段：收集每个文件引用的哈希
  if ("files" in data)
    for (const file of data.files ?? []) if (isFileRef(file)) hashes.add(SessionStored.refHash(file.uri))
  // A corrupt row's non-array content is left for decoding to reject.
  // content 为非数组（损坏行）时跳过，留给解码阶段去拒绝
  if ("content" in data && Array.isArray(data.content))
    // 遍历每个 part 中的工具内容项，收集工具文件引用的哈希
    for (const part of data.content)
      for (const item of toolItems(part)) if (isToolFileRef(item)) hashes.add(SessionStored.refHash(item.uri))
  // 数据本身就是工具 part 时，同样收集其内容项哈希
  if ("type" in data && data.type === "tool")
    for (const item of toolItems(data)) if (isToolFileRef(item)) hashes.add(SessionStored.refHash(item.uri))
}

/** A ref whose blob is gone reads as this text, so clients and the model never see a bare ref. */
// 生成“媒体不可用”的占位文本：有名称时显示名称与类型，否则只显示 MIME 类型
const unavailable = (mime: string, name?: string) =>
  `[media unavailable: ${name === undefined ? mime : `${name} (${mime})`}]`

// 把丢失 blob 的文件引用替换为带占位文本的明文文件附件
function unavailableFile(file: SessionStored.FileRef): FileAttachment {
  // 解构出 uri（丢弃）并保留其余字段
  const { uri: _, ...rest } = file
  // 返回替换后的附件：数据为占位文本的 base64，MIME 改为 text/plain
  return { ...rest, data: Buffer.from(unavailable(file.mime, file.name)).toString("base64"), mime: "text/plain" }
}

// 把丢失 blob 的工具文件项替换为文本内容项
const unavailableToolItem = (item: Tool.Content & { readonly type: "file" }): Tool.Content => ({
  type: "text",
  text: unavailable(item.mime, item.name),
})

// 把文件引用内联为实际数据：blob 存在则替换为数据，丢失则用占位附件
function inlineFile(file: SessionStored.File, blobs: Blobs): SessionStored.File {
  // 非引用（已是内联数据）原样返回
  if (!isFileRef(file)) return file
  // 按引用哈希取 blob 数据
  const data = blobs.get(SessionStored.refHash(file.uri))
  // 数据缺失时返回占位附件
  if (data === undefined) return unavailableFile(file)
  // 去掉 uri，填入实际数据
  const { uri: _, ...rest } = file
  return { ...rest, data }
}

// 把工具文件项内联为 data URI：blob 存在则改写 uri，丢失则替换为占位文本
function inlineToolItem(item: Tool.Content, blobs: Blobs): Tool.Content {
  // 非文件引用原样返回
  if (!isToolFileRef(item)) return item
  // 按引用哈希取 blob 数据
  const data = blobs.get(SessionStored.refHash(item.uri))
  // 数据缺失时替换为占位文本项
  if (data === undefined) return unavailableToolItem(item)
  // 改写为 data: MIME;base64,数据 形式的 URI
  return { ...item, uri: `data:${item.mime};base64,${data}` }
}

/** Rewrites the ref files in a message row, returning the row itself when it names none. */
// 重写消息行中的文件引用（用 file/item 两个替换函数），未引用任何文件时原样返回该行
function rewriteMessage(
  row: MessageRow,
  file: (file: SessionStored.File) => SessionStored.File,
  item: (item: Tool.Content) => Tool.Content,
): MessageRow {
  // 消息数据
  const data = row.data
  // 顶层 files 含文件引用时逐个替换
  if ("files" in data && data.files?.some(isFileRef)) return { ...row, data: { ...data, files: data.files.map(file) } }
  // content 中存在含文件引用的工具 part 时逐个重写
  if ("content" in data && data.content.some((part) => toolItems(part).some(isToolFileRef)))
    return {
      // 返回带重写 content 的新行
      ...row,
      data: {
        ...data,
        content: data.content.map((part): Part => {
          // 非工具 part 或状态未完成/未出错的原样返回
          if (part.type !== "tool" || (part.state.status !== "completed" && part.state.status !== "error")) return part
          // 工具内容
          const content = part.state.content
          // 内容为空或不含文件引用的原样返回
          if (!content?.some(isToolFileRef)) return part
          // 逐项替换工具内容
          return { ...part, state: { ...part.state, content: map(content, item) } }
        }),
      },
    }
  // 未引用任何文件：原样返回
  return row
}

// 重写收件箱行负载中的文件引用，未引用时原样返回
function rewriteInbox(row: InboxRow, file: (file: SessionStored.File) => SessionStored.File): InboxRow {
  // 收件箱负载
  const payload = row.payload
  // 没有 files 字段或不含文件引用时原样返回
  if (!("files" in payload) || !payload.files?.some(isFileRef)) return row
  // 返回替换后的新行
  return { ...row, payload: { ...payload, files: payload.files.map(file) } }
}

// 从数据库按哈希批量加载 blob，返回哈希到 base64 数据的映射
const load = Effect.fnUntraced(function* (db: DatabaseService, hashes: ReadonlySet<string>) {
  // 结果映射
  const blobs = new Map<string, string>()
  // 按固定批大小分批查询（避免 SQL 参数超限）
  for (const batch of DatabaseBatch.batches([...hashes], 1)) {
    // 查询本批哈希对应的 blob 行（失败直接终止）
    const found = yield* db
      .select({ hash: BlobTable.hash, data: BlobTable.data })
      .from(BlobTable)
      .where(inArray(BlobTable.hash, batch))
      .all()
      .pipe(Effect.orDie)
    // 把每条 blob 转为 base64 存入结果
    for (const blob of found) blobs.set(blob.hash, view(blob.data).toString("base64"))
  }
  // 返回加载结果
  return blobs
})

// 把 Uint8Array 视图安全转换为 Buffer（已是 Buffer 直接用，否则按其内存区间包装）
const view = (data: Uint8Array) =>
  Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength)

/** Restores inline media for the refs in `session_message` rows. Rows without refs are returned untouched. */
// 水合（hydrate）：把消息行中的引用还原为内联媒体数据；无引用的行原样返回
export const hydrate = Effect.fnUntraced(function* (db: DatabaseService, rows: ReadonlyArray<MessageRow>) {
  // 哈希集合
  const hashes = new Set<string>()
  // 收集所有行引用的哈希
  for (const row of rows) collect(row.data, hashes)
  // 没有任何引用：直接原样返回
  if (hashes.size === 0) return rows
  // 加载全部 blob 数据
  const blobs = yield* load(db, hashes)
  // 逐行重写：内联文件与工具内容
  return rows.map((row) =>
    rewriteMessage(
      row,
      (file) => inlineFile(file, blobs),
      (item) => inlineToolItem(item, blobs),
    ),
  )
})

/** Restores inline media for the refs in `session_inbox` rows. Rows without refs are returned untouched. */
// 水合收件箱行：把负载中的文件引用还原为内联数据；无引用的行原样返回
export const hydrateInbox = Effect.fnUntraced(function* (db: DatabaseService, rows: ReadonlyArray<InboxRow>) {
  // 哈希集合
  const hashes = new Set<string>()
  // 收集所有行负载引用的哈希
  for (const row of rows) collect(row.payload, hashes)
  // 没有任何引用：直接原样返回
  if (hashes.size === 0) return rows
  // 加载全部 blob 数据
  const blobs = yield* load(db, hashes)
  // 逐行重写 files 字段
  return rows.map((row) => rewriteInbox(row, (file) => inlineFile(file, blobs)))
})

/** What a client that fetches bytes itself learns about a blob. */
// blob 元信息：字节数与（图片的）宽高
export interface Meta {
  readonly bytes: number
  readonly width: number | null
  readonly height: number | null
}

/**
 * For clients that fetch media themselves: refs stay in `rows`, except those whose blob is gone or not referenced (the media route only serves referenced blobs), which become the
 * same unavailable placeholder {@link hydrate} gives. Returns the size and dimensions of every blob still named.
 */
// 面向自行取回媒体字节的客户端：引用保留在行内，但 blob 已丢失或已无引用（媒体路由只提供仍被引用的 blob）的替换为不可用占位；同时返回仍被引用的每个 blob 的大小与尺寸
export const keepRefs = Effect.fnUntraced(function* (db: DatabaseService, rows: ReadonlyArray<MessageRow>) {
  // 哈希集合
  const hashes = new Set<string>()
  // 收集所有行引用的哈希
  for (const row of rows) collect(row.data, hashes)
  // 加载元信息
  const meta = yield* loadMeta(db, hashes)
  // 重写行：仍可用的引用保留，不可用的替换为占位
  return { rows: rows.map((row) => rewriteMessage(row, keepFile(meta), keepToolItem(meta))), meta }
})

/** {@link keepRefs} for inbox rows. */
// keepRefs 的收件箱行版本：只处理 files 字段
export const keepInboxRefs = Effect.fnUntraced(function* (db: DatabaseService, rows: ReadonlyArray<InboxRow>) {
  // 哈希集合
  const hashes = new Set<string>()
  // 收集所有行负载引用的哈希
  for (const row of rows) collect(row.payload, hashes)
  // 加载元信息
  const meta = yield* loadMeta(db, hashes)
  // 重写行并返回元信息
  return { rows: rows.map((row) => rewriteInbox(row, keepFile(meta))), meta }
})

// 加载哈希集合中仍被引用的 blob 的元信息（字节数与宽高）
const loadMeta = Effect.fnUntraced(function* (db: DatabaseService, hashes: ReadonlySet<string>) {
  // 结果映射
  const meta = new Map<string, Meta>()
  // 分批查询
  for (const batch of DatabaseBatch.batches([...hashes], 1)) {
    // 查询本批哈希且在引用表中仍存在的 blob 元信息（失败直接终止）
    const found = yield* db
      .select({ hash: BlobTable.hash, bytes: BlobTable.bytes, width: BlobTable.width, height: BlobTable.height })
      .from(BlobTable)
      .where(
        and(
          inArray(BlobTable.hash, batch),
          exists(
            db
              .select({ one: sql`1` })
              .from(BlobRefTable)
              .where(eq(BlobRefTable.hash, BlobTable.hash)),
          ),
        ),
      )
      .all()
      .pipe(Effect.orDie)
    // 逐条写入结果映射
    for (const { hash, ...rest } of found) meta.set(hash, rest)
  }
  // 返回元信息映射
  return meta
})

// 生成“保留引用”的文件替换函数：引用仍可用则原样保留，否则替换为占位附件
const keepFile =
  (meta: ReadonlyMap<string, Meta>) =>
  (file: SessionStored.File): SessionStored.File =>
    isFileRef(file) && !meta.has(SessionStored.refHash(file.uri)) ? unavailableFile(file) : file

// 生成“保留引用”的工具项替换函数：引用仍可用则原样保留，否则替换为占位文本
const keepToolItem =
  (meta: ReadonlyMap<string, Meta>) =>
  (item: Tool.Content): Tool.Content =>
    isToolFileRef(item) && !meta.has(SessionStored.refHash(item.uri)) ? unavailableToolItem(item) : item

/** Adds each kept ref's blob size and dimensions to files decoded from {@link keepRefs} or {@link keepInboxRefs}. */
// 为解码后的附件补充每个保留引用的 blob 大小与尺寸信息
export function describe(files: ReadonlyArray<Attachment>, meta: ReadonlyMap<string, Meta>): Attachment[] {
  // 逐个处理附件
  return files.map((file) => {
    // 非 URI 引用（已是内联数据）原样返回
    if (!("uri" in file)) return file
    // 按引用哈希查找元信息
    const blob = meta.get(SessionStored.refHash(file.uri))
    // 找不到则原样返回
    if (!blob) return file
    // 补充字节数，宽高存在时才附带
    return {
      ...file,
      bytes: blob.bytes,
      ...(blob.width === null ? {} : { width: blob.width }),
      ...(blob.height === null ? {} : { height: blob.height }),
    }
  })
}

/**
 * One blob's type and bytes, for the experimental media route and `media:` prompt attachments. Only a blob some
 * message or inbox item still references is readable; an unreferenced one awaiting its sweep reads as missing.
 */
// 读取单个 blob 的 MIME 与字节，供实验性媒体路由和 media: 附件使用；只有仍被某消息或收件箱项引用的 blob 可读，等待清扫的无引用 blob 视为不存在
export const read = Effect.fnUntraced(function* (db: DatabaseService, hash: string) {
  // 查询该哈希且仍被引用的 blob（失败直接终止）
  const blob = yield* db
    .select({ mime: BlobTable.mime, data: BlobTable.data })
    .from(BlobTable)
    .where(
      and(
        eq(BlobTable.hash, hash),
        exists(
          db
            .select({ one: sql`1` })
            .from(BlobRefTable)
            .where(eq(BlobRefTable.hash, BlobTable.hash)),
        ),
      ),
    )
    .get()
    .pipe(Effect.orDie)
  // 找到则返回 MIME 与 Buffer 数据，否则返回 undefined
  return blob && { mime: blob.mime, data: view(blob.data) }
})

/** A blob's hash is the lowercase hex SHA-256 of its raw bytes. */
// 计算 blob 哈希：原始字节的小写十六进制 SHA-256
export const hashBytes = (raw: Uint8Array) => createHash("sha256").update(raw).digest("hex")

/** The row a ref keeps its blob alive for: a message at its `seq`, or a pending inbox row at its `enqueued_seq`. */
// 引用的所有者行信息：会话 ID、消息 ID 与序列号
export interface Owner {
  readonly sessionID: SessionSchema.ID
  readonly messageID: SessionMessage.ID
  readonly seq: number
}

/** Blobs taken out of one row, by hash. */
// 从一行中摘出的待写入 blob（按哈希去重）
type Pending = Map<string, typeof BlobTable.$inferInsert>
// 助手消息内容单元类型
type AssistantPart = SessionMessage.Assistant["content"][number]

/** Reads the `media_blob` flag from the Flag.Service in scope on every call; without one, it is off. */
export const enabled = Effect.gen(function* () {
  const flag = yield* Effect.serviceOption(Flag.Service)
  if (Option.isNone(flag)) return false
  return yield* flag.value.enabled("media_blob")
})

/**
 * {@link Flag.enabled} for `media_blob` as `session`'s location configures it, where its media is written. Off when
 * that location can't boot or load its config, which surfaces as defects too, so a broken location never fails the caller.
 */
export const enabledFor = (instances: Instance.Interface, session: SessionSchema.Info): Effect.Effect<boolean> =>
  Flag.enabled("media_blob").pipe(
    instances.provide(session),
    // 捕获失败原因
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.failCause(Cause.fromReasons<never>(cause.reasons.filter(Cause.isInterruptReason)))
        : Effect.logWarning("could not resolve experimental.media_blob; keeping media inline", { cause }).pipe(
            Effect.as(false),
          ),
    ),
  )

/**
 * Whether a fork's projection stores the child's copied media as blobs. `Session.fork` sets it from the parent's
 * location; the projection ignores the caller's own config, and a replayed fork without it copies media inline.
 */
// fork 投影的上下文引用：标记 fork 出的会话是否把复制的媒体存为 blob；未设置时默认 false（媒体内联复制）
export const ForkMedia = Context.Reference<boolean>("@opencode/SessionBlob/ForkMedia", { defaultValue: () => false })

// 匹配 data URI 的正则：data:<mime>;base64,<数据>，s 标志让 . 匹配换行
const DATA_URI = /^data:[^,]*;base64,(.*)$/s

// 把字节摘出为 blob：首次出现的哈希登记待写入项，返回指向该 blob 的引用
function take(pending: Pending, raw: Buffer, mime: string) {
  // 计算内容哈希
  const hash = hashBytes(raw)
  // 同哈希只登记一次（内容寻址去重）
  if (!pending.has(hash)) pending.set(hash, { hash, mime, bytes: raw.byteLength, data: raw })
  // 返回引用形式的 URI
  return SessionStored.ref(hash)
}

// 把内联文件替换为文件引用：已是引用的原样返回
function fileRef(pending: Pending, file: SessionStored.File): SessionStored.File {
  // 已是引用：直接返回
  if (isFileRef(file)) return file
  // 拆出 base64 数据与其余字段
  const { data, ...rest } = file
  // 解码 base64 后摘出为 blob，并返回引用
  return { ...rest, uri: take(pending, Buffer.from(data, "base64"), file.mime) }
}

// 把工具内容中的 data: 文件替换为引用：其他类型或非 data URI 原样返回
function toolRef(pending: Pending, item: Tool.Content): Tool.Content {
  // 非文件类型原样返回
  if (item.type !== "file") return item
  // 尝试从 data URI 中提取 base64 数据
  const data = DATA_URI.exec(item.uri)?.[1]
  // 非 data URI 原样返回
  return data === undefined ? item : { ...item, uri: take(pending, Buffer.from(data, "base64"), item.mime) }
}

// 处理助手消息的某个 part：把已完成/出错工具内容中的 data: 文件摘出为引用
function toolPartRefs(pending: Pending, part: AssistantPart): AssistantPart {
  // 非工具 part 或状态不是完成/出错的原样返回
  if (part.type !== "tool" || (part.state.status !== "completed" && part.state.status !== "error")) return part
  // 工具内容
  const content = part.state.content
  // 内容为空原样返回
  if (!content) return part
  // 逐项替换为引用
  return { ...part, state: { ...part.state, content: map(content, (item) => toolRef(pending, item)) } }
}

/** Inserts blobs, keeping any that already exist. */
// 批量插入 blob：已存在的哈希跳过（内容寻址，幂等）
export const save = Effect.fnUntraced(function* (
  db: DatabaseService,
  blobs: ReadonlyArray<typeof BlobTable.$inferInsert>,
) {
  // 按插入批量上限分批执行
  for (const batch of DatabaseBatch.insertBatches(BlobTable, blobs))
    yield* db.insert(BlobTable).values(batch).onConflictDoNothing().run().pipe(Effect.orDie)
})

/** {@link externalize} for a user message or pending inbox user payload. */
// 外化用户负载中的内联文件为 blob 引用（仅当开关开启且有文件时）
export const externalizePayload = Effect.fnUntraced(function* <
  T extends { readonly files?: ReadonlyArray<SessionStored.File> },
>(db: DatabaseService, input: T): Effect.fn.Return<T> {
  // 无文件或开关关闭：原样返回
  if (input.files === undefined || !(yield* enabled)) return input
  // 待写入 blob 集合
  const pending: Pending = new Map()
  // 逐个把文件替换为引用
  const files = input.files.map((file) => fileRef(pending, file))
  // 没有摘出任何 blob：原样返回
  if (pending.size === 0) return input
  // 保存全部 blob
  yield* save(db, [...pending.values()])
  // 返回带引用的负载
  return { ...input, files }
})

/**
 * With `experimental.media_blob` on, moves inline user files and tool `data:` files into `blob` and returns the
 * message to store with refs in their place. Existing refs pass through.
 */
// 外化消息：开关开启时把用户内联文件与工具 data: 文件移入 blob 表，返回带引用的消息；已是引用的直接透传
export const externalize = Effect.fnUntraced(function* (
  db: DatabaseService,
  message: SessionMessage.Info | SessionStored.User,
) {
  // 用户消息：走负载外化
  if (message.type === "user") return yield* externalizePayload(db, message)
  // 非助手消息或开关关闭：原样返回
  if (message.type !== "assistant" || !(yield* enabled)) return message
  // 待写入 blob 集合
  const pending: Pending = new Map()
  // 逐个处理助手内容单元
  const content = message.content.map((part) => toolPartRefs(pending, part))
  // 没有摘出任何 blob：原样返回
  if (pending.size === 0) return message
  // 保存全部 blob
  yield* save(db, [...pending.values()])
  // 返回带引用的消息
  return { ...message, content }
})

/** {@link externalize} for one assistant part. Returns the same part when nothing moved. */
// 外化单个助手内容单元：无移动时返回原 part
export const externalizePart = Effect.fnUntraced(function* (db: DatabaseService, part: AssistantPart) {
  // 开关关闭：原样返回
  if (!(yield* enabled)) return part
  // 待写入 blob 集合
  const pending: Pending = new Map()
  // 处理该 part
  const stored = toolPartRefs(pending, part)
  // 没有摘出任何 blob：原样返回
  if (pending.size === 0) return part
  // 保存全部 blob
  yield* save(db, [...pending.values()])
  // 返回替换后的 part
  return stored
})

// 收集给定数据引用的全部 blob 哈希
const hashesOf = (data: Refs) => {
  const hashes = new Set<string>()
  collect(data, hashes)
  return hashes
}

// 处理存储层 part：仅当工具内容中确有 data: 文件时才逐项替换为引用
function storedPartRefs(pending: Pending, part: Part): Part {
  // 非工具 part 或状态不是完成/出错的原样返回
  if (part.type !== "tool" || (part.state.status !== "completed" && part.state.status !== "error")) return part
  // 工具内容
  const content = part.state.content
  // 内容为空或不含 data: 文件时原样返回
  if (!content?.some((item) => item.type === "file" && DATA_URI.test(item.uri))) return part
  // 逐项替换为引用
  return { ...part, state: { ...part.state, content: map(content, (item) => toolRef(pending, item)) } }
}

/**
 * Moves a stored row's inline media into blobs whatever the flag says, for offline backfills. Returns the row to
 * store (the same object when nothing moved), the blobs to insert, and every hash the row then names.
 */
// 无视开关把存储行中的内联媒体移入 blob（用于离线回填）；返回待存储行、待插入 blob 与该行引用的全部哈希
export function split<T extends MessageRow["data"] | InboxRow["payload"] | Part>(data: T) {
  // 待写入 blob 集合
  const pending: Pending = new Map()
  // 按数据形态分派：files 中仍有内联文件的 → 逐个替换为引用
  const stored = (
    "files" in data && data.files?.some((file) => !isFileRef(file))
      ? { ...data, files: data.files.map((file) => fileRef(pending, file)) }
      : "content" in data
        ? { ...data, content: data.content.map((part) => storedPartRefs(pending, part)) }
        : "type" in data && data.type === "tool"
          ? storedPartRefs(pending, data)
          : data
  ) as T
  // 没有移动任何内容时保持原数据
  const result = pending.size > 0 ? stored : data
  // 返回行数据、是否发生移动、待插入 blob 与引用哈希
  return { data: result, moved: pending.size > 0, blobs: [...pending.values()], hashes: hashesOf(result) }
}

/**
 * {@link split} for a message row copied into another session by a fork: saves the moved blobs and returns the row
 * to store. Callers check {@link ForkMedia} and record the copy's refs.
 */
// fork 复制到另一会话的消息行外化：保存摘出的 blob 并返回待存储行；调用方负责检查 ForkMedia 并记录副本的引用
export const externalizeRow = Effect.fnUntraced(function* (db: DatabaseService, data: MessageRow["data"]) {
  // 拆分内联媒体
  const result = split(data)
  // 没有移动：原样返回
  if (!result.moved) return data
  // 保存摘出的 blob
  yield* save(db, result.blobs)
  // 返回带引用的行数据
  return result.data
})

/** Records that `owner` references each blob its stored row names, so release keeps them until it lets go. */
// 记录 owner 对其存储行所引用的每个 blob 的引用，使释放（release）在这些引用消失前保留 blob
export const recordRefs = Effect.fnUntraced(function* (db: DatabaseService, owner: Owner, data: Refs) {
  // 按数据收集哈希并记录
  yield* recordHashes(db, owner, hashesOf(data))
})

/**
 * {@link recordRefs} for the given hashes only, such as the blobs an import took out of its own inline data, so
 * refs it carried in can't keep or expose blobs it never held.
 */
// 只记录给定哈希集合的引用（如导入从自身内联数据摘出的 blob），防止带入的引用保留或暴露它本不持有的 blob
export const recordHashes = Effect.fnUntraced(function* (
  db: DatabaseService,
  owner: Owner,
  hashes: ReadonlySet<string>,
) {
  // A ref whose blob is already gone keeps nothing alive; reads render it as unavailable.
  // 已消失 blob 的引用不会保留任何东西；读取时渲染为不可用
  const found: Array<{ hash: string }> = []
  // 分批查询实际存在的 blob 哈希
  for (const batch of DatabaseBatch.batches([...hashes], 1))
    found.push(
      ...(yield* db
        .select({ hash: BlobTable.hash })
        .from(BlobTable)
        .where(inArray(BlobTable.hash, batch))
        .all()
        .pipe(Effect.orDie)),
    )
  // 构造引用行：会话、消息、哈希、序列号
  const refs = found.map(({ hash }) => ({
    session_id: owner.sessionID,
    message_id: owner.messageID,
    hash,
    seq: owner.seq,
  }))
  // The conflict update binds `seq` once more.
  // 冲突时更新 seq（引用随消息迁移而刷新）
  for (const batch of DatabaseBatch.insertBatches(BlobRefTable, refs, 1))
    yield* db
      .insert(BlobRefTable)
      .values(batch)
      .onConflictDoUpdate({
        target: [BlobRefTable.session_id, BlobRefTable.message_id, BlobRefTable.hash],
        set: { seq: owner.seq },
      })
      .run()
      .pipe(Effect.orDie)
})

/** Records the refs a rewritten message names and releases the ones it no longer does. */
// 同步引用：记录重写后消息的引用，并释放它不再引用的旧引用
export const syncRefs = Effect.fnUntraced(function* (db: DatabaseService, owner: Owner, data: Refs) {
  // 先记录新引用
  yield* recordRefs(db, owner, data)
  // 当前行引用的哈希集合
  const present = hashesOf(data)
  // 限定本会话本消息的引用条件
  const own = [eq(BlobRefTable.session_id, owner.sessionID), eq(BlobRefTable.message_id, owner.messageID)] as const
  // 无任何引用：直接释放本消息全部引用
  if (present.size === 0) return yield* release(db, ...own)
  // 查出本消息现有引用中已不在新数据里的过期哈希
  const stale = (yield* db
    .select({ hash: BlobRefTable.hash })
    .from(BlobRefTable)
    .where(and(...own))
    .all()
    .pipe(Effect.orDie)).flatMap((ref) => (present.has(ref.hash) ? [] : [ref.hash]))
  // 分批释放过期引用
  for (const batch of DatabaseBatch.batches(stale, 1, own.length))
    yield* release(db, ...own, inArray(BlobRefTable.hash, batch))
})

/** Deletes the matching refs, then every blob among theirs that no ref names anymore. */
// 删除匹配的引用，然后删除其中不再被任何引用指向的 blob
const release = Effect.fnUntraced(function* (db: DatabaseService, ...where: readonly [SQL, ...SQL[]]) {
  // 删除引用并返回被释放的哈希（失败直接终止）
  const released = yield* db
    .delete(BlobRefTable)
    .where(and(...where))
    .returning({ hash: BlobRefTable.hash })
    .all()
    .pipe(Effect.orDie)
  // 去重后分批删除孤儿 blob
  for (const batch of DatabaseBatch.batches([...new Set(released.map((ref) => ref.hash))], 1))
    yield* db
      .delete(BlobTable)
      .where(
        and(
          inArray(BlobTable.hash, batch),
          notExists(
            db
              .select({ one: sql`1` })
              .from(BlobRefTable)
              .where(eq(BlobRefTable.hash, BlobTable.hash)),
          ),
        ),
      )
      .run()
      .pipe(Effect.orDie)
})

/** Releases the blobs a removed message or cancelled inbox row referenced. */
// 释放被删除消息或已取消收件箱行引用的 blob
export const releaseMessage = (db: DatabaseService, sessionID: SessionSchema.ID, messageID: SessionMessage.ID) =>
  release(db, eq(BlobRefTable.session_id, sessionID), eq(BlobRefTable.message_id, messageID))

/** Releases the blobs referenced at or after `seq`, for a revert. */
// 释放 seq 及之后引用的 blob（用于回退 revert）
export const releaseFrom = (db: DatabaseService, sessionID: SessionSchema.ID, seq: number) =>
  release(db, eq(BlobRefTable.session_id, sessionID), gte(BlobRefTable.seq, seq))

/** Releases every blob a deleted session referenced. */
// 释放被删除会话引用的全部 blob
export const releaseSession = (db: DatabaseService, sessionID: SessionSchema.ID) =>
  release(db, eq(BlobRefTable.session_id, sessionID))
