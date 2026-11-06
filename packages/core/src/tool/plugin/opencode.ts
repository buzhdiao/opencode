// 将本模块以命名空间方式重新导出为 OpenCodeTools
export * as OpenCodeTools from "./opencode.js"

// 导入系统消息片段类型与工具失败类型
import { SystemPart, ToolFailure } from "@opencode/ai/effect"
// 导入插件上下文类型（Context）
import type { Context } from "@opencode/plugin/effect/plugin"
// 导入会话钩子类型（SessionHooks）
import type { SessionHooks } from "@opencode/plugin/effect/session"
// 导入模型 Schema（用于取字段定义）
import { Model } from "@opencode/schema/model"
// 导入 AbsolutePath 品牌化类型（绝对路径）
import { AbsolutePath } from "@opencode/schema/schema"
// 导入会话 Schema
import { Session } from "@opencode/schema/session"
// 导入 Effect 原语：Effect、Schema
import { Effect, Schema } from "effect"
// 导入统一的工具失败映射函数
import { toolFailure } from "../runtime.js"
// 导入文件访问（FileAccess）服务
import { FileAccess } from "../../file-access.js"
// 导入 Git 操作服务
import { Git } from "../../git.js"
// 导入权限（Permission）服务
import { Permission } from "../../permission.js"
// 导入工作树（Worktree）服务
import { Worktree } from "../../worktree.js"

// session_rename 工具的输入 Schema
export const RenameInput = Schema.Struct({
  // 可选的会话 ID（省略表示当前会话）
  sessionID: Schema.optionalKey(Session.ID).annotate({ description: "Omit to rename the current session." }),
  // 新标题（非空）
  title: Schema.String.check(Schema.isMinLength(1)).annotate({ description: "New session title." }),
})

// session_rename 的输出 Schema：会话 ID + 新标题
const RenameOutput = Schema.Struct({ sessionID: Session.ID, title: Schema.String })

// session_move 工具的输入 Schema
export const MoveInput = Schema.Struct({
  // 可选的会话 ID（省略表示当前会话）
  sessionID: Schema.optionalKey(Session.ID).annotate({ description: "Omit to move the current session." }),
  // 目标目录（支持 ~ 与相对路径）
  directory: AbsolutePath.check(Schema.isMinLength(1)).annotate({
    description: "Destination directory, relative to the target session's directory or absolute. Supports ~.",
  }),
})

// session_move 的输出 Schema：会话 ID + 新目录
const MoveOutput = Schema.Struct({ sessionID: Session.ID, directory: AbsolutePath })

// worktree_create 工具的输入 Schema
export const WorktreeCreateInput = Schema.Struct({
  // 工作树名称（去空白后非空）
  name: Schema.Trim.check(Schema.isNonEmpty()).annotate({ description: "Worktree name." }),
})

// worktree_remove 工具的输入 Schema
export const WorktreeRemoveInput = Schema.Struct({
  // 要移除的工作树绝对路径
  directory: AbsolutePath.check(Schema.isMinLength(1)).annotate({
    description: "Absolute path of the worktree to remove.",
  }),
  // 可选的强制移除（丢弃改动与未跟踪文件）
  force: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Discard modified and untracked files. Only set this when the user has confirmed forced removal.",
  }),
})

// worktree_remove 的输出 Schema：目录 + 是否已移除
const WorktreeRemoveOutput = Schema.Struct({ directory: AbsolutePath, removed: Schema.Boolean })

// models 工具的输入 Schema
export const ModelsInput = Schema.Struct({
  // 可选的搜索关键词
  query: Schema.optionalKey(Schema.String).annotate({
    description: "Text to search for in model names and IDs.",
  }),
  // 可选的 provider 过滤
  provider: Schema.optionalKey(Schema.String).annotate({
    description: "Provider ID or name to filter by. Try your own provider first.",
  }),
  // 可选的模型类型：chat 或 image
  type: Schema.optionalKey(Schema.Literals(["chat", "image"])).annotate({
    description: [
      'Which kind of model to list. Defaults to "chat".',
      '"chat": a language model (LLM). Powers sessions, agents and subagents, and can call tools.',
      '"image": generates or edits images from a prompt. It can\'t chat or call tools.',
    ].join("\n"),
  }),
  // 可选：是否包含模型家族的旧版本
  all: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Include older versions of each model family. By default only the newest version is listed.",
  }),
  // 可选的返回上限（1-100，默认 20）
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))).annotate({
    description: "Maximum number of models to return. Defaults to 20.",
  }),
  // 可选的分页偏移
  offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))).annotate({
    description: "Number of models to skip, for paging through results.",
  }),
})

