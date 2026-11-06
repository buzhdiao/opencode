// Shell 扫描（scan）模块：把 Bash/Zsh/POSIX 或 PowerShell 命令文本解析为词与命令，
// 供权限系统静态判定可授权范围；无法可靠解析时报告不透明（opaque）原因
// 桶导出（barrel export）：将本模块聚合为命名空间 ShellScan，供外部统一引用
export * as ShellScan from "./scan.js"

// 不透明（opaque）原因枚举：解析器无法可靠分析命令的各类情形
export type OpaqueReason =
  | "command-substitution"
  | "compound-command"
  | "dynamic-command-name"
  | "dynamic-execution"
  | "heredoc"
  | "invalid-redirect"
  | "invalid-structure"
  | "unterminated-escape"
  | "unterminated-quote"

// 一条被扫描出的命令：resource 为源码片段，words 为熟词，rawWords 为源码原文词
type Command = {
  resource: string
  words: string[]
  rawWords: string[]
  // Exclusive raw-token ends relative to resource, for source-shaped permission prefixes.
  // 各词在 resource 内的"独占"结束下标，用于构造贴近源码形状的权限前缀
  wordEnds?: number[]
  // 是否为 PowerShell 语句头（statement head）上的调用
  statementHead?: true
  // 是否为声明（declaration，如 export FOO=1）
  declaration?: true
  // Words before the first redirect when redirects appear between arguments.
  // 当参数之间夹着重定向（redirect）时，记录第一个重定向之前的词数
  redirectWordCount?: number
  // Exclusive prefix end relative to resource for commandless or group redirects.
  // 无命令或成组重定向时，重定向标记之前的前缀在 resource 内的独占结束下标
  redirectPrefixEnd?: number
}

// Opaque describes a parsing limitation, not a permission decision.
// 扫描结果：opaque 表示解析能力受限（并非权限判定）；scanned 携带解析出的命令列表
export type Result = { kind: "scanned"; commands: Command[] } | { kind: "opaque"; reason: OpaqueReason }

