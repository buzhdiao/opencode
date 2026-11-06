// 从 effect 导入 Effect：迁移逻辑以 Effect 生成器编写
import { Effect } from "effect"
// 仅导入类型：DatabaseMigration（迁移定义类型）
import type { DatabaseMigration } from "../migration.js"

// 迁移：重建消息/部分表的索引以支持游标（cursor）分页（按时间+id 稳定排序）
const migration: DatabaseMigration.Migration = {
  // 迁移唯一标识
  id: "20260312043431_session_message_cursor",
  // 升级逻辑
  up(tx) {
    // 用 Effect.gen 编排
    return Effect.gen(function* () {
      // 删除旧的按会话查消息的单一索引
      yield* tx.run(`DROP INDEX IF EXISTS \`message_session_idx\`;`)
      // 删除旧的按消息查部分的单一索引
      yield* tx.run(`DROP INDEX IF EXISTS \`part_message_idx\`;`)
      // 创建复合索引（session_id, time_created, id）：支持稳定的游标分页查询
      yield* tx.run(
        `CREATE INDEX \`message_session_time_created_id_idx\` ON \`message\` (\`session_id\`,\`time_created\`,\`id\`);`,
      )
      // 创建复合索引（message_id, id）：支持部分（part）的稳定分页
      yield* tx.run(`CREATE INDEX \`part_message_id_id_idx\` ON \`part\` (\`message_id\`,\`id\`);`)
    })
  },
}

// 默认导出迁移定义
export default migration
