// 从 effect 库导入 Effect：用于以函数式效果（effect）风格编排迁移逻辑
import { Effect } from "effect"
// 仅导入类型 DatabaseMigration：数据库迁移（migration）的定义接口
import type { DatabaseMigration } from "../migration.js"

// 声明迁移对象，需满足 DatabaseMigration.Migration 接口（id + up）
const migration: DatabaseMigration.Migration = {
  // 迁移唯一 id：由时间戳 + 随机名称组成，用于记录该迁移是否已应用
  id: "20261029165540_schedule_checks",
  // up：迁移的升级（up）函数，tx 为包裹好的数据库事务（transaction）句柄
  up(tx) {
    // 用 Effect.gen 以生成器（generator）写法串联多条 SQL 操作
    return Effect.gen(function* () {
      // 执行 SQL：给 schedule（定时计划）表新增 check 列，定义触发前的
      // 前置检查（checks）表达式
      yield* tx.run(`ALTER TABLE \`schedule\` ADD \`check\` text;`)
      // 新增 checks 列：统计已执行的前置检查次数（非空，默认 0）
      yield* tx.run(`ALTER TABLE \`schedule\` ADD \`checks\` integer DEFAULT 0 NOT NULL;`)
      // 新增 failures 列：统计检查失败的次数（非空，默认 0）
      yield* tx.run(`ALTER TABLE \`schedule\` ADD \`failures\` integer DEFAULT 0 NOT NULL;`)
      // 新增 state 列：记录检查器的内部状态（如最近检查的上下文）
      yield* tx.run(`ALTER TABLE \`schedule\` ADD \`state\` text;`)
    })
  },
}

// 以默认导出（default export）暴露迁移，供迁移注册表统一收集
export default migration
