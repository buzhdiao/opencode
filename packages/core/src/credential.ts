// 凭据（Credential）服务：在数据库中持久化各集成（integration）的凭据，提供增删改查、激活切换与并发去重，并通过事件总线广播变更。
export * as Credential from "./credential.js"

import { asc, desc, eq, type SQL } from "drizzle-orm"
import { Cause, Context, Effect, Fiber, Layer, Schema } from "effect"
import { Credential } from "@opencode/schema/credential"
import { CredentialLegacy } from "@opencode/schema/credential-legacy"
import { Integration } from "@opencode/schema/integration"
import { Database } from "./database/database.js"
import { Bus } from "./bus.js"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { EffectFlock } from "@opencode/util/effect-flock"
import { CredentialTable } from "./credential/sql.js"
import { ErrorSummary } from "./util/error-summary.js"

// 转发导出 schema 的凭据 ID（ID）类型与编解码器
export const ID = Credential.ID
export type ID = Credential.ID

// OAuth 型凭据（含访问/刷新令牌）
export const OAuth = Credential.OAuth
export type OAuth = Credential.OAuth

// API 密钥（Key）型凭据
export const Key = Credential.Key
export type Key = Credential.Key

// 外部（External）型凭据：由外部系统托管的凭据引用
export const External = Credential.External
export type External = Credential.External

// 凭据取值（Value）联合类型：OAuth | Key | External
export const Value = Credential.Value
export type Value = Credential.Value

// 凭据事件定义（Updated / Switched 等）
export const Event = Credential.Event

// 凭据信息（Info）：ID、所属集成、显示标签与机密取值
export class Info extends Schema.Class<Info>("Credential.Info")({
  // 凭据唯一 ID
  id: ID,
  // 所属集成 ID
  integrationID: Integration.ID,
  // 显示标签
  label: Schema.String,
  // 机密取值
  value: Value,
}) {}

// 服务接口：凭据的查询、并发锁与增删改
export interface Interface {
  /** Returns every stored credential. */
  // 返回全部已存储凭据
  readonly all: () => Effect.Effect<Info[]>
  /** Returns stored credentials belonging to one integration. */
  // 返回属于某个集成的已存储凭据
  readonly list: (integrationID: Integration.ID) => Effect.Effect<Info[]>
  /** Returns one stored credential by ID. */
  // 按 ID 返回单个凭据
  readonly get: (id: ID) => Effect.Effect<Info | undefined>
  /** Concurrent callers for the same credential share the running operation's result, including failures. */
  // 同一凭据的并发调用共享正在运行的操作结果（包括失败）
  readonly lock: (
    id: ID,
    operation: Effect.Effect<OAuth | undefined, unknown>,
  ) => Effect.Effect<OAuth | undefined, unknown>
  /**
   * Creates a credential for an integration and returns the new record. The new credential becomes the
   * integration's selection unless `activate` is false and the integration already has a credential.
   */
  // 为集成创建凭据并返回新记录；默认激活，仅当显式 activate=false 且已有凭据时不激活
  readonly create: (input: {
    readonly id?: ID
    readonly integrationID: Integration.ID
    readonly value: Value
    readonly label?: string
    readonly activate?: boolean
  }) => Effect.Effect<Info>
  /** Selects a stored credential for its integration. */
  // 选中某凭据作为其集成的当前激活凭据
  readonly activate: (id: ID) => Effect.Effect<void>
  /** Updates the label or secret value of a stored credential. */
  // 更新已存凭据的标签或机密值
  readonly update: (id: ID, updates: Partial<Pick<Info, "label" | "value">>) => Effect.Effect<void>
  /** Removes a stored credential. */
  // 删除已存凭据
  readonly remove: (id: ID) => Effect.Effect<void>
}

// Effect 服务令牌（Service tag）
export class Service extends Context.Service<Service, Interface>()("@opencode/Credential") {}

