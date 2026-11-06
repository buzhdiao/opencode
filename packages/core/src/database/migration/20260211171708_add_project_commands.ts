// 从 effect 导入 Effect：迁移逻辑以 Effect 生成器编写
import { Effect } from "effect"
// 仅导入类型：DatabaseMigration（迁移定义类型）
import type { DatabaseMigration } from "../migration.js"

// 迁移：为 project 表新增 commands 列（自定义命令配置）
const migration: DatabaseMigration.Migration = {
  // 迁移唯一标识
  id: "20260211171708_add_project_commands",
  // 升级逻辑
  up(tx) {
    // 用 Effect.gen 编排
    return Effect.gen(function* () {
      // 给 project 表添加可空的 commands 文本列
      yield* tx.run(`ALTER TABLE \`project\` ADD \`commands\` text;`)
    })
  },
}

// 默认导出迁移定义
export default migration
