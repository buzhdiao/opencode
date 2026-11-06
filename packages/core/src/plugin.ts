// 末尾自导出：便于 `import { Plugin } from "./plugin.js"` 引用命名空间
export * as Plugin from "./plugin.js"
// 转发导出 @opencode/schema/plugin 中的事件、GUI 包、ID、信息、来源与状态定义
export { Event, GuiBundle, ID, Info, Source, State } from "@opencode/schema/plugin"

// 导入 readFile：异步读取文件（读取插件的 GUI bundle 源码）
import { readFile } from "node:fs/promises"
// 导入 fileURLToPath：把 file:// URL 转成文件系统路径
import { fileURLToPath } from "node:url"
// 导入 Plugin 模式定义（类型）
import { Plugin } from "@opencode/schema/plugin"
// 导入 Node：位置节点工厂
import { Node } from "@opencode/util/effect/app-node"
// 导入 LayerNode 类型：节点提供器的返回类型
import { LayerNode } from "@opencode/util/effect/layer-node"
// 仅导入 PersistentPty 类型（用于节点错误类型标注）
import type { PersistentPty } from "./persistent-pty.js"
// 从 effect 库导入：Cause（原因）、Context（上下文）、Effect（效果）、Exit（结果）、Latch（闩）、
// Layer（层）、Logger（日志器）、Queue（队列）、References（引用）、Scope（作用域）、Semaphore（信号量）
import { Cause, Context, Effect, Exit, Latch, Layer, Logger, Queue, References, Scope, Semaphore } from "effect"
// 导入 Bus（事件总线）服务
import { Bus } from "./bus.js"
// 导入 PluginHost：插件宿主（hooks/list 能力的载体）
import { PluginHost } from "./plugin/host.js"
// 导入插件服务本体：Failure（失败）、Generation（代）、Service
import { type Failure, type Generation, Service } from "./plugin/service.js"
// 导入 State（状态管理）模块
import { State } from "./state.js"

// 转发导出 plugin/service.js 中的等待激活、失败/代类型、接口与服务
export { awaitActivation, type Failure, type Generation, type Interface, Service } from "./plugin/service.js"

