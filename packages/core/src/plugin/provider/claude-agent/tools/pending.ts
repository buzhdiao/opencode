// 导出 PendingTools 命名空间，供其他模块引用本文件内容
export * as PendingTools from "./pending.js"

// 导入 MCP 的工具调用结果类型
import type { CallToolResult } from "@modelcontextprotocol/server"
// 导入工具结果类型
import type { ToolResult } from "./result.js"

// 一次进行中的工具调用：工具名 + 可解析的 Promise（等待 OpenCode 侧给出结果）
interface Call {
  // 带前缀的完整工具名
  readonly name: string
  // 用 Promise.withResolvers 创建的待解析 Promise
  readonly result: PromiseWithResolvers<ToolResult.Result>
}

// PendingTools 的接口：协调 Claude 侧工具调用与 OpenCode 侧实际执行
export interface Interface {
  // 预登记一次调用（由模型流解析时调用）
  readonly expect: (id: string, name: string) => void
  // 工具调用开始前登记（由 PreToolUse 钩子调用），并记录“下一个”调用 ID
  readonly before: (id: string, name: string) => void
  // MCP 服务器收到 tools/call 时调用：等待 OpenCode 的执行结果
  readonly call: (name: string) => Promise<CallToolResult>
  // OpenCode 执行完毕后回填结果
  readonly resolve: (id: string, result: ToolResult.Result) => void
  // 取出该调用的“替换输出”（供 PostToolUse 钩子改写 Claude 看到的结果）
  readonly after: (id: string) => ToolResult.Result["replacement"]
  // 清空所有进行中的调用（用于中断场景）
  readonly clear: () => void
}

// 工厂函数：创建 PendingTools 实现
export function make(): Interface {
  // 进行中的调用表（按调用 ID）
  const calls = new Map<string, Call>()
  // 每个调用的替换输出表（按调用 ID）
  const replacements = new Map<string, ToolResult.Result["replacement"]>()
  // “下一个”调用 ID：由 PreToolUse 钩子设置，供随后到来的 tools/call 使用
  let next: string | undefined

  // 预登记/获取一次调用：不存在则创建并登记；工具名不匹配则报错
  function expect(id: string, name: string) {
    // 查找已登记的调用
    const saved = calls.get(id)
    // 没有则创建新的调用记录（附一个可解析的 Promise）
    const call = saved ?? { name, result: Promise.withResolvers<ToolResult.Result>() }
    // 首次出现时登记
    if (!saved) calls.set(id, call)
    // 同一 ID 出现不同工具名说明状态错乱，抛错
    if (call.name !== name) throw new Error(`Mismatched Claude tool call ${id}`)
    // 返回调用记录
    return call
  }

  // 返回接口实现
  return {
    // 暴露 expect
    expect,
    // PreToolUse 钩子调用：登记调用并把它设为“下一个”
    before(id: string, name: string) {
      // 校验并登记
      expect(id, name)
      // 记录下一个调用 ID
      next = id
    },
    // MCP tools/call 处理：等待 OpenCode 侧执行结果
    async call(name: string) {
      // 取出“下一个”调用 ID 并清空
      const id = next
      next = undefined
      // 没有 PreToolUse 登记的 ID 说明时序错乱，抛错
      if (!id) throw new Error("Claude invoked an OpenCode tool without its PreToolUse ID")
      // 校验并获取调用记录
      const call = expect(id, name)
      // 等待 OpenCode 侧的执行结果
      const result = await call.result.promise
      // 若结果带替换输出，则记录下来供 PostToolUse 钩子使用
      if (result.replacement) replacements.set(id, result.replacement)
      // 调用完成，从表中移除
      calls.delete(id)
      // 返回 MCP 格式的结果给 Claude
      return result.mcp
    },
    // OpenCode 执行完毕后回填结果
    resolve(id: string, result: ToolResult.Result) {
      // 查找等待中的调用
      const call = calls.get(id)
      // 没有等待中的调用说明状态错乱，抛错
      if (!call) throw new Error(`No waiting Claude tool call ${id}`)
      // 解析该调用的 Promise
      call.result.resolve(result)
    },
    // PostToolUse 钩子调用：取出并移除该调用的替换输出
    after(id: string) {
      // 取出替换输出
      const replacement = replacements.get(id)
      // 用后即删
      replacements.delete(id)
      // 返回替换输出（可能为 undefined）
      return replacement
    },
    // 只能在“中断并排空（interrupt-and-drain）”之后调用；过早 resolve 这些 handler 可能引发另一次模型调用。
    // Call only after interrupt-and-drain; resolving these handlers earlier can start another model call.
    clear() {
      // 把所有等待中的调用以“用户取消”错误结果收尾
      for (const call of calls.values()) {
        call.result.resolve({
          // 标记为错误
          mcp: { isError: true, content: [{ type: "text", text: "Cancelled by user." }] },
          // 无替换输出
          replacement: undefined,
        })
      }
      // 清空调用表
      calls.clear()
      // 清空替换输出表
      replacements.clear()
      // 清空“下一个”调用 ID
      next = undefined
    },
  }
}
