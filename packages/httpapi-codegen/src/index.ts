/**
 * httpapi-codegen：把 effect HttpApi 契约编译为各客户端形态的代码生成器。
 *
 * 模块职责：
 * - compile()：反射 HttpApi 契约，收集每个端点的输入/成功/错误 schema，做可移植性与命名校验；
 * - emitEffect()：内联生成"契约 + 类型 + 客户端"全套 Effect 代码；
 * - emitEffectImported()：生成"适配层"——引用既有 Api/分组/端点变量，不重建契约；
 * - emitEffectShape()：只生成类型层（AppApi 接口，即 client/src/effect/api/api.ts 的来源）；
 * - emitPromise()：生成零依赖的 Promise 风格客户端（types/client-error/client/index）。
 *
 * 在系统中的位置：packages/opencode/src/server 定义 HttpApi 契约 → 本生成器（CLI 在 scripts）
 * 产出 client/src/effect/api/api.ts 与 packages/client/src/effect/generated/* 等文件。
 *
 * 关键设计：
 * - 生成符号名一律由分组/端点标识推导（与遍历顺序无关），新增端点不会改名无关产物；
 * - "可移植性"判定：schema 的注解/检查/编码链可被代码生成器复现，决定走内联生成还是权威导入；
 * - 命名空间迁移（namespace/aliases）：把端点嵌进客户端命名空间，同时生成 deprecated 别名保兼容；
 * - 所有生成文件以 prettier 格式化，并用清单文件记录上次产物以便清理过期文件。
 */
import { isAbsolute, join } from "node:path"
// 导入 effect 核心：Context/Effect/FileSystem/PlatformError/Schema 及 Schema AST 与表示工具
import { Context, Effect, FileSystem, PlatformError, Schema, SchemaAST, SchemaRepresentation } from "effect"
// 导入 HTTP 方法常量与 HttpRouter 类型（校验端点路径合法性）
import { HttpMethod, type HttpRouter } from "effect/http"
// 导入 effect 的 HttpApi 契约设施：API/端点/分组/Schema 编码与 OpenAPI 注解
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api"
// 导入 prettier：生成代码后统一格式化
import { format } from "prettier"

// 输入字段描述：字段名 + 来源（路径参数/查询串/请求头/请求体）
export type InputField = {
  // 字段名
  readonly name: string
  // 字段来源
  readonly source: "params" | "query" | "headers" | "payload"
}

// 操作级输入字段：在 InputField 基础上多出 wildcard（路径通配符）来源
export type OperationInputField = {
  // 字段名
  readonly name: string
  // 字段来源（额外允许 wildcard）
  readonly source: InputField["source"] | "wildcard"
}

// 操作描述：生成器为每个端点产出的元信息（分组/方法名/输入模式/成功形态/错误）
export type Operation = {
  // 所属分组名（可能带命名空间前缀）
  readonly group: string
  // 客户端方法名（clientPath 以点连接）
  readonly name: string
  // 输入字段列表
  readonly input: ReadonlyArray<OperationInputField>
  // 输入模式：无参 / 全部可选 / 必填
  readonly inputMode: "none" | "optional" | "required"
  // 成功响应形态：返回值 / 无内容 / 流
  readonly success: "value" | "void" | "stream"
  // 可能抛出的错误标识列表（含 ClientError）
  readonly errors: ReadonlyArray<string>
}

// 生成器输出：操作元信息列表 + 待写文件（路径 + 内容）
export type Output = {
  // 操作列表
  readonly operations: ReadonlyArray<Operation>
  // 文件列表
  readonly files: ReadonlyArray<{
    // 文件相对路径
    readonly path: string
    // 文件内容
    readonly content: string
  }>
}

// 契约：compile() 的产出——分组列表 + 可选的废弃别名列表
export type Contract = {
  // 分组列表
  readonly groups: ReadonlyArray<Group>
  // 可选：旧路径别名（端点迁入命名空间时保留兼容）
  readonly aliases?: ReadonlyArray<Alias>
}

/** A namespaced endpoint's pre-namespace client path and group, kept as a deprecated alias of its new location. */
// 废弃别名：记录带命名空间端点的旧客户端路径与旧分组，作为新位置的 deprecated 别名保留
export type Alias = {
  // 旧路径（相对客户端根）
  readonly from: ReadonlyArray<string>
  // 新路径
  readonly to: ReadonlyArray<string>
  // 旧分组名
  readonly fromGroup: string
  // 新分组
  readonly group: Group
  // 端点本体
  readonly endpoint: Endpoint
}

// Effect 类型引用：把某 schema 生成的类型替换为外部命名类型的引用（避免重复展开）
export type EffectTypeReference = {
  // 被引用的 schema
  readonly schema: Schema.Top
  // 引用类型的名字
  readonly name: string
  // 引用类型的导入来源
  readonly import: string
}

// Effect 输出类型覆盖：把某端点的输出类型替换为外部类型
export type EffectOutputType = {
  // 类型名
  readonly name: string
  // 导入来源
  readonly import: string
}

// 已解析的类型引用：schema 换成 AST 与可选的 TS 类型文本
type ResolvedEffectTypeReference = Omit<EffectTypeReference, "schema"> & {
  // schema 的 AST
  readonly ast: SchemaAST.AST
  // 生成的 TS 类型文本（无法生成时为 undefined）
  readonly type: string | undefined
}

// 生成失败错误：带 reason 的 TaggedError，生成器所有失败统一抛它
export class GenerationError extends Schema.TaggedError<GenerationError>()("GenerationError", {
  // 失败原因描述
  reason: Schema.String,
}) {
  // 覆写 message：直接暴露 reason 文本
  override get message() {
    // 返回原因
    return this.reason
  }
}

// 端点编译产物：compile 内部为每个端点收集的全部信息（后续各渲染器共用）
export type Endpoint = {
  // 所属分组名（带命名空间）
  readonly group: string
  // 分组在客户端对象上的路径
  readonly groupPath: ReadonlyArray<string>
  // 原始分组标识
  readonly sourceGroup: string
  // 是否顶层分组（方法直接挂在客户端根上）
  readonly topLevel: boolean
  // effect HttpApi 的端点原对象
  readonly endpoint: HttpApiEndpoint.Top
  // 路径参数 schema（无则 undefined）
  readonly params: Schema.Top | undefined
  // 查询参数 schema
  readonly query: Schema.Top | undefined
  // 请求头 schema
  readonly headers: Schema.Top | undefined
  // 请求体 schema 列表
  readonly payloads: ReadonlyArray<Schema.Top>
  // 对应的操作元信息
  readonly operation: Operation
  // 客户端方法路径（至少一段）
  readonly clientPath: readonly [string, ...Array<string>]
  // 输入字段（带 optional 标记）
  readonly input: ReadonlyArray<InputField & { readonly optional: boolean }>
  // 成功响应是否为 { data } 信封（客户端需解包）
  readonly unwrapData: boolean
  // 错误列表：状态码 + schema
  readonly errors: ReadonlyArray<{ readonly status: number; readonly schema: Schema.Top }>
  // 成功响应 schema 列表
  readonly successes: ReadonlyArray<Schema.Top>
  // 是否所有 schema 都可被 Effect 代码生成器复现（决定内联生成还是权威导入）
  readonly effectPortable: boolean
}

// 分组：一组端点 + 在客户端对象上的位置 + 生成的模块名
export type Group = {
  // 分组标识
  readonly identifier: string
  /** Where the group's methods live on the client; empty for top-level groups outside a namespace. */
  // 分组方法在客户端上的路径（顶层分组为空数组）
  readonly path: ReadonlyArray<string>
  // 原始分组标识
  readonly sourceIdentifier: string
  // 生成的模块文件名（不含 .ts）
  readonly module: string
  // 组内端点列表
  readonly endpoints: ReadonlyArray<Endpoint>
}

// 内部：命名槽位（schema + 生成的变量名），渲染分组文件时用
type Slot = {
  // 槽位名（生成的 const 名）
  readonly name: string
  // 对应 schema
  readonly schema: Schema.Top
}

// Promise 客户端的输入字段：普通字段或路径通配符
type PromiseInputField =
  // 普通输入字段（带 optional）
  | (InputField & { readonly optional: boolean })
  // 通配符字段（必填的字符串路径）
  | { readonly name: string; readonly source: "wildcard"; readonly optional: false }

// 解析端点的 httpApiStatus 注解：优先走 AST 解析器，旧 AST 回退到 context 注解
const resolveHttpApiStatus = (ast: SchemaAST.AST) =>
  // 先尝试在 AST 上解析 httpApiStatus
  SchemaAST.resolveAt<number>("httpApiStatus")(ast) ??
  // 回退：从 context 注解取（兼容 checks 未定义的旧 AST）
  (ast.checks === undefined ? ast.context?.annotations?.httpApiStatus : undefined)
// 解析 ~httpApiEncoding 注解（编码方式：Json/Uint8Array/FormUrlEncoded 等）
const resolveHttpApiEncoding = SchemaAST.resolveAt<HttpApiSchema.Encoding>("~httpApiEncoding")
// 清单文件 schema：字符串数组的 JSON（记录上次生成的文件列表）
const Manifest = Schema.fromJsonString(Schema.Array(Schema.String))
// 清单文件名（写入输出目录，用于清理过期产物）
const manifestName = ".httpapi-codegen.json"

// compile：把 HttpApi 契约编译为 Contract——生成流程第一步（反射端点 → 校验 → 分组）
export function compile<Id extends string, Groups extends HttpApiGroup.Constraint>(
  // 待编译的 HttpApi 实例
  api: HttpApi.HttpApi<Id, Groups>,
  // 可选项
  options?: {
    // 可选：分组名重命名映射（原标识 → 客户端名）
    readonly groupNames?: Readonly<Record<string, string>>
    // 可选：要跳过生成的端点标识集合
    readonly omitEndpoints?: ReadonlySet<string>
    /**
     * Nests an endpoint's group under a client namespace, so `client.<group>.<method>` becomes
     * `client.<namespace>.<group>.<method>`. A group whose name equals the namespace is not repeated.
     */
    // 可选：把端点分组嵌进客户端命名空间（client.group.method → client.ns.group.method）；与命名空间同名的分组不重复
    readonly namespace?: (endpoint: HttpApiEndpoint.Top) => string | undefined
    /**
     * Keeps each namespaced endpoint's pre-namespace client path and generated type names as deprecated aliases of
     * the namespaced ones, so moving an endpoint into a namespace does not break callers.
     */
    // 可选：为迁入命名空间的端点保留旧路径与旧类型名的 deprecated 别名，避免破坏调用方
    readonly aliases?: boolean
  },
// 返回编译后的契约
): Contract {
  // 收集全部编译好的端点
  const endpoints: Array<Endpoint> = []
  // 缓存：AST → 是否可移植（避免重复判定）
  const portable = new Map<SchemaAST.AST, boolean>()
  // Where each namespaced endpoint would sit without its namespace.
  // 记录每个被命名空间化端点"不带命名空间时"的分组与路径（供生成别名用）
  const unnamespaced = new Map<Endpoint, { readonly group: string; readonly path: ReadonlyArray<string> }>()

  // 反射 HttpApi：逐分组/端点回调，把端点编译进 endpoints
  HttpApi.reflect(api, {
    // 分组回调：无需处理（信息都在端点上）
    onGroup() {},
    // 端点回调：编译单个端点
    onEndpoint({ endpoint, errors, group, middleware }) {
      // 跳过显式排除的端点
      if (options?.omitEndpoints?.has(endpoint.identifier)) return
      // 解析分组在客户端上的名字（可用 groupNames 重命名）
      const sourceName = options?.groupNames?.[group.identifier] ?? group.identifier
      // 计算该端点应处的客户端命名空间
      const namespace = options?.namespace?.(endpoint)
      // 命名空间不能为空串或原型链危险名 __proto__
      if (namespace === "" || namespace === "__proto__") {
        // 抛出非法命名空间错误
        throw new GenerationError({ reason: `Invalid client namespace: ${JSON.stringify(namespace)}` })
      }
      // 分组最终名：有命名空间且不同于源名时加前缀，否则用源名
      const groupName = namespace === undefined || namespace === sourceName ? sourceName : `${namespace}.${sourceName}`
      // 计算分组在客户端对象上的路径（决定嵌套层级）
      const groupPath =
        namespace === undefined
          // 无命名空间：顶层分组直接挂根
          ? group.topLevel
            // 非顶层分组占一层
            ? []
            : [sourceName]
          // 有命名空间：顶层分组或与源同名时只占命名空间一层
          : group.topLevel || namespace === sourceName
            // 否则命名空间 + 源名两层
            ? [namespace]
            : [namespace, sourceName]
      // 端点全名：分组名 + 端点标识（错误信息用）
      const name = `${groupName}.${endpoint.identifier}`
      // 查找对客户端必需的中间件
      const required = Array.from(middleware).find((item) => item.requiredForClient)
      // 客户端无法执行服务端中间件，必须报错要求适配器
      if (required !== undefined) {
        // 抛出需要适配器的错误
        throw new GenerationError({ reason: `Client middleware requires adapter: ${required.key}` })
      }

      // 取端点的全部成功响应 schema
      const successSchemas = Array.from(endpoint.success)
      // 无成功 schema 视为 204 无内容
      if (successSchemas.length === 0) successSchemas.push(HttpApiSchema.NoContent)
      // 多个成功 schema 无法映射为单一返回类型，报错
      if (successSchemas.length > 1) throw new GenerationError({ reason: `Multiple success schemas: ${name}` })

      // 归一化路径参数 schema（校验可移植性并与重建形态比对）
      const params = normalizeTransport(endpoint.params, "params", endpoint, name)
      // 归一化 query schema
      const query = normalizeTransport(endpoint.query, "query", endpoint, name)
      // 归一化 headers schema
      const headers = normalizeTransport(endpoint.headers, "headers", endpoint, name)
      // 收集请求体 schema（各 content-type 分组的全部 schema）
      const sourcePayloads = Array.from(endpoint.payload.values()).flatMap(({ schemas }) => schemas)
      // 多个请求体 schema 无法用单一输入类型表达，报错
      if (sourcePayloads.length > 1) {
        // 抛出多 payload 错误
        throw new GenerationError({ reason: `Multiple payload schemas: ${name}` })
      }
      // 逐个归一化 payload
      const payloads = sourcePayloads.map((schema) => normalizeTransport(schema, "payload", endpoint, name)!)
      // 归一化成功响应
      const success = normalizeTransport(successSchemas[0], "success", endpoint, name)!
      // Sort by status so output does not churn when middleware changes the declaration order.
      // 错误按状态码排序，避免中间件改变声明顺序导致生成物抖动
      const errorSchemas = Array.from(errors)
        // 排序后展开为 { status, schema } 列表
        .toSorted(([a], [b]) => a - b)
        .flatMap(([status, schemas]) =>
          schemas.map((schema) => ({ status, ...normalizeTransport(schema, "error", endpoint, name)! })),
        )
      // 汇总全部输入字段：params/query/headers/payload 依次收集
      const inputs = [
        // 路径参数字段
        ...inputFields(params?.schema, "params", name),
        // 查询字段
        ...inputFields(query?.schema, "query", name),
        // 请求头字段
        ...inputFields(headers?.schema, "headers", name),
        // 请求体字段
        ...payloads.flatMap((item) => inputFields(item.schema, "payload", name)),
      ]
      // 记录字段名 → 来源，用于跨来源冲突检测
      const names = new Map<string, InputField["source"]>()
      // 逐字段查重
      for (const field of inputs) {
        // 已有同名字段
        const existing = names.get(field.name)
        // 同名字段已存在 → 报错
        if (existing !== undefined) {
          // 不透明 payload（非扁平 struct）与其他来源冲突时给出更具体的信息
          if (field.source === "payload" && payloads[0] !== undefined && !isFlattenableStruct(payloads[0].schema)) {
            // 抛出不透明 payload 冲突错误
            throw new GenerationError({
              reason: `Opaque payload field collision: ${name}.payload conflicts with ${existing}.${field.name}`,
            })
          }
          // 抛出普通字段冲突错误
          throw new GenerationError({ reason: `Input field collision: ${field.name}` })
        }
        // 登记字段名
        names.set(field.name, field.source)
      }

      // 收集端点全部 schema 及其诊断路径（错误信息中定位用）
      const schemaPaths: Array<readonly [string, Schema.Top]> = [
        // 路径参数
        ...(params === undefined ? [] : [[`${name}.params`, params.schema] as const]),
        // 查询
        ...(query === undefined ? [] : [[`${name}.query`, query.schema] as const]),
        // 请求头
        ...(headers === undefined ? [] : [[`${name}.headers`, headers.schema] as const]),
        // 请求体
        ...payloads.map((item) => [`${name}.payload`, item.schema] as const),
        // 成功响应（流会拆出 data/error 两项）
        ...responseSchemas(success.schema, `${name}.success`),
        // 各状态码错误
        ...errorSchemas.map((item) => [`${name}.error.${item.status}`, item.schema] as const),
      ]
      // 判定端点是否 effect 可移植：全部 schema 可移植且流可移植
      const effectPortable =
        // 逐个检查 params/query/headers/payload/success/errors
        [params, query, headers, ...payloads, success, ...errorSchemas].every(
          // 任一显式标记 effectPortable === false 即不可移植
          (item) => item?.effectPortable !== false,
        // 再检查流成功响应的可移植性
        ) && streamEffectPortable(success.schema)
      // 可移植时逐个断言（内部带缓存）
      if (effectPortable) {
        // 断言每个 schema 可移植，否则抛错
        for (const [path, schema] of schemaPaths) assertPortable(schema, path, portable)
      }

      // 计算客户端方法路径：优先用 OpenAPI identifier 注解，回退到 分组.端点 拼接
      const clientPath = clientEndpointPath(
        // 传入分组标识
        group.identifier,
        // 取端点的 OpenAPI identifier 注解（无则回退）
        Context.getOrElse(endpoint.annotations, OpenApi.Identifier, () =>
          // 回退名：顶层分组用端点标识，否则 分组.端点
          group.topLevel ? endpoint.identifier : `${group.identifier}.${endpoint.identifier}`,
        ),
      )
      // 组装端点编译产物
      const compiled: Endpoint = {
        // 分组名（带命名空间）
        group: groupName,
        // 客户端分组路径
        groupPath,
        // 原始分组标识
        sourceGroup: group.identifier,
        // 是否顶层分组
        topLevel: group.topLevel,
        // 原始端点对象
        endpoint,
        // 路径参数 schema
        params: params?.schema,
        // 查询 schema
        query: query?.schema,
        // 请求头 schema
        headers: headers?.schema,
        // 请求体 schema 列表
        payloads: payloads.map((item) => item.schema),
        // 输入字段列表
        input: inputs,
        // 客户端方法路径
        clientPath,
        // 成功响应是否带 { data } 信封
        unwrapData: isDataEnvelope(success.schema),
        // 成功 schema 列表
        successes: [success.schema],
        // 错误列表（保留状态码）
        errors: errorSchemas.map((item) => ({ status: item.status, schema: item.schema })),
        // 是否 effect 可移植
        effectPortable,
        // 操作元信息
        operation: {
          // 分组名
          group: groupName,
          // 方法名 = 客户端路径以点连接
          name: clientPath.join("."),
          // 输入字段（只保留名字与来源）
          input: inputs.map(({ name, source }) => ({ name, source })),
          // 输入模式：无字段为 none，全可选为 optional，否则 required
          inputMode: inputs.length === 0 ? "none" : inputs.every((field) => field.optional) ? "optional" : "required",
          // 成功形态：流 → stream；无内容 → void；其余 → value
          success: isStreamSchema(success.schema)
            // 流
            ? "stream"
            // 无内容（204）
            : HttpApiSchema.isNoContent(success.schema.ast)
              // 普通值
              ? "void"
              : "value",
          // 错误标识集合：各错误 schema 的 identifier + 固定的 ClientError
          errors: [
            // 用 Set 去重
            ...new Set([
              // 提取每个错误 schema 的标识
              ...errorSchemas.flatMap((item) => {
                // 解析 schema 的 identifier 注解
                const identifier = SchemaAST.resolveIdentifier(item.schema.ast)
                // 无标识则跳过
                return identifier === undefined ? [] : [identifier]
              }),
              // 始终包含 ClientError（传输层错误兜底）
              "ClientError",
            ]),
          ],
        },
      }
      // 收录该端点
      endpoints.push(compiled)
      // 端点确实被移入命名空间时记录其原位置
      if (namespace !== undefined && namespace !== sourceName) {
        // 原位置：原分组名 + 原路径
        unnamespaced.set(compiled, { group: sourceName, path: group.topLevel ? [] : [sourceName] })
      }
    },
  })

  // 已占用的模块名（内置 client/client-error/index 三个）
  const modules = new Set(["client", "client-error", "index"])
  // 按分组名聚合端点并逐组校验
  const groups = Array.from(
    // 用 Map.groupBy 按分组名分组
    Map.groupBy(endpoints, (endpoint) => endpoint.group),
    // 对每个分组：
    ([identifier, endpoints]) => {
      // 同名分组若来自多个源分组，说明命名冲突
      if (new Set(endpoints.map((endpoint) => endpoint.sourceGroup)).size > 1) {
        // 抛出分组名冲突错误
        throw new GenerationError({ reason: `Client group name collision: ${identifier}` })
      }
      // 取分组路径（取首个端点的）
      const path = endpoints[0].groupPath
      // 组内端点路径不一致说明分组路径冲突
      if (endpoints.some((endpoint) => endpoint.groupPath.join("\0") !== path.join("\0"))) {
        // 抛出路径冲突
        throw new GenerationError({ reason: `Client group path conflict: ${identifier}` })
      }
      // Module names derive from the group identifier so unrelated groups never rename.
      // 模块名由分组标识清洗而来：非法字符替换为 -，去掉首尾连字符
      const sanitized = identifier.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")
      // Windows 保留名与内置名不可用作模块名
      const reserved = /^(aux|client|client-error|con|index|nul|prn|com[1-9]|lpt[1-9])$/i.test(sanitized)
      // 空名或保留名时加 group- 前缀兜底
      const module = sanitized === "" || reserved ? `group-${sanitized}` : sanitized
      // 模块名小写后查重（大小写不敏感文件系统的兼容）
      if (modules.has(module.toLowerCase())) {
        // 抛出模块名冲突
        throw new GenerationError({ reason: `Client module name collision: ${module}` })
      }
      // 登记已用模块名
      modules.add(module.toLowerCase())
      // 产出分组记录
      return { identifier, path, sourceIdentifier: endpoints[0].sourceGroup, module, endpoints }
    },
  )
  // 收集全部分组类型名（查重用）
  const groupTypeNames = new Set<string>()
  // 收集全部端点类型名
  const endpointTypeNames = new Set<string>()
  // 收集全部操作键
  const operationKeys = new Set<string>()
  // 遍历分组做命名校验
  for (const group of groups) {
    // 分组标识不能是 __proto__（会污染对象原型）
    if (group.identifier === "__proto__") {
      // 抛出错误
      throw new GenerationError({ reason: "Client group name cannot be __proto__" })
    }
    // 分组类型名 = 标识符转 PascalCase 片段
    const groupTypeName = identifierPart(group.identifier)
    // 重复即冲突
    if (groupTypeNames.has(groupTypeName)) {
      // 抛出分组类型冲突
      throw new GenerationError({ reason: `Client group type collision: ${groupTypeName}` })
    }
    // 登记分组类型名
    groupTypeNames.add(groupTypeName)
    // 校验组内客户端路径两两不冲突（前缀包含也算冲突）
    assertUniqueClientPaths(
      // 传入本组全部客户端路径
      group.endpoints.map((endpoint) => endpoint.clientPath),
      // 冲突时的错误信息
      (path) => `Client endpoint name collision: ${group.identifier}.${path.join(".")}`,
    )
    // 组内短名查重集合
    const typeNames = new Set<string>()
    // 遍历组内端点
    for (const endpoint of group.endpoints) {
      // 计算操作键（分组标识 + 客户端路径）
      const operationKey = clientOperationKey(group, endpoint)
      // 操作键重复即冲突
      if (operationKeys.has(operationKey)) {
        // 抛出操作键冲突
        throw new GenerationError({ reason: `Client operation key collision: ${operationKey}` })
      }
      // 登记操作键
      operationKeys.add(operationKey)
      // 端点短类型名 = 客户端路径各段转 PascalCase 后拼接
      const name = endpoint.clientPath.map(identifierPart).join("")
      // 完整端点类型名 = 分组类型名 + 端点短名
      const endpointTypeName = `${groupTypeName}${name}`
      // 端点类型名重复即冲突
      if (endpointTypeNames.has(endpointTypeName)) {
        // 抛出端点类型冲突
        throw new GenerationError({ reason: `Client endpoint type collision: ${endpointTypeName}` })
      }
      // 登记端点类型名
      endpointTypeNames.add(endpointTypeName)
      // 组内短名也要唯一
      if (typeNames.has(name)) {
        // 抛出短名冲突
        throw new GenerationError({ reason: `Client endpoint type collision: ${group.identifier}.${name}` })
      }
      // 登记短名
      typeNames.add(name)
    }
  }
  // visit：递归校验客户端对象树中同层字段名不冲突
  const visit = (node: GroupNode, path: ReadonlyArray<string>) => {
    // 本层已用名字
    const keys = new Set<string>()
    // 遍历本层条目
    for (const entry of node.entries) {
      // 字符串条目是命名空间占位；分组条目取其端点路径首段
      const names =
        // 取该条目在本层暴露的名字
        typeof entry === "string" ? [entry] : [...new Set(entry.endpoints.map((item) => item.clientPath[0]))]
      // 逐名字校验
      for (const name of names) {
        // 重名即冲突（打印完整路径）
        if (keys.has(name)) throw new GenerationError({ reason: `Client name collision: ${[...path, name].join(".")}` })
        // 登记名字
        keys.add(name)
      }
    }
    // 递归子命名空间
    for (const [name, child] of node.children) visit(child, [...path, name])
  }
  // 从根开始校验
  visit(groupTree(groups), [])
  // 未开启 aliases 时直接返回（不含别名）
  if (options?.aliases !== true) return { groups }
  // 生成别名列表：每个被命名空间化的端点对应一条
  const aliases = groups.flatMap((group) =>
    // 对每个端点：
    group.endpoints.flatMap((endpoint): Array<Alias> => {
      // 查端点的原位置
      const previous = unnamespaced.get(endpoint)
      // 没有原位置则无别名
      if (previous === undefined) return []
      // 产出别名记录
      return [
        {
          // 旧路径 = 原路径 + 客户端路径
          from: [...previous.path, ...endpoint.clientPath],
          // 新路径 = 分组路径 + 客户端路径
          to: [...group.path, ...endpoint.clientPath],
          // 旧分组名
          fromGroup: previous.group,
          // 新分组
          group,
          // 端点本体
          endpoint,
        },
      ]
    }),
  )
  // 收集全部新路径（与别名旧路径做冲突比对）
  const paths = groups.flatMap((group) => group.endpoints.map((endpoint) => [...group.path, ...endpoint.clientPath]))
  // 校验别名旧路径与现有路径不冲突
  for (const alias of aliases) {
    // 别名旧路径的规范化 key
    const key = alias.from.join("\0")
    // 检查每个现有路径
    const conflict = paths.some((path) => {
      // 现有路径的 key
      const other = path.join("\0")
      // 相等或互为前缀都算冲突
      return other === key || other.startsWith(`${key}\0`) || key.startsWith(`${other}\0`)
    })
    // 抛出别名路径冲突
    if (conflict) throw new GenerationError({ reason: `Client alias collision: ${alias.from.join(".")}` })
  }
  // 再用通用断言校验别名路径两两不冲突
  assertUniqueClientPaths(
    // 全部别名旧路径
    aliases.map((alias) => alias.from),
    // 冲突错误信息
    (path) => `Client alias collision: ${path.join(".")}`,
  )
  // 返回带别名的契约
  return { groups, aliases }
}

