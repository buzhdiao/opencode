// 将本模块以命名空间方式重新导出为 PatchTool
export * as PatchTool from "./patch.js"

// 导入插件上下文类型（Context）
import type { Context } from "@opencode/plugin/effect/plugin"
// 导入会话钩子类型（SessionHooks）
import type { SessionHooks } from "@opencode/plugin/effect/session"
// 导入 Effect 化的工具失败类型（ToolFailure）
import { ToolFailure } from "@opencode/ai/effect"
// 导入 FileDiff Schema（文件差异结构）
import { FileDiff } from "@opencode/schema/file-diff"
// 导入 Effect 原语：Effect、Result（成功/失败容器）、Schema
import { Effect, Result, Schema } from "effect"
// 导入 BOM 工具：处理字节顺序标记（BOM）的拆分与拼接
import { Bom } from "@opencode/util/bom"
// 导入统一的工具失败映射函数
import { toolFailure } from "../runtime.js"
// 导入环境（Environment）服务：文件系统操作与错误类型
import { Environment } from "../../environment/index.js"
// 导入格式化器（Formatter）服务：写文件后自动格式化
import { Formatter } from "../../formatter.js"
// 导入文件变更（FileMutation）服务：读文本、加锁、同步 BOM
import { FileMutation } from "../../file-mutation.js"
// 导入位置（Location）服务：当前工作目录
import { Location } from "../../location.js"
// 导入文件访问（FileAccess）服务：路径解析与授权
import { FileAccess } from "../../file-access.js"
// 导入 Patch 工具库：解析与应用补丁
import { Patch } from "@opencode/util/patch"
// 导入权限（Permission）服务
import { Permission } from "../../permission.js"
// 导入工具描述文本（patch.txt）
import DESCRIPTION from "../patch.txt"
// 导入文件差异计算函数
import { fileDiff } from "./file-diff.js"

// 工具名
export const name = "patch"

// patch 工具的输入 Schema：完整补丁文本
export const Input = Schema.Struct({
  patchText: Schema.String.annotate({
    description: "The full patch text describing add, update, and delete operations",
  }),
})

// 单条已应用操作的 Schema：类型（add/update/delete）、资源路径、目标绝对路径
export const Applied = Schema.Struct({
  // 操作类型
  type: Schema.Literals(["add", "update", "delete"]),
  // 资源路径（用于展示）
  resource: Schema.String,
  // 目标绝对路径
  target: Schema.String,
})

// 输出 Schema：已应用操作列表 + 每个文件的差异信息
export const Output = Schema.Struct({
  // 已应用的操作
  applied: Schema.Array(Applied),
  // 涉及文件的 diff 列表
  files: Schema.Array(FileDiff.Info),
})
// 输出的静态类型
export type Output = typeof Output.Type

// 把输出格式化为面向模型的简洁文本（A/D/M + 路径列表）
export const toModelContent = (output: Output) =>
  [
    // 首行：成功提示
    "Success. Updated the following files:",
    // 逐行输出操作摘要：add->A、delete->D、update->M
    ...output.applied.map(
      (item) => `${item.type === "add" ? "A" : item.type === "delete" ? "D" : "M"} ${item.resource}`,
    ),
  ].join("\n")

// 预处理后的补丁块（Prepared）：按 hunk 类型附带解析出的目标与前后内容
type Prepared =
  // 新增文件：带目标、写入内容、空的前文与后文
  | (Extract<Patch.Hunk, { readonly type: "add" }> & {
      // 解析后的目标文件
      readonly target: FileAccess.Target
      // 将写入的内容
      readonly content: string
      // 修改前内容（新增为空）
      readonly before: string
      // 修改后内容
      readonly after: string
    })
  // 删除文件：带目标与原内容
  | (Extract<Patch.Hunk, { readonly type: "delete" }> & {
      // 解析后的目标文件
      readonly target: FileAccess.Target
      // 删除前内容
      readonly before: string
      // 删除后内容（为空）
      readonly after: string
    })
  // 更新文件：带目标、新内容、前后内容，及可选的移动目标（重命名）
  | (Extract<Patch.Hunk, { readonly type: "update" }> & {
      // 解析后的目标文件
      readonly target: FileAccess.Target
      // 更新后的内容
      readonly content: string
      // 更新前内容
      readonly before: string
      // 更新后内容（不含 BOM）
      readonly after: string
      // 可选的移动（重命名）目标
      readonly moveTarget?: FileAccess.Target
    })

