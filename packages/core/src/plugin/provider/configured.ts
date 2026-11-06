// 从 effect 库导入 Effect 组合子与 Option 可选值类型
import { Effect, Option } from "effect"
// 导入配置文档（Document）与配置条目（Entry）的类型定义
import type { Document, Entry } from "@opencode/schema/config"
// 导入配置服务（读取全局 opencode 配置）
import { Config } from "../../config.js"
// 导入 Provider 模块（供应商相关的服务与类型）
import { Provider } from "../../provider.js"

// 定义 configuredSettings：一个 Effect 生成器函数，读取指定供应商 ID 当前已生效的设置
export const configuredSettings = Effect.fn("ProviderPlugin.configuredSettings")(function* (id: Provider.ID) {
  // 从上下文中取出 Provider 服务
  const providers = yield* Provider.Service
  // 获取该供应商当前的设置（可能不存在，故用可选链）
  const current = (yield* providers.get(id))?.settings
  // 尝试获取 Config 服务；可能未提供，所以返回 Option
  const service = yield* Effect.serviceOption(Config.Service)
  // 若 Config 服务存在则读取其全部条目，否则视为空数组
  const entries = Option.isSome(service) ? yield* service.value.entries() : []
  // 将各配置文档中的供应商设置逐层折叠合并到当前设置上
  return foldSettings(entries, id, current)
})

// 折叠函数：把所有“文档型”配置条目里对应供应商的设置依次合并（overlay 合并），以 initial 为初始值
export function foldSettings(entries: readonly Entry[], id: string, initial: Provider.Settings | undefined) {
  return entries
    // 只保留类型为 document 的条目（过滤并收窄类型）
    .filter((entry): entry is Document => entry.type === "document")
    // 依次把每个文档中该供应商的 settings 合并进累计结果
    .reduce((settings, entry) => Provider.mergeOverlay(settings, entry.info.providers?.[id]?.settings), initial)
}
