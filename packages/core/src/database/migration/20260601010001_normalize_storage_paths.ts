// 从 effect 库导入 Effect：用于以函数式效果（effect）风格编排迁移逻辑
import { Effect } from "effect"
// 仅导入类型 DatabaseMigration：数据库迁移（migration）的定义接口
import type { DatabaseMigration } from "../migration.js"

// 声明迁移对象，需满足 DatabaseMigration.Migration 接口（id + up）
const migration: DatabaseMigration.Migration = {
  // 迁移唯一 id：由时间戳 + 随机名称组成，用于记录该迁移是否已应用
  id: "20260601010001_normalize_storage_paths",
  // up：迁移的升级（up）函数，tx 为包裹好的数据库事务（transaction）句柄
  up(tx) {
    // 用 Effect.gen 以生成器（generator）写法串联多条 SQL 操作
    return Effect.gen(function* () {
      // 归一化（normalize）project 表的 worktree 路径：把 Windows 风格的反斜杠
      // 分隔符（char(92) 即 \）替换为正斜杠 /，只处理盘符（C:\...）或 UNC（\\...）路径
      yield* tx.run(
        `UPDATE project SET worktree = REPLACE(worktree, char(92), '/') WHERE worktree GLOB '[A-Za-z]:' || char(92) || '*' OR worktree LIKE char(92) || char(92) || '%';`,
      )
      // 归一化 project 表的 sandboxes（JSON 列表）：把双反斜杠换成 /，
      // 仅当字段含反斜杠且 worktree 是盘符路径或 // 开头时才处理
      yield* tx.run(
        `UPDATE project SET sandboxes = REPLACE(sandboxes, char(92) || char(92), '/') WHERE instr(sandboxes, char(92)) > 0 AND (worktree GLOB '[A-Za-z]:*' OR worktree LIKE '//%');`,
      )
      // 归一化 session（会话）表的 directory 字段：同样把 Windows 反斜杠换成 /
      yield* tx.run(
        `UPDATE session SET directory = REPLACE(directory, char(92), '/') WHERE directory GLOB '[A-Za-z]:' || char(92) || '*' OR directory LIKE char(92) || char(92) || '%';`,
      )
      // 归一化 session 表的 path 字段：为空值跳过，含反斜杠且目录属于
      // Windows/UNC 风格时才替换，避免误改类 Unix 路径
      yield* tx.run(
        `UPDATE session SET path = REPLACE(path, char(92), '/') WHERE path IS NOT NULL AND instr(path, char(92)) > 0 AND (directory GLOB '[A-Za-z]:*' OR directory LIKE '//%');`,
      )
    })
  },
}

// 以默认导出（default export）暴露迁移，供迁移注册表统一收集
export default migration
