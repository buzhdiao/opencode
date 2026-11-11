// Snapshot capture, listing, diff, restore and packing against generated repositories, and a scripted
// agent session with snapshots on or off. strobe's script host loads this module once per block and
// calls its exports (perf/snapshot.bench.ts, perf/session.bench.ts). Each operation returns how many
// git processes it spawned, an exact count next to its time.
//
// Fixtures are generated once under $SNAPSHOT_BENCH_ROOT (default the temp folder) by running this file
// (`bun packages/core/perf/snapshot.ts medium`), and reset to their first commit when a block prepares one. The
// snapshot store is a fresh folder per block.
// （上方英文注释原样保留：对生成仓库做快照的捕获/列变更/diff/恢复/打包，外加快照开关两种模式的
// 脚本化 agent 会话。strobe 的脚本宿主每个 block 加载本模块一次，调用其导出（供
// perf/snapshot.bench.ts 与 perf/session.bench.ts 测量）。每个操作返回它拉起了多少个 git 进程，
// 作为挂在耗时旁边的精确计数。
// fixture 由本文件生成一次（`bun packages/core/perf/snapshot.ts medium`），存放在
// $SNAPSHOT_BENCH_ROOT（默认临时目录）下；block 准备时会把 fixture 重置回首个提交；
// 快照存储每个 block 用一个全新目录。）
// 导入 Bun 的模板字符串 shell（$）：直接驱动 git 命令（生成 fixture、重置、ls-files 等）
import { $ } from "bun"
// 导入 fs/promises：异步文件操作（建目录、读写、删目录）
import fs from "fs/promises"
// 导入同步文件工具：mkdirSync 建根目录、realpathSync 解析真实路径、rmSync 退出时清理
import { mkdirSync, realpathSync, rmSync } from "fs"
// 导入 os：取系统临时目录
import os from "os"
// 导入 path：拼接各路径
import path from "path"
// 导入 LLMEvent 类型：会话基准中 TestLLM 推流的事件类型
import type { LLMEvent } from "@opencode/ai/effect"
// 导入 Global 服务：进程级全局目录（bench 用临时目录替换）
import { Global } from "@opencode/util/global"
// 导入 AppProcess 服务：子进程执行抽象（bench 用计数版包装统计 git 拉起次数）
import { AppProcess } from "@opencode/util/process"
// 导入 Effect 栈：Layer 组合、Logger 静默、ManagedRuntime 承载运行时、Stream 处理 LLM 事件流
import { Effect, Layer, Logger, ManagedRuntime, Stream } from "effect"
// 导入 AppNodeBuilder：按服务分组 + 替换清单组装应用节点层
import { AppNodeBuilder } from "../src/effect/app-node-builder"
// 导入 Git 服务：打包用例直接调用其对象打包（git gc 式 pack）
import { Git } from "../src/git"
// 导入 Location：目录引用（快照绑定到某个目录）
import { Location } from "../src/location"
// 导入路径品牌类型：AbsolutePath 绝对路径、RelativePath 相对路径
import { AbsolutePath, RelativePath } from "../src/schema"
// 导入 Snapshot：被测的快照服务（捕获/列变更/diff/恢复）
import { Snapshot } from "../src/snapshot"

// The real path: Snapshot compares a location with its worktree's real path, and macOS's temp folder is a symlink
// (/var/folders/… is /private/var/folders/…), so a fixture under it would read as outside its own project.
// （上方英文注释原样保留：用真实路径——Snapshot 会拿目录与它 worktree 的真实路径作比较，而 macOS 的
// 临时目录是符号链接（/var/folders/… 实为 /private/var/folders/…），fixture 若放在链接路径下会被判为
// "在自己的项目之外"。）
// fixture 根目录：可用环境变量 SNAPSHOT_BENCH_ROOT 覆盖，默认系统临时目录
const base = process.env.SNAPSHOT_BENCH_ROOT ?? os.tmpdir()
// 确保根目录存在
mkdirSync(base, { recursive: true })
// 本 bench 的实际工作根：根目录解析真实路径后的 opencode-snapshot-bench 子目录
const root = path.join(realpathSync(base), "opencode-snapshot-bench")

