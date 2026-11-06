// 以命名空间形式导出 ToolOutput 模块
export * as ToolOutput from "./tool-output.js"

// 引入 Node path，用于拼接文件路径
import path from "path"
// 仅引入 Tool 类型（内容与结果结构）
import type { Tool } from "./tool.js"
// 引入 Effect 原语：Context、Duration、Effect、Layer（层）、Schedule（调度）
import { Context, Duration, Effect, Layer, Schedule } from "effect"
// 引入全局/位置级服务节点构造工具
import { makeGlobalNode, makeLocationNode } from "@opencode/util/effect/app-node"
// 引入文件系统工具服务
import { FSUtil } from "@opencode/util/fs-util"
// 引入全局数据目录服务
import { Global } from "@opencode/util/global"
// 引入标识符生成器（用于文件名）
import { Identifier } from "@opencode/schema/identifier"
// 引入按保留期清理文件的工具
import { FileRetention } from "./file-retention.js"
// 引入状态框架
import { State } from "./state.js"

// 模型可见输出的默认最大行数
export const MAX_LINES = 2_000
// 默认最大字节数：50 KiB
export const MAX_BYTES = 50 * 1024 // 50 KiB
// 落盘输出的保留时长：7 天
export const RETENTION = Duration.days(7)
// 输出文件存放的数据子目录名
export const DIRECTORY = "tool-output"

// 生成输出文件名：tool_ + 唯一标识符（可带时间戳）
export const fileName = (timestamp?: number) => "tool_" + Identifier.create(false, timestamp)

// 结果类型别名（规范化后的工具结果）
type Result = Tool.NormalizedResult

// 行数/字节限制
type Limits = {
  maxLines: number
  maxBytes: number
}

// 状态编辑器：部分更新限制
export type Editor = {
  configure: (limits: Partial<Limits>) => void
}

// 服务接口（含状态变换能力）
export interface Interface extends State.Transformable<Editor> {
  // 截断超限的结果内容
  readonly truncate: (result: Result) => Effect.Effect<Result>
  /** Writes bytes the model cannot receive inline to a retained file and returns its path. */
  // （中文）把无法内联返回给模型的字节写入保留文件，并返回其路径
  readonly save: (bytes: Uint8Array, extension: string) => Effect.Effect<string>
  // 立即执行一次过期文件清理
  readonly cleanup: () => Effect.Effect<void>
}

// 定义 ToolOutput 服务标记类
export class Service extends Context.Service<Service, Interface>()("@opencode/ToolOutput") {}

// （中文）清理目录中过期的 tool_ 前缀输出文件
const cleanup = Effect.fn("ToolOutput.cleanup")(function* (fs: FSUtil.Interface, directory: string) {
  // 读取目录并筛出合法的输出文件名；目录不存在等错误按空数组处理
  const entries = yield* fs.readDirectory(directory).pipe(
    Effect.map((entries) => entries.filter((entry) => /^tool_[0-9a-f]{12}/.test(entry))),
    Effect.orElseSucceed(() => []),
  )
  // 按保留期删除过期文件
  yield* FileRetention.cleanup(
    fs,
    entries.map((entry) => path.join(directory, entry)),
    RETENTION,
  )
})

