// 把本模块以命名空间形式整体导出为 V1Migration，供其他模块按 V1Migration.xxx 引用
export * as V1Migration from "./v1-migration.js"

// 导入 effect 核心构件：Cause（错误原因）、Effect（效果运行时）、Fiber（纤程）、
// Layer（服务层）、Option（可选值）、Schema（数据校验）、Semaphore（信号量）
import { Cause, Effect, Fiber, Layer, Option, Schema, Semaphore } from "effect"
// 导入 Database 服务：操作数据库的统一入口
import { Database } from "./database.js"
// 导入 storedAbsolutePath：把路径解析为存储格式的绝对路径
import { storedAbsolutePath } from "./path.js"
// 导入会话（session）与消息（message）的 drizzle 表定义
import { SessionMessageTable, SessionTable } from "../session/sql.js"
// 导入 SessionV1 schema：V1 会话数据的校验模型
import { SessionV1 } from "@opencode/schema/session-v1"
// 导入 SessionMessage：V2 会话消息的类型与 ID 构造器
import { SessionMessage } from "../session/message.js"
// 导入 SessionSchema：会话 ID 等基础 schema
import { SessionSchema } from "../session/schema.js"
// 导入 KVTable：键值（key-value）存储表定义
import { KVTable } from "../kv/sql.js"
// 导入 EventSequenceTable：事件序号（sequence）表定义
import { EventSequenceTable } from "../event/sql.js"
// 导入 drizzle 操作符：eq（等值比较）与 sql（SQL 片段模板）
import { eq, sql } from "drizzle-orm"
// 导入 Global 服务：读取全局数据目录等信息
import { Global } from "@opencode/util/global"
// 导入 FSUtil：文件系统工具服务（realPath、isDir 等）
import { FSUtil } from "@opencode/util/fs-util"
// 导入 existsSync：同步判断文件是否存在
import { existsSync } from "node:fs"
// 导入 path 模块：处理文件路径
import path from "node:path"
// 仅导入类型：bun:sqlite 的 Database（SQLite 连接）类型
import type { Database as SQLiteDatabase } from "bun:sqlite"
// 导入 Agent schema：代理（agent）标识的构造器
import { Agent } from "@opencode/schema/agent"
// 导入 Project 服务与类型：项目（project）解析与标识
import { Project } from "../project.js"
// 导入 AbsolutePath：绝对路径品牌（brand）类型
import { AbsolutePath } from "../schema.js"
// 导入 ProjectTable：项目表的 drizzle 定义
import { ProjectTable } from "../project/sql.js"

// SourceMessage：从 V1 库读出的原始消息行结构
export type SourceMessage = {
  // 消息唯一标识
  readonly id: string
  // 所属会话标识
  readonly session_id: string
  // 创建时间（毫秒时间戳）
  readonly time_created: number
  // 更新时间（毫秒时间戳）
  readonly time_updated: number
  // 原始 JSON 数据文本
  readonly data: string
}

// SourcePart：从 V1 库读出的原始分片（part）行结构
export type SourcePart = {
  // 分片唯一标识
  readonly id: string
  // 所属消息标识
  readonly message_id: string
  // 所属会话标识
  readonly session_id: string
  // 创建时间（毫秒时间戳）
  readonly time_created: number
  // 更新时间（毫秒时间戳）
  readonly time_updated: number
  // 原始 JSON 数据文本
  readonly data: string
}

// TransformInput：转换单个会话时所需的输入——会话行、消息行与分片行
export type TransformInput = {
  // V1 会话表的整行数据（drizzle 推断的查询结果类型）
  readonly session: typeof SessionTable.$inferSelect
  // 该会话的全部原始消息
  readonly messages: ReadonlyArray<SourceMessage>
  // 该会话的全部原始分片
  readonly parts: ReadonlyArray<SourcePart>
}

// Warning：迁移过程中的告警——说明哪条数据被跳过及其原因
export type Warning = {
  // 跳过原因（如 invalid-message、orphan-part）
  readonly reason: string
  // 相关会话标识
  readonly sessionID: string
  // 可选：相关消息标识
  readonly messageID?: string
  // 可选：相关分片标识
  readonly partID?: string
  // 可选：数据被识别出的实际类型（便于排查）
  readonly observedType?: string
}

// TransformResult：单个会话的转换结果——目标消息列表、会话级统计、
// 水位线（watermark）与告警列表
export type TransformResult = {
  // 转换后的消息列表：每条带序号（seq）与 JSON 数据
  readonly messages: ReadonlyArray<{
    // 消息唯一标识
    readonly id: string
    // 所属会话标识
    readonly session_id: string
    // 消息类型（user/assistant/compaction 等）
    readonly type: SessionMessage.Type
    // 消息在会话内的顺序号
    readonly seq: number
    // 创建时间（毫秒时间戳）
    readonly time_created: number
    // 更新时间（毫秒时间戳）
    readonly time_updated: number
    // 消息的 JSON 内容对象
    readonly data: Record<string, unknown>
  }>
  // 需要回写到会话表的部分字段（agent/model/用量统计/撤销标记等）
  readonly session: Pick<
    typeof SessionTable.$inferInsert,
    | "agent"
    | "model"
    | "cost"
    | "tokens_input"
    | "tokens_output"
    | "tokens_reasoning"
    | "tokens_cache_read"
    | "tokens_cache_write"
    | "revert"
    | "time_compacting"
  >
  // watermark：本会话事件流的最高序号（用于初始化事件序列表）
  readonly watermark: number
  // 转换过程中产生的告警
  readonly warnings: ReadonlyArray<Warning>
}

// Progress：迁移进度描述——标签加可选的分子/分母
type Progress = {
  // 进度标签（如 "Migrating sessions"）
  readonly label: string
  // 已完成数量
  readonly numerator?: number
  // 总数量
  readonly denominator?: number
}

// Status：对外暴露的迁移状态——需要迁移/已完成/进行中/出错
export type Status =
  | { readonly status: "required" | "completed" }
  | { readonly status: "running"; readonly progress: Progress }
  | { readonly status: "error"; readonly error: string }

// RunResult：run() 的返回值——固定为已完成
type RunResult = {
  readonly status: "completed"
}

// Options：run() 的可选项——可显式指定下一代（next）数据库路径
type Options = {
  readonly nextDatabasePath?: string
}

// MigrationState：记录在 kv 表中的迁移状态——正在迁移会话（含游标）或已完成
type MigrationState = { readonly phase: "sessions"; readonly cursor?: string } | { readonly phase: "completed" }

// RuntimeState：进程内的迁移运行状态——空闲/进行中/出错
type RuntimeState =
  | { readonly status: "idle" }
  | { readonly status: "running"; readonly progress: Progress }
  | { readonly status: "error"; readonly error: string }

// NextProject：opencode-next.db（V2 数据库）中 project 表的行结构
type NextProject = {
  readonly id: string
  readonly worktree: string
  readonly vcs: string | null
  readonly name: string | null
  readonly icon_url: string | null
  readonly icon_url_override: string | null
  readonly icon_color: string | null
  readonly time_created: number
  readonly time_updated: number
  readonly time_initialized: number | null
  readonly sandboxes: string
  readonly commands: string | null
}

// NextColumns：描述目标表各列的导入策略——必需/可空/带回退列
type NextColumns<A> = Record<keyof A, "required" | "nullable" | { readonly fallback: keyof A & string }>

// NEXT_PROJECT_COLUMNS：project 表各列的导入策略清单
const NEXT_PROJECT_COLUMNS = {
  // 主键，必需
  id: "required",
  // 工作树路径，必需
  worktree: "required",
  // 版本控制系统类型，可空
  vcs: "nullable",
  // 项目名称，可空
  name: "nullable",
  // 图标地址，可空
  icon_url: "nullable",
  // 覆盖图标地址：缺失时回退（fallback）到 icon_url 列
  icon_url_override: { fallback: "icon_url" },
  // 图标颜色，可空
  icon_color: "nullable",
  // 创建时间，必需
  time_created: "required",
  // 更新时间，必需
  time_updated: "required",
  // 初始化时间，可空
  time_initialized: "nullable",
  // 沙箱配置 JSON，必需
  sandboxes: "required",
  // 命令配置 JSON，可空
  commands: "nullable",
} satisfies NextColumns<NextProject>

