// 将本模块以命名空间（namespace）形式整体导出；CodeModeCatalog 负责把工具清单压缩为带预算的摘要（summary）
export * as CodeModeCatalog from "./catalog.js"

// 导入 Effect 的 Schema：定义摘要结构并支持 JSON 编解码
import { Schema } from "effect"

// 定义 Tool（工具）类型：清单里的单个工具条目
export type Tool = {
  // 类型标记：固定为 "tool"
  readonly type: "tool"
  // 工具名（不含命名空间前缀）
  readonly name: string
  // 工具描述
  readonly description: string
  /** Read only for the tools the catalog shows. */
  readonly signature: string
  // 是否固定展示（pinned）：为 true 时始终进入摘要
  readonly pinned?: boolean
}

// 定义 Namespace（命名空间）类型：一组工具或子命名空间的容器
export type Namespace = {
  // 类型标记：固定为 "namespace"
  readonly type: "namespace"
  // 命名空间名
  readonly name: string
  // 可选描述
  readonly description?: string
  // 包含的工具/子命名空间列表
  readonly tools: ReadonlyArray<Tool | Namespace>
}

// 定义 Inventory（清单）类型：顶层工具/命名空间的集合
export type Inventory = {
  // 工具与命名空间的只读数组
  readonly tools: ReadonlyArray<Tool | Namespace>
}

// 定义 Listing 模式：单个工具的展示行（path 为完整调用路径，line 为渲染好的文本行）
const Listing = Schema.Struct({
  // 完整点分路径，例如 "fs.read"
  path: Schema.String,
  // 渲染后的单行文本
  line: Schema.String,
})
export type Listing = typeof Listing.Type

// 定义 NamespaceSummary 模式：单个命名空间的摘要
const NamespaceSummary = Schema.Struct({
  // 命名空间名
  name: Schema.String,
  // 可选描述
  description: Schema.optionalKey(Schema.String),
  /** Every tool's path, so an update can tell a new tool from one that was not shown. */
  tools: Schema.Array(Schema.String),
  entries: Schema.Array(Listing),
})
export type NamespaceSummary = typeof NamespaceSummary.Type

// 导出 Summary 模式：整个清单的摘要（总数、展示数、各命名空间摘要）
export const Summary = Schema.Struct({
  // 工具总数
  total: Schema.Number,
  namespaces: Schema.Array(NamespaceSummary),
})
// 导出 Summary 的类型别名
export type Summary = typeof Summary.Type

// 定义可选项：budget 为内联展示的 token 预算
export type Options = {
  // 可选的字符预算（以 token 估算）
  readonly budget?: number
}

// 单条描述的最大字符数（超过则截断加省略号）
const DESCRIPTION_LIMIT = 120
// 粗略的"每 token 字符数"换算系数
const CHARACTERS_PER_TOKEN = 4
// 默认的内联预算：约 2000 token
const INLINE_BUDGET = 2_000

