// 从 effect 库导入 Effect：用于以函数式效果（effect）风格编排迁移逻辑
import { Effect } from "effect"
// 从 drizzle-orm 导入 sql 标签模板：用于构造参数化的 SQL 查询
import { sql } from "drizzle-orm"
// 仅导入类型 DatabaseMigration：数据库迁移（migration）的定义接口
import type { DatabaseMigration } from "../migration.js"

// 常量：pre-split（拆分前）V2 谱系最后一个迁移的标记 id
const previousV2Marker = "20260730195856_optional_session_title"

// 声明迁移对象，需满足 DatabaseMigration.Migration 接口（id + up）
const migration: DatabaseMigration.Migration = {
  // 迁移唯一 id：由时间戳 + 随机名称组成，用于记录该迁移是否已应用
  id: "20260804233008_loose_psylocke",
  // up：迁移的升级（up）函数，tx 为包裹好的数据库事务（transaction）句柄
  up(tx) {
    // 用 Effect.gen 以生成器（generator）写法串联多条 SQL 操作
    return Effect.gen(function* () {
      // This marker identifies the completed pre-split V2 lineage. Its V2 tables
      // are canonical, so rename them in place instead of replaying the V1 squash.
      // 查询迁移记录表：若该标记存在，说明库已完成拆分前的 V2 升级，
      // 其 V2 表已是标准结构，直接原地改名而不重放 V1 的压缩（squash）流程
      if (yield* tx.get(sql`SELECT id FROM migration WHERE id = ${previousV2Marker}`)) {
        // 检查是否存在只属于 V1（message 表有、session_message 没有）的会话历史
        const v1Only = yield* tx.get(sql`
          SELECT 1
          FROM message
          WHERE NOT EXISTS (
            SELECT 1 FROM session_message WHERE session_message.session_id = message.session_id
          )
          LIMIT 1
        `)
        // 若存在 V1 独有的历史，无法安全合并，直接致命错误终止迁移
        if (v1Only) return yield* Effect.die(new Error("Previous V2 database contains V1-only session history"))

        // 删除旧表 session 上的各索引（index），表即将改名
        yield* tx.run(`DROP INDEX IF EXISTS \`session_project_idx\`;`)
        // 同上：删除按工作区查询的旧索引
        yield* tx.run(`DROP INDEX IF EXISTS \`session_workspace_idx\`;`)
        // 同上：删除按父会话查询的旧索引
        yield* tx.run(`DROP INDEX IF EXISTS \`session_parent_idx\`;`)
        // 同上：删除按挂起时间查询的旧部分索引
        yield* tx.run(`DROP INDEX IF EXISTS \`session_time_suspended_idx\`;`)
        // 把 V2 的 session 表原地改名为 session_v2，腾出 session 表名给新模型
        yield* tx.run(`ALTER TABLE \`session\` RENAME TO \`session_v2\`;`)
        // 在改名后的表上重建按 project_id 查询的索引
        yield* tx.run(`CREATE INDEX \`session_v2_project_idx\` ON \`session_v2\` (\`project_id\`);`)
        // 重建按 workspace_id 查询的索引
        yield* tx.run(`CREATE INDEX \`session_v2_workspace_idx\` ON \`session_v2\` (\`workspace_id\`);`)
        // 重建按 parent_id（父会话）查询的索引
        yield* tx.run(`CREATE INDEX \`session_v2_parent_idx\` ON \`session_v2\` (\`parent_id\`);`)
        // 重建 time_suspended（挂起时间）部分索引：仅覆盖未挂起的行
        yield* tx.run(
          `CREATE INDEX \`session_v2_time_suspended_idx\` ON \`session_v2\` (\`time_suspended\`) WHERE "session_v2"."time_suspended" is not null;`,
        )
        // 删除不再需要的数据迁移记录表 data_migration
        yield* tx.run(`DROP TABLE IF EXISTS \`data_migration\`;`)
        // 删除旧的会话上下文纪元表 session_context_epoch
        yield* tx.run(`DROP TABLE IF EXISTS \`session_context_epoch\`;`)
        // 删除旧的会话输入收件箱表 session_input
        yield* tx.run(`DROP TABLE IF EXISTS \`session_input\`;`)
        // 该分支处理完毕，提前结束迁移
        return
      }

      // 执行 SQL：创建 kv（键值存储）表，IF NOT EXISTS 保证幂等
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`kv\` (
          \`key\` text PRIMARY KEY,
          \`value\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      // 创建 instruction_blob（指令内容块）表：以哈希去重存放指令正文
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`instruction_blob\` (
          \`hash\` text PRIMARY KEY,
          \`value\` text
        );
      `)
      // 创建 instruction_entry（指令条目）表：记录每个会话引用的指令键值，
      // 主键 (session_id, key)，外键关联 session_v2 且级联删除
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`instruction_entry\` (
          \`session_id\` text NOT NULL,
          \`key\` text NOT NULL,
          \`value\` text,
          \`removed\` integer DEFAULT false NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`instruction_entry_pk\` PRIMARY KEY(\`session_id\`, \`key\`),
          CONSTRAINT \`fk_instruction_entry_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      // 创建 instruction_state（指令状态）表：按会话记录指令纪元的
      // 起点序号（epoch_start）、已同步到序号（through_seq）与初始/当前取值
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`instruction_state\` (
          \`session_id\` text PRIMARY KEY,
          \`epoch_start\` integer NOT NULL,
          \`through_seq\` integer NOT NULL,
          \`initial_values\` text NOT NULL,
          \`current_values\` text NOT NULL,
          CONSTRAINT \`fk_instruction_state_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      // 创建 session_pending（会话待处理项）表：存放压缩（compaction）等
      // 待处理载荷，delivery 与 admitted_seq 用于投递去重排序
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`session_pending\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`type\` text NOT NULL,
          \`data\` text NOT NULL,
          \`delivery\` text,
          \`admitted_seq\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_pending_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      // 创建 session_v2（第二代会话）表：完整承载会话的元数据、用量统计、
      // 时间戳与撤销（revert）、权限（permission）等运行状态
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`session_v2\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`workspace_id\` text,
          \`parent_id\` text,
          \`fork_session_id\` text,
          \`fork_boundary\` text,
          \`slug\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`path\` text,
          \`title\` text,
          \`version\` text NOT NULL,
          \`share_url\` text,
          \`summary_additions\` integer,
          \`summary_deletions\` integer,
          \`summary_files\` integer,
          \`summary_diffs\` text,
          \`metadata\` text,
          \`cost\` real DEFAULT 0 NOT NULL,
          \`tokens_input\` integer DEFAULT 0 NOT NULL,
          \`tokens_output\` integer DEFAULT 0 NOT NULL,
          \`tokens_reasoning\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_read\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_write\` integer DEFAULT 0 NOT NULL,
          \`revert\` text,
          \`permission\` text,
          \`agent\` text,
          \`model\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_compacting\` integer,
          \`time_archived\` integer,
          \`time_suspended\` integer,
          CONSTRAINT \`fk_session_v2_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      // 给 event（事件）表新增 created 列：记录事件产生时间（非空，默认 0）
      yield* tx.run(`ALTER TABLE \`event\` ADD \`created\` integer DEFAULT 0 NOT NULL;`)
      // 执行 SQL：创建 __new_session_message 影子表——相比旧表把 seq 列
      // 提前，并把外键指向新的 session_v2 表
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`__new_session_message\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`type\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_session_message_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      // 删除旧 session_message 表（消息投影将按新模型重建）
      yield* tx.run(`DROP TABLE \`session_message\`;`)
      // 把影子表重命名为 session_message，完成表替换
      yield* tx.run(`ALTER TABLE \`__new_session_message\` RENAME TO \`session_message\`;`)
      // 创建 (session_id, seq) 唯一索引：保证同一会话内消息序号唯一
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_message_session_seq_idx\` ON \`session_message\` (\`session_id\`,\`seq\`);`,
      )
      // 创建 (session_id, type, seq) 索引：支持按会话+类型的有序查询
      yield* tx.run(
        `CREATE INDEX \`session_message_session_type_seq_idx\` ON \`session_message\` (\`session_id\`,\`type\`,\`seq\`);`,
      )
      // 创建 (session_id, time_created, id) 索引：支持按会话+时间的有序查询
      yield* tx.run(
        `CREATE INDEX \`session_message_session_time_created_id_idx\` ON \`session_message\` (\`session_id\`,\`time_created\`,\`id\`);`,
      )
      // 创建 time_created 单列索引：支持跨会话按时间检索消息
      yield* tx.run(`CREATE INDEX \`session_message_time_created_idx\` ON \`session_message\` (\`time_created\`);`)
      // 创建 (session_id, delivery, admitted_seq) 索引：加速待处理项按投递方式排队
      yield* tx.run(
        `CREATE INDEX \`session_pending_session_delivery_seq_idx\` ON \`session_pending\` (\`session_id\`,\`delivery\`,\`admitted_seq\`);`,
      )
      // 创建部分唯一索引：同一会话最多存在一条压缩（compaction）待处理项
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_pending_session_compaction_idx\` ON \`session_pending\` (\`session_id\`) WHERE "session_pending"."type" = 'compaction';`,
      )
      // 创建 (session_id, admitted_seq) 唯一索引：同一会话内接纳序号唯一
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_pending_session_admitted_seq_idx\` ON \`session_pending\` (\`session_id\`,\`admitted_seq\`);`,
      )
      // 在 session_v2 上创建按 project_id 查询的索引
      yield* tx.run(`CREATE INDEX \`session_v2_project_idx\` ON \`session_v2\` (\`project_id\`);`)
      // 创建按 workspace_id 查询的索引
      yield* tx.run(`CREATE INDEX \`session_v2_workspace_idx\` ON \`session_v2\` (\`workspace_id\`);`)
      // 创建按 parent_id（父会话）查询的索引
      yield* tx.run(`CREATE INDEX \`session_v2_parent_idx\` ON \`session_v2\` (\`parent_id\`);`)
      // 创建 time_suspended（挂起时间）部分索引：仅覆盖仍在挂起的会话
      yield* tx.run(
        `CREATE INDEX \`session_v2_time_suspended_idx\` ON \`session_v2\` (\`time_suspended\`) WHERE "session_v2"."time_suspended" is not null;`,
      )
      // 清理废弃表：删除 data_migration（数据迁移记录）表
      yield* tx.run(`DROP TABLE \`data_migration\`;`)
      // 删除 session_context_epoch（会话上下文纪元）表
      yield* tx.run(`DROP TABLE \`session_context_epoch\`;`)
      // 删除 session_input（会话输入收件箱）表
      yield* tx.run(`DROP TABLE \`session_input\`;`)
    })
  },
}

// 以默认导出（default export）暴露迁移，供迁移注册表统一收集
export default migration
