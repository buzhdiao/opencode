// 配置技能插件（Config Skill Plugin）：加载配置声明的技能来源（目录与 URL）并注册到技能服务。
export * as ConfigSkillPlugin from "./skill.js"

// 导入插件定义工具。
import { define } from "@opencode/plugin/effect/plugin"
// 导入配置条目（Entry）类型。
import type { Entry } from "@opencode/schema/config"
// 导入文件系统工具服务。
import { FSUtil } from "@opencode/util/fs-util"
// 导入全局目录服务。
import { Global } from "@opencode/util/global"
// 导入 Node 的 path 模块。
import path from "path"
// 导入 Effect 的并发与流工具。
import { Effect, FiberMap, PubSub, Semaphore, Stream } from "effect"
// 导入配置服务。
import { Config } from "../../config.js"
// 导入文件监视器服务。
import { Watcher } from "../../filesystem/watcher.js"
// 导入位置服务。
import { Location } from "../../location.js"
// 导入绝对路径品牌类型。
import { AbsolutePath } from "../../schema.js"
// 导入技能服务与类型。
import { Skill } from "../../skill.js"
// 导入技能发现服务。
import { SkillDiscovery } from "../../skill/discovery.js"
// 导入技能文件解析器。
import { SkillFile } from "./skill-file.js"
// 导入技能扫描器。
import { SkillScan } from "./skill-scan.js"

// 技能来源类型：目录或 URL。
type Source = Skill.DirectorySource | Skill.UrlSource

