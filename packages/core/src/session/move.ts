// 会话迁移（SessionMove）模块：把会话移动到另一个目录/工作区，
// 或在目标不可用、会话仍在执行时通过收件箱（Inbox）排队执行迁移。
export * as SessionMove from "./move.js"

// 会话领域的类型（Session.Info 等，仅类型）
import type { Session } from "@opencode/schema/session"
// 全局单例节点构造工具
import { makeGlobalNode } from "@opencode/util/effect/app-node"
// 文件系统工具服务
import { FSUtil } from "@opencode/util/fs-util"
// 全局服务：提供用户主目录等全局信息
import { Global } from "@opencode/util/global"
// Effect 核心：Cause（原因）、Context、Effect、Layer、Schema
import { Cause, Context, Effect, Layer, Schema } from "effect"
// Node 的 path 工具：路径拼接/解析/相对化
import path from "path"
// 事件总线
import { Bus } from "../bus.js"
// 数据库服务
import { Database } from "../database/database.js"
// 实例（Instance）服务：按会话位置提供运行实例
import { Instance } from "../instance/service.js"
// Location 服务：位置引用与上下文
import { Location } from "../location.js"
// 位置服务映射：按目录/工作区作用域化各服务
import { LocationServiceMap } from "../location-service-map.js"
// 项目服务：把目录解析为项目
import { Project } from "../project.js"
// 绝对/相对路径品牌类型构造器
import { AbsolutePath, RelativePath } from "../schema.js"
// 会话未找到错误
import { NotFoundError } from "./error.js"
// 会话事件定义（如 Moved、InboxCancelled）
import { SessionEvent } from "./event.js"
// 会话执行（Execution）服务：判断会话是否在执行、唤醒执行器
import { SessionExecution } from "./execution.js"
// 会话收件箱（Inbox）服务：投递/排队会话操作
import { SessionInbox } from "./inbox.js"
// 会话消息类型（生成消息 ID）
import { SessionMessage } from "./message.js"
// 会话投影器（Projector）节点：作为本节点的依赖
import { SessionProjector } from "./projector.js"
// 会话运行器（Runner）节点：探测源位置可用性
import { SessionRunner } from "./runner/index.js"
// 会话存储服务：读取会话
import { SessionStore } from "./store.js"

// 目标目录不存在错误（携带目录绝对路径）
export class DestinationNotFoundError extends Schema.TaggedError<DestinationNotFoundError>()(
  "Session.DestinationNotFoundError",
  { directory: AbsolutePath },
) {}

// 目标不是目录错误（例如指向了文件）
export class DestinationNotDirectoryError extends Schema.TaggedError<DestinationNotDirectoryError>()(
  "Session.DestinationNotDirectoryError",
  { directory: AbsolutePath },
) {}

// 目标位置不可用错误（例如目标项目上下文无法初始化）
export class DestinationUnavailableError extends Schema.TaggedError<DestinationUnavailableError>()(
  "Session.DestinationUnavailableError",
  { directory: AbsolutePath },
) {}

// 服务接口：move 把会话移动到目标目录（可选工作区与投递方式）
export interface Interface {
  readonly move: (input: {
    sessionID: Session.ID
    directory: AbsolutePath
    workspaceID?: Location.Ref["workspaceID"]
    delivery?: SessionInbox.Delivery
  }) => Effect.Effect<
    void,
    NotFoundError | DestinationNotFoundError | DestinationNotDirectoryError | DestinationUnavailableError
  >
}

// 服务标识：Effect Context 中用于定位本服务的 Tag
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionMove") {}

