// 将本模块以命名空间（namespace）形式整体导出；CodeModeInstructions 负责 Code Mode 工具目录的提示词渲染与变更通知
export * as CodeModeInstructions from "./instructions.js"

// 导入搜索签名与工具表达式工具：searchSignature 生成 search 用法说明，toolExpression 渲染工具调用表达式
import { searchSignature, toolExpression } from "@opencode/codemode"
// 导入 Effect 与 Schema
import { Effect, Schema } from "effect"
// 导入指令（Instructions）框架：管理注入模型上下文的动态说明文本
import { Instructions } from "../instructions/index.js"
// 导入目录（CodeModeCatalog）：做摘要与行渲染
import { CodeModeCatalog } from "./catalog.js"

// 定义 prompt：根据"目录是否只展示了部分工具"生成 Code Mode 提示词开头（模板字符串，内部不得改动）
// prettier-ignore
const prompt = (hasMoreTools: boolean) => `# Code Mode

The tools listed below${hasMoreTools ? ", and \`search\`," : ""} cannot be called directly: they only work as JavaScript inside the \`execute\` tool. Every other tool you have is a normal tool call: call it directly, never inside \`execute\`.

${hasMoreTools ? `The catalog is partial. Before calling a tool that is not listed below, find it with the global \`search(...)\` function. Do not guess tool names. Each result's \`path\` is the complete call expression: write it out as code, for example \`await tools.ns.tool_name({ ... })\`. Do not use it as a key such as \`tools[path]\`.

- ${searchSignature}` : "The catalog is complete. Do not guess tool names."}

## Code Mode tools (call only inside \`execute\`)`

// 导出 render：把目录摘要渲染成完整的指令文本
export function render(catalog: CodeModeCatalog.Summary) {
  // 没有任何工具时返回专门说明：不要调用 execute
  if (catalog.total === 0)
    return "No Code Mode tools are currently available. Later Code Mode catalog updates may add or remove tools. Do not call `execute` unless there is at least one available Code Mode tool."

  // 把每个命名空间展开为标题行 + 其展示条目行，得到最终的工具清单文本行
  const tools = catalog.namespaces.flatMap((namespace) => {
    return [CodeModeCatalog.namespaceLine(namespace), ...namespace.entries.map((entry) => entry.line)]
  })

  // 返回提示词：标题段（含是否需要 search 的说明）+ 工具清单
  return `${prompt(catalog.shown < catalog.total)}

${tools.join("\n")}`
}

