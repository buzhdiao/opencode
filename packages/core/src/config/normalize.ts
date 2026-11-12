// 配置规范化（Normalize）模块：把 V1 旧版配置与 V2 原生配置统一转换为当前格式，并产出诊断（diagnostics）信息。
export * as ConfigNormalize from "./normalize.js"

// 导入 Node 的深度相等比较工具。
import { isDeepStrictEqual } from "node:util"
// 导入判断普通对象的工具函数。
import { isRecord } from "@opencode/util/record"
// 导入 Effect 的 Option（可选值）与 Schema（模式校验）工具。
import { Option, Schema } from "effect"
// 导入 V2 配置的顶层信息模式。
import { Info } from "@opencode/schema/config"
// 导入代理（agent）配置模式。
import { ConfigAgent } from "@opencode/schema/config/agent"
// 导入命令（command）配置模式。
import { ConfigCommand } from "@opencode/schema/config/command"
// 导入压缩（compaction）配置模式。
import { ConfigCompaction } from "@opencode/schema/config/compaction"
// 导入格式化器（formatter）配置模式。
import { ConfigFormatter } from "@opencode/schema/config/formatter"
// 导入 LSP 配置模式。
import { ConfigLSP } from "@opencode/schema/config/lsp"
// 导入媒体（media）配置模式。
import { ConfigMedia } from "@opencode/schema/config/media"
// 导入模型（model）选择模式。
import { ConfigModel } from "@opencode/schema/config/model"
// 导入 MCP 配置模式。
import { ConfigMCP } from "@opencode/schema/config/mcp"
// 导入插件（plugin）配置模式。
import { ConfigPlugin } from "@opencode/schema/config/plugin"
// 导入策略（policy）配置模式。
import { ConfigPolicy } from "@opencode/schema/config/policy"
// 导入提供方（provider）配置模式。
import { ConfigProvider } from "@opencode/schema/config/provider"
// 导入引用（reference）配置模式。
import { ConfigReference } from "@opencode/schema/config/reference"
// 导入实验特性（experimental）配置模式。
import { ConfigExperimental } from "@opencode/schema/config/experimental"
// 导入权限（permission）规则模式。
import { Permission } from "@opencode/schema/permission"
// 导入 V1 代理配置模式（旧版）。
import { ConfigAgentV1 } from "../v1/config/agent.js"
// 导入 V1 命令配置模式（旧版）。
import { ConfigCommandV1 } from "../v1/config/command.js"
// 导入 V1 MCP 配置模式（旧版）。
import { ConfigMCPV1 } from "../v1/config/mcp.js"
// 导入 V1 权限配置模式（旧版）。
import { ConfigPermissionV1 } from "../v1/config/permission.js"
// 导入 V1 插件配置模式（旧版）。
import { ConfigPluginV1 } from "../v1/config/plugin.js"
// 导入 V1 提供方配置模式（旧版）。
import { ConfigProviderV1 } from "../v1/config/provider.js"
// 导入 V1 迁移工具（旧值到新值的转换函数集）。
import { ConfigMigrateV1 } from "../v1/config/migrate.js"
// 导入正整数品牌类型。
import { PositiveInt } from "../schema.js"

// 诊断条目：kind 为冲突（conflict）/无效（invalid）/不支持（unsupported），path 指向配置中的位置。
export interface Diagnostic {
  // 诊断类别。
  readonly kind: "conflict" | "invalid" | "unsupported"
  // 在配置中的路径（如 ["mcp", "servers"]）。
  readonly path: readonly string[]
  // 人类可读的说明信息。
  readonly message: string
}

// 规范化结果：成功时返回编码后的配置与诊断；整个配置被拒绝（根不是对象）时只返回诊断。
export type Result =
  | {
      // 结果类型：已规范化。
      readonly type: "normalized"
      // 转换后输出的配置对象。
      readonly encoded: Readonly<Record<string, unknown>>
      // 收集到的诊断列表。
      readonly diagnostics: readonly Diagnostic[]
    }
  // 结果类型：整个配置被拒绝。
  | { readonly type: "rejected"; readonly diagnostics: readonly Diagnostic[] }

// Schema 解码选项：报告所有错误、忽略多余属性。
const options = { errors: "all", onExcessProperty: "ignore" } as const
// 顶层不再支持的键：出现即产出 unsupported 诊断。
const unsupportedTopLevel = ["logLevel", "server", "subagent_depth", "layout"] as const
// 实验区不再支持的键。
const unsupportedExperimental = [
  // 粘贴摘要禁用开关。
  "disable_paste_summary",
  // 批量工具。
  "batch_tool",
  // OpenTelemetry。
  "openTelemetry",
  // 主工具列表。
  "primary_tools",
  // 拒绝后继续循环。
  "continue_loop_on_deny",
] as const
// 提供方不再支持的键。
const unsupportedProvider = ["id", "whitelist", "blacklist"] as const
// 模型不再支持的键。
const unsupportedModel = ["release_date", "attachment", "reasoning", "temperature", "experimental"] as const
// V1 autoupdate 字段的合法取值：布尔或 "notify"。
const LegacyAutoupdate = Schema.Literals([true, false, "notify"])

