// 将本模块以命名空间（namespace）形式导出为 Rpc
export * as Rpc from "./rpc.js"
// 转发导出 RPC 定义构造器
export { define } from "@opencode/schema/rpc"
// 转发导出定义、事件负载与失败相关的类型
export type { Definition, EventPayload, Failure } from "@opencode/schema/rpc"

// 导入 RPC 客户端、域与处理器类型
import type { RpcClient, RpcDomain, RpcHandlers } from "@opencode/plugin/effect/rpc"
// 导入 RPC 基础类型
import type { Rpc } from "@opencode/schema/rpc"
// 导入事件 schema（用于构造 RPC 事件定义）
import { Event } from "@opencode/schema/event"
// 导入工具值 schema 类型
import type { Tool } from "@opencode/schema/tool"
// 导入 Standard Schema 规范类型
import type { StandardSchemaV1 } from "@standard-schema/spec"
// 导入构建分层节点的辅助函数
import { makeLocationNode } from "@opencode/util/effect/app-node"
// 从 effect 导入上下文、Deferred、Effect、JsonSchema、Layer、Schema 等
import { Context, Deferred, Effect, JsonSchema, Layer, Schema, SchemaRepresentation, Stream } from "effect"
// 导入事件总线（Bus）服务
import { Bus } from "./bus.js"
// 导入位置（Location）服务
import { Location } from "./location.js"
// 导入通用 schema 工具
import { optional, statics } from "./schema.js"

// 服务接口：注册 RPC 处理器、构造类型化客户端、按名称调用、关闭
export interface Interface {
  // 注册一个 RPC 定义及其处理器
  readonly register: RpcDomain["register"]
  // 根据定义构造类型化的 RPC 客户端
  readonly client: <D extends Rpc.Definition>(definition: D) => RpcClient<D, Rpc.SystemError, never, unknown>
  // 按 RPC ID 与方法名直接调用
  readonly call: (rpcID: string, method: string, input: unknown) => Effect.Effect<unknown, Rpc.Failure>
  // 关闭 RPC 服务（此后所有调用失败）
  readonly close: Effect.Effect<void>
}

// 定义 Rpc 服务
export class Service extends Context.Service<Service, Interface>()("@opencode/Rpc") {}

// 声明过的错误类型：处理器通过它抛出带类型标签的业务错误
class DeclaredError extends Error {
  constructor(
    // 错误类型标签，需与定义中声明的 errors 键匹配
    readonly type: string,
    message: string,
    // 可选的错误附加数据
    readonly data?: unknown,
  ) {
    super(message)
  }
}

