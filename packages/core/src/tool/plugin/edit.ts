/**
 * Model-facing exact-edit leaf. Relative paths resolve within the active
 * Location. Absolute paths inside that Location are accepted, while explicit
 * absolute external paths retain mutation capability through a separate
 * external_directory approval before edit approval.
 */
// =====================================================================
// 文件角色：EditTool —— 模型侧的“精确编辑”工具（查找替换）。
// 特点：对模型展示的是 LF 视图（Read 的输出），编辑时映射回真实字节，
// 因此 CRLF/混合换行既不会阻断匹配，也不会污染未触及区域；匹配失败时
// 降级到“排版字符归一化”“行尾空白忽略”两级；失败时给出有针对性的提示。
// =====================================================================
export * as EditTool from "./edit.js"

// 插件上下文类型。
import type { Context } from "@opencode/plugin/effect/plugin"
import { ToolFailure } from "@opencode/ai/effect"
// 文件差异 Schema（结果里带 diff）。
import { FileDiff } from "@opencode/schema/file-diff"
import { Effect, Schema } from "effect"
// 工具失败构造器。
import { toolFailure } from "../runtime.js"
// 环境服务。
import { Environment } from "../../environment/index.js"
// 文件变更锁（同一路径的编辑互斥）。
import { FileMutation } from "../../file-mutation.js"
// Location 服务。
import { Location } from "../../location.js"
// 文件访问控制。
import { FileAccess } from "../../file-access.js"
// 文件写入服务（目标解析/授权/提交/格式化）。
import { FileWrite } from "../../file-write.js"
// 权限系统。
import { Permission } from "../../permission.js"
// diff 生成。
import { fileDiff } from "./file-diff.js"

// 工具名。
export const name = "edit"

// 输入 Schema：path / oldString / newString / replaceAll。
export const Input = Schema.Struct({
  path: Schema.String.annotate({
    description: "File to edit",
  }),
  oldString: Schema.String.annotate({ description: "Exact text to find and replace" }),
  newString: Schema.String.annotate({ description: "Text to replace oldString with (must differ from oldString)" }),
  replaceAll: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      "Whether to replace every occurrence of oldString. When false, oldString must match exactly once. Defaults to false.",
  }),
})

// 输出 Schema：文件 diff 列表 + 替换次数。
export const Output = Schema.Struct({
  files: Schema.Array(FileDiff.Info),
  replacements: Schema.Number,
})
export type Output = typeof Output.Type

// CRLF 常量。
const crlf = "\r\n"

// Match：源串中的一个匹配区间。
interface Match {
  readonly start: number
  readonly end: number
}

// normalizeForMatch：把排版变体归一化——弯引号→直引号、各种横线→-、
// 各种空格（含全角/不间断）→ 普通空格。
const normalizeForMatch = (value: string) =>
  value
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")

// findOccurrences：找出 search 在 content 中的所有不重叠出现位置。
const findOccurrences = (content: string, search: string) => {
  const result: Match[] = []
  let offset = 0
  while ((offset = content.indexOf(search, offset)) !== -1) {
    result.push({ start: offset, end: offset + search.length })
    offset += search.length
  }
  return result
}

