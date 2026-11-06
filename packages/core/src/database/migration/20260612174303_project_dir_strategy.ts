// 从 effect 库导入 Effect：用于以函数式效果（effect）风格编排迁移逻辑
import { Effect } from "effect"
// 仅导入类型 DatabaseMigration：数据库迁移（migration）的定义接口
import type { DatabaseMigration } from "../migration.js"

// 声明迁移对象，需满足 DatabaseMigration.Migration 接口（id + up）
const migration: DatabaseMigration.Migration = {
  // 迁移唯一 id：由时间戳 + 随机名称组成，用于记录该迁移是否已应用
  id: "20260612174303_project_dir_strategy",
  // up：迁移的升级（up）函数，tx 为包裹好的数据库事务（transaction）句柄
  up(tx) {
    // 用 Effect.gen 以生成器（generator）写法串联多条 SQL 操作
    return Effect.gen(function* () {
      // 给 project_directory（项目目录）表新增 strategy（策略）列，
      // 记录目录的处理策略（SQLite 的 ADD COLUMN 不能同时加非空无默认列）
      yield* tx.run(`ALTER TABLE \`project_directory\` ADD \`strategy\` text;`)
      // 临时关闭外键（foreign keys）约束，避免表重建期间触发外键检查
      yield* tx.run(`PRAGMA foreign_keys=OFF;`)
      // 执行 SQL：创建 __new_project_directory 影子表——type 改为可空，
      // 并带上新增的 strategy 列，主键与外键定义保持不变
      yield* tx.run(`
        CREATE TABLE \`__new_project_directory\` (
          \`project_id\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`type\` text,
          \`strategy\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`project_directory_pk\` PRIMARY KEY(\`project_id\`, \`directory\`),
          CONSTRAINT \`fk_project_directory_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      // 把旧表数据整体搬迁到影子表（strategy 列暂为 NULL，后续按需回填）
      yield* tx.run(
        `INSERT INTO \`__new_project_directory\`(\`project_id\`, \`directory\`, \`type\`, \`time_created\`) SELECT \`project_id\`, \`directory\`, \`type\`, \`time_created\` FROM \`project_directory\`;`,
      )
      // 删除旧表，准备换名
      yield* tx.run(`DROP TABLE \`project_directory\`;`)
      // 把影子表重命名为正式表名，完成表结构替换
      yield* tx.run(`ALTER TABLE \`__new_project_directory\` RENAME TO \`project_directory\`;`)
      // 表重建完成，重新开启外键约束
      yield* tx.run(`PRAGMA foreign_keys=ON;`)
    })
  },
}

// 以默认导出（default export）暴露迁移，供迁移注册表统一收集
export default migration
