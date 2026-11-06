// 将本模块整体导出为 Git 命名空间（自导出，供其他模块以 Git.xxx 引用）
export * as Git from "./git.js"

// 引入 os（取家目录）与 path（路径拼接/解析）
import os from "os"
import path from "path"
// 引入 Effect 的失败原因、上下文、延迟值、Effect、Exit、层、重试计划与模式工具
import { Cause, Context, Deferred, Effect, Exit, Layer, Option, Schedule, Schema } from "effect"
// 引入子进程构造器（effect/process）
import { ChildProcess } from "effect/process"
// 引入绝对/相对路径品牌类型
import { AbsolutePath, RelativePath } from "./schema.js"
// 引入文件系统工具服务
import { FSUtil } from "@opencode/util/fs-util"
// 引入应用进程执行服务
import { AppProcess } from "@opencode/util/process"
// 引入全局节点构造器（不绑定目录的服务节点）
import { makeGlobalNode } from "@opencode/util/effect/app-node"
// 引入文件差异模式（diff 结果结构）
import { FileDiff } from "@opencode/schema/file-diff"
// 引入按键互斥锁（KeyedMutex）
import { KeyedMutex } from "./effect/keyed-mutex.js"
// 引入 VCS 补丁工具（补丁切块与字节预算）
import { VcsPatch } from "./vcs/patch.js"
// 引入 git 可执行文件的解析逻辑
import { gitExecutable } from "./util/git-executable.js"

// 仓库（Repository）实体：工作树（worktree）目录、git 目录（GIT_DIR）与公共目录（common dir）
export class Repository extends Schema.Class<Repository>("Git.Repository")({
  worktree: AbsolutePath,
  gitDirectory: AbsolutePath,
  commonDirectory: AbsolutePath,
}) {}

// Included from $GIT_DIR/config via include.path (git >= 1.7.10); OpenCode owns
// this file entirely, so updates are plain rewrites with no config parsing.
// OpenCode 完全拥有的 gitconfig 片段文件名（由 config 的 include.path 引入）
const snapshotConfigFile = "opencode.gitconfig"
// 追加到仓库 config 的 include 片段（引入上面的文件）
const snapshotConfigInclude = `[include]
	path = ${snapshotConfigFile}
`
// 快照仓库的核心配置：关闭 autocrlf/splitIndex/fsmonitor，启用 longpaths、
// symlinks、untrackedCache、manyFiles，索引用版本 4（提升大仓库性能与一致性）
const snapshotConfig = `[core]
	autocrlf = false
	longpaths = true
	symlinks = true
	fsmonitor = false
	untrackedCache = true
	# A split index cannot name its shared file once manyFiles skips index checksums.
	splitIndex = false
[feature]
	manyFiles = true
[index]
	version = 4
	threads = true
`

// 树对象（tree）ID 的品牌类型（带 Git.TreeID 品牌的字符串）
export const TreeID = Schema.String.pipe(Schema.brand("Git.TreeID"))
export type TreeID = typeof TreeID.Type

// 临时索引文件名前缀（区分 OpenCode 创建的临时索引）
const temporaryIndexPrefix = "index.opencode-"
// Like `git gc --auto`, pack once loose objects accumulate, and combine packs before lookups slow down.
// Room for paths on one Git command line after the Git path, repository flags, and quoting. Windows caps a command
// line at 32,767 characters. macOS caps arguments plus environment at 1 MiB, and Linux caps them at 2 MiB by default.
// 单条 Git 命令行的参数预算：Windows 24k 字符，其余平台 128KiB
const argumentBudget = process.platform === "win32" ? 24_000 : 128 * 1024
// 松散对象（loose objects）数量达到该值就触发打包
const looseObjectLimit = 2048
// 包（pack）数量达到该值就触发合并打包
const packCountLimit = 16

// 快照捕获（capture）的输入
export interface CaptureInput {
  readonly repository: Repository
  // 要捕获的项目相对路径范围（scopes）
  readonly scopes: readonly RelativePath[]
  /**
   * Source repository whose ignore rules decide which paths are recorded. Its index also
   * rebuilds an unreadable snapshot index without rehashing every tracked file.
   */
  // 提供忽略规则与索引种子的源仓库（可选）
  readonly ignores?: Repository
  // 未跟踪文件的大小上限（超过则跳过不入快照）
  readonly maximumUntrackedFileBytes?: number
}

// 错误类：Git 操作失败（带操作名、消息、目录与原因）
export class OperationError extends Schema.TaggedError<OperationError>()("Git.OperationError", {
  operation: Schema.Literals([
    "clone",
    "fetch",
    "checkout",
    "reset",
    "create",
    "refresh",
    "write_tree",
    "list_files",
    "diff",
    "restore",
    "pack",
  ]),
  message: Schema.String,
  directory: Schema.optional(AbsolutePath),
  cause: Schema.optional(Schema.Defect()),
}) {}

/** Git could not answer: the spawn failed or it exited with an unexpected status. */
// 错误类：Git 无法应答（进程启动失败或以异常退出码结束）
export class CommandError extends Schema.TaggedError<CommandError>()("Git.CommandError", {
  args: Schema.Array(Schema.String),
  exitCode: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Defect()),
}) {}

// 工作树（worktree）条目：目录 + 类型（main 主工作树 / linked 链接工作树）
export class Worktree extends Schema.Class<Worktree>("Git.Worktree")({
  directory: AbsolutePath,
  kind: Schema.Literals(["main", "linked"]),
}) {}

// 错误类：工作树操作失败（创建/移除/列出）
export class WorktreeError extends Schema.TaggedError<WorktreeError>()("Git.WorktreeError", {
  operation: Schema.Literals(["create", "remove", "list"]),
  message: Schema.String,
  directory: Schema.optional(AbsolutePath),
  // 可选：是否需要 --force 才能继续（脏工作树）
  forceRequired: Schema.optional(Schema.Boolean),
  cause: Schema.optional(Schema.Defect()),
}) {}

// 服务接口：按 repo/remote/history/sync/worktree/index/tree/objects 分组的能力声明
export interface Interface {
  readonly repo: {
    // 从某目录向上发现仓库；不是可读仓库时返回 undefined
    readonly discover: (input: AbsolutePath) => Effect.Effect<Repository | undefined>
    /**
     * Spawn-free stamp of the metadata that `discover`, `remote.get` and `history.rootCommits`
     * read for the `.git` entry at `dotGit`: undefined when it isn't a readable repository.
     */
    // 计算指定 .git 条目的"免启动进程"指纹（外部 git 变更会改变它）
    readonly fingerprint: (dotGit: AbsolutePath) => Effect.Effect<string | undefined>
    // 浅克隆远程仓库到目录
    readonly clone: (input: {
      remote: string
      directory: AbsolutePath
      branch?: string
      depth?: number
    }) => Effect.Effect<Repository, OperationError>
    // 在指定目录创建新的 git 存储目录（可从种子仓库播种索引）
    readonly create: (input: {
      worktree: AbsolutePath
      gitDirectory: AbsolutePath
      seed?: Repository
    }) => Effect.Effect<Repository, OperationError>
  }
  readonly remote: {
    /** Undefined when the remote doesn't exist. */
    // 读取远程（remote）URL；远程不存在时返回 undefined
    readonly get: (repository: Repository, name?: string) => Effect.Effect<string | undefined, CommandError>
  }
  readonly history: {
    // HEAD 提交哈希； unborn（未出生）时返回 undefined
    readonly head: (repository: Repository) => Effect.Effect<string | undefined>
    // 当前分支名；分离 HEAD 时返回 undefined
    readonly branch: (repository: Repository) => Effect.Effect<string | undefined>
    // 远端默认分支名
    readonly defaultRemoteBranch: (repository: Repository, remote?: string) => Effect.Effect<string | undefined>
    /** Empty when HEAD is unborn. */
    // 根提交（无父提交）列表；HEAD 未出生时为空
    readonly rootCommits: (repository: Repository) => Effect.Effect<readonly string[], CommandError>
  }
  readonly sync: {
    // 拉取所有远程（可修剪 prune 已删除的引用）
    readonly fetchRemotes: (repository: Repository, input?: { prune?: boolean }) => Effect.Effect<void, OperationError>
    // 拉取单个分支到远程跟踪引用（可强制非快进）
    readonly fetchBranch: (
      repository: Repository,
      input: { remote?: string; branch: string; force?: boolean },
    ) => Effect.Effect<void, OperationError>
    // 检出远程分支（可基于远程分支重置本地分支）
    readonly checkoutRemoteBranch: (
      repository: Repository,
      input: { remote?: string; branch: string; reset?: boolean },
    ) => Effect.Effect<void, OperationError>
    // 硬重置到指定修订
    readonly resetHard: (repository: Repository, revision: string) => Effect.Effect<void, OperationError>
  }
  readonly worktree: {
    // 创建链接工作树
    readonly create: (input: {
      repository: Repository
      directory: AbsolutePath
      ref?: string
    }) => Effect.Effect<Repository, WorktreeError>
    // 移除工作树（可强制）
    readonly remove: (input: {
      repository: Repository
      directory: AbsolutePath
      force: boolean
    }) => Effect.Effect<void, WorktreeError>
    // 列出全部工作树
    readonly list: (repository: Repository) => Effect.Effect<readonly Worktree[], WorktreeError>
  }
  readonly index: {
    /** Refresh only the requested project-relative scope, preserving all other entries. */
    // 仅刷新请求的项目相对范围（scope）的索引，保留其他条目；返回被跳过的超大文件
    readonly refresh: (input: {
      repository: Repository
      scope: RelativePath
      ignores?: Repository
      maximumUntrackedFileBytes?: number
    }) => Effect.Effect<{ readonly skipped: readonly RelativePath[] }, OperationError>
    // 批量判断哪些路径被忽略规则排除
    readonly ignored: (input: {
      repository: Repository
      paths: readonly RelativePath[]
    }) => Effect.Effect<ReadonlySet<RelativePath>, OperationError>
  }
  readonly tree: {
    // 捕获快照：把工作树状态写成一棵树对象并返回树 ID
    readonly capture: (input: CaptureInput) => Effect.Effect<TreeID, OperationError>
    // 直接把当前索引写成树对象
    readonly write: (repository: Repository) => Effect.Effect<TreeID, OperationError>
    // 列出两棵树之间有差异的文件
    readonly files: (input: {
      repository: Repository
      from: TreeID
      to: TreeID
    }) => Effect.Effect<readonly RelativePath[], OperationError>
    // 计算两棵树的差异（含逐文件补丁与增删行统计）
    readonly diff: (input: {
      repository: Repository
      from: TreeID
      to: TreeID
      context?: number
      paths?: readonly RelativePath[]
    }) => Effect.Effect<readonly FileDiff.Info[], OperationError>
    // 把文件恢复到指定树中的状态（树里没有则从工作树删除）
    readonly restore: (input: {
      repository: Repository
      files: ReadonlyMap<RelativePath, TreeID>
    }) => Effect.Effect<void, OperationError>
  }
  readonly objects: {
    /**
     * Pack loose objects and combine small packs without dropping any object,
     * reachable or not. Returns without work below the thresholds; safe to run
     * concurrently with captures and with other processes.
     */
    // 打包松散对象并合并小包（不丢弃任何对象）；低于阈值时不做事
    readonly pack: (repository: Repository) => Effect.Effect<void, OperationError>
  }
}

