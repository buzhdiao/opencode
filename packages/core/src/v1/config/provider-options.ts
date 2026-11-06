// 将本文件的所有导出聚合到命名空间 ConfigProviderOptionsV1 下，供统一引入
export * as ConfigProviderOptionsV1 from "./provider-options.js"

// 判断是否为普通对象的工具函数
import { isRecord } from "@opencode/util/record"

// 提供商选项类型：只读的键值记录
type Options = Readonly<Record<string, unknown>>

// 提供商解析结果：设置项、请求头与请求体覆盖
export interface ProviderResult {
  // 传给提供商 SDK 的设置
  readonly settings: Record<string, unknown>
  // 额外的请求头（可选）
  readonly headers?: Record<string, string>
  // 额外的请求体字段（可选）
  readonly body?: Record<string, unknown>
}

// 解析提供商级 options：拆出 headers/body 覆盖项，其余归入 settings
export function provider(options: Options): ProviderResult {
  // 取出 headers 选项
  const headers = options.headers
  // 取出 body 选项
  const body = options.body
  // 其余选项组成 settings
  const settings = Object.fromEntries(Object.entries(options).filter(([key]) => key !== "headers" && key !== "body"))
  // headers 是对象时过滤出值全为字符串的键值对，否则无覆盖
  const headerOverlay = isRecord(headers)
    ? Object.fromEntries(
        Object.entries(headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      )
    : undefined
  // body 是对象时浅拷贝为覆盖项，否则无覆盖
  const bodyOverlay = isRecord(body) ? { ...body } : undefined
  // 返回解析结果
  return {
    // 设置项
    settings,
    // 请求头覆盖
    headers: headerOverlay,
    // 请求体覆盖
    body: bodyOverlay,
  }
}

// 解析模型级 options：原样透传（全部传给 SDK）
export function model(options: Options) {
  // 浅拷贝返回
  return { ...options }
}

// Model options read before the request is built; v1's `@ai-sdk/openai-compatible` sent every other one verbatim
// in the request body.
// 兼容模式的保留键集合：请求构建前消费的选项；其余选项在旧版
// `@ai-sdk/openai-compatible` 中会原样进入请求体
const COMPATIBLE_KEYS = new Set([
  // API 密钥
  "apiKey",
  // 接口基础地址
  "baseURL",
  // 请求头
  "headers",
  // 请求体覆盖
  "body",
  // 额外请求体
  "extraBody",
  // 整体超时
  "timeout",
  // 分块超时
  "chunkTimeout",
  // 响应头超时
  "headerTimeout",
  // 禁用标记
  "disabled",
  // 推理力度
  "reasoningEffort",
  // 文本详略程度
  "textVerbosity",
  // 终端用户标识
  "user",
  // 严格 JSON Schema
  "strictJsonSchema",
])

// 解析兼容（openai-compatible）模型的 options：拆分为 settings 与额外请求体
export function compatibleModel(options: Options) {
  // 取出全部键值对
  const entries = Object.entries(options)
  // 非保留键的部分视为请求体附加字段
  const body = Object.fromEntries(entries.filter(([key]) => !COMPATIBLE_KEYS.has(key)))
  // 返回拆分结果
  return {
    // 保留键组成 settings
    settings: Object.fromEntries(entries.filter(([key]) => COMPATIBLE_KEYS.has(key))),
    // 请求体附加字段：为空时不携带
    body: Object.keys(body).length ? body : undefined,
  }
}
