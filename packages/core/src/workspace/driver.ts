// 将本文件的所有导出聚合到命名空间 WorkspaceDriver 下，供统一引入
export * as WorkspaceDriver from "./driver.js"

// Workspace Schema：工作区 ID 等类型
import { Workspace } from "@opencode/schema/workspace"
// 构建 effect 全局节点（服务注册）
import { makeGlobalNode } from "@opencode/util/effect/app-node"
// effect 库：Context 依赖注入、Effect 编排、Layer 分层、Schema 校验
import { Context, Effect, Layer, Schema } from "effect"
// effect 的作用域（Scope）类型
import type { Scope } from "effect"
// 环境驱动类型（连接后的产物）
import type { EnvironmentDriver } from "../environment/driver.js"

/**
 * Smallest provider-owned JSON value required to reconnect to the same
 * provider resource. Core stores it opaquely and hands it back; only the
 * owning driver reads inside.
 */
// 绑定（Binding）：重连同一提供商资源所需的最小 JSON 值；
// 核心只做不透明存储与回传，仅驱动自己能解读
export const Binding = Schema.Record(Schema.String, Schema.Json)
// Binding 的 TypeScript 类型
export type Binding = typeof Binding.Type

// 工作区驱动的通用错误
export class Error extends Schema.TaggedError<Error>()("WorkspaceDriver.Error", {
  // 错误消息（可选）
  message: Schema.optional(Schema.String),
  // 引发原因（可选 defect）
  cause: Schema.optional(Schema.Defect()),
}) {}

// 错误：找不到指定提供商的驱动
export class ProviderNotFound extends Schema.TaggedError<ProviderNotFound>()("WorkspaceDriver.ProviderNotFound", {
  // 缺失的提供商名
  provider: Schema.String,
}) {}

// 工作区驱动接口：提供商资源生命周期管理
export interface Interface {
  /**
   * Get-or-create the provider resource backing this logical workspace.
   *
   * MUST be idempotent per `workspaceID`: core retries the same ID after
   * failures and process crashes, including a crash between a successful
   * create and the binding being persisted, and another process may race the
   * same ID. Key the resource by `workspaceID` (a provider tag or a
   * deterministic name) and adopt an existing match instead of creating a
   * duplicate.
   */
  // 获取或创建支撑该逻辑工作区的提供商资源；必须按 workspaceID 幂等
  readonly create: (input: {
    // 逻辑工作区 ID
    readonly workspaceID: Workspace.ID
  }) => Effect.Effect<{ readonly binding: Binding }, Error>
  // 连接已有资源，返回环境驱动（依赖 Scope 管理生命周期）
  readonly connect: (input: {
    // 工作区 ID
    readonly workspaceID: Workspace.ID
    // 已持久化的绑定
    readonly binding: Binding
    // 保存新绑定值的回调
    readonly saveBinding: (binding: Binding) => Effect.Effect<void>
  }) => Effect.Effect<EnvironmentDriver.Driver, Error, Scope.Scope>
  // 工作区空闲时挂起资源（保存可能更新过的绑定）
  readonly suspendForIdle: (input: {
    // 工作区 ID
    readonly workspaceID: Workspace.ID
    // 当前绑定
    readonly binding: Binding
    // 保存绑定回调
    readonly saveBinding: (binding: Binding) => Effect.Effect<void>
  }) => Effect.Effect<void, Error>
  /**
   * Release the provider resource for this workspace.
   *
   * `binding` is null when none was persisted: the workspace was never
   * provisioned, or provisioning was interrupted mid-create. Look up any
   * resource previously created for `workspaceID` and clean it up, treating
   * absence as success.
   */
  // 释放该工作区的提供商资源；binding 为 null 表示从未成功供给，也按成功处理
  readonly destroy: (input: {
    // 工作区 ID
    readonly workspaceID: Workspace.ID
    // 已持久化的绑定（可为 null）
    readonly binding: Binding | null
  }) => Effect.Effect<void, Error>
}

// 便捷构造：直接返回驱动实现
export const make = (driver: Interface) => driver

// 驱动注册表接口：按提供商名取驱动
export interface Registry {
  // 获取指定提供商的驱动，缺失时失败
  readonly get: (provider: string) => Effect.Effect<Interface, ProviderNotFound>
}

// 注册表服务定义（Context.Service）
export class RegistryService extends Context.Service<RegistryService, Registry>()(
  // 服务标签
  "@opencode/WorkspaceDriverRegistry",
) {}

// 由驱动映射构建注册表实现
export const registry = (drivers: Readonly<Record<string, Interface>>): Registry => ({
  // get 实现
  get: (provider) => {
    // 查找驱动（用 hasOwn 防原型链污染）
    const driver = Object.hasOwn(drivers, provider) ? drivers[provider] : undefined
    // 找到则成功返回，否则报 ProviderNotFound
    return driver ? Effect.succeed(driver) : Effect.fail(new ProviderNotFound({ provider }))
  },
})

// 构建注册表的全局节点（含固定驱动集）
export const registryNode = (drivers: Readonly<Record<string, Interface>>) =>
  makeGlobalNode({
    // 服务类型
    service: RegistryService,
    // 服务层：常量注册表
    layer: Layer.succeed(RegistryService, RegistryService.of(registry(drivers))),
    // 无额外依赖
    deps: [],
  })

// 默认导出的空注册表节点
export const node = registryNode({})
