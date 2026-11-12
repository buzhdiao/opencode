// 核心代理（Agent）服务
import { Agent } from "@opencode/core/agent"
// effect 库：Effect 编排
import { Effect } from "effect"
// HttpApiBuilder：API 分组处理器构建器
import { HttpApiBuilder } from "effect/http-api"
// API 定义
import { Api } from "../api"
import { response } from "../location"
import { AgentNotFoundError } from "@opencode/protocol/errors"

// 代理分组处理器：列出与获取代理
export const AgentHandler = HttpApiBuilder.group(Api, "server.agent", (handlers) =>
  handlers
    .handle("agent.list", () => response(Agent.Service.use((agent) => agent.list())))
    .handle(
      "agent.get",
      Effect.fn(function* (ctx) {
        // 调用代理服务按 ID 查询
        const agent = yield* Agent.Service.use((service) => service.get(ctx.params.agentID))
        // 不存在时抛出"代理未找到"错误
        if (!agent)
          return yield* new AgentNotFoundError({
            // 缺失的代理 ID
            agentID: ctx.params.agentID,
            // 错误消息
            message: `Agent not found: ${ctx.params.agentID}`,
          })
        // 找到则包装响应返回
        return yield* response(Effect.succeed(agent))
      }),
    ),
)
