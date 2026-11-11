// Agent 会话的基准测试定义（strobe bench 文件）：测量"快照开关"对一次真实 agent 会话耗时的影响。
// 被测脚本宿主为同目录 ./snapshot.ts（strobe 每个 block 加载一次，ctx.call 调用其导出）；
// 与 perf/snapshot.bench.ts 共用 fixtures 与准备逻辑。对比 snapshots on/off 两组序列即得快照的开销，
// 对比 base/head 两次检出即可发现改动是否移动了会话耗时或 git 进程数。
// 导入 strobe 的 bench 定义器与 script 目标构造器
import { bench, script } from "@hona/strobe"

// A scripted agent session through the real SessionStep.attempt, each model response 400 ms after
// the request, with snapshots on (a real store) or off. Compare the two series for what snapshots add
// to a session's wall time; compare base and head for whether a change moved either.
// （上方英文注释原样保留：一次走真实 SessionStep.attempt 的脚本化 agent 会话，每次模型响应在请求后
// 400 ms 到达，快照开（真实存储）或关。对比两组序列即快照给会话挂钟时间增加了什么；
// 对比 base/head 即改动是否移动了任一项。）
// 导出 bench 定义：单目标 core，参数为快照开关与 fixture 规格
export default bench({
  // 被测目标：名为 core 的脚本宿主，指向同目录的 snapshot.ts
  targets: { core: script("./snapshot.ts") },
  // 参数：snapshots 在 on/off 两组间对比；fixture 默认跑 opencode 仓库克隆，more 可选 medium
  params: { snapshots: ["on", "off"], fixture: { run: ["opencode"], more: ["medium"] } },
  // 每个用例前的准备：按参数准备 fixture（重置到首个提交、开新的快照存储）
  async setup(ctx) {
    // 调脚本宿主的 prepare，参数为 fixture 名
    await ctx.call("prepare", ctx.params.fixture)
  },
  // 测量用例
  cases: {
    // 用例：15 步的 agent 会话（脚本化 trace，含读/编辑/工具调用）
    "an agent session of 15 steps": {
      // 主指标：run.duration（会话挂钟时间）
      primary: "run.duration",
      // 附加指标：count.git（会话拉起的 git 进程数）
      metrics: ["count.git"],
      async run(ctx) {
        // 调 session：按快照开关跑会话，模型响应延迟 400 ms；把返回的 git 进程数记入计数器
        ctx.count("git", await ctx.call<number>("session", ctx.params.snapshots, 400))
      },
      // 用例间把 fixture 复位（会话会编辑工作区文件）
      reset: (ctx) => ctx.call("resetFixture"),
    },
  },
})
