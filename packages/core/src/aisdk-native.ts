// 将本模块以命名空间 AISDKNative 的形式整体导出，外部通过 `AISDKNative.xxx` 访问
export * as AISDKNative from "./aisdk-native.js"

// 导入 Effect 库原语：Effect、Option（可选值）、Schema（校验/编解码）、Struct（对象键剔除等工具）
import { Effect, Option, Schema, Struct } from "effect"
import { isRecord } from "@opencode/util/record"
import type { Provider } from "./provider.js"

export const AISDK_PREFIX = "aisdk:"
export const isAISDK = (value: string | undefined): value is string => value?.startsWith(AISDK_PREFIX) ?? false
export const aisdk = (value: string) => (isAISDK(value) ? value : `${AISDK_PREFIX}${value}`)
export function packageName(value: string): string
export function packageName(value: undefined): undefined
export function packageName(value: string | undefined): string | undefined
export function packageName(value: string | undefined) {
  // Native provider entrypoints can persist in user configuration across the npm scope migration.
  if (value?.startsWith("@opencode-ai/ai/")) return value.replace("@opencode-ai/", "@opencode/")
  if (value === undefined || !isAISDK(value)) return value
  return value.slice(AISDK_PREFIX.length)
}

type Json = Schema.Schema.Type<typeof Schema.Json>
const JsonRecord = Schema.Record(Schema.String, Schema.Json)
const decodeJsonRecord = Schema.decodeUnknownSync(JsonRecord)

export function mergeOverlay(
  base: Readonly<Record<string, unknown>> | undefined,
  overlay: Readonly<Record<string, unknown>> | undefined,
): Record<string, Json> | undefined {
  if (base === undefined) return overlay && decodeJsonRecord({ ...overlay })
  if (overlay === undefined) return decodeJsonRecord({ ...base })
  return decodeJsonRecord(mergeRecord(base, overlay))
}

function mergeRecord(
  base: Readonly<Record<string, unknown>>,
  overlay: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(
    new Set([...Object.keys(base), ...Object.keys(overlay)]).values().map((key): [string, unknown] => {
      const left = base[key]
      const right = overlay[key]
      if (right === undefined) return [key, left]
      if (isRecord(left) && isRecord(right)) return [key, mergeRecord(left, right)]
      return [key, right]
    }),
  )
}

export function mergeHeaders(
  base: Readonly<Record<string, string>> | undefined,
  overlay: Readonly<Record<string, string>> | undefined,
) {
  if (base === undefined) return overlay && { ...overlay }
  if (overlay === undefined) return { ...base }
  return Object.fromEntries(
    [...Object.entries(base), ...Object.entries(overlay)]
      .reduce((result, entry) => {
        result.set(entry[0].toLowerCase(), entry)
        return result
      }, new Map<string, [string, string]>())
      .values(),
  )
}

// 叠加配置（Overlays）：可在目标上覆盖的三类信息——SDK 设置、请求头、请求体
type Overlays = {
  settings?: Provider.Settings
  headers?: Record<string, string>
  body?: Record<string, unknown>
}

// 重写目标（Target）：在叠加配置之上，还可能带 npm 包名与多个变体（variant）配置
type Target<ID extends string> = Overlays & {
  package?: string
  variants?: (Overlays & { id: ID })[]
}

// 上下文（Context）：重写时的判断依据——提供者（provider）ID、规范名、模型 ID、协议形态
type Context = {
  readonly providerID: string
  readonly canonical?: string
  readonly modelID?: string
  readonly shape?: "responses" | "completions"
}

