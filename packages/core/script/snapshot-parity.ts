/**
 * Differential corpus for the snapshot engine. Run the same file from two worktrees
 * and compare the JSON: tree IDs, changed-file lists, diffs, and post-restore
 * worktree digests must be byte-identical.
 *
 *   bun run script/snapshot-parity.ts <result.json> [scenario...]
 */
// （上方英文文档注释原样保留：快照引擎的差分语料库。在两个工作树里各跑一遍本文件，比较 JSON：
// 树 ID、变更文件列表、diff 与恢复后的 worktree 摘要必须逐字节一致。
// 用法：`bun run script/snapshot-parity.ts <结果.json> [场景名...]`。）
// 用途：改动快照引擎（src/snapshot 等）前后各产出一份结果 JSON，用 script/snapshot-parity-compare.ts
// 对比，即可发现行为回归出现在哪个场景的哪一步；输出对所有 git 环境差异（见 variants）也保持确定性。
// 导入 Bun 的模板字符串 shell（$）：驱动 git 与 find 命令
import { $ } from "bun"
// 导入 crypto：计算内容/补丁的 SHA-1 摘要（结果确定性化，补丁文本本身不入 JSON）
import crypto from "crypto"
// 导入 fs/promises：文件与目录操作
import fs from "fs/promises"
// 导入 os：取系统临时目录
import os from "os"
// 导入 path：拼接各路径
import path from "path"
// 导入 Effect 栈：Layer 组合、Logger 静默、ManagedRuntime 承载快照服务运行时
import { Effect, Layer, Logger, ManagedRuntime } from "effect"
// 导入 AppNodeBuilder：组装快照服务的应用层
import { AppNodeBuilder } from "../src/effect/app-node-builder"
// 导入 Location：目录引用（快照绑定目录）
import { Location } from "../src/location"
// 导入路径品牌类型：AbsolutePath 绝对路径、RelativePath 相对路径
import { AbsolutePath, RelativePath } from "../src/schema"
// 导入 Snapshot：被差分测试的快照服务
import { Snapshot } from "../src/snapshot"
// 导入 Global 服务：全局目录（指向本次运行的数据目录）
import { Global } from "@opencode/util/global"

// 语料库工作根：可用 SNAPSHOT_BENCH_ROOT 覆盖（与 perf/snapshot.ts 共用变量名），默认系统临时目录
const root = path.join(process.env.SNAPSHOT_BENCH_ROOT ?? os.tmpdir(), "opencode-snapshot-parity")

// User-level Git configuration reaches every snapshot command, so the corpus runs under several.
// （上方英文注释原样保留：用户级 git 配置会波及每条快照命令，所以语料库要在多种配置下各跑一遍。）
// git 全局配置变体：变体名 → 写入临时 gitconfig 的内容（undefined 表示用机器真实配置，即 user 档）
const variants: Record<string, string | undefined> = {
  // user：不覆盖——用运行机器的真实全局配置（默认档）
  user: undefined,
  // empty：空的 gitconfig
  empty: "",
  // split index：启用分裂索引（index.lock 并行写优化路径）
  "split index": "[core]\n\tsplitIndex = true\n",
  // skip hash + manyFiles：add 时跳过对象哈希、开启大仓库特性
  "skip hash": "[index]\n\tskipHash = true\n[feature]\n\tmanyFiles = true\n",
  // autocrlf 换行转换 + 关闭未跟踪缓存
  "autocrlf and no untracked cache": "[core]\n\tautocrlf = true\n\tuntrackedCache = false\n",
  // fsmonitor：启用文件系统监视器钩子
  fsmonitor: "[core]\n\tfsmonitor = true\n",
  // 模板目录：init 时套用模板（含钩子与排除规则，见下面 TEMPLATE 占位符替换）
  "template hook": "[init]\n\ttemplateDir = TEMPLATE\n",
}
// 本轮跑哪个变体：环境变量 PARITY_CONFIG 指定，默认 user（完整语料库要每个变体各跑一遍）
const variant = process.env.PARITY_CONFIG ?? "user"
// user 档（值为 undefined）不做任何覆盖；其余变体生成临时 gitconfig 与模板
if (variants[variant] !== undefined) {
  // 确保工作根存在
  await fs.mkdir(root, { recursive: true })
  // 本进程专用的 git 模板目录（带进程号避免并行冲突）
  const template = path.join(root, `template-${process.pid}`)
  // 建模板的 hooks 子目录
  await fs.mkdir(path.join(template, "hooks"), { recursive: true })
  // 放一个 post-checkout 钩子：检出时往 .hooklog 写一行（测模板钩子在快照链路里不产生分歧）
  await fs.writeFile(path.join(template, "hooks", "post-checkout"), '#!/bin/sh\necho "checkout $3" > .hooklog\n', {
    mode: 0o755,
  })
  // Stores are created with `git init`, so template ignore rules must keep applying to them.
  // （上方英文注释原样保留：快照存储是用 `git init` 建的，所以模板里的忽略规则必须继续对它们生效。）
  // 建模板的 info 子目录
  await fs.mkdir(path.join(template, "info"), { recursive: true })
  // 模板排除规则：template-ignored/ 目录在任何模板化仓库里都被忽略（ignore rules 场景会用它）
  await fs.writeFile(path.join(template, "info", "exclude"), "template-ignored/\n")
  // 本进程专用的全局 gitconfig 路径
  const config = path.join(root, `gitconfig-${process.pid}`)
  // 写入变体内容（TEMPLATE 占位符替换为上面的模板目录）
  await fs.writeFile(config, variants[variant]!.replace("TEMPLATE", template))
  // 用 GIT_CONFIG_GLOBAL 让所有 git 子进程使用这份配置
  process.env.GIT_CONFIG_GLOBAL = config
}

// 所有 git 子进程的环境：固定作者/提交者与日期（提交哈希确定，树可比较），放开 file 协议（子模块用）
const env = {
  // 继承当前环境
  ...process.env,
  // 允许 file:// 协议（tracked submodule 场景的本地子模块）
  GIT_ALLOW_PROTOCOL: "file",
  // 固定作者名
  GIT_AUTHOR_NAME: "Parity",
  // 固定作者邮箱
  GIT_AUTHOR_EMAIL: "parity@opencode.test",
  // 固定提交者名
  GIT_COMMITTER_NAME: "Parity",
  // 固定提交者邮箱
  GIT_COMMITTER_EMAIL: "parity@opencode.test",
  // 固定作者日期
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  // 固定提交日期
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
}

// 场景上下文：场景函数可用的操作集合（每个操作都会把结果按标签记入该场景的日志）
type Context = {
  // 场景的仓库目录
  readonly dir: string
  // 写文件（文本或二进制），父目录自动创建
  readonly write: (file: string, content: string | Uint8Array) => Promise<void>
  // 删除文件/目录（递归，不存在也不报错）
  readonly remove: (file: string) => Promise<void>
  // 跑一条 git 命令（固定 core.fsmonitor=false 等确定性配置），返回 stdout
  readonly git: (args: string[], cwd?: string) => Promise<string>
  // 捕获快照并记录树 ID 与树的完整列表（location 可选：相对仓库根的子目录）
  readonly capture: (label: string, location?: string) => Promise<void>
  // 列出两棵树之间的变更文件并记录
  readonly files: (from: string, to: string) => Promise<void>
  // 对两棵树做 diff 并记录（补丁文本以 SHA-1 摘要形式记录；paths 可选过滤）
  readonly diff: (from: string, to: string, paths?: string[]) => Promise<void>
  // 执行恢复（文件 → 树 的映射）并记录结果与恢复后的 worktree 摘要
  readonly restore: (label: string, files: Record<string, string>) => Promise<void>
  // 记录当前 worktree 的递归摘要（路径/类型/权限位/内容哈希）
  readonly digest: (label: string) => Promise<void>
}

