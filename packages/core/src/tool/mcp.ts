// 将本模块以命名空间方式重新导出为 McpTool
export * as McpTool from "./mcp.js"

// 导入 Effect 化的工具失败类型（ToolFailure）
import { ToolFailure } from "@opencode/ai/effect"
// 导入 MCP 事件 Schema（如工具列表变化事件）
import { McpEvent } from "@opencode/schema/mcp-event"
// 导入 Effect 原语：Context、Effect、Fiber（轻量线程）、JsonSchema 类型、Layer、Option、PubSub（发布订阅）、Schema、Semaphore（信号量）、Stream
import { Context, Effect, Fiber, type JsonSchema, Layer, Option, PubSub, Schema, Semaphore, Stream } from "effect"
// 导入辅助函数：把服务打包成位置（location）依赖注入节点
import { makeLocationNode } from "@opencode/util/effect/app-node"
// 导入 mime-types 库的 extension 函数：由 MIME 类型推断文件扩展名
import { extension } from "mime-types"
// 导入事件总线（Bus）服务
import { Bus } from "../bus.js"

// 导入 MCP 客户端服务
import { Mcp } from "../mcp/index.js"
// 导入 MIME 类型判断工具
import { Mime } from "../mime.js"
// 导入权限（Permission）服务
import { Permission } from "../permission.js"
// 导入工具（Tool）注册中心服务
import { Tool } from "../tool.js"
// 导入工具输出（ToolOutput）存储服务
import { ToolOutput } from "../tool-output.js"
// 导入读文件工具的文件系统模块（借用其 MEDIA_MIMES 媒体类型集合）
import { ReadToolFileSystem } from "./read-filesystem.js"
// 导入工具命名处理函数：规范化名（normalizedName）与生效名（effectiveName）
import { effectiveName, normalizedName } from "./runtime.js"

// 构造“从 JSON 字符串解码为任意值”的解析器（失败时返回 Option 而非抛错）
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

/**
 * Registry namespace and permission action names for MCP tools.
 */
// MCP 工具的注册命名空间：由服务器名规范化而来
export const namespace = (server: string) => normalizedName({ name: server })
// MCP 工具的完整名：工具名加上服务器命名空间
export const name = (server: string, tool: string) =>
  effectiveName({ name: tool, options: { namespace: namespace(server) } })

// 服务接口定义：对外暴露的能力
export interface Interface {
  /**
   * Wait for the initial MCP tool registration, give servers still connecting a bounded chance to
   * finish, then bring the registry up to date without waiting for the debounced reload.
   */
  // flush：等待初始注册完成，并把注册中心同步到最新（不必等防抖刷新）
  readonly flush: Effect.Effect<void>
}

// Effect 服务标签（Context.Tag）：依赖注入标识 "@opencode/McpTool"
export class Service extends Context.Service<Service, Interface>()("@opencode/McpTool") {}

