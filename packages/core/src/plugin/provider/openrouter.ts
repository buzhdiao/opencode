// 从 effect 库导入 Effect
import { Effect } from "effect"
// 导入 Model（模型 ID 工具）
import { Model } from "../../model.js"
// 导入插件定义辅助函数 define
import { define } from "@opencode/plugin/effect/plugin"

// 导出 OpenRouter 提供商插件：补来源请求头，并禁用不可用的别名模型
export const OpenRouterPlugin = define({
  // 插件唯一标识符
  id: "opencode.provider.openrouter",
  // 插件主流程生成器
  effect: Effect.fn(function* (ctx) {
    // 第一段：给 OpenRouter 提供商追加来源统计请求头
    yield* ctx.provider.transform((evt) => {
      // 遍历当前每个提供商条目
      for (const item of evt.list()) {
        // 只处理由 openrouter 包驱动的提供商
        if (item.provider.package !== "@opencode/ai/providers/openrouter") continue
        // 按 ID 更新该提供商配置
        evt.update(item.provider.id, (provider) => {
          // 在保留已有请求头的基础上追加 HTTP-Referer 与 X-Title
          provider.headers = { ...provider.headers, "HTTP-Referer": "https://opencode.ai/", "X-Title": "opencode" }
        })
      }
    })
    // 第二段：禁用 OpenRouter 上走通用路径会失败的 OpenAI 聊天别名模型
    yield* ctx.model.transform((models) => {
      // 遍历所有提供商条目
      for (const item of models.provider.list()) {
        // 只处理由 openrouter 包驱动的提供商
        if (item.provider.package !== "@opencode/ai/providers/openrouter") continue
        // 逐个检查需要禁用的别名模型 ID
        for (const modelID of [Model.ID.make("gpt-5-chat-latest"), Model.ID.make("openai/gpt-5-chat")]) {
          // 该提供商目录中没有此模型则跳过
          if (!models.get(item.provider.id, modelID)) continue
          // 更新该模型的启用状态
          models.update(item.provider.id, modelID, (model) => {
            // These are OpenRouter-specific OpenAI chat aliases that do not work
            // on the generic path. Keep custom providers with matching IDs untouched.
            // 禁用该别名模型
            model.enabled = false
          })
        }
      }
    })
  }),
})
