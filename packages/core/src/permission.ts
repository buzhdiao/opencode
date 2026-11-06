// 末尾自导出：便于 `import { Permission } from "./permission.js"` 引用命名空间
export * as Permission from "./permission.js"

// 导入 makeLocationNode：把服务包装成位置（location）节点
import { makeLocationNode } from "@opencode/util/effect/app-node"
// 从 effect 库导入 Context（服务上下文）、Deferred（延迟值）、Effect（效果）、Layer（层）、Schema（模式）
import { Context, Deferred, Effect, Layer, Schema } from "effect"
// 导入 Permission 模式：规则、请求、回复等定义
import { Permission } from "@opencode/schema/permission"
// 仅导入 Tool 类型：工具（tool）上下文字段
import type { Tool } from "@opencode/schema/tool"
// 导入 Bus（事件总线）服务
import { Bus } from "./bus.js"
// 导入 Location（位置）服务
import { Location } from "./location.js"
// 导入 Agent 服务：解析代理（agent）的权限配置
import { Agent } from "./agent.js"
// 导入 SessionErrors：会话（session）相关错误类型
import { SessionErrors } from "./session/error.js"
// 导入 SessionSchema：会话 ID 等模式定义
import { SessionSchema } from "./session/schema.js"
// 导入 SessionStore：会话存储服务
import { SessionStore } from "./session/store.js"
// 导入 Wildcard：通配符匹配工具
import { Wildcard } from "./util/wildcard.js"
// 导入 PermissionSaved：已保存的权限授权记录服务
import { PermissionSaved } from "./permission/saved.js"
// 导入 PluginHooks：插件钩子（hooks）服务
import { PluginHooks } from "./plugin/hooks.js"

// 引用 Permission.Effect（allow/ask/deny 枚举）并以 Effect 名字导出
const PermissionEffect = Permission.Effect
// 以 Effect 名导出权限效果枚举
export { PermissionEffect as Effect }
// 转发导出 Rule（单条规则）与 Ruleset（规则集）定义
export { Rule, Ruleset } from "@opencode/schema/permission"
// 代理缺失权限配置时的默认规则集：全部拒绝（fail closed）
const missingAgentPermissions: Permission.Ruleset = [{ action: "*", resource: "*", effect: "deny" }]

// 导出 ID：权限请求 ID 的校验器
export const ID = Permission.ID
// 导出 ID 的类型别名
export type ID = typeof ID.Type

// 导出 Source：请求来源（工具调用等）定义
export const Source = Permission.Source
// 导出 Source 的类型别名
export type Source = typeof Source.Type

// 导出 Request：权限请求的完整结构
export const Request = Permission.Request
// 导出 Request 的类型别名
export type Request = typeof Request.Type

// 导出 Reply：用户回复（allow/always/reject）枚举
export const Reply = Permission.Reply
// 导出 Reply 的类型别名
export type Reply = typeof Reply.Type

// AssertInput：断言（assert/ask）一个权限时需要的输入；在 Request 基础上放宽 id/message
export interface AssertInput extends Omit<Request, "id" | "message"> {
  // 可选的请求 ID（缺省时生成）
  readonly id?: ID
  // 可选的代理 ID（缺省用会话的代理）
  readonly agent?: Agent.ID
}

/** The requester fields of a permission request made by a tool call. */
// invocation：从工具调用的上下文提取请求者字段（会话、代理、消息与工具 ID）
export const invocation = (context: Pick<Tool.Context, "sessionID" | "agent" | "messageID" | "id">) => ({
  // 会话 ID
  sessionID: context.sessionID,
  // 代理 ID
  agent: context.agent,
  // 来源：工具类型，附消息 ID 与工具调用 ID
  source: { type: "tool" as const, messageID: context.messageID, id: context.id },
})

// ReplyInput：用户对某个请求做出回复所需的输入
export interface ReplyInput {
  // 目标请求 ID
  readonly requestID: ID
  // 回复内容（allow/always/reject）
  readonly reply: Reply
  // 可选反馈消息（reject 时作为修正反馈传给模型）
  readonly message?: string
}

// AskResult：ask 的结果——请求 ID 与最终效果（allow/deny）
export interface AskResult {
  // 请求 ID
  readonly id: ID
  // 最终效果
  readonly effect: Permission.Effect
}

