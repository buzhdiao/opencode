// Shell 解析（parse）模块：调用扫描器解析命令，产出权限资源（resource）、授权通配模式（save）与目录列表
// 桶导出（barrel export）：将本模块聚合为命名空间 ShellParse，供外部统一引用
export * as ShellParse from "./parse.js"

// effect 库：Effect 组合与 Result 容错工具
import { Effect, Result } from "effect"
// Node 文件系统（读取 /etc/passwd）
import fs from "fs"
// os 工具（获取用户主目录、当前用户信息）
import os from "os"
// 路径拼接与解析
import path from "path"
// POSIX/Bash/Zsh 的便携 shell 扫描器
import { ShellScan } from "./scan.js"
// shell 选择与识别工具
import { ShellSelect } from "./select.js"
// 通配符（wildcard）匹配工具
import { Wildcard } from "../util/wildcard.js"

// 词片段（Part）：text 为去引号后的"熟"文本，raw 为源码原文，unquotedTilde 标记未加引号的 ~ 开头词
type Part = { type: string; text: string; raw: string; unquotedTilde?: boolean }
// 会改变当前工作目录（cwd）的命令集合，同时收录 PowerShell 的对应别名（统一小写）
const CWD = new Set(["cd", "chdir", "popd", "pushd", "push-location", "set-location"])
// 匹配 PowerShell 的 -LiteralPath 参数（含缩写 -lp 与别名 -pspath，可选结尾冒号，忽略大小写）
const POWERSHELL_LITERAL_FLAG_RE = /^-(?:lp|l(?:i(?:t(?:e(?:r(?:a(?:l(?:p(?:a(?:t(?:h)?)?)?)?)?)?)?)?)?)?|psp(?:a(?:t(?:h)?)?)?):?$/i
// 匹配 PowerShell 的 -Stack 参数（含 -StackName 与缩写 -st，可选结尾冒号）
const POWERSHELL_STACK_FLAG_RE = /^-(?:stack(?:name|nam|na|n)?|st):?$/i

// 扫描结果：commands 为每条命令的权限资源及其授权模式（save），directories 为涉及的目录操作数
export type Result = {
  commands: Array<{ resource: string; save: string }>
  directories: string[]
}

