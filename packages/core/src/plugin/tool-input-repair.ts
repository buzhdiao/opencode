// 将本模块以命名空间 `ToolInputRepairPlugin` 全量导出
export * as ToolInputRepairPlugin from "./tool-input-repair.js"

// 引入工具失败错误类型（ToolFailure），用于包装执行出错信息
import { ToolFailure } from "@opencode/ai/effect"
// 引入插件定义工具 define
import { define } from "@opencode/plugin/effect/plugin"
// 引入 Effect 原语、JsonSchema（JSON Schema 模型）、Option、Predicate（谓词工具）与 Schema（校验/编解码）
import { Effect, JsonSchema, Option, Predicate, Schema } from "effect"
// 引入工具运行时的定义读取与内容规范化函数
import { definition, normalizeContent } from "../tool/runtime.js"

// Repairs apply only when the input schema unambiguously supports them:
// - Stringified root or nested object: '{"limit":"20"}' -> { limit: 20 }
// - Closed object: { limit: "20", extra: true } -> { limit: 20 }
// - Optional null or empty-object placeholder: { limit: null } -> {}
// - Numeric or boolean string: { limit: "20", enabled: "false" } -> { limit: 20, enabled: false }
// - Nullable field: { count: "2" } -> { count: 2 }
// - Stringified array or compatible item: { tags: '["a"]', count: "2" } -> { tags: ["a"], count: [2] }
// - Positional tuple: { pair: ["2", "false"] } -> { pair: [2, false] }
// - Typed dictionary: { counts: { first: "2" } } -> { counts: { first: 2 } }
// - Nested fields and local references: { items: [{ count: "2" }] } -> { items: [{ count: 2 }] }
// 修复仅在输入 schema 明确支持时才进行：字符串化的对象/数组、闭式对象的剔除、null/空对象占位、数字与布尔字符串、可空字段、按位置的元组、类型化字典、嵌套字段与本地引用等情形

// 构造"从字符串解析 JSON"的宽松解码器：输入未知值，解析失败返回 None
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
// 递归修复的最大深度，防止循环引用导致无限递归
const maxDepth = 6

// Tool names models carry over from other harnesses, used only when no tool has that name.
// The result tells the model which tool ran, so it calls that one next time.
// 模型从其他 harness 带来的工具别名：仅在不存在同名工具时使用；执行后会告知模型实际运行的工具，使其下次直接调用该工具
const aliases = new Map([["bash", "shell"]])

// 定义工具输入修复插件：在工具执行前后挂钩，把模型生成的"近乎正确"的输入修整为 schema 兼容的形态
export const Plugin = define({
  // 插件唯一标识
  id: "opencode.tool.input.repair",
  // 插件副作用：注册执行前/执行后两个钩子
  effect: (ctx) =>
    Effect.gen(function* () {
      // 别名映射记录：调用 ID -> 模型原本请求的工具名
      const aliased = new Map<string, string>()
      // 注册 execute.before 钩子：在工具真正执行前修复输入
      yield* ctx.tool.hook("execute.before", (event) =>
        Effect.gen(function* () {
          // The outer Code Mode tool is built per snapshot rather than registered, so it cannot be
          // looked up here. Its `{ code }` input is trivial; the tools it calls are repaired normally.
          // 外层 Code Mode 工具按快照构建而非注册，这里查不到它；其 { code } 输入很平凡，它调用的工具会被正常修复
          if (event.tool === "execute") return
          // 列出当前可用的全部工具
          const tools = yield* ctx.tool.list()
          // 查询该工具名是否命中别名表
          const alias = aliases.get(event.tool)
          // 查找目标工具：先按原工具名找，找不到再按别名找
          const tool =
            tools.find((tool) => tool.id === event.tool) ??
            (alias === undefined ? undefined : tools.find((tool) => tool.id === alias))
          // 找不到任何工具则不做处理
          if (!tool) return
          // 若实际执行的工具与模型请求的不同（别名命中）：记录映射并改写事件中的工具名
          if (tool.id !== event.tool) {
            aliased.set(event.id, event.tool)
            event.tool = tool.id
          }
          // 读取工具的输入 JSON Schema
          const schema = definition(tool).inputSchema
          // 仅处理对象型输入 schema
          if (schema.type !== "object") return
          // 递归修复输入（根 schema 同时作为引用解析根）
          event.input = repair(event.input, schema, schema, 0)
        }),
      )
      // 注册 execute.after 钩子：在执行结束后为别名命中的调用补充提示信息
      yield* ctx.tool.hook("execute.after", (event) =>
        Effect.sync(() => {
          // 查询该调用是否来自别名
          const called = aliased.get(event.id)
          // 非别名调用则直接返回
          if (called === undefined) return
          // 用完即删，避免内存泄漏
          aliased.delete(event.id)
          // 提示文案：告知模型该工具不存在别名，下次应直接调用实际工具
          const note = `There is no "${called}" tool, so this ran as "${event.tool}". Call "${event.tool}" directly.`
          // 若执行出错：把提示附加到错误信息之后，包装为 ToolFailure
          if (event.status === "error") {
            event.error = new ToolFailure({
              message: `${event.error.message}\n\n${note}`,
              error: event.error.error,
              metadata: event.error.metadata,
            })
            return
          }
          // 成功时：在结果内容尾部追加提示文本
          event.result = {
            ...event.result,
            content: [...normalizeContent(event.result.content, event.result.output), { type: "text", text: note }],
          }
        }),
      )
    }),
})

