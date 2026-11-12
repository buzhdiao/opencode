// 将本模块整体导出为 SessionBackground 命名空间
export * as SessionBackground from "./background.js"

// 导入后台任务的种类与状态类型
import type { Kind, Status } from "@opencode/schema/job"
// 导入 effect 核心
import { Effect } from "effect"
// 导入任务系统接口类型
import type { Job } from "../job.js"
// 导入会话 schema 类型
import type { SessionSchema } from "./schema.js"

// 查询接口：按会话 ID 查询会话摘要（含父会话 ID），可能不存在
export type Lookup = {
  readonly get: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<
    { readonly parentID?: SessionSchema.ID; readonly agent?: string; readonly title?: string } | undefined
  >
}

export type OutstandingItem =
  | {
      readonly kind: "shell"
      readonly sessionID: SessionSchema.ID
      readonly shellID: string
      readonly command: string
    }
  | {
      readonly kind: "image"
      readonly sessionID: SessionSchema.ID
      readonly model: string
      readonly path: string
    }
  | {
      readonly kind: "subagent"
      readonly sessionID: SessionSchema.ID
      readonly childSessionID: SessionSchema.ID
      readonly agent: string
      readonly description: string
    }

export type ListFilter = {
  readonly sessionID?: SessionSchema.ID
  readonly kind?: Kind
  readonly status?: Status
  readonly descendants?: boolean
}

/**
 * Background jobs still running for a Session or any of its descendants. A child's own
 * background shell counts even after the child reported to its parent: its notice wakes
 * the child again, so the child's work is not finished.
 *
 * `active` adds executions that hold a claim right now, such as a subagent mid-turn
 * whose Job record already settled. Only descendants are added, and a child already
 * represented by a running background job is not repeated.
 */
// 找出某会话及其所有后代仍在运行的后台任务；子会话自己的后台 shell 也算——它的完成通知会再次唤醒子会话，因此子会话的工作尚未结束
export const outstanding = Effect.fnUntraced(function* (
  jobs: Pick<Job.Interface, "runningBackground"> & { readonly get?: Job.Interface["get"] },
  store: Lookup,
  sessionID: SessionSchema.ID,
  active?: ReadonlySet<SessionSchema.ID>,
) {
  // 父子关系缓存：会话 ID -> 父会话 ID（null 表示已查询过且无父）
  const parents = new Map<SessionSchema.ID, SessionSchema.ID | null>()
  // 取出正在运行的后台任务，过滤出归属会话（subagent 用其父会话）是给定会话或其后代的任务
  const owned = yield* Effect.filter(yield* jobs.runningBackground, (recovery) =>
    descends(store, parents, recovery.kind === "subagent" ? recovery.parentSessionID : recovery.sessionID, sessionID),
  )
  const items: OutstandingItem[] = owned.map((recovery) => {
    if (recovery.kind === "shell")
      return {
        kind: "shell" as const,
        sessionID: recovery.sessionID,
        shellID: recovery.shellID,
        command: recovery.command,
      }
    // image 任务：附带图片路径与模型
    if (recovery.kind === "image")
      return { kind: "image" as const, sessionID: recovery.sessionID, path: recovery.path, model: recovery.model }
    // subagent 任务：归属父会话，附带子会话与 agent 描述
    return {
      kind: "subagent" as const,
      sessionID: recovery.parentSessionID,
      childSessionID: recovery.childSessionID,
      agent: recovery.agent,
      description: recovery.description,
    }
  })
  if (!active || active.size === 0) return items
  const children = new Set(items.flatMap((item) => (item.kind === "subagent" ? [item.childSessionID] : [])))
  for (const activeID of active) {
    if (activeID === sessionID || children.has(activeID)) continue
    // A cancelled child may still be draining while it cleans up.
    const tracked = jobs.get ? yield* jobs.get(activeID) : undefined
    if (tracked?.status === "cancelled") continue
    if (!(yield* descends(store, parents, activeID, sessionID))) continue
    const info = yield* store.get(activeID)
    if (!info?.parentID) continue
    items.push({
      kind: "subagent",
      sessionID: info.parentID,
      childSessionID: activeID,
      agent: info.agent ?? "subagent",
      description: info.title ?? "Subagent",
    })
  }
  return items
})

/** Active and unconsumed background jobs matching the requested Session, kind, status, and descendant scope. */
// 列出符合过滤条件的活跃且未消费的后台任务（按会话、种类、状态、是否含后代）
export const list = Effect.fn("SessionBackground.list")(function* (
  jobs: Pick<Job.Interface, "backgroundJobs">,
  store: Lookup,
  filter: ListFilter = {},
) {
  // 取出全部后台任务并按种类与状态过滤
  const items = (yield* jobs.backgroundJobs).filter(
    (item) =>
      (filter.kind === undefined || item.kind === filter.kind) &&
      (filter.status === undefined || item.status === filter.status),
  )
  // 未指定会话时直接返回全部
  if (filter.sessionID === undefined) return items
  // 目标会话 ID
  const sessionID = filter.sessionID
  // 不含后代时只保留归属该会话的任务
  if (!filter.descendants) return items.filter((item) => item.sessionID === sessionID)
  // 含后代时按祖先关系过滤（带缓存）
  const parents = new Map<SessionSchema.ID, SessionSchema.ID | null>()
  return yield* Effect.filter(items, (item) => descends(store, parents, item.sessionID, sessionID))
})

// 判断 from 会话是否为 ancestor 会话本身或其后代；沿父链向上遍历，parents 缓存避免重复查询，seen 防环
const descends = Effect.fnUntraced(function* (
  store: Lookup,
  parents: Map<SessionSchema.ID, SessionSchema.ID | null>,
  from: SessionSchema.ID,
  ancestor: SessionSchema.ID,
) {
  // 已访问集合：防止父链成环导致死循环
  const seen = new Set<SessionSchema.ID>()
  // 从 from 会话开始向上走
  let current: SessionSchema.ID | undefined = from
  // 循环直到无父或回到已访问节点
  while (current !== undefined && !seen.has(current)) {
    // 命中目标祖先：是后代
    if (current === ancestor) return true
    // 标记当前节点已访问
    seen.add(current)
    // 先查缓存
    const cached = parents.get(current)
    if (cached !== undefined) {
      // 缓存命中：null 表示无父，转成 undefined 结束循环
      current = cached ?? undefined
      continue
    }
    // 查询存储获取父会话 ID
    const parentID = (yield* store.get(current))?.parentID
    // 写入缓存（null 表示无父）
    parents.set(current, parentID ?? null)
    // 继续向上
    current = parentID
  }
  // 遍历完整条父链仍未命中：不是后代
  return false
})
