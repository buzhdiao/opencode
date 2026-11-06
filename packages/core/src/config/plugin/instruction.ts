// 配置指令插件（Config Instruction Plugin）：加载 AGENTS.md 与配置的 instructions 来源，供系统提示使用。
export * as ConfigInstructionPlugin from "./instruction.js"

// 导入插件定义工具。
import { define } from "@opencode/plugin/effect/plugin"
// 导入文件系统工具服务。
import { FSUtil } from "@opencode/util/fs-util"
// 导入全局目录服务。
import { Global } from "@opencode/util/global"
// 导入同目录判断工具。
import { sameDirectory } from "@opencode/util/path"
// 导入 Node 的 path 模块及 dirname/join 函数。
import path, { dirname, join } from "path"
// 导入 Effect 的并发与流工具。
import { Effect, FiberMap, PubSub, Semaphore, Stream } from "effect"
// 导入 HTTP 客户端工具。
import { HttpClient, HttpClientRequest } from "effect/http"
// 导入配置服务。
import { Config } from "../../config.js"
// 导入文件监视器服务。
import { Watcher } from "../../filesystem/watcher.js"
// 导入指令发现服务。
import { InstructionDiscovery } from "../../instruction-discovery.js"
// 导入指令集合工具。
import { Instructions } from "../../instructions/index.js"
// 导入位置服务。
import { Location } from "../../location.js"

// 已加载状态：可用（文件列表）或不可用。
type Loaded =
  | { readonly type: "available"; readonly files: InstructionDiscovery.File[] }
  | { readonly type: "unavailable" }

