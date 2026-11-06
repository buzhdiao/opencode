// 引入项目（Project）核心服务：项目列表与信息更新
import { Project } from "@opencode/core/project"
// 引入 Effect 运行时
import { Effect } from "effect"
// 引入 HTTP API 构建器
import { HttpApiBuilder } from "effect/http-api"
// 引入本服务 API 定义
import { Api } from "../api"
// 引入项目未找到错误（ProjectNotFoundError）
import { ProjectNotFoundError } from "@opencode/protocol/errors"

// 导出 ProjectHandler：注册 "server.project" 分组处理器
export const ProjectHandler = HttpApiBuilder.group(Api, "server.project", (handlers) =>
  handlers
    // 处理 project.list：按查询参数列出项目
    .handle("project.list", (ctx) => Project.Service.use((project) => project.list(ctx.query)))
    // 处理 project.update：更新项目信息
    .handle("project.update", (ctx) =>
      Project.Service.use((project) =>
        // 合并路径参数 projectID 与负载字段后执行更新
        project.update({ ...ctx.payload, projectID: ctx.params.projectID }).pipe(
          // 更新失败一律映射为“项目未找到”错误（当前实现只有未找到一种失败）
          Effect.mapError(
            () =>
              new ProjectNotFoundError({
                projectID: ctx.params.projectID,
                message: `Project not found: ${ctx.params.projectID}`,
              }),
          ),
        ),
      ),
    ),
)
