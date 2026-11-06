// 引入权限（Permission）服务：非受控（unattended）询问上下文
import { Permission } from "@opencode/core/permission"
// 引入计划任务（Schedule）核心服务
import { Schedule } from "@opencode/core/schedule"
// 引入会话类型（仅类型）
import type { Session } from "@opencode/core/session"
// 引入协议层错误：禁止访问、无效请求、计划任务未找到
import { ForbiddenError, InvalidRequestError, ScheduleNotFoundError } from "@opencode/protocol/errors"
// 引入创建计划任务的负载类型（CreatePayload）
import type { CreatePayload } from "@opencode/protocol/groups/schedule"
// 引入 Effect 运行时
import { Effect } from "effect"
// 引入 Schema 工具（204 响应）
import { HttpApiSchema } from "effect/http-api"
// 引入会话不存在的统一错误映射
import { missingSession } from "./session-error"

/** `schedule.*` in the `server.experimental` group. Every route needs experimental.schedules where the Session lives. */
/** 构造 `server.experimental` 分组下的 `schedule.*` 处理器集合；每个路由都要求会话所在位置开启 experimental.schedules */
export const makeSchedule = Effect.gen(function* () {
  // 获取计划任务服务
  const schedules = yield* Schedule.Service

  // allowed：校验指定会话允许创建计划任务（会话存在且该位置开启了开关）
  const allowed = (sessionID: Session.ID) =>
    schedules.enabled(sessionID).pipe(
      // 会话不存在 -> 会话未找到错误
      Effect.mapError(missingSession),
      // 开关关闭 -> 禁止访问（403）
      Effect.flatMap((enabled) => (enabled ? Effect.void : Effect.fail(disabled()))),
    )

  // A schedule whose Session is gone, or whose location has the flag off, reads as missing or forbidden like the rest.
  // find：按 ID 查找计划任务；其会话已消失或位置开关关闭时，与其他路由一致地表现为“未找到/禁止”
  const find = (id: Schedule.ID) =>
    Effect.gen(function* () {
      // 查询计划任务信息；不存在映射为 ScheduleNotFoundError
      const info = yield* schedules.get(id).pipe(Effect.mapError(missingSchedule))
      // 无所属会话视为未找到
      if (info.sessionID === undefined) return yield* missingSchedule({ scheduleID: id })
      // 校验会话仍允许计划任务；会话已删除时同样映射为“未找到”
      yield* allowed(info.sessionID).pipe(
        Effect.catchTag("SessionNotFoundError", () => Effect.fail(missingSchedule({ scheduleID: id }))),
      )
      // 返回任务信息
      return info
    })

  return {
    // create：创建计划任务
    create: (payload: CreatePayload) =>
      // Stateless HTTP callers have no guaranteed UI listener to answer an interactive ask, so settle asks unattended.
      // 无状态 HTTP 调用方没有保证在线的 UI 来回答交互式询问，因此以“非受控”（unattended）方式自动处理权限询问
      schedules.create(Schedule.toCreateInput(payload.sessionID, payload)).pipe(
        // 提供空的非受控上下文：任何权限询问都按空规则处理
        Effect.provideService(Permission.Unattended, []),
        // 成功时包一层 data 字段
        Effect.map((data) => ({ data })),
        Effect.catchTags({
          // 任务定义非法 -> InvalidRequestError
          "Schedule.InvalidError": (error) =>
            Effect.fail(new InvalidRequestError({ message: error.message, kind: "schedule" })),
          // 位置未开启计划任务 -> 403
          "Schedule.DisabledError": () => Effect.fail(disabled()),
          // 非受控权限被阻断 -> 403
          "Permission.BlockedError": (error) => Effect.fail(new ForbiddenError({ message: error.message })),
          // 非受控权限被纠正（反馈） -> 403（使用反馈文本）
          "Permission.CorrectedError": (error) => Effect.fail(new ForbiddenError({ message: error.feedback })),
          // 会话不存在 -> 会话未找到错误
          "Session.NotFoundError": (error) => Effect.fail(missingSession(error)),
        }),
      ),
    // list：列出指定会话的计划任务
    list: (sessionID: Session.ID) =>
      allowed(sessionID).pipe(
        // 校验通过后查询列表
        Effect.andThen(schedules.list({ sessionID })),
        // 包一层 data 字段
        Effect.map((data) => ({ data })),
      ),
    // get：读取单个计划任务
    get: (id: Schedule.ID) => find(id).pipe(Effect.map((data) => ({ data }))),
    // pause：暂停计划任务
    pause: (id: Schedule.ID) =>
      find(id).pipe(
        // 校验通过后执行暂停；不存在映射为未找到
        Effect.andThen(schedules.pause(id).pipe(Effect.mapError(missingSchedule))),
        // 包一层 data 字段
        Effect.map((data) => ({ data })),
      ),
    // resume：恢复计划任务
    resume: (id: Schedule.ID) =>
      find(id).pipe(
        // 校验通过后执行恢复；不存在映射为未找到
        Effect.andThen(schedules.resume(id).pipe(Effect.mapError(missingSchedule))),
        // 包一层 data 字段
        Effect.map((data) => ({ data })),
      ),
    // remove：删除计划任务
    remove: (id: Schedule.ID) =>
      find(id).pipe(
        // 校验通过后执行删除；不存在映射为未找到
        Effect.andThen(schedules.remove(id).pipe(Effect.mapError(missingSchedule))),
        // 返回 204 无内容
        Effect.as(HttpApiSchema.NoContent.make()),
      ),
  }
})

// 辅助函数：构造“计划任务未找到”错误
function missingSchedule(error: { readonly scheduleID: Schedule.ID }) {
  return new ScheduleNotFoundError({ scheduleID: error.scheduleID, message: `Schedule not found: ${error.scheduleID}` })
}

// 辅助函数：构造“计划任务被禁用”的禁止访问错误（复用 DisabledError 的消息文案）
function disabled() {
  return new ForbiddenError({ message: new Schedule.DisabledError().message })
}
