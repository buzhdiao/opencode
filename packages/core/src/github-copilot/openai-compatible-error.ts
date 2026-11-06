// 引入 zod 校验库与 ZodType 类型
import { z, type ZodType } from "zod/v4"

// OpenAI 兼容接口错误响应的数据结构定义
export const openaiCompatibleErrorDataSchema = z.object({
  // 错误对象
  error: z.object({
    // 错误消息文本
    message: z.string(),

    // The additional information below is handled loosely to support
    // OpenAI-compatible providers that have slightly different error
    // responses:
    // 错误类型（可选且可为 null，宽松兼容各家略有差异的响应）
    type: z.string().nullish(),
    // 出错的参数名（任意类型，宽松处理）
    param: z.any().nullish(),
    // 错误码（字符串或数字，宽松处理）
    code: z.union([z.string(), z.number()]).nullish(),
  }),
})

// 由 Schema 推导出的错误数据类型
export type OpenAICompatibleErrorData = z.infer<typeof openaiCompatibleErrorDataSchema>

// 提供商错误结构：描述如何校验错误体、提取消息以及判断是否可重试
export type ProviderErrorStructure<T> = {
  // 错误响应体的 zod 校验器
  errorSchema: ZodType<T>
  // 从解析后的错误数据中提取可读消息
  errorToMessage: (error: T) => string
  // 可选：根据响应与错误内容判断该请求是否可重试
  isRetryable?: (response: Response, error?: T) => boolean
}

// 默认的 OpenAI 兼容错误处理结构：使用上面的通用 schema 与 message 字段
export const defaultOpenAICompatibleErrorStructure: ProviderErrorStructure<OpenAICompatibleErrorData> = {
  // 使用通用错误数据 schema
  errorSchema: openaiCompatibleErrorDataSchema,
  // 错误消息取 error.message
  errorToMessage: (data) => data.error.message,
}
