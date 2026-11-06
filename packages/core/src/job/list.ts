// 将本模块以命名空间 JobList 整体再导出（barrel 模式）
export * as JobList from "./list.js"

// 引入作业（Job）的 schema：状态、时间等类型定义
import { Job } from "@opencode/schema/job"
// 引入 drizzle-orm 的升序（ascending）排序辅助函数
import { asc } from "drizzle-orm"
// 引入 Effect 函数式运行时核心构件：Effect、Schema（编解码）、SynchronizedRef（同步引用）
import { Effect, Schema, SynchronizedRef } from "effect"
// 仅引入类型：数据库接口
import type { Database } from "../database/database.js"
// 仅引入类型：活跃作业的运行时描述 Info
import type { Info } from "../job.js"
// 引入恢复信息类型 Recovery 及其解码 schema（描述可恢复作业的三种形态）
import { type Recovery, RecoverySchema } from "./recovery.js"
// 引入作业表（SQLite 的 job 表）的 drizzle 表定义
import { JobTable } from "./sql.js"

// 对外条目类型：直接复用 Job.Info
export type Item = Job.Info

// “活跃作业”的实时视图：内存中的作业对象，除数据库行外还带有实时状态
export type Live = {
  // 作业的实时信息（状态、起止时间、标题等）
  readonly info: Info
  // 是否已转入后台运行（后台作业即使尚未落库也应出现在列表中）
  readonly isBackgrounded: boolean
  // 可选的恢复信息（shell / subagent / image 三种之一）
  readonly recovery?: Recovery
}

// 内部辅助：把数据库行（叠加实时状态）转换为对外的 Job.Info 结构
function toItem(input: {
  // 作业 ID
  readonly id: string
  // 数据库记录的状态
  readonly status: Job.Status
  // 可选标题（可能为 null，表示未设置）
  readonly title?: string | null
  // 开始时间戳
  readonly started: number
  // 可选完成时间戳
  readonly completed?: number
  // 恢复信息（决定该作业的种类）
  readonly recovery: Recovery
}): Job.Info {
  // 把 null 标题统一为 undefined，便于后续条件展开
  const title = input.title ?? undefined
  // 组装时间字段：started 必有；completed 仅在存在时才展开进对象
  const time: Job.Time = {
    // 开始时间
    started: input.started,
    // 完成时间仅在存在时加入
    ...(input.completed !== undefined ? { completed: input.completed } : {}),
  }
  // 取出恢复信息，按其种类分发
  const recovery = input.recovery
  // shell 形态：映射为 shell 后台作业信息
  if (recovery.kind === "shell") {
    return {
      // 种类标记
      kind: "shell",
      // 作业 ID
      id: input.id,
      // 归属会话 ID
      sessionID: recovery.sessionID,
      // 状态（数据库或实时值）
      status: input.status,
      // 标题仅在存在时展开
      ...(title !== undefined ? { title } : {}),
      // 时间信息
      time,
      // shell 进程 ID
      shellID: recovery.shellID,
      // 执行的命令
      command: recovery.command,
    }
  }
  // subagent 形态：映射为子代理（subagent）作业信息
  if (recovery.kind === "subagent") {
    return {
      // 种类标记
      kind: "subagent",
      // 作业 ID
      id: input.id,
      // 会话归属：记录父会话 ID
      sessionID: recovery.parentSessionID,
      // 状态
      status: input.status,
      // 标题仅在存在时展开
      ...(title !== undefined ? { title } : {}),
      // 时间信息
      time,
      // 子会话 ID
      childSessionID: recovery.childSessionID,
      // 运行所用的 agent 名称
      agent: recovery.agent,
      // 任务描述
      description: recovery.description,
    }
  }
  // 其余（image 形态）：映射为图片生成作业信息
  return {
    // 种类标记
    kind: "image",
    // 作业 ID
    id: input.id,
    // 归属会话 ID
    sessionID: recovery.sessionID,
    // 状态
    status: input.status,
    // 标题仅在存在时展开
    ...(title !== undefined ? { title } : {}),
    // 时间信息
    time,
    // 生成图片的路径
    path: recovery.path,
    // 所用模型
    model: recovery.model,
  }
}