// 命令前缀表（ARITY）：键为"命令 [子命令]"组合，值为授权前缀应保留的词数；
// 如 "docker": 2 表示 `docker ps` 的授权前缀取前 2 个词，"npm run": 3 表示 `npm run dev` 取 3 个词
const ARITY: Record<string, number> = {
  // —— 单命令工具：前缀保留 1 个词 ——
  cat: 1,
  cd: 1,
  chmod: 1,
  chown: 1,
  cp: 1,
  echo: 1,
  env: 1,
  export: 1,
  grep: 1,
  kill: 1,
  killall: 1,
  ln: 1,
  ls: 1,
  mkdir: 1,
  mv: 1,
  ps: 1,
  pwd: 1,
  rm: 1,
  rmdir: 1,
  sleep: 1,
  source: 1,
  tail: 1,
  touch: 1,
  unset: 1,
  which: 1,
  // —— 带子命令的工具：前缀保留 2 个词（个别条目为 3，表示子命令后还需一个操作词）——
  aws: 3,
  az: 3,
  bazel: 2,
  brew: 2,
  bun: 2,
  "bun run": 3,
  "bun x": 3,
  cargo: 2,
  "cargo add": 3,
  "cargo run": 3,
  cdk: 2,
  cf: 2,
  cmake: 2,
  composer: 2,
  consul: 2,
  "consul kv": 3,
  crictl: 2,
  deno: 2,
  "deno task": 3,
  doctl: 3,
  docker: 2,
  "docker builder": 3,
  "docker compose": 3,
  "docker container": 3,
  "docker image": 3,
  "docker network": 3,
  "docker volume": 3,
  eksctl: 2,
  "eksctl create": 3,
  firebase: 2,
  flyctl: 2,
  gcloud: 3,
  gh: 3,
  git: 2,
  "git config": 3,
  "git remote": 3,
  "git stash": 3,
  go: 2,
  gradle: 2,
  helm: 2,
  heroku: 2,
  hugo: 2,
  ip: 2,
  "ip addr": 3,
  "ip link": 3,
  "ip netns": 3,
  "ip route": 3,
  kind: 2,
  "kind create": 3,
  kubectl: 2,
  "kubectl kustomize": 3,
  "kubectl rollout": 3,
  kustomize: 2,
  make: 2,
  mc: 2,
  "mc admin": 3,
  minikube: 2,
  mongosh: 2,
  mysql: 2,
  mvn: 2,
  ng: 2,
  npm: 2,
  "npm exec": 3,
  "npm init": 3,
  "npm run": 3,
  "npm view": 3,
  npx: 2,
  nvm: 2,
  nx: 2,
  openssl: 2,
  "openssl req": 3,
  "openssl x509": 3,
  pip: 2,
  pipenv: 2,
  pnpm: 2,
  "pnpm dlx": 3,
  "pnpm exec": 3,
  "pnpm run": 3,
  poetry: 2,
  podman: 2,
  "podman container": 3,
  "podman image": 3,
  psql: 2,
  pulumi: 2,
  "pulumi stack": 3,
  python: 2,
  pyenv: 2,
  rake: 2,
  rbenv: 2,
  "redis-cli": 2,
  rustup: 2,
  serverless: 2,
  sfdx: 3,
  skaffold: 2,
  sls: 2,
  sst: 2,
  swift: 2,
  systemctl: 2,
  terraform: 2,
  "terraform workspace": 3,
  tmux: 2,
  turbo: 2,
  ufw: 2,
  vault: 2,
  "vault auth": 3,
  "vault kv": 3,
  vercel: 2,
  volta: 2,
  wp: 2,
  yarn: 2,
  "yarn dlx": 3,
  "yarn run": 3,
}
// 表中最大的词数（此处为 3），作为前缀匹配时截取词数的上限
const PREFIX_LENGTH = Math.max(...Object.values(ARITY))

