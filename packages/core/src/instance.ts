// 引入 Effect 的上下文（Context）、Effect 与层（Layer）
import { Context, Effect, Layer } from "effect"
// 以下引入构成实例（instance）图的各服务模块
import { Agent } from "./agent.js"
import { Artifact } from "./artifact.js"
import { AISDK } from "./aisdk.js"
import { Model } from "./model.js"
import { Provider } from "./provider.js"
import { Command } from "./command.js"
import { Config } from "./config.js"
// 引入层节点（LayerNode）工具：组合、替换与编译依赖图
import { LayerNode } from "@opencode/util/effect/layer-node"
// 引入位置图节点基础类型与全局共享标签
import { Node } from "@opencode/util/effect/app-node"
import { FileMutation } from "./file-mutation.js"
import { FileWrite } from "./file-write.js"
import { Environment } from "./environment/index.js"
import { Formatter } from "./formatter.js"
import { FileSystem } from "./filesystem.js"
import { FileSystemSearch } from "./filesystem/search.js"
import { Generate } from "./generate.js"
import { Voice } from "./voice.js"
import { UsageLimits } from "./usage-limits.js"
import { Form } from "./form.js"
import { Image } from "./image.js"
import { LocationWatcher } from "./filesystem/location-watcher.js"
import { Integration } from "./integration.js"
import { Location } from "./location.js"
import { LocationLifecycle } from "./location-lifecycle.js"
import { FileAccess } from "./file-access.js"
import { ModelResolver } from "./model-resolver.js"
import { Mcp } from "./mcp/index.js"
import { Permission } from "./permission.js"
import { Plugin } from "./plugin.js"
import { PluginHooks } from "./plugin/hooks.js"
import { InstancePlugins } from "./plugin/instance.js"
import { PluginSupervisor } from "./plugin/supervisor.js"
import { WorktreeStrategies } from "./worktree/strategies.js"
import { Pty } from "./pty.js"
import { Shell } from "./shell.js"
import { ShellSelect } from "./shell/select.js"
import { Reference } from "./reference.js"
import { Rpc } from "./rpc.js"
import { WebSearch } from "./websearch.js"
import { ReferenceInstructions } from "./reference/instructions.js"
import { SessionRunnerLLM } from "./session/runner/llm.js"
import { SessionRunnerModel } from "./session/runner/model.js"
import { SessionCompaction } from "./session/compaction.js"
import { SessionTitle } from "./session/title.js"
import { SessionContext } from "./session/context.js"
import { Skill } from "./skill.js"
import { SkillInstructions } from "./skill/instructions.js"
import { Snapshot } from "./snapshot.js"
import { InstructionDiscovery } from "./instruction-discovery.js"
import { InstructionBuiltIns } from "./instructions/builtins.js"
import { SessionInstructions } from "./session/instructions.js"
import { McpTool } from "./tool/mcp.js"
import { ReadToolFileSystem } from "./tool/read-filesystem.js"
import { Tool } from "./tool.js"
import { ToolOutput } from "./tool-output.js"
import { Vcs } from "./vcs.js"

// 将本模块整体导出为 Instance 命名空间（自导出）
export * as Instance from "./instance.js"
// 转发实例服务定义（Service/node/Interface）到 instance/service.js
export { Service, node, type Interface } from "./instance/service.js"

// 实例图（graph）的全部节点：每个元素都是一个按目录装配的服务节点。
// 列表顺序即依赖顺序——被依赖的服务在前；位置监听器最后启动（见文末注释）。
const nodes = [
  // 目录定位与目录生命周期
  Location.node,
  LocationLifecycle.node,
  // 环境变量与配置发现
  Environment.node,
  Config.node,
  // 代理（agent）、产物（artifact）与命令（command）
  Agent.node,
  Artifact.node,
  Command.node,
  // 引用（reference）、RPC 与网页搜索
  Reference.node,
  Rpc.node,
  WebSearch.node,
  // 凭据集成
  Integration.node,
  // 提供商（provider）与模型层
  Provider.node,
  Model.node,
  ModelResolver.node,
  AISDK.node,
  // 插件体系（注册、钩子、实例插件、监督者）
  Plugin.node,
  PluginHooks.node,
  InstancePlugins.node,
  PluginSupervisor.node,
  // 工作树（worktree）策略
  WorktreeStrategies.node,
  // 文件系统与内容搜索
  FileSystemSearch.node,
  FileSystem.node,
  // Shell 选择、伪终端（pty）与命令执行
  ShellSelect.node,
  Pty.node,
  Shell.node,
  // 技能（skill）
  Skill.node,
  // 内置指令与指令发现
  InstructionBuiltIns.node,
  InstructionDiscovery.node,
  // 文件访问、变更记录与写入
  FileAccess.node,
  FileMutation.node,
  FileWrite.node,
  // 格式化器
  Formatter.node,
  // MCP 客户端
  Mcp.node,
  // 权限
  Permission.node,
  // 工具与工具输出
  Tool.node,
  ToolOutput.node,
  // 图像归一化
  Image.node,
  // 技能指令与引用指令
  SkillInstructions.node,
  ReferenceInstructions.node,
  // 表单
  Form.node,
  // 生成（文本/图像/决策）
  Generate.node,
  // 语音与用量限制
  Voice.node,
  UsageLimits.node,
  // 读取工具的文件系统视图与 MCP 工具
  ReadToolFileSystem.node,
  McpTool.node,
  // 会话（session）运行链路：指令、模型、压缩、标题、上下文、快照与 LLM 运行器
  SessionInstructions.node,
  SessionRunnerModel.node,
  SessionCompaction.node,
  SessionTitle.node,
  SessionContext.node,
  Snapshot.node,
  SessionRunnerLLM.node,
  // 版本控制集成
  Vcs.node,
  // Start repository watches only after boot-critical filesystem and Git work.
  // 位置监听器最后启动：确保关键的文件系统与 Git 启动工作完成后再监视仓库
  LocationWatcher.node,
] as const satisfies readonly Node.LocationGraph<never, unknown>[]

