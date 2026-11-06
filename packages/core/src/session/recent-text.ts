// 将本模块以命名空间形式整体导出为 SessionRecentText
export * as SessionRecentText from "./recent-text.js"

// 会话消息类型
import type { SessionMessage } from "./message.js"
// 用户消息的持久化形态类型
import type { SessionStored } from "./stored.js"

// 工具输出在摘要中保留的最大字符数
const TOOL_OUTPUT_MAX_CHARS = 1_250

/**
 * The text of the messages a summary compaction kept verbatim. History rebuilds it from `metadata.keepID`;
 * compactions written before that reference carry the text they stored.
 */
// 摘要压缩逐字保留的消息文本。历史可从 metadata.keepID 重建；
// 在该引用出现之前写入的压缩则携带它们存储的文本
export const kept = (message: SessionMessage.CompactionCompleted) =>
  // metadata.recent 是字符串时使用之，否则返回空串
  typeof message.metadata?.recent === "string" ? message.metadata.recent : ""

/** One message as the recent, verbatim part of a summary shows it. Empty for messages that part leaves out. */
// 把单条消息渲染成摘要「近期原文」部分中的样子；被该部分排除的消息返回空串
export const messageToText = (message: SessionMessage.Info | SessionStored.User): string => {
  // 按消息类型分别渲染
  switch (message.type) {
    // Earlier summaries and instruction updates are handled outside the recent part.
    // 更早的摘要与指令更新在「近期原文」之外单独处理
    case "compaction":
    case "system":
      return ""

    // 用户消息：技能、正文与附件依次渲染
    case "user": {
      // 有正文的技能渲染为「技能激活」标记
      const skills =
        message.skills?.flatMap((skill) =>
          skill.text === undefined ? [] : [`[Skill activated: ${skill.name}]\n${skill.text}`],
        ) ?? []
      // 每个附件渲染为一行「已附加」标记，名字缺失时回退到 URI 或内联文案
      const files =
        message.files?.map((file) => {
          const name = file.name ?? (file.source.type === "uri" ? file.source.uri : "inline attachment")
          return `[Attached ${file.mime}: ${name}]`
        }) ?? []
      // 按顺序拼接：技能、用户正文、附件
      return [...skills, `[User]: ${message.text}`, ...files].join("\n")
    }

    // 目录切换消息：说明工作目录变更
    case "location-switched":
      return `[User]: The working directory has been changed to ${message.location.directory}.`

    // 助手消息：文本、工具调用与结果逐段渲染
    case "assistant":
      return message.content
        .flatMap((part) => {
          // 文本部件：助手正文
          if (part.type === "text") return [`[Assistant]: ${part.text}`]
          // Providers return summaries of the real reasoning, and written out as text it can read like an attempt to
          // extract the model's thinking.
          // 提供方返回的是真实推理的摘要，写成文本容易被读成试图泄露模型思维，因此不渲染
          if (part.type === "reasoning") return []

          // 工具入参：字符串原样，其他 JSON 序列化
          const input = typeof part.state.input === "string" ? part.state.input : JSON.stringify(part.state.input)
          // 工具调用行
          const call = `[Assistant tool call]: ${part.name}(${input})`
          // 已完成：附上（截断后的）工具结果
          if (part.state.status === "completed") {
            return [call, `[Tool result]: ${truncateToolOutput(serializeToolContent(part.state.content))}`]
          }
          // 出错：附上错误信息
          if (part.state.status === "error") return [call, `[Tool error]: ${part.state.error.message}`]
          // 其他状态只显示调用行
          return [call]
        })
        .join("\n")

    // 合成消息：合成上下文标记
    case "synthetic":
      return `[Synthetic context]: ${message.text}`

    // 技能消息：技能激活标记
    case "skill":
      return `[Skill activated: ${message.name}]\n${message.text}`

    // Shell 消息：后台 shell 不展示，前台显示命令与截断后的输出
    case "shell":
      if (message.metadata?.background === true) return ""
      return `[Shell]: ${message.command}\n${truncateToolOutput(message.output?.output ?? "")}`

    // 未知类型：留空
    default:
      return ""
  }
}

// 截断工具输出到上限字符数，必要时加截断标记
export const truncateToolOutput = (value: string) => {
  // 未超限则原样返回
  if (value.length <= TOOL_OUTPUT_MAX_CHARS) return value

  // Count code points so a surrogate pair is never split.
  // 按码点（code point）计数，避免把代理对（surrogate pair）截成两半
  let end = 0
  let kept = 0
  // 逐字符遍历直到达到上限
  for (const char of value) {
    if (kept === TOOL_OUTPUT_MAX_CHARS) break
    // 累计字节（UTF-16 码元）长度
    end += char.length
    kept++
  }
  // 长度与码点数一致的巧合下原样返回
  if (end === value.length) return value
  // 返回截断结果并附加标记
  return `${value.slice(0, end)}\n[truncated]`
}

// 把工具结果内容序列化为文本：文本原样，媒体只保留 mime 与名字
export const serializeToolContent = (content: ReadonlyArray<SessionMessage.ToolStateCompleted["content"][number]>) =>
  content
    .map((item) => {
      // 文本项直接输出
      if (item.type === "text") return item.text
      // 媒体项输出为「已附加」标记（无名时省略名字）
      return `[Attached ${item.mime}${item.name === undefined ? "" : `: ${item.name}`}]`
    })
    .join("\n")
