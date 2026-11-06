// 引入 drizzle-orm 的 SQLite 构表原语：二进制列、表、文本列、整数列、索引、复合主键、浮点列、唯一索引
import { blob, sqliteTable, text, integer, index, primaryKey, real, uniqueIndex } from "drizzle-orm/sqlite-core"
// 引入 sql 模板标签，用于书写部分索引（partial index）的原生 SQL 条件
import { sql } from "drizzle-orm"
// 引入目录列与子路径列构造器（规范化存储路径）
import { directoryColumn, pathColumn } from "../database/path.js"
// 引入项目表定义，用于建立会话到项目的外键
import { ProjectTable } from "../project/sql.js"
// 引入会话消息模块的类型（仅类型）
import type { SessionMessage } from "./message.js"
// 引入会话收件箱（inbox）的类型（仅类型）
import type { SessionInbox } from "./inbox.js"
// 引入代理（Agent）schema 类型（仅类型）
import type { Agent } from "@opencode/schema/agent"
// 引入文件差异（FileDiff）类型（仅类型）
import type { FileDiff } from "@opencode/schema/file-diff"
// 引入权限（Permission）类型（仅类型）
import type { Permission } from "@opencode/schema/permission"
// 引入项目（Project）类型（仅类型）
import type { Project } from "@opencode/schema/project"
// 引入会话 schema 类型（仅类型）
import type { SessionSchema } from "./schema.js"
// 引入会话存储载荷类型（仅类型）
import type { SessionStored } from "./stored.js"
// 引入工作区（Workspace）类型（仅类型）
import type { Workspace } from "@opencode/schema/workspace"
// 引入通用时间戳列组（time_created/time_updated 等）
import { Timestamps } from "../database/schema.sql.js"
// 引入指令（Instruction）类型（仅类型）
import type { Instruction } from "@opencode/schema/instruction"
// 引入会话（Session）类型（仅类型）
import type { Session } from "@opencode/schema/session"
// 引入收件箱载荷类型：压缩（compaction）、移动（move）、合成（synthetic）消息
import type { CompactionPayload, MovePayload, SyntheticPayload } from "@opencode/schema/session-inbox"
// 引入旧版回滚（RevertV1）类型（仅类型）
import type { RevertV1 } from "@opencode/schema/session-revert"
// 引入 effect 的 Schema（用于声明任意 JSON 值类型）
import type { Schema } from "effect"

// 分布式 Omit：对联合类型的每个成员分别剔除属性 K（保留联合的分支结构）
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
// 消息存储行的 data 类型：非 user 类型的会话消息编码，或带媒体引用的 user 消息编码；剔除 type 与 id（两者单独成列）
type SessionMessageData = DistributiveOmit<
  Exclude<(typeof SessionMessage.Info)["Encoded"], { readonly type: "user" }> | (typeof SessionStored.User)["Encoded"],
  "type" | "id"
>
// 消息部件（part）存储行的 data 类型：助手内容的编码形式
export type SessionPartData = SessionMessage.AssistantContentEncoded