// Effect Context 的服务标签
export class Service extends Context.Service<Service, Interface>()("@opencode/Git") {}

// 构建服务实现的 Layer：全部真实逻辑都在这里
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 依赖：文件系统工具服务
    const fs = yield* FSUtil.Service
    // 依赖：进程执行服务
    const proc = yield* AppProcess.Service
    // 创建按键互斥锁（同一键串行执行）
    const locks = KeyedMutex.makeUnsafe<string>()
    // 以仓库的 git 目录为键加锁执行（同一存储的写操作串行化）
    const locked = <A, E, R>(repository: Repository, effect: Effect.Effect<A, E, R>) =>
      locks.withLock(repository.gitDirectory)(effect)

    // 仓库发现：从 input 向上查找 .git 条目并解析仓库结构
    const discover = Effect.fn("Git.repo.discover")(function* (input: AbsolutePath) {
      // 向上搜索 .git（文件或目录），找不到则返回 undefined
      const dotgit = yield* fs.up({ targets: [".git"], start: input, mode: "first" }).pipe(
        Effect.map((matches) => matches[0]),
        Effect.orElseSucceed(() => undefined),
      )
      if (!dotgit) return undefined

      // 以 .git 所在目录为工作目录运行 rev-parse
      const cwd = path.dirname(dotgit)
      const result = yield* run(cwd, proc, ["rev-parse", "--git-dir", "--git-common-dir", "--show-toplevel"])
      // 解析三行输出：git 目录、公共目录、顶层工作树
      const [gitDir, commonDir, topLevel] = result.text.split(/\r?\n/)
      if (!gitDir || !commonDir) return undefined

      // 构造仓库描述（topLevel 缺失时退化为 cwd）
      return new Repository({
        worktree: AbsolutePath.make(topLevel ? resolvePath(cwd, topLevel) : cwd),
        gitDirectory: AbsolutePath.make(resolvePath(cwd, gitDir)),
        commonDirectory: AbsolutePath.make(resolvePath(cwd, commonDir)),
      })
    })

    // 对单个文件取 stat 指纹（类型:ino:大小:mtime）；读不到时返回 "missing"
    const stamp = (target: string) =>
      fs.stat(target).pipe(
        Effect.map((info) =>
          [info.type, Option.getOrUndefined(info.ino), info.size, Option.getOrUndefined(info.mtime)?.getTime()].join(
            ":",
          ),
        ),
        Effect.orElseSucceed(() => "missing"),
      )
    // 安全读文本文件；失败返回 undefined
    const readText = (target: string) => fs.readFileStringSafe(target).pipe(Effect.orElseSucceed(() => undefined))

    // Covers linked worktrees (gitdir file + commondir), HEAD and the ref it points at,
    // loose/packed/reftable refs, repository/worktree/global/XDG/system config, and the
    // cached `opencode` project id, so external `git init`, a first commit or `git remote`
    // edits change the stamp.
    // 计算 .git 条目的"免启动进程"指纹：覆盖链接工作树（gitdir+commondir）、HEAD
    // 及其指向的引用、松散/打包/reftable 引用、仓库/工作树/全局/XDG/系统配置、
    // 以及缓存的 opencode 项目 ID——外部 git 操作（init、首次提交、改 remote）都会改变指纹
    const fingerprint = Effect.fn("Git.repo.fingerprint")(function* (dotGit: AbsolutePath) {
      // .git 条目本身必须存在且是文件或目录
      const dot = yield* fs.stat(dotGit).pipe(Effect.orElseSucceed(() => undefined))
      if (!dot || (dot.type !== "File" && dot.type !== "Directory")) return undefined
      // .git 是文件（链接工作树）时读取 gitdir: 指向真实 git 目录
      const gitFile = dot.type === "File" ? (yield* readText(dotGit))?.match(/^gitdir:\s*(.+)$/m)?.[1]?.trim() : ""
      if (gitFile === undefined) return undefined
      // 解析真实 git 目录（相对路径相对 .git 所在目录）
      const gitDir = gitFile ? yield* fs.resolve(path.resolve(path.dirname(dotGit), gitFile)) : dotGit
      // 读取 commondir：链接工作树共享的公共目录
      const commondir = (yield* readText(path.join(gitDir, "commondir")))?.trim()
      const commonDir = commondir ? yield* fs.resolve(path.resolve(gitDir, commondir)) : gitDir
      // 读取 HEAD 内容
      const head = (yield* readText(path.join(gitDir, "HEAD")))?.trim()
      if (head === undefined) return undefined
      // HEAD 指向引用时提取引用路径
      const ref = head.startsWith("ref:") ? head.slice(4).trim() : undefined

      // 汇总参与指纹的配置文件（按 git 的查找规则）
      const home = process.env.HOME || os.homedir()
      // GIT_CONFIG_NOSYSTEM 开启时排除系统配置
      const nosystem = ["1", "true", "yes", "on"].includes((process.env.GIT_CONFIG_NOSYSTEM ?? "").toLowerCase())
      const files = [
        path.join(gitDir, "HEAD"),
        path.join(commonDir, "config"),
        path.join(commonDir, "config.worktree"),
        path.join(gitDir, "config.worktree"),
        path.join(commonDir, "packed-refs"),
        path.join(commonDir, "reftable", "tables.list"),
        path.join(commonDir, "opencode"),
        ...(ref ? [path.join(commonDir, ref), path.join(gitDir, ref)] : []),
        process.env.GIT_CONFIG_GLOBAL || path.join(home, ".gitconfig"),
        path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "git", "config"),
        ...(nosystem ? [] : [process.env.GIT_CONFIG_SYSTEM || "/etc/gitconfig"]),
      ]
      // 并发对 .git 条目与全部文件取 stat 指纹
      const stamps = yield* Effect.forEach([dotGit, ...files], stamp, { concurrency: "unbounded" })
      // 组合最终指纹字符串（目录、HEAD、文件清单与各文件印记）
      return [gitDir, commonDir, head, ...files, ...stamps].join("\0")
    })

    // 执行 git 命令；进程启动失败映射为 CommandError
    const command = (cwd: string, args: string[]) =>
      execute(cwd, proc, args).pipe(Effect.mapError((cause) => new CommandError({ args, cause })))

    // 读取远程 URL
    const remote = Effect.fn("Git.remote.get")(function* (repository: Repository, name = "origin") {
      const args = ["remote", "get-url", name]
      const result = yield* command(repository.worktree, args)
      // Exit 2: no such remote.
      if (result.exitCode === 2) return undefined
      // 其他非零退出码：报 CommandError
      if (result.exitCode !== 0) return yield* new CommandError({ args, exitCode: result.exitCode })
      // 空输出视为 undefined
      return result.text.trim() || undefined
    })

    // 列出根提交（无父提交的提交）
    const roots = Effect.fn("Git.history.rootCommits")(function* (repository: Repository) {
      const args = ["rev-list", "--max-parents=0", "HEAD"]
      const result = yield* command(repository.worktree, args)
      // 成功：按行拆分、去空、排序
      if (result.exitCode === 0)
        return result.text
          .split("\n")
          .map((item) => item.trim())
          .filter(Boolean)
          .toSorted()
      // `rev-parse -q --verify` exits 1 only when HEAD doesn't resolve, i.e. it is unborn.
      // 用 rev-parse 验证 HEAD：退出码 1 说明 HEAD 未出生（空仓库），返回空列表
      const verify = yield* command(repository.worktree, ["rev-parse", "-q", "--verify", "HEAD"])
      if (verify.exitCode === 1) return []
      // 其余情况：报 CommandError
      return yield* new CommandError({ args, exitCode: result.exitCode })
    })

    // 解析 HEAD 提交哈希；失败（未出生等）返回 undefined
    const head = Effect.fn("Git.history.head")(function* (repository: Repository) {
      const result = yield* run(repository.worktree, proc, ["rev-parse", "HEAD"])
      if (result.exitCode !== 0) return undefined
      return result.text.trim() || undefined
    })

    // 解析当前分支名；分离 HEAD 等失败情形返回 undefined
    const branch = Effect.fn("Git.history.branch")(function* (repository: Repository) {
      const result = yield* run(repository.worktree, proc, ["symbolic-ref", "--quiet", "--short", "HEAD"])
      if (result.exitCode !== 0) return undefined
      return result.text.trim() || undefined
    })

    // 读取远端默认分支（refs/remotes/<remote>/HEAD 的指向）
    const remoteHead = Effect.fn("Git.history.defaultRemoteBranch")(function* (
      repository: Repository,
      remoteName = "origin",
    ) {
      const result = yield* run(repository.worktree, proc, ["symbolic-ref", `refs/remotes/${remoteName}/HEAD`])
      if (result.exitCode !== 0) return undefined
      // 去掉 refs/remotes/<remote>/ 前缀得到分支名
      return result.text.trim().replace(new RegExp(`^refs/remotes/${remoteName}/`), "") || undefined
    })

    // 在目录中执行一次 git 操作：spawn 失败或非零退出都映射为 OperationError
    const operation = Effect.fnUntraced(function* (
      operation: OperationError["operation"],
      directory: AbsolutePath,
      args: string[],
    ) {
      const result = yield* execute(directory, proc, args).pipe(Effect.mapError(spawnFailure(operation, directory)))
      // 退出码 0：成功
      if (result.exitCode === 0) return
      // 非零：构造操作失败错误
      return yield* commandFailure(operation, directory, result)
    })

    // 克隆远程仓库（浅克隆，默认深度 100）
    const clone = Effect.fn("Git.repo.clone")(function* (input: {
      remote: string
      directory: AbsolutePath
      branch?: string
      depth?: number
    }) {
      // 在目标目录的父目录中执行 clone（-- 结束选项，防注入）
      yield* operation("clone", AbsolutePath.make(path.dirname(input.directory)), [
        "clone",
        "--depth",
        String(input.depth ?? 100),
        ...(input.branch ? ["--branch", input.branch] : []),
        "--",
        input.remote,
        input.directory,
      ])
      // 克隆完成后 discover 验证仓库可打开
      const repository = yield* discover(input.directory)
      if (repository) return repository
      // 打不开：报克隆失败
      return yield* new OperationError({
        operation: "clone",
        directory: input.directory,
        message: "Cloned repository could not be opened",
      })
    })

    // 拉取所有远程（默认开启 --prune 修剪失效引用）
    const fetch = Effect.fn("Git.sync.fetchRemotes")(function* (
      repository: Repository,
      input: { prune?: boolean } = {},
    ) {
      yield* operation("fetch", repository.worktree, ["fetch", "--all", ...(input.prune === false ? [] : ["--prune"])])
    })

    // 拉取单个分支到远程跟踪引用
    const fetchBranch = Effect.fn("Git.sync.fetchBranch")(function* (
      repository: Repository,
      input: { remote?: string; branch: string; force?: boolean },
    ) {
      // 远程名默认 origin
      const remoteName = input.remote ?? "origin"
      // 引用规格：本地分支 → 远程跟踪引用
      const spec = `refs/heads/${input.branch}:refs/remotes/${remoteName}/${input.branch}`
      // force !== false 时加 + 前缀允许非快进更新
      yield* operation("fetch", repository.worktree, ["fetch", remoteName, input.force === false ? spec : `+${spec}`])
    })

    // 检出远程分支
    const checkout = Effect.fn("Git.sync.checkoutRemoteBranch")(function* (
      repository: Repository,
      input: { remote?: string; branch: string; reset?: boolean },
    ) {
      const remoteName = input.remote ?? "origin"
      // reset !== false 时用 -B 基于远程分支重建本地分支；否则普通检出
      yield* operation("checkout", repository.worktree, [
        "checkout",
        ...(input.reset === false ? [input.branch] : ["-B", input.branch, `${remoteName}/${input.branch}`]),
      ])
    })

    // 硬重置到指定修订
    const reset = Effect.fn("Git.sync.resetHard")(function* (repository: Repository, revision: string) {
      yield* operation("reset", repository.worktree, ["reset", "--hard", revision])
    })

    // 为显式仓库构造 git 参数：同时指定 git 目录与工作树
    const repositoryArgs = (repository: Repository, args: string[]) => [
      "--git-dir",
      repository.gitDirectory,
      "--work-tree",
      repository.worktree,
      ...args,
    ]

    // 在仓库上运行 git：支持自定义索引文件（GIT_INDEX_FILE）、stdin 与输出上限
    const repositoryRun = (
      operationName: OperationError["operation"],
      repository: Repository,
      args: string[],
      options?: RepositoryOptions,
    ) =>
      proc
        .run(
          ChildProcess.make(gitExecutable(), repositoryArgs(repository, args), {
            cwd: repository.worktree,
            env: options?.index ? { ...options.env, GIT_INDEX_FILE: options.index } : options?.env,
            extendEnv: true,
          }),
          { stdin: options?.stdin, maxOutputBytes: options?.maxOutputBytes },
        )
        .pipe(Effect.mapError(spawnFailure(operationName, repository.worktree)))

    // repositoryRun 的封装：解码 stdout/stderr，成功返回文本，失败映射为 OperationError
    const repositoryOperation = Effect.fnUntraced(function* (
      operationName: OperationError["operation"],
      repository: Repository,
      args: string[],
      options?: RepositoryOptions,
    ) {
      const result = yield* repositoryRun(operationName, repository, args, options)
      const text = result.stdout.toString("utf8")
      const stderr = result.stderr.toString("utf8")
      // 退出码 0：返回文本、stderr 与"输出是否被截断"标志
      if (result.exitCode === 0) return { text, stderr, truncated: result.stdoutTruncated }
      // 非零：构造失败错误
      return yield* commandFailure(operationName, repository.worktree, { text, stderr })
    })

    /**
     * On Windows, Git exits non-zero instead of reusing a loose object that another process is finalizing at the
     * same moment. Objects are content-addressed, so one of at most two retries finds that copy in place. Only a Git
     * exit is retried, never a failure to start Git, and other platforms fail on the first attempt.
     */
    // Windows 专用的并发对象写入重试：Git 偶尔因别的进程正在落盘同一对象而失败，
    // 对象按内容寻址，最多重试 2 次（间隔 50ms）即可命中；仅重试 Git 自身退出失败，
    // 不重试启动失败；其他平台一次定胜负
    const retryConcurrentObjectWrite = <A, R>(effect: Effect.Effect<A, OperationError, R>) =>
      process.platform === "win32"
        ? effect.pipe(
            Effect.retry({
              times: 2,
              schedule: Schedule.spaced("50 millis"),
              while: (error) => error.cause === undefined,
            }),
          )
        : effect

    /**
     * A new store is initialized in a temporary sibling directory and renamed into
     * place, so processes racing to create the same store never observe or write a
     * half-initialized one; the loser discards its copy and adopts the winner's.
     */
    // 创建新的 git 存储目录：先在临时兄弟目录初始化，再原子改名就位；
    // 并发创建者中输家丢弃自己的副本、采用赢家的成果
    const create = Effect.fn("Git.repo.create")(function* (input: {
      worktree: AbsolutePath
      gitDirectory: AbsolutePath
      seed?: Repository
    }) {
      // 目标仓库描述（common 目录即 git 目录）
      const repository = new Repository({
        worktree: input.worktree,
        gitDirectory: input.gitDirectory,
        commonDirectory: input.gitDirectory,
      })
      // 已存在 HEAD：说明存储已在，只需重新初始化（补配置）
      if (yield* fs.existsSafe(path.join(input.gitDirectory, "HEAD"))) {
        yield* initRepository({ ...input, directory: input.gitDirectory })
        return repository
      }
      // 临时兄弟目录（带唯一后缀）
      const temporaryDirectory = AbsolutePath.make(`${input.gitDirectory}.init-${uniqueSuffix()}`)
      yield* Effect.gen(function* () {
        // 在临时目录中完成初始化
        yield* initRepository({ ...input, directory: temporaryDirectory })
        // 原子改名到目标位置（捕获结果而非让错误冒泡）
        const renamed = yield* fs.rename(temporaryDirectory, input.gitDirectory).pipe(Effect.exit)
        // 改名成功，或并发对手已就位（HEAD 出现）：采用现状
        if (Exit.isSuccess(renamed) || (yield* fs.existsSafe(path.join(input.gitDirectory, "HEAD")))) return
        // 都失败：报操作错误
        return yield* new OperationError({
          operation: "create",
          directory: input.gitDirectory,
          message: "Failed to move Git storage into place",
          cause: Cause.squash(renamed.cause),
        })
      }).pipe(Effect.ensuring(fs.remove(temporaryDirectory, { recursive: true, force: true }).pipe(Effect.ignore)))
      return repository
    })

    // 初始化 git 存储目录：建目录、git init、写配置、可选播种（对象共享与索引）
    const initRepository = Effect.fnUntraced(function* (input: {
      worktree: AbsolutePath
      gitDirectory: AbsolutePath
      directory: AbsolutePath
      seed?: Repository
    }) {
      // 错误工厂：统一包装为 create 操作错误
      const operationError = (message: string) => (cause: unknown) =>
        new OperationError({ operation: "create", directory: input.gitDirectory, message, cause })
      // 确保目录存在
      yield* fs.ensureDir(input.directory).pipe(Effect.mapError(operationError("Failed to create Git storage")))
      // 执行 git init
      yield* repositoryOperation(
        "create",
        new Repository({ worktree: input.worktree, gitDirectory: input.directory, commonDirectory: input.directory }),
        ["init"],
      )
      // 写入快照配置文件并确保 config 里有 include 片段
      yield* Effect.gen(function* () {
        // 写入 OpenCode 拥有的 gitconfig 片段
        yield* fs.writeFileString(path.join(input.directory, snapshotConfigFile), snapshotConfig)
        // 读取 git init 生成的 config
        const config = path.join(input.directory, "config")
        const current = yield* fs.readFileString(config)
        // 已包含 include 片段则跳过
        if (current.includes(snapshotConfigInclude)) return
        // 以追加方式写入 include 片段（补齐换行）
        yield* fs.writeFileString(config, `${current.endsWith("\n") ? "\n" : "\n\n"}${snapshotConfigInclude}`, {
          flag: "a",
        })
      }).pipe(Effect.mapError(operationError("Failed to configure Git storage")))
      // 无种子仓库：到此结束
      if (!input.seed) return
      // 有种子：共享其对象库（写 alternates 指向源仓库的 objects 目录）
      yield* fs
        .ensureDir(path.join(input.directory, "objects", "info"))
        .pipe(Effect.mapError(operationError("Failed to configure shared Git objects")))
      yield* fs
        .writeFileString(
          path.join(input.directory, "objects", "info", "alternates"),
          path.join(input.seed.commonDirectory, "objects") + "\n",
        )
        .pipe(Effect.mapError(operationError("Failed to configure shared Git objects")))
      // 播种索引：从源仓库复制索引到本仓库（失败则清理并忽略）
      const index = path.join(input.directory, "index")
      yield* seedIndex(
        new Repository({ worktree: input.worktree, gitDirectory: input.directory, commonDirectory: input.directory }),
        input.seed,
        index,
      ).pipe(
        Effect.catch(() => fs.remove(index, { force: true })),
        Effect.ignore,
      )
    })

    /**
     * Both commands only read the index, so they never take `index.lock`. Two parallel processes beat one combined
     * `ls-files -m -o`, whose lstat pass is not threaded like diff-files'.
     */
    // 列出工作树相对某索引的改动：已跟踪改动（diff-files）与未跟踪文件（ls-files --others）。
    // 两个命令都只读索引、不抢 index.lock，并行跑比合并的单条 ls-files -m -o 更快
    const listChanges = Effect.fnUntraced(function* (
      repository: Repository,
      scope: RelativePath,
      index?: string,
      excludeFrom?: string,
    ) {
      // 单条列表命令的封装：按 NUL 拆分并规整为相对路径
      const list = (args: string[]) =>
        repositoryOperation("refresh", repository, args, { index }).pipe(
          // Embedded repositories are listed as `dir/`; update-index records them as gitlinks.
          Effect.map((result) => nuls(result.text).map((file) => RelativePath.make(file.replace(/\/$/, "")))),
        )
      // 并行执行两条命令（并发 2）
      const [tracked, untracked] = yield* Effect.all(
        [
          // 已跟踪文件的改动
          list(["diff-files", "--name-only", "-z", "--", literalPathspec(scope)]),
          // 未跟踪文件（可选用源仓库的 exclude 文件过滤）
          list([
            "ls-files",
            "--others",
            ...(excludeFrom ? [`--exclude-from=${excludeFrom}`] : []),
            "--exclude-standard",
            "-z",
            "--",
            literalPathspec(scope),
          ]),
        ],
        { concurrency: 2 },
      )
      return { tracked, untracked }
    })

    // 把改动写入（临时）索引：处理排除集、超大文件跳过与嵌入仓库 gitlink
    const updateIndex = Effect.fnUntraced(function* (input: {
      repository: Repository
      changes: { tracked: readonly RelativePath[]; untracked: readonly RelativePath[] }
      ignores?: Repository
      maximumUntrackedFileBytes?: number
      index?: string
      excluded?: ReadonlySet<RelativePath>
    }) {
      // 全部候选路径（已跟踪 + 未跟踪）
      const candidates = [...input.changes.tracked, ...input.changes.untracked]
      // 无候选：无事可做
      if (!candidates.length) return { skipped: [] }
      // 排除集：外部传入，或用忽略仓库现算，否则为空集
      const excluded =
        input.excluded ??
        (input.ignores ? yield* ignored({ repository: input.ignores, paths: candidates }) : new Set<RelativePath>())
      // 未跟踪文件大小上限
      const maximum = input.maximumUntrackedFileBytes
      // 有上限时：并发 stat 未跟踪且未被排除的文件，找出超限者
      const skipped = maximum
        ? (yield* Effect.forEach(
            input.changes.untracked.filter((item) => !excluded.has(item)),
            (item) =>
              fs.stat(path.join(input.repository.worktree, item)).pipe(
                Effect.map((info) => (info.type === "File" && Number(info.size) > maximum ? item : undefined)),
                Effect.orElseSucceed(() => undefined),
              ),
            { concurrency: 8 },
          )).filter((item): item is RelativePath => item !== undefined)
        : []
      // 跳过集合
      const skip = new Set(skipped)
      // 实际要加入索引的路径
      const added = candidates.filter((item) => !excluded.has(item) && !skip.has(item))
      // Untracked paths are not in the index, so only tracked paths that are now ignored need removing.
      // 需要从索引强制移除的路径：被忽略规则排除的已跟踪文件
      const removed = input.changes.tracked.filter((item) => excluded.has(item))
      // update-index takes literal paths, so large lists avoid add's quadratic pathspec matching.
      // 用 update-index --stdin 移除（字面路径，避免 add 的路径规格二次方匹配）
      if (removed.length)
        yield* repositoryOperation("refresh", input.repository, ["update-index", "--force-remove", "-z", "--stdin"], {
          stdin: removed.join("\0") + "\0",
          index: input.index,
        })
      // update-index drops a tracked file replaced by an embedded repository; a second line for the same path,
      // in the same call, records its gitlink. For a path that already is a gitlink the repeat is a no-op.
      // 检测被嵌入仓库顶替的已跟踪路径（目录下出现 .git）
      const embedded = (yield* Effect.forEach(
        input.changes.tracked.filter((item) => !excluded.has(item)),
        (item) =>
          fs
            .existsSafe(path.join(input.repository.worktree, item, ".git"))
            .pipe(Effect.map((found) => (found ? item : undefined))),
        { concurrency: 8 },
      )).filter((item): item is RelativePath => item !== undefined)
      // 有要加入的路径：update-index --add --remove --replace（含嵌入仓库的重复行以记录 gitlink）
      if (added.length)
        yield* retryConcurrentObjectWrite(
          repositoryOperation(
            "refresh",
            input.repository,
            ["update-index", "--add", "--remove", "--replace", "-z", "--stdin"],
            { stdin: [...added, ...embedded].join("\0") + "\0", index: input.index },
          ),
        )
      // 返回本次跳过的超大文件
      return { skipped }
    })

    // 刷新索引：对单个范围列出改动并写入
    const refresh = Effect.fn("Git.index.refresh")(function* (input: {
      repository: Repository
      scope: RelativePath
      ignores?: Repository
      maximumUntrackedFileBytes?: number
    }) {
      return yield* updateIndex({ ...input, changes: yield* listChanges(input.repository, input.scope) })
    })

    // 批量判断哪些路径被忽略（check-ignore --no-index，NUL 分隔 stdin/stdout）
    const ignored = Effect.fn("Git.index.ignored")(function* (input: {
      repository: Repository
      paths: readonly RelativePath[]
    }) {
      // 空输入直接返回空集
      if (!input.paths.length) return new Set<RelativePath>()
      const result = yield* repositoryRun(
        "list_files",
        input.repository,
        ["check-ignore", "--no-index", "--stdin", "-z"],
        { stdin: input.paths.join("\0") + "\0" },
      )
      // Exit 1: none of the paths are ignored.
      // 退出码 1 表示没有任何路径被忽略（正常）；其他非零才是错误
      if (result.exitCode !== 0 && result.exitCode !== 1)
        return yield* new OperationError({
          operation: "list_files",
          directory: input.repository.worktree,
          message: result.stderr.toString("utf8").trim() || "Failed to check ignored paths",
        })
      // 返回被忽略路径的集合
      return new Set(nuls(result.stdout.toString("utf8")).map((file) => RelativePath.make(file)))
    })

    // 把当前索引写成树对象（可指定临时索引）
    const writeTree = Effect.fn("Git.tree.write")(function* (repository: Repository, index?: string) {
      // 带 Windows 并发重试地执行 write-tree
      const tree = (yield* retryConcurrentObjectWrite(
        repositoryOperation("write_tree", repository, ["write-tree"], { index }),
      )).text.trim()
      // 校验输出是 40-64 位十六进制（SHA-1/SHA-256）
      if (/^[0-9a-f]{40,64}$/.test(tree)) return TreeID.make(tree)
      // 非法输出：报错
      return yield* new OperationError({
        operation: "write_tree",
        directory: repository.worktree,
        message: `Invalid tree ID: ${tree}`,
      })
    })

    // 仓库索引文件路径
    const indexFile = (repository: Repository) => path.join(repository.gitDirectory, "index")
    /** Git only replaces an index by renaming a new file into place, so every write changes its inode. */
    // 索引指纹（ino:大小:mtime）——Git 替换索引靠改名，每次写入必换 inode
    const indexFingerprint = (file: string) =>
      fs.stat(file).pipe(
        Effect.map((info) =>
          [Option.getOrUndefined(info.ino), info.size, Option.getOrUndefined(info.mtime)?.getTime()].join(":"),
        ),
        Effect.orElseSucceed(() => undefined),
      )

    /** A copied index must keep the timestamp Git uses to detect racily clean entries. */
    // 复制索引并保留 mtime（Git 依赖 mtime 检测 racy-clean 条目）
    const copyIndex = Effect.fnUntraced(function* (from: string, to: string) {
      // 先取源索引的 stat
      const info = yield* fs.stat(from)
      // 复制文件
      yield* fs.copyFile(from, to)
      // 恢复 mtime（失败可忽略）
      const mtime = Option.getOrUndefined(info.mtime)
      if (mtime)
        yield* fs
          .utimes(
            to,
            Option.getOrElse(info.atime, () => mtime),
            mtime,
          )
          .pipe(Effect.ignore)
    })

    /**
     * Copy the source index into the store. A split index names a shared index file in
     * its own Git directory, so those files are linked in just long enough to rewrite the
     * copy as a complete index.
     */
    // 把源仓库索引播种到目标：若源是分裂索引（split index），先把 sharedindex.* 链接过来，
    // 用 update-index --no-split-index 把副本重写成完整索引，最后清理链接文件
    const seedIndex = Effect.fnUntraced(function* (store: Repository, source: Repository, target: string) {
      // 复制源索引（保留 mtime）
      yield* copyIndex(path.join(source.gitDirectory, "index"), target)
      // 找出源 git 目录里的 sharedindex.* 文件
      const shared = (yield* fs.readDirectory(source.gitDirectory)).filter((entry) => entry.startsWith("sharedindex."))
      // 不是分裂索引：结束
      if (shared.length === 0) return
      yield* Effect.forEach(shared, (entry) => {
        // 把共享索引文件硬链接到目标（链接失败退回复制）
        const from = path.join(source.gitDirectory, entry)
        const to = path.join(store.gitDirectory, entry)
        return fs.link(from, to).pipe(Effect.catch(() => fs.copyFile(from, to)))
      }).pipe(
        // 用 --no-split-index 重写副本为完整索引
        Effect.andThen(repositoryOperation("refresh", store, ["update-index", "--no-split-index"], { index: target })),
        // 无论成败都清理链接进来的共享文件
        Effect.ensuring(
          Effect.forEach(shared, (entry) =>
            fs.remove(path.join(store.gitDirectory, entry), { force: true }).pipe(Effect.ignore),
          ),
        ),
      )
    })

    /**
     * Run index writes against a temporary index, then rename it over the store's
     * index. Processes never contend on `index.lock`, an interrupted or killed
     * writer cannot leave a partial index behind, and a stale lock is irrelevant.
     * Git never writes an index in place, it writes a lock file and renames it over
     * the temporary name, so a hard-linked temporary index leaves the store's index
     * untouched; a copy is the fallback when linking fails. The index is only a stat
     * cache over the object store; when writers race, the last rename wins and the
     * next capture reconciles against the worktree.
     */
    // 临时索引管理（获取-使用-释放）：所有索引写入都针对临时索引，完成后改名覆盖
    // 仓库索引。进程间永不争抢 index.lock；被杀的写者不会留下半个索引；
    // 过期锁无关紧要。获取时优先硬链接现有索引（链接失败退回复制）；
    // 索引只是对象库之上的 stat 缓存，写者竞争时最后改名者胜出，
    // 下次捕获会再与工作树对账
    const withTemporaryIndex = <A, E, R>(repository: Repository, use: (index: string) => Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        // 获取阶段：准备临时索引
        Effect.gen(function* () {
          // 现有仓库索引与临时索引路径
          const current = indexFile(repository)
          const index = temporaryIndex(repository)
          // 没有现有索引：直接用全新临时索引
          if (!(yield* fs.existsSafe(current))) return index
          // 优先硬链接（Git 不原地写索引，链接出的临时索引与仓库索引互不影响）
          const linked = yield* fs.link(current, index).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          )
          if (linked) return index
          // 链接失败：复制索引（保留 mtime）
          yield* copyIndex(current, index).pipe(
            Effect.mapError(
              (cause) =>
                new OperationError({
                  operation: "refresh",
                  directory: repository.gitDirectory,
                  message: "Failed to prepare a temporary index",
                  cause,
                }),
            ),
          )
          return index
        }),
        // 使用阶段：执行写入并安装（改名覆盖）
        (index) =>
          Effect.gen(function* () {
            // 执行调用方给定的索引操作
            const value = yield* use(index)
            // 不可中断地安装临时索引
            const installed = yield* Effect.uninterruptible(
              Effect.gen(function* () {
                // Fingerprint before the rename, so a concurrent writer's index can never be paired with this tree.
                // 改名前取指纹，确保并发写者的索引永不与本树配对
                const fingerprint = yield* indexFingerprint(index)
                // 改名覆盖仓库索引（带重试）
                const renamed = yield* fs.rename(index, indexFile(repository)).pipe(
                  // Windows reports a transient sharing violation while another process reads the index.
                  Effect.retry({ times: 3, schedule: Schedule.spaced("20 millis") }),
                  Effect.as(true),
                  Effect.orElseSucceed(() => false),
                )
                // 安装成功返回指纹，供"干净捕获"缓存配对
                return renamed ? fingerprint : undefined
              }),
            )
            return { value, installed }
          }),
        // 释放阶段：删除临时索引（无论成败）
        (index) => fs.remove(index, { force: true }).pipe(Effect.ignore),
      )

    // A clean capture returns the tree last written from the exact index it scanned.
    // "干净捕获"缓存：git 目录 → (索引指纹, 树 ID)，指纹一致时直接复用上次结果
    const lastCaptures = new Map<string, { readonly fingerprint: string; readonly tree: TreeID }>()
    // 已做过首次整理（清扫临时索引 + 确保配置）的存储集合
    const preparedStores = new Set<string>()
    // 进行中的捕获（键 → Deferred），供相同参数的并发调用共享结果
    const pendingCaptures = new Map<string, Deferred.Deferred<TreeID, OperationError>>()
    // Untracked files skipped for size, by path, with the stamp they had when skipped.
    // 因超限被跳过的未跟踪文件：git 目录 → (路径 → 跳过时的"大小:mtime"印记)
    const oversizedFiles = new Map<string, Map<RelativePath, string>>()

    /**
     * Changes are listed against the temporary index they are written to, never the
     * store's index, which another process may replace at any moment. Each tree is
     * therefore exactly its own index plus the worktree changes against it.
     */
    // 实际捕获：改动永远对照本次写入的临时索引列出（仓库索引随时可能被他人替换），
    // 因此每棵树恰好等于"自己的索引 + 对照它列出的工作树改动"
    const attemptCapture = Effect.fnUntraced(function* (input: CaptureInput) {
      // 源仓库的 info/exclude 文件（作为 ls-files 的排除来源）
      const sourceExclude = input.ignores ? path.join(input.ignores.commonDirectory, "info", "exclude") : undefined
      const excludeFrom = sourceExclude && (yield* fs.existsSafe(sourceExclude)) ? sourceExclude : undefined
      // 全程在临时索引上进行
      const result = yield* withTemporaryIndex(input.repository, (index) =>
        Effect.gen(function* () {
          // 记录本次扫描所用索引的指纹
          const scanned = yield* indexFingerprint(index)
          // 并行对每个范围列出改动
          const changes = yield* Effect.forEach(
            input.scopes,
            (scope) => listChanges(input.repository, scope, index, excludeFrom),
            { concurrency: "unbounded" },
          )
          // 上次干净捕获的记录
          const last = lastCaptures.get(input.repository.gitDirectory)
          // 汇总全部未跟踪文件
          const untracked = changes.flatMap((change) => change.untracked)
          // 上次跳过的超大文件印记表
          const oversized = oversizedFiles.get(input.repository.gitDirectory)
          // 仍然超限的文件：印记未变的那些
          const stillOversized = new Set(
            oversized
              ? (yield* Effect.forEach(
                  untracked.filter((file) => oversized.has(file)),
                  (file) =>
                    oversizedStamp(input, file).pipe(
                      Effect.map((current) => (current && current === oversized.get(file) ? file : undefined)),
                    ),
                  { concurrency: 8 },
                )).filter((file): file is RelativePath => file !== undefined)
              : [],
          )
          // Paths the source ignores are listed as untracked on every scan; they leave the index unchanged.
          // 索引未变（指纹一致）且没有已跟踪改动时：算出被源忽略的路径集合，
          // 用于判断能否复用上次捕获
          const excluded =
            scanned && last?.fingerprint === scanned && changes.every((change) => !change.tracked.length)
              ? input.ignores
                ? yield* ignored({
                    repository: input.ignores,
                    paths: untracked.filter((file) => !stillOversized.has(file)),
                  })
                : new Set<RelativePath>()
              : undefined
          // 上次捕获存在，且所有未跟踪文件要么被忽略要么仍超限：直接复用上次的树
          if (last && excluded && untracked.every((file) => excluded.has(file) || stillOversized.has(file)))
            return last.tree
          // 否则：把每个范围的改动写入索引，收集跳过的超大文件
          const skipped = (yield* Effect.forEach(changes, (change) =>
            updateIndex({ ...input, changes: change, index, excluded }),
          )).flatMap((update) => update.skipped)
          // 记录超大文件印记（供下次捕获判断"仍然超限"）
          oversizedFiles.set(
            input.repository.gitDirectory,
            new Map(
              (yield* Effect.forEach(
                skipped,
                (file) => oversizedStamp(input, file).pipe(Effect.map((value) => [file, value] as const)),
                { concurrency: 8 },
              )).filter((entry): entry is readonly [RelativePath, string] => entry[1] !== undefined),
            ),
          )
          // 写出树对象
          return yield* writeTree(input.repository, index)
        }),
      )
      // 索引成功安装：记录"干净捕获"配对（指纹 → 树）
      if (result.installed)
        lastCaptures.set(input.repository.gitDirectory, { fingerprint: result.installed, tree: result.value })
      // 安装失败：清除缓存配对（下次重新扫描）
      if (!result.installed) lastCaptures.delete(input.repository.gitDirectory)
      return result.value
    })

    // 计算超大文件的印记（"大小:mtime"）；未超限或已消失返回 undefined
    const oversizedStamp = (input: CaptureInput, file: RelativePath) =>
      fs.stat(path.join(input.repository.worktree, file)).pipe(
        Effect.map((info) =>
          input.maximumUntrackedFileBytes && info.type === "File" && Number(info.size) > input.maximumUntrackedFileBytes
            ? `${info.size}:${Option.getOrUndefined(info.mtime)?.getTime()}`
            : undefined,
        ),
        Effect.orElseSucceed(() => undefined),
      )

    /**
     * Callers queued behind a running capture share the next one, which starts after they all asked, so it still
     * sees every change made before each call.
     */
    // 捕获入口：相同参数的并发调用共享同一次捕获；共享者等到的是它们全部到齐之后
    // 才开始的那次捕获，因此仍能看到各自发起前的所有改动
    const captureTree = Effect.fn("Git.tree.capture")(function* (input: CaptureInput) {
      // 以捕获参数构造共享键
      const key = JSON.stringify([
        input.repository.gitDirectory,
        input.repository.worktree,
        input.scopes,
        input.ignores?.gitDirectory,
        input.maximumUntrackedFileBytes,
      ])
      // 已有进行中的捕获：等待其结果
      const pending = pendingCaptures.get(key)
      if (pending) {
        const exit = yield* Effect.exit(Deferred.await(pending))
        // 成功或非中断失败：直接返回结果
        if (Exit.isSuccess(exit) || !Cause.hasInterruptsOnly(exit.cause)) return yield* exit
      }
      // 新建本次捕获的完成信号
      const deferred = Deferred.makeUnsafe<TreeID, OperationError>()
      // 从共享表移除自己（仅当仍是自己时）
      const release = () => {
        if (pendingCaptures.get(key) === deferred) pendingCaptures.delete(key)
      }
      return yield* Effect.uninterruptibleMask((restore) => {
        // 登记进行中
        pendingCaptures.set(key, deferred)
        // 恢复可中断地执行加锁捕获；退出时移除登记并完成信号
        return restore(captureLocked(input, release)).pipe(
          Effect.onExit((exit) => {
            release()
            return Deferred.done(deferred, exit)
          }),
        )
      })
    })

    // 加锁执行捕获：首次接触该存储时先做整理；失败且索引不可读时重建后重试
    const captureLocked = (input: CaptureInput, onStart: () => void) =>
      locked(
        input.repository,
        Effect.gen(function* () {
          // 通知共享等待者：真正的捕获现在才开始
          onStart()
          // 该存储第一次捕获：清扫遗留临时索引并确保配置最新
          if (!preparedStores.has(input.repository.gitDirectory)) {
            preparedStores.add(input.repository.gitDirectory)
            yield* sweepTemporaryIndexes(input.repository)
            yield* ensureSnapshotConfig(input.repository)
          }
          // 执行实际捕获；失败时若索引不可读则重建后重试一次
          return yield* attemptCapture(input).pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                // 索引可读：错误原样上抛
                if (!(yield* isIndexUnreadable(input.repository))) return yield* error
                // 记录重建日志
                yield* Effect.logWarning("rebuilding unreadable snapshot index", {
                  directory: input.repository.gitDirectory,
                  message: error.message,
                })
                // 重建索引后重试
                yield* rebuildIndex(input.repository, input.ignores)
                return yield* attemptCapture(input)
              }),
            ),
          )
        }),
      )

    /**
     * Only an index Git itself cannot read is rebuilt, decided by exit status rather
     * than by localized messages. Other failures, such as an unreadable worktree
     * file or a process that could not start, surface unchanged.
     */
    // 判断索引是否 Git 自身不可读：用 ls-files 探针按退出状态判断（不依赖本地化消息）
    const isIndexUnreadable = Effect.fnUntraced(function* (repository: Repository) {
      // 索引不存在谈不上不可读
      if (!(yield* fs.existsSafe(indexFile(repository)))) return false
      return yield* repositoryOperation("refresh", repository, [
        "ls-files",
        "-z",
        "--",
        literalPathspec(".opencode-probe"),
      ]).pipe(Effect.match({ onSuccess: () => false, onFailure: (error) => error.cause === undefined }))
    })

    // 重建索引：优先从源仓库播种（省去全量重哈希），失败则删除索引从头再来
    const rebuildIndex = Effect.fnUntraced(function* (repository: Repository, source?: Repository) {
      // 清除干净捕获缓存
      lastCaptures.delete(repository.gitDirectory)
      // 准备临时索引
      const temporary = temporaryIndex(repository)
      // The source's stat cache and cache-tree spare recovery from rehashing every tracked file.
      // 尝试从源仓库播种临时索引（复用其 stat 缓存与 cache-tree）
      const copied = source
        ? yield* seedIndex(repository, source, temporary).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          )
        : false
      // 播种成功：改名就位；失败：直接删除旧索引（下次全量重建）
      yield* (
        copied ? fs.rename(temporary, indexFile(repository)) : fs.remove(indexFile(repository), { force: true })
      ).pipe(Effect.ignore, Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)))
    })

    // Stores created by earlier releases would otherwise keep their original settings; only OpenCode's include file is rewritten, never `config`.
    // 确保快照配置文件与当前版本一致（旧版本存储的配置需要补齐）；只重写 OpenCode 自己的片段文件，不动 config
    const ensureSnapshotConfig = Effect.fnUntraced(function* (repository: Repository) {
      // 读取现有配置片段
      const file = path.join(repository.gitDirectory, snapshotConfigFile)
      const current = yield* fs.readFileStringSafe(file).pipe(Effect.orElseSucceed(() => undefined))
      // 内容一致（或读不到时）无需处理
      if (current === undefined || current === snapshotConfig) return
      // Concurrent Git processes must never read a partially written file.
      // 先写临时文件再原子改名，避免并发 Git 进程读到半截文件
      const temporary = `${file}.${uniqueSuffix()}`
      yield* fs
        .writeFileString(temporary, snapshotConfig)
        .pipe(
          Effect.andThen(fs.rename(temporary, file)),
          Effect.ignore,
          Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
        )
    })

    // 生成临时索引路径：前缀 + 时间戳 + 唯一后缀
    const temporaryIndex = (repository: Repository) =>
      path.join(repository.gitDirectory, `${temporaryIndexPrefix}${Date.now()}-${uniqueSuffix()}`)

    /**
     * Temporary indexes left by killed processes. Age comes from the creation time in
     * the name, because a hard-linked index keeps the store index's old mtime; live
     * captures finish long before the cutoff.
     */
    // 清扫被杀死进程遗留的临时索引：年龄取文件名里的时间戳
    // （硬链接的索引保留了仓库索引的旧 mtime，不可靠）；存活捕获远早于截止线完成
    const sweepTemporaryIndexes = Effect.fnUntraced(function* (repository: Repository) {
      // 截止线：1 小时前
      const cutoff = Date.now() - 60 * 60 * 1000
      // 读取 git 目录条目（失败按空处理）
      const entries = yield* fs.readDirectory(repository.gitDirectory).pipe(Effect.orElseSucceed(() => []))
      // 删除前缀匹配且时间戳早于截止线的临时索引
      yield* Effect.forEach(
        entries.filter(
          (entry) =>
            entry.startsWith(temporaryIndexPrefix) &&
            Number(entry.slice(temporaryIndexPrefix.length).split("-")[0]) < cutoff,
        ),
        (entry) => fs.remove(path.join(repository.gitDirectory, entry), { force: true }).pipe(Effect.ignore),
        { discard: true },
      )
    })

    // 列出两棵树之间有差异的文件
    const treeFiles = Effect.fn("Git.tree.files")(function* (input: {
      repository: Repository
      from: TreeID
      to: TreeID
    }) {
      // Undo needs both paths of a rename, not only its destination.
      // 用 --no-renames：撤销时需要改名的两侧路径，而不只是目标路径
      return nuls(
        (yield* repositoryOperation("list_files", input.repository, [
          "diff",
          "--name-only",
          "--no-renames",
          "-z",
          input.from,
          input.to,
        ])).text,
      ).map((file) => RelativePath.make(file))
    })

    // 计算两棵树的差异（可限定路径、上下文行数）
    const treeDiff = Effect.fn("Git.tree.diff")(function* (input: {
      repository: Repository
      from: TreeID
      to: TreeID
      context?: number
      paths?: readonly RelativePath[]
    }) {
      // 显式空路径列表：直接返回空
      if (input.paths?.length === 0) return []
      // 把路径按命令行预算分组；未限定路径时只有一个空组（全树）
      const groups = input.paths ? pathGroups(input.paths) : [undefined]
      const diffs: FileDiff.Info[] = []
      // 补丁总字节预算
      let patchBudget = VcsPatch.MAX_TOTAL_PATCH_BYTES
      // 逐组计算，预算耗尽后不再取补丁
      for (const paths of groups) {
        const group = yield* diffGroup({ ...input, paths }, patchBudget)
        diffs.push(...group.diffs)
        patchBudget = group.truncated ? 0 : patchBudget - group.patchBytes
      }
      return diffs
    })

    // 单组路径的 diff：并行取 name-status / numstat / patch 三种输出并拼装
    const diffGroup = Effect.fnUntraced(function* (
      input: { repository: Repository; from: TreeID; to: TreeID; context?: number; paths?: readonly RelativePath[] },
      patchBudget: number,
    ) {
      // 公共参数：两棵树 + 限定路径
      const args = ["--no-renames", input.from, input.to, "--", ...(input.paths ?? [])]
      // Patch headers have no -z form: unquoted paths keep chunksByFile matching non-ASCII names.
      // 三条命令并行执行（补丁预算耗尽时跳过补丁）
      const [names, numbers, patch] = yield* Effect.all(
        [
          // 文件状态（-z 输出，NUL 分隔）
          repositoryOperation("diff", input.repository, [
            "--literal-pathspecs",
            "diff",
            "--name-status",
            "-z",
            ...args,
          ]),
          // 增删行统计
          repositoryOperation("diff", input.repository, ["--literal-pathspecs", "diff", "--numstat", "-z", ...args]),
          // 逐文件补丁（关闭外部 diff；限制输出字节）
          patchBudget > 0
            ? repositoryOperation(
                "diff",
                input.repository,
                [
                  "--literal-pathspecs",
                  "-c",
                  "core.quotepath=false",
                  "diff",
                  "--no-ext-diff",
                  `--unified=${input.context ?? 3}`,
                  ...args,
                ],
                { maxOutputBytes: patchBudget },
              )
            : Effect.succeed({ text: "", stderr: "", truncated: true }),
        ],
        { concurrency: 3 },
      )
      // 解析 name-status：偶数位是状态码，下一位是路径
      const statuses = nuls(names.text)
      const files = statuses.flatMap((code, index) => {
        const file = statuses[index + 1]
        if (index % 2 !== 0 || !file) return []
        return [
          {
            file: RelativePath.make(file),
            // A/D/其他 → added/deleted/modified
            status: code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified",
          } as const,
        ]
      })
      // 解析 numstat：增、删、路径（二进制文件显示 -）
      const stats = new Map(
        nuls(numbers.text).flatMap((line) => {
          const [additions, deletions, ...file] = line.split("\t")
          if (!additions || !deletions || file.length === 0) return []
          return [
            [
              file.join("\t"),
              additions === "-" || deletions === "-"
                ? { binary: true, additions: 0, deletions: 0 }
                : { binary: false, additions: Number(additions), deletions: Number(deletions) },
            ] as const,
          ]
        }),
      )
      // 把补丁按文件切块（路径用 name-status 的原样输出匹配）
      const patches = VcsPatch.chunksByFile(patch, (index) => files[index]?.file)
      return {
        // 组装每个文件的差异信息（二进制文件不带补丁文本）
        diffs: files.map((entry) => {
          const stat = stats.get(entry.file)
          return {
            ...entry,
            additions: stat?.additions ?? 0,
            deletions: stat?.deletions ?? 0,
            patch: stat?.binary ? "" : (patches.get(entry.file) ?? VcsPatch.emptyPatch(entry.file)),
          } satisfies FileDiff.Info
        }),
        // 本组补丁字节数与是否被截断
        patchBytes: Buffer.byteLength(patch.text),
        truncated: patch.truncated,
      }
    })

    // 查询树中是否存在某文件条目（ls-tree 单路径）
    const hasEntry = Effect.fnUntraced(function* (repository: Repository, tree: TreeID, file: RelativePath) {
      // 取 ls-tree 输出并去掉结尾 NUL
      const text = (yield* repositoryOperation("restore", repository, [
        "ls-tree",
        "-z",
        tree,
        "--",
        literalPathspec(file),
      ])).text.replace(/\0$/, "")
      // 空输出：条目不存在
      if (!text) return false
      // 输出格式非法：报错
      if (!/^\d+\s+\w+\s+[0-9a-f]+\t/.test(text))
        return yield* new OperationError({
          operation: "restore",
          directory: repository.worktree,
          message: `Invalid tree entry for ${file}`,
        })
      return true
    })

    // 从工作树删除文件/目录（失败包装为 restore 操作错误）
    const removePath = (repository: Repository, file: RelativePath) =>
      fs.remove(path.join(repository.worktree, file), { recursive: true, force: true }).pipe(
        Effect.mapError(
          (cause) =>
            new OperationError({
              operation: "restore",
              directory: repository.worktree,
              message: `Failed to remove ${file}`,
              cause,
            }),
        ),
      )

    // 在树中查找一批路径里实际存在的条目（ls-tree）
    const pathsInTree = Effect.fnUntraced(function* (
      repository: Repository,
      tree: TreeID,
      files: readonly RelativePath[],
    ) {
      // 全部路径转字面路径规格
      const pathspecs = files.map(literalPathspec)
      // 估算能否放进一条命令行
      const fits = pathspecs.reduce((length, pathspec) => length + pathspec.length + 1, 0) <= argumentBudget
      const result = yield* repositoryOperation(
        "restore",
        repository,
        // 装得下：按路径规格查询；装不下：递归列全树再过滤
        fits ? ["ls-tree", "-z", tree, "--", ...pathspecs] : ["ls-tree", "-r", "-t", "-z", "--full-tree", tree],
      )
      // 解析每条记录（模式 类型 哈希<TAB>路径）
      const listed = yield* Effect.forEach(nuls(result.text), (record) => {
        const match = /^\d+ \w+ [0-9a-f]+\t(.*)$/s.exec(record)
        if (match) return Effect.succeed(RelativePath.make(match[1]!))
        return Effect.fail(
          new OperationError({
            operation: "restore",
            directory: repository.worktree,
            message: `Invalid tree entry: ${record}`,
          }),
        )
      })
      return new Set(listed)
    })

    /** Batched paths cost one ls-tree and one checkout per source tree instead of two processes per file. */
    // 恢复文件到指定树的状态：可批量时每个源树一次 ls-tree + 一次 checkout；
    // 不可批量（路径含特殊字符）时逐文件处理
    const restore = Effect.fn("Git.tree.restore")(
      (input: { repository: Repository; files: ReadonlyMap<RelativePath, TreeID> }) =>
        locked(
          input.repository,
          Effect.gen(function* () {
            // 空输入直接返回
            if (!input.files.size) return
            // 路径不可批量：逐文件处理
            if (!canBatchRestore([...input.files.keys()]))
              return yield* Effect.forEach(
                input.files,
                ([file, tree]) =>
                  Effect.gen(function* () {
                    // 树中没有该文件：从工作树删除
                    if (!(yield* hasEntry(input.repository, tree, file)))
                      return yield* removePath(input.repository, file)
                    // 有该文件：在临时索引下 checkout 恢复
                    yield* withTemporaryIndex(input.repository, (index) =>
                      repositoryOperation(
                        "restore",
                        input.repository,
                        ["checkout", tree, "--", literalPathspec(file)],
                        {
                          index,
                        },
                      ),
                    )
                  }),
                { discard: true },
              )
            // 可批量：按源树分组路径
            const groups = new Map<TreeID, RelativePath[]>()
            input.files.forEach((tree, file) => groups.set(tree, [...(groups.get(tree) ?? []), file]))
            // 对每组查询树中实际存在的路径
            const plan = yield* Effect.forEach(groups, ([tree, files]) =>
              pathsInTree(input.repository, tree, files).pipe(
                Effect.map((present) => ({
                  tree,
                  present: files.filter((file) => present.has(file)),
                  absent: files.filter((file) => !present.has(file)),
                })),
              ),
            )
            // Checkouts go first, so one failing removal cannot stop the other files from being restored.
            // 先做检出（临时索引下按路径清单批量 checkout）
            const checkouts = plan.filter((item) => item.present.length)
            if (checkouts.length)
              yield* withTemporaryIndex(input.repository, (index) =>
                Effect.forEach(
                  checkouts,
                  (item) =>
                    repositoryOperation(
                      "restore",
                      input.repository,
                      ["checkout", item.tree, "--pathspec-from-file=-", "--pathspec-file-nul"],
                      { stdin: item.present.map(literalPathspec).join("\0") + "\0", index },
                    ),
                  { discard: true },
                ),
              )
            // 再删除树中不存在的文件（并发 16）
            yield* Effect.forEach(
              plan.flatMap((item) => item.absent),
              (file) => removePath(input.repository, file),
              { concurrency: 16, discard: true },
            )
          }),
        ),
    )

    /**
     * Snapshot trees have no refs, so Git's own repack and prune would treat every
     * snapshot as garbage. Packing instead hands pack-objects an explicit list of
     * every loose object (and, when combining, every object in the old packs), checks
     * the new index lists all of them, and only then deletes the loose copies and
     * the combined packs. Nothing is pruned, and objects are never delegated to the
     * source repository through alternates.
     */
    // 打包松散对象/合并小包：快照树没有引用，Git 自带的 repack/prune 会把它们当垃圾，
    // 因此显式给 pack-objects 一份对象清单（合并时含旧包内全部对象），
    // 校验新包索引齐全后才删除松散副本与被合并的包；绝不 prune，也绝不通过
    // alternates 把对象委托给源仓库
    const packObjects = Effect.fn("Git.objects.pack")(function* (repository: Repository) {
      // objects 与 pack 目录路径
      const objects = path.join(repository.gitDirectory, "objects")
      const packDirectory = path.join(objects, "pack")
      // 扫描松散对象与本地包
      const loose = yield* looseObjects(objects)
      const packs = yield* localPacks(packDirectory)
      // 包数达到阈值：合并所有包
      const combinePacks = packs.length >= packCountLimit
      // 都低于阈值：无事可做
      if (loose.length < looseObjectLimit && !combinePacks) return
      // 加跨进程打包锁执行
      yield* withPackLock(
        repository,
        Effect.gen(function* () {
          // 先清扫遗留的临时/孤儿包
          yield* sweepTemporaryPacks(packDirectory)
          // 合并模式：读取每个旧包索引里的全部对象 ID
          const combined = combinePacks
            ? yield* Effect.forEach(packs, (pack) =>
                packIndex(repository, path.join(packDirectory, `${pack}.idx`)).pipe(
                  Effect.map((oids) => ({ pack, oids })),
                ),
              )
            : []
          // 待打包对象全集（去重）：松散对象 + 旧包对象
          const objectIds = [...new Set([...loose.map((item) => item.oid), ...combined.flatMap((item) => item.oids)])]
          // 空集：结束
          if (!objectIds.length) return
          // 运行 pack-objects（限制线程与窗口内存），从 stdin 读对象清单
          const newPacks = (yield* repositoryOperation(
            "pack",
            repository,
            [
              "-c",
              "pack.threads=2",
              "-c",
              "pack.windowMemory=64m",
              "pack-objects",
              "-q",
              "--non-empty",
              path.join(packDirectory, "pack"),
            ],
            { stdin: objectIds.join("\n") + "\n" },
          )).text
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
          // 读取每个新包索引中的对象 ID
          const packedIds = new Set(
            (yield* Effect.forEach(newPacks, (name) =>
              packIndex(repository, path.join(packDirectory, `pack-${name}.idx`)),
            )).flat(),
          )
          // 校验无遗漏；有缺失则报错且不删任何东西
          const missing = objectIds.filter((oid) => !packedIds.has(oid))
          if (missing.length)
            return yield* new OperationError({
              operation: "pack",
              directory: repository.gitDirectory,
              message: `Packed ${packedIds.size} objects but ${missing.length} are missing; nothing was removed`,
            })
          // Deletion is quick and must not stop halfway, which could strand a pack without its index.
          // 不可中断地执行删除（半途而废会让包失去索引）
          yield* Effect.uninterruptible(
            Effect.gen(function* () {
              // 并发删除全部松散对象
              yield* Effect.forEach(loose, (item) => fs.remove(item.file, { force: true }).pipe(Effect.ignore), {
                concurrency: 16,
                discard: true,
              })
              // 新包名集合
              const newPackNames = new Set(newPacks.map((name) => `pack-${name}`))
              // 删除被合并的旧包（新写出的包除外）
              yield* Effect.forEach(
                combined.filter((item) => !newPackNames.has(item.pack)),
                (item) =>
                  // The index goes first so readers never see an index without its pack.
                  // 先删索引再删包：读者永远不会看到"有索引无包"的状态
                  Effect.forEach(
                    [".idx", ".pack", ".rev", ".bitmap", ".mtimes"],
                    (extension) =>
                      fs
                        .remove(path.join(packDirectory, `${item.pack}${extension}`), { force: true })
                        .pipe(Effect.ignore),
                    { discard: true },
                  ),
                { discard: true },
              )
            }),
          )
        }),
      )
    })

    // 扫描 objects 目录下的松散对象（2 位十六进制扇出子目录）
    const looseObjects = Effect.fnUntraced(function* (objects: string) {
      // 找出全部扇出目录
      const fanout = (yield* fs.readDirectory(objects).pipe(Effect.orElseSucceed(() => []))).filter((entry) =>
        /^[0-9a-f]{2}$/.test(entry),
      )
      // 并发扫描每个扇出目录（SHA-1 剩余 38 位或 SHA-256 剩余 62 位）
      const listed = yield* Effect.forEach(
        fanout,
        (prefix) =>
          fs.readDirectory(path.join(objects, prefix)).pipe(
            Effect.orElseSucceed(() => []),
            Effect.map((entries) =>
              entries
                .filter((entry) => /^[0-9a-f]{38}$|^[0-9a-f]{62}$/.test(entry))
                .map((entry) => ({ oid: prefix + entry, file: path.join(objects, prefix, entry) })),
            ),
          ),
        { concurrency: 16 },
      )
      // 摊平成对象列表
      return listed.flat()
    })

    // Packs with a .keep marker or a promisor file belong to someone else's policy and are left alone.
    // 列出本地可合并的包：带 .keep 或 .promisor 标记的包属于别人的策略，不动
    const localPacks = Effect.fnUntraced(function* (directory: string) {
      // 读取 pack 目录全部条目
      const entries = new Set(yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => [])))
      return [...entries]
        // 只看 pack-*.pack
        .filter((entry) => entry.startsWith("pack-") && entry.endsWith(".pack"))
        .map((entry) => entry.slice(0, -".pack".length))
        // 必须有索引，且没有 .keep/.promisor
        .filter(
          (pack) => entries.has(`${pack}.idx`) && !entries.has(`${pack}.keep`) && !entries.has(`${pack}.promisor`),
        )
    })

    // 读取包索引中的对象 ID：优先直接解析 v2 二进制，失败回退 show-index
    const packIndex = Effect.fnUntraced(function* (repository: Repository, file: string) {
      // 读取索引文件字节
      const bytes = yield* fs.readFile(file).pipe(
        Effect.mapError(
          (cause) =>
            new OperationError({
              operation: "pack",
              directory: repository.gitDirectory,
              message: `Failed to read ${file}`,
              cause,
            }),
        ),
      )
      // 直接解析成功：返回
      const parsed = packIndexObjectIDs(bytes)
      if (parsed) return parsed
      // 解析不了：用 git show-index 兜底
      const result = yield* repositoryOperation("pack", repository, ["show-index"], { stdin: bytes })
      return result.text.split("\n").flatMap((line) => {
        // 每行格式：偏移 对象ID 校验和…，取第二个字段
        const oid = line.split(" ")[1]
        return oid ? [oid] : []
      })
    })

    /**
     * pack-objects writes tmp_* files and renames them; leftovers mean a killed
     * process. A pack without its index is unreadable to Git, so removing one is
     * lossless; the age cutoff skips a pack whose index is still being renamed.
     */
    // 清扫临时/孤儿包：tmp_* 与没有索引的 pack（都意味着进程被杀）；
    // 1 小时年龄阈值可跳过索引仍在改名中的包
    const sweepTemporaryPacks = Effect.fnUntraced(function* (directory: string) {
      const cutoff = Date.now() - 60 * 60 * 1000
      const entries = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []))
      // 现存索引对应的包名集合
      const indexed = new Set(entries.filter((entry) => entry.endsWith(".idx")).map((entry) => entry.slice(0, -4)))
      yield* Effect.forEach(
        entries.filter(
          (entry) =>
            entry.startsWith("tmp_") ||
            (entry.startsWith("pack-") && entry.endsWith(".pack") && !indexed.has(entry.slice(0, -5))),
        ),
        (entry) =>
          fs.stat(path.join(directory, entry)).pipe(
            // 早于截止线才删除
            Effect.flatMap((info) =>
              (Option.getOrUndefined(info.mtime)?.getTime() ?? 0) < cutoff
                ? fs.remove(path.join(directory, entry), { force: true })
                : Effect.void,
            ),
            Effect.ignore,
          ),
        { discard: true },
      )
    })

    // Cross-process exclusion: concurrent packing would stay lossless but duplicate work and objects.
    // 跨进程打包锁：并发打包虽仍无损但会重复劳动与对象。
    // 用 wx 独占写锁文件（内容为 PID）；锁超过 1 小时视为过期先删；拿不到锁直接跳过
    const withPackLock = <A, E, R>(repository: Repository, effect: Effect.Effect<A, E, R>) => {
      // 锁文件路径
      const file = path.join(repository.gitDirectory, "opencode-pack.lock")
      return Effect.gen(function* () {
        // 检查现有锁是否过期
        const stale = yield* fs.stat(file).pipe(
          Effect.map((info) => (Option.getOrUndefined(info.mtime)?.getTime() ?? 0) < Date.now() - 60 * 60 * 1000),
          Effect.orElseSucceed(() => false),
        )
        // 过期锁：删除
        if (stale) yield* fs.remove(file, { force: true }).pipe(Effect.ignore)
        // 尝试独占创建锁文件
        const acquired = yield* fs.writeFileString(file, String(process.pid), { flag: "wx" }).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        )
        // 拿不到锁：放弃本次打包（无害）
        if (!acquired) return
        // 持锁执行，无论成败都删除锁文件
        yield* effect.pipe(Effect.ensuring(fs.remove(file, { force: true }).pipe(Effect.ignore)))
      })
    }

    // 运行 worktree 子命令：统一错误映射（识别"需要 force"的脏工作树）
    const worktreeRun = Effect.fnUntraced(function* (
      operation: "create" | "remove" | "list",
      repository: Repository,
      args: string[],
      worktreeDirectory?: AbsolutePath,
      cwd = repository.worktree,
    ) {
      const result = yield* proc
        .run(ChildProcess.make(gitExecutable(), args, { cwd, extendEnv: true, stdin: "ignore" }))
        .pipe(
          Effect.mapError(
            (cause) => new WorktreeError({ operation, directory: worktreeDirectory, message: cause.message, cause }),
          ),
        )
      // 退出码 0：返回 stdout 文本
      if (result.exitCode === 0) return result.stdout.toString("utf8")
      // 组装错误消息（stderr 优先）
      const message = result.stderr.toString("utf8").trim() || result.stdout.toString("utf8").trim() || "Git failed"
      return yield* new WorktreeError({
        operation,
        directory: worktreeDirectory,
        message,
        // remove 失败且消息提示脏工作树：标记需要 --force
        forceRequired: operation === "remove" && /contains modified or untracked files|is dirty/i.test(message),
      })
    })

    // 创建链接工作树（分离 HEAD，避免占用分支）
    const worktreeCreate = Effect.fn("Git.worktree.create")(function* (input: {
      repository: Repository
      directory: AbsolutePath
      ref?: string
    }) {
      yield* worktreeRun(
        "create",
        input.repository,
        ["worktree", "add", "--detach", "--", input.directory, input.ref ?? "HEAD"],
        input.directory,
      )
      // 创建后 discover 验证可打开
      const repository = yield* discover(input.directory)
      if (repository) return repository
      return yield* new WorktreeError({
        operation: "create",
        directory: input.directory,
        message: "Created worktree could not be opened",
      })
    })

    // 移除工作树（在公共目录执行，可强制）
    const worktreeRemove = Effect.fn("Git.worktree.remove")(function* (input: {
      repository: Repository
      directory: AbsolutePath
      force: boolean
    }) {
      yield* worktreeRun(
        "remove",
        input.repository,
        ["worktree", "remove", ...(input.force ? ["--force"] : []), input.directory],
        input.directory,
        input.repository.commonDirectory,
      )
    })

    // 列出全部工作树（porcelain 输出解析）
    const worktreeList = Effect.fn("Git.worktree.list")(function* (repository: Repository) {
      return (yield* worktreeRun("list", repository, ["worktree", "list", "--porcelain"]))
        .split("\n")
        // 只取 worktree 行
        .filter((line) => line.startsWith("worktree "))
        .map(
          (line, index) =>
            new Worktree({
              // 第一条是主工作树，其余是链接工作树
              directory: AbsolutePath.make(resolvePath(repository.worktree, line.slice("worktree ".length).trim())),
              kind: index === 0 ? "main" : "linked",
            }),
        )
    })

    // 暴露服务实现（按接口分组）
    return Service.of({
      repo: { discover, fingerprint, clone, create },
      remote: { get: remote },
      history: { head, branch, defaultRemoteBranch: remoteHead, rootCommits: roots },
      sync: { fetchRemotes: fetch, fetchBranch, checkoutRemoteBranch: checkout, resetHard: reset },
      worktree: { create: worktreeCreate, remove: worktreeRemove, list: worktreeList },
      index: { refresh, ignored },
      tree: {
        capture: captureTree,
        write: (repository) => writeTree(repository),
        files: treeFiles,
        diff: treeDiff,
        restore,
      },
      objects: { pack: packObjects },
    })
  }),
)

