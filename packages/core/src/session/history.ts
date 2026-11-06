// 导入 drizzle-orm 的 SQL 构造器
import { and, asc, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm"
// 导入 AI 消息类型（原生窗口用）
import { Message } from "@opencode/ai/effect"
// 导入 effect 核心
import { Effect, Option, Schema } from "effect"
// 导入模型类型（仅类型）
import type { Model } from "@opencode/schema/model"
// 导入旧版本会话数据升级辅助
import { SessionLegacy } from "@opencode/schema/session-legacy"
// 导入数据库接口类型
import { Database } from "../database/database.js"
// 导入数据库批量操作辅助
import { DatabaseBatch } from "../database/batch.js"
// 导入消息解码失败错误
import { MessageDecodeError } from "./error.js"
// 导入会话消息模块
import { SessionMessage } from "./message.js"
// 导入会话 schema 类型（仅类型）
import type { SessionSchema } from "./schema.js"
// 导入指令列表基础设施
import { Instructions } from "../instructions/index.js"
// 导入指令状态服务（初始渲染与预览）
import { InstructionState } from "./instruction-state.js"
// 导入会话 blob 模块（媒体水合）
import { SessionBlob } from "./blob.js"
// 导入近期文本重建辅助
import { SessionRecentText } from "./recent-text.js"
// 导入消息表与内容单元表定义
import { SessionMessageTable, SessionPartTable } from "./sql.js"
// 导入会话存储类型（含 Stored.User）
import { SessionStored } from "./stored.js"

// 数据库服务类型别名
type DatabaseService = Database.Interface["db"]

// 消息解码器（Effect 版）
const decode = Schema.decodeUnknownEffect(SessionMessage.Info)
// 消息解码器（同步版）
const decodeSync = Schema.decodeUnknownSync(SessionMessage.Info)
// 存储层用户消息解码器（不水合文件字节）
const decodeStoredUser = Schema.decodeUnknownEffect(SessionStored.User)
// 含媒体元信息的消息解码器（引用保留）
const decodeMedia = Schema.decodeUnknownEffect(SessionMessage.MediaInfo)
// 助手内容单元解码器（同步版）
const decodePartSync = Schema.decodeUnknownSync(SessionMessage.AssistantContent)
// 导出助手内容单元编码器
export const encodePart = Schema.encodeSync(SessionMessage.AssistantContent)

/**
 * Which completed compactions bound a history read. Local summaries always do. Native
 * windows do for model-neutral readers (`latest`), never for the original transcript
 * (`local`), and only when the target model can replay them.
 */
// 历史读取的边界类型：latest（对模型中立读者，可用本地与原生压缩）、local（仅本地摘要，还原始转录）、或具体模型引用（仅该模型可重放的原生窗口）
export type Boundary = "latest" | "local" | Model.Ref

/** A completed provider compaction, which replays `native.messages` instead of a summary. */
// 判断是否为“原生压缩完成”消息：以重放原生消息列表代替摘要
export const isNativeCompaction = (
  message: SessionMessage.Info,
): message is SessionMessage.CompactionCompleted & { readonly native: { readonly messages: unknown } } =>
  message.type === "compaction" && message.status === "completed" && message.native?.messages !== undefined

/** A native compaction's window: canonical AI messages, stored as JSON. */
// 原生压缩窗口的编解码器：规范的 AI 消息数组（JSON 存储）
export const NativeWindow = Schema.toCodecJson(Schema.Array(Message))
// 窗口解码（Option 版：可解码返回 Some）
const decodeNativeWindow = Schema.decodeUnknownOption(NativeWindow)
// 判断某消息数组是否可解码为窗口
const decodesWindow = (messages: unknown) => Option.isSome(decodeNativeWindow(messages))

// Like other native data, a window only replays on the model that made it. One that no longer decodes, for example
// a malformed one from a compaction hook, is skipped the same way instead of failing the session.
// 判断消息在给定边界下是否可重放：非原生压缩总是可重放；latest 边界可重放；local 不可重放原生窗口；否则要求产生窗口的模型与边界一致且窗口仍可解码
const replayable = (message: SessionMessage.Info, boundary: Boundary) =>
  !isNativeCompaction(message) ||
  boundary === "latest" ||
  (boundary !== "local" &&
    message.model?.providerID === boundary.providerID &&
    message.model.id === boundary.id &&
    decodesWindow(message.native.messages))

// 查找会话中（可选地在某 seq 之前）最新的已完成压缩消息，按边界过滤可重放性
const latestCompaction = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  boundary: Boundary,
  before?: number,
) {
  // 查询最新一条满足条件的压缩消息 seq
  return yield* db
    .select({ seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(
      and(
        // 属于该会话
        eq(SessionMessageTable.session_id, sessionID),
        // 类型为 compaction
        eq(SessionMessageTable.type, "compaction"),
        // 状态为 completed
        sql`json_extract(${SessionMessageTable.data}, '$.status') = 'completed'`,
        // 可选的 seq 上限
        before === undefined ? undefined : lt(SessionMessageTable.seq, before),
        // latest 边界不过滤；其他边界要求无原生窗口或窗口与边界模型匹配
        boundary === "latest"
          ? undefined
          : or(
              // Rows written before v2.1 hold the window in `providerContext`.
              // v2.1 之前的行把窗口存在 providerContext 中：两者都为空表示纯摘要压缩
              sql`coalesce(json_extract(${SessionMessageTable.data}, '$.native.messages'), json_extract(${SessionMessageTable.data}, '$.providerContext')) is null`,
              boundary === "local"
                ? undefined
                : and(
                    sql`json_extract(${SessionMessageTable.data}, '$.model.providerID') = ${boundary.providerID}`,
                    sql`json_extract(${SessionMessageTable.data}, '$.model.id') = ${boundary.id}`,
                  ),
            ),
      ),
    )
    .orderBy(desc(SessionMessageTable.seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
})

/**
 * Puts each assistant row's `session_part` rows into its `data.content`, in ordinal order. Rows without parts keep
 * their inline content, so legacy rows read unchanged. A row an older build wrote inline content to after its parts
 * were split reads as the parts followed by that content, the order the projector moves them in. Runs before blob
 * hydration so media in parts restores too.
 */
// 把助手行的 session_part 内容单元按序合并进 data.content：无 parts 的行保留内联内容；在 blob 水合前执行，使 parts 中的媒体也能还原
export const withParts = Effect.fnUntraced(function* (
  db: DatabaseService,
  rows: ReadonlyArray<typeof SessionMessageTable.$inferSelect>,
) {
  // 收集所有助手行 ID
  const assistantIDs = rows.flatMap((row) => (row.type === "assistant" ? [row.id] : []))
  // 没有助手行：原样返回
  if (assistantIDs.length === 0) return rows
  // 消息 ID → 内容单元数据列表的映射
  const partsByMessage = new Map<SessionMessage.ID, Array<(typeof SessionPartTable.$inferSelect)["data"]>>()
  // 分批查询内容单元行，按消息与序号排序
  for (const ids of DatabaseBatch.batches(assistantIDs, 1)) {
    const partRows = yield* db
      .select()
      .from(SessionPartTable)
      .where(inArray(SessionPartTable.message_id, ids))
      .orderBy(asc(SessionPartTable.message_id), asc(SessionPartTable.ordinal))
      .all()
      .pipe(Effect.orDie)
    // 按消息 ID 分组
    for (const part of partRows) {
      const list = partsByMessage.get(part.message_id)
      if (list) list.push(part.data)
      else partsByMessage.set(part.message_id, [part.data])
    }
  }
  // 没有任何 parts：原样返回
  if (partsByMessage.size === 0) return rows
  // 重组每行：parts 在前，旧构建写入的内联 content 在后（与投影器迁移顺序一致）
  return rows.map((row) => {
    const parts = partsByMessage.get(row.id)
    if (!parts) return row
    const inline = "content" in row.data ? row.data.content : undefined
    return { ...row, data: { ...row.data, content: Array.isArray(inline) ? [...parts, ...inline] : parts } }
  })
})

// Every stored message row decodes through here, so rows written in older shapes are upgraded in one place.
// 所有存储行都经由这里解码：旧版数据形状在此统一升级
const rowInput = (row: typeof SessionMessageTable.$inferSelect) => ({
  ...SessionLegacy.message(row.type, row.data),
  id: row.id,
  type: row.type,
})

// 同步解码单个内容单元行（含旧版升级）
export const decodePartRowSync = (row: typeof SessionPartTable.$inferSelect) =>
  decodePartSync(SessionLegacy.part({ ...row.data, type: row.type }))

// 同步解码单个消息行
export const decodeMessageRowSync = (row: typeof SessionMessageTable.$inferSelect) => decodeSync(rowInput(row))

// 构造解码失败的错误（携带会话与消息 ID）
const decodeError = (row: typeof SessionMessageTable.$inferSelect) => () =>
  new MessageDecodeError({
    sessionID: row.session_id,
    messageID: row.id,
  })

// 解码单个消息行（Effect 版，失败转 MessageDecodeError）
export const decodeMessageRow = (row: typeof SessionMessageTable.$inferSelect) =>
  decode(rowInput(row)).pipe(Effect.mapError(decodeError(row)))

/** Decodes a row without its blobs, so user files may stay refs. Only for readers that never use file bytes. */
// 解码行但不水合 blob（用户文件保持引用形式）；仅限不使用文件字节的读取方
const decodeStoredRow = (
  row: typeof SessionMessageTable.$inferSelect,
): Effect.Effect<SessionMessage.Info | SessionStored.User, MessageDecodeError> =>
  row.type === "user" ? decodeStoredUser(rowInput(row)).pipe(Effect.mapError(decodeError(row))) : decodeMessageRow(row)

/** Decodes rows after restoring media stored in `blob`. Reads that return media must use this. */
// 先水合 blob 中存储的媒体再解码行；返回媒体的读取方必须使用此入口
export const decodeMessageRows = Effect.fnUntraced(function* (
  db: DatabaseService,
  rows: ReadonlyArray<typeof SessionMessageTable.$inferSelect>,
) {
  // 合并 parts、水合媒体，再逐行解码（串行以控制内存）
  return yield* Effect.forEach(yield* SessionBlob.hydrate(db, yield* withParts(db, rows)), decodeMessageRow, {
    concurrency: 1,
  })
})

/** {@link decodeMessageRows} for one row. */
// decodeMessageRows 的单行版本
export const loadMessageRow = Effect.fnUntraced(function* (
  db: DatabaseService,
  row: typeof SessionMessageTable.$inferSelect,
) {
  // 合并 parts 并水合（无变化时回退原行）
  const [hydrated = row] = yield* SessionBlob.hydrate(db, yield* withParts(db, [row]))
  // 解码水合后的行
  return yield* decodeMessageRow(hydrated)
})

/** Decodes rows for clients that fetch media themselves, so files stored in `blob` stay `media:` refs. */
// 面向自行取媒体的客户端解码行：blob 中的文件保持 media: 引用，并补充大小与尺寸元信息
export const decodeMessageRowsWithRefs = Effect.fnUntraced(function* (
  db: DatabaseService,
  rows: ReadonlyArray<typeof SessionMessageTable.$inferSelect>,
) {
  // 合并 parts 并保留引用（丢失/无引用的替换为占位）
  const kept = yield* SessionBlob.keepRefs(db, yield* withParts(db, rows))
  // 逐行用媒体元信息解码器
  return yield* Effect.forEach(
    kept.rows,
    (row) =>
      decodeMedia(rowInput(row)).pipe(
        Effect.mapError(decodeError(row)),
        // 用户消息的文件补充每个保留引用的 blob 元信息
        Effect.map((message) =>
          message.type === "user" && message.files
            ? { ...message, files: SessionBlob.describe(message.files, kept.meta) }
            : message,
        ),
      ),
    { concurrency: 1 },
  )
})

// 读取某边界下会话的消息条目（seq + 消息）：从最新可用压缩处开始，应用重放与原生检查点过滤
const messageEntries = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  boundary: Boundary,
  before?: number,
): Effect.fn.Return<
  ReadonlyArray<{ readonly seq: number; readonly message: SessionMessage.Info }>,
  MessageDecodeError
> {
  // 查找最新的可用压缩
  const compaction = yield* latestCompaction(db, sessionID, boundary, before)
  // 读取该 seq（含）之后到会话末尾的全部消息行
  const rows = yield* db
    .select()
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        compaction ? gte(SessionMessageTable.seq, compaction.seq) : undefined,
      ),
    )
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  // 合并 parts、水合媒体后逐行解码（串行）
  const decoded = yield* Effect.forEach(
    yield* SessionBlob.hydrate(db, yield* withParts(db, rows)),
    (row) => decodeMessageRow(row).pipe(Effect.map((message) => ({ seq: row.seq, message }))),
    { concurrency: 1 },
  )
  // A window that cannot replay leaves nothing to start from, so read from the compaction before it.
  // 窗口不可重放时无从开始：回退到它之前的压缩重新读取（递归）
  const start = decoded[0]
  if (compaction && start && !replayable(start.message, boundary))
    return yield* messageEntries(db, sessionID, boundary, compaction.seq)
  // 有压缩时重建被引用消息的近期文本
  const entries = compaction ? yield* withRecentText(db, sessionID, decoded) : decoded
  // Re-expansion may cross a native checkpoint whose completion already advanced the instruction
  // epoch: the baseline supersedes the chronological updates before it. Forks seed their baseline
  // at sequence 0 but retain parent sequences, so the copied checkpoint still retires them.
  // 找最后一条原生压缩：其之后的指令基线取代之前的按时间顺序更新
  const native = entries.findLast((entry) => isNativeCompaction(entry.message))
  // Skipped native checkpoints are not textual summaries. Their original transcript remains available.
  // 过滤：原生检查点之前的 system 消息被退休；在给定边界下不可重放的消息被跳过
  return entries.filter(
    (entry) =>
      !(entry.message.type === "system" && native && entry.seq < native.seq) && replayable(entry.message, boundary),
  )
})

