// 将本模块以命名空间（namespace）形式导出为 Ripgrep
export * as Ripgrep from "./ripgrep.js"

// 从 effect 导入上下文、Effect、Fiber、Layer、Schema、Stream 等工具
import { Context, Effect, Fiber, Layer, Schema, Stream } from "effect"
// 导入 effect 的子进程构造器
import { ChildProcess } from "effect/process"
// 导入文件系统条目（Entry）与搜索匹配（Match）的 schema
import { Entry, Match } from "@opencode/schema/filesystem"
// 导入构建分层节点的辅助函数
import { makeLocationNode } from "@opencode/util/effect/app-node"
// 导入流收集与中止等待的工具函数
import { collectStream, waitForAbort } from "@opencode/util/process"
// 导入环境（Environment）服务，提供进程执行入口
import { Environment } from "./environment/index.js"
// 导入通用数值与路径 schema
import { NonNegativeInt, PositiveInt, RelativePath } from "./schema.js"
// 导入 ripgrep 可执行文件定位服务
import { RipgrepBinary } from "./ripgrep/binary.js"

/**
 * Small core-owned ripgrep execution adapter. It deliberately exposes raw
 * process-oriented rows, not model text or permission behavior. Search maps
 * these rows into filesystem results; leaf tools own
 * presentation and permission prompts.
 */
// 模块说明：核心内置的 ripgrep 执行适配器，刻意只暴露面向进程的原始行数据，
// 不做模型文本或权限行为处理；搜索功能将这些行映射为文件系统结果，
// 展示与权限提示由叶子工具负责。

// stderr 捕获上限：8KB
const ERROR_BYTES = 8 * 1024
// 单行允许的最大子匹配（submatch）数
const MAX_SUBMATCHES = 100
// 单行文本最大字符数，超长截断
const MAX_LINE_CHARS = 2_000

// ripgrep JSON 输出中 type=match 行的结构 schema
const RawMatch = Schema.Struct({
  // 行类型必须是 "match"
  type: Schema.Literal("match"),
  // 匹配数据体
  data: Schema.Struct({
    // 匹配文件路径
    path: Schema.Struct({ text: Schema.String }),
    // 匹配所在行的原文
    lines: Schema.Struct({ text: Schema.String }),
    // 行号（正整数）
    line_number: PositiveInt,
    // 在文件中的绝对偏移（非负整数）
    absolute_offset: NonNegativeInt,
    // 子匹配列表：每个含匹配文本与其起止偏移
    submatches: Schema.Array(
      Schema.Struct({
        match: Schema.Struct({ text: Schema.String }),
        start: NonNegativeInt,
        end: NonNegativeInt,
      }),
    ),
  }),
})
// 将一行文本解码为 JSON 值的 Effect
const decodeJsonRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))

// 原始匹配数据的类型别名
type RawMatchData = (typeof RawMatch.Type)["data"]

