// 将本模块整体导出为 Generate 命名空间（自导出，供其他模块以 Generate.xxx 引用）
export * as Generate from "./generate.js"

// 引入 AI 能力封装：请求构造、错误类型、决策/图像/LLM 客户端与媒体工具
import { ai, AIError, DecisionClient, ImageClient, LLMClient, Media } from "@opencode/ai/effect"
// 引入决策与图像的请求/结果类型
import type { DecisionRequest, DecisionResult, ImageRequest, ImageResult } from "@opencode/schema/generate"
// 引入金额模式（用于成本统计）
import { Money } from "@opencode/schema/money"
// 引入会话 ID（为生成请求生成归属头，不落库）
import { SessionID } from "@opencode/schema/session-id"
// 引入 Effect 基础工具
import { Context, Effect, Layer, Schema } from "effect"
// 引入共享请求执行器（RequestExecutor）
import { RequestExecutor } from "@opencode/ai/route"
// 引入"按目录（location）装配服务节点"的辅助构造器
import { makeLocationNode } from "@opencode/util/effect/app-node"
// 引入 LLM 客户端与请求执行器节点
import { llmClient, requestExecutor } from "./effect/app-node-platform.js"
// 引入集成模块（凭据授权错误定义）
import { Integration } from "./integration.js"
// 引入模型解析器
import { ModelResolver } from "./model-resolver.js"
// 引入模型服务
import { Model } from "./model.js"
// 引入模型请求的一次性重试策略
import { ModelRetry } from "./model-retry.js"

// 文本生成输入：提示词（prompt）+ 可选的模型引用（Model.Ref）
export interface TextInput {
  readonly prompt: string
  readonly model?: Model.Ref
}

// 错误类：生成服务不可用（如凭据缺失、没有可用模型）
export class UnavailableError extends Schema.TaggedError<UnavailableError>()("Generate.UnavailableError", {
  message: Schema.String,
  // 可选：不可用的具体服务名
  service: Schema.optional(Schema.String),
}) {}

// 错误类：指定的模型不存在
export class ModelNotFoundError extends Schema.TaggedError<ModelNotFoundError>()("Generate.ModelNotFoundError", {
  providerID: Schema.String,
  modelID: Schema.String,
  message: Schema.String,
}) {}

/** The model exists but cannot serve this request, such as a chat model asked for images. */
// 模型存在但不能服务该请求（例如让聊天模型生成图像）
export class UnsupportedModelError extends Schema.TaggedError<UnsupportedModelError>()(
  "Generate.UnsupportedModelError",
  {
    providerID: Schema.String,
    modelID: Schema.String,
    // 缺失的能力（chat/image/decision）
    capability: Schema.String,
    message: Schema.String,
  },
) {}

// 错误类：请求本身非法（可指明出错的字段）
export class InvalidRequestError extends Schema.TaggedError<InvalidRequestError>()("Generate.InvalidRequestError", {
  message: Schema.String,
  field: Schema.optional(Schema.String),
}) {}

// 提供商（provider）失败原因的字面量枚举
export const ProviderFailure = Schema.Literals([
  // 认证失败
  "authentication",
  // 限流
  "rate_limit",
  // 内容安全拦截
  "content_filter",
  // 请求非法
  "invalid_request",
  // 提供商过载
  "overloaded",
  // 其他提供商侧错误
  "provider",
])

/** The provider rejected or failed the request after it was sent. */
// 提供商在请求发出后拒绝或失败
export class ProviderRequestError extends Schema.TaggedError<ProviderRequestError>()("Generate.ProviderRequestError", {
  providerID: Schema.String,
  // 失败原因归类
  reason: ProviderFailure,
  message: Schema.String,
  // 可选：HTTP 状态码
  status: Schema.optional(Schema.Int),
  // 可选：建议的重试等待毫秒数
  retryAfterMs: Schema.optional(Schema.Int),
}) {}

// 本服务全部错误类型的联合
export type Error =
  | ModelNotFoundError
  | UnsupportedModelError
  | InvalidRequestError
  | ProviderRequestError
  | UnavailableError