// 插件定义：注册 patch 工具
export const Plugin = {
  // 插件唯一标识
  id: "opencode.tool.patch",
  // 插件的 Effect 主体
  effect: Effect.fn("PatchTool.Plugin")(function* (ctx: Context) {
    // 注入环境服务
    const environment = yield* Environment.Service
    // 注入文件访问服务
    const access = yield* FileAccess.Service
    // 注入文件变更服务（用于互斥锁）
    const fileMutation = yield* FileMutation.Service
    // 注入格式化器服务
    const formatter = yield* Formatter.Service
    // 注入位置服务
    const location = yield* Location.Service
    // 注入权限服务
    const permission = yield* Permission.Service

    // 向工具注册中心注册 patch 工具
    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          // 工具名
          name,
          // 选项：不启用 codemode；要求 edit 权限
          options: { codemode: false, permission: "edit" },
          // 工具描述来自文本文件
          description: DESCRIPTION,
          // 输入/输出 Schema
          input: Input,
          output: Output,
          // 执行体
          execute: (input, context) => {
            // 已成功应用的操作（用于失败时报告进度）
            const applied: Array<typeof Applied.Type> = []
            // 预先解析补丁文本（Result：成功为 hunk 数组，失败为错误）
            const parsed = Patch.parse(input.patchText)
            // 解析成功时计算所有涉及的目标路径（含 update 的移动目标），用于加文件锁
            const lockTargets = Result.isSuccess(parsed)
              ? parsed.success.flatMap((hunk) => [
                  // 主路径
                  FileAccess.resolvePath(location.directory, hunk.path),
                  // update 且带 movePath 时追加移动目标路径
                  ...(hunk.type === "update" && hunk.movePath
                    ? [FileAccess.resolvePath(location.directory, hunk.movePath)]
                    : []),
                ])
              // 解析失败则无需加锁
              : []
            // 构造带“已完成操作”上下文的失败信息
            const fail = (operation: string, error: unknown) => {
              // 已完成的资源列表
              const completed = applied.map((item) => item.resource).join(", ")
              return new ToolFailure({
                message: `${operation}: ${errorMessage(error)}${completed ? `. Completed before failure: ${completed}` : ""}`,
              })
            }
            return Effect.gen(function* () {
              // 补丁文本为空：失败
              if (!input.patchText) return yield* new ToolFailure({ message: "patchText is required" })
              // 取出解析结果（失败则转成工具失败）
              const hunks = yield* Effect.fromResult(parsed).pipe(
                Effect.mapError((error) => new ToolFailure({ message: `patch verification failed: ${error.message}` })),
              )
              // 空补丁：失败
              if (hunks.length === 0) {
                return yield* new ToolFailure({ message: "patch rejected: empty patch" })
              }
              // 预处理结果列表
              const prepared: Prepared[] = []
              // 模拟落盘状态：路径 -> 内容（null 表示已删除），用于处理同一补丁内的连续操作
              const updates = new Map<string, string | null>()
              // 解析目标文件的辅助 Effect：工作区内的直接返回，外部目录需要额外授权
              const resolveTarget = Effect.fnUntraced(function* (value: string) {
                // 解析为文件目标
                const target = yield* access.resolve({ path: value, kind: "file" })
                // 不在外部目录则直接返回
                if (!target.externalDirectory) return target
                // 外部目录：做外部写授权（附文件路径与父目录元数据）
                yield* access.authorizeExternal([target], context, {
                  filepath: target.absolute,
                  parentDir: target.externalDirectory.directory,
                })
                return target
              })
              // 逐个 hunk 预处理（只做校验与内容推导，不写盘）
              for (const hunk of hunks) {
                yield* Effect.gen(function* () {
                  // 解析 hunk 的目标文件
                  const target = yield* resolveTarget(hunk.path)
                  // 新增文件分支
                  if (hunk.type === "add") {
                    // 内容规范化：以换行结尾或为空则原样，否则补一个换行
                    const content =
                      hunk.contents.endsWith("\n") || hunk.contents === "" ? hunk.contents : `${hunk.contents}\n`
                    // 记录预处理结果（新增：before 为空，after 为去 BOM 文本）
                    prepared.push({
                      ...hunk,
                      target,
                      content,
                      before: "",
                      after: Bom.split(content).text,
                    })
                    // 登记模拟状态：该路径将写入新内容
                    updates.set(target.absolute, content)
                    return
                  }
                  // 删除文件分支
                  if (hunk.type === "delete") {
                    // 查询模拟状态
                    const previous = updates.get(target.absolute)
                    // 之前已被删除：再次删除失败
                    if (previous === null) {
                      return yield* new ToolFailure({
                        message: `patch verification failed: Failed to delete ${target.resource}: file does not exist`,
                      })
                    }
                    // 删除前内容：优先取模拟状态，否则真正读文件（失败给出具体原因）
                    const before =
                      previous !== undefined
                        ? Bom.split(previous).text
                        : (yield* FileMutation.readText(environment.files, target.absolute).pipe(
                            Effect.mapError(
                              (error) =>
                                new ToolFailure({
                                  message: `patch verification failed: Failed to delete ${target.resource}: ${errorMessage(error)}`,
                                }),
                            ),
                          )).text
                    // 记录预处理结果
                    prepared.push({ ...hunk, target, before, after: "" })
                    // 登记模拟状态：标记为已删除
                    updates.set(target.absolute, null)
                    return
                  }
                  // 更新文件分支：查询模拟状态
                  const previous = updates.get(target.absolute)
                  // 之前已被删除：无法更新
                  if (previous === null) {
                    return yield* new ToolFailure({
                      message: `patch verification failed: Failed to read file to update ${target.absolute}: file does not exist`,
                    })
                  }
                  // 原始内容：优先取模拟状态，否则读文件并保留 BOM
                  const original =
                    previous ??
                    (yield* Effect.gen(function* () {
                      // 读文件（失败给出具体原因）
                      const content = yield* FileMutation.readText(environment.files, target.absolute).pipe(
                        Effect.mapError(
                          (error) =>
                            new ToolFailure({
                              message: `patch verification failed: Failed to read file to update ${target.absolute}: ${errorMessage(error)}`,
                            }),
                        ),
                      )
                      // 把文本与 BOM 重新拼接成原始字节内容
                      return Bom.join(content.text, content.bom)
                    }))
                  // 拆出去 BOM 的前文
                  const before = Bom.split(original).text
                  // 由补丁块推导新内容（上下文不匹配会抛错）
                  const update = yield* Effect.try({
                    try: () => Patch.derive(hunk.path, hunk.chunks, original),
                    catch: (error) => new ToolFailure({ message: `patch verification failed: ${errorMessage(error)}` }),
                  })
                  // 有移动路径则解析移动目标
                  const move = hunk.movePath ? yield* resolveTarget(hunk.movePath) : undefined
                  // 移动目标与原路径相同则视为未移动
                  const moveTarget = move && move.absolute !== target.absolute ? move : undefined
                  // 新内容拼回 BOM
                  const next = Patch.joinBom(update.content, update.bom)
                  // 记录预处理结果
                  prepared.push({
                    ...hunk,
                    target,
                    content: next,
                    before,
                    after: update.content,
                    moveTarget,
                  })
                  // 更新模拟状态：有移动则原路径标记删除、新路径写入内容；否则原地更新
                  if (moveTarget) {
                    updates.set(target.absolute, null)
                    updates.set(moveTarget.absolute, next)
                  } else {
                    updates.set(target.absolute, next)
                  }
                }).pipe(
                  // 预处理失败给统一消息
                  Effect.mapError(toolFailure(`Unable to prepare patch at ${hunk.path}`)),
                )
              }

              // 为每个预处理的变更生成 diff 文件信息
              const patchFiles = prepared.map((change) => patchFile(change))
              // 汇总所有涉及的目标（含移动目标）
              const targets = prepared.flatMap((change) => [
                change.target,
                ...(change.type === "update" && change.moveTarget ? [change.moveTarget] : []),
              ])
              // 断言 edit 权限：资源为所有涉及文件（去重），元数据带路径与完整 diff
              yield* permission.assert({
                action: "edit",
                resources: [...new Set(targets.map((target) => target.resource))],
                save: ["*"],
                metadata: {
                  // 涉及的文件路径列表
                  filepath: targets.map((target) => target.resource).join(", "),
                  // 所有 diff 拼接的补丁文本
                  diff: patchFiles.map((file) => `${file.patch}\n`).join(""),
                  // 结构化的文件差异
                  files: patchFiles,
                },
                ...Permission.invocation(context),
              })

              // 真正执行写盘：逐个变更落盘
              yield* Effect.forEach(
                prepared,
                (change) =>
                  Effect.gen(function* () {
                    // update 且有移动目标时写入新位置
                    const moveTarget = change.type === "update" ? change.moveTarget : undefined
                    // 实际写入目标
                    const target = moveTarget ?? change.target
                    // 删除操作：移除文件
                    if (change.type === "delete")
                      yield* environment.files
                        .remove(change.target.absolute)
                        .pipe(Effect.mapError((error) => fail(`Failed to delete ${change.target.resource}`, error)))
                    // 非删除操作：写入内容（UTF-8 编码）
                    if (change.type !== "delete")
                      yield* environment.files
                        .write(target.absolute, new TextEncoder().encode(change.content))
                        .pipe(Effect.mapError((error) => fail(`Failed to write ${target.resource}`, error)))
                    // 有移动目标：写入新位置后删除旧文件
                    if (moveTarget)
                      yield* environment.files
                        .remove(change.target.absolute)
                        .pipe(
                          Effect.mapError((error) =>
                            fail(`Wrote ${moveTarget.resource} but failed to remove ${change.target.resource}`, error),
                          ),
                        )
                    // 登记已应用操作
                    applied.push({ type: change.type, resource: target.resource, target: target.absolute })
                  }),
                // 不收集返回值
                { discard: true },
              )
              // 格式化结果缓存：路径 -> 格式化后文本
              const formatted = new Map<string, string>()
              // 对所有“最终存在”的文件（排除已删除的）尝试格式化
              yield* Effect.forEach(
                [...updates.entries()].flatMap(([target, value]) => (value === null ? [] : [target])),
                (target) =>
                  Effect.gen(function* () {
                    // 重新读当前文件内容（可能被格式化器改动过）
                    const current = yield* FileMutation.readText(environment.files, target).pipe(
                      Effect.mapError((error) => fail(`Failed to read ${target}`, error)),
                    )
                    // 缓存格式化结果：该文件配置了格式化器则同步（保留 BOM），否则用原文
                    formatted.set(
                      target,
                      (yield* formatter.file(target))
                        ? yield* FileMutation.syncTextBom(environment.files, target, current.bom).pipe(
                            Effect.mapError((error) => fail(`Failed to sync ${target}`, error)),
                          )
                        : current.text,
                    )
                  }),
                { discard: true },
              )
              // 组装最终 diff 列表：删除用原样，其他用（移动目标处的）格式化后文本
              const files = prepared.map((change) => {
                if (change.type === "delete") return patchFile(change)
                const target = change.type === "update" && change.moveTarget ? change.moveTarget : change.target
                return patchFile(change, formatted.get(target.absolute))
              })
              // 返回已应用操作与文件差异
              return { applied, files }
            }).pipe(
              // 全程持有涉及文件的互斥锁，避免与并发的编辑/写入工具冲突
              fileMutation.withLock(lockTargets),
              // 成功后组织工具返回：输出 + 面向模型文本 + 元数据
              Effect.map((output) => ({
                output,
                content: toModelContent(output),
                metadata: { files: output.files },
              })),
              // 整体失败兜底消息
              Effect.mapError(toolFailure("Unable to apply patch")),
            )
          },
        }),
      )
      // 注册出错则直接中断
      .pipe(Effect.orDie)

    // 会话钩子：根据模型决定启用 patch 还是 edit/write 工具
    const hook = (event: SessionHooks["context"]) =>
      Effect.sync(() => {
        // OpenAI 的 GPT 系列模型（排除 oss 与 gpt-4）更适合 patch 格式
        const usePatch =
          event.model.id.includes("gpt-") && !event.model.id.includes("oss") && !event.model.id.includes("gpt-4")
        if (usePatch) {
          // 使用 patch：移除 edit 与 write 工具
          delete event.tools.edit
          delete event.tools.write
          return
        }
        // 其他模型：移除 patch 工具
        delete event.tools.patch
      })
    // 在 context / compaction / generate 三个钩子点注册
    yield* ctx.session.hook("context", hook)
    yield* ctx.session.hook("compaction", hook)
    yield* ctx.session.hook("generate", hook)
  }),
}

