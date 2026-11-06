// 从 effect 库导入 Effect：用于以函数式效果（effect）风格编排迁移逻辑
import { Effect } from "effect"
// 仅导入类型 DatabaseMigration：数据库迁移（migration）的定义接口
import type { DatabaseMigration } from "../migration.js"

// 声明迁移对象，需满足 DatabaseMigration.Migration 接口（id + up）
const migration: DatabaseMigration.Migration = {
  // 迁移唯一 id：由时间戳 + 随机名称组成，用于记录该迁移是否已应用
  id: "20260427172553_slow_nightmare",
  // up：迁移的升级（up）函数，tx 为包裹好的数据库事务（transaction）句柄
  up(tx) {
    // 用 Effect.gen 以生成器（generator）写法串联多条 SQL 操作
    return Effect.gen(function* () {
      // 执行 SQL：创建 session_message（会话消息）表，作为消息存储的新载体
      yield* tx.run(`
        CREATE TABLE \`session_message\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`type\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_session_message_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      // 删除旧表 session_entry 上的三个索引（index），为新表索引让路
      yield* tx.run(`DROP INDEX IF EXISTS \`session_entry_session_idx\`;`)
      // IF EXISTS 保证索引不存在时也不报错
      yield* tx.run(`DROP INDEX IF EXISTS \`session_entry_session_type_idx\`;`)
      // 同上：删除按时间排序的旧索引
      yield* tx.run(`DROP INDEX IF EXISTS \`session_entry_time_created_idx\`;`)
      // 在新表 session_message 上创建 session_id 索引，加速按会话查询
      yield* tx.run(`CREATE INDEX \`session_message_session_idx\` ON \`session_message\` (\`session_id\`);`)
      // 创建 (session_id, type) 复合索引，加速按会话+类型过滤
      yield* tx.run(
        `CREATE INDEX \`session_message_session_type_idx\` ON \`session_message\` (\`session_id\`,\`type\`);`,
      )
      // 创建 time_created 索引，加速按创建时间排序或过滤
      yield* tx.run(`CREATE INDEX \`session_message_time_created_idx\` ON \`session_message\` (\`time_created\`);`)
      // 删除旧表 session_entry：数据模型从 session_entry 迁移到 session_message
      yield* tx.run(`DROP TABLE \`session_entry\`;`)
    })
  },
}

// 以默认导出（default export）暴露迁移，供迁移注册表统一收集
export default migration