// NextSession：opencode-next.db 中 session 表的行结构
type NextSession = {
  readonly id: string
  readonly project_id: string
  readonly workspace_id: string | null
  readonly parent_id: string | null
  readonly fork_session_id: string | null
  readonly fork_boundary: string | null
  readonly slug: string
  readonly directory: string
  readonly path: string | null
  readonly title: string | null
  readonly version: string
  readonly share_url: string | null
  readonly summary_additions: number | null
  readonly summary_deletions: number | null
  readonly summary_files: number | null
  readonly summary_diffs: string | null
  readonly metadata: string | null
  readonly cost: number
  readonly tokens_input: number
  readonly tokens_output: number
  readonly tokens_reasoning: number
  readonly tokens_cache_read: number
  readonly tokens_cache_write: number
  readonly revert: string | null
  readonly permission: string | null
  readonly agent: string | null
  readonly model: string | null
  readonly time_created: number
  readonly time_updated: number
  readonly time_compacting: number | null
  readonly time_archived: number | null
  readonly time_suspended: number | null
}

// NEXT_SESSION_COLUMNS：session 表各列的导入策略清单（全部列均存在时直读）
const NEXT_SESSION_COLUMNS = {
  // 主键，必需
  id: "required",
  // 所属项目，必需
  project_id: "required",
  // 所属工作区，可空
  workspace_id: "nullable",
  // 父会话，可空
  parent_id: "nullable",
  // 分叉来源会话，可空
  fork_session_id: "nullable",
  // 分叉边界，可空
  fork_boundary: "nullable",
  // 短标识，必需
  slug: "required",
  // 工作目录，必需
  directory: "required",
  // 存储路径，可空
  path: "nullable",
  // 标题，可空
  title: "nullable",
  // 版本，必需
  version: "required",
  // 分享链接，可空
  share_url: "nullable",
  // 摘要：新增行数，可空
  summary_additions: "nullable",
  // 摘要：删除行数，可空
  summary_deletions: "nullable",
  // 摘要：文件数，可空
  summary_files: "nullable",
  // 摘要：diff 文本，可空
  summary_diffs: "nullable",
  // 元数据，可空
  metadata: "nullable",
  // 花费，必需
  cost: "required",
  // 输入 token 数，必需
  tokens_input: "required",
  // 输出 token 数，必需
  tokens_output: "required",
  // 推理 token 数，必需
  tokens_reasoning: "required",
  // 缓存读取 token 数，必需
  tokens_cache_read: "required",
  // 缓存写入 token 数，必需
  tokens_cache_write: "required",
  // 撤销标记，可空
  revert: "nullable",
  // 权限 JSON，可空
  permission: "nullable",
  // 代理，可空
  agent: "nullable",
  // 模型，可空
  model: "nullable",
  // 创建时间，必需
  time_created: "required",
  // 更新时间，必需
  time_updated: "required",
  // 压缩开始时间，可空
  time_compacting: "nullable",
  // 归档时间，可空
  time_archived: "nullable",
  // 挂起时间，可空
  time_suspended: "nullable",
} satisfies NextColumns<NextSession>

// NextMessage：opencode-next.db 中 session_message 表的行结构
type NextMessage = {
  readonly id: string
  readonly session_id: string
  readonly type: string
  readonly seq: number
  readonly time_created: number
  readonly time_updated: number
  readonly data: string
}

// lock：许可数为 1 的全局信号量——保证迁移同一时刻只运行一份
const lock = Semaphore.makeUnsafe(1)
// MIGRATION_STATE_KEY：迁移状态在 kv 表中的键名
const MIGRATION_STATE_KEY = "migration.v1-v2"
// EVENT_DELETE_BATCH_SIZE：清理旧事件表的分批大小
const EVENT_DELETE_BATCH_SIZE = 1_000
// decodeJson：把 JSON 文本解码为未知值的容错解码器
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
// decodeMessage：把消息 JSON 解码为 V1 消息模型
const decodeMessage = Schema.decodeUnknownOption(SessionV1.Info)
// decodePart：把分片 JSON 解码为 V1 分片模型
const decodePart = Schema.decodeUnknownOption(SessionV1.Part)
// runtimeState：模块级的运行状态（启动时为空闲）
let runtimeState: RuntimeState = { status: "idle" }

