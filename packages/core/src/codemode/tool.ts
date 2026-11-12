// 将本模块以命名空间（namespace）形式整体导出；CodeModeTool 定义 execute 工具：在受限运行时里用 JavaScript 编排工具调用
export * as CodeModeTool from "./tool.js"

// 导入 ToolFailure：把内部失败包装成模型可见的工具失败
import { ToolFailure } from "@opencode/ai/effect"
// 导入 CodeMode 运行时与 Namespace/Tool 构造器
import { CodeMode, Namespace, Tool } from "@opencode/codemode"
// 导入工具 Schema 相关类型：内容块、上下文、错误、信息、元数据、命名空间、结果
import type {
  Content,
  Context as ToolContext,
  Error,
  Info,
  Metadata,
  Namespace as ToolNamespace,
  Result,
} from "@opencode/schema/tool"
// 导入 Effect 工具：Clock（时钟）、Context、Effect、Ref、Schema、Semaphore（信号量）
import { Clock, Context, Effect, Ref, Schema, Semaphore } from "effect"
// 导入 toSessionError：把任意错误转换为会话可用的错误描述
import { toSessionError } from "../session/to-session-error.js"
// 导入 definition（取工具定义）与 normalizedName（规范化工具名）
import { definition, normalizedName } from "../tool/runtime.js"
// 导入权限（Permission）服务接口
import { Permission } from "../permission.js"
// 导入目录（CodeModeCatalog）：构建与压缩工具清单
import { CodeModeCatalog } from "./catalog.js"
// 导入 CodeModeExecution：获取执行上下文
import { CodeModeExecution } from "./execution.js"
// 导入 CodeModeFetch：注入受控 fetch 并渲染其展示信息
import { CodeModeFetch } from "./fetch.js"

// 定义 ExecuteFile 模式：execute 产出的文件（base64 数据、MIME 类型、可选文件名）
const ExecuteFile = Schema.Struct({
  // base64 编码的文件数据
  data: Schema.String,
  // 文件的 MIME 类型
  mime: Schema.String,
  // 可选的文件名
  name: Schema.optionalKey(Schema.String),
})

// 定义 ExecuteCall 模式：一次内部工具调用的行信息
const ExecuteCall = Schema.Struct({
  // 被调用的工具名
  tool: Schema.String,
  // 调用状态：运行中 / 已完成 / 出错
  status: Schema.Literals(["running", "completed", "error"]),
  // 可选的输入展示（受控的 JSON 对象）
  input: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
})

// 导出 ExecuteCall 的类型别名
type ExecuteCall = typeof ExecuteCall.Type

// 定义 ExecuteOutput 模式：execute 工具的输出结构
const ExecuteOutput = Schema.Struct({
  // 程序结果与日志合成的文本输出
  output: Schema.String,
  // 内部工具调用记录数组
  toolCalls: Schema.Array(ExecuteCall),
  // 可选的错误标记（程序失败时为 true）
  error: Schema.optionalKey(Schema.Literal(true)),
  // 产出的文件列表
  files: Schema.Array(ExecuteFile),
})

// 定义 CollectedFiles 类型：按调用序号归组收集的文件
type CollectedFiles = {
  // 产生这些文件的内部调用序号
  readonly index: number
  // 该调用产出的文件数组
  readonly files: Array<typeof ExecuteFile.Type>
}

// 定义 Node<T>：目录树节点，可挂一个值 T、命名空间元数据与子节点映射
type Node<T> = {
  // 挂载在该路径上的值（如工具实现）
  tool?: T
  // 挂载的命名空间元数据
  namespace?: ToolNamespace
  // 子节点映射（键为路径段名）
  readonly children: Map<string, Node<T>>
}

// 定义 ToolNode：值为工具实现的目录节点
type ToolNode = Node<Tool.Tool<Run>>

// 定义 Tools：渲染给 Code Mode 运行时的嵌套工具对象（工具 / 命名空间 / 子映射）
type Tools = {
  [name: string]: Tool.Tool<Run> | Namespace.Namespace<Run> | Tools
}