// 会话表（session_v2）：每个会话一行
export const SessionTable = sqliteTable(
  "session_v2",
  {
    // 会话 ID（主键）
    id: text().$type<SessionSchema.ID>().primaryKey(),
    // 所属项目 ID（非空，随项目级联删除）
    project_id: text()
      .$type<Project.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    // 所属工作区 ID（可选）
    workspace_id: text().$type<Workspace.ID>(),
    // 父会话 ID（子代理会话时存在）
    parent_id: text().$type<SessionSchema.ID>(),
    // 分叉（fork）来源会话 ID
    fork_session_id: text().$type<SessionSchema.ID>(),
    // 分叉边界信息（JSON）
    fork_boundary: text({ mode: "json" }).$type<Session.ForkBoundary>(),
    // URL 友好的短标识符（非空）
    slug: text().notNull(),
    // 会话所在目录（规范化绝对路径，非空）
    directory: directoryColumn().notNull(),
    // 相对项目根的子路径（可选）
    path: pathColumn(),
    // 会话标题（可选）
    title: text(),
    // 创建会话时的客户端版本（非空）
    version: text().notNull(),
    // 分享链接（可选）
    share_url: text(),
    // 汇总：新增行数
    summary_additions: integer(),
    // 汇总：删除行数
    summary_deletions: integer(),
    // 汇总：变更文件数
    summary_files: integer(),
    // 汇总：旧版文件差异信息数组（JSON）
    summary_diffs: text({ mode: "json" }).$type<FileDiff.LegacyInfo[]>(),
    // 会话元数据（JSON）
    metadata: text({ mode: "json" }).$type<Session.Metadata>(),
    // 累计成本（美元，非空，默认 0）
    cost: real().notNull().default(0),
    // 累计输入 token 数（非空，默认 0）
    tokens_input: integer().notNull().default(0),
    // 累计输出 token 数（非空，默认 0）
    tokens_output: integer().notNull().default(0),
    // 累计推理（reasoning）token 数（非空，默认 0）
    tokens_reasoning: integer().notNull().default(0),
    // 累计缓存读取 token 数（非空，默认 0）
    tokens_cache_read: integer().notNull().default(0),
    // 累计缓存写入 token 数（非空，默认 0）
    tokens_cache_write: integer().notNull().default(0),
    // 回滚（revert）状态快照（JSON，兼容新版与 RevertV1 两种格式）
    revert: text({ mode: "json" }).$type<Session.Revert | RevertV1>(),
    // 会话级权限规则集（JSON）
    permission: text({ mode: "json" }).$type<Permission.Ruleset>(),
    // 会话绑定的代理 ID
    agent: text().$type<Agent.ID>(),
    // 会话默认模型（JSON：providerID/id/variant）
    model: text({ mode: "json" }).$type<{
      id: string
      providerID: string
      variant?: string
    }>(),
    // 展开通用时间戳列（time_created/time_updated）
    ...Timestamps,
    // 最近一次"忙碌"心跳时间
    time_busy: integer(),
    // 进入空闲的时间
    time_idle: integer(),
    // 最近一次被客户端查看的时间
    time_viewed: integer(),
    // 空闲结束时的结果（如用户接管等）
    idle_outcome: text().$type<NonNullable<Session.Info["outcome"]>>(),
    // 开始压缩（compaction）上下文的时间
    time_compacting: integer(),
    // 归档时间
    time_archived: integer(),
    // 执行声明（execution claim）时间戳（沿用历史列名，见 SessionStore.claim）
    /** The execution claim timestamp (historical column name; see SessionStore.claim). */
    time_suspended: integer(),
    // 孤儿执行声明的恢复尝试次数（非空，默认 0）
    resume_attempts: integer().notNull().default(0),
  },
  // 表索引定义
  (table) => [
    // 按项目查会话的索引
    index("session_v2_project_idx").on(table.project_id),
    // 按工作区查会话的索引
    index("session_v2_workspace_idx").on(table.workspace_id),
    // 按父会话查子会话的索引
    index("session_v2_parent_idx").on(table.parent_id),
    // 执行声明的部分索引：仅索引已声明执行中（time_suspended 非空）的会话
    index("session_v2_time_suspended_idx")
      .on(table.time_suspended)
      .where(sql`${table.time_suspended} is not null`),
  ],
)

// 会话消息表：每个会话的消息（user/assistant/shell 等类型）按序号存储
export const SessionMessageTable = sqliteTable(
  "session_message",
  {
    // 消息 ID（主键）
    id: text().$type<SessionMessage.ID>().primaryKey(),
    // 所属会话 ID（非空，随会话级联删除）
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    // 消息类型（非空）
    type: text().$type<SessionMessage.Type>().notNull(),
    // 会话内单调递增序号（非空），用于排序与游标分页
    seq: integer().notNull(),
    // 展开通用时间戳列
    ...Timestamps,
    // 消息负载（JSON，非空）
    data: text({ mode: "json" }).notNull().$type<SessionMessageData>(),
  },
  // 表索引定义
  (table) => [
    // 唯一索引：(session_id, seq)，保证同一会话内序号唯一
    uniqueIndex("session_message_session_seq_idx").on(table.session_id, table.seq),
    // 索引：(session_id, type, seq)，加速按类型过滤的消息查询
    index("session_message_session_type_seq_idx").on(table.session_id, table.type, table.seq),
    // 索引：(session_id, time_created, id)，加速按时间的稳定游标分页
    index("session_message_session_time_created_id_idx").on(table.session_id, table.time_created, table.id),
    // 索引：按创建时间跨会话查询
    index("session_message_time_created_idx").on(table.time_created),
  ],
)

// 会话消息部件表：助手消息的 content 拆分成独立的 part 行
export const SessionPartTable = sqliteTable(
  "session_part",
  {
    // 所属消息 ID（非空，随消息级联删除）
    message_id: text()
      .$type<SessionMessage.ID>()
      .notNull()
      .references(() => SessionMessageTable.id, { onDelete: "cascade" }),
    // 所属会话 ID（冗余存储，非空，随会话级联删除）
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    // 消息内的部件序号（非空）
    ordinal: integer().notNull(),
    // 部件类型（text/reasoning/tool 等，非空）
    type: text().$type<SessionMessage.AssistantContent["type"]>().notNull(),
    // 工具调用 ID（tool 部件时存在）
    call_id: text(),
    // 展开通用时间戳列
    ...Timestamps,
    // 部件负载（JSON，非空）
    data: text({ mode: "json" }).notNull().$type<SessionPartData>(),
  },
  // 表索引定义
  (table) => [
    // 复合主键：(message_id, ordinal)，保证消息内部件序号唯一
    primaryKey({ columns: [table.message_id, table.ordinal] }),
    // 索引：按会话+消息+序号检索部件
    index("session_part_session_message_idx").on(table.session_id, table.message_id, table.ordinal),
  ],
)

