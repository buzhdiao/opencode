// 导入集成 OAuth 方法注册类型
import type { IntegrationOAuthMethodRegistration } from "@opencode/plugin/effect/integration"
// 导入插件定义工具 define
import { define } from "@opencode/plugin/effect/plugin"
// 从 effect 库导入时钟、Deferred、Effect、Option 与 Schema
import { Clock, Deferred, Effect, Option, Schema } from "effect"
// 导入 HTTP 客户端相关工具
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
// 导入 Node http 服务器类型
import type { Server } from "node:http"
// 导入应用信息（User-Agent 用）
import { App } from "../../app.js"
// 导入凭据模块
import { Credential } from "../../credential.js"
// 导入集成模块
import { Integration } from "../../integration.js"
// 导入集成连接模块
import { IntegrationConnection } from "../../integration/connection.js"
// 导入模型模块
import { Model } from "../../model.js"
// 导入 OAuth 回调页面
import { OauthCallbackPage } from "../../oauth/page.js"
// 导入 Provider 模块
import { Provider } from "../../provider.js"
// 导入共享缓存服务
import { SharedCache } from "../../shared-cache.js"
// 导入插件内部类型
import type { PluginInternal } from "../internal.js"
// 导入激活凭据解析工具
import { activeCredential } from "./credential-settings.js"
// 导入供应商刷新工具
import { ProviderRefresh } from "./refresh.js"

// 供应商 ID
const providerID = Provider.ID.make("digitalocean")
// 集成 ID
const integrationID = Integration.ID.make("digitalocean")
// 登录方法 ID：浏览器 OAuth
const methodID = Integration.MethodID.make("browser")

// OAuth 应用的 client ID
const clientID = "b1a6c5158156caac821fd1b30253ca8acb52454a48fa744420e41889cb589f82"
// DigitalOcean 授权端点
const authorizeEndpoint = "https://cloud.digitalocean.com/v1/oauth/authorize"
// 推理路由（routers）列表端点
const routersEndpoint = "https://api.digitalocean.com/v2/gen-ai/models/routers"
// 本地回调端口
const callbackPort = 1456
// 回调路径
const callbackPath = "/auth/callback"
// 回调页面提交 token 的路径
const tokenPath = "/auth/token"
// 路由列表响应的 Schema：model_routers 数组，每项含非空名称
const RoutersResponse = Schema.Struct({
  model_routers: Schema.Array(Schema.Struct({ name: Schema.NonEmptyString })),
})
// 路由列表类型
type Routers = (typeof RoutersResponse.Type)["model_routers"]
// 回调载荷解码器：从 JSON 字符串中解析 OAuth 回调参数
const decodeCallback = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      // 访问令牌（可选）
      access_token: Schema.optional(Schema.String),
      // 过期秒数（可选）
      expires_in: Schema.optional(Schema.String),
      // 防 CSRF 的 state（可选）
      state: Schema.optional(Schema.String),
      // 错误码（可选）
      error: Schema.optional(Schema.String),
      // 错误描述（可选）
      error_description: Schema.optional(Schema.String),
    }),
  ),
)

