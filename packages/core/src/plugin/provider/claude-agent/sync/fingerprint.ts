// 导出 Fingerprint 命名空间，供其他模块引用本文件内容
export * as Fingerprint from "./fingerprint.js"

// 导入 Node 的哈希工具
import { createHash } from "node:crypto"
// 导入 AI SDK 的消息与提示词类型
import type { LanguageModelV3Message, LanguageModelV3Prompt } from "@ai-sdk/provider"

// 组（Group）：一组连续的同角色消息，附带规范化哈希与起止下标
export interface Group {
  // 该组的规范化哈希
  readonly hash: string
  // 组内消息的角色（不含 system）
  readonly role: "user" | "assistant" | "tool"
  // 起始下标（含）
  readonly start: number
  // 结束下标（不含）
  readonly end: number
}

// 把任意值规范化为确定性字符串：数组展开、对象按键排序并剔除 undefined 字段
function canonical(value: unknown): string {
  // 数组：逐元素规范化后拼接
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  // 普通对象（非 null）：按键排序后逐字段规范化
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>
    // 收集字段字符串
    const fields: string[] = []
    // 遍历排序后的键
    for (const key of Object.keys(object).sort()) {
      // 跳过值为 undefined 的字段（避免可选字段影响哈希）
      if (object[key] !== undefined) fields.push(`${JSON.stringify(key)}:${canonical(object[key])}`)
    }
    // 拼接为对象字面量形式
    return `{${fields.join(",")}}`
  }
  // 基础类型直接 JSON 序列化（null/undefined 兜底为 "null"）
  return JSON.stringify(value) ?? "null"
}

// 计算规范化后的 SHA-256 哈希
function hash(value: unknown) {
  return createHash("sha256").update(canonical(value)).digest("hex")
}

// 提取消息中“对身份有意义”的部分：opencode 对 thinking 与 provider options 的编码会随目标模型变化，因此不计入。
// opencode sends thinking and provider options differently depending on the target model, so they don't count.
function visible(message: Exclude<LanguageModelV3Message, { role: "system" }>) {
  // 收集可见部件
  const parts: unknown[] = []
  // 暂存累积的文本
  let text = ""
  // 遍历内容块
  for (const part of message.content) {
    // 推理（reasoning）块不计入
    if (part.type === "reasoning") continue
    // 文本块：先累积（相邻文本合并）
    if (part.type === "text") {
      text += part.text
      continue
    }
    // 遇到非文本块时，先把已累积的文本冲刷为部件
    if (text) parts.push({ type: "text", text })
    text = ""
    // 文件块：把数据统一为字符串（URL 取 href；字符串原样；二进制转 base64）
    if (part.type === "file") {
      const data =
        part.data instanceof URL
          ? part.data.href
          : typeof part.data === "string"
            ? part.data
            : Buffer.from(part.data).toString("base64")
      parts.push({ type: part.type, mediaType: part.mediaType, data })
      continue
    }
    // 工具调用块：保留 id/名称/输入
    if (part.type === "tool-call") {
      parts.push({ type: part.type, id: part.toolCallId, name: part.toolName, input: part.input })
      continue
    }
    // 工具结果块：剔除 providerOptions 后保留
    if (part.type === "tool-result") {
      // 复制输出对象以便删改
      const output = { ...part.output }
      // 顶层 providerOptions 不计入
      if ("providerOptions" in output) delete output.providerOptions
      // content 型输出：逐项剔除 providerOptions
      if (output.type === "content") {
        output.value = output.value.map((part) => {
          const item = { ...part }
          delete item.providerOptions
          return item
        })
      }
      parts.push({ type: part.type, id: part.toolCallId, name: part.toolName, output })
    }
  }
  // 收尾：冲刷剩余文本
  if (text) parts.push({ type: "text", text })
  // 返回可见部件列表
  return parts
}

// OpenCode 会把工具产物降级为这样一条独立的 user 消息。
// OpenCode lowers tool attachments into this separate user message.
function isToolMedia(message: LanguageModelV3Message) {
  return (
    // 必须是 user 消息
    message.role === "user" &&
    // 且内容多于一块
    message.content.length > 1 &&
    // 第一块是特定标记文本
    message.content[0]?.type === "text" &&
    message.content[0].text === "Attached media from tool result:" &&
    // 其余块全部是文件
    message.content.slice(1).every((part) => part.type === "file")
  )
}

// 把提示词切分成组并计算哈希；prefix 是此前保存的组哈希，用于在连续 user 消息处对齐边界
export function groups(prompt: LanguageModelV3Prompt, prefix: readonly { readonly hash: string }[] = []): Group[] {
  // 结果组列表
  const groups: Group[] = []
  // 游标
  let i = 0
  // 逐条消息扫描
  while (i < prompt.length) {
    // 当前消息
    const message = prompt[i]!
    // 组起始下标
    const start = i
    // 前移游标
    i++
    // system 消息不参与分组
    if (message.role === "system") continue
    // 提取可见部件
    const parts = visible(message)
    // 空消息跳过
    if (parts.length === 0) continue
    // 组成员哈希：以当前消息开始
    const members = [hash(parts)]
    // user 消息：把紧随其后的连续 user 消息合并进同一组
    if (message.role === "user") {
      // 只要还有消息就继续
      while (i < prompt.length) {
        // 已提交过的输入仍是边界：即使之后有 user 消息没有可见回复，也要在检查点处断开
        // A submitted input remains a boundary even when a later user message arrives without a visible reply.
        const checkpoint = prefix[groups.length]
        // 若当前成员集与保存的检查点哈希一致，说明历史边界在此，停止合并
        if (checkpoint && hash({ role: message.role, members: members.toSorted() }) === checkpoint.hash) break
        // 取下一条消息
        const next = prompt[i]!
        // 不是 user 消息则停止合并
        if (next.role !== "user") break
        // 合并下一条 user 消息的可见哈希
        members.push(hash(visible(next)))
        i++
      }
      // 组成员排序（顺序无关，便于与 Claude 侧对齐）
      members.sort()
    }
    // tool 组：若紧随其后的是工具媒体 user 消息，则并入该组
    if (message.role === "tool") {
      const next = prompt[i]
      if (next && next.role === "user" && isToolMedia(next)) {
        members.push(hash(visible(next)))
        i++
      }
    }
    // 记录该组：整体哈希由角色与成员决定
    groups.push({ hash: hash({ role: message.role, members }), role: message.role, start, end: i })
  }
  // 返回所有组
  return groups
}
