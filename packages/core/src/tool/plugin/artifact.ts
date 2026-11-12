// 将本模块以命名空间方式重新导出为 ArtifactTools
export * as ArtifactTools from "./artifact.js"

// 导入 Effect 化的工具失败类型（ToolFailure）
import { ToolFailure } from "@opencode/ai/effect"
// 导入插件上下文类型（Context）
import type { Context } from "@opencode/plugin/effect/plugin"
// 导入 optional 标注：把字段标记为可选
import { optional } from "@opencode/schema/schema"
// 导入 Effect 原语：Effect、Schema、Stream
import { Effect, Schema, Stream } from "effect"
// 导入 Artifact（工件）服务
import { Artifact } from "../../artifact.js"
// 导入配置（Config）服务
import { Config } from "../../config.js"
// 导入配置条目观察器：监听配置变化
import { ConfigEntryObserver } from "../../config/plugin/entry-observer.js"
// 导入功能开关（Flag）服务
import { Flag } from "../../flag.js"

// artifact_create 工具的输入 Schema
export const CreateToolInput = Schema.Struct({
  // 工件标题（人类可读）
  title: Schema.String.annotate({ description: "Human-readable artifact title." }),
  // 文件映射：相对路径 -> UTF-8 内容
  files: Schema.Record(Schema.String, Schema.String).annotate({
    description: "UTF-8 file map keyed by relative path (for example index.html and assets/app.js).",
  }),
  // 可选的入口文件（相对工件根目录；默认 index.html、index.md 或唯一文件）
  entry: Schema.String.pipe(optional).annotate({
    description: "Entry file path relative to the artifact root. Defaults to index.html, index.md, or the sole file.",
  }),
  // 可选的 provider 覆盖（临时指定工件提供商）
  provider: Schema.String.pipe(optional).annotate({
    description: "Artifact provider ID to override the default provider for this request.",
  }),
})

// artifact_read 工具的输入 Schema：工件 ID
export const ReadToolInput = Schema.Struct({
  // 要读取的工件 ID
  id: Artifact.ID.annotate({ description: "Artifact ID (art_...) to read." }),
})

// artifact_update 工具的输入 Schema：ID + 可选更新字段 + 必填的替换文件映射
export const UpdateToolInput = Schema.Struct({
  // 要更新的工件 ID
  id: Artifact.ID.annotate({ description: "Artifact ID (art_...) to update." }),
  // 可选的新标题（省略则保留原标题）
  title: Schema.String.pipe(optional).annotate({ description: "Updated title, or omit to keep the current title." }),
  // 替换用的文件映射
  files: Schema.Record(Schema.String, Schema.String).annotate({
    description: "Replacement UTF-8 file map keyed by relative path.",
  }),
  // 可选的新入口文件
  entry: Schema.String.pipe(optional).annotate({ description: "Updated entry file path." }),
})

// artifact_delete 工具的输入 Schema：工件 ID
export const DeleteToolInput = Schema.Struct({
  // 要删除的工件 ID
  id: Artifact.ID.annotate({ description: "Artifact ID (art_...) to delete." }),
})

// artifact_delete 的输出 Schema：被删 ID 与删除标记
const DeleteToolOutput = Schema.Struct({
  // 被删除的工件 ID
  id: Artifact.ID,
  // 是否已删除
  deleted: Schema.Boolean,
})

