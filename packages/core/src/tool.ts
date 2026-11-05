// =====================================================================
// 文件角色：Tool —— 工具注册表与执行管线。
// 所有内置/插件/MCP 工具先“注册”到本模块（校验名字、schema、命名空间，
// 转成 provider 可用的 ToolDefinition），再在每一步请求里 snapshot() 出
// “本次可用的工具定义集合”与一个统一的 execute 入口。执行管线：
// execute.before 钩子 → 工具体 → execute.after 钩子 → 内容规范化（图片）。
// Code Mode（execute 工具）允许模型写一段 TS 程序编排多个工具调用。
// =====================================================================
export * as Tool from "./tool.js"
// 直接复用 @opencode/schema/tool 的基础类型（错误、内容块等）。
export { CallID, Content, Error, FileContent, TextContent } from "@opencode/schema/tool"
export type { Context, Metadata, Namespace, Options, Result } from "@opencode/schema/tool"

// ToolDefinition：发给 provider 的工具定义（名字+描述+入参 schema）。
import { ToolDefinition, type ToolCall } from "@opencode/ai/effect"
// CodeMode：Code Mode 程序执行相关类型。
import type { CodeMode } from "@opencode/codemode"
// Tool 的 Schema（Info/Result/Content 等）。
import { Tool } from "@opencode/schema/tool"
// effect 核心：Context（DI）、Layer（装配）、Ref（可变引用）、Result
// （成功/失败）、Schema（运行时校验）、SchemaIssue（校验错误格式化）。
import { Context, Effect, Layer, Ref, Result, Schema, SchemaIssue, Types } from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
// agent 类型（只用作类型）。
import type { Agent } from "./agent.js"
// Code Mode 的目录清单与执行工具。
import { CodeModeCatalog } from "./codemode/catalog.js"
import { CodeModeTool } from "./codemode/tool.js"
// 图片处理服务（工具输出里的图片规范化）。
import { Image } from "./image.js"
// 权限系统。
import { Permission } from "./permission.js"
// 插件钩子。
import { PluginHooks } from "./plugin/hooks.js"
// 会话消息与 Schema（ID 类型）。
import { SessionMessage } from "./session/message.js"
import { SessionSchema } from "./session/schema.js"
// 可重载状态。
import { State } from "./state.js"
// 工具运行时的通用逻辑（定义转换、名字规范化、执行、内容规范化）。
import { definition, effectiveName, execute, normalizedName, normalizeContent } from "./tool/runtime.js"
// 通配符匹配（权限规则）。
import { Wildcard } from "./util/wildcard.js"

// RegistrationError：注册失败（名字非法、schema 非法等）。
export class RegistrationError extends Schema.TaggedError<RegistrationError>()("Tool.RegistrationError", {
  name: Schema.String,
  message: Schema.String,
}) {}

// Editor：注册表的“编辑视图”——插件在事务里增删改工具。
export interface Editor {
  readonly list: () => readonly (Tool.Info & { readonly id: string })[]
  readonly get: (id: string) => (Tool.Info & { readonly id: string }) | undefined
  readonly namespace: (namespace: Tool.Namespace) => void
  readonly add: (tool: Tool.Info) => void
  readonly update: (id: string, update: (tool: Types.Mutable<Tool.Info>) => void) => void
  readonly remove: (id: string) => void
}

// 内部数据结构：工具、已转换的定义、命名空间、注册错误记录。
type Data = {
  tools: Map<string, Tool.Info & { readonly id: string }>
  // Converted once at registration; schemas cannot change without re-registering the tool.
  // 定义在注册时一次性转换；schema 要改必须重新注册。
  definitions: Map<string, ToolDefinition>
  namespaces: Map<string, Tool.Namespace>
  errors: { kind: "tool" | "namespace"; name: string; namespace?: string; error: RegistrationError }[]
}

// 对外接口：list / snapshot / check（Code Mode 无模型步的试跑）。
export interface Interface extends State.Transformable<Editor> {
  readonly list: () => Effect.Effect<ReadonlyArray<Tool.Info & { readonly id: string }>>
  // snapshot：按权限规则过滤出本次可用的工具定义与执行入口。
  readonly snapshot: (permissions?: Permission.Ruleset) => Effect.Effect<Snapshot>
  /**
   * Runs a Code Mode program with no model step over only the Code Mode tools named in `tools` (still subject to
   * whole-tool permission filtering and each tool's own executor policy), with no `fetch`.
   */
  // check：跑一段 Code Mode 程序（无模型步），只允许指定工具，仍受权限约束。
  readonly check: (input: CheckInput) => Effect.Effect<CodeMode.Result>
}

