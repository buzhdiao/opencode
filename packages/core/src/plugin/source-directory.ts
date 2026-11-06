// 将本模块以命名空间 `PluginSourceDirectory` 全量导出
export * as PluginSourceDirectory from "./source-directory.js"

// 引入文件系统工具（FSUtil）接口类型，抽象目录/文件读取操作
import { FSUtil } from "@opencode/util/fs-util"
// 引入 Effect 原语与 Option（可选值类型：Some/None）
import { Effect, Option } from "effect"
// 引入 Node.js path 模块做跨平台路径拼接
import path from "path"

// 插件目录的候选名称：兼容 "plugin" 与 "plugins" 两种命名习惯
export const names = ["plugin", "plugins"] as const

// 发现已登记的插件来源：扫描指定目录下的 plugin/plugins 子目录，返回可加载的目标路径列表
export const discover = Effect.fn("PluginSourceDirectory.discover")(function* (
  fs: FSUtil.Interface,
  directory: string,
) {
  // 依次读取两个候选目录；目录不存在时以空数组兜底，并把每项补充为完整目标路径
  const children = (yield* Effect.forEach(names, (source) =>
    fs.readDirectoryEntries(path.join(directory, source)).pipe(
      Effect.orElseSucceed(() => []),
      Effect.map((entries) => entries.map((entry) => ({ ...entry, target: path.join(directory, source, entry.name) }))),
    ),
  ))
    // 拍平两个目录的扫描结果为一个列表
    .flat()
    // 按目标路径字典序排序，保证发现顺序稳定可复现
    .sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0))
  // 逐项判定该路径能否作为插件加载目标，结果包装为 Option
  const targets = yield* Effect.forEach(children, (entry) =>
    Effect.gen(function* () {
      // 判断路径是否以 .ts/.js 源文件后缀结尾
      const source = entry.target.endsWith(".ts") || entry.target.endsWith(".js")
      // 普通源码文件：直接可作为插件目标
      if (entry.type === "File" && source) return Option.some(entry.target)
      // 目录：视为目录型插件（含多个文件的插件包）
      if (entry.type === "Directory") return Option.some(entry.target)
      // 其余非符号链接类型一律忽略
      if (entry.type !== "SymbolicLink") return Option.none<string>()
      // 符号链接指向源码：需确认链接目标确实是文件后才接受
      if (source && (yield* fs.isFile(entry.target))) return Option.some(entry.target)
      // 符号链接指向目录：确认目标是目录后接受
      if (yield* fs.isDir(entry.target)) return Option.some(entry.target)
      // 其余情况：不作为插件目标
      return Option.none<string>()
    }),
  )
  // 丢弃 None，把 Some 展开为路径值，返回最终目标列表
  return targets.flatMap(Option.toArray)
})
