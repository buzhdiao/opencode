// 以命名空间形式导出 Snapshot 模块
export * as Snapshot from "./snapshot.js"

// 引入位置级服务节点构造工具
import { makeLocationNode } from "@opencode/util/effect/app-node"
// 引入 Node path，用于路径拼接与相对化
import path from "path"
// 引入 Effect 原语：Clock（时钟）、Context、Effect、Fiber（纤程）、Layer（层）、Schema、Scope（作用域）
import { Clock, Context, Effect, Fiber, Layer, Schema, Scope } from "effect"
// 引入文件差异 schema
import { FileDiff } from "@opencode/schema/file-diff"
// 引入文件系统工具服务
import { FSUtil } from "@opencode/util/fs-util"
// 引入内部 Git 服务
import { Git } from "./git.js"
// 引入全局数据目录服务
import { Global } from "@opencode/util/global"
// 引入位置服务
import { Location } from "./location.js"
// 引入绝对/相对路径 schema
import { AbsolutePath, RelativePath } from "./schema.js"
// 引入快照 ID schema
import { ID } from "@opencode/schema/snapshot"
// 引入哈希工具（为 worktree 生成稳定短哈希）
import { Hash } from "@opencode/util/hash"
// 引入状态框架
import { State } from "./state.js"

// 重新导出快照 ID
export { ID }

// 定义快照操作的标签错误（操作类别：捕获/列文件/差异/恢复）
export class Error extends Schema.TaggedError<Error>()("Snapshot.Error", {
  // 出错的操作名称
  operation: Schema.Literals(["capture", "files", "diff", "restore"]),
  // 错误消息
  message: Schema.String,
  // 可选的根因（缺陷）
  cause: Schema.optional(Schema.Defect()),
}) {}

// 比较输入：两棵快照树的 ID
export interface CompareInput {
  readonly from: ID
  readonly to: ID
}

// 差异输入：在比较基础上可指定上下文行数与路径过滤
export interface DiffInput extends CompareInput {
  readonly context?: number
  readonly paths?: readonly RelativePath[]
}

// 恢复输入：项目相对路径 -> 对应快照树 ID
export interface RestoreInput {
  /** Paths are relative to the project root. */
  // （中文）路径相对于项目根目录
  readonly files: ReadonlyMap<RelativePath, ID>
}

// 状态编辑器：开关快照功能
export type Editor = {
  configure: (enabled: boolean) => void
}

// 服务接口（含状态变换能力）
export interface Interface extends State.Transformable<Editor> {
  /**
   * Capture the current Location-scoped filesystem state as a content-addressed
   * tree. Returns `undefined` when snapshots are disabled, unsupported, or the
   * best-effort capture fails.
   */
  // （中文）把当前 Location 范围的文件系统状态捕获为内容寻址（content-addressed）树。
  // 快照被禁用、环境不支持或尽力而为的捕获失败时返回 `undefined`
  readonly capture: () => Effect.Effect<ID | undefined>

  /**
   * List project-relative paths changed between two captured trees without
   * loading file contents or generating patches.
   */
  // （中文）列出两棵快照树之间变化的项目相对路径；不加载文件内容、不生成补丁
  readonly files: (input: CompareInput) => Effect.Effect<readonly RelativePath[], Error>

  /**
   * Generate structured per-file diffs between two captured trees. `context`
   * controls unchanged lines around each unified diff hunk.
   */
  // （中文）在两棵快照树之间生成按文件的结构化差异；`context` 控制每个统一差异块（hunk）
  // 周围保留的未变更行数
  readonly diff: (input: DiffInput) => Effect.Effect<readonly FileDiff.Info[], Error>

  /**
   * Restore selected project-relative paths from their associated trees. A path
   * absent from its selected tree is removed; paths outside the map are untouched.
   */
  // （中文）按映射从对应的快照树恢复所选路径；路径在其树中不存在时会被删除，映射之外的路径保持不动
  readonly restore: (input: RestoreInput) => Effect.Effect<void, Error>
}

// 定义 Snapshot 服务标记类
export class Service extends Context.Service<Service, Interface>()("@opencode/Snapshot") {}