// findLineOccurrences：按“行序列”匹配（多行 oldString 的行级搜索）。
// 每行比较前做 trimEnd + 排版归一化，因此行尾空白差异不影响匹配。
const findLineOccurrences = (content: string, search: string) => {
  // oldString 是否以换行结尾（要求匹配区域也以换行收尾）。
  const trailingNewline = search.endsWith("\n")
  const expected = search.split("\n")
  if (trailingNewline) expected.pop()
  // 把内容切成行（含每行的起止偏移、是否有换行、是否 \r 结尾）。
  const lines = [...content.matchAll(/[^\n]*(?:\n|$)/g)]
    .filter((match) => match[0] !== "")
    .map((match) => {
      const newline = match[0].endsWith("\n")
      const text = newline ? match[0].slice(0, -1) : match[0]
      return {
        start: match.index,
        end: match.index + match[0].length,
        text,
        contentEnd: match.index + text.length - (text.endsWith("\r") ? 1 : 0),
        newline,
      }
    })
  // 滑动窗口：每一处连续 expected.length 行做归一化比较。
  const candidates = lines.flatMap((line, index) => {
    const actual = lines.slice(index, index + expected.length)
    if (actual.length !== expected.length) return []
    if (
      !actual.every(
        (item, lineIndex) =>
          normalizeForMatch(item.text.trimEnd()) === normalizeForMatch(expected[lineIndex].trimEnd()),
      )
    )
      return []
    // oldString 带尾换行时，匹配区域也必须以换行收尾。
    const last = actual.at(-1)!
    if (trailingNewline && !last.newline) return []
    return [{ start: line.start, end: trailingNewline ? last.end : last.contentEnd }]
  })
  // 去掉相互重叠的候选（保留先出现的）。
  return candidates.reduce<Match[]>((result, candidate) => {
    if (result.some((match) => match.end > candidate.start && match.start < candidate.end)) return result
    result.push(candidate)
    return result
  }, [])
}

/** The dominant line ending in text, or fallback when there is none. */
// lineEnding：文本中的主导换行符；两种各半/都没有 → fallback。
const lineEnding = (text: string, fallback: string) => {
  const crlfCount = text.split(crlf).length - 1
  const lfCount = text.split("\n").length - 1 - crlfCount
  if (crlfCount === lfCount) return fallback
  return crlfCount > lfCount ? crlf : "\n"
}

/**
 * Joins the replacement's lines with line endings taken from the matched source region. A replacement line that
 * keeps a region line (longest common subsequence, compared like the trailing-whitespace tier) reuses that line's
 * ending; a line that changes in place reuses the ending of the line it replaces; only lines beyond those take
 * `fallback`. Unchanged context inside a match therefore keeps its bytes even in a mixed-ending file.
 */
// withRegionEndings：替换文本的换行符“就地继承”：
// 保留下来的行沿用原行换行；原地修改的行沿用被替换行的换行；新增行才用 fallback。
const withRegionEndings = (region: string, replacement: string, fallback: string) => {
  const before = region.split(/\r?\n/)
  // 依次取出区域里的每个换行符（\r\n 或 \n）。
  const endings = [...region.matchAll(/\r?\n/g)].map((match) => match[0])
  const after = replacement.split("\n")
  const key = (line: string) => normalizeForMatch(line.trimEnd())
  // 用 LCS 对齐替换行与源行。
  const source = alignLines(before.map(key), after.map(key))
  return after.map((line, index) => (index === after.length - 1 ? line : line + (endings[source[index]!] ?? fallback))).join("")
}

/**
 * For each line of `after`, the index of the `before` line it keeps (longest common subsequence) or, between kept
 * lines, the line it takes the place of; undefined for lines with no counterpart.
 */
// alignLines：经典 LCS 动态规划（Uint32Array 打平成一位数组省内存）。
// 返回 after 每行对应的 before 行号；无对应为 undefined。
const alignLines = (before: string[], after: string[]) => {
  const width = after.length + 1
  const table = new Uint32Array((before.length + 1) * width)
  // 自底向上填表：相等取对角+1，否则取右/下较大者。
  for (let i = before.length - 1; i >= 0; i--)
    for (let j = after.length - 1; j >= 0; j--)
      table[i * width + j] =
        before[i] === after[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
  const result: (number | undefined)[] = []
  // gap：收集“跳过”的行，遇到匹配行时一次性配对（改行继承被改行的换行）。
  const gap = { before: [] as number[], after: [] as number[] }
  const flush = () => {
    gap.after.forEach((j, k) => (result[j] = gap.before[k]))
    gap.before = []
    gap.after = []
  }
  // 回溯路径。
  let i = 0
  let j = 0
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      flush()
      result[j++] = i++
      continue
    }
    if (table[(i + 1) * width + j] >= table[i * width + j + 1]) gap.before.push(i++)
    else gap.after.push(j++)
  }
  while (i < before.length) gap.before.push(i++)
  while (j < after.length) gap.after.push(j++)
  flush()
  return result
}

