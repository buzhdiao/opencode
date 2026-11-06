// 将本模块以命名空间 `SessionStored` 全量导出
export * as SessionStored from "./stored.js"

// 引入 effect 的 Schema 库
import { Schema } from "effect"
// 引入用户附件与媒体引用 schema
import { FileAttachment, MediaRef } from "@opencode/schema/prompt"
// 引入"可选"（optional）组合子
import { optional } from "@opencode/schema/schema"
// 引入收件箱的用户载荷 schema（重命名为 InboxUserPayload 以示区分）
import { UserPayload as InboxUserPayload } from "@opencode/schema/session-inbox"
// 引入工具（Tool）schema
import { Tool } from "@opencode/schema/tool"
// 引入会话消息模块
import { SessionMessage } from "./message.js"

/**
 * Stored rows may reference a `blob` row as `media:` and the lowercase hex SHA-256 of its raw bytes. The blob
 * row holds the bytes and size; the ref names no server route.
 */
// 存储行对 blob 的引用格式（复用 MediaRef）：形如 `media:<小写十六进制 SHA-256>`
export const Ref = MediaRef
// Ref 的类型别名
export type Ref = MediaRef

/** The `blob` hash a {@link Ref} names. */
// 从引用中取出它命名的 blob 哈希：去掉 "media:" 前缀
export const refHash = (ref: Ref) => ref.slice("media:".length)

/** The {@link Ref} naming a `blob` hash. */
// 由 blob 哈希构造对应的引用字符串
export const ref = (hash: string): Ref => `media:${hash}`

// 剥离 FileAttachment 的 data 字段（内联数据），其余字段保留为 attachment
const { data: _, ...attachment } = FileAttachment.fields

/** A user file whose bytes live in `blob`. */
// 字节存放在 blob 中的用户文件：沿用附件字段，但 uri 指向 media: 引用
export interface FileRef extends Schema.Schema.Type<typeof FileRef> {}
export const FileRef = Schema.Struct({ ...attachment, uri: Ref })

// 用户文件：内联附件或 blob 引用（二选一）
export const File = Schema.Union([FileAttachment, FileRef])
// File 的解码后类型
export type File = typeof File.Type

/** A tool result file whose bytes live in `blob`. */
// 字节存放在 blob 中的工具结果文件：沿用工具文件内容字段，uri 指向 media: 引用
export interface ToolFileRef extends Schema.Schema.Type<typeof ToolFileRef> {}
export const ToolFileRef = Schema.Struct({ ...Tool.FileContent.fields, uri: Ref })

// 可选的 files 数组 schema（供下面的存储载荷复用）
const files = Schema.Array(File).pipe(optional)

/** A `session_inbox` user payload as stored, whose files may be refs. */
// 存储态的收件箱用户载荷：files 中的文件可能是 media: 引用
export interface UserPayload extends Schema.Schema.Type<typeof UserPayload> {}
export const UserPayload = Schema.Struct({ ...InboxUserPayload.fields, files })

/** A `session_message` user message as stored, whose files may be refs. */
// 存储态的 user 消息：files 中的文件可能是 media: 引用
export interface User extends Schema.Schema.Type<typeof User> {}
export const User = Schema.Struct({ ...SessionMessage.User.fields, files })
