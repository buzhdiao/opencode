// 引入 zod 校验库
import { z } from "zod/v4"
// 引入 AI SDK 的 JSON 错误响应处理器工厂
import { createJsonErrorResponseHandler } from "@ai-sdk/provider-utils"

// OpenAI 错误响应体的数据结构定义
export const openaiErrorDataSchema = z.object({
  // 错误对象
  error: z.object({
    // 错误消息文本
    message: z.string(),

    // The additional information below is handled loosely to support
    // OpenAI-compatible providers that have slightly different error
    // responses:
    // 错误类型（可选且可为 null，宽松兼容）
    type: z.string().nullish(),
    // 出错的参数（任意类型，宽松兼容）
    param: z.any().nullish(),
    // 错误码（字符串或数字，宽松兼容）
    code: z.union([z.string(), z.number()]).nullish(),
  }),
})

// 由 Schema 推导出的错误数据类型
export type OpenAIErrorData = z.infer<typeof openaiErrorDataSchema>

// 请求失败响应的统一处理器：按 schema 解析错误体并抛出带消息的错误
export const openaiFailedResponseHandler = createJsonErrorResponseHandler({
  // 错误体校验 schema
  errorSchema: openaiErrorDataSchema,
  // 错误消息取 error.message
  errorToMessage: (data) => data.error.message,
})