// 生成式 fixture 规格：名字 → 被跟踪文件数 / 忽略文件数 / 目录数
const fixtures: Record<string, { tracked: number; ignored: number; dirs: number }> = {
  // small：1 000 个跟踪文件，无忽略文件，20 个目录
  small: { tracked: 1_000, ignored: 0, dirs: 20 },
  // medium：2 万跟踪 + 2 万忽略（node_modules 形态），400 个目录
  medium: { tracked: 20_000, ignored: 20_000, dirs: 400 },
  // large：10 万跟踪 + 5 万忽略，2 000 个目录
  large: { tracked: 100_000, ignored: 50_000, dirs: 2_000 },
}

// git 进程计数器：所有经 countingProcess 的子进程都会累加
let spawns = 0
// 计数版 AppProcess 层：包装真实服务，run 前先把计数加一再透传（其余行为不变）
const countingProcess = Layer.effect(
  AppProcess.Service,
  Effect.gen(function* () {
    // 先取真实实现
    const real = yield* AppProcess.Service
    // 返回包装后的服务：只劫持 run 一个方法
    return AppProcess.Service.of({
      ...real,
      run: (command, options) => {
        // 计数加一（命令即将拉起一个子进程）
        spawns++
        // 透传给真实实现
        return real.run(command, options)
      },
    })
  }),
).pipe(Layer.provide(AppNodeBuilder.build(AppProcess.node)))

// 构建快照层：Snapshot 服务绑定到指定目录与数据目录，进程替换为计数版，日志静默
const snapshotLayer = (data: string, directory: string) =>
  AppNodeBuilder.build(Snapshot.node, [
    // Location 替换：把快照服务绑定到固定目录引用
    Location.node.replace(Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(directory) }))),
    // Global 替换：数据/配置目录都落在 data 下（每 block 全新）
    Global.node.replace(Global.layerWith({ data, config: path.join(data, "config") })),
    // AppProcess 替换：换上计数版，统计 git 拉起次数
    AppProcess.node.replace(countingProcess),
  ]).pipe(Layer.provide(Logger.layer([])))

// block 级可变状态：当前 fixture、数据目录、文件样本、运行时、基准/目标捕获 ID、编辑计数、存储路径
const state: {
  // fixture 工作目录（git 仓库）
  dir: string
  // 快照数据目录（存储所在）
  data: string
  // 被跟踪文件的均匀抽样（编辑/恢复用）
  sample: string[]
  // 快照服务的长驻运行时（prepare 时创建）
  runtime?: ManagedRuntime.ManagedRuntime<Snapshot.Service, never>
  // 基准捕获的树 ID（列变更/diff/恢复的 from）
  before?: Snapshot.ID
  // 目标捕获的树 ID（to）
  after?: Snapshot.ID
  // 已做的编辑轮次（生成不重复的标记）
  edits: number
  // 打包用例的存储路径
  store?: string
} = { dir: "", data: "", sample: [], edits: 0 }

// 进程退出时清理：删数据目录与打包副本（无论成败）
process.on("exit", () => {
  // 数据目录（含快照存储）
  if (state.data) rmSync(state.data, { recursive: true, force: true })
  // 打包用例复制的存储副本
  if (state.store) rmSync(`${state.store}-work`, { recursive: true, force: true })
})

// 在长驻运行时里跑一段快照操作：从运行时取 Snapshot.Service，交给 body 使用
const snapshot = <A, E>(body: (snapshot: Snapshot.Interface) => Effect.Effect<A, E>) => {
  // 尚未 prepare 过则直接报错（脚手架顺序错误）
  if (!state.runtime) throw new Error("prepare a fixture first")
  // 运行并转 Promise
  return state.runtime.runPromise(Effect.flatMap(Snapshot.Service, body))
}

// The spawned git processes of `body`, an exact count per run.
// （上方英文注释原样保留：body 执行期间拉起的 git 进程数——每次 run 的精确计数。）
// 辅助：记录 body 前后的计数差，作为该操作的 git 进程数
const counted = async (body: () => Promise<unknown>) => {
  // 起点计数
  const before = spawns
  // 执行操作
  await body()
  // 返回增量
  return spawns - before
}