// 核心修复函数：按 schema 类型递归整形输入值；无法确定修复方式时原样返回
function repair(value: unknown, schema: JsonSchema.JsonSchema, root: JsonSchema.JsonSchema, depth: number): unknown {
  // 超过最大深度则放弃修复，直接返回原值
  if (depth > maxDepth) return value

  // 处理 $ref 引用：解析本地定义后继续修复
  if (typeof schema.$ref === "string") {
    // 根据引用路径格式选取定义容器：#/ $defs/... 或 #/definitions/...
    const definitions = /^#\/\$defs\/[^/]+$/.test(schema.$ref)
      ? root.$defs
      : /^#\/definitions\/[^/]+$/.test(schema.$ref)
        ? root.definitions
        : undefined
    // 定义容器不是对象则无法解析，原样返回
    if (!Predicate.isObject(definitions)) return value
    // 过滤出对象型定义，再按 JSON Pointer 取出目标定义（处理 ~1 -> / 与 ~0 -> ~ 转义）
    const target = Object.fromEntries(
      Object.entries(definitions).filter((entry): entry is [string, JsonSchema.JsonSchema] =>
        Predicate.isObject(entry[1]),
      ),
    )[
      schema.$ref
        .slice(schema.$ref.lastIndexOf("/") + 1)
        .replaceAll("~1", "/")
        .replaceAll("~0", "~")
    ]
    // 找到目标定义则继续修复（深度+1），否则原样返回
    return target ? repair(value, target, root, depth + 1) : value
  }

  // 处理类型数组（如 ["string","null"]）
  if (Array.isArray(schema.type)) {
    // 值为 null 且 schema 允许 null：原样返回
    if (value === null && schema.type.includes("null")) return value
    // 值的类型已在允许列表中：原样返回
    if (schema.type.includes(typeof value)) return value
    // 排除 null 后的候选类型
    const types = schema.type.filter((type) => type !== "null")
    // 只剩一种类型时收窄后继续修复，否则放弃
    return types.length === 1 ? repair(value, { ...schema, type: types[0] }, root, depth + 1) : value
  }

  // 处理未声明 type 但有 anyOf/oneOf 的 schema
  if (schema.type === undefined) {
    // 同时存在 anyOf 与 oneOf 时语义不明确，放弃修复
    if (Array.isArray(schema.anyOf) && Array.isArray(schema.oneOf)) return value
    // 优先取 anyOf，其次 oneOf 作为候选分支
    const branches = Array.isArray(schema.anyOf) ? schema.anyOf : schema.oneOf
    // 无有效分支或值为 null：放弃修复
    if (!Array.isArray(branches) || value === null) return value
    // 任一分支非对象或与值类型一致：说明当前形态合法，原样返回
    if (branches.some((branch) => !Predicate.isObject(branch) || branch.type === typeof value)) return value
    // 过滤掉 null 分支
    const candidates = branches.filter((branch) => Predicate.isObject(branch) && branch.type !== "null")
    // 仅剩一个候选分支时收窄继续修复，否则放弃
    return candidates.length === 1 ? repair(value, candidates[0], root, depth + 1) : value
  }

  // 处理数字类型：字符串形式的数字转为数字
  if (schema.type === "number" || schema.type === "integer") {
    // 非字符串或空白字符串：原样返回
    if (typeof value !== "string" || value.trim() === "") return value
    // 尝试把字符串转为数字
    const parsed = Number(value)
    // 数字有效，且 integer 类型还要求是安全整数时才采用转换结果
    return Number.isFinite(parsed) && (schema.type !== "integer" || Number.isSafeInteger(parsed)) ? parsed : value
  }
  // 处理布尔类型："true"/"false" 字符串转为布尔值
  if (schema.type === "boolean") return value === "true" ? true : value === "false" ? false : value
  // 对象类型交给 repairObject 处理
  if (schema.type === "object") return repairObject(value, schema, root, depth)
  // 数组类型交给 repairArray 处理
  if (schema.type === "array") return repairArray(value, schema, root, depth)
  // 其余类型（如 string）不做修复
  return value
}