// 规范化入口：输入任意 JSON 值，返回编码后的配置与诊断列表。
export function normalize(input: unknown): Result {
  // 根不是对象时直接拒绝整个配置。
  if (!isRecord(input))
    return {
      type: "rejected",
      diagnostics: [
        { kind: "invalid", path: ["$"], message: "rejected configuration because its root is not an object" },
      ],
    }

  // 收集诊断信息的数组。
  const diagnostics: Diagnostic[] = []
  // 规范化输出的配置对象。
  const encoded: Record<string, unknown> = {}
  // 检查各顶层不再支持的键并记录诊断。
  unsupportedTopLevel.forEach((key) => unsupportedIfPresent(input, key, [key], diagnostics))

  // 旧版 snapshot 布尔字段（是否启用快照）。
  const legacySnapshots = own(input, "snapshot")
    ? decodeEncoded(Schema.Boolean, input.snapshot, ["snapshot"], diagnostics)
    : undefined
  // 旧版 autoupdate 字段（true/false/"notify"）。
  const legacyUpdate = own(input, "autoupdate")
    ? decodeValue(LegacyAutoupdate, input.autoupdate, ["autoupdate"], diagnostics)
    : undefined
  // 新版 update 字段。
  const nativeUpdate = own(input, "update")
    ? decodeEncoded(Info.fields.update, input.update, ["update"], diagnostics)
    : undefined
  // 旧版 autoshare：为 true 时映射为 "auto"，否则无值。
  const legacyShare = own(input, "autoshare")
    ? decodeValue(Schema.Boolean, input.autoshare, ["autoshare"], diagnostics) === true
      ? "auto"
      : undefined
    : undefined
  // 旧版 attachment 字段映射为新的 media 配置。
  const legacyMedia = own(input, "attachment")
    ? decodeEncoded(ConfigMedia.Info, input.attachment, ["attachment"], diagnostics)
    : undefined
  // 有旧版附件配置时写入 media。
  if (legacyMedia !== undefined) encoded.media = legacyMedia
  // 有旧版快照配置时写入 snapshots。
  if (legacySnapshots !== undefined) encoded.snapshots = legacySnapshots
  // 把旧版 autoupdate 三态映射为新版 update 语义：false→disable，"notify"→notify，true→auto。
  const migratedUpdate =
    legacyUpdate === false
      ? "disable"
      : legacyUpdate === "notify"
        ? "notify"
        : legacyUpdate === true
          ? "auto"
          : undefined
  // 新旧 update 择一（冲突记诊断），有值则写入。
  const update = prefer(migratedUpdate, nativeUpdate, ["update"], diagnostics)
  if (update !== undefined) encoded.update = update
  // 旧版 autoshare 迁移结果写入 share。
  if (legacyShare !== undefined) encoded.share = legacyShare

  // 旧版 reference（单数）映射：键名到引用条目。
  const legacyReferences = decodeMap(input.reference, ConfigReference.Entry, ["reference"], diagnostics, decodeEncoded)
  // 新版 references（复数）映射。
  const nativeReferences = decodeMap(
    input.references,
    ConfigReference.Entry,
    ["references"],
    diagnostics,
    decodeEncoded,
  )
  // 合并新旧引用映射（新版优先，冲突记诊断）。
  mergeMap(
    encoded,
    "references",
    legacyReferences,
    nativeReferences,
    isRecord(input.reference) || isRecord(input.references),
    diagnostics,
  )

  // 解码旧版 command 映射。
  const legacyCommands = decodeMap(input.command, ConfigCommandV1.Info, ["command"], diagnostics, decodeValue)
  // 对旧版命令中的模型选择做不支持项诊断。
  diagnoseSelectionMap(input.command, ["command"], diagnostics)
  // 把旧版命令逐个迁移为 V2 规范结构。
  const migratedCommands = mapValues(legacyCommands, (value) =>
    canonical(ConfigCommand.Info, ConfigMigrateV1.migrateCommand(value)),
  )
  // 解码新版 commands 映射。
  const nativeCommands = decodeMap(input.commands, ConfigCommand.Info, ["commands"], diagnostics, decodeEncoded)
  // 合并新旧命令映射。
  mergeMap(
    encoded,
    "commands",
    migratedCommands,
    nativeCommands,
    isRecord(input.command) || isRecord(input.commands),
    diagnostics,
  )

  // 解码旧版 agent 映射并逐个迁移。
  const legacyAgents = mapValues(
    decodeMap(input.agent, ConfigAgentV1.Info, ["agent"], diagnostics, decodeValue),
    (value) => canonical(ConfigAgent.Info, ConfigMigrateV1.migrateAgent(value)),
  )
  // 旧版 small_model 字符串（小型快速模型的引用）。
  const legacySmallModel = own(input, "small_model")
    ? decodeValue(Schema.String, input.small_model, ["small_model"], diagnostics)
    : undefined
  // 把 small_model 迁移为可用的模型选择。
  const migratedSmallModel = ConfigMigrateV1.modelSelection(legacySmallModel)
  // small_model 存在但无法迁移：记 unsupported 诊断。
  if (legacySmallModel && !migratedSmallModel)
    diagnostics.push({
      kind: "unsupported",
      path: ["small_model"],
      message: "omitted unsupported legacy model reference",
    })
  // 能迁移时把 small_model 注入名为 title 的代理作为其模型。
  if (migratedSmallModel)
    legacyAgents.title = {
      model: migratedSmallModel,
      ...legacyAgents.title,
    }
  // 旧版 mode 映射也按代理迁移，并强制标记为主（primary）模式。
  const modeAgents = mapValues(decodeMap(input.mode, ConfigAgentV1.Info, ["mode"], diagnostics, decodeValue), (value) =>
    canonical(ConfigAgent.Info, ConfigMigrateV1.migrateAgent({ ...value, mode: "primary" })),
  )
  // 合并 agent 与 mode 两份旧版代理（同名冲突记诊断）。
  const migratedAgents = mergeMaps(legacyAgents, modeAgents, ["agents"], diagnostics)
  // 解码新版 agents 映射。
  const nativeAgents = decodeMap(input.agents, ConfigAgent.Info, ["agents"], diagnostics, decodeEncoded)
  // 对旧版 agent 做不支持字段的诊断。
  diagnoseAgentUnsupported(input.agent, ["agent"], diagnostics)
  // 对旧版 mode 做不支持字段的诊断。
  diagnoseAgentUnsupported(input.mode, ["mode"], diagnostics)
  // 合并迁移后的旧版代理与新版代理。
  mergeMap(
    encoded,
    "agents",
    migratedAgents,
    nativeAgents,
    migratedSmallModel !== undefined || isRecord(input.agent) || isRecord(input.mode) || isRecord(input.agents),
    diagnostics,
  )

  // 迁移旧版 provider（单数）映射。
  const legacyProviders = migrateProviders(input.provider, diagnostics)
  // 解码新版 providers 映射。
  const nativeProviders = decodeMap(input.providers, ConfigProvider.Info, ["providers"], diagnostics, decodeEncoded)
  // 合并新旧提供方映射。
  mergeMap(
    encoded,
    "providers",
    legacyProviders,
    nativeProviders,
    isRecord(input.provider) || isRecord(input.providers),
    diagnostics,
  )

  // 旧版 tools 开关迁移为权限规则。
  const toolRules = migrateTools(input.tools, diagnostics)
  // 旧版 permission 迁移为权限规则。
  const permissionRules = migratePermissions(input.permission, diagnostics)
  // 解码新版 permissions 规则列表。
  const nativePermissions = decodeList(input.permissions, Permission.Rule, ["permissions"], diagnostics, decodeEncoded)
  // 三者按序合并为统一的权限规则列表。
  const permissions = [...toolRules, ...permissionRules, ...nativePermissions]
  // 有规则或原配置就是数组时写入 permissions。
  if (permissions.length || Array.isArray(input.permissions)) encoded.permissions = permissions

  // 解码旧版 plugin 列表并统一为 {package, options} 形状（元组形式拆为包名与选项）。
  const legacyPlugins = decodeList(input.plugin, ConfigPluginV1.Spec, ["plugin"], diagnostics, decodeValue).map(
    (plugin) => (typeof plugin === "string" ? plugin : { package: plugin[0], options: plugin[1] }),
  )
  // 解码新版 plugins 列表。
  const nativePlugins = decodeList(input.plugins, ConfigPlugin.Plugin, ["plugins"], diagnostics, decodeEncoded)
  // 任一来源有插件或显式给了数组时，旧版在前、新版在后合并写入。
  if (legacyPlugins.length || nativePlugins.length || Array.isArray(input.plugin) || Array.isArray(input.plugins))
    encoded.plugins = [...legacyPlugins, ...nativePlugins]

  // 规范化技能（skills）配置。
  normalizeSkills(input, encoded, diagnostics)
  // 规范化 MCP 配置。
  normalizeMcp(input, encoded, diagnostics)
  // 规范化压缩（compaction）配置。
  normalizeCompaction(input, encoded, diagnostics)
  // 规范化策略（policies）配置。
  normalizePolicies(input, encoded, diagnostics)
  // 规范化实验特性配置。
  normalizeExperimental(input, encoded, diagnostics)
  // 规范化监视器（watcher）配置。
  normalizeWatcher(input, encoded, diagnostics)
  // 规范化格式化器（formatter）配置。
  normalizeFormatter(input, encoded, diagnostics)
  // 规范化 LSP 配置。
  normalizeLsp(input, encoded, diagnostics)

  // 顶层默认模型选择。
  const model = own(input, "model")
    ? decodeValue(ConfigModel.Selection, input.model, ["model"], diagnostics)
    : undefined
  // 有模型选择时写入，并把提供方 ID 迁移到当前拼写。
  if (model) encoded.model = { ...model, providerID: ConfigMigrateV1.providerID(model.providerID) }

  // 无旧版对应、直接按 V2 解码后覆盖写入的原子顶层键集合。
  const nativeAtomic = {
    // JSON Schema 声明。
    $schema: Info.fields.$schema,
    // shell 偏好。
    shell: Info.fields.shell,
    // 默认代理。
    default_agent: Info.fields.default_agent,
    // 分享设置。
    share: Info.fields.share,
    // 企业特性开关。
    enterprise: Info.fields.enterprise,
    // 用户名。
    username: Info.fields.username,
    // 时区。
    timezone: Info.fields.timezone,
    // 快照开关。
    snapshots: Info.fields.snapshots,
    // 媒体设置。
    media: Info.fields.media,
    // 工具输出限制。
    tool_output: Info.fields.tool_output,
    // 网络搜索设置。
    websearch: Info.fields.websearch,
    // 工作树（worktree）设置。
    worktree: Info.fields.worktree,
    // 预热（warming）设置。
    warming: Info.fields.warming,
  }
  // 逐个解码并覆盖这些原子键。
  Object.entries(nativeAtomic).forEach(([key, schema]) => {
    // 输入中没有该键则跳过。
    if (!own(input, key)) return
    // 按对应模式解码。
    const value = decodeEncoded(schema, input[key], [key], diagnostics)
    // 解码失败（undefined）时跳过。
    if (value === undefined) return
    // 覆盖写入，键冲突时记诊断。
    overlay(encoded, key, value, [key], diagnostics)
  })

  // 解码 instructions 列表（额外的指令文件路径）。
  const instructions = decodeList(input.instructions, Schema.String, ["instructions"], diagnostics, decodeEncoded)
  // 有条目或显式给了数组时写入。
  if (instructions.length || Array.isArray(input.instructions)) encoded.instructions = instructions

  // 返回规范化结果与全部诊断。
  return { type: "normalized", encoded, diagnostics }
}