/** Resets the fixture and opens a fresh snapshot store on it; the first capture creates the store. */
// （上方英文文档注释原样保留：重置 fixture 并在其上开一个全新快照存储；首次捕获创建存储。）
// 导出 prepare：bench 每个 block 的入口——fixture 就位、抽样、起运行时、建初始存储
export async function prepare(fixture: string) {
  // fixture 目录：工作根下 fixtures/<名字>
  const dir = path.join(root, "fixtures", fixture)
  // 未生成过（没有 .bench-ready 标记）则报错，提示先手动生成一次
  if (!(await Bun.file(path.join(dir, ".bench-ready")).exists()))
    throw new Error(
      `fixture ${fixture} is not generated yet: run \`bun packages/core/perf/snapshot.ts ${fixture}\` once`,
    )
  // 记下 fixture 目录
  state.dir = dir
  // 重置回首个提交（清掉上次 bench 的编辑）
  await reset(state.dir)
  // 开一个全新的数据目录（快照存储每个 block 一份）
  state.data = await fs.mkdtemp(path.join(root, "data-"))
  // 从被跟踪文件里均匀抽 100 个样本（编辑/恢复都动它们）
  state.sample = await trackedSample(state.dir, 100)
  // 起快照服务的长驻运行时（与生产一样长驻，考验进程内缓存）
  state.runtime = ManagedRuntime.make(snapshotLayer(state.data, state.dir) as Layer.Layer<Snapshot.Service>)
  // 先捕获一次：创建存储并建立基线
  await capture()
}

// 导出 capture：无参捕获一次，返回 git 进程数；捕获必须返回树 ID（undefined 视为内部错误）
export const capture = () =>
  counted(() =>
    snapshot((s) =>
      s
        .capture()
        .pipe(Effect.flatMap((id) => (id ? Effect.succeed(id) : Effect.die(new Error("capture returned undefined"))))),
    ),
  )

/** `count` captures at once on one store, as sessions in one project capture when their steps start together. */
// （上方英文文档注释原样保留：在同一存储上并发 count 次捕获——如同一个项目的多个会话步骤同时开始捕获。）
// 导出 captureMany：并发捕获 count 次（并发争用同一存储）
export const captureMany = (count: number) =>
  counted(() => Promise.all(Array.from({ length: count }, () => snapshot((s) => s.capture()))))

/** Edits `count` tracked files (spread across the tree). */
// （上方英文文档注释原样保留：编辑 count 个被跟踪文件（散布在目录树各处）。）
// 导出 edit：改样本里的前 count 个文件，内容带轮次标记（保证每次都是真实变更）
export async function edit(count: number) {
  // 本轮编辑的标记（也用于生成不重复内容）
  const tag = `edit-${state.edits++}`
  // 并发写入：每个文件内容 = 标记行 + 文件路径行
  await Promise.all(
    state.sample.slice(0, count).map((file) => Bun.write(path.join(state.dir, file), `// ${tag}\n${file}\n`)),
  )
}

/** Adds one new file. */
// （上方英文文档注释原样保留：新增一个文件。）
// 导出 add：在 src/ 下新增一个带序号的新文件
export async function add() {
  // 写入 src/new-<序号>.ts
  await Bun.write(path.join(state.dir, "src", `new-${state.edits++}.ts`), "new\n")
}

/** A capture before and after editing 100 files, for listing and diffing the change. */
// （上方英文文档注释原样保留：编辑 100 个文件前后各捕获一次，供列变更与 diff 用。）
// 导出 change：记录基准捕获 → 制造 100 个改动 → 记录目标捕获
export async function change() {
  // 基准捕获（from）
  state.before = await snapshot((s) => s.capture())
  // 制造改动
  await edit(100)
  // 目标捕获（to）
  state.after = await snapshot((s) => s.capture())
}

/** The capture `restore` puts files back to. */
// （上方英文文档注释原样保留：restore 把文件恢复到的那个捕获。）
// 导出 mark：只做基准捕获（恢复用例的准备步骤）
export async function mark() {
  // 基准捕获存入 before
  state.before = await snapshot((s) => s.capture())
}

// 导出 files：列出 before → after 的变更文件（返回 git 进程数）
export const files = () => counted(() => snapshot((s) => s.files({ from: state.before!, to: state.after! })))

// 导出 diff：对 before → after 做差异（返回 git 进程数）
export const diff = () => counted(() => snapshot((s) => s.diff({ from: state.before!, to: state.after! })))

// 导出 restore：把全部样本文件恢复到 before 捕获（返回 git 进程数）
export const restore = () =>
  counted(() =>
    snapshot((s) =>
      s.restore({ files: new Map(state.sample.map((file) => [RelativePath.make(file), state.before!] as const)) }),
    ),
  )

