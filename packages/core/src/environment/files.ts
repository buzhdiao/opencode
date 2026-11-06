// 从 effect 库导入 Effect（效果类型）与 Schema（运行时数据校验/编解码）
import { Effect, Schema } from "effect"

// FileType：文件类型 schema，限定四种字面量取值
export const FileType = Schema.Literals(["file", "directory", "symlink", "other"])
// 由 schema 推导出的 FileType 静态类型
export type FileType = typeof FileType.Type

// FileInfo：单个文件的元信息（类型、字节大小、修改时间毫秒数）
export interface FileInfo {
  readonly type: FileType
  readonly size: number
  readonly mtimeMs: number
}

// DirEntry：目录列表中的一项（条目名 + 类型）
export interface DirEntry {
  readonly name: string
  readonly type: FileType
}

// NotFound 错误：目标路径不存在
export class NotFound extends Schema.TaggedError<NotFound>()("Environment.NotFound", {
  path: Schema.String,
}) {}

// WrongKind 错误：目标的实际类型与操作预期不符（例如对目录调用 read），携带实际类型
export class WrongKind extends Schema.TaggedError<WrongKind>()("Environment.WrongKind", {
  path: Schema.String,
  actual: FileType,
}) {}

// Failed 错误：一般性操作失败，携带底层原因（defect）
export class Failed extends Schema.TaggedError<Failed>()("Environment.Failed", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {}

// FilesImpl：文件操作契约的接口定义（具体实现见 exec-defaults/local/memory 等）
export interface FilesImpl {
  /**
   * Content operations (`read`, `list`) follow final symlinks; metadata operations (`stat` and entry
   * tags returned by `list`) do not. `info` describes the target file whose bytes are returned.
   * The process-backed default caps collected output at 64 MiB; larger whole-file reads fail with
   * `Failed`, so callers must use ranges for larger files.
   *
   * 中文说明：内容类操作（`read`、`list`）会跟随末级符号链接到最终目标；元数据类操作（`stat` 及
   * `list` 返回的条目标签）不跟随。`info` 描述的是实际返回字节内容的目标文件。基于进程的默认实现
   * 将收集输出上限设为 64 MiB，超限的整文件读取会以 `Failed` 失败，因此更大文件必须使用 range 读取。
   */
  readonly read: (
    path: string,
    range?: { readonly offset: number; readonly length: number },
  ) => Effect.Effect<{ readonly info: FileInfo; readonly bytes: Uint8Array }, NotFound | WrongKind | Failed>
  // write：把字节写入指定路径（必要时创建父目录）
  readonly write: (path: string, bytes: Uint8Array) => Effect.Effect<void, Failed>
  // stat 描述路径条目本身，因此末级符号链接被报告为 `symlink` 而不会被跟随。
  /** Describes the path entry itself, so a final symlink is reported as `symlink` rather than followed. */
  readonly stat: (path: string) => Effect.Effect<FileInfo, NotFound | Failed>
  // list 跟随末级符号链接到被列出的目录，但保留每个返回条目自身的类型。
  /** Follows a final symlink to the listed directory while preserving each returned entry's own type. */
  readonly list: (path: string) => Effect.Effect<ReadonlyArray<DirEntry>, NotFound | WrongKind | Failed>
  // remove：删除目标（目录时递归删除）
  readonly remove: (path: string) => Effect.Effect<void, Failed>
  // move：把 from 移动/重命名为 to
  readonly move: (from: string, to: string) => Effect.Effect<void, NotFound | Failed>
  // mkdir：创建目录
  readonly mkdir: (path: string) => Effect.Effect<void, Failed>
}

// Files：对外公开的文件操作接口（当前与 FilesImpl 等价）
export interface Files extends FilesImpl {}

/**
 * Derives a follow-stat kind from the lstat-like Files contract. A dangling
 * symlink fails with `NotFound`.
 *
 * 中文说明：在“lstat 风格”的 Files 契约之上推导“跟随链接后”的类型；悬空符号链接（目标不存在）将以 `NotFound` 失败。
 */
export const typeFollowing = (files: Files, path: string) =>
  files.stat(path).pipe(
    // 拿到 stat 的类型后决定是否需要进一步跟随
    Effect.flatMap((info) =>
      // 末级是符号链接时，用零长度 read（同样跟随链接）探测目标的真实类型
      info.type === "symlink"
        ? files.read(path, { offset: 0, length: 0 }).pipe(
            // read 成功即取其 info.type 作为跟随后的类型
            Effect.map((result) => result.info.type),
            // 若 read 因类型不符失败（例如链接指向目录），直接采用错误里携带的实际类型
            Effect.catchTag("Environment.WrongKind", (error) => Effect.succeed(error.actual)),
          )
        // 非符号链接则类型就是 stat 报告的类型
        : Effect.succeed(info.type),
    ),
  )

// 跟随末级符号链接判断存在性，因此悬空符号链接视为不存在。
/** Follows a final symlink, so a dangling symlink does not exist. */
export const exists = (files: Files, path: string) =>
  typeFollowing(files, path).pipe(
    // 类型可解析即视为存在，把结果常量化为 true
    Effect.as(true),
    // NotFound 错误统一转成 false（不存在）
    Effect.catchTag("Environment.NotFound", () => Effect.succeed(false)),
  )

// 以命名空间形式整体导出本模块
export * as EnvironmentFiles from "./files.js"