// 服务层（Layer）：装配迁移逻辑
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 依次注入迁移所需的各个服务
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const projects = yield* Project.Service
    const locations = yield* LocationServiceMap.Service
    const store = yield* SessionStore.Service
    const execution = yield* SessionExecution.Service
    const instances = yield* Instance.Service
    const admission = yield* SessionInbox.Service
    const database = yield* Database.Service
    const bus = yield* Bus.Service

    // get：读取会话，不存在则抛 NotFoundError
    const get = Effect.fn("SessionMove.get")(function* (sessionID: Session.ID) {
      const session = yield* store.get(sessionID)
      if (!session) return yield* new NotFoundError({ sessionID })
      return session
    })

    // resolveDestination：把用户输入的目录解析并校验为迁移目标（MovePayload）
    const resolveDestination = Effect.fn("SessionMove.resolveDestination")(function* (
      session: Session.Info,
      input: Parameters<Interface["move"]>[0],
    ) {
      // 去掉首尾空白
      const value = input.directory.trim()
      // 展开 ~ 与 ~/ 前缀为用户主目录
      const expanded =
        value === "~" ? global.home : value.startsWith("~/") ? path.join(global.home, value.slice(2)) : value
      // 以会话当前目录为基准解析为绝对路径
      const directory = AbsolutePath.make(path.resolve(session.location.directory, expanded))
      // 统计目标路径信息；stat 失败视为不存在
      const info = yield* fs.stat(directory).pipe(Effect.orElseSucceed(() => undefined))
      // 目标不存在则报错
      if (!info) return yield* new DestinationNotFoundError({ directory })
      // 目标不是目录则报错
      if (info.type !== "Directory") return yield* new DestinationNotDirectoryError({ directory })
      // 把目标目录解析为所属项目
      const project = yield* projects.resolve(directory)
      // 组装迁移载荷：目标位置引用、项目 ID 与项目内相对子路径
      const destination: SessionInbox.MovePayload = {
        location: Location.Ref.make({ directory, workspaceID: input.workspaceID }),
        projectID: project.id,
        subpath: RelativePath.make(path.relative(project.directory, directory).replaceAll("\\", "/")),
      }
      // 在目标位置作用域内验证各服务可用；中断原因保持中断，其余失败降级为"目标不可用"错误
      yield* locations.contextEffect(destination.location).pipe(
        Effect.scoped,
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause))
            return Effect.failCause(Cause.fromReasons<never>(cause.reasons.filter(Cause.isInterruptReason)))
          return Effect.logWarning("session move destination unavailable", { directory, cause }).pipe(
            Effect.andThen(Effect.fail(new DestinationUnavailableError({ directory }))),
          )
        }),
      )
      return destination
    })

    // sourceUnavailable：探测"源位置是否已不可用"（此时必须直接迁移而非排队）
    const sourceUnavailable = Effect.fn("SessionMove.sourceUnavailable")(function* (session: Session.Info) {
      // 会话正在执行时，源始终可用
      if (yield* execution.isActive(session.id)) return false
      // 源目录已不存在（被删除/卸载）则不可用
      if (!(yield* fs.isDir(session.location.directory))) return true
      // 尝试在该会话的实例上提供 Runner 服务；被中断则保持中断，
      // 其他失败说明源位置起不来 Runner，即源不可用
      return yield* SessionRunner.Service.pipe(
        instances.provide(session),
        Effect.as(false),
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(Cause.fromReasons<never>(cause.reasons.filter(Cause.isInterruptReason)))
            : Effect.succeed(true),
        ),
      )
    })

    return Service.of({
      // move：迁移入口
      move: Effect.fn("SessionMove.move")(function* (input) {
        // 读取会话（不存在则失败）
        const session = yield* get(input.sessionID)
        // 解析并校验目标位置
        const destination = yield* resolveDestination(session, input)
        // Probe outside the inbox lock so cancellation remains available during initialization.
        // 在收件箱锁外先探测源可用性，保证初始化期间仍可被取消
        const unavailable = yield* sourceUnavailable(session)
        // 构造收件箱条目；未指定投递方式默认 steer（插队执行）
        const item = SessionInbox.Item.make({
          type: "move",
          payload: destination,
          delivery: input.delivery ?? "steer",
        })
        // 在会话的串行（serialized）作用域内决定"直接迁移"还是"排队迁移"
        yield* SessionInbox.serialized(
          input.sessionID,
          Effect.gen(function* () {
            // 锁内重读会话最新状态
            const latest = yield* get(input.sessionID)
            // Only recover the placement we probed; active runners retain their step-boundary handoff.
            // 仅当探测结论仍然成立（位置未变且未在执行）时才走直接迁移路径
            if (
              unavailable &&
              latest.location.directory === session.location.directory &&
              latest.location.workspaceID === session.location.workspaceID &&
              !(yield* execution.isActive(input.sessionID))
            ) {
              // 先收集该会话所有待处理的收件箱条目，逐个构造取消事件
              const cancellations = (yield* SessionInbox.moveIDs(database.db, input.sessionID)).map(
                (item) => [SessionEvent.InboxCancelled, { sessionID: input.sessionID, inboxID: item.id }] as const,
              )
              // 再构造迁移事件（携带目标信息）
              const moved = [SessionEvent.Moved, { sessionID: input.sessionID, ...destination }] as const
              // 没有待取消条目时只发布迁移事件
              const first = cancellations[0]
              if (!first) return yield* bus.publish(...moved).pipe(Effect.asVoid)
              // 否则按序发布：取消事件们 + 迁移事件（同一批次保证原子性）
              return yield* bus.publishAll([first, ...cancellations.slice(1), moved])
            }
            // 目标仍可用或会话在执行：把迁移作为收件箱条目排队，由执行器在步骤边界处理
            yield* admission
              .admit({
                id: SessionMessage.ID.create(),
                sessionID: input.sessionID,
                item,
              })
              .pipe(Effect.orDie)
          }),
        )
        // 唤醒执行器，尽快处理刚排队的迁移
        yield* execution.wake(input.sessionID)
      }),
    })
  }),
)

// 注册为全局单例节点，声明全部依赖节点
export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [
    FSUtil.node,
    Global.node,
    Project.node,
    LocationServiceMap.node,
    SessionStore.node,
    SessionExecution.node,
    Instance.node,
    SessionInbox.node,
    Database.node,
    Bus.node,
    SessionProjector.node,
  ],
})