// layer：Plugin 服务的层实现
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 获取事件总线服务
    const bus = yield* Bus.Service
    // 创建根作用域：所有插件激活的作用域都从这里 fork
    const scope = yield* Scope.make()
    // One slot per requested definition in activation order, including ones whose setup failed, so
    // the prefix diff below stays index-aligned and a failed revision is not retried until it changes.
    // active：按激活顺序为每个请求的定义保留一个槽位，包括 setup 失败的定义，
    // 因此前缀差异（prefix diff）保持索引对齐，失败的修订版在变化前不会被重试。
    const active = new Map<Plugin.ID, Slot>()
    // lock：单许可信号量，串行化激活/关闭操作
    const lock = Semaphore.makeUnsafe(1)
    // ready：就绪闩（latch），初始打开；有挂起变更时关闭，表示激活尚未完成
    const ready = yield* Latch.make(true)
    // pending：当前挂起的持有令牌集合（用于就绪判定）
    const pending = new Set<object>()
    // closed：服务是否已关闭
    let closed = false
    // holdUnsafe：同步地挂起一个持有令牌并关闭就绪闩；返回释放效果
    const holdUnsafe = () => {
      // 已关闭则无事可做
      if (closed) return Effect.void
      // 生成唯一令牌
      const token = {}
      // 登记挂起
      pending.add(token)
      // 关闭就绪闩（表示未就绪）
      ready.closeUnsafe()
      // 返回释放效果
      return Effect.sync(() => {
        // 释放令牌；若这是最后一个挂起则重新打开就绪闩
        if (pending.delete(token) && pending.size === 0) ready.openUnsafe()
      })
    }
    // hold：把 holdUnsafe 包成 Effect
    const hold = () => Effect.sync(holdUnsafe)
    // pendingFailures：待处理的插件失败队列（由后台 worker 消费）
    const pendingFailures = yield* Queue.unbounded<PendingFailure>()
    // discovered：inventory 快照中附加的失败清单
    let discovered: readonly Failure[] = []
    // inventory：最近一次构建的插件信息快照
    let inventory: Plugin.Info[] = []
    // snapshot：拼装完整快照——所有活跃槽位的信息 + 失败清单
    const snapshot = () => [...Array.from(active.values()).map(slotInfo), ...discovered]
    // A changed `./gui-experimental` bundle alone restarts nothing; its revision is part of what changes, so the event
    // tells the app to reload it.
    // publish：仅在快照（含 GUI 修订号）真正变化时发布 Updated 事件。
    // 仅 `./gui-experimental` 包变化不会重启插件；其修订号是变化的一部分，事件会通知应用重载它。
    const publish = State.changes(
      // 变化键：插件信息列表 + 每个活跃槽位的 GUI 修订号
      (items: readonly Plugin.Info[]) => [items, Array.from(active.values(), (entry) => entry.plugin.gui?.revision)],
      // 变化时发布的动作
      () => bus.publish(Plugin.Event.Updated, {}).pipe(Effect.asVoid),
    )
    // list：返回 inventory 快照
    const list = Effect.fn("Plugin.list")(function* () {
      // 直接返回快照
      return inventory
    })
    // gui：返回指定插件的 GUI bundle（源码 + 修订号 + 选项）
    const gui = Effect.fn("Plugin.gui")(function* (id: Plugin.ID) {
      // 取该插件槽位的 GUI 信息
      const gui = active.get(id)?.plugin.gui
      // 无 GUI 则返回 undefined
      if (!gui) return undefined
      // A plugin that resolved a `./gui-experimental` file but cannot read it now is a server fault, not a missing
      // bundle.
      // 读取 GUI 源文件；能解析出路径却读不到属于服务器故障（错误会上抛），而非缺失包
      const code = yield* Effect.promise(() => readFile(fileURLToPath(gui.file), "utf8"))
      // 返回 GUI bundle
      return { code, revision: gui.revision, options: gui.options } satisfies Plugin.GuiBundle
    })
    // hostContext：捕获插件宿主所需的服务上下文（供 load 时提供）
    const hostContext = yield* Effect.context<Effect.Services<ReturnType<typeof PluginHost.make>>>()
    // load：加载单个插件代（Generation）——fork 作用域、分组失败、构造宿主并运行
    const load = Effect.fnUntraced(function* (plugin: Generation) {
      // 激活记录：插件代 + 从根作用域 fork 出的子作用域
      const activation: Activation = { plugin, scope: yield* Scope.fork(scope) }
      // inherit：继承当前的状态继承器（插件内创建的状态跟随插件生命周期）
      const inherit = yield* State.inherit()
      // grouped：把状态变换失败分组——失败时记录激活失败并入队待处理失败
      const grouped = State.group((failure, refresh) => {
        // 记录激活失败信息
        activation.failure = {
          // 错误说明
          error: `Plugin disabled after ${failure.state}.transform failed. Check server logs for details.`,
          // 失败引用 ID（短随机串）
          ref: `err_${crypto.randomUUID().slice(0, 8)}`,
        }
        // 入队待处理失败（含释放令牌）
        Queue.offerUnsafe(pendingFailures, {
          // 插件代
          plugin,
          // 子作用域（稍后关闭）
          scope: activation.scope,
          // 失败详情
          failure,
          // 状态刷新效果
          refresh,
          // 失败引用 ID
          ref: activation.failure.ref,
          // 释放持有令牌的效果
          release: holdUnsafe(),
        })
      })
      // 构造插件宿主（提供 list 能力与上下文）
      const host = yield* PluginHost.make({ list }, plugin.id).pipe(Effect.provideContext(hostContext))
      // 运行插件效果并捕获退出：分组失败、继承状态、定制上下文（新作用域 + 保留日志级别）
      const exit = yield* Effect.suspend(() => plugin.effect(host)).pipe(
        // 失败分组
        grouped,
        // 状态继承
        inherit,
        // 更新上下文：替换作用域并保留当前日志器与最低日志级别
        Effect.updateContext((context: Context.Context<never>) =>
          // 以激活作用域为基础构建上下文
          Context.make(Scope.Scope, activation.scope).pipe(
            // 保留当前日志器
            Context.add(Logger.CurrentLoggers, Context.get(context, Logger.CurrentLoggers)),
            // 保留最低日志级别
            Context.add(References.MinimumLogLevel, Context.get(context, References.MinimumLogLevel)),
          ),
        ),
        // 打上加载 span（附插件 ID）
        Effect.withSpan("Plugin.load", { attributes: { "plugin.id": plugin.id } }),
        // 退出钩子：失败且非插件内记录的失败时关闭子作用域
        Effect.onExit((exit) =>
          Exit.isFailure(exit) && !activation.failure ? Scope.close(activation.scope, exit) : Effect.void,
        ),
        // 捕获退出结果（不向上传播）
        Effect.exit,
      )
      // 插件内已记录失败或成功退出：返回激活记录
      if (activation.failure || Exit.isSuccess(exit)) return { activation } as const
      // 其他失败：记录警告并返回错误信息
      yield* Effect.logWarning("failed to load plugin", {
        // 插件 ID
        "plugin.id": plugin.id,
        // 失败原因
        cause: exit.cause,
      })
      // 返回格式化后的错误
      return { error: Cause.pretty(exit.cause) } as const
    })

    // activate：激活一批插件定义（带前缀差异算法，只重启变化的部分）
    const activate = Effect.fn("Plugin.activate")(function* (
      // 要激活的插件代列表
      plugins: readonly Generation[],
      // 附加的失败清单（默认空）
      failures: readonly Failure[] = [],
    ) {
      // 规范化定义：复制并强制 ID 为 Plugin.ID 类型
      const definitions = plugins.map((plugin) => ({ ...plugin, id: Plugin.ID.make(plugin.id) }))
      // ids：用于查重的集合
      const ids = new Set<Plugin.ID>()
      // 检查重复插件 ID：重复属于缺陷
      for (const definition of definitions) {
        // 已存在则崩溃
        if (ids.has(definition.id)) yield* Effect.die(new Error(`Duplicate plugin ID: ${definition.id}`))
        // 登记新 ID
        ids.add(definition.id)
      }

      // acquireUseRelease：持有期全程保持就绪闩关闭
      yield* Effect.acquireUseRelease(
        // 获取：挂起持有令牌
        hold(),
        // 主体：在信号量保护下执行差异激活
        () =>
          lock.withPermit(
            Effect.gen(function* () {
              // 服务已关闭则跳过
              if (closed) return
              // 记录外部失败清单
              discovered = failures
              // 当前的活跃槽位列表
              const current = Array.from(active.values())
              // 找到第一个与现有槽位不匹配（ID 不同或修订号不同）的定义位置
              const changed = definitions.findIndex((definition, index) => {
                // 对应位置的现有槽位
                const entry = current[index]
                // ID 或修订号不同视为变化
                return entry?.plugin.id !== definition.id || entry.plugin.revision !== definition.revision
              })
              // 未变化的前缀长度：全部匹配时为 definitions.length
              const prefix = changed === -1 ? definitions.length : changed
              // 就地更新未变化前缀的插件代（保留其激活）
              for (const definition of definitions.slice(0, prefix)) {
                // 取现有槽位
                const entry = active.get(definition.id)
                // 存在则只更新插件代
                if (entry) active.set(definition.id, { ...entry, plugin: definition })
              }
              // 完全没有变化（前缀覆盖全部且数量一致）时：更新快照并发布后返回
              if (prefix === definitions.length && active.size === definitions.length) {
                // 更新 inventory
                inventory = snapshot()
                // 发布更新事件
                yield* publish(inventory)
                // 结束
                return
              }

              // 在状态批处理中执行重启：保证状态一致
              yield* State.batch(
                Effect.gen(function* () {
                  // Registrations are ordered by setup, so only the unchanged prefix can stay alive.
                  // previous：变化点之后的所有旧槽位（注册按 setup 顺序排列，只有未变化前缀能存活）
                  const previous = new Map(Array.from(active.entries()).slice(prefix))
                  // 从后往前关闭旧槽位（保持与创建相反的顺序）
                  yield* Effect.forEach(
                    // 反转顺序
                    Array.from(previous.entries()).toReversed(),
                    // 关闭单个槽位
                    ([id, slot]) =>
                      Effect.gen(function* () {
                        // 从活跃表移除
                        active.delete(id)
                        // 激活存在且未失败时关闭其作用域（触发清理）
                        if (slot.activation && !slot.activation.failure)
                          // 正常关闭
                          yield* Scope.close(slot.activation.scope, Exit.void)
                      }),
                    // 丢弃结果
                    { discard: true },
                  )
                  // 逐个加载变化点之后的新定义
                  for (const definition of definitions.slice(prefix)) {
                    // 尝试复用旧槽位（可能含旧激活）
                    const slot = previous.get(definition.id)
                    // Reordering healthy registrations does not authorize retrying a failed revision.
                    // 旧激活已失败且修订号未变：不重试，仅更新插件代（重排健康注册不等于允许重试失败修订）
                    if (slot?.activation?.failure && slot.plugin.revision === definition.revision) {
                      // 保留失败激活
                      active.set(definition.id, { ...slot, plugin: definition })
                      // 处理下一个
                      continue
                    }
                    // 加载新定义
                    const result = yield* load(definition)
                    // 加载成功：登记新激活
                    if (result.activation !== undefined) {
                      // 写入槽位
                      active.set(definition.id, {
                        // 插件代
                        plugin: definition,
                        // 激活记录
                        activation: result.activation,
                      })
                      // 处理下一个
                      continue
                    }
                    // 加载失败：登记错误
                    active.set(definition.id, { plugin: definition, error: result.error })

                    // 尝试回退：恢复旧的失败前激活（若它健康）
                    const fallback = slot?.activation
                    // 无回退或回退也失败则跳过
                    if (!fallback || fallback.failure) continue
                    // 重新加载旧插件代
                    const restored = yield* load(fallback.plugin)
                    // 恢复成功：登记恢复的激活（保留错误信息）
                    if (restored.activation !== undefined) {
                      // 写入槽位
                      active.set(definition.id, {
                        // 新插件代
                        plugin: definition,
                        // 旧激活
                        activation: restored.activation,
                        // 保留加载错误
                        error: result.error,
                      })
                      // 处理下一个
                      continue
                    }
                    // 回退也失败：记录错误并停用该插件
                    yield* Effect.logError("failed to restore plugin; deactivating", {
                      // 插件 ID
                      "plugin.id": definition.id,
                    })
                  }

                  // 重建 inventory 快照
                  inventory = snapshot()
                }),
              )
              // 发布更新事件
              yield* publish(inventory)
            }),
          ),
        // 释放：释放持有令牌
        (release) => release,
      )
    })

    // 后台 worker：逐个处理插件失败队列（禁用失败插件、刷新状态、清理作用域）
    yield* Queue.take(pendingFailures).pipe(
      // 对每个失败项执行处理
      Effect.flatMap((item) =>
        Effect.gen(function* () {
          // 记录警告日志
          yield* Effect.logWarning("disabled plugin after transform failure", {
            // 插件 ID
            "plugin.id": item.plugin.id,
            // 失败的状态名
            state: item.failure.state,
            // 失败引用 ID
            ref: item.ref,
            // 以缺陷形式记录原因
            cause: Cause.die(item.failure.cause),
          })
          // 在信号量保护下更新状态
          yield* lock.withPermit(
            Effect.gen(function* () {
              // 服务已关闭则跳过
              if (closed) return
              // Failure is already recorded on its exact activation, so an old queued item
              // cannot disable a replacement and teardown need not wait for this worker.
              // 失败已记录在确切的激活上，旧的队列项不会禁用替代品；teardown 无需等待本 worker。
              inventory = snapshot()
              // 执行状态刷新并捕获退出
              const refreshed = yield* State.batch(item.refresh).pipe(Effect.exit)
              // 发布更新事件
              yield* publish(inventory)
              // 刷新失败时记录警告
              if (Exit.isFailure(refreshed))
                yield* Effect.logWarning("failed to refresh state after disabling plugin", {
                  // 插件 ID
                  "plugin.id": item.plugin.id,
                  // 失败引用 ID
                  ref: item.ref,
                  // 失败原因
                  cause: refreshed.cause,
                })
            }),
          )
          // 处理结束
        }).pipe(
          // Cleanup must also be scheduled if an inventory observer fails. User finalizers
          // may await readiness, so never join them under the activation lock or readiness hold.
          // 清理保证：即使清单观察者失败也必须调度。用户终止器可能等待就绪，
          // 因此绝不能在激活锁或就绪持有内 join 它们。
          Effect.ensuring(
            // 关闭插件作用域（后台 fork 执行，不阻塞）
            Scope.close(item.scope, Exit.void).pipe(
              // 关闭失败仅记录警告
              Effect.catchCause((cause) =>
                Effect.logWarning("failed to clean up disabled plugin", {
                  // 插件 ID
                  "plugin.id": item.plugin.id,
                  // 失败引用 ID
                  ref: item.ref,
                  // 失败原因
                  cause,
                }),
              ),
              // 立即启动后台协程
              Effect.forkScoped({ startImmediately: true }),
            ),
          ),
          // 处理本体失败（非中断类）时记录错误
          Effect.catchCauseIf(
            // 中断不算失败
            (cause) => !Cause.hasInterrupts(cause),
            // 记录错误日志
            (cause) =>
              Effect.logError("failed to report disabled plugin", {
                // 插件 ID
                "plugin.id": item.plugin.id,
                // 失败引用 ID
                ref: item.ref,
                // 失败原因
                cause,
              }),
          ),
          // 最终释放持有令牌
          Effect.ensuring(item.release),
        ),
      ),
      // 永久循环消费队列
      Effect.forever,
      // 后台 fork 启动
      Effect.forkScoped,
    )

    // close：关闭服务——标记关闭、清空挂起、打开就绪闩、清空激活并停止状态
    const close = (exit: Exit.Exit<unknown, unknown>) =>
      // 在信号量保护下执行
      lock.withPermit(
        Effect.gen(function* () {
          // 标记已关闭
          closed = true
          // 丢弃所有挂起持有
          pending.clear()
          // 强制打开就绪闩（等待者不再阻塞）
          ready.openUnsafe()
          // 清空活跃槽位
          active.clear()
          // 关闭根作用域并停止状态容器
          yield* State.shutdown(Scope.close(scope, exit))
        }),
      )
    // 注册终止器：服务关闭时以正常退出关闭
    yield* Effect.addFinalizer(close)

    // 返回服务实现
    return Service.of({
      // activate：激活插件集合
      activate,
      // close：关闭服务
      close,
      // awaitActivation：等待当前激活完成（就绪闩）
      awaitActivation: ready.await,
      // hold：挂起一个持有令牌（让等待激活的观察者阻塞）
      hold,
      // list：返回插件信息清单
      list,
      // gui：返回插件 GUI bundle
      gui,
    })
  }),
)

