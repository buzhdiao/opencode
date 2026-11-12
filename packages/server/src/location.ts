// 引入文件系统服务：用于识别“目录不存在”错误类型
import { FileSystem } from "@opencode/core/filesystem"
// 引入位置（Location）服务：请求作用域内的工作目录上下文
import { Location } from "@opencode/core/location"
// 引入插件服务：等待插件激活
import { Plugin } from "@opencode/core/plugin"
// 引入位置服务映射：按请求解析服务集
import { LocationServiceMap } from "@opencode/core/location-services"
// 引入 AbsolutePath：绝对路径构造类型
import { AbsolutePath } from "@opencode/core/schema"
// 引入会话（Session）：会话 ID 校验与查询
import { Session } from "@opencode/core/session"
// 引入协议层错误：位置未找到、无效请求、服务不可用
import { LocationNotFoundError, InvalidRequestError, ServiceUnavailableError } from "@opencode/protocol/errors"
// 引入 Effect、Layer（依赖注入层）与 Schema（校验）
import { Effect, Layer, Schema } from "effect"
// 引入 HTTP 请求类型
import { HttpServerRequest } from "effect/http"
// 引入 HTTP API 中间件（HttpApiMiddleware）基类
import { HttpApiMiddleware } from "effect/http-api"
// 引入会话不存在的统一错误映射
import { missingSession } from "./handlers/session-error"

// 位置中间件成功后提供的服务层类型（从 LocationServiceMap.get 的返回推导）
export type LocationServices = Layer.Success<ReturnType<(typeof LocationServiceMap.Service)["get"]>>

// LocationMiddleware：HTTP API 中间件——为每个请求提供其 Location 对应的服务集；可能以 LocationNotFoundError 失败
export class LocationMiddleware extends HttpApiMiddleware.Service<LocationMiddleware, { provides: LocationServices }>()(
  "@opencode/HttpApiLocation",
  { error: [LocationNotFoundError] },
) {}

// locationErrors：把 FileSystem.DirectoryNotFoundError（目录不存在）映射为协议层的 LocationNotFoundError
export function locationErrors<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return effect.pipe(
    Effect.catchIf(
      // 类型收窄：仅捕获目录不存在错误
      (error): error is Extract<E, FileSystem.DirectoryNotFoundError> =>
        error instanceof FileSystem.DirectoryNotFoundError,
      (error) =>
        Effect.fail(
          new LocationNotFoundError({
            // 携带出错目录
            location: { directory: error.directory },
            message: `Location not found: ${error.directory}`,
          }),
        ),
    ),
  )
}

// Temporary: managed policy is applied by the last internal plugin, and State shows each registration as soon as it is
// made, so until activation finishes a provider the policy denies is still listed and usable. Only the endpoints that
// list or use providers wait. Remove once a plugin batch becomes visible only when it ends.
export const awaitPlugins = Plugin.awaitActivation.pipe(
  Effect.timeoutOrElse({
    // 超时阈值 5 秒
    duration: "5 seconds",
    // 超时后的失败效果
    orElse: () =>
      Effect.fail(
        new ServiceUnavailableError({
          message: "Location plugins did not finish activating",
          service: "plugin",
        }),
      ),
  }),
)

// response：包装响应——附带当前请求的 location 信息（目录与项目），再执行数据效果
export function response<A, E, R>(data: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    // 从请求作用域取出位置服务
    const location = yield* Location.Service
    return {
      // 响应头部的 location 信息
      location: new Location.Info({
        directory: location.directory,
        project: location.project,
      }),
      // 数据负载
      data: yield* data,
    }
  })
}

// 会话 ID 解码器：把未知输入校验为 Session.ID
const decodeSessionID = Schema.decodeUnknownEffect(Session.ID)

// sessionInfo：解析并校验会话 ID（非法 ID -> InvalidRequestError），再获取会话信息（不存在 -> SessionNotFoundError）
export const sessionInfo = Effect.fnUntraced(function* (sessions: Session.Interface, sessionID: unknown) {
  // 先校验/解码会话 ID
  const id = yield* decodeSessionID(sessionID).pipe(
    Effect.mapError(() => new InvalidRequestError({ message: "Invalid session ID", field: "sessionID" })),
  )
  // 按解码后的 ID 获取会话；不存在统一映射
  return yield* sessions.get(id).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
})

// requestRef：从 HTTP 请求中提取位置引用（Location.Ref），用于确定服务集的缓存键
export function requestRef(request: HttpServerRequest.HttpServerRequest): Location.Ref {
  // 解析 URL 查询参数
  const query = new URL(request.url, "http://localhost").searchParams
  // 目录来源优先级：查询参数 > x-opencode-directory 头 > 进程当前目录
  const directory =
    query.get("location[directory]") ||
    (request.headers["x-opencode-directory"] ? decode(request.headers["x-opencode-directory"]) : process.cwd())
  // 构造位置引用
  return Location.Ref.make({
    directory: AbsolutePath.make(directory),
  })
}

// decode：尽力对头部值做 URI 解码；解码失败（非法编码）时原样返回
function decode(input: string) {
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

// layer：中间件的实现层——按请求解析服务集并提供给下游效果，同时统一映射位置错误
export const layer = Layer.effect(
  LocationMiddleware,
  Effect.gen(function* () {
    // 获取位置服务映射
    const locations = yield* LocationServiceMap.Service
    // 中间件逻辑：包裹下游 effect
    return LocationMiddleware.of((effect) =>
      Effect.gen(function* () {
        // 获取原始 HTTP 请求
        const request = yield* HttpServerRequest.HttpServerRequest
        // 提供该位置对应的服务集并映射位置错误
        return yield* effect.pipe(Effect.provide(locations.get(requestRef(request))), locationErrors)
      }),
    )
  }),
)