// 构建 Snapshot 服务层
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 获取文件系统工具服务
    const fs = yield* FSUtil.Service
    // 获取 Git 服务
    const git = yield* Git.Service
    // 获取全局数据目录
    const global = yield* Global.Service
    // 获取位置服务
    const location = yield* Location.Service
    // 取当前层生命周期作用域，快照仓库的初始化纤程挂在其下
    const lifetime = yield* Scope.Scope
    // 创建快照开关状态
    const state = State.create<{ enabled: boolean }, Editor>({
      name: "snapshot",
      // 默认启用
      initial: () => ({ enabled: true }),
      editor: (editor) => ({
        configure: (enabled) => {
          editor.enabled = enabled
        },
      }),
    })
    // Cache a scope-owned fiber so caller cancellation stops waiting without poisoning shared initialization.
    // （中文）缓存一个归作用域所有的纤程：调用方取消只是停止等待，不会污染共享的初始化过程
    const repositoryFiber = yield* Effect.cached(
      Effect.gen(function* () {
        // 在项目目录中发现外层 Git 仓库
        const source = yield* git.repo.discover(location.project.directory)
        // 不是 Git 仓库则报错
        if (!source) return yield* new Error({ operation: "capture", message: "Project is not a Git repository" })
        // worktree 取真实路径（规范化符号链接）
        const worktree = AbsolutePath.make(yield* fs.realPath(source.worktree).pipe(Effect.orDie))
        // 快照仓库的 git 目录：数据目录/snapshot/项目ID/<worktree 哈希>
        const gitDirectory = AbsolutePath.make(
          path.join(global.data, "snapshot", location.project.id, Hash.fast(worktree)),
        )
        // 已存在（有 HEAD）则直接复用；否则以源仓库为种子创建新的快照仓库
        const snapshotRepository = (yield* fs.existsSafe(path.join(gitDirectory, "HEAD")))
          ? new Git.Repository({ worktree, gitDirectory, commonDirectory: gitDirectory })
          : yield* git.repo
              .create({ worktree, gitDirectory, seed: source })
              .pipe(Effect.mapError((cause) => failure("capture", cause)))
        // 返回发现结果、规范化的 worktree 与快照仓库
        return { source, worktree, snapshotRepository }
      }).pipe(Effect.forkIn(lifetime)),
    )
    // 等待初始化完成（不可中断地合并纤程结果）
    const repository = repositoryFiber.pipe(Effect.uninterruptible, Effect.flatMap(Fiber.join))

    // The worktree is a real path, so the Location must be one too: a symlinked or junctioned path would fall outside
    // it, and a path in another letter case would become a pathspec that matches nothing.
    // （中文）worktree 已是真实路径，因此 Location 也必须是：符号链接/联接（junction）路径会落在其外；
    // 大小写不一致的路径会变成匹配不到任何文件的 pathspec
    // 计算捕获范围：Location 目录相对 worktree 的路径
    const scope = Effect.fnUntraced(function* (worktree: AbsolutePath) {
      // 规范化 Location 目录的真实路径
      const directory = yield* fs
        .realPath(location.directory)
        .pipe(Effect.mapError((cause) => failure("capture", cause)))
      // 目录在项目之外则报错
      if (!FSUtil.contains(worktree, directory))
        return yield* new Error({ operation: "capture", message: "Location is outside the project" })
      // 返回相对路径（Windows 反斜杠转正斜杠；空串时用 "."）
      return RelativePath.make(path.relative(worktree, directory).replaceAll("\\", "/") || ".")
    })

    // 快照功能是否可用：位置托管在 Git 之上且状态开关打开
    const enabled = () => location.vcs?.type === "git" && state.get().enabled

    // `objects.pack` takes a cross-process lock, so a run that outlasts the interval never overlaps the next.
    // （中文）`objects.pack` 需要跨进程锁，因此一次运行超过间隔也不会与下一次重叠
    // 上次打包检查时间，初始为负无穷（表示从未检查过）
    let lastPackCheck = Number.NEGATIVE_INFINITY
    // 距上次检查满 10 分钟时在后台打包快照对象
    const packWhenDue = Effect.fnUntraced(function* (repository: Git.Repository) {
      // 当前时间
      const now = yield* Clock.currentTimeMillis
      // 未满 10 分钟则跳过
      if (now - lastPackCheck < 10 * 60 * 1000) return
      // 记录本次检查时间
      lastPackCheck = now
      // fork 后台打包；失败仅记录警告
      yield* git.objects.pack(repository).pipe(
        Effect.catch((cause) => Effect.logWarning("failed to pack snapshot objects", { cause })),
        Effect.forkIn(lifetime),
      )
    })

    // （中文）捕获当前状态为快照树
    const capture = Effect.fn("Snapshot.capture")(function* () {
      // 未启用则直接返回 undefined
      if (!enabled()) return undefined
      return yield* Effect.gen(function* () {
        // 等待仓库初始化完成
        const repo = yield* repository
        // 以相对范围为 scope 捕获树（忽略规则来自源仓库；未跟踪文件上限 2MiB）
        const tree = yield* git.tree.capture({
          repository: repo.snapshotRepository,
          scopes: [yield* scope(repo.worktree)],
          ignores: repo.source,
          maximumUntrackedFileBytes: 2 * 1024 * 1024,
        })
        // 视情况触发后台打包
        yield* packWhenDue(repo.snapshotRepository)
        // 树哈希即为快照 ID
        return ID.make(tree)
      }).pipe(
        // 任何失败只记警告并返回 undefined（尽力而为，不影响主流程）
        Effect.catch((cause) => Effect.logWarning("failed to capture snapshot", { cause }).pipe(Effect.as(undefined))),
      )
    })

    // （中文）组装比较所需的仓库与树 ID
    const comparison = Effect.fnUntraced(function* (operation: "files" | "diff", input: CompareInput) {
      // 等待仓库初始化（失败包装为对应操作的错误）
      const repo = yield* repository.pipe(Effect.mapError((cause) => failure(operation, cause)))
      // 返回源仓库、快照仓库与两棵树 ID
      return {
        source: repo.source,
        repository: repo.snapshotRepository,
        from: Git.TreeID.make(input.from),
        to: Git.TreeID.make(input.to),
      }
    })

    // Snapshots track every scoped file; the source repository's ignore rules decide what callers see.
    // （中文）快照记录范围内所有文件；源仓库的忽略规则决定调用方能看到什么
    // 请求源仓库的忽略规则，返回被忽略路径的集合
    const ignored = Effect.fnUntraced(function* (
      operation: "files" | "diff",
      source: Git.Repository,
      paths: readonly RelativePath[],
    ) {
      return yield* git.index
        .ignored({ repository: source, paths })
        .pipe(Effect.mapError((cause) => failure(operation, cause)))
    })

    // （中文）列出两树间变化且未被源仓库忽略的文件
    const files = Effect.fn("Snapshot.files")(function* (input: CompareInput) {
      // 组装比较上下文
      const compared = yield* comparison("files", input)
      // 计算树间变化文件
      const changed = yield* git.tree
        .files({ repository: compared.repository, from: compared.from, to: compared.to })
        .pipe(Effect.mapError((cause) => failure("files", cause)))
      // 无变化直接返回空
      if (changed.length === 0) return []
      // 查询源仓库的忽略规则
      const skipped = yield* ignored("files", compared.source, changed)
      // 过滤掉被忽略的文件
      return changed.filter((file) => !skipped.has(file))
    })

    // （中文）生成两树间按文件的差异（可带路径过滤）
    const diff = Effect.fn("Snapshot.diff")(function* (input: DiffInput) {
      // 显式传入空路径列表时直接返回空
      if (input.paths?.length === 0) return []
      // 组装比较上下文
      const compared = yield* comparison("diff", input)
      // Only an explicit selection becomes a pathspec; ignored paths are dropped from the result instead.
      // （中文）只有显式选择的路径才作为 pathspec；被忽略的路径从结果中剔除而不是预先传入
      // 计算树间差异
      const diffs = yield* git.tree
        .diff({
          repository: compared.repository,
          from: compared.from,
          to: compared.to,
          context: input.context,
          paths: input.paths,
        })
        .pipe(Effect.mapError((cause) => failure("diff", cause)))
      // 无差异直接返回空
      if (diffs.length === 0) return []
      // 提取差异涉及的文件路径
      const paths = diffs.map((file) => RelativePath.make(file.file))
      // 查询源仓库的忽略规则
      const skipped = yield* ignored("diff", compared.source, paths)
      // 剔除被忽略的差异项
      return diffs.filter((_, index) => !skipped.has(paths[index]!))
    })

    // （中文）校验并构造恢复计划：路径 -> 树 ID，且路径不得逃出项目
    const plan = Effect.fnUntraced(function* (worktree: AbsolutePath, input: RestoreInput) {
      // 恢复计划表
      const files = new Map<RelativePath, Git.TreeID>()
      // 逐项校验
      for (const [file, snapshot] of input.files) {
        // 解析为绝对路径
        const absolute = path.resolve(worktree, file)
        // 逃出项目目录则报错
        if (!FSUtil.contains(worktree, absolute))
          return yield* new Error({ operation: "restore", message: `Path escapes the project: ${file}` })
        // 登记恢复项
        files.set(file, Git.TreeID.make(snapshot))
      }
      // 返回计划
      return files
    })

    // （中文）从快照恢复所选路径
    const restore = Effect.fn("Snapshot.restore")(function* (input: RestoreInput) {
      // 功能被禁用时显式报错
      if (!enabled()) return yield* new Error({ operation: "restore", message: "Snapshots are disabled" })
      // 等待仓库初始化完成
      const repo = yield* repository.pipe(Effect.mapError((cause) => failure("restore", cause)))
      // 按恢复计划执行树级恢复
      yield* git.tree
        .restore({ repository: repo.snapshotRepository, files: yield* plan(repo.worktree, input) })
        .pipe(Effect.mapError((cause) => failure("restore", cause)))
    })

    // 组装服务实例
    return Service.of({ transform: state.transform, reload: state.reload, capture, files, diff, restore })
  }).pipe(Effect.withSpan("Snapshot.boot")),
)

// 导出位置级服务节点
export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Git.node, Global.node, Location.node],
})

// （中文）空实现层：在禁用快照的场合替代真实服务
export const noopLayer = Layer.succeed(
  Service,
  Service.of({
    transform: () => Effect.succeed({ dispose: Effect.void }),
    reload: () => Effect.void,
    capture: () => Effect.undefined,
    files: () => Effect.succeed([]),
    diff: () => Effect.succeed([]),
    restore: () => Effect.void,
  }),
)

// （中文）把底层错误包装为快照错误；已是同一操作的快照错误则原样返回
function failure(operation: Error["operation"], cause: unknown) {
  // 同操作错误直接复用
  if (cause instanceof Error && cause.operation === operation) return cause
  // 其他错误统一包装
  return new Error({
    operation,
    message: cause instanceof globalThis.Error ? cause.message : String(cause),
    cause,
  })
}