// 插件定义：注册 artifact（工件）相关工具
export const Plugin = {
  // 插件唯一标识
  id: "opencode.tool.artifact",
  // 插件的 Effect 主体
  effect: Effect.fn("ArtifactTools.Plugin")(function* (ctx: Context) {
    // 注入配置服务
    const config = yield* Config.Service
    // 注入工件服务
    const artifacts = yield* Artifact.Service

    // artifact_create 描述文案的快照（可变容器，配置/工件变化时刷新）
    const promptSnapshot = { text: yield* renderCreateDescription(artifacts) }
    // 刷新工具描述并重载注册中心的 Effect
    const refreshTools = Effect.gen(function* () {
      // 重新渲染描述文案
      promptSnapshot.text = yield* renderCreateDescription(artifacts)
      // 重载工具注册中心
      yield* ctx.tool.reload()
    })

    // 观察配置条目变化，变化时触发 refreshTools（返回已加载的配置条目）
    const loaded = yield* ConfigEntryObserver.observe(config, ctx.event, refreshTools)
    // 订阅“工件已更新”事件，同样触发刷新（后台 Fiber，立即启动）
    yield* ctx.event.subscribe({ types: [Artifact.Event.Updated.type] }).pipe(
      Stream.runForEach(() => refreshTools),
      Effect.forkScoped({ startImmediately: true }),
    )

    const flags = yield* Flag.Service
    const enabled = () => flags.resolve(loaded.entries).artifacts.enabled
    const failure = (error: { readonly message: string }) => new ToolFailure({ message: error.message, error })

    // 对工具注册中心做一次变换，批量注册 artifact 工具
    yield* ctx.tool
      .transform((editor) => {
        // 功能未启用则不注册任何工具
        if (!enabled()) return

        // 注册 artifact_create：发布新工件
        editor.add({
          // 工具名
          name: "artifact_create",
          // 描述来自动态快照（含 provider 提示）
          description: promptSnapshot.text,
          // 输入 Schema
          input: CreateToolInput,
          // 输出 Schema：工件信息
          output: Artifact.Info,
          // 选项：opencode 命名空间 + 启用 codemode
          options: { namespace: "opencode", codemode: true },
          // 执行体：调用工件服务创建
          execute: (input, context) =>
            artifacts
              .create({
                // 标题
                title: input.title,
                // 文件映射
                files: input.files,
                // 入口文件
                entry: input.entry,
                // provider：有传则转成 ProviderID 类型
                provider: input.provider === undefined ? undefined : Artifact.ProviderID.make(input.provider),
                // 所属会话 ID
                sessionID: context.sessionID,
              })
              .pipe(
                // 成功后返回工件信息与摘要内容
                Effect.map((info) => ({
                  output: info,
                  content: `Published ${info.title} (${info.id} via ${info.provider}): ${info.url}`,
                })),
                // 失败映射为 ToolFailure
                Effect.mapError(failure),
              ),
        })

        // 注册 artifact_read：读取工件元数据与文件内容
        editor.add({
          name: "artifact_read",
          description: "Read an artifact's metadata and file contents so you can inspect or update it.",
          input: ReadToolInput,
          output: Artifact.Content,
          options: { namespace: "opencode", codemode: true },
          execute: (input) =>
            // 按 ID 获取工件内容
            artifacts.get(input.id).pipe(
              // 成功后返回内容与摘要（标题、ID、文件数）
              Effect.map((content) => ({
                output: content,
                content: `${content.info.title} (${content.info.id} · ${Object.keys(content.files).length} files)`,
              })),
              Effect.mapError(failure),
            ),
        })

        // 注册 artifact_update：在同一 ID/URL 下替换文件
        editor.add({
          name: "artifact_update",
          description: "Replace an existing artifact's files at the same ID and URL.",
          input: UpdateToolInput,
          output: Artifact.Info,
          options: { namespace: "opencode", codemode: true },
          execute: (input, context) =>
            // 调用更新
            artifacts
              .update(input.id, {
                // 可选新标题
                title: input.title,
                // 替换文件映射
                files: input.files,
                // 可选新入口
                entry: input.entry,
                // 所属会话 ID
                sessionID: context.sessionID,
              })
              .pipe(
                // 成功后返回工件信息与摘要内容
                Effect.map((info) => ({
                  output: info,
                  content: `Updated ${info.title} (${info.id}): ${info.url}`,
                })),
                Effect.mapError(failure),
              ),
        })

        // 注册 artifact_delete：删除工件并清理存储副本
        editor.add({
          name: "artifact_delete",
          description: "Delete an artifact and remove its stored copy.",
          input: DeleteToolInput,
          output: DeleteToolOutput,
          options: { namespace: "opencode", codemode: true },
          execute: (input) =>
            // 调用删除
            artifacts.remove(input.id).pipe(
              // 成功后返回删除结果
              Effect.map(() => ({
                output: { id: input.id, deleted: true },
                content: `Deleted ${input.id}`,
              })),
              Effect.mapError(failure),
            ),
        })
      })
      // 注册过程若出错则直接中断（orDie）
      .pipe(Effect.orDie)
  }),
}

// 渲染 artifact_create 的描述文案：包含默认 provider 与其他可用 provider 的说明
function renderCreateDescription(artifacts: Artifact.Interface) {
  return artifacts.prompts().pipe(
    Effect.map(({ defaultProvider, others }) => {
      // 基础行：功能说明 + 默认 provider 的 id、能力列表与提示
      const lines = [
        "Publish a new artifact to the default artifact provider or a named override.",
        `Default provider (${defaultProvider.id} [${defaultProvider.capabilities.join(", ")}]): ${defaultProvider.prompt}`,
      ]
      // 存在其他可用 provider 时追加说明
      if (others.length > 0) {
        lines.push(
          `Other active providers (pass provider to override): ${others.map((item) => `${item.id} [${item.capabilities.join(", ")}]`).join(", ")}.`,
        )
      }
      // 拼成多行文本
      return lines.join("\n")
    }),
  )
}
