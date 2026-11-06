// 从 effect 导入 Effect：迁移逻辑以 Effect 生成器编写
import { Effect } from "effect"
// 仅导入类型：DatabaseMigration（迁移定义类型）
import type { DatabaseMigration } from "../migration.js"

// 迁移：重建 workspace 表，把 name 列改为“非空且默认空字符串”
const migration: DatabaseMigration.Migration = {
  // 迁移唯一标识
  id: "20260410174513_workspace-name",
  // 升级逻辑
  up(tx) {
    // 用 Effect.gen 编排
    return Effect.gen(function* () {
      // 读取 workspace 表现有列信息，判断旧表是否已有 name 列
      const columns = yield* tx.all<{ name: string }>(`PRAGMA table_info(\`workspace\`)`)
      // 旧表有 name 列则搬移原值，否则统一用空字符串字面量填充
      const name = columns.some((column) => column.name === "name") ? "`name`" : "''"

      // SQLite 表级修改需重建表：先临时关闭外键检查
      yield* tx.run(`PRAGMA foreign_keys=OFF;`)
      // 创建新表 __new_workspace：name 列默认空字符串且非空，其余结构保持
      yield* tx.run(`
        CREATE TABLE \`__new_workspace\` (
          \`id\` text PRIMARY KEY,
          \`type\` text NOT NULL,
          \`name\` text DEFAULT '' NOT NULL,
          \`branch\` text,
          \`directory\` text,
          \`extra\` text,
          \`project_id\` text NOT NULL,
          CONSTRAINT \`fk_workspace_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      // 把旧表数据整体搬入新表（name 按上述判定取原值或空串）
      yield* tx.run(
        `INSERT INTO \`__new_workspace\`(\`id\`, \`type\`, \`branch\`, \`name\`, \`directory\`, \`extra\`, \`project_id\`) SELECT \`id\`, \`type\`, \`branch\`, ${name}, \`directory\`, \`extra\`, \`project_id\` FROM \`workspace\`;`,
      )
      // 删除旧表
      yield* tx.run(`DROP TABLE \`workspace\`;`)
      // 把新表重命名为 workspace
      yield* tx.run(`ALTER TABLE \`__new_workspace\` RENAME TO \`workspace\`;`)
      // 重建完成，恢复外键检查
      yield* tx.run(`PRAGMA foreign_keys=ON;`)
    })
  },
}

// 默认导出迁移定义
export default migration
