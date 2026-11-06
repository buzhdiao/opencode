// 将本模块以命名空间方式重新导出为 QuestionTool
export * as QuestionTool from "./question.js"

// 导入插件上下文类型（Context）
import type { Context } from "@opencode/plugin/effect/plugin"
// 导入 Effect 化的工具失败类型（ToolFailure）
import { ToolFailure } from "@opencode/ai/effect"
// 导入 Effect 原语：Effect、Schema
import { Effect, Schema } from "effect"
// 导入表单（Form）服务：承载交互式提问
import { Form } from "../../form.js"
// 导入权限（Permission）服务
import { Permission } from "../../permission.js"
// 导入 Question Schema：提问与回答的数据结构
import { Question } from "@opencode/schema/question"

// 工具名
export const name = "question"

// 工具描述：何时提问与使用要点（反引号转义的多行模板字符串，勿在其内部改动）
export const description = `Use this tool when you need to ask the user questions during execution. This allows you to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take.

Usage notes:
- A "Type your own answer" option is added automatically; don't include a separate option for free form answers
- Set \`multiple: true\` to allow selecting more than one option
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label`

// 输入 Schema：问题列表（非空）
export const Input = Schema.Struct({
  // 要问的问题数组
  questions: Schema.Array(Question.Prompt).check(Schema.isNonEmpty()).annotate({ description: "Questions to ask" }),
})

// 输出 Schema：回答列表
export const Output = Schema.Struct({
  // 与问题一一对应的回答数组
  answers: Schema.Array(Question.Answer),
})
// 输出的静态类型
export type Output = typeof Output.Type

// 用户关闭提问时的类型化错误（TaggedError）
export class CancelledError extends Schema.TaggedError<CancelledError>()("QuestionTool.CancelledError", {}) {
  // 错误消息
  override get message() {
    return "The user dismissed this question"
  }
}

// 把问题与回答格式化为面向模型的文本
export const toModelContent = (questions: ReadonlyArray<Question.Prompt>, answers: ReadonlyArray<Question.Answer>) => {
  // 逐题格式化为 "问题"="回答1, 回答2"（未回答标记 Unanswered）
  const formatted = questions
    .map(
      (question, index) =>
        `"${question.question}"="${answers[index]?.length ? answers[index].join(", ") : "Unanswered"}"`,
    )
    .join(", ")
  // 输出总结句
  return `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`
}

// 插件定义：注册 question 工具
export const Plugin = {
  // 插件唯一标识
  id: "opencode.tool.question",
  // 插件的 Effect 主体
  effect: Effect.fn("QuestionTool.Plugin")(function* (ctx: Context) {
    // 注入表单服务
    const forms = yield* Form.Service
    // 注入权限服务
    const permission = yield* Permission.Service

    // 向工具注册中心注册 question 工具
    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          // 工具名
          name,
          // 选项：不启用 codemode
          options: { codemode: false },
          // 工具描述
          description,
          // 输入/输出 Schema
          input: Input,
          output: Output,
          // 执行体：先断言权限，再弹出表单收集回答
          execute: (input, context) =>
            permission
              .assert({
                // 提问动作
                action: "question",
                // 任意资源
                resources: ["*"],
                // 附带调用上下文
                ...Permission.invocation(context),
              })
              .pipe(
                // 权限失败映射为工具失败
                Effect.mapError((error) => new ToolFailure({ message: "Permission denied: question", error })),
                // 权限通过后向会话发起表单提问
                Effect.andThen(
                  forms
                    .ask({
                      // 所属会话
                      sessionID: context.sessionID,
                      // 表单标题
                      title: "Questions",
                      // 元数据：类型与来源工具消息
                      metadata: {
                        kind: "question",
                        tool: { messageID: context.messageID, id: context.id },
                      },
                      // 把每个问题转换为表单字段
                      fields: [
                        toField(input.questions[0], 0),
                        ...input.questions.slice(1).map((question, index) => toField(question, index + 1)),
                      ],
                    })
                    // 表单错误直接中断（不经模型侧处理）
                    .pipe(Effect.orDie),
                ),
                // 处理表单结果
                Effect.flatMap((state) => {
                  // Deliberate defect tunnel (see Permission.assert): a dismissal must dodge
                  // leaf `mapError` blankets so it never becomes model-facing tool output; it
                  // resurfaces as a typed failure at SessionModelRequest.executeTool.
                  // A dismissal with a message (e.g. from a non-interactive client) is ordinary
                  // model-facing feedback: the model continues instead of the step ending.
                  // 关闭且带消息（如非交互客户端）：作为普通工具失败返回给模型
                  if (state.status === "cancelled" && state.message !== undefined)
                    return Effect.fail(new ToolFailure({ message: state.message }))
                  // 无消息的关闭：走缺陷通道（die），避免被各层 mapError 吞掉变成模型输出
                  if (state.status === "cancelled") return Effect.die(new CancelledError())
                  // 组装输出：按问题索引收集回答
                  const output = {
                    answers: input.questions.map((_, index): Question.Answer => {
                      // 取表单字段 q0、q1……的值
                      const value = state.answer[`q${index}`]
                      // 没填则返回空回答
                      if (value === undefined) return []
                      // 数组值直接转换
                      if (Array.isArray(value)) return Array.from(value)
                      // 单值包成数组
                      return [String(value)]
                    }),
                  }
                  // 返回回答与面向模型的文本
                  return Effect.succeed({
                    output,
                    content: toModelContent(input.questions, output.answers),
                    metadata: { answers: output.answers },
                  })
                }),
              ),
        }),
      )
      // 注册出错则直接中断
      .pipe(Effect.orDie)
  }),
}

// 把问题转换为表单字段定义
function toField(question: Question.Prompt, index: number): Form.Field {
  return {
    // 字段键：q0、q1……
    key: `q${index}`,
    // 字段标题（问题的 header）
    title: question.header,
    // 字段描述（问题正文）
    description: question.question,
    // 类型：允许多选则 multiselect，否则单行文本
    type: question.multiple === true ? "multiselect" : "string",
    // 选项列表：值与标签都用选项 label
    options: question.options.map((option) => ({
      value: option.label,
      label: option.label,
      description: option.description,
    })),
    // 允许自定义输入（自由作答）
    custom: true,
  }
}
