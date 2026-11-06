// 导入容错型 HTML 流式解析器 Parser（来自 htmlparser2）
import { Parser } from "htmlparser2"

// 需要整体忽略（不输出任何内容）的 HTML 标签集合：脚本、样式、无脚本降级、内嵌框架等对 Markdown 无意义的内容
const omitted = new Set(["script", "style", "noscript", "iframe", "object", "embed", "meta", "link", "template"])
// 语义上等价于“块级元素”的通用容器标签集合：渲染前后需要空行分隔，但本身没有特定 Markdown 语法
const blocks = new Set([
  // address：联系信息
  "address",
  // article：文章容器
  "article",
  // aside：侧边内容
  "aside",
  // details：可折叠区域
  "details",
  // dialog：对话框
  "dialog",
  // div：通用容器
  "div",
  // dl：定义列表容器
  "dl",
  // fieldset：表单分组
  "fieldset",
  // figcaption：图注
  "figcaption",
  // figure：图文区块
  "figure",
  // footer：页脚
  "footer",
  // form：表单
  "form",
  // header：页头
  "header",
  // main：主体内容
  "main",
  // nav：导航
  "nav",
  // p：段落
  "p",
  // section：章节
  "section",
  // summary：折叠区标题
  "summary",
])

// 解析栈中的帧（Frame）：记录每一层元素嵌套的上下文状态
type Frame = {
  // 该帧（及其子树）是否被抑制（不输出内容）
  suppressed: boolean
  // 当前帧开启的超链接：href 与可选的 title
  link?: { href: string; title?: string }
  // 进入块级元素等场景时被挂起的链接，等离开该块后恢复
  suspendedLink?: Frame["link"]
  // 行内强调标记（如 **bold**）的回溯信息：输出位置索引、所在块编号、是否有前导空格、上一层标记
  marker?: { index: number; block: number; leadingSpace?: boolean; previous?: Frame["marker"] }
  // 当前处于其中的代码块：是否行内、累计文本、可选语言
  code?: { inline: boolean; text: string; language?: string }
  // 链接文本中嵌套的行内代码
  linkCode?: NonNullable<Frame["code"]>
  // 因进入链接而被挂起的行内代码，链接结束后恢复
  resumedCode?: NonNullable<Frame["code"]>
  // 当前处于其中的列表：是否有序、下一个序号、外层列表
  list?: { ordered: boolean; next: number; previous?: Frame["list"] }
  // 当前处于其中的列表项：缩进字符串、外层列表项
  item?: { indent: string; previous?: Frame["item"] }
  // 当前处于其中的表格：起始输出索引、已收集的行、正在收集的行、可选标题、是否含跨行/跨列而需降级、外层表格
  table?: {
    // 表格内容在输出中的起始 chunk 索引，用于回取“松散文本”
    start: number
    // 已收集完的行（每行是单元格文本数组）
    rows: string[][]
    // 正在收集的当前行
    row?: string[]
    // 表格标题（caption）
    caption?: string
    // 存在 colspan/rowspan 等无法用管道表格表达的结构时置为 true，走降级渲染
    fallback: boolean
    // 外层表格（支持嵌套表格的回溯）
    previous?: Frame["table"]
  }
  // 当前单元格：其在输出中的起始 chunk 索引
  cell?: { start: number }
  // 当前表格标题：其在输出中的起始 chunk 索引
  caption?: { start: number }
  // 当前 details 折叠区：是否展开、是否正处于 summary、外层 details
  details?: { open: boolean; summary: boolean; previous?: Frame["details"] }
}

// 输出片段类型：普通字符串，或标记为 raw 的字符串（表示已定型的原子块，如围栏代码块，不再参与空白归一化）
type Chunk = string | { raw: string }

// 导出的最大输出字节数：5MB
export const MAX_MARKDOWN_BYTES = 5 * 1024 * 1024
// 普通内容的字节限额：留出 64KB 余量，保证后续还能塞进围栏符号、链接闭合等包裹性文本
const CONTENT_BYTES = MAX_MARKDOWN_BYTES - 64 * 1024

