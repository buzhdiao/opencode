// 导出 ClaudeStatus 命名空间，供其他模块引用本文件内容
export * as ClaudeStatus from "./status.js"

// 从 effect 库导入 Effect、Semaphore（信号量）与 SubscriptionRef（可订阅的响应式引用）
import { Effect, Semaphore, SubscriptionRef } from "effect"
// 导入 Claude IO 接口类型
import type { ClaudeIO } from "./io.js"
// 导入探测（probe）模块：用于实际检查 claude 登录状态
import { ClaudeProbe } from "./probe.js"
// 导入查询选项构造模块
import { ClaudeQueryOptions } from "./query-options.js"

// 状态机类型：检查中 / 未安装 / 失败（含原因）/ 就绪（含探测结果）
export type State =
  | { readonly type: "checking" }
  | { readonly type: "missing" }
  | { readonly type: "failed"; readonly message: string }
  | { readonly type: "ready"; readonly probe: ClaudeProbe.Result }

// ClaudeStatus 的接口：暴露响应式状态、手动刷新方法、以及聊天进程回填状态的方法
export interface Interface {
  // 可订阅的状态引用，监听者会收到状态变更
  readonly state: SubscriptionRef.SubscriptionRef<State>
  // 主动重新检测 claude 的可用性与登录状态
  readonly refresh: () => Effect.Effect<void>
  // 聊天自身进程启动时探测到的状态，用它来更新全局状态
  // What a chat's own process found when it started
  readonly report: (next: State) => Effect.Effect<void>
}

// 工厂函数：构造 ClaudeStatus 实现
export const make = Effect.fn("ClaudeStatus.make")(function* (
  // Claude IO 抽象（用于定位/执行 claude 二进制）
  io: ClaudeIO.Interface,
  // 连接信息回调：返回当前凭据环境变量映射
  connection: () => Effect.Effect<Record<string, string>>,
) {
  // 创建响应式状态引用，初始为“检查中”
  const state = yield* SubscriptionRef.make<State>({ type: "checking" })
  // 创建并发度为 1 的信号量，用于串行化刷新操作
  const lock = yield* Semaphore.make(1)

  // 刷新操作被串行化：这样“启动后”的重连检查不会与携带更旧账号快照的检查产生竞态
  // Serialized so a reconnect checks again after startup, rather than racing it with an older account snapshot.
  const refresh = Effect.fn("ClaudeStatus.refresh")(function* () {
    // 在 PATH 中查找 claude 可执行文件
    const executable = io.which()
    // 找不到可执行文件：状态置为“未安装”
    if (!executable) return yield* SubscriptionRef.set(state, { type: "missing" })
    // 获取当前连接（凭据）环境
    const env = yield* connection()
    // 运行探测：成功则状态置为“就绪”并附带探测结果
    const next = yield* ClaudeProbe.run(ClaudeQueryOptions.base({ executable, io, connection: env })).pipe(
      Effect.map((probe): State => ({ type: "ready", probe })),
      // 探测失败：记录警告日志，状态置为“失败”并附带错误信息
      Effect.catch((error) =>
        Effect.logWarning("Claude Code login check failed", { cause: error.cause }).pipe(
          Effect.as<State>({
            type: "failed",
            message: error.cause instanceof Error ? error.cause.message : String(error.cause),
          }),
        ),
      ),
    )
    // 把新状态写入响应式引用
    yield* SubscriptionRef.set(state, next)
  }, lock.withPermit)

  // report：直接把外部（聊天进程）上报的状态写入引用
  const report = (next: State) => SubscriptionRef.set(state, next)

  // 返回满足 Interface 的实现对象
  return { state, refresh, report } satisfies Interface
})
