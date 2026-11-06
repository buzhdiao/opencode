// 将本模块整体导出为 SessionInbox 命名空间
export * as SessionInbox from "./inbox.js"

// 导入 drizzle-orm 的 SQL 构造器
import { and, asc, eq, or } from "drizzle-orm"
// 导入 effect 核心
import { Context, DateTime, Effect, Layer, Schema } from "effect"
// 导入全局依赖注入节点构造工具
import { makeGlobalNode } from "@opencode/util/effect/app-node"
// 导入会话收件箱的各种条目与负载 schema
import {
  Compaction,
  CompactionPayload,
  Delivery,
  Info,
  Item,
  MediaInfo,
  MediaUser,
  MediaUserPayload,
  Move,
  MovePayload,
  Synthetic,
  SyntheticPayload,
  User,
  UserPayload,
} from "@opencode/schema/session-inbox"
// 导入数据库服务
import { Database } from "../database/database.js"
// 导入事件总线服务
import { Bus } from "../bus.js"
// 导入按键互斥锁（保证同一会话的操作串行化）
import { KeyedMutex } from "../effect/keyed-mutex.js"
// 导入会话事件定义
import { SessionEvent } from "./event.js"
// 导入会话 blob 模块（媒体外化/水合/引用）
import { SessionBlob } from "./blob.js"
// 导入会话消息模块
import { SessionMessage } from "./message.js"
// 导入会话 schema 类型
import { SessionSchema } from "./schema.js"
// 导入会话存储类型（Stored.UserPayload）
import { SessionStored } from "./stored.js"
// 导入收件箱表与消息表定义
import { SessionInboxTable, SessionMessageTable } from "./sql.js"
// 导入会话历史服务
import { SessionHistory } from "./history.js"

// 数据库服务类型别名
type DatabaseService = Database.Interface["db"]

// 重新导出收件箱相关的类型与构造器，方便调用方从本模块取用
export {
  Compaction,
  CompactionPayload,
  Delivery,
  Info,
  Item,
  MediaInfo,
  MediaUser,
  MediaUserPayload,
  Move,
  MovePayload,
  Synthetic,
  SyntheticPayload,
  User,
  UserPayload,
}

/**
 * Which pending input `promote` may consume: "steer" promotes steers only (a step
 * boundary mid-work), while "input" also allows one queued input when no steers are
 * waiting (the idle boundary, where the Session picks up fresh work).
 */
// 可提升（promote）范围：steer 只消费 steer 投递（工作中步骤边界）；input 还允许在没有 steer 时消费一条排队输入（空闲边界）
export type Promotable = "input" | "steer"

// 各类负载的编解码器（同步版）
const decodeUser = Schema.decodeUnknownSync(UserPayload)
const decodeMediaUser = Schema.decodeUnknownSync(MediaUserPayload)
const decodeStoredUser = Schema.decodeUnknownSync(SessionStored.UserPayload)
const encodeStoredUser = Schema.encodeSync(SessionStored.UserPayload)
const decodeSynthetic = Schema.decodeUnknownSync(SyntheticPayload)
const encodeSynthetic = Schema.encodeSync(SyntheticPayload)
const decodeCompaction = Schema.decodeUnknownSync(CompactionPayload)
const encodeCompaction = Schema.encodeSync(CompactionPayload)
const decodeMove = Schema.decodeUnknownSync(MovePayload)
const encodeMove = Schema.encodeSync(MovePayload)
// 每会话一把的互斥锁集合：串行化对同一会话收件箱的变更
const inboxLocks = KeyedMutex.makeUnsafe<SessionSchema.ID>()
// 待处理条目引用：收件箱 ID + 所属会话 ID
type PendingRef = { readonly id: SessionMessage.ID; readonly sessionID: SessionSchema.ID }

// 在会话锁内串行执行 Effect：避免并发修改同一会话的收件箱
export const serialized = <A, E, R>(sessionID: SessionSchema.ID, effect: Effect.Effect<A, E, R>) =>
  inboxLocks.withLock(sessionID)(effect)

// 生命周期冲突错误：条目 ID 与预期类型/会话不一致或行已被消费
export class LifecycleConflict extends Schema.TaggedError<LifecycleConflict>()("SessionInbox.LifecycleConflict", {
  id: SessionMessage.ID,
}) {}

