// 导入 Effect（函数式效果运行时）与 Layer（服务层构造器）
import { Effect, Layer } from "effect"

// Status：V1 数据迁移的状态类型——本占位实现只会返回 completed
export type Status = { readonly status: "completed" }

// layer：空服务层（Layer.empty）——不提供任何服务，等于跳过 V1 迁移的准备工作
export const layer = Layer.empty
// status：返回已完成状态的效果（Effect），供查询迁移进度
export function status() {
  // 直接以常量结果成功完成
  return Effect.succeed({ status: "completed" } as const)
}
// run：执行 V1 数据迁移的入口——本实现为空操作（noop），立即返回完成
export function run() {
  // 不做任何实际迁移，直接成功结束
  return Effect.succeed({ status: "completed" } as const)
}
