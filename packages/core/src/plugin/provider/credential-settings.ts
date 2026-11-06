// 从 effect 库导入 Effect 组合子
import { Effect } from "effect"
// 导入插件上下文类型
import type { Context } from "@opencode/plugin/effect/plugin"
// 导入凭据（Credential）模块
import { Credential } from "../../credential.js"
// 导入 Provider 类型定义
import type { Provider } from "../../provider.js"
// 导入供应商刷新（ProviderRefresh）工具
import { ProviderRefresh } from "./refresh.js"

/**
 * 把集成（integration）当前激活的连接解析为其凭据；无法解析时返回 undefined。
 */
/** Resolves the integration's active connection to its credential, or undefined when it cannot be resolved. */
export const activeCredential = Effect.fnUntraced(function* (
  // 插件上下文
  ctx: Context,
  // 集成 ID
  integrationID: string,
): Effect.fn.Return<{
  // 激活连接（Effect 成功值类型）
  readonly connection: Effect.Success<ReturnType<Context["integration"]["connection"]["active"]>>
  // 对应的凭据值（可能为 undefined）
  readonly credential: Credential.Value | undefined
}> {
  // 获取该集成当前激活的连接
  const connection = yield* ctx.integration.connection.active(integrationID)
  // 若存在连接则解析为凭据；解析失败时以 undefined 兜底
  const credential = connection
    ? yield* ctx.integration.connection.resolve(connection).pipe(Effect.orElseSucceed(() => undefined))
    : undefined
  // 返回连接与凭据
  return { connection, credential }
})

/**
 * 跟踪由激活连接的存储凭据推导出的供应商设置（例如作为凭据元数据保存的登录表单答案）。
 * 模型解析器不会把凭据元数据传给包（package），因此需要它的插件要在自己的 provider transform
 * 中应用这些设置。当该集成激活的凭据切换且推导设置发生变化时，会重新加载供应商。
 */
/**
 * Tracks provider settings a plugin derives from the active connection's stored credential, such as login form
 * answers kept as credential metadata. The model resolver does not pass credential metadata to packages, so a
 * plugin that needs it applies these settings in its provider transform. Switching this integration's active
 * credential reloads providers when the derived settings change.
 */
export const credentialSettings = Effect.fn("ProviderPlugin.credentialSettings")(function* (
  // 插件上下文
  ctx: Context,
  // 集成 ID
  integrationID: string,
  // 选择器：从凭据值中提取供应商设置
  select: (value: Credential.Value) => Provider.Settings,
) {
  // 获取凭据服务
  const credentials = yield* Credential.Service
  // 定义加载函数：读取当前激活连接凭据并推导设置
  const load = Effect.fn("ProviderPlugin.credentialSettings.load")(function* () {
    // 获取该集成当前激活的连接
    const connection = yield* ctx.integration.connection.active(integrationID)
    // 直接读取存储的凭据值而不是解析连接，这样启动阶段不会触发任何刷新
    // Reads the stored value rather than resolving the connection, so startup never refreshes anything.
    const stored =
      connection?.type === "credential" ? yield* credentials.get(Credential.ID.make(connection.id)) : undefined
    // 有凭据则用选择器推导设置，否则返回空对象
    return stored ? select(stored.value) : {}
  })
  // 初始设置：立即加载一次
  const current = { settings: yield* load() }
  // 注册“凭据切换”回调：切换发生时重新加载并按需刷新供应商
  yield* ProviderRefresh.onSwitch(
    integrationID,
    Effect.gen(function* () {
      // 重新加载推导设置
      const next = yield* load()
      // 与当前设置做 JSON 比较，无变化则不刷新
      if (JSON.stringify(next) === JSON.stringify(current.settings)) return
      // 更新缓存中的当前设置
      current.settings = next
      // 触发供应商重载
      yield* ctx.provider.reload()
    }),
  )
  // 返回携带当前设置的引用（后续切换时会被更新）
  return current
})

/**
 * 从凭据元数据中挑出供应商包接受为设置项的字符串字段。
 */
/** Picks the string metadata entries a provider package accepts as settings. */
export function metadataSettings(metadata: Readonly<Record<string, unknown>> | undefined, keys: readonly string[]) {
  // 遍历关注的键：仅保留值为非空字符串的条目，构造为对象
  return Object.fromEntries(
    keys.flatMap((key) => (typeof metadata?.[key] === "string" && metadata[key] !== "" ? [[key, metadata[key]]] : [])),
  )
}