// 把全部节点组合成一张层节点图（整个实例的依赖图）
export const graph = LayerNode.group(nodes)

// 实例图编译后提供的全部服务类型
export type Services = LayerNode.Output<typeof graph>
// 实例启动唯一可恢复的错误：目录不存在
export type Error = FileSystem.DirectoryNotFoundError

// 实例构造选项
export interface Options {
  // Plugins this instance is born with; empty and absent are equivalent.
  // 随实例自带的插件列表；为空与缺省等价
  readonly plugins?: InstancePlugins.List
  // Filesystem config discovery; true (default) is today's behavior. When
  // false the instance boots vanilla: no upward config scan, no global config
  // dir, no plugin-dir loading or ambient plugin module imports, no boot-time
  // AGENTS.md discovery. Wellknown integration config and host-injected values
  // still apply, and a config value that explicitly names something
  // file-backed (a skill path, an MCP command) is a request, not discovery.
  // Use-triggered behavior also stays: reading a file still injects nested
  // AGENTS.md instructions — that is session-time context, not boot-time
  // population.
  // 是否启用文件系统配置发现（默认 true）。false 时实例以"原味（vanilla）"
  // 模式启动：不向上扫描配置、无全局配置目录、不加载插件目录或环境插件模块、
  // 不做启动期 AGENTS.md 发现；wellknown 集成配置与宿主注入值仍然生效，
  // 显式指定文件路径的配置项仍是请求而非发现；使用期行为不变（读文件仍会
  // 注入嵌套 AGENTS.md 指令——那是会话期上下文，不是启动期装配）。
  readonly discovery?: boolean
  // 调用方的层替换项（优先于 vanilla 默认替换）
  readonly replacements?: LayerNode.Replacements
}

// Vanilla neutralizes the discovery inputs; the plugin list stays untouched.
// These are defaults ahead of caller replacements: a host that replaces a
// gated node itself owns that node's discovery flags. Plugin-directory
// discovery needs no swap here — implicit scanning only triggers on Directory
// config entries, which a no-scan Config never produces, and the default
// source still honors explicit plugin operations from wellknown and
// host-injected config.
// vanilla 模式下中和"发现"相关输入；插件列表保持不动。
// 这些替换排在调用方替换之前：自己替换受控节点的宿主自行决定其发现开关。
// 插件目录发现无需在此替换——隐式扫描只由 Directory 配置项触发，而关闭扫描
// 的 Config 不会产生该配置；默认插件来源仍遵守 wellknown 与宿主注入配置中的
// 显式插件操作。
const vanillaReplacements: LayerNode.Replacements = [
  // 关闭项目级与全局级配置发现
  Config.node.replace(Config.configured({ project: false, global: false })),
  // 同步关闭指令发现
  InstructionDiscovery.node.replace(InstructionDiscovery.configured({ project: false, global: false })),
]

// 用一份全新编译的图副本把服务立在一个目录上：一个目录即一个实例
// One instance is one compiled, fresh copy of the graph standing on a directory.
export function layer(ref: Location.Ref, options: Options = {}): Layer.Layer<Services, Error> {
  // 记录启动起始时间（用于日志中的耗时统计）
  const startedAt = performance.now()
  // Ordered: vanilla defaults, then caller replacements (which win over the
  // defaults), then instance bindings (which win over everything).
  // 替换列表（按优先级递增）：vanilla 默认 → 调用方替换 → 实例自身绑定
  const replacements: LayerNode.Replacements = [
    // vanilla 模式：注入默认替换（关闭文件系统发现）
    ...(options.discovery === false ? vanillaReplacements : []),
    // 调用方替换（覆盖默认值）
    ...(options.replacements ?? []),
    // 实例绑定：把位置节点绑定到具体目录引用
    Location.node.replace(Location.boundNode(ref)),
    // 实例绑定：注入随实例自带的插件列表（缺省为空）
    InstancePlugins.node.replace(InstancePlugins.bound(options.plugins ?? [])),
  ]

  // 编译整张图（全局共享标签使公共服务可跨实例复用），并做三层收尾处理
  return LayerNode.compile(graph, { replacements, shared: Node.tags.values.global }).pipe(
    // A missing directory is expected; other instance boot failures remain defects.
    // 捕获启动失败：目录不存在转为可恢复错误，其余重新抛出视为缺陷（defect）
    Layer.catchCause(
      (cause): Layer.Layer<Services, Error> =>
        Layer.unwrap(
          Effect.failCause(cause).pipe(
            Effect.catch(
              (error): Effect.Effect<never, Error> =>
                error instanceof FileSystem.DirectoryNotFoundError ? Effect.fail(error) : Effect.die(error),
            ),
          ),
        ),
    ),
    // 注册终结器（finalizer）：实例关闭时执行目录生命周期服务的 shutdown
    Layer.tap((context) => Effect.addFinalizer(() => Context.get(context, LocationLifecycle.Service).shutdown)),
    // 记录启动完成日志：目录、工作区 ID 与耗时（毫秒）
    Layer.tap(() =>
      Effect.logInfo("location services booted", {
        directory: ref.directory,
        workspaceID: ref.workspaceID,
        durationMs: Math.round(performance.now() - startedAt),
      }),
    ),
  )
}
