// 将本模块以命名空间 Artifact 的形式整体导出，外部通过 `Artifact.xxx` 访问
export * as Artifact from "./artifact.js"

// 导入加密随机 UUID 生成器（用于原子替换目录时的临时名）
import { randomUUID } from "node:crypto"
// 导入基于 Promise 的文件系统 API
import fs from "node:fs/promises"
// 导入路径处理工具
import path from "node:path"
// 导入按文件名扩展推断 MIME 类型的工具
import { lookup } from "mime-types"
// 导入工件（artifact）的 schema 定义：能力、内容、输入/输出、事件、ID、信息、提供者等
import {
  Capability,
  Content,
  CreateInput,
  Event,
  ID,
  Info,
  Provider,
  ProviderID,
  UpdateInput,
} from "@opencode/schema/artifact"
// 导入会话（session）ID 类型
import type { SessionID } from "@opencode/schema/session-id"
// 导入全局服务（数据目录等）
import { Global } from "@opencode/util/global"
// 导入“位置节点”工厂：把服务与实现层打包成可被应用装配树引用的节点
import { makeLocationNode } from "@opencode/util/effect/app-node"
// 导入 Effect 原语：Clock（时钟）、Context、Effect、Layer、Option（可选值）、Schema（校验/编解码）
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { Bus } from "./bus.js"
import { Flag } from "./flag.js"
import { KV } from "./kv.js"
import { Location } from "./location.js"
import { Mime } from "./mime.js"
import { Session } from "./session.js"
import { State } from "./state.js"

// 重新导出 schema 中的类型与校验器，方便调用方统一从本模块引入
export { Capability, Content, CreateInput, Event, ID, Info, Provider, ProviderID, UpdateInput }

// 本地提供者（provider）的固定 ID：表示由 OpenCode 服务器自身托管
export const LocalProviderID = ProviderID.make("local")
// KV 存储中工件记录的键前缀
const ItemPrefix = "artifact:item:"

// 提供者创建输入：ID、标题、入口文件、文件字节表、可选的所属会话 ID
export interface ProviderCreateInput {
  readonly id: ID
  readonly title: string
  readonly entry: string
  readonly files: Readonly<Record<string, Uint8Array>>
  readonly sessionID?: SessionID
}

// 提供者更新输入：与创建类似但没有 id（更新目标已确定）
export interface ProviderUpdateInput {
  readonly title: string
  readonly entry: string
  readonly files: Readonly<Record<string, Uint8Array>>
  readonly sessionID?: SessionID
}

// 提供者操作结果：可选的访问 URL（缺省时使用本地视图地址）
export interface ProviderResult {
  readonly url?: string
}

// 提供者实现接口（ProviderImplementation）：描述一个工件托管后端的能力与操作
export interface ProviderImplementation {
  // 提供者 ID
  readonly id: ProviderID
  // 展示名称
  readonly name: string
  // 支持的能力（capability）列表，如 "static"
  readonly capabilities: readonly Capability[]
  // 注入提示词（prompt）：告诉模型该提供者如何发布工件
  readonly prompt: string
  // 创建工件：写入文件并返回结果
  readonly create: (input: ProviderCreateInput) => Effect.Effect<ProviderResult, unknown>
  // 读取工件的全部文件字节
  readonly read: (id: ID) => Effect.Effect<Readonly<Record<string, Uint8Array>>, unknown>
  // 更新工件内容
  readonly update: (id: ID, input: ProviderUpdateInput) => Effect.Effect<ProviderResult, unknown>
  // 删除工件
  readonly delete: (id: ID) => Effect.Effect<void, unknown>
}

// 本地文件：字节内容 + MIME 类型
export interface LocalFile {
  readonly bytes: Uint8Array
  readonly mime: string
}

