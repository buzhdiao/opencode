// 以 Status 命名空间 re-export 本模块
export * as Status from "./service-status"

// 引入 Effect 与 Ref（可变引用）
import { Effect, Ref } from "effect"

// 服务状态类型：启动中（starting）/ 就绪（ready）/ 停止中（stopping）/ 失败（failed）
export type State =
  | { readonly type: "starting" }
  | { readonly type: "ready" }
  | { readonly type: "stopping" }
  | { readonly type: "failed" }

// 状态服务接口：读取当前状态与三个单向状态迁移
export interface Interface {
  // 读取当前状态
  readonly current: Effect.Effect<State>
  // 迁移到就绪（仅允许从 starting 进入）
  readonly ready: Effect.Effect<void>
  // 迁移到失败（仅允许从 starting 进入）
  readonly fail: Effect.Effect<void>
  // 迁移到停止中（任意状态均可进入，幂等）
  readonly beginStopping: Effect.Effect<void>
}

// 构建状态服务实例（默认初始状态为 starting）
export const make = Effect.fnUntraced(function* (options: { readonly initial?: State } = {}) {
  // 创建保存当前状态的 Ref，初始为 starting（或调用者指定的初始状态）
  const current = yield* Ref.make(options.initial ?? ({ type: "starting" } satisfies State))
  // 停止中迁移：已是 stopping 则保持不变，否则置为 stopping
  const beginStopping = Ref.update(current, (status) =>
    status.type === "stopping" ? status : ({ type: "stopping" } satisfies State),
  )

  // 返回满足接口的实现
  return {
    // 读取状态
    current: Ref.get(current),
    // 就绪迁移：仅 starting 可变为 ready，其余状态保持不变
    ready: Ref.update(current, (status) => (status.type === "starting" ? ({ type: "ready" } satisfies State) : status)),
    // 失败迁移：仅 starting 可变为 failed，其余状态保持不变
    fail: Ref.update(current, (status) => (status.type === "starting" ? ({ type: "failed" } satisfies State) : status)),
    // 停止中迁移
    beginStopping,
  } satisfies Interface
})
