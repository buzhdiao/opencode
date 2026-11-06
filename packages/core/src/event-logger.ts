// 事件日志器（Event Logger）：订阅事件总线（bus），把关键配置类事件以 Info 级别写入日志。
export * as EventLogger from "./event-logger.js"

import { Effect, Layer } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Bus } from "./bus.js"

// 需要记录到日志的事件类型集合（agent/provider/model/command/config 的更新事件）
const EVENT_TYPES = new Set(["agent.updated", "provider.updated", "model.updated", "command.updated", "config.updated"])

// 构建日志层：监听总线并仅对关注的事件打日志；effectDiscard 表示层本身不产出服务
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    // 取出事件总线服务
    const bus = yield* Bus.Service
    // 注册监听器，返回取消订阅效果
    const unsubscribe = yield* bus.listen((event) =>
      // 命中集合则记日志，否则无事发生
      EVENT_TYPES.has(event.type) ? Effect.logInfo("event", { event }) : Effect.void,
    )
    // 注册终结器：层关闭时退订，避免泄漏
    yield* Effect.addFinalizer(() => unsubscribe)
  }),
)

// 全局节点：把该层挂到全局依赖图，依赖事件总线节点
export const node = makeGlobalNode({ name: "event-logger", layer, deps: [Bus.node] })
