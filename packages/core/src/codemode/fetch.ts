// 将本模块以命名空间（namespace）形式整体导出；CodeModeFetch 为 Code Mode 程序提供受控的 fetch 能力
export * as CodeModeFetch from "./fetch.js"

// 导入 Code Mode 扩展（Extension）机制：把函数作为全局能力注入程序
import { Extension } from "@opencode/codemode"
// 导入 isRecord：判断值是否为普通对象
import { isRecord } from "@opencode/util/record"
// 导入 Effect
import { Effect } from "effect"
// 导入权限（Permission）服务：执行 webfetch 授权检查
import { Permission } from "../permission.js"
// 导入 CodeModeExecution：读取当前执行的工具上下文（会话/消息信息）
import { CodeModeExecution } from "./execution.js"

// 单次请求的超时时间：30 秒（毫秒）
const TIMEOUT_MS = 30_000

// 定义 Init 类型：fetch 的可选初始化参数（方法、头、体）
type Init = {
  // HTTP 方法（可选，默认 GET）
  readonly method?: string
  // 请求头：键值对象或键值对数组
  readonly headers?: Record<string, string> | Array<[string, string]>
  // 请求体：字符串、字节数组或 URLSearchParams
  readonly body?: string | Uint8Array<ArrayBuffer> | URLSearchParams
}

// 定义 fetch：受权限约束、跟随重定向并复用 webfetch 规则的 HTTP 请求
const fetch = (input: string | URL, init: Init = {}) =>
  Effect.gen(function* () {
    // Rules match the URL as written. The fragment is never sent, and would keep a rule for the exact URL from
    // matching.
    const url = String(input).split("#")[0]
    const parsed = URL.parse(url)
    if (parsed?.protocol === "file:") return yield* Effect.fail(new Error("fetch cannot be used for filesystem access."))
    // Rules match the URL, so `https://user@evil.com` would slip past a rule for `https://evil.com/*`.
    if (parsed?.username || parsed?.password)
      return yield* Effect.fail(new TypeError("fetch cannot be used with credentials in the URL."))
    const execution = yield* CodeModeExecution.Service
    // 取权限服务
    const permission = yield* Permission.Service
    // 标记来源为工具调用：带上消息 ID 与调用 ID
    const source = { type: "tool" as const, messageID: execution.messageID, id: execution.id }
    // The same rules as the webfetch tool, so a URL denied there is denied here.
    // 断言 webfetch 权限：与 webfetch 工具共用同一套规则，被拒的 URL 在这里同样被拒
    yield* permission
      .assert({
        action: "webfetch",
        resources: [url],
        save: ["*"],
        metadata: display([input, init]),
        sessionID: execution.sessionID,
        agent: execution.agent,
        source,
      })
      .pipe(
        // The feedback is the user talking to the model, so it must reach the program as the error's message.
        // 用户拒绝时把反馈文本放进错误消息：程序里抛出的就是模型要看到的话
        Effect.catchTag("Permission.CorrectedError", (error) =>
          Effect.fail(new Error(`The user rejected fetching ${url}: ${error.feedback}`)),
        ),
      )
    // Redirects are followed here so each new URL meets the same deny rules as the webfetch tool's hops.
    // 定义 check：重定向到新 URL 前确认它未被显式拒绝（沿用 webfetch 的逐跳规则）
    const check = (next: string) =>
      permission.assertNotDenied({
        action: "webfetch",
        resources: [next],
        metadata: { ...display([next, init]), redirectedFrom: url },
        sessionID: execution.sessionID,
        agent: execution.agent,
        source,
      })
    // 创建 30 秒后自动中止的 AbortSignal
    const signal = AbortSignal.timeout(TIMEOUT_MS)
    // 定义 follow：递归发起请求并处理重定向链
    const follow = (
      target: string,
      request: Init,
      redirects: number,
    ): Effect.Effect<{ response: Response; url: string; redirects: number }, unknown> =>
      // 以手动重定向模式发起真实请求（fetch 到结果后自行处理跳转）
      Effect.tryPromise({
        try: () => globalThis.fetch(target, { ...request, redirect: "manual", signal }),
        catch: (error) => error,
      }).pipe(
        // 拿到响应后判断是否需要跟随重定向
        Effect.flatMap((response) => {
          // 读取 location 头
          const location = response.headers.get("location")
          // 非重定向状态或缺少 location：直接返回当前响应
          if (!redirectStatuses.has(response.status) || location === null)
            return Effect.succeed({ response, url: target, redirects })
          // 重定向次数超限则报错
          if (redirects >= MAX_REDIRECTS)
            return Effect.fail(new Error(`Too many redirects (more than ${MAX_REDIRECTS})`))
          // 相对路径的 location 以当前 URL 为基准解析
          const next = new URL(location, target)
          // 只允许跟随到 http/https 协议
          if (next.protocol !== "http:" && next.protocol !== "https:")
            return Effect.fail(new Error(`fetch cannot follow a redirect to ${next.protocol} URLs.`))
          // 重定向目标同样禁止内嵌凭据
          if (next.username || next.password)
            return Effect.fail(new Error("fetch cannot follow a redirect with credentials in the URL."))
          // 清掉目标的锚点
          next.hash = ""
          // 检查新 URL 未被拒绝后递归跟随，次数 +1
          return check(next.href).pipe(
            Effect.andThen(follow(next.href, redirected(request, response.status, target, next), redirects + 1)),
          )
        }),
      )
    // 从初始 URL 开始跟随请求
    const result = yield* follow(url, init, 0)
    // 读取响应内容并构造简化的返回对象
    return yield* Effect.tryPromise({ try: () => read(result), catch: (error) => error })
  })

