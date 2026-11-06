// 配置工具输出插件（Config Tool Output Plugin）：把配置中的 tool_output 限制应用到工具输出服务。
export * as ConfigToolOutputPlugin from "./tool-output.js"

// 导入插件定义工具。
import { define } from "@opencode/plugin/effect/plugin"
// 导入 Effect。
import { Effect } from "effect"
// 导入配置服务。
import { Config } from "../../config.js"
// 导入工具输出服务。
import { ToolOutput } from "../../tool-output.js"
// 导入配置条目观察器。
import { ConfigEntryObserver } from "./entry-observer.js"

// 定义插件。
export const Plugin = define({
  // 插件 ID。
  id: "opencode.config.tool-output",
  // 插件主流程。
  effect: Effect.fn(function* (ctx) {
    // 获取配置服务。
    const config = yield* Config.Service
    // 获取工具输出服务。
    const output = yield* ToolOutput.Service
    // 观察配置：更新时触发工具输出服务重载。
    const loaded = yield* ConfigEntryObserver.observe(config, ctx.event, output.reload())
    // 应用工具输出配置。
    yield* output.transform((editor) => {
      // 取最后声明的配置。
      const configured = Config.latest(loaded.entries, "tool_output")
      // 未配置则不动。
      if (!configured) return
      // 应用限制（未提供的字段不覆盖）。
      editor.configure({
        ...(configured.max_lines === undefined ? {} : { maxLines: configured.max_lines }),
        ...(configured.max_bytes === undefined ? {} : { maxBytes: configured.max_bytes }),
      })
    })
  }),
})
