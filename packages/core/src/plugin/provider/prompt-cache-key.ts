// 从 effect 库导入 Effect
import { Effect } from "effect"
// 导入插件定义辅助函数 define
import { define } from "@opencode/plugin/effect/plugin"

// Chat-completions `prompt_cache_key` body support for catalog providers
// without a dedicated AI package. Audited per provider (docs + OpenAPI +
// SDK request types); only unscoped body-key support is listed. Scoped-only
// support is left off because the boolean cannot express route scope:
// fastrouter (GPT-5.6 routes only), frogbot (Google/Vertex routes only).
// 支持在 chat-completions 请求体中携带 prompt_cache_key 的目录提供商名单
// （无专用 AI SDK 包的提供商），逐一按文档/OpenAPI/SDK 请求类型核实过；
// 仅列出“不限路由范围”的支持——仅限特定路由的（fastrouter 仅 GPT-5.6 路由、
// frogbot 仅 Google/Vertex 路由）无法用布尔值表达，故不列入。
const providerIDs = [
  "abliteration-ai",
  "aihubmix",
  "anyapi",
  "auriko",
  "edenai",
  "jalapeno",
  "llama",
  "morph",
  "snowflake-cortex",
  "tencent-tokenhub",
  "upstage",
  "venice",
] as const

// 导出 PromptCacheKey 插件：为名单内提供商打开 prompt_cache_key 兼容开关
export const PromptCacheKeyPlugin = define({
  // 插件唯一标识符
  id: "opencode.provider.prompt-cache-key",
  // 插件主流程生成器
  effect: Effect.fn(function* (ctx) {
    // Set on the provider so configured provider and model compatibility can override it.
    // 标记设置在提供商级别，便于配置层在提供商/模型级别覆盖它。
    yield* ctx.provider.transform((providers) => {
      // 遍历支持名单中的每个提供商 ID
      for (const id of providerIDs) {
        // 目录中不存在该提供商则跳过
        if (!providers.get(id)) continue
        // 更新该提供商的兼容性标记
        providers.update(id, (provider) => {
          // 在保留原兼容项的基础上声明支持 prompt_cache_key
          provider.compatibility = { ...provider.compatibility, supportsPromptCacheKey: true }
        })
      }
    })
  }),
})
