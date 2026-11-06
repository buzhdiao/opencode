// 以命名空间形式整体再导出本模块
export * as PluginHost from "./host.js"

// Plugin：插件效果体系入口
import { Plugin } from "@opencode/plugin/effect"
// IntegrationMethodRegistration：集成方式注册类型
import type { IntegrationMethodRegistration } from "@opencode/plugin/effect/integration"
// EventManifest：事件清单（区分服务端事件等）
import { EventManifest } from "@opencode/schema/event-manifest"
// Event：事件负载类型
import type { Event } from "@opencode/schema/event"
// ServerConfig：MCP 服务器配置 Schema
import { ServerConfig } from "@opencode/schema/mcp"
// 以下为核心服务模块
import { App } from "../app.js"
import { Effect, Schema, Stream } from "effect"
import { Agent } from "../agent.js"
import { Artifact } from "../artifact.js"
import { AISDK } from "../aisdk.js"
import { Command } from "../command.js"
import { Credential } from "../credential.js"
import { Bus } from "../bus.js"
import { Integration } from "../integration.js"
import { IntegrationConnection } from "../integration/connection.js"
import { KV } from "../kv.js"
import { Location } from "../location.js"
import { LocationServiceMap } from "../location-service-map.js"
import { Model } from "../model.js"
import { Mcp } from "../mcp/index.js"
import { Session } from "../session.js"
import { InstructionEntry } from "../session/instruction-entry.js"
import { PersistentPty } from "../persistent-pty.js"
import { Provider } from "../provider.js"
import { Reference } from "../reference.js"
import { Rpc } from "../rpc.js"
import { AbsolutePath, type DeepMutable } from "../schema.js"
import { Skill } from "../skill.js"
import { Tool } from "../tool.js"
import { Workspace } from "../workspace.js"
import { Vcs } from "../vcs.js"
import { WebSearch } from "../websearch.js"
import { Worktree } from "../worktree.js"
import { WorktreeStrategies } from "../worktree/strategies.js"
import { Generate } from "../generate.js"
import { Permission } from "../permission.js"
// PluginHooks：插件钩子注册中心
import { PluginHooks } from "./hooks.js"
// Interface：插件系统对外接口类型
import type { Interface } from "../plugin.js"
// LayerNode：服务层节点辅助
import { LayerNode } from "@opencode/util/effect/layer-node"

// mutable：把值断言为深度可变（DeepMutable）类型，供插件编辑器使用
const mutable = <T>(value: T) => value as DeepMutable<T>
// RpcEvent：rpc.* 类型事件的最小结构
type RpcEvent = Event.Payload & {
  // 事件类型必须以 rpc. 开头
  readonly type: `rpc.${string}`
  // 事件所属位置
  readonly location: Location.Ref
  // 事件数据
  readonly data: Readonly<Record<string, unknown>>
}
// isRpcType：类型守卫，判断事件类型字符串是否为 rpc.*
const isRpcType = (type: string): type is RpcEvent["type"] => type.startsWith("rpc.")
// isRpcEvent：类型守卫，判断负载是否为 rpc 事件
const isRpcEvent = (event: Event.Payload): event is RpcEvent => isRpcType(event.type)
// isPublicEvent：类型守卫，判断事件是否对插件公开（服务端清单事件或 rpc 事件）
const isPublicEvent = (event: Event.Payload): event is EventManifest.ServerEvent | RpcEvent =>
  // 服务端清单内事件或 rpc 事件才算公开
  EventManifest.isServer(event) || isRpcEvent(event)
