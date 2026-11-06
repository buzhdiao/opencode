// 引入 Effect 的上下文、Effect 与追踪器
import { Context, Effect, Tracer } from "effect"

// ParentSpan 是可选的，因此移除它不会给 effect 增加任何新的环境要求。
// ParentSpan is optional, so removing it never takes away a requirement of the effect.
// 从 effect 的上下文中移除父级 Span（ParentSpan），用于切断与外层的追踪继承链
export const withoutParentSpan = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  // 用 pipe 对 effect 做上下文变换
  effect.pipe(
    // 更新 effect 所需的上下文
    Effect.updateContext(
      // 从上下文中省略 ParentSpan 条目；类型上仍断言为原来的 R（因为 ParentSpan 本就可选）
      (context: Context.Context<R>) => Context.omit(Tracer.ParentSpan)(context) as Context.Context<R>,
    ),
  )
