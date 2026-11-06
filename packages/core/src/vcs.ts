// 以命名空间形式导出 Vcs 模块
export * as Vcs from "./vcs.js"

// 引入 Node path，用于路径拼接与判定
import path from "path"
// 引入 Effect 原语：Cause、Context、Effect、FiberSet（纤程集合）、Layer（层）、Schema、Semaphore（信号量）、Stream（流）
import { Cause, Context, Effect, FiberSet, Layer, Schema, Semaphore, Stream } from "effect"
// 引入插件侧 VCS 定义与编辑器类型
import type { VcsDefinition, VcsEditor } from "@opencode/plugin/effect/vcs"
// 引入文件差异 schema
import { FileDiff } from "@opencode/schema/file-diff"
// 引入文件系统事件 schema
import { FileSystem } from "@opencode/schema/filesystem"
// 引入 VCS 相关 schema（Base、BranchList、FileStatus、Info、Mode、Untracked）
import { Base, BranchList, FileStatus, Info, Mode, Untracked } from "@opencode/schema/vcs"
// 引入 VCS 事件
import { VcsEvent } from "@opencode/schema/vcs-event"
// 引入位置级节点构造工具
import { makeLocationNode } from "@opencode/util/effect/app-node"
// 引入文件系统工具服务
import { FSUtil } from "@opencode/util/fs-util"
// 引入内部模块：位置服务
import { Location } from "./location.js"
// 引入项目服务（判断项目根）
import { Project } from "./project.js"
// 引入事件总线
import { Bus } from "./bus.js"
// 引入状态框架
import { State } from "./state.js"
// 引入补丁常量与空补丁工具
import { emptyPatch, MAX_TOTAL_PATCH_BYTES, PATCH_CONTEXT_LINES } from "./vcs/patch.js"

// 重新导出 VCS 类型
export { Base, BranchList, FileStatus, Info, Mode, Untracked }

// 差异生成失败错误
export class DiffError extends Schema.TaggedError<DiffError>()("Vcs.DiffError", {
  message: Schema.String,
}) {}

// 初始化失败错误：kind 描述失败类别（缺失/冲突/未知/不支持/失败）
export class InitializeError extends Schema.TaggedError<InitializeError>()("Vcs.InitializeError", {
  kind: Schema.Literals(["missing", "conflict", "unknown", "unsupported", "failed"]),
}) {}

// 差异选项：上下文行数、基准引用、未跟踪处理
export interface DiffOptions {
  readonly context?: number
  readonly base?: string
  readonly untracked?: Untracked
}

// 分支列表选项：搜索关键字与数量上限
export interface BranchOptions {
  readonly search?: string
  readonly limit?: number
}

// 提供方适配器接口：由具体 VCS（如 Git 插件）实现
export interface Adapter {
  // 基本信息（当前分支等）
  readonly info: () => Effect.Effect<Info>
  // 审查基准（可选实现）
  readonly base?: () => Effect.Effect<Base | null, DiffError>
  // 分支列表
  readonly branches: (options?: BranchOptions) => Effect.Effect<BranchList>
  // 文件状态
  readonly status: () => Effect.Effect<FileStatus[]>
  // 差异
  readonly diff: (mode: Mode, options?: DiffOptions) => Effect.Effect<FileDiff.Info[], DiffError>
}

// 服务接口：适配器 + 状态变换 + 初始化
export interface Interface extends Adapter, State.Transformable<VcsEditor> {
  // 必选的基准方法
  readonly base: () => Effect.Effect<Base | null, DiffError>
  // 在项目目录初始化指定提供方
  readonly initialize: (providerID: string) => Effect.Effect<void, InitializeError>
}

// 领域状态：已注册提供方与当前选择
interface Data {
  readonly providers: Map<string, VcsDefinition>
  selection?: string
}

// 定义 Vcs 服务标记类
export class Service extends Context.Service<Service, Interface>()("@opencode/Vcs") {}

