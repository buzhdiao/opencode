// 引入网络搜索（WebSearch）核心服务：搜索提供商与查询
import { WebSearch } from "@opencode/core/websearch"
// 引入协议层错误：无效请求与服务不可用
import { InvalidRequestError, ServiceUnavailableError } from "@opencode/protocol/errors"
// 引入 Effect 运行时
import { Effect } from "effect"
// 引入 HTTP API 构建器
import { HttpApiBuilder } from "effect/http-api"
// 引入本服务 API 定义
import { Api } from "../api"
// 引入 awaitPlugins（等待插件激活）与 response（响应包装）
import { awaitPlugins, response } from "../location"

// 导出 WebSearchHandler：注册 "server.websearch" 分组处理器
export const WebSearchHandler = HttpApiBuilder.group(Api, "server.websearch", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle(
        // 处理 websearch.providers：列出可用的搜索提供商
        "websearch.providers",
        Effect.fn("server.websearch.providers")(function* () {
          // 获取网络搜索服务
          const websearch = yield* WebSearch.Service
          // 经 response 包装返回提供商列表
          return yield* response(websearch.providers())
        }),
      )
      .handle(
        // 处理 websearch.query：执行一次网络搜索
        "websearch.query",
        Effect.fn("server.websearch.query")(function* (request) {
          // A cold Location must finish activating plugins before their providers can be resolved.
          // 冷启动的 Location 必须先完成插件激活，其搜索提供商才能被解析
          yield* awaitPlugins
          // 获取网络搜索服务
          const websearch = yield* WebSearch.Service
          return yield* response(
            // 执行查询；按错误类型分别映射
            websearch.query(request.payload).pipe(
              Effect.catchTags({
                // 未指定提供商 -> InvalidRequestError（标注 providerID 字段）
                "WebSearch.ProviderRequired": () =>
                  new InvalidRequestError({
                    message: "Web search provider is required",
                    kind: "websearch_provider_required",
                    field: "providerID",
                  }),
                // 指定的提供商不存在 -> InvalidRequestError
                "WebSearch.ProviderNotFound": (error) =>
                  new InvalidRequestError({
                    message: `Web search provider not found: ${error.providerID}`,
                    kind: "websearch_provider_not_found",
                    field: "providerID",
                  }),
                // 网络搜索被禁用 -> InvalidRequestError
                "WebSearch.Disabled": () =>
                  new InvalidRequestError({ message: "Web search is disabled", kind: "websearch_disabled" }),
                // 搜索请求失败 -> ServiceUnavailableError（service 标识出错的提供商）
                "WebSearch.Request": (error) =>
                  new ServiceUnavailableError({
                    message: `Web search request failed: ${error.providerID}`,
                    service: error.providerID,
                  }),
              }),
            ),
          )
        }),
      )
  }),
)