/**
 * Matches against the LF view Read shows the model, then maps offsets back to the source, so CRLF and mixed line
 * endings neither block matches nor leak into untouched regions.
 */
// matchView：核心匹配逻辑——在 LF 视图里匹配，再把偏移映射回源串。
const matchView = (source: string, oldString: string, newString: string) => {
  // LF 视图：把源串的 \r\n 全部替换为 \n。
  const view = source.replaceAll(crlf, "\n")
  // removed：每个 \r\n 在视图中的位置差（用于偏移回映射）。
  const removed = [...source.matchAll(/\r\n/g)].map((match, index) => match.index - index)
  // 文件的主导换行符（替换文本的 fallback）。
  const fileEnding = lineEnding(source, "\n")
  const search = oldString.replaceAll(crlf, "\n")
  const replacement = newString.replaceAll(crlf, "\n")
  // 第一级：LF 视图里的精确匹配。
  const exact = findOccurrences(view, search)
  // These one-to-one mappings preserve offsets into the LF view.
  // 第二级：排版字符归一化后的匹配。
  const unicode = exact.length > 0 ? [] : findOccurrences(normalizeForMatch(view), normalizeForMatch(search))
  // 第三级：行级匹配（忽略行尾空白）。
  const trailing = exact.length > 0 || unicode.length > 0 ? [] : findLineOccurrences(view, search)
  return {
    // matches：偏移映射回源串（每个 \r\n 加回 1 字节）。
    matches: (exact.length > 0 ? exact : unicode.length > 0 ? unicode : trailing).map((match) => ({
      start: match.start + countBefore(removed, match.start),
      end: match.end + countBefore(removed, match.end),
    })),
    // replace：给定匹配区间，生成继承换行风格的替换文本。
    replace: (match: Match) => {
      const region = source.slice(match.start, match.end)
      return withRegionEndings(region, replacement, lineEnding(region, fileEnding))
    },
  }
}

// 提示的行数与行宽上限。
const hintLines = 12
const hintLineLength = 200

/**
 * A short hint for an oldString miss, so the next attempt can succeed without rereading the file: newString is
 * already there (often an edit that already applied), or the lines closest to oldString, numbered like Read output.
 * Lines vote for where oldString starts when they match ignoring all whitespace; at least half must agree. Only the
 * span from the first to the last line that matched is shown, so padding oldString cannot reveal the lines after it.
 */
// missHint：匹配失败时的智能提示——
// 1) newString 已在文件里 → “可能已经改过了”；
// 2) 用“投票法”定位 oldString 最可能在的起始行（所有空白忽略后比较，
//    至少半数行同意才给出），并展示最接近的行（带 Read 风格行号）。
// 只展示匹配到的首尾行之间的内容，防止用长 oldString 探测后续行。
const missHint = (source: string, oldString: string, newString: string) => {
  const view = source.replaceAll(crlf, "\n")
  const replacement = newString.replaceAll(crlf, "\n")
  // newString 足够长且已在文件中 → 判定为重复编辑。
  if (replacement.trim().length >= 20 && normalizeForMatch(view).includes(normalizeForMatch(replacement)))
    return "newString is already in the file, so this edit may already be applied."
  const key = (line: string) => normalizeForMatch(line).replace(/\s+/g, " ").trim()
  // “有内容”的行才参与定位（纯空白/无字母数字的行不算）。
  const distinct = (line: string) => /[\p{L}\p{N}]/u.test(line)
  const lines = view.split("\n")
  const search = oldString.replaceAll(crlf, "\n").split("\n")
  // positions：每行的归一化文本 → 出现的行号列表。
  const positions = new Map<string, number[]>()
  lines.forEach((line, index) => {
    const value = key(line)
    if (!distinct(value)) return
    const found = positions.get(value)
    if (found) found.push(index)
    else positions.set(value, [index])
  })
  // 投票：oldString 的每行在文件中的每个出现位置 → 偏移差 = 起始行候选。
  const votes = new Map<number, number>()
  const wanted = search.filter((line, offset) => {
    const value = key(line)
    if (!distinct(value)) return false
    for (const index of positions.get(value) ?? []) votes.set(index - offset, (votes.get(index - offset) ?? 0) + 1)
    return true
  }).length
  // 票数最高的起始行。
  const [start, count] = [...votes].reduce((best, vote) => (vote[1] > best[1] ? vote : best), [0, 0])
  // 得票不足（少于一半的行同意）→ 不给提示。
  if (count === 0 || count * 2 < wanted) return
  // 找出真正匹配上的行号。
  const matched = search.flatMap((line, offset) => {
    const value = key(line)
    const index = start + offset
    return value !== "" && index >= 0 && index < lines.length && key(lines[index]) === value ? [index] : []
  })
  // 展示从首个到最后一个匹配行（上限 hintLines 行、超宽截断）。
  const from = matched[0]
  const to = Math.min(matched.at(-1)! + 1, from + hintLines)
  return [
    "The closest lines in the file:",
    ...lines
      .slice(from, to)
      .map(
        (line, index) =>
          `${from + index + 1}: ${line.length > hintLineLength ? `${line.slice(0, hintLineLength)}…` : line}`,
      ),
  ].join("\n")
}

