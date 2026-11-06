// 导出 SyncDecision 命名空间，供其他模块引用本文件内容
export * as SyncDecision from "./decide.js"

// 导入 AI SDK 的提示词类型
import type { LanguageModelV3Prompt } from "@ai-sdk/provider"
// 导入指纹模块：把提示词切分成组并计算哈希
import { Fingerprint } from "./fingerprint.js"
// 导入会话记录类型
import type { SessionRecord } from "./record.js"

// 决定本轮请求如何与 Claude 会话同步：全新开始 / 分支变更 / 补齐历史 / 直接继续
export function decide(prompt: LanguageModelV3Prompt, record?: SessionRecord.Record) {
  // 取出上次保存的历史检查点（可能没有记录）
  const saved = record?.history ?? []
  // 计算当前提示词的分组；中断场景下把已保存的历史传进去用于对齐
  const groups = Fingerprint.groups(prompt, record?.interrupted ? saved : undefined)
  // 没有任何历史：全新（fresh）请求，从第 0 条开始
  if (saved.length === 0) return { kind: "fresh", start: 0 } as const

  // 记录前后历史匹配的组数
  let matched = 0
  // 逐组比对哈希，直到不匹配或某一边用尽
  while (matched < saved.length && matched < groups.length) {
    // 哈希不一致则停止比对
    if (saved[matched]!.hash !== groups[matched]!.hash) break
    // 匹配成功，继续下一组
    matched++
  }
  // 一组都对不上：说明历史完全变了，按全新请求处理
  if (matched === 0) return { kind: "fresh", start: 0 } as const
  // 已保存的历史发生了变化：需要创建隔离分支；若没有安全检查点可用则只能重建
  // Changed histories need an isolated branch, or a rebuild when no safe checkpoint survives.
  if (matched < saved.length) return { kind: "changed", start: 0 } as const

  // 被中断的回复以 Claude 侧已抽取的记录为准，而不是 OpenCode 本地的残缺副本
  // Claude's drained transcript owns the interrupted reply, not OpenCode's partial copy.
  while (record?.interrupted && groups[matched]?.role === "assistant") {
    // 取出该 assistant 组的首条消息
    const reply = prompt[groups[matched]!.start]!
    // 若这条“残缺回复”包含工具调用，则不能跳过，停止
    if (reply.role !== "assistant" || reply.content.some((part) => part.type === "tool-call")) break
    // 纯文本的残缺回复可以跳过（Claude 会用自己的版本补齐）
    matched++
  }
  // 计算本轮请求的起始下标（下一组的位置；没有下一组则等于提示词长度）
  const start = groups[matched]?.start ?? prompt.length
  // 中断场景下若无新增内容需要发送，说明本地与 Claude 侧历史有分歧，需要重建
  if (record?.interrupted && start === prompt.length) return { kind: "changed", start: 0 } as const
  // 取出尚未同步（漏发）的组
  const missed = groups.slice(matched)
  // 若漏发内容中存在非 user 角色（如工具结果），需要先做“补齐（catch-up）”；否则是普通继续（continue）
  const kind = missed.some((group) => group.role !== "user") ? "catch-up" : "continue"
  // 返回同步决策
  return { kind, start } as const
}

// 查找安全的分支边界：分支不能落在原生工具调用与其结果之间
// A branch must not end between a native tool call and its results.
export function boundary(prompt: LanguageModelV3Prompt, record?: SessionRecord.Record) {
  // 计算当前提示词的分组
  const groups = Fingerprint.groups(prompt)
  // 取出上次保存的历史检查点
  const history = record?.history ?? []
  // 记录尚未收到结果的工具调用 ID 集合
  const pending = new Set<string>()
  // 保存找到的安全边界（Claude 消息 ID、截断位置、可保留的历史）
  let found: { messageID: string; start: number; history: readonly SessionRecord.Checkpoint[] } | undefined
  // 逐组扫描
  for (let i = 0; i < groups.length; i++) {
    // 取出当前组
    const group = groups[i]!
    // 撤销（undo）可能重新提交完全相同的输入；最新的 user 组要留给新一轮使用
    // Undo can resubmit identical input; keep the current user group for the new turn.
    if (i === groups.length - 1 && group.role === "user") break
    // 取该组对应的历史检查点
    const checkpoint = history[i]
    // 检查点缺失或哈希不一致：再往前就无法确认安全了，停止
    if (!checkpoint || checkpoint.hash !== group.hash) break
    // 遍历该组内所有消息，维护“未完成工具调用”集合
    for (const message of prompt.slice(group.start, group.end)) {
      // 系统消息不参与
      if (message.role === "system") continue
      // 遍历内容块
      for (const part of message.content) {
        // 工具调用：加入待完成集合
        if (part.type === "tool-call") pending.add(part.toolCallId)
        // 工具结果：从待完成集合移除
        if (part.type === "tool-result") pending.delete(part.toolCallId)
      }
    }
    // 该组已有对应的 Claude 消息 ID 且没有悬空的工具调用：可以在此安全分支
    if (checkpoint.claudeMessageID && pending.size === 0) {
      // 记录边界：截断位置为组末尾，历史保留到当前组
      found = { messageID: checkpoint.claudeMessageID, start: group.end, history: history.slice(0, i + 1) }
    }
  }
  // 返回最后一个安全边界（可能为 undefined）
  return found
}