// 单个模型条目的 Schema
const ModelEntry = Schema.Struct({
  // 模型引用（providerID/modelID）
  id: Schema.String.annotate({ description: "providerID/modelID" }),
  // 模型名称
  name: Schema.String,
  // 发布时间（Unix 毫秒时间戳，未知为 0）
  released: Model.Info.fields.time.fields.released.annotate({
    description: "Release date as a Unix timestamp in milliseconds, or 0 when unknown.",
  }),
  // 支持的变体列表
  variants: Schema.Array(Model.VariantID),
  // 价格（美元/百万 token）
  cost: Model.Info.fields.cost.annotate({ description: "Pricing in USD per million tokens." }),
  // 模型状态
  status: Model.Info.fields.status,
})

// models 的输出 Schema：按 provider 分组的模型列表 + 总数 + 下一页偏移
const ModelsOutput = Schema.Struct({
  providers: Schema.Array(
    Schema.Struct({
      // provider ID
      id: Schema.String,
      // provider 名称
      name: Schema.String,
      // 该 provider 下的匹配模型（最新在前）
      models: Schema.Array(ModelEntry).annotate({ description: "Newest first." }),
    }),
  ).annotate({ description: "Matching models grouped by provider. Your own provider comes first." }),
  // 所有页的匹配模型总数
  total: Schema.Int.annotate({ description: "Number of matching models across all pages." }),
  // 下一页偏移（最后一页为 null）
  next: Schema.NullOr(Schema.Int).annotate({ description: "Offset of the next page, or null on the last page." }),
})