// 服务实现层
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 依赖：事件总线
    const bus = yield* Bus.Service
    // 依赖：位置服务
    const location = yield* Location.Service
    // 构造当前目录/工作空间的位置引用
    const ref = Location.Ref.make({ directory: location.directory, workspaceID: location.workspaceID })
    // 关闭信号：完成后所有调用与长连接都会失败
    const closed = yield* Deferred.make<void>()
    // 调用上下文：传给处理器，用于抛出声明过的错误
    const callContext = {
      error: (type: string, message: string, data?: unknown) => new DeclaredError(type, message, data),
    }
    // 注册表：RPC ID -> 该 ID 下按序注册的 {定义, 处理器} 列表
    const registrations = new Map<
      string,
      Array<{
        readonly definition: Rpc.Definition
        readonly handlers: Readonly<Record<string, Function>>
      }>
    >()
    // 事件定义缓存：按 definition 弱引用，避免重复构建
    const definitions = new WeakMap<
      Rpc.Definition,
      ReadonlyMap<string, { readonly event: Rpc.EventDefinition; readonly definition: Event.Definition }>
    >()
    // 取得（并缓存）某定义下所有事件的总线事件定义
    const eventsFor = (definition: Rpc.Definition) => {
      // 已缓存则直接返回
      const existing = definitions.get(definition)
      if (existing) return existing
      // 将每个事件名映射为 {事件定义, 总线事件定义}
      const events = new Map(
        Object.entries(definition.events).map(([name, event]) => [
          name,
          { event, definition: eventDefinition(eventType(definition, name)) },
        ]),
      )
      // 写入缓存
      definitions.set(definition, events)
      return events
    }

    // 注册 RPC 定义与处理器；返回 { dispose, events.emit }
    const register = Effect.fn("Rpc.register")(function* <const D extends Rpc.Definition>(
      definition: D,
      handlers: RpcHandlers<NoInfer<D>>,
    ) {
      // 组装注册条目
      const entry = { definition, handlers }
      // 注销逻辑：从注册表中移除本条目；若该 ID 下已无条目则整键删除
      const dispose = Effect.sync(() => {
        const remaining = (registrations.get(definition.id) ?? []).filter((candidate) => candidate !== entry)
        if (remaining.length === 0) {
          registrations.delete(definition.id)
          return
        }
        registrations.set(definition.id, remaining)
      })
      // 以获取-释放（acquireRelease）语义登记，作用域结束时自动注销
      yield* Effect.acquireRelease(
        Effect.sync(() => registrations.set(definition.id, [...(registrations.get(definition.id) ?? []), entry])),
        () => dispose,
      )

      // 取得该定义的事件定义表
      const events = eventsFor(definition)
      // 返回注册句柄
      return {
        dispose,
        events: {
          // 发布 RPC 事件：按事件 schema 编码后写入总线
          emit: Effect.fn("Rpc.emit")(function* (...args: Rpc.EventInput<D>) {
            // 查找事件定义，未知事件则失败
            const registered = events.get(args[0])
            if (!registered) return yield* Effect.fail(new Error(`Unknown RPC event: ${definition.id}.${args[0]}`))
            // 取事件定义
            const event = registered.event
            // SAFETY: The public event-schema contract guarantees an object encoded/output type.
            // 编码事件数据（契约保证为对象类型）
            // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
            const data = (yield* encode(event.schema, args[1])) as Readonly<Record<string, unknown>>
            // 发布到总线（带位置引用），结果转为 void
            return yield* bus
              .publish(registered.definition, data, {
                location: ref,
              })
              .pipe(Effect.asVoid)
          }),
        },
      }
    })

    // 按名称调用已注册的 RPC 方法：解析 -> 执行 -> 错误归一 -> 输出编码
    const call = Effect.fn("Rpc.call")(function* (rpcID: string, name: string, input: unknown) {
      // 服务已关闭则不可用
      if (yield* Deferred.isDone(closed))
        return yield* Effect.fail(failure("rpc.unavailable", `RPC is unavailable: ${rpcID}`))
      // 取该 RPC ID 下最后一次注册的条目
      const entry = registrations.get(rpcID)?.at(-1)
      // 未注册则不可用
      if (!entry) return yield* Effect.fail(failure("rpc.unavailable", `RPC is unavailable: ${rpcID}`))
      // 定义或处理器中都不存在该方法时报方法未找到
      if (!Object.hasOwn(entry.definition.methods, name) || !Object.hasOwn(entry.handlers, name))
        return yield* Effect.fail(failure("rpc.method_not_found", `Unknown RPC method: ${rpcID}.${name}`))
      // 取方法定义与处理器
      const method = entry.definition.methods[name]
      const handler = entry.handlers[name]
      // 按方法输入 schema 校验入参
      const parsed = yield* parse(method.input, input).pipe(
        Effect.mapError((error) => failure("rpc.invalid_input", errorMessage(error, "Invalid RPC input"))),
      )
      // 执行处理器，统一处理错误、缺陷与关闭竞争
      const result = yield* Effect.suspend(() => {
        // The heterogeneous registry erases handlers after their selected schema validates input.
        // 注册表抹掉了处理器类型，这里按 unknown 效果执行
        const execution: Effect.Effect<unknown, unknown> = handler(parsed, callContext)
        return execution
      }).pipe(
        // 将 DeclaredError 转为 Rpc.Failure；未声明的错误视为致命缺陷
        Effect.catch((error) => encodeError(method, error)),
        // Normalize handler bugs here so direct callers can recover just like HTTP callers.
        // 处理器缺陷（bug）在这里归一为内部错误，让调用方可恢复
        Effect.catchDefect((defect) =>
          Effect.logError("rpc handler failed", { rpc: rpcID, method: name, defect }).pipe(
            Effect.andThen(Effect.fail(failure("rpc.internal", "RPC call failed"))),
          ),
        ),
        // A long-lived RPC must release its location when the routing cache invalidates it.
        // 服务关闭时让长连接立即以“不可用”失败
        Effect.raceFirst(
          Deferred.await(closed).pipe(
            Effect.andThen(Effect.fail(failure("rpc.unavailable", `RPC is unavailable: ${rpcID}`))),
          ),
        ),
      )
      // 按方法输出 schema 编码结果
      return yield* encode(method.output, result).pipe(
        Effect.mapError((error) => failure("rpc.invalid_output", errorMessage(error, "Invalid RPC output"))),
      )
    })

    // 根据定义构造类型化客户端：方法代理 + 事件订阅
    const client = <D extends Rpc.Definition>(definition: D): RpcClient<D, Rpc.SystemError, never, unknown> => {
      // 取该定义的事件定义表
      const events = eventsFor(definition)
      // 将每个方法映射为经过错误解码与输出解码的调用
      const methods = Object.fromEntries(
        Object.entries(definition.methods).map(([name, method]) => [
          name,
          (input: unknown) =>
            call(definition.id, name, input).pipe(
              // 将声明过的错误解码为类型化失败
              Effect.catch((error) => decodeError(method, error)),
              // 输出按 schema 解码；解码失败视为致命缺陷
              Effect.flatMap((value) => read(method.output, value).pipe(Effect.catch((cause) => Effect.die(cause)))),
            ),
        ]),
      )
      // SAFETY: Every runtime key comes from this definition, and each method delegates through its corresponding schema.
      // 返回客户端对象
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      return {
        ...methods,
        events: {
          // 订阅 RPC 事件：过滤总线并转换为逻辑事件负载
          subscribe: <Name extends keyof D["events"] & string>(name: Name) => {
            // 未知事件则返回失败流
            const registered = events.get(name)
            if (!registered) return Stream.fail(new Error(`Unknown RPC event: ${definition.id}.${name}`))
            // 订阅总线事件流，注入位置服务并转换为逻辑事件
            return bus.subscribe(registered.definition).pipe(
              Stream.provideService(Location.Service, location),
              Stream.mapEffect((payload) => logicalEvent(definition, name, payload, ref)),
            )
          },
        },
      } as RpcClient<D, Rpc.SystemError, never, unknown>
    }

    // 组装并返回服务实现；close 通过完成 Deferred 触发全局关闭
    return Service.of({ register, call, client, close: Deferred.succeed(closed, undefined).pipe(Effect.asVoid) })
  }),
)

