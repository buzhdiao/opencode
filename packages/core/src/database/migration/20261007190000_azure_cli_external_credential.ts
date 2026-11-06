// 从 effect 库导入 Effect：用于以函数式效果（effect）风格编排迁移逻辑
import { Effect } from "effect"
// 仅导入类型 DatabaseMigration：数据库迁移（migration）的定义接口
import type { DatabaseMigration } from "../migration.js"

// Azure CLI connections were OAuth credentials holding a copy of the CLI's token; they now reference the CLI as an
// external credential source. Dropping the token fields keeps the method and the resource in metadata.
// 声明迁移对象，需满足 DatabaseMigration.Migration 接口（id + up）
const migration: DatabaseMigration.Migration = {
  // 迁移唯一 id：由时间戳 + 随机名称组成，用于记录该迁移是否已应用
  id: "20261007190000_azure_cli_external_credential",
  // up：迁移的升级（up）函数，tx 为包裹好的数据库事务（transaction）句柄
  up(tx) {
    // 用 Effect.gen 以生成器（generator）写法串联多条 SQL 操作
    return Effect.gen(function* () {
      // 执行 SQL：改造 Azure CLI 连接的凭据——原来是持有 CLI 令牌副本的
      // OAuth（开放授权）凭据，现在改为 external（外部）类型，直接引用 CLI。
      // 用 json_set 把 type 改为 'external'，再用 json_remove 删掉
      // access/refresh/expires 三个令牌字段，认证方式与资源信息保留在 metadata 中
      yield* tx.run(`
        UPDATE \`credential\`
        SET \`value\` = json_remove(json_set(\`value\`, '$.type', 'external'), '$.access', '$.refresh', '$.expires')
        WHERE \`integration_id\` = 'azure'
          AND json_extract(\`value\`, '$.type') = 'oauth'
          AND json_extract(\`value\`, '$.methodID') = 'azure-cli'
      `)
    })
  },
}

// 以默认导出（default export）暴露迁移，供迁移注册表统一收集
export default migration