// 注册为全局节点（Git 服务不绑定目录），依赖文件系统工具与进程服务节点
export const node = makeGlobalNode({ service: Service, layer: layer, deps: [FSUtil.node, AppProcess.node] })

// 简单命令结果：退出码 + stdout 文本 + stderr 文本
interface Result {
  readonly exitCode: number
  readonly text: string
  readonly stderr: string
}

// 仓库命令选项：stdin、环境变量、输出上限与自定义索引文件
interface RepositoryOptions {
  readonly stdin?: string | Uint8Array
  readonly env?: Record<string, string>
  readonly maxOutputBytes?: number
  readonly index?: string
}

// 错误工厂：进程启动失败 → OperationError（柯里化）
function spawnFailure(operation: OperationError["operation"], directory: AbsolutePath) {
  return (cause: { readonly message: string }) =>
    new OperationError({ operation, directory, message: cause.message, cause })
}

// 错误工厂：非零退出 → OperationError（消息取 stderr，退而取 stdout）
function commandFailure(
  operation: OperationError["operation"],
  directory: AbsolutePath,
  result: { readonly text: string; readonly stderr: string },
) {
  return new OperationError({
    operation,
    directory,
    message: result.stderr.trim() || result.text.trim() || `Git ${operation} failed`,
  })
}

