// 引入 Shell 核心：会话内 shell 命令的执行与输出读取
import { Shell } from "@opencode/core/shell"
// 引入位置（Location）服务：当前请求的工作目录上下文
import { Location } from "@opencode/core/location"
// 引入 Effect 运行时
import { Effect } from "effect"
// 引入 HTTP API 构建器与 Schema 工具（204 响应）
import { HttpApiBuilder, HttpApiSchema } from "effect/http-api"
// 引入 shell 命令未找到错误（ShellNotFoundError）
import { ShellNotFoundError } from "@opencode/protocol/errors"
// 引入本服务 API 定义
import { Api } from "../api"
// 引入 response 辅助：响应中附带 location 信息
import { response } from "../location"

// 导出 ShellHandler：注册 "server.shell" 分组处理器
export const ShellHandler = HttpApiBuilder.group(Api, "server.shell", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle(
        // 处理 shell.list：列出可用的 shell
        "shell.list",
        Effect.fn(function* () {
          // 获取 Shell 服务
          const shell = yield* Shell.Service
          // 经 response 包装返回 shell 列表
          return yield* response(shell.list())
        }),
      )
      .handle(
        // 处理 shell.create：创建一个 shell 命令执行
        "shell.create",
        Effect.fn(function* (ctx) {
          // 获取 Shell 服务
          const shell = yield* Shell.Service
          // 获取当前请求的位置
          const location = yield* Location.Service
          return yield* response(
            // 创建执行；cwd 未指定时回退到当前位置目录；内部错误升级为缺陷（orDie）
            shell.create({ ...ctx.payload, cwd: ctx.payload.cwd || location.directory }).pipe(Effect.orDie),
          )
        }),
      )
      .handle(
        // 处理 shell.get：获取单个 shell 命令执行的详情
        "shell.get",
        Effect.fn(function* (ctx) {
          // 获取 Shell 服务
          const shell = yield* Shell.Service
          return yield* response(
            shell
              // 按查询 ID 获取详情
              .get(ctx.params.id)
              .pipe(
                Effect.catchTag(
                  // 未找到 -> ShellNotFoundError
                  "Shell.NotFoundError",
                  () =>
                    new ShellNotFoundError({ id: ctx.params.id, message: `Shell command not found: ${ctx.params.id}` }),
                ),
              ),
          )
        }),
      )
      .handle(
        // 处理 shell.output：读取 shell 命令的输出（游标分页）
        "shell.output",
        Effect.fn(function* (ctx) {
          // 获取 Shell 服务
          const shell = yield* Shell.Service
          return yield* response(
            shell
              // 读取输出：cursor 指定起始位置，limit 限制条数
              .output(ctx.params.id, { cursor: ctx.query.cursor, limit: ctx.query.limit })
              .pipe(
                Effect.catchTag(
                  // 未找到 -> ShellNotFoundError
                  "Shell.NotFoundError",
                  () =>
                    new ShellNotFoundError({ id: ctx.params.id, message: `Shell command not found: ${ctx.params.id}` }),
                ),
              ),
          )
        }),
      )
      .handle(
        // 处理 shell.remove：移除一个 shell 命令执行记录
        "shell.remove",
        Effect.fn(function* (ctx) {
          // 获取 Shell 服务
          const shell = yield* Shell.Service
          // 执行删除；不存在时静默成功（幂等删除）
          yield* shell.remove(ctx.params.id).pipe(Effect.catchTag("Shell.NotFoundError", () => Effect.void))
          // 返回 204 无内容
          return HttpApiSchema.NoContent.make()
        }),
      )
  }),
)
