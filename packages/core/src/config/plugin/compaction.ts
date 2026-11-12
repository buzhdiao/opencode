// 配置压缩插件（Config Compaction Plugin）：把配置中的压缩（compaction）设置应用到会话压缩服务。
export * as ConfigCompactionPlugin from "./compaction.js"

// 导入插件定义工具。
import { define } from "@opencode/plugin/effect/plugin"
// 导入 Effect。
import { Effect } from "effect"
// 导入配置服务。
import { Config } from "../../config.js"
// 导入命令行旗标（Flag）。
import { Flag } from "../../flag.js"
// 导入会话压缩服务。
import { SessionCompaction } from "../../session/compaction.js"
// 导入配置条目观察器。
import { ConfigEntryObserver } from "./entry-observer.js"

// 定义插件。
export const Plugin = define({
  // 插件 ID。
  id: "opencode.config.compaction",
  // 插件主流程。
  effect: Effect.fn(function* (ctx) {
    // 获取配置服务。
    const config = yield* Config.Service
    // 获取会话压缩服务。
    const compaction = yield* SessionCompaction.Service
    const flags = yield* Flag.Service
    const loaded = yield* ConfigEntryObserver.observe(config, ctx.event, compaction.reload())
    // 把压缩配置写入编辑器。
    yield* compaction.transform((editor) => {
      editor.configure({ precompute: flags.resolve(loaded.entries).background_compaction.enabled })
      for (const entry of loaded.entries) {
        // 只处理带 compaction 设置的文档。
        if (entry.type !== "document" || !entry.info.compaction) continue
        // 应用该文档的压缩设置（未提供的字段不覆盖）。
        editor.configure({
          ...(entry.info.compaction.auto === undefined ? {} : { auto: entry.info.compaction.auto }),
          ...(entry.info.compaction.buffer === undefined ? {} : { buffer: entry.info.compaction.buffer }),
          ...(entry.info.compaction.keep?.tokens === undefined ? {} : { keep: entry.info.compaction.keep.tokens }),
        })
      }
    })
  }),
})
