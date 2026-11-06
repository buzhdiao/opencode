// 从 effect 库导入 Effect：用于以函数式效果（effect）风格编排迁移逻辑
import { Effect } from "effect"
// 仅导入类型 DatabaseMigration：数据库迁移（migration）的定义接口
import type { DatabaseMigration } from "../migration.js"

// 声明迁移对象，需满足 DatabaseMigration.Migration 接口（id + up）
const migration: DatabaseMigration.Migration = {
  // 迁移唯一 id：由时间戳 + 随机名称组成，用于记录该迁移是否已应用
  id: "20260603160727_jittery_ezekiel_stane",
  // up：迁移的升级（up）函数，tx 为包裹好的数据库事务（transaction）句柄
  up(tx) {
    // 用 Effect.gen 以生成器（generator）写法串联多条 SQL 操作
    return Effect.gen(function* () {
      // 删除旧的 pending 输入索引，将被包含 delivery 维度的新索引取代
      yield* tx.run(`DROP INDEX IF EXISTS \`session_input_session_pending_seq_idx\`;`)
      // 创建 (aggregate_id, type, seq) 事件索引（index）：加速按聚合+类型
      // 读取事件流；IF NOT EXISTS 保证与已有索引冲突时不报错
      yield* tx.run(
        `CREATE INDEX IF NOT EXISTS \`event_aggregate_type_seq_idx\` ON \`event\` (\`aggregate_id\`,\`type\`,\`seq\`);`,
      )
      // 创建 (session_id, promoted_seq, delivery, seq) 索引：加速按会话
      // 查询待投递输入，并区分投递（delivery）方式
      yield* tx.run(
        `CREATE INDEX IF NOT EXISTS \`session_input_session_pending_delivery_seq_idx\` ON \`session_input\` (\`session_id\`,\`promoted_seq\`,\`delivery\`,\`seq\`);`,
      )
      // 创建 (session_id, time_created, id) 索引：加速按会话+时间读取消息，
      // IF NOT EXISTS 避免在前一迁移已建过同名索引时出错
      yield* tx.run(
        `CREATE INDEX IF NOT EXISTS \`session_message_session_time_created_id_idx\` ON \`session_message\` (\`session_id\`,\`time_created\`,\`id\`);`,
      )
    })
  },
}

// 以默认导出（default export）暴露迁移，供迁移注册表统一收集
export default migration
