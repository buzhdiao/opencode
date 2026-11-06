// 指令状态（InstructionState）模块：在数据库中折叠（fold）每个会话的指令来源状态，
// 记录"当前生效值"及其对应的 blob 哈希，支持观察（observe）、提交（commit）、
// 应用增量（apply）、纪元（epoch）推进与回退（rewind）等操作。
export * as InstructionState from "./instruction-state.js"

// Drizzle 的查询条件操作符与 SQL 模板工具
import { and, eq, gte, inArray, sql } from "drizzle-orm"
// Effect 核心：Effect、Option、Schema
import { Effect, Option, Schema } from "effect"
// 数据库服务（仅类型）
import type { Database } from "../database/database.js"
// 事件总线（仅类型）
import type { Bus } from "../bus.js"
// 指令系统：读取、diff、渲染等能力
import { Instructions } from "../instructions/index.js"
// 会话事件定义（如 InstructionsUpdated）
import { SessionEvent } from "./event.js"
// 会话领域的 Schema（如会话 ID 类型）
import { SessionSchema } from "./schema.js"
// 指令状态表与指令 blob 表的数据库定义
import { InstructionBlobTable, InstructionStateTable } from "./sql.js"

// 数据库服务类型别名
type DatabaseService = Database.Interface["db"]

// 观察（Observation）结果：一次指令读取与已存储状态对比后的产物
export interface Observation extends Instructions.Admission {
  // 目标会话 ID
  readonly sessionID: SessionSchema.ID
  // 是否为初次观察（数据库中尚无该会话的状态记录）
  readonly initial: boolean
  // 观察前的值集（键 -> blob 哈希）
  readonly previous: Instructions.Values
  // 观察后的当前值集（键 -> blob 哈希）
  readonly current: Instructions.Values
}

// observe：读取指令来源并对比数据库中已存储的值，产出 Observation
export const observe = Effect.fn("InstructionState.observe")(function* (
  db: DatabaseService,
  instructions: Instructions.List,
  sessionID: SessionSchema.ID,
): Effect.fn.Return<Observation, Instructions.InitializationBlocked> {
  // 并发执行"读取指令内容"与"查询已存状态"两件事
  const [observed, stored] = yield* Effect.all([Instructions.read(instructions), find(db, sessionID)], {
    concurrency: "unbounded",
  })
  // 用读取结果与存储的当前值做对比，得到准入（admission）结果
  const result = yield* observeAgainst(observed, stored?.current_values)
  return {
    sessionID,
    // 数据库中没有记录即为初次（initial）
    initial: !stored,
    // 之前无记录时 previous 为空对象
    previous: stored?.current_values ?? {},
    ...result,
  }
})

// commit：把一次观察结果作为 InstructionsUpdated 事件发布到总线；
// 只有初次观察或存在增量（delta）时才发布，避免空事件
export const commit = Effect.fn("InstructionState.commit")(function* (
  db: DatabaseService,
  bus: Bus.Interface,
  instructions: Instructions.List,
  observation: Observation,
) {
  // 非初次且没有增量时无需发布
  if (!observation.initial && Object.keys(observation.delta).length === 0) return
  // The rendered text is frozen into the durable event because re-rendering it
  // later would require the original Location-scoped instruction sources.
  // 初次观察不带叙述文本；后续增量则渲染一段变更说明文本
  const text = observation.initial ? "" : yield* renderUpdateText(db, instructions, observation)
  yield* bus.publish(
    SessionEvent.InstructionsUpdated,
    {
      sessionID: observation.sessionID,
      // 事件携带键级增量
      delta: observation.delta,
      // 文本非空时才附带 text 字段
      ...(text.length > 0 ? { text } : {}),
    },
    {
      // Initial sync establishes the baseline; unlike later deltas it is not chronological history.
      // 初次同步只建立基线（baseline），在事件元数据中标记 initial
      ...(observation.initial ? { metadata: { instructions: { initial: true } } } : {}),
      // 事件提交（commit）钩子：事件落库后把新值 blob 写入 blob 表
      commit: () => insertBlobs(db, observation.blobs),
    },
  )
})

// renderUpdateText：渲染"指令更新"的叙述文本，需要取回被替换键的旧值
const renderUpdateText = Effect.fnUntraced(function* (
  db: DatabaseService,
  instructions: Instructions.List,
  observation: Observation,
) {
  // 找出本次增量涉及的键在 previous 中的旧哈希（键 -> 旧哈希）
  const replaced = Object.entries(observation.previous).filter(([key]) => Object.hasOwn(observation.delta, key))
  // 从 blob 表加载这些旧值
  const blobs = yield* loadBlobs(
    db,
    replaced.map(([, hash]) => hash),
  )
  // 还原"键 -> 旧值"映射（缺 blob 会直接抛错）
  const previous = Object.fromEntries(replaced.map(([key, hash]) => [key, requireBlob(blobs, hash)]))
  // 把本次准入的 blob（哈希 -> 值）整理成 Map 供增量解引用
  const admitted = new Map(
    Object.entries(observation.blobs).map(([hash, value]) => [Instructions.Hash.make(hash), value]),
  )
  // 渲染更新文本：旧值 -> 新增量
  return Instructions.renderUpdate(instructions, previous, dereferenceDelta(observation.delta, admitted))
})

