// 引入会话（Session）核心：错误类型定义
import { Session } from "@opencode/core/session"
// 引入快照（Snapshot）类型（仅类型）
import type { Snapshot } from "@opencode/core/snapshot"
// 引入协议层错误：消息未找到、会话未找到、未知错误
import { MessageNotFoundError, SessionNotFoundError, UnknownError } from "@opencode/protocol/errors"
// 引入 Effect 运行时
import { Effect } from "effect"

// 辅助函数：把会话服务的 NotFoundError 映射为协议层 SessionNotFoundError
export function missingSession(error: Session.NotFoundError) {
  return new SessionNotFoundError({
    sessionID: error.sessionID,
    message: `Session not found: ${error.sessionID}`,
  })
}

// 辅助函数：把会话消息未找到错误映射为协议层 MessageNotFoundError
export function missingMessage(error: Session.MessageNotFoundError) {
  return new MessageNotFoundError({
    sessionID: error.sessionID,
    messageID: error.messageID,
    message: `Message not found: ${error.messageID}`,
  })
}

// 辅助函数：处理会话消息解码失败——记录日志并返回带引用编号的未知错误（不泄露内部细节）
export function failedMessageDecode(error: Session.MessageDecodeError) {
  // 生成短随机引用编号，用于关联错误响应与服务端日志
  const ref = `err_${crypto.randomUUID().slice(0, 8)}`
  return Effect.logError("failed to decode session message").pipe(
    // 日志附加引用编号与上下文（会话/消息 ID），便于排查
    Effect.annotateLogs({ ref, sessionID: error.sessionID, messageID: error.messageID }),
    Effect.andThen(
      // 对客户端只返回通用提示与引用编号
      Effect.fail(new UnknownError({ message: "Unexpected server error. Check server logs for details.", ref })),
    ),
  )
}

/** Snapshot repositories are host state clients cannot repair, so surface only a log reference. */
// 辅助工厂：快照（snapshot）仓库属于客户端无法自行修复的主机状态，因此只透出日志引用编号
export function failedSnapshot(operation: string, sessionID: Session.ID) {
  // 返回错误映射函数：operation 描述出错的快照操作（如 "stage session revert"）
  return (error: Snapshot.Error) => {
    // 生成短随机引用编号，用于关联错误响应与服务端日志
    const ref = `err_${crypto.randomUUID().slice(0, 8)}`
    return Effect.logError(`failed to ${operation}`, { cause: error }).pipe(
      // 日志附加引用编号与会话 ID
      Effect.annotateLogs({ ref, sessionID }),
      Effect.andThen(
        // 对客户端只返回通用提示与引用编号
        Effect.fail(new UnknownError({ message: "Unexpected server error. Check server logs for details.", ref })),
      ),
    )
  }
}
