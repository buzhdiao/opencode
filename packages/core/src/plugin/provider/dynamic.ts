// 从 effect 库导入 Effect 组合子
import { Effect } from "effect"
// 导入插件定义工具 define（用于声明一个 Effect 插件）
import { define } from "@opencode/plugin/effect/plugin"
// 导入 Npm 服务（用于动态加载 npm 包）
import { Npm } from "@opencode/util/npm"
// 导入 SDK 工厂加载器（按包名加载 AI SDK 的工厂函数）
import { loadSDKFactory } from "./sdk-factory.js"

// 定义动态供应商插件：在运行时按需加载用户指定 npm 包里的 AI SDK
export const DynamicProviderPlugin = define({
  // 插件唯一标识
  id: "opencode.provider.dynamic",
  // 插件主逻辑（Effect 生成器）
  effect: Effect.fn(function* (ctx) {
    // 获取 Npm 服务实例
    const npm = yield* Npm.Service
    // 向 AI SDK 子系统注册 "sdk" 阶段的钩子
    yield* ctx.aisdk.hook(
      "sdk",
      // 钩子回调：当需要 SDK 而尚未提供时，动态加载
      Effect.fn(function* (evt) {
        // 如果事件里已经带了 sdk 实例，则无需再做任何事
        if (evt.sdk) return

        // 按事件中指定的包名加载 SDK 工厂，再用选项调用它，生成 sdk 实例并回填到事件上
        evt.sdk = ((yield* loadSDKFactory(npm, evt.package)) as (options: any) => any)(evt.options)
      }),
    )
  }),
})