// Bash 全部重定向运算符，长的在前以便优先匹配
const BASH_REDIRECTS = ["&>>", "&>", "<<<", "<<-", "<<", "<>", "<&", ">&", ">|", ">>", ">", "<"]
// Bash 列表运算符：连接命令的运算符
const BASH_LIST_OPERATORS = ["&&", "||", "|&"]
// Zsh 的列表运算符（多出 &! 与 &|）
const ZSH_LIST_OPERATORS = ["&&", "||", "|&", "&!", "&|"]
// case 语句体内可用的分支分隔符（Bash）
const BASH_CASE_OPERATORS = [";;&", ";;", ";&", ";|", ...BASH_LIST_OPERATORS]
// case 语句体内可用的分支分隔符（Zsh）
const ZSH_CASE_OPERATORS = [";;&", ";;", ";&", ";|", ...ZSH_LIST_OPERATORS]
// Builtins that bind their operands to variables or evaluate them as variable names.
// 会把操作数绑定为变量名、或把操作数按变量名求值的内建命令（builtin）
const BASH_BINDING_BUILTINS = new Set([
  "declare",
  "typeset",
  "local",
  "export",
  "readonly",
  "private",
  "unset",
  "read",
  "getln",
  "vared",
  "getopts",
  "mapfile",
  "readarray",
  "compgen",
  "zparseopts",
  "zregexparse",
  "zformat",
  "zstyle",
  "zstat",
  "stat",
])
// 算术比较运算符：其操作数会按算术（arithmetic）方式求值
const BASH_ARITHMETIC_COMPARISONS = new Set(["-eq", "-ne", "-lt", "-le", "-gt", "-ge"])
// 文本中存在可执行展开的特征：$ 后跟 ( 或 {（允许转义字符与续行），或反引号
const BASH_EXPANSION_RE = /\$(?:\\.|\\\n)*[({]|`/
// 十六进制/八进制/Unicode 转义序列（如 \x41、\101、\u4e2d），可解码出任意字符
const BASH_ESCAPE_RE = /\\(?:x[\da-fA-F]{1,2}|[0-7]{1,3}|u[\da-fA-F]{1,4}|U[\da-fA-F]{1,8})/
// 支持 name=value 赋值语法的声明类内建命令
const BASH_ASSIGNMENT_DECLARATIONS = new Set(["declare", "typeset", "export", "readonly", "local"])
// 全部声明类内建命令（再含 unset/unsetenv）
const BASH_DECLARATIONS = new Set([...BASH_ASSIGNMENT_DECLARATIONS, "unset", "unsetenv"])
// Bash 的前导修饰词（precommand）：其后的词才是真正执行的命令
const BASH_PRECOMMANDS = new Set(["builtin", "command", "time", "coproc", "!"])
// Zsh 的前导修饰词
const ZSH_PRECOMMANDS = new Set(["noglob", "nocorrect", "exec", "-"])
// Zsh 中把操作数按算术求值（或本身无条件退出）的内建命令
const ZSH_ARITHMETIC_BUILTINS = new Set([
  "integer",
  "float",
  "exit",
  "return",
  "shift",
  "break",
  "continue",
  "bye",
  "logout",
])
// 不能作为函数名的保留字（它们是复合命令关键字）
const BASH_NON_FUNCTION_KEYWORDS = new Set([
  "if",
  "for",
  "select",
  "case",
  "then",
  "elif",
  "else",
  "fi",
  "do",
  "done",
  "in",
  "esac",
])
// Characters that can begin a quoting or expansion unit.
// 能开启一个引号/展开单元（unit）的起始字符
const BASH_UNIT_STARTS = "\\$'\"`<>"
// 输入长度上限（64KiB），超长直接视为不透明
const MAX_INPUT_LENGTH = 64 * 1024
// 嵌套替换深度上限
const MAX_SUBSTITUTION_DEPTH = 32
// 词元（token）匹配：标识符且其后（可跨续行）紧跟空白或运算符，才确认成词
const TOKEN_RE = /[A-Za-z_][A-Za-z0-9_]*(?=(?:\\\n)*(?:[ \t\n;|&()<>]|$))/y
// 前瞻：} 之后是空白/运算符/结尾（允许前置续行）
const BRACE_CLOSE_AHEAD_RE = /(?:\\\n)*(?:[ \t\n;&|()<>]|$)/y
// 前瞻：空白（允许前置续行）
const SPACE_CONTINUATION_AHEAD_RE = /(?:\\\n)*[ \t\n]/y
// 前瞻：空白或左括号（允许前置续行），用于确认取反前缀 !
const NEGATION_AHEAD_RE = /(?:\\\n)*[ \t\n(]/y
// Ahead of a coproc or time prefix: optional negations, then a compound command.
// coproc/time 前缀之后的内容：可选的若干取反 !，再跟一个复合命令
const COMPOUND_AHEAD = String.raw`(?=(?:!(?:[ \t]|\\\n)*)*(?:[{(]|\[\[(?:\\\n)*[ \t\n]|(?:if|while|until|for|select|case|repeat)\b))`
// coproc 前缀的粘性匹配（可选 -- 与协程名，后随复合命令）
const COPROC_AHEAD_RE = new RegExp(
  String.raw`coproc(?:[ \t]|\\\n)+(?:--(?:[ \t]|\\\n)+)?(?:[A-Za-z_][A-Za-z0-9_]*(?:[ \t]|\\\n)+)?` + COMPOUND_AHEAD,
  "y",
)
// time 前缀的粘性匹配（可选 -p 与 --，后随复合命令）
const TIME_AHEAD_RE = new RegExp(
  String.raw`time(?:[ \t]|\\\n)+(?:-p(?:[ \t]|\\\n)+)?(?:--(?:[ \t]|\\\n)+)?` + COMPOUND_AHEAD,
  "y",
)
// [function] name [()] then blanks, continuations, and comments before the body.
// 函数头：可选 function 关键字、函数名、可选 ()，其后是函数体之前的空白/续行/注释
const FUNCTION_HEAD_RE =
  /(function[ \t](?:[ \t]|\\\n)*)?([A-Za-z_][\w.:+@%-]*)?(?:[ \t]|\\\n)*(\([ \t]*\))?((?:[ \t\n]|\\\n|#[^\n]*\n)*)/y
// 函数体开启：{、(、[[ 或 if/while/... 等复合命令关键字
const FUNCTION_BODY_RE =
  /[{(]|\[\[(?=(?:\\\n)*[ \t\n])|(?:if|while|until|for|select|case|repeat)(?=(?:\\\n)*(?:[ \t\n(]|$))/y
// 前瞻：若干分隔符/注释之后出现 do 关键字或 {（for 循环体的开始）
const DO_AHEAD_RE = /(?:[ \t\n;]|\\\n|#[^\n]*(?:\n|$))*(?:do(?=(?:\\\n)*(?:[ \t\n;{(]|$))|\{(?=(?:\\\n)*[ \t\n]))/y
// `${` 后跟空白或 | 的开启（无 fork 替换形式）
const NOFORK_OPEN_RE = /\$\{(?:\\\n)*(?:[ \t\n]|\|)/y
// Zsh flags that neither evaluate nor glob a value; s and j take an argument between repeated delimiters.
// Zsh ${(...)}} 旗标组中不求值也不通配的安全旗标；s 与 j 旗标在成对分隔符之间带一个参数
const ZSH_SAFE_FLAGS_RE = /\$\{\((?:[@AaBbCcDEfFikLMmNnOopPqStUuVvWwXZz0-]|q[+]|[js]([^({[<\\])(?:(?!\1)[^)])*\1)*\)/y
// 匹配带引号参数的 s/j 旗标（用于从旗标串中剔除后再检查）
const ZSH_QUOTED_FLAG_ARG_RE = /[js]([^({[<\\])(?:(?!\1)[^)])*\1/g
// Zsh 的通配修饰符前缀（^ = ~ # + 等旗标后随 ~）
const ZSH_GLOB_MODIFIER_RE = /(?:[\^=~#+]|\\\n)*~/y
// Trailing Zsh glob qualifiers without code execution (e, +cmd), delimiters (f, u, g, P), modifiers (:), or math expressions.
// 不含代码执行（e、+cmd）、分隔符（f、u、g、P）、修饰符（:）与数学表达式的尾部 Zsh 通配限定符（qualifier）
const ZSH_GLOB_QUALIFIER_RE =
  /\((?:[/F.@=*rwxAIERWsStUG^MTNDn-]|[oO][nLlamcdN]|[amc][Mwhmsd]?[-+]?\d+|L[kKmMpPgGtT]?[-+]?\d+|[lY][-+]?\d+|\[[-+]?\d+(?:,[-+]?\d+)?\]|,)+\)(?=(?:\\\n)*(?:[ \t\n;&|<>)]|$))/y
// Zsh 的变量下标开启：$name 前可带旗标，后随 [
const ZSH_SUBSCRIPT_RE = /\$(?:[\^=+~#]|\\\n)*(?:[A-Za-z_](?:[A-Za-z0-9_]|\\\n)*|[@*#?$!0-9-])(?:\\\n)*\[/y
// 零个或多个续行（反斜杠+换行）
const LINE_CONTINUATION_RE = /(?:\\\n)*/y
// 参数展开的前缀：可选 Zsh 旗标组与 ! # ^ = + ~ 前缀（允许续行）
const PARAMETER_PREFIX_RE = /(?:\\\n)*(?:\([^)]*\))?(?:[!#^=+~]|\\\n)*/y
// 参数名：标识符、数字或特殊参数（@ * # ? $ ! - 等）
const PARAMETER_NAME_RE = /(?:[A-Za-z_](?:[A-Za-z0-9_]|\\\n)*|\d(?:\d|\\\n)*|[@*#?$!-])(?:\\\n)*/y
// 参数提示符展开的结束：@P} 或 @E}（Bash 的 ${name@P} 会把值当提示符求值）
const PARAMETER_PROMPT_RE = /@(?:\\\n)*[EP](?:\\\n)*\}/y
// ANSI-C 引号 $'...' 中受支持的转义映射表
const BASH_ANSI_ESCAPES: Record<string, string> = {
  a: "\x07",
  b: "\b",
  e: "\x1b",
  E: "\x1b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "\\": "\\",
  "'": "'",
  '"': '"',
  "?": "?",
}

// 不透明结果的简写类型
type Opaque = { kind: "opaque"; reason: OpaqueReason }

// Bash 侧扫描结果：scanned 附带命令列表与扫描结束位置
type BashResult = { kind: "scanned"; commands: Command[]; end: number } | Opaque

// Shared across one scan: the work budget, the shell dialect, and whether a bound expansion reaches a variable sink.
// 一次扫描全程共享：工作预算、方言（dialect），以及被绑定文本中的展开是否到达变量汇（variable sink）
type BashContext = {
  // 剩余工作预算，防止超长/恶意输入拖垮解析
  remaining: number
  // 当前 shell 方言
  dialect: Dialect
  // 是否已出现"被绑定"文本中的展开特征（$、反引号）
  boundDollar?: boolean
  // 是否出现可执行展开的开启特征（$、(、{、反引号）
  boundOpen?: boolean
  // 是否出现可能携带 `[` 的文本（替换输出/转义等）
  boundBracket?: boolean
  // 求值汇一侧是否出现 `[`（下标会被再次求值）
  sinkBracket?: boolean
  // 是否存在会被按名字/算术求值的变量汇
  variableSink?: boolean
  // 是否出现 eval、PS4 等"执行其内容"的汇（eval sink）
  evalSink?: boolean
}

// 一个待读取正文的 heredoc 的描述
type BashHeredoc = {
  // 结束分隔符（解码后）
  delimiter: string
  // Dash 风格的原始分隔符（保留 $ 时与 delimiter 不同）
  dashDelimiter?: string
  // 分隔符是否带引号（带引号则正文不做展开）
  quoted: boolean
  // 是否为 <<- 形式（正文可去前导制表符）
  tabs: boolean
  // 正文是否流入变量绑定（需要按"延迟求值"检查）
  binding?: boolean
  // 是否已被某条命令认领
  owned?: true
  // 认领该 heredoc 的命令（用于回填 resource）
  command?: Command
  // 认领命令在源码中的起点
  start?: number
}

// Bash 扫描器的全部可变状态
type BashState = {
  // 输入文本
  input: string
  // 共享上下文
  context: BashContext
  // 已完成的命令列表
  commands: Command[]
  // 嵌套结构中先收集、之后并入 commands 的命令
  nestedCommands: Command[]
  // 当前命令的熟词（去引号后）
  words: string[]
  // 当前命令的原始词（源码原文）
  rawWords: string[]
  // Pending heredocs, shared with nested groups: a body starts after the next newline token at any nesting.
  // 待读取正文的 heredoc，与嵌套组共享：任何层级的换行之后都可能开始正文
  heredocs: BashHeredoc[]
  // 复合命令结构栈
  structures: Array<{
    // 结构种类
    kind: "if" | "while" | "until" | "for" | "case" | "repeat"
    // 所处阶段
    phase: "header" | "condition" | "pattern" | "body" | "do"
    // 该阶段已完成的语句数
    count: number
    // 是否已出现 else
    sawElse?: boolean
    // 是否已出现 in
    sawIn?: boolean
    // case 模式是否已开始
    patternStarted?: boolean
    // for 的值列表是否为括号形式
    parenthesized?: boolean
  }>
  // 当前正在累积的熟词文本
  word: string
  // 当前词的字面文本（解码后、不含展开）
  literal: string
  // 当前词中命令替换输出的字面替代文本
  output: string
  // 是否正在累积一个词
  wordStarted: boolean
  // 当前词在源码中的起点
  wordStart: number
  // 当前词在源码中的结束（独占）
  wordEnd: number
  // 当前命令在源码中的起点
  commandStart: number | undefined
  // 第一个重定向之前的词数（语义见 Command）
  redirectWordCount: number | undefined
  // 裸重定向前缀的结束下标（语义见 Command）
  redirectPrefixEnd: number | undefined
  // Posix shells such as Dash read `&>` as `&` and `>`, so later words would start another command there.
  // POSIX shell（如 Dash）把 `&>` 读作 `&` 和 `>`，此时后续词会开启新命令；记录触发时的词数以便校验
  ampersandRedirectWords: number | undefined
  // 当前命令命令词的下标（-1 表示尚未出现）
  commandWordIndex: number
  // 当前词是否处于赋值目标（name=）位置
  assignmentWord: boolean
  // 赋值头部出现引号/转义（值形态不可信）
  assignmentHeadUnsafe: boolean
  // 已发现的不透明原因
  invalid: OpaqueReason | undefined
  // 正在读取重定向目标
  redirectTarget: boolean
  // 是否为复制重定向 <& / >&
  dupRedirect: boolean
  // 是否为 here-string（<<<）
  hereString: boolean
  // 当前命令是否含重定向
  hasRedirect: boolean
  // 当前命令是否含文件重定向
  hasFileRedirect: boolean
  // 刚结束一个复合命令
  compoundEnd: boolean
  // A list operator (&&, ||, |, |&) still awaits its right-hand command.
  // 列表运算符（&&、||、|、|&）还在等待其右侧命令
  dangling: boolean
  // Receives each word's literal text when the list is a command substitution, whose output it stands in for.
  // 当该列表是命令替换时，接收各词字面文本的容器（其 output 即替换的输出替身）
  outer: BashText | undefined
}

// A word's cooked text, the literal text it decodes to apart from its expansions, and the literal text of its
// command substitutions' words, which stands in for their output.
// 一个词的三种文本：word 为熟文本；literal 为解码后（除展开外）的字面文本；
// output 为其命令替换各词的字面文本（充当替换输出的替身）
type BashText = { word: string; literal: string; output: string }

// Arithmetic text, a builtin operand that names or binds a variable now, or a value bound for later.
// 词的求值类别：arithmetic=按算术求值；binding=现在被绑定为变量名；deferred=绑定值供以后使用
type BashEvaluation = "arithmetic" | "binding" | "deferred"

// Bash and Zsh name those shells. Posix covers sh, dash, and any other shell, and stays sound for Bash, Zsh, and
// Dash alike, so it is the default.
// 方言：bash 与 zsh 指名对应 shell；posix 覆盖 sh/dash 及其他一切 shell，
// 其规则对 Bash/Zsh/Dash 也保持健全，因此是默认值
export type Dialect = "bash" | "zsh" | "posix"

// POSIX/Bash/Zsh 扫描入口：输入与方言，返回扫描结果
export function scan(input: string, dialect: Dialect = "posix"): Result {
  // 超长输入直接按不透明处理
  if (input.length > MAX_INPUT_LENGTH) return { kind: "opaque", reason: "invalid-structure" }
  // 初始化共享上下文：预算为"长度上限 × 嵌套深度上限"
  const context: BashContext = { remaining: MAX_INPUT_LENGTH * MAX_SUBSTITUTION_DEPTH, dialect }
  // 从头扫描
  const result = scanBash(input, 0, 0, context)
  // 不透明则原样返回
  if (result.kind === "opaque") return result
  // 被绑定的展开既可开启执行、又到达了求值汇，说明存在动态执行（如 eval、PS4、变量间接）
  if (
    context.boundDollar &&
    context.boundOpen &&
    (context.evalSink || ((context.boundBracket || context.sinkBracket) && context.variableSink))
  )
    return { kind: "opaque", reason: "dynamic-execution" }
  // 返回扫描出的命令
  return { kind: "scanned", commands: result.commands }
}

// 记录一条语句：若当前处于复合结构内，则该结构已完成的语句数加一
function bashStatement(state: BashState) {
  const structure = state.structures.at(-1)
  if (structure) structure.count++
}

// 当前是否处于复合结构的头部/模式/do 阶段（这些位置上的内容不是命令）
function bashInHeader(state: BashState) {
  const phase = state.structures.at(-1)?.phase
  return phase === "header" || phase === "pattern" || phase === "do"
}

// 当前位置是否处于一条新命令的开始（无已积累词、无重定向、不在结构头部）
function atCommandStart(state: BashState) {
  return !state.words.length && !state.hasRedirect && !state.compoundEnd && !bashInHeader(state)
}

// 当前列表是否还有未收尾的内容（半个词/已积累词/重定向/刚结束的复合命令）
function pending(state: BashState) {
  return state.wordStarted || state.words.length > 0 || state.hasRedirect || state.compoundEnd
}

// Ends the current list; false when an operator still awaits its command.
// 结束当前命令列表；若仍有运算符在等待右侧命令则返回 false
function endBashList(state: BashState) {
  if (pending(state)) finishBashCommand(state, false, true)
  return !state.dangling
}

// 关闭一个列表（如遇到 ) 或输入结束）并产出扫描结果
function closeBashList(state: BashState, end: number): BashResult {
  // 运算符悬空说明结构不合法
  if (!endBashList(state)) return { kind: "opaque", reason: "invalid-structure" }
  // 此前记录的不透明原因优先返回
  if (state.invalid) return { kind: "opaque", reason: state.invalid }
  // 仍有未闭合的复合结构
  if (state.structures.length) return { kind: "opaque", reason: "compound-command" }
  // 成功：返回命令列表与结束位置
  return { kind: "scanned", commands: state.commands, end }
}

// 收尾当前正在累积的词：分类归档到命令词、赋值或重定向目标
function finishBashWord(state: BashState) {
  // 没有正在累积的词则无事可做
  if (!state.wordStarted) return
  // 词中出现 PS4（追踪提示符，其值会被 shell 当代码求值）记为 eval 汇
  if (/PS4/.test(state.word)) state.context.evalSink = true
  // 计算该词的求值类别（算术/绑定/延迟）
  const evaluation = bashWordEvaluation(state)
  // 非 Bash 方言：NULLCMD 或向特殊数组/选项参数的赋值会触发动态执行
  if (
    state.context.dialect !== "bash" &&
    (/(?:READ)?NULLCMD/.test(state.word) ||
      ((state.assignmentWord || evaluation === "binding") &&
        /^(?:-[A-Za-z]*v)?(?:(?:dis_)?(?:functions|[gs]?aliases)|options|commands)(?:\+?=|\[|$)/.test(state.word)))
  )
    state.invalid ??= "dynamic-execution"
  // 该词的求值类别会实际展开其中的文本时，记为动态执行
  if (evaluation && bashEvaluatesExpansion(state, evaluation, state.context)) state.invalid ??= "dynamic-execution"
  // 熟词与字面文本不一致且已有命令词时，若命令是 declare/typeset/local（会再解析参数），记为 eval 汇
  if (state.word !== state.literal && state.commandWordIndex >= 0) {
    const builtin = state.words[bashBuiltinIndex(state)]
    if (builtin === "declare" || builtin === "typeset" || builtin === "local") state.context.evalSink = true
  }
  // 命令替换场景：把本词的字面/输出文本并入外层容器（充当替换输出）
  if (state.outer) state.outer.output += ` ${state.literal} ${state.output}`
  const structure = state.structures.at(-1)
  // 是否处于 repeat 循环头部（其控制变量按算术求值）
  const repeatHeader = structure?.kind === "repeat" && structure.phase === "header"
  // repeat 头部的第一个词是循环变量，不算命令词；头部到此结束
  if (!state.redirectTarget && repeatHeader) structure.phase = "do"
  // 非重定向目标且不在 repeat 头部：作为命令词归档
  if (!state.redirectTarget && !repeatHeader) {
    // 尚无命令词且不是赋值目标，则本词是命令词
    if (!state.assignmentWord && state.commandWordIndex < 0) state.commandWordIndex = state.words.length
    // 记录命令源码起点
    state.commandStart ??= state.wordStart
    // 收录熟词
    state.words.push(state.word)
    // Unquoted trailing continuations are ignored syntax, not part of the raw token.
    // 未引用的尾部续行只是被忽略的语法，不属于原始词；按词的真实起止截取
    state.rawWords.push(state.input.slice(state.wordStart, state.wordEnd))
  }
  // 本词是重定向目标
  if (state.redirectTarget) {
    // 复制重定向 <&/>& 中形如 2-、- 的纯描述符不算文件重定向
    if (!state.dupRedirect || !/^(?:\d+-?|-)$/.test(state.input.slice(state.wordStart, state.wordEnd)))
      state.hasFileRedirect = true
    // 记录重定向目标的起点（裸重定向前缀用）
    state.redirectPrefixEnd ??= state.wordEnd
  }
  // 重置词级状态
  state.redirectTarget = false
  state.dupRedirect = false
  state.hereString = false
  state.word = ""
  state.literal = ""
  state.output = ""
  state.wordStarted = false
  state.assignmentWord = false
  state.assignmentHeadUnsafe = false
}

// How the shell evaluates the current word's literal text: as arithmetic, or as a value it binds to a variable
// that a later $((name)) may evaluate.
// 判定 shell 会如何处理当前词的字面文本：按算术求值，还是绑定到变量（之后可能被 $((name)) 再次求值）
function bashWordEvaluation(state: BashState): BashEvaluation | undefined {
  // 重定向目标：here-string 的内容供以后使用（延迟），文件重定向目标不参与求值
  if (state.redirectTarget) return state.hereString ? "deferred" : undefined
  const structure = state.structures.at(-1)
  // repeat 头部的循环变量按算术求值
  if (structure?.kind === "repeat" && structure.phase === "header") return "arithmetic"
  // for 头部 in 之后的值列表供以后使用
  if (structure?.kind === "for" && structure.phase === "header" && structure.sawIn) return "deferred"
  // 还没出现命令词：处于赋值目标位置则延迟，否则不参与求值
  if (state.commandWordIndex < 0) return state.assignmentWord ? "deferred" : undefined
  // 找到真正执行的内建命令下标
  const name = bashBuiltinIndex(state)
  const command = state.words[name]
  if (command === undefined) return undefined
  // let 及 Zsh 的算术类内建按算术求值其操作数
  if (command === "let" || (state.context.dialect !== "bash" && ZSH_ARITHMETIC_BUILTINS.has(command)))
    return "arithmetic"
  // set：开 -A 数组选项时绑定变量名，否则值为延迟绑定
  if (command === "set")
    return state.words.slice(name + 1).some((word) => /^[-+][A-Za-z0-9]*A/.test(word)) ? "binding" : "deferred"
  // 绑定类内建（declare/export/read 等）
  if (BASH_BINDING_BUILTINS.has(command)) {
    const options = state.words.slice(name + 1)
    // -E/-F/-i/-n 等选项使其操作数按算术求值
    if (options.some((word) => word.startsWith("-") && /[EFin]/.test(word))) return "arithmetic"
    // A plain `name=value` declaration without options binds a scalar unless Bash re-parses an existing array.
    // 不带选项的普通 name=value 声明只绑定标量；除非 Bash 会把值重新按数组解析（含 ( 或 $、`）
    if (
      state.assignmentWord &&
      BASH_ASSIGNMENT_DECLARATIONS.has(command) &&
      options.every((word) => !word.startsWith("-")) &&
      (command === "export" ||
        command === "readonly" ||
        state.context.dialect === "zsh" ||
        !/\+?=(?:\(|[$`])/.test(state.word))
    )
      return "deferred"
    // 其余情形会把操作数当变量名/下标处理
    return "binding"
  }
  // printf/print -v 把输出绑定到指定变量名
  if (command === "printf" || command === "print") {
    const options = [...state.words.slice(name + 1), state.word]
    const flag = command === "print" ? /^-[A-Za-z]*v/ : /^-v/
    return options.some((word) => flag.test(word)) ? "binding" : undefined
  }
  // wait -p 把进程 ID 绑定到变量
  if (command === "wait")
    return /^-[nf]*p/.test(state.word) || /^-[nf]*p$/.test(state.words.at(-1) ?? "") ? "binding" : undefined
  // test/[：-v 测试变量名；Zsh 的 -t 按算术求值描述符
  if (command === "test" || command === "[") {
    if (state.words.at(-1) === "-v") return "binding"
    if (state.context.dialect !== "bash" && state.words.at(-1) === "-t") return "arithmetic"
  }
  return undefined
}

// Index of the word naming the builtin that runs, skipping precommand wrappers and their options.
// 找到命名真正执行的内建命令的词下标：跳过前导修饰词及其选项
function bashBuiltinIndex(state: BashState) {
  let name = state.commandWordIndex
  // 循环跳过 builtin/command/time/coproc/! 及 Zsh 的 nogoglob 等
  while (
    BASH_PRECOMMANDS.has(state.words[name] ?? "") ||
    (state.context.dialect !== "bash" && ZSH_PRECOMMANDS.has(state.words[name] ?? ""))
  ) {
    const precommand = state.words[name++]
    // 跳过修饰词的选项（- 开头；"-" 本身是 Zsh 前导词，到此为止）
    while (precommand !== "-" && state.words[name]?.startsWith("-")) {
      if (precommand === "exec" && /^-[cl]*a$/.test(state.words[name])) name++
      name++
    }
  }
  return name
}

// 结束当前命令：生成 Command 记录、检查内建命令的动态执行风险，并重置命令级状态
function finishBashCommand(state: BashState, boundary = false, newline = false) {
  // 先把正在累积的词收尾
  finishBashWord(state)
  // 仍处于重定向目标说明重定向没有目标词
  if (state.redirectTarget) state.invalid ??= "invalid-redirect"
  state.redirectTarget = false
  // 复合命令结束之后又出现新词，结构不合法
  if (state.compoundEnd && state.words.length > 0) state.invalid ??= "invalid-structure"
  const name = state.commandWordIndex
  const inHeader = bashInHeader(state)
  // 有命令词下标但该位置没有词（如只有重定向），结构不合法
  if (name >= 0 && !state.words[name]) state.invalid ??= "invalid-structure"
  // 认领本条命令的 Command（供 heredoc 归属用）
  let owner: Command | undefined
  if (name >= 0 && !inHeader) {
    // 命令资源 = 源码中命令起点到最后一个词结束，去掉首尾空白
    const resource = state.input.slice(state.commandStart, state.wordEnd).replace(/^[ \t\n]+|[ \t\n]+$/g, "")
    const command: Command = {
      resource,
      // 词序列从命令词开始（丢弃其前的赋值词）
      words: state.words.slice(name),
      rawWords: state.rawWords.slice(name),
      // 整条命令以声明类内建开头（如 export FOO=1）则标记为 declaration
      ...(name === 0 &&
      !state.hasRedirect &&
      BASH_DECLARATIONS.has(state.rawWords[0]) &&
      resource.startsWith(state.rawWords[0])
        ? { declaration: true as const }
        : {}),
      // 参数之间夹着重定向时，记录第一个重定向之前的词数（相对命令词）
      ...(state.redirectWordCount !== undefined && state.redirectWordCount < state.words.length
        ? { redirectWordCount: state.redirectWordCount - name }
        : {}),
    }
    state.commands.push(command)
    // 找到真正执行的内建命令及其参数
    const builtin = bashBuiltinIndex(state)
    const builtinName = state.words[builtin]
    const builtinArgs = state.words.slice(builtin + 1)
    // eval 会执行其参数
    if (builtinName === "eval") state.context.evalSink = true
    // set -k 使所有变量赋值都成为环境变量（关键字参数），视为动态执行
    if (builtinName === "set" && builtinArgs.some((word) => /^-[A-Za-z0-9]*k/.test(word) || word === "keyword"))
      state.invalid ??= "dynamic-execution"
    // Dash expands an alias defined earlier in the same script, which can name any command.
    // Dash 会展开同脚本中先前定义的别名（alias x=...），可能使命令名不可预知
    if (builtinName === "alias" && builtinArgs.some((word) => word.includes("="))) state.invalid ??= "dynamic-execution"
    // Zsh options such as globsubst, kshglob, and promptsubst enable evaluation on expansions and print -P.
    // Zsh 的 emulate/setopt/set -o 若开启 globsubst、kshglob、promptsubst 等选项，
    // 会让展开求值或 print -P 执行代码
    if (
      state.context.dialect !== "bash" &&
      (builtinName === "emulate" ||
        ((builtinName === "setopt" ||
          builtinName === "unsetopt" ||
          (builtinName === "set" && builtinArgs.some((word) => /^[-+][A-Za-z0-9]*o/.test(word)))) &&
          builtinArgs.some(
            (word) =>
              /^-[A-Za-z0-9]*m/.test(word) ||
              /^(?:no)?(?:globsubst|kshglob|promptsubst|promptvars|aliases)$/.test(
                word
                  .replace(/^[-+][A-Za-z0-9]*?o/i, "")
                  .toLowerCase()
                  .replace(/[_-]/g, ""),
              ),
          )))
    )
      state.invalid ??= "dynamic-execution"
    // Bash compgen -C and -F execute their argument immediately to generate completions.
    // Bash compgen 的 -C/-F 会立即执行其参数来生成补全
    if (
      state.context.dialect !== "zsh" &&
      builtinName === "compgen" &&
      builtinArgs.some((word) => word.startsWith("-") && /[CF]/.test(word))
    )
      state.invalid ??= "dynamic-execution"
    // 绑定类内建在列：其 heredoc 正文会流入变量绑定
    if (BASH_BINDING_BUILTINS.has(builtinName ?? "")) {
      for (const heredoc of state.heredocs) heredoc.binding ??= true
    }
    owner = command
  } else if (
    // 无命令词、不在结构头部、但有重定向：作为"裸重定向"命令记录
    name < 0 &&
    !inHeader &&
    state.commandStart !== undefined &&
    (state.hasFileRedirect || (state.hasRedirect && !state.compoundEnd))
  ) {
    // 源码片段与首部空白
    const rawSpan = state.input.slice(state.commandStart, state.wordEnd)
    const leading = /^[ \t\n]+/.exec(rawSpan)?.[0].length ?? 0
    // 资源 = 去掉首部空白与尾部空白的片段
    const resource = rawSpan.slice(leading).replace(/[ \t\n]+$/g, "")
    if (resource) {
      // 前缀结束位置：以重定向标记处为准（限定在资源范围内）
      const prefixEnd =
        state.redirectPrefixEnd !== undefined
          ? Math.max(1, Math.min(resource.length, state.redirectPrefixEnd - state.commandStart - leading))
          : resource.length
      // 前缀词（如 `> log` 的 `> log` 部分）
      const prefixToken = resource.slice(0, prefixEnd)
      const command: Command = {
        resource,
        words: [prefixToken],
        rawWords: [prefixToken],
        redirectPrefixEnd: prefixEnd,
      }
      state.commands.push(command)
      owner = command
    }
  }
  // 给待处理的 heredoc 指派归属命令（换行之后正文才开始）
  for (const heredoc of state.heredocs) {
    if (owner && newline && !heredoc.owned) {
      heredoc.command = owner
      heredoc.start = state.commandStart
    }
    heredoc.owned = true
  }
  // 作为列表边界结束却没有命令内容，结构不合法
  if (boundary && !state.words.length && !state.hasRedirect && !state.compoundEnd && !inHeader)
    state.invalid ??= "invalid-structure"
  // POSIX 把 &> 读作 & 和 >，此时若词数超过触发时的数量说明有词被误并入本命令
  if (state.words.length > (state.ampersandRedirectWords ?? Infinity)) state.invalid ??= "invalid-redirect"
  // 把嵌套结构中收集的命令并入
  state.commands.push(...state.nestedCommands.splice(0))
  // 确有命令内容则计一条语句
  if (!inHeader && (state.words.length > 0 || state.hasRedirect)) bashStatement(state)
  // 重置命令级状态
  state.words.length = 0
  state.rawWords.length = 0
  state.commandWordIndex = -1
  state.commandStart = undefined
  state.dupRedirect = false
  state.hasRedirect = false
  state.hasFileRedirect = false
  state.redirectWordCount = undefined
  state.redirectPrefixEnd = undefined
  state.ampersandRedirectWords = undefined
  state.compoundEnd = false
  state.dangling = false
}

// Bash/Zsh/POSIX 主扫描器：扫描一段（或一层嵌套）输入，返回结果或结束下标
function scanBash(
  input: string,
  start: number,
  depth: number,
  context: BashContext,
  // close：本层期待的闭合符（) / } / nofork），无则扫描到输入结束
  close?: ")" | "}" | "nofork",
  // A group shares its parent's heredocs; a substitution starts its own.
  // heredocs：成组命令与父级共享 heredoc；命令替换则自带新列表
  heredocs?: BashHeredoc[],
  // outer：命令替换场景下接收各词字面文本的容器
  outer?: BashText,
): BashResult {
  // 嵌套过深或预算耗尽即放弃
  if (depth > MAX_SUBSTITUTION_DEPTH || context.remaining < 0) return { kind: "opaque", reason: "invalid-structure" }
  // 初始化本层状态
  const state: BashState = {
    input,
    context,
    commands: [],
    nestedCommands: [],
    words: [],
    rawWords: [],
    heredocs: heredocs ?? [],
    structures: [],
    word: "",
    literal: "",
    output: "",
    wordStarted: false,
    wordStart: start,
    wordEnd: start,
    commandStart: undefined,
    redirectWordCount: undefined,
    redirectPrefixEnd: undefined,
    ampersandRedirectWords: undefined,
    commandWordIndex: -1,
    assignmentWord: false,
    assignmentHeadUnsafe: false,
    invalid: undefined,
    redirectTarget: false,
    dupRedirect: false,
    hereString: false,
    hasRedirect: false,
    hasFileRedirect: false,
    compoundEnd: false,
    dangling: false,
    outer,
  }
  // 逐字符主循环
  for (let index = start; index < input.length; index++) {
    // 每个字符消耗一格预算
    if (--context.remaining < 0) return { kind: "opaque", reason: "invalid-structure" }
    const char = input[index]
    // Line continuations are removed before tokens are read.
    // 反斜杠+换行的续行在读词元（token）前被移除，直接跳过
    if (char === "\\" && input[index + 1] === "\n") {
      index++
      continue
    }
    // 不在词中：判定词边界处的结构
    if (!state.wordStarted) {
      state.wordStart = index
      // 词外空白直接跳过
      if (char === " " || char === "\t") continue
      // 与本层 close 匹配的 }：先检查它是否真的是列表闭合（后随分隔符等）
      if (
        char === "}" &&
        state.words.length === 0 &&
        !state.redirectTarget &&
        (close === "}" || close === "nofork") &&
        state.structures.length === 0 &&
        (heredocs !== undefined || state.heredocs.length === 0) &&
        (close === "nofork" || testAt(BRACE_CLOSE_AHEAD_RE, input, index + 1))
      )
        return closeBashList(state, index)
      // 其余的 } 要么身处复合结构，要么结构不合法
      if (char === "}")
        return { kind: "opaque", reason: state.structures.length ? "compound-command" : "invalid-structure" }
      // 尝试处理命令开始处的结构（复合命令、函数、((、[[ 等）
      const step = scanBashCommandStart(state, index, depth, context)
      if (typeof step === "object") return step
      if (step !== undefined) {
        index = step
        continue
      }
    }
    // 以反斜杠结尾的输入：转义不完整
    if (char === "\\" && index + 1 >= input.length) return { kind: "opaque", reason: "unterminated-escape" }
    // 赋值目标处出现引号/转义（如 name="va"l），值形态不可信
    if (
      !state.assignmentWord &&
      ("'\"\\".includes(char) || (char === "$" && (input[index + 1] === "'" || input[index + 1] === '"')))
    )
      state.assignmentHeadUnsafe = true
    // 是否处于 case 模式（pat) 中的 pat）
    const inCasePattern = state.structures.at(-1)?.phase === "pattern"
    // Elsewhere a parenthesized group inside a word is a Zsh glob qualifier, which can run code.
    // 判定 name=(...) 是否为数组赋值（仅声明类命令或纯赋值；否则括号组可能是可执行代码的通配限定符）
    const array =
      (char === "=" || char === "(") &&
      state.assignmentWord &&
      state.word.length > 1 &&
      state.word.endsWith("=") &&
      !state.word.endsWith("==") &&
      (state.commandWordIndex < 0 || BASH_ASSIGNMENT_DECLARATIONS.has(state.rawWords[state.commandWordIndex]))
    // =( ) 进程替换或数组字面量：作为嵌套列表扫描并并入词
    if (char === "=" && (!state.wordStarted || array) && input[index + 1] === "(") {
      const end = scanBashNested(input, index + 2, depth, context, state.nestedCommands, ")")
      if (typeof end === "object") return end
      state.wordStarted = true
      state.word += input.slice(index, end + 1)
      index = end
      state.wordEnd = index + 1
      continue
    }
    // 引号/展开单元（$、"、'、`、<、> 等）交给单元扫描器
    const unit = BASH_UNIT_STARTS.includes(char)
      ? scanBashUnit(
          input,
          index,
          depth,
          context,
          state.nestedCommands,
          "word",
          // 命令词之后、非声明命令且非赋值目标时，才允许 $[ 算术形式
          !state.assignmentWord && state.commandWordIndex >= 0 && !BASH_DECLARATIONS.has(state.rawWords[0]),
          state,
        )
      : undefined
    if (typeof unit === "object") return unit
    if (unit !== undefined) {
      state.wordStarted = true
      index = unit
      state.wordEnd = index + 1
      continue
    }
    // name[subscript]= 形式的数组赋值：先扫描下标
    if (
      char === "[" &&
      !inCasePattern &&
      !state.assignmentWord &&
      !state.assignmentHeadUnsafe &&
      state.commandWordIndex < 0 &&
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(state.word)
    ) {
      const subscript: Command[] = []
      const end = scanBashSubscript(input, index + 1, depth, context, subscript, BASH_SPANS.assignmentSubscript)
      if (typeof end === "object") return end
      // 下标之后必须是 = 或 += 才是赋值
      const assign = bashOperator(input, end + 1, ["+=", "="])
      if (typeof assign === "object") return assign
      if (assign) {
        // Dash has no arrays and word-splits unquoted expansions inside `name[subscript]=value`.
        // Dash 没有数组且会在 name[subscript]=value 中按词拆分未引用的展开，故 posix 直接放弃
        if (context.dialect === "posix" && /[$`]/.test(input.slice(index + 1, end)))
          return { kind: "opaque", reason: "invalid-structure" }
        state.nestedCommands.push(...subscript)
        state.assignmentWord = true
        state.word += input.slice(index, end + 1)
        index = end
        state.wordEnd = index + 1
        continue
      }
    }
    // 数组字面量或 case 模式中的通配模式分组（如 *(a|b)）
    if (char === "(" && (array || ((inCasePattern || context.dialect === "bash") && /[?*+@!]$/.test(state.word)))) {
      const mode = array ? "array" : "pattern"
      const end = scanBashArrayOrPattern(input, index, depth + 1, context, state.nestedCommands, mode)
      if (typeof end === "object") return end
      // 该整体若吞掉了换行，会错过待读取的 heredoc 正文
      if (bashCrossesHeredoc(state, index, end)) return { kind: "opaque", reason: "heredoc" }
      // Zsh ends an array assignment at its closing parenthesis, so text right after it starts a command.
      // Zsh 在闭合括号处结束数组赋值，其后紧跟的文本会开启新命令，因此必须以分隔符收尾
      if (array && end + 1 < input.length && !" \t\n;&|<>)".includes(input[end + 1]))
        return { kind: "opaque", reason: "invalid-structure" }
      state.wordStarted = true
      state.word += input.slice(index, end + 1)
      index = end
      state.wordEnd = index + 1
      continue
    }
    // 词外注释：跳过至行尾
    if (char === "#" && !state.wordStarted) {
      const newline = input.indexOf("\n", index)
      if (newline === -1) break
      index = newline - 1
      continue
    }
    // 运算符与分隔符（重定向、管道、分号、换行等）
    if ("<>&|;\n".includes(char)) {
      const step = scanBashOperatorOrSeparator(state, index, depth, context)
      if (typeof step === "object") return step
      index = step
      continue
    }
    // case 模式的右括号：把当前词收尾后重读该字符
    if (inCasePattern && char === ")") {
      finishBashWord(state)
      index--
      continue
    }
    // 其他位置的 )：仅当本层期待 ) 才闭合
    if (char === ")") {
      if (close !== ")" || state.structures.length > 0 || (heredocs === undefined && state.heredocs.length > 0))
        return { kind: "opaque", reason: "compound-command" }
      return closeBashList(state, index)
    }
    // Zsh 词尾的通配限定符（如 f:e:h:），安全时按字面并入词
    if (
      char === "(" &&
      context.dialect === "zsh" &&
      state.wordStarted &&
      !inCasePattern &&
      testAt(ZSH_GLOB_QUALIFIER_RE, input, index)
    ) {
      const end = ZSH_GLOB_QUALIFIER_RE.lastIndex - 1
      bashAppend(state, input.slice(index, end + 1))
      index = end
      state.wordEnd = index + 1
      continue
    }
    // 其余的 ( 是子 shell 或无法识别的展开
    if (char === "(") return { kind: "opaque", reason: state.wordStarted ? "dynamic-execution" : "compound-command" }
    // 不认识的空白类字符（如垂直制表符）
    if (/\s/.test(char) && !" \t\n".includes(char)) return { kind: "opaque", reason: "invalid-structure" }
    // 空格/制表符结束当前词
    if (char === " " || char === "\t") {
      finishBashWord(state)
      continue
    }
    // 普通字符：累积进当前词
    state.wordStarted = true
    // name= 形态的赋值目标（词到此恰好是合法变量名，且头部无引号转义）
    if (
      char === "=" &&
      !state.assignmentWord &&
      !state.assignmentHeadUnsafe &&
      /^[A-Za-z_][A-Za-z0-9_]*\+?$/.test(state.word)
    )
      state.assignmentWord = true
    bashAppend(state, char)
    state.wordEnd = index + 1
  }

  // 输入结束但本层期待闭合符：未闭合的替换或结构
  if (close) return { kind: "opaque", reason: close === ")" ? "command-substitution" : "invalid-structure" }
  // 还有 heredoc 未读到正文
  if (state.heredocs.length) return { kind: "opaque", reason: "heredoc" }
  // 正常结束整个列表
  return closeBashList(state, input.length)
}

// Steps return the last consumed index.
// 处理重定向运算符与分隔符（; | & 换行等）；返回最后消费的下标
function scanBashOperatorOrSeparator(
  state: BashState,
  index: number,
  depth: number,
  context: BashContext,
): number | Opaque {
  const input = state.input
  const char = input[index]
  // 尝试把 <>& 开头的位置匹配为重定向运算符
  const redirect = "<>&".includes(char) ? bashOperator(input, index, BASH_REDIRECTS) : undefined
  if (typeof redirect === "object") return redirect
  const caseHead = state.structures.at(-1)
  // case 结构体内（非分支体）出现重定向不合法
  if (redirect && caseHead?.kind === "case" && caseHead.phase !== "body")
    return { kind: "opaque", reason: "invalid-redirect" }
  if (redirect) {
    // 本命令含重定向，命令起点至少从重定向词开始
    state.hasRedirect = true
    state.commandStart ??= state.wordStart
    // 连续两个重定向运算符不合法
    if (state.redirectTarget) state.invalid ??= "invalid-redirect"
    // 词是文件描述符前缀（如 2、{var}）时丢弃它，它不属于命令词
    const fdPrefix =
      state.wordStarted && !state.assignmentHeadUnsafe && /^(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})$/.test(state.word)
    if (fdPrefix) {
      state.word = ""
      state.literal = ""
      state.output = ""
      state.wordStarted = false
    }
    // 否则先收尾当前词
    if (!fdPrefix) finishBashWord(state)
    // POSIX 的 &> 分歧点：记录触发时的词数，防止后续词被误并入
    if (redirect.startsWith("&") && context.dialect === "posix") state.ampersandRedirectWords ??= state.words.length
    // 第一次遇到"命令之后"的重定向时，记录其前的词数
    if (state.redirectWordCount === undefined && state.commandWordIndex >= 0) {
      state.redirectWordCount = state.words.length
    }
    // heredoc（<< 与 <<-）：读取分隔符并入队
    if (redirect === "<<" || redirect === "<<-") {
      const delimiter = bashHeredocDelimiter(input, index + redirect.length, redirect === "<<-")
      if (!delimiter) return { kind: "opaque", reason: "invalid-redirect" }
      state.hasFileRedirect = true
      // 裸前缀结束于运算符后（空白）或分隔符结束处
      state.redirectPrefixEnd ??=
        " \t".includes(input[index + redirect.length] ?? "") ? index + redirect.length : delimiter.end + 1
      state.heredocs.push(delimiter)
      state.wordEnd = delimiter.end + 1
      state.redirectTarget = false
      state.dupRedirect = false
      return delimiter.end
    }
    // 运算符后紧跟空白：裸前缀在该处结束（供 > log 之类的无命令重定向用）
    if (" \t\n".includes(input[index + redirect.length] ?? "")) state.redirectPrefixEnd ??= index + redirect.length
    // 下一个词是重定向目标
    state.redirectTarget = true
    // 复制重定向（<& / >&）
    state.dupRedirect = redirect === "<&" || redirect === ">&"
    // here-string（<<<）
    state.hereString = redirect === "<<<"
    return index + redirect.length - 1
  }
  // case 模式中的 | 是模式分隔符，收尾当前词后重读
  if (state.structures.at(-1)?.phase === "pattern" && char === "|") {
    finishBashWord(state)
    return index - 1
  }
  const structure = state.structures.at(-1)
  // 是否处于 case 分支体
  const caseBody = structure?.kind === "case" && structure.phase === "body"
  // 按方言与位置选择可用运算符集合
  const operators =
    context.dialect === "zsh"
      ? caseBody
        ? ZSH_CASE_OPERATORS
        : ZSH_LIST_OPERATORS
      : caseBody
        ? BASH_CASE_OPERATORS
        : BASH_LIST_OPERATORS
  const operator = bashOperator(input, index, operators)
  if (typeof operator === "object") return operator
  // 分隔符取匹配到的运算符，否则就是单字符
  const separator = operator ?? char
  // case 分支体中的 ;;/;;&/;&/;|：结束列表并进入下一组模式
  if (caseBody && separator.startsWith(";") && separator.length > 1) {
    if (!endBashList(state)) return { kind: "opaque", reason: "invalid-structure" }
    structure.phase = "pattern"
    structure.patternStarted = false
    return index + separator.length - 1
  }
  // case 的头部/模式阶段只允许换行
  if (structure?.kind === "case" && (structure.phase === "header" || structure.phase === "pattern")) {
    if (separator !== "\n") return { kind: "opaque", reason: "compound-command" }
    // 模式阶段还残留未闭合的词
    if (structure.phase === "pattern" && (state.wordStarted || state.words.length > 0))
      return { kind: "opaque", reason: "compound-command" }
    finishBashWord(state)
    return readBashHeredocs(state, index, depth, context)
  }
  // for/repeat 的头部与 do 阶段只允许 ; 或换行
  if (
    (structure?.kind === "for" || structure?.kind === "repeat") &&
    (structure.phase === "header" || structure.phase === "do")
  ) {
    if (separator !== ";" && separator !== "\n") return { kind: "opaque", reason: "compound-command" }
    // 头部还没出现变量名（in 之前必须有词）
    if (structure.phase === "header" && !structure.sawIn && !state.wordStarted && state.words.length === 0)
      return { kind: "opaque", reason: "compound-command" }
  }
  // 空行：只读取 heredoc 正文
  if (separator === "\n" && !pending(state)) return readBashHeredocs(state, index, depth, context)
  // Zsh 允许独立的 ; 空语句
  if (separator === ";" && context.dialect === "zsh" && !pending(state) && !state.dangling) return index
  // 结束当前命令（换行则同时可能开始 heredoc 正文）
  finishBashCommand(state, true, separator === "\n")
  // for 头部遇到 ; 即进入 do 阶段
  if (structure?.kind === "for" && structure.phase === "header") structure.phase = "do"
  // 悬空标记：除了 ;、换行与单个 &（同步后台），其余运算符都要等右侧命令
  state.dangling = !(separator === ";" || separator === "\n" || (separator.startsWith("&") && separator !== "&&"))
  // Reprocess the newline to read pending heredoc bodies.
  // 换行若有待处理 heredoc，则回退一格重读该换行以触发正文读取
  if (separator === "\n" && state.heredocs.length) return index - 1
  return index + separator.length - 1
}

// 命令去重键：资源片段与词序列
function bashCommandKey(command: Command) {
  return JSON.stringify([command.resource, command.words])
}

// Reads the pending heredoc bodies after the newline at index and returns the last index they cover.
// 读取下标处换行之后的所有待处理 heredoc 正文，返回它们覆盖到的最后下标
function readBashHeredocs(state: BashState, index: number, depth: number, context: BashContext) {
  let end = index
  for (const heredoc of state.heredocs.splice(0)) {
    // 找到该 heredoc 的正文与结束行
    const body = bashHeredoc(state.input, end + 1, heredoc)
    if (!body) return { kind: "opaque", reason: "heredoc" } satisfies Opaque
    // 有归属命令时，把 resource 扩到正文结束（heredoc 也算命令的一部分）
    if (heredoc.command) heredoc.command.resource = state.input.slice(heredoc.start, body.end).trim()
    // 带引号的分隔符：正文按字面处理，不做展开
    const text = heredoc.quoted ? { word: body.source, literal: body.source, output: "" } : bashText()
    if (!heredoc.quoted) {
      // 不带引号则扫描正文中的展开
      const expansion = scanBashSpan(body.source, 0, depth, context, state.commands, BASH_SPANS.heredoc, true, text)
      if (typeof expansion === "object") return expansion
    }
    // 正文流入变量绑定时按"延迟求值"记录特征
    if (heredoc.binding) bashEvaluatesExpansion(text, "deferred", context)
    end = body.end
  }
  return end
}

// Whether a construct read as one unit holds a newline token that would start pending heredoc bodies.
// 判断一个被整体读取的构造里是否藏有换行（会提前触发待处理的 heredoc 正文）
function bashCrossesHeredoc(state: BashState, start: number, end: number) {
  return state.heredocs.length > 0 && state.input.slice(start, end).includes("\n")
}

// 处理命令开始位置的特殊结构（case 括号、for 值列表、复合命令、((、[[、函数头等）
// 返回消费到的下标；undefined 表示此处只是普通命令的开始
function scanBashCommandStart(
  state: BashState,
  index: number,
  depth: number,
  context: BashContext,
): number | Opaque | undefined {
  const input = state.input
  const char = input[index]
  const structure = state.structures.at(-1)
  // case 模式的开启括号（pat 的左括号）
  if (structure?.phase === "pattern" && !structure.patternStarted && !state.words.length && char === "(") {
    structure.patternStarted = true
    return index
  }
  // case 模式之间的 | 分隔符
  if (structure?.phase === "pattern" && char === "|") {
    if (!state.words.length) return { kind: "opaque", reason: "compound-command" }
    finishBashWord(state)
    structure.patternStarted = true
    return index
  }
  // case 模式的闭合括号：结束本组模式，进入分支体
  if (structure?.phase === "pattern" && char === ")") {
    if (!state.words.length) return { kind: "opaque", reason: "compound-command" }
    finishBashCommand(state)
    structure.phase = "body"
    structure.count = 0
    return index
  }
  // for 头部的括号值列表（for x in (a b c)，Zsh/Ksh 形式）
  if (structure?.kind === "for" && structure.phase === "header" && char === "(" && input[index + 1] !== "(") {
    const end = scanBashArrayOrPattern(input, index, depth + 1, context, state.nestedCommands, "array")
    if (typeof end === "object") return end
    if (bashCrossesHeredoc(state, index, end)) return { kind: "opaque", reason: "heredoc" }
    finishBashCommand(state)
    // Zsh permits a sublist or brace group directly after the value list, without do/done.
    // Zsh 允许值列表之后直接跟子列表或花括号组（无 do/done）；否则结构到此结束
    structure.phase = "do"
    structure.parenthesized = true
    if (!testAt(DO_AHEAD_RE, input, end + 1)) state.structures.pop()
    return end
  }
  // repeat 的 do 阶段：若下一个词不是 do，则该 repeat 没有 do/done，结构结束
  if (structure?.kind === "repeat" && structure.phase === "do" && char !== "\n" && char !== "#" && char !== ";") {
    if (matchAt(TOKEN_RE, input, index)?.[0] !== "do") state.structures.pop()
  }
  // 尝试按复合命令关键字（if/while/case 等）处理
  const keywordStep = scanBashKeyword(state, index, depth, context)
  if (keywordStep !== undefined) return keywordStep
  // for 的 do 阶段：只接受 { 开始的循环体
  if (structure?.kind === "for" && structure.phase === "do" && char !== "\n" && char !== "#" && char !== ";") {
    if (char !== "{" || !testAt(SPACE_CONTINUATION_AHEAD_RE, input, index + 1)) return { kind: "opaque", reason: "compound-command" }
    state.structures.pop()
  }
  const atStart = atCommandStart(state)
  // 命令开始处的 (：可能是函数定义头 name()
  const functionHead = atStart && char === "(" ? bashFunctionHeadLength(input, index) : 0
  if (functionHead) return index + functionHead - 1
  // 命令开始的取反 !
  if (atStart && char === "!") {
    if (testAt(NEGATION_AHEAD_RE, input, index + 1)) return index
  }
  // 是否处于 for 头部
  const forHeader = structure?.kind === "for" && structure.phase === "header"
  // 命令开始或 for 头部：尝试匹配 (( 与 [[ 运算符
  const compoundOpen =
    (atStart || forHeader) && "([".includes(char) ? bashOperator(input, index, ["((", "[["]) : undefined
  if (typeof compoundOpen === "object") return compoundOpen
  // (( )) 算术命令
  if (compoundOpen === "((") {
    // for 头部里 (( 之前不能有词
    if (forHeader && state.words.length > 0) return { kind: "opaque", reason: "compound-command" }
    // for 头部用允许注释的算术 span，其余用严格 span
    const span = forHeader ? BASH_SPANS.forArithmetic : BASH_SPANS.arithmetic
    const end = scanBashArithmetic(input, index + 2, depth, context, state.commands, span)
    if (typeof end === "number") {
      // 算术体若吞掉换行会错过 heredoc
      if (bashCrossesHeredoc(state, index, end)) return { kind: "opaque", reason: "heredoc" }
      if (!forHeader && context.dialect === "posix") {
        // Dash reads `((` as two nested subshells, so posix reports both readings.
        // Dash 把 `((` 读作两层嵌套子 shell；posix 按两种读法都报告
        const subshells = scanBash(input, index + 1, depth + 1, context, ")")
        if (subshells.kind === "opaque") return subshells
        if (subshells.end !== end) return { kind: "opaque", reason: "compound-command" }
        const seen = new Set(state.commands.map(bashCommandKey))
        state.commands.push(...subshells.commands.filter((command) => !seen.has(bashCommandKey(command))))
      }
      // for 头部的 ((...)) 是其 in 列表
      if (forHeader) {
        structure.phase = "do"
        structure.sawIn = true
      }
      if (!forHeader) {
        bashStatement(state)
        state.compoundEnd = true
      }
      return end
    }
    // 算术读法失败但报了不透明原因则返回
    if (end) return end
    if (forHeader) return { kind: "opaque", reason: "invalid-structure" }
  }
  // 命令开始的子 shell ( ) 或花括号组 { }
  if (
    atStart &&
    (char === "(" ||
      (char === "{" && testAt(SPACE_CONTINUATION_AHEAD_RE, input, index + 1)))
  ) {
    // 子组与父级共享 heredoc 列表
    const group = scanBash(input, index + 1, depth + 1, context, char === "{" ? "}" : ")", state.heredocs)
    if (group.kind === "opaque") return group
    // 空组不合法
    if (!input.slice(index + 1, group.end).trim()) return { kind: "opaque", reason: "invalid-structure" }
    state.commands.push(...group.commands)
    bashStatement(state)
    state.compoundEnd = true
    return group.end
  }
  // [[ ]] 条件命令
  if (
    atStart &&
    compoundOpen === "[[" &&
    testAt(SPACE_CONTINUATION_AHEAD_RE, input, index + 2)
  ) {
    const end = scanBashConditional(input, index + 2, depth, context, state.commands)
    if (typeof end === "object") return end
    if (bashCrossesHeredoc(state, index, end)) return { kind: "opaque", reason: "heredoc" }
    bashStatement(state)
    state.compoundEnd = true
    return end
  }
  // 都不匹配：普通命令开始
  return undefined
}

// 识别并处理 shell 复合命令关键字（if/then/fi/in/do/done/esac 等）
// 返回消费到的下标；undefined 表示不是关键字
function scanBashKeyword(
  state: BashState,
  index: number,
  depth: number,
  context: BashContext,
): number | Opaque | undefined {
  const input = state.input
  const char = input[index]
  // 关键字以字母/下划线开头，否则直接放弃
  if (!((char >= "A" && char <= "Z") || (char >= "a" && char <= "z") || char === "_")) return undefined
  const structure = state.structures.at(-1)
  // 取当前词元与其结束下标
  const token = matchAt(TOKEN_RE, input, index)?.[0]
  const end = index + (token?.length ?? 0) - 1
  // case 头部的 in：其前必须恰好是待匹配词且无重定向
  if (structure?.kind === "case" && structure.phase === "header" && token === "in") {
    if (state.words.length !== 1 || state.hasRedirect) return { kind: "opaque", reason: "compound-command" }
    finishBashCommand(state)
    structure.phase = "pattern"
    structure.patternStarted = false
    return end
  }
  // for 头部/do 阶段的 in（Zsh/Ksh 允许 do 之后跟 in）
  if (
    structure?.kind === "for" &&
    (structure.phase === "header" || structure.phase === "do") &&
    !structure.sawIn &&
    !structure.parenthesized &&
    token === "in" &&
    (structure.phase === "do" || state.words.length >= 1)
  ) {
    structure.sawIn = true
    structure.phase = "header"
    return end
  }
  // 空模式分支（pat) 之前直接 esac）也能结束 case
  if (structure?.phase === "pattern" && !structure.patternStarted && !state.words.length && token === "esac") {
    state.structures.pop()
    bashStatement(state)
    state.compoundEnd = true
    return end
  }
  // POSIX `for name do` omits the in list.
  // POSIX 的 for 允许省略 in 列表：for name 直接接 do
  if (
    structure?.kind === "for" &&
    structure.phase === "header" &&
    !structure.sawIn &&
    state.words.length === 1 &&
    !state.hasRedirect &&
    token === "do"
  ) {
    finishBashCommand(state)
    structure.phase = "do"
  }
  const inHeader = bashInHeader(state)
  // 结构闭合关键字（then/elif/else/fi/do/done/esac）：要求当前没有未收尾的词
  if (
    token &&
    ["then", "elif", "else", "fi", "do", "done", "esac"].includes(token) &&
    !state.words.length &&
    !state.redirectTarget &&
    (!inHeader || (token === "do" && structure?.phase === "do"))
  ) {
    // Bash and Dash read a reserved word after a redirect as a command word, while Zsh reads a keyword.
    // 重定向之后的保留字在 Bash/Dash 中是命令词（Zsh 中才是关键字），先结束列表
    if ((state.hasRedirect && context.dialect !== "zsh") || !endBashList(state) || !structure)
      return { kind: "opaque", reason: "compound-command" }
    // then：只属于 if 的条件阶段之后
    if (token === "then") {
      if (structure.kind !== "if" || structure.phase !== "condition" || !structure.count)
        return { kind: "opaque", reason: "compound-command" }
      structure.phase = "body"
      structure.count = 0
      return end
    }
    // elif/else：只属于 if 的分支体之后（else 之后不能再有 elif/else）
    if (token === "elif" || token === "else") {
      if (structure.kind !== "if" || structure.phase !== "body" || !structure.count || structure.sawElse)
        return { kind: "opaque", reason: "compound-command" }
      structure.phase = token === "elif" ? "condition" : "body"
      structure.sawElse = token === "else"
      structure.count = 0
      return end
    }
    // do：属于 for/while/until/repeat 的条件之后
    if (token === "do") {
      if (
        !["for", "while", "until", "repeat"].includes(structure.kind) ||
        !["condition", "do"].includes(structure.phase) ||
        (structure.kind !== "for" && structure.kind !== "repeat" && !structure.count)
      )
        return { kind: "opaque", reason: "compound-command" }
      structure.phase = "body"
      structure.count = 0
      return end
    }
    // fi/done/esac：闭合对应结构，其余情形不合法
    if (
      (token === "fi" && (structure.kind !== "if" || structure.phase !== "body" || !structure.count)) ||
      (token === "done" &&
        (!["for", "while", "until", "repeat"].includes(structure.kind) ||
          structure.phase !== "body" ||
          !structure.count)) ||
      (token === "esac" && (structure.kind !== "case" || structure.phase === "header"))
    )
      return { kind: "opaque", reason: "compound-command" }
    state.structures.pop()
    bashStatement(state)
    state.compoundEnd = true
    return end
  }
  // 不在命令开始位置则不再尝试
  if (!atCommandStart(state)) return undefined
  // 命令开始处的函数定义（name() { 或 function name ...）
  const definitionLength = bashFunctionHeadLength(input, index)
  if (definitionLength > 0) return index + definitionLength - 1
  // 复合命令的开启关键字：压入结构栈
  if (
    token === "if" ||
    token === "while" ||
    token === "until" ||
    token === "for" ||
    token === "select" ||
    token === "case" ||
    (token === "repeat" && context.dialect !== "bash")
  ) {
    // 结构层数与替换深度共享上限
    if (depth + state.structures.length >= MAX_SUBSTITUTION_DEPTH) return { kind: "opaque", reason: "compound-command" }
    state.structures.push({
      // select 按 for 的规则处理
      kind: token === "select" ? "for" : token,
      // for/select/case/repeat 从头部开始，其余从条件开始
      phase: ["for", "select", "case", "repeat"].includes(token) ? "header" : "condition",
      count: 0,
    })
    // The compound command itself satisfies a preceding list operator.
    // 复合命令本身即可满足其前的列表运算符
    state.dangling = false
    return end
  }
  // coproc/time 前缀：按各自的前瞻匹配整段
  const prefix = token === "coproc" ? COPROC_AHEAD_RE : token === "time" ? TIME_AHEAD_RE : undefined
  const prefixMatch = prefix && matchAt(prefix, input, index)?.[0]
  if (prefixMatch) return index + prefixMatch.length - 1
  return undefined
}

// 计算函数定义头的长度（[function] name [()]）；不是函数定义返回 0
function bashFunctionHeadLength(input: string, start: number) {
  const head = matchAt(FUNCTION_HEAD_RE, input, start)
  // 有 function 关键字时必须有名字；无关键字时必须有 () 且名字不是保留字
  if (!head || (head[1] ? !head[2] : !head[3] || BASH_NON_FUNCTION_KEYWORDS.has(head[2] ?? ""))) return 0
  // Blanks, comments, and newlines before the body stay for the caller, where newlines start heredoc bodies.
  // 函数体之前的空白/注释/换行留给调用者处理（换行会开始 heredoc 正文）
  return testAt(FUNCTION_BODY_RE, input, start + head[0].length) ? head[0].length - head[4].length : 0
}

// Word text is unquoted. Quoted text follows double-quote rules. Arithmetic text, including subscripts,
// expands like double-quoted text while its matcher still lets a backslash escape any character.
// 词文本模式：word=未引用；quoted=按双引号规则；arithmetic=算术文本（含下标），
// 其展开同双引号，但允许反斜杠转义任意字符
type BashTextMode = "word" | "quoted" | "arithmetic"

// 一段文本区域（span）：开启/闭合字符、遇到即拒绝的字符集、内部文本模式
type BashSpan = { open?: string; close?: string; reject: string; mode: Exclude<BashTextMode, "word"> }

// 各类 span 的参数表
const BASH_SPANS = {
  // 双引号串
  double: { close: '"', reject: "", mode: "quoted" },
  // heredoc 正文（无闭合符，读到分隔符行为止）
  heredoc: { reject: "", mode: "quoted" },
  // Bash rereads `((...))` it cannot parse as arithmetic, such as text with a comment, as nested subshells.
  // ((...)) 算术：遇到 ; # } 即放弃（Bash 会把读不通的 ((...)) 重读为嵌套子 shell）
  arithmetic: { open: "(", close: ")", reject: ";#}", mode: "arithmetic" },
  // for 头部的 ((...))：允许注释（POSIX for 的算术条件可含 #）
  forArithmetic: { open: "(", close: ")", reject: "#}", mode: "arithmetic" },
  // $[...] 旧式算术：结构字符一律拒绝
  bracketArithmetic: { close: "]", reject: ";|&<>()[\n'\"\\#", mode: "arithmetic" },
  // 下标 name[...]：按算术求值
  subscript: { open: "[", close: "]", reject: '"}', mode: "arithmetic" },
  // 双引号内的下标
  quotedSubscript: { open: "[", close: "]", reject: '"', mode: "quoted" },
  // Dash splits an assignment subscript at blanks and operators, so Bash and Zsh assignments diverge.
  // 赋值下标 name[...]=：Dash 会在空白与运算符处拆词，因此拒绝面最宽
  assignmentSubscript: { open: "[", close: "]", reject: " \t\n\r\v\f;&|<>()", mode: "arithmetic" },
  // Single quotes are literal here in some shells and quoting in others, so reject what either reading
  // would parse structurally and scan the contents for expansions. Inside a double-quoted parameter, Zsh and
  // Dash read them literally even within subscripts and arithmetic, where `"` and `}` would end the parameter.
  // 算术/参数内部的引号：各 shell 对单引号是字面还是引用看法不一，
  // 因此拒绝任何一种读法都会结构化解析的字符，并扫描内容中的展开
  arithmeticQuote: { close: "'", reject: '()[];"}', mode: "quoted" },
  arithmeticDouble: { close: '"', reject: "()[];}", mode: "quoted" },
  // 双引号参数内部的到闭引号 span（其中 " 与 } 会结束参数）
  parameterQuote: { close: "'", reject: '"}[]', mode: "quoted" },
} satisfies Record<string, BashSpan>

// Scans one quoting or expansion unit at index into commands, appending its text when given a sink.
// 扫描下标处的一个引号/展开单元：把解析出的命令收入 commands，并在给定 text 时把文本并入
// Returns the unit's last index, or undefined when the character is ordinary text.
// 返回该单元的最后一个下标；普通文本字符返回 undefined
function scanBashUnit(
  input: string,
  index: number,
  depth: number,
  context: BashContext,
  commands: Command[],
  mode: BashTextMode,
  // 是否允许 $[ 旧式算术
  allowBracket: boolean,
  text?: BashText,
): number | Opaque | undefined {
  const char = input[index]
  const next = input[index + 1] ?? "\0"
  // 反斜杠：双引号内只转义 $ ` " \ 换行，其余按字面
  if (char === "\\") {
    if (mode === "quoted" && !'$`"\\\n'.includes(next)) return undefined
    // 换行续行不产生文本
    if (text && next !== "\n") bashAppend(text, input.slice(index + 1, index + 2))
    return index + 1
  }
  // Zsh 的 $ 特殊形式若会求值（旗标组/通配修饰符）即动态执行
  if (char === "$" && context.dialect !== "bash" && zshEvaluates(input, index))
    return { kind: "opaque", reason: "dynamic-execution" }
  // Zsh 的 $name[...] 下标：按模式选择 span 扫描
  if (
    char === "$" &&
    context.dialect !== "bash" &&
    (mode === "word" || mode === "quoted") &&
    testAt(ZSH_SUBSCRIPT_RE, input, index)
  ) {
    const bracket = ZSH_SUBSCRIPT_RE.lastIndex
    const subscript = bashText()
    const span = mode === "quoted" ? BASH_SPANS.quotedSubscript : BASH_SPANS.subscript
    const end = scanBashSubscript(input, bracket, depth, context, commands, span, subscript)
    if (typeof end === "object") return end
    if (text) text.word += `${input.slice(index, bracket)}${subscript.word}]`
    return end
  }
  // 尝试匹配 $ 开头的运算符，或词模式下的 <( / >(
  const opener =
    char === "$"
      ? bashOperator(input, index, ["$$", "$((", "$(", "${", "$[", "$'", '$"'])
      : mode === "word" && (char === "<" || char === ">")
        ? bashOperator(input, index, [`${char}(`])
        : undefined
  if (typeof opener === "object") return opener
  // $$（进程 ID）：后面紧跟 $'...' 时各 shell 解释不一，含反斜杠即放弃
  if (opener === "$$") {
    const quoteStart = matchAt(LINE_CONTINUATION_RE, input, index + 2) ? LINE_CONTINUATION_RE.lastIndex : index + 2
    if (input[quoteStart] === "'") {
      const nextQuote = input.indexOf("'", quoteStart + 1)
      if (nextQuote < 0) return { kind: "opaque", reason: "unterminated-quote" }
      // Zsh and Bash 3.2 inside ${...} can parse $$'...' with ANSI-C escapes while Bash 5/Dash treat $$ as PID.
      // Zsh 与 Bash 3.2（在 ${...} 内）会把 $$'...' 按 ANSI-C 转义解析，而 Bash 5/Dash 把 $$ 当 PID
      if (input.slice(quoteStart + 1, nextQuote).includes("\\") && input.includes("'", nextQuote + 1))
        return { kind: "opaque", reason: "unterminated-quote" }
    }
    if (text) text.word += "$$"
    return index + 1
  }
  // 词模式下的 $'...'：读取 ANSI-C 引号并检查歧义
  if (mode === "word" && opener === "$'") {
    const quote = bashAnsiQuote(input, index + 1)
    if (!quote) return { kind: "opaque", reason: "unterminated-quote" }
    const firstQuote = input.indexOf("'", index + 2)
    // Dash does not support $'...' and closes the single-quoted span at the first `'`, even after `\`.
    // Dash 不支持 $'...'：它会在第一个 `'` 处闭合单引号（即使其前有反斜杠），产生分歧时放弃
    if (
      quote.end !== firstQuote &&
      ((context.dialect !== "bash" && index >= 2 && input[index - 2] === "$") ||
        (context.dialect === "posix" &&
          (input.indexOf("'", firstQuote + 1) < quote.end || /[#"\n]|\\'/.test(input.slice(firstQuote + 1)))))
    )
      return { kind: "opaque", reason: "unterminated-quote" }
    if (text) bashAppend(text, quote.value)
    return quote.end
  }
  // 算术模式下的 $'...'：解码后还须继续扫描到引号结束
  if (mode === "arithmetic" && opener === "$'") {
    const quote = bashAnsiQuote(input, index + 1)
    if (!quote || quote.end !== input.indexOf("'", index + 2) || /[()[\];"}]/.test(quote.value))
      return { kind: "opaque", reason: "invalid-structure" }
    if (text) bashAppend(text, quote.value)
    return scanBashSpan(input, index + 2, depth, context, commands, BASH_SPANS.arithmeticQuote, allowBracket, text)
  }
  // 词模式下的单引号串：字面取内容
  if (mode === "word" && char === "'") {
    const end = input.indexOf("'", index + 1)
    if (end < 0) return { kind: "opaque", reason: "unterminated-quote" }
    if (text) bashAppend(text, input.slice(index + 1, end))
    return end
  }
  // 算术模式下的单引号：继续扫描到闭引号
  if (mode === "arithmetic" && char === "'")
    return scanBashSpan(input, index + 1, depth, context, commands, BASH_SPANS.arithmeticQuote, allowBracket, text)
  // $"..." 本地化串按双引号处理
  if (mode === "word" && opener === '$"')
    return scanBashSpan(input, index + 2, depth, context, commands, BASH_SPANS.double, allowBracket, text)
  // 双引号串（算术内用专门的 span）
  if (mode !== "quoted" && char === '"') {
    const span = mode === "arithmetic" ? BASH_SPANS.arithmeticDouble : BASH_SPANS.double
    return scanBashSpan(input, index + 1, depth, context, commands, span, allowBracket, text)
  }
  // 进程替换/命令替换/$参数/$[ 等交给对应扫描器
  const end =
    opener === "<(" || opener === ">("
      ? scanBashNested(input, index + 2, depth, context, commands, ")")
      : (opener && opener !== "$'" && opener !== '$"') || char === "`"
        ? scanBashDollarOrBacktick(input, index, depth, context, commands, mode !== "word", allowBracket, text)
        : undefined
  // $name 等普通参数：仅把 $ 记入熟文本（名字由主循环逐字累积）
  if (end === undefined && char === "$" && /[A-Za-z_0-9@*#?$!-]/.test(next)) {
    if (text) text.word += "$"
    return index
  }
  // 有单元时把整段源码并入熟文本
  if (text && typeof end === "number") text.word += input.slice(index, end + 1)
  return end
}

// Zsh flag groups such as ${(e)name} evaluate a value, and a modifier run with ~, such as $^~name or
// ${(f)~name}, globs it, which can run glob qualifier code.
// 判断 Zsh 的 $ 展开是否会求值或通配：${(e)name} 之类旗标组会求值；带 ~ 的修饰符会通配，
// 而通配可能执行通配限定符代码
function zshEvaluates(input: string, index: number) {
  let at = index + 1
  // ${ 后跟续行：无法确定旗标，保守视为求值
  if (input.startsWith("{\\\n", at)) return true
  // ${(flags)name}：旗标组必须整体安全（不求值不通配），否则视为求值
  if (input[at] === "{" && input[at + 1] === "(") {
    if (!testAt(ZSH_SAFE_FLAGS_RE, input, index)) return true
    at = ZSH_SAFE_FLAGS_RE.lastIndex
  }
  // 跳过花括号进入名字部分
  if (input[at] === "{") at++
  // 名字前若带 ~ 通配修饰符则视为求值
  return testAt(ZSH_GLOB_MODIFIER_RE, input, at)
}

// 向词文本追加一段内容：熟文本与字面文本同步增长
function bashAppend(text: BashText, value: string) {
  text.word += value
  text.literal += value
}

// Arithmetic evaluation expands `name[subscript]` again, so a literal expansion in text the shell evaluates as
// arithmetic can run: (( )), $(( )), $[ ], subscripts, ${name:offset:length}, let operands, and the arithmetic
// operands of [[ ]]. Builtins that name or bind a variable from an operand evaluate its subscript, so a literal
// expansion there runs when the operand also has a bracket; a command substitution's words stand in for the
// output it supplies. Values bound for later, such as assignment values, array elements, for lists, and
// here-strings, reach arithmetic or subscript evaluation when a variable sink appears in the command.
// A parameter's words count as its value. Text that reaches arithmetic only at runtime, through the
// environment, a function argument, or the output a command substitution supplies to a later binding, remains
// out of reach.
// 判断该词文本在给定求值类别下是否会让其中的字面展开真正执行：
// 算术求值会再次展开 name[subscript]，因此 (( ))、$(( ))、$[ ]、下标、${name:off:len}、let 操作数、
// [[ ]] 的算术操作数里的字面展开都能运行；绑定类内建会对带括号的操作数求其下标；
// 延迟绑定的值（赋值、数组元素、for 列表、here-string）只有当命令中出现变量汇时才会到达求值点。
// 命令替换的词视作其输出；仅运行时才进入算术的文本（环境变量、函数参数、后续绑定收到的输出）不可达
function bashEvaluatesExpansion(text: BashText, evaluation: BashEvaluation, context: BashContext) {
  // 字面文本与输出替身合并起来检查
  const combined = `${text.literal} ${text.output}`
  // 是否存在可执行展开特征
  const hasExpansion = BASH_EXPANSION_RE.test(combined)
  // Escapes reach the value through $'...' or a substitution's printf, echo -e, or tr.
  // 转义序列可经 $'...' 或替换输出（printf/echo -e/tr）到达值
  const hasEscape = BASH_ESCAPE_RE.test(combined)
  // 记录"被绑定文本含展开"特征（供 scan 末尾的动态执行判定）
  if (hasExpansion || hasEscape || /[$`]/.test(text.literal)) context.boundDollar = true
  // 记录"被绑定文本含可执行展开的开启"特征
  if (hasExpansion || hasEscape || /[({`]/.test(text.literal)) context.boundOpen = true
  // A substitution's output can hold `[` that the script never spells (printf '\x5b', tr, base64 -d).
  // 替换输出可能含有脚本没写出的 `[`（printf '\x5b'、tr、base64 -d 等）
  if (hasExpansion || hasEscape || text.output.trim() || combined.includes("[")) context.boundBracket = true
  // 延迟求值只登记特征，不立即判定
  if (evaluation === "deferred") return false
  // 求值汇一侧出现 `[`（下标会被再次求值）
  if (text.word.includes("[") || combined.includes("[")) context.sinkBracket = true
  // 判定是否存在变量汇：算术下出现标识符或 $；绑定时出现 $ 或方括号
  if (
    evaluation === "arithmetic"
      ? /[A-Za-z_]|(?:\$(?![?#!-]|\$(?!\[)))/.test(text.word)
      : text.word.includes("$") || combined.includes("[")
  )
    context.variableSink = true
  // 算术求值：存在展开特征即会执行
  if (evaluation === "arithmetic") return hasExpansion
  // 绑定求值：有括号且有展开才执行
  return combined.includes("[") && hasExpansion
}

// 构造一份空的词文本
function bashText(): BashText {
  return { word: "", literal: "", output: "" }
}

// Scans a subscript after its `[`; indexed arrays evaluate it as arithmetic.
// 扫描 `[` 之后的下标；索引数组的下标会按算术求值，其中的字面展开会执行
function scanBashSubscript(
  input: string,
  start: number,
  depth: number,
  context: BashContext,
  commands: Command[],
  span: BashSpan = BASH_SPANS.subscript,
  text = bashText(),
): number | Opaque {
  const end = scanBashSpan(input, start, depth, context, commands, span, false, text)
  if (typeof end === "number") {
    // 出现下标即记录 sinkBracket
    context.sinkBracket = true
    // 下标内的展开按算术求值会执行时，判为动态执行
    if (bashEvaluatesExpansion(text, "arithmetic", context)) return { kind: "opaque", reason: "dynamic-execution" }
  }
  return end
}

// Scans to the span's unnested close character and returns its index; a span without one runs to the end.
// 扫描到 span 的（未嵌套的）闭合字符并返回其下标；没有闭合符的 span 一直扫到结尾
function scanBashSpan(
  input: string,
  start: number,
  depth: number,
  context: BashContext,
  commands: Command[],
  span: BashSpan,
  allowBracket: boolean,
  text?: BashText,
): number | Opaque {
  // 嵌套深度计数
  let nesting = 0
  for (let index = start; index < input.length; index++) {
    if (--context.remaining < 0) return { kind: "opaque", reason: "invalid-structure" }
    const char = input[index]
    // 顶层遇到闭合符：span 结束
    if (char === span.close && !nesting) return index
    // A `#` after a digit is a base prefix, and after `$` the parameter $#.
    // 遇到拒绝字符即结构不合法；但数字/`$` 之后的 `#` 是进制前缀或 $# 参数，属例外
    if (span.reject.includes(char) && !(char === "#" && /[\d$]/.test(input[index - 1] ?? "")))
      return { kind: "opaque", reason: "invalid-structure" }
    // 开启符：嵌套加一，并与外部深度合并校验上限
    if (char === span.open && ++nesting + depth > MAX_SUBSTITUTION_DEPTH)
      return { kind: "opaque", reason: "invalid-structure" }
    // 嵌套内的闭合符只减计数
    if (char === span.close) nesting--
    // 开闭符本身不作为单元处理，其余字符交给单元扫描器
    const unit =
      char === span.open || char === span.close
        ? undefined
        : scanBashUnit(input, index, depth, context, commands, span.mode, allowBracket, text)
    if (typeof unit === "object") return unit
    if (unit !== undefined) index = unit
    // 转义的开/闭符按两个字面字符记入文本
    else if (char === "\\" && (input[index + 1] === span.open || input[index + 1] === span.close)) {
      if (text) bashAppend(text, input.slice(index, index + 2))
      index++
    } else if (text) bashAppend(text, char)
  }
  // 有闭合符却没等到：引号未闭合；无闭合符则到结尾为止
  return span.close ? { kind: "opaque", reason: "unterminated-quote" } : input.length
}

// Scans a nested list such as a command or process substitution and returns its closing index.
// 扫描一个嵌套列表（命令替换/进程替换等）并返回其闭合下标，命令并入外层
function scanBashNested(
  input: string,
  start: number,
  depth: number,
  context: BashContext,
  commands: Command[],
  close: ")" | "nofork",
  text?: BashText,
): number | Opaque {
  // 嵌套列表自带独立的 heredoc 队列
  const nested = scanBash(input, start, depth + 1, context, close, undefined, text)
  if (nested.kind === "opaque") return nested
  commands.push(...nested.commands)
  return nested.end
}

// Returns the first listed operator at index. Shells disagree about operators split by line continuations.
// 在下标处匹配 operators 中第一个命中的运算符；各 shell 对被续行拆开的运算符看法不一，
// 只有当源码中确实连续出现该运算符时才认可，否则视为结构不合法
function bashOperator(input: string, index: number, operators: string[]): string | Opaque | undefined {
  // 剥掉续行后收集最多 3 个字符用于匹配
  let text = ""
  for (let cursor = index; text.length < 3 && cursor < input.length; cursor++) {
    if (input.startsWith("\\\n", cursor)) cursor++
    else text += input[cursor]
  }
  const operator = operators.find((candidate) => text.startsWith(candidate))
  // 被续行拆开的运算符不合法
  if (operator && !input.startsWith(operator, index)) return { kind: "opaque", reason: "invalid-structure" }
  return operator
}

// 分发 $ 与反引号开头的各种替换/展开形式
function scanBashDollarOrBacktick(
  input: string,
  start: number,
  depth: number,
  context: BashContext,
  commands: Command[],
  // 是否处于引用（双引号/算术）上下文
  quoted: boolean,
  allowBracket: boolean,
  text?: BashText,
): number | Opaque {
  // 嵌套过深
  if (depth >= MAX_SUBSTITUTION_DEPTH) return { kind: "opaque", reason: "command-substitution" }
  // 反引号命令替换
  if (input[start] === "`") return scanBashBacktick(input, start, depth + 1, context, commands, quoted, text)
  // $((...)) 算术替换（若按 (( 失败则退回 $() 读法）
  if (input.startsWith("$((", start)) {
    const end = scanBashArithmetic(input, start + 3, depth + 1, context, commands, BASH_SPANS.arithmetic)
    if (end !== undefined) return end
  }
  // $(...) 命令替换
  if (input.startsWith("$(", start)) return scanBashNested(input, start + 2, depth, context, commands, ")", text)
  // ${ ...} / ${|...} 无 fork 形式
  const nofork = matchAt(NOFORK_OPEN_RE, input, start)
  if (nofork) return scanBashNested(input, start + nofork[0].length, depth, context, commands, "nofork", text)
  // ${...} 参数展开
  if (input.startsWith("${", start)) {
    // Literal text in parameter words reaches the enclosing word's value.
    // 参数词中的字面文本会到达外层词的值
    const parameter = bashText()
    const end = scanBashParameter(input, start + 2, depth + 1, context, commands, quoted, parameter)
    // ${!name} and Zsh ${(P)name} evaluate the subscript in the referenced name.
    // 间接展开 ${!name} 与 Zsh ${(P)name} 会对引用名里的下标再次求值
    const indirect =
      /^(?:\\\n)*!/.test(input.slice(start + 2)) ||
      (context.dialect !== "bash" &&
        input[start + 2] === "(" &&
        testAt(ZSH_SAFE_FLAGS_RE, input, start) &&
        input.slice(start + 3, ZSH_SAFE_FLAGS_RE.lastIndex - 1).replace(ZSH_QUOTED_FLAG_ARG_RE, "").includes("P"))
    if (indirect) {
      // 间接展开构成变量汇
      context.variableSink = true
      // 引用名的字面展开会执行时判为动态执行
      if (bashEvaluatesExpansion(parameter, "binding", context)) return { kind: "opaque", reason: "dynamic-execution" }
    }
    // 参数的字面文本并入外层
    if (text) {
      text.literal += parameter.literal
      text.output += parameter.output
    }
    return end
  }
  // Dash leaves `$[` literal, which splits words differently; Bash and Zsh always read arithmetic.
  // Dash 把 `$[` 按字面处理（拆词方式不同）；Bash/Zsh 总是按算术读。posix 且不允许时放弃
  if (!allowBracket && context.dialect === "posix") return { kind: "opaque", reason: "command-substitution" }
  // $[...] 旧式算术：扫描表达式并检查是否会让展开执行
  const expression = bashText()
  const end = scanBashSpan(
    input,
    start + 2,
    depth + 1,
    context,
    commands,
    BASH_SPANS.bracketArithmetic,
    true,
    expression,
  )
  if (typeof end === "number" && bashEvaluatesExpansion(expression, "arithmetic", context))
    return { kind: "opaque", reason: "dynamic-execution" }
  return end
}

// Scans the text of ((...)) after its opening parentheses. Returns undefined when the text closes with a single
// parenthesis, which makes it a nested subshell instead.
// 扫描 ((...)) 开括号之后的文本；若文本以单个 ) 收尾，说明它其实是嵌套子 shell，返回 undefined 交回调用者
function scanBashArithmetic(
  input: string,
  start: number,
  depth: number,
  context: BashContext,
  commands: Command[],
  span: BashSpan,
): number | Opaque | undefined {
  // 算术体内部的命令与文本
  const arithmetic: Command[] = []
  const text = bashText()
  const end = scanBashSpan(input, start, depth, context, arithmetic, span, true, text)
  if (typeof end === "object") return { kind: "opaque", reason: "invalid-structure" }
  // 结束处必须是 )) 才算算术
  const close = bashOperator(input, end, ["))"])
  if (typeof close === "object") return close
  // 单个 ) 收尾：交回调用者按嵌套子 shell 处理
  if (!close) return undefined
  // 算术文本中的字面展开会执行时判为动态执行
  if (bashEvaluatesExpansion(text, "arithmetic", context)) return { kind: "opaque", reason: "dynamic-execution" }
  commands.push(...arithmetic)
  return end + 1
}

// 扫描反引号命令替换 `...`
function scanBashBacktick(
  input: string,
  start: number,
  depth: number,
  context: BashContext,
  commands: Command[],
  quoted: boolean,
  text?: BashText,
): number | Opaque {
  // 反引号内的命令源码
  let source = ""
  for (let index = start + 1; index < input.length; index++) {
    if (--context.remaining < 0) return { kind: "opaque", reason: "invalid-structure" }
    // 闭合反引号：把收集到的源码当作一段完整命令重新扫描
    if (input[index] === "`") {
      const inner = scanBash(source, 0, depth, context, undefined, undefined, text)
      if (inner.kind === "opaque") return { kind: "opaque", reason: "command-substitution" }
      commands.push(...inner.commands)
      return index
    }
    const next = input[index + 1] ?? "\0"
    // 反引号内的转义：\$ \` \\ 与换行（引用上下文还包括 \"）
    if (input[index] === "\\" && ("$`\\\n".includes(next) || (quoted && next === '"'))) {
      index++
      // 续行不产生内容
      if (next !== "\n") source += next
      continue
    }
    source += input[index]
  }
  // 没等到闭合反引号
  return { kind: "opaque", reason: "command-substitution" }
}

// 扫描 ${...} 参数展开的内容，直到其闭合 }
function scanBashParameter(
  input: string,
  start: number,
  depth: number,
  context: BashContext,
  commands: Command[],
  // 是否处于引用上下文（双引号内）
  quoted: boolean,
  text: BashText,
): number | Opaque {
  // 跳过旗标/取反等前缀，定位名字起点
  const nameStart = matchAt(PARAMETER_PREFIX_RE, input, start) ? PARAMETER_PREFIX_RE.lastIndex : start
  // The operands of ${name:offset:length} are arithmetic, and ${name:=word} or ${name=word} binds a variable.
  // ${name:offset:length} 的操作数按算术求值；${name:=word} / ${name=word} 会绑定变量
  let colon = testAt(PARAMETER_NAME_RE, input, nameStart) ? PARAMETER_NAME_RE.lastIndex : -1
  // 名字文本（去掉续行）
  const name = colon > nameStart ? input.slice(nameStart, colon).replace(/\\\n/g, "") : ""
  // 非 Bash：NULLCMD 或对特殊数组/选项参数的下标/赋值会触发动态执行
  if (
    context.dialect !== "bash" &&
    (/^(?:READ)?NULLCMD$/.test(name) ||
      (/^(?:(?:dis_)?(?:functions|[gs]?aliases)|options|commands)$/.test(name) && "[=:".includes(input[colon] ?? "")))
  )
    return { kind: "opaque", reason: "dynamic-execution" }
  // PS4 的值会被 shell 当代码求值
  if (name === "PS4") context.evalSink = true
  // 冒号之后的求值类别（算术/延迟）
  let evaluation: BashEvaluation | undefined
  // 求值部分在熟文本中的起点
  let wordOffset = 0
  let literalOffset = 0
  // 逐字符扫描参数体
  for (let index = start; index < input.length; index++) {
    if (--context.remaining < 0) return { kind: "opaque", reason: "invalid-structure" }
    const char = input[index]
    // 闭合 }：检查求值部分的展开是否可达并返回
    if (char === "}") {
      if (
        evaluation &&
        bashEvaluatesExpansion(
          { word: text.word.slice(wordOffset), literal: text.literal.slice(literalOffset), output: text.output },
          evaluation,
          context,
        )
      )
        return { kind: "opaque", reason: "dynamic-execution" }
      return index
    }
    // 到达名字结束处：根据后续字符判定操作数性质
    if (index === colon && !evaluation) {
      // ${name:offset} 形式按算术求值
      if (char === ":" && !"-=?+".includes(input[index + 1] ?? "")) evaluation = "arithmetic"
      // ${name=word} / ${name:=word} 绑定变量
      if (char === "=" || (char === ":" && input[index + 1] === "=")) evaluation = "deferred"
      if (evaluation) {
        wordOffset = text.word.length
        literalOffset = text.literal.length
      }
    }
    // Bash ${name@P} evaluates the value as prompt text.
    // ${name@P} / ${name@E} 会把值当提示符/转义文本求值
    if (char === "@") {
      if (testAt(PARAMETER_PROMPT_RE, input, index)) return { kind: "opaque", reason: "dynamic-execution" }
    }
    // Zsh globs an unquoted parameter's words, where a parenthesized group can be a glob qualifier.
    // 未引用参数的词会被 Zsh 通配，括号组可能是可执行代码的通配限定符
    if (!quoted && context.dialect !== "bash" && char === "(" && index > start)
      return { kind: "opaque", reason: "dynamic-execution" }
    // 双引号内 $'...'：解码 ANSI-C 转义并入字面文本
    if (quoted && char === "'" && input[index - 1] === "$") {
      const ansi = bashAnsiQuote(input, index)
      if (!ansi) return { kind: "opaque", reason: "unterminated-quote" }
      text.literal += ansi.value
    }
    // 名字结束处的 [ 是下标
    const subscript = index === colon && char === "["
    // 按位置选择扫描方式：下标 / 引号内的单双引号 / 普通单元
    const unit = subscript
      ? scanBashSubscript(input, index + 1, depth, context, commands)
      : quoted && char === "'"
        ? scanBashSpan(input, index + 1, depth, context, commands, BASH_SPANS.parameterQuote, false, text)
        : quoted && char === '"'
          ? scanBashSpan(input, index + 1, depth, context, commands, BASH_SPANS.double, false, text)
          : scanBashUnit(input, index, depth, context, commands, quoted ? "quoted" : "word", false, text)
    if (typeof unit === "object") return unit
    // Bash 3.2 ends a double-quoted parameter at an unquoted `}` inside `$(...)`.
    // Bash 3.2 会在 $(...) 内的未引用 } 处结束双引号参数，产生歧义时放弃
    if (quoted && unit !== undefined && input.startsWith("$(", index) && input.slice(index, unit + 1).includes("}"))
      return { kind: "opaque", reason: "command-substitution" }
    // 下标结束或嵌套 ${} 结束后，重新定位冒号（其后才是操作数）
    if (subscript || (index === nameStart && input.startsWith("${", index) && unit !== undefined)) {
      colon = matchAt(LINE_CONTINUATION_RE, input, Number(unit) + 1) ? LINE_CONTINUATION_RE.lastIndex : Number(unit) + 1
    }
    if (unit !== undefined) index = unit
    else bashAppend(text, char)
  }
  // 没等到闭合 }
  return { kind: "opaque", reason: "command-substitution" }
}

// 扫描 [[ ]] 条件命令的内容
function scanBashConditional(
  input: string,
  start: number,
  depth: number,
  context: BashContext,
  commands: Command[],
): number | Opaque {
  // 已完成的词（含其文本三类）
  const words: BashText[] = []
  // 当前正在累积的词
  let text = bashText()
  let wordStarted = false
  let hasWord = false
  // 普通括号深度与模式括号深度
  let parenDepth = 0
  let patternParenDepth = 0
  // 把当前词推入词表
  const flushWord = () => {
    if (!hasWord) return
    words.push(text)
    text = bashText()
    hasWord = false
  }
  // 逐字符扫描
  for (let index = start; index < input.length; index++) {
    if (--context.remaining < 0) return { kind: "opaque", reason: "invalid-structure" }
    const char = input[index]
    // 续行跳过
    if (char === "\\" && input[index + 1] === "\n") {
      index++
      continue
    }
    // 词结束时先收尾
    if (!wordStarted) flushWord()
    // 词外遇到 ]：尝试匹配 ]] 闭合
    const close = !wordStarted && char === "]" ? bashOperator(input, index, ["]]"]) : undefined
    if (typeof close === "object") return close
    if (close) {
      // ]] 之后必须是分隔符/结尾才算闭合
      if (testAt(BRACE_CLOSE_AHEAD_RE, input, index + 2)) {
        // 括号不配对
        if (parenDepth !== 0) return { kind: "opaque", reason: "invalid-structure" }
        // -v names a variable, -t in Zsh evaluates the descriptor, and arithmetic comparisons evaluate both operands.
        // -v 引用变量名；Zsh 的 -t 按算术求值描述符；算术比较运算符两侧操作数都按算术求值
        const evaluated = words.some(
          (word, at) =>
            (words[at - 1]?.word === "-v" && bashEvaluatesExpansion(word, "binding", context)) ||
            (((context.dialect !== "bash" && words[at - 1]?.word === "-t") ||
              BASH_ARITHMETIC_COMPARISONS.has(words[at - 1]?.word ?? "") ||
              BASH_ARITHMETIC_COMPARISONS.has(words[at + 1]?.word ?? "")) &&
              bashEvaluatesExpansion(word, "arithmetic", context)),
        )
        // 会执行的展开判为动态执行
        if (evaluated) return { kind: "opaque", reason: "dynamic-execution" }
        return index + 1
      }
    }
    // 词外注释跳到行尾
    if (!wordStarted && char === "#") {
      const newline = input.indexOf("\n", index)
      if (newline < 0) return { kind: "opaque", reason: "invalid-structure" }
      index = newline
      continue
    }
    // 空白结束当前词（模式括号内不结束）
    if (char === " " || char === "\t" || char === "\n") {
      if (!patternParenDepth) wordStarted = false
      continue
    }
    // [[ ]] 内不允许 ;
    if (char === ";") return { kind: "opaque", reason: "invalid-structure" }
    // 括号：要么属于模式（如 =(x)），要么是独立的词
    if (char === "(" || char === ")") {
      if (char === ")" && parenDepth === 0) return { kind: "opaque", reason: "invalid-structure" }
      // 比较运算符之后的括号组是模式（=~ 的右侧等）
      const inPattern =
        patternParenDepth > 0 || (char === "(" && ["=", "==", "!=", "=~"].includes(words.at(-1)?.word ?? ""))
      parenDepth += char === "(" ? 1 : -1
      if (inPattern) {
        patternParenDepth += char === "(" ? 1 : -1
        wordStarted = true
        hasWord = true
        bashAppend(text, char)
        continue
      }
      // 结构括号作为独立词记录
      flushWord()
      words.push({ word: char, literal: "", output: "" })
      wordStarted = false
      continue
    }
    // 引号/展开单元
    const unit = scanBashUnit(input, index, depth, context, commands, "word", true, text)
    if (typeof unit === "object") return unit
    if (unit !== undefined) index = unit
    // 词外的 & | < > 是 [[ ]] 的结构字符
    if (unit === undefined && !patternParenDepth && "&|<>".includes(char)) {
      flushWord()
      words.push({ word: char, literal: "", output: "" })
      wordStarted = false
      continue
    }
    // 普通字符累积
    wordStarted = true
    hasWord = true
    if (unit === undefined) bashAppend(text, char)
  }
  // 没等到 ]]
  return { kind: "opaque", reason: "invalid-structure" }
}

// 扫描数组字面量 (a b c) 或通配模式分组（*(a|b) 等），返回闭合 ) 的下标
function scanBashArrayOrPattern(
  input: string,
  start: number,
  depth: number,
  context: BashContext,
  commands: Command[],
  mode: "array" | "pattern",
): number | Opaque {
  if (depth > MAX_SUBSTITUTION_DEPTH) return { kind: "opaque", reason: "command-substitution" }
  // Array elements bind variables, so their decoded text is a subscript sink.
  // 数组元素会绑定到变量，其解码文本是下标汇；模式不需要文本收集
  const text = mode === "array" ? bashText() : undefined
  let wordStarted = false
  // 逐字符扫描
  for (let index = start + 1; index < input.length; index++) {
    if (--context.remaining < 0) return { kind: "opaque", reason: "invalid-structure" }
    const char = input[index]
    // 续行跳过
    if (char === "\\" && input[index + 1] === "\n") {
      index++
      continue
    }
    // 每个元素结束时按"延迟求值"登记其文本特征，随后清空（各元素独立）
    if (text && (char === ")" || char === " " || char === "\t" || char === "\n")) {
      bashEvaluatesExpansion(text, "deferred", context)
      text.literal = ""
      text.output = ""
    }
    // 闭合括号：结束
    if (char === ")") return index
    // 数组中的词外注释跳到行尾
    if (mode === "array" && !wordStarted && char === "#") {
      const newline = input.indexOf("\n", index)
      if (newline < 0) return { kind: "opaque", reason: "command-substitution" }
      index = newline
      continue
    }
    // 空白分隔元素（数组内换行也是分隔符）
    if (char === " " || char === "\t" || (mode === "array" && char === "\n")) {
      wordStarted = false
      continue
    }
    // Zsh 数组元素词尾的安全通配限定符按字面并入
    if (
      mode === "array" &&
      wordStarted &&
      char === "(" &&
      context.dialect === "zsh" &&
      testAt(ZSH_GLOB_QUALIFIER_RE, input, index)
    ) {
      const end = ZSH_GLOB_QUALIFIER_RE.lastIndex - 1
      if (text) text.literal += input.slice(index, end + 1)
      index = end
      continue
    }
    // Array elements are globbed, where a parenthesized group can be a Zsh glob qualifier.
    // 数组元素会被通配，换行/;/& 以及数组内的 | ( 都可能引入不可分析的限定符
    if (char === "\n" || char === ";" || char === "&" || (mode === "array" && "|(".includes(char)))
      return { kind: "opaque", reason: "command-substitution" }
    wordStarted = true
    // 元素内容：=(...) 嵌套 / 嵌套模式分组 / 下标 / 普通单元
    const unit =
      mode === "array" && char === "=" && input[index + 1] === "("
        ? scanBashNested(input, index + 2, depth, context, commands, ")")
        : char === "("
          ? scanBashArrayOrPattern(input, index, depth + 1, context, commands, mode)
          : char === "["
            ? scanBashSubscript(input, index + 1, depth, context, commands)
            : scanBashUnit(input, index, depth, context, commands, "word", false, text)
    if (typeof unit === "object") return unit
    if (unit !== undefined) index = unit
    else if (text) text.literal += char
  }
  // 没等到闭合 )
  return { kind: "opaque", reason: "command-substitution" }
}

// 解码 ANSI-C 引号 $'...' 的内容，返回解码值与闭引号下标；不完整/非法转义返回 undefined
function bashAnsiQuote(input: string, start: number, allowUnicode = true) {
  let value = ""
  for (let index = start + 1; index < input.length; index++) {
    // 闭引号：结束
    if (input[index] === "'") return { value, end: index }
    // 普通字符直接累积
    if (input[index] !== "\\") {
      value += input[index]
      continue
    }
    // 反斜杠后的转义字符
    const escaped = input[++index]
    if (escaped === undefined) return
    // 简单转义（\n \t 等）查表
    if (escaped in BASH_ANSI_ESCAPES) {
      value += BASH_ANSI_ESCAPES[escaped]
      continue
    }
    // 数字转义：\x 十六进制 / \u \U Unicode / 八进制
    const digits =
      escaped === "x"
        ? /^[\da-fA-F]{1,2}/.exec(input.slice(index + 1, index + 3))?.[0]
        : allowUnicode && escaped === "u"
          ? /^[\da-fA-F]{1,4}/.exec(input.slice(index + 1, index + 5))?.[0]
          : allowUnicode && escaped === "U"
            ? /^[\da-fA-F]{1,8}/.exec(input.slice(index + 1, index + 9))?.[0]
            : /[0-7]/.test(escaped)
              ? /^[0-7]{1,3}/.exec(input.slice(index, index + 3))?.[0]
              : undefined
    // 无法识别的转义序列
    if (!digits) return
    const octal = /[0-7]/.test(escaped)
    const point = parseInt(digits, octal ? 8 : 16)
    // 拒绝 NUL、超范围与代理区码点
    if (point === 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) return
    value += String.fromCodePoint(point)
    index += digits.length - (octal ? 1 : 0)
  }
}

// 解析 heredoc 的结束分隔符（<< 或 <<- 之后的词），返回分隔符描述
function bashHeredocDelimiter(input: string, start: number, tabs: boolean) {
  // 解码后的分隔符
  let delimiter = ""
  // Dash 风格的原始分隔符（保留 $ 的版本）
  let dashDelimiter: string | undefined
  // 分隔符是否带引号/转义（带则正文不做展开）
  let quoted = false
  // 当前引号上下文
  let quote: "'" | '"' | undefined
  // 分隔符在源码中的结束下标
  let end = start
  // 是否已开始收集
  let started = false
  for (let index = start; index < input.length; index++) {
    const char = input[index]
    // 开始前的空白跳过
    if (!started && /[ \t]/.test(char)) continue
    // 词前注释：此处没有分隔符
    if (!started && char === "#") return
    // 未引用时遇到分隔/运算字符即结束
    if (!quote && /[ \t\n;&|()<>]/.test(char))
      return started ? { delimiter, dashDelimiter, quoted, tabs, end } : undefined
    // $ 后接续行：形态不明，放弃
    if (!quote && char === "$" && input.startsWith("\\\n", index + 1)) return
    // Dash retains $ in $'...' heredoc delimiters while Bash and Zsh strip $.
    // $'...' 分隔符：Dash 保留 $ 而 Bash/Zsh 去掉 $，需同时记录两种读法
    if (!quote && input.startsWith("$'", index)) {
      const literal = bashAnsiQuote(input, index + 1, false)
      if (!literal || literal.end !== input.indexOf("'", index + 2)) return
      dashDelimiter = `${dashDelimiter ?? delimiter}$${input.slice(index + 2, literal.end)}`
      delimiter += literal.value
      quoted = true
      started = true
      index = literal.end
      end = index
      continue
    }
    // Bash strips $ from $"..." heredoc delimiters while Zsh and Dash retain $.
    // $"..." 分隔符各 shell 解释分歧，直接放弃
    if (!quote && input.startsWith('$"', index)) return
    // 闭引号
    if (char === quote) {
      quote = undefined
      end = index
      continue
    }
    // 引号外的反斜杠转义（单引号内反斜杠是字面）
    if (char === "\\" && quote !== "'") {
      const next = input[index + 1]
      if (next === undefined) return
      // 续行跳过
      if (next === "\n") {
        index++
        continue
      }
      // Double quotes only remove escapes for shell-special characters.
      // 未引用时转义任意字符；双引号内只移除 shell 特殊字符的转义
      if (!quote || '$`"\\'.includes(next)) {
        quoted = true
        started = true
        const escaped = input[++index]
        if (dashDelimiter !== undefined) dashDelimiter += escaped
        delimiter += escaped
        end = index
        continue
      }
    }
    // 引号开启
    if (!quote && (char === "'" || char === '"')) {
      quote = char
      quoted = true
      started = true
      end = index
      continue
    }
    // 普通字符累积（同时维护 Dash 版本）
    if (dashDelimiter !== undefined) dashDelimiter += char
    delimiter += char
    started = true
    end = index
  }
  // 到输入结束：只有已开始且引号闭合才有效
  if (started && !quote) return { delimiter, dashDelimiter, quoted, tabs, end }
}

// 定位 heredoc 正文：从 start 行开始找到分隔符所在行，返回正文与结束下标
function bashHeredoc(
  input: string,
  start: number,
  delimiter: { delimiter: string; dashDelimiter?: string; tabs: boolean; quoted: boolean },
) {
  // 正文起点（首行）
  const bodyStart = start
  // 分隔符行的行首
  let lineStart = start
  // 已拼接的（可能跨续行的）当前行
  let line = ""
  // Backslashes ending the joined line; an odd count continues it.
  // 拼接行末尾的反斜杠数量；奇数个说明该行继续
  let backslashes = 0
  // 逐行扫描（index 指向换行或输入末尾）
  for (let index = start; index <= input.length; index++) {
    if (index < input.length && input[index] !== "\n") continue
    // 本行文本（<<- 且是首行时去掉前导制表符）
    const text =
      delimiter.tabs && start === lineStart ? input.slice(start, index).replace(/^\t+/, "") : input.slice(start, index)
    // 统计行尾连续反斜杠
    let run = 0
    while (text[text.length - 1 - run] === "\\") run++
    backslashes = run === text.length ? backslashes + run : run
    // 未引用分隔符且反斜杠为奇数：该行与下一行拼接
    const continued = !delimiter.quoted && backslashes % 2 === 1 && index < input.length
    const maxLength = Math.max(delimiter.delimiter.length, delimiter.dashDelimiter?.length ?? 0)
    // Joined lines only grow, so text past the delimiter's length cannot change the comparison.
    // 拼接行只增不减，超过分隔符长度后无需再比较
    if (line.length <= maxLength) line += continued ? text.slice(0, -1) : text
    if (continued) {
      backslashes--
      start = index + 1
      continue
    }
    // Dash 读法先命中（保留 $ 的分隔符）
    if (delimiter.dashDelimiter !== undefined && line === delimiter.dashDelimiter) return
    // 匹配到分隔符行
    if (line === delimiter.delimiter) {
      // Dash does not join backslash-continued delimiter lines; fail closed if a physical delimiter follows.
      // Dash 不拼接续行；若其后还存在物理分隔符行（读法分歧）则放弃
      if (start > lineStart && input.slice(index + 1).includes(delimiter.delimiter)) return
      return { source: input.slice(bodyStart, lineStart), end: index }
    }
    // 普通行：重置行状态
    line = ""
    backslashes = 0
    start = index + 1
    lineStart = start
  }
}

// PowerShell 扫描入口：返回扫描结果
export function scanPowerShell(input: string): Result {
  // 超长输入直接放弃
  if (input.length > MAX_INPUT_LENGTH) return { kind: "opaque", reason: "invalid-structure" }
  // PowerShell's Unicode quotes, dashes, and whitespace differ from JavaScript's token rules.
  // PowerShell 的 Unicode 引号/连字符/空白与 JavaScript 词法不同，出现即放弃
  if (/[\0\u0085\u2013-\u2015\u2018-\u201e\ufeff]/.test(input)) return { kind: "opaque", reason: "invalid-structure" }
  // 从头扫描整段
  const result = scanPowerShellList(input, 0, 0, { remaining: MAX_INPUT_LENGTH * MAX_SUBSTITUTION_DEPTH })
  if (result.kind === "opaque") return result
  return { kind: "scanned", commands: result.commands }
}

// PowerShell 子句类型：成员链、语句块、if/try/clause/switch/paren/do 各控制结构
type PowerShellClause = "member" | "block" | "if" | "try" | "clause" | "switch" | "paren" | "do" | undefined

// PowerShell 列表扫描器：扫描一段（或一层嵌套）语句
function scanPowerShellList(
  input: string,
  start: number,
  depth: number,
  budget: { remaining: number },
  // 本层期待的闭合符
  close?: ")" | "}" | "]",
  // hash：本层内容形态（true=纯表达式组；"clause"/"switch"=成员/分支组）
  hash: boolean | "clause" | "switch" = false,
  // skipped：因 $"..." 歧义而需要跳过的下标集合
  skipped?: ReadonlySet<number>,
): BashResult {
  if (depth >= MAX_SUBSTITUTION_DEPTH || budget.remaining < 0) return { kind: "opaque", reason: "invalid-structure" }
  // 本层产出的命令
  const commands: Command[] = []
  // 嵌套结构中先收集的命令
  const nestedCommands: Command[] = []
  // 当前命令的词
  const words: string[] = []
  const rawWords: string[] = []
  // 各词的源码结束下标
  const wordEnds: number[] = []
  // 本层初始是否处于表达式模式（如 ${...} 或类定义体）
  const initialExpression = hash === true || hash === "clause"
  // 本层初始子句（switch/clause 组内是成员访问）
  const initialClause: PowerShellClause = hash === "clause" || hash === "switch" ? "member" : undefined
  // 当前命令的源码起点
  let segment = start
  // 当前累积的词
  let word = ""
  let started = false
  let wordStart = start
  // 当前引号上下文
  let quote: "'" | '"' | undefined
  // 当前引号串是否为独立词（自成一个参数）
  let standalone = false
  let expression = initialExpression
  let clause: PowerShellClause = initialClause
  // 刚结束的控制结构（用于识别 until/else/catch 等）
  let after: "do" | "if" | "try" | undefined
  // 成员链状态：可索引形态（变量/已闭合/成员访问中）
  let indexable: false | "variable" | "closed" | "member" = false
  // 成员链的源码起点（方法调用时用）
  let memberChainStart: number | undefined
  // 链上是否出现过成员访问
  let hasMemberAccess = false
  let hasFileRedirect = false
  // 是否已遇到 --% 停止解析标记
  let stopParsing = false
  // 当前命令的结束位置
  let commandEnd = start
  // 是否处于语句头（用于 foreach 块判定）
  let statementHead = true
  let invalid = false
  let redirectTarget = false
  let dangling = false
  // 是否处于 & 或 . 的调用形式
  let invocation = false

  // 上一个词（含正在累积的）
  const previousWord = () => (started ? word : (words.at(-1) ?? ""))
  // 上一个词是否以成员运算符 . 或 : 结尾
  const afterMemberOperator = () => indexable === "member" && /[.:]$/.test(previousWord())
  // 重置成员链状态
  const resetMember = () => {
    indexable = false
    memberChainStart = undefined
    hasMemberAccess = false
  }
  // 收尾当前词：归档或处理 --%
  const finishWord = (end: number) => {
    if (!started) return
    // Generic tokens can spell stop-parsing with escapes or embedded quotes; literal strings cannot.
    // --% 只在普通词元位置生效（不能来自引号串，也不在表达式/重定向/参数冒号后）
    if (
      word === "--%" &&
      words.length > 0 &&
      !expression &&
      !clause &&
      !redirectTarget &&
      !/['"]/.test(input[wordStart]) &&
      !rawWords.at(-1)?.endsWith(",") &&
      !POWERSHELL_PARAMETER_COLON_RE.test(rawWords.at(-1) ?? "")
    )
      stopParsing = true
    // 非重定向目标才归档为词
    if (!redirectTarget) {
      // 命令的第一个词决定资源起点
      if (!words.length && !invocation) segment = wordStart
      words.push(word)
      rawWords.push(input.slice(wordStart, end))
      wordEnds.push(end)
      dangling = false
    }
    commandEnd = end
    redirectTarget = false
    word = ""
    started = false
  }
  // 结束当前命令：生成 Command 或标记不合法，并重置命令级状态
  const finishCommand = (end: number, required = false) => {
    finishWord(end)
    // 有词且（非表达式/子句模式，或含文件重定向）才生成命令
    if (words.length && ((!expression && !clause) || hasFileRedirect))
      commands.push({
        resource: input.slice(segment, commandEnd).trimEnd(),
        words: [...words],
        rawWords: [...rawWords],
        wordEnds: wordEnds.map((value) => value - segment),
        ...(statementHead && !invocation && !expression && !clause ? { statementHead: true as const } : {}),
      })
    else if (
      // 纯调用形式（& xxx）必须有词；required 时不能为空；子句不能悬空
      (!expression && !clause && invocation) ||
      (required && !words.length && !nestedCommands.length) ||
      (clause !== undefined && clause !== "member")
    )
      invalid = true
    if (redirectTarget) invalid = true
    // 并入嵌套命令
    commands.push(...nestedCommands.splice(0))
    // 重置命令级状态
    words.length = 0
    rawWords.length = 0
    wordEnds.length = 0
    redirectTarget = false
    hasFileRedirect = false
    invocation = false
    expression = initialExpression
    clause = initialClause
    after = undefined
    resetMember()
    stopParsing = false
  }

  // 主循环
  let index = start
  for (; index < input.length; index++) {
    // 每字符消耗预算
    if (--budget.remaining < 0) return { kind: "opaque", reason: "invalid-structure" }
    // $"..." 歧义时跳过预设下标
    if (skipped?.has(index)) continue
    const char = input[index]
    // 是否处于表达式上下文
    const inExpression = expression && !redirectTarget
    // 词边界：尚未开始，或（非表达式时）上一词以逗号结束（逗号后是新参数）
    const atBoundary = !started || (!inExpression && word.endsWith(","))
    if (!started) wordStart = index
    // --% 之后按字面读到一个整段
    if (stopParsing) {
      const stop = powerShellStopParsing(input, index, skipped)
      const text = input.slice(index, stop).trim()
      if (text) {
        wordStart = index + input.slice(index, stop).search(/\S/)
        word = text
        started = true
        finishWord(wordStart + text.length)
      }
      stopParsing = false
      index = stop - 1
      continue
    }
    // 引号串内部
    if (quote) {
      let nextQuote = index + 1
      while (skipped?.has(nextQuote)) nextQuote++
      // 双写引号表示字面引号
      if (char === quote && input[nextQuote] === quote) {
        word += quote
        index = nextQuote
      } else if (char === quote) {
        // 闭引号
        quote = undefined
        if (standalone) {
          finishWord(index + 1)
          indexable = "closed"
        }
      } else if (quote === '"' && char === "`") {
        // 双引号内的反引号转义
        const escape = powerShellEscape(input, index, false, skipped)
        if (!escape) return { kind: "opaque", reason: "unterminated-escape" }
        word += escape.value
        index = escape.end
      } else if (quote === '"' && char === "$" && input[index + 1] === "{") {
        // 双引号内的 ${...} 变量
        const end = powerShellBracedVariable(input, index, skipped)
        if (end === undefined) return { kind: "opaque", reason: "invalid-structure" }
        word += input.slice(index, end + 1)
        index = end
      } else if (quote === '"' && char === "$" && input[index + 1] === "(") {
        // 双引号内的 $(...) 子表达式：扫描其内部命令
        const sub = powerShellSubExpression(input, index + 2, false, budget, skipped)
        if (!sub) return { kind: "opaque", reason: "invalid-structure" }
        const result = scanPowerShellList(input, index + 2, depth + 1, budget, ")", false, sub.skipped)
        if (result.kind === "opaque") return result
        nestedCommands.push(...result.commands)
        const end = sub.rawEnd !== undefined && sub.rawEnd > result.end ? sub.rawEnd : result.end
        word += input.slice(index, end + 1)
        index = end
      } else word += char
      continue
    }
    // 引号开启
    if (char === "'" || char === '"') {
      // 空位上的引号串使本段成为表达式
      if (!started && words.length === 0 && !invocation) expression = true
      quote = char
      const dynamicMember = afterMemberOperator()
      // 独立词判定
      standalone = atBoundary || (expression && !redirectTarget) || dynamicMember
      if (dynamicMember) hasMemberAccess = true
      else if (standalone) {
        memberChainStart = index
        hasMemberAccess = false
      } else resetMember()
      started = true
      continue
    }
    // 反引号转义（含行尾续行）
    if (char === "`") {
      const escape = powerShellEscape(input, index, atBoundary || inExpression, skipped)
      if (!escape) return { kind: "opaque", reason: "unterminated-escape" }
      const rawSpace = /\s/.test(input[index + 1] ?? "")
      // 表达式/词中转义的空白结束当前词
      if ((inExpression || atBoundary) && started && rawSpace) finishWord(index)
      // At a token boundary escaped whitespace is trivia, not a new argument.
      // 词边界处转义的空白只是噪音，不构成新参数
      else if (!atBoundary || !rawSpace) {
        started = true
        if (!(indexable === "member" && /[\p{L}\p{Nl}\d_]/u.test(escape.value))) resetMember()
        word += escape.value
      }
      index = escape.end
      continue
    }
    // 参数之后的 --%：开启停止解析模式
    if (
      !started &&
      words.length > 0 &&
      !expression &&
      !clause &&
      !redirectTarget &&
      testAt(POWERSHELL_STOP_PARSING_RE, input, index)
    ) {
      word = "--%"
      started = true
      finishWord(index + 3)
      index += 2
      continue
    }
    // 块注释 <# ... #>
    if (char === "<" && input[index + 1] === "#" && (atBoundary || inExpression || indexable === "member")) {
      const memberOperator = afterMemberOperator()
      if (started) finishWord(index)
      // 找到注释结束
      const end = input.indexOf("#>", index + 2)
      if (end < 0) return { kind: "opaque", reason: "invalid-structure" }
      if (!memberOperator) resetMember()
      index = end + 1
      continue
    }
    // 行注释 # ...（成员链或 ] 上下文内的 # 可能是类型字面量的一部分，需排除）
    if (
      char === "#" &&
      (atBoundary ||
        indexable === "member" ||
        (inExpression && !(close === "]" && /^[\p{L}\p{Nl}_][\p{L}\p{Nl}\d_.#+`\\]*$/u.test(word))))
    ) {
      const prev = previousWord()
      const memberOperator = afterMemberOperator()
      // 子句中、逗号后或成员链上的 # 先收词；否则结束整条命令
      if ((clause && clause !== "member") || prev.endsWith(",") || memberOperator) finishWord(index)
      else if (words.length || started || invocation) finishCommand(index)
      // 注释新起一条语句
      statementHead = !dangling
      // 找最近的换行（\n 或 \r）
      const endings = [input.indexOf("\n", index), input.indexOf("\r", index)].filter((ending) => ending >= 0)
      const newline = endings.length > 0 ? Math.min(...endings) : -1
      if (newline === -1) {
        index = input.length
        break
      }
      // \r\n 一起跳过
      index = input[newline] === "\r" && input[newline + 1] === "\n" ? newline + 1 : newline
      continue
    }
    // 表达式中的 > 或 *>（如流比较/重定向形态）结束当前词
    if (inExpression && started && (char === ">" || (char === "*" && input[index + 1] === ">"))) finishWord(index)
    // 尝试识别重定向运算符（>、*>、数字、n>& 等）
    const redirect =
      !started &&
      (char === ">" ||
        char === "*" ||
        (/\d/.test(char) && (words.length > 0 || testAt(POWERSHELL_MERGE_REDIRECT_RE, input, index))))
        ? powerShellRedirect(input, index)
        : undefined
    if (redirect === false) return { kind: "opaque", reason: "invalid-redirect" }
    if (redirect) {
      // 重定向必须跟在有命令之后
      if (redirectTarget || words.length === 0 || (clause && clause !== "member"))
        return { kind: "opaque", reason: "invalid-redirect" }
      // 含 & 的是流合并，否则下一个词是重定向目标
      redirectTarget = !redirect.includes("&")
      if (redirectTarget) hasFileRedirect = true
      resetMember()
      index += redirect.length - 1
      commandEnd = index + 1
      continue
    }
    // 语句开始处的 : 标签（label: while/for/...）
    if (!started && !words.length && !invocation && !expression && !clause && char === ":") {
      const label = matchAt(POWERSHELL_LABEL_RE, input, index)
      if (label) {
        index += label[0].length - 1
        continue
      }
    }
    // 控制流关键字识别（param/foreach/if/try/... ；词表中仅允许 param/class/enum）
    if (
      !started &&
      !invocation &&
      !clause &&
      (!words.length ? !expression : words.every((item) => item.startsWith("["))) &&
      /[A-Za-z]/.test(char)
    ) {
      const keyword = matchAt(POWERSHELL_KEYWORD_RE, input, index)?.[0]?.toLowerCase()
      if (
        keyword &&
        (words.length > 0
          ? (keyword === "param" && testAt(POWERSHELL_PARAM_RE, input, index)) ||
            keyword === "class" ||
            keyword === "enum"
          : (keyword === "param" && testAt(POWERSHELL_PARAM_RE, input, index)) ||
            (keyword === "foreach" && testAt(POWERSHELL_FOREACH_RE, input, index)) ||
            (keyword === "until" && after === "do") ||
            ((keyword === "else" || keyword === "elseif") && after === "if") ||
            ((keyword === "catch" || keyword === "finally") && after === "try") ||
            /^(?:if|for|while|do|switch|function|filter|workflow|parallel|sequence|configuration|try|begin|process|end|clean|trap|class|enum|data|dynamicparam|using|break|continue)$/.test(
              keyword,
            ))
      ) {
        // class/enum/break/continue 体是表达式形态
        expression = /^(?:class|enum|break|continue)$/.test(keyword)
        // 按关键字设定子句类型
        clause =
          keyword === "using" || keyword === "break" || keyword === "continue"
            ? "member"
            : keyword === "param" || keyword === "until" || (keyword === "while" && after === "do")
              ? "paren"
              : keyword === "do"
                ? "do"
                : keyword === "if" || keyword === "elseif"
                  ? "if"
                  : keyword === "try" || keyword === "catch"
                    ? "try"
                    : keyword === "switch"
                      ? "switch"
                      : keyword === "class" || keyword === "enum"
                        ? "clause"
                        : "block"
        after = undefined
        index += keyword.length - 1
        continue
      }
      // return/throw/exit 不是子句，只跳过
      if (!words.length && keyword && /^(?:return|throw|exit)$/.test(keyword)) {
        after = undefined
        index += keyword.length - 1
        continue
      }
    }
    // 表达式内的赋值/复合赋值（= += -= 等），或 do 循环的 in：重置当前积累
    const assign = inExpression && !clause && (char === "=" || (/[-+*/%]/.test(char) && input[index + 1] === "="))
    if (assign || (inExpression && close === ")" && !started && testAt(POWERSHELL_IN_RE, input, index))) {
      if (assign) finishWord(index)
      words.length = 0
      rawWords.length = 0
      wordEnds.length = 0
      expression = false
      hasFileRedirect = false
      resetMember()
      if (!assign || char !== "=") index++
      continue
    }
    // 孤立的 @（不是展开开头）不合法
    if (atBoundary && char === "@" && !testAt(POWERSHELL_AT_OPENER_RE, input, index + 1))
      return { kind: "opaque", reason: "invalid-structure" }
    // @'...' / @"..." here-string：读取正文并作为独立词
    if (atBoundary && char === "@" && (input[index + 1] === "'" || input[index + 1] === '"')) {
      if (started) finishWord(index)
      wordStart = index
      const literal = powerShellHereString(input, index, depth, budget, skipped)
      if (literal.kind === "opaque") return literal
      if (!words.length && !invocation) expression = true
      nestedCommands.push(...literal.commands)
      word = literal.source
      started = true
      index = literal.end
      finishWord(index + 1)
      memberChainStart = wordStart
      hasMemberAccess = false
      indexable = "closed"
      continue
    }
    // ${...} 花括号变量名
    if (char === "$" && input[index + 1] === "{") {
      const end = powerShellBracedVariable(input, index, skipped)
      if (end === undefined) return { kind: "opaque", reason: "invalid-structure" }
      if (!started && !words.length && !invocation && hash !== "switch") expression = true
      const dynamicMember = afterMemberOperator()
      // 维护成员链状态
      if (dynamicMember) {
        indexable = "closed"
        hasMemberAccess = true
      } else if (atBoundary) {
        memberChainStart = index
        hasMemberAccess = false
        indexable = "closed"
      } else resetMember()
      word += input.slice(index, end + 1)
      started = true
      index = end
      // 表达式中的独立变量自成一词（除非后面紧跟下标 [）
      if (expression && !redirectTarget && input[index + 1] !== "[") finishWord(index + 1)
      continue
    }
    // 定位嵌套块的开括号：$( / @{ / ( / { / [
    const opener =
      (char === "$" || (atBoundary && char === "@")) && input[index + 1] === "("
        ? index + 1
        : atBoundary && char === "@" && input[index + 1] === "{"
          ? index + 1
          : char === "(" ||
              char === "{" ||
              (char === "[" &&
                (inExpression ||
                  Boolean(indexable) ||
                  (!started && !invocation && (!words.length || clause === "block" || clause === "try"))))
            ? index
            : undefined
    if (opener !== undefined) {
      const tokenIndex = index
      const openChar = input[opener]
      const dynamicMemberOpener = afterMemberOperator()
      const priorIndexable = Boolean(indexable)
      // 判定是否为方法调用 $x.m(...)
      const isMethodCall =
        char === "(" &&
        opener === tokenIndex &&
        memberChainStart !== undefined &&
        ((indexable === "member" && started && !/[.:]$/.test(word)) ||
          (indexable === "closed" && !started && hasMemberAccess))
      // 是否为独立块（自成一词）
      const standaloneBlock = atBoundary || inExpression || char === "(" || openChar === "{"
      // 嵌套块对应的闭合符
      const blockClose = openChar === "(" ? ")" : openChar === "[" ? "]" : "}"
      // 嵌套块的内容形态（决定子层初始表达式/子句）
      const blockHash =
        openChar === "["
          ? true
          : char === "@" && openChar === "{"
            ? true
            : clause === "switch" && openChar === "{"
              ? "switch"
              : clause === "clause" && openChar === "{"
                ? "clause"
                : close === "]" && char === "(" && started
                  ? "clause"
                  : false
      // 词中开块：先收尾当前词
      if (started && (char === "{" || char === "(" || (char === "@" && atBoundary))) {
        finishWord(index)
        if (stopParsing) {
          index--
          continue
        }
        wordStart = index
      }
      if (!started && !words.length && !invocation) expression = true
      // 递归扫描嵌套块
      const result = scanPowerShellList(input, opener + 1, depth + 1, budget, blockClose, blockHash, skipped)
      if (result.kind === "opaque") return result
      nestedCommands.push(...result.commands)
      started = true
      word += input.slice(index, result.end + 1)
      index = result.end
      // 方法调用：把整条链（head(args)）作为一条嵌套命令
      if (isMethodCall && memberChainStart !== undefined) {
        finishWord(index + 1)
        const callResource = input.slice(memberChainStart, result.end + 1)
        const head = input.slice(memberChainStart, opener)
        const args = input.slice(opener, result.end + 1)
        nestedCommands.push({
          resource: callResource,
          words: [head, args],
          rawWords: [head, args],
          wordEnds: [head.length, callResource.length],
        })
        indexable = "closed"
        hasMemberAccess = false
      } else if (openChar === "[") {
        // 下标/类型字面量：闭合形态
        indexable = "closed"
        if (!priorIndexable) memberChainStart = tokenIndex
        if (input[index + 1] !== "[") finishWord(index + 1)
      } else if (standaloneBlock) {
        // 独立块自成一词
        finishWord(index + 1)
        indexable = "closed"
        if (!dynamicMemberOpener) memberChainStart = tokenIndex
        hasMemberAccess = dynamicMemberOpener
      }
      // 控制结构头部完成：paren 之后的 ( 或其他子句的 { 标记进入成员/体
      if ((clause === "paren" && char === "(") || (clause && clause !== "paren" && char === "{")) {
        const completed = clause === "do" || clause === "if" || clause === "try" ? clause : undefined
        clause = "member"
        finishCommand(index + 1)
        after = completed
      }
      continue
    }
    // 本层的闭合符：结束
    if (char === close) break
    // 不匹配的闭合符
    if (char === "}" || char === ")" || (char === "]" && inExpression))
      return { kind: "opaque", reason: "invalid-structure" }
    // & 调用或 . 调用（dot-sourcing）
    if (
      !started &&
      words.length === 0 &&
      ((char === "&" && input[index + 1] !== "&") ||
        (char === "." && (!input[index + 1] || /[\s"'$(),;{|}&]/.test(input[index + 1]))))
    ) {
      if (invocation) return { kind: "opaque", reason: "invalid-structure" }
      segment = index
      invocation = true
      after = undefined
      continue
    }
    // 空白结束当前词
    if (/\s/.test(char) && char !== "\n" && char !== "\r") {
      const memberOperator = afterMemberOperator()
      finishWord(index)
      if (!memberOperator) resetMember()
      continue
    }
    // 分隔符：\r\n、&&、||、;、|、&、换行
    const next = input[index + 1]
    const separator =
      char === "\r" && next === "\n"
        ? char + next
        : (char === "&" && next === "&") || (char === "|" && next === "|")
          ? char + next
          : char === ";" || char === "|" || char === "&" || char === "\n" || char === "\r"
            ? char
            : undefined
    if (separator) {
      // ] 组内不允许语句分隔符
      if (
        close === "]" &&
        (separator === ";" || separator === "|" || separator === "||" || separator === "&&" || separator === "&")
      )
        return { kind: "opaque", reason: "invalid-structure" }
      // 换行类分隔符：子句/逗号/成员链中的换行只是继续
      if (separator === "\n" || separator === "\r" || separator === "\r\n") {
        const prev = previousWord()
        const memberOperator = afterMemberOperator()
        if ((clause && clause !== "member") || prev.endsWith(",") || memberOperator) {
          finishWord(index)
          index += separator.length - 1
          if (!memberOperator) resetMember()
          continue
        }
        // 空行跳过
        if (!started && !words.length && !invocation) {
          index += separator.length - 1
          resetMember()
          continue
        }
      }
      // 结束当前命令；运算符悬空时该命令是必需的
      finishCommand(index, dangling || ![";", "\n", "\r", "\r\n"].includes(separator))
      dangling = ![";", "&", "\n", "\r", "\r\n"].includes(separator)
      statementHead = !dangling
      index += separator.length - 1
      continue
    }
    // 空位上的表达式起始（变量/数字/一元运算等）
    if (!started && !words.length && !invocation && hash !== "switch" && testAt(POWERSHELL_EXPRESSION_RE, input, index))
      expression = true
    // 变量 $x：进入可索引状态并维护成员链
    if ((atBoundary || afterMemberOperator()) && char === "$") {
      if (testAt(POWERSHELL_INDEXABLE_VAR_RE, input, index + 1)) {
        if (afterMemberOperator()) hasMemberAccess = true
        else {
          memberChainStart = index
          hasMemberAccess = false
        }
        indexable = "variable"
      } else resetMember()
    } else if (indexable === "closed") {
      // 已闭合形态：继续成员访问（.、::、?.）或回到不可索引
      indexable =
        (char === "." && input[index + 1] !== "." && (!/\s/.test(input[index + 1] ?? "") || inExpression)) ||
        (!started && char === ":" && input[index + 1] === ":") ||
        (!started &&
          char === "?" &&
          input[index + 1] === "." &&
          input[index + 2] !== "." &&
          (!/\s/.test(input[index + 2] ?? "") || inExpression))
          ? "member"
          : !started && char === "?" && input[index + 1] === "["
            ? "closed"
            : false
      if (indexable === "member") hasMemberAccess = true
      else if (!indexable) resetMember()
    } else if (indexable === "variable") {
      // 变量形态：成员访问或继续变量名
      indexable =
        (char === "." && input[index + 1] !== "." && (!/\s/.test(input[index + 1] ?? "") || inExpression)) ||
        (char === ":" && input[index + 1] === ":")
          ? "member"
          : (char === "." && input[index + 1] === ".") || !/[\p{L}\p{Nl}\d_:?]/u.test(char)
            ? false
            : "variable"
      if (indexable === "member") hasMemberAccess = true
      else if (!indexable) resetMember()
    } else if (indexable === "member") {
      // 成员访问中：继续成员名字符
      indexable =
        char === "." && input[index + 1] === "."
          ? false
          : (char === "." && (!/\s/.test(input[index + 1] ?? "") || inExpression)) ||
              (char === ":" && (input[index + 1] === ":" || input[index - 1] === ":")) ||
              (char === "?" && input[index + 1] === "." && input[index + 2] !== ".") ||
              /[\p{L}\p{Nl}\d_]/u.test(char)
            ? "member"
            : false
      if (!indexable) resetMember()
    }
    // 普通字符累积进当前词
    after = undefined
    started = true
    dangling = false
    word += char
  }

  // 结束：本层必须落在期待的闭合符上
  if (close !== undefined && input[index] !== close) return { kind: "opaque", reason: "invalid-structure" }
  // 引号未闭合
  if (quote) return { kind: "opaque", reason: "unterminated-quote" }
  finishCommand(index)
  // 悬空的重定向/不合法/悬空运算符
  if (redirectTarget || invalid || dangling) return { kind: "opaque", reason: "invalid-structure" }
  // 存在空命令词（动态命令名）
  if (commands.some((command) => !command.words[0])) return { kind: "opaque", reason: "dynamic-command-name" }
  return { kind: "scanned", commands, end: index }
}

// --% 停止解析标记（其后内容按字面处理）
const POWERSHELL_STOP_PARSING_RE = /--%(?=$|[\s;|&(){}])/y
// 参数名以冒号结尾（-Foo: 形式）
const POWERSHELL_PARAMETER_COLON_RE = /^-[\p{L}\p{Nl}_?][\p{L}\p{Nl}\d_?-]*:$/u
// 流合并重定向 n>&
const POWERSHELL_MERGE_REDIRECT_RE = /\d>&/y
// 语句标签 label:（其后必须是循环关键字）
const POWERSHELL_LABEL_RE = /:[A-Za-z_]\w*(?=\s*(?:while|for|foreach|do|switch)(?=$|[\s&(),;{|}]))/iy
// 关键字词（后随分隔符或结尾）
const POWERSHELL_KEYWORD_RE = /[A-Za-z]+(?=$|[\s&(),;{|}])/y
// foreach(
const POWERSHELL_FOREACH_RE = /foreach\s*\(/isy
// param(
const POWERSHELL_PARAM_RE = /param\s*\(/isy
// do 循环的 in
const POWERSHELL_IN_RE = /in(?=$|[\s&(),;{|}])/iy
// @ 之后允许的展开开符（@' "@ { @( 之外的 @ 不合法）
const POWERSHELL_AT_OPENER_RE = /[({'"\p{L}\p{Nl}\d_?]/uy
// $ 之后可索引的变量名（含作用域前缀 :name）
const POWERSHELL_INDEXABLE_VAR_RE = /(?::[\p{L}\p{Nl}\d_?]+|[\p{L}\p{Nl}\d_][\p{L}\p{Nl}\d_?]*)/uy
// here-string 头部：@' 或 @" 之后直接换行
const POWERSHELL_HERE_HEADER_RE = /@['"][^\S\r\n]*(?:\r\n|\r|\n)/y
// `u{...} Unicode 转义
const POWERSHELL_UNICODE_ESCAPE_RE = /u\{([0-9a-f]{1,6})\}/iy
// 表达式起始形态：变量、一元运算、数字字面量（含后缀）、-not/-join/-split 等
const POWERSHELL_EXPRESSION_RE =
  /(?:!*(?:\+\+|--|[+-])?\$(?:\{|(?:\?|\$|\^)(?=$|[\s;|&(){},#>])|:[\p{L}\p{Nl}\d_?]+|[\p{L}\p{Nl}\d_][\p{L}\p{Nl}\d_?]*(?::[\p{L}\p{Nl}\d_?]+)?)|!(?![\p{L}\p{Nl}_.\d])|\+(?![=\p{L}\p{Nl}_.\d])|--(?!=)|-(?![=\p{L}\p{Nl}\d_?.])|,(?!\s*$)|!*[+-]?(?:0[xX][\da-fA-F]+|0[bB][01]+|(?:\d+(?:\.(?!\.)\d*|(?!\.(?!\.)))|\.\d+)(?:[eE][+-]?\d+)?)(?:[dDlLnN]|[uU][sSyYlL]?|[sSyY])?(?:[kKmMgGtTpP][bB])?(?=$|[\s!#%&()*+,\-/.;<=>\]|{}])|-(?:not|bnot|join|[ic]?split)(?![\p{L}\p{Nl}]))/iuy

// PowerShell 反引号转义的字符映射表
const POWERSHELL_ESCAPES: Record<string, string> = {
  "0": "\0",
  a: "\x07",
  b: "\b",
  e: "\x1b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
}

// 从指定下标执行粘性正则匹配
function matchAt(regex: RegExp, input: string, index: number) {
  regex.lastIndex = index
  return regex.exec(input)
}

// 从指定下标测试粘性正则是否命中
function testAt(regex: RegExp, input: string, index: number) {
  regex.lastIndex = index
  return regex.test(input)
}

// 解析反引号转义；返回转义值与结束下标
function powerShellEscape(input: string, start: number, lineContinuation = false, skipped?: ReadonlySet<number>) {
  let next = start + 1
  while (skipped?.has(next)) next++
  const char = input[next]
  if (char === undefined) return
  // 行尾转义是续行（\r\n 时值取 \r\n）
  if (char === "\r" || char === "\n")
    return {
      value: lineContinuation && char === "\r" && input[next + 1] === "\n" ? "\r\n" : char,
      end: next + (lineContinuation && char === "\r" && input[next + 1] === "\n" ? 1 : 0),
    }
  // `u{XXXX} Unicode 转义
  if (char === "u" && input[next + 1] === "{") {
    const code = matchAt(POWERSHELL_UNICODE_ESCAPE_RE, input, next)
    if (!code || Number.parseInt(code[1], 16) > 0x10ffff) return
    return { value: String.fromCodePoint(Number.parseInt(code[1], 16)), end: next + code[0].length - 1 }
  }
  // 其余查表，未知字符按字面
  return { value: POWERSHELL_ESCAPES[char] ?? char, end: next }
}

// 找到 ${...} 花括号变量的闭合 }；空名或未闭合返回 undefined
function powerShellBracedVariable(input: string, start: number, skipped?: ReadonlySet<number>) {
  for (let index = start + 2; index < input.length; index++) {
    if (skipped?.has(index)) continue
    // 反引号转义跳过
    if (input[index] === "`") {
      const escape = powerShellEscape(input, index, false, skipped)
      if (!escape) return
      index = escape.end
      continue
    }
    if (input[index] === "}") return index > start + 2 ? index : undefined
  }
}

// 预扫描 $(...) 子表达式的原始边界：返回需要跳过的下标（$"..." 歧义）与原始闭括号位置
function powerShellSubExpression(
  input: string,
  start: number,
  hereString: boolean,
  budget: { remaining: number },
  skipped?: ReadonlySet<number>,
) {
  const nextSkipped = new Set(skipped)
  // 括号深度
  let depth = 1
  // 第一个配对的 ) 位置
  let rawEnd: number | undefined
  for (let index = start; index < input.length; index++) {
    if (--budget.remaining < 0) return
    if (nextSkipped.has(index)) continue
    const char = input[index]
    if (char === "(") depth++
    else if (char === ")") {
      if (--depth === 0 && rawEnd === undefined) rawEnd = index
    } else if (!hereString && (char === '"' || char === "`")) {
      // 双写引号歧义：把成对的第一个引号加入跳过集合
      let next = index + 1
      while (nextSkipped.has(next)) next++
      if (input[next] === '"') {
        nextSkipped.add(index)
        index = next
      }
    }
  }
  return { skipped: nextSkipped, rawEnd }
}

// --% 模式：找到字面文本的结束（换行或未引用的 | / &&）
function powerShellStopParsing(input: string, start: number, skipped?: ReadonlySet<number>) {
  let quoted = false
  for (let index = start; index < input.length; index++) {
    if (skipped?.has(index)) continue
    if (input[index] === '"') quoted = !quoted
    if (
      input[index] === "\r" ||
      input[index] === "\n" ||
      ((input[index] === "|" || (input[index] === "&" && input[index + 1] === "&")) && !quoted)
    )
      return index
  }
  return input.length
}

// 读取 here-string（@'...'@ 或 @"..."@）的正文与其中的子命令
function powerShellHereString(
  input: string,
  start: number,
  depth: number,
  budget: { remaining: number },
  skipped?: ReadonlySet<number>,
): (Result & { source: string; end: number }) | { kind: "opaque"; reason: OpaqueReason } {
  // 头部必须是 @' / @" 后直接换行
  const header = matchAt(POWERSHELL_HERE_HEADER_RE, input, start)
  if (!header) return { kind: "opaque", reason: "unterminated-quote" }
  // 引号类型
  const quote = input[start + 1]
  // 正文起点
  const body = start + header[0].length
  const commands: Command[] = []
  // 是否处于行首（结束标记必须在行首）
  let lineStart = true
  for (let index = body; index < input.length; index++) {
    if (--budget.remaining < 0) return { kind: "opaque", reason: "invalid-structure" }
    if (skipped?.has(index)) continue
    // 行首的 '<quote>@ / "<quote>@ 是结束标记
    if (lineStart && input[index] === quote && input[index + 1] === "@") {
      // 正文不含结束标记前的换行
      const end =
        index > body && input[index - 1] === "\n" && input[index - 2] === "\r"
          ? index - 2
          : index > body
            ? index - 1
            : index
      return { kind: "scanned", commands, source: input.slice(body, end), end: index + 1 }
    }
    // 双引号 here-string 中的展开
    if (quote === '"') {
      // 反引号转义
      if (input[index] === "`") {
        const escape = powerShellEscape(input, index, false, skipped)
        if (!escape) return { kind: "opaque", reason: "unterminated-escape" }
        index = escape.end
        lineStart = false
        continue
      }
      // ${...} 变量
      if (input[index] === "$" && input[index + 1] === "{") {
        const end = powerShellBracedVariable(input, index, skipped)
        if (end === undefined) return { kind: "opaque", reason: "invalid-structure" }
        index = end
        lineStart = false
        continue
      }
      // $(...) 子表达式：扫描其中的命令
      if (input[index] === "$" && input[index + 1] === "(") {
        const sub = powerShellSubExpression(input, index + 2, true, budget, skipped)
        if (!sub) return { kind: "opaque", reason: "invalid-structure" }
        const result = scanPowerShellList(input, index + 2, depth + 1, budget, ")", false, sub.skipped)
        if (result.kind === "opaque") return result
        commands.push(...result.commands)
        index = sub.rawEnd !== undefined && sub.rawEnd > result.end ? sub.rawEnd : result.end
        lineStart = false
        continue
      }
    }
    // 行首标记
    lineStart = input[index] === "\r" || input[index] === "\n"
  }
  // 没等到结束标记
  return { kind: "opaque", reason: "unterminated-quote" }
}

// 解析 PowerShell 重定向运算符；返回运算符文本，非法返回 false，不是重定向返回 undefined
function powerShellRedirect(input: string, index: number) {
  let cursor = index
  // *> 或数字流号
  if (input[cursor] === "*") cursor++
  else while (/\d/.test(input[cursor] ?? "")) cursor++
  if (input[cursor] !== ">") return
  cursor++
  // 追加 >>
  if (input[cursor] === ">") cursor++
  // 流合并 n>&m
  if (input[cursor] === "&") {
    cursor++
    while (/\d/.test(input[cursor] ?? "")) cursor++
  }
  const redirect = input.slice(index, cursor)
  // 仅接受合法形态
  return /^(?:(?:[1-6]|\*)?>>?|[2-6*]>&1)$/.test(redirect) ? redirect : false
}
