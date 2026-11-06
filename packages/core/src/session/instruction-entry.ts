// 指令条目（InstructionEntry）存储模块：管理某个会话注入的"上下文条目"。
// 每个条目是 (sessionID, key) 唯一的键值对，会被渲染为模型可见的上下文，
// 并支持更新与（软）移除，移除后仍保留历史叙述供模型感知。
export * as InstructionEntry from "./instruction-entry.js"

// Drizzle ORM 的查询条件与排序操作符
import { and, asc, eq, isNotNull, isNull, ne, or } from "drizzle-orm"
// Effect 生态核心：Context（依赖注入）、Effect、Layer（层装配）、Schema（校验）
import { Context, Effect, Layer, Schema } from "effect"
// 指令条目的 Schema 定义（键、值、快照、超限错误等）
import { InstructionEntry } from "@opencode/schema/instruction-entry"
// 数据库服务（封装 Drizzle db 实例）
import { Database } from "../database/database.js"
// 全局单例节点（node）构造工具：把服务注册为进程级单例
import { makeGlobalNode } from "@opencode/util/effect/app-node"
// 指令（Instructions）系统：把条目转换为模型上下文来源
import { Instructions } from "../instructions/index.js"
// 会话领域的 Schema（如会话 ID 类型）
import { SessionSchema } from "./schema.js"
// 指令条目的数据库表定义
import { InstructionEntryTable } from "./sql.js"

// 导出条目键（Key）的 Schema
export const Key = InstructionEntry.Key
// Key 的类型别名（从 Schema 推导）
export type Key = typeof Key.Type
// 导出条目信息（Info）的 Schema
export const Info = InstructionEntry.Info
// Info 的类型别名
export type Info = typeof Info.Type
// 导出快照（Snapshot）Schema
export const Snapshot = InstructionEntry.Snapshot
// Snapshot 的类型别名
export type Snapshot = typeof Snapshot.Type
// 单个条目值的最大字节数限制
export const MaxValueBytes = InstructionEntry.MaxValueBytes
// 值超限（ValueTooLarge）时的错误类型
export const ValueTooLargeError = InstructionEntry.ValueTooLargeError

// 数据库服务类型别名：从 Database.Interface 中取出 db 实例的类型
type DatabaseService = Database.Interface["db"]
// 批量插入的批大小（batch size）：每次 INSERT 最多写入的条目数
const InsertBatchSize = 10

// snapshot：读取某个会话的全部条目（包含已移除的），用于完整快照
export const snapshot = Effect.fn("InstructionEntry.snapshot")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  // 第三个参数传 true，表示包含 removed 标记的行
  return yield* rows(db, sessionID, true)
})

// rows：按 key 升序查询指定会话的条目行；includeRemoved 决定是否过滤已移除条目
const rows = Effect.fnUntraced(function* (db: DatabaseService, sessionID: SessionSchema.ID, includeRemoved: boolean) {
  return yield* db
    .select({
      key: InstructionEntryTable.key,
      value: InstructionEntryTable.value,
      removed: InstructionEntryTable.removed,
    })
    .from(InstructionEntryTable)
    .where(
      and(
        eq(InstructionEntryTable.session_id, sessionID),
        includeRemoved ? undefined : eq(InstructionEntryTable.removed, false),
      ),
    )
    .orderBy(asc(InstructionEntryTable.key))
    .all()
    .pipe(Effect.orDie)
})

// initialize：把一个快照（初始条目集合）批量写入数据库，创建/更新时间统一为 created
export const initialize = Effect.fn("InstructionEntry.initialize")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  entries: Snapshot,
  created: number,
) {
  // 把条目列表按 InsertBatchSize 切成若干批次
  const batches = Array.from({ length: Math.ceil(entries.length / InsertBatchSize) }, (_, index) =>
    entries.slice(index * InsertBatchSize, (index + 1) * InsertBatchSize),
  )
  // 逐批插入；discard: true 表示不关心每批的返回值
  yield* Effect.forEach(
    batches,
    (batch) =>
      db
        .insert(InstructionEntryTable)
        .values(
          batch.map((entry) => ({
            ...entry,
            session_id: sessionID,
            time_created: created,
            time_updated: created,
          })),
        )
        .run()
        .pipe(Effect.orDie),
    { discard: true },
  )
})

// 服务接口：声明本服务对外提供的能力（列表、写入、移除、加载为指令来源）
export interface Interface {
  // list：列出会话中未移除条目的键值对
  readonly list: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<Info>>
  // put：写入/更新一个条目；值过大时以 ValueTooLargeError 失败
  readonly put: (input: {
    readonly sessionID: SessionSchema.ID
    readonly key: Key
    readonly value: Schema.Json
  }) => Effect.Effect<void, InstructionEntry.ValueTooLargeError>
  // remove：移除一个条目（软删除）
  readonly remove: (input: { readonly sessionID: SessionSchema.ID; readonly key: Key }) => Effect.Effect<void>
  /** Produces one Instructions source per stored entry, keyed `api/<key>`. */
  readonly load: (sessionID: SessionSchema.ID) => Effect.Effect<Instructions.List>
}

