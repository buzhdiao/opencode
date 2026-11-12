// 将本文件的所有导出聚合到命名空间 SubagentTool 下，供插件系统统一引入
export * as SubagentTool from "./subagent.js"

// 工具执行失败时抛出的错误类型（ToolFailure）
import { ToolFailure } from "@opencode/ai/effect"
// 插件上下文类型（Context），提供 tool/session 等扩展点
import type { Context } from "@opencode/plugin/effect/plugin"
// 会话钩子（SessionHooks）的类型定义
import type { SessionHooks } from "@opencode/plugin/effect/session"
// effect 库核心：Effect 副作用编排、Predicate 断言工具、Schema 数据校验
import { Effect, Predicate, Schema } from "effect"
// Agent 服务：解析可用代理
import { Agent } from "../../agent.js"
// Config 服务：读取全局配置
import { Config } from "../../config.js"
// Job 服务：任务的阻塞与取消
import { Job } from "../../job.js"
// Model 服务：查询可用模型
import { Model } from "../../model.js"
// Permission 服务：权限断言与评估
import { Permission } from "../../permission.js"
// Session 服务：会话的创建/查询/切换
import { Session } from "../../session.js"
// 会话相关 Schema（如 ID 类型）
import { SessionSchema } from "../../session/schema.js"
import { SubagentJob } from "../../session/subagent-job.js"

// 工具名称：subagent（子代理）
export const name = "subagent"

// 构造后台运行模式下的返回结果：告知模型子代理已在后台运行
const backgroundResult = (sessionID: SessionSchema.ID) => ({
  // 子代理的会话 ID，后续可用它跟进对话
  sessionID,
  // 状态固定为 running（运行中）
  status: "running" as const,
  // 输出提示文案：不要轮询/重复子代理的工作，并说明如何跟进
  output: [
    `The subagent is working in the background (sessionID: ${sessionID}). You will receive a <subagent> message when it goes idle, and again after each later round of work.`,
    "DO NOT sleep, poll for progress, ask the subagent for status, or duplicate this subagent's work; avoid working with the same files or topics it is using.",
    // 建议处理互不重叠的任务，或简单告知用户已启动后结束回复
    "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
    // 说明运行期间如何向该子代理发送后续消息
    "To send it follow-ups or change its instructions while it runs, call subagent again with this sessionID.",
  ].join("\n"),
})

// 工具入参 Schema（Schema：effect 库的数据校验与描述定义）
export const Input = Schema.Struct({
  // agent：要使用的专用代理类型
  agent: Schema.String.annotate({
    description:
      "The type of specialized agent to use for this task. If the user asks for a subagent by a name that is not one of the available subagents, they most likely mean a model: pick a suitable agent and pass the name through the model parameter instead.",
  }),
  description: Schema.String.annotate({ description: "A short 3-5 word label for the task, displayed to the user" }),
  prompt: Schema.String.annotate({ description: "The task for the subagent to perform" }),
  model: Schema.optionalKey(Schema.String).annotate({
    description:
      'NEVER set this unless the user explicitly asks for a particular model or variant. It must be a chat model; image and decision models can\'t run subagents. The value is written as "providerID/modelID", or "providerID/modelID#variant" to include a variant. Do not guess the ID: look the model up with the models tool, filtering to your own provider first.',
  }),
  // sessionID：可选，向已存在的子代理会话发送后续消息；省略则新建
  sessionID: Schema.optionalKey(SessionSchema.ID).annotate({
    description: "Send a follow-up to an existing subagent, running or finished. Omit to start a new one.",
  }),
})

// 工具出参 Schema：会话 ID、运行状态与输出文本
export const Output = Schema.Struct({
  // 子代理会话 ID
  sessionID: SessionSchema.ID,
  status: Schema.Literal("running"),
  output: Schema.String,
})
// 工具描述：说明子代理的用途、前后台行为与 sessionID 续聊用法
export const description = [
  // 在子会话中派生一个代理来执行指定任务
  "Spawns an agent in a child session to work on the specified task.",
  "Subagents always run in the background: the call returns immediately with a sessionID, and you receive a `<subagent>` message each time the child goes idle, including after later work.",
  "Keep working on non-overlapping tasks, or briefly tell the user what you launched and end your response. Do not sleep, poll for progress, or ask the child for status.",
  "New child sessions start with fresh context, so include all relevant context and instructions when you don't pass a sessionID.",
  "Pass the returned sessionID to continue that specific child conversation. A follow-up to a running child joins its current run.",
].join("\n")

