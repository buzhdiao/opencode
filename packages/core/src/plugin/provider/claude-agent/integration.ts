// 导出 ClaudeIntegration 命名空间，供其他模块引用本文件内容
export * as ClaudeIntegration from "./integration.js"

// 导入插件上下文类型
import type { Context } from "@opencode/plugin/effect/plugin"
// 从 effect 库导入 Effect、Stream 与 SubscriptionRef
import { Effect, Stream, SubscriptionRef } from "effect"
// 导入集成连接类型定义
import type { IntegrationConnection } from "../../../integration/connection.js"
// 导入供应商刷新工具
import { ProviderRefresh } from "../refresh.js"
// 导入探测模块（判断登录状态）
import { ClaudeProbe } from "./claude/probe.js"
// 导入状态类型
import type { ClaudeStatus } from "./claude/status.js"
// 导入 Claude Provider（集成 ID 等）
import { ClaudeProvider } from "./provider.js"

// 登录方法的 ID
export const METHOD_ID = "claude-login"

// 该登录方法只记录“用户选择了 Claude Code”这一事实。登录本身属于 `claude` 命令，插件永远拿不到 token
// （参见 specs/v2/claude-agent-provider.md 的 "Login" 章节）。
// The login method only records that the user chose Claude Code. The login itself belongs to `claude`, and the plugin
// never sees a token (specs/v2/claude-agent-provider.md, "Login").
export const register = Effect.fn("ClaudeIntegration.register")(function* (
  // 插件上下文
  ctx: Context,
  // Claude 状态机接口
  status: ClaudeStatus.Interface,
) {
  // 注册集成转换：设置集成名称与登录方法
  yield* ctx.integration.transform((editor) => {
    // 更新 claude 集成的显示名称
    editor.update(ClaudeProvider.ID, (integration) => {
      integration.name = "Claude Agent"
    })
    // 声明登录方法：外部类型，指向 claude 自带的登录命令
    editor.method.update({
      integrationID: ClaudeProvider.ID,
      method: { id: METHOD_ID, type: "external", label: "Claude Code login (claude auth login)" },
    })
  })

  // 订阅状态变化：把非“检查中”的状态同步为连接的问题（problem）标记
  yield* SubscriptionRef.changes(status.state).pipe(
    Stream.runForEach((state) =>
      Effect.gen(function* () {
        // “检查中”状态不产生任何标记
        if (state.type === "checking") return
        // 获取 claude 集成当前激活的连接
        const connection = yield* ctx.integration.connection.active(ClaudeProvider.ID)
        // 没有连接则无需上报状态
        if (!connection) return
        // 把状态转换为的问题标记写入连接状态
        yield* ctx.integration.connection.status({
          integrationID: ClaudeProvider.ID,
          connection,
          status: problem(state),
        })
      }),
    ),
    // 用独立 fiber 在后台运行该订阅
    Effect.forkScoped,
  )

  // 用户连接（切换凭据）时再次检查。opencode 按连接记录问题，新连接初始无问题，
  // 此时用户可能刚运行过 `claude auth login`。
  // Check again when the user connects. opencode keeps a problem per connection, so a new connection starts with
  // none, and the user may have just run `claude auth login`.
  yield* ProviderRefresh.onSwitch(ClaudeProvider.ID, status.refresh())
})

// 把状态转换为连接的问题标记（无问题时返回 undefined）
function problem(state: ClaudeStatus.State): IntegrationConnection.Status | undefined {
  // 未安装 claude：提示安装并登录
  if (state.type === "missing")
    return {
      status: "needs_auth",
      message: "Claude Code is not installed. Install it, then run `claude auth login`.",
      url: "https://code.claude.com/docs/en/setup",
    }
  // 失败状态：错误消息已经说明了 Claude Code 出了什么问题，直接使用
  // The message already says what went wrong with Claude Code.
  if (state.type === "failed") return { status: "needs_auth", message: state.message }
  // 就绪但探测结果显示未登录：提示登录
  if (state.type === "ready" && !ClaudeProbe.isLoggedIn(state.probe.account))
    return { status: "needs_auth", message: "Claude Code is not logged in. Run `claude auth login` in a terminal." }
  // 其余情况没有问题
  return undefined
}