// 容错版执行：任何失败（含启动失败）都按"退出码 1、空输出"处理
function run(cwd: string, proc: AppProcess.Interface, args: string[]) {
  return execute(cwd, proc, args).pipe(Effect.orElseSucceed(() => ({ exitCode: 1, text: "", stderr: "" })))
}

// 执行 git 命令并收集 stdout/stderr 文本
function execute(cwd: string, proc: AppProcess.Interface, args: string[]) {
  return proc
    .run(
      ChildProcess.make(gitExecutable(), args, {
        cwd,
        extendEnv: true,
        stdin: "ignore",
      }),
    )
    .pipe(
      Effect.map(
        (result) =>
          ({
            exitCode: result.exitCode,
            text: result.stdout.toString("utf8"),
            stderr: result.stderr.toString("utf8"),
          }) satisfies Result,
      ),
    )
}

/** Split NUL-terminated git output into its records. */
// 按 NUL 切分 git 的 -z 输出并去掉空记录
function nuls(text: string) {
  return text.split("\0").filter(Boolean)
}

/** Pathspec magic that matches exactly one path, so names with `*`, `?`, `[`, or a leading `:` are not patterns. */
// 给路径加 :(literal) 前缀：含 * ? [ 或前导 : 的文件名不会被当作通配模式
function literalPathspec(file: string) {
  return `:(literal)${file}`
}

