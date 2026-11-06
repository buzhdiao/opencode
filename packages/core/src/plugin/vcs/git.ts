// 将本模块以命名空间 `VcsGitPlugin` 全量导出
export * as VcsGitPlugin from "./git.js"

// 引入随机 UUID 生成器，用于创建临时文件名
import { randomUUID } from "crypto"
// 引入 Promise 风格的文件系统 API
import fs from "fs/promises"
// 引入 os 模块（读取临时目录）
import os from "os"
// 引入 path 模块做路径拼接与相对路径计算
import path from "path"
// 引入插件定义工具 define
import { define } from "@opencode/plugin/effect/plugin"
// 引入 Effect 原语
import { Effect } from "effect"
// 引入子进程 Effect 构造器
import { ChildProcess } from "effect/process"
// 引入文件差异（FileDiff）schema
import { FileDiff } from "@opencode/schema/file-diff"
// 引入版本控制相关 schema：Base（审查基线）、BranchList、FileStatus、Info、Mode
import { Base, BranchList, FileStatus, Info, Mode } from "@opencode/schema/vcs"
// 引入应用进程服务（AppProcess）：受控地运行外部命令
import { AppProcess } from "@opencode/util/process"
// 引入 Location 服务：提供工作目录与项目信息
import { Location } from "../../location.js"
// 引入 VCS 适配器相关类型（仅类型导入）
import type { Adapter, BranchOptions, DiffOptions, Untracked } from "../../vcs.js"
// 引入差异错误类型 DiffError
import { DiffError } from "../../vcs.js"
// 引入 git 可执行文件解析函数
import { gitExecutable } from "../../util/git-executable.js"
// 引入补丁（patch）处理工具：按文件切块、空补丁、字节上限常量、上下文行数、补丁切分
import {
  chunksByFile,
  emptyPatch,
  MAX_PATCH_BYTES,
  MAX_TOTAL_PATCH_BYTES,
  PATCH_CONTEXT_LINES,
  splitGitPatch,
} from "../../vcs/patch.js"
// 引入 Patch 类型（仅类型导入）
import type { Patch } from "../../vcs/patch.js"

// 定义 Git 版本控制插件：向 VCS 注册表注册 Git 适配器
export const Plugin = define({
  // 插件唯一标识
  id: "opencode.vcs.git",
  // 插件副作用主体
  effect: Effect.fn("VcsGitPlugin")(function* (ctx) {
    // 获取 Location 服务（工作目录上下文）
    const location = yield* Location.Service
    // Markerless locations need this definition to initialize their first repository.
    // 已声明其他 VCS 类型的 Location 直接退出；无标记（markerless）的 Location 需要本定义来初始化首个仓库
    if (location.vcs && location.vcs.type !== "git") return

    // 获取进程服务实例
    const processes = yield* AppProcess.Service
    // 构建 Git 适配器：作用于 Location 目录，工作树为项目目录
    const adapter = make(processes, {
      directory: location.directory,
      worktree: location.project.directory,
    })

    // 向 VCS 注册表添加 Git 适配器条目
    yield* ctx.vcs.transform((editor) => {
      editor.add({
        // 适配器 id
        id: "git",
        // 显示名称
        name: "Git",
        // init：在工作树中初始化 Git 仓库
        init: (input) =>
          Effect.gen(function* () {
            // 运行 `git init`
            const result = yield* processes.run(
              ChildProcess.make(gitExecutable(), ["init"], { cwd: input.worktree, stdin: "ignore" }),
            )
            // 退出码非 0 视为初始化失败
            if (result.exitCode !== 0) return yield* Effect.fail(new Error("Git initialization failed"))
          }),
        // info：返回当前分支与默认分支信息
        info: () => adapter.info(),
        // base：解析审查基线
        base: () => adapter.base(),
        // branches：列出分支（带搜索与数量限制）
        branches: (input) => adapter.branches({ search: input.search, limit: input.limit }),
        // status：返回文件状态列表
        status: () => adapter.status(),
        // diff：按模式与选项返回差异
        diff: (input) =>
          adapter.diff(input.mode, { context: input.context, base: input.base, untracked: input.untracked }),
      })
    })
  }),
})

/**
 * Git adapter for the Vcs service. Ported from the V1 pipeline: patches are
 * batched through one `git diff` invocation where possible and capped by
 * per-file and total byte budgets, falling back to empty patches when capped.
 */
