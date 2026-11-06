// 文件变更（File Mutation）：按路径加锁串行化读/写事务，提供通用写入与保留 BOM 的文本写入能力。
export * as FileMutation from "./file-mutation.js"

import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Context, Effect, Layer } from "effect"
import { KeyedMutex } from "./effect/keyed-mutex.js"
import { FSUtil } from "@opencode/util/fs-util"
import { Bom } from "@opencode/util/bom"
import { Environment } from "./environment/index.js"
import type { Files } from "./environment/index.js"
import type { FileAccess } from "./file-access.js"

// 变更目标（Target）：从文件访问目标中挑选绝对路径与资源标识
export type Target = Pick<FileAccess.Target, "absolute" | "resource">

// 写入输入：目标 + 内容（文本或二进制字节）
export interface WriteInput {
  readonly target: Target
  readonly content: string | Uint8Array
}

// 文本写入输入：内容限定为字符串
export interface TextWriteInput {
  readonly target: Target
  readonly content: string
}

// 写入结果：操作类型、目标路径、资源标识、文件此前是否存在
export interface WriteResult {
  readonly operation: "write"
  readonly target: string
  readonly resource: string
  readonly existed: boolean
}

// 文本写入结果：额外携带最终是否带 BOM（字节顺序标记，byte order mark）
export interface TextWriteResult extends WriteResult {
  readonly bom: boolean
}

// 服务接口
export interface Interface {
  /** Serialize a complete read/prepare/write mutation transaction by resolved path. */
  // 按解析后的路径串行化完整的读/准备/写变更事务
  readonly withLock: (
    targets: ReadonlyArray<string>,
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  // 通用写入
  readonly write: (input: WriteInput) => Effect.Effect<WriteResult, Environment.Failed>
  /** Write text while retaining an existing UTF-8 BOM and emitting at most one BOM. */
  // 写文本时保留既有 UTF-8 BOM，且至多输出一个 BOM
  readonly writeTextPreservingBom: (
    input: TextWriteInput,
  ) => Effect.Effect<TextWriteResult, Environment.WrongKind | Environment.Failed>
}

// Effect 服务令牌
export class Service extends Context.Service<Service, Interface>()("@opencode/FileMutation") {}

// 读取文本文件：读取字节后按 BOM 解码为字符串
export const readText = Effect.fn("FileMutation.readText")(function* (files: Files, target: string) {
  return Bom.decodeBytes((yield* files.read(target)).bytes)
})

// 读取可选文本：文件不存在时返回 undefined 而不是失败
export const readOptionalText = Effect.fn("FileMutation.readOptionalText")(function* (files: Files, target: string) {
  // 未找到时吞掉错误
  const result = yield* files.read(target).pipe(Effect.catchTag("Environment.NotFound", () => Effect.undefined))
  return result ? Bom.decodeBytes(result.bytes) : undefined
})

// 同步文本的 BOM 状态：按需在现有字节上添加/移除 BOM 后写回，返回最终文本
export const syncTextBom = Effect.fn("FileMutation.syncTextBom")(function* (
  files: Files,
  target: string,
  bom: boolean,
) {
  // 按目标 BOM 状态同步字节
  const synced = Bom.syncBytes((yield* files.read(target)).bytes, bom)
  // 有字节变化才写回
  if (synced.bytes) yield* files.write(target, synced.bytes)
  return synced.text
})

/** Share transaction locks across Location graphs that address the same file. */
// 跨位置图（Location graph）共享事务锁：寻址同一文件的不同位置图共用锁，避免并发写冲突
const transactionLocks = KeyedMutex.makeUnsafe<string>()

/**
 * Mutation locking is process-local and serializes cooperating OpenCode
 * changes; external writes can still race.
 */
// 服务实现层
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 环境服务，提供文件读写
    const environment = yield* Environment.Service
    // 进程内按键互斥锁，按目标绝对路径加锁
    const locks = KeyedMutex.makeUnsafe<string>()
    // 多目标事务锁：对去重并排序后的路径逆序嵌套加锁，保证全局锁顺序一致（避免死锁）
    const withLock: Interface["withLock"] = (targets) => (effect) =>
      [...new Set(targets.map(FSUtil.resolve))]
        .sort()
        .reduceRight((result, target) => transactionLocks.withLock(target)(result), effect)
    // 单目标锁：按目标绝对路径加锁，并让效果不可中断，保证写操作原子完成
    const withTargetLock =
      (target: Target) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        locks.withLock(target.absolute)(Effect.uninterruptible(effect))

    // 构造写入结果对象
    const writeResult = (target: Target, existed: boolean): WriteResult => ({
      operation: "write",
      target: target.absolute,
      resource: target.resource,
      existed,
    })

    // 通用写入：先查存在性，再写入（文本编码为 UTF-8 字节），返回结果
    const write = Effect.fn("FileMutation.write")((input: WriteInput) =>
      withTargetLock(input.target)(
        Effect.gen(function* () {
          const existed = yield* environment.files.stat(input.target.absolute).pipe(
            // stat 判断文件是否已存在
            Effect.as(true),
            // 不存在记为 false
            Effect.catchTag("Environment.NotFound", () => Effect.succeed(false)),
          )
          yield* environment.files.write(
            input.target.absolute,
            // 字符串编码为字节后写入
            typeof input.content === "string" ? new TextEncoder().encode(input.content) : input.content,
          )
          return writeResult(input.target, existed)
        }),
      ),
    )

    // 保留 BOM 的文本写入：读现有文件头 3 字节判断 BOM，与内容自带 BOM 合并决策
    const writeTextPreservingBom = Effect.fn("FileMutation.writeTextPreservingBom")((input: TextWriteInput) =>
      withTargetLock(input.target)(
        Effect.gen(function* () {
          // 拆分内容中的 BOM
          const next = Bom.split(input.content)
          const current = yield* environment.files.read(input.target.absolute, { offset: 0, length: 3 }).pipe(
            // 只读前 3 字节判断现有 BOM
            Effect.map((result) => result.bytes),
            // 文件不存在则为 undefined
            Effect.catchTag("Environment.NotFound", () => Effect.undefined),
          )
          // 保留已有 BOM，或沿用内容自带 BOM
          const bom = Boolean(current && Bom.has(current)) || next.bom
          // 按决策重组文本写回
          yield* environment.files.write(input.target.absolute, new TextEncoder().encode(Bom.join(next.text, bom)))
          return { ...writeResult(input.target, current !== undefined), bom }
        }),
      ),
    )

    return Service.of({ withLock, write, writeTextPreservingBom })
  }),
)

// 位置节点：文件变更服务随位置装配，依赖环境节点
export const node = makeLocationNode({ service: Service, layer, deps: [Environment.node] })

/**
 * Deferred until the corresponding integrations exist.
 */
// 以下能力推迟到对应集成存在后再实现：
// TODO: Publish watcher/file-edit events after watcher integration exists.
// TODO: Add snapshots / undo after snapshot design exists.
// TODO: Notify LSP and collect diagnostics after LSP runtime exists.
// TODO: Design multi-file transactions / rollback if patch needs atomic edits.
// Until then, edits are sequential and report partial application.
// TODO: Define crash recovery and idempotency for side effects between Tool.Called and durable settlement.
