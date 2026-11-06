// 从 effect 导入 Effect：迁移逻辑以 Effect 生成器编写
import { Effect } from "effect"
// 仅导入类型：DatabaseMigration（迁移定义类型）
import type { DatabaseMigration } from "../migration.js"

// 迁移：把“所选组织”从账号表迁移到账号状态表（组织选择属于全局状态而非账号属性）
const migration: DatabaseMigration.Migration = {
  // 迁移唯一标识
  id: "20260309230000_move_org_to_state",
  // 升级逻辑
  up(tx) {
    // 用 Effect.gen 编排
    return Effect.gen(function* () {
      // 给 account_state 表新增 active_org_id 列
      yield* tx.run(`ALTER TABLE \`account_state\` ADD \`active_org_id\` text;`)
      // 数据搬迁：把每个激活账号原有的 selected_org_id 回填到状态表的新列
      yield* tx.run(
        `UPDATE \`account_state\` SET \`active_org_id\` = (SELECT \`selected_org_id\` FROM \`account\` WHERE \`account\`.\`id\` = \`account_state\`.\`active_account_id\`);`,
      )
      // 删除 account 表上的旧列
      yield* tx.run(`ALTER TABLE \`account\` DROP COLUMN \`selected_org_id\`;`)
    })
  },
}

// 默认导出迁移定义
export default migration
