// 从 effect 库导入 Effect（效果类型）与 Stream（流式数据）
import { Effect, Stream } from "effect"
// 导入 ChildProcess 模块：用于描述子进程命令
import { ChildProcess } from "effect/process"
// 仅作类型导入：ChildProcessSpawner 服务类型
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
// 导入 collectStream：把流收集为缓冲区（带大小上限）的工具
import { collectStream } from "@opencode/util/process"
// 仅作类型导入：Driver 驱动器接口
import type { Driver } from "./driver.js"
// 导入错误类型与 Files 相关类型定义
import { Failed, NotFound, WrongKind, type FileInfo, type Files, type FileType, type FilesImpl } from "./files.js"

/**
 * Files derived from spawning processes: one process per intent, "$1" is
 * always the target path. Scripts report classification through an exit-code
 * protocol (44/45/46) so failures never require parsing localized error text;
 * LC_ALL=C pins the one stderr match that remains. Requires GNU coreutils and
 * findutils in the target image — BSD and busybox userlands will not work.
 * Malformed output from these scripts is our own bug and dies as a defect.
 *
 * 中文说明：本文件的 Files 实现基于“派生进程”完成——每个操作启动一个进程，"$1" 恒为目标路径。
 * 脚本通过退出码协议（44/45/46）报告分类结果，因此失败时无需解析本地化错误文本；
 * LC_ALL=C 固定 stderr 中唯一需要匹配的那段文本。目标镜像需装有 GNU coreutils 与 findutils
 * ——BSD 和 busybox 用户态不可用。脚本输出格式错误属于我们自身的 bug，按缺陷（defect）处理直接崩溃。
 */

// 数据（stdout）收集上限：64 MiB，超出即失败，防止无限内存占用
const MAX_DATA_BYTES = 64 * 1024 * 1024
// 错误（stderr）收集上限：64 KiB，足够容纳分类信息
const MAX_ERROR_BYTES = 64 * 1024
// 退出码协议：44 表示目标不存在（NOT_FOUND）
const NOT_FOUND = 44
// 退出码协议：45 表示类型不对（WRONG_KIND，如对目录调用 read）
const WRONG_KIND = 45
// 退出码协议：46 表示操作失败（FAILED）
const FAILED = 46
// 元数据字段之间的分隔符：制表符
const TAB = "\t"

// 生成“读取文件元数据”的 shell 片段：用 stat 取 类型/大小/修改时间，失败时按退出码协议分类
// flags 用于让调用方决定是否加 -L（跟随符号链接）
const loadMetadata = (flags = "") => `
metadata=$(stat ${flags} -c '%F${TAB}%s${TAB}%Y' -- "$1" 2>&1) || {
  case "$metadata" in
    *'No such file or directory'*|*'Not a directory'*) exit ${NOT_FOUND} ;;
    *) printf '%s' "$metadata" >&2; exit ${FAILED} ;;
  esac
}
`

// stat 脚本：先加载元数据，再原样输出（类型\t大小\t修改时间）
const statScript = `
${loadMetadata()}
printf '%s\n' "$metadata"
`

// read 脚本：加载（跟随链接的）元数据；仅允许常规文件，否则以 WRONG_KIND 退出；
// 先输出元数据行，再按是否传 range 参数决定用 dd 截取区间还是 cat 全量输出
const readScript = `
${loadMetadata("-L")}
kind=\${metadata%%${TAB}*}
if [ "$kind" != 'regular file' ] && [ "$kind" != 'regular empty file' ]; then
  printf '%s' "$kind" >&2
  exit ${WRONG_KIND}
fi
printf '%s\n' "$metadata"
if [ "$2" = range ]; then
  dd if="$1" iflag=skip_bytes,count_bytes skip="$3" count="$4" status=none
else
  cat -- "$1"
fi
`

// list 脚本：确认目标是目录后，用 find 列出直接子项（类型\0名称\0 的 NUL 分隔格式）
const listScript = `
${loadMetadata("-L")}
kind=\${metadata%%${TAB}*}
if [ "$kind" != directory ]; then
  printf '%s' "$kind" >&2
  exit ${WRONG_KIND}
fi
find -H "$1" -mindepth 1 -maxdepth 1 -printf '%y\\0%f\\0'
`

// move 脚本：确认源存在后，用 mv 移动到 "$2"（由附加参数传入）
const moveScript = `
${loadMetadata()}
mv -- "$1" "$2"
`

