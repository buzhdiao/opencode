// 引入核心配置服务（Config Service）：提供配置项的读取与更新能力
import { Config } from "@opencode/core/config"
// 引入 Shell 选择服务（ShellSelect）：用于发现系统可用的 shell
import { ShellSelect } from "@opencode/core/shell/select"
// 引入 Effect：函数式效果（Effect）运行时，用于组合各处理器逻辑
import { Effect } from "effect"
// 引入 HttpApiBuilder：按分组（group）构建 HTTP API 处理器
import { HttpApiBuilder } from "effect/http-api"
// 引入本服务的 API 定义（端点清单）
import { Api } from "../api"

// 导出 ConfigHandler：注册 "server.config" 分组下的全部处理器
export const ConfigHandler = HttpApiBuilder.group(Api, "server.config", (handlers) =>
  handlers
    // 处理 config.get：返回当前配置的全部条目（entries）
    .handle("config.get", () => Config.Service.use((config) => config.entries()))
    .handle(
      // 处理 config.update：更新配置内容
      "config.update",
      Effect.fn(function* (ctx) {
        // 从环境服务中取出配置服务实例
        const config = yield* Config.Service
        // 若当前环境不支持配置更新，则以“缺陷”（die，程序性错误而非业务失败）终止
        if (!config.update) return yield* Effect.die(new Error("Config updates are unavailable"))
        // 执行配置更新；Effect.orDie 把内部错误转为缺陷（此类错误不应由客户端处理）
        return yield* config.update(ctx.payload).pipe(Effect.orDie)
      }),
    )
    .handle(
      // 处理 config.shells：列出系统上可用的 shell
      "config.shells",
      Effect.fn(function* () {
        // 取出 Shell 选择服务
        const shell = yield* ShellSelect.Service
        // 若不支持 shell 发现（如平台限制），同样以缺陷终止
        if (!shell.list) return yield* Effect.die(new Error("Shell discovery is unavailable"))
        // 执行 shell 列表发现并返回结果
        return yield* shell.list()
      }),
    ),
)