// prepare：观察并立即提交一次指令状态（常用于会话开始时同步基线）
export const prepare = Effect.fn("InstructionState.prepare")(function* (
  db: DatabaseService,
  bus: Bus.Interface,
  instructions: Instructions.List,
  sessionID: SessionSchema.ID,
) {
  yield* commit(db, bus, instructions, yield* observe(db, instructions, sessionID))
})

// apply：把一个来自事件的哈希增量应用到数据库状态（事件回放/折叠时使用）
export const apply = Effect.fn("InstructionState.apply")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  seq: number,
  delta: Instructions.Delta,
) {
  // 查询当前已存状态
  const stored = yield* find(db, sessionID)
  // 把增量应用到当前值上得到新值集
  const current = Instructions.applyHashDelta(stored?.current_values ?? {}, delta)
  // 无记录则初始化一条状态
  if (!stored) return yield* initialize(db, sessionID, seq, current)
  // 有记录则推进 through_seq 并写入新的当前值
  yield* db
    .update(InstructionStateTable)
    .set({ through_seq: seq, current_values: current })
    .where(eq(InstructionStateTable.session_id, sessionID))
    .run()
    .pipe(Effect.orDie)
})

// initialize：为会话插入初始状态行（epoch 起点、已推进序号、初始/当前值）
export const initialize = Effect.fn("InstructionState.initialize")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  seq: number,
  values: Instructions.Values,
) {
  yield* db
    .insert(InstructionStateTable)
    .values({
      session_id: sessionID,
      epoch_start: seq,
      through_seq: seq,
      initial_values: values,
      current_values: values,
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

// advanceEpoch：开启新纪元（epoch）——把当前值固化为新的初始值，起点重置为 epochStart
export const advanceEpoch = Effect.fn("InstructionState.advanceEpoch")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  epochStart: number,
) {
  yield* db
    .update(InstructionStateTable)
    .set({
      epoch_start: epochStart,
      through_seq: epochStart,
      // 用 SQL 表达式把 current_values 原样拷贝到 initial_values
      initial_values: sql`${InstructionStateTable.current_values}`,
    })
    .where(eq(InstructionStateTable.session_id, sessionID))
    .run()
    .pipe(Effect.orDie)
})

/**
 * Clears the fold only when a committed revert removed an update or the epoch start. Otherwise the
 * fold still matches the surviving history, and keeping its baseline keeps the prompt cache.
 */
// rewind：回退（rewind）——删除 through_seq 达到边界的折叠状态，
// 使折叠从存续历史的更早位置重建
export const rewind = Effect.fn("InstructionState.rewind")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  boundary: number,
) {
  yield* db
    .delete(InstructionStateTable)
    .where(and(eq(InstructionStateTable.session_id, sessionID), gte(InstructionStateTable.through_seq, boundary)))
    .run()
    .pipe(Effect.orDie)
})

/** Renders the epoch baseline shown at the start of every model request. */
// initial：渲染纪元基线（baseline）文本——每次模型请求开头展示的指令初始内容
export const initial = Effect.fn("InstructionState.initial")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  instructions: Instructions.List,
) {
  // 查询状态；装配阶段状态必须已存在，否则视为缺陷（die）
  const state = yield* find(db, sessionID)
  if (!state) return yield* Effect.die(new Error(`Instruction state not found during assembly: ${sessionID}`))
  // 加载初始值引用的所有 blob
  const blobs = yield* loadBlobs(db, Object.values(state.initial_values))
  // 解引用为真实值后渲染初始文本
  return Instructions.renderInitial(instructions, dereference(state.initial_values, blobs))
})

/** The current instruction values, used to seed a fork's baseline. */
// current：取当前生效的指令值集（键 -> 哈希），用于给 fork 出的会话播种基线
export const current = Effect.fn("InstructionState.current")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  return (yield* find(db, sessionID))?.current_values
})