// 类型守卫：存储条目与请求的会话和类型都匹配
function matches<Type extends Item["type"]>(
  stored: Info,
  request: PendingRef & { readonly type: Type },
): stored is Extract<Info, { readonly type: Type }> {
  return stored.sessionID === request.sessionID && stored.type === request.type
}

// 把收件箱表行转换为结构化 Info（按类型解码负载）
const fromRow = (row: typeof SessionInboxTable.$inferSelect): Info => {
  // 公共字段：ID、会话、创建时间
  const base = {
    id: row.id,
    sessionID: row.session_id,
    time: { created: DateTime.makeUnsafe(row.time_created) },
  }
  // 压缩条目
  if (row.type === "compaction")
    return Compaction.make({
      ...base,
      type: "compaction",
      payload: decodeCompaction(row.payload),
      delivery: row.delivery,
    })
  // 移动条目
  if (row.type === "move")
    return Move.make({ ...base, type: "move", payload: decodeMove(row.payload), delivery: row.delivery })
  // 用户输入条目
  if (row.type === "user")
    return User.make({
      ...base,
      type: "user",
      payload: decodeUser(row.payload),
      delivery: row.delivery,
    })
  // 合成消息条目
  if (row.type === "synthetic")
    return Synthetic.make({
      ...base,
      type: "synthetic",
      payload: decodeSynthetic(row.payload),
      delivery: row.delivery,
    })
  // 未知类型：生命周期冲突
  throw new LifecycleConflict({ id: base.id })
}

// 按 ID 查找待处理收件箱条目（水合媒体后解码）
export const find = Effect.fn("SessionInbox.find")(function* (db: DatabaseService, id: SessionMessage.ID) {
  // 查询行（失败直接终止）
  const row = yield* db.select().from(SessionInboxTable).where(eq(SessionInboxTable.id, id)).get().pipe(Effect.orDie)
  // 不存在：返回 undefined
  if (row === undefined) return undefined
  // 水合行中引用的媒体
  const [hydrated] = yield* SessionBlob.hydrateInbox(db, [row])
  // 转换为 Info
  return hydrated && fromRow(hydrated)
})

// 从已提升的消息行重建收件箱条目（用于幂等重放：行已消费但事件重放时仍能得到条目）
const promotedFromMessage = Effect.fn("SessionInbox.promotedFromMessage")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  id: SessionMessage.ID,
  delivery: Delivery,
) {
  // 查询消息行
  const row = yield* db
    .select()
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.id, id))
    .get()
    .pipe(Effect.orDie)
  // 消息不存在：无法重建
  if (row === undefined) return undefined
  // 会话不匹配或类型不是 user/synthetic：生命周期冲突
  if (row.session_id !== sessionID || (row.type !== "user" && row.type !== "synthetic"))
    return yield* new LifecycleConflict({ id })
  // 水合媒体后解码消息
  const [message] = yield* SessionHistory.decodeMessageRows(db, [row]).pipe(Effect.orDie)
  // 解码失败：返回 undefined
  if (!message) return undefined
  // 条目公共字段（时间取消息创建时间）
  const base = { id, sessionID, time: { created: message.time.created }, delivery }
  // 用户消息：重建 User 条目
  if (message.type === "user")
    return User.make({
      ...base,
      type: "user",
      payload: UserPayload.make({
        text: message.text,
        files: message.files,
        agents: message.agents,
        skills: message.skills,
        metadata: message.metadata,
      }),
    })
  // 合成消息：重建 Synthetic 条目
  if (message.type === "synthetic")
    return Synthetic.make({
      ...base,
      type: "synthetic",
      payload: SyntheticPayload.make({
        text: message.text,
        description: message.description,
        metadata: message.metadata,
      }),
    })
})

// 服务接口：make 的成功返回类型
export type Interface = Effect.Success<ReturnType<typeof make>>

// 声明 effect Context 服务标签
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionInbox") {}

