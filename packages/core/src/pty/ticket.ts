// 将本模块以命名空间 `PtyTicket` 全量导出
export * as PtyTicket from "./ticket.js"

// 引入工作区类型（仅类型）
import type { Workspace } from "@opencode/schema/workspace"
// 引入 PTY 票据 schema（连接令牌）
import { PtyTicket } from "@opencode/schema/pty-ticket"
// 引入 PTY 类型（仅类型）
import type { Pty } from "@opencode/schema/pty"
// 引入 Effect 原语：Cache（带 TTL 的缓存）、Context、Duration、Effect、Layer
import { Cache, Context, Duration, Effect, Layer } from "effect"
// 引入全局节点工厂
import { makeGlobalNode } from "@opencode/util/effect/app-node"

// 票据默认有效期：60 秒
const DEFAULT_TTL = Duration.seconds(60)
// 缓存容量上限：1 万条
const CAPACITY = 10_000

// 导出连接令牌 schema（票据+过期时间的响应结构）
export const ConnectToken = PtyTicket.ConnectToken

// A ticket authorizes one upgrade to one target: a PTY, or a client MCP connection by client name.
// 票据目标：一次升级只授权一个目标——某个 PTY，或按客户端名标识的 MCP 连接
export type Target =
  // PTY 目标
  | { readonly ptyID: Pty.ID; readonly mcpClient?: never }
  // MCP 客户端目标
  | { readonly mcpClient: string; readonly ptyID?: never }

// 票据作用域：目标 + 可选的目录与工作区限定
export type Scope = Target & {
  // 限定目录（可选）
  readonly directory?: string
  // 限定工作区（可选）
  readonly workspaceID?: Workspace.ID
}

// 缓存中存储的票据记录：与作用域一一对应的可比较结构
type Stored = {
  // 归一化的目标字符串（pty:ID 或 mcp:client）
  readonly target: string
  // 限定目录（可选）
  readonly directory?: string
  // 限定工作区（可选）
  readonly workspaceID?: Workspace.ID
}

// 票据服务接口：签发与核销
export interface Interface {
  // issue：签发票据，返回连接令牌
  issue(input: Scope): Effect.Effect<typeof ConnectToken.Type>
  // consume：核销票据——存在且作用域匹配时返回 true（票据一次性使用）
  consume(input: Scope & { readonly ticket: string }): Effect.Effect<boolean>
}

// 定义服务标签，供依赖注入系统识别本服务
export class Service extends Context.Service<Service, Interface>()("@opencode/PtyTicket") {}

// 把作用域归一化为存储记录：目标转为稳定字符串
function stored(scope: Scope): Stored {
  return {
    // PTY 目标 -> "pty:<id>"；MCP 目标 -> "mcp:<client>"
    target: scope.ptyID !== undefined ? `pty:${scope.ptyID}` : `mcp:${scope.mcpClient}`,
    // 原样保留目录限定
    directory: scope.directory,
    // 原样保留工作区限定
    workspaceID: scope.workspaceID,
  }
}

// 判断存储记录与请求作用域是否完全匹配
function matches(record: Stored, input: Stored) {
  return (
    // 目标相同
    record.target === input.target && record.directory === input.directory && record.workspaceID === input.workspaceID
  )
}

// Tickets are inserted via Cache.set and removed atomically via invalidateWhen. The lookup is
// never invoked; it dies if it ever is, which would signal a misuse of the Service interface.
// 票据只经 Cache.set 写入、经 invalidateWhen 原子移除；lookup 永远不应被调用——若被调用则直接
// 中止，表示对服务接口的误用
const noLookup = () => Effect.die(new Error("PtyTicket cache must be used via set/invalidateWhen, never get"))

// Visible for tests so the TTL can be shortened. Production uses `layer` with the default TTL.
// 构建服务实现（导出供测试缩短 TTL）；生产环境使用带默认 TTL 的 layer
export const make = (ttl: Duration.Input = DEFAULT_TTL) =>
  Effect.gen(function* () {
    // 创建票据缓存：容量 1 万、禁止读取、按 TTL 过期
    const cache = yield* Cache.make<string, Stored>({ capacity: CAPACITY, lookup: noLookup, timeToLive: ttl })
    // 计算过期秒数（至少 1 秒），随令牌返回给客户端
    const expiresIn = Math.max(1, Math.round(Duration.toSeconds(Duration.fromInputUnsafe(ttl))))
    // 组装服务实现
    return Service.of({
      // issue 实现：生成随机票据并写入缓存
      issue: Effect.fn("PtyTicket.issue")(function* (input) {
        // 生成随机 UUID 作为票据
        const ticket = crypto.randomUUID()
        // 把作用域记录写入缓存
        yield* Cache.set(cache, ticket, stored(input))
        // 返回票据与过期秒数
        return { ticket, expires_in: expiresIn }
      }),
      // consume 实现：当且仅当记录存在且作用域匹配时原子失效该票据
      consume: Effect.fn("PtyTicket.consume")(function* (input) {
        // invalidateWhen 返回是否成功失效
        return yield* Cache.invalidateWhen(cache, input.ticket, (record) => matches(record, stored(input)))
      }),
    })
  })

// 生产服务层：默认 TTL
const layer = Layer.effect(Service, make())

// 创建全局节点：票据服务为宿主级单例，无额外依赖
export const node = makeGlobalNode({ service: Service, layer: layer, deps: [] })
