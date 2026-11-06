// 配置工作树插件（Config Worktree Plugin）：把配置中的 worktree 目录设置应用到工作树策略服务。
export * as ConfigWorktreePlugin from "./worktree.js"

// 导入插件定义工具。
import { define } from "@opencode/plugin/effect/plugin"
// 导入 Effect。
import { Effect } from "effect"
// 导入 Node 的 path 模块。
import path from "path"
// 导入配置服务。
import { Config } from "../../config.js"
// 导入全局目录服务。
import { Global } from "@opencode/util/global"
// 导入位置服务。
import { Location } from "../../location.js"
// 导入绝对路径品牌类型。
import { AbsolutePath } from "../../schema.js"
// 导入工作树策略服务。
import { WorktreeStrategies } from "../../worktree/strategies.js"
// 导入配置条目观察器。
import { ConfigEntryObserver } from "./entry-observer.js"

// 定义插件。
export const Plugin = define({
  // 插件 ID。
  id: "opencode.config.worktree",
  // 插件主流程。
  effect: Effect.fn(function* (ctx) {
    // 获取配置服务。
    const config = yield* Config.Service
    // 获取位置服务。
    const location = yield* Location.Service
    // 获取全局目录服务。
    const global = yield* Global.Service
    // 获取工作树策略服务。
    const worktrees = yield* WorktreeStrategies.Service
    // 观察配置：更新时触发策略重载。
    const loaded = yield* ConfigEntryObserver.observe(config, ctx.event, worktrees.reload())
    // 应用工作树配置。
    yield* worktrees.transform((editor) => {
      // 遍历每个配置条目。
      for (const entry of loaded.entries) {
        // 只处理带 worktree 设置的文档。
        if (entry.type !== "document" || !entry.info.worktree) continue
        // 读取配置的工作树目录。
        const directory = entry.info.worktree.directory
        // 应用目录配置：~ 前缀展开为主目录，否则相对项目规范根目录解析。
        editor.configure({
          directory: AbsolutePath.make(
            directory.startsWith("~/")
              ? path.join(global.home, directory.slice(2))
              : path.resolve(location.project.canonical, directory),
          ),
        })
      }
    })
  }),
})