/**
 * A read-mostly agent loop under the step policy, 20 steps: capture at attempt start, capture at
 * settlement, then list changed files. One step in five edits two files.
 */
// （上方英文文档注释原样保留：贴近步进策略的读多写少 agent 循环，20 步：尝试开始捕获、结算捕获、
// 再列变更文件；每五步有一步编辑两个文件。）
// 导出 agentLoop：模拟真实会话的快照负载节奏
export const agentLoop = () =>
  counted(async () => {
    // 20 步循环
    for (let index = 0; index < 20; index++) {
      // 步开始捕获（from）
      const from = await snapshot((s) => s.capture())
      // 每五步中的第一步（index % 5 == 0）编辑两个文件
      if (index % 5 === 0) await edit(2)
      // 步结算捕获（to）
      const to = await snapshot((s) => s.capture())
      // 树有变化才列变更文件（无变化时生产代码也会跳过）
      if (from !== to) await snapshot((s) => s.files({ from: from!, to: to! }))
    }
  })

/** A store with history to pack: ten captures of 100 edited files, copied aside untouched. */
// （上方英文文档注释原样保留：攒出一个有历史可打包的存储：十轮"编辑 100 个文件 + 捕获"，
// 然后原样复制一份副本。）
// 导出 history：制造打包用例的存储状态
export async function history() {
  // 十轮编辑 + 捕获，产生大量松散对象
  for (let index = 0; index < 10; index++) {
    // 编辑 100 个文件
    await edit(100)
    // 捕获一次
    await snapshot((s) => s.capture())
  }
  // 数据目录下 snapshot/ 的第一个项目目录（存储按项目分目录）
  const project = (await fs.readdir(path.join(state.data, "snapshot")))[0]!
  // 该项目下的存储列表
  const stores = await fs.readdir(path.join(state.data, "snapshot", project))
  // 记下存储路径（打包对象）
  state.store = path.join(state.data, "snapshot", project, stores[0]!)
  // 立即复制一份未打包副本（原始存储保持原样，便于反复打包）
  await unpack()
}

/** Puts the unpacked copy of the store back, for the next packing. */
// （上方英文文档注释原样保留：重新放回未打包的存储副本，供下一次打包。）
// 导出 unpack：删旧副本，从原始存储重新复制（打包用例的 reset）
export async function unpack() {
  // 删掉上一轮的打包副本
  await fs.rm(`${state.store}-work`, { recursive: true, force: true })
  // 从原始存储完整复制出工作副本
  await fs.cp(state.store!, `${state.store}-work`, { recursive: true })
}

/** Packs the store copy's loose objects; returns the git processes and the store's size after (KiB). */
// （上方英文文档注释原样保留：打包存储副本里的松散对象；返回 git 进程数与打包后的存储大小（KiB）。）
// 导出 pack：对副本执行 git 对象打包，返回 { git 进程数, 存储大小 KiB }
export async function pack() {
  // 打包对象：存储副本路径（绝对）
  const store = AbsolutePath.make(`${state.store}-work`)
  // 计数执行打包（独立提供 Git 层与计数版进程层）
  const git = await counted(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        // 取 Git 服务
        const git = yield* Git.Service
        // 对该仓库做对象打包（worktree 指向 fixture，git 目录指向存储副本）
        yield* git.objects.pack(
          new Git.Repository({ worktree: AbsolutePath.make(state.dir), gitDirectory: store, commonDirectory: store }),
        )
      }).pipe(
        // 单独组装 Git 层，进程仍走计数版
        Effect.provide(AppNodeBuilder.build(Git.node, [AppProcess.node.replace(countingProcess)])),
        // 日志静默
        Effect.provide(Logger.layer([])),
      ),
    ),
  )
  // 返回 git 进程数与打包后的存储大小（字节转 KiB 取整）
  return { git, kib: Math.round((await size(store)) / 1024) }
}

// 递归统计目录总字节数（目录项并发取 stat）
async function size(dir: string): Promise<number> {
  // 列目录（带类型）
  const entries = await fs.readdir(dir, { withFileTypes: true })
  // 并发取每项大小：目录递归，文件 stat
  const sizes = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory() ? size(path.join(dir, entry.name)) : fs.stat(path.join(dir, entry.name)).then((s) => s.size),
    ),
  )
  // 求和
  return sizes.reduce((total, n) => total + n, 0)
}