// Keep every namespace visible, then select full listings one per namespace per round, in path order, until the
// inline budget is exhausted. The selection depends only on the tools, and only selected signatures are rendered.
export function summarize(inventory: Inventory, options: Options = {}): Summary {
  // 读取预算（未传时用默认值）
  const budget = options.budget ?? INLINE_BUDGET
  // 把嵌套清单摊平成工具列表与命名空间映射
  const flattened = flatten(inventory.tools)
  // 按工具路径的第一段（命名空间名）分组并排序
  const namespaces = [...Map.groupBy(flattened.tools, (tool) => tool.path.split(".", 1)[0] ?? tool.path)]
    // 按命名空间名字典序排序
    .sort(([left], [right]) => {
      if (left < right) return -1
      if (left > right) return 1
      return 0
    })
    // 把每个分组加工成内部命名空间对象
    .map(([name, namespaceEntries]) => {
      // 取该命名空间的描述（若有）
      const description = flattened.namespaces.get(name)?.description
      const sorted = namespaceEntries.toSorted((left, right) => {
        if (left.path < right.path) return -1
        if (left.path > right.path) return 1
        return 0
      })
      return {
        name,
        // 描述存在时才带上该字段
        ...(description === undefined ? {} : { description }),
        tools: sorted.map((entry) => entry.path),
        selectionOrder: sorted.filter((entry) => !entry.tool.pinned),
        selectedListings: sorted.filter((entry) => entry.tool.pinned).map(listing),
        selectionIndex: 0,
      }
    })

  // 活跃集合：尚有候选未考虑的命名空间
  const active = new Set(namespaces)
  // TODO: Bound namespace discovery once large namespace inventories and descriptions can no longer stay inline.
  // 计算剩余预算：总预算减去所有命名空间标题行的成本，再减去 pinned 条目行的成本
  let remaining =
    budget -
    namespaces.reduce(
      (total, namespace) =>
        total +
        cost(
          namespaceLine({
            name: namespace.name,
            ...(namespace.description === undefined ? {} : { description: namespace.description }),
            tools: namespace.tools,
            entries: [],
          }),
        ),
      0,
    ) -
    namespaces
      .flatMap((namespace) => namespace.selectedListings)
      .reduce((total, listing) => total + cost(listing.line), 0)
  // 多轮挑选：每轮每个活跃命名空间尝试纳入一个候选
  while (active.size > 0) {
    // 遍历当前活跃的命名空间
    for (const namespace of active) {
      const entry = namespace.selectionOrder[namespace.selectionIndex]
      const candidate = entry && listing(entry)
      if (!candidate || cost(candidate.line) > remaining) {
        active.delete(namespace)
        continue
      }
      namespace.selectedListings.push(candidate)
      namespace.selectionIndex += 1
      remaining -= cost(candidate.line)
      if (namespace.selectionIndex === namespace.selectionOrder.length) active.delete(namespace)
    }
  }

  return {
    total: flattened.tools.length,
    namespaces: namespaces.map((namespace) => ({
      name: namespace.name,
      ...(namespace.description === undefined ? {} : { description: namespace.description }),
      tools: namespace.tools,
      entries: namespace.selectedListings,
    })),
  }
}

/** Looks up any tool's listing as the catalog would show it. */
export function lookup(inventory: Inventory) {
  const tools = new Map(flatten(inventory.tools).tools.map((entry) => [entry.path, entry]))
  return (path: string) => {
    const entry = tools.get(path)
    return entry === undefined ? undefined : listing(entry)
  }
}

function listing(entry: { readonly path: string; readonly tool: Tool }) {
  const firstLine = entry.tool.description.split("\n", 1)[0]?.trim() ?? ""
  const description =
    firstLine.length > DESCRIPTION_LIMIT ? firstLine.slice(0, DESCRIPTION_LIMIT - 3) + "..." : firstLine
  const suffix = description.length === 0 ? "" : ` // ${description}`
  return { path: entry.path, line: `  - ${entry.tool.signature}${suffix}` }
}

function flatten(entries: ReadonlyArray<Tool | Namespace>, path: ReadonlyArray<string> = []) {
  const tools: Array<{ readonly path: string; readonly tool: Tool }> = []
  const namespaces = new Map<string, Namespace>()
  // 遍历每个条目
  for (const entry of entries) {
    // 工具条目：记录为带全路径的展示项
    if (entry.type === "tool") {
      tools.push({ path: [...path, entry.name].join("."), tool: entry })
      continue
    }
    // 命名空间条目：计算子路径全名并登记
    const next = [...path, entry.name]
    namespaces.set(next.join("."), entry)
    // 递归摊平子命名空间
    const nested = flatten(entry.tools, next)
    // 合并子级工具
    tools.push(...nested.tools)
    // 合并子级命名空间映射
    for (const [name, namespace] of nested.namespaces) namespaces.set(name, namespace)
  }
  // 返回摊平结果
  return { tools, namespaces }
}

export function namespaceLine(namespace: NamespaceSummary, shown = namespace.entries.length) {
  const count = namespace.tools.length === 1 ? "1 tool" : `${namespace.tools.length} tools`
  const label =
    shown === namespace.tools.length ? count : shown === 0 ? `${count}, none shown` : `${count}, ${shown} shown`
  return `- ${namespace.name} (${label})${namespace.description === undefined ? "" : ` // ${namespace.description}`}`
}

export function cost(text: string) {
  return Math.round(text.length / CHARACTERS_PER_TOKEN)
}
