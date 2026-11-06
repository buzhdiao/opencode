/**
 * Local tracking checkouts for remote Git references, one per remote and
 * branch. Each checkout permanently tracks a single ref: the requested branch
 * when the cache key has one, otherwise the remote default branch. Content
 * follows "newest wins": refresh fetches and hard-resets, so readers may
 * observe the checkout move underneath them.
 */
// 模块说明：为远程 Git 引用维护本地跟踪检出（checkout），每个远程+分支各一个。
// 每个检出永久跟踪单一 ref：缓存键带分支时跟踪该分支，否则跟踪远程默认分支。
// 内容遵循“最新者胜”：刷新会拉取并硬重置，读者可能观察到检出在脚下移动。
import path from "path"
// 从 effect 导入时钟、上下文、时长、Effect、Layer、Option、Schema 等工具
import { Clock, Context, Duration, Effect, Layer, Option, Schema } from "effect"
// 导入文件系统工具服务
import { FSUtil } from "@opencode/util/fs-util"
// 导入 Git 服务
import { Git } from "./git.js"
// 导入全局服务
import { Global } from "@opencode/util/global"
// 导入仓库引用解析工具
import { Repository } from "./repository.js"
// 导入绝对路径 schema
import { AbsolutePath } from "./schema.js"
// 导入构建全局分层节点的辅助函数
import { makeGlobalNode } from "@opencode/util/effect/app-node"
// 导入文件锁（flock）服务
import { EffectFlock } from "@opencode/util/effect-flock"
// 导入键值存储（KV）服务
import { KV } from "./kv.js"

// 刷新记录的 schema：仅保存上次尝试刷新的时间戳
const Refresh = Schema.Struct({
  attemptedAt: Schema.Number,
})
// 刷新间隔：1 天（毫秒），用于“每日”节流
const refreshInterval = Duration.toMillis(Duration.days(1))

// ensure 操作的结果类型
export type Result = {
  // 仓库标识（label）
  readonly repository: string
  // 主机名
  readonly host: string
  // 远程 URL
  readonly remote: string
  // 本地检出路径
  readonly localPath: string
  // 本次结果状态：命中缓存 / 新克隆 / 已刷新
  readonly status: "cached" | "cloned" | "refreshed"
  // 当前 HEAD 提交哈希（可选）
  readonly head?: string
  // 当前所在分支（可选）
  readonly branch?: string
}

// ensure 操作的输入类型
export type EnsureInput = {
  // 远程仓库引用
  readonly reference: Repository.RemoteReference
  /** `daily` throttles existing checkouts; `true` forces a refresh. */
  // `daily` 对已有检出按每日节流；`true` 强制刷新
  readonly refresh?: boolean | "daily"
  // 指定分支（可选）
  readonly branch?: string
}

// 分支名非法错误
export class InvalidBranchError extends Schema.TaggedError<InvalidBranchError>()("RepositoryCacheInvalidBranchError", {
  branch: Schema.String,
  message: Schema.String,
}) {}

// 克隆失败错误
export class CloneFailedError extends Schema.TaggedError<CloneFailedError>()("RepositoryCacheCloneFailedError", {
  repository: Schema.String,
  message: Schema.String,
}) {}

// 拉取（fetch）失败错误
export class FetchFailedError extends Schema.TaggedError<FetchFailedError>()("RepositoryCacheFetchFailedError", {
  repository: Schema.String,
  message: Schema.String,
}) {}

// 检出（checkout）失败错误
export class CheckoutFailedError extends Schema.TaggedError<CheckoutFailedError>()(
  "RepositoryCacheCheckoutFailedError",
  {
    repository: Schema.String,
    branch: Schema.String,
    message: Schema.String,
  },
) {}

// 硬重置（reset --hard）失败错误
export class ResetFailedError extends Schema.TaggedError<ResetFailedError>()("RepositoryCacheResetFailedError", {
  repository: Schema.String,
  message: Schema.String,
}) {}

// 获取文件锁失败错误
export class LockFailedError extends Schema.TaggedError<LockFailedError>()("RepositoryCacheLockFailedError", {
  localPath: Schema.String,
  message: Schema.String,
}) {}

// 其他缓存操作（目录创建、清理等）失败错误
export class CacheOperationError extends Schema.TaggedError<CacheOperationError>()("RepositoryCacheOperationError", {
  operation: Schema.String,
  path: Schema.String,
  message: Schema.String,
}) {}