// 会话收件箱表：待投递给会话运行器的消息队列
export const SessionInboxTable = sqliteTable(
  "session_inbox",
  {
    // 收件项 ID（主键）
    id: text().$type<SessionMessage.ID>().primaryKey(),
    // 目标会话 ID（非空，随会话级联删除）
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    // 收件项类型（非空）
    type: text().$type<SessionInbox.Info["type"]>().notNull(),
    // 收件项负载（JSON，非空）：用户载荷/合成/压缩/移动之一
    payload: text({ mode: "json" })
      .$type<SessionStored.UserPayload | SyntheticPayload | CompactionPayload | MovePayload>()
      .notNull(),
    // 投递状态（非空）
    delivery: text().$type<SessionInbox.Delivery>().notNull(),
    // 入队时的事件序号（非空），用于保持投递顺序
    enqueued_seq: integer().notNull(),
    // 创建时间（非空，默认当前毫秒）
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  // 表索引定义
  (table) => [
    // 索引：按会话+投递状态+入队序号取待投递项
    index("session_inbox_session_delivery_seq_idx").on(table.session_id, table.delivery, table.enqueued_seq),
    // 唯一索引：同一会话内入队序号唯一
    uniqueIndex("session_inbox_session_enqueued_seq_idx").on(table.session_id, table.enqueued_seq),
  ],
)

// 会话指令条目表：记录会话内指令（instruction）键值的应用/移除记录
export const InstructionEntryTable = sqliteTable(
  "instruction_entry",
  {
    // 所属会话 ID（非空，随会话级联删除）
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    // 指令键（非空）
    key: text().notNull(),
    // 指令值（JSON，可选）
    value: text({ mode: "json" }).$type<Schema.Json>(),
    // 是否已移除该指令（布尔列，非空，默认 false）
    removed: integer({ mode: "boolean" }).notNull().default(false),
    // 展开通用时间戳列
    ...Timestamps,
  },
  // 复合主键：(session_id, key)
  (table) => [primaryKey({ columns: [table.session_id, table.key] })],
)

// 指令内容去重表：按内容哈希存储指令的原始 JSON
export const InstructionBlobTable = sqliteTable("instruction_blob", {
  // 内容哈希（主键）
  hash: text().$type<Instruction.Hash>().primaryKey(),
  // 指令原始内容（JSON）
  value: text({ mode: "json" }).$type<Schema.Json>(),
})

// 会话指令状态表：每个会话一行，跟踪指令值随消息流的演进
export const InstructionStateTable = sqliteTable("instruction_state", {
  // 所属会话 ID（主键，随会话级联删除）
  session_id: text()
    .$type<SessionSchema.ID>()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  // 指令纪元（epoch）起始的事件序号（非空）
  epoch_start: integer().notNull(),
  // 指令已应用到的消息序号（非空）
  through_seq: integer().notNull(),
  // 纪元起始时的指令值快照（JSON，非空）
  initial_values: text({ mode: "json" }).notNull().$type<Instruction.Values>(),
  // 当前指令值（JSON，非空）
  current_values: text({ mode: "json" }).notNull().$type<Instruction.Values>(),
})

// 二进制大对象（blob）表：按内容哈希存储内联媒体文件的原始字节
export const BlobTable = sqliteTable("blob", {
  // 内容 SHA-256 哈希（主键）
  hash: text().primaryKey(),
  // MIME 类型（非空）
  mime: text().notNull(),
  // 字节大小（非空）
  bytes: integer().notNull(),
  // 图片宽度（可选）
  width: integer(),
  // 图片高度（可选）
  height: integer(),
  // 原始字节（非空）
  data: blob({ mode: "buffer" }).notNull(),
  // 创建时间（非空，默认当前毫秒）
  time_created: integer()
    .notNull()
    .$default(() => Date.now()),
})

// blob 引用表：记录哪条消息引用了哪个 blob（用于清理与还原）
export const BlobRefTable = sqliteTable(
  "blob_ref",
  {
    // 所属会话 ID（非空，随会话级联删除）
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    // 引用方消息 ID（非空）
    message_id: text().$type<SessionMessage.ID>().notNull(),
    // 被引用的 blob 哈希（非空，随 blob 级联删除）
    hash: text()
      .notNull()
      .references(() => BlobTable.hash, { onDelete: "cascade" }),
    // 消息内引用序号（非空）
    seq: integer().notNull(),
  },
  // 表索引定义
  (table) => [
    // 复合主键：(session_id, message_id, hash)
    primaryKey({ columns: [table.session_id, table.message_id, table.hash] }),
    // 索引：按哈希反查引用（判断 blob 是否仍被使用）
    index("blob_ref_hash_idx").on(table.hash),
    // 索引：按会话+序号检索引用
    index("blob_ref_session_seq_idx").on(table.session_id, table.seq),
  ],
)
