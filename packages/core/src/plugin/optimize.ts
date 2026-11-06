// 以命名空间形式整体再导出本模块
export * as OptimizePlugin from "./optimize.js"

// define 与 Context 类型：插件定义与插件上下文
import { define, type Context } from "@opencode/plugin/effect/plugin"
// SessionHooks：会话钩子类型
import type { SessionHooks } from "@opencode/plugin/effect/session"
// Model：模型 Schema 类型
import { Model } from "@opencode/schema/model"
// Effect：效果运行时
import { Effect } from "effect"
// SessionSystemPrompt：系统提示模板渲染器
import { SessionSystemPrompt } from "../session/system-prompt.js"

// 导入各模型家族专用的提示词模板（以文本资源形式打包）
import PROMPT_GPT from "./system-prompt/gpt.txt"
import PROMPT_ASTRA from "./system-prompt/gpt-astra.txt"
import PROMPT_KIMI from "./system-prompt/kimi.txt"
import PROMPT_META from "./system-prompt/meta.txt"
import PROMPT_TRINITY from "./system-prompt/trinity.txt"
import PROMPT_ANTHROPIC from "./system-prompt/anthropic.txt"

// OpenAI 系模型提示插件：模型 ID 含 "gpt" 时注入对应模板（astra 变体用专属模板）
export const OpenAIPlugin = make("opencode.prompt.openai", (model) => {
  // 统一小写便于匹配
  const id = model.id.toLowerCase()
  // 不含 gpt 则不注入
  if (!id.includes("gpt")) return undefined
  // astra 变体使用专属模板，其余使用通用 GPT 模板
  return id.includes("astra") ? PROMPT_ASTRA : PROMPT_GPT
})

// Anthropic 系模型提示插件：模型 ID 含 "claude" 时注入，且以追加（append）方式而非覆盖
export const AnthropicPlugin = make(
  // 插件 ID
  "opencode.prompt.anthropic",
  // 匹配函数：仅 claude 模型返回模板
  (model) => {
    // 统一小写便于匹配
    const id = model.id.toLowerCase()
    // 不含 claude 则不注入
    if (!id.includes("claude")) return undefined
    // 返回 Anthropic 专属模板
    return PROMPT_ANTHROPIC
  },
  // 模式：追加到现有系统提示之后
  "append",
)

// Both OpenAIToolsPlugin and AnthropicToolsPlugin are disabled intentionally until we can figure out a good ux for displaying
// heavy grep/glob usage done via shell or other mechanisms

// OpenAI 工具裁剪插件（当前未启用）：移除 grep/glob 工具
export const OpenAIToolsPlugin = make("opencode.optimize.openai.tools", (model, tools) => {
  // 拼接模型 ID/modelID/family 便于一次性匹配
  const ids = [model.id, model.modelID, model.family].join(" ").toLowerCase()
  // 非 gpt 模型不处理
  if (!ids.includes("gpt")) return undefined
  // 删除 grep 工具定义
  delete tools.grep
  // 删除 glob 工具定义
  delete tools.glob
  // 返回 undefined 表示不改写系统提示
  return undefined
})

// Anthropic 工具裁剪插件（当前未启用）：同上，针对 claude 模型
export const AnthropicToolsPlugin = make("opencode.optimize.anthropic.tools", (model, tools) => {
  // 拼接模型标识便于一次性匹配
  const ids = [model.id, model.modelID, model.family].join(" ").toLowerCase()
  // 非 claude 模型不处理
  if (!ids.includes("claude")) return undefined
  // 删除 grep 工具定义
  delete tools.grep
  // 删除 glob 工具定义
  delete tools.glob
  // 返回 undefined 表示不改写系统提示
  return undefined
})