// check 的输入。
export interface CheckInput {
  readonly code: string
  readonly tools: ReadonlyArray<string>
  readonly bindings: Readonly<Record<string, CodeMode.DataValue>>
  readonly permissions: Permission.Ruleset
  readonly limits: CodeMode.ExecutionLimits
  readonly context: Omit<Tool.Context, "id">
}

/** A local execution result after hooks and content normalization. */
// NormalizedResult：经过钩子与内容规范化之后的本地执行结果。
export interface NormalizedResult extends Tool.Result {
  readonly content: ReadonlyArray<Tool.Content>
}

// Snapshot：一次请求可用的工具集合。
export interface Snapshot {
  readonly definitions: ReadonlyArray<ToolDefinition>
  readonly codeModeCatalog?: CodeModeCatalog.Inventory
  // execute：统一的工具执行入口（step.ts 的 executeTool 最终走这里）。
  readonly execute: (input: {
    readonly sessionID: SessionSchema.ID
    readonly agent: Agent.ID
    readonly messageID: SessionMessage.ID
    readonly call: ToolCall
    readonly progress?: (update: Tool.Metadata) => Effect.Effect<void>
    /** Surviving request definitions, keyed by the names advertised after session context hooks. */
    // definitions：本次请求实际通告的工具名集合（钩子可能删改过）。
    readonly definitions?: ReadonlyMap<string, ToolDefinition>
  }) => Effect.Effect<NormalizedResult, Tool.Error>
}

// Effect 服务标识。
export class Service extends Context.Service<Service, Interface>()("@opencode/Tool") {}