// 本服务全部可能错误的联合类型
export type Error =
  | InvalidBranchError
  | CloneFailedError
  | FetchFailedError
  | CheckoutFailedError
  | ResetFailedError
  | LockFailedError
  | CacheOperationError

// 服务接口：仅需实现 ensure（确保缓存检出存在且最新）
export interface Interface {
  readonly ensure: (input: EnsureInput) => Effect.Effect<Result, Error>
}

// 定义 RepositoryCache 服务
export class Service extends Context.Service<Service, Interface>()("@opencode/RepositoryCache") {}

// 运行时错误守卫：判断未知值是否为本服务的错误类型
export const isError: (error: unknown) => error is Error = Schema.is(
  Schema.Union([
    InvalidBranchError,
    CloneFailedError,
    FetchFailedError,
    CheckoutFailedError,
    ResetFailedError,
    LockFailedError,
    CacheOperationError,
  ]),
)

// 校验分支名：将 Repository.validateBranch 的同步异常转为 InvalidBranchError
export const validateBranch = Effect.fn("RepositoryCache.validateBranch")(function* (branch: string) {
  return yield* Effect.try({
    // 尝试执行同步校验
    try: () => Repository.validateBranch(branch),
    // 校验抛错时包装为非法分支错误
    catch: (error) => new InvalidBranchError({ branch, message: errorMessage(error) }),
  })
})

