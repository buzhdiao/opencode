// 将本文件的所有导出聚合到命名空间 WellKnownPlugin 下，供统一引入
export * as WellKnownPlugin from "./plugin.js"

// 插件定义工具（define）
import { define } from "@opencode/plugin/effect/plugin"
// effect 库：Effect 编排、Stream 流处理
import { Effect, Stream } from "effect"
// Bus：事件总线服务
import { Bus } from "../bus.js"
// WellKnown：知名集成（.well-known 清单）服务
import { WellKnown } from "../wellknown.js"

// 插件定义：把 WellKnown 清单同步为集成与登录方法
export const Plugin = define({
  // 插件唯一标识
  id: "opencode.wellknown",
  // 插件主 effect
  effect: Effect.fn(function* (ctx) {
    // 获取事件总线服务
    const bus = yield* Bus.Service
    // 获取 WellKnown 服务
    const wellknown = yield* WellKnown.Service
    // 预热条目（拉取清单；失败则致命终止）
    yield* wellknown.entries().pipe(Effect.orDie)
    // 变更集成注册表：为带认证的清单注册集成与登录命令
    yield* ctx.integration.transform((editor) => {
      // 遍历当前快照中的每个条目
      wellknown.snapshot().forEach((entry) => {
        // 清单不含认证配置时跳过
        if (!entry.manifest.auth) return
        // 更新对应集成：名称改为来源主机名
        editor.update(entry.integrationID, (integration) => {
          // 用 origin 的 hostname 作为集成名
          integration.name = new URL(entry.origin).hostname
        })
        // 更新集成方法：注册 "login" 命令
        editor.method.update({
          // 目标集成 ID
          integrationID: entry.integrationID,
          // 方法定义
          method: {
            // 方法 ID：login
            id: "login",
            // 类型：命令
            type: "command",
            // 按钮文案
            label: "Log in",
            // 清单声明的登录命令
            command: [...entry.manifest.auth.command],
          },
        })
      })
    })
    // 订阅清单更新事件：每次更新触发集成注册表重载
    yield* bus.subscribe(WellKnown.Event.Updated).pipe(
      // 对每个事件执行重载
      Stream.runForEach(() => ctx.integration.reload()),
      // 以作用域内后台进程（fiber）立即启动
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})
