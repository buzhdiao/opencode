// 引入引用（Reference）核心服务：代码引用/搜索相关能力
import { Reference } from "@opencode/core/reference"
// 引入 HTTP API 构建器
import { HttpApiBuilder } from "effect/http-api"
// 引入本服务 API 定义
import { Api } from "../api"
// 引入 response 辅助：响应中附带 location 信息
import { response } from "../location"

// 导出 ReferenceHandler：注册 "server.reference" 分组处理器
export const ReferenceHandler = HttpApiBuilder.group(Api, "server.reference", (handlers) =>
  // 处理 reference.list：在插件服务上下文中列出引用；响应附带 location 信息
  handlers.handle("reference.list", () => response(Reference.Service.use((reference) => reference.list()))),
)
