// 从 effect 库导入 Effect：用于以函数式效果（effect）风格编排迁移逻辑
import { Effect } from "effect"
// 仅导入类型 DatabaseMigration：数据库迁移（migration）的定义接口
import type { DatabaseMigration } from "../migration.js"

// 声明迁移对象，需满足 DatabaseMigration.Migration 接口（id + up）
const migration: DatabaseMigration.Migration = {
  // 迁移唯一 id：由时间戳 + 随机名称组成，用于记录该迁移是否已应用
  id: "20260603001617_session_message_projection_indexes",
  // up：迁移的升级（up）函数，tx 为包裹好的数据库事务（transaction）句柄
  up(tx) {
    // 用 Effect.gen 以生成器（generator）写法串联多条 SQL 操作
    return Effect.gen(function* () {
      // 删除旧索引：仅按 session_id 查询的索引将被更精细的索引取代
      yield* tx.run(`DROP INDEX IF EXISTS \`session_message_session_idx\`;`)
      // 删除 (session_id, type) 复合索引，为带排序键的新索引让路
      yield* tx.run(`DROP INDEX IF EXISTS \`session_message_session_type_idx\`;`)
      // 在 event（事件）表上创建 (aggregate_id, seq) 索引，
      // 加速按聚合（aggregate）读取事件序列的操作
      yield* tx.run(`CREATE INDEX \`event_aggregate_seq_idx\` ON \`event\` (\`aggregate_id\`,\`seq\`);`)
      // 创建 (session_id, time_created, id) 索引：按会话+时间排序查询消息，
      // 追加 id 作决胜键，保证同一时间戳下顺序稳定
      yield* tx.run(
        `CREATE INDEX \`session_message_session_time_created_id_idx\` ON \`session_message\` (\`session_id\`,\`time_created\`,\`id\`);`,
      )
      // 创建 (session_id, type, time_created, id) 索引：支持按会话+类型+时间的有序查询
      yield* tx.run(
        `CREATE INDEX \`session_message_session_type_time_created_id_idx\` ON \`session_message\` (\`session_id\`,\`type\`,\`time_created\`,\`id\`);`,
      )
    })
  },
}

// 以默认导出（default export）暴露迁移，供迁移注册表统一收集
export default migration