// Per-execution parts of a runtime shared by every execution against the same inventory.
// 定义 Run：同一清单上所有执行共享的运行时中"每次执行"独享的部分
class Run extends Context.Service<
  Run,
  {
    // 执行一个内部工具调用（名称、注册信息、输入）
    readonly executeTool: (name: string, tool: Info, input: unknown) => Effect.Effect<unknown, unknown>
    // 本次执行的进度钩子（用于上报调用行）
    readonly hooks: CodeMode.Hooks
  }
>()("@opencode/CodeModeTool/Run") {}

// 定义 Inventory（清单）类型：已注册工具与命名空间的快照
export type Inventory = {
  // 工具注册信息映射（键为注册名）
  readonly tools: ReadonlyMap<string, Info>
  // 可选的命名空间元数据映射
  readonly namespaces?: ReadonlyMap<string, ToolNamespace>
}

// Invariant model-facing guidance; the changing tool catalog is delivered through Instructions.
// 定义 description：execute 工具的固定说明（会变化的目录走 Instructions，不写死在这里）
const description = [
  // 第 1 条：说明 execute 的用途
  "Run JavaScript in a confined Code Mode runtime to script tool calls and HTTP requests and compose their results.",
  "Write plain JavaScript and send it exactly as written: no code fence, and no JSON or other wrapper around it.",
  "`fetch` is available for HTTP requests. Imports, direct filesystem access, and timers are unavailable: there is no `setTimeout` or sleep. All other external access goes through `tools`.",
  "Inside `execute`, the only callable tools are those explicitly listed in the Code Mode catalog instructions or returned by the `search` function. Ignore tools shown outside the Code Mode catalog. They are not available in the Code Mode runtime.",
  'Call tools through `tools` using only exact paths and signatures from the catalog. Do not infer or normalize tool names; preserve bracket notation such as `tools.<namespace>["tool-name"](input)`.',
  // 第 5 条：建议显式 return；省略时取最后一个顶层表达式的值
  "Prefer an explicit `return`; if omitted, the final top-level expression becomes the result.",
  // 第 6 条：重要的调用要 await；独立调用用 Promise.allSettled 并发
  "Await every call whose completion matters; pending calls are interrupted when execution ends. Run independent calls concurrently with `Promise.allSettled`.",
].join("\n")

