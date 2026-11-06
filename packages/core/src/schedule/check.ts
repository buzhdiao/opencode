// 将本模块整体导出为 ScheduleCheck 命名空间
export * as ScheduleCheck from "./check.js"

// 导入 Code Mode（在沙箱中运行 JS 代码调用工具）模块
import { CodeMode } from "@opencode/codemode"
// 导入判断是否为普通对象的工具函数
import { isRecord } from "@opencode/util/record"
// 导入收集子进程流的工具
import { collectStream } from "@opencode/util/process"
// 导入 Schedule 的 schema 类型定义
import type { Schedule as ScheduleSchema } from "@opencode/schema/schedule"
// 导入 effect 核心：数组、时长、Effect、Option、Result、Schema
import { Array, Duration, Effect, Option, Result, Schema } from "effect"
// 导入子进程构造器
import { ChildProcess } from "effect/process"
// 导入 Agent 服务
import { Agent } from "../agent.js"
// 导入 Code Mode 工具辅助
import { CodeModeTool } from "../codemode/tool.js"
// 导入环境（spawner 等）服务
import { Environment } from "../environment/index.js"
// 导入文件访问控制服务
import { FileAccess } from "../file-access.js"
// 导入定位（工作目录/workspace）服务
import { Location } from "../location.js"
// 导入权限服务
import { Permission } from "../permission.js"
// 导入插件服务
import { Plugin } from "../plugin.js"
// 导入会话消息类型
import type { SessionMessage } from "../session/message.js"
// 导入会话 schema 类型
import type { SessionSchema } from "../session/schema.js"
// 导入 shell 命令解析（扫描目录/外部命令）
import { ShellParse } from "../shell/parse.js"
// 导入 shell 选择服务
import { ShellSelect } from "../shell/select.js"
// 导入工具服务
import { Tool } from "../tool.js"
// 导入 MCP 工具服务
import { McpTool } from "../tool/mcp.js"

// 导出单次检查的超时时间（30 秒）
export const TIMEOUT_MS = 30_000
// 输出上限：32 KiB，防止检查输出撑爆内存/数据库
const MAX_OUTPUT_BYTES = 32 * 1024
// Code Mode 执行限制：超时、最多 20 次工具调用、最大输出字节数
const CODE_LIMITS: CodeMode.ExecutionLimits = {
  timeoutMs: TIMEOUT_MS,
  maxToolCalls: 20,
  maxOutputBytes: MAX_OUTPUT_BYTES,
}

// 禁止在计划检查代码中调用的工具集合（防止定时任务创建/修改计划、移动会话、操作 worktree 等危险副作用）
const FORBIDDEN_CODE_TOOLS = new Set([
  "opencode.schedule_create",
  "opencode.schedule_pause",
  "opencode.schedule_resume",
  "opencode.schedule_delete",
  "opencode.session_move",
  "opencode.session_rename",
  "opencode.worktree_create",
  "opencode.worktree_remove",
])

// 定义 code 检查返回对象的解码器：wake 必填布尔，state/message 可选
const decodeCodeObjectResult = Schema.decodeUnknownResult(
  Schema.Struct({
    wake: Schema.Boolean,
    state: Schema.optionalKey(Schema.Json),
    message: Schema.optionalKey(Schema.String),
  }),
)

// 运行上下文：触发检查的消息 ID、当前时间戳、已运行次数
export interface RunContext {
  readonly messageID: SessionMessage.ID
  readonly now: number
  readonly checks: number
}

// 检查结果类型：成功（是否唤醒、携带状态、可选消息）或失败（错误信息、可选 invalid 标记表示配置本身无效）
export type Outcome =
  | {
      readonly ok: true
      readonly wake: boolean
      readonly state: Schema.Json
      readonly message?: string
    }
  | {
      readonly ok: false
      readonly error: string
      readonly invalid?: boolean
    }

