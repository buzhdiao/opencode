// 文件访问（File Access）：词法解析路径、判定内部/外部目标，并对接权限系统请求外部目录与读权限。
export * as FileAccess from "./file-access.js"

import { makeLocationNode } from "@opencode/util/effect/app-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Array, Context, Effect, Layer, Schema } from "effect"
import path from "path"
import { Environment } from "./environment/index.js"
import { Location } from "./location.js"
import { Permission } from "./permission.js"
import { Project } from "./project.js"
import { AbsolutePath } from "./schema.js"
import type { SessionErrors } from "./session/error.js"
import type { Tool } from "./tool.js"

// 目标种类（Kind）：普通文件或目录
export const Kind = Schema.Literals(["file", "directory"])
export type Kind = typeof Kind.Type

// 解析（resolve）操作的输入结构
export const ResolveInput = Schema.Struct({
  // 待解析的原始路径
  path: Schema.String,
  /** Selects the external approval boundary; it does not validate the target type. */
  // 可选：选择外部审批边界，并不校验目标类型
  kind: Kind.pipe(Schema.optional),
})
export type ResolveInput = typeof ResolveInput.Type

// 外部目录授权信息：目标位于位置（Location）之外时记录审批边界
export interface ExternalDirectoryAuthorization {
  // 权限动作类型：外部目录
  readonly action: "external_directory"
  /** Lexical directory used as the external approval boundary. */
  // 作为外部审批边界的词法目录
  readonly directory: AbsolutePath
  // 待审批的资源标识（目录下全部内容）
  readonly resource: string
  // 用户选择"记住"授权时的保存范围
  readonly save: string
}

// 解析结果目标（Target）：绝对路径 + 权限资源标识 + 可选的外部目录授权
export interface Target {
  // 解析后的绝对路径
  readonly absolute: AbsolutePath
  /** Location-relative for internal paths, absolute for external paths. */
  // 权限资源标识：内部路径相对位置目录，外部路径为绝对路径
  readonly resource: string
  // 外部目录时携带的授权信息
  readonly externalDirectory?: ExternalDirectoryAuthorization
}

// 调用上下文（Invocation）：从工具上下文中挑出的会话/代理/消息/工具调用 ID
export type Invocation = Pick<Tool.Context, "sessionID" | "agent" | "messageID" | "id">

// 读取选项：允许传入一个本次调用已授权的同级目标，用于文件名恢复
export interface ReadOptions {
  /** A target already authorized by this invocation, used for filename recovery. */
  readonly siblingOf: Target
}

// 文件访问服务接口
export interface Interface {
  /** Resolve a lexical path and its permission resources, without requesting approval. */
  // 词法解析路径并计算权限资源标识，但不发起审批
  readonly resolve: (input: ResolveInput) => Effect.Effect<Target, Environment.Failed>
  /** Approve external directories in one batch, preserving first-seen resource order. */
  // 批量请求外部目录审批，保持资源首次出现的顺序
  readonly authorizeExternal: (
    targets: readonly Target[],
    context: Invocation,
    metadata?: Permission.AssertInput["metadata"],
  ) => Effect.Effect<void, Permission.Error | SessionErrors.NotFoundError>
  /** Resolve a read target and obtain external-directory approval before read approval. */
  // 解析读取目标，并先取得外部目录审批、再取得读权限审批
  readonly authorizeRead: (
    file: string,
    context: Invocation,
    options?: ReadOptions,
  ) => Effect.Effect<Target, Environment.Failed | Permission.Error | SessionErrors.NotFoundError>
}

// Effect 服务令牌（Service tag）
export class Service extends Context.Service<Service, Interface>()("@opencode/FileAccess") {}

/** Expand a leading ~ and normalize Windows shell paths before lexical resolution. */
// 词法解析前：展开前导 ~ 并归一化 Windows 外壳路径
export const resolvePath = (directory: string, input: string, home = Global.Path.home) => {
  // 先把 Windows 风格路径归一化
  const normalized = FSUtil.windowsPath(input)
  return path.resolve(
    directory,
    // 仅 "~" 时直接指向家目录
    normalized === "~"
      ? home
      // "~/"（或 Windows 的 "~\"）展开到家目录下
      : normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))
        ? path.join(home, normalized.slice(2))
        // 其他情况按相对路径处理
        : normalized,
  )
}

