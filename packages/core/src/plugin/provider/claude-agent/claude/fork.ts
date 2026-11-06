// 以命名空间形式整体再导出本模块
export * as ClaudeFork from "./fork.js"

// ClaudeSDK：惰性加载的 Claude Agent SDK 访问器
import { ClaudeSDK } from "./sdk.js"

// Result：fork 结果（新会话 ID 与旧消息 ID 到新消息 ID 的映射）
export interface Result {
  // fork 出的新会话 ID
  readonly sessionID: string
  // 原消息 UUID -> 新消息 UUID 的映射
  readonly messages: ReadonlyMap<string, string>
}

// The SDK gives forked messages fresh UUIDs. Verify the copied prefix before mapping checkpoints onto them.
// create：从指定消息处分叉（fork）会话；先校验复制的消息前缀，再建立检查点映射。
export async function create(sessionID: string, messageID: string): Promise<Result | undefined> {
  // 按需加载 SDK 的三个会话操作
  const { deleteSession, forkSession, getSessionMessages } = await ClaudeSDK.load()
  // 读取原会话的全部消息
  const source = await getSessionMessages(sessionID)
  // 定位分叉终点消息的下标
  const end = source.findIndex((message) => message.uuid === messageID)
  // 未找到目标消息则放弃
  if (end < 0) return
  // 执行 SDK 的会话分叉（复制到目标消息为止）
  const fork = await forkSession(sessionID, { upToMessageId: messageID })
  // 校验阶段出错时清理新会话
  try {
    // 读取新会话复制的消息
    const copied = await getSessionMessages(fork.sessionId)
    // 复制数量必须与截断点一致，否则说明历史边界被破坏
    if (copied.length !== end + 1) throw new Error("Claude fork did not preserve the requested history boundary")
    // 构建新旧消息 UUID 映射
    const messages = new Map<string, string>()
    // 逐条对比复制前后的一致性
    for (let i = 0; i < copied.length; i++) {
      // 原会话第 i 条
      const before = source[i]!
      // 新会话第 i 条
      const after = copied[i]!
      // 类型或消息体不一致即视为分叉被篡改
      if (before.type !== after.type || JSON.stringify(before.message) !== JSON.stringify(after.message)) {
        // 抛出错误
        throw new Error("Claude fork changed the copied conversation")
      }
      // 记录映射关系
      messages.set(before.uuid, after.uuid)
    }
    // 返回分叉结果
    return { sessionID: fork.sessionId, messages }
  } catch (error) {
    // 校验失败：删除已创建的新会话
    await deleteSession(fork.sessionId)
    // 重新抛出错误
    throw error
  }
}
