// 以命名空间形式整体再导出本模块
export * as ClaudeIO from "./io.js"

// Options：Claude Agent SDK 的选项类型（用于 spawn 字段）
import type { Options } from "@anthropic-ai/claude-agent-sdk"
// which：PATH 查找工具
import { which } from "../../../../util/which.js"
// ClaudeFork：会话分叉实现
import { ClaudeFork } from "./fork.js"
// ClaudeSDK：SDK 惰性加载器
import { ClaudeSDK } from "./sdk.js"

// Everything that reaches outside opencode. Tests swap it for a fake `claude`.
// Interface：所有对外部环境（进程/文件系统/SDK）的访问接口，便于测试替换。
export interface Interface {
  // Undefined uses the SDK's own spawn
  // spawn：自定义 claude 进程启动器；未定义时使用 SDK 自带的 spawn
  readonly spawn?: Options["spawnClaudeCodeProcess"]
  // which：查找 claude 可执行文件路径
  readonly which: () => string | undefined
  // Before our isolation settings
  // env：返回基础进程环境（在隔离设置覆盖之前）
  readonly env: () => Record<string, string | undefined>
  // sessionExists：判断指定会话是否存在
  readonly sessionExists: (sessionID: string) => Promise<boolean>
  // fork：从指定消息处分叉会话
  readonly fork: (sessionID: string, messageID: string) => Promise<ClaudeFork.Result | undefined>
  // remove：删除会话
  readonly remove: (sessionID: string) => Promise<void>
}

// real：生产环境的真实实现
export const real: Interface = {
  // 查找 claude：优先环境变量指定的路径，其次 PATH
  which: () => process.env.OPENCODE_CLAUDE_PATH || which("claude") || undefined,
  // 返回当前进程环境
  env: () => process.env,
  // 会话存在性检查：借助 SDK 的 getSessionInfo
  sessionExists: async (sessionID) => {
    // 加载 SDK
    const { getSessionInfo } = await ClaudeSDK.load()
    // 会话信息非 undefined 即存在
    return (await getSessionInfo(sessionID)) !== undefined
  },
  // 分叉委托给 ClaudeFork.create
  fork: ClaudeFork.create,
  // 删除会话：借助 SDK 的 deleteSession
  remove: async (sessionID) => {
    // 加载 SDK
    const { deleteSession } = await ClaudeSDK.load()
    // 执行删除
    await deleteSession(sessionID)
  },
}
