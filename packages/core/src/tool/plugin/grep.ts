// 将本模块以命名空间方式重新导出为 GrepTool
export * as GrepTool from "./grep.js"

// 导入插件上下文类型（Context）
import type { Context } from "@opencode/plugin/effect/plugin"
// 导入 Effect 化的工具失败类型（ToolFailure）
import { ToolFailure } from "@opencode/ai/effect"
// 导入 Effect 原语：Effect、Schema
import { Effect, Schema } from "effect"
// 导入 Node.js path 模块，用于路径运算
import path from "path"
// 导入环境（Environment）服务
import { Environment } from "../../environment/index.js"
// 导入文件系统（FileSystem）Schema 与常量
import { FileSystem } from "../../filesystem.js"
// 导入位置（Location）服务：当前工作目录
import { Location } from "../../location.js"
// 导入文件访问（FileAccess）服务：路径解析与授权
import { FileAccess } from "../../file-access.js"
// 导入权限（Permission）服务
import { Permission } from "../../permission.js"
// 导入 Ripgrep 服务：底层 ripgrep 搜索
import { Ripgrep } from "../../ripgrep.js"
// 导入 RelativePath 品牌化类型（相对路径）
import { RelativePath } from "../../schema.js"
// 导入搜索辅助模块（路径类型判断、带限额的搜索）
import { ToolSearch } from "../search.js"

// 工具名
export const name = "grep"

// grep 工具的输入 Schema
export const Input = Schema.Struct({
  // 匹配模式：正则或字面文本，且不能为空
  pattern: FileSystem.GrepInput.fields.pattern
    .check(Schema.isMinLength(1, { message: "Pattern must not be empty" }))
    .annotate({
      description: "Regular expression or literal text to match in file contents.",
    }),
  // 可选的搜索目标（文件或目录，默认当前工作目录）
  path: Schema.optionalKey(RelativePath).annotate({
    description: "File or directory to search. Defaults to the current working directory.",
  }),
  // 文件名过滤的 glob 模式
  include: FileSystem.GrepInput.fields.include.annotate({
    description: 'Glob pattern to filter files (for example, "*.js" or "*.{ts,tsx}")',
  }),
  // 是否把 pattern 当作字面文本而非正则
  literal: FileSystem.GrepInput.fields.literal.annotate({
    description: "Treat `pattern` as exact text instead of a regular expression (default: false).",
  }),
  // 是否区分大小写
  caseSensitive: FileSystem.GrepInput.fields.caseSensitive.annotate({
    description: "Use case-sensitive matching (default: true).",
  }),
  // 返回匹配行的最大数量
  limit: FileSystem.GrepInput.fields.limit.annotate({
    description: `Maximum number of matching lines to return (default: ${FileSystem.DEFAULT_SEARCH_LIMIT})`,
  }),
})

// 输出 Schema：匹配项数组
export const Output = Schema.Array(FileSystem.Match)
// 编码后（传输形态）的输出类型
type EncodedOutput = typeof Output.Encoded

/** Format raw search matches into concise model content. */
// 把原始搜索匹配格式化为面向模型的简洁文本
export const toModelContent = (matches: EncodedOutput, truncated = false) => {
  // 无匹配时给提示，否则先输出总匹配数
  const lines = matches.length === 0 ? ["No matches found"] : [`Found ${matches.length} matches`]
  // 当前正在输出的文件路径
  let current = ""
  // 逐条输出匹配：同一文件的行归到同一标题下
  for (const match of matches) {
    // 换文件时先输出文件名标题
    if (current !== match.entry.path) {
      // 文件之间空一行分隔
      if (current) lines.push("")
      // 更新当前文件
      current = match.entry.path
      // 输出 "路径:" 标题行
      lines.push(`${match.entry.path}:`)
    }
    // 输出行号与行内容预览（缩进两格）
    lines.push(`  Line ${match.line}: ${match.text}`)
  }
  // 结果被截断时追加提示
  if (truncated)
    lines.push(
      "",
      `(Results are truncated: showing first ${matches.length} results. Consider using a more specific path or pattern.)`,
    )
  // 拼成多行文本
  return lines.join("\n")
}

