// 从 effect 导入 Effect：用于以函数式效果（effect）风格编排建表逻辑
import { Effect } from "effect"
// 仅导入类型 DatabaseMigration：数据库迁移（migration）的定义接口
import type { DatabaseMigration } from "./migration.js"

// schema：初始建表（bootstrap schema）定义——省略 id 字段，
// 因为引导建表不算一次增量迁移，只复用其 up 逻辑
const schema: Omit<DatabaseMigration.Migration, "id"> = {
  // up：在单个事务（transaction）中一次性创建全部表与索引
  up(tx) {
    // 用 Effect.gen 以生成器（generator）写法串联多条 SQL 操作
    return Effect.gen(function* () {
      // 执行 SQL：创建 account_state（账户状态）表，记录当前激活的账户与组织
      yield* tx.run(`
        CREATE TABLE \`account_state\` (
          \`id\` integer PRIMARY KEY,
          \`active_account_id\` text,
          \`active_org_id\` text,
          CONSTRAINT \`fk_account_state_active_account_id_account_id_fk\` FOREIGN KEY (\`active_account_id\`) REFERENCES \`account\`(\`id\`) ON DELETE SET NULL
        );
      `)
      // 创建 account（账户）表：邮箱、站点地址与访问/刷新令牌（token）信息
      yield* tx.run(`
        CREATE TABLE \`account\` (
          \`id\` text PRIMARY KEY,
          \`email\` text NOT NULL,
          \`url\` text NOT NULL,
          \`access_token\` text NOT NULL,
          \`refresh_token\` text NOT NULL,
          \`token_expiry\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      // 创建 control_account（控制端账户）表：以 (email, url) 为复合主键，
      // 存放控制平面账户的令牌与激活标记
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
      // 创建 credential（凭据）表：按集成（integration）或连接器
      // （connector）存放认证凭据值
      yield* tx.run(`
        CREATE TABLE \`credential\` (
          \`id\` text PRIMARY KEY,
          \`integration_id\` text,
          \`label\` text NOT NULL,
          \`value\` text NOT NULL,
          \`connector_id\` text,
          \`method_id\` text,
          \`active\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      // 创建 event_sequence（事件序列）表：按聚合（aggregate）记录事件序号
      yield* tx.run(`
        CREATE TABLE \`event_sequence\` (
          \`aggregate_id\` text PRIMARY KEY,
          \`seq\` integer NOT NULL,
          \`owner_id\` text
        );
      `)
      // 创建 event（事件）表：事件溯源（event sourcing）的事件存储，
      // 外键关联序列表并级联删除
      yield* tx.run(`
        CREATE TABLE \`event\` (
          \`id\` text PRIMARY KEY,
          \`aggregate_id\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`created\` integer DEFAULT 0 NOT NULL,
          \`type\` text NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_event_aggregate_id_event_sequence_aggregate_id_fk\` FOREIGN KEY (\`aggregate_id\`) REFERENCES \`event_sequence\`(\`aggregate_id\`) ON DELETE CASCADE
        );
      `)
      // 创建 job（后台任务）表：以通知标识为主键的任务及其恢复上下文
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
      // 创建 kv（键值存储）表：通用键值对存储
      yield* tx.run(`
        CREATE TABLE \`kv\` (
          \`key\` text PRIMARY KEY,
          \`value\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      // 创建 permission（权限）表：项目级权限规则
      yield* tx.run(`
        CREATE TABLE \`permission\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`action\` text NOT NULL,
          \`resource\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_permission_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      // 创建 project_directory（项目目录）表：项目关联的目录与策略
      yield* tx.run(`
        CREATE TABLE \`project_directory\` (
          \`project_id\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`type\` text,
          \`strategy\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`project_directory_pk\` PRIMARY KEY(\`project_id\`, \`directory\`),
          CONSTRAINT \`fk_project_directory_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      // 创建 project（项目）表：工作树位置、版本控制信息、图标、
      // 各类时间戳与沙箱（sandbox）/命令配置
      yield* tx.run(`
        CREATE TABLE \`project\` (
          \`id\` text PRIMARY KEY,
          \`worktree\` text NOT NULL,
          \`vcs\` text,
          \`name\` text,
          \`icon_url\` text,
          \`icon_url_override\` text,
          \`icon_color\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_initialized\` integer,
          \`time_active\` integer DEFAULT 0 NOT NULL,
          \`time_archived\` integer,
          \`sandboxes\` text NOT NULL,
          \`commands\` text
        );
      `)
      // 创建 schedule（定时计划）表：会话的定时触发规则与执行统计
      yield* tx.run(`
        CREATE TABLE \`schedule\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text,
          \`name\` text,
          \`action\` text NOT NULL,
          \`check\` text,
          \`when\` text NOT NULL,
          \`tz\` text NOT NULL,
          \`status\` text DEFAULT 'active' NOT NULL,
          \`next_due_at\` integer,
          \`ends_at\` integer,
          \`remaining_runs\` integer,
          \`run_count\` integer DEFAULT 0 NOT NULL,
          \`checks\` integer DEFAULT 0 NOT NULL,
          \`failures\` integer DEFAULT 0 NOT NULL,
          \`last_fired_at\` integer,
          \`last_message_id\` text,
          \`last_outcome\` text,
          \`retry_at\` integer,
          \`state\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_schedule_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      // 创建 blob_ref（内容块引用）表：消息对二进制内容块的引用关系
      yield* tx.run(`
        CREATE TABLE \`blob_ref\` (
          \`session_id\` text NOT NULL,
          \`message_id\` text NOT NULL,
          \`hash\` text NOT NULL,
          \`seq\` integer NOT NULL,
          CONSTRAINT \`blob_ref_pk\` PRIMARY KEY(\`session_id\`, \`message_id\`, \`hash\`),
          CONSTRAINT \`fk_blob_ref_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_blob_ref_hash_blob_hash_fk\` FOREIGN KEY (\`hash\`) REFERENCES \`blob\`(\`hash\`) ON DELETE CASCADE
        );
      `)
      // 创建 blob（二进制大对象）表：按哈希去重的附件内容
      yield* tx.run(`
        CREATE TABLE \`blob\` (
          \`hash\` text PRIMARY KEY,
          \`mime\` text NOT NULL,
          \`bytes\` integer NOT NULL,
          \`width\` integer,
          \`height\` integer,
          \`data\` blob NOT NULL,
          \`time_created\` integer NOT NULL
        );
      `)
      // 创建 instruction_blob（指令内容块）表：按哈希去重的指令正文
      yield* tx.run(`
        CREATE TABLE \`instruction_blob\` (
          \`hash\` text PRIMARY KEY,
          \`value\` text
        );
      `)
      // 创建 instruction_entry（指令条目）表：会话引用的指令键值，
      // removed 标记删除（墓碑记录）
      yield* tx.run(`
        CREATE TABLE \`instruction_entry\` (
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
      // 创建 instruction_state（指令状态）表：会话指令纪元的同步进度与取值
      yield* tx.run(`
        CREATE TABLE \`instruction_state\` (
          \`session_id\` text PRIMARY KEY,
          \`epoch_start\` integer NOT NULL,
          \`through_seq\` integer NOT NULL,
          \`initial_values\` text NOT NULL,
          \`current_values\` text NOT NULL,
          CONSTRAINT \`fk_instruction_state_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      // 创建 session_inbox（会话收件箱）表：待投递给会话的消息队列
      yield* tx.run(`
        CREATE TABLE \`session_inbox\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`type\` text NOT NULL,
          \`payload\` text NOT NULL,
          \`delivery\` text NOT NULL,
          \`enqueued_seq\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_inbox_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      // 创建 session_message（会话消息）表：消息投影（projection）存储，
      // seq 为聚合内顺序号
      yield* tx.run(`
        CREATE TABLE \`session_message\` (
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
      // 创建 session_part（消息分片）表：消息内容的分片存储
      yield* tx.run(`
        CREATE TABLE \`session_part\` (
          \`message_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`ordinal\` integer NOT NULL,
          \`type\` text NOT NULL,
          \`call_id\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`session_part_pk\` PRIMARY KEY(\`message_id\`, \`ordinal\`),
          CONSTRAINT \`fk_session_part_message_id_session_message_id_fk\` FOREIGN KEY (\`message_id\`) REFERENCES \`session_message\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_session_part_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      // 创建 session_v2（第二代会话）表：会话的完整元数据、用量统计与运行状态
      yield* tx.run(`
        CREATE TABLE \`session_v2\` (
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
          \`time_busy\` integer,
          \`time_idle\` integer,
          \`time_viewed\` integer,
          \`idle_outcome\` text,
          \`time_compacting\` integer,
          \`time_archived\` integer,
          \`time_suspended\` integer,
          \`resume_attempts\` integer DEFAULT 0 NOT NULL,
          CONSTRAINT \`fk_session_v2_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      // 创建 workspace（工作区）表：提供方与绑定（binding）信息
      yield* tx.run(`
        CREATE TABLE \`workspace\` (
          \`id\` text PRIMARY KEY,
          \`provider\` text NOT NULL,
          \`binding\` text,
          \`created_at\` integer NOT NULL,
          \`last_used_at\` integer NOT NULL
        );
      `)
      // 创建 worktree（工作树）表：项目的工作树目录与策略
      yield* tx.run(`
        CREATE TABLE \`worktree\` (
          \`project_id\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`strategy\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`worktree_pk\` PRIMARY KEY(\`project_id\`, \`directory\`),
          CONSTRAINT \`fk_worktree_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      // 创建 event 表的 (aggregate_id, seq) 唯一索引：保证事件序号不重复
      yield* tx.run(`CREATE UNIQUE INDEX \`event_aggregate_seq_idx\` ON \`event\` (\`aggregate_id\`,\`seq\`);`)
      // 创建 event 表的 (aggregate_id, type, seq) 索引：按类型读取事件流
      yield* tx.run(`CREATE INDEX \`event_aggregate_type_seq_idx\` ON \`event\` (\`aggregate_id\`,\`type\`,\`seq\`);`)
      // 创建 job 表按 session_id 查询的索引
      yield* tx.run(`CREATE INDEX \`job_session_idx\` ON \`job\` (\`session_id\`);`)
      // 创建 job 表按 child_session_id（子会话）反查的索引
      yield* tx.run(`CREATE INDEX \`job_child_session_idx\` ON \`job\` (\`child_session_id\`);`)
      // 创建 job 表按自身 id 查询的索引
      yield* tx.run(`CREATE INDEX \`job_id_idx\` ON \`job\` (\`id\`);`)
      // 创建 permission 表的唯一索引：防止同一项目下重复的权限规则
      yield* tx.run(
        `CREATE UNIQUE INDEX \`permission_project_action_resource_idx\` ON \`permission\` (\`project_id\`,\`action\`,\`resource\`);`,
      )
      // 创建 schedule 表按 session_id 查询的索引
      yield* tx.run(`CREATE INDEX \`schedule_session_idx\` ON \`schedule\` (\`session_id\`);`)
      // 创建 schedule 表的到期扫描部分索引：仅覆盖激活且有下次到期时间的行
      yield* tx.run(
        `CREATE INDEX \`schedule_due_idx\` ON \`schedule\` (\`next_due_at\`) WHERE "schedule"."status" = 'active' and "schedule"."next_due_at" is not null;`,
      )
      // 创建 blob_ref 表按 hash 反查引用的索引
      yield* tx.run(`CREATE INDEX \`blob_ref_hash_idx\` ON \`blob_ref\` (\`hash\`);`)
      // 创建 blob_ref 表按会话顺序读取的索引
      yield* tx.run(`CREATE INDEX \`blob_ref_session_seq_idx\` ON \`blob_ref\` (\`session_id\`,\`seq\`);`)
      // 创建 session_inbox 表按投递方式取件的索引
      yield* tx.run(
        `CREATE INDEX \`session_inbox_session_delivery_seq_idx\` ON \`session_inbox\` (\`session_id\`,\`delivery\`,\`enqueued_seq\`);`,
      )
      // 创建 session_inbox 表入队序号唯一索引
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_inbox_session_enqueued_seq_idx\` ON \`session_inbox\` (\`session_id\`,\`enqueued_seq\`);`,
      )
      // 创建 session_message 表 (session_id, seq) 唯一索引：消息顺序号唯一
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_message_session_seq_idx\` ON \`session_message\` (\`session_id\`,\`seq\`);`,
      )
      // 创建 session_message 表按类型有序查询的索引
      yield* tx.run(
        `CREATE INDEX \`session_message_session_type_seq_idx\` ON \`session_message\` (\`session_id\`,\`type\`,\`seq\`);`,
      )
      // 创建 session_message 表按时间有序查询的索引
      yield* tx.run(
        `CREATE INDEX \`session_message_session_time_created_id_idx\` ON \`session_message\` (\`session_id\`,\`time_created\`,\`id\`);`,
      )
      // 创建 session_message 表跨会话按时间检索的索引
      yield* tx.run(`CREATE INDEX \`session_message_time_created_idx\` ON \`session_message\` (\`time_created\`);`)
      // 创建 session_part 表按会话读取分片的索引
      yield* tx.run(
        `CREATE INDEX \`session_part_session_message_idx\` ON \`session_part\` (\`session_id\`,\`message_id\`,\`ordinal\`);`,
      )
      // 创建 session_v2 表按 project_id 查询的索引
      yield* tx.run(`CREATE INDEX \`session_v2_project_idx\` ON \`session_v2\` (\`project_id\`);`)
      // 创建 session_v2 表按 workspace_id 查询的索引
      yield* tx.run(`CREATE INDEX \`session_v2_workspace_idx\` ON \`session_v2\` (\`workspace_id\`);`)
      // 创建 session_v2 表按 parent_id（父会话）查询的索引
      yield* tx.run(`CREATE INDEX \`session_v2_parent_idx\` ON \`session_v2\` (\`parent_id\`);`)
      // 创建 session_v2 表挂起时间部分索引：仅覆盖仍在挂起的会话
      yield* tx.run(
        `CREATE INDEX \`session_v2_time_suspended_idx\` ON \`session_v2\` (\`time_suspended\`) WHERE "session_v2"."time_suspended" is not null;`,
      )
    })
  },
}

// 以默认导出（default export）暴露 schema，供迁移引导流程使用
export default schema
