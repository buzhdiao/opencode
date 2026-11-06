// 配置图片插件（Config Image Plugin）：把配置中的媒体图片设置应用到图片服务。
export * as ConfigImagePlugin from "./image.js"

// 导入插件定义工具。
import { define } from "@opencode/plugin/effect/plugin"
// 导入 Effect。
import { Effect } from "effect"
// 导入配置服务。
import { Config } from "../../config.js"
// 导入图片服务。
import { Image } from "../../image.js"
// 导入配置条目观察器。
import { ConfigEntryObserver } from "./entry-observer.js"

// 定义插件。
export const Plugin = define({
  // 插件 ID。
  id: "opencode.config.image",
  // 插件主流程。
  effect: Effect.fn(function* (ctx) {
    // 获取配置服务。
    const config = yield* Config.Service
    // 获取图片服务。
    const image = yield* Image.Service
    // 观察配置：更新时触发图片服务重载。
    const loaded = yield* ConfigEntryObserver.observe(config, ctx.event, image.reload())
    // 应用图片配置。
    yield* image.transform((editor) => {
      // 遍历每个配置条目。
      for (const entry of loaded.entries) {
        // 只处理文档条目。
        if (entry.type !== "document") continue
        // 读取媒体图片设置。
        const configured = entry.info.media?.image
        // 未配置则跳过。
        if (!configured) continue
        // 应用设置（未提供的字段不覆盖）。
        editor.configure({
          ...(configured.auto_resize === undefined ? {} : { autoResize: configured.auto_resize }),
          ...(configured.max_width === undefined ? {} : { maxWidth: configured.max_width }),
          ...(configured.max_height === undefined ? {} : { maxHeight: configured.max_height }),
          ...(configured.max_base64_bytes === undefined ? {} : { maxBase64Bytes: configured.max_base64_bytes }),
        })
      }
    })
  }),
})
