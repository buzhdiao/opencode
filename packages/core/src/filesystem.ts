// 文件系统（FileSystem）：面向位置（Location）的读取/列目录/搜索/写入文件系统服务。
export * as FileSystem from "./filesystem.js"

import { makeLocationNode } from "@opencode/util/effect/app-node"
import path from "path"
import { Context, Effect, Layer, type Option, type PlatformError, Schema, type Stream } from "effect"
import { FSUtil } from "@opencode/util/fs-util"
import { Location } from "./location.js"
import { AbsolutePath, PositiveInt, RelativePath } from "./schema.js"
import { FileSystemSearch } from "./filesystem/search.js"
import { Entry, FileSystem, FindInput, Write } from "@opencode/schema/filesystem"
export { Entry, Match, Submatch } from "@opencode/schema/filesystem"

// 读取输入：位置相对路径
export interface ReadInput {
  readonly path: RelativePath
}

// 写入输入：绝对路径，或相对位置目录的路径
export interface WriteInput {
  /** Absolute, or relative to the location directory. */
  readonly path: string
  readonly data: Uint8Array
}

// 文件未找到错误
export class NotFoundError extends Schema.TaggedError<NotFoundError>()("FileSystem.NotFoundError", {
  // 未找到的相对路径
  path: RelativePath,
}) {}

// 目录未找到错误（携带底层平台原因）
export class DirectoryNotFoundError extends Schema.TaggedError<DirectoryNotFoundError>()(
  "FileSystem.DirectoryNotFoundError",
  {
    // 未找到的目录
    directory: AbsolutePath,
    // 底层平台错误
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Directory not found: ${this.directory}`
  }
}

// 目录访问被拒错误（携带底层平台原因）
export class DirectoryAccessDeniedError extends Schema.TaggedError<DirectoryAccessDeniedError>()(
  "FileSystem.DirectoryAccessDeniedError",
  {
    // 被拒绝访问的目录
    directory: AbsolutePath,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Access denied to directory: ${this.directory}`
  }
}

// 文件内容（Content）结构：URI、名称、文本内容、编码与 MIME 类型
export const Content = Schema.Struct({
  uri: Schema.String,
  name: Schema.String.pipe(Schema.optional),
  content: Schema.String,
  encoding: Schema.Literals(["utf8", "base64"]),
  mime: Schema.String,
}).annotate({ identifier: "FileSystem.Content" })
export type Content = typeof Content.Type

// 列目录输入：可选路径，缺省为位置根目录
export interface ListInput {
  readonly path?: string
}

export { FindInput, Write }

// 搜索默认条数上限
export const DEFAULT_SEARCH_LIMIT = 100
// 搜索默认超时（毫秒）
export const DEFAULT_SEARCH_TIMEOUT_MS = 30_000

// Glob 搜索输入：模式、路径、是否含隐藏文件与条数上限
export class GlobInput extends Schema.Class<GlobInput>("FileSystem.GlobInput")({
  pattern: Schema.String,
  path: Schema.optionalKey(RelativePath),
  hidden: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(PositiveInt),
}) {}

// Grep 搜索输入：模式、路径、文件名通配、字面量/大小写开关与条数上限
export class GrepInput extends Schema.Class<GrepInput>("FileSystem.GrepInput")({
  pattern: Schema.String,
  path: Schema.optionalKey(RelativePath),
  include: Schema.optionalKey(Schema.String),
  literal: Schema.optionalKey(Schema.Boolean),
  caseSensitive: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(PositiveInt),
}) {}

// 文件系统事件定义，直接复用 schema 中的定义
export const Event = FileSystem.Event

// 读文件结果（File）：MIME、大小、修改时间与惰性字节流工厂
export interface File {
  readonly mime: string
  readonly size: number
  readonly mtime: Option.Option<Date>
  readonly stream: (options?: {
    readonly offset?: number
    readonly bytesToRead?: number
  }) => Stream.Stream<Uint8Array, PlatformError.PlatformError>
}

// 服务接口
export interface Interface {
  readonly read: (input: ReadInput) => Effect.Effect<File, NotFoundError>
  /** Fails with `NotFoundError` when the path is missing or is not a directory. */
  // 路径缺失或不是目录时以 NotFoundError 失败
  readonly list: (input?: ListInput) => Effect.Effect<Entry[], NotFoundError>
  // 文件搜索
  readonly find: (input: FindInput) => Effect.Effect<Entry[]>
  /** Writes a file at an absolute path or one relative to the location; not confined to it. */
  // 在绝对路径或位置相对路径处写入文件；不局限于位置之内
  readonly write: (input: WriteInput) => Effect.Effect<Write>
}

// Effect 服务令牌
export class Service extends Context.Service<Service, Interface>()("@opencode/FileSystem") {}