// emitEffect：产出内联生成的 Effect 客户端（契约+类型+实现全部重新生成）
export function emitEffect(contract: Contract): Output {
  // 找第一个不可移植的端点
  const endpoint = contract.groups.flatMap((group) => group.endpoints).find((endpoint) => !endpoint.effectPortable)
  // 存在不可移植端点则无法内联生成
  if (endpoint !== undefined) {
    // 抛出需要权威导入的错误
    throw new GenerationError({
      reason: `Effect schema requires authoritative import: ${endpoint.group}.${endpoint.endpoint.identifier}`,
    })
  }
  // 返回操作列表与渲染好的文件
  return { operations: operations(contract.groups), files: renderEffectFiles(contract.groups, contract.aliases ?? []) }
}

// emitEffectImported：产出"引用既有 Api/分组/端点"的适配层客户端（不重建契约）
export function emitEffectImported(
  // 编译好的契约
  contract: Contract,
  // 引用方式选项（三选一）
  options:
    // 方式一：引用整个 Api（module + api 变量名）
    | { readonly module: string; readonly api: string; readonly shapeModule?: string }
    // 方式二：引用单个分组
    | { readonly module: string; readonly group: string; readonly shapeModule?: string }
    // 方式三：按端点映射引用
    | {
        // 被引用模块路径
        readonly module: string
        // 分组.端点 → 导入变量名映射
        readonly endpoints: Readonly<Record<string, string>>
        // 可选：shape 类型所在模块
        readonly shapeModule?: string
      },
): Output {
  // 组装输出
  return {
    // 操作列表（与内联一致）
    operations: operations(contract.groups),
    // 文件由适配层渲染器产出
    files: renderImportedEffectFiles(contract.groups, contract.aliases ?? [], options),
  }
}

// emitEffectShape：只生成类型层（AppApi 接口），不生成运行时客户端
export function emitEffectShape(
  // 编译好的契约
  contract: Contract,
  // 可选项
  options?: {
    // 可选：外部类型引用（替换内联展开）
    readonly typeReferences?: ReadonlyArray<EffectTypeReference>
    // 可选：输出类型覆盖
    readonly outputTypes?: Readonly<Record<string, EffectOutputType>>
  },
): Output {
  // 组装输出
  return {
    // 操作列表
    operations: operations(contract.groups),
    // 文件列表
    files: [
      {
        // 唯一文件：api.ts
        path: "api.ts",
        // 内容 = 渲染类型层
        content: renderEffectShape(
          // 传分组
          contract.groups,
          // 类型引用（默认空）
          options?.typeReferences ?? [],
          // 输出类型覆盖
          options?.outputTypes,
          // 别名列表
          contract.aliases ?? [],
        ),
      },
    ],
  }
}

// emitPromise：产出 Promise 风格客户端（types/client-error/client/index 四文件）
export function emitPromise(
  // 编译好的契约
  contract: Contract,
  // 可选项
  options?: {
    // 可选：输出类型覆盖（名字 + 导入来源）
    readonly outputTypes?: Readonly<Record<string, { readonly name: string; readonly import: string }>>
    // 可选：是否输出可变类型（去掉 readonly）
    readonly mutableOutputs?: boolean
  },
// 返回 Output
): Output {
  // 取全部分组
  const groups = contract.groups
  // 逐分组校验
  for (const group of groups) {
    // 逐端点断言 Promise 客户端的限制
    for (const endpoint of group.endpoints) assertPromiseEndpoint(endpoint)
  }
  // 组装输出
  return {
    // 操作列表（按 Promise 输入规则重算）
    operations: promiseOperations(groups),
    // 文件列表
    files: [
      {
        // types.ts：类型定义
        path: "types.ts",
        // 类型文件内容（覆盖/可变/别名选项透传）
        content: renderPromiseTypes(groups, options?.outputTypes, options?.mutableOutputs ?? false, contract.aliases),
      },
      // client-error.ts
      {
        // 文件路径：client-error.ts
        path: "client-error.ts",
        // 内容：固定的 ClientError 模板（字符串字面量，原样保留）
        content: `export type ClientErrorReason = "Transport" | "UnexpectedStatus" | "UnsupportedContentType" | "MalformedResponse" | "SseEventTooLarge"\n\nexport class ClientError extends Error {\n  override readonly name = "ClientError"\n  constructor(readonly reason: ClientErrorReason, options?: ErrorOptions & { readonly detail?: string | null }) {\n    const detail = options?.detail ?? (options?.cause instanceof Error ? options.cause.message : undefined)\n    super(detail ? \`\${reason}: \${detail}\` : reason, options)\n  }\n}\n`,
      },
      // client.ts
      {
        // 文件路径：client.ts
        path: "client.ts",
        // 内容：渲染后按需注入二进制/通配符支持
        content: normalizePromiseClientContent(renderPromiseClient(groups, contract.aliases), groups),
      },
      // index.ts
      {
        // 文件路径：index.ts
        path: "index.ts",
        // 内容：
        content:
          // 出口模板（导出 ClientError 与 client/types）
          'export { ClientError, type ClientErrorReason } from "./client-error.js"\nexport * as OpenCode from "./client.js"\nexport * from "./types.js"\n',
      },
    ],
  }
}

// renderEffectShape：渲染整个 api.ts 类型层内容
function renderEffectShape(
  // 全部分组
  groups: ReadonlyArray<Group>,
  // 外部类型引用
  typeReferences: ReadonlyArray<EffectTypeReference>,
  // 输出类型覆盖（可 undefined）
  outputTypes: Readonly<Record<string, EffectOutputType>> | undefined,
  // 别名列表
  aliases: ReadonlyArray<Alias>,
) {
  // 解析类型引用（建 names/asts 两个索引）
  const references = effectTypeReferences(typeReferences)
  // 需要追加的 import 集合（渲染类型时收集）
  const imports = new Set<string>()
  // 外部名字集合：AppApi/Effect/Stream + 引用与覆盖中的标识符（生成名不得与之冲突）
  const externalNames = new Set([
    // 固定占用的名字
    "AppApi",
    // 类型引用的名字
    "Effect",
    // 输出覆盖的名字
    "Stream",
    ...typeReferences.flatMap((reference) => reference.name.match(/^[A-Za-z_$][A-Za-z0-9_$]*/) ?? []),
    ...Object.values(outputTypes ?? {}).flatMap((output) => output.name.match(/^[A-Za-z_$][A-Za-z0-9_$]*/) ?? []),
  ])
  // 生成器将产出的全部类型名
  const generatedNames = groups.flatMap((group) => [
    // 分组接口名
    groupShapeName(group),
    // 各端点的 Input/Output/Operation 类型名
    ...group.endpoints.flatMap((endpoint) => [
      // 无输入端点没有 Input 类型
      ...(endpoint.operation.inputMode === "none" ? [] : [`${endpointTypeName(group, endpoint)}Input`]),
      // 输出类型名
      `${endpointTypeName(group, endpoint)}Output`,
      // 操作类型名
      groupShapeTypeName(group, endpoint),
    ]),
  ])
  // 生成名与外部名冲突即报错
  const collision = generatedNames.find((name) => externalNames.has(name))
  // 检测到冲突
  if (collision !== undefined) {
    // 抛出生成类型与导入类型冲突
    throw new GenerationError({ reason: `Generated Effect type collides with imported type: ${collision}` })
  }
  // An alias joins the interface of the deepest group above its old path, so code typed against that group keeps
  // compiling; an alias with no such group becomes a field of AppApi.
  // 别名字段：在客户端树中的相对路径 + 生成的类型文本 + 原别名记录
  type AliasField = { readonly path: ReadonlyArray<string>; readonly value: string; readonly alias: Alias }
  // 分组 → 该组要附带的别名字段
  const groupAliases = new Map<Group, Array<AliasField>>()
  // 无挂靠分组的别名（最终挂到 AppApi 根上）
  const rootAliases: Array<AliasField> = []
  // 遍历别名
  for (const alias of aliases) {
    // 别名字段的类型文本：Operation<E>
    const value = `${groupShapeTypeName(alias.group, alias.endpoint)}<E>`
    // 找别名旧路径的最深祖先分组作为挂靠点
    const owner = groups
      // 过滤条件：
      .filter(
        // 分组路径非空
        (group) =>
          // 分组路径是别名旧路径的前缀
          group.path.length > 0 &&
          // 逐段比较
          group.path.length < alias.from.length &&
          // 路径前缀判断
          group.path.every((name, index) => alias.from[index] === name),
      )
      // 取最深匹配
      .toSorted((a, b) => b.path.length - a.path.length)[0]
    // 无挂靠分组 → 挂根
    if (owner === undefined) {
      // 登记到根别名
      rootAliases.push({ path: alias.from, value, alias })
      // 转下一个别名
      continue
    }
    // 合并进该分组的别名字段
    groupAliases.set(owner, [
      // 已有则追加
      ...(groupAliases.get(owner) ?? []),
      // 相对路径 = 别名路径去掉分组前缀
      { path: alias.from.slice(owner.path.length), value, alias },
    ])
  }
  // 根层已占用的首段名字（全部端点完整路径的首段）
  const rootNames = new Set(
    // 取每个端点完整路径的首段
    groups.flatMap((group) => group.endpoints.map((endpoint) => [...group.path, ...endpoint.clientPath][0])),
  )
  // 无挂靠别名若与根层现有首段同名会冲突
  const unowned = rootAliases.find((item) => rootNames.has(item.path[0]))
  // 检测到无处挂靠的别名
  if (unowned !== undefined) {
    // 抛出别名无处可挂错误
    throw new GenerationError({ reason: `Client alias has no group to join: ${unowned.alias.from.join(".")}` })
  }
  // 旧命名的类型别名（Input/Output/Operation 三件套）
  const aliasTypes: Array<{ readonly name: string; readonly target: string; readonly generic?: true }> =
    // 对每个别名：
    aliases.flatMap((alias) => {
      // 旧类型名 = 旧分组名 + 端点路径各段 PascalCase
      const from = `${identifierPart(alias.fromGroup)}${alias.endpoint.clientPath.map(identifierPart).join("")}`
      // 新类型名
      const to = endpointTypeName(alias.group, alias.endpoint)
      // 产出三条别名
      return [
        // 无输入端点没有 Input 别名
        ...(alias.endpoint.operation.inputMode === "none" ? [] : [{ name: `${from}Input`, target: `${to}Input` }]),
        // Output 别名
        { name: `${from}Output`, target: `${to}Output` },
        // Operation 别名（带 E 泛型）
        { name: `${from}Operation`, target: `${to}Operation`, generic: true as const },
      ]
    })
  // A group whose endpoints all moved into one group keeps its interface name as an alias of that group's.
  // 若旧分组的全部端点都迁进了同一个新分组，把旧分组接口名也做成别名
  for (const fromGroup of new Set(aliases.map((alias) => alias.fromGroup))) {
    // 新分组中已存在同名分组则跳过
    if (groups.some((group) => group.identifier === fromGroup)) continue
    // 该旧分组的全部迁移记录
    const moved = aliases.filter((alias) => alias.fromGroup === fromGroup)
    // 目标分组
    const target = moved[0].group
    // 迁移目标不一致或数量不齐则不生成整组别名
    if (moved.some((alias) => alias.group !== target) || moved.length !== target.endpoints.length) continue
    // 追加 分组Api → 新分组接口 的别名
    aliasTypes.push({ name: `${identifierPart(fromGroup)}Api`, target: groupShapeName(target), generic: true })
  }
  // 占用名集合 = 外部名 + 生成名
  const takenNames = new Set([...externalNames, ...generatedNames])
  // 别名类型名查重
  for (const { name } of aliasTypes) {
    // 抛出别名冲突
    if (takenNames.has(name)) throw new GenerationError({ reason: `Client type alias collision: ${name}` })
    // 登记占用名
    takenNames.add(name)
  }
  // 渲染每条别名为带 @deprecated 文档的类型别名
  const renderedAliasTypes = aliasTypes.map(
    // 生成别名声明文本
    (item) =>
      // 带泛型的 Operation 别名加 <E = never>
      `${deprecatedTypeAliasDoc(item.target)}\nexport type ${item.name}${item.generic ? "<E = never>" : ""} = ${item.target}${item.generic ? "<E>" : ""}`,
  )
  // 逐分组渲染端点类型与分组接口
  const endpointTypes = groups.map((group) => {
    // 逐端点渲染
    const endpoints = group.endpoints.map((endpoint) => {
      // 类型名前缀
      const prefix = endpointTypeName(group, endpoint)
      // 输入字段逐个渲染
      const input = endpoint.input
        // 对每个字段：
        .map((field) => {
          // 取字段 schema（从对应传输层挖出子属性）
          const schema = effectInputSchema(endpoint, field)
          // 取不到说明契约异常
          if (schema === undefined) {
            // 抛出缺 schema 错误
            throw new GenerationError({
              reason: `Missing Effect input schema: ${endpoint.group}.${endpoint.endpoint.identifier}.${field.name}`,
            })
          }
          // 渲染为 readonly 字段（可选标记 + effect 类型文本）
          return `readonly ${JSON.stringify(field.name)}${field.optional ? "?" : ""}: ${effectType(schema, references, imports)}`
        })
        // 拼接字段
        .join("; ")
      // 无输入端点不生成 Input 类型
      const inputType = endpoint.operation.inputMode === "none" ? "" : `export type ${prefix}Input = { ${input} }`
      // 计算输出 schema（流/204/信封已处理）
      const output = effectOutputSchema(endpoint)
      // 查找输出类型覆盖
      const override = outputTypes?.[clientOperationKey(group, endpoint)]
      // 有覆盖时登记其导入
      if (override !== undefined) imports.add(override.import)
      // 输出类型：覆盖名优先，无内容为 void，否则 effect 类型文本
      const outputType = `export type ${prefix}Output = ${override?.name ?? (output === undefined ? "void" : effectType(output, references, imports))}`
      // 产出三段：Input/Output/Operation
      return [
        // Input（无输入端点为空）
        endpoint.operation.inputMode === "none" ? "" : inputType,
        // Output
        outputType,
        // Operation 类型：入参 → Effect/Stream
        `export type ${groupShapeTypeName(group, endpoint)}<E = never> = (${endpoint.operation.inputMode === "none" ? "" : `input${endpoint.operation.inputMode === "optional" ? "?" : ""}: ${prefix}Input`}) => ${endpoint.operation.success === "stream" ? `Stream.Stream<${prefix}Output, E>` : `Effect.Effect<${prefix}Output, E>`}`,
      ]
        // 过滤空串
        .filter(Boolean)
        // 换行连接
        .join("\n")
    })
    // 渲染分组接口的方法字段（嵌套树 + 别名）
    const methods = renderClientTree(
      // 方法类型 = 对应 Operation<E>
      group.endpoints,
      // 字段渲染
      (endpoint) => `${groupShapeTypeName(group, endpoint)}<E>`,
      (name, value) => `readonly ${JSON.stringify(name)}: ${value}`,
      // 传入该分组的别名字段
      "\n",
      groupAliases.get(group),
    )
    // 分组文本 = 端点类型 + 分组接口
    return `${endpoints.join("\n\n")}\n\nexport interface ${groupShapeName(group)}<E = never> {\n${methods}\n}`
  })
  // 渲染 AppApi 根接口字段（决定每个分组如何聚合到根上）
  const clientFields = renderGroupTree(
    // 全部分组
    groups,
    // 成员渲染回调：按分组形态给出 fields 或 whole
    (group) =>
      // 顶层分组：方法摊开在根上
      group.endpoints[0]?.topLevel
        // 返回字段形态
        ? {
            // 渲染组内方法树
            fields: renderClientTree(
              // 组内端点
              group.endpoints,
              // 方法类型 = Operation<E>
              (endpoint) => `${groupShapeTypeName(group, endpoint)}<E>`,
              // 字段渲染
              (name, value) => `readonly ${JSON.stringify(name)}: ${value}`,
              // 换行分隔
              "\n",
            ),
          // 字段对象结束
          }
        // 非顶层分组：整体引用分组接口
        : { whole: `${groupShapeName(group)}<E>` },
    // 字段渲染回调
    (name, value) => `readonly ${JSON.stringify(name)}: ${value}`,
    // 合并回调：whole 与 fields 用交叉类型 & 连接（fields 包成对象字面量）
    (wholes, fields) => [...wholes, ...(fields.length === 0 ? [] : [`{\n${fields.join("\n")}\n}`])].join(" & "),
    // 换行分隔
    "\n",
  )
  // 渲染根层别名（无挂靠分组的别名直接作为 AppApi 字段）
  const rootAliasFields = renderClientTree(
    // 端点列表为空（leaf 永不调用）
    [],
    // leaf 返回空串
    () => "",
    // 字段渲染
    (name, value) => `readonly ${JSON.stringify(name)}: ${value}`,
    // 换行
    "\n",
    // 传入根别名
    rootAliases,
  )
  // 拼装最终 api.ts：生成标记 + import + 类型/别名 + AppApi 接口
  return `// Generated by @opencode/httpapi-codegen. Do not edit.
// effect 基础导入
import type { Effect, Stream } from "effect"
// 追加收集到的外部类型导入
${[...imports].join("\n")}

// 端点类型 + 别名类型
${[...endpointTypes, ...renderedAliasTypes].join("\n\n")}

// AppApi 接口：客户端总入口
export interface AppApi<E = never> {
// 字段 = 分组字段 + 根别名
${[clientFields, rootAliasFields].filter(Boolean).join("\n")}
}
`
}

