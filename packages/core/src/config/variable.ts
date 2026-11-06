// 配置变量（Config Variable）模块：对配置文本做 {env:VAR} 与 {file:path} 变量替换。
export * as ConfigVariable from "./variable.js"

// 导入 Node 的 os 模块，用于获取用户主目录。
import os from "os"
// 导入 Node 的 path 模块，用于路径拼接与解析。
import path from "path"
// 导入 Effect 库。
import { Effect } from "effect"
// 导入 jsonc-parser 的解析函数与错误类型。
import { type ParseError, parse } from "jsonc-parser"
// 导入文件系统工具服务。
import { FSUtil } from "@opencode/util/fs-util"

// 替换来源类型：来自真实配置文件路径，或来自虚拟内容（source + 所在目录 dir）。
type ParseSource =
  | {
      // 来源是磁盘上的配置文件。
      type: "path"
      // 配置文件路径。
      path: string
    }
  | {
      // 来源是虚拟文本。
      type: "virtual"
      // 虚拟来源名（如内存中的配置）。
      source: string
      // 用于解析相对路径的基准目录。
      dir: string
    }

// 替换输入：来源加上待处理文本与可选的环境变量覆盖表。
type SubstituteInput = ParseSource & {
  // 待替换的配置文本。
  text: string
  // 可选的环境变量表（缺省用 process.env）。
  env?: Record<string, string>
}

/** Apply {env:VAR} and {file:path} substitutions to config text. */
// 对配置文本应用 {env:VAR} 与 {file:path} 替换：env 直接内联，file 读取文件内容并转义后内联。
export const substitute = Effect.fn("ConfigVariable.substitute")(function* (input: SubstituteInput) {
  // 构造 env 替换函数：escape 为 true 时把值按 JSON 字符串转义（不含首尾引号）。
  const env = (escape: boolean) =>
    input.text.replace(/\{env:([^}]+)\}/g, (_, name: string) => {
      // 优先用传入的环境变量表，其次进程环境；取不到则为空串。
      const value = (input.env?.[name] ?? process.env[name]) || ""
      // 按需转义后返回。
      return escape ? JSON.stringify(value).slice(1, -1) : value
    })
  // Escape only when raw values break the JSON (e.g. Windows paths), so configs that parse today keep their meaning.
  // 先用未转义的原始值替换文件引用；仅当原始值破坏 JSON 语法（如 Windows 路径反斜杠）时才改用转义版本，
  // 保证今天能解析的配置含义不变。
  const raw = yield* substituteFiles(input, env(false))
  // 收集解析错误的数组。
  const errors: ParseError[] = []
  // 文本含 {env: 占位符时才需要尝试解析验证。
  if (input.text.includes("{env:")) parse(raw, errors, { allowTrailingComma: true })
  // 原始替换能通过解析：直接返回。
  if (!errors.length) return raw
  // 否则改用转义后的 env 值再替换一次。
  return yield* substituteFiles(input, env(true))
})

// 处理 {file:path} 替换：把每个引用替换为文件内容（JSON 字符串转义、去首尾引号）。
const substituteFiles = Effect.fnUntraced(function* (input: SubstituteInput, text: string) {
  // 获取文件系统工具服务。
  const fs = yield* FSUtil.Service
  // 解析相对路径的基准目录：路径来源用其所在目录，虚拟来源用指定目录。
  const configDir = input.type === "path" ? path.dirname(input.path) : input.dir
  // 日志中报告的来源名。
  const configSource = input.type === "path" ? input.path : input.source
  // 已拼接的输出。
  let out = ""
  // 已处理到的位置。
  let cursor = 0

  // 逐个处理文本中的 {file:...} 引用。
  for (const match of text.matchAll(/\{file:[^}]+\}/g)) {
    // 引用记号本身。
    const token = match[0]
    // 引用在文本中的起始位置。
    const index = match.index
    // 先拼接引用之前的原文。
    out += text.slice(cursor, index)

    // 计算引用所在行的行首。
    const lineStart = text.lastIndexOf("\n", index - 1) + 1
    // 取行首到引用之间的内容（去左侧空白）。
    const prefix = text.slice(lineStart, index).trimStart()
    // 位于 // 注释中的引用不替换，原样保留。
    if (prefix.startsWith("//")) {
      out += token
      cursor = index + token.length
      continue
    }

    // 提取引用中的文件路径。
    const filePath = token.slice("{file:".length, -1)
    // 展开 ~ 前缀为用户主目录。
    const expandedPath = filePath.startsWith("~/") ? path.join(os.homedir(), filePath.slice(2)) : filePath
    // 绝对路径直接用；相对路径基于配置文件目录解析。
    const resolvedPath = path.isAbsolute(expandedPath) ? expandedPath : path.resolve(configDir, expandedPath)
    // Like a missing {env:VAR}, a missing or unreadable file substitutes empty so one stale secret
    // reference cannot take down every Location that loads this config.
    // 读取文件内容：与缺失的 {env:VAR} 类似，文件缺失或不可读时替换为空串并记警告，
    // 避免一个过期的密钥引用拖垮加载这份配置的每个位置（Location）。
    const fileContent = yield* fs.readFileString(resolvedPath).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("config file reference is missing or unreadable", {
          source: configSource,
          reference: token,
          path: resolvedPath,
          cause,
        }).pipe(Effect.as("")),
      ),
    )

    // 把文件内容（去首尾空白）按 JSON 字符串转义后内联（去掉首尾引号）。
    out += JSON.stringify(fileContent.trim()).slice(1, -1)
    // 前进游标越过该引用。
    cursor = index + token.length
  }

  // 拼接最后一段原文并返回。
  return out + text.slice(cursor)
})
