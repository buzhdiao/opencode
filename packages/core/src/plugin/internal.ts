// 以命名空间形式整体再导出本模块
export * as PluginInternal from "./internal.js"

// LLMClient：LLM 客户端服务
import { LLMClient } from "@opencode/ai/effect"
// Plugin：插件类型
import type { Plugin } from "@opencode/plugin/effect/plugin"
// LayerNode：服务层（Layer）节点注册表辅助
import { LayerNode } from "@opencode/util/effect/layer-node"
// Generation：插件注册后的最终形态
import type { Generation } from "./service.js"
// httpClient/httpFetch：平台级 HTTP 客户端服务节点
import { httpClient, httpFetch } from "@opencode/util/effect/app-node-platform"
// AppProcess：子进程管理服务
import { AppProcess } from "@opencode/util/process"
// Context/Effect/Scope：依赖容器、效果运行时、作用域
import { Context, Effect, Scope } from "effect"
// FetchHttpClient/HttpClient：HTTP 客户端实现
import { FetchHttpClient, HttpClient } from "effect/http"
// 以下为核心服务模块
import { Agent } from "../agent.js"
import { App } from "../app.js"
import { Artifact } from "../artifact.js"
import { Model } from "../model.js"
import { Provider } from "../provider.js"
import { Command } from "../command.js"
import { Config } from "../config.js"
import { Credential } from "../credential.js"
// llmClient：LLM 客户端服务节点
import { llmClient } from "../effect/app-node-platform.js"
// 配置驱动的各插件（agent/command/compaction 等）
import { ConfigAgentPlugin } from "../config/plugin/agent.js"
import { ConfigCommandPlugin } from "../config/plugin/command.js"
import { ConfigCompactionPlugin } from "../config/plugin/compaction.js"
import { ConfigFormatterPlugin } from "../config/plugin/formatter.js"
import { ConfigImagePlugin } from "../config/plugin/image.js"
import { ConfigInstructionPlugin } from "../config/plugin/instruction.js"
import { ConfigLocationWatcherPlugin } from "../config/plugin/location-watcher.js"
import { ConfigMcpPlugin } from "../config/plugin/mcp.js"
import { ConfigProviderPlugin } from "../config/plugin/provider.js"
import { ConfigPolicyPlugin } from "../config/plugin/policy.js"
import { ConfigReferencePlugin } from "../config/plugin/reference.js"
import { ConfigShellPlugin } from "../config/plugin/shell.js"
import { ConfigSnapshotPlugin } from "../config/plugin/snapshot.js"
import { ConfigSkillPlugin } from "../config/plugin/skill.js"
import { ConfigCompatibilityPlugin } from "../config/plugin/compatibility.js"
import { ConfigToolOutputPlugin } from "../config/plugin/tool-output.js"
import { ConfigWebSearchPlugin } from "../config/plugin/websearch.js"
import { ConfigWorktreePlugin } from "../config/plugin/worktree.js"
// Worktree 及其策略
import { Worktree } from "../worktree.js"
import { WorktreeStrategies } from "../worktree/strategies.js"
// 以下为内部服务模块
import { Bus } from "../bus.js"
import { Environment } from "../environment/index.js"
import { FileAccess } from "../file-access.js"
import { FileMutation } from "../file-mutation.js"
import { FileWrite } from "../file-write.js"
import { Flag } from "../flag.js"
import { Formatter } from "../formatter.js"
import { Generate } from "../generate.js"
import { Form } from "../form.js"
import { FileSystem } from "../filesystem.js"
import { LocationWatcherPolicy } from "../filesystem/location-watcher-policy.js"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Image } from "../image.js"
import { InstructionDiscovery } from "../instruction-discovery.js"
import { Integration } from "../integration.js"
import { Job } from "../job.js"
import { KV } from "../kv.js"
import { Location } from "../location.js"
import { ModelsDev } from "../models-dev.js"
import { Mcp } from "../mcp/index.js"
import { Npm } from "@opencode/util/npm"
import { Permission } from "../permission.js"
import { Reference } from "../reference.js"
import { WebSearch } from "../websearch.js"
import { Ripgrep } from "../ripgrep.js"
import { Schedule } from "../schedule.js"
import { Session } from "../session.js"
import { SessionCompaction } from "../session/compaction.js"
import { SessionInstructions } from "../session/instructions.js"
import { SubagentJob } from "../session/subagent-job.js"
import { SharedCache } from "../shared-cache.js"
import { Shell } from "../shell.js"
import { ShellSelect } from "../shell/select.js"
import { Snapshot } from "../snapshot.js"
import { Skill } from "../skill.js"
import { SkillDiscovery } from "../skill/discovery.js"
import { Watcher } from "../filesystem/watcher.js"
// 各内置工具插件
import { PatchTool } from "../tool/plugin/patch.js"
import { EditTool } from "../tool/plugin/edit.js"
import { GlobTool } from "../tool/plugin/glob.js"
import { GrepTool } from "../tool/plugin/grep.js"
import { ImageGenerateTool } from "../tool/plugin/image-generate.js"
import { McpEventTools } from "../tool/plugin/mcp-events.js"
import { McpResourceTools } from "../tool/plugin/mcp-resource.js"
import { OpenCodeTools } from "../tool/plugin/opencode.js"
import { QuestionTool } from "../tool/plugin/question.js"
import { ReadToolFileSystem } from "../tool/read-filesystem.js"
import { ReadTool } from "../tool/plugin/read.js"
import { ArtifactTools } from "../tool/plugin/artifact.js"
import { ScheduleTools } from "../tool/plugin/schedule.js"
import { ShellTool } from "../tool/plugin/shell.js"
import { SkillTool } from "../tool/plugin/skill.js"
import { SubagentTool } from "../tool/plugin/subagent.js"
import { TodoTool } from "../tool/plugin/todo.js"
import { Tool } from "../tool.js"
import { ToolOutput } from "../tool-output.js"
import { WebFetchTool } from "../tool/plugin/webfetch.js"
import { WebSearchTool } from "../tool/plugin/websearch.js"
import { WellKnown } from "../wellknown.js"
import { WriteTool } from "../tool/plugin/write.js"
// 以下为内部功能插件
import { AgentPlugin } from "./agent.js"
// 浏览器插件（默认导出）
import BrowserPlugin from "@opencode/plugin-browser"
import { CommandPlugin } from "./command.js"
import { IdentityPlugin } from "./identity.js"
import { ForkNoticePlugin } from "./fork-notice.js"
import { PlanPlugin } from "./plan.js"
import { GoalPlugin } from "./goal.js"
import { ModelsDevPlugin } from "./models-dev.js"
import { McpCodeModeDefaultsPlugin } from "./mcp-codemode-defaults.js"
import { ProviderPlugins } from "./provider.js"
import { DynamicProviderPlugin } from "./provider/dynamic.js"
import { OpencodePlugin } from "./provider/opencode.js"
import { WebSearchPlugins } from "./websearch/index.js"
import { SkillPlugin } from "./skill.js"
import { VcsHgPlugin } from "./vcs/hg.js"
import { ToolInputRepairPlugin } from "./tool-input-repair.js"
import { OptimizePlugin } from "./optimize.js"
import { VcsGitPlugin } from "./vcs/git.js"
import { VerbosityPlugin } from "./verbosity.js"
import { WarmingPlugin } from "./warming.js"
import { WellKnownPlugin } from "../wellknown/plugin.js"

