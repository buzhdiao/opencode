// 兼容性插件（Config Compatibility Plugin）：兼容加载 .claude/.agents 目录下的技能（skill）文件。
export * as ConfigCompatibilityPlugin from "./compatibility.js"

// 导入插件定义工具。
import { define } from "@opencode/plugin/effect/plugin"
// 导入文件系统工具服务。
import { FSUtil } from "@opencode/util/fs-util"
// 导入 Node 的 path 模块。
import path from "path"
// 导入 Effect 的并发与流工具。
import { Effect, FiberMap, PubSub, Semaphore, Stream } from "effect"
// 导入配置服务。
import { Config } from "../../config.js"
// 导入文件监视器服务。
import { Watcher } from "../../filesystem/watcher.js"
// 导入技能服务与类型。
import { Skill } from "../../skill.js"
// 导入技能文件解析器。
import { SkillFile } from "./skill-file.js"
// 导入技能扫描器。
import { SkillScan } from "./skill-scan.js"

// 定义插件。
export const Plugin = define({
  // 插件 ID。
  id: "opencode.config.compatibility",
  // 插件主流程。
  effect: Effect.fn(function* (ctx) {
    // 获取配置服务。
    const config = yield* Config.Service
    // 获取文件系统工具服务。
    const fs = yield* FSUtil.Service
    // 获取文件监视器服务。
    const watcher = yield* Watcher.Service
    // 管理 watch fiber 的映射表。
    const watches = yield* FiberMap.make<string>()
    // 变更通知的滑动窗口发布订阅（容量 1，只留最新）。
    const changes = yield* PubSub.sliding<string>(1)
    // 串行化刷新的信号量。
    const lock = Semaphore.makeUnsafe(1)
    // 当前加载的技能列表（可变缓存）。
    const skills: Skill.Info[] = []
    // 读取兼容根目录配置（未配置时返回空列表）。
    const compatibility = () =>
      config.compatibility ? config.compatibility() : Effect.succeed({ claude: [], agents: [] })

    // 订阅某个文件/目录的监视并把更新转发到变更通道。
    const watch = Effect.fn("ConfigCompatibilityPlugin.watch")(function* (
      target: string,
      type: "file" | "directory",
    ) {
      // 订阅监视事件（目录监视时应用技能扫描的忽略规则）。
      const updates = yield* watcher.subscribe(
        type === "directory" ? { path: target, type, ignore: SkillScan.ignore } : { path: target, type },
      )
      // 用固定键启动 fiber，把更新路径发布到 changes（已存在则不重复）。
      yield* FiberMap.run(
        watches,
        `${type}:${target}`,
        updates.pipe(Stream.runForEach((update) => PubSub.publish(changes, update.path).pipe(Effect.asVoid))),
        { onlyIfMissing: true, startImmediately: true },
      )
    })

    // 重新扫描全部兼容技能目录并重建监视。
    const refresh = Effect.fn("ConfigCompatibilityPlugin.refresh")(
      function* () {
        // 清空旧的监视。
        yield* FiberMap.clear(watches)
        // 读取兼容根目录。
        const roots = yield* compatibility()
        // 兼容技能目录：各根目录下的 skills 子目录。
        const directories = [...roots.claude, ...roots.agents].map((root) => path.join(root, "skills"))
        // 本轮加载到的技能（按 ID 去重）。
        const loaded = new Map<Skill.ID, Skill.Info>()
        // 逐个目录扫描。
        for (const directory of directories) {
          // 解析真实路径；目录不存在则跳过。
          const resolved = yield* fs.realPath(directory).pipe(Effect.orElseSucceed(() => undefined))
          if (!resolved) continue
          // 监视该目录。
          yield* watch(resolved, "directory")
          // 扫描目录下的技能文件。
          for (const filepath of yield* SkillScan.scan(resolved)) {
            // 读取文件内容（失败跳过）。
            const content = yield* fs.readFileStringSafe(filepath).pipe(Effect.orElseSucceed(() => undefined))
            if (!content) continue
            // 解析技能文件。
            const parsed = SkillFile.parse(resolved, filepath, content)
            // 解析成功则按 ID 记录。
            if (parsed._tag === "Parsed") loaded.set(parsed.skill.id, parsed.skill)
          }
        }
        // 用最新结果整体替换技能缓存。
        skills.splice(0, skills.length, ...loaded.values())
      },
      // 刷新全程持锁，避免并发扫描。
      (effect) => lock.withPermit(effect),
    )

    // 刷新一次并触发技能服务重载。
    const reload = refresh().pipe(Effect.andThen(ctx.skill.reload()))
    // 订阅变更通知。
    const updates = yield* PubSub.subscribe(changes)
    // 变更去抖 100ms 后重载。
    yield* Stream.fromSubscription(updates).pipe(
      Stream.debounce("100 millis"),
      Stream.runForEach(() => reload),
      Effect.forkScoped({ startImmediately: true }),
    )
    // 配置变化：仅当变化路径属于兼容来源才触发重建。
    yield* config.changes().pipe(
      Stream.filterEffect((update) =>
        Effect.map(compatibility(), (roots) => isCompatibilitySource(roots, update.path)),
      ),
      Stream.runForEach((update) => PubSub.publish(changes, update.path).pipe(Effect.asVoid)),
      Effect.forkScoped({ startImmediately: true }),
    )
    // 启动时先刷新一次。
    yield* refresh()
    // 把加载的技能写入技能编辑器。
    yield* ctx.skill.transform((editor) => {
      for (const skill of skills) editor.add(skill)
    })
  }),
})

// 兼容来源目录名。
const sourceDirectories = [".claude", ".agents"] as const

// 判断文件是否属于兼容来源：是兼容目录本身，或位于某个兼容根目录之下。
function isCompatibilitySource(
  roots: { readonly claude: readonly string[]; readonly agents: readonly string[] },
  file: string,
) {
  return (
    sourceDirectories.some((name) => path.basename(file) === name) ||
    [...roots.claude, ...roots.agents].some((root) => FSUtil.contains(root, file))
  )
}
