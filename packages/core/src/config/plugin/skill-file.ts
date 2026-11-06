// 技能文件解析（Skill File）模块：把 SKILL.md/技能 Markdown 解析为技能（skill）信息。
export * as SkillFile from "./skill-file.js"

// 导入 Node 的 path 模块。
import path from "path"
// 导入判断普通对象的工具函数。
import { isRecord } from "@opencode/util/record"
// 导入 Effect 的 Result、Schema 与解析器工具。
import { Result, Schema, type SchemaIssue, SchemaParser } from "effect"
// 导入 Markdown 解析工具。
import { ConfigMarkdown } from "../markdown.js"
// 导入绝对路径品牌类型。
import { AbsolutePath } from "../../schema.js"
// 导入技能服务与类型。
import { Skill } from "../../skill.js"

// 允许的 frontmatter 字段：name、description、metadata 与 disable-model-invocation。
const Frontmatter = Schema.Struct({
  // 技能显示名（可选）。
  name: Schema.String.pipe(Schema.optional),
  // 技能描述（可选）。
  description: Schema.String.pipe(Schema.optional),
  // 任意元数据（可选）。
  metadata: Schema.Unknown.pipe(Schema.optional),
  // 是否禁止模型自动调用（可选）。
  "disable-model-invocation": Schema.Unknown.pipe(Schema.optional),
})
// frontmatter 的结果式解码器（失败返回 Issue 而不抛错）。
const decodeFrontmatter = SchemaParser.decodeUnknownResult(Frontmatter)

// 解析结果：成功（Parsed）或跳过（因非 Markdown 或 frontmatter 不合法）。
export type ParseResult =
  | { readonly _tag: "Parsed"; readonly skill: Skill.Info }
  | { readonly _tag: "Skipped"; readonly reason: "markdown" }
  | { readonly _tag: "Skipped"; readonly reason: "frontmatter"; readonly issue: SchemaIssue.Issue }

// 从 metadata 中读取布尔值字段（仅对象形式的 metadata）。
const metadataBoolean = (metadata: unknown, key: string) => {
  // 非对象时返回 undefined。
  if (!isRecord(metadata)) return undefined
  // 读取指定键的布尔值。
  return booleanValue(metadata[key])
}

// 把任意值宽松地解释为布尔：支持布尔、0/1 数字与常见真假字符串。
const booleanValue = (value: unknown) => {
  // 布尔直接返回。
  if (typeof value === "boolean") return value
  // 数字仅接受 0 与 1。
  if (typeof value === "number") return value === 1 ? true : value === 0 ? false : undefined
  // 非字符串无法解释。
  if (typeof value !== "string") return undefined
  // 归一化为小写并去空白。
  const normalized = value.trim().toLowerCase()
  // 真值写法。
  if (["true", "yes", "on", "1"].includes(normalized)) return true
  // 假值写法。
  if (["false", "no", "off", "0"].includes(normalized)) return false
  // 无法识别返回 undefined。
  return undefined
}

// 解析一个技能 Markdown 文件：目录用于推导技能 ID。
export function parse(directory: string, filepath: string, content: string): ParseResult {
  // 解析 Markdown；失败按非 Markdown 跳过。
  const markdown = ConfigMarkdown.parseOption(content)
  if (!markdown) return { _tag: "Skipped", reason: "markdown" }
  // 解码 frontmatter。
  const decoded = decodeFrontmatter(markdown.data)
  // frontmatter 不合法则跳过并附带问题详情。
  if (Result.isFailure(decoded)) return { _tag: "Skipped", reason: "frontmatter", issue: decoded.failure }
  // 取出解码后的 frontmatter。
  const frontmatter = decoded.success
  // 技能 ID：根目录下的非 SKILL.md 文件取文件名；否则取所在目录名。
  const id =
    path.dirname(filepath) === directory && path.basename(filepath) !== "SKILL.md"
      ? path.basename(filepath, ".md")
      : path.basename(path.dirname(filepath))
  // 读取 metadata 里的 opencode/autoinvoke 开关。
  const opencodeAutoinvoke = metadataBoolean(frontmatter.metadata, "opencode/autoinvoke")
  // 读取 disable-model-invocation 开关。
  const disableModelInvocation = booleanValue(frontmatter["disable-model-invocation"])
  // 自动调用：优先 opencode/autoinvoke；其次由 disable-model-invocation 反推为 false。
  const autoinvoke = opencodeAutoinvoke ?? (disableModelInvocation ? false : undefined)
  // 返回解析成功的技能信息。
  return {
    _tag: "Parsed",
    skill: {
      // 技能 ID。
      id: Skill.ID.make(id),
      // 显示名：frontmatter 的 name 优先，缺省用 ID。
      name: Skill.Name.make(frontmatter.name ?? id),
      ...(frontmatter.description === undefined ? {} : { description: frontmatter.description }),
      ...(autoinvoke === undefined ? {} : { autoinvoke }),
      // 技能文件路径。
      path: AbsolutePath.make(filepath),
      // 正文内容。
      content: markdown.content,
    },
  }
}
