// 从 effect 库导入 Effect
import { Effect } from "effect"
// 导入 Npm 服务接口类型（用于安装依赖）
import { Npm } from "@opencode/util/npm"
// 导入运行时动态导入与模块路径解析工具
import { importModule, resolveModule } from "@opencode/util/runtime-import"

// loadSDKFactory：安装（或定位）指定的提供商包并返回其工厂函数导出
export const loadSDKFactory = Effect.fnUntraced(function* (npm: Npm.Interface, packageName: string) {
  // file:// 开头的包名视为本地路径，直接使用；否则先安装再解析出模块入口路径
  const installedPath = packageName.startsWith("file://")
    ? packageName
    : yield* npm.add(installSpec(packageName)).pipe(
        // 安装失败属于致命错误，直接终止
        Effect.orDie,
        // 根据安装结果的包名与目录解析出可导入的模块路径
        Effect.map((installed) => resolveModule(installed.name, installed.directory)),
      )

  // 动态导入模块并断言为键值对象
  const mod = (yield* Effect.promise(() => importModule(installedPath))) as Record<string, unknown>
  // 查找第一个以 "create" 开头的导出，即提供商工厂函数
  const match = Object.keys(mod).find((name) => name.startsWith("create"))
  // 找不到工厂导出属于致命错误
  if (!match) return yield* Effect.die(new Error(`Package ${packageName} has no provider factory export`))
  // 返回工厂函数本身
  return mod[match]
})

// The AI SDK bridge only supports AI SDK v6 providers. Official `@ai-sdk/*` packages now publish AI SDK v7 under
// `latest` and keep the v6 line under the `ai-v6` dist-tag, so an unversioned official package installs that tag.
// An explicit version, range, or tag is installed as written.
// AI SDK 桥只支持 v6 提供商。官方 @ai-sdk/* 包在 latest 标签发布 v7，v6 系列挂在 ai-v6
// dist-tag 上，因此未带版本的官方包按该标签安装；显式的版本/范围/标签则原样安装。
function installSpec(packageName: string) {
  // 官方 @ai-sdk/ 顶层包追加 @ai-v6 标签，其余包名原样返回
  return /^@ai-sdk\/[^/@]+$/.test(packageName) ? `${packageName}@ai-v6` : packageName
}
