// 配置 MCP 插件（Config MCP Plugin）：把配置中的 MCP 服务器注册到 MCP 服务。
export * as ConfigMcpPlugin from "./mcp.js"

// 导入插件定义工具。
import { define } from "@opencode/plugin/effect/plugin"
import { Document, type Entry } from "@opencode/schema/config"
import type { ServerConfig } from "@opencode/schema/mcp"
// 导入 Effect 与流工具。
import { Effect, Stream } from "effect"
// 导入配置服务。
import { Config } from "../../config.js"
// 导入 MCP 服务。
import { Mcp } from "../../mcp/index.js"

// 定义插件。
export const Plugin = define({
  // 插件 ID。
  id: "opencode.config.mcp",
  // 插件主流程：订阅配置更新事件并进入注册逻辑。
  effect: Effect.fn(function* (ctx) {
    yield* register(ctx.event.subscribe({ types: ["config.updated"] }))
  }),
})

// 注册逻辑：监听事件流，在配置更新时重载 MCP 并应用初始配置。
export const register = Effect.fn("ConfigMCPPlugin.register")(function* (
  events: Stream.Stream<{ readonly type: string }, unknown>,
) {
  // 获取配置服务。
  const config = yield* Config.Service
  // 获取 MCP 服务。
  const mcp = yield* Mcp.Service
  const loaded = { entries: [] as Entry[] }

  // 过滤出 config.updated 事件。
  yield* events.pipe(
    Stream.filter((event) => event.type === "config.updated"),
    // 每次事件触发 MCP 重载（失败记错误日志）。
    Stream.runForEach(() =>
      config.entries().pipe(
        Effect.tap((entries) => Effect.sync(() => (loaded.entries = entries))),
        Effect.andThen(mcp.reload()),
        Effect.catchCause((cause) => Effect.logError("failed to reload MCP config", { cause })),
      ),
    ),
    // 忽略整个流的错误。
    Effect.ignore,
    // 在后台 fiber 上立即启动。
    Effect.forkScoped({ startImmediately: true }),
  )

  // Subscribe before the initial load so updates racing it trigger a rebuild.
  loaded.entries = yield* config.entries()
  yield* mcp.transform((editor) => {
    const documents = loaded.entries.filter((entry): entry is Document => entry.type === "document")
    // Global timeout defaults merge in config order; each server can override them.
    // 按配置顺序合并各文档的全局超时默认值；每台服务器可再覆盖。
    const timeout = Object.assign(
      {},
      ...documents.flatMap((entry) => (entry.info.mcp?.timeout ? [entry.info.mcp.timeout] : [])),
    )
    // 服务器映射（按文档顺序写入，后者覆盖前者）。
    const servers = new Map<string, ServerConfig>()
    // 遍历每份文档的服务器定义。
    for (const document of documents) {
      for (const [name, server] of Object.entries(document.info.mcp?.servers ?? {})) {
        servers.set(name, server)
      }
    }
    // 注册尚未存在的服务器：全局超时与服务器自身超时合并。
    for (const [name, server] of servers) {
      // 已存在的服务器不覆盖。
      if (editor.get(name)) continue
      editor.set(name, { ...server, timeout: { ...timeout, ...server.timeout } })
    }
  })
})