// preview：预演一次观察，返回"初始文本 + 更新文本"，不落库（供 UI 预览用）
export const preview = Effect.fn("InstructionState.preview")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  instructions: Instructions.List,
  observed: Instructions.ReadResult,
) {
  // 查询已存状态
  const state = yield* find(db, sessionID)
  // 把观察结果与已存当前值对比
  const result = yield* observeAgainst(observed, state?.current_values)
  // 把观察产生的 blob 整理成 Map
  const observedBlobs = new Map<Instructions.Hash, Schema.Json>(
    Object.entries(result.blobs).map(([hash, value]) => [Instructions.Hash.make(hash), value]),
  )
  // 无状态时：整体内容都算初始文本，没有更新文本
  if (!state) {
    const values = dereference(result.current, observedBlobs)
    return { initial: Instructions.renderInitial(instructions, values), update: "" }
  }
  // 有状态时：加载初始值与当前值引用的全部 blob
  const stored = yield* loadBlobs(db, [...Object.values(state.initial_values), ...Object.values(state.current_values)])
  return {
    // 初始文本来自已存的初始值
    initial: Instructions.renderInitial(instructions, dereference(state.initial_values, stored)),
    // 更新文本 = 已存当前值 -> 观察增量
    update: Instructions.renderUpdate(
      instructions,
      dereference(state.current_values, stored),
      dereferenceDelta(result.delta, observedBlobs),
    ),
  }
})

// observeAgainst：把观察结果与可选的旧值对比，返回当前值集与准入信息（delta/blobs 等）
const observeAgainst = Effect.fnUntraced(function* (observed: Instructions.ReadResult, previous?: Instructions.Values) {
  // 计算 diff 并得到准入（可能被初始化阻断）
  const admission = yield* Instructions.diff(observed, previous)
  return {
    // 把增量应用到旧值上得到当前值集
    current: Instructions.applyHashDelta(previous ?? {}, admission.delta),
    ...admission,
  }
})

// find：按会话 ID 查询单条状态记录（可能不存在）
const find = Effect.fnUntraced(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  return yield* db
    .select()
    .from(InstructionStateTable)
    .where(eq(InstructionStateTable.session_id, sessionID))
    .get()
    .pipe(Effect.orDie)
})

// insertBlobs：把哈希 -> JSON 值的集合插入 blob 表，冲突时忽略（幂等）
const insertBlobs = Effect.fnUntraced(function* (db: DatabaseService, blobs: Readonly<Record<string, Schema.Json>>) {
  // 整理为行记录
  const rows = Object.entries(blobs).map(([hash, value]) => ({ hash: Instructions.Hash.make(hash), value }))
  // 空集合直接返回
  if (rows.length === 0) return
  yield* db.insert(InstructionBlobTable).values(rows).onConflictDoNothing().run().pipe(Effect.orDie)
})

// loadBlobs：按哈希批量加载 blob 值，返回哈希 -> 值的 Map；任何缺失都视为缺陷
const loadBlobs = Effect.fnUntraced(function* (db: DatabaseService, values: ReadonlyArray<Instructions.Hash>) {
  // 先去重
  const hashes = [...new Set(values)]
  // 按 500 个一批切分，避免 SQL IN 子句过大
  const batches = Array.from({ length: Math.ceil(hashes.length / 500) }, (_, index) =>
    hashes.slice(index * 500, (index + 1) * 500),
  )
  // 并发 4 路执行各批次查询，再拍平结果
  const rows = (yield* Effect.forEach(
    batches,
    (batch) =>
      db.select().from(InstructionBlobTable).where(inArray(InstructionBlobTable.hash, batch)).all().pipe(Effect.orDie),
    { concurrency: 4 },
  )).flat()
  // 建立哈希 -> 值的映射
  const blobs = new Map(rows.map((row) => [row.hash, row.value]))
  // 校验每个请求的哈希都存在，缺失则 die（数据一致性被破坏）
  for (const hash of hashes) {
    if (!blobs.has(hash)) return yield* Effect.die(new Error(`Instruction blob not found: ${hash}`))
  }
  return blobs
})

// dereference：把"键 -> 哈希"的值集解引用为"键 -> 真实 JSON 值"
function dereference(
  values: Instructions.Values,
  blobs: ReadonlyMap<Instructions.Hash, Schema.Json>,
): Readonly<Record<string, Schema.Json>> {
  return Object.fromEntries(Object.entries(values).map(([key, hash]) => [key, requireBlob(blobs, hash)]))
}

// dereferenceDelta：把哈希增量解引用为"键 -> Option(值)"；removed 表示该键被移除
function dereferenceDelta(
  delta: Instructions.Delta,
  blobs: ReadonlyMap<Instructions.Hash, Schema.Json>,
): Readonly<Record<string, Option.Option<Schema.Json>>> {
  return Object.fromEntries(
    Object.entries(delta).map(([key, hash]) => [
      key,
      hash === "removed" ? Option.none() : Option.some(requireBlob(blobs, hash)),
    ]),
  )
}

// requireBlob：从 Map 中取 blob 值，缺失则抛错（调用方假定其必然存在）
function requireBlob(blobs: ReadonlyMap<Instructions.Hash, Schema.Json>, hash: Instructions.Hash) {
  const value = blobs.get(hash)
  if (value === undefined) throw new Error(`Instruction blob not found: ${hash}`)
  return value
}