// 把 HTML 字符串转换为 Markdown 字符串（核心入口）
export function convertHTMLToMarkdown(html: string) {
  // 输出片段缓冲区
  const output: Chunk[] = []
  // 元素嵌套栈，每进入一个标签压入一个帧
  const stack: Frame[] = []
  // UTF-8 编码器，用于按字节数计算与截断
  const encoder = new TextEncoder()
  // 是否有待输出的空格（HTML 中连续空白延迟合并）
  let pendingSpace = false
  // 待写入的缩进字符串（列表项续行用）
  let pendingIndent = ""
  // 最后一个已输出字符（不存在时保持初始空串）
  let last = ""
  // 当前 blockquote 引用嵌套深度
  let quoteDepth = 0
  // 下一行是否需要补 "> " 引用前缀
  let needsQuotePrefix = false
  // 已输出的块数量，用于判断标记是否跨越了块边界
  let blockCount = 0
  // 当前标签嵌套深度
  let depth = 0
  // 是否已因深度超限而停止输出
  let stopped = false
  // 当前累计输出字节数
  let outputBytes = 0
  // 当前激活的代码块（进入 pre/code 时设置）
  let activeCode: NonNullable<Frame["code"]> | undefined
  // 当前激活的链接
  let activeLink: Frame["link"] | undefined
  // 链接的 "[" 是否已输出但尚未闭合（等待 "]()"）
  let linkOpen = false
  // 当前激活的行内强调标记
  let activeMarker: Frame["marker"] | undefined
  // 当前激活的列表
  let activeList: Frame["list"] | undefined
  // 当前激活的列表项
  let activeItem: Frame["item"] | undefined
  // 当前激活的表格
  let activeTable: NonNullable<Frame["table"]> | undefined
  // 当前激活的单元格
  let activeCell: Frame["cell"] | undefined
  // 表格嵌套深度
  let tableDepth = 0
  // 停止输出后回退（fallback）路径上被抑制元素所在的深度界线
  let fallbackSuppressedDepth = 0
  // 停止输出后回退路径上被忽略元素（omitted）的剩余深度
  let fallbackOmittedDepth = 0
  // 当前激活的 details 折叠区
  let activeDetails: Frame["details"] | undefined

  // 按字节上限截断字符串：不破坏 UTF-8 码点，二分查找最大可保留字符数
  const sliceBytes = (value: string, bytes: number) => {
    // 整体不超限则原样返回
    if (encoder.encode(value).byteLength <= bytes) return value
    // 拆成码点数组（避免按 UTF-16 代元切断）
    const characters = Array.from(value)
    // 二分下界
    let low = 0
    // 二分上界
    let high = characters.length
    // 标准二分：找最大的前缀使其字节数不超过上限
    while (low < high) {
      // 取中点（向上取整，保证区间收缩）
      const middle = Math.ceil((low + high) / 2)
      // 前缀字节长度不超限则右移下界
      if (encoder.encode(characters.slice(0, middle).join("")).byteLength <= bytes) low = middle
      // 否则收缩上界
      else high = middle - 1
    }
    // 返回截断后的字符串
    return characters.slice(0, low).join("")
  }
  // 追加文本到输出：受字节限额约束，超出部分截断
  const append = (value: string, content = false) => {
    // 内容类文本用更严格的 CONTENT_BYTES 限额，其余用总限额
    const limit = content ? CONTENT_BYTES : MAX_MARKDOWN_BYTES
    // 空串或已达限额则直接返回
    if (!value || outputBytes >= limit) return
    // 计算字节数
    const bytes = encoder.encode(value)
    // 剩余可用字节数
    const remaining = limit - outputBytes
    // 超出剩余空间时按字节截断
    const next = bytes.byteLength <= remaining ? value : sliceBytes(value, remaining)
    // 入队输出
    output.push(next)
    // 累计实际写入的字节数
    outputBytes += bytes.byteLength <= remaining ? bytes.byteLength : encoder.encode(next).byteLength
    // 更新“最后一个字符”记录（空串时保持原值）
    last = next.at(-1) ?? last
  }
  // 追加“原始块”文本：标记为 raw，后续归一化阶段原样保留
  const appendRaw = (value: string) => {
    // 记录追加前的片段数
    const before = output.length
    // 普通追加
    append(value)
    // 若确实写入了内容，把最后一个片段包成 raw 标记
    if (output.length > before) output[output.length - 1] = { raw: output[output.length - 1] as string }
  }
  // 回取自 start 索引起的全部输出片段并合并为字符串（同时从字节数中扣回）
  const take = (start: number) => {
    // 从输出中切出片段
    const chunks = output.splice(start)
    // 拼接为字符串（raw 片段取其 raw 值）
    const value = chunks.map((chunk) => (typeof chunk === "string" ? chunk : chunk.raw)).join("")
    // 从累计字节数中扣除
    outputBytes -= encoder.encode(value).byteLength
    // 返回取出的文本
    return value
  }
  // 生成当前深度的引用前缀（最多 8 层）
  const quotePrefix = () => "> ".repeat(Math.min(8, quoteDepth))
  // 若本行待补引用前缀则先写入
  const prefixQuote = () => {
    // 无需补前缀、不在引用中或正处于表格单元格内时跳过
    if (!needsQuotePrefix || quoteDepth === 0 || activeCell) return
    // 写入引用前缀
    append(quotePrefix())
    // 清除待补标记
    needsQuotePrefix = false
  }
  // 落盘待输出的空格：能并进标记前导位置的就地并进，否则普通追加
  const flushSpace = () => {
    // 没有待输出空格则直接返回
    if (!pendingSpace) return
    // 取当前激活的强调标记
    const marker = activeMarker
    // 特殊情形：空格紧跟在标记片段之后（标记是当前最后一个 chunk）且前一个字符不是空白
    if (marker && output.length === marker.index + 1 && last !== " " && last !== "\n") {
      // 取出标记所在片段
      const value = output[marker.index]
      // 字符串片段则在其前面补一个空格
      if (typeof value === "string") output[marker.index] = ` ${value}`
      // 手工累计这 1 个字节
      outputBytes++
      // 标记该空格已被合并进标记
      marker.leadingSpace = true
      // 清除待输出空格
      pendingSpace = false
      return
    }
    // 常规情形：上一字符不是换行或空格时追加一个空格
    if (last && last !== "\n" && last !== " ") append(" ")
    // 清除待输出空格
    pendingSpace = false
  }
  // 输出行内文本的统一入口：先处理空格、引用前缀、缩进、链接开启
  const inline = (value: string, open = false, content = false) => {
    // open 表示新词开始：先落盘待定空格
    if (open) flushSpace()
    // 需要时补引用前缀
    prefixQuote()
    // 有待写缩进则先写并清空
    if (pendingIndent) {
      append(pendingIndent)
      pendingIndent = ""
    }
    // 处于链接中但 "[" 尚未输出：先输出 "["
    if (activeLink && !linkOpen) {
      append("[")
      linkOpen = true
    }
    // 实际写入文本（content 指明是否受内容限额约束）
    append(value, content)
  }
  // 结束一个块：闭合未闭链接、输出空行、复位状态
  const block = () => {
    // 链接仍开启则先补上 "]()" 闭合
    if (activeLink && linkOpen) {
      closeLink(activeLink)
      linkOpen = false
    }
    // 丢弃跨块空格
    pendingSpace = false
    // 输出块间空行
    append("\n\n")
    // 块计数加一
    blockCount++
    // 处于引用中则下一行需要引用前缀
    needsQuotePrefix = quoteDepth > 0
    // 新块恢复列表项缩进
    pendingIndent = activeItem?.indent ?? ""
  }
  // 挂起当前链接（如进入块级元素时）：记到帧上并结束块
  const suspendLink = (frame: Frame) => {
    // 无激活链接则无事可做
    if (!activeLink) return
    // 记录到当前帧以便退出时恢复
    frame.suspendedLink = activeLink
    // 先以块结束的方式闭合链接
    block()
    // 清空激活链接状态
    activeLink = undefined
    linkOpen = false
  }
  // 处理文本节点：代码块内直接累积，其余做空白合并与 Markdown 转义
  const text = (value: string) => {
    // 处于代码块中：原文累积（不转义）
    if (activeCode) {
      activeCode.text += value
      return
    }
    // 按空白序列拆分（保留分隔符）
    for (const part of value.split(/([\t\n\f\r ]+)/)) {
      // 跳过空片段
      if (!part) continue
      // 纯空白片段：记为待定空格（稍后合并）
      if (/^[\t\n\f\r ]+$/.test(part)) {
        pendingSpace = true
        continue
      }
      // 输出转义后的文本：
      inline(
        // 先转义 Markdown 特殊字符（\ ` * _ [ ] < > |）
        part
          .replace(/([\\`*_[\]<>|])/g, "\\$1")
          // 再转义波浪号（删除线语法）
          .replace(/~/g, "\\~")
          // 行首的 #、+、- 转义，避免被当作标题/列表
          .replace(/^([#+-])/, "\\$1")
          // 行首的 "数字." 转义，避免被当作有序列表
          .replace(/^(\d+)\./, "$1\\."),
        true,
        true,
      )
    }
  }
  // 转义链接目标（URL）：括号前加反斜杠，空白转为 %20
  const destination = (value: string) => value.replace(/([\\()])/g, "\\$1").replace(/[\t\n\r ]+/g, "%20")
  // 生成可选的链接 title 部分（带引号并转义），无 title 时返回空串
  const title = (value: string | undefined) =>
    value
      // 把 title 包裹成 " ..." 形式：空白压缩、去首尾、转义反斜杠与双引号
      ? ` "${value
          .replace(/[\t\n\r ]+/g, " ")
          .trim()
          .replace(/([\\"])/g, "\\$1")}"`
      : ""
  // 闭合链接：输出 "](目标 title)" 形式
  const closeLink = (link: NonNullable<Frame["link"]>) => append(`](${destination(link.href)}${title(link.title)})`)
  // 行内强调标签名到 Markdown 标记的映射
  const inlineMarker = (name: string) => {
    // strong/b 对应加粗 **
    if (name === "strong" || name === "b") return "**"
    // em/i 对应斜体 *
    if (name === "em" || name === "i") return "*"
    // s/strike/del 对应删除线 ~~
    if (name === "s" || name === "strike" || name === "del") return "~~"
    // 其他标签没有行内标记
    return undefined
  }
  // 结束一个代码块：按行内/块级分别渲染，并处理字节限额下的截断
  const finishCode = (code: NonNullable<Frame["code"]>) => {
    // 空的行内代码块不输出
    if (code.inline && !code.text) return
    // 代码文本中最长的连续反引号数量
    let backticks = 0
    // 代码文本中最长的连续波浪号数量
    let tildes = 0
    // 当前遍历到的连续反引号计数
    let currentBackticks = 0
    // 当前遍历到的连续波浪号计数
    let currentTildes = 0
    // 扫描一遍统计最长连续序列
    for (const character of code.text) {
      // 反引号则累加，否则清零
      currentBackticks = character === "`" ? currentBackticks + 1 : 0
      // 波浪号则累加，否则清零
      currentTildes = character === "~" ? currentTildes + 1 : 0
      // 更新反引号最大值
      backticks = Math.max(backticks, currentBackticks)
      // 更新波浪号最大值
      tildes = Math.max(tildes, currentTildes)
    }
    // 行内代码分支
    if (code.inline) {
      // 围栏长度取“内容内最长反引号 + 1”，至少 1 个
      const fence = "`".repeat(Math.max(1, backticks + 1))
      // 先落盘待定空格
      flushSpace()
      // 补引用前缀
      prefixQuote()
      // 计算可用字节：内容限额减去已有输出与两侧围栏
      const available = Math.max(0, CONTENT_BYTES - outputBytes - fence.length * 2)
      // 按可用字节截断代码文本
      let payload = sliceBytes(code.text, available)
      // 循环直到成功放下或内容耗尽
      while (payload) {
        // 若首尾有反引号/空格则各补一个空格垫片，避免与围栏粘连（全空格内容除外）
        const padding = /^[ `]|[ `]$/.test(payload) && !/^ +$/.test(payload) ? " " : ""
        // 当前内容字节数
        const bytes = encoder.encode(payload).byteLength
        // 带垫片能放进限额则输出完整行内代码并结束
        if (bytes + padding.length * 2 <= available) {
          appendRaw(`${fence}${padding}${payload}${padding}${fence}`)
          return
        }
        // Padding costs at most two bytes, so at most two whole-code-point trims are needed.
        // 每次裁掉一个码点再试
        payload = sliceBytes(payload, bytes - 1)
      }
      // 内容为空或放不下：直接返回
      return
    }
    // 处于表格单元格中的块级代码降级为普通文本
    if (activeCell) {
      text(code.text)
      return
    }
    // 围栏字符选择：优先反引号，但若波浪号更长则用波浪号，避免冲突
    const marker = backticks <= tildes ? "`" : "~"
    // 围栏长度：至少 3 个，且比内容中该字符的最长连续数多 1
    const length = Math.max(3, (marker === "`" ? backticks : tildes) + 1)
    // 生成围栏字符串
    const fence = marker.repeat(length)
    // 块级代码先起一个新块
    block()
    // 围栏起始行（带语言标注）
    const prefix = `${fence}${code.language ?? ""}\n`
    // 引用环境下的前缀
    const quote = quoteDepth > 0 ? quotePrefix() : ""
    // 待输出的代码内容
    let payload = code.text
    // 循环尝试，直到能整体放下或内容耗尽
    for (;;) {
      // 组装完整块：首行围栏、内容（无尾换行则补）、闭合围栏
      const candidate = `${prefix}${payload}${payload.endsWith("\n") ? "" : "\n"}${fence}`
      // 引用环境给每行加前缀
      const value = quote ? candidate.replace(/^/gm, quote) : candidate
      // 计算完整块的字节数
      const valueBytes = encoder.encode(value).byteLength
      // 能放进内容限额则输出并结束
      if (outputBytes + valueBytes <= CONTENT_BYTES) {
        appendRaw(value)
        block()
        return
      }
      // No amount of trimming can make the empty fenced block fit.
      // 内容已空仍放不下：放弃
      if (!payload) return
      // 计算需要削减的字节数
      const excess = valueBytes - Math.max(0, CONTENT_BYTES - outputBytes)
      // 按超出量（向上取整）截断代码内容后重试
      payload = sliceBytes(payload, Math.max(0, encoder.encode(payload).byteLength - Math.ceil(excess)))
    }
  }

  // 创建 HTML 解析器并注册三个事件回调
  const parser = new Parser({
    // 遇到开始标签时的处理
    onopentag(name, attributes) {
      // 深度加一
      depth++
      // 深度超过 1 万：防御性熔断，避免恶意深嵌套
      if (depth > 10_000) {
        // 若最内层是被抑制的帧，则记录回退路径的深度界线，让文本仍可输出
        if (stack.at(-1)?.suppressed) {
          // 找到最靠后的可见（未抑制）帧
          const visibleParent = stack.findLastIndex((frame) => !frame.suppressed)
          // 界线设为该帧之下两层
          fallbackSuppressedDepth = visibleParent + 2
        }
        // 清空激活代码块状态
        activeCode = undefined
        // 停止正常输出
        stopped = true
      }
      // 已停止：进入降级模式
      if (stopped) {
        // 忽略类标签继续计深，等待其闭合
        if (omitted.has(name)) fallbackOmittedDepth++
        // 其他标签当作普通空白间隔
        else pendingSpace = true
        return
      }
      // 计算本帧是否被抑制：父帧被抑制，或标签属于忽略集合
      const suppressed = (stack.at(-1)?.suppressed ?? false) || omitted.has(name)
      // 创建当前帧
      const frame: Frame = { suppressed }
      // 判断是否“隐藏”元素：有 hidden 属性、aria-hidden 为 true、或是 head
      const hidden = "hidden" in attributes || attributes["aria-hidden"]?.toLowerCase() === "true" || name === "head"
      // 取当前 details 状态
      const details = activeDetails
      // 隐藏元素，或处于未展开 details 的非 summary 部分：帧被抑制
      if (hidden || (details && !details.open && !details.summary && name !== "summary")) frame.suppressed = true
      // 入栈
      stack.push(frame)
      // 被抑制的帧不产生任何输出
      if (frame.suppressed) return

      // 处于块级代码中：只处理换行与语言标注
      if (activeCode && !activeCode.inline) {
        // pre 内的 br 记为换行
        if (name === "br") activeCode.text += "\n"
        // pre 内的 code 带类名时提取语言（language-xxx / lang-xxx）
        if (name === "code" && attributes.class)
          activeCode.language = attributes.class.match(/(?:language-|lang-)([^\s]+)/)?.[1]
        return
      }
      // details 折叠区开始：登记状态并起块
      if (name === "details") {
        frame.details = { open: "open" in attributes, summary: false, previous: activeDetails }
        activeDetails = frame.details
        block()
        return
      }
      // summary 开始：登记并起块（summary 内容始终可见）
      if (name === "summary") {
        if (details) details.summary = true
        block()
        return
      }
      // pre 开始：挂起链接，创建块级代码上下文
      if (name === "pre") {
        suspendLink(frame)
        frame.code = { inline: false, text: "" }
        activeCode = frame.code
        return
      }
      // code 开始：创建行内代码上下文（行内代码不嵌套）
      if (name === "code") {
        if (activeCode?.inline) return
        frame.code = { inline: true, text: "" }
        activeCode = frame.code
        return
      }
      // 标题 h1-h6：起块并输出对应数量的 # 与空格
      if (/^h[1-6]$/.test(name)) {
        block()
        inline(`${"#".repeat(Number(name[1]))} `)
        return
      }
      // 通用块级容器：挂起链接并起块（p 前已有空格时免多一空行）
      if (blocks.has(name)) {
        suspendLink(frame)
        if (name === "p" && last === " ") return
        block()
        return
      }
      // 换行标签 br：输出 Markdown 硬换行（行尾两空格 + 换行）
      if (name === "br") {
        pendingSpace = false
        inline("  \n")
        needsQuotePrefix = quoteDepth > 0
        return
      }
      // 水平分割线 hr：独立成块输出 ---
      if (name === "hr") {
        block()
        inline("---")
        block()
        return
      }
      // 行内强调标记
      const marker = inlineMarker(name)
      if (marker) {
        // 输出开启标记
        inline(marker, true)
        // 在帧上记录回溯信息：输出索引、块编号、外层标记
        frame.marker = { index: output.length - 1, block: blockCount, previous: activeMarker }
        activeMarker = frame.marker
        return
      }
      // 链接 a
      if (name === "a") {
        // 特例：正在行内代码中又开启链接且已有激活链接（a>code>a 结构）——先收尾外层
        if (activeLink && activeCode?.inline) {
          // 找到同时持有该链接与该行内代码的祖先帧
          const parent = stack.findLast(
            (candidate) => candidate.link === activeLink && candidate.linkCode === activeCode,
          )
          if (parent) {
            // 输出祖先的行内代码
            finishCode(activeCode)
            // 链接开启中则闭合
            if (linkOpen) closeLink(activeLink)
            // 恢复祖先挂起的行内代码
            activeCode = parent.resumedCode
            // 清空祖先链接状态
            parent.link = undefined
            parent.linkCode = undefined
            activeLink = undefined
            linkOpen = false
          }
        }
        // 行内代码中开启链接：先结束当前代码，切换为“链接文本中的代码”模式
        if (activeCode?.inline) {
          // 记录被挂起的行内代码
          frame.resumedCode = activeCode
          // 已有内容则先输出
          if (activeCode.text) finishCode(activeCode)
          // 清空原代码文本
          activeCode.text = ""
          activeCode = undefined
          // 登记链接
          frame.link = { href: attributes.href ?? "", title: attributes.title }
          activeLink = frame.link
          linkOpen = true
          // 输出 "["
          inline("[", true)
          // 新建“链接文本代码”上下文
          frame.linkCode = { inline: true, text: "" }
          activeCode = frame.linkCode
          return
        }
        // 已有激活链接时嵌套 a：先闭合旧链接
        if (activeLink) {
          if (linkOpen) closeLink(activeLink)
          // 把祖先帧上的链接引用清掉
          const parent = stack.findLast((candidate) => candidate.link === activeLink)
          if (parent) parent.link = undefined
          activeLink = undefined
          linkOpen = false
        }
        // 登记本帧链接并输出 "["
        frame.link = { href: attributes.href ?? "", title: attributes.title }
        activeLink = frame.link
        linkOpen = true
        return inline("[", true)
      }
      // 图片 img：输出 ![alt](src "title")，alt 按剩余限额截断
      if (name === "img") {
        // 转义 alt 中的反斜杠与右中括号
        const alt = (attributes.alt ?? "").replace(/([\\\]])/g, "\\$1")
        // 组装闭合部分 "]()"
        const close = `](${destination(attributes.src ?? "")}${title(attributes.title)})`
        // 开启部分
        const open = "!["
        // alt 可用字节数：内容限额减去已有输出与首尾固定部分
        const available = CONTENT_BYTES - outputBytes - encoder.encode(open + close).byteLength
        // 输出图片语法
        inline(`${open}${sliceBytes(alt, Math.max(0, available))}${close}`, true)
        return
      }
      // blockquote 开始：挂起链接、起块、深度加一
      if (name === "blockquote") {
        suspendLink(frame)
        block()
        quoteDepth++
        needsQuotePrefix = true
        return
      }
      // ul/ol 开始：挂起链接，登记列表状态（ol 读取 start 起始序号）
      if (name === "ul" || name === "ol") {
        suspendLink(frame)
        const start = Number.parseInt(attributes.start ?? "1")
        frame.list = { ordered: name === "ol", next: Number.isNaN(start) ? 1 : start, previous: activeList }
        activeList = frame.list
        block()
        return
      }
      // 列表项 li 开始：起块并输出序号/圆点前缀
      if (name === "li") {
        block()
        // 读取 value 属性（可指定序号）
        const value = Number.parseInt(attributes.value ?? "")
        // 有序列表且 value 合法：更新下一个序号
        if (activeList?.ordered && !Number.isNaN(value)) activeList.next = value
        // 生成标记：有序用 "1."，无序用 "-"
        const marker = activeList?.ordered ? `${activeList.next++}.` : "-"
        // 组装前缀（缩进截断到 24 字符防失控），并记录续行缩进
        const prefix = `${(activeItem?.indent ?? "").slice(0, 24)}${marker} `
        frame.item = { indent: " ".repeat(prefix.length), previous: activeItem }
        activeItem = frame.item
        pendingIndent = ""
        inline(prefix)
        return
      }
      // table 开始：挂起链接；顶层表格登记状态，嵌套表格只记空格
      if (name === "table") {
        suspendLink(frame)
        tableDepth++
        if (tableDepth === 1) {
          block()
          frame.table = { start: output.length, rows: [], fallback: false, previous: activeTable }
          activeTable = frame.table
        } else pendingSpace = true
        return
      }
      // tr 行开始：非顶层表格记空格；顶层则开启新行收集
      if (name === "tr") {
        if (tableDepth !== 1) {
          pendingSpace = true
          return
        }
        if (activeTable) activeTable.row = []
        return
      }
      // 表头/单元格 th/td：非顶层记空格；顶层检测 colspan/rowspan 置降级标记并开启单元格收集
      if (name === "th" || name === "td") {
        if (tableDepth !== 1) {
          pendingSpace = true
          return
        }
        if (attributes.colspan || attributes.rowspan) activeTable!.fallback = true
        frame.cell = { start: output.length }
        activeCell = frame.cell
        return
      }
      // caption 开始：记录起始索引
      if (name === "caption") {
        frame.caption = { start: output.length }
        return
      }
      // dt 定义术语：起块并输出加粗
      if (name === "dt") {
        block()
        inline("**")
        return
      }
      // dd 定义描述：输出换行 + ": " 的定义语法
      if (name === "dd") {
        inline("\n: ")
        return
      }
    },
    // 遇到文本节点时的处理
    ontext(value) {
      // 降级模式：仅在不在被忽略/被抑制的回退范围内时输出文本
      if (stopped) {
        if (fallbackSuppressedDepth === 0 && fallbackOmittedDepth === 0) text(value)
        return
      }
      // 最内层帧被抑制：丢弃文本
      if (stack.at(-1)?.suppressed) return
      // 正常处理
      text(value)
    },
    // 遇到结束标签时的处理
    onclosetag(name) {
      // 深度减一
      depth--
      // 降级模式：只维护回退计数
      if (stopped) {
        // 忽略类标签闭合则递减计数
        if (fallbackOmittedDepth > 0 && omitted.has(name)) fallbackOmittedDepth--
        // 深度回到被抑制界线之上则清除该界线
        if (fallbackSuppressedDepth > 0 && depth < fallbackSuppressedDepth) fallbackSuppressedDepth = 0
        return
      }
      // 弹出当前帧
      const frame = stack.pop()
      // 被抑制的帧结束时不产生输出
      if (!frame || frame.suppressed) return
      // 本帧是“链接文本中的代码”结束
      if (frame.linkCode) {
        // 外层链接已不在开启状态：把代码文本并回挂起的行内代码
        if (activeLink !== frame.link || !linkOpen) {
          frame.resumedCode!.text += frame.linkCode.text
          activeCode = frame.resumedCode
          // 若链接仍匹配则清掉激活链接
          if (activeLink === frame.link) activeLink = undefined
          linkOpen = false
          return
        }
        // 链接仍开启：先输出代码，再闭合链接，然后恢复挂起的行内代码
        activeCode = undefined
        finishCode(frame.linkCode)
        if (frame.link && linkOpen) closeLink(frame.link)
        activeLink = undefined
        linkOpen = false
        activeCode = frame.resumedCode
        return
      }
      // 处于块级代码中且本帧不是代码帧：无需处理
      if (activeCode && !activeCode.inline && !frame.code) return
      // 本帧是代码帧：输出代码块并恢复挂起的链接
      if (frame.code) {
        activeCode = undefined
        finishCode(frame.code)
        if (frame.suspendedLink) activeLink = frame.suspendedLink
        return
      }
      // summary 结束：回到 details 正文模式并起块
      if (name === "summary") {
        if (activeDetails) activeDetails.summary = false
        return block()
      }
      // details 结束：恢复外层 details 并起块
      if (name === "details") {
        activeDetails = frame.details?.previous
        return block()
      }
      // dt 结束：闭合加粗
      if (name === "dt") {
        inline("**")
        return
      }
      // dd 结束：起块
      if (name === "dd") return block()
      // 行内强调结束
      const marker = inlineMarker(name)
      if (marker) {
        // 暂存待定空格状态
        const trailingSpace = pendingSpace
        pendingSpace = false
        // 恢复外层激活标记
        if (frame.marker) activeMarker = frame.marker.previous
        // 标记跨越了块边界，或标记后没有实际内容：撤销该标记（清空片段）
        if (frame.marker && (frame.marker.block !== blockCount || output.length === frame.marker.index + 1)) {
          output[frame.marker.index] = ""
          pendingSpace = trailingSpace || frame.marker.leadingSpace === true
          return
        }
        // 正常输出闭合标记
        inline(marker)
        // 恢复空格状态
        pendingSpace = trailingSpace || frame.marker?.leadingSpace === true
        return
      }
      // 链接结束：若仍是激活链接则闭合 "]()"
      if (name === "a") {
        if (frame.link && (activeLink === frame.link || !activeLink)) {
          activeLink = frame.link
          // 链接开启中或已有文本输出则补闭合
          if (linkOpen || (last && last !== "\n")) closeLink(frame.link)
          linkOpen = false
          activeLink = undefined
        }
        return
      }
      // 标题或块级容器结束：起块并恢复挂起的链接
      if (/^h[1-6]$/.test(name) || blocks.has(name)) {
        block()
        if (frame.suspendedLink) activeLink = frame.suspendedLink
        return
      }
      // blockquote 结束：深度减一并起块，恢复挂起链接
      if (name === "blockquote") {
        quoteDepth--
        block()
        if (frame.suspendedLink) activeLink = frame.suspendedLink
        return
      }
      // 列表项结束：恢复外层列表项并起块
      if (name === "li") {
        activeItem = frame.item?.previous
        return block()
      }
      // 列表结束：恢复外层列表、起块、恢复挂起链接
      if (name === "ul" || name === "ol") {
        activeList = frame.list?.previous
        block()
        if (frame.suspendedLink) activeLink = frame.suspendedLink
        return
      }
      // 表头/单元格结束（顶层表格）：回取单元格文本，压平空白，转义竖线，收进行
      if ((name === "th" || name === "td") && tableDepth === 1) {
        activeCell = undefined
        if (frame.cell) {
          const value = take(frame.cell.start)
            .replace(/[\t\r\n ]+/g, " ")
            .trim()
            .replace(/(?<!\\)\|/g, "\\|")
          activeTable?.row?.push(value)
        }
        return
      }
      // 行结束（顶层表格）：收行并复位
      if (name === "tr") {
        if (tableDepth !== 1) return
        if (activeTable?.row) activeTable.rows.push(activeTable.row)
        if (activeTable) activeTable.row = undefined
        pendingSpace = true
        return
      }
      // 标题结束（顶层表格）：回取文本压平后记为表格标题
      if (name === "caption" && frame.caption && activeTable) {
        activeTable.caption = take(frame.caption.start)
          .replace(/[\t\r\n ]+/g, " ")
          .trim()
        return
      }
      // 表格结束
      if (name === "table") {
        tableDepth--
        // 顶层表格收尾
        if (tableDepth === 0) {
          const table = frame.table
          activeTable = table?.previous
          if (table) {
            // 回取表格起始到现在的所有“松散文本”（表格前的游离内容）
            const loose = take(table.start)
              .replace(/[\t\r\n ]+/g, " ")
              .trim()
            // 首行列数
            const width = table.rows[0]?.length ?? 0
            // 判断是否矩形（每行列数一致），矩形才能渲染成管道表格
            const rectangular = width > 0 && table.rows.every((row) => row.length === width)
            // 有游离文本则先输出
            if (loose) {
              append(loose)
              block()
            }
            // 有标题则输出标题
            if (table.caption) {
              append(table.caption)
              block()
            }
            // 非降级且是矩形：渲染标准管道表格
            if (!table.fallback && rectangular) {
              // 组装前缀（引用 + 缩进）
              const prefix = `${quoteDepth > 0 ? quotePrefix() : ""}${pendingIndent}`
              pendingIndent = ""
              // 输出表头行与分隔行
              append(`${prefix}| ${table.rows[0].join(" | ")} |\n${prefix}|${" --- |".repeat(width)}`)
              // 逐行输出数据行
              for (const row of table.rows.slice(1)) append(`\n${prefix}| ${row.join(" | ")} |`)
            } else {
              // 降级渲染：每行作为一段文本输出，行间用空行分隔
              for (const [index, row] of table.rows.entries()) {
                if (index > 0) block()
                append(row.join(" | "))
              }
            }
          }
          // 表格收尾起块
          block()
          if (frame.suspendedLink) activeLink = frame.suspendedLink
          return
        }
        // 嵌套表格结束：只记空格
        pendingSpace = true
      }
    },
  })
  // 分块（每 64KB）喂给解析器，避免单次超大字符串
  for (let index = 0; index < html.length; index += 64 * 1024) parser.write(html.slice(index, index + 64 * 1024))
  // 结束解析
  parser.end()

  // 归一化后的最终文本行
  const normalized: string[] = []
  // 累积中的普通文本
  let pendingText = ""
  // 把累积文本做空白归一化后推入结果
  const flushText = () => {
    // 无积压文本则返回
    if (!pendingText) return
    // 预处理：行尾空格保留硬换行的两空格形式，其余删掉；3 个以上换行压缩为 2 个；按行拆分
    const lines = pendingText
      .replace(/[ \t]+\n/g, (space) => (space.startsWith("  ") ? "  \n" : "\n"))
      .replace(/\n{3,}/g, "\n\n")
      .split("\n")
    normalized.push(
      lines
        .map((line, index) => {
          // 非空行原样保留
          if (line) return line
          // 空行：取前后行的引用前缀
          const before = lines[index - 1]?.match(/^(?:> )+/)?.[0]
          const after = lines[index + 1]?.match(/^(?:> )+/)?.[0]
          // 缺失或不一致时原样返回
          if (!before || !after || before.length === after.length) return line
          // 空行落在引用深度变化处：补齐较浅一侧的引用前缀，保持引用块连续
          return "> ".repeat(Math.min(before.length, after.length) / 2).trimEnd()
        })
        .join("\n"),
    )
    pendingText = ""
  }
  // 遍历输出片段：raw 片段直接推入，普通文本先累积
  for (const chunk of output) {
    if (typeof chunk !== "string") {
      flushText()
      normalized.push(chunk.raw)
      continue
    }
    pendingText += chunk
  }
  // 冲掉残余文本
  flushText()
  // 拼接、去首尾空白，并按总限额截断后返回
  return sliceBytes(normalized.join("").trim(), MAX_MARKDOWN_BYTES)
}