/**
 * A summary compaction references its kept messages by `metadata.keepID` instead of storing them, so
 * history rebuilds their text from the messages between that one and the compaction, in memory only (see
 * `SessionRecentText.kept`). Compactions written before the reference have none and keep the text they stored.
 */
// 摘要压缩通过 metadata.keepID 引用保留的消息：历史读取时在内存中重建其文本；早于该机制的压缩沿用其已存文本
const withRecentText = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  entries: ReadonlyArray<{ readonly seq: number; readonly message: SessionMessage.Info }>,
) {
  // 首个条目应是压缩消息
  const first = entries[0]
  const compaction = first?.message
  // 不是已完成的压缩：原样返回
  if (compaction?.type !== "compaction" || compaction.status !== "completed") return entries
  // 读取保留引用 ID
  const keepID = compaction.metadata?.keepID
  // 无有效 ID：原样返回
  if (!Schema.is(SessionMessage.ID)(keepID)) return entries
  // 查询 keepID 消息的 seq
  const start = yield* db
    .select({ seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.id, keepID)))
    .get()
    .pipe(Effect.orDie)
  // 找不到被引用消息：原样返回
  if (!start) return entries
  // 读取 keepID 到压缩之间的消息行
  const rows = yield* db
    .select()
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        gte(SessionMessageTable.seq, start.seq),
        lt(SessionMessageTable.seq, first.seq),
      ),
    )
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  // The recent text names attachments by mime and name only, so their bytes are never read.
  // 近期文本只按 MIME 与名称提及附件，因此从不读取文件字节
  const kept = yield* Effect.forEach(yield* withParts(db, rows), decodeStoredRow, { concurrency: 1 })
  // 把每条消息转为文本并拼接
  const recent = kept.map(SessionRecentText.messageToText).filter(Boolean).join("\n\n")
  // 返回带重建 recent 的压缩条目与其余条目
  return [{ ...first, message: { ...compaction, metadata: { ...compaction.metadata, recent } } }, ...entries.slice(1)]
})