// 基础层：实现路径解析、读取、列目录与写入
const baseLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 底层文件系统工具服务
    const fs = yield* FSUtil.Service
    // 当前位置服务
    const location = yield* Location.Service
    // 搜索子服务
    const search = yield* FileSystemSearch.Service
    // Workspace-placed directories exist only inside the workspace, so a host
    // realpath probe at boot consults the wrong filesystem and would block
    // construction on servers without a matching local directory. Treat the
    // configured directory as canonical; local placements keep symlink
    // canonicalization. This skip is boot-only: resolve/read/list below still
    // access the host filesystem per operation (tracked in #44568).
    // 根目录确定：工作区（workspace）放置的目录仅存在于工作区内，启动时跳过 realpath 探测；本地放置仍做符号链接规范化
    const root = location.workspaceID
      ? location.directory
      : yield* fs.realPath(location.directory).pipe(
          // Linux realpath succeeds on an unreadable directory, so probe readability explicitly.
          // Linux 的 realpath 对不可读目录也会成功，因此显式探测可读性
          Effect.tap((real) => fs.access(real, { readable: true })),
          Effect.catch((cause): Effect.Effect<never, DirectoryNotFoundError | DirectoryAccessDeniedError> => {
            // 原因是"未找到"则映射为目录未找到错误
            if (cause.reason._tag === "NotFound")
              return Effect.fail(new DirectoryNotFoundError({ directory: location.directory, cause }))
            // 访问被拒则映射为访问拒绝错误
            if (FSUtil.isAccessDenied(cause))
              return Effect.fail(new DirectoryAccessDeniedError({ directory: location.directory, cause }))
            // 其他原因视为缺陷（defect）直接崩溃
            return Effect.die(cause)
          }),
        )
    // 路径解析：拒绝空字节、逃逸位置目录与根目录之外的符号链接目标
    const resolve = Effect.fnUntraced(function* (input: RelativePath) {
      // 含空字节视为非法路径
      if (input.includes("\u0000")) return yield* Effect.fail(new NotFoundError({ path: input }))
      // 解析为绝对路径
      const absolute = path.resolve(location.directory, input)
      // 词法上逃逸出位置目录则拒绝
      if (!FSUtil.contains(location.directory, absolute)) return yield* Effect.fail(new NotFoundError({ path: input }))
      const real = yield* fs.realPath(absolute).pipe(
        // 解析真实路径（穿透符号链接）
        Effect.catchReason(
          "PlatformError",
          "NotFound",
          // 未找到映射为 NotFoundError
          () => Effect.fail(new NotFoundError({ path: input })),
          // 其他平台错误视为缺陷
          (_, error) => Effect.die(error),
        ),
      )
      // 真实路径逃逸出根目录则拒绝
      if (!FSUtil.contains(root, real)) return yield* Effect.fail(new NotFoundError({ path: input }))
      return { absolute, real, directory: location.directory }
    })
    return Service.of({
      // 搜索直接委托给搜索子服务
      find: search.find,
      read: Effect.fn("FileSystem.read")(function* (input) {
        // 先解析并校验路径
        const target = yield* resolve(input.path)
        const info = yield* fs.stat(target.real).pipe(
          // stat 真实路径获取元信息
          Effect.catchReason(
            "PlatformError",
            "NotFound",
            () => Effect.fail(new NotFoundError({ path: input.path })),
            (_, error) => Effect.die(error),
          ),
        )
        // 不是普通文件则按未找到处理
        if (info.type !== "File") return yield* Effect.fail(new NotFoundError({ path: input.path }))
        return {
          // 按路径推断 MIME 类型
          mime: FSUtil.mimeType(target.real),
          // 文件大小
          size: Number(info.size),
          // 修改时间（可能缺失）
          mtime: info.mtime,
          // 惰性字节流读取器
          stream: (options) => fs.stream(target.real, options),
        }
      }),
      list: Effect.fn("FileSystem.list")(function* (input = {}) {
        // Navigation can leave the cwd without activating another Location.
        // 目录解析允许跳出当前工作目录，而不必激活另一个位置
        const directory = path.resolve(location.directory, input.path ?? ".")
        // 预构造未找到错误
        const missing = new NotFoundError({ path: RelativePath.make(input.path ?? ".") })
        const info = yield* fs.stat(directory).pipe(
          Effect.catchReason(
            "PlatformError",
            "NotFound",
            () => Effect.fail(missing),
            (_, error) => Effect.die(error),
          ),
        )
        // 不是目录则报未找到
        if (info.type !== "Directory") return yield* missing
        return yield* fs.readDirectoryEntries(directory).pipe(
          Effect.orDie,
          Effect.map((items) =>
            items
              .flatMap((item) => {
                // 跳过符号链接等其他类型
                if (item.type !== "File" && item.type !== "Directory") return []
                const type = item.type === "Directory" ? "directory" : "file"
                const absolute = path.join(directory, item.name)
                // 相对位置目录的路径，位置根记为 "."
                const relative = path.relative(location.directory, absolute) || "."
                return [
                  Entry.make({
                    // 目录条目路径以分隔符结尾
                    path: RelativePath.make(relative + (type === "directory" ? path.sep : "")),
                    type,
                  }),
                ]
              })
              // 同类按名称排序，目录排在前
              .sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === "directory" ? -1 : 1)),
          ),
        )
      }),
      // Unlike read, write reaches outside the location so clients can stage files in the
      // server tmp directory, which the model is already told to prefer and permitted to access.
      // 与 read 不同，write 允许写到位置之外（如服务器 tmp 目录），供客户端暂存文件
      write: Effect.fn("FileSystem.write")(function* (input) {
        // 解析目标路径（可为绝对或相对）
        const target = path.resolve(location.directory, input.path)
        // 写入数据并按需创建父目录
        yield* fs.writeWithDirs(target, input.data).pipe(Effect.orDie)
        return Write.make({ path: AbsolutePath.make(target) })
      }),
    })
  }),
)

// 位置节点：文件系统服务随位置装配，依赖底层 FS、位置与搜索节点
export const node = makeLocationNode({
  service: Service,
  layer: baseLayer,
  deps: [FSUtil.node, Location.node, FileSystemSearch.node],
})
