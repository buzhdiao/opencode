// 导入 immer 的 produce：以不可变方式通过草稿（draft）修改对象
import { castDraft, produce, type WritableDraft } from "immer"
// Effect 核心：DateTime（时间）、Effect、Match（模式匹配）、pipe（管道组合）、Schema
import { DateTime, Effect, Match, pipe, Schema } from "effect"
// 会话事件定义：本模块把持久化事件投影（project）为会话消息
import { SessionEvent } from "./event.js"
// 会话消息类型与构造器
import { SessionMessage } from "./message.js"

// 适配器（Adapter）接口：把"消息存储"的具体读写抽象出来，
// 使事件投影逻辑与存储实现（如 UI 状态或数据库）解耦
export interface Adapter {
  // 获取当前选中的 agent（可能没有）
  readonly getAgent: () => Effect.Effect<SessionMessage.AgentSelected["agent"] | undefined>
  // 获取当前选中的模型（可能没有）
  readonly getModel: () => Effect.Effect<SessionMessage.ModelSelected["model"] | undefined>
  // 获取上一次的位置（LocationSwitched 的 previous）
  readonly getLocation: () => Effect.Effect<SessionMessage.LocationSwitched["previous"]>
  // 获取"当前"（最新一条）助手消息
  readonly getCurrentAssistant: () => Effect.Effect<SessionMessage.Assistant | undefined>
  // 按 ID 获取助手消息
  readonly getAssistant: (messageID: SessionMessage.ID) => Effect.Effect<SessionMessage.Assistant | undefined>
  // 按 shellID 获取 shell 消息
  readonly getShell: (shellID: SessionMessage.Shell["shellID"]) => Effect.Effect<SessionMessage.Shell | undefined>
  // 获取进行中的压缩（compaction）消息
  readonly getCompaction: () => Effect.Effect<SessionMessage.Compaction | undefined>
  // 整体更新一条助手消息
  readonly updateAssistant: (assistant: SessionMessage.Assistant) => Effect.Effect<void>
  // 向助手消息追加一个内容分片（part）
  readonly appendAssistantPart: (
    messageID: SessionMessage.ID,
    part: SessionMessage.AssistantContent,
  ) => Effect.Effect<void>
  // 按 (类型, callID, 不完整推理) 条件查找并原地修改某个助手分片
  readonly updateAssistantPart: <T extends SessionMessage.AssistantContent["type"]>(
    messageID: SessionMessage.ID,
    match: {
      readonly type: T
      readonly callID?: string
      readonly incompleteReasoning?: boolean
    },
    recipe: (draft: WritableDraft<Extract<SessionMessage.AssistantContent, { readonly type: T }>>) => void,
  ) => Effect.Effect<void>
  // 整体替换助手消息的全部分片
  readonly replaceAssistantParts: (
    messageID: SessionMessage.ID,
    parts: ReadonlyArray<SessionMessage.AssistantContent>,
  ) => Effect.Effect<void>
  // 更新一条 shell 消息
  readonly updateShell: (shell: SessionMessage.Shell) => Effect.Effect<void>
  // 更新一条压缩消息
  readonly updateCompaction: (compaction: SessionMessage.Compaction) => Effect.Effect<void>
  // 追加一条新消息
  readonly appendMessage: (message: SessionMessage.Info) => Effect.Effect<void>
}

// 助手消息草稿类型：immer 的可写草稿
type DraftAssistant = WritableDraft<SessionMessage.Assistant>

// 创建同步解码器：把事件携带的 JSON 内容数组解码为助手内容分片数组
const decodeAssistantContent = Schema.decodeUnknownSync(Schema.Array(SessionMessage.AssistantContent))

