// 从 effect 库导入 Effect：用于以函数式效果（effect）风格编排迁移逻辑
import { Effect } from "effect"
// 仅导入类型 DatabaseMigration：数据库迁移（migration）的定义接口
import type { DatabaseMigration } from "../migration.js"

// 声明迁移对象，需满足 DatabaseMigration.Migration 接口（id + up）
const migration: DatabaseMigration.Migration = {
  // 迁移唯一 id：由时间戳 + 随机名称组成，用于记录该迁移是否已应用
  id: "20260603141458_session_input_inbox",
  // up：迁移的升级（up）函数，tx 为包裹好的数据库事务（transaction）句柄
  up(tx) {
    // 用 Effect.gen 以生成器（generator）写法串联多条 SQL 操作
    return Effect.gen(function* () {
      // 执行 SQL：创建 session_input（会话输入收件箱）表，排队存放用户
      // 提交的提示（prompt）；delivery 记录投递方式，promoted_seq 记录
      // 被提升为正式消息时的序号（未提升则为 NULL）
      yield* tx.run(`
        CREATE TABLE \`session_input\` (
          \`seq\` integer PRIMARY KEY AUTOINCREMENT,
          \`id\` text NOT NULL UNIQUE,
          \`session_id\` text NOT NULL,
          \`prompt\` text NOT NULL,
          \`delivery\` text NOT NULL,
          \`promoted_seq\` integer,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_input_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      // 创建 (session_id, promoted_seq, seq) 索引：加速查询某会话的
      // 待处理（pending）输入，并按投递顺序排列
      yield* tx.run(
        `CREATE INDEX \`session_input_session_pending_seq_idx\` ON \`session_input\` (\`session_id\`,\`promoted_seq\`,\`seq\`);`,
      )
    })
  },
}

// 以默认导出（default export）暴露迁移，供迁移注册表统一收集
export default migration
