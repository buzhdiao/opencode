// 工具定义构造与 JSON Schema 输出、输入校验等运行时工具集
import { emptyInputJsonSchema, ToolFailure, type ToolDefinition } from "@opencode/ai/effect"
// 判断是否为普通对象（record）的工具函数
import { isRecord } from "@opencode/util/record"
// 工具相关的共享 Schema 与类型（Info/Context/Error/Content）
import { Tool } from "@opencode/schema/tool"
// 标准化 Schema 规范（Standard Schema）与 JSON Schema 接口类型
import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec"
// effect 库：Effect 编排、JsonPointer 指针解析、JsonSchema、Result、Schema、错误与表示工具
import { Effect, JsonPointer, JsonSchema, Result, Schema, SchemaIssue, SchemaRepresentation } from "effect"
// zod v4 核心类型与 JSON Schema 转换
import { $ZodType, toJSONSchema } from "zod/v4/core"

// 创建把 effect 校验问题（issue）格式化为标准 Schema 问题列表的格式化器
const formatEffectIssues = SchemaIssue.makeFormatterStandardSchemaV1()

// Codecs for raw JSON Schema inputs (mostly MCP tools), built once per schema object; schemas are not edited after
// registration. Not an Effect `Cache`: each entry keeps its lookup fiber, which keeps the caller's stack frames and
// through them the `Effect.fn` closures over its Location's services, so evicted Locations stayed alive.
// 针对"原始 JSON Schema 输入"（主要是 MCP 工具）的编解码器缓存：
// 按 schema 对象弱引用缓存，注册后不再变更；用 WeakMap 而非 Effect Cache，
// 避免 fiber 持有调用栈导致已驱逐的 Location 服务无法被回收
const jsonSchemas = new WeakMap<object, Schema.Codec<unknown> | undefined>()

// 取得（或构建并缓存）某个 JSON Schema 对应的 effect 编解码器
const codecFor = (schema: JsonSchema.JsonSchema) => {
  // 已有缓存则直接返回
  if (jsonSchemas.has(schema)) return jsonSchemas.get(schema)
  // 尝试把 JSON Schema 转成 effect 编解码器，失败则取 undefined
  const codec = Result.try(() => jsonSchema(schema)).pipe(Result.getOrUndefined)
  // 写入缓存（含失败结果，避免重复尝试）
  jsonSchemas.set(schema, codec)
  // 返回编解码器
  return codec
}

// 把工具信息转换为标准工具定义（名称/描述/输入输出 JSON Schema）
export const definition = (tool: Tool.Info<any, any>): ToolDefinition => ({
  // 定义类型：tool
  type: "tool",
  // 工具的有效名称（含命名空间前缀）
  name: effectiveName(tool),
  // 工具描述
  description: tool.description,
  // 输入参数的 JSON Schema
  inputSchema: inputJsonSchema(tool.input),
  ...(tool.freeform && { freeform: tool.freeform }),
  ...(tool.output === undefined ? {} : { outputSchema: outputJsonSchema(tool.output) }),
})

// 工具执行入口：解码入参、执行、校验并编码出参
export const execute = (tool: Tool.Info<any, any>, input: unknown, context: Tool.Context) =>
  Effect.gen(function* () {
    // 解码并校验入参
    const decoded = yield* decodeInput(tool, input)
    // Tool implementations declare `Tool.Error` but plugins can fail with anything at
    // runtime. A foreign typed failure would slip past every `catchTag("Tool.Error")`
    // downstream and leave its call permanently unsettled, so the declared contract is
    // enforced here at the untrusted boundary. Declines tunnel through as defects and
    // interrupts are not errors; neither is touched.
    // 工具声明只会抛 Tool.Error，但插件运行时可能抛任意错误；
    // 在这个不受信任的边界统一包装，避免未知错误绕过下游 catchTag
    const result = yield* tool.execute(decoded, context).pipe(
      // 把非 Tool.Error 的失败包装成标准 Tool.Error
      Effect.mapError((error: unknown) =>
        // 已是 Tool.Error 则原样保留（? 分支直接透传）
        // 其它错误：取 message（Error 对象）或字符串化后包装
        error instanceof Tool.Error
          ? error
          : new Tool.Error({
              message: error instanceof globalThis.Error ? error.message : String(error),
            }),
      ),
    )
    // 工具未声明输出 Schema 时
    if (tool.output === undefined) {
      // 却返回了 output 字段则属内部错误
      if ("output" in result) return yield* Effect.die("Tool result declared output without an output schema")
      // 返回无 output 的标准响应
      return {
        // 输出为空
        output: undefined,
        // 规范化正文内容
        content: normalizeContent(result.content),
        // 有元数据时附带
        ...(result.metadata === undefined ? {} : { metadata: result.metadata }),
      }
    }
    // 声明了输出却没返回 output 字段则报工具错误
    if (!("output" in result)) return yield* new Tool.Error({ message: "Tool did not return its declared output" })
    // 按输出 Schema 校验并编码输出值
    const output = yield* encodeOutput(tool.output, result.output)
    // 返回标准响应
    return {
      // 编码后的输出
      output,
      // 规范化正文（可引用输出值）
      content: normalizeContent(result.content, output),
      // 有元数据时附带
      ...(result.metadata === undefined ? {} : { metadata: result.metadata }),
    }
  })