// 重写入口：把用户配置里指向官方 AI SDK 包的 specifier 改写为 OpenCode 内置的原生（native）包，并翻译其设置
export function rewrite<ID extends string>(
  target: Target<ID>,
  input: Context & { readonly specifier: string | undefined; readonly builtins: ReadonlySet<string> },
) {
  // 没有 specifier 就无事可做
  if (input.specifier === undefined) return
  // 先用宽松 schema 解码目标上的既有设置（容错旧配置中的异常字段）
  const settings = decode(target.settings ?? {})
  // 解析出替换后的包名（内置包或按协议派生的包）
  const replacement = resolve(input.specifier, { ...input, settings })
  // 解析不出对应原生包则保持原样
  if (!replacement) return
  // 根据替换包与模型 ID 计算“选项叠加”（设置/请求头/请求体）
  const translated = options(replacement, input.modelID, settings)
  // 目标原本带 package 字段，或解析结果与原 specifier 不同时，写回 target.package
  if (target.package !== undefined || replacement !== input.specifier) target.package = replacement
  // Without `provider`, the native compatible package reports every AI SDK-mapped host as `openai-compatible`.
  // （若不带 `provider` 标识，原生 openai-compatible 包会把所有 AI SDK 映射主机都上报为 `openai-compatible`）
  const identity =
    replacement === "@opencode/ai/providers/openai-compatible" && !input.builtins.has(input.specifier)
      ? { provider: input.canonical ?? input.providerID }
      : {}
  // 最终设置：目标原本无 settings 时保持 undefined，否则用翻译后的设置并附加 identity 标识
  target.settings = target.settings === undefined ? undefined : { ...translated.settings, ...identity }
  target.headers = mergeHeaders(translated.headers, target.headers)
  target.body = mergeOverlay(translated.body, target.body)
  target.variants = target.variants?.map((variant) => {
    // 用变体自身的设置解码后计算选项叠加
    const overlay = options(replacement, input.modelID, decode(variant.settings ?? {}))
    const headers = mergeHeaders(overlay.headers, variant.headers)
    const body = mergeOverlay(overlay.body, variant.body)
    return {
      id: variant.id,
      ...(variant.settings === undefined ? {} : { settings: overlay.settings }),
      ...(headers === undefined ? {} : { headers }),
      ...(body === undefined ? {} : { body }),
    }
  })
}

// 官方 AI SDK 包名 → OpenCode 内置原生包 的固定映射表（键为 npm 包名，值为本仓库内置的等价实现）
const PACKAGES: Readonly<Record<string, string>> = {
  "@ai-sdk/amazon-bedrock": "@opencode/ai/providers/amazon-bedrock",
  "@ai-sdk/alibaba": "@opencode/ai/providers/alibaba/chat",
  "@ai-sdk/anthropic": "@opencode/ai/providers/anthropic",
  "@ai-sdk/azure": "@opencode/ai/providers/azure/responses",
  "@ai-sdk/cerebras": "@opencode/ai/providers/cerebras",
  "@ai-sdk/cohere": "@opencode/ai/providers/cohere",
  "@ai-sdk/deepinfra": "@opencode/ai/providers/deepinfra",
  "@ai-sdk/google": "@opencode/ai/providers/google",
  "@ai-sdk/google-vertex": "@opencode/ai/providers/google-vertex",
  // Google Vertex 上的 Anthropic 模型走 messages 协议包
  "@ai-sdk/google-vertex/anthropic": "@opencode/ai/providers/google-vertex/messages",
  "@ai-sdk/groq": "@opencode/ai/providers/groq",
  "@ai-sdk/mistral": "@opencode/ai/providers/mistral",
  "@ai-sdk/openai": "@opencode/ai/providers/openai",
  "@ai-sdk/openai-compatible": "@opencode/ai/providers/openai-compatible",
  "@ai-sdk/togetherai": "@opencode/ai/providers/togetherai",
  "@ai-sdk/xai": "@opencode/ai/providers/xai",
  // 第三方网关/提供者包同样映射到内置实现
  "@ai-sdk/gateway": "@opencode/ai/providers/vercel-ai-gateway",
  "@openrouter/ai-sdk-provider": "@opencode/ai/providers/openrouter",
  "ai-gateway-provider": "@opencode/ai/providers/cloudflare-ai-gateway",
  "venice-ai-sdk-provider": "@opencode/ai/providers/venice",
}

