// 引入模型（Model）核心服务：可用模型与默认模型
import { Model } from "@opencode/core/model"
// 引入 Effect 运行时
import { Effect } from "effect"
// 引入 HTTP API 构建器
import { HttpApiBuilder } from "effect/http-api"
// 引入本服务 API 定义
import { Api } from "../api"
// 引入 awaitPlugins（等待插件激活）与 response（响应包装）
import { awaitPlugins, response } from "../location"

// 导出 ModelHandler：注册 "server.model" 分组处理器
export const ModelHandler = HttpApiBuilder.group(Api, "server.model", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle(
        // 处理 model.list：列出当前可用的模型
        "model.list",
        Effect.fn(function* (ctx) {
          // 等待插件激活完成（插件可能注册额外模型）
          yield* awaitPlugins
          // 获取模型服务
          const models = yield* Model.Service
          // 按查询的类型过滤（types）并列出；响应附带 location 信息
          return yield* response(models.available(ctx.query.types))
        }),
      )
      .handle(
        // 处理 model.default：返回默认模型
        "model.default",
        Effect.fn(function* () {
          // 等待插件激活完成
          yield* awaitPlugins
          // 获取模型服务
          const models = yield* Model.Service
          // 返回默认模型（响应附带 location 信息）
          return yield* response(models.default())
        }),
      )
  }),
)