// 插件激活所需的基础服务集合（requirements 列表的来源）
const services = [
  // 逐项列出各服务标识（Context.Tag）
  Agent.Service,
  // Activation clears the ambient context, so built-ins see the configured build channel only through this.
  App.Service,
  FetchHttpClient.Fetch,
  Artifact.Service,
  AppProcess.Service,
  Provider.Service,
  Model.Service,
  Command.Service,
  Config.Service,
  Credential.Service,
  Bus.Service,
  Environment.Service,
  FileAccess.Service,
  FileMutation.Service,
  FileWrite.Service,
  Flag.Service,
  Formatter.Service,
  Generate.Service,
  LocationWatcherPolicy.Service,
  FileSystem.Service,
  FSUtil.Service,
  Global.Service,
  HttpClient.HttpClient,
  Image.Service,
  InstructionDiscovery.Service,
  Integration.Service,
  Job.Service,
  KV.Service,
  LLMClient.Service,
  Location.Service,
  ModelsDev.Service,
  Mcp.Service,
  Npm.Service,
  Permission.Service,
  Form.Service,
  ReadToolFileSystem.Service,
  Reference.Service,
  WebSearch.Service,
  Ripgrep.Service,
  Schedule.Service,
  Session.Service,
  SessionCompaction.Service,
  SessionInstructions.Service,
  SubagentJob.Service,
  SharedCache.Service,
  Shell.Service,
  ShellSelect.Service,
  Snapshot.Service,
  Skill.Service,
  SkillDiscovery.Service,
  Tool.Service,
  ToolOutput.Service,
  Watcher.Service,
  WellKnown.Service,
  Worktree.Service,
  WorktreeStrategies.Service,
] as const

