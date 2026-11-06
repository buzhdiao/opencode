// 从 effect 库导入 Effect
import { Effect } from "effect"
// 导入插件定义辅助函数 define
import { define } from "@opencode/plugin/effect/plugin"

// 导出 ZenMux 提供商插件：为 ZenMux 网关提供商补充来源标识请求头
export const ZenmuxPlugin = define({
  // 插件唯一标识符
  id: "opencode.provider.zenmux",
  // 插件主流程生成器
  effect: Effect.fn(function* (ctx) {
    // 订阅 provider 目录变换，在提供商清单构建/更新时执行回调
    yield* ctx.provider.transform((evt) => {
      // 遍历当前每个提供商条目
      for (const item of evt.list()) {
        // 只处理由 openai-compatible 包驱动的提供商
        if (item.provider.package !== "@opencode/ai/providers/openai-compatible") continue
        // 只处理 baseURL 指向 ZenMux 网关的提供商
        if (item.provider.settings?.baseURL !== "https://zenmux.ai/api/v1") continue
        // 按 ID 更新该提供商配置
        evt.update(item.provider.id, (provider) => {
          // 注意这里的展开顺序：来源头在前，用户显式配置的头可以覆盖它们
          provider.headers = {
            "HTTP-Referer": "https://opencode.ai/",
            "X-Title": "opencode",
            ...provider.headers,
          }
        })
      }
    })
  }),
})