// A read-heavy coding loop: explore, edit, run checks, answer.
// （上方英文注释原样保留：读多写少的编码循环——探索、编辑、跑检查、作答。）
// 会话脚本：15 个工具调用步的序列（read/grep/glob/edit/shell/text），模拟典型 agent 行为
const trace = [
  "read",
  "grep",
  "read",
  "glob",
  "read",
  "edit",
  "shell",
  "read",
  "edit",
  "shell",
  "grep",
  "read",
  "edit",
  "shell",
  "text",
] as const

/**
 * One agent session through the real SessionStep.attempt: the scripted trace, each model response
 * after `ttft` ms, with snapshots on (a real store) or off. The difference between the two is what
 * snapshots add to a session's wall time.
 */
// （上方英文文档注释原样保留：一次走真实 SessionStep.attempt 的 agent 会话——按脚本 trace 执行，
// 每次模型响应延迟 ttft 毫秒到达，快照开（真实存储）或关。两者之差即快照给会话挂钟时间增加的量。）
// 导出 session：跑一次脚本化会话，返回会话拉起的 git 进程数
export async function session(snapshots: "on" | "off", ttft: number) {
  // Loaded here, not at the top: the snapshot cases then load at git refs whose session and model
  // APIs differ, and the first session call (a warmup run) pays for the import.
  // （上方英文注释原样保留：在这里而非文件顶部加载——快照用例继续跑在不含会话/模型 API 的 git 引用上，
  // 首次会话调用（预热轮）支付 import 成本。）
  // 以下动态导入会话所需模块（只在会话用例用到，快照用例不支付成本）
  // AI 效果层：ai 请求构造器与 LanguageModel 模型描述
  const { ai, LanguageModel } = await import("@opencode/ai/effect")
  // OpenAI Chat 协议：基准模型的路由（决定请求编码形态）
  const { OpenAIChat } = await import("@opencode/ai/protocols/openai-chat")
  // 测试用 LLM：脚本化推送响应、无需真实网络
  const { TestLLM } = await import("@opencode/ai/testing")
  // LayerNode：Effect 层分组抽象（组装会话运行时的层）
  const { LayerNode } = await import("@opencode/util/effect/layer-node")
  // Money：美元每百万 token 的成本类型（给基准模型定价）
  const { Money } = await import("@opencode/schema/money")
  // Agent：默认 agent ID（尝试参数用）
  const { Agent } = await import("../src/agent")
  // Bus：事件总线（会话事件流）
  const { Bus } = await import("../src/bus")
  // Database：SQLite 数据库服务（建会话/项目记录）
  const { Database } = await import("../src/database/database")
  // Project：项目 ID 常量（全局项目）
  const { Project } = await import("../src/project")
  // ProjectTable：项目表的 drizzle 表定义（插桩数据）
  const { ProjectTable } = await import("../src/project/sql")
  // Session：会话 ID 生成
  const { Session } = await import("../src/session")
  // SessionMessage：会话消息 ID 生成
  const { SessionMessage } = await import("../src/session/message")
  // SessionProjector：会话投影（读模型物化层）
  const { SessionProjector } = await import("../src/session/projector")
  // SessionRunnerModel：把模型描述解析为运行时模型的辅助
  const { SessionRunnerModel } = await import("../src/session/runner/model")
  // SessionStep：被测的会话步进器（真实 attempt 流程）
  const { SessionStep } = await import("../src/session/runner/step")
  // SessionTable：会话表的 drizzle 表定义（插桩数据）
  const { SessionTable } = await import("../src/session/sql")
  // ToolOutput：工具输出服务（会话运行时依赖）
  const { ToolOutput } = await import("../src/tool-output")

  // 基准模型：id 为 bench-model 的 OpenAI Chat 路由模型，解析为运行时模型——
  // 工具开启、输入输出仅文本、上下文 10 万 token、输出上限 1 000，并给定美元定价
  const model = SessionRunnerModel.resolved(
    // 构造语言模型描述：测试提供商 + OpenAI Chat 路由
    LanguageModel.make({ id: "bench-model", provider: "test", route: OpenAIChat.route }),
    {
      // 能力：支持工具调用，输入输出均为纯文本
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      // 限制：上下文 100k token，单次输出 1 000 token
      limit: { context: 100_000, output: 1_000 },
      // 定价（美元/百万 token）：输入 1、输出 2、缓存读 0.1、缓存写 0.5
      cost: [
        {
          // 输入价格
          input: Money.USDPerMillionTokens.make(1),
          // 输出价格
          output: Money.USDPerMillionTokens.make(2),
          // 缓存读/写价格
          cache: { read: Money.USDPerMillionTokens.make(0.1), write: Money.USDPerMillionTokens.make(0.5) },
        },
      ],
    },
  )

  // 会话开始前的 git 进程计数（结束时取差值返回）
  const before = spawns
  // 快照层：on 用真实存储（绑到 fixture 与数据目录），off 用空操作层（完全不做快照）
  const layer = snapshots === "on" ? snapshotLayer(state.data, state.dir) : Snapshot.noopLayer
  // 把一次 LLM 响应包装成"延迟 ttft 毫秒后推流"的流（模拟首 token 延迟）
  const delayed = (response: ReturnType<typeof TestLLM.stop>) =>
    Stream.unwrap(Effect.sleep(ttft).pipe(Effect.as(Stream.fromIterable(response as Iterable<LLMEvent>))))
  // 运行整场会话：插桩 → 逐步推送 LLM 响应并驱动 SessionStep.attempt
  await Effect.runPromise(
    Effect.gen(function* () {
      // 取底层数据库句柄
      const db = (yield* Database.Service).db
      // 取测试 LLM 控制器（推送脚本化响应）
      const llm = yield* TestLLM.Test
      // 新会话 ID
      const sessionID = Session.ID.create()
      // 插入全局项目记录：worktree 指向 fixture；已存在则跳过
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make(state.dir), sandboxes: [] })
        .onConflictDoNothing()
        .run()
      // 插入会话记录：挂在全局项目下，目录指向 fixture
      yield* db
        .insert(SessionTable)
        .values({ id: sessionID, project_id: Project.ID.global, slug: "bench", directory: state.dir, version: "bench" })
        .run()
      // 取会话步进器服务
      const steps = yield* SessionStep.make
      // 已发生的 edit 工具调用数（决定写哪个样本文件）
      let edits = 0
      // 按脚本 trace 逐步执行
      for (const kind of trace) {
        // 本步工具调用 ID：带序号、类型与随机后缀，保证唯一
        const call = `call-${edits}-${kind}-${Math.random().toString(36).slice(2)}`
        // 预先推送本步的模型响应：text 步推文本"Done."，其余步推对应类型的工具调用
        yield* llm.push(
          delayed(
            kind === "text"
              ? TestLLM.text("Done.", `text-${call}`)
              : TestLLM.toolCall(call, kind, { path: state.sample[edits % state.sample.length] }),
          ),
        )
        // 驱动一步真实会话尝试（SessionStep.attempt 完整流程）
        yield* steps.attempt({
          // 目录始终视为打开（bench 不测关闭分支）
          isLocationClosed: () => false,
          // 会话 ID
          sessionID,
          // 本步助手消息 ID
          assistantMessageID: SessionMessage.ID.create(),
          // 默认 agent
          agent: Agent.defaultID,
          // 上面的基准模型
          model,
          // 预备好的请求上下文
          prepared: {
            // 重试前钩子：空操作
            retry: () => Effect.void,
            // 构造 AI 请求（模型 + 固定提示词）
            request: ai.request({ model: model.model, prompt: "bench" }),
            // 无附加选项
            options: {},
            // 工具执行桩：edit 真写文件（轮转样本），其余直接返回 ok
            executeTool: (input) =>
              Effect.gen(function* () {
                // edit 调用：向样本文件写入一行标记（真实落盘）
                if (input.call.name === "edit")
                  yield* Effect.promise(() =>
                    Bun.write(
                      path.join(state.dir, state.sample[edits++ % state.sample.length]!),
                      `// bench ${edits}\n`,
                    ),
                  )
                // 其他工具：返回一段文本内容
                return { content: [{ type: "text" as const, text: "ok" }] }
              }),
          },
          // 重试判定：不重试
          retry: () => Effect.succeed({ retry: false as const }),
          // 不做续跑恢复
          recoverContinuation: false,
          // 溢出时不恢复
          recoverOverflow: Effect.succeed(false),
        })
      }
    }).pipe(
      // 提供快照层（on=真实存储 / off=空操作）
      Effect.provide(layer),
      // 提供会话运行时的核心层组合 + 测试 LLM 层
      Effect.provide(
        Layer.merge(
          // 数据库/总线/会话投影/工具输出分组
          AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, SessionProjector.node, ToolOutput.node]), [
            // Bus 持久化开启（真实会话的事件落库路径）
            Bus.node.replace(Bus.configured({ persist: true })),
          ]),
          // 测试 LLM 层（响应来自上面的推送）
          TestLLM.testLayer(),
        ),
      ),
      // 日志静默
      Effect.provide(Logger.layer([])),
    ),
  )
  // 返回本场会话拉起的 git 进程数
  return spawns - before
}

