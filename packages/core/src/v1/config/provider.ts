// 将本文件的所有导出聚合到命名空间 ConfigProviderV1 下，供统一引入
export * as ConfigProviderV1 from "./provider.js"

// effect 库：Schema 数据校验
import { Schema } from "effect"
// 通用 Schema：正整数
import { PositiveInt } from "../../schema.js"

// 模型状态枚举：alpha/beta/已弃用/正式
export const ModelStatus = Schema.Literals(["alpha", "beta", "deprecated", "active"])

// 模型（Model）配置 Schema
export const Model = Schema.Struct({
  // 模型 ID
  id: Schema.optional(Schema.String),
  // 显示名称
  name: Schema.optional(Schema.String),
  // 模型家族
  family: Schema.optional(Schema.String),
  // 发布日期
  release_date: Schema.optional(Schema.String),
  // 是否支持附件
  attachment: Schema.optional(Schema.Boolean),
  // 是否支持推理
  reasoning: Schema.optional(Schema.Boolean),
  // 是否支持温度参数
  temperature: Schema.optional(Schema.Boolean),
  // 是否支持工具调用
  tool_call: Schema.optional(Schema.Boolean),
  // 是否支持交错思考：布尔、字符串或指定字段名
  interleaved: Schema.optional(
    Schema.Union([
      // 布尔开关
      Schema.Boolean,
      // 字符串形式
      Schema.String,
      // 结构形式：指定字段名
      Schema.Struct({
        field: Schema.String,
      }),
    ]),
  ),
  // 计费信息（每 token 单价）
  cost: Schema.optional(
    Schema.Struct({
      // 输入单价
      input: Schema.Finite,
      // 输出单价
      output: Schema.Finite,
      // 缓存读取单价
      cache_read: Schema.optional(Schema.Finite),
      // 缓存写入单价
      cache_write: Schema.optional(Schema.Finite),
      // 超过 200k 上下文的计费（可选）
      context_over_200k: Schema.optional(
        Schema.Struct({
          // 超长输入单价
          input: Schema.Finite,
          // 超长输出单价
          output: Schema.Finite,
          // 超长缓存读取单价
          cache_read: Schema.optional(Schema.Finite),
          // 超长缓存写入单价
          cache_write: Schema.optional(Schema.Finite),
        }),
      ),
    }),
  ),
  // 上下文限制
  limit: Schema.optional(
    Schema.Struct({
      context: Schema.optional(Schema.Finite),
      input: Schema.optional(Schema.Finite),
      output: Schema.optional(Schema.Finite),
    }),
  ),
  // 支持的输入/输出模态
  modalities: Schema.optional(
    Schema.Struct({
      // 输入模态列表（文本/音频/图像/视频/PDF）
      input: Schema.optional(Schema.mutable(Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"])))),
      // 输出模态列表
      output: Schema.optional(
        Schema.mutable(Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"]))),
      ),
    }),
  ),
  // 是否为实验性模型
  experimental: Schema.optional(Schema.Boolean),
  // 模型状态
  status: Schema.optional(ModelStatus),
  // 提供商 SDK 信息：npm 包名与 API 标识
  provider: Schema.optional(
    Schema.Struct({ npm: Schema.optional(Schema.String), api: Schema.optional(Schema.String) }),
  ),
  // 模型级选项（任意键值）
  options: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
  // 模型级请求头
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  // 模型变体配置（键为变体名）
  variants: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.StructWithRest(
        Schema.Struct({
          // 是否禁用该变体
          disabled: Schema.optional(Schema.Boolean).annotate({ description: "Disable this variant for the model" }),
        }),
        // 变体允许携带任意附加键值
        [Schema.Record(Schema.String, Schema.Any)],
      ),
    ).annotate({ description: "Variant-specific configuration" }),
  ),
})

// 提供商（Provider）配置 Schema
export const Info = Schema.Struct({
  // API 标识
  api: Schema.optional(Schema.String),
  // 显示名称
  name: Schema.optional(Schema.String),
  // 需要的环境变量名列表
  env: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  // 提供商 ID
  id: Schema.optional(Schema.String),
  // SDK 的 npm 包名
  npm: Schema.optional(Schema.String),
  // 模型白名单
  whitelist: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  // 模型黑名单
  blacklist: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  // 提供商级选项（固定字段 + 任意附加字段）
  options: Schema.optional(
    Schema.StructWithRest(
      Schema.Struct({
        // API 密钥
        apiKey: Schema.optional(Schema.String),
        // 接口基础地址
        baseURL: Schema.optional(Schema.String),
        // GitHub Enterprise URL（copilot 认证用）
        enterpriseUrl: Schema.optional(Schema.String).annotate({
          description: "GitHub Enterprise URL for copilot authentication",
        }),
        // 是否为该提供商启用 promptCacheKey（默认 false）
        setCacheKey: Schema.optional(Schema.Boolean).annotate({
          description: "Enable promptCacheKey for this provider (default false)",
        }),
        // 完整请求超时（毫秒；false 表示禁用）
        timeout: Schema.optional(Schema.Union([PositiveInt, Schema.Literal(false)])).annotate({
          description: "Timeout in milliseconds for full requests to this provider. Set to false to disable timeout.",
        }),
        // 响应头等待超时（毫秒；false 表示禁用）
        headerTimeout: Schema.optional(Schema.Union([PositiveInt, Schema.Literal(false)])).annotate({
          description:
            "Timeout in milliseconds to wait for response headers. Provider integrations may set defaults. Set to false to disable timeout.",
        }),
        // SSE 流式分块间超时（毫秒；超窗未到块则中止请求）
        chunkTimeout: Schema.optional(PositiveInt).annotate({
          description:
            "Timeout in milliseconds between streamed SSE chunks for this provider. If no chunk arrives within this window, the request is aborted.",
        }),
      }),
      // 允许任意附加选项键值
      [Schema.Record(Schema.String, Schema.Any)],
    ),
  ),
  // 该提供商的模型配置表（键为模型名）
  models: Schema.optional(Schema.Record(Schema.String, Model)),
  // 标注 Schema 标识符
}).annotate({ identifier: "ProviderConfig" })
// Info 的 TypeScript 类型
export type Info = Schema.Schema.Type<typeof Info>
