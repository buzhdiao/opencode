// 导入 Node 的 os 模块（获取用户主目录）
import os from "os"
// 导入 Node 的 path 模块（路径解析与比较）
import path from "path"

// 缓存当前用户的主目录路径
const home = os.homedir()

// isHome：判断给定目录是否就是用户主目录本身
export function isHome(directory: string) {
  // 两侧都做 resolve 归一化后比较，避免相对路径/斜杠差异造成误判
  return path.resolve(directory) === path.resolve(home)
}

// macOS 上主目录下不应被扫描的常见子目录名（媒体、下载、文档等）
const DARWIN_HOME = [
  "Music",
  "Pictures",
  "Movies",
  "Downloads",
  "Desktop",
  "Documents",
  "Public",
  "Applications",
  "Library",
]

// Windows 上主目录下不应被扫描的常见子目录名（AppData 等）
const WIN32_HOME = ["AppData", "Downloads", "Desktop", "Documents", "Pictures", "Music", "Videos", "OneDrive"]

// 扫描主目录时应跳过的目录基名集合。
/** Directory basenames to skip when scanning the home directory. */
export function names(): ReadonlySet<string> {
  // 按平台返回对应列表；其他平台没有预置名单
  if (process.platform === "darwin") return new Set(DARWIN_HOME)
  if (process.platform === "win32") return new Set(WIN32_HOME)
  return new Set()
}

// 以命名空间形式整体导出本模块
export * as Protected from "./protected.js"