// effectTypeReferences：把外部类型引用整理成 names（按名）与 asts（按 AST）两个索引
function effectTypeReferences(input: ReadonlyArray<EffectTypeReference>) {
  // 名字 → 引用
  const names = new Map<string, ResolvedEffectTypeReference>()
  // AST → 引用
  const asts = new Map<SchemaAST.AST, ResolvedEffectTypeReference>()
  // 逐个处理引用
  for (const reference of input) {
    // 无 identifier 的 schema 无法按名引用，跳过
    if (SchemaAST.resolveIdentifier(reference.schema.ast) === undefined) continue
    // 投影为解码侧类型（取其 AST）
    const projected = Schema.toType(reference.schema)
    // 生成类型代码文档
    const document = SchemaRepresentation.toCodeDocument(
      // 基于 codegen 归一化后的 AST 生成表示
      SchemaRepresentation.toRepresentations([codegenAst(projected.ast)]),
    )
    // 取首个代码段里的类型名
    const name = document.codes[0]?.Type
    // 提取非递归引用的类型文本
    const type =
      // 按 $ref 找对应定义
      name === undefined ? undefined : document.references.nonRecursives.find((item) => item.$ref === name)?.code.Type
    // 组装引用记录
    const value = { name: reference.name, import: reference.import, ast: reference.schema.ast, type }
    // 以原始 AST 为键登记
    asts.set(reference.schema.ast, value)
    // 以投影 AST 为键登记（两种形态都能命中）
    asts.set(projected.ast, value)
    // 名字非法或类型缺失则只登记 AST 索引
    if (name === undefined || type === undefined || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) continue
    // 同名引用查重
    const previous = names.get(name)
    // 已有同名
    if (previous !== undefined) {
      // AST 不同 → 真冲突
      if (previous.ast !== reference.schema.ast) {
        // 抛出引用冲突
        throw new GenerationError({ reason: `Conflicting Effect type reference: ${name}` })
      }
      // AST 相同 → 视为重复输入，跳过
      continue
    }
    // 登记名字索引
    names.set(name, value)
  }
  // 返回两个索引
  return { names, asts }
}

// effectType：把 schema 渲染成 TS 类型文本（优先命中外部引用，否则内联展开）
function effectType(schema: Schema.Top, references: ReturnType<typeof effectTypeReferences>, imports: Set<string>) {
  // 投影为解码侧类型
  const projected = Schema.toType(schema)
  // 先查 AST 索引（原始或投影形态）
  const direct = references.asts.get(schema.ast) ?? references.asts.get(projected.ast)
  // 命中外部引用：登记导入并直接用其名字
  if (direct !== undefined) {
    // 登记导入来源
    imports.add(direct.import)
    // 返回引用名
    return direct.name
  }
  // 未命中：生成类型代码文档
  const document = SchemaRepresentation.toCodeDocument(
    // 生成表示
    SchemaRepresentation.toRepresentations([codegenAst(projected.ast)]),
  )
  // 非递归引用 → 类型文本映射
  const source = new Map(document.references.nonRecursives.map((reference) => [reference.$ref, reference.code.Type]))
  // expand：把文档里的中间引用名替换为真实类型（或外部引用名）
  const expand = (type: string, seen = new Set<string>()): string => {
    // 逐个引用名处理
    for (const [name, value] of source) {
      // 构造词边界的替换正则
      const pattern = new RegExp(
        // 转义正则特殊字符；前后断言避免误替换子串
        `(?<![A-Za-z0-9_$.'\"])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_$.'\"])`,
        "g",
      )
      // 类型文本中不含该名则跳过
      if (!pattern.test(type)) continue
      // Optional/encoded occurrences can acquire a numeric suffix. Reuse the named
      // type only when its definition matches; a suffix can also denote a different shape.
      // 带数字后缀的候选：先去掉后缀查引用
      const candidate = references.names.get(name.replace(/_\d+$/, ""))
      // 无后缀命中优先；有后缀时仅当类型定义等价才复用（后缀也可能是不同形态）
      const reference = references.names.get(name) ?? (candidate?.type === value ? candidate : undefined)
      // 命中外部引用
      if (reference !== undefined) {
        // 登记导入
        imports.add(reference.import)
        // 替换为引用名
        type = type.replace(pattern, reference.name)
        // 无外部引用可复用
        continue
      }
      // 递归展开中跳过已见引用（防环）
      if (seen.has(name)) continue
      // 用内联展开文本替换
      type = type.replace(pattern, `(${expand(value, new Set([...seen, name]))})`)
    }
    // 返回展开后的类型
    return type
  }
  // 从顶层类型开始展开
  const type = expand(document.codes[0].Type)
  // 类型里用到 DateTime/Schema 时补对应导入
  if (type.includes("DateTime.")) imports.add('import type { DateTime } from "effect"')
  // 补 Schema 导入
  if (type.includes("Schema.")) imports.add('import type { Schema } from "effect"')
  // 返回最终类型文本
  return type
}

// effectInputSchema：取端点某输入字段的 schema（从 params/query/headers/payload 挖子属性）
function effectInputSchema(endpoint: Endpoint, field: InputField): Schema.Top | undefined {
  // 按来源选择 schema
  const schema =
    // 路径参数
    field.source === "params"
      // 查询
      ? endpoint.params
      // 请求头
      : field.source === "query"
        // 请求体（第一个）
        ? endpoint.query
        : field.source === "headers"
          ? endpoint.headers
          : endpoint.payloads[0]
  // 无对应 schema 返回 undefined
  if (schema === undefined) return undefined
  // 不透明 payload 直接整体作为字段类型（不挖子属性）
  if (isOpaquePayload(endpoint) && field.source === "payload") return schema
  // 投影为解码侧 AST
  const ast = Schema.toType(schema).ast
  // 非对象类型没有属性可挖
  if (!SchemaAST.isObjects(ast)) return undefined
  // 找同名字段
  const property = ast.propertySignatures.find((property) => property.name === field.name)
  // 无该字段返回 undefined；有则把属性类型包成独立 schema
  return property === undefined ? undefined : Schema.make<Schema.Top>(property.type)
}

// effectOutputSchema：计算端点输出 schema（处理流/204/信封解包）
function effectOutputSchema(endpoint: Endpoint): Schema.Top | undefined {
  // 取成功 schema
  const schema = endpoint.successes[0]
  // 204 无内容 → 无输出类型
  if (HttpApiSchema.isNoContent(schema.ast)) return undefined
  // 流响应
  if (isStreamSchema(schema)) {
    // 二进制流 → Uint8Array
    if (schema._tag === "StreamUint8Array") return Schema.Uint8Array
    // data 模式取 data 载荷，events 模式取事件联合
    return schema.sseMode === "data" ? streamDataSchema(schema) : Schema.make<Schema.Top>(schema.events.ast)
  }
  // 非信封响应原样返回
  if (!endpoint.unwrapData) return schema
  // 投影 AST
  const ast = Schema.toType(schema).ast
  // 非对象无法解包
  if (!SchemaAST.isObjects(ast)) return undefined
  // 取 data 属性
  const data = ast.propertySignatures.find((property) => property.name === "data")
  // 返回 data 子 schema
  return data === undefined ? undefined : Schema.make<Schema.Top>(data.type)
}

// 分组接口名：标识符 PascalCase + Api
function groupShapeName(group: Group) {
  // 生成 XxxApi
  return `${identifierPart(group.identifier)}Api`
}

// Generated symbol names derive from group and endpoint identity, never from traversal
// position, so adding an endpoint or group cannot rename unrelated generated code.
// Uniqueness is validated by compile (groupTypeNames/endpointTypeNames).
// 分组类型名（PascalCase 片段）；名字由分组/端点标识推导、与遍历顺序无关，唯一性由 compile 校验
function groupTypeName(group: Group) {
  // 转换
  return identifierPart(group.identifier)
}

// 端点类型名：分组类型名 + 客户端路径各段拼接
function endpointTypeName(group: Group, endpoint: Endpoint) {
  // 拼接
  return `${groupTypeName(group)}${endpoint.clientPath.map(identifierPart).join("")}`
}

// 端点适配器变量名（运行时客户端里每端点一个）
function endpointAdapterName(group: Group, endpoint: Endpoint) {
  // Endpoint 前缀
  return `Endpoint${endpointTypeName(group, endpoint)}`
}

// 端点操作类型名（Operation 后缀）
function groupShapeTypeName(group: Group, endpoint: Endpoint) {
  // 拼 Operation
  return `${endpointTypeName(group, endpoint)}Operation`
}

// assertPromiseEndpoint：校验端点满足 Promise 客户端的限制（编码/流/错误形态）
function assertPromiseEndpoint(endpoint: Endpoint) {
  // 端点全名（错误信息用）
  const name = `${endpoint.group}.${endpoint.endpoint.identifier}`
  // 取请求体 schema
  const payload = endpoint.payloads[0]
  // 推断请求体编码
  const payloadEncoding =
    // 无 payload 时编码为 undefined
    payload === undefined
      // 从注解解析编码标签
      ? undefined
      // 回退：按方法是否有请求体推断 Json/FormUrlEncoded
      : (resolveHttpApiEncoding(payload.ast)?._tag ??
        (HttpMethod.hasBody(endpoint.endpoint.method) ? "Json" : "FormUrlEncoded"))
  // Promise 客户端只支持 Json 与二进制编码的请求体
  if (payloadEncoding !== undefined && payloadEncoding !== "Json" && payloadEncoding !== "Uint8Array") {
    // 抛出不支持的编码
    throw new GenerationError({ reason: `Unsupported Promise payload encoding: ${name}` })
  }
  // 校验成功响应
  const success = endpoint.successes[0]
  // 流响应仅支持 SSE data 模式且错误为 Never
  if (isStreamSchema(success)) {
    // 条件判断：
    if (
      // 必须是 StreamSse
      success._tag !== "StreamSse" ||
      // 必须是 data 模式
      success.sseMode !== "data" ||
      // 错误必须是 Never
      !SchemaAST.isNever(Schema.toType(success.error).ast)
    // 条件不满足
    ) {
      // 抛出不支持的流
      throw new GenerationError({ reason: `Unsupported Promise stream: ${name}` })
    }
  // 非流响应：编码必须是 Json 或二进制
  } else if (!HttpApiSchema.isNoContent(success.ast)) {
    // 解析编码（默认 Json）
    const encoding = resolveHttpApiEncoding(success.ast)?._tag ?? "Json"
    // 不合法则报错
    if (encoding !== "Json" && encoding !== "Uint8Array") {
      // 抛出不支持的编码
      throw new GenerationError({ reason: `Unsupported Promise success encoding: ${name}` })
    }
  }
  // 校验错误声明
  for (const error of endpoint.errors) {
    // 错误必须有字面量判别字段（_tag/name）供客户端收窄
    if (declaredErrorFields(error.schema) === undefined) {
      // 抛出缺判别字段错误
      throw new GenerationError({ reason: `Promise error must have a literal discriminator: ${name}` })
    }
    // 错误编码必须是 Json
    if ((resolveHttpApiEncoding(error.schema.ast)?._tag ?? "Json") !== "Json") {
      // 抛出不支持的错误编码
      throw new GenerationError({ reason: `Unsupported Promise error encoding: ${name}` })
    }
  }
}

// operations：摊平全部操作元信息
function operations(groups: ReadonlyArray<Group>) {
  // 逐分组逐端点取 operation
  return groups.flatMap((group) => group.endpoints.map((endpoint) => endpoint.operation))
}

// promiseOperations：Promise 版操作元信息（输入按 Promise 规则重算，含通配符）
function promiseOperations(groups: ReadonlyArray<Group>) {
  // 逐分组展开
  return groups.flatMap((group) =>
    // 逐端点改写
    group.endpoints.map((endpoint) => ({
      // 保留其余字段
      ...endpoint.operation,
      // 输入字段换成 Promise 视角
      input: promiseInput(endpoint).map(({ name, source }) => ({ name, source })),
      // 输入模式按 Promise 规则重算
      inputMode: promiseInputMode(endpoint),
    })),
  )
}

// renderEffectFiles：渲染内联 Effect 客户端的全部文件
function renderEffectFiles(groups: ReadonlyArray<Group>, aliases: ReadonlyArray<Alias>): Output["files"] {
  // 每个分组一个模块文件
  return [
    // 分组文件：路径 = 模块名
    ...groups.map((group) => ({ path: `${group.module}.ts`, content: renderGroup(group) })),
    // client-error.ts：Schema 化的 ClientError
    {
      // 文件路径：client-error.ts
      path: "client-error.ts",
      // 内容（固定模板）
      content:
        'import { Schema } from "effect"\n\nexport class ClientError extends Schema.TaggedError<ClientError>()("ClientError", {\n  cause: Schema.Defect(),\n}) {}\n',
    },
    // client.ts：客户端实现
    { path: "client.ts", content: renderClient(groups, aliases) },
    // index.ts：出口
    {
      // 文件路径：index.ts
      path: "index.ts",
      content: 'export { ClientError } from "./client-error.js"\nexport * as OpenCode from "./client.js"\n',
    },
  ]
}

// renderImportedEffectFiles：渲染"引用既有契约"的适配层客户端文件
function renderImportedEffectFiles(
  // 全部分组
  groups: ReadonlyArray<Group>,
  // 别名
  aliases: ReadonlyArray<Alias>,
  // 选项（api / group / endpoints 三种引用方式）
  options:
    // 方式一：引用整个 Api
    | { readonly module: string; readonly api: string; readonly shapeModule?: string }
    // 方式二：引用单个分组
    | { readonly module: string; readonly group: string; readonly shapeModule?: string }
    | {
        // 方式三：端点映射
        readonly module: string
        readonly endpoints: Readonly<Record<string, string>>
        readonly shapeModule?: string
      },
// 返回文件列表
): Output["files"] {
  // An imported Api or group keeps its source group names; a projection rebuilds groups under their client names.
  // 引用整个 Api 或分组时沿用源分组名；按端点投影时用客户端名重建分组键
  const rawKey = (group: Group) => JSON.stringify("endpoints" in options ? group.identifier : group.sourceIdentifier)
  // 逐分组生成适配方法
  const adapters = groups.map((group) => {
    // 顶层分组用整个 RawClient，否则取对应分组键
    const rawGroup = group.endpoints[0]?.topLevel ? "RawClient" : `RawClient[${rawKey(group)}]`
    // 逐端点生成适配器
    const methods = group.endpoints.map((item) => {
      // 类型名前缀
      const prefix = endpointTypeName(group, item)
      // 适配器变量名
      const adapter = endpointAdapterName(group, item)
      // 各来源 schema（存在性判断用）
      const schemaBySource = {
        // params
        params: item.params,
        // query
        query: item.query,
        // headers
        headers: item.headers,
        // payload
        payload: item.payloads[0],
      }
      // 生成对 raw 客户端的实参（params/query/headers/payload 四段）
      const request = (["params", "query", "headers", "payload"] as const)
        // 逐来源渲染
        .map((source) =>
          // 传入输入字段与模式
          renderEffectRequestPart(
            // 是否不透明 payload
            item.input,
            // 该来源 schema 是否存在
            item.operation.inputMode,
            // 过滤掉无内容的来源段
            source,
            // 逗号拼接
            isOpaquePayload(item),
            schemaBySource[source] !== undefined,
          ),
        )
        .filter((part): part is string => part !== undefined)
        .join(", ")
      // 生成适配器的输入类型（从 Request 类型按来源+字段索引）
      const input = item.input
        // 逐字段
        .map(
          // 字段类型 = Request[source][name]（不透明 payload 直接用 Request[source]）
          (field) =>
            // 分号拼接
            `readonly ${JSON.stringify(field.name)}${field.optional ? "?" : ""}: ${prefix}Request[${JSON.stringify(field.source)}]${isOpaquePayload(item) && field.source === "payload" ? "" : `[${JSON.stringify(field.name)}]`}`,
        )
        .join("; ")
      // 生成适配器的入参签名
      const argument =
        // 无输入端点无参
        item.operation.inputMode === "none"
          // 可选输入加 ?
          ? ""
          : `input${item.operation.inputMode === "optional" ? "?" : ""}: ${prefix}Input`
      // HttpApiClient distributes union payloads into union request objects, while rebuilding a flattened input
      // produces one object containing a union value. The shapes are equivalent but TypeScript cannot correlate them.
      // 不透明 payload 断言为 Request 形状后调用 raw 客户端
      const rawCall = `raw[${JSON.stringify(item.endpoint.identifier)}]({ ${request} }${isOpaquePayload(item) ? ` as ${prefix}Request` : ""})`
      // 映射错误（并按需解包 data 信封）
      const mapped = `${rawCall}.pipe(Effect.mapError(mapClientError)${item.unwrapData ? ", Effect.map((value) => value.data)" : ""})`
      // 流成功响应要走 Stream.unwrap 包装
      const result =
        // 流分支
        item.operation.success === "stream"
          // 把 Effect<Stream> 展开成 Stream，并把错误映射为 ClientError
          ? `Stream.unwrap(${rawCall}.pipe(Effect.mapError(mapClientError), Effect.map((stream) => stream.pipe(Stream.mapError(mapClientError)))))`
          // 非流用映射后的结果
          : mapped
      // 输出形态保持：有 shape 模块时用 preserve 工具做编译期等价校验
      const output =
        // 无 shape 模块直接用结果
        options.shapeModule === undefined
          // 用 preserveEffect/preserveStream 保证生成输出与契约一致
          ? result
          : `${item.operation.success === "stream" ? "preserveStream" : "preserveEffect"}<${prefix}Output>()(${result})`
      // 无 shape 模块且需要输入时，声明 Request/Input 类型
      const declarations =
        // 从 raw 分组方法的参数推导 Request
        options.shapeModule === undefined && item.operation.inputMode !== "none"
          // 不透明 payload 也需要 Request 类型
          ? `type ${prefix}Request = Parameters<${rawGroup}[${JSON.stringify(item.endpoint.identifier)}]>[0]\ntype ${prefix}Input = { ${input} }\n`
          // 其余情况无需声明
          : isOpaquePayload(item)
            ? `type ${prefix}Request = Parameters<${rawGroup}[${JSON.stringify(item.endpoint.identifier)}]>[0]\n`
            : ""
      // 拼装适配器：类型声明 + 工厂函数
      return `${declarations}const ${adapter} = (raw: ${rawGroup}) => (${argument}) => ${output}`
    })
    // 渲染组内方法字段（值 = 适配器调用）
    const fields = renderClientTree(
      // 每个端点 → EndpointXxx(raw)
      group.endpoints,
      // 字段渲染
      (item) => `${endpointAdapterName(group, item)}(raw)`,
      // 逗号分隔
      (name, value) => `${JSON.stringify(name)}: ${value}`,
      ", ",
    )
    // 分组适配器工厂
    return `${methods.join("\n\n")}\n\nconst adaptGroup${groupTypeName(group)} = (raw: ${rawGroup}) => ({ ${fields} })`
  })
  // 渲染客户端根字段（分组如何聚合）
  const fields = renderGroupTree(
    // 对每个分组：
    groups,
    // 顶层分组摊开
    (group) =>
      // 摊开适配器结果
      group.endpoints[0]?.topLevel
        // 非顶层分组整体调用适配器（按 rawKey 取 raw）
        ? { fields: `...adaptGroup${groupTypeName(group)}(raw)` }
        // 字段渲染
        : { whole: `adaptGroup${groupTypeName(group)}(raw[${rawKey(group)}])` },
    // 用展开合并
    (name, value) => `${JSON.stringify(name)}: ${value}`,
    // 逗号分隔
    spreadObject,
    ", ",
  )
  // 是否有流端点（决定是否导入 Stream）
  const usesStream = groups.some((group) => group.endpoints.some((item) => item.operation.success === "stream"))
  // 是否为整 Api 引用方式
  const imported = "api" in options
  // 非整 Api 引用时构建投影（重建 HttpApi 声明）
  const projection = imported
    // group 方式：引用单个分组
    ? undefined
    // endpoints 方式：按映射重建
    : "group" in options
      // 整 Api 引用直接用传入的 api 名
      ? renderImportedGroup(options.group)
      : renderImportedProjection(groups, options.endpoints)
  // 默认叫 Api
  const api = imported ? options.api : "Api"
  // 全部适配器变量名集合
  const adapterNames = new Set(
    // 收集
    groups.flatMap((group) => group.endpoints.map((endpoint) => endpointAdapterName(group, endpoint))),
  )
  // 投影导入名或 api 名与适配器名冲突则报错
  const adapterCollision = (projection?.imports ?? [api]).find((name) => adapterNames.has(name))
  // 检测到冲突
  if (adapterCollision !== undefined) {
    // 抛出适配器名与导入端点冲突
    throw new GenerationError({
      reason: `Generated Effect adapter collides with imported endpoint: ${adapterCollision}`,
    })
  }
  // 组装 import：无投影时只导入 api；有投影时导入 effect http-api 与投影名
  const imports =
    // 无投影分支
    projection === undefined
      // 有投影分支
      ? `import { ${api} } from ${JSON.stringify(options.module)}`
      // endpoints 方式还需要 HttpApiGroup
      : `import { HttpApi, HttpApiClient${"endpoints" in options ? ", HttpApiGroup" : ""} } from "effect/http-api"\nimport { ${projection.imports.join(", ")} } from ${JSON.stringify(options.module)}`
  // 无投影时还需 HttpApiClient
  const httpApiImport = projection === undefined ? 'import { HttpApiClient } from "effect/http-api"\n' : ""
  // shape 模块的类型导入列表（各端点 Input/Output）
  const shapeTypes = groups.flatMap((group) =>
    // 逐端点收集
    group.endpoints.flatMap((endpoint) => [
      // 无输入端点无 Input
      ...(endpoint.operation.inputMode === "none" ? [] : [`${endpointTypeName(group, endpoint)}Input`]),
      // Output
      `${endpointTypeName(group, endpoint)}Output`,
    ]),
  )
  // shape 模块导入语句
  const shapeImport =
    // 未启用 shape 模块则无导入
    options.shapeModule === undefined
      // 生成 type 导入
      ? ""
      : `import type { ${shapeTypes.join(", ")} } from ${JSON.stringify(options.shapeModule)}\n`
  // preserve 工具：编译期校验生成输出与契约类型等价（多出字段会报错）
  const preserve =
    // 未启用 shape 模块则不需要
    options.shapeModule === undefined
      // preserveEffect 定义；有流端点时追加 preserveStream
      ? ""
      : `const preserveEffect = <A>() => <Actual extends A, E, R>(effect: Effect.Effect<Actual, E, R> & ([A] extends [Actual] ? unknown : { readonly __generatedOutputWiderThanContract: [expected: Actual, generated: A] })): Effect.Effect<A, E, R> => effect\n${usesStream ? "const preserveStream = <A>() => <Actual extends A, E, R>(stream: Stream.Stream<Actual, E, R> & ([A] extends [Actual] ? unknown : { readonly __generatedOutputWiderThanContract: [expected: Actual, generated: A] })): Stream.Stream<A, E, R> => stream\n" : ""}\n`
  // 拼装 client.ts 全文（导入/错误映射/适配器/客户端工厂）
  const client = `// Generated by @opencode/httpapi-codegen. Do not edit.\nimport { Effect${usesStream ? ", Stream" : ""}, Schema } from "effect"\nimport { Sse } from "effect/encoding"\nimport { HttpClientError } from "effect/http"\n${httpApiImport}${imports}\n${shapeImport}import { ClientError } from "./client-error.js"\n\n${projection?.source ?? ""}type RawClient = HttpApiClient.ForApi<typeof ${api}>\n\nconst mapClientError = <E>(error: E) => HttpClientError.isHttpClientError(error) || Schema.isSchemaError(error) || Sse.Retry.is(error) ? new ClientError({ cause: error }) : error\n\n${preserve}${adapters.join("\n\n")}\n\nconst adaptClient = ${aliases.length === 0 ? `(raw: RawClient) => ({ ${fields} })` : `(raw: RawClient) => {\n  const client = { ${fields} }\n  return ${renderAliasedClient(groups, aliases, "client")}\n}`}\n\nexport const make = (options?: { readonly baseUrl?: URL | string }) => HttpApiClient.make(${api}, options).pipe(Effect.map(adaptClient))\n`
  // 返回三个文件
  return [
    // client-error.ts
    {
      path: "client-error.ts",
      // 内容（固定模板）
      content:
        'import { Schema } from "effect"\n\nexport class ClientError extends Schema.TaggedError<ClientError>()("ClientError", {\n  cause: Schema.Defect(),\n}) {}\n',
    },
    // client.ts
    { path: "client.ts", content: client },
    // 内容 = 拼装好的 client
    {
      // index.ts
      path: "index.ts",
      // 出口内容
      content: 'export { ClientError } from "./client-error.js"\nexport * as OpenCode from "./client.js"\n',
    },
  ]
}

