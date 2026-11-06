// 配置 shell 插件（Config Shell Plugin）：把配置中的 shell 设置应用到 shell 选择服务。
export * as ConfigShellPlugin from "./shell.js"

// 导入插件定义工具。
import { define } from "@opencode/plugin/effect/plugin"
// 导入 Effect。
import { Effect } from "effect"
// 导入配置服务。
import { Config } from "../../config.js"
// 导入 shell 选择服务。
import { ShellSelect } from "../../shell/select.js"
// 导入配置条目观察器。
import { ConfigEntryObserver } from "./entry-observer.js"

// 定义插件。
export const Plugin = define({
  // 插件 ID。
  id: "opencode.config.shell",
  // 插件主流程。
  effect: Effect.fn(function* (ctx) {
    // 获取配置服务。
    const config = yield* Config.Service
    // 获取 shell 选择服务。
    const shell = yield* ShellSelect.Service
    // 观察配置：更新时触发 shell 服务重载。
    const loaded = yield* ConfigEntryObserver.observe(config, ctx.event, shell.reload())
    // 应用 shell 配置。
    yield* shell.transform((editor) => {
      // 取最后声明的 shell 配置。
      const configured = Config.latest(loaded.entries, "shell")
      // 有配置才应用。
      if (configured) editor.configure(configured)
    })
  }),
})