// 装配层：注入插件钩子、图片服务、权限服务。
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    const image = yield* Image.Service
    const permission = yield* Permission.Service

    // 内容块归一化的中间类型：普通内容块，或被剔除的原因标记。
    type NormalizedItem = Tool.Content | "decode" | "size"
    // normalizeImages：把工具输出里的 data:URL 图片走图片服务规范化
    // （转码/压缩）；解码失败/超限的剔除并给出计数提示。
    const normalizeImages = Effect.fnUntraced(function* (content: ReadonlyArray<Tool.Content>) {
      const normalized = yield* Effect.forEach(content, (item): Effect.Effect<NormalizedItem> => {
        // 非图片的 file 内容原样保留。
        if (item.type !== "file" || !item.mime.startsWith("image/")) return Effect.succeed(item)
        // 从 data URL 提取 base64。
        const base64 = /^data:[^,]*;base64,(.*)$/s.exec(item.uri)?.[1]
        if (base64 === undefined) return Effect.succeed(item)
        const resource = item.name ?? `${item.mime} tool output`
        return image.normalize(resource, { uri: resource, content: base64, encoding: "base64", mime: item.mime }).pipe(
          // 成功：替换为规范化后的 data URL。
          Effect.map((result) => ({
            ...item,
            uri: `data:${result.mime};base64,${result.content}`,
            mime: result.mime,
          })),
          // 缩图服务不可用：保留原图。
          Effect.catchTag("Image.ResizerUnavailableError", () => Effect.succeed(item)),
          // 解码失败：标记剔除。
          Effect.catchTag("Image.DecodeError", () => Effect.succeed("decode" as const)),
          // 尺寸超限：标记剔除。
          Effect.catchTag("Image.SizeError", () => Effect.succeed("size" as const)),
        )
      })
      // note：为剔除的图片生成计数说明（如“[2 images omitted: ...]”）。
      const note = (reason: "decode" | "size", text: string) => {
        const count = normalized.filter((item) => item === reason).length
        if (count === 0) return []
        return [{ type: "text" as const, text: `[${count} image${count === 1 ? "" : "s"} omitted: ${text}]` }]
      }
      return [
        ...normalized.filter((item) => typeof item !== "string"),
        ...note("decode", "could not be decoded."),
        ...note("size", "could not be resized below the image size limit."),
      ]
    })

    // beforeExecute：触发插件的 execute.before 钩子（可改写入参）。
    const beforeExecute = (name: string, input: unknown, context: Tool.Context) =>
      hooks.trigger("tool", "execute.before", {
        tool: name,
        sessionID: context.sessionID,
        agent: context.agent,
        messageID: context.messageID,
        id: context.id,
        input,
      })

    // executeTool：单个工具的完整执行——打注解、跑工具体、走 after 钩子、
    // 规范化内容；Tool.Error 也会经过 after 钩子再上抛。
    const executeTool = Effect.fn("Tool.execute")(function* (
      tool: Tool.Info,
      name: string,
      input: unknown,
      context: Tool.Context,
    ) {
      // span 注解（可观测性）。
      yield* Effect.annotateCurrentSpan({
        "gen_ai.tool.name": name,
        "gen_ai.tool.call.id": context.id,
        "session.id": context.sessionID,
      })
      // 执行工具体；Tool.Error 被捕获成 { failure } 以便走统一 after 钩子。
      const execution = yield* execute(tool, input, context).pipe(
        Effect.map((value) => ({ value })),
        Effect.catchTag("Tool.Error", (failure) => Effect.succeed({ failure })),
      )
      // after 钩子事件的基本字段。
      const base = {
        tool: name,
        sessionID: context.sessionID,
        agent: context.agent,
        messageID: context.messageID,
        id: context.id,
        input,
      }
      // 失败路径：after 钩子（status=error）后重新上抛错误。
      if ("failure" in execution) {
        const afterEvent: PluginHooks.Domains["tool"]["execute.after"] = {
          ...base,
          status: "error",
          error: execution.failure,
        }
        yield* hooks.trigger("tool", "execute.after", afterEvent)
        return yield* afterEvent.error
      }
      // 成功路径：after 钩子（status=completed，带结果）。
      const afterEvent: PluginHooks.Domains["tool"]["execute.after"] = {
        ...base,
        status: "completed",
        result: {
          ...(execution.value.output === undefined ? {} : { output: execution.value.output }),
          content: execution.value.content,
          ...(execution.value.metadata === undefined ? {} : { metadata: execution.value.metadata }),
        },
      }
      yield* hooks.trigger("tool", "execute.after", afterEvent)
      // 钩子可能改写结果：再做一次内容规范化（含图片处理）。
      const afterContent = yield* normalizeImages(normalizeContent(afterEvent.result.content, afterEvent.result.output))
      return {
        ...(afterEvent.result.output === undefined ? {} : { output: afterEvent.result.output }),
        content: afterContent,
        ...(afterEvent.result.metadata === undefined ? {} : { metadata: afterEvent.result.metadata }),
      }
    })

    // run：before 钩子 → executeTool（钩子返回的 input 才是真正执行用的）。
    const run = (tool: Tool.Info, name: string, input: unknown, context: Tool.Context) =>
      beforeExecute(name, input, context).pipe(Effect.flatMap((event) => executeTool(tool, name, event.input, context)))

    // Code Mode 目录缓存：同一份注册表 + 同一组可见工具 → 复用。
    let catalog:
      | {
          data: Data
          names: string
          inventory: CodeModeTool.Inventory
          value: CodeModeCatalog.Inventory
          definition: ToolDefinition
        }
      | undefined
    // State.create：注册表的可重载状态与编辑器实现。
    const state = State.create<Data, Editor>({
      name: "tool",
      initial: () => ({
        tools: new Map(),
        definitions: new Map(),
        namespaces: new Map(),
        errors: [],
      }),
      editor: (editor) => ({
        list: () => Array.from(editor.tools.values()),
        get: (id) => editor.tools.get(id),
        // namespace：登记命名空间（非法则记错误）。
        namespace: (namespace) => {
          const error = namespaceError(namespace.name)
          if (error) {
            editor.errors.push({ kind: "namespace", name: namespace.name, namespace: namespace.name, error })
            return
          }
          editor.namespaces.set(namespace.name, { ...namespace })
        },
        // add：新增工具（id = 生效名）。
        add: (tool) => {
          const id = effectiveName(tool)
          commit(editor, id, { ...tool, id, options: tool.options && { ...tool.options } })
        },
        // update：更新工具（保持原名字与命名空间不被覆盖）。
        update: (id, update) => {
          const current = editor.tools.get(id)
          if (!current) return
          const tool = { ...current, options: current.options && { ...current.options } }
          update(tool)
          tool.name = current.name
          tool.id = id
          if (tool.options?.namespace !== current.options?.namespace)
            tool.options = { ...tool.options, namespace: current.options?.namespace }
          commit(editor, id, tool)
        },
        // remove：删除工具与其定义。
        remove: (id) => {
          editor.tools.delete(id)
          editor.definitions.delete(id)
        },
      }),
      // notify：编辑提交后触发——目录缓存失效 + 打印注册错误。
      notify: (value) => {
        catalog = undefined
        return Effect.forEach(
          value.errors,
          ({ kind, name, namespace, error }) =>
            Effect.logError(`Skipping invalid ${kind} registration`, {
              name,
              namespace,
              error: error.message,
            }),
          { discard: true },
        )
      },
    })

    // 服务实现。
    return Service.of({
      transform: state.transform,
      reload: state.reload,
      list: () => Effect.sync(() => Array.from(state.get().tools.values())),
      // snapshot：按权限规则产出本次请求可用的工具定义与执行入口。
      snapshot: Effect.fn("Tool.snapshot")((permissions) =>
        Effect.sync(() => {
          const data = state.get()
          // active：未被权限规则整体禁用的工具。
          const active = new Map<string, Tool.Info>()
          const rules = permissions ?? []
          for (const [name, tool] of data.tools) {
            if (whollyDisabled(tool.options?.permission ?? name, rules)) continue
            active.set(name, tool)
          }
          // Code Mode 本身（execute 工具）是否可用。
          const codeModeEnabled = !whollyDisabled("execute", rules)
          // Without Code Mode its tools would be unreachable, so expose them as direct tools instead.
          // 没有 Code Mode 时，所有工具都直接暴露；有 Code Mode 时只暴露
          // codemode=false 的工具，其余通过 execute 程序调用。
          const direct = codeModeEnabled
            ? new Map(Array.from(active).filter(([, tool]) => tool.options?.codemode === false))
            : active
          const codeModeTools = new Map(Array.from(active).filter(([, tool]) => tool.options?.codemode !== false))
          // 名字串用 \0 连接（作为缓存键的一部分）。
          const names = Array.from(codeModeTools.keys()).join("\0")
          // Discovery is immutable for a registry revision and visible tool set. Keep executors
          // fresh, but share the inventory, whose prepared runtime and much larger rendered catalog
          // are cached by identity, and the execute tool's definition across steps.
          // 目录缓存：注册表对象与可见工具名都相同才复用（执行器保持新鲜，
          // 大目录与定义跨步共享）。
          const cached = catalog?.data === data && catalog.names === names ? catalog : undefined
          const codeModeInventory = cached?.inventory ?? { tools: codeModeTools, namespaces: data.namespaces }
          // 创建 Code Mode 的 execute 工具（内部把工具调用转发给 run）。
          const codeModeTool = codeModeEnabled
            ? CodeModeTool.create(
                codeModeInventory,
                (name, tool, input, context) => run(tool, name, input, context),
                permission,
              )
            : undefined
          const codeModeCatalog = !codeModeEnabled
            ? undefined
            : (cached?.value ?? CodeModeTool.catalog(codeModeInventory))
          const codeModeDefinition = codeModeTool && (cached?.definition ?? definition(codeModeTool))
          if (codeModeCatalog && codeModeDefinition)
            catalog = {
              data,
              names,
              inventory: codeModeInventory,
              value: codeModeCatalog,
              definition: codeModeDefinition,
            }
          return {
            ...(codeModeCatalog === undefined ? {} : { codeModeCatalog }),
            // 定义列表：直接工具按名字排序 + Code Mode 的 execute 定义。
            definitions: [
              ...Array.from(direct)
                .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
                .map(([name]) => data.definitions.get(name)!),
              ...(codeModeDefinition ? [codeModeDefinition] : []),
            ],
            // execute：本次请求的工具执行入口。
            execute: Effect.fnUntraced(function* (input: Parameters<Snapshot["execute"]>[0]) {
              const context: Tool.Context = {
                sessionID: input.sessionID,
                agent: input.agent,
                messageID: input.messageID,
                id: Tool.CallID.make(input.call.id),
                progress: input.progress ?? (() => Effect.void),
              }
              // 先走 before 钩子（可改写入参/改名）。
              const event = yield* beforeExecute(input.call.name, input.call.input, context)
              const requested = input.definitions?.get(event.tool)
              // Preserve session context removal and alias resolution, now after the repair hook.
              // 请求里已不存在的工具（钩子删掉的）→ 明确报错。
              if (!requested && input.definitions && (direct.has(event.tool) || codeModeTool?.name === event.tool))
                return yield* new Tool.Error({ message: `Tool is not available for this request: ${event.tool}` })
              const name = requested?.name ?? event.tool
              // execute 工具走 Code Mode 执行器。
              if (name === "execute" && codeModeTool)
                return yield* executeTool(codeModeTool, name, event.input, context)
              // 直接工具。
              const tool = direct.get(name)
              if (tool) return yield* executeTool(tool, name, event.input, context)
              return yield* new Tool.Error({
                message: `No tool named "${name}" is currently available. Please use a tool from the available tool list.`,
              })
            }),
          }
        }),
      ),
      // check：无模型步地跑一段 Code Mode 程序（供测试/校验）。
      check: Effect.fn("Tool.check")(function* (input) {
        // Code Mode 被禁用 → 直接失败。
        if (whollyDisabled("execute", input.permissions)) {
          return {
            ok: false,
            error: { kind: "ExecutionFailure", message: "Code Mode is disabled for this agent" },
            toolCalls: [],
          } satisfies CodeMode.Result
        }
        const data = state.get()
        // 只允许指定名字的 Code Mode 工具，且逐个过权限。
        const allowed = new Set(input.tools)
        const tools = new Map(
          Array.from(data.tools).filter(
            ([name, tool]) =>
              tool.options?.codemode !== false &&
              allowed.has(CodeModeTool.qualifiedName(tool)) &&
              !whollyDisabled(tool.options?.permission ?? name, input.permissions),
          ),
        )
        // callSeq：为程序里的每次工具调用生成递增的调用 ID。
        const callSeq = yield* Ref.make(0)
        return yield* CodeModeTool.check(
          { tools, namespaces: data.namespaces },
          input.code,
          input.bindings,
          input.limits,
          (name, tool, toolInput) =>
            Effect.gen(function* () {
              const index = yield* Ref.getAndUpdate(callSeq, (value) => value + 1)
              const context: Tool.Context = {
                ...input.context,
                id: Tool.CallID.make(`call_${input.context.messageID}_${index}`),
              }
              return yield* run(tool, name, toolInput, context)
            }),
        )
      }),
    })
  }),
)