// 构建 Service 的 Effect 层（Layer）
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 注入 MCP 客户端服务
    const mcp = yield* Mcp.Service
    // 注入工具注册中心
    const tools = yield* Tool.Service
    // 注入事件总线
    const bus = yield* Bus.Service
    // 注入权限服务
    const permission = yield* Permission.Service
    // 注入工具输出服务
    const toolOutput = yield* ToolOutput.Service
    // 创建互斥信号量（容量 1），保护工具目录的发现与注册过程
    const lock = Semaphore.makeUnsafe(1)
    // 最近一次发现的 MCP 工具列表（flush 时用于对比注册中心是否落后）
    let discovered: Mcp.Tool[] = []

    // Register once after initial discovery; only subsequent updates need a debounced reload.
    // 初始注册：在锁保护下拉取工具目录并注册到工具中心，随后 fork 到后台执行
    const initial = yield* lock
      .withPermit(
        Effect.gen(function* () {
          // 拉取 MCP 服务器当前提供的全部工具
          discovered = yield* mcp.tools()
          // 对工具注册中心做一次变换（editor 模式批量编辑）
          yield* tools.transform((editor) => {
            // 逐个注册发现的工具
            for (const tool of discovered) {
              editor.add({
                // 工具名
                name: tool.name,
                // 选项：以服务器名为命名空间；除非显式关闭否则启用 codemode
                options: { namespace: namespace(tool.server), codemode: tool.codemode !== false },
                // 描述（缺失用空串）
                description: tool.description ?? "",
                // 输入参数的 JSON Schema
                input: tool.inputSchema as JsonSchema.JsonSchema,
                // 输出的 JSON Schema（缺失视为空对象）
                output: (tool.outputSchema ?? {}) as JsonSchema.JsonSchema,
                // 工具执行体：校验权限后调用 MCP 服务器
                execute: (input, context) =>
                  Effect.gen(function* () {
                    // 断言权限：以“服务器.工具”为动作名，允许任意资源与保存位置
                    yield* permission.assert({
                      action: name(tool.server, tool.name),
                      resources: ["*"],
                      save: ["*"],
                      metadata: { input: input ?? {} },
                      // 附带调用上下文（会话、agent 等元数据）
                      ...Permission.invocation(context),
                    })
                    // 调用 MCP 服务器的工具
                    const result = yield* mcp
                      .callTool({
                        // 目标服务器
                        server: tool.server,
                        // 工具名
                        name: tool.name,
                        // 调用参数
                        args: (input ?? {}) as Record<string, unknown>,
                        // 所属会话 ID
                        sessionID: context.sessionID,
                      })
                      .pipe(
                        // 把 MCP 层的带标签错误统一转成工具失败
                        Effect.catchTags({
                          // 服务器不可用
                          "MCP.NotFoundError": (error) =>
                            new ToolFailure({ message: `MCP server "${error.server}" is not available` }),
                          // 调用出错
                          "MCP.ToolCallError": (error) => new ToolFailure({ message: error.message }),
                        }),
                      )
                    // 工具自身报错：把返回的文本内容拼成错误消息
                    if (result.isError)
                      return yield* new ToolFailure({
                        message:
                          result.content
                            // 仅收集文本片段
                            .flatMap((part) => (part.type === "text" ? [part.text] : []))
                            // 用换行拼接
                            .join("\n")
                            // 去首尾；为空时用默认消息
                            .trim() || "MCP tool returned an error",
                      })
                    // 把各内容片段转换为统一内容结构
                    const content = yield* Effect.forEach(result.content, (part) => toContent(part, toolOutput))
                    // 拼接全部文本片段
                    const text = content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
                    // 计算结构化输出
                    const output = () => {
                      // 服务器返回了结构化结果则直接使用
                      if (result.structured !== undefined) return result.structured
                      // 无文本时输出 null
                      if (text === "") return null
                      // Agents assume JSON returned as text is already an object, so parse it when the server declares no schema.
                      // 服务器未声明输出 Schema 且文本以 { 或 [ 开头：尝试解析为 JSON
                      if (tool.outputSchema === undefined && (text.startsWith("{") || text.startsWith("[")))
                        return Option.getOrElse(decodeJson(text), () => text)
                      // 其余情况原样返回文本
                      return text
                    }
                    // 返回工具结果：结构化输出 + 内容片段（无内容则省略字段）
                    return {
                      output: output(),
                      ...(content.length === 0 ? {} : { content }),
                    }
                  }).pipe(
                    // 执行期间的错误统一映射为 ToolFailure
                    Effect.mapError((error) => {
                      // 工具失败原样透传
                      if (error instanceof ToolFailure) return error
                      // 权限被拦截
                      if (error instanceof Permission.BlockedError)
                        return new ToolFailure({ message: error.message, error })
                      // 权限被纠正（带反馈信息）
                      if (error instanceof Permission.CorrectedError)
                        return new ToolFailure({ message: error.feedback, error })
                      // 其他错误给通用消息
                      return new ToolFailure({ message: `Unable to execute ${name(tool.server, tool.name)}`, error })
                    }),
                  ),
              })
            }
          })
        }),
      )
      // fork 到当前作用域的后台：不阻塞层的构建
      .pipe(Effect.forkScoped)
    // 重对齐（reconcile）：在锁保护下重新拉取工具目录并让注册中心全量刷新
    const reconcile = lock.withPermit(
      Effect.gen(function* () {
        discovered = yield* mcp.tools()
        yield* tools.reload()
      }),
    )

    // Servers announce tools in bursts and each read loads the whole catalog, so settle and refresh
    // once. The bus subscription stays eager; only the already-open sliding subscription is debounced.
    // 创建容量 1 的滑动 PubSub：只保留最新一次“有变化”信号
    const changes = yield* PubSub.sliding<void>(1)
    // 订阅总线的“工具列表变化”事件：每来一个事件就向 changes 发布一次
    yield* bus.subscribe(McpEvent.ToolsChanged).pipe(
      Stream.runForEach(() => PubSub.publish(changes, undefined)),
      // 立即启动的后台 Fiber
      Effect.forkScoped({ startImmediately: true }),
    )
    // 订阅 changes 信号
    const updates = yield* PubSub.subscribe(changes)
    // 对信号做 100ms 防抖后再触发重对齐（合并突发更新，避免重复全量刷新）
    yield* Stream.fromSubscription(updates).pipe(
      Stream.debounce("100 millis"),
      Stream.runForEach(() => reconcile),
      Effect.forkScoped({ startImmediately: true }),
    )
    // 返回服务实现
    return Service.of({
      // flush：等待初始注册、等待服务器启动完成，并兜底检查注册中心是否落后
      flush: Effect.gen(function* () {
        // 等待初始注册 Fiber 完成
        yield* Fiber.await(initial)
        // 等待 MCP 服务器集合完成启动（给仍在连接中的服务器一个有界的机会）
        yield* mcp.awaitStartup()
        // Each catalog refresh creates new tool objects, so identity shows whether the registry is behind.
        // 再次拉取当前目录
        const current = yield* mcp.tools()
        // 若与 discovered 在长度或对象标识上不一致，说明注册中心落后，立即重对齐
        if (current.length !== discovered.length || current.some((tool, index) => tool !== discovered[index]))
          yield* reconcile
      }),
    })
  }),
)

