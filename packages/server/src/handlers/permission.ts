// 引入实例（Instance）服务：按位置提供实例上下文
import { Instance } from "@opencode/core/instance/service"
// 引入位置（Location）服务
import { Location } from "@opencode/core/location"
// 引入权限（Permission）核心服务：审批请求的发起与答复
import { Permission } from "@opencode/core/permission"
// 引入已保存权限（PermissionSaved）服务：持久化的权限允许规则
import { PermissionSaved } from "@opencode/core/permission/saved"
// 引入会话（Session）服务
import { Session } from "@opencode/core/session"
// 引入 Effect 运行时
import { Effect } from "effect"
// 引入 HTTP API 构建器与 Schema 工具（204 响应）
import { HttpApiBuilder, HttpApiSchema } from "effect/http-api"
// 引入本服务 API 定义
import { Api } from "../api"
// 引入协议层错误：冲突、权限请求未找到、已保存权限未找到
import { ConflictError, PermissionNotFoundError, PermissionSavedNotFoundError } from "@opencode/protocol/errors"
// 引入位置辅助：错误映射、response 包装、会话信息解析
import { locationErrors, response, sessionInfo } from "../location"
// 引入会话不存在的统一错误映射
import { missingSession } from "./session-error"

// 辅助函数：构造“权限请求未找到”错误
function missingRequest(id: Permission.ID) {
  return new PermissionNotFoundError({ requestID: id, message: `Permission request not found: ${id}` })
}

// 导出 PermissionHandler：注册 "server.permission" 分组处理器
export const PermissionHandler = HttpApiBuilder.group(Api, "server.permission", (handlers) =>
  Effect.gen(function* () {
    // 获取实例服务（为 session.permission.list 提供位置实例）
    const instances = yield* Instance.Service
    // 获取会话服务
    const sessions = yield* Session.Service
    // 辅助校验：请求必须存在且属于指定会话（防止跨会话操作他人请求）
    const requireOwnedRequest = Effect.fnUntraced(function* (
      sessionID: Permission.Request["sessionID"],
      requestID: Permission.ID,
    ) {
      // 获取权限服务
      const permission = yield* Permission.Service
      // 按请求 ID 查询权限请求
      const request = yield* permission.get(requestID)
      // 不存在或会话不匹配，都按“请求未找到”失败
      if (!request || request.sessionID !== sessionID) return yield* missingRequest(requestID)
      // 返回服务实例与请求记录供后续使用
      return { permission, request }
    })

    return handlers
      .handle(
        // 处理 permission.request.list：列出当前待审批的权限请求
        "permission.request.list",
        Effect.fn(function* () {
          // 获取权限服务
          const permission = yield* Permission.Service
          // 经 response 包装返回请求列表
          return yield* response(permission.list())
        }),
      )
      .handle(
        // 处理 session.permission.create：在会话中主动发起一次权限询问（ask）
        "session.permission.create",
        Effect.fn(function* (ctx) {
          // 获取权限服务
          const permission = yield* Permission.Service
          return {
            // 发起询问：ID、动作、资源、保存选项、元数据、来源与代理；会话不存在统一映射
            data: yield* permission
              .ask({
                id: ctx.payload.id,
                sessionID: ctx.params.sessionID,
                action: ctx.payload.action,
                resources: ctx.payload.resources,
                save: ctx.payload.save,
                metadata: ctx.payload.metadata,
                source: ctx.payload.source,
                agent: ctx.payload.agent,
              })
              .pipe(Effect.catchTag("Session.NotFoundError", missingSession)),
          }
        }),
      )
      .handle(
        // 处理 session.permission.list：列出某会话的权限请求
        "session.permission.list",
        Effect.fn(function* (ctx) {
          // 先解析并校验会话（非法 ID/不存在会话会失败）
          const session = yield* sessionInfo(sessions, ctx.params.sessionID)
          // 在该会话所属实例的作用域中查询其权限请求
          const requests = yield* Permission.Service.use((permission) =>
            permission.forSession(ctx.params.sessionID),
          ).pipe(instances.provide(session), locationErrors)
          // 返回请求列表
          return { data: requests }
        }),
      )
      .handle(
        // 处理 session.permission.get：获取单个权限请求详情
        "session.permission.get",
        Effect.fn(function* (ctx) {
          // 校验请求归属该会话
          const owned = yield* requireOwnedRequest(ctx.params.sessionID, ctx.params.requestID)
          // 返回请求详情
          return { data: owned.request }
        }),
      )
      .handle(
        // 处理 session.permission.reply：答复（允许/拒绝）权限请求
        "session.permission.reply",
        Effect.fn(function* (ctx) {
          // 校验请求归属该会话
          const owned = yield* requireOwnedRequest(ctx.params.sessionID, ctx.params.requestID)
          // 提交答复（决定与可选说明）；请求已被删除等未找到情况统一映射
          yield* owned.permission
            .reply({ requestID: ctx.params.requestID, reply: ctx.payload.decision, message: ctx.payload.message })
            .pipe(Effect.catchTag("Permission.NotFoundError", () => missingRequest(ctx.params.requestID)))
          // 返回 204 无内容
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        // 处理 permission.saved.list：列出已保存的权限允许规则
        "permission.saved.list",
        Effect.fn(function* (ctx) {
          // 获取当前请求的位置（用于默认项目 ID）
          const location = yield* Location.Service
          // 获取已保存权限服务
          const saved = yield* PermissionSaved.Service
          return {
            // 查询指定项目（未传则用当前项目）的保存规则
            data: yield* saved.list({
              projectID: ctx.query.projectID ?? location.project.id,
            }),
          }
        }),
      )
      .handle(
        // 处理 permission.saved.update：更新（新增）一条保存的权限规则
        "permission.saved.update",
        Effect.fn(function* (ctx) {
          // 获取已保存权限服务
          const saved = yield* PermissionSaved.Service
          return {
            // 更新规则的 ID、动作与资源；未找到/冲突分别映射为协议错误
            data: yield* saved
              .update({ id: ctx.params.id, action: ctx.payload.action, resource: ctx.payload.resource })
              .pipe(
                Effect.catchTags({
                  // 规则不存在 -> PermissionSavedNotFoundError
                  "PermissionSaved.NotFoundError": (error) =>
                    new PermissionSavedNotFoundError({
                      id: error.id,
                      message: `Saved permission not found: ${error.id}`,
                    }),
                  // 与现有规则冲突（已存在同动作/资源的允许）-> ConflictError
                  "PermissionSaved.ConflictError": (error) =>
                    new ConflictError({
                      resource: error.id,
                      message: `A saved permission already allows ${error.action} for ${error.resource}`,
                    }),
                }),
              ),
          }
        }),
      )
      .handle(
        // 处理 permission.saved.remove：删除一条保存的权限规则
        "permission.saved.remove",
        Effect.fn(function* (ctx) {
          // 获取已保存权限服务
          const saved = yield* PermissionSaved.Service
          // 执行删除
          yield* saved.remove(ctx.params.id)
          // 返回 204 无内容
          return HttpApiSchema.NoContent.make()
        }),
      )
  }),
)