/** Puts the fixture back to its commit after a session edited it. */
// （上方英文文档注释原样保留：会话编辑过 fixture 后，把它复位回提交状态。）
// 导出 resetFixture：硬重置 fixture（session 用例的 reset）
export const resetFixture = () => reset(state.dir)

// ---------- fixtures ----------

// Generated once, outside any benchmark: tens of thousands of files and their first commit take minutes on a
// machine that scans every new file. `bun packages/core/perf/snapshot.ts medium opencode`
// （上方英文注释原样保留：fixture 只生成一次、在基准测试之外——几万个文件加首次提交在会全量扫描
// 新文件的机器上要好几分钟。`bun packages/core/perf/snapshot.ts medium opencode`。）
// 直接运行本文件时进入 fixture 生成模式（不跑基准）
if (import.meta.main) {
  // 确保工作根存在
  await fs.mkdir(root, { recursive: true })
  // 依次生成命令行指定的 fixture（缺省生成 medium）
  for (const name of process.argv.slice(2).length ? process.argv.slice(2) : ["medium"]) {
    // 计时开始
    const started = performance.now()
    // opencode 是克隆本仓库，其余走生成器
    const dir = name === "opencode" ? await cloneOpencode() : await generate(name)
    // 打印结果与耗时（秒）
    console.log(`${name}: ${dir} (${((performance.now() - started) / 1000).toFixed(0)} s)`)
  }
}