// 导出 create：构建 execute 工具定义
export const create = (
  // 工具清单快照
  inventory: Inventory,
  // 执行内部工具调用的回调（带完整上下文）
  executeTool: (name: string, tool: Info, input: unknown, context: ToolContext) => Effect.Effect<Result, Error>,
  // 权限服务接口
  permission: Permission.Interface,
) => {
  // 返回符合 Info 形状的工具定义
  return {
    // 工具名：execute
    name: "execute",
    // 上面组装的固定描述
    description,
    // 输入模式：CodeMode.Input（含 code 字段）
    input: CodeMode.Input,
    freeform: { type: "text" },
    output: ExecuteOutput,
    // 执行入口：解构出 code 后运行
    execute: ({ code }, context) =>
      Effect.gen(function* () {
        // 内部调用的自增序号
        const callIndex = yield* Ref.make(0)
        // 按调用序号收集的文件列表
        const files = yield* Ref.make<Array<CollectedFiles>>([])
        // 当前的调用行列表
        const calls = yield* Ref.make<Array<ExecuteCall>>([])
        // 信号量锁：串行化对调用列表的更新与发布
        const lock = Semaphore.makeUnsafe(1)
        // Each update replaces the last, so send at most one per 100 ms; a trailing one carries the latest rows.
        // A success drops a pending one when the scope closes, since the result carries the final rows.
        // 取当前作用域：节流后的补发任务挂在这里
        const scope = yield* Effect.scope
        // 记录上次发布的时间点（初始为负无穷，保证首条立即发布）
        const publishedAt = yield* Ref.make(Number.NEGATIVE_INFINITY)
        // 是否已安排"末尾补发"（trailing）：避免每次更新都发一条
        const trailing = yield* Ref.make(false)
        // 定义 publish：立即发布当前全部调用行
        const publish = Effect.gen(function* () {
          // 清掉待补发标记
          yield* Ref.set(trailing, false)
          // 记录本次发布时间
          yield* Ref.set(publishedAt, yield* Clock.currentTimeMillis)
          // 把当前调用行通过 progress 推给界面
          yield* context.progress({ toolCalls: yield* Ref.get(calls) })
        })
        // 定义 record：在锁内更新调用行，并按 100ms 节流发布
        const record = (update: (items: Array<ExecuteCall>) => Array<ExecuteCall>) =>
          lock.withPermit(
            Effect.gen(function* () {
              // 应用更新函数修改调用行列表
              yield* Ref.update(calls, update)
              // 已安排补发则本次不再重复安排
              if (yield* Ref.get(trailing)) return
              // 计算距离下次可发布还需等待的毫秒数
              const wait = (yield* Ref.get(publishedAt)) + 100 - (yield* Clock.currentTimeMillis)
              // 无需等待则立即发布
              if (wait <= 0) return yield* publish
              // 标记已安排补发
              yield* Ref.set(trailing, true)
              // 延迟 wait 后在锁内补发最新行；任务挂到当前作用域
              yield* Effect.sleep(wait).pipe(Effect.andThen(lock.withPermit(publish)), Effect.forkIn(scope))
            }),
          )
        // 运行程序：构建运行时并执行代码
        const result = yield* runtime(inventory)
          .execute(code)
          .pipe(
            // 注入 Run 服务：内部工具调用与进度钩子
            Effect.provideService(Run, {
              // 定义内部工具调用的执行函数
              executeTool: (name, tool, input) =>
                Effect.gen(function* () {
                  // 取出并自增本次调用的序号
                  const index = yield* Ref.getAndUpdate(callIndex, (index) => index + 1)
                  // The program sees the same failure text the model gets for a direct call.
                  // 调用真实的工具实现；把错误转成与直接调用一致的失败文本
                  const executed = yield* executeTool(name, tool, input, {
                    ...context,
                    // Progress replaces the execute call's own, so an inner tool's updates would hide the call rows.
                    // 内部工具的 progress 置空：避免覆盖 execute 自身的调用行进度
                    progress: () => Effect.void,
                    // A stop is the execute call's to handle: a nested call never fails it with its own error.
                    cancel: undefined,
                  }).pipe(
                    // 失败时包装为 ToolFailure（消息经过 toSessionError 归一化）
                    Effect.mapError((error) => new ToolFailure({ message: toSessionError(error).message, error })),
                  )
                  // 把结果的 content 归一化为内容块数组
                  const content = resultContent(executed)
                  // 从内容块中提取文件部分
                  const outputFileParts = outputFiles(content)
                  // 有文件时按调用序号归组收集
                  if (outputFileParts.length > 0)
                    yield* Ref.update(files, (items) => [...items, { index, files: outputFileParts }])
                  // 返回程序可见的结果值
                  return resultValue(executed)
                }),
              // 进度钩子：把调用开始/结束映射为记录动作
              hooks: progressHooks(record),
            }),
            // A failed or interrupted call keeps its last progress, so send pending rows before it settles.
            // 程序失败或被中断时：若有未发布的行，先补发一次再落地失败
            Effect.onError(() =>
              lock.withPermit(Ref.get(trailing).pipe(Effect.flatMap((pending) => (pending ? publish : Effect.void)))),
            ),
            // 注入执行上下文：供 fetch 扩展读取会话/消息信息
            Effect.provideService(CodeModeExecution.Service, context),
            // 注入权限服务：供 fetch 做授权检查
            Effect.provideService(Permission.Service, permission),
          )
        // 取最终的调用行列表
        const toolCalls = yield* Ref.get(calls)
        // 把收集到的文件按调用序号排序后摊平
        const collected = (yield* Ref.get(files))
          .toSorted((left, right) => left.index - right.index)
          .flatMap((item) => item.files)
        // 把程序结果格式化为输出文本
        const output = formatResult(result)
        // 组装符合 ExecuteOutput 的值
        const value: typeof ExecuteOutput.Type = {
          output,
          toolCalls,
          files: collected,
          // 程序失败时附加 error 标记
          ...(result.ok ? {} : { error: true }),
        }
        // 组装给模型的内容块：文本 + 文件（data URI）
        const content: Array<Content> = [
          { type: "text", text: value.output },
          ...value.files.map((file) => ({
            type: "file" as const,
            uri: `data:${file.mime};base64,${file.data}`,
            mime: file.mime,
            ...(file.name === undefined ? {} : { name: file.name }),
          })),
        ]
        // 组装元数据：调用行与错误标记
        const metadata: Metadata = {
          toolCalls: value.toolCalls,
          ...(value.error ? { error: true } : {}),
        }
        // 返回工具结果
        return {
          output: value,
          content,
          metadata,
        }
        // 整个执行放在作用域内：结束时丢弃待补发任务
      }).pipe(Effect.scoped),
  } satisfies Info
}

