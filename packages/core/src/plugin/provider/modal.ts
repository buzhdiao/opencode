// 从 effect 库导入 Effect
import { Effect } from "effect"
// 从 effect/http 导入 HttpClient 服务
import { HttpClient } from "effect/http"
// 导入插件定义辅助函数 define
import { define } from "@opencode/plugin/effect/plugin"
// 导入集成连接（integration connection）工具
import { IntegrationConnection } from "../../integration/connection.js"
// 导入 Modal 模型目录的加载/派生工具
import { ModalModels } from "../../modal/models.js"
// 导入 Provider 服务与 ID 工具
import { Provider } from "../../provider.js"
// 导入跨 Location 共享缓存服务
import { SharedCache } from "../../shared-cache.js"
// 导入内部插件类型声明（仅类型）
import type { PluginInternal } from "../internal.js"
// 导入“当前生效凭据”读取辅助函数
import { activeCredential } from "./credential-settings.js"
// 导入提供商刷新辅助工具
import { ProviderRefresh } from "./refresh.js"

// Modal 提供商的 ID
const providerID = Provider.ID.make("modal")

// 导出 Modal 提供商插件：按连接与凭据发现 Modal 代理背后的模型列表
export const ModalPlugin = define({
  // 插件唯一标识符
  id: "opencode.provider.modal",
  // 插件主流程生成器
  effect: Effect.fn(function* (ctx) {
    // 获取提供商服务实例
    const providers = yield* Provider.Service
    // 获取共享缓存服务实例
    const cache = yield* SharedCache.Service
    // 获取 HTTP 客户端实例
    const http = yield* HttpClient.HttpClient
    // 启动刷新循环：凭据切换、定时与强制加载都会触发 load，结果存入 discovered
    const discovered = yield* ProviderRefresh.start({
      // 关联的集成 ID
      integrationID: "modal",
      // 初始状态：尚无 baseURL、模型与连接信息
      initial: {} as {
        readonly baseURL?: string
        readonly models?: ModalModels.Snapshot
        readonly connection?: Effect.Success<ReturnType<typeof ctx.integration.connection.active>>
      },
      // 读取当前活跃连接的 Effect
      active: ctx.integration.connection.active("modal"),
      // 状态变化时重载提供商目录
      reload: ctx.provider.reload(),
      // load：读取凭据并加载模型快照
      load: Effect.fn("ModalPlugin.load")(function* (_, options) {
        // 取当前生效的连接与凭据
        const { connection, credential } = yield* activeCredential(ctx, "modal")
        // 优先用凭据里的 key，否则回退到环境变量 MODAL_PROXY_TOKEN
        const apiKey = credential?.type === "key" ? credential.key : process.env.MODAL_PROXY_TOKEN
        // 获取 modal 提供商的目录条目
        const provider = yield* providers.get(providerID)
        // 读取用户配置的 baseURL（必须是字符串）
        const baseURL = typeof provider?.settings?.baseURL === "string" ? provider.settings.baseURL : undefined
        // 缺少 key 或 baseURL 时返回空状态
        if (!apiKey || !baseURL) return { connection, value: {} }
        // 通过共享缓存加载模型快照：按连接/key/baseURL 组成的缓存键去重
        const models = yield* cache
          .get({
            key: modelsKey(connection, apiKey, baseURL),
            ...options,
            // 缓存未命中时的实际加载逻辑
            load: (connection ? ctx.integration.connection.resolve(connection) : Effect.undefined).pipe(
              // 解析出加载模型用的 key：连接凭据的 key、无连接时用环境变量，其余情况失败
              Effect.map((current) =>
                current?.type === "key" ? current.key : connection ? undefined : process.env.MODAL_PROXY_TOKEN,
              ),
              // 有 key 才真正请求 Modal 的模型列表
              Effect.flatMap((key) =>
                key ? ModalModels.load(http, baseURL, key) : Effect.fail(new Error("Modal connection has no API key")),
              ),
              // 加载结果按模型 ID 字典序排序
              Effect.map((models) => models.toSorted((a, b) => a.id.localeCompare(b.id))),
            ),
          })
          // 缓存层整体失败（网络错误等）时按“无模型”处理
          .pipe(Effect.orElseSucceed(() => undefined))
        // 返回本连接对应的快照状态
        return { connection, value: { baseURL, models, connection } }
      }),
    })

    // 订阅 provider 目录变换：把发现的模型注入 modal 提供商条目
    yield* ctx.provider.transform((evt) => {
      // 取 modal 提供商条目与最近一次发现的快照
      const item = evt.get(providerID)
      const loaded = discovered.current
      // 提供商不存在或尚未发现模型/baseURL 时直接返回
      if (!item || !loaded.models || !loaded.baseURL) return
      // 以“追加模型”的形式登记提供商信息、派生后的模型列表与来源连接
      evt.add({
        info: item.provider,
        models: Array.from(
          ModalModels.derive(loaded.baseURL, loaded.models, Array.from(item.models.values())).values(),
        ),
        sourceConnection: loaded.connection,
      })
    })
  }),
} satisfies PluginInternal.InternalPlugin)

// modelsKey：构造模型快照的缓存键（连接标识 + key 指纹 + 去尾斜杠的 baseURL）
function modelsKey(connection: Parameters<typeof IntegrationConnection.key>[0], apiKey: string, baseURL: string) {
  // 连接标识；无连接时标记为环境变量来源
  const access = IntegrationConnection.key(connection) ?? "env:MODAL_PROXY_TOKEN"
  // 拼接缓存键：key 只放指纹，避免明文泄漏
  return `modal:${access}:${SharedCache.fingerprint(apiKey)}:${baseURL.replace(/\/+$/, "")}`
}