// OAuth 登录方法注册
const oauth = {
  // 所属集成
  integrationID,
  // 方法描述
  method: {
    // 方法 ID
    id: methodID,
    // 类型：OAuth
    type: "oauth",
    // 标签
    label: "Login with DigitalOcean",
  },
  // 授权流程
  authorize: () =>
    Effect.gen(function* () {
      // 生成 32 字节随机 state（base64url 编码）
      const state = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
      // 创建 Deferred 用于传递令牌结果（成功/失败）
      const token = yield* Deferred.make<{ access: string; expiresIn: number }, Error>()
      // 延迟加载 node:http，让没有 loopback 监听能力的运行时（workerd）永不求值它
      // Lazy so runtimes without a loopback listener (workerd) never evaluate node:http.
      const { createServer } = yield* Effect.promise(() => import("node:http"))
      // 创建本地 HTTP 服务器处理回调
      const server = createServer((request, response) => {
        // 解析请求 URL
        const url = new URL(request.url ?? "/", "http://localhost")
        // GET 回调路径：返回引导页（由页面脚本向 tokenPath 提交令牌）
        if (request.method === "GET" && url.pathname === callbackPath) {
          response
            .writeHead(200, { "Content-Type": "text/html" })
            .end(OauthCallbackPage.bootstrap({ tokenPath, provider: "DigitalOcean" }))
          return
        }
        // POST token 路径：接收令牌载荷
        if (request.method === "POST" && url.pathname === tokenPath) {
          // 收集请求体分块
          const chunks: Buffer[] = []
          request.on("data", (chunk: Buffer) => chunks.push(chunk))
          request.on("end", () => {
            // 拼接并解码回调载荷
            const body = Option.getOrUndefined(decodeCallback(Buffer.concat(chunks).toString("utf8")))
            // 提取错误信息
            const error = body?.error_description || body?.error
            // 提取访问令牌
            const access = body?.access_token
            // 校验：有错误、缺令牌或 state 不匹配都算失败
            if (error || !access || body?.state !== state) {
              // 组装错误消息
              const message = error || (access ? "Invalid OAuth state" : "Missing access token")
              // 以失败结果完成 Deferred
              Effect.runFork(Deferred.fail(token, new Error(message)))
              // 返回 400 与错误 JSON
              response.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: message }))
              return
            }
            // 解析过期秒数（默认 0）
            const expires = Number.parseInt(body.expires_in ?? "0", 10)
            // 以成功结果完成 Deferred；过期值无效时回退为 30 天
            Effect.runFork(
              Deferred.succeed(token, {
                access,
                expiresIn: Number.isFinite(expires) && expires > 0 ? expires : 60 * 60 * 24 * 30,
              }),
            )
            // 返回成功响应
            response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }))
          })
          return
        }
        // 其余路径返回 404
        response.writeHead(404).end("Not found")
      })
      // 监听本地端口
      const port = yield* listen(server)
      // 注册 finalizer：作用域结束时关闭服务器
      yield* Effect.addFinalizer(() => Effect.sync(() => server.close()))
      // 构造重定向 URI
      const redirect = `http://localhost:${port}${callbackPath}`
      // 返回授权描述
      return {
        // 模式：自动打开浏览器
        mode: "auto" as const,
        // 授权 URL（隐式令牌流）
        url: `${authorizeEndpoint}?${new URLSearchParams({
          response_type: "token",
          client_id: clientID,
          redirect_uri: redirect,
          scope: "genai:read inference:query",
          state,
        })}`,
        // 用户提示
        instructions: "Complete authorization in your browser. This window will close automatically.",
        // 回调：等待令牌并构造 OAuth 凭据
        callback: Effect.gen(function* () {
          // 等待令牌结果
          const payload = yield* Deferred.await(token)
          // 构造 OAuth 凭据（本流程无刷新令牌）
          return Credential.OAuth.make({
            type: "oauth",
            methodID,
            access: payload.access,
            refresh: "",
            // 过期时间 = 当前时间 + 有效秒数
            expires: (yield* Clock.currentTimeMillis) + payload.expiresIn * 1000,
          })
        }),
      }
    }),
} satisfies IntegrationOAuthMethodRegistration

