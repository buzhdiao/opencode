// 将本模块以命名空间形式整体导出为 SessionPrompt
export * as SessionPrompt from "./prompt.js"

// Base64 编码类型与文件附件（FileAttachment）构造
import { Base64, FileAttachment } from "@opencode/schema/prompt"
// 提示词输入（PromptInput）模式：files/agents/skills 等字段
import { PromptInput } from "@opencode/schema/prompt-input"
// 会话收件箱模式：投递方式与用户载荷
import { SessionInbox } from "@opencode/schema/session-inbox"
// 会话信息类型
import type { Session } from "@opencode/schema/session"
// 会话消息 ID 类型
import type { SessionMessage } from "@opencode/schema/session-message"
// 文件系统服务：stat/读文件/读目录等
import { FSUtil } from "@opencode/util/fs-util"
// effect：Effect 效果、Option 可选值、Schema 编解码
import { Effect, Option, Schema } from "effect"
// Node 的 path 模块：路径与分隔符
import path from "path"
// 把 file: URL 转回文件系统路径
import { fileURLToPath } from "url"
// 数据库服务：读取已存 blob 附件
import { Database } from "../database/database.js"
// 图像服务：图像归一化（缩放）
import { Image } from "../image.js"
// MIME 类型探测
import { Mime } from "../mime.js"
// 插件服务：等待插件激活
import { Plugin } from "../plugin/service.js"
// 插件钩子：触发事件供插件改写输入
import { PluginHooks } from "../plugin/hooks.js"
// 技能（Skill）服务：查询与准备技能
import { Skill } from "../skill.js"
// 会话 blob 存储：按哈希读取媒体
import { SessionBlob } from "./blob.js"
// 附件/技能相关错误类型
import { AttachmentError, SkillNotFoundError } from "./error.js"
// SessionStored.Ref：media: 引用的模式
import { SessionStored } from "./stored.js"

// Image types the resizer can decode; others such as HEIC and AVIF go to the provider unchanged.
// 缩放器（resizer）可解码的图像类型；HEIC、AVIF 等其他类型原样交给模型提供方
const RESIZABLE_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"])

// 用户提示（prompt）的输入结构：文本、附件、提及的代理/技能、元数据与投递方式
export type Input = {
  text: string
  files?: PromptInput.Prompt["files"]
  agents?: PromptInput.Prompt["agents"]
  skills?: PromptInput.Prompt["skills"]
  metadata?: Record<string, unknown>
  delivery?: SessionInbox.Delivery
}

// 准备用户提示：触发插件钩子、物化附件、解析技能，产出可入队的用户消息载荷
export const prepare = Effect.fn("SessionPrompt.prepare")(function* (request: {
  session: Session.Info
  messageID: SessionMessage.ID
  input: Input
}) {
  // 获取文件系统服务
  const fs = yield* FSUtil.Service
  // 等待所有插件完成激活
  yield* Plugin.awaitActivation
  // 获取插件钩子服务
  const hooks = yield* PluginHooks.Service
  // 触发 "session"/"prompt" 钩子：插件可改写文本、附件与投递方式；传入深拷贝避免被钩子污染原始输入
  const event = yield* hooks.trigger("session", "prompt", {
    sessionID: request.session.id,
    messageID: request.messageID,
    prompt: structuredClone({
      text: request.input.text,
      files: request.input.files?.slice(),
      agents: request.input.agents?.slice(),
      skills: request.input.skills?.slice(),
    }),
    metadata: structuredClone(request.input.metadata),
    // 未指定投递方式时默认 steer（转向当前执行）
    delivery: request.input.delivery ?? "steer",
  })
  // 钩子处理后的提示词
  const input = event.prompt
  // 存在附件时并发（8 路）物化每个附件为字节数据
  const files = input.files
    ? yield* Effect.forEach(input.files, materializeAttachment, { concurrency: 8 })
    : undefined
  // 请求引用的技能列表
  const requested = input.skills
  // 解析技能：查技能服务、准备技能文本，结果缓存避免重复准备
  const selected = yield* Effect.gen(function* () {
    // 未引用任何技能则返回 undefined
    if (!requested?.length) return undefined
    // 获取技能服务
    const skillService = yield* Skill.Service
    // 已准备技能的缓存：ID → 名称
    const prepared = new Map<Skill.ID, Skill.Name>()
    return yield* Effect.forEach(requested, (attachment) =>
      Effect.gen(function* () {
        // 缓存命中则直接复用（同一技能可能被多次提及）
        const name = prepared.get(attachment.id)
        if (name !== undefined) return { id: attachment.id, name, mention: attachment.mention }
        // 查询技能详情
        const skill = yield* skillService.get(attachment.id)
        // 技能不存在则报错
        if (!skill) return yield* new SkillNotFoundError({ skill: attachment.id })
        // 写入缓存
        prepared.set(skill.id, skill.name)
        // 读取技能关联的文件
        const files = yield* skillService.files(skill.id)
        // 准备技能（渲染正文），orDie 表示准备失败不可恢复；输出其文本
        return {
          id: skill.id,
          name: skill.name,
          text: (yield* Skill.prepare(fs, skill, files).pipe(Effect.orDie)).output,
          mention: attachment.mention,
        }
      }),
    )
  })
  // 组装收件箱条目：用户消息载荷 + 投递方式
  return {
    type: "user",
    payload: SessionInbox.UserPayload.make({
      text: input.text,
      agents: input.agents,
      files,
      skills: selected?.length ? selected : undefined,
      metadata: event.metadata,
    }),
    delivery: event.delivery,
  } satisfies SessionInbox.Item
})

