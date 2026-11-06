// 将本模块以命名空间 `WebSearchProvider` 全量导出
export * as WebSearchProvider from "./provider.js"

// 引入插件上下文类型（仅类型）
import type { Context } from "@opencode/plugin/effect/plugin"
// 引入凭据类型（仅类型）
import type { Credential } from "@opencode/schema/credential"
// 引入网页搜索 schema 类型（仅类型）
import type { WebSearch } from "@opencode/schema/websearch"
// 引入 Effect 原语
import { Effect } from "effect"

/** Registers a web search provider backed by an API key integration with the same ID and name. */
// 注册一个网页搜索提供方：背后是同名同 ID 的 API key 集成（integration）
export const register = Effect.fn("WebSearchProvider.register")(function* (
  ctx: Context,
  // 提供方描述：id、名称、凭据环境变量与执行函数
  provider: {
    // 提供方唯一标识
    readonly id: string
    // 显示名称
    readonly name: string
    // 凭据环境变量名
    readonly env: string
    // 执行搜索：输入与（可选的）已解析凭据，返回结果数组
    readonly execute: (
      input: WebSearch.ProviderInput,
      credential: Credential.Value | undefined,
    ) => Effect.Effect<readonly WebSearch.Result[], unknown>
  },
) {
  // 第一步：注册集成（integration）——更新名称并声明两种凭据方式
  yield* ctx.integration.transform((editor) => {
    // 更新集成名称为提供方名称
    editor.update(provider.id, (integration) => (integration.name = provider.name))
    // 声明支持显式密钥（key）方式
    editor.method.update({
      integrationID: provider.id,
      method: { type: "key" },
    })
    // 声明支持环境变量（env）方式
    editor.method.update({
      integrationID: provider.id,
      method: { type: "env", names: [provider.env] },
    })
  })
  // 第二步：注册网页搜索提供方，执行时先解析活跃连接的凭据
  yield* ctx.websearch.transform((editor) => {
    editor.add({
      // 提供方 id
      id: provider.id,
      // 显示名称
      name: provider.name,
      // 执行函数：先取活跃连接与凭据，再委托 provider.execute
      execute: (input) =>
        Effect.gen(function* () {
          // 查询该集成当前活跃的连接
          const connection = yield* ctx.integration.connection.active(provider.id)
          // 有连接则解析其凭据，否则为 undefined
          const credential = connection ? yield* ctx.integration.connection.resolve(connection) : undefined
          // 委托提供方执行搜索
          return yield* provider.execute(input, credential)
        }),
    })
  })
})