// 构建服务层
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 获取文件系统工具服务
    const fs = yield* FSUtil.Service
    // 获取位置服务
    const location = yield* Location.Service
    // 获取事件总线
    const bus = yield* Bus.Service
    // 取层生命周期作用域
    const root = yield* Effect.scope
    // 创建后台纤程运行器（随层结束）
    const fork = yield* FiberSet.makeRuntime<never, void, never>()
    // 位置检测到的 VCS 类型（可能无）
    const vcs = location.vcs
    // 当前信息缓存（初始只有空分支表）
    const current: { info: Info } = { info: { branch: {} } }
    // 刷新互斥信号量（同一时刻只允许一个刷新）
    const refreshLock = Semaphore.makeUnsafe(1)
    // 传给提供方的作用域描述：目录、worktree、规范路径与存储位置
    const scope = {
      directory: location.directory,
      worktree: location.project.directory,
      canonical: location.project.canonical,
      ...(vcs ? { store: vcs.store } : {}),
    }
    // Info 的 schema 解码器
    const decodeInfo = Schema.decodeUnknownEffect(Schema.toType(Info))
    // Base 的解码器（可为 null）
    const decodeBase = Schema.decodeUnknownEffect(Schema.NullOr(Base))
    // BranchList 的解码器
    const decodeBranches = Schema.decodeUnknownEffect(BranchList)
    // FileStatus 数组的解码器
    const decodeStatus = Schema.decodeUnknownEffect(Schema.Array(FileStatus))
    // FileDiff.Info 数组的解码器
    const decodeDiff = Schema.decodeUnknownEffect(Schema.Array(FileDiff.Info))
    // 提供方注册状态
    const state: State.Interface<Data, VcsEditor> = State.create<Data, VcsEditor>({
      name: "vcs",
      // 初始为空提供方表
      initial: () => ({ providers: new Map() }),
      editor: (editor) => ({
        // 注册提供方
        add: (provider) => editor.providers.set(provider.id, provider),
        // 默认选择的读写
        default: {
          get: () => editor.selection,
          set: (selection) => (editor.selection = selection),
        },
      }),
      // 状态变化时对账刷新（随层中断，中断不算失败）
      notify: () => State.reconcile(root, fork, () => refresh()),
    })
    // 取当前应使用的提供方：显式选择优先，否则用位置检测的 VCS 类型
    const selected = () => {
      // 读取状态
      const value = state.get()
      // 解析提供方 ID
      const id = value.selection ?? vcs?.type
      // 按 ID 查表
      return id ? value.providers.get(id) : undefined
    }
    // （中文）容错执行一般操作：中断原样上抛；失败记警告并回退到兜底值
    const protect = <A>(provider: VcsDefinition, operation: string, effect: Effect.Effect<A, unknown>, fallback: A) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(cause).pipe(Effect.orDie)
            : Effect.logWarning("vcs provider failed", { provider: provider.id, operation, cause }).pipe(
                Effect.as(fallback),
              ),
        ),
      )
    // （中文）容错执行审查类操作（base/diff）：中断上抛；失败转为 DiffError
    const review = <A>(provider: VcsDefinition, operation: "base" | "diff", effect: Effect.Effect<A, unknown>) =>
      effect.pipe(
        Effect.catchCause((cause) => {
          // 中断不属于失败，原样传播
          if (Cause.hasInterrupts(cause)) return Effect.failCause(cause).pipe(Effect.orDie)
          // 展开根因
          const error = Cause.squash(cause)
          // 先记警告，再失败
          return Effect.logWarning("vcs provider failed", { provider: provider.id, operation, cause }).pipe(
            Effect.andThen(
              // 已是 DiffError 则透传，否则按操作类型包装消息
              Effect.fail(
                error instanceof DiffError
                  ? error
                  : new DiffError({
                      message:
                        operation === "base"
                          ? "VCS provider could not resolve a review base"
                          : "VCS provider could not produce a diff",
                    }),
              ),
            ),
          )
        }),
      )
    // （中文）刷新当前信息：加锁执行，比较分支是否变化
    const refresh = Effect.fn("Vcs.refresh")(function* () {
      const changed = yield* Effect.gen(function* () {
        // 当前提供方
        const provider = selected()
        // 请求信息；失败回退为空分支表
        const next: Info = provider
          ? {
              ...(yield* protect(provider, "info", provider.info(scope).pipe(Effect.flatMap(decodeInfo)), {
                branch: {},
              })),
              provider: provider.id,
            }
          : { branch: {} }
        // 比较当前分支是否变化
        const changed = current.info.branch.current !== next.branch.current
        // 更新缓存
        current.info = next
        // 返回是否变化
        return changed
      }).pipe(Semaphore.withPermit(refreshLock))
      // 未变化则无需广播
      if (!changed) return
      // Legacy listeners can publish nested updates before streams and SSE receive
      // this event. Re-announce the latest branch if publication was overtaken.
      // （中文）旧监听器可能在流与 SSE 收到该事件前又发布嵌套更新。若发布被超越，则重新广播最新分支
      while (true) {
        // 读取当前分支并发布
        const branch = current.info.branch.current
        yield* bus.publish(VcsEvent.BranchUpdated, { branch })
        // 发布期间分支未再变化则结束
        if (branch === current.info.branch.current) return
      }
    })

    // 仅当位置托管在 VCS 之上时，监听分支元数据文件变化以刷新
    if (vcs) {
      // 规范化存储目录的真实路径（失败则用原值）
      const store = yield* fs.realPath(vcs.store).pipe(Effect.orElseSucceed(() => vcs.store))
      // 分支元数据文件判定：Git 看 HEAD；其他 VCS 看 store/branch
      const isBranchMetadata =
        vcs.type === "git"
          ? (file: string) => path.basename(file) === "HEAD" && FSUtil.contains(store, file)
          : (file: string) => path.resolve(file) === path.join(store, "branch")
      // 订阅文件系统变更事件
      yield* bus.subscribe(FileSystem.Event.Changed).pipe(
        // 只保留分支元数据相关的事件
        Stream.filter((event) => isBranchMetadata(event.data.file)),
        // 每个事件触发一次刷新（失败记警告）
        Stream.runForEach((event) =>
          refresh().pipe(
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterrupts(cause),
              (cause) => Effect.logWarning("vcs refresh failed", { file: event.data.file, cause }),
            ),
            Effect.withSpan("Vcs.refreshBranch", { attributes: { file: event.data.file } }),
          ),
        ),
        // 立即启动并随作用域终止
        Effect.forkScoped({ startImmediately: true }),
      )
    }

    // 组装服务实现
    return Service.of({
      transform: state.transform,
      reload: state.reload,
      // （中文）在项目目录初始化指定 VCS
      initialize: Effect.fn("Vcs.initialize")(function* (providerID: string) {
        // 项目目录不存在：missing
        if (!(yield* fs.isDir(location.project.directory))) return yield* new InitializeError({ kind: "missing" })
        // 已是某项目根：conflict
        if (yield* Project.root(fs, location.project.directory)) return yield* new InitializeError({ kind: "conflict" })
        // 提供方未注册：unknown
        const provider = state.get().providers.get(providerID)
        if (!provider) return yield* new InitializeError({ kind: "unknown" })
        // 提供方不支持初始化：unsupported
        if (!provider.init) return yield* new InitializeError({ kind: "unsupported" })
        // 执行初始化；中断上抛，失败记警告并报 failed
        yield* provider
          .init(scope)
          .pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause)
                ? Effect.failCause(cause).pipe(Effect.orDie)
                : Effect.logWarning("vcs initialization failed", { provider: providerID, cause }).pipe(
                    Effect.andThen(Effect.fail(new InitializeError({ kind: "failed" }))),
                  ),
            ),
          )
      }),
      // 读取当前缓存信息
      info: Effect.fn("Vcs.info")(function* () {
        return current.info
      }),
      // （中文）请求审查基准
      base: Effect.fn("Vcs.base")(function* () {
        // 当前提供方
        const provider = selected()
        // 无提供方或不支持基准时返回 null
        if (!provider?.base) return null
        // 经审查容错执行并解码
        return yield* review(provider, "base", provider.base(scope).pipe(Effect.flatMap(decodeBase)))
      }),
      // （中文）列出分支
      branches: Effect.fn("Vcs.branches")(function* (options?: BranchOptions) {
        // 当前提供方
        const provider = selected()
        if (provider)
          return yield* protect(
            provider,
            "branches",
            provider.branches({ ...scope, ...options }).pipe(Effect.flatMap(decodeBranches)),
            [],
          )
        // 无提供方返回空
        return []
      }),
      // （中文）列出文件状态
      status: Effect.fn("Vcs.status")(function* () {
        // 当前提供方
        const provider = selected()
        if (provider)
          return yield* protect(
            provider,
            "status",
            provider.status(scope).pipe(
              Effect.flatMap(decodeStatus),
              Effect.map((rows) => Array.from(rows)),
            ),
            [],
          )
        // 无提供方返回空
        return []
      }),
      // （中文）生成差异并做总量裁剪
      diff: Effect.fn("Vcs.diff")(function* (mode: Mode, options?: DiffOptions) {
        // 当前提供方
        const provider = selected()
        // 无提供方返回空
        if (!provider) return []
        // 经审查容错执行差异；附带默认上下文行数与输出字节上限
        const rows = yield* review(
          provider,
          "diff",
          provider
            .diff({
              ...scope,
              mode,
              ...(options?.base !== undefined ? { base: options.base } : {}),
              ...(options?.untracked !== undefined ? { untracked: options.untracked } : {}),
              context: options?.context ?? PATCH_CONTEXT_LINES,
              maxOutputBytes: MAX_TOTAL_PATCH_BYTES,
            })
            .pipe(Effect.flatMap(decodeDiff)),
        )
        // 累计补丁字节数
        let total = 0
        // 超出总字节上限的补丁替换为空补丁
        return rows.map((row) => {
          // 当前补丁字节数
          const bytes = Buffer.byteLength(row.patch)
          // 加上会超限则用空补丁占位
          if (total + bytes > MAX_TOTAL_PATCH_BYTES) return { ...row, patch: emptyPatch(row.file) }
          // 计入累计
          total += bytes
          // 保留原补丁
          return row
        })
      }),
    })
  }),
)

// 导出位置级服务节点
export const node = makeLocationNode({
  service: Service,
  layer: layer,
  deps: [FSUtil.node, Location.node, Bus.node],
})