// 规范化 skills：接受字符串数组或 {paths, urls} 对象两种形状。
function normalizeSkills(input: Record<string, unknown>, encoded: Record<string, unknown>, diagnostics: Diagnostic[]) {
  // 没有 skills 键时直接返回。
  if (!own(input, "skills")) return
  // 数组形式：按字符串列表解码。
  if (Array.isArray(input.skills)) {
    encoded.skills = decodeList(input.skills, Schema.String, ["skills"], diagnostics, decodeEncoded)
    return
  }
  // 既不是数组也不是对象：记无效诊断。
  if (!isRecord(input.skills)) {
    invalid(["skills"], diagnostics)
    return
  }
  // 对象形式：合并 paths 与 urls 两个字符串列表。
  encoded.skills = [
    ...decodeList(input.skills.paths, Schema.String, ["skills", "paths"], diagnostics, decodeEncoded),
    ...decodeList(input.skills.urls, Schema.String, ["skills", "urls"], diagnostics, decodeEncoded),
  ]
}

// 规范化 MCP：处理旧版 mcp 对象、experimental.mcp_timeout 与新版形状的合并。
function normalizeMcp(input: Record<string, unknown>, encoded: Record<string, unknown>, diagnostics: Diagnostic[]) {
  // 旧版解码出的服务器表。
  const legacyServers: Record<string, unknown> = {}
  // 新版解码出的服务器表。
  const nativeServers: Record<string, unknown> = {}
  // 收集到的超时配置。
  const timeout: Record<string, unknown> = {}
  // 旧版 experimental.mcp_timeout：全局 MCP 超时。
  if (isRecord(input.experimental) && own(input.experimental, "mcp_timeout")) {
    // 按正整数模式解码。
    const value = decodeEncoded(
      PositiveInt,
      input.experimental.mcp_timeout,
      ["experimental", "mcp_timeout"],
      diagnostics,
    )
    // V1 never applied this to connecting, unlike a per-server timeout.
    // V1 从不把该超时用于建连（这点不同于按服务器的超时），但这里同时映射到 catalog 与 execution。
    if (value !== undefined) {
      timeout.catalog = value
      timeout.execution = value
    }
  }
  // 存在旧版 mcp 键时逐项处理。
  if (own(input, "mcp")) {
    // 不是对象则记无效诊断。
    if (!isRecord(input.mcp)) invalid(["mcp"], diagnostics)
    // 是对象才继续逐项解析。
    if (isRecord(input.mcp)) {
      // 遍历 mcp 下的每个条目。
      Object.entries(input.mcp).forEach(([name, value]) => {
        // 该条目的诊断路径。
        const path = ["mcp", name]
        // 仅含 enabled 的旧条目已不支持：记诊断并跳过。
        if (isEnabledOnlyMcp(value)) {
          diagnostics.push({ kind: "unsupported", path, message: "omitted enabled-only legacy MCP entry" })
          return
        }
        // servers 子表且不是单个直连服务器：先展开数字超时再按新版服务器模式解码。
        if (name === "servers" && !isDirectLegacyMcp(value)) {
          Object.entries(
            decodeMap(expandServerTimeouts(value), ConfigMCP.Server, path, diagnostics, decodeEncoded),
          ).forEach(([key, server]) => setOwn(nativeServers, key, server))
          return
        }
        // timeout 子表且不是单个直连服务器：迁移超时配置（数字先迁移为结构化形状）。
        if (name === "timeout" && !isDirectLegacyMcp(value)) {
          normalizeMcpTimeout(
            typeof value === "number" ? ConfigMigrateV1.migrateMcpTimeout(value) : value,
            timeout,
            path,
            diagnostics,
          )
          return
        }
        // 其余条目按旧版单服务器模式解码。
        const server = decodeValue(ConfigMCPV1.Info, value, path, diagnostics)
        // 解码成功则迁移为 V2 服务器结构并写入旧表。
        if (server !== undefined)
          setOwn(legacyServers, name, canonical(ConfigMCP.Server, ConfigMigrateV1.migrateMcp(server)))
      })
    }
  }
  // 合并新旧服务器表（新版优先，冲突记诊断）。
  const servers = mergeMaps(legacyServers, nativeServers, ["mcp", "servers"], diagnostics)
  // 服务器与超时都为空时：若原 mcp 就是空对象则保留空对象，否则不写。
  if (!Object.keys(servers).length && !Object.keys(timeout).length) {
    if (isRecord(input.mcp) && !Object.keys(input.mcp).length) encoded.mcp = {}
    return
  }
  // 写入合并后的 mcp 配置：超时与服务器按存在与否拼装。
  encoded.mcp = {
    ...(Object.keys(timeout).length ? { timeout } : {}),
    ...(Object.keys(servers).length ? { servers } : {}),
  }
}