// 把反斜杠统一替换为正斜杠，保证资源标识跨平台一致
const slash = (value: string) => value.replaceAll("\\", "/")

// 服务实现层
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 取出环境中的文件操作接口
    const { files } = yield* Environment.Service
    // 判断文件是否存在的辅助函数
    const exists = (file: string) => Environment.exists(files, file)
    // 当前位置（工作目录）服务
    const location = yield* Location.Service
    // 权限服务，用于发起审批
    const permission = yield* Permission.Service

    // resolve：词法解析路径并计算权限资源
    const resolve = Effect.fn("FileAccess.resolve")(function* (input: ResolveInput) {
      // 解析为绝对路径
      const absolute = AbsolutePath.make(resolvePath(location.directory, input.path))
      // 项目工作树根目录
      const worktree = path.resolve(location.project.directory)
      // 内部判定：目标位于位置目录内，或位于（非盘符根的）工作树内
      const internal =
        FSUtil.contains(location.directory, absolute) ||
        (worktree !== path.parse(worktree).root && FSUtil.contains(worktree, absolute))
      if (internal) {
        return {
          absolute,
          // 内部资源用相对位置目录的路径表示（位置根记为 "."）
          resource: slash(path.relative(location.directory, absolute) || "."),
        } satisfies Target
      }
      // 外部目标：尽量确定种类（文件/目录）以圈定审批边界
      const type =
        // 调用方显式给出 kind 时优先使用
        input.kind ??
        (yield* Environment.typeFollowing(files, absolute).pipe(
          // 目标不存在则视为未定义
          Effect.catchTag("Environment.NotFound", () => Effect.undefined),
        ))
      // 审批边界取目录本身或文件所在目录
      const directory = AbsolutePath.make(type === "directory" ? absolute : path.dirname(absolute))
      return {
        absolute,
        // 外部资源直接用绝对路径
        resource: slash(absolute),
        externalDirectory: {
          action: "external_directory",
          directory,
          // 待审批资源：该目录下所有内容
          resource: slash(path.join(directory, "*")),
          // 保存范围：项目根（若可确定）下所有内容
          save: slash(path.join((yield* Project.root({ exists }, directory)) ?? directory, "*")),
        },
      } satisfies Target
    })

    // 批量审批外部目录：按资源去重后一次性请求，减少弹窗次数
    const authorizeExternal = Effect.fn("FileAccess.authorizeExternal")(function* (
      targets: readonly Target[],
      context: Invocation,
      metadata?: Permission.AssertInput["metadata"],
    ) {
      // 收集所有外部目录授权并按 resource 去重
      const external = Array.dedupeWith(
        targets.flatMap((target) => (target.externalDirectory ? [target.externalDirectory] : [])),
        (left, right) => left.resource === right.resource,
      )
      // 没有外部目录则无需审批
      if (external.length === 0) return
      yield* permission.assert({
        // 请求外部目录动作
        action: "external_directory",
        // 各边界资源
        resources: external.map((item) => item.resource),
        // 各"记住"范围
        save: external.map((item) => item.save),
        // 可选元数据透传
        ...(metadata === undefined ? {} : { metadata }),
        // 附带调用上下文（会话/消息等）
        ...Permission.invocation(context),
      })
    })

    // 读授权：解析目标 →（必要时）外部目录审批 → 读权限审批
    const authorizeRead = Effect.fn("FileAccess.authorizeRead")(function* (
      file: string,
      context: Invocation,
      options?: ReadOptions,
    ) {
      // 文件名恢复场景按文件解析
      const target = yield* resolve({ path: file, kind: options ? "file" : undefined })
      // 是否与已授权目标同目录
      const sibling = options && path.dirname(target.absolute) === path.dirname(options.siblingOf.absolute)

      // Filename recovery shares the directory approval, but checks the recovered file's own read rules.
      // 文件名恢复共用同目录的外部审批，但恢复出的文件仍要走自身的读规则
      // 非同目录则单独请求外部目录审批
      if (!sibling) yield* authorizeExternal([target], context)
      yield* permission.assert({
        // 请求读动作
        action: "read",
        resources: [target.resource],
        save: ["*"],
        ...Permission.invocation(context),
      })
      // 返回已授权的目标
      return target
    })

    return Service.of({ resolve, authorizeExternal, authorizeRead })
  }),
)

// 位置节点：文件访问服务随位置装配，依赖环境/位置/权限节点
export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Environment.node, Location.node, Permission.node],
})
