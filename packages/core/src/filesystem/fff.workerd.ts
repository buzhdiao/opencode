// 导入 bind：把后端绑定成统一适配器的工具
import { bind } from "./fff.js"

// 转发共享类型定义，保持与平台无关的接口一致
export type { Directory, DirSearch, File, Init, Mixed, MixedSearch, Picker, Result, Search } from "./fff.js"

// 原有注释：workerd（Cloudflare Workers 运行时）上不存在 fff 后端；所有 create 都报告不可用，
// FileSystemSearch 会像在缺少原生模块的运行时上一样自动降级。
// No fff backend exists on workerd; every create reports unavailability and
// FileSystemSearch degrades the same way it does on a runtime without the native module.
// 显式传入 undefined 后端，并定制不可用错误文案
const adapter = bind(undefined, "fff unavailable on workerd runtime")

// 导出可用性判断（恒为 false）与创建函数（恒失败）
export const available = adapter.available
export const create = adapter.create

// 以命名空间形式整体导出本模块
export * as Fff from "./fff.workerd.js"
