// 从 effect 库导入 Effect：用于以函数式效果（effect）风格编排迁移逻辑
import { Effect } from "effect"
// 仅导入类型 DatabaseMigration：数据库迁移（migration）的定义接口
import type { DatabaseMigration } from "../migration.js"

// 声明迁移对象，需满足 DatabaseMigration.Migration 接口（id + up）
const migration: DatabaseMigration.Migration = {
  // 迁移唯一 id：由时间戳 + 随机名称组成，用于记录该迁移是否已应用
  id: "20260622142730_simplify_session_context_epoch",
  // up：迁移的升级（up）函数，tx 为包裹好的数据库事务（transaction）句柄
  up(tx) {
    // 用 Effect.gen 以生成器（generator）写法串联多条 SQL 操作
    return Effect.gen(function* () {
      // 执行 SQL：简化 session_context_epoch（会话上下文纪元）表——
      // 删除 agent（代理）列，该维度改由其他表承担
      yield* tx.run(`ALTER TABLE \`session_context_epoch\` DROP COLUMN \`agent\`;`)
      // 删除 replacement_seq（替换序号）列，简化快照定位逻辑
      yield* tx.run(`ALTER TABLE \`session_context_epoch\` DROP COLUMN \`replacement_seq\`;`)
      // 删除 revision（修订次数）列，不再跟踪快照修订
      yield* tx.run(`ALTER TABLE \`session_context_epoch\` DROP COLUMN \`revision\`;`)
    })
  },
}

// 以默认导出（default export）暴露迁移，供迁移注册表统一收集
export default migration
