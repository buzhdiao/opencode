// 引入 RPC 核心服务：调用插件注册的自定义方法
import { Rpc } from "@opencode/core/rpc"
// 引入插件服务：等待插件激活
import { Plugin } from "@opencode/core/plugin"
// 引入协议层错误：RPC 错误与 RPC 内部错误
import { RpcError, RpcInternalError } from "@opencode/protocol/errors"
// 引入 Effect 运行时
import { Effect } from "effect"
// 引入 HTTP API 构建器
import { HttpApiBuilder } from "effect/http-api"
// 引入本服务 API 定义
import { Api } from "../api"

// 导出 RpcHandler：注册 "server.rpc" 分组处理器
export const RpcHandler = HttpApiBuilder.group(Api, "server.rpc", (handlers) =>
  // 处理 rpc.call：按 RPC ID 与方法名调用插件注册的方法
  handlers.handle("rpc.call", ({ params, payload }) =>
    Effect.gen(function* () {
      // 等待插件激活完成（RPC 由插件注册）
      yield* Plugin.awaitActivation
      // 获取 RPC 服务
      const rpc = yield* Rpc.Service
      // 执行调用：入参为 RPC ID、方法名与请求负载
      const output = yield* rpc.call(params.rpcID, params.method, payload.input)
      // 无返回值时返回空对象，否则包一层 output 字段
      return output === undefined ? {} : { output }
    }).pipe(
      // 把 RPC 服务的错误映射为协议层错误：输出不合法或内部错误 -> RpcInternalError（客户端不应重试），其余为业务性 RPC 错误（可携带附加数据）
      Effect.mapError((error) =>
        error.type === "rpc.invalid_output" || error.type === "rpc.internal"
          ? new RpcInternalError({ type: error.type, message: error.message })
          : new RpcError({
              type: error.type,
              message: error.message,
              ...(error.data === undefined ? {} : { data: error.data }),
            }),
      ),
      // Defects outside handler execution are still logged, never echoed to the client.
      // 处理缺陷（defect，程序性异常）：记录日志但绝不把细节回传给客户端
      Effect.catchDefect((defect) =>
        Effect.logError("rpc call failed", { rpc: params.rpcID, method: params.method, defect }).pipe(
          Effect.andThen(Effect.fail(new RpcInternalError({ type: "rpc.internal", message: "RPC call failed" }))),
        ),
      ),
    ),
  ),
)
