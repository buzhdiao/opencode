// 从 effect 库导入 Effect：用于以函数式效果（effect）风格编排迁移逻辑
import { Effect } from "effect"
// 仅导入类型 DatabaseMigration：数据库迁移（migration）的定义接口
import type { DatabaseMigration } from "../migration.js"

// 声明迁移对象，需满足 DatabaseMigration.Migration 接口（id + up）
const migration: DatabaseMigration.Migration = {
  // 迁移唯一 id：由时间戳 + 随机名称组成，用于记录该迁移是否已应用
  id: "20261030054400_job",
  // up：迁移的升级（up）函数，tx 为包裹好的数据库事务（transaction）句柄
  up(tx) {
    // 用 Effect.gen 以生成器（generator）写法串联多条 SQL 操作
    return Effect.gen(function* () {
      // 执行 SQL：创建 job（后台任务）表：以 notification_id（通知标识）为主键，
      // kind 区分任务类型，status/output/error 记录执行状态与结果，
      // recovery 保存恢复（recovery）上下文供后续重建任务
      yield* tx.run(`
        CREATE TABLE \`job\` (
          \`notification_id\` text PRIMARY KEY,
          \`id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`child_session_id\` text,
          \`kind\` text NOT NULL,
          \`title\` text,
          \`status\` text NOT NULL,
          \`output\` text,
          \`error\` text,
          \`recovery\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      // 创建 session_id 上的索引（index）：加速按主会话查询任务
      yield* tx.run(`CREATE INDEX \`job_session_idx\` ON \`job\` (\`session_id\`);`)
      // 创建 child_session_id 上的索引：加速按子会话反查任务
      yield* tx.run(`CREATE INDEX \`job_child_session_idx\` ON \`job\` (\`child_session_id\`);`)
      // 创建 id 上的索引：加速按任务自身标识查询
      yield* tx.run(`CREATE INDEX \`job_id_idx\` ON \`job\` (\`id\`);`)
      // 数据搬迁：把 kv 表中 key 以 'job.background/' 开头的后台任务记录
      // 解析（json_extract 各字段）后写入 job 表；OR IGNORE 跳过主键冲突，
      // WHERE 过滤掉缺少通知标识或会话标识的残缺记录
      yield* tx.run(`
        INSERT OR IGNORE INTO \`job\` (
          \`notification_id\`, \`id\`, \`session_id\`, \`child_session_id\`, \`kind\`, \`title\`,
          \`status\`, \`output\`, \`error\`, \`recovery\`, \`time_created\`, \`time_updated\`
        )
        SELECT
          json_extract(\`value\`, '$.notificationID'),
          json_extract(\`value\`, '$.id'),
          COALESCE(json_extract(\`value\`, '$.recovery.sessionID'), json_extract(\`value\`, '$.recovery.parentSessionID')),
          json_extract(\`value\`, '$.recovery.childSessionID'),
          json_extract(\`value\`, '$.recovery.kind'),
          COALESCE(
            json_extract(\`value\`, '$.recovery.command'),
            json_extract(\`value\`, '$.recovery.description'),
            json_extract(\`value\`, '$.recovery.path')
          ),
          json_extract(\`value\`, '$.status'),
          json_extract(\`value\`, '$.output'),
          json_extract(\`value\`, '$.error'),
          json_extract(\`value\`, '$.recovery'),
          \`time_created\`,
          \`time_updated\`
        FROM \`kv\`
        WHERE \`key\` LIKE 'job.background/%'
          AND json_extract(\`value\`, '$.notificationID') IS NOT NULL
          AND json_extract(\`value\`, '$.id') IS NOT NULL
          AND COALESCE(json_extract(\`value\`, '$.recovery.sessionID'), json_extract(\`value\`, '$.recovery.parentSessionID')) IS NOT NULL;
      `)
      // 搬迁完成后删除 kv 表中的旧后台任务记录，避免数据双份
      yield* tx.run(`DELETE FROM \`kv\` WHERE \`key\` LIKE 'job.background/%';`)
    })
  },
}

// 以默认导出（default export）暴露迁移，供迁移注册表统一收集
export default migration
