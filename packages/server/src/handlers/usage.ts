// 引入用量限制（UsageLimits）服务：查询当前账号的用量与配额
import { UsageLimits } from "@opencode/core/usage-limits"
// 引入服务不可用错误（ServiceUnavailableError）
import { ServiceUnavailableError } from "@opencode/protocol/errors"
// 引入 Effect 运行时
import { Effect } from "effect"
// 引入 HTTP API 构建器
import { HttpApiBuilder } from "effect/http-api"
// 引入本服务 API 定义
import { Api } from "../api"
// 引入 awaitPlugins（等待插件激活）与 response（响应包装）
import { awaitPlugins, response } from "../location"

// 导出 UsageHandler：注册 "server.usage" 分组处理器
export const UsageHandler = HttpApiBuilder.group(Api, "server.usage", (handlers) =>
  Effect.gen(function* () {
    return handlers.handle(
      // 处理 usage.limits：查询用量限制信息
      "usage.limits",
      Effect.fn("server.usage.limits")(function* () {
        // The OpenCode Console plugin registers the sign-in method that refreshes an expired credential.
        // 等待插件激活：OpenCode Console 插件会注册登录方法，用于刷新过期的凭证
        yield* awaitPlugins
        // 获取用量限制服务
        const limits = yield* UsageLimits.Service
        return yield* response(
          limits.get().pipe(
            // 无数据时把 undefined 归一化为 null（便于 JSON 序列化）
            Effect.map((info) => info ?? null),
            // 查询失败映射为服务不可用错误
            Effect.mapError((error) => new ServiceUnavailableError({ message: error.message, service: "opencode" })),
          ),
        )
      }),
    )
  }),
)