/**
 * Paths whose restore operations commute: none inside another, and every segment
 * printable ASCII that no platform rewrites. Git precomposes Unicode, filesystems
 * may fold case, and Windows drops trailing dots and spaces and treats `\` and
 * `:` specially, so anything else takes the ordered path.
 */
// 判断一批路径能否批量恢复：互相之间无嵌套，且每段都是任何平台都不会改写的
// 可打印 ASCII（Git 预组合 Unicode、文件系统可能折叠大小写、Windows 会丢弃
// 结尾的点/空格并特殊对待 \ 与 :），否则走逐个有序路径
function canBatchRestore(files: readonly string[]) {
  // 每段必须全为可打印 ASCII、不含 \ 与 :、不以点或空格结尾
  const canonical = files.every((file) =>
    file.split("/").every((part) => /^[\x20-\x7e]+$/.test(part) && !/[\\:]/.test(part) && !/[. ]$/.test(part)),
  )
  if (!canonical) return false
  // 大小写折叠后不得有重名（防大小写不敏感文件系统冲突）
  const folded = new Set(files.map((file) => file.toLowerCase()))
  if (folded.size !== files.length) return false
  // 任何路径不得是另一路径的祖先目录
  return files.every((file) => {
    const parts = file.toLowerCase().split("/")
    return parts.slice(1).every((_, index) => !folded.has(parts.slice(0, index + 1).join("/")))
  })
}

