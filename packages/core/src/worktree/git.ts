// 将本文件的所有导出聚合到命名空间 WorktreeGit 下，供统一引入
export * as WorktreeGit from "./git.js"

// effect 库：Effect 编排
import { Effect } from "effect"
// Worktree Schema：策略 ID 与列表条目类型
import { Worktree } from "@opencode/schema/worktree"
// 文件系统工具服务
import { FSUtil } from "@opencode/util/fs-util"
// Git 服务：仓库与 worktree 操作
import { Git } from "../git.js"
// 目录规范化与不可用错误
import { canonical, DirectoryUnavailableError } from "./directory.js"
// 工作树策略接口
import type { Strategy } from "./strategies.js"

// 构造基于 git worktree 的工作树策略
export const make = Effect.gen(function* () {
  // 获取文件系统工具服务
  const fs = yield* FSUtil.Service
  // 获取 Git 服务
  const git = yield* Git.Service

  // 返回策略实现
  return {
    // 策略 ID：git
    id: Worktree.StrategyID.make("git"),
    // 创建工作树
    create: Effect.fn("Worktree.Git.create")(function* (input) {
      // 在源目录中发现 git 仓库
      const repository = yield* git.repo.discover(input.sourceDirectory)
      // 不是仓库则报"目录不可用"
      if (!repository) return yield* new DirectoryUnavailableError({ directory: input.sourceDirectory })
      // 在目标目录按指定分支创建 worktree
      yield* git.worktree.create({ repository, directory: input.directory, ref: input.branch })
      // 返回规范化后的工作树目录
      return { directory: yield* canonical(fs, input.directory) }
    }),
    // 移除工作树
    remove: Effect.fn("Worktree.Git.remove")(function* (input) {
      // 在工作树目录中发现所属仓库
      const repository = yield* git.repo.discover(input.directory)
      // 不是仓库则报"目录不可用"
      if (!repository) return yield* new DirectoryUnavailableError({ directory: input.directory })
      // 删除 worktree（可指定强制）
      yield* git.worktree.remove({ repository, directory: input.directory, force: input.force })
    }),
    // 列出所有工作树
    list: Effect.fn("Worktree.Git.list")(function* (directory) {
      // 在给定目录中发现仓库
      const repository = yield* git.repo.discover(directory)
      // 不是仓库则报"目录不可用"
      if (!repository) return yield* new DirectoryUnavailableError({ directory })
      // 获取 git 侧的 worktree 列表
      const entries = yield* git.worktree.list(repository)
      // 逐个规范化目录并转换为列表条目
      return yield* Effect.forEach(entries, (entry) =>
        canonical(fs, entry.directory).pipe(
          // 主工作树标记为 root，其余为 worktree
          Effect.map((directory) => ({ directory, type: entry.kind === "main" ? "root" : "worktree" }) as const),
          // 目录已消失（不可用）的条目静默跳过
          Effect.catchTag("Worktree.DirectoryUnavailableError", () => Effect.undefined),
        ),
      ).pipe(Effect.map((items) => items.filter((item): item is Worktree.ListEntry => item !== undefined)))
    }),
  } satisfies Strategy
})
