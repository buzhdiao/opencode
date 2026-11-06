// 以命名空间形式整体再导出本模块
export * as McpCodeModeDefaultsPlugin from "./mcp-codemode-defaults.js"

// define：插件定义辅助函数
import { define } from "@opencode/plugin/effect/plugin"
// Effect：函数式效果运行时
import { Effect } from "effect"

// Defaults that make known MCP servers work well with OpenCode Code Mode, so a server's own Code Mode never ends up
// nested inside OpenCode's. A server with `codemode` set in config is left exactly as configured.

// These servers are Code Mode themselves, so OpenCode Code Mode is turned off for them (`codemode: false`).
// 这类服务端本身就是 Code Mode（代码模式）执行器，需为它们关闭 OpenCode 自身的 Code Mode（codemode: false），
// 避免出现"代码模式套代码模式"的嵌套；URL 形如 https://executor.sh/<org>/mcp
const urls = [/^https:\/\/executor\.sh\/[^/]+\/mcp$/]

// PostHog wraps all of its tools in one server-side Code Mode tool unless the client asks for "tools" mode, so OpenCode
// Code Mode stays on and PostHog's is turned off. PostHog also reads `?mode=`, but the header wins over it and leaves
// the URL, which stored credentials are keyed by, unchanged.
// PostHog 的 MCP 主机名匹配规则（mcp.posthog.com / mcp-eu / mcp.us / mcp.eu 等）
const posthog = /^mcp(?:-eu|\.us|\.eu)?\.posthog\.com$/
// PostHog 用于声明 MCP 工具模式的自定义请求头
const mode = "x-posthog-mcp-mode"

// 定义 MCP Code Mode 默认值插件
export const Plugin = define({
  // 插件唯一标识
  id: "opencode.mcp.codemode.defaults",
  // 插件激活时执行的生成器主体
  effect: Effect.fn(function* (ctx) {
    // 通过 transform 编辑器遍历并修改全部 MCP 服务器配置
    yield* ctx.mcp.transform((editor) => {
      // 逐个检查每台服务器（name, server 键值对）
      for (const [, server] of editor.list()) {
        // 用户已显式配置 codemode 的服务器保持原样，不做任何默认调整
        if (server.codemode !== undefined) continue
        // 本地（stdio）类型的服务器按命令行判断
        if (server.type === "local") {
          // executor mcp 命令本身就是 Code Mode 执行器：关闭 OpenCode 的 Code Mode
          if (server.command[0] === "executor" && server.command[1] === "mcp") server.codemode = false
          // 本地服务器不走 URL/请求头逻辑，直接继续
          continue
        }
        // 远程服务器 URL 无法解析时跳过（防御性检查）
        if (!URL.canParse(server.url)) continue
        // 解析出可操作的 URL 对象
        const url = new URL(server.url)
        // 计算规范化的端点（origin + 去掉末尾斜杠的路径），用于模式匹配
        const endpoint = `${url.origin}${url.pathname.replace(/\/+$/, "")}`
        // 命中 Code Mode 执行器端点列表则关闭 OpenCode 的 Code Mode
        if (urls.some((pattern) => pattern.test(endpoint))) server.codemode = false
        // PostHog 专属处理：主机名匹配、URL 未带 mode 查询参数、请求头里也没有模式声明
        if (
          posthog.test(url.hostname) &&
          !url.searchParams.has("mode") &&
          !Object.keys(server.headers ?? {}).some((key) => key.toLowerCase() === mode)
        )
          // 追加 x-posthog-mcp-mode: tools 请求头，要求 PostHog 返回原始工具列表
          server.headers = { ...server.headers, [mode]: "tools" }
      }
    })
  }),
})
