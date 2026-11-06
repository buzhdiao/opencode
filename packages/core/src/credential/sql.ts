// 从 drizzle-orm 的 SQLite 核心模块导入列类型构造器：integer（整型列）、sqliteTable（表定义函数）、text（文本列）
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
// 导入所有表共用的 Timestamps 字段展开（如 created_at / updated_at 等时间戳列）
import { Timestamps } from "../database/schema.sql.js"
// 仅导入类型：凭据（Credential）的命名空间类型，用于给列标注更精确的 TS 类型
import type { Credential } from "../credential.js"

// 定义 credential（凭据）表的 drizzle 表结构，供类型安全查询与建库使用
export const CredentialTable = sqliteTable("credential", {
  // id 列：文本主键，类型收窄为 Credential.ID（凭据唯一标识）
  id: text().$type<Credential.ID>().primaryKey(),
  // integration_id 列：关联的集成（integration）ID，可为空；类型取自 Credential.Info["integrationID"]
  integration_id: text().$type<Credential.Info["integrationID"]>(),
  // label 列：凭据的显示标签，不允许为空
  label: text().notNull(),
  // value 列：凭据值，以 JSON 模式存储（mode: "json"），类型为 Credential.Value，不允许为空
  value: text({ mode: "json" }).$type<Credential.Value>().notNull(),
  // connector_id 列：连接器（connector）ID，可为空（并非所有凭据都有连接器）
  connector_id: text(),
  // method_id 列：认证方式（method）ID，可为空
  method_id: text(),
  // active 列：是否启用，以布尔整型存储（mode: "boolean"），可为空表示未设置
  active: integer({ mode: "boolean" }),
  // 展开通用时间戳列（创建/更新时间等）
  ...Timestamps,
})
