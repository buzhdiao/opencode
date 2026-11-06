// 从 effect 库导入 Effect 与 Schema
import { Effect, Schema } from "effect"
// 导入本地提供商插件工厂（与 LM Studio 等共用发现逻辑）
import { createLocalProviderPlugin } from "./local.js"

// 提供商 ID，同时用于过滤 owned_by 字段
const providerID = "vllm"

// 定义 vLLM /v1/models 返回的单个模型条目的 Schema
const RemoteModel = Schema.Struct({
  // 模型 ID
  id: Schema.String,
  // 模型归属方（用于过滤出 vLLM 自己的模型）
  owned_by: Schema.String,
  // 最大模型长度（上下文），服务端可能返回 null
  max_model_len: Schema.NullOr(Schema.Int),
})

// 定义整个响应体的 Schema：data 数组
const Response = Schema.Struct({ data: Schema.Array(RemoteModel) })

// 通过通用本地提供商插件工厂创建 vLLM 插件构造器
export const make = createLocalProviderPlugin({
  // 插件唯一标识符
  id: "opencode.provider.vllm",
  // 目录中提供商的 ID
  providerID,
  // 展示名称
  name: "vLLM",
  // vLLM 服务默认地址
  origin: "http://127.0.0.1:8000",
  // 发现逻辑：先探活再拉取模型列表
  discover: (client) =>
    Effect.gen(function* () {
      // 请求 /health 确认服务可达（失败会中断发现流程）
      yield* client.get("/health")
      // 请求 /v1/models 并按 Response Schema 解码
      const response = yield* client.getJson("/v1/models", Response)
      // 只保留归属为 vLLM 且 ID 非空的模型，按 ID 字典序排序
      return response.data
        .filter((model) => model.owned_by === providerID && model.id.length > 0)
        .toSorted((a, b) => a.id.localeCompare(b.id))
    }),
  // Tool calling depends on vLLM server flags and parsers that model discovery does not report.
  // 把发现的模型条目映射为 OpenCode 的模型描述
  model: (item) => ({
    // 模型 ID
    id: item.id,
    // 上下文长度取服务端报告的 max_model_len
    context: item.max_model_len,
  }),
})

// 用默认 origin 构造插件实例并导出
export const VLLMPlugin = make()
