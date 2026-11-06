// 从 drizzle-orm 的 SQLite 核心模块导入建表辅助函数：sqliteTable（定义表）、text（文本列）、integer（整数列）、primaryKey（复合主键）
import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core"

// 导入数据库通用的 Timestamps 字段集（created_at / updated_at 等时间戳列），供各表复用
import { Timestamps } from "../database/schema.sql.js"

// 定义 account（账户）表：存储每个账号的登录信息与令牌
export const AccountTable = sqliteTable("account", {
  // 主键 id：账户的唯一标识（文本类型）
  id: text().primaryKey(),
  // email：账户邮箱，不允许为空
  email: text().notNull(),
  // url：账户所属平台的地址（例如 API 基址），不允许为空
  url: text().notNull(),
  // access_token：访问令牌（access token），用于调用平台 API
  access_token: text().notNull(),
  // refresh_token：刷新令牌（refresh token），用于在访问令牌过期后换取新令牌
  refresh_token: text().notNull(),
  // token_expiry：令牌过期时间（整数列，通常为 Unix 毫秒时间戳），可空
  token_expiry: integer(),
  // 展开公共时间戳字段（created_at / updated_at）
  ...Timestamps,
})

// 定义 account_state（账户状态）表：记录全局当前激活的账户与组织（organization）
export const AccountStateTable = sqliteTable("account_state", {
  // 主键 id：单行状态记录的标识（整数）
  id: integer().primaryKey(),
  // active_account_id：当前激活账户的外键，指向 account 表的 id；账户被删除时置为 NULL（set null）
  active_account_id: text().references(() => AccountTable.id, { onDelete: "set null" }),
  // active_org_id：当前激活的组织 ID，可空
  active_org_id: text(),
})

// LEGACY
// （遗留表，仅为兼容旧数据保留）定义 control_account（控制端账户）表：旧版账户存储，以 email + url 作为复合主键
export const ControlAccountTable = sqliteTable(
  "control_account",
  {
    // email：账户邮箱，不允许为空（复合主键的一部分）
    email: text().notNull(),
    // url：账户所属平台地址，不允许为空（复合主键的一部分）
    url: text().notNull(),
    // access_token：访问令牌
    access_token: text().notNull(),
    // refresh_token：刷新令牌
    refresh_token: text().notNull(),
    // token_expiry：令牌过期时间，可空
    token_expiry: integer(),
    // active：是否为激活账户（布尔模式的整数列），默认 false
    active: integer({ mode: "boolean" })
      .notNull()
      .$default(() => false),
    // 展开公共时间戳字段
    ...Timestamps,
  },
  // 表约束：声明 (email, url) 复合主键
  (table) => [primaryKey({ columns: [table.email, table.url] })],
)
