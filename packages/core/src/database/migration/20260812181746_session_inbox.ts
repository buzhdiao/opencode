// 从 effect 库导入 Effect：用于以函数式效果（effect）风格编排迁移逻辑
import { Effect } from "effect"
// 仅导入类型 DatabaseMigration：数据库迁移（migration）的定义接口
import type { DatabaseMigration } from "../migration.js"

// 声明迁移对象，需满足 DatabaseMigration.Migration 接口（id + up）
const migration: DatabaseMigration.Migration = {
  // 迁移唯一 id：由时间戳 + 随机名称组成，用于记录该迁移是否已应用
  id: "20260812181746_session_inbox",
  // up：迁移的升级（up）函数，tx 为包裹好的数据库事务（transaction）句柄
  up(tx) {
    // 用 Effect.gen 以生成器（generator）写法串联多条 SQL 操作
    return Effect.gen(function* () {
      // 执行 SQL：创建 session_inbox（会话收件箱）表，存放待投递给会话的
      // 消息载荷（payload）与投递方式（delivery）、入队序号（enqueued_seq）
      yield* tx.run(`
        CREATE TABLE \`session_inbox\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`type\` text NOT NULL,
          \`payload\` text NOT NULL,
          \`delivery\` text NOT NULL,
          \`enqueued_seq\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_inbox_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      // 创建 (session_id, delivery, enqueued_seq) 索引（index）：
      // 加速按会话+投递方式取出收件箱条目
      yield* tx.run(
        `CREATE INDEX \`session_inbox_session_delivery_seq_idx\` ON \`session_inbox\` (\`session_id\`,\`delivery\`,\`enqueued_seq\`);`,
      )
      // 创建 (session_id, enqueued_seq) 唯一索引：保证同一会话内入队序号不重复
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_inbox_session_enqueued_seq_idx\` ON \`session_inbox\` (\`session_id\`,\`enqueued_seq\`);`,
      )
    })
  },
}

// 以默认导出（default export）暴露迁移，供迁移注册表统一收集
export default migration