// make：为指定插件构建插件上下文（Plugin.Context）
export const make = Effect.fn("PluginHost.make")(function* (plugin: Pick<Interface, "list">, pluginID: string) {
  // 获取应用元信息
  const app = yield* App.Metadata
  // 逐个获取插件上下文所需的各服务
  const agents = yield* Agent.Service
  const artifacts = yield* Artifact.Service
  const aisdk = yield* AISDK.Service
  const providers = yield* Provider.Service
  const models = yield* Model.Service
  const commands = yield* Command.Service
  const bus = yield* Bus.Service
  const integration = yield* Integration.Service
  const kv = yield* KV.Service
  const mcp = yield* Mcp.Service
  const location = yield* Location.Service
  const reference = yield* Reference.Service
  const rpc = yield* Rpc.Service
  const skill = yield* Skill.Service
  const tools = yield* Tool.Service
  const vcs = yield* Vcs.Service
  const websearch = yield* WebSearch.Service
  const generate = yield* Generate.Service
  // 文本生成辅助：把结果包成 { text } 形态
  const generateText = (input: Generate.TextInput) => generate.text(input).pipe(Effect.map((text) => ({ text })))
  const permission = yield* Permission.Service
  // 钩子注册中心
  const hooks = yield* PluginHooks.Service
  const sessions = yield* Session.Service
  // 指令条目服务
  const instructionEntries = yield* InstructionEntry.Service
  // 持久化伪终端（PTY）服务
  const persistentPty = yield* PersistentPty.Service
  // 位置到服务映射（跨位置调用时用）
  const locations = yield* LocationServiceMap.Service
  // worktree（工作树）及其策略服务
  const worktrees = yield* Worktree.Service
  const worktreeStrategies = yield* WorktreeStrategies.Service
  // 无工作区（workspace）上下文时才允许工作树操作（全局位置专属）
  const currentWorktreeStrategies = location.workspaceID ? undefined : worktreeStrategies
  // locationInfo：把位置服务信息压缩为可序列化的 Info
  const locationInfo = (current: Location.Interface = location) =>
    // 构造位置信息对象
    new Location.Info({
      // 目录
      directory: current.directory,
      // 工作区 ID
      workspaceID: current.workspaceID,
      // 项目
      project: current.project,
    })
  // locationRef：从插件入参解析目标位置引用（缺省用当前位置）
  const locationRef = (input?: { readonly location?: { readonly directory?: string; readonly workspace?: string } }) =>
    // 未提供 location 时返回 undefined
    input?.location === undefined
      ? undefined
      // 否则构造位置引用（目录缺省取当前目录）
      : Location.Ref.make({
          // 目录（规范化为绝对路径）
          directory: AbsolutePath.make(input.location.directory ?? location.directory),
          // 工作区 ID（缺省取当前）
          workspaceID:
            input.location.workspace === undefined ? location.workspaceID : Workspace.ID.make(input.location.workspace),
        })
  // isCurrentLocation：判断引用是否指向当前位置
  const isCurrentLocation = (ref: Location.Ref) =>
    // 目录与工作区 ID 都相同才算当前
    ref.directory === location.directory && ref.workspaceID === location.workspaceID
  // response：把效果结果包上当前位置信息
  const response = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    // 映射为 { location, data } 形态
    effect.pipe(Effect.map((data) => ({ location: locationInfo(), data })))
  // atLocation：在指定位置的服务环境中执行效果
  const atLocation = <A, E, R>(ref: Location.Ref, effect: Effect.Effect<A, E, R>) =>
    // 组织生成器
    Effect.gen(function* () {
      // 在目标位置环境中取位置信息与结果
      return { location: locationInfo(yield* Location.Service), data: yield* effect }
      // 提供该位置对应的服务层
    }).pipe(Effect.provide(locations.get(ref)))

  // sessionPermission：按请求 ID 取权限请求，并校验其属于指定会话
  const sessionPermission = (input: Parameters<Plugin.Context["permission"]["get"]>[0]) =>
    // 查询权限请求
    permission
      .get(input.requestID)
      .pipe(
        // 请求存在且会话匹配则成功，否则失败
        Effect.flatMap((request) =>
          request?.sessionID === input.sessionID
            ? Effect.succeed(request)
            : Effect.fail(new Error(`Permission request not found: ${input.requestID}`)),
        ),
      )

  // worktree 单条信息解码器
  const decodeWorktree = Schema.decodeUnknownEffect(Worktree.Info)
  // worktree 列表条目解码器
  const decodeWorktrees = Schema.decodeUnknownEffect(Schema.Array(Worktree.ListEntry))

  // listAgents：在指定位置列出 agent（失败转为缺陷）
  const listAgents = Effect.fn("PluginHost.listAgents")((ref: Location.Ref) =>
    // 在目标位置环境中执行列表
    atLocation(
      // 目标位置
      ref,
      // 先取 Agent 服务再列表
      Effect.flatMap(Agent.Service, (agents) => agents.list()),
      // 失败视为不可恢复缺陷
    ).pipe(Effect.orDie),
  )

  // Keep the instance graph's inferred types independent of Session handles.
  // 构建暴露给插件的完整上下文对象
  const context: Plugin.Context = {
    // 应用元信息
    app,
    // 当前位置信息
    location: locationInfo(),
    // 插件选项（此处为空，加载时注入）
    options: {},
    // rpc 客户端并附加 register 注册方法
    rpc: Object.assign(rpc.client, { register: rpc.register }),
    // agent 域 API
    agent: {
      // get：按 ID 取 agent（支持跨位置查询）
      get: (input) => {
        // 解析目标位置
        const ref = locationRef(input)
        // 跨位置：走 listAgents 再过滤；否则直接取
        const output =
          ref && !isCurrentLocation(ref)
            ? listAgents(ref).pipe(
                // 在结果中查找指定 ID 的 agent
                Effect.map((result) => ({
                  // 保留位置信息
                  ...result,
                  // 过滤出目标 agent
                  data: result.data.find((agent) => agent.id === input.agentID),
                })),
              )
            // 当前位置：直接获取
            : response(agents.get(input.agentID))
        // 统一处理"未找到"的情况
        return output.pipe(
          // 找到则透传，未找到则失败
          Effect.flatMap((result) =>
            result.data
              ? Effect.succeed({ ...result, data: result.data })
              : Effect.fail(new Error(`Agent not found: ${input.agentID}`)),
          ),
        )
      },
      // list：列出 agent（支持跨位置）
      list: (input) => {
        // 解析目标位置
        const ref = locationRef(input)
        // 跨位置走远程列表
        if (ref && !isCurrentLocation(ref)) return listAgents(ref)
        // 当前位置直接列表
        return response(agents.list())
      },
      // reload：重载 agent 定义
      reload: agents.reload,
      // transform：以编辑器回调修改 agent 定义
      transform: (callback) =>
        // 调用服务的 transform
        agents.transform((editor) => {
          // 把编辑器包装成插件友好接口
          callback({
            // 列出全部
            list: editor.list,
            // 按 ID 取
            get: (id) => editor.get(Agent.ID.make(id)),
            // 取/设默认 agent
            default: (id) => editor.default(id === undefined ? undefined : Agent.ID.make(id)),
            // 更新指定 agent
            update: (id, update) => editor.update(Agent.ID.make(id), update),
            // 移除指定 agent
            remove: (id) => editor.remove(Agent.ID.make(id)),
          })
        }),
    },
    // aisdk 域 API：AI SDK 钩子
    aisdk: {
      // hook：注册 sdk 或 language 钩子
      hook: (name, callback, options) => {
        // sdk 钩子：SDK 实例构造时触发
        if (name === "sdk") {
          // 注册 sdk 钩子
          return aisdk.hook.sdk((event) => {
            // 限定提供商（若指定）
            if (options?.providerID !== undefined && options.providerID !== event.model.providerID) return Effect.void
            // 组装传给插件的输出（模型转可变）
            const output = {
              // 模型信息
              model: mutable(event.model),
              // 来源包
              package: event.package,
              // 模型选项
              options: event.options,
              // SDK 实例
              sdk: event.sdk,
            }
            // oxlint-disable-next-line no-restricted-globals -- The generic hook callback remains a union after narrowing by hook name.
            // 调用插件回调，并把回调改写的 sdk 写回事件
            return Reflect.apply(callback, undefined, [output]).pipe(
              // 回调完成后同步写回
              Effect.tap(() => Effect.sync(() => (event.sdk = output.sdk))),
            )
          })
        }
        // 其余按 language 钩子处理
        return aisdk.hook.language((event) => {
          // 限定提供商（若指定）
          if (options?.providerID !== undefined && options.providerID !== event.model.providerID) return Effect.void
          // 组装传给插件的输出
          const output = {
            // 模型信息
            model: mutable(event.model),
            // 模型选项
            options: event.options,
            // SDK 实例
            sdk: event.sdk,
            // 语言模型实例
            language: event.language,
          }
          // oxlint-disable-next-line no-restricted-globals -- The generic hook callback remains a union after narrowing by hook name.
          // 调用插件回调，并把改写的 language 写回事件
          return Reflect.apply(callback, undefined, [output]).pipe(
            // 回调完成后同步写回
            Effect.tap(() => Effect.sync(() => (event.language = output.language))),
          )
        })
      },
    },
    // provider 域 API
    provider: {
      // list：列出可用提供商
      list: () => response(providers.available()),
      // get：按 ID 取提供商
      get: (input) =>
        // 查询提供商
        providers
          .get(Provider.ID.make(input.providerID))
          .pipe(
            // 找到则包上位置，未找到则失败
            Effect.flatMap((provider) =>
              provider === undefined
                ? Effect.fail(new Error(`Provider not found: ${input.providerID}`))
                : response(Effect.succeed(provider)),
            ),
          ),
      // reload：重载提供商
      reload: providers.reload,
      // transform：以编辑器回调修改提供商
      transform: (callback) =>
        // 调用服务 transform
        providers.transform((editor) => {
          // 包装编辑器接口
          callback({
            // 列出全部
            list: editor.list,
            // 按 ID 取
            get: (id) => editor.get(Provider.ID.make(id)),
            // 添加提供商（规范化来源连接信息）
            add: (definition) =>
              editor.add({
                // 展开定义
                ...definition,
                // 来源连接存在时转换为内部 Info
                sourceConnection: definition.sourceConnection && connectionInfo(definition.sourceConnection),
              }),
            // 更新指定提供商
            update: (id, update) => editor.update(Provider.ID.make(id), update),
            // 移除指定提供商
            remove: (id) => editor.remove(Provider.ID.make(id)),
            // 模型子编辑器
            models: {
              // 覆盖某提供商的模型集合
              set: (id, models) => editor.models.set(Provider.ID.make(id), models),
              // 更新单个模型
              update: (providerID, modelID, update) =>
                editor.models.update(Provider.ID.make(providerID), Model.ID.make(modelID), update),
              // 移除单个模型
              remove: (providerID, modelID) =>
                editor.models.remove(Provider.ID.make(providerID), Model.ID.make(modelID)),
            },
          })
        }),
    },
    // model 域 API
    model: {
      // list：列出可用模型（可按类型过滤）
      list: (input) => response(models.available(input?.types)),
      // default：取默认模型
      default: () => response(models.default()),
      // reload：重载模型目录
      reload: models.reload,
      // transform：以编辑器回调修改模型目录
      transform: (callback) =>
        // 调用服务 transform
        models.transform((editor) =>
          // 包装编辑器接口
          callback({
            // 按提供商列出模型
            list: (providerID) => editor.list(providerID === undefined ? undefined : Provider.ID.make(providerID)),
            // 取单个模型
            get: (providerID, modelID) => editor.get(Provider.ID.make(providerID), Model.ID.make(modelID)),
            // 更新单个模型
            update: (providerID, modelID, update) =>
              editor.update(Provider.ID.make(providerID), Model.ID.make(modelID), update),
            // 移除单个模型
            remove: (providerID, modelID) => editor.remove(Provider.ID.make(providerID), Model.ID.make(modelID)),
            // 默认模型子接口
            default: {
              // 读默认
              get: editor.default.get,
              // 设默认
              set: (providerID, modelID) => editor.default.set(Provider.ID.make(providerID), Model.ID.make(modelID)),
            },
            // 提供商子接口
            provider: {
              // 列出提供商
              list: editor.provider.list,
              // 按 ID 取提供商
              get: (id) => editor.provider.get(Provider.ID.make(id)),
            },
          }),
        ),
    },
    // command 域 API
    command: {
      // list：列出命令
      list: () => response(commands.list()),
      // reload：重载命令
      reload: commands.reload,
      // transform：以编辑器回调修改命令
      transform: commands.transform,
    },
    // credential 域 API
    credential: {
      // activate：激活指定凭据（credential）连接
      activate: (input) => integration.connection.activate(input.credentialID),
    },
    // event 域 API
    event: {
      // The bus only delivers the requested types, which TypeScript cannot follow through the generic signature.
      // subscribe：订阅事件总线（只投递所请求类型；公开事件过滤）
      subscribe: ((input?: { readonly types?: ReadonlyArray<string> }) => {
        // 未指定类型：订阅全部并过滤出公开事件
        if (!input?.types?.length) return bus.subscribe().pipe(Stream.filter(isPublicEvent))
        // 收集无法识别的事件类型
        const unknown = new Array<string>()
        // 把类型名映射为事件定义（rpc 类型特殊处理）
        const [first, ...rest] = input.types.flatMap((type) => {
          // rpc.* 类型取 rpc 事件定义
          if (isRpcType(type)) return [Rpc.eventDefinition(type)]
          // 其余查服务端事件清单
          const definition = EventManifest.Server.get(type)
          // 未登记的类型记入 unknown
          if (!definition) unknown.push(type)
          // 返回找到的定义
          return definition ? [definition] : []
        })
        // 有任一定义则订阅这些类型，否则返回永不产生事件（never）的流
        const events = first ? bus.subscribe([first, ...rest]) : Stream.never
        // 无未知类型直接返回
        if (unknown.length === 0) return events
        // 有未知类型：先记警告再订阅
        return Stream.unwrap(
          // 记录被忽略的类型
          Effect.logWarning("ignoring unknown event types", { pluginID, types: unknown }).pipe(Effect.as(events)),
        )
        // 断言为泛型签名
      }) as Plugin.Context["event"]["subscribe"],
    },
    // experimental 域 API
    experimental: {
      // 终端能力
      terminal: {
        // read：读取持久化终端输出
        read: (input) => persistentPty.read(input.sessionID, input.lines),
      },
      // 生成能力
      generate: {
        // 文本生成
        text: generateText,
        // 图像生成
        image: generate.image,
        // 决策生成
        decisions: generate.decisions,
      },
      // artifact（产出物提供方）能力
      artifact: {
        // reload：重载产出物提供方
        reload: artifacts.reload,
        // transform：以编辑器回调修改提供方
        transform: (callback) =>
          // 调用服务 transform
          artifacts.transform((editor) => {
            // 包装编辑器接口
            callback({
              // 添加提供方（规范化各字段）
              add: (definition) =>
                editor.add({
                  // 规范化 ID
                  id: Artifact.ProviderID.make(definition.id),
                  // 名称
                  name: definition.name,
                  // 能力声明
                  capabilities: definition.capabilities,
                  // 提示词
                  prompt: definition.prompt,
                  // 创建实现
                  create: definition.create,
                  // 读取实现
                  read: definition.read,
                  // 更新实现
                  update: definition.update,
                  // 删除实现
                  delete: definition.delete,
                }),
              // 移除提供方
              remove: (id) => editor.remove(Artifact.ProviderID.make(id)),
              // 默认提供方
              default: {
                // 读默认
                get: () => editor.default.get(),
                // 设默认（可清空）
                set: (providerID) =>
                  editor.default.set(providerID === undefined ? undefined : Artifact.ProviderID.make(providerID)),
              },
            })
          }),
      },
    },
    // generate 域 API
    generate: {
      // 文本生成
      text: generateText,
    },
    // integration 域 API
    integration: {
      // list：列出集成
      list: () => response(integration.list()),
      // get：按 ID 取集成
      get: Effect.fn(function* (input) {
        // 查询集成
        const item = yield* integration.get(Integration.ID.make(input.integrationID))
        // 未找到则失败
        if (!item) return yield* Effect.fail(new Error(`Integration not found: ${input.integrationID}`))
        // 找到则包上位置返回
        return yield* response(Effect.succeed(item))
      }),
      // connect：连接方式（密钥/外部）
      connect: {
        // key：提交 API key 连接
        key: (input) =>
          // 调用密钥连接
          integration.connection.key({
            // 集成 ID
            integrationID: Integration.ID.make(input.integrationID),
            // 密钥
            key: input.key,
            // 表单回答
            answer: input.answer,
            // 标签
            label: input.label,
          }),
        // external：外部方式连接（如 CLI 登录）
        external: (input) =>
          // 调用外部连接
          integration.connection.external({
            // 集成 ID
            integrationID: Integration.ID.make(input.integrationID),
            // 方式 ID
            methodID: Integration.MethodID.make(input.methodID),
            // 表单回答
            answer: input.answer,
            // 标签
            label: input.label,
          }),
      },
      // oauth：OAuth 连接流程
      oauth: {
        // connect：发起 OAuth 授权
        connect: (input) =>
          // 包上位置信息
          response(
            // 调用 oauth 连接
            integration.oauth.connect({
              // 集成 ID
              integrationID: Integration.ID.make(input.integrationID),
              // 方式 ID
              methodID: Integration.MethodID.make(input.methodID),
              // 表单回答
              answer: input.answer,
              // 标签
              label: input.label,
            }),
          ),
        // status：查询授权尝试状态
        status: (input) =>
          // 包上位置信息
          response(
            // 调用状态查询
            integration.oauth.status({
              // 集成 ID
              integrationID: Integration.ID.make(input.integrationID),
              // 尝试 ID
              attemptID: Integration.AttemptID.make(input.attemptID),
            }),
          ),
        // complete：用授权码完成授权
        complete: (input) =>
          // 调用完成
          integration.oauth.complete({
            // 集成 ID
            integrationID: Integration.ID.make(input.integrationID),
            // 尝试 ID
            attemptID: Integration.AttemptID.make(input.attemptID),
            // 授权码
            code: input.code,
          }),
        // cancel：取消授权尝试
        cancel: (input) =>
          // 调用取消
          integration.oauth.cancel({
            // 集成 ID
            integrationID: Integration.ID.make(input.integrationID),
            // 尝试 ID
            attemptID: Integration.AttemptID.make(input.attemptID),
          }),
      },
      // command：命令式连接流程
      command: {
        // connect：发起命令连接
        connect: (input) =>
          // 包上位置信息
          response(
            // 调用命令连接
            integration.command.connect({
              // 集成 ID
              integrationID: Integration.ID.make(input.integrationID),
              // 方式 ID
              methodID: Integration.MethodID.make(input.methodID),
              // 标签
              label: input.label,
            }),
          ),
        // status：查询命令连接状态
        status: (input) =>
          // 包上位置信息
          response(
            // 调用状态查询
            integration.command.status({
              // 集成 ID
              integrationID: Integration.ID.make(input.integrationID),
              // 尝试 ID
              attemptID: Integration.AttemptID.make(input.attemptID),
            }),
          ),
        // cancel：取消命令连接
        cancel: (input) =>
          // 调用取消
          integration.command.cancel({
            // 集成 ID
            integrationID: Integration.ID.make(input.integrationID),
            // 尝试 ID
            attemptID: Integration.AttemptID.make(input.attemptID),
          }),
      },
      // reload：重载集成
      reload: integration.reload,
      // connection：连接子接口
      connection: {
        // active：取指定集成的当前活跃连接
        active: (id) => integration.connection.active(Integration.ID.make(id)),
        // resolve：把连接解析为凭据
        resolve: (connection) => integration.connection.resolve(connectionInfo(connection)),
        // status：上报连接状态
        status: (input) =>
          // 调用状态上报
          integration.connection.status({
            // 集成 ID
            integrationID: Integration.ID.make(input.integrationID),
            // 连接信息
            connection: connectionInfo(input.connection),
            // 状态值
            status: input.status,
          }),
      },
      // transform：以编辑器回调修改集成
      transform: (callback) =>
        // 调用服务 transform
        integration.transform((editor) => {
          // 包装编辑器接口
          callback({
            // 列出全部
            list: editor.list,
            // 按 ID 取
            get: (id) => editor.get(Integration.ID.make(id)),
            // 更新指定集成
            update: (id, update) => editor.update(Integration.ID.make(id), update),
            // 移除指定集成
            remove: (id) => editor.remove(Integration.ID.make(id)),
            // 方式（method）子编辑器
            method: {
              // 列出某集成的方式
              list: (id) => editor.method.list(Integration.ID.make(id)),
              // 更新方式（转换为内部实现）
              update: (input) => editor.method.update(methodImplementation(input)),
              // 移除某方式（先解码校验）
              remove: (id, method) =>
                editor.method.remove(Integration.ID.make(id), Schema.decodeUnknownSync(Integration.Method)(method)),
            },
          })
        }),
    },
    // mcp 域 API
    mcp: {
      // list：列出 MCP 服务器（支持跨位置）
      list: (input) => {
        // 解析目标位置
        const ref = locationRef(input)
        // 跨位置时在目标位置环境中查询
        if (ref && !isCurrentLocation(ref))
          // 在目标位置执行
          return atLocation(
            // 目标位置
            ref,
            // 先取 Mcp 服务再列服务器
            Effect.flatMap(Mcp.Service, (mcp) => mcp.servers()),
          )
        // 当前位置直接列表
        return response(mcp.servers())
      },
      // reload：重载 MCP 服务器
      reload: mcp.reload,
      // transform：以编辑器回调修改 MCP 配置
      transform: (callback) =>
        // 调用服务 transform
        mcp.transform((editor) => {
          // 包装编辑器接口
          callback({
            // 列出全部（配置转可变）
            list: () => editor.list().map(([name, config]) => [name, mutable(config)]),
            // 按 name 取（转可变）
            get: (name) => mutable(editor.get(name)),
            // 设置服务器（先解码校验）
            set: (name, config) => editor.set(name, Schema.decodeUnknownSync(ServerConfig)(config)),
            // 更新服务器
            update: editor.update,
            // 移除服务器
            remove: editor.remove,
          })
        }),
    },
    // permission 域 API
    permission: {
      // hook：注册权限相关钩子
      hook: (name, callback) => hooks.register("permission", name, callback),
      // list：列出某会话的权限请求
      list: (input) => permission.forSession(input.sessionID),
      // get：取单个权限请求（校验会话）
      get: sessionPermission,
      // reply：答复权限请求
      reply: (input) =>
        // 先校验请求属于该会话
        sessionPermission(input).pipe(
          // 再提交答复
          Effect.andThen(() =>
            permission.reply({ requestID: input.requestID, reply: input.decision, message: input.message }),
          ),
        ),
      // Plain rejections stay defects, as for built-in tools, so they end the step.
      // assert：断言权限通过；被拒/纠正/会话不存在转成工具错误（Tool.Error）
      assert: (input) =>
        // 调用权限断言
        permission.assert(input).pipe(
          // 按错误标签映射
          Effect.catchTags({
            // 被阻止：转为工具错误
            "Permission.BlockedError": (error) => Effect.fail(new Tool.Error({ message: error.message, error })),
            // 被纠正：转为携带反馈的工具错误
            "Permission.CorrectedError": (error) => Effect.fail(new Tool.Error({ message: error.feedback, error })),
            // 会话不存在：转为工具错误
            "Session.NotFoundError": (error) =>
              Effect.fail(new Tool.Error({ message: `Session not found: ${error.sessionID}`, error })),
          }),
        ),
    },
    // plugin 域 API
    plugin: {
      // list：列出已注册插件
      list: () => response(plugin.list()),
    },
    // reference 域 API
    reference: {
      // list：列出引用源
      list: () => response(reference.list()),
      // reload：重载引用
      reload: reference.reload,
      // transform：以编辑器回调修改引用
      transform: (callback) =>
        // 调用服务 transform
        reference.transform((editor) => {
          // 包装编辑器接口
          callback({
            // 添加引用源（先解码校验）
            add: (name, source) => editor.add(name, Schema.decodeUnknownSync(Reference.Source)(source)),
            // 移除引用源
            remove: editor.remove,
            // 列出全部
            list: editor.list,
            // 按名取
            get: editor.get,
          })
        }),
    },
    // skill 域 API
    skill: {
      // list：列出技能
      list: () => response(skill.list()),
      // reload：重载技能
      reload: skill.reload,
      // transform：以编辑器回调修改技能
      transform: (callback) =>
        // 调用服务 transform
        skill.transform((editor) => {
          // 包装编辑器接口
          callback({
            // 列出全部（转可变）
            list: () => mutable(editor.list()),
            // 按名取
            get: editor.get,
            // 添加技能（先解码校验）
            add: (value) => editor.add(Schema.decodeUnknownSync(Skill.Info)(value)),
            // 更新技能
            update: editor.update,
            // 移除技能
            remove: editor.remove,
          })
        }),
    },
    // storage：命名空间化的键值存储
    storage: storage(kv, pluginID),
    // shell 域 API
    shell: {
      // hook：注册 shell 钩子
      hook: (name, callback) => hooks.register("shell", name, callback),
    },
    // tool 域 API
    tool: {
      // transform：以编辑器回调修改工具
      transform: tools.transform,
      // reload：重载工具
      reload: tools.reload,
      // list：列出工具
      list: tools.list,
      // hook：注册工具钩子
      hook: (name, callback) => hooks.register("tool", name, callback),
    },
    // vcs 域 API
    vcs: {
      // get：取版本控制信息
      get: () => response(vcs.info()),
      // base：取基线（base）信息
      base: () => response(vcs.base()),
      // branch：分支子接口
      branch: {
        // list：列出分支（可搜索/限量）
        list: (input) => response(vcs.branches({ search: input?.search, limit: input?.limit })),
      },
      // status：取状态
      status: () => response(vcs.status()),
      // diff：取差异
      diff: (input) => response(vcs.diff(input.mode, { context: input.context, base: input.base })),
      // transform：以编辑器回调修改 vcs
      transform: vcs.transform,
      // reload：重载 vcs
      reload: vcs.reload,
    },
    // websearch 域 API
    websearch: {
      // providers：列出搜索提供方
      providers: () => response(websearch.providers()),
      // query：执行搜索
      query: (input) =>
        // 包上位置信息
        response(
          // 调用查询
          websearch.query({
            // 查询文本
            query: input.query,
            // 指定提供方（可选）
            providerID: input.providerID === undefined ? undefined : WebSearch.ID.make(input.providerID),
          }),
        ),
      // reload：重载搜索
      reload: websearch.reload,
      // transform：以编辑器回调修改搜索提供方
      transform: (callback) =>
        // 调用服务 transform
        websearch.transform((editor) => {
          // 包装编辑器接口
          callback({
            // 添加提供方
            add: (definition) =>
              editor.add({
                // 规范化 ID
                id: WebSearch.ID.make(definition.id),
                // 名称
                name: definition.name,
                // 执行实现
                execute: definition.execute,
              }),
            // 默认提供方
            default: {
              // 读默认
              get: editor.default.get,
              // 设默认（false/random 或具体 ID）
              set: (selection) =>
                editor.default.set(
                  selection === false || selection === "random" ? selection : WebSearch.ID.make(selection),
                ),
            },
          })
        }),
    },
    // worktree 域 API
    worktree: {
      // list：列出工作树
      list: worktrees.list,
      // create：创建工作树
      create: (input) => worktrees.create(input, currentWorktreeStrategies),
      // refresh：刷新工作树
      refresh: (input) => worktrees.refresh(input, currentWorktreeStrategies).pipe(Effect.asVoid),
      // remove：移除工作树
      remove: (input) => worktrees.remove(input, currentWorktreeStrategies),
      // reload：重载工作树策略
      reload: worktreeStrategies.reload,
      // transform：以编辑器回调注册策略
      transform: (callback) =>
        // 调用服务 transform
        worktreeStrategies.transform((editor) =>
          // 包装编辑器接口
          callback({
            // 添加策略（包装各实现并解码结果）
            add: (definition) =>
              editor.add({
                // 规范化 ID
                id: Worktree.StrategyID.make(definition.id),
                // 创建实现（结果经解码）
                create: (input) => definition.create(input).pipe(Effect.flatMap(decodeWorktree)),
                // 移除实现
                remove: (input) => definition.remove(input),
                // 列表实现（结果经解码）
                list: (directory) => definition.list(directory).pipe(Effect.flatMap(decodeWorktrees)),
              }),
          }),
        ),
    },
    // session 域 API
    session: {
      // hook：注册会话钩子
      hook: (name, callback, options) => hooks.register("session", name, callback, options),
      // list：列出会话
      list: sessions.list,
      // create：创建会话（处理父子与位置关系）
      create: (input) =>
        // 调用创建
        sessions.create({
          // 会话 ID
          id: input?.id,
          // 标题
          title: input?.title,
          // agent
          agent: input?.agent,
          // 模型
          model: input?.model,
          // 元数据
          metadata: input?.metadata,
          // 权限
          permissions: input?.permissions,
          // 无父会话：带位置；有父会话：仅带父 ID
          ...(input?.parentID === undefined
            ? {
                // 位置（缺省用当前位置）
                location:
                  input?.location ??
                  Location.Ref.make({ directory: location.directory, workspaceID: location.workspaceID }),
              }
            // 有父会话时记录父 ID
            : { parentID: input.parentID }),
        }),
      // get：取单个会话
      get: (input) => sessions.get(input.sessionID),
      // remove：移除会话
      remove: (input) => sessions.remove(input.sessionID),
      // switchAgent：切换会话 agent
      switchAgent: sessions.switchAgent,
      // switchModel：切换会话模型
      switchModel: sessions.switchModel,
      // prompt：向会话发送提示
      prompt: sessions.prompt,
      // generate：在会话中生成文本
      generate: (input) => sessions.generate(input).pipe(Effect.map((text) => ({ text }))),
      // command：执行会话命令（参数名映射 name -> command）
      command: (input) => sessions.command({ ...input, command: input.name }),
      // compact：压缩会话
      compact: sessions.compact,
      // update：更新会话（标题/元数据/权限，按需执行）
      update: Effect.fn(function* (input) {
        // 先确保会话存在
        yield* sessions.get(input.sessionID)
        // 标题存在则重命名
        if (input.title !== undefined) yield* sessions.rename({ sessionID: input.sessionID, title: input.title })
        // 元数据存在则设置
        if (input.metadata !== undefined)
          // 调用元数据设置
          yield* sessions.setMetadata({ sessionID: input.sessionID, metadata: input.metadata })
        // 权限存在则设置
        if (input.permissions !== undefined)
          // 调用权限设置
          yield* sessions.setPermissions({ sessionID: input.sessionID, permissions: input.permissions })
      }),
      // move：移动会话
      move: sessions.move,
      // synthetic：写入合成消息
      synthetic: sessions.synthetic,
      // interrupt：中断会话执行
      interrupt: (input) =>
        // 调用中断并包装结果
        sessions
          .interrupt(input.sessionID, { resume: input.resume })
          .pipe(Effect.map((interrupted) => ({ interrupted }))),
      // wait：等待会话空闲
      wait: (input) => sessions.wait(input.sessionID),
      // context：取会话上下文
      context: (input) => sessions.context(input.sessionID),
      // instructions：指令条目子接口
      instructions: {
        // entry：条目操作
        entry: {
          // list：列出条目（先确保会话存在）
          list: Effect.fn(function* (input) {
            // 确保会话存在
            yield* sessions.get(input.sessionID)
            // 返回条目列表
            return yield* instructionEntries.list(input.sessionID)
          }),
          // put：写入条目
          put: Effect.fn(function* (input) {
            // 解码校验键
            const key = yield* Schema.decodeUnknownEffect(InstructionEntry.Key)(input.key)
            // 确保会话存在
            yield* sessions.get(input.sessionID)
            // 写入条目
            yield* instructionEntries.put({ ...input, key })
          }),
          // remove：移除条目
          remove: Effect.fn(function* (input) {
            // 解码校验键
            const key = yield* Schema.decodeUnknownEffect(InstructionEntry.Key)(input.key)
            // 确保会话存在
            yield* sessions.get(input.sessionID)
            // 移除条目
            yield* instructionEntries.remove({ ...input, key })
          }),
        },
      },
    },
  }
  // 返回构建好的上下文
  return context
})