// Rows appear in start order; the same call object arrives at both hooks, so a call finds its row again.
// 定义 progressHooks：把 Code Mode 的钩子事件映射为调用行的增改
function progressHooks(record: (update: (items: Array<ExecuteCall>) => Array<ExecuteCall>) => Effect.Effect<unknown>) {
  // 行索引表：WeakMap 以调用对象为键，记录其在行数组中的下标
  const rows = new WeakMap<object, number>()
  // 定义 start：在行数组末尾追加新行并记下其下标
  const start = (call: object, entry: ExecuteCall) =>
    record((items) => {
      rows.set(call, items.length)
      return [...items, entry]
    })
  // 定义 settle：把对应行的状态更新为完成或出错
  const settle = (call: object, result: CodeMode.CallResult) => {
    // 查找该调用的行下标
    const index = rows.get(call)
    // 找不到（未记录过）则无事可做
    if (index === undefined) return Effect.void
    // 更新该下标行的状态字段
    return record((items) => {
      const next = [...items]
      next[index] = { ...items[index], status: result.status === "success" ? "completed" : "error" }
      return next
    })
  }
  // 返回钩子集合
  return {
    // 工具调用开始：展示输入后追加"运行中"行
    "tool.before": (call) => {
      // 计算可展示的输入（做安全裁剪）
      const shown = displayInput(call.input)
      return start(call, { tool: call.name, status: "running", ...(shown ? { input: shown } : {}) })
    },
    // 工具调用结束：更新行状态
    "tool.after": settle,
    // Only listed extension functions get a row; anything else stays out of the TUI.
    // 扩展函数开始：只给列入白名单的函数建行
    "extension.before": (call) => {
      // 按函数名分发
      switch (call.name) {
        // fetch：展示方法与 URL
        case "fetch":
          return start(call, { tool: call.name, status: "running", input: CodeModeFetch.display(call.args) })
        // 其他扩展函数不展示
        default:
          return Effect.void
      }
    },
    // 扩展函数结束：同样更新行状态
    "extension.after": settle,
  } satisfies CodeMode.Hooks
}

// 导出 catalog：由清单构建"摘要用"的目录（含 pinned 标记与命名空间元数据）
export const catalog = (inventory: Inventory) => {
  // 收集所有 pinned 工具的完整路径
  const pinned = new Set(
    Array.from(inventory.tools.values())
      .filter((registration) => registration.options?.pinned === true)
      .map(qualifiedName),
  )
  // 建目录树根节点
  const root: CatalogNode = { children: new Map() }
  // 把命名空间元数据挂到对应路径节点
  for (const namespace of inventory.namespaces?.values() ?? []) getNode(root, namespace.name).namespace = namespace
  // 遍历运行时目录中的每个工具路径，挂上摘要条目
  for (const tool of runtime(inventory).catalog)
    getNode(root, tool.path).tool = {
      type: "tool",
      // 工具名取路径最后一段
      name: tool.path.split(".").at(-1) ?? tool.path,
      description: tool.description,
      // Rendered only for the tools the catalog shows.
      get signature() {
        return tool.signature
      },
      pinned: pinned.has(tool.path),
    }
  // 渲染整棵树并返回清单形状
  return {
    tools: renderCatalog(root),
  } satisfies CodeModeCatalog.Inventory
}

