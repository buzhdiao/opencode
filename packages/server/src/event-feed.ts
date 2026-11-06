// 将本文件的所有导出聚合到命名空间 EventFeed 下，供统一引入
export * as EventFeed from "./event-feed"

// 核心事件总线
import { Bus } from "@opencode/core/bus"
// 事件 Schema（事件 ID 等）
import { Event } from "@opencode/schema/event"
// 公共事件类型与守卫函数
import { isOpenCodeEvent, type OpenCodeEvent } from "@opencode/protocol/groups/event"
// effect 库：Cause 错误因、Context、Effect、Layer、Queue 队列、Schema、Scope、Stream 流
import { Cause, Context, Effect, Layer, Queue, Schema, Scope, Stream } from "effect"

// 每个订阅者队列的默认容量
export const SubscriberCapacity = 4_096

// 错误：订阅者队列溢出
export class SubscriberOverflowError extends Schema.TaggedError<SubscriberOverflowError>()(
  "EventFeed.SubscriberOverflow",
  // 触发溢出的容量值
  { capacity: Schema.Int },
) {}

// 错误：事件编码失败
export class EncodingError extends Schema.TaggedError<EncodingError>()("EventFeed.EncodingError", {
  // 出错的事件 ID
  eventID: Event.ID,
  // 出错的事件类型
  eventType: Schema.String,
  // 编码失败的原始原因
  cause: Schema.Defect(),
}) {}

// 事件流可能出现的错误联合
export type Error = SubscriberOverflowError | EncodingError

// 服务接口：订阅事件流（可选按类型过滤）
export interface Interface {
  // 订阅：返回编码后的 SSE 事件帧流（依赖 Scope 管理生命周期）
  readonly subscribe: (types?: ReadonlyArray<string>) => Effect.Effect<Stream.Stream<string, Error>, never, Scope.Scope>
}

// 服务定义（Context.Service）
export class Service extends Context.Service<Service, Interface>()("@opencode/server/EventFeed") {}

// 把事件渲染为 SSE 帧（"data: {...}\n\n"）
export function frame(event: OpenCodeEvent) {
  // JSON 序列化并按 SSE 格式封装
  return `data: ${JSON.stringify(event)}\n\n`
}

// 构建事件馈送服务：订阅总线并扇出到各订阅者队列
export const make = Effect.fn("EventFeed.make")(function* (
  // 挂载总线观察者的回调（返回取消订阅函数）
  observe: (subscriber: Bus.Subscriber) => Effect.Effect<Bus.Unsubscribe>,
  // 可选项：队列容量与自定义编码函数
  options?: { readonly capacity?: number; readonly encode?: (event: OpenCodeEvent) => string },
) {
  // 队列容量：入参或默认值
  const capacity = options?.capacity ?? SubscriberCapacity
  // 事件渲染函数：自定义或默认 SSE 帧
  const render = options?.encode ?? frame
  // 订阅者表：队列 → 类型过滤集合（undefined 表示不过滤）
  const subscribers = new Map<Queue.Queue<string, Error>, ReadonlySet<string> | undefined>()

  // 广播致命错误：清空订阅者并让所有队列失败
  const fail = (error: Error) =>
    Effect.sync(() => {
      // 取出当前全部队列
      const current = Array.from(subscribers.keys())
      // 清空订阅者表
      subscribers.clear()
      // 逐个让队列以错误终止
      for (const subscriber of current) Queue.failCauseUnsafe(subscriber, Cause.fail(error))
    })

  // 发布事件：编码一次并投递给匹配的订阅者
  const publish = Effect.fnUntraced(function* (event: Event.Payload) {
    // 非公开事件类型直接忽略
    if (!isOpenCodeEvent(event)) return
    // 编码缓存（惰性编码一次，多订阅者复用）
    let encoded: string | undefined
    // 遍历所有订阅者
    for (const [subscriber, types] of subscribers) {
      // 设置了类型过滤且不匹配时跳过
      if (types && !types.has(event.type)) continue
      // 首次需要时执行编码；失败则记录并广播致命错误
      encoded ??= yield* Effect.try({
        // 执行渲染
        try: () => render(event),
        // 编码失败构造 EncodingError
        catch: (cause) => new EncodingError({ eventID: event.id, eventType: event.type, cause }),
      }).pipe(
        // 捕获编码错误：记录日志后终止整个馈送
        Effect.catch((error) =>
          Effect.logError("Failed to encode public event", {
            // 事件 ID
            eventID: error.eventID,
            // 事件类型
            eventType: error.eventType,
            // 原始原因
            cause: error.cause,
          }).pipe(Effect.andThen(fail(error)), Effect.as(undefined)),
        ),
      )
      // 编码失败（已广播错误）时结束发布
      if (encoded === undefined) return
      // 投递成功则继续下一个订阅者
      if (Queue.offerUnsafe(subscriber, encoded)) continue
      // 队列已满：移除该订阅者并让其以溢出错误终止
      subscribers.delete(subscriber)
      Queue.failCauseUnsafe(subscriber, Cause.fail(new SubscriberOverflowError({ capacity })))
    }
  })

  // 把发布函数挂载到总线上（得到取消订阅函数）
  const unsubscribe = yield* observe(publish)
  // 注册作用域终结器：作用域关闭时取消订阅
  yield* Effect.addFinalizer(() => unsubscribe)

  // 返回服务实现
  return Service.of({
    // 订阅实现：创建受限队列并转换为流
    subscribe: (types) =>
      Effect.acquireRelease(
        // 创建容量受限（丢弃旧值）的队列
        Queue.dropping<string, Error>(capacity).pipe(
          // 创建后登记订阅者（带类型过滤集合）
          Effect.tap((queue) => Effect.sync(() => subscribers.set(queue, types?.length ? new Set(types) : undefined))),
        ),
        // 释放时：移除登记并关闭队列
        (queue) =>
          Effect.sync(() => subscribers.delete(queue)).pipe(Effect.andThen(Queue.shutdown(queue)), Effect.asVoid),
      ).pipe(Effect.map(Stream.fromQueue)),
  })
})

// 服务分层：从 Bus 服务构建事件馈送
export const layer = Layer.effect(
  // 目标服务
  Service,
  // 构造 effect
  Effect.gen(function* () {
    // 获取事件总线服务
    const bus = yield* Bus.Service
    // 以 bus.listen 作为观察者构建服务
    return yield* make(bus.listen)
  }),
)