/** Validates condition syntax synchronously before asking for permissions or spawning anything. */
// 同步校验条件语法，在请求权限或启动任何进程之前执行
export function validate(condition: ScheduleSchema.Condition): Result.Result<void, string> {
  // 按条件类型分派
  switch (condition.type) {
    // shell 条件校验
    case "shell": {
      // 命令不能为空白
      if (condition.run.trim() === "") return Result.fail("A shell check needs a command")
      // 统计 is/matches/changes 三个谓词中已设置的数量（最多只能选一个）
      const predicates = [
        condition.is !== undefined,
        condition.matches !== undefined,
        condition.changes !== undefined,
      ].filter(Boolean).length
      // 设置了多个谓词则报错
      if (predicates > 1) return Result.fail("Choose at most one of is, matches or changes")
      // 未设置 matches 则无需校验正则，直接通过
      if (condition.matches === undefined) return Result.succeed(undefined)
      // 尝试编译正则，捕获非法表达式错误并转成可读信息
      return Result.try({
        try: () => {
          new RegExp(condition.matches!)
        },
        catch: (cause) =>
          `Invalid regular expression ${JSON.stringify(condition.matches)}: ${cause instanceof Error ? cause.message : String(cause)}`,
      })
    }
    // code 条件校验
    case "code": {
      // 静态扫描代码中引用的工具
      const scanned = CodeMode.scanTools(condition.code)
      // 扫描失败（语法错误等）直接返回失败信息
      if (Result.isFailure(scanned)) return Result.fail(scanned.failure.message)
      // 遍历引用到的每个工具路径
      for (const path of scanned.success) {
        // 命中禁用工具集合则拒绝
        if (FORBIDDEN_CODE_TOOLS.has(path)) {
          return Result.fail(`Tool ${path} cannot be used inside a schedule check`)
        }
      }
      // 校验通过
      return Result.succeed(undefined)
    }
  }
}

// 生成人类可读的条件描述：shell 显示命令；code 显示首个非空代码行（截断到 60 字符）
export function describe(condition: ScheduleSchema.Condition): string {
  // 按条件类型分派
  switch (condition.type) {
    // shell 条件直接返回命令文本
    case "shell":
      return condition.run
    // code 条件取第一行有效代码作为摘要
    case "code": {
      // 按行拆分、去空白，找到第一个非空行
      const line = condition.code
        .split("\n")
        .map((item) => item.trim())
        .find((item) => item.length > 0)
      // 有内容则显示截断后的代码行，否则只返回 "code"
      return line ? `code (${line.slice(0, 60)})` : "code"
    }
  }
}

/** Runs in the Session's Location while the user is present; approves required permissions once without saving. */
// 授权入口：在用户在场时运行于会话的 Location 中，一次性批准所需权限且不保存
export const authorize = Effect.fnUntraced(function* (
  session: SessionSchema.Info,
  name: string | undefined,
  when: ScheduleSchema.When,
  check: ScheduleSchema.StoredCheck,
) {
  // 等待插件激活完成（插件可能影响权限判断）
  yield* Plugin.awaitActivation
  // 按检查条件类型分派到对应的授权流程
  switch (check.condition.type) {
    // shell 条件走 shell 授权
    case "shell":
      return yield* authorizeShell(session, name, when, check.mode, check.condition)
    // code 条件走 code 授权
    case "code":
      return yield* authorizeCode(session, name, when, check.mode, check.condition)
  }
})

/** Runs one check in the Session's Location under narrow unattended permissions and a 30s wall-clock cap. */
// 执行一次检查：运行于会话的 Location，使用受限的无人值守（unattended）权限，并施加 30 秒墙钟上限
export const evaluate = Effect.fnUntraced(function* (
  session: SessionSchema.Info,
  check: ScheduleSchema.StoredCheck,
  prevState: Schema.Json,
  context: RunContext,
) {
  // 内部实际运行的 Effect：等待插件激活后按条件类型分派
  const run = Effect.gen(function* () {
    yield* Plugin.awaitActivation
    switch (check.condition.type) {
      // shell 条件执行 shell 检查
      case "shell":
        return yield* runShell(session, check.condition, prevState)
      // code 条件执行 code 检查
      case "code":
        return yield* runCode(session, check.condition, prevState, context)
    }
  })
  // 运行并套上超时保护：超时则返回失败结果
  return yield* run.pipe(
    Effect.timeoutOption(TIMEOUT_MS),
    Effect.map((result): Outcome =>
      Option.match(result, {
        // 超时（无结果）：返回超时错误
        onNone: () => ({ ok: false, error: `Check timed out after ${TIMEOUT_MS}ms` }),
        // 正常完成：透传检查结果
        onSome: (outcome) => outcome,
      }),
    ),
  )
})

