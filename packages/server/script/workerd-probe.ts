#!/usr/bin/env bun
// Server 包的 workerd 打包探针，对应 package.json 的 `probe:workerd`。
// 在把 @opencode/server 部署到 Cloudflare Workers（Durable Object 内跑 opencode 核心与服务器）之前，
// 用它验证 src/workerd.ts 背后的完整模块图能在 workerd 解析条件下被打包，并暴露运行时必须供给的外部依赖。
/**
 * Bundle probe for the workerd profile: verifies the full module graph behind
 * src/workerd.ts resolves under the `workerd` condition without any `bun:`
 * builtins. `node:` builtins stay external (workerd provides them through
 * nodejs_compat); the probe prints the surviving externals so the A4 boot
 * spike knows exactly what the runtime must supply.
 */
// （上方英文文档注释原样保留：workerd 配置的打包探针——验证 src/workerd.ts 背后的完整模块图
// 能在 `workerd` 解析条件下解析、不依赖任何 `bun:` 内建；`node:` 内建保持外部化——workerd 经
// nodejs_compat 提供它们，探针会打印幸存的外部依赖清单，供 A4 启动实验明确运行时须供给什么。）
// 导入 path：拼接 workerd.ts 入口路径
import path from "node:path"
// 导入 mkdtempSync：同步创建一次性输出目录（脚本顶层直接用，同步版省一层 await）
import { mkdtempSync } from "node:fs"
// 导入 os：取系统临时目录
import os from "node:os"

// 建临时输出目录：产物只用于扫描 import，不落仓库
const outdir = mkdtempSync(path.join(os.tmpdir(), "opencode-workerd-probe-"))
// 打包 src/workerd.ts：conditions 加 "workerd" 使 #imports 等解析到 workerd 专属实现（如 sqlite.workerd），
// target=node 保持 node: 内建外部化；throw:false 让失败以返回值呈现而非抛异常
const result = await Bun.build({
  // 打包入口：本脚本上一级的 src/workerd.ts（Server 的 workerd 入口）
  entrypoints: [path.join(import.meta.dir, "../src/workerd.ts")],
  // 模块解析条件：启用 workerd 变体
  conditions: ["workerd"],
  // 目标运行时：node（在 workerd 上靠 nodejs_compat 兼容）
  target: "node",
  // 产物写入上面的临时目录
  outdir,
  // 不生成 sourcemap（探针只关心模块图与体积）
  sourcemap: "none",
  // 打包失败不抛异常，由下面的 result.success 分支统一报错
  throw: false,
})

// 打包失败：打印问题数量与每条日志，非零退出
if (!result.success) {
  console.error(`workerd bundle probe FAILED (${result.logs.length} issues)`)
  for (const log of result.logs) console.error(String(log))
  process.exit(1)
}

// Everything in the graph is bundled, so any import specifier that survives in
// the output is an external the runtime must provide. A specifier reached only
// through `import()` is loaded lazily behind a runtime guard, so it costs
// nothing on a runtime that never takes that branch; a static import is
// evaluated on module load and must resolve.
// （上方英文注释原样保留：整图已被打包，所以产物里幸存的 import 说明符就是运行时必须提供的外部依赖；
// 只经动态 import() 到达的说明符被运行时守卫懒加载，在永远不会走到该分支的运行时上零成本；
// 而静态 import 在模块求值时就要解析，必须能被运行时满足。）
// Bun 的 JS 转译器：扫描产物文本里的 import 语句，比正则更可靠
const transpiler = new Bun.Transpiler({ loader: "js" })
// 收集外部依赖：说明符 → 是否被静态导入
const externals = new Map<string, { static: boolean }>()
// 记录一个说明符：isStatic 与既有记录取或（同一说明符动态+静态并存时按静态算，从严处理）
const record = (specifier: string, isStatic: boolean) => {
  const seen = externals.get(specifier)
  externals.set(specifier, { static: (seen?.static ?? false) || isStatic })
}
// 逐个产物扫描 import
for (const artifact of result.outputs) {
  // 取产物文本
  const text = await artifact.text()
  // ESM import 声明：kind 不是 dynamic-import 的视为静态导入
  for (const imported of transpiler.scanImports(text)) record(imported.path, imported.kind !== "dynamic-import")
  // 再用正则抓 CJS require("...") 调用——require 在模块求值时执行，一律按静态算
  for (const match of text.matchAll(/\brequire\(\s*"([^"]+)"\s*\)/g)) record(match[1], true)
}
// 说明符排序，输出稳定、便于两次探针结果对比
const sorted = Array.from(externals.keys()).toSorted()
// 判断是否 Bun 内建模块（"bun" 本身或 "bun:" 前缀）
const isBun = (specifier: string) => specifier === "bun" || specifier.startsWith("bun:")
// 泄漏清单：被静态导入的 bun 内建——workerd 上没有 Bun 全局，这些模块加载即崩
const leaked = sorted.filter((specifier) => isBun(specifier) && externals.get(specifier)!.static)
// 统计产物总字节数
const bytes = result.outputs.reduce((total, artifact) => total + artifact.size, 0)

// 打包成功：输出产物数量与总体积
console.log(`workerd bundle probe OK: ${result.outputs.length} artifacts, ${(bytes / 1024 / 1024).toFixed(1)} MiB`)
// 打印外部依赖清单标题
console.log(`external builtins (${sorted.length}):`)
// 逐行打印外部说明符；仅被动态导入的标注 (lazy)
for (const specifier of sorted) {
  const lazy = externals.get(specifier)!.static ? "" : " (lazy)"
  console.log(`  ${specifier}${lazy}`)
}
// 有 bun 内建被静态导入即判失败并退出非零：workerd 无法供给，需改代码消除泄漏
if (leaked.length > 0) {
  console.error(`FAILED: bun builtins statically imported in the workerd graph: ${leaked.join(", ")}`)
  process.exit(1)
}