/**
 * Object IDs from a version 2 pack index: magic, version, a 256-entry fan-out
 * table whose last entry is the object count, then the sorted IDs. Returns
 * undefined for version 1 indexes and for packs with 64-bit offsets (over 2 GiB),
 * whose hash length this size check cannot derive.
 */
// 直接解析 v2 包索引的对象 ID：魔数、版本、256 项扇出表（末项为对象数）、
// 排序的 ID 数组。v1 索引与 64 位偏移（超 2GiB）的包返回 undefined
function packIndexObjectIDs(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // 至少要装下头部与扇出表；魔数 \377tOc 与版本 2 校验
  if (bytes.length < 1032 || view.getUint32(0) !== 0xff744f63 || view.getUint32(4) !== 2) return undefined
  // 从扇出表末项取对象总数
  const count = view.getUint32(8 + 255 * 4)
  // 由总大小反推哈希长度（20=SHA-1，32=SHA-256）
  const hash = (bytes.length - 1032 - 8 * count) / (count + 2)
  if (hash !== 20 && hash !== 32) return undefined
  // 逐个切出对象 ID 并转十六进制
  return Array.from({ length: count }, (_, index) =>
    Buffer.from(bytes.subarray(1032 + index * hash, 1032 + (index + 1) * hash)).toString("hex"),
  )
}

