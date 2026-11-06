// 会话模型请求（SessionModelRequest）模块：为会话的各类流程（主对话、压缩、生成、标题）
// 构建发往 LLM 的请求，接入插件钩子（hook）、媒体裁剪与输出上限计算。
export * as SessionModelRequest from "./model-request.js"

// AI 抽象层：请求/消息模型、生成参数键、语言模型与流式选项等
import {
  ai,
  AssistantMessage,
  type ContentPart,
  GENERATION_KEYS,
  type GenerationOptionsFields,
  LanguageModel,
  type LLM,
  type LLMRequest,
  type Media,
  type MediaPart,
  Message,
  SystemPart,
  ToolMessage,
  type ToolResultPart,
  UserMessage,
} from "@opencode/ai/effect"
// 流式选项类型（HTTP 钩子、WebSocket 等）
import type { StreamOptions } from "@opencode/ai/route"
// 会话流程的事件类型（主上下文/压缩/生成/标题等，仅类型）
import type {
  SessionCompaction,
  SessionContext,
  SessionGenerate,
  SessionRequest,
  SessionRequestKind,
  SessionTitle,
} from "@opencode/plugin/effect/session"
// agent 与模型的类型（仅类型）
import type { Agent } from "@opencode/schema/agent"
import type { Model } from "@opencode/schema/model"
// 工具内容类型（仅类型）
import type { Content } from "@opencode/schema/tool"
// Effect 核心：Cause、Context、Effect、Layer、Result、Stream
import { Cause, Context, Effect, Layer, Result, Stream } from "effect"
// HTTP 客户端请求/响应工具（用于钩子桥接 Web 请求）
import { HttpClientRequest, HttpClientResponse } from "effect/http"
// Location 级节点构造工具
import { makeLocationNode } from "@opencode/util/effect/app-node"
// 应用元数据服务（用户代理等）
import { App } from "../app.js"
// 指令系统：拼接初始渲染文本
import { Instructions } from "../instructions/index.js"
// 权限（Permission）服务：DeclinedError 表示用户拒绝授权
import { Permission } from "../permission.js"
// 插件钩子（PluginHooks）服务
import { PluginHooks } from "../plugin/hooks.js"
// 问题工具：CancelledError 表示用户关闭了提问
import { QuestionTool } from "../tool/plugin/question.js"
// 工具（Tool）服务：快照与执行
import { Tool } from "../tool.js"
// 会话亲和（affinity）工具：从会话取亲和键
import { SessionAffinity } from "./affinity.js"
// 模型传输（transport）服务：WebSocket 通道绑定
import { SessionModelTransport } from "./model-transport.js"
// 运行器模型解析类型
import { SessionRunnerModel } from "./runner/model.js"
// 会话领域 Schema
import { SessionSchema } from "./schema.js"
// 系统提示词构建
import { SessionSystemPrompt } from "./system-prompt.js"
// 把会话消息转换为 LLM 消息的工具
import { toLLMMessages } from "./runner/to-llm-message.js"
// 会话消息类型（仅类型）
import type { SessionMessage } from "./message.js"

// 触发裁剪的内联图片总大小阈值：25 MiB
const IMAGE_BYTES_TRIGGER = 25 * 1024 * 1024 // 25 MiB
// 裁剪后保留的目标大小：15 MiB
const IMAGE_BYTES_TARGET = 15 * 1024 * 1024 // 15 MiB
// 被裁剪图片在请求中替换成的占位提示文本
const IMAGE_REMOVED =
  "[This image was removed to reduce the request size and is no longer visible. Do not make claims about its contents from memory. If needed, retrieve it again with an available tool or ask the user to attach it again.]"
