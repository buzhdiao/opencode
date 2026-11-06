// 从 effect 库导入 Effect：用于以函数式效果（effect）风格编排迁移逻辑
import { Effect } from "effect"
// 仅导入类型 DatabaseMigration：数据库迁移（migration）的定义接口
import type { DatabaseMigration } from "../migration.js"

// 声明迁移对象，需满足 DatabaseMigration.Migration 接口（id + up）
const migration: DatabaseMigration.Migration = {
  // 迁移唯一 id：由时间戳 + 随机名称组成，用于记录该迁移是否已应用
  id: "20260603040000_session_message_projection_order",
  // up：迁移的升级（up）函数，tx 为包裹好的数据库事务（transaction）句柄
  up(tx) {
    // 用 Effect.gen 以生成器（generator）写法串联多条 SQL 操作
    return Effect.gen(function* () {
      // Pre-launch Session projections were written before durable event persistence
      // became unconditional, so they cannot be assigned truthful aggregate order.
      // 执行 SQL：清空 session_message 表——上线前的投影（projection）数据
      // 缺少可靠的事件顺序，无法赋予真实的序号，只能重建
      yield* tx.run(`DELETE FROM \`session_message\`;`)
      // 给 session_message 表新增 seq 列（非空）：记录消息在聚合内的顺序号
      yield* tx.run(`ALTER TABLE \`session_message\` ADD COLUMN \`seq\` integer NOT NULL;`)
      // 删除旧的按时间排序索引，改用基于 seq 的索引
      yield* tx.run(`DROP INDEX IF EXISTS \`session_message_session_type_time_created_id_idx\`;`)
      // 创建 (session_id, seq) 索引：按会话取消息并按序号排序
      yield* tx.run(`CREATE INDEX \`session_message_session_seq_idx\` ON \`session_message\` (\`session_id\`,\`seq\`);`)
      // 创建 (session_id, type, seq) 索引：支持按会话+类型+序号的有序查询
      yield* tx.run(
        `CREATE INDEX \`session_message_session_type_seq_idx\` ON \`session_message\` (\`session_id\`,\`type\`,\`seq\`);`,
      )
    })
  },
}

// 以默认导出（default export）暴露迁移，供迁移注册表统一收集
export default migration
