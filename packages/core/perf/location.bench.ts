// Location 服务的基准测试定义（strobe bench 文件）：测量目录服务图的加载成本与常驻内存。
// 由 @hona/strobe 的 CLI 驱动（对比 base/head 两次检出的结果），targets 的 script 声明
// 被测脚本宿主为同目录 ./location.ts——strobe 每个 block 加载它一次，通过 ctx.call 调用其导出。
// 用法：`bunx strobe perf/location.bench.ts`（在 packages/core 下）；先跑一次基线再在改动后对比。
// 导入 strobe 的 bench 定义器与 script 目标构造器
import { bench, script } from "@hona/strobe"

// 导出 bench 定义：单目标 core（./location.ts 脚本宿主），四个测量用例
export default bench({
  // 被测目标：名为 core 的脚本宿主，指向同目录的 location.ts
  targets: { core: script("./location.ts") },
  // 测量用例
  cases: {
    // A request for a directory the server already serves.
    // （上方英文注释原样保留：服务端已缓存的目录请求——热路径。）
    // 用例一：加载已缓存的目录（命中缓存，只测重复加载的成本）；primary 指标为 CPU 工作量
    "load a cached location": {
      // 主指标：cpu.work（CPU 工作量）
      primary: "cpu.work",
      async run(ctx) {
        // 调脚本宿主的 load：构建/返回目录服务图
        await ctx.call("load")
      },
    },
    // The first request after the directory's graph was dropped (a config change, an idle eviction).
    // （上方英文注释原样保留：目录图被丢弃后的首次请求——如配置变更、空闲淘汰后的冷加载。）
    // 用例二：真正的冷加载；每次 run 后用 reset 调 invalidate 重新失效，保证下一轮仍是冷的
    "load a location": {
      // 主指标：cpu.work
      primary: "cpu.work",
      async run(ctx) {
        // 冷加载目录图
        await ctx.call("load")
      },
      async reset(ctx) {
        // 用例间失效缓存，让下一轮 run 回到冷态
        await ctx.call("invalidate")
      },
    },
    // What one more open directory keeps alive in a long-running server.
    // （上方英文注释原样保留：多打开一个目录会让长驻服务器多留存的量。）
    // 用例三：常驻成本——新建一个完整 Location 图并保持存活；primary 为保留堆内存
    "keep a location graph": {
      // 主指标：js.heap.retained（JS 堆保留内存）
      primary: "js.heap.retained",
      // 附加指标：cpu.work（构建图的 CPU 成本）
      metrics: ["cpu.work"],
      async run(ctx) {
        // 调 keepLocation：再建一个 Location 图并挂到长命 scope
        await ctx.call("keepLocation")
      },
    },
    // 用例四：常驻成本——多实例化一个 models.dev 插件（共享定义 + 每实例物化读模型）
    "keep a models.dev plugin instance": {
      // 主指标：js.heap.retained
      primary: "js.heap.retained",
      // 附加指标：cpu.work
      metrics: ["cpu.work"],
      async run(ctx) {
        // 调 keepPlugin：再建一个 models.dev 插件实例并保持存活
        await ctx.call("keepPlugin")
      },
    },
  },
  // 每个用例首次 run 前的准备
  async setup(ctx) {
    // The first load pays for module and database setup once; a cold case starts dropped.
    // （上方英文注释原样保留：首次加载一次性支付模块与数据库初始化；冷用例从失效态开始。）
    // 先加载一次，把模块/数据库等一次性成本排除在测量之外
    await ctx.call("load")
    // 冷加载用例：随后立即失效，使首个被测 run 从冷态开始
    if (ctx.case === "load a location") await ctx.call("invalidate")
  },
})