// 按协议派生内置包路径：对给定主机名 name，生成 chat/messages/responses 三种协议对应的包名
const protocols = (name: string) => ({
  "@ai-sdk/openai-compatible": `@opencode/ai/providers/${name}/chat`,
  "@ai-sdk/anthropic": `@opencode/ai/providers/${name}/messages`,
  "@ai-sdk/openai": `@opencode/ai/providers/${name}/responses`,
})

// 主机（host）专属重定向表：某些提供者主机需要按其支持的协议改用专属内置包
const HOSTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  // 阿里系各主机变体：统一复用 alibaba 的三协议包
  alibaba: protocols("alibaba"),
  "alibaba-cn": protocols("alibaba"),
  "alibaba-coding-plan": protocols("alibaba"),
  "alibaba-coding-plan-cn": protocols("alibaba"),
  "alibaba-token-plan": protocols("alibaba"),
  "alibaba-token-plan-cn": protocols("alibaba"),
  // Baseten 只支持 openai-compatible 协议
  baseten: { "@ai-sdk/openai-compatible": "@opencode/ai/providers/baseten" },
  // Cloudflare AI 网关：无论官方包为何种协议，一律改写为其网关包
  "cloudflare-ai-gateway": {
    "@ai-sdk/anthropic": "@opencode/ai/providers/cloudflare-ai-gateway",
    "@ai-sdk/openai": "@opencode/ai/providers/cloudflare-ai-gateway",
    "@ai-sdk/openai-compatible": "@opencode/ai/providers/cloudflare-ai-gateway",
    "ai-gateway-provider": "@opencode/ai/providers/cloudflare-ai-gateway",
  },
  // 以下为只支持单一协议的主机：Cohere 与 Zhipu（zai）走 chat，其余走 openai-compatible
  cohere: { "@ai-sdk/openai-compatible": "@opencode/ai/providers/cohere/chat" },
  "cloudflare-workers-ai": { "@ai-sdk/openai-compatible": "@opencode/ai/providers/cloudflare-workers-ai" },
  deepseek: { "@ai-sdk/openai-compatible": "@opencode/ai/providers/deepseek" },
  digitalocean: { "@ai-sdk/openai-compatible": "@opencode/ai/providers/digitalocean" },
  "fireworks-ai": { "@ai-sdk/openai-compatible": "@opencode/ai/providers/fireworks" },
  // Google Vertex：openai-compatible 走 chat 子包，Mistral 走专属子包
  "google-vertex": {
    "@ai-sdk/openai-compatible": "@opencode/ai/providers/google-vertex/chat",
    "@ai-sdk/mistral": "@opencode/ai/providers/google-vertex/mistral",
  },
  // Kimi for Coding / Meta / MiniMax / Moonshot 系列主机：复用各自厂商名的三协议包
  "kimi-for-coding": protocols("moonshot"),
  meta: protocols("meta"),
  minimax: protocols("minimax"),
  "minimax-cn": protocols("minimax"),
  "minimax-coding-plan": protocols("minimax"),
  "minimax-cn-coding-plan": protocols("minimax"),
  moonshotai: protocols("moonshot"),
  "moonshotai-cn": protocols("moonshot"),
  // Zai / Zhipu 系主机：openai-compatible 走 zai 的 chat 子包，coding-plan 主机走其专属三协议包
  zai: { "@ai-sdk/openai-compatible": "@opencode/ai/providers/zai/chat" },
  "zai-coding-plan": protocols("zai-coding-plan"),
  zhipuai: { "@ai-sdk/openai-compatible": "@opencode/ai/providers/zai/chat" },
  "zhipuai-coding-plan": protocols("zai-coding-plan"),
}

