// 从 effect 库导入 Effect 与 Schema（模式校验/解码工具）
import { Effect, Schema } from "effect"
// 导入本地提供商插件工厂（与 LM Studio、vLLM 等本地服务共用一套发现逻辑）
import { createLocalProviderPlugin } from "./local.js"

// 定义 LM Studio /api/v1/models 返回的单个模型条目的 Schema（结构校验）
const RemoteModel = Schema.Struct({
  type: Schema.String,
  key: Schema.String,
  // 展示名称
  display_name: Schema.String,
  // 模型架构（可选，可为 null），用作模型家族（family）
  architecture: Schema.NullOr(Schema.String).pipe(Schema.optional),
  // 当前已加载的实例列表，每个实例携带各自的上下文长度配置
  loaded_instances: Schema.Array(
    Schema.Struct({
      config: Schema.Struct({ context_length: Schema.Int }),
    }),
  ),
  // Null for decision models whose context is unknown.
  max_context_length: Schema.NullOr(Schema.Int),
  capabilities: Schema.Struct({
    vision: Schema.Boolean,
    trained_for_tool_use: Schema.Boolean,
  }).pipe(Schema.optional),
  has_vision_adapter: Schema.Boolean.pipe(Schema.optional),
})

// 定义整个响应体的 Schema：包含模型数组
const Response = Schema.Struct({ models: Schema.Array(RemoteModel) })

// 通过通用本地提供商插件工厂创建 LM Studio 插件构造器
export const make = createLocalProviderPlugin({
  // 插件唯一标识符
  id: "opencode.provider.lmstudio",
  // 目录中提供商的 ID
  providerID: "lmstudio",
  // 展示名称
  name: "LM Studio",
  // LM Studio 本地服务默认地址
  origin: "http://127.0.0.1:1234",
  // 去掉 baseURL 末尾的 /v1 或 /api/v1 后缀，得到服务根地址
  stripPathSuffix: /\/(?:api\/)?v1$/,
  // 发现逻辑：请求模型列表并整理
  discover: (client) =>
    Effect.gen(function* () {
      // 请求 /api/v1/models 并按 Response Schema 解码
      const response = yield* client.getJson("/api/v1/models", Response)
      // 过滤出真正的文本生成模型且 key 非空，再按 key 字典序排序
      return response.models
        .filter((model) => (model.type === "llm" || model.type === "decision") && model.key.length > 0)
        .toSorted((a, b) => a.key.localeCompare(b.key))
    }),
  // 把发现的远端模型条目映射为 OpenCode 的模型描述
  model: (item) => ({
    // 模型 ID 取 key
    id: item.key,
    // 展示名优先用 display_name，缺失时回退到 key
    name: item.display_name || item.key,
    // 模型家族取架构字段
    family: item.architecture,
    type: item.type === "decision" ? "decision" : "chat",
    tools: item.capabilities?.trained_for_tool_use,
    vision: item.capabilities?.vision ?? item.has_vision_adapter,
    context:
      item.loaded_instances.length === 0
        ? item.max_context_length
        : Math.min(...item.loaded_instances.map((instance) => instance.config.context_length)),
  }),
})

// 用默认 origin 构造插件实例并导出
export const LMStudioPlugin = make()