// 场景：拿到上下文、按剧本操作、可失败（失败也会记入日志参与对比）
type Scenario = (ctx: Context) => Promise<void>

// 提交辅助：全量暂存 + 允许空提交的首次/普通提交（保证两棵工作树进度一致）
const commit = async (ctx: Context, message = "initial") => {
  // 暂存全部
  await ctx.git(["add", "-A"])
  // 静默提交（无 GPG、允许空提交）
  await ctx.git(["commit", "-q", "--no-gpg-sign", "--allow-empty", "-m", message])
}

// 差分场景库：名字 → 剧本。覆盖文件系统/索引/协议的边角形态，是语料库的主体
const scenarios: Record<string, Scenario> = {
  // 基线场景：增删改文件、重复捕获、列变更、diff、恢复后再捕获
  async basic(ctx) {
    // 写入三个初始文件（根目录两个 + 子目录一个）
    await ctx.write("a.txt", "a\n")
    // 第二个根文件
    await ctx.write("b.txt", "b\n")
    // 子目录文件
    await ctx.write("dir/c.txt", "c\n")
    // 首次提交
    await commit(ctx)
    // 捕获基线树 t0
    await ctx.capture("t0")
    // 修改 a.txt
    await ctx.write("a.txt", "a2\n")
    // 删除 b.txt
    await ctx.remove("b.txt")
    // 新增 dir/new.txt
    await ctx.write("dir/new.txt", "new\n")
    // 捕获变更后的 t1
    await ctx.capture("t1")
    // 同状态重复捕获（两次结果必须一致）
    await ctx.capture("t1-again")
    // 列出 t0→t1 的变更文件
    await ctx.files("t0", "t1")
    // 对 t0→t1 做完整 diff
    await ctx.diff("t0", "t1")
    // 限定单文件路径的 diff
    await ctx.diff("t0", "t1", ["a.txt"])
    // 把三个变更路径恢复回 t0
    await ctx.restore("undo", { "a.txt": "t0", "b.txt": "t0", "dir/new.txt": "t0" })
    // 恢复后捕获 t2
    await ctx.capture("t2")
    // 比较 t0→t2（应无差异）
    await ctx.files("t0", "t2")
  },

  // 整目录重命名：20 个文件的 src/ 改名为 lib/（测目录级重命名的树差异与 diff 形态）
  async "rename directory"(ctx) {
    // 在 src/ 下写 20 个文件
    for (let i = 0; i < 20; i++) await ctx.write(`src/f${i}.ts`, `${i}\n`)
    // 提交
    await commit(ctx)
    // 捕获 t0
    await ctx.capture("t0")
    // 整目录改名 src → lib（同盘 rename）
    await fs.rename(path.join(ctx.dir, "src"), path.join(ctx.dir, "lib"))
    // 捕获 t1
    await ctx.capture("t1")
    // 列变更（应体现目录级重命名）
    await ctx.files("t0", "t1")
    // diff
    await ctx.diff("t0", "t1")
  },

  // 文件变目录：同名路径从文件变成目录（a → a/b），再恢复（类型翻转的恢复路径）
  async "file becomes directory"(ctx) {
    // a 是普通文件，另留一个无关文件
    await ctx.write("a", "file\n")
    // 无关文件（不应出现在任何变更里）
    await ctx.write("keep.txt", "keep\n")
    // 提交
    await commit(ctx)
    // 捕获 t0
    await ctx.capture("t0")
    // 删掉文件 a
    await ctx.remove("a")
    // 同名路径建为目录 a/b
    await ctx.write("a/b", "nested\n")
    // 捕获 t1
    await ctx.capture("t1")
    // 列变更
    await ctx.files("t0", "t1")
    // 恢复 a 与 a/b 回 t0（类型各异的两个键）
    await ctx.restore("undo", { a: "t0", "a/b": "t0" })
    // 捕获 t2
    await ctx.capture("t2")
  },

  // 目录变文件：d/x、d/y 删掉后 d 变成文件，再恢复整个目录
  async "directory becomes file"(ctx) {
    // d 是含两个文件的目录
    await ctx.write("d/x", "x\n")
    // 第二个成员
    await ctx.write("d/y", "y\n")
    // 提交
    await commit(ctx)
    // 捕获 t0
    await ctx.capture("t0")
    // 删掉目录 d
    await ctx.remove("d")
    // 同名路径建为普通文件
    await ctx.write("d", "file now\n")
    // 捕获 t1
    await ctx.capture("t1")
    // 列变更
    await ctx.files("t0", "t1")
    // 恢复 d/x、d/y 与 d（目录键与文件键混在一份计划里）
    await ctx.restore("undo", { "d/x": "t0", "d/y": "t0", d: "t0" })
    // 捕获 t2
    await ctx.capture("t2")
  },

  // 嵌套仓库：项目里 git init 一个子仓库并反复提交（测嵌套 .git 的捕获/列变更/diff 表现）
  async "embedded repository"(ctx) {
    // 外层仓库一个初始文件
    await ctx.write("top.txt", "top\n")
    // 提交
    await commit(ctx)
    // 捕获 t0
    await ctx.capture("t0")
    // 子目录里放一个文件
    await ctx.write("sub/inner.txt", "inner\n")
    // 在 sub/ 内 git init 出嵌套仓库
    await ctx.git(["init", "-q"], path.join(ctx.dir, "sub"))
    // 子仓库全量暂存
    await ctx.git(["add", "-A"], path.join(ctx.dir, "sub"))
    // 子仓库首次提交
    await ctx.git(["commit", "-q", "--no-gpg-sign", "-m", "inner"], path.join(ctx.dir, "sub"))
    // 捕获 t1（嵌套 .git 已存在）
    await ctx.capture("t1")
    // 改子仓库内文件
    await ctx.write("sub/inner.txt", "changed\n")
    // 捕获 t2
    await ctx.capture("t2")
    // 子仓库提交该改动
    await ctx.git(["commit", "-q", "--no-gpg-sign", "-am", "inner 2"], path.join(ctx.dir, "sub"))
    // 捕获 t3（嵌套仓库 HEAD 变了）
    await ctx.capture("t3")
    // 列 t0→t3 变更
    await ctx.files("t0", "t3")
    // diff
    await ctx.diff("t0", "t3")
  },

  // 符号链接：文件链接、目录链接、悬空链接，以及"普通文件被替换成链接"，再全部恢复
  async symlinks(ctx) {
    // 一个链接目标、一个目录（供目录链接指）、一个将被替换的普通文件
    await ctx.write("target.txt", "target\n")
    // 目录内成员
    await ctx.write("dir/inside.txt", "inside\n")
    // 将被链接替换的普通文件
    await ctx.write("plain.txt", "plain\n")
    // 提交
    await commit(ctx)
    // 捕获 t0
    await ctx.capture("t0")
    // 指向文件的链接
    await fs.symlink("target.txt", path.join(ctx.dir, "link"))
    // 指向目录的链接
    await fs.symlink("dir", path.join(ctx.dir, "dirlink"))
    // 悬空链接（目标不存在）
    await fs.symlink("missing", path.join(ctx.dir, "dangling"))
    // 删掉普通文件 plain.txt
    await ctx.remove("plain.txt")
    // 同名路径换成指向 target.txt 的链接
    await fs.symlink("target.txt", path.join(ctx.dir, "plain.txt"))
    // 捕获 t1
    await ctx.capture("t1")
    // 改链接目标的内容（链接本身未动）
    await ctx.write("target.txt", "target 2\n")
    // 捕获 t2
    await ctx.capture("t2")
    // 列变更
    await ctx.files("t0", "t2")
    // diff
    await ctx.diff("t0", "t2")
    // 全部五个路径恢复回 t0（链接/悬空/文件混合）
    await ctx.restore("undo", { link: "t0", dirlink: "t0", dangling: "t0", "plain.txt": "t0", "target.txt": "t0" })
    // 捕获 t3
    await ctx.capture("t3")
  },

  // 可执行位：chmod +x 后捕获、diff、再恢复（权限位差异与恢复）
  async "executable bit"(ctx) {
    // 一个普通脚本文件
    await ctx.write("run.sh", "echo hi\n")
    // 提交
    await commit(ctx)
    // 捕获 t0
    await ctx.capture("t0")
    // 加可执行位
    await fs.chmod(path.join(ctx.dir, "run.sh"), 0o755)
    // 捕获 t1
    await ctx.capture("t1")
    // 列变更（权限位变化应体现）
    await ctx.files("t0", "t1")
    // diff
    await ctx.diff("t0", "t1")
    // 恢复回 t0（可执行位应被还原）
    await ctx.restore("undo", { "run.sh": "t0" })
    // 捕获 t2
    await ctx.capture("t2")
  },

  // 特殊文件名：空格/重音（NFC 与 NFD）/引号/冒号/感叹号/#/方括号/星号/问号/反斜杠/制表符/换行/日文，改动后全部恢复
  async "special names"(ctx) {
    const names = [
      "with space.txt",
      "caf\u00e9.txt",
      "cafe\u0301-nfd.txt",
      'quote"s.txt',
      "-rf",
      ":colon.txt",
      "!bang.txt",
      "#hash.txt",
      "app/[slug]/page.tsx",
      "star*.txt",
      "q?.txt",
      "back\\slash.txt",
      "tab\tname.txt",
      "new\nline.txt",
      "\u65e5\u672c\u8a9e/\u30d5\u30a1\u30a4\u30eb.txt",
    ]
    // 逐个写入全部特殊名字文件
    for (const name of names) await ctx.write(name, `${name}\n`)
    // 提交
    await commit(ctx)
    // 捕获 t0
    await ctx.capture("t0")
    // 逐个改写（内容带上名字）
    for (const name of names) await ctx.write(name, `${name} changed\n`)
    // 新增一个带方括号的文件
    await ctx.write("added [x].txt", "added\n")
    // 捕获 t1
    await ctx.capture("t1")
    // 列变更
    await ctx.files("t0", "t1")
    // diff
    await ctx.diff("t0", "t1")
    // 全部文件（含新增）一次性恢复回 t0
    await ctx.restore("undo", Object.fromEntries([...names, "added [x].txt"].map((name) => [name, "t0"])))
    // 捕获 t2
    await ctx.capture("t2")
  },

  // 忽略规则：.gitignore、强制 add 的例外、.git/info/exclude 与模板排除三层规则叠加及其变化
  async "ignore rules"(ctx) {
    // .gitignore：忽略 *.log 与 build/，但白名单 keep.log
    await ctx.write(".gitignore", "*.log\nbuild/\n!keep.log\n")
    // 白名单文件
    await ctx.write("keep.log", "keep\n")
    // 被跟踪的普通文件
    await ctx.write("src/a.ts", "a\n")
    // 将被强制 add 的忽略路径文件
    await ctx.write("build/forced.txt", "forced\n")
    // 全量暂存
    await ctx.git(["add", "-A"])
    // 强制 add 忽略路径（.gitignore 的例外例外）
    await ctx.git(["add", "-f", "build/forced.txt"])
    // 提交
    await ctx.git(["commit", "-q", "--no-gpg-sign", "-m", "initial"])
    // 仓库级排除：secret/ 与 *.local
    await ctx.write(".git/info/exclude", "secret/\n*.local\n")
    // 捕获 t0
    await ctx.capture("t0")
    // 被忽略的新文件
    await ctx.write("debug.log", "ignored\n")
    // 白名单文件改动（应被跟踪）
    await ctx.write("keep.log", "keep 2\n")
    // 强制跟踪文件改动
    await ctx.write("build/forced.txt", "forced 2\n")
    // 忽略目录内新文件
    await ctx.write("build/out.js", "out\n")
    // exclude 规则命中的新文件
    await ctx.write("secret/key.txt", "key\n")
    // *.local 命中
    await ctx.write("config.local", "local\n")
    // 模板排除规则命中（变体 "template hook" 才有该规则）
    await ctx.write("template-ignored/x.txt", "template\n")
    // 被跟踪文件改动
    await ctx.write("src/a.ts", "a2\n")
    // 捕获 t1
    await ctx.capture("t1")
    // 列变更
    await ctx.files("t0", "t1")
    // diff
    await ctx.diff("t0", "t1")
    // 清空 exclude 规则
    await ctx.write(".git/info/exclude", "")
    // 捕获 t2
    await ctx.capture("t2")
    // 列 t1→t2（secret/config.local 从"不可见"变"未跟踪"）
    await ctx.files("t1", "t2")
  },

  // gitignore 变化：忽略规则本身被增删时，之前/之后的捕获与列变更如何跟随
  async "gitignore changes"(ctx) {
    // 初始：gen/ 未被忽略
    await ctx.write("gen/out.txt", "1\n")
    // 一个普通被跟踪文件
    await ctx.write("src.txt", "src\n")
    // 提交
    await commit(ctx)
    // 捕获 t0
    await ctx.capture("t0")
    // 新增忽略规则 gen/
    await ctx.write(".gitignore", "gen/\n")
    // 改 gen/out.txt（已被忽略）
    await ctx.write("gen/out.txt", "2\n")
    // 捕获 t1
    await ctx.capture("t1")
    // 列 t0→t1
    await ctx.files("t0", "t1")
    // 清空 .gitignore
    await ctx.write(".gitignore", "")
    // 捕获 t2
    await ctx.capture("t2")
    // 列 t1→t2
    await ctx.files("t1", "t2")
  },

  // 大文件：3 MiB 二进制新增/替换/缩回（大二进制对象进出树）
  async "large files"(ctx) {
    // 一个小的已跟踪二进制
    await ctx.write("tracked.bin", "small\n")
    // 提交
    await commit(ctx)
    // 捕获 t0
    await ctx.capture("t0")
    // 新增 3 MiB 二进制
    await ctx.write("big.bin", new Uint8Array(3 * 1024 * 1024).fill(7))
    // 已跟踪二进制也膨胀到 3 MiB
    await ctx.write("tracked.bin", new Uint8Array(3 * 1024 * 1024).fill(9))
    // 捕获 t1
    await ctx.capture("t1")
    // 列 t0→t1
    await ctx.files("t0", "t1")
    // big.bin 缩回小文件
    await ctx.write("big.bin", "now small\n")
    // 捕获 t2
    await ctx.capture("t2")
    // 列 t1→t2
    await ctx.files("t1", "t2")
  },

  // 换行符：.gitattributes 的 text=auto 与 CRLF 检出（eol=crlf），LF/CRLF 改写后恢复并核对 worktree 摘要
  async "line endings"(ctx) {
    // 属性行：自动换行归一 + .bat 强制 CRLF
    await ctx.write(".gitattributes", "* text=auto\n*.bat eol=crlf\n")
    // LF 文件
    await ctx.write("unix.txt", "one\ntwo\n")
    // 提交
    await commit(ctx)
    // 捕获 t0
    await ctx.capture("t0")
    // unix.txt 改成 CRLF
    await ctx.write("unix.txt", "one\r\ntwo\r\nthree\r\n")
    // .bat 以 CRLF 写入（检出形态受 eol=crlf 影响）
    await ctx.write("run.bat", "echo\r\n")
    // 捕获 t1
    await ctx.capture("t1")
    // 列变更
    await ctx.files("t0", "t1")
    // diff
    await ctx.diff("t0", "t1")
    // 两个文件恢复回 t0
    await ctx.restore("undo", { "unix.txt": "t0", "run.bat": "t0" })
    // 记录恢复后的 worktree 摘要（换行形态是否被还原）
    await ctx.digest("after-undo")
  },

  // 合并冲突：制造一个真实冲突（merge 失败被吞掉），在冲突态下捕获并列变更
  async "merge conflict in source"(ctx) {
    // 基线文件
    await ctx.write("c.txt", "base\n")
    // 提交
    await commit(ctx)
    // 开分支 other
    await ctx.git(["checkout", "-q", "-b", "other"])
    // other 分支上改 c.txt
    await ctx.write("c.txt", "other\n")
    // 提交
    await commit(ctx, "other")
    // 回到原分支
    await ctx.git(["checkout", "-q", "-"])
    // 原分支上改同一文件
    await ctx.write("c.txt", "main\n")
    // 提交
    await commit(ctx, "main")
    // 合并 other（必然冲突，失败被吞掉，留在冲突态）
    await ctx.git(["merge", "-q", "other"]).catch(() => "")
    // 冲突态下捕获 t0
    await ctx.capture("t0")
    // 解决冲突
    await ctx.write("c.txt", "resolved\n")
    // 捕获 t1
    await ctx.capture("t1")
    // 列 t0→t1
    await ctx.files("t0", "t1")
  },

  // 仅大小写重命名：Readme.md → README.md（大小写不敏感文件系统上的树一致性）
  async "case-only rename"(ctx) {
    // 初始 Readme.md
    await ctx.write("Readme.md", "readme\n")
    // 提交
    await commit(ctx)
    // 捕获 t0
    await ctx.capture("t0")
    // 仅大小写改名 → README.md
    await fs.rename(path.join(ctx.dir, "Readme.md"), path.join(ctx.dir, "README.md"))
    // 捕获 t1
    await ctx.capture("t1")
    // 列变更
    await ctx.files("t0", "t1")
    // 改 README.md 内容
    await ctx.write("README.md", "changed\n")
    // 捕获 t2
    await ctx.capture("t2")
    // 列 t0→t2
    await ctx.files("t0", "t2")
  },

  // 子目录作为 location：快照/列变更绑定在 pkg/ 子目录上，与全仓库捕获交错比对
  async "location subdirectory"(ctx) {
    // 两个子目录各一个文件
    await ctx.write("pkg/a.txt", "a\n")
    // 另一个子目录的文件（location 外）
    await ctx.write("other/b.txt", "b\n")
    // 提交
    await commit(ctx)
    // 以 pkg/ 为 location 捕获 t0（树只含该子目录视角）
    await ctx.capture("t0", "pkg")
    // pkg 内改一个、增一个，other/ 也在变
    await ctx.write("pkg/a.txt", "a2\n")
    // pkg 内新增
    await ctx.write("pkg/new.txt", "new\n")
    // other/ 内改动（pkg 视角应不可见）
    await ctx.write("other/b.txt", "b2\n")
    // 仍以 pkg/ 为 location 捕获 t1
    await ctx.capture("t1", "pkg")
    // 列 pkg 视角的 t0→t1（不含 other/ 的改动）
    await ctx.files("t0", "t1")
    // 全仓库视角捕获 t2
    await ctx.capture("t2", ".")
    // 列 t1→t2（跨 location 的树比较）
    await ctx.files("t1", "t2")
    // 回到 pkg/ 视角捕获 t3
    await ctx.capture("t3", "pkg")
    // 列 t2→t3
    await ctx.files("t2", "t3")
  },

  // 大量未跟踪文件：3 000 个未跟踪文件分 30 个目录（未跟踪扫描的成本与确定性），重复捕获比对
  async "many untracked"(ctx) {
    // 一个已提交的种子文件
    await ctx.write("seed.txt", "seed\n")
    // 提交
    await commit(ctx)
    // 生成 3 000 个未跟踪文件、分 30 个目录
    for (let i = 0; i < 3000; i++) await ctx.write(`gen/d${i % 30}/f${i}.txt`, `${i}\n`)
    // 捕获 t0
    await ctx.capture("t0")
    // 同状态重复捕获（大量未跟踪下两次结果必须一致）
    await ctx.capture("t0-again")
  },

  // 空目录与全部删除：git 不跟踪空目录——建空目录、删光内容、恢复（空目录是否复活的边界）
  async "empty directories and delete all"(ctx) {
    // 深层文件与根文件
    await ctx.write("a/b/c.txt", "c\n")
    // 根文件
    await ctx.write("d.txt", "d\n")
    // 提交
    await commit(ctx)
    // 捕获 t0
    await ctx.capture("t0")
    // 建空目录 empty/nested（git 不跟踪空目录）
    await fs.mkdir(path.join(ctx.dir, "empty/nested"), { recursive: true })
    // 捕获 t1
    await ctx.capture("t1")
    // 删掉整个 a/
    await ctx.remove("a")
    // 删掉 d.txt
    await ctx.remove("d.txt")
    // 捕获 t2
    await ctx.capture("t2")
    // 列 t0→t2
    await ctx.files("t0", "t2")
    // 恢复 a/b/c.txt 与 d.txt 回 t0
    await ctx.restore("undo", { "a/b/c.txt": "t0", "d.txt": "t0" })
    // 捕获 t3
    await ctx.capture("t3")
  },

  // 重叠路径恢复：a 与 a/b 在四种先后顺序下互相覆盖地恢复（恢复计划的顺序稳定性）
  async "restore with overlapping paths"(ctx) {
    // a 是普通文件
    await ctx.write("a", "file a\n")
    // 提交
    await commit(ctx)
    // 捕获 t0
    await ctx.capture("t0")
    // 删 a，改建成目录 a/b
    await ctx.remove("a")
    // 目录成员
    await ctx.write("a/b", "nested b\n")
    // 捕获 t1
    await ctx.capture("t1")
    // 再删掉，改回普通文件
    await ctx.remove("a")
    // 普通文件 a
    await ctx.write("a", "file again\n")
    // 捕获 t2
    await ctx.capture("t2")
    // 四种顺序互相覆盖的恢复（文件键/目录键交替先后的稳定性）
    await ctx.restore("order-1", { a: "t0", "a/b": "t0" })
    // 顺序颠倒：目录键在前
    await ctx.restore("order-2", { "a/b": "t1", a: "t1" })
    // 文件键在前（取 t1 的普通文件）
    await ctx.restore("order-3", { a: "t1", "a/b": "t1" })
    // 两键取自不同的树
    await ctx.restore("order-4", { "a/b": "t0", a: "t2" })
  },

  // 多树混合恢复：一次恢复里不同文件取自不同树（x 取 t1、y/z 取 t0、w 取 t1）
  async "restore from several trees"(ctx) {
    // 两个初始文件
    await ctx.write("x.txt", "x0\n")
    // 第二个
    await ctx.write("y.txt", "y0\n")
    // 提交
    await commit(ctx)
    // 捕获 t0
    await ctx.capture("t0")
    // 改 x、增 z
    await ctx.write("x.txt", "x1\n")
    // 新增 z
    await ctx.write("z.txt", "z1\n")
    // 捕获 t1
    await ctx.capture("t1")
    // 再改 x/y/z、增 w
    await ctx.write("x.txt", "x2\n")
    // y 改动
    await ctx.write("y.txt", "y2\n")
    // z 改动
    await ctx.write("z.txt", "z2\n")
    // 新增 w
    await ctx.write("w.txt", "w2\n")
    // 一次恢复里混合取自 t1 与 t0 的四个文件
    await ctx.restore("mixed", { "x.txt": "t1", "y.txt": "t0", "z.txt": "t0", "w.txt": "t1" })
  },

  // 暂存区状态：staged 与 worktree 内容分叉时捕获（快照只看 worktree 还是也看 index 的边界）
  async "staged changes in source"(ctx) {
    // 提交过的 a.txt
    await ctx.write("a.txt", "a\n")
    // 提交
    await commit(ctx)
    // 改 a.txt、增 new.txt 并暂存
    await ctx.write("a.txt", "staged\n")
    // 新增 new.txt
    await ctx.write("new.txt", "staged new\n")
    // 暂存
    await ctx.git(["add", "-A"])
    // worktree 里再改 a.txt（与暂存区分叉）
    await ctx.write("a.txt", "worktree\n")
    // 分叉态捕获 t0
    await ctx.capture("t0")
    // worktree 再改
    await ctx.write("a.txt", "worktree 2\n")
    // 捕获 t1
    await ctx.capture("t1")
    // 列 t0→t1
    await ctx.files("t0", "t1")
  },

  // 二进制与类型替换：二进制文件修改、普通文件被替换成指向它的符号链接再换回普通文件
  async "binary and replaced types"(ctx) {
    // 二进制文件与普通文件
    await ctx.write("img.bin", new Uint8Array([0, 1, 2, 3, 0, 255]))
    // 普通文件（稍后被换成链接）
    await ctx.write("f.txt", "file\n")
    // 提交
    await commit(ctx)
    // 捕获 t0
    await ctx.capture("t0")
    // 二进制内容变化（长度也变）
    await ctx.write("img.bin", new Uint8Array([0, 9, 9, 3, 0, 255, 1]))
    // 删掉 f.txt
    await ctx.remove("f.txt")
    // 同名换成指向 img.bin 的符号链接
    await fs.symlink("img.bin", path.join(ctx.dir, "f.txt"))
    // 捕获 t1
    await ctx.capture("t1")
    // 列变更
    await ctx.files("t0", "t1")
    // diff
    await ctx.diff("t0", "t1")
    // 删掉链接
    await ctx.remove("f.txt")
    // 换回普通文件
    await ctx.write("f.txt", "file\n")
    // 捕获 t2
    await ctx.capture("t2")
    // 列 t0→t2
    await ctx.files("t0", "t2")
  },

  // 稀疏检出：sparse-checkout 只留 in/，检出范围外的 out/ 被移除后的捕获与列变更
  async "sparse checkout source"(ctx) {
    // in/ 与 out/ 各一个文件
    await ctx.write("in/a.txt", "a\n")
    // out/ 的文件（稀疏检出后应从工作区消失）
    await ctx.write("out/b.txt", "b\n")
    // 提交
    await commit(ctx)
    // 稀疏检出：只保留 in/（out/ 从工作区移除）
    await ctx.git(["sparse-checkout", "set", "in"])
    // 捕获 t0
    await ctx.capture("t0")
    // in/ 内改一个、增一个
    await ctx.write("in/a.txt", "a2\n")
    // in/ 内新增
    await ctx.write("in/new.txt", "new\n")
    // 捕获 t1
    await ctx.capture("t1")
    // 列 t0→t1
    await ctx.files("t0", "t1")
  },

  // 不可读文件：chmod 000 的文件进出捕获（读失败时的确定性表现）
  async "unreadable file"(ctx) {
    // 一个正常文件
    await ctx.write("ok.txt", "ok\n")
    // 提交
    await commit(ctx)
    // 捕获 t0
    await ctx.capture("t0")
    // 新增文件并立刻锁成 0o000（不可读）
    await ctx.write("locked.txt", "locked\n")
    // 锁成 0o000：任何读者（含本脚本恢复时）都无法读它
    await fs.chmod(path.join(ctx.dir, "locked.txt"), 0o000)
    // 不可读态捕获 t1
    await ctx.capture("t1")
    // 恢复权限
    await fs.chmod(path.join(ctx.dir, "locked.txt"), 0o644)
    // 捕获 t2
    await ctx.capture("t2")
    // 列 t0→t2
    await ctx.files("t0", "t2")
  },

  // 尚无提交：git init 后没有任何提交的仓库（HEAD 不存在）下捕获、部分暂存、列变更
  async "no commits yet"(ctx) {
    // 尚无任何提交的仓库里写一个文件
    await ctx.write("a.txt", "a\n")
    // 捕获 t0（HEAD 不存在）
    await ctx.capture("t0")
    // 暂存 a.txt
    await ctx.git(["add", "a.txt"])
    // 再写 b.txt
    await ctx.write("b.txt", "b\n")
    // 捕获 t1（部分暂存态）
    await ctx.capture("t1")
    // 列 t0→t1
    await ctx.files("t0", "t1")
  },

  // 特殊文件：mkfifo 建的命名管道进出捕获（非普通文件的确定性处理）
  async "special files"(ctx) {
    // 一个普通文件
    await ctx.write("a.txt", "a\n")
    // 提交
    await commit(ctx)
    // 捕获 t0
    await ctx.capture("t0")
    // 建命名管道（FIFO）
    await $`mkfifo ${path.join(ctx.dir, "pipe")}`.quiet()
    // 捕获 t1
    await ctx.capture("t1")
    // 删掉管道
    await ctx.remove("pipe")
    // 捕获 t2
    await ctx.capture("t2")
    // 列 t0→t2
    await ctx.files("t0", "t2")
  },

  // 跟踪的子模块：本地仓库作为 vendor/library 子模块加入、内容提交推进（子模块树 ID 的可比性；
  // 子模块 URL 固定为相对路径，因为绝对临时路径每次运行都不同，见下方英文注释）
  async "tracked submodule"(ctx) {
    // 兄弟目录里的"上游库"仓库
    const other = path.join(path.dirname(ctx.dir), "library")
    // 建目录
    await fs.mkdir(other)
    // 初始化为 git 仓库
    await ctx.git(["init", "-q"], other)
    // 写一个文件
    await fs.writeFile(path.join(other, "lib.txt"), "lib\n")
    // 暂存
    await ctx.git(["add", "-A"], other)
    // 提交
    await ctx.git(["commit", "-q", "--no-gpg-sign", "-m", "lib"], other)
    // 以 file 协议把它加为 vendor/library 子模块
    await ctx.git(["-c", "protocol.file.allow=always", "submodule", "add", "-q", other, "vendor/library"])
    // The absolute temporary URL differs between runs; pin it so trees are comparable.
    // （上方英文注释原样保留：子模块的绝对临时 URL 两次运行不同；改写成相对路径固定下来，树才可比。）
    await ctx.git(["config", "-f", ".gitmodules", "submodule.vendor/library.url", "../library"])
    // 提交（子模块入库）
    await commit(ctx)
    // 捕获 t0
    await ctx.capture("t0")
    // 直接改子模块工作区文件
    await ctx.write("vendor/library/lib.txt", "changed\n")
    // 捕获 t1
    await ctx.capture("t1")
    // 在子仓库内提交该改动（子模块 HEAD 前进）
    await ctx.git(["commit", "-q", "--no-gpg-sign", "-am", "bump"], path.join(ctx.dir, "vendor/library"))
    // 捕获 t2
    await ctx.capture("t2")
    // 列 t0→t2
    await ctx.files("t0", "t2")
    // diff
    await ctx.diff("t0", "t2")
  },

  // 索引标志：assume-unchanged、skip-worktree、intent-to-add（add -N）三种索引标志下捕获与列变更
  async "index flags in source"(ctx) {
    // 三个普通文件
    await ctx.write("assumed.txt", "a\n")
    // skip-worktree 的对象
    await ctx.write("skipped.txt", "s\n")
    // 对照组
    await ctx.write("plain.txt", "p\n")
    // 提交
    await commit(ctx)
    // 给 assumed.txt 打 assume-unchanged（声称没变）
    await ctx.git(["update-index", "--assume-unchanged", "assumed.txt"])
    // 给 skipped.txt 打 skip-worktree（声称不关心工作区）
    await ctx.git(["update-index", "--skip-worktree", "skipped.txt"])
    // 写 intent-to-add 文件
    await ctx.write("intent.txt", "intent\n")
    // add -N：仅记录意图
    await ctx.git(["add", "-N", "intent.txt"])
    // 三种标志齐全时捕获 t0
    await ctx.capture("t0")
    // 四个文件全部改动（含打了标志的三个）
    await ctx.write("assumed.txt", "a2\n")
    // skipped.txt 改动
    await ctx.write("skipped.txt", "s2\n")
    // intent-to-add 文件改动
    await ctx.write("intent.txt", "intent 2\n")
    // 对照组改动
    await ctx.write("plain.txt", "p2\n")
    // 捕获 t1
    await ctx.capture("t1")
    // 列 t0→t1
    await ctx.files("t0", "t1")
  },

  // 恢复键拼写：大小写不同（readme.md）、目录路径、NFD 重音、./ 前缀等拼写的解析（同名文件均归一到实际路径）
  async "restore key spellings"(ctx) {
    // 四个恢复对象：大小写敏感名、目录、NFC 重音名
    await ctx.write("Readme.md", "readme\n")
    // 目录成员 a
    await ctx.write("dir/a.txt", "a\n")
    // 目录成员 b
    await ctx.write("dir/b.txt", "b\n")
    // NFC 形式的重音名
    await ctx.write("caf\u00e9.txt", "nfc\n")
    // 提交
    await commit(ctx)
    // 捕获 t0
    await ctx.capture("t0")
    // 全部改动（含新增 dir/c.txt）
    await ctx.write("Readme.md", "changed\n")
    // dir/a 改动
    await ctx.write("dir/a.txt", "a2\n")
    // dir 内新增 c
    await ctx.write("dir/c.txt", "c2\n")
    // 重音名文件改动
    await ctx.write("caf\u00e9.txt", "nfc 2\n")
    // 恢复键用小写 readme.md（大小写归一）
    await ctx.restore("case", { "readme.md": "t0" })
    // 恢复键用目录路径 dir
    await ctx.restore("directory", { dir: "t0" })
    // 恢复键用 NFD 形式的重音名（Unicode 归一）
    await ctx.restore("nfd", { "cafe\u0301.txt": "t0" })
    // 恢复键带 ./ 前缀
    await ctx.restore("dot-slash", { "./Readme.md": "t0" })
  },

  // 大批量恢复：300 个改动 + 50 个新增 + 100 个删除后，一次性把 350 个文件恢复到 t0
  async "large batched restore"(ctx) {
    // 在 7 个目录里铺 300 个文件
    for (let i = 0; i < 300; i++) await ctx.write(`src/m${i % 7}/f${i}.ts`, `export const v = ${i}\n`)
    // 提交
    await commit(ctx)
    // 捕获 t0
    await ctx.capture("t0")
    // 改动其中偶数下标的 150 个
    for (let i = 0; i < 300; i += 2) await ctx.write(`src/m${i % 7}/f${i}.ts`, `changed ${i}\n`)
    // 新增 50 个
    for (let i = 0; i < 50; i++) await ctx.write(`src/new/n${i}.ts`, `new ${i}\n`)
    // 删除 100 个（i ≡ 1 mod 3 的）
    for (let i = 1; i < 300; i += 3) await ctx.remove(`src/m${i % 7}/f${i}.ts`)
    // 捕获 t1
    await ctx.capture("t1")
    // 列 t0→t1
    await ctx.files("t0", "t1")
    // 组装大批量恢复计划：300 个原文件 + 50 个新文件全部指回 t0
    const changed = await Promise.resolve().then(async () => {
      // 计划表
      const files: Record<string, string> = {}
      // 全部 300 个
      for (let i = 0; i < 300; i++) files[`src/m${i % 7}/f${i}.ts`] = "t0"
      // 全部 50 个新文件
      for (let i = 0; i < 50; i++) files[`src/new/n${i}.ts`] = "t0"
      // 返回计划
      return files
    })
    // 一次性恢复 350 个文件
    await ctx.restore("all", changed)
    // 捕获 t2
    await ctx.capture("t2")
    // 列 t0→t2（应无差异）
    await ctx.files("t0", "t2")
  },

  // 被文件挡住的恢复：a 已从目录变成文件，恢复 a/b.txt 会被它挡住（报错路径的确定性）
  async "restore blocked by a file"(ctx) {
    // a 是目录（含 b.txt），z.txt 正常
    await ctx.write("a/b.txt", "b\n")
    // 普通文件 z
    await ctx.write("z.txt", "z\n")
    // 提交
    await commit(ctx)
    // 捕获 t0
    await ctx.capture("t0")
    // 删掉目录 a
    await ctx.remove("a")
    // 同名换成普通文件（挡住 a/b.txt 的恢复）
    await ctx.write("a", "now a file\n")
    // 改 z.txt
    await ctx.write("z.txt", "z2\n")
    // 恢复 a/b.txt（会被文件 a 挡住）与 z.txt
    await ctx.restore("blocked", { "a/b.txt": "t0", "z.txt": "t0" })
  },

  // 带模式字符的 location：app/[id] 这种含 glob 字符的目录作为快照绑定目录
  async "location with pattern characters"(ctx) {
    // app/[id]（方括号是 glob 模式字符）与 app/i 各一个文件
    await ctx.write("app/[id]/page.tsx", "page\n")
    // 普通目录 app/i 的文件（不应被 [id] 模式吞掉）
    await ctx.write("app/i/other.tsx", "other\n")
    // 提交
    await commit(ctx)
    // 以 app/[id] 为 location 捕获 t0（路径须按字面量而非模式处理）
    await ctx.capture("t0", "app/[id]")
    // 两个目录各改一个文件
    await ctx.write("app/[id]/page.tsx", "page 2\n")
    // app/i 改动（location 外）
    await ctx.write("app/i/other.tsx", "other 2\n")
    // 仍以 app/[id] 为 location 捕获 t1
    await ctx.capture("t1", "app/[id]")
    // 列 t0→t1（只应含 app/[id] 内的改动）
    await ctx.files("t0", "t1")
  },

  // 两侧都不存在的恢复路径：恢复计划里出现从未存在/稍后才出现的文件（恢复对缺失路径的宽容度）
  async "restore paths absent from both sides"(ctx) {
    // 一个普通文件
    await ctx.write("a.txt", "a\n")
    // 提交
    await commit(ctx)
    // 捕获 t0
    await ctx.capture("t0")
    // 恢复从未存在过的路径（t0 里也没有）
    await ctx.restore("missing", { "never.txt": "t0", "gone/deep/x.txt": "t0" })
    // 新增 later.txt（t0 里没有）
    await ctx.write("later.txt", "later\n")
    // 用 t0 恢复它（t0 里没有该文件 → 应被删除）
    await ctx.restore("remove-later", { "later.txt": "t0" })
  },
}

