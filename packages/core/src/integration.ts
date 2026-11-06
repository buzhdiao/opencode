// 将本模块以命名空间 Integration 的形式整体再导出
export * as Integration from "./integration.js"

// 引入 makeLocationNode：构造挂到位置标签下的服务节点
import { makeLocationNode } from "@opencode/util/effect/app-node"
// 从 effect 引入本模块所需工具：Cause、Clock、Context、Duration、Effect、Equal、Exit、Fiber、Layer、Schedule、Schema、Scope、Stream、SynchronizedRef、Types
import {
  Cause,
  Clock,
  Context,
  Duration,
  Effect,
  Equal,
  Exit,
  Fiber,
  Layer,
  Schedule,
  Schema,
  Scope,
  Stream,
  SynchronizedRef,
  Types,
} from "effect"
// 引入集成的模式定义（ID、方法、尝试、事件等）
import { Integration } from "@opencode/schema/integration"
// 引入凭据（Credential）服务与类型
import { Credential } from "./credential.js"
// 引入状态（State）工具：带编辑器与通知的可变换注册表
import { State } from "./state.js"
// 引入事件总线服务
import { Bus } from "./bus.js"
// 引入集成连接（IntegrationConnection）工具
import { IntegrationConnection } from "./integration/connection.js"
// 引入应用进程（AppProcess）服务：管理子进程与流收集
import { AppProcess } from "@opencode/util/process"
// 从 effect/process 引入子进程构造工具
import { ChildProcess } from "effect/process"
// 引入表单（Form）工具：字段校验与答案处理
import { Form } from "./form.js"

// 再导出集成 ID（模式与类型）
export const ID = Integration.ID
export type ID = Integration.ID

// 再导出方法 ID（模式与类型）
export const MethodID = Integration.MethodID
export type MethodID = Integration.MethodID

// 再导出尝试 ID（模式与类型）
export const AttemptID = Integration.AttemptID
export type AttemptID = typeof AttemptID.Type

// 再导出 OAuth 方法（模式与类型）
export const OAuthMethod = Integration.OAuthMethod
export type OAuthMethod = Integration.OAuthMethod

// 再导出命令方法（模式与类型）
export const CommandMethod = Integration.CommandMethod
export type CommandMethod = Integration.CommandMethod

// 再导出密钥方法（模式与类型）
export const KeyMethod = Integration.KeyMethod
export type KeyMethod = Integration.KeyMethod

// 再导出外部方法（模式与类型）
export const ExternalMethod = Integration.ExternalMethod
export type ExternalMethod = Integration.ExternalMethod

// 再导出环境变量方法（模式与类型）
export const EnvMethod = Integration.EnvMethod
export type EnvMethod = Integration.EnvMethod

// 再导出方法联合类型（模式与类型）
export const Method = Integration.Method
export type Method = Integration.Method

// 再导出集成信息（模式与类型）
export const Info = Integration.Info
export type Info = Integration.Info

// OAuth 授权信息：授权 URL、说明文字、可选过期时间，并区分自动/授权码两种模式
export type OAuthAuthorization = {
  readonly url: string
  readonly instructions: string
  readonly expiresAt?: number
} & (
  | {
      // auto 模式：回调效果自动完成授权
      readonly mode: "auto"
      readonly callback: Effect.Effect<Credential.OAuth, unknown>
      /** Hands `callback` the redirect URL a user pasted, for when the browser cannot reach this machine. */
      // submit：把用户粘贴的重定向 URL 交给回调，用于浏览器无法访问本机的场景
      readonly submit?: (redirect: string) => Effect.Effect<void, unknown>
    }
  | {
      // code 模式：用授权码换凭据
      readonly mode: "code"
      readonly callback: (code: string) => Effect.Effect<Credential.OAuth, unknown>
    }
)

// OAuth 实现接口：一个集成的 OAuth 方法及其授权/刷新/标签逻辑
export interface OAuthImplementation {
  readonly integrationID: ID
  readonly method: OAuthMethod
  readonly authorize: (answer: Form.Answer) => Effect.Effect<OAuthAuthorization, unknown, Scope.Scope>
  readonly refresh?: (credential: Credential.OAuth) => Effect.Effect<Credential.OAuth, unknown>
  readonly label?: (credential: Credential.OAuth) => string | undefined
}

// 密钥（key）实现接口：仅声明集成与方法
export interface KeyImplementation {
  readonly integrationID: ID
  readonly method: KeyMethod
}

// 外部（external）实现接口：凭据来源由外部系统管理
export interface ExternalImplementation {
  readonly integrationID: ID
  readonly method: ExternalMethod
}

// 命令（command）实现接口：通过运行命令取得凭据
export interface CommandImplementation {
  readonly integrationID: ID
  readonly method: CommandMethod
}

// 环境变量（env）实现接口：凭据来自环境变量
export interface EnvImplementation {
  readonly integrationID: ID
  readonly method: EnvMethod
}

// 实现联合类型：上述五种方法实现
export type Implementation =
  | OAuthImplementation
  | CommandImplementation
  | KeyImplementation
  | ExternalImplementation
  | EnvImplementation

// 再导出授权尝试（Attempt）模式与类型
export const Attempt = Integration.Attempt
export type Attempt = Integration.Attempt

// 再导出尝试状态模式与类型
export const AttemptStatus = Integration.AttemptStatus
export type AttemptStatus = typeof AttemptStatus.Type

// 再导出命令尝试模式与类型
export const CommandAttempt = Integration.CommandAttempt
export type CommandAttempt = Integration.CommandAttempt

// 再导出命令尝试状态模式与类型
export const CommandAttemptStatus = Integration.CommandAttemptStatus
export type CommandAttemptStatus = Integration.CommandAttemptStatus

// 错误：OAuth 完成时缺少授权码
export class CodeRequiredError extends Schema.TaggedError<CodeRequiredError>()("Integration.CodeRequired", {
  attemptID: AttemptID,
}) {}

