// 以命名空间形式整体再导出本模块
export * as ClaudeSDK from "./sdk.js"

// SDK 类型（仅类型，运行时按需动态加载）
import type * as SDK from "@anthropic-ai/claude-agent-sdk"

// Loaded on first use, so opencode starts without loading the SDK.
// 惰性加载：首次使用才 import SDK，保证 opencode 启动时不加载它。
let sdk: Promise<typeof SDK> | undefined

// load：获取 SDK 模块（带失败重试语义）
export function load() {
  // 未加载过则发起动态导入
  sdk ??= import("#claude-agent-sdk").catch((cause) => {
    // Let the next request try again, for example after the SDK is installed.
    // 失败时清空缓存，让下一次请求（例如 SDK 安装后）可以重试。
    sdk = undefined
    // 抛出带指引的错误
    throw new Error("Claude Agent SDK isn't installed. Install @anthropic-ai/claude-agent-sdk to use Claude Agent.", {
      cause,
    })
  })
  // 返回缓存的加载 Promise
  return sdk
}