// 服务实现层
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 依赖：文件系统工具
    const fs = yield* FSUtil.Service
    // 依赖：Git 服务
    const git = yield* Git.Service
    // 依赖：文件锁服务
    const flock = yield* EffectFlock.Service
    // 依赖：全局服务
    const global = yield* Global.Service
    // 依赖：键值存储
    const kv = yield* KV.Service

    return Service.of({
      // 核心 API：确保指定远程仓库（可选分支）的本地缓存检出存在且最新
      ensure: Effect.fn("RepositoryCache.ensure")(function* (input) {
        // 指定了分支则先校验其合法性
        if (input.branch) yield* validateBranch(input.branch)

        // 仓库标识（引用 label）
        const repository = input.reference.label
        // 计算本地缓存路径（按远程与分支键控）
        const localPath = Repository.cachePath(global.repos, input.reference, input.branch)
        // KV 记录键：按路径记录上次刷新尝试时间
        const key = `repository-cache:${localPath}`
        // 解析克隆目标引用，解析不出则退回原引用
        const cloneTarget = Repository.parse(input.reference.remote) ?? input.reference

        // 以缓存路径为键加进程间文件锁，避免并发操作同一检出
        return yield* flock
          .withLock(
            Effect.gen(function* () {
              // 确保缓存目录存在
              yield* cacheOperation(fs.ensureDir(path.dirname(localPath)), "ensure cache directory", localPath)

              // 发现 localPath 处（或其上层）是否已有 Git 仓库
              const existing = yield* git.repo.discover(AbsolutePath.make(localPath))
              // 若发现仓库，读取其 origin 远程 URL（失败则视为无）
              const origin = existing
                ? yield* git.remote.get(existing).pipe(Effect.orElseSucceed(() => undefined))
                : undefined
              // 解析 origin 远程 URL 为仓库引用
              const originReference = origin ? Repository.parse(origin) : undefined
              // Discovery walks upward, so an enclosing repository with a
              // matching origin could masquerade as the cache entry; reuse
              // requires the checkout to live exactly at the cache path.
              // 解析发现到的仓库实际工作树（worktree）路径
              const worktree = existing ? yield* fs.resolve(localPath) : undefined
              // 判定是否可复用现有检出：工作树恰好在缓存路径、origin 匹配克隆目标
              const reuse = Boolean(
                existing &&
                  existing.worktree === worktree &&
                  originReference &&
                  Repository.same(originReference, cloneTarget),
              )
              // 不可复用但路径上存在旧内容时，先清除过期缓存
              if (!reuse && (yield* fs.existsSafe(localPath))) {
                yield* cacheOperation(fs.remove(localPath, { recursive: true }), "remove stale cache", localPath)
              }

              // 读取当前时间戳
              const now = yield* Clock.currentTimeMillis
              // 读取上次刷新尝试记录（不存在则为 undefined）
              const previous = Option.getOrUndefined(Schema.decodeUnknownOption(Refresh)(yield* kv.get(key)))
              // 计算 refresh 决策：“daily”按上次尝试时间节流，否则直接用输入值
              const refresh =
                input.refresh === "daily" ? !previous || now - previous.attemptedAt >= refreshInterval : input.refresh
              // 推导结果状态：不可复用=克隆；可复用且需刷新=刷新；否则=命中缓存
              const status = !reuse ? ("cloned" as const) : refresh ? ("refreshed" as const) : ("cached" as const)

              // 需要克隆或刷新时才执行网络操作
              if (status !== "cached") {
                // Record attempts before network work so failures obey the same refresh interval.
                // 在网络操作前先记录尝试时间，使失败也遵循同一刷新间隔
                yield* kv.set(key, { attemptedAt: now })

                // 状态为克隆：全新克隆仓库到缓存路径
                if (status === "cloned") {
                  yield* git.repo
                    .clone({
                      remote: input.reference.remote,
                      directory: AbsolutePath.make(localPath),
                      branch: input.branch,
                    })
                    // 克隆失败时包装为 CloneFailedError
                    .pipe(Effect.mapError((error) => new CloneFailedError({ repository, message: error.message })))
                }

                // 状态为刷新：拉取远端并硬重置检出
                if (status === "refreshed") {
                  // 没有已存在的仓库则无法刷新
                  if (!existing)
                    return yield* new FetchFailedError({ repository, message: "Repository is unavailable" })
                  // 拉取所有远程更新
                  yield* git.sync
                    .fetchRemotes(existing)
                    .pipe(Effect.mapError((error) => new FetchFailedError({ repository, message: error.message })))

                  // 指定了分支时额外拉取该分支
                  if (input.branch) {
                    yield* git.sync
                      .fetchBranch(existing, { branch: input.branch })
                      .pipe(Effect.mapError((error) => new FetchFailedError({ repository, message: error.message })))
                  }

                  // Checking out the tracked ref before resetting keeps the
                  // checkout self-healing even if it was left on another
                  // branch.
                  // 确定要跟踪的分支：优先输入分支，否则取远程默认分支
                  const branch = input.branch ?? (yield* git.history.defaultRemoteBranch(existing))
                  // 有分支则先检出对应的远程跟踪分支（自愈可能残留的其他分支状态）
                  if (branch) {
                    yield* git.sync
                      .checkoutRemoteBranch(existing, { branch })
                      .pipe(
                        Effect.mapError(
                          (error) => new CheckoutFailedError({ repository, branch, message: error.message }),
                        ),
                      )
                  }

                  // 计算硬重置目标分支：无显式分支时取当前分支
                  const target = branch ?? (yield* git.history.branch(existing))
                  // 硬重置到 origin/<分支>（无分支时保持 HEAD）
                  yield* git.sync
                    .resetHard(existing, target ? `origin/${target}` : "HEAD")
                    .pipe(Effect.mapError((error) => new ResetFailedError({ repository, message: error.message })))
                }
              }

              // 最终再发现一次仓库，用于读取 HEAD 与分支信息
              const checkout = yield* git.repo.discover(AbsolutePath.make(localPath))

              // 返回操作结果
              return {
                repository,
                host: input.reference.host,
                remote: input.reference.remote,
                localPath,
                status,
                // 有检出时读取当前 HEAD 哈希
                head: checkout ? yield* git.history.head(checkout) : undefined,
                // 有检出时读取当前分支
                branch: checkout ? yield* git.history.branch(checkout) : undefined,
              } satisfies Result
            }),
            key,
          )
          .pipe(
            // 锁获取失败或未分类错误统一包装为 LockFailedError
            Effect.mapError((error) =>
              isError(error) ? error : new LockFailedError({ localPath, message: errorMessage(error) }),
            ),
          )
      }),
    })
  }),
)

// 构建 RepositoryCache 的全局分层节点，声明其依赖的节点
export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [EffectFlock.node, FSUtil.node, Git.node, Global.node, KV.node],
})

// 从未知错误中提取消息文本
function errorMessage(error: unknown) {
  return error instanceof globalThis.Error ? error.message : String(error)
}

// 将普通文件系统操作的错误包装为 CacheOperationError
function cacheOperation<A, E, R>(effect: Effect.Effect<A, E, R>, operation: string, target: string) {
  return effect.pipe(
    Effect.mapError((error) => new CacheOperationError({ operation, path: target, message: errorMessage(error) })),
  )
}

// 将本模块以命名空间形式自导出为 RepositoryCache
export * as RepositoryCache from "./repository-cache.js"