// 错误：授权失败（携带底层原因）
export class AuthorizationError extends Schema.TaggedError<AuthorizationError>()("Integration.Authorization", {
  cause: Schema.Defect(),
}) {
  // 消息：优先取底层 Error 的 message，否则用通用文案
  override get message() {
    const cause = this.cause
    if (cause instanceof Error && cause.message) return cause.message
    return "Authorization failed"
  }
}

// 错误：找不到指定的授权尝试
export class AttemptNotFoundError extends Schema.TaggedError<AttemptNotFoundError>()("Integration.AttemptNotFound", {
  integrationID: ID,
  attemptID: AttemptID,
}) {}

// 本模块的错误联合类型
export type Error = CodeRequiredError | AuthorizationError | AttemptNotFoundError

// 再导出集成事件定义
export { Event } from "@opencode/schema/integration"

// 再导出集成引用（Ref）模式与类型
export const Ref = Integration.Ref
export type Ref = Integration.Ref

// 注册表条目：集成引用、方法列表与 OAuth 实现映射
type Entry = {
  ref: Types.DeepMutable<Ref>
  methods: Method[]
  implementations: Map<MethodID, OAuthImplementation>
}

// 状态数据：集成 ID 到条目的映射
type Data = {
  integrations: Map<ID, Entry>
}

// 编辑器接口：对集成注册表的增删改查与方法的增删改
export type Editor = {
  list: () => readonly Types.DeepMutable<Ref>[]
  get: (id: ID) => Types.DeepMutable<Ref> | undefined
  update: (id: ID, update: (integration: Types.DeepMutable<Ref>) => void) => void
  remove: (id: ID) => void
  method: {
    list: (integrationID: ID) => readonly Method[]
    update: (implementation: Implementation) => void
    remove: (integrationID: ID, method: Method) => void
  }
}

// 服务接口：继承状态的可变换（Transformable）能力，并暴露连接与 OAuth/命令流程
export interface Interface extends State.Transformable<Editor> {
  /** Revision of integration definitions; credential values remain owned by Credential. */
  // revision：集成定义的修订号；凭据值仍由 Credential 服务管理
  readonly revision: () => number
  /** Registers a scoped transform over the integration registry. */
  /** Returns one integration with its methods and current connections. */
  // get：返回单个集成及其方法与当前连接
  readonly get: (id: ID) => Effect.Effect<Info | undefined>
  /** Returns all integrations with their methods and current connections. */
  // list：返回全部集成及其方法与当前连接
  readonly list: () => Effect.Effect<Info[]>
  readonly connection: {
    /** Returns the active connection for one integration. */
    // active：返回某集成当前激活的连接
    readonly active: (id: ID) => Effect.Effect<IntegrationConnection.Info | undefined>
    /** Resolves a connection into credential material or an external credential-source reference. */
    // resolve：把连接解析成凭据内容（必要时刷新 OAuth 令牌）
    readonly resolve: (
      connection: IntegrationConnection.Info,
    ) => Effect.Effect<Credential.Value | undefined, AuthorizationError>
    /** Runs a key method and stores the resulting credential. */
    // key：保存用户输入的密钥凭据
    readonly key: (input: {
      /** Integration receiving the credential. */
      // 接收凭据的集成
      readonly integrationID: ID
      /** Secret entered by the user. */
      // 用户输入的密钥
      readonly key: string
      /** Values collected from the method's form fields. */
      // 从方法表单收集的答案
      readonly answer?: Form.Answer
      /** User-facing label for the stored credential. */
      // 存储凭据的展示标签
      readonly label?: string
    }) => Effect.Effect<void, AuthorizationError>
    /** Runs an external method and stores a reference configured by its form answers. */
    // external：保存外部凭据引用（由表单答案配置）
    readonly external: (input: {
      /** Integration receiving the credential. */
      // 接收凭据的集成
      readonly integrationID: ID
      /** External method that defines the form and credential source. */
      // 定义表单与凭据来源的外部方法
      readonly methodID: MethodID
      /** Values collected from the method's form fields. */
      // 从方法表单收集的答案
      readonly answer?: Form.Answer
      /** User-facing label for the stored credential. */
      // 存储凭据的展示标签
      readonly label?: string
    }) => Effect.Effect<void, AuthorizationError>
    /** Selects a stored credential as the active integration connection. */
    // activate：把某个存储凭据设为激活连接
    readonly activate: (credentialID: Credential.ID) => Effect.Effect<void>
    /** Updates a stored credential exposed as a connection. */
    // update：更新作为连接暴露的存储凭据（如标签）
    readonly update: (
      credentialID: Credential.ID,
      updates: Partial<Pick<Credential.Info, "label">>,
    ) => Effect.Effect<void>
    /** Removes a stored credential connection. */
    // remove：删除存储凭据连接
    readonly remove: (credentialID: Credential.ID) => Effect.Effect<void>
    /** Reports or clears a runtime problem with a connection; `get` and `list` project it onto the connection. */
    // status：上报或清除连接的运行时问题；get/list 会把它投影到连接上
    readonly status: (input: {
      readonly integrationID: ID
      readonly connection: IntegrationConnection.Info
      readonly status: IntegrationConnection.Status | undefined
    }) => Effect.Effect<void>
  }
  readonly oauth: {
    /** Starts a stateful OAuth attempt. */
    // connect：发起一次有状态的 OAuth 授权尝试
    readonly connect: (input: {
      readonly integrationID: ID
      readonly methodID: MethodID
      readonly answer?: Form.Answer
      readonly label?: string
    }) => Effect.Effect<Attempt, AuthorizationError>
    /** Returns the current state of an OAuth attempt. */
    // status：查询 OAuth 尝试的当前状态
    readonly status: (input: {
      readonly integrationID: ID
      readonly attemptID: AttemptID
    }) => Effect.Effect<AttemptStatus, AttemptNotFoundError>
    /** Completes the attempt and stores its credential. */
    // complete：完成尝试并存储其凭据
    readonly complete: (input: {
      readonly integrationID: ID
      readonly attemptID: AttemptID
      readonly code?: string
    }) => Effect.Effect<void, CodeRequiredError | AuthorizationError | AttemptNotFoundError>
    /** Cancels an attempt and releases its resources. */
    // cancel：取消尝试并释放其资源
    readonly cancel: (input: { readonly integrationID: ID; readonly attemptID: AttemptID }) => Effect.Effect<void>
  }
  readonly command: {
    // connect：发起基于命令的授权尝试
    readonly connect: (input: {
      readonly integrationID: ID
      readonly methodID: MethodID
      readonly label?: string
    }) => Effect.Effect<CommandAttempt, AuthorizationError>
    // status：查询命令尝试的当前状态
    readonly status: (input: {
      readonly integrationID: ID
      readonly attemptID: AttemptID
    }) => Effect.Effect<CommandAttemptStatus, AttemptNotFoundError>
    // cancel：取消命令尝试
    readonly cancel: (input: { readonly integrationID: ID; readonly attemptID: AttemptID }) => Effect.Effect<void>
  }
}