/** Number of sorted positions strictly before offset. */
// countBefore：有序位置数组里严格小于 offset 的个数（二分查找）。
const countBefore = (positions: number[], offset: number) => {
  let low = 0
  let high = positions.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (positions[middle] < offset) low = middle + 1
    else high = middle
  }
  return low
}

/** Deferred edit behavior and UX integrations remain visible at the model-facing seam. */
// TODO: Publish watcher/file-edit events after watcher integration exists.
// TODO: Add snapshots / undo after design exists.
// TODO: Add LSP notification and diagnostics after LSP runtime exists.
// （原文注释保留：编辑相关的事件/快照/LSP 集成等能力尚未落地。）

// 插件实现（opencode.tool.edit）。
export const Plugin = {
  id: "opencode.tool.edit",
  effect: Effect.fn("EditTool.Plugin")(function* (ctx: Context) {
    // 依赖：文件变更锁、文件写入、环境、Location、权限。
    const fileMutation = yield* FileMutation.Service
    const fileWrite = yield* FileWrite.Service
    const environment = yield* Environment.Service
    const location = yield* Location.Service
    const permission = yield* Permission.Service

    // 注册工具本体。
    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          // codemode=false：始终直接暴露；permission="edit"：走 edit 权限动作。
          options: { codemode: false, permission: "edit" },
          description:
            "Edit the contents of a file by finding and replacing exact text. When editing text from Read output, preserve the exact indentation (tabs or spaces) and omit the line-number prefix, such as `1: `. Never include the prefix in oldString or newString. Write line breaks as \\n; the file's existing CRLF or LF line endings are matched and preserved. To change line endings themselves, make oldString and newString differ only in \\r; that edit applies to the exact bytes. If there is no exact match, the edit retries while ignoring typographic quote, dash, and space variants, then trailing whitespace on each line. The edit fails if oldString is not found. By default, oldString must identify a UNIQUE location. Multiple matches FAIL unless replaceAll is true. Add more surrounding context to disambiguate, or set replaceAll to true to replace every occurrence. Use replaceAll when the change should apply to every occurrence, such as renaming a variable.",
          input: Input,
          output: Output,
          execute: (input, context) => {
            return Effect.gen(function* () {
              // 快速失败：old 与 new 相同、old 为空。
              if (input.oldString === input.newString) {
                return yield* new ToolFailure({
                  message: "No changes to apply: oldString and newString are identical.",
                })
              }
              if (input.oldString === "") {
                return yield* new ToolFailure({
                  message: "oldString must not be empty. Use write to create or overwrite a file.",
                })
              }

              // 解析目标路径（相对路径基于 Location；外部目录另行授权）。
              const target = yield* fileWrite.target(input.path, context)

              // 读原文件（不存在/是目录等各给明确报错）。
              const original = yield* FileMutation.readText(environment.files, target.absolute).pipe(
                Effect.catchTag("Environment.NotFound", () =>
                  Effect.fail(new ToolFailure({ message: `File not found: ${input.path}` })),
                ),
                Effect.catchTag("Environment.WrongKind", (error) =>
                  error.actual === "directory"
                    ? Effect.fail(new ToolFailure({ message: `Path is a directory, not a file: ${input.path}` }))
                    : Effect.fail(new ToolFailure({ message: `Unable to edit ${input.path}`, error })),
                ),
              )
              const source = original.text
              // Strings that differ only in \r ask to change line endings themselves, so they apply to the exact
              // bytes. Every other edit matches the LF view Read shows the model and keeps the file's endings.
              // 只差 \r 的 old/new = 用户想改换行符本身 → 按精确字节匹配；
              // 其余编辑走 LF 视图匹配（保留文件原有换行风格）。
              const endingsOnly = input.oldString.replaceAll("\r", "") === input.newString.replaceAll("\r", "")
              const { matches, replace } = endingsOnly
                ? { matches: findOccurrences(source, input.oldString), replace: () => input.newString }
                : matchView(source, input.oldString, input.newString)
              const replacements = matches.length
              // 从后往前替换（偏移不受前面替换影响）；replaceAll 或只替换第一个。
              const replaced = (input.replaceAll === true ? matches : matches.slice(0, 1))
                .toReversed()
                .reduce(
                  (content, match) => `${content.slice(0, match.start)}${replace(match)}${content.slice(match.end)}`,
                  source,
                )
              // 生成 diff 预览并走写授权（用户可看到改动再批准）。
              const preview =
                replacements > 0 && (replacements === 1 || input.replaceAll === true)
                  ? fileDiff(target.resource, source, replaced)
                  : undefined
              yield* fileWrite.authorize(target, context, preview)
              // 没找到：尝试给出智能提示（且仅当该文件可读时）。
              if (replacements === 0) {
                // The hint shows file contents, so only when reading this file is already allowed.
                const readable = yield* permission.allows({
                  action: "read",
                  resources: [target.resource],
                  save: ["*"],
                  ...Permission.invocation(context),
                })
                const hint = readable ? missHint(source, input.oldString, input.newString) : undefined
                return yield* new ToolFailure({
                  message: `Could not find oldString in ${input.path}. It must match exactly, including whitespace and indentation.${hint ? `\n\n${hint}` : ""}`,
                })
              }
              // 多处匹配且未指定 replaceAll → 失败（要求唯一）。
              if (replacements > 1 && input.replaceAll !== true) {
                return yield* new ToolFailure({
                  message: `Found ${replacements} matches for oldString, but expected exactly one. Add more surrounding context to make oldString unique, or set replaceAll to true to replace every occurrence.`,
                })
              }
              // 替换后内容没变 → 视为无操作失败。
              if (replaced === source) {
                return yield* new ToolFailure({
                  message: endingsOnly
                    ? `No changes to apply: ${input.path} already has those line endings.`
                    : `No changes to apply: the edit leaves ${input.path} unchanged. Line endings follow the file; to change them, write \\r explicitly in oldString or newString.`,
                })
              }
              // 提交写入（返回结果可能带 formatter 处理后的文本）。
              const result = yield* fileWrite.commit(target, replaced)
              const formatted =
                result.formatted ?? (yield* FileMutation.readText(environment.files, target.absolute)).text
              return {
                files: [fileDiff(result.resource, source, formatted)],
                replacements,
              } satisfies Output
            }).pipe(
              // 同一路径的编辑加锁互斥。
              fileMutation.withLock([FileAccess.resolvePath(location.directory, input.path)]),
              // 包装成标准结果（content 为一句话摘要，metadata 带 diff）。
              Effect.map((output) => ({
                output,
                content: `Edited ${output.files[0]?.file} (${output.replacements} replacement${output.replacements === 1 ? "" : "s"})`,
                metadata: { files: output.files },
              })),
              Effect.mapError(toolFailure(`Unable to edit ${input.path}`)),
            )
          },
        }),
      )
      .pipe(Effect.orDie)
  }),
}