// 物化单个附件：把 URI（blob 引用 / data URL / file URI）解析为文件附件对象
const materializeAttachment = Effect.fn("SessionPrompt.materializeAttachment")(function* (
  input: PromptInput.FileAttachment,
) {
  // Stored blob bytes were normalized when first admitted, so a `media:` ref re-admits them unchanged.
  // 存储 blob 的字节在首次接纳时已归一化，因此 media: 引用再次接纳时保持不变
  const ref = Schema.decodeUnknownOption(SessionStored.Ref)(input.uri)
  // media: 引用路径：从 blob 存储读取并直接构造附件
  if (Option.isSome(ref)) {
    // 按引用哈希读取 blob
    const blob = yield* readBlobAttachment(ref.value)
    // 构造文件附件：字节转 base64
    return FileAttachment.create({
      data: Base64.make(Buffer.from(blob.data).toString("base64")),
      mime: blob.mime,
      source: input.source ?? { type: "inline" },
      name: input.name,
      description: input.description,
      mention: input.mention,
    })
  }
  // 附件标签：用于错误信息与日志
  const label = attachmentLabel(input)
  // data: URL 走内联解码；其他 URI 走文件读取
  const resolved = input.uri.startsWith("data:")
    ? {
        bytes: yield* decodeDataURL(input.uri, label),
        source: input.source ?? { type: "inline" as const },
        start: undefined,
        end: undefined,
        name: undefined,
        mime: undefined,
      }
    : yield* readFileAttachment(input.uri)
  // 超过附件大小上限则报错
  if (resolved.bytes.byteLength > MAX_ATTACHMENT_BYTES)
    return yield* new AttachmentError({
      uri: label,
      message: `Attachment exceeds the ${MAX_ATTACHMENT_BYTES} byte limit: ${label}`,
    })

  // 未显式给出 mime 时按字节探测
  const mime = resolved.mime ?? Mime.detect(resolved.bytes)
  // 纯文本且指定了行范围时，截取 start..end 行；否则使用完整字节
  const content =
    mime === "text/plain" && resolved.start !== undefined
      ? Buffer.from(
          Buffer.from(resolved.bytes)
            .toString("utf8")
            .split("\n")
            .slice(resolved.start - 1, resolved.end)
            .join("\n"),
        )
      : resolved.bytes
  // 图像附件做归一化（缩放）
  const normalized = yield* normalizeImageAttachment(input, Buffer.from(content).toString("base64"), mime)
  // 构造最终的文件附件
  return FileAttachment.create({
    data: normalized.data,
    mime: normalized.mime,
    source: resolved.source,
    name: input.name ?? resolved.name,
    description: input.description,
    mention: input.mention,
  })
})

// 归一化图像附件：可解码类型交给图像服务缩放；缩放器不可用时原样返回
const normalizeImageAttachment = Effect.fn("SessionPrompt.normalizeImageAttachment")(function* (
  input: PromptInput.FileAttachment,
  data: string,
  mime: string,
) {
  // 不可缩放的 mime 直接返回原数据
  if (!RESIZABLE_IMAGE_MIMES.has(mime)) return { data: Base64.make(data), mime }
  // 获取图像服务
  const image = yield* Image.Service
  // 附件标签（用于错误与内容标识）
  const label = attachmentLabel(input)
  // 归一化输入内容
  const content = { uri: label, content: data, encoding: "base64" as const, mime }
  // 执行归一化；缩放器不可用时回退为原内容，其他错误包装为附件错误
  const normalized = yield* image.normalize(label, content).pipe(
    Effect.catchTag("Image.ResizerUnavailableError", () => Effect.succeed(content)),
    Effect.mapError((error) => new AttachmentError({ uri: label, message: error.message })),
  )
  // 返回归一化后的数据与 mime
  return { data: Base64.make(normalized.content), mime: normalized.mime }
})

/** A `media:` ref a client received from an experimental `experimental-media-uri` read, sent back as an attachment. */
// 客户端把实验性 experimental-media-uri 读取返回的 media: 引用当附件传回时，从 blob 存储读取
const readBlobAttachment = Effect.fn("SessionPrompt.readBlobAttachment")(function* (uri: SessionStored.Ref) {
  // 获取数据库句柄
  const { db } = yield* Database.Service
  // 按引用哈希读取 blob
  const blob = yield* SessionBlob.read(db, SessionStored.refHash(uri))
  // blob 已不存在则报附件错误
  if (!blob) return yield* new AttachmentError({ uri, message: `Attachment is no longer stored: ${uri}` })
  return blob
})

