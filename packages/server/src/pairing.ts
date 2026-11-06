// 以 ServerPairing 命名空间 re-export 本模块
export * as ServerPairing from "./pairing"

// 引入 Effect 核心：Cache（带 TTL 的缓存）、Context（依赖注入标签）、Duration（时长）、Effect、Layer（层）
import { Cache, Context, Duration, Effect, Layer } from "effect"
// 引入全局节点工厂：把服务注册为进程级共享单例
import { makeGlobalNode } from "@opencode/util/effect/app-node"
// 引入 Node 加密模块的随机字节生成
import { randomBytes } from "node:crypto"

// 配对码（pairing code）的有效期：5 分钟
const TTL = Duration.minutes(5)

// 服务接口：签发与消费配对码
export interface Interface {
  // 签发一个新配对码，返回码本身与以秒计的过期时间
  readonly issue: () => Effect.Effect<{ readonly code: string; readonly expires_in: number }>
  // 消费（校验并删除）一个配对码，返回其是否有效
  readonly consume: (code: string) => Effect.Effect<boolean>
}

// 将接口包装为 Effect Context Tag，供依赖注入使用
export class Service extends Context.Service<Service, Interface>()("@opencode/ServerPairing") {}

// 缓存条目只通过 Cache.set 写入、通过 invalidateWhen 移除，因此 lookup 永远不应被执行。
// Codes are inserted via Cache.set and removed via invalidateWhen, so the lookup never runs.
// lookup 兜底实现：一旦被触发就以缺陷（die）终止，说明使用方式非法
const noLookup = () => Effect.die(new Error("ServerPairing cache must be used via set/invalidateWhen, never get"))

// 构建服务实现层
const layer = Layer.effect(
  // 将实现绑定到 Service Tag
  Service,
  // 构建服务：创建缓存并实现接口方法
  Effect.gen(function* () {
    // 创建容量 1000、带 5 分钟 TTL 的缓存；值恒为 true，仅用作"码存在"的标记
    const cache = yield* Cache.make<string, true>({ capacity: 1_000, lookup: noLookup, timeToLive: TTL })
    // 返回服务实现
    return Service.of({
      // 签发配对码
      issue: Effect.fn("ServerPairing.issue")(function* () {
        // 用 16 个加密安全随机字节生成 base64url 形式的配对码
        const code = randomBytes(16).toString("base64url")
        // 写入缓存，TTL 从此刻开始计时
        yield* Cache.set(cache, code, true)
        // 返回配对码与过期秒数，供客户端展示倒计时
        return { code, expires_in: Duration.toSeconds(TTL) }
      }),
      // 消费配对码
      consume: Effect.fn("ServerPairing.consume")(function* (code) {
        // 缓存中存在该码（谓词恒真）则删除并返回 true；不存在则返回 false
        return yield* Cache.invalidateWhen(cache, code, () => true)
      }),
    })
  }),
)

// 导出全局节点：让 Service 在整个进程内共享同一个实例
export const node = makeGlobalNode({ service: Service, layer, deps: [] })
