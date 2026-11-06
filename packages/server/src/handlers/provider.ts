// 引入提供商（Provider）核心服务：AI 提供商信息
import { Provider } from "@opencode/core/provider"
// 引入提供商未找到错误（ProviderNotFoundError）
import { ProviderNotFoundError } from "@opencode/protocol/errors"
// 引入 Effect 运行时
import { Effect } from "effect"
// 引入 HTTP API 构建器
import { HttpApiBuilder } from "effect/http-api"
// 引入本服务 API 定义
import { Api } from "../api"
// 引入 awaitPlugins（等待插件激活）与 response（响应包装）
import { awaitPlugins, response } from "../location"

// 导出 ProviderHandler：注册 "server.provider" 分组处理器
export const ProviderHandler = HttpApiBuilder.group(Api, "server.provider", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle(
        // 处理 provider.list：列出当前可用的提供商
        "provider.list",
        Effect.fn(function* () {
          // 等待插件激活完成（插件可能注册额外提供商）
          yield* awaitPlugins
          // 获取提供商服务
          const providers = yield* Provider.Service
          // 返回可用列表（响应附带 location 信息）
          return yield* response(providers.available())
        }),
      )
      .handle(
        // 处理 provider.get：按 ID 获取单个提供商详情
        "provider.get",
        Effect.fn(function* (ctx) {
          // 获取提供商服务
          const providers = yield* Provider.Service
          // 查询指定提供商
          const provider = yield* providers.get(ctx.params.providerID)
          // 不存在则返回 ProviderNotFoundError
          if (!provider)
            return yield* new ProviderNotFoundError({
              providerID: ctx.params.providerID,
              message: `Provider not found: ${ctx.params.providerID}`,
            })
          // 经 response 包装返回提供商详情
          return yield* response(Effect.succeed(provider))
        }),
      )
  }),
)
