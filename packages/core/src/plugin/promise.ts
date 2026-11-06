// 以命名空间形式整体再导出本模块
export * as PluginPromise from "./promise.js"

// 转发导出 promise 适配器（adapter）：把基于 Promise 的旧式插件包装成 Effect 插件
export { fromPromise } from "@opencode/plugin/promise/adapter"
