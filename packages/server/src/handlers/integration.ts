// 引入集成（Integration）核心服务：管理外部服务的发现、连接与授权
import { Integration } from "@opencode/core/integration"
import { Effect } from "effect"
// 引入 HTTP API 构建器与 Schema 工具（204 响应）
import { HttpApiBuilder, HttpApiSchema } from "effect/http-api"
// 引入本服务 API 定义
import { Api } from "../api"
// 引入协议层错误：集成未找到、集成方法未找到、集成未找到、无效请求
import {
  IntegrationAttemptNotFoundError,
  IntegrationMethodNotFoundError,
  IntegrationNotFoundError,
  InvalidRequestError,
} from "@opencode/protocol/errors"
// 引入 response 辅助：响应中附带 location 信息
import { response } from "../location"
// 引入 WellKnown 服务：从 well-known 地址发现集成
import { WellKnown } from "@opencode/core/wellknown"
// 引入配置（Config）服务
import { Config } from "@opencode/core/config"
// 引入托管策略（ManagedPolicy）：集中式允许/拒绝策略
import { ManagedPolicy } from "@opencode/core/managed-policy"

// 辅助 Effect：读取当前配置并编译出托管策略语句（statements）
const statements = Effect.fnUntraced(function* () {
  // 获取配置服务
  const config = yield* Config.Service
  // 从配置条目中解析出策略语句集合
  return ManagedPolicy.statements(yield* config.entries())
})

// MCP OAuth logins skip integration policy: whether an MCP server is available at all is decided by `mcp.use` and by
// managed policy withholding the documents of denied integrations.
// 判断集成是否来自 MCP：MCP OAuth 登录跳过 integration.connect 策略——MCP 服务器可用与否由 `mcp.use` 与托管策略（对被拒集成隐藏文档）决定
const isMcp = (integration: { readonly metadata?: { readonly source?: unknown } } | undefined) =>
  integration?.metadata?.source === "mcp"

// `integration.connect` decides which integrations are listed and can be connected. Credential creation shares it.
// requireConnectable：执行 integration.connect 策略检查，决定集成是否可列出/连接；凭证创建也复用该检查
export const requireConnectable = Effect.fnUntraced(function* (integrationID: Integration.ID) {
  // 获取集成服务
  const integrations = yield* Integration.Service
  // MCP 来源的集成不受该策略限制，直接放行
  if (isMcp(yield* integrations.get(integrationID))) return
  // 在 integration.connect 动作上匹配该集成 ID 的策略语句
  const denied = ManagedPolicy.match(yield* statements(), "integration.connect", integrationID)
  // 没有 deny 效果（无匹配或 allow）则放行
  if (denied?.effect !== "deny") return
  // 被策略拒绝：返回无效请求错误并标注策略种类
  return yield* new InvalidRequestError({
    message: `${denied.message}: connecting ${integrationID} is not allowed`,
    kind: "integration_policy",
  })
})

// authorize：把集成授权（Authorization）失败统一映射为无效请求错误
const authorize = <A, R>(effect: Effect.Effect<A, Integration.AuthorizationError, R>) =>
  effect.pipe(
    Effect.mapError(
      (error) =>
        new InvalidRequestError({
          // 优先透出底层原因消息；为空时使用通用提示
          message:
            error.cause instanceof Error && error.cause.message.trim() ? error.cause.message : "Authentication failed",
          // 标注错误种类为集成授权失败
          kind: "integration_authorization",
        }),
    ),
  )