// 定义插件。
export const Plugin = define({
  // 插件 ID。
  id: "opencode.config.instruction",
  // 插件主流程。
  effect: Effect.fn(function* (ctx) {
    // 获取指令发现服务。
    const discovery = yield* InstructionDiscovery.Service
    // Activate even when both discovery scopes are disabled: configured `instructions`
    // entries are explicit requests, not discovery.
    // 即使两级发现都被禁用也要激活：配置中的 instructions 条目是显式请求，不属于发现机制。
    yield* Effect.gen(function* () {
      // 获取配置服务。
      const config = yield* Config.Service
      // 获取文件系统工具服务。
      const fs = yield* FSUtil.Service
      // 获取全局目录服务。
      const global = yield* Global.Service
      // 构造只接受成功状态码的 HTTP 客户端。
      const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
      // 获取位置服务。
      const location = yield* Location.Service
      // 获取文件监视器服务。
      const watcher = yield* Watcher.Service
      // 变更通知的滑动窗口发布订阅（容量 1）。
      const changes = yield* PubSub.sliding<string>(1)
      // 管理 watch fiber 的映射表。
      const watches = yield* FiberMap.make<string>()
      // 串行化刷新的信号量。
      const lock = Semaphore.makeUnsafe(1)
      // 解析当前工作目录的真实路径。
      const start = yield* fs.resolve(location.directory)
      // 解析项目根目录的真实路径。
      const root = yield* fs.resolve(location.project.directory)
      // 解析用户主目录的真实路径。
      const home = yield* fs.resolve(global.home)
      // 项目级发现：已启用且当前目录确实位于项目根之内。
      const project = discovery.project && FSUtil.contains(root, start)
      // 向上遍历的终点：当前目录位于主目录下时止于主目录，否则止于项目根。
      const stop = FSUtil.contains(home, start) ? home : root
      // 全局 AGENTS.md 的路径。
      const globalFile = yield* fs.resolve(join(global.config, "AGENTS.md"))
      // 可变的已加载状态容器。
      const loaded: { current: Loaded } = { current: { type: "available", files: [] } }
      // 可变的已配置来源容器：路径/模式列表与远程抓取内容映射。
      const configured: { sources: string[]; remote: Map<string, InstructionDiscovery.File> } = {
        sources: [],
        remote: new Map(),
      }

      // 把监视更新发布到变更通道。
      const publish = (update: Watcher.Update) => PubSub.publish(changes, update.path).pipe(Effect.asVoid)
      // The ancestor walk can reach the global file when the location sits
      // beneath the global config dir; global: false excludes it there too.
      // 组装候选 AGENTS.md：全局文件（启用全局发现时）加项目内逐级向上的文件；
      // 当位置位于全局配置目录之下时祖先遍历会触及全局文件，global: false 时同样排除它。
      const candidates = [
        ...(discovery.global ? [globalFile] : []),
        ...(project
          ? ancestorDirectories(start, stop)
              .map((directory) => join(directory, "AGENTS.md"))
              .filter((file) => discovery.global || file !== globalFile)
          : []),
      ]
      // 逐个订阅候选文件的监视（集合去重）。
      for (const file of new Set(candidates)) {
        // 订阅该文件。
        const updates = yield* watcher.subscribe({ path: file, type: "file" })
        // 更新转发到变更通道（后台 fiber 立即启动）。
        yield* updates.pipe(Stream.runForEach(publish), Effect.forkScoped({ startImmediately: true }))
      }

      // A missing file may be mid-save and is transient; a denied file (e.g. outside a sandbox grant) stays absent.
      // 读取指令文件：文件缺失可能是保存中途的暂态；被拒读（如沙箱授权之外）的文件则保持缺席。
      const read = Effect.fn("ConfigInstructionPlugin.read")(function* (filepath: string) {
        return yield* fs.readFileString(filepath).pipe(
          // 读取成功时构造指令文件对象。
          Effect.map((content) => new InstructionDiscovery.File({ path: filepath, content })),
          // 缺失或被拒读时降级处理。
          Effect.catchIf(
            (error) => error.reason._tag === "NotFound" || FSUtil.isAccessDenied(error),
            (error) =>
              // 记调试日志；缺失返回 undefined，被拒返回 "denied"。
              Effect.logDebug("instruction file skipped", { path: filepath, reason: error.reason._tag }).pipe(
                Effect.as(error.reason._tag === "NotFound" ? undefined : ("denied" as const)),
              ),
          ),
        )
      })

      // 全局来源：读取全局 AGENTS.md。
      const globalSource = Effect.fn("ConfigInstructionPlugin.globalSource")(function* () {
        // 未启用全局发现或文件不存在时返回空。
        if (!discovery.global || !(yield* fs.isFile(globalFile))) return []
        // 读取文件。
        const file = yield* read(globalFile)
        // 读取成功才返回。
        return file instanceof InstructionDiscovery.File ? [file] : []
      })

      // 项目来源：从当前目录向上收集各级 AGENTS.md。
      const projectSource = Effect.fn("ConfigInstructionPlugin.projectSource")(function* () {
        // 未启用项目发现返回空。
        if (!project) return []
        // 从当前目录向上查找 AGENTS.md 并解析真实路径。
        const walked = yield* Effect.forEach(
          yield* fs.up({ targets: ["AGENTS.md"], start, stop, type: "file" }),
          fs.resolve,
        )
        // 去重；global: false 时排除全局文件。
        const discovered = new Set(walked.filter((file) => discovery.global || file !== globalFile))
        // 并发读取全部文件。
        const files = yield* Effect.forEach(discovered, read, { concurrency: "unbounded" })
        // 任一文件返回 undefined（暂态缺失）时整体视为不可用。
        if (files.some((file) => file === undefined)) return Instructions.unavailable
        // 过滤出读取成功的文件。
        return files.filter((file) => file instanceof InstructionDiscovery.File)
      })

      // Relative patterns search upward from the location to the project root. Without
      // project discovery they resolve against the global config directory instead.
      // 解析一个配置的来源模式为具体文件列表：相对模式从位置向上搜到项目根；
      // 没有项目发现时改为相对全局配置目录解析。
      const match = Effect.fn("ConfigInstructionPlugin.match")(function* (source: string) {
        // 展开 ~ 前缀为用户主目录。
        const expanded = source.startsWith("~/") ? path.join(global.home, source.slice(2)) : source
        // 扫描选项：绝对路径、只含文件、包含点文件。
        const options = { absolute: true, include: "file", dot: true } as const
        // 绝对路径模式。
        if (path.isAbsolute(expanded)) {
          // Keep literal directories working as before. When no literal parent exists, treat
          // the whole source as a glob (`~/notes/**/*.md`) with `/` separators.
          // 字面目录保持原有行为；父目录不存在时把整个来源当作 glob（~/notes/**/*.md），分隔符统一为 /。
          const directory = path.dirname(expanded)
          // 检查字面父目录是否存在。
          const hasLiteralParent = yield* fs.isDir(directory)
          // 按两种策略扫描（有字面父目录时只扫描 basename 并限定其目录）。
          return yield* fs
            .scan(hasLiteralParent ? path.basename(expanded) : expanded.replaceAll(path.sep, "/"), {
              ...options,
              ...(hasLiteralParent ? { cwd: directory } : {}),
            })
            .pipe(Effect.orElseSucceed(() => [] as string[]))
        }
        // 相对模式且启用项目发现：从当前目录向上匹配到项目根。
        if (project) return yield* fs.globUp(expanded, start, root)
        // 项目与全局发现都关闭：返回空。
        if (!discovery.global) return []
        // 相对全局配置目录扫描。
        return yield* fs
          .scan(expanded, { ...options, cwd: global.config })
          .pipe(Effect.orElseSucceed(() => [] as string[]))
      })

      // 配置来源：解析 configured.sources 中的每个条目并维护对应的文件监视。
      const configuredSource = Effect.fn("ConfigInstructionPlugin.configuredSource")(function* () {
        // 收集到的文件。
        const files: InstructionDiscovery.File[] = []
        // 本轮实际监视的路径集合。
        const watched = new Set<string>()
        // 逐个来源处理。
        for (const source of configured.sources) {
          // URL 来源：直接使用已抓取的内容。
          if (isUrl(source)) {
            const file = configured.remote.get(source)
            if (file) files.push(file)
            continue
          }
          // 文件模式：解析出的每个文件排序后读取。
          for (const item of (yield* match(source)).toSorted()) {
            // 解析真实路径。
            const resolved = yield* fs.resolve(item)
            // 已监视过的跳过。
            if (watched.has(resolved)) continue
            // 记入监视集合。
            watched.add(resolved)
            // 读取文件。
            const file = yield* read(resolved)
            // 读取成功才收集。
            if (file instanceof InstructionDiscovery.File) files.push(file)
          }
        }
        // 移除不再需要的旧监视。
        for (const [key] of Array.from(watches)) if (!watched.has(key)) yield* FiberMap.remove(watches, key)
        // 为每个监视的文件订阅更新（已存在的不重复）。
        for (const file of watched) {
          const updates = yield* watcher.subscribe({ path: file, type: "file" })
          yield* FiberMap.run(watches, file, updates.pipe(Stream.runForEach(publish)), {
            onlyIfMissing: true,
            startImmediately: true,
          })
        }
        // 返回收集的文件。
        return files
      })

      // Remote instructions are fetched only when config loads, not on every file rescan.
      // A failed fetch keeps the last good copy or skips the URL, so an unreachable URL
      // never makes the whole instruction set unavailable.
      // 重新读取配置：远程指令只在配置加载时抓取，而非每次文件重扫；抓取失败保留上一份好副本或跳过该 URL，
      // 因此不可达的 URL 永远不会让整套指令变为不可用。
      const reconfigure = Effect.fn("ConfigInstructionPlugin.reconfigure")(
        function* () {
          // 读取当前配置条目。
          const entries = yield* config.entries()
          // 汇总所有文档的 instructions 列表并去重。
          const sources = Array.from(
            new Set(entries.flatMap((entry) => (entry.type === "document" ? (entry.info.instructions ?? []) : []))),
          )
          // 并发（最多 4）抓取所有 URL 来源。
          const fetched = yield* Effect.forEach(
            sources.filter(isUrl),
            (url) =>
              HttpClientRequest.get(url).pipe(
                // 执行 GET 请求。
                http.execute,
                // 取响应文本。
                Effect.flatMap((response) => response.text),
                // 限时 5 秒。
                Effect.timeout("5 seconds"),
                // 成功时构造指令文件对象。
                Effect.map((content) => new InstructionDiscovery.File({ path: url, content })),
                // 失败记警告并回退到上一次的内容。
                Effect.catchCause((cause) =>
                  Effect.logWarning("failed to fetch instruction url", { url, cause }).pipe(
                    Effect.as(configured.remote.get(url)),
                  ),
                ),
              ),
            { concurrency: 4 },
          )
          // 记录本轮来源列表。
          configured.sources = sources
          // 记录抓取成功的远程内容映射。
          configured.remote = new Map(
            fetched.filter((file) => file !== undefined).map((file) => [file.path, file] as const),
          )
        },
        // 持锁串行化。
        (effect) => lock.withPermit(effect),
      )

      // 隔离单个来源的失败：出错记警告并把该来源视为不可用，不影响其他来源。
      const isolate = <A, E, R>(source: string, effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to load instruction source", { source, cause }).pipe(
              Effect.as(Instructions.unavailable),
            ),
          ),
        )

      // 总刷新：并发收集三个来源并更新状态容器。
      const refresh = Effect.fn("ConfigInstructionPlugin.refresh")(
        function* (file?: string) {
          // 并发收集三个来源（各自隔离失败）。
          const sources = yield* Effect.all({
            global: isolate("global", globalSource()),
            project: isolate("project", projectSource()),
            configured: isolate("configured", configuredSource()),
          })
          // 三者都是数组（未失败）才可用；否则整体不可用。
          loaded.current =
            Array.isArray(sources.global) && Array.isArray(sources.project) && Array.isArray(sources.configured)
              ? { type: "available", files: [...sources.global, ...sources.project, ...sources.configured] }
              : { type: "unavailable" }
          // 没有触发文件时到此为止。
          if (!file) return
          // 有触发文件时记调试日志（列出当前指令文件）。
          yield* Effect.logDebug("instructions rescanned", {
            file,
            instructions:
              loaded.current.type === "available" ? loaded.current.files.map((item) => item.path) : "unavailable",
          })
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
        // 每次触发：刷新并重载指令发现。
        Stream.runForEach((file) => refresh(file).pipe(Effect.andThen(discovery.reload()))),
        Effect.forkScoped({ startImmediately: true }),
      )
      // Subscribe before the first config read so an update in between still triggers a reload.
      // 订阅 config.updated：先订阅再读配置，期间的更新也能触发重载。
      yield* ctx.event.subscribe({ types: ["config.updated"] }).pipe(
        Stream.runForEach(() => reconfigure().pipe(Effect.andThen(refresh()), Effect.andThen(discovery.reload()))),
        Effect.forkScoped({ startImmediately: true }),
      )
      // 启动时读取一次配置来源。
      yield* reconfigure()
      // 启动时刷新一次。
      yield* refresh()
      // 把结果写入指令发现编辑器。
      yield* discovery.transform((editor) => {
        // 整体不可用时标记。
        if (loaded.current.type === "unavailable") {
          editor.unavailable()
          return
        }
        // 否则逐个加入指令文件。
        for (const file of loaded.current.files) editor.add(file)
      })
    }).pipe(
      // 整个激活流程失败：记警告并把指令发现标记为不可用。
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to activate instruction source", { cause }).pipe(
          Effect.andThen(discovery.transform((editor) => editor.unavailable())),
          Effect.asVoid,
        ),
      ),
    )
  }),
})

// `start` keeps the client's spelling while `stop` may come from git, so a Windows drive
// letter can differ only in case (`c:\repo` vs `C:\repo`). Compare the way FSUtil.contains
// admitted `start` beneath `stop`, or the walk passes `stop` and recurses at the drive root.
// 枚举 start 到 stop 的祖先目录。start 保留客户端拼写而 stop 可能来自 git，
// Windows 盘符可能仅大小写不同（c:\repo 与 C:\repo）。要按 FSUtil.contains 接纳 start 的方式比较，
// 否则遍历会越过 stop 并在盘符根无限递归。
function ancestorDirectories(start: string, stop: string): string[] {
  // 已到终点：只返回自身。
  if (sameDirectory(start, stop)) return [start]
  // 否则返回自身加父级链。
  return [start, ...ancestorDirectories(dirname(start), stop)]
}

// 判断字符串是否为 http/https URL。
function isUrl(source: string) {
  return URL.canParse(source) && /^https?:$/.test(new URL(source).protocol)
}