// 构建 Git 适配器对象：封装 info/base/branches/status/diff 五个操作
function make(proc: AppProcess.Interface, input: { directory: string; worktree: string }) {
  // Listing commands scope pathspecs to the requested directory; per-file
  // commands run from the worktree root because git lists root-relative paths.
  // 列举类命令把 pathspec 限定到请求目录；单文件命令从工作树根运行，因为 git 返回的是根相对路径
  const ctx: Ctx = { proc, git: makeGit(proc), directory: input.directory, worktree: input.worktree }

  // 返回满足 Adapter 接口的实现
  return {
    // info：并行获取当前分支与默认分支
    info: Effect.fn("VcsGit.info")(function* () {
      // 并发执行两个查询：当前分支名与默认分支
      const [current, root] = yield* Effect.all([ctx.git.branch(ctx.directory), ctx.git.defaultBranch(ctx.directory)], {
        concurrency: 2,
      })
      // 组装 Info 结果（默认分支可能不存在）
      return { branch: { current, default: root?.name } } satisfies Info
    }),
    // base：直接委托 git 操作解析审查基线
    base: () => ctx.git.base(ctx.directory),
    // branches：委托列出分支
    branches: Effect.fn("VcsGit.branches")(function* (options?: BranchOptions) {
      return yield* ctx.git.branches(ctx.directory, options)
    }),
    // status：合并状态列表与行数统计
    status: Effect.fn("VcsGit.status")(function* () {
      // 取 git 操作集
      const git = ctx.git
      // 仓库有提交记录则以 HEAD 为参照，否则无参照
      const ref = (yield* git.hasHead(ctx.directory)) ? "HEAD" : undefined
      // 并发获取状态列表与（有 HEAD 时的）行数统计
      const [list, stats] = yield* Effect.all(
        [
          statusItems(ctx).pipe(Effect.map((result) => result.list)),
          ref ? git.stats(ctx.directory, ref) : Effect.succeed([] as Stat[]),
        ],
        { concurrency: 2 },
      )
      // 把统计结果转为 file -> 增删行数的映射
      const map = nums(stats)
      // 对"新增"状态但统计中缺失的文件，批量预取未跟踪文件的统计
      const untracked = yield* untrackedBatch(
        ctx,
        list.filter((item) => item.status === "added" && !map.has(item.file)).map((item) => item.file),
      )
      // 按文件名排序逐项组装 FileStatus
      return yield* Effect.forEach(
        list.toSorted((a, b) => a.file.localeCompare(b.file)),
        (item) =>
          Effect.gen(function* () {
            // 统计来源优先级：diff 统计 -> 批量预取 -> 单文件查询（仅"新增"）
            const stat =
              map.get(item.file) ??
              (item.status === "added"
                ? (untracked.stats.get(item.file) ?? (yield* git.statUntracked(ctx.worktree, item.file)))
                : undefined)
            // 组装单条文件状态（无统计时增删为 0）
            return {
              file: item.file,
              additions: stat?.additions ?? 0,
              deletions: stat?.deletions ?? 0,
              status: item.status,
            } satisfies FileStatus
          }),
      )
    }),
    // diff：按模式（working/committed/staged）返回差异
    diff: Effect.fn("VcsGit.diff")(function* (mode: Mode, options?: DiffOptions) {
      // 取 git 操作集
      const git = ctx.git
      // working 模式：对比工作区与 HEAD（无 HEAD 时为纯未跟踪）
      if (mode === "working") {
        return yield* track(ctx, (yield* git.hasHead(ctx.directory)) ? "HEAD" : undefined, options)
      }

      // 仓库无任何提交：committed 模式返回空；staged 模式按纯未跟踪处理
      if (!(yield* git.hasHead(ctx.directory))) {
        return mode === "committed" ? [] : yield* track(ctx, undefined, options)
      }
      // 审查基线：优先显式指定，否则取默认分支引用
      const base = options?.base ?? (yield* git.defaultBranch(ctx.directory))?.ref
      // 计算基线与 HEAD 的合并基准（merge base）
      const ref = base ? yield* git.mergeBase(ctx.directory, base) : undefined
      // 无合并基准时报错
      if (!ref) {
        return yield* new DiffError({
          message: base ? `No merge base available for ${base}` : "No review base available",
        })
      }
      // 与合并基准对比：committed 模式对比到 HEAD，staged 模式对比到工作区
      return yield* diffAgainstRef(ctx, ref, { ...options, target: mode === "committed" ? "HEAD" : undefined })
    }),
  } satisfies Adapter
}

// 文件状态种类（沿用 FileStatus 的 status 联合类型）
type Kind = FileStatus["status"]

// 单条变更条目：文件路径、git 状态码、归一化状态
interface Item {
  // 文件路径
  readonly file: string
  // 原始 git 状态码（如 "??", "M "）
  readonly code: string
  // 归一化后的状态
  readonly status: Kind
}

// 行数统计：单文件的增删行数
interface Stat {
  // 文件路径
  readonly file: string
  // 新增行数
  readonly additions: number
  // 删除行数
  readonly deletions: number
}

// Git 差异选项：扩展 DiffOptions，允许 target 指定为 HEAD
interface GitDiffOptions extends DiffOptions {
  // target：差异的终点（HEAD 或省略表示工作区）
  readonly target?: "HEAD"
}

// 补丁选项：在差异选项之上增加输出字节上限
interface PatchOptions extends GitDiffOptions {
  // 最大输出字节数
  readonly maxOutputBytes?: number
}

// 上下文对象：封装进程服务、git 操作集与两个工作目录
interface Ctx {
  // 进程服务
  readonly proc: AppProcess.Interface
  // git 操作集
  readonly git: GitOps
  // 请求的作用目录（pathspec 限定用）
  readonly directory: string
  // 工作树根目录
  readonly worktree: string
}

// git 操作集类型：makeGit 的返回类型
type GitOps = ReturnType<typeof makeGit>

// 统一的 git 命令前置配置：避免可选锁、关闭换行转换/文件监控、启用长路径与符号链接、关闭路径引号转义
const cfg = [
  "--no-optional-locks",
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.longpaths=true",
  "-c",
  "core.symlinks=true",
  "-c",
  "core.quotepath=false",
] as const

// 把 git 两字符状态码归一化为 Kind
const kind = (code: string): Kind => {
  // "??" 表示未跟踪文件 -> 新增
  if (code === "??") return "added"
  // 含 U（未合并/冲突）按修改处理
  if (code.includes("U")) return "modified"
  // 含 A 且不含 D -> 新增
  if (code.includes("A") && !code.includes("D")) return "added"
  // 含 D 且不含 A -> 删除
  if (code.includes("D") && !code.includes("A")) return "deleted"
  // 其余情况按修改处理
  return "modified"
}

// 按空字符切分 git -z 输出，并过滤空段
const nuls = (text: string) => text.split("\0").filter(Boolean)

// 解析 `git diff --numstat -z` 输出为 Stat 列表
const numstat = (text: string) =>
  nuls(text).flatMap((item) => {
    // 第一个制表符前是新增行数
    const a = item.indexOf("\t")
    // 第二个制表符前是删除行数
    const b = item.indexOf("\t", a + 1)
    // 两个制表符缺任一则跳过该段
    if (a === -1 || b === -1) return []
    // 最后一段是文件路径
    const file = item.slice(b + 1)
    // 路径为空则跳过
    if (!file) return []
    // 组装单条统计
    return [{ file, additions: count(item.slice(0, a)), deletions: count(item.slice(a + 1, b)) } satisfies Stat]
  })