// renderImportedGroup：引用单个既有分组（导入变量并包成 Api）
function renderImportedGroup(group: string) {
  // 返回导入与源码片段
  return {
    // 导入该分组变量
    imports: [group],
    // 用 HttpApi.make 包裹该分组
    source: `const Api = HttpApi.make("generated").add(${group})\n\n`,
  }
}

// renderImportedProjection：按端点映射重建 HttpApi 声明（导入各端点变量）
function renderImportedProjection(groups: ReadonlyArray<Group>, endpoints: Readonly<Record<string, string>>) {
  // 逐分组逐端点解析导入名
  const imports = groups.flatMap((group) =>
    // 逐端点
    group.endpoints.map((endpoint) => {
      // 查映射表（分组.端点 → 变量名）
      const name = endpoints[`${group.identifier}.${endpoint.endpoint.identifier}`]
      // 缺映射即报错
      if (name === undefined) {
        // 抛出缺失端点错误
        throw new GenerationError({
          reason: `Missing imported endpoint: ${group.identifier}.${endpoint.endpoint.identifier}`,
        })
      }
      // 返回变量名
      return name
    }),
  )
  // 重建 HttpApi 源码：make + 逐分组 add
  const source = `const Api = HttpApi.make("generated").${groups
    .map((group) => {
      // 顶层分组加 topLevel 选项
      const options = group.endpoints[0]?.topLevel ? ", { topLevel: true }" : ""
      // 生成 add 链（组内端点逐个 add）
      return `add(HttpApiGroup.make(${JSON.stringify(group.identifier)}${options})${group.endpoints.map((endpoint) => `.add(${endpoints[`${group.identifier}.${endpoint.endpoint.identifier}`]})`).join("")})`
    })
    // join 成一条链
    .join(".")}\n\n`
  // 返回导入名与源码
  return { imports: [...new Set(imports)], source }
}

// renderPromiseTypes：渲染 Promise 客户端的 types.ts 全文
function renderPromiseTypes(
  // 全部分组
  groups: ReadonlyArray<Group>,
  // 输出类型覆盖
  outputTypes?: Readonly<Record<string, { readonly name: string; readonly import: string }>>,
  // 可变输出开关
  mutableOutputs = false,
  // 别名列表
  aliases: ReadonlyArray<Alias> = [],
) {
  // 类型文本缓存（按 AST）
  const types = new Map<SchemaAST.AST, string>()
  // typeOf：schema → TS 类型文本（可解码侧或编码侧）
  const typeOf = (schema: Schema.Top, decoded = false) => {
    // 按需投影
    const projected = decoded ? Schema.toType(schema) : Schema.toEncoded(schema)
    // 命中缓存直接返回
    const cached = types.get(projected.ast)
    // 缓存命中
    if (cached !== undefined) return cached
    // 计算结构化类型文本
    const type = structuralType(projected)
    // 写缓存
    types.set(projected.ast, type)
    // 返回
    return type
  }
  // fieldTypeOf：取对象 schema 中某字段的类型（处理可选 undefined 语义）
  const fieldTypeOf = (schema: Schema.Top, name: string, decoded: boolean) => {
    // 取 AST 并找属性签名
    const ast = (decoded ? Schema.toType(schema) : Schema.toEncoded(schema)).ast
    // 判断是否对象
    const property = SchemaAST.isObjects(ast)
      // 找同名字段
      ? ast.propertySignatures.find((property) => property.name === name)
      // 非对象或无字段时用索引访问类型兜底
      : undefined
    // 用索引访问
    if (property === undefined) return `(${typeOf(schema, decoded)})[${JSON.stringify(name)}]`
    // 把属性类型包成 schema
    const type = Schema.make<Schema.Top>(property.type)
    // Indexing an optional property includes undefined, so keep it when the field schema omits it.
    // 属性非可选或本身含 undefined → 直接用其类型
    if (!SchemaAST.isOptional(property.type) || includesUndefined(property.type)) return typeOf(type)
    // 可选属性补上 undefined 联合，与索引访问语义保持一致
    return typeOf(Schema.UndefinedOr(type))
  }
  // 输出类型占位标记（先占位，最后统一替换成具体类型文本）
  const outputMarkers = new Map<SchemaAST.AST, string>()
  // 收集到的输出 schema
  const outputSchemas: Array<Schema.Top> = []
  // outputTypeOf：为输出 schema 分配占位标记
  const outputTypeOf = (schema: Schema.Top) => {
    // 投影为编码侧
    const projected = Schema.toEncoded(schema)
    // 同一 AST 复用同一标记
    const cached = outputMarkers.get(projected.ast)
    // 命中缓存
    if (cached !== undefined) return cached
    // 生成本次标记（含序号）
    const marker = `__PROMISE_TYPE_${outputSchemas.length}__`
    // 登记 schema
    outputSchemas.push(projected)
    // 记录标记
    outputMarkers.set(projected.ast, marker)
    // 返回标记
    return marker
  }
  // 汇总全部错误类型（按判别标签去重）
  const errors = new Map(
    // 遍历分组端点
    groups.flatMap((group) =>
      // 遍历端点错误
      group.endpoints.flatMap((endpoint) =>
        // 遍历端点的错误
        endpoint.errors.flatMap((error) => {
          // 提取带判别字段的错误信息
          const tagged = declaredErrorFields(error.schema)
          // 无法提取的跳过；按标签建映射
          return tagged === undefined ? [] : [[tagged.tag, tagged] as const]
        }),
      ),
    ),
  )
  // 产出类型声明 + 类型守卫函数
  const errorTypes = Array.from(errors.values()).map((error) => {
    // 渲染错误字段
    const fields = error.fields
      // readonly 字段拼接
      .map(([name, schema, optional]) => `readonly ${JSON.stringify(name)}${optional ? "?" : ""}: ${typeOf(schema)}`)
      .join("; ")
    // 类型 + isXxx 守卫（用 _tag 存在性与值判断收窄）
    return `export type ${error.identifier} = { readonly ${JSON.stringify(error.key)}: ${JSON.stringify(error.tag)}; ${fields} }\nexport const is${error.identifier} = (value: unknown): value is ${error.identifier} => typeof value === "object" && value !== null && ${JSON.stringify(error.key)} in value && value[${JSON.stringify(error.key)}] === ${JSON.stringify(error.tag)}`
  })
  // 渲染各端点的 Input/Output 类型
  const operations = groups
    // 遍历分组端点
    .flatMap((group) =>
      // 逐端点
      group.endpoints.flatMap((endpoint) => {
        // 类型名前缀
        const prefix = promiseTypePrefix(group.identifier, endpoint.clientPath)
        // 各来源 schema
        const schemas = {
          // params
          params: endpoint.params,
          // query
          query: endpoint.query,
          // headers
          headers: endpoint.headers,
          // payload
          payload: endpoint.payloads[0],
        }
        // Promise 输入字段（含通配符）
        const input = promiseInput(endpoint)
          // 逐字段渲染
          .map((field) => {
            // 通配符字段是 string 路径
            if (field.source === "wildcard") return `readonly ${JSON.stringify(field.name)}: string`
            // 取对应来源 schema
            const schema = schemas[field.source]
            // 缺 schema 报错
            if (schema === undefined)
              // 抛出缺失输入 schema
              throw new GenerationError({ reason: `Missing input schema: ${prefix}.${field.name}` })
            // 渲染字段（不透明 payload 用整体类型；query 用解码侧字段类型）
            return `readonly ${JSON.stringify(field.name)}${field.optional ? "?" : ""}: ${isOpaquePayload(endpoint) && field.source === "payload" ? typeOf(schema) : fieldTypeOf(schema, field.name, field.source === "query")}`
          })
          // 分号拼接
          .join("; ")
        // 成功 schema
        const successSchema = endpoint.successes[0]
        // 输出类型：覆盖优先，其次按流模式取类型
        const success =
          // 查覆盖
          outputTypes?.[clientOperationKey(group, endpoint)]?.name ??
          // 无覆盖时分配占位标记
          outputTypeOf(
            // SSE 流
            isStreamSchema(successSchema) && successSchema._tag === "StreamSse"
              // data 模式取编码侧 data
              ? successSchema.sseMode === "data"
                // events 模式取事件联合
                ? streamEncodedDataSchema(successSchema)
                // 普通响应用原 schema
                : Schema.make<Schema.Top>(successSchema.events.ast)
              : successSchema,
          )
        // 产出 Input/Output 两条
        return [
          // 无输入端点无 Input
          ...(promiseInputMode(endpoint) === "none" ? [] : [`export type ${prefix}Input = { ${input} }`]),
          // Output：信封响应用 ["data"] 索引解包
          `export type ${prefix}Output = ${endpoint.unwrapData ? `(${success})["data"]` : success}`,
        ]
      }),
    )
    .join("\n\n")
  // 保留名集合：ClientError/JsonValue/错误名/各端点 InputOutput/覆盖名
  const reservedNames = new Set([
    // 保留字
    "ClientError",
    "JsonValue",
    // 错误类型名
    ...errors.keys(),
    // 各端点类型名
    ...groups.flatMap((group) =>
      group.endpoints.flatMap((endpoint) => {
        // 前缀
        const prefix = promiseTypePrefix(group.identifier, endpoint.clientPath)
        // Input/Output
        return [`${prefix}Input`, `${prefix}Output`]
      }),
    ),
    // 覆盖类型名
    ...Object.values(outputTypes ?? {}).map((output) => output.name),
  ])
  // 别名类型对：旧前缀 → 新前缀（Input/Output）
  const aliasTypes = aliases.flatMap((alias) => {
    // 旧类型前缀
    const from = promiseTypePrefix(alias.fromGroup, alias.endpoint.clientPath)
    // 新类型前缀
    const to = promiseTypePrefix(alias.group.identifier, alias.endpoint.clientPath)
    // Input/Output 后缀各一条
    return [...(promiseInputMode(alias.endpoint) === "none" ? [] : ["Input"]), "Output"].map(
      (suffix) => [`${from}${suffix}`, `${to}${suffix}`] as const,
    )
  })
  // 别名类型名查重
  for (const [name] of aliasTypes) {
    // 冲突报错
    if (reservedNames.has(name)) throw new GenerationError({ reason: `Client type alias collision: ${name}` })
    // 登记
    reservedNames.add(name)
  }
  // 渲染全部输出 schema 的结构化类型与定义
  const rendered = structuralTypes(outputSchemas, mutableOutputs, reservedNames)
  // resolve：把占位标记替换为真实类型文本
  const resolve = (source: string) =>
    // 逐个标记替换
    rendered.types.reduce((result, type, index) => result.replaceAll(`__PROMISE_TYPE_${index}__`, type), source)
  // 错误类型文本解析
  const resolvedErrors = errorTypes.map(resolve)
  // 操作类型文本解析
  const resolvedOperations = resolve(operations)
  // 判断是否需要 JsonValue 定义
  const json = [...rendered.definitions, ...resolvedErrors, resolvedOperations].some((type) =>
    // 任一处引用即需要
    type.includes("JsonValue"),
  )
    // 输出 JsonValue 定义（可变模式用可变形态）
    ? `export type JsonValue = null | boolean | number | string | ${mutableOutputs ? "Array<JsonValue> | { [key: string]: JsonValue }" : "ReadonlyArray<JsonValue> | { readonly [key: string]: JsonValue }"}`
    : ""
  // 覆盖类型的导入语句（去重）
  const imports = [...new Set(Object.values(outputTypes ?? {}).map((override) => override.import))]
  // 渲染别名声明
  const resolvedAliases = aliasTypes
    // 带废弃文档的类型别名
    .map(([from, to]) => `${deprecatedTypeAliasDoc(to)}\nexport type ${from} = ${to}`)
    .join("\n\n")
  // 拼装全文：导入 + JsonValue + 定义 + 错误 + 操作 + 别名
  return [...imports, json, ...rendered.definitions, ...resolvedErrors, resolvedOperations, resolvedAliases]
    // 过滤空段
    .filter(Boolean)
    // 空行连接
    .join("\n\n")
}

// mutableType：把 readonly/ReadonlyArray 替换为可变形态
function mutableType(type: string) {
  // 数组与属性修饰符都去掉
  return type.replaceAll("ReadonlyArray<", "Array<").replaceAll(/\breadonly\s+/g, "")
}

