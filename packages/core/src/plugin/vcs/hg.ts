// 将本模块以命名空间 `VcsHgPlugin` 全量导出
export * as VcsHgPlugin from "./hg.js"

// 引入 path 模块做相对路径计算
import path from "path"
// 引入 Effect 原语
import { Effect } from "effect"
// 引入子进程 Effect 构造器
import { ChildProcess } from "effect/process"
// 引入插件定义工具 define
import { define } from "@opencode/plugin/effect/plugin"
// 引入文件差异 schema
import { FileDiff } from "@opencode/schema/file-diff"
// 引入版本控制 schema：FileStatus、Info、Mode
import { FileStatus, Info, Mode } from "@opencode/schema/vcs"
// 引入文件系统工具服务（读文件）
import { FSUtil } from "@opencode/util/fs-util"
// 引入应用进程服务
import { AppProcess } from "@opencode/util/process"
// 引入 Location 服务
import { Location } from "../../location.js"
// 引入适配器与差异选项类型（仅类型）
import type { Adapter, DiffOptions } from "../../vcs.js"
// 引入差异错误类型
import { DiffError } from "../../vcs.js"
// 引入补丁工具：合成新增/删除补丁、按文件切块、统计行数、空补丁与字节上限常量
import {
  addPatch,
  chunksByFile,
  countPatch,
  deletePatch,
  emptyPatch,
  MAX_PATCH_BYTES,
  MAX_TOTAL_PATCH_BYTES,
  PATCH_CONTEXT_LINES,
} from "../../vcs/patch.js"

// 定义 Mercurial 版本控制插件：向 VCS 注册表注册 hg 适配器
export const Plugin = define({
  // 插件唯一标识
  id: "opencode.vcs.hg",
  // 插件副作用主体
  effect: Effect.fn("VcsHgPlugin")(function* (ctx) {
    // 获取 Location 服务
    const location = yield* Location.Service
    // Markerless locations need this definition to initialize their first repository.
    // 已声明其他 VCS 类型的 Location 直接退出；无标记的 Location 需要本定义初始化首个仓库
    if (location.vcs && location.vcs.type !== "hg") return

    // 获取进程服务
    const processes = yield* AppProcess.Service
    // 获取文件系统服务
    const fs = yield* FSUtil.Service
    // 构建 hg 适配器
    const adapter = make(processes, fs, {
      directory: location.directory,
      worktree: location.project.directory,
    })

    // 向 VCS 注册表添加 hg 适配器条目
    yield* ctx.vcs.transform((editor) => {
      editor.add({
        // 适配器 id
        id: "hg",
        // 显示名称
        name: "Mercurial",
        // init：在工作树初始化 Mercurial 仓库
        init: (input) =>
          Effect.gen(function* () {
            // 运行 `hg init`（HGPLAIN=1 保证输出格式稳定）
            const result = yield* processes.run(
              ChildProcess.make("hg", ["init"], {
                cwd: input.worktree,
                env: { HGPLAIN: "1" },
                extendEnv: true,
                stdin: "ignore",
              }),
            )
            // 失败则报错
            if (result.exitCode !== 0) return yield* Effect.fail(new Error("Mercurial initialization failed"))
          }),
        // info：返回分支信息
        info: () => adapter.info(),
        // branches：列出分支（hg 适配器不支持，恒为空）
        branches: (input) => adapter.branches({ search: input.search, limit: input.limit }),
        // status：返回文件状态
        status: () => adapter.status(),
        // diff：按模式与选项返回差异
        diff: (input) => adapter.diff(input.mode, { context: input.context, base: input.base }),
      })
    })
  }),
})

/**
 * Mercurial adapter for the Vcs service. `hg diff --git` emits git-format
 * patches for tracked changes; untracked (`?`) and missing (`!`) files never
 * appear in `hg diff`, so their patches are synthesized from file contents.
 */