// requirements：插件宿主所需的全部服务节点分组
export const requirements = LayerNode.group([
  // 逐项列出各服务节点
  App.node,
  Agent.node,
  Artifact.node,
  AISDK.node,
  Provider.node,
  Model.node,
  Command.node,
  Bus.node,
  Integration.node,
  KV.node,
  Mcp.node,
  Location.node,
  Reference.node,
  Rpc.node,
  Skill.node,
  Tool.node,
  Vcs.node,
  WebSearch.node,
  Worktree.node,
  WorktreeStrategies.node,
  Generate.node,
  Permission.node,
  PluginHooks.node,
  Session.node,
  InstructionEntry.node,
  PersistentPty.node,
  LocationServiceMap.node,
])

// storage：为插件构造带命名空间前缀的键值存储
export function storage(kv: KV.Interface, pluginID: string): Plugin.Context["storage"] {
  // 命名空间：把插件 ID 每个字符转为 4 位十六进制后拼接，避免特殊字符冲突
  const namespace = `plugin:${pluginID
    .split("")
    .map((value) => value.charCodeAt(0).toString(16).padStart(4, "0"))
    .join("")}:`
  // 返回存储接口
  return {
    // get：读取（自动加前缀）
    get: (key) => kv.get(namespace + key),
    // set：写入（自动加前缀）
    set: (key, value) => kv.set(namespace + key, value),
    // remove：移除（自动加前缀）
    remove: (key) => kv.remove(namespace + key),
    // scan：按前缀扫描
    scan: (options) =>
      // 调用底层扫描
      kv
        .scan({
          // 拼接前缀
          prefix: namespace + options.prefix,
          // 游标也需加前缀
          after: options.after === undefined ? undefined : namespace + options.after,
          // 数量限制
          limit: options.limit,
        })
        .pipe(
          // 结果剥离命名空间前缀
          Effect.map((result) => {
            // 逐条剥前缀
            const entries = result.entries.map((entry) => ({
              // 去掉前缀后的键
              key: entry.key.slice(namespace.length),
              // 原值
              value: entry.value,
            }))
            // 无下一页则直接返回
            if (result.next === undefined) return { entries }
            // 下一页游标剥前缀返回
            return { entries, next: result.next.slice(namespace.length) }
          }),
        ),
  }
}

