// 配置位置监视插件（Config Location Watcher Plugin）：把配置中的 watcher.ignore 应用到位置监视策略。
export * as ConfigLocationWatcherPlugin from "./location-watcher.js"

// 导入插件定义工具。
import { define } from "@opencode/plugin/effect/plugin"
// 导入 Effect。
import { Effect } from "effect"
// 导入配置服务。
import { Config } from "../../config.js"
// 导入位置监视策略服务。
import { LocationWatcherPolicy } from "../../filesystem/location-watcher-policy.js"
// 导入配置条目观察器。
import { ConfigEntryObserver } from "./entry-observer.js"

// 定义插件。
export const Plugin = define({
  // 插件 ID。
  id: "opencode.config.location-watcher",
  // 插件主流程。
  effect: Effect.fn(function* (ctx) {
    // 获取配置服务。
    const config = yield* Config.Service
    // 获取位置监视策略服务。
    const policy = yield* LocationWatcherPolicy.Service
    // 观察配置：更新时触发策略重载。
    const loaded = yield* ConfigEntryObserver.observe(config, ctx.event, policy.reload())
    // 应用忽略规则。
    yield* policy.transform((editor) => {
      // 遍历每个配置条目。
      for (const entry of loaded.entries) {
        // 只处理带 watcher.ignore 的文档。
        if (entry.type !== "document" || !entry.info.watcher?.ignore) continue
        // 追加该文档的忽略规则。
        editor.add(entry.info.watcher.ignore)
      }
    })
  }),
})
