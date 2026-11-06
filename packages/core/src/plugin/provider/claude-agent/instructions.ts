// 导出 ClaudeInstructions 命名空间，供其他模块引用本文件内容
export * as ClaudeInstructions from "./instructions.js"

// 导入系统提示片段（SystemPart）类型
import type { SystemPart } from "@opencode/ai/effect"
// 导入插件上下文类型
import type { Context } from "@opencode/plugin/effect/plugin"
// 从 effect 库导入 Effect、Option 与 Schema
import { Effect, Option, Schema } from "effect"
// 导入 Claude 系统提示工具（选项键名等）
import { ClaudeSystemPrompt } from "./language-model/system-prompt.js"
// 导入 Claude Provider（用于匹配 providerID）
import { ClaudeProvider } from "./provider.js"

// 需要注册系统提示转换的三种会话阶段：上下文、生成、压缩
const KINDS = ["context", "generate", "compaction"] as const

// 定义指令元数据的 Schema：metadata.experimental.instructions 是 key/text 对的数组
const InstructionsMetadata = Schema.Struct({
  experimental: Schema.Struct({
    instructions: Schema.Array(Schema.Struct({ key: Schema.String, text: Schema.String })),
  }),
})

// Claude Code 会自己写日期和环境信息，所以 OpenCode 提供的这两类内容会与之重复，应跳过
// Claude Code writes its own date and environment, so OpenCode's would repeat them.
const SUPPLIED_BY_CLAUDE = new Set(["core/date", "core/environment"])

// 注册函数：为三种会话阶段挂上钩子，把 OpenCode 的系统提示转写为 Claude Code 的选项
export const register = Effect.fn("ClaudeInstructions.register")(function* (ctx: Context) {
  // 对每种阶段（kind）执行注册
  yield* Effect.forEach(
    KINDS,
    (kind) =>
      // 在 ctx.session 上注册该阶段的钩子，仅对 claude 供应商生效
      ctx.session.hook(
        kind,
        (event) =>
          Effect.gen(function* () {
            // 解析事件对应的 agent（代理配置）；失败则直接中止
            const agent = yield* ctx.agent.get({ agentID: event.agent }).pipe(Effect.orDie)
            // 从解析后的 agent 读取角色（system），而不是靠猜测哪段提示词是内置的
            // Read the role from the resolved agent, not by guessing which prompt text is a built-in.
            event.options[ClaudeSystemPrompt.AGENT_OPTION] = agent.data.system ?? ""
            // 把剩余的系统提示文本拼接为额外指令，写入选项
            event.options[ClaudeSystemPrompt.INSTRUCTIONS_OPTION] = instructions(event.system)
          }),
        { providerID: ClaudeProvider.ID },
      ),
    // discard: true 表示只需要执行副作用，不收集返回值
    { discard: true },
  )
})

// 提取指令文本：第一个片段是 OpenCode 自己的提示词，会被 Claude Code 的提示词替换，故跳过
// The first part is OpenCode's own prompt, which Claude Code's prompt replaces.
function instructions(system: ReadonlyArray<SystemPart>) {
  // 收集文本片段的数组
  const texts: string[] = []
  // 从第二个片段开始遍历
  for (const part of system.slice(1)) {
    // 尝试把该片段的 metadata 解码为指令元数据
    const metadata = Schema.decodeUnknownOption(InstructionsMetadata)(part.metadata)
    // 解码失败：说明是普通文本片段，直接收集其文本
    if (Option.isNone(metadata)) {
      texts.push(part.text)
      continue
    }
    // 解码成功：遍历其来源指令列表
    for (const source of metadata.value.experimental.instructions) {
      // Claude Code 已自行提供的（日期/环境）内容跳过
      if (SUPPLIED_BY_CLAUDE.has(source.key)) continue
      // 其余指令文本收集起来
      texts.push(source.text)
    }
  }
  // 用空行拼接所有指令文本
  return texts.join("\n\n")
}
