// effect 库：Layer 分层合并
import { Layer } from "effect"
// 各 API 分组的处理器层（每行一组）
import { GenerateHandler } from "./handlers/generate"
import { VoiceHandler } from "./handlers/voice"
import { MessageHandler } from "./handlers/message"
import { ModelHandler } from "./handlers/model"
import { ProviderHandler } from "./handlers/provider"
import { SessionHandler } from "./handlers/session"
import { PermissionHandler } from "./handlers/permission"
import { FileSystemHandler } from "./handlers/fs"
import { FormHandler } from "./handlers/form"
import { CommandHandler } from "./handlers/command"
import { SkillHandler } from "./handlers/skill"
import { RpcHandler } from "./handlers/rpc"
import { EventHandler } from "./handlers/event"
import { AgentHandler } from "./handlers/agent"
import { PluginHandler } from "./handlers/plugin"
import { ServerHandler } from "./handlers/server"
import { DebugHandler } from "./handlers/debug"
import { PtyHandler } from "./handlers/pty"
import { PersistentPtyHandler } from "./handlers/persistent-pty"
import { ShellHandler } from "./handlers/shell"
import { ReferenceHandler } from "./handlers/reference"
import { LocationHandler } from "./handlers/location"
import { IntegrationHandler } from "./handlers/integration"
import { WebSearchHandler } from "./handlers/websearch"
import { UsageHandler } from "./handlers/usage"
import { McpHandler } from "./handlers/mcp"
import { CredentialHandler } from "./handlers/credential"
import { ProjectHandler } from "./handlers/project"
import { WorktreeHandler } from "./handlers/worktree"
import { VcsHandler } from "./handlers/vcs"
// 事件馈送层（供事件处理器使用）
import { EventFeed } from "./event-feed"
import { MigrationHandler } from "./handlers/migration"
import { ConfigHandler } from "./handlers/config"

// 汇总全部处理器层为单一 Layer（随分组新增在此追加）
export const handlers = Layer.mergeAll(
  // 服务器信息
  ServerHandler,
  // 调试接口
  DebugHandler,
  // 配置迁移
  MigrationHandler,
  // Location 管理
  LocationHandler,
  // 代理
  AgentHandler,
  // 插件
  PluginHandler,
  // 会话
  SessionHandler,
  // 消息
  MessageHandler,
  // 模型
  ModelHandler,
  // 生成
  GenerateHandler,
  // 语音
  VoiceHandler,
  // 提供商
  ProviderHandler,
  // 集成
  IntegrationHandler,
  // 网页搜索
  WebSearchHandler,
  // 用量
  UsageHandler,
  // MCP 服务器
  McpHandler,
  // 凭据
  CredentialHandler,
  // 项目
  ProjectHandler,
  // 表单
  FormHandler,
  // 权限
  PermissionHandler,
  // 文件系统
  FileSystemHandler,
  // 命令
  CommandHandler,
  // 技能
  SkillHandler,
  // RPC
  RpcHandler,
  // 事件流（附带事件馈送层依赖）
  EventHandler.pipe(Layer.provide(EventFeed.layer)),
  // 终端（PTY）
  PtyHandler,
  // 持久化终端
  PersistentPtyHandler,
  // Shell
  ShellHandler,
  // 引用
  ReferenceHandler,
  // 工作树
  WorktreeHandler,
  // 版本控制
  VcsHandler,
  // 配置
  ConfigHandler,
)
