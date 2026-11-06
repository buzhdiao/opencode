// 导入 LLMClient（LLM 客户端服务）与 RequestExecutor（请求执行器服务）的抽象定义
import { LLMClient, RequestExecutor } from "@opencode/ai/route"
// 从 effect 库导入 Effect（效果类型）与 Layer（图层组合）
import { Effect, Layer } from "effect"
// 导入 Effect 的 FetchHttpClient（基于 fetch 的 HTTP 客户端实现）与 HttpClient 接口
import { FetchHttpClient, HttpClient } from "effect/http"
// 导入 Socket 模块，包含 WebSocket 构造器等服务标签
import { Socket } from "effect/socket"
// 导入 makeGlobalNode：声明全局单例图层节点的辅助函数
import { makeGlobalNode } from "@opencode/util/effect/app-node"
// 复用本仓库 util 包中已定义的 httpClient 图层节点
import { httpClient } from "@opencode/util/effect/app-node-platform"
// 导入本目录下的 WebSocketConstructor 服务（平台相关的 WebSocket 构造器实现）
import { WebSocketConstructor } from "./websocket-constructor.js"

// 下面这段注释为原代码自带说明：Bun 的 fetch 会在静默五分钟后终止请求，早于 provider 路由自身的头/分块超时。
// Bun's fetch ends a request after five quiet minutes, before provider routes' own header and chunk timeouts.
// 构造一个图层：移除 Bun 运行时给 fetch 附加的默认超时限制
const withoutBunTimeout = Layer.effect(
  // 该图层提供的服务标签：HttpClient
  HttpClient.HttpClient,
  Effect.gen(function* () {
    // 从上下文中取出原始的 HttpClient 实例
    const client = yield* HttpClient.HttpClient
    // 用 transformResponse 包装客户端：在每个请求上注入 RequestInit 服务，把 timeout 设为 false（禁用 Bun 的超时）
    return HttpClient.transformResponse(
      client,
      Effect.provideService(FetchHttpClient.RequestInit, { timeout: false } as BunFetchRequestInit),
    )
  }),
)

// 导出 requestExecutor 节点：请求执行器，依赖底层 httpClient，并去掉 Bun 的超时限制
export const requestExecutor = makeGlobalNode({
  // 该节点提供的服务标识：RequestExecutor.Service
  service: RequestExecutor.Service,
  // 图层实现：采用 RequestExecutor 自带图层，并注入去超时后的 HttpClient
  layer: RequestExecutor.layer.pipe(Layer.provide(withoutBunTimeout)),
  // 声明依赖：需要先就绪 httpClient 节点
  deps: [httpClient],
})

// 导出 llmClient 节点：LLM 客户端，依赖 requestExecutor（经由其发出请求）
export const llmClient = makeGlobalNode({ service: LLMClient.Service, layer: LLMClient.layer, deps: [requestExecutor] })

// 导出 webSocketConstructor 节点：平台相关的 WebSocket 构造器服务，无额外依赖
export const webSocketConstructor = makeGlobalNode({
  // 该节点提供的服务标识：Socket.WebSocketConstructor
  service: Socket.WebSocketConstructor,
  // 图层实现：来自本目录 websocket-constructor.ts 定义的 layer
  layer: WebSocketConstructor.layer,
  // 无依赖
  deps: [],
})

// 以命名空间形式整体导出本模块
export * as LayerNodePlatform from "./app-node-platform.js"