// 提供给模型的提供者提示信息：默认提供者（含提示词）与其余提供者列表
export interface ProviderPrompts {
  readonly defaultProvider: {
    readonly id: ProviderID
    readonly name: string
    readonly capabilities: readonly Capability[]
    readonly prompt: string
  }
  readonly others: readonly {
    readonly id: ProviderID
    readonly name: string
    readonly capabilities: readonly Capability[]
  }[]
}

// 功能未启用错误：需在配置中开启 experimental.artifacts
export class DisabledError extends Schema.TaggedError<DisabledError>()("Artifact.DisabledError", {}) {
  override get message() {
    return "Artifacts are disabled; set experimental.artifacts in config"
  }
}

// 工件不存在错误：携带工件 ID
export class NotFoundError extends Schema.TaggedError<NotFoundError>()("Artifact.NotFoundError", {
  artifactID: ID,
}) {
  override get message() {
    return `Artifact not found: ${this.artifactID}`
  }
}

// 工件文件缺失错误：目标路径在提供者处找不到
export class FileMissingError extends Schema.TaggedError<FileMissingError>()("Artifact.FileMissingError", {
  artifactID: ID,
  path: Schema.String,
}) {
  override get message() {
    return `Artifact file not found: ${this.path}`
  }
}

// 提供者未找到错误：请求的提供者 ID 未注册
export class ProviderNotFoundError extends Schema.TaggedError<ProviderNotFoundError>()(
  "Artifact.ProviderNotFoundError",
  {
    providerID: ProviderID,
  },
) {
  override get message() {
    return `Artifact provider not found: ${this.providerID}`
  }
}

// 输入不合法错误：带原因与可选的字段名
export class InvalidError extends Schema.TaggedError<InvalidError>()("Artifact.InvalidError", {
  reason: Schema.String,
  field: Schema.optional(Schema.String),
}) {
  override get message() {
    return this.reason
  }
}

// 提供者执行失败错误：包装底层异常
export class ProviderError extends Schema.TaggedError<ProviderError>()("Artifact.ProviderError", {
  providerID: ProviderID,
  cause: Schema.Defect(),
}) {
  override get message() {
    return this.cause instanceof Error && this.cause.message
      ? `Artifact provider ${this.providerID} failed: ${this.cause.message}`
      : `Artifact provider ${this.providerID} failed`
  }
}

// 本服务的统一错误联合类型（含会话不存在错误）
export type Error =
  | DisabledError
  | NotFoundError
  | FileMissingError
  | ProviderNotFoundError
  | InvalidError
  | ProviderError
  | Session.NotFoundError

// 编辑器（Editor）：配置重载时对提供者注册表与默认选择的同步修改接口
export type Editor = {
  // 注册一个提供者实现
  add: (provider: ProviderImplementation) => void
  // 注销指定提供者
  remove: (id: ProviderID) => void
  // 默认（当前选中）提供者的读取/设置
  default: {
    get: () => ProviderID | undefined
    set: (providerID: ProviderID | undefined) => void
  }
}

// 内部状态数据：提供者映射表 + 当前选中的提供者 ID（可选）
type Data = {
  readonly providers: Map<ProviderID, ProviderImplementation>
  selection?: ProviderID
}