// 进程运行结果：退出码、标准输出、标准错误（均为字节数组）
interface Result {
  readonly exitCode: number
  readonly stdout: Uint8Array
  readonly stderr: Uint8Array
}

// 导出 execDefaults：基于进程派生器的 Files 默认实现（每个方法对应一段 shell 脚本）
export const execDefaults = (spawner: ChildProcessSpawner["Service"]): FilesImpl => {
  // run：统一执行入口——用 sh -c 运行脚本，收集输出与退出码，并把所有异常归一为 Failed
  const run = (
    path: string,
    script: string,
    args: ReadonlyArray<string> = [],
    stdin?: Uint8Array,
  ): Effect.Effect<Result, Failed> =>
    // scoped：为子进程的生命周期创建作用域，结束时自动清理
    Effect.scoped(
      Effect.gen(function* () {
        // 构造子进程命令：sh -c 脚本，"$0"=sh，"$1"=path，其余为附加参数
        const command = ChildProcess.make("sh", ["-c", script, "sh", path, ...args], {
          env: { LC_ALL: "C" },
          extendEnv: true,
          stdin: stdin === undefined ? undefined : Stream.make(stdin),
        })
        // 派生进程；派生失败同样归一为 Failed
        const handle = yield* spawner.spawn(command).pipe(Effect.mapError((cause) => new Failed({ path, cause })))
        // 并发收集 stdout、stderr 与退出码（三者互不阻塞）
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            collectStream(handle.stdout, MAX_DATA_BYTES),
            collectStream(handle.stderr, MAX_ERROR_BYTES),
            handle.exitCode,
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.mapError((cause) => new Failed({ path, cause })))
        // 任一输出流超出收集上限即判定失败，避免静默截断数据
        if (stdout.truncated || stderr.truncated) {
          return yield* new Failed({ path, cause: new Error("Process output exceeded its collection limit") })
        }
        // 返回原始字节数组形式的收集结果
        return { exitCode, stdout: stdout.buffer, stderr: stderr.buffer }
      }),
    )

  // classify：按退出码协议分类结果——0 成功、44 不存在、45 类型不对、46/其他为一般失败
  const classify = <A>(
    path: string,
    result: Result,
    success: (stdout: Uint8Array) => A,
  ): Effect.Effect<A, NotFound | WrongKind | Failed> => {
    // 退出码 0：调用 success 解析 stdout 产出最终值
    if (result.exitCode === 0) return Effect.sync(() => success(result.stdout))
    // 退出码 44：映射为 NotFound 错误
    if (result.exitCode === NOT_FOUND) return Effect.fail(new NotFound({ path }))
    // 退出码 45：从 stderr 解析实际类型并映射为 WrongKind 错误
    if (result.exitCode === WRONG_KIND) {
      return Effect.fail(new WrongKind({ path, actual: parseType(new TextDecoder().decode(result.stderr)) }))
    }
    // 其余退出码：归一为 Failed
    return Effect.fail(processFailure(path, result))
  }

  // complete：仅区分成功与失败（无类型分类需求），用于 write/remove/mkdir 等
  const complete = (path: string, result: Result) =>
    result.exitCode === 0 ? Effect.void : Effect.fail(processFailure(path, result))

  // 组装 FilesImpl 接口的各方法：每个方法即“跑对应脚本 + 分类/解析结果”
  return {
    // stat：运行 stat 脚本并用 classifyPlain 解析元数据行
    stat: (path) => run(path, statScript).pipe(Effect.flatMap((result) => classifyPlain(path, result, parseInfo))),
    // read：可带 range（offset/length）参数；结果首行是元数据，其后是文件内容
    read: (path, range) =>
      run(
        path,
        readScript,
        range === undefined ? ["whole"] : ["range", String(range.offset), String(range.length)],
      ).pipe(
        Effect.flatMap((result) =>
          classify(path, result, (stdout) => {
            // 找到首个换行符（ASCII 10）作为元数据头与文件体的分界
            const newline = stdout.indexOf(10)
            // 缺失元数据行属于协议被破坏，直接抛错（会被归为 defect）
            if (newline < 0) throw new Error("Missing read metadata header")
            // 返回解析出的文件信息与剩余部分的字节内容
            return {
              info: parseInfo(stdout.slice(0, newline)),
              bytes: stdout.slice(newline + 1),
            }
          }),
        ),
      ),
    // write：先确保父目录存在（mkdir -p），再通过 stdin 把字节写入目标文件
    write: (path, bytes) =>
      run(path, `mkdir -p "$(dirname "$1")" && cat > "$1"`, [], bytes).pipe(
        Effect.flatMap((result) => complete(path, result)),
      ),
    // list：运行 list 脚本并解析 NUL 分隔的目录条目
    list: (path) => run(path, listScript).pipe(Effect.flatMap((result) => classify(path, result, parseList))),
    // remove：递归强制删除目标
    remove: (path) => run(path, `rm -rf -- "$1"`).pipe(Effect.flatMap((result) => complete(path, result))),
    // move：把 from 移动到 to（to 作为 "$2" 传入）；协议上不会出现 WrongKind
    move: (from, to) =>
      run(from, moveScript, [to]).pipe(Effect.flatMap((result) => classifyPlain(from, result, () => undefined))),
    // mkdir：递归创建目录
    mkdir: (path) => run(path, `mkdir -p -- "$1"`).pipe(Effect.flatMap((result) => complete(path, result))),
  }
}

