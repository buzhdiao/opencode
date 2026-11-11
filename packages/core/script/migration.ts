#!/usr/bin/env bun
// 数据库迁移生成脚本，对应 package.json 的 `migration`（`bun run script/migration.ts`，在 packages/core 下执行）。
// 在数据库演进流程中的位置：src/ 下的 *.sql.ts（drizzle schema）变更后运行本脚本，它会：
//   1. 以提交在仓库的 schema.json 为基线，用 drizzle-kit 生成增量迁移 SQL → 写入 src/database/migration/<name>.ts；
//   2. 生成全量 schema → 写入 src/database/schema.gen.ts（全新安装一次建库用的语句集合）；
//   3. 重排迁移注册表 → 写入 src/database/migration.gen.ts。
// 用法：`bun run migration [--name xxx]` 生成；`bun run migration --check` 只校验是否落后（CI 也在用）。
// drizzle.config.ts 在这里被当作基础配置复用（覆盖 out 字段派生临时配置）。

// 导入 fs/promises：建临时目录、复制基线快照、删除临时目录
import fs from "fs/promises"
// 导入 os：取系统临时目录
import os from "os"
// 导入 path：拼接各路径
import path from "path"
// 导入 pathToFileURL：把 drizzle.config.ts 的路径转成 file:// URL，便于生成临时配置文件里的 import
import { pathToFileURL } from "url"
// 导入 parseArgs：解析命令行参数
import { parseArgs } from "util"

// 仓库根目录（本脚本位于 packages/core/script，向上三级）
const root = path.resolve(import.meta.dirname, "../../..")
// 提交在仓库的 drizzle 基线快照：记录上一次生成迁移后的完整表结构
const snapshot = path.join(root, "packages/core/schema.json")
// 增量迁移文件目录：每个迁移一个 .ts
const tsDir = path.join(root, "packages/core/src/database/migration")
// 迁移注册表（自动生成）：按顺序导出全部迁移
const registry = path.join(root, "packages/core/src/database/migration.gen.ts")
// 全量建库 schema（自动生成）：全新安装时一次性创建所有表
const schema = path.join(root, "packages/core/src/database/schema.gen.ts")
// 解析命令行参数：--check 只做校验不落盘；--name 指定生成的迁移名
const args = parseArgs({
  // 传入 process.argv 中去掉前两项的参数
  args: process.argv.slice(2),
  options: {
    // 布尔开关：校验模式
    check: { type: "boolean" },
    // 字符串：新迁移的名称
    name: { type: "string" },
  },
})

// 校验模式：跑 check 后立即退出
if (args.values.check) {
  await check()
  process.exit(0)
}

// 默认模式：执行生成
await generate()

// 生成迁移：先做增量（新迁移 + 更新基线快照），再做全量（重写 schema.gen.ts 与 migration.gen.ts）
async function generate() {
  // 在系统临时目录下建一个独立工作区，避免污染仓库
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-core-migration-"))
  // 增量输出目录：以提交的快照为基线生成差异迁移
  const incremental = path.join(temporary, "incremental")
  // 全量输出目录：从空库生成完整 schema
  const full = path.join(temporary, "full")
  try {
    // 建增量目录
    await fs.mkdir(incremental)
    // 建增量基线子目录（drizzle-kit 约定：baseline/snapshot.json 是 diff 的起点）
    await fs.mkdir(path.join(incremental, "baseline"))
    // 把提交的快照复制为基线
    await fs.copyFile(snapshot, path.join(incremental, "baseline/snapshot.json"))
    // 调 drizzle-kit generate 对比基线生成增量迁移（name 为可选的迁移名）
    await drizzle(temporary, incremental, args.values.name)

    // 收集增量输出里实际生成的迁移，应恰好 0 或 1 个
    const generated = await generatedMigrations(incremental)
    // 多于 1 个说明一次改动太大（drizzle-kit 不会这样输出），报错终止
    if (generated.length > 1) throw new Error(`Expected one generated migration, found ${generated.length}.`)
    // 取迁移名（没有 schema 变更时为 undefined）
    const name = generated[0]
    // 有新迁移才写文件
    if (name) {
      // 目标迁移文件路径：src/database/migration/<name>.ts
      const target = path.join(tsDir, `${name}.ts`)
      // 同名迁移已存在则报错，防止覆盖
      if (await Bun.file(target).exists()) throw new Error(`Database migration already exists: ${name}`)
      // 把迁移 SQL 渲染成 Effect 风格的迁移 TS 文件（先经 prettier 格式化）
      await Bun.write(
        target,
        await formatTypescript(
          renderMigration(name, await Bun.file(path.join(incremental, name, "migration.sql")).text()),
        ),
      )
      // 用新快照（同样经 prettier 格式化以最小化 diff）覆盖提交在仓库的基线快照
      await Bun.write(snapshot, await formatJson(await Bun.file(path.join(incremental, name, "snapshot.json")).text()))
    }

    // 全量部分：从空库生成完整 schema
    await fs.mkdir(full)
    // drizzle-kit generate 不给基线，产出单条全量迁移 SQL（固定名 schema）
    await drizzle(temporary, full, "schema")
    // 全量 SQL 渲染为 schema.gen.ts（Omit 掉 id，因为它不是真正可执行的迁移）
    await Bun.write(schema, await formatTypescript(renderSchema(await generatedSql(full))))
    // 按目录里的迁移文件重排注册表 migration.gen.ts
    await Bun.write(registry, await formatTypescript(renderRegistry(await typescriptMigrations())))
  } finally {
    // 无论成败都清理临时工作区
    await fs.rm(temporary, { recursive: true, force: true })
  }
}