// 把 npm 包名解析为原生包名：优先查主机专属表，再处理 Bedrock Mantle 与 Azure 特例，最后查通用映射表
export function native(npm: string, context: Context & { readonly settings?: Provider.Settings }): string | undefined {
  // 先查当前提供者主机的专属映射
  const host = HOSTS[context.providerID]?.[npm]
  if (host) return host
  // Bedrock Mantle 入口需要按模型家族拆分为 messages/chat/responses
  if (npm === "@ai-sdk/amazon-bedrock/mantle") return mantle(context.modelID)
  // Azure 在 completions 形态下改用 chat 包
  if (npm === "@ai-sdk/azure" && azureChat(context)) return "@opencode/ai/providers/azure/chat"
  // 其余走固定映射表（未命中返回 undefined）
  return PACKAGES[npm]
}

// 判断 Azure 是否应使用 chat（completions）协议：显式 shape 或设置 useCompletionUrls 为 true
const azureChat = (context: Context & { readonly settings?: Provider.Settings }) =>
  context.shape === "completions" || context.settings?.useCompletionUrls === true

// Mantle serves Claude only through Anthropic Messages and GPT-OSS only through Chat.
// （Bedrock Mantle 网关：Claude 只走 Anthropic Messages，GPT-OSS 只走 Chat）
const mantle = (modelID: string | undefined) => {
  // 未指定模型时返回通用 Mantle 包
  if (modelID === undefined) return "@opencode/ai/providers/amazon-bedrock/mantle"
  // Anthropic 家族模型走 messages 子包
  if (modelID.includes("anthropic.")) return "@opencode/ai/providers/amazon-bedrock/mantle/messages"
  // 其余模型：GPT-OSS 走 chat 子包，其他走 responses 子包
  return `@opencode/ai/providers/amazon-bedrock/mantle/${modelID.includes("gpt-oss") ? "chat" : "responses"}`
}

// Old hyphenated Vertex entrypoints that stale configs may still name.
// （旧版连字符命名的 Vertex 入口，过时的配置可能仍在引用）
const LEGACY_VERTEX: Readonly<Record<string, string>> = {
  "@opencode/ai/providers/google-vertex-chat": "@opencode/ai/providers/google-vertex/chat",
  "@opencode/ai/providers/google-vertex-responses": "@opencode/ai/providers/google-vertex/responses",
  "@opencode/ai/providers/google-vertex-interactions": "@opencode/ai/providers/google-vertex/interactions",
  "@opencode/ai/providers/google-vertex-mistral": "@opencode/ai/providers/google-vertex/mistral",
}

function resolve(
  specifier: string,
  context: Context & { readonly settings?: Provider.Settings; readonly builtins: ReadonlySet<string> },
): string | undefined {
  const npm = packageName(specifier)
  if (isAISDK(specifier) || npm in PACKAGES || npm in (HOSTS[context.providerID] ?? {})) return native(npm, context)
  if (npm === "@opencode/ai/providers/amazon-bedrock/mantle" || npm === "@opencode/ai/providers/amazon-bedrock-mantle")
    return mantle(context.modelID)
  // 旧版 Vertex 连字符包名：映射到新的斜杠路径
  if (npm in LEGACY_VERTEX) return LEGACY_VERTEX[npm]
  // Azure：completions 形态时把默认包改写为 chat 包
  if (
    (npm === "@opencode/ai/providers/azure" || npm === "@opencode/ai/providers/azure/responses") &&
    azureChat(context)
  )
    return "@opencode/ai/providers/azure/chat"
  return context.builtins.has(npm) ? npm : undefined
}

// 选项叠加（Overlay）：翻译后的最终产物——设置 + 可选请求头 + 可选请求体
type Overlay = {
  readonly settings: Provider.Settings
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: Readonly<Record<string, unknown>>
}