// 解析 numstat 中的计数：二进制文件显示 "-" 记 0，非法值也记 0
const count = (value: string) => {
  // 解析计数值
  const parsed = value === "-" ? 0 : Number.parseInt(value || "0", 10)
  // 仅返回有限数字
  return Number.isFinite(parsed) ? parsed : 0
}

// 构建底层 git 操作集：封装常用 git 子命令的执行与解析
function makeGit(proc: AppProcess.Interface, env?: Record<string, string>) {
  // 基础运行函数：执行 git 命令并返回退出码、stdout 文本与是否被截断
  const run = Effect.fnUntraced(
    function* (args: string[], opts: { cwd: string; maxOutputBytes?: number }) {
      // 运行子进程：附带统一配置与环境变量（可扩展）
      const result = yield* proc.run(
        ChildProcess.make(gitExecutable(), [...cfg, ...args], {
          cwd: opts.cwd,
          env,
          extendEnv: true,
          stdin: "ignore",
        }),
        { maxOutputBytes: opts.maxOutputBytes },
      )
      // 返回结果对象：退出码、惰性取文本函数、截断标记
      return {
        exitCode: result.exitCode,
        text: () => result.stdout.toString("utf8"),
        truncated: result.stdoutTruncated || result.stderrTruncated,
      }
    },
    // 进程启动失败时退化为"失败退出码 + 空文本"而不是中断
    Effect.orElseSucceed(() => ({ exitCode: 1, text: () => "", truncated: false })),
  )

  // text：运行命令并直接返回 stdout 文本
  const text = Effect.fnUntraced(function* (args: string[], opts: { cwd: string }) {
    return (yield* run(args, opts)).text()
  })

  // lines：运行命令并按行拆分（去空白、去空行）
  const lines = Effect.fnUntraced(function* (args: string[], opts: { cwd: string }) {
    return (yield* text(args, opts))
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean)
  })

  // configured：读取 git 配置的 init.defaultBranch，且仅当该分支确实存在时返回
  const configured = Effect.fnUntraced(function* (cwd: string, list: string[]) {
    // 读取配置值
    const result = yield* run(["config", "init.defaultBranch"], { cwd })
    // 取配置名
    const name = result.text().trim()
    // 名称为空或分支不存在则返回 undefined
    if (!name || !list.includes(name)) return
    // 返回名称与引用（相同字符串）
    return { name, ref: name }
  })

  // primary：选择"主"远程（origin 优先，其次唯一远程，再次 upstream，最后取第一个）
  const primary = Effect.fnUntraced(function* (cwd: string) {
    // 列出全部远程
    const list = yield* lines(["remote"], { cwd })
    // 有 origin 则用 origin
    if (list.includes("origin")) return "origin"
    // 只有一个远程则直接用
    if (list.length === 1) return list[0]
    // 有 upstream 则用 upstream
    if (list.includes("upstream")) return "upstream"
    // 兜底取第一个远程
    return list[0]
  })

  // branch：读取当前分支名
  const branch = Effect.fn("VcsGit.branch")(function* (cwd: string) {
    // 查询 HEAD 的符号引用短名
    const result = yield* run(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd })
    // 失败（如 detached HEAD）返回 undefined
    if (result.exitCode !== 0) return
    // 返回去除空白的分支名
    return result.text().trim() || undefined
  })

  // branches：列出本地与远程分支名（可搜索、限量）
  const branches = Effect.fn("VcsGit.branches")(function* (cwd: string, options?: BranchOptions) {
    // 归一化搜索词：去空白并转小写
    const search = options?.search?.trim().toLowerCase()
    // `refname:short` collapses `refs/remotes/<remote>/HEAD` to the bare remote name, so strip the namespace
    // instead. Search and limit apply here because ref globs cannot cross `/` and `--count` precedes the filter.
    // refname:short 会把 remote HEAD 折叠成裸远程名，因此改用 lstrip 剥离命名空间；搜索与限量在过滤阶段生效，因为 ref 通配不能跨 "/" 且 --count 在过滤之前生效
    return (yield* lines(
      [
        "for-each-ref",
        "--sort=refname",
        "--sort=-committerdate",
        "--format=%(refname:lstrip=2)",
        "refs/heads",
        "refs/remotes",
      ],
      { cwd },
    ))
      // 过滤掉 remote HEAD 条目并应用搜索匹配
      .filter((item) => !item.endsWith("/HEAD") && (!search || item.toLowerCase().includes(search)))
      // 应用数量限制
      .slice(0, options?.limit) satisfies BranchList
  })

  // defaultBranch：推断默认分支（远程 HEAD -> 配置 -> main/master 约定）
  const defaultBranch = Effect.fn("VcsGit.defaultBranch")(function* (cwd: string) {
    // 找主远程
    const remote = yield* primary(cwd)
    // 若存在远程：优先读取 remote HEAD
    if (remote) {
      // 查询远程 HEAD 符号引用
      const head = yield* run(["symbolic-ref", `refs/remotes/${remote}/HEAD`], { cwd })
      // 查询成功则解析分支名
      if (head.exitCode === 0) {
        // 去掉 refs/remotes/ 前缀
        const ref = head
          .text()
          .trim()
          .replace(/^refs\/remotes\//, "")
        // 剥离远程名前缀得到分支名
        const name = ref.startsWith(`${remote}/`) ? ref.slice(`${remote}/`.length) : ""
        // 有名称则返回
        if (name) return { name, ref }
      }
    }

    // 列出本地分支，尝试配置的默认分支
    const list = yield* lines(["for-each-ref", "--format=%(refname:lstrip=2)", "refs/heads"], { cwd })
    // 配置分支存在则返回
    const next = yield* configured(cwd, list)
    // 已有结果直接返回
    if (next) return next
    // 退回 main
    if (list.includes("main")) return { name: "main", ref: "main" }
    // 再退回 master
    if (list.includes("master")) return { name: "master", ref: "master" }
  })

  // resolve：把引用解析为完整的提交哈希
  const resolve = Effect.fnUntraced(function* (cwd: string, ref: string) {
    // rev-parse 验证引用必须是提交
    const result = yield* run(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], { cwd })
    // 解析失败返回 undefined
    if (result.exitCode !== 0) return
    // 返回完整哈希
    return result.text().trim() || undefined
  })

  // ancestor：判断提交是否为指定引用的祖先
  const ancestor = Effect.fnUntraced(function* (cwd: string, commit: string, ref: string) {
    // 提交哈希格式校验（40~64 位十六进制），防止注入任意参数
    if (!/^[a-f0-9]{40,64}$/.test(commit)) return false
    // merge-base --is-ancestor 退出码 0 表示是祖先
    return (yield* run(["merge-base", "--is-ancestor", commit, ref], { cwd })).exitCode === 0
  })

  // namedRef：验证输入是"具名分支"并给出短名与完整引用
  const namedRef = Effect.fnUntraced(function* (cwd: string, input: string) {
    // Creation hints must identify a branch, not HEAD, an object ID, or a revision expression.
    // 分支创建线索必须指向分支，而非 HEAD、对象 ID 或修订表达式
    if (input === "HEAD" || input.endsWith("/HEAD") || /[~^:@{}\s]/.test(input)) return
    // 解析符号全名
    const ref = (yield* text(["rev-parse", "--symbolic-full-name", "--verify", "--end-of-options", input], {
      cwd,
    })).trim()
    // 要求 refs/heads/ 或 refs/remotes/ 下的真实引用，且能解析为提交
    if (!/^refs\/(heads|remotes)\/.+/.test(ref) || ref.endsWith("/HEAD") || !(yield* resolve(cwd, ref))) return
    // 返回短名（去掉 heads/ 或 remote 前缀）与完整引用
    return { name: ref.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\/[^/]+\//, ""), ref }
  })

  // base：推断审查基线（优先 reflog 中的分支创建来源，退回默认分支）
  const base = Effect.fn("VcsGit.base")(function* (cwd: string) {
    // 仓库没有任何提交则无基线
    if (!(yield* hasHead(cwd))) return null
    // 当前分支名
    const current = yield* branch(cwd)
    // 无分支（detached）要求用户选择基线
    if (!current) return yield* new DiffError({ message: "Choose a review base" })
    // 读取当前分支 reflog（最多 256 条，哈希与说明以 NUL 分隔）
    const history = (yield* lines(
      ["reflog", "show", "--max-count=256", "--format=%H%x00%gs", `refs/heads/${current}`],
      {
        cwd,
      },
    )).flatMap((line) => {
      // 解析"哈希\0说明"格式的每一行
      const match = /^([a-f0-9]+)\0(.+)$/.exec(line)
      // 匹配成功则产出条目
      return match ? [{ commit: match[1], message: match[2] }] : []
    })
    // 检查分支是否发生过重命名（重命名的创建记录不可靠）
    const renamed = history.some((entry) => entry.message.startsWith("Branch: renamed "))
    // 找到分支创建记录（"branch: Created from ..."）
    const creation = renamed ? undefined : history.find((entry) => entry.message.startsWith("branch: Created from "))
    // 提取创建来源字符串
    const origin = creation?.message.slice("branch: Created from ".length)
    // 若有创建记录：尝试验证其为可用基线
    if (creation && origin) {
      // 把来源解析为具名分支
      const candidate = yield* namedRef(cwd, origin)
      // 候选有效、不是当前分支、且该提交同时是 HEAD 与候选引用的祖先时采用
      if (
        candidate &&
        candidate.name !== current &&
        (yield* ancestor(cwd, creation.commit, "HEAD")) &&
        (yield* ancestor(cwd, creation.commit, candidate.ref))
      ) {
        // 返回 reflog 来源的基线
        return { ...candidate, source: "reflog" } satisfies Base
      }
    }
    // 退回默认分支
    const root = yield* defaultBranch(cwd)
    // 无默认分支或当前分支就是默认分支时无法提供基线
    if (!root || current !== root.name) return yield* new DiffError({ message: "Choose a review base" })
    // 把默认分支解析为具名引用
    const candidate = yield* namedRef(cwd, root.ref)
    // 解析失败报错
    if (!candidate) return yield* new DiffError({ message: "The default review base is unavailable" })
    // 返回默认来源的基线
    return { name: root.name, ref: candidate.ref, source: "default" } satisfies Base
  })

  // hasHead：判断仓库是否已有任何提交
  const hasHead = Effect.fn("VcsGit.hasHead")(function* (cwd: string) {
    // rev-parse 验证 HEAD 是否存在
    const result = yield* run(["rev-parse", "--verify", "HEAD"], { cwd })
    // 退出码 0 表示存在
    return result.exitCode === 0
  })

  // mergeBase：计算基线与 HEAD 的合并基准提交
  const mergeBase = Effect.fn("VcsGit.mergeBase")(function* (cwd: string, base: string) {
    // 先把基线解析为提交哈希
    const ref = yield* resolve(cwd, base)
    // 解析失败则放弃
    if (!ref) return
    // 运行 merge-base
    const result = yield* run(["merge-base", ref, "HEAD"], { cwd })
    // 失败返回 undefined
    if (result.exitCode !== 0) return
    // 返回合并基准哈希
    return result.text().trim() || undefined
  })

  // status：列出变更文件（porcelain v1 -z 格式）
  const status = Effect.fn("VcsGit.statusNames")(function* (
    cwd: string,
    untracked: "normal" | "all" = "normal",
    names?: readonly string[],
  ) {
    // pathspec：指定文件列表时用字面量形式，否则为当前目录
    const pathspecs = names ? names.map((name) => `:(literal)${name}`) : ["."]
    // 运行 status 命令并按 NUL 切分解析
    return nuls(
      yield* text(
        ["status", "--porcelain=v1", `--untracked-files=${untracked}`, "--no-renames", "-z", "--", ...pathspecs],
        { cwd },
      ),
    ).flatMap((item) => {
      // 第 3 个字符起是文件路径
      const file = item.slice(3)
      // 路径为空则跳过
      if (!file) return []
      // 前两个字符是状态码
      const code = item.slice(0, 2)
      // 组装条目
      return [{ file, code, status: kind(code) } satisfies Item]
    })
  })

  // diff：列出与某引用的变更文件（name-status -z 交替输出码与路径）
  const diff = Effect.fn("VcsGit.diffNames")(function* (cwd: string, ref: string, target?: string) {
    // 运行 diff --name-status -z
    const result = yield* run(
      ["diff", "--no-ext-diff", "--no-renames", "--name-status", "-z", ref, ...(target ? [target] : []), "--", "."],
      { cwd },
    )
    // 失败时报 DiffError
    if (result.exitCode !== 0) return yield* new DiffError({ message: "Unable to list Git changes" })
    // 切分输出
    const list = nuls(result.text())
    // 偶数下标为状态码，奇数下标为对应文件
    return list.flatMap((code, idx) => {
      // 跳过奇数位（文件条目）
      if (idx % 2 !== 0) return []
      // 取配对的文件路径
      const file = list[idx + 1]
      // 码或路径缺失则跳过
      if (!code || !file) return []
      // 组装条目
      return [{ file, code, status: kind(code) } satisfies Item]
    })
  })

  // stats：获取与某引用对比的增删行数统计
  const stats = Effect.fn("VcsGit.stats")(function* (cwd: string, ref: string, target?: string) {
    // 运行 diff --numstat -z 并解析
    return numstat(
      yield* text(
        ["diff", "--no-ext-diff", "--no-renames", "--numstat", "-z", ref, ...(target ? [target] : []), "--", "."],
        { cwd },
      ),
    )
  })

  // diffPatch：运行补丁型 diff 的公共实现
  const diffPatch = Effect.fnUntraced(function* (
    cwd: string,
    args: string[],
    options: PatchOptions | undefined,
    mode: { dropTruncated: boolean; noIndex?: boolean },
  ) {
    // 组装 diff 命令：可选 --no-index、统一上下文行数
    const result = yield* run(
      [
        "diff",
        ...(mode.noIndex ? ["--no-index"] : []),
        "--patch",
        "--no-ext-diff",
        "--no-renames",
        `--unified=${options?.context ?? 3}`,
        ...args,
      ],
      { cwd, maxOutputBytes: options?.maxOutputBytes },
    )
    // dropTruncated 时输出被截断则丢弃文本，避免残缺补丁
    return {
      text: mode.dropTruncated && result.truncated ? "" : result.text(),
      truncated: result.truncated,
    } satisfies Patch
  })

  // patch：单个已跟踪文件相对引用的补丁（截断即丢弃）
  const patch = Effect.fn("VcsGit.patch")(function* (cwd: string, ref: string, file: string, options?: PatchOptions) {
    // 委托 diffPatch，传入引用、可选 target 与具体文件
    return yield* diffPatch(cwd, [ref, ...(options?.target ? [options.target] : []), "--", file], options, {
      dropTruncated: true,
    })
  })

  // patchAll：整个目录的批量补丁（不因截断丢弃，交由上层处理）
  const patchAll = Effect.fn("VcsGit.patchAll")(function* (cwd: string, ref: string, options?: PatchOptions) {
    // 委托 diffPatch，pathspec 为当前目录
    return yield* diffPatch(cwd, [ref, ...(options?.target ? [options.target] : []), "--", "."], options, {
      dropTruncated: false,
    })
  })

  // patchUntracked：未跟踪文件的补丁（与 /dev/null 对比）
  const patchUntracked = Effect.fn("VcsGit.patchUntracked")(function* (
    cwd: string,
    file: string,
    options?: PatchOptions,
  ) {
    // A folder entry has no patch of its own.
    // 目录条目自身没有补丁
    if (file.endsWith("/")) return { text: "", truncated: false } satisfies Patch
    // 用 --no-index 把该文件与 /dev/null 对比
    return yield* diffPatch(cwd, ["--", "/dev/null", file], options, { dropTruncated: true, noIndex: true })
  })

  // statUntracked：单个未跟踪文件的增删行数
  const statUntracked = Effect.fn("VcsGit.statUntracked")(function* (cwd: string, file: string) {
    // 目录条目没有统计
    if (file.endsWith("/")) return
    // 运行单文件 numstat，限制输出 4KB
    const result = yield* run(["diff", "--no-index", "--numstat", "--", "/dev/null", file], {
      cwd,
      maxOutputBytes: 4096,
    })
    // 输出被截断则放弃，交由调用方兜底
    if (result.truncated) return

    // 按制表符拆分：新增、删除、路径
    const parts = result.text().split("\t")
    // 字段不足则放弃
    if (parts.length < 2) return

    // 组装统计
    return { file, additions: count(parts[0]), deletions: count(parts[1]) } satisfies Stat
  })

  // Paths are literal so names containing pathspec magic such as `*` or `[` match only themselves.
  // intentToAdd：把文件批量标记为"意图添加"（intent-to-add）；路径按字面量处理，含 `*`、`[` 等 magic 字符的名字只匹配自身
  const intentToAdd = Effect.fn("VcsGit.intentToAdd")(function* (cwd: string, list: string) {
    // 运行 git add --intent-to-add，路径清单来自文件且以 NUL 分隔
    yield* run(
      [
        "--literal-pathspecs",
        "-c",
        "core.splitIndex=false",
        "add",
        "--intent-to-add",
        "--force",
        "--sparse",
        "--ignore-errors",
        `--pathspec-from-file=${list}`,
        "--pathspec-file-nul",
      ],
      { cwd },
    )
  })

  // worktreeStats：工作区（相对索引）的增删统计
  const worktreeStats = Effect.fn("VcsGit.worktreeStats")(function* (cwd: string) {
    // 直接对工作区跑 numstat
    return numstat(yield* text(["diff", "--no-ext-diff", "--no-renames", "--numstat", "-z"], { cwd }))
  })

  // worktreePatch：工作区（相对索引）的完整补丁
  const worktreePatch = Effect.fn("VcsGit.worktreePatch")(function* (cwd: string, options?: PatchOptions) {
    // 无引用参数的补丁 diff
    return yield* diffPatch(cwd, [], options, { dropTruncated: false })
  })

  // 导出全部 git 操作
  return {
    branch,
    branches,
    base,
    defaultBranch,
    hasHead,
    mergeBase,
    status,
    diff,
    stats,
    patch,
    patchAll,
    patchUntracked,
    statUntracked,
    intentToAdd,
    worktreeStats,
    worktreePatch,
  }
}