// 构造收件箱服务实现
export const make = Effect.fn("SessionInbox.make")(function* () {
  // 取出数据库服务
  const database = yield* Database.Service
  const db = database.db
  // 取出事件总线
  const bus = yield* Bus.Service

  /** First admission wins for matching Session and type, without preparing a new payload. */
  // 调和（reconcile）：同会话同类型的首个准入生效；查找已存在的条目或从已提升消息重建，类型不符则冲突
  const reconcile = Effect.fn("SessionInbox.reconcile")(function* <Type extends Item["type"]>(request: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly type: Type
    readonly delivery: Delivery
  }) {
    // 先查待处理表，再尝试从已提升消息重建
    const existing =
      (yield* find(db, request.id)) ?? (yield* promotedFromMessage(db, request.sessionID, request.id, request.delivery))
    // 两者皆无：可全新准入
    if (existing === undefined) return undefined
    // 压缩条目或类型不匹配：冲突
    if (existing.type === "compaction" || !matches(existing, request))
      return yield* new LifecycleConflict({ id: request.id })
    // 返回已存在的条目（幂等）
    return existing
  })

  // 准入（admit）：把条目写入收件箱（经 InboxEnqueued 事件投影），重复准入返回已有条目
  const admit = Effect.fn("SessionInbox.admit")(function* <Type extends Item["type"]>(request: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly item: Item & { readonly type: Type }
  }) {
    // 先调和：已存在则直接返回
    const existing = yield* reconcile({ ...request, type: request.item.type, delivery: request.item.delivery })
    if (existing !== undefined) return existing
    // 发布入队事件（投影器写表）
    const admitted = yield* bus
      .publish(SessionEvent.InboxEnqueued, {
        inboxID: request.id,
        sessionID: request.sessionID,
        item: request.item,
      })
      .pipe(
        // 事件返回后组装 Info（时间取事件创建时间）
        Effect.map((event) =>
          Info.make({
            id: request.id,
            sessionID: request.sessionID,
            time: { created: DateTime.makeUnsafe(event.created) },
            ...request.item,
          }),
        ),
        // 投影器经缺陷通道中止事务（如并发竞争）：冲突时重读存储，拿到条目则幂等成功
        Effect.catchDefect((defect) =>
          defect instanceof LifecycleConflict
            ? find(db, request.id).pipe(
                Effect.flatMap((stored) => (stored === undefined ? Effect.fail(defect) : Effect.succeed(stored))),
              )
            : Effect.die(defect),
        ),
      )
    // 校验写入结果与请求匹配
    if (!matches(admitted, { ...request, type: request.item.type }))
      return yield* new LifecycleConflict({ id: request.id })
    // 返回准入的条目
    return admitted
  })

  // 准入压缩条目：每个会话同时最多一个待处理压缩
  const admitCompaction = Effect.fn("SessionInbox.admitCompaction")(function* (input: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly delivery: Delivery
  }) {
    // 在会话锁内串行执行
    return yield* serialized(
      input.sessionID,
      Effect.gen(function* () {
        // 精确查找同 ID 条目
        const exact = yield* find(db, input.id)
        if (exact) {
          // 同会话的压缩条目：幂等返回
          if (exact.type === "compaction" && exact.sessionID === input.sessionID) return exact
          // 类型或会话不符：冲突
          return yield* new LifecycleConflict({ id: input.id })
        }
        // 该 ID 对应的消息已存在：说明已消费过，冲突
        if (yield* promotedFromMessage(db, input.sessionID, input.id, input.delivery))
          return yield* new LifecycleConflict({ id: input.id })
        // 已有其他待处理压缩：复用它
        const pending = (yield* list(db, input.sessionID)).find((item) => item.type === "compaction")
        if (pending) return pending
        // 全新准入压缩条目（空负载）
        return yield* admit({
          id: input.id,
          sessionID: input.sessionID,
          item: { type: "compaction", payload: {}, delivery: input.delivery },
        })
      }),
    )
  })

  // 取消条目：发布 InboxCancelled 事件
  const cancel = Effect.fn("SessionInbox.cancel")((input: PendingRef) =>
    publishMutation(
      input,
      bus.publish(SessionEvent.InboxCancelled, {
        sessionID: input.sessionID,
        inboxID: input.id,
      }),
    ),
  )

  // 把条目投递方式改为 steer
  const steer = Effect.fn("SessionInbox.steer")((input: PendingRef) =>
    publishMutation(
      input,
      bus.publish(SessionEvent.InboxDeliveryChanged, {
        sessionID: input.sessionID,
        inboxID: input.id,
        delivery: "steer",
      }),
    ),
  )

  // 把条目投递方式改为 queue
  const queue = Effect.fn("SessionInbox.queue")((input: PendingRef) =>
    publishMutation(
      input,
      bus.publish(SessionEvent.InboxDeliveryChanged, {
        sessionID: input.sessionID,
        inboxID: input.id,
        delivery: "queue",
      }),
    ),
  )

  // 返回服务实现
  return {
    list: (sessionID: SessionSchema.ID) => list(db, sessionID),
    reconcile,
    admit,
    admitCompaction,
    cancel,
    steer,
    queue,
  }
})