// 解码并校验工具入参；校验失败时报出格式化的问题清单
const decodeInput = (tool: Tool.Info<any, any>, value: unknown) =>
  Effect.gen(function* () {
    // 执行入参校验
    const result = yield* validateInput(tool.input, value)
    // 存在校验问题时抛出工具错误
    if (result.issues)
      return yield* new Tool.Error({ message: formatInputIssues(effectiveName(tool), result.issues, value) })
    // 返回校验通过的值
    return result.value
  })

// 按工具声明的参数 Schema 类型选择校验路径
const validateInput = (
  // 工具的参数 Schema（effect Schema / 标准 Schema / 原始 JSON Schema）
  schema: Tool.ValueSchema<any>,
  // 原始入参值
  value: unknown,
): Effect.Effect<StandardSchemaV1.Result<unknown>> => {
  // 标准 Schema 走标准化校验
  if (isStandardSchema(schema)) return validateStandard(schema, value)
  // 其余走 effect 校验流程
  return Effect.gen(function* () {
    // effect Schema 直接用；原始 JSON Schema 则查缓存的编解码器
    const codec = Schema.isSchema(schema) ? schema : codecFor(schema)
    // 拿不到编解码器（转换失败）时不校验，原样透传
    if (codec === undefined) return { value }
    // 用 effect 解码校验未知值，收集全部错误
    return yield* Schema.decodeUnknownEffect(codec)(value, { errors: "all" }).pipe(
      // 分别处理成功与失败
      Effect.match({
        // 失败：把 effect 问题格式化为标准问题列表
        onFailure: (error) => formatEffectIssues(error.issue),
        // 成功：返回校验后的值
        onSuccess: (value) => ({ value }),
      }),
    )
  })
}

// 把入参校验问题格式化为面向模型的可读错误信息
const formatInputIssues = (tool: string, issues: ReadonlyArray<StandardSchemaV1.Issue>, value: unknown) => {
  // 最多展示前 5 条问题的详情
  const details = issues.slice(0, 5).map((issue) => {
    // 把问题路径拼成 a.b[0] 形式
    const path =
      issue.path?.reduce<string>((path, segment) => {
        // 取路径段的关键字（对象形式取其 key）
        const key = typeof segment === "object" ? segment.key : segment
        // 数字键用方括号表示
        if (typeof key === "number") return `${path}[${key}]`
        // 首段直接写，后续用点号连接
        return path === "" ? String(key) : `${path}.${String(key)}`
      }, "") || "root"
    // 单条问题行：路径 + 消息
    return `- ${path}: ${issue.message}`
  })
  // 超过 5 条时追加省略提示
  if (issues.length > 5) details.push(`- ...and ${issues.length - 5} more ${issues.length === 6 ? "issue" : "issues"}`)
  // 组装完整错误信息：问题列表 + 原始入参 + 修正提示
  return `Invalid arguments for tool "${tool}":\n${details.join("\n")}\n\nArguments provided:\n${JSON.stringify(value, null, 2)}\n\nUpdate the arguments and call the tool again.`
}

// 把原始 JSON Schema 对象转换为 effect 编解码器
const jsonSchema = (schema: JsonSchema.JsonSchema) => {
  // 按 $schema 声明或是否含 definitions 选择草稿版本：
  // 含 draft-07 标记或 definitions 时按 draft-07 解析，否则按 2020-12 草稿解析
  const draft =
    (typeof schema.$schema === "string" && schema.$schema.includes("draft-07")) || "definitions" in schema
      ? JsonSchema.fromSchemaDraft07(schema)
      : JsonSchema.fromSchemaDraft2020_12(schema)
  // 由 JSON Schema 文档构造 effect Schema（编解码器）
  return Schema.make<Schema.Codec<unknown>>(SchemaRepresentation.fromJsonSchemaDocument(draft).ast)
}

