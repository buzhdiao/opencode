// Shell 选择（select）模块：发现、校验并选定系统上可用的 shell，并生成其启动参数
// 桶导出（barrel export）：将本模块聚合为命名空间 ShellSelect，供外部统一引用
export * as ShellSelect from "./select.js"

// 路径解析与拼接
import path from "path"
// 异步读文件（读取 /etc/shells）
import { readFile } from "fs/promises"
// 同步 stat（探测 shell 可执行文件）
import { statSync } from "fs"
// effect 库：依赖注入容器（Context）、Effect、Layer 层与 Schema 校验
import { Context, Effect, Layer, Schema } from "effect"
// 构造带位置（location）的依赖节点工具
import { makeLocationNode } from "@opencode/util/effect/app-node"
// 文件系统工具（含 Windows 路径归一化）
import { FSUtil } from "@opencode/util/fs-util"
// 全局配置服务（提供 bin 目录等）
import { Global } from "@opencode/util/global"
// 通用状态（State）管理工具
import { State } from "../state.js"
// App 执行别名（App Execution Alias）判断与 which 查找
import { isAppExecutionAlias, which } from "../util/which.js"

// 各 shell 的特性元数据（metadata）：deny=禁止使用；login=需按登录 shell（login shell）调用；ps=PowerShell 系
const META: Record<string, { deny?: boolean; login?: boolean; ps?: boolean }> = {
  bash: { login: true },
  dash: { login: true },
  fish: { deny: true, login: true },
  ksh: { login: true },
  nu: { deny: true },
  powershell: { ps: true },
  pwsh: { ps: true },
  sh: { login: true },
  zsh: { login: true },
}

// 列表项：shell 的路径、短名称，以及是否可接受（acceptable，即未被 deny）
export type Item = {
  path: string
  name: string
  acceptable: boolean
}

// 配置项 Schema：可选的 gitbash 路径（Windows 下 Git Bash 的 bash.exe 位置）
export const Options = Schema.Struct({
  gitbash: Schema.optional(Schema.String),
})
// 由 Schema 推导出的选项类型
export type Options = typeof Options.Type

// 持久化状态的数据形状：用户在配置里选择的 shell
type Data = {
  shell?: string
}

// 编辑器接口：允许外部（如配置界面）写入所选 shell
export type Editor = {
  configure: (shell: string) => void
}

// 解析入参：priority 决定按配置优先还是兼容优先（compat，仅选可安全分析的 shell）
export type ResolveInput = {
  priority: "config" | "compat"
}

// 服务接口：在 State 可变换（Transformable）能力之上提供 resolve 与可选的 list
export interface Interface extends State.Transformable<Editor> {
  readonly resolve: (input: ResolveInput) => Effect.Effect<string>
  readonly list?: () => Effect.Effect<Item[]>
}

// Effect 服务（Service）声明，标签为 "@opencode/ShellSelect"
export class Service extends Context.Service<Service, Interface>()("@opencode/ShellSelect") {}

// 容错版 stat：文件不存在时返回 undefined 而不是抛错
function stat(file: string) {
  return statSync(file, { throwIfNoEntry: false }) ?? undefined
}

// 在 PATH（或指定 bin 目录）中查找可执行文件
function findExecutable(name: string, bin?: string) {
  return which(name, undefined, bin)
}

// 把传入的 shell 名/路径补全为可用的完整形式；非 Windows 原样返回
function full(file: string, options?: Options, bin?: string) {
  // 非 Windows 无需补全
  if (process.platform !== "win32") return file
  // 统一转换为 Windows 路径格式
  const shell = FSUtil.windowsPath(file)
  // 传入的是带目录的路径时
  if (path.win32.dirname(shell) !== ".") {
    // 以 / 开头且名为 bash 的路径（如 Git Bash 的挂载路径）优先换算成 gitbash 路径
    if (shell.startsWith("/") && name(shell) === "bash") return gitbash(options, bin) || shell
    // 其他带目录路径直接使用
    return shell
  }
  // 裸名称：bash 优先解析为 Git Bash，其次在 PATH 中查找
  if (name(shell) === "bash") return gitbash(options, bin) || findExecutable(shell, bin) || shell
  // 其他名称直接在 PATH 中查找，找不到则原样返回
  return findExecutable(shell, bin) || shell
}

