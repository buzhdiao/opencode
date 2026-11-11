#!/usr/bin/env bun
// node-pty 权限修复脚本，对应 package.json 的 `fix-node-pty`。
// 由根 package.json 的 postinstall 在每次安装依赖后调用（`bun run --cwd packages/core fix-node-pty`）：
// npm 包 @lydell/node-pty 的 prebuilds 里自带的 spawn-helper 帮助可执行文件可能丢失执行位，
// 本脚本补上权限，否则 macOS/Linux 上 PTY 无法启动子进程。

// 导入 fs/promises：读取目录与修改文件权限
import fs from "fs/promises"
// 导入 path：拼接 node-pty prebuilds 目录路径
import path from "path"
// 导入 fileURLToPath：把 import.meta.url 转为文件路径，定位脚本所在目录
import { fileURLToPath } from "url"

// 本脚本的文件绝对路径
const __filename = fileURLToPath(import.meta.url)
// 本脚本所在目录（packages/core/script）
const __dirname = path.dirname(__filename)
// 包根目录（packages/core）
const dir = path.resolve(__dirname, "..")

// 仅 Unix 类系统需要处理；Windows 没有可执行位概念
if (process.platform !== "win32") {
  // node-pty 的预编译产物目录：node_modules/node-pty/prebuilds/<平台>/spawn-helper
  const root = path.join(dir, "node_modules", "node-pty", "prebuilds")
  // 列出 prebuilds 下所有平台子目录；目录不存在时（如未安装依赖）静默跳过
  const dirs = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  // 收集每个平台子目录下 spawn-helper 的完整路径
  const files = dirs.filter((x) => x.isDirectory()).map((x) => path.join(root, x.name, "spawn-helper"))
  // 逐个检查并修复权限，收集实际修复过的文件
  const result = await Promise.all(
    files.map(async (file) => {
      // stat 失败（spawn-helper 不存在）则跳过该平台
      const stat = await fs.stat(file).catch(() => undefined)
      if (!stat) return
      // 三个执行位（用户/组/其他，0o111）都已具备则无需修复
      if ((stat.mode & 0o111) === 0o111) return
      // 补上 0o755（rwxr-xr-x）：在原权限基础上加执行位
      await fs.chmod(file, stat.mode | 0o755)
      // 返回路径表示该文件被修复
      return file
    }),
  )
  // 过滤掉未修复（undefined）的项
  const fixed = result.filter(Boolean)
  // 有修复时打印一条摘要日志
  if (fixed.length) {
    console.log(`fixed node-pty permissions for ${fixed.length} helper${fixed.length === 1 ? "" : "s"}`)
  }
}
