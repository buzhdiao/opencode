// 将本模块以命名空间方式重新导出为 ReadTool
export * as ReadTool from "./read.js"

// 导入插件上下文类型（Context）
import type { Context } from "@opencode/plugin/effect/plugin"
// 导入 path 模块的常用函数：取文件名、取目录、拼接路径
import { basename, dirname, join } from "path"
// 导入 Effect 化的工具失败类型（ToolFailure）
import { ToolFailure } from "@opencode/ai/effect"
// 导入 Effect 原语：Effect、Schema
import { Effect, Schema } from "effect"
// 导入文件系统工具服务
import { FSUtil } from "@opencode/util/fs-util"
// 导入位置（Location）服务：当前工作目录
import { Location } from "../../location.js"
// 导入文件访问（FileAccess）服务：路径解析与授权
import { FileAccess } from "../../file-access.js"
// 导入权限（Permission）服务
import { Permission } from "../../permission.js"
// 导入会话指令（SessionInstructions）服务：注入 AGENTS.md 指令
import { SessionInstructions } from "../../session/instructions.js"
// 导入 AbsolutePath 品牌化类型（绝对路径）
import { AbsolutePath } from "../../schema.js"
// 导入技能（Skill）服务与工具
import { Skill } from "../../skill.js"
// 导入技能发现模块（用其路径安全判断）
import { SkillDiscovery } from "../../skill/discovery.js"
// 导入读工具的文件系统实现（分页、媒体读取等）
import { ReadToolFileSystem } from "../read-filesystem.js"
// 导入环境（Environment）服务：文件系统驱动与错误类型
import { Environment } from "../../environment/index.js"

// 工具名
export const name = "read"
// 向上查找的指令文件名
const FILENAME = "AGENTS.md"
// 基础输入 Schema（目录读取也复用）
const LocationInput = Schema.Struct({
  // 要读取的文件或目录
  path: Schema.String.annotate({ description: "File or directory to read" }),
  // 起始行号/目录条目（从 1 开始）
  offset: ReadToolFileSystem.PageInput.fields.offset.annotate({
    description: "The line or directory entry to start reading from (1-based)",
  }),
  // 最多读取的行数/条目数（默认且上限 2000）
  limit: ReadToolFileSystem.PageInput.fields.limit.annotate({
    description: "The maximum number of lines or directory entries to read (defaults to and capped at 2000)",
  }),
})
// 工具输入 Schema（当前与 LocationInput 相同）
export const Input = LocationInput
// 输出 Schema：文件内容 / 文本分页 / 目录分页 三选一
const Output = Schema.Union([ReadToolFileSystem.FileContent, ReadToolFileSystem.TextPage, ReadToolFileSystem.ListPage])

