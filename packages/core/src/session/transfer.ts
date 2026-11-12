// 将本模块以命名空间 `SessionTransfer` 全量导出
export * as SessionTransfer from "./transfer.js"

// 引入会话传输（session-transfer）数据 schema
import { SessionTransfer } from "@opencode/schema/session-transfer"
// 引入工具（Tool）schema（净化工具内容时使用）
import { Tool } from "@opencode/schema/tool"
// 引入技能（Skill）schema（净化技能名时使用）
import { Skill } from "@opencode/schema/skill"
// 引入 drizzle-orm 的等值条件构造器
import { eq } from "drizzle-orm"
// 引入 Effect 原语：时钟、服务容器、时间、层与 Schema
import { Clock, Context, DateTime, Effect, Layer, Schema } from "effect"
// 引入 effect/Array 的 map（对工具内容数组逐项映射）
import { map } from "effect/Array"
// 引入 path 模块（计算相对路径）
import path from "path"
// 引入全局服务节点构造工具
import { makeGlobalNode } from "@opencode/util/effect/app-node"
// 引入应用元数据服务
import { App } from "../app.js"
// 引入事件总线服务
import { Bus } from "../bus.js"
// 引入数据库服务
import { Database } from "../database/database.js"
// 引入批量插入分片工具
import { DatabaseBatch } from "../database/batch.js"
// 引入实例服务
import { Instance } from "../instance/service.js"
// 引入位置（Location）类型
import { Location } from "../location.js"
// 引入项目服务
import { Project } from "../project.js"
// 引入项目的插入/更新函数
import { upsertProject } from "../project/sql.js"
// 引入绝对路径与相对路径 schema
import { AbsolutePath, RelativePath } from "../schema.js"
// 引入会话服务
import { Session } from "../session.js"
// 引入短标识（slug）生成器
import { Slug } from "../util/slug.js"
// 引入会话 blob 存储模块
import { SessionBlob } from "./blob.js"
// 引入会话事件定义
import { SessionEvent } from "./event.js"
// 引入会话消息模块
import { SessionMessage } from "./message.js"
// 引入会话投影器（用于识别重复投影缺陷）
import { SessionProjector } from "./projector.js"
// 引入会话表与消息表
import { SessionMessageTable, SessionTable } from "./sql.js"

// 传输数据类型：转发 schema 的定义
export const Data = SessionTransfer.Data
// Data 的类型别名
export type Data = SessionTransfer.Data

// 导入冲突错误：目标会话 ID 已存在
export class ImportConflictError extends Schema.TaggedError<ImportConflictError>()(
  "SessionTransfer.ImportConflictError",
  { sessionID: Session.ID },
) {}

// 服务接口：导出（可脱敏）与导入会话
export interface Interface {
  readonly export: (input: {
    sessionID: Session.ID
    sanitize?: boolean
  }) => Effect.Effect<Data, Session.NotFoundError | Session.MessageDecodeError>
  readonly import: (input: {
    data: Data
    location: Location.Ref
  }) => Effect.Effect<Session.Info, ImportConflictError | Session.NotFoundError>
}

// 定义可注入的服务标识（Context.Tag）
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionTransfer") {}

