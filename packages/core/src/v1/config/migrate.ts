// 将本文件的所有导出聚合到命名空间 ConfigMigrateV1 下，供统一引入
export * as ConfigMigrateV1 from "./migrate.js"

// v2 的代理配置 Schema（迁移目标格式）
import { ConfigAgent } from "@opencode/schema/config/agent"
// effect 库：Schema 校验
import { Schema } from "effect"
// v1 的各类配置 Schema（迁移源格式）
import { ConfigAgentV1 } from "./agent.js"
import { ConfigCommandV1 } from "./command.js"
import { ConfigMCPV1 } from "./mcp.js"
import { ConfigPermissionV1 } from "./permission.js"
import { ConfigProviderV1 } from "./provider.js"
import { ConfigProviderOptionsV1 } from "./provider-options.js"
// 提供商工具（包名/AI SDK 说明符处理）
import { Provider } from "../../provider.js"
// 模型工具（兼容性/能力默认值）
import { Model } from "../../model.js"

// 统一的解码选项：收集全部错误并忽略多余属性
const decodeOptions = { errors: "all", onExcessProperty: "ignore" } as const
// v2 代理配置的同步解码器（输入为 JSON 字符串）
const decodeAgent = Schema.decodeUnknownSync(Schema.fromJsonString(ConfigAgent.Info), decodeOptions)

// 把 v1 权限配置（键值对数组）转换为 v2 的权限规则数组
function permissions(info?: ConfigPermissionV1.Info) {
  // 展平每个键下的规则；无配置时得到空数组
  const rules = (info ?? []).flatMap(([key, rule]) => {
    // 归一化动作名（v1 键名 → v2 动作）
    const action = normalizeAction(key)
    // 字符串规则作用于所有资源（*）
    if (typeof rule === "string") return [{ action, resource: "*", effect: rule }]
    // 对象规则逐条展开为 { 动作, 资源, 效果 }
    return rule.map(([resource, effect]) => ({ action, resource, effect }))
  })
  // 空规则集返回 undefined（不携带字段）
  return rules.length ? rules : undefined
}

// Map v1 permission/tool keys onto their renamed v2 tool actions so migrated rules keep matching.
// 把 v1 的权限/工具键名映射为 v2 改名后的动作，保证迁移后的规则继续生效
export function normalizeAction(action: string) {
  // write/patch/apply_patch 统一映射为 edit
  if (action === "write" || action === "patch" || action === "apply_patch") return "edit"
  // task 映射为 subagent
  if (action === "task") return "subagent"
  // bash 映射为 shell
  if (action === "bash") return "shell"
  // 其余键名不变
  return action
}

// 把 v1 代理配置迁移为 v2 代理配置（经 JSON 字符串 + Schema 解码校验）
export function migrateAgent(info: ConfigAgentV1.Info) {
  // 组装请求体附加参数：options 加上可选的温度/top_p
  const body = {
    // 透传全部附加选项
    ...info.options,
    // 有温度时附带
    ...(info.temperature === undefined ? {} : { temperature: info.temperature }),
    // 有 top_p 时附带
    ...(info.top_p === undefined ? {} : { top_p: info.top_p }),
  }
  // 序列化为 JSON 并按 v2 Schema 解码校验
  return decodeAgent(
    JSON.stringify({
      // 模型选择（提供商/模型/变体）
      model: modelSelection(info.model, info.variant),
      // 请求体附加参数（为空时不携带）
      request: Object.keys(body).length ? { body } : undefined,
      // 系统提示词
      system: info.prompt,
      // 描述
      description: info.description,
      // 运行模式
      mode: info.mode,
      // 是否隐藏
      hidden: info.hidden,
      // 颜色：十六进制原样保留，否则回退为灰色 #aaaaaa
      color: info.color === undefined ? undefined : info.color.startsWith("#") ? info.color : "#aaaaaa",
      // 最大迭代步数
      steps: info.steps,
      // 旧字段 disable 映射为 disabled
      disabled: info.disable,
      // 权限规则
      permissions: permissions(info.permission),
    }),
  )
}

