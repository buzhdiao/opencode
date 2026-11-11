// 快照引擎的基准测试定义（strobe bench 文件）：测量捕获/列变更/diff/恢复/打包各类操作
// 在不同规模仓库上的耗时与 git 进程数。被测脚本宿主为同目录 ./snapshot.ts（strobe 每个 block
// 加载一次，ctx.call 调用其导出）；fixture 准备与生成见 snapshot.ts。
// 导入 strobe 的 bench 定义器、script 目标构造器与 Context 类型
import { bench, script, type Context } from "@hona/strobe"

// bench 定义的上下文类型：带 fixture 字符串参数
type Ctx = Context<{ fixture: string }>

// Snapshot work spawns git: its time is the run's wall time (a child's CPU leaves with the child), and
// `count.git` is how many processes it spawned.
// （上方英文注释原样保留：快照工作会拉起 git 子进程——子进程的 CPU 随子进程离开，所以时间只按
// 挂钟计时；count.git 记录它拉起了多少个进程。）
// 辅助：调一次脚本宿主操作并把返回的 git 进程数记入计数器
const git = (ctx: Ctx, call: string, ...args: unknown[]) =>
  ctx.call<number>(call, ...args).then((n) => ctx.count("git", n))

// What each case needs in place before its first run; `reset` repeats it between runs.
// （上方英文注释原样保留：各用例首次 run 前需要就位的状态；reset 在每轮 run 之间重复同样的操作。）
// 用例名 → 首次 run 前的准备动作（编辑/新增文件、做一次前后捕获、攒历史等）
const before: Record<string, (ctx: Ctx) => Promise<unknown>> = {
  // 编辑 1 个被跟踪文件（测"有改动时捕获"）
  "capture after editing a file": (ctx) => ctx.call("edit", 1),
  // 新增 1 个文件
  "capture after adding a file": (ctx) => ctx.call("add"),
  // 编辑 100 个文件
  "capture after editing 100 files": (ctx) => ctx.call("edit", 100),
  // 做前后两次捕获（中间改 100 个文件），供列变更/diff 用
  "list 100 changed files": (ctx) => ctx.call("change"),
  // 同上（diff 用）
  "diff 100 changed files": (ctx) => ctx.call("change"),
  // 先做一次基准捕获（mark），再改 100 个文件，供"恢复 100 个文件"用
  "restore 100 files": async (ctx) => {
    // 基准捕获
    await ctx.call("mark")
    // 制造 100 个文件改动
    await ctx.call("edit", 100)
  },
  // 攒出有历史可打包的存储：十次"改 100 文件 + 捕获"
  "pack the store": (ctx) => ctx.call("history"),
}

// 通用指标配置：主指标挂钟时间，附加 git 进程数
const timed = { primary: "run.duration", metrics: ["count.git"] }

// 导出 bench 定义：单目标 core（./snapshot.ts 脚本宿主），十个测量用例
export default bench({
  // 被测目标：名为 core 的脚本宿主，指向同目录的 snapshot.ts
  targets: { core: script("./snapshot.ts") },
  // Generated repositories: 1,000, 20,000 or 100,000 tracked files, or this repository cloned.
  // （上方英文注释原样保留：生成的仓库——1 000/20 000/100 000 个被跟踪文件，或克隆本仓库。）
  // 参数：默认跑 medium（2 万跟踪 + 2 万忽略文件）；more 可选 small/large/opencode 克隆
  params: { fixture: { run: ["medium"], more: ["small", "large", "opencode"] } },
  // 每个用例前的准备：准备 fixture（重置到首个提交、开新存储），再做该用例的 before 动作
  async setup(ctx) {
    // 调脚本宿主的 prepare：fixture 就位 + 首次捕获建存储
    await ctx.call("prepare", ctx.params.fixture)
    // 若该用例在 before 表里有准备动作则执行
    await before[ctx.case]?.(ctx)
  },
  // 测量用例
  cases: {
    // 用例：无改动时捕获（纯遍历成本）
    "capture, nothing changed": { ...timed, run: (ctx) => git(ctx, "capture") },
    // Eight sessions in one project capturing at once share the project's store.
    // （上方英文注释原样保留：同一项目的八个会话同时捕获，共享项目的存储。）
    // 用例：8 个捕获并发（测共享存储上的并发捕获）
    "8 captures at once, nothing changed": { ...timed, run: (ctx) => git(ctx, "captureMany", 8) },
    // 用例：编辑 1 个文件后捕获；reset 重新编辑，保持每轮状态一致
    "capture after editing a file": {
      ...timed,
      run: (ctx) => git(ctx, "capture"),
      reset: (ctx) => ctx.call("edit", 1),
    },
    // 用例：新增 1 个文件后捕获
    "capture after adding a file": { ...timed, run: (ctx) => git(ctx, "capture"), reset: (ctx) => ctx.call("add") },
    // 用例：编辑 100 个文件后捕获（大量变更的捕获成本）
    "capture after editing 100 files": {
      ...timed,
      run: (ctx) => git(ctx, "capture"),
      reset: (ctx) => ctx.call("edit", 100),
    },
    // 用例：列出两次捕获间变更的 100 个文件
    "list 100 changed files": { ...timed, run: (ctx) => git(ctx, "files") },
    // 用例：对两次捕获做 diff
    "diff 100 changed files": { ...timed, run: (ctx) => git(ctx, "diff") },
    // 用例：把 100 个文件恢复到基准捕获
    "restore 100 files": { ...timed, run: (ctx) => git(ctx, "restore"), reset: (ctx) => ctx.call("edit", 100) },
    // 20 agent steps: a capture at attempt start and at settlement, changed files listed; one step in
    // five edits two files.
    // （上方英文注释原样保留：20 个 agent 步——每步在尝试开始与结算时各捕获一次并列出变更文件；
    // 每五步有一步编辑两个文件。）
    // 用例：agent 步循环（贴近真实会话的快照负载）
    "agent step loop": { ...timed, run: (ctx) => git(ctx, "agentLoop") },
    // Loose objects of ten captures into a pack; `count.store.kib` is the store's size after.
    // （上方英文注释原样保留：把十次捕获的松散对象打成 pack；count.store.kib 是打包后的存储大小。）
    // 用例：打包存储（git gc 式 pack）；附加指标记打包后存储大小（KiB）
    "pack the store": {
      primary: "run.duration",
      metrics: ["count.git", "count.store.kib"],
      async run(ctx) {
        // 调 pack：返回 git 进程数与存储大小（KiB）
        const packed = await ctx.call<{ git: number; kib: number }>("pack")
        // 记 git 进程数
        ctx.count("git", packed.git)
        // 记存储大小
        ctx.count("store.kib", packed.kib)
      },
      // reset：用未打包的副本重置存储，供下一轮打包
      reset: (ctx) => ctx.call("unpack"),
    },
  },
})
