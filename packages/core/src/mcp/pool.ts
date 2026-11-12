// 将本模块以命名空间 McpPool 整体再导出（barrel 模式）
export * as McpPool from "./pool.js"

import type { AuthProvider } from "@modelcontextprotocol/client"
import type { Mcp } from "@opencode/schema/mcp"
// 引入跨平台生成器节点（全局层依赖）
import { CrossSpawnSpawner } from "@opencode/util/cross-spawn-spawner"
// 引入全局节点辅助（Service+Layer 不绑定 Location）
import { makeGlobalNode } from "@opencode/util/effect/app-node"
// 引入 http fetch 节点（全局层依赖）
import { httpFetch } from "@opencode/util/effect/app-node-platform"
// 引入 Effect：原因、Context、Deferred、Effect、Exit、Fiber、FiberSet、Layer、Scope、Semaphore
import { Cause, Context, Deferred, Effect, Exit, Fiber, FiberSet, Layer, Scope, Semaphore } from "effect"
// 引入 Effect 的 fetch HTTP 客户端标记
import { FetchHttpClient } from "effect/http"
// 引入子进程生成器
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
// 引入环境（Environment）服务
import { Environment } from "../environment/index.js"
// 引入共享缓存（指纹计算）
import { SharedCache } from "../shared-cache.js"
// 仅引入类型：MCP 客户端连接
import type { McpClient } from "./client.js"
// 引入 MCP 连接模块
import { McpConnection } from "./connection.js"

// 池连接的输入：在普通连接输入之上追加 select
export interface Input extends McpConnection.Input {
  /**
   * Run once per start: what tells this connection apart from every other one to the same server (see `key`),
   * and the OAuth provider to open it with. Both come from one credential selection, so a slot's key and the
   * account it connects as can't disagree.
   */
  // select：每次 start 运行一次——给出共享键与 OAuth 提供者（同一次凭证选定，键与账号不会错位）
  readonly select: Effect.Effect<Selection>
}

// select 的结果：共享键与 OAuth 提供者
export interface Selection {
  // 本连接区别于同一服务器其他连接的键
  readonly key: string
  readonly authProvider: Effect.Effect<AuthProvider | undefined>
}

// 池服务接口
export interface Interface {
  /**
   * A Location's connection to a server that may be shared. Each start joins the connection other
   * Locations hold under the same key, or opens it, and each stop lets go of it; the last to let go
   * closes it. A server that negotiates the legacy protocol, or that answers but refuses or breaks the
   * pooled handshake, is never shared: the Location connects on its own, exactly as it would unpooled,
   * and every later start for that key skips straight to that.
   */
  // connection：返回一个可共享的连接；start 加入/打开共享槽，stop 放手，最后放手者关闭
  readonly connection: (input: Input) => McpConnection.Connection
}

// Effect 服务标识（Tag）
export class Service extends Context.Service<Service, Interface>()("@opencode/McpPool") {}

/**
 * Everything that could make two connections behave differently, so only identical ones are shared.
 * The server's name is left out; each Location keeps its own. Secrets appear only as fingerprints.
 */
// key：把所有会导致行为差异的因素编码进共享键；服务器名不参与（各 Location 自留）；密钥只出现指纹
export const key = (input: {
  // 服务器配置
  readonly config: Mcp.ServerConfig
  /** Local only: the directory the server runs in, as `McpStdio.resolveCwd` resolves it for the spawn. */
  // cwd：仅本地服务器——实际运行目录（按 McpStdio.resolveCwd 解析）
  readonly cwd?: string
  /** The active OAuth credential's ID, which a token refresh keeps and a sign-in replaces. */
  // credential：当前 OAuth 凭证 ID（令牌刷新保持不变，重新登录会更换）
  readonly credential?: string
  // 客户端标识
  readonly clientInfo?: { readonly name: string; readonly version: string }
  readonly mcpEvents?: boolean
}) => {
  // 局部简写
  const config = input.config
  const common = [config.protocol, config.timeout ?? null, input.clientInfo ?? null, input.mcpEvents === true]
  if (config.type === "remote")
    return JSON.stringify([
      // 类型标记
      "remote",
      // URL
      config.url,
      // 头部（指纹化）
      fingerprint(config.headers),
      // oauth 段（client_secret 指纹化）
      config.oauth ? { ...config.oauth, client_secret: fingerprint(config.oauth.client_secret) } : config.oauth,
      // A remote server's URL gains ?codemode=false unless Code Mode is off.
      // 是否附加 codemode=false（Code Mode 未关闭时为 true）
      config.codemode !== false,
      // 凭证 ID
      input.credential ?? null,
      // 公共片段
      ...common,
    ])
  // Only Locations on this host share local servers, so the execution plane is always the host.
  // 本地服务器键：仅同机 Location 共享，执行平面恒为 host
  return JSON.stringify([
    // 类型标记
    "local",
    // 执行平面标记
    "host",
    // 命令
    config.command,
    // 解析后的 cwd
    input.cwd ?? null,
    // 环境变量（指纹化）
    fingerprint(config.environment),
    // 公共片段
    ...common,
  ])
}

