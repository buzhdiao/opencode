// 引入版本控制（Vcs）核心服务：git 等版本控制操作
import { Vcs } from "@opencode/core/vcs"
// 引入项目（Project）服务：解析项目信息
import { Project } from "@opencode/core/project"
// 引入工作树（Worktree）：仅用于其事件定义
import { Worktree } from "@opencode/core/worktree"
// 引入总线（Bus）：发布领域事件
import { Bus } from "@opencode/core/bus"
import { Location } from "@opencode/core/location"
// 引入位置服务映射：初始化后失效缓存
import { LocationServiceMap } from "@opencode/core/location-services"
// 引入协议层错误：冲突、无效请求、服务不可用
import { ConflictError, InvalidRequestError, ServiceUnavailableError } from "@opencode/protocol/errors"
// 引入“VCS 初始化不支持”错误类型（协议分组定义）
import { VcsInitNotSupportedError } from "@opencode/protocol/groups/vcs"
// 引入 Effect 运行时
import { Effect } from "effect"
// 引入 HTTP API 构建器与 Schema 工具（204 响应）
import { HttpApiBuilder, HttpApiSchema } from "effect/http-api"
// 引入本服务 API 定义
import { Api } from "../api"
// 引入 response 辅助：响应中附带 location 信息
import { response } from "../location"

// 导出 VcsHandler：注册 "server.vcs" 分组处理器
export const VcsHandler = HttpApiBuilder.group(Api, "server.vcs", (handlers) =>
  Effect.gen(function* () {
    // 获取项目服务（初始化后解析项目）
    const project = yield* Project.Service
    // 获取事件总线（初始化成功后广播工作树更新）
    const bus = yield* Bus.Service
    // 获取位置服务映射（初始化后失效缓存）
    const locations = yield* LocationServiceMap.Service
    return handlers
      // 处理 vcs.init：在项目目录初始化版本控制（默认 git）
      .handle("vcs.init", (ctx) =>
        Effect.gen(function* () {
          // 获取当前请求的位置
          const location = yield* Location.Service
          // 以项目目录为初始化目标
          const directory = location.project.directory
          // 提供商默认为 git（可由查询参数指定）
          const providerID = ctx.query.provider ?? "git"
          const vcs = yield* Vcs.Service
          // 执行初始化；按错误类别分别映射为协议错误
          yield* vcs.initialize(providerID).pipe(
            Effect.mapError((error) => {
              // 目录缺失 -> InvalidRequestError（标注 location 字段）
              if (error.kind === "missing")
                return new InvalidRequestError({ message: "Project directory does not exist", field: "location" })
              // 已有版本控制 -> ConflictError
              if (error.kind === "conflict")
                return new ConflictError({ message: "Project already has version control", resource: directory })
              // 未知提供商 -> InvalidRequestError（标注 provider 字段）
              if (error.kind === "unknown")
                return new InvalidRequestError({
                  message: "Unknown VCS provider",
                  field: "provider",
                })
              // 提供商不支持初始化 -> VcsInitNotSupportedError
              if (error.kind === "unsupported")
                return new VcsInitNotSupportedError({
                  providerID,
                  message: "VCS provider does not support initialization",
                })
              // 其余初始化失败 -> ServiceUnavailableError
              return new ServiceUnavailableError({ service: providerID, message: "VCS initialization failed" })
            }),
          )
          // 初始化后重新解析项目，确认 VCS 状态已生效
          const resolved = yield* project.resolve(directory)
          // 状态未生效视为初始化失败
          if (!resolved.vcs)
            return yield* new ServiceUnavailableError({ service: providerID, message: "VCS initialization failed" })
          // 失效该位置的缓存服务（VCS 可用性会影响各服务行为）
          yield* locations.invalidate(
            Location.Ref.make({ directory: location.directory, workspaceID: location.workspaceID }),
          )
          // 广播工作树更新事件（携带项目 ID）
          yield* bus.publish(Worktree.Event.Updated, { projectID: resolved.id })
          // 返回 204 无内容
          return HttpApiSchema.NoContent.make()
        }),
      )
      // 处理 vcs.get：获取当前 VCS 信息（提供商、状态等）
      .handle("vcs.get", () =>
        response(
          Effect.gen(function* () {
            // 获取 VCS 服务
            const vcs = yield* Vcs.Service
            // 读取信息
            return yield* vcs.info()
          }),
        ),
      )
      // 处理 vcs.base：获取基准提交/分支（用于 diff）
      .handle("vcs.base", () =>
        response(
          Effect.gen(function* () {
            // 获取 VCS 服务
            const vcs = yield* Vcs.Service
            return yield* vcs
              // 读取基准；失败映射为服务不可用
              .base()
              .pipe(Effect.mapError((error) => new ServiceUnavailableError({ service: "vcs", message: error.message })))
          }),
        ),
      )
      // 处理 vcs.status：获取工作区状态（改动文件等）
      .handle("vcs.status", () =>
        response(
          Effect.gen(function* () {
            // 获取 VCS 服务
            const vcs = yield* Vcs.Service
            // 读取状态
            return yield* vcs.status()
          }),
        ),
      )
      // 处理 vcs.branch.list：列出分支（支持搜索，条数上限 100）
      .handle("vcs.branch.list", (ctx) =>
        response(
          Effect.gen(function* () {
            // 获取 VCS 服务
            const vcs = yield* Vcs.Service
            // 查询分支：limit 默认 50 且最大不超过 100
            return yield* vcs.branches({ search: ctx.query.search, limit: Math.min(ctx.query.limit ?? 50, 100) })
          }),
        ),
      )
      // 处理 vcs.diff：计算差异（模式、上下文行数、基准、是否含未跟踪文件）
      .handle("vcs.diff", (ctx) =>
        response(
          Effect.gen(function* () {
            // 获取 VCS 服务
            const vcs = yield* Vcs.Service
            return yield* vcs
              // 按模式计算 diff 并透传可选参数
              .diff(ctx.query.mode, {
                context: ctx.query.context,
                base: ctx.query.base,
                untracked: ctx.query.untracked,
              })
              // 失败映射为服务不可用
              .pipe(Effect.mapError((error) => new ServiceUnavailableError({ service: "vcs", message: error.message })))
          }),
        ),
      )
  }),
)
