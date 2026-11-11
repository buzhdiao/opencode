#!/usr/bin/env bun
// Server 包（@opencode/server）的构建脚本，对应 package.json 的 `build`（`bun run script/build.ts`）。
// 发布流程中的位置：`bun run pack`（script/pack.ts → @opencode/script/pack）会先执行本脚本再打 npm 包。
// 与 packages/core/script/build.ts 同构但更简单：没有 models 快照插件、loader 与额外外部化清单；
// 产物：dist/ 下的 JS 分块 + tsc 生成的 .d.ts 声明（emitDeclarationOnly，也落在 dist/，供 pack 改写 exports）。

// 导入 Bun 的模板字符串 shell（$），用于执行 tsc 命令
import { $ } from "bun"
// 导入 rm：递归删除上一次构建的 dist 目录
import { rm } from "node:fs/promises"
// 导入 path：解析 src 目录绝对路径
import path from "node:path"
// 导入 fileURLToPath：把本脚本的 import.meta.url 转为文件路径，用于定位包根目录
import { fileURLToPath } from "node:url"

// 切换工作目录到本脚本的上一级（packages/server），后续相对路径均以包根为基准
process.chdir(fileURLToPath(new URL("..", import.meta.url)))

// 清空旧产物：递归删除 dist/（不存在则忽略）
await rm("dist", { recursive: true, force: true })
// 第一步：用 tsc 按 tsconfig.build.json 把 src 编译为声明文件（emitDeclarationOnly，outDir=dist/）
await $`bun tsc -p tsconfig.build.json`
// 第二步：Bun.build 打包。root 设为 src 的绝对路径，作为打包入口树的根
const root = path.resolve("src")
// 执行打包：以下逐项配置入口/产物/目标/格式/外部化/分块/命名
const result = await Bun.build({
  // 扫描 src 下全部 .ts（绝对路径）作为打包入口，过滤掉 .d.ts（声明文件不是可执行代码）
  entrypoints: await Array.fromAsync(new Bun.Glob("**/*.ts").scan({ cwd: root, absolute: true })).then((files) =>
    files.filter((file) => !file.endsWith(".d.ts")),
  ),
  // 打包根目录：入口的相对路径按它计算
  root,
  // 输出目录：dist/
  outdir: "dist",
  // 目标运行时：node（部署到 Cloudflare Workers 时经 workerd 的 nodejs_compat 兼容层复用）
  target: "node",
  // 模块格式：ESM
  format: "esm",
  // 依赖处理：所有 bare import（node_modules 依赖）保持外部化，不打进产物
  packages: "external",
  // 代码分块：共享模块抽出为 chunks/[name]-[hash].js，避免重复打包
  splitting: true,
  // 产物命名规则：入口保持原目录结构，chunk 与资源带哈希
  naming: {
    entry: "[dir]/[name].[ext]",
    chunk: "chunks/[name]-[hash].[ext]",
  },
})
// 打包失败（任一入口报错）时聚合所有日志抛出，让构建立即失败
if (!result.success) throw new AggregateError(result.logs, "Failed to build Server")
