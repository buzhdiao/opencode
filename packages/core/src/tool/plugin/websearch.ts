// 将本文件的所有导出聚合到命名空间 WebSearchTool 下，供插件系统统一引入
export * as WebSearchTool from "./websearch.js"

// 插件上下文类型（Context），提供 tool/session 等扩展点
import type { Context } from "@opencode/plugin/effect/plugin"
// 会话钩子（SessionHooks）的类型定义
import type { SessionHooks } from "@opencode/plugin/effect/session"
// 工具执行失败时抛出的错误类型（ToolFailure）
import { ToolFailure } from "@opencode/ai/effect"
// effect 库核心：Effect 编排、Schema 校验、Semaphore 信号量
import { Effect, Schema, Semaphore } from "effect"
// HTTP 客户端错误类型（用于识别状态码）
import { HttpClientError } from "effect/http"
// Form 服务：向用户发起交互表单询问
import { Form } from "../../form.js"
// Permission 服务：权限断言
import { Permission } from "../../permission.js"
// WebSearch 服务：搜索提供商查询与选择
import { WebSearch } from "../../websearch.js"

// 工具名称：websearch（网页搜索）
export const name = "websearch"
// 无搜索结果时返回的提示文案
export const NO_RESULTS = "No search results found. Please try a different query."
// 提供商选择互斥锁：保证并发请求时只弹出一次选择表单
const providerSelectionLock = Semaphore.makeUnsafe(1)
// HTTP 状态码到错误文案的映射
const httpErrors = new Map([
  // 限流
  [429, "Web search rate limited (HTTP 429)"],
  // 鉴权失败
  [401, "Web search authentication failed (HTTP 401)"],
])

// 工具描述：使用用户选定的搜索集成联网搜索，并提示当前年份
export const description = `Search the web using the user's selected search integration. Use this for current information beyond knowledge cutoff.

The current year is ${new Date().getFullYear()}. Use this year when searching for recent information or current events.`

// 工具入参 Schema
export const Input = Schema.Struct({
  // query：搜索关键词
  query: Schema.String.annotate({ description: "Websearch query" }),
})