// 对象修复：解析字符串化对象、剔除多余/占位字段、逐属性递归修复
function repairObject(
  value: unknown,
  schema: JsonSchema.JsonSchema,
  root: JsonSchema.JsonSchema,
  depth: number,
): unknown {
  // 字符串值先尝试解析为 JSON 对象
  const parsed = typeof value === "string" ? Option.getOrUndefined(decodeJson(value)) : value
  // 解析失败或不是对象：原样返回
  if (!Predicate.isObject(parsed)) return value

  // 取声明的属性表（缺省为空对象）
  const properties = Predicate.isObject(schema.properties) ? schema.properties : {}
  // 取必填字段列表（缺省为空数组）
  const required = Array.isArray(schema.required) ? schema.required : []
  // 是否声明了 patternProperties（模式属性）
  const patterned = Predicate.isObject(schema.patternProperties)
  // 是否使用了 allOf/anyOf/oneOf 组合
  const composed = Array.isArray(schema.allOf) || Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)

  // 用 reduce 逐键构建修复后的对象
  return Object.keys(parsed).reduce<Record<string, unknown>>((result, key) => {
    // 当前键的值
    const current = result[key]
    // 该键是否被 properties 声明
    const declared = Object.hasOwn(properties, key)
    // 属性 schema：优先声明属性；未声明且无模式属性时退回 additionalProperties；否则无
    const property = declared ? properties[key] : !patterned ? schema.additionalProperties : undefined

    // 封闭对象（additionalProperties: false）且无模式属性/组合：剔除未声明的多余键
    if (!declared && schema.additionalProperties === false && !patterned && !composed) {
      // 复制结果并删除该键
      const next = { ...result }
      delete next[key]
      // 返回删除后的对象
      return next
    }
    // 拿不到属性 schema（如 additionalProperties 也未定义）：不做修复
    if (!Predicate.isObject(property)) return result

    // Only a bare single-type property provably rejects null and `{}`. Compositions, enums,
    // constants, references and nullable flags may accept them, so those are left alone.
    // 只有"裸的单类型属性"可证明拒绝 null 与空对象；组合、枚举、常量、引用与可空标记可能接受它们，因此保持不动
    const plain =
      typeof property.type === "string" &&
      property.type !== "null" &&
      !composed &&
      ["anyOf", "oneOf", "allOf", "enum", "const", "$ref", "nullable"].every((keyword) => !(keyword in property))
    // 判定当前值是否为"占位"：空对象且属性类型不是 object
    const placeholder = Predicate.isObject(current) && Object.keys(current).length === 0 && property.type !== "object"
    // 已声明、非必填、且为裸单类型属性，而值是 null 或空对象占位：直接删除该字段
    if (declared && !required.includes(key) && plain && (current === null || placeholder)) {
      // 复制结果并删除该键
      const next = { ...result }
      delete next[key]
      // 返回删除后的对象
      return next
    }

    // 按属性 schema 递归修复该值
    const repaired = repair(current, property, root, depth + 1)
    // 未发生变化则复用原对象；有变化则写入修复后的值
    return repaired === current ? result : { ...result, [key]: repaired }
  }, parsed)
}

// 数组修复：解析字符串化数组、按元组/元素 schema 逐项修复、把兼容单值包装为数组
function repairArray(
  value: unknown,
  schema: JsonSchema.JsonSchema,
  root: JsonSchema.JsonSchema,
  depth: number,
): unknown {
  // 字符串值先尝试解析为 JSON
  const parsed = typeof value === "string" ? Option.getOrUndefined(decodeJson(value)) : value
  // 元组定义：优先 prefixItems；否则 items 为数组时视为元组
  const tuple = Array.isArray(schema.prefixItems)
    ? schema.prefixItems
    : Array.isArray(schema.items)
      ? schema.items
      : undefined

  // 值本身是数组：逐项修复
  if (Array.isArray(parsed)) {
    // 对每个元素按对应位置的成员 schema 修复
    const repaired = parsed.map((item, index) => {
      // 取该位置的成员 schema：元组项越界时回退到 items/additionalItems；非元组则用 items
      const member = tuple
        ? (tuple[index] ?? (Array.isArray(schema.prefixItems) ? schema.items : schema.additionalItems))
        : schema.items
      // 成员 schema 有效则递归修复，否则原样保留
      return Predicate.isObject(member) ? repair(item, member, root, depth + 1) : item
    })
    // 若所有元素都没变则返回原数组引用，避免无谓替换
    return repaired.every((item, index) => item === parsed[index]) ? parsed : repaired
  }

  // 非数组值：仅当存在元组定义，或 items 不是对象 schema 时放弃修复
  if (tuple || !Predicate.isObject(schema.items)) return value
  // 按元素 schema 递归修复该单值
  const repaired = repair(value, schema.items, root, depth + 1)
  // 读取元素类型
  const type = schema.items.type
  // 判断修复后的值与元素类型是否兼容（object/array/integer/number/string|boolean 分别校验）
  const compatible =
    type === "object"
      ? Predicate.isObject(repaired)
      : type === "array"
        ? Array.isArray(repaired)
        : type === "integer"
          ? typeof repaired === "number" && Number.isSafeInteger(repaired)
          : type === "number"
            ? typeof repaired === "number" && Number.isFinite(repaired)
            : (type === "string" || type === "boolean") && typeof repaired === type
  // 兼容时把单值包装为单元素数组返回，否则原样返回
  return compatible ? [repaired] : value
}