// Requirements 类型：上述服务集合的组合标识类型
export type Requirements = Context.Service.Identifier<(typeof services)[number]>

// requirements：所有服务节点的分组层（group），供插件宿主构建运行环境
export const requirements = LayerNode.group([
  // 逐项列出各服务的节点定义
  Agent.node,
  App.node,
  Artifact.node,
  AppProcess.node,
  Provider.node,
  Model.node,
  Command.node,
  Config.node,
  Credential.node,
  Bus.node,
  Environment.node,
  FileAccess.node,
  FileMutation.node,
  FileWrite.node,
  Flag.node,
  Formatter.node,
  Generate.node,
  LocationWatcherPolicy.node,
  FileSystem.node,
  FSUtil.node,
  Global.node,
  // 平台 HTTP 客户端节点
  httpClient,
  // 平台 fetch 节点
  httpFetch,
  Image.node,
  InstructionDiscovery.node,
  Integration.node,
  Job.node,
  Shell.daemonNode,
  KV.node,
  // LLM 客户端节点
  llmClient,
  Location.node,
  ModelsDev.node,
  Mcp.node,
  Npm.node,
  Permission.node,
  Form.node,
  ReadToolFileSystem.node,
  Reference.node,
  WebSearch.node,
  Ripgrep.node,
  Schedule.node,
  Session.node,
  SessionCompaction.node,
  SessionInstructions.node,
  SubagentJob.node,
  SharedCache.node,
  Shell.node,
  ShellSelect.node,
  Snapshot.node,
  Skill.node,
  SkillDiscovery.node,
  Tool.node,
  ToolOutput.node,
  Watcher.node,
  WellKnown.node,
  Worktree.node,
  WorktreeStrategies.node,
])

// InternalPlugin 类型：要求上述服务（及 Scope）的插件
export type InternalPlugin = Plugin<Requirements | Scope.Scope>

// pre：前置插件列表（先于用户配置插件激活），顺序影响钩子执行次序
const pre = [
  // 工具输入修复插件
  ToolInputRepairPlugin.Plugin,
  // 配置 worktree 插件
  ConfigWorktreePlugin.Plugin,
  // 配置 MCP 插件
  ConfigMcpPlugin.Plugin,
  // MCP Code Mode 默认值插件
  McpCodeModeDefaultsPlugin.Plugin,
  // WellKnown 插件
  WellKnownPlugin.Plugin,
  // Git 版本控制插件
  VcsGitPlugin.Plugin,
  // agent 能力插件
  AgentPlugin.Plugin,
  ForkNoticePlugin.Plugin,
  PlanPlugin.Plugin,
  // 命令插件
  CommandPlugin.Plugin,
  // 目标（goal）插件
  GoalPlugin.Plugin,
  // 技能（skill）插件
  SkillPlugin.Plugin,
  // Mercurial 版本控制插件
  VcsHgPlugin.Plugin,
  // models.dev 目录插件
  ModelsDevPlugin,
  // 所有提供商插件
  ...ProviderPlugins,
  // 所有网页搜索插件
  ...WebSearchPlugins,
  // patch 工具
  PatchTool.Plugin,
  // Render model prompts after the patch plugin selects the available editing tools.
  // 在 patch 插件确定可用编辑工具之后，再渲染各模型的提示词。
  ...OptimizePlugin.Plugins,
  // 输出详细程度（verbosity）插件
  VerbosityPlugin.Plugin,
  // 模型身份提示插件
  IdentityPlugin.Plugin,
  // 以下为各内置工具
  EditTool.Plugin,
  GlobTool.Plugin,
  GrepTool.Plugin,
  ImageGenerateTool.Plugin,
  OpenCodeTools.Plugin,
  McpEventTools.Plugin,
  McpResourceTools.Plugin,
  QuestionTool.Plugin,
  ReadTool.Plugin,
  ArtifactTools.Plugin,
  ScheduleTools.Plugin,
  ShellTool.Plugin,
  SkillTool.Plugin,
  SubagentTool.Plugin,
  TodoTool.Plugin,
  WebFetchTool.Plugin,
  WebSearchTool.Plugin,
  WriteTool.Plugin,
  // 预热（warming）插件
  WarmingPlugin.Plugin,
] as const satisfies readonly InternalPlugin[]