// 构建 Rpc 的分层节点，声明其依赖的节点
export const node = makeLocationNode({ service: Service, layer, deps: [Bus.node, Location.node] })

// RPC 事件信封的公共字段
const fields = {
  // 事件 ID
  id: Event.ID,
  // 创建时间（有限数值）
  created: Schema.Finite,
  // 可选元数据记录
  metadata: optional(Schema.Record(Schema.String, Schema.Unknown)),
  // 可选位置引用
  location: optional(Location.Ref),
}
// 事件数据体：任意字符串键的未知值记录
const EventData = Schema.Record(Schema.String, Schema.Unknown)
// JSON Schema 到 Effect 编解码器的缓存（按 schema 弱引用）
const jsonSchemas = new WeakMap<JsonSchema.JsonSchema, Schema.Codec<unknown>>()

// 生成 RPC 事件的类型名：rpc.<定义ID>.<事件名>
function eventType<const D extends Rpc.Definition, const Name extends keyof D["events"] & string>(
  definition: D,
  name: Name,
): `rpc.${D["id"]}.${Name}` {
  return `rpc.${definition.id}.${name}`
}

// 构造 RPC 事件的总线事件定义（临时/ephemeral，不持久化）
export function eventDefinition(type: `rpc.${string}`): Event.Definition {
  // 数据体 schema
  const data = EventData
  // 组合公共字段 + 字面量类型 + 数据体，并附带静态元信息
  return Schema.Struct({ ...fields, type: Schema.Literal(type), data }).pipe(
    statics(() => ({ type, durability: "ephemeral" as const, durable: undefined, data })),
  ) satisfies Event.EphemeralDefinition<string, typeof data>
}

// 输入解析：支持 Effect Schema、Standard Schema 与 JSON Schema 三种形态
function parse(schema: Tool.ValueSchema, value: unknown): Effect.Effect<unknown, unknown> {
  // Effect Schema：直接解码
  if (Schema.isSchema(schema)) return Schema.decodeUnknownEffect(schema)(value)
  // Standard Schema：走 ~standard.validate 协议（可能是同步或 Promise）
  if (isStandardSchema(schema)) {
    return Effect.gen(function* () {
      // 同步调用校验，异常转为失败
      const parsed = yield* Effect.try({ try: () => schema["~standard"].validate(value), catch: (cause) => cause })
      // 返回值为 Promise 时等待其完成
      const result =
        parsed instanceof Promise ? yield* Effect.tryPromise({ try: () => parsed, catch: (cause) => cause }) : parsed
      // 存在校验问题（issues）则合并消息后失败
      if (result.issues) return yield* Effect.fail(new Error(result.issues.map((issue) => issue.message).join("\n")))
      // 返回校验后的值
      return result.value
    })
  }
  // 其余视为 JSON Schema：构建（并缓存）对应编解码器后解码
  return Effect.try({
    try: () => {
      // 命中缓存则直接复用
      const existing = jsonSchemas.get(schema)
      if (existing) return existing
      // 从 Draft 2020-12 JSON Schema 文档构建 Effect 编解码器
      const codec = Schema.make<Schema.Codec<unknown>>(
        SchemaRepresentation.fromJsonSchemaDocument(JsonSchema.fromSchemaDraft2020_12(schema)).ast,
      )
      // 写入缓存
      jsonSchemas.set(schema, codec)
      return codec
    },
    catch: (cause) => cause,
  }).pipe(Effect.flatMap((codec) => Schema.decodeUnknownEffect(codec)(value)))
}