// 空"未跟踪批量结果"：统计与补丁映射都为空
const emptyUntracked = () => ({ stats: new Map<string, Stat>(), patches: new Map<string, string>() })

/**
 * Prefetches what `statUntracked` and `patchUntracked` report, in three Git processes instead of two
 * per file. The files are recorded intent-to-add in an otherwise empty throwaway index, so a plain
 * `git diff` against it shows exactly those files as new, with the same attribute handling and patch
 * text as `git diff --no-index /dev/null <file>`. Files the batch cannot reproduce byte for byte are
 * left out, and callers fall back to the per-file commands.
 */
// 批量预取未跟踪文件的统计与补丁：用 3 个 git 进程替代每文件 2 个。文件在一个临时空索引里登记为
// intent-to-add，普通 `git diff` 即把它们显示为新增文件，与逐文件命令输出字节一致；无法复现的文件
// 剔除批次，由调用方回退到逐文件命令
const untrackedBatch = Effect.fnUntraced(function* (
  ctx: Ctx,
  files: readonly string[],
  // Patches are only built when requested; status needs line counts alone.
  // 补丁仅在请求时构建；状态查询只需要行数
  patches?: DiffOptions,
) {
  // 筛选可入批次的文件
  const eligible = yield* Effect.promise(() =>
    Promise.all(
      files.map(async (file) => {
        // Directories (nested repositories) and symlinks diff differently through an index.
        // 目录（嵌套仓库）与符号链接经索引对比的行为不同，直接排除
        if (file.endsWith("/")) return
        // 取文件元数据（lstat 不跟随符号链接）
        const stat = await fs.lstat(path.join(ctx.worktree, file)).catch(() => undefined)
        // 非普通文件排除
        if (!stat?.isFile()) return
        // A file this large could crowd every other file out of the batch's output budget.
        // 过大的文件会把其他文件挤出批次的输出预算，排除
        if (stat.size > MAX_TOTAL_PATCH_BYTES / 2) return
        // 保留该文件
        return file
      }),
    ).then((list) => list.filter((file) => file !== undefined)),
  )
  // The batch costs up to three processes; for a single file the per-file commands are cheaper.
  // 批量最多花 3 个进程；单个文件时逐文件命令更便宜
  if (eligible.length < 2) return emptyUntracked()

  // 获取-使用-释放模式：临时文件在整个流程后清理
  return yield* Effect.acquireUseRelease(
    Effect.promise(async () => {
      // 在系统临时目录生成唯一前缀
      const base = path.join(os.tmpdir(), `opencode-untracked-${randomUUID()}`)
      // 写入 NUL 分隔的文件清单
      await fs.writeFile(`${base}.list`, eligible.map((file) => `${file}\0`).join(""))
      // 返回前缀
      return base
    }),
    (base) =>
      Effect.gen(function* () {
        // 构造使用自定义 GIT_INDEX_FILE 的 git 操作集
        const git = makeGit(ctx.proc, { GIT_INDEX_FILE: `${base}.index` })
        // 在临时索引里把清单中的文件登记为 intent-to-add
        yield* git.intentToAdd(ctx.worktree, `${base}.list`)
        // 并发获取统计与（可选的）补丁
        const [stats, patch] = yield* Effect.all(
          [
            git.worktreeStats(ctx.worktree),
            patches
              ? git.worktreePatch(ctx.worktree, {
                  context: patches.context ?? PATCH_CONTEXT_LINES,
                  maxOutputBytes: MAX_TOTAL_PATCH_BYTES,
                })
              : Effect.succeed({ text: "", truncated: false } satisfies Patch),
          ],
          { concurrency: 2 },
        )
        // 期望的文件集合
        const wanted = new Set(eligible)
        // 补丁头 -> 文件路径映射，用于把补丁块归属到文件
        const headers = new Map<string, string>(eligible.map((file) => [`diff --git a/${file} b/${file}`, file]))
        // 返回统计与补丁映射
        return {
          // 统计：只保留期望文件
          stats: new Map(stats.filter((item) => wanted.has(item.file)).map((item) => [item.file, item] as const)),
          // Only chunks with the default `a/` and `b/` prefixes match the per-file output; configured
          // prefixes and quoted paths fall back to it.
          // 补丁：只有使用默认 a/、b/ 前缀的块才能与逐文件输出对齐；自定义前缀或带引号路径的块回退到逐文件命令
          patches: new Map(
            splitGitPatch(patch).flatMap((chunk) => {
              // 取补丁块首行（diff --git 头）对应的文件
              const file = headers.get(chunk.slice(0, chunk.indexOf("\n")))
              // 无法归属则跳过
              return file === undefined ? [] : [[file, chunk] as const]
            }),
          ),
        }
      }),
    (base) =>
      Effect.promise(() =>
        // 释放阶段：清理清单、索引与锁文件
        Promise.all(
          [`${base}.list`, `${base}.index`, `${base}.index.lock`].map((file) => fs.rm(file, { force: true })),
        ),
      ),
  )
})