// 跑一个场景：建独立工作区 → 构造上下文 → 执行剧本 → 收集日志 → 清理。返回逐步日志（进结果 JSON）
async function run(name: string, scenario: Scenario) {
  // 本场景的隔离工作区：真实路径解析（同 snapshot.ts 的 macOS 处理）
  const base = await fs.realpath(await fs.mkdtemp(path.join(root, "case-")))
  // 场景仓库目录
  const dir = path.join(base, "project")
  // 快照数据目录（存储所在）
  const data = path.join(base, "data")
  // 建仓库目录
  await fs.mkdir(dir, { recursive: true })
  // git 命令封装：关 fsmonitor、关 splitIndex（与 variants 的 split index 区分：这里是命令级稳定配置）、
  // 默认分支 main；固定 env（作者/日期）；静默执行返回 stdout
  const git = (args: string[], cwd = dir) =>
    $`git -c core.fsmonitor=false -c core.splitIndex=false -c init.defaultBranch=main ${args}`
      .cwd(cwd)
      .env(env)
      .quiet()
      .text()
  // 初始化场景仓库
  await git(["init", "-q"])
  // 本场景的逐步日志：每个操作一条记录，两份结果 JSON 逐条对比
  const log: unknown[] = []
  // 标签 → 捕获到的树 ID（捕获失败记 undefined，后续引用它的操作会跳过并记录 skipped）
  const trees = new Map<string, Snapshot.ID | undefined>()
  // One long-lived runtime per Location, as in production, so in-process caches are exercised.
  // （上方英文注释原样保留：每个 Location 一个长驻运行时——与生产一致，从而真正考验进程内缓存。）
  // location 相对路径 → 其专属运行时（"." 与 "pkg" 等子目录各有各的运行时）
  const runtimes = new Map<string, ManagedRuntime.ManagedRuntime<Snapshot.Service, never>>()
  // 取（或建）某个 location 的运行时：快照层绑定到 dir/location，日志静默
  const runtime = (location = ".") => {
    // 已有则复用
    const existing = runtimes.get(location)
    // 命中缓存：直接返回该 location 的运行时
    if (existing) return existing
    // 新建长驻运行时
    const created = ManagedRuntime.make(
      Layer.provide(snapshotLayer(data, path.join(dir, location)), Logger.layer([])) as Layer.Layer<Snapshot.Service>,
    )
    // 登记复用
    runtimes.set(location, created)
    // 返回新建的运行时
    return created
  }
  // 在指定 location 的运行时里跑一段快照操作：失败不抛——归一成 { error: true } 参与对比
  const use = <A>(location: string | undefined, body: (snapshot: Snapshot.Interface) => Effect.Effect<A, unknown>) =>
    runtime(location)
      .runPromise(
        Effect.gen(function* () {
          // 取快照服务并执行 body
          return yield* body(yield* Snapshot.Service)
        }).pipe(Effect.exit),
      )
      // Exit 转 plain 对象：成功 { ok: 值 }，失败 { error: true }（错误细节不进 JSON，保持两侧可对比）
      .then((exit) => (exit._tag === "Success" ? { ok: exit.value } : { error: true }))
  // 取某标签的树 ID；未捕获过则抛错（剧本写错了）
  const tree = (label: string) => {
    // 查标签对应的树 ID
    const id = trees.get(label)
    // 未捕获过（或捕获失败）：剧本引用了不存在的树，直接抛错
    if (!id) throw new Error(`no tree ${label}`)
    // 返回树 ID
    return id
  }
  // 构造场景上下文：每个操作都把结果记入 log
  const ctx: Context = {
    // 仓库目录
    dir,
    // 写文件：先建父目录再写入
    write: async (file, content) => {
      // 递归创建父目录（特殊文件名场景的路径可能带深层目录）
      await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true })
      // 写入内容（文本或二进制）
      await fs.writeFile(path.join(dir, file), content)
    },
    // 删除：递归、容忍不存在
    remove: (file) => fs.rm(path.join(dir, file), { recursive: true, force: true }),
    // git 命令
    git,
    // 捕获：在指定 location（缺省仓库根）捕获，记录树 ID 与树的完整列表（供逐字节对比）
    capture: async (label, location) => {
      // 执行捕获
      const result = await use(location, (snapshot) => snapshot.capture())
      // 树 ID（失败为 undefined）
      const id = "ok" in result ? result.ok : undefined
      // 登记标签 → 树
      trees.set(label, id)
      // 记录：树 ID + 该树在存储里的完整 ls-tree 列表（同样内容两份必须一致）
      log.push({ capture: label, tree: id ?? null, entries: id ? await listing(data, id) : null })
    },
    // 列变更：任一侧树缺失则记 skipped；否则记录 files 结果
    files: async (from, to) => {
      // 任一侧树缺失：跳过并记录（两侧 JSON 会一致地出现 skipped）
      if (!trees.get(from) || !trees.get(to)) return void log.push({ files: [from, to], skipped: true })
      // 记录列变更结果
      log.push({ files: [from, to], result: await use(undefined, (s) => s.files({ from: tree(from), to: tree(to) })) })
    },
    // diff：任一侧树缺失则记 skipped；补丁文本换成 SHA-1（补丁本身可能含平台差异细节，摘要足以比对）
    diff: async (from, to, paths) => {
      if (!trees.get(from) || !trees.get(to)) return void log.push({ diff: [from, to], skipped: true })
      // 执行 diff（paths 可选过滤）
      const result = await use(undefined, (s) =>
        s.diff({ from: tree(from), to: tree(to), paths: paths?.map((file) => RelativePath.make(file)) }),
      )
      // 记录：路径过滤参数 + 逐文件结果（patch 摘要化）
      log.push({
        diff: [from, to, paths ?? null],
        result:
          "ok" in result && result.ok
            ? result.ok.map((file) => ({
                ...file,
                patch: crypto.createHash("sha1").update(file.patch).digest("hex"),
              }))
            : result,
      })
    },
    // 恢复：计划 = { 相对路径 → 树 ID }；源树缺失的文件直接从计划剔除（结果同样进对比）
    restore: async (label, files) => {
      // 组装恢复计划
      const plan = new Map(
        Object.entries(files).flatMap(([file, from]) => {
          // 源树 ID（缺失则该文件不进计划）
          const id = trees.get(from)
          // 有树才收录：相对路径 → 树 ID
          return id ? [[RelativePath.make(file), id] as const] : []
        }),
      )
      // 执行恢复
      const result = await use(undefined, (s) => s.restore({ files: plan }))
      // 记录：结果（成功记 "ok"）+ 恢复后的 worktree 递归摘要
      log.push({ restore: label, result: "ok" in result ? "ok" : result, worktree: await digest(dir) })
    },
    // digest：记录当前 worktree 的递归摘要
    digest: async (label) => {
      log.push({ digest: label, worktree: await digest(dir) })
    },
  }
  // 执行剧本：失败转字符串记入日志（场景自身报错也是差分的一部分）
  const failure = await scenario(ctx).then(
    () => undefined,
    (error: unknown) => String(error),
  )
  // 有失败则追加一条
  if (failure) log.push({ scenarioError: failure })
  // 释放本场景的全部长驻运行时
  await Promise.all([...runtimes.values()].map((item) => item.dispose()))
  // 保险起见把工作区权限放开（unreadable file 场景的 0o000 文件会挡住递归删除）
  await $`chmod -R u+rwX ${base}`.quiet().nothrow()
  // PARITY_KEEP 时保留工作区供排查
  if (process.env.PARITY_KEEP) console.error(`kept ${base}`)
  // 否则删除
  if (!process.env.PARITY_KEEP) await fs.rm(base, { recursive: true, force: true })
  // 返回日志
  return log
}