// 校验模式：确认没有未生成的迁移，且 schema.gen.ts 与 migration.gen.ts 都是最新的
async function check() {
  // 校验用的临时工作区
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-core-migration-check-"))
  const incremental = path.join(temporary, "incremental")
  const full = path.join(temporary, "full")
  try {
    // 与 generate 相同：以提交的快照为基线
    await fs.mkdir(incremental)
    await fs.mkdir(path.join(incremental, "baseline"))
    await fs.copyFile(snapshot, path.join(incremental, "baseline/snapshot.json"))
    // 跑 drizzle-kit generate 对比基线（不指定迁移名）
    await drizzle(temporary, incremental)
    // 生成了任何迁移都说明 schema 有未落盘的变更
    if ((await generatedMigrations(incremental)).length > 0) {
      throw new Error(
        "Core schema has ungenerated database migrations. Run `bun script/migration.ts` from packages/core.",
      )
    }

    // 全量部分：重新生成 schema 并与提交的 schema.gen.ts 逐字节比对
    await fs.mkdir(full)
    await drizzle(temporary, full, "schema")
    // 不一致说明 schema.gen.ts 落后
    if ((await Bun.file(schema).text()) !== (await formatTypescript(renderSchema(await generatedSql(full))))) {
      throw new Error("Current database schema is stale. Run `bun script/migration.ts` from packages/core.")
    }

    // 注册表校验：按目录里的迁移重新渲染，与提交的 migration.gen.ts 比对
    const migrations = await typescriptMigrations()
    if ((await Bun.file(registry).text()) !== (await formatTypescript(renderRegistry(migrations)))) {
      throw new Error("Database migration registry is stale. Run `bun script/migration.ts` from packages/core.")
    }
  } finally {
    // 清理临时工作区
    await fs.rm(temporary, { recursive: true, force: true })
  }
}