// Kimi 模型提示插件：模型 ID 含 "kimi" 时注入 Kimi 模板
export const KimiPlugin = make("opencode.prompt.kimi", (model) =>
  // 三元判断：匹配则返回模板，否则 undefined
  model.id.toLowerCase().includes("kimi") ? PROMPT_KIMI : undefined,
)
// Arcee（Trinity）模型提示插件
export const ArceePlugin = make("opencode.prompt.arcee", (model) =>
  // 匹配 "trinity" 则返回 Trinity 模板
  model.id.toLowerCase().includes("trinity") ? PROMPT_TRINITY : undefined,
)
// Meta（Muse）模型提示插件
export const MetaPlugin = make("opencode.prompt.meta", (model) => {
  // 不匹配则不注入
  if (!model.id.toLowerCase().includes("muse")) return undefined
  // 注入模板并把占位符 {{MODEL_NAME}} 替换为实际模型名
  return PROMPT_META.replaceAll("{{MODEL_NAME}}", model.name)
})

// 导出启用的优化插件集合（不含被禁用的工具裁剪插件）
export const Plugins = [OpenAIPlugin, AnthropicPlugin, KimiPlugin, ArceePlugin, MetaPlugin] as const

// 以事件对象为键的 WeakMap 缓存：同一会话事件内避免重复查询模型列表
const models = new WeakMap<SessionHooks["context"], Model.Info>()

// resolveModel：从会话钩子事件解析当前使用的模型信息（带缓存）
export const resolveModel = (ctx: Context, event: SessionHooks["context"]) =>
  // 用 Effect.gen 组织异步逻辑
  Effect.gen(function* () {
    // 先查缓存
    const cached = models.get(event)
    // 缓存命中且提供商与模型 ID 都一致时直接复用
    if (cached?.providerID === event.model.providerID && cached.id === event.model.id) return cached
    // 未命中则查询模型列表，按提供商与 ID 精确匹配；找不到时退回默认定义
    const model: Model.Info =
      // 从模型服务列表中查找
      (yield* ctx.model.list()).data.find(
        // 匹配提供商 ID 与模型 ID
        (model) => model.providerID === event.model.providerID && model.id === event.model.id,
        // 找不到时构造一个默认的模型信息兜底
      ) ?? Model.Info.default(event.model.providerID, event.model.id)
    // 写入缓存供同事件后续使用
    models.set(event, model)
    // 返回解析出的模型信息
    return model
  })

// make：工厂函数，按给定匹配规则生成"注入/裁剪"插件
function make(
  // 插件 ID
  id: string,
  // 优化回调：返回要注入的模板文本；返回 undefined 表示不注入
  optimize: (model: Model.Info, tools: SessionHooks["context"]["tools"]) => string | undefined,
  // 注入模式：override（覆盖第一段）或 append（追加），默认 override
  mode: "override" | "append" = "override",
) {
  // 定义插件
  return define({
    // 插件唯一标识
    id,
    // 激活主体：注册会话钩子
    effect: Effect.fn(`OptimizePlugin.${id}`)(function* (ctx) {
      // 会话上下文钩子：在系统提示组装时改写
      const hook = (event: SessionHooks["context"]) =>
        // Effect.gen 组织逻辑
        Effect.gen(function* () {
          // 解析当前模型（带缓存）
          const model = yield* resolveModel(ctx, event)
          // Curate tools before rendering their guidance, including for agents with a custom system prompt.
          // 先执行工具裁剪，再渲染工具指引；对自定义系统提示的 agent 同样生效。
          const template = optimize(model, event.tools)
          // 无模板则不处理
          if (!template) return
          // agent 配置了自定义系统提示时跳过注入（尊重用户定义）
          if ((yield* ctx.agent.get({ agentID: event.agent })).data.system) return
          // 取系统提示第一段
          const system = event.system[0]
          // 不存在则退出
          if (!system) return
          // 用工具名列表渲染模板中的工具指引部分
          const rendered = SessionSystemPrompt.render(template, Object.keys(event.tools))
          // append 模式拼接在原文本后，override 模式直接替换
          const text = mode === "append" ? `${system.text}\n\n${rendered}` : rendered
          // 写回系统提示第一段
          event.system[0] = { ...system, text }
          // 任何错误静默吞掉，不影响会话
        }).pipe(Effect.catch(() => Effect.void))
      // 在会话上下文组装时挂钩
      yield* ctx.session.hook("context", hook)
      // 压缩（compaction）后重新挂钩，保证注入不丢失
      yield* ctx.session.hook("compaction", hook)
      // 每次生成（generate）前挂钩
      yield* ctx.session.hook("generate", hook)
    }),
  })
}
