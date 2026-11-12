// 将本模块以命名空间 Instructions 的形式再导出
export * as Instructions from "./index.js"

// 引入 hash 创建工具
import { createHash } from "crypto"
// 引入指令相关的 schema 定义
import { Instruction } from "@opencode/schema/instruction"
// 引入 Effect 的数据类型、副作用、Option 与 Schema 工具
import { Data, Effect, Option, Schema } from "effect"
import { canonicalJson } from "../util/canonical-json.js"

// 转发导出 Key 及其类型
export const Key = Instruction.Key
export type Key = Instruction.Key
// 转发导出 Hash 及其类型
export const Hash = Instruction.Hash
export type Hash = Instruction.Hash
// 转发导出 Values 及其类型
export const Values = Instruction.Values
export type Values = Instruction.Values
// 转发导出 Delta 及其类型
export const Delta = Instruction.Delta
export type Delta = Instruction.Delta

// 非值（NonValue）类型：读取失败的两种特殊标记
type NonValue = Data.TaggedEnum<{ Unavailable: {}; Removed: {} }>
// 生成 NonValue 的构造器与判别函数
const NonValue = Data.taggedEnum<NonValue>()

/** The read failed temporarily; the stored value stands. */
// 临时读取失败标记：继续沿用已存储的值
export const unavailable = NonValue.Unavailable()
export type Unavailable = typeof unavailable

/** An observed absence: the source exists but its value is gone. */
// 观察到的缺失标记：来源存在但其值已消失
export const removed = NonValue.Removed()
export type Removed = typeof removed

/**
 * One composable instruction source over canonical JSON — the same
 * representation that is hashed, stored, and replayed. `make` builds one from
 * a typed definition; renderers returning `undefined` skip (undecodable or
 * unrenderable historical values).
 */
// 单个可组合的指令来源：以规范化 JSON 为载体（哈希/存储/重放用同一表示）；渲染函数返回 undefined 表示跳过
export interface Source {
  // 指令键
  readonly key: Key
  // 读取当前值的副作用（可能返回不可用/已移除标记）
  readonly read: Effect.Effect<Schema.Json | Unavailable | Removed>
  // 首次出现时渲染的文本
  readonly initial: (value: Schema.Json) => string | undefined
  // 值变化时渲染的文本
  readonly changed: (previous: Schema.Json, current: Schema.Json) => string | undefined
  // 值被移除时渲染的文本
  readonly removed: (previous: Schema.Json) => string | undefined
}

// Source 的命名空间声明：构造来源时提供的类型化定义
export declare namespace Source {
  /** The typed definition supplied when constructing a source. */
  export interface Definition<A> {
    // 指令键
    readonly key: Key
    // 类型 A 与 JSON 之间的编解码器（codec）
    readonly codec: Schema.Codec<A, Schema.Json>
    // 读取强类型值
    readonly read: Effect.Effect<A | Unavailable | Removed>
    // 渲染规则
    readonly render: {
      readonly initial: (current: A) => string
      readonly changed: (previous: A, current: A) => string | undefined
      readonly removed?: (previous: A) => string
    }
  }
}

/** Ordered sources; identical values render identical bytes. */
// 有序来源列表：相同的值总能渲染出相同的字节
export type List = ReadonlyArray<Source>

// 一次读取的结果：键到值/标记的只读数组
export type ReadResult = ReadonlyArray<{
  readonly key: Key
  readonly value: Schema.Json | Unavailable | Removed
}>

// 准入（Admission）结构：哈希增量与对应的内容块
export interface Admission {
  readonly delta: Delta
  readonly blobs: Readonly<Record<string, Schema.Json>>
}

// 初始化受阻错误：存在不可用的来源时阻止初始化
export class InitializationBlocked extends Schema.TaggedError<InitializationBlocked>()(
  "Instructions.InitializationBlocked",
  { keys: Schema.Array(Key) },
) {
  override get message() {
    return `Instruction initialization blocked by unavailable sources: ${this.keys.join(", ")}`
  }
}

// 重复键错误：组合来源时不允许出现重复的指令键
export class DuplicateKeyError extends Schema.TaggedError<DuplicateKeyError>()("Instructions.DuplicateKeyError", {
  key: Key,
}) {
  override get message() {
    return `Duplicate instruction key: ${this.key}`
  }
}

// 空的来源列表
export const empty: List = []

