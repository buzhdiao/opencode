// 文件保留（File Retention）：按保留期（retention）清理过期文件的工具函数。
export * as FileRetention from "./file-retention.js"

import { Duration, Effect, Option } from "effect"
import { FSUtil } from "@opencode/util/fs-util"

// cleanup：删除最后修改时间早于保留期截止点的文件
export const cleanup = Effect.fn("FileRetention.cleanup")(function* (
  fs: FSUtil.Interface,
  files: ReadonlyArray<string>,
  retention: Duration.Input,
) {
  // 计算截止时间戳：当前时间减去保留时长
  const cutoff = Date.now() - Duration.toMillis(retention)
  yield* Effect.forEach(
    files,
    (file) =>
      Effect.gen(function* () {
        // stat 失败按 undefined 处理
        const info = yield* fs.stat(file).pipe(Effect.orElseSucceed(() => undefined))
        // 取最后修改时间，可能缺失
        const mtime = info && Option.getOrUndefined(info.mtime)
        // 无修改时间或仍在保留期内则跳过
        if (!mtime || mtime.getTime() >= cutoff) return
        // 删除过期文件，忽略删除失败
        yield* fs.remove(file).pipe(Effect.ignore)
      }),
    // 最多 8 路并发，不收集结果
    { concurrency: 8, discard: true },
  )
})