// fingerprint：把密钥（字符串或键值表）转成指纹；undefined 变 null
function fingerprint(secret: string | Record<string, string> | undefined) {
  // 未定义直接 null
  if (secret === undefined) return null
  // 字符串直接指纹；对象先按键排序再序列化后指纹
  return SharedCache.fingerprint(
    typeof secret === "string"
      ? secret
      : JSON.stringify(Object.entries(secret).toSorted(([a], [b]) => a.localeCompare(b))),
  )
}

// A Location holding a shared connection. The pool reaches Locations only through the holders
// registered right now, never through the one that opened the connection.
// Holder：一个持有共享连接的 Location；池只通过当前登记的持有者触达各方
interface Holder {
  readonly authProvider: Effect.Effect<AuthProvider | undefined>
  readonly elicitation: McpClient.ElicitationHandler["create"]
  // 连接关闭回调
  readonly closed: (reason: string) => void
  // 目录变化回调
  readonly changed: (kind: McpConnection.Kind) => void
}

// 尝试结果：共享成功 / 转私有 / 连接失败
type Outcome = "connected" | "private" | McpConnection.Failure

// 槽位：一条共享连接及其持有者集合、锁、结果与启动纤程
interface Slot {
  // 共享的底层连接
  readonly connection: McpConnection.Connection
  // 持有者集合
  readonly holders: Set<Holder>
  // 槽位级信号量
  readonly lock: Semaphore.Semaphore
  // 一次性结果
  readonly outcome: Deferred.Deferred<Outcome>
  // 启动纤程（可选）
  start?: Fiber.Fiber<void>
  // 是否已连上
  connected: boolean
}