// 按输出 Schema 校验/编码工具输出值
const encodeOutput = (schema: Tool.ValueSchema<any>, value: unknown) => {
  // effect Schema：走 encode 编码
  if (Schema.isSchema(schema))
    return Schema.encodeEffect(schema)(value).pipe(
      // 编码失败时报输出校验错误
      Effect.mapError(
        (error) =>
          new Tool.Error({ message: `Tool returned an invalid value for its output schema: ${error.message}` }),
      ),
    )
  // 标准 Schema：走标准化校验
  if (isStandardSchema(schema))
    return validateStandard(schema, value).pipe(
      // 校验失败（有问题）时报输出校验错误，否则校验通过返回原值
      Effect.flatMap((result) =>
        result.issues
          ? new Tool.Error({
              message: `Tool returned an invalid value for its output schema: ${result.issues.map((issue) => issue.message).join(", ")}`,
            })
          : Effect.succeed(result.value),
      ),
    )
  // 原始 JSON Schema：至少保证输出是合法 JSON
  return Schema.decodeUnknownEffect(Schema.Json)(value).pipe(
    // 非 JSON 值时报错
    Effect.mapError(
      (error) => new Tool.Error({ message: `Tool returned a non-JSON value for its output schema: ${error.message}` }),
    ),
  )
}

// 判断是否为标准 Schema（带 ~standard 属性）
const isStandardSchema = (schema: Tool.ValueSchema<any>): schema is StandardSchemaV1<any, any> =>
  // 对象且含 "~standard" 键
  typeof schema === "object" && schema !== null && "~standard" in schema

// 判断标准 Schema 是否附带 JSON Schema 转换能力
const isStandardJSONSchema = (
  schema: StandardSchemaV1<any, any>,
): schema is StandardSchemaV1<any, any> & StandardJSONSchemaV1<any, any> => "jsonSchema" in schema["~standard"]

// 运行标准 Schema 校验：兼容同步与 Promise 结果
const validateStandard = (
  // 标准 Schema
  schema: StandardSchemaV1<any, any>,
  // 待校验值
  value: unknown,
): Effect.Effect<StandardSchemaV1.Result<unknown>> =>
  Effect.gen(function* () {
    // 同步执行校验（可能抛异常）
    const result = yield* Effect.try({ try: () => schema["~standard"].validate(value), catch: (error) => error })
    // 返回 Promise 时转成 effect 等待
    return result instanceof Promise ? yield* Effect.tryPromise({ try: () => result, catch: (error) => error }) : result
  }).pipe(
    // 统一处理成功/失败
    Effect.match({
      // 失败：包装成单条问题
      onFailure: (error) => ({ issues: [{ message: error instanceof Error ? error.message : String(error) }] }),
      // 成功：原样返回结果
      onSuccess: (result) => result,
    }),
  )

// 推导工具入参的 JSON Schema（用于向模型描述工具）
const inputJsonSchema = (schema: Tool.ValueSchema<any>): JsonSchema.JsonSchema => {
  // 无参工具返回空 Schema
  if (schema === undefined || schema === null) return {}
  // 标准 Schema：从其 jsonSchema 能力导出
  if (isStandardSchema(schema)) return standardJsonSchema(schema, "input")
  // 原始 JSON Schema：直接透传
  if (!Schema.isSchema(schema)) return schema
  // effect Schema：无参时用空参 Schema，否则转 JSON Schema
  return emptyInputJsonSchema(schema) ?? toJsonSchema(schema)
}

// 推导工具出参的 JSON Schema
const outputJsonSchema = (schema: Tool.ValueSchema<any>): JsonSchema.JsonSchema => {
  // 标准 Schema：导出 output 侧
  if (isStandardSchema(schema)) return standardJsonSchema(schema, "output")
  // effect Schema 转 JSON Schema；原始 JSON Schema 透传
  return Schema.isSchema(schema) ? toJsonSchema(schema) : schema
}

// 从标准 Schema 导出指定方向（input/output）的 JSON Schema
const standardJsonSchema = (schema: StandardSchemaV1<any, any>, io: "input" | "output"): JsonSchema.JsonSchema => {
  // 自带 jsonSchema 能力时直接调用
  if (isStandardJSONSchema(schema)) return schema["~standard"].jsonSchema[io]({ target: "draft-2020-12" })
  // zod 类型：用 zod 的转换器
  if (schema instanceof $ZodType) return toJSONSchema(schema, { target: "draft-2020-12", io })
  // 其它厂商不支持转换时报错
  throw new Error(`Schema vendor "${schema["~standard"].vendor}" does not support JSON Schema conversion`)
}

