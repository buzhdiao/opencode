// 导入 Bun 原生构建的 fff 文件查找器（FFI 后端）
import { FileFinder } from "@ff-labs/fff-bun"
// 导入 bind：把后端绑定成统一适配器的工具
import { bind } from "./fff.js"

// 转发共享类型定义，保持与平台无关的接口一致
export type { Directory, DirSearch, File, Init, Mixed, MixedSearch, Picker, Result, Search } from "./fff.js"

// 全局声明：构建期注入的 C 库类型标识（glibc 或 musl），原生模块据此选择加载的共享库
declare global {
  const FFF_LIBC: "gnu" | "musl"
}

// 把 Bun 后端绑定成统一适配器
const adapter = bind(FileFinder)

// 导出可用性判断与创建函数
export const available = adapter.available
export const create = adapter.create

// 以命名空间形式整体导出本模块
export * as Fff from "./fff.bun.js"
