// 从 effect 库导入 Effect：用于以函数式效果（effect）风格编排迁移逻辑
import { Effect } from "effect"
// 仅导入类型 DatabaseMigration：数据库迁移（migration）的定义接口
import type { DatabaseMigration } from "../migration.js"

// 声明迁移对象，需满足 DatabaseMigration.Migration 接口（id + up）
const migration: DatabaseMigration.Migration = {
  // 迁移唯一 id：由时间戳 + 随机名称组成，用于记录该迁移是否已应用
  id: "20260622170816_reset_v2_session_state",
  // up：迁移的升级（up）函数，tx 为包裹好的数据库事务（transaction）句柄
  up(tx) {
    // 用 Effect.gen 以生成器（generator）写法串联多条 SQL 操作
    return Effect.gen(function* () {
      // 执行 SQL：重置 v2 会话状态——清空 session_context_epoch
      // （会话上下文纪元）表
      yield* tx.run(`DELETE FROM \`session_context_epoch\`;`)
      // 清空 session_input（会话输入收件箱）表
      yield* tx.run(`DELETE FROM \`session_input\`;`)
      // 清空 session_message（会话消息）表
      yield* tx.run(`DELETE FROM \`session_message\`;`)
      // 清空 event（事件）表
      yield* tx.run(`DELETE FROM \`event\`;`)
      // 清空 event_sequence（事件序号）表，让序号从零重新分配
      yield* tx.run(`DELETE FROM \`event_sequence\`;`)
    })
  },
}

// 以默认导出（default export）暴露迁移，供迁移注册表统一收集
export default migration