// 工具出参 Schema
const Output = Schema.Struct({
  // 实际使用的搜索提供商 ID
  provider: WebSearch.ID,
  // 搜索结果数组
  results: Schema.Array(WebSearch.Result),
})
// 插件定义：注册 websearch 工具及上下文钩子
export const Plugin = {
  // 插件唯一标识
  id: "opencode.tool.websearch",
  // 插件主 effect：获取服务并注册工具
  effect: Effect.fn("WebSearchTool.Plugin")(function* (ctx: Context) {
    // 获取权限服务
    const permission = yield* Permission.Service
    // 获取表单交互服务
    const forms = yield* Form.Service
    // 获取网页搜索服务
    const websearch = yield* WebSearch.Service

    // 向工具注册表提交本工具的定义
    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          // 工具名
          name,
          // 关闭 codemode（不作为代码模式调用）
          options: { codemode: false },
          // 工具描述
          description,
          // 入参 Schema
          input: Input,
          // 出参 Schema
          output: Output,
          // 工具执行体
          execute: (input, context) =>
            Effect.gen(function* () {
              // 对搜索关键词做权限断言（action: websearch）
              yield* permission.assert({
                // 权限动作名
                action: name,
                // 作用资源：搜索词
                resources: [input.query],
                // 用户允许时记住该授权
                save: ["*"],
                // 元数据附带完整入参
                metadata: input,
                // 附带调用方信息
                ...Permission.invocation(context),
              })
              // 定义搜索调用：可指定提供商 ID，并上报进度
              const search = (providerID?: WebSearch.ID) =>
                websearch.query(
                  // 查询参数：入参 + 可选的提供商 ID
                  { ...input, providerID },
                  {
                    // 所属会话
                    sessionID: context.sessionID,
                    // 提供商切换时向调用方推送进度
                    onProvider: (provider) => context.progress({ provider: provider.id }),
                  },
                )
              // 先用默认配置执行搜索；缺提供商时进入选择流程
              const result = yield* search().pipe(
                // 捕获"缺少搜索提供商"错误，引导用户选择
                Effect.catchTag("WebSearch.ProviderRequired", () => {
                  // 加互斥锁执行提供商选择，避免并发弹多次表单
                  return providerSelectionLock
                    .withPermit(
                      Effect.gen(function* () {
                        // 已有默认提供商则无需选择
                        if (yield* websearch.default()) return
                        // 取出可用提供商列表
                        const providers = (yield* ctx.websearch.providers()).data
                        // 暂取第一个作为默认候选
                        const defaultProvider = providers[0]
                        // 没有任何提供商时抛出"需要提供商"错误
                        if (!defaultProvider) return yield* new WebSearch.ProviderRequiredError()
                        // 弹出询问表单：是否允许联网搜索
                        const response = yield* forms.ask({
                          // 所属会话
                          sessionID: context.sessionID,
                          // 表单标题
                          title: "Web Search",
                          // 元数据标记表单类型
                          metadata: { kind: "websearch.provider" },
                          // 表单字段定义
                          fields: [
                            {
                              // 字段键名
                              key: "choice",
                              // 字段说明
                              description: "Allow OpenCode to search the web for up-to-date information?",
                              // 字符串类型（单选）
                              type: "string",
                              // 必填
                              required: true,
                              // 不允许自定义输入
                              custom: false,
                              // 三个选项
                              options: [
                                {
                                  // 允许：使用列出的提供商搜索
                                  value: "allow",
                                  label: `Allow search via ${providers.map((provider) => provider.name).join(", ")}`,
                                },
                                {
                                  // 自行选择其它提供商
                                  value: "choose",
                                  label: "Choose another provider",
                                },
                                // 禁用网页搜索
                                { value: "disable", label: "Disable web search" },
                              ],
                            },
                          ],
                        })
                        // 用户取消时视为搜索取消
                        if (response.status === "cancelled")
                          return yield* Effect.fail(new Error("Web search cancelled"))
                        // 选择禁用：记住偏好并抛出"已禁用"错误
                        if (response.answer.choice === "disable") {
                          // 持久化禁用选择
                          yield* websearch.select(false)
                          // 抛出禁用错误
                          return yield* new WebSearch.DisabledError()
                        }
                        // 选择"choose"时再弹出提供商选择表单，否则无二次选择
                        const selection =
                          response.answer.choice === "choose"
                            ? yield* forms.ask({
                                // 所属会话
                                sessionID: context.sessionID,
                                // 表单标题
                                title: "Choose a web search provider",
                                // 元数据标记表单类型
                                metadata: { kind: "websearch.provider" },
                                // 提供商单选字段
                                fields: [
                                  {
                                    // 字段键名
                                    key: "provider",
                                    // 字段说明
                                    description: "Choose a provider for web search.",
                                    // 字符串类型（单选）
                                    type: "string",
                                    // 必填
                                    required: true,
                                    // 不允许自定义输入
                                    custom: false,
                                    // 逐个列出可用提供商
                                    options: providers.map((provider) => ({
                                      // 选项值为提供商 ID
                                      value: provider.id,
                                      // 选项显示名为提供商名称
                                      label: provider.name,
                                    })),
                                  },
                                ],
                              })
                            : undefined
                        // 二次选择被取消时同样视为搜索取消
                        if (selection?.status === "cancelled")
                          return yield* Effect.fail(new Error("Web search cancelled"))
                        // 取所选提供商 ID；未选择时使用随机策略
                        const providerID = selection?.answer.provider ?? "random"
                        // 随机策略：记住选择后返回（不指定具体提供商）
                        if (providerID === "random") {
                          // 持久化随机选择
                          yield* websearch.select("random")
                          // 结束选择流程
                          return
                        }
                        // 校验所选提供商确实存在
                        const provider = providers.find((provider) => provider.id === providerID)
                        // 不存在则要求重新选择
                        if (!provider) return yield* new WebSearch.ProviderRequiredError()
                        // 持久化所选提供商
                        yield* websearch.select(provider.id)
                        // 返回选中的提供商 ID
                        return provider.id
                      }),
                    )
                    .pipe(
                      // 整个选择流程限时 1 分钟，超时视为取消
                      Effect.timeoutOrElse({
                        duration: "1 minute",
                        orElse: () => Effect.fail(new Error("Web search cancelled")),
                      }),
                      // 选定提供商后重新执行搜索
                      Effect.flatMap(search),
                    )
                }),
              )
              // 组装输出：提供商 ID 与结果列表
              const output = {
                // 使用的提供商
                provider: result.providerID,
                // 搜索结果
                results: result.results,
              }
              // 把结果渲染成 Markdown 文本；无结果时返回提示
              const content = output.results.length
                ? output.results
                    // 逐条把结果转为 "## [标题](URL)" 格式
                    .map((result) => {
                      // 标题缺失时回退为 URL
                      const title = result.title ?? result.url
                      // 有发布时间时附加 ISO 格式的发布时间行
                      const published = result.time.published
                        ? `\nPublished: ${new Date(result.time.published).toISOString()}`
                        : ""
                      // 拼接单条结果的 Markdown
                      return `## [${title}](${result.url})${published}${result.content ? `\n\n${result.content}` : ""}`
                    })
                    // 条目间用空行分隔
                    .join("\n\n")
                : NO_RESULTS
              // 返回工具响应：output/正文/元数据
              return { output, content, metadata: { provider: output.provider } }
            }).pipe(
              // 统一错误处理：区分搜索请求错误与普通错误
              Effect.mapError((error) => {
                // 通用兜底错误文案
                const fallback = `Unable to search the web for ${input.query}`
                // 非搜索请求错误直接用兜底文案
                if (!Schema.is(WebSearch.RequestError)(error)) return new ToolFailure({ message: fallback, error })
                // 若底层是 HTTP 错误则取出状态码
                const status = HttpClientError.isHttpClientError(error.cause) ? error.cause.response?.status : undefined
                // 构造带状态码信息的错误（优先使用预映射文案）
                return new ToolFailure({
                  // 有状态码时用映射文案或通用 HTTP 文案
                  message:
                    status === undefined
                      ? fallback
                      : (httpErrors.get(status) ?? `Web search request failed (HTTP ${status})`),
                  // 原始错误
                  error,
                  // 元数据携带出错提供商
                  metadata: { provider: error.providerID },
                })
              }),
            ),
        }),
      )
      // 注册失败则直接终止
      .pipe(Effect.orDie)

    // 构造上下文钩子：搜索不可用时从工具列表中移除 websearch
    const hook = (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
        // 判断是否处于"已禁用"状态（默认查询失败且命中 Disabled 标签）
        const disabled = yield* websearch.default().pipe(
          // 查询成功说明未禁用
          Effect.as(false),
          // 捕获"已禁用"错误则视为禁用
          Effect.catchTag("WebSearch.Disabled", () => Effect.succeed(true)),
        )
        // Policy can remove every provider, and the model shouldn't be offered a tool that can't search.
        // 策略可能移除所有提供商；无提供商或已禁用时不向模型提供该工具
        if (disabled || (yield* websearch.providers()).length === 0) delete event.tools[name]
      })
    // 在 context（上下文构建）钩子上挂载
    yield* ctx.session.hook("context", hook)
    // 在 compaction（会话压缩）钩子上挂载
    yield* ctx.session.hook("compaction", hook)
    // 在 generate（模型生成）钩子上挂载
    yield* ctx.session.hook("generate", hook)
  }),
}
