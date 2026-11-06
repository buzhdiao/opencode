// 从 effect 库导入 Effect
import { Effect } from "effect"
// 导入插件定义辅助函数 define
import { define } from "@opencode/plugin/effect/plugin"
// 导入 Integration 服务，用于查询用户已配置的集成
import { Integration } from "../../integration.js"

// 导出 LLMGateway 提供商插件：为 LLM Gateway 提供商追加来源标识请求头
export const LLMGatewayPlugin = define({
  // 插件唯一标识符
  id: "opencode.provider.llmgateway",
  // 插件主流程生成器
  effect: Effect.fn(function* (ctx) {
    // 获取集成服务实例
    const integrations = yield* Integration.Service
    // 列出所有已配置集成的 ID 并放入 Set，便于 O(1) 查找
    const configured = new Set((yield* integrations.list()).map((integration) => integration.id))
    // 订阅 provider 目录变换，在提供商清单构建/更新时执行回调
    yield* ctx.provider.transform((evt) => {
      // 遍历当前每个提供商条目
      for (const item of evt.list()) {
        // 显式禁用的提供商直接跳过
        if (item.provider.activation === "disabled") continue
        // 只处理由 openai-compatible 包驱动的提供商
        if (item.provider.package !== "@opencode/ai/providers/openai-compatible") continue
        // 只处理 baseURL 指向 LLM Gateway API 的提供商
        if (item.provider.settings?.baseURL !== "https://api.llmgateway.io/v1") continue
        // 用户必须已配置同名集成（即提供了该提供商的凭据），否则跳过
        if (!configured.has(Integration.ID.make(item.provider.id))) continue
        // 按 ID 更新该提供商配置
        evt.update(item.provider.id, (provider) => {
          // 在保留已有请求头的基础上追加来源统计头，LLM Gateway 用它们归因调用来源
          provider.headers = {
            ...provider.headers,
            "HTTP-Referer": "https://opencode.ai/",
            "X-Title": "opencode",
            "X-Source": "opencode",
          }
        })
      }
    })
  }),
})
