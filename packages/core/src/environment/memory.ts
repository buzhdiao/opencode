// 导入 Node 的 posix 路径工具（内存驱动统一使用 POSIX 风格路径）
import path from "node:path"
// 从 effect 库导入 Effect（效果类型）与 PlatformError（平台错误构造）
import { Effect, PlatformError } from "effect"
// 导入 ChildProcessSpawner 的 make：自定义派生器实现
import { make } from "effect/process/ChildProcessSpawner"
// 仅作类型导入：Driver 驱动器接口
import type { Driver } from "./driver.js"
// 导入错误类型与 Files 相关类型
import { Failed, NotFound, WrongKind, type FileInfo, type FilesImpl, type FileType } from "./files.js"

// Node：内存文件系统的节点类型——文件（含内容字节）、目录或符号链接（含目标路径）
type Node =
  | { readonly type: "file"; readonly bytes: Uint8Array; readonly mtimeMs: number }
  | { readonly type: "directory"; readonly mtimeMs: number }
  | { readonly type: "symlink"; readonly target: string; readonly mtimeMs: number }

// MemoryDriver：在 Driver 之上扩展一个 symlink 操作（内存文件系统专供测试建链接）
export interface MemoryDriver extends Driver {
  readonly symlink: (target: string, path: string) => Effect.Effect<void, Failed>
}

