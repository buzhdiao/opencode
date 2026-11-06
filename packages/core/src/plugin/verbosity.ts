// 将本模块以命名空间 `VerbosityPlugin` 全量导出
export * as VerbosityPlugin from "./verbosity.js"

// 引入插件定义工具 define
import { define } from "@opencode/plugin/effect/plugin"
// 引入会话请求类型（仅类型）
import type { SessionRequest } from "@opencode/plugin/effect/session"
// 引入 Effect 原语
import { Effect } from "effect"
// 引入模型服务
import { Model } from "../model.js"
// 引入提供方工具（aisdk 包名构造）
import { Provider } from "../provider.js"
// 引入内部插件类型（仅类型）
import type { PluginInternal } from "./internal.js"

// 直接提供 OpenAI 风格模型 ID 的直连包名集合
const direct = new Set([
  "@opencode/ai/providers/openai",
  "@opencode/ai/providers/openai/responses",
  "@opencode/ai/providers/azure",
  "@opencode/ai/providers/azure/responses",
])
// 经网关转发 OpenAI 模型的包名集合（ID 带有 openai/ 前缀）
const gateways = new Set([
  "@opencode/ai/providers/cloudflare-ai-gateway",
  "@opencode/ai/providers/vercel-ai-gateway",
  Provider.aisdk("@ai-sdk/gateway"),
])

// 定义输出详尽度（verbosity）插件：为支持的 OpenAI GPT 模型自动设置 textVerbosity
export const Plugin = define({
  // 插件唯一标识
  id: "opencode.prompt.verbosity",
  // 插件副作用主体
  effect: Effect.fn("VerbosityPlugin")(function* (ctx) {
    // 获取模型服务
    const models = yield* Model.Service
    // 钩子逻辑：在用户未显式指定时为支持详尽度控制的模型注入默认值
    const hook = (event: SessionRequest) =>
      Effect.gen(function* () {
        // 用户已显式设置 textVerbosity 则不覆盖
        if (event.options.textVerbosity !== undefined) return
        // 按提供方与模型 ID 查询模型信息
        const model = yield* models.get(event.model.providerID, event.model.id)
        // 模型不存在则退出
        if (!model) return
        // 解析 OpenAI 风格模型 ID
        const id = openAIModelID(model)
        // 无法解析或模型不支持详尽度控制则退出
        if (!id || !supportsVerbosity(id)) return
        // 模型级设置已指定详尽度则不再注入
        if (model.settings?.textVerbosity !== undefined) return
        // 查找请求使用的模型变体
        const variant = model.variants.find((item) => item.id === event.model.variant)
        // 变体级设置已指定详尽度则不再注入
        if (variant?.settings?.textVerbosity !== undefined) return
        // 默认注入 low（低详尽度），降低 token 消耗
        event.options.textVerbosity = "low"
      })
    // 把钩子挂到四个会话阶段：上下文、压缩、生成、标题
    yield* ctx.session.hook("context", hook)
    yield* ctx.session.hook("compaction", hook)
    yield* ctx.session.hook("generate", hook)
    yield* ctx.session.hook("title", hook)
  }),
} satisfies PluginInternal.InternalPlugin)

// 判断 OpenAI 模型 ID 是否支持 textVerbosity 控制
function supportsVerbosity(id: string) {
  // gpt-6 系列全部支持
  if (id.includes("gpt-6")) return true
  // -chat / -image 变体不支持
  if (id.includes("-chat") || id.includes("-image")) return false
  // New GPT-5 minor versions remain unset until their support is known.
  // 新的 GPT-5 小版本在其支持情况明确前不注入
  return /(?:^|[/.])gpt-5\.[1-6](?:[.:-]|$)/.test(id) || /(?:^|[/.])gpt-5(?:-(?:mini|nano)(?:[.:-]|$)|$)/.test(id)
}

// 从模型信息解析 OpenAI 风格模型 ID（去掉包前缀）
function openAIModelID(model: Model.Info) {
  // 统一转小写
  const id = model.modelID.toLowerCase()
  // 直连包：ID 已是 OpenAI 风格
  if (direct.has(model.package ?? "")) return id
  // Bedrock Mantle 网关：剥去 openai. 前缀
  if (model.package === "@opencode/ai/providers/amazon-bedrock/mantle/responses" && id.startsWith("openai."))
    return id.slice("openai.".length)
  // 通用网关：剥去 openai/ 前缀
  if (gateways.has(model.package ?? "") && id.startsWith("openai/")) return id.slice("openai/".length)
}