// 转发导出 @opencode/schema/permission 中的 Event（Asked/Replied 等事件）
export { Event } from "@opencode/schema/permission"

/**
 * Rules that settle a request which would otherwise ask, for work nobody is present to answer, such as a schedule's
 * check. A request they do not allow is denied. Configured denies still win, as they are evaluated first.
 */
// Unattended：无人值守场景（如定时任务的检查）使用的兜底规则集上下文引用。
// 会被询问的请求若未被这些规则允许则拒绝；已配置的拒绝规则仍优先（它们先求值）。
export const Unattended = Context.Reference<Permission.Ruleset | undefined>("@opencode/Permission/Unattended", {
  // 默认值：未设置（undefined）
  defaultValue: () => undefined,
})

// DeclinedError：用户拒绝了请求（无额外反馈）
export class DeclinedError extends Schema.TaggedError<DeclinedError>()("Permission.DeclinedError", {}) {}

// CorrectedError：用户拒绝并附带了反馈（feedback），用于把修正意见传回模型
export class CorrectedError extends Schema.TaggedError<CorrectedError>()("Permission.CorrectedError", {
  // 用户反馈文本
  feedback: Schema.String,
}) {
  // 错误消息即反馈内容
  override get message() {
    // 返回 feedback
    return this.feedback
  }
}

// BlockedError：规则直接拒绝请求（附带命中的规则、权限名、资源与原因）
export class BlockedError extends Schema.TaggedError<BlockedError>()("Permission.BlockedError", {
  // 相关规则集
  rules: Permission.Ruleset,
  // 权限动作名
  permission: Schema.String,
  // 被拒的资源列表
  resources: Schema.Array(Schema.String),
  // 可选的拒绝原因
  reason: Schema.String.pipe(Schema.optional),
}) {
  // 错误消息：有原因用原因，否则用默认文案
  override get message() {
    // 原因缺失时显示 "Permission denied: <permission>"
    return this.reason ?? `Permission denied: ${this.permission}`
  }
}

// NotFoundError：找不到指定 ID 的待处理请求
export class NotFoundError extends Schema.TaggedError<NotFoundError>()("Permission.NotFoundError", {
  // 请求 ID
  requestID: ID,
}) {}

// Error：本模块对外的失败类型并集
export type Error = BlockedError | CorrectedError

// evaluate：按规则集求值一次授权决定；取最后一条（findLast）匹配 action 与 resource 的规则
export function evaluate(action: string, resource: string, ...rulesets: Permission.Ruleset[]): Permission.Rule {
  // 无规则匹配时默认效果为 ask（需要询问）
  return (
    // 展平所有规则集后从后往前找第一条匹配的规则
    rulesets
      .flat()
      // 通配符匹配动作与资源
      .findLast((rule) => Wildcard.match(action, rule.action) && Wildcard.match(resource, rule.resource)) ?? {
      // 默认规则：动作保持，资源通配，效果为 ask
      action,
      resource: "*",
      effect: "ask",
    }
  )
}

// merge：把多个规则集按顺序拼接成单一规则集（后面的优先级更高）
export function merge(...rulesets: Permission.Ruleset[]): Permission.Ruleset {
  // 展平返回
  return rulesets.flat()
}

// Interface：Permission 服务的对外接口
export interface Interface {
  // 关闭服务：拒绝所有待处理请求
  readonly close: Effect.Effect<void>
  // ask：求值并可能创建待处理请求；非阻塞（立即返回效果）
  readonly ask: (input: AssertInput) => Effect.Effect<AskResult, SessionErrors.NotFoundError>
  // assert：求值并在需要询问时阻塞等待用户回复；拒绝/修正以失败返回
  readonly assert: (input: AssertInput) => Effect.Effect<void, Error | SessionErrors.NotFoundError>
  /** Fails only when the rules deny the request; never asks the user. */
  // assertNotDenied：仅当规则拒绝时失败；从不询问用户
  readonly assertNotDenied: (input: AssertInput) => Effect.Effect<void, BlockedError | SessionErrors.NotFoundError>
  /** True only when the rules already allow the request; never asks the user. */
  // allows：仅当规则已允许时返回 true；从不询问用户
  readonly allows: (input: AssertInput) => Effect.Effect<boolean, SessionErrors.NotFoundError>
  // reply：用户对请求做出回复
  readonly reply: (input: ReplyInput) => Effect.Effect<void, NotFoundError>
  // get：按 ID 取待处理请求
  readonly get: (id: ID) => Effect.Effect<Request | undefined>
  // forSession：列出某会话的全部待处理请求
  readonly forSession: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<Request>>
  // list：列出全部待处理请求
  readonly list: () => Effect.Effect<ReadonlyArray<Request>>
}

