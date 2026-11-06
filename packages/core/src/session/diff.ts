// 将本模块整体导出为 SessionDiff 命名空间
export * as SessionDiff from "./diff.js"

// 导入 drizzle-orm 的 SQL 构造器
import { and, asc, desc, eq, gt, lt, sql } from "drizzle-orm"
// 导入 effect 核心
import { Context, Effect, Schema } from "effect"
// 导入 Location 引用 schema
import { Location } from "@opencode/schema/location"
// 导入数据库接口类型
import { Database } from "../database/database.js"
// 导入 Location 到服务的映射（用于按 Location 提供快照服务）
import { LocationServiceMap } from "../location-service-map.js"
// 导入快照服务
import { Snapshot } from "../snapshot.js"
// 导入补丁默认上下文行数常量
import { PATCH_CONTEXT_LINES } from "../vcs/patch.js"
// 导入会话相关错误类型
import { MessageNotFoundError } from "./error.js"
// 导入会话消息模块
import { SessionMessage } from "./message.js"
// 导入会话 schema 类型
import { SessionSchema } from "./schema.js"
// 导入消息表定义
import { SessionMessageTable } from "./sql.js"

// 回合范围错误：from/to 消息非法时抛出（带会话 ID、出错的字段与说明）
export class TurnRangeError extends Schema.TaggedError<TurnRangeError>()("Session.TurnRangeError", {
  sessionID: SessionSchema.ID,
  field: Schema.Literals(["from", "to"]),
  message: Schema.String,
}) {}

// Location 引用的同步解码器（JSON 字符串 → 结构化对象）
const decodeLocation = Schema.decodeUnknownSync(Schema.fromJsonString(Location.Ref))

/**
 * Diff the files changed by the turn containing a user message. A turn runs from
 * the first prompt after the Session was last idle until the next idle marker, so
 * prompts steered in while it was busy belong to the same turn; `to` extends the
 * range through the turn containing a later user message. Compares the range's
 * first recorded start snapshot with its last recorded end snapshot; only a step
 * still running in the active Session compares against the working copy. Like VCS
 * diffs, an omitted `context` yields full-file patches.
 *
 * A Session without any idle marker predates them, so its prompts span until the
 * next user message instead.
 *
 * Snapshot trees live in the repository of the Location that captured them, so a
 * range spanning a location switch is rejected rather than diffed wrongly.
 */
