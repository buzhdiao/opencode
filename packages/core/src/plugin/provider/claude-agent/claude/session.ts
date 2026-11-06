// 导出 ClaudeSession 命名空间，供其他模块引用本文件内容
export * as ClaudeSession from "./session.js"

// 导入 AI SDK 的函数工具类型
import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider"
// 导入 Claude Agent SDK 的选项与消息类型
import type { Options, SDKMessage, SDKResultMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
// 导入工具名转换工具
import { ToolNames } from "../tools/names.js"
// 导入探测模块（版本检查等）
import { ClaudeProbe } from "./probe.js"
// 导入 SDK 加载器
import { ClaudeSDK } from "./sdk.js"

// 一轮对话（Turn）：消息缓冲 + 排空（drain）Promise + 唤醒回调 + 结束标记
interface Turn {
  // 该轮消息全部送达后的解析器（等待排空完成）
  readonly drained: PromiseWithResolvers<void>
  // 该轮累积的 SDK 消息
  readonly messages: SDKMessage[]
  // 可选的唤醒回调（readStep 等待消息时挂起）
  wake?: () => void
  // 该轮是否已结束
  finished: boolean
}

// 会话接口类型：由 start 的返回值推导
export type Interface = Awaited<ReturnType<typeof start>>

// 启动一个 Claude 会话进程（封装 query）
export async function start(options: Options) {
  // 按需加载 SDK，取出 query 函数
  const { query } = await ClaudeSDK.load()
  // 输入流控制器（稍后在流启动回调里赋值；非空断言）
  let input!: ReadableStreamDefaultController<SDKUserMessage>
  // 创建用户消息输入流
  const prompt = new ReadableStream<SDKUserMessage>({
    start(controller) {
      // 保存控制器，供后续 enqueue 用户消息
      input = controller
    },
  })
  // 启动 Claude 会话查询
  const session = query({ prompt, options })
  // 当前轮次（可能无）
  let turn: Turn | undefined
  // 会话是否已初始化完成
  let initialized = false
  // 会话是否已结束
  let ended = false
  // 记录过程中出现的失败（异常对象）
  let failure: unknown
  // 关闭流程的 Promise（避免重复关闭）
  let stopping: Promise<void> | undefined
  // 是否已产生持久化消息（assistant/result）
  let persisted = false
  // 初始化结果 Promise：检查版本并提取账户/模型信息
  const ready = session.initializationResult().then((init): ClaudeProbe.Result => {
    // 版本过旧等错误：抛出
    const error = ClaudeProbe.versionError(init.claude_code_version)
    if (error) throw error
    // 标记已初始化
    initialized = true
    // 返回探测结果（版本、账户、模型列表）
    return { version: init.claude_code_version!, account: init.account, models: init.models }
  })
  // 启动阶段的取消可能在任何人 await ready 之前就停止会话，所以这里先吞掉 rejection。
  // A cancel during startup can stop the session before anything awaits ready.
  ready.catch(() => {})

  // 结束当前轮次：标记完成并解析 drained Promise
  function finishTurn() {
    // 无轮次则跳过
    if (!turn) return
    // 标记完成
    turn.finished = true
    // 解析排空 Promise
    turn.drained.resolve()
  }

  // SDK 迭代器的唯一读取者（包括轮次被取消期间）
  // The only reader of the SDK iterator, including while a turn is being cancelled.
  async function readAll() {
    try {
      // 持续读取会话消息
      for await (const message of session) {
        // 有活动轮次时：消息入缓冲并唤醒等待者
        if (turn) {
          turn.messages.push(message)
          turn.wake?.()
        }
        // assistant/result 消息意味着已产生持久化内容
        if (message.type === "assistant" || message.type === "result") persisted = true
        // result 消息标志本轮结束
        if (message.type === "result") finishTurn()
      }
    } catch (error) {
      // 记录失败原因
      failure = error
    } finally {
      // 会话流结束：标记结束并完成收尾
      ended = true
      finishTurn()
      turn?.wake?.()
    }
  }
  // 启动后台泵（后台读取循环）
  const pump = readAll()

  // 中断当前轮次
  async function interrupt() {
    // 取当前轮次
    const active = turn
    // 无活动轮次、已完成或会话已结束则无需中断
    if (!active || active.finished || ended) return
    // 调用 SDK 的 interrupt
    await session.interrupt()
    // interrupt() 在 result 与转录落盘之前就 resolve，因此开始下一轮前要先等排空完成。
    // interrupt() resolves before the result and transcript flush, so wait for the drain before another turn starts.
    await active.drained.promise
  }

  // 关闭会话
  async function shutdown() {
    try {
      // 已初始化且未结束时：先中断并等待当前轮排空
      if (initialized && !ended) {
        await session.interrupt()
        if (turn && !turn.finished) await turn.drained.promise
      }
      // 关闭输入流
      input.close()
      // 未初始化的进程没有对话需要落盘，直接关闭
      // An uninitialized process has no conversation to flush.
      if (!initialized) session.close()
      // 等待后台泵结束
      await pump
    } finally {
      // 最终确保会话关闭
      session.close()
    }
  }

  // 幂等的停止入口（只启动一次关闭流程）
  function stop() {
    // 尚未停止则启动关闭流程
    if (!stopping) stopping = shutdown()
    // 返回关闭 Promise
    return stopping
  }

  // 开始新一轮对话：入队一条用户消息
  function begin(content: SDKUserMessage["message"]["content"], uuid = crypto.randomUUID()) {
    // 会话已结束/停止中：抛出（优先使用已知失败原因）
    if (ended || stopping) throw failure ?? new Error("Claude Code session has stopped")
    // 上一轮尚未结束：抛错
    if (turn && !turn.finished) throw new Error("Claude Code is still finishing the previous turn")
    // 创建新轮次
    turn = { drained: Promise.withResolvers<void>(), messages: [], finished: false }
    // 把用户消息入队到输入流
    input.enqueue({ type: "user", uuid, message: { role: "user", content }, parent_tool_use_id: null })
  }

  // 读取一个“步骤”：直到本轮回复结束（发生工具调用或得到 result）
  async function readStep(
    // 发射回调：把每条 SDK 消息交给上层
    emit: (message: SDKMessage) => void,
    // OpenCode 提供的工具列表
    tools: readonly LanguageModelV3FunctionTool[],
  ): Promise<SDKResultMessage | "tools"> {
    // 取当前轮次
    const active = turn
    // 无轮次则报错
    if (!active) throw new Error("No Claude turn to read")
    // 本步骤是否调用了工具
    let calledTools = false
    // 循环消费消息
    while (true) {
      // 从缓冲取出下一条消息
      const message = active.messages.shift()
      // 没有消息时
      if (!message) {
        // 会话已结束但回复未完成：抛出（优先已知失败）
        if (ended) throw failure ?? new Error("Claude Code stopped before finishing its reply")
        // 否则挂起等待新消息
        await new Promise<void>((resolve) => {
          active.wake = resolve
        })
        continue
      }
      // 把消息发射给上层
      emit(message)
      // 检查顶层助手消息中的工具调用
      if (message.type === "assistant" && message.parent_tool_use_id === null) {
        for (const part of message.message.content) {
          // 调用了我们未提供的工具时，由 Claude Code 自行报错，轮次继续，与 OpenCode 无关
          // Calls to tools we did not offer get Claude Code's own error, and the turn continues without OpenCode.
          if (part.type === "tool_use" && ToolNames.original(part.name, tools)) calledTools = true
        }
      }
      // 判断回复是否结束：顶层流事件的 message_stop
      const replyEnded =
        message.type === "stream_event" && message.parent_tool_use_id === null && message.event.type === "message_stop"
      // 已发生工具调用且回复结束：返回 "tools"（等待工具结果）
      if (calledTools && replyEnded) return "tools"
      // 收到 result 消息：本轮结束，返回结果
      if (message.type === "result") return message
    }
  }

  // 返回会话接口
  return {
    // 会话 ID：优先用 resume 的目标，否则用新建的 sessionId
    id: options.resume ?? options.sessionId!,
    // 初始化结果 Promise
    ready,
    // 会话是否已结束
    get ended() {
      return ended
    },
    // 是否已产生持久化内容
    get persisted() {
      return persisted
    },
    // 是否有进行中的轮次
    get running() {
      return !!turn && !turn.finished
    },
    // 开始新轮次
    begin,
    // 读取一个步骤
    readStep,
    // 向会话追加一条用户消息（优先插队处理）
    addUser(content: SDKUserMessage["message"]["content"], uuid: NonNullable<SDKUserMessage["uuid"]>) {
      input.enqueue({
        // 用户消息类型
        type: "user",
        // 消息 UUID
        uuid,
        // 优先级：next（插队）
        priority: "next",
        // 消息体
        message: { role: "user", content },
        // 顶层消息无父工具调用
        parent_tool_use_id: null,
      })
    },
    // 中断当前轮次
    interrupt,
    // 停止会话
    stop,
    // 设置模型
    setModel: (model: string) => session.setModel(model),
    // 设置努力等级（null 表示清除）
    setEffort: (effort: Options["effort"]) => session.applyFlagSettings({ effortLevel: effort ?? null }),
  }
}
