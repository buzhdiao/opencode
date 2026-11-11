#!/usr/bin/env bun
// Core 包的 npm 打包脚本，对应 package.json 的 `pack`。
// 仅 5 行：把包目录交给共享的 @opencode/script/pack（packages/script/src/pack.ts）完成
// 构建（内部先跑 `bun run build` 即 script/build.ts）、重写 package.json 的 exports/imports
// 指向 dist 产物，最后 `bun pm pack` 出 tarball 到仓库根 dist/npm/。
import path from "node:path"
// 导入共享打包函数 pack：由 packages/script 包提供
import { pack } from "@opencode/script/pack"

// 打包 packages/core 目录；types 指明构建脚本把 TypeScript 声明写到 dist/types/，
// 共享 pack 据此把 exports 的 `./src/x.ts` 改写为 dist/types 下的 .d.ts 路径
await pack(path.resolve(import.meta.dir, ".."), { types: "./dist/types/" })
