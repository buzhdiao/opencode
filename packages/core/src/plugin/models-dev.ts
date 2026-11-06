// define：插件定义辅助函数
import { define } from "@opencode/plugin/effect/plugin"
// Integration：集成（integration）相关 Schema
import { Integration } from "@opencode/schema/integration"
// Provider：提供商 Schema（含 ID 枚举）
import { Provider } from "@opencode/schema/provider"
// Effect/Stream：效果运行时与流
import { Effect, Stream } from "effect"
// Bus：进程内事件总线服务
import { Bus } from "../bus.js"
// Model：模型服务（用于判断模型能力）
import { Model } from "../model.js"
// ModelsDev：models.dev 目录（catalog）快照服务
import { ModelsDev } from "../models-dev.js"

// These catalog entries require inference profiles on Bedrock Runtime.
// Opus/Sonnet 4.6 and Opus 5.5 support in-region calls in eu-west-2 and must remain available.
// 以下目录条目在 Bedrock Runtime 上必须通过推理配置文件（inference profile）调用，
// 不能直接按模型 ID 调用；Opus/Sonnet 4.6 与 Opus 5.5 在 eu-west-2 支持区域内调用，需保留。
const BEDROCK_PROFILE_ONLY_IDS = [
  // 逐一列出仅能通过 Bedrock 推理配置文件调用的模型 ID
  "amazon.nova-2-lite-v1:0",
  "anthropic.claude-fable-5",
  "anthropic.claude-fable-5-1",
  "anthropic.claude-haiku-4-5-20251001-v1:0",
  "anthropic.claude-haiku-5-5",
  "anthropic.claude-opus-4-1-20250805-v1:0",
  "anthropic.claude-opus-4-5-20251101-v1:0",
  "anthropic.claude-opus-4-7",
  "anthropic.claude-opus-4-8",
  "anthropic.claude-opus-5",
  "anthropic.claude-sonnet-4-5-20250929-v1:0",
  "anthropic.claude-sonnet-5",
  "anthropic.claude-sonnet-5-5",
  "deepseek.r1-v1:0",
  "meta.llama4-maverick-17b-instruct-v1:0",
  "meta.llama4-scout-17b-instruct-v1:0",
  "mistral.pixtral-large-2502-v1:0",
  "writer.palmyra-x4-v1:0",
  "writer.palmyra-x5-v1:0",
]