// 服务接口：Effect 风格的异步 API，附带状态模块的 transform / reload 能力
export interface Interface extends State.Transformable<Editor> {
  // 查询工件功能是否启用
  readonly enabled: () => Effect.Effect<boolean>
  // 列出全部提供者（需启用功能）
  readonly providers: () => Effect.Effect<readonly Provider[], DisabledError>
  // 获取给模型用的提供者提示信息
  readonly prompts: () => Effect.Effect<ProviderPrompts>
  // 按会话/提供者过滤列出工件元信息
  readonly list: (filter?: {
    readonly sessionID?: SessionID
    readonly provider?: ProviderID
  }) => Effect.Effect<readonly Info[], DisabledError | Session.NotFoundError>
  // 创建工件
  readonly create: (input: CreateInput) => Effect.Effect<Info, Error>
  // 读取工件内容（元信息 + 文件文本）
  readonly get: (id: ID) => Effect.Effect<Content, DisabledError | NotFoundError | ProviderNotFoundError | ProviderError>
  // 读取工件元信息
  readonly info: (id: ID) => Effect.Effect<Info, DisabledError | NotFoundError>
  // 更新工件
  readonly update: (id: ID, input: UpdateInput) => Effect.Effect<Info, Error>
  // 删除工件
  readonly remove: (id: ID) => Effect.Effect<void, DisabledError | NotFoundError | ProviderError>
  // 读取本地托管工件的某个文件（字节 + MIME）
  readonly readLocalFile: (
    id: ID,
    subpath?: string,
  ) => Effect.Effect<LocalFile, DisabledError | NotFoundError | FileMissingError | InvalidError>
}

// 定义服务标识（Effect 依赖注入的 Tag）
export class Service extends Context.Service<Service, Interface>()("@opencode/Artifact") {}

// KV 中存储的记录结构：工件元信息 + 所在目录 + 所属项目 ID
const StoredRecord = Schema.Struct({
  info: Info,
  directory: Schema.String,
  projectID: Schema.String,
})
// 导出 StoredRecord 的静态类型
type StoredRecord = typeof StoredRecord.Type

// 宽松解码器：KV 值 → StoredRecord（失败时返回 None）
const decodeStoredRecord = Schema.decodeUnknownOption(StoredRecord)
// 同步编码器：StoredRecord → KV 值
const encodeStoredRecord = Schema.encodeSync(StoredRecord)
// 文本编码器：字符串内容 → UTF-8 字节
const encoder = new TextEncoder()

/** Resolves the stored directory of an artifact for HTTP routes without an explicit location query. */
// （为没有显式 location 查询参数的 HTTP 路由解析工件的存储目录）
export const locate = (kv: KV.Interface, id: ID) =>
  kv.get(ItemPrefix + id).pipe(
    Effect.map((stored) => {
      // 记录不存在时返回 undefined
      if (stored === undefined) return undefined
      const decoded = decodeStoredRecord(stored)
      // 解码成功则返回其目录，否则 undefined
      return Option.isSome(decoded) ? decoded.value.directory : undefined
    }),
  )