// 构造成功结果的辅助函数：wake 为真且提供了 message 时才附带 message 字段
const wakeOutcome = (wake: boolean, state: Schema.Json, message: string | undefined) => ({
  ok: true as const,
  wake,
  state,
  ...(wake && message !== undefined ? { message } : {}),
})

// 解析 code 检查用到的工具：校验工具存在且被允许，返回工具服务与所需权限动作列表
const codeActions = Effect.fnUntraced(function* (paths: ReadonlyArray<string>) {
  // 取出 MCP 工具服务
  const mcp = yield* McpTool.Service
  // 取出工具注册表服务
  const tools = yield* Tool.Service
  // 引用了工具时先刷新 MCP 工具（确保动态 MCP 工具已注册）
  if (paths.length > 0) yield* mcp.flush
  // 列出全部已注册工具
  const registered = yield* tools.list()
  // 解析结果列表
  const resolved: Array<(typeof registered)[number]> = []
  // 逐个解析工具路径
  for (const path of paths) {
    // 禁用工具直接失败
    if (FORBIDDEN_CODE_TOOLS.has(path)) {
      return yield* Effect.fail(`Tool ${path} cannot be used inside a schedule check`)
    }
    // 在注册表中查找匹配的 Code Mode 工具（须允许 codemode）
    const found = registered.find(
      (item) => item.options?.codemode !== false && CodeModeTool.qualifiedName(item) === path,
    )
    // 找不到则失败
    if (!found) return yield* Effect.fail(`Unknown Code Mode tool: ${path}`)
    // 需要“edit”权限的工具不允许出现在计划检查中
    if (found.options?.permission === "edit") {
      return yield* Effect.fail(`Tool ${path} cannot be used inside a schedule check`)
    }
    // 记录解析到的工具
    resolved.push(found)
  }
  // 返回工具服务与去重后的权限动作列表（优先用工具声明的 permission，否则用工具 id）
  return { tools, actions: Array.dedupe(resolved.map((tool) => tool.options?.permission ?? tool.id)) }
})

// code 条件的授权流程：请求用户批准代码检查所需的全部权限（不保存）
const authorizeCode = Effect.fnUntraced(function* (
  session: SessionSchema.Info,
  name: string | undefined,
  when: ScheduleSchema.When,
  mode: ScheduleSchema.CheckMode,
  condition: ScheduleSchema.CodeCondition,
) {
  // 取出权限服务
  const permission = yield* Permission.Service
  // 取出 Agent 服务
  const agents = yield* Agent.Service
  // 选择会话对应的 Agent
  const agent = yield* agents.select(session.agent)
  // 静态扫描代码中引用的工具
  const scanned = CodeMode.scanTools(condition.code)
  // 扫描失败则直接失败
  if (Result.isFailure(scanned)) return yield* Effect.fail(scanned.failure.message)
  // 取出工具路径列表
  const paths = scanned.success

  // 断言 execute 动作未被显式拒绝
  yield* permission.assertNotDenied({
    action: "execute",
    resources: ["*"],
    sessionID: session.id,
    agent: agent.id,
  })

  // 解析代码用到的工具与所需动作
  const actions = (yield* codeActions(paths)).actions

  // 不需要额外动作时：只请求一次 execute 权限（附带计划元数据）后返回
  if (actions.length === 0) {
    yield* permission.assert({
      action: "execute",
      resources: ["*"],
      metadata: { schedule: name, mode, when, unattended: true, code: condition.code, tools: [] },
      sessionID: session.id,
      agent: agent.id,
    })
    return
  }

  // Fail fast on any explicit deny before asking the user to approve earlier tools.
  // 先对所有动作逐一断言未被拒绝：在向用户请求批准前快速失败
  yield* Effect.forEach(
    actions,
    (action) =>
      permission.assertNotDenied({
        action,
        resources: ["*"],
        sessionID: session.id,
        agent: agent.id,
      }),
    { discard: true },
  )

  // 逐个请求用户批准各动作所需的权限
  yield* Effect.forEach(
    actions,
    (action) =>
      permission.assert({
        action,
        resources: ["*"],
        // No `save`: "always" would save a project-wide allow, while scheduled ticks run via Unattended.
        // 不传 save：不能把“总是允许”存成项目级规则，计划触发走无人值守通道
        metadata: { schedule: name, mode, when, unattended: true, code: condition.code, tools: [...paths] },
        sessionID: session.id,
        agent: agent.id,
      }),
    { discard: true },
  )
})

