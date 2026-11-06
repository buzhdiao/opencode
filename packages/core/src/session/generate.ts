// 将本模块整体导出为 SessionGenerate 命名空间
export * as SessionGenerate from "./generate.js"

// 导入文件系统错误类型（仅类型）
import type { FileSystem } from "../filesystem.js"
// 导入 LLM 客户端、消息构造与 AI 错误类型
import { LLMClient, Message, type AIError } from "@opencode/ai/effect"
// 导入 effect 核心
import { Effect } from "effect"
// 导入数据库服务
import { Database } from "../database/database.js"
// 导入实例服务
import { Instance } from "../instance/service.js"
// 导入插件服务
import { Plugin } from "../plugin/service.js"
// 导入指令类型（仅类型）
import type { Instructions } from "../instructions/index.js"
// 导入会话上下文服务
import { SessionContext } from "./context.js"
// 导入 agent 未找到错误类型（仅类型）
import type { AgentNotFoundError } from "./error.js"
// 导入会话历史服务
import { SessionHistory } from "./history.js"
// 导入模型请求辅助
import { SessionModelRequest } from "./model-request.js"
// 导入模型重试策略
import { ModelRetry } from "../model-retry.js"
// 导入运行器模型类型（仅类型）
import type { SessionRunnerModel } from "./runner/model.js"
// 导入会话 schema 类型（仅类型）
import type { SessionSchema } from "./schema.js"

// 生成流程可能的错误联合类型
export type Error =
  | AgentNotFoundError
  | Instructions.InitializationBlocked
  | SessionRunnerModel.Error
  | AIError
  | FileSystem.DirectoryNotFoundError

/** Generates text from current Session context without mutating the Session. */
// 从当前会话上下文生成文本，不修改会话本身（用于标题生成等只读用途）
export const generate = Effect.fn("SessionGenerate.generate")(function* (input: {
  // 目标会话
  session: SessionSchema.Info
  // 用户提示文本
  prompt: string
}) {
  // 取出实例服务（提供会话作用域）
  const instances = yield* Instance.Service
  // 取出数据库服务
  const database = yield* Database.Service
  // 取出 LLM 客户端服务
  const llm = yield* LLMClient.Service

  // 在会话对应实例作用域内执行生成
  return yield* Effect.gen(function* () {
    // 等待插件激活完成
    yield* Plugin.awaitActivation
    // 取出会话上下文服务
    const context = yield* SessionContext.Service
    // 选择会话的 agent、指令与工具
    const selection = yield* context.select(input.session.id)
    // 解析会话使用的模型
    const model = yield* context.resolveModel(selection.session)
    // 预览历史：得到初始指令渲染与消息列表（不写入）
    const history = yield* SessionHistory.preview(database.db, selection.session.id, selection.instructions, model.ref)
    // 构造基础对话记录（系统提示、消息、工具）
    const transcript = SessionModelRequest.baseTranscript({
      agent: selection.agent.info,
      model,
      tools: selection.tools,
      initial: history.initial,
      messages: history.messages,
    })
    // 准备生成请求：在历史之后追加（可选的）指令更新系统消息与本次用户提示
    const prepared = yield* context.request.generate({
      session: selection.session,
      agent: selection.agent.id,
      model,
      tools: selection.tools,
      system: transcript.system,
      messages: [
        ...transcript.messages,
        ...(history.instructionUpdate ? [Message.system(history.instructionUpdate)] : []),
        Message.user(input.prompt),
      ],
    })
    // 记录请求日志（会话、供应商、模型）
    yield* Effect.logInfo("sending session generation request", {
      sessionID: selection.session.id,
      providerID: model.ref.providerID,
      modelID: model.ref.id,
    })
    // 调用 LLM 生成（带重试策略）
    const response = yield* llm.generate(prepared.request, prepared.options).pipe(ModelRetry.retry)
    // 记录用量诊断日志
    yield* Effect.logInfo("session generation usage diagnostic", { usage: response.usage })
    // 返回生成的文本
    return response.text
  }).pipe(instances.provide(input.session))
})
