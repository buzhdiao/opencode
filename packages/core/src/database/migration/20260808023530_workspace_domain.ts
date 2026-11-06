// 从 effect 库导入 Effect：用于以函数式效果（effect）风格编排迁移逻辑
import { Effect } from "effect"
// 仅导入类型 DatabaseMigration：数据库迁移（migration）的定义接口
import type { DatabaseMigration } from "../migration.js"

// 声明迁移对象，需满足 DatabaseMigration.Migration 接口（id + up）
const migration: DatabaseMigration.Migration = {
  // 迁移唯一 id：由时间戳 + 随机名称组成，用于记录该迁移是否已应用
  id: "20260808023530_workspace_domain",
  // up：迁移的升级（up）函数，tx 为包裹好的数据库事务（transaction）句柄
  up(tx) {
    // 用 Effect.gen 以生成器（generator）写法串联多条 SQL 操作
    return Effect.gen(function* () {
      // 执行 SQL：删除旧 workspace（工作区）表，改用新的领域（domain）模型重建
      yield* tx.run(`DROP TABLE \`workspace\`;`)
      // 重建 workspace 表：provider（提供方）+ binding（绑定）标识工作区，
      // created_at/last_used_at 分别记录创建与最近使用时间
      yield* tx.run(`
        CREATE TABLE \`workspace\` (
          \`id\` text PRIMARY KEY,
          \`provider\` text NOT NULL,
          \`binding\` text NOT NULL,
          \`created_at\` integer NOT NULL,
          \`last_used_at\` integer NOT NULL
        );
      `)
    })
  },
}

// 以默认导出（default export）暴露迁移，供迁移注册表统一收集
export default migration
