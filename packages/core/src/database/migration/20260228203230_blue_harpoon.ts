// 从 effect 导入 Effect：迁移逻辑以 Effect 生成器编写
import { Effect } from "effect"
// 仅导入类型：DatabaseMigration（迁移定义类型）
import type { DatabaseMigration } from "../migration.js"

// 迁移：创建 account（账号）与 account_state（账号状态）表
const migration: DatabaseMigration.Migration = {
  // 迁移唯一标识
  id: "20260228203230_blue_harpoon",
  // 升级逻辑
  up(tx) {
    // 用 Effect.gen 编排
    return Effect.gen(function* () {
      // 创建 account 表：邮箱/URL/令牌信息及所选组织 id
      yield* tx.run(`
        CREATE TABLE \`account\` (
          \`id\` text PRIMARY KEY,
          \`email\` text NOT NULL,
          \`url\` text NOT NULL,
          \`access_token\` text NOT NULL,
          \`refresh_token\` text NOT NULL,
          \`token_expiry\` integer,
          \`selected_org_id\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      // 创建 account_state 单行表：记录当前激活账号（删除账号时置空）
      yield* tx.run(`
        CREATE TABLE \`account_state\` (
          \`id\` integer PRIMARY KEY NOT NULL,
          \`active_account_id\` text,
          FOREIGN KEY (\`active_account_id\`) REFERENCES \`account\`(\`id\`) ON UPDATE no action ON DELETE set null
        );
      `)
    })
  },
}

// 默认导出迁移定义
export default migration
