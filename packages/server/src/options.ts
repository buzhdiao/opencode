// 引入数据库选项 Schema 定义
import { Database } from "@opencode/core/database/database"
// 引入 models.dev 模型目录模块
import { ModelsDev } from "@opencode/core/models-dev"
// 引入持久化 PTY（伪终端）模块
import { PersistentPty } from "@opencode/core/persistent-pty"
// 引入 Effect 的 Schema 库，用于声明并校验选项结构
import { Schema } from "effect"
// 引入 Node 平台层的 Fetch 类型（仅类型导入）
import type { LayerNodePlatform } from "@opencode/util/effect/app-node-platform"

// 服务端启动选项的 Schema 结构：既做校验，也推导出 ServerOptions 类型
export const ServerOptions = Schema.Struct({
  // 可选的应用信息块
  app: Schema.optional(
    Schema.Struct({
      // 应用名称
      name: Schema.optional(Schema.String),
      // 应用版本号
      version: Schema.optional(Schema.String),
      // 发布渠道标识
      channel: Schema.optional(Schema.String),
    }),
  ),
  // 监听主机名（缺省 127.0.0.1）
  hostname: Schema.optional(Schema.String),
  // 监听端口：0~65535 之间的整数（缺省时自动挑选可用端口）
  port: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(65_535))),
  // 访问密码（服务器启动的必要条件）
  password: Schema.optional(Schema.String),
  // 允许的 CORS（跨源资源共享）来源列表
  cors: Schema.optional(Schema.Array(Schema.String)),
  // 是否启用模拟（simulation）模式
  simulation: Schema.optional(Schema.Boolean),
  // 数据库相关选项
  database: Schema.optional(Database.Options),
  // 持久化 PTY 相关选项
  pty: Schema.optional(PersistentPty.Options),
  // 事件系统选项块
  events: Schema.optional(
    Schema.Struct({
      // 是否把事件持久化到存储
      persist: Schema.optional(Schema.Boolean),
    }),
  ),
  // models.dev 模型目录选项
  models: Schema.optional(ModelsDev.Options),
  // 替换 OpenCode 自身 HTTP 请求所用的 fetch 实现（详见下方英文说明）
  /**
   * Replaces `globalThis.fetch` for OpenCode's own HTTP requests: OpenCode Console config, model requests, web fetch
   * and search, well-known config, and remote MCP servers. Agent code in Code Mode keeps `globalThis.fetch`. For
   * example, a Cloudflare Worker can route requests through a Service Binding.
   */
  // 自定义 fetch：仅接受函数值（Schema.declare 定义不透明类型并做运行时判断）
  fetch: Schema.optional(Schema.declare((input): input is LayerNodePlatform.Fetch => typeof input === "function")),
  // 已连接的 OpenCode Console 配置保持新鲜的方式（详见下方英文说明）
  /**
   * How a connected OpenCode Console's config stays fresh. `poll` (default `true`) re-checks it every minute in the
   * background. With `poll: false` it refreshes only when a prompt starts, so a host that suspends between prompts,
   * such as a Durable Object, can stay idle.
   */
  // Console 配置刷新选项块
  console: Schema.optional(Schema.Struct({ poll: Schema.optional(Schema.Boolean) })),
  // 配置加载选项块
  config: Schema.optional(
    Schema.Struct({
      // 配置目录路径
      directory: Schema.optional(Schema.String),
      // 是否按项目加载配置
      project: Schema.optional(Schema.Boolean),
      // 是否加载 claude 兼容配置
      claude: Schema.optional(Schema.Boolean),
      // 内联配置的文件路径
      file: Schema.optional(Schema.String),
      // 内联配置的内容字符串
      content: Schema.optional(Schema.String),
    }),
  ),
  // Windows 平台专用选项块
  windows: Schema.optional(
    Schema.Struct({
      // Git Bash 可执行文件路径
      gitbash: Schema.optional(Schema.String),
    }),
  ),
  // 文件系统相关选项块
  fs: Schema.optional(
    Schema.Struct({
      // 是否启用文件监视器（filewatcher）
      filewatcher: Schema.optional(Schema.Boolean),
      // 是否启用 fff 文件索引
      fff: Schema.optional(Schema.Boolean),
    }),
  ),
})
// 从 Schema 推导出的选项类型（与校验结构一一对应）
export type ServerOptions = typeof ServerOptions.Type
