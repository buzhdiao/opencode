// 引入位置服务映射（按位置解析服务实现）
import { LocationServiceMap } from "@opencode/core/location-service-map"
// 引入协议层错误：无效请求错误（InvalidRequestError）与未知错误（UnknownError）
import { InvalidRequestError, UnknownError } from "@opencode/protocol/errors"
// 引入全局服务：提供全局日志目录等环境信息
import { Global } from "@opencode/util/global"
// 引入堆快照工具（HeapSnapshot）：可把当前进程内存写入文件
import { HeapSnapshot } from "@opencode/util/heap-snapshot"
// 引入 Effect、Option（可选值）与 RcMap（引用计数缓存）
import { Effect, Option, RcMap } from "effect"
// 引入 HTTP API 构建器
import { HttpApiBuilder } from "effect/http-api"
// 引入 Node 的 path 模块：校验绝对路径
import path from "node:path"
// 引入本服务 API 定义
import { Api } from "../api"
// 引入 requestRef：从 HTTP 请求中提取位置引用（Location.Ref）
import { requestRef } from "../location"

// 导出 DebugHandler：注册 "server.debug" 调试分组处理器
export const DebugHandler = HttpApiBuilder.group(Api, "server.debug", (handlers) =>
  Effect.gen(function* () {
    // 获取全局服务（日志目录等）
    const global = yield* Global.Service
    return handlers
      .handle(
        // 处理 debug.heapDump：把进程堆内存转储（heap dump）写入文件
        "debug.heapDump",
        // 命名该 Effect 便于日志追踪
        Effect.fn("server.debug.heapDump")(function* (ctx) {
          // 读取查询参数中的目标目录
          const directory = ctx.query.directory
          // 若提供了目录则必须为绝对路径，否则返回无效请求错误
          if (directory !== undefined && !path.isAbsolute(directory))
            return yield* new InvalidRequestError({ message: "directory must be an absolute path", field: "directory" })
          // 写堆快照到指定目录（未指定则写到全局日志目录）
          return yield* HeapSnapshot.write(directory ?? global.log).pipe(
            // 失败时把原因包装为带引用编号的错误，方便客户端与日志对照
            Effect.catch((cause) => {
              // 生成一个短随机引用编号（如 err_1a2b3c4d），用于关联错误消息与服务端日志
              const ref = `err_${crypto.randomUUID().slice(0, 8)}`
              return Effect.logError("failed to write heap snapshot", { cause }).pipe(
                // 在日志中附加引用编号，便于检索
                Effect.annotateLogs({ ref }),
                Effect.andThen(
                  // The reason (a missing permission, a file where the directory should be) is usually the caller's to fix.
                  // 失败原因（如缺权限、目录位置其实是个文件）通常需要调用方修正，故以 UnknownError 透出
                  Effect.fail(
                    new UnknownError({
                      message: `Failed to write heap snapshot: ${cause.cause instanceof Error ? cause.cause.message : cause.message}`,
                      ref,
                    }),
                  ),
                ),
              )
            }),
          )
        }),
      )
      .handle(
        // 处理 debug.location：列出当前缓存的所有位置（location）键
        "debug.location",
        Effect.fn(function* () {
          // 取出位置服务映射（该服务通过 serviceOption 可选注入，缺失时抛错）
          const locations = Option.getOrThrow(yield* Effect.serviceOption(LocationServiceMap.Service))
          // 返回 RcMap 缓存中的全部键（即各位置的引用）
          return Array.from(yield* RcMap.keys(locations.rcMap))
        }),
      )
      .handle(
        // 处理 debug.location.evict：手动逐出（evict）当前请求对应位置的缓存服务
        "debug.location.evict",
        Effect.fn(function* (ctx) {
          // 取出位置服务映射
          const locations = Option.getOrThrow(yield* Effect.serviceOption(LocationServiceMap.Service))
          // Resolve through requestRef so the key matches the shape the location
          // middleware cached the services under.
          // 通过 requestRef 解析位置键，确保与位置中间件缓存服务时所用的键形状一致
          yield* locations.invalidate(requestRef(ctx.request))
        }),
      )
  }),
)