// 运行 code 检查：执行用户代码并解释返回值（布尔或 { wake, state?, message? }）
const runCode = Effect.fnUntraced(function* (
  session: SessionSchema.Info,
  condition: ScheduleSchema.CodeCondition,
  prevState: Schema.Json,
  context: RunContext,
) {
  // 取出权限服务
  const permission = yield* Permission.Service
  // 取出 Agent 服务
  const agents = yield* Agent.Service
  // 选择会话对应的 Agent
  const agent = yield* agents.select(session.agent)
  // 找不到 Agent 信息则失败
  if (!agent.info) return { ok: false as const, error: `Agent not found: ${agent.id}` }

  // 静态扫描代码引用的工具
  const scanned = CodeMode.scanTools(condition.code)
  // 扫描失败则失败
  if (Result.isFailure(scanned)) return { ok: false as const, error: scanned.failure.message }
  // 工具路径列表
  const paths = scanned.success

  // 解析工具与动作（捕获失败为 Result）
  const resolved = yield* Effect.result(codeActions(paths))
  // 解析失败则失败
  if (Result.isFailure(resolved)) return { ok: false as const, error: resolved.failure }

  // 所需权限动作列表
  const actions = resolved.success.actions
  // 构造无人值守权限规则集：execute + 各动作一律允许（仅限本次检查）
  const unattended: Permission.Ruleset = ["execute", ...actions].map((action) => ({
    action,
    resource: "*",
    effect: "allow" as const,
  }))

  // 在无人值守规则下再次断言各动作未被显式拒绝（结果转 Result）
  const notDenied = yield* Effect.forEach(
    ["execute", ...actions],
    (action) =>
      permission.assertNotDenied({
        action,
        resources: ["*"],
        sessionID: session.id,
        agent: agent.id,
      }),
    { discard: true },
  ).pipe(Effect.provideService(Permission.Unattended, unattended), Effect.result)

  // 存在被拒绝的动作则失败
  if (Result.isFailure(notDenied)) return { ok: false as const, error: notDenied.failure.message }

  // 注入到代码执行环境的绑定变量：上一次状态、当前时间、运行次数（input 为兼容别名）
  const bindings: Record<string, Schema.Json> = {
    state: prevState,
    now: context.now,
    runs: context.checks,
    input: { state: prevState, now: context.now, runs: context.checks },
  }

  // 运行代码：合并 Agent 与会话权限，套用执行限制，提供无人值守权限规则
  const result = yield* resolved.success.tools
    .check({
      code: condition.code,
      tools: paths,
      bindings,
      permissions: Permission.merge(agent.info.permissions, session.permissions ?? []),
      limits: CODE_LIMITS,
      context: {
        sessionID: session.id,
        agent: agent.id,
        messageID: context.messageID,
        progress: () => Effect.void,
      },
    })
    .pipe(Effect.provideService(Permission.Unattended, unattended))

  // 执行出错：判断是否属于“配置无效”类错误（解析错误、不支持的语法、未知工具、非法入参、需要批准）
  if (!result.ok) {
    const invalid =
      result.error.kind === "ParseError" ||
      result.error.kind === "UnsupportedSyntax" ||
      result.error.kind === "UnknownTool" ||
      result.error.kind === "InvalidToolInput" ||
      result.error.message.includes("needs approval")
    // 返回失败结果，invalid 为真时附带该标记（调用方可据此停用计划）
    return { ok: false as const, error: result.error.message, ...(invalid ? { invalid: true } : {}) }
  }
  // 返回布尔值：直接作为 wake 信号，状态保持不变
  if (typeof result.value === "boolean") {
    return { ok: true as const, wake: result.value, state: prevState }
  }
  // 返回对象：按 schema 解码校验
  const decoded = decodeCodeObjectResult(result.value)
  // 解码失败：返回失败并标记 invalid（返回类型不符合约定）
  if (Result.isFailure(decoded)) {
    return {
      ok: false as const,
      error: `A code check must return a boolean or { wake, state?, message? }: ${decoded.failure}`,
      invalid: true,
    }
  }
  // 未返回 state 时沿用上一次状态
  const state = decoded.success.state === undefined ? prevState : decoded.success.state
  // 去除消息首尾空白，空串视为无消息
  const trimmed = decoded.success.message?.trim()
  const message = trimmed ? trimmed : undefined
  // 组装成功结果
  return wakeOutcome(decoded.success.wake, state, message)
})

