// 将本模块以命名空间 `SessionStats` 全量导出
export * as SessionStats from "./stats.js"

// 引入 Effect 原语与工具类型（DateTime/Option/Schema/Types）
import { DateTime, Effect, Option, Schema, type Types } from "effect"
// 引入 drizzle-orm 的条件构造器与 sql 模板标签
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm"
// 引入模型（Model）schema
import { Model } from "@opencode/schema/model"
// 引入金额（Money）schema
import { Money } from "@opencode/schema/money"
// 引入项目（Project）schema
import { Project } from "@opencode/schema/project"
// 引入供应商（Provider）schema
import { Provider } from "@opencode/schema/provider"
// 引入事件（Event）schema
import { Event } from "@opencode/schema/event"
// 引入会话事件（SessionEvent）schema
import { SessionEvent } from "@opencode/schema/session-event"
// 引入会话统计的工具模式（ToolMode）schema
import { ToolMode } from "@opencode/schema/session-stats"
// 引入 token 用量（TokenUsage）schema
import { TokenUsage } from "@opencode/schema/token-usage"
// 引入数据库服务
import { Database } from "../database/database.js"
// 引入批量分片工具
import { DatabaseBatch } from "../database/batch.js"
// 引入事件表（用于读取压缩用量事件）
import { EventTable } from "../event/sql.js"
// 引入会话消息表、部件表与会话表
import { SessionMessageTable, SessionPartTable, SessionTable } from "./sql.js"

// 统计查询输入
type Input = {
  // 起始时间（毫秒，可选）
  readonly from?: number
  // 结束时间（毫秒，可选，默认当前时刻）
  readonly to?: number
  // 按项目过滤（可选）
  readonly projectID?: Project.ID
  // 用于"活跃日"分组的时区（可选）
  readonly timezone?: string
  // 工具统计模式：none/summary/full（可选）
  readonly tools?: ToolMode
}

// 可变的 token 用量类型（DeepMutable 便于原地累加）
type Tokens = Types.DeepMutable<TokenUsage.Info>

// 消息查询结果行：模型与 token/成本字段均从 JSON 中提取
type MessageRow = {
  // 所属会话 ID
  sessionID: string
  // 父会话 ID（null 表示顶层会话）
  parentID: string | null
  // 消息类型：user 或 assistant
  type: "user" | "assistant"
  // 创建时间（毫秒）
  timeCreated: number
  // 供应商 ID（可能缺失）
  providerID: string | null
  // 模型 ID（可能缺失）
  modelID: string | null
  // 模型变体（可能缺失）
  variant: string | null
  // 输入 token 数（可能缺失）
  input: number | null
  // 输出 token 数（可能缺失）
  output: number | null
  // 推理 token 数（可能缺失）
  reasoning: number | null
  // 缓存读取 token 数（可能缺失）
  cacheRead: number | null
  // 缓存写入 token 数（可能缺失）
  cacheWrite: number | null
  // 成本（可能缺失）
  cost: number | null
}

// 工具部件查询结果行（full 模式的明细）
type ToolRow = {
  // 工具名（可能缺失）
  name: string | null
  // 执行状态（可能缺失）
  status: string | null
  // 执行时长（可能缺失）
  duration: number | null
}

// 工具汇总查询结果行（summary 模式的 SQL 聚合结果）
type ToolSummaryRow = {
  // 调用总数
  calls: number
  // 成功数
  succeeded: number
  // 失败数
  failed: number
  // 未完成数
  unfinished: number
}

// 按模型聚合的中间结构
type ModelAggregate = {
  // 模型引用（provider/model/variant）
  model: Model.Ref
  // 步数
  steps: number
  // token 用量
  tokens: Tokens
  // 成本
  cost: number
}

// 按工具聚合的中间结构（含时长样本）
type ToolAggregate = {
  // 工具名
  name: string
  // 调用数
  calls: number
  // 成功数
  succeeded: number
  // 失败数
  failed: number
  // 未完成数
  unfinished: number
  // 时长样本列表（用于求中位数）
  durations: number[]
}

