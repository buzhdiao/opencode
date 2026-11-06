// 引入 Instance 服务：把会话映射到对应的 Location（实例）并提供运行环境
import { Instance } from "@opencode/core/instance/service"
// 引入 Session 服务：查询会话信息
import { Session } from "@opencode/core/session"
// 引入 Effect 核心与 Layer（依赖注入层）
import { Effect, Layer } from "effect"
// 引入 HTTP 路由上下文
import { HttpRouter } from "effect/http"
// 引入 HttpApi 中间件基础设施
import { HttpApiMiddleware } from "effect/http-api"
// 引入协议错误类型：非法请求、会话不存在、Location 不存在
import { LocationNotFoundError, InvalidRequestError, SessionNotFoundError } from "@opencode/protocol/errors"
// 引入共享工具：错误归一化、会话查询与 LocationServices 类型
import { locationErrors, sessionInfo, type LocationServices } from "../location"

// 定义会话定位中间件：为被包裹的 effect 提供该会话所属 Location 的服务集，并声明可能的三类错误
export class SessionLocationMiddleware extends HttpApiMiddleware.Service<
  SessionLocationMiddleware,
  { provides: LocationServices }
>()("@opencode/HttpApiSessionLocation", {
  // 声明该中间件可能失败出的错误标签
  error: [InvalidRequestError, SessionNotFoundError, LocationNotFoundError],
}) {}

// 构建会话定位中间件的 Layer
export const sessionLocationLayer = Layer.effect(
  // 将实现绑定到 SessionLocationMiddleware Tag
  SessionLocationMiddleware,
  // 构建服务实现：从环境取出所需依赖
  Effect.gen(function* () {
    // 会话服务，用于查询会话信息
    const sessions = yield* Session.Service
    // 实例服务，用于提供会话对应的运行环境
    const instances = yield* Instance.Service

    // 返回中间件实现：包裹 effect => ...
    return SessionLocationMiddleware.of((effect) =>
      Effect.gen(function* () {
        // 获取路由上下文以读取路径参数中的会话 ID
        const route = yield* HttpRouter.RouteContext
        // 查询会话信息（不存在则抛 SessionNotFoundError）
        const session = yield* sessionInfo(sessions, route.params.sessionID)
        // 为原 effect 提供该会话对应实例的运行环境，并归一化 Location 相关错误
        return yield* effect.pipe(instances.provide(session), locationErrors)
      }),
    )
  }),
)
