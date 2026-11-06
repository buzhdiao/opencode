// 将本模块以命名空间形式整体导出为 SessionShell
export * as SessionShell from "./shell.js"

// 会话信息类型
import type { Session } from "@opencode/schema/session"
// effect：Effect 运行时
import { Effect } from "effect"
// 实例服务：为会话所在实例提供依赖
import { Instance } from "../instance/service.js"
// 插件服务：等待插件激活
import { Plugin } from "../plugin/service.js"
// Shell 服务：创建与管理后台 shell
import { Shell } from "../shell.js"
// Shell 结果类型与不可用占位值
import { ShellResult } from "../shell/result.js"

// 为会话启动一个后台 shell：在会话目录执行命令，返回 shell 信息与结果/输出读取器
export const start = Effect.fn("SessionShell.start")(function* (input: { session: Session.Info; command: string }) {
  // 获取实例服务
  const instances = yield* Instance.Service
  // 等待插件激活后取得 Shell 服务，并以会话所在实例提供依赖
  const shell = yield* Plugin.awaitActivation.pipe(Effect.andThen(Shell.Service), instances.provide(input.session))
  // 创建 shell：工作目录为会话目录，timeout=0 表示不设超时，元数据标记会话与后台属性
  const info = yield* shell.create({
    command: input.command,
    cwd: input.session.location.directory,
    timeout: 0,
    metadata: { sessionID: input.session.id, background: true },
  })
  // Keep completion tied to the original shell even if the Session moves.
  // 把完成结果绑定到原 shell，即使会话（Session）之后移动也不受影响
  return {
    // shell 基本信息
    info,
    // 结束结果：等待 shell 退出
    result: shell.result(info),
    // 输出读取：最多取 1 MB；shell 已不存在时回退为「不可用」占位
    output: shell
      .output(info.id, { limit: 1024 * 1024 })
      .pipe(Effect.catchTag("Shell.NotFoundError", () => Effect.succeed(ShellResult.unavailable))),
  }
})
