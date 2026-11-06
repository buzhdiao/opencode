// 导入路径处理工具
import path from "path"
// 导入 file:// URL 转本地路径的工具
import { fileURLToPath } from "url"
// 从 effect 导入 Schema（用于定义标签错误）
import { Schema } from "effect"

// 仓库引用（reference）的基础字段类型
type BaseReference = {
  // 主机名，如 github.com，本地文件引用为 "file"
  readonly host: string
  // 仓库路径（远程为 owner/repo 形式，本地为文件系统路径）
  readonly path: string
  // 路径分段数组
  readonly segments: string[]
  // 所有者（仅两段式 owner/repo 时存在）
  readonly owner?: string
  // 仓库名（最后一段）
  readonly repo: string
  // 原始远程 URL
  readonly remote: string
  // 展示用标签
  readonly label: string
}

// 远程仓库引用类型：可携带协议（如 https:）
export type RemoteReference = BaseReference & {
  readonly protocol?: string
}

// 本地文件仓库引用类型
export type FileReference = BaseReference & {
  readonly host: "file"
  readonly protocol: "file:"
}

// 仓库引用的联合类型：远程或本地文件
export type Reference = RemoteReference | FileReference

// 仓库引用无法解析时的错误
export class InvalidReferenceError extends Schema.TaggedError<InvalidReferenceError>()(
  "RepositoryInvalidReferenceError",
  {
    repository: Schema.String,
    message: Schema.String,
  },
) {}

// 不支持本地文件仓库时的错误
export class UnsupportedLocalRepositoryError extends Schema.TaggedError<UnsupportedLocalRepositoryError>()(
  "RepositoryUnsupportedLocalRepositoryError",
  {
    repository: Schema.String,
    message: Schema.String,
  },
) {}

// 分支名非法错误
export class InvalidBranchError extends Schema.TaggedError<InvalidBranchError>()("RepositoryInvalidBranchError", {
  branch: Schema.String,
  message: Schema.String,
}) {}

// 解析任意仓库输入字符串为引用对象；无法解析时返回 undefined
export function parse(input: string): Reference | undefined {
  // 先做清理（去除 git+ 前缀、#fragment、尾部斜杠等）
  const cleaned = normalizeInput(input)
  // 清理后为空则无法解析
  if (!cleaned) return

  // 匹配 "github:owner/repo" 简写形式
  const githubPrefixed = cleaned.match(/^github:([^/\s]+)\/([^/\s]+)$/)
  // 命中简写则按 github.com 远程构建
  if (githubPrefixed) return buildRemote({ host: "github.com", segments: [githubPrefixed[1], githubPrefixed[2]] })

  // 不含 "://" 时尝试识别非 URL 的简写形式（scp 语法或 host/path）
  if (!cleaned.includes("://")) {
    // 匹配 scp 风格语法：[user@]host:path
    const scp = cleaned.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/)
    // 命中 scp 语法则按该主机构建远程引用
    if (scp) return buildRemote({ host: scp[1], segments: parts(scp[2]), remote: cleaned })

    // 按斜杠拆分为路径段
    const direct = parts(cleaned)
    // 首段形似主机名（含点/冒号/localhost）时按 host/owner/repo 处理
    if (direct.length >= 2 && hostLike(direct[0])) return buildRemote({ host: direct[0], segments: direct.slice(1) })
    // 恰好两段（owner/repo）时默认视为 github.com 仓库
    if (direct.length === 2) return buildRemote({ host: "github.com", segments: direct })
  }

  // 尝试按标准 URL 解析
  try {
    const url = new URL(cleaned)
    // file: 协议表示本地文件仓库
    if (url.protocol === "file:") return buildFile({ url, remote: cleaned })
    // 拆分 URL 路径段
    const segments = parts(url.pathname)
    // 构建远程引用；github.com 时统一生成规范克隆 URL
    return buildRemote({
      host: url.host,
      segments,
      remote: url.host === "github.com" ? githubRemote(segments.join("/")) : cleaned,
      protocol: url.protocol,
    })
  } catch {
    // URL 解析失败则返回 undefined
    return
  }
}

// 解析远程仓库引用；非法或本地引用时直接抛错
export function parseRemote(input: string): RemoteReference {
  // 先做宽松解析
  const reference = parse(input)
  // 完全无法解析时抛出非法引用错误
  if (!reference) {
    throw new InvalidReferenceError({
      repository: input,
      message: "Repository must be a git URL, host/path reference, or GitHub owner/repo shorthand",
    })
  }
  // 本地文件仓库不受支持
  if (!isRemote(reference)) {
    throw new UnsupportedLocalRepositoryError({
      repository: input,
      message: "Local file repositories are not supported",
    })
  }
  // 返回远程引用
  return reference
}

// 校验分支名合法性：仅允许字母数字与 / _ . -，且不能以 - 开头或包含 ..
export function validateBranch(branch: string): void {
  // 满足全部规则则通过
  if (/^[A-Za-z0-9/_.-]+$/.test(branch) && !branch.startsWith("-") && !branch.includes("..")) return
  // 否则抛出非法分支错误
  throw new InvalidBranchError({
    branch,
    message: "Branch must contain only alphanumeric characters, /, _, ., and -, and cannot start with - or contain ..",
  })
}

// 类型守卫：判断引用是否为本地文件引用
export function isFile(reference: Reference): reference is FileReference {
  return reference.protocol === "file:"
}

// 类型守卫：判断引用是否为远程引用
export function isRemote(reference: Reference): reference is RemoteReference {
  return !isFile(reference)
}

