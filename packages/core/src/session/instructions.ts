// 会话指令（SessionInstructions）模块：把用户在会话中引用的指令文件（如 AGENTS.md）
// 作为一条合成消息（synthetic message）注入会话历史，并去重避免重复注入。
export * as SessionInstructions from "./instructions.js"

// Node 的 path 工具：计算相对路径
import { relative } from "path"
// Effect 核心：Context、Effect、Layer、Option、Ref（可变引用）、Schema
import { Context, Effect, Layer, Option, Ref, Schema } from "effect"
// Location 级单例节点构造工具（依赖随 Location 变化）
import { makeLocationNode } from "@opencode/util/effect/app-node"
// 事件总线
import { Bus } from "../bus.js"
// 数据库服务
import { Database } from "../database/database.js"
// 文件系统工具服务（读取文件、路径判断等）
import { FSUtil } from "@opencode/util/fs-util"
// Location 服务：提供项目目录等位置信息
import { Location } from "../location.js"
// 会话事件定义（如 Synthetic 事件）
import { SessionEvent } from "./event.js"
// 消息解码错误类型
import { MessageDecodeError } from "./error.js"
// 会话历史服务：查询会话中的合成消息
import { SessionHistory } from "./history.js"
// 会话消息类型（含 Synthetic）
import { SessionMessage } from "./message.js"
// 会话领域的 Schema（如会话 ID 类型）
import { SessionSchema } from "./schema.js"

// 合成消息元数据的 Schema：用于识别"由本模块注入"的指令合成消息及其文件路径清单
const InjectedMetadata = Schema.Struct({
  instruction: Schema.Struct({ paths: Schema.Array(Schema.String) }),
})

// 服务接口：load 把指定路径的指令文件注入会话（失败类型为解码错误或文件系统错误）
export interface Interface {
  readonly load: (input: {
    readonly sessionID: SessionSchema.ID
    readonly paths: ReadonlyArray<string>
  }) => Effect.Effect<void, MessageDecodeError | FSUtil.Error>
}

// 服务标识：Effect Context 中用于定位本服务的 Tag
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionInstructions") {}