// 扫描 shell 命令：解析工作目录、所用 shell、涉及的目录与外部命令，供权限检查
const scanShell = Effect.fnUntraced(function* (command: string) {
  // 取出定位服务
  const location = yield* Location.Service
  // 取出文件访问服务
  const access = yield* FileAccess.Service
  // 取出 shell 选择服务
  const shellSelect = yield* ShellSelect.Service
  // 把工作目录解析为受控访问目标（失败转成错误消息）
  const target = yield* access
    .resolve({ path: location.directory, kind: "directory" })
    .pipe(Effect.mapError((error) => error.message))
  // 按兼容性优先选择 shell
  const shell = yield* shellSelect.resolve({ priority: "compat" })
  // 扫描命令：找出其中出现的目录与外部命令
  const parsed = yield* ShellParse.scan(command, shell, target.absolute).pipe(
    Effect.mapError((error) => error.message),
  )
  // 把命令里引用的每个目录解析为访问目标
  const directories = yield* Effect.forEach(parsed.directories, (directory) =>
    access
      .resolve({ path: FileAccess.resolvePath(target.absolute, directory), kind: "directory" })
      .pipe(Effect.mapError((error) => error.message)),
  )
  // 收集所有外部目录资源并去重
  const external = Array.dedupe(
    [target, ...directories].flatMap((item) => (item.externalDirectory ? [item.externalDirectory.resource] : [])),
  )
  // 收集所有外部命令资源并去重
  const commands = Array.dedupe(parsed.commands.map((item) => item.resource))
  // 返回扫描结果：shell、工作目录、workspaceID、外部目录、命令列表
  return { shell, cwd: target.absolute, workspaceID: location.workspaceID, external, commands }
})

// 断言 shell 扫描结果所需的权限（外部目录与 shell 命令），可附带元数据
const assertShellPermissions = Effect.fnUntraced(function* (
  session: SessionSchema.Info,
  scanned: { readonly external: ReadonlyArray<string>; readonly commands: ReadonlyArray<string> },
  metadata?: Record<string, unknown>,
) {
  // 取出权限服务
  const permission = yield* Permission.Service
  // 取出 Agent 服务
  const agents = yield* Agent.Service
  // 选择会话对应的 Agent
  const agent = yield* agents.select(session.agent)
  // 涉及外部目录时请求 external_directory 权限
  if (scanned.external.length > 0) {
    yield* permission.assert({
      action: "external_directory",
      resources: [...scanned.external],
      ...(metadata === undefined ? {} : { metadata }),
      sessionID: session.id,
      agent: agent.id,
    })
  }
  // 涉及命令时请求 shell 权限
  if (scanned.commands.length > 0) {
    yield* permission.assert({
      action: "shell",
      resources: [...scanned.commands],
      ...(metadata === undefined ? {} : { metadata }),
      sessionID: session.id,
      agent: agent.id,
    })
  }
})

// shell 条件的授权流程：扫描命令并请求用户批准（不保存）
const authorizeShell = Effect.fnUntraced(function* (
  session: SessionSchema.Info,
  name: string | undefined,
  when: ScheduleSchema.When,
  mode: ScheduleSchema.CheckMode,
  condition: ScheduleSchema.ShellCondition,
) {
  // 扫描命令
  const scanned = yield* scanShell(condition.run)
  // 携带计划元数据断言权限
  yield* assertShellPermissions(session, scanned, {
    schedule: name,
    mode,
    when,
    unattended: true,
    run: condition.run,
  })
})

