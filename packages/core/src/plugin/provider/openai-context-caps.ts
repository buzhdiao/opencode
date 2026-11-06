// 导入插件定义辅助函数 define
import { define } from "@opencode/plugin/effect/plugin"
// 从 effect 库导入 Effect
import { Effect } from "effect"
// 导入 Integration 服务（用于构造集成 ID）
import { Integration } from "../../integration.js"
// 导入 Provider（提供商 ID 常量等）
import { Provider } from "../../provider.js"
// 导入内部插件类型声明（仅类型）
import type { PluginInternal } from "../internal.js"
// 导入“当前生效凭据”读取辅助函数
import { activeCredential } from "./credential-settings.js"
// 导入提供商刷新辅助工具
import { ProviderRefresh } from "./refresh.js"

// OpenAI 集成的 ID
const integrationID = Integration.ID.make("openai")
// 视为 ChatGPT 登录的 OAuth 方式集合（浏览器、无头设备码、令牌共享）
const methodIDs = new Set(["chatgpt-browser", "chatgpt-headless", "chatgpt-token-sharing"])

// The backend accepts each model's full input window, but larger requests use more of the ChatGPT plan. OpenAI's
// default windows for ChatGPT plans are 272k, and 500k for gpt-6.1-sol; later models are assumed to keep 500k.
// ChatGPT 订阅计划下的输入窗口上限：旧模型 272k，gpt-6.1 及以后假定为 500k。
const legacyInput = 272_000
const currentInput = 500_000

// 导出 OpenAI 上下文上限插件：ChatGPT 登录时收紧各模型的输入上下文限制
export const OpenAIContextCapsPlugin = define({
  // 插件唯一标识符
  id: "opencode.provider.openai-context-caps",
  // 插件主流程生成器
  effect: Effect.fn(function* (ctx) {
    // 记录当前是否以 ChatGPT 方式登录（跨调用保持状态）
    let signedIn = false

    // load：重新读取凭据并判断“是否已登录”是否发生变化
    const load = Effect.fn("OpenAIContextCapsPlugin.load")(function* () {
      // 读取 OpenAI 集成当前生效的凭据
      const { credential } = yield* activeCredential(ctx, integrationID)
      // 保存上一次的登录状态
      const previous = signedIn
      // 仅当凭据为 OAuth 且登录方式在集合中时才算 ChatGPT 登录
      signedIn = credential?.type === "oauth" && methodIDs.has(credential.methodID)
      // 返回状态是否发生变化（决定是否需要刷新 provider）
      return signedIn !== previous
    })

    // 启动时先执行一次 load 以建立初始状态
    yield* load()
    // 订阅 model 目录变换，按登录状态收紧模型限制
    yield* ctx.model.transform((models) => {
      // 未以 ChatGPT 登录时不做任何限制
      if (!signedIn) return
      // 遍历 openai 提供商下的所有模型
      for (const model of models.list(Provider.ID.openai)) {
        // 逐个更新模型草稿
        models.update(model.providerID, model.id, (draft) => {
          // 按模型的 API ID 计算允许的输入上限
          const input = cap(draft.modelID ?? draft.id)
          // 目录声明的输入或上下文上限若不超过上限则无需调整
          if ((draft.limit.input || draft.limit.context) <= input) return
          // 收紧输入与总上下文（上下文 = 输入上限 + 输出上限）
          draft.limit = { ...draft.limit, input, context: input + draft.limit.output }
        })
      }
    })
    // 在凭据切换时重新 load，状态变化才触发 provider 重载
    yield* ProviderRefresh.onSwitch(integrationID, ProviderRefresh.reloadIfChanged(load(), ctx.provider.reload()))
  }),
} satisfies PluginInternal.InternalPlugin)

// cap：根据 API 模型 ID 返回 ChatGPT 计划允许的输入窗口
function cap(apiID: string) {
  // 匹配 gpt-主版本[.次版本] 前缀
  const match = apiID.match(/^gpt-(\d+)(?:\.(\d+))?/)
  // 无法识别版本号的模型按当前（较大）上限处理
  if (!match) return currentInput
  // 主版本号
  const major = Number(match[1])
  // 次版本号，缺失按 0 处理
  const minor = Number(match[2] ?? 0)
  // 6.1 及更高版本用 500k，更早的用 272k
  return major > 6 || (major === 6 && minor >= 1) ? currentInput : legacyInput
}