// ripgrep 执行失败错误（可携带底层原因）
export class Error extends Schema.TaggedError<Error>()("Ripgrep.Error", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

// 搜索模式（正则）非法错误
export class InvalidPatternError extends Schema.TaggedError<InvalidPatternError>()("Ripgrep.InvalidPatternError", {
  pattern: Schema.String,
  message: Schema.String,
}) {}

// 文件查找（find）的输入类型
export interface FindInput {
  // 工作目录
  readonly cwd: string
  // 文件名 glob 模式
  readonly pattern: string
  // 结果数量上限
  readonly limit: number
  // 需要排除的 glob 模式列表
  readonly exclude?: readonly string[]
  // 是否包含隐藏文件
  readonly hidden?: boolean
  // 是否跟随符号链接
  readonly follow?: boolean
  // 中止信号（AbortSignal）
  readonly signal?: AbortSignal
  // 每产出一个条目时的可选回调
  readonly onEntry?: (entry: Entry) => Effect.Effect<void>
}

// 文件名通配（glob）的输入类型
export interface GlobInput {
  // 工作目录
  readonly cwd: string
  // glob 模式
  readonly pattern: string
  // 结果数量上限
  readonly limit: number
  // 是否包含隐藏文件
  readonly hidden?: boolean
  // 是否跟随符号链接
  readonly follow?: boolean
  // 中止信号
  readonly signal?: AbortSignal
}

// 内容搜索（grep）的输入类型
export interface GrepInput {
  // 工作目录
  readonly cwd: string
  // 搜索模式（正则或字面量）
  readonly pattern: string
  // 限定搜索单个文件（缺省为整个目录）
  readonly file?: string
  // 文件名包含过滤 glob
  readonly include?: string
  // 是否按字面量（非正则）匹配
  readonly literal?: boolean
  // 是否区分大小写（false 时忽略大小写）
  readonly caseSensitive?: boolean
  // 结果数量上限
  readonly limit: number
  // 中止信号
  readonly signal?: AbortSignal
}

// 服务接口：文件查找、glob 与内容搜索
export interface Interface {
  readonly find: (input: FindInput) => Effect.Effect<readonly Entry[], Error>
  readonly glob: (input: GlobInput) => Effect.Effect<readonly Entry[], Error>
  readonly grep: (input: GrepInput) => Effect.Effect<readonly Match[], Error | InvalidPatternError>
}

// 定义 Ripgrep 服务
export class Service extends Context.Service<Service, Interface>()("@opencode/Ripgrep") {}

// 构造通用失败错误的辅助函数
const failure = (message: string, cause?: unknown) => new Error({ message, cause })

// 规范化 ripgrep 输出的路径：去 ./ 前缀、去开头斜杠、统一反斜杠为正斜杠
const normalizePath = (value: string) =>
  value
    .replace(/^(?:\.[\\/])+/u, "")
    .replace(/^[\\/]+/u, "")
    .replaceAll("\\", "/")

// 判断 stderr 是否表明正则模式非法
const isInvalidPattern = (stderr: string) =>
  stderr.includes("regex parse error") || stderr.includes("error parsing regex")

// 服务实现层
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 依赖：环境服务（提供进程派生）
    const environment = yield* Environment.Service
    // 依赖：ripgrep 二进制定位
    const binary = yield* RipgrepBinary.Service

    // 通用执行器：spawn ripgrep，逐行解析，处理限额、截断、退出码与中止
    const run = <A>(input: {
      readonly cwd: string
      readonly args: string[]
      readonly limit: number
      readonly signal?: AbortSignal
      readonly parse: (line: string) => Effect.Effect<A | undefined, Error>
      readonly pattern?: string
      readonly onItem?: (item: A) => Effect.Effect<void>
    }) => {
      // 在作用域内运行，保证进程资源在结束时清理
      const program = Effect.scoped(
        Effect.gen(function* () {
          // Hosted environments will resolve rg through their driver image; the spawner is the execution seam.
          // 托管环境会通过驱动镜像解析 rg；spawner 是执行接缝
          const handle = yield* environment.spawner.spawn(
            ChildProcess.make(yield* binary.filepath, input.args, { cwd: input.cwd, extendEnv: true, stdin: "ignore" }),
          )
          // 后台 fiber 持续收集 stderr（截断到上限），供错误诊断使用
          const stderrFiber = yield* collectStream(handle.stderr, ERROR_BYTES).pipe(
            Effect.map((output) => output.buffer.toString("utf8")),
            Effect.forkScoped,
          )
          // 已通过 onItem 通知的条目计数
          let observed = 0
          // 将 stdout 按行解码并逐行解析、过滤、通知、限额收集
          const rows = yield* Stream.decodeText(handle.stdout).pipe(
            // 按行切分
            Stream.splitLines,
            // 丢弃空行
            Stream.filter((line) => line.length > 0),
            // 调用调用方提供的解析器
            Stream.mapEffect(input.parse),
            // 过滤掉解析为 undefined 的行
            Stream.filter((row): row is A => row !== undefined),
            // 在限额内对每个条目触发 onItem 回调
            Stream.tap((row) => {
              // 无回调或已达限额时跳过
              if (!input.onItem || observed++ >= input.limit) return Effect.void
              return input.onItem(row)
            }),
            // 多取一条用于判断是否被截断
            Stream.take(input.limit + 1),
            Stream.runCollect,
          )
          // 行数超过限额说明结果被截断
          const truncated = rows.length > input.limit
          // 截断时只保留前 limit 条
          if (truncated) return rows.slice(0, input.limit)

          // 等待进程退出码
          const code = yield* handle.exitCode
          // 合并后台 fiber 得到完整 stderr 文本
          const stderr = yield* Fiber.join(stderrFiber)
          // 退出码 2 且 stderr 指向正则错误时返回非法模式错误
          if (input.pattern && code === 2 && isInvalidPattern(stderr)) {
            return yield* new InvalidPatternError({ pattern: input.pattern, message: stderr.trim() })
          }
          // 除 0（成功）、1（无匹配）、2（用法/错误）外的退出码都视为失败
          if (code !== 0 && code !== 1 && code !== 2) {
            return yield* failure(stderr.trim() || `ripgrep failed with code ${code}`)
          }
          // 退出码 1 表示无匹配，返回空数组
          return code === 1 ? [] : rows
        }),
      )
      // 提供中止信号时与中止等待竞争，先到先得
      const abortable = input.signal ? program.pipe(Effect.raceFirst(waitForAbort(input.signal))) : program
      // 统一错误通道：已知的本模块错误原样透传，其余包装为通用失败
      return abortable.pipe(
        Effect.mapError((cause) =>
          cause instanceof Error || cause instanceof InvalidPatternError
            ? cause
            : failure("ripgrep execution failed", cause),
        ),
      )
    }

    // 组装并返回服务实现
    return Service.of({
      // glob：按文件名模式列出文件
      glob: (input) =>
        run<string>({
          cwd: input.cwd,
          limit: input.limit,
          signal: input.signal,
          // 构造 rg --files 的命令行参数
          args: [
            // 忽略用户的 rg 配置文件
            "--no-config",
            // 列出文件模式
            "--files",
            // 需要时包含隐藏文件
            ...(input.hidden ? ["--hidden"] : []),
            // 需要时跟随符号链接
            ...(input.follow ? ["--follow"] : []),
            // 应用调用方的 glob 模式
            `--glob=${input.pattern}`,
            // Positive globs override rg's hidden-file filter; exclude before applying the result limit.
            // 未启用隐藏文件时排除点开头文件（正向 glob 会覆盖 rg 的隐藏过滤）
            ...(input.hidden ? [] : ["--glob=!**/.*"]),
            // 始终排除 .git 目录
            "--glob=!**/.git/**",
            // 从当前目录开始扫描
            ".",
          ],
          // 每行就是一个相对路径，直接规范化
          parse: (line) => Effect.succeed(normalizePath(line)),
        }).pipe(
          // 将每个路径包装为文件系统条目
          Effect.map((result) =>
            result.map((relative) =>
              Entry.make({
                path: RelativePath.make(relative),
                type: "file",
              }),
            ),
          ),
          // glob 不暴露“非法模式”这一具体错误，统一转为通用错误
          Effect.catchTag("Ripgrep.InvalidPatternError", (cause) => Effect.fail(failure(cause.message, cause))),
        ),
      // find：按 glob 查找文件，支持排除模式与逐条回调
      find: (input) =>
        run<Entry>({
          cwd: input.cwd,
          limit: input.limit,
          signal: input.signal,
          // 构造 rg --files 的命令行参数
          args: [
            // 忽略用户配置
            "--no-config",
            // 列出文件模式
            "--files",
            // 需要时包含隐藏文件
            ...(input.hidden ? ["--hidden"] : []),
            // 需要时跟随符号链接
            ...(input.follow ? ["--follow"] : []),
            // 万能模式 "*" 不必传给 rg，其他模式作为 glob 传入
            ...(input.pattern === "*" ? [] : [`--glob=${input.pattern}`]),
            // 将排除模式转成负向 glob
            ...(input.exclude ?? []).map((pattern) => `--glob=!${pattern}`),
            // 始终排除 .git 目录
            "--glob=!**/.git/**",
            // 从当前目录开始扫描
            ".",
          ],
          // 每行解析为一个文件条目
          parse: (line) => {
            const relative = normalizePath(line)
            return Effect.succeed(
              Entry.make({
                path: RelativePath.make(relative),
                type: "file",
              }),
            )
          },
          // 逐条目回调透传给调用方
          onItem: input.onEntry,
        }).pipe(Effect.catchTag("Ripgrep.InvalidPatternError", (cause) => Effect.fail(failure(cause.message, cause)))),
      // grep：内容搜索，输出结构化匹配结果
      grep: (input) =>
        run<RawMatchData>({
          ...input,
          // 构造 rg --json 的命令行参数
          args: [
            // 忽略用户配置
            "--no-config",
            // JSON 输出格式
            "--json",
            // 包含隐藏文件
            "--hidden",
            // 抑制 stderr 的杂项消息
            "--no-messages",
            // 字面量匹配时使用 --fixed-strings
            ...(input.literal ? ["--fixed-strings"] : []),
            // 不区分大小写时使用 --ignore-case
            ...(input.caseSensitive === false ? ["--ignore-case"] : []),
            // 文件名包含过滤 glob
            ...(input.include ? [`--glob=${input.include}`] : []),
            // 始终排除 .git 目录
            "--glob=!**/.git/**",
            // "--" 之后是位置参数，防止模式被当成选项
            "--",
            // 搜索模式
            input.pattern,
            // 目标文件或目录（缺省当前目录）
            input.file ?? ".",
          ],
          // 解析 JSON 行：只保留 type=match 的记录并做限幅处理
          parse: (line) =>
            decodeJsonRecord(line).pipe(
              // JSON 解析失败包装为通用错误
              Effect.mapError((cause) => failure("Invalid ripgrep JSON output", cause)),
              Effect.flatMap((json) => {
                // 非 match 类型（如 begin/end/summary）直接忽略
                if (!json || typeof json !== "object" || !("type" in json) || json.type !== "match")
                  return Effect.undefined
                // 按 schema 校验并变换 match 记录
                return Schema.decodeUnknownEffect(RawMatch)(json).pipe(
                  Effect.map((match) => ({
                    ...match.data,
                    lines: {
                      text:
                        // 超长行截断到上限并追加省略号
                        match.data.lines.text.length > MAX_LINE_CHARS
                          ? Buffer.from(match.data.lines.text.slice(0, MAX_LINE_CHARS), "utf8").toString() + "..."
                          : match.data.lines.text,
                    },
                    // 规范化路径分隔符
                    path: { text: normalizePath(match.data.path.text) },
                    // 限制子匹配数量
                    submatches: match.data.submatches.slice(0, MAX_SUBMATCHES),
                  })),
                  Effect.mapError((cause) => failure("Invalid ripgrep match output", cause)),
                )
              }),
            ),
        }).pipe(
          // 将原始匹配数据映射为对外的 Match 类型
          Effect.map((result) =>
            result.map((match) =>
              Match.make({
                entry: Entry.make({
                  path: RelativePath.make(match.path.text),
                  type: "file",
                }),
                line: match.line_number,
                offset: match.absolute_offset,
                text: match.lines.text,
                submatches: match.submatches.map((submatch) => ({
                  text: submatch.match.text,
                  start: submatch.start,
                  end: submatch.end,
                })),
              }),
            ),
          ),
        ),
    })
  }),
)

// 构建 Ripgrep 的分层节点，声明其依赖的节点
export const node = makeLocationNode({ service: Service, layer, deps: [Environment.node, RipgrepBinary.node] })
