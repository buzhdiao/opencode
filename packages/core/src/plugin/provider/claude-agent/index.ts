// 导入插件定义工具 define（用于声明一个 Effect 插件）
import { define } from "@opencode/plugin/effect/plugin"
// 从 effect 库导入 Effect、Option（可选值）与 Stream（流）
import { Effect, Option, Stream } from "effect"
// 导入 Claude IO（对本地 claude 二进制进程的抽象）
import { ClaudeIO } from "./claude/io.js"
// 导入 Claude 会话管理模块
import { ClaudeSessions } from "./claude/sessions.js"
// 导入 Claude 状态检测模块
import { ClaudeStatus } from "./claude/status.js"
// 导入 AI SDK 桥接模块
import { ClaudeAISDK } from "./aisdk.js"
// 导入指令（系统提示）注册模块
import { ClaudeInstructions } from "./instructions.js"
// 导入集成（认证等）注册模块
import { ClaudeIntegration } from "./integration.js"
// 导入供应商（provider）注册模块
import { ClaudeProvider } from "./provider.js"
// 导入会话钩子注册模块
import { ClaudeSessionHooks } from "./session.js"
// 导入环境服务（用于判断能否启动本地进程）
import { Environment } from "../../../environment/index.js"
// 导入“环境不可用”实现
import { EnvironmentUnavailable } from "../../../environment/unavailable.js"
// 导入位置服务（工作区信息）
import { Location } from "../../../location.js"
// 导入插件内部类型定义
import type { PluginInternal } from "../../internal.js"

// 插件的唯一标识字符串
export const ID = "opencode.provider.claude-agent"

// 测试会传入伪造的 ClaudeIO。注册表（registry）定义在 setup 作用域之外，这样重载后可以接管既有进程。
// 重启测试会传入自己的注册表并在退出时关闭它，模拟 opencode 进程退出的行为。
// Tests pass a fake ClaudeIO here. The registry lives outside setup's scope, so a reload can adopt its processes.
// Restart tests pass their own and close it, as an exiting opencode would.
export const make = (io: ClaudeIO.Interface, registry = ClaudeSessions.registry()) =>
  define({
    // 插件唯一标识
    id: ID,
    // 插件主逻辑（Effect 生成器）
    effect: Effect.fn("ClaudeAgent.Plugin")(function* (ctx) {
      // Claude Agent 依赖本地的 claude 可执行文件，因此在无法启动本地进程的环境中应跳过该插件
      // Claude Agent runs the local `claude` binary, so skip it where opencode cannot start local processes.
      const environment = yield* Effect.serviceOption(Environment.Service)
      // 获取位置服务（可能不存在）
      const location = yield* Effect.serviceOption(Location.Service)
      // 若位置服务存在且工作区 ID 未定义（如远程环境），则不启用本插件
      if (Option.isSome(location) && location.value.workspaceID !== undefined) return
      // 若环境服务的 spawner 是“不可用”实现，同样跳过
      if (Option.isSome(environment) && environment.value.spawner === EnvironmentUnavailable.spawner) return

      // 创建 Claude 状态机（检查 claude 是否安装、是否已登录）；连接信息回调指向 provider 的连接状态
      const status = yield* ClaudeStatus.make(io, () => ClaudeProvider.connection(ctx))
      // 把注册表与 IO、状态、存储、目录绑定，附着到当前上下文
      const sessions = yield* registry.attach({ io, status, storage: ctx.storage, directory: ctx.location.directory })
      // 订阅会话执行结束相关事件（成功/失败/被中断）
      yield* ctx.event
        .subscribe({
          types: ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"],
        })
        .pipe(
          // 对每个事件：把对应会话标记为空闲（以便回收/复用其 Claude 进程）
          Stream.runForEach((event) => sessions.idle(event.data.sessionID)),
          // 用独立的 fiber 立即启动该订阅，不阻塞插件初始化
          Effect.forkScoped({ startImmediately: true }),
        )
      // 注册供应商（model/provider 配置转换）
      yield* ClaudeProvider.register(ctx, status, io)
      // 注册集成（登录凭据等）
      yield* ClaudeIntegration.register(ctx, status)
      // 注册 AI SDK 桥接（让 OpenCode 模型请求走 Claude Agent）
      yield* ClaudeAISDK.register(ctx, sessions)
      // 注册会话钩子
      yield* ClaudeSessionHooks.register(ctx)
      // 注册指令/系统提示转换
      yield* ClaudeInstructions.register(ctx)
    }),
  } satisfies PluginInternal.InternalPlugin)

// 默认导出的插件实例：使用真实的 ClaudeIO 与默认注册表
export const ClaudeAgentPlugin = make(ClaudeIO.real)