// 服务 Layer
export const layer = Layer.effect(Service, make())

// 创建全局依赖注入节点
export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, Bus.node] })

/** 投影入队事件：写入收件箱表并登记 blob 引用（由事件总线调用） */
export const projectAdmitted = Effect.fn("SessionInbox.projectAdmitted")(function* (
  db: DatabaseService,
  request: {
    // 入队时的序列号
    readonly enqueuedSeq: number
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly item: Item
    readonly timeCreated: number
  },
) {
  // 检查同 ID 消息是否已存在（冲突防御）
  const message = yield* db
    .select({ id: SessionMessageTable.id })
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.id, request.id))
    .get()
    .pipe(Effect.orDie)
  // 消息已存在：缺陷式冲突（中止事件事务）
  if (message !== undefined) return yield* Effect.die(new LifecycleConflict({ id: request.id }))
  // 按类型编码负载：用户负载先外化内联媒体为 blob
  const payload =
    request.item.type === "user"
      ? encodeStoredUser(yield* SessionBlob.externalizePayload(db, request.item.payload))
      : request.item.type === "synthetic"
        ? encodeSynthetic(request.item.payload)
        : request.item.type === "compaction"
          ? encodeCompaction(request.item.payload)
          : encodeMove(request.item.payload)
  // 插入收件箱行（冲突时忽略并返回）
  const stored = yield* db
    .insert(SessionInboxTable)
    .values({
      id: request.id,
      session_id: request.sessionID,
      type: request.item.type,
      payload,
      delivery: request.item.delivery,
      enqueued_seq: request.enqueuedSeq,
      time_created: request.timeCreated,
    })
    .onConflictDoNothing()
    .returning({ id: SessionInboxTable.id })
    .get()
    .pipe(Effect.orDie)
  // 没有写入（ID 冲突）：缺陷式冲突
  if (!stored) return yield* Effect.die(new LifecycleConflict({ id: request.id }))
  // 为负载中引用的 blob 登记引用（以入队序列号为所有者）
  yield* SessionBlob.recordRefs(
    db,
    { sessionID: request.sessionID, messageID: request.id, seq: request.enqueuedSeq },
    payload,
  )
})

/**
 * Consume one pending row at promotion. The row's content feeds the projected
 * message insert inside the same event transaction; the deleted row is what
 * makes the table pending-only.
 */
// 投影送达事件：删除待处理行并返回其存储负载（删除即“表只存待处理”的机制）
export const projectDelivered = Effect.fn("SessionInbox.projectDelivered")(function* (
  db: DatabaseService,
  input: PendingRef,
) {
  // 删除该行并返回删除的行（失败直接终止）
  const deleted = yield* db
    .delete(SessionInboxTable)
    .where(and(eq(SessionInboxTable.id, input.id), eq(SessionInboxTable.session_id, input.sessionID)))
    .returning()
    .get()
    .pipe(Effect.orDie)
  // 行不存在（已被消费或未入队）：缺陷式冲突
  if (!deleted) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
  // 转换为 Delivered 结构
  return delivered(deleted)
})