// 构建服务实现层
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const app = yield* App.Service
    const bus = yield* Bus.Service
    // 取数据库句柄
    const { db } = yield* Database.Service
    // 取实例服务（判断 blob 存储是否启用时使用）
    const instances = yield* Instance.Service
    // 取项目服务
    const projects = yield* Project.Service
    // 取会话服务
    const sessions = yield* Session.Service
    // 消息编码器：Info → 存储编码形态
    const encodeMessage = Schema.encodeSync(SessionMessage.Info)

    // 组装并返回服务实现
    return Service.of({
      // 导出会话数据（可选脱敏）
      export: Effect.fn("SessionTransfer.export")(function* (input) {
        // 组装传输数据：会话信息 + 按时间升序排列的已完结消息
        const data = {
          info: yield* sessions.get(input.sessionID),
          messages: (yield* sessions.messages({ sessionID: input.sessionID, order: "asc" })).filter(isSettled),
        }
        // 需要脱敏时对敏感字段打码，否则原样返回
        return input.sanitize ? sanitize(data) : data
      }),
      // 导入会话：写入消息、发布创建事件并回填统计
      import: Effect.fn("SessionTransfer.import")(function* (input) {
        // 目标会话 ID（沿用数据中的 ID）
        const sessionID = input.data.info.id
        // 查询该 ID 是否已有会话
        const recorded = yield* db
          .select({ id: SessionTable.id })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get()
          .pipe(Effect.orDie)
        // 已存在：返回导入冲突错误
        if (recorded) return yield* new ImportConflictError({ sessionID })
        // 有父会话时校验其存在（不存在会抛 NotFound）
        if (input.data.info.parentID) yield* sessions.get(input.data.info.parentID)
        // 解析目标目录所属的项目
        const project = yield* projects.resolve(input.location.directory)
        // 确保项目行已落库
        yield* upsertProject(db, project).pipe(Effect.orDie)
        // 导入时间（当前毫秒）
        const importedAt = yield* Clock.currentTimeMillis
        // 计算相对项目根的子路径（反斜杠统一为正斜杠）
        const subpath = RelativePath.make(
          path.relative(project.directory, input.location.directory).replaceAll("\\", "/"),
        )
        // 过滤出已完结的消息并转为存储行（seq 从 1 编号）
        const messages = input.data.messages.filter(isSettled).map((message, index) => {
          // 编码为存储形态
          const encoded = encodeMessage(message)
          // 拆出 id/type 单列，其余字段留在 data
          const { id: _, type, ...data } = encoded
          return {
            // 保留原消息 ID
            id: message.id,
            // 所属会话
            session_id: sessionID,
            // 消息类型
            type,
            // 顺序号从 1 开始
            seq: index + 1,
            // 原创建时间（转为毫秒）
            time_created: DateTime.toEpochMillis(message.time.created),
            // 消息负载
            data,
          }
        })
        // Only inline media the import carries becomes blobs, and only its blobs get refs: refs it carried in
        // could otherwise keep or expose blobs it never held. The destination's config is loaded only when needed.
        // 拆分每条消息中的内联媒体为 blob 行与引用
        const split = messages.map((message) => SessionBlob.split(message.data))
        // 仅当确有媒体需要搬移，且目标位置启用了 blob 存储时才落 blob
        const media =
          split.some((row) => row.moved) &&
          (yield* SessionBlob.enabledFor(instances, {
            ...input.data.info,
            projectID: project.id,
            location: input.location,
            subpath,
          }))
        // 发布会话创建事件；在提交回调中写入消息与统计（事件与数据同事务化提交）
        yield* bus
          .publish(
            SessionEvent.Created,
            {
              // 会话 ID
              sessionID,
              // 父会话（可选）
              parentID: input.data.info.parentID,
              // 新生成的短标识
              slug: Slug.create(),
              // 当前应用版本
              version: app.version,
              // 项目 ID
              projectID: project.id,
              // 目标位置
              location: input.location,
              // 子路径
              subpath,
              // 标题
              title: input.data.info.title,
              // 代理
              agent: input.data.info.agent,
              // 模型
              model: input.data.info.model,
              // 元数据
              metadata: input.data.info.metadata,
              // 权限规则
              permissions: input.data.info.permissions,
            },
            {
              // 指定事件归属位置
              location: input.location,
              // 提交回调：事件提交成功后写入消息与统计
              commit: (seq) =>
                Effect.gen(function* () {
                  // 有消息才写
                  if (messages.length > 0) {
                    // 启用媒体时：先保存所有拆出的 blob
                    if (media) yield* Effect.forEach(split, (row) => SessionBlob.save(db, row.blobs), { discard: true })
                    // 启用媒体时：用去媒体后的 data 替换消息负载（原内联数据换成引用）
                    const stored = media
                      ? messages.map((message, i) => ({ ...message, data: split[i]!.data }))
                      : messages
                    // 分批插入消息行
                    for (const batch of DatabaseBatch.insertBatches(SessionMessageTable, stored))
                      yield* db.insert(SessionMessageTable).values(batch).run().pipe(Effect.orDie)
                    // 启用媒体时：记录每条消息对 blob 的引用
                    if (media)
                      yield* Effect.forEach(
                        stored,
                        (message, i) =>
                          SessionBlob.recordHashes(
                            db,
                            { sessionID, messageID: message.id, seq: message.seq },
                            new Set(split[i]!.blobs.map((blob) => blob.hash)),
                          ),
                        { discard: true },
                      )
                    // 为导入的消息预留事件序号区间
                    yield* Bus.reserveSequence(db, sessionID, seq + messages.length)
                  }
                  // 回填会话行的统计与时间字段
                  yield* db
                    .update(SessionTable)
                    .set({
                      // 原成本
                      cost: input.data.info.cost,
                      // 原输入 token 数
                      tokens_input: input.data.info.tokens.input,
                      // 原输出 token 数
                      tokens_output: input.data.info.tokens.output,
                      // 原推理 token 数
                      tokens_reasoning: input.data.info.tokens.reasoning,
                      // 原缓存读取 token 数
                      tokens_cache_read: input.data.info.tokens.cache.read,
                      // 原缓存写入 token 数
                      tokens_cache_write: input.data.info.tokens.cache.write,
                      // 原创建时间
                      time_created: DateTime.toEpochMillis(input.data.info.time.created),
                      // 更新时间记为导入时刻
                      time_updated: importedAt,
                      // 忙碌时间：仅在有过空闲时间时取 idle 与 busy 的较小者
                      time_busy:
                        input.data.info.time.idle && input.data.info.time.busy
                          ? Math.min(
                              DateTime.toEpochMillis(input.data.info.time.idle),
                              DateTime.toEpochMillis(input.data.info.time.busy),
                            )
                          : null,
                      // 空闲时间（无则为 null）
                      time_idle: input.data.info.time.idle ? DateTime.toEpochMillis(input.data.info.time.idle) : null,
                      // 查看时间：同样以空闲时间为界取较小者
                      time_viewed:
                        input.data.info.time.idle && input.data.info.time.viewed
                          ? Math.min(
                              DateTime.toEpochMillis(input.data.info.time.idle),
                              DateTime.toEpochMillis(input.data.info.time.viewed),
                            )
                          : null,
                      // 空闲结果：仅在有过空闲时间时保留
                      idle_outcome: input.data.info.time.idle ? (input.data.info.outcome ?? null) : null,
                      // 归档时间（无则为 null）
                      time_archived: input.data.info.time.archived
                        ? DateTime.toEpochMillis(input.data.info.time.archived)
                        : null,
                    })
                    .where(eq(SessionTable.id, sessionID))
                    .run()
                    .pipe(Effect.orDie)
                }),
            },
          )
          .pipe(
            // 投影器发现该会话已被投影过：转为导入冲突错误；其他缺陷照常中止
            Effect.catchDefect((defect) =>
              defect instanceof SessionProjector.SessionAlreadyProjected
                ? Effect.fail(new ImportConflictError({ sessionID }))
                : Effect.die(defect),
            ),
          )
        // 返回导入后的会话信息
        return yield* sessions.get(sessionID).pipe(Effect.orDie)
      }),
    })
  }),
)

