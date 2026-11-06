// 以命名空间形式导出 UsageLimits 模块
export * as UsageLimits from "./usage-limits.js"

// 引入模型 schema（预算中的模型条目用）
import { Model } from "@opencode/schema/model"
// 引入金额工具（美元金额构造）
import { Money } from "@opencode/schema/money"
// 引入提供方 ID schema
import { Provider } from "@opencode/schema/provider"
// 引入用量限制 schema（Info 与 Budget 字段）
import { UsageLimits } from "@opencode/schema/usage-limits"
// 引入位置级服务节点构造工具
import { makeLocationNode } from "@opencode/util/effect/app-node"
// 引入 HTTP 客户端节点
import { httpClient } from "@opencode/util/effect/app-node-platform"
// 引入 Effect 原语：Context、Duration、Effect、Layer（层）、Schema
import { Context, Duration, Effect, Layer, Schema } from "effect"
// 引入 HTTP 客户端工具
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
// 引入控制台（Console）访问工具
import { ConsoleAccess } from "./console-access.js"
// 仅引入凭证类型
import type { Credential } from "./credential.js"
// 引入集成服务（管理连接与凭证）
import { Integration } from "./integration.js"

// 重新导出用量信息类型
export const Info = UsageLimits.Info
export type Info = UsageLimits.Info

// 服务不可用错误
export class UnavailableError extends Schema.TaggedError<UnavailableError>()("UsageLimits.UnavailableError", {
  message: Schema.String,
}) {}

// 服务接口：读取当前登录工作区的用量限制
export interface Interface {
  /** The usage limits of the OpenCode Console workspace this location is signed in to, if it is. */
  // （中文）当前 Location 所登录（若已登录）的 OpenCode 控制台（Console）工作区的用量限制
  readonly get: () => Effect.Effect<Info | undefined, UnavailableError>
}

// 定义 UsageLimits 服务标记类
export class Service extends Context.Service<Service, Interface>()("@opencode/UsageLimits") {}

// 构建服务层
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 获取集成服务
    const integrations = yield* Integration.Service
    // 获取 HTTP 客户端
    const http = yield* HttpClient.HttpClient

    // （中文）读取用量限制
    const get = Effect.fn("UsageLimits.get")(function* () {
      // 取 "opencode" 集成的活动连接
      const connection = yield* integrations.connection.active(Integration.ID.make("opencode"))
      // 未登录则无用量信息
      if (!connection) return undefined
      // 解析连接为可用凭证；失败包装为 UnavailableError
      const credential = yield* integrations.connection
        .resolve(connection)
        .pipe(Effect.mapError((error) => new UnavailableError({ message: error.message })))
      // 无凭证或为外部（external）类型时不提供用量
      if (!credential || credential.type === "external") return undefined
      // 工作区 ID 来自凭证元数据中的 orgID
      const workspaceID = credential.metadata?.orgID
      // 非字符串则视为不可用
      if (typeof workspaceID !== "string") return undefined
      // 依据凭证确定控制台服务地址
      const server = ConsoleAccess.server(credential)
      // 并发读取预算与 Go 用量，整体限时 15 秒
      const [budgets, go] = yield* Effect.all(
        [readBudgets(http, server, credential), readGo(http, server, credential, workspaceID)],
        { concurrency: 2 },
      ).pipe(
        Effect.timeoutOrElse({
          duration: Duration.seconds(15),
          orElse: () => Effect.fail(new UnavailableError({ message: "OpenCode Console usage limits timed out" })),
        }),
      )
      // 组装用量信息：工作区、Go 用量（可选）与预算列表
      return {
        workspace: {
          id: workspaceID,
          ...(typeof credential.metadata?.orgName === "string" ? { name: credential.metadata.orgName } : {}),
          usageURL: `${server}/${workspaceID}/activity/overview`,
        },
        ...(go === undefined ? {} : { go }),
        budgets,
      }
    })

    // 组装服务实例
    return Service.of({ get })
  }),
)

// 导出位置级服务节点
export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Integration.node, httpClient],
})

// One budget as `GET /api/policies/current-budgets` describes it.
// （中文）`GET /api/policies/current-budgets` 返回的单条预算结构
const ConsoleBudget = Schema.Struct({
  ruleID: Schema.String,
  limitDollars: Schema.Finite,
  spentDollars: Schema.Finite,
  scope: UsageLimits.Budget.fields.scope,
  per: UsageLimits.Budget.fields.per,
  coverage: UsageLimits.Budget.fields.coverage,
  models: Schema.Array(
    Schema.Struct({
      providerID: Schema.String,
      modelID: Schema.String,
      name: Schema.String,
      spentDollars: Schema.optional(Schema.Finite),
    }),
  ),
  vendors: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  inputPriceAtLeast: Schema.optional(Schema.Finite),
  picked: Schema.Boolean,
  shared: Schema.Boolean,
  resetsAt: Schema.DateFromString,
})