/** A consumed row with its payload as stored, so user file refs reach the message without their blobs. */
// 已消费条目：负载保持存储形式（用户文件引用未水合，供消息插入使用）
export type Delivered =
  | { readonly id: SessionMessage.ID; readonly type: "user"; readonly payload: SessionStored.UserPayload }
  | { readonly id: SessionMessage.ID; readonly type: "synthetic"; readonly payload: SyntheticPayload }
  | { readonly id: SessionMessage.ID; readonly type: "compaction" | "move" }

// 把表行转换为 Delivered（按类型解码负载）
const delivered = (row: typeof SessionInboxTable.$inferSelect): Delivered => {
  if (row.type === "user") return { id: row.id, type: "user", payload: decodeStoredUser(row.payload) }
  if (row.type === "synthetic") return { id: row.id, type: "synthetic", payload: decodeSynthetic(row.payload) }
  return { id: row.id, type: row.type }
}

/** 投影取消事件：删除排队/steer 待处理行并释放其 blob 引用 */
export const projectCancelled = Effect.fn("SessionInbox.projectCancelled")(function* (
  db: DatabaseService,
  input: PendingRef,
) {
  // 仅允许取消 queue 或 steer 投递的行
  const deleted = yield* db
    .delete(SessionInboxTable)
    .where(
      and(
        eq(SessionInboxTable.id, input.id),
        eq(SessionInboxTable.session_id, input.sessionID),
        or(eq(SessionInboxTable.delivery, "queue"), eq(SessionInboxTable.delivery, "steer")),
      ),
    )
    .returning({ id: SessionInboxTable.id })
    .get()
    .pipe(Effect.orDie)
  // 行不存在：缺陷式冲突
  if (!deleted) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
  // 释放该条目引用的 blob
  yield* SessionBlob.releaseMessage(db, input.sessionID, input.id)
})

// 投影投递方式变更：从 from 改为 to（须匹配原投递方式）
const projectDelivery = Effect.fn("SessionInbox.projectDelivery")(function* (
  db: DatabaseService,
  input: PendingRef & { readonly from: Delivery; readonly to: Delivery },
) {
  // 更新行的投递方式（条件包含原值，防竞态）
  const updated = yield* db
    .update(SessionInboxTable)
    .set({ delivery: input.to })
    .where(
      and(
        eq(SessionInboxTable.id, input.id),
        eq(SessionInboxTable.session_id, input.sessionID),
        eq(SessionInboxTable.delivery, input.from),
      ),
    )
    .returning({ id: SessionInboxTable.id })
    .get()
    .pipe(Effect.orDie)
  // 没有更新到行：缺陷式冲突
  if (!updated) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
})

// 投影投递方式变更事件：steer↔queue 互转
export const projectDeliveryChanged = Effect.fn("SessionInbox.projectDeliveryChanged")(
  (db: DatabaseService, input: PendingRef & { readonly delivery: Delivery }) =>
    projectDelivery(db, {
      ...input,
      from: input.delivery === "steer" ? "queue" : "steer",
      to: input.delivery,
    }),
)

// 查询会话全部待处理行（按入队序号升序）
const listRows = (db: DatabaseService, sessionID: SessionSchema.ID) =>
  db
    .select()
    .from(SessionInboxTable)
    .where(eq(SessionInboxTable.session_id, sessionID))
    .orderBy(asc(SessionInboxTable.enqueued_seq))
    .all()
    .pipe(Effect.orDie)

// 列出会话的待处理条目（水合媒体后转换）
export const list = Effect.fn("SessionInbox.list")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  return (yield* SessionBlob.hydrateInbox(db, yield* listRows(db, sessionID))).map(fromRow)
})

/** {@link list} for clients that fetch media themselves: files stored in `blob` stay `media:` refs. */
// list 的引用保留版本：面向自行取媒体的客户端，blob 文件保持 media: 引用并补充元信息
export const listWithRefs = Effect.fn("SessionInbox.listWithRefs")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  // 保留引用地读取行
  const kept = yield* SessionBlob.keepInboxRefs(db, yield* listRows(db, sessionID))
  // 逐行转换：用户条目用媒体解码器并补充 blob 元信息
  return kept.rows.map((row): MediaInfo => {
    if (row.type !== "user") return fromRow(row)
    const payload = decodeMediaUser(row.payload)
    return MediaUser.make({
      id: row.id,
      sessionID: row.session_id,
      time: { created: DateTime.makeUnsafe(row.time_created) },
      type: "user",
      payload: payload.files ? { ...payload, files: SessionBlob.describe(payload.files, kept.meta) } : payload,
      delivery: row.delivery,
    })
  })
})