// 定义插件。
export const Plugin = define({
  // 插件 ID。
  id: "opencode.config.skill",
  // 插件主流程。
  effect: Effect.fn(function* (ctx) {
    // 获取配置服务。
    const config = yield* Config.Service
    // 获取技能发现服务。
    const discovery = yield* SkillDiscovery.Service
    // 获取文件系统工具服务。
    const fs = yield* FSUtil.Service
    // 获取全局目录服务。
    const global = yield* Global.Service
    // 获取位置服务。
    const location = yield* Location.Service
    // 获取文件监视器服务。
    const watcher = yield* Watcher.Service
    // 可变的已加载状态：配置条目与技能列表。
    const loaded: { entries: Entry[]; skills: Skill.Info[] } = {
      entries: yield* config.entries(),
      skills: [],
    }
    // 管理 watch fiber 的映射表。
    const watches = yield* FiberMap.make<string>()
    // 变更通知的滑动窗口发布订阅（容量 1）。
    const changes = yield* PubSub.sliding<string>(1)
    // 串行化刷新的信号量。
    const lock = Semaphore.makeUnsafe(1)

    // 订阅某个文件/目录的监视并把更新转发到变更通道。
    const watch = Effect.fn("ConfigSkillPlugin.watch")(function* (directory: string, type: "file" | "directory") {
      // 监视目标的绝对路径。
      const target = path.resolve(directory)
      // 订阅监视事件（目录监视时应用技能扫描的忽略规则）。
      const updates = yield* watcher.subscribe(
        type === "directory" ? { path: target, type, ignore: SkillScan.ignore } : { path: target, type },
      )
      // 用固定键启动 fiber 发布更新（已存在则不重复）。
      yield* FiberMap.run(
        watches,
        `${type}:${target}`,
        updates.pipe(Stream.runForEach((update) => PubSub.publish(changes, update.path).pipe(Effect.asVoid))),
        { onlyIfMissing: true, startImmediately: true },
      )
    })

    // 找到目标路径第一个不存在的祖先目录（用于在目录尚未创建时挂监视）。
    function firstMissing(target: string): Effect.Effect<string | undefined> {
      // 父目录。
      const parent = path.dirname(target)
      // 已到根：没有缺失的祖先。
      if (parent === target) return Effect.undefined
      // 父目录存在则目标本身是缺失点；否则继续向上找。
      return fs.isDir(parent).pipe(Effect.flatMap((exists) => (exists ? Effect.succeed(target) : firstMissing(parent))))
    }

    // 监视一个技能来源目录：处理目录存在/缺失/符号链接等情形，返回需要扫描的根列表。
    const watchDirectory: (directory: string) => Effect.Effect<string[]> = Effect.fn(
      "ConfigSkillPlugin.watchDirectory",
    )(function* (directory: string) {
      // 目标的绝对路径。
      const target = path.resolve(directory)
      // 解析真实路径（目录不存在时为 undefined）。
      const resolved = yield* fs.realPath(directory).pipe(Effect.orElseSucceed(() => undefined))
      if (resolved) {
        // 监视真实目录。
        yield* watch(resolved, "directory")
        // 真实路径与声明路径不同（如符号链接）时还要监视声明路径本身。
        if (resolved !== target) yield* watch(target, "file")
        // 返回需要扫描的根。
        return resolved === target ? [target] : [target, resolved]
      }
      // 目录不存在：找到第一个缺失的祖先并对它挂文件监视。
      const missing = yield* firstMissing(target)
      if (missing) yield* watch(missing, "file")
      // 再查一次真实路径：可能在挂监视期间目录已被创建。
      if (
        yield* fs.realPath(directory).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        )
      ) {
        // 已创建时撤销刚才的缺失监视并重新递归处理。
        if (missing) yield* FiberMap.remove(watches, `file:${path.resolve(missing)}`)
        return yield* watchDirectory(directory)
      }
      // 仍然不存在：只返回目标路径（等创建事件）。
      return [target]
    })

    // 汇总所有技能来源：配置目录下的 skill/skills 子目录加文档声明的条目。
    const sources = () => {
      // 结果列表。
      const result: Source[] = []
      // 去重添加来源。
      const add = (source: Source) => {
        // 已存在相同来源则跳过。
        if (result.some((item) => Skill.Source.equals(item, source))) return
        result.push(source)
      }
      // 所有目录型配置条目。
      const directories = loaded.entries.flatMap((entry) => (entry.type === "directory" ? [entry.path] : []))
      // 所有文档声明的 skills 条目。
      const items = loaded.entries.flatMap((entry) => (entry.type === "document" ? (entry.info.skills ?? []) : []))
      // 每个配置目录派生 skill 与 skills 两个子目录来源。
      for (const directory of directories) {
        add(Skill.DirectorySource.make({ type: "directory", path: AbsolutePath.make(path.join(directory, "skill")) }))
        add(Skill.DirectorySource.make({ type: "directory", path: AbsolutePath.make(path.join(directory, "skills")) }))
      }
      // 处理文档声明的每个条目。
      for (const item of items) {
        // URL 条目（仅 http/https）作为远程来源。
        if (URL.canParse(item) && /^(https?:)$/.test(new URL(item).protocol)) {
          add(Skill.UrlSource.make({ type: "url", url: item }))
          continue
        }
        // 展开 ~ 前缀。
        const expanded = item.startsWith("~/") ? path.join(global.home, item.slice(2)) : item
        // 目录来源：绝对路径直接用，相对路径基于当前工作目录解析。
        add(
          Skill.DirectorySource.make({
            type: "directory",
            path: AbsolutePath.make(path.isAbsolute(expanded) ? expanded : path.join(location.directory, expanded)),
          }),
        )
      }
      // 返回全部来源。
      return result
    }

    // 加载一个来源：目录直接扫描；URL 先拉取到本地目录再扫描。
    const load = Effect.fn("ConfigSkillPlugin.load")(function* (source: Source) {
      // 待扫描的目录列表。
      const directories =
        source.type === "directory"
          ? [source.path]
          : yield* discovery.pull(source.url).pipe(
              // 拉取失败记警告并返回空列表。
              Effect.catchCause((cause) =>
                Effect.logWarning("failed to load skill source", {
                  source: Skill.Source.key(source),
                  cause,
                }).pipe(Effect.as([] as AbsolutePath[])),
              ),
            )
      // 为每个目录建立监视并收集根。
      const roots = (yield* Effect.forEach(directories, watchDirectory)).flat()
      // 收集到的技能。
      const skills: Skill.Info[] = []
      // 逐个目录扫描。
      for (const directory of directories) {
        for (const filepath of yield* SkillScan.scan(directory)) {
          // 解析文件真实路径（失败用原路径）。
          const resolved = yield* fs.realPath(filepath).pipe(Effect.orElseSucceed(() => filepath))
          // 不在任何监视根之下时对文件单独挂监视。
          if (!roots.some((root) => FSUtil.contains(root, resolved))) yield* watch(resolved, "file")
          // 读取文件内容（失败跳过）。
          const content = yield* fs.readFileStringSafe(filepath).pipe(Effect.orElseSucceed(() => undefined))
          if (!content) continue
          // 解析技能文件。
          const parsed = SkillFile.parse(directory, filepath, content)
          // 跳过的文件记调试日志。
          if (parsed._tag === "Skipped") {
            yield* Effect.logDebug("skill file skipped", {
              filepath,
              reason: parsed.reason,
              ...(parsed.reason === "frontmatter" ? { issue: parsed.issue } : {}),
            })
            continue
          }
          // 收集解析成功的技能。
          skills.push(parsed.skill)
        }
      }
      // 记调试日志：来源与技能列表。
      yield* Effect.logDebug("skill source loaded", {
        source: Skill.Source.key(source),
        type: source.type,
        directories,
        skills: skills.map((skill) => skill.id),
      })
      // 返回技能列表。
      return skills
    })

    // 总刷新：清空监视、重新加载全部来源并更新缓存。
    const refresh = Effect.fn("ConfigSkillPlugin.refresh")(
      function* (file?: string) {
        // 清空旧的监视。
        yield* FiberMap.clear(watches)
        // 按 ID 去重的技能表。
        const skills = new Map<Skill.ID, Skill.Info>()
        // 计算本轮来源。
        const current = sources()
        // 逐个来源加载，后到的覆盖先到的。
        for (const source of current) {
          for (const skill of yield* load(source)) skills.set(skill.id, skill)
        }
        // 更新技能缓存。
        loaded.skills = Array.from(skills.values())
        // 带触发文件时记信息日志。
        if (file) {
          yield* Effect.logInfo("skills rescanned", {
            file,
            sources: current.map(Skill.Source.key),
            skills: loaded.skills.map((skill) => skill.id),
          })
        }
      },
      // 持锁串行化（可带触发文件参数）。
      (effect, ..._args: [file?: string]) => lock.withPermit(effect),
    )

    // Editor saves arrive as bursts of watcher events; settle before rescanning once. Subscribe
    // before debouncing so no update slips through while the debounce starts its pull.
    // 编辑器保存会带来成串的监视事件；去抖后只重扫一次。先订阅再去抖，避免去抖启动拉取时漏掉更新。
    const updates = yield* PubSub.subscribe(changes)
    yield* Stream.fromSubscription(updates).pipe(
      // 去抖 100ms。
      Stream.debounce("100 millis"),
      // 每次触发：刷新并重载技能服务。
      Stream.runForEach((file) => refresh(file).pipe(Effect.andThen(ctx.skill.reload()))),
      Effect.forkScoped({ startImmediately: true }),
    )
    // 启动时先刷新一次。
    yield* refresh()
    // 把技能写入技能编辑器。
    yield* ctx.skill.transform((editor) => {
      for (const skill of loaded.skills) editor.add(skill)
    })
    // 订阅 config.updated：更新条目缓存并整体重扫。
    yield* ctx.event.subscribe({ types: ["config.updated"] }).pipe(
      Stream.runForEach(() =>
        config.entries().pipe(
          // 记录最新条目。
          Effect.tap((entries) => Effect.sync(() => (loaded.entries = entries))),
          // 刷新并重载。
          Effect.andThen(refresh()),
          Effect.andThen(ctx.skill.reload()),
        ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})
