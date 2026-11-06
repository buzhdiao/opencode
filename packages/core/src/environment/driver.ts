// 仅作类型导入：ChildProcessSpawner 服务类型（Effect 的子进程派生器接口）
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
// 仅作类型导入：本目录 files.ts 中的 FilesImpl 实现（文件操作的具体实现接口）
import type { FilesImpl } from "./files.js"

// Driver 接口：环境驱动器，抽象“文件操作 + 进程派生”能力来源（本地/远程等不同实现）
export interface Driver {
  // spawner：底层子进程派生器服务，用于执行 shell 脚本等
  readonly spawner: ChildProcessSpawner["Service"]
  // overrides：可选的部分文件操作实现覆盖（例如远程驱动替换默认的本地实现）
  readonly overrides?: Partial<FilesImpl>
}

// 以命名空间形式整体导出本模块
export * as EnvironmentDriver from "./driver.js"
