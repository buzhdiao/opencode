// 从 effect 库导入 Effect 与 Schema
import { Effect, Schema } from "effect"
// 导入本地提供商插件工厂
import { createLocalProviderPlugin } from "./local.js"

// 定义 /api/tags 与 /api/show 共用的模型详情 Schema
const Details = Schema.Struct({
  // 来源父模型（可选，如微调自某个基础模型）
  parent_model: Schema.String.pipe(Schema.optional),
  // 量化格式
  format: Schema.String,
  // 模型家族
  family: Schema.String,
  // 家族列表（可选）
  families: Schema.Array(Schema.String).pipe(Schema.optional),
  // 参数规模（如 "7B"）
  parameter_size: Schema.String,
  // 量化级别
  quantization_level: Schema.String,
})

// 定义 /api/tags 返回的单个模型条目的 Schema
const RemoteModel = Schema.Struct({
  // 展示名称
  name: Schema.String,
  // 模型标识（tag 形式，如 llama3:8b）
  model: Schema.String,
  // 远端模型名（可选，云端托管的模型）
  remote_model: Schema.String.pipe(Schema.optional),
  // 远端主机（可选）
  remote_host: Schema.String.pipe(Schema.optional),
  // 最后修改时间
  modified_at: Schema.String,
  // 模型文件大小（字节）
  size: Schema.Int,
  // 内容摘要，用于判断模型是否变化
  digest: Schema.String,
  // 模型详情
  details: Details,
})

// /api/tags 的响应体 Schema
const TagsResponse = Schema.Struct({ models: Schema.Array(RemoteModel) })
// /api/show 的请求体 Schema
const ShowRequest = Schema.Struct({ model: Schema.String })
// /api/show 的响应体 Schema（各字段大多可选）
const ShowResponse = Schema.Struct({
  parameters: Schema.String.pipe(Schema.optional),
  license: Schema.String.pipe(Schema.optional),
  modified_at: Schema.String.pipe(Schema.optional),
  details: Details.pipe(Schema.optional),
  template: Schema.String.pipe(Schema.optional),
  // 能力列表：completion、tools、vision 等
  capabilities: Schema.Array(Schema.String).pipe(Schema.optional),
  // 模型元信息键值对（如 *.context_length）
  model_info: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
})

// 发现到的模型 = tags 条目 + 对应的 show 详情
type DiscoveredModel = typeof RemoteModel.Type & { show: typeof ShowResponse.Type }
// show 详情缓存：记录凭据与各模型的 digest→info 映射
type ShowCache = {
  apiKey?: string
  entries: Map<string, { digest: string; info: typeof ShowResponse.Type }>
}

// 按服务根地址缓存各 Ollama 实例的 show 详情（跨刷新复用）
const shows = new Map<string, ShowCache>()

// 通过通用本地提供商插件工厂创建 Ollama 插件构造器
export const make = createLocalProviderPlugin({
  // 插件唯一标识符
  id: "opencode.provider.ollama",
  // 目录中提供商的 ID
  providerID: "ollama",
  // 展示名称
  name: "Ollama",
  // Ollama 默认服务地址
  origin: "http://127.0.0.1:11434",
  // 去掉 baseURL 末尾的 /v1 或 /api 后缀，得到服务根地址
  stripPathSuffix: /\/(?:v1|api)$/,
  // 发现逻辑：列出模型并逐个获取 show 详情
  discover: (client) =>
    Effect.gen(function* () {
      // 读取该服务根地址此前的 show 缓存
      const cached = shows.get(client.root)
      // 仅当凭据（apiKey）一致时才复用上次的条目，否则从空 Map 开始
      const previous = cached && cached.apiKey === client.apiKey ? cached.entries : new Map()
      // 先以旧条目占位写入缓存（记录当前凭据）
      shows.set(client.root, { apiKey: client.apiKey, entries: previous })
      // 请求 /api/tags 获取本地模型列表
      const response = yield* client.getJson("/api/tags", TagsResponse)
      // 过滤掉 model 为空的条目并按 model 名字典序排序
      const summaries = response.models
        .filter((model) => model.model.length > 0)
        .toSorted((a, b) => a.model.localeCompare(b.model))
      // 本轮发现的新缓存条目
      const entries = new Map<string, { digest: string; info: typeof ShowResponse.Type }>()
      // 并发 4 路逐个获取每个模型的 show 详情
      const models = yield* Effect.forEach(
        summaries,
        (model) =>
          Effect.gen(function* () {
            // 上次缓存的该模型详情
            const saved = previous.get(model.model)
            // digest 未变则复用旧详情，否则重新请求 /api/show
            const info =
              saved?.digest === model.digest
                ? saved.info
                : yield* client.postJson("/api/show", ShowRequest, { model: model.model }, ShowResponse)
            // 记录到新缓存
            entries.set(model.model, { digest: model.digest, info })
            // 返回带 show 详情的模型条目
            return { ...model, show: info }
          }).pipe(Effect.orElseSucceed(() => undefined)),
        { concurrency: 4 },
      )
      // 用新条目整体替换缓存
      shows.set(client.root, { apiKey: client.apiKey, entries })
      // 只保留具备 completion 能力且获取详情成功的模型
      return models.filter(
        (model): model is DiscoveredModel =>
          model !== undefined && (model.show.capabilities?.includes("completion") ?? false),
      )
    }),
  // 把发现的模型条目映射为 OpenCode 的模型描述
  model: (item) => ({
    // 模型 ID 用 tag 形式的 model 名
    id: item.model,
    // 展示名优先用 name
    name: item.name || item.model,
    // 家族优先取 show 详情里的，缺失时回退到 tags 的 details
    family: item.show.details?.family || item.details.family,
    // 工具调用能力取决于 show 里的 capabilities
    tools: item.show.capabilities?.includes("tools"),
    // 视觉能力同上
    vision: item.show.capabilities?.includes("vision"),
    // 从 model_info 中找出第一个 .context_length 结尾的正数值作为上下文长度
    context: Object.entries(item.show.model_info ?? {}).flatMap(([key, value]) =>
      key.endsWith(".context_length") && typeof value === "number" && value > 0 ? [value] : [],
    )[0],
  }),
})

// 用默认 origin 构造插件实例并导出
export const OllamaPlugin = make()
