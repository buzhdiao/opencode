// 将本模块以命名空间 `SessionTitle` 全量导出
export * as SessionTitle from "./title.js"

// 引入深比较，用于判断备选模型引用是否与首选模型相同
import { isDeepStrictEqual } from "node:util"
// 引入 LLM 客户端、流事件与消息构造工具
import { LLMClient, LLMEvent, Message, SystemPart } from "@opencode/ai/effect"
// 引入代理（Agent）类型（仅类型）
import type { Agent } from "@opencode/schema/agent"
// 引入 Effect 原语：服务容器、时间、层与流
import { Context, DateTime, Effect, Layer, Stream } from "effect"
// 引入数据库服务
import { Database } from "../database/database.js"
// 引入事件总线服务
import { Bus } from "../bus.js"
// 引入按位置装配的服务节点工具
import { makeLocationNode } from "@opencode/util/effect/app-node"
// 引入"根会话默认标题"的精确匹配判定工具
import { isExactRootFallback } from "@opencode/util/session-title-fallback"
// 引入 LLM 客户端层依赖
import { llmClient } from "../effect/app-node-platform.js"
// 引入会话上下文服务
import { SessionContext } from "./context.js"
// 引入会话事件定义
import { SessionEvent } from "./event.js"
// 引入会话历史模块
import { SessionHistory } from "./history.js"
// 引入运行器已解析模型的类型（仅类型）
import type { SessionRunnerModel } from "./runner/model.js"
// 引入会话 schema
import { SessionSchema } from "./schema.js"
// 引入用量记录模块
import { SessionUsage } from "./usage.js"
// 引入会话存储服务
import { SessionStore } from "./store.js"

// 标题最大长度（超出截断并加省略号）
const MAX_LENGTH = 100
// 生成标题时的对话上下文预算（字符数）
const MAX_CONTEXT_LENGTH = 8_000
// 首条消息参与提示词的最大长度
const MAX_FIRST_MESSAGE_LENGTH = 2_000
// 提交时序不符时使用的哨兵缺陷（defect）值
const titleChanged = Symbol("Session title changed")

// 服务接口
export interface Interface {
  /** Generates an initial title or regenerates one from bounded conversation history. */
  readonly generate: (sessionID: SessionSchema.ID) => Effect.Effect<void>
}

// 定义可注入的服务标识（Context.Tag）
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionTitle") {}

// 截断标题到最大长度（保留省略号）
const truncate = (value: string) => (value.length <= MAX_LENGTH ? value : `${value.slice(0, MAX_LENGTH - 3)}...`)
// Framing the input as text to name keeps models from answering or carrying out the request instead.
const messagePrompt = (text: string) =>
  `Here is the first message of the conversation:\n\n<message>\n${text}\n</message>\n\nReply with only the title.`
// 生成"根据对话内容起标题"的提示词（输入包裹在 <conversation> 标签中）
const conversationPrompt = (text: string) =>
  `Here is the conversation so far:\n\n<conversation>\n${text}\n</conversation>\n\nReply with only the title.`
// 判断会话是否仍未命名（标题还是根会话的默认兜底标题）
export const isUntitled = (session: SessionSchema.Info) =>
  isExactRootFallback({
    title: session.title,
    time: { created: DateTime.toEpochMillis(session.time.created) },
  })

