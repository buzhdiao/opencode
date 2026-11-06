// 引入位置（Location）服务：当前请求的工作目录上下文
import { Location } from "@opencode/core/location"
// 引入位置服务映射（LocationServiceMap）：管理各位置的服务实例
import { LocationServiceMap } from "@opencode/core/location-service-map"
// 引入服务不可用错误（ServiceUnavailableError）
import { ServiceUnavailableError } from "@opencode/protocol/errors"
// 引入 Cause（错误原因）与 Effect
import { Cause, Effect } from "effect"
// 引入 HTTP API 构建器
import { HttpApiBuilder } from "effect/http-api"
// 引入本服务 API 定义
import { Api } from "../api"

// 导出 LocationHandler：注册 "server.location" 分组处理器
export const LocationHandler = HttpApiBuilder.group(Api, "server.location", (handlers) =>
  Effect.gen(function* () {
    // 获取位置服务映射实例
    const locations = yield* LocationServiceMap.Service
    return handlers
      .handle(
        // 处理 location.get：返回当前请求的 location 信息（目录与所属项目）
        "location.get",
        Effect.fn(function* () {
          // 从请求作用域中取出位置服务
          const location = yield* Location.Service
          // 构造 Location.Info 响应结构
          return new Location.Info({
            directory: location.directory,
            project: location.project,
          })
        }),
      )
      // 处理 location.reload：重新加载当前 location 的服务（热重载配置）
      .handle("location.reload", () =>
        LocationServiceMap.reload().pipe(
          // 以当前映射实例提供依赖
          Effect.provideService(LocationServiceMap.Service, locations),
          // 处理重载失败的原因（Cause）
          Effect.catchCause((cause) =>
            // 纯中断（interrupt）原因原样透传，交由运行时正常处理
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(Cause.fromReasons<never>(cause.reasons.filter(Cause.isInterruptReason)))
              // 其余失败（加载异常）映射为服务不可用错误，并附上完整原因文本
              : Effect.fail(new ServiceUnavailableError({ message: Cause.pretty(cause), service: "location" })),
          ),
        ),
      )
  }),
)
