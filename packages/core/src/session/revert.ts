// 将本模块以命名空间形式整体导出为 SessionRevert
export * as SessionRevert from "./revert.js"

// drizzle 的 SQL 构造器：and 组合、asc 升序、eq 等值、gt 大于
import { and, asc, eq, gt } from "drizzle-orm"
// effect：Effect 效果运行时
import { Effect } from "effect"
// 数据库服务
import { Database } from "../database/database.js"
// 事件总线：发布回退相关事件
import { Bus } from "../bus.js"
// 实例服务：为会话所在实例提供依赖
import { Instance } from "../instance/service.js"
// 相对路径品牌类型
import { RelativePath } from "../schema.js"
// 快照（Snapshot）服务：文件状态捕获/恢复/差异
import { Snapshot } from "../snapshot.js"
// 会话事件定义
import { SessionEvent } from "./event.js"
// 消息未找到错误
import { MessageNotFoundError } from "./error.js"
// 会话消息 ID 类型
import { SessionMessage } from "./message.js"
// 会话 Schema：Info 等类型
import { SessionSchema } from "./schema.js"
// 会话历史读取：解码消息行
import { SessionHistory } from "./history.js"
// 会话消息表
import { SessionMessageTable } from "./sql.js"

// 回退规划的输入：会话 ID 与目标边界消息 ID
interface BoundaryInput {
  readonly sessionID: SessionSchema.ID
  readonly messageID: SessionMessage.ID
}

// 暂存（stage）回退：把目标消息之后的文件改动恢复到暂存快照，并发布暂存事件
export const stage = Effect.fn("SessionRevert.stage")(function* (input: {
  session: SessionSchema.Info
  messageID: SessionMessage.ID
  files?: boolean
}) {
  // 获取实例、数据库与总线服务
  const instances = yield* Instance.Service
  const database = yield* Database.Service
  const bus = yield* Bus.Service

  return yield* Effect.gen(function* () {
    // 获取快照服务
    const snapshot = yield* Snapshot.Service
    // 已有暂存快照则复用，否则重新捕获当前状态
    const original = input.session.revert?.snapshot ?? (yield* snapshot.capture())
    // 规划边界之后要恢复的文件 → 快照映射
    const next = yield* plan(database.db, { sessionID: input.session.id, messageID: input.messageID })
    // 待恢复的文件集合：相对路径 → 快照 ID
    const restore = new Map<RelativePath, Snapshot.ID>()
    // 已有回退状态时，先恢复其登记过的文件到原快照
    if (original) {
      for (const file of input.session.revert?.files ?? []) restore.set(RelativePath.make(file.file), original)
    }
    // files !== false 时把新规划中的文件也纳入恢复
    if (input.files !== false) for (const [file, tree] of next) restore.set(file, tree)
    // 存在待恢复文件时执行恢复
    if (restore.size) yield* snapshot.restore({ files: restore })
    // files === false 时差异只看空路径集
    const paths = input.files === false ? [] : Array.from(next.keys())
    // 计算原快照与当前状态之间这些路径的差异；无原快照则为空
    const files = original
      ? yield* snapshot.diff({ from: original, to: (yield* snapshot.capture()) ?? original, paths })
      : []
    // 组装回退状态：边界消息、原快照与文件差异
    const revert = {
      messageID: input.messageID,
      snapshot: original,
      files,
    } satisfies SessionSchema.Info["revert"]
    // 发布暂存事件，交给投影层落库
    yield* bus.publish(SessionEvent.RevertEvent.Staged, {
      sessionID: input.session.id,
      revert,
    })
    // 返回暂存的回退状态
    return revert
  }).pipe(instances.provide(input.session))
})

// 清除（clear）回退：把登记过的文件恢复到暂存快照，并发布清除事件
export const clear = Effect.fn("SessionRevert.clear")(function* (session: SessionSchema.Info) {
  // 获取实例与总线服务
  const instances = yield* Instance.Service
  const bus = yield* Bus.Service
  yield* Effect.gen(function* () {
    // 获取快照服务
    const snapshot = yield* Snapshot.Service
    // 没有回退状态则无事可做
    if (!session.revert) return
    // 暂存时的原快照
    const original = session.revert.snapshot
    // 有快照时把所有登记文件恢复回去
    if (original)
      yield* snapshot.restore({
        files: new Map((session.revert.files ?? []).map((file) => [RelativePath.make(file.file), original])),
      })
    // 发布清除事件
    yield* bus.publish(SessionEvent.RevertEvent.Cleared, {
      sessionID: session.id,
    })
  }).pipe(instances.provide(session))
})

// 提交（commit）回退：仅发布提交事件，由投影层删除边界之后的数据
export const commit = Effect.fn("SessionRevert.commit")(function* (bus: Bus.Interface, session: SessionSchema.Info) {
  // 没有回退状态则无事可做
  if (!session.revert) return
  // 发布提交事件：to 为回退边界消息 ID
  yield* bus.publish(SessionEvent.RevertEvent.Committed, {
    sessionID: session.id,
    to: session.revert.messageID,
  })
})

// 规划（plan）：计算边界消息之后所有助手消息触及的文件 → 各自起始快照的映射
const plan = Effect.fn("SessionRevert.plan")(function* (db: Database.Interface["db"], input: BoundaryInput) {
  // 查询边界消息的 seq
  const boundary = yield* db
    .select({ seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.id, input.messageID)))
    .get()
    .pipe(Effect.orDie)
  // 边界消息不存在则报错
  if (!boundary) return yield* new MessageNotFoundError(input)
  // 查询边界之后的所有 assistant 消息行
  const rows = yield* db
    .select()
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, input.sessionID),
        eq(SessionMessageTable.type, "assistant"),
        gt(SessionMessageTable.seq, boundary.seq),
      ),
    )
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  // 文件 → 快照 ID 的映射
  const files = new Map<RelativePath, Snapshot.ID>()
  // 逐条消息收集其快照中的文件改动
  for (const row of rows) {
    // 解码消息行
    const message = SessionHistory.decodeMessageRowSync(row)
    // 非 assistant 或没有起始快照的消息跳过
    if (message.type !== "assistant" || !message.snapshot?.start) continue
    // 首次出现的文件登记其起始快照（早的消息优先，保持时间顺序）
    for (const file of message.snapshot.files ?? [])
      if (!files.has(file)) files.set(file, message.snapshot.start)
  }
  // 返回规划结果
  return files
})