// `classify` 的简化版，适用于协议中永不报告 WrongKind 的脚本。
/** `classify` for scripts whose protocol never reports WrongKind. */
const classifyPlain = <A>(
  path: string,
  result: Result,
  success: (stdout: Uint8Array) => A,
): Effect.Effect<A, NotFound | Failed> => {
  // 退出码 0：解析 stdout 成功
  if (result.exitCode === 0) return Effect.sync(() => success(result.stdout))
  // 退出码 44：目标不存在
  if (result.exitCode === NOT_FOUND) return Effect.fail(new NotFound({ path }))
  // 其余：归一为 Failed
  return Effect.fail(processFailure(path, result))
}

// processFailure：把非协议退出码转换为 Failed 错误，优先携带 stderr 文本，否则带上退出码
const processFailure = (path: string, result: Result) =>
  new Failed({
    path,
    cause: new Error(new TextDecoder().decode(result.stderr).trim() || `Process exited with code ${result.exitCode}`),
  })

// parseInfo：解析 "类型\t大小\t修改时间(秒)" 元数据行为结构化 FileInfo
const parseInfo = (bytes: Uint8Array): FileInfo => {
  // 按制表符拆分出类型、大小、修改时间三个原始字段
  const [rawType, rawSize, rawMtime] = new TextDecoder().decode(bytes).trim().split(TAB)
  // 大小转为数字
  const size = Number(rawSize)
  // 修改时间由秒转为毫秒
  const mtimeMs = Number(rawMtime) * 1_000
  // 任一字段非法即视为脚本输出损坏（属于自身 bug，抛错成 defect）
  if (!rawType || !Number.isFinite(size) || !Number.isFinite(mtimeMs)) throw new Error("Invalid stat output")
  // 返回结构化的文件信息
  return { type: parseType(rawType), size, mtimeMs }
}

// parseType：把 stat/find 的类型文本归一化为 FileType 枚举
const parseType = (value: string): FileType => {
  // GNU stat 对常规文件的表述，或 find 的缩写 "f"
  if (value === "regular file" || value === "regular empty file" || value === "f") return "file"
  // 目录
  if (value === "directory" || value === "d") return "directory"
  // 符号链接
  if (value === "symbolic link" || value === "l") return "symlink"
  // 其他类型（socket、fifo、块/字符设备等）
  return "other"
}

// parseList：解析 find 输出的 "类型\0名称\0" 重复序列为目录条目数组
const parseList = (bytes: Uint8Array) => {
  // 解码并按 NUL 字符拆分字段
  const fields = new TextDecoder().decode(bytes).split("\0")
  // 丢弃末尾的空字段（最后一个 \0 之后的部分）
  fields.pop()
  // 字段数应为偶数（类型+名称成对），否则输出损坏
  if (fields.length % 2 !== 0) throw new Error("Invalid find output")
  // 每两个字段组合为一个条目：名称在前一对的第二个位置，类型在第一个位置
  return Array.from({ length: fields.length / 2 }, (_, index) => ({
    name: fields[index * 2 + 1],
    type: parseType(fields[index * 2]),
  }))
}

// 导出 makeFiles：把驱动的派生器交给 execDefaults，再叠加驱动的可选覆盖项
export const makeFiles = (driver: Driver): Files => ({
  ...execDefaults(driver.spawner),
  ...driver.overrides,
})

// 以命名空间形式整体导出本模块
export * as EnvironmentExecDefaults from "./exec-defaults.js"
