// 引入表单（Form）核心服务：管理会话内交互表单
import { Form } from "@opencode/core/form"
// 引入 Effect 运行时
import { Effect } from "effect"
// 引入 HTTP API 构建器
import { HttpApiBuilder } from "effect/http-api"
// 引入本服务 API 定义
import { Api } from "../api"
// 引入 response 辅助：在响应中附带当前 location 信息
import { response } from "../location"

// 导出 FormHandler：注册 "server.form" 分组处理器
export const FormHandler = HttpApiBuilder.group(Api, "server.form", (handlers) =>
  // 处理 form.list：列出当前（按 location 解析的）可用表单
  handlers.handle(
    "form.list",
    Effect.fn(function* () {
      // 获取表单服务
      const form = yield* Form.Service
      // 调用 list 并通过 response 包装出带 location 的响应
      return yield* response(form.list())
    }),
  ),
)