/** Entries a folder listing shows, and checks per Git call. */
// 目录列举单次展示/检查的最大条目数
const MAX_FOLDER_ENTRIES = 500

/** Entries, and time, a folder listing spends checking before it stops and reports that more were not checked. */
// 目录列举在停止并报告"未全部检查"之前的条目数与时间预算
const MAX_FOLDER_SCAN = 5_000
const MAX_FOLDER_SCAN_MS = 1_000

/**
 * Untracked files, one by one unless the caller asks for folders. With folders, Git lists an untracked folder as one
 * `dir/` entry, as `git status` shows it, and a directory inside such a folder lists only its immediate entries, with
 * its subfolders again as one entry each.
 */
// 列出状态条目：默认逐个列出未跟踪文件；请求目录模式时按 git status 展示方式（目录折叠为 dir/）
const statusItems = Effect.fnUntraced(function* (ctx: Ctx, untracked: Untracked = "files") {
  // 文件模式：全部列出（含未跟踪），无"更多"标记
  if (untracked === "files") return { list: yield* ctx.git.status(ctx.directory, "all"), more: undefined }

  // 目录模式：先做常规状态列举（未跟踪目录折叠为 dir/）
  const list = yield* ctx.git.status(ctx.directory)
  // 计算 Location 目录相对工作树的前缀（统一为 / 分隔）
  const prefix = path.relative(ctx.worktree, ctx.directory).split(path.sep).join("/")
  // 不在子目录中，或没有折叠的未跟踪目录覆盖该前缀：直接返回常规列表
  if (
    !prefix ||
    !list.some((item) => item.code === "??" && item.file.endsWith("/") && `${prefix}/`.startsWith(item.file))
  )
    return { list, more: undefined }

  // 读取目录下的条目名并排序
  const names = yield* Effect.promise(() => fs.readdir(ctx.directory).then((items) => items.toSorted()))
  // Ignored entries do not list, so check entries a batch at a time until the listing fills, the folder runs out, or
  // the scan budget does.
  // 被忽略的条目不会出现在列举中，因此分批检查，直到列满、目录查完或扫描预算耗尽
  const entries: Item[] = []
  // 记录扫描开始时间
  const started = Date.now()
  // 已检查的条目数
  let checked = 0
  // 循环条件：还有未检查条目、未达条目上限、未达扫描条目预算、未超时
  while (
    checked < names.length &&
    entries.length < MAX_FOLDER_ENTRIES &&
    checked < MAX_FOLDER_SCAN &&
    Date.now() - started < MAX_FOLDER_SCAN_MS
  ) {
    // 取下一批条目名
    const batch = names.slice(checked, checked + MAX_FOLDER_ENTRIES)
    // 累计已检查数
    checked += batch.length
    // 对该批条目运行状态检查并累加结果
    entries.push(...(yield* ctx.git.status(ctx.directory, "normal", batch)))
  }
  // 返回截断后的列表与"更多"标记
  return {
    list: entries.slice(0, MAX_FOLDER_ENTRIES),
    more: entries.length > MAX_FOLDER_ENTRIES || checked < names.length ? `${prefix}/` : undefined,
  }
})