// 服务层（Layer）：装配 load 的具体实现
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 依次注入事件总线、文件系统、数据库与位置服务
    const bus = yield* Bus.Service
    const fs = yield* FSUtil.Service
    const db = (yield* Database.Service).db
    const location = yield* Location.Service
    // Resolved once for the Location layer; the synthetic text and dedup ledger keep
    // absolute paths, but the human-facing description shows paths relative to the project
    // root so opening a subdirectory still describes paths from the project root.
    // 解析项目根目录（每个 Location 层只解析一次）
    const root = yield* fs.resolve(location.project.directory)
    // Same-step parallel reads settle concurrently, so an in-memory claim guards each
    // Session/path pair while a load is in flight. The claim is released once the load
    // settles: the synthetic message metadata scanned below is the only lasting ledger,
    // so paths whose synthetics drop out of model-visible history (compaction, revert)
    // are re-discovered and re-injected instead of staying silently lost.
    // 用内存中的"认领表"记录正在加载的 (会话, 路径) 组合，防止并发重复注入
    const inFlight = yield* Ref.make<Map<SessionSchema.ID, Set<string>>>(new Map())

    // load：注入指令文件的主流程（认领 -> 过滤已注入 -> 读取 -> 发布合成消息 -> 释放认领）
    const load = Effect.fn("SessionInstructions.load")(function* (input: Parameters<Interface["load"]>[0]) {
      // 原子地认领尚未在加载中的路径，返回本次真正认领到的路径集合
      const claimed = yield* Ref.modify(inFlight, (map) => {
        const existing = map.get(input.sessionID) ?? new Set<string>()
        // 过滤出既不在认领表中的路径
        const newlyClaimed = input.paths.filter((path) => !existing.has(path))
        // 没有新认领则原样返回
        if (newlyClaimed.length === 0) return [newlyClaimed, map]
        // 把新认领的路径加入该会话的集合（复制后更新）
        const next = new Map(map)
        next.set(input.sessionID, new Set([...existing, ...newlyClaimed]))
        return [newlyClaimed, next]
      })
      // 一个都没认领到说明并发任务已覆盖，直接返回
      if (claimed.length === 0) return
      yield* Effect.gen(function* () {
        // 查询历史中已经注入过的路径（持久化的去重台账）
        const alreadyInjected = yield* previouslyInjected(db, input.sessionID)
        // 认领的路径里再过滤掉历史上已注入的
        const toInject = claimed.filter((path) => !alreadyInjected.has(path))
        // 全部已注入则无需操作
        if (toInject.length === 0) return
        // 并发读取每个文件；读取失败（返回 undefined）的文件被跳过
        const files = yield* Effect.forEach(
          toInject,
          (path) =>
            fs
              .readFileStringSafe(path)
              .pipe(Effect.map((content) => (content === undefined ? undefined : { path, content }))),
          { concurrency: "unbounded" },
        )
        // 只保留成功读取的文件
        const readable = files.filter((file): file is { path: string; content: string } => file !== undefined)
        // 一个都读不到则不发布消息
        if (readable.length === 0) return
        // Publish directly rather than through Session.synthetic: a Location-scoped layer
        // cannot depend on Session (it routes through LocationServiceMap, forming a type
        // cycle with this node). The durable publish commits the synthetic and its metadata
        // ledger atomically, so releasing the claim afterwards cannot readmit the paths.
        // 直接向总线发布合成消息：正文为各文件内容，描述为人读的相对路径，
        // 元数据记录注入的绝对路径（作为去重台账）
        yield* bus.publish(SessionEvent.Synthetic, {
          sessionID: input.sessionID,
          text: readable.map((file) => `Instructions from: ${file.path}\n${file.content}`).join("\n\n"),
          description: `Loaded ${readable.map((file) => describePath(root, file.path)).join(", ")}`,
          metadata: { instruction: { paths: readable.map((file) => file.path) } },
        })
      }).pipe(
        // 无论成功失败都要释放认领，避免认领泄漏阻塞后续注入
        Effect.ensuring(
          Ref.update(inFlight, (map) => {
            const existing = map.get(input.sessionID)
            // 会话不在认领表中则无需修改
            if (!existing) return map
            // 从集合中移除本次认领的路径
            const remaining = new Set([...existing].filter((path) => !claimed.includes(path)))
            const next = new Map(map)
            // 集合为空则删除该会话的条目，否则更新
            if (remaining.size === 0) next.delete(input.sessionID)
            else next.set(input.sessionID, remaining)
            return next
          }),
        ),
      )
    })

    return Service.of({ load })
  }),
)

// previouslyInjected：扫描会话历史中的合成消息，汇总已被注入过的指令文件路径集合
function previouslyInjected(db: Database.Interface["db"], sessionID: SessionSchema.ID) {
  return Effect.gen(function* () {
    // 查询该会话的全部合成消息
    const history = yield* SessionHistory.synthetics(db, sessionID)
    return new Set(
      history
        // 只处理类型为 synthetic 的消息
        .filter((message): message is SessionMessage.Synthetic => message.type === "synthetic")
        // 解码元数据，成功则取出 instruction.paths 拍平汇总
        .flatMap(
          (message) =>
            Option.getOrUndefined(Schema.decodeUnknownOption(InjectedMetadata)(message.metadata))?.instruction.paths ??
            [],
        ),
    )
  })
}

// Paths are normally discovered under the project root, so the description shows them
// relative to it. A directly-loaded path outside the root falls back to its absolute form
// rather than emitting `../..` chains.
// describePath：把路径转成面向用户显示的形式——项目根内用相对路径，根外退回绝对路径
function describePath(root: string, path: string) {
  return FSUtil.contains(root, path) ? relative(root, path) : path
}

// 注册为 Location 级节点：每个项目位置各一份实例，依赖总线/数据库/文件系统/位置节点
export const node = makeLocationNode({
  name: "session-instructions",
  layer,
  deps: [Bus.node, Database.node, FSUtil.node, Location.node],
})