// 组装快照层：Snapshot 服务绑定到指定目录，数据/配置目录都落在 data 下（无进程替换层）
function snapshotLayer(data: string, directory: string) {
  return AppNodeBuilder.build(Snapshot.node, [
    // Location 替换：绑定目录引用
    Location.node.replace(Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(directory) }))),
    // Global 替换：数据与配置目录
    Global.node.replace(Global.layerWith({ data, config: path.join(data, "config") })),
  ])
}

/** The recursive listing of a captured tree, read from whichever snapshot store holds it. */
// （上方英文文档注释原样保留：某棵已捕获树的递归列表——从持有它的那个快照存储里读取。）
// 在 data/snapshot 下的各存储里找该树，用 git ls-tree 输出完整条目（两份结果的列表必须一致）
async function listing(data: string, tree: string) {
  // 找出所有存储目录（snapshot 下两级、类型为目录）
  const stores = (await $`find ${path.join(data, "snapshot")} -mindepth 2 -maxdepth 2 -type d`.quiet().text())
    .split("\n")
    .filter(Boolean)
  // 逐个存储尝试读树
  for (const store of stores) {
    // git --git-dir <存储> ls-tree -r -z：完整递归列出树条目（NUL 分隔）；读不到继续找下一个
    const result = await $`git --git-dir ${store} ls-tree -r -z ${tree}`.quiet().nothrow()
    // 命中：按 NUL 切分返回非空条目
    if (result.exitCode === 0) return result.stdout.toString().split("\0").filter(Boolean)
  }
  // 所有存储都没有：返回 null（失败同样进对比）
  return null
}

