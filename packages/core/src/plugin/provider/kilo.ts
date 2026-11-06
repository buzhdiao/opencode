// 从 effect 库导入 Effect 模块，用于构建函数式副作用（Effect）工作流
import { Effect } from "effect"
// 导入插件定义辅助函数 define，用于声明一个 provider 插件
import { define } from "@opencode/plugin/effect/plugin"

// 导出 Kilo 提供商插件：为通过 Kilo 网关接入的 OpenAI 兼容提供商补充来源标识请求头
export const KiloPlugin = define({
  // 插件的唯一标识符
  id: "opencode.provider.kilo",
  // 插件主流程：一个 Effect 生成器函数，ctx 提供各类钩子与变换入口
  effect: Effect.fn(function* (ctx) {
    // 订阅 provider 目录变换事件，在提供商列表构建/更新时执行回调
    yield* ctx.provider.transform((evt) => {
      // 遍历当前事件中的每个提供商条目
      for (const item of evt.list()) {
        // 只处理由 openai-compatible 包驱动的提供商，其余跳过
        if (item.provider.package !== "@opencode/ai/providers/openai-compatible") continue
        // 只处理 baseURL 指向 Kilo 网关的提供商，避免误伤其他通用兼容提供商
        if (item.provider.settings?.baseURL !== "https://api.kilo.ai/api/gateway") continue
        // 按 ID 更新该提供商的配置
        evt.update(item.provider.id, (provider) => {
          // 在保留已有请求头的基础上追加 HTTP-Referer 与 X-Title，Kilo 用它们统计调用来源
          provider.headers = { ...provider.headers, "HTTP-Referer": "https://opencode.ai/", "X-Title": "opencode" }
        })
      }
    })
  }),
})
