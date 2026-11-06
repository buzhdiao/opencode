// 引入凭证（Credential）核心服务：管理各集成的凭证增删改查与激活
import { Credential } from "@opencode/core/credential"
// 引入文件系统服务（FileSystem）：此处仅用于捕获“目录不存在”错误类型
import { FileSystem } from "@opencode/core/filesystem"
// 引入位置（Location）模型：表示工作目录上下文
import { Location } from "@opencode/core/location"
// 引入位置服务映射（LocationServiceMap）：按位置解析出一组服务实现
import { LocationServiceMap } from "@opencode/core/location-services"
// 引入 AbsolutePath：绝对路径的校验构造类型
import { AbsolutePath } from "@opencode/core/schema"
// 引入协议层错误类型：冲突错误（ConflictError），对应 409
import { ConflictError } from "@opencode/protocol/errors"
// 引入全局服务（Global）：提供全局配置目录等环境信息
import { Global } from "@opencode/util/global"
// 引入 Effect 运行时
import { Effect } from "effect"
// 引入 HTTP API 构建器与 Schema 工具（NoContent 即 204 响应等）
import { HttpApiBuilder, HttpApiSchema } from "effect/http-api"
// 引入本服务 API 定义
import { Api } from "../api"
// 引入 requireConnectable：校验集成（integration）是否允许连接（受托管策略约束）
import { requireConnectable } from "./integration"

// 导出 CredentialHandler：注册 "server.credential" 分组处理器
export const CredentialHandler = HttpApiBuilder.group(Api, "server.credential", (handlers) =>
  // 用 Effect.gen 构建处理器组：先准备共享依赖，再返回 handlers 链
  Effect.gen(function* () {
    // 获取全局服务（全局配置目录路径等）
    const global = yield* Global.Service
    // 获取位置服务映射
    const locations = yield* LocationServiceMap.Service
    // Credentials are global, so `integration.connect` is read from the global config Location, which carries managed
    // policy, the Console document, and user config.
    // 凭证是全局资源，因此从“全局配置位置”解析服务集：其中承载托管策略（managed policy）、Console 文档与用户配置
    const services = locations.get(Location.Ref.make({ directory: AbsolutePath.make(global.config) }))
    return handlers
      .handle(
        // 处理 credential.list：列出所有凭证
        "credential.list",
        Effect.fn(function* () {
          // 获取凭证服务
          const credential = yield* Credential.Service
          // 返回经 entries() 加工后的凭证列表（附带 active 标记）
          return { data: entries(yield* credential.all()) }
        }),
      )
      .handle(
        // 处理 credential.create：创建凭证
        "credential.create",
        Effect.fn(function* (ctx) {
          // 先校验该集成是否允许连接（integration.connect 策略检查）
          yield* requireConnectable(ctx.payload.integrationID).pipe(
            // 以上面解析出的全局服务集提供运行依赖
            Effect.provide(services),
            // The global config directory always exists.
            // 全局配置目录必然存在，因此“目录不存在”属于程序性缺陷，直接 die 而不是当作业务错误返回
            Effect.catchIf((error) => error instanceof FileSystem.DirectoryNotFoundError, Effect.die),
          )
          // 获取凭证服务
          const credential = yield* Credential.Service
          // 若调用方指定了 id 且该 id 已存在，则返回冲突错误（409）
          if (ctx.payload.id && (yield* credential.get(ctx.payload.id)))
            return yield* new ConflictError({
              resource: ctx.payload.id,
              message: `Credential already exists: ${ctx.payload.id}`,
            })
          // 执行创建
          const created = yield* credential.create(ctx.payload)
          // 重新列出该集成的凭证，找到刚创建的条目（带 active 信息）
          const entry = entries(yield* credential.list(created.integrationID)).find((item) => item.id === created.id)
          // 若找不到（极端情况），退回创建结果并标记为未激活
          return { data: entry ?? { ...created, active: false } }
        }),
      )
      .handle(
        // 处理 credential.update：更新凭证的显示标签（label）
        "credential.update",
        Effect.fn(function* (ctx) {
          // 获取凭证服务
          const credential = yield* Credential.Service
          // 按路径参数 credentialID 更新标签
          yield* credential.update(ctx.params.credentialID, { label: ctx.payload.label })
          // 返回 204 无内容响应
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        // 处理 credential.activate：把指定凭证设为该集成当前使用的凭证
        "credential.activate",
        Effect.fn(function* (ctx) {
          // 获取凭证服务
          const credential = yield* Credential.Service
          // 执行激活
          yield* credential.activate(ctx.params.credentialID)
          // 返回 204 无内容
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        // 处理 credential.remove：删除指定凭证
        "credential.remove",
        Effect.fn(function* (ctx) {
          // 获取凭证服务
          const credential = yield* Credential.Service
          // 执行删除
          yield* credential.remove(ctx.params.credentialID)
          // 返回 204 无内容
          return HttpApiSchema.NoContent.make()
        }),
      )
  }),
)

// Credential listings order each integration's selected credential last.
// 辅助函数：把凭证列表加工成响应视图；每个集成当前选中的凭证会标记 active=true
function entries(credentials: Credential.Info[]) {
  // 构建“集成ID -> 选中凭证ID”的映射（Map）
  const selected = new Map(credentials.map((item) => [item.integrationID, item.id]))
  // 将每条凭证映射为响应结构；active 判断该凭证是否为其集成当前选中的
  return credentials.map((item) => ({
    id: item.id,
    integrationID: item.integrationID,
    label: item.label,
    active: selected.get(item.integrationID) === item.id,
    value: item.value,
  }))
}
