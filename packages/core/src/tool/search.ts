// 将本文件的所有导出聚合到命名空间 ToolSearch 下，供插件系统统一引入
export * as ToolSearch from "./search.js"

// 工具执行失败时抛出的错误类型（ToolFailure）
import { ToolFailure } from "@opencode/ai/effect"
// effect 库核心：Effect 副作用编排
import { Effect } from "effect"
// 环境服务：文件类型查询
import { Environment } from "../environment/index.js"
// 文件系统共享常量（如默认搜索超时）
import { FileSystem } from "../filesystem.js"

// 解析搜索路径的类型（跟随符号链接）；路径不存在时报工具错误
export const pathType = (files: Environment.Files, absolute: string, display: string) =>
  // 查询路径类型（解析符号链接后）
  Environment.typeFollowing(files, absolute).pipe(
    // 路径不存在时转为带展示路径的工具失败
    Effect.catchTag("Environment.NotFound", () =>
      Effect.fail(new ToolFailure({ message: `Search path does not exist: ${display}` })),
    ),
  )

// Fetches one result past the limit so truncation can be reported without a second search.
// 限定搜索结果数量：多取一条用于判断是否截断，避免二次搜索
export const bounded = <A, E, R>(limit: number, search: (limit: number) => Effect.Effect<readonly A[], E, R>) =>
  // 实际请求 limit+1 条
  search(limit + 1).pipe(
    // 整个搜索套上默认超时
    Effect.timeoutOrElse({
      // 超时时长：文件系统默认搜索超时
      duration: FileSystem.DEFAULT_SEARCH_TIMEOUT_MS,
      // 超时后的错误信息
      orElse: () =>
        Effect.fail(
          new ToolFailure({
            message: `Search timed out after ${FileSystem.DEFAULT_SEARCH_TIMEOUT_MS / 1_000} seconds. Consider using a more specific path or pattern.`,
          }),
        ),
    }),
    // 截取前 limit 条并标记是否被截断
    Effect.map((items) => ({ items: items.slice(0, limit), truncated: items.length > limit })),
  )
