// 将本文件的所有导出聚合到命名空间 WebFetchTool 下，供插件系统统一引入
export * as WebFetchTool from "./webfetch.js"

// 插件上下文类型（Context），提供 tool/session 等扩展点
import type { Context } from "@opencode/plugin/effect/plugin"
// 工具执行失败时抛出的错误类型（ToolFailure）
import { ToolFailure } from "@opencode/ai/effect"
// effect 库核心：Duration 时长、Effect 副作用编排、Schema 数据校验
import { Duration, Effect, Schema } from "effect"
// effect 的 HTTP 客户端相关：客户端、错误、请求与响应工具
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http"
// htmlparser2 的 HTML 解析器，用于提取纯文本
import { Parser } from "htmlparser2"
// Mime：MIME 类型判断工具
import { Mime } from "../../mime.js"
// Permission 服务：权限断言
import { Permission } from "../../permission.js"
// HTML 转 Markdown 工具及输出大小上限
import { convertHTMLToMarkdown, MAX_MARKDOWN_BYTES } from "../html-markdown.js"
// 有大小上限的响应体收集工具
import { collectBoundedResponseBody } from "../http-body.js"

// 工具名称：webfetch（网页抓取）
export const name = "webfetch"
// 响应体最大字节数：复用 Markdown 转换的输出上限
export const MAX_RESPONSE_BYTES = MAX_MARKDOWN_BYTES
// 默认超时时间（秒）
export const DEFAULT_TIMEOUT_SECONDS = 30
// 允许的最大超时时间（秒）
export const MAX_TIMEOUT_SECONDS = 120

// 工具描述：抓取 URL 内容并按 text/markdown/html 返回，默认 markdown
export const description = `Fetch content from an HTTP or HTTPS URL and return it as text, markdown, or HTML. Markdown is the default.

Use a more targeted tool when one is available. This tool is read-only. Large text results may be replaced with a preview while the complete output is retained in managed storage.`

// 超时时间校验：必须是有限数值且大于 0、不超过最大超时
const Timeout = Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(MAX_TIMEOUT_SECONDS))

// 工具入参 Schema
export const Input = Schema.Struct({
  // url：要抓取的 HTTP/HTTPS 地址
  url: Schema.String.annotate({ description: "The HTTP or HTTPS URL to fetch content from" }),
  // format：返回格式，默认 markdown
  format: Schema.Literals(["text", "markdown", "html"])
    .annotate({ description: "The format to return the content in. Defaults to markdown." })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed("markdown" as const))),
  // timeout：可选超时（秒）
  timeout: Schema.optionalKey(Timeout).annotate({
    description: `Optional timeout in seconds (maximum: ${MAX_TIMEOUT_SECONDS})`,
  }),
})

// 工具出参 Schema
const Output = Schema.Struct({
  // 最终请求的 URL
  url: Schema.String,
  // 响应的 Content-Type
  contentType: Schema.String,
  // 返回格式（复用入参中 format 的定义）
  format: Input.fields.format,
  // 输出内容
  output: Schema.String,
})
// 格式字段的类型别名
type Format = (typeof Input.Type)["format"]

// 依据请求格式生成 HTTP Accept 头（按优先级列出可接受的 MIME 类型）
const acceptHeader = (format: Format) => {
  // markdown 格式优先接受 markdown，其次纯文本与 HTML
  switch (format) {
    // markdown：markdown 最优先
    case "markdown":
      return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
    // text：纯文本最优先
    case "text":
      return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1"
    // html：HTML 最优先
    case "html":
      return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1"
  }
}

// 组装请求头：User-Agent、Accept、Accept-Language
const headers = (format: Format, userAgent: string) => ({
  // 客户端标识
  "User-Agent": userAgent,
  // 可接受的内容类型
  Accept: acceptHeader(format),
  // 语言偏好：英文
  "Accept-Language": "en-US,en;q=0.9",
})

// 默认的 User-Agent 字符串
const openCodeUserAgent =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OpenCode-User/1.0; +https://opencode.ai"

// 判断错误是否为 Cloudflare 人机验证挑战（403 且带 cf-mitigated: challenge 头）
const isCloudflareChallenge = (error: unknown) => {
  // 非 HTTP 客户端错误或非状态码错误直接排除
  if (!HttpClientError.isHttpClientError(error) || error.reason._tag !== "StatusCodeError") return false
  // 取出对应的响应
  const response = error.reason.response
  // 状态码 403 且命中 Cloudflare 挑战标记时返回 true
  return response.status === 403 && response.headers["cf-mitigated"] === "challenge"
}

// 构造 GET 请求（附带按格式生成的请求头）
const request = (url: string, format: Format, userAgent = openCodeUserAgent) =>
  HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(headers(format, userAgent)))

