// which 库：在 PATH 中查找可执行文件
import whichPkg from "which"
// Node 路径工具（Windows 分隔符等）
import path from "path"
// Node 文件系统：存在性与符号链接检查
import { existsSync, lstatSync } from "fs"

// 在给定（或当前进程）环境中查找命令的完整路径
export function which(cmd: string, env?: NodeJS.ProcessEnv, bin?: string) {
  // 取搜索的 PATH：优先传入 env，其次当前进程；兼容大小写两种键名
  const base = env?.PATH ?? env?.Path ?? process.env.PATH ?? process.env.Path ?? ""
  // 拼接附加目录 bin：有 base 时用分隔符追加，否则单独使用
  const full = base && bin ? base + path.delimiter + bin : base || bin
  // 执行同步查找（找不到不抛错），失败时再尝试 Windows 应用执行别名
  return (
    whichPkg.sync(cmd, {
      // 找不到时返回 null 而不是抛错
      nothrow: true,
      // 使用的搜索路径
      path: full,
      // Windows 可执行扩展名（PATHEXT）
      pathExt: env?.PATHEXT ?? env?.PathExt ?? process.env.PATHEXT ?? process.env.PathExt,
    }) ?? appExecutionAlias(cmd, full)
  )
}

// Microsoft Store apps, such as PowerShell 7, put app execution aliases in WindowsApps on PATH. They launch like
// any executable, but stat rejects them with EACCES, so `which` skips them.
// 判断文件是否为 Windows 应用执行别名（App Execution Alias）：
// 是符号链接但按普通可执行文件可启动
export function isAppExecutionAlias(file: string) {
  return (
    // 仅 Windows 平台
    process.platform === "win32" &&
    // 是符号链接（文件不存在时 lstat 返回 undefined）
    lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink() === true &&
    // 且目标真实存在
    existsSync(file)
  )
}

// 在搜索路径中查找命令对应的 Windows 应用执行别名
function appExecutionAlias(cmd: string, search: string | undefined) {
  // 仅 Windows、有搜索路径、且命令是纯文件名（不含目录）时才处理
  if (process.platform !== "win32" || !search || path.win32.dirname(cmd) !== ".") return null
  // 命令已带 .exe 后缀则直接用，否则补上 .exe
  const name = path.win32.extname(cmd).toLowerCase() === ".exe" ? cmd : cmd + ".exe"
  return (
    search
      // 按分隔符拆出各目录
      .split(path.win32.delimiter)
      // 过滤空段
      .filter(Boolean)
      // 拼出每个目录下的候选路径（去掉路径两侧可能的引号）
      .map((dir) => path.win32.join(dir.replace(/^"(.*)"$/, "$1"), name))
      // 取第一个符合应用执行别名特征的候选
      .find(isAppExecutionAlias) ?? null
  )
}
