// 将本文件的所有导出聚合到命名空间 ErrorSummary 下，供统一引入
export * as ErrorSummary from "./error-summary.js"

// effect 库：Option 可选值处理、Schema 数据校验
import { Option, Schema } from "effect"

// 错误对象的结构化解码器：只提取常见字段（名称/标签/消息/代码/errno/原因），字段均可缺省
const decode = Schema.decodeUnknownOption(
  Schema.Struct({
    // 错误名称
    name: Schema.optional(Schema.String),
    // effect 风格的错误标签
    _tag: Schema.optional(Schema.String),
    // 错误消息
    message: Schema.optional(Schema.String),
    // 错误码（字符串或数字）
    code: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
    // 系统错误号
    errno: Schema.optional(Schema.Number),
    // 引发本错误的原因（下层错误）
    cause: Schema.optional(Schema.Unknown),
  }),
)

/** Stacks are omitted; each entry keeps the classification and message of one error in the cause chain. */
// 把未知错误（含 cause 链）提炼为简短的错误摘要数组：省略堆栈，只保留分类与消息
export function from(error: unknown) {
  // 摘要结果列表
  const errors: { type: string; message?: string; code?: string | number; errno?: number }[] = []
  // 已处理过的错误对象集合（防止 cause 循环引用）
  const seen = new Set<unknown>()
  // 沿 cause 链向上遍历：最多 8 层且不重复访问
  while (error && !seen.has(error) && errors.length < 8) {
    // 记录当前错误已处理
    seen.add(error)
    // 尝试结构化解码当前错误
    const result = decode(error)
    // 解码失败（非对象等）则停止遍历
    if (Option.isNone(result)) break
    // 提取当前错误的分类与字段信息
    errors.push({
      // 分类：优先 _tag，其次 Error.name，再次解出的 name，最后 unknown
      type: result.value._tag ?? (error instanceof Error ? error.name : result.value.name) ?? "unknown",
      // 消息（空串视为无消息）
      message: result.value.message || undefined,
      // 错误码
      code: result.value.code,
      // 系统错误号
      errno: result.value.errno,
    })
    // 前进到下一个原因：Error 用其 cause，其余用解出的 cause
    error = error instanceof Error ? error.cause : result.value.cause
  }
  // 返回错误摘要数组
  return errors
}