// transformSession：把一个 V1 会话（消息+分片）转换为 V2 结构的核心纯函数
export function transformSession(input: TransformInput): TransformResult {
  // warnings：本次转换收集的告警
  const warnings: Warning[] = []
  // messages：解码消息行，过滤坏行，并按（创建时间, id）排序
  const messages = input.messages
    .map((row) => {
      // 先把行数据的 JSON 文本解码为未知值
      const value = Option.getOrUndefined(decodeJson(row.data))
      // 再按 V1 消息模型解码（补回行 id 与 sessionID）
      const decoded =
        value && typeof value === "object"
          ? Option.getOrUndefined(decodeMessage({ ...value, id: row.id, sessionID: row.session_id }))
          : undefined
      // 解码成功则保留
      if (decoded) return { row, value: decoded }
      // 解码失败则记一条 invalid-message 告警
      warnings.push({ reason: "invalid-message", sessionID: input.session.id, messageID: row.id })
      return undefined
    })
    // 过滤掉解码失败的行
    .filter((item): item is NonNullable<typeof item> => item !== undefined)
    // 按创建时间排序，时间相同按 id 字典序，保证稳定顺序
    .sort((a, b) => a.row.time_created - b.row.time_created || a.row.id.localeCompare(b.row.id))
  // messageIDs：本会话全部消息 id 的集合，用于识别孤儿分片
  const messageIDs = new Set(input.messages.map((row) => row.id))
  // parts：解码分片行，丢弃不属于任何消息的孤儿分片，并按 id 排序
  const parts = input.parts
    .map((row) => {
      // 先解码分片的 JSON 文本
      const value = Option.getOrUndefined(decodeJson(row.data))
      // 记录数据中观察到的 type 字段（用于告警诊断）
      const observedType = value && typeof value === "object" && "type" in value ? String(value.type) : undefined
      // 若分片所属消息不存在，视为孤儿分片
      if (!messageIDs.has(row.message_id)) {
        warnings.push({
          reason: "orphan-part",
          sessionID: input.session.id,
          messageID: row.message_id,
          partID: row.id,
          observedType,
        })
        return undefined
      }
      // 按 V1 分片模型解码（补回行 id、messageID、sessionID）
      const decoded =
        value && typeof value === "object"
          ? Option.getOrUndefined(
              decodePart({ ...value, id: row.id, messageID: row.message_id, sessionID: row.session_id }),
            )
          : undefined
      // 解码成功则保留
      if (decoded) return { row, value: decoded }
      // 解码失败记 invalid-part 告警
      warnings.push({
        reason: "invalid-part",
        sessionID: input.session.id,
        messageID: row.message_id,
        partID: row.id,
        observedType,
      })
      return undefined
    })
    // 过滤掉被丢弃的分片
    .filter((item): item is NonNullable<typeof item> => item !== undefined)
    // 按 id 字典序排序，保证稳定顺序
    .sort((a, b) => a.row.id.localeCompare(b.row.id))
  // byMessage：按消息 id 把分片分组
  const byMessage = Map.groupBy(parts, (item) => item.row.message_id)
  // paired：已被“用户消息+压缩摘要”配对消费掉的 assistant 消息 id 集合
  const paired = new Set<string>()
  // used：已占用的消息 id 集合，供合成（synthetic）消息生成新 id 时避让
  const used = new Set(messages.map((item) => item.row.id))
  // projected：逐条消息投影（project）为 V2 消息
  const projected = messages
    .flatMap((item) => {
      // 已被配对消费的 assistant 消息不再单独投影
      if (paired.has(item.row.id)) return []
      // owned：归属当前消息的全部分片值
      const owned = byMessage.get(item.row.id)?.map((part) => part.value) ?? []
      // 用户消息分支
      if (item.value.role === "user") {
        // compaction：查找归属本消息的压缩分片
        const compaction = owned.find((part): part is SessionV1.CompactionPart => part.type === "compaction")
        if (compaction) {
          // pairedSummary：寻找由本压缩产生的摘要 assistant 消息
          const pairedSummary = messages.find(
            (candidate): candidate is (typeof messages)[number] & { value: SessionV1.Assistant } =>
              candidate.value.role === "assistant" &&
              candidate.value.parentID === item.row.id &&
              candidate.value.summary === true,
          )
          // 没有配对摘要则放弃投影（历史不完整，跳过）
          if (!pairedSummary) return []
          // 标记摘要消息已被配对消费
          paired.add(pairedSummary.row.id)
          // 摘要消息出错或未完成则同样跳过
          if (pairedSummary.value.error || pairedSummary.value.time.completed === undefined) return []
          // summary：配对到的摘要消息
          const summary = pairedSummary
          // summaryText：把摘要消息的文本分片拼接为摘要正文
          const summaryText = (byMessage.get(summary.row.id) ?? [])
            .map((part) => part.value)
            .filter((part): part is SessionV1.TextPart => part.type === "text" && part.text.length > 0)
            .map((part) => part.text)
            .join("\n\n")
          // tailIndex：压缩尾部（tail）起始消息的位置
          const tailIndex = compaction.tail_start_id
            ? messages.findIndex((candidate) => candidate.row.id === compaction.tail_start_id)
            : -1
          // compactionIndex：当前压缩消息在列表中的位置
          const compactionIndex = messages.findIndex((candidate) => candidate.row.id === item.row.id)
          // tail：压缩尾部区间内的消息（摘要之后、压缩点之前）
          const tail = tailIndex < 0 ? [] : messages.slice(tailIndex, compactionIndex)
          // V1 kept these messages beside the summary; they replay as text, like compactions before v2.1.
          // recent：把尾部消息序列化为文本，随压缩消息回放
          const recent = serializeRecent(tail, byMessage)
          // 返回一条 V2 的 compaction 消息（时间取两者更新的较大值）
          return [
            row(
              { ...item.row, time_updated: Math.max(item.row.time_updated, summary.row.time_updated) },
              {
                id: item.row.id,
                type: "compaction",
                status: "completed",
                reason: compaction.auto ? "auto" : "manual",
                summary: summaryText,
                ...(recent ? { metadata: { recent } } : {}),
                time: { created: item.row.time_created },
              },
            ),
          ]
        }
        // subtasks：子任务（subtask）分片
        const subtasks = owned.filter((part) => part.type === "subtask")
        // visible：未被忽略的文本分片
        const visible = owned.filter((part): part is SessionV1.TextPart => part.type === "text" && !part.ignored)
        // files：文件（file）分片
        const files = owned.filter((part): part is SessionV1.FilePart => part.type === "file")
        // agents：代理提及（agent）分片
        const agents = owned.filter((part): part is SessionV1.AgentPart => part.type === "agent")
        // 只有子任务而没有可展示内容时，该用户消息整体跳过
        if (subtasks.length > 0 && visible.length === 0 && files.length === 0 && agents.length === 0) return []
        // ordinary：非合成（synthetic）的普通文本分片
        const ordinary = visible.filter((part) => !part.synthetic)
        // synthetic：标记为合成的文本分片
        const synthetic = visible.filter((part) => part.synthetic)
        // attachments：把内联文件分片迁移为附件
        const attachments = files.flatMap((part) => migrateFile(part))
        // unavailable：无法迁移的外部文件，生成占位说明文本
        const unavailable = files.flatMap((part) => (!part.url.startsWith("data:") ? [unavailableFile(part)] : []))
        // text：拼接正文——普通文本 + 外部文件的不可用占位
        const text = owned
          .flatMap((part) => {
            // 普通文本分片直接取文本
            if (part.type === "text" && !part.ignored && !part.synthetic) return [part.text]
            // 外部文件分片替换为不可用占位文本
            if (part.type === "file" && !part.url.startsWith("data:")) return [unavailableFile(part)]
            return []
          })
          .join("\n\n")
        // agentAttachments：把代理提及分片转为 V2 的 agents 附件结构
        const agentAttachments = agents.map((part) => ({
          name: part.name,
          ...(part.source
            ? { mention: { text: part.source.value, start: part.source.start, end: part.source.end } }
            : {}),
        }))
        // 只剩合成文本（无普通文本/附件/代理提及）时，输出单条 synthetic 消息
        if (
          ordinary.length === 0 &&
          unavailable.length === 0 &&
          synthetic.length > 0 &&
          attachments.length === 0 &&
          agentAttachments.length === 0
        )
          return [
            row(item.row, {
              id: item.row.id,
              type: "synthetic",
              text: synthetic.map((part) => part.text).join("\n\n"),
              time: { created: item.row.time_created },
            }),
          ]
        // user：构造常规的用户消息
        const user = row(item.row, {
          id: item.row.id,
          type: "user",
          text,
          ...(attachments.length ? { files: attachments } : {}),
          ...(agentAttachments.length ? { agents: agentAttachments } : {}),
          time: { created: item.row.time_created },
        })
        // 没有合成内容时只返回用户消息
        if (synthetic.length === 0) return [user]
        // 有合成内容时额外追加一条 synthetic 消息（id 需避开已占用集合）
        return [
          user,
          row(item.row, {
            id: syntheticID(item.row.id, used),
            type: "synthetic",
            text: synthetic.map((part) => part.text).join("\n\n"),
            time: { created: item.row.time_created },
          }),
        ]
      }
      // 既非用户也非助手的消息（如系统占位）不投影
      if (item.value.role !== "assistant") return []
      // assistant：当前 assistant 消息值
      const assistant = item.value
      // parent：该 assistant 消息的父消息（通常是对应用户消息）
      const parent = messages.find((candidate) => candidate.row.id === assistant.parentID)
      // parentParts：父消息的分片
      const parentParts = parent ? (byMessage.get(parent.row.id)?.map((part) => part.value) ?? []) : []
      // 父消息是子任务且本消息只是 task 工具调用时，跳过（子任务对话不进主线历史）
      if (
        parentParts.some((part) => part.type === "subtask") &&
        owned.some((part) => part.type === "tool" && part.tool === "task")
      )
        return []
      // content：把分片转换为 V2 的内容条目（文本/推理/工具）
      const content = owned.flatMap((part): Array<Record<string, unknown>> => {
        // 文本分片：转 text 条目，元数据作为 native 保留
        if (part.type === "text")
          return [{ type: "text", text: part.text, ...(part.metadata ? { native: part.metadata } : {}) }]
        // 推理分片：转 reasoning 条目并保留起止时间
        if (part.type === "reasoning")
          return [
            {
              type: "reasoning",
              text: part.text,
              ...(part.metadata ? { native: part.metadata } : {}),
              time: { created: part.time.start, ...(part.time.end === undefined ? {} : { completed: part.time.end }) },
            },
          ]
        // 其他类型暂不处理
        if (part.type !== "tool") return []
        // 工具分片交给 migrateTool 迁移
        return [migrateTool(part, item.row.time_created)]
      })
      // start：快照起点——依次取 step-start/snapshot/patch 中的快照标识
      const start =
        owned.flatMap((part) => (part.type === "step-start" && part.snapshot ? [part.snapshot] : []))[0] ??
        owned.flatMap((part) => (part.type === "snapshot" ? [part.snapshot] : []))[0] ??
        owned.flatMap((part) => (part.type === "patch" ? [part.hash] : []))[0]
      // end：快照终点——最后一个 step-finish 的快照
      const end = owned.flatMap((part) => (part.type === "step-finish" && part.snapshot ? [part.snapshot] : [])).at(-1)
      // snapshotFiles：patch 分片中涉及的文件集合（去重）
      const snapshotFiles = Array.from(new Set(owned.flatMap((part) => (part.type === "patch" ? part.files : []))))
      // finish：规范化的结束原因（stop/length/tool-calls 等）
      const finish = normalizeFinish(assistant.finish)
      // 返回 V2 的 assistant 消息
      return [
        row(item.row, {
          id: item.row.id,
          type: "assistant",
          agent: assistant.agent,
          // model：补全提供方/模型/变体（variant）三元组
          model: {
            providerID: assistant.providerID,
            id: assistant.modelID,
            variant: assistant.variant ?? "default",
          },
          content,
          ...(start || end || snapshotFiles.length
            ? {
                snapshot: {
                  ...(start ? { start } : {}),
                  ...(end ? { end } : {}),
                  ...(snapshotFiles.length ? { files: snapshotFiles } : {}),
                },
              }
            : {}),
          ...(finish ? { finish } : {}),
          // cost：本条消息的花费
          cost: assistant.cost,
          // tokens：本条消息的各类 token 用量
          tokens: {
            input: assistant.tokens.input,
            output: assistant.tokens.output,
            reasoning: assistant.tokens.reasoning,
            cache: assistant.tokens.cache,
          },
          ...(assistant.error ? { error: migrateError(assistant.error) } : {}),
          time: {
            created: item.row.time_created,
            ...(assistant.time.completed === undefined ? {} : { completed: item.row.time_updated }),
          },
        }),
      ]
    })
    // 为投影结果按顺序补上 seq 序号
    .map((item, seq) => ({ ...item, seq }))
  // last：最后一条投影消息
  const last = projected.at(-1)
  // notice：针对旧工具名/参数变化生成的系统提示文本（无变化则为 undefined）
  const notice = last === undefined ? undefined : legacyToolNotice(projected)
  // migrated：最终消息列表——若有提示，则在其后追加一条 system 消息
  const migrated =
    last === undefined || notice === undefined
      ? projected
      : [
          ...projected,
          {
            ...last,
            id: syntheticID(last.id, used),
            type: "system" as const,
            seq: projected.length,
            data: {
              text: notice,
              time: { created: last.time_created },
            },
          },
        ]
  // assistants：全部 assistant 消息值，用于汇总用量
  const assistants = messages
    .map((item) => item.value)
    .filter((item): item is SessionV1.Assistant => item.role === "assistant")
  // latestUser：最后一条“正常”的用户消息（非压缩、非纯子任务），用于回填 agent/model
  const latestUser = messages.findLast((item) => {
    // 非用户消息跳过
    if (item.value.role !== "user") return false
    // owned：该消息的分片
    const owned = byMessage.get(item.row.id) ?? []
    // 携带压缩分片的消息不算
    if (owned.some((part) => part.value.type === "compaction")) return false
    // 混合了子任务与其他内容、或不含子任务的消息才算正常
    return !owned.some((part) => part.value.type === "subtask") || !owned.every((part) => part.value.type === "subtask")
  })
  // 返回转换结果：消息、会话级回写字段、水位线与告警
  return {
    messages: migrated,
    session: {
      // agent：优先用会话已有值，否则取最后一条用户消息的代理
      agent: input.session.agent ?? (latestUser?.value.role === "user" ? Agent.ID.make(latestUser.value.agent) : null),
      // model：优先用会话已有值，否则取最后一条用户消息的模型三元组
      model:
        input.session.model ??
        (latestUser?.value.role === "user"
          ? {
              id: latestUser.value.model.modelID,
              providerID: latestUser.value.model.providerID,
              variant: latestUser.value.model.variant ?? "default",
            }
          : null),
      // cost：所有 assistant 消息花费之和
      cost: assistants.reduce((total, item) => total + item.cost, 0),
      // 汇总输入 token
      tokens_input: assistants.reduce((total, item) => total + item.tokens.input, 0),
      // 汇总输出 token
      tokens_output: assistants.reduce((total, item) => total + item.tokens.output, 0),
      // 汇总推理 token
      tokens_reasoning: assistants.reduce((total, item) => total + item.tokens.reasoning, 0),
      // 汇总缓存读取 token
      tokens_cache_read: assistants.reduce((total, item) => total + item.tokens.cache.read, 0),
      // 汇总缓存写入 token
      tokens_cache_write: assistants.reduce((total, item) => total + item.tokens.cache.write, 0),
      // revert：V1 数据不再保留撤销标记
      revert: null,
      // time_compacting：V1 数据不再保留压缩时间
      time_compacting: null,
    },
    // watermark：消息数为 0 时为 -1，否则为最后一条的序号
    watermark: migrated.length - 1,
    warnings,
  }
}