// 插件定义：注册 OpenCode 自身管理类工具
export const Plugin = {
  // 插件唯一标识
  id: "opencode.tools",
  // 插件的 Effect 主体
  effect: Effect.fn("OpenCodeTools.Plugin")(function* (ctx: Context) {
    // 注入文件访问服务
    const access = yield* FileAccess.Service
    // 注入权限服务
    const permission = yield* Permission.Service
    // 会话钩子：向系统提示追加工作树使用建议
    const hook = (event: SessionHooks["context"]) =>
      Effect.sync(() => {
        // 在 system 部分插入提示：跨目录建工作树时考虑用 session_move 切换工作目录
        event.system.push(
          SystemPart.make(
            "When you create a worktree outside the current working directory and intend to use it as your primary working directory, consider using `execute` to call `tools.opencode.session_move` and make the worktree the session's working directory.",
          ),
        )
      })
    // 在 context / compaction / generate 三个钩子点注册同一提示
    yield* ctx.session.hook("context", hook)
    yield* ctx.session.hook("compaction", hook)
    yield* ctx.session.hook("generate", hook)
    // 向工具注册中心批量注册工具
    yield* ctx.tool
      .transform((draft) => {
        // 声明 opencode 命名空间及其说明
        draft.namespace({
          name: "opencode",
          description:
            "Tools for managing OpenCode itself, such as working with sessions and worktrees, searching the available models, and reading MCP resources.",
        })
        // 注册 session_rename：重命名会话
        draft.add({
          name: "session_rename",
          description:
            "Rename a session, or omit sessionID to rename the current session. Use a short, specific title that summarizes the work being done.",
          input: RenameInput,
          output: RenameOutput,
          options: { namespace: "opencode", codemode: true },
          execute: (input, context) => {
            // 目标会话：未传则用当前会话
            const sessionID = input.sessionID ?? context.sessionID
            // 去除标题首尾空白
            const title = input.title.trim()
            // 空标题直接失败
            if (!title) return Effect.fail(new ToolFailure({ message: "Session title must not be empty" }))
            // 调用会话更新并返回结果
            return ctx.session.update({ sessionID, title }).pipe(
              Effect.as({
                output: { sessionID, title },
                content: `Renamed session ${sessionID} to ${title}.`,
              }),
              // 失败映射为工具失败
              Effect.mapError((error) => new ToolFailure({ message: `Unable to rename session ${sessionID}`, error })),
            )
          },
        })
        // 注册 session_move：把会话迁到另一个目录
        draft.add({
          name: "session_move",
          description:
            "Move a session to another directory, or omit sessionID to move the current session. The current session moves at the next safe boundary; do not run destination-dependent tools in the same execute call.",
          input: MoveInput,
          output: MoveOutput,
          // 选项：opencode 命名空间 + codemode + 置顶
          options: { namespace: "opencode", codemode: true, pinned: true },
          execute: (input, context) =>
            Effect.gen(function* () {
              // 目标会话：未传则用当前会话
              const sessionID = input.sessionID ?? context.sessionID
              // 执行迁移（delivery: "steer" 表示在下一个安全边界生效）
              yield* ctx.session.move({
                sessionID,
                directory: input.directory,
                delivery: "steer",
              })
              // 返回迁移结果
              return {
                output: { sessionID, directory: input.directory },
                content: `Moved session ${sessionID} to ${input.directory}.`,
              }
            }).pipe(
              // 失败映射为工具失败
              Effect.mapError(
                (error) => new ToolFailure({ message: `Unable to move session to ${input.directory}`, error }),
              ),
            ),
        })
        // 注册 worktree_create：创建命名工作树
        draft.add({
          name: "worktree_create",
          description: "Create a named worktree. Returns its directory.",
          input: WorktreeCreateInput,
          // 输出：Worktree 信息
          output: Worktree.Info,
          options: { namespace: "opencode", codemode: true, pinned: true },
          execute: (input) =>
            // 以当前项目为归属创建工作树
            ctx.worktree.create({ projectID: ctx.location.project.id, name: input.name }).pipe(
              // 成功后返回目录信息
              Effect.map((output) => ({ output, content: `Created worktree in ${output.directory}.` })),
              Effect.mapError(
                (error) => new ToolFailure({ message: `Unable to create worktree ${input.name}`, error }),
              ),
            ),
        })
        // 注册 worktree_list：列出仓库的工作树
        draft.add({
          name: "worktree_list",
          description: "List a repository's worktrees.",
          // 无输入参数
          input: Schema.Struct({}),
          // 输出：工作树列表
          output: Schema.Struct({ worktrees: Worktree.List }),
          options: { namespace: "opencode", codemode: true, pinned: true },
          execute: () =>
            // 按当前项目列出
            ctx.worktree.list({ projectID: ctx.location.project.id }).pipe(
              Effect.map((worktrees) => ({ output: { worktrees } })),
              Effect.mapError((error) => new ToolFailure({ message: "Unable to list worktrees", error })),
            ),
        })
        // 注册 worktree_remove：移除工作树（需要 edit 权限）
        draft.add({
          name: "worktree_remove",
          description:
            "Remove a worktree. The repository location selects configuration; directory identifies the worktree to remove.",
          input: WorktreeRemoveInput,
          output: WorktreeRemoveOutput,
          // 选项：额外要求 edit 权限
          options: { namespace: "opencode", codemode: true, pinned: true, permission: "edit" },
          execute: (input, context) =>
            Effect.gen(function* () {
              // Removing a worktree deletes files, so it requires the same approval as editing them.
              // 解析目标目录
              const target = yield* access.resolve({ path: input.directory, kind: "directory" })
              // 断言 edit 权限（删除文件与编辑文件同级审批）
              yield* permission.assert({
                action: "edit",
                resources: [target.resource],
                save: ["*"],
                ...Permission.invocation(context),
              })
              // 执行移除（force 缺省为 false）
              yield* ctx.worktree
                .remove({
                  projectID: ctx.location.project.id,
                  directory: target.absolute,
                  force: input.force ?? false,
                })
                .pipe(Effect.mapError((error) => new ToolFailure({ message: removeFailure(target.absolute, error) })))
              // 返回移除结果
              return {
                output: { directory: target.absolute, removed: true },
                content: `Removed worktree ${target.absolute}.`,
              }
            }).pipe(
              // 其他失败给通用消息
              Effect.mapError(toolFailure(`Unable to remove worktree ${input.directory}`)),
            ),
        })
        // 注册 models：搜索可用模型
        draft.add({
          name: "models",
          description:
            "Search the models available to use. Use this to turn a model name the user mentions into an exact reference for a tool that takes a model. Check your own provider first.",
          input: ModelsInput,
          output: ModelsOutput,
          options: { namespace: "opencode", codemode: true },
          execute: (input, context) =>
            Effect.gen(function* () {
              // 分页偏移（默认 0）
              const offset = input.offset ?? 0
              // 每页上限（默认 20）
              const limit = input.limit ?? 20
              // 当前会话使用的 provider（用于把“自己的 provider”排前）
              const own = (yield* ctx.session.get({ sessionID: context.sessionID })).model?.providerID
              // 拆分搜索词（小写、去空）
              const terms = input.query?.toLowerCase().split(/\s+/).filter(Boolean) ?? []
              // provider ID -> 名称映射
              const names = new Map((yield* ctx.provider.list()).data.map((provider) => [provider.id, provider.name]))
              // provider 过滤条件（小写）
              const provider = input.provider?.toLowerCase()
              // 拉取指定类型的模型并逐步过滤：
              const matching = (yield* ctx.model.list({ types: [input.type ?? "chat"] })).data
                // 按 provider 过滤（ID 或名称匹配）
                .filter(
                  (model) =>
                    provider === undefined ||
                    model.providerID.toLowerCase() === provider ||
                    names.get(model.providerID)?.toLowerCase() === provider,
                )
                // 按关键词过滤：所有词都要出现在 "provider/id 名称" 文本中
                .filter((model) => {
                  const text = `${model.providerID}/${model.id} ${model.name}`.toLowerCase()
                  return terms.every((term) => text.includes(term))
                })
                // 排序：自己的 provider 优先，其次按 provider 名，再按发布时间新到旧
                .toSorted(
                  (left, right) =>
                    Number(right.providerID === own) - Number(left.providerID === own) ||
                    left.providerID.localeCompare(right.providerID) ||
                    right.time.released - left.time.released,
                )
                // 家族去重：未开启 all 时每个（provider, family）只保留排序后最先出现的最新版本
                .filter((model, index, sorted) => {
                  if (input.all || model.family === undefined) return true
                  return (
                    sorted.findIndex(
                      (other) => other.providerID === model.providerID && other.family === model.family,
                    ) === index
                  )
                })
              // 截取当前页
              const page = matching.slice(offset, offset + limit)
              // 按 provider 分组组装输出
              const providers = Array.from(new Set(page.map((model) => model.providerID))).map((id) => ({
                // provider ID
                id,
                // provider 名称（缺失用 ID 兜底）
                name: names.get(id) ?? id,
                // 该 provider 下的模型条目
                models: page
                  .filter((model) => model.providerID === id)
                  .map((model) => ({
                    // 引用形式 providerID/modelID
                    id: `${model.providerID}/${model.id}`,
                    // 名称
                    name: model.name,
                    // 发布时间
                    released: model.time.released,
                    // 变体 ID 列表
                    variants: model.variants.map((variant) => variant.id),
                    // 价格
                    cost: model.cost,
                    // 状态
                    status: model.status,
                  })),
              }))
              // 返回分组结果、总数与下一页偏移
              return {
                output: {
                  providers,
                  total: matching.length,
                  next: offset + limit < matching.length ? offset + limit : null,
                },
              }
            }).pipe(Effect.mapError((error) => new ToolFailure({ message: "Unable to list models", error }))),
        })
      })
      // 注册出错则直接中断
      .pipe(Effect.orDie)
  }),
}

// Worktree errors carry no model-facing message, and Git's own text suggests forcing removal.
// 把移除工作树的各种错误翻译成面向模型的具体消息
function removeFailure(directory: string, error: unknown) {
  // 目录不存在或不是目录
  if (error instanceof Worktree.DirectoryUnavailableError)
    return `Unable to remove worktree ${directory}: the directory does not exist or is not a directory.`
  // 不是本项目的 worktree
  if (error instanceof Worktree.InvalidDirectoryError)
    return `Unable to remove ${directory}: it is not a worktree of this project. Use worktree_list to see the project's worktrees.`
  // 所需的 worktree 策略不可用
  if (error instanceof Worktree.StrategyUnavailableError)
    return `Unable to remove worktree ${directory}: its worktree strategy ${error.strategy} is not available.`
  // 需要强制移除（有改动或未跟踪文件）
  if ((error instanceof Git.WorktreeError || error instanceof Worktree.OperationError) && error.forceRequired)
    return `Unable to remove worktree ${directory}: it has modified or untracked files.`
  // 兜底消息
  return `Unable to remove worktree ${directory}.`
}