// 服务实现层（Layer）：构建工件状态与全部业务操作
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 依赖注入：事件总线、配置、全局服务、KV、位置、会话、特性开关
    const bus = yield* Bus.Service
    const flags = yield* Flag.Service
    const global = yield* Global.Service
    const kv = yield* KV.Service
    const location = yield* Location.Service
    const sessions = yield* Session.Service

    // 工件存储根目录：<数据目录>/artifacts
    const rootDir = path.join(global.data, "artifacts")
    // 某个工件的专属目录
    const itemDir = (id: ID) => path.join(rootDir, id)
    // 加载属于当前项目的工件记录，不存在则报 NotFoundError
    const requireRecord = (id: ID) =>
      loadProjectRecord(kv, id, location.project.id).pipe(
        Effect.flatMap((existing) =>
          existing ? Effect.succeed(existing) : Effect.fail(new NotFoundError({ artifactID: id })),
        ),
      )

    // 本地提供者实现：把文件写入服务器本地目录并按目录对外服务
    const localProvider: ProviderImplementation = {
      id: LocalProviderID,
      name: "Local",
      capabilities: ["static"],
      // 提示词：告知模型工件由本服务器以 HTML 提供服务
      prompt:
        "Artifacts are served as HTML by this OpenCode server. Only people who can reach this server can open them.",
      // 创建：替换目录文件并返回本地视图 URL
      create: (input) =>
        replaceDirectoryFiles(itemDir(input.id), input.files).pipe(Effect.as({ url: viewURL(input.id) })),
      // 读取：递归读取目录下的全部文件
      read: (id) => readDirectoryFiles(itemDir(id)),
      // 更新：同样以整目录替换实现
      update: (id, input) => replaceDirectoryFiles(itemDir(id), input.files).pipe(Effect.as({ url: viewURL(id) })),
      // 删除：递归强制删除工件目录
      delete: (id) => Effect.promise(() => fs.rm(itemDir(id), { recursive: true, force: true })),
    }

    // 提供者快照：转为普通对象数组并按 ID 排序（用于变更比较与事件载荷）
    const snapshotProviders = (data: Data) =>
      Array.from(data.providers.values(), (provider) => ({
        id: provider.id,
        name: provider.name,
        capabilities: provider.capabilities,
        selection: data.selection,
      })).toSorted((a, b) => a.id.localeCompare(b.id))

    // 创建状态：初始注册本地提供者；编辑器支持增删与默认选择；变更时经总线发布 Updated 事件
    const state = State.create<Data, Editor>({
      initial: () => ({
        providers: new Map([[LocalProviderID, localProvider]]),
      }),
      // 编辑器实现：直接操作草稿
      editor: (draft) => ({
        // 注册提供者（按 ID 覆盖）
        add: (provider) => {
          draft.providers.set(provider.id, provider)
        },
        // 注销提供者：本地提供者不允许删除；若是当前默认则一并清除
        remove: (id) => {
          if (id === LocalProviderID) return
          draft.providers.delete(id)
          if (draft.selection === id) draft.selection = undefined
        },
        // 默认提供者的读写
        default: {
          get: () => draft.selection,
          set: (providerID) => {
            draft.selection = providerID
          },
        },
      }),
      // 变更通知：快照发生变化时经总线发布 Event.Updated
      notify: State.changes(snapshotProviders, () => bus.publish(Event.Updated, {}).pipe(Effect.asVoid)),
    })

    const isEnabled = Effect.fn("Artifact.enabled")(() => flags.enabled("artifacts"))

    // 守卫：未启用时直接失败（DisabledError）
    const requireEnabled = () =>
      isEnabled().pipe(Effect.flatMap((on) => (on ? Effect.void : Effect.fail(new DisabledError()))))

    // 当前生效的默认提供者：选中项存在且已注册则用之，否则回退本地提供者
    const activeDefaultID = () => {
      const data = state.get()
      return data.selection && data.providers.has(data.selection) ? data.selection : LocalProviderID
    }

    // 解析目标提供者：未指定则用默认；注册表中找不到则报 ProviderNotFoundError
    const resolveProvider = (requested?: ProviderID) => {
      const data = state.get()
      const target = requested ?? activeDefaultID()
      const found = data.providers.get(target)
      return found ? Effect.succeed(found) : Effect.fail(new ProviderNotFoundError({ providerID: target }))
    }

    // 会话校验：给了 sessionID 就确保该会话存在（不存在会失败）
    const checkSession = (sessionID?: SessionID) =>
      sessionID === undefined ? Effect.void : sessions.get(sessionID).pipe(Effect.asVoid)

    // 组装并返回服务实例
    return Service.of({
      // 转发状态模块的 transform / reload
      transform: state.transform,
      reload: state.reload,
      // enabled：透出启用查询
      enabled: isEnabled,
      // providers：列出全部提供者，默认项排最前，其余按名称排序
      providers: Effect.fn("Artifact.providers")(function* () {
        yield* requireEnabled()
        const defaultID = activeDefaultID()
        return Array.from(state.get().providers.values(), (provider) =>
          Provider.make({
            id: provider.id,
            name: provider.name,
            capabilities: [...provider.capabilities],
            default: provider.id === defaultID,
          }),
        ).toSorted((a, b) => Number(b.default) - Number(a.default) || a.name.localeCompare(b.name))
      }),
      // prompts：给模型的提示信息——默认提供者（含 prompt）与其余提供者
      prompts: Effect.fn("Artifact.prompts")(function* () {
        const defaultID = activeDefaultID()
        // 默认提供者缺失时回退本地提供者
        const defaultProvider = state.get().providers.get(defaultID) ?? localProvider
        // 其余提供者按名称排序并精简字段
        const others = Array.from(state.get().providers.values())
          .filter((item) => item.id !== defaultProvider.id)
          .toSorted((a, b) => a.name.localeCompare(b.name))
          .map((item) => ({ id: item.id, name: item.name, capabilities: item.capabilities }))
        return {
          defaultProvider: {
            id: defaultProvider.id,
            name: defaultProvider.name,
            capabilities: defaultProvider.capabilities,
            prompt: defaultProvider.prompt,
          },
          others,
        }
      }),
      // list：按会话/提供者过滤工件，按更新时间倒序（同时间按 ID 倒序）
      list: Effect.fn("Artifact.list")(function* (filter) {
        yield* requireEnabled()
        if (filter?.sessionID !== undefined) yield* checkSession(filter.sessionID)
        const items = yield* scanProjectInfos(kv, location.project.id)
        return items
          .filter(
            (item) =>
              (filter?.sessionID === undefined || item.sessionID === filter.sessionID) &&
              (filter?.provider === undefined || item.provider === filter.provider),
          )
          .toSorted((a, b) => b.time.updated - a.time.updated || b.id.localeCompare(a.id))
      }),
      // create：校验 → 规范化文件 → 解析入口与提供者 → 调用提供者创建 → 写入 KV 记录
      create: Effect.fn("Artifact.create")(function* (input) {
        yield* requireEnabled()
        yield* checkSession(input.sessionID)
        // 标题去除首尾空白，不能为空
        const title = input.title.trim()
        if (!title) return yield* new InvalidError({ reason: "Artifact title must not be empty", field: "title" })
        // 字符串文件统一转字节并规范化路径
        const files = yield* normalizeFiles(encodeStringFiles(input.files))
        // 解析入口文件
        const entry = yield* resolveEntry(files, input.entry)
        // 解析目标提供者
        const provider = yield* resolveProvider(input.provider)
        // 生成新 ID 与当前时间戳
        const id = ID.create()
        const now = yield* Clock.currentTimeMillis
        // 调用提供者创建（错误统一包装为 ProviderError）
        const created = yield* provider
          .create({ id, title, entry, files, sessionID: input.sessionID })
          .pipe(Effect.mapError((cause) => new ProviderError({ providerID: provider.id, cause })))
        // 组装元信息：URL 优先用提供者返回的，否则用本地视图地址
        const info = Info.make({
          id,
          provider: provider.id,
          ...(input.sessionID === undefined ? {} : { sessionID: input.sessionID }),
          title,
          entry,
          url: created.url ?? viewURL(id),
          time: { created: now, updated: now },
        })
        // 把记录（元信息 + 目录 + 项目 ID）持久化到 KV
        yield* kv.set(
          ItemPrefix + id,
          encodeStoredRecord({
            info,
            directory: location.directory,
            projectID: location.project.id,
          }),
        )
        return info
      }),
      // info：读取工件元信息（需启用且存在）
      info: Effect.fn("Artifact.info")(function* (id) {
        yield* requireEnabled()
        const existing = yield* requireRecord(id)
        return existing.info
      }),
      // get：读取工件内容——元信息 + 提供者处读到的文件（转文本）
      get: Effect.fn("Artifact.get")(function* (id) {
        yield* requireEnabled()
        const existing = yield* requireRecord(id)
        const provider = yield* resolveProvider(existing.info.provider)
        const raw = yield* provider
          .read(id)
          .pipe(Effect.mapError((cause) => new ProviderError({ providerID: provider.id, cause })))
        return Content.make({
          info: existing.info,
          files: decodeReadFiles(raw),
        })
      }),
      // update：校验 → 合并标题/文件/入口 → 调用提供者更新 → 覆写 KV 记录
      update: Effect.fn("Artifact.update")(function* (id, input) {
        yield* requireEnabled()
        yield* checkSession(input.sessionID)
        const existing = yield* requireRecord(id)
        // 标题未提供时沿用原值
        const title = input.title === undefined ? existing.info.title : input.title.trim()
        if (!title) return yield* new InvalidError({ reason: "Artifact title must not be empty", field: "title" })
        // 文件规范化
        const files = yield* normalizeFiles(encodeStringFiles(input.files))
        // 入口未提供时沿用原入口（前提是新文件里仍存在该文件）
        const entry = yield* resolveEntry(
          files,
          input.entry ?? (files[existing.info.entry] ? existing.info.entry : undefined),
        )
        // 提供者由原记录决定
        const provider = yield* resolveProvider(existing.info.provider)
        const now = yield* Clock.currentTimeMillis
        // 会话未提供时沿用原值
        const sessionID = input.sessionID ?? existing.info.sessionID
        // 调用提供者更新（错误统一包装）
        const updated = yield* provider
          .update(id, { title, entry, files, sessionID })
          .pipe(Effect.mapError((cause) => new ProviderError({ providerID: provider.id, cause })))
        // 重建元信息：保留创建时间，更新修改时间；URL 优先用提供者返回值
        const info = Info.make({
          id,
          provider: existing.info.provider,
          ...(sessionID === undefined ? {} : { sessionID }),
          title,
          entry,
          url: updated.url ?? existing.info.url,
          time: { created: existing.info.time.created, updated: now },
        })
        // 覆写 KV 记录（保留原目录与项目 ID）
        yield* kv.set(
          ItemPrefix + id,
          encodeStoredRecord({
            info,
            directory: existing.directory,
            projectID: existing.projectID,
          }),
        )
        return info
      }),
      // remove：删除工件——调用提供者删除（存在时）并移除 KV 记录
      remove: Effect.fn("Artifact.remove")(function* (id) {
        yield* requireEnabled()
        const existing = yield* requireRecord(id)
        const provider = state.get().providers.get(existing.info.provider)
        if (provider) {
          yield* provider
            .delete(id)
            .pipe(Effect.mapError((cause) => new ProviderError({ providerID: provider.id, cause })))
        }
        yield* kv.remove(ItemPrefix + id)
      }),
      // readLocalFile：为 HTTP 视图路由读取本地托管工件的文件（字节 + MIME）
      readLocalFile: Effect.fn("Artifact.readLocalFile")(function* (id, subpath) {
        yield* requireEnabled()
        const existing = yield* requireRecord(id)
        // 仅本地提供者托管的工件才能从本地文件系统读取
        if (existing.info.provider !== LocalProviderID) {
          return yield* new InvalidError({
            reason: `Artifact ${id} is hosted by provider "${existing.info.provider}", not the local server`,
            field: "artifactID",
          })
        }
        // 目标路径：给了子路径则规范化，否则用入口文件
        const requested = subpath?.trim() ? yield* normalizePath(subpath) : existing.info.entry
        // 拼出绝对路径（子路径已被规范化，安全）
        const target = path.join(itemDir(id), ...requested.split("/"))
        // 检查目标存在且是文件（stat 失败视为不存在）
        const exists = yield* Effect.promise(() =>
          fs
            .stat(target)
            .then((stat) => stat.isFile())
            .catch(() => false),
        )
        if (!exists) return yield* new FileMissingError({ artifactID: id, path: requested })
        // 读取字节并嗅探 MIME
        const bytes = yield* Effect.promise(() => fs.readFile(target).then((buf) => new Uint8Array(buf)))
        return { bytes, mime: detectFileMime(requested, bytes) }
      }),
    })
  }),
)

