// 引入作业（Job）核心服务：后台任务记录
import { Job } from "@opencode/core/job"
// 引入会话（Session）服务与 ID 类型
import { Session } from "@opencode/core/session"
// 引入会话后台工具（SessionBackground）：列出后台会话任务
import { SessionBackground } from "@opencode/core/session/background"
// 引入列表查询参数类型（ListQuery）
import type { ListQuery } from "@opencode/protocol/groups/job"
// 引入 Effect 与 Option（可选值工具）
import { Effect, Option } from "effect"
// 引入会话不存在的统一错误映射
import { missingSession } from "./session-error"

/** `job.*` in the `server.experimental` group. */
/** 构造 `server.experimental` 分组下的 `job.*` 处理器集合 */
export const makeJob = Effect.gen(function* () {
  // 获取作业服务
  const jobs = yield* Job.Service
  // 获取会话服务
  const sessions = yield* Session.Service
  // 构造会话查询器：按会话 ID 获取会话；不存在时返回 undefined（而不是失败）
  const lookup = {
    get: (sessionID: Session.ID) => sessions.get(sessionID).pipe(Effect.option, Effect.map(Option.getOrUndefined)),
  }

  return {
    // list 处理器：列出后台作业
    list: Effect.fn("JobHandler.list")(function* (query: ListQuery) {
      // 若查询指定了会话 ID，先确认该会话存在（不存在则返回会话未找到错误）
      if (query.sessionID !== undefined) {
        yield* sessions.get(query.sessionID).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
      }
      // 委托 SessionBackground.list 执行实际列表逻辑
      return {
        data: yield* SessionBackground.list(jobs, lookup, query),
      }
    }),
  }
})