// 定义 DigitalOcean 插件：浏览器 OAuth 登录 + 发现推理路由并注册为模型
export const DigitalOceanPlugin = define({
  // 插件唯一标识
  id: "opencode.provider.digitalocean",
  // 插件主逻辑（Effect 生成器）
  effect: Effect.fn(function* (ctx) {
    // 获取共享缓存服务
    const cache = yield* SharedCache.Service
    // 创建“状态码正常”过滤后的 HTTP 客户端
    const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
    // 启动凭据驱动的刷新流程：按连接加载路由列表
    const discovered = yield* ProviderRefresh.start({
      // 所属集成
      integrationID,
      // 初始值：空路由列表
      initial: { routers: [] } as { readonly key?: string; readonly routers: Routers },
      // 激活连接的 Effect
      active: ctx.integration.connection.active(integrationID),
      // 供应商重载 Effect
      reload: ctx.provider.reload(),
      // 加载函数：给定当前值与刷新选项
      load: Effect.fn("DigitalOceanPlugin.load")(function* (current, options) {
        // 解析激活连接与凭据
        const { connection, credential } = yield* activeCredential(ctx, integrationID)
        // 连接不存在、凭据非本方法的 OAuth：返回空路由
        if (!connection || credential?.type !== "oauth" || credential.methodID !== methodID)
          return { connection, value: { routers: [] } }
        // 缓存键：按连接特征构造
        const key = `digitalocean:${IntegrationConnection.key(connection)}`
        // 过期令牌无法刷新，因此沿用该连接已加载的路由
        // An expired token cannot be refreshed, so it keeps the routers already loaded for the connection.
        if (credential.expires !== 0 && credential.expires <= (yield* Clock.currentTimeMillis))
          return { connection, value: current.key === key ? current : { key, routers: [] } }
        // 通过共享缓存加载路由列表（带并发去重）
        const routers = yield* cache
          .get({
            // 缓存键
            key,
            // 刷新选项透传
            ...options,
            // 实际加载逻辑
            load: Effect.gen(function* () {
              // 重新解析连接以获取最新令牌
              const latest = yield* ctx.integration.connection.resolve(connection)
              // 凭据不是本方法的 OAuth 则失败
              if (latest?.type !== "oauth" || latest.methodID !== methodID)
                return yield* Effect.fail(new Error("DigitalOcean connection has no OAuth credential"))
              // 请求路由列表端点（Bearer 令牌、接受 JSON、带 User-Agent），10 秒超时
              const response = yield* http
                .execute(
                  HttpClientRequest.get(routersEndpoint).pipe(
                    HttpClientRequest.bearerToken(latest.access),
                    HttpClientRequest.acceptJson,
                    HttpClientRequest.setHeader("User-Agent", App.useragent(ctx.app)),
                  ),
                )
                .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(RoutersResponse)), Effect.timeout("10 seconds"))
              // 按名称排序返回路由
              return response.model_routers.toSorted((a, b) => a.name.localeCompare(b.name))
            }),
          })
          // 加载失败时回退为空列表
          .pipe(Effect.orElseSucceed((): Routers => []))
        // 返回连接与路由
        return { connection, value: { key, routers } }
      }),
    })

    // 注册集成转换：声明 OAuth 登录方法
    yield* ctx.integration.transform((draft) => {
      draft.method.update(oauth)
    })
    // 注册供应商转换：把发现的路由注册为模型
    yield* ctx.provider.transform((evt) => {
      // 未启用该供应商则跳过
      if (!evt.get(providerID)) return
      // 遍历已发现的路由
      for (const router of discovered.current.routers) {
        // 模型 ID：router:<名称>
        const id = `router:${router.name}`
        // 已注册过则跳过
        if (evt.get(providerID)?.models.has(Model.ID.make(id))) continue
        // 注册新模型
        evt.models.update(providerID, id, (draft) => {
          // 名称即路由名
          draft.name = router.name
          // 模型家族
          draft.family = Model.Family.make("digitalocean-inference-routers")
          // 能力：支持工具，仅文本输入输出
          draft.capabilities = { tools: true, input: ["text"], output: ["text"] }
          // 上下文/输出限制
          draft.limit = { context: 128_000, output: 8_192 }
        })
      }
    })
  }),
} satisfies PluginInternal.InternalPlugin)

// 把服务器绑定到回调端口（回调式 Effect）
function listen(server: Server) {
  return Effect.callback<number, Error>((resume) => {
    // 错误处理：以失败恢复
    const onError = (error: Error) => resume(Effect.fail(error))
    // 监听一次性错误事件
    server.once("error", onError)
    // 绑定 localhost 的回调端口
    server.listen(callbackPort, "localhost", () => {
      // 成功后移除错误监听
      server.off("error", onError)
      // 以端口成功恢复
      resume(Effect.succeed(callbackPort))
    })
  }).pipe(
    // 端口被占用时转换为更友好的错误信息
    Effect.mapError((cause) =>
      "code" in cause && cause.code === "EADDRINUSE"
        ? new Error(
            `DigitalOcean login needs local port ${callbackPort}, but it is already in use. Stop the process using that port and try again.`,
          )
        : cause,
    ),
  )
}
