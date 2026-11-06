// 技能扫描（Skill Scan）模块：在目录树中查找 SKILL.md 与顶层技能 Markdown 文件。
export * as SkillScan from "./skill-scan.js"

// 导入文件系统工具（忽略规则与忽略目录列表）。
import { FSUtil } from "@opencode/util/fs-util"
// 导入 Node 的 path 模块。
import path from "path"
// 导入 Effect。
import { Effect } from "effect"

// 递归扫描的最大深度。
const MAX_DEPTH = 6

// 监视/扫描时应用的忽略规则：通用忽略加隐藏文件与隐藏目录。
export const ignore = [...FSUtil.ignoreGlobs, "**/.*", "**/.*/**"]

// 广度优先扫描技能文件：命中 SKILL.md 的目录不再下钻。
export const scan = Effect.fn("SkillScan.scan")(function* (root: string) {
  // 获取文件系统工具服务。
  const fs = yield* FSUtil.Service
  // 收集到的技能文件路径。
  const files: string[] = []
  // 待处理队列：目录加深度。
  const queue = [{ directory: root, depth: 0 }]
  // 逐个处理队列中的目录。
  for (const item of queue) {
    // 读取目录条目（失败视为空目录）。
    const entries = yield* fs.readDirectoryEntries(item.directory).pipe(Effect.orElseSucceed(() => []))
    // 过滤隐藏项与系统忽略目录后，解析符号链接的真实类型。
    const children = yield* Effect.forEach(
      entries.filter((entry) => !entry.name.startsWith(".") && !FSUtil.ignoredDirectories.includes(entry.name)),
      (entry) => {
        // 子项完整路径。
        const target = path.join(item.directory, entry.name)
        // 非符号链接直接使用条目类型。
        if (entry.type !== "SymbolicLink") return Effect.succeed({ name: entry.name, path: target, type: entry.type })
        // 符号链接：stat 解析真实类型（失败记为 Unknown）。
        return fs.stat(target).pipe(
          Effect.map((info) => info.type),
          Effect.orElseSucceed(() => "Unknown" as const),
          Effect.map((type) => ({ name: entry.name, path: target, type })),
        )
      },
    )
    // 目录内存在 SKILL.md 文件即视为技能根。
    const skill = children.find((child) => child.type === "File" && child.name === "SKILL.md")
    if (skill) {
      // 记录技能文件并不再下钻该目录。
      files.push(skill.path)
      continue
    }
    // 仅根目录层级收集散置的 .md 文件作为技能。
    if (item.depth === 0)
      files.push(
        ...children.filter((child) => child.type === "File" && child.name.endsWith(".md")).map((child) => child.path),
      )
    // 未达最大深度时把子目录加入队列。
    if (item.depth < MAX_DEPTH)
      queue.push(
        ...children
          .filter((child) => child.type === "Directory")
          .map((child) => ({ directory: child.path, depth: item.depth + 1 })),
      )
  }
  // 返回按路径排序的技能文件列表。
  return files.toSorted()
})
