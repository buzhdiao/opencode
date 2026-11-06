// 从 effect 库导入 Effect：用于以函数式效果（effect）风格编排迁移逻辑
import { Effect } from "effect"
// 仅导入类型 DatabaseMigration：数据库迁移（migration）的定义接口
import type { DatabaseMigration } from "../migration.js"

// 声明迁移对象，需满足 DatabaseMigration.Migration 接口（id + up）
const migration: DatabaseMigration.Migration = {
  // 迁移唯一 id：由时间戳 + 随机名称组成，用于记录该迁移是否已应用
  id: "20260923013825_project_time_active",
  // up：迁移的升级（up）函数，tx 为包裹好的数据库事务（transaction）句柄
  up(tx) {
    // 用 Effect.gen 以生成器（generator）写法串联多条 SQL 操作
    return Effect.gen(function* () {
      // 执行 SQL：给 project（项目）表新增 time_active 列，记录最近活跃时间，
      // 非空且默认 0
      yield* tx.run(`ALTER TABLE \`project\` ADD \`time_active\` integer DEFAULT 0 NOT NULL;`)
      // 回填（backfill）：把已有项目的时间活跃值初始化为各自的 time_updated
      yield* tx.run(`UPDATE \`project\` SET \`time_active\` = \`time_updated\`;`)
    })
  },
}

// 以默认导出（default export）暴露迁移，供迁移注册表统一收集
export default migration