/** Closes a typed definition into one `Source`, so differently typed sources compose. */
// 将类型化定义封装为统一的 Source，使不同类型的来源可以组合
export function make<A>(source: Source.Definition<A>): List {
  // 构造 JSON -> A 的解码器（失败返回 undefined）
  const decode = Schema.decodeUnknownOption(source.codec)
  // 构造 A -> JSON 的同步编码器
  const encode = Schema.encodeSync(source.codec)
  // 首次渲染：校验文本非空后返回
  const initial = (value: A) => requireText(source.key, "initial", source.render.initial(value))
  // 解码 JSON 值，失败时得到 undefined（历史值可能无法解码）
  const decodeValue = (value: Schema.Json) => Option.getOrUndefined(decode(value))
  return [
    {
      key: source.key,
      // 读取：把强类型值映射为 JSON；不可用/已移除标记原样传递
      read: source.read.pipe(
        Effect.map((value) => {
          if (isUnavailable(value)) return unavailable
          if (isRemoved(value)) return removed
          return encode(value)
        }),
      ),
      initial: (value) => {
        // 尝试解码存储值，解码失败则跳过渲染
        const decoded = decodeValue(value)
        return decoded === undefined ? undefined : initial(decoded)
      },
      changed: (previous, current) => {
        // 解码前值
        const before = decodeValue(previous)
        // 解码当前值
        const after = decodeValue(current)
        // 当前值无法解码则不渲染
        if (after === undefined) return undefined
        // 之前没有有效值时按首次出现渲染
        if (before === undefined) return initial(after)
        // 渲染变化文本，并确保非空
        const text = source.render.changed(before, after)
        return text === undefined ? undefined : requireText(source.key, "changed", text)
      },
      removed: (previous) => {
        // 解码被移除前的值；无渲染函数或解码失败则跳过
        const decoded = decodeValue(previous)
        return decoded === undefined || source.render.removed === undefined
          ? undefined
          : requireText(source.key, "removed", source.render.removed(decoded))
      },
    },
  ]
}

// 组合多个来源列表：展平并检查键唯一性
export function combine(values: ReadonlyArray<List>): List {
  // 展平为一维来源数组
  const sources = values.flat()
  // 已见键集合
  const keys = new Set<Key>()
  // 逐个检查重复键
  for (const source of sources) {
    if (keys.has(source.key)) throw new DuplicateKeyError({ key: source.key })
    keys.add(source.key)
  }
  return sources
}

// 并发读取所有来源的当前值
export function read(value: List): Effect.Effect<ReadResult> {
  return Effect.forEach(
    value,
    (source) => source.read.pipe(Effect.map((observed) => ({ key: source.key, value: observed }))),
    // 并发数不受限
    { concurrency: "unbounded" },
  )
}

// 对比观察值与上次的哈希表，产出增量（delta）与内容块（blobs）
export function diff(observed: ReadResult, previous?: Values): Effect.Effect<Admission, InitializationBlocked> {
  // 首次（无 previous）读取时，任何不可用来源都会阻塞初始化
  const blocked = previous ? [] : observed.flatMap((entry) => (isUnavailable(entry.value) ? [entry.key] : []))
  if (blocked.length > 0) return Effect.fail(new InitializationBlocked({ keys: blocked }))
  // 增量表：键 -> 新哈希或移除标记
  const delta: Record<string, Hash | Instruction.Removed> = {}
  // 内容块表：哈希 -> JSON 值
  const blobs: Record<string, Schema.Json> = {}
  // 逐个来源比对
  for (const entry of observed) {
    // 临时不可用：跳过，不产生增量
    if (isUnavailable(entry.value)) continue
    if (isRemoved(entry.value)) {
      // 已移除：仅当之前确实存在该键时记录移除
      if (previous && Object.hasOwn(previous, entry.key)) delta[entry.key] = Instruction.removed
      continue
    }
    // 计算当前值的哈希
    const next = hash(entry.value)
    // 哈希未变化则无需记录
    if (previous?.[entry.key] === next) continue
    delta[entry.key] = next
    blobs[next] = entry.value
  }
  return Effect.succeed({ delta, blobs })
}

/** One source's rendered text, keyed so consumers can tell the sources apart. */
// 单个来源渲染出的文本，附带键以便消费方区分
export interface Rendered {
  readonly key: Key
  readonly text: string
}

// 初始渲染：为每个有存储值的来源生成首次文本
export function renderInitial(value: List, values: Readonly<Record<string, Schema.Json>>): ReadonlyArray<Rendered> {
  return value.flatMap((source) => {
    // 没有存储值的来源跳过
    if (!Object.hasOwn(values, source.key)) return []
    // 渲染首次文本
    const text = source.initial(values[source.key])
    return text === undefined ? [] : [{ key: source.key, text }]
  })
}

/** The text models see for rendered sources. */
// 将所有渲染文本拼接为模型最终看到的字符串
export function join(rendered: ReadonlyArray<Rendered>) {
  return render(rendered.map((part) => part.text))
}