// 定义 CatalogNode：摘要目录树的节点类型
type CatalogNode = Node<CodeModeCatalog.Tool>

// 定义 renderCatalog：把目录树渲染为排序后的 Tool/Namespace 数组
function renderCatalog(root: CatalogNode): ReadonlyArray<CodeModeCatalog.Tool | CodeModeCatalog.Namespace> {
  return Array.from(root.children)
    // 子节点按键名（字典序）排序
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .flatMap(([name, node]) => {
      // 递归渲染子级
      const tools = renderCatalog(node)
      // 构造命名空间条目：有元数据或有子内容时才存在
      const namespace =
        node.namespace === undefined && tools.length === 0
          ? undefined
          : {
              type: "namespace" as const,
              name,
              ...(node.namespace?.description === undefined ? {} : { description: node.namespace.description }),
              tools,
            }
      // 无工具值：只返回命名空间（或空）
      if (node.tool === undefined) return namespace === undefined ? [] : [namespace]
      // 无命名空间：只返回工具
      if (namespace === undefined) return [node.tool]
      // 两者都有：工具在前、命名空间在后
      return [node.tool, namespace]
    })
}

// Inventories are immutable snapshots, so tool definitions, schemas, and the search index are built
// once per inventory and shared by its catalog and every execution.
// 运行时缓存：清单 -> 已构建的 CodeMode 运行时（清单是不可变快照，可安全复用）
const runtimes = new WeakMap<Inventory, CodeMode.Runtime<Run | CodeModeExecution.Service | Permission.Service>>()

// 定义 runtime：取（或构建）某清单对应的运行时
function runtime(inventory: Inventory) {
  // 命中缓存直接返回
  const cached = runtimes.get(inventory)
  if (cached) return cached
  // 把清单转换成运行时可用的工具表
  const tools = inventoryTools(inventory)
  // 构建 CodeMode 运行时：带工具、fetch 扩展与全局钩子
  const created = CodeMode.make<typeof tools, [typeof CodeModeFetch.extension]>({
    tools,
    extensions: [CodeModeFetch.extension],
    hooks: runHooks,
  })
  // 写入缓存
  runtimes.set(inventory, created)
  // 返回新运行时
  return created
}

/**
 * Runs one program over `inventory` alone with no model step and no `fetch`, binding `bindings` as outer globals.
 */
// 导出 check：离线校验入口——无模型、无 fetch，把 bindings 作为外部全局变量运行一段代码
export const check = (
  // 工具清单快照
  inventory: Inventory,
  // 待执行的代码
  code: string,
  // 外部全局绑定
  bindings: Readonly<Record<string, CodeMode.DataValue>>,
  // 执行限制（时间/内存等）
  limits: CodeMode.ExecutionLimits,
  // 内部工具调用回调
  executeTool: (name: string, tool: Info, input: unknown) => Effect.Effect<Result, Error>,
) =>
  CodeMode.make({
    tools: inventoryTools(inventory),
    hooks: runHooks,
    limits,
  })
    .execute(code, bindings)
    .pipe(
      Effect.provideService(Run, {
        // 内部调用直接走回调并把结果转为值
        executeTool: (name, tool, input) => executeTool(name, tool, input).pipe(Effect.map(resultValue)),
        // 校验模式不需要进度钩子
        hooks: {},
      }),
    )