// 校验 URL 必须是安全的 HTTP(S) 地址
const assertHttpUrl = (url: URL) => {
  // 协议必须是 http 或 https
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("URL must use http:// or https://")
  // Rules match the URL, so `https://user@evil.com` would slip past a rule for `https://evil.com/*`.
  // 禁止在 URL 中携带凭据，防止绕过权限规则匹配
  if (url.username || url.password) throw new Error("URL must not include credentials")
}

// 最大重定向次数
export const MAX_REDIRECTS = 10
// 视为重定向的 HTTP 状态码集合
const redirectStatuses = new Set([301, 302, 303, 307, 308])

// Follows redirects here instead of in fetch so each new URL is checked against the permission rules first.
// 手动逐跳执行请求并跟随重定向：每跳新 URL 都先过一遍权限规则校验
const execute = (
  // HTTP 客户端实例
  http: HttpClient.HttpClient,
  // 每跳新 URL 前的权限校验函数
  check: (url: string) => Effect.Effect<void, Error>,
  // 当前请求的 URL
  url: string,
  // 期望的返回格式
  format: Format,
  // User-Agent（默认 OpenCode 的标识）
  userAgent = openCodeUserAgent,
  // 已发生的重定向次数
  redirects = 0,
): Effect.Effect<HttpClientResponse.HttpClientResponse, Error> =>
  // 发起请求，并禁用底层 fetch 的自动重定向
  http.execute(request(url, format, userAgent)).pipe(
    // 提供手动重定向的 RequestInit 配置
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    // 收到响应后处理重定向
    Effect.flatMap((response) => {
      // 读取 Location 头
      const location = response.headers.location
      // 非重定向状态或缺少 Location 时，直接按状态码校验返回
      if (!redirectStatuses.has(response.status) || !location) return HttpClientResponse.filterStatusOk(response)
      // 超过最大重定向次数则失败
      if (redirects >= MAX_REDIRECTS) return Effect.fail(new Error(`Too many redirects (more than ${MAX_REDIRECTS})`))
      // 处理一次重定向
      return Effect.gen(function* () {
        // 解析并校验重定向目标
        const next = yield* Effect.try({
          try: () => {
            // 基于当前 URL 解析相对 Location
            const target = new URL(location, url)
            // 校验目标协议与凭据
            assertHttpUrl(target)
            // 清除 fragment（#锚点），避免影响规则匹配
            target.hash = ""
            // 返回最终的目标 URL 字符串
            return target.href
          },
          // 解析异常时统一包装为 Error
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        })
        // 对重定向后的 URL 重新执行权限校验
        yield* check(next)
        // 递归请求新 URL，重定向计数加一
        return yield* execute(http, check, next, format, userAgent, redirects + 1)
      })
    }),
  )

// 在大小限制内收集响应体；超限时抛出明确错误
const collectBody = (response: HttpClientResponse.HttpClientResponse) =>
  collectBoundedResponseBody(
    // 目标响应
    response,
    // 字节数上限
    MAX_RESPONSE_BYTES,
    // 超限时的错误构造
    () => new Error(`Response too large (exceeds ${MAX_RESPONSE_BYTES} byte limit)`),
  )

// 从 Content-Type 中取出 MIME 部分（去掉参数并转小写）
const mimeFrom = (contentType: string) => contentType.split(";", 1)[0]?.trim().toLowerCase() ?? ""
// 判断是否为图片附件（排除 SVG 等文本类图片）
const isImageAttachment = (mime: string) =>
  mime.startsWith("image/") && mime !== "image/svg+xml" && mime !== "image/vnd.fastbidsheet"
// 按目标格式转换 HTML 内容；非 HTML 原样返回
const convert = (content: string, contentType: string, format: Format) => {
  // 非 HTML 内容无需转换
  if (!contentType.includes("text/html")) return content
  // markdown 格式：转成 Markdown
  if (format === "markdown") return convertHTMLToMarkdown(content)
  // text 格式：抽取纯文本
  if (format === "text") return extractTextFromHTML(content)
  // html 格式：原样返回
  return content
}