// 构建服务层
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 获取文件系统工具服务
    const fs = yield* FSUtil.Service
    // 获取全局数据目录
    const global = yield* Global.Service
    // 输出目录：数据目录/tool-output
    const directory = path.join(global.data, DIRECTORY)
    // 限制状态（可通过编辑器配置）
    const state = State.create<Limits, Editor>({
      name: "tool-output",
      // 默认限制
      initial: () => ({ maxLines: MAX_LINES, maxBytes: MAX_BYTES }),
      editor: (editor) => ({
        configure: (limits) => {
          // 更新行数限制（若提供）
          if (limits.maxLines !== undefined) editor.maxLines = limits.maxLines
          // 更新字节限制（若提供）
          if (limits.maxBytes !== undefined) editor.maxBytes = limits.maxBytes
        },
      }),
    })

    // （中文）截断实现：把超限输出裁剪到限制内，全量文本落盘并在模型可见内容中插入提示
    const truncate = Effect.fnUntraced(function* (result: Result) {
      // 已处理过（带 truncated 标记）的结果直接返回
      if (result.metadata?.truncated !== undefined) return result
      // 原始内容块
      const content = result.content
      // 拼接全部文本块
      const text = content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n")
      // 读取当前限制
      const limits = state.get()
      // 按行拆分
      const lines = text.split("\n")
      // 末尾换行产生的空行不计入
      if (text.endsWith("\n")) lines.pop()
      // 全文的 UTF-8 字节数
      const totalBytes = Buffer.byteLength(text, "utf-8")
      // 未超限：仅补上 truncated=false 标记
      if (lines.length <= limits.maxLines && totalBytes <= limits.maxBytes)
        return { ...result, metadata: { ...result.metadata, truncated: false } }

      // 保留在模型输出中的行
      const kept: string[] = []
      // 已保留的字节数
      let bytes = 0
      // 逐行收集，直到达到行数或字节上限
      for (const line of lines.slice(0, limits.maxLines)) {
        // 该行占用的字节（行间补一个换行符）
        const size = Buffer.byteLength(line, "utf-8") + (kept.length > 0 ? 1 : 0)
        // 超出字节上限即停止收集
        if (bytes + size > limits.maxBytes) break
        // 收录该行
        kept.push(line)
        bytes += size
      }
      // 全量文本的落盘路径
      const file = path.join(directory, fileName())
      // 确保输出目录存在
      yield* fs.ensureDir(directory).pipe(Effect.orDie)
      // 写入完整文本
      yield* fs.writeFileString(file, text).pipe(Effect.orDie)
      // 提示已展示的行范围（无保留行时显示 "0 lines"）
      const shown = kept.length > 0 ? `lines 1-${kept.length}` : "0 lines"
      // 截断提示文本
      const marker = `[showing ${shown} of ${lines.length}; full output saved to ${file}]`
      // 截断后的内容块
      const bounded: Tool.Content[] = []
      // 仍可分配给文本块的字符预算
      let remaining = kept.join("\n").length
      // 是否已遇到文本块
      let seenText = false
      // 是否已插入过提示
      let marked = false
      // 按预算裁剪各文本块
      for (const item of content) {
        // 文件块原样保留
        if (item.type === "file") {
          bounded.push(item)
          continue
        }
        // 首块之外的文本块之间按 1 字符预算扣除
        if (seenText && remaining > 0) remaining--
        seenText = true
        // 整块仍在预算内则整块保留
        if (remaining >= item.text.length) {
          bounded.push(item)
          remaining -= item.text.length
          continue
        }
        // 剩余预算不够整块时截短该块（尚有剩余才放入）
        if (remaining > 0) bounded.push({ ...item, text: item.text.slice(0, remaining) })
        // 在首次截断处插入提示
        if (!marked) bounded.push({ type: "text", text: marker })
        // 预算用尽
        remaining = 0
        marked = true
      }
      // 全程未插入过提示时补在末尾
      if (!marked) bounded.push({ type: "text", text: marker })
      // 返回截断结果（带输出路径与标记）
      return {
        ...result,
        content: bounded,
        metadata: { ...result.metadata, truncated: true, outputPath: file },
      }
    })

    // （中文）把二进制字节保存为保留文件并返回路径
    const save = Effect.fnUntraced(function* (bytes: Uint8Array, extension: string) {
      // 目标文件名（追加扩展名）
      const file = path.join(directory, fileName() + extension)
      // 写入文件（必要时创建目录）
      yield* fs.writeWithDirs(file, bytes).pipe(Effect.orDie)
      // 返回文件路径
      return file
    })

    // 组装服务实例
    return Service.of({
      transform: state.transform,
      reload: state.reload,
      truncate,
      save,
      cleanup: () => cleanup(fs, directory),
    })
  }),
)

// 周期清理层：每小时清理一次过期输出文件（随作用域后台运行）
const cleanupLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    // 获取文件系统工具服务
    const fs = yield* FSUtil.Service
    // 获取全局数据目录
    const global = yield* Global.Service
    // 重复执行清理
    yield* cleanup(fs, path.join(global.data, DIRECTORY)).pipe(
      Effect.repeat(Schedule.spaced(Duration.hours(1))),
      Effect.forkScoped,
    )
  }),
)

// 注册全局清理节点
const cleanupNode = makeGlobalNode({
  name: "tool-output-cleanup",
  layer: cleanupLayer,
  deps: [FSUtil.node, Global.node],
})

// 导出位置级服务节点
export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Global.node, cleanupNode],
})