// 把 effect Schema 转成对推理提供商更友好的 JSON Schema
const toJsonSchema = (schema: Schema.Top): JsonSchema.JsonSchema => {
  // 生成 JSON Schema 文档（多余属性按错误处理）
  const document = Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" })
  // Effect emits valid JSON Schema that some inference providers handle poorly. Simplify it
  // without changing validation: `{ type: "integer", allOf: [{ minimum: 0 }] }` becomes
  // `{ type: "integer", minimum: 0 }` only when no keyword would be overwritten. Named schemas
  // emit `$ref` plus root `$defs`; inline acyclic local references so providers receive the full
  // nested schema directly, then remove unused `$defs`. Recursive references stay intact because
  // expanding them would never terminate.
  // 简化输出但不改变校验语义：展平 allOf；内联本地 $ref；清理未用的 $defs；
  // 递归引用保持原样（展开不会终止）
  const normalized = flattenAllOf(
    // 无命名定义时直接用根 Schema，否则带上 $defs
    Object.keys(document.definitions).length === 0
      ? document.schema
      : { ...document.schema, $defs: document.definitions },
  )
  // 内联本地引用后按需移除 $defs
  return dropDefinitionsIfResolved(inlineLocalReferences(normalized)) as JsonSchema.JsonSchema
}

// 递归展平 JSON Schema 中的 allOf 组合（并把内层也做同样处理）
const flattenAllOf = (value: unknown): unknown => {
  // 数组：逐元素递归处理
  if (Array.isArray(value)) return value.map(flattenAllOf)
  // 非对象（或 null）原样返回
  if (typeof value !== "object" || value === null) return value

  // Effect adds the safe-integer range to every Schema.Int. Drop it so tool schemas don't change and
  // bust prompt caches.
  // 判断是否为 integer 类型节点
  const integer = "type" in value && value.type === "integer"
  // 重建对象：integer 时剔除 effect 自动加的安全整数范围边界，再递归处理每个值
  const schema = Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key, item]) =>
          // 非 integer 类型保留全部键；integer 类型剔除默认的 MIN/MAX_SAFE_INTEGER 边界
          !integer ||
          !(
            (key === "minimum" && item === Number.MIN_SAFE_INTEGER) ||
            (key === "maximum" && item === Number.MAX_SAFE_INTEGER)
          ),
      )
      // 递归处理每个属性值
      .map(([key, item]) => [key, flattenAllOf(item)]),
  )
  // allOf 不存在、元素非对象或不可安全合并时，保持现状返回
  if (!Array.isArray(schema.allOf) || !schema.allOf.every(isRecord) || !canFlattenAllOf(schema.allOf, schema))
    return schema
  // 拆出 allOf 与其余键
  const { allOf, ...rest } = schema
  // 把 allOf 各项合并后再叠上其余键，并继续递归展平
  return flattenAllOf({ ...Object.assign({}, ...allOf), ...rest })
}

// 判断 allOf 数组能否与父对象无冲突合并（各键不重复）
const canFlattenAllOf = (allOf: ReadonlyArray<Record<string, unknown>>, parent: Record<string, unknown>) => {
  // 父对象自身的键集合（排除 allOf）
  const keys = new Set(Object.keys(parent).filter((key) => key !== "allOf"))
  // 每个分支的每个键都必须是新的，才允许展平
  return allOf.every((item) =>
    Object.keys(item).every((key) => {
      // 键已存在则不能合并
      if (keys.has(key)) return false
      // 记录新键
      keys.add(key)
      // 该键可用
      return true
    }),
  )
}

