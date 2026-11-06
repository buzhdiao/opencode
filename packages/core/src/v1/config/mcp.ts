// 将本文件的所有导出聚合到命名空间 ConfigMCPV1 下，供统一引入
export * as ConfigMCPV1 from "./mcp.js"

// effect 库：Schema 数据校验
import { Schema } from "effect"
// 通用 Schema：正整数
import { PositiveInt } from "../../schema.js"

// 本地（stdio）MCP 服务器配置 Schema
export const Local = Schema.Struct({
  // 连接类型固定为 local
  type: Schema.Literal("local").annotate({ description: "Type of MCP server connection" }),
  // 启动 MCP 服务器的命令及参数
  command: Schema.mutable(Schema.Array(Schema.String)).annotate({
    description: "Command and arguments to run the MCP server",
  }),
  // 服务器进程的工作目录（相对路径基于工作区目录解析）
  cwd: Schema.optional(Schema.String).annotate({
    description: "Working directory for the MCP server process. Relative paths resolve from the workspace directory.",
  }),
  // 启动时设置的环境变量
  environment: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({
    description: "Environment variables to set when running the MCP server",
  }),
  // 启动时是否启用该服务器
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Enable or disable the MCP server on startup",
  }),
  // 是否通过 Code Mode 暴露该服务器的工具（默认 true）
  codemode: Schema.optional(Schema.Boolean).annotate({
    description: "Expose this server's tools through Code Mode. Defaults to true.",
  }),
  // 请求超时（毫秒）
  timeout: Schema.optional(PositiveInt).annotate({
    description: "Timeout in ms for MCP server requests. Defaults to 5000 (5 seconds) if not specified.",
  }),
  // 标注 Schema 标识符
}).annotate({ identifier: "McpLocalConfig" })
// Local 的 TypeScript 类型
export type Local = Schema.Schema.Type<typeof Local>

// MCP OAuth 认证配置 Schema
export const OAuth = Schema.Struct({
  // OAuth 客户端 ID（缺省时尝试动态客户端注册 RFC 7591）
  clientId: Schema.optional(Schema.String).annotate({
    description: "OAuth client ID. If not provided, dynamic client registration (RFC 7591) will be attempted.",
  }),
  // OAuth 客户端密钥（授权服务器要求时提供）
  clientSecret: Schema.optional(Schema.String).annotate({
    description: "OAuth client secret (if required by the authorization server)",
  }),
  // 授权时请求的 OAuth 作用域
  scope: Schema.optional(Schema.String).annotate({ description: "OAuth scopes to request during authorization" }),
  // 本地 OAuth 回调端口（1-65535；redirectUri 设置时忽略）
  callbackPort: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))).annotate({
    description:
      "Port for the local OAuth callback server (default: 19876). Shorthand for redirectUri when only the port needs changing. Ignored if redirectUri is set.",
  }),
  // OAuth 重定向 URI
  redirectUri: Schema.optional(Schema.String).annotate({
    description: "OAuth redirect URI (default: http://127.0.0.1:19876/mcp/oauth/callback).",
  }),
  // 标注 Schema 标识符
}).annotate({ identifier: "McpOAuthConfig" })
// OAuth 的 TypeScript 类型
export type OAuth = Schema.Schema.Type<typeof OAuth>

// 远程（HTTP）MCP 服务器配置 Schema
export const Remote = Schema.Struct({
  // 连接类型固定为 remote
  type: Schema.Literal("remote").annotate({ description: "Type of MCP server connection" }),
  // 远程 MCP 服务器的 URL
  url: Schema.String.annotate({ description: "URL of the remote MCP server" }),
  // 启动时是否启用该服务器
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Enable or disable the MCP server on startup",
  }),
  // 是否通过 Code Mode 暴露该服务器的工具（默认 true）
  codemode: Schema.optional(Schema.Boolean).annotate({
    description: "Expose this server's tools through Code Mode. Defaults to true.",
  }),
  // 请求携带的 HTTP 头
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({
    description: "Headers to send with the request",
  }),
  // OAuth 配置（设为 false 可关闭自动检测）
  oauth: Schema.optional(Schema.Union([OAuth, Schema.Literal(false)])).annotate({
    description: "OAuth authentication configuration for the MCP server. Set to false to disable OAuth auto-detection.",
  }),
  // 请求超时（毫秒）
  timeout: Schema.optional(PositiveInt).annotate({
    description: "Timeout in ms for MCP server requests. Defaults to 5000 (5 seconds) if not specified.",
  }),
  // 标注 Schema 标识符
}).annotate({ identifier: "McpRemoteConfig" })
// Remote 的 TypeScript 类型
export type Remote = Schema.Schema.Type<typeof Remote>

// MCP 服务器配置总入口：按 type 区分本地/远程
export const Info = Schema.Union([Local, Remote]).annotate({ discriminator: "type" })
// Info 的 TypeScript 类型
export type Info = Schema.Schema.Type<typeof Info>
