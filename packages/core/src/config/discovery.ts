// 配置发现（Config Discovery）模块：枚举所有可能的配置（config）来源路径，并按优先级整理成 Sources。
export * as ConfigDiscovery from "./discovery.js"

// 导入 Node 的 os 模块，用于读取当前用户名等系统信息。
import os from "os"
// 导入 Node 的 path 模块，用于拼接与解析文件路径。
import path from "path"
// 导入 Effect 库，用 Effect.fn 定义可组合的副作用（effect）流程。
import { Effect } from "effect"
// 导入文件系统工具服务（FSUtil），提供 resolve、readDirectory 等抽象文件操作。
import { FSUtil } from "@opencode/util/fs-util"
// 导入全局目录服务（Global），提供用户主目录与全局配置目录位置。
import { Global } from "@opencode/util/global"
// 导入位置（Location）服务，描述当前工作目录与项目根目录。
import { Location } from "../location.js"
// 导入 AbsolutePath 品牌类型，表示经过校验的绝对路径。
import { AbsolutePath } from "../schema.js"
// 导入配置加载选项（Options）类型。
import type { Options } from "../config.js"

// 声明配置文件的候选文件名：普通 JSON 与允许注释的 JSONC。
export const names = ["opencode.json", "opencode.jsonc"]

/** Eligible sources in priority order, including paths that may appear later. */
// 来源（Sources）接口：按优先级排列的候选配置来源，包含可能稍后才出现的路径。
export interface Sources {
  // 系统级配置：路径及该路径当前是否存在。
  readonly system?: { readonly path: AbsolutePath; readonly present: boolean }
  /** macOS MDM managed preferences plist (`ai.opencode.managed`), when one is deployed. */
  // macOS MDM 托管偏好 plist（ai.opencode.managed），仅在企业部署了描述文件时存在。
  readonly preferences?: AbsolutePath
  // 全局（用户级）配置目录。
  readonly global?: AbsolutePath
  // 通过选项显式指定的配置文件路径。
  readonly explicit?: AbsolutePath
  // 直接命中的配置文件（opencode.json/jsonc）列表。
  readonly direct: readonly AbsolutePath[]
  // 项目内发现的 .opencode 目录列表（附带是否存在标记）。
  readonly project: readonly { readonly path: AbsolutePath; readonly present: boolean }[]
  // 发现的 .claude 目录列表（用于兼容 Claude Code 的配置）。
  readonly claude: readonly AbsolutePath[]
  // 发现的 .agents 目录列表（用于兼容其他代理工具的配置）。
  readonly agents: readonly AbsolutePath[]
}

/** Platform system configuration directory (`/Library/Application Support/opencode`, `/etc/opencode`, `%ProgramData%\opencode`). */
// 返回各平台的系统配置目录：macOS 为 /Library/Application Support/opencode，Windows 为 %ProgramData%\opencode，其余为 /etc/opencode。
export function systemDirectory(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env) {
  // macOS 平台的系统配置目录。
  if (platform === "darwin") return AbsolutePath.make("/Library/Application Support/opencode")
  // Windows 平台：优先取 ProgramData 环境变量，缺省回退到 C:\ProgramData。
  if (platform === "win32") return AbsolutePath.make(path.join(env.ProgramData || "C:\\ProgramData", "opencode"))
  // Linux 等其他平台的系统配置目录。
  return AbsolutePath.make("/etc/opencode")
}

/** macOS MDM managed preferences plists, most specific first; the first one present wins. */
// 返回 macOS MDM 托管偏好 plist 的候选路径：先用户级后机器级，第一个实际存在的生效。
export function preferencePaths(user: string) {
  return [
    // 针对当前用户的托管偏好 plist。
    AbsolutePath.make(path.join("/Library/Managed Preferences", user, "ai.opencode.managed.plist")),
    // 机器级（所有用户共享）的托管偏好 plist。
    AbsolutePath.make("/Library/Managed Preferences/ai.opencode.managed.plist"),
  ]
}

// Keys macOS and MDM profiles inject into managed preferences that are not OpenCode config.
// macOS 与 MDM 描述文件会注入托管偏好的这些元数据键，它们不属于 OpenCode 配置。
const preferenceMetadata = new Set([
  // 描述文件的显示名。
  "PayloadDisplayName",
  // 描述文件的标识符。
  "PayloadIdentifier",
  // 描述文件的类型。
  "PayloadType",
  // 描述文件的 UUID。
  "PayloadUUID",
  // 描述文件的版本号。
  "PayloadVersion",
  // 手动安装标记。
  "_manualProfile",
])

