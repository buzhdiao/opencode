// 控制台访问（Console Access）：为已连接的 OpenCode Console 提供配置刷新选项与请求头工具。
export * as ConsoleAccess from "./console-access.js"

import type { Credential } from "./credential.js"

export const defaultServer = "https://opencode.ai/console"

/** The OpenCode Console a credential signed in to. */
// 从凭据（credential）元数据中解析登录的 Console 地址，缺省回退到默认服务端
export function server(value: Credential.Value) {
  // 元数据带 server 字符串则使用之，否则回退默认服务端
  const server = typeof value.metadata?.server === "string" ? value.metadata.server : defaultServer
  // Credentials saved before August 2026 store the retired console.opencode.ai host, which maps path-for-path onto
  // the default server; rewriting it lets that host be shut down without forcing those users to reconnect.
  // 把已废弃的 console.opencode.ai 主机重写到默认服务端（路径一一对应），旧凭据无需重新登录
  return server.replace(/^https:\/\/console\.opencode\.ai(?=\/|$)/, defaultServer)
}

/** Authenticates a Console request as the credential's member, in the workspace the sign-in chose. */
// 为 Console 请求构造认证头：以凭据身份（Bearer 令牌）并在登录时选择的工作区（workspace）内调用
export function headers(value: Credential.Key | Credential.OAuth): Record<string, string> {
  // 可选的组织（org）ID
  const orgID = value.metadata?.orgID
  return {
    // OAuth 型用访问令牌，Key 型用密钥
    authorization: `Bearer ${value.type === "oauth" ? value.access : value.key}`,
    // 有组织 ID 时附加 x-org-id 请求头
    ...(typeof orgID === "string" ? { "x-org-id": orgID } : {}),
  }
}