// status：查询 V1 迁移的当前状态（需要/已完成/进行中/出错）
export function status(): Effect.Effect<Status, never, Database.Service> {
  return Effect.gen(function* () {
    // db：当前数据库连接
    const db = (yield* Database.Service).db
    // 没有 V1 遗留会话时视为已完成
    if (!(yield* hasLegacySessions(db))) return { status: "completed" as const }
    // state：读取 kv 中的持久化迁移状态
    const state = yield* readState(db)
    // 进程内正在运行则如实返回运行状态
    if (runtimeState.status === "running") return runtimeState
    // 进程内处于错误状态则如实返回错误
    if (runtimeState.status === "error") return runtimeState
    // 持久化状态已完成则返回完成
    if (state?.phase === "completed") return { status: "completed" as const }
    // 其余情况说明还需要执行迁移
    return { status: "required" as const }
  })
}

// layer：迁移服务层——启动时立即在后台分叉（fork）执行迁移并跟踪状态
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    // 置为运行中，初始阶段为清理旧事件
    runtimeState = { status: "running", progress: { label: "Clearing old events" } }
    // 启动迁移（run），失败/成功分别更新运行状态
    yield* run().pipe(
      // matchCauseEffect：区分失败与成功两条路径
      Effect.matchCauseEffect({
        // 失败：记录错误文本并写日志
        onFailure: (cause) =>
          Effect.sync(() => {
            runtimeState = { status: "error", error: errorText(Cause.squash(cause)) }
          }).pipe(Effect.andThen(Effect.logError("V1 migration failed", { cause }))),
        // 成功：回到空闲状态
        onSuccess: () =>
          Effect.sync(() => {
            runtimeState = { status: "idle" }
          }),
      }),
      // forkScoped：作为作用域内后台纤程立即启动，不阻塞启动流程
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
)

// errorText：把任意错误展开为多行文本（带 Caused by 因果链）
function errorText(input: unknown): string {
  // 非 Error 对象直接字符串化
  if (!(input instanceof Error)) return String(input)
  // 取出内层原因
  const cause = input.cause
  // 无原因时只返回自身消息，否则递归拼接原因链
  return cause === undefined ? input.message : `${input.message}\nCaused by: ${errorText(cause)}`
}

// updateProgress：仅在运行中时更新进度（避免覆盖错误状态）
function updateProgress(progress: Progress) {
  if (runtimeState.status === "running") runtimeState = { status: "running", progress }
}

