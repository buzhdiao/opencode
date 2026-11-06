// 导入 zod v4：用于定义并校验 provider 专属选项的 schema
import { z } from "zod/v4"

// OpenAICompatibleChatModelId：模型 ID 类型（当前就是字符串）
export type OpenAICompatibleChatModelId = string

// openaiCompatibleProviderOptions：copilot provider 专属选项的 schema 定义
export const openaiCompatibleProviderOptions = z.object({
  /**
   * A unique identifier representing your end-user, which can help the provider to
   * monitor and detect abuse.
   *
   * 中文说明：终端用户的唯一标识符，可帮助 provider 监测与发现滥用行为。
   */
  user: z.string().optional(),

  /**
   * Reasoning effort for reasoning models. Defaults to `medium`.
   *
   * 中文说明：推理模型的推理力度（reasoning effort）。默认 `medium`。
   */
  reasoningEffort: z.string().optional(),

  /**
   * Controls the verbosity of the generated text. Defaults to `medium`.
   *
   * 中文说明：控制生成文本的详细程度（verbosity）。默认 `medium`。
   */
  textVerbosity: z.string().optional(),

  /**
   * Copilot thinking_budget used for Anthropic models.
   *
   * 中文说明：Copilot 的 thinking_budget，用于 Anthropic 系模型。
   */
  thinking_budget: z.number().optional(),
})

// 由 schema 推导出选项的静态类型
export type OpenAICompatibleProviderOptions = z.infer<typeof openaiCompatibleProviderOptions>
