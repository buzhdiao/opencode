// 从 effect 导入 Effect：迁移逻辑以 Effect 生成器编写
import { Effect } from "effect"
// 仅导入类型：DatabaseMigration（迁移定义类型）
import type { DatabaseMigration } from "../migration.js"

// 迁移：调整 workspace 表结构（新增类型/名称/目录/扩展字段，删除 config 字段）
const migration: DatabaseMigration.Migration = {
  // 迁移唯一标识
  id: "20260303231226_add_workspace_fields",
  // 升级逻辑
  up(tx) {
    // 用 Effect.gen 编排
    return Effect.gen(function* () {
      // 新增必填的 type 列（工作区类型）
      yield* tx.run(`ALTER TABLE \`workspace\` ADD \`type\` text NOT NULL;`)
      // 新增可空的 name 列（工作区名称）
      yield* tx.run(`ALTER TABLE \`workspace\` ADD \`name\` text;`)
      // 新增可空的 directory 列（工作目录）
      yield* tx.run(`ALTER TABLE \`workspace\` ADD \`directory\` text;`)
      // 新增可空的 extra 列（扩展配置）
      yield* tx.run(`ALTER TABLE \`workspace\` ADD \`extra\` text;`)
      // 删除不再使用的 config 列（其信息并入 extra）
      yield* tx.run(`ALTER TABLE \`workspace\` DROP COLUMN \`config\`;`)
    })
  },
}

// 默认导出迁移定义
export default migration