/** Store a valid tool under its effective name, or record why it was skipped. */
// commit：把工具注册进编辑器；失败则记录原因（不抛出）。
function commit(editor: Data, id: string, input: Tool.Info & { readonly id: string }) {
  // JavaScript plugins may leave out `input` for a tool that takes none.
  // JS 插件可能不写 input（无参工具）→ 补空对象。
  const tool = input.input === undefined || input.input === null ? { ...input, input: {} } : input
  const registered = register(tool)
  if (Result.isFailure(registered)) {
    editor.errors.push({
      kind: "tool",
      name: tool.name,
      namespace: tool.options?.namespace,
      error: registered.failure,
    })
    return
  }
  editor.tools.set(id, tool)
  editor.definitions.set(id, registered.success)
}

// whollyDisabled：权限规则里最后一条匹配是 “* + deny” → 整体禁用。
const whollyDisabled = (action: string, rules: Permission.Ruleset) => {
  const rule = rules.findLast((rule) => Wildcard.match(action, rule.action))
  return rule?.resource === "*" && rule.effect === "deny"
}

// SchemaIssue 格式化器（错误信息更友好）。
const formatSchemaIssue = SchemaIssue.makeFormatterDefault()

// schemaMakeError：从定义转换异常里提取可读信息。
function schemaMakeError(error: unknown) {
  if (error instanceof Error && SchemaIssue.isIssue(error.cause)) return formatSchemaIssue(error.cause)
  return error instanceof Error ? error.message : String(error)
}