// methodImplementation：把插件注册的集成方式转成内部实现结构
function methodImplementation(input: IntegrationMethodRegistration): Integration.Implementation {
  // 含 authorize 的为 OAuth 方式
  if ("authorize" in input) {
    // 取可选的刷新实现
    const refresh = input.refresh
    // 返回 OAuth 实现结构
    return {
      // 集成 ID
      integrationID: Integration.ID.make(input.integrationID),
      // 方式描述（规范化 ID）
      method: { ...input.method, id: Integration.MethodID.make(input.method.id) },
      // 授权实现：包装授权结果中的凭据
      authorize: (answer) =>
        // 调用插件授权
        input.authorize(answer).pipe(
          // 对授权结果做凭据规范化
          Effect.map((authorization) => {
            // 自动模式：回调是效果的流
            if (authorization.mode === "auto") {
              // 规范化回调结果
              return {
                // 保留其余字段
                ...authorization,
                // 回调结果经 credential 规范化
                callback: authorization.callback.pipe(Effect.map(credential)),
              }
            }
            // 手动模式：回调接收授权码
            return {
              // 保留其余字段
              ...authorization,
              // 回调结果经 credential 规范化
              callback: (code: string) => authorization.callback(code).pipe(Effect.map(credential)),
            }
          }),
        ),
      // 有刷新实现时附加（结果经 credential 规范化）
      ...(refresh ? { refresh: (value: Credential.OAuth) => refresh(value).pipe(Effect.map(credential)) } : {}),
      // 有标签时附加
      ...(input.label ? { label: input.label } : {}),
    }
  }
  // env 方式：直接透传
  if (input.method.type === "env") {
    // 返回 env 实现结构
    return {
      // 集成 ID
      integrationID: Integration.ID.make(input.integrationID),
      // 方式描述
      method: input.method,
    }
  }
  // command 方式：规范化 ID 后透传
  if (input.method.type === "command") {
    // 返回 command 实现结构
    return {
      // 集成 ID
      integrationID: Integration.ID.make(input.integrationID),
      // 方式描述（规范化 ID）
      method: { ...input.method, id: Integration.MethodID.make(input.method.id) },
    }
  }
  // external 方式：规范化 ID 后透传
  if (input.method.type === "external") {
    // 返回 external 实现结构
    return {
      // 集成 ID
      integrationID: Integration.ID.make(input.integrationID),
      // 方式描述（规范化 ID）
      method: { ...input.method, id: Integration.MethodID.make(input.method.id) },
    }
  }
  // 其余方式：直接透传
  return {
    // 集成 ID
    integrationID: Integration.ID.make(input.integrationID),
    // 方式描述
    method: input.method,
  }
}

// connectionInfo：把插件侧连接描述规范化为内部 Info
function connectionInfo(
  // 凭据型连接（含字符串 id）或环境变量型连接
  connection:
    | (Omit<IntegrationConnection.CredentialInfo, "id"> & { readonly id: string })
    | IntegrationConnection.EnvInfo,
  // 返回内部连接信息
): IntegrationConnection.Info {
  // 凭据型：规范化 ID；环境型：原样返回
  return connection.type === "credential" ? { ...connection, id: Credential.ID.make(connection.id) } : connection
}

// credential：规范化 OAuth 凭据（methodID 转为内部品牌类型）
function credential(value: Credential.OAuth) {
  // 重建凭据对象
  return Credential.OAuth.make({ ...value, methodID: Integration.MethodID.make(value.methodID) })
}