// Native servers accept the V1 bare-number timeout so one V1-shaped field does not drop the whole server.
// 为新版服务器表兼容 V1 的裸数字 timeout：把数字超时迁移为结构化超时，避免单个 V1 形状字段导致整台服务器被丢弃。
function expandServerTimeouts(value: unknown) {
  // 非对象原样返回。
  if (!isRecord(value)) return value
  // 逐台服务器检查 timeout 字段。
  return Object.fromEntries(
    Object.entries(value).map(([name, server]) => [
      name,
      // 是对象且 timeout 为数字时迁移为结构化超时，否则原样保留。
      isRecord(server) && typeof server.timeout === "number"
        ? { ...server, timeout: ConfigMigrateV1.migrateMcpTimeout(server.timeout) }
        : server,
    ]),
  )
}

// 解析 MCP 超时配置：支持 catalog/execution 等键的覆盖语义。
function normalizeMcpTimeout(
  value: unknown,
  timeout: Record<string, unknown>,
  path: string[],
  diagnostics: Diagnostic[],
) {
  // 非对象记无效诊断。
  if (!isRecord(value)) {
    invalid(path, diagnostics)
    return
  }
  // 找出输入中出现且超时模式认识键。
  const recognized = Object.entries(ConfigMCP.Timeout.fields).filter(([key]) => own(value, key))
  // 有内容但没有任何被识别的键：整体无效。
  if (Object.keys(value).length && !recognized.length) {
    invalid(path, diagnostics)
    return
  }
  // 逐个解码识别到的键并覆盖写入。
  recognized.forEach(([key, field]) => {
    // 按字段模式解码叶子值。
    const leaf = decodeEncoded(field, value[key], [...path, key], diagnostics)
    // 解码失败跳过。
    if (leaf === undefined) return
    // 覆盖写入超时表。
    overlay(timeout, key, leaf, [...path, key], diagnostics)
  })
}

// 规范化 compaction：合并旧版 preserve_recent_tokens/reserved 与新版 keep/buffer。
function normalizeCompaction(
  input: Record<string, unknown>,
  encoded: Record<string, unknown>,
  diagnostics: Diagnostic[],
) {
  // 没有 compaction 键时直接返回。
  if (!own(input, "compaction")) return
  // 不是对象则记无效诊断。
  if (!isRecord(input.compaction)) {
    invalid(["compaction"], diagnostics)
    return
  }
  // tail_turns 已不支持，出现即记诊断。
  unsupportedIfPresent(input.compaction, "tail_turns", ["compaction", "tail_turns"], diagnostics)
  // prune 已不支持，出现即记诊断。
  unsupportedIfPresent(input.compaction, "prune", ["compaction", "prune"], diagnostics)
  // 规范化结果容器。
  const result: Record<string, unknown> = {}
  // 解码 auto 开关（是否自动压缩）。
  if (own(input.compaction, "auto")) {
    const value = decodeEncoded(
      ConfigCompaction.Info.fields.auto,
      input.compaction.auto,
      ["compaction", "auto"],
      diagnostics,
    )
    // 解码成功才写入。
    if (value !== undefined) result.auto = value
  }
  // 旧版 preserve_recent_tokens（保留最近令牌数）解码。
  const legacyTokens = own(input.compaction, "preserve_recent_tokens")
    ? decodeEncoded(
        ConfigCompaction.Keep.fields.tokens,
        input.compaction.preserve_recent_tokens,
        ["compaction", "preserve_recent_tokens"],
        diagnostics,
      )
    : undefined
  // 新版 keep 子对象（不是对象时视为没有）。
  const nativeKeep = isRecord(input.compaction.keep) ? input.compaction.keep : undefined
  // keep 键存在但不是对象：记无效诊断。
  if (own(input.compaction, "keep") && !nativeKeep) invalid(["compaction", "keep"], diagnostics)
  // 解码新版 keep.tokens。
  const nativeTokens =
    nativeKeep && own(nativeKeep, "tokens")
      ? decodeEncoded(
          ConfigCompaction.Keep.fields.tokens,
          nativeKeep.tokens,
          ["compaction", "keep", "tokens"],
          diagnostics,
        )
      : undefined
  // 新旧令牌数择一（冲突记诊断），有值则写入 keep。
  const tokens = prefer(legacyTokens, nativeTokens, ["compaction", "keep", "tokens"], diagnostics)
  if (tokens !== undefined) result.keep = { tokens }
  // 旧版 reserved（预留缓冲）解码。
  const legacyBuffer = own(input.compaction, "reserved")
    ? decodeEncoded(
        ConfigCompaction.Info.fields.buffer,
        input.compaction.reserved,
        ["compaction", "reserved"],
        diagnostics,
      )
    : undefined
  // 新版 buffer 解码。
  const nativeBuffer = own(input.compaction, "buffer")
    ? decodeEncoded(ConfigCompaction.Info.fields.buffer, input.compaction.buffer, ["compaction", "buffer"], diagnostics)
    : undefined
  // 新旧缓冲择一（冲突记诊断）。
  const buffer = prefer(legacyBuffer, nativeBuffer, ["compaction", "buffer"], diagnostics)
  // 有值则写入 buffer。
  if (buffer !== undefined) result.buffer = buffer
  // 有内容或原对象为空时写入 compaction。
  if (Object.keys(result).length || !Object.keys(input.compaction).length) encoded.compaction = result
}