// run：执行完整的 V1 -> V2 数据迁移（带互斥锁，可断点续迁）
export function run(
  options: Options = {},
): Effect.Effect<RunResult, never, Database.Service | Global.Service | Project.Service | FSUtil.Service> {
  // withPermit：同一进程内串行执行迁移
  return lock.withPermit(
    Effect.gen(function* () {
      // db：当前数据库连接
      const db = (yield* Database.Service).db
      // global：全局服务（数据目录）
      const global = yield* Global.Service
      // state：读取持久化的迁移状态
      const state = yield* readState(db)
      // 已完成过则直接返回
      if (state?.phase === "completed") return { status: "completed" as const }
      // 没有 V1 遗留会话则无事可做
      if (!(yield* hasLegacySessions(db))) return { status: "completed" as const }
      // now：本次迁移的基准时间戳
      const now = Date.now()
      // 确保全局项目行存在（工作树为数据目录根），幂等插入
      yield* db.run(sql`
          INSERT OR IGNORE INTO project (id, worktree, time_created, time_updated, time_active, sandboxes)
          VALUES (${Project.ID.global}, ${path.parse(global.data).root}, ${now}, ${now}, ${now}, '[]')
        `)
      // 首次运行（无状态记录）：清理旧事件表并初始化迁移状态
      if (state === undefined)
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              // 循环分批删除 event 表数据
              while (true) {
                // 每批按 rowid 删除固定数量
                yield* tx.run(sql`
                    DELETE FROM event
                    WHERE rowid IN (SELECT rowid FROM event LIMIT ${EVENT_DELETE_BATCH_SIZE})
                  `)
                // 读取本批实际删除行数
                const deleted = (yield* tx.get<{ value: number }>(sql`SELECT changes() AS value`))?.value ?? 0
                // 删除量小于批次大小说明已清空
                if (deleted < EVENT_DELETE_BATCH_SIZE) break
                // 让出执行权，避免长事务饿死其他工作
                yield* Effect.yieldNow
              }
              // 写入初始迁移状态：进入 sessions 阶段
              yield* tx
                .insert(KVTable)
                .values({ key: MIGRATION_STATE_KEY, value: { phase: "sessions" } })
                .run()
            }),
          )
          // 状态初始化失败属于不可恢复错误，直接 die
          .pipe(Effect.orDie)
      // sourceTotal：opencode-next.db 中的会话总数（无该库则为 0）
      const sourceTotal = yield* countNextSessions(nextPath(options, global.data))
      // legacyTotal：当前库中 V1 遗留会话总数
      const legacyTotal = (yield* db.get<{ value: number }>(sql`SELECT COUNT(*) AS value FROM session`))?.value ?? 0
      // cursor：断点续迁的游标（上次迁移到的会话 id）
      const cursor = state?.phase === "sessions" ? state.cursor : undefined
      // migrated：游标之前尚未完成的会话数量（用于进度计算）
      const migrated =
        cursor !== undefined
          ? ((yield* db.get<{ value: number }>(sql`SELECT COUNT(*) AS value FROM session WHERE id >= ${cursor}`))
              ?.value ?? 0)
          : 0
      // denominator：进度分母 = 两部分会话总数
      const denominator = sourceTotal + legacyTotal
      // 更新进度：开始迁移会话
      updateProgress({ label: "Migrating sessions", numerator: migrated, denominator })
      // 先从 opencode-next.db 导入（V2 数据源），并回调更新进度
      yield* importNextDatabase(db, nextPath(options, global.data), (completed) => {
        updateProgress({ label: "Migrating sessions", numerator: migrated + completed, denominator })
      })
      // 导入完成后再刷新一次进度
      updateProgress({ label: "Migrating sessions", numerator: migrated + sourceTotal, denominator })
      // projects：现有项目的 id -> worktree 映射
      const projects = new Map(
        (yield* db.all<{ id: string; worktree: string }>(sql`SELECT id, worktree FROM project`)).map((project) => [
          project.id,
          project.worktree,
        ]),
      )
      // directories：目录解析结果缓存（含失败/超时的 undefined）
      const directories = new Map<string, { project: Project.Resolved; path: string } | undefined>()
      // lookupTimedOut：目录解析一旦超时，后续不再尝试（避免反复挂起）
      let lookupTimedOut = false
      // 主循环：逐个处理 V1 遗留会话（从最新到最旧）
      while (true) {
        // 读取当前迁移状态
        const state = yield* readState(db)
        // cursorValue：本轮的游标（已迁移到哪个会话 id）
        const cursorValue = state?.phase === "sessions" ? state.cursor : undefined
        // nextID：取游标之前（更旧）的下一个待迁移会话，同时标记是否已存在于 session_v2
        const nextID = yield* db.get<{
          id: string
          project_id: string
          workspace_id: string | null
          directory: string
          path: string | null
          time_updated: number
          imported: number
        }>(sql`
          SELECT id, project_id, workspace_id, directory, path, time_updated,
            EXISTS (SELECT 1 FROM session_v2 WHERE session_v2.id = session.id) AS imported
          FROM session
          ${cursorValue === undefined ? sql`` : sql`WHERE id < ${cursorValue}`}
          ORDER BY id DESC LIMIT 1
        `)
        // 没有更多会话则迁移结束
        if (!nextID) break
        // projectID：项目不存在时回退到全局项目
        const projectID = projects.has(nextID.project_id) ? nextID.project_id : Project.ID.global
        // Legacy ACP sessions can store a cwd relative to an unknown process directory.
        // Use the project worktree instead, and leave the original V1 row intact.
        // directory：目录不是绝对路径时改用项目工作树（保持 V1 原行不变）
        const directory =
          !nextID.directory || storedAbsolutePath(nextID.directory)
            ? nextID.directory
            : (storedAbsolutePath(projects.get(projectID) ?? path.parse(global.data).root) ?? "")
        // unowned：会话归属全局项目、无工作区绑定、未导入且目录未变——
        // 需要进一步解析目录归属
        const unowned =
          projectID === Project.ID.global &&
          nextID.workspace_id === null &&
          !nextID.imported &&
          directory === nextID.directory
        // 未缓存且未超时的情况下解析该目录的归属项目
        if (unowned && !lookupTimedOut && !directories.has(directory)) {
          // resolved：解析结果（可能是 Option.none 表示超时）
          const resolved = yield* resolveDirectory(directory)
          // One hung directory (e.g. a dead network mount) usually means more; leave the rest under global.
          // 一次超时通常意味着后续也会挂起，直接放弃其余目录解析
          if (Option.isNone(resolved)) {
            lookupTimedOut = true
            yield* Effect.logWarning("Stopped resolving V1 session directories after a timeout", { directory })
          }
          // 缓存解析结果
          directories.set(directory, Option.getOrUndefined(resolved))
        }
        // owner：目录归属的项目信息（unowned 时才查找）
        const owner = unowned ? directories.get(directory) : undefined
        // 每个会话的迁移放在独立事务中：写游标、复制会话、迁移消息
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              // 先落盘游标（冲突则更新），保证断点续迁
              yield* tx
                .insert(KVTable)
                .values({ key: MIGRATION_STATE_KEY, value: { phase: "sessions", cursor: nextID.id } })
                .onConflictDoUpdate({
                  target: KVTable.key,
                  set: { value: { phase: "sessions", cursor: nextID.id }, time_updated: Date.now() },
                })
                .run()
              // 项目缺失被改派到全局时记告警
              if (projectID !== nextID.project_id)
                yield* Effect.logWarning("Reassigned V1 session with missing project", {
                  sessionID: nextID.id,
                  projectID: nextID.project_id,
                })
              // 目录被替换（原为相对路径）时记告警
              if (directory !== nextID.directory)
                yield* Effect.logWarning("Replaced relative V1 session directory", {
                  sessionID: nextID.id,
                  directory: nextID.directory,
                  resolved: directory,
                })
              // owner：解析出的新项目若不存在则先建项目行
              if (owner && !projects.has(owner.project.id))
                yield* tx
                  .insert(ProjectTable)
                  .values({
                    id: owner.project.id,
                    worktree: owner.project.canonical,
                    vcs: owner.project.vcs?.type,
                    sandboxes: [],
                    time_active: nextID.time_updated,
                  })
                  .onConflictDoNothing()
                  .run()
              // 把 V1 会话行复制进 session_v2（幂等，已存在则忽略），
              // 项目/路径按解析结果覆盖，permission 置空
              yield* tx.run(sql`
                  INSERT OR IGNORE INTO session_v2 (
                    id, project_id, workspace_id, parent_id, slug, directory, path, title, version, share_url,
                    summary_additions, summary_deletions, summary_files, summary_diffs, metadata, cost,
                    tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
                    revert, permission, agent, model, time_created, time_updated, time_compacting, time_archived
                  )
                  SELECT
                    id, ${owner?.project.id ?? projectID}, workspace_id, parent_id, slug, ${directory}, ${owner?.path ?? nextID.path}, title, version, share_url,
                    summary_additions, summary_deletions, summary_files, summary_diffs, metadata, cost,
                    tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
                    revert, NULL, agent, model, time_created, time_updated, time_compacting, time_archived
                  FROM session
                  WHERE id = ${nextID.id}
                `)
              // next：重新读出刚复制的会话行（drizzle 模型）
              const next = yield* tx
                .select()
                .from(SessionTable)
                .where(eq(SessionTable.id, SessionSchema.ID.make(nextID.id)))
                .get()
              // 复制失败则致命错误终止
              if (!next) return yield* Effect.die(new Error(`Failed to copy V1 session ${nextID.id}`))
              // sourceMessages：读取该会话的 V1 原始消息
              const sourceMessages = yield* tx.all<SourceMessage>(
                sql`SELECT id, session_id, time_created, time_updated, data FROM message WHERE session_id = ${next.id}`,
              )
              // sourceParts：读取该会话的 V1 原始分片
              const sourceParts = yield* tx.all<SourcePart>(
                sql`SELECT id, message_id, session_id, time_created, time_updated, data FROM part WHERE session_id = ${next.id}`,
              )
              // transformed：执行核心转换（纯函数）
              const transformed = transformSession({ session: next, messages: sourceMessages, parts: sourceParts })
              // 把全部告警写入日志
              yield* Effect.forEach(transformed.warnings, (warning) =>
                Effect.logWarning("Skipped V1 migration row", warning),
              )
              // 先清空该会话已有的 V2 消息（保证可重入）
              yield* tx.delete(SessionMessageTable).where(eq(SessionMessageTable.session_id, next.id)).run()
              // 逐条写入转换后的 V2 消息
              yield* Effect.forEach(transformed.messages, (message) =>
                tx
                  .insert(SessionMessageTable)
                  .values({
                    id: SessionMessage.ID.make(message.id),
                    session_id: SessionSchema.ID.make(message.session_id),
                    type: message.type,
                    seq: message.seq,
                    time_created: message.time_created,
                    time_updated: message.time_updated,
                    data: sql`${JSON.stringify(message.data)}`,
                  })
                  .run(),
              )
              // 把会话级统计（agent/model/用量等）回写到会话表
              yield* tx
                .update(SessionTable)
                .set({ ...transformed.session, time_updated: next.time_updated })
                .where(eq(SessionTable.id, next.id))
                .run()
              // 初始化该会话的事件序列水位线（冲突则更新）
              yield* tx
                .insert(EventSequenceTable)
                .values({ aggregate_id: next.id, seq: transformed.watermark })
                .onConflictDoUpdate({
                  target: EventSequenceTable.aggregate_id,
                  set: { seq: transformed.watermark, owner_id: null },
                })
                .run()
            }),
          )
          // 单会话失败视为不可恢复，直接 die
          .pipe(Effect.orDie)
        // 新解析出的项目登记进本地映射，避免重复插入
        if (owner && !projects.has(owner.project.id)) projects.set(owner.project.id, owner.project.canonical)
        // 运行中则推进进度计数
        if (runtimeState.status === "running")
          runtimeState = {
            status: "running",
            progress: {
              label: "Migrating sessions",
              numerator: (runtimeState.progress.numerator ?? 0) + 1,
              denominator,
            },
          }
        // 让出执行权，保持事件循环可响应
        yield* Effect.yieldNow
      }
      // 全部完成：把持久化状态标记为 completed
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .insert(KVTable)
              .values({ key: MIGRATION_STATE_KEY, value: { phase: "completed" } })
              .onConflictDoUpdate({
                target: KVTable.key,
                set: { value: { phase: "completed" }, time_updated: Date.now() },
              })
              .run()
          }),
        )
        .pipe(Effect.orDie)
      // 返回完成结果
      return { status: "completed" as const }
    }).pipe(Effect.orDie),
  )
}

