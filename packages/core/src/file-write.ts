// 文件写入（File Write）：把路径解析、审批、写入与格式化串成完整的写文件流程。
export * as FileWrite from "./file-write.js"

import { makeLocationNode } from "@opencode/util/effect/app-node"
import type { FileDiff } from "@opencode/schema/file-diff"
import { Bom } from "@opencode/util/bom"
import { Context, Effect, Layer } from "effect"
import { Environment } from "./environment/index.js"
import { FileAccess } from "./file-access.js"
import { FileMutation } from "./file-mutation.js"
import { Formatter } from "./formatter.js"
import { Permission } from "./permission.js"
import type { SessionErrors } from "./session/error.js"
import { fileDiff } from "./tool/plugin/file-diff.js"

// 写入输入：目标路径与文本内容
export interface WriteInput {
  readonly path: string
  readonly content: string
}

// 写入完成结果（Written）：在文本写入结果之上附带格式化后的文本
export interface Written extends FileMutation.TextWriteResult {
  /** The file text after a formatter ran on it. */
  readonly formatted?: string
}

// 服务接口
export interface Interface {
  /** Resolve a file to write and obtain external-directory approval. */
  // 解析待写文件，并取得外部目录审批
  readonly target: (
    file: string,
    context: FileAccess.Invocation,
  ) => Effect.Effect<FileAccess.Target, Environment.Failed | Permission.Error | SessionErrors.NotFoundError>
  /** Request edit approval for a resolved target, showing the change when it is known. */
  // 为已解析目标请求编辑审批，若改动已知则随审批展示差异
  readonly authorize: (
    target: FileAccess.Target,
    context: FileAccess.Invocation,
    preview?: FileDiff.Info,
  ) => Effect.Effect<void, Permission.Error | SessionErrors.NotFoundError>
  /** Write approved text, keeping an existing UTF-8 BOM, then format the file. */
  // 写入已批准文本（保留既有 UTF-8 BOM），随后对文件做格式化
  readonly commit: (
    target: FileAccess.Target,
    content: string,
  ) => Effect.Effect<Written, Environment.NotFound | Environment.WrongKind | Environment.Failed>
  /** Resolve, approve, write and format a whole file. */
  // 一步完成整份文件：解析 → 审批 → 写入 → 格式化
  readonly write: (
    input: WriteInput,
    context: FileAccess.Invocation,
  ) => Effect.Effect<
    Written,
    Environment.NotFound | Environment.WrongKind | Environment.Failed | Permission.Error | SessionErrors.NotFoundError
  >
}

// Effect 服务令牌
export class Service extends Context.Service<Service, Interface>()("@opencode/FileWrite") {}

// 服务实现层
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 文件访问服务：解析与外部目录审批
    const access = yield* FileAccess.Service
    // 环境服务：读取现有文件内容
    const environment = yield* Environment.Service
    // 文件变更服务：实际写入
    const fileMutation = yield* FileMutation.Service
    // 格式化服务
    const formatter = yield* Formatter.Service
    // 权限服务：编辑审批
    const permission = yield* Permission.Service

    // target：解析目标文件并请求外部目录审批
    const target = Effect.fn("FileWrite.target")(function* (file: string, context: FileAccess.Invocation) {
      // 明确按文件解析
      const target = yield* access.resolve({ path: file, kind: "file" })
      // 目标在位置之外时请求外部目录审批
      yield* access.authorizeExternal([target], context)
      return target
    })

    // authorize：请求编辑审批；带差异预览时把差异放进审批元数据供界面展示
    const authorize = Effect.fn("FileWrite.authorize")(function* (
      target: FileAccess.Target,
      context: FileAccess.Invocation,
      preview?: FileDiff.Info,
    ) {
      yield* permission.assert({
        // 编辑动作
        action: "edit",
        resources: [target.resource],
        save: ["*"],
        // 有预览则携带文件差异
        metadata: preview ? { files: [preview] } : undefined,
        ...Permission.invocation(context),
      })
    })

    // commit：保留 BOM 写入文本；若该文件需要格式化则把格式化结果写回并返回
    const commit = Effect.fn("FileWrite.commit")(function* (target: FileAccess.Target, content: string) {
      // 先按 BOM 保留策略写入
      const written = yield* fileMutation.writeTextPreservingBom({ target, content })
      // 文件不参与格式化则直接返回
      if (!(yield* formatter.file(target.absolute))) return written
      return {
        ...written,
        // 同步 BOM 并取回格式化后的文本
        formatted: yield* FileMutation.syncTextBom(environment.files, target.absolute, written.bom),
      } satisfies Written
    })

    // write：完整写流程 —— 解析 → 读取现有内容生成差异 → 请求编辑审批 → 提交写入
    const write = Effect.fn("FileWrite.write")(function* (input: WriteInput, context: FileAccess.Invocation) {
      const resolved = yield* target(input.path, context)
      // 读取现有文本（可能不存在）
      const current = yield* FileMutation.readOptionalText(environment.files, resolved.absolute)
      yield* authorize(
        resolved,
        context,
        // 生成旧/新文本差异，并标记新增或修改
        fileDiff(resolved.resource, current?.text ?? "", Bom.split(input.content).text, current ? "modified" : "added"),
      )
      return yield* commit(resolved, input.content)
    })

    return Service.of({ target, authorize, commit, write })
  }),
)

// 位置节点：文件写入服务随位置装配，依赖其全部协作服务节点
export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Environment.node, FileAccess.node, FileMutation.node, Formatter.node, Permission.node],
})
