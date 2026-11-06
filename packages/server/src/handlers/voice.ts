// 引入位置（Location）模型与位置服务映射
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-services"
// 引入 AbsolutePath：绝对路径构造类型
import { AbsolutePath } from "@opencode/core/schema"
// 引入语音（Voice）核心服务：语音模型与语音会话
import { Voice } from "@opencode/core/voice"
// 引入协议层错误：无效请求与服务不可用
import { InvalidRequestError, ServiceUnavailableError } from "@opencode/protocol/errors"
// 引入全局服务：提供全局配置目录
import { Global } from "@opencode/util/global"
// 引入 Effect 运行时
import { Effect } from "effect"
// 引入 HTTP API 构建器
import { HttpApiBuilder } from "effect/http-api"
// 引入本服务 API 定义
import { Api } from "../api"
// 引入 awaitPlugins（等待插件激活）与 locationErrors（位置错误映射）
import { awaitPlugins, locationErrors } from "../location"

// 导出 VoiceHandler：注册 "server.voice" 分组处理器
export const VoiceHandler = HttpApiBuilder.group(Api, "server.voice", (handlers) =>
  Effect.gen(function* () {
    // 获取全局服务（全局配置目录）
    const global = yield* Global.Service
    // 获取位置服务映射
    const locations = yield* LocationServiceMap.Service
    // 从全局配置位置解析服务集（语音服务依赖该位置的配置/凭证）
    const services = locations.get(Location.Ref.make({ directory: AbsolutePath.make(global.config) }))
    return handlers
      .handle(
        // 处理 voice.models：列出可用的语音模型
        "voice.models",
        Effect.fn("server.voice.models")(
          function* () {
            // 等待插件激活完成（语音提供商可能由插件注册）
            yield* awaitPlugins
            // 获取语音服务
            const voice = yield* Voice.Service
            // 返回模型列表
            return { data: yield* voice.models() }
          },
          // 以全局服务集提供依赖
          Effect.provide(services),
          // 位置相关错误统一映射
          locationErrors,
        ),
      )
      .handle(
        // 处理 voice.session：建立语音会话，返回实时传输（transport）信息
        "voice.session",
        Effect.fn("server.voice.session")(
          // 入参为请求上下文，payload 携带会话参数
          function* (request) {
            // 等待插件激活完成
            yield* awaitPlugins
            // 获取语音服务
            const voice = yield* Voice.Service
            // 建立语音会话并取得传输通道；按错误类型映射：请求参数非法 -> InvalidRequestError，其余（依赖/网络问题）-> ServiceUnavailableError
            const transport = yield* voice
              .session(request.payload)
              .pipe(
                Effect.mapError((error) =>
                  error._tag === "Voice.InvalidRequestError"
                    ? new InvalidRequestError({ message: error.message })
                    : new ServiceUnavailableError({ message: error.message, service: error.service }),
                ),
              )
            // 返回传输信息
            return { data: { transport } }
          },
          // 以全局服务集提供依赖
          Effect.provide(services),
          // 位置相关错误统一映射
          locationErrors,
        ),
      )
  }),
)
