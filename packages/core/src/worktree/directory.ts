// 将本文件的所有导出聚合到命名空间 WorktreeDirectory 下，供统一引入
export * as WorktreeDirectory from "./directory.js"

// effect 库：Effect 编排、Schema 校验
import { Effect, Schema } from "effect"
// 文件系统工具服务
import { FSUtil } from "@opencode/util/fs-util"
// 通用 Schema：绝对路径
import { AbsolutePath } from "../schema.js"

// 错误：目录不可用（不存在或不是目录）
export class DirectoryUnavailableError extends Schema.TaggedError<DirectoryUnavailableError>()(
  "Worktree.DirectoryUnavailableError",
  // 出问题的目录路径
  { directory: AbsolutePath },
) {}

// 规范化目录路径：解析真实路径并校验是目录
export const canonical = Effect.fnUntraced(function* (fs: FSUtil.Interface, input: AbsolutePath) {
  // 解析为绝对真实路径
  const resolved = AbsolutePath.make(yield* fs.resolve(input))
  // 不是目录则报"目录不可用"
  if (!(yield* fs.isDir(resolved))) return yield* new DirectoryUnavailableError({ directory: input })
  // 返回规范化路径
  return resolved
})