// Used when the catalog has no output limit for the model.
// 模型目录没有输出上限时的兜底输出 token 数
const OUTPUT_TOKEN_FALLBACK = 32_000
// No reply needs more, however much the model allows.
// 输出 token 的硬上限：再大的允许值也不需要更多
const OUTPUT_TOKEN_MAX = 256_000
// Prompt text is estimated at about 4 characters per token, which can run low on dense text such as code.
// 估算误差余量：提示词按约 4 字符/token 估算，对代码等稠密文本可能偏低，故放大 15%
const ESTIMATE_ERROR = 0.15
// Share of the window a turn leaves unused when its output limit is fitted to the room left. Providers count a few
// tokens more than we do (chat template, tool schemas), and strict ones reject input plus output past the window.
// Compaction sizes its summary against its own reserve instead.
// 为上下文窗口预留的空闲比例：各家 provider 的 token 计数普遍略多（聊天模板、工具 schema），
// 严格的 provider 会在"输入+输出"超出窗口时直接拒绝
const WINDOW_HEADROOM = 0.01
// Never ask for less; only reachable with automatic compaction off, since it keeps the window from filling this far.
// 输出下限：绝不请求更少（仅在关闭自动压缩时可能触及，因为它限制了窗口填充程度）
const OUTPUT_TOKEN_MIN = 1_024

/** Tool errors, plus the user declining a permission or dismissing a question. */
// 工具执行错误类型：工具错误 + 用户拒绝授权 + 用户取消提问
export type ExecuteError = Tool.Error | Permission.DeclinedError | QuestionTool.CancelledError

// Prepared：一次请求准备完成后的产物（事件、LLM 请求、流式选项与回调）
export interface Prepared<Event = SessionRequest> {
  // 流程对应的事件草稿（主对话/压缩/生成/标题）
  readonly event: Event
  // 组装好的 LLM 请求
  readonly request: LLMRequest
  // 流式选项（HTTP 钩子、WebSocket 等）
  readonly options: StreamOptions
  // 重试回调：触发 session/retry 插件钩子
  readonly retry: (event: PluginHooks.Domains["session"]["retry"]) => Effect.Effect<void>
  /** Runs a tool call against the tools this request advertised. */
  // executeTool：针对本请求声明的工具集执行一次工具调用
  readonly executeTool: (
    input: Parameters<Tool.Snapshot["execute"]>[0],
  ) => Effect.Effect<Tool.NormalizedResult, ExecuteError>
}

// Input：构建请求所需的输入
export interface Input {
  // 目标会话信息
  readonly session: SessionSchema.Info
  // 使用的 agent ID
  readonly agent: Agent.ID
  // 解析后的模型（含路由、能力、限额）
  readonly model: SessionRunnerModel.Resolved
  // 可选的工具快照（缺省表示本请求无工具）
  readonly tools?: Tool.Snapshot
  // 系统提示词分片
  readonly system: Array<SystemPart>
  // 对话消息列表
  readonly messages: Array<Message>
  // 可选的工具调用策略（auto/none/指定工具等）
  readonly toolChoice?: LLM.LLMRequestInput["toolChoice"]
  /** Only the durable runner may use a stateful WebSocket. */
  // 仅持久化运行器（durable runner）可使用有状态 WebSocket
  readonly webSocket?: "session"
  /** Prompt size, measured by the provider or estimated. The default output limit leaves room for it. */
  // 提示词大小（provider 实测或本地估算），用于把输出上限适配到剩余窗口
  readonly inputTokens?: { readonly measured: number; readonly estimated: number }
}

/** The default output limit: the catalog limit, fitted to the room the prompt leaves in the context window. */
// outputLimit：默认输出上限 = 目录限额向"提示词之后的剩余窗口"适配后的结果
export const outputLimit = (limit: Model.Info["limit"], inputTokens?: Input["inputTokens"], headroom = 0) => {
  // 请求值 = 目录输出限额（无则用兜底值），再截到硬上限
  const requested = Math.min(limit.output > 0 ? limit.output : OUTPUT_TOKEN_FALLBACK, OUTPUT_TOKEN_MAX)
  // 没有输入大小信息或窗口无效时直接返回请求值
  if (inputTokens === undefined || limit.context <= 0) return requested
  // 剩余空间 = 窗口*(1-预留) - 实测输入 - 估算输入*(1+估算误差)
  const room =
    Math.floor(limit.context * (1 - headroom)) -
    inputTokens.measured -
    Math.ceil(inputTokens.estimated * (1 + ESTIMATE_ERROR))
  // 取请求值与剩余空间的较小者，但不低于输出下限
  return Math.min(requested, Math.max(OUTPUT_TOKEN_MIN, room))
}