// 在指定输出目录驱动 drizzle-kit generate：生成一份覆盖 out 的临时配置，然后子进程执行
async function drizzle(temporary: string, output: string, name?: string) {
  // 临时配置文件路径：以输出目录的基名命名，避免两份配置互相覆盖
  const config = path.join(temporary, `${path.basename(output)}.config.ts`)
  // 写临时配置：原样导入仓库的 drizzle.config.ts，仅覆盖 out 为本函数的输出目录
  await Bun.write(
    config,
    `import config from ${JSON.stringify(pathToFileURL(path.join(root, "packages/core/drizzle.config.ts")).href)}

export default { ...config, out: ${JSON.stringify(output)} }
`,
  )
  // 子进程执行 drizzle-kit generate：配置指向临时文件，--name 透传迁移名；工作目录是 packages/core
  const child = Bun.spawn(["bun", "drizzle-kit", "generate", "--config", config, ...(name ? ["--name", name] : [])], {
    cwd: path.join(root, "packages/core"),
    // stdio 直连，drizzle-kit 的输出实时可见
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  // 等子进程退出
  const exit = await child.exited
  // 非零退出码视为生成失败
  if (exit !== 0) throw new Error(`Drizzle generation failed with exit code ${exit}.`)
}

// 列出目录下生成的迁移名（每个迁移目录含 migration.sql），排序返回
async function generatedMigrations(directory: string) {
  // 扫描 */migration.sql，取第一级目录名作为迁移名，过滤 undefined 并排序
  return (await Array.fromAsync(new Bun.Glob("*/migration.sql").scan({ cwd: directory })))
    .map((file) => file.split("/")[0])
    .filter((name): name is string => name !== undefined)
    .sort()
}

// 读取全量迁移的 SQL：必须恰好生成一条全量迁移，返回其 migration.sql 内容
async function generatedSql(directory: string) {
  const generated = await generatedMigrations(directory)
  // 数量不为 1 说明全量生成异常，直接报错
  if (generated.length !== 1) throw new Error(`Expected one full schema migration, found ${generated.length}.`)
  // 读取那条迁移的 SQL
  return Bun.file(path.join(directory, generated[0]!, "migration.sql")).text()
}

// 列出 src/database/migration 目录下已有的迁移名（去掉 .ts 后缀），排序
async function typescriptMigrations() {
  return (await Array.fromAsync(new Bun.Glob("*.ts").scan({ cwd: tsDir })))
    .map((file) => path.basename(file, ".ts"))
    .sort()
}

// 渲染单个迁移文件：DatabaseMigration.Migration 形状，id 为迁移名，up 里逐条执行 SQL
function renderMigration(name: string, sql: string) {
  return `import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: ${JSON.stringify(name)},
  up(tx) {
    return Effect.gen(function* () {
${renderStatements(sql)}
    })
  },
}

export default migration
`
}

// 渲染全量 schema.gen.ts：与迁移同构但没有 id（不是注册表里的迁移，只是建库语句集合）
function renderSchema(sql: string) {
  return `import { Effect } from "effect"
import type { DatabaseMigration } from "./migration.js"

const schema: Omit<DatabaseMigration.Migration, "id"> = {
  up(tx) {
    return Effect.gen(function* () {
${renderStatements(sql)}
    })
  },
}

export default schema
`
}

// 把 drizzle 产出的 SQL 文本拆成单条语句并渲染成 tx.run(...) 语句行
function renderStatements(sql: string) {
  return sql
    // drizzle 用 "--> statement-breakpoint" 注释分隔语句
    .split("--> statement-breakpoint")
    // 去掉每条语句首尾空白
    .map((statement) => statement.trim())
    // 丢弃空语句
    .filter((statement) => statement.length > 0)
    // 每条语句渲染为一个 yield* tx.run(...) 行
    .map(renderRun)
    // 多条语句之间以换行拼接
    .join("\n")
}

// 渲染单条 SQL 语句为模板字符串形式的 tx.run 调用（单行或多行两种排版）
function renderRun(statement: string) {
  // 制表符统一转两个空格，再按行拆开
  const lines = statement.replaceAll("\t", "  ").split("\n")
  // 单行语句：直接内联进模板字符串
  if (lines.length === 1) return `      yield* tx.run(\`${escapeTemplate(lines[0])}\`)`
  // 多行语句：整体缩进两格，闭合反引号单独一行
  return `      yield* tx.run(\`\n${lines.map((line) => `        ${escapeTemplate(line)}`).join("\n")}\n      \`)`
}

// 转义模板字符串里的特殊字符：反斜杠、反引号、${ 插值序列，防止 SQL 内容破坏模板字面量
function escapeTemplate(line: string) {
  return line.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${")
}

// 用 prettier 格式化 TypeScript（与仓库风格一致：无分号、行宽 120）
async function formatTypescript(input: string) {
  const prettier = await import("prettier")
  // 动态加载 TS 与 estree 插件
  const typescript = await import("prettier/plugins/typescript")
  const estree = await import("prettier/plugins/estree")
  // 以 typescript 解析器格式化
  return prettier.format(input, {
    parser: "typescript",
    plugins: [typescript.default, estree.default],
    semi: false,
    printWidth: 120,
  })
}

// Drizzle emits every array multi-line; format the snapshot so regeneration
// diffs stay minimal against the prettier-styled checked-in copy.
// （上方英文注释原样保留：drizzle 输出的 JSON 数组总是多行；用 prettier 格式化快照，
// 使重新生成时与提交副本的 diff 最小。）
// 用 prettier 的 JSON 解析器格式化快照 JSON（行宽 120）
async function formatJson(input: string) {
  const prettier = await import("prettier")
  const babel = await import("prettier/plugins/babel")
  const estree = await import("prettier/plugins/estree")
  return prettier.format(input, {
    parser: "json",
    plugins: [babel.default, estree.default],
    printWidth: 120,
  })
}

// 渲染迁移注册表 migration.gen.ts：按文件名排序导入每个迁移并组成数组
function renderRegistry(names: string[]) {
  return `import type { DatabaseMigration } from "./migration.js"
${names.map((name, index) => `import m${index.toString().padStart(2, "0")} from "./migration/${name}.js"`).join("\n")}

export const migrations = [
${names.map((_, index) => `  m${index.toString().padStart(2, "0")},`).join("\n")}
] satisfies DatabaseMigration.Migration[]
`
}