// 把任意错误翻译成简短的人类可读消息
function errorMessage(error: unknown) {
  // 文件不存在
  if (error instanceof Environment.NotFound) return "file does not exist"
  // 路径类型不符：是目录或别的类型
  if (error instanceof Environment.WrongKind)
    return error.actual === "directory" ? "path is a directory" : `path is ${error.actual}`
  // 包装型失败：递归取原因
  if (error instanceof Environment.Failed) return errorMessage(error.cause)
  // 普通错误取 message，其他转字符串
  return error instanceof Error ? error.message : String(error)
}

// 为一个变更生成 FileDiff 信息（默认 after 取变更自身的后文）
function patchFile(change: Prepared, after = change.after): typeof FileDiff.Info.Type {
  // 更新且移动时，展示的目标用移动后的资源路径
  const target = (change.type === "update" ? change.moveTarget : undefined)?.resource ?? change.target.resource
  // 计算 diff（状态按操作类型映射）
  const diff = fileDiff(
    change.target.absolute,
    change.before,
    after,
    change.type === "add" ? "added" : change.type === "delete" ? "deleted" : "modified",
  )
  // 返回修正过目标路径并裁剪过缩进的 diff
  return {
    ...diff,
    file: target,
    patch: trimDiff(diff.patch),
  }
}

