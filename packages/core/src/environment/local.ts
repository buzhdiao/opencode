// 导入 Node 的 promises 版文件系统 API
import fs from "node:fs/promises"
// 导入 Node 的路径处理模块
import path from "node:path"
// 从 effect 库导入 Effect（效果类型）
import { Effect } from "effect"
// 仅作类型导入：ChildProcessSpawner 服务类型
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
// 仅作类型导入：Driver 驱动器接口
import type { Driver } from "./driver.js"
// 导入错误类型与 Files 相关类型
import { Failed, NotFound, WrongKind, type FileInfo, type FilesImpl, type FileType } from "./files.js"

/**
 * The host filesystem binding. Deliberately raw node:fs rather than effect's
 * FileSystem service or FSUtil: the contract needs lstat semantics (stat
 * reports "symlink"), and effect's node FileSystem stat always follows
 * symlinks. Nothing above the environment seam touches node:fs.
 *
 * 中文说明：本文件是宿主文件系统绑定。刻意直接使用 node:fs 原生 API，而非 effect 的 FileSystem
 * 服务或 FSUtil——因为契约需要 lstat 语义（stat 要能报告 "symlink"），而 effect 的 node
 * FileSystem 的 stat 总是跟随符号链接。环境接缝之上的代码不允许触碰 node:fs。
 */
export const makeLocalDriver = (spawner: ChildProcessSpawner["Service"]): Driver => {
  // overrides：用原生 fs 实现覆盖 exec 默认实现的文件操作
  const overrides: FilesImpl = {
    // read：读取文件内容（可带 range 区间），先校验目标确为常规文件
    read: (value, range) =>
      Effect.gen(function* () {
        // 跟随链接取目标文件的元信息
        const info = yield* stat(value, true)
        // 目标不是常规文件则报告 WrongKind
        if (info.type !== "file") return yield* new WrongKind({ path: value, actual: info.type })
        // 未指定 range：一次性读取整个文件
        if (range === undefined) {
          const bytes = yield* attempt(value, () => fs.readFile(value), true)
          return { info, bytes }
        }
        // 指定 range：打开文件句柄，从 offset 处读取 length 字节
        const bytes = yield* attempt(
          value,
          async () => {
            const handle = await fs.open(value, "r")
            try {
              // 预分配接收缓冲区
              const buffer = new Uint8Array(range.length)
              // 从指定偏移读取，最多 range.length 字节
              const result = await handle.read(buffer, 0, range.length, range.offset)
              // 只返回实际读到的部分
              return buffer.subarray(0, result.bytesRead)
            } finally {
              // 无论成败都关闭文件句柄
              await handle.close()
            }
          },
          true,
        )
        // 返回元信息与读取到的字节
        return { info, bytes }
      }),
    // stat：不跟随链接，报告路径条目本身的类型
    stat: (value) => stat(value, false),
    // list：列出目录的直接子项，并映射每个条目的类型
    list: (value) =>
      Effect.gen(function* () {
        // 跟随链接确认最终目标是目录
        const info = yield* stat(value, true)
        // 目标不是目录则报告 WrongKind
        if (info.type !== "directory") return yield* new WrongKind({ path: value, actual: info.type })
        // withFileTypes: true 使 readdir 返回带类型的 Dirent 对象
        const entries = yield* attempt(value, () => fs.readdir(value, { withFileTypes: true }), true)
        // 把 Dirent 映射为统一的 DirEntry 结构
        return entries.map((entry) => ({ name: entry.name, type: fileType(entry) }))
      }),
    // write：先递归创建父目录，再写入字节
    write: (value, bytes) =>
      attempt(value, async () => {
        await fs.mkdir(path.dirname(value), { recursive: true })
        await fs.writeFile(value, bytes)
      }),
    // remove：递归强制删除（目录/文件/符号链接均适用）
    remove: (value) => attempt(value, () => fs.rm(value, { recursive: true, force: true })),
    // move：移动或重命名；若目标是已存在目录，则移入该目录内（保持原文件名）
    move: (from, to) =>
      Effect.gen(function* () {
        // 确认源存在（不跟随链接）
        yield* stat(from, false)
        // 计算最终目标路径：目标为目录时拼接源文件名，否则直接用 to
        const destination = yield* stat(to, false).pipe(
          Effect.map((info) => (info.type === "directory" ? path.join(to, path.basename(from)) : to)),
          // 目标不存在时按 POSIX rename 语义直接使用 to
          Effect.catchIf(
            (error) => error instanceof NotFound,
            () => Effect.succeed(to),
          ),
        )
        // 执行实际的原子重命名
        yield* attempt(from, () => fs.rename(from, destination))
      }),
    // mkdir：递归创建目录
    mkdir: (value) => attempt(value, () => fs.mkdir(value, { recursive: true }).then(() => undefined)),
  }

  // 返回本地驱动器：自带派生器与上述文件操作覆盖
  return { spawner, overrides }
}

// stat 辅助：follow 为 true 时用 fs.stat（跟随链接），否则用 fs.lstat（不跟随），并映射为 FileInfo
const stat = (value: string, follow: boolean) =>
  attempt(value, () => (follow ? fs.stat(value) : fs.lstat(value)), true).pipe(
    Effect.map((stats): FileInfo => ({ type: fileType(stats), size: stats.size, mtimeMs: stats.mtimeMs })),
  )

// fileType：把 Node 的 Dirent/Stats 类型判断方法归一化为 FileType 枚举
const fileType = (entry: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): FileType => {
  if (entry.isFile()) return "file"
  if (entry.isDirectory()) return "directory"
  if (entry.isSymbolicLink()) return "symlink"
  return "other"
}

// attempt 的重载一：默认不区分“不存在”错误，失败统一映射为 Failed
function attempt<A>(value: string, run: () => Promise<A>): Effect.Effect<A, Failed>
// attempt 的重载二：missing 为 true 时，把 ENOENT/ENOTDIR 类错误映射为 NotFound
function attempt<A>(value: string, run: () => Promise<A>, missing: true): Effect.Effect<A, NotFound | Failed>
// attempt 实现：把 Promise 包装为 Effect，并统一错误映射
function attempt<A>(value: string, run: () => Promise<A>, missing = false) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) =>
      missing && isMissing(cause) ? new NotFound({ path: value }) : new Failed({ path: value, cause }),
  })
}

// isMissing：判断错误是否为 Node 的“路径不存在”类错误码（ENOENT/ENOTDIR）
const isMissing = (cause: unknown) =>
  cause !== null &&
  typeof cause === "object" &&
  "code" in cause &&
  (cause.code === "ENOENT" || cause.code === "ENOTDIR")

// 以命名空间形式整体导出本模块
export * as EnvironmentLocal from "./local.js"