// `plugin` is the requested definition; `activation` is its last activation, which may have
// failed or be an older fallback while the requested revision keeps failing setup.
// Slot：一个请求定义的槽位——plugin 是请求的定义；activation 是其最近一次激活，
// 可能已失败或是旧的回退（当请求修订持续 setup 失败时）。
type Slot = {
  // 请求的插件定义（ID 已规范化）
  readonly plugin: Generation & { readonly id: Plugin.ID }
  // 最近一次激活（可选）
  readonly activation?: Activation
  // 加载错误（可选）
  readonly error?: string
}

// Share the activation across slot snapshots so teardown sees failures synchronously,
// including failures discovered after activate() has captured its previous slots.
// Activation：跨槽位快照共享的激活记录，让 teardown 能同步看到失败，
// 包括 activate() 已捕获旧槽位之后才发现的失败。
type Activation = {
  // 激活对应的插件代
  readonly plugin: Generation
  // 激活的子作用域（可关闭）
  readonly scope: Scope.Closeable
  // 失败信息（错误说明 + 引用 ID），成功时缺失
  failure?: { readonly error: string; readonly ref: string }
}

// PendingFailure：失败队列中的条目（禁用插件所需的全部信息）
type PendingFailure = {
  // 失败的插件代
  readonly plugin: Generation
  // 该插件的作用域
  readonly scope: Scope.Closeable
  // 失败详情
  readonly failure: State.Failure
  // 状态刷新效果
  readonly refresh: Effect.Effect<void>
  // 失败引用 ID
  readonly ref: string
  // 释放持有令牌的效果
  readonly release: Effect.Effect<void>
}

// slotInfo：把槽位转成对外的 Plugin.Info（状态、来源、功能）
function slotInfo(slot: Slot): Plugin.Info {
  // 失败信息：优先激活上的失败，其次槽位的加载错误
  const failure = slot.activation?.failure ?? (slot.error === undefined ? undefined : { error: slot.error })
  // 返回插件信息
  return {
    // 插件 ID
    id: slot.plugin.id,
    // 来源：缺失时视为内置
    source: slot.plugin.source ?? { type: "builtin" },
    // 状态：无失败为 active，否则 failed 附错误
    state: failure === undefined ? { status: "active" } : { status: "failed", ...failure },
    // Built-in and SDK plugins are server parts; a package lists its own parts.
    // 内置与 SDK 插件是服务器部件；包插件自行声明部件
    features: slot.plugin.features ?? { server: true },
  }
}

// 导出 node：把 Plugin 服务挂到位置节点，依赖 PluginHost 的要求
export const node: LayerNode.Provider<Service, PersistentPty.UnavailableError, typeof Node.tags.values.location> =
  // 构造位置节点
  Node.makeLocationNode({
    // 服务类型
    service: Service,
    // 服务层
    layer,
    // 依赖：插件宿主要求
    deps: [PluginHost.requirements],
  })
