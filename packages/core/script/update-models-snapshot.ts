#!/usr/bin/env bun
/**
 * Refreshes the bundled models.dev catalog snapshot at src/models-dev/snapshot.txt,
 * or writes it to the path given as the first argument.
 * The snapshot is the boot-time floor for the catalog when no cache entry exists
 * and fetching is disabled or unavailable; live fetch still refreshes on top.
 */
// 模型目录快照更新脚本，对应 package.json 的 `update-models-snapshot`。
// （上方英文文档注释原样保留：刷新 src/models-dev/snapshot.txt 或写到第一个参数给的路径；
// 该快照是启动时无缓存、且禁用/无法联网时的目录兜底，线上拉取仍会在其上刷新。）
// 发布流程：release.yml / release-dry-run.yml 会执行
// `bun packages/core/script/update-models-snapshot.ts .cache/models-catalog/api.json` 把最新目录缓存下来；
// 本地手动用法：`bun run script/update-models-snapshot.ts` 直接更新仓库内提交的快照。
import path from "node:path"
// 导入快照工具：committedSnapshot 是仓库内快照文件的 URL，fetchModelsSnapshot 从线上拉取并校验目录
import { committedSnapshot, fetchModelsSnapshot } from "./models-snapshot"

// 输出目标：有第一个命令行参数则解析为绝对路径（发布工作流的缓存文件），否则写回仓库内提交的快照文件
const target = process.argv[2] ? path.resolve(process.argv[2]) : Bun.fileURLToPath(committedSnapshot)
// 从 models.opencode.ai（或 OPENCODE_MODELS_URL 指定的源）拉取目录并裁剪、校验
const snapshot = await fetchModelsSnapshot()
// 把校验后的目录文本写入目标文件
await Bun.write(target, snapshot.text)
// 打印结果摘要：提供商数量、字节数、目标路径
console.log(`Wrote ${snapshot.providers} providers (${snapshot.text.length} bytes) to ${target}`)