// 全局服务节点：声明依赖的应用/总线/数据库/实例/项目/会话节点
export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [App.node, Bus.node, Database.node, Instance.node, Project.node, Session.node],
})

// 判断消息是否已完结（进行中的消息不参与传输）
function isSettled(message: SessionMessage.Info) {
  // 助手消息：有完成时间才算完结
  if (message.type === "assistant") return message.time.completed !== undefined
  // shell 与压缩消息：状态不再是 running 即完结
  if (message.type === "shell" || message.type === "compaction") return message.status !== "running"
  // 其余类型视为完结
  return true
}

// 生成脱敏占位符；空值（全空白）原样返回
function redact(kind: string, id: string, value: string) {
  return value.trim() ? `[redacted:${kind}:${id}]` : value
}

// 将非空的对象型元数据替换为脱敏标记（空对象或 undefined 原样返回）
function metadata(kind: string, id: string, value: Readonly<Record<string, unknown>> | undefined) {
  // 无元数据：原样返回
  if (!value) return value
  // 有键值对：替换为脱敏标记；空对象保持为空对象
  return Object.keys(value).length > 0 ? { redacted: `${kind}:${id}` } : value
}

// 脱敏整个传输数据：会话信息与消息逐字段打码
function sanitize(data: Data): Data {
  return {
    info: {
      ...data.info,
      // 标题脱敏（未定义保持未定义）
      title: data.info.title === undefined ? undefined : redact("session-title", data.info.id, data.info.title),
      // 非空元数据替换为脱敏标记
      metadata:
        data.info.metadata && Object.keys(data.info.metadata).length > 0
          ? { redacted: `session-metadata:${data.info.id}` }
          : data.info.metadata,
      // 目录路径脱敏（保持绝对路径形态）
      location: {
        ...data.info.location,
        directory: AbsolutePath.make(`/${redact("session-directory", data.info.id, data.info.location.directory)}`),
      },
      // 回滚信息：文件路径与补丁逐项脱敏
      revert: data.info.revert
        ? {
            ...data.info.revert,
            files: data.info.revert.files?.map((file, index) => ({
              ...file,
              file: redact("revert-file", String(index), file.file),
              patch: redact("revert-patch", String(index), file.patch),
            })),
          }
        : undefined,
    },
    // 消息逐条脱敏
    messages: data.messages.map(sanitizeMessage),
  }
}