// 打包成节点：依赖 App / Bus / Config / Global / KV / Location / Session 各节点
export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Bus.node, Flag.node, Global.node, KV.node, Location.node, Session.node],
})

// 把字符串文件表统一编码为 UTF-8 字节表
function encodeStringFiles(files: Readonly<Record<string, string>>) {
  return Object.fromEntries(Object.entries(files).map(([filePath, content]) => [filePath, encoder.encode(content)]))
}

// 把字节文件表统一解码为文本（读取展示用）
function decodeReadFiles(files: Readonly<Record<string, Uint8Array>>) {
  const decoder = new TextDecoder()
  return Object.fromEntries(Object.entries(files).map(([filePath, bytes]) => [filePath, decoder.decode(bytes)]))
}

// 检测文件 MIME：先按扩展名查表（文本类补 charset=utf-8），查不到再按字节嗅探
function detectFileMime(filePath: string, bytes: Uint8Array) {
  const byName = lookup(filePath)
  if (typeof byName === "string") {
    return byName.startsWith("text/") || byName === "application/javascript" || byName === "application/json"
      ? `${byName}; charset=utf-8`
      : byName
  }
  return Mime.detect(bytes)
}

// 路径规范化：统一斜杠、去掉前导 ./ 与 /，拒绝空路径与 NUL 字节
function normalizePath(raw: string): Effect.Effect<string, InvalidError> {
  const trimmed = raw
    .replaceAll("\\", "/")
    .replace(/^(?:\.\/)+/u, "")
    .replace(/^\/+/u, "")
  // 空路径或包含 NUL 字节视为非法
  if (!trimmed || trimmed.includes("\0")) {
    return Effect.fail(
      new InvalidError({ reason: `Invalid artifact file path: ${JSON.stringify(raw)}`, field: "files" }),
    )
  }
  // 逐段检查：不允许空段（连续斜杠）、当前目录（.）与上级目录（..），确保路径不逃逸
  const segments = trimmed.split("/")
  if (segments.some((part) => !part || part === "." || part === "..")) {
    return Effect.fail(
      new InvalidError({ reason: `Artifact file path must stay relative: ${JSON.stringify(raw)}`, field: "files" }),
    )
  }
  return Effect.succeed(segments.join("/"))
}