// 构建 Mercurial 适配器：hg diff --git 只覆盖已跟踪变更；未跟踪（?）与缺失（!）文件不会出现在
// diff 中，因此它们的补丁需从文件内容合成
function make(
  proc: AppProcess.Interface,
  fs: FSUtil.Interface,
  input: { directory: string; worktree: string },
): Adapter {
  // 构建底层 hg 操作集
  const hg = makeHg(proc, input.worktree)
  // All commands run from the worktree root (hg prints root-relative paths);
  // this pathspec scopes them to the requested directory.
  // 所有命令从工作树根运行（hg 输出根相对路径）；该 pathspec 把范围限定到请求目录
  const scope = path.relative(input.worktree, input.directory) || "."

  // 为单条变更取补丁：优先用 diff 批量结果，未跟踪/缺失文件从内容合成
  const patchFor = Effect.fnUntraced(function* (item: Item, rev: string | undefined, chunk: string | undefined) {
    // diff 批量结果中已有该文件的补丁则直接使用
    if (chunk !== undefined) return chunk
    // 未跟踪文件（?）：读取当前内容合成"新增补丁"
    if (item.code === "?") {
      // 读取文件内容，失败时为 undefined
      const content = yield* fs
        .readFileString(path.join(input.worktree, item.file))
        .pipe(Effect.orElseSucceed(() => undefined))
      // 内容缺失或超过单补丁字节上限则给空补丁
      if (content === undefined || Buffer.byteLength(content) > MAX_PATCH_BYTES) return emptyPatch(item.file)
      // 合成新增补丁
      return addPatch(item.file, content)
    }
    // 缺失文件（!）：从指定修订版读出原内容合成"删除补丁"
    if (item.code === "!") {
      // 从修订版读取文件内容
      const content = yield* hg.cat(rev ?? ".", item.file)
      // 内容缺失或超限则给空补丁
      if (content === undefined || Buffer.byteLength(content) > MAX_PATCH_BYTES) return emptyPatch(item.file)
      // 合成删除补丁
      return deletePatch(item.file, content)
    }
    // 其余情况给空补丁
    return emptyPatch(item.file)
  })

  // 与某修订版对比：并获取状态与补丁，逐文件组装差异行
  const diffAgainst = Effect.fnUntraced(function* (rev: string | undefined, options?: DiffOptions) {
    // 并发获取状态条目与补丁批（上下文行数可配置）
    const [items, batch] = yield* Effect.all(
      [hg.status(rev, scope), hg.diff(rev, scope, { context: options?.context ?? PATCH_CONTEXT_LINES })],
      { concurrency: 2 },
    )
    // 把补丁批按文件切块（index 函数恒返回 undefined，按块头匹配文件）
    const chunks = chunksByFile(batch, () => undefined)
    // 差异行列表
    const list: FileDiff.Info[] = []
    // 按文件名排序逐条组装
    for (const item of items.toSorted((a, b) => a.file.localeCompare(b.file))) {
      // 获取补丁
      const patch = yield* patchFor(item, rev, chunks.get(item.file))
      // 统计补丁的增删行数
      const counts = countPatch(patch)
      // 推入差异行
      list.push({
        file: item.file,
        patch,
        additions: counts.additions,
        deletions: counts.deletions,
        status: item.status,
      })
    }
    // 返回全部差异行
    return list
  })

  // 返回满足 Adapter 接口的实现
  return {
    // info：当前分支与默认分支（hg 的默认分支固定叫 default）
    info: Effect.fn("VcsHg.info")(function* () {
      // 组装 Info
      return { branch: { current: yield* hg.branch(), default: "default" } } satisfies Info
    }),
    // branches：Mercurial 适配器不提供分支列举
    branches: Effect.fn("VcsHg.branches")(function* () {
      // 恒返回空列表
      return []
    }),
    // status：以 0 上下文 diff 转换为文件状态列表
    status: Effect.fn("VcsHg.status")(function* () {
      // 取无上下文的差异行并映射为 FileStatus
      return (yield* diffAgainst(undefined, { context: 0 })).map(
        (item) =>
          ({
            file: item.file,
            additions: item.additions,
            deletions: item.deletions,
            status: item.status,
          }) satisfies FileStatus,
      )
    }),
    // diff：working 模式对比工作区；staged 模式对比与 default 的共同祖先
    diff: Effect.fn("VcsHg.diff")(function* (mode: Mode, options?: DiffOptions) {
      // working：与工作区对比
      if (mode === "working") return yield* diffAgainst(undefined, options)
      // committed 或显式基线：Mercurial 适配器不支持
      if (mode === "committed" || options?.base !== undefined) {
        return yield* new DiffError({
          message: "The Mercurial provider does not support committed reviews or explicit bases",
        })
      }

      // 读取当前分支
      const branch = yield* hg.branch()
      // 无分支或就是 default：无 staged 差异
      if (!branch || branch === "default") return []
      // 计算与 default 的共同祖先
      const ancestor = yield* hg.ancestor()
      // 无祖先则无差异
      if (!ancestor) return []
      // 与祖先修订对比
      return yield* diffAgainst(ancestor, options)
    }),
  }
}

