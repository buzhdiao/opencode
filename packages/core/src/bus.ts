// 事件总线（Bus）：持久化事件（durable event）的发布/订阅中枢——事件落库、按聚合（aggregate）排序，
// 支持实时订阅、按聚合的历史日志回放（log）与跨进程重放（replay）。
export * as Bus from "./bus.js"

import { Cause, Clock, Context, Effect, Layer, Option, PubSub, Schema, Stream } from "effect"
import { Event } from "@opencode/schema/event"
import type { EventLog } from "@opencode/schema/event-log"
import { and, asc, eq, gt, lte, sql } from "drizzle-orm"
import { Database } from "./database/database.js"
import { EventSequenceTable, EventTable } from "./event/sql.js"
import type { Location } from "@opencode/schema/location"
import { KeyedMutex } from "./effect/keyed-mutex.js"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { isDeepStrictEqual } from "node:util"
import { Durable } from "@opencode/schema/durable-event-manifest"
import { SessionEvent } from "@opencode/schema/session-event"
import { SessionLegacy } from "@opencode/schema/session-legacy"
import type { SessionID } from "@opencode/schema/session-id"
import { AbsolutePath } from "@opencode/schema/schema"

// 订阅者（Subscriber）函数类型：接收事件载荷并返回效果
export type Subscriber<D extends Event.Definition = Event.Definition> = (event: Event.Payload<D>) => Effect.Effect<void>
// 取消订阅（Unsubscribe）的效果类型
export type Unsubscribe = Effect.Effect<void>

// latestSequence：读取某聚合（aggregate）当前已持久化的最大序列号（无记录时返回 -1）
export const latestSequence = Effect.fn("Bus.latestSequence")(function* (
  db: Database.Interface["db"],
  aggregateID: string,
) {
  const row = yield* db
    .select({ seq: EventSequenceTable.seq })
    .from(EventSequenceTable)
    .where(eq(EventSequenceTable.aggregate_id, aggregateID))
    .get()
    .pipe(Effect.orDie)
  return row?.seq ?? -1
})

// reserveSequence：预留序列号——插入或以 max() 取较大值推进该聚合的序列水位（供分叉聚合继承前缀）
export const reserveSequence = Effect.fn("Bus.reserveSequence")(function* (
  db: Database.Interface["db"],
  aggregateID: string,
  seq: number,
) {
  yield* db
    .insert(EventSequenceTable)
    .values([{ aggregate_id: aggregateID, seq }])
    .onConflictDoUpdate({
      target: EventSequenceTable.aggregate_id,
      set: { seq: sql`max(${EventSequenceTable.seq}, ${seq})` },
    })
    .run()
    .pipe(Effect.orDie)
})

// 序列化事件（SerializedEvent）：可从数据库行/快照重建的完整事件描述
export type SerializedEvent = {
  readonly id: Event.ID
  readonly type: string
  readonly created?: number
  readonly seq: number
  readonly aggregateID: string
  readonly data: Record<string, unknown>
}

// 无效持久化事件错误（缺陷级，表示数据损坏或程序错误）
export class InvalidDurableEventError extends Schema.TaggedError<InvalidDurableEventError>()(
  "Bus.InvalidDurableEvent",
  {
    // 事件类型
    type: Schema.String,
    // 错误信息
    message: Schema.String,
  },
) {}

// 构造持久化信封（envelope）：聚合 ID + 序列号 + 版本
const envelope = (aggregateID: string, seq: number, version: number) => ({
  aggregateID,
  seq: Event.Seq.make(seq),
  version: Event.Version.make(version),
})

// requireAggregateID：从事件数据中提取聚合 ID 字段；缺失或非字符串则直接崩溃
const requireAggregateID = (type: string, aggregate: string, data: unknown) => {
  const aggregateID = (data as Record<string, unknown>)[aggregate]
  if (typeof aggregateID === "string") return Effect.succeed(aggregateID)
  return Effect.die(new InvalidDurableEventError({ type, message: `Expected string aggregate field ${aggregate}` }))
}

// Every stored event decodes through here, so payloads written in older shapes are upgraded in one place.
// 所有入库事件都经此解码，旧形状的载荷在此统一升级
const decodeStoredData = (definition: Event.DurableDefinition, data: unknown) =>
  Schema.decodeUnknownSync(definition.data)(SessionLegacy.event(definition.type, data))

// decodeSerializedEvent：把序列化事件行还原为事件载荷；未知类型或非持久化类型则抛错
const decodeSerializedEvent = (event: SerializedEvent): Event.Payload => {
  const definition = Durable.get(event.type)
  if (!definition?.durable) {
    throw new InvalidDurableEventError({ type: event.type, message: `Unknown durable event type ${event.type}` })
  }
  return {
    id: event.id,
    created: event.created ?? 0,
    type: definition.type,
    durable: envelope(event.aggregateID, event.seq, definition.durable.version),
    data: decodeStoredData(definition, event.data),
  }
}

// 转发导出事件相关的类型工具与定义构造器
export const versionedType = Event.versionedType
export const durable = Event.durable
export const ephemeral = Event.ephemeral

// 发布选项（PublishOptions）
export interface PublishOptions {
  // 显式指定事件 ID（重放/幂等场景）
  readonly id?: Event.ID
  // 附加元数据
  readonly metadata?: Record<string, unknown>
  // 事件归属的位置（Location）
  readonly location?: Location.Ref
  // 全局事件：不携带位置，所有位置可见
  readonly global?: boolean
  /** Local operational projection committed atomically with a new durable event. Not replayed or serialized. */
  // 与新持久化事件原子提交的本地投影回调；不参与重放也不序列化
  readonly commit?: (seq: number) => Effect.Effect<void>
}

