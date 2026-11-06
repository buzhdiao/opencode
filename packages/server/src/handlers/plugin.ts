// 引入插件（Plugin）核心服务：插件列表与 GUI 包
import { Plugin } from "@opencode/core/plugin"
// 引入插件更新（PluginUpdate）服务：检查与更新插件包
import { PluginUpdate } from "@opencode/core/plugin/update"
// 引入协议层错误：无效请求、插件未找到、服务不可用
import { InvalidRequestError, PluginNotFoundError, ServiceUnavailableError } from "@opencode/protocol/errors"
// 引入 Cause（错误原因）、Effect 与 Exit（结果封装）
import { Cause, Effect, Exit } from "effect"
// 引入 HTTP API 构建器
import { HttpApiBuilder } from "effect/http-api"
// 引入本服务 API 定义
import { Api } from "../api"
// 引入 response 辅助：响应中附带 location 信息
import { response } from "../location"

// 导出 PluginHandler：注册 "server.plugin" 分组处理器
export const PluginHandler = HttpApiBuilder.group(Api, "server.plugin", (handlers) =>
  // 处理 plugin.list：列出全部插件
  handlers
    .handle("plugin.list", () =>
      Effect.gen(function* () {
        // 在插件服务上下文中执行列表查询；响应附带 location 信息
        return yield* response(Plugin.Service.use((plugin) => plugin.list()))
      }),
    )
    // 处理 plugin.gui：返回插件附带的前端（./gui-experimental）包
    .handle("plugin.gui", (ctx) =>
      Effect.gen(function* () {
        // 获取插件服务
        const plugins = yield* Plugin.Service
        // 按插件 ID 获取其 GUI 包
        const bundle = yield* plugins.gui(ctx.query.id)
        // 没有该插件或其没有 GUI 包：返回插件未找到错误
        if (!bundle)
          return yield* new PluginNotFoundError({
            pluginID: ctx.query.id,
            message: `No active plugin with a ./gui-experimental bundle: ${ctx.query.id}`,
          })
        // 经 response 包装返回包内容
        return yield* response(Effect.succeed(bundle))
      }),
    )
    // 处理 plugin.check：检查插件包是否有过新版本（可指定单个目标）
    .handle("plugin.check", (ctx) =>
      Effect.gen(function* () {
        // 获取插件服务
        const plugins = yield* Plugin.Service
        // 读取当前插件清单（inventory）
        const inventory = yield* plugins.list()
        // 收集清单中所有“包来源”插件的目标（target，如 npm 包名）并去重
        const targets = [
          ...new Set(inventory.flatMap((plugin) => (plugin.source.type === "package" ? [plugin.source.target] : []))),
          // 若请求指定了 target，则只保留该目标
        ].filter((target) => ctx.payload.target === undefined || target === ctx.payload.target)
        // 指定的 target 不在当前清单中：返回无效请求错误
        if (ctx.payload.target !== undefined && !targets.length)
          return yield* new InvalidRequestError({
            message: `Plugin package is not in the current server inventory: ${ctx.payload.target}`,
            field: "target",
          })
        // 获取插件更新服务
        const updates = yield* PluginUpdate.Service
        // 并发检查每个目标的最新版本（refresh 强制绕过缓存），构造“目标 -> 版本信息”映射
        const outdated = new Map(
          yield* Effect.forEach(
            targets,
            (target) => updates.check(target, { refresh: true }).pipe(Effect.map((value) => [target, value] as const)),
            { concurrency: "unbounded" },
          ),
        )
        return yield* response(
          Effect.succeed(
            // 把检查结果合并回清单：包来源且有检查结果的插件附加 outdated/updating 标记
            inventory.map((plugin) => {
              // 非包来源或该目标没有检查结果的原样返回
              if (plugin.source.type !== "package" || !outdated.has(plugin.source.target)) return plugin
              return {
                ...plugin,
                source: {
                  type: "package" as const,
                  target: plugin.source.target,
                  // 保留原版本号（若有）
                  ...(plugin.source.version ? { version: plugin.source.version } : {}),
                  // 有新版本时标记 outdated
                  ...(outdated.get(plugin.source.target) ? { outdated: true as const } : {}),
                  // 正在更新时标记 updating
                  ...(plugin.source.updating ? { updating: true as const } : {}),
                },
              }
            }),
          ),
        )
      }),
    )
    // 处理 plugin.update：更新指定的插件包（可多个）
    .handle("plugin.update", (ctx) =>
      Effect.gen(function* () {
        // 获取插件服务
        const plugins = yield* Plugin.Service
        // 构造当前清单中包来源目标的集合
        const inventory = new Set(
          (yield* plugins.list()).flatMap((plugin) => (plugin.source.type === "package" ? [plugin.source.target] : [])),
        )
        // 找出请求中不在清单内的目标
        const unknown = ctx.payload.targets.filter((target) => !inventory.has(target))
        // 存在未知目标：返回无效请求错误（列出全部未知项）
        if (unknown.length)
          return yield* new InvalidRequestError({
            message: `Plugin packages are not in the current server inventory: ${unknown.join(", ")}`,
            field: "targets",
          })
        // 获取插件更新服务
        const updates = yield* PluginUpdate.Service
        // Let every update run to completion instead of interrupting the rest on the first failure.
        // 并发执行所有更新：每个更新用 Effect.exit 捕获结果，失败也不中断其余更新
        const failures = yield* Effect.forEach(
          ctx.payload.targets,
          (target) =>
            updates.update(target).pipe(
              // 把成功/失败封装为 Exit
              Effect.exit,
              // 失败时收集“目标: 原因”字符串，成功返回空数组
              Effect.map((exit) => (Exit.isFailure(exit) ? [`${target}: ${Cause.pretty(exit.cause)}`] : [])),
            ),
          { concurrency: "unbounded" },
        ).pipe(Effect.map((results) => results.flat()))
        // 存在任何失败：返回服务不可用错误（汇总全部失败原因）
        if (failures.length)
          return yield* new ServiceUnavailableError({
            message: `Failed to update plugin packages: ${failures.join("; ")}`,
            service: "plugin",
          })
      }),
    ),
)
