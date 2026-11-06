// 从 effect 库导入 Effect，用于构建函数式副作用工作流
import { Effect } from "effect"
// 导入插件定义辅助函数 define
import { define } from "@opencode/plugin/effect/plugin"

// 导出 Neon 提供商插件：声明 Neon 集成的环境变量凭据方式
export const NeonPlugin = define({
  // 插件唯一标识符
  id: "opencode.provider.neon",
  // 插件主流程生成器
  effect: Effect.fn(function* (ctx) {
    // 订阅 integration 目录变换，在集成（登录方式）清单构建时执行回调
    yield* ctx.integration.transform((editor) => {
      // models.dev also lists NEON_AI_GATEWAY_BASE_URL, which only fills the base URL template.
      // 声明该集成支持从环境变量 NEON_AI_GATEWAY_TOKEN 读取令牌（base URL 变量不构成凭据，故不列出）
      editor.method.update({ integrationID: "neon", method: { type: "env", names: ["NEON_AI_GATEWAY_TOKEN"] } })
    })
  }),
})