// 插件定义：注册 read 工具
export const Plugin = {
  // 插件唯一标识
  id: "opencode.tool.read",
  // 插件的 Effect 主体
  effect: Effect.fn("ReadTool.Plugin")(function* (ctx: Context) {
    // 注入读工具文件系统服务
    const reader = yield* ReadToolFileSystem.Service
    // 注入文件访问服务
    const access = yield* FileAccess.Service
    // 注入权限服务
    const permission = yield* Permission.Service
    // 注入技能服务
    const skills = yield* Skill.Service
    // 注入会话指令服务
    const sessionInstructions = yield* SessionInstructions.Service
    // 注入文件系统工具服务
    const fs = yield* FSUtil.Service
    // 注入位置服务
    const location = yield* Location.Service

    // 向工具注册中心注册 read 工具
    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          // 工具名
          name,
          // 选项：不启用 codemode
          options: { codemode: false },
          // 工具描述：读取文件/目录的用法说明
          description:
            "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.",
          // 输入/输出 Schema
          input: Input,
          output: Output,
          // 执行体
          execute: (input, context) => {
            return Effect.gen(function* () {
              // 技能 URI 分支：path 是 skill:// 形式时读技能虚拟内容
              if (Skill.isUri(input.path)) {
                // 解析技能 URI
                const parsed = parseSkillUri(input.path)
                // 解析失败：当作文件不存在
                if (!parsed) return yield* new ToolFailure({ message: `File not found: ${input.path}` })
                // 构造技能 ID 并获取技能
                const id = Skill.ID.make(parsed.id)
                const skill = yield* skills.get(id)
                // 技能不存在或其路径不是技能 URI：失败
                if (!skill || !Skill.isUri(skill.path))
                  return yield* new ToolFailure({ message: `File not found: ${input.path}` })
                // 取技能附带的额外文件
                const extra = yield* skills.files(id)
                // 断言技能访问权限
                yield* permission.assert({
                  action: "skill",
                  resources: [skill.id],
                  save: [skill.id],
                  ...Permission.invocation(context),
                })
                // 断言对技能内目标路径的读权限
                yield* permission.assert({
                  action: "read",
                  resources: [parsed.uri],
                  save: ["*"],
                  ...Permission.invocation(context),
                })
                // 构建内存虚拟文件系统承载技能内容
                const virtualFs = Environment.makeFiles(Environment.makeMemoryDriver())
                // UTF-8 编码器
                const encoder = new TextEncoder()
                // 把技能主文件写入 /SKILL.md
                yield* virtualFs.write(AbsolutePath.make("/SKILL.md"), encoder.encode(skill.content))
                // 把额外文件写入虚拟根目录（忽略结果）
                yield* Effect.forEach(
                  extra ? Array.from(extra) : [],
                  ([rel, text]) => virtualFs.write(AbsolutePath.make(`/${rel}`), encoder.encode(text)),
                  { discard: true },
                )
                // 从虚拟文件系统读取目标内容（分页参数透传）
                const output = yield* ReadToolFileSystem.read(virtualFs, AbsolutePath.make(parsed.target), input.path, {
                  offset: input.offset,
                  limit: input.limit,
                }).pipe(
                  // 虚拟路径不存在统一转成“文件不存在”失败
                  Effect.catchIf(
                    (error) => error instanceof Environment.NotFound,
                    () => Effect.fail(new ToolFailure({ message: `File not found: ${input.path}` })),
                  ),
                )
                // 返回内容与原 URI 路径
                return { output, path: input.path }
              }

              // 普通路径读取函数：按分页参数读目标
              const read = (target: FileAccess.Target) =>
                reader.read(target.absolute, target.resource, {
                  offset: input.offset,
                  limit: input.limit,
                })

              // 对请求路径做读授权
              const requested = yield* access.authorizeRead(input.path, context)
              // 先按原路径读取；NotFound 时尝试相似文件名回退
              const result = yield* read(requested).pipe(
                // 成功时包装内容与目标
                Effect.map((content) => ({ content, target: requested, path: input.path })),
                // NotFound 时的回退分支
                Effect.catchIf(
                  (error) => error instanceof Environment.NotFound,
                  () =>
                    Effect.gen(function* () {
                      // 在同目录找规范化名相近的替代文件
                      const alternate = yield* alternatePath(requested.absolute).pipe(
                        Effect.orElseSucceed(() => undefined),
                      )
                      // 没有替代文件：走统一的“缺失”错误提示
                      if (!alternate) return yield* missing(input.path, requested.absolute)
                      // 对替代文件授权读取（作为请求目标的同级）
                      const target = yield* access.authorizeRead(alternate, context, { siblingOf: requested })
                      // 读取替代文件（仍不存在则走缺失提示）
                      const content = yield* read(target).pipe(
                        Effect.catchIf(
                          (error) => error instanceof Environment.NotFound,
                          () => missing(input.path, requested.absolute),
                        ),
                      )
                      // 替代命中目录列表也视为不匹配，走缺失提示
                      if (content.type === "list-page") return yield* missing(input.path, requested.absolute)
                      // 返回内容，路径显示为请求目录 + 替代文件名
                      return {
                        content,
                        target,
                        path: join(dirname(input.path), basename(alternate)),
                      }
                    }),
                ),
              )
              // After a successful read, discover nearby AGENTS.md walking up to the Location
              // root exclusive and inject them as durable synthetic instructions. For a
              // directory listing the walk starts at the directory itself (so its own AGENTS.md
              // is discovered); for a file it starts at the file's dirname. External reads are
              // skipped, and discovery failures never fail the read.
              // 读取成功后：向上发现 AGENTS.md 并作为持久合成指令注入
              yield* Effect.gen(function* () {
                // 外部目录读取不做发现
                if (result.target.externalDirectory !== undefined) return
                // 解析实际读取目标的绝对路径
                const resolved = yield* fs.resolve(result.target.absolute)
                // 解析项目根（Location 目录）
                const root = yield* fs.resolve(location.directory)
                // The Location and its ancestors are already supplied by initial instructions,
                // even when an upward walk from elsewhere in the project cannot reach root.
                // 自下而上查找 AGENTS.md：目录列表从目录自身开始（发现其 AGENTS.md），文件从其父目录开始；到 root 为止（不含）
                const discovered = yield* fs.up({
                  // 查找目标文件名
                  targets: [FILENAME],
                  // 起始目录
                  start: result.content.type === "list-page" ? resolved : dirname(resolved),
                  // 停止边界
                  stop: root,
                  // 只匹配文件
                  type: "file",
                })
                // 过滤候选：排除 root 自身及祖先（已由初始指令覆盖），也排除刚读过的文件本身
                const candidates = (yield* Effect.forEach(discovered, fs.resolve)).filter(
                  (file) => !FSUtil.contains(dirname(file), root) && file !== resolved,
                )
                // 没有候选则无事可做
                if (candidates.length === 0) return
                // 把候选 AGENTS.md 加载进会话指令
                yield* sessionInstructions.load({ sessionID: context.sessionID, paths: candidates })
              }).pipe(
                // 发现过程的任何失败都不影响读结果
                Effect.catch(() => Effect.void),
                Effect.catchDefect(() => Effect.void),
              )
              // 返回输出与展示路径
              return { output: result.content, path: result.path }
            }).pipe(
              // 成功后组织工具返回
              Effect.map((result) => ({
                // 输出内容
                output: result.output,
                // 面向模型的文本
                content: toModelContent(result.path, input.offset, result.output),
                // 元数据：是否截断（文件类型不算截断）
                metadata: { truncated: result.output.type === "file" ? false : result.output.truncated },
              })),
              // 失败映射：读工具的专属错误直接用其消息，其他给通用消息
              Effect.mapError((error) => {
                if (error instanceof ToolFailure) return error
                const message =
                  error instanceof ReadToolFileSystem.BinaryFileError ||
                  error instanceof ReadToolFileSystem.MediaIngestLimitError ||
                  error instanceof ReadToolFileSystem.OffsetOutOfRangeError ||
                  error instanceof ReadToolFileSystem.PathKindError
                    ? error.message
                    : `Unable to read ${input.path}`
                return new ToolFailure({ message, error })
              }),
            )
          },
        }),
      )
      // 注册出错则直接中断
      .pipe(Effect.orDie)

    // 在同目录中查找与目标文件名“规范化后相同”的替代文件
    const alternatePath = Effect.fn("ReadTool.alternatePath")(function* (absolute: string) {
      // 规范化函数：NFC 归一、把不间断空格换成普通空格、把弯引号换成直引号
      const canonical = (name: string) =>
        name
          .normalize("NFC")
          .replace(/[\u00a0\u202f]/g, " ")
          .replace(/[\u2018\u2019]/g, "'")
      // 目标文件名的规范化形式
      const base = canonical(basename(absolute))
      // 列出同目录条目并按规范化名匹配
      const matches = (yield* reader.list(AbsolutePath.make(dirname(absolute)))).filter(
        (entry) => entry.type === "file" && canonical(entry.name) === base,
      )
      // 只有恰好一个匹配时才回退（避免歧义）
      if (matches.length !== 1) return
      // 返回替代文件的完整路径
      return join(dirname(absolute), matches[0].name)
    })

    // Lists through the session's environment, which may be a remote workspace rather than this host.
    // 列出目录内容：found（存在并返回名字）、missing（目录不存在）、unknown（其他失败）
    const listing = (path: string) =>
      reader.list(AbsolutePath.make(path)).pipe(
        // 目录存在：返回条目名列表
        Effect.map((entries) => ({ type: "found" as const, names: entries.map((entry) => entry.name) })),
        // 目录不存在
        Effect.catchTag("Environment.NotFound", () => Effect.succeed({ type: "missing" as const })),
        // 其他错误降级为 unknown
        Effect.orElseSucceed(() => ({ type: "unknown" as const })),
      )

    // 从名字列表里找与 name 相似的候选（双向包含匹配，最多 3 个）
    const similar = (names: readonly string[], name: string) => {
      // 目标的小写形式
      const base = name.toLowerCase()
      // 过滤：候选包含目标或目标包含候选（均小写比较）
      return names
        .filter((entry) => {
          const candidate = entry.toLowerCase()
          return candidate.includes(base) || base.includes(candidate)
        })
        // 最多给 3 个建议
        .slice(0, 3)
    }

    // A missing folder usually means a removed worktree, a moved directory, or a relative path
    // resolved from the wrong place, so name the first missing folder and its nearest existing parent.
    // 目录整体缺失时的错误提示：指出第一个缺失的目录与其最近存在的父目录
    const missingFolder = Effect.fn("ReadTool.missingFolder")(function* (input: string, folder: string) {
      // 当前检查的子目录
      let child = folder
      // 其父目录
      let parent = dirname(folder)
      // 自下而上找第一个存在的父目录
      while (parent !== child) {
        // 列出父目录
        const found = yield* listing(parent)
        // 状态未知：停止回溯
        if (found.type === "unknown") break
        // 父目录存在：给出针对性提示
        if (found.type === "found") {
          // 在父目录里找与缺失目录名相似的建议
          const suggestions = similar(found.names, basename(child)).map((entry) => join(parent, entry))
          // 组装多段消息
          const message = [
            `File not found: ${input}`,
            `The folder ${child} does not exist. The nearest folder that does is ${parent}.`,
            ...(suggestions.length === 0 ? [] : [`Did you mean one of these?\n${suggestions.join("\n")}`]),
          ].join("\n\n")
          // 返回失败
          return yield* new ToolFailure({ message })
        }
        // 父目录也不存在：继续向上
        child = parent
        parent = dirname(parent)
      }
      // 回溯到根仍没找到：给通用提示
      return yield* new ToolFailure({ message: `File not found: ${input}` })
    })

    // 统一的“文件缺失”错误构造：区分目录缺失与文件名打错两种情形
    const missing = Effect.fn("ReadTool.missing")(function* (input: string, absolute: string) {
      // 所在目录
      const folder = dirname(absolute)
      // 列出目录
      const found = yield* listing(folder)
      // 目录本身不存在：走目录缺失提示
      if (found.type === "missing") return yield* missingFolder(input, folder)
      // 目录存在：找与请求文件名相似的建议
      const suggestions =
        found.type === "found" ? similar(found.names, basename(input)).map((entry) => join(dirname(input), entry)) : []
      // 有建议时给 “Did you mean” 消息，否则给通用消息
      const message =
        suggestions.length === 0
          ? `File not found: ${input}`
          : `File not found: ${input}\n\nDid you mean one of these?\n${suggestions.join("\n")}`
      // 返回失败
      return yield* new ToolFailure({ message })
    })
  }),
}