// 服务实现层
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 取出数据库句柄
    const db = (yield* Database.Service).db
    // 事件总线，用于广播凭据事件
    const bus = yield* Bus.Service
    // 跨进程文件锁服务
    const flock = yield* EffectFlock.Service
    // 当前作用域，用于托管后台操作
    const scope = yield* Effect.scope
    // 进行中的刷新操作：凭据 ID → Fiber
    const pending = new Map<ID, Fiber.Fiber<OAuth | undefined, unknown>>()
    // Rows written before v2.1 may carry the old key credential shape.
    // v2.1 之前写入的行可能携带旧版 key 凭据形状，统一经旧版解码器升级
    const decode = Schema.decodeUnknownSync(CredentialLegacy.Value)
    // 把数据库行转换为 Info；缺少 integration_id 的行视为无效
    const stored = (row: typeof CredentialTable.$inferSelect) => {
      if (!row.integration_id) return
      return new Info({
        id: row.id,
        integrationID: row.integration_id,
        label: row.label,
        // 旧形状在此处升级
        value: decode(row.value),
      })
    }
    // 批量转换并过滤无效行
    const storedRows = (rows: ReadonlyArray<typeof CredentialTable.$inferSelect>) =>
      rows.flatMap((row) => {
        const credential = stored(row)
        return credential ? [credential] : []
      })
    // 查询行：可带 where 条件，按激活状态、创建时间与 ID 升序
    const rows = (where?: SQL) =>
      db
        .select()
        .from(CredentialTable)
        .where(where)
        .orderBy(asc(CredentialTable.active), asc(CredentialTable.time_created), asc(CredentialTable.id))
        .all()
        .pipe(Effect.orDie, Effect.map(storedRows))
    // 事务参数类型：从 db.transaction 的回调签名推导
    type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
    // 查询某集成当前激活的凭据（排序后的第一条）
    const currentActive = (tx: Transaction, integrationID: Integration.ID) =>
      tx
        .select({ id: CredentialTable.id, active: CredentialTable.active })
        .from(CredentialTable)
        .where(eq(CredentialTable.integration_id, integrationID))
        .orderBy(desc(CredentialTable.active), desc(CredentialTable.time_created), desc(CredentialTable.id))
        .get()
    // 取消该集成所有凭据的激活标记
    const deactivateAll = (tx: Transaction, integrationID: Integration.ID) =>
      tx.update(CredentialTable).set({ active: false }).where(eq(CredentialTable.integration_id, integrationID)).run()
    // 切换激活：先全量取消再激活指定凭据
    const switchActive = (tx: Transaction, integrationID: Integration.ID, id: ID) =>
      Effect.gen(function* () {
        yield* deactivateAll(tx, integrationID)
        yield* tx.update(CredentialTable).set({ active: true }).where(eq(CredentialTable.id, id)).run()
      })
    // 日志包装器：失败时记录错误摘要并把错误 orDie 化（数据库错误不可恢复）
    const logFailure =
      (message: string, fields: Record<string, unknown>) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.onError((cause) =>
            Effect.logError(message, { ...fields, errors: ErrorSummary.from(Cause.squash(cause)) }),
          ),
          Effect.orDie,
        )

    return Service.of({
      // lock：同一凭据的并发刷新去重——已有进行中的 Fiber 就直接等待并共享其结果
      lock: Effect.fn("Credential.lock")((id, operation) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            // 查看是否已有进行中的操作
            const current = pending.get(id)
            // 有则共享等待其完成
            if (current) return yield* restore(Fiber.join(current))
            // The global scope owns the operation, not the first Session or Location waiting for it.
            // The file lock extends this to other processes sharing the database.
            // 操作托管在全局作用域上（而非首个等待者），文件锁进一步把互斥扩展到共享数据库的其他进程
            const fiber = yield* operation.pipe(
              // 跨进程互斥
              flock.withLock(`credential-refresh:${id}`),
              // 完成后清理 pending 登记
              Effect.ensuring(Effect.sync(() => pending.delete(id))),
              // 在全局作用域后台运行
              Effect.forkIn(scope),
            )
            // 登记进行中的操作
            pending.set(id, fiber)
            // 等待并共享结果
            return yield* restore(Fiber.join(fiber))
          }),
        ),
      ),
      // 全部凭据
      all: () => rows(),
      // 按集成过滤
      list: Effect.fn("Credential.list")((integrationID) => rows(eq(CredentialTable.integration_id, integrationID))),
      get: Effect.fn("Credential.get")(function* (id) {
        // 查询单行
        const row = yield* db.select().from(CredentialTable).where(eq(CredentialTable.id, id)).get().pipe(Effect.orDie)
        // 转换为 Info 或 undefined
        return row ? stored(row) : undefined
      }),
      create: Effect.fn("Credential.create")(function* (input) {
        // 组装新凭据：未传 ID 则生成，未传标签则用 "default"
        const credential = new Info({
          id: input.id ?? ID.create(),
          integrationID: input.integrationID,
          label: input.label ?? "default",
          value: input.value,
        })
        // 在单个事务里完成激活决策与插入
        const activated = yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              // 当前激活凭据
              const current = yield* currentActive(tx, credential.integrationID)
              // 默认激活；仅当显式不激活且已有凭据时才不激活
              const activate = input.activate !== false || !current
              // 激活新凭据前先取消其他凭据
              if (activate) yield* deactivateAll(tx, credential.integrationID)
              // Legacy rows have no active flag and the newest one is selected, so pin it before inserting a newer row.
              // 旧版行没有激活标记且默认选最新一行，因此插入新行前先把旧行钉为激活
              if (!activate && current && !current.active)
                yield* tx.update(CredentialTable).set({ active: true }).where(eq(CredentialTable.id, current.id)).run()
              yield* tx
                .insert(CredentialTable)
                .values({
                  id: credential.id,
                  integration_id: credential.integrationID,
                  label: credential.label,
                  value: credential.value,
                  // 是否作为激活凭据插入
                  active: activate,
                })
                .run()
              return activate
            }),
          )
          .pipe(
            logFailure("credential create failed", {
              // 失败时记录错误摘要
              credentialID: credential.id,
              integrationID: credential.integrationID,
            }),
          )
        // 记录创建成功的结构化日志
        yield* Effect.logInfo("credential created", {
          credentialID: credential.id,
          integrationID: credential.integrationID,
          type: credential.value.type,
          active: activated,
        })
        // 广播凭据更新事件（全局）
        yield* bus.publish(Event.Updated, {}, { global: true })
        if (activated)
          // 若新凭据被激活，再广播切换事件
          yield* bus.publish(
            Event.Switched,
            { integrationID: credential.integrationID, credentialID: credential.id },
            { global: true },
          )
        return credential
      }),
      activate: Effect.fn("Credential.activate")(function* (id) {
        // 事务内完成查找与切换，返回受影响的集成 ID（无需切换时返回 undefined）
        const integrationID = yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              // 查目标凭据
              const credential = yield* tx.select().from(CredentialTable).where(eq(CredentialTable.id, id)).get()
              // 不存在或无所属集成则无事
              if (!credential?.integration_id) return
              // 当前激活凭据
              const active = yield* currentActive(tx, credential.integration_id)
              // 已是激活状态则无事
              if (active?.id === id) return
              // 执行切换
              yield* switchActive(tx, credential.integration_id, id)
              return credential.integration_id
            }),
          )
          .pipe(logFailure("credential activate failed", { credentialID: id }))
        if (integrationID) {
          // 确有切换才记录日志并广播
          yield* Effect.logInfo("credential activated", { integrationID, credentialID: id })
          yield* bus.publish(Event.Switched, { integrationID, credentialID: id }, { global: true })
        }
      }),
      update: Effect.fn("Credential.update")(function* (id, updates) {
        // 没有任何更新则直接返回
        if (updates.label === undefined && updates.value === undefined) return
        // 先查现有凭据以判断是否需要更新
        const credential = yield* db
          .select({ integrationID: CredentialTable.integration_id, label: CredentialTable.label })
          .from(CredentialTable)
          .where(eq(CredentialTable.id, id))
          .get()
          .pipe(logFailure("credential update lookup failed", { credentialID: id }))
        if (!credential?.integrationID) {
          // 凭据缺失则告警并跳过
          yield* Effect.logWarning("credential update skipped", { credentialID: id, reason: "credential_missing" })
          return
        }
        // 标签未变且无值更新则跳过
        if (updates.label === credential.label && updates.value === undefined) return
        // 执行更新并要求返回 ID，以确认该行仍存在
        const updated = yield* db
          .update(CredentialTable)
          .set({ label: updates.label, value: updates.value })
          .where(eq(CredentialTable.id, id))
          .returning({ id: CredentialTable.id })
          .get()
          .pipe(logFailure("credential update failed", { credentialID: id, integrationID: credential.integrationID }))
        if (!updated) {
          // 行已被并发删除则告警并跳过
          yield* Effect.logWarning("credential update skipped", { credentialID: id, reason: "credential_removed" })
          return
        }
        // 记录更新详情日志
        yield* Effect.logInfo("credential updated", {
          credentialID: id,
          integrationID: credential.integrationID,
          valueChanged: updates.value !== undefined,
          labelChanged: updates.label !== undefined && updates.label !== credential.label,
        })
        if (updates.label !== undefined && updates.label !== credential.label)
          // 标签确实变化才广播更新事件
          yield* bus.publish(Event.Updated, {}, { global: true })
      }),
      remove: Effect.fn("Credential.remove")(function* (id) {
        // 事务内完成删除与激活替补选择
        const removed = yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              // 查目标凭据
              const credential = yield* tx.select().from(CredentialTable).where(eq(CredentialTable.id, id)).get()
              // 不存在则无事
              if (!credential) return
              // 当前激活凭据
              const active = credential.integration_id ? yield* currentActive(tx, credential.integration_id) : undefined
              // 删除该行
              yield* tx.delete(CredentialTable).where(eq(CredentialTable.id, id)).run()
              if (!credential.integration_id || active?.id !== id)
                // 删除的不是激活凭据则无需切换
                return { switched: false as const, integrationID: credential.integration_id }
              // 被删的是激活凭据：选最新的存活凭据作为替补
              const replacement = yield* tx
                .select({ id: CredentialTable.id })
                .from(CredentialTable)
                .where(eq(CredentialTable.integration_id, credential.integration_id))
                .orderBy(desc(CredentialTable.time_created), desc(CredentialTable.id))
                .get()
              // 有替补则激活之
              if (replacement) yield* switchActive(tx, credential.integration_id, replacement.id)
              return {
                switched: true as const,
                integrationID: credential.integration_id,
                // 可能没有替补
                credentialID: replacement?.id ?? null,
              }
            }),
          )
          .pipe(logFailure("credential remove failed", { credentialID: id }))
        // 凭据本就不存在
        if (!removed) return
        // 记录删除日志（含替补信息）
        yield* Effect.logInfo("credential removed", {
          credentialID: id,
          integrationID: removed.integrationID,
          active: removed.switched,
          ...(removed.switched ? { replacementID: removed.credentialID } : {}),
        })
        // 广播更新
        yield* bus.publish(Event.Updated, {}, { global: true })
        if (removed.switched)
          // 发生切换则广播切换事件
          yield* bus.publish(
            Event.Switched,
            { integrationID: removed.integrationID, credentialID: removed.credentialID },
            { global: true },
          )
      }),
    })
  }),
)

// 全局节点：凭据服务全局唯一，依赖数据库、总线与文件锁节点
export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, Bus.node, EffectFlock.node] })