// 查询某 shell 文件的元数据；未知 shell 返回 undefined
function meta(file: string) {
  return META[name(file)]
}

// 判断 shell 是否兼容可用（未被标记 deny）
function compatible(file: string) {
  return meta(file)?.deny !== true
}

// 判断路径是否为绝对路径（rooted，已带根）
function rooted(file: string) {
  return path.isAbsolute(FSUtil.windowsPath(file))
}

// 解析出确实存在的可执行 shell 路径；不存在则返回 undefined
function executable(file: string, options?: Options, bin?: string) {
  // 先补全为完整路径
  const shell = full(file, options, bin)
  // 绝对路径直接验证文件存在性
  if (rooted(shell)) {
    // Check the alias first: stat throws EACCES for it.
    // 先检查应用执行别名（App Execution Alias）：对它 stat 会抛 EACCES
    if (isAppExecutionAlias(shell) || stat(shell)?.isFile()) return shell
    // 既不是别名也不是普通文件则视为不可用
    return
  }
  // 非绝对路径按名称在 PATH 中查找
  return findExecutable(shell, bin) ?? undefined
}

// 枚举 Windows 下可用的 shell 候选（去重）：pwsh、powershell、Git Bash、cmd
function win(options?: Options, bin?: string) {
  return Array.from(
    new Set(
      [
        // PowerShell 7+（pwsh）
        findExecutable("pwsh", bin),
        // Windows PowerShell（powershell）
        findExecutable("powershell", bin),
        // Git Bash 的 bash.exe（可选）
        gitbash(options, bin),
        // 默认命令行处理器：环境变量 COMSPEC，缺省 cmd.exe
        process.env.COMSPEC || "cmd.exe",
      ]
        // 过滤掉查找失败的空值
        .filter((item): item is string => Boolean(item))
        // 统一补全为完整路径
        .map((file) => full(file, options, bin)),
    ),
  )
}

// 枚举 Unix 下的 shell：优先读 /etc/shells（去空行与注释），失败时退回常见路径
async function unix() {
  // 读取失败时以空字符串兜底
  const text = await readFile("/etc/shells", "utf8").catch(() => "")
  // 有内容则按行拆分、去重后返回
  if (text) return Array.from(new Set(text.split("\n").filter((line) => line.trim() && !line.startsWith("#"))))
  // 无 /etc/shells 时给出保守的默认列表
  return ["/bin/bash", "/bin/zsh", "/bin/sh"]
}

// 选定最终使用的 shell：优先用户指定文件，其次平台默认
function select(file: string | undefined, options?: Options, opts?: { compatible?: boolean }, bin?: string) {
  // 指定了 shell 且（不要求兼容或该 shell 兼容）时尝试解析
  if (file && (!opts?.compatible || compatible(file))) {
    const shell = executable(file, options, bin)
    // 找到可用可执行文件即采用
    if (shell) return shell
  }
  // Windows 上取候选列表第一个
  if (process.platform === "win32") return win(options, bin)[0]
  // 其他平台走通用回退
  return fallback(bin)
}

// 定位 Git Bash 的 bash.exe：优先显式配置，其次从 git 可执行文件位置推导
export function gitbash(options?: Options, bin?: string) {
  // 仅 Windows 有 Git Bash
  if (process.platform !== "win32") return
  // 使用用户配置的路径
  if (options?.gitbash) return options.gitbash
  // 找到 git.exe
  const git = findExecutable("git", bin)
  // 没装 git 则无法推导
  if (!git) return
  // git 位于 <root>/cmd 或 <root>/bin 下，向上两级拼出 <root>/bin/bash.exe
  const file = path.join(git, "..", "..", "bin", "bash.exe")
  // 文件存在（size>0）才返回
  if (stat(file)?.size) return file
}

// 平台默认 shell：macOS 用 zsh，其次 bash，最后 /bin/sh
function fallback(bin?: string) {
  if (process.platform === "darwin") return "/bin/zsh"
  const bash = findExecutable("bash", bin)
  if (bash) return bash
  return "/bin/sh"
}

// 提取 shell 的短名称（如 "bash.exe" -> "bash"），统一小写
export function name(file: string) {
  if (process.platform === "win32") return path.win32.parse(FSUtil.windowsPath(file)).name.toLowerCase()
  return path.basename(file).toLowerCase()
}