/** A folder listing that stopped early ends with an entry for the folder itself, marked `more`. */
// 提前停止的目录列举会在末尾附加一条表示该目录自身的"更多"条目
const withMore = (rows: FileDiff.Info[], folder: string | undefined) =>
  folder === undefined
    ? rows
    : [...rows, { file: folder, patch: "", additions: 0, deletions: 0, status: "added" as const, more: true as const }]

// 把 Stat 列表转为 file -> 增删行数的映射
const nums = (list: Stat[]) =>
  new Map(list.map((item) => [item.file, { additions: item.additions, deletions: item.deletions }] as const))

// 合并多个条目列表：按文件路径去重，保留首次出现
const merge = (...lists: Item[][]) => {
  // 以文件路径为键去重
  const out = new Map<string, Item>()
  // 依次放入，先到先得
  lists.flat().forEach((item) => {
    if (!out.has(item.file)) out.set(item.file, item)
  })
  // 返回值列表
  return [...out.values()]
}

// 空批量补丁结果：无补丁、未截断
const emptyBatch = () => ({ patches: new Map<string, string>(), capped: false })

// 批量补丁：一次 diff 拿到全部文件的补丁，再按文件切块
const batchPatches = Effect.fnUntraced(function* (ctx: Ctx, ref: string, list: Item[], options?: GitDiffOptions) {
  // 空列表直接返回空结果
  if (list.length === 0) return emptyBatch()

  // 运行整目录补丁 diff（受总字节预算限制）
  const result = yield* ctx.git.patchAll(ctx.directory, ref, {
    target: options?.target,
    context: options?.context ?? PATCH_CONTEXT_LINES,
    maxOutputBytes: MAX_TOTAL_PATCH_BYTES,
  })

  // 返回按文件切块的补丁与截断标记
  return {
    patches: chunksByFile(result, (index) => list[index]?.file),
    capped: result.truncated,
  }
})