// V1 grouped non-git sessions under global; V2 resolves an owner for each directory.
// Discovery must not publish adoption events for sessions already stored in V2.
// Any failure keeps the session under global. The lookup runs detached so a filesystem or git call
// that ignores interruption cannot stall the migration; Option.none means it timed out.
// resolveDirectory：解析目录归属的项目——独立纤程运行，5 秒超时兜底
function resolveDirectory(directory: string) {
  return Effect.gen(function* () {
    // forkDetach：分叉不接续的纤程，文件系统/git 调用无法被中断也不会阻塞迁移
    const fiber = yield* Effect.forkDetach(
      Effect.gen(function* () {
        // 空目录直接结束
        if (!directory) return
        // fs：文件系统工具服务
        const fs = yield* FSUtil.Service
        // normalized：把目录解析为规范绝对路径（失败按 undefined 处理）
        const normalized = yield* fs
          .realPath(path.resolve(FSUtil.windowsPath(directory)))
          .pipe(Effect.orElseSucceed(() => undefined))
        // 路径无效或不是目录时放弃
        if (!normalized || !(yield* fs.isDir(normalized))) return
        // projects：项目服务
        const projects = yield* Project.Service
        // project：解析目录归属的项目（persist=false 不落库）
        const project = yield* projects.resolve(AbsolutePath.make(normalized), { persist: false })
        // 返回项目与其内部相对路径
        return {
          project,
          path: path.relative(project.directory, normalized).replaceAll("\\", "/"),
        }
      }),
    )
    // Fiber.join：等待结果；缺陷（defect）降级为告警；整体限时 5 秒
    const result = yield* Fiber.join(fiber).pipe(
      Effect.catchDefect((defect) =>
        Effect.logWarning("Failed to resolve V1 session directory", { directory, defect }).pipe(Effect.as(undefined)),
      ),
      Effect.timeoutOption("5 seconds"),
    )
    // 超时（Option.none）时补一刀中断纤程
    if (Option.isNone(result)) yield* Effect.forkDetach(Fiber.interrupt(fiber))
    // 返回解析结果（可能是 none）
    return result
  })
}

// nextPath：推断 opencode-next.db 的路径——优先显式配置；内存库跳过；
// 默认位于数据目录下
function nextPath(options: Options, data: string) {
  // 显式配置的路径优先
  if (options.nextDatabasePath) return options.nextDatabasePath
  // 内存数据库没有伴生文件
  if (process.env.OPENCODE_DB === ":memory:") return undefined
  // 默认路径：数据目录中的 opencode-next.db
  return path.join(data, "opencode-next.db")
}

// openNextDatabase：以只读方式打开 opencode-next.db（带释放器）
function openNextDatabase(sourcePath: string) {
  // acquireRelease：打开成功后注册关闭资源的 finalizer
  return Effect.acquireRelease(
    Effect.gen(function* () {
      // 动态导入 bun:sqlite（仅在 Bun 运行时可用）
      const sqlite = yield* Effect.promise(() => import("bun:sqlite"))
      // 以只读+严格模式打开数据库
      return new sqlite.Database(sourcePath, { readonly: true, strict: true })
    }),
    // finalizer：作用域结束时关闭连接
    (source) => Effect.sync(() => source.close()),
  )
}

// countNextSessions：统计 opencode-next.db 中的会话数（库不存在或不兼容则为 0）
function countNextSessions(sourcePath: string | undefined) {
  // 无路径或文件不存在直接返回 0
  if (!sourcePath || !existsSync(sourcePath)) return Effect.succeed(0)
  // scoped：在独立作用域中打开数据库，结束自动关闭
  return Effect.scoped(
    Effect.gen(function* () {
      // source：打开的源数据库
      const source = yield* openNextDatabase(sourcePath)
      // 表结构不兼容则计 0
      if (!isNextDatabase(source)) return 0
      // 查询 session 表行数
      return source.query<{ value: number }, []>("SELECT COUNT(*) AS value FROM session").get()?.value ?? 0
    }),
  )
}

// importNextDatabase：把 opencode-next.db 的项目/会话/消息导入当前库
function importNextDatabase(
  db: Database.Interface["db"],
  sourcePath: string | undefined,
  onProgress: (completed: number) => void,
): Effect.Effect<void, unknown> {
  // 无路径或文件不存在则无事可做
  if (!sourcePath || !existsSync(sourcePath)) return Effect.void
  // scoped：独立作用域管理数据库连接
  return Effect.scoped(
    Effect.gen(function* () {
      // source：打开源数据库
      const source = yield* openNextDatabase(sourcePath)
      // 结构不兼容则告警并跳过
      if (!isNextDatabase(source)) {
        yield* Effect.logWarning("Skipped incompatible opencode-next.db", { path: sourcePath })
        return
      }
      // 开启源库的显式事务（保证批量读取一致性）
      source.run("BEGIN")
      // 注册 finalizer：作用域退出时若有未提交事务则回滚
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (source.inTransaction) source.run("ROLLBACK")
        }),
      )
      // projects：源库全部项目（按列策略投影读取），建 id -> 行映射
      const projects = new Map(
        selectNextRows<NextProject>(source, "project", NEXT_PROJECT_COLUMNS).map((project) => [project.id, project]),
      )
      // sessions：源库全部会话（按 id 倒序）
      const sessions = selectNextRows<NextSession>(source, "session", NEXT_SESSION_COLUMNS)
      // 逐个会话导入
      for (const [index, session] of sessions.entries()) {
        // project：该会话的项目（不存在则回退全局）
        const project = projects.get(session.project_id)
        // projectID：最终写入的项目 id
        const projectID = project ? session.project_id : Project.ID.global
        // 项目缺失时告警（改派到全局项目）
        if (!project) {
          yield* Effect.logWarning("Reassigned previous V2 session with missing project", {
            sessionID: session.id,
            projectID: session.project_id,
          })
        }
        // messages：源库中该会话的消息（按 seq 排序）
        const messages = source
          .query<
            NextMessage,
            [string]
          >("SELECT id, session_id, type, seq, time_created, time_updated, data FROM session_message WHERE session_id = ? ORDER BY seq")
          .all(session.id)
        // 每个会话的导入放在独立事务中
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              // 项目存在时幂等插入项目行
              if (project)
                yield* tx.run(sql`
                  INSERT OR IGNORE INTO project (
                    id, worktree, vcs, name, icon_url, icon_url_override, icon_color,
                    time_created, time_updated, time_initialized, time_active, sandboxes, commands
                  ) VALUES (
                    ${project.id}, ${project.worktree}, ${project.vcs}, ${project.name}, ${project.icon_url},
                    ${project.icon_url_override}, ${project.icon_color}, ${project.time_created}, ${project.time_updated},
                    ${project.time_initialized}, ${project.time_updated}, ${project.sandboxes}, ${project.commands}
                  )
                `)
              // existing：当前库是否已有该会话（幂等跳过）
              const existing = yield* tx
                .select({ id: SessionTable.id })
                .from(SessionTable)
                .where(eq(SessionTable.id, SessionSchema.ID.make(session.id)))
                .get()
              // 已存在则跳过
              if (existing) return
              // 插入会话行到 session_v2
              yield* tx.run(sql`
                INSERT INTO session_v2 (
                  id, project_id, workspace_id, parent_id, fork_session_id, fork_boundary, slug, directory,
                  path, title, version, share_url, summary_additions, summary_deletions, summary_files,
                  summary_diffs, metadata, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read,
                  tokens_cache_write, revert, permission, agent, model, time_created, time_updated, time_compacting,
                  time_archived, time_suspended
                ) VALUES (
                  ${session.id}, ${projectID}, ${session.workspace_id}, ${session.parent_id},
                  ${session.fork_session_id}, ${session.fork_boundary}, ${session.slug}, ${session.directory},
                  ${session.path}, ${session.title}, ${session.version}, ${session.share_url},
                  ${session.summary_additions}, ${session.summary_deletions}, ${session.summary_files},
                  ${session.summary_diffs}, ${session.metadata}, ${session.cost}, ${session.tokens_input},
                  ${session.tokens_output}, ${session.tokens_reasoning}, ${session.tokens_cache_read},
                  ${session.tokens_cache_write}, ${session.revert}, ${session.permission}, ${session.agent},
                  ${session.model}, ${session.time_created}, ${session.time_updated}, ${session.time_compacting},
                  ${session.time_archived}, ${session.time_suspended}
                )
              `)
              // 逐条插入该会话的消息
              yield* Effect.forEach(messages, (message) =>
                tx
                  .insert(SessionMessageTable)
                  .values({
                    id: SessionMessage.ID.make(message.id),
                    session_id: SessionSchema.ID.make(message.session_id),
                    type: message.type as SessionMessage.Type,
                    seq: message.seq,
                    time_created: message.time_created,
                    time_updated: message.time_updated,
                    data: sql`${message.data}`,
                  })
                  .run(),
              )
              // 以最后一条消息的 seq 初始化/更新事件序列水位线
              yield* tx
                .insert(EventSequenceTable)
                .values({ aggregate_id: session.id, seq: messages.at(-1)?.seq ?? -1 })
                .onConflictDoUpdate({
                  target: EventSequenceTable.aggregate_id,
                  set: { seq: messages.at(-1)?.seq ?? -1, owner_id: null },
                })
                .run()
            }),
          )
          // 单会话失败视为不可恢复
          .pipe(Effect.orDie)
        // 回调报告进度（已完成会话数）
        onProgress(index + 1)
        // 让出执行权
        yield* Effect.yieldNow
      }
      // 全部导入成功后提交源库事务
      source.run("COMMIT")
    }),
  )
}

