#!/usr/bin/env bun
// Server 包（@opencode/server）的 npm 打包脚本，对应 package.json 的 `pack`。
// 与 packages/core/script/pack.ts 同构：把包目录交给共享的 @opencode/script/pack 完成
// 构建（内部先跑本包 `bun run build` 即 script/build.ts）、重写 package.json 的 exports
// 指向 dist 产物，最后 `bun pm pack` 出 tarball 到仓库根 dist/npm/，供发布工作流上传。
import path from "node:path"
// 导入共享打包函数 pack：由 packages/script 包提供
import { pack } from "@opencode/script/pack"

// 打包 packages/server 目录；不传 options 时共享 pack 默认 types=./dist/：
// 本包构建把 .d.ts 与 JS 一并写进 dist/，exports 的 "./*" 通配由 ./src/*.ts
// 改写为 { import: "./dist/*.js", types: "./dist/*.d.ts" }
await pack(path.resolve(import.meta.dir, ".."))