// post：后置插件列表（在用户配置插件之后激活）
const post = [
  // 配置指令插件
  ConfigInstructionPlugin.Plugin,
  // 配置引用插件
  ConfigReferencePlugin.Plugin,
  // 配置 agent 插件
  ConfigAgentPlugin.Plugin,
  // 浏览器插件
  BrowserPlugin,
  // 配置命令插件
  ConfigCommandPlugin.Plugin,
  // 配置压缩插件
  ConfigCompactionPlugin.Plugin,
  // 配置格式化器插件
  ConfigFormatterPlugin.Plugin,
  // 配置图片插件
  ConfigImagePlugin.Plugin,
  // 配置位置监听插件
  ConfigLocationWatcherPlugin.Plugin,
  // 配置 shell 插件
  ConfigShellPlugin.Plugin,
  // 配置快照插件
  ConfigSnapshotPlugin.Plugin,
  // 配置工具输出插件
  ConfigToolOutputPlugin.Plugin,
  // 配置兼容性插件
  ConfigCompatibilityPlugin.Plugin,
  // 配置技能插件
  ConfigSkillPlugin.Plugin,
  // 配置提供商插件
  ConfigProviderPlugin.Plugin,
  // Run the dynamic npm SDK loader after SDK, instance, and external plugins register their `sdk` hooks.
  // 动态 npm SDK 加载器须在 SDK/实例/外部插件注册完各自的 `sdk` 钩子之后再运行。
  DynamicProviderPlugin,
  // 配置网页搜索插件
  ConfigWebSearchPlugin.Plugin,
  // 配置策略插件（受保护）
  ConfigPolicyPlugin.Plugin,
] as const satisfies readonly InternalPlugin[]

// Repository config must not switch off policy enforcement or the Console connection that delivers
// organization statements, so plugin remove operations skip these IDs.
// 仓库配置不得关掉策略执行或提供组织声明的 Console 连接，因此插件移除操作会跳过这些 ID。
export const guarded: ReadonlySet<string> = new Set([OpencodePlugin.id, ConfigPolicyPlugin.Plugin.id])

// list：产出内部插件的"前置/后置"两份注册记录
export const list = Effect.fn("PluginInternal.list")(function* () {
  // Capture only services; activation supplies the child Scope and batching context.
  // 只从当前环境挑选（pick）所需服务；激活时再提供子作用域与批处理上下文。
  const context = Context.pick(...services)(yield* Effect.context<Requirements>())
  // resolve：把插件包装成 Generation 记录（注入服务上下文）
  const resolve = (plugins: readonly InternalPlugin[]) =>
    // 逐个映射
    plugins.map(
      (plugin) =>
        ({
          // 插件 ID
          id: plugin.id,
          // 激活效果：运行插件 effect 并注入服务上下文
          effect: (host) => plugin.effect(host).pipe(Effect.provide(context)),
          // 固定版本标记：内置
          revision: "internal",
          // 来源：内置（builtin）
          source: { type: "builtin" },
          // 满足 Generation 类型
        }) satisfies Generation,
    )
  // 返回前置与后置两组注册记录
  return {
    // 前置插件
    pre: resolve(pre),
    // 后置插件
    post: resolve(post),
  }
})
