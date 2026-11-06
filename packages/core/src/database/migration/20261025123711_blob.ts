// 从 effect 库导入 Effect：用于以函数式效果（effect）风格编排迁移逻辑
import { Effect } from "effect"
// 仅导入类型 DatabaseMigration：数据库迁移（migration）的定义接口
import type { DatabaseMigration } from "../migration.js"

// 声明迁移对象，需满足 DatabaseMigration.Migration 接口（id + up）
const migration: DatabaseMigration.Migration = {
  // 迁移唯一 id：由时间戳 + 随机名称组成，用于记录该迁移是否已应用
  id: "20261025123711_blob",
  // up：迁移的升级（up）函数，tx 为包裹好的数据库事务（transaction）句柄
  up(tx) {
    // 用 Effect.gen 以生成器（generator）写法串联多条 SQL 操作
    return Effect.gen(function* () {
      // 执行 SQL：创建 blob_ref（内容块引用）表，记录消息引用了哪些内容块；
      // 主键 (session_id, message_id, hash)，两条外键分别级联删除
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
      // 创建 blob（二进制大对象）表：按哈希去重存储附件内容，
      // 包含 MIME 类型、字节数与图片尺寸信息
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
      // 创建 hash 上的索引（index）：加速反查“哪些消息引用了某内容块”
      yield* tx.run(`CREATE INDEX \`blob_ref_hash_idx\` ON \`blob_ref\` (\`hash\`);`)
      // 创建 (session_id, seq) 索引：加速按会话顺序读取引用
      yield* tx.run(`CREATE INDEX \`blob_ref_session_seq_idx\` ON \`blob_ref\` (\`session_id\`,\`seq\`);`)
    })
  },
}

// 以默认导出（default export）暴露迁移，供迁移注册表统一收集
export default migration