// 文件表规范化：至少要有一个文件；每个路径都通过 normalizePath 校验（去重后输出）
function normalizeFiles(files: Readonly<Record<string, Uint8Array>>) {
  return Effect.gen(function* () {
    const entries = Object.entries(files)
    if (entries.length === 0) {
      return yield* new InvalidError({ reason: "Artifact must include at least one file", field: "files" })
    }
    const normalized = new Map<string, Uint8Array>()
    for (const [rawPath, content] of entries) {
      const clean = yield* normalizePath(rawPath)
      normalized.set(clean, content)
    }
    return Object.fromEntries(normalized)
  })
}

// 解析入口（entry）文件：显式指定则须存在于文件表；否则优先 index.html / index.md；单文件时唯一键即入口
function resolveEntry(files: Readonly<Record<string, Uint8Array>>, requested?: string) {
  if (requested !== undefined) {
    return normalizePath(requested).pipe(
      Effect.flatMap((clean) =>
        files[clean] !== undefined
          ? Effect.succeed(clean)
          : Effect.fail(new InvalidError({ reason: `Entry file not found in files: ${clean}`, field: "entry" })),
      ),
    )
  }
  if (files["index.html"] !== undefined) return Effect.succeed("index.html")
  if (files["index.md"] !== undefined) return Effect.succeed("index.md")
  const keys = Object.keys(files)
  if (keys.length === 1 && keys[0] !== undefined) return Effect.succeed(keys[0])
  return Effect.fail(
    new InvalidError({
      reason: 'Include "index.html" or "index.md", or specify "entry" when publishing multiple files',
      field: "entry",
    }),
  )
}

