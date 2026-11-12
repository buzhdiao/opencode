// 引入实例（Instance）服务：按位置提供实例上下文
import { Instance } from "@opencode/core/instance/service"
// 引入会话（Session）核心服务：会话生命周期、消息与恢复
import { Session } from "@opencode/core/session"
// 引入会话统计（SessionStats）：按时间聚合使用数据
import { SessionStats } from "@opencode/core/session/stats"
// 引入会话标题（SessionTitle）：自动生成会话标题
import { SessionTitle } from "@opencode/core/session/title"
// 引入会话导入导出（SessionTransfer）：跨服务端迁移会话
import { SessionTransfer } from "@opencode/core/session/transfer"
// 引入指令条目（InstructionEntry）：会话级指令键值存储
import { InstructionEntry } from "@opencode/core/session/instruction-entry"
// 引入表单（Form）服务：会话内交互表单
import { Form } from "@opencode/core/form"
// 引入 DateTime（时间处理）、Effect 与 Stream（流）
import { DateTime, Effect, Stream } from "effect"
// 引入 HTTP 服务端响应工具
import { HttpServerResponse } from "effect/http"
// 引入 HTTP API 构建器与 Schema 工具（204 响应）
import { HttpApiBuilder, HttpApiSchema } from "effect/http-api"
// 引入带媒体引用的单条消息响应 Schema
import { SessionMediaMessageResponse } from "@opencode/protocol/groups/message"
// 引入带媒体引用的收件箱响应 Schema
import { SessionMediaInboxResponse } from "@opencode/protocol/groups/session"
// 引入本服务 API 定义
import { Api } from "../api"
// 引入 wantsMediaRefs：判断客户端是否要求媒体引用（media: URI）形式
import { wantsMediaRefs } from "../media-uri"
// 引入协议层错误集合：冲突、命令执行/未找到、表单错误、无效请求/游标、消息未找到、服务不可用、会话忙、技能未找到
import {
  ConflictError,
  CommandExecutionError,
  CommandNotFoundError,
  FormAlreadySettledError,
  FormInvalidAnswerError,
  FormNotFoundError,
  InvalidRequestError,
  InvalidCursorError,
  MessageNotFoundError,
  ServiceUnavailableError,
  SessionBusyError,
  SkillNotFoundError,
} from "@opencode/protocol/errors"
// 引入 AbsolutePath：绝对路径构造类型
import { AbsolutePath } from "@opencode/core/schema"
// 引入位置相关错误映射
import { locationErrors } from "../location"
// 引入会话错误辅助：解码失败、快照失败、消息/会话未找到
import { failedMessageDecode, failedSnapshot, missingMessage, missingSession } from "./session-error"

// 辅助函数：构造“表单未找到”错误
function missingForm(id: Form.ID) {
  return new FormNotFoundError({ id, message: `Form not found: ${id}` })
}