// renderPromiseClient：渲染 Promise 客户端 client.ts 全文
function renderPromiseClient(groups: ReadonlyArray<Group>, aliases: ReadonlyArray<Alias> = []) {
  // 需要的类型导入
  const imports = groups.flatMap((group) =>
    // 遍历端点
    group.endpoints.flatMap((endpoint) => {
      // 类型前缀
      const prefix = promiseTypePrefix(group.identifier, endpoint.clientPath)
      // 有输入端点加 Input 类型
      return [...(promiseInputMode(endpoint) === "none" ? [] : [`${prefix}Input`]), `${prefix}Output`]
    }),
  )
  // 逐分组
  const groupFields = new Map<Group, string>()
  // 渲染组内方法
  for (const group of groups) {
    // 逐端点
    const methods = group.endpoints.map((endpoint) => {
      // 类型前缀
      const prefix = promiseTypePrefix(group.identifier, endpoint.clientPath)
      // 输入模式
      const inputMode = promiseInputMode(endpoint)
      // 方法签名：无输入只有 requestOptions；有输入则 input + requestOptions
      const argument =
        // 无输入
        inputMode === "none"
          // 仅选项参数
          ? "requestOptions?: RequestOptions"
          // 有输入（可选模式加 ?）
          : `input${inputMode === "optional" ? "?" : ""}: ${prefix}Input, requestOptions?: RequestOptions`
      // 生成请求路径模板（参数插值 + 通配符）
      const path = promisePath(endpoint.endpoint.path, endpoint.input, promiseWildcardInput(endpoint))
      // 字段访问表达式（可选模式用 ?.）
      const access = (name: string) => `input${inputMode === "optional" ? "?." : ""}[${JSON.stringify(name)}]`
      // part：渲染某来源的请求段
      const part = (source: InputField["source"]) => {
        // 过滤该来源字段
        const inputs = endpoint.input.filter((field) => field.source === source)
        // 无字段：payload 存在时给空对象，否则省略该段
        return inputs.length === 0
          // payload 存在
          ? source === "payload" && endpoint.payloads.length > 0
            // 空对象
            ? "{ }"
            // 省略
            : undefined
          // 不透明 payload 直接传整个字段
          : isOpaquePayload(endpoint) && source === "payload"
            // 传字段值
            ? access(inputs[0].name)
            // 组装对象字面量
            : `{ ${inputs.map((field) => `${JSON.stringify(field.name)}: ${access(field.name)}`).join(", ")} }`
      }
      // 组装 descriptor 的可选段
      const parts = [
        // query
        endpoint.query === undefined ? undefined : `query: ${part("query")}`,
        // headers
        endpoint.headers === undefined ? undefined : `headers: ${part("headers")}`,
        // body
        endpoint.payloads.length === 0 ? undefined : `body: ${part("payload")}`,
      // 过滤省略段
      ].filter((value): value is string => value !== undefined)
      // 声明的错误状态码（去重）
      const declaredStatuses = [...new Set(endpoint.errors.map((error) => error.status))]
      // 请求描述符：方法/路径/各段/成功状态码/声明状态/空响应/二进制标记
      const descriptor = `{ method: ${JSON.stringify(endpoint.endpoint.method)}, path: ${path}${parts.length === 0 ? "" : `, ${parts.join(", ")}`}, successStatus: ${resolveHttpApiStatus(endpoint.successes[0].ast) ?? 200}, declaredStatuses: [${declaredStatuses.join(", ")}], empty: ${endpoint.operation.success === "void"}${isBinarySchema(endpoint.successes[0]) ? ", binary: true" : ""}${isBinaryPayload(endpoint) ? ", binaryBody: true" : ""} }`
      // 流端点走 sse 生成器
      if (endpoint.operation.success === "stream") {
        // 取成功 schema
        const success = endpoint.successes[0]
        // 再次校验必须是 SSE data 模式
        if (!isStreamSchema(success) || success._tag !== "StreamSse" || success.sseMode !== "data") {
          // 抛出未实现错误
          throw new GenerationError({
            reason: `Promise stream emission is not implemented: ${group.identifier}.${endpoint.endpoint.identifier}`,
          })
        }
        // 流方法返回 AsyncIterable（内部用 sse 解析）
        return `(${argument}): AsyncIterable<${prefix}Output> => sse<${prefix}Output>(${descriptor}, requestOptions)`
      }
      // 信封响应追加 .then 解包 data
      const unwrap = endpoint.unwrapData ? ".then((value) => value.data)" : ""
      // 普通方法：request<T> + 可选解包
      return `(${argument}) => request<${endpoint.unwrapData ? `{ readonly data: ${prefix}Output }` : `${prefix}Output`}>(${descriptor}, requestOptions)${unwrap}`
    })
    // 记录分组的方法字段
    groupFields.set(
      // 渲染客户端树
      group,
      // 端点 → 方法文本（按下标取）
      renderClientTree(
        // 字段渲染
        group.endpoints,
        // 逗号分隔
        (_endpoint, endpointIndex) => methods[endpointIndex],
        (name, value) => `${JSON.stringify(name)}: ${value}`,
        ", ",
      ),
    )
  }
  // 渲染根字段（分组聚合）
  const fields = renderGroupTree(
    // 每组用其方法字段
    groups,
    // 字段渲染
    (group) => ({ fields: groupFields.get(group)! }),
    // 展开合并
    (name, value) => `${JSON.stringify(name)}: ${value}`,
    // 逗号分隔
    spreadObject,
    ", ",
  )
  // 返回语句：有别名时构造 client 再包一层别名视图
  const returned =
    // 无别名直接返回对象
    aliases.length === 0
      // 返回对象
      ? `return { ${fields} }`
      // 有别名：先存 client 再渲染别名视图
      : `const client = { ${fields} }\n  return ${renderAliasedClient(groups, aliases, "client")}`
  // 客户端实现全文（模板：选项/描述符/prepare/execute/SSE 解析/工具函数，原样保留）
  return `import type { ${imports.join(", ")} } from "./types.js"\nimport { ClientError } from "./client-error.js"\n\nexport interface ClientOptions {\n  readonly baseUrl: string\n  readonly fetch?: typeof globalThis.fetch\n  readonly headers?: RequestInit["headers"]\n}\n\nexport interface RequestOptions {\n  readonly signal?: AbortSignal\n  readonly headers?: RequestInit["headers"]\n  /** Reports every chunk a streaming response receives, including keepalive comments that yield no event. */\n  readonly onActivity?: () => void\n}\n\ninterface RequestDescriptor {\n  readonly method: string\n  readonly path: string\n  readonly query?: Record<string, unknown>\n  readonly headers?: Record<string, unknown>\n  readonly body?: unknown\n  readonly successStatus: number\n  readonly declaredStatuses: ReadonlyArray<number>\n  readonly empty: boolean\n}\n\nconst maxSseEventBytes = 16 * 1024 * 1024\n\nexport function make(options: ClientOptions) {\n  const fetch = options.fetch ?? globalThis.fetch\n\n  const prepare = (descriptor: RequestDescriptor, requestOptions?: RequestOptions) => {\n    // A leading slash would replace any path prefix on baseUrl, so join relative to it.\n    const baseUrl = new URL(options.baseUrl)\n    if (!baseUrl.pathname.endsWith("/")) baseUrl.pathname += "/"\n    const url = new URL(descriptor.path.slice(1), baseUrl)\n    for (const [key, value] of Object.entries(descriptor.query ?? {})) appendQuery(url.searchParams, key, value)\n    const headers = new Headers(options.headers)\n    for (const [key, value] of Object.entries(descriptor.headers ?? {})) {\n      if (value !== undefined && value !== null) headers.set(key, String(value))\n    }\n    for (const [key, value] of new Headers(requestOptions?.headers)) headers.set(key, value)\n    if (descriptor.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json")\n    return {\n      url,\n      init: {\n        method: descriptor.method,\n        signal: requestOptions?.signal,\n        headers,\n        body: descriptor.body === undefined ? undefined : JSON.stringify(descriptor.body),\n      } satisfies RequestInit,\n    }\n  }\n\n  const execute = async (descriptor: RequestDescriptor, requestOptions?: RequestOptions) => {\n    try {\n      const prepared = prepare(descriptor, requestOptions)\n      return await fetch(prepared.url, prepared.init)\n    } catch (cause) {\n      throw new ClientError("Transport", { cause })\n    }\n  }\n\n  const responseError = async (response: Response, descriptor: RequestDescriptor): Promise<never> => {\n    if (descriptor.declaredStatuses.includes(response.status)) throw declared(await json(response) as DeclaredErrorBody)\n    try {\n      await response.body?.cancel()\n    } catch {}\n    throw new ClientError("UnexpectedStatus", { cause: { status: response.status }, detail: String(response.status) })\n  }\n\n  const request = async <A>(descriptor: RequestDescriptor, requestOptions?: RequestOptions): Promise<A> => {\n    const response = await execute(descriptor, requestOptions)\n    if (response.status !== descriptor.successStatus) return responseError(response, descriptor)\n    if (descriptor.empty) {\n      try {\n        await response.body?.cancel()\n      } catch {}\n      return undefined as A\n    }\n    return await json(response) as A\n  }\n\n  const sse = <A>(descriptor: RequestDescriptor, requestOptions?: RequestOptions): AsyncIterable<A> => ({\n    async *[Symbol.asyncIterator]() {\n      const response = await execute(descriptor, requestOptions)\n      if (response.status !== descriptor.successStatus) await responseError(response, descriptor)\n      if (!isContentType(response, "text/event-stream")) {\n        try {\n          await response.body?.cancel()\n        } catch {}\n        throw new ClientError("UnsupportedContentType", { detail: response.headers.get("content-type") })\n      }\n      if (response.body === null) throw new ClientError("MalformedResponse")\n      const reader = response.body.getReader()\n      const decoder = new TextDecoder()\n      let buffer = ""\n      try {\n        while (true) {\n          let next: ReadableStreamReadResult<Uint8Array>\n          try {\n            next = await reader.read()\n          } catch (cause) {\n            throw new ClientError("Transport", { cause })\n          }\n          if (!next.done) requestOptions?.onActivity?.()\n          buffer += decoder.decode(next.value, { stream: !next.done })\n          if (buffer.length > maxSseEventBytes) throw new ClientError("SseEventTooLarge")\n          const trailingCarriageReturn = !next.done && buffer.endsWith("\\r")\n          if (trailingCarriageReturn) buffer = buffer.slice(0, -1)\n          buffer = buffer.replaceAll("\\r\\n", "\\n").replaceAll("\\r", "\\n")\n          if (trailingCarriageReturn) buffer += "\\r"\n          if (next.done && buffer !== "") buffer += "\\n\\n"\n          let boundary = buffer.indexOf("\\n\\n")\n          while (boundary >= 0) {\n            const block = buffer.slice(0, boundary)\n            buffer = buffer.slice(boundary + 2)\n            const data = block.split("\\n").flatMap((line) => line.startsWith("data:") ? [line.slice(5).trimStart()] : []).join("\\n")\n            if (data !== "") {\n              try {\n                yield JSON.parse(data) as A\n              } catch (cause) {\n                throw new ClientError("MalformedResponse", { cause })\n              }\n            }\n            boundary = buffer.indexOf("\\n\\n")\n          }\n          if (next.done) return\n        }\n      } finally {\n        try {\n          await reader.cancel()\n        } catch {}\n        reader.releaseLock()\n      }\n    },\n  })\n\n  ${returned}\n}\n\nfunction appendQuery(params: URLSearchParams, key: string, value: unknown): void {\n  if (value === undefined) return\n  if (value === null) {\n    params.append(key, "null")\n    return\n  }\n  if (Array.isArray(value)) {\n    for (const item of value) appendQuery(params, key, item)\n    return\n  }\n  if (typeof value === "object") {\n    for (const [child, item] of Object.entries(value)) appendQuery(params, \`\${key}[\${child}]\`, item)\n    return\n  }\n  params.append(key, String(value))\n}\n\nasync function json(response: Response): Promise<unknown> {\n  if (!isContentType(response, "application/json") && !response.headers.get("content-type")?.includes("+json")) {\n    try {\n      await response.body?.cancel()\n    } catch {}\n    throw new ClientError("UnsupportedContentType", { detail: response.headers.get("content-type") })\n  }\n  let text: string\n  try {\n    text = await response.text()\n  } catch (cause) {\n    throw new ClientError("Transport", { cause })\n  }\n  if (text === "") throw new ClientError("MalformedResponse")\n  try {\n    return JSON.parse(text)\n  } catch (cause) {\n    throw new ClientError("MalformedResponse", { cause })\n  }\n}\n\ntype DeclaredErrorBody = { readonly _tag?: string; readonly message?: string; readonly data?: { readonly message?: string } }\n\n/** Throw declared error bodies as Errors. The body's fields stay on the error, so narrowing on \`_tag\` or \`name\` still works. */\nfunction declared(body: DeclaredErrorBody) {\n  const error = Object.assign(new Error(body.message ?? body.data?.message), body)\n  if (body._tag) error.name = body._tag\n  return error\n}\n\nfunction isContentType(response: Response, expected: string) {\n  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === expected\n}\n`
}

// promiseTypePrefix：Promise 类型名前缀（分组 + 路径拼接）
function promiseTypePrefix(group: string, path: ReadonlyArray<string>) {
  // PascalCase 拼接
  return `${identifierPart(group)}${path.map(identifierPart).join("")}`
}

// clientOperationKey：操作键（分组标识 + 客户端路径）
function clientOperationKey(group: Group, endpoint: Endpoint) {
  // 点连接
  return [group.identifier, ...endpoint.clientPath].join(".")
}

// clientEndpointPath：从端点标识推客户端路径（去掉 v2 前缀与分组重名段）
function clientEndpointPath(group: string, name: string) {
  // 按点切分
  const parts = name.split(".")
  // 去掉 v2 前缀（迁移期遗留）
  if (parts[0] === "v2") parts.shift()
  // 找路径中与分组末段相同的段，其后部分作为客户端路径
  const index = parts.lastIndexOf(group.slice(group.lastIndexOf(".") + 1))
  // 没找到则用全路径
  const result = index < 0 ? parts : parts.slice(index + 1)
  // 路径必须非空且每段非空
  if (result.length === 0 || result.some((part) => part.length === 0)) {
    // 抛出空路径错误
    throw new GenerationError({ reason: "Client endpoint path must contain non-empty names" })
  }
  // 路径段不能是 __proto__
  if (result.some((part) => part === "__proto__")) {
    // 抛出错误
    throw new GenerationError({ reason: "Client endpoint path cannot contain __proto__" })
  }
  // 返回至少一段的路径
  return result as [string, ...Array<string>]
}

// assertUniqueClientPaths：校验路径两两不构成前缀冲突
function assertUniqueClientPaths(
  // 全部路径
  paths: ReadonlyArray<ReadonlyArray<string>>,
  // 冲突时的错误信息生成器
  reason: (path: ReadonlyArray<string>) => string,
) {
  // 已见路径集合
  const seen = new Set<string>()
  // 规范化 key
  for (const path of paths) {
    // 与每个已见路径比较
    const key = path.join("\0")
    // 已见 key
    for (const existing of seen) {
      // 相等或互为前缀即冲突
      if (existing === key || existing.startsWith(`${key}\0`) || key.startsWith(`${existing}\0`)) {
        // 抛出冲突
        throw new GenerationError({ reason: reason(path) })
      }
    }
    // 登记
    seen.add(key)
  }
}

/**
 * Renders a group's methods as nested fields. `aliases` adds deprecated fields at their path relative to the tree;
 * a field that holds only aliases carries the deprecation note.
 */
// renderClientTree：把端点渲染成嵌套字段树（支持在树中插入废弃别名字段）
function renderClientTree(
  // 端点列表
  endpoints: ReadonlyArray<Endpoint>,
  // 叶子渲染（端点 → 值文本）
  leaf: (endpoint: Endpoint, index: number) => string,
  // 字段渲染（名+值 → 文本）
  field: (name: string, value: string) => string,
  // 同层分隔符
  separator: string,
  // 别名列表（带相对路径）
  aliases: ReadonlyArray<{ readonly path: ReadonlyArray<string>; readonly value: string; readonly alias: Alias }> = [],
) {
  // 树节点：端点/别名/真实存在标记/子节点
  type Node = {
    // 端点叶子
    endpoint?: { readonly value: Endpoint; readonly index: number }
    // 别名叶子
    alias?: { readonly value: string; readonly alias: Alias; readonly depth: number }
    // 是否真实存在（有端点或别名途经）
    real: boolean
    // 子节点表
    readonly children: Map<string, Node>
  }
  // 根节点
  const root: Node = { real: false, children: new Map() }
  // insert：沿路径插入节点并标记 real
  const insert = (path: ReadonlyArray<string>, real: boolean) =>
    // 逐段下降
    path.reduce((parent, name) => {
      // 复用或新建子节点
      const child: Node = parent.children.get(name) ?? { real: false, children: new Map() }
      // 任一路径经过即视为 real
      child.real ||= real
      // 挂到父节点
      parent.children.set(name, child)
      // 返回子节点供继续插入
      return child
    }, root)
  // 端点按客户端路径插入
  endpoints.forEach((endpoint, index) => {
    // 末段节点挂上端点与下标
    insert(endpoint.clientPath, true).endpoint = { value: endpoint, index }
  })
  // 插入别名
  for (const item of aliases) {
    // 沿路径插入（不算 real）
    const node = insert(item.path, false)
    // 与现有端点/别名/子树冲突即报错
    if (node.endpoint !== undefined || node.alias !== undefined || node.children.size > 0) {
      // 抛出别名冲突
      throw new GenerationError({ reason: `Client alias collision: ${item.alias.from.join(".")}` })
    }
    // 挂上别名值与深度
    node.alias = { value: item.value, alias: item.alias, depth: item.path.length }
  }
  // firstAlias：向下找第一个别名（给非真实节点补废弃文档用）
  const firstAlias = (node: Node): { readonly alias: Alias; readonly depth: number } =>
    // 递归首个子节点
    node.alias ?? firstAlias(node.children.values().next().value!)
  // render：递归渲染字段
  const render = (node: Node, depth: number): string =>
    // 遍历子节点
    Array.from(node.children, ([name, child]) => {
      // 节点值：端点/别名/子对象
      const value =
        // 端点叶子
        child.endpoint !== undefined
          // 调用叶子渲染
          ? leaf(child.endpoint.value, child.endpoint.index)
          // 别名叶子
          : child.alias !== undefined
            // 用别名值
            ? child.alias.value
            // 中间节点递归渲染为对象
            : `{ ${render(child, depth + 1)} }`
      // 真实节点正常渲染
      if (child.real) return field(name, value)
      // 非真实节点（仅别名途经）取其首个别名
      const { alias, depth: aliasDepth } = firstAlias(child)
      // 渲染为带 @deprecated 文档的字段
      return `\n${deprecatedAliasDoc(alias.to.slice(0, alias.to.length - (aliasDepth - depth - 1)))}\n${field(name, value)}`
    }).join(separator)
  // 以分隔符连接
  return render(root, 0)
}

// deprecatedAliasDoc：生成字段级废弃文档
function deprecatedAliasDoc(replacement: ReadonlyArray<string>) {
  // 指向新路径 client.xxx
  return `/** @deprecated Use \`client.${replacement.join(".")}\`. Removed in the next minor. */`
}

// deprecatedTypeAliasDoc：生成类型别名级废弃文档
function deprecatedTypeAliasDoc(replacement: string) {
  // 指向新类型名
  return `/** @deprecated Use \`${replacement}\`. Removed in the next minor. */`
}

// propertyAccess：渲染属性访问链（合法标识用点号，否则方括号）
function propertyAccess(root: string, path: ReadonlyArray<string>) {
  // 逐段累积
  return path.reduce(
    // 合法标识符
    (result, name) =>
      // 点号访问
      /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? `${result}.${name}` : `${result}[${JSON.stringify(name)}]`,
    // 方括号访问
    root,
  )
}

/**
 * Renders the runtime client with its aliases: `{ ...client, <alias fields> }`, where each alias is the namespaced
 * function itself and an existing object on an alias path is spread rather than replaced.
 */
// renderAliasedClient：渲染带别名的运行时客户端对象（{ ...client, 别名字段 }）
function renderAliasedClient(groups: ReadonlyArray<Group>, aliases: ReadonlyArray<Alias>, client: string) {
  // 收集客户端上真实存在的中间路径
  const existing = new Set(
    // 遍历端点路径
    groups.flatMap((group) =>
      // 完整路径
      group.endpoints.flatMap((endpoint) => {
        // 每个中间前缀
        const path = [...group.path, ...endpoint.clientPath]
        // 登记中间路径 key
        return path.slice(0, -1).map((_, index) => path.slice(0, index + 1).join("\0"))
      }),
    ),
  )
  // 别名树节点
  type Node = { alias?: Alias; readonly children: Map<string, Node> }
  // 根节点
  const root: Node = { children: new Map() }
  // 别名沿旧路径插入
  for (const alias of aliases) {
    // 逐段下降
    const node = alias.from.reduce((parent, name) => {
      // 复用或新建
      const child: Node = parent.children.get(name) ?? { children: new Map() }
      // 挂节点
      parent.children.set(name, child)
      // 返回子节点
      return child
    }, root)
    // 挂别名
    node.alias = alias
  }
  // firstAlias：向下找第一个别名
  const firstAlias = (node: Node): Alias => node.alias ?? firstAlias(node.children.values().next().value!)
  // 递归
  const render = (node: Node, path: ReadonlyArray<string>): string =>
    // render：递归渲染别名层
    Array.from(node.children, ([name, child]) => {
      // 子路径
      const childPath = [...path, name]
      // 字段名（JSON 引号形式）
      const key = JSON.stringify(name)
      // 别名叶：直接引用新位置的函数
      if (child.alias !== undefined) {
        // 带 @deprecated 文档
        return `\n${deprecatedAliasDoc(child.alias.to)}\n${key}: ${propertyAccess(client, child.alias.to)}`
      }
      // 该路径在真实客户端上存在 → 展开合并（不覆盖既有方法）
      if (existing.has(childPath.join("\0"))) {
        // 展开 + 追加别名子层
        return `${key}: { ...${propertyAccess(client, childPath)}, ${render(child, childPath)} }`
      }
      // 中间节点：取首个别名计算替换目标
      const alias = firstAlias(child)
      // 截取替换目标（去掉已渲染的前缀段）
      const replacement = alias.to.slice(0, alias.to.length - (alias.from.length - childPath.length))
      // 渲染为带文档的子对象
      return `\n${deprecatedAliasDoc(replacement)}\n${key}: { ${render(child, childPath)} }`
    // 逗号连接
    }).join(", ")
  // 整体 = 展开 client + 别名层
  return `{ ...${client}, ${render(root, [])} }`
}

// A node of the public client object: groups whose methods sit at this path, and nested
// namespaces, kept in declaration order so adding a group never reorders unrelated output.
// GroupNode：客户端对象树节点（条目 + 子命名空间）
type GroupNode = {
  // 本层条目：分组或命名空间占位名
  readonly entries: Array<Group | string>
  // 子命名空间（保持声明顺序，新增分组不打乱既有输出）
  readonly children: Map<string, GroupNode>
}

// groupTree：把分组按路径组织成树
function groupTree(groups: ReadonlyArray<Group>) {
  // 根节点
  const root: GroupNode = { entries: [], children: new Map() }
  // 逐分组
  for (const group of groups) {
    // 沿路径下降
    const node = group.path.reduce((parent, name) => {
      // 复用已有子节点
      const existing = parent.children.get(name)
      // 命中
      if (existing !== undefined) return existing
      // 新建子节点
      const child: GroupNode = { entries: [], children: new Map() }
      // 挂到父节点
      parent.children.set(name, child)
      // 父层登记占位名
      parent.entries.push(name)
      // 返回子节点
      return child
    }, root)
    // 分组挂到目标节点
    node.entries.push(group)
  }
  // 返回树根
  return root
}

/**
 * Renders the client object from its groups. A group either renders as one whole value (a
 * reference or call) or as fields; a node holding exactly one whole and nothing else collapses
 * to that whole, anything else goes through `combine`.
 */
// renderGroupTree：从分组树渲染客户端对象字段
function renderGroupTree(
  // 分组列表
  groups: ReadonlyArray<Group>,
  // 成员渲染回调（whole 或 fields）
  member: (group: Group) => { readonly whole: string } | { readonly fields: string },
  // 字段渲染回调
  field: (name: string, value: string) => string,
  // 合并回调
  combine: (wholes: ReadonlyArray<string>, fields: ReadonlyArray<string>) => string,
  // 分隔符
  separator: string,
) {
  // parts：收集一个节点的 whole 与 fields
  const parts = (node: GroupNode) => {
    // 整体值列表
    const wholes: Array<string> = []
    // 字段列表
    const fields: Array<string> = []
    // 遍历条目
    for (const entry of node.entries) {
      // 字符串条目：命名空间占位
      if (typeof entry === "string") {
        // 渲染其子节点为字段
        fields.push(field(entry, value(node.children.get(entry)!)))
        // 跳过
        continue
      }
      // 调成员回调
      const rendered = member(entry)
      // whole 收集
      if ("whole" in rendered) wholes.push(rendered.whole)
      // fields 非空才收
      else if (rendered.fields !== "") fields.push(rendered.fields)
    }
    // 返回两部分
    return { wholes, fields }
  }
  // value：渲染一个节点的值
  const value = (node: GroupNode): string => {
    // 取 parts
    const { wholes, fields } = parts(node)
    // 恰好一个 whole 且无字段 → 直接用该值，否则用合并回调
    return wholes.length === 1 && fields.length === 0 ? wholes[0] : combine(wholes, fields)
  }
  // 根层 parts
  const root = parts(groupTree(groups))
  // 根上不能有嵌套 whole（顶层分组除外）
  if (root.wholes.length > 0) throw new GenerationError({ reason: "Client root cannot hold a nested group" })
  // 返回根字段
  return root.fields.join(separator)
}

// spreadObject：合并回调——whole 展开在前，字段在后
function spreadObject(wholes: ReadonlyArray<string>, fields: ReadonlyArray<string>) {
  // 拼对象字面量
  return `{ ${[...wholes.map((whole) => `...${whole}`), ...fields].join(", ")} }`
}

// identifierPart：把任意标识转成 PascalCase 合法片段（数字开头补下划线）
function identifierPart(value: string) {
  // 按非字母数字切分
  const identifier = value
    // 去掉空段
    .split(/[^A-Za-z0-9]+/)
    // 每段首字母大写
    .filter(Boolean)
    // 拼接
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join("")
  // 数字开头补下划线
  return /^[A-Za-z_$]/.test(identifier) ? identifier : `_${identifier}`
}