// 读取 file: URI 指向的文件或目录作为附件
const readFileAttachment = Effect.fn("SessionPrompt.readFileAttachment")(function* (uri: string) {
  // 获取文件系统服务
  const fs = yield* FSUtil.Service
  // 解析 URI；非法 URI 报附件错误
  const url = yield* Effect.try({
    try: () => new URL(uri),
    catch: () => new AttachmentError({ uri, message: `Invalid attachment URI: ${uri}` }),
  })
  // 仅支持 file: 协议
  if (url.protocol !== "file:")
    return yield* new AttachmentError({ uri, message: `Unsupported attachment URI: ${uri}` })
  // 解析可选的 start/end 行范围参数（正整数）
  const start = positiveInt(url.searchParams.get("start"))
  const end = positiveInt(url.searchParams.get("end"))
  // 去掉查询与 hash 后把 URL 转回文件路径
  const target = yield* Effect.try({
    try: () => {
      url.search = ""
      url.hash = ""
      return fileURLToPath(url)
    },
    catch: () => new AttachmentError({ uri, message: `Invalid file URI: ${uri}` }),
  })
  // 查询目标状态；失败报无法读取
  const info = yield* fs
    .stat(target)
    .pipe(Effect.mapError(() => new AttachmentError({ uri, message: `Unable to read attachment: ${uri}` })))
  // 目录：读取目录条目列表作为文本附件
  if (info.type === "Directory") {
    const entries = yield* fs
      .readDirectoryEntries(target)
      .pipe(Effect.mapError(() => new AttachmentError({ uri, message: `Unable to read attachment: ${uri}` })))
    // 目录列表：过滤文件/目录、同类型按名排序且目录优先、目录名补分隔符，逐行拼接
    return {
      bytes: Buffer.from(
        entries
          .filter((entry) => entry.type === "File" || entry.type === "Directory")
          .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "Directory" ? -1 : 1))
          .map((entry) => entry.name + (entry.type === "Directory" ? path.sep : ""))
          .join("\n"),
      ),
      source: { type: "uri" as const, uri },
      start: undefined,
      end: undefined,
      name: path.basename(target),
      mime: "application/x-directory",
    }
  }
  // 既非目录也非普通文件则报错
  if (info.type !== "File") return yield* new AttachmentError({ uri, message: `Attachment is not a file: ${uri}` })
  // 文件大小超限则报错
  if (Number(info.size) > MAX_ATTACHMENT_BYTES)
    return yield* new AttachmentError({
      uri,
      message: `Attachment exceeds the ${MAX_ATTACHMENT_BYTES} byte limit: ${uri}`,
    })
  // 读取文件字节；失败报无法读取
  const bytes = yield* fs
    .readFile(target)
    .pipe(Effect.mapError(() => new AttachmentError({ uri, message: `Unable to read attachment: ${uri}` })))
  // 返回文件内容与解析出的行范围
  return { bytes, source: { type: "uri" as const, uri }, start, end, name: path.basename(target), mime: undefined }
})

// 附件大小上限：20 MB
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

// A data URL is the whole file; errors and logs must name the attachment, not echo its bytes.
// data URL 就是整个文件，因此错误与日志只能写附件名，绝不能回显其字节
function attachmentLabel(input: PromptInput.FileAttachment) {
  // 有名字用名字；内联 data URL 用固定文案；否则用 URI
  return input.name ?? (input.uri.startsWith("data:") ? "inline attachment" : input.uri)
}

// 解码 data: URL 为字节：支持 base64 与百分比编码两种载荷
function decodeDataURL(uri: string, label: string) {
  return Effect.try({
    try: () => {
      // 找到元数据与载荷的分隔逗号
      const comma = uri.indexOf(",")
      // 缺少逗号说明不是合法 data URL
      if (comma === -1) throw new Error("Invalid data URL")
      // "data:" 之后到逗号之间是元数据段
      const metadata = uri.slice(5, comma)
      // 逗号之后是载荷
      const payload = uri.slice(comma + 1)
      // 元数据不含 base64 时按百分比编码（URI 编码）解码
      if (!metadata.split(";").some((part) => part.toLowerCase() === "base64"))
        return Buffer.from(decodeURIComponent(payload))
      // 按 base64 解码字节
      const bytes = Buffer.from(payload, "base64")
      // 回编不一致说明不是规范（canonical）base64，拒绝处理
      if (bytes.toString("base64") !== payload) throw new Error("Non-canonical base64")
      return bytes
    },
    // 解析失败统一包装为附件错误（用标签而非原始字节）
    catch: () => new AttachmentError({ uri: label, message: `Invalid attachment data URL: ${label}` }),
  })
}

// 把字符串解析为正整数；空值或非法值返回 undefined
function positiveInt(value: string | null) {
  // 参数缺失
  if (value === null) return
  // 转数字
  const parsed = Number(value)
  // 必须是正整数才有效
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}