// 对包含某用户消息的回合（turn）内变更的文件做差异：回合从上次空闲后的首个 prompt 开始到下一个 idle 标记为止；比较回合首个 start 快照与最后一个 end 快照；仅在活跃会话中仍在运行的步骤才与工作副本比较；范围跨越 Location 切换则报错
export const turn = Effect.fn("SessionDiff.turn")(function* (
  db: Database.Interface["db"],
  locations: Context.Service.Shape<typeof LocationServiceMap.Service>,
  input: {
    readonly session: SessionSchema.Info
    /** The process is currently executing this Session. */
    // 当前进程是否正在执行该会话
    readonly active: boolean
    // 起点用户消息 ID（可选）
    readonly from?: SessionMessage.ID
    // 终点用户消息 ID（可选）
    readonly to?: SessionMessage.ID
    // 差异上下文行数（可选，缺省为完整文件补丁）
    readonly context?: number
  },
) {
  // 会话 ID
  const sessionID = input.session.id
  // Selecting only seq lets the (session_id, type, seq) index answer these without reading message rows,
  // which can be megabytes each. Matching the requested IDs here with OR would scan the whole Session.
  // 查询某类型消息的全部 seq：只选 seq 可命中 (session_id, type, seq) 索引，避免读取可能数 MB 的消息行
  const boundaries = (type: "user" | "idle") =>
    db
      .select({ seq: SessionMessageTable.seq })
      .from(SessionMessageTable)
      .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, type)))
      .orderBy(asc(SessionMessageTable.seq))
      .all()
      .pipe(
        // 只保留 seq 列表
        Effect.map((rows) => rows.map((row) => row.seq)),
        // 查询失败直接终止
        Effect.orDie,
      )
  // 全部用户消息的 seq
  const users = yield* boundaries("user")
  // 全部 idle 标记的 seq
  const markers = yield* boundaries("idle")
  // 校验并解析边界消息：必须是该会话中的用户消息
  const resolve = Effect.fn(function* (field: "from" | "to", id: SessionMessage.ID) {
    // 查询消息行
    const row = yield* db
      .select({ id: SessionMessageTable.id, type: SessionMessageTable.type, seq: SessionMessageTable.seq })
      .from(SessionMessageTable)
      .where(and(eq(SessionMessageTable.id, id), eq(SessionMessageTable.session_id, sessionID)))
      .get()
      .pipe(Effect.orDie)
    // 消息不存在：抛出未找到错误
    if (!row) return yield* new MessageNotFoundError({ sessionID, messageID: id })
    // 非用户消息：抛出回合范围错误
    if (row.type !== "user")
      return yield* new TurnRangeError({ sessionID, field, message: `Message ${id} is not a user message` })
    // 返回合法边界行
    return row
  })
  // 起点锚点：显式指定的 from，否则取该会话最近一条用户消息
  const anchor = input.from
    ? yield* resolve("from", input.from)
    : yield* db
        .select({ id: SessionMessageTable.id, seq: SessionMessageTable.seq })
        .from(SessionMessageTable)
        .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "user")))
        .orderBy(desc(SessionMessageTable.seq))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
  // 会话中没有任何用户消息：无差异
  if (!anchor) return []
  // 终点：显式指定的 to，否则与锚点相同
  const last = input.to ? yield* resolve("to", input.to) : anchor
  // 终点在锚点之前：范围非法
  if (last.seq < anchor.seq)
    return yield* new TurnRangeError({ sessionID, field: "to", message: `Message ${last.id} precedes ${anchor.id}` })
  // Without any marker, history predates idle markers and a prompt's turn ends at the next prompt.
  // 无 idle 标记说明历史早于该机制：一个 prompt 的回合延续到下一条用户消息为止
  const legacy = markers.length === 0
  // The turn opens with the first prompt after the previous idle marker; the anchor itself is the latest candidate.
  // 回合开始于前一个 idle 标记之后的第一条用户消息（锚点自身是最近的候选）
  const opened = markers.findLast((seq) => seq < anchor.seq) ?? -1
  // 回合起始 seq：legacy 模式用锚点，否则用 opened 标记后的第一条用户消息
  const start = legacy ? anchor.seq : (users.find((seq) => seq > opened) ?? anchor.seq)
  // 回合结束边界：legacy 模式用 last 之后的第一条用户消息，否则用第一个在其后的 idle 标记
  const end = legacy ? users.find((seq) => seq > last.seq) : markers.find((seq) => seq > last.seq)
  // 查询范围内全部助手步骤消息：提取快照起止与完成时间（JSON 字段抽取）
  const steps = yield* db
    .select({
      seq: SessionMessageTable.seq,
      start: sql<string | null>`json_extract(${SessionMessageTable.data}, '$.snapshot.start')`,
      end: sql<string | null>`json_extract(${SessionMessageTable.data}, '$.snapshot.end')`,
      completed: sql<number | null>`json_extract(${SessionMessageTable.data}, '$.time.completed')`,
    })
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        eq(SessionMessageTable.type, "assistant"),
        gt(SessionMessageTable.seq, start),
        end === undefined ? undefined : lt(SessionMessageTable.seq, end),
      ),
    )
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  // 第一个与最后一个步骤
  const first = steps[0]
  const final = steps[steps.length - 1]
  // 范围内第一条记录的 start 快照
  const from = steps.find((step) => step.start)?.start
  // 没有步骤或缺少起始快照：无差异
  if (!first || !final || !from) return []
  // 查询范围内的 Location 切换记录
  const switches = yield* db
    .select({
      seq: SessionMessageTable.seq,
      location: sql<string>`json_extract(${SessionMessageTable.data}, '$.location')`,
      previous: sql<string | null>`json_extract(${SessionMessageTable.data}, '$.previous.location')`,
    })
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "location-switched")))
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  // 范围内部发生 Location 切换：快照树分属不同仓库，拒绝错误比对
  if (switches.some((row) => row.seq > first.seq && row.seq < final.seq))
    return yield* new TurnRangeError({ sessionID, field: "to", message: "Turn range spans a location change" })
  // 切换前该会话所在的 Location（首个步骤之前最近一次切换的目标）
  const before = switches.findLast((row) => row.seq < first.seq)?.location
  // 切换后来源 Location（首个步骤之后第一次切换的 previous）
  const after = switches.find((row) => row.seq > first.seq)?.previous
  // 确定快照树所在的 Location：优先切换前记录，其次切换后的来源，最后回退会话当前 Location
  const location = before ? decodeLocation(before) : after ? decodeLocation(after) : input.session.location
  // 最后一个已记录的 end 快照
  const recorded = steps.findLast((step) => step.end)?.end
  // 在对应 Location 的服务作用域内执行差异计算
  return yield* Effect.gen(function* () {
    // 取出快照服务
    const snapshot = yield* Snapshot.Service
    // 最后一步仍在运行且会话活跃：与当前工作副本比较（现场捕获快照）
    const running = input.active && final.completed === null
    // 终点快照：运行中则现场捕获（失败回退已记录值），否则用已记录值
    const to = running ? ((yield* snapshot.capture()) ?? recorded) : recorded
    // 无终点快照：无差异
    if (!to) return []
    // 执行快照差异
    return yield* snapshot.diff({
      from: Snapshot.ID.make(from),
      to: Snapshot.ID.make(to),
      context: input.context ?? PATCH_CONTEXT_LINES,
    })
  }).pipe(Effect.provide(locations.get(location)))
})