// 定义 models.dev 目录插件：把 models.dev 快照接入集成与提供商体系
export const ModelsDevPlugin = define({
  // 插件唯一标识
  id: "opencode.models.dev",
  // 插件激活时执行的生成器主体
  effect: Effect.fn(function* (ctx) {
    // 获取 models.dev 快照服务
    const modelsDev = yield* ModelsDev.Service
    // 获取事件总线服务
    const bus = yield* Bus.Service
    // Filtering and definition indexes are shared across Locations. Only Model materialization
    // makes mutable copies, after provider configuration and access have been resolved.
    // 过滤与定义索引在多个 location 间共享；只有模型实体化（materialization）才做可变拷贝。
    // 读取当前快照并做过滤预处理，包一层可变引用便于后续刷新
    const loaded = { data: snapshots(yield* modelsDev.get()) }
    // 把每个提供商登记成集成（integration）及其认证方式
    yield* ctx.integration.transform((integrations) => {
      // 遍历过滤后的每个提供商快照
      for (const provider of loaded.data) {
        // 没有声明环境变量（environment）的提供商无需登记
        if (provider.environment.length === 0) continue
        // 以提供商 id 作为集成 ID
        const integrationID = provider.info.id
        // 更新集成名称为提供商显示名
        integrations.update(integrationID, (integration) => (integration.name = provider.info.name))
        // 登记"API key"认证方式
        integrations.method.update({
          // 所属集成
          integrationID,
          // 方式类型：密钥
          method: { type: "key" },
        })
        // 登记"环境变量"认证方式
        integrations.method.update({
          // 所属集成
          integrationID,
          // 方式类型：环境变量，列出全部候选变量名
          method: {
            type: "env",
            // Every listed variable is treated as a key; plugins override providers that also list setup values.
            // 每个列出的变量都视作密钥来源；若提供商另有 setup 值，会被插件覆盖。
            names: [...provider.environment],
          },
        })
      }
    })
    // 把 models.dev 快照注册为可用提供商及模型目录
    yield* ctx.provider.transform((providers) => {
      // 遍历每个提供商快照
      for (const provider of loaded.data) {
        // 添加提供商定义（附带 integrationID 关联）与其模型列表
        providers.add({
          // 复制提供商信息并关联集成 ID
          info: { ...provider.info, integrationID: Integration.ID.make(provider.info.id) },
          // 该提供商的全部模型
          models: provider.models,
        })
      }
    })
    // apply：用新快照替换内存数据并触发集成与提供商重载
    const apply = (data: readonly ModelsDev.Snapshot[]) => {
      // 重新过滤并替换内存中的快照数据
      loaded.data = snapshots(data)
      // 依次重载集成与提供商，使新数据生效
      return ctx.integration.reload().pipe(Effect.andThen(ctx.provider.reload()))
    }
    // 订阅"快照已刷新"事件，后台持续应用新数据
    yield* bus.subscribe(ModelsDev.Event.Refreshed).pipe(
      // 每收到一条刷新事件就重新读取并应用
      Stream.runForEach(() => modelsDev.get().pipe(Effect.flatMap(apply))),
      // 以当前作用域（Scope）派生后台纤维（fiber），并立即启动
      Effect.forkScoped({ startImmediately: true }),
    )
    // A refresh that landed between the initial read and the subscription above published
    // Refreshed to nobody here. On a cold cache that read served the bundled snapshot, so
    // re-read now instead of waiting for the next TTL refresh.
    // 初次读取与订阅建立之间落地的刷新事件无人消费；冷缓存时初次读取只拿到内置快照，
    // 因此这里立即重读一次，而不是等待下一轮 TTL 刷新。
    const latest = yield* modelsDev.get()
    // 若最新快照与已应用的不同，则再应用一次
    if (snapshots(latest) !== loaded.data) yield* apply(latest)
  }),
})

// WeakMap 缓存：以原始快照数组为键记住过滤结果，避免重复过滤
const prepared = new WeakMap<readonly ModelsDev.Snapshot[], readonly ModelsDev.Snapshot[]>()

// 过滤并规范化 models.dev 快照：剔除废弃提供商、不可用模型与 Bedrock 专用推理配置模型
function snapshots(data: readonly ModelsDev.Snapshot[]) {
  // 命中缓存直接返回，保证同一快照的过滤结果引用稳定
  const cached = prepared.get(data)
  // 缓存存在则复用
  if (cached) return cached
  // 开始构建过滤后的结果
  const result = data
    // 先过滤提供商
    .filter(
      // These deprecated aliases are replaced by the canonical Azure and Google Vertex providers.
      // 这些已弃用的别名由规范的 Azure 与 Google Vertex 提供商取代，直接剔除。
      (provider) => provider.info.id !== "azure-cognitive-services" && provider.info.id !== "google-vertex-anthropic",
    )
    // 再逐提供商过滤模型
    .map((provider) => ({
      // 保留提供商其余字段
      ...provider,
      // 过滤后的模型列表
      models: provider.models.filter(
        (model) =>
          // 剔除标记为废弃（deprecated）的模型
          model.status !== "deprecated" &&
          // Non-chat models are kept for lookups; the Model service never offers them for sessions.
          // 非聊天模型保留用于查询；Model 服务不会把它们提供给会话使用。
          ((model.type ?? "chat") !== "chat" || Model.supportsText(model)) &&
          // Bedrock 上必须走推理配置文件的模型不进入直连目录
          !(
            provider.info.id === Provider.ID.amazonBedrock &&
            BEDROCK_PROFILE_ONLY_IDS.includes(model.modelID ?? model.id)
          ),
      ),
    }))
  // 写入缓存
  prepared.set(data, result)
  // 返回过滤结果
  return result
}