// publishAll 的单条输入：定义 + 数据 + 可选选项
export type PublishInput<D extends Event.DurableDefinition = Event.DurableDefinition> = readonly [
  definition: D,
  data: Event.Data<D>,
  options?: PublishOptions,
]

// publishAll 的返回类型：逐条映射为对应定义的事件载荷
export type PublishResult<I extends readonly PublishInput[]> = {
  readonly [K in keyof I]: I[K] extends PublishInput<infer D> ? Event.Payload<D> : never
}

/** Marker/event union emitted by `log`. */
// log 流的元素：事件载荷或同步（Synced）标记
export type LogItem = Event.Payload | EventLog.Synced

// isSynced：类型守卫，判断 log 元素是否为同步标记
export const isSynced = (item: LogItem): item is EventLog.Synced => item.type === "log.synced"

// 订阅多个定义时的载荷类型：逐个映射为对应载荷的联合
export type SubscribePayload<D extends readonly Event.Definition[]> = D[number] extends infer Item
  ? Item extends Event.Definition
    ? Event.Payload<Item>
    : never
  : never

// subscribe 的多态接口定义（无参 / 单定义 / 多定义）
export interface Subscribe {
  /**
   * Volatile live channel: every event published from now on, nothing before or
   * across a disconnect. Consumers that need reliability combine it with `log`.
   * With an ambient Location, delivery is restricted to that Location and global
   * events. Unlocated Session events use the Session's owner at publication time.
   * Session moves reach both the old and new Location, without changing the event.
   */
  (): Stream.Stream<Event.Payload>
  <D extends Event.Definition>(definition: D): Stream.Stream<Event.Payload<D>>
  <const D extends readonly [Event.Definition, ...Event.Definition[]]>(
    definitions: D,
  ): Stream.Stream<SubscribePayload<D>>
}

// isDefinition：类型守卫——入参是单个定义还是定义数组
const isDefinition = (input: Event.Definition | readonly Event.Definition[]): input is Event.Definition =>
  !Array.isArray(input)

// 总线服务接口
export interface Interface {
  // publish：发布单个事件（持久化或易逝）
  readonly publish: <D extends Event.Definition>(
    definition: D,
    data: Event.Data<D>,
    options?: PublishOptions,
  ) => Effect.Effect<Event.Payload<D>>
  // publishAll：批量发布到同一聚合，保证原子提交
  readonly publishAll: <const I extends readonly [PublishInput, ...PublishInput[]]>(
    events: I,
  ) => Effect.Effect<PublishResult<I>>
  readonly subscribe: Subscribe
  /**
   * Durable, ordered per-aggregate log read. Forked aggregates may reserve an
   * inherited prefix before their first child-authored event. `follow: false`
   * completes at the end of the log; `follow: true` replays then transitions
   * to live. Both modes emit one `Synced` marker at the captured replay
   * watermark.
   */
  // log：按聚合读取持久化事件日志——回放到当前水位，follow 模式继续追实时
  readonly log: (input: {
    readonly aggregateID: string
    readonly after?: number
    readonly follow?: boolean
  }) => Stream.Stream<LogItem>
  /** @deprecated Use `subscribe()` and consume the returned stream. */
  // listen：已废弃的全量监听器注册（改用 subscribe()）
  readonly listen: (listener: Subscriber) => Effect.Effect<Unsubscribe>
  // project：注册投影器（projector），在事件提交事务内同步调用
  readonly project: <D extends Event.Definition>(definition: D, projector: Subscriber<D>) => Effect.Effect<void>
  // replay：重放一条序列化事件（跨进程恢复用）
  readonly replay: (
    event: SerializedEvent,
    options?: { readonly publish?: boolean; readonly ownerID?: string; readonly strictOwner?: boolean },
  ) => Effect.Effect<void>
  // remove：删除聚合的全部事件
  readonly remove: (aggregateID: string) => Effect.Effect<void>
  // claim：认领聚合的所有权（跨进程协调谁负责重放）
  readonly claim: (aggregateID: string, ownerID: string) => Effect.Effect<void>
}

// Effect 服务令牌
export class Service extends Context.Service<Service, Interface>()("@opencode/Bus") {}

// 层装配选项（Options）
interface Options {
  // 读取聚合日志前的钩子
  readonly beforeAggregateRead?: (aggregateID: string) => Effect.Effect<void>
  /** Maximum durable rows read per page while replaying or tailing an aggregate log. */
  // 回放/追尾时每页读取的最大持久化行数
  readonly logReadPageSize?: number
  /** Retain durable event payloads for historical log reads and replay. */
  // 是否在数据库中保留持久化事件载荷（供历史读取与重放）
  readonly persist?: boolean
}