// 解析 skill:// URI：提取技能 ID 与内部目标路径，并做安全校验
function parseSkillUri(value: string) {
  // 去掉 "skill://" 前缀并去掉尾部斜杠
  const trimmed = value.slice("skill://".length).replace(/\/+$/, "")
  // 第一个斜杠的位置，用于分隔技能 ID 与内部路径
  const slash = trimmed.indexOf("/")
  // 技能 ID
  const id = slash === -1 ? trimmed : trimmed.slice(0, slash)
  // 斜杠后的内部路径（可为空）
  const rest = slash === -1 ? "" : trimmed.slice(slash + 1)
  // 技能 ID 必须是安全路径段
  if (!SkillDiscovery.isSafeSegment(id)) return undefined
  // 内部路径的每一段都必须安全
  if (rest !== "" && !rest.split("/").every(SkillDiscovery.isSafeSegment)) return undefined
  // Permission checks use the canonical URI, so `skill://id/file/` can't slip past a rule for `skill://id/file`.
  // 返回解析结果：目标路径与规范化 URI（供权限检查使用）
  return { id, target: rest === "" ? "/" : `/${rest}`, uri: Skill.uri(id, rest || undefined) }
}

// 把读取结果格式化为面向模型的内容（媒体、目录、文本三种形态）
export const toModelContent = (path: string, offset: number | undefined, output: typeof Output.Type) => {
  // base64 编码的文件（图片/PDF）：文本说明 + 内联 data URI
  if (output.type === "file" && output.encoding === "base64")
    return [
      { type: "text", text: output.mime === "application/pdf" ? "PDF read successfully" : "Image read successfully" },
      {
        type: "file",
        uri: `data:${output.mime};base64,${output.content}`,
        mime: output.mime,
        name: path,
      },
    ] as const

  // 目录列表分页
  if (output.type === "list-page") {
    // 起始条目号
    const start = offset || 1
    // 首行摘要：条目数或范围
    const content = [
      output.entries.length === 0
        ? `Read directory ${path}, 0 entries`
        : `Read directory ${path}, entries ${start}-${start + output.entries.length - 1}`,
    ]
    // 逐条输出目录路径
    output.entries.forEach((entry) => content.push(entry.path))
    // 被截断时提示用 next 偏移继续
    if (output.truncated && output.next !== undefined)
      content.push(`[Output truncated. Continue reading with offset: ${output.next}]`)
    // 拼成多行文本
    return content.join("\n")
  }

  // 文本文件/文本分页
  // 起始行号：分页时用其 offset，整文件从 1 开始
  const start = output.type === "text-page" ? output.offset : 1
  // Pages already join selected lines; a trailing newline represents a selected blank line.
  // 整文件内容去掉末尾换行（分页内容保持原样）
  const text = output.type === "file" ? output.content.replace(/\n$/, "") : output.content
  // 拆行（空内容为空数组）
  const lines = output.content === "" ? [] : text.split("\n")
  // 首行摘要
  const content = [
    lines.length === 0 ? `Read file ${path}, 0 lines` : `Read file ${path}, lines ${start}-${start + lines.length - 1}`,
  ]
  // 逐行输出 "行号: 内容"
  lines.forEach((line, index) => content.push(`${start + index}: ${line}`))
  // 分页被截断时提示继续读取
  if (output.type === "text-page" && output.truncated && output.next !== undefined)
    content.push(`[Output truncated. Continue reading with offset: ${output.next}]`)
  // 拼成多行文本
  return content.join("\n")
}