// 扫描入口：解析一条 shell 命令，产出授权所需的资源与目录信息（失败返回 Error）
export function scan(command: string, shell: string, cwd: string): Effect.Effect<Result, Error> {
  // suspend 让扫描延迟到 Effect 实际运行时才执行（惰性求值）
  return Effect.suspend(() => {
    // 当前 shell 是否为 PowerShell 系
    const powershell = ShellSelect.ps(shell)
    // 当前 shell 的短名称（bash/zsh/sh 等）
    const shellName = ShellSelect.name(shell)
    // PowerShell 用专用扫描器；其余按方言扫描（bash/zsh 用各自方言，其他一律按 posix 兜底）
    const scanned = powershell
      ? ShellScan.scanPowerShell(command)
      : ShellScan.scan(command, shellName === "bash" || shellName === "zsh" ? shellName : "posix")
    // 扫描器无法可靠分析（opaque，不透明）时直接报错，交由上层拒绝执行
    if (scanned.kind === "opaque")
      return Effect.fail(new Error(`Portable shell scanner cannot analyze command: ${scanned.reason}`))

    // 结果累加器
    const output: Result = { commands: [], directories: [] }
    // 逐条处理扫描出的命令
    for (const item of scanned.commands) {
      // Declarations are skipped as standalone permission resources, while nested substitutions remain.
      // 声明（declaration，如 export FOO=1）不单独生成命令授权，其内嵌替换仍会被扫描
      if (item.declaration) continue
      // 无命令的裸重定向（如 `> log`）：截取重定向标记之前的前缀再加 * 授权
      if (item.redirectPrefixEnd !== undefined) {
        // 重定向标记之前的源码片段
        const head = item.resource.slice(0, item.redirectPrefixEnd)
        // 重定向结束位置上的那个字符
        const next = item.resource[item.redirectPrefixEnd]
        // 该字符是制表符/换行就沿用，否则用空格衔接通配符
        const separator = next === "\t" || next === "\n" ? next : " "
        // 资源为原文，保存模式为"前缀 + 分隔符 + *"（匹配任意重定向目标）
        output.commands.push({ resource: item.resource, save: `${head}${separator}*` })
        continue
      }
      // 若参数之间夹着重定向，则只取第一个重定向之前的词作为参数
      const words = item.redirectWordCount === undefined ? item.rawWords : item.rawWords.slice(0, item.redirectWordCount)
      // Bare statement-head foreach blocks act as PowerShell control flow rather than cmdlet invocations.
      // PowerShell 语句头的 foreach 块是控制流关键字而非 cmdlet 调用，跳过
      if (
        powershell &&
        item.statementHead &&
        /^foreach(?:-|$)/i.test(words[0] ?? "") &&
        words.length > 1 &&
        words.slice(1).every((word) => word.startsWith("{"))
      )
        continue
      // 把每个原始词拆成片段（Part）：PowerShell 识别参数与值，POSIX 侧标记动态性与 ~ 前缀
      const parts = powershell
        ? words.flatMap((raw, index): Part[] => {
            // 默认用原始词；仅当不含转义的 `$ 且含引号字符时，才改用去引号后的熟文本
            const text =
              !raw.includes("`$") && /['"`]/.test(raw) ? (item.words[index] ?? raw) : raw.replaceAll("`$", "\0")
            // 不符合 -Name 参数形态的词按普通单词处理
            if (!/^-[A-Za-z_?][\w?-]*(?::|$)/.test(raw)) return [{ type: "word", text, raw }]
            // 参数名与值以冒号分隔（如 -Path:C:\x），定位冒号位置
            const colon = text.indexOf(":")
            if (colon >= 0) {
              // 原始词中的冒号位置（可能因引号与熟文本不同）
              const rawColon = raw.indexOf(":")
              return colon + 1 < text.length
                ? [
                    // 冒号之前是参数名片段（按参数类型记录）
                    { type: "command_parameter", text: text.slice(0, colon), raw: raw.slice(0, rawColon) },
                    // 冒号之后是值片段（普通单词）
                    { type: "word", text: text.slice(colon + 1), raw: rawColon >= 0 ? raw.slice(rawColon + 1) : raw },
                  ]
                // 冒号在末尾：整词只是一个参数
                : [{ type: "command_parameter", text: text.slice(0, colon), raw }]
            }
            // 无冒号：整词就是一个参数
            return [{ type: "command_parameter", text, raw }]
          })
        : item.rawWords.map((raw, index): Part => {
            // 取对应的熟文本，缺失时退回原始词
            const word = item.words[index] ?? raw
            return {
              type: "word",
              // 静态词（无展开）把 $ 换成占位符以便按字面通配；动态词统一记为 "$"（匹配任意值）
              text: isStaticBashWord(raw) ? word.replaceAll("$", "\0") : "$",
              raw,
              // 记录该词是否以未加引号的 ~ 开头（需要主目录展开）
              unquotedTilde: raw.startsWith("~"),
            }
          })
      // 尝试把命令识别为切换目录类命令（cd/pushd 等，可被 builtin/command 包裹）
      const directoryCommand = unwrapDirectoryCommand(powershell ? words : item.rawWords, parts, powershell)
      if (directoryCommand) {
        // 解析出目录操作数
        const resolved = directoryArgs(directoryCommand, powershell, cwd, shell)
        // 记录这些目录
        output.directories.push(...resolved.directories)
        // 若整个命令就是目录命令且参数全部解析成功，则只授权目录，不再生成命令资源
        if (directoryCommand === parts && resolved.complete) continue
      }
      // 按前缀表匹配命令头：从最长（PREFIX_LENGTH 个词）往下试
      const selected = prefix(words.slice(0, PREFIX_LENGTH))
      // 常规保存模式："命令前缀 + *"（匹配任意参数）
      const conventional = `${selected.join(" ")} *`
      // 最后一个前缀词在资源原文中的结束下标（仅 PowerShell 扫描提供）
      const end = item.wordEnds?.[selected.length - 1]
      // Keep existing grants stable unless normalized spacing loses the original source boundary.
      // 保存模式：优先沿用常规模式；仅当 PowerShell 且原文边界与规范化形式不一致时，才按原文裁剪
      const save =
        !powershell || end === undefined || Wildcard.match(item.resource, conventional)
          ? conventional
          : item.resource[end] === "("
            ? `${item.resource.slice(0, end)}(*`
            : (() => {
                // 向后找到第一个词边界（空白处），在该处截断
                const boundary =
                  item.wordEnds?.find(
                    (value) => value >= end && (value >= item.resource.length || /\s/.test(item.resource[value])),
                  ) ?? end
                // 取边界处的空白（可能含反引号续行）作为分隔符
                const separator = /^\s+(?:`(?:\r\n|\r|\n)\s*)?/.exec(item.resource.slice(boundary))?.[0]
                // 保存模式 = 原文前缀 + 分隔符 + *
                return `${item.resource.slice(0, boundary)}${separator ?? " "}*`
              })()
      // 记录命令：资源为原文，保存模式如上
      output.commands.push({
        resource: item.resource,
        save,
      })
    }
    // 扫描成功，返回累加结果
    return Effect.succeed(output)
  })
}

// 识别目录命令：返回该命令对应的片段切片（用于提取目录操作数）；非目录命令返回 undefined
function unwrapDirectoryCommand(rawWords: string[], parts: Part[], powershell: boolean) {
  // 取命令头（PowerShell 统一小写以便匹配别名）
  const head = powershell ? rawWords[0]?.toLowerCase() : rawWords[0]
  // 直接就是 cd/pushd 等命令
  if (CWD.has(head ?? "")) return parts
  // PowerShell 不做包裹展开
  if (powershell) return
  // POSIX 侧跳过 builtin/command 前缀及其选项
  let index = 0
  while (rawWords[index] === "builtin" || rawWords[index] === "command") {
    // 记住当前包裹词
    const wrapper = rawWords[index]
    index++
    // 跳过包裹命令的选项（- 开头的词）
    while (rawWords[index]?.startsWith("-")) {
      const flag = rawWords[index]
      index++
      // -- 表示选项结束
      if (flag === "--") break
      // command -v/-V 只做查找不执行，不算目录命令
      if (wrapper === "command" && /^-[p]*[vV]/.test(flag)) return
    }
  }
  // 跳过包裹后若命令头是目录命令，则返回其余片段
  return index > 0 && CWD.has(rawWords[index] ?? "") ? parts.slice(index) : undefined
}

// 判断一个 Bash 词是否为"静态"词：不含展开（expansion）、不含会匹配点文件的通配、引号闭合。
// 静态词可按字面值参与权限通配匹配；返回 false 表示动态或不安全。
function isStaticBashWord(raw: string) {
  // 当前引号上下文：单引号、双引号或 ANSI-C 引号 $'...'
  let quote: "'" | '"' | "$'" | undefined
  // 是否已进入当前路径段（以 / 分隔）
  let segmentStarted = false
  // 当前路径段是否以点开头（潜在点文件）
  let segmentLeadingDot = false
  // 当前路径段是否出现通配符
  let segmentGlob = false
  // 是否出现过 $'...' 中的反斜杠转义（可解码出任意字符）
  let hasAnsiEscape = false
  // 是否存在未加引号的通配符
  let hasUnquotedGlob = false
  // 未闭合花括号栈，值表示该层是否含逗号或 ..（花括号展开）
  const braces: boolean[] = []
  // 记录一个字符并维护路径段状态；返回 false 表示该词不安全
  const recordChar = (char: string, unquotedGlob = false) => {
    // 记录未加引号的通配符
    if (unquotedGlob) hasUnquotedGlob = true
    // ANSI 转义与未引用通配同现：转义可能解码出任意字符，视为不安全
    if (hasAnsiEscape && hasUnquotedGlob) return false
    // 斜杠开启新路径段，重置段内状态
    if (char === "/") {
      segmentStarted = false
      segmentLeadingDot = false
      segmentGlob = false
      return true
    }
    // 段首字符决定该段是否以点开头
    if (!segmentStarted) {
      segmentStarted = true
      segmentLeadingDot = char === "."
    }
    // 段内出现通配符
    if (unquotedGlob) segmentGlob = true
    // 点开头的段里出现通配（如 .*）不安全
    return !(segmentLeadingDot && segmentGlob)
  }

  // 逐字符扫描原始词
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index]
    const next = raw[index + 1] ?? ""
    // 单引号内：除闭引号外一切按字面处理
    if (quote === "'") {
      if (char === "'") {
        quote = undefined
        continue
      }
      if (!recordChar(char)) return false
      continue
    }
    // ANSI-C 引号 $'...' 内：反斜杠转义需特殊处理
    if (quote === "$'") {
      if (char === "\\") {
        hasAnsiEscape = true
        if (hasUnquotedGlob) return false
        index++
        continue
      }
      if (char === "'") {
        quote = undefined
        continue
      }
      if (!recordChar(char)) return false
      continue
    }
    // 双引号内：仅 \$ \` \" \\ 与反斜杠换行是转义
    if (quote === '"') {
      if (char === "\\" && '$`"\\\n'.includes(next)) {
        index++
        if (next !== "\n" && !recordChar(next)) return false
        continue
      }
      if (char === '"') {
        quote = undefined
        continue
      }
      // 双引号内的反引号或 $ 展开（含 $ 后接续行）使词变为动态
      if (char === "`" || (char === "$" && (/[A-Za-z_0-9@*#?$!({[-]/.test(next) || raw.startsWith("\\\n", index + 1))))
        return false
      if (!recordChar(char)) return false
      continue
    }
    // 未引用的反斜杠转义下一个字符（\<换行> 是续行，直接跳过）
    if (char === "\\") {
      index++
      if (next !== "\n" && !recordChar(next)) return false
      continue
    }
    // 进入单引号
    if (char === "'") {
      quote = "'"
      continue
    }
    // 进入双引号
    if (char === '"') {
      quote = '"'
      continue
    }
    // $' 开始 ANSI-C 引号
    if (char === "$" && next === "'") {
      quote = "$'"
      index++
      continue
    }
    // $" 是本地化引号，按双引号处理
    if (char === "$" && next === '"') {
      quote = '"'
      index++
      continue
    }
    // 反引号、进程替换 <( >( =(、以及 $ 展开都使词变为动态
    if (
      char === "`" ||
      ((char === "<" || char === ">" || char === "=") && next === "(") ||
      (char === "$" && (/[A-Za-z_0-9@*#?$!({[-]/.test(next) || raw.startsWith("\\\n", index + 1)))
    )
      return false
    // 进入花括号，入栈
    if (char === "{") {
      braces.push(false)
      if (!recordChar(char)) return false
      continue
    }
    // 花括号内出现逗号或双点（..）说明是花括号展开（brace expansion）
    if (braces.length > 0 && (char === "," || (char === "." && next === "."))) {
      braces[braces.length - 1] = true
    }
    // 闭合花括号：若该层是展开则不安全；否则按普通字符记录
    if (char === "}" && braces.length > 0) {
      if (braces.pop()) return false
      if (!recordChar(char)) return false
      continue
    }
    // 普通字符；* ? [ 是通配符
    if (!recordChar(char, char === "*" || char === "?" || char === "[")) return false
  }
  // 引号未闭合则不视为静态
  return quote === undefined
}

// 判断 PowerShell 词中是否存在可能匹配点开头路径段的通配符（点文件风险）
function hasPowerShellDotWildcard(raw: string) {
  // 当前引号上下文
  let quote: "'" | '"' | undefined
  // 路径段状态（/ 和 \ 都算分隔符）
  let segmentStarted = false
  let segmentLeadingDot = false
  let segmentGlob = false
  // 双引号内是否出现过反引号转义（转义可能隐藏通配语义）
  let hasQuoteEscape = false
  // 是否存在未引用通配符
  let hasUnquotedGlob = false
  // 记录字符；返回 true 表示发现点段通配
  const recordChar = (char: string, unquotedGlob = false) => {
    if (unquotedGlob) hasUnquotedGlob = true
    // 引号转义与未引用通配同现时，保守判定为存在风险
    if (hasQuoteEscape && hasUnquotedGlob) return true
    // 分隔符开启新路径段
    if (char === "/" || char === "\\") {
      segmentStarted = false
      segmentLeadingDot = false
      segmentGlob = false
      return false
    }
    // 段首记录是否以点开头
    if (!segmentStarted) {
      segmentStarted = true
      segmentLeadingDot = char === "."
    }
    if (unquotedGlob) segmentGlob = true
    // 点开头且段内有通配即命中
    return segmentLeadingDot && segmentGlob
  }

  // 逐字符扫描
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index]
    const next = raw[index + 1] ?? ""
    // 单引号内：'' 表示字面单引号
    if (quote === "'") {
      if (char === "'" && next === "'") {
        index++
        if (recordChar("'")) return true
        continue
      }
      if (char === "'") {
        quote = undefined
        continue
      }
      if (recordChar(char)) return true
      continue
    }
    // 双引号内：`` 为字面反引号，"" 为字面双引号
    if (quote === '"') {
      if (char === "`") {
        hasQuoteEscape = true
        if (hasUnquotedGlob) return true
        index++
        continue
      }
      if (char === '"' && next === '"') {
        index++
        if (recordChar('"')) return true
        continue
      }
      if (char === '"') {
        quote = undefined
        continue
      }
      if (recordChar(char)) return true
      continue
    }
    // 未引用的反引号转义下一字符
    if (char === "`") {
      index++
      if (recordChar(next)) return true
      continue
    }
    // 进入引号
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    // 普通字符；* ? [ 为通配符
    if (recordChar(char, char === "*" || char === "?" || char === "[")) return true
  }
  return false
}

// 从目录命令中提取目录操作数；complete 表示所有操作数都已解析为具体目录
function directoryArgs(command: Part[], powershell: boolean, cwd: string, shell: string) {
  // 命令头（小写）
  const head = command[0]?.text.toLowerCase() ?? ""
  // popd 弹栈依赖运行时目录栈，无法静态求值
  if (head === "popd" || head === "pop-location") return { directories: [], complete: false }

  // POSIX 分支：收集非选项操作数
  if (!powershell) {
    // 是否已遇到 --（其后一切都算操作数）
    let endOfOptions = false
    // 过滤出操作数：跳过选项，-- 后全收，- 本身算操作数（表示上一次目录）
    const operands = command.slice(1).filter((part) => {
      if (endOfOptions) return true
      if (part.text === "--") {
        endOfOptions = true
        return false
      }
      if (part.text === "-") return true
      return !part.text.startsWith("-")
    })
    // 没有操作数则无目录可授权
    if (operands.length === 0) return { directories: [], complete: false }
    // 逐个解析操作数；无法解析的记为 undefined
    const resolved = operands.map((part) =>
      part.text === "-" ? undefined : directoryArgument(part.text, false, cwd, shell, part.unquotedTilde),
    )
    // 收集成功解析的目录
    const directories = resolved.filter((item): item is string => item !== undefined)
    // 全部解析成功才算 complete
    return { directories, complete: directories.length === operands.length }
  }

  // PowerShell 分支
  const directories: string[] = []
  // 上一个参数是否为 -Path/-LiteralPath（其后的词是路径值）
  let pathFlag = false
  // 上一个参数是否为 -LiteralPath（值按字面处理）
  let literalFlag = false
  // 是否已遇到 --（其后不再是参数）
  let endOfParameters = false
  // 是否出现过操作数
  let sawOperand = false
  // 是否全部可静态解析
  let complete = true
  // 遍历除命令头外的所有片段
  for (const part of command.slice(1)) {
    // -- 之后一切都是操作数
    if (!endOfParameters && part.text === "--") {
      endOfParameters = true
      continue
    }
    // -Path/-LiteralPath 的值
    if (pathFlag) {
      sawOperand = true
      // 非字面模式下，点通配或 -/+（栈引用）都视为无法静态解析
      const value =
        !literalFlag && (hasPowerShellDotWildcard(part.raw) || part.text === "-" || part.text === "+")
          ? undefined
          : directoryArgument(part.text, true, cwd, shell)
      if (value) directories.push(value)
      if (!value) complete = false
      // 选项值只作用于一个词
      pathFlag = false
      literalFlag = false
      continue
    }
    // 参数名
    if (!endOfParameters && part.type === "command_parameter") {
      // 涉及位置栈的命令无法静态求值，直接放弃
      if (POWERSHELL_STACK_FLAG_RE.test(part.text)) {
        complete = false
        return { directories, complete }
      }
      // 记录是否为字面路径参数
      literalFlag = POWERSHELL_LITERAL_FLAG_RE.test(part.text)
      // -Path 系参数（-p/-pa/-path 等）
      pathFlag = literalFlag || /^-p(?:ath|at|a)?:?$/i.test(part.text)
      continue
    }
    // 普通操作数
    sawOperand = true
    // 点通配或选项未结束时的 -/+ 栈引用无法静态解析
    const value =
      hasPowerShellDotWildcard(part.raw) || (!endOfParameters && (part.raw === "-" || part.raw === "+"))
        ? undefined
        : directoryArgument(part.text, true, cwd, shell)
    if (value) directories.push(value)
    if (!value) complete = false
  }
  // 必须出现过操作数且全部解析成功
  return { directories, complete: sawOperand && complete }
}

// 把单个目录操作数解析为具体路径；无法解析时返回 undefined
function directoryArgument(value: string, powershell: boolean, cwd: string, shell: string, unquotedTilde = false) {
  // POSIX 直接做已知目录展开
  if (!powershell) return expandKnownDirectory(value, false, cwd, unquotedTilde)
  // PowerShell：先剥掉成对的外层引号
  const quote = value[0]
  const text = (quote === '"' || quote === "'") && value.at(-1) === quote ? value.slice(1, -1) : value

  // PowerShell exposes environment variables through $env:NAME and provides these
  // automatic directory variables. Expand only values we can determine without executing code.
  // 依次展开 ${env:NAME}、$env:NAME 与自动目录变量 $HOME/$PWD/$PSHOME（只做可静态确定的替换）
  return expandKnownDirectory(
    text
      // ${env:NAME} 形式，查不到则替换为空
      .replace(/\$\{env:([^}]+)\}/gi, (_, key: string) => environment(key) ?? "")
      // $env:NAME 形式
      .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, key: string) => environment(key) ?? "")
      // $HOME/$PWD/$PSHOME（含 ${HOME} 花括号形式）：分别取主目录/当前目录/shell 所在目录
      .replace(/\$(?:\{(HOME|PWD|PSHOME)\}|(HOME|PWD|PSHOME)(?=$|[\\/]))/gi, (_, braced?: string, bare?: string) => {
        const key = (braced ?? bare ?? "").toUpperCase()
        if (key === "HOME") return os.homedir()
        if (key === "PWD") return cwd
        return path.dirname(shell)
      }),
    true,
    cwd,
  )
}

// 展开常见的目录写法（~、~user 等）；返回 undefined 表示无法静态确定
function expandKnownDirectory(value: string, powershell: boolean, cwd: string, unquotedTilde = false) {
  // Unknown shell expressions cannot be resolved safely during permission analysis.
  // 含 $、反引号或 PowerShell 子表达式的值无法安全静态求值
  if (value.includes("$") || value.includes("`") || (powershell && value.startsWith("("))) return
  // 还原此前被替换成 \0 占位符的 $ 字符
  const resolved = value.replaceAll("\0", "$")
  // ~ 即主目录
  if (resolved === "~") return os.homedir()
  // ~/...（Windows 下 ~\...）拼接到主目录之后
  if (resolved.startsWith("~/") || (process.platform === "win32" && resolved.startsWith("~\\"))) {
    return path.join(os.homedir(), resolved.slice(2))
  }
  // 未加引号的 ~ 才支持更多波浪号形式（且仅非 Windows）
  if (unquotedTilde && process.platform !== "win32") {
    // ~+ 是当前目录
    if (resolved === "~+") return cwd
    // ~+/... 拼接到当前目录
    if (resolved.startsWith("~+/")) return path.join(cwd, resolved.slice(3))
    // ~-N/~N 依赖目录栈历史，无法静态求值
    if (/^~(?:[-+](?:\d+)?|\d+)(?=$|\/)/.test(resolved)) return
    // ~user 形式：解析该用户的主目录
    const userMatch = /^~([A-Za-z_][A-Za-z0-9._-]*)(?=$|\/)/.exec(resolved)
    if (userMatch) {
      const user = userMatch[1]
      const home = resolveUserHome(user)
      if (!home) return
      return path.join(home, resolved.slice(user.length + 1))
    }
  }
  // 其余原样返回
  return resolved
}

// /etc/passwd 用户主目录映射的进程级缓存
let cachedPasswdHomes: ReadonlyMap<string, string> | undefined

// 解析 /etc/passwd，构建 用户名 -> 主目录 的映射（带缓存）
function passwdHomes() {
  // 命中缓存直接返回
  if (cachedPasswdHomes) return cachedPasswdHomes
  // 读取失败按空内容处理
  const content = Result.try(() => fs.readFileSync("/etc/passwd", "utf8"))
  // 成功则逐行解析：跳过空行与注释，取第 1 列（用户名）与第 6 列（主目录）
  const entries = Result.isSuccess(content)
    ? content.success.split("\n").flatMap((line): Array<[string, string]> => {
        if (!line || line.startsWith("#")) return []
        const fields = line.split(":")
        const name = fields[0]
        const home = fields[5]
        return name && home ? [[name, home]] : []
      })
    : []
  // 构建并缓存
  cachedPasswdHomes = new Map(entries)
  return cachedPasswdHomes
}

// 解析指定用户的主目录；找不到返回 undefined
function resolveUserHome(user: string) {
  // 先看当前进程用户是否就是目标用户
  const current = Result.try(() => os.userInfo())
  if (Result.isSuccess(current) && current.success.username === user && current.success.homedir) {
    return current.success.homedir
  }
  // 再查 /etc/passwd
  const fromPasswd = passwdHomes().get(user)
  if (fromPasswd) return fromPasswd
  // macOS 最后尝试 /Users/<user> 目录是否存在
  if (process.platform === "darwin") {
    const candidate = path.join("/Users", user)
    const exists = Result.try(() => fs.statSync(candidate).isDirectory())
    if (Result.isSuccess(exists) && exists.success) return candidate
  }
}

// 读取环境变量；Windows 上做大小写不敏感匹配
function environment(key: string) {
  if (process.platform !== "win32") return process.env[key]
  const name = Object.keys(process.env).find((item) => item.toLowerCase() === key.toLowerCase())
  return name ? process.env[name] : undefined
}

// 前缀匹配：从最长的词组合开始查 ARITY 表，命中即按其词数截取；否则保留第一个词
function prefix(tokens: string[]) {
  for (let length = tokens.length; length > 0; length--) {
    const arity = ARITY[tokens.slice(0, length).join(" ")]
    if (arity !== undefined) return tokens.slice(0, arity)
  }
  return tokens.slice(0, 1)
}