// 本地工件的查看 URL：/api/experimental/artifacts/<id>/view/
function viewURL(id: ID) {
  return `/api/experimental/artifacts/${encodeURIComponent(id)}/view/`
}

// 加载属于指定项目的工件记录：KV 值缺失或解码失败或项目不匹配都返回 undefined
function loadProjectRecord(kv: KV.Interface, id: ID, projectID: string) {
  return kv.get(ItemPrefix + id).pipe(
    Effect.map((stored) => {
      if (stored === undefined) return undefined
      const decoded = Option.getOrUndefined(decodeStoredRecord(stored))
      return decoded?.projectID === projectID ? decoded : undefined
    }),
  )
}

// 扫描当前项目的全部工件元信息：按前缀分页遍历 KV，边翻页边解码过滤
function scanProjectInfos(kv: KV.Interface, projectID: string) {
  return Effect.gen(function* () {
    const results: Info[] = []
    // 分页游标：上一页返回的 after 键
    let after: string | undefined
    while (true) {
      // 每页最多 500 条
      const page = yield* kv.scan({ prefix: ItemPrefix, after, limit: 500 })
      results.push(
        ...page.entries.flatMap((entry) => {
          const decoded = decodeStoredRecord(entry.value)
          return Option.isSome(decoded) && decoded.value.projectID === projectID ? [decoded.value.info] : []
        }),
      )
      // 没有下一页时结束
      if (!page.next) return results
      after = page.next
    }
  })
}