// 导出 update：对比前后两次目录摘要，生成"最小必要"的变更提示
export function update(previous: CodeModeCatalog.Summary, current: CodeModeCatalog.Summary) {
  // 准备"整体替换"文本：告知旧目录作废，附上新目录全文
  const replacement = `The Code Mode tool catalog has changed. This catalog supersedes the previous Code Mode tool catalog.

${render(current)}`
  // 新目录为空：直接用替换文本
  if (current.total === 0) return replacement
  // 判断前后目录是否都为"完整展示"（shown === total）
  const previousComplete = previous.shown === previous.total
  const currentComplete = current.shown === current.total
  // 完整性发生变化（从完整变部分或反之）：需要整体替换
  if (previousComplete !== currentComplete) return replacement

  // 先比较命名空间描述的差异（按命名空间名对齐）
  const descriptions = Instructions.diffByKey(
    previous.namespaces.filter((namespace) => namespace.description !== undefined),
    current.namespaces.filter((namespace) => namespace.description !== undefined),
    (namespace) => namespace.name,
    (before, after) => before.description !== after.description,
  )
  // 描述有增删改：需要整体替换
  if (descriptions.added.length > 0 || descriptions.removed.length > 0 || descriptions.changed.length > 0)
    return replacement

  // 再比较全部条目行的差异（按 path 对齐）
  const diff = Instructions.diffByKey(
    previous.namespaces.flatMap((namespace) => namespace.entries),
    current.namespaces.flatMap((namespace) => namespace.entries),
    (entry) => entry.path,
    (before, after) => before.line !== after.line,
  )
  // 条目是否有任何变化
  const entriesChanged = diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0

  // 当前目录只展示了部分工具（部分目录模式）
  if (!currentComplete) {
    // 条目有变化：整体替换（部分模式下不做细粒度提示）
    if (entriesChanged) return replacement
    // 再比较各命名空间的工具数量差异
    const namespaces = Instructions.diffByKey(
      previous.namespaces,
      current.namespaces,
      (namespace) => namespace.name,
      (before, after) => before.count !== after.count,
    )
    // 数量是否有任何增删改
    const changed = namespaces.added.length > 0 || namespaces.removed.length > 0 || namespaces.changed.length > 0
    // 没有任何变化却走到这里：仍需替换（保守处理）
    if (!changed) return replacement

    // 开始拼接增量提示文本
    const parts = ["The Code Mode tool catalog has changed."]
    // 有新增命名空间：列出名字与工具数
    if (namespaces.added.length > 0) {
      parts.push(
        `New tool namespaces are available: ${namespaces.added
          .map((namespace) => `\`${namespace.name}\` (${namespace.count} tools)`)
          .join(", ")}.`,
      )
    }
    // 有数量变化的命名空间：提示需要重新 search
    if (namespaces.changed.length > 0) {
      parts.push(
        `The following namespace inventories changed; search them again before relying on previous results: ${namespaces.changed
          .map((change) => `\`${change.current.name}\` now has ${change.current.count} tools`)
          .join(", ")}.`,
      )
    }
    // 有被移除的命名空间：明确禁止继续使用
    if (namespaces.removed.length > 0) {
      parts.push(
        `The following tool namespaces are no longer available and must not be used: ${namespaces.removed
          .map((namespace) => `\`${namespace.name}\``)
          .join(", ")}.`,
      )
    }
    // 把各段拼成增量文本
    const delta = parts.join("\n\n")
    // 增量文本更短则用增量，否则退回整体替换
    if (delta.length < replacement.length) return delta
    return replacement
  }

  // 完整目录模式下：条目没变则无需任何提示，返回整体替换文本（由调用方判断是否真正变化）
  if (!entriesChanged) return replacement
  // 开始拼接条目级增量提示
  const parts = ["The Code Mode tool catalog has changed."]
  // 有新增工具：逐行列出其展示行
  if (diff.added.length > 0) {
    parts.push(
      [
        "New tools are available in addition to those previously listed:",
        ...diff.added.map((entry) => entry.line),
      ].join("\n"),
    )
  }
  // 有变化的工具：声明新行覆盖旧行
  if (diff.changed.length > 0) {
    parts.push(
      [
        "Changed tool listings supersede the previously listed ones:",
        ...diff.changed.map((change) => change.current.line),
      ].join("\n"),
    )
  }
  // 有被移除的工具：以调用表达式的形式明确禁止
  if (diff.removed.length > 0) {
    parts.push(
      `The following tools are no longer available and must not be called: ${diff.removed
        .map((entry) => toolExpression(entry.path))
        .join(", ")}.`,
    )
  }
  // 把各段拼成增量文本
  const delta = parts.join("\n\n")
  // 增量更短则用增量，否则退回整体替换
  if (delta.length < replacement.length) return delta
  return replacement
}

// 定义本指令段在指令集合中的键
const key = Instructions.Key.make("core/codemode")
// 构建目录摘要的 JSON 编解码器（跨请求持久化/比较用）
const codec = Schema.toCodecJson(CodeModeCatalog.Summary)

// 导出 make：由可选清单构建一个 Instructions 列表项
export const make = (inventory?: CodeModeCatalog.Inventory): Instructions.List => {
  // 未提供清单时标记为"已移除"，否则做摘要
  const catalog = inventory === undefined ? Instructions.removed : CodeModeCatalog.summarize(inventory)
  // 组装指令项：键、编解码器、当前摘要与渲染策略
  return Instructions.make({
    key,
    codec,
    // read：直接返回已算好的摘要
    read: Effect.succeed(catalog),
    render: {
      // 初始渲染用 render
      initial: render,
      // 变化时用 update 生成差异提示
      changed: update,
      // 被移除时的提示文本
      removed: () => "Code Mode tools are no longer available. Do not use any previously listed Code Mode tools.",
    },
  })
}
