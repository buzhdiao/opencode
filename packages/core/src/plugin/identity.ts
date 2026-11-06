// 以命名空间形式整体再导出（re-export）本模块，外部可通过 IdentityPlugin.xxx 访问
export * as IdentityPlugin from "./identity.js"

// 引入系统提示的分段部件（SystemPart）
import { SystemPart } from "@opencode/ai/effect"
// define：声明式插件定义辅助函数
import { define } from "@opencode/plugin/effect/plugin"
// SessionHooks：会话生命周期钩子（hook）的类型定义
import type { SessionHooks } from "@opencode/plugin/effect/session"
// Model：模型相关的 Schema 类型
import { Model } from "@opencode/schema/model"
// Effect：函数式效果（Effect）运行时
import { Effect } from "effect"
// 复用 OptimizePlugin 提供的"解析当前会话模型"逻辑
import { OptimizePlugin } from "./optimize.js"

// 生成一段"模型身份"说明文本：让模型知道它自己是谁（避免自我认知混乱）
export function identity(model: { readonly name: string; readonly ref: Model.Ref }) {
  // 把各行用换行符拼成一个完整字符串
  return [
    // 标题行：当前模型
    "# Your Model",
    // 模型的显示名称
    `- Name: ${model.name}`,
    // 模型所属的提供商（provider）ID
    `- Provider ID: ${model.ref.providerID}`,
    // 模型自身的 ID
    `- Model ID: ${model.ref.id}`,
  ].join("\n")
}

// 定义"身份提示"插件
export const Plugin = define({
  // 插件的唯一标识符
  id: "opencode.prompt.identity",
  // effect：插件激活时执行的生成器主体
  effect: Effect.fn("IdentityPlugin")(function* (ctx) {
    // 定义一个会话上下文钩子（hook）：在组装系统提示时注入身份文本
    const hook = (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
        // 解析当前会话实际使用的模型信息（可能被用户切换过）
        const model = yield* OptimizePlugin.resolveModel(ctx, event)
        // 把身份文本作为系统提示的第二段插入（索引 1，紧跟第一段）
        event.system.splice(1, 0, SystemPart.make(identity({ name: model.name, ref: event.model })))
        // 出错时静默吞掉（身份提示非关键功能，不应影响会话）
      }).pipe(Effect.catch(() => Effect.void))
    // 在会话上下文组装时挂钩
    yield* ctx.session.hook("context", hook)
    // 在上下文压缩（compaction）后重新挂钩，保证身份提示不丢失
    yield* ctx.session.hook("compaction", hook)
    // 在每次生成（generate）前挂钩，确保请求里始终带身份提示
    yield* ctx.session.hook("generate", hook)
  }),
})
