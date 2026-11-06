// 从 effect 导入 Effect：迁移逻辑以 Effect 生成器编写
import { Effect } from "effect"
// 仅导入类型：DatabaseMigration（迁移定义类型）
import type { DatabaseMigration } from "../migration.js"

// 迁移：会话关联工作区（新增 workspace_id 列与索引）
const migration: DatabaseMigration.Migration = {
  // 迁移唯一标识
  id: "20260227213759_add_session_workspace_id",
  // 升级逻辑
  up(tx) {
    // 用 Effect.gen 编排
    return Effect.gen(function* () {
      // 给 session 表添加可空的 workspace_id 文本列
      yield* tx.run(`ALTER TABLE \`session\` ADD \`workspace_id\` text;`)
      // 创建按工作区查会话的索引
      yield* tx.run(`CREATE INDEX \`session_workspace_idx\` ON \`session\` (\`workspace_id\`);`)
    })
  },
}

// 默认导出迁移定义
export default migration
