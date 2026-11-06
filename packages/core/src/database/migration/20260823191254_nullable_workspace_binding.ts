// 从 effect 库导入 Effect：用于以函数式效果（effect）风格编排迁移逻辑
import { Effect } from "effect"
// 仅导入类型 DatabaseMigration：数据库迁移（migration）的定义接口
import type { DatabaseMigration } from "../migration.js"

// 声明迁移对象，需满足 DatabaseMigration.Migration 接口（id + up）
const migration: DatabaseMigration.Migration = {
  // 迁移唯一 id：由时间戳 + 随机名称组成，用于记录该迁移是否已应用
  id: "20260823191254_nullable_workspace_binding",
  // foreignKeys 设为 false：执行迁移前放宽外键（foreign keys）约束
  foreignKeys: false,
  // up：迁移的升级（up）函数，tx 为包裹好的数据库事务（transaction）句柄
  up(tx) {
    // 用 Effect.gen 以生成器（generator）写法串联多条 SQL 操作
    return Effect.gen(function* () {
      // 执行 SQL：创建 __new_workspace 影子表——binding（绑定）列改为可空，
      // 允许暂未绑定提供方资源的工作区存在
      yield* tx.run(`
        CREATE TABLE \`__new_workspace\` (
          \`id\` text PRIMARY KEY,
          \`provider\` text NOT NULL,
          \`binding\` text,
          \`created_at\` integer NOT NULL,
          \`last_used_at\` integer NOT NULL
        );
      `)
      // 把旧 workspace 表的全部数据原样搬到影子表
      yield* tx.run(
        `INSERT INTO \`__new_workspace\`(\`id\`, \`provider\`, \`binding\`, \`created_at\`, \`last_used_at\`) SELECT \`id\`, \`provider\`, \`binding\`, \`created_at\`, \`last_used_at\` FROM \`workspace\`;`,
      )
      // 删除旧表，准备换名
      yield* tx.run(`DROP TABLE \`workspace\`;`)
      // 把影子表重命名为 workspace，完成表结构替换
      yield* tx.run(`ALTER TABLE \`__new_workspace\` RENAME TO \`workspace\`;`)
    })
  },
}

// 以默认导出（default export）暴露迁移，供迁移注册表统一收集
export default migration
