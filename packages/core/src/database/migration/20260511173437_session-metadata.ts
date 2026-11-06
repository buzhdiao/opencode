// 从 effect 库导入 Effect：用于以函数式效果（effect）风格编排迁移逻辑
import { Effect } from "effect"
// 仅导入类型 DatabaseMigration：数据库迁移（migration）的定义接口
import type { DatabaseMigration } from "../migration.js"

// 声明迁移对象，需满足 DatabaseMigration.Migration 接口（id + up）
const migration: DatabaseMigration.Migration = {
  // 迁移唯一 id：由时间戳 + 随机名称组成，用于记录该迁移是否已应用
  id: "20260511173437_session-metadata",
  // up：迁移的升级（up）函数，tx 为包裹好的数据库事务（transaction）句柄
  up(tx) {
    // 用 Effect.gen 以生成器（generator）写法串联多条 SQL 操作
    return Effect.gen(function* () {
      // This column briefly shipped again under 20260530232709_lovely_romulus.
      // 防御性检查：查询 session（会话）表的列信息（PRAGMA table_info），
      // 若 metadata 列已存在（该列曾在后续迁移中再次添加过）则直接跳过
      if (
        (yield* tx.all<{ name: string }>(`PRAGMA table_info(\`session\`)`)).some((column) => column.name === "metadata")
      )
        return
      // 执行 SQL：给 session 表新增 metadata（元数据）列，存放任意扩展信息
      yield* tx.run(`ALTER TABLE \`session\` ADD \`metadata\` text;`)
    })
  },
}

// 以默认导出（default export）暴露迁移，供迁移注册表统一收集
export default migration
