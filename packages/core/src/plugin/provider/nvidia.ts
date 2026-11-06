// 从 effect 库导入 Effect
import { Effect } from "effect"
// 导入插件定义辅助函数 define
import { define } from "@opencode/plugin/effect/plugin"

// 导出 NVIDIA 提供商插件：为 NVIDIA NIM 目录提供商补充来源与计费标识请求头
export const NvidiaPlugin = define({
  // 插件唯一标识符
  id: "opencode.provider.nvidia",
  // 插件主流程生成器
  effect: Effect.fn(function* (ctx) {
    // 订阅 provider 目录变换，在提供商清单构建/更新时执行回调
    yield* ctx.provider.transform((evt) => {
      // 遍历当前每个提供商条目
      for (const item of evt.list()) {
        // 只处理由 openai-compatible 包驱动的提供商
        if (item.provider.package !== "@opencode/ai/providers/openai-compatible") continue
        // 只处理 baseURL 指向 NVIDIA 集成 API 的提供商
        if (item.provider.settings?.baseURL !== "https://integrate.api.nvidia.com/v1") continue
        // 按 ID 更新该提供商配置
        evt.update(item.provider.id, (provider) => {
          // 追加来源统计头与计费来源头（若用户已设置 X-BILLING-INVOKE-ORIGIN 则保留原值）
          provider.headers = {
            ...provider.headers,
            "HTTP-Referer": "https://opencode.ai/",
            "X-Title": "opencode",
            "X-BILLING-INVOKE-ORIGIN": provider.headers?.["X-BILLING-INVOKE-ORIGIN"] ?? "OpenCode",
          }
        })
      }
    })
  }),
})
