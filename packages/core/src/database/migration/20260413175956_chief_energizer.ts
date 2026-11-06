// 从 effect 库导入 Effect：用于以函数式效果（effect）风格编排迁移逻辑
import { Effect } from "effect"
// 仅导入类型 DatabaseMigration：数据库迁移（migration）的定义接口
import type { DatabaseMigration } from "../migration.js"

// 声明迁移对象，需满足 DatabaseMigration.Migration 接口（id + up）
const migration: DatabaseMigration.Migration = {
  // 迁移唯一 id：由时间戳 + 随机名称组成，用于记录该迁移是否已应用
  id: "20260413175956_chief_energizer",
  // up：迁移的升级（up）函数，tx 为包裹好的数据库事务（transaction）句柄
  up(tx) {
    // 用 Effect.gen 以生成器（generator）写法串联多条 SQL 操作
    return Effect.gen(function* () {
      // 在事务中执行 SQL：创建 session_entry（会话条目）表，存放会话的消息条目
      yield* tx.run(`
        CREATE TABLE \`session_entry\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`type\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_session_entry_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      // 创建 session_id 上的索引（index），加速“按会话取条目”的查询
      yield* tx.run(`CREATE INDEX \`session_entry_session_idx\` ON \`session_entry\` (\`session_id\`);`)
      // 创建 (session_id, type) 复合索引，加速按会话+类型过滤的查询
      yield* tx.run(`CREATE INDEX \`session_entry_session_type_idx\` ON \`session_entry\` (\`session_id\`,\`type\`);`)
      // 创建 time_created 索引，加速按创建时间排序或过滤
      yield* tx.run(`CREATE INDEX \`session_entry_time_created_idx\` ON \`session_entry\` (\`time_created\`);`)
    })
  },
}

// 以默认导出（default export）暴露迁移，供迁移注册表统一收集
export default migration
