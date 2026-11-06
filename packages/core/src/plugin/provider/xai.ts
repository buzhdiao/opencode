// 导入集成 OAuth 方式注册类型（仅类型）
import type { IntegrationOAuthMethodRegistration } from "@opencode/plugin/effect/integration"
// 导入插件定义辅助函数 define
import { define } from "@opencode/plugin/effect/plugin"
// 从 effect 库导入时钟、Effect、Option、Schema
import { Clock, Effect, Option, Schema } from "effect"
// 导入应用信息工具（User-Agent）
import { App } from "../../app.js"
// 导入凭据模块
import { Credential } from "../../credential.js"
// 导入集成模块
import { Integration } from "../../integration.js"
// 导入 Provider 服务与 ID 工具
import { Provider } from "../../provider.js"

// xAI 官方分配给 OpenCode 的 OAuth 客户端 ID
const clientID = "b1a00492-073a-47ea-816f-4c329264a828"
// OAuth 签发方地址
const issuer = "https://auth.x.ai/oauth2"
// OAuth 设备码授权的 grant type URI
const deviceGrant = "urn:ietf:params:oauth:grant-type:device_code"
// 申请的 OAuth 作用域
const scope = "openid profile email offline_access grok-cli:access api:access"
// 设备码轮询的安全余量（毫秒），避免服务器时钟偏差导致提前请求
const pollingSafetyMargin = 3000
// 旧版浏览器登录方式的 ID（已迁移到设备码方式）
const browserMethodID = Integration.MethodID.make("browser")
// 设备码登录方式的 ID
const deviceMethodID = Integration.MethodID.make("device")
// 提供商 ID
const providerID = Provider.ID.make("xai")

// 令牌接口响应 Schema：访问令牌、可选刷新令牌与过期秒数
const Token = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
})
// 令牌的解码后类型
type Token = typeof Token.Type

// 设备码申请响应 Schema
const Device = Schema.Struct({
  // 设备码
  device_code: Schema.String,
  // 用户手动输入的码
  user_code: Schema.String,
  // 验证页面地址
  verification_uri: Schema.String,
  // 已带码的完整验证地址（可选，可直接打开）
  verification_uri_complete: Schema.optional(Schema.String),
  // 设备码有效期秒数（可选）
  expires_in: Schema.optional(Schema.Number),
  // 建议的轮询间隔秒数（可选）
  interval: Schema.optional(Schema.Number),
})

// 设备码令牌接口错误响应 Schema
const DeviceError = Schema.Struct({
  error: Schema.optional(Schema.String),
  error_description: Schema.optional(Schema.String),
})
// 错误响应的解码器
const decodeDeviceError = Schema.decodeUnknownOption(Schema.fromJsonString(DeviceError))

// device：构造 xAI 的 SuperGrok 设备码 OAuth 登录方式定义
const device = (app: App.Info) =>
  ({
    // 所属集成 ID
    integrationID: Integration.ID.make("xai"),
    // 方式定义：设备码 OAuth
    method: {
      id: deviceMethodID,
      type: "oauth",
      label: "SuperGrok Subscription",
    },
    // 授权流程：申请设备码并轮询令牌
    authorize: () =>
      request(
        `${issuer}/device/code`,
        {
          method: "POST",
          headers: headers(app),
          body: new URLSearchParams({ client_id: clientID, scope, referrer: "opencode" }).toString(),
        },
        Device,
      ).pipe(
        // 拿到设备码后构造授权结果
        Effect.flatMap((value) =>
          Clock.currentTimeMillis.pipe(
            Effect.map((created) => {
              // 设备码有效期秒数（缺失按 0 处理，即不限制）
              const lifetime = positiveSeconds(value.expires_in, 0)
              return {
                // 自动模式：插件自己轮询
                mode: "auto" as const,
                // 优先用带码的完整验证地址
                url: value.verification_uri_complete ?? value.verification_uri,
                // 给用户看的说明文案
                instructions: `Open ${value.verification_uri} on any device and enter code: ${value.user_code}`,
                // 有有效期时附上过期时间戳
                ...(lifetime ? { expiresAt: created + lifetime * 1000 } : {}),
                // 回调：轮询令牌并构造凭据
                callback: poll(value, app).pipe(Effect.flatMap((tokens) => credential(deviceMethodID, tokens))),
              }
            }),
          ),
        ),
      ),
    // 刷新逻辑：用刷新令牌换新令牌
    refresh: (value) => refresh(deviceMethodID, value, app),
  }) satisfies IntegrationOAuthMethodRegistration