/** Grep leaf that defaults its filesystem root to the active Location. */
// Grep 工具插件定义：文件系统根目录默认取当前活动 Location
export const Plugin = {
  // 插件唯一标识
  id: "opencode.tool.grep",
  // 插件的 Effect 主体
  effect: Effect.fn("GrepTool.Plugin")(function* (ctx: Context) {
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

    // 向工具注册中心注册 grep 工具
    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          // 工具名
          name,
          // 选项：不启用 codemode
          options: { codemode: false },
          // 工具描述：说明用途与返回内容
          description:
            "Search file contents using ripgrep's regular expression syntax or literal text matching. Use it to locate specific code, symbols, or text patterns, and narrow searches with `path` or `include`. Returns matching file paths, line numbers, and line previews.",
          // 输入/输出 Schema
          input: Input,
          output: Output,
          // 执行体
          execute: (input, context) =>
            Effect.gen(function* () {
              // 解析目标路径（默认当前目录）为可访问对象
              const target = yield* access.resolve({ path: input.path ?? "." })
              // 授权访问（工作区外需要外部访问授权）
              yield* access.authorizeExternal([target], context)
              // 断言权限：以 grep 为动作名，模式作为资源，并记录各参数元数据
              yield* permission.assert({
                action: name,
                resources: [input.pattern],
                save: ["*"],
                metadata: {
                  // 搜索根
                  root: ".",
                  // 搜索路径
                  path: input.path,
                  // 文件过滤 glob
                  include: input.include,
                  // 是否字面匹配
                  literal: input.literal,
                  // 是否区分大小写
                  caseSensitive: input.caseSensitive,
                  // 结果上限
                  limit: input.limit,
                },
                // 附带调用上下文
                ...Permission.invocation(context),
              })
              // 搜索根的绝对路径
              const root = target.absolute
              // 判断目标类型（文件/目录/不存在）
              const type = yield* ToolSearch.pathType(environment.files, root, input.path ?? ".")
              // 目录则以它为工作目录；文件则取其所在目录
              const cwd = type === "directory" ? root : path.dirname(root)
              // 执行带限额的内容搜索
              const result = yield* ToolSearch.bounded(input.limit ?? FileSystem.DEFAULT_SEARCH_LIMIT, (limit) =>
                ripgrep.grep({
                  // 工作目录
                  cwd,
                  // 匹配模式
                  pattern: input.pattern,
                  // 单文件搜索时限定文件名
                  file: type === "file" ? path.basename(root) : undefined,
                  // 文件名过滤 glob
                  include: input.include,
                  // 是否字面匹配
                  literal: input.literal,
                  // 是否区分大小写
                  caseSensitive: input.caseSensitive,
                  // 结果上限
                  limit,
                }),
              )
              // 返回结果：把每个匹配的文件路径换算成相对当前 Location 的路径
              return {
                matches: result.items.map((match) =>
                  FileSystem.Match.make({
                    ...match,
                    entry: FileSystem.Entry.make({
                      ...match.entry,
                      path: RelativePath.make(path.relative(location.directory, path.resolve(cwd, match.entry.path))),
                    }),
                  }),
                ),
                // 是否被截断
                truncated: result.truncated,
              }
            }).pipe(
              // 成功后组织工具返回：输出匹配数组 + 面向模型的文本 + 元数据
              Effect.map((result) => ({
                output: result.matches,
                content: toModelContent(
                  // 内容里的路径用绝对路径表示，便于模型引用
                  result.matches.map((match) => ({
                    ...match,
                    entry: { ...match.entry, path: path.resolve(location.directory, match.entry.path) },
                  })),
                  result.truncated,
                ),
                metadata: { matches: result.matches.length, truncated: result.truncated },
              })),
              // 失败按类型细分映射：正则非法给专门提示，其余给通用失败
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : error instanceof Ripgrep.InvalidPatternError
                    ? new ToolFailure({ message: `Invalid regex pattern: ${error.message}` })
                    : new ToolFailure({ message: `Unable to grep for ${input.pattern}`, error }),
              ),
            ),
        }),
      )
      // 注册出错则直接中断
      .pipe(Effect.orDie)
  }),
}
