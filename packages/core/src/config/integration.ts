// 配置集成（Config Integration）模块：处理由集成连接（如 OpenCode Console）下发的远程配置文档。
export * as ConfigIntegration from "./integration.js"

// 导入 Effect 的 Option（可选值）与 Schema（模式校验）工具。
import { Option, Schema, SchemaGetter } from "effect"
// 导入配置文档基类与条目（Entry）类型。
import { Config, type Entry } from "@opencode/schema/config"
// 导入 MCP（Model Context Protocol）配置模式。
import { ConfigMCP } from "@opencode/schema/config/mcp"
// 导入策略（policy）配置模式。
import { ConfigPolicy } from "@opencode/schema/config/policy"
// 导入提供方（provider）配置模式。
import { ConfigProvider } from "@opencode/schema/config/provider"
// 导入连接（Connection）信息模式。
import { Connection } from "@opencode/schema/connection"
// 导入集成标识（IntegrationID）模式。
import { IntegrationID } from "@opencode/schema/integration-id"

// Drop statements whose action or effect is a value this version does not know, so a newer remote source can
// extend either enum. Malformed statements still fail validation.
// 策略列表模式：丢弃本版本不认识的 action 或 effect 取值的语句，让更新的远程来源可以扩展这两个枚举；格式错误的语句仍会校验失败。
export const Policies = Schema.Array(Schema.Unknown).pipe(
  // 解码阶段：先按 Unknown 数组接收，再过滤掉无法识别的策略。
  Schema.decodeTo(Schema.Unknown, {
    // 对每个策略对象做宽松结构检查并过滤。
    decode: SchemaGetter.transform((policies) =>
      // 保留所有可识别的策略项。
      policies.filter((policy) => {
        // 尝试把策略解码为含 action 字符串字段的结构。
        const action = Schema.decodeUnknownOption(Schema.Struct({ action: Schema.String }))(policy)
        // 若 action 可读取但取值不在已知枚举中，则丢弃该策略。
        if (Option.isSome(action) && !Schema.is(ConfigPolicy.Action)(action.value.action)) return false
        // 尝试把策略解码为含 effect 字符串字段的结构。
        const effect = Schema.decodeUnknownOption(Schema.Struct({ effect: Schema.String }))(policy)
        // effect 缺失时保留；effect 存在则必须是已知枚举值。
        return Option.isNone(effect) || Schema.is(ConfigPolicy.Effect)(effect.value.effect)
      }),
    ),
    // 编码阶段：直接透传，不做严格校验。
    encode: SchemaGetter.passthrough({ strict: false }),
  }),
  // 最终解码为目标类型 ConfigPolicy.Info 数组。
  Schema.decodeTo(Schema.Array(ConfigPolicy.Info)),
)

/**
 * The allow-listed keys of a remote config. Only these keys are read before decoding, so a newer remote source's
 * other keys, valid or not, can never reject the document.
 */
// 远程配置的键白名单（allow-list）：解码前只读取这些键，因此更新的远程来源带来的其他键无论有效与否都不会导致文档被拒。
export const Remote = Schema.Struct({
  // 允许的提供方定义。
  providers: Config.Info.fields.providers,
  // 允许的 MCP 服务器定义。
  mcp: Config.Info.fields.mcp,
  // 允许的策略列表（可选）。
  policies: Policies.pipe(Schema.optional),
  // 允许的网络搜索选择。
  websearch: Config.Info.fields.websearch,
})
// 由模式推导出的 Remote 类型。
export type Remote = typeof Remote.Type

/**
 * A config document delivered by an integration connection, such as the OpenCode Console's config. Config loads it
 * right after managed policies, so user and project config override its settings while its policies outrank theirs.
 * Its providers authenticate with, and only exist for, that connection.
 */
// 集成连接下发的配置文档：例如 OpenCode Console 的配置。加载顺序紧跟托管策略之后，因此用户与项目配置可覆盖其设置，
// 而其策略优先级高于二者；其提供方通过该连接鉴权，也只为该连接而存在。
export class Document extends Config.Document.extend<Document>("Config.IntegrationDocument")({
  // 下发该文档的集成标识。
  integrationID: IntegrationID,
  // 该集成的活动连接信息。
  connection: Connection.Info,
  /** Organization behind the connection, named in denials by the document's policies. */
  // 连接背后的组织名，文档策略拒绝（deny）时会提及它（可选）。
  organization: Schema.optional(Schema.String),
}) {}

/**
 * A config document a well-known origin delivers. `integrationID` is the origin, so `integration.use` decides the
 * providers it defines by the origin rather than by provider ID.
 */
