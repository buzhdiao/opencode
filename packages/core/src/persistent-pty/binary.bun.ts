// 引入 Node 的 crypto 模块（用于计算 SHA-256 校验和）
import { createHash } from "node:crypto"
// 引入 Node 的文件系统 Promise API：chmod（改权限）、lstat（不跟随符号链接的 stat）、mkdir（建目录）、open（打开文件）、readFile（读文件）、rename（重命名）、rm（删除）
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises"
// 引入 Node 的 path 模块（跨平台路径拼接）
import path from "node:path"
// 引入内嵌的 PTY 原生二进制资源（构建期注入：可能为空、路径字符串或内嵌数据对象）
import asset from "./pty-binding.js"

// 标记当前运行时（Bun）下持久化 PTY 可用
export const available = true

// 解析 opencode-pty 二进制的可执行路径
export async function resolveBinary(bin: string) {
  // 环境变量显式指定时优先使用
  if (process.env.OPENCODE_PTY_BIN) return process.env.OPENCODE_PTY_BIN
  // 没有内嵌资源时，回退到 PATH 中的 opencode-pty 命令
  if (!asset) return "opencode-pty"
  // 资源是路径字符串时直接使用该路径
  if (typeof asset === "string") return asset
  // 资源是内嵌二进制数据时，安装（解包）到本地缓存目录
  return install(bin, asset)
}

// 把内嵌的 opencode-pty 二进制安装到 bin 根目录下（按"版本+校验和前缀"分目录缓存）
async function install(
  bin: string,
  input: { readonly path: string; readonly version: string; readonly sha256: string },
) {
  // 安装根目录：<bin>/opencode-pty
  const root = path.join(bin, "opencode-pty")
  // 确保根目录存在且权限安全（仅当前用户可访问）
  await privateDirectory(root)
  // 缓存目录：以版本号 + 校验和前 16 位命名，不同构建互不干扰
  const directory = path.join(root, `${input.version}-${input.sha256.slice(0, 16)}`)
  // 确保缓存目录存在且权限安全
  await privateDirectory(directory)
  // Windows only launches executables with their extension.
  // 目标文件路径：Windows 必须带 .exe 扩展名才能作为可执行文件启动
  const destination = path.join(directory, process.platform === "win32" ? "opencode-pty.exe" : "opencode-pty")
  // 目标已存在且校验通过时，直接复用缓存，无需安装
  if (await validateIfPresent(destination, input.sha256)) return destination

  // 读取内嵌二进制数据为字节数组
  const bytes = new Uint8Array(await Bun.file(input.path).arrayBuffer())
  // 校验内嵌数据的 SHA-256，不匹配说明构建产物损坏，直接报错
  if (sha256(bytes) !== input.sha256) throw new Error("Embedded opencode-pty checksum mismatch")
  // 先写入临时文件（带进程号与随机数，避免并发冲突）
  const temporary = path.join(directory, `opencode-pty.${process.pid}.${crypto.randomUUID()}.tmp`)
  try {
    // 以独占模式（wx）创建临时文件，权限 0700（仅属主可读写执行）
    const file = await open(temporary, "wx", 0o700)
    try {
      // 写入全部字节
      await file.writeFile(bytes)
      // 强制刷盘（fsync），确保数据落盘后再改名
      await file.sync()
    } finally {
      // 无论成功与否都关闭文件句柄
      await file.close()
    }
    // 改为 0755 权限，使其可执行
    await chmod(temporary, 0o755)
    // 原子改名为目标文件；若改名失败，先检查是否是并发安装已完成（校验通过则忽略错误）
    await rename(temporary, destination).catch(async (error) => {
      if (!(await validateIfPresent(destination, input.sha256))) throw error
    })
  } finally {
    // 清理残留的临时文件（成功改名后 rm 一个不存在的路径也无害）
    await rm(temporary, { force: true })
  }
  // 最后再校验一次目标文件并返回路径
  return validate(destination, input.sha256)
}

// 创建/检查一个"私有"目录：仅当前用户可访问，且必须是真实目录而非符号链接
async function privateDirectory(directory: string) {
  // 递归创建目录，权限 0700
  await mkdir(directory, { recursive: true, mode: 0o700 })
  // 用 lstat 检查目录本身（不跟随符号链接）
  const info = await lstat(directory)
  // 不是目录或是指向别处的符号链接都视为不安全，防止路径劫持
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe opencode-pty directory: ${directory}`)
  // 平台支持 getuid 时，校验目录属主是当前用户
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined
  if (uid !== undefined && info.uid !== uid)
    throw new Error(`opencode-pty directory is owned by another user: ${directory}`)
  // 再次收紧权限到 0700，防止目录被预先放宽
  await chmod(directory, 0o700)
}

// 若目标文件已存在则校验它：通过返回 true，缺失返回 false，其他错误向上抛
async function validateIfPresent(file: string, expected: string) {
  try {
    // 执行完整校验（类型/属主/校验和）
    await validate(file, expected)
    // 校验通过：文件可用
    return true
  } catch (error) {
    // 文件不存在（ENOENT）视为"未安装"，返回 false 等待安装
    if (isMissing(error)) return false
    // 其他错误（损坏、属主不对等）直接抛出
    throw error
  }
}

// 校验一个已存在的 opencode-pty 可执行文件：类型安全 + 属主校验 + SHA-256 校验
async function validate(file: string, expected: string) {
  // 用 lstat 检查文件本身（不跟随符号链接）
  const info = await lstat(file)
  // 不是普通文件或是指向别处的符号链接都视为不安全
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Unsafe opencode-pty executable: ${file}`)
  // 平台支持 getuid 时，校验文件属主是当前用户
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined
  if (uid !== undefined && info.uid !== uid)
    throw new Error(`opencode-pty executable is owned by another user: ${file}`)
  // 重新计算文件内容的 SHA-256，与期望值不符说明缓存被篡改或损坏
  if (sha256(await readFile(file)) !== expected) throw new Error(`Cached opencode-pty checksum mismatch: ${file}`)
  // 确保可执行权限为 0755
  await chmod(file, 0o755)
  // 返回通过校验的文件路径
  return file
}

// 计算字节数组的 SHA-256 十六进制摘要
function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex")
}

// 判断错误是否为"文件不存在"（Node 的 ENOENT 错误码）
function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}