// 增量更新渲染：根据 delta 与前值生成新增/变化/移除的文本
export function renderUpdate(
  value: List,
  previous: Readonly<Record<string, Schema.Json>>,
  delta: Readonly<Record<string, Option.Option<Schema.Json>>>,
) {
  return render(
    value.flatMap((source) => {
      // 该来源不在增量中则跳过
      if (!Object.hasOwn(delta, source.key)) return []
      // 取该键的增量项（None 表示移除）
      const current = delta[source.key]
      if (Option.isNone(current)) {
        // 移除：之前不存在该键则无需渲染
        if (!Object.hasOwn(previous, source.key)) return []
        const text = source.removed(previous[source.key])
        return text === undefined ? [] : [text]
      }
      // 取新的 JSON 值
      const next = current.value
      // 之前有值按“变化”渲染，否则按“首次出现”渲染
      const text = Object.hasOwn(previous, source.key)
        ? source.changed(previous[source.key], next)
        : source.initial(next)
      return text === undefined ? [] : [text]
    }),
  )
}

// 计算 JSON 值的 SHA-256 哈希（基于规范化序列化）
export function hash(value: Schema.Json) {
  return Hash.make(createHash("sha256").update(canonicalJson(value)).digest("hex"))
}

// 把哈希增量应用到已有哈希表，得到新的哈希表
export function applyHashDelta(values: Values, delta: Delta): Values {
  // 复制原表
  const result: Record<string, Hash> = { ...values }
  // 逐项应用增量
  for (const [key, value] of Object.entries(delta)) {
    if (value === Instruction.removed) delete result[key]
    else result[key] = value
  }
  return result
}

// 按键比较两个列表：得出新增、移除与变化三类差异
export function diffByKey<A>(
  previous: ReadonlyArray<A>,
  current: ReadonlyArray<A>,
  key: (value: A) => string,
  changed: (previous: A, current: A) => boolean,
): {
  readonly added: ReadonlyArray<A>
  readonly removed: ReadonlyArray<A>
  readonly changed: ReadonlyArray<{ readonly previous: A; readonly current: A }>
} {
  // 当前列表的键集合
  const currentKeys = new Set(current.map(key))
  // 之前列表按键索引
  const previousByKey = new Map(previous.map((value) => [key(value), value] as const))
  return {
    // 新增：当前有而之前没有
    added: current.filter((value) => !previousByKey.has(key(value))),
    // 移除：之前有而当前没有
    removed: previous.filter((value) => !currentKeys.has(key(value))),
    // 变化：两边都有且 changed 判定不同
    changed: current.flatMap((value) => {
      const before = previousByKey.get(key(value))
      return before === undefined || !changed(before, value) ? [] : [{ previous: before, current: value }]
    }),
  }
}

/**
 * Renders a keyed list update: added, changed, and removed entries as deltas,
 * or the full list restated when no entry differs.
 */
// 渲染键控列表的更新：有差异时按新增/变化/移除输出增量，无差异时重述完整列表
export function listUpdate<A>(input: {
  readonly key: (value: A) => string
  readonly changed: (previous: A, current: A) => boolean
  readonly entries: (values: ReadonlyArray<A>) => ReadonlyArray<string>
  readonly render: (values: ReadonlyArray<A>) => string
  readonly text: {
    readonly replaced: string
    readonly added: string
    readonly changed: string
    readonly removed: (keys: string) => string
  }
}) {
  return (previous: ReadonlyArray<A>, current: ReadonlyArray<A>) => {
    // 先按键求差异
    const diff = diffByKey(previous, current, input.key, input.changed)
    if (diff.added.length === 0 && diff.changed.length === 0 && diff.removed.length === 0)
      return [input.text.replaced, input.render(current)].join("\n")
    return [
      ...(diff.added.length === 0 ? [] : [input.text.added, ...input.entries(diff.added)]),
      ...(diff.changed.length === 0
        ? []
        : [input.text.changed, ...input.entries(diff.changed.map((change) => change.current))]),
      ...(diff.removed.length === 0 ? [] : [input.text.removed(diff.removed.map(input.key).join(", "))]),
    ].join("\n")
  }
}

// 内部拼接函数：用空行分隔多个文本片段
function render(parts: ReadonlyArray<string>) {
  return parts.join("\n\n")
}

// Reference-equality guards: `A` in a typed source may itself be JSON shaped
// like these singletons, so identity, never structure, discriminates.
// 引用相等守卫：类型化来源的值可能在结构上长得像这些单例，因此只能用同一性判别
function isUnavailable(value: unknown): value is Unavailable {
  return value === unavailable
}

// 同上：判断是否为“已移除”单例
function isRemoved(value: unknown): value is Removed {
  return value === removed
}

function requireText(key: Key, kind: string, text: string) {
  if (text.length === 0) throw new Error(`Instruction source ${key} rendered an empty ${kind}`)
  return text
}