// 运行 shell 检查：在无人值守权限下执行命令并按谓词判定是否唤醒
const runShell = Effect.fnUntraced(function* (
  session: SessionSchema.Info,
  condition: ScheduleSchema.ShellCondition,
  prevState: Schema.Json,
) {
  // 取出环境服务（提供 spawner）
  const environment = yield* Environment.Service
  // 扫描命令（失败转 Result）
  const scannedExit = yield* Effect.result(scanShell(condition.run))
  // 扫描失败返回失败结果
  if (Result.isFailure(scannedExit)) return { ok: false as const, error: scannedExit.failure } satisfies Outcome
  // 扫描结果
  const scanned = scannedExit.success
  // 构造无人值守规则集：外部目录与命令全部允许
  const unattended: Permission.Ruleset = [
    ...scanned.external.map((resource) => ({ action: "external_directory", resource, effect: "allow" as const })),
    ...scanned.commands.map((resource) => ({ action: "shell", resource, effect: "allow" as const })),
  ]
  // 在无人值守规则下执行权限断言（结果转 Result）
  const authorized = yield* assertShellPermissions(session, scanned).pipe(
    Effect.provideService(Permission.Unattended, unattended),
    Effect.result,
  )
  // 权限被拒则失败
  if (Result.isFailure(authorized)) return { ok: false as const, error: authorized.failure.message }

  // 在作用域内启动并等待子进程完成
  const executed = yield* Effect.scoped(
    Effect.gen(function* () {
      // 构造子进程：用选定 shell 执行命令；非 Windows 时脱离进程组；3 秒宽限后强杀
      const proc = ChildProcess.make(scanned.shell, ShellSelect.args(scanned.shell, condition.run), {
        cwd: scanned.cwd,
        ...(scanned.workspaceID === undefined ? { env: process.env } : {}),
        stdin: "ignore",
        detached: process.platform !== "win32",
        forceKillAfter: Duration.seconds(3),
      })
      // 通过环境的 spawner 启动进程
      const handle = yield* environment.spawner.spawn(proc)
      // 并发收集 stdout、stderr（各限 32KiB）与退出码
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectStream(handle.stdout, MAX_OUTPUT_BYTES),
          collectStream(handle.stderr, MAX_OUTPUT_BYTES),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      )
      // 返回退出码与 UTF-8 解码后的输出
      return {
        exitCode,
        stdout: utf8Decode(stdout.buffer),
        stderr: utf8Decode(stderr.buffer),
      }
    }),
  ).pipe(Effect.result)

  // 执行抛错（如进程启动失败）则转为失败结果
  if (Result.isFailure(executed)) {
    return {
      ok: false as const,
      error: executed.failure instanceof Error ? executed.failure.message : String(executed.failure),
    }
  }

  // 执行结果
  const output = executed.success
  // 去除 stdout 首尾空白
  const trimmed = output.stdout.trim()
  // 非空 stdout 作为唤醒消息
  const message = trimmed === "" ? undefined : trimmed
  // 判断是否配置了谓词（is / matches / changes 任一）
  const hasPredicate =
    condition.is !== undefined || condition.matches !== undefined || condition.changes === true

  // 无谓词：以退出码为唤醒信号（退出码 0 表示成功 → 唤醒）
  if (!hasPredicate) {
    return wakeOutcome(output.exitCode === 0, null, message)
  }

  // 有谓词但命令失败：返回带 stderr 详情的错误
  if (output.exitCode !== 0) {
    const detail = output.stderr.trim() || trimmed
    return {
      ok: false as const,
      error: `Command exited with code ${output.exitCode}${detail ? `: ${detail}` : ""}`,
    }
  }

  // is 谓词：stdout（去空白）与期望值相等才唤醒
  if (condition.is !== undefined) {
    return wakeOutcome(trimmed === condition.is.trim(), null, message)
  }

  // matches 谓词：正则匹配完整 stdout 才唤醒
  if (condition.matches !== undefined) {
    return wakeOutcome(new RegExp(condition.matches).test(output.stdout), null, message)
  }

  // changes 谓词：与上一次保存的 stdout 比较，不同才唤醒；状态中保存本次 stdout
  const prevStdout = isRecord(prevState) && typeof prevState.stdout === "string" ? prevState.stdout : null
  return wakeOutcome(prevStdout !== null && output.stdout !== prevStdout, { stdout: output.stdout }, message)
})

// UTF-8 解码辅助：末尾若是截断产生的替换字符 U+FFFD 则去掉，避免半字符残留
function utf8Decode(bytes: Uint8Array): string {
  const text = new TextDecoder("utf-8").decode(bytes)
  return text.endsWith("\uFFFD") ? text.slice(0, -1) : text
}