// 列出会话待处理 move 条目的 ID（用于会话移动流程）
export const moveIDs = Effect.fn("SessionInbox.moveIDs")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  return yield* db
    .select({ id: SessionInboxTable.id })
    .from(SessionInboxTable)
    .where(and(eq(SessionInboxTable.session_id, sessionID), eq(SessionInboxTable.type, "move")))
    .orderBy(asc(SessionInboxTable.enqueued_seq))
    .all()
    .pipe(Effect.orDie)
})

// 找出下一个可提升的条目：优先 steer，scope 为 input 时才回退到排队条目
export const nextPromotable = Effect.fn("SessionInbox.nextPromotable")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  promotable: Promotable,
) {
  // 最老的待处理 steer
  const steer = (yield* pendingSteers(db, sessionID))[0]
  // 有 steer 则提升它
  if (steer) return promotion(steer)
  // scope 不是 input：不消费排队条目
  if (promotable !== "input") return undefined
  // 取最老的排队条目
  const queued = yield* firstQueued(db, sessionID)
  return queued ? promotion(queued) : undefined
})

/** What a boundary decides on: prompts are promoted by id, so only a move's payload is read. */
// 提升决策信息：prompt 类按 ID 提升，只有 move 需要读取负载
export type Promotion =
  | { readonly id: SessionMessage.ID; readonly type: "user" | "synthetic" | "compaction"; readonly delivery: Delivery }
  | {
      readonly id: SessionMessage.ID
      readonly type: "move"
      readonly delivery: Delivery
      readonly payload: MovePayload
    }

// 把表行转换为 Promotion（move 解码负载，其余只带 ID）
const promotion = (row: typeof SessionInboxTable.$inferSelect): Promotion =>
  row.type === "move"
    ? { id: row.id, type: "move", delivery: row.delivery, payload: decodeMove(row.payload) }
    : { id: row.id, type: row.type, delivery: row.delivery }

/** Which pending rows count: "input" means any item in either delivery mode. */
// 存在性检查范围："input" 表示任意投递方式的任意条目
export type Scope = "input" | Delivery

// 检查会话在给定范围内是否有待处理条目
export const has = Effect.fn("SessionInbox.has")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  scope: Scope,
) {
  // 查询第一条匹配行
  const row = yield* db
    .select({ id: SessionInboxTable.id })
    .from(SessionInboxTable)
    .where(
      and(
        eq(SessionInboxTable.session_id, sessionID),
        scope === "input"
          ? or(eq(SessionInboxTable.delivery, "steer"), eq(SessionInboxTable.delivery, "queue"))
          : eq(SessionInboxTable.delivery, scope),
      ),
    )
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  // 有行即存在
  return row !== undefined
})

// 发布变更的通用包装：会话锁内执行；投影器的生命周期冲突从缺陷转为可失败错误
const publishMutation = <A, E, R>(input: PendingRef, effect: Effect.Effect<A, E, R>) =>
  serialized(input.sessionID, effect).pipe(
    Effect.asVoid,
    // Bus projectors abort their transaction through the defect channel.
    Effect.catchDefect((defect) => (defect instanceof LifecycleConflict ? Effect.fail(defect) : Effect.die(defect))),
  )

// 发布一批行的送达事件（把它们提升为可见消息），返回发布的行数
const publish = Effect.fn("SessionInbox.publish")(function* (
  db: DatabaseService,
  bus: Bus.Interface,
  sessionID: SessionSchema.ID,
  rows: ReadonlyArray<typeof SessionInboxTable.$inferSelect>,
) {
  // 逐行发布
  yield* Effect.forEach(
    rows,
    (row) => {
      // 只允许 user/synthetic/move 类型被送达
      if (row.type !== "move" && row.type !== "user" && row.type !== "synthetic")
        return Effect.die(new LifecycleConflict({ id: row.id }))
      // 发布送达事件
      return bus
        .publish(SessionEvent.InboxDelivered, {
          sessionID,
          inboxID: row.id,
        })
        .pipe(
          // 投影器报冲突（如重放）：尝试从已提升消息重建条目，重建成功视为已送达
          Effect.catchDefect((defect) =>
            defect instanceof LifecycleConflict
              ? promotedFromMessage(db, sessionID, row.id, row.delivery).pipe(
                  Effect.flatMap((stored) => (stored !== undefined ? Effect.void : Effect.die(defect))),
                  Effect.orDie,
                )
              : Effect.die(defect),
          ),
        )
    },
    { discard: true },
  )
  // 返回发布数量
  return rows.length
})