// 根据替换后的包名与模型 ID，把旧版（AI SDK 风格）设置翻译为“设置 + 请求头 + 请求体”的叠加配置
function options(replacement: string, modelID: string | undefined, settings: Legacy): Overlay {
  // Bedrock 的 Converse API 有单独的参数翻译路径（需要模型 ID 参与）
  const converse = replacement === "@opencode/ai/providers/amazon-bedrock" && modelID !== undefined
  // 剔除将由其他键转译的旧键：headers、extraBody、useCompletionUrls 及 OpenRouter 专属键
  const kept = Struct.omit(settings, ["headers", "extraBody", "useCompletionUrls", ...OPENROUTER_KEYS])
  // Claude 模型且开启 reasoning 时，产出类型化的 thinking 设置
  const thinking = converse ? bedrockThinking(modelID, settings) : undefined
  return {
    // 基础设置：Bedrock 家族走 bedrockSettings 归一化，其余保留 kept；有 thinking 时附加
    settings: {
      ...(replacement.startsWith("@opencode/ai/providers/amazon-bedrock") ? bedrockSettings(kept, converse) : kept),
      ...(thinking === undefined ? {} : { thinking }),
    },
    // 透传用户自定义请求头
    ...(settings.headers === undefined ? {} : { headers: settings.headers }),
    // extraBody 转为通用请求体叠加
    ...(settings.extraBody === undefined ? {} : { body: settings.extraBody }),
    // Bedrock Converse 的请求体字段翻译
    ...(converse ? bedrockRequest(modelID, settings) : {}),
    // OpenRouter 的请求头字段翻译
    ...(replacement === "@opencode/ai/providers/openrouter" ? openRouterRequest(settings) : {}),
  }
}

// AI SDK spellings the native Bedrock packages do not read.
// （原生 Bedrock 包不认识的 AI SDK 风格键名，需在归一化时剔除）
const BEDROCK_KEYS = [
  "bearerToken",
  "endpoint",
  "credentials",
  "credentialProvider",
  "accessKeyId",
  "secretAccessKey",
  "sessionToken",
]
// Request settings Converse takes in the body; translated by `bedrockRequest`.
// （这些请求设置要放进 Converse 请求体，由 `bedrockRequest` 负责转译）
const CONVERSE_KEYS = ["additionalModelRequestFields", "reasoningConfig", "anthropicBeta", "serviceTier"]

// 把 AI SDK 风格的 Bedrock 凭据/区域/地址设置归一化为原生包可读的结构
function bedrockSettings(settings: Legacy, converse: boolean) {
  // 区域：优先显式 region，其次凭据对象里的 region
  const region = settings.region ?? settings.credentials?.region
  // 凭据：既可能在 credentials 子对象，也可能平铺在顶层
  const credentials = settings.credentials ?? settings
  // 基础地址：baseURL 或旧的 endpoint 键
  const baseURL = settings.baseURL ?? settings.endpoint
  return {
    // 剔除待转译键：Converse 模式额外剔除请求体键（它们会进入 body）
    ...Struct.omit(settings, converse ? [...BEDROCK_KEYS, ...CONVERSE_KEYS] : BEDROCK_KEYS),
    // 透传 baseURL，并把其中的 ${AWS_REGION} 占位符替换为实际区域
    ...(baseURL === undefined
      ? {}
      : { baseURL: region === undefined ? baseURL : baseURL.replaceAll("${AWS_REGION}", region) }),
    // 旧的 bearerToken 键映射为原生包读取的 apiKey
    ...(settings.apiKey === undefined && settings.bearerToken !== undefined ? { apiKey: settings.bearerToken } : {}),
    // 把平铺的 accessKeyId/secretAccessKey/sessionToken 组装回 credentials 对象（带区域与会话令牌）
    ...(credentials.accessKeyId === undefined || credentials.secretAccessKey === undefined
      ? {}
      : {
          credentials: {
            ...(region === undefined ? {} : { region }),
            accessKeyId: credentials.accessKeyId,
            secretAccessKey: credentials.secretAccessKey,
            ...(credentials.sessionToken === undefined ? {} : { sessionToken: credentials.sessionToken }),
          },
        }),
  }
}

