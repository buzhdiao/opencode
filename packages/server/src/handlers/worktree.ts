// 引入 Git 工具：区分需要 force 的 git 工作树错误
import { Git } from "@opencode/core/git"
// 引入工作树（Worktree）核心服务与错误类型
import { Worktree } from "@opencode/core/worktree"
// 引入项目（Project）服务错误
import { Project } from "@opencode/core/project"
// 引入项目未找到错误（ProjectNotFoundError）
import { ProjectNotFoundError } from "@opencode/protocol/errors"
// 引入工作树错误响应类型（协议分组定义）
import { WorktreeError } from "@opencode/protocol/groups/worktree"
// 引入 Effect 运行时
import { Effect } from "effect"
// 引入 HTTP API 构建器与 Schema 工具（204 响应）
import { HttpApiBuilder, HttpApiSchema } from "effect/http-api"
// 引入本服务 API 定义
import { Api } from "../api"

// 导出 WorktreeHandler：注册 "server.worktree" 分组处理器
export const WorktreeHandler = HttpApiBuilder.group(Api, "server.worktree", (handlers) =>
  Effect.gen(function* () {
    // 获取工作树服务
    const worktrees = yield* Worktree.Service
    return handlers
      // 处理 worktree.list：按查询参数列出项目的工作树
      .handle("worktree.list", (ctx) =>
        worktrees.list(ctx.query).pipe(Effect.catchTag("Project.NotFoundError", missingProject)),
      )
      // 处理 worktree.create：创建新工作树
      .handle("worktree.create", (ctx) => worktrees.create(ctx.payload).pipe(badRequest))
      // 处理 worktree.remove：移除工作树
      .handle("worktree.remove", (ctx) =>
        worktrees.remove(ctx.payload).pipe(badRequest, Effect.as(HttpApiSchema.NoContent.make())),
      )
      // 处理 worktree.refresh：刷新工作树状态
      .handle("worktree.refresh", (ctx) =>
        worktrees.refresh(ctx.payload).pipe(badRequest, Effect.as(HttpApiSchema.NoContent.make())),
      )
  }),
)

// badRequest：把工作树服务的错误统一映射为协议层错误：项目未找到 -> ProjectNotFoundError，其余 -> WorktreeError（附错误消息与是否需要 force）
function badRequest<A, R>(effect: Effect.Effect<A, Worktree.Error, R>) {
  return effect.pipe(
    Effect.mapError((error) =>
      error._tag === "Project.NotFoundError"
        ? missingProject(error)
        : new WorktreeError({
            name: "WorktreeError",
            data: {
              message: message(error),
              // 仅 git 工作树错误或操作错误才可能要求 force
              forceRequired:
                error instanceof Git.WorktreeError || error instanceof Worktree.OperationError
                  ? error.forceRequired
                  : undefined,
            },
          }),
    ),
  )
}

// missingProject：构造“项目未找到”错误
function missingProject(error: Project.NotFoundError) {
  return new ProjectNotFoundError({ projectID: error.projectID, message: `Project not found: ${error.projectID}` })
}

// message：把各类工作树错误转换为人类可读的错误文案
function message(error: Exclude<Worktree.Error, Project.NotFoundError>) {
  // 源目录未找到：区分“传了目录但不是可用检出”与“未找到工作树源”两种文案
  if (error instanceof Worktree.SourceDirectoryNotFoundError)
    return error.directory
      ? `Cannot create a worktree from ${error.directory}: it is not a checkout of this project that supports worktrees, such as a git repository`
      : `Worktree source not found for project: ${error.projectID}`
  // 目标目录已存在
  if (error instanceof Worktree.DestinationExistsError) return `Worktree destination already exists: ${error.directory}`
  // 目录不可用
  if (error instanceof Worktree.DirectoryUnavailableError) return `Worktree directory unavailable: ${error.directory}`
  // 目录非法
  if (error instanceof Worktree.InvalidDirectoryError) return `Invalid worktree directory: ${error.directory}`
  // 策略（strategy）不可用
  if (error instanceof Worktree.StrategyUnavailableError) return `Worktree strategy unavailable: ${error.strategy}`
  // 其余错误直接使用其自带消息
  return error.message
}