// 定义 inventoryTools：把清单渲染成 CodeMode 运行时的嵌套工具对象
function inventoryTools(inventory: Inventory) {
  // A path may carry namespace metadata, a callable tool, child tools, or all three.
  // 建工具树根节点
  const root: ToolNode = { children: new Map() }
  // 挂载命名空间元数据
  for (const namespace of inventory.namespaces?.values() ?? []) getNode(root, namespace.name).namespace = namespace
  // 遍历每个注册工具：定义可调用实现并挂到其完整路径
  for (const [name, registration] of inventory.tools) {
    // 取工具的标准化定义（描述与输入/输出 Schema）
    const child = definition(registration)
    getNode(root, qualifiedName(registration)).tool = Tool.make({
      description: child.description,
      input: child.inputSchema,
      freeform: registration.freeform !== undefined,
      output: child.outputSchema ?? Schema.NullOr(Schema.String),
      // 执行时回调 Run 服务里的 executeTool
      execute: (input) => Run.use((run) => run.executeTool(name, registration, input)),
    })
  }
  // 渲染整棵工具树
  return renderTools(root)
}

// 定义 resultContent：把结果的 content 归一化为内容块数组
function resultContent(executed: Result) {
  return typeof executed.content === "string"
    ? [{ type: "text" as const, text: executed.content }]
    : (executed.content ?? [])
}

// 定义 resultValue：从结果中提取程序可见的返回值
function resultValue(executed: Result) {
  // 已有 output 则直接使用
  if (executed.output !== undefined) return executed.output
  // 否则拼接全部文本块
  const text = resultContent(executed)
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
  // 空文本返回 null
  return text === "" ? null : text
}

// 定义 runHooks：全局钩子——把事件转发给当前执行的 Run 服务（没有则跳过）
const runHooks = {
  "tool.before": (call) => Run.use((run) => run.hooks["tool.before"]?.(call) ?? Effect.void),
  "tool.after": (call, result) => Run.use((run) => run.hooks["tool.after"]?.(call, result) ?? Effect.void),
  "extension.before": (call) => Run.use((run) => run.hooks["extension.before"]?.(call) ?? Effect.void),
  "extension.after": (call, result) => Run.use((run) => run.hooks["extension.after"]?.(call, result) ?? Effect.void),
} satisfies CodeMode.Hooks<Run>

// 定义 getNode：按点分路径在树中找到（或创建）节点
function getNode<T>(root: Node<T>, path: string) {
  return path.split(".").reduce((parent, name) => {
    // 取子节点，不存在则创建空节点
    const child: Node<T> = parent.children.get(name) ?? { children: new Map() }
    // 写回父节点映射
    parent.children.set(name, child)
    // 继续向下
    return child
  }, root)
}

// 定义 renderTools：渲染整棵工具树，并把"路径冲突"的可调用工具平铺到顶层
function renderTools(root: ToolNode) {
  // 收集需要平铺的可调用工具（路径 -> 工具）
  const callables = new Map<string, Tool.Tool<Run>>()
  // 先递归渲染嵌套结构
  const tools = renderChildren(root, [], callables)
  // 再把平铺的工具按点分路径写入顶层
  for (const [path, tool] of callables) tools[path] = tool
  // 返回最终工具对象
  return tools
}

// 定义 renderChildren：渲染某节点的全部子级为嵌套对象
function renderChildren(node: ToolNode, path: ReadonlyArray<string>, callables: Map<string, Tool.Tool<Run>>): Tools {
  return Object.fromEntries(
    Array.from(node.children).flatMap(([name, child]) => {
      // 计算子级完整路径
      const next = [...path, name]
      // A record cannot hold both a top-level tool and namespace under the same key.
      // 顶层键无法同时容纳工具与命名空间：把该子树整体平铺成点分键
      if (path.length === 0 && child.tool !== undefined && (child.namespace !== undefined || child.children.size > 0)) {
        const tools: Tools = {}
        flattenTools(child, next, tools)
        return Object.entries(tools)
      }
      // 常规情况：渲染为单个键值对
      return [[name, renderEntry(child, next, callables)]]
    }),
  )
}

