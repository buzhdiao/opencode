// 将本文件的所有导出聚合到命名空间 VcsPatch 下，供统一引入
export * as VcsPatch from "./patch.js"

// diff 库：生成补丁文本与结构化补丁
import { formatPatch, structuredPatch } from "diff"

// Effectively "full file" context; adapters use it when no context is requested.
// 近似"整个文件"的上下文行数；适配器在未请求上下文时使用该值
export const PATCH_CONTEXT_LINES = 2_147_483_647
// 单个补丁的最大字节数
export const MAX_PATCH_BYTES = 10_000_000
// 全部补丁的总最大字节数
export const MAX_TOTAL_PATCH_BYTES = 10_000_000

// 补丁对象：文本与是否被截断
export interface Patch {
  // 补丁文本
  readonly text: string
  // 是否因超限被截断
  readonly truncated: boolean
}

// 构造"空文件 → 空文件"的空补丁（保持标准 diff 头格式）
export const emptyPatch = (file: string) => formatPatch(structuredPatch(file, file, "", "", "", "", { context: 0 }))

// 构造"新增文件"补丁：旧内容为空
export const addPatch = (file: string, content: string) =>
  formatPatch(structuredPatch(file, file, "", content, "", "", { context: 0 }))

// 构造"删除文件"补丁：新内容为空
export const deletePatch = (file: string, content: string) =>
  formatPatch(structuredPatch(file, file, content, "", "", "", { context: 0 }))

/** Count changed lines in a unified diff, ignoring `+++`/`---` file headers. */
// 统计 unified diff 中的增删行数（跳过 +++/--- 文件头行）
export const countPatch = (patch: string) => {
  // 新增行计数
  let additions = 0
  // 删除行计数
  let deletions = 0
  // 逐行扫描补丁
  for (const line of patch.split("\n")) {
    // 以 + 开头但不是 +++ 文件头 → 新增行
    if (line.startsWith("+") && !line.startsWith("+++")) additions++
    // 以 - 开头但不是 --- 文件头 → 删除行
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++
  }
  // 返回统计结果
  return { additions, deletions }
}

// 解析带引号的路径（git 对含特殊字符的路径会加引号并转义）
const parseQuotedPath = (value: string) => {
  // 输出的解转义结果
  let out = ""
  // 从第一个引号之后开始扫描
  for (let idx = 1; idx < value.length; idx++) {
    // 当前字符
    const char = value[idx]
    // 遇到闭合引号：返回结果与结束位置
    if (char === '"') return { value: out, end: idx + 1 }
    // 普通字符直接追加
    if (char !== "\\") {
      out += char
      continue
    }

    // 反斜杠转义：取下一个字符判断含义
    const next = value[++idx]
    // \t 制表符
    if (next === "t") out += "\t"
    // \n 换行
    else if (next === "n") out += "\n"
    // \r 回车
    else if (next === "r") out += "\r"
    // \" 与 \\ 原样还原
    else if (next === '"' || next === "\\") out += next
    // 其余转义丢弃反斜杠（越界时取空串）
    else out += next ?? ""
  }
}

// 解析路径 token：无引号时取制表符前的部分；有引号时解转义
const parsePathToken = (value: string) => {
  // 非引号开头：截取制表符之前的内容
  if (!value.startsWith('"')) return value.split("\t")[0]
  // 引号开头：解转义并回退原文
  return parseQuotedPath(value)?.value ?? value
}

// 从 diff 路径（a/xxx 或 b/xxx）提取文件名；/dev/null 视为无文件
const fileFromDiffPath = (value: string | undefined) => {
  // 空值或 /dev/null 表示文件不存在（新增/删除）
  if (!value || value === "/dev/null") return
  // 解析路径 token
  const file = parsePathToken(value)
  // 去掉 a/ 或 b/ 前缀
  if (file.startsWith("a/") || file.startsWith("b/")) return file.slice(2)
  // 无前缀时原样返回
  return file
}

// 从 "diff --git a/x b/y" 头部解析新文件路径
const fileFromGitHeader = (header: string) => {
  // 带引号的头部：两段路径均为引号形式
  if (header.startsWith('"')) {
    // 解析第一段带引号路径
    const first = parseQuotedPath(header)
    // 第二段（去掉空白后）
    const second = first ? header.slice(first.end).trimStart() : undefined
    // 缺少第二段则放弃
    if (!second) return
    // 第二段不带引号时按普通 diff 路径处理
    if (!second.startsWith('"')) return fileFromDiffPath(second)
    // 第二段带引号：解转义后提取文件名
    return fileFromDiffPath(parseQuotedPath(second)?.value)
  }

  // 无引号：找 " b/" 分隔符定位新路径
  const separator = header.indexOf(" b/")
  // 找不到分隔符则放弃
  if (separator === -1) return
  // 提取并解析新文件路径
  return fileFromDiffPath(header.slice(separator + 1))
}

// 从单个补丁块（chunk）中识别它涉及的文件路径
export const fileFromPatchChunk = (chunk: string) => {
  // 优先取 +++ 行的新文件路径
  const next = /^\+\+\+ (.+)$/m.exec(chunk)?.[1]
  // 其次取 --- 行的旧文件路径
  const before = /^--- (.+)$/m.exec(chunk)?.[1]
  // 两者取其一得到文件名
  const file = fileFromDiffPath(next) ?? fileFromDiffPath(before)
  // 命中即返回
  if (file) return file

  // 回退：解析 "diff --git" 头部
  const header = /^diff --git (.+)$/m.exec(chunk)?.[1]
  // 从头部提取文件名
  return fileFromGitHeader(header ?? "")
}

/** Split `git diff`-format output into per-file chunks, dropping a trailing partial chunk when truncated. */
// 把 git diff 输出按文件切成多个补丁块；截断时丢弃末尾不完整的块
export const splitGitPatch = (patch: Patch) => {
  // 找出所有 "diff --git " 出现的起点（排除紧跟上一行的情况）
  const starts = [...patch.text.matchAll(/(?:^|\n)diff --git /g)].map((match) =>
    // 匹配串以换行开头时起点后移一位
    match[0].startsWith("\n") ? match.index + 1 : match.index,
  )
  // 按起点切分出各文件的块
  const chunks = starts.map((start, index) => patch.text.slice(start, starts[index + 1] ?? patch.text.length))
  // 未截断时全部返回
  if (!patch.truncated) return chunks
  // 截断时丢弃最后一块（可能不完整）
  return chunks.slice(0, -1)
}

/** Map per-file chunks by the file they touch, concatenating chunks for the same file. */
// 按文件归组补丁块：同一文件的多个块拼接在一起
export const chunksByFile = (patch: Patch, fallback: (index: number) => string | undefined) =>
  // 归约累积成 文件 → 补丁文本 的映射
  splitGitPatch(patch).reduce((acc, chunk, index) => {
    // 解析块所属文件，失败时用回调兜底
    const file = fileFromPatchChunk(chunk) ?? fallback(index)
    // 仍无法确定归属则丢弃
    if (!file) return acc
    // 追加到该文件已有的补丁文本之后
    acc.set(file, (acc.get(file) ?? "") + chunk)
    // 返回累积器
    return acc
  }, new Map<string, string>())