// isNextDatabase：校验源库是否为可识别的 opencode-next.db（必须同时有
// project/session/session_message 三张表）
function isNextDatabase(source: SQLiteDatabase) {
  // 收集源库全部表名
  const tables = new Set(
    source
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((table) => table.name),
  )
  // 三张关键表齐全才算兼容
  return tables.has("project") && tables.has("session") && tables.has("session_message")
}

// selectNextRows：按列策略从源库读取行——缺失列用 NULL 或回退列替代，
// 缺失必需列则抛错（库不兼容）
function selectNextRows<A>(source: SQLiteDatabase, table: "project" | "session", definition: NextColumns<A>) {
  // columns：源库该表现有的全部列名
  const columns = new Set(
    source
      .query<{ name: string }, [string]>("SELECT name FROM pragma_table_info(?)")
      .all(table)
      .map((column) => column.name),
  )
  // missing：被标记为必需但源库缺失的列
  const missing = Object.entries(definition)
    .filter(([column, strategy]) => strategy === "required" && !columns.has(column))
    .map(([column]) => column)
  // 存在缺失的必需列时直接抛错
  if (missing.length)
    throw new Error(`Incompatible opencode-next.db: ${table} is missing required columns: ${missing.join(", ")}`)
  // projection：为每个策略列生成 SELECT 投影——直读/回退列别名/NULL 别名
  const projection = Object.entries(definition).map(([column, strategy]) => {
    // 列存在则直读
    if (columns.has(column)) return `"${column}"`
    // 列缺失但配置了回退列且回退列存在时，用回退列顶替
    if (
      typeof strategy === "object" &&
      strategy !== null &&
      "fallback" in strategy &&
      typeof strategy.fallback === "string" &&
      columns.has(strategy.fallback)
    )
      return `"${strategy.fallback}" AS "${column}"`
    // 其余情况以 NULL 占位
    return `NULL AS "${column}"`
  })
  // 查询全部行；session 表按 id 倒序读取
  return source
    .query<A, []>(`SELECT ${projection.join(", ")} FROM "${table}"${table === "session" ? ' ORDER BY "id" DESC' : ""}`)
    .all()
}

// row：把一条源消息与新的消息体组装成 TransformResult 的消息结构
function row(
  source: SourceMessage,
  message: {
    readonly id: string
    readonly type: SessionMessage.Type
    readonly time: { readonly created: number }
    readonly [key: string]: unknown
  },
): TransformResult["messages"][number] {
  // 解构出 id/type，其余字段全部归入 data
  const { id, type, ...data } = message
  // 返回带会话/时间的完整消息行（seq 稍后统一编号）
  return {
    id,
    session_id: source.session_id,
    type,
    seq: 0,
    time_created: source.time_created,
    time_updated: source.time_updated,
    data,
  }
}

// RENAMED_TOOLS：V1 -> V2 的工具改名映射
const RENAMED_TOOLS: Readonly<Record<string, string>> = { bash: "shell", task: "subagent", apply_patch: "patch" }
// PATH_TOOLS：参数从 filePath 改为 path 的工具列表
const PATH_TOOLS = ["read", "edit", "write"]
// REMOVED_TOOLS：默认已移除的工具列表
const REMOVED_TOOLS = ["todowrite"]

/**
 * Tells the model about V1 tools it called in the still-visible history whose
 * V2 names or arguments differ, so it does not repeat those calls. Only tools
 * that actually appear after the last compaction are mentioned.
 */
// legacyToolNotice：扫描压缩点之后的可见历史，为仍在使用的旧工具生成
// 名称/参数变化提示，避免模型重复调用旧接口
function legacyToolNotice(messages: ReadonlyArray<TransformResult["messages"][number]>) {
  // start：最后一条压缩消息的位置（其后的历史仍可见）
  const start = messages.findLastIndex((message) => message.type === "compaction")
  // called：压缩点之后被调用过的工具名集合
  const called = new Set(
    messages.slice(start + 1).flatMap((message) => {
      // 只关心 assistant 消息的 content 数组
      if (message.type !== "assistant" || !Array.isArray(message.data.content)) return []
      // 提取所有工具条目的名称
      return message.data.content.flatMap((item: Record<string, unknown>) =>
        item.type === "tool" && typeof item.name === "string" ? [item.name] : [],
      )
    }),
  )
  // list：把工具名列表格式化为反引号包裹的清单
  const list = (names: ReadonlyArray<string>) => names.map((name) => `\`${name}\``).join(", ")
  // renamed：实际被调用过的改名工具
  const renamed = Object.keys(RENAMED_TOOLS).filter((name) => called.has(name))
  // paths：实际被调用过的参数变更工具
  const paths = PATH_TOOLS.filter((name) => called.has(name))
  // removed：实际被调用过的已移除工具
  const removed = REMOVED_TOOLS.filter((name) => called.has(name))
  // parts：按类别生成提示段落（仅提示真正出现过的工具）
  const parts = [
    // 改名工具的提示（单个/多个分别措辞）
    ...(renamed.length === 1
      ? [`The \`${renamed[0]}\` tool is now \`${RENAMED_TOOLS[renamed[0]]}\` and must be called by that name.`]
      : renamed.length > 1
        ? [
            `The following tools were renamed and must be called by their new names: ${renamed
              .map((name) => `\`${name}\` is now \`${RENAMED_TOOLS[name]}\``)
              .join("; ")}.`,
          ]
        : []),
    // task -> subagent 的参数变化提示
    ...(called.has("task")
      ? ["The `subagent` tool takes `agent` instead of `subagent_type` and `sessionID` instead of `task_id`."]
      : []),
    // 参数改名（filePath -> path）的提示
    ...(paths.length === 1
      ? [`The \`${paths[0]}\` tool now takes \`path\` instead of \`filePath\`.`]
      : paths.length > 1
        ? [`The following tools now take \`path\` instead of \`filePath\`: ${list(paths)}.`]
        : []),
    // skill 工具参数改名提示
    ...(called.has("skill") ? ["The `skill` tool now takes `id` instead of `name`."] : []),
    // 已移除工具的提示
    ...(removed.length === 1
      ? [`The \`${removed[0]}\` tool is no longer available by default. Only call it if it is in your tool list.`]
      : removed.length > 1
        ? [
            `The following tools are no longer available by default. Only call them if they are in your tool list: ${list(removed)}.`,
          ]
        : []),
  ]
  // 没有任何提示则返回 undefined
  if (parts.length === 0) return undefined
  // 拼接完整提示文本
  return ["The available tools have changed.", ...parts].join("\n\n")
}