// 池服务层
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 取回当前作用域
    const scope = yield* Effect.scope
    // 运行时纤程集合
    const run = yield* FiberSet.makeRuntime<never, void, never>()
    // 用本地子进程生成器构建宿主驱动
    const driver = Environment.makeLocalDriver(yield* ChildProcessSpawner)
    // 宿主环境服务（文件与 spawner）
    const host = Environment.Service.of({ files: Environment.makeFiles(driver), spawner: driver.spawner })
    // 取回注入的 fetch
    const fetch = yield* FetchHttpClient.Fetch
    // 活跃槽位表（键 -> 槽）
    const slots = new Map<string, Slot>()
    // Keys whose server negotiated legacy or refused the pooled handshake. Kept for the life of the process.
    // 不可共享键集合：协商到旧协议或拒绝共享握手的服务器（进程生命周期内有效）
    const unpoolable = new Set<string>()
    // The subset that negotiated legacy. Their private connections skip the 2026-07-28 probe; a refusal
    // proves nothing about the protocol, so those keep the configured one.
    // 其中协商到旧协议的键：其私有连接跳过 2026-07-28 探测，保持配置的协议
    const legacy = new Set<string>()
    // Names of local servers already warned about for having no cwd, which keeps each project's folder in the key.
    // 已就“本地服务器未固定 cwd”警告过的服务器名（每个项目目录各自成键）
    const unfixed = new Set<string>()

    // Takes only data from the Location that opens it: the connection outlives that Location's claim.
    const open = (key: string, input: Pick<Input, "name" | "config" | "directory" | "clientInfo" | "mcpEvents">) => {
      const slot: Slot = {
        // 持有者集合
        holders: new Set(),
        // 槽位信号量
        lock: Semaphore.makeUnsafe(1),
        // 一次性结果
        outcome: Deferred.makeUnsafe(),
        // 尚未连上
        connected: false,
        // 底层共享连接（shared 模式）
        connection: McpConnection.make({
          // 服务器名
          name: input.name,
          // 配置
          config: input.config,
          // 目录
          directory: input.directory,
          // 共享模式
          shared: true,
          // 客户端标识
          clientInfo: input.clientInfo,
          mcpEvents: input.mcpEvents,
          // Every holder of a key presents the same credential, so any of them can build the provider.
          // OAuth 提供者：同键持有者凭证一致，任取一个持有者构建
          authProvider: Effect.suspend(() => slot.holders.values().next().value?.authProvider ?? Effect.undefined),
          // 交互路由
          elicitation: {
            // Elicitations a request carries reach that request's Location. Any other one, which the
            // server could not tie to a request, goes to every holder and the first answer wins; the
            // others are interrupted, which cancels their forms.
            // create：带请求的交互发给该请求的 Location；其余的广播给所有持有者，首个应答胜出
            create: (request) =>
              Effect.suspend(() => {
                // 当前全部持有者
                const holders = Array.from(slot.holders)
                // 没有持有者：直接取消
                if (holders.length === 0) return Effect.succeed({ action: "cancel" as const })
                // 竞速全部持有者，取第一个应答
                return Effect.raceAll(holders.map((holder) => holder.elicitation(request)))
              }),
            // complete：共享连接无旧版 URL 交互，空实现
            complete: () => Effect.void,
          },
          // 恒为宿主环境
          environment: host,
          // 注入 fetch
          fetch,
          // 池自身作用域
          scope,
          // 生命周期互斥换成槽位信号量
          lock: (effect) => slot.lock.withPermit(effect),
          // 回调与后台恢复都跑在池运行时
          callbacks: run,
          fork: run,
          // 池级事件处理
          events: {
            // 连接中：无需处理（持有者各自已收到自己的 connecting）
            connecting: Effect.void,
            // 已连接：无需处理
            connected: Effect.void,
            // A server that answered but refused the pooled handshake, such as one that wants roots, may
            // still accept the Location's own connection; anything unreachable would only fail again.
            // failed：把槽从池中摘除；服务器有应答但拒绝时记入不可共享集合
            failed: (failure, answered) =>
              Effect.gen(function* () {
                // 摘除槽位
                detach(key, slot)
                // 有应答的拒绝：记警告并标记该键不可共享
                if (answered) {
                  unpoolable.add(key)
                  yield* Effect.logWarning("mcp pool ignored: server refused the shared connection", {
                    server: input.name,
                    error: failure.error,
                  })
                }
                // 结算结果：有应答 → 私有，否则按失败
                yield* Deferred.succeed(slot.outcome, answered ? "private" : failure)
              }),
            // legacy：服务器协商到旧协议——摘槽、记不可共享与旧协议集合、结果转私有
            legacy: (version) =>
              Effect.gen(function* () {
                // 摘除槽位
                detach(key, slot)
                // 该键不可共享
                unpoolable.add(key)
                // 该键为旧协议
                legacy.add(key)
                // 记警告日志
                yield* Effect.logWarning("mcp pool ignored: server speaks an older protocol", {
                  server: input.name,
                  version,
                })
                // 结算为私有
                yield* Deferred.succeed(slot.outcome, "private")
              }),
            // settled：无需处理
            settled: Effect.void,
            // closed：共享连接自行关闭——摘槽、清持有者、停止连接并逐个通知
            closed: (reason) =>
              Effect.gen(function* () {
                // 摘除槽位
                detach(key, slot)
                // 取当前全部持有者
                const holders = Array.from(slot.holders)
                // 清空持有者
                slot.holders.clear()
                // 停止底层连接
                yield* slot.connection.stop
                // 逐个通知持有者连接已关
                for (const holder of holders) holder.closed(reason)
              }),
            // changed：已连接时把目录变化广播给所有持有者
            changed: (kind) =>
              Effect.sync(() => {
                if (slot.connected) for (const holder of slot.holders) holder.changed(kind)
              }),
          },
        }),
      }
      // 登记槽位
      slots.set(key, slot)
      // 返回槽位
      return slot
    }

    // connect：启动共享连接并结算结果
    const connect = (key: string, slot: Slot) =>
      Effect.gen(function* () {
        // 启动底层共享连接
        yield* slot.connection.start
        // A failed or legacy start already settled the outcome.
        // 失败或旧协议的启动已自行结算，这里只需处理成功路径
        if (!slot.connection.client) return
        // 标记已连接
        slot.connected = true
        // 结算为“已连接”
        yield* Deferred.succeed(slot.outcome, "connected")
      }).pipe(
        // 槽位信号量串行
        slot.lock.withPermit,
        // Holders wait on the outcome, so an attempt that dies still settles it.
        // 启动本身死亡时也要结算结果（持有者在等）
        Effect.onError((cause) =>
          Effect.suspend(() => {
            // 摘除槽位
            detach(key, slot)
            // 以失败结算
            return Deferred.succeed(slot.outcome, { status: "failed", error: String(Cause.squash(cause)) })
          }),
        ),
      )

    // detach：槽位仍登记在表时将其移除
    const detach = (key: string, slot: Slot) => {
      if (slots.get(key) === slot) slots.delete(key)
    }

    // Closes as soon as the last holder lets go, interrupting a start nobody waits for anymore.
    // release：持有者放手；最后一个放手时中断启动并关闭连接
    const release = (key: string, slot: Slot, holder: Holder) =>
      Effect.suspend(() => {
        // 移除该持有者
        slot.holders.delete(holder)
        // 还有别的持有者：不动
        if (slot.holders.size > 0) return Effect.void
        // 摘除槽位
        detach(key, slot)
        // 关闭收尾
        return Effect.gen(function* () {
          // 无人等待的启动直接中断
          if (slot.start) yield* Fiber.interrupt(slot.start)
          // 在槽位锁下停止连接
          yield* slot.connection.stop.pipe(slot.lock.withPermit)
        })
      })

    // acquire：加入槽位并等待结果（成功返回共享连接，否则返回结果）
    const acquire = Effect.fnUntraced(function* (key: string, input: Input, holder: Holder) {
      // 已知不可共享的键：直接转私有
      if (unpoolable.has(key)) return "private" as const
      // 取现有槽位或新开一个
      const slot =
        slots.get(key) ??
        open(key, {
          name: input.name,
          config: input.config,
          directory: input.directory,
          clientInfo: input.clientInfo,
          mcpEvents: input.mcpEvents,
        })
      yield* Effect.acquireRelease(
        Effect.sync(() => slot.holders.add(holder)),
        () => release(key, slot, holder),
      )
      // Started once a holder is registered: the attempt reads its OAuth provider from the holders.
      // 有持有者登记后才启动（尝试从持有者处读 OAuth 提供者）
      slot.start ??= run(connect(key, slot))
      // 等待结果
      const outcome = yield* Deferred.await(slot.outcome)
      // 成功返回共享连接，否则返回结果值
      return outcome === "connected" ? slot.connection : outcome
    })

    // connection：为某 Location 构造一个可共享的连接外观
    const connection = (input: Input): McpConnection.Connection => {
      // 本外观的状态：占用、持有者、共享连接与自有连接
      const state: {
        claim?: Scope.Closeable
        holder?: Holder
        shared?: McpConnection.Connection
        own?: McpConnection.Connection
        // This start's credential selection, which a private connection opens with as well.
        // 本次 start 的凭证选定结果（私有连接也用它打开）
        selected?: Selection
      } = {}
      // A private connection, used when the key can't be shared, with the configured protocol or plain legacy.
      // privately：构造私有连接（配置协议或纯 legacy）
      const privately = (config: Mcp.ServerConfig) =>
        McpConnection.make({
          // 展开原输入
          ...input,
          // 覆盖配置
          config,
          // OAuth 提供者：优先本次选定，否则原输入
          authProvider: Effect.suspend(() => state.selected?.authProvider ?? input.authProvider),
        })
      // 按配置协议的私有连接
      const configured = privately(input.config)
      // 旧协议私有连接（已知 legacy 时用）
      const older = privately({ ...input.config, protocol: "legacy" })
      // live：当前生效的连接（共享优先，其次自有，最后配置的）
      const live = () => state.shared ?? state.own ?? configured
      // The shared connection carries the name of the Location that opened it; forms show this Location's.
      // elicit：共享连接上的交互改挂本 Location 的服务器名
      const elicit: McpClient.ElicitationHandler["create"] = (request) =>
        input.elicitation.create({ ...request, server: input.name })

      // Holder callbacks run in the Location's own callback runtime, under its lock, and only while the
      // claim they belong to is the current one.
      // current：在 Location 自己的回调运行时与锁下执行；仅当占用仍是当前者时
      const current = (holder: Holder, effect: () => Effect.Effect<void>) =>
        input.callbacks(
          Effect.suspend(() => (state.holder === holder ? effect() : Effect.void)).pipe(input.lock, Effect.ignore),
        )

      // clear：清理占用（关闭占用作用域并复位状态）
      const clear = Effect.suspend(() => {
        // 取当前占用
        const claim = state.claim
        // 复位状态
        state.claim = undefined
        state.holder = undefined
        state.shared = undefined
        // 关闭占用作用域（有占用时）
        return claim ? Scope.close(claim, Exit.void) : Effect.void
      })

      // Resolves false when the key can't be shared, leaving the start to the Location's own connection.
      // join：尝试加入共享连接；键不可共享时返回 false，由 Location 自己的连接启动
      const join = (selected: Selection) =>
        Effect.gen(function* () {
          // 先广播“连接中”
          yield* input.events.connecting
          // 从输入作用域分叉占用作用域
          const claim = yield* Scope.fork(input.scope)
          // 构造持有者（回调走 current 包装）
          const holder: Holder = {
            authProvider: selected.authProvider,
            elicitation: elicit,
            closed: (reason) => current(holder, () => input.events.closed(reason)),
            changed: (kind) => current(holder, () => input.events.changed(kind)),
          }
          // 登记占用与持有者
          state.claim = claim
          state.holder = holder
          // 加入槽位并等待结果（占用作用域内；被中断则清理）
          const outcome = yield* acquire(selected.key, input, holder).pipe(
            Scope.provide(claim),
            Effect.onInterrupt(() => clear),
          )
          // 转私有：清理并返回 false
          if (outcome === "private") {
            yield* clear
            return false
          }
          // 共享连接失败：清理并上报失败，返回 true（start 视为已处理）
          if ("status" in outcome) {
            yield* clear
            yield* input.events.failed(outcome, false)
            return true
          }
          // 成功：登记共享连接并广播已连接
          state.shared = outcome
          yield* input.events.connected
          return true
        }).pipe(Effect.onExit((exit) => (Exit.isSuccess(exit) && !exit.value ? Effect.void : input.events.settled)))

      // Requests through a shared connection bring this Location's elicitation handler along.
      // bind：把本 Location 的交互处理器绑定到共享连接的请求上
      const bind = (client: McpClient.Connection): McpClient.Connection => ({
        // 展开原连接
        ...client,
        // 工具调用带 elicit
        callTool: (request) => client.callTool({ elicitation: elicit, ...request }),
        // 提示词带 elicit
        prompt: (request) => client.prompt({ elicitation: elicit, ...request }),
        // 资源读取带 elicit
        readResource: (request) => client.readResource({ elicitation: elicit, ...request }),
      })

      return {
        // 当前客户端
        get client() {
          return live().client
        },
        // 当前工具列表
        get tools() {
          return live().tools
        },
        // 当前提示词列表
        get prompts() {
          return live().prompts
        },
        // start：先试共享，不行再走自有连接
        start: Effect.gen(function* () {
          // 本地服务器未固定 cwd 时警告一次（每个项目目录各自成键）
          if (input.config.type === "local" && input.config.cwd === undefined && !unfixed.has(input.name)) {
            unfixed.add(input.name)
            yield* Effect.logWarning(
              "mcp pool ignored: local server has no fixed cwd, so each directory runs its own",
              {
                server: input.name,
              },
            )
          }
          // 运行凭证选定
          const selected = yield* input.select
          // 登记选定结果
          state.selected = selected
          // 键可共享且成功加入：结束
          if (!unpoolable.has(selected.key) && (yield* join(selected))) return
          // 否则用自有连接：已知 legacy 用旧协议连接，否则用配置
          state.own = legacy.has(selected.key) ? older : configured
          yield* state.own.start
        }),
        // stop：放手共享占用，或停止自有连接
        stop: Effect.gen(function* () {
          // 没有共享占用：停自有（或配置的）连接
          if (!state.claim) return yield* (state.own ?? configured).stop
          // 清理占用
          yield* clear
          // 广播三类目录清空
          yield* input.events.changed("tools")
          yield* input.events.changed("resources")
          yield* input.events.changed("prompts")
        }),
        // recovering：共享连接上绑定 elicit 后执行；自有连接直接执行
        recovering: (client, request) =>
          state.shared
            ? state.shared.recovering(client, (client) => request(bind(client)))
            : (state.own ?? configured).recovering(client, request),
        // catalog：从当前生效连接拉取
        catalog: (client) => live().catalog(client),
      }
    }

    // 返回服务实现
    return Service.of({ connection })
  }),
)

// node：注册为全局节点（不绑定 Location），依赖生成器与 http fetch 节点
export const node = makeGlobalNode({ service: Service, layer, deps: [CrossSpawnSpawner.node, httpFetch] })