// V1 provider lists and `experimental.policies` stay supported and merge into
// top-level `policies`; within a document, later sources win ties.
// 规范化策略：V1 的提供方名单与 experimental.policies 继续支持，并合并进顶层 policies；同一文档内后到的来源在平局时胜出。
function normalizePolicies(
  input: Record<string, unknown>,
  encoded: Record<string, unknown>,
  diagnostics: Diagnostic[],
) {
  // 由旧字段生成的策略语句。
  const generated: unknown[] = []
  // 解码 enabled_providers 名单。
  const enabled = decodeProviderList(input, "enabled_providers", diagnostics)
  // 名单存在且（名单为空或能解析出值）时：先拒绝所有提供方，再逐个放行名单内的提供方。
  if (enabled.present && (!enabled.nonEmpty || enabled.values.length)) {
    generated.push({ action: "provider.use", resource: "*", effect: "deny" })
    generated.push(
      ...enabled.values.map((resource) => ({
        action: "provider.use",
        resource: ConfigMigrateV1.providerID(resource),
        effect: "allow",
      })),
    )
  }
  // 解码 disabled_providers 名单。
  const disabled = decodeProviderList(input, "disabled_providers", diagnostics)
  // 名单内每个提供方生成一条拒绝语句。
  generated.push(
    ...disabled.values.map((resource) => ({
      action: "provider.use",
      resource: ConfigMigrateV1.providerID(resource),
      effect: "deny",
    })),
  )
  // 解码 experimental.policies 列表。
  const experimental = isRecord(input.experimental)
    ? decodeList(
        input.experimental.policies,
        ConfigPolicy.Info,
        ["experimental", "policies"],
        diagnostics,
        decodeEncoded,
      )
    : []
  // 解码新版顶层 policies 列表。
  const native = decodeList(input.policies, ConfigPolicy.Info, ["policies"], diagnostics, decodeEncoded)
  // 任一来源有内容或显式给了数组时，按 生成 → experimental → 新版 的顺序合并写入。
  if (
    generated.length ||
    experimental.length ||
    native.length ||
    Array.isArray(input.policies) ||
    (isRecord(input.experimental) && Array.isArray(input.experimental.policies))
  )
    encoded.policies = [...generated, ...experimental, ...native]
}

// 规范化 experimental：剔除不支持键后按新模式解码其余键。
function normalizeExperimental(
  input: Record<string, unknown>,
  encoded: Record<string, unknown>,
  diagnostics: Diagnostic[],
) {
  // 规范化结果容器。
  const result: Record<string, unknown> = {}
  // 存在 experimental 键才处理。
  if (own(input, "experimental")) {
    // 不是对象记无效诊断。
    if (!isRecord(input.experimental)) invalid(["experimental"], diagnostics)
    // 是对象才逐键处理。
    if (isRecord(input.experimental)) {
      // 取出实验配置对象。
      const experimental = input.experimental
      // 对每个不再支持的键记诊断。
      unsupportedExperimental.forEach((key) =>
        unsupportedIfPresent(experimental, key, ["experimental", key], diagnostics),
      )
      // `policies` merges into top-level `policies` in normalizePolicies.
      // 遍历模式已知的实验键并解码；policies 已在 normalizePolicies 中并入顶层，此处跳过。
      Object.entries(ConfigExperimental.Info.fields).forEach(([key, schema]) => {
        // 跳过 policies 或输入中不存在的键。
        if (key === "policies" || !own(experimental, key)) return
        // 按模式解码该键。
        const value = decodeEncoded(schema, experimental[key], ["experimental", key], diagnostics)
        // 解码成功才写入。
        if (value !== undefined) result[key] = value
      })
    }
  }
  // 有内容或原对象为空时写入 experimental。
  if (Object.keys(result).length || (isRecord(input.experimental) && !Object.keys(input.experimental).length))
    encoded.experimental = result
}

// 规范化 watcher：目前只有 ignore 列表。
function normalizeWatcher(input: Record<string, unknown>, encoded: Record<string, unknown>, diagnostics: Diagnostic[]) {
  // 没有 watcher 键直接返回。
  if (!own(input, "watcher")) return
  // 不是对象记无效诊断。
  if (!isRecord(input.watcher)) {
    invalid(["watcher"], diagnostics)
    return
  }
  // 解码 ignore 忽略模式列表。
  const ignore = decodeList(input.watcher.ignore, Schema.String, ["watcher", "ignore"], diagnostics, decodeEncoded)
  // 有内容或显式给了数组时写入 {ignore}，否则写入空对象。
  encoded.watcher = ignore.length || Array.isArray(input.watcher.ignore) ? { ignore } : {}
}

// 规范化 formatter：支持布尔开关或命名映射两种形状。
function normalizeFormatter(
  input: Record<string, unknown>,
  encoded: Record<string, unknown>,
  diagnostics: Diagnostic[],
) {
  // 没有 formatter 键直接返回。
  if (!own(input, "formatter")) return
  // 布尔形式：整体启用/禁用。
  if (typeof input.formatter === "boolean") {
    const value = decodeEncoded(ConfigFormatter.Info, input.formatter, ["formatter"], diagnostics)
    // 解码成功才写入。
    if (value !== undefined) encoded.formatter = value
    return
  }
  // 映射形式：按条目模式解码。
  const entries = decodeMap(input.formatter, ConfigFormatter.Entry, ["formatter"], diagnostics, decodeEncoded)
  // 是对象且（为空对象或解析出条目）时写入。
  if (isRecord(input.formatter) && (!Object.keys(input.formatter).length || Object.keys(entries).length))
    encoded.formatter = entries
}