// 压缩用量事件的宽松解码器（解码失败返回 None）
const decodeUsage = Schema.decodeUnknownOption(SessionEvent.UsageRecorded.data)
// 查询分窗大小：31 天（毫秒），避免单次查询范围过大
const Window = 31 * 24 * 60 * 60 * 1_000

// 时间范围非法错误：from 不早于 to
export class InvalidRangeError extends Schema.TaggedError<InvalidRangeError>()("SessionStats.InvalidRangeError", {
  from: Schema.Finite,
  to: Schema.Finite,
}) {}

// 汇总会话使用统计：会话数、token、成本、工具使用与每日活跃度
export const get = Effect.fn("SessionStats.get")(function* (input: Input = {}) {
  // 取数据库句柄
  const db = (yield* Database.Service).db
  // 结束时间默认为当前时刻
  const to = input.to ?? Date.now()
  // 起点不早于终点：返回非法范围错误
  if (input.from !== undefined && input.from >= to) return yield* new InvalidRangeError({ from: input.from, to })
  // 可选的项目过滤 SQL 片段（未指定项目时为空串）
  const project = input.projectID === undefined ? sql`` : sql`AND session.project_id = ${input.projectID}`
  // 起点默认取最早一条有效消息的时间；没有任何消息则用终点（区间为空）
  const from =
    input.from ??
    (yield* db
      .get<{ time: number | null }>(
        sql`
        SELECT min(message.time_created) AS time
        FROM ${SessionMessageTable} AS message
        JOIN ${SessionTable} AS session ON session.id = message.session_id
        WHERE message.type IN ('user', 'assistant')
          AND message.time_created < ${to}
          AND (session.fork_session_id IS NULL OR message.time_created >= session.time_created)
          ${project}
      `,
      )
      .pipe(Effect.orDie))?.time ??
    to
  // 将 [from, to) 切成不超过 31 天的连续窗口
  const ranges = windows(from, to)
  // 工具统计模式：默认 summary（仅计数）
  const toolMode = input.tools ?? "summary"
  // 参与统计的顶层会话 ID 集合
  const sessions = new Set<string>()
  // 子代理会话 ID 集合
  const subagents = new Set<string>()
  // 每日步数活跃度：日期键 → 步数
  const activity = new Map<string, number>()
  // 按模型聚合的映射：模型键 → 聚合结构
  const models = new Map<string, ModelAggregate>()
  // 按工具聚合的映射：工具名 → 聚合结构
  const tools = new Map<string, ToolAggregate>()
  // 全局累计：提示数/步数/token/成本
  const totals = {
    prompts: 0,
    steps: 0,
    tokens: emptyTokens(),
    cost: 0,
  }
  // 工具调用汇总计数
  const toolTotals = { calls: 0, succeeded: 0, failed: 0, unfinished: 0 }
  // 按指定时区生成日期键（YYYY-MM-DD）的函数
  const dateKey = makeDateKey(input.timezone)

  // 逐窗口查询消息行并聚合（串行执行，避免并发查询过多）
  yield* Effect.forEach(
    ranges,
    (range) =>
      db
        .all<MessageRow>(
          // 提取消息的模型/token/成本字段：同时兼容 part 表行与旧格式 content 内嵌 part
          sql`
          SELECT
            message.session_id AS sessionID,
            session.parent_id AS parentID,
            message.type AS type,
            message.time_created AS timeCreated,
            json_extract(message.data, '$.model.providerID') AS providerID,
            json_extract(message.data, '$.model.id') AS modelID,
            json_extract(message.data, '$.model.variant') AS variant,
            json_extract(message.data, '$.tokens.input') AS input,
            json_extract(message.data, '$.tokens.output') AS output,
            json_extract(message.data, '$.tokens.reasoning') AS reasoning,
            json_extract(message.data, '$.tokens.cache.read') AS cacheRead,
            json_extract(message.data, '$.tokens.cache.write') AS cacheWrite,
            json_extract(message.data, '$.cost') AS cost
          FROM ${SessionMessageTable} AS message
          JOIN ${SessionTable} AS session ON session.id = message.session_id
          WHERE message.type IN ('user', 'assistant')
            AND message.time_created >= ${range.from}
            AND message.time_created < ${range.to}
            AND (session.fork_session_id IS NULL OR message.time_created >= session.time_created)
            ${project}
        `,
        )
        .pipe(
          // 查询失败视为致命缺陷
          Effect.orDie,
          // 查询完成后同步聚合每一行
          Effect.tap((rows) =>
            Effect.sync(() => {
              // 遍历该窗口的每一行
              rows.forEach((row) => {
                // 无父会话：计入顶层会话集合
                if (row.parentID === null) sessions.add(row.sessionID)
                // 有父会话：计入子代理会话集合
                else subagents.add(row.sessionID)
                // 用户消息只参与提示数统计，其余字段不累计
                if (row.type === "user") {
                  // 仅顶层用户消息算一次提示
                  if (row.parentID === null) totals.prompts++
                  return
                }

                // 助手消息算一步
                totals.steps++
                // 提取该行的 token 用量
                const tokens = rowTokens(row)
                // 累加到全局 token 汇总
                addTokens(totals.tokens, tokens)
                // 累加成本（缺失按 0）
                totals.cost += row.cost ?? 0
                // 按时区得到该行的日期键
                const day = dateKey(row.timeCreated)
                // 该日步数 +1
                activity.set(day, (activity.get(day) ?? 0) + 1)
                // 缺供应商或模型 ID：跳过模型聚合
                if (!row.providerID || !row.modelID) return
                // 模型键：provider/model#variant
                const key = `${row.providerID}/${row.modelID}#${row.variant ?? ""}`
                // 取或初始化该模型的聚合结构
                const model = models.get(key) ?? {
                  model: {
                    providerID: Provider.ID.make(row.providerID),
                    id: Model.ID.make(row.modelID),
                    variant: row.variant ? Model.VariantID.make(row.variant) : undefined,
                  },
                  steps: 0,
                  tokens: emptyTokens(),
                  cost: 0,
                }
                // 写回映射
                models.set(key, model)
                // 模型步数 +1
                model.steps++
                // 模型成本累加
                model.cost += row.cost ?? 0
                // 模型 token 累加
                addTokens(model.tokens, tokens)
              })
            }),
          ),
        ),
    { concurrency: 1, discard: true },
  )

  // none 模式：跳过工具统计
  if (toolMode !== "none")
    // 逐窗口查询工具调用并聚合（串行执行）
    yield* Effect.forEach(
      ranges,
      (range) => {
        // 汇总模式：SQL 端聚合，只取计数不取明细
        if (toolMode === "summary")
          return db
            .get<ToolSummaryRow>(
              // 聚合查询：UNION ALL 同时覆盖 part 表行与旧格式消息内嵌的 content tool 项
              sql`
            WITH calls AS MATERIALIZED (
              SELECT json_extract(part.data, '$.state.status') AS status
              FROM ${SessionPartTable} AS part
              JOIN ${SessionMessageTable} AS message ON message.id = part.message_id
              JOIN ${SessionTable} AS session ON session.id = message.session_id
              WHERE message.type = 'assistant'
                AND message.time_created >= ${range.from}
                AND message.time_created < ${range.to}
                AND (session.fork_session_id IS NULL OR message.time_created >= session.time_created)
                AND part.type = 'tool'
                ${project}
              UNION ALL
              SELECT json_extract(content.value, '$.state.status') AS status
              FROM ${SessionMessageTable} AS message
              JOIN ${SessionTable} AS session ON session.id = message.session_id,
                json_each(message.data, '$.content') AS content
              WHERE message.type = 'assistant'
                AND message.time_created >= ${range.from}
                AND message.time_created < ${range.to}
                AND (session.fork_session_id IS NULL OR message.time_created >= session.time_created)
                AND json_array_length(message.data, '$.content') > 0
                AND json_extract(content.value, '$.type') = 'tool'
                ${project}
            )
            SELECT
              count(*) AS calls,
              count(*) FILTER (WHERE status = 'completed') AS succeeded,
              count(*) FILTER (WHERE status = 'error') AS failed,
              count(*) FILTER (WHERE status IS NULL OR status NOT IN ('completed', 'error')) AS unfinished
            FROM calls
          `,
            )
            .pipe(
              // 查询失败视为致命
              Effect.orDie,
              // 把聚合结果累加进全局工具计数
              Effect.tap((row) =>
                Effect.sync(() => {
                  // 无结果行：跳过
                  if (!row) return
                  // 累加调用/成功/失败/未完成计数
                  toolTotals.calls += row.calls
                  toolTotals.succeeded += row.succeeded
                  toolTotals.failed += row.failed
                  toolTotals.unfinished += row.unfinished
                }),
              ),
              // 结果仅用于副作用
              Effect.asVoid,
            )
        // 完整模式：取每条工具调用的名称/状态/时长明细
        return db
          .all<ToolRow>(
            // 明细查询：同样 UNION ALL 兼容两种存储形态；时长 = 完成时间 - 开始（或创建）时间
            sql`
          SELECT
            json_extract(part.data, '$.name') AS name,
            json_extract(part.data, '$.state.status') AS status,
            CASE
              WHEN json_extract(part.data, '$.time.completed') IS NULL THEN NULL
              ELSE json_extract(part.data, '$.time.completed')
                - coalesce(json_extract(part.data, '$.time.ran'), json_extract(part.data, '$.time.created'))
            END AS duration
          FROM ${SessionPartTable} AS part
          JOIN ${SessionMessageTable} AS message ON message.id = part.message_id
          JOIN ${SessionTable} AS session ON session.id = message.session_id
          WHERE message.type = 'assistant'
            AND message.time_created >= ${range.from}
            AND message.time_created < ${range.to}
            AND (session.fork_session_id IS NULL OR message.time_created >= session.time_created)
            AND part.type = 'tool'
            ${project}
          UNION ALL
          SELECT
            json_extract(content.value, '$.name') AS name,
            json_extract(content.value, '$.state.status') AS status,
            CASE
              WHEN json_extract(content.value, '$.time.completed') IS NULL THEN NULL
              ELSE json_extract(content.value, '$.time.completed')
                - coalesce(json_extract(content.value, '$.time.ran'), json_extract(content.value, '$.time.created'))
            END AS duration
          FROM ${SessionMessageTable} AS message
          JOIN ${SessionTable} AS session ON session.id = message.session_id,
            json_each(message.data, '$.content') AS content
          WHERE message.type = 'assistant'
            AND message.time_created >= ${range.from}
            AND message.time_created < ${range.to}
            AND (session.fork_session_id IS NULL OR message.time_created >= session.time_created)
            AND json_array_length(message.data, '$.content') > 0
            AND json_extract(content.value, '$.type') = 'tool'
            ${project}
        `,
          )
          .pipe(
            // 查询失败视为致命
            Effect.orDie,
            // 聚合每一行到工具映射
            Effect.tap((rows) =>
              Effect.sync(() => {
                // 遍历该窗口的每一行
                rows.forEach((row) => {
                  // 累加全局工具计数（calls/succeeded/failed/unfinished）
                  addToolStatus(toolTotals, row.status)
                  // 无工具名：只计入总数，不进明细
                  if (!row.name) return
                  // 取或初始化该工具的聚合结构
                  const tool = tools.get(row.name) ?? {
                    name: row.name,
                    calls: 0,
                    succeeded: 0,
                    failed: 0,
                    unfinished: 0,
                    durations: [],
                  }
                  // 写回映射
                  tools.set(row.name, tool)
                  // 该工具计数累加
                  addToolStatus(tool, row.status)
                  // 有时长样本则收集起来（用于中位数）
                  if (row.duration !== null) tool.durations.push(row.duration)
                })
              }),
            ),
            // 结果仅用于副作用
            Effect.asVoid,
          )
      },
      { concurrency: 1, discard: true },
    )

  // 取相关项目（或全部）的会话 ID 列表
  const ids = yield* db
    .select({ id: SessionTable.id })
    .from(SessionTable)
    .where(input.projectID === undefined ? undefined : eq(SessionTable.project_id, input.projectID))
    .all()
    .pipe(Effect.orDie)
  // 查询这些会话在时间范围内的"压缩用量"事件（分批并发，避免超长 IN 列表）
  const events = (yield* Effect.forEach(
    // 按每批 1 个、最多 3 批一组切分 ID
    DatabaseBatch.batches(
      ids.map((row) => row.id),
      1,
      3,
    ),
    // 每批查询一次事件表
    (batch) =>
      db
        .select({ data: EventTable.data })
        .from(EventTable)
        .where(
          // 组合条件：本批会话 + 压缩用量事件类型 + 来源为压缩 + 时间范围
          and(
            // 限定聚合 ID 在本批会话内
            inArray(EventTable.aggregate_id, batch),
            // 事件类型为压缩用量记录（带持久化版本号）
            eq(
              EventTable.type,
              Event.versionedType(SessionEvent.UsageRecorded.type, SessionEvent.UsageRecorded.durable.version),
            ),
            // 来源必须是 compaction（消息表已统计过常规用量）
            sql`json_extract(${EventTable.data}, '$.source') = 'compaction'`,
            // 创建时间不早于起点
            gte(EventTable.created, from),
            // 创建时间早于终点
            lt(EventTable.created, to),
          ),
        )
        .all()
        .pipe(Effect.orDie),
    // 最多 4 批并发
    { concurrency: 4 },
  )).flat()
  // 解码并累加压缩用量事件
  events.forEach((row) => {
    // 宽松解码事件数据
    const decoded = decodeUsage(row.data)
    // 无法解码：跳过
    if (Option.isNone(decoded)) return
    // token 累加进全局汇总
    addTokens(totals.tokens, decoded.value.tokens)
    // 成本累加进全局汇总
    totals.cost += decoded.value.cost
  })

  // 活跃日列表：按日期字符串升序排序
  const days = [...activity.entries()].sort(([a], [b]) => a.localeCompare(b))
  // 组装并返回统计结果
  return {
    // 统计范围（毫秒时间戳转 DateTime）
    range: { from: DateTime.makeUnsafe(from), to: DateTime.makeUnsafe(to) },
    // 顶层会话数
    sessions: sessions.size,
    // 子代理会话数
    subagents: subagents.size,
    // 提示（用户消息）数
    prompts: totals.prompts,
    // 步数（助手消息数）
    steps: totals.steps,
    // token 汇总
    tokens: totals.tokens,
    // 成本（转为美元金额）
    cost: Money.USD.make(totals.cost),
    // 工具统计：按模式返回——none 只带模式；summary 带汇总；full 再带按调用数排序的明细
    tools:
      toolMode === "none"
        ? { mode: toolMode }
        : toolMode === "summary"
          ? { mode: toolMode, totals: toolTotals }
          : {
              mode: toolMode,
              totals: toolTotals,
              usage: [...tools.values()]
                // 按调用次数降序排列
                .sort((a, b) => b.calls - a.calls)
                .map((tool) => ({
                  name: tool.name,
                  calls: tool.calls,
                  succeeded: tool.succeeded,
                  failed: tool.failed,
                  unfinished: tool.unfinished,
                  // 时长中位数
                  durationP50: median(tool.durations),
                })),
            },
    // 活跃天数
    activeDays: days.length,
    // 最长连续活跃天数
    streak: longestStreak(days.map(([date]) => date)),
    // 每日步数
    activity: days.map(([date, steps]) => ({ date, steps })),
    // 模型明细：按总 token 降序，成本转为美元
    models: [...models.values()]
      .sort((a, b) => TokenUsage.total(b.tokens) - TokenUsage.total(a.tokens))
      .map((model) => ({ ...model, cost: Money.USD.make(model.cost) })),
  }
})