// 构建服务实现层
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 取事件总线服务
    const bus = yield* Bus.Service
    // 取 LLM 客户端服务
    const llm = yield* LLMClient.Service
    // 取会话上下文服务
    const context = yield* SessionContext.Service
    // 取会话存储服务
    const store = yield* SessionStore.Service
    // 取数据库句柄
    const db = (yield* Database.Service).db

    // 尝试让模型为会话起标题：流式收集回复并记录用量
    const attempt = Effect.fn("SessionTitle.attempt")(function* (input: {
      readonly session: SessionSchema.Info
      readonly agent: Agent.Info
      readonly text: string
      readonly model: SessionRunnerModel.Resolved
    }) {
      // 收集流式文本增量
      const chunks: string[] = []
      // 流失败标志
      let failed = false
      // 累计的用量记录（有结果才发布）
      let usage: SessionUsage.Recorded | undefined
      // 延迟发布用量事件：仅在已产生用量时发布
      const recordUsage = Effect.suspend(() =>
        usage
          ? bus.publish(SessionEvent.UsageRecorded, {
              sessionID: input.session.id,
              source: "title",
              ...usage,
            })
          : Effect.void,
      )
      // 调用模型前的准备：构建系统提示（有代理系统提示才加）与单条用户消息
      const prepared = yield* context.request.title({
        session: input.session,
        agent: input.agent.id,
        model: input.model,
        system: input.agent.system ? [SystemPart.make(input.agent.system)] : [],
        messages: [Message.user(input.text)],
      })
      // 准备阶段已被拦截并给出结果：直接返回该结果
      if (prepared.event.result !== undefined) return prepared.event.result
      // 流式调用模型：收集文本、累计各步用量；失败标记而不中断
      yield* llm.stream(prepared.request, prepared.options).pipe(
        Stream.runForEach((event) => {
          // 文本增量事件：追加到 chunks
          if (LLMEvent.is.textDelta(event)) chunks.push(event.text)
          // 步骤结束事件：记录该步用量并累计
          if (LLMEvent.is.stepFinish(event)) {
            const step = SessionUsage.record(event.usage, input.model.cost)
            usage = usage ? SessionUsage.add(usage, step) : step
          }
          // 每个事件处理完毕后继续
          return Effect.void
        }),
        // 模型出错：标记 failed 而不是让整个生成流程失败
        Effect.catchTag("AI.Error", () =>
          Effect.sync(() => {
            failed = true
          }),
        ),
        // 被中断时也要把已产生的用量记录下来
        Effect.onInterrupt(() => recordUsage.pipe(Effect.asVoid)),
      )
      // 正常结束后发布用量
      yield* recordUsage
      // 流失败：返回 undefined（外层可回退到备选模型）
      if (failed) return
      // 合并文本后取第一条非空行作为标题
      return chunks
        .join("")
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0)
    })

    // 生成会话标题（首次命名或按近期对话重新生成）
    const generate = Effect.fn("SessionTitle.generate")(function* (sessionID: SessionSchema.ID) {
      // 读取会话信息
      const session = yield* store.get(sessionID)
      // 会话不存在：直接返回
      if (!session) return
      // 取首条用户消息（标题的主要依据）
      const firstUser = yield* SessionHistory.firstUserMessage(db, session.id)
      // 没有用户消息：无从生成
      if (!firstUser) return
      // 组装给模型的起标题素材：已命名会话带上近期对话，未命名的只用首条消息
      const text = !isUntitled(session)
        ? yield* store.context(session.id).pipe(
            Effect.map((messages) => {
              // 原始请求：首条消息截断到上限
              const original = `Original request:\n${firstUser.text.slice(0, MAX_FIRST_MESSAGE_LENGTH)}`
              // 拼接除首条外的用户与助手消息为对话摘录
              const recent = messages
                .flatMap((message) => {
                  // 其他用户消息：以 "User:" 前缀加入
                  if (message.type === "user" && message.id !== firstUser.id) return [`User: ${message.text.trim()}`]
                  // 非用户/助手类型：跳过
                  if (message.type !== "assistant") return []
                  // 提取助手消息的全部非空文本段并合并
                  const text = message.content
                    .flatMap((part) => (part.type === "text" ? [part.text.trim()] : []))
                    .filter(Boolean)
                    .join("\n")
                  // 有文本则以 "Assistant:" 前缀加入
                  return text ? [`Assistant: ${text}`] : []
                })
                .join("\n\n")
              // 没有近期对话：仅用原始请求生成提示词
              if (!recent) return conversationPrompt(original)
              // 前缀：原始请求 + "近期对话"小节标题
              const prefix = `${original}\n\nRecent conversation:\n`
              // 按提示词模板与前缀的长度计算近期对话可用的字符预算
              const budget = MAX_CONTEXT_LENGTH - conversationPrompt("").length - prefix.length
              // 从尾部截取预算内的最近对话（保留最新内容）
              return conversationPrompt(`${prefix}${recent.slice(-budget)}`)
            }),
            // 读取上下文失败：退回仅用首条消息的提示词
            Effect.orElseSucceed(() => messagePrompt(firstUser.text)),
          )
        : messagePrompt(firstUser.text)
      // 选择用于起标题的代理与模型
      const selection = yield* context.selectTitle(session)
      // 未选择（如禁用起标题）：放弃
      if (!selection) return
      // 先用选定模型尝试；失败且与首选模型不同时，再用首选模型兜底一次
      const title =
        (yield* attempt({ session, agent: selection.agent, text, model: selection.selected })) ??
        (selection.primary && !isDeepStrictEqual(selection.selected.ref, selection.primary.ref)
          ? yield* attempt({ session, agent: selection.agent, text, model: selection.primary })
          : undefined)
      // 两次尝试都失败：放弃
      if (!title) return
      // 记录发布前的事件序号，用于提交时的乐观校验
      const expectedSequence = (yield* Bus.latestSequence(db, sessionID)) + 1
      // 重新读取会话，检测生成期间的并发变化
      const current = yield* store.get(sessionID)
      // 会话消失、标题已被他人修改、或新标题与旧标题相同：放弃
      if (!current || current.title !== session.title || current.title === truncate(title)) return
      // 发布重命名事件；提交时序不符则用哨兵缺陷中止
      yield* bus
        .publish(
          SessionEvent.Renamed,
          {
            sessionID: session.id,
            title: truncate(title),
          },
          { commit: (sequence) => (sequence === expectedSequence ? Effect.void : Effect.die(titleChanged)) },
        )
        .pipe(Effect.catchDefect((defect) => (defect === titleChanged ? Effect.void : Effect.die(defect))))
    })
    // 返回服务实现
    return Service.of({ generate })
  }),
)

// 按位置装配的服务节点及依赖
export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Bus.node, llmClient, SessionContext.node, SessionStore.node, Database.node],
})