// projectTerminalSnapshot：在步骤结束/失败时把快照（snapshot）与文件列表写入助手消息
const projectTerminalSnapshot = (draft: DraftAssistant, event: SessionEvent.Step.Ended | SessionEvent.Step.Failed) => {
  // 事件里带了快照或文件才需要更新
  if (event.data.snapshot || event.data.files)
    draft.snapshot = {
      ...draft.snapshot,
      // 记录结束时的快照与文件（files 需复制为数组）
      end: event.data.snapshot,
      files: event.data.files ? Array.from(event.data.files) : undefined,
    }
}

// update：把一个持久化事件投影为消息存储的变更（核心分发函数）
export function update(adapter: Adapter, event: SessionEvent.DurableEvent) {
  // 事件创建时间，转换为 DateTime
  const created = DateTime.makeUnsafe(event.created)

  // updateOwnedAssistant：仅当消息存在时用 recipe 修改指定助手消息（不可变更新）
  const updateOwnedAssistant = (messageID: SessionMessage.ID, recipe: (draft: DraftAssistant) => void) =>
    Effect.gen(function* () {
      const assistant = yield* adapter.getAssistant(messageID)
      // 消息不存在（不属于本存储）则忽略
      if (!assistant) return
      yield* adapter.updateAssistant(produce(assistant, recipe))
    })

  // clearCurrentRetry：清空当前助手消息上的重试（retry）标记
  const clearCurrentRetry = Effect.gen(function* () {
    const assistant = yield* adapter.getCurrentAssistant()
    // 没有当前消息或没有重试标记则无需清理
    if (!assistant?.retry) return
    yield* adapter.updateAssistant(
      produce(assistant, (draft) => {
        draft.retry = undefined
      }),
    )
  })

  // idle：构造并追加一条"空闲"（Idle）消息，表示会话执行结束（成功/失败/被中断）
  const idle = (outcome: SessionMessage.Idle["outcome"], error?: SessionMessage.Idle["error"]) =>
    clearCurrentRetry.pipe(
      Effect.andThen(
        adapter.appendMessage(
          SessionMessage.Idle.make({
            // 消息 ID 从事件 ID 派生，保证幂等
            id: SessionMessage.ID.fromEvent(event.id),
            type: "idle",
            outcome,
            error,
            metadata: event.metadata,
            time: { created },
          }),
        ),
      ),
    )

  // project：按事件 type 分发的模式匹配（必须穷尽所有事件类型）
  const project = pipe(
    Match.type<SessionEvent.DurableEvent>(),
    Match.discriminatorsExhaustive("type")({
      // 会话级元数据事件不产生消息
      "session.created": () => Effect.void,
      "session.viewed": () => Effect.void,
      "session.archived": () => Effect.void,
      "session.unarchived": () => Effect.void,
      // 客户端发来完整内容：整体替换助手消息的分片
      "session.message.content.updated": (event) =>
        adapter.replaceAssistantParts(event.data.messageID, decodeAssistantContent(event.data.content)),
      // 用量记录不产生消息
      "session.usage.recorded": () => Effect.void,
      // agent 切换：记录新旧 agent
      "session.agent.selected": (event) =>
        Effect.gen(function* () {
          // 事件未带旧值时从存储中读取当前 agent
          const previous = event.data.previous ?? (yield* adapter.getAgent())
          yield* adapter.appendMessage(
            SessionMessage.AgentSelected.make({
              id: SessionMessage.ID.fromEvent(event.id),
              type: "agent-switched",
              metadata: event.metadata,
              agent: event.data.agent,
              previous,
              time: { created },
            }),
          )
        }),
      // 模型切换：记录新旧模型
      "session.model.selected": (event) =>
        Effect.gen(function* () {
          // 事件未带旧值时从存储中读取当前模型
          const previous = event.data.previous ?? (yield* adapter.getModel())
          yield* adapter.appendMessage(
            SessionMessage.ModelSelected.make({
              id: SessionMessage.ID.fromEvent(event.id),
              type: "model-switched",
              metadata: event.metadata,
              model: event.data.model,
              previous,
              time: { created },
            }),
          )
        }),
      // 会话迁移：记录位置切换及旧位置
      "session.moved": (event) =>
        Effect.gen(function* () {
          yield* adapter.appendMessage(
            SessionMessage.LocationSwitched.make({
              id: SessionMessage.ID.fromEvent(event.id),
              type: "location-switched",
              metadata: event.metadata,
              location: event.data.location,
              projectID: event.data.projectID,
              subpath: event.data.subpath,
              // 旧位置从存储中读取
              previous: yield* adapter.getLocation(),
              time: { created },
            }),
          )
        }),
      // 以下会话级事件同样不产生消息
      "session.renamed": () => Effect.void,
      "session.metadata.updated": () => Effect.void,
      "session.permissions": () => Effect.void,
      "session.deleted": () => Effect.void,
      "session.forked": () => Effect.void,
      "session.inbox.delivered": () => Effect.void,
      "session.inbox.enqueued": () => Effect.void,
      "session.inbox.cancelled": () => Effect.void,
      "session.inbox.delivery.changed": () => Effect.void,
      "session.execution.started": () => Effect.void,
      // 执行成功：追加 outcome 为 succeeded 的空闲消息
      "session.execution.succeeded": () => idle("succeeded"),
      // 执行失败：追加 outcome 为 failed 并携带错误信息的空闲消息
      "session.execution.failed": (event) => idle("failed", event.data.error),
      // Shutdown keeps the execution claim and the resumed drain continues the turn.
      // 执行中断：因 shutdown 引起的只清理重试标记（恢复后继续本轮）；其余按中断结束
      "session.execution.interrupted": (event) =>
        event.data.reason === "shutdown" ? clearCurrentRetry : idle("interrupted"),
      // 指令更新：仅当事件携带渲染文本时，追加一条系统消息说明指令变化
      "session.instructions.updated": (event) => {
        // 没有文本（例如初次同步基线）则不产生消息
        if (event.data.text === undefined) return Effect.void
        return adapter.appendMessage(
          SessionMessage.System.make({
            id: SessionMessage.ID.fromEvent(event.id),
            type: "system",
            text: event.data.text,
            // 描述列出发生变化的指令键
            description: `Instructions updated: ${Object.keys(event.data.delta).join(", ")}`,
            metadata: { ...event.metadata, notice: "instructions", instructionSources: Object.keys(event.data.delta) },
            time: { created },
          }),
        )
      },
      // 合成消息：直接把事件中的文本/描述/元数据落为一条 synthetic 消息
      "session.synthetic": (event) => {
        return adapter.appendMessage(
          SessionMessage.Synthetic.make({
            text: event.data.text,
            description: event.data.description,
            metadata: event.data.metadata,
            id: SessionMessage.ID.fromEvent(event.id),
            type: "synthetic",
            time: { created },
          }),
        )
      },
      // 技能（skill）激活：追加一条 skill 消息
      "session.skill.activated": (event) => {
        return adapter.appendMessage(
          SessionMessage.Skill.make({
            id: SessionMessage.ID.fromEvent(event.id),
            type: "skill",
            skill: event.data.id,
            name: event.data.name,
            text: event.data.text,
            metadata: event.metadata,
            time: { created },
          }),
        )
      },
      // shell 启动：追加一条 shell 消息（后台 shell 在元数据中打标）
      "session.shell.started": (event) => {
        return adapter.appendMessage(
          SessionMessage.Shell.make({
            id: SessionMessage.ID.fromEvent(event.id),
            type: "shell",
            metadata:
              event.data.shell.metadata.background === true ? { ...event.metadata, background: true } : event.metadata,
            shellID: event.data.shell.id,
            command: event.data.shell.command,
            status: event.data.shell.status,
            time: { created },
          }),
        )
      },
      // shell 结束：更新已存在的 shell 消息的状态、退出码、输出与完成时间
      "session.shell.ended": (event) =>
        Effect.gen(function* () {
          const currentShell = yield* adapter.getShell(event.data.shell.id)
          // 找到对应 shell 消息才更新（不存在则忽略）
          if (currentShell) {
            yield* adapter.updateShell(
              produce(currentShell, (draft) => {
                draft.status = event.data.shell.status
                draft.exit = event.data.shell.exit
                draft.output = event.data.output
                draft.time.completed = created
              }),
            )
          }
        }),
      // 步骤开始：复用或新建助手消息
      "session.step.started": (event) =>
        Effect.gen(function* () {
          // 先找事件指定的助手消息
          const existing = yield* adapter.getAssistant(event.data.assistantMessageID)
          if (existing) {
            // 已存在（重试/续跑同一轮）：重置其运行态字段
            yield* adapter.updateAssistant(
              produce(existing, (draft) => {
                draft.agent = event.data.agent
                draft.model = castDraft(event.data.model)
                draft.retry = undefined
                draft.error = undefined
                draft.finish = undefined
                draft.rawFinish = undefined
                draft.native = undefined
                draft.time.created = DateTime.makeUnsafe(event.data.started)
                draft.time.streamed = undefined
                draft.time.completed = undefined
                // 事件带快照时记录步骤起始快照
                if (event.data.snapshot) draft.snapshot = { ...draft.snapshot, start: event.data.snapshot }
              }),
            )
            return
          }
          // 不存在则是新的一轮：先把"当前"助手消息标记完成
          const currentAssistant = yield* adapter.getCurrentAssistant()
          if (currentAssistant) {
            yield* adapter.updateAssistant(
              produce(currentAssistant, (draft) => {
                draft.retry = undefined
                draft.time.completed = created
              }),
            )
          }
          // 再追加一条新的助手消息（内容为空，等待后续事件填充）
          yield* adapter.appendMessage(
            SessionMessage.Assistant.make({
              id: event.data.assistantMessageID,
              type: "assistant",
              agent: event.data.agent,
              model: event.data.model,
              metadata: event.metadata,
              time: { created: DateTime.makeUnsafe(event.data.started) },
              content: [],
              snapshot: event.data.snapshot ? { start: event.data.snapshot } : undefined,
            }),
          )
        }),
      // 步骤开始流式输出：记录 streamed 时间
      "session.step.streamed": (event) => {
        return updateOwnedAssistant(event.data.assistantMessageID, (draft) => {
          draft.time.streamed = created
        })
      },
      // 步骤正常结束：写入完成时间、结束原因、原生信息、成本与 token 用量
      "session.step.ended": (event) => {
        return updateOwnedAssistant(event.data.assistantMessageID, (draft) => {
          draft.time.completed = created
          draft.finish = event.data.finish
          draft.rawFinish = event.data.rawFinish
          draft.native = castDraft(event.data.native)
          draft.cost = event.data.cost
          draft.tokens = event.data.tokens
          projectTerminalSnapshot(draft, event)
        })
      },
      // 步骤失败：写入错误信息并清理重试标记
      "session.step.failed": (event) => {
        return updateOwnedAssistant(event.data.assistantMessageID, (draft) => {
          draft.time.completed = created
          // 事件未带 finish 时归一化为 "error"
          draft.finish = event.data.finish ?? "error"
          draft.rawFinish = event.data.rawFinish
          draft.native = castDraft(event.data.native)
          draft.error = castDraft(event.data.error)
          draft.retry = undefined
          // 只有事件同时带成本与 token 用量时才覆盖
          if (event.data.cost !== undefined && event.data.tokens !== undefined) {
            draft.cost = event.data.cost
            draft.tokens = castDraft(event.data.tokens)
          }
          projectTerminalSnapshot(draft, event)
        })
      },
      // 文本开始：追加一个空文本分片（内容由后续 text.ended 填充）
      "session.text.started": (event) => {
        return adapter.appendAssistantPart(
          event.data.assistantMessageID,
          SessionMessage.AssistantText.make({ type: "text", text: "" }),
        )
      },
      // 文本结束：把最终文本与原生数据写回文本分片
      "session.text.ended": (event) => {
        return adapter.updateAssistantPart(event.data.assistantMessageID, { type: "text" }, (match) => {
          match.text = event.data.text
          match.native = castDraft(event.data.native)
        })
      },
      // 工具输入开始：追加一个流式（streaming）状态的工具分片
      "session.tool.input.started": (event) => {
        return adapter.appendAssistantPart(
          event.data.assistantMessageID,
          SessionMessage.AssistantTool.make({
            type: "tool",
            id: event.data.id,
            name: event.data.name,
            time: { created },
            state: SessionMessage.ToolStateStreaming.make({ status: "streaming", input: "" }),
          }),
        )
      },
      // 工具输入结束：把完整输入文本写回流式状态
      "session.tool.input.ended": (event) => {
        return adapter.updateAssistantPart(
          event.data.assistantMessageID,
          { type: "tool", callID: event.data.id },
          (match) => {
            // 仅在仍是流式状态时写入
            if (match.state.status === "streaming") match.state.input = event.data.text
          },
        )
      },
      // 工具被调用：切换到 running 状态并记录执行信息
      "session.tool.called": (event) => {
        return adapter.updateAssistantPart(
          event.data.assistantMessageID,
          { type: "tool", callID: event.data.id },
          (match) => {
            match.executed = event.data.executed
            match.native = event.data.native
            match.time.ran = created
            // 状态整体替换为 running，并携带解析后的输入
            match.state = castDraft(
              SessionMessage.ToolStateRunning.make({
                status: "running",
                input: event.data.input,
                metadata: {},
              }),
            )
          },
        )
      },
      // Terminal tool events are self-contained; projection is a direct copy and
      // never reaches into ephemeral progress history.
      // 工具成功：把状态替换为 completed，保留已有输入并写入内容/元数据
      "session.tool.success": (event) => {
        return adapter.updateAssistantPart(
          event.data.assistantMessageID,
          { type: "tool", callID: event.data.id },
          (match) => {
            // 仅在 running 状态时处理（流式中收到成功视为乱序，忽略）
            if (match.state.status === "running") {
              match.executed = event.data.executed || match.executed === true
              // 原生数据做合并而非覆盖
              if (event.data.native) match.native = { ...match.native, ...event.data.native }
              match.time.completed = created
              match.state = castDraft(
                SessionMessage.ToolStateCompleted.make({
                  status: "completed",
                  input: match.state.input,
                  content: event.data.content,
                  ...(event.data.metadata === undefined ? {} : { metadata: event.data.metadata }),
                }),
              )
            }
          },
        )
      },
      // 工具失败：把状态替换为 error（流式或运行中都可转入）
      "session.tool.failed": (event) => {
        return adapter.updateAssistantPart(
          event.data.assistantMessageID,
          { type: "tool", callID: event.data.id },
          (match) => {
            if (match.state.status === "streaming" || match.state.status === "running") {
              match.executed = event.data.executed || match.executed === true
              if (event.data.native) match.native = { ...match.native, ...event.data.native }
              match.time.completed = created
              match.state = castDraft(
                SessionMessage.ToolStateError.make({
                  status: "error",
                  error: event.data.error,
                  // 输入仍是字符串时丢弃（错误态只保留结构化输入）
                  input: typeof match.state.input === "string" ? {} : match.state.input,
                  ...(event.data.content === undefined ? {} : { content: event.data.content }),
                  ...(event.data.metadata === undefined ? {} : { metadata: event.data.metadata }),
                }),
              )
            }
          },
        )
      },
      // 推理（reasoning）开始：追加一个空推理分片（携带原生标记）
      "session.reasoning.started": (event) => {
        return adapter.appendAssistantPart(
          event.data.assistantMessageID,
          SessionMessage.AssistantReasoning.make({
            type: "reasoning",
            text: "",
            native: event.data.native,
            time: { created },
          }),
        )
      },
      // 推理结束：按"不完整推理"条件定位分片并写入最终文本与完成时间
      "session.reasoning.ended": (event) => {
        return adapter.updateAssistantPart(
          event.data.assistantMessageID,
          { type: "reasoning", incompleteReasoning: true },
          (match) => {
            match.text = event.data.text
            // 创建时间缺失时以本事件时间兜底
            match.time = { created: match.time?.created ?? created, completed: created }
            // 事件带原生数据时才覆盖
            if (event.data.native !== undefined) match.native = event.data.native
          },
        )
      },
      // 重试排程：在助手消息上记录重试次数、时间与错误
      "session.retry.scheduled": (event) => {
        return updateOwnedAssistant(event.data.assistantMessageID, (draft) => {
          draft.retry = {
            attempt: event.data.attempt,
            at: DateTime.makeUnsafe(event.data.at),
            error: castDraft(event.data.error),
          }
        })
      },
      // 压缩开始：追加一条 running 状态的压缩消息（复用输入消息 ID）
      "session.compaction.started": (event) =>
        adapter.appendMessage(
          SessionMessage.CompactionRunning.make({
            id: event.data.inputID ?? SessionMessage.ID.fromEvent(event.id),
            type: "compaction",
            status: "running",
            metadata: event.metadata,
            reason: event.data.reason,
            // 摘要先置空，结束后填充
            summary: "",
            time: { created },
          }),
        ),
      // 压缩结束：更新进行中的压缩消息，或直接追加一条完成的压缩消息
      "session.compaction.ended": (event) =>
        Effect.gen(function* () {
          const current = yield* adapter.getCompaction()
          // 存在进行中的压缩：就地更新为完成态并填充结果
          if (current?.status === "running") {
            yield* adapter.updateCompaction({
              ...current,
              status: "completed",
              // 元数据做合并
              metadata: event.metadata ? { ...current.metadata, ...event.metadata } : current.metadata,
              reason: event.data.reason,
              model: event.data.model,
              native: event.data.native,
              summary: event.data.text,
              cost: event.data.cost,
              tokens: event.data.tokens,
            })
            return
          }
          // 没有进行中的压缩（如回放/其他流程）：直接追加一条完成的压缩消息
          yield* adapter.appendMessage(
            SessionMessage.Compaction.make({
              id: SessionMessage.ID.fromEvent(event.id),
              type: "compaction",
              status: "completed",
              metadata: event.metadata,
              reason: event.data.reason,
              model: event.data.model,
              native: event.data.native,
              summary: event.data.text,
              cost: event.data.cost,
              tokens: event.data.tokens,
              time: { created },
            }),
          )
        }),
      // 压缩失败：构造 failed 状态的压缩消息（尽量复用已有消息的 ID/元数据/时间）
      "session.compaction.failed": (event) =>
        Effect.gen(function* () {
          const current = yield* adapter.getCompaction()
          const failed = SessionMessage.CompactionFailed.make({
            id: current?.id ?? event.data.inputID ?? SessionMessage.ID.fromEvent(event.id),
            type: "compaction",
            status: "failed",
            metadata: current?.metadata ?? event.metadata,
            reason: event.data.reason,
            error: event.data.error,
            cost: event.data.cost,
            tokens: event.data.tokens,
            time: current?.time ?? { created },
          })
          // 存在进行中的压缩则就地更新，否则追加
          if (current?.status === "running") return yield* adapter.updateCompaction(failed)
          yield* adapter.appendMessage(failed)
        }),
      // 回滚（revert）相关事件不产生消息（由其他模块处理）
      "session.revert.staged": () => Effect.void,
      "session.revert.cleared": () => Effect.void,
      "session.revert.committed": () => Effect.void,
    }),
  )
  // 对传入事件执行投影
  return project(event)
}

// 以命名空间方式再导出本模块
export * as SessionMessageUpdater from "./message-updater.js"