// 规范化 lsp：同样支持布尔或命名映射两种形状。
function normalizeLsp(input: Record<string, unknown>, encoded: Record<string, unknown>, diagnostics: Diagnostic[]) {
  // 没有 lsp 键直接返回。
  if (!own(input, "lsp")) return
  // 布尔形式：整体启用/禁用。
  if (typeof input.lsp === "boolean") {
    const value = decodeEncoded(ConfigLSP.Info, input.lsp, ["lsp"], diagnostics)
    // 解码成功才写入。
    if (value !== undefined) encoded.lsp = value
    return
  }
  // 映射形式：按条目模式解码。
  const entries = decodeMap(input.lsp, ConfigLSP.Entry, ["lsp"], diagnostics, decodeEncoded)
  // 是对象且（为空对象或解析出条目）时写入。
  if (isRecord(input.lsp) && (!Object.keys(input.lsp).length || Object.keys(entries).length)) encoded.lsp = entries
}

// 迁移旧版 tools：{工具名: 布尔} 转为 allow/deny 权限规则。
function migrateTools(value: unknown, diagnostics: Diagnostic[]) {
  // 未提供时返回空列表。
  if (value === undefined) return []
  // 不是对象记无效诊断。
  if (!isRecord(value)) {
    invalid(["tools"], diagnostics)
    return []
  }
  // 每个条目生成一条作用于所有资源（*）的规则。
  return Object.entries(value).flatMap(([action, raw]) => {
    // 布尔值解码。
    const enabled = decodeValue(Schema.Boolean, raw, ["tools", action], diagnostics)
    // 解码失败跳过。
    if (enabled === undefined) return []
    // 生成 allow 或 deny 规则（动作名迁移到当前拼写）。
    return [{ action: ConfigMigrateV1.normalizeAction(action), resource: "*", effect: enabled ? "allow" : "deny" }]
  })
}

// 迁移旧版 permission：支持字符串总开关与两级映射两种形状。
function migratePermissions(value: unknown, diagnostics: Diagnostic[]) {
  // 未提供时返回空列表。
  if (value === undefined) return []
  // 字符串形式：对所有动作统一 allow/ask/deny。
  if (typeof value === "string") {
    const effect = decodeValue(ConfigPermissionV1.Action, value, ["permission"], diagnostics)
    // 解码失败返回空；否则生成通配规则。
    return effect === undefined ? [] : [{ action: "*", resource: "*", effect }]
  }
  // 不是对象记无效诊断。
  if (!isRecord(value)) {
    invalid(["permission"], diagnostics)
    return []
  }
  // 映射形式：遍历每个动作。
  return Object.entries(value).flatMap(([action, raw]) => {
    // 值为字符串：该动作对所有资源统一处理。
    if (typeof raw === "string") {
      const effect = decodeValue(ConfigPermissionV1.Action, raw, ["permission", action], diagnostics)
      // 解码失败跳过；否则生成规则。
      return effect === undefined ? [] : [{ action: ConfigMigrateV1.normalizeAction(action), resource: "*", effect }]
    }
    // 值不是对象记无效诊断。
    if (!isRecord(raw)) {
      invalid(["permission", action], diagnostics)
      return []
    }
    // 值为对象：键是资源模式，值是效果。
    return Object.entries(raw).flatMap(([resource, effect], index) => {
      // 解码效果值。
      const decoded = decodeValue(ConfigPermissionV1.Action, effect, ["permission", action, String(index)], diagnostics)
      // 解码失败跳过。
      return decoded === undefined
        ? []
        : [{ action: ConfigMigrateV1.normalizeAction(action), resource, effect: decoded }]
    })
  })
}

// 迁移旧版 provider：逐个解码迁移，并把重命名的提供方落到新 ID 上。
function migrateProviders(value: unknown, diagnostics: Diagnostic[]) {
  // 未提供时返回空对象。
  if (value === undefined) return {}
  // 不是对象记无效诊断。
  if (!isRecord(value)) {
    invalid(["provider"], diagnostics)
    return {}
  }
  // 逐个解码旧提供方并准备迁移信息。
  const candidates = Object.entries(value).flatMap(([name, raw]) => {
    // 该提供方的诊断路径。
    const path = ["provider", name]
    // 记录不支持字段诊断。
    diagnoseProviderUnsupported(raw, path, diagnostics)
    // 头部/请求体形状非法时跳过该提供方。
    if (invalidProviderOverlays(raw, path, diagnostics)) return []
    // 按旧版模式解码。
    const provider = decodeValue(ConfigProviderV1.Info, raw, path, diagnostics)
    // 解码失败跳过。
    if (provider === undefined) return []
    // 计算迁移后的提供方 ID。
    const destination = ConfigMigrateV1.providerID(name)
    // 产出迁移候选：原名称、目标 ID 与迁移结果。
    return [
      {
        name,
        destination,
        provider: canonical(ConfigProvider.Info, ConfigMigrateV1.migrateProvider(name, provider)),
      },
    ]
  })
  // 名称未变的提供方集合（它们占用着自己的目标 ID）。
  const current = new Set(candidates.filter((item) => item.name === item.destination).map((item) => item.destination))
  // 结果表。
  const result: Record<string, unknown> = {}
  // 逐个落位：重命名的提供方若目标 ID 已被占用则丢弃，避免覆盖。
  candidates.forEach((item) => {
    if (item.name !== item.destination && current.has(item.destination)) return
    setOwn(result, item.destination, item.provider)
  })
  // 返回迁移结果。
  return result
}

// 检查旧提供方 options.headers/options.body 的形状；非法时记诊断并让调用方跳过该提供方。
function invalidProviderOverlays(value: unknown, path: string[], diagnostics: Diagnostic[]) {
  // 不是对象或没有 options 时视为合法。
  if (!isRecord(value) || !isRecord(value.options)) return false
  // headers 必须是普通对象且值全为字符串。
  const headersInvalid =
    own(value.options, "headers") &&
    (!isPlainRecord(value.options.headers) ||
      Object.values(value.options.headers).some((item) => typeof item !== "string"))
  // body 必须是普通对象。
  const bodyInvalid = own(value.options, "body") && !isPlainRecord(value.options.body)
  // headers 非法记诊断。
  if (headersInvalid) invalid([...path, "options", "headers"], diagnostics)
  // body 非法记诊断。
  if (bodyInvalid) invalid([...path, "options", "body"], diagnostics)
  // 任一非法即返回 true。
  return headersInvalid || bodyInvalid
}