// Claude's enabled budget is a typed setting so the protocol can fit it under the output limit.
// （Claude 的思考预算需作为类型化设置传递，协议才能将其纳入输出上限之内）
// 从 reasoningConfig 提取 Claude 的 thinking 预算：仅在 anthropic 模型、显式 enabled 且给了 budgetTokens 时
function bedrockThinking(modelID: string | undefined, settings: Legacy) {
  const reasoning = settings.reasoningConfig
  // 不满足条件（非 anthropic / 非 enabled / 缺 budgetTokens）时不产出设置
  if (!modelID?.includes("anthropic") || reasoning?.type !== "enabled" || reasoning.budgetTokens === undefined) return
  return { type: "enabled", budgetTokens: reasoning.budgetTokens }
}

// 生成 Bedrock 请求体（additionalModelRequestFields 等）：按模型家族把 reasoning 设置转译成对应字段
function bedrockRequest(modelID: string | undefined, settings: Legacy): Pick<Overlay, "body"> {
  // 用户提供的附加模型请求字段（转译的基础）
  const additional = settings.additionalModelRequestFields ?? {}
  // 推理（reasoning）相关设置
  const reasoning = settings.reasoningConfig
  // 是否 Anthropic 家族模型
  const anthropic = modelID?.includes("anthropic") ?? false
  // 是否 OpenAI 家族（Bedrock 上的 openai.* 模型）
  const openai = modelID?.includes("openai.") ?? false
  // gpt-oss (Harmony) takes the flat chat-completions `reasoning_effort`; GPT-5.6+ take Responses-style `reasoning.effort`.
  // （gpt-oss（Harmony）用扁平的 chat-completions `reasoning_effort`；GPT-5.6+ 用 Responses 风格的 `reasoning.effort`）
  const harmony = modelID?.includes("openai.gpt-oss") ?? false
  // 推理设置中的最大推理力度（effort）
  const effort = reasoning?.maxReasoningEffort
  // 推理类型（如 enabled/adaptive）
  const type = reasoning?.type
  // 思考 token 预算
  const budget = reasoning?.budgetTokens
  // 思考展示方式
  const display = reasoning?.display
  // 已配置的 anthropicBeta 头列表
  const betas = settings.anthropicBeta ?? []
  const fields = mergeOverlay(additional, {
    ...(betas.length > 0 ? { anthropic_beta: [...(additional.anthropic_beta ?? []), ...betas] } : {}),
    // Anthropic 自适应思考模式：thinking.type=adaptive，可选 display
    ...(anthropic && type === "adaptive"
      ? { thinking: { type: "adaptive", ...(display === undefined ? {} : { display }) } }
      : {}),
    // Anthropic 模型：effort 进入 output_config
    ...(anthropic && effort !== undefined ? { output_config: { ...additional.output_config, effort } } : {}),
    // Harmony（gpt-oss）：扁平的 reasoning_effort
    ...(!anthropic && openai && harmony && effort !== undefined ? { reasoning_effort: effort } : {}),
    // 非 Harmony 的 OpenAI 模型：Responses 风格 reasoning.effort
    ...(!anthropic && openai && !harmony && effort !== undefined
      ? { reasoning: { ...additional.reasoning, effort } }
      : {}),
    // 其他家族模型：使用通用 reasoningConfig 结构
    ...(!anthropic && !openai && effort !== undefined
      ? {
          reasoningConfig: {
            ...(type === undefined || type === "adaptive" ? {} : { type }),
            ...(budget === undefined ? {} : { budgetTokens: budget }),
            maxReasoningEffort: effort,
          },
        }
      : {}),
  })
  const body = {
    // 仅在确实有附加字段时输出 additionalModelRequestFields
    ...(fields && Object.keys(fields).length > 0 ? { additionalModelRequestFields: fields } : {}),
    // 服务层级（serviceTier）转成带 type 的对象
    ...(settings.serviceTier === undefined ? {} : { serviceTier: { type: settings.serviceTier } }),
  }
  // 没有任何内容时返回空对象（表示不叠加 body）
  return Object.keys(body).length === 0 ? {} : { body }
}

// Constructor options the native OpenRouter package takes as headers, plus `compatibility`, which the
// native package would otherwise forward to the request body.
// （原生 OpenRouter 包把这些构造选项作为请求头读取；其中 compatibility 若不剔除会被转发进请求体）
const OPENROUTER_KEYS = ["appName", "appUrl", "api_keys", "compatibility"] as const