// 服务标识：Effect Context 中用于定位本服务的 Tag
export class Service extends Context.Service<Service, Interface>()("@opencode/InstructionEntry") {}

// renderValue：把 JSON 值渲染为文本——字符串原样输出，其余类型格式化为两空格缩进的 JSON
const renderValue = (value: Schema.Json) => (typeof value === "string" ? value : JSON.stringify(value, null, 2))

// renderBlock：把一个条目渲染为 <context key="...">...</context> 包裹的文本块（按行拼接）
const renderBlock = (key: Key, value: Schema.Json) =>
  [`<context key="${key}">`, renderValue(value), "</context>"].join("\n")

// Rendering stays mechanism-neutral: the model sees session context, not how
// it was attached. Only chronological updates and removals carry narration.
// source：把一个条目转换为 Instructions 指令来源（键为 api/<key>）
const source = (entry: Info & { readonly removed: boolean }) =>
  Instructions.make<Schema.Json>({
    // 来源键：加 api/ 前缀，把会话注入的上下文与用户文件类指令区分开
    key: Instructions.Key.make(`api/${entry.key}`),
    // 编解码器（codec）：值按 JSON 编解码
    codec: Schema.toCodecJson(Schema.Json),
    // read：读取当前值；已移除的条目返回 Instructions.removed 哨兵值
    read: Effect.succeed(entry.removed ? Instructions.removed : entry.value),
    // render：定义初始、变更、移除三种渲染形态
    render: {
      // initial：首次注入时渲染上下文块
      initial: (value) => renderBlock(entry.key, value),
      // changed：值变更时提示模型新值取代旧值
      changed: (_previous, value) =>
        [
          `The context under "${entry.key}" changed and supersedes the previous value:`,
          renderBlock(entry.key, value),
        ].join("\n"),
      // removed：移除时提示模型忽略该上下文
      removed: () => `The context under "${entry.key}" no longer applies. Disregard it.`,
    },
  })

// 服务层（Layer）：装配 list/put/remove/load 四个能力的具体实现
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 注入数据库服务
    const { db } = yield* Database.Service

    // list：查询未移除的条目并映射为 { key, value } 列表
    const list = Effect.fn("InstructionEntry.list")(function* (sessionID: SessionSchema.ID) {
      return (yield* rows(db, sessionID, false)).map((row) => ({ key: row.key, value: row.value }))
    })

    // put：先做大小校验，再以 (session_id, key) 为冲突目标执行 upsert；
    // setWhere 保证只有"从已移除恢复"或"值真正变化"时才更新，避免无谓写入
    const put = Effect.fn("InstructionEntry.put")(function* (input: Parameters<Interface["put"]>[0]) {
      // 计算值的 UTF-8 字节数，用于上限校验
      const actualBytes = Buffer.byteLength(JSON.stringify(input.value), "utf8")
      // 超过上限则以 ValueTooLargeError 失败
      if (actualBytes > MaxValueBytes)
        yield* new ValueTooLargeError({
          actualBytes,
          maxBytes: MaxValueBytes,
          message: `Instruction entry value is ${actualBytes} bytes; the limit is ${MaxValueBytes} bytes`,
        })
      // 构造"值是否变化"的 SQL 条件：写入 null 时要求旧值非空；否则要求旧值为空或不等于新值
      const changed =
        input.value === null
          ? isNotNull(InstructionEntryTable.value)
          : or(isNull(InstructionEntryTable.value), ne(InstructionEntryTable.value, input.value))
      yield* db
        .insert(InstructionEntryTable)
        .values({ session_id: input.sessionID, key: input.key, value: input.value, removed: false })
        .onConflictDoUpdate({
          target: [InstructionEntryTable.session_id, InstructionEntryTable.key],
          set: { value: input.value, removed: false, time_updated: Date.now() },
          setWhere: or(eq(InstructionEntryTable.removed, true), changed),
        })
        .run()
        .pipe(Effect.orDie)
    })

    // remove：软删除——把值置空并标记 removed（仅对尚未移除的行生效）
    const remove = Effect.fn("InstructionEntry.remove")(function* (input: Parameters<Interface["remove"]>[0]) {
      yield* db
        .update(InstructionEntryTable)
        .set({ value: null, removed: true, time_updated: Date.now() })
        .where(
          and(
            eq(InstructionEntryTable.session_id, input.sessionID),
            eq(InstructionEntryTable.key, input.key),
            eq(InstructionEntryTable.removed, false),
          ),
        )
        .run()
        .pipe(Effect.orDie)
    })

    // load：把全部条目（含已移除，以便记录移除叙述）转换为指令来源并合并成列表
    const load = Effect.fn("InstructionEntry.load")(function* (sessionID: SessionSchema.ID) {
      return Instructions.combine((yield* rows(db, sessionID, true)).map(source))
    })

    // 用上述实现构建服务实例
    return Service.of({ list, put, remove, load })
  }),
)

// 注册为全局单例节点，依赖数据库节点
export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