// 插件定义：注册 subagent 工具及其钩子
export const Plugin = {
  // 插件唯一标识
  id: "opencode.tool.subagent",
  // 插件主 effect（Effect：effect 库中可组合的惰性计算单元），gen 以生成器风格编排
  effect: Effect.fn("SubagentTool.Plugin")(function* (ctx: Context) {
    // 获取会话服务
    const sessions = yield* Session.Service
    // 获取任务（Job）服务
    const jobs = yield* Job.Service
    // 获取代理（Agent）服务
    const agents = yield* Agent.Service
    // 获取配置（Config）服务
    const config = yield* Config.Service
    // 获取权限（Permission）服务
    const permission = yield* Permission.Service
    // 获取模型（Model）服务
    const models = yield* Model.Service
    // 获取子代理任务（SubagentJob）服务
    const subagents = yield* SubagentJob.Service

    // 解析并校验模型引用字符串，返回合法的 Model.Ref
    const resolveModel = Effect.fn("SubagentTool.resolveModel")(function* (input: string) {
      // 尝试解析模型引用字符串，失败则抛出工具错误
      const ref = yield* Effect.try({
        // 解析 "providerID/modelID" 或 "providerID/modelID#variant" 格式
        try: () => Model.Ref.parse(input),
        // 解析失败的兜底：构造 ToolFailure 提示正确格式
        catch: () =>
          new ToolFailure({
            message: `Invalid model "${input}". Use "providerID/modelID" or "providerID/modelID#variant".`,
          }),
      })
      // 在可用模型（chat 模型）列表中查找匹配项
      const model = (yield* models.available()).find(
        (model) => model.providerID === ref.providerID && model.id === ref.id,
      )
      // 未找到对应模型时给出详细错误
      if (model === undefined) {
        // 再到 image/decision 模型中查找，用于给出更精确的提示
        const other = (yield* models.available(["image", "decision"])).find(
          (model) => model.providerID === ref.providerID && model.id === ref.id,
        )
        // 抛出失败：区分"是图片/决策模型"与"模型不存在"两种情况
        return yield* new ToolFailure({
          // 依据是否在其它类型中找到来选择错误文案
          message: other
            ? `Model "${ref.providerID}/${ref.id}" is ${other.type === "image" ? "an image" : "a decision"} model; subagents need a chat model. Use the models tool to find one.`
            : `Model "${ref.providerID}/${ref.id}" is not available. Use the models tool to see what is available.`,
        })
      }
      // 指定了 variant（变体）但该模型不支持时，报错并列出可用变体
      if (ref.variant !== undefined && !model.variants.some((variant) => variant.id === ref.variant))
        return yield* new ToolFailure({
          // 依据模型是否支持变体给出不同提示
          message:
            model.variants.length === 0
              ? `Model "${ref.providerID}/${ref.id}" has no variants. Omit the variant.`
              : `Variant "${ref.variant}" is not available for "${ref.providerID}/${ref.id}". Available: ${model.variants.map((variant) => variant.id).join(", ")}.`,
        })
      // 校验通过，返回解析后的模型引用
      return ref
    })

    // 向工具注册表提交（transform）本工具的定义
    yield* ctx.tool
      // 在编辑器中添加工具
      .transform((editor) =>
        editor.add({
          // 工具名
          name,
          // 关闭 codemode（不作为代码模式调用）
          options: { codemode: false },
          // 工具描述
          description,
          // 入参 Schema
          input: Input,
          // 出参 Schema
          output: Output,
          // 工具执行体：入参与调用上下文
          execute: (input, context) =>
            Effect.gen(function* () {
              // 获取父会话（调用本工具的当前会话）
              const parent = yield* sessions
                .get(context.sessionID)
                .pipe(
                  Effect.mapError(
                    (error) => new ToolFailure({ message: `Parent session not found: ${context.sessionID}`, error }),
                  ),
                )
              // 从父会话开始向上遍历
              let current = parent
              // 记录会话嵌套深度
              let depth = 0
              // 沿 parentID 逐级上溯，统计嵌套层数
              while (current.parentID) {
                // 每上溯一层深度加一
                depth++
                // 取上一层会话，取不到则报错
                current = yield* sessions
                  .get(current.parentID)
                  .pipe(
                    Effect.mapError(
                      (error) => new ToolFailure({ message: `Parent session not found: ${current.parentID}`, error }),
                    ),
                  )
              }
              // 读取实验配置中的子代理嵌套深度上限，默认 1
              const limit = Config.latest(yield* config.entries(), "experimental")?.subagent_depth ?? 1
              // 超过深度上限则拒绝继续嵌套
              if (depth >= limit)
                return yield* new ToolFailure({
                  message: `Subagent depth limit reached (${limit}). Increase "experimental.subagent_depth" to allow nested subagents.`,
                })
              // 解析请求的代理
              const agent = yield* agents.resolve(input.agent)
              // 代理不存在则报错
              if (agent === undefined) return yield* new ToolFailure({ message: `Unknown agent: ${input.agent}` })
              // 主代理（primary）不能作为子代理运行
              if (agent.mode === "primary")
                return yield* new ToolFailure({ message: `Agent ${input.agent} cannot run as a subagent` })
              // 断言当前调用有权使用该代理（action: subagent，资源为代理 ID）
              yield* permission
                .assert({
                  // 权限动作名：subagent
                  action: name,
                  // 作用资源：目标代理 ID
                  resources: [agent.id],
                  // 用户允许时记住该授权
                  save: [agent.id],
                  // 附带调用方信息（工具调用上下文）
                  ...Permission.invocation(context),
                })
                .pipe(Effect.mapError((error) => new ToolFailure({ message: `Subagent denied: ${agent.id}`, error })))

              // 若传入 sessionID，则查找要继续的既有子代理会话
              const existing =
                input.sessionID === undefined
                  ? undefined
                  : yield* sessions
                      .get(input.sessionID)
                      .pipe(
                        Effect.mapError(
                          (error) =>
                            new ToolFailure({ message: `Subagent session not found: ${input.sessionID}`, error }),
                        ),
                      )
              // 既有会话必须是当前会话的直接子会话，否则拒绝
              if (existing !== undefined && existing.parentID !== context.sessionID)
                return yield* new ToolFailure({
                  message: `Session ${existing.id} is not a child of the current session`,
                })
              // 显式指定模型时先解析校验，得到模型覆盖值
              const override = input.model === undefined ? undefined : yield* resolveModel(input.model)
              // Continuing with a different agent switches the child, mirroring create semantics
              // where an explicit model wins over the agent's configured model, which wins over the inherited one.
              // 换代理继续会话时切换子会话的代理；显式模型优先于代理配置模型，再优先于继承模型
              if (existing !== undefined) {
                // 判断是否切换到了不同的代理
                const switched = existing.agent !== agent.id
                // 计算要应用的模型：显式指定优先；未指定且换了代理时用新代理默认模型
                const model = override ?? (switched ? agent.model : undefined)
                // 并行执行代理切换与模型切换
                yield* Effect.all([
                  // 需要时切换子会话代理，否则为空操作
                  switched ? sessions.switchAgent({ sessionID: existing.id, agent: agent.id }) : Effect.void,
                  // 有模型需要应用时切换子会话模型，否则为空操作
                  model === undefined ? Effect.void : sessions.switchModel({ sessionID: existing.id, model }),
                ]).pipe(
                  Effect.mapError(
                    (error) => new ToolFailure({ message: `Failed to switch subagent session: ${existing.id}`, error }),
                  ),
                )
              }

              // 最终模型：显式覆盖 > 代理默认模型 > 继承父会话模型
              const model = override ?? agent.model ?? parent.model
              // 确定子会话：复用既有会话，或新建一个以当前会话为父的子会话
              const child =
                existing ??
                (yield* sessions
                  .create({
                    // 父会话为当前会话
                    parentID: context.sessionID,
                    // 会话标题取任务简述
                    title: input.description,
                    // 子会话使用的代理
                    agent: agent.id,
                    // 子会话使用的模型
                    model,
                  })
                  .pipe(
                    Effect.mapError(
                      (error) => new ToolFailure({ message: `Parent session not found: ${context.sessionID}`, error }),
                    ),
                  ))

              // A child that is not draining yet must be admitted without waking: the job's resume
              // owns the start, so the period cannot run before its boundary is registered.
              const running =
                existing !== undefined &&
                ((yield* sessions.active).has(existing.id) || (yield* jobs.get(existing.id))?.status === "running")
              yield* context.progress({ sessionID: child.id, status: "running" })

              yield* sessions
                .prompt({
                  // 目标为子会话
                  sessionID: child.id,
                  // 首次调用时告知子代理它是被派生的，并拼接任务文本
                  text:
                    existing === undefined
                      ? ["You are a subagent spawned by another session.", input.prompt].join("\n")
                      : input.prompt,
                  ...(running ? {} : { resume: false }),
                })
                .pipe(
                  Effect.mapError(
                    (error) => new ToolFailure({ message: `Failed to prompt subagent: ${child.id}`, error }),
                  ),
                )

              // 构造恢复（recovery）信息：用于崩溃后重建子代理任务
              const recovery = {
                // 类型标记：subagent
                kind: "subagent" as const,
                // 父会话 ID
                parentSessionID: context.sessionID,
                // 子会话 ID
                childSessionID: child.id,
                // 代理名称
                agent: agent.name,
                // 任务简述
                description: input.description,
              }
              // 注册子代理任务
              yield* subagents.start(recovery)
              return backgroundResult(child.id)
            }).pipe(
              // 将执行结果包装为工具响应（content/metadata）
              Effect.map((output) => ({
                // 原始输出
                output,
                content: output.output,
                metadata: { sessionID: output.sessionID, status: output.status },
              })),
            ),
        }),
      )
      // 注册失败则直接终止（orDie：把错误转为 defect 致命缺陷）
      .pipe(Effect.orDie)

    // 注册 execute.before 钩子：在工具执行前清理空字符串参数
    yield* ctx.tool.hook("execute.before", (event) =>
      Effect.sync(() => {
        // 仅处理本工具，且入参必须是对象
        if (event.tool !== name || !Predicate.isObject(event.input)) return
        // model 与 sessionID 都非空时无需处理
        if (event.input.model !== "" && event.input.sessionID !== "") return
        // 复制入参以便删除字段
        const input = { ...event.input }
        // 删除空的 model 字段
        if (input.model === "") delete input.model
        // 删除空的 sessionID 字段
        if (input.sessionID === "") delete input.sessionID
        // 用清理后的入参替换原入参
        event.input = input
      }),
    )

    // 构造上下文钩子：把可用的子代理列表追加到工具描述中
    const hook = (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
        // 取出本工具在事件中的定义
        const tool = event.tools[name]
        // 工具不存在则直接返回
        if (!tool) return
        // 解析当前会话使用的代理
        const selected = yield* agents.resolve(event.agent)
        // 解析失败则返回
        if (!selected) return
        // 过滤出可作为子代理的代理：非 primary、未隐藏且未被当前代理的权限拒绝
        const available = (yield* agents.list())
          .filter(
            (agent) =>
              agent.mode !== "primary" &&
              !agent.hidden &&
              Permission.evaluate(name, agent.id, selected.permissions).effect !== "deny",
          )
          // 按代理 ID 排序，保证列表顺序稳定
          .toSorted((a, b) => a.id.localeCompare(b.id))
        // 没有可用子代理时不修改描述
        if (available.length === 0) return
        // 在原描述后追加"可用子代理"清单
        tool.description = [
          // 保留原描述
          tool.description,
          // 空行分隔
          "",
          // 列表标题
          "Available subagents:",
          // 逐个列出代理 ID 与描述（缺省时给出提示文案）
          ...available.map(
            (agent) =>
              `- ${agent.id}: ${agent.description ?? "This subagent should only be called when explicitly requested."}`,
          ),
        ].join("\n")
      })
    // 在 context（上下文构建）钩子上挂载
    yield* ctx.session.hook("context", hook)
    // 在 compaction（会话压缩）钩子上挂载
    yield* ctx.session.hook("compaction", hook)
    // 在 generate（模型生成）钩子上挂载
    yield* ctx.session.hook("generate", hook)
  }),
}