// Only media the read tool also accepts is sent inline; other types would fail request lowering on every later turn.
// 把 MCP 工具返回的单个内容片段转换为统一内容结构
const toContent = Effect.fnUntraced(function* (part: Mcp.ToolResultContent, toolOutput: ToolOutput.Interface) {
  // 文本片段直接透传
  if (part.type === "text") return { type: "text" as const, text: part.text }
  // 解析 MIME 类型：去掉 "; charset=..." 参数并转小写
  const mime = part.mimeType.split(";", 1)[0].trim().toLowerCase()
  // 读工具也接受的媒体类型：转为内联 data URI 的文件内容
  if (ReadToolFileSystem.MEDIA_MIMES.has(mime))
    return { type: "file" as const, uri: `data:${part.mimeType};base64,${part.data}`, mime: part.mimeType }
  // 其余类型先把 base64 解码为字节
  const bytes = Buffer.from(part.data, "base64")
  // 资源标签（优先用 uri，缺省叫 content）
  const label = part.uri ?? "content"
  // 文本类 MIME：解码为 UTF-8 文本内联返回
  if (Mime.isTextual(mime))
    return { type: "text" as const, text: `[Resource ${label} (${part.mimeType})]\n${bytes.toString("utf8")}` }
  // 其他二进制类型：推断文件扩展名
  const ext = extension(mime)
  // 保存到工具输出目录
  const file = yield* toolOutput.save(bytes, ext ? `.${ext}` : "")
  // 返回保存位置说明文本
  return {
    type: "text" as const,
    text: `[Binary resource ${label} (${part.mimeType}, ${bytes.byteLength} bytes) saved to ${file}]`,
  }
})

// 以位置节点形式导出服务，并声明全部依赖节点
export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Tool.node, Mcp.node, Bus.node, Permission.node, ToolOutput.node],
})
