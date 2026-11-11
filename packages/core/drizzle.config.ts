// Drizzle Kit 配置：声明数据库 schema 的扫描范围与迁移产物的输出目录。
// 由 drizzle-kit CLI 读取（packages/core 的 `db` 脚本，即 `bun drizzle-kit`，如 `bun run db generate`）；
// script/migration.ts 也会导入本文件作为基础配置，覆盖 out 字段后派生临时配置去驱动 drizzle-kit generate。
import { defineConfig } from "drizzle-kit"

// 导出 drizzle-kit 配置对象
export default defineConfig({
  // 数据库方言：SQLite（opencode 的本地嵌入式数据库）
  dialect: "sqlite",
  // schema 源文件范围：扫描 src 下所有 *.sql.ts / sql.ts 文件，从中提取表结构定义
  schema: ["./src/**/*.sql.ts", "./src/**/sql.ts"],
  // 迁移产物输出目录：drizzle-kit generate 生成的 SQL 与快照写入 ./migration
  out: "./migration",
  // 本地数据库连接信息：硬编码的开发机路径；drizzle-kit generate 生成迁移时并不连接数据库，
  // 此字段仅供 push/introspect 等需要真实连接的命令使用
  dbCredentials: {
    url: "/home/thdxr/.local/share/opencode/opencode.db",
  },
})
