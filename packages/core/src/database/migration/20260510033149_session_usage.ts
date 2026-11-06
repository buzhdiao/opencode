// 从 effect 库导入 Effect：用于以函数式效果（effect）风格编排迁移逻辑
import { Effect } from "effect"
// 仅导入类型 DatabaseMigration：数据库迁移（migration）的定义接口
import type { DatabaseMigration } from "../migration.js"

// 声明迁移对象，需满足 DatabaseMigration.Migration 接口（id + up）
const migration: DatabaseMigration.Migration = {
  // 迁移唯一 id：由时间戳 + 随机名称组成，用于记录该迁移是否已应用
  id: "20260510033149_session_usage",
  // up：迁移的升级（up）函数，tx 为包裹好的数据库事务（transaction）句柄
  up(tx) {
    // 用 Effect.gen 以生成器（generator）写法串联多条 SQL 操作
    return Effect.gen(function* () {
      // 给 session（会话）表新增 cost 列：会话累计花费（非空，默认 0）
      yield* tx.run(`ALTER TABLE \`session\` ADD \`cost\` real DEFAULT 0 NOT NULL;`)
      // 新增 tokens_input 列：输入 token 总数（非空，默认 0）
      yield* tx.run(`ALTER TABLE \`session\` ADD \`tokens_input\` integer DEFAULT 0 NOT NULL;`)
      // 新增 tokens_output 列：输出 token 总数（非空，默认 0）
      yield* tx.run(`ALTER TABLE \`session\` ADD \`tokens_output\` integer DEFAULT 0 NOT NULL;`)
      // 新增 tokens_reasoning 列：推理（reasoning）token 总数（非空，默认 0）
      yield* tx.run(`ALTER TABLE \`session\` ADD \`tokens_reasoning\` integer DEFAULT 0 NOT NULL;`)
      // 新增 tokens_cache_read 列：缓存读取（cache read）token 总数（非空，默认 0）
      yield* tx.run(`ALTER TABLE \`session\` ADD \`tokens_cache_read\` integer DEFAULT 0 NOT NULL;`)
      // 新增 tokens_cache_write 列：缓存写入（cache write）token 总数（非空，默认 0）
      yield* tx.run(`ALTER TABLE \`session\` ADD \`tokens_cache_write\` integer DEFAULT 0 NOT NULL;`)
      // 回填（backfill）历史数据：遍历全部 session，把每条消息 JSON 中的
      // 花费与各类 token 用量汇总（仅统计 role=assistant 的消息），写入新列
      yield* tx.run(`
        UPDATE session
        SET
          cost = coalesce((
            SELECT sum(coalesce(json_extract(message.data, '$.cost'), 0))
            FROM message
            WHERE message.session_id = session.id
              AND json_extract(message.data, '$.role') = 'assistant'
          ), 0),
          tokens_input = coalesce((
            SELECT sum(coalesce(json_extract(message.data, '$.tokens.input'), 0))
            FROM message
            WHERE message.session_id = session.id
              AND json_extract(message.data, '$.role') = 'assistant'
          ), 0),
          tokens_output = coalesce((
            SELECT sum(coalesce(json_extract(message.data, '$.tokens.output'), 0))
            FROM message
            WHERE message.session_id = session.id
              AND json_extract(message.data, '$.role') = 'assistant'
          ), 0),
          tokens_reasoning = coalesce((
            SELECT sum(coalesce(json_extract(message.data, '$.tokens.reasoning'), 0))
            FROM message
            WHERE message.session_id = session.id
              AND json_extract(message.data, '$.role') = 'assistant'
          ), 0),
          tokens_cache_read = coalesce((
            SELECT sum(coalesce(json_extract(message.data, '$.tokens.cache.read'), 0))
            FROM message
            WHERE message.session_id = session.id
              AND json_extract(message.data, '$.role') = 'assistant'
          ), 0),
          tokens_cache_write = coalesce((
            SELECT sum(coalesce(json_extract(message.data, '$.tokens.cache.write'), 0))
            FROM message
            WHERE message.session_id = session.id
              AND json_extract(message.data, '$.role') = 'assistant'
          ), 0)
      `)
    })
  },
}

// 以默认导出（default export）暴露迁移，供迁移注册表统一收集
export default migration
