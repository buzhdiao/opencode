// 配置格式化器插件（Config Formatter Plugin）：把配置中的 formatter 设置应用到格式化器服务。
export * as ConfigFormatterPlugin from "./formatter.js"

// 导入插件定义工具。
import { define } from "@opencode/plugin/effect/plugin"
// 导入配置条目（Entry）类型。
import type { Entry } from "@opencode/schema/config"
// 导入格式化器配置类型。
import type { ConfigFormatter } from "@opencode/schema/config/formatter"
// 导入文件系统工具服务。
import { FSUtil } from "@opencode/util/fs-util"
// 导入全局目录服务。
import { Global } from "@opencode/util/global"
// 导入 Npm 服务。
import { Npm } from "@opencode/util/npm"
// 导入应用进程服务。
import { AppProcess } from "@opencode/util/process"
// 导入 Effect。
import { Effect } from "effect"
// 导入配置服务。
import { Config } from "../../config.js"
// 导入格式化器服务。
import { Formatter } from "../../formatter.js"
// 导入内建格式化器工厂与信息类型。
import { make, type Info } from "../../formatter/builtins.js"
// 导入位置服务。
import { Location } from "../../location.js"
// 导入配置条目观察器。
import { ConfigEntryObserver } from "./entry-observer.js"

// 定义插件。
export const Plugin = define({
  // 插件 ID。
  id: "opencode.config.formatter",
  // 插件主流程。
  effect: Effect.fn(function* (ctx) {
    // 获取配置服务。
    const config = yield* Config.Service
    // 获取格式化器服务。
    const formatter = yield* Formatter.Service
    // 获取文件系统工具服务。
    const fs = yield* FSUtil.Service
    // 获取全局目录服务。
    const global = yield* Global.Service
    // 获取位置服务。
    const location = yield* Location.Service
    // 获取 Npm 服务。
    const npm = yield* Npm.Service
    // 获取应用进程服务。
    const processes = yield* AppProcess.Service
    // 观察配置：更新时触发格式化器重载。
    const loaded = yield* ConfigEntryObserver.observe(config, ctx.event, formatter.reload())

    // 应用格式化器配置。
    yield* formatter.transform((editor) => {
      // 归并所有文档后的 formatter 配置。
      const configured = resolve(loaded.entries)
      // 没有任何配置则不动。
      if (!configured) return
      // 构造内建格式化器集合。
      const builtIns = make({
        directory: location.directory,
        worktree: location.project.directory,
        fs,
        npm,
        processes,
        bin: global.bin,
      })
      // 先注册全部内建格式化器。
      builtIns.forEach(editor.set)
      // 配置为 true（仅整体启用）时到此为止。
      if (configured === true) return

      // 遍历每个命名条目并覆盖。
      for (const [name, entry] of Object.entries(configured)) {
        // 标记 disabled 的条目移除。
        if (entry.disabled) {
          editor.remove(name)
          continue
        }
        // 同名的内建格式化器。
        const builtIn = builtIns.find((formatter) => formatter.name === name)
        // 合并出最终条目。
        const current: Info = {
          name,
          // 扩展名：条目指定优先，其次内建，最后为空。
          extensions: entry.extensions ?? builtIn?.extensions ?? [],
          // 环境变量：内建与条目合并，条目优先。
          environment: { ...builtIn?.environment, ...entry.environment },
          // 启用状态：有内建且未给命令时沿用内建；否则按配置的命令数组（无命令即禁用）。
          enabled:
            builtIn && !entry.command ? builtIn.enabled : Effect.succeed(entry.command ? [...entry.command] : false),
        }
        // 写入编辑器。
        editor.set(current)
      }
    })
  }),
})

// Documents apply from lowest to highest priority. A boolean resets everything before it; an object
// merges each named formatter's supplied fields over the same name from earlier objects.
// 文档按从低到高的优先级应用。布尔值直接重置此前的一切；对象则把每个命名格式化器的字段合并到之前同名条目之上。
function resolve(entries: readonly Entry[]) {
  return entries.reduce<boolean | Record<string, ConfigFormatter.Entry> | undefined>((result, entry) => {
    // 只处理带 formatter 设置的文档。
    if (entry.type !== "document" || entry.info.formatter === undefined) return result
    // 布尔配置直接作为新结果。
    if (typeof entry.info.formatter === "boolean") return entry.info.formatter
    // 对象配置：逐名合并到既有对象之上（此前是布尔或无配置时以空对象起步）。
    return Object.entries(entry.info.formatter).reduce(
      (merged, [name, item]) => ({
        ...merged,
        [name]: { ...merged[name], ...item, environment: { ...merged[name]?.environment, ...item.environment } },
      }),
      typeof result === "object" ? result : {},
    )
  }, undefined)
}