// configured：按选项构造总线节点（含实现层）
export function configured(options?: Options) {
  return makeGlobalNode({
    service: Service,
    deps: [Database.node],
    layer: Layer.effect(
      Service,
      Effect.gen(function* () {
        // Deferred import: a static one would close the module cycle
        // bus → location → project → bus and hit the node bindings in TDZ.
        // 延迟导入：静态导入会造成 bus → location → project → bus 的循环依赖并在 TDZ 阶段踩中节点绑定
        const { Location } = yield* Effect.promise(() => import("./location.js"))
        const { SessionTable } = yield* Effect.promise(() => import("./session/sql.js"))
        // 三类发布订阅通道：实时全量、按聚合唤醒、按类型订阅
        const pubsub = {
          // 实时通道：所有事件
          live: yield* PubSub.unbounded<Event.Payload>(),
          // 按聚合 ID 的唤醒信号集合
          durable: new Map<string, Set<PubSub.PubSub<void>>>(),
          // 按事件类型的订阅者集合
          typed: new Map<string, Set<PubSub.PubSub<Event.Payload>>>(),
        }
        // 投影器注册表：类型版本键 → 投影器列表
        const projectors = new Map<string, Subscriber[]>()
        // 兼容的全量监听器列表
        const listeners = new Array<Subscriber>()
        // 按聚合 ID 的互斥锁
        const durableLocks = KeyedMutex.makeUnsafe<string>()
        // 数据库句柄
        const { db } = yield* Database.Service
        // 每页读取行数，默认 512
        const logReadPageSize = options?.logReadPageSize ?? 512
        // 默认不持久化事件载荷
        const persist = options?.persist ?? false
        // 会话（session）ID → 位置 的路由缓存
        const sessions = new Map<SessionID, Location.Ref>()
        // Keep routing separate from the public event, and retain its snapshot
        // while a slow subscriber drains events queued before a move or deletion.
        // 路由表与公开事件分离：挂在事件载荷上的弱映射，慢订阅者排空队列期间保留快照
        const routes = new WeakMap<Event.Payload, readonly Location.Ref[]>()

        // isSessionEvent：判断事件是否为会话事件
        const isSessionEvent = (event: Event.Payload): event is SessionEvent.Event =>
          Object.hasOwn(SessionEvent.All.cases, event.type)

        // prepareRoutes：预计算事件路由与会话位置更新；返回在事务提交后应用的回调
        const prepareRoutes = Effect.fnUntraced(function* (events: readonly Event.Payload[]) {
          // 待应用的会话位置更新
          const updates = new Map<SessionID, Location.Ref | undefined>()
          // 每个事件的投递位置列表
          const resolved = new Map<Event.Payload, readonly Location.Ref[]>()
          for (const event of events) {
            // 非会话事件无需路由计算
            if (!isSessionEvent(event)) continue
            const id = event.data.sessionID
            if (event.type === "session.created") {
              // 新会话：记录其位置
              updates.set(id, event.data.location)
              // 投递到声明的位置
              resolved.set(event, [event.location ?? event.data.location])
              continue
            }
            if (event.location && event.type !== "session.forked" && event.type !== "session.moved") {
              // 删除事件：清除路由缓存
              if (event.type === "session.deleted") updates.set(id, undefined)
              // 其余自带位置的事件直接使用信封位置
              continue
            }
            // 分叉事件按父会话查位置
            const owner = event.type === "session.forked" ? event.data.parentID : id
            // 优先用本批次已计算的更新
            let ref = updates.has(owner) ? updates.get(owner) : sessions.get(owner)
            if (!ref && !updates.has(owner)) {
              // 缓存未命中则查数据库
              const row = yield* db
                .select({ directory: SessionTable.directory, workspaceID: SessionTable.workspace_id })
                .from(SessionTable)
                .where(eq(SessionTable.id, owner))
                .get()
                .pipe(Effect.orDie)
              ref = row
                ? { directory: AbsolutePath.make(row.directory), workspaceID: row.workspaceID ?? undefined }
                : undefined
              // 记录以避免重复查询
              updates.set(owner, ref)
            }
            if (event.type === "session.moved") {
              // Both owners need the transition, even if the producer supplied
              // an envelope location. Later events use only the destination.
              // 移动事件：新旧两个位置的订阅者都要收到过渡事件
              // 会话位置更新到目的地
              updates.set(id, event.data.location)
              resolved.set(event, ref ? [ref, event.data.location] : [event.data.location])
              continue
            }
            // 分叉：新会话继承父会话位置
            if (event.type === "session.forked") updates.set(id, ref)
            resolved.set(event, event.location ? [event.location] : ref ? [ref] : [])
            if (event.type === "session.deleted") updates.set(id, undefined)
          }
          // Apply only after the projection transaction commits. A failed move
          // must not redirect events away from the Session's actual location.
          // 仅在投影事务提交后才应用路由更新：失败的移动不能把事件改道到错误位置
          return () => {
            for (const [id, ref] of updates) {
              if (ref) sessions.set(id, ref)
              else sessions.delete(id)
            }
            for (const [event, ref] of resolved) routes.set(event, ref)
          }
        })

        // 层终结器：关闭全部发布订阅通道，避免悬挂订阅
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* PubSub.shutdown(pubsub.live)
            yield* Effect.forEach(
              pubsub.durable.values(),
              (pubsubs) => Effect.forEach(pubsubs, PubSub.shutdown, { discard: true }),
              { discard: true },
            )
            yield* Effect.forEach(
              pubsub.typed.values(),
              (subscribers) => Effect.forEach(subscribers, PubSub.shutdown, { discard: true }),
              { discard: true },
            )
          }),
        )

        // commitDurableEvent：在单个数据库事务内完成持久化事件的序列号分配、校验、投影与落库
        function commitDurableEvent(
          definition: Event.Definition,
          event: Event.Payload,
          input?: {
            // 期望的序列号（重放时提供）
            readonly seq: number
            // 期望的聚合 ID
            readonly aggregateID: string
            // 认领者 ID
            readonly ownerID?: string
            // 严格校验认领者
            readonly strictOwner?: boolean
          },
          commit?: (seq: number) => Effect.Effect<void>,
        ) {
          return Effect.gen(function* () {
            const durable = definition.durable
            // 非持久化事件无事可做
            if (!durable) return yield* Effect.void
            // 从数据中提取聚合 ID
            const aggregateID = yield* requireAggregateID(event.type, durable.aggregate, event.data)
            if (input && input.aggregateID !== aggregateID) {
              // 重放时聚合 ID 必须一致
              yield* Effect.die(
                new InvalidDurableEventError({
                  type: event.type,
                  message: `Aggregate mismatch: expected ${input.aggregateID}, got ${aggregateID}`,
                }),
              )
            }
            // 取出注册在该类型版本上的投影器
            const list = projectors.get(versionedType(definition.type, durable.version)) ?? []
            // 不可中断执行，保证事务完整性
            return yield* Effect.uninterruptible(
              Effect.gen(function* () {
                // immediate 事务：在同一事务内读取水位、校验并写入
                const committed = yield* db
                  .transaction(
                    () =>
                      Effect.gen(function* () {
                        const row = yield* db
                          // 读取该聚合当前序列水位与认领者
                          .select({ seq: EventSequenceTable.seq, ownerID: EventSequenceTable.owner_id })
                          .from(EventSequenceTable)
                          .where(eq(EventSequenceTable.aggregate_id, aggregateID))
                          .get()
                          .pipe(Effect.orDie)
                        // 无记录视为 -1
                        const latest = row?.seq ?? -1
                        const encode = () =>
                          Schema.encodeUnknownSync(definition.data)(event.data) as Record<string, unknown>
                        if (input?.strictOwner && row?.ownerID && row.ownerID !== input.ownerID) {
                          // 严格模式下认领者不匹配则崩溃
                          yield* Effect.die(
                            new InvalidDurableEventError({
                              type: event.type,
                              message: `Replay owner mismatch for aggregate ${aggregateID}: expected ${row.ownerID}, got ${input.ownerID ?? "none"}`,
                            }),
                          )
                        }
                        if (input && input.seq <= latest) {
                          // 重放序列号不超前：校验是否为已存在的事件
                          // 未持久化时无事可做
                          if (!persist) return
                          const stored = yield* db
                            .select()
                            .from(EventTable)
                            .where(and(eq(EventTable.aggregate_id, aggregateID), eq(EventTable.seq, input.seq)))
                            .get()
                            .pipe(Effect.orDie)
                          if (
                            stored?.id === event.id &&
                            stored.type === versionedType(definition.type, durable.version) &&
                            stored.created === (event.created ?? 0) &&
                            // Rows written before a payload rename compare in their upgraded shape.
                            // 旧载荷先升级形状再比较，保证重命名前的行能匹配
                            isDeepStrictEqual(SessionLegacy.event(definition.type, stored.data), encode())
                          ) {
                            if (input.ownerID && row?.ownerID == null) {
                              // 事件一致但缺认领者则补记
                              yield* db
                                .update(EventSequenceTable)
                                .set({ owner_id: input.ownerID })
                                .where(eq(EventSequenceTable.aggregate_id, aggregateID))
                                .run()
                                .pipe(Effect.orDie)
                            }
                            // 幂等重放：直接返回
                            return
                          }
                          yield* Effect.die(
                            // 与已存内容不一致：重放分叉，崩溃报错
                            new InvalidDurableEventError({
                              type: event.type,
                              message: `Replay diverged at aggregate ${aggregateID} sequence ${input.seq}`,
                            }),
                          )
                        }
                        if (input && row?.ownerID && row.ownerID !== input.ownerID) {
                          // 该聚合已被其他进程认领：静默放弃，不重复写入
                          return
                        }
                        // 分配序列号：重放用给定值，否则递增
                        const seq = input?.seq ?? latest + 1
                        if (input && seq !== latest + 1) {
                          // 重放序列号必须紧接当前水位
                          yield* Effect.die(
                            new InvalidDurableEventError({
                              type: event.type,
                              message: `Sequence mismatch for aggregate ${aggregateID}: expected ${latest + 1}, got ${seq}`,
                            }),
                          )
                        }
                        if (persist) {
                          // 持久化模式下检查事件 ID 唯一性
                          const stored = yield* db
                            .select({ aggregateID: EventTable.aggregate_id, seq: EventTable.seq })
                            .from(EventTable)
                            .where(eq(EventTable.id, event.id))
                            .get()
                            .pipe(Effect.orDie)
                          if (stored)
                            yield* Effect.die(
                              new InvalidDurableEventError({
                                type: event.type,
                                message: `Event ${event.id} already exists at aggregate ${stored.aggregateID} sequence ${stored.seq}`,
                              }),
                            )
                        }
                        // 组装带持久化信封的已提交事件
                        const committed = {
                          ...event,
                          durable: { aggregateID, seq, version: durable.version },
                        } as Event.Payload
                        // 预计算路由
                        const route = yield* prepareRoutes([committed])
                        for (const projector of list) {
                          // 事务内同步执行投影器
                          yield* projector(committed)
                        }
                        // 本地投影回调与事件原子提交
                        if (commit) yield* commit(seq)
                        // 写入/推进聚合序列水位（max 保护不回退），必要时记录认领者
                        yield* db
                          .insert(EventSequenceTable)
                          .values([{ aggregate_id: aggregateID, seq, owner_id: input?.ownerID }])
                          .onConflictDoUpdate({
                            target: EventSequenceTable.aggregate_id,
                            set: {
                              seq: sql`max(${EventSequenceTable.seq}, ${seq})`,
                              ...(input?.ownerID && row?.ownerID == null ? { owner_id: input.ownerID } : {}),
                            },
                          })
                          .run()
                          .pipe(Effect.orDie)
                        if (persist)
                          yield* db
                            // 持久化事件行
                            .insert(EventTable)
                            .values([
                              {
                                id: event.id,
                                aggregate_id: aggregateID,
                                seq,
                                created: event.created ?? 0,
                                type: versionedType(definition.type, durable.version),
                                data: encode(),
                              },
                            ])
                            .run()
                            .pipe(Effect.orDie)
                        return { aggregateID, seq, event: committed, route }
                      }),
                    { behavior: "immediate" },
                  )
                  .pipe(Effect.orDie)
                if (committed) {
                  // 事务提交成功后：应用路由并唤醒等待该聚合的订阅者
                  committed.route()
                  yield* Effect.forEach(
                    pubsub.durable.get(committed.aggregateID) ?? [],
                    (wake) => PubSub.publish(wake, undefined),
                    { discard: true },
                  )
                }
                return committed
              }),
            )
          })
        }

        // publishEvent：发布单个事件——持久化事件走聚合锁 + 落库，易逝事件仅做路由与通知
        function publishEvent<D extends Event.Definition>(
          definition: D,
          event: Event.Payload<D>,
          commit?: PublishOptions["commit"],
        ) {
          return Effect.gen(function* () {
            if (!definition.durable && commit)
              // 本地投影回调只支持持久化事件
              return yield* Effect.die(
                new InvalidDurableEventError({
                  type: event.type,
                  message: "Local commit hooks require a durable event",
                }),
              )
            if (definition.durable) {
              // 提取聚合 ID
              const aggregateID = (event.data as Record<string, unknown>)[definition.durable.aggregate]
              if (typeof aggregateID !== "string")
                // 数据缺失聚合字段：仍提交（内部会崩溃报错），原样返回事件
                return yield* commitDurableEvent(definition, event as Event.Payload, undefined, commit).pipe(
                  Effect.as(event),
                )
              return yield* durableLocks.withLock(aggregateID)(
                // 同一聚合串行发布
                Effect.gen(function* () {
                  const committed = yield* commitDurableEvent(definition, event as Event.Payload, undefined, commit)
                  if (!committed) return event
                  // 用带信封的事件替换
                  event = committed.event as Event.Payload<D>
                  // 通知订阅者（监听器隔离）
                  yield* notify(event as Event.Payload, true)
                  return event
                }),
              )
            }
            // 易逝事件：仅计算路由
            const route = yield* prepareRoutes([event as Event.Payload])
            route()
            yield* notify(event as Event.Payload, false)
            return event
          })
        }

        // observe：观察者包装——监听器失败仅记录日志（中断除外），不影响发布流程
        const observe = (event: Event.Payload, observer: (event: Event.Payload) => Effect.Effect<void>) =>
          Effect.suspend(() => observer(event)).pipe(
            Effect.catchCauseIf(
              // 中断（取消）不算失败
              (cause) => !Cause.hasInterrupts(cause),
              (cause) => Effect.logError("Event listener failed", { eventID: event.id, eventType: event.type, cause }),
            ),
          )

        // notify：通知订阅者——全量监听器 → 实时通道 → 类型订阅者
        function notify(event: Event.Payload, isolateListeners: boolean) {
          return Effect.gen(function* () {
            yield* Effect.forEach(
              listeners,
              // 隔离模式下单个失败不影响其他
              (listener) => (isolateListeners ? observe(event, listener) : listener(event)),
              { discard: true },
            )
            // Type subscribers resume inline and may publish follow-up events, so live subscribers get this one first.
            // 类型订阅者可能内联恢复并发布后续事件，因此实时订阅者先收到本事件
            yield* PubSub.publish(pubsub.live, event)
            const typed = pubsub.typed.get(event.type)
            if (typed)
              yield* Effect.forEach(typed, (subscriber) => PubSub.publish(subscriber, event), { discard: true })
          })
        }

        // makePayload：组装事件载荷——生成 ID、时间戳，并决定事件的位置标签
        const makePayload = (definition: Event.Definition, data: unknown, options: PublishOptions | undefined) =>
          Effect.gen(function* () {
            // 环境中的位置（可选）
            const serviceLocation = Option.getOrUndefined(yield* Effect.serviceOption(Location.Service))
            const location = options?.global
              // 全局事件不带位置
              ? undefined
              : (options?.location ??
                (serviceLocation
                  // 回退到环境位置
                  ? { directory: serviceLocation.directory, workspaceID: serviceLocation.workspaceID }
                  : undefined))
            return {
              // 显式 ID 或新生成
              id: options?.id ?? Event.ID.create(),
              // 创建时间戳
              created: yield* Clock.currentTimeMillis,
              ...(options?.metadata ? { metadata: options.metadata } : {}),
              type: definition.type,
              ...(location ? { location } : {}),
              data,
            } as Event.Payload
          })

        // publish：组装载荷后走发布流程
        function publish<D extends Event.Definition>(definition: D, data: Event.Data<D>, options?: PublishOptions) {
          return Effect.gen(function* () {
            const event = (yield* makePayload(definition, data, options)) as Event.Payload<D>
            return yield* publishEvent(definition, event, options?.commit)
          })
        }

        // publishAll：把多条事件原子地提交到同一聚合（单事务、连续序列号）
        function publishAll<const I extends readonly [PublishInput, ...PublishInput[]]>(events: I) {
          return Effect.gen(function* () {
            // 先组装全部载荷并提取各自聚合 ID
            const payloads = yield* Effect.forEach(events, ([definition, data, options]) =>
              Effect.gen(function* () {
                const aggregateID = yield* requireAggregateID(definition.type, definition.durable.aggregate, data)
                return {
                  definition,
                  aggregateID,
                  commit: options?.commit,
                  event: yield* makePayload(definition, data, options),
                }
              }),
            )
            const aggregateID = payloads[0].aggregateID
            if (payloads.some((item) => item.aggregateID !== aggregateID)) {
              // 全部事件必须属于同一聚合
              return yield* Effect.die(
                new InvalidDurableEventError({
                  type: payloads[0].definition.type,
                  message: "Published events must belong to the same aggregate",
                }),
              )
            }
            return yield* durableLocks.withLock(aggregateID)(
              // 聚合锁内原子提交
              Effect.uninterruptible(
                Effect.gen(function* () {
                  const committed = yield* db
                    .transaction(
                      () =>
                        Effect.gen(function* () {
                          const row = yield* db
                            // 读取当前水位，为批次分配连续序列号
                            .select({ seq: EventSequenceTable.seq })
                            .from(EventSequenceTable)
                            .where(eq(EventSequenceTable.aggregate_id, aggregateID))
                            .get()
                            .pipe(Effect.orDie)
                          // 批次起始序列
                          const firstSeq = (row?.seq ?? -1) + 1
                          // 批次结束序列
                          const finalSeq = firstSeq + payloads.length - 1
                          const queued = payloads.map((item, index) => ({
                            ...item.event,
                            // 预填信封
                            durable: envelope(aggregateID, firstSeq + index, item.definition.durable.version),
                          }))
                          // 整批预计算路由
                          const route = yield* prepareRoutes(queued)
                          const rows = new Array<typeof EventTable.$inferInsert>()
                          const ids = new Set<Event.ID>()
                          for (const [index, item] of payloads.entries()) {
                            const seq = firstSeq + index
                            if (persist) {
                              if (ids.has(item.event.id))
                                // 批内 ID 重复直接崩溃
                                yield* Effect.die(
                                  new InvalidDurableEventError({
                                    type: item.event.type,
                                    message: `Event ${item.event.id} appears more than once in the batch`,
                                  }),
                                )
                              ids.add(item.event.id)
                              const stored = yield* db
                                // 检查事件 ID 是否已存在于库中
                                .select({ aggregateID: EventTable.aggregate_id, seq: EventTable.seq })
                                .from(EventTable)
                                .where(eq(EventTable.id, item.event.id))
                                .get()
                                .pipe(Effect.orDie)
                              if (stored)
                                yield* Effect.die(
                                  new InvalidDurableEventError({
                                    type: item.event.type,
                                    message: `Event ${item.event.id} already exists at aggregate ${stored.aggregateID} sequence ${stored.seq}`,
                                  }),
                                )
                            }
                            const event = queued[index]
                            for (const projector of projectors.get(
                              versionedType(item.definition.type, item.definition.durable.version),
                            ) ?? []) {
                              // 事务内执行投影器
                              yield* projector(event)
                            }
                            // 本地投影回调
                            if (item.commit) yield* item.commit(seq)
                            if (persist)
                              rows.push({
                                id: event.id,
                                aggregate_id: aggregateID,
                                seq,
                                created: event.created,
                                type: versionedType(item.definition.type, item.definition.durable.version),
                                data: Schema.encodeUnknownSync(item.definition.data)(item.event.data) as Record<
                                  string,
                                  unknown
                                >,
                              })
                          }
                          // 一次性把水位推进到批次末尾
                          yield* db
                            .insert(EventSequenceTable)
                            .values([{ aggregate_id: aggregateID, seq: finalSeq }])
                            .onConflictDoUpdate({ target: EventSequenceTable.aggregate_id, set: { seq: finalSeq } })
                            .run()
                            .pipe(Effect.orDie)
                          // 批量落库
                          if (persist) yield* db.insert(EventTable).values(rows).run().pipe(Effect.orDie)
                          return { events: queued, route }
                        }),
                      { behavior: "immediate" },
                    )
                    .pipe(Effect.orDie)
                  // 提交后应用路由
                  committed.route()
                  yield* Effect.forEach(
                    pubsub.durable.get(aggregateID) ?? [],
                    (wake) => PubSub.publish(wake, undefined),
                    {
                      discard: true,
                    },
                  )
                  // 逐个通知订阅者
                  yield* Effect.forEach(committed.events, (event) => notify(event, true), { discard: true })
                  return committed.events as PublishResult<I>
                }),
              ),
            )
          })
        }

        // replay：把序列化事件重放进总线（跨进程恢复/镜像用）
        function replay(
          event: SerializedEvent,
          options?: { readonly publish?: boolean; readonly ownerID?: string; readonly strictOwner?: boolean },
        ) {
          return Effect.gen(function* () {
            const definition = Durable.get(event.type)
            if (!definition?.durable)
              // 未知类型直接崩溃
              return yield* Effect.die(
                new InvalidDurableEventError({ type: event.type, message: `Unknown durable event type ${event.type}` }),
              )
            yield* durableLocks.withLock(event.aggregateID)(
              // 聚合锁内重放
              Effect.gen(function* () {
                const payload = {
                  id: event.id,
                  created: event.created ?? 0,
                  type: definition.type,
                  // 旧形状在此升级
                  data: decodeStoredData(definition, event.data),
                } as Event.Payload
                const committed = yield* commitDurableEvent(definition, payload, {
                  // 期望的序列号
                  seq: event.seq,
                  aggregateID: event.aggregateID,
                  ownerID: options?.ownerID,
                  strictOwner: options?.strictOwner,
                })
                if (committed && options?.publish) {
                  // 可选地通知订阅者
                  yield* notify(committed.event, true)
                }
              }),
            )
          })
        }

        // remove：删除聚合的全部序列与事件行，并清空其路由缓存
        function remove(aggregateID: string) {
          return db
            .transaction(() =>
              Effect.gen(function* () {
                yield* db.delete(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, aggregateID)).run()
                yield* db.delete(EventTable).where(eq(EventTable.aggregate_id, aggregateID)).run()
              }),
            )
            .pipe(
              Effect.tap(() => Effect.sync(() => sessions.delete(aggregateID as SessionID))),
              Effect.orDie,
            )
        }

        // claim：设置聚合的认领者（跨进程协调谁负责重放）
        function claim(aggregateID: string, ownerID: string) {
          return db
            .update(EventSequenceTable)
            .set({ owner_id: ownerID })
            .where(eq(EventSequenceTable.aggregate_id, aggregateID))
            .run()
            .pipe(Effect.orDie)
        }

        // local：按环境位置过滤事件流（无环境位置则原样透传）
        const local = <A extends Event.Payload>(stream: Stream.Stream<A>) =>
          Stream.unwrap(
            Effect.serviceOption(Location.Service).pipe(
              Effect.map((location) =>
                Option.match(location, {
                  // 无环境位置：不过滤
                  onNone: () => stream,
                  onSome: (location) => {
                    const matches = (ref: Location.Ref) =>
                      // 目录与工作区都一致才算命中
                      ref.directory === location.directory && ref.workspaceID === location.workspaceID
                    return stream.pipe(
                      Stream.filter((event) => {
                        // 有预计算路由则按路由投递
                        const refs = routes.get(event)
                        if (refs) return refs.some(matches)
                        // 否则按事件自带位置判断
                        return !event.location || matches(event.location)
                      }),
                    )
                  },
                }),
              ),
            ),
          )

        // subscribe 的三个重载声明（无参 / 单定义 / 多定义）
        function subscribe(): Stream.Stream<Event.Payload>
        function subscribe<D extends Event.Definition>(definition: D): Stream.Stream<Event.Payload<D>>
        function subscribe<const D extends readonly [Event.Definition, ...Event.Definition[]]>(
          definitions: D,
        ): Stream.Stream<SubscribePayload<D>>
        function subscribe(input?: Event.Definition | readonly Event.Definition[]): Stream.Stream<Event.Payload> {
          // 无参订阅：实时全量流
          if (input === undefined) return streamLive()
          // 归一为类型集合
          const types = new Set((isDefinition(input) ? [input] : input).map((definition) => definition.type))
          // One PubSub per subscription, registered under each type, keeps publish order across types.
          // 每个订阅一个 PubSub，并登记到各类型之下，以保持跨类型的发布顺序
          return local(
            Stream.unwrap(
              Effect.acquireRelease(
                PubSub.unbounded<Event.Payload>().pipe(
                  Effect.tap((subscriber) =>
                    Effect.sync(() => {
                      for (const type of types)
                        // 把订阅者登记到各类型
                        pubsub.typed.set(type, (pubsub.typed.get(type) ?? new Set()).add(subscriber))
                    }),
                  ),
                ),
                (subscriber) =>
                  Effect.sync(() => {
                    for (const type of types) {
                      // 释放时逐类型注销
                      const subscribers = pubsub.typed.get(type)
                      subscribers?.delete(subscriber)
                      // 集合为空则删除键
                      if (subscribers?.size === 0) pubsub.typed.delete(type)
                    }
                  }).pipe(Effect.andThen(PubSub.shutdown(subscriber))),
              ).pipe(Effect.flatMap(PubSub.subscribe), Effect.map(Stream.fromSubscription)),
            ),
          )
        }

        // streamLive：实时全量流（受位置过滤）
        const streamLive = (): Stream.Stream<Event.Payload> => local(Stream.fromPubSub(pubsub.live))

        // readAfter：读取某聚合 after 之后、through 之前的一页事件
        const readAfter = (
          aggregateID: string,
          after: number,
          input: { readonly through: number; readonly limit: number },
        ) =>
          (options?.beforeAggregateRead?.(aggregateID) ?? Effect.void).pipe(
            // 读取前钩子
            Effect.andThen(
              Effect.suspend(() => {
                const query = db
                  .select()
                  .from(EventTable)
                  .where(
                    and(
                      eq(EventTable.aggregate_id, aggregateID),
                      // 序列大于游标
                      gt(EventTable.seq, after),
                      // 不越过目标水位
                      lte(EventTable.seq, input.through),
                    ),
                  )
                  // 按序列升序
                  .orderBy(asc(EventTable.seq))
                // 限页读取
                return query.limit(input.limit).all()
              }),
            ),
            Effect.orDie,
            // Skip types missing from the durable manifest instead of failing the
            // read: the aggregate may hold events this process cannot decode. The
            // raw tail seq keeps cursors advancing across the resulting gaps.
            // 跳过本进程无法解码的类型而非整体失败；原始尾序列保证游标跨缺口继续前进
            Effect.map((rows) => ({
              seq: rows.at(-1)?.seq,
              events: rows.flatMap((event) => {
                // 清单中不存在的类型丢弃
                if (!Durable.get(event.type)?.durable) return []
                return [
                  decodeSerializedEvent({
                    id: event.id,
                    created: event.created,
                    aggregateID: event.aggregate_id,
                    seq: event.seq,
                    type: event.type,
                    data: event.data,
                  }),
                ]
              }),
            })),
          )

        // subscribeDurable：订阅某聚合的唤醒信号——注册滑窗 PubSub，释放时注销并关闭
        const subscribeDurable = (aggregateID: string) =>
          Effect.gen(function* () {
            // 滑动窗口：只保留最新一次唤醒
            const wake = yield* PubSub.sliding<void>(1)
            const subscription = yield* PubSub.subscribe(wake)
            yield* Effect.acquireRelease(
              Effect.sync(() => {
                const wakes = pubsub.durable.get(aggregateID) ?? new Set()
                // 登记唤醒通道
                wakes.add(wake)
                pubsub.durable.set(aggregateID, wakes)
              }),
              () =>
                Effect.sync(() => {
                  const wakes = pubsub.durable.get(aggregateID)
                  // 注销
                  wakes?.delete(wake)
                  if (wakes?.size === 0) pubsub.durable.delete(aggregateID)
                }).pipe(Effect.andThen(PubSub.shutdown(wake))),
            )
            return subscription
          })

        // log：按聚合读取持久化事件日志；follow 模式在回放后继续追实时
        const log = (input: {
          readonly aggregateID: string
          readonly after?: number
          readonly follow?: boolean
        }): Stream.Stream<LogItem> =>
          Stream.unwrap(
            Effect.gen(function* () {
              // 当前游标（-1 表示从头开始）
              let sequence = input.after ?? -1
              // readThrough：读到指定水位的分页流；每页推进游标
              const readThrough = (through: number): Stream.Stream<Event.Payload> =>
                Stream.paginate(sequence, (cursor) =>
                  readAfter(input.aggregateID, cursor, { through, limit: logReadPageSize }).pipe(
                    Effect.tap((page) =>
                      Effect.sync(() => {
                        // 用页尾序列推进游标
                        sequence = page.seq ?? sequence
                      }),
                    ),
                    Effect.map(
                      (page) =>
                        [
                          page.events,
                          // 未到水位则继续分页
                          page.seq !== undefined && page.seq < through ? Option.some(page.seq) : Option.none<number>(),
                        ] as const,
                    ),
                  ),
                )
              // Subscribing before the historical read means events committed during
              // replay either appear in the read or arrive through a post-marker wake.
              // 先订阅后回放：回放期间提交的事件要么出现在读取中，要么经唤醒送达
              const wakes = input.follow ? yield* subscribeDurable(input.aggregateID) : undefined
              // 捕获回放水位
              const target = yield* latestSequence(db, input.aggregateID)
              const marker: EventLog.Synced = {
                type: "log.synced",
                aggregateID: input.aggregateID,
                ...(target >= 0 ? { seq: Event.Seq.make(target) } : {}),
              }
              // 回放段 + 同步标记
              const replay: Stream.Stream<LogItem> = readThrough(target).pipe(Stream.concat(Stream.make(marker)))
              // 非 follow 模式：读完即止
              if (!wakes) return replay
              const live: Stream.Stream<LogItem> = Stream.fromSubscription(wakes).pipe(
                // 每次唤醒读取最新水位
                Stream.mapEffect(() => latestSequence(db, input.aggregateID)),
                // 没有新事件则跳过
                Stream.filter((target) => target > sequence),
                // 增量读取新事件
                Stream.flatMap((target) => readThrough(target)),
              )
              return Stream.concat(replay, live)
            }),
          )

        // listen：注册全量监听器，返回取消订阅效果（兼容旧 API）
        const listen = (listener: Subscriber): Effect.Effect<Unsubscribe> =>
          Effect.sync(() => {
            listeners.push(listener)
            return Effect.sync(() => {
              const index = listeners.indexOf(listener)
              // 按引用移除
              if (index >= 0) listeners.splice(index, 1)
            })
          })

        // project：按类型（持久化事件带版本）注册投影器，供事务内调用
        const project = <D extends Event.Definition>(definition: D, projector: Subscriber<D>): Effect.Effect<void> =>
          Effect.sync(() => {
            const key = definition.durable
              ? versionedType(definition.type, definition.durable.version)
              : definition.type
            const list = projectors.get(key) ?? []
            list.push((event) => projector(event as Event.Payload<D>))
            projectors.set(key, list)
          })

        // 暴露服务实现
        return Service.of({
          publish,
          publishAll,
          subscribe,
          log,
          listen,
          project,
          replay,
          remove,
          claim,
        })
      }),
    ),
  })
}

// 默认全局总线节点
export const node = configured()
