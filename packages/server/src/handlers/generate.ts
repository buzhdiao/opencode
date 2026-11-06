// 引入生成（Generate）核心服务：直接调用模型完成文本/图像生成与决策
import { Generate } from "@opencode/core/generate"
// 引入位置（Location）服务模型
import { Location } from "@opencode/core/location"
// 引入位置服务映射：按位置解析服务集
import { LocationServiceMap } from "@opencode/core/location-services"
// 引入 AbsolutePath：绝对路径构造类型
import { AbsolutePath } from "@opencode/core/schema"
// 引入协议层错误：无效请求、模型未找到、提供商请求错误、服务不可用、模型能力不支持
import {
  InvalidRequestError,
  ModelNotFoundError,
  ProviderRequestError,
  ServiceUnavailableError,
  UnsupportedModelError,
} from "@opencode/protocol/errors"
// 引入决策请求与图像请求的 Schema 类型
import type { DecisionRequest, ImageRequest } from "@opencode/schema/generate"
// 引入全局服务：提供全局配置目录
import { Global } from "@opencode/util/global"
// 引入模型（Model）Schema：模型引用类型
import { Model } from "@opencode/schema/model"
// 引入 Effect 运行时
import { Effect } from "effect"
// 引入 HTTP API 构建器
import { HttpApiBuilder } from "effect/http-api"
// 引入本服务 API 定义
import { Api } from "../api"
// 引入 awaitPlugins（等待插件激活）与 locationErrors（位置错误映射）
import { awaitPlugins, locationErrors } from "../location"

// 导出 GenerateHandler：注册 "server.generate" 分组处理器
export const GenerateHandler = HttpApiBuilder.group(Api, "server.generate", (handlers) =>
  Effect.gen(function* () {
    // 获取全局服务（全局配置目录）
    const global = yield* Global.Service
    // 获取位置服务映射
    const locations = yield* LocationServiceMap.Service
    // 从全局配置位置解析服务集（生成依赖该位置的提供商配置）
    const services = locations.get(Location.Ref.make({ directory: AbsolutePath.make(global.config) }))
    // 文本生成处理器：同时服务 generate.text 与 generate.textLegacy 两个端点
    const text = Effect.fn("server.generate.text")(
      // 入参为请求上下文，payload 含提示词与可选模型引用
      function* (request: { readonly payload: { readonly prompt: string; readonly model?: Model.Ref } }) {
        // 等待插件激活完成（提供商可能由插件注册）；超时 5 秒则失败
        yield* awaitPlugins
        // 获取生成服务
        const generate = yield* Generate.Service
        // 执行文本生成，内部错误经 generateError 映射为协议错误
        return { data: { text: yield* generate.text(request.payload).pipe(Effect.mapError(generateError)) } }
      },
      // 以全局服务集提供依赖
      Effect.provide(services),
      // 统一映射位置相关错误
      locationErrors,
    )
    // 图像生成处理器
    const image = Effect.fn("server.generate.image")(
      // payload 为图像请求（提示词、尺寸等）
      function* (request: { readonly payload: ImageRequest }) {
        // 等待插件激活完成
        yield* awaitPlugins
        // 获取生成服务
        const generate = yield* Generate.Service
        // 执行图像生成并映射错误
        return { data: yield* generate.image(request.payload).pipe(Effect.mapError(generateError)) }
      },
      // 以全局服务集提供依赖
      Effect.provide(services),
      // 统一映射位置相关错误
      locationErrors,
    )
    // 决策生成处理器：就多个问题征求模型决策
    const decisions = Effect.fn("server.generate.decisions")(
      // payload 为决策请求（问题列表）
      function* (request: { readonly payload: DecisionRequest }) {
        // 收集所有问题的名称（name）
        const names = new Set(request.payload.questions.map((question) => question.name))
        // 名称必须唯一，否则返回无效请求错误
        if (names.size !== request.payload.questions.length)
          return yield* new InvalidRequestError({
            message: "Decision question names must be unique",
            field: "questions",
          })
        // 等待插件激活完成
        yield* awaitPlugins
        // 获取生成服务
        const generate = yield* Generate.Service
        // 执行决策生成并映射错误
        return { data: yield* generate.decisions(request.payload).pipe(Effect.mapError(generateError)) }
      },
      // 以全局服务集提供依赖
      Effect.provide(services),
      // 统一映射位置相关错误
      locationErrors,
    )
    return handlers
      // 处理 generate.text：标准文本生成端点
      .handle("generate.text", text)
      // 处理 generate.textLegacy：兼容旧版客户端，复用同一文本处理器
      .handle("generate.textLegacy", text)
      // 处理 generate.image：图像生成端点
      .handle("generate.image", image)
      // 处理 generate.decisions：决策生成端点
      .handle("generate.decisions", decisions)
  }),
)

// 辅助函数：把生成服务的内部错误按 _tag 映射为协议层 HTTP 错误
function generateError(error: Generate.Error) {
  switch (error._tag) {
    // 模型未找到 -> ModelNotFoundError
    case "Generate.ModelNotFoundError":
      return new ModelNotFoundError({ providerID: error.providerID, modelID: error.modelID, message: error.message })
    // 模型不支持所需能力 -> UnsupportedModelError
    case "Generate.UnsupportedModelError":
      return new UnsupportedModelError({
        providerID: error.providerID,
        modelID: error.modelID,
        capability: error.capability,
        message: error.message,
      })
    // 请求参数非法 -> InvalidRequestError（field 存在时才附带）
    case "Generate.InvalidRequestError":
      return new InvalidRequestError({
        message: error.message,
        ...(error.field === undefined ? {} : { field: error.field }),
      })
    // 提供商请求失败 -> ProviderRequestError（status 与 retryAfterMs 可选附带）
    case "Generate.ProviderRequestError":
      return new ProviderRequestError({
        providerID: error.providerID,
        reason: error.reason,
        message: error.message,
        ...(error.status === undefined ? {} : { status: error.status }),
        ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      })
    // 服务不可用 -> ServiceUnavailableError（service 可选附带）
    case "Generate.UnavailableError":
      return new ServiceUnavailableError({
        message: error.message,
        ...(error.service === undefined ? {} : { service: error.service }),
      })
  }
}