// 服务接口：文本生成、图像生成与决策三种能力
export interface Interface {
  // 生成文本
  readonly text: (input: TextInput) => Effect.Effect<string, Error>
  // 生成图像
  readonly image: (input: ImageRequest) => Effect.Effect<ImageResult, Error>
  // 生成结构化决策（问答）
  readonly decisions: (input: DecisionRequest) => Effect.Effect<DecisionResult, Error>
}

// Effect Context 的服务标签
export class Service extends Context.Service<Service, Interface>()("@opencode/Generate") {}

// Image and decision clients are built here, on the shared request executor, so only Generate depends on them.
// 构建服务实现；图像与决策客户端在此层构建（共享请求执行器），只有 Generate 依赖它们
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 依赖：LLM 客户端
    const llm = yield* LLMClient.Service
    // 依赖：模型解析器
    const resolver = yield* ModelResolver.Service
    // 依赖：模型服务（查询可用模型）
    const models = yield* Model.Service
    // 依赖：共享请求执行器
    const executor = yield* RequestExecutor.Service
    // 依赖：图像客户端
    const images = yield* ImageClient.Service
    // 依赖：决策客户端
    const decisionClient = yield* DecisionClient.Service

    // 文本生成的内部实现
    const runText = Effect.fn("Generate.text")(function* (input: TextInput) {
      // 解析模型引用；把各类解析错误统一映射为 Generate 的错误类型
      const resolved = yield* resolver.resolve(input.model).pipe(
        Effect.catchTag(
          [
            "SessionRunnerModel.VariantUnavailableError",
            "SessionRunnerModel.UnsupportedPackageError",
            "SessionRunnerModel.ModelConfigurationError",
            "SessionRunnerModel.ModelInitializationError",
            "SessionRunnerModel.UnresolvedProviderVariablesError",
            "SessionRunnerModel.UnsupportedCompactionError",
          ],
          (error) =>
            Effect.fail(
              // 指定了模型：转换为具体错误；未指定模型：报"服务不可用"
              input.model
                ? resolutionError(input.model, "chat", error)
                : new UnavailableError({ message: error.message, service: error.providerID }),
            ),
        ),
      )
      // 指定了模型但解析不到：报"模型不存在/类型不符"
      if (!resolved && input.model) return yield* missing(input.model, "chat")
      // 未指定模型且没有可用模型：报"服务不可用"
      if (!resolved)
        return yield* new UnavailableError({ message: "No model specified and no supported model is available" })
      // 调用 LLM 生成文本
      const response = yield* llm
        .generate(
          ai.request({
            model: resolved.model,
            prompt: input.prompt,
            // Gateways require session attribution even for a stateless call; no Session is stored.
            headers: { "x-opencode-session": SessionID.create() },
          }),
        )
        .pipe(
          // 应用一次性重试策略
          ModelRetry.retryOneShot,
          // 把 AI 错误映射为 Generate 错误
          Effect.mapError((error) => providerError(resolved.ref, error)),
        )
      // 返回生成的文本
      return response.text
    })

    // A ref no model of this type has: another type's model (422) or no model at all (404).
    // 在可用模型中查找同 ID 模型：找到说明是另一种类型的模型（422），否则确实不存在（404）
    const missing = Effect.fnUntraced(function* (ref: Model.Ref, type: Model.Type) {
      // 在 chat/image/decision 三类可用模型中按 provider+id 查找
      const other = (yield* models.available(["chat", "image", "decision"])).find(
        (model) => model.providerID === ref.providerID && model.id === ref.id,
      )
      // 存在同 ID 模型但类型不符：报"不支持该能力"
      if (other)
        return yield* new UnsupportedModelError({
          providerID: ref.providerID,
          modelID: ref.id,
          capability: type,
          message: `${ref.providerID}/${ref.id} is a ${other.type ?? "chat"} model, not a ${type} model`,
        })
      // 完全不存在：报"模型未找到"
      return yield* new ModelNotFoundError({
        providerID: ref.providerID,
        modelID: ref.id,
        message: `Model not found: ${ref.providerID}/${ref.id}`,
      })
    })

    // 图像生成
    const image = Effect.fn("Generate.image")(function* (input: ImageRequest) {
      // 解析图像模型；解析失败统一映射
      const model = yield* resolver
        .resolveImage(input.model)
        .pipe(Effect.mapError((error) => resolutionError(input.model, "image", error)))
      // 解析不到：报"模型不存在/类型不符"
      if (!model) return yield* missing(input.model, "image")
      // `ai.image.generate` turns an invalid request into a typed error; building it with `ai.image.request` would throw.
      // 调用图像生成（注入图像客户端；带一次性重试与错误映射）
      const response = yield* ai.image.generate({
        model,
        prompt: input.prompt,
        // 请求自带的参考图像转成 base64 媒体
        images: input.images?.map((file) => Media.base64(file.data, file.mime)),
        n: input.n,
        aspect: input.aspect,
        resolution: input.resolution,
      }).pipe(
        // 提供图像客户端依赖
        Effect.provideService(ImageClient.Service, images),
        // 应用一次性重试策略
        ModelRetry.retryOneShot,
        // 错误映射
        Effect.mapError((error) => providerError(input.model, error)),
      )
      // URL results are downloaded so every image comes back inline, like the request's own files.
      // Materializing also detects the type of a downloaded image from its bytes when the URL didn't say.
      // 把每个返回资源物化（下载 URL 等）为 base64 内联数据，使所有图像都以内联形式返回
      const outputs = yield* Effect.forEach(response.images, (asset) =>
        asset.materialize().pipe(
          // 物化后转为 base64 与 MIME 类型
          Effect.flatMap((image) =>
            image.base64().pipe(Effect.map((data) => ({ type: "image" as const, data, mime: image.mediaType }))),
          ),
          // 物化（可能的下载）需要请求执行器
          Effect.provideService(RequestExecutor.Service, executor),
          // 下载/转换失败映射为提供商错误
          Effect.mapError((error) => providerError(input.model, error)),
        ),
      )
      // 仅保留 token 类型的用量统计
      const usage = response.usage?.type === "tokens" ? response.usage : undefined
      // 组装结果：图像、token 用量（有值才带）、原生元数据（存在才带）
      return {
        images: outputs,
        ...(usage?.input === undefined && usage?.output === undefined
          ? {}
          : { tokens: { input: usage.input, output: usage.output } }),
        ...(response.providerMetadata ? { native: plainJson(response.providerMetadata) } : {}),
      } satisfies ImageResult
    })

    // 决策生成
    const decisions = Effect.fn("Generate.decisions")(function* (input: DecisionRequest) {
      // 解析决策模型；解析失败统一映射
      const model = yield* resolver
        .resolveDecision(input.model)
        .pipe(Effect.mapError((error) => resolutionError(input.model, "decision", error)))
      // 解析不到：报"模型不存在/类型不符"
      if (!model) return yield* missing(input.model, "decision")
      // 调用决策生成；把文件输入统一转成 base64 媒体
      const response = yield* ai.decision.generate({
        model,
        input: input.input.map((part) =>
          // 文件部分转 base64 媒体并保留文件名，其余部分原样传递
          part.type === "file"
            ? { type: "media" as const, media: Media.base64(part.data, part.mime), filename: part.name }
            : part,
        ),
        questions: input.questions,
      }).pipe(
        // 提供决策客户端依赖
        Effect.provideService(DecisionClient.Service, decisionClient),
        // 应用一次性重试策略
        ModelRetry.retryOneShot,
        // 错误映射
        Effect.mapError((error) => providerError(input.model, error)),
      )
      // 取用量统计
      const usage = response.usage
      // 组装结果：答案、成本（有才带）、token 用量（有才带）、原生元数据（存在才带）
      return {
        answers: response.answers,
        ...(usage?.cost === undefined ? {} : { cost: Money.USD.make(usage.cost) }),
        ...(usage?.inputTokens === undefined && usage?.outputTokens === undefined
          ? {}
          : { tokens: { input: usage.inputTokens, output: usage.outputTokens } }),
        ...(response.providerMetadata ? { native: plainJson(response.providerMetadata) } : {}),
      } satisfies DecisionResult
    })

    // 凭据包装：把"凭据授权错误"转换成"服务不可用"错误
    const credentials = <A, E, R>(effect: Effect.Effect<A, E | Integration.AuthorizationError, R>) =>
      effect.pipe(
        Effect.catchTag(
          "Integration.Authorization",
          () => new UnavailableError({ message: "Generation credentials are unavailable" }),
        ),
      )

    // 对外暴露三个能力，统一经过凭据错误转换
    return Service.of({
      text: (input) => credentials(runText(input)),
      image: (input) => credentials(image(input)),
      decisions: (input) => credentials(decisions(input)),
    })
  }),
