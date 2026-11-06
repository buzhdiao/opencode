// 将本模块以命名空间 `SubagentJob` 全量导出
export * as SubagentJob from "./subagent-job.js"

// 引入 Effect 的服务容器（Context）、核心原语、层（Layer）与作用域（Scope）
import { Context, Effect, Layer, Scope } from "effect"
// 引入应用节点的 Node 工具
import { Node } from "@opencode/util/effect/app-node"
// 引入层节点类型（仅类型）
import type { LayerNode } from "@opencode/util/effect/layer-node"
// 引入后台任务服务
import { Job } from "../job.js"
// 引入会话服务
import { Session } from "../session.js"
// 引入子代理完成投递模块
import { SubagentCompletion } from "./subagent-completion.js"

// 取 Job.Recovery 中 kind 为 "subagent" 的恢复信息类型
type Recovery = Extract<Job.Recovery, { kind: "subagent" }>

// 服务接口：启动、后台化与通知子代理任务
export interface Interface {
  start: (recovery: Recovery) => Effect.Effect<Job.Info>
  background: (recovery: Recovery) => Effect.Effect<void>
  notify: (recovery: Recovery, startedAt: number) => Effect.Effect<void>
}

// 定义可注入的服务标识（Context.Tag）
export class Service extends Context.Service<Service, Interface>()("@opencode/SubagentJob") {}

// 构建服务实现：依赖 Session、Job 服务与当前作用域
const make: Effect.Effect<Interface, never, Session.Service | Job.Service | Scope.Scope> = Effect.gen(function* () {
  // 取会话服务
  const sessions = yield* Session.Service
  // 取后台任务服务
  const jobs = yield* Job.Service
  // 取当前作用域（观察者协程挂在其下，随作用域关闭而终止）
  const scope = yield* Scope.Scope
  // Jobs and their completion observers outlive the plugin that launched them.
  // Fork with the global context too, rather than retaining the caller's location.
  // 捕获当前上下文，供 fork 出的协程复用（脱离调用方的位置）
  const context = yield* Effect.context<never>()
  // One observer per job generation, including continuations of the same child.
  // 已注册的观察者键集合：每代任务只有一个观察者（含同一子会话的续跑）
  const notifications = new Set<string>()

  // 观察一个子代理任务：等待其结束后向父会话投递合成消息
  const notify = Effect.fn("SubagentJob.notify")(function* (recovery: Recovery, startedAt: number) {
    // 观察者键：子会话 ID + 启动时间，唯一标识一代任务
    const key = `${recovery.childSessionID}:${startedAt}`
    // 已观察过该代任务：直接返回（幂等）
    if (notifications.has(key)) return
    // 记录该键，防止重复注册
    notifications.add(key)
    // 等待任务结束并投递结果
    yield* Effect.gen(function* () {
      // 阻塞等待子会话对应的任务完成，读取其终态信息
      const info = (yield* jobs.wait({ id: recovery.childSessionID })).info
      // 有终态信息则投递给父会话
      if (info) yield* SubagentCompletion.deliver(sessions, jobs, { ...info, recovery })
    }).pipe(
      // 无论成败，观察结束后都移除该键
      Effect.ensuring(Effect.sync(() => notifications.delete(key))),
      // 在服务作用域中立即启动观察协程（不等调用方完成）
      Effect.forkIn(scope, { startImmediately: true }),
      // 使用捕获的全局上下文运行（不保留调用方位置）
      Effect.setContext(context),
    )
  })

  // 组装并返回服务实现
  return Service.of({
    // 启动（恢复）一个子代理会话任务，完成后返回其最终文本
    start: (recovery: Recovery) =>
      jobs
        // 在任务系统中注册一个 subagent 类型的任务
        .start({
          // 任务 ID 即子会话 ID
          id: recovery.childSessionID,
          // 任务类型：子代理
          type: "subagent",
          // 任务标题：子代理描述
          title: recovery.description,
          // 无额外元数据
          metadata: {},
          // 携带恢复信息
          recovery,
          // 任务体：恢复子会话运行并提取最后结果
          run: Effect.gen(function* () {
            // 恢复（继续运行）子代理会话
            yield* sessions.resume(recovery.childSessionID)
            // 取子会话最近 20 条消息（新→旧）
            const messages = yield* sessions.messages({ sessionID: recovery.childSessionID, order: "desc", limit: 20 })
            // 找到最近一条已完成且无错误的助手消息
            const assistant = messages.find(
              (message) =>
                message.type === "assistant" && message.time.completed !== undefined && message.error === undefined,
            )
            // 提取其中的文本回复
            return SubagentCompletion.text(assistant)
          }),
        })
        // 同样以捕获的全局上下文运行
        .pipe(Effect.setContext(context)),
    // 将子代理任务注册为后台任务并挂接完成通知
    background: Effect.fn("SubagentJob.background")(function* (recovery: Recovery) {
      // 注册后台任务，返回其信息
      const info = yield* jobs.background(recovery.childSessionID)
      // 成功注册则按其启动时间挂接完成观察者
      if (info) yield* notify(recovery, info.started_at)
    }),
    // 暴露 notify 方法
    notify,
  })
})

// 全局服务节点：声明服务、实现层及依赖（Session 与 Job 节点）
export const node: LayerNode.Provider<Service, never, typeof Node.tags.values.global> = Node.makeGlobalNode({
  service: Service,
  layer: Layer.effect(Service, make),
  deps: [Session.node, Job.node],
})