// 定义 renderEntry：渲染单个节点为工具 / 命名空间 / 子对象
function renderEntry(
  node: ToolNode,
  path: ReadonlyArray<string>,
  callables: Map<string, Tool.Tool<Run>>,
): Tools[string] {
  // 先递归渲染子级
  const tools = renderChildren(node, path, callables)
  // CodeMode merges this dotted tool path with the nested namespace entry.
  // 节点上同时有工具与命名空间/子级时：把工具登记为点分路径，稍后平铺，避免键冲突
  if (node.tool !== undefined && (node.namespace !== undefined || node.children.size > 0))
    callables.set(path.join("."), node.tool)
  // 有命名空间元数据：渲染为命名空间
  if (node.namespace !== undefined)
    return Namespace.make({
      description: node.namespace.description,
      tools,
    })
  // 无工具：返回子对象
  if (node.tool === undefined) return tools
  // 叶子工具：直接返回工具本身
  if (node.children.size === 0) return node.tool
  // 有子级：返回子对象
  return tools
}

// 定义 flattenTools：把子树的工具全部平铺到点分键上
function flattenTools(node: ToolNode, path: ReadonlyArray<string>, tools: Tools) {
  // 当前节点有工具则记录
  if (node.tool !== undefined) tools[path.join(".")] = node.tool
  // 递归处理全部子节点
  for (const [name, child] of node.children) flattenTools(child, [...path, name], tools)
}

// 导出 qualifiedName：计算工具的完整限定名（命名空间.规范化名）
export function qualifiedName(registration: Info) {
  // 取规范化后的工具名
  const normalized = normalizedName(registration)
  // 无命名空间则返回原名
  if (registration.options?.namespace === undefined) return normalized
  // 否则拼上命名空间前缀
  return `${registration.options.namespace}.${normalized}`
}

// Tool inputs arrive as parsed JSON, so the JSON value cast is a boundary fact.
// 定义 displayInput：把内部工具的输入裁剪成可安全展示的 JSON 对象
function displayInput(input: unknown): Record<string, typeof Schema.Json.Type> | undefined {
  // 空输入不展示
  if (input === null || input === undefined) return
  // 非普通对象（含数组）时包装为 { input: 值 } 展示
  if (typeof input !== "object" || Array.isArray(input)) return { input: input as typeof Schema.Json.Type }
  // 空对象不展示
  if (Object.keys(input).length === 0) return
  // 普通对象原样返回（输入本就是解析后的 JSON）
  return input as Record<string, typeof Schema.Json.Type>
}

// 定义 formatResult：把运行结果格式化为输出文本（含错误、警告与日志段）
function formatResult(result: CodeMode.Result) {
  // 成功时格式化返回值；失败时拼接错误消息与未重复的修复建议
  const output = result.ok
    ? formatValue(result.value)
    : [result.error.message, ...(result.error.suggestions ?? []).filter((hint) => !result.error.message.includes(hint))]
        .join("\n")
        .trim()
  // 成功且有警告时生成警告段
  const warnings =
    result.ok && result.warnings && result.warnings.length > 0
      ? `Warnings:\n${result.warnings.map((item) => `- [${item.kind}] ${item.message}`).join("\n")}`
      : undefined
  // 有日志时生成日志段
  const logs = result.logs && result.logs.length > 0 ? `Logs:\n${result.logs.join("\n")}` : undefined
  // 用空行合并各非空段
  return [output, warnings, logs].filter((part) => part !== undefined && part !== "").join("\n\n")
}

// Compact JSON: indentation adds tokens on every later step without helping the model. Clients pretty-print it.
function formatValue(value: CodeMode.DataValue) {
  // 字符串直接返回
  if (typeof value === "string") return value
  return JSON.stringify(value) ?? String(value)
}

// 定义 outputFiles：从内容块中提取文件（要求为 base64 data URI 格式）
function outputFiles(content: ReadonlyArray<Content>): Array<typeof ExecuteFile.Type> {
  return content.flatMap((part) => {
    // 非文件块跳过
    if (part.type !== "file") return []
    // 构造期望的 data URI 前缀
    const prefix = `data:${part.mime};base64,`
    // 前缀不匹配则跳过
    if (!part.uri.startsWith(prefix)) return []
    // 剥掉前缀得到 base64 数据，组装文件条目
    return [
      {
        data: part.uri.slice(prefix.length),
        mime: part.mime,
        ...(part.name === undefined ? {} : { name: part.name }),
      },
    ]
  })
}
