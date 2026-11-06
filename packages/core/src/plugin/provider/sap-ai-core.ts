// 从 effect 库导入 Effect
import { Effect } from "effect"
// 导入插件定义辅助函数 define
import { define } from "@opencode/plugin/effect/plugin"
// 导入 Npm 服务（用于动态安装依赖包）
import { Npm } from "@opencode/util/npm"
// 导入 Provider（提供商 ID 工具）
import { Provider } from "../../provider.js"
// 导入 SDK 工厂加载辅助函数
import { loadSDKFactory } from "./sdk-factory.js"

// 导出 SAP AI Core 提供商插件：动态加载其 SDK 包并创建语言模型实例
export const SapAICorePlugin = define({
  // 插件唯一标识符
  id: "opencode.provider.sap.ai.core",
  // 插件主流程生成器
  effect: Effect.fn(function* (ctx) {
    // 获取 Npm 服务实例
    const npm = yield* Npm.Service
    // 挂载 "sdk" 钩子：在需要创建 SDK 实例时被调用（仅作用于 sap-ai-core 提供商）
    yield* ctx.aisdk.hook(
      "sdk",
      Effect.fn(function* (evt) {
        // 服务密钥优先取环境变量，其次取调用方选项里传入的字符串
        const serviceKey =
          process.env.AICORE_SERVICE_KEY ??
          (typeof evt.options.serviceKey === "string" ? evt.options.serviceKey : undefined)
        // 选项里传入的密钥回填到环境变量，供后续 SDK 使用
        if (serviceKey && !process.env.AICORE_SERVICE_KEY) process.env.AICORE_SERVICE_KEY = serviceKey

        // 加载（必要时安装）该包的提供商工厂函数
        const factory = yield* loadSDKFactory(npm, evt.package)
        // 工厂导出不可调用属于致命错误，直接终止
        if (typeof factory !== "function")
          return yield* Effect.die(new Error(`Package ${evt.package} provider factory export is not callable`))

        // 用配置（部署 ID、资源组）调用工厂，产出 SDK 实例挂回事件
        evt.sdk = factory(
          serviceKey
            ? { deploymentId: process.env.AICORE_DEPLOYMENT_ID, resourceGroup: process.env.AICORE_RESOURCE_GROUP }
            : {},
        )
      }),
      // 限定钩子只对 sap-ai-core 提供商生效
      { providerID: Provider.ID.make("sap-ai-core") },
    )
    // 挂载 "language" 钩子：由 SDK 实例创建具体的语言模型
    yield* ctx.aisdk.hook(
      "language",
      Effect.fn(function* (evt) {
        // 优先用模型的真实 API ID，缺失时用目录 ID 实例化语言模型
        evt.language = evt.sdk(evt.model.modelID ?? evt.model.id)
      }),
      // 限定钩子只对 sap-ai-core 提供商生效
      { providerID: Provider.ID.make("sap-ai-core") },
    )
  }),
})