// Go 用量计量器：状态、百分比与重置时间
const GoMeter = Schema.Struct({
  status: Schema.Literals(["ok", "rate-limited"]),
  percent: Schema.Finite,
  resetsAt: Schema.DateFromString,
})
// Go 用量响应：滚动/每周/每月三个计量器
const GoUsage = Schema.Struct({ usage: Schema.Struct({ rolling: GoMeter, weekly: GoMeter, monthly: GoMeter }) })

/** Every budget covering the member. Console refuses a service account's key with 403, and it has no budgets. */
// （中文）读取覆盖该成员的所有预算。控制台对服务账号（service account）密钥返回 403，此时视作没有预算。
function readBudgets(http: HttpClient.HttpClient, server: string, credential: Credential.Key | Credential.OAuth) {
  // 在独立作用域内执行请求
  return HttpClient.withScope(http)
    .execute(
      // 发起 GET 预算请求：接受 JSON 并附带凭证头
      HttpClientRequest.get(`${server}/api/policies/current-budgets`).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.setHeaders(ConsoleAccess.headers(credential)),
      ),
    )
    .pipe(
      Effect.flatMap((response) =>
        // 403 表示无预算（如服务账号），按空列表处理
        response.status === 403
          ? Effect.succeed([])
          : HttpClientResponse.filterStatusOk(response).pipe(
              // 按 schema 解析响应体
              Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Array(ConsoleBudget))),
              // 把控制台预算映射为内部预算结构
              Effect.map((budgets) =>
                budgets.map((budget) => ({
                  id: budget.ruleID,
                  limit: Money.USD.make(budget.limitDollars),
                  spent: Money.USD.make(budget.spentDollars),
                  scope: budget.scope,
                  per: budget.per,
                  coverage: budget.coverage,
                  models: budget.models.map((model) => ({
                    providerID: Provider.ID.make(model.providerID),
                    modelID: Model.ID.make(model.modelID),
                    name: model.name,
                    ...(model.spentDollars === undefined ? {} : { spent: Money.USD.make(model.spentDollars) }),
                  })),
                  vendors: budget.vendors.map((vendor) => vendor.name),
                  ...(budget.inputPriceAtLeast === undefined
                    ? {}
                    : { inputPriceAtLeast: Money.USDPerMillionTokens.make(budget.inputPriceAtLeast) }),
                  picked: budget.picked,
                  shared: budget.shared,
                  resetsAt: budget.resetsAt.getTime(),
                })),
              ),
            ),
      ),
      // 响应处理限定在响应作用域内
      Effect.scoped,
      // 任何错误统一包装为 UnavailableError
      Effect.mapError(
        (error) => new UnavailableError({ message: `OpenCode Console budgets are unavailable: ${error.message}` }),
      ),
    )
}

/**
 * The Go allowance, from the inference API that shares the Console's origin. Go refuses (403) a workspace the member
 * doesn't subscribe to Go in, which has no allowance to show.
 */
// （中文）Go（订阅）额度：来自与控制台同源（origin）的推理 API。成员未订阅 Go 的工作区会收到 403，
// 此时没有可展示的额度。
function readGo(
  http: HttpClient.HttpClient,
  server: string,
  credential: Credential.Key | Credential.OAuth,
  workspaceID: string,
) {
  // 在独立作用域内执行请求
  return HttpClient.withScope(http)
    .execute(
      // 请求 Go 用量接口（取服务器的 origin 拼路径）
      HttpClientRequest.get(`${new URL(server).origin}/zen/go/v1/usage`).pipe(
        HttpClientRequest.acceptJson,
        // OAuth 凭证用访问令牌，Key 凭证用密钥
        HttpClientRequest.bearerToken(credential.type === "oauth" ? credential.access : credential.key),
        // 附带组织 ID 头
        HttpClientRequest.setHeader("x-opencode-org-id", workspaceID),
      ),
    )
    .pipe(
      Effect.flatMap((response) =>
        // 未订阅 Go 的工作区返回 403，按无额度处理
        response.status === 403
          ? Effect.succeed(undefined)
          : HttpClientResponse.filterStatusOk(response).pipe(
              // 按 schema 解析用量响应体
              Effect.flatMap(HttpClientResponse.schemaBodyJson(GoUsage)),
              // 映射为内部计量器结构
              Effect.map((body) => ({
                rolling: meter(body.usage.rolling),
                weekly: meter(body.usage.weekly),
                monthly: meter(body.usage.monthly),
              })),
            ),
      ),
      // 响应处理限定在响应作用域内
      Effect.scoped,
      // 任何错误统一包装为 UnavailableError
      Effect.mapError(
        (error) => new UnavailableError({ message: `OpenCode Go usage is unavailable: ${error.message}` }),
      ),
    )
}

// （中文）把 Go 计量器映射为内部结构（limited 表示已被限流）
function meter(value: typeof GoMeter.Type) {
  return { percent: value.percent, limited: value.status === "rate-limited", resetsAt: value.resetsAt.getTime() }
}