/** Paths, types, modes, and content hashes of the worktree, excluding `.git`. */
// （上方英文文档注释原样保留：worktree 的路径、类型、权限位与内容哈希——不含 .git。）
// 递归生成 worktree 摘要：每条目一行（L 符号链接 / D 目录 / F 文件+可执行位+SHA-1），排序后可比
async function digest(dir: string) {
  // 摘要行集合
  const entries: string[] = []
  // 递归遍历（目录名排序，保证输出确定）
  const walk = async (current: string) => {
    // 按名字排序目录项
    for (const entry of (await fs.readdir(current, { withFileTypes: true })).toSorted((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      // 完整路径
      const full = path.join(current, entry.name)
      // 相对仓库根的路径
      const relative = path.relative(dir, full)
      // 跳过 .git 本身与其内容
      if (relative === ".git" || relative.startsWith(".git/")) continue
      // lstat：不穿透符号链接
      const stat = await fs.lstat(full)
      // 符号链接：记录目标
      if (stat.isSymbolicLink()) entries.push(`L ${relative} -> ${await fs.readlink(full)}`)
      // 目录：记一行后递归
      else if (stat.isDirectory()) {
        // 目录条目
        entries.push(`D ${relative}`)
        // 递归下钻
        await walk(full)
      } else {
        // 普通文件：读内容算 SHA-1（读不了的文件按固定占位串算，保证确定性）
        const content = await fs.readFile(full).catch(() => Buffer.from("<unreadable>"))
        // 记录：路径 + 可执行位（任一执行位即 x）+ 内容哈希
        entries.push(
          `F ${relative} ${stat.mode & 0o111 ? "x" : "-"} ${crypto.createHash("sha1").update(content).digest("hex")}`,
        )
      }
    }
  }
  // 从仓库根开始遍历
  await walk(dir)
  // 返回摘要行
  return entries
}

// 主流程：确保工作根存在，按命令行选择场景，逐个跑并写结果 JSON
await fs.mkdir(root, { recursive: true })
// 第一个参数是输出文件，其余是可选的场景名过滤
const [outputFile, ...selected] = process.argv.slice(2)
// 结果：场景名 → 日志数组
const output: Record<string, unknown> = {}
// 顺序遍历全部场景（跳过未选中的），保证输出顺序稳定
for (const [name, scenario] of Object.entries(scenarios)) {
  // 指定了场景名列表且本场景不在其中则跳过
  if (selected.length && !selected.includes(name)) continue
  // 跑场景并记录
  output[name] = await run(name, scenario)
}
// 把结果 JSON（缩进 2）写到输出文件——两份输出交给 script/snapshot-parity-compare.ts 对比
await Bun.write(outputFile!, JSON.stringify(output, null, 2))
