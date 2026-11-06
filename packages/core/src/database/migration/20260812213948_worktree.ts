// 从 effect 库导入 Effect：用于以函数式效果（effect）风格编排迁移逻辑
import { Effect } from "effect"
// 仅导入类型 DatabaseMigration：数据库迁移（migration）的定义接口
import type { DatabaseMigration } from "../migration.js"

// 声明迁移对象，需满足 DatabaseMigration.Migration 接口（id + up）
const migration: DatabaseMigration.Migration = {
  // 迁移唯一 id：由时间戳 + 随机名称组成，用于记录该迁移是否已应用
  id: "20260812213948_worktree",
  // up：迁移的升级（up）函数，tx 为包裹好的数据库事务（transaction）句柄
  up(tx) {
    // 用 Effect.gen 以生成器（generator）写法串联多条 SQL 操作
    return Effect.gen(function* () {
      // 执行 SQL：创建 worktree（工作树）表，把“项目目录”概念统一收敛为
      // 工作树；主键 (project_id, directory)，外键级联删除
      yield* tx.run(`
        CREATE TABLE \`worktree\` (
          \`project_id\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`strategy\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`worktree_pk\` PRIMARY KEY(\`project_id\`, \`directory\`),
          CONSTRAINT \`fk_worktree_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      // 数据搬迁：把 project_directory 表中的目录迁移为 worktree 行，
      // 策略值做规范化——'git_worktree' 统一改名为 'git'，其余原样保留
      yield* tx.run(`
        INSERT INTO \`worktree\` (\`project_id\`, \`directory\`, \`strategy\`, \`time_created\`)
        SELECT
          \`project_id\`,
          \`directory\`,
          CASE
            WHEN \`strategy\` = 'git_worktree' THEN 'git'
            WHEN \`strategy\` IS NOT NULL THEN \`strategy\`
            WHEN \`type\` = 'git_worktree' THEN 'git'
          END,
          \`time_created\`
        FROM \`project_directory\`;
      `)
    })
  },
}

// 以默认导出（default export）暴露迁移，供迁移注册表统一收集
export default migration