// 批量写文件：先并发建齐所有父目录，再每批 512 个并发写入（避免一次性开太多 fd）
async function writeMany(files: Array<[string, string]>) {
  // 收集全部父目录并去重
  const dirs = new Set(files.map(([file]) => path.dirname(file)))
  // 并发递归建目录
  await Promise.all([...dirs].map((dir) => fs.mkdir(dir, { recursive: true })))
  // 分批并发写入
  for (let index = 0; index < files.length; index += 512)
    await Promise.all(files.slice(index, index + 512).map(([file, content]) => Bun.write(file, content)))
}

// 生成一个合成 fixture：规格来自 fixtures 表（文件数/忽略文件数/目录数）
async function generate(name: string) {
  // 查规格，未知名字直接报错
  const fixture = fixtures[name]
  if (!fixture) throw new Error(`unknown fixture ${name}: small, medium, large or opencode`)
  // fixture 目录
  const dir = path.join(root, "fixtures", name)
  // 已生成过（.bench-ready 存在）则直接复用
  if (await Bun.file(path.join(dir, ".bench-ready")).exists()) return dir
  // 清掉残留（可能上次生成中断）
  await fs.rm(dir, { recursive: true, force: true })
  // 打印生成进度
  console.error(`generating fixture ${name} (${fixture.tracked} tracked, ${fixture.ignored} ignored)`)
  // 被跟踪文件清单：src/d<目录号>/f<序号>.ts，内容为 8 行重复的导出语句（约几百字节/个）
  const tracked = Array.from({ length: fixture.tracked }, (_, index) => {
    // 文件按目录数取模散布
    const file = path.join(dir, "src", `d${index % fixture.dirs}`, `f${index}.ts`)
    // 内容重复 8 行让文件有真实体积
    return [file, `export const value${index} = ${index}\n`.repeat(8)] as [string, string]
  })
  // 忽略文件清单：node_modules/pkg<取模>/f<序号>.js——模拟装了一半的依赖树
  const ignored = Array.from({ length: fixture.ignored }, (_, index) => {
    // 500 个假包轮转
    const file = path.join(dir, "node_modules", `pkg${index % 500}`, `f${index}.js`)
    // 内容为一行 CJS 导出
    return [file, `module.exports = ${index}\n`] as [string, string]
  })
  // 写入全部文件 + .gitignore（忽略 node_modules 与 dist）
  await writeMany([...tracked, ...ignored, [path.join(dir, ".gitignore"), "node_modules\ndist\n"]])
  // git 初始化并做首次提交
  await gitInit(dir)
  // 写 .bench-ready 标记：表示 fixture 生成完成
  await Bun.write(path.join(dir, ".bench-ready"), "")
  // 返回 fixture 目录
  return dir
}