// 注入图像与决策客户端层
).pipe(Layer.provide([ImageClient.layer, DecisionClient.layer]))

// Provider metadata may hold undefined fields, which the JSON response schema rejects.
// 通过 JSON 序列化往返剔除 undefined 字段，避免响应模式校验失败
function plainJson(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value))
}

// 把模型解析错误映射为 Generate 错误
function resolutionError(ref: Model.Ref, type: string, error: ModelResolver.Error) {
  // 凭据授权错误原样透传（由 credentials 统一转换）
  if (error._tag === "Integration.Authorization") return error
  // 模型变体不可用：请求字段非法（model.variant）
  if (error._tag === "SessionRunnerModel.VariantUnavailableError")
    return new InvalidRequestError({ message: error.message, field: "model.variant" })
  // 不支持该类型所需的 API 包：报"模型不支持该能力"
  if (error._tag === "SessionRunnerModel.UnsupportedPackageError")
    return new UnsupportedModelError({
      providerID: ref.providerID,
      modelID: ref.id,
      capability: type,
      message: `${ref.providerID}/${ref.id} has no ${type} API opencode can call (package ${error.package})`,
    })
  // 其余解析错误：一律视为请求非法（model 字段）
  return new InvalidRequestError({ message: error.message, field: "model" })
}