/**
 * Checkouts are keyed by remote and branch: a branch-specific reference gets
 * its own directory so branchless refreshes can never move it. The branch is
 * percent-encoded because valid branch names may contain `/`.
 */
// 计算缓存检出路径：按远程与分支键控；带分支的引用拥有独立目录，
// 分支名做百分号编码，因为合法分支名可能包含 “/”
export function cachePath(root: string, reference: Reference, branch?: string): string {
  // 基础路径 = 根目录 + 主机（按冒号拆为多级目录）+ 各路径段
  const base = path.join(root, ...reference.host.split(":"), ...reference.segments)
  // 带分支时追加 @<编码后的分支名>
  return branch ? `${base}@${encodeURIComponent(branch)}` : base
}

// 缓存身份标识：host/path，用于比较两个引用是否指向同一仓库
export function cacheIdentity(reference: Reference): string {
  return `${reference.host}/${reference.path}`
}

// 判断两个引用是否指向同一仓库（按缓存身份比较）
export function same(left: Reference, right: Reference): boolean {
  return cacheIdentity(left) === cacheIdentity(right)
}

// 清理输入：去首尾空白、去 git+ 前缀、去 #fragment、去尾部斜杠
function normalizeInput(input: string) {
  return input
    .trim()
    .replace(/^git\+/, "")
    .replace(/#.*$/, "")
    .replace(/\/+$/, "")
}

// 去除末尾的 .git 后缀
function trimGitSuffix(input: string) {
  return input.replace(/\.git$/, "")
}

// 按斜杠拆分路径段：去空白、去 .git 后缀、过滤空段
function parts(input: string) {
  return input
    .split("/")
    .map((item) => trimGitSuffix(item.trim()))
    .filter(Boolean)
}

// cachePath makes each `:`-separated host part a directory.
// 主机名安全性检查：非空、不以 - 开头，且每个冒号分段都安全
function safeHost(input: string) {
  return Boolean(input) && !input.startsWith("-") && input.split(":").every(safeSegment)
}

// 单个路径段安全检查：不能是 . 或 ..、不含冒号、不含空白与斜杠
function safeSegment(input: string) {
  return input !== "." && input !== ".." && !input.includes(":") && !/[\s/\\]/.test(input)
}

// 判断字符串是否“形似主机名”：含点或冒号，或恰为 localhost
function hostLike(input: string) {
  return input.includes(".") || input.includes(":") || input === "localhost"
}

// 确保字符串以斜杠结尾（用于拼接基址 URL）
function withSlash(input: string) {
  return input.endsWith("/") ? input : `${input}/`
}

// 生成 github.com 的克隆 URL；可通过环境变量覆盖克隆基址
function githubRemote(pathname: string) {
  // 读取可选的克隆基址环境变量
  const base = process.env.OPENCODE_REPO_CLONE_GITHUB_BASE_URL
  // 未配置时使用官方 github.com 地址
  if (!base) return `https://github.com/${pathname}.git`
  // 配置了基址则以该基址拼接相对路径
  return new URL(`${pathname}.git`, withSlash(base)).href
}

// 构建远程引用对象；主机或路径段不安全时返回 undefined
function buildRemote(input: { host: string; segments: string[]; remote?: string; protocol?: string }) {
  // 规范化路径段：去 .git 后缀并过滤空段
  const segments = input.segments.map(trimGitSuffix).filter(Boolean)
  // 主机或任一路径段不安全（可能造成目录穿越）时拒绝
  if (!safeHost(input.host) || !segments.length || segments.some((segment) => !safeSegment(segment))) return
  // 拼接仓库路径
  const repositoryPath = segments.join("/")
  // 主机名统一小写
  const host = input.host.toLowerCase()
  // 返回远程引用
  return {
    host,
    path: repositoryPath,
    segments,
    // 恰好两段时才有 owner 概念
    owner: segments.length === 2 ? segments[0] : undefined,
    // 仓库名取最后一段
    repo: segments[segments.length - 1],
    // 远程 URL：优先显式传入；github.com 用专用生成器；否则按 https 规范拼接
    remote:
      input.remote ?? (host === "github.com" ? githubRemote(repositoryPath) : `https://${host}/${repositoryPath}.git`),
    // 展示标签：github 两段式直接用 owner/repo，否则带主机前缀
    label: host === "github.com" && segments.length === 2 ? repositoryPath : `${host}/${repositoryPath}`,
    protocol: input.protocol,
  } satisfies RemoteReference
}

// 构建本地文件引用对象；路径为空时返回 undefined
function buildFile(input: { url: URL; remote: string }) {
  // 将 file:// URL 转为规范化的本地文件路径
  const filePath = path.normalize(fileURLToPath(input.url))
  // 按斜杠/反斜杠拆分路径段并过滤空段
  const segments = filePath.split(/[\\/]+/).filter(Boolean)
  // 无有效路径段则失败
  if (!segments.length) return
  // 返回文件引用
  return {
    host: "file",
    path: filePath,
    // 各段去掉结尾冒号（Windows 盘符兼容）
    segments: segments.map((segment) => segment.replace(/:$/, "")),
    // 本地引用没有 owner
    owner: undefined,
    // 仓库名取最后一段并去 .git 后缀
    repo: trimGitSuffix(segments[segments.length - 1]),
    // 保留原始输入作为远程标识
    remote: input.remote,
    // 标签即本地路径
    label: filePath,
    protocol: "file:",
  } satisfies FileReference
}

// 将本模块以命名空间形式导出为 Repository
export * as Repository from "./repository.js"