// 该 shell 是否需要按登录 shell（login shell）方式调用
export function login(file: string) {
  return meta(file)?.login === true
}

// 该 shell 是否为 PowerShell 系
export function ps(file: string) {
  return meta(file)?.ps === true
}

// 构造列表项：path 为完整路径；name 在短名可直接执行时用短名，否则用完整路径
function info(file: string, options?: Options, bin?: string): Item {
  const item = full(file, options, bin)
  const n = name(item)
  return {
    path: item,
    name: executable(n, options, bin) ? n : item,
    acceptable: compatible(item),
  }
}

// 组装在指定 shell 中执行 command 的启动参数
export function args(file: string, command: string) {
  const n = name(file)
  // cmd 用 /c 执行
  if (n === "cmd") return ["/c", command]
  // PowerShell 系：禁用横幅、配置文件与交互模式
  if (ps(file)) return ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command]
  // zsh aborts the whole line on an unmatched glob; pass it through literally as bash does.
  if (n === "zsh") return ["+o", "nomatch", "-c", command]
  return ["-c", command]
}

// Resolve afresh so removing a shell does not leave terminals using a stale cached path.
// 每次都重新解析（不读缓存），避免 shell 被删除后终端仍使用过期的缓存路径
export function environment(bin?: string, filter?: { compatible?: boolean }) {
  return select(process.env.SHELL, undefined, filter, bin)
}

// "config" 优先级的默认解析结果缓存（按 bin 目录区分）
let defaultConfigured: { bin?: string; value: string } | undefined
// "compat" 优先级的默认解析结果缓存
let defaultCompatible: { bin?: string; value: string } | undefined

// 解析应使用的 shell：显式配置 > 环境变量 SHELL > 缓存 > 平台默认
export function resolve(input: ResolveInput, configShell?: string, options?: Options, bin?: string) {
  // compat 优先级时只允许兼容（未 deny）的 shell
  const filter = input.priority === "compat" ? { compatible: true } : undefined
  // 配置里指定了 shell 则直接选它
  if (configShell) return select(configShell, options, filter, bin)
  // 配置了 gitbash 时绕过缓存重新解析（会影响 Windows 候选）
  if (options?.gitbash) return select(process.env.SHELL, options, filter, bin)
  // 读取对应优先级的缓存
  const cached = input.priority === "compat" ? defaultCompatible : defaultConfigured
  // 同一 bin 下命中缓存则直接返回
  if (cached && cached.bin === bin) return cached.value
  // 否则现算一次
  const value = environment(bin, filter)
  // 按优先级写回缓存
  if (input.priority === "compat") defaultCompatible = { bin, value }
  if (input.priority === "config") defaultConfigured = { bin, value }
  return value
}
// 测试辅助：清空两份缓存
resolve.reset = () => {
  defaultConfigured = undefined
  defaultCompatible = undefined
}

// 列出当前系统所有可用（可执行）的 shell
export async function list(options?: Options, bin?: string): Promise<Item[]> {
  // Windows 走候选枚举，其他平台读 /etc/shells
  const shells = process.platform === "win32" ? win(options, bin) : await unix()
  // 过滤出真实可执行的项并转换为列表项
  return shells.filter((shell) => executable(shell, options, bin)).map((shell) => info(shell, options, bin))
}

// 构建 ShellSelect 服务对应的 Effect Layer（层）：注入 Global 与 State 依赖
const layer = (options?: Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      // 依赖全局服务（获取 bin 目录）
      const global = yield* Global.Service
      // 创建 "shell-select" 状态：记录用户选择的 shell，并暴露 configure 编辑器
      const state = State.create<Data, Editor>({
        name: "shell-select",
        initial: () => ({}),
        editor: (editor) => ({
          configure: (shell) => {
            editor.shell = shell
          },
        }),
      })
      // 组装服务实现：transform/reload 透传状态能力，resolve/list 包装为 Effect
      return Service.of({
        transform: state.transform,
        reload: state.reload,
        resolve: (input) => Effect.sync(() => resolve(input, state.get().shell, options, global.bin)),
        list: () => Effect.promise(() => list(options, global.bin)),
      })
    }),
  )

// 生成一个携带该服务层的位置节点（location node），依赖 Global 节点
export function configured(options?: Options) {
  return makeLocationNode({ service: Service, layer: layer(options), deps: [Global.node] })
}

// 默认导出的节点实例
export const node = configured()