// 定义 Integration 服务类：标识为 "@opencode/Integration"
export class Service extends Context.Service<Service, Interface>()("@opencode/Integration") {}

// 授权尝试存活时间：10 分钟
const attemptLifetime = Duration.toMillis(Duration.minutes(10))
// 终态尝试（完成/失败/过期）在内存的保留时间：1 分钟
const terminalRetention = Duration.toMillis(Duration.minutes(1))
// 清理（scrub）巡检间隔：30 秒
const scrubInterval = Duration.seconds(30)

// 尝试的时间信息：创建时间与过期时间
type AttemptTime = { created: number; expires: number }
// 待决 OAuth 尝试：正在等待授权完成
type PendingAttempt = {
  status: "pending"
  completing: boolean
  persisting: boolean
  authorization: OAuthAuthorization
  integrationID: ID
  methodID: MethodID
  label?: string
  scope: Scope.Closeable
  time: AttemptTime
}
// 终态尝试：已完成、失败或过期，到 removeAt 时清理
type TerminalAttempt = {
  status: "complete" | "failed" | "expired"
  integrationID: ID
  message?: string
  removeAt: number
  time: AttemptTime
}
// OAuth 尝试条目：待决或终态
type AttemptEntry = PendingAttempt | TerminalAttempt

// 待决命令尝试：等待命令产出凭据
type PendingCommandAttempt = {
  status: "pending"
  integrationID: ID
  label?: string
  message?: string
  persisting: boolean
  scope: Scope.Closeable
  time: AttemptTime
}
// 命令尝试条目：待决或终态
type CommandAttemptEntry = PendingCommandAttempt | TerminalAttempt

// 尝试引用类型：以尝试 ID 为键的同步引用映射
type AttemptRef<Pending> = SynchronizedRef.SynchronizedRef<Map<AttemptID, Pending | TerminalAttempt>>

