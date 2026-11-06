// 配置监视（Config Watch）模块：根据发现的配置来源生成需要监视的文件/目录清单。
export * as ConfigWatch from "./watch.js"

// 导入 Node 的 path 模块，用于取目录名与文件名。
import path from "path"
// 导入文件系统工具（判断包含关系与忽略通配）。
import { FSUtil } from "@opencode/util/fs-util"
// 导入监视器输入类型。
import type { Watcher } from "../filesystem/watcher.js"
// 导入配置来源类型。
import type { ConfigDiscovery } from "./discovery.js"

// 根据配置来源计算监视计划：返回 监视键 → 监视输入 的映射。
export function plan(sources: ConfigDiscovery.Sources) {
  // 需要整目录监视的目录：存在的系统目录、全局目录与存在的项目根目录。
  const directories = [
    ...(sources.system?.present ? [sources.system.path] : []),
    ...(sources.global ? [sources.global] : []),
    ...sources.project.filter((root) => root.present).map((root) => root.path),
  ]
  // 需要按文件/条目监视的路径全集：系统目录、直接配置文件、项目根、.claude、.agents 与显式指定文件。
  const files = [
    ...(sources.system ? [sources.system.path] : []),
    ...sources.direct,
    ...sources.project.map((root) => root.path),
    ...sources.claude,
    ...sources.agents,
    ...(sources.explicit ? [sources.explicit] : []),
  ]
  // Keep a parent watch for each root so deletion/recreation is observable.
  // 不被目录监视覆盖的文件按其父目录分组：保留对父目录的监视，删除/重建才可被观察到。
  const parents = Map.groupBy(
    files.filter((file) => !directories.some((directory) => file !== directory && FSUtil.contains(directory, file))),
    (file) => path.dirname(file),
  )
  // 组装最终计划：目录监视与父目录条目监视，以 JSON 键去重。
  return new Map(
    [
      // 每个配置根用整目录监视并应用通用忽略规则。
      ...directories.map((path) => ({
        path,
        type: "directory" as const,
        ignore: FSUtil.ignoreGlobs,
      })),
      // 每个父目录只监视其中关心的文件名集合。
      ...Array.from(parents, ([parent, files]) => ({
        path: parent,
        type: "entries" as const,
        names: [...new Set(files.map((file) => path.basename(file)))].toSorted(),
      })),
    ].map((target) => [JSON.stringify(target), target satisfies Watcher.WatchInput]),
  )
}
