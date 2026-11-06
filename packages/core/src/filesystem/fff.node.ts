// 导入 bind：把后端绑定成统一适配器的工具
import { bind } from "./fff.js"

// 转发共享类型定义，保持与平台无关的接口一致
export type { Directory, DirSearch, File, Init, Mixed, MixedSearch, Picker, Result, Search } from "./fff.js"

// 顶层动态加载 node 原生后端；加载失败时以 undefined 兜底（保持模块可导入）
const { FileFinder } = await import("@ff-labs/fff-node").catch(() => ({ FileFinder: undefined }))

// 绑定可能缺失的后端；缺失时 create 会返回定制的“node 运行时不可用”错误
const adapter = bind(FileFinder, "fff unavailable on node runtime")

// 导出可用性判断与创建函数
export const available = adapter.available
export const create = adapter.create

// 以命名空间形式整体导出本模块
export * as Fff from "./fff.node.js"