// 允许的最大重定向次数
export const MAX_REDIRECTS = 20
// 视为重定向的 HTTP 状态码集合
const redirectStatuses = new Set([301, 302, 303, 307, 308])

// The request a browser sends after a redirect: 303, and 301/302 after a POST, become a GET without a body, and
// credentials are not sent to another origin.
// 定义 redirected：按浏览器语义构造重定向后的请求（303，以及 POST 后的 301/302 改为无体 GET；跨源不带凭据）
const redirected = (request: Init, status: number, from: string, to: URL): Init => {
  // 取原请求方法（缺省 GET），统一大写便于比较
  const method = request.method?.toUpperCase() ?? "GET"
  // 判断是否应转为 GET：303 且非 HEAD，或 301/302 且原方法为 POST
  const toGet = status === 303 ? method !== "HEAD" : (status === 301 || status === 302) && method === "POST"
  // 复制原请求头以便裁剪
  const headers = new Headers(request.headers)
  // 转 GET 时删除所有与 body 相关的头
  if (toGet)
    ["content-type", "content-length", "content-encoding", "content-language", "content-location"].forEach((name) =>
      headers.delete(name),
    )
  // 跨源（origin 不同）时不携带授权与 Cookie 类头
  if (new URL(from).origin !== to.origin)
    ["authorization", "cookie", "proxy-authorization"].forEach((name) => headers.delete(name))
  // 返回重定向后的请求参数
  return {
    method: toGet ? "GET" : request.method,
    headers: Array.from(headers),
    body: toGet ? undefined : request.body,
  }
}

// 定义 read：把 Response 转成程序可用的简化对象（字节、头、文本/JSON 访问器）
const read = async (result: { response: Response; url: string; redirects: number }) => {
  // 取最终响应
  const response = result.response
  // 一次性读出全部字节
  const bytes = await response.bytes()
  // 把响应头折叠成小写键的对象
  const headers = Object.fromEntries(response.headers)
  // 定义 text：把字节按 UTF-8 解码为字符串
  const text = () => new TextDecoder().decode(bytes)
  // 返回简化响应对象
  return {
    // 最终 URL（跟随重定向后）
    url: result.url,
    // 状态码
    status: response.status,
    // 状态文本
    statusText: response.statusText,
    // 是否成功（2xx）
    ok: response.ok,
    // 是否发生过重定向
    redirected: result.redirects > 0,
    // 头访问器：get / has / entries
    headers: {
      // 按小写名取头值，取不到返回 null
      get: (name: string) => headers[name.toLowerCase()] ?? null,
      // 判断某个头是否存在
      has: (name: string) => name.toLowerCase() in headers,
      // 遍历全部头键值
      entries: () => Object.entries(headers),
    },
    // 异步取文本
    text: async () => text(),
    // 异步取 JSON（解析为 unknown）
    json: async () => JSON.parse(text()) as unknown,
    // 异步取原始字节
    bytes: async () => bytes,
  }
}

// 导出扩展定义：把上面的 fetch 以异步全局函数的形式注入 Code Mode 程序
export const extension = Extension.make({ name: "fetch", globals: { fetch: Extension.async(fetch) } })

/** What to show for a fetch call: its method and URL. */
// 导出 display：生成 fetch 调用的展示元数据（方法 + URL）
export const display = (args: ReadonlyArray<unknown>) => {
  // 解构出输入与 init 参数
  const [input, init] = args
  // init 为对象且带字符串 method 时取大写，否则默认 GET
  const method = isRecord(init) && typeof init.method === "string" ? init.method.toUpperCase() : "GET"
  // 返回方法与 URL
  return { method, url: String(input) }
}