/**
 * Promotes pending input into visible messages and returns the promoted count,
 * or undefined when the runner must first handle a pending control.
 * Steered compaction takes priority over pending prompts, without crossing a move.
 * Only the "input" scope may fall through to one queued input.
 */
// 提升：把待处理输入变成可见消息并返回数量；有控制类条目（压缩/移动）需先处理时返回 undefined；steer 压缩优先于 prompt，且绝不跨越 move
export const promote = Effect.fn("SessionInbox.promote")(function* (
  db: DatabaseService,
  bus: Bus.Interface,
  sessionID: SessionSchema.ID,
  scope: Promotable,
) {
  // 会话锁内串行执行
  return yield* serialized(
    sessionID,
    Effect.gen(function* () {
      // 读取待处理 steer（含压缩前置重排）
      const steers = yield* pendingSteers(db, sessionID)
      // 有 steer 或 scope 限定为 steer：处理 steer 队列
      if (steers.length > 0 || scope === "steer") {
        // 队首是控制类条目：让运行器先处理它
        if (steers.length > 0 && isControl(steers[0])) return undefined
        // 发布首个控制条目之前的全部 steer
        return yield* publish(db, bus, sessionID, beforeControl(steers))
      }

      // 无 steer 且 scope 为 input：取最老的排队条目
      const queued = yield* firstQueued(db, sessionID)
      // 队列空：0
      if (!queued) return 0
      // 队首是控制类：让运行器先处理
      if (isControl(queued)) return undefined
      // 发布该排队条目
      const promoted = yield* publish(db, bus, sessionID, [queued])
      // 顺带发布其后的全部 steer（不跨控制条目）
      return promoted + (yield* publish(db, bus, sessionID, beforeControl(yield* pendingSteers(db, sessionID))))
    }),
  )
})

// 判断是否为控制类条目（压缩或移动）
const isControl = (row: typeof SessionInboxTable.$inferSelect) => row.type === "compaction" || row.type === "move"

// 截取首个控制类条目之前的行（控制条目之前的内容可以一起发布）
const beforeControl = (rows: Array<typeof SessionInboxTable.$inferSelect>) => {
  const control = rows.findIndex(isControl)
  return control === -1 ? rows : rows.slice(0, control)
}

// 取最老的排队（queue）条目
const firstQueued = (db: DatabaseService, sessionID: SessionSchema.ID) =>
  db
    .select()
    .from(SessionInboxTable)
    .where(and(eq(SessionInboxTable.session_id, sessionID), eq(SessionInboxTable.delivery, "queue")))
    .orderBy(asc(SessionInboxTable.enqueued_seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)

// 取全部待处理 steer（按入队顺序），并把压缩控制条目前置
const pendingSteers = (db: DatabaseService, sessionID: SessionSchema.ID) =>
  db
    .select()
    .from(SessionInboxTable)
    .where(and(eq(SessionInboxTable.session_id, sessionID), eq(SessionInboxTable.delivery, "steer")))
    .orderBy(asc(SessionInboxTable.enqueued_seq))
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => {
        // A move changes the context's Location: never pull compaction across it.
        // Within that boundary, compact before promoting even earlier steers so
        // their text stays verbatim after the checkpoint, not inside its summary.
        // move 会改变上下文 Location：压缩绝不跨越它；边界内则把压缩提到更早的 steer 之前，使其原文保留在检查点之后
        const control = rows.findIndex(isControl)
        if (control > 0 && rows[control].type === "compaction") rows.unshift(...rows.splice(control, 1))
        return rows
      }),
    )
