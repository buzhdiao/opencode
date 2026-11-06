// 将本模块以命名空间 IntegrationConnection 整体再导出（barrel 模式，调用方通过该命名空间访问）
export * as IntegrationConnection from "./connection.js"

// 引入连接（connection）相关的 schema 定义
import { Connection } from "@opencode/schema/connection"

// 转发导出凭证信息（CredentialInfo）的运行时值
export const CredentialInfo = Connection.CredentialInfo
// 转发导出凭证信息（CredentialInfo）的类型
export type CredentialInfo = Connection.CredentialInfo

// 转发导出环境变量信息（EnvInfo）的运行时值
export const EnvInfo = Connection.EnvInfo
// 转发导出环境变量信息（EnvInfo）的类型
export type EnvInfo = Connection.EnvInfo

// 转发导出连接信息（Info）的运行时值
export const Info = Connection.Info
// 转发导出连接信息（Info）的类型
export type Info = Connection.Info

// 转发导出连接状态（Status）的运行时值
export const Status = Connection.Status
// 转发导出连接状态（Status）的类型
export type Status = Connection.Status

/** Identity of an access choice; labels and refreshed token values do not identify a new connection. */
// 计算一次访问选择的标识键（key）：凭证选择用 credential:<id>，环境变量选择用 env:<name>
export function key(
  // 入参 connection：凭证（带 id）或环境变量（带名称）二选一，也允许为 undefined（表示未选择）
  connection:
    | { readonly type: "credential"; readonly id: string }
    | { readonly type: "env"; readonly name: string }
    | undefined,
) {
  // 未选择任何连接时返回 undefined
  if (!connection) return undefined
  // 按选择类型拼出稳定键；标签与刷新后的令牌值不参与身份判定（不会产生新连接身份）
  return connection.type === "credential" ? `credential:${connection.id}` : `env:${connection.name}`
}
