// 将本模块以命名空间 `SubagentJob` 全量导出
export * as SubagentJob from "./subagent-job.js"

import { Context, Effect, Layer } from "effect"
import { Node } from "@opencode/util/effect/app-node"
// 引入层节点类型（仅类型）
import type { LayerNode } from "@opencode/util/effect/layer-node"
// 引入后台任务服务
import { Job } from "../job.js"
import { SessionExecution } from "./execution.js"

// 取 Job.Recovery 中 kind 为 "subagent" 的恢复信息类型
type Recovery = Extract<Job.Recovery, { kind: "subagent" }>

// 服务接口：启动、后台化与通知子代理任务
export interface Interface {
  readonly start: (recovery: Recovery) => Effect.Effect<Job.Info>
}

// 定义可注入的服务标识（Context.Tag）
export class Service extends Context.Service<Service, Interface>()("@opencode/SubagentJob") {}

export function start(
  jobs: Job.Interface,
  execution: SessionExecution.Interface,
  recovery: Recovery,
  notificationID?: Job.Background["notificationID"],
) {
  const id = recovery.childSessionID
  return jobs.start({
    id,
    type: "subagent",
    title: recovery.description,
    metadata: notificationID === undefined ? {} : undefined,
    recovery,
    notificationID,
    background: true,
    run: execution.resume(id).pipe(
      // Only an explicit caller cancel releases the child's claim. A server shutdown
      // interrupts this job but must leave the child resumable on the next start.
      Effect.onInterrupt(() =>
        jobs.isCancelled(id).pipe(Effect.flatMap((cancelled) => (cancelled ? execution.interrupt(id) : Effect.void))),
      ),
      Effect.as(""),
    ),
  })
}

const make = Effect.gen(function* () {
  const execution = yield* SessionExecution.Service
  const jobs = yield* Job.Service
  // Jobs outlive the plugin that launched them. Fork with the global context too, rather
  // than retaining the caller's location.
  const context = yield* Effect.context<never>()

  // 组装并返回服务实现
  return Service.of({
    start: (recovery) => start(jobs, execution, recovery).pipe(Effect.setContext(context)),
  })
})

export const layer = Layer.effect(Service, make)

export const node: LayerNode.Provider<Service, never, typeof Node.tags.values.global> = Node.makeGlobalNode({
  service: Service,
  layer,
  deps: [SessionExecution.node, Job.node],
})
