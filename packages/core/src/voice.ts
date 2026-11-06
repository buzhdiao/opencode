// 以命名空间形式导出 Voice 模块
export * as Voice from "./voice.js"

// 引入 AI 错误类型
import { type AIError } from "@opencode/ai/effect"
// 引入实时（Realtime）语音能力及会话/传输相关类型
import {
  Realtime,
  type RealtimeSession,
  type RealtimeTransport,
  type RealtimeTransportInput,
  type RealtimeTransportType,
} from "@opencode/ai/experimental"
// 引入请求执行器服务
import { RequestExecutor } from "@opencode/ai/route"
// 引入位置级节点构造工具
import { makeLocationNode } from "@opencode/util/effect/app-node"
// 引入 Effect 原语（含 Redacted 脱敏值）
import { Context, Effect, Layer, Redacted, Schema } from "effect"
// 引入凭证模块
import { Credential } from "./credential.js"
// 引入本包的请求执行器节点
import { requestExecutor } from "./effect/app-node-platform.js"
// 引入集成服务
import { Integration } from "./integration.js"

// 语音模型信息
export interface ModelInfo {
  readonly model: string
  readonly provider: string
  // 支持的传输方式列表
  readonly transports: readonly RealtimeTransportType[]
  // 服务器是否具备启动该模型的凭证
  readonly available: boolean
}

// 模型列表及默认模型
export interface Models {
  readonly models: readonly ModelInfo[]
  readonly default?: string
}

// 会话创建入参：模型、可选已有会话、传输配置
export interface SessionInput {
  readonly model: string
  readonly session?: RealtimeSession
  readonly transport: RealtimeTransportInput
}

// 请求非法错误
export class InvalidRequestError extends Schema.TaggedError<InvalidRequestError>()("Voice.InvalidRequestError", {
  message: Schema.String,
}) {}

// 服务不可用错误（可带服务名）
export class UnavailableError extends Schema.TaggedError<UnavailableError>()("Voice.UnavailableError", {
  message: Schema.String,
  service: Schema.optional(Schema.String),
}) {}

// 错误联合类型
export type Error = InvalidRequestError | UnavailableError

// 服务接口：列出模型与创建会话
export interface Interface {
  readonly models: () => Effect.Effect<Models>
  readonly session: (input: SessionInput) => Effect.Effect<RealtimeTransport, Error>
}

// 定义 Voice 服务标记类
export class Service extends Context.Service<Service, Interface>()("@opencode/Voice") {}