// 由知名来源（well-known origin）下发的配置文档：integrationID 即来源本身，因此 integration.use 按来源而非提供方 ID 来裁决其定义的提供方。
export class WellKnownDocument extends Config.Document.extend<WellKnownDocument>("Config.WellKnownDocument")({
  // 作为来源标识的集成 ID。
  integrationID: IntegrationID,
}) {}

/** The integration whose delivered document last defines each provider. */
// 计算每个提供方最终由哪个集成的文档定义：返回 提供方ID → 集成ID 的映射。
export function suppliers(entries: readonly Entry[]) {
  return new Map(
    entries
      // 只保留知名来源文档。
      .filter((entry): entry is WellKnownDocument => entry instanceof WellKnownDocument)
      // 展开为 [提供方ID, 集成ID] 对，后出现的文档覆盖先前的定义。
      .flatMap((document) => Object.keys(document.info.providers ?? {}).map((id) => [id, document.integrationID])),
  )
}

/**
 * Builds an integration document from the allow-listed keys of a remote config: providers, remote MCP servers,
 * policies, and the web search selection. A remote source can never load plugins, run commands, or change any
 * other local behavior through config.
 */
// 用远程配置白名单内的键构建集成文档：提供方、远程 MCP 服务器、策略与网络搜索选择。远程来源永远无法借配置加载插件、执行命令或改变其他本地行为。
export function make(input: {
  // 下发文档的集成 ID。
  readonly integrationID: IntegrationID
  // 关联的连接信息。
  readonly connection: Connection.Info
  // 可选的组织名。
  readonly organization?: string
  // 白名单内的远程配置内容。
  readonly info: Remote
}) {
  // 取出远程 MCP 服务器定义。
  const servers = input.info.mcp?.servers
  // 构造集成配置文档。
  return new Document({
    // 文档类型标记。
    type: "document",
    // 记录集成 ID。
    integrationID: input.integrationID,
    // 记录连接信息。
    connection: input.connection,
    // 记录组织名。
    organization: input.organization,
    // 组装文档携带的配置信息。
    info: new Config.Info({
      // 远程提供方：存在时逐个转换。
      providers:
        input.info.providers &&
        Object.fromEntries(
          Object.entries(input.info.providers).map(([id, provider]) => [
            // 保留原提供方 ID。
            id,
            // 转换为运行时的提供方信息。
            new ConfigProvider.Info({
              // 展开远程提供方的原始字段。
              ...provider,
              // The connection supplies credentials; `env` would read local variables as this provider's key.
              // 清空 env：凭据由连接提供，读取本地环境变量会把本机密钥当作该提供方的密钥。
              env: undefined,
              // 写入剔除凭据后的设置。
              settings: withoutCredentials(provider.settings),
              // 模型列表：存在时逐个转换。
              models:
                provider.models &&
                Object.fromEntries(
                  Object.entries(provider.models).map(([modelID, model]) => [
                    // 保留原模型 ID。
                    modelID,
                    // 转换模型信息并剔除各层凭据。
                    {
                      // 展开原模型字段。
                      ...model,
                      // 剔除模型设置中的凭据。
                      settings: withoutCredentials(model.settings),
                      // 变体（variant）列表同样剔除凭据。
                      variants: model.variants?.map((variant) => ({
                        // 展开原变体字段。
                        ...variant,
                        // 剔除变体设置中的凭据。
                        settings: withoutCredentials(variant.settings),
                      })),
                    },
                  ]),
                ),
            }),
          ]),
        ),
      // Local servers would run a command on this machine.
      // MCP 服务器：只保留远程（remote）类型——本地服务器会在本机执行命令，必须剔除。
      mcp:
        servers &&
        new ConfigMCP.Info({
          // 过滤出 type 为 remote 的服务器。
          servers: Object.fromEntries(Object.entries(servers).filter(([, server]) => server.type === "remote")),
        }),
      // 透传远程策略列表。
      policies: input.info.policies,
      // 透传网络搜索选择。
      websearch: input.info.websearch,
    }),
  })
}

// 从设置对象中剔除 apiKey、authToken、accessToken 等凭据键，防止远程配置携带敏感信息。
function withoutCredentials<Value>(settings: Readonly<Record<string, Value>> | undefined) {
  return (
    settings &&
    Object.fromEntries(
      // 过滤掉三个凭据键后重建对象。
      Object.entries(settings).filter(([key]) => !["apiKey", "authToken", "accessToken"].includes(key)),
    )
  )
}
