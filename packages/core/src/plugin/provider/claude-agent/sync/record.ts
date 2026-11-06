// 导出 SessionRecord 命名空间，供其他模块引用本文件内容
export * as SessionRecord from "./record.js"

// 从 effect 库导入 Effect、Option（可选值）与 Schema（校验/编解码）
import { Effect, Option, Schema } from "effect"

// 定义“检查点（Checkpoint）”结构：一次同步断点的哈希，以及可选的已送达的 Claude 消息 ID
const Checkpoint = Schema.Struct({ hash: Schema.String, claudeMessageID: Schema.optional(Schema.String) })
// 导出检查点的 TypeScript 类型（由 Schema 推导）
export type Checkpoint = typeof Checkpoint.Type
// 定义“会话记录（Record）”结构：Claude 会话 ID、可选的历史检查点列表、以及中断标记
const Record = Schema.Struct({
  // 对应的 Claude 原生会话 ID
  claudeSessionID: Schema.String,
  // 可选：同步历史（每个检查点记录到哪一步了）
  history: Schema.optional(Schema.Array(Checkpoint)),
  // 取消后，未完成的回复归 Claude 所有；历史只记录到它已收到的输入为止
  // After cancellation, Claude owns the partial reply; history ends at the input it received.
  interrupted: Schema.optional(Schema.Boolean),
})
// 导出会话记录的 TypeScript 类型（由 Schema 推导）
export type Record = typeof Record.Type

// 存储接口：按键读取任意值 / 写入会话记录
export interface Storage {
  // 读取指定键的原始值（未知类型）
  readonly get: (key: string) => Effect.Effect<unknown>
  // 写入指定键的会话记录
  readonly set: (key: string, value: Record) => Effect.Effect<void>
}

// 工厂函数：基于给定存储实现构造会话记录的读写器
export function make(storage: Storage) {
  return {
    // 读取某个 OpenCode 会话对应的记录
    get: Effect.fn("SessionRecord.get")(function* (sessionID: string) {
      // 从存储中取出原始值，并用 Schema 校验解码为 Record（解码失败时返回 none）
      const saved = Schema.decodeUnknownOption(Record)(yield* storage.get(`sessions/${sessionID}`))
      // 把 Option 转成 undefined（不存在或无效时返回 undefined）
      return Option.getOrUndefined(saved)
    }),
    // 写入某个 OpenCode 会话的记录（键为 sessions/<sessionID>）
    set: (sessionID: string, record: Record) => storage.set(`sessions/${sessionID}`, record),
  }
}