// register：注册校验——命名空间合法、名字合法、execute 保留、input 是
// schema；通过后转成 ToolDefinition。
function register(tool: Tool.Info): Result.Result<ToolDefinition, RegistrationError> {
  const namespace = tool.options?.namespace
  if (namespace !== undefined) {
    const error = namespaceError(namespace)
    if (error) return Result.fail(error)
  }
  // 名字只允许字母数字下划线连字符。
  const name = normalizedName(tool)
  if (!/^[A-Za-z0-9_-]+$/.test(name))
    return Result.fail(new RegistrationError({ name, message: `Invalid tool name: ${name}` }))
  const id = effectiveName(tool)
  // execute 名字保留给 Code Mode。
  if (tool.options?.codemode === false && id === "execute")
    return Result.fail(new RegistrationError({ name: id, message: 'Tool name "execute" is reserved for CodeMode' }))
  // Standard Schema libraries such as ArkType make schemas that are functions.
  // Standard Schema 生态里 schema 可以是函数（如 ArkType），两者都接受。
  if (typeof tool.input !== "object" && typeof tool.input !== "function")
    return Result.fail(
      new RegistrationError({ name: id, message: `Invalid tool definition ${id}: input must be a schema` }),
    )
  return Result.try({
    try: () => ToolDefinition.make(definition(tool)),
    catch: (error) =>
      new RegistrationError({ name: id, message: `Invalid tool definition ${id}: ${schemaMakeError(error)}` }),
  })
}

// namespaceError：命名空间每一段都必须是合法标识符。
function namespaceError(name: string) {
  if (name.split(".").every((segment) => /^[A-Za-z0-9_-]+$/.test(segment))) return
  return new RegistrationError({ name, message: `Invalid tool namespace: ${JSON.stringify(name)}` })
}

// node：依赖装配。
export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [PluginHooks.node, Image.node, Permission.node],
})