// 读取全部作业列表：合并数据库中的历史行与内存中的活跃作业
export function read<Entry extends Live>(
  // 数据库句柄（drizzle 实例）
  db: Database.Interface["db"],
  // 各活跃作业的同步引用（Map：作业 ID -> 实时条目）
  jobs: SynchronizedRef.SynchronizedRef<Map<string, Entry>>,
): Effect.Effect<readonly Job.Info[]> {
  // 构造恢复信息的容错解码器：解码失败返回 None 而不是抛错
  const decodeRecovery = Schema.decodeUnknownOption(RecoverySchema)
  return Effect.gen(function* () {
    // 并行取两份数据：数据库中的全部历史行 + 内存中的活跃作业快照
    const [rows, active] = yield* Effect.all([
      // 按创建时间、通知 ID 升序查询全部作业行；查询失败直接中断（orDie）
      db
        .select()
        .from(JobTable)
        .orderBy(asc(JobTable.time_created), asc(JobTable.notification_id))
        .all()
        .pipe(Effect.orDie),
      // 读取活跃作业 Map 的当前值
      SynchronizedRef.get(jobs),
    ])
    // 已被数据库行覆盖（按通知 ID 去重）的集合
    const seen = new Set<string>()
    // 最终的列表结果
    const items: Job.Info[] = []
    // 先遍历数据库行，拼出历史作业条目
    for (const row of rows) {
      // 尝试解码该行的恢复信息
      const recovery = decodeRecovery(row.recovery)
      // 解码失败（None）说明数据损坏或格式过旧，跳过该行
      if (recovery._tag === "None") continue
      // 记录该通知 ID 已由数据库覆盖
      seen.add(row.notification_id)
      // 查找该行对应的内存活跃作业
      const live = active.get(row.id)
      // 判断内存中的实时信息与数据库行是否属于同一轮生成（通知 ID 一致才可信）
      const sameGeneration = live?.info.notificationID === row.notification_id
      // 同代则用实时状态（更新鲜），否则用数据库记录的状态
      const status = sameGeneration ? live.info.status : row.status
      // 完成时间：同代用实时值；不同代时非 running 行取行更新时间，仍在运行则没有
      const completed = sameGeneration
        ? live.info.completed_at
        : row.status !== "running"
          ? row.time_updated
          : undefined
      // 组装并追加该作业条目
      items.push(
        toItem({
          // 行 ID
          id: row.id,
          // 上面计算出的状态
          status,
          // 同代且内存有标题则用实时标题，否则用数据库标题
          title: sameGeneration && live.info.title !== undefined ? live.info.title : row.title,
          // 创建时间作为开始时间
          started: row.time_created,
          // 上面计算出的完成时间
          completed,
          // 解码出的恢复信息
          recovery: recovery.value,
        }),
      )
    }
    // 再遍历内存中的活跃作业，补上尚未落库（或比数据库行更新）的后台作业
    for (const live of active.values()) {
      // 非后台作业或没有恢复信息的跳过（前者已由数据库行表达，后者无法展示）
      if (!live.isBackgrounded || !live.recovery) continue
      // 该作业的通知 ID 已被数据库行覆盖时跳过，避免重复展示
      if (live.info.notificationID && seen.has(live.info.notificationID)) continue
      // 直接用实时信息组装条目并追加
      items.push(
        toItem({
          // 实时信息中的作业 ID
          id: live.info.id,
          // 实时状态
          status: live.info.status,
          // 实时标题
          title: live.info.title,
          // 实时开始时间
          started: live.info.started_at,
          // 实时完成时间
          completed: live.info.completed_at,
          // 内存中的恢复信息
          recovery: live.recovery,
        }),
      )
    }
    // 返回合并后的完整列表
    return items
  }).pipe(Effect.withSpan("Job.backgroundJobs"))
}