// 输出编码：Effect Schema 走编码，其余（Standard/JSON Schema）复用 parse
function encode(schema: Tool.ValueSchema, value: unknown): Effect.Effect<unknown, unknown> {
  return Schema.isSchema(schema) ? Schema.encodeUnknownEffect(schema)(value) : parse(schema, value)
}

// 将处理器抛出的 DeclaredError 编码为类型化 Rpc.Failure；未声明的错误视为致命缺陷
function encodeError(method: Rpc.Method, error: unknown): Effect.Effect<never, Rpc.Failure> {
  // 不是声明过的错误则直接上抛为缺陷
  if (!(error instanceof DeclaredError)) return Effect.die(error)
  // 方法未声明该错误类型时视为编程错误
  if (!method.errors || !Object.hasOwn(method.errors, error.type)) {
    return Effect.die(new Error(`Undeclared RPC error: ${error.type}`))
  }
  // 按声明的错误 schema 编码附加数据
  return encode(method.errors[error.type], error.data).pipe(
    // 编码失败视为致命缺陷
    Effect.catch((cause) => Effect.die(cause)),
    // 成功则构造类型化失败
    Effect.flatMap((data) => Effect.fail(failure(error.type, error.message, data))),
  )
}

// 客户端侧：将 Rpc.Failure 按声明解码为类型化失败
function decodeError(method: Rpc.Method, error: Rpc.Failure): Effect.Effect<never, Rpc.Failure> {
  // 未声明该错误类型则原样透传
  if (!method.errors || !Object.hasOwn(method.errors, error.type)) return Effect.fail(error)
  // 按声明的错误 schema 读取附加数据
  return read(method.errors[error.type], error.data).pipe(
    // 读取失败视为致命缺陷
    Effect.catch((cause) => Effect.die(cause)),
    // 成功则重建类型化失败
    Effect.flatMap((data) => Effect.fail(failure(error.type, error.message, data))),
  )
}

// 构造 Rpc.Failure 对象：无附加数据时省略 data 字段
function failure(type: string, message: string, data?: unknown): Rpc.Failure {
  return data === undefined ? { type, message } : { type, message, data }
}

// 从未知错误中提取消息文本，取不到时使用兜底文案
function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  return fallback
}

// 判断 schema 是否实现了 Standard Schema 协议
function isStandardSchema(schema: Tool.ValueSchema): schema is Extract<Tool.ValueSchema, StandardSchemaV1> {
  return "~standard" in schema
}

// 输出读取：Effect Schema 需要解码；Standard Schema 的结果在发布侧已解析过，直接透传
function read(schema: Tool.ValueSchema, value: unknown): Effect.Effect<unknown, unknown> {
  // Standard Schema results were already parsed by the publisher; don't apply transforms twice.
  return Schema.isSchema(schema) ? Schema.decodeUnknownEffect(schema)(value) : Effect.succeed(value)
}

// 将总线原始事件负载转换为对外公开的 RPC 逻辑事件负载
const logicalEvent = Effect.fn("Rpc.logicalEvent")(function* <
  D extends Rpc.Definition,
  Name extends keyof D["events"] & string,
>(
  definition: D,
  name: Name,
  payload: Event.Payload,
  ref: Location.Ref,
): Effect.fn.Return<Rpc.EventPayload<D, Name>, unknown> {
  // 取事件定义
  const event = definition.events[name]
  // 按事件 schema 读取（解码）数据体
  const data = yield* read(event.schema, payload.data)
  // SAFETY: The private Bus definition owns the envelope and location.
  // 重建事件负载：写入完整的类型名与位置引用
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return {
    ...payload,
    type: eventType(definition, name),
    data,
    location: ref,
  } as Rpc.EventPayload<D, Name>
})