// This repository, cloned, with a realistic ignored dependency tree instead of a full install.
// （上方英文注释原样保留：克隆本仓库本身，配一个写实的忽略依赖树——而不是真的全量安装。）
// 克隆 opencode 仓库作为 opencode fixture
async function cloneOpencode() {
  // fixture 目录
  const dir = path.join(root, "fixtures", "opencode")
  // 已生成则直接复用
  if (await Bun.file(path.join(dir, ".bench-ready")).exists()) return dir
  // 清掉残留
  await fs.rm(dir, { recursive: true, force: true })
  // 找到本仓库的顶层目录（从 perf 目录向上）
  const source = (await $`git rev-parse --show-toplevel`.cwd(import.meta.dir).text()).trim()
  // 打印克隆进度
  console.error(`cloning ${source} into fixture opencode`)
  // 本地克隆（不共享硬链接，保证独立对象库）
  await $`git clone --quiet --local --no-hardlinks ${source} ${dir}`.quiet()
  // 补 3 万个 node_modules 假文件，模拟真实的忽略文件规模
  await writeMany(
    Array.from({ length: 30_000 }, (_, index) => [
      path.join(dir, "node_modules", `pkg${index % 700}`, `f${index}.js`),
      `module.exports = ${index}\n`,
    ]),
  )
  // 把 .bench-ready 加进 git 本地排除（避免污染 fixture 状态）
  await Bun.write(path.join(dir, ".git", "info", "exclude"), ".bench-ready\n")
  // 写完成标记
  await Bun.write(path.join(dir, ".bench-ready"), "")
  // 返回 fixture 目录
  return dir
}

// fixture 的 git 初始化：init、排除标记文件、全量 add（关 fsmonitor 开 fscache/preloadindex）、首次提交
async function gitInit(dir: string) {
  // 静默初始化仓库
  await $`git init -q`.cwd(dir).quiet()
  // 把 .bench-ready 写入本地排除（不算未跟踪文件）
  await Bun.write(path.join(dir, ".git", "info", "exclude"), ".bench-ready\n")
  // 全量暂存：显式关闭 fsmonitor，开启 fscache 与 preloadindex（大仓库 add 更快更稳定）
  await $`git -c core.fsmonitor=false -c core.fscache=true -c core.preloadindex=true add -A`.cwd(dir).quiet()
  // 固定身份的首次提交（无 GPG 签名，保证可复现）
  await $`git -c user.email=bench@opencode.test -c user.name=Bench commit -q --no-gpg-sign -m initial`.cwd(dir).quiet()
}

// 把 fixture 重置回首个提交：硬重置 + 清理未跟踪文件与目录
async function reset(dir: string) {
  // 硬重置（丢弃全部已跟踪改动；关 fsmonitor）
  await $`git -c core.fsmonitor=false reset -q --hard`.cwd(dir).quiet()
  // 清理未跟踪文件与空目录（-f -d）
  await $`git -c core.fsmonitor=false clean -qfd`.cwd(dir).quiet()
}

// 从被跟踪文件里均匀抽 count 个样本：只取 .ts/.md，按步长跨全树取样
async function trackedSample(dir: string, count: number) {
  // 列出全部被跟踪文件（NUL 分隔，避免特殊文件名问题）
  const text = await $`git ls-files -z`.cwd(dir).text()
  // 过滤出 .ts 与 .md 文件
  const files = text.split("\0").filter((file) => file.endsWith(".ts") || file.endsWith(".md"))
  // 步长：文件总数 / 需要的样本数（至少 1）
  const stride = Math.max(1, Math.floor(files.length / count))
  // 按步长取 count 个（取模防越界）
  return Array.from({ length: count }, (_, index) => files[(index * stride) % files.length]!)
}