// 文件状态种类
type Kind = FileStatus["status"]

// 单条变更条目
interface Item {
  // 文件路径
  readonly file: string
  // 原始 hg 状态码
  readonly code: string
  // 归一化状态
  readonly status: Kind
}

// 把 hg 单字符状态码归一化：A/? -> 新增，R/! -> 删除，其余 -> 修改
const kind = (code: string): Kind => {
  // 新增或未跟踪
  if (code === "A" || code === "?") return "added"
  // 删除或缺失
  if (code === "R" || code === "!") return "deleted"
  // 其余按修改
  return "modified"
}

// 构建底层 hg 操作集
function makeHg(proc: AppProcess.Interface, worktree: string) {
  // 基础运行函数：执行 hg 命令并返回退出码、文本与截断标记
  const run = Effect.fnUntraced(
    function* (args: string[], opts?: { maxOutputBytes?: number }) {
      // 运行子进程（HGPLAIN=1 保证输出稳定）
      const result = yield* proc.run(
        ChildProcess.make("hg", args, {
          cwd: worktree,
          env: { HGPLAIN: "1" },
          extendEnv: true,
          stdin: "ignore",
        }),
        { maxOutputBytes: opts?.maxOutputBytes },
      )
      // 返回结果对象
      return {
        exitCode: result.exitCode,
        text: () => result.stdout.toString("utf8"),
        truncated: result.stdoutTruncated || result.stderrTruncated,
      }
    },
    // 进程启动失败时退化为失败结果
    Effect.orElseSucceed(() => ({ exitCode: 1, text: () => "", truncated: false })),
  )

  // status：按 NUL 分隔输出列出变更条目
  const status = Effect.fn("VcsHg.statusNames")(function* (rev: string | undefined, scope: string) {
    // 运行 hg status -0（可选 --rev）
    const result = yield* run(["status", "-0", ...(rev ? ["--rev", rev] : []), scope])
    // 失败返回空
    if (result.exitCode !== 0) return []
    // 解析 NUL 分隔的条目
    return result
      .text()
      .split("\0")
      .filter(Boolean)
      .flatMap((entry) => {
        // 第一个字符是状态码
        const code = entry.slice(0, 1)
        // 第三个字符起是文件路径
        const file = entry.slice(2)
        // 路径为空则跳过
        if (!file) return []
        // 组装条目
        return [{ file, code, status: kind(code) } satisfies Item]
      })
  })

  // diff：获取 git 格式补丁批
  const diff = Effect.fn("VcsHg.diffPatch")(function* (
    rev: string | undefined,
    scope: string,
    options: { context: number },
  ) {
    // 运行 hg diff --git（统一上下文行数，可选修订版）
    const result = yield* run(
      ["diff", "--git", "--unified", String(options.context), ...(rev ? ["-r", rev] : []), scope],
      { maxOutputBytes: MAX_TOTAL_PATCH_BYTES },
    )
    // 失败返回空补丁批
    if (result.exitCode !== 0) return { text: "", truncated: false }
    // 返回补丁文本与截断标记
    return { text: result.text(), truncated: result.truncated }
  })

  // branch：读取当前分支名
  const branch = Effect.fn("VcsHg.branch")(function* () {
    // 运行 hg branch
    const result = yield* run(["branch"])
    // 失败返回 undefined
    if (result.exitCode !== 0) return undefined
    // 返回去除空白的分支名
    return result.text().trim() || undefined
  })

  // ancestor：计算当前分支与 default 的共同祖先节点
  const ancestor = Effect.fn("VcsHg.ancestor")(function* () {
    // 运行 hg log 模板查询
    const result = yield* run(["log", "-r", "ancestor(., default)", "-T", "{node}"])
    // 失败返回 undefined
    if (result.exitCode !== 0) return undefined
    // 返回节点哈希
    return result.text().trim() || undefined
  })

  // cat：读取某修订版下的文件内容
  const cat = Effect.fn("VcsHg.cat")(function* (rev: string, file: string) {
    // 运行 hg cat，限制输出字节
    const result = yield* run(["cat", "-r", rev, "--", file], { maxOutputBytes: MAX_PATCH_BYTES })
    // 失败或被截断返回 undefined
    if (result.exitCode !== 0 || result.truncated) return undefined
    // 返回文件内容
    return result.text()
  })

  // 导出全部 hg 操作
  return { status, diff, branch, ancestor, cat }
}