// 加载某边界下会话的全部消息（只返回消息列表）
export const load = Effect.fn("SessionHistory.load")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  boundary: Boundary,
) {
  return (yield* messageEntries(db, sessionID, boundary)).map((entry) => entry.message)
})

// 为运行器加载条目：同事务中读取消息与指令初始渲染（保证一致性）
export const entriesForRunner = Effect.fn("SessionHistory.entriesForRunner")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  instructions: Instructions.List,
  boundary: Boundary,
) {
  return yield* db
    .transaction(() =>
      Effect.gen(function* () {
        // 读取消息条目
        const messages = yield* messageEntries(db, sessionID, boundary)
        return {
          // 计算指令初始渲染
          initial: yield* InstructionState.initial(db, sessionID, instructions),
          entries: messages,
        }
      }),
    )
    .pipe(Effect.orDie)
})

// 预览历史：用于无副作用的生成（如标题）；截掉未完成的助手前缀并给出指令更新
export const preview = Effect.fn("SessionHistory.preview")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  instructions: Instructions.List,
  boundary: Boundary,
) {
  // 先观察指令列表的当前状态（读取版本）
  const observed = yield* Instructions.read(instructions)
  return yield* db
    .transaction(() =>
      Effect.gen(function* () {
        // 读取消息条目
        const messages = yield* messageEntries(db, sessionID, boundary)
        // An active assistant may contain an unresolved tool call, so only preview the settled prefix.
        // 活跃助手可能含未完成的工具调用：只预览已结算的前缀
        const unsettled = messages.findIndex(
          (entry) => entry.message.type === "assistant" && entry.message.time.completed === undefined,
        )
        const settled = unsettled === -1 ? messages : messages.slice(0, unsettled)
        // 计算指令预览（含可能的更新）
        const assembled = yield* InstructionState.preview(db, sessionID, instructions, observed)
        return {
          initial: assembled.initial,
          messages: settled.map((entry) => entry.message),
          instructionUpdate: assembled.update,
        }
      }),
    )
    // 指令初始化被阻止属于业务错误；其余错误直接终止
    .pipe(Effect.catch((error) => (error instanceof Instructions.InitializationBlocked ? error : Effect.die(error))))
})

