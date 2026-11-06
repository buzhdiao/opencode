// 从 effect 库导入 Effect：用于以函数式效果（effect）风格编排迁移逻辑
import { Effect } from "effect"
// 仅导入类型 DatabaseMigration：数据库迁移（migration）的定义接口
import type { DatabaseMigration } from "../migration.js"

// 声明迁移对象，需满足 DatabaseMigration.Migration 接口（id + up）
const migration: DatabaseMigration.Migration = {
  // 迁移唯一 id：由时间戳 + 随机名称组成，用于记录该迁移是否已应用
  id: "20261026223005_schedule",
  // up：迁移的升级（up）函数，tx 为包裹好的数据库事务（transaction）句柄
  up(tx) {
    // 用 Effect.gen 以生成器（generator）写法串联多条 SQL 操作
    return Effect.gen(function* () {
      // 执行 SQL：创建 schedule（定时计划）表，定义会话的定时触发规则：
      // when 为触发表达式、tz 为时区，next_due_at 记录下次到期时间，
      // remaining_runs/run_count 跟踪剩余与已执行次数，last_* 记录最近一次触发结果
      yield* tx.run(`
        CREATE TABLE \`schedule\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text,
          \`name\` text,
          \`action\` text NOT NULL,
          \`when\` text NOT NULL,
          \`tz\` text NOT NULL,
          \`status\` text DEFAULT 'active' NOT NULL,
          \`next_due_at\` integer,
          \`ends_at\` integer,
          \`remaining_runs\` integer,
          \`run_count\` integer DEFAULT 0 NOT NULL,
          \`last_fired_at\` integer,
          \`last_message_id\` text,
          \`last_outcome\` text,
          \`retry_at\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_schedule_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      // 创建 session_id 上的索引（index）：加速按会话查询其定时计划
      yield* tx.run(`CREATE INDEX \`schedule_session_idx\` ON \`schedule\` (\`session_id\`);`)
      // 创建部分索引：仅覆盖状态为 active 且已有下次到期时间的行，
      // 加速调度器扫描“到期待执行”的计划
      yield* tx.run(
        `CREATE INDEX \`schedule_due_idx\` ON \`schedule\` (\`next_due_at\`) WHERE "schedule"."status" = 'active' and "schedule"."next_due_at" is not null;`,
      )
    })
  },
}

// 以默认导出（default export）暴露迁移，供迁移注册表统一收集
export default migration
