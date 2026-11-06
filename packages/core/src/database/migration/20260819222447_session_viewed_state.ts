// 从 effect 库导入 Effect：用于以函数式效果（effect）风格编排迁移逻辑
import { Effect } from "effect"
// 仅导入类型 DatabaseMigration：数据库迁移（migration）的定义接口
import type { DatabaseMigration } from "../migration.js"

// 声明迁移对象，需满足 DatabaseMigration.Migration 接口（id + up）
const migration: DatabaseMigration.Migration = {
  // 迁移唯一 id：由时间戳 + 随机名称组成，用于记录该迁移是否已应用
  id: "20260819222447_session_viewed_state",
  // up：迁移的升级（up）函数，tx 为包裹好的数据库事务（transaction）句柄
  up(tx) {
    // 用 Effect.gen 以生成器（generator）写法串联多条 SQL 操作
    return Effect.gen(function* () {
      // 执行 SQL：给 session_v2 表新增 time_idle 列，记录会话转为空闲的时间
      yield* tx.run(`ALTER TABLE \`session_v2\` ADD \`time_idle\` integer;`)
      // 新增 time_viewed 列，记录用户最近查看（viewed）会话的时间
      yield* tx.run(`ALTER TABLE \`session_v2\` ADD \`time_viewed\` integer;`)
      // 新增 idle_outcome 列，记录会话空闲结束时的结果（outcome）
      yield* tx.run(`ALTER TABLE \`session_v2\` ADD \`idle_outcome\` text;`)
    })
  },
}

// 以默认导出（default export）暴露迁移，供迁移注册表统一收集
export default migration
