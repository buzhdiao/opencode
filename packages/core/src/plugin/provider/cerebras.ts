// Effect：效果运行时
import { Effect } from "effect"
// define：插件定义辅助函数
import { define } from "@opencode/plugin/effect/plugin"

// 定义 Cerebras 提供商插件：为 Cerebras 请求附加第三方集成标识头
export const CerebrasPlugin = define({
  // 插件唯一标识
  id: "opencode.provider.cerebras",
  // 插件激活时执行的生成器主体
  effect: Effect.fn(function* (ctx) {
    // 通过编辑器遍历并修改提供商定义
    yield* ctx.provider.transform((evt) => {
      // 逐个检查每个提供商
      for (const item of evt.list()) {
        // 只处理 Cerebras 官方包的提供商
        if (item.provider.package !== "@opencode/ai/providers/cerebras") continue
        // 更新该提供商的请求头
        evt.update(item.provider.id, (provider) => {
          // 附加 X-Cerebras-3rd-Party-Integration 头，标识来自 opencode
          provider.headers = { ...provider.headers, "X-Cerebras-3rd-Party-Integration": "opencode" }
        })
      }
    })
  }),
})