// 裁剪 diff 中的公共缩进，使补丁更紧凑
function trimDiff(diff: string) {
  // 按行拆分
  const lines = diff.split("\n")
  // 取出正文行（+/-/空格开头，排除文件头的 ---/+++）
  const content = lines.filter(
    (line) =>
      (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) &&
      !line.startsWith("---") &&
      !line.startsWith("+++"),
  )
  // 没有正文行则原样返回
  if (content.length === 0) return diff
  // 计算正文行的最小公共缩进（忽略纯空白行）
  const indent = content.reduce((result, line) => {
    // 去掉 diff 前缀字符后的内容
    const value = line.slice(1)
    // 空白行不参与统计
    if (value.trim().length === 0) return result
    // 取该行前导空白长度与当前最小值的较小者
    return Math.min(result, value.match(/^(\s*)/)?.[1].length ?? result)
  }, Infinity)
  // 无公共缩进或缩进为 0：原样返回
  if (indent === Infinity || indent === 0) return diff
  // 逐行去掉公共缩进后拼接
  return lines
    .map((line) => {
      if (
        (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) &&
        !line.startsWith("---") &&
        !line.startsWith("+++")
      ) {
        // 保留前缀字符，跳过公共缩进
        return line[0] + line.slice(1 + indent)
      }
      // 非正文行（文件头等）原样保留
      return line
    })
    .join("\n")
}
