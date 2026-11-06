// 会话信息（Session.Info）映射模块：把 sessions 数据库表中的一行记录
// 转换为会话的领域对象 SessionSchema.Info，供存储层对外提供统一的会话信息。
import { DateTime, Schema } from "effect"
// Model 模式（schema）：提供模型 ID、变体（variant）等品牌类型的构造器
import { Model } from "@opencode/schema/model"
// Provider 模式：提供模型提供商（provider）ID 的品牌类型构造器
import { Provider } from "@opencode/schema/provider"
// 绝对路径（AbsolutePath）与相对路径（RelativePath）的品牌类型构造器
import { AbsolutePath, RelativePath } from "../schema.js"
// 会话领域的 Schema 定义（其中包含 Info 结构）
import { SessionSchema } from "./schema.js"
// 会话表的 Drizzle 表定义类型，用于推导查询行的类型
import type { SessionTable } from "./sql.js"
// 持久化的回滚（revert）信息模式
import { PersistedRevert } from "@opencode/schema/session-revert"
// 金额（Money）工具：把数值构造成带币种语义的成本对象
import { Money } from "@opencode/schema/money"

// 创建一个同步解码器：把数据库里存储的 JSON 回滚信息校验并解码为 PersistedRevert 类型
const decodeRevert = Schema.decodeUnknownSync(PersistedRevert)

// 把会话表的一行查询结果（row）转换为会话 Info 对象
export function fromRow(row: typeof SessionTable.$inferSelect): SessionSchema.Info {
  // 用 Info.make 构造并校验整个会话信息对象
  return SessionSchema.Info.make({
    // 会话唯一标识（ID），直接取自行记录
    id: row.id,
    // 所属项目 ID
    projectID: row.project_id,
    // 会话标题；数据库中的 NULL 归一化为 undefined
    title: row.title ?? undefined,
    // 父会话 ID（子任务/派生会话才有）；NULL 归一化为 undefined
    parentID: row.parent_id ?? undefined,
    // fork 信息：只有同时记录了源会话 ID 和回放边界（boundary）时才组装，否则为 undefined
    fork:
      row.fork_session_id && row.fork_boundary
        ? {
            sessionID: row.fork_session_id,
            boundary: row.fork_boundary,
          }
        : undefined,
    // 会话绑定的 agent（智能体）名称；NULL 归一化为 undefined
    agent: row.agent ?? undefined,
    // 会话选用的模型：把数据库字段转换为品牌化的模型/提供商 ID，无记录则为 undefined
    model: row.model
      ? {
          id: Model.ID.make(row.model.id),
          providerID: Provider.ID.make(row.model.providerID),
          variant: Model.VariantID.make(row.model.variant ?? "default"),
        }
      : undefined,
    // 会话累计成本（美元），用 Money.USD.make 构造成本对象
    cost: Money.USD.make(row.cost),
    // token 用量统计：输入、输出、推理
    tokens: {
      input: row.tokens_input,
      output: row.tokens_output,
      reasoning: row.tokens_reasoning,
      // 缓存（prompt cache）读写的 token 数
      cache: {
        read: row.tokens_cache_read,
        write: row.tokens_cache_write,
      },
    },
    // 会话位置：所在目录（绝对路径）与工作区 ID（可选）
    location: {
      directory: AbsolutePath.make(row.directory),
      workspaceID: row.workspace_id ?? undefined,
    },
    // 项目内的相对子路径（可选），用于在项目目录下再分层
    subpath: row.path ? RelativePath.make(row.path) : undefined,
    // 附加元数据（JSON）；NULL 归一化为 undefined
    metadata: row.metadata ?? undefined,
    // 会话级权限配置；NULL 归一化为 undefined
    permissions: row.permission ?? undefined,
    // 回滚信息：存在则用解码器解码校验，否则为 undefined
    revert: row.revert ? decodeRevert(row.revert) : undefined,
    // 会话空闲（执行结束）时的结果记录；NULL 归一化为 undefined
    outcome: row.idle_outcome ?? undefined,
    // 各类时间戳：用 DateTime.makeUnsafe 把毫秒数转换为 DateTime
    time: {
      created: DateTime.makeUnsafe(row.time_created),
      updated: DateTime.makeUnsafe(row.time_updated),
      busy: row.time_busy === null ? undefined : DateTime.makeUnsafe(row.time_busy),
      idle: row.time_idle === null ? undefined : DateTime.makeUnsafe(row.time_idle),
      viewed: row.time_viewed === null ? undefined : DateTime.makeUnsafe(row.time_viewed),
      archived: row.time_archived === null ? undefined : DateTime.makeUnsafe(row.time_archived),
    },
  })
}