// 构建服务层
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 获取请求执行器
    const executor = yield* RequestExecutor.Service
    // 获取集成服务
    const integrations = yield* Integration.Service

    // Integration lists the active credential first, then newer stored credentials, then non-empty env vars.
    // （中文）集成层按序列出凭证：先活动凭证，再较新的存储凭证，最后非空环境变量
    // （中文）为提供方查找可用连接（默认只认 key 方式）
    const findConnection = (provider: string, methods: readonly string[] = ["key"]) =>
      integrations
        .get(Integration.ID.make(provider))
        .pipe(
          Effect.map((info) => info?.connections.find((item) => item.type === "env" || methods.includes(item.method))),
        )

    // Where an engine's sessions start: its provider with the server's key or, for GPT-Live without an OpenAI key,
    // OpenCode's hosted GPT-Live with the server's OpenCode Console connection, whose sign-in works as well as a key.
    // （中文）确定引擎会话的起点：优先其提供方 + 服务器密钥；GPT-Live 若无 OpenAI 密钥，
    // 可退回 OpenCode 托管的 GPT-Live + 控制台连接（登录态等同密钥）
    const source = Effect.fnUntraced(function* (engine: (typeof Realtime.engines)[number]) {
      // 查找引擎提供方的连接
      const connection = yield* findConnection(engine.provider)
      // 找到即用
      if (connection) return { provider: engine.provider, connection }
      // 非 GPT-Live 引擎没有回退
      if (engine.id !== "openai-live") return undefined
      // 回退：查 OpenCode 托管服务的连接（key 或 oauth）
      const hosted = yield* findConnection(openCodeLive.provider, ["key", "oauth"])
      return hosted && { provider: openCodeLive.provider, connection: hosted }
    })

    // （中文）列出语音模型及可用性
    const models = Effect.fn("Voice.models")(function* () {
      // 逐引擎解析凭证来源
      const list = yield* Effect.forEach(Realtime.engines, (engine) =>
        source(engine).pipe(
          Effect.map((found) => ({
            model: engine.model,
            provider: found?.provider ?? engine.provider,
            transports: engine.transports,
            available: found !== undefined,
          })),
        ),
      )
      // 取第一个可用模型作为默认
      const first = list.find((item) => item.available)?.model
      return first ? { models: list, default: first } : { models: list }
    })

    // （中文）创建实时语音会话
    const session = Effect.fn("Voice.session")(function* (input: SessionInput) {
      // 按模型名解析引擎
      const engine = Realtime.engine(input.model)
      // 不支持的模型报错
      if (!engine) return yield* new InvalidRequestError({ message: `Unsupported voice model: ${input.model}` })

      // 查找凭证来源
      const found = yield* source(engine)
      // 解析连接为凭证；失败报不可用
      const credential = found
        ? yield* integrations.connection
            .resolve(found.connection)
            .pipe(Effect.mapError((error) => new UnavailableError({ service: found.provider, message: error.message })))
        : undefined
      // 计算访问参数
      const access = found && credential && sessionAccess(found.provider, credential)
      // 无来源或无访问参数时报不可用（区分 GPT-Live 的提示语）
      if (found === undefined || access === undefined)
        return yield* new UnavailableError({
          service: engine.provider,
          message: engine.id === "openai-live" ? missingLiveKeyMessage : missingKeyMessage[engine.provider],
        })

      // 建立实时连接；注入执行器并把错误映射为内部类型
      return yield* Realtime.connect({
        model: input.model,
        session: input.session,
        transport: input.transport,
        ...access,
      }).pipe(
        Effect.provideService(RequestExecutor.Service, executor),
        Effect.mapError(
          (error: AIError): Error =>
            error.reason._tag === "InvalidRequest" || error.reason._tag === "UnsupportedOperation"
              ? new InvalidRequestError({ message: error.message })
              : new UnavailableError({ message: error.message, service: found.provider }),
        ),
      )
    })

    // 组装服务实例
    return Service.of({ models, session })
  }),
)

// 导出位置级服务节点
export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Integration.node, requestExecutor],
})

/** OpenCode hosts GPT-Live on its OpenAI account, billed to the workspace whose credential starts a session. */
// （中文）OpenCode 在其 OpenAI 账户上托管 GPT-Live，费用计入以凭证发起会话的工作区
const openCodeLive = { provider: "opencode", baseURL: "https://opencode.ai/inference/openai/v1" } as const

/**
 * What a credential starts a session with: a provider's API key on its own API, or an OpenCode Console API key or
 * account sign-in on OpenCode's hosted GPT-Live, for the workspace the sign-in chose.
 */
// （中文）凭证如何发起会话：提供方自有 API 用其密钥；OpenCode 托管 GPT-Live 用控制台 API 密钥
// 或账号登录（按登录选择的工作区）。
const sessionAccess = (provider: string, credential: Credential.Value) => {
  // 非 OpenCode 托管：仅 key 凭证可用
  if (provider !== openCodeLive.provider)
    return credential.type === "key" ? { apiKey: Redacted.make(credential.key) } : undefined
  // 外部凭证不能发起托管会话
  if (credential.type === "external") return undefined
  // 组织 ID（可选）
  const orgID = credential.metadata?.orgID
  // 组装托管访问参数：密钥 + baseURL + 组织头
  return {
    apiKey: Redacted.make(credential.type === "oauth" ? credential.access : credential.key),
    baseURL: openCodeLive.baseURL,
    ...(typeof orgID === "string" ? { headers: { "x-opencode-org-id": orgID } } : {}),
  }
}

// GPT-Live 缺密钥时的提示语
const missingLiveKeyMessage =
  "GPT-Live needs an OpenAI API key (a stored key or OPENAI_API_KEY) or an OpenCode Console connection on the server. ChatGPT sign-in can't start voice sessions."

// 各提供方缺密钥时的提示语
const missingKeyMessage = {
  openai:
    "Voice needs an OpenAI API key on the server (a stored key or OPENAI_API_KEY). ChatGPT sign-in can't start voice sessions.",
  xai: "Voice needs an xAI API key on the server (a stored key or XAI_API_KEY).",
  google:
    "Voice needs a Google API key on the server (a stored key, GEMINI_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, or GOOGLE_API_KEY).",
} as const