// 把 OpenRouter 的构造期选项（应用名/网址/密钥列表）转成请求头叠加
function openRouterRequest(settings: Legacy): Pick<Overlay, "headers"> {
  // 合成应用相关头（标题/Referer/API 密钥列表）并叠加用户自定义头
  const headers =
    mergeHeaders(
      {
        ...(settings.appName === undefined ? {} : { "X-OpenRouter-Title": settings.appName }),
        ...(settings.appUrl === undefined ? {} : { "HTTP-Referer": settings.appUrl }),
        ...(settings.api_keys === undefined || Object.keys(settings.api_keys).length === 0
          ? {}
          : { "X-Provider-API-Keys": JSON.stringify(settings.api_keys) }),
      },
      settings.headers,
    ) ?? {}
  // 没有任何头时返回空对象（表示不叠加 headers）
  return Object.keys(headers).length === 0 ? {} : { headers }
}

// 宽松（lenient）schema 包装：字段可选、可为 undefined，且解码失败时不报错而是回退为 undefined
const lenient = <S extends Schema.Top>(schema: S) =>
  Schema.optional(Schema.UndefinedOr(schema).pipe(Schema.catchDecoding(() => Effect.succeed(Option.some(undefined)))))

// Bedrock 凭据结构：必填的 key id 与 secret，可选的会话令牌与区域（宽松解码）
const Credentials = Schema.Struct({
  accessKeyId: Schema.String,
  secretAccessKey: Schema.String,
  sessionToken: lenient(Schema.String),
  region: lenient(Schema.String),
})

// 旧版（AI SDK 风格）设置的完整宽松 schema：已知键宽松解码，未知键一律放行为字符串键对象
const Legacy = Schema.StructWithRest(
  Schema.Struct({
    apiKey: lenient(Schema.String),
    baseURL: lenient(Schema.String),
    headers: lenient(Schema.Record(Schema.String, Schema.String)),
    extraBody: lenient(Schema.Record(Schema.String, Schema.Unknown)),
    useCompletionUrls: lenient(Schema.Boolean),
    auth: lenient(Schema.Literals(["bearer", "sigv4"])),
    bearerToken: lenient(Schema.String),
    endpoint: lenient(Schema.String),
    region: lenient(Schema.String),
    credentials: lenient(Credentials),
    accessKeyId: lenient(Schema.String),
    secretAccessKey: lenient(Schema.String),
    sessionToken: lenient(Schema.String),
    anthropicBeta: lenient(Schema.Array(Schema.String)),
    serviceTier: lenient(Schema.String),
    // 推理配置：类型/展示/力度/预算，全部宽松
    reasoningConfig: lenient(
      Schema.Struct({
        type: lenient(Schema.String),
        display: lenient(Schema.String),
        maxReasoningEffort: lenient(Schema.String),
        budgetTokens: lenient(Schema.Number),
      }),
    ),
    // 附加模型请求字段：已知子键 + 任意未知键（宽松）
    additionalModelRequestFields: lenient(
      Schema.StructWithRest(
        Schema.Struct({
          anthropic_beta: lenient(Schema.Array(Schema.String)),
          output_config: lenient(Schema.Record(Schema.String, Schema.Unknown)),
          reasoning: lenient(Schema.Record(Schema.String, Schema.Unknown)),
        }),
        [Schema.Record(Schema.String, Schema.Unknown)],
      ),
    ),
    // OpenRouter 专属键：应用名/网址/API 密钥映射
    appName: lenient(Schema.String),
    appUrl: lenient(Schema.String),
    api_keys: lenient(Schema.Record(Schema.String, Schema.String)),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)
// 导出 Legacy 的静态类型
type Legacy = typeof Legacy.Type
// 同步解码器：未知输入 → Legacy（异常字段回退 undefined，不抛错）
const decode = Schema.decodeUnknownSync(Legacy)