// 按消息类型脱敏各字段
function sanitizeMessage(message: SessionMessage.Info): SessionMessage.Info {
  // 先处理消息级元数据（非空则打码）
  const meta = metadata("message-metadata", message.id, message.metadata)
  // 用户消息：文本、文件、代理与技能逐项脱敏
  if (message.type === "user")
    return {
      ...message,
      // 打码后的元数据
      metadata: meta,
      // 消息文本脱敏
      text: redact("text", message.id, message.text),
      // 文件逐个脱敏：清空内联数据、来源改为 inline、名称/描述/提及打码
      files: message.files?.map((file, index) => ({
        ...file,
        data: "",
        source: { type: "inline" },
        name: file.name === undefined ? undefined : redact("file-name", String(index), file.name),
        description:
          file.description === undefined ? undefined : redact("file-description", String(index), file.description),
        mention: file.mention
          ? { ...file.mention, text: redact("file-mention", String(index), file.mention.text) }
          : undefined,
      })),
      // 代理引用逐个脱敏：名称与提及文本打码
      agents: message.agents?.map((agent, index) => ({
        ...agent,
        name: redact("agent-name", String(index), agent.name),
        mention: agent.mention
          ? { ...agent.mention, text: redact("agent-mention", String(index), agent.mention.text) }
          : undefined,
      })),
      // 技能引用逐个脱敏：名称、文本与提及打码
      skills: message.skills?.map((skill, index) => ({
        ...skill,
        name: Skill.Name.make(redact("skill-name", String(index), skill.name)),
        text: skill.text === undefined ? undefined : redact("skill", String(index), skill.text),
        mention: skill.mention
          ? { ...skill.mention, text: redact("skill-mention", String(index), skill.mention.text) }
          : undefined,
      })),
    }
  // 合成消息：文本与描述脱敏
  if (message.type === "synthetic")
    return {
      ...message,
      metadata: meta,
      text: redact("synthetic", message.id, message.text),
      description:
        message.description === undefined
          ? undefined
          : redact("synthetic-description", message.id, message.description),
    }
  // 系统消息：文本脱敏
  if (message.type === "system") return { ...message, metadata: meta, text: redact("system", message.id, message.text) }
  // 技能消息：文本脱敏
  if (message.type === "skill") return { ...message, metadata: meta, text: redact("skill", message.id, message.text) }
  // shell 消息：命令与输出脱敏
  if (message.type === "shell")
    return {
      ...message,
      metadata: meta,
      command: redact("shell-command", message.id, message.command),
      output: message.output
        ? { ...message.output, output: redact("shell-output", message.id, message.output.output) }
        : undefined,
    }
  // 助手消息：内容逐段脱敏
  if (message.type === "assistant")
    return {
      ...message,
      metadata: meta,
      // 每个内容段按类型脱敏
      content: message.content.map((content) => {
        // 文本段：文本与原生载体打码
        if (content.type === "text")
          return {
            ...content,
            text: redact("text", message.id, content.text),
            native: content.native ? { redacted: `text-native:${message.id}` } : undefined,
          }
        // 推理段：文本与原生载体打码
        if (content.type === "reasoning")
          return {
            ...content,
            text: redact("reasoning", message.id, content.text),
            native: content.native ? { redacted: `reasoning-native:${message.id}` } : undefined,
          }
        // 工具段：原生载体与工具状态打码
        return {
          ...content,
          native: content.native ? { redacted: `tool-native:${message.id}` } : undefined,
          state: sanitizeToolState(message.id, content.state),
        }
      }),
    }
  // 压缩消息：按状态脱敏摘要与原生载体
  if (message.type === "compaction") {
    // 失败的压缩消息：仅打码元数据
    if (message.status === "failed")
      return {
        ...message,
        metadata: meta,
      }
    // 其余：摘要打码；已完成的再打码原生载体
    return {
      ...message,
      metadata: meta,
      summary: redact("compaction-summary", message.id, message.summary),
      ...(message.status === "completed" ? { native: metadata("compaction-native", message.id, message.native) } : {}),
    }
  }
  // 兜底：仅打码元数据
  return { ...message, metadata: meta }
}