// 把 AI 错误映射为"请求非法"或"提供商请求错误"
function providerError(ref: Model.Ref, error: AIError) {
  // 取错误的根本原因
  const reason = error.reason
  // 尚未发出就被判非法的请求：报 InvalidRequestError
  if (reason._tag === "InvalidRequest" && reason.http === undefined)
    return new InvalidRequestError({ message: reason.message })
  // 不支持的操作：同样视为请求非法
  if (reason._tag === "UnsupportedOperation") return new InvalidRequestError({ message: reason.message })
  // 提取 HTTP 状态码与重试建议（存在时）
  const status = "http" in reason ? reason.http?.status : undefined
  const retryAfterMs = "retryAfterMs" in reason ? reason.retryAfterMs : undefined
  // 其余情况：报提供商请求错误
  return new ProviderRequestError({
    providerID: ref.providerID,
    // 按错误标签与状态码归类失败原因
    reason: failureReason(reason._tag, status),
    message: reason.message,
    ...(status === undefined ? {} : { status }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  })
}

// 按错误标签与状态码归类失败原因
function failureReason(tag: AIError["reason"]["_tag"], status: number | undefined): typeof ProviderFailure.Type {
  // 认证失败
  if (tag === "Authentication") return "authentication"
  // 限流或配额超限
  if (tag === "RateLimit" || tag === "QuotaExceeded") return "rate_limit"
  // 内容政策拦截
  if (tag === "ContentPolicy") return "content_filter"
  // 请求非法
  if (tag === "InvalidRequest") return "invalid_request"
  // 提供商内部错误且状态码为 503/529：视为过载
  if (tag === "ProviderInternal" && (status === 503 || status === 529)) return "overloaded"
  // 其余一律归为普通提供商错误
  return "provider"
}

// 包装为按目录装配的节点，依赖模型解析器、模型服务、LLM 客户端与请求执行器节点
export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [ModelResolver.node, Model.node, llmClient, requestExecutor],
})