// baseTranscript：构建请求的基础骨架（系统提示 + 转换后的对话消息）
export const baseTranscript = (input: {
  readonly agent: Agent.Info
  readonly model: SessionRunnerModel.Resolved
  readonly tools: Tool.Snapshot
  readonly initial: ReadonlyArray<Instructions.Rendered>
  readonly messages: ReadonlyArray<SessionMessage.Info>
}) => {
  // provider 元数据键：优先取模型路由声明的键，否则用 provider 名
  const providerMetadataKey = input.model.model.route.providerMetadataKey ?? input.model.model.provider
  return {
    providerMetadataKey,
    system: [
      // 第一段：agent 自带系统提示词，缺省则按工具清单生成默认系统提示词
      SystemPart.make(
        input.agent.system
          ? input.agent.system
          : SessionSystemPrompt.make(input.tools.definitions.map((tool) => tool.name)),
      ),
      // 第二段：初始指令渲染文本，并在元数据中保留原始渲染结果
      {
        ...SystemPart.make(Instructions.join(input.initial)),
        metadata: { experimental: { instructions: input.initial } },
      },
    ].filter((part) => part.text.length > 0),
    // 把会话消息转换为 LLM 消息
    messages: toLLMMessages(input.messages, input.model.ref, providerMetadataKey),
  }
}

// mimeToModality：把 MIME 类型归为模态（image/audio/video/pdf），未知返回 undefined
const mimeToModality = (mime: string) => {
  if (mime.startsWith("image/")) return "image"
  if (mime.startsWith("audio/")) return "audio"
  if (mime.startsWith("video/")) return "video"
  if (mime === "application/pdf") return "pdf"
}

// xAI rejects any other image type (e.g. GIF) with invalid_image, and the stored image would fail every later turn.
// xAI 只接受这三种图片类型（其他如 GIF 会被拒），存储的图片不能在后续轮次反复报错
const XAI_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp"])

// unsupportedMedia：判断某媒体是否不被当前模型/提供商支持，返回替换用的错误提示文本
const unsupportedMedia = (
  mime: string,
  name: string | undefined,
  capabilities: Model.Capabilities,
  provider: string | undefined,
) => {
  // 先归一化模态
  const modality = mimeToModality(mime)
  // 非媒体类型（无模态）无需处理
  if (!modality) return
  // 不支持的情形：模型能力不含该模态；或 xAI 收到不在白名单内的图片类型
  const unsupported = !capabilities.input.some((item) => item.startsWith(modality))
    ? modality
    : provider === "xai" && modality === "image" && !XAI_IMAGE_MIMES.has(mime.toLowerCase())
      ? mime
      : undefined
  // 支持则不替换
  if (!unsupported) return
  // 返回提示文本，要求模型告知用户
  return `ERROR: Cannot read ${name ? `"${name}"` : modality} (this model does not support ${unsupported} input). Inform the user.`
}

// The inline budget counts base64 characters, which are ASCII, so a string's length is its size without scanning it.
// Remote and provider-referenced media carry no local payload and never count toward the inline budget.
// mediaBytes：估算媒体的"内联体积"——base64 字符数即字符串长度（ASCII）；
// bytes 源按 4/3 近似 base64 膨胀；远程/引用型媒体不计入
const mediaBytes = (media: Media.Asset) => {
  if (media.source.type === "base64") return media.source.data.length
  if (media.source.type === "bytes") return Math.ceil(media.source.data.byteLength / 3) * 4
  return 0
}