// 插件定义：注册 webfetch 工具
export const Plugin = {
  // 插件唯一标识
  id: "opencode.tool.webfetch",
  // 插件主 effect：获取服务并注册工具
  effect: Effect.fn("WebFetchTool.Plugin")(function* (ctx: Context) {
    // 获取 HTTP 客户端
    const http = yield* HttpClient.HttpClient
    // 获取权限服务
    const permission = yield* Permission.Service

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
              // Rules are matched against the URL that is requested, so `HTTPS://EVIL.COM` meets a rule for
              // `https://evil.com/*`.
              // 解析并规范化请求 URL：权限规则按请求的 URL 匹配
              const url = yield* Effect.try({
                try: () => {
                  // 解析 URL 字符串
                  const parsed = new URL(input.url)
                  // 校验协议与凭据
                  assertHttpUrl(parsed)
                  // The fragment is never sent, and would keep a rule for the exact URL from matching.
                  // 去掉 fragment（不会发送，但会妨碍精确 URL 规则匹配）
                  parsed.hash = ""
                  // 返回规范化后的 URL
                  return parsed.href
                },
                // 解析/校验异常原样抛出
                catch: (error) => error,
              })

              // 对请求 URL 做权限断言（action: webfetch）
              yield* permission.assert({
                // 权限动作名
                action: name,
                // 作用资源：目标 URL
                resources: [url],
                // 用户允许时记住该授权
                save: ["*"],
                // 元数据附带完整入参
                metadata: input,
                // 附带调用方信息
                ...Permission.invocation(context),
              })

              // 执行请求并收集响应体（带超时）
              const { body, contentType } = yield* Effect.gen(function* () {
                // 每跳重定向前的权限校验：确保未被拒绝
                const check = (next: string) =>
                  permission.assertNotDenied({
                    // 权限动作名
                    action: name,
                    // 作用资源：重定向目标 URL
                    resources: [next],
                    // 元数据附带更新后的 URL
                    metadata: { ...input, url: next },
                    // 附带调用方信息
                    ...Permission.invocation(context),
                  })
                // 发起请求；命中 Cloudflare 挑战时改用 "opencode" UA 重试一次
                const response = yield* execute(http, check, url, input.format).pipe(
                  Effect.catchIf(isCloudflareChallenge, () => execute(http, check, url, input.format, "opencode")),
                )
                // 读取响应的 Content-Type（缺省为空串）
                const contentType = response.headers["content-type"] || ""
                // 提取 MIME 类型
                const mime = mimeFrom(contentType)
                // 图片附件不被支持，直接失败
                if (isImageAttachment(mime))
                  return yield* Effect.fail(new Error(`Unsupported fetched image content type: ${mime}`))
                // 非文本类 MIME 也不被支持
                if (!Mime.isTextual(mime))
                  return yield* Effect.fail(new Error(`Unsupported fetched file content type: ${mime}`))
                // 收集响应体并返回其与 Content-Type
                return { body: yield* collectBody(response), contentType }
              }).pipe(
                // 整个请求流程套上超时控制
                Effect.timeoutOrElse({
                  // 超时时长：入参指定或默认 30 秒
                  duration: Duration.seconds(input.timeout ?? DEFAULT_TIMEOUT_SECONDS),
                  // 超时后统一报错
                  orElse: () => Effect.fail(new Error("Request timed out")),
                }),
              )
              // 把响应体字节解码为文本
              const content = new TextDecoder().decode(body)
              // 按目标格式转换内容（失败则抛错）
              const output = yield* Effect.try({
                // 执行格式转换
                try: () => convert(content, contentType, input.format),
                // 异常原样抛出
                catch: (error) => error,
              })
              // 组装工具输出
              const result = {
                // 原始请求 URL
                url: input.url,
                // 响应 Content-Type
                contentType,
                // 实际使用的格式
                format: input.format,
                // 转换后的内容
                output,
              }
              // 返回工具响应：output/正文/元数据
              return { output: result, content: result.output, metadata: { contentType: result.contentType } }
            }).pipe(Effect.mapError((error) => new ToolFailure({ message: `Unable to fetch ${input.url}`, error }))),
        }),
      )
      // 注册失败则直接终止
      .pipe(Effect.orDie)
  }),
}

// 从 HTML 中抽取纯文本：跳过 script/style 等无意义标签的内容
export function extractTextFromHTML(html: string) {
  // 累积的文本结果
  let text = ""
  // 当前需要跳过的标签嵌套深度（大于 0 表示处于要忽略的标签内）
  let skipDepth = 0
  // 创建 HTML 解析器并注册回调
  const parser = new Parser({
    // 遇到开标签：若已在跳过区或进入黑名单标签，则深度加一
    onopentag(name) {
      if (skipDepth > 0 || ["script", "style", "noscript", "iframe", "object", "embed"].includes(name)) skipDepth++
    },
    // 遇到文本：只有在非跳过区才收集
    ontext(input) {
      if (skipDepth === 0) text += input
    },
    // 遇到闭标签：退出跳过区时深度减一
    onclosetag() {
      if (skipDepth > 0) skipDepth--
    },
  })
  // 喂入 HTML 内容
  parser.write(html)
  // 结束解析
  parser.end()
  // 返回去除首尾空白后的纯文本
  return text.trim()
}

// 透传导出 HTML 转 Markdown 的实现
export { convertHTMLToMarkdown }