// 定义 Permission 服务标识：标签 "@opencode/Permission"
export class Service extends Context.Service<Service, Interface>()("@opencode/Permission") {}

// Pending：一条待用户处理的请求及其完成信号
interface Pending {
  // 请求内容
  readonly request: Request
  // 发起请求的代理（可选）
  readonly agent?: Agent.ID
  // Deferred：等待回复（失败=Declined/Corrected，成功=允许）
  readonly deferred: Deferred.Deferred<void, DeclinedError | CorrectedError>
}

// layer：Permission 服务的层实现
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 获取事件总线服务
    const bus = yield* Bus.Service
    // 获取位置服务（项目 ID 用于保存授权）
    const location = yield* Location.Service
    // 获取代理服务（解析代理权限）
    const agents = yield* Agent.Service
    // 获取会话存储服务（取会话的权限配置）
    const sessions = yield* SessionStore.Service
    // 获取已保存授权服务（"总是允许"持久化）
    const saved = yield* PermissionSaved.Service
    // 获取插件钩子服务（permission.evaluate 钩子）
    const hooks = yield* PluginHooks.Service
    // pending：请求 ID -> 待处理条目
    const pending = new Map<ID, Pending>()
    // closed：服务是否已关闭
    let closed = false

    // close：关闭服务——拒绝所有待处理请求并清空表
    const close = Effect.gen(function* () {
      // 标记已关闭（新请求会立即失败）
      closed = true
      // 对每个待处理请求：发布 Replied(reject) 并使对应 Deferred 失败
      yield* Effect.forEach(Array.from(pending.values()), (item) =>
        // 发布拒绝事件
        bus
          .publish(Permission.Event.Replied, {
            // 会话 ID
            sessionID: item.request.sessionID,
            // 请求 ID
            requestID: item.request.id,
            // 回复为拒绝
            reply: "reject",
          })
          // 事件发布后（无论成败）让等待方收到 DeclinedError
          .pipe(Effect.ensuring(Deferred.fail(item.deferred, new DeclinedError()))),
      )
      // 清空待处理表
      pending.clear()
      // 关闭过程不可被中断
    }).pipe(Effect.uninterruptible)
    // 注册终止器：服务关闭时执行 close
    yield* Effect.addFinalizer(() => close)

    // savedRules：读取项目级已保存的授权，转成 allow 规则
    const savedRules = Effect.fnUntraced(function* () {
      // 列出当前项目保存的授权记录
      return (yield* saved.list({ projectID: location.project.id })).map(
        // 每条记录转成 allow 规则
        (item): Permission.Rule => ({
          // 动作
          action: item.action,
          // 资源
          resource: item.resource,
          // 效果为允许
          effect: "allow",
        }),
      )
    })

    // configured：合并会话的代理权限与会话自身权限，得到生效规则集
    const configured = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, agentID?: Agent.ID) {
      // 读取会话；不存在时抛 NotFoundError
      const session = yield* sessions.get(sessionID)
      // 会话缺失返回错误
      if (!session) return yield* new SessionErrors.NotFoundError({ sessionID })
      // 解析代理：优先显式指定，否则用会话绑定的代理
      const agent = yield* agents.resolve(agentID ?? session.agent)
      // 合并代理权限（缺失则全拒）与会话权限
      return merge(agent?.permissions ?? missingAgentPermissions, session.permissions ?? [])
    })

    // denied：判断任一资源在规则集下被拒绝
    function denied(input: Pick<Request, "action" | "resources">, rules: Permission.Ruleset) {
      // 逐资源求值，任一 deny 即拒绝
      return input.resources.some((resource) => evaluate(input.action, resource, rules).effect === "deny")
    }

    // relevant：筛选出动作匹配该请求的规则（用于错误信息展示）
    function relevant(input: AssertInput, rules: Permission.Ruleset) {
      // 保留 action 匹配的规则
      return rules.filter((rule) => Wildcard.match(input.action, rule.action))
    }

    // evaluateInput：完整的权限求值流程（拒绝短路 -> 保存授权 -> 钩子 -> 无人值守处理）
    const evaluateInput = Effect.fnUntraced(function* (input: AssertInput) {
      // 取生效规则集
      const rules = yield* configured(input.sessionID, input.agent)
      // 配置里已显式拒绝时直接返回 deny（优先级最高）
      if (denied(input, rules)) return { effect: "deny" as const, rules }
      // 追加已保存的授权规则后再求值
      const all = [...rules, ...(yield* savedRules())]
      // 对每个资源求值
      const effects = input.resources.map((resource) => evaluate(input.action, resource, all).effect)
      // 任一资源需要询问则整体为 ask，否则 allow
      const effect: Permission.Effect = effects.includes("ask") ? "ask" : "allow"
      // 触发插件的 permission.evaluate 钩子（可修改效果与消息）
      const event = yield* hooks.trigger("permission", "evaluate", {
        // 会话 ID
        sessionID: input.sessionID,
        // 代理 ID
        agent: input.agent,
        // 动作
        action: input.action,
        // 资源列表
        resources: input.resources,
        // 元数据
        metadata: input.metadata,
        // 来源
        source: input.source,
        // 当前求值效果
        effect,
      })
      // 读取无人值守规则集（若在无人值守上下文中）
      const unattended = yield* Unattended
      // 钩子结果不是 ask、或不在无人值守场景时直接采用钩子结果
      if (event.effect !== "ask" || unattended === undefined)
        // 返回钩子的效果、消息与规则集
        return { effect: event.effect, message: event.message, rules: all }
      // 无人值守：把兜底规则集并入后再求值
      const settled = [...all, ...unattended]
      // 仅当全部资源都被允许才算允许
      const allowed = input.resources.every((resource) => evaluate(input.action, resource, settled).effect === "allow")
      // 允许则返回 allow（规则集仍用原集合）
      if (allowed) return { effect: "allow" as const, rules: all }
      // 否则拒绝，并说明"无人可批准"
      return {
        // 效果为拒绝
        effect: "deny" as const,
        // 拒绝原因
        message: `Permission ${input.action} needs approval, and nobody is present to give it`,
        // 规则集
        rules: all,
      }
    })

    // request：把输入整理成 Request 结构（含 ID 生成与元数据清洗）
    function request(input: AssertInput, message?: string): Request {
      // 返回请求对象
      return {
        // 请求 ID：输入自带或现场生成
        id: input.id ?? ID.create(),
        // 会话 ID
        sessionID: input.sessionID,
        // 动作
        action: input.action,
        // 资源列表
        resources: input.resources,
        // "总是允许"时要保存的资源
        save: input.save,
        // Tools copy optional inputs straight into metadata; undefined values are not JSON and would
        // fail the HttpApi response encoder when clients list pending requests.
        // 工具会把可选输入直接塞进 metadata；undefined 不是合法 JSON，
        // 会让客户端列出待处理请求时 HttpApi 响应编码失败，因此过滤掉。
        metadata:
          // 有元数据时过滤 undefined 值
          input.metadata &&
          // 重建为无 undefined 的记录
          Object.fromEntries(Object.entries(input.metadata).filter(([, value]) => value !== undefined)),
        // 来源
        source: input.source,
        // 附加消息（拒绝原因等）
        message,
      }
    }

    // create：注册待处理请求并广播 Asked 事件；返回条目
    const create = (request: Request, agent?: Agent.ID) =>
      // 注册过程不可中断，保证表与事件的一致性
      Effect.uninterruptible(
        Effect.gen(function* () {
          // 创建完成信号
          const deferred = yield* Deferred.make<void, DeclinedError | CorrectedError>()
          // 组装待处理条目
          const item = { request, agent, deferred }
          // 服务已关闭时立即失败并返回条目
          if (closed) {
            // 让等待方收到 DeclinedError
            yield* Deferred.fail(deferred, new DeclinedError())
            // 返回条目
            return item
          }
          // 请求 ID 重复属于缺陷：直接崩溃
          if (pending.has(request.id))
            // 抛出重复 ID 缺陷
            return yield* Effect.die(new Error(`Duplicate pending permission ID: ${request.id}`))
          // 登记到待处理表
          pending.set(request.id, item)
          // 广播 Asked 事件；发布失败时撤销登记
          yield* bus
            .publish(Permission.Event.Asked, request)
            // 出错时从表中移除
            .pipe(Effect.onError(() => Effect.sync(() => pending.delete(request.id))))
          // 返回条目
          return item
        }),
      )

    // ask：求值一次；效果为 ask 时仅创建待处理请求（不阻塞），立即返回结果
    const ask = Effect.fn("Permission.ask")(function* (input: AssertInput) {
      // 服务已关闭时直接拒绝
      if (closed) return { id: input.id ?? ID.create(), effect: "deny" as const }
      // 求值
      const result = yield* evaluateInput(input)
      // 构造请求
      const value = request(input, result.message)
      // 需要询问时创建待处理请求（广播事件）
      if (result.effect === "ask") yield* create(value, input.agent)
      // 返回请求 ID 与效果
      return { id: value.id, effect: result.effect }
    })

    // assert：求值并在需要时阻塞等待用户回复
    const assert = Effect.fn("Permission.assert")((input: AssertInput) =>
      Effect.gen(function* () {
        // 服务已关闭属于缺陷：直接崩溃并附 DeclinedError
        if (closed) return yield* Effect.die(new DeclinedError())
        // 求值
        const result = yield* evaluateInput(input)
        // 用不可中断掩码包裹等待：登记/清理不受中断影响，等待本身可中断
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            // 规则拒绝时抛 BlockedError
            if (result.effect === "deny") {
              // 返回失败
              return yield* new BlockedError({
                // 附动作匹配的规则
                rules: relevant(input, result.rules),
                // 权限动作名
                permission: input.action,
                // 资源列表
                resources: input.resources,
                // 拒绝原因
                reason: result.message,
              })
            }
            // 已允许则直接通过
            if (result.effect === "allow") return
            // 需要询问：创建待处理请求并等待回复
            const item = yield* create(request(input, result.message), input.agent)
            // 等待 Deferred 完成（可被中断）
            return yield* restore(Deferred.await(item.deferred)).pipe(
              // Deliberate defect tunnel: leaves wrap execution in blanket `mapError`, which
              // must not convert a user's decline into model-facing tool output. The decline
              // resurfaces as a typed failure at SessionModelRequest.executeTool. A decline
              // WITH feedback (CorrectedError) intentionally stays typed so the leaf can turn
              // it into ToolFailure and the model continues.
              // 故意的缺陷隧道：外层会用一刀切的 mapError 包住执行，
              // 不能把用户的拒绝变成面向模型的工具输出。拒绝会在
              // SessionModelRequest.executeTool 处重新浮现为类型化失败；
              // 带反馈的拒绝（CorrectedError）保持类型化，由叶子层转成 ToolFailure 让模型继续。
              Effect.catchTag("Permission.DeclinedError", (error) => Effect.die(error)),
              // 无论成功失败都从待处理表移除该请求
              Effect.ensuring(
                Effect.sync(() => {
                  // 移除登记
                  pending.delete(item.request.id)
                }),
              ),
            )
          }),
        )
      }),
    )

    // assertNotDenied：只做拒绝检查，需要询问时静默放行（不阻塞）
    const assertNotDenied = Effect.fn("Permission.assertNotDenied")(function* (input: AssertInput) {
      // 求值
      const result = yield* evaluateInput(input)
      // 非拒绝（allow/ask）时通过
      if (result.effect !== "deny") return
      // 拒绝时抛 BlockedError
      return yield* new BlockedError({
        // 附动作匹配的规则
        rules: relevant(input, result.rules),
        // 权限动作名
        permission: input.action,
        // 资源列表
        resources: input.resources,
        // 拒绝原因
        reason: result.message,
      })
    })

    // allows：仅当规则已允许时返回 true；从不询问
    const allows = Effect.fn("Permission.allows")(function* (input: AssertInput) {
      // 服务已关闭时不允许
      if (closed) return false
      // 求值并判断是否为 allow
      return (yield* evaluateInput(input)).effect === "allow"
    })

    // reply：用户回复某个请求；处理拒绝/总是允许的联动语义
    const reply = Effect.fn("Permission.reply")((input: ReplyInput) =>
      // 回复处理不可中断
      Effect.uninterruptible(
        Effect.gen(function* () {
          // 查找待处理条目
          const existing = pending.get(input.requestID)
          // 找不到时抛 NotFoundError
          if (!existing) return yield* new NotFoundError({ requestID: input.requestID })
          // 广播该请求的回复事件
          yield* bus.publish(Permission.Event.Replied, {
            // 会话 ID
            sessionID: existing.request.sessionID,
            // 请求 ID
            requestID: existing.request.id,
            // 用户回复
            reply: input.reply,
          })

          // 拒绝：拒绝该请求并联动拒绝同会话的全部待处理请求
          if (input.reply === "reject") {
            // 让目标请求的等待方失败：有反馈用 CorrectedError，否则 DeclinedError
            yield* Deferred.fail(
              // 目标信号
              existing.deferred,
              // 按有无反馈选择错误类型
              input.message ? new CorrectedError({ feedback: input.message }) : new DeclinedError(),
            )
            // 从表中移除目标请求
            pending.delete(input.requestID)
            // 遍历其余待处理请求
            for (const [id, item] of pending) {
              // 跳过不同会话的请求
              if (item.request.sessionID !== existing.request.sessionID) continue
              // 广播该请求也被拒绝
              yield* bus.publish(Permission.Event.Replied, {
                // 会话 ID
                sessionID: item.request.sessionID,
                // 请求 ID
                requestID: item.request.id,
                // 回复为拒绝
                reply: "reject",
              })
              // Feedback applies to the whole batch, so parallel asks don't end the step.
              // 反馈适用于整批请求，让并行的询问不会中断当前步骤
              yield* Deferred.fail(
                // 该请求的信号
                item.deferred,
                // 同样按有无反馈选择错误类型
                input.message ? new CorrectedError({ feedback: input.message }) : new DeclinedError(),
              )
              // 从表中移除
              pending.delete(id)
            }
            // 拒绝分支到此结束
            return
          }

          // "总是允许"且请求标记了要保存的资源时，持久化授权
          if (input.reply === "always" && existing.request.save?.length) {
            // 写入项目级保存授权
            yield* saved.add({
              // 项目 ID
              projectID: location.project.id,
              // 动作
              action: existing.request.action,
              // 要保存的资源列表
              resources: existing.request.save,
            })
          }
          // 完成目标请求的等待
          yield* Deferred.succeed(existing.deferred, undefined)
          // 从表中移除目标请求
          pending.delete(input.requestID)
          // 非"总是允许"或没有要保存的资源时到此结束
          if (input.reply !== "always" || !existing.request.save?.length) return

          // "总是允许"联动：同会话中现在已变为允许的其他请求一并完成
          for (const [id, item] of pending) {
            // 重新求值该请求（忽略会话已消失的错误）
            const result = yield* evaluateInput({ ...item.request, agent: item.agent }).pipe(
              // 会话不存在时视为 undefined
              Effect.catchTag("Session.NotFoundError", () => Effect.undefined),
            )
            // 未变为允许的跳过
            if (result?.effect !== "allow") continue
            // 广播该请求被"总是允许"放行
            yield* bus.publish(Permission.Event.Replied, {
              // 会话 ID
              sessionID: item.request.sessionID,
              // 请求 ID
              requestID: item.request.id,
              // 回复为 always
              reply: "always",
            })
            // 完成其等待
            yield* Deferred.succeed(item.deferred, undefined)
            // 从表中移除
            pending.delete(id)
          }
        }),
      ),
    )

    // list：列出全部待处理请求
    const list = Effect.fn("Permission.list")(function* () {
      // 取每条待处理条目的请求
      return Array.from(pending.values(), (item) => item.request)
    })

    // get：按 ID 取待处理请求
    const get = Effect.fn("Permission.get")(function* (id: ID) {
      // 存在则返回请求，否则 undefined
      return pending.get(id)?.request
    })

    // forSession：列出指定会话的待处理请求
    const forSession = Effect.fn("Permission.forSession")(function* (sessionID: SessionSchema.ID) {
      // 过滤出会话匹配的请求
      return Array.from(pending.values(), (item) => item.request).filter((request) => request.sessionID === sessionID)
    })

    // 返回服务实现
    return Service.of({ ask, assert, assertNotDenied, allows, reply, get, forSession, list, close })
  }),
)

// 导出 node：把 Permission 服务挂到位置节点，并列出全部依赖节点
export const node = makeLocationNode({
  // 服务类型
  service: Service,
  // 服务层
  layer,
  // 依赖：总线、位置、代理、会话存储、保存授权、插件钩子
  deps: [Bus.node, Location.node, Agent.node, SessionStore.node, PermissionSaved.node, PluginHooks.node],
})