// 导出 xAI 提供商插件：迁移旧登录方式、注册登录方式并设置默认传输协议
export const XAIPlugin = define({
  // 插件唯一标识符
  id: "opencode.provider.xai",
  // 插件主流程生成器
  effect: Effect.fn(function* (ctx) {
    // 获取凭据服务实例
    const credentials = yield* Credential.Service
    // 一次性迁移：把旧的 browser 方式凭据改标为 device 方式
    yield* Effect.forEach(
      yield* credentials.list(Integration.ID.make("xai")),
      (credential) => {
        // 只处理旧 browser 方式的 OAuth 凭据
        if (credential.value.type !== "oauth" || credential.value.methodID !== browserMethodID) return Effect.void
        // 改写 methodID 后写回（令牌本身继续有效）
        return credentials.update(credential.id, {
          value: Credential.OAuth.make({ ...credential.value, methodID: deviceMethodID }),
        })
      },
      { discard: true },
    )

    // 注册集成名称与登录方式
    yield* ctx.integration.transform((editor) => {
      // 更新 xAI 集成的展示名
      editor.update("xai", (integration) => {
        integration.name = "xAI"
      })
      // 注册 SuperGrok 设备码登录方式
      editor.method.update(device(ctx.app))
      // 注册手动粘贴 API key 的方式
      editor.method.update({ integrationID: "xai", method: { type: "key", label: "Manually enter API Key" } })
    })
    // 提供商目录变换：默认走 WebSocket 传输（用户可覆盖）
    yield* ctx.provider.transform((providers) => {
      // 提供商不在目录中则跳过
      if (!providers.get(providerID)) return
      // 更新提供商设置
      providers.update(providerID, (provider) => {
        provider.settings = Provider.mergeOverlay(provider.settings, {
          // 未显式配置传输协议时默认 websocket
          transport: provider.settings?.transport ?? "websocket",
        })
      })
    })
  }),
})

// refresh：用刷新令牌向 xAI 换取新令牌
function refresh(methodID: Integration.MethodID, value: Credential.OAuth, app: App.Info) {
  return request(
    `${issuer}/token`,
    {
      method: "POST",
      headers: headers(app),
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: value.refresh,
        client_id: clientID,
      }).toString(),
    },
    Token,
  ).pipe(Effect.flatMap((tokens) => credential(methodID, tokens, value.refresh, value.metadata)))
}

// poll：按间隔轮询设备码令牌接口，直到用户完成授权、拒绝或超时
function poll(device: typeof Device.Type, app: App.Info): Effect.Effect<Token, unknown> {
  return Effect.gen(function* () {
    // 记录开始时间
    const started = yield* Clock.currentTimeMillis
    // 计算设备码过期时间（默认 5 分钟）
    const expires = started + positiveSeconds(device.expires_in, 300) * 1000
    // loop：单次轮询逻辑，interval 为当前间隔（毫秒）
    const loop = (interval: number): Effect.Effect<Token, unknown> =>
      Effect.gen(function* () {
        // 超过设备码有效期则失败
        if ((yield* Clock.currentTimeMillis) >= expires) {
          return yield* Effect.fail(new Error("xAI device authorization timed out"))
        }
        // 发起令牌交换请求
        const response = yield* send(`${issuer}/token`, {
          method: "POST",
          headers: headers(app),
          body: new URLSearchParams({
            grant_type: deviceGrant,
            client_id: clientID,
            device_code: device.device_code,
          }).toString(),
        })
        // 成功则解码令牌
        if (response.ok) return yield* decode(response, Token)
        // 失败时读取响应体并尝试解析错误结构
        const error = yield* Effect.promise(() => response.text()).pipe(
          Effect.map((body) => Option.getOrUndefined(decodeDeviceError(body))),
          Effect.orElseSucceed(() => undefined),
        )
        // 等待用户授权：按当前间隔加安全余量后再轮询
        if (error?.error === "authorization_pending") {
          return yield* Effect.sleep(interval + pollingSafetyMargin).pipe(Effect.andThen(loop(interval)))
        }
        // 服务器要求放慢：间隔加 5 秒后继续
        if (error?.error === "slow_down") {
          const next = interval + 5000
          return yield* Effect.sleep(next + pollingSafetyMargin).pipe(Effect.andThen(loop(next)))
        }
        // 用户拒绝授权
        if (error?.error === "access_denied" || error?.error === "authorization_denied") {
          return yield* Effect.fail(new Error("xAI device authorization was denied"))
        }
        // 设备码已过期，需要重新发起登录
        if (error?.error === "expired_token") {
          return yield* Effect.fail(new Error("xAI device code expired - please re-run login"))
        }
        // 其余错误：给出状态码与可用的细节
        const detail = error?.error_description ?? error?.error
        return yield* Effect.fail(
          new Error(`xAI device token exchange failed (${response.status})${detail ? `: ${detail}` : ""}`),
        )
      })
    // 以服务器建议的间隔（默认 5 秒，至少 1 秒）开始轮询
    return yield* loop(Math.max(positiveSeconds(device.interval, 5) * 1000, 1000))
  })
}

