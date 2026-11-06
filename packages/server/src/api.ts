// 协议包提供的默认 API 工厂
import { makeDefaultApi } from "@opencode/protocol/api"
// Location 中间件：按 Location 解析请求归属
import { LocationMiddleware } from "./location"
// 表单接口的 Location 中间件
import { FormLocationMiddleware } from "./middleware/form-location"
// 会话接口的 Location 中间件
import { SessionLocationMiddleware } from "./middleware/session-location"

// 构建 API 实例：注入三类路由中间件
export const Api = makeDefaultApi({
  // 通用 Location 中间件
  locationMiddleware: LocationMiddleware,
  // FormLocationMiddleware contains the temporary `sessionID === "global"` MCP elicitation hack.
  // Do not use that sentinel with general session APIs.
  // 表单中间件包含 `sessionID === "global"` 的 MCP elicitation 临时技巧，
  // 不要在通用会话 API 中使用该哨兵值
  formLocationMiddleware: FormLocationMiddleware,
  // 会话接口中间件
  sessionLocationMiddleware: SessionLocationMiddleware,
})