// 把 v1 命令配置迁移为 v2 命令配置
export function migrateCommand(command: ConfigCommandV1.Info) {
  return {
    // 模板原样
    template: command.template,
    // 描述原样
    description: command.description,
    // 代理原样
    agent: command.agent,
    // 模型选择（含变体）
    model: modelSelection(command.model, command.variant),
    // 旧字段 subtask 映射为 subagent
    subagent: command.subtask,
  }
}

// 解析 v1 的 "provider/model"（及可选 "#variant"）字符串为结构化模型选择
export function modelSelection(input?: string, variant?: string) {
  // 为空或不符合 provider/model 格式时返回 undefined
  if (input === undefined || !/^[^/#]+\/[^#]+$/.test(input)) return undefined
  // 找到第一个 "/" 的位置作为分隔
  const separator = input.indexOf("/")
  // 返回结构化的选择对象
  return {
    // 提供商 ID（同时做旧 ID 更名）
    providerID: providerID(input.slice(0, separator)),
    // 模型 ID
    model: input.slice(separator + 1),
    // 变体：非空且不含 "#" 时附带
    ...(variant === undefined || variant.length === 0 || variant.includes("#") ? {} : { variant }),
  }
}

// V1 had a single MCP timeout, so a bare number bounds every phase.
// v1 只有单一 MCP 超时值，迁移时让该数字同时约束启动/目录/执行三个阶段
export function migrateMcpTimeout(timeout: number) {
  return { startup: timeout, catalog: timeout, execution: timeout }
}

// 把 v1 的 MCP 服务器配置迁移为 v2 格式
export function migrateMcp(info: ConfigMCPV1.Info) {
  // enabled 缺省为 undefined，否则取反为 disabled
  const disabled = info.enabled === undefined ? undefined : !info.enabled
  // 本地（stdio）服务器
  if (info.type === "local")
    return {
      // 类型
      type: info.type,
      // 启动命令
      command: info.command,
      // 工作目录
      cwd: info.cwd,
      // 环境变量
      environment: info.environment,
      // 禁用标记
      disabled,
      // Code Mode 开关
      codemode: info.codemode,
      // 超时（迁移为三阶段值）
      timeout: info.timeout === undefined ? undefined : migrateMcpTimeout(info.timeout),
    }
  // 远程（HTTP）服务器
  return {
    // 类型
    type: info.type,
    // 服务器 URL
    url: info.url,
    // 请求头
    headers: info.headers,
    // OAuth：存在时把驼峰字段转为下划线字段
    oauth: info.oauth && {
      // 客户端 ID
      client_id: info.oauth.clientId,
      // 客户端密钥
      client_secret: info.oauth.clientSecret,
      // 作用域
      scope: info.oauth.scope,
      // 回调端口
      callback_port: info.oauth.callbackPort,
      // 重定向 URI
      redirect_uri: info.oauth.redirectUri,
    },
    // 禁用标记
    disabled,
    // Code Mode 开关
    codemode: info.codemode,
    // 超时（迁移为三阶段值）
    timeout: info.timeout === undefined ? undefined : migrateMcpTimeout(info.timeout),
  }
}

// 按提供商来源 ID 分派到对应的迁移实现
export function migrateProvider(sourceID: string, info: ConfigProviderV1.Info) {
  // Azure 认知服务走专用迁移
  if (sourceID === "azure-cognitive-services") return migrateAzureCognitiveServicesProvider(info)
  // Google Vertex Anthropic 走专用迁移
  if (sourceID === "google-vertex-anthropic") return migrateGoogleVertexAnthropicProvider(info)
  // 其余走标准迁移
  return migrateStandardProvider(info)
}

// 标准提供商迁移
function migrateStandardProvider(info: ConfigProviderV1.Info) {
  // V1 `setCacheKey` toggled `prompt_cache_key` for the whole provider; it is not a provider package setting.
  // 剥离 setCacheKey（v1 中它控制整个提供商的 prompt_cache_key，不属于包设置）
  const { setCacheKey, ...rest } = info.options ?? {}
  // 解析剩余选项为设置/请求头/请求体
  const options = ConfigProviderOptionsV1.provider(rest)
  // 组装 v2 提供商配置
  return {
    // 显示名称
    name: info.name,
    // 环境变量
    env: info.env,
    // SDK 包说明符（npm 包时转换）
    package: info.npm ? packageSpecifier(info.npm) : undefined,
    // 兼容性信息：setCacheKey 映射为 supportsPromptCacheKey
    compatibility: setCacheKey === undefined ? undefined : { supportsPromptCacheKey: setCacheKey },
    // 设置项：有 api 时把 baseURL 覆盖为 api；否则用解析出的 settings
    settings: info.api ? { ...options.settings, baseURL: info.api } : info.options ? options.settings : undefined,
    // 请求头覆盖（有 options 时才携带）
    headers: info.options && options.headers,
    // 请求体覆盖（有 options 时才携带）
    body: info.options && options.body,
    // 逐个迁移模型配置
    models:
      info.models &&
      Object.fromEntries(Object.entries(info.models).map(([name, model]) => [name, migrateModel(model, info.npm)])),
  }
}

// Azure 认知服务提供商的专用迁移
function migrateAzureCognitiveServicesProvider(info: ConfigProviderV1.Info) {
  // 先按标准迁移
  const standard = migrateStandardProvider(info)
  // 迁移结果：从环境变量中移除已不再需要的资源名变量
  const migrated = {
    ...standard,
    env: standard.env?.filter((name) => name !== "AZURE_COGNITIVE_SERVICES_RESOURCE_NAME"),
  }
  // 不是 openai-compatible 包或显式配置了 api 时直接返回
  if (info.npm !== "@ai-sdk/openai-compatible" || info.api) return migrated
  // 否则自动补上从环境变量构造的 Azure baseURL
  return {
    ...migrated,
    settings: {
      ...migrated.settings,
      baseURL: "https://${AZURE_COGNITIVE_SERVICES_RESOURCE_NAME}.cognitiveservices.azure.com/openai",
    },
  }
}

// Google Vertex Anthropic 提供商的专用迁移
function migrateGoogleVertexAnthropicProvider(info: ConfigProviderV1.Info) {
  // 先按标准迁移
  const migrated = migrateStandardProvider(info)
  // 包名：缺省时使用 Google Vertex 的 Anthropic SDK
  const packageName = migrated.package ?? Provider.aisdk("@ai-sdk/google-vertex/anthropic")
  return {
    ...migrated,
    // The current Google Vertex provider includes Gemini and Claude. Keep the Anthropic SDK on Claude models
    // instead of changing the package inherited by every model on the provider.
    // 新的 Google Vertex 提供商同时含 Gemini 与 Claude；不在提供商层改包，
    // 而是把 Anthropic SDK 下放到各个 Claude 模型上
    package: undefined,
    // 逐个模型：已指定包的保持不变，否则补上 Anthropic SDK 包名
    models:
      migrated.models &&
      Object.fromEntries(
        Object.entries(migrated.models).map(([name, model]) => [
          name,
          model.package ? model : { ...model, package: packageName },
        ]),
      ),
  }
}

// Built-in provider routes are already native package specifiers; only npm packages load through the AI SDK.
// 计算包说明符：内置路由本就是原生说明符；只有 npm 包才经由 AI SDK 加载
function packageSpecifier(npm: string) {
  // 规范化包名
  const name = Provider.packageName(npm)
  // @opencode/ai/ 前缀的原生包直接使用；其余包装为 aisdk 说明符
  return name.startsWith("@opencode/ai/") ? name : Provider.aisdk(npm)
}

// Renames retired provider IDs in V1 fields and the shared top-level model.
// 更名已退役的 v1 提供商 ID（配置字段与共享顶层模型均会用到）
export function providerID(input: string) {
  // Azure 认知服务 → azure
  if (input === "azure-cognitive-services") return "azure"
  // Google Vertex Anthropic → google-vertex
  if (input === "google-vertex-anthropic") return "google-vertex"
  // 其余不变
  return input
}

// 把 v1 的模型配置迁移为 v2 格式
function migrateModel(info: typeof ConfigProviderV1.Model.Type, npm: string | undefined) {
  // 检测旧版"禁用思考块绑定"的退出选项（thinking 或 reasoningConfig 中 blockBinding === false）
  const disableThinkingBlockBinding =
    info.options?.thinking?.blockBinding === false || info.options?.reasoningConfig?.blockBinding === false
  // 复制 options，避免修改入参
  const options = info.options && { ...info.options }

  // Move the legacy opt-out to compatibility without mutating the input.
  // 把旧版退出开关从 options 移到 compatibility（不改动输入对象）
  if (options && disableThinkingBlockBinding) {
    // 遍历可能携带该开关的两个键
    for (const key of ["thinking", "reasoningConfig"]) {
      // 该键没有禁用绑定时跳过
      if (options[key]?.blockBinding !== false) continue

      // 从子对象中剥离 blockBinding，保留其余键
      const { blockBinding, ...rest } = options[key]
      // 还有剩余键时保留子对象
      if (Object.keys(rest).length) {
        options[key] = rest
        continue
      }
      // 子对象只剩该开关时整键删除
      delete options[key]
    }
  }

  // 判断是否为 openai-compatible 提供商（决定选项拆分方式）
  const compatible = (info.provider?.npm ?? npm) === "@ai-sdk/openai-compatible"
  // 拆分函数：兼容包拆为 settings+body，其它包全部作为 settings
  const split = (input: Record<string, unknown>) =>
    compatible
      ? ConfigProviderOptionsV1.compatibleModel(input)
      : { settings: ConfigProviderOptionsV1.model(input), body: undefined }
  // 有 options 时执行拆分
  const migrated = options && split(options)
  // 设置项
  const settings = migrated?.settings
  // 由 interleaved 推导兼容性信息
  const compatibility = Model.compatibility(info.interleaved)
  // 计费信息：基础档 + 可选的 200k 以上档位
  const costs = info.cost && [
    {
      // 基础输入单价
      input: info.cost.input,
      // 基础输出单价
      output: info.cost.output,
      // 缓存读写单价
      cache: { read: info.cost.cache_read, write: info.cost.cache_write },
    },
    // 存在超长上下文档位时附加
    ...(info.cost.context_over_200k
      ? [
          {
            // 档位：上下文 200k
            tier: { type: "context" as const, size: 200_000 },
            // 超长输入单价
            input: info.cost.context_over_200k.input,
            // 超长输出单价
            output: info.cost.context_over_200k.output,
            // 超长缓存单价
            cache: { read: info.cost.context_over_200k.cache_read, write: info.cost.context_over_200k.cache_write },
          },
        ]
      : []),
  ]
  // 取模型能力默认值
  const defaults = Model.Capabilities.default()
  // 显式声明过工具调用或模态时才构造能力对象
  const capabilities =
    info.tool_call !== undefined || info.modalities?.input !== undefined || info.modalities?.output !== undefined
      ? {
          // 工具调用能力（缺省用默认）
          tools: info.tool_call ?? defaults.tools,
          // 输入模态（缺省用默认）
          input: info.modalities?.input ?? defaults.input,
          // 输出模态（缺省用默认）
          output: info.modalities?.output ?? defaults.output,
        }
      : undefined
  // 组装 v2 模型配置
  return {
    // 模型 ID
    modelID: info.id,
    // 模型家族
    family: info.family,
    // 显示名称
    name: info.name,
    // 兼容性：旧版禁用思考绑定时附加 supportsThinkingBlockBinding: false
    compatibility: disableThinkingBlockBinding
      ? { ...compatibility, supportsThinkingBlockBinding: false }
      : compatibility,
    // SDK 包说明符（provider.npm 优先）
    package: info.provider?.npm ? packageSpecifier(info.provider.npm) : undefined,
    // 设置项：provider.api 存在时覆盖 baseURL
    settings: info.provider?.api ? { ...settings, baseURL: info.provider.api } : settings,
    // 能力
    capabilities,
    // 模型级请求头
    headers: info.headers,
    // 额外请求体（仅兼容包有）
    body: migrated?.body,
    // 变体列表：逐个拆分为 id + settings/body
    variants:
      info.variants &&
      Object.entries(info.variants).map(([id, options]) => ({ id, ...split(options) })),
    // 计费
    cost: costs,
    // 状态为 deprecated 时标记禁用
    disabled: info.status === "deprecated" ? true : undefined,
    // 限制：截断为安全整数范围
    limit: info.limit && {
      context: int(info.limit.context),
      input: info.limit.input === undefined ? undefined : int(info.limit.input),
      output: int(info.limit.output),
    },
  }
}

// 把数值截断并夹在安全整数范围内（用于限制字段）
function int(value: number) {
  return Math.max(Number.MIN_SAFE_INTEGER, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value)))
}
