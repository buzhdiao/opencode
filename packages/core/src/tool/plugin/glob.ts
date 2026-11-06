// 将本模块以命名空间方式重新导出为 GlobTool
export * as GlobTool from "./glob.js"

// 导入 Effect 化的工具失败类型（ToolFailure）
import { ToolFailure } from "@opencode/ai/effect"
// 导入插件上下文类型（Context）
import type { Context } from "@opencode/plugin/effect/plugin"
// 导入 Effect 原语：Effect、Schema
import { Effect, Schema } from "effect"
// 导入 Node.js path 模块，用于路径运算
import path from "path"
// 导入统一的工具失败映射函数
import { toolFailure } from "../runtime.js"
// 导入搜索辅助模块（路径类型判断、带限额的搜索）
import { ToolSearch } from "../search.js"
// 导入环境（Environment）服务
import { Environment } from "../../environment/index.js"
// 导入文件系统（FileSystem）Schema 与常量
import { FileSystem } from "../../filesystem.js"
// 导入位置（Location）服务：当前工作目录
import { Location } from "../../location.js"
// 导入文件访问（FileAccess）服务：路径解析与授权
import { FileAccess } from "../../file-access.js"
// 导入 Ripgrep 服务：底层 ripgrep 搜索
import { Ripgrep } from "../../ripgrep.js"
// 导入 RelativePath 品牌化类型（相对路径）
import { RelativePath } from "../../schema.js"
// 导入权限（Permission）服务
import { Permission } from "../../permission.js"

// 工具名
export const name = "glob"

// glob 工具的输入 Schema
export const Input = Schema.Struct({
  // glob 匹配模式
  pattern: FileSystem.GlobInput.fields.pattern.annotate({ description: "Glob pattern to match files against" }),
  // 可选的搜索目录（默认当前工作目录）
  path: Schema.optionalKey(RelativePath).annotate({
    description: "Directory to search. Defaults to the current working directory.",
  }),
  // 是否包含隐藏文件与目录
  hidden: FileSystem.GlobInput.fields.hidden.annotate({
    description: "Include hidden files and directories (default: false).",
  }),
  // 返回结果的最大数量
  limit: FileSystem.GlobInput.fields.limit.annotate({
    description: `Maximum number of matching files to return (default: ${FileSystem.DEFAULT_SEARCH_LIMIT})`,
  }),
})

// 输出 Schema：文件条目数组
export const Output = Schema.Array(FileSystem.Entry)
// 编码后（传输形态）的输出类型
type EncodedOutput = typeof Output.Encoded

/** Format raw search results into the concise line-oriented output models expect. */
// 把原始搜索结果格式化为面向模型的简洁逐行文本
export const toModelContent = (entries: EncodedOutput, truncated = false) => {
  // 无结果时给提示，否则逐行列出文件路径
  const lines = entries.length === 0 ? ["No files found"] : entries.map((item) => item.path)
  // 结果被截断时追加提示
  if (truncated)
    lines.push(
      "",
      `(Results are truncated: showing first ${entries.length} results. Consider using a more specific path or pattern.)`,
    )
  // 拼成多行文本
  return lines.join("\n")
}

/** Glob leaf that defaults its filesystem root to the active Location. */
// Glob 工具插件定义：文件系统根目录默认取当前活动 Location
export const Plugin = {
  // 插件唯一标识
  id: "opencode.tool.glob",
  // 插件的 Effect 主体
  effect: Effect.fn("GlobTool.Plugin")(function* (ctx: Context) {
    // 注入环境服务
    const environment = yield* Environment.Service
    // 注入 ripgrep 服务
    const ripgrep = yield* Ripgrep.Service
    // 注入位置服务
    const location = yield* Location.Service
    // 注入文件访问服务
    const access = yield* FileAccess.Service
    // 注入权限服务
    const permission = yield* Permission.Service

    // 向工具注册中心注册 glob 工具
    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          // 工具名
          name,
          // 选项：不启用 codemode（不并入代码模式工具集）
          options: { codemode: false },
          // 工具描述（带示例）
          description: 'Search file paths using a glob pattern (examples: "**/*.ts", "src/**/*.tsx").',
          // 输入/输出 Schema
          input: Input,
          output: Output,
          // 执行体
          execute: (input, context) =>
            Effect.gen(function* () {
              // 规整搜索路径：模型有时会传字符串 "undefined"/"null"，按缺失处理
              const searchPath = input.path === "undefined" || input.path === "null" ? undefined : input.path
              // 解析目标目录为可访问对象
              const target = yield* access.resolve({ path: searchPath ?? ".", kind: "directory" })
              // 授权访问（若目标在工作区外则需要外部访问授权）
              yield* access.authorizeExternal([target], context)
              // 断言权限：以 glob 为动作名，模式作为资源
              yield* permission.assert({
                action: name,
                resources: [input.pattern],
                save: ["*"],
                metadata: {
                  // 搜索根
                  root: searchPath ?? ".",
                  // 搜索路径
                  path: searchPath,
                  // 是否含隐藏文件
                  hidden: input.hidden,
                  // 结果上限
                  limit: input.limit,
                },
                // 附带调用上下文
                ...Permission.invocation(context),
              })
              // 判断目标路径的类型（文件/目录/不存在）
              const type = yield* ToolSearch.pathType(environment.files, target.absolute, searchPath ?? ".")
              // 不是目录则失败
              if (type !== "directory")
                return yield* Effect.fail(
                  new ToolFailure({ message: `Search path is not a directory: ${searchPath ?? "."}` }),
                )
              // 搜索根的绝对路径
              const root = target.absolute
              // 执行带限额的 glob 搜索（limit 缺省用默认搜索上限）
              const result = yield* ToolSearch.bounded(input.limit ?? FileSystem.DEFAULT_SEARCH_LIMIT, (limit) =>
                ripgrep.glob({ cwd: root, pattern: input.pattern, hidden: input.hidden, limit }),
              )
              // 返回结果：把每个条目的路径换算成相对当前 Location 的路径
              return {
                entries: result.items.map((entry) =>
                  FileSystem.Entry.make({
                    ...entry,
                    path: RelativePath.make(path.relative(location.directory, path.resolve(root, entry.path))),
                  }),
                ),
                // 是否被截断
                truncated: result.truncated,
              }
            }).pipe(
              // 成功后组织工具返回：输出条目数组 + 面向模型的文本 + 元数据
              Effect.map((result) => ({
                output: result.entries,
                content: toModelContent(
                  // 内容里的路径用绝对路径表示，便于模型引用
                  result.entries.map((entry) => ({ ...entry, path: path.resolve(location.directory, entry.path) })),
                  result.truncated,
                ),
                metadata: { count: result.entries.length, truncated: result.truncated },
              })),
              // 失败统一映射为工具失败
              Effect.mapError(toolFailure(`Unable to find files matching ${input.pattern}`)),
            ),
        }),
      )
      // 注册出错则直接中断
      .pipe(Effect.orDie)
  }),
}