/**
 * Groups are sorted like Git's output, so groups of file paths concatenate in the
 * order one call prints them. Each path is counted with room for the quotes Windows
 * adds around spaces.
 */
// 把路径按字节序排序并装入不超过命令行预算的组（与 Git 输出顺序一致，
// 使各组的输出可按序拼接）；每项预算 +3，为 Windows 给含空格路径加的引号留位
function pathGroups(paths: readonly RelativePath[]) {
  return paths
    .toSorted((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
    .reduce<{ groups: RelativePath[][]; length: number }>(
      (state, file) => {
        // 本项的开销
        const cost = file.length + 3
        // 当前组还装得下：放进去
        const current = state.groups.at(-1)
        if (current && state.length + cost <= argumentBudget) {
          current.push(file)
          return { groups: state.groups, length: state.length + cost }
        }
        // 装不下：开新组
        return { groups: [...state.groups, [file]], length: cost }
      },
      { groups: [], length: 0 },
    ).groups
}

// 生成唯一后缀：进程号 + 随机串
function uniqueSuffix() {
  return `${process.pid}-${Math.random().toString(36).slice(2)}`
}

// 规整 git 输出的路径：去行尾换行、转换 Windows 路径分隔符、判断绝对/相对
function resolvePath(cwd: string, value: string) {
  const trimmed = value.replace(/[\r\n]+$/, "")
  // 空值退回当前目录
  if (!trimmed) return cwd
  const normalized = FSUtil.windowsPath(trimmed)
  // 绝对路径直接规整；相对路径基于 cwd 解析
  if (path.isAbsolute(normalized)) return path.normalize(normalized)
  return path.resolve(cwd, normalized)
}