// 原生补丁：对单文件逐个取补丁（未跟踪走 --no-index，已跟踪走普通 diff）
const nativePatch = Effect.fnUntraced(function* (
  ctx: Ctx,
  ref: string | undefined,
  item: Item,
  options?: GitDiffOptions,
) {
  // 按未跟踪/已跟踪选择不同的补丁命令
  const result =
    item.code === "??" || !ref
      ? yield* ctx.git.patchUntracked(ctx.worktree, item.file, {
          context: options?.context ?? PATCH_CONTEXT_LINES,
          maxOutputBytes: MAX_PATCH_BYTES,
        })
      : yield* ctx.git.patch(ctx.worktree, ref, item.file, {
          target: options?.target,
          context: options?.context ?? PATCH_CONTEXT_LINES,
          maxOutputBytes: MAX_PATCH_BYTES,
        })
  // 完整且非空则直接使用
  if (!result.truncated && result.text) return result.text

  // 否则退化为空补丁（仅标注文件不可展示）
  return emptyPatch(item.file)
})

// 总量预算判断：补丁加入后不超总预算则保留，否则替换为空补丁并标记截断
const totalPatch = (file: string, patch: string, total: number) => {
  // 未超预算则接受该补丁
  if (total + Buffer.byteLength(patch) <= MAX_TOTAL_PATCH_BYTES) return { patch, capped: false }
  // 超预算则使用空补丁并标记
  return { patch: emptyPatch(file), capped: true }
}