// 将时间范围切分为不超过 Window（31 天）的连续窗口
function windows(from: number, to: number) {
  return Array.from({ length: Math.ceil((to - from) / Window) }, (_, index) => ({
    // 窗口起点：from 加上 index 个窗口长
    from: from + index * Window,
    // 窗口终点：不超过整个范围的终点
    to: Math.min(to, from + (index + 1) * Window),
  }))
}

// 从消息行提取 token 用量（缺失字段按 0 计）
function rowTokens(row: MessageRow): Tokens {
  return {
    input: row.input ?? 0,
    output: row.output ?? 0,
    reasoning: row.reasoning ?? 0,
    cache: { read: row.cacheRead ?? 0, write: row.cacheWrite ?? 0 },
  }
}

// 构造全零的 token 用量（初始化累加器用）
function emptyTokens(): Tokens {
  return { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
}

// 将 source 的各 token 维度累加进 target（原地修改）
function addTokens(target: Tokens, source: TokenUsage.Info) {
  // 输入 token
  target.input += source.input
  // 输出 token
  target.output += source.output
  // 推理 token
  target.reasoning += source.reasoning
  // 缓存读取 token
  target.cache.read += source.cache.read
  // 缓存写入 token
  target.cache.write += source.cache.write
}

// 按状态累加工具调用计数（calls 恒 +1，按 completed/error/其他分流）
function addToolStatus(
  target: { calls: number; succeeded: number; failed: number; unfinished: number },
  status: string | null,
) {
  // 调用总数 +1
  target.calls++
  // 完成：成功数 +1
  if (status === "completed") {
    target.succeeded++
    return
  }
  // 出错：失败数 +1
  if (status === "error") {
    target.failed++
    return
  }
  // 其余（含无状态）：未完成 +1
  target.unfinished++
}

// 生成"把时间戳映射为指定时区 YYYY-MM-DD"的日期键函数
function makeDateKey(timezone = "UTC") {
  // 固定美式（en-US）格式化器：保证字段拆解稳定，时区来自入参
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
  // 将格式化结果按字段类型重组为 YYYY-MM-DD
  return (time: number) => {
    // formatToParts 得到各字段，再按 type 建立映射
    const parts = Object.fromEntries(formatter.formatToParts(time).map((part) => [part.type, part.value]))
    // 拼接为标准日期键
    return `${parts.year}-${parts.month}-${parts.day}`
  }
}

// 计算最长连续活跃天数（相邻日期序号差 1 视为连续）
function longestStreak(days: string[]) {
  return days.reduce(
    (result, day, index) => {
      // 前一个活跃日
      const previous = days[index - 1]
      // 与前一日相邻则连续天数 +1，否则重置为 1
      const current = previous && dayOrdinal(day) - dayOrdinal(previous) === 1 ? result.current + 1 : 1
      // 更新当前连续数与历史最长
      return { current, longest: Math.max(result.longest, current) }
    },
    { current: 0, longest: 0 },
  ).longest
}

// 将日期字符串（YYYY-MM-DD）转为自纪元起的天数序号（用于相邻判断）
function dayOrdinal(value: string) {
  // 拆出年月日并转数字
  const [year, month, day] = value.split("-").map(Number)
  // 用 UTC 毫秒数除以一天的毫秒数得到天数
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000)
}

// 计算中位数：偶数个样本取中间两数的均值
function median(values: number[]) {
  // 无样本：返回 undefined
  if (values.length === 0) return undefined
  // 升序排序副本
  const sorted = values.toSorted((a, b) => a - b)
  // 中间位置
  const middle = Math.floor(sorted.length / 2)
  // 偶数取均值，奇数取正中元素
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}