/** Removes MDM payload metadata from `plutil -convert json` output. */
// 从 `plutil -convert json` 的输出中剔除 MDM 描述文件元数据键，只留下真正的配置内容。
export function stripPreferenceMetadata(json: string) {
  // 先把文本解析为任意 JSON 值。
  const parsed: unknown = JSON.parse(json)
  // 若不是普通对象（例如数组或标量），原样返回，无需过滤。
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return json
  // 过滤掉 preferenceMetadata 集合中的键后重新序列化为 JSON 字符串。
  return JSON.stringify(Object.fromEntries(Object.entries(parsed).filter(([key]) => !preferenceMetadata.has(key))))
}

// 定义发现流程 discover：一个 Effect 生成器，收集并整理所有配置来源。
export const discover = Effect.fn("ConfigDiscovery.discover")(function* (options?: Options) {
  // 获取文件系统工具服务。
  const fs = yield* FSUtil.Service
  // 获取全局目录服务。
  const global = yield* Global.Service
  // 获取位置服务（当前目录与项目根目录）。
  const location = yield* Location.Service
  // 计算系统级配置目录：允许用 options.system 覆盖或禁用。
  const system = (() => {
    // 显式传 false 表示完全跳过系统配置。
    if (options?.system === false) return
    // 传字符串则视为自定义系统配置目录路径。
    if (typeof options?.system === "string") return AbsolutePath.make(path.resolve(options.system))
    // 否则按当前平台探测默认系统配置目录。
    return systemDirectory()
  })()
  // 全局配置目录的绝对路径。
  const globalDirectory = AbsolutePath.make(global.config)
  // 用户主目录下的 .agents 目录（兼容其他代理工具）。
  const globalAgentsDirectory = AbsolutePath.make(path.join(global.home, ".agents"))
  // 用户主目录下的 .claude 目录（兼容 Claude Code）。
  const globalClaudeDirectory = AbsolutePath.make(path.join(global.home, ".claude"))
  // 系统与全局两级配置目录集合。
  const configDirectories = [...(system ? [system] : []), globalDirectory]
  // 并发解析所有全局根目录（含 .claude/.agents）的真实路径，供后续过滤使用。
  const globalRoots = yield* Effect.forEach(
    [...configDirectories, globalClaudeDirectory, globalAgentsDirectory],
    (item) => fs.resolve(item),
    { concurrency: "unbounded" },
  )
  // 解析当前工作目录的真实路径。
  const current = yield* fs.resolve(location.directory)
  // 若当前目录本身就是某个全局配置根，或显式禁用项目配置，则不做向上遍历；否则从当前目录逐级向上收集候选目录。
  const directories =
    globalRoots.slice(0, configDirectories.length).includes(current) || options?.project === false
      ? []
      : yield* fs.up({ targets: ["."], start: location.directory }).pipe(Effect.orDie)
  // 每个目录内要探测的候选名：兼容目录（.claude、.agents、.opencode）加配置文件名（倒序存放，便于最终再反转恢复优先级）。
  const candidates = [".claude", ".agents", ".opencode", ...names.toReversed()]
  // 对每个候选目录并发探测其中的候选名，得到 {原始路径, 解析路径, 是否缺失} 列表。
  const discovered = yield* Effect.forEach(
    directories,
    (directory) =>
      Effect.gen(function* () {
        // Resolve the parent too: missing children must honor symlinked global roots.
        // 父目录也要解析真实路径：即使子项缺失，也要遵循符号链接后的全局根目录。
        const parent = directory === location.directory ? current : yield* fs.resolve(directory)
        // One directory listing skips realpath and stat on absent candidates; sandboxes that deny
        // listing an ancestor fall back to probing each candidate directly.
        // 先尝试一次性列出父目录内容：缺失的候选名即可跳过逐个 stat；若沙箱禁止列目录，则回退为逐个探测。
        const entries = yield* fs.readDirectory(parent).pipe(
          Effect.map((list) => new Set(list.map((entry) => entry.toLowerCase()))),
          Effect.orElseSucceed(() => undefined),
        )
        // 对该目录下的每个候选名并发判断存在性。
        return yield* Effect.forEach(
          candidates,
          (name) => {
            // 候选名的完整路径（保留原大小写）。
            const item = AbsolutePath.make(path.join(directory, name))
            // 已有目录列表且其中不含该候选名：直接标记为缺失，避免无谓的系统调用。
            if (entries && !entries.has(name.toLowerCase())) {
              return Effect.succeed({ item, resolved: path.resolve(parent, name), missing: true })
            }
            // 否则解析该候选的真实路径并标记为存在。
            return fs
              .resolve(path.join(parent, name))
              .pipe(Effect.map((resolved) => ({ item, resolved, missing: false })))
          },
          { concurrency: "unbounded" },
        )
      }),
    { concurrency: "unbounded" },
  ).pipe(
    // 把每个目录的结果摊平成单一列表。
    Effect.map((items) => items.flat()),
    // 探测失败（如权限不足）直接中断流程。
    Effect.orDie,
  )

  // 是否启用全局配置来源。
  const globalEnabled = options?.global !== false
  // 并发解析系统与全局目录下的所有配置文件候选路径。
  const globalFiles = yield* Effect.forEach(
    configDirectories.flatMap((directory) => names.map((name) => path.join(directory, name))),
    (file) => fs.resolve(file),
    { concurrency: "unbounded" },
  )
  // Global sources must not re-enter through the project walk.
  // 从项目遍历结果中剔除全局来源，避免全局配置经项目遍历被重复计入。
  const visibleEntries = discovered.filter((entry) =>
    globalEnabled
      ? !globalRoots.includes(entry.resolved) && !globalFiles.includes(entry.resolved)
      : !globalRoots.some((root) => entry.resolved === root || entry.resolved.startsWith(root + path.sep)),
  )
  // 只保留可见条目的原始路径。
  const visible = visibleEntries.map((entry) => entry.item)

  // A custom system directory replaces platform discovery, so it also skips host MDM preferences.
  // 仅在 macOS 且启用全局与系统配置时读取 MDM 托管偏好；自定义系统目录会取代平台探测，因此同时跳过 MDM。
  const preferences =
    globalEnabled && (options?.system ?? true) === true && process.platform === "darwin"
      ? (yield* Effect.filter(
          preferencePaths(yield* Effect.try(() => os.userInfo().username).pipe(Effect.orElseSucceed(() => "user"))),
          fs.isFile,
        )).at(0)
      : undefined

  // 汇总返回各来源：系统目录、MDM 偏好、全局、显式指定、直接配置文件、.opencode、.claude、.agents。
  return {
    // 系统目录信息（含是否存在），仅在启用全局时返回。
    system: globalEnabled && system ? { path: system, present: yield* fs.isDir(system) } : undefined,
    // 第一个实际存在的 MDM 托管偏好 plist（非 macOS 时为 undefined）。
    preferences,
    // 启用时返回全局配置目录。
    global: globalEnabled ? globalDirectory : undefined,
    // 命令行显式指定的配置文件（若有）。
    explicit: options?.file ? AbsolutePath.make(path.resolve(options.file)) : undefined,
    // 直接命中的配置文件：剔除兼容目录后反转，恢复 opencode.json 优先于 opencode.jsonc 的顺序。
    direct: visible.filter((item) => ![".agents", ".claude", ".opencode"].includes(path.basename(item))).toReversed(),
    // 项目内的 .opencode 目录：反转优先级并逐个标注是否存在。
    project: yield* Effect.forEach(
      visibleEntries.filter((entry) => path.basename(entry.item) === ".opencode").toReversed(),
      (entry) =>
        entry.missing
          ? Effect.succeed({ path: entry.item, present: false })
          : fs.isDir(entry.item).pipe(Effect.map((present) => ({ path: entry.item, present }))),
      { concurrency: "unbounded" },
    ),
    // .claude 目录：全局目录（若启用）与项目内发现的目录去重合并。
    claude:
      options?.claude === false
        ? []
        : [
            ...new Set([
              ...(globalEnabled ? [globalClaudeDirectory] : []),
              ...visible.filter((item) => path.basename(item) === ".claude").toReversed(),
            ]),
          ],
    // .agents 目录：同样把全局目录与项目内发现的目录去重合并。
    agents: [
      ...new Set([
        ...(globalEnabled ? [globalAgentsDirectory] : []),
        ...visible.filter((item) => path.basename(item) === ".agents").toReversed(),
      ]),
    ],
  } satisfies Sources
})