// 为单个条目取补丁：优先级为截断 -> 批量缓存 -> 未跟踪预取 -> 原生单文件查询
const patchForItem = Effect.fnUntraced(function* (
  ctx: Ctx,
  ref: string | undefined,
  item: Item,
  batch: { patches: Map<string, string>; capped: boolean },
  untracked: Map<string, string>,
  capped: boolean,
  options?: GitDiffOptions,
) {
  // 已全局截断：直接给空补丁
  if (capped) return emptyPatch(item.file)

  // 批量补丁中已有该文件则直接使用
  const batched = batch.patches.get(item.file)
  // 命中即返回
  if (batched !== undefined) return batched
  // 已跟踪文件在批量结果被截断时：无法可靠取到，给空补丁
  if (item.code !== "??" && batch.capped) return emptyPatch(item.file)
  // 未跟踪文件：查预取的补丁
  const prefetched = item.code === "??" || !ref ? untracked.get(item.file) : undefined
  // 命中预取则返回
  if (prefetched !== undefined) return prefetched
  // 最后回退到原生单文件查询
  return yield* nativePatch(ctx, ref, item, options)
})

// 组装最终差异行：为每个条目补齐统计与补丁，并施加总量预算
const files = Effect.fnUntraced(function* (
  ctx: Ctx,
  ref: string | undefined,
  list: Item[],
  map: Map<string, { additions: number; deletions: number }>,
  batch: { patches: Map<string, string>; capped: boolean },
  options?: GitDiffOptions,
) {
  // 批量预取未跟踪文件的统计与补丁：候选为未跟踪文件、无引用时的全部，或非 target 模式下缺失统计的新增文件
  const untracked = yield* untrackedBatch(
    ctx,
    list
      .filter(
        (item) => item.code === "??" || !ref || (!options?.target && item.status === "added" && !map.has(item.file)),
      )
      .map((item) => item.file),
    options ?? {},
  )
  // 最终行列表
  const next: FileDiff.Info[] = []
  // 已累计的补丁字节数
  let total = 0
  // 是否已进入截断状态
  let capped = false

  // 按文件名排序逐条处理
  for (const item of list.toSorted((a, b) => a.file.localeCompare(b.file))) {
    // 统计来源：diff 统计 -> 非 target 模式下新增文件的未跟踪统计 -> 单文件查询
    const stat =
      map.get(item.file) ??
      (!options?.target && item.status === "added"
        ? (untracked.stats.get(item.file) ?? (yield* ctx.git.statUntracked(ctx.worktree, item.file)))
        : undefined)
    // 获取该条目的补丁
    const patch = yield* patchForItem(ctx, ref, item, batch, untracked.patches, capped, options)
    // 已截断时保留补丁但维持截断标记；否则按总预算判定
    const result: { patch: string; capped: boolean } = capped
      ? { patch, capped: true }
      : totalPatch(item.file, patch, total)
    // 合并截断标记
    capped = capped || result.capped
    // 未截断时累计字节数，达到总预算即进入截断状态
    if (!capped) {
      total += Buffer.byteLength(result.patch)
      capped = total >= MAX_TOTAL_PATCH_BYTES
    }
    // 推入最终行
    next.push({
      file: item.file,
      patch: result.patch,
      additions: stat?.additions ?? 0,
      deletions: stat?.deletions ?? 0,
      status: item.status,
    })
  }

  // 返回全部差异行
  return next
})

// 相对某引用的差异：并行获取变更列表、统计与可选的未跟踪目录条目
const diffAgainstRef = Effect.fnUntraced(function* (ctx: Ctx, ref: string, options?: GitDiffOptions) {
  // 三个查询并发执行
  const [list, stats, extra] = yield* Effect.all(
    [
      // 变更文件列表
      ctx.git.diff(ctx.directory, ref, options?.target),
      // 增删统计
      ctx.git.stats(ctx.directory, ref, options?.target),
      // target 模式不需要目录扫描；否则按 untracked 选项扫描状态
      options?.target ? Effect.succeed({ list: [], more: undefined }) : statusItems(ctx, options?.untracked),
    ],
    { concurrency: 3 },
  )
  // 合并 diff 列表与未跟踪条目，组装差异行
  const rows = yield* files(
    ctx,
    ref,
    merge(
      list,
      extra.list.filter((item) => item.code === "??"),
    ),
    nums(stats),
    yield* batchPatches(ctx, ref, list, options),
    options,
  )
  // 附加"更多"目录条目后返回
  return withMore(rows, extra.more)
})

// track：working 模式的差异入口（无 HEAD 时为纯未跟踪视图）
const track = Effect.fnUntraced(function* (ctx: Ctx, ref: string | undefined, options?: DiffOptions) {
  // 无引用：仅用状态条目组装，统计与补丁从零开始
  if (!ref) {
    // 扫描状态条目
    const status = yield* statusItems(ctx, options?.untracked)
    // 组装差异行并附加"更多"标记
    return withMore(yield* files(ctx, ref, status.list, new Map(), emptyBatch(), options), status.more)
  }
  // 有引用：与 HEAD 对比
  return yield* diffAgainstRef(ctx, ref, options)
})
