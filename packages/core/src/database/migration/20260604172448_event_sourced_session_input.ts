// 从 effect 库导入 Effect：用于以函数式效果（effect）风格编排迁移逻辑
import { Effect } from "effect"
// 仅导入类型 DatabaseMigration：数据库迁移（migration）的定义接口
import type { DatabaseMigration } from "../migration.js"

// 声明迁移对象，需满足 DatabaseMigration.Migration 接口（id + up）
const migration: DatabaseMigration.Migration = {
  // 迁移唯一 id：由时间戳 + 随机名称组成，用于记录该迁移是否已应用
  id: "20260604172448_event_sourced_session_input",
  // up：迁移的升级（up）函数，tx 为包裹好的数据库事务（transaction）句柄
  up(tx) {
    // 用 Effect.gen 以生成器（generator）写法串联多条 SQL 操作
    return Effect.gen(function* () {
      // 清空各表数据：本次重构把输入改为事件溯源（event sourcing）模型，
      // 旧数据无法按新模型重建，需要全部重置
      yield* tx.run(`DELETE FROM \`session_input\`;`)
      // 同步清空消息（session_message）表
      yield* tx.run(`DELETE FROM \`session_message\`;`)
      // 清空事件（event）表
      yield* tx.run(`DELETE FROM \`event\`;`)
      // 清空事件序号（event_sequence）表
      yield* tx.run(`DELETE FROM \`event_sequence\`;`)
      // 解除 session（会话）与 workspace（工作区）的绑定，为清空工作区做准备
      yield* tx.run(`UPDATE \`session\` SET \`workspace_id\` = NULL;`)
      // 清空工作区表
      yield* tx.run(`DELETE FROM \`workspace\`;`)
      // 删除普通的事件索引，改为唯一索引（unique index）
      yield* tx.run(`DROP INDEX IF EXISTS \`event_aggregate_seq_idx\`;`)
      // 创建 (aggregate_id, seq) 唯一索引：在数据库层面保证同一聚合内序号不重复
      yield* tx.run(`CREATE UNIQUE INDEX \`event_aggregate_seq_idx\` ON \`event\` (\`aggregate_id\`,\`seq\`);`)
      // 删除普通的消息序号索引
      yield* tx.run(`DROP INDEX IF EXISTS \`session_message_session_seq_idx\`;`)
      // 创建 (session_id, seq) 唯一索引：保证同一会话内消息序号唯一
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_message_session_seq_idx\` ON \`session_message\` (\`session_id\`,\`seq\`);`,
      )
      // 临时关闭外键（foreign keys）约束，便于后面的表重建操作
      yield* tx.run(`PRAGMA foreign_keys=OFF;`)
      // 执行 SQL：先建 __new_session_input 影子表——新表以 id 为主键，
      // 新增 admitted_seq（被接纳的序号）列，用于事件溯源去重与排序
      yield* tx.run(`
        CREATE TABLE \`__new_session_input\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`prompt\` text NOT NULL,
          \`delivery\` text NOT NULL,
          \`admitted_seq\` integer NOT NULL,
          \`promoted_seq\` integer,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_input_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      // 删除旧 session_input 表（SQLite 无法直接改主键，需走“建影子表-换名”流程）
      yield* tx.run(`DROP TABLE \`session_input\`;`)
      // 把影子表重命名为正式表名 session_input
      yield* tx.run(`ALTER TABLE \`__new_session_input\` RENAME TO \`session_input\`;`)
      // 表重建完成，重新开启外键约束
      yield* tx.run(`PRAGMA foreign_keys=ON;`)
      // 创建 (session_id, promoted_seq, delivery, admitted_seq) 索引：
      // 加速查询各会话按投递方式分组的待处理输入
      yield* tx.run(
        `CREATE INDEX \`session_input_session_pending_delivery_seq_idx\` ON \`session_input\` (\`session_id\`,\`promoted_seq\`,\`delivery\`,\`admitted_seq\`);`,
      )
      // 创建 (session_id, admitted_seq) 唯一索引：同一会话内接纳序号唯一
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_input_session_admitted_seq_idx\` ON \`session_input\` (\`session_id\`,\`admitted_seq\`);`,
      )
      // 创建 (session_id, promoted_seq) 唯一索引：同一会话内提升序号唯一
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_input_session_promoted_seq_idx\` ON \`session_input\` (\`session_id\`,\`promoted_seq\`);`,
      )
    })
  },
}

// 以默认导出（default export）暴露迁移，供迁移注册表统一收集
export default migration
