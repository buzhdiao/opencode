// 从 effect 库导入 Effect：用于以函数式效果（effect）风格编排迁移逻辑
import { Effect } from "effect"
// 仅导入类型 DatabaseMigration：数据库迁移（migration）的定义接口
import type { DatabaseMigration } from "../migration.js"

// 声明迁移对象，需满足 DatabaseMigration.Migration 接口（id + up）
const migration: DatabaseMigration.Migration = {
  // 迁移唯一 id：由时间戳 + 随机名称组成，用于记录该迁移是否已应用
  id: "20261025154125_drop_session_pending",
  // up：迁移的升级（up）函数，tx 为包裹好的数据库事务（transaction）句柄
  up(tx) {
    // 用 Effect.gen 以生成器（generator）写法串联多条 SQL 操作
    return Effect.gen(function* () {
      // 执行 SQL：删除 session_pending（会话待处理项）表的各索引（index）
      yield* tx.run(`DROP INDEX IF EXISTS \`session_pending_session_delivery_seq_idx\`;`)
      // 删除压缩（compaction）唯一索引
      yield* tx.run(`DROP INDEX IF EXISTS \`session_pending_session_compaction_idx\`;`)
      // 删除接纳序号（admitted_seq）唯一索引
      yield* tx.run(`DROP INDEX IF EXISTS \`session_pending_session_admitted_seq_idx\`;`)
      // 删除整张 session_pending 表：待处理项改由 session_inbox 承载
      yield* tx.run(`DROP TABLE IF EXISTS \`session_pending\`;`)
    })
  },
}

// 以默认导出（default export）暴露迁移，供迁移注册表统一收集
export default migration
