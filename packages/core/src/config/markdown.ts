// 配置 Markdown 解析模块：解析带 frontmatter 的 Markdown 文件（如代理/命令/技能定义）。
export * as ConfigMarkdown from "./markdown.js"

// 导入 gray-matter 库用于解析 frontmatter。
import matter from "gray-matter"
// 解析 Markdown 内容，返回 frontmatter 数据与正文；YAML 解析失败时先净化再重试。
export function parse(content: string) {
  // Passing options bypasses gray-matter's module-global content cache, which
  // it populates before parsing: a failed YAML parse poisons the entry and
  // every later parse of the same content replays it without throwing, so the
  // sanitize fallback below never runs. Upstream: jonschlinkert/gray-matter#166.
  // 传入选项对象可绕过 gray-matter 的模块级内容缓存：该缓存在解析前就会写入条目，
  // YAML 解析失败会污染缓存，之后相同内容的每次解析都静默重放失败而不抛异常，
  // 导致下方 sanitize 兜底永不执行。上游 issue：jonschlinkert/gray-matter#166。
  try {
    // 首次尝试：直接解析原始内容（传空选项以绕过缓存）。
    return matter(content, {})
  } catch {
    // 失败则对内容做净化（sanitize）后再次解析。
    return matter(sanitize(content), {})
  }
}

// 解析的可选版本：任何失败都返回 undefined 而不是抛异常。
export function parseOption(content: string) {
  try {
    // 尝试正常解析。
    return parse(content)
  } catch {
    // 解析失败时返回 undefined，调用方据此跳过该文件。
    return undefined
  }
}

// Other coding agents accept unquoted colons in frontmatter values. Retry
// those values as YAML block scalars so existing config files keep working.
// 其他编码代理允许 frontmatter 值中出现未加引号的冒号；这里把这些值改写为 YAML 块标量（block scalar）再重试，
// 使旧配置文件继续可用。
export function sanitize(content: string) {
  // 匹配文件开头的 frontmatter 区块（--- 包围）。
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  // 没有 frontmatter 时原样返回。
  if (!match) return content
  // 取出 frontmatter 的正文（不含 --- 分隔线）。
  const frontmatter = match[1]
  // 逐行处理 frontmatter：把含冒号的裸值改写为块标量。
  const result = frontmatter.split(/\r?\n/).flatMap((line) => {
    // 注释行、空行、缩进行保持原样。
    if (line.trim().startsWith("#") || line.trim() === "" || /^\s+/.test(line)) return [line]
    // 匹配 "键: 值" 形式的行。
    const entry = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/)
    // 不符合键值形式的行保持原样。
    if (!entry) return [line]
    // 取出值部分并去掉首尾空白。
    const value = entry[2].trim()
    // 空值或已是块标量指示符/带引号的值无需处理。
    if (value === "" || value === ">" || value === "|" || value.startsWith('"') || value.startsWith("'")) return [line]
    // 值中不含冒号时也无需处理。
    if (!value.includes(":")) return [line]
    // 把值改写为 YAML 块标量：`键: |-` 加两空格缩进的原文。
    return [`${entry[1]}: |-`, `  ${value}`]
  })
  // 用处理后的行替换原 frontmatter 文本（回调形式可避免 $ 替换符被展开）。
  return content.replace(frontmatter, () => result.join("\n"))
}