// request：发送请求并在失败时构造带细节的错误
function request<S extends Schema.Decoder<unknown>>(url: string, init: RequestInit, schema: S) {
  return send(url, init).pipe(
    Effect.flatMap((response) => {
      // 成功则按 Schema 解码
      if (response.ok) return decode(response, schema)
      // 失败时读取响应体文本并失败
      return Effect.promise(() => response.text()).pipe(
        Effect.flatMap((detail) =>
          Effect.fail(new Error(`xAI request failed (${response.status})${detail ? `: ${detail}` : ""}`)),
        ),
      )
    }),
  )
}

// send：把 fetch 包装成 Effect（带中断信号）
function send(url: string, init: RequestInit) {
  return Effect.tryPromise({
    // 传入 signal 便于 Effect 中断时中止请求
    try: (signal) => fetch(url, { ...init, signal }),
    // 失败原因原样保留
    catch: (cause) => cause,
  })
}

// decode：解析 JSON 并按 Schema 同步校验
function decode<S extends Schema.Decoder<unknown>>(response: Response, schema: S) {
  return Effect.promise(() => response.json()).pipe(Effect.map(Schema.decodeUnknownSync(schema)))
}

// credential：把令牌响应构造为 OAuth 凭据
function credential(
  methodID: Integration.MethodID,
  tokens: Token,
  currentRefresh?: string,
  metadata?: Readonly<Record<string, unknown>>,
) {
  // 刷新令牌：优先响应里的，回退到当前值
  const refresh = tokens.refresh_token ?? currentRefresh
  // 没有刷新令牌无法维持登录
  if (!refresh) return Effect.fail(new Error("xAI token response is missing refresh_token"))
  // 构造凭据
  return Effect.succeed(
    Credential.OAuth.make({
      type: "oauth",
      methodID,
      refresh,
      access: tokens.access_token,
      expires: tokenExpiration(tokens),
      metadata,
    }),
  )
}

// tokenExpiration：计算令牌过期时间戳
function tokenExpiration(tokens: Token) {
  // 有 expires_in 时按当前时间加秒数
  if (tokens.expires_in) return Date.now() + positiveSeconds(tokens.expires_in, 3600) * 1000
  // 否则尝试从 JWT 的载荷里读 exp 声明
  const payload = tokens.access_token.split(".")[1]
  // 没有 JWT 载荷则按 1 小时兜底
  if (!payload) return Date.now() + 3600 * 1000
  // 解码载荷 JSON 并校验结构
  const claims = Schema.decodeUnknownOption(
    Schema.fromJsonString(Schema.Struct({ exp: Schema.optional(Schema.Number) })),
  )(Buffer.from(payload, "base64url").toString())
  // 读取 exp
  const expiration = Option.getOrUndefined(claims)?.exp
  // 有 exp 用它，否则 1 小时兜底
  return expiration ? expiration * 1000 : Date.now() + 3600 * 1000
}

// headers：构造请求头（表单编码、JSON 接受、User-Agent）
function headers(app: App.Info) {
  return {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
    "User-Agent": App.useragent(app),
  }
}

// positiveSeconds：把未知值解析为正数秒，失败时用兜底值
function positiveSeconds(value: unknown, fallback: number) {
  // 尝试转为数字
  const seconds = Number(value)
  // 有限正数才有效
  return Number.isFinite(seconds) && seconds > 0 ? seconds : fallback
}
