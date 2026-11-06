// 配置网络搜索插件（Config WebSearch Plugin）：把配置中的 websearch 选择应用到网络搜索服务。
export * as ConfigWebSearchPlugin from "./websearch.js"

// 导入插件定义工具。
import { define } from "@opencode/plugin/effect/plugin"
// 导入 Effect。
import { Effect } from "effect"
// 导入配置服务。
import { Config } from "../../config.js"
// 导入配置条目观察器。
import { ConfigEntryObserver } from "./entry-observer.js"

// 定义插件。
export const Plugin = define({
  // 插件 ID。
  id: "opencode.config.websearch",
  // 插件主流程。
  effect: Effect.fn(function* (ctx) {
    // 获取配置服务。
    const config = yield* Config.Service
    // 观察配置：更新时触发网络搜索服务重载。
    const loaded = yield* ConfigEntryObserver.observe(config, ctx.event, ctx.websearch.reload())
    // 应用网络搜索配置。
    yield* ctx.websearch.transform((websearch) => {
      // 取最后声明的选择。
      const selection = Config.latest(loaded.entries, "websearch")
      // 显式为 false 时关闭默认搜索。
      if (selection === false) websearch.default.set(false)
      // 声明了提供方时设为默认。
      if (selection) websearch.default.set(selection.provider)
    })
  }),
})
