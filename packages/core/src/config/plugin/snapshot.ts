// 配置快照插件（Config Snapshot Plugin）：把配置中的快照（snapshots）开关应用到快照服务。
export * as ConfigSnapshotPlugin from "./snapshot.js"

// 导入插件定义工具。
import { define } from "@opencode/plugin/effect/plugin"
// 导入 Effect。
import { Effect } from "effect"
// 导入配置服务。
import { Config } from "../../config.js"
// 导入快照服务。
import { Snapshot } from "../../snapshot.js"
// 导入配置条目观察器。
import { ConfigEntryObserver } from "./entry-observer.js"

// 定义插件。
export const Plugin = define({
  // 插件 ID。
  id: "opencode.config.snapshot",
  // 插件主流程。
  effect: Effect.fn(function* (ctx) {
    // 获取配置服务。
    const config = yield* Config.Service
    // 获取快照服务。
    const snapshot = yield* Snapshot.Service
    // 观察配置：更新时触发快照服务重载。
    const loaded = yield* ConfigEntryObserver.observe(config, ctx.event, snapshot.reload())
    // 应用快照配置。
    yield* snapshot.transform((editor) => {
      // 取最后声明的快照开关。
      const configured = Config.latest(loaded.entries, "snapshots")
      // 未声明则不动。
      if (configured === undefined) return
      // 应用配置。
      editor.configure(configured)
    })
  }),
})