// 递归内联本地 $defs 引用（把 $ref 展开为真实定义）
const inlineLocalReferences = (
  // 当前处理的值
  value: unknown,
  // 当前可见的本地定义表
  definitions?: Record<string, unknown>,
  // 已展开的定义名（防递归死循环）
  seen = new Set<string>(),
): unknown => {
  // 数组：逐元素递归
  if (Array.isArray(value)) return value.map((item) => inlineLocalReferences(item, definitions, seen))
  // 非普通对象原样返回
  if (!isRecord(value)) return value

  // 首次进入时从根节点取 $defs
  const localDefinitions = definitions ?? (isRecord(value.$defs) ? value.$defs : undefined)
  // 存在 $ref 且有本地定义表时尝试内联
  if (typeof value.$ref === "string" && localDefinitions) {
    // 解析 $ref 的 URI 片段指针
    const tokens = JsonPointer.parseUriFragment(value.$ref)
    // 仅处理 "#/$defs/名称" 形式的本地引用
    const name = tokens?.length === 2 && tokens[0] === "$defs" ? tokens[1] : undefined
    // 名称有效且未展开过（防止递归引用无限展开）
    if (name && !seen.has(name)) {
      // 取出被引用的定义
      const target = localDefinitions[name]
      // 定义存在时执行内联
      if (target) {
        // 移除当前对象的 $ref，保留其余键
        const { $ref: _, ...rest } = value
        // 递归展开目标定义（记录已见名称）
        const resolvedTarget = inlineLocalReferences(target, localDefinitions, new Set(seen).add(name))
        // 递归处理当前对象剩余的键
        const resolvedSiblings = inlineLocalReferences(rest, localDefinitions, seen)
        // 任一侧不是对象时只保留目标
        if (!isRecord(resolvedTarget) || !isRecord(resolvedSiblings)) return resolvedTarget
        // 键不冲突时直接合并
        if (canMergeRecords(resolvedTarget, resolvedSiblings)) return { ...resolvedTarget, ...resolvedSiblings }
        // 有键冲突时用 allOf 组合（保持校验语义）
        return { allOf: [resolvedTarget, resolvedSiblings] }
      }
    }
  }

  // 无需内联：递归处理对象的每个属性
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, inlineLocalReferences(item, localDefinitions, seen)]),
  )
}

// 判断两个对象能否直接合并（左侧所有键不在右侧出现）
const canMergeRecords = (left: Record<string, unknown>, right: Record<string, unknown>) =>
  // 检查键冲突
  Object.keys(left).every((key) => !(key in right))

// 当所有本地引用都已内联后，移除多余的 $defs
const dropDefinitionsIfResolved = (value: unknown): unknown => {
  // 非对象或仍含本地引用时原样返回
  if (!isRecord(value) || hasLocalReference(value)) return value
  // 去掉 $defs 键
  const { $defs: _, ...rest } = value
  // 返回清理后的对象
  return rest
}

// 递归检查值中是否仍存在指向 #/$defs/ 的本地引用
const hasLocalReference = (value: unknown): boolean => {
  // 数组：任一元素命中即真
  if (Array.isArray(value)) return value.some(hasLocalReference)
  // 非普通对象返回否
  if (!isRecord(value)) return false
  // 自身就是本地引用
  if (typeof value.$ref === "string" && value.$ref.startsWith("#/$defs/")) return true
  // 递归检查所有属性值
  return Object.values(value).some(hasLocalReference)
}

// 把工具正文内容规范化为标准 Content 数组
export const normalizeContent = (value: string | ReadonlyArray<Tool.Content> | undefined, output?: unknown) => {
  // 字符串：包装成单个 text 内容块
  if (typeof value === "string") return [{ type: "text" as const, text: value }]
  // 已有内容数组且非空：浅拷贝返回
  if (value !== undefined && value.length > 0) return [...value]
  // 无内容时把输出值字符串化作为文本返回
  return [{ type: "text" as const, text: stringify(output) }]
}

// 把任意值安全转为字符串（优先原样字符串，其次 JSON，失败兜底 String()）
export const stringify = (value: unknown) => {
  // 字符串直接返回
  if (typeof value === "string") return value
  // 尝试 JSON 序列化
  try {
    // JSON 序列化（undefined 会得到 null，用 ?? 回退）
    return JSON.stringify(value) ?? String(value)
  } catch {
    // 序列化失败（如循环引用）时兜底
    return String(value)
  }
}

// 把工具名中不安全字符替换为下划线（模型/供应商兼容）
export const normalizedName = (tool: Pick<Tool.Info, "name">) => tool.name.replace(/[^a-zA-Z0-9_-]/g, "_")

// 计算工具的有效名称：带命名空间时用下划线拼接前缀
// 无命名空间时只做规范化；有命名空间：点号转下划线 + 规范化工具名
export const effectiveName = (tool: Pick<Tool.Info, "name" | "options">) =>
  tool.options?.namespace === undefined
    ? normalizedName(tool)
    : `${tool.options.namespace.replaceAll(".", "_")}_${normalizedName(tool)}`

/** For `Effect.mapError`: keep a `ToolFailure` as is, wrap anything else with `message`. */
// 供 Effect.mapError 使用：ToolFailure 原样保留，其它错误用给定 message 包装
export const toolFailure = (message: string) => (error: unknown) =>
  error instanceof ToolFailure ? error : new ToolFailure({ message, error })
