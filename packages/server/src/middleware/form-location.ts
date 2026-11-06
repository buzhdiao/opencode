// 引入 Instance 服务：把会话映射到对应的 Location（实例）并提供运行环境
import { Instance } from "@opencode/core/instance/service"
// 引入 Location 服务映射：按请求引用解析出 LocationServices 依赖集
import { LocationServiceMap } from "@opencode/core/location-services"
// 引入 Session 服务：查询会话信息
import { Session } from "@opencode/core/session"
// 引入协议错误类型：非法请求、会话不存在、Location 不存在
import { LocationNotFoundError, InvalidRequestError, SessionNotFoundError } from "@opencode/protocol/errors"
// 引入 Effect 核心与 Layer（依赖注入层）
import { Effect, Layer } from "effect"
// 引入 HTTP 路由上下文、请求对象与响应构造器
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
// 引入 HttpApi 中间件基础设施
import { HttpApiMiddleware } from "effect/http-api"
// 引入共享工具：错误归一化、请求引用、会话查询与 LocationServices 类型
import { locationErrors, requestRef, sessionInfo, type LocationServices } from "../location"

// 定义表单定位中间件：为被包裹的 effect 提供 LocationServices，并声明可能的三类错误
export class FormLocationMiddleware extends HttpApiMiddleware.Service<
  FormLocationMiddleware,
  { provides: LocationServices }
>()("@opencode/HttpApiFormLocation", {
  // 声明该中间件可能失败出的错误标签
  error: [InvalidRequestError, SessionNotFoundError, LocationNotFoundError],
}) {}

// 构建表单定位中间件的 Layer
export const formLocationLayer = Layer.effect(
  // 将实现绑定到 FormLocationMiddleware Tag
  FormLocationMiddleware,
  // 构建服务实现：从环境取出所需依赖
  Effect.gen(function* () {
    // 会话服务，用于查询会话信息
    const sessions = yield* Session.Service
    // 实例服务，用于判断会话是否在线并提供环境
    const instances = yield* Instance.Service
    // Location 服务映射，用于按请求引用解析服务集
    const locations = yield* LocationServiceMap.Service

    // 返回中间件实现：包裹（effect, options）=> ...
    return FormLocationMiddleware.of((effect, options) =>
      Effect.gen(function* () {
        // 获取路由上下文以读取路径参数
        const route = yield* HttpRouter.RouteContext
        // 会话 ID 为 "global" 时走特殊分支
        if (route.params.sessionID === "global") {
          // 临时的 MCP elicitation（引导输入）逃生通道。仍然按 Location 限定范围，只是跳过会话行查询，
          // 因为部分 MCP elicitation 目前无法归属到真实会话。保持不公开文档，待其携带会话归属后移除。
          // Temporary MCP elicitation escape hatch. This is still Location-scoped; it only bypasses
          // the session row lookup because some MCP elicitations cannot currently be attributed to
          // a real session. Keep this undocumented and remove once elicitations carry session ownership.
          // 获取当前请求对象，用于推导请求所属的 Location
          const request = yield* HttpServerRequest.HttpServerRequest
          // 按请求引用解析 Location 服务集并提供给原 effect
          return yield* effect.pipe(Effect.provide(locations.get(requestRef(request))), locationErrors)
        }

        // 查询会话信息（不存在则抛 SessionNotFoundError）
        const session = yield* sessionInfo(sessions, route.params.sessionID)
        // 表单存于内存中，没有在线能力的会话不会有待处理表单。列表接口绝不能启动它的 Location：
        // 客户端会轮询整个子代理树，包括已删除的工作树。
        // Forms live in memory, so a Session without live capabilities has none pending. Listing must
        // not boot its Location: clients poll whole subagent trees, including deleted worktrees.
        // 表单列表接口且会话不在线时，直接返回空数组而不唤醒 Location
        if (options.endpoint.identifier === "session.form.list" && instances.live && !(yield* instances.live(session)))
          // 返回空列表响应
          return HttpServerResponse.jsonUnsafe({ data: [] })
        // 正常路径：为原 effect 提供该会话对应实例的运行环境
        return yield* effect.pipe(instances.provide(session), locationErrors)
      }),
    )
  }),
)
