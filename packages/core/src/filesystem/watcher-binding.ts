// 导入 createRequire：在 ESM 环境中构造 CommonJS 的 require，用于加载原生绑定
import { createRequire } from "node:module"

// 构建期注入的 C 库标识（glibc/musl），运行时可能未定义
declare const OPENCODE_LIBC: string | undefined

// 原有注释：刻意做成惰性加载——在 workerd 上 import.meta.url 为 undefined 且永远不会
// 加载 watcher，因此 createRequire 绝不能在模块顶层执行。
// Lazy: on workerd import.meta.url is undefined and the watcher is never
// loaded, so createRequire must not run at module scope.
export default function load() {
  // 以当前模块为基准创建 require 函数，才能解析相对本包的原生模块
  const require = createRequire(import.meta.url)
  // 读取 libc 标识（未注入时为 undefined，后续回退为 glibc）
  const libc = typeof OPENCODE_LIBC === "undefined" ? undefined : OPENCODE_LIBC
  // 优先使用环境变量指定的 watcher 路径；否则按 平台-架构[-libc] 拼出包名加载
  return require(
    process.env.OPENCODE_PARCEL_WATCHER_PATH ??
      `@parcel/watcher-${process.platform}-${process.arch}${process.platform === "linux" ? `-${libc || "glibc"}` : ""}`,
  )
}