// 记录旧提供方及其模型中已不支持的字段诊断。
function diagnoseProviderUnsupported(value: unknown, path: string[], diagnostics: Diagnostic[]) {
  // 非对象直接返回。
  if (!isRecord(value)) return
  // 提供方级别的不支持键。
  unsupportedProvider.forEach((key) => unsupportedIfPresent(value, key, [...path, key], diagnostics))
  // 没有 models 时结束。
  if (!isRecord(value.models)) return
  // 逐个模型检查不支持键。
  Object.entries(value.models).forEach(([name, model]) => {
    // 非对象跳过。
    if (!isRecord(model)) return
    // 模型级别的不支持键。
    unsupportedModel.forEach((key) => unsupportedIfPresent(model, key, [...path, "models", name, key], diagnostics))
    // status 只有 deprecated 取值仍被接受，其余记诊断。
    if (own(model, "status") && model.status !== "deprecated")
      unsupportedIfPresent(model, "status", [...path, "models", name, "status"], diagnostics)
    // interleaved 仅布尔取值被接受，其余记诊断。
    if (own(model, "interleaved") && typeof model.interleaved === "boolean")
      unsupportedIfPresent(model, "interleaved", [...path, "models", name, "interleaved"], diagnostics)
  })
}

// 记录旧代理中不支持的字段（name 字段与模型/变体选择）。
function diagnoseAgentUnsupported(value: unknown, path: string[], diagnostics: Diagnostic[]) {
  // 非对象直接返回。
  if (!isRecord(value)) return
  // 逐个代理检查。
  Object.entries(value).forEach(([name, agent]) => {
    // 非对象跳过。
    if (!isRecord(agent)) return
    // name 字段已不支持。
    unsupportedIfPresent(agent, "name", [...path, name, "name"], diagnostics)
    // 检查模型/变体选择写法。
    diagnoseSelection(agent, [...path, name], diagnostics)
  })
}

// 对映射中每个对象条目检查模型选择写法。
function diagnoseSelectionMap(value: unknown, path: string[], diagnostics: Diagnostic[]) {
  // 非对象直接返回。
  if (!isRecord(value)) return
  // 逐个条目检查。
  Object.entries(value).forEach(([name, entry]) => {
    // 仅对象条目需要检查。
    if (isRecord(entry)) diagnoseSelection(entry, [...path, name], diagnostics)
  })
}

// 检查单个对象里的 model/variant 旧写法是否可识别，不可识别记 unsupported 诊断。
function diagnoseSelection(value: Record<string, unknown>, path: string[], diagnostics: Diagnostic[]) {
  const modelValid = typeof value.model === "string" && ConfigMigrateV1.modelSelection(value.model) !== undefined
  if (own(value, "model") && typeof value.model === "string" && !modelValid)
    diagnostics.push({
      kind: "unsupported",
      path: [...path, "model"],
      message: "omitted unsupported legacy model reference",
    })
  // variant 需要有效的 model 前提，且本身非空、不含 #，否则记诊断。
  if (
    own(value, "variant") &&
    typeof value.variant === "string" &&
    (!modelValid || value.variant.length === 0 || value.variant.includes("#"))
  )
    diagnostics.push({
      kind: "unsupported",
      path: [...path, "variant"],
      message: "omitted unsupported legacy model variant",
    })
}

// 解码旧版提供方名单（enabled/disabled_providers），返回存在性、是否非空与字符串值。
function decodeProviderList(
  input: Record<string, unknown>,
  key: "enabled_providers" | "disabled_providers",
  diagnostics: Diagnostic[],
) {
  // 键不存在：视为未提供。
  if (!own(input, key)) return { present: false, nonEmpty: false, values: [] as string[] }
  // 不是数组：记无效诊断，并按"存在、非空、无值"处理（保持 deny-all 行为）。
  if (!Array.isArray(input[key])) {
    invalid([key], diagnostics)
    return { present: true, nonEmpty: true, values: [] as string[] }
  }
  // 正常数组：返回存在性、是否非空与解码后的字符串列表。
  return {
    present: true,
    nonEmpty: input[key].length > 0,
    values: decodeList(input[key], Schema.String, [key], diagnostics, decodeValue),
  }
}

// 通用映射解码：把 {名: 值} 逐项用给定解码函数转换，失败项剔除。
function decodeMap<S extends Schema.Codec<unknown, unknown, never>, A>(
  value: unknown,
  schema: S,
  path: string[],
  diagnostics: Diagnostic[],
  decode: (schema: S, value: unknown, path: string[], diagnostics: Diagnostic[]) => A | undefined,
): Record<string, A> {
  // 未提供返回空对象。
  if (value === undefined) return {}
  // 不是对象记无效诊断。
  if (!isRecord(value)) {
    invalid(path, diagnostics)
    return {}
  }
  // 逐项解码并剔除失败项。
  return Object.fromEntries(
    Object.entries(value).flatMap(([name, raw]): [string, A][] => {
      // 解码单项（路径附带键名）。
      const decoded = decode(schema, raw, [...path, name], diagnostics)
      // 失败项不进入结果。
      return decoded === undefined ? [] : [[name, decoded]]
    }),
  )
}

// 通用列表解码：逐项解码并剔除失败项。
function decodeList<S extends Schema.Codec<unknown, unknown, never>, A>(
  value: unknown,
  schema: S,
  path: string[],
  diagnostics: Diagnostic[],
  decode: (schema: S, value: unknown, path: string[], diagnostics: Diagnostic[]) => A | undefined,
): A[] {
  // 未提供返回空数组。
  if (value === undefined) return []
  // 不是数组记无效诊断。
  if (!Array.isArray(value)) {
    invalid(path, diagnostics)
    return []
  }
  // 逐项解码并剔除失败项。
  return value.flatMap((item, index) => {
    // 解码单项（路径附带索引）。
    const decoded = decode(schema, item, [...path, String(index)], diagnostics)
    // 失败项不进入结果。
    return decoded === undefined ? [] : [decoded]
  })
}

// 解码任意值为模式类型：失败记无效诊断并返回 undefined。
function decodeValue<S extends Schema.Codec<unknown, unknown, never, never>>(
  schema: S,
  value: unknown,
  path: string[],
  diagnostics: Diagnostic[],
) {
  // 尝试解码。
  const decoded = Schema.decodeUnknownOption(schema, options)(value)
  // 成功返回值。
  if (Option.isSome(decoded)) return decoded.value
  // 失败记诊断。
  invalid(path, diagnostics)
  return undefined
}

