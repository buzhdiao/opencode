// 以命名空间形式整体导出本模块（环境子系统的统一入口）
export * as Environment from "./index.js"

// 导出 Driver 类型：环境驱动器接口
export { type Driver } from "./driver.js"
// 导出文件子系统的类型与工具函数：目录条目、存在性判断、错误类、文件信息/接口、类型跟随
export {
  type DirEntry,
  exists,
  Failed,
  type FileInfo,
  type Files,
  type FilesImpl,
  type FileType,
  NotFound,
  typeFollowing,
  WrongKind,
} from "./files.js"
// 导出基于进程的默认实现与组装函数
export { execDefaults, makeFiles } from "./exec-defaults.js"
// 导出本地驱动器构造函数
export { makeLocalDriver } from "./local.js"
// 导出内存驱动器构造函数及其类型（用于测试等场景）
export { makeMemoryDriver, type MemoryDriver } from "./memory.js"
// 导出环境服务的接口、图层节点与服务标签
export { type Interface, node, Service } from "./environment.js"
