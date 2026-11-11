#!/usr/bin/env bun
// Core 包（@opencode/core）的构建脚本，对应 package.json 的 `build`（`bun run script/build.ts`）。
// 发布流程中的位置：`bun run pack`（script/pack.ts → @opencode/script/pack）会先执行本脚本再打 npm 包；
// 产物写入 dist/（JS 分块）与 dist/types/（tsc 声明，供 pack 重写 exports 指向）。
// 两步走：先 tsc 生成 .d.ts，再用 Bun.build 把 src 下全部 TS 打包为 node 目标的 ESM。

// 导入 Bun 的模板字符串 shell（$），用于执行 tsc 命令
import { $ } from "bun"
// 导入 rm：递归删除上一次构建的 dist 目录
import { rm } from "node:fs/promises"
// 导入 path：解析 src 目录绝对路径
import path from "node:path"
// 导入 fileURLToPath：把本脚本的 import.meta.url 转为文件路径，用于定位包根目录
import { fileURLToPath } from "node:url"
// 导入 models 快照工具：bundledModelsSnapshot 读取内置目录文本，modelsSnapshotPlugin 在打包时把它喂给加载器
import { bundledModelsSnapshot, modelsSnapshotPlugin } from "./models-snapshot"

// 切换工作目录到本脚本的上一级（packages/core），后续相对路径均以包根为基准
process.chdir(fileURLToPath(new URL("..", import.meta.url)))

// 清空旧产物：递归删除 dist/（不存在则忽略）
await rm("dist", { recursive: true, force: true })
// 第一步：用 tsc 按 tsconfig.build.json 把 src 编译到 dist/types（仅声明文件，见该 tsconfig 的 outDir）
await $`bun tsc -p tsconfig.build.json`

// 第二步：Bun.build 打包。root 设为 src 的绝对路径，作为打包入口树的根
const root = path.resolve("src")
// 扫描 src 下全部 .ts 文件（绝对路径），作为打包入口（每个模块一个入口，保持 dist 的目录结构）
const files = await Array.fromAsync(new Bun.Glob("**/*.ts").scan({ cwd: root, absolute: true }))
// 执行打包：以下逐项配置入口/产物/目标/格式/外部化/分块/插件/加载器/命名
const result = await Bun.build({
  // 过滤掉 .d.ts（声明文件不是可执行代码）；其余文件全部作为入口
  entrypoints: files.filter((file) => !file.endsWith(".d.ts")),
  // 打包根目录：入口的相对路径按它计算
  root,
  // 输出目录：dist/
  outdir: "dist",
  // 目标运行时：node（包在 CLI 的 Bun 进程里运行）
  target: "node",
  // 模块格式：ESM
  format: "esm",
  // 依赖处理：所有 bare import（node_modules 依赖）保持外部化，不打进产物
  packages: "external",
  // 额外外部化的子路径导入：这些 #imports 在 package.json 里按运行时条件映射到不同实现，
  // 打包时不能解析为单一文件，交给运行时按 import 条件解析
  external: [
    // SQLite 驱动（bun/node/workerd 三种实现）
    "#sqlite",
    // 终端 PTY 绑定
    "#pty",
    // Claude Agent SDK 桥接
    "#claude-agent-sdk",
    // 持久 PTY 的二进制
    "#persistent-pty-binary",
    // 文件系统扫描库 fff
    "#fff",
    // 图像处理 WASM（photon）
    "#photon-wasm",
    // v1 数据库迁移（仅 bun 运行时有实现）
    "#v1-migration",
  ],
  // 代码分块：共享模块抽出为 chunks/[name]-[hash].js，避免重复打包
  splitting: true,
  // 插件：把 import "*/models-dev/snapshot.txt" 的内容替换为内置的 models.dev 目录文本
  plugins: [modelsSnapshotPlugin(await bundledModelsSnapshot())],
  // 非代码资源加载器：.txt/.md 文本按字符串内联
  loader: {
    ".txt": "text",
    ".md": "text",
  },
  // 产物命名规则：入口保持原目录结构，chunk 与资源带哈希
  naming: {
    entry: "[dir]/[name].[ext]",
    chunk: "chunks/[name]-[hash].[ext]",
    asset: "assets/[name]-[hash].[ext]",
  },
})
// 打包失败（任一入口报错）时聚合所有日志抛出，让构建立即失败
if (!result.success) throw new AggregateError(result.logs, "Failed to build Core")