// 原子替换目录内容：先写入 staging 目录，再以 rename 换入，失败时回滚备份并清理临时目录
function replaceDirectoryFiles(baseDir: string, files: Readonly<Record<string, Uint8Array>>) {
  return Effect.tryPromise(async () => {
    // 确保父目录存在
    const parent = path.dirname(baseDir)
    await fs.mkdir(parent, { recursive: true })
    // 用随机 UUID 命名临时目录，避免并发冲突
    const nonce = randomUUID()
    const staging = `${baseDir}.staging-${nonce}`
    const backup = `${baseDir}.backup-${nonce}`
    try {
      // 建 staging 目录并写入全部文件（含子目录）
      await fs.mkdir(staging, { recursive: true })
      await Promise.all(
        Object.entries(files).map(async ([rel, bytes]) => {
          const dest = path.join(staging, ...rel.split("/"))
          await fs.mkdir(path.dirname(dest), { recursive: true })
          await fs.writeFile(dest, bytes)
        }),
      )
      // 记录是否已有旧内容
      const hadExisting = await fs
        .stat(baseDir)
        .then(() => true)
        .catch(() => false)
      // 有旧内容时先把原目录挪到备份位置
      if (hadExisting) await fs.rename(baseDir, backup)
      try {
        // staging 原子换入正式位置
        await fs.rename(staging, baseDir)
      } catch (err) {
        // 换入失败：把备份挪回原位，尽量还原
        if (hadExisting) await fs.rename(backup, baseDir).catch(() => undefined)
        throw err
      }
      // 成功后删除备份目录
      if (hadExisting) await fs.rm(backup, { recursive: true, force: true }).catch(() => undefined)
    } catch (err) {
      // 任何失败都清理 staging 目录
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
      throw err
    }
  })
}

// 递归读取目录下全部文件：返回相对路径 → 字节 的映射（目录不可读时按空处理）
function readDirectoryFiles(baseDir: string) {
  return Effect.promise(async () => {
    const out: Record<string, Uint8Array> = {}
    // walk：current 为绝对目录，prefix 为已累积的相对路径
    const walk = async (current: string, prefix: string): Promise<void> => {
      const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])
      await Promise.all(
        entries.map(async (entry) => {
          // 拼相对路径与绝对路径
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name
          const full = path.join(current, entry.name)
          // 子目录继续递归；文件读取字节
          if (entry.isDirectory()) return walk(full, rel)
          if (entry.isFile()) out[rel] = new Uint8Array(await fs.readFile(full))
        }),
      )
    }
    await walk(baseDir, "")
    return out
  })
}
