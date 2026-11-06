/**
 * Model-facing file-write leaf. Relative paths resolve within the active
 * Location. Absolute paths inside that Location are accepted, while explicit
 * absolute external paths retain mutation capability through a separate
 * external_directory approval before edit approval.
 */
// 将本文件的所有导出聚合到命名空间 WriteTool 下，供插件系统统一引入
export * as WriteTool from "./write.js"

// 插件上下文类型（Context），提供 tool/session 等扩展点
import type { Context } from "@opencode/plugin/effect/plugin"
// 工具执行失败时抛出的错误类型（ToolFailure）
import { ToolFailure } from "@opencode/ai/effect"
// effect 库核心：Effect 副作用编排、Schema 数据校验
import { Effect, Schema } from "effect"
// FileWrite 服务：负责实际的文件写入逻辑
import { FileWrite } from "../../file-write.js"

// 工具名称：write（写文件）
export const name = "write"

// TODO: Revisit whether model-facing mutation schemas should prefer absolute `filePath` naming for trained-in compatibility after evaluating model behavior.
// 工具入参 Schema
export const Input = Schema.Struct({
  // path：要写入的文件路径
  path: Schema.String.annotate({
    description: "Path to the file to write to",
  }),
  // content：要写入的完整内容
  content: Schema.String.annotate({ description: "Content to write to the file" }),
})

// 工具出参 Schema
export const Output = Schema.Struct({
  // 操作类型固定为 write
  operation: Schema.Literal("write"),
  // 目标路径
  target: Schema.String,
  // 实际写入的资源标识
  resource: Schema.String,
  // 文件写入前是否已存在
  existed: Schema.Boolean,
})
// Output 的 TypeScript 类型
export type Output = typeof Output.Type

// 把写入结果转成面向模型的简短回执文案（区分"已写入"与"新建"）
export const toModelContent = (output: Output) =>
  `${output.existed ? "Wrote" : "Created"} file successfully: ${output.resource}`

/** Deferred write UX integrations remain visible at the model-facing seam. */
// TODO: Publish watcher/file-edit events after watcher integration exists.
// TODO: Add snapshots / undo after design exists.
// TODO: Add LSP notification and diagnostics after LSP runtime exists.

// 插件定义：注册 write 工具
export const Plugin = {
  // 插件唯一标识
  id: "opencode.tool.write",
  // 插件主 effect：获取文件写入服务并注册工具
  effect: Effect.fn("WriteTool.Plugin")(function* (ctx: Context) {
    // 获取文件写入（FileWrite）服务
    const fileWrite = yield* FileWrite.Service

    // 向工具注册表提交本工具的定义
    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          // 工具名
          name,
          // 关闭 codemode；权限类别归为 edit（编辑类操作）
          options: { codemode: false, permission: "edit" },
          // 工具描述：整文件写入，自动创建缺失的父目录，局部修改建议用 edit 工具
          description:
            "Writes a file to the local filesystem, overwriting if one exists.\n\nMissing parent directories are created automatically.\n\nUse this tool to create new files or overwrite existing files. For partial changes, use the edit tool instead.",
          // 入参 Schema
          input: Input,
          // 出参 Schema
          output: Output,
          // 工具执行体：调用 FileWrite 服务完成写入
          execute: (input, context) =>
            Effect.gen(function* () {
              // 执行写入，返回写入详情
              const written = yield* fileWrite.write(input, context)
              // 组装标准化的输出字段
              return {
                // 操作类型
                operation: written.operation,
                // 目标路径
                target: written.target,
                // 资源标识
                resource: written.resource,
                // 是否覆盖了已存在的文件
                existed: written.existed,
              }
            }).pipe(
              // 成功时把输出映射为工具响应（附带回执文案）
              Effect.map((output) => ({ output, content: toModelContent(output) })),
              // 失败时转为工具错误
              Effect.mapError((error) => new ToolFailure({ message: `Unable to write ${input.path}`, error })),
            ),
        }),
      )
      // 注册失败则直接终止
      .pipe(Effect.orDie)
  }),
}