// makeMemoryDriver：构造一个完全驻留内存的文件系统驱动器（测试与无盘环境用）
export const makeMemoryDriver = (): MemoryDriver => {
  // 节点表：绝对路径 -> 节点；初始仅有一个根目录
  const nodes = new Map<string, Node>([["/", { type: "directory", mtimeMs: Date.now() }]])
  // key：把任意输入解析为规范化的绝对 POSIX 路径
  const key = (value: string) => path.posix.resolve("/", value)
  // info：把节点映射为统一的 FileInfo；大小按文件字节数/链接目标编码长度/目录为 0
  const info = (node: Node): FileInfo => ({
    type: node.type,
    size:
      node.type === "file"
        ? node.bytes.length
        : node.type === "symlink"
          ? new TextEncoder().encode(node.target).length
          : 0,
    mtimeMs: node.mtimeMs,
  })
  // resolveKey：解析路径中的符号链接。followFinal 决定是否跟随末级链接；
  // seen 集合用于检测循环链接（重复出现即视为不可解析，返回 undefined）
  const resolveKey = (value: string, followFinal: boolean, seen = new Set<string>()): string | undefined => {
    // 先规范化路径并拆分为各段
    const normalized = key(value)
    const parts = normalized.split("/").filter(Boolean)
    // 从根目录开始逐段下行
    const base = "/"
    const walk = (current: string, index: number): string | undefined => {
      // 所有段处理完毕，返回最终路径
      if (index === parts.length) return current
      const part = parts[index]
      // 计算当前段的候选路径
      const candidate = path.posix.join(current, part)
      // 查表取节点
      const node = nodes.get(candidate)
      // 非符号链接、或末级链接且不要求跟随：直接继续下一段
      if (node?.type !== "symlink" || (!followFinal && index === parts.length - 1)) return walk(candidate, index + 1)
      // 该链接已在解析链中出现过：判定为循环，解析失败
      if (seen.has(candidate)) return undefined
      seen.add(candidate)
      // 把链接目标（相对链接则相对其所在目录）与剩余路径段拼接后递归解析
      const target = path.posix.resolve(path.posix.dirname(candidate), node.target)
      return resolveKey(path.posix.join(target, ...parts.slice(index + 1)), followFinal, seen)
    }
    // 从根开始解析
    return walk(base, 0)
  }
  // lookup：按 lstat 语义查找节点（不跟随末级链接）；解析失败时退回原始规范化路径
  const lookup = (value: string) => nodes.get(resolveKey(value, false) ?? key(value))
  // requireParent：断言目标的父路径存在且是目录（模拟真实文件系统的前置校验）
  const requireParent = (value: string) => {
    const parentPath = path.posix.dirname(key(value))
    const parent = nodes.get(resolveKey(parentPath, true) ?? parentPath)
    if (!parent) throw new Error(`Parent directory does not exist: ${path.posix.dirname(value)}`)
    if (parent.type !== "directory") throw new Error(`Parent is not a directory: ${path.posix.dirname(value)}`)
  }
  // mkdirSync：同步递归建目录——目标已存在且是目录则跳过；已存在但非目录则报错；
  // 否则先确保父目录存在再插入新目录节点
  const mkdirSync = (value: string) => {
    const target = resolveKey(value, false) ?? key(value)
    const existing = nodes.get(target)
    if (existing?.type === "directory") return
    if (existing) throw new Error(`Path is not a directory: ${value}`)
    const parent = path.posix.dirname(target)
    if (parent !== target) mkdirSync(parent)
    nodes.set(target, { type: "directory", mtimeMs: Date.now() })
  }
  // failed：构造携带路径与原因的 Failed 错误
  const failed = (value: string, cause: unknown) => new Failed({ path: value, cause })
  // overrides：内存实现的文件操作集，覆盖 exec 默认实现
  const overrides: FilesImpl = {
    // stat：不跟随末级链接，返回条目自身的元信息
    stat: (value) =>
      Effect.suspend(() => {
        const node = lookup(value)
        return node ? Effect.succeed(info(node)) : Effect.fail(new NotFound({ path: value }))
      }),
    // read：读取文件内容（可带 range）；跟随链接到最终目标，并校验类型
    read: (value, range) =>
      Effect.gen(function* () {
        // 先按 lstat 语义找到入口节点，不存在即 NotFound
        const original = lookup(value)
        if (!original) return yield* new NotFound({ path: value })
        // 入口本身是目录则报 WrongKind（read 只针对文件内容）
        if (original.type === "directory") return yield* new WrongKind({ path: value, actual: "directory" })
        // 跟随全部链接解析最终节点；解析失败（循环/悬空）视为不存在
        const resolved = resolveKey(value, true)
        const node = resolved === undefined ? undefined : nodes.get(resolved)
        if (!node) return yield* new NotFound({ path: value })
        // 最终目标不是文件则报 WrongKind 并携带实际类型
        if (node.type !== "file") return yield* new WrongKind({ path: value, actual: node.type })
        // 未指定 range 返回全部字节；否则按 offset/length 截取子数组
        const bytes = range === undefined ? node.bytes : node.bytes.subarray(range.offset, range.offset + range.length)
        // slice() 复制一份，避免调用方拿到内部缓冲区引用
        return { info: info(node), bytes: bytes.slice() }
      }),
    // write：写入字节——先确保父目录存在，目标为目录则报错；末级是链接则写到链接目标处
    write: (value, bytes) =>
      Effect.try({
        try: () => {
          // 确保父目录链存在
          mkdirSync(path.posix.dirname(key(value)))
          const existing = lookup(value)
          // 目标本身是目录则无法写入
          if (existing?.type === "directory") throw new Error(`Path is a directory: ${value}`)
          // 末级为符号链接时跟随到目标；否则写入该路径本身
          const target = existing?.type === "symlink" ? resolveKey(value, true) : resolveKey(value, false)
          if (!target) throw new Error(`Cannot resolve symlink: ${value}`)
          // 校验目标父目录存在且为目录
          requireParent(target)
          // 写入文件节点（复制字节并刷新修改时间）
          nodes.set(target, { type: "file", bytes: bytes.slice(), mtimeMs: Date.now() })
        },
        // 任何异常统一转为 Failed
        catch: (cause) => failed(value, cause),
      }),
    // list：列出目录的直接子项并按名称排序；跟随链接确定被列目录
    list: (value) =>
      Effect.gen(function* () {
        const target = resolveKey(value, true) ?? key(value)
        const node = nodes.get(target)
        if (!node) return yield* new NotFound({ path: value })
        if (node.type !== "directory") return yield* new WrongKind({ path: value, actual: node.type })
        // 过滤出父目录恰为目标的条目，映射为 DirEntry 并按名称排序
        return [...nodes.entries()]
          .filter(([entry]) => entry !== target && path.posix.dirname(entry) === target)
          .map(([entry, child]) => ({ name: path.posix.basename(entry), type: child.type satisfies FileType }))
          .sort((a, b) => a.name.localeCompare(b.name))
      }),
    // remove：删除目标及其整棵子树（遍历所有以目标为前缀的节点）
    remove: (value) =>
      Effect.sync(() => {
        const target = resolveKey(value, false) ?? key(value)
        for (const entry of nodes.keys()) {
          if (entry === target || entry.startsWith(`${target}/`)) nodes.delete(entry)
        }
      }),
    // move：移动/重命名，模拟 POSIX rename 的目录语义与防呆校验
    move: (from, to) =>
      Effect.gen(function* () {
        // 解析源路径并取节点，不存在即 NotFound
        const source = resolveKey(from, false) ?? key(from)
        const node = nodes.get(source)
        if (!node) return yield* new NotFound({ path: from })
        yield* Effect.try({
          try: () => {
            // 计算请求的目标路径；若目标已是目录，则移入其内部并保留源名称
            const requested = resolveKey(to, false) ?? key(to)
            const destination =
              nodes.get(requested)?.type === "directory"
                ? path.posix.join(requested, path.posix.basename(source))
                : requested
            // 禁止把目录移动到其自身内部
            if (node.type === "directory" && destination.startsWith(`${source}/`)) {
              throw new Error(`Cannot move a directory into itself: ${from}`)
            }
            // 禁止用目录覆盖非目录
            const existing = nodes.get(destination)
            if (node.type === "directory" && existing && existing.type !== "directory") {
              throw new Error(`Cannot overwrite a non-directory with a directory: ${to}`)
            }
            // 目标父目录必须存在且为目录
            requireParent(destination)
            // 收集源子树的所有节点，先从旧位置删除
            const moved = [...nodes.entries()].filter(([entry]) => entry === source || entry.startsWith(`${source}/`))
            for (const [entry] of moved) nodes.delete(entry)
            // 再按目标前缀重新插入（路径前缀替换实现整树搬移）
            for (const [entry, child] of moved) nodes.set(`${destination}${entry.slice(source.length)}`, child)
          },
          // 异常统一转为 Failed
          catch: (cause) => failed(from, cause),
        })
      }),
    // mkdir：递归创建目录，异常转 Failed
    mkdir: (value) => Effect.try({ try: () => mkdirSync(value), catch: (cause) => failed(value, cause) }),
  }

  // spawner：内存驱动不支持派生进程——任何 spawn 请求都以系统错误失败
  const spawner = make((command) =>
    Effect.suspend(() => {
      // 尽力描述被拒绝的命令（管道命令没有单一可执行名）
      const description = command._tag === "StandardCommand" ? command.command : "pipeline"
      return Effect.fail(
        PlatformError.systemError({
          _tag: "Unknown",
          module: "EnvironmentMemory",
          method: "spawn",
          pathOrDescriptor: description,
          cause: failed(description, new Error("The memory driver cannot spawn processes")),
        }),
      )
    }),
  )

  // 返回内存驱动器：派生器、文件操作集与额外的 symlink 操作
  return {
    spawner,
    overrides,
    symlink: (target, value) =>
      Effect.try({
        try: () => {
          // 先校验链接所在父目录存在且为目录
          requireParent(value)
          // 插入符号链接节点（记录目标路径与当前时间）
          nodes.set(resolveKey(value, false) ?? key(value), { type: "symlink", target, mtimeMs: Date.now() })
        },
        // 异常统一转为 Failed
        catch: (cause) => failed(value, cause),
      }),
  }
}

// 以命名空间形式整体导出本模块
export * as EnvironmentMemory from "./memory.js"
