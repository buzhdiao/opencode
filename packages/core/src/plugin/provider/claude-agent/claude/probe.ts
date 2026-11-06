// 以命名空间形式整体再导出本模块
export * as ClaudeProbe from "./probe.js"

// SDK 类型：账户信息、模型信息、选项、查询会话
import type { AccountInfo, ModelInfo, Options, Query } from "@anthropic-ai/claude-agent-sdk"
// Effect/Schema：效果运行时与 Schema
import { Effect, Schema } from "effect"
// ClaudeSDK：SDK 惰性加载器
import { ClaudeSDK } from "./sdk.js"

// Model：探测得到的模型信息（扩展了上下文窗口字段）
export interface Model extends ModelInfo {
  // 模型上下文窗口（可选，旧版本探测不到）
  contextWindow?: number
}

// Result：探测结果
export interface Result {
  // Claude Code 版本（可能缺失）
  readonly version: string | undefined
  // 账户信息
  readonly account: AccountInfo
  // 模型列表
  readonly models: readonly Model[]
}

// ProbeError：探测失败的带标签错误
export class ProbeError extends Schema.TaggedError<ProbeError>()("ClaudeProbe.ProbeError", {
  // 原始缺陷
  cause: Schema.Defect(),
}) {}

// Older binaries silently ignore verbatimPrompts and can interpret user text as Claude commands.
// 可用版本下限：更旧的二进制会静默忽略 verbatimPrompts，把用户文本误当 Claude 命令。
const MINIMUM_VERSION = "2.1.248"
// Older binaries do not support summary-only context usage. Their models keep the conservative fallback.
// 支持摘要式上下文查询的版本下限；更旧版本的模型保持保守回退值。
const CONTEXT_DISCOVERY_VERSION = "2.1.257"

// versionError：版本过低（或未知）时构造错误；版本足够则返回 undefined
export function versionError(version: string | undefined) {
  // 版本已知且达标则通过
  if (version && atLeast(version, MINIMUM_VERSION)) return
  // 组装错误信息
  const message = version
    // 有版本号：给出要求版本
    ? `Claude Code ${version} is too old; ${MINIMUM_VERSION} or later is required.`
    // 无版本号：说明无法确认兼容性
    : "Claude Code did not report its version, so compatibility could not be checked."
  // 返回带更新提示的错误
  return new Error(`${message} Run \`claude update\`.`)
}

// Compares release numbers like 2.1.248. A pre-release or build suffix is ignored.
// atLeast：按发布号逐段比较版本（忽略预发布/构建后缀）。
function atLeast(version: string, minimum: string) {
  // 解析函数：去掉 -/+ 后缀后按点分数字
  const parse = (value: string) => value.split(/[-+]/)[0].split(".").map(Number)
  // 当前版本各段
  const current = parse(version)
  // 要求版本各段
  const required = parse(minimum)
  // 找到第一个不同的段
  const index = required.findIndex((part, position) => (current[position] ?? 0) !== part)
  // 全部相同或当前段更大即为达标
  return index === -1 || (current[index] ?? 0) > required[index]
}