// 导出 SessionHandler：注册 "server.session" 分组处理器（端点最多的一组）
export const SessionHandler = HttpApiBuilder.group(Api, "server.session", (handlers) =>
  Effect.gen(function* () {
    // 获取会话服务
    const session = yield* Session.Service
    // 获取会话导入导出服务
    const transfer = yield* SessionTransfer.Service
    // 获取指令条目服务
    const instructions = yield* InstructionEntry.Service
    // 获取实例服务（用于按会话所属位置提供作用域）
    const instances = yield* Instance.Service
    // requireSession：确认会话存在并返回其信息；不存在映射为 SessionNotFoundError
    const requireSession = (sessionID: Session.ID) =>
      session.get(sessionID).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
    // requireOwnedForm：校验表单存在且属于指定会话（防止跨会话操作）
    const requireOwnedForm = Effect.fnUntraced(function* (sessionID: Form.Info["sessionID"], formID: Form.ID) {
      // 获取表单服务
      const form = yield* Form.Service
      // 查询表单信息；不存在映射为“表单未找到”
      const info = yield* form.get(formID).pipe(Effect.catchTag("Form.NotFoundError", () => missingForm(formID)))
      // 会话不匹配也按“表单未找到”处理（不泄露他人表单的存在性）
      if (info.sessionID !== sessionID) return yield* missingForm(formID)
      // 返回服务实例与表单信息
      return { form, info }
    })
    // busySession：把会话忙错误映射为协议层 SessionBusyError
    const busySession = (error: Session.BusyError) =>
      new SessionBusyError({
        sessionID: error.sessionID,
        message: `Session is busy: ${error.sessionID}`,
      })
    // pendingMutation：处理“待处理输入”（收件箱项）的变更——失败映射并统一返回 204
    const pendingMutation = (effect: ReturnType<typeof session.cancelInbox>, conflict: string) =>
      effect.pipe(
        // 会话不存在 -> SessionNotFoundError
        Effect.catchTag("Session.NotFoundError", missingSession),
        // 收件箱项状态冲突 -> ConflictError（带说明）
        Effect.catchTag(
          "Session.InboxConflictError",
          (error) => new ConflictError({ resource: error.inboxID, message: `${conflict}: ${error.inboxID}` }),
        ),
        // 成功时返回 204 无内容
        Effect.as(HttpApiSchema.NoContent.make()),
      )

    return handlers
      .handle(
        // 处理 session.list：分页列出会话
        "session.list",
        Effect.fn(function* (ctx) {
          return yield* session
            // 透传查询参数执行列表
            .list(ctx.query)
            .pipe(
              // 列表游标非法 -> InvalidCursorError
              Effect.catchTag(
                "Session.InvalidListCursorError",
                (error) => new InvalidCursorError({ message: error.message }),
              ),
            )
        }),
      )
      .handle(
        // 处理 session.stats：按时间段统计使用数据
        "session.stats",
        Effect.fn(function* (ctx) {
          // 时区默认 UTC
          const timezone = ctx.query.timezone ?? "UTC"
          // 用 Intl 校验时区名是否合法，非法则返回无效请求错误
          yield* Effect.try({
            try: () => new Intl.DateTimeFormat("en-US", { timeZone: timezone }),
            catch: () => new InvalidRequestError({ message: `Invalid time zone: ${timezone}` }),
          })
          return {
            // 执行统计：起止时间、项目、时区与工具过滤；范围非法映射为无效请求
            data: yield* SessionStats.get({
              from: ctx.query.from,
              to: ctx.query.to,
              projectID: ctx.query.project,
              timezone,
              tools: ctx.query.tools,
            }).pipe(
              Effect.mapError(() => new InvalidRequestError({ message: "Stats range must end after it starts" })),
            ),
          }
        }),
      )
      .handle(
        // 处理 session.create：创建新会话
        "session.create",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session
              // 创建参数：ID、标题、代理、模型、元数据与权限覆盖
              .create({
                id: ctx.payload.id,
                title: ctx.payload.title,
                agent: ctx.payload.agent,
                model: ctx.payload.model,
                metadata: ctx.payload.metadata,
                permissions: ctx.payload.permissions,
                // 子会话只带 parentID；顶层会话带位置（未指定时回退到服务进程当前目录）
                ...(ctx.payload.parentID === undefined
                  ? { location: ctx.payload.location ?? { directory: AbsolutePath.make(process.cwd()) } }
                  : { parentID: ctx.payload.parentID }),
              })
              .pipe(Effect.catchTag("Session.NotFoundError", missingSession)),
          }
        }),
      )
      .handle(
        // 处理 session.import：从导出数据导入会话
        "session.import",
        Effect.fn(function* (ctx) {
          return {
            data: yield* transfer
              // 导入内容：会话信息与消息列表；位置未指定时回退到进程当前目录
              .import({
                data: { info: ctx.payload.info, messages: ctx.payload.messages },
                location: ctx.payload.location ?? { directory: AbsolutePath.make(process.cwd()) },
              })
              .pipe(
                // 会话不存在 -> SessionNotFoundError
                Effect.catchTag("Session.NotFoundError", missingSession),
                // 目标会话 ID 已存在 -> ConflictError
                Effect.catchTag(
                  "SessionTransfer.ImportConflictError",
                  (error) =>
                    new ConflictError({
                      message: `Session already exists: ${error.sessionID}`,
                      resource: error.sessionID,
                    }),
                ),
              ),
          }
        }),
      )
      .handle(
        // 处理 session.export：导出会话（可选脱敏 sanitize）
        "session.export",
        Effect.fn(function* (ctx) {
          return {
            data: yield* transfer
              // 按会话 ID 导出；sanitize 决定是否去除敏感内容
              .export({ sessionID: ctx.params.sessionID, sanitize: ctx.query.sanitize })
              .pipe(
                // 会话不存在 -> SessionNotFoundError
                Effect.catchTag("Session.NotFoundError", missingSession),
                // 消息解码失败 -> 统一的 UnknownError（带日志引用）
                Effect.catchTag("Session.MessageDecodeError", failedMessageDecode),
              ),
          }
        }),
      )
      .handle(
        // 处理 session.active：列出当前正在运行（活跃）的会话
        "session.active",
        Effect.fn(function* () {
          // 读取活跃会话 ID 集合
          const active = yield* session.active
          return {
            // 转为 { 会话ID: { type: "running" } } 的映射结构
            data: Object.fromEntries(Array.from(active, (sessionID) => [sessionID, { type: "running" as const }])),
          }
        }),
      )
      .handle(
        // 处理 session.get：获取单个会话详情
        "session.get",
        Effect.fn(function* (ctx) {
          return {
            // 查询会话；不存在映射为 SessionNotFoundError
            data: yield* session
              .get(ctx.params.sessionID)
              .pipe(Effect.catchTag("Session.NotFoundError", missingSession)),
          }
        }),
      )
      .handle(
        // 处理 session.view：上报客户端正在查看该会话（影响活跃状态/空闲判定）
        "session.view",
        Effect.fn(function* (ctx) {
          // 记录查看事件；idle 为客户端的空闲时间戳（毫秒）
          yield* session
            .view({ sessionID: ctx.params.sessionID, idle: DateTime.toEpochMillis(ctx.payload.idle) })
            .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          // 返回 204 无内容
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        // 处理 session.remove：删除会话
        "session.remove",
        Effect.fn(function* (ctx) {
          // 执行删除；不存在映射为 SessionNotFoundError
          yield* session.remove(ctx.params.sessionID).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          // 返回 204 无内容
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        // 处理 session.environment：为会话设置额外环境变量
        "session.environment",
        Effect.fn(function* (ctx) {
          // 写入变量映射；会话不存在映射为 SessionNotFoundError
          yield* session
            .environment({ sessionID: ctx.params.sessionID, variables: ctx.payload.variables })
            .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          // 返回 204 无内容
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        // 处理 session.fork：从指定消息前分叉出新会话
        "session.fork",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.fork({ sessionID: ctx.params.sessionID, before: ctx.payload.before }).pipe(
              // 会话不存在 -> SessionNotFoundError
              Effect.catchTag("Session.NotFoundError", missingSession),
              // 分叉锚点消息不存在 -> MessageNotFoundError
              Effect.catchTag("Session.MessageNotFoundError", missingMessage),
              // 分叉结果为空（没有可复制内容）-> InvalidRequestError
              Effect.catchTag(
                "Session.ForkEmptyError",
                (error) => new InvalidRequestError({ message: error.message, kind: "empty_session" }),
              ),
            ),
          }
        }),
      )
      .handle(
        // 处理 session.switchAgent：切换会话使用的代理（agent）
        "session.switchAgent",
        Effect.fn(function* (ctx) {
          // 执行切换；会话不存在映射为 SessionNotFoundError
          yield* session
            .switchAgent({ sessionID: ctx.params.sessionID, agent: ctx.payload.agent })
            .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          // 返回 204 无内容
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        // 处理 session.switchModel：切换会话使用的模型
        "session.switchModel",
        Effect.fn(function* (ctx) {
          // 执行切换；会话不存在映射为 SessionNotFoundError
          yield* session
            .switchModel({ sessionID: ctx.params.sessionID, model: ctx.payload.model })
            .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          // 返回 204 无内容
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        // 处理 session.update：按需更新会话的标题/元数据/权限/归档状态
        "session.update",
        Effect.fn(function* (ctx) {
          // 先确认会话存在
          const info = yield* requireSession(ctx.params.sessionID)
          // 负载带 title 字段时处理标题
          if (ctx.payload.title !== undefined) {
            // 非空字符串：直接重命名
            if (ctx.payload.title) {
              yield* session
                .rename({ sessionID: ctx.params.sessionID, title: ctx.payload.title })
                .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
            } else {
              // 空字符串：触发自动生成标题（按会话所属实例提供作用域）
              yield* SessionTitle.Service.use((title) => title.generate(ctx.params.sessionID)).pipe(
                instances.provide(info),
                locationErrors,
              )
            }
          }
          // 负载带 metadata 字段：更新元数据
          if (ctx.payload.metadata !== undefined)
            yield* session
              .setMetadata({ sessionID: ctx.params.sessionID, metadata: ctx.payload.metadata })
              .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          // 负载带 permissions 字段：更新权限覆盖
          if (ctx.payload.permissions !== undefined)
            yield* session
              .setPermissions({ sessionID: ctx.params.sessionID, permissions: ctx.payload.permissions })
              .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          // 负载带 archived 字段：归档或取消归档
          if (ctx.payload.archived !== undefined)
            yield* (ctx.payload.archived ? session.archive : session.unarchive)(ctx.params.sessionID).pipe(
              Effect.catchTag("Session.NotFoundError", missingSession),
            )
          // 返回 204 无内容
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        // 处理 session.move：把会话迁移到另一个目录（服务端）
        "session.move",
        Effect.fn(function* (ctx) {
          yield* session
            .move({
              sessionID: ctx.params.sessionID,
              directory: ctx.payload.directory,
              delivery: ctx.payload.delivery,
            })
            .pipe(
              // 会话不存在 -> SessionNotFoundError
              Effect.catchTag("Session.NotFoundError", missingSession),
              // 目标目录不存在 -> InvalidRequestError
              Effect.catchTag("Session.DestinationNotFoundError", (error) =>
                Effect.fail(new InvalidRequestError({ message: `Directory does not exist: ${error.directory}` })),
              ),
              // 目标不是目录 -> InvalidRequestError
              Effect.catchTag("Session.DestinationNotDirectoryError", (error) =>
                Effect.fail(new InvalidRequestError({ message: `Not a directory: ${error.directory}` })),
              ),
              // 目标目录不可用 -> InvalidRequestError
              Effect.catchTag("Session.DestinationUnavailableError", (error) =>
                Effect.fail(new InvalidRequestError({ message: `Directory is unavailable: ${error.directory}` })),
              ),
            )
          // 返回 204 无内容
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        // 处理 session.prompt：向会话提交用户提示（可附带文件/代理/技能）
        "session.prompt",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session
              .prompt({
                sessionID: ctx.params.sessionID,
                id: ctx.payload.id,
                text: ctx.payload.text,
                files: ctx.payload.files,
                agents: ctx.payload.agents,
                skills: ctx.payload.skills,
                metadata: ctx.payload.metadata,
                delivery: ctx.payload.delivery,
                resume: ctx.payload.resume,
              })
              .pipe(
                // 会话不存在 -> SessionNotFoundError
                Effect.catchTag("Session.NotFoundError", missingSession),
                // 提示消息 ID 与已有持久记录冲突 -> ConflictError
                Effect.catchTag("Session.PromptConflictError", (error) =>
                  Effect.fail(
                    new ConflictError({
                      message: `Prompt message ID conflicts with an existing durable record: ${error.messageID}`,
                      resource: error.messageID,
                    }),
                  ),
                ),
                // 附件非法 -> InvalidRequestError（标注 files 字段）
                Effect.catchTag("Session.AttachmentError", (error) =>
                  Effect.fail(new InvalidRequestError({ message: error.message, field: "files" })),
                ),
                // 技能未找到 -> InvalidRequestError（标注 skills 字段）
                Effect.catchTag("Session.SkillNotFoundError", (error) =>
                  Effect.fail(new InvalidRequestError({ message: `Skill not found: ${error.skill}`, field: "skills" })),
                ),
                // 位置相关错误统一映射
                locationErrors,
              ),
          }
        }),
      )
      .handle(
        // 处理 session.command：执行自定义命令（可能展开为提示）
        "session.command",
        Effect.fn(function* (ctx) {
          yield* session
            .command({
              sessionID: ctx.params.sessionID,
              command: ctx.payload.name,
              text: ctx.payload.text,
              files: ctx.payload.files,
              agents: ctx.payload.agents,
              skills: ctx.payload.skills,
              delivery: ctx.payload.delivery,
            })
            .pipe(
              // 会话不存在 -> SessionNotFoundError
              Effect.catchTag("Session.NotFoundError", missingSession),
              // 命令未找到 -> CommandNotFoundError
              Effect.catchTag("Command.NotFoundError", (error) =>
                Effect.fail(
                  new CommandNotFoundError({
                    command: error.command,
                    message: error.message,
                  }),
                ),
              ),
              // 命令执行失败 -> CommandExecutionError
              Effect.catchTag("Command.ExecutionError", (error) =>
                Effect.fail(
                  new CommandExecutionError({
                    command: error.command,
                    message: error.message,
                  }),
                ),
              ),
              // 位置相关错误统一映射
              locationErrors,
            )
          // 返回 204 无内容
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        // 处理 session.skill：直接调用技能（skill）开始一段执行
        "session.skill",
        Effect.fn(function* (ctx) {
          yield* session
            .skill({
              sessionID: ctx.params.sessionID,
              skill: ctx.payload.id,
              resume: ctx.payload.resume,
            })
            .pipe(
              // 会话不存在 -> SessionNotFoundError
              Effect.catchTag("Session.NotFoundError", missingSession),
              // 技能未找到 -> SkillNotFoundError
              Effect.catchTag("Session.SkillNotFoundError", (error) =>
                Effect.fail(new SkillNotFoundError({ skill: error.skill, message: `Skill not found: ${error.skill}` })),
              ),
              // 位置相关错误统一映射
              locationErrors,
            )
          // 返回 204 无内容
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        // 处理 session.synthetic：注入一条合成（synthetic）输入消息（如系统事件）
        "session.synthetic",
        Effect.fn(function* (ctx) {
          // 注入参数：ID、文本、描述、元数据、投递方式与恢复标志
          const data = yield* session
            .synthetic({
              id: ctx.payload.id,
              sessionID: ctx.params.sessionID,
              text: ctx.payload.text,
              description: ctx.payload.description,
              metadata: ctx.payload.metadata,
              delivery: ctx.payload.delivery,
              resume: ctx.payload.resume,
            })
            .pipe(
              // 会话不存在 -> SessionNotFoundError
              Effect.catchTag("Session.NotFoundError", missingSession),
              // 合成输入 ID 与已有持久记录冲突 -> ConflictError
              Effect.catchTag("Session.SyntheticConflictError", (error) =>
                Effect.fail(
                  new ConflictError({
                    message: `Synthetic input ID conflicts with an existing durable record: ${error.inputID}`,
                    resource: error.inputID,
                  }),
                ),
              ),
            )
          // 返回注入结果
          return { data }
        }),
      )
      .handle(
        // 处理 session.shell：在会话内执行 shell 命令
        "session.shell",
        Effect.fn(function* (ctx) {
          yield* session
            .shell({ sessionID: ctx.params.sessionID, id: ctx.payload.id, command: ctx.payload.command })
            .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          // 返回 204 无内容
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        // 处理 session.compact：压缩（compact）会话上下文
        "session.compact",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session
              // 压缩参数：会话 ID、输入 ID 与投递方式
              .compact({ sessionID: ctx.params.sessionID, id: ctx.payload.id, delivery: ctx.payload.delivery })
              .pipe(
                // 会话不存在 -> SessionNotFoundError
                Effect.catchTag("Session.NotFoundError", missingSession),
                // 压缩输入 ID 与已有持久记录冲突 -> ConflictError
                Effect.catchTag("Session.CompactionConflictError", (error) =>
                  Effect.fail(
                    new ConflictError({
                      message: `Compaction input ID conflicts with an existing durable record: ${error.inputID}`,
                      resource: error.inputID,
                    }),
                  ),
                ),
              ),
          }
        }),
      )
      .handle(
        // 处理 session.wait：等待会话当前执行完成（阻塞直到空闲）
        "session.wait",
        Effect.fn(function* (ctx) {
          // 执行等待；会话不存在映射为 SessionNotFoundError
          yield* session.wait(ctx.params.sessionID).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          // 返回 204 无内容
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        // 处理 session.revert.stage：暂存（stage）回滚点——把指定文件回退到指定消息之前
        "session.revert.stage",
        Effect.fn(function* (ctx) {
          // 记录回滚暂存操作日志（会话、消息与文件列表）
          yield* Effect.log("session.revert.stage", {
            sessionID: ctx.params.sessionID,
            messageID: ctx.payload.messageID,
            files: ctx.payload.files,
          })
          return {
            data: yield* session.revert
              // 透传路径与负载参数执行暂存
              .stage({ ...ctx.params, ...ctx.payload })
              .pipe(
                // 会话不存在 -> SessionNotFoundError
                Effect.catchTag("Session.NotFoundError", missingSession),
                // 锚点消息不存在 -> MessageNotFoundError
                Effect.catchTag("Session.MessageNotFoundError", missingMessage),
                // 会话忙（正在执行）-> SessionBusyError
                Effect.catchTag("Session.BusyError", busySession),
                // 快照操作失败 -> 统一 UnknownError（带日志引用）
                Effect.catchTag("Snapshot.Error", failedSnapshot("stage session revert", ctx.params.sessionID)),
                // 位置相关错误统一映射
                locationErrors,
              ),
          }
        }),
      )
      .handle(
        // 处理 session.revert.clear：清除会话的回滚暂存（撤销已暂存的回退）
        "session.revert.clear",
        Effect.fn(function* (ctx) {
          // 记录回滚清除操作日志
          yield* Effect.log("session.revert.clear", { sessionID: ctx.params.sessionID })
          yield* session.revert
            .clear(ctx.params.sessionID)
            .pipe(
              // 会话不存在 -> SessionNotFoundError
              Effect.catchTag("Session.NotFoundError", missingSession),
              // 会话忙 -> SessionBusyError
              Effect.catchTag("Session.BusyError", busySession),
              // 快照操作失败 -> 统一 UnknownError
              Effect.catchTag("Snapshot.Error", failedSnapshot("clear session revert", ctx.params.sessionID)),
              // 位置相关错误统一映射
              locationErrors,
            )
          // 返回 204 无内容
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        // 处理 session.revert.commit：提交回滚——彻底丢弃已暂存的消息/文件
        "session.revert.commit",
        Effect.fn(function* (ctx) {
          // 记录回滚提交操作日志
          yield* Effect.log("session.revert.commit", { sessionID: ctx.params.sessionID })
          yield* session.revert
            .commit(ctx.params.sessionID)
            .pipe(
              // 会话不存在 -> SessionNotFoundError
              Effect.catchTag("Session.NotFoundError", missingSession),
              // 会话忙 -> SessionBusyError
              Effect.catchTag("Session.BusyError", busySession),
            )
          // 返回 204 无内容
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        // 处理 session.context：返回会话当前上下文（模型可见的消息/token 等）
        "session.context",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session
              // 读取会话上下文
              .context(ctx.params.sessionID)
              .pipe(
                // 会话不存在 -> SessionNotFoundError
                Effect.catchTag("Session.NotFoundError", missingSession),
                // 消息解码失败 -> 统一 UnknownError（带日志引用）
                Effect.catchTag("Session.MessageDecodeError", failedMessageDecode),
              ),
          }
        }),
      )
      .handle(
        // 处理 session.diff：计算会话轮次之间的文件差异
        "session.diff",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.diff({ sessionID: ctx.params.sessionID, ...ctx.query }).pipe(
              // 会话不存在 -> SessionNotFoundError
              Effect.catchTag("Session.NotFoundError", missingSession),
              // 锚点消息不存在 -> MessageNotFoundError
              Effect.catchTag("Session.MessageNotFoundError", missingMessage),
              // 轮次范围非法 -> InvalidRequestError（标注出错字段）
              Effect.catchTag(
                "Session.TurnRangeError",
                (error) => new InvalidRequestError({ message: error.message, field: error.field }),
              ),
              // 快照操作失败 -> 统一 UnknownError
              Effect.catchTag("Snapshot.Error", failedSnapshot("diff session turn", ctx.params.sessionID)),
              // 位置相关错误统一映射
              locationErrors,
            ),
          }
        }),
      )
      .handle(
        // 处理 session.inbox.list：列出会话的待处理输入（收件箱）
        "session.inbox.list",
        Effect.fn(function* (ctx) {
          // 客户端要求媒体引用形式时，走 inboxWithRefs 并以对应 Schema 序列化
          if (wantsMediaRefs(ctx.request))
            return yield* HttpServerResponse.schemaJson(SessionMediaInboxResponse)({
              data: yield* session
                .inboxWithRefs(ctx.params.sessionID)
                .pipe(Effect.catchTag("Session.NotFoundError", missingSession)),
            }).pipe(Effect.orDie)
          return {
            // 常规路径：返回收件箱内容
            data: yield* session
              .inbox(ctx.params.sessionID)
              .pipe(Effect.catchTag("Session.NotFoundError", missingSession)),
          }
        }),
      )
      .handle(
        // 处理 session.inbox.cancel：取消一条待处理输入
        "session.inbox.cancel",
        Effect.fn(function* (ctx) {
          yield* session.cancelInbox({ sessionID: ctx.params.sessionID, inboxID: ctx.params.inboxID }).pipe(
            // 会话不存在 -> SessionNotFoundError
            Effect.catchTag("Session.NotFoundError", missingSession),
            // 已结算/冲突时视为已取消：静默成功（幂等）
            Effect.catchTag("Session.InboxConflictError", () => Effect.void),
          )
          // 返回 204 无内容
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        // 处理 session.inbox.update：修改待处理输入的投递方式（steer 插队 / queue 排队）
        "session.inbox.update",
        Effect.fn(function* (ctx) {
          return yield* pendingMutation(
            // 按目标投递方式选择对应变更操作
            ctx.payload.delivery === "steer"
              ? session.steerInbox({ sessionID: ctx.params.sessionID, inboxID: ctx.params.inboxID })
              : session.queueInbox({ sessionID: ctx.params.sessionID, inboxID: ctx.params.inboxID }),
            // 冲突时的说明文案
            `Pending input cannot change to ${ctx.payload.delivery}`,
          )
        }),
      )
      .handle(
        // 处理 session.instructions.entry.list：列出会话的指令条目
        "session.instructions.entry.list",
        Effect.fn(function* (ctx) {
          // 先确认会话存在
          yield* requireSession(ctx.params.sessionID)
          // 返回指令条目列表
          return { data: yield* instructions.list(ctx.params.sessionID) }
        }),
      )
      .handle(
        // 处理 session.instructions.entry.put：写入（新增/更新）一条指令条目
        "session.instructions.entry.put",
        Effect.fn(function* (ctx) {
          // 先确认会话存在
          yield* requireSession(ctx.params.sessionID)
          // 按键写入值
          yield* instructions.put({ sessionID: ctx.params.sessionID, key: ctx.params.key, value: ctx.payload.value })
          // 返回 204 无内容
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        // 处理 session.instructions.entry.remove：删除一条指令条目
        "session.instructions.entry.remove",
        Effect.fn(function* (ctx) {
          // 先确认会话存在
          yield* requireSession(ctx.params.sessionID)
          // 按键删除
          yield* instructions.remove({ sessionID: ctx.params.sessionID, key: ctx.params.key })
          // 返回 204 无内容
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        // 处理 session.generate：让会话直接生成一段文本（不经消息循环）
        "session.generate",
        Effect.fn(function* (ctx) {
          const result = yield* session
            .generate({ sessionID: ctx.params.sessionID, prompt: ctx.payload.prompt })
            .pipe(
              Effect.mapError((error) =>
                error._tag === "Session.NotFoundError"
                  ? missingSession(error)
                  : new ServiceUnavailableError({ message: error.message, service: "session generation" }),
              ),
            )
          return { data: result }
        }),
      )
      .handle(
        // 处理 session.log：订阅会话日志（可选 follow 持续流式输出）
        "session.log",
        Effect.fn(function* (ctx) {
          // 先确认会话存在
          yield* session.get(ctx.params.sessionID).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          // 返回日志流：after 指定起始位置，follow 决定是否持续输出（流内失败视为缺陷）
          return session
            .log({ sessionID: ctx.params.sessionID, after: ctx.query.after, follow: ctx.query.follow })
            .pipe(Stream.orDie)
        }),
      )
      .handle(
        // 处理 session.interrupt：中断会话当前执行（可选恢复 pending 状态）
        "session.interrupt",
        Effect.fn(function* (ctx) {
          // 先确认会话存在
          yield* requireSession(ctx.params.sessionID)
          // 执行中断；resume 决定是否保留待处理输入
          return { interrupted: yield* session.interrupt(ctx.params.sessionID, { resume: ctx.query.resume }) }
        }),
      )
      .handle(
        // 处理 session.background：把会话转入后台（返回提示符）
        "session.background",
        Effect.fn(function* (ctx) {
          // 执行转后台；会话不存在映射为 SessionNotFoundError
          yield* session.background(ctx.params.sessionID).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          // 返回 204 无内容
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        // 处理 session.message：获取会话中的单条消息
        "session.message",
        Effect.fn(function* (ctx) {
          // 先确认会话存在
          yield* session.get(ctx.params.sessionID).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          // 客户端要求媒体引用形式时，走 messageWithRefs 并以对应 Schema 序列化
          if (wantsMediaRefs(ctx.request)) {
            const message = yield* session.messageWithRefs(ctx.params)
            if (message)
              return yield* HttpServerResponse.schemaJson(SessionMediaMessageResponse)({ data: message }).pipe(
                Effect.orDie,
              )
          } else {
            // 常规路径：按会话与消息 ID 查询
            const message = yield* session.message(ctx.params)
            // 找到则返回
            if (message) return { data: message }
          }
          // 两种路径都未找到消息 -> MessageNotFoundError
          return yield* new MessageNotFoundError({
            sessionID: ctx.params.sessionID,
            messageID: ctx.params.messageID,
            message: `Message not found: ${ctx.params.messageID}`,
          })
        }),
      )
      .handle(
        // 处理 session.form.list：列出会话内的表单
        "session.form.list",
        Effect.fn(function* (ctx) {
          // 获取表单服务
          const form = yield* Form.Service
          // 按会话列出表单
          return { data: yield* form.list({ sessionID: ctx.params.sessionID }) }
        }),
      )
      .handle(
        // 处理 session.form.create：在会话中创建表单
        "session.form.create",
        Effect.fn(function* (ctx) {
          // 获取表单服务
          const form = yield* Form.Service
          // 创建参数：ID、标题、元数据与字段定义
          const created = yield* form
            .create({
              id: ctx.payload.id,
              sessionID: ctx.params.sessionID,
              title: ctx.payload.title,
              metadata: ctx.payload.metadata,
              fields: ctx.payload.fields,
            })
            .pipe(
              Effect.catchTags({
                // 表单 ID 已存在 -> ConflictError
                "Form.AlreadyExistsError": (error) => new ConflictError({ resource: error.id, message: error.message }),
                // 字段定义非法 -> InvalidRequestError（标注 fields 字段）
                "Form.InvalidFormError": (error) =>
                  new InvalidRequestError({ message: error.message, field: "fields" }),
              }),
            )
          // 返回创建结果
          return { data: created }
        }),
      )
      .handle(
        // 处理 session.form.get：获取表单详情及其当前状态
        "session.form.get",
        Effect.fn(function* (ctx) {
          // 校验表单归属该会话
          const owned = yield* requireOwnedForm(ctx.params.sessionID, ctx.params.formID)
          // 查询表单状态；已删除映射为“表单未找到”
          const state = yield* owned.form
            .state(ctx.params.formID)
            .pipe(Effect.catchTag("Form.NotFoundError", () => missingForm(ctx.params.formID)))
          // 返回表单信息与状态
          return { data: { ...owned.info, state } }
        }),
      )
      .handle(
        // 处理 session.form.reply：提交表单答案
        "session.form.reply",
        Effect.fn(function* (ctx) {
          // 校验表单归属该会话
          const owned = yield* requireOwnedForm(ctx.params.sessionID, ctx.params.formID)
          yield* owned.form.reply({ id: ctx.params.formID, answer: ctx.payload.answer }).pipe(
            Effect.catchTags({
              // 表单已结算（已提交/取消）-> FormAlreadySettledError
              "Form.AlreadySettledError": (error) =>
                new FormAlreadySettledError({ id: error.id, message: error.message }),
              // 答案不合法 -> FormInvalidAnswerError
              "Form.InvalidAnswerError": (error) =>
                new FormInvalidAnswerError({ id: error.id, message: error.message }),
              // 表单已删除 -> “表单未找到”
              "Form.NotFoundError": () => missingForm(ctx.params.formID),
            }),
          )
          // 返回 204 无内容
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        // 处理 session.form.cancel：取消表单（可带说明消息）
        "session.form.cancel",
        Effect.fn(function* (ctx) {
          // 校验表单归属该会话
          const owned = yield* requireOwnedForm(ctx.params.sessionID, ctx.params.formID)
          yield* owned.form.cancel(ctx.params.formID, { message: ctx.query.message }).pipe(
            Effect.catchTags({
              // 表单已结算 -> FormAlreadySettledError
              "Form.AlreadySettledError": (error) =>
                new FormAlreadySettledError({ id: error.id, message: error.message }),
              // 表单已删除 -> “表单未找到”
              "Form.NotFoundError": () => missingForm(ctx.params.formID),
            }),
          )
          // 返回 204 无内容
          return HttpApiSchema.NoContent.make()
        }),
      )
  }),
)