/**
 * The synthetic messages `load(db, sessionID, "latest")` would return, read without the rest of the transcript. Under
 * that boundary every row from the latest completed compaction on is kept, and synthetic rows carry no media.
 */
// 只读取 latest 边界下会返回的合成消息（不读其余转录；合成行不含媒体）
export const synthetics = Effect.fn("SessionHistory.synthetics")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  // 找最新的可用压缩
  const compaction = yield* latestCompaction(db, sessionID, "latest")
  // 读取该 seq 之后的全部 synthetic 行
  const rows = yield* db
    .select()
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        eq(SessionMessageTable.type, "synthetic"),
        compaction ? gte(SessionMessageTable.seq, compaction.seq) : undefined,
      ),
    )
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  // 逐行解码（串行）
  return yield* Effect.forEach(rows, decodeMessageRow, { concurrency: 1 })
})

/**
 * The unfinished assistant messages `load(db, sessionID, "latest")` would return, read without the rest of the
 * transcript. Only these can hold a tool call that is still streaming or running.
 */
// 只读取 latest 边界下未完成的助手消息（只有它们可能持有仍在流式/运行中的工具调用）
export const incompleteAssistants = Effect.fn("SessionHistory.incompleteAssistants")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  // 找最新的可用压缩
  const compaction = yield* latestCompaction(db, sessionID, "latest")
  // 读取该 seq 之后未完成的助手行
  const rows = yield* db
    .select()
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        eq(SessionMessageTable.type, "assistant"),
        sql`json_extract(${SessionMessageTable.data}, '$.time.completed') is null`,
        compaction ? gte(SessionMessageTable.seq, compaction.seq) : undefined,
      ),
    )
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  // 水合媒体后解码
  return yield* decodeMessageRows(db, rows)
})

/** The id and text of the session's first user message. */
// 读取会话第一条用户消息的 ID 与文本（用于派生标题等）
export const firstUserMessage = Effect.fn("SessionHistory.firstUserMessage")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  // 按 seq 升序取第一条用户消息，抽取 data 中的 text 字段
  const row = yield* db
    .select({
      id: SessionMessageTable.id,
      text: sql<unknown>`json_extract(${SessionMessageTable.data}, '$.text')`,
    })
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "user")))
    .orderBy(asc(SessionMessageTable.seq))
    .get()
    .pipe(Effect.orDie)
  // 文本必须是字符串才返回，否则视为无
  return row && Schema.is(Schema.String)(row.text) ? { id: row.id, text: row.text } : undefined
})

// 将本模块整体导出为 SessionHistory 命名空间（置于文件末尾以打破循环依赖）
export * as SessionHistory from "./history.js"