// migrateTool：把 V1 工具分片迁移为 V2 工具条目（按执行状态分派）
function migrateTool(part: typeof SessionV1.ToolPart.Type, fallback: number) {
  // base：各状态共有的字段（类型/调用 id/工具名/原生元数据）
  const base = {
    type: "tool" as const,
    id: part.callID,
    name: part.tool,
    ...(part.metadata ? { native: part.metadata } : {}),
  }
  // 已完成状态：携带输入、输出内容与时间
  if (part.state.status === "completed")
    return {
      ...base,
      state: {
        status: "completed",
        input: part.state.input,
        // 输出内容：已被压缩清除的旧结果用占位文本，否则保留文本与附件
        content:
          part.state.time.compacted === undefined
            ? [
                { type: "text", text: part.state.output },
                ...(part.state.attachments ?? []).map((file) => ({
                  type: "file" as const,
                  uri: file.url,
                  mime: file.mime,
                  ...(file.filename ? { name: file.filename } : {}),
                })),
              ]
            : [{ type: "text", text: "[Old tool result content cleared]" }],
        metadata: part.state.metadata,
      },
      time: { created: part.state.time.start, completed: part.state.time.end },
    }
  // 错误状态：携带输入、错误信息与可选输出/元数据
  if (part.state.status === "error")
    return {
      ...base,
      state: {
        status: "error",
        input: part.state.input,
        error: { type: "tool.execution", message: part.state.error },
        ...(typeof part.state.metadata?.output === "string"
          ? { content: [{ type: "text", text: part.state.metadata.output }] }
          : {}),
        ...(part.state.metadata ? { metadata: part.state.metadata } : {}),
      },
      time: { created: part.state.time.start, completed: part.state.time.end },
    }
  // 其余（pending/running）：迁移时统一转为“执行被中断”的错误条目
  return {
    ...base,
    state: {
      status: "error",
      input: part.state.input,
      error: { type: "tool.interrupted", message: "Tool execution was interrupted before V2 migration" },
      ...(part.state.status === "running" && part.state.metadata ? { metadata: part.state.metadata } : {}),
    },
    // running 状态有开始时间，其余用回退时间
    time: { created: part.state.status === "running" ? part.state.time.start : fallback },
  }
}

// migrateError：把 V1 助手消息的错误迁移为 V2 的 {type, message} 结构
function migrateError(error: NonNullable<(typeof SessionV1.Assistant.Type)["error"]>) {
  // message：优先用错误数据中的消息，输出超限用固定文案，否则用错误名
  const message =
    "message" in error.data
      ? error.data.message
      : error.name === "MessageOutputLengthError"
        ? "The model exceeded its output limit"
        : error.name
  // type：按错误名映射为 V2 的错误类型码
  const type =
    error.name === "ProviderAuthError"
      ? "provider.auth"
      : error.name === "ContentFilterError"
        ? "provider.content-filter"
        : error.name === "ContextOverflowError"
          ? "provider.invalid-request"
          : error.name === "StructuredOutputError" || error.name === "MessageOutputLengthError"
            ? "provider.invalid-output"
            : error.name === "MessageAbortedError"
              ? "aborted"
              : error.name === "APIError"
                ? "provider.error"
                : "unknown"
  // 返回结构化错误
  return { type, message }
}

// normalizeFinish：把结束原因收敛到 V2 认可的枚举值
function normalizeFinish(finish: string | undefined) {
  // 未提供则返回 undefined
  if (!finish) return undefined
  // 在白名单中查找；不认识的一律归为 unknown
  return (
    (["stop", "length", "tool-calls", "content-filter", "error", "unknown"] as const).find(
      (value) => value === finish,
    ) ?? "unknown"
  )
}

// migrateFile：把 V1 内联（data: URL）文件分片迁移为 V2 附件；外部文件返回空
function migrateFile(part: SessionV1.FilePart) {
  // 非 data: URL 的外部文件不做内联迁移
  if (!part.url.startsWith("data:")) return []
  // comma：data URL 头部与负载的分隔位置
  const comma = part.url.indexOf(",")
  // 结构异常（无逗号）时放弃
  if (comma < 0) return []
  // header：data URL 的头部（含 MIME 与编码声明）
  const header = part.url.slice(0, comma)
  // payload：URL 编码/base64 的负载部分
  const payload = part.url.slice(comma + 1)
  // data：统一转成 base64 文本——base64 负载原样规范化；URL 编码负载先解码
  const data = header.endsWith(";base64")
    ? Buffer.from(payload, "base64").toString("base64")
    : Buffer.from(decodeURIComponent(payload)).toString("base64")
  // 返回 V2 附件结构（含来源引用与提及位置）
  return [
    {
      data,
      mime: part.mime,
      source:
        part.source?.type === "resource" ? { type: "uri" as const, uri: part.source.uri } : { type: "inline" as const },
      ...(part.filename ? { name: part.filename } : {}),
      ...(part.source
        ? { mention: { text: part.source.text.value, start: part.source.text.start, end: part.source.text.end } }
        : {}),
    },
  ]
}

// unavailableFile：为无法迁移的外部文件生成占位说明文本
function unavailableFile(part: SessionV1.FilePart) {
  // label：优先文件名，其次资源 URI，最后原始 URL
  const label = part.filename ?? (part.source?.type === "resource" ? part.source.uri : part.url)
  // 返回说明文本（含 MIME 类型）
  return `[Attachment unavailable after migration: ${label} (${part.mime})]`
}

// syntheticID：为合成消息生成不冲突的 id——源 id 前缀 + 哈希派生后缀
function syntheticID(source: string, used: Set<string>) {
  // prefix：取源 id 的前 16 个字符
  const prefix = source.slice(0, 16)
  // alphabet：后缀使用的 62 进制字符表
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
  // 从 salt=0 起不断尝试，直到生成的 id 未被占用
  for (let salt = 0; ; salt++) {
    // hex：sha256("v1-synthetic:源id[:salt]") 的十六进制摘要
    const hex = new Bun.CryptoHasher("sha256").update(`v1-synthetic:${source}${salt ? `:${salt}` : ""}`).digest("hex")
    // value：把摘要当作大整数处理
    let value = BigInt(`0x${hex}`)
    // suffix：由大整数转 62 进制生成的后缀
    let suffix = ""
    // 目标长度 14 位
    while (suffix.length < 14) {
      // 每轮取最低位的 62 进制字符前插
      suffix = alphabet[Number(value % 62n)] + suffix
      // 整除 62 继续下一位
      value /= 62n
    }
    // id：前缀 + 后缀
    const id = prefix + suffix
    // 已被占用则换 salt 重试
    if (used.has(id)) continue
    // 登记占用并返回
    used.add(id)
    return id
  }
}

// serializeRecent：把压缩尾部的消息序列化为纯文本（供 compaction 消息回放）
function serializeRecent(
  messages: ReadonlyArray<{ row: SourceMessage; value: typeof SessionV1.Info.Type }>,
  parts: Map<string, Array<{ row: SourcePart; value: typeof SessionV1.Part.Type }>>,
) {
  // 逐条消息转文本后用空行拼接
  return messages
    .flatMap((message) => {
      // owned：该消息的分片
      const owned = parts.get(message.row.id)?.map((part) => part.value) ?? []
      // 用户消息：拼接未忽略的文本分片
      if (message.value.role === "user")
        return [
          `[User]: ${owned
            .filter((part) => part.type === "text" && !part.ignored)
            .map((part) => (part.type === "text" ? part.text : ""))
            .join("\n\n")}`,
        ]
      // 助手消息：保留文本与推理分片
      return owned.flatMap((part) =>
        part.type === "text"
          ? [`[Assistant]: ${part.text}`]
          : part.type === "reasoning" && part.text
            ? [`[Assistant reasoning]: ${part.text}`]
            : [],
      )
    })
    .join("\n\n")
}

// readState：从 kv 表读取迁移状态（缺失或损坏返回 undefined）
function readState(db: Database.Interface["db"]): Effect.Effect<MigrationState | undefined> {
  return db
    .select({ value: KVTable.value })
    .from(KVTable)
    .where(eq(KVTable.key, MIGRATION_STATE_KEY))
    .get()
    .pipe(
      // 解析状态值；读取失败视为不可恢复
      Effect.map((row) => parseState(row?.value)),
      Effect.orDie,
    )
}

// parseState：校验并解析迁移状态的原始值
function parseState(input: unknown): MigrationState | undefined {
  // 非对象或缺少 phase 字段则视为无效
  if (!input || typeof input !== "object" || !("phase" in input)) return
  // completed 阶段
  if (input.phase === "completed") return { phase: "completed" }
  // 未知阶段视为无效
  if (input.phase !== "sessions") return
  // sessions 阶段但无游标：从头开始
  if (!("cursor" in input) || input.cursor === undefined) return { phase: "sessions" }
  // 有游标则返回带游标的状态（游标必须是字符串）
  if (typeof input.cursor === "string") return { phase: "sessions", cursor: input.cursor }
}

// hasLegacySessions：判断当前库是否还有 V1 的 session 表（即存在遗留数据）
function hasLegacySessions(db: Database.Interface["db"]) {
  return db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session'`).pipe(
    // 查到行即代表表存在
    Effect.map((row) => row !== undefined),
    // 查询失败视为不可恢复
    Effect.orDie,
  )
}