// The input never sends a message, so no model call is made and no tokens are used.
// run：启动一次"探测"会话：不发消息、不调用模型、不消耗令牌，仅获取版本/账户/模型信息。
export const run = Effect.fn("ClaudeProbe.run")(function* (options: Options) {
  // 创建可手动 resolve 的停止信号
  const stop = Promise.withResolvers<void>()
  // 以获取-使用-释放模式管理会话生命周期
  return yield* Effect.acquireUseRelease(
    // 获取：启动查询会话
    Effect.tryPromise({
      // 启动逻辑
      try: async () => {
        // 加载 SDK
        const { query } = await ClaudeSDK.load()
        // 以"等待停止信号"作为输入流：永不发送真实消息；不持久化会话
        return query({ prompt: waitFor(stop.promise), options: { ...options, persistSession: false } })
      },
      // 失败转 ProbeError
      catch: (cause) => new ProbeError({ cause }),
    }),
    // 使用：读取初始化结果
    (session) =>
      // 组织逻辑
      Effect.gen(function* () {
        // 等待初始化结果（30 秒超时）
        const init = yield* Effect.tryPromise({
          // 读取初始化结果
          try: () => session.initializationResult(),
          // 失败转 ProbeError
          catch: (cause) => new ProbeError({ cause }),
        }).pipe(
          // 超时处理
          Effect.timeoutOrElse({
            // 30 秒
            duration: "30 seconds",
            // 超时报错
            orElse: () => Effect.fail(new ProbeError({ cause: new Error("claude did not start within 30 seconds") })),
          }),
        )
        // No prompt is sent here, so an old Claude Code can still list its models.
        // The version is checked when a chat starts, and that chat's error tells the user to update.
        // 此处不发送提示，旧版本也能列出模型；版本检查推迟到聊天开始时，由该次错误提示升级。
        const version = init.claude_code_version
        // 复制模型列表
        const models: Model[] = init.models.map((model) => ({ ...model }))
        // 版本支持时进一步探测各模型的上下文窗口
        if (version && atLeast(version, CONTEXT_DISCOVERY_VERSION)) yield* discoverContext(session, models)
        // 返回探测结果
        return { version, account: init.account, models } satisfies Result
      }),
    // 释放：解除停止信号并关闭会话
    (session) =>
      // 同步清理
      Effect.sync(() => {
        // 触发停止信号，结束输入流
        stop.resolve()
        // 关闭会话
        session.close()
      }),
  )
})

// Sets each model's context window in place, so models discovered before a timeout keep theirs.
// discoverContext：逐个模型查询上下文窗口并就地写回；超时前已探测的保留。
const discoverContext = Effect.fn("ClaudeProbe.discoverContext")(
  // 主体：遍历模型
  function* (session: Query, models: readonly Model[]) {
    // 逐个处理
    for (const model of models) {
      // 跳过 default 模型
      if (model.value === "default") continue
      // 单模型探测（失败仅告警）
      yield* Effect.tryPromise(async () => {
        // 切换当前模型
        await session.setModel(model.value)
        // 查询摘要式上下文用量
        const usage = await session.getContextUsage({ detail: "summary" })
        // rawMaxTokens is capacity; maxTokens can reflect Claude's own compaction window.
        // rawMaxTokens 才是真实容量；maxTokens 可能反映 Claude 自身的压缩窗口。
        if (!Number.isSafeInteger(usage.rawMaxTokens) || usage.rawMaxTokens <= 0) {
          // 无有效容量时报错
          throw new Error("Claude Code did not report a valid context window")
        }
        // 写回模型上下文窗口
        model.contextWindow = usage.rawMaxTokens
      }).pipe(
        // 失败仅记录警告，保留其余模型
        Effect.catch((error) =>
          Effect.logWarning("Claude Code context discovery failed", {
            // 出错的模型
            model: model.value,
            // 原因
            cause: error.cause,
          }),
        ),
      )
    }
  },
  // 整体超时保护
  Effect.timeoutOrElse({
    // 30 秒
    duration: "30 seconds",
    // A stuck control must not become a login failure. Closing this query cancels the pending request.
    // 卡住的控制请求不能演变为登录失败；关闭查询即取消挂起请求。
    orElse: () =>
      Effect.logWarning("Claude Code context discovery timed out; undiscovered models use conservative limits"),
  }),
)

// isLoggedIn：依据账户信息判断是否已登录
export function isLoggedIn(account: AccountInfo) {
  // 有令牌来源或配置了 API key 即视为已登录
  return account.tokenSource !== "none" || account.apiKeySource !== undefined
}

// waitFor：以异步生成器实现"永不产出、只等停止信号"的输入流
async function* waitFor(done: Promise<void>): AsyncGenerator<never> {
  // 等待停止信号后即结束
  await done
}
