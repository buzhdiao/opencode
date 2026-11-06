// 以命名空间形式整体再导出本模块
export * as ClaudeAISDK from "./aisdk.js"

// 插件上下文类型
import type { Context } from "@opencode/plugin/effect/plugin"
// Effect：效果运行时
import { Effect } from "effect"
// ClaudeQueryOptions：Claude 连接环境变量构造
import { ClaudeQueryOptions } from "./claude/query-options.js"
// ClaudeSessions：会话运行接口类型
import type { ClaudeSessions } from "./claude/sessions.js"
// ClaudeAgentLanguageModel：AI SDK 语言模型实现
import { ClaudeAgentLanguageModel } from "./language-model/claude-agent-language-model.js"
// ClaudeProvider：Claude 提供商常量
import { ClaudeProvider } from "./provider.js"

// register：向 AI SDK 体系注册 Claude Agent 语言模型
export const register = Effect.fn("ClaudeAISDK.register")(function* (ctx: Context, sessions: ClaudeSessions.Interface) {
  // 捕获当前依赖上下文（供 Promise 化运行使用）
  const context = yield* Effect.context<never>()
  // 构建可在正确上下文中运行 Effect 的 Promise 执行器
  const run = Effect.runPromiseWith(context)
  // 语言模型运行时依赖
  const dependencies: ClaudeAgentLanguageModel.Dependencies = {
    // run：把请求交给会话运行器执行（支持中断信号）
    run: (request, signal) => run(sessions.run(request), { signal }),
  }
  // 注册 sdk 钩子：在 SDK 构造时注入语言模型
  yield* ctx.aisdk.hook(
    // 钩子名：sdk
    "sdk",
    (evt) =>
      // 同步处理
      Effect.sync(() => {
        // 仅处理 Claude 提供商的包
        if (evt.package !== ClaudeProvider.PACKAGE) return
        // opencode spreads the model's settings into options, next to the configured headers and body
        // 依据模型设置/请求头/请求体计算 Claude 进程的连接环境变量
        const connection = ClaudeQueryOptions.connectionEnv({
          // 模型设置
          settings: evt.options,
          // 配置的请求头
          headers: evt.options.headers,
          // 配置的请求体
          body: evt.options.body,
        })
        // 注入 SDK 定义：按模型 ID 构造语言模型
        evt.sdk = {
          // 语言模型工厂
          languageModel: (modelID: string) => new ClaudeAgentLanguageModel.Model(modelID, dependencies, connection),
        }
      }),
    // 仅对 Claude 提供商生效
    { providerID: ClaudeProvider.ID },
  )
})
