// 将本模块以命名空间 McpInstructions 整体再导出（barrel 模式）
export * as McpInstructions from "./instructions.js"

// 引入应用节点定位辅助（把 Service+Layer 绑定到依赖图中的位置）
import { makeLocationNode } from "@opencode/util/effect/app-node"
// 引入 Effect 的 Context（服务标识）、Effect、Layer（依赖注入层）、Schema
import { Context, Effect, Layer, Schema } from "effect"
// 引入权限（Permission）模块
import { Permission } from "../permission.js"
// 引入 MCP 工具的命名空间/名称辅助
import { McpTool } from "../tool/mcp.js"
// 引入 MCP 服务本体
import { Mcp } from "./index.js"
// 引入指令（Instructions）列表服务
import { Instructions } from "../instructions/index.js"

// 单个服务器的指令摘要 schema：服务器名、指令文本、可选 codemode=false 标记
const Summary = Schema.Struct({
  // 服务器名
  server: Schema.String,
  // 该服务器给出的使用说明文本
  instructions: Schema.String,
  // 可选：显式声明不使用 Code Mode（只能是字面量 false）
  codemode: Schema.optionalKey(Schema.Literal(false)),
})
// 摘要类型（由 schema 推导）
type Summary = typeof Summary.Type

// 把摘要数组渲染成若干 <server> 条目行
const entries = (servers: ReadonlyArray<Summary>) =>
  servers.flatMap((server) => {
    // 条目开头：服务器标签行（两个空格缩进）
    const result = [`  <server name="${server.server}">`]
    // 该服务器启用 Code Mode 时，附加一条使用说明：通过 execute 工具并带上命名空间调用
    if (server.codemode !== false)
      result.push(
        `    Use tools from this server through \`execute\` under \`tools[${JSON.stringify(McpTool.namespace(server.server))}]\`.`,
      )
    // 指令文本按行拆分并统一缩进，最后附上闭合标签
    result.push(...server.instructions.split("\n").map((line) => `    ${line}`), "  </server>")
    // 返回该服务器的条目行列表
    return result
  })

// 把条目行包上 <mcp_instructions> 根标签并按行拼接成整段文本
const render = (servers: ReadonlyArray<Summary>) =>
  ["<mcp_instructions>", ...entries(servers), "</mcp_instructions>"].join("\n")

// 注册一个“列表型指令源”的更新逻辑：键、变更判定、渲染方式与增/改/删提示文案
const update = Instructions.listUpdate<Summary>({
  // 以服务器名作为条目唯一键
  key: (server) => server.server,
  // 变更判定：指令文本或 codemode 标记任一变化即视为改变
  changed: (before, after) => before.instructions !== after.instructions || before.codemode !== after.codemode,
  // 条目渲染函数
  entries,
  // 整体渲染函数
  render,
  // 各类变更时插入的提示文案
  text: {
    // 列表整体被替换时
    replaced: "The available MCP server instructions have changed. This list supersedes the previous one.",
    // 新增条目时
    added: "New MCP server instructions are available in addition to those previously listed:",
    // 条目变化时（同键覆盖）
    changed:
      "The following MCP server instructions have changed. Each entry replaces the previously listed server with the same name:",
    // 条目被移除时（函数式文案）
    removed: (names) => `Instructions for the following MCP servers are no longer available: ${names}.`,
  },
})

// 服务接口：按权限规则加载可用的 MCP 服务器指令列表
export interface Interface {
  /** Lists server instructions reachable under the given ruleset; callers pass the merged agent and Session permissions. */
  // load：在给定权限规则集下列出可达的服务器指令
  readonly load: (permissions: Permission.Ruleset) => Effect.Effect<Instructions.List>
}

// Effect 服务标识（Tag）：用于从上下文中取回本服务
export class Service extends Context.Service<Service, Interface>()("@opencode/McpInstructions") {}

// 构建服务层：依赖 Mcp 服务
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 取回 MCP 服务
    const mcp = yield* Mcp.Service

    return Service.of({
      // load 实现：计算在权限范围内可见的服务器指令
      load: Effect.fn("McpInstructions.load")(function* (permissions) {
        // 指令源工厂：用给定值生成 Instructions 条目（核心内置的 MCP 指引）
        const source = (value: ReadonlyArray<Summary> | Instructions.Removed) =>
          Instructions.make<ReadonlyArray<Summary>>({
            // 固定键，标识这是核心内置的 MCP 指引
            key: Instructions.Key.make("core/mcp-guidance"),
            // 值的 JSON 编解码器（摘要数组）
            codec: Schema.toCodecJson(Schema.Array(Summary)),
            // 直接返回给定值（不做额外读取）
            read: Effect.succeed(value),
            // 渲染配置：初次渲染、变化时更新、移除时提示
            render: {
              initial: render,
              changed: update,
              removed: () => "MCP server instructions are no longer available.",
            },
          })
        // 并行取回服务器指令与全部工具（无并发上限）
        const [instructions, tools] = yield* Effect.all([mcp.instructions(), mcp.tools()], {
          concurrency: "unbounded",
        })
        // 判断本会话是否对任意工具拥有 execute 权限（效果不为 deny）
        const canExecute = Permission.evaluate("execute", "*", permissions).effect !== "deny"
        // Instructions are useful only when this Session can reach at least one server tool.
        // 过滤出可见的服务器指令：至少要有一个工具可通过权限访问
        const visible = instructions
          .flatMap((item) => {
            // 找出属于该服务器的全部工具
            const owned = tools.filter((tool) => tool.server === item.server)
            // Without execute, Code Mode server tools are exposed directly.
            // 判定是否走 Code Mode：需要 execute 权限且服务器未显式关闭
            const codemode = canExecute && owned[0]?.codemode !== false
            // 若该服务器的任一工具都不能通过权限访问，则整个服务器不可见
            if (
              !owned.some(
                (tool) =>
                  Permission.evaluate(McpTool.name(tool.server, tool.name), "*", permissions).effect !== "deny",
              )
            )
              return []
            // 生成该服务器的摘要：走 Code Mode 时不带标记，否则显式标 codemode: false
            return [
              codemode
                ? { server: item.server, instructions: item.instructions }
                : { server: item.server, instructions: item.instructions, codemode: false as const },
            ]
          })
          // 按服务器名排序（本地化比较）
          .toSorted((a, b) => a.server.localeCompare(b.server))
        // 全部不可见时返回“已移除”标记，否则返回可见列表
        return source(visible.length === 0 ? Instructions.removed : visible)
      }),
    })
  }),
)

// 生成带依赖信息的节点（依赖 Mcp 节点）
export const node = makeLocationNode({ service: Service, layer, deps: [Mcp.node] })