/** Replaces media with the returned text; messages without replacements are returned unchanged. */
// replaceMedia：按回调逐个替换消息中的媒体（返回 undefined 表示保留原样）
const replaceMedia = (
  messages: LLMRequest["messages"],
  replace: (media: { mime: string; name: string | undefined; bytes: () => number }) => string | undefined,
) => {
  // 处理媒体分片：回调返回文本则替换为文本分片
  const media = (part: MediaPart) => {
    const text = replace({ mime: part.media.mediaType, name: part.filename, bytes: () => mediaBytes(part.media) })
    return text === undefined ? part : Message.text(text)
  }
  // 处理工具结果分片：只处理 content 型结果中的 file 项
  const toolResult = (part: ToolResultPart) => {
    if (part.result.type !== "content") return part
    const result = part.result
    // 逐项检查 file 项，需要替换的换成文本内容
    const value = result.value.map((item): Content => {
      if (item.type !== "file") return item
      const text = replace({ mime: item.mime, name: item.name, bytes: () => item.uri.length })
      return text === undefined ? item : { type: "text", text }
    })
    // 无任何变化则返回原分片（保持引用相等）
    return value.every((item, index) => item === result.value[index]) ? part : { ...part, result: { ...result, value } }
  }
  // 按消息角色分别处理
  return messages.map((message) => {
    switch (message.role) {
      // 系统消息不含媒体
      case "system":
        return message
      case "user": {
        // 用户消息：替换其中的媒体分片
        const content = message.content.map((part) => (part.type === "media" ? media(part) : part))
        // 未变化则复用原消息对象
        return sameParts(content, message.content) ? message : new UserMessage({ ...message, content })
      }
      case "assistant": {
        // 助手消息：替换媒体分片与工具结果里的文件
        const content = message.content.map((part) => {
          if (part.type === "media") return media(part)
          return part.type === "tool-result" ? toolResult(part) : part
        })
        return sameParts(content, message.content) ? message : new AssistantMessage({ ...message, content })
      }
      case "tool": {
        // 工具消息：所有分片都按工具结果处理
        const content = message.content.map(toolResult)
        return sameParts(content, message.content) ? message : new ToolMessage({ ...message, content })
      }
    }
  })
}

// sameParts：判断两个分片数组的对应元素是否全部引用相等
const sameParts = (next: ReadonlyArray<ContentPart>, previous: ReadonlyArray<ContentPart>) =>
  next.every((part, index) => part === previous[index])

// unsupportedParts：把模型/提供商不支持的媒体替换为错误提示文本
export const unsupportedParts = (
  messages: LLMRequest["messages"],
  capabilities: Model.Capabilities,
  provider?: string,
) => replaceMedia(messages, (media) => unsupportedMedia(media.mime, media.name, capabilities, provider))

// boundImages：限制请求中内联图片的总体积（超过触发阈值时按序裁掉最旧的图片）
export const boundImages = (messages: LLMRequest["messages"]) => {
  // 判断 MIME 是否为图片
  const isImage = (mime: string) => mime.toLowerCase().startsWith("image/")
  // 收集所有内联图片的体积（媒体分片按字节数，工具结果里的文件按 URI 长度）
  const sizes = messages.flatMap((message) =>
    message.content.flatMap((part) => {
      if (part.type === "media") return isImage(part.media.mediaType) ? [mediaBytes(part.media)] : []
      if (part.type !== "tool-result" || part.result.type !== "content") return []
      return part.result.value.flatMap((item: Content) =>
        item.type === "file" && isImage(item.mime) ? [item.uri.length] : [],
      )
    }),
  )
  // Replay the images in order, dropping the oldest down to the target whenever the kept payload passes the trigger.
  // A new image then moves the cut only every (trigger - target) bytes instead of on every request, so the replaced
  // prefix, and with it the provider's prompt cache, stays the same between cuts.
  // 滑动窗口式裁剪：累计保留体积，超过触发阈值就把最旧的图片丢到目标体积以下；
  // 这样切点只在每新增 (触发-目标) 字节时前移一次，保证两次裁剪间被替换的前缀
  // （以及 provider 的提示词缓存）保持稳定
  let cut = 0
  let kept = 0
  for (const size of sizes) {
    kept += size
    // 未超触发阈值前不裁剪
    if (kept <= IMAGE_BYTES_TRIGGER) continue
    // 超过后从最旧开始丢弃，直到降到目标体积以下
    while (kept > IMAGE_BYTES_TARGET) kept -= sizes[cut++]!
  }
  // 没有需要裁掉的图片则原样返回
  if (cut === 0) return messages

  // 按序把前 cut 张图片替换为占位提示文本
  let index = 0
  return replaceMedia(messages, (media) => {
    // 非图片不处理
    if (!isImage(media.mime)) return
    // 前 cut 张返回占位文本，其余保留
    return index++ < cut ? IMAGE_REMOVED : undefined
  })
}

// Definitions：钩子上下文中工具定义的类型别名
type Definitions = PluginHooks.Domains["session"]["context"]["tools"]

