// 将本文件的所有导出聚合到命名空间 ConfigAgentV1 下，供统一引入
export * as ConfigAgentV1 from "./agent.js"

// effect 库：Schema 校验、SchemaGetter 自定义编解码
import { Schema, SchemaGetter } from "effect"
// 通用 Schema：正整数
import { PositiveInt } from "../../schema.js"
// 权限配置 Schema（v1）
import { ConfigPermissionV1 } from "./permission.js"

// 颜色字段：6 位十六进制色值或主题色名
const Color = Schema.Union([
  // 十六进制颜色（#RRGGBB）
  Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/)),
  // 预置主题色
  Schema.Literals(["primary", "secondary", "accent", "success", "warning", "error", "info"]),
])

// 代理（Agent）配置 Schema：固定字段 + 允许任意附加字段
const AgentSchema = Schema.StructWithRest(
  Schema.Struct({
    // 该代理使用的模型
    model: Schema.optional(Schema.String),
    // 默认模型变体（仅在使用代理配置的模型时生效）
    variant: Schema.optional(Schema.String).annotate({
      description: "Default model variant for this agent (applies only when using the agent's configured model).",
    }),
    // 采样温度
    temperature: Schema.optional(Schema.Finite),
    // top_p 采样参数
    top_p: Schema.optional(Schema.Finite),
    // 代理的系统提示词
    prompt: Schema.optional(Schema.String),
    // 工具开关（已废弃，改用 permission）
    tools: Schema.optional(ConfigPermissionV1.Entries(Schema.Boolean)).annotate({
      description: "@deprecated Use 'permission' field instead",
    }),
    // 是否禁用该代理
    disable: Schema.optional(Schema.Boolean),
    // 描述该代理的适用场景
    description: Schema.optional(Schema.String).annotate({ description: "Description of when to use the agent" }),
    // 运行模式：子代理/主代理/两者皆可
    mode: Schema.optional(Schema.Literals(["subagent", "primary", "all"])),
    // 是否在 @ 自动补全菜单中隐藏该子代理
    hidden: Schema.optional(Schema.Boolean).annotate({
      description: "Hide this subagent from the @ autocomplete menu (default: false, only applies to mode: subagent)",
    }),
    // 附加选项（任意键值）
    options: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
    // 显示颜色
    color: Schema.optional(Color).annotate({
      description: "Hex color code (e.g., #FF5733) or theme color (e.g., primary)",
    }),
    // 强制纯文本回复前允许的最大代理迭代步数
    steps: Schema.optional(PositiveInt).annotate({
      description: "Maximum number of agentic iterations before forcing text-only response",
    }),
    // 旧版步数字段（已废弃，改用 steps）
    maxSteps: Schema.optional(PositiveInt).annotate({ description: "@deprecated Use 'steps' field instead." }),
    // 权限规则配置
    permission: Schema.optional(ConfigPermissionV1.Info),
  }),
  // 允许携带任意额外键值（供提供商/插件透传）
  [Schema.Record(Schema.String, Schema.Any)],
)

// 已知的固定字段集合（名称 + Schema 字段），其余键归入 options
const KNOWN_KEYS = new Set(["name", ...Object.keys(AgentSchema.schema.fields)])

// 归一化代理配置：收集附加字段进 options，并把旧版 tools 合并进 permission
const normalize = (agent: Schema.Schema.Type<typeof AgentSchema>): Schema.Schema.Type<typeof AgentSchema> => {
  // 复制原 options，准备追加未知键
  const options: Record<string, unknown> = { ...agent.options }
  // 遍历配置中的所有键值
  for (const [key, value] of Object.entries(agent)) {
    // 非已知键的都收进 options
    if (!KNOWN_KEYS.has(key)) options[key] = value
  }

  // A Map keeps each key's first position when a later entry overrides it, like Object.assign.
  // 用 Map 合并权限规则：后写覆盖值但保留首次出现的位置（与 Object.assign 行为一致）
  const permission = new Map<string, ConfigPermissionV1.Rule>()
  // 把旧版 tools 布尔开关转换为 allow/deny 规则
  for (const [tool, enabled] of agent.tools ?? []) {
    // 布尔值映射为 allow/deny 动作
    const action = enabled ? "allow" : "deny"
    // write/patch 工具统一映射为 edit 动作键
    permission.set(tool === "write" || tool === "patch" ? "edit" : tool, action)
  }
  // 新版 permission 字段覆盖旧版转换结果
  for (const [key, rule] of agent.permission ?? []) permission.set(key, rule)

  // steps：优先新字段，回退旧字段 maxSteps
  const steps = agent.steps ?? agent.maxSteps
  // 返回归一化后的配置对象
  return { ...agent, options, permission: [...permission], ...(steps !== undefined ? { steps } : {}) }
}

// 导出代理配置 Schema：解码时执行归一化，编码时透传
export const Info = AgentSchema.pipe(
  // 在解码管道中挂上自定义的解码/编码逻辑
  Schema.decodeTo(Schema.toType(AgentSchema), {
    // 解码侧：调用 normalize 归一化
    decode: SchemaGetter.transform(normalize),
    // 编码侧：宽松透传（不做严格校验）
    encode: SchemaGetter.passthrough({ strict: false }),
  }),
  // 标注 Schema 标识符
).annotate({ identifier: "AgentConfig" })
// Info 的 TypeScript 类型
export type Info = Schema.Schema.Type<typeof Info>