// structuralTypes：批量把 schema 渲染成 TS 类型（命名去重 + 定义抽取）
function structuralTypes(schemas: ReadonlyArray<Schema.Top>, mutable: boolean, reservedNames: ReadonlySet<string>) {
  // 空输入直接返回空
  if (schemas.length === 0) return { types: [], definitions: [] }
  // 生成类型表示
  const representations = SchemaRepresentation.toRepresentations(
    // 转换为 codegen AST 后生成表示
    promiseTypeAsts(schemas) as [SchemaAST.AST, ...Array<SchemaAST.AST>],
  )
  // 生成代码文档
  const document = SchemaRepresentation.toCodeDocument(representations)
  // 出现 artifact 或递归引用均不支持
  if (document.artifacts.length > 0 || Object.keys(document.references.recursives).length > 0) {
    // 抛出未实现错误
    throw new GenerationError({ reason: "Referenced Promise types are not implemented" })
  }
  // 匿名引用集合（无 identifier 注解的中间引用）
  const anonymous = new Set(
    // 遍历引用
    Object.entries(representations.references)
      // 逐引用判断是否匿名
      .filter(([, reference]) => {
        // 无注解视为匿名
        if (!("annotations" in reference) || reference.annotations === undefined) return true
        // 无 identifier 也视为匿名
        return reference.annotations.identifier === undefined && reference.annotations["~identifier"] === undefined
      })
      // 收集匿名引用名
      .map(([name]) => name),
  )
  // 匿名引用 → 类型文本
  const anonymousTypes = new Map(
    // 过滤匿名
    document.references.nonRecursives
      // 映射文本
      .filter((reference) => anonymous.has(reference.$ref))
      .map((reference) => [reference.$ref, reference.code.Type]),
  )
  // inlineAnonymous：把匿名引用内联展开为具体类型
  const inlineAnonymous = (type: string, seen = new Set<string>()): string => {
    // 遍历匿名引用
    for (const [reference, value] of anonymousTypes) {
      // 构造词边界正则
      const pattern = `(?<![A-Za-z0-9_$.'"])${reference.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_$.'"])`
      // 不出现则跳过
      if (!new RegExp(pattern).test(type)) continue
      // 出现自身说明递归，不支持
      if (seen.has(reference)) {
        // 抛出递归错误
        throw new GenerationError({ reason: `Recursive Promise types are not implemented: ${reference}` })
      }
      // 替换为内联展开
      type = type.replaceAll(new RegExp(pattern, "g"), `(${inlineAnonymous(value, new Set([...seen, reference]))})`)
    }
    // 返回内联后的类型
    return type
  }
  // 命名映射与占用名
  const names = new Map<string, string>()
  // 保留名先占坑
  const usedNames = new Set(reservedNames)
  // 具名引用（非匿名）
  const references = document.references.nonRecursives.filter((reference) => !anonymous.has(reference.$ref))
  // 引用名集合
  const referenceNames = new Set(references.map((reference) => reference.$ref))
  // 为每个引用分配唯一类型名
  for (const reference of references) {
    // 种子名
    const seed = identifierPart(reference.$ref)
    // 去重取名
    const name = uniqueTypeName(seed, usedNames)
    // 登记映射
    names.set(reference.$ref, name)
    // 占用
    usedNames.add(name)
  }
  // render：类型文本的最终清理（替换引用名/JsonValue/any/可变/字符串建议）
  const render = (type: string) => {
    // 替换具名引用
    for (const [reference, name] of names) {
      // 词边界正则
      const pattern = `(?<![A-Za-z0-9_$.'"])${reference.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_$.'"])`
      // 全量替换
      type = type.replace(new RegExp(pattern, "g"), name)
    }
    // Schema.Json → JsonValue；unknown → any（排除字符串字面量内）
    const output = type.replaceAll("Schema.Json", "JsonValue").replaceAll(/(?<!["'])\bunknown\b(?!["'])/g, "any")
    // 按需可变化 + 保留字符串字面量提示
    return mutable ? mutableType(preserveStringSuggestions(output)) : preserveStringSuggestions(output)
  }
  // 等价类型合并：相同定义的引用共用一个名字
  const equivalent = new Map<string, string>()
  // 遍历引用
  for (const reference of references) {
    // 去掉数字后缀的基础名
    const base = reference.$ref.replace(/_\d+$/, "")
    // 基础名是具名引用则用基础名
    const identifier = referenceNames.has(base) ? base : reference.$ref
    // 等价 key：标识符 + 渲染文本
    const key = `${identifier}\0${render(inlineAnonymous(reference.code.Type))}`
    // 已有等价项
    const existing = equivalent.get(key)
    // 复用已有名字
    if (existing !== undefined) {
      // 登记后继续
      names.set(reference.$ref, existing)
      // 已有等价名，跳过
      continue
    }
    // 取本引用名
    const name = names.get(reference.$ref)
    // 缺名报错
    if (name === undefined) throw new GenerationError({ reason: `Missing Promise type name: ${reference.$ref}` })
    // 登记等价
    equivalent.set(key, name)
  }
  // 已输出定义集合
  const emitted = new Set<string>()
  // 返回类型文本与定义
  return {
    // 顶层类型（顺序与 outputSchemas 的占位对应）
    types: document.codes.map((code) => render(inlineAnonymous(code.Type))),
    // 定义输出（按首次出现顺序，去重）
    definitions: references.flatMap((reference) => {
      // 取名字
      const name = names.get(reference.$ref)
      // 缺名报错
      if (name === undefined) throw new GenerationError({ reason: `Missing Promise type name: ${reference.$ref}` })
      // 已输出跳过
      if (emitted.has(name)) return []
      // 标记已输出
      emitted.add(name)
      // 输出 export type 定义
      return [`export type ${name} = ${render(inlineAnonymous(reference.code.Type))}`]
    }),
  }
}

// uniqueTypeName：种子名 + 数字后缀去重
function uniqueTypeName(seed: string, used: ReadonlySet<string>, suffix = 1): string {
  // 首次不加后缀
  const name = suffix === 1 ? seed : `${seed}${suffix}`
  // 占用则递增后缀重试
  return used.has(name) ? uniqueTypeName(seed, used, suffix + 1) : name
}

// structuralType：单个 schema → 内联展开的结构化类型文本
function structuralType(schema: Schema.Top) {
  // 生成代码文档
  const document = SchemaRepresentation.toCodeDocument(SchemaRepresentation.toRepresentations([promiseTypeAst(schema)]))
  // artifact/递归不支持
  if (document.artifacts.length > 0 || Object.keys(document.references.recursives).length > 0) {
    // 抛错
    throw new GenerationError({ reason: "Referenced Promise types are not implemented" })
  }
  // 引用 → 文本映射
  const references = new Map(
    // 建映射
    document.references.nonRecursives.map((reference) => [reference.$ref, reference.code.Type]),
  )
  // expand：递归内联展开引用
  const expand = (type: string, seen = new Set<string>()): string => {
    // 逐引用
    for (const [reference, value] of references) {
      // 词边界正则
      const pattern = `(?<![A-Za-z0-9_$.'"])${reference.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_$.'"])`
      // 不出现跳过
      if (!new RegExp(pattern).test(type)) continue
      // 递归不支持
      if (seen.has(reference)) {
        // 抛错
        throw new GenerationError({ reason: `Recursive Promise types are not implemented: ${reference}` })
      }
      // 展开替换
      type = type.replace(new RegExp(pattern, "g"), `(${expand(value, new Set([...seen, reference]))})`)
    }
    // 返回展开后的类型
    return type
  }
  // 顶层展开 + JsonValue 替换 + 字符串建议保留
  return preserveStringSuggestions(expand(document.codes[0].Type).replaceAll("Schema.Json", "JsonValue"))
}

// includesUndefined：AST 是否包含 undefined（可选字段判断用）
function includesUndefined(ast: SchemaAST.AST): boolean {
  // undefined 类型
  if (SchemaAST.isUndefined(ast)) return true
  // 联合类型任一成员包含即可
  return SchemaAST.isUnion(ast) && ast.types.some(includesUndefined)
}

// promiseTypeAst：Promise 类型用的 AST（走 codegen 归一化）
function promiseTypeAst(schema: Schema.Top) {
  // 归一化
  return codegenAst(schema.ast)
}

// promiseTypeAsts：批量版本
function promiseTypeAsts(schemas: ReadonlyArray<Schema.Top>) {
  // 逐个归一化
  return codegenAsts(schemas.map((schema) => schema.ast))
}

// codegenAst：单个 AST 归一化
function codegenAst(root: SchemaAST.AST) {
  // 走批量
  return codegenAsts([root])[0]
}

// codegenAsts：把 AST 树归一化为"可生成代码"形态（缓存 + 引用去重）
function codegenAsts(roots: ReadonlyArray<SchemaAST.AST>) {
  // AST 级缓存
  const cache = new WeakMap<SchemaAST.AST, SchemaAST.AST>()
  // 引用登记（按 标识+可选+可变+编码 组合去重）
  const references = new Map<string, SchemaAST.AST>()
  // recur：递归处理
  const recur = (ast: SchemaAST.AST): SchemaAST.AST => {
    // 命中缓存
    const cached = cache.get(ast)
    // 返回缓存
    if (cached !== undefined) return cached
    // 解析标识符
    const identifier = SchemaAST.resolveIdentifier(ast)
    // 归一化当前节点
    const output = normalize(ast)
    // 组合引用键
    const referenceKey =
      // 标识 + 可选/可变标记 + 编码表示
      identifier === undefined
        // 拼键
        ? undefined
        // 查已有引用
        : `${identifier}\0${ast.context?.isOptional === true}\0${ast.context?.isMutable === true}\0${representationEncoding(output)}`
    // 查引用
    const reference = referenceKey === undefined ? undefined : references.get(referenceKey)
    // 命中：复用同一 AST 节点（保证表示去重）
    if (reference !== undefined) {
      // 写缓存
      cache.set(ast, reference)
      // 返回
      return reference
    }
    // 写缓存
    cache.set(ast, output)
    // 登记引用
    if (referenceKey !== undefined) references.set(referenceKey, output)
    // 返回归一化结果
    return output
  }
  // normalize：单节点归一化
  const normalize = (ast: SchemaAST.AST): SchemaAST.AST => {
    // 声明类型且未提供 toCode 时做特殊处理
    if (SchemaAST.isDeclaration(ast) && ast.annotations?.toCode === undefined) {
      // 取表示注解
      const representation = ast.annotations?.representation
      // Json 表示 → 直接用 Schema.Json 的 AST
      if (
        // 判断是否对象
        typeof representation === "object" &&
        // 检查 id
        representation !== null &&
        // 命中 Json 表示
        "id" in representation &&
        // 返回 Json AST
        representation.id === "effect/schema/Json"
      ) {
        // 带构造器注解的类型（如 TaggedError）：展开其首个类型参数为字段结构
        return Schema.Json.ast
      }
      // 取构造器注解
      if (ast.annotations?.["~constructor"] !== undefined && ast.typeParameters[0] !== undefined) {
        // 解析标识符
        const identifier = SchemaAST.resolveIdentifier(ast)
        // 递归处理字段
        const fields = recur(ast.typeParameters[0])
        // 无标识则丢弃名字直接用字段
        if (identifier === undefined) return fields
        // 保留标识符重建声明
        return Schema.make<Schema.Top>(fields).annotate({ identifier }).ast
      }
    }
    // 其余节点：若有 recur 能力则递归改写子节点
    if (!("recur" in ast) || typeof ast.recur !== "function") return ast
    // 递归改写
    return ast.recur(recur)
  }
  // 逐个处理根
  return roots.map(recur)
}

// preserveStringSuggestions："多个字符串字面量 | string"改为 (string & {})，保住编辑器字面量提示
function preserveStringSuggestions(type: string) {
  // 正则替换
  return type.replaceAll(/((?:"(?:\\.|[^"\\])*"\s*\|\s*)+)string\b/g, "$1(string & {})")
}

// normalizePromiseClientContent：按需向 client 模板注入二进制/通配符支持（精确替换标记）
function normalizePromiseClientContent(content: string, groups: ReadonlyArray<Group>) {
  // 全部端点
  const endpoints = groups.flatMap((group) => group.endpoints)
  // 是否用到二进制响应
  const usesBinary = endpoints.some((endpoint) => isBinarySchema(endpoint.successes[0]))
  // 是否用到路径通配符
  const usesWildcard = endpoints.some((endpoint) => promiseWildcardInput(endpoint) !== undefined)

  // SSE：去掉显式泛型标注（统一注入后重新推导）
  const sseReady = replaceOne(content, "let next: ReadableStreamReadResult<Uint8Array>", "let next")
  // 二进制响应支持：注入 binary 标记与 arrayBuffer 读取
  const binaryReady = usesBinary
    // 两处替换
    ? replaceOne(
        // descriptor 加 binary 字段
        replaceOne(sseReady, "readonly empty: boolean\n}", "readonly empty: boolean\n  readonly binary?: true\n}"),
        "if (descriptor.empty) {",
        // request 里处理二进制读取
        "if (descriptor.binary) return new Uint8Array(await response.arrayBuffer()) as A\n    if (descriptor.empty) {",
      )
    : sseReady
  // 二进制请求体支持：注入 binaryBody 标记与 content-type 处理
  const binaryBodyReady = endpoints.some(isBinaryPayload)
    // 三处替换
    ? replaceOne(
        replaceOne(
          replaceOne(
            binaryReady,
            // descriptor 加 binaryBody
            "readonly body?: unknown\n",
            "readonly body?: unknown\n  readonly binaryBody?: true\n",
          ),
          // content-type 按 binaryBody 选择
          'if (descriptor.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json")',
          'if (descriptor.body !== undefined && !headers.has("content-type"))\n      headers.set("content-type", descriptor.binaryBody ? "application/octet-stream" : "application/json")',
        ),
        // body 按 binaryBody 选择序列化方式
        "body: descriptor.body === undefined ? undefined : JSON.stringify(descriptor.body),",
        'body:\n          descriptor.body === undefined\n            ? undefined\n            : descriptor.binaryBody\n              ? (descriptor.body as RequestInit["body"])\n              : JSON.stringify(descriptor.body),',
      )
    : binaryReady
  // 通配符支持：注入 encodePath 工具
  return usesWildcard
    // 注入到 appendQuery 之前
    ? replaceOne(
        binaryBodyReady,
        "function appendQuery(params: URLSearchParams, key: string, value: unknown): void {",
        'function encodePath(value: string): string {\n  return value.split("/").map(encodeURIComponent).join("/")\n}\n\nfunction appendQuery(params: URLSearchParams, key: string, value: unknown): void {',
      )
    : binaryBodyReady
}

// isBinaryPayload：请求体是否二进制（Uint8Array 编码）
function isBinaryPayload(endpoint: Endpoint) {
  // 取 payload
  const payload = endpoint.payloads[0]
  // 判断编码标签
  return payload !== undefined && resolveHttpApiEncoding(payload.ast)?._tag === "Uint8Array"
}

// replaceOne：精确单次替换（找不到标记直接报错，保证模板与注入同步）
function replaceOne(input: string, search: string, replacement: string) {
  // 标记必须存在
  if (!input.includes(search))
    // 抛出缺标记错误
    throw new GenerationError({ reason: `Missing Promise client template marker: ${search}` })
  // 执行替换
  return input.replace(search, replacement)
}

// promiseInput：Promise 视角的输入字段（普通字段 + 可选通配符）
function promiseInput(endpoint: Endpoint): ReadonlyArray<PromiseInputField> {
  // 取通配符字段
  const wildcard = promiseWildcardInput(endpoint)
  // 无通配符即原字段
  if (wildcard === undefined) return endpoint.input
  // 追加通配符
  return [...endpoint.input, wildcard]
}

// promiseInputMode：Promise 输入模式（none/optional/required）
function promiseInputMode(endpoint: Endpoint): Operation["inputMode"] {
  // 取输入
  const input = promiseInput(endpoint)
  // 空即 none
  if (input.length === 0) return "none"
  // 全可选即 optional
  return input.every((field) => field.optional) ? "optional" : "required"
}

// promiseWildcardInput：提取路径通配符输入字段（仅支持结尾单个 *）
function promiseWildcardInput(endpoint: Endpoint): PromiseInputField | undefined {
  // 无 * 直接返回
  if (!endpoint.endpoint.path.includes("*")) return undefined
  // 多个 * 不支持
  if (endpoint.endpoint.path.indexOf("*") !== endpoint.endpoint.path.lastIndexOf("*")) {
    // 抛错
    throw new GenerationError({ reason: `Unsupported Promise path wildcard: ${endpoint.endpoint.path}` })
  }
  // * 必须在结尾
  if (!endpoint.endpoint.path.endsWith("*")) {
    // 抛错
    throw new GenerationError({ reason: `Unsupported Promise path wildcard: ${endpoint.endpoint.path}` })
  }
  // 字段名：避免与已有 path 字段冲突
  const name = endpoint.input.some((field) => field.name === "path") ? "wildcard" : "path"
  // 返回通配符字段
  return { name, source: "wildcard", optional: false }
}

// isBinarySchema：schema 是否二进制编码（Uint8Array）
function isBinarySchema(schema: Schema.Top) {
  // 判断编码标签（默认 Json）
  return (resolveHttpApiEncoding(schema.ast)?._tag ?? "Json") === "Uint8Array"
}

// promisePath：生成请求路径模板（:param 插值 + 可选通配符）
function promisePath(path: string, input: ReadonlyArray<InputField>, wildcard?: PromiseInputField) {
  // 收集路径参数名
  const fields = new Set(input.filter((field) => field.source === "params").map((field) => field.name))
  // 切分段落（识别 :name）
  const segments = (wildcard === undefined ? path : path.slice(0, -1))
    // 去掉结尾 * 后切分
    .split(/(:[A-Za-z_][A-Za-z0-9_]*)/g)
    // 过滤空段
    .filter(Boolean)
  // 逐段处理
  const template = segments
    // 普通段：转义反引号
    .map((segment) => {
      // 非参数段
      if (!segment.startsWith(":")) return segment.replaceAll("`", "\\`")
      // 参数段：取参数名
      const name = segment.slice(1)
      // 缺路径参数报错
      if (!fields.has(name)) throw new GenerationError({ reason: `Missing path parameter: ${name}` })
      // 生成 encodeURIComponent 插值
      return `\${encodeURIComponent(input.${name})}`
    })
    // 拼接模板
    .join("")
  // 追加通配符段（encodePath 编码）
  return `\`${template}${wildcard === undefined ? "" : `\${encodePath(input.${wildcard.name})}`}\``
}

// normalizeTransport：把传输层 schema 与"重建后"形态比对，判定可移植性
function normalizeTransport(
  // 待检 schema
  schema: Schema.Top | undefined,
  // 来源（params/query/headers/payload/success/error）
  source: InputField["source"] | "success" | "error",
  // 原端点（重建用）
  endpoint: HttpApiEndpoint.Top,
  // 操作名（错误信息用）
  operation: string,
) {
  // 无 schema 返回 undefined
  if (schema === undefined) return undefined
  // 流 schema 天然可移植
  if (isStreamSchema(schema)) return { schema, effectPortable: true } as const
  // 元数据（注解/检查）不可移植直接报错
  if (!metadataPortable(schema.ast, new Set())) {
    // 抛出不可移植错误
    throw new GenerationError({ reason: `Unportable schema: ${operation}.${source}` })
  }
  // 投影为解码侧类型
  const decoded = Schema.toType(schema)
  // 路径必须合法（/ 开头或 *）
  if (!isPathInput(endpoint.path)) {
    // 抛出非法路径
    throw new GenerationError({ reason: `Invalid endpoint path: ${operation}` })
  }
  // 用同一路径重建只含目标来源的端点（effect 内部会归一化 schema）
  const rebuilt =
    // params 分支
    source === "params"
      // 重建 params
      ? HttpApiEndpoint.make(endpoint.method)(endpoint.identifier, endpoint.path, {
          // 成功用占位 String
          params: decoded,
          // query 分支
          success: Schema.String,
        })
      : source === "query"
        // headers 分支
        ? HttpApiEndpoint.make(endpoint.method)(endpoint.identifier, endpoint.path, {
            query: decoded,
            success: Schema.String,
          })
        // payload 分支
        : source === "headers"
          ? HttpApiEndpoint.make(endpoint.method)(endpoint.identifier, endpoint.path, {
              headers: decoded,
              success: Schema.String,
            })
          // success 分支
          : source === "payload"
            ? HttpApiEndpoint.make(endpoint.method)(endpoint.identifier, endpoint.path, {
                payload: decoded,
                success: Schema.String,
              })
            // error 分支
            : source === "success"
              ? HttpApiEndpoint.make(endpoint.method)(endpoint.identifier, endpoint.path, { success: decoded })
              : HttpApiEndpoint.make(endpoint.method)(endpoint.identifier, endpoint.path, {
                  success: Schema.String,
                  error: decoded,
                })
  // 从重建端点取回目标来源的 schema
  const normalized =
    // params
    source === "params"
      // 取 params
      ? rebuilt.params
      : source === "query"
        // 取 query
        ? rebuilt.query
        : source === "headers"
          // 取 headers
          ? rebuilt.headers
          : source === "payload"
            // 取 payload（第一个）
            ? Array.from(rebuilt.payload.values())[0]?.schemas[0]
            : source === "success"
              // 取 success（第一个）
              ? Array.from(rebuilt.success)[0]
              // 取 error（第一个）
              : Array.from(rebuilt.error)[0]
  // 重建失败 → 不可移植
  if (normalized === undefined) throw new GenerationError({ reason: `Unportable schema: ${operation}.${source}` })
  // 编码表示不一致 → 标记不可移植（保留原 schema）
  if (!sameEncoding(schema.ast, normalized.ast)) return { schema, effectPortable: false } as const
  // 一致 → 用解码侧 schema 且可移植
  return { schema: decoded, effectPortable: true } as const
}

// isPathInput：路径是否合法输入（* 或以 / 开头）
function isPathInput(path: string): path is HttpRouter.PathInput {
  // 判断
  return path === "*" || path.startsWith("/")
}

// 编码表示缓存（AST → JSON 文本）
const encodings = new WeakMap<SchemaAST.AST, string>()

// sameEncoding：运行时编码与表示都一致才算同编码
function sameEncoding(left: SchemaAST.AST, right: SchemaAST.AST): boolean {
  // 先比运行时结构
  if (!sameRuntimeEncoding(left, right)) return false
  // 再比表示
  return sameRepresentation(left, right)
}

// sameRepresentation：表示（序列化 JSON）一致
function sameRepresentation(left: SchemaAST.AST, right: SchemaAST.AST): boolean {
  // 比较
  return representationEncoding(left) === representationEncoding(right)
}

// representationEncoding：把 AST 表示序列化成 JSON 文本（带缓存）
function representationEncoding(ast: SchemaAST.AST) {
  // 查缓存
  const cached = encodings.get(ast)
  // 命中
  if (cached !== undefined) return cached
  // 序列化表示
  const encoded = JSON.stringify(SchemaRepresentation.toJson(SchemaRepresentation.toRepresentation(ast)))
  // 写缓存
  encodings.set(ast, encoded)
  // 返回
  return encoded
}

// sameRuntimeEncoding：递归比较两个 AST 的运行时结构
function sameRuntimeEncoding(left: SchemaAST.AST, right: SchemaAST.AST): boolean {
  // 标签或编码链长度不同即不同
  if (left._tag !== right._tag || left.encoding?.length !== right.encoding?.length) return false
  // 比较编码链
  if (
    // 逐链比较
    left.encoding?.some((link, index) => {
      // 对方缺失或链不同
      const other = right.encoding?.[index]
      // 返回不同
      return other === undefined || !sameRuntimeEncoding(link.to, other.to)
    })
  // 存在链不同
  ) {
    // 返回不同
    return false
  }
  // Suspend：展开 thunk 再比
  if (!sameChecks(left.checks, right.checks) || !sameContext(left.context, right.context)) return false
  // 双方都是 suspend
  if (SchemaAST.isSuspend(left) && SchemaAST.isSuspend(right)) {
    // 递归比较
    return sameRuntimeEncoding(left.thunk(), right.thunk())
  }
  // 联合：逐成员比较
  if (SchemaAST.isUnion(left) && SchemaAST.isUnion(right)) {
    // 长度一致且
    return (
      // 逐位比较
      left.types.length === right.types.length &&
      left.types.every((ast, index) => sameRuntimeEncoding(ast, right.types[index]))
    )
  }
  // 数组：元素与 rest 全比
  if (SchemaAST.isArrays(left) && SchemaAST.isArrays(right)) {
    // 长度一致且
    return (
      // 元素逐位、rest 逐位
      left.elements.length === right.elements.length &&
      left.rest.length === right.rest.length &&
      left.elements.every((ast, index) => sameRuntimeEncoding(ast, right.elements[index])) &&
      left.rest.every((ast, index) => sameRuntimeEncoding(ast, right.rest[index]))
    )
  }
  // 对象：属性签名与索引签名全比
  if (SchemaAST.isObjects(left) && SchemaAST.isObjects(right)) {
    // 数量一致且
    return (
      // 属性逐位、索引逐位
      left.propertySignatures.length === right.propertySignatures.length &&
      left.indexSignatures.length === right.indexSignatures.length &&
      left.propertySignatures.every((field, index) =>
        sameRuntimeEncoding(field.type, right.propertySignatures[index].type),
      ) &&
      left.indexSignatures.every(
        (field, index) =>
          sameRuntimeEncoding(field.parameter, right.indexSignatures[index].parameter) &&
          sameRuntimeEncoding(field.type, right.indexSignatures[index].type),
      )
    )
  }
  // 其余默认相同
  return true
}

// sameChecks：比较检查列表（Filter 需函数相同）
function sameChecks(left: SchemaAST.Checks | undefined, right: SchemaAST.Checks | undefined): boolean {
  // 长度不同即不同
  if (left?.length !== right?.length) return false
  // 双方为空即相同
  if (left === undefined || right === undefined) return true
  // 逐项比较
  return left.every((check, index) => {
    // 对方项
    const other = right[index]
    // 标签不同即不同
    if (other === undefined || check._tag !== other._tag) return false
    // Filter：函数与 aborted 都要相同
    if (check._tag === "Filter" && other._tag === "Filter") {
      // 函数相同且未中止
      return check.run === other.run && check.aborted === other.aborted
    }
    // FilterGroup：递归比较子检查
    return check._tag === "FilterGroup" && other._tag === "FilterGroup" && sameChecks(check.checks, other.checks)
  })
}

// sameContext：比较上下文标记（可选/可变）
function sameContext(left: SchemaAST.Context | undefined, right: SchemaAST.Context | undefined) {
  // 两个标记都一致
  return (
    (left?.isOptional ?? false) === (right?.isOptional ?? false) &&
    (left?.isMutable ?? false) === (right?.isMutable ?? false)
  )
}

// write：把 Output 写入目录（安全检查 + 清单维护 + prettier 格式化）
export function write(
  // 输出文件集
  output: Output,
  // 目标目录
  directory: string,
// 返回写入效果（可能失败：生成错误或平台错误，依赖文件系统）
): Effect.Effect<void, GenerationError | PlatformError.PlatformError, FileSystem.FileSystem> {
  // 生成器主体
  return Effect.gen(function* () {
    // 本次的文件路径集合
    const paths = new Set<string>()
    // 规范化（小写）路径集合（大小写不敏感查重）
    const normalizedPaths = new Set<string>()
    // 逐文件校验
    for (const file of output.files) {
      // 路径必须安全（非清单名/非绝对/无分隔符）
      if (!isSafeOutputPath(file.path)) yield* new GenerationError({ reason: `Unsafe output path: ${file.path}` })
      // 小写路径
      const path = file.path.toLowerCase()
      // 大小写不敏感查重
      if (normalizedPaths.has(path)) yield* new GenerationError({ reason: `Duplicate output path: ${file.path}` })
      // 抛出重复路径
      normalizedPaths.add(path)
      // 登记路径
      paths.add(file.path)
    }
    // 取文件系统服务
    const fs = yield* FileSystem.FileSystem
    // 递归创建输出目录
    yield* fs.makeDirectory(directory, { recursive: true })
    // 清单文件路径
    const manifest = join(directory, manifestName)
    // 读上一次的清单（不存在则为空列表）
    const previous = (yield* fs.exists(manifest))
      // 存在则读取并解码
      ? yield* fs.readFileString(manifest).pipe(
          // 解码失败视为清单损坏
          Effect.flatMap(Schema.decodeUnknownEffect(Manifest)),
          // 抛出清单无效
          Effect.mapError(() => new GenerationError({ reason: `Invalid generated file manifest: ${manifest}` })),
        )
      // 无清单时空列表
      : []
    // 清单里若含不安全路径同样视为损坏
    if (previous.some((path) => !isSafeOutputPath(path))) {
      // 抛错
      yield* new GenerationError({ reason: `Invalid generated file manifest: ${manifest}` })
    }
    // 删除本次不再生成的旧文件（并发 8）
    yield* Effect.forEach(
      // 过滤出过期文件
      previous.filter((path) => !paths.has(path)),
      // 强制删除
      (path) => fs.remove(join(directory, path), { force: true }),
      // 并发控制
      { concurrency: 8, discard: true },
    )
    // 写入前检查：目标若为符号链接则拒绝（防路径逃逸）
    yield* Effect.forEach(
      // 逐文件检查
      output.files,
      (file) =>
        // 存在则取 stat
        fs.exists(join(directory, file.path)).pipe(
          // 存在才 stat
          Effect.flatMap((exists) => (exists ? fs.stat(join(directory, file.path)) : Effect.undefined)),
          // 符号链接视为不安全
          Effect.flatMap((info) =>
            // 抛错
            info?.type === "SymbolicLink"
              // 非链接放行
              ? new GenerationError({ reason: `Unsafe output path: ${file.path}` })
              : Effect.void,
          ),
        ),
      // 并发控制
      { concurrency: 8, discard: true },
    )
    // 逐文件格式化并写入（并发 8）
    yield* Effect.forEach(
      // 逐文件
      output.files,
      (file) =>
        // 用 prettier 按文件路径推断解析器格式化
        Effect.tryPromise({
          // TS 解析、无分号、120 列（与仓库格式一致）
          try: () => format(file.content, { filepath: file.path, parser: "typescript", semi: false, printWidth: 120 }),
          // 格式化失败抛错
          catch: (error) => new GenerationError({ reason: `Failed to format ${file.path}: ${String(error)}` }),
        // 写入文件
        }).pipe(Effect.flatMap((content) => fs.writeFileString(join(directory, file.path), content))),
      // 并发控制
      { concurrency: 8, discard: true },
    )
    // Format the manifest with the same prettier settings as the repo-wide
    // format pass, so `check:generated` stays clean after the generate bot
    // reformats the tree.
    // 清单内容：本次全部文件路径排序后的 JSON
    const manifestJson = JSON.stringify(output.files.map((file) => file.path).sort())
    // 也用 prettier 格式化（json 解析器）
    const manifestContent = yield* Effect.tryPromise({
      // 按清单路径推断为 json
      try: () => format(manifestJson, { filepath: manifest, parser: "json", printWidth: 120 }),
      // 失败抛错
      catch: (error) => new GenerationError({ reason: `Failed to format ${manifest}: ${String(error)}` }),
    })
    // 写入清单
    yield* fs.writeFileString(manifest, manifestContent)
  })
}

// isSafeOutputPath：输出路径安全检查（防覆盖清单/绝对路径/目录穿越）
function isSafeOutputPath(path: string) {
  // 不能是清单本身/绝对路径/点/点点/含路径分隔符
  return path !== manifestName && !isAbsolute(path) && path !== "." && path !== ".." && !/[\\/]/.test(path)
}

// generate：一站式入口——编译 → emitEffect → 写目录
export function generate<Id extends string, Groups extends HttpApiGroup.Constraint>(
  // HttpApi 实例
  api: HttpApi.HttpApi<Id, Groups>,
  // 选项（输出目录）
  options: { readonly directory: string },
// 返回写入效果
): Effect.Effect<void, GenerationError | PlatformError.PlatformError, FileSystem.FileSystem> {
  // try 包裹编译与产出
  return Effect.try({
    // 编译并产出
    try: () => emitEffect(compile(api)),
    // 非生成错误也归一为 GenerationError
    catch: (error) => (error instanceof GenerationError ? error : new GenerationError({ reason: String(error) })),
  // 拿到输出后写盘
  }).pipe(Effect.flatMap((output) => write(output, options.directory)))
}

// isFlattenableStruct：schema 是否为无索引签名的对象（可平铺为输入字段）
function isFlattenableStruct(schema: Schema.Top) {
  // 取解码侧 AST
  const ast = Schema.toType(schema).ast
  // 对象且无索引签名
  return SchemaAST.isObjects(ast) && ast.indexSignatures.length === 0
}

// isOpaquePayload：payload 是否"不透明"（非扁平 struct，需整体传输）
function isOpaquePayload(endpoint: Endpoint) {
  // 取第一个 payload
  const payload = endpoint.payloads[0]
  // 存在且不可平铺
  return payload !== undefined && !isFlattenableStruct(payload)
}

// inputFields：从 schema 提取输入字段（非扁平 struct 的 payload 视为单字段 payload）
function inputFields(schema: Schema.Top | undefined, source: InputField["source"], operation: string) {
  // 无 schema 返回空
  if (schema === undefined) return []
  // 取解码侧 AST
  const ast = Schema.toType(schema).ast
  // 非对象或带索引签名
  if (!SchemaAST.isObjects(ast) || ast.indexSignatures.length > 0) {
    // payload 特例：整体作为名为 payload 的字段
    if (source === "payload") return [{ name: "payload", source, optional: false }] as const
    // 其他来源必须是 struct，否则报错
    throw new GenerationError({ reason: `Input schema must be a struct: ${operation}.${source}` })
  }
  // 逐属性生成字段
  return ast.propertySignatures.map((field) => {
    // 字段名必须是字符串
    if (typeof field.name !== "string") {
      // 抛错
      throw new GenerationError({ reason: `Input field must have a string name: ${operation}.${source}` })
    }
    // 产出字段记录
    return {
      // 字段名
      name: field.name,
      // 来源
      source,
      // 是否可选
      optional: SchemaAST.isOptional(field.type),
    }
  })
}

// responseSchemas：成功响应拆成诊断 schema 列表（流拆 data/error）
function responseSchemas(schema: Schema.Top, path: string): Array<readonly [string, Schema.Top]> {
  // 204 无内容 → 空
  if (HttpApiSchema.isNoContent(schema.ast)) return []
  // 非流：单条
  if (!isStreamSchema(schema)) return [[path, schema]]
  // 二进制流无载荷 → 空
  if (schema._tag === "StreamUint8Array") return []
  // data 模式取 data 载荷，events 模式取事件联合
  const value = schema.sseMode === "data" ? streamDataSchema(schema) : Schema.make<Schema.Top>(schema.events.ast)
  // 产出两条：载荷与错误
  return [
    // 载荷条目
    [`${path}.${schema.sseMode}`, value],
    // 错误条目
    [`${path}.error`, schema.error],
  ]
}

// assertPortable：断言 schema 可被 Effect 代码生成器复现（缓存 + 环检测）
function assertPortable(schema: Schema.Top, path: string, portable: Map<SchemaAST.AST, boolean>) {
  // 访问中集合（环检测）
  const visiting = new Set<SchemaAST.AST>()
  // 提取 tagged 错误字段（如有）
  const taggedError = taggedErrorFields(schema)
  // visit：带缓存与环保护的递归
  const visit = (ast: SchemaAST.AST): boolean => {
    // 命中缓存
    const cached = portable.get(ast)
    // 返回
    if (cached !== undefined) return cached
    // 环上节点视为可移植（由外层判定）
    if (visiting.has(ast)) return true
    // 标记访问中
    visiting.add(ast)
    // 判定当前节点
    const result = visitCurrent(ast)
    // 取消标记
    visiting.delete(ast)
    // 写缓存
    portable.set(ast, result)
    // 返回结果
    return result
  }
  // visitCurrent：单节点判定
  const visitCurrent = (ast: SchemaAST.AST): boolean => {
    // 注解必须可移植
    if (!annotationsPortable(ast.annotations)) return false
    // 检查（含编码检查）必须可移植
    if (!checksPortable(ast.checks) || ("encodingChecks" in ast && !checksPortable(ast.encodingChecks))) return false
    // 声明类型：需支持 toCode / Json 表示 / 构造器展开之一
    if (SchemaAST.isDeclaration(ast)) {
      // 取表示注解
      const representation = ast.annotations?.representation
      // 支持性判断
      const supported =
        // 有 toCode 函数
        typeof ast.annotations?.toCode === "function" ||
        // 或 Json 表示
        (typeof representation === "object" &&
          // 检查 id
          representation !== null &&
          // 命中
          "id" in representation &&
          // 或带构造器注解且有类型参数
          representation.id === "effect/schema/Json") ||
        (ast.annotations?.["~constructor"] !== undefined && ast.typeParameters[0] !== undefined)
      // 支持 && 类型参数都可移植
      return supported && ast.typeParameters.every(visit)
    }
    // 带编码但无 toCode → 不可移植
    if (ast.encoding !== undefined && ast.annotations?.toCode === undefined) return false
    // Suspend：展开继续判
    if (SchemaAST.isSuspend(ast)) return visit(ast.thunk())
    // 联合：全部成员可移植
    if (SchemaAST.isUnion(ast)) return ast.types.every(visit)
    // 数组：元素与 rest
    if (SchemaAST.isArrays(ast)) {
      // 全部可移植
      return ast.elements.every(visit) && ast.rest.every(visit)
    }
    // 对象：属性与索引签名
    if (SchemaAST.isObjects(ast)) {
      // 全部可移植
      return (
        // 属性逐个
        ast.propertySignatures.every((field) => visit(field.type)) &&
        // 索引签名（参数与类型）
        ast.indexSignatures.every((index) => visit(index.parameter) && visit(index.type))
      )
    }
    // 模板字面量：逐段
    if (SchemaAST.isTemplateLiteral(ast)) return ast.parts.every(visit)
    // 其余默认可移植
    return true
  }
  // tagged 错误（声明类型）走专门校验路径
  if (taggedError !== undefined && SchemaAST.isDeclaration(schema.ast)) {
    // 条件：
    if (
      // 顶层有检查
      schema.ast.checks !== undefined ||
      // 编码检查不可移植
      ("encodingChecks" in schema.ast && !checksPortable(schema.ast.encodingChecks)) ||
      // 类型参数带检查
      schema.ast.typeParameters.some((ast) => ast.checks !== undefined) ||
      // 类型参数必须全部可移植
      !schema.ast.typeParameters.every(visit)
    // 任一不满足即抛错
    ) {
      // 抛出不可移植
      throw new GenerationError({ reason: `Unportable schema: ${path}` })
    }
    // 校验通过直接返回
    return
  }
  // 普通路径：整体不可移植即抛错
  if (!visit(schema.ast)) throw new GenerationError({ reason: `Unportable schema: ${path}` })
}

// checksPortable：检查是否可移植（Filter 需带可序列化表示与任意约束）
function checksPortable(checks: SchemaAST.Checks | undefined): boolean {
  // 无检查即可移植
  if (checks === undefined) return true
  // 逐检查
  return checks.every((check) =>
    // Filter 检查
    check._tag === "Filter"
      // 未中止且
      ? !check.aborted &&
        // 带表示注解
        check.annotations?.representation !== undefined &&
        // 表示可序列化
        serializable(check.annotations.representation) &&
        // 且 arbitrary 约束为对象
        typeof check.annotations.arbitraryConstraint === "object" &&
        // 非空对象
        check.annotations.arbitraryConstraint !== null
      // 其他标签：递归子检查
      : checksPortable(check.checks),
  )
}

// metadataPortable：元数据（注解/检查/编码链/子节点）整体可移植性
function metadataPortable(ast: SchemaAST.AST, seen: Set<SchemaAST.AST>): boolean {
  // 已见即视为可移植（防环）
  if (seen.has(ast)) return true
  // 登记
  seen.add(ast)
  // 注解与检查
  if (!annotationsPortable(ast.annotations) || !checksPortable(ast.checks)) return false
  // 编码检查
  if ("encodingChecks" in ast && !checksPortable(ast.encodingChecks)) return false
  // 编码链逐段
  if (ast.encoding?.some((link) => !metadataPortable(link.to, seen))) return false
  // 声明：类型参数逐个
  if (SchemaAST.isDeclaration(ast)) return ast.typeParameters.every((item) => metadataPortable(item, seen))
  // Suspend：展开
  if (SchemaAST.isSuspend(ast)) return metadataPortable(ast.thunk(), seen)
  // 联合：逐成员
  if (SchemaAST.isUnion(ast)) return ast.types.every((item) => metadataPortable(item, seen))
  // 数组：元素与 rest
  if (SchemaAST.isArrays(ast)) {
    // 全部可移植
    return (
      // 元素/rest 逐个
      ast.elements.every((item) => metadataPortable(item, seen)) &&
      ast.rest.every((item) => metadataPortable(item, seen))
    )
  }
  // 对象：属性与索引
  if (SchemaAST.isObjects(ast)) {
    // 全部可移植
    return (
      // 逐个
      ast.propertySignatures.every((field) => metadataPortable(field.type, seen)) &&
      ast.indexSignatures.every(
        (field) => metadataPortable(field.parameter, seen) && metadataPortable(field.type, seen),
      )
    )
  }
  // 其余默认可移植
  return true
}

// annotationsPortable：注解是否可移植（白名单外的值必须可序列化）
function annotationsPortable(annotations: Schema.Annotations.Annotations | undefined) {
  // 无注解即可移植
  if (annotations === undefined) return true
  // 逐键值
  return Object.entries(annotations).every(([key, value]) => {
    // 白名单键（有专用运行时实现，无需序列化）
    if (
      // toCodec 等
      [
        "toCodec",
        "toCodecJson",
        "toCodecStringTree",
        "toCodecArbitrary",
        "toArbitrary",
        "toFormatter",
        "toEquivalence",
        "toCode",
        "~constructor",
      // ~constructor
      ].includes(key)
    ) {
      // 白名单内直接放行
      return true
    }
    // 其余值必须可序列化
    return serializable(value)
  })
}

// serializable：值是否可安全序列化进生成代码（null/原始值/数组/纯对象）
function serializable(value: unknown): boolean {
  // 原始值
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return true
  // 数组逐元素
  if (Array.isArray(value)) return value.every(serializable)
  // 非对象不可
  if (typeof value !== "object") return false
  // 对象逐值
  return Object.values(value).every(serializable)
}

// taggedErrorFields：declaredErrorFields 的 _tag 特化（只认 _tag 判别）
function taggedErrorFields(schema: Schema.Top) {
  // 先取字段信息
  const fields = declaredErrorFields(schema)
  // key 为 _tag 才返回
  return fields?.key === "_tag" ? fields : undefined
}

// declaredErrorFields：提取"带字面量判别字段的声明错误"信息（TaggedError 类）
function declaredErrorFields(schema: Schema.Top) {
  // 必须是带 ~constructor 注解的声明
  if (!SchemaAST.isDeclaration(schema.ast) || schema.ast.annotations?.["~constructor"] === undefined) {
    // 不满足返回 undefined
    return undefined
  }
  // 首个类型参数是字段结构
  const fields = schema.ast.typeParameters[0]
  // 必须是无索引签名的对象
  if (!SchemaAST.isObjects(fields) || fields.indexSignatures.length > 0) return undefined
  // 找 _tag 或 name 判别字段
  const key = fields.propertySignatures.find((field) => field.name === "_tag" || field.name === "name")?.name
  // 必须是其中之一
  if (key !== "_tag" && key !== "name") return undefined
  // 取判别字段的字面量值
  const tag = fields.propertySignatures.find((field) => field.name === key)?.type
  // 必须是字符串字面量
  if (tag === undefined || !SchemaAST.isLiteral(tag) || typeof tag.literal !== "string") return undefined
  // 产出：判别键/标签/标识符/其余字段
  return {
    // 判别键
    key,
    // 字面量标签
    tag: tag.literal,
    // 标识符（回退用标签）
    identifier: SchemaAST.resolveIdentifier(schema.ast) ?? tag.literal,
    // 其余字段（名字/schema/可选）
    fields: fields.propertySignatures.flatMap((field) =>
      // 跳过判别字段与非字符串字段
      field.name === key || typeof field.name !== "string"
        ? []
        : [[field.name, Schema.make<Schema.Top>(field.type), SchemaAST.isOptional(field.type)] as const],
    ),
  }
}

// isDataEnvelope：成功响应是否为单字段 { data } 信封（客户端需解包）
function isDataEnvelope(schema: Schema.Top) {
  // 流与 204 都不是信封
  if (isStreamSchema(schema) || HttpApiSchema.isNoContent(schema.ast)) return false
  // 取解码侧 AST
  const ast = Schema.toType(schema).ast
  // 对象且无索引签名且恰有 data 一个属性
  return (
    // 是对象
    SchemaAST.isObjects(ast) &&
    // 无索引
    ast.indexSignatures.length === 0 &&
    // 恰一个属性
    ast.propertySignatures.length === 1 &&
    // 且名为 data
    ast.propertySignatures[0]?.name === "data"
  )
}

// isStreamSchema：是否流式响应 schema（SSE 或 Uint8Array 流）
function isStreamSchema(
  // 有 _tag 且为两种流之一
  schema: Schema.Top,
): schema is Exclude<HttpApiSchema.StreamSchema, HttpApiSchema.StreamNdjson<Schema.Top>> {
  return "_tag" in schema && (schema._tag === "StreamSse" || schema._tag === "StreamUint8Array")
}

// streamDataSchema：SSE data 模式的解码侧 data schema
function streamDataSchema(schema: Extract<HttpApiSchema.StreamSchema, { readonly _tag: "StreamSse" }>) {
  // 从 events 中挖出 data
  return Schema.make<Schema.Top>(streamDataAst(Schema.toType(schema.events).ast))
}

// streamEncodedDataSchema：SSE data 模式的编码侧 data schema
function streamEncodedDataSchema(schema: Extract<HttpApiSchema.StreamSchema, { readonly _tag: "StreamSse" }>) {
  // 取 effect 内部的 replaceEncoding 运行时助手（无公开类型）
  // oxlint-disable-next-line no-restricted-globals -- Effect exposes this runtime helper without a public type.
  const replaceEncoding: unknown = Reflect.get(SchemaAST, "replaceEncoding")
  // 助手不存在即报错
  if (typeof replaceEncoding !== "function") throw new GenerationError({ reason: "Invalid SSE data schema" })
  // 用它移除编码标记
  const ast: unknown = replaceEncoding(streamDataAst(schema.events.ast), undefined)
  // 结果必须是合法 AST
  if (!SchemaAST.isAST(ast)) throw new GenerationError({ reason: "Invalid SSE data schema" })
  // 转为编码侧 schema
  return Schema.toEncoded(Schema.make<Schema.Top>(ast))
}

// streamDataAst：从 events 对象中挖出 data 属性类型
function streamDataAst(ast: SchemaAST.AST) {
  // 必须是对象
  if (!SchemaAST.isObjects(ast)) throw new GenerationError({ reason: "Invalid SSE data schema" })
  // 找 data 属性
  const data = ast.propertySignatures.find((field) => field.name === "data")?.type
  // 缺失即报错
  if (data === undefined) throw new GenerationError({ reason: "Invalid SSE data schema" })
  // 返回 data 类型
  return data
}

// streamEffectPortable：流成功响应是否可移植（重建后编码一致）
function streamEffectPortable(schema: Schema.Top) {
  // 二进制流/events 模式天然可移植
  if (!isStreamSchema(schema) || schema._tag === "StreamUint8Array" || schema.sseMode === "events") return true
  // 用相同参数重建 SSE 流
  const rebuilt = HttpApiSchema.StreamSse({
    // data 载荷
    data: streamDataSchema(schema),
    // 错误
    error: schema.error,
    // content-type
    contentType: schema.contentType,
  })
  // 与原 events 编码一致才可移植
  return sameEncoding(schema.events.ast, rebuilt.events.ast)
}

// renderGroup：渲染单个分组的模块文件（schema 声明 + 端点适配器 + 分组定义）
function renderGroup(group: Group) {
  // schema 槽位（渲染为 const）
  const slots: Array<Slot> = []
  // 端点适配器文本
  const adapters: Array<string> = []
  // 逐端点生成端点声明源码
  const endpointSources = group.endpoints.map((operation) => {
    // 解构端点信息
    const {
      // 端点
      endpoint,
      // 错误
      errors,
      // 请求头（重命名）
      headers: endpointHeaders,
      // 路径参数（重命名）
      params: endpointParams,
      // 请求体（重命名）
      payloads: endpointPayloads,
      // 查询（重命名）
      query: endpointQuery,
      // 成功列表
      successes,
    } = operation
    // 适配器前缀名
    const prefix = `Endpoint${operation.clientPath.map(identifierPart).join("")}`
    // params 槽位
    const params = addSlot(endpointParams, `${prefix}Params`)
    // query 槽位
    const query = addSlot(endpointQuery, `${prefix}Query`)
    // headers 槽位
    const headers = addSlot(endpointHeaders, `${prefix}Headers`)
    // payload 槽位（可能多个）
    const payloads = endpointPayloads.map((schema, index) => addSlot(schema, `${prefix}Payload${index}`)!)
    // 成功渲染（流有特殊处理）
    const success = renderSuccess(successes[0], `${prefix}Success`)
    // 错误槽位
    const errorSlots = errors.map((error, index) => addSlot(error.schema, `${prefix}Error${index}`)!)
    // 组装端点选项
    const options = [
      // params
      params === undefined ? undefined : `params: ${params.name}`,
      // query
      query === undefined ? undefined : `query: ${query.name}`,
      // headers
      headers === undefined ? undefined : `headers: ${headers.name}`,
      // payload：无则省略
      payloads.length === 0
        // 省略
        ? undefined
        // 单个直接引用，多个用数组
        : `payload: ${payloads.length === 1 ? payloads[0].name : `[${payloads.map((slot) => slot.name).join(", ")}]`}`,
      // success 必有
      `success: ${success.source}`,
      // error：无则省略
      errorSlots.length === 0
        // 省略
        ? undefined
        // 单个直接引用，多个用数组
        : `error: ${errorSlots.length === 1 ? errorSlots[0].name : `[${errorSlots.map((slot) => slot.name).join(", ")}]`}`,
    // 过滤省略项
    ].filter((option): option is string => option !== undefined)
    // 来源 → 槽位映射（输入类型用）
    const schemaBySource = { params, query, headers, payload: payloads[0] }
    // 生成端点输入类型
    const inputType = operation.input
      // 逐字段
      .map((field) => {
        // 取来源槽位
        const slot = schemaBySource[field.source]
        // 缺槽位报错
        if (slot === undefined) {
          // 抛出缺失输入 schema
          throw new GenerationError({ reason: `Missing input schema: ${group.identifier}.${endpoint.identifier}` })
        }
        // 字段类型：不透明 payload 用整个槽位类型，否则索引到字段
        return `readonly ${JSON.stringify(field.name)}${field.optional ? "?" : ""}: ${isOpaquePayload(operation) && field.source === "payload" ? `typeof ${slot.name}.Type` : `(typeof ${slot.name}.Type)[${JSON.stringify(field.name)}]`}`
      })
      // 分号拼接
      .join("; ")
    // 适配器入参签名
    const argument =
      // 无输入无参
      operation.operation.inputMode === "none"
        // 可选加 ?
        ? ""
        : `input${operation.operation.inputMode === "optional" ? "?" : ""}: ${prefix}Input`
    // 生成 raw 调用实参（四来源）
    const request = (["params", "query", "headers", "payload"] as const)
      // 逐来源渲染
      .map((source) =>
        // 传输入与模式
        renderEffectRequestPart(
          // 不透明 payload
          operation.input,
          // 来源槽位存在性
          operation.operation.inputMode,
          // 过滤省略
          source,
          // 逗号拼接
          isOpaquePayload(operation),
          schemaBySource[source] !== undefined,
        ),
      )
      .filter((part): part is string => part !== undefined)
      .join(", ")
    // 声明的错误槽位（含流错误）
    const declared = [...errorSlots, ...(success.streamError === undefined ? [] : [success.streamError])]
    // 声明错误 schema：空为 Never，否则 Union
    const declaredSchema =
      // 拼装 Union
      declared.length === 0 ? "Schema.Never" : `Schema.Union([${declared.map((slot) => slot.name).join(", ")}])`
    // 是否不透明 payload
    const opaquePayload = isOpaquePayload(operation)
    // HttpApiClient distributes union payloads into union request objects, while rebuilding a flattened input
    // produces one object containing a union value. The shapes are equivalent but TypeScript cannot correlate them.
    // raw 调用（不透明 payload 断言为 Request 形状）
    const rawCall = `raw[${JSON.stringify(endpoint.identifier)}]({ ${request} }${opaquePayload ? ` as ${prefix}Request` : ""})`
    // 映射错误 + 可选解包 data
    const mapped = `${rawCall}.pipe(Effect.mapError(map${prefix}Error)${operation.unwrapData ? ", Effect.map((value) => value.data)" : ""})`
    // 输入类型声明（不透明 payload 额外声明 Request）
    const inputDeclaration =
      // 无输入无声明
      operation.operation.inputMode === "none"
        // Request 类型（交叉响应模式标记）
        ? ""
        // Input 类型声明
        : `${opaquePayload ? `type ${prefix}Request = Parameters<RawGroup[${JSON.stringify(endpoint.identifier)}]>[0] & { readonly responseMode?: "decoded-only" }\n` : ""}type ${prefix}Input = { ${inputType} }\n`
    // 收录适配器全文
    adapters.push(
      // 适配器文本（声明错误 + 错误映射函数 + 端点工厂）
      `${inputDeclaration}const ${prefix}DeclaredError = ${declaredSchema}\nconst map${prefix}Error = (error: unknown) => HttpClientError.isHttpClientError(error) || Schema.isSchemaError(error) || Sse.Retry.is(error) ? new ClientError({ cause: error }) : Schema.is(${prefix}DeclaredError)(error) ? error : new ClientError({ cause: error })\nconst ${prefix} = (raw: RawGroup) => (${argument}) => ${operation.operation.success === "stream" ? `Stream.unwrap(${rawCall}.pipe(Effect.mapError(map${prefix}Error), Effect.map((stream) => stream.pipe(Stream.mapError(map${prefix}Error)))))` : mapped}`,
    )
    // 端点声明源码（HttpApiEndpoint.make 链）
    return `HttpApiEndpoint.make(${JSON.stringify(endpoint.method)})(${JSON.stringify(endpoint.identifier)}, ${JSON.stringify(endpoint.path)}, { ${options.join(", ")} })`
  })

  // addSlot：登记 schema 槽位（undefined 跳过）
  function addSlot(schema: Schema.Top | undefined, name: string) {
    // 无 schema 返回 undefined
    if (schema === undefined) return undefined
    // 组装槽位
    const slot = { name, schema }
    // 收录
    slots.push(slot)
    // 返回槽位
    return slot
  }

  // renderSuccess：渲染成功响应（流需拆 data/error 槽位并标注状态码）
  function renderSuccess(schema: Schema.Top, name: string) {
    // 非流：直接登记槽位
    if (!isStreamSchema(schema)) return { source: addSlot(schema, name)!.name }
    // 解析状态码（默认 200）
    const status = resolveHttpApiStatus(schema.ast) ?? 200
    // 非 200 时追加 status 注解
    const annotate = status === 200 ? "" : `.pipe(HttpApiSchema.status(${status}))`
    // 二进制流
    if (schema._tag === "StreamUint8Array") {
      // 返回 StreamUint8Array 构造
      return {
        // 带 content-type
        source: `HttpApiSchema.StreamUint8Array({ contentType: ${JSON.stringify(schema.contentType)} })${annotate}`,
      }
    }
    // SSE 流：登记载荷槽位
    const value = addSlot(
      // data 模式取 data，events 取事件联合
      schema.sseMode === "data" ? streamDataSchema(schema) : Schema.make<Schema.Top>(schema.events.ast),
      // 槽位名后缀
      `${name}${schema.sseMode === "data" ? "Data" : "Events"}`,
    )!
    // 错误槽位
    const error = addSlot(schema.error, `${name}Error`)!
    // 返回构造源码与错误槽位
    return {
      // StreamSse 构造（含 contentType 与状态注解）
      source: `HttpApiSchema.StreamSse({ ${schema.sseMode}: ${value.name}, error: ${error.name}, contentType: ${JSON.stringify(schema.contentType)} })${annotate}`,
      // 附带错误槽位（供声明错误用）
      streamError: error,
    }
  }

  // 渲染全部 schema 声明
  const declarations = renderSchemas(slots)
  // 分组定义源码（make + 逐端点 add）
  const groupSource = `HttpApiGroup.make(${JSON.stringify(group.identifier)}, { topLevel: ${group.endpoints[0]?.topLevel ?? false} })${endpointSources.map((endpoint) => `.add(${endpoint})`).join("")}`
  // 是否用到 HttpApiSchema（决定导入）
  const usesHttpApiSchema = endpointSources.some((source) => source.includes("HttpApiSchema."))
  // 渲染客户端方法树
  const methods = renderClientTree(
    // 端点 → 适配器调用
    group.endpoints,
    // 字段渲染
    (item) => `Endpoint${item.clientPath.map(identifierPart).join("")}(raw)`,
    // 逗号分隔
    (name, value) => `${JSON.stringify(name)}: ${value}`,
    ", ",
  )
  // 分组类型名
  const name = groupTypeName(group)
  // raw 客户端类型：顶层用整个 Client，否则分组客户端
  const rawGroup = group.endpoints[0]?.topLevel
    // 顶层
    ? `HttpApiClient.Client<typeof Group${name}>`
    // 分组
    : `HttpApiClient.Client.Group<typeof Group${name}, never, never>`
  // 是否有流端点（决定导入 Stream）
  const usesStream = group.endpoints.some((item) => item.operation.success === "stream")
  // 分组文件全文（导入/声明/分组/适配器/出口）
  return `// Generated by @opencode/httpapi-codegen. Do not edit.\nimport { Effect, Schema${usesStream ? ", Stream" : ""} } from "effect"\nimport { Sse } from "effect/encoding"\nimport { HttpClientError } from "effect/http"\nimport { HttpApiClient, HttpApiEndpoint, HttpApiGroup${usesHttpApiSchema ? ", HttpApiSchema" : ""} } from "effect/http-api"\nimport { ClientError } from "./client-error.js"\n\n${declarations}\n\nexport const Group${name} = ${groupSource}\n\ntype RawGroup = ${rawGroup}\n\n${adapters.join("\n\n")}\n\nexport const adaptGroup${name} = (raw: RawGroup) => ({ ${methods} })\n`
}

// renderEffectRequestPart：渲染 raw 调用的单来源实参（无字段时可省略或空对象）
function renderEffectRequestPart(
  // 输入字段
  input: Endpoint["input"],
  // 输入模式
  mode: Operation["inputMode"],
  // 来源
  source: InputField["source"],
  // 是否不透明 payload
  opaquePayload: boolean,
  // 来源 schema 是否存在（默认不存在）
  present = false,
) {
  // 过滤该来源字段
  const fields = input.filter((field) => field.source === source)
  // 无字段：存在则空对象，否则省略
  if (fields.length === 0) return present ? `${source}: { }` : undefined
  // 字段访问（可选模式用 ?.）
  const access = (name: string) => `input${mode === "optional" ? "?." : ""}[${JSON.stringify(name)}]`
  // 不透明 payload 直接传字段值
  if (opaquePayload && source === "payload") return `${source}: ${access(fields[0].name)}`
  // 组装对象字面量
  return `${source}: { ${fields.map((field) => `${JSON.stringify(field.name)}: ${access(field.name)}`).join(", ")} }`
}

// renderSchemas：把槽位渲染成 const/class 声明（tagged 错误生成为 class）
function renderSchemas(slots: ReadonlyArray<Slot>) {
  // 无槽位返回空
  if (slots.length === 0) return ""
  // 槽位下标 → tagged 错误信息
  const classes = new Map(
    // 遍历槽位
    slots.flatMap((slot, index) => {
      // 提取 tagged 信息
      const tagged = taggedErrorFields(slot.schema)
      // 非 tagged 跳过
      return tagged === undefined ? [] : [[index, tagged] as const]
    }),
  )
  // 展开槽位：tagged 错误改用 Never 占位 + 按字段拆出子槽位
  const expanded = [
    // tagged 槽位用 Never 占位
    ...slots.map((slot, index) => (classes.has(index) ? { name: slot.name, schema: Schema.Never } : slot)),
    // 每个字段一个子槽位
    ...Array.from(classes.values()).flatMap((tagged, classIndex) =>
      // 子槽位命名
      tagged.fields.map(([name, schema]) => ({ name: `Class${classIndex}${name}`, schema })),
    ),
  ]
  // 生成表示
  const document = SchemaRepresentation.toCodeDocument(
    // 转换 AST
    SchemaRepresentation.toRepresentations(
      // 逐槽位标注状态码
      codegenAsts(
        expanded.map((slot) => slot.schema.annotate({ httpApiStatus: resolveHttpApiStatus(slot.schema.ast) }).ast),
      // 生成文档
      ) as [SchemaAST.AST, ...Array<SchemaAST.AST>],
    ),
  )
  // artifact：导入声明/枚举/运行时常量
  const artifacts = document.artifacts.flatMap((artifact) => {
    // 导入声明
    if (artifact._tag === "Import") return [artifact.importDeclaration]
    // 枚举用其 runtime
    if (artifact._tag === "Enum") return [artifact.code.runtime]
    // 其余生成为 const
    return [`const ${artifact.identifier} = ${artifact.code.runtime}`]
  })
  // 引用声明（非递归为 const，递归为 type + Codec）
  const references = [
    // 非递归
    ...document.references.nonRecursives.map(({ $ref, code }) => `const ${$ref} = ${code.runtime}`),
    // 递归：类型 + 编解码器
    ...Object.entries(document.references.recursives).map(
      ([$ref, code]) => `type ${$ref} = ${code.Type}\nconst ${$ref}: Schema.Codec<${$ref}> = ${code.runtime}`,
    ),
  ]
  // 字段子槽位下标从槽位总数起
  let fieldIndex = slots.length
  // 逐槽位生成声明
  const declarations = slots.map((slot, index) => {
    // 取 tagged 信息
    const tagged = classes.get(index)
    // 非 tagged：直接 const
    if (tagged === undefined) return `const ${slot.name} = ${document.codes[index].runtime}`
    // tagged：字段引用子槽位
    const fields = tagged.fields
      // 逐字段取 runtime
      .map(([name]) => `${JSON.stringify(name)}: ${document.codes[fieldIndex++].runtime}`)
      // 逗号拼接
      .join(", ")
    // 收集非 undefined 的注解（状态/编码）
    const annotations = Object.entries({
      // 状态码
      httpApiStatus: resolveHttpApiStatus(slot.schema.ast),
      // 编码
      "~httpApiEncoding": resolveHttpApiEncoding(slot.schema.ast),
    // 过滤 undefined
    }).filter((entry) => entry[1] !== undefined)
    // 生成 annotate 链
    const annotate =
      // 无注解为空
      annotations.length === 0
        // JSON 化键值
        ? ""
        : `.annotate({ ${annotations.map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(", ")} })`
    // 生成 class + const 别名（带注解）
    return `class ${slot.name}Class extends Schema.TaggedError<${slot.name}Class>(${JSON.stringify(tagged.identifier)})(${JSON.stringify(tagged.tag)}, { ${fields} }) {}\nconst ${slot.name} = ${slot.name}Class${annotate}`
  })
  // 拼接全文
  return [...artifacts, ...references, ...declarations].join("\n\n")
}

// renderClient：渲染内联 Effect 客户端的 client.ts（分组聚合 + 工厂）
function renderClient(groups: ReadonlyArray<Group>, aliases: ReadonlyArray<Alias>) {
  // 分组导入语句
  const imports = groups
    // 逐分组
    .map(
      // 导入 adaptGroup 与 Group
      (group) =>
        // 模块路径
        `import { adaptGroup${groupTypeName(group)}, Group${groupTypeName(group)} } from ${JSON.stringify(`./${group.module}`)}`,
    )
    // Api 声明：make + 逐分组 add
    .join("\n")
  // 拼装 add 链
  const api = `HttpApi.make("generated")${groups.map((group) => `.add(Group${groupTypeName(group)})`).join("")}`
  // 渲染根字段
  const fields = renderGroupTree(
    // 对每个分组：
    groups,
    (group) => {
      // 判断分组是否顶层
      if (!group.endpoints[0]?.topLevel) {
        // 非顶层分组：整体适配（按分组标识取 raw）
        return { whole: `adaptGroup${groupTypeName(group)}(raw[${JSON.stringify(group.identifier)}])` }
      }
      // 组装 raw 映射
      const raw = `{ ${group.endpoints.map((item) => `${JSON.stringify(item.endpoint.identifier)}: raw[${JSON.stringify(item.endpoint.identifier)}]`).join(", ")} }`
      // 摊开适配结果
      return { fields: `...adaptGroup${groupTypeName(group)}(${raw})` }
    },
    // 字段渲染
    (name, value) => `${JSON.stringify(name)}: ${value}`,
    // 展开合并
    spreadObject,
    // 逗号分隔
    ", ",
  )
  // client.ts 全文（含 adaptClient 与 make 工厂）
  return `// Generated by @opencode/httpapi-codegen. Do not edit.\nimport { Effect } from "effect"\nimport { HttpApi, HttpApiClient } from "effect/http-api"\n${imports}\n\nconst Api = ${api}\nconst adaptClient = ${aliases.length === 0 ? `(raw: HttpApiClient.ForApi<typeof Api>) => ({ ${fields} })` : `(raw: HttpApiClient.ForApi<typeof Api>) => {\n  const client = { ${fields} }\n  return ${renderAliasedClient(groups, aliases, "client")}\n}`}\n\nexport const make = (options?: { readonly baseUrl?: URL | string }) =>\n  HttpApiClient.make(Api, options).pipe(Effect.map(adaptClient))\n`
}
