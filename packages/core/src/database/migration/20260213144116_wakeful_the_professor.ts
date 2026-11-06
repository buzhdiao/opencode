// 从 effect 导入 Effect：迁移逻辑以 Effect 生成器编写
import { Effect } from "effect"
// 仅导入类型：DatabaseMigration（迁移定义类型）
import type { DatabaseMigration } from "../migration.js"

// 迁移：创建 control_account（受控账号）表
const migration: DatabaseMigration.Migration = {
  // 迁移唯一标识
  id: "20260213144116_wakeful_the_professor",
  // 升级逻辑
  up(tx) {
    // 用 Effect.gen 编排
    return Effect.gen(function* () {
      // 创建 control_account 表：以 email+url 为复合主键，存储访问/刷新令牌及过期时间与启用状态
      yield* tx.run(`
        CREATE TABLE \`control_account\` (
          \`email\` text NOT NULL,
          \`url\` text NOT NULL,
          \`access_token\` text NOT NULL,
          \`refresh_token\` text NOT NULL,
          \`token_expiry\` integer,
          \`active\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`control_account_pk\` PRIMARY KEY(\`email\`, \`url\`)
        );
      `)
    })
  },
}

// 默认导出迁移定义
export default migration