// 构建集成服务层
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 依次获取依赖：凭据、总线、进程服务与所有者作用域
    const credentials = yield* Credential.Service
    const bus = yield* Bus.Service
    const processes = yield* AppProcess.Service
    const scope = yield* Scope.Scope
    // OAuth 尝试表（未安全初始化——构造期无并发）
    const attempts = SynchronizedRef.makeUnsafe(new Map<AttemptID, AttemptEntry>())
    // 命令尝试表
    const commandAttempts = SynchronizedRef.makeUnsafe(new Map<AttemptID, CommandAttemptEntry>())
    // Runtime-only: statuses describe the current process's view of a connection and are not persisted.
    // 连接状态表：仅运行时存在，描述当前进程视角，不持久化
    const statuses = new Map<string, IntegrationConnection.Status>()
    // 状态表的键：集成 ID + 连接键
    const statusKey = (integrationID: ID, connection: IntegrationConnection.Info) =>
      `${integrationID}:${IntegrationConnection.key(connection)}`
    // 创建集成注册表状态：含编辑器与变更通知
    const state = State.create<Data, Editor>({
      name: "integration",
      // 初始数据：空映射
      initial: () => ({ integrations: new Map<ID, Entry>() }),
      // editor：把数据包装成编辑器 API
      editor: (editor) => {
        // ensure：取集成条目，不存在则创建默认条目并放入映射
        const ensure = (id: ID): Entry => {
          const current = editor.integrations.get(id) ?? {
            ref: { id, name: id },
            methods: [],
            implementations: new Map(),
          }
          if (!editor.integrations.has(id)) editor.integrations.set(id, current)
          return current
        }
        // 返回编辑器实现
        return {
          // list：所有集成引用
          list: () => Array.from(editor.integrations.values(), (entry) => entry.ref),
          // get：按 ID 取集成引用
          get: (id) => editor.integrations.get(id)?.ref,
          // update：修改集成引用并确保 ID 一致
          update: (id, update) => {
            const current = ensure(id)
            update(current.ref)
            current.ref.id = id
          },
          // remove：删除集成条目
          remove: (id) => editor.integrations.delete(id),
          // method：方法级编辑
          method: {
            // list：列出某集成的方法
            list: (integrationID) => editor.integrations.get(integrationID)?.methods ?? [],
            // update：插入或替换方法；OAuth 实现另存到 implementations
            update: (implementation) => {
              const current = ensure(implementation.integrationID)
              const index = current.methods.findIndex((method) => sameMethod(method, implementation.method))
              if (index === -1) current.methods.push(implementation.method)
              else current.methods[index] = implementation.method
              if ("authorize" in implementation) {
                current.implementations.set(implementation.method.id, implementation)
              }
            },
            // remove：删除方法；OAuth 方法同时移除其实现
            remove: (integrationID, method) => {
              const current = editor.integrations.get(integrationID)
              if (!current) return
              const index = current.methods.findIndex((candidate) => sameMethod(candidate, method))
              if (index !== -1) current.methods.splice(index, 1)
              if (method.type === "oauth") current.implementations.delete(method.id)
            },
          },
        }
      },
      // notify：数据变化时投影成排序后的 Info 列表，并发布 Updated 事件
      notify: State.changes(
        (data) =>
          Array.from(data.integrations.values(), (entry) => project(entry, resolveConnections(entry, []))).toSorted(
            (a, b) => a.name.localeCompare(b.name),
          ),
        () => bus.publish(Integration.Event.Updated, {}).pipe(Effect.asVoid),
      ),
    })

    // 排序缓存：以集成映射为键的 WeakMap
    const sorted = new WeakMap<Map<ID, Entry>, Entry[]>()
    // sortedEntries：按名称排序条目，命中缓存则直接返回
    const sortedEntries = () => {
      const integrations = state.get().integrations
      const cached = sorted.get(integrations)
      if (cached) return cached
      const entries = Array.from(integrations.values()).toSorted((a, b) => a.ref.name.localeCompare(b.ref.name))
      sorted.set(integrations, entries)
      return entries
    }

    // createCredential：创建凭据；无标签时自动生成“名称 / 名称 2 / 名称 3…”
    const createCredential = Effect.fnUntraced(function* (input: Parameters<Credential.Interface["create"]>[0]) {
      // 已指定标签：直接创建
      if (input.label !== undefined) return yield* credentials.create(input)
      // 取集成名（缺失时用集成 ID）
      const name = state.get().integrations.get(input.integrationID)?.ref.name ?? input.integrationID
      // 收集该集成已占用的标签集合
      const labels = new Set((yield* credentials.list(input.integrationID)).map((credential) => credential.label))
      // 依序尝试 name、name 2、name 3…找到第一个未占用的标签，全占用则退回 name
      const label =
        Array.from({ length: labels.size + 1 }, (_, index) => (index === 0 ? name : `${name} ${index + 1}`)).find(
          (candidate) => !labels.has(candidate),
        ) ?? name
      // 带标签创建凭据
      return yield* credentials.create({ ...input, label })
    })

    // resolveConnections：解析集成的可用连接——存储凭据（逆序，最新的排前）+ 命中的环境变量
    const resolveConnections = (entry: Entry | undefined, saved: readonly Credential.Info[]) => {
      // 把存储凭据映射为连接信息并反转（列表中每个集成最后一条凭据是激活的）
      const credentials = saved
        .map((credential) => ({
          type: "credential" as const,
          id: credential.id,
          label: credential.label,
          method: credential.value.type,
        }))
        .toReversed()
      // 环境变量方法：收集方法声明的名称中环境里确实存在的变量
      const env = (entry?.methods ?? [])
        .filter((method) => method.type === "env")
        .flatMap((method) => method.names.filter((name) => process.env[name]))
        .map((name) => ({ type: "env" as const, name }))
      // 合并返回
      return [...credentials, ...env]
    }

    // project：把注册表条目投影为对外的 Info，并附加运行时状态
    const project = (entry: Entry, connections: IntegrationConnection.Info[]): Info =>
      Info.make({
        id: entry.ref.id,
        name: entry.ref.name,
        ...(entry.ref.metadata === undefined ? {} : { metadata: entry.ref.metadata }),
        methods: entry.methods,
        connections: connections.map((connection) => {
          // 若该连接有运行时状态则合并进去
          const status = statuses.get(statusKey(entry.ref.id, connection))
          return status ? { ...connection, status } : connection
        }),
      })

    // authorize：把任意失败的 effect 错误映射为 AuthorizationError
    const authorize = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.mapError((cause) => new AuthorizationError({ cause })))

    // close：立即 fork 关闭尝试作用域（不阻塞当前流程）
    const close = (attemptScope: Scope.Closeable) =>
      Scope.close(attemptScope, Exit.void).pipe(Effect.forkIn(scope, { startImmediately: true }), Effect.asVoid)

    // message：从 Cause 中压榨出可读的错误消息
    const message = (cause: Cause.Cause<unknown>) => {
      const error = Cause.squash(cause)
      return error instanceof Error ? error.message : String(error)
    }

    // Claims a pending attempt for settlement. A failed exit records the failure and closes the attempt.
    // claim：认领一个待决尝试用于结算；失败时记录失败并关闭尝试
    const claim = Effect.fnUntraced(function* <Pending extends PendingAttempt | PendingCommandAttempt>(
      ref: AttemptRef<Pending>,
      attemptID: AttemptID,
      exit: Exit.Exit<unknown, unknown>,
    ) {
      // 取当前时间，作为失败记录的基准
      const now = yield* Clock.currentTimeMillis
      // 原子地认领尝试
      const attempt = yield* SynchronizedRef.modify(ref, (current) => {
        const match = current.get(attemptID)
        // 不存在、非待决或正在持久化：不认领
        if (!match || match.status !== "pending" || match.persisting) return [undefined, current]
        // 成功：标记为持久化中（防止重复认领/取消/过期）
        const next: Pending | TerminalAttempt = Exit.isSuccess(exit)
          ? { ...match, persisting: true }
          : {
              // 失败：转为 failed 终态，附带消息与清理时间
              status: "failed",
              integrationID: match.integrationID,
              message: message(exit.cause),
              time: match.time,
              removeAt: now + terminalRetention,
            }
        // 返回认领的尝试与更新后的表
        return [match, new Map(current).set(attemptID, next)]
      })
      // 失败时异步关闭尝试作用域（释放其资源）
      if (attempt && Exit.isFailure(exit)) yield* close(attempt.scope)
      // 返回认领结果
      return attempt
    })

    // record：把持久化结果写为终态（成功→complete，失败→failed）
    const record = Effect.fnUntraced(function* <Pending extends PendingAttempt | PendingCommandAttempt>(
      ref: AttemptRef<Pending>,
      attemptID: AttemptID,
      attempt: Pending,
      persistence: Exit.Exit<void, unknown>,
    ) {
      // 记录结算时间
      const settledAt = yield* Clock.currentTimeMillis
      // 依据持久化结果构造终态
      const terminal: TerminalAttempt = Exit.isSuccess(persistence)
        ? {
            status: "complete",
            integrationID: attempt.integrationID,
            time: attempt.time,
            removeAt: settledAt + terminalRetention,
          }
        : {
            status: "failed",
            integrationID: attempt.integrationID,
            message: message(persistence.cause),
            time: attempt.time,
            removeAt: settledAt + terminalRetention,
          }
      // 更新尝试表
      yield* SynchronizedRef.update(ref, (current) => new Map(current).set(attemptID, terminal))
    })

    // settle：结算 OAuth 尝试——认领后持久化凭据，最终释放作用域
    const settle = Effect.fnUntraced(function* (attemptID: AttemptID, exit: Exit.Exit<Credential.OAuth, unknown>) {
      // 认领尝试
      const attempt = yield* claim(attempts, attemptID, exit)
      // 未认领到或已失败：结束
      if (!attempt || Exit.isFailure(exit)) return
      yield* Effect.gen(function* () {
        // 持久化凭据：失败也要捕获为 Exit
        const persistence = yield* Effect.suspend(() => {
          // 取该集成该方法的 OAuth 实现（用于生成默认标签）
          const implementation = state
            .get()
            .integrations.get(attempt.integrationID)
            ?.implementations.get(attempt.methodID)
          // 创建凭据
          return createCredential({
            integrationID: attempt.integrationID,
            label: attempt.label ?? implementation?.label?.(exit.value),
            value: exit.value,
          })
        }).pipe(Effect.asVoid, Effect.exit)
        // Persisting attempts cannot be cancelled, expired, or claimed again.
        // 先记录终态再实际执行持久化（持久化中的尝试不可取消/过期/再次认领）
        yield* record(attempts, attemptID, attempt, persistence)
        // 重新触发持久化效果以传播其错误（成功时无副作用）
        yield* persistence
        // 无论成败都关闭尝试作用域
      }).pipe(Effect.ensuring(close(attempt.scope)))
      // 整个结算不可中断
    }, Effect.uninterruptible)

    // settleCommand：结算命令尝试——把命令输出保存为 key 凭据
    const settleCommand = Effect.fnUntraced(function* (attemptID: AttemptID, exit: Exit.Exit<string, unknown>) {
      // 认领命令尝试
      const attempt = yield* claim(commandAttempts, attemptID, exit)
      // 未认领到或已失败：结束
      if (!attempt || Exit.isFailure(exit)) return
      // 把命令输出包装成 key 凭据并持久化（捕获为 Exit）
      const persistence = yield* createCredential({
        integrationID: attempt.integrationID,
        label: attempt.label,
        value: Credential.Key.make({ type: "key", key: exit.value }),
      }).pipe(Effect.asVoid, Effect.exit)
      // 写入终态
      yield* record(commandAttempts, attemptID, attempt, persistence)
      // 关闭尝试作用域
      yield* close(attempt.scope)
      // 整个结算不可中断
    }, Effect.uninterruptible)

    // scrub：巡检尝试表——过期待决转为 expired，终态到期的从表中删除
    const scrub = Effect.fnUntraced(function* <Pending extends PendingAttempt | PendingCommandAttempt>(
      ref: AttemptRef<Pending>,
      expire: (attemptID: AttemptID, attempt: Pending) => Effect.Effect<void>,
    ) {
      // 取当前时间
      const now = yield* Clock.currentTimeMillis
      // 原子地扫描并更新表
      const expired = yield* SynchronizedRef.modify(ref, (current) => {
        const next = new Map(current)
        // 收集本轮过期的待决尝试
        const closed: [AttemptID, Pending][] = []
        for (const [id, attempt] of current) {
          // 待决且未在持久化且已过期：转为 expired 终态
          if (attempt.status === "pending" && !attempt.persisting && attempt.time.expires <= now) {
            closed.push([id, attempt])
            next.set(id, {
              status: "expired",
              integrationID: attempt.integrationID,
              time: attempt.time,
              removeAt: now + terminalRetention,
            })
            continue
          }
          // 终态且已到清理时间：从表中删除
          if (attempt.status !== "pending" && attempt.removeAt <= now) next.delete(id)
        }
        // 返回过期列表与更新后的表
        return [closed, next]
      })
      // 对每个过期尝试执行 expire 回调（如关闭作用域/记日志）
      yield* Effect.forEach(expired, ([id, attempt]) => expire(id, attempt), { discard: true })
    })

    // cancel：取消尝试——从表中移除并关闭其作用域；before 在移除后执行（如记日志）
    const cancel = Effect.fnUntraced(function* <Pending extends PendingAttempt | PendingCommandAttempt>(
      ref: AttemptRef<Pending>,
      input: { readonly integrationID: ID; readonly attemptID: AttemptID },
      before: Effect.Effect<void> = Effect.void,
    ) {
      // 原子地移除尝试
      const attempt = yield* SynchronizedRef.modify(ref, (current) => {
        const match = current.get(input.attemptID)
        // 不存在、集成不匹配、非待决或正在持久化：不取消
        if (!match || match.integrationID !== input.integrationID || match.status !== "pending" || match.persisting)
          return [undefined, current]
        const next = new Map(current)
        next.delete(input.attemptID)
        return [match, next]
      })
      // 未移除任何东西：结束
      if (!attempt) return
      // 执行前置回调
      yield* before
      // 关闭尝试作用域，释放资源
      yield* Scope.close(attempt.scope, Exit.void)
    })

    // 启动 OAuth 尝试巡检：每 30 秒清理过期尝试并记日志、关作用域
    yield* scrub(attempts, (attemptID, attempt) =>
      Effect.logInfo("integration oauth attempt closed", {
        integrationID: attempt.integrationID,
        attemptID,
        reason: "expired",
      }).pipe(Effect.andThen(close(attempt.scope))),
    ).pipe(Effect.repeat(Schedule.spaced(scrubInterval)), Effect.forkIn(scope))
    // 启动命令尝试巡检：每 30 秒清理过期尝试并关作用域
    yield* scrub(commandAttempts, (_, attempt) => close(attempt.scope)).pipe(
      Effect.repeat(Schedule.spaced(scrubInterval)),
      Effect.forkIn(scope),
    )

    // connectOAuth：发起 OAuth 授权尝试
    const connectOAuth = Effect.fn("Integration.oauth.connect")(function* (input: {
      readonly integrationID: ID
      readonly methodID: MethodID
      readonly answer?: Form.Answer
      readonly label?: string
    }) {
      // 取目标 OAuth 方法实现
      const method = state.get().integrations.get(input.integrationID)?.implementations.get(input.methodID)
      // 方法不存在：致命错误
      if (!method) {
        return yield* Effect.die(new Error(`OAuth method not found: ${input.integrationID}/${input.methodID}`))
      }
      // 答案缺省为空对象
      const answer = input.answer ?? {}
      // 校验答案与方法表单是否匹配
      const invalid = answerError(method.method.form, answer)
      // 不匹配则授权失败
      if (invalid) return yield* new AuthorizationError({ cause: new Error(invalid) })
      // 从所有者作用域 fork 出本尝试的作用域
      const attemptScope = yield* Scope.fork(scope)
      // 执行授权（提供尝试作用域）；失败时关闭作用域
      const authorization = yield* authorize(method.authorize(answer)).pipe(
        Scope.provide(attemptScope),
        Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(attemptScope, exit) : Effect.void)),
      )
      // 生成尝试 ID 与时间信息（未给过期时间则用默认存活期）
      const id = AttemptID.create()
      const created = yield* Clock.currentTimeMillis
      const time = { created, expires: authorization.expiresAt ?? created + attemptLifetime }
      // 登记为待决尝试；auto 模式标记 completing
      yield* SynchronizedRef.update(attempts, (current) =>
        new Map(current).set(id, {
          status: "pending",
          completing: authorization.mode === "auto",
          persisting: false,
          authorization,
          integrationID: input.integrationID,
          methodID: input.methodID,
          label: input.label,
          scope: attemptScope,
          time,
        }),
      )
      // auto 模式：fork 回调自动结算
      if (authorization.mode === "auto") {
        yield* authorization.callback.pipe(
          Effect.exit,
          Effect.flatMap((exit) => settle(id, exit)),
          Effect.forkIn(attemptScope, { startImmediately: true }),
        )
      }
      // 返回尝试信息（URL、说明、模式、是否需粘贴重定向 URL 等）
      return new Attempt({
        attemptID: id,
        url: authorization.url,
        instructions: authorization.instructions,
        mode: authorization.mode,
        ...(authorization.mode === "auto" && authorization.submit ? { paste: true } : {}),
        time,
      })
    })

    // connectCommand：发起基于命令的授权尝试
    const connectCommand = Effect.fn("Integration.command.connect")(function* (input: {
      readonly integrationID: ID
      readonly methodID: MethodID
      readonly label?: string
    }) {
      // 查找目标命令方法
      const method = state
        .get()
        .integrations.get(input.integrationID)
        ?.methods.find((method) => method.type === "command" && method.id === input.methodID)
      // 方法不存在或命令为空：致命错误
      if (!method || method.type !== "command" || !method.command[0]) {
        return yield* Effect.die(new Error(`Command method not found: ${input.integrationID}/${input.methodID}`))
      }

      // fork 尝试作用域并登记待决尝试
      const attemptScope = yield* Scope.fork(scope)
      const attemptID = AttemptID.create()
      const created = yield* Clock.currentTimeMillis
      const time = { created, expires: created + attemptLifetime }
      yield* SynchronizedRef.update(commandAttempts, (current) =>
        new Map(current).set(attemptID, {
          status: "pending",
          integrationID: input.integrationID,
          label: input.label,
          persisting: false,
          scope: attemptScope,
          time,
        }),
      )

      // fork 命令执行流程：产出凭据后结算
      yield* Effect.gen(function* () {
        // 启动子进程（继承环境变量、忽略 stdin）
        const handle = yield* processes.spawn(
          ChildProcess.make(method.command[0], method.command.slice(1), {
            extendEnv: true,
            stdin: "ignore",
          }),
        )
        // 后台收集 stdout（凭据来源）
        const stdout = yield* AppProcess.collectStream(handle.stdout, undefined).pipe(Effect.forkScoped)
        // 消费 stderr：把输出累积进尝试的 message 字段（供失败时展示）
        yield* handle.stderr.pipe(
          Stream.decodeText,
          Stream.tap((chunk) =>
            SynchronizedRef.update(commandAttempts, (current) => {
              const attempt = current.get(attemptID)
              // 尝试已不在待决态则忽略
              if (!attempt || attempt.status !== "pending") return current
              const message = (attempt.message ?? "") + chunk
              return new Map(current).set(attemptID, { ...attempt, message })
            }),
          ),
          Stream.runDrain,
        )
        // 等待进程退出码
        const exitCode = yield* handle.exitCode
        // 非零退出：以 stderr 消息或默认文案失败
        if (exitCode !== 0) {
          const attempt = (yield* SynchronizedRef.get(commandAttempts)).get(attemptID)
          return yield* Effect.fail(new Error(attempt?.message?.trim() || `Authentication command exited ${exitCode}`))
        }
        // 取 stdout 内容作为凭据
        const credential = (yield* Fiber.join(stdout)).buffer.toString("utf8").trim()
        // 空凭据：失败
        if (!credential) return yield* Effect.fail(new Error("Authentication command returned no credential"))
        // 返回凭据
        return credential
      }).pipe(
        // 提供尝试作用域；结束后用 exit 结算并 fork 到尝试作用域
        Scope.provide(attemptScope),
        Effect.exit,
        Effect.flatMap((exit) => settleCommand(attemptID, exit)),
        Effect.forkIn(attemptScope, { startImmediately: true }),
      )

      // 返回命令尝试信息
      return CommandAttempt.make({ attemptID, time })
    })

    // 返回服务实现
    return Service.of({
      transform: state.transform,
      reload: state.reload,
      revision: state.revision,
      // get：查询单个集成（含连接投影）
      get: Effect.fn("Integration.get")(function* (id) {
        const entry = state.get().integrations.get(id)
        // 不存在返回 undefined
        if (!entry) return undefined
        // 投影为 Info，连接来自该集成的存储凭据
        return project(entry, resolveConnections(entry, yield* credentials.list(id)))
      }),
      // list：列出全部集成（按名称排序）
      list: Effect.fn("Integration.list")(function* () {
        // 一次性取全部凭据并按集成 ID 分组
        const saved = Map.groupBy(yield* credentials.all(), (credential) => credential.integrationID)
        // 逐个投影
        return sortedEntries().map((entry) => project(entry, resolveConnections(entry, saved.get(entry.ref.id) ?? [])))
      }),
      connection: {
        // active：取集成的激活连接（连接列表第一条）
        active: Effect.fn("Integration.connection.active")(function* (id) {
          const entry = state.get().integrations.get(id)
          return resolveConnections(entry, yield* credentials.list(id))[0]
        }),
        // resolve：把连接解析成可用凭据（环境变量直接取值；OAuth 到期前刷新）
        resolve: Effect.fn("Integration.connection.resolve")(function* (connection) {
          // 环境变量连接：直接读环境变量
          if (connection.type === "env") {
            const key = process.env[connection.name]
            return key ? Credential.Key.make({ type: "key", key }) : undefined
          }
          // 凭据连接：读取存储凭据
          const credential = yield* credentials.get(connection.id)
          // 凭据不存在：undefined
          if (!credential) return undefined
          // 非 OAuth 凭据：直接返回
          if (credential.value.type !== "oauth") return credential.value
          // 取该 OAuth 方法的刷新实现
          const refresh = state
            .get()
            .integrations.get(credential.integrationID)
            ?.implementations.get(credential.value.methodID)?.refresh
          // expiring：判断令牌是否会在 5 分钟内过期
          const expiring = (value: Credential.OAuth) =>
            Clock.currentTimeMillis.pipe(
              Effect.map((now) => value.expires <= now + Duration.toMillis(Duration.minutes(5))),
            )
          // 无刷新实现或未临近过期：直接返回现值
          if (!refresh || !(yield* expiring(credential.value))) return credential.value
          // 临近过期：加凭据锁后刷新（避免并发重复刷新）
          return yield* authorize(
            credentials.lock(
              credential.id,
              Effect.gen(function* () {
                // Another Location may have refreshed while this caller waited.
                // 拿到锁后重新读取：其他 Location 可能已在等待期间刷新过
                const current = yield* credentials.get(credential.id)
                // 凭据消失或类型变了：返回 undefined
                if (!current || current.value.type !== "oauth") return undefined
                // 已不再临近过期：直接用现值
                if (!(yield* expiring(current.value))) return current.value
                // 调用刷新（最多 30 秒），成功后写回存储
                const value = yield* refresh(current.value).pipe(Effect.timeout("30 seconds"))
                yield* credentials.update(current.id, { value })
                // 返回新令牌
                return value
              }),
            ),
          )
        }),
        // key：保存密钥凭据
        key: Effect.fn("Integration.connection.key")(function* (input) {
          // 查找该集成的密钥方法
          const method = state
            .get()
            .integrations.get(input.integrationID)
            ?.methods.find((method) => method.type === "key")
          // 方法不存在：致命错误
          if (!method) return yield* Effect.die(new Error(`Key method not found: ${input.integrationID}`))
          // 答案缺省为空
          const answer = input.answer ?? {}
          // 校验答案
          const invalid = answerError(method.form, answer, "Key")
          // 不匹配则授权失败
          if (invalid) return yield* new AuthorizationError({ cause: new Error(invalid) })
          // 创建 key 凭据（答案非空时附为元数据）
          yield* createCredential({
            integrationID: input.integrationID,
            label: input.label,
            value: Credential.Key.make({
              type: "key",
              key: input.key,
              ...(Object.keys(answer).length > 0 ? { metadata: answer } : {}),
            }),
          })
        }),
        // external：保存外部凭据引用
        external: Effect.fn("Integration.connection.external")(function* (input) {
          // 查找目标外部方法
          const method = state
            .get()
            .integrations.get(input.integrationID)
            ?.methods.find((method) => method.type === "external" && method.id === input.methodID)
          // 方法不存在：授权失败
          if (method?.type !== "external")
            return yield* new AuthorizationError({ cause: new Error(`External method not found: ${input.methodID}`) })
          // 答案缺省为空
          const answer = input.answer ?? {}
          // 校验答案
          const invalid = answerError(method.form, answer, "External")
          // 不匹配则授权失败
          if (invalid) return yield* new AuthorizationError({ cause: new Error(invalid) })
          // 创建 external 凭据（答案非空时附为元数据）
          yield* createCredential({
            integrationID: input.integrationID,
            label: input.label,
            value: Credential.External.make({
              type: "external",
              methodID: method.id,
              ...(Object.keys(answer).length > 0 ? { metadata: answer } : {}),
            }),
          })
        }),
        // activate：激活某个凭据连接
        activate: Effect.fn("Integration.connection.activate")((credentialID) => credentials.activate(credentialID)),
        // update：更新凭据（如标签）
        update: Effect.fn("Integration.connection.update")((credentialID, updates) =>
          credentials.update(credentialID, updates),
        ),
        // remove：删除凭据连接
        remove: Effect.fn("Integration.connection.remove")((credentialID) => credentials.remove(credentialID)),
        // status：上报/清除连接运行时状态；变化时广播 Updated 事件
        status: Effect.fn("Integration.connection.status")(function* (input) {
          // 计算状态键
          const key = statusKey(input.integrationID, input.connection)
          // 状态没变：不发布事件
          if (Equal.equals(statuses.get(key), input.status)) return
          // 有状态则写入，无状态则删除
          if (input.status) statuses.set(key, input.status)
          if (!input.status) statuses.delete(key)
          // 广播集成已更新
          yield* bus.publish(Integration.Event.Updated, {})
        }),
      },
      oauth: {
        // connect：发起 OAuth 尝试
        connect: connectOAuth,
        // status：查询 OAuth 尝试状态
        status: Effect.fn("Integration.oauth.status")(function* (input) {
          // 读取尝试
          const attempt = (yield* SynchronizedRef.get(attempts)).get(input.attemptID)
          // 不存在或集成不匹配：尝试未找到错误
          if (!attempt || attempt.integrationID !== input.integrationID) return yield* new AttemptNotFoundError(input)
          // 失败终态：附带错误消息
          if (attempt.status === "failed") {
            return { status: attempt.status, message: attempt.message ?? "Authorization failed", time: attempt.time }
          }
          // 其他状态：只带状态与时间
          return { status: attempt.status, time: attempt.time }
        }),
        // complete：完成 OAuth 尝试（提交授权码或等待自动回调）
        complete: Effect.fn("Integration.oauth.complete")(function* (input) {
          // 原子地检查并锁定尝试为 completing
          const attempt = yield* SynchronizedRef.modify(attempts, (current) => {
            const match = current.get(input.attemptID)
            // 不存在或集成不匹配：未找到
            if (!match || match.integrationID !== input.integrationID) return [undefined, current]
            // 非待决或已在完成中：原样返回
            if (match.status !== "pending" || match.completing) return [match, current]
            // code 模式但没有授权码：暂不动（下面报错）
            if (match.authorization.mode === "code" && input.code === undefined) return [match, current]
            // 标记为完成中，防止并发重复完成
            return [match, new Map(current).set(input.attemptID, { ...match, completing: true })]
          })
          // 未找到：报错
          if (!attempt) return yield* new AttemptNotFoundError(input)
          // 已是终态：无事可做
          if (attempt.status !== "pending") return
          // The attempt still settles through its callback; clients keep polling status for the result.
          // auto 模式且支持粘贴：把用户粘贴的重定向 URL 交给 submit；结算仍由回调完成，客户端继续轮询状态
          if (attempt.authorization.mode === "auto" && attempt.authorization.submit && input.code !== undefined)
            return yield* authorize(attempt.authorization.submit(input.code))
          // code 模式缺少授权码：报错
          if (attempt.authorization.mode === "code" && input.code === undefined) {
            return yield* new CodeRequiredError({ attemptID: input.attemptID })
          }
          // 完成中被再次完成：致命错误
          if (attempt.completing)
            return yield* Effect.die(new Error(`OAuth attempt already completing: ${input.attemptID}`))
          // 组装回调：auto 用效果本身；code 用授权码调用
          const callback =
            attempt.authorization.mode === "auto"
              ? attempt.authorization.callback
              : attempt.authorization.callback(input.code as string)
          // 执行回调并结算
          const exit = yield* authorize(callback).pipe(Effect.exit)
          yield* settle(input.attemptID, exit)
          // 失败则向上传播
          if (Exit.isFailure(exit)) return yield* exit
        }),
        // cancel：取消 OAuth 尝试（附带取消日志）
        cancel: Effect.fn("Integration.oauth.cancel")((input) =>
          cancel(
            attempts,
            input,
            Effect.logInfo("integration oauth attempt closed", {
              integrationID: input.integrationID,
              attemptID: input.attemptID,
              reason: "cancelled",
            }),
          ),
        ),
      },
      command: {
        // connect：发起命令授权尝试
        connect: connectCommand,
        // status：查询命令尝试状态
        status: Effect.fn("Integration.command.status")(function* (input) {
          // 读取尝试
          const attempt = (yield* SynchronizedRef.get(commandAttempts)).get(input.attemptID)
          // 不存在或集成不匹配：未找到错误
          if (!attempt || attempt.integrationID !== input.integrationID) return yield* new AttemptNotFoundError(input)
          // 待决：附带已累积的 stderr 消息
          if (attempt.status === "pending") {
            return {
              status: attempt.status,
              ...(attempt.message ? { message: attempt.message } : {}),
              time: attempt.time,
            }
          }
          // 失败：附带消息
          if (attempt.status === "failed") {
            return { status: attempt.status, message: attempt.message ?? "Authentication failed", time: attempt.time }
          }
          // 其他终态：状态与时间
          return { status: attempt.status, time: attempt.time }
        }),
        // cancel：取消命令尝试
        cancel: Effect.fn("Integration.command.cancel")((input) => cancel(commandAttempts, input)),
      },
    })
  }),
)

// sameMethod：判断两个方法是否相同——类型一致且（任一没有 id 或 id 相等）
const sameMethod = (a: Method, b: Method) => a.type === b.type && (!("id" in a) || !("id" in b) || a.id === b.id)

// Methods without a form reject answers when named; OAuth ignores answers it has no form for.
// answerError：校验表单答案——有表单时校验字段与答案；无表单的命名方法不接受任何答案
const answerError = (form: ReadonlyArray<Form.Field> | undefined, answer: Form.Answer, method?: string) => {
  // 有表单：先校验字段定义，再校验答案内容
  if (form) return Form.validateFields(form) ?? Form.validateAnswer(form, answer)
  // 无表单但调用方带了答案：报错
  if (method && Object.keys(answer).length > 0) return `${method} method does not accept a form answer`
}

// 导出位置节点：装配本层与依赖（凭据、总线、进程服务）
export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Credential.node, Bus.node, AppProcess.node],
})