// 按工具执行状态脱敏输入与输出
function sanitizeToolState(id: string, state: SessionMessage.ToolState): SessionMessage.ToolState {
  // 流式中：仅输入文本打码
  if (state.status === "streaming") return { ...state, input: redact("tool-input", id, state.input) }
  // 运行中：输入与元数据整体替换为脱敏标记
  if (state.status === "running")
    return { ...state, input: { redacted: `tool-input:${id}` }, metadata: { redacted: `tool-metadata:${id}` } }
  // 元数据非空则打码（完成/失败态共用）
  const meta = state.metadata === undefined ? undefined : { redacted: `tool-metadata:${id}` }
  // 已完成：输入打码，输出内容逐项脱敏
  if (state.status === "completed")
    return {
      ...state,
      input: { redacted: `tool-input:${id}` },
      content: map(state.content, (item) => sanitizeToolContent(id, item)),
      metadata: meta,
    }
  // 其余（失败/中止等）：输入打码，有输出内容时逐项脱敏
  return {
    ...state,
    input: { redacted: `tool-input:${id}` },
    content: state.content ? map(state.content, (item) => sanitizeToolContent(id, item)) : undefined,
    metadata: meta,
  }
}

// 脱敏工具输出的单个内容项
function sanitizeToolContent(id: string, content: Tool.Content): Tool.Content {
  // 文本输出：文本打码
  if (content.type === "text") return { ...content, text: redact("tool-output", id, content.text) }
  // 文件类输出：URI 与名称打码
  return {
    ...content,
    uri: redact("tool-file-uri", id, content.uri),
    name: content.name === undefined ? undefined : redact("tool-file-name", id, content.name),
  }
}
