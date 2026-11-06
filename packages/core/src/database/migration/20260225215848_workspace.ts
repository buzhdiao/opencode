// 从 effect 导入 Effect：迁移逻辑以 Effect 生成器编写
import { Effect } from "effect"
// 仅导入类型：DatabaseMigration（迁移定义类型）
import type { DatabaseMigration } from "../migration.js"

// 迁移：创建 workspace（工作区）表
const migration: DatabaseMigration.Migration = {
  // 迁移唯一标识
  id: "20260225215848_workspace",
  // 升级逻辑
  up(tx) {
    // 用 Effect.gen 编排
    return Effect.gen(function* () {
      // 创建 workspace 表：分支、所属项目（外键级联删除）与配置
      yield* tx.run(`
        CREATE TABLE \`workspace\` (
          \`id\` text PRIMARY KEY,
          \`branch\` text,
          \`project_id\` text NOT NULL,
          \`config\` text NOT NULL,
          CONSTRAINT \`fk_workspace_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
    })
  },
}

// 默认导出迁移定义
export default migration