// 导出 IntegrationHandler：注册 "server.integration" 分组处理器
export const IntegrationHandler = HttpApiBuilder.group(Api, "server.integration", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle(
        // 处理 integration.list：列出可用的集成（按策略过滤）
        "integration.list",
        Effect.fn(function* () {
          const service = yield* Integration.Service
          // 读取当前托管策略语句
          const current = yield* statements()
          return yield* response(
            service
              .list()
              .pipe(
                // 列表后过滤：MCP 集成放行；其余集成仅当策略未 deny 时可见
                Effect.map((integrations) =>
                  integrations.filter(
                    (integration) =>
                      isMcp(integration) ||
                      ManagedPolicy.decision(current, "integration.connect", integration.id) !== "deny",
                  ),
                ),
              ),
          )
        }),
      )
      .handle(
        // 处理 integration.get：按 ID 获取单个集成详情
        "integration.get",
        Effect.fn(function* (ctx) {
          // 获取集成服务
          const service = yield* Integration.Service
          // 查询该集成
          const integration = yield* service.get(ctx.params.integrationID)
          // 不存在则返回 IntegrationNotFoundError
          if (!integration)
            return yield* new IntegrationNotFoundError({
              integrationID: ctx.params.integrationID,
              message: `Integration not found: ${ctx.params.integrationID}`,
            })
          // 通过 response 包装返回集成详情
          return yield* response(Effect.succeed(integration))
        }),
      )
      .handle(
        // 处理 integration.wellknown.add：添加 well-known 来源的集成
        "integration.wellknown.add",
        Effect.fn(function* (ctx) {
          // 获取 WellKnown 服务
          const wellknown = yield* WellKnown.Service
          // 获取集成服务
          const integration = yield* Integration.Service
          // Well-known sources are integrations keyed by their origin as entered.
          // well-known 来源的集成以其源地址（origin）作为集成 ID，先去掉尾部斜杠再做策略检查
          yield* requireConnectable(Integration.ID.make(ctx.payload.url.replace(/\/+$/, "")))
          // 执行 well-known 发现并添加；失败映射为无效请求错误
          yield* wellknown
            .add(ctx.payload.url)
            .pipe(
              Effect.mapError(
                (error) => new InvalidRequestError({ message: error.message, kind: "well_known_discovery" }),
              ),
            )
          // 触发集成服务重新加载，使新来源生效
          yield* integration.reload()
          // 返回 204 无内容
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        // 处理 integration.connect.key：用 API 密钥（key）连接集成
        "integration.connect.key",
        Effect.fn(function* (ctx) {
          // 先做集成连接策略检查
          yield* requireConnectable(ctx.params.integrationID)
          // 获取集成服务
          const service = yield* Integration.Service
          // 确认集成存在，否则返回未找到错误
          if (!(yield* service.get(ctx.params.integrationID)))
            return yield* new IntegrationNotFoundError({
              integrationID: ctx.params.integrationID,
              message: `Integration not found: ${ctx.params.integrationID}`,
            })
          // 执行密钥连接授权；失败经 authorize 映射错误
          yield* authorize(
            service.connection.key({
              integrationID: ctx.params.integrationID,
              key: ctx.payload.key,
              answer: ctx.payload.answer,
              label: ctx.payload.label,
            }),
          )
          // 返回 204 无内容
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        // 处理 integration.connect.external：走外部流程（如浏览器跳转）连接集成
        "integration.connect.external",
        Effect.fn(function* (ctx) {
          // 先做集成连接策略检查
          yield* requireConnectable(ctx.params.integrationID)
          // 获取集成服务
          const service = yield* Integration.Service
          // 确认集成存在
          if (!(yield* service.get(ctx.params.integrationID)))
            return yield* new IntegrationNotFoundError({
              integrationID: ctx.params.integrationID,
              message: `Integration not found: ${ctx.params.integrationID}`,
            })
          // 执行外部连接授权
          yield* authorize(
            service.connection.external({
              integrationID: ctx.params.integrationID,
              methodID: ctx.payload.methodID,
              answer: ctx.payload.answer,
              label: ctx.payload.label,
            }),
          )
          // 返回 204 无内容
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        // 处理 integration.oauth.connect：发起 OAuth 连接，返回授权尝试信息
        "integration.oauth.connect",
        Effect.fn(function* (ctx) {
          // 先做集成连接策略检查
          yield* requireConnectable(ctx.params.integrationID)
          // 获取集成服务
          const service = yield* Integration.Service
          // 执行 OAuth 发起并经 response 包装返回
          return yield* response(
            authorize(
              service.oauth.connect({
                integrationID: ctx.params.integrationID,
                methodID: ctx.payload.methodID,
                answer: ctx.payload.answer,
                label: ctx.payload.label,
              }),
            ),
          )
        }),
      )
      .handle(
        // 处理 integration.oauth.status：查询 OAuth 授权尝试的状态
        "integration.oauth.status",
        Effect.fn(function* (ctx) {
          // 获取集成服务
          const service = yield* Integration.Service
          // 确认集成存在
          if (!(yield* service.get(ctx.params.integrationID)))
            return yield* new IntegrationNotFoundError({
              integrationID: ctx.params.integrationID,
              message: `Integration not found: ${ctx.params.integrationID}`,
            })
          return yield* response(
            service.oauth
              .status({
                integrationID: ctx.params.integrationID,
                attemptID: ctx.params.attemptID,
              })
              .pipe(
                // 尝试不存在时映射为 IntegrationAttemptNotFoundError
                Effect.mapError(
                  (error) =>
                    new IntegrationAttemptNotFoundError({
                      integrationID: error.integrationID,
                      attemptID: error.attemptID,
                      message: `OAuth attempt not found: ${error.attemptID}`,
                    }),
                ),
              ),
          )
        }),
      )
      .handle(
        // 处理 integration.oauth.complete：用授权码（code）完成 OAuth 流程
        "integration.oauth.complete",
        Effect.fn(function* (ctx) {
          // 获取集成服务
          const service = yield* Integration.Service
          // 确认集成存在
          if (!(yield* service.get(ctx.params.integrationID)))
            return yield* new IntegrationNotFoundError({
              integrationID: ctx.params.integrationID,
              message: `Integration not found: ${ctx.params.integrationID}`,
            })
          // 提交授权码完成流程；按错误类型分别映射
          yield* service.oauth
            .complete({
              integrationID: ctx.params.integrationID,
              attemptID: ctx.params.attemptID,
              code: ctx.payload.code,
            })
            .pipe(
              Effect.mapError((error) => {
                // 尝试不存在 -> IntegrationAttemptNotFoundError
                if (error._tag === "Integration.AttemptNotFound")
                  return new IntegrationAttemptNotFoundError({
                    integrationID: error.integrationID,
                    attemptID: error.attemptID,
                    message: `OAuth attempt not found: ${error.attemptID}`,
                  })
                // 缺少授权码 -> InvalidRequestError
                if (error._tag === "Integration.CodeRequired")
                  return new InvalidRequestError({
                    message: "Authorization code is required",
                    kind: "integration_code_required",
                  })
                // 其余按授权失败处理（透出底层原因）
                return new InvalidRequestError({
                  message:
                    error.cause instanceof Error && error.cause.message.trim()
                      ? error.cause.message
                      : "Authentication failed",
                  kind: "integration_authorization",
                })
              }),
            )
          // 返回 204 无内容
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        // 处理 integration.oauth.cancel：取消进行中的 OAuth 授权尝试
        "integration.oauth.cancel",
        Effect.fn(function* (ctx) {
          // 获取集成服务
          const service = yield* Integration.Service
          // 执行取消
          yield* service.oauth.cancel({
            integrationID: ctx.params.integrationID,
            attemptID: ctx.params.attemptID,
          })
          // 返回 204 无内容
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        // 处理 integration.command.connect：通过本地命令流程连接集成
        "integration.command.connect",
        Effect.fn(function* (ctx) {
          // 先做集成连接策略检查
          yield* requireConnectable(ctx.params.integrationID)
          // 获取集成服务
          const service = yield* Integration.Service
          // 确认集成存在
          const integration = yield* service.get(ctx.params.integrationID)
          if (!integration)
            return yield* new IntegrationNotFoundError({
              integrationID: ctx.params.integrationID,
              message: `Integration not found: ${ctx.params.integrationID}`,
            })
          // 确认请求的命令方法（methodID）确实存在于该集成
          if (!integration.methods.some((method) => method.type === "command" && method.id === ctx.payload.methodID))
            return yield* new IntegrationMethodNotFoundError({
              integrationID: ctx.params.integrationID,
              methodID: ctx.payload.methodID,
              message: `Integration method not found: ${ctx.payload.methodID}`,
            })
          // 执行命令连接授权并经 response 包装返回
          return yield* response(
            authorize(
              service.command.connect({
                integrationID: ctx.params.integrationID,
                methodID: ctx.payload.methodID,
                label: ctx.payload.label,
              }),
            ),
          )
        }),
      )
      .handle(
        // 处理 integration.command.status：查询命令连接尝试的状态
        "integration.command.status",
        Effect.fn(function* (ctx) {
          // 获取集成服务
          const service = yield* Integration.Service
          // 确认集成存在
          if (!(yield* service.get(ctx.params.integrationID)))
            return yield* new IntegrationNotFoundError({
              integrationID: ctx.params.integrationID,
              message: `Integration not found: ${ctx.params.integrationID}`,
            })
          return yield* response(
            service.command
              .status({
                integrationID: ctx.params.integrationID,
                attemptID: ctx.params.attemptID,
              })
              .pipe(
                // 尝试不存在时映射为 IntegrationAttemptNotFoundError
                Effect.mapError(
                  (error) =>
                    new IntegrationAttemptNotFoundError({
                      integrationID: error.integrationID,
                      attemptID: error.attemptID,
                      message: `Command attempt not found: ${error.attemptID}`,
                    }),
                ),
              ),
          )
        }),
      )
      .handle(
        // 处理 integration.command.cancel：取消进行中的命令连接尝试
        "integration.command.cancel",
        Effect.fn(function* (ctx) {
          // 获取集成服务
          const service = yield* Integration.Service
          // 执行取消
          yield* service.command.cancel({
            integrationID: ctx.params.integrationID,
            attemptID: ctx.params.attemptID,
          })
          // 返回 204 无内容
          return HttpApiSchema.NoContent.make()
        }),
      )
  }),
)
