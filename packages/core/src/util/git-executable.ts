// Node 文件系统：存在性检查与真实路径解析
import { existsSync, realpathSync } from "node:fs"
// Node 路径工具
import path from "path"
// 惰性求值工具
import { lazy } from "./lazy.js"
// which 命令查找工具
import { which } from "./which.js"

// macOS 上系统自带的 git 垫片（shim）路径
const darwinShim = "/usr/bin/git"
// Xcode 命令行工具选择的符号链接位置
const xcodeSelectLink = "/var/db/xcode_select_link"

// macOS 默认的开发者目录列表
const defaultDeveloperDirs = [
  // Xcode.app 内的开发者目录
  "/Applications/Xcode.app/Contents/Developer",
  // 独立安装的命令行工具目录
  "/Library/Developer/CommandLineTools",
]

// 读取符号链接的真实指向；不存在或读取失败返回 null
function readXcodeSelectLink(link: string) {
  // 链接不存在直接返回 null
  if (!existsSync(link)) return null
  // 解析真实路径，失败兜底
  try {
    // 返回解析后的真实路径
    return realpathSync(link)
  } catch {
    // 任何异常都按"无链接"处理
    return null
  }
}

// 计算 macOS 的开发者目录优先级列表（可用 DEVELOPER_DIR 覆盖，便于测试注入）
export function darwinDeveloperDirs(
  // 环境变量 DEVELOPER_DIR（去除首尾空白）
  developerDir = process.env.DEVELOPER_DIR?.trim(),
  // 读链接函数（默认读 xcode_select 链接，测试可替换）
  readLink: (link: string) => string | null = readXcodeSelectLink,
) {
  // 显式设置了 DEVELOPER_DIR 时只用该目录
  if (developerDir) return [developerDir]
  // 读取 xcode_select 链接指向的目录
  const selected = readLink(xcodeSelectLink)
  // 有链接时把链接目录放在默认目录之前；否则只用默认目录
  return selected ? [selected, ...defaultDeveloperDirs] : defaultDeveloperDirs
}

// 解析可用的 git 可执行文件路径
export function resolveGitExecutable(
  // 当前操作系统平台
  platform: NodeJS.Platform,
  // which 查到的 git 路径（可能为 null）
  resolved: string | null,
  // 可注入的选项（目录列表/存在性检查，便于测试）
  options?: {
    developerDirs?: readonly string[]
    exists?: (file: string) => boolean
  },
) {
  // Windows：有解析路径就取绝对路径，否则依赖 PATH 中的 git
  if (platform === "win32") return resolved ? path.resolve(resolved) : "git"
  // 非 macOS 或没找到 git：直接用 PATH 中的 git
  if (platform !== "darwin" || !resolved) return "git"
  // macOS：把找到的路径规范化为 POSIX 绝对路径
  const full = path.posix.resolve(resolved)
  // 不是系统垫片路径则直接使用
  if (full !== darwinShim) return full
  // 命中的是 /usr/bin/git 垫片（可能不带开发者目录），改从开发者目录中找真实 git
  // 存在性检查函数（默认 existsSync）
  const exists = options?.exists ?? existsSync
  // 开发者目录列表（默认按 darwinDeveloperDirs 计算）
  const dirs = options?.developerDirs ?? darwinDeveloperDirs()
  // 在各目录下找 usr/bin/git，排除垫片自身，找不到则回退 PATH 中的 git
  return (
    dirs
      // 只保留非空且为 POSIX 绝对路径的目录
      .filter((dir) => Boolean(dir) && path.posix.isAbsolute(dir))
      // 拼出候选 git 路径
      .map((dir) => path.posix.join(dir, "usr/bin/git"))
      // 取第一个既不是垫片又真实存在的候选
      .find((candidate) => candidate !== darwinShim && exists(candidate)) ?? "git"
  )
}

// 惰性解析当前进程实际使用的 git 可执行文件（首次调用时计算并缓存）
export const gitExecutable = lazy(() =>
  resolveGitExecutable(
    // 当前平台
    process.platform,
    // Windows/macOS 上先 which 查找 git，其它平台无需解析
    process.platform === "win32" || process.platform === "darwin" ? which("git") : null,
  ),
)
