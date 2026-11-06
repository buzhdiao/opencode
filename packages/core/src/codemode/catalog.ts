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
  // 调用签名（展示给模型的代码形态）
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

// 定义 NamespaceSummary 模式：单个命名空间的摘要
const NamespaceSummary = Schema.Struct({
  // 命名空间名
  name: Schema.String,
  // 可选描述
  description: Schema.optionalKey(Schema.String),
  // 该命名空间的工具总数
  count: Schema.Number,
  // 实际展示的条目列表
  entries: Schema.Array(Listing),
})

// 导出 Summary 模式：整个清单的摘要（总数、展示数、各命名空间摘要）
export const Summary = Schema.Struct({
  // 工具总数
  total: Schema.Number,
  // 本次展示的工具数
  shown: Schema.Number,
  // 各命名空间的摘要数组
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

// Keep every namespace visible, then select full listings one per namespace per round,
// considering shorter listings first until the inline budget is exhausted.
// summarize：把完整清单压缩为摘要——保留所有命名空间行，再按"每轮各命名空间挑一条、短者优先"的规则挑选条目，直到预算耗尽
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
      // 为组内每个工具生成展示行，并按路径排序
      const listings = namespaceEntries
        .map((entry) => {
          // 取描述的第一行并去除首尾空白
          const firstLine = entry.description.split("\n", 1)[0]?.trim() ?? ""
          // 超过长度上限时截断并加省略号
          const description =
            firstLine.length > DESCRIPTION_LIMIT ? firstLine.slice(0, DESCRIPTION_LIMIT - 3) + "..." : firstLine
          // 描述非空时拼出 " // 描述" 后缀
          const suffix = description.length === 0 ? "" : ` // ${description}`
          // 生成形如 "  - signature // 描述" 的展示行
          return { path: entry.path, line: `  - ${entry.signature}${suffix}` }
        })
        .toSorted((left, right) => {
          // 展示行按路径字典序排序
          if (left.path < right.path) return -1
          if (left.path > right.path) return 1
          return 0
        })
      // 对排序后的展示行做"成本排名"（按行长度换算的 token 成本升序）
      const ranked = rankListings(listings)
      // 收集被 pinned 的工具对应的展示行集合
      const pinned = new Set(
        namespaceEntries
          .filter((entry) => entry.pinned)
          .map((entry) => listings.find((listing) => listing.path === entry.path))
          .filter((listing) => listing !== undefined),
      )
      // 组装内部命名空间对象：含备选顺序、已选集合与选择游标
      return {
        name,
        // 描述存在时才带上该字段
        ...(description === undefined ? {} : { description }),
        listings,
        // 候选顺序：成本排名中未被 pinned 的条目
        selectionOrder: ranked.filter((candidate) => !pinned.has(candidate.listing)),
        // 已选集合初始为 pinned 的条目
        selectedListings: pinned,
        // 选择游标：下一轮应取的候选下标
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
            count: namespace.listings.length,
            entries: [],
          }),
        ),
      0,
    ) -
    namespaces
      .flatMap((namespace) => namespace.listings.filter((listing) => namespace.selectedListings.has(listing)))
      .reduce((total, listing) => total + cost(listing.line), 0)
  // 多轮挑选：每轮每个活跃命名空间尝试纳入一个候选
  while (active.size > 0) {
    // 遍历当前活跃的命名空间
    for (const namespace of active) {
      // 取该命名空间的下一个候选
      const candidate = namespace.selectionOrder[namespace.selectionIndex]
      // 没有更多候选，或该候选成本超过剩余预算：本命名空间出局
      if (!candidate || candidate.cost > remaining) {
        active.delete(namespace)
        continue
      }
      // 把候选加入已选集合
      namespace.selectedListings.add(candidate.listing)
      // 前进选择游标
      namespace.selectionIndex += 1
      // 扣减剩余预算
      remaining -= candidate.cost
      // 候选耗尽时把命名空间移出活跃集合
      if (namespace.selectionIndex === namespace.selectionOrder.length) active.delete(namespace)
    }
  }

  // 把内部命名空间对象映射为最终的 NamespaceSummary
  const namespaceSummaries = namespaces.map((namespace) => ({
    name: namespace.name,
    // 描述存在时才携带
    ...(namespace.description === undefined ? {} : { description: namespace.description }),
    count: namespace.listings.length,
    // entries 只包含最终被选中的展示行
    entries: namespace.listings.filter((listing) => namespace.selectedListings.has(listing)),
  }))
  // 返回最终摘要：总数、展示数与各命名空间摘要
  return {
    total: flattened.tools.length,
    shown: namespaceSummaries.reduce((total, namespace) => total + namespace.entries.length, 0),
    namespaces: namespaceSummaries,
  }
}

// 定义 flatten：把嵌套的 Tool/Namespace 树摊平为工具列表与"命名空间全名 -> 命名空间"映射
function flatten(entries: ReadonlyArray<Tool | Namespace>, path: ReadonlyArray<string> = []) {
  // 累积的工具列表（path 为点分全路径）
  const tools: Array<Omit<Tool, "name"> & { readonly path: string }> = []
  // 累积的命名空间映射
  const namespaces = new Map<string, Namespace>()
  // 遍历每个条目
  for (const entry of entries) {
    // 工具条目：记录为带全路径的展示项
    if (entry.type === "tool") {
      tools.push({
        type: "tool",
        path: [...path, entry.name].join("."),
        description: entry.description,
        signature: entry.signature,
        ...(entry.pinned === undefined ? {} : { pinned: entry.pinned }),
      })
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

// 导出 namespaceLine：渲染命名空间标题行，例如 "- fs (3 tools, 1 shown) // 描述"
export function namespaceLine(namespace: typeof NamespaceSummary.Type) {
  // 工具数文案：单数不带 s
  const count = namespace.count === 1 ? "1 tool" : `${namespace.count} tools`
  // 展示情况文案：全部展示 / 一个都没展示 / 部分展示
  const label =
    namespace.entries.length === namespace.count
      ? count
      : namespace.entries.length === 0
        ? `${count}, none shown`
        : `${count}, ${namespace.entries.length} shown`
  // 拼接标题行（有描述时追加 " // 描述"）
  return `- ${namespace.name} (${label})${namespace.description === undefined ? "" : ` // ${namespace.description}`}`
}

// 定义 rankListings：把展示行按"成本（token 估算）升序、路径字典序次之"排名
function rankListings(listings: ReadonlyArray<typeof Listing.Type>) {
  return listings
    // 为每行计算成本
    .map((listing) => ({ listing, cost: cost(listing.line) }))
    .toSorted((left, right) => {
      // 先按成本升序
      if (left.cost !== right.cost) return left.cost - right.cost
      // 成本相同再按路径字典序
      if (left.listing.path < right.listing.path) return -1
      if (left.listing.path > right.listing.path) return 1
      return 0
    })
}

// 定义 cost：按"字符数 / 4"粗略估算文本的 token 数
function cost(text: string) {
  return Math.round(text.length / CHARACTERS_PER_TOKEN)
}