// 解码并回编码（encode）为普通 JSON 形状：任何一步失败都记诊断并返回 undefined。
function decodeEncoded<S extends Schema.Codec<unknown, unknown, never, never>>(
  schema: S,
  value: unknown,
  path: string[],
  diagnostics: Diagnostic[],
) {
  // 先解码。
  const decoded = Schema.decodeUnknownOption(schema, options)(value)
  // 解码失败记诊断。
  if (Option.isNone(decoded)) {
    invalid(path, diagnostics)
    return undefined
  }
  // 再编码为可序列化的规范形状。
  const encoded = Schema.encodeUnknownOption(schema, options)(decoded.value)
  // 成功则去除 undefined 值后返回。
  if (Option.isSome(encoded)) return plain(encoded.value)
  // 编码失败记诊断。
  invalid(path, diagnostics)
  return undefined
}

// 先解码再编码，强制把值规范化为该模式的规范形状（失败时抛错，用于已通过校验的中间值）。
function canonical<S extends Schema.Codec<unknown, unknown, never, never>>(schema: S, value: unknown) {
  return plain(
    Option.getOrThrow(
      Schema.decodeUnknownOption(
        schema,
        options,
      )(plain(value)).pipe(Option.flatMap((decoded) => Schema.encodeUnknownOption(schema, options)(decoded))),
    ),
  )
}

// 递归去除对象中的 undefined 值属性，返回纯 JSON 兼容结构。
function plain(value: unknown): unknown {
  // 数组逐项处理。
  if (Array.isArray(value)) return value.map(plain)
  // 非对象原样返回。
  if (!isRecord(value)) return value
  // 对象：剔除 undefined 属性后重建。
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => (item === undefined ? [] : [[key, plain(item)]])),
  )
}

// 把新旧两个映射合并写入目标键（新版优先，冲突记诊断）。
function mergeMap(
  target: Record<string, unknown>,
  key: string,
  legacy: Readonly<Record<string, unknown>>,
  native: Readonly<Record<string, unknown>>,
  present: boolean,
  diagnostics: Diagnostic[],
) {
  // 先合并两份映射。
  const merged = mergeMaps(legacy, native, [key], diagnostics)
  // 声明出现过才写入目标。
  if (present) target[key] = merged
}

// 合并两份映射：以旧版为基础，新版逐键覆盖，同名不同值记冲突诊断。
function mergeMaps(
  legacy: Readonly<Record<string, unknown>>,
  native: Readonly<Record<string, unknown>>,
  path: string[],
  diagnostics: Diagnostic[],
) {
  // 复制旧版为初始结果。
  const result = Object.fromEntries(Object.entries(legacy))
  // 新版逐键覆盖。
  Object.entries(native).forEach(([name, value]) => {
    // 同名键且值不同：记冲突诊断。
    if (own(result, name) && !isDeepStrictEqual(result[name], value)) conflict([...path, name], diagnostics)
    // 覆盖写入。
    setOwn(result, name, value)
  })
  // 返回合并结果。
  return result
}

// 对映射逐值应用转换函数，返回 undefined 的项被剔除。
function mapValues<A>(input: Readonly<Record<string, A>>, map: (value: A) => unknown) {
  return Object.fromEntries(
    Object.entries(input).flatMap(([key, value]) => {
      // 转换单个值。
      const mapped = map(value)
      // undefined 的项被丢弃。
      return mapped === undefined ? [] : [[key, mapped]]
    }),
  )
}

// 覆盖写入目标对象的键，已有值不同时记冲突诊断。
function overlay(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
  path: string[],
  diagnostics: Diagnostic[],
) {
  // 已有值且不同：记冲突诊断。
  if (own(target, key) && !isDeepStrictEqual(target[key], value)) conflict(path, diagnostics)
  // 写入新值。
  target[key] = value
}

// 新旧值择一：新版缺失用旧版；两者都有且不同记冲突诊断并取新版。
function prefer(legacy: unknown, native: unknown, path: string[], diagnostics: Diagnostic[]) {
  // 没有新版值时用旧版。
  if (native === undefined) return legacy
  // 两者都有且不同：记冲突诊断。
  if (legacy !== undefined && !isDeepStrictEqual(legacy, native)) conflict(path, diagnostics)
  // 返回新版值。
  return native
}

// 键存在即记一条 unsupported 诊断（该旧设置被丢弃）。
function unsupportedIfPresent(value: Record<string, unknown>, key: string, path: string[], diagnostics: Diagnostic[]) {
  // 键不存在则无事发生。
  if (!own(value, key)) return
  // 记录诊断。
  diagnostics.push({ kind: "unsupported", path, message: "omitted unsupported legacy setting" })
}

// 记录一条"跳过无法识别的值"的无效诊断。
function invalid(path: string[], diagnostics: Diagnostic[]) {
  diagnostics.push({ kind: "invalid", path, message: "skipped malformed recognized value" })
}

// 记录一条"保留新版值、舍弃旧版值"的冲突诊断。
function conflict(path: string[], diagnostics: Diagnostic[]) {
  diagnostics.push({ kind: "conflict", path, message: "retained native value over legacy value" })
}

// 判断是否为旧版直连 MCP 服务器（直接含 type: local/remote 的对象）。
function isDirectLegacyMcp(value: unknown) {
  return isRecord(value) && (value.type === "local" || value.type === "remote")
}

// 判断是否为仅含 enabled 布尔的旧版 MCP 条目（已不支持）。
function isEnabledOnlyMcp(value: unknown) {
  return isRecord(value) && !own(value, "type") && typeof value.enabled === "boolean"
}

// 判断是否为原型为 Object.prototype 或 null 的普通对象。
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  // 非对象直接否。
  if (!isRecord(value)) return false
  // 检查原型。
  const prototype = Object.getPrototypeOf(value)
  // 原型匹配才视为普通对象。
  return prototype === Object.prototype || prototype === null
}

// 判断对象是否自有某键（不查原型链）。
function own(value: Record<string, unknown>, key: string) {
  return Object.hasOwn(value, key)
}

// 用 defineProperty 写入键：绕开普通赋值可能触发的 setter 或只读约束。
function setOwn(value: Record<string, unknown>, key: string, item: unknown) {
  Object.defineProperty(value, key, { value: item, enumerable: true, configurable: true, writable: true })
}