/** Builds the model request for each session flow. Each entry runs its own plugin hook. */
// 服务接口：为每种会话流程构建模型请求（各自触发对应插件钩子）
export interface Interface {
  // primary：主对话请求
  readonly primary: (input: Input) => Effect.Effect<Prepared<SessionContext>>
  // compaction：压缩请求
  readonly compaction: (input: Input) => Effect.Effect<Prepared<SessionCompaction>>
  // generate：生成请求
  readonly generate: (input: Input) => Effect.Effect<Prepared<SessionGenerate>>
  // title：标题请求
  readonly title: (input: Input) => Effect.Effect<Prepared<SessionTitle>>
}

// 服务标识：Effect Context 中用于定位本服务的 Tag
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionModelRequest") {}

// 服务层（Layer）：装配 prepare 及四种流程入口
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 注入插件钩子、模型传输服务与应用元数据
    const hooks = yield* PluginHooks.Service
    const transport = yield* SessionModelTransport.Service
    const app = yield* App.Metadata
    // prepare：通用的请求准备流程（各流程通过 shape 回调差异化）
    const prepare = Effect.fn("SessionModelRequest.prepare")(function* <
      S extends SessionRequest & { tools?: Definitions },
    >(kind: SessionRequestKind, input: Input, shape: (draft: SessionRequest, tools: Definitions) => Effect.Effect<S>) {
      // 解构会话与模型
      const session = input.session
      const model = input.model
      // 钩子事件的作用域信息（会话/agent/模型/流程类型）
      const scope = { sessionID: session.id, agent: input.agent, model: model.ref, kind }
      // 未提供工具时给一个空快照，execute 直接报"本请求无工具"
      const tools = input.tools ?? {
        definitions: [],
        execute: () => new Tool.Error({ message: "Tools are not available for this request" }),
      }
      // Remember which tool each definition object came from. Hooks rename a tool by moving
      // its definition to a new key, so after the hook we find the tool by object identity.
      // Definitions are shared across steps and sessions, and hooks may edit schemas in place,
      // so each hook gets a deep copy.
      // 记录每个定义对象来自哪个工具：钩子改名是通过把定义挪到新键实现的，
      // 因此钩子后按对象身份回查；定义跨步骤/会话共享且钩子可能就地改 schema，故深拷贝
      const given = new Map(
        tools.definitions.map(
          (t) => [{ description: t.description, input: JSON.parse(JSON.stringify(t.inputSchema)) }, t] as const,
        ),
      )
      // Hooks see the default output limit and may change or remove it. Titles and generate keep the provider default,
      // because their reasoning is hard to budget.
      // 运行钩子对请求草稿做整形：主对话给"预留窗口后"的输出上限，
      // 压缩用不带预留的上限，标题/生成保持 provider 默认（其推理难以预算）
      const shaped = yield* shape(
        {
          sessionID: session.id,
          model: model.ref,
          system: input.system,
          messages: input.messages,
          options:
            kind === "primary"
              ? { maxTokens: outputLimit(model.limit, input.inputTokens, WINDOW_HEADROOM) }
              : kind === "compaction"
                ? { maxTokens: outputLimit(model.limit, input.inputTokens) }
                : {},
        },
        // 以工具名为键传入定义的深拷贝
        Object.fromEntries(Array.from(given, ([d, t]) => [t.name, d])),
      )
      // Match by identity first, then by key. Entries matching neither were invented by a
      // hook and are dropped. `t.name` stays the real name so execution can map renames back.
      // 钩子返回后回查工具：先按对象身份，再按键名；两者都不匹配的定义是钩子凭空
      // 新造的，直接丢弃；t.name 保留真实名称以便执行时把改名映射回去
      const byName = new Map(tools.definitions.map((t) => [t.name, t]))
      const hooked = new Map(
        Object.entries(shaped.tools ?? {}).flatMap(([name, d]) => {
          const t = given.get(d) ?? byName.get(name)
          return t ? [[name, { ...t, description: d.description, inputSchema: d.input }] as const] : []
        }),
      )
      // 把钩子返回的 options 拆分为"生成参数"与"provider 专有选项"
      const entries = Object.entries(shaped.options)
      const generation = Object.fromEntries(entries.filter(([k]) => GENERATION_KEYS.has(k))) as GenerationOptionsFields
      const providerOptions = Object.fromEntries(entries.filter(([k]) => !GENERATION_KEYS.has(k)))
      // 读取会话的亲和键（用于提示词缓存与路由）
      const affinity = SessionAffinity.get(session)
      // 组装基础 LLM 请求
      const base = ai.request({
        model: model.model,
        headers: {
          // 附带会话/父会话/亲和键等追踪头
          "x-opencode-session-id": session.id,
          ...(session.parentID ? { "x-opencode-parent-session-id": session.parentID } : {}),
          "x-session-affinity": affinity,
          "X-Session-Id": affinity,
          ...(session.parentID ? { "x-parent-session-id": session.parentID } : {}),
          "User-Agent": App.useragent(app),
          "x-opencode-project": session.projectID,
          "x-opencode-session": affinity,
          "x-opencode-client": app.name,
        },
        // TODO: Persist cache lineage so nested forks reuse the root session's cache key.
        // 提示词缓存键：亲和键形如 ses_<64位hex> 时去掉前缀（派生会话共享缓存），否则原样
        promptCacheKey: /^ses_[0-9a-f]{64}$/.test(affinity) ? affinity.slice(4) : affinity,
        // 缓存 TTL：模型目录有配置才传
        cache: model.cache?.ttl === undefined ? undefined : { ttl: model.cache.ttl },
        system: shaped.system,
        // 消息先剔除不支持的媒体，再对内联图片做体积裁剪
        messages: boundImages(unsupportedParts(shaped.messages, model.capabilities, model.model.provider)),
        tools: Array.from(hooked, ([name, t]) => ({ ...t, name })),
        toolChoice: input.toolChoice,
        // 生成参数平铺进请求
        ...generation,
        providerOptions: Object.keys(providerOptions).length === 0 ? undefined : providerOptions,
      })

      // 取模型路由的基础 URL
      const baseURL = base.model.route.endpoint.baseURL
      // 触发 session/model.request 钩子：允许调整 baseURL 与请求头
      const modelHook = yield* hooks.trigger("session", "model.request", {
        ...scope,
        baseURL,
        headers: { ...base.headers },
      })
      // 钩子改了 baseURL 时克隆路由；否则沿用原路由
      const route =
        modelHook.baseURL !== undefined && modelHook.baseURL !== baseURL
          ? base.model.route.with({ endpoint: { baseURL: modelHook.baseURL } })
          : base.model.route
      // 应用钩子结果：可能更新模型路由与请求头
      const request = {
        ...base,
        model: route === base.model.route ? base.model : LanguageModel.update(base.model, { route }),
        headers: Object.keys(modelHook.headers).length === 0 ? undefined : modelHook.headers,
      }
      // 探测是否注册了 HTTP 请求/响应钩子
      const hasHttpHooks =
        (yield* hooks.has("session", "http.request", model.ref.providerID)) ||
        (yield* hooks.has("session", "http.response", model.ref.providerID))
      // http：把钩子桥接到传输层的每个 HTTP 请求/响应
      const http: StreamOptions["http"] = hasHttpHooks
        ? (req, handler) =>
            Effect.gen(function* () {
              // 把传输层请求转换为 Web Request
              const request = yield* HttpClientRequest.toWeb(req)
              // 请求前钩子
              const before = yield* hooks.trigger("session", "http.request", { ...scope, request })
              // A hook that kept the request object cannot have replaced its body, so the original body is sent as is.
              // Reading it back would hold a second full copy of the request, screenshots included, for the whole call.
              // 钩子未换请求对象时直接沿用原始 body（避免为回读 body 再持有一整份拷贝）；
              // 换了则从新请求克隆出 body（Uint8Array）再发送
              const sent =
                before.request === request
                  ? HttpClientRequest.setBody(HttpClientRequest.fromWeb(request), req.body)
                  : before.request.body
                    ? HttpClientRequest.bodyUint8Array(
                        HttpClientRequest.fromWeb(before.request),
                        new Uint8Array(yield* Effect.promise(() => before.request.clone().arrayBuffer())),
                        before.request.headers.get("content-type") ?? undefined,
                      )
                    : HttpClientRequest.fromWeb(before.request)
              // 执行实际请求
              const res = yield* handler(sent)
              // 响应后钩子：把响应包装为 Web Response（无实体的状态码传 null）
              const after = yield* hooks.trigger("session", "http.response", {
                ...scope,
                request: before.request,
                response: new Response(
                  [204, 205, 304].includes(res.status) ? null : yield* Stream.toReadableStreamEffect(res.stream),
                  { status: res.status, headers: res.headers },
                ),
              })
              // 用钩子后的响应构造返回值（保留发送的请求上下文）
              return HttpClientResponse.fromWeb(sent, after.response)
            })
        : undefined
      // HTTP hooks wrap every HTTP request, including the WebSocket fallback path. The route decides
      // which transport actually carries the request, so both hook families are always offered.
      // webSocket：持久化运行器且模型走 WebSocket 传输时绑定通道，
      // 握手/收/发各阶段都暴露给实验性钩子
      const webSocket =
        input.webSocket === "session" && model.transport === "websocket"
          ? transport.bind(
              session.id,
              {
                // 握手钩子：允许改 URL 与头
                handshake: (connect) =>
                  hooks
                    .trigger("session", "experimental.ws.handshake", {
                      ...scope,
                      url: connect.url,
                      headers: connect.headers,
                    })
                    .pipe(Effect.map((event) => ({ url: event.url, headers: event.headers }))),
                // 发送钩子：允许改出站帧
                send: (frame) =>
                  hooks
                    .trigger("session", "experimental.ws.send", { ...scope, frame })
                    .pipe(Effect.map((event) => event.frame)),
                // 接收钩子：允许改入站帧
                receive: (frame) =>
                  hooks
                    .trigger("session", "experimental.ws.receive", { ...scope, frame })
                    .pipe(Effect.map((event) => event.frame)),
              },
              model.chunkTimeout,
            )
          : undefined

      return {
        // 钩子整形后的事件草稿
        event: shaped,
        request,
        // 组装流式选项（按需附带 http/webSocket）
        options: { ...(http ? { http } : {}), ...(webSocket ? { webSocket } : {}) },
        // retry：触发 session/retry 钩子
        retry: (event: Parameters<Prepared["retry"]>[0]) =>
          hooks.trigger("session", "retry", event).pipe(Effect.asVoid),
        // Permission.assert and the question tool throw declines as defects so tools cannot
        // catch them and turn a "no" into model-visible output. Recover them here as failures,
        // including declines a tool rethrew and its wrapper attached to a Tool.Error, as Promise
        // plugin tools do.
        // executeTool：执行工具调用，并把"用户拒绝/取消"类缺陷（defect）恢复为可处理失败，
        // 避免工具把它们吞掉后把"拒绝"变成模型可见的输出；也覆盖工具重抛后包进 Tool.Error 的情形
        executeTool: (call: Parameters<Prepared["executeTool"]>[0]) =>
          tools.execute({ ...call, definitions: hooked }).pipe(
            Effect.catchCauseFilter(
              (cause) => {
                // 在原因（die/fail）中寻找拒绝类错误
                const decline = cause.reasons
                  .map((r) => (Cause.isDieReason(r) ? r.defect : Cause.isFailReason(r) ? r.error.error : undefined))
                  .find(
                    (value): value is Permission.DeclinedError | QuestionTool.CancelledError =>
                      value instanceof Permission.DeclinedError || value instanceof QuestionTool.CancelledError,
                  )
                // 找到则成功提取，否则保持原失败
                return decline ? Result.succeed(decline) : Result.fail(cause)
              },
              // 把提取出的拒绝错误转为普通失败
              (decline) => Effect.fail(decline),
            ),
          ),
      }
    })

    // agentHook：构造触发 session/context|compaction|generate 钩子的 shape 回调
    const agentHook =
      (name: "context" | "compaction" | "generate", agent: Agent.ID) => (draft: SessionRequest, tools: Definitions) =>
        hooks.trigger("session", name, { ...draft, agent, tools })

    return Service.of({
      // primary：触发 session/context 钩子
      primary: (input) => prepare("primary", input, agentHook("context", input.agent)),
      // compaction：触发 session/compaction 钩子
      compaction: (input) => prepare("compaction", input, agentHook("compaction", input.agent)),
      // generate：触发 session/generate 钩子
      generate: (input) => prepare("generate", input, agentHook("generate", input.agent)),
      // title：触发 session/title 钩子
      title: (input) => prepare("title", input, (draft) => hooks.trigger("session", "title", draft)),
    })
  }),
)

// 注册为 Location 级节点，依赖插件钩子/传输/应用元数据节点
export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [PluginHooks.node, SessionModelTransport.node, App.node],
})
