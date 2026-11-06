// 导入 Model 模式（schema）定义，本模块所有模型（model）相关类型与校验器都来自这里
import { Model } from "@opencode/schema/model"
// 导入 Provider 模块：供应商（provider）定义、设置与合并逻辑
import { Provider } from "./provider.js"
// 仅导入 DeepMutable 类型工具：把 Info 的深层属性变为可变，便于草稿（draft）编辑
import type { DeepMutable } from "./schema.js"
// 从 effect 库导入 Context（服务上下文）、Effect（效果）、Layer（层）、Stream（流）
import { Context, Effect, Layer, Stream } from "effect"
// 导入 makeLocationNode：把服务包装成位置（location）节点的工厂函数
import { makeLocationNode } from "@opencode/util/effect/app-node"
// 导入 Bus（事件总线）服务：用于发布/订阅事件
import { Bus } from "./bus.js"
// 导入 State（状态管理）模块：提供可变换、可通知的状态容器
import { State } from "./state.js"
// 导入 Location（位置）服务：提供当前目录/工作区信息
import { Location } from "./location.js"
// 从 immer 导入 freeze：深度冻结对象使其不可变
import { freeze } from "immer"
// 导入 AISDKNative：原生 AI SDK 提供商识别与包名重写逻辑
import { AISDKNative } from "./aisdk-native.js"

// 直接导出 Model.ID：模型 ID（ID）的 schema 校验器
export const ID = Model.ID
// 导出 ID 的类型别名（typeof ID.Type 取 schema 解析出的类型）
export type ID = typeof ID.Type

// 导出 Model.VariantID：变体 ID（variant ID）的 schema 校验器
export const VariantID = Model.VariantID
// 导出 VariantID 的类型别名
export type VariantID = typeof VariantID.Type

// Grouping of models, eg claude opus, claude sonnet
// 导出模型家族（family）：模型分组，如 claude opus、claude sonnet
export const Family = Model.Family
// 导出 Family 的类型别名
export type Family = Model.Family

// 导出 ReasoningField：推理（reasoning）字段兼容性定义
export const ReasoningField = Model.ReasoningField
// 导出 ReasoningField 的类型别名
export type ReasoningField = Model.ReasoningField

// 导出 Compatibility：兼容性（compatibility）定义（推理字段等适配信息）
export const Compatibility = Model.Compatibility
// 导出 Compatibility 的类型别名
export type Compatibility = Model.Compatibility

// 导出 Capabilities：能力（capabilities）定义（工具、输入输出媒体、温度等）
export const Capabilities = Model.Capabilities
// 导出 Capabilities 的类型别名
export type Capabilities = Model.Capabilities

/** Merges partial config capabilities onto a base model's capabilities, defaulting unset fields. */
// 把配置里的部分能力合并到基础模型能力上，未设置的字段取默认值
export const mergeCapabilities = (config: Partial<Capabilities>, base: Capabilities | undefined) => {
  // 基础能力缺失时用 Capabilities 的默认值兜底
  const fallback = base ?? Capabilities.default()
  // 返回合并后的能力对象：每项都优先取 config，缺失则回退到 fallback/base
  return {
    // 工具（tools）支持：config 优先，否则用 fallback
    tools: config.tools ?? fallback.tools,
    // 输入（input）媒体类型：config 优先，浅拷贝一份避免共享引用
    input: [...(config.input ?? fallback.input)],
    // 输出（output）媒体类型：同上，浅拷贝
    output: [...(config.output ?? fallback.output)],
    // 温度（temperature）支持：config 优先，其次取 base 上的值
    temperature: config.temperature ?? base?.temperature,
  }
}

// 导出 Cost：费用（cost）定义（每百万 token 的输入/输出/缓存价格）
export const Cost = Model.Cost

// 导出 Type：模型类型（type），如 chat（聊天）、image（图像）、decision（决策）
export const Type = Model.Type
// 导出 Type 的类型别名
export type Type = Model.Type

// 导出 Ref：模型引用（ref）定义
export const Ref = Model.Ref
// 导出 Ref 的类型别名
export type Ref = typeof Ref.Type

// 导出 Info：模型信息（model info）的完整定义
export const Info = Model.Info
// 导出 Info 的类型别名
export type Info = Model.Info

/** Effective provider and model settings used only while constructing a runtime model. */
// RuntimeInfo：仅用于构建运行时模型时生效的供应商与模型设置（settings 为可选）
export type RuntimeInfo = Omit<Info, "settings"> & { readonly settings?: Provider.Settings }

// MutableInfo：深层可变的模型信息，供编辑器草稿修改
export type MutableInfo = DeepMutable<Info>

// 转发导出 @opencode/schema/model 中的 Event（事件）定义
export { Event } from "@opencode/schema/model"

// Editor 接口：在状态变换（transform）期间使用的可变编辑视图
export interface Editor {
  /** Includes disabled candidates so later transforms can re-enable them. */
  // 列出模型；包含已禁用的候选，便于后续变换重新启用；可按 providerID 过滤
  readonly list: (providerID?: Provider.ID) => readonly MutableInfo[]
  // 按 providerID + modelID 取单个可变模型信息，找不到返回 undefined
  readonly get: (providerID: Provider.ID, modelID: ID) => MutableInfo | undefined
  // 更新指定模型：以回调形式在可变草稿上修改
  readonly update: (providerID: Provider.ID, modelID: ID, update: (model: MutableInfo) => void) => void
  // 删除指定模型
  readonly remove: (providerID: Provider.ID, modelID: ID) => void
  // 默认模型的读取与设置
  readonly default: {
    // 读取当前默认模型（providerID + modelID），未设置返回 undefined
    readonly get: () => { providerID: Provider.ID; modelID: ID } | undefined
    // 设置默认模型
    readonly set: (providerID: Provider.ID, modelID: ID) => void
  }
  /** Coherent, read-only provider inputs, including definitions from inactive providers. */
  // 供应商只读视图：返回一致的输入，包含未激活供应商的定义
  readonly provider: {
    // 列出所有供应商定义
    readonly list: () => readonly Provider.Definition[]
    // 按 ID 取单个供应商定义
    readonly get: (providerID: Provider.ID) => Provider.Definition | undefined
  }
}

// Interface 接口：Model 服务的对外能力，继承 State.Transformable 以支持插件变换
export interface Interface extends State.Transformable<Editor> {
  // 按 providerID + modelID 取模型信息（Effect 异步），找不到返回 undefined
  readonly get: (providerID: Provider.ID, modelID: ID) => Effect.Effect<Info | undefined>
  // 返回全部模型信息（只读数组）
  readonly all: () => Effect.Effect<readonly Info[]>
  /** Enabled models of the given types, chat when none are given. Only chat models are offered for sessions. */
  // 返回指定类型的已启用模型；缺省为 chat。只有 chat 模型会提供给会话（session）
  readonly available: (types?: readonly Model.Type[]) => Effect.Effect<readonly Info[]>
  // 返回默认模型（用户指定或第一个可用的文本模型）
  readonly default: () => Effect.Effect<Info | undefined>
  // 返回指定供应商下的"小模型"（用于摘要等轻量任务）
  readonly small: (providerID: Provider.ID) => Effect.Effect<Info | undefined>
}

// 定义 Model 服务标识：通过 Context 按标签 "@opencode/Model" 获取服务实例
export class Service extends Context.Service<Service, Interface>()("@opencode/Model") {}

// Data：状态容器内部的数据结构
type Data = {
  // 按供应商 ID 分组的模型信息映射（只读）
  models: Map<Provider.ID, ReadonlyMap<ID, Info>>
  // 用户设置的默认模型（可选）
  defaultModel?: { providerID: Provider.ID; modelID: ID }
}

// layer：Model 服务的 Effect Layer（层）实现
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 获取 Provider 服务依赖：读取供应商快照
    const providers = yield* Provider.Service
    // 获取 Bus 服务依赖：发布模型更新事件
    const bus = yield* Bus.Service
    // 获取 Location 服务依赖：携带目录/工作区信息
    const location = yield* Location.Service
    // 判断是否禁用免费模型：环境变量 OPENCODE_DISABLE_FREE_MODELS 为 "1" 或 "true"
    const disableFree = ["1", "true"].includes(process.env.OPENCODE_DISABLE_FREE_MODELS?.toLowerCase() ?? "")
    // input：最近一次读取到的供应商快照缓存
    let input: Provider.Snapshot | undefined
    // 创建状态容器：管理模型映射与编辑器（editor）
    const state: State.Interface<Data, Editor> = State.create<Data, Editor>({
      // 状态名称，用于调试与日志
      name: "model",
      // 初始数据：把供应商快照中可用的模型记录转成 providerID -> models 映射
      initial: () => ({
        models: new Map((input?.available ?? []).map((record) => [record.provider.id, record.models])),
      }),
      // editor：构建编辑视图；写时复制保证定义对象不被共享方意外修改
      editor: (data) => {
        // Definitions are shared across Locations; a provider's map and a model are copied before their first edit.
        // owned：记录已被本编辑器接管（复制）的模型映射集合（弱引用）
        const owned = new WeakSet<ReadonlyMap<ID, Info>>()
        // drafts：记录已被复制成草稿的模型信息集合（弱引用）
        const drafts = new WeakSet<Info>()
        // writable：取出指定供应商的可写模型映射；首次编辑时复制原映射
        const writable = (providerID: Provider.ID) => {
          // 当前该供应商的只读映射
          const current = data.models.get(providerID)
          // 供应商不存在则无可写映射
          if (!current) return undefined
          // 已是本编辑器拥有的映射则直接返回
          if (owned.has(current)) return current as Map<ID, Info>
          // 首次编辑：复制一份映射
          const copy = new Map(current)
          // 登记为已拥有
          owned.add(copy)
          // 替换 data 中的映射
          data.models.set(providerID, copy)
          // 返回可写映射
          return copy
        }
        // draft：取出指定模型的可变草稿；首次编辑时深拷贝
        const draft = (providerID: Provider.ID, modelID: ID) => {
          // 先确保供应商映射可写
          const models = writable(providerID)
          // 供应商不存在则无草稿
          if (!models) return undefined
          // 取当前模型定义
          const current = models.get(modelID)
          // 模型不存在则无草稿
          if (!current) return undefined
          // 已是草稿则直接返回，避免重复拷贝
          if (drafts.has(current)) return current as MutableInfo
          // 首次编辑：结构化深拷贝成可变信息
          const copy = structuredClone(current) as MutableInfo
          // 登记为草稿
          drafts.add(copy)
          // 写回映射
          models.set(modelID, copy)
          // 返回草稿
          return copy
        }
        // 返回编辑器对象
        return {
          // list：枚举模型草稿；未指定 providerID 时枚举所有供应商
          list: (providerID) => {
            // 计算要枚举的供应商 ID 列表
            const ids = providerID === undefined ? Array.from(data.models.keys()) : [providerID]
            // 对每个供应商的每个模型尝试取草稿（不存在的模型会被 draft 跳过）
            return ids.flatMap((id) =>
              Array.from(data.models.get(id)?.keys() ?? []).flatMap((modelID) => draft(id, modelID) ?? []),
            )
          },
          // get：即 draft（取可变草稿）
          get: draft,
          update: (providerID, modelID, update) => {
            // Model edits cannot create/enable a provider or bypass its availability decision.
            // 先确保供应商映射可写；供应商不存在则直接忽略更新
            const models = writable(providerID)
            // 无可写映射则不处理
            if (!models) return
            // 取已有草稿；模型不存在时基于默认模板新建
            const model = draft(providerID, modelID) ?? (Info.default(providerID, modelID) as MutableInfo)
            // 执行用户提供的更新回调
            update(model)
            // 强制回写模型 ID，防止更新回调篡改
            model.id = modelID
            // 强制回写供应商 ID
            model.providerID = providerID
            // 查找供应商定义，用于补全包名等信息
            const provider = input?.records.get(providerID)?.provider
            // 用 AISDKNative 重写模型的解析相关字段
            AISDKNative.rewrite(model, {
              // 包名：模型自带优先，其次供应商自带
              specifier: model.package ?? provider?.package,
              // 供应商 ID
              providerID,
              // 规范名（canonical）：模型自带优先，其次供应商
              canonical: model.canonical ?? provider?.canonical,
              // 原始模型 ID：模型自带优先，否则用键名
              modelID: model.modelID ?? modelID,
            })
            // 登记为草稿（新模板情况）
            drafts.add(model)
            // 写回映射
            models.set(modelID, model)
          },
          remove: (providerID, modelID) => {
            // 从可写映射中删除指定模型；供应商不存在则忽略
            writable(providerID)?.delete(modelID)
          },
          // default：默认模型的读写
          default: {
            // 读取默认模型设置
            get: () => data.defaultModel,
            // 写入默认模型设置
            set: (providerID, modelID) => {
              // 记录 providerID + modelID
              data.defaultModel = { providerID, modelID }
            },
          },
          // provider：供应商定义的只读视图
          provider: {
            // 列出快照中的所有供应商定义
            list: () => Array.from(input?.records.values() ?? []),
            // 按 ID 取供应商定义
            get: (providerID) => input?.records.get(providerID),
          },
        }
      },
      // read() also refreshes dependencies changed inside a State.batch before notification.
      // notify：通知回调指向下文的 notify 效果
      notify: () => notify,
    })
    // 注册终止器（finalizer）：服务关闭时停止状态容器
    yield* Effect.addFinalizer(() => State.shutdown(state.reload()))
    // cached：最近一次构建的快照（数据 + 各类视图）
    let cached:
      | {
          // 构建快照时的数据引用，用于检测变化
          data: Data
          // 全部模型（含非 chat 类型移除前的排序结果）
          all: readonly Info[]
          // 可用（启用）的 chat 模型
          available: readonly Info[]
          // 非_chat 类型（image、decision…）按类型分组的模型
          other: ReadonlyMap<Model.Type, readonly Info[]>
          // 按供应商 ID 分组的合并后模型映射
          byProvider: ReadonlyMap<Provider.ID, ReadonlyMap<ID, Info>>
        }
      | undefined
    // An unedited model keeps its shared definition object across rebuilds, so its merged output is reusable.
    // merged：缓存"原始模型定义 -> 合并后结果"的映射，避免重复合并（弱引用）
    const merged = new WeakMap<Info, { provider: Provider.Info | undefined; model: Info }>()
    // read：构建/返回模型快照的核心流程
    const read = Effect.fn("Model.snapshot")(function* () {
      // 循环重试，直到快照与输入一致（处理并发变化）
      while (true) {
        // 读取当前供应商快照
        const current = yield* providers.snapshot()
        // 供应商快照变化时更新缓存输入并使状态失效
        if (input !== current) {
          // 记录新输入
          input = current
          // 使状态失效，触发重建
          state.invalidate()
        }
        // 读取状态数据（可能被重建）
        const data = state.get()
        // 数据未变时直接返回上次缓存，避免重复计算
        if (cached?.data === data) return cached
        // A failed model transform can remove its plugin's provider/integration registrations.
        // Re-materialize from the surviving inputs, not from the failed candidate's seed.
        // 若在构建期间供应商快照又变了（例如变换失败移除了注册），重试
        if (current !== (yield* providers.snapshot())) continue
        // byProvider：按供应商分组构建合并后的模型映射
        const byProvider = new Map(
          Array.from(data.models, ([providerID, models]) => {
            // 取该供应商的供应商级定义
            const provider = current.records.get(providerID)?.provider
            // 返回 [providerID, 合并后模型映射] 对
            return [
              providerID,
              new Map(
                Array.from(models, ([id, model]) => {
                  // 查缓存：同一模型定义在同一供应商下可直接复用上次合并结果
                  const reusable = merged.get(model)
                  // 命中缓存则直接返回上次结果
                  if (reusable && reusable.provider === provider) return [id, reusable.model]
                  // 否则现场合并：展开模型定义并叠加供应商信息
                  const value = {
                    // 展开模型自身字段
                    ...model,
                    // 供应商有规范名时覆盖
                    ...(provider?.canonical === undefined ? {} : { canonical: provider.canonical }),
                    // 包名：模型自带优先，其次供应商
                    package: model.package ?? provider?.package,
                    // 兼容性：供应商与模型按字段合并（模型优先）
                    compatibility:
                      provider?.compatibility === undefined
                        ? model.compatibility
                        : { ...provider.compatibility, ...model.compatibility },
                    // 设置：供应商可下发的设置与模型设置做覆盖合并
                    settings: Provider.mergeOverlay(
                      Provider.modelSettings(provider?.settings),
                      Provider.modelSettings(model.settings),
                    ),
                    // 请求头：供应商与模型按名字（大小写不敏感）合并
                    headers: Provider.mergeHeaders(provider?.headers, model.headers),
                    // 请求体覆盖：供应商与模型做覆盖合并
                    body: Provider.mergeOverlay(provider?.body, model.body),
                  } satisfies Info
                  // 写入合并缓存
                  merged.set(model, { provider, model: value })
                  // 返回合并后的键值对
                  return [id, value]
                }),
              ),
            ]
          }),
        )
        // 环境变量要求禁用免费模型时
        if (disableFree)
          // 遍历 OpenCode 官方免费渠道（opencode 与 opencode-go）
          for (const providerID of [Provider.ID.opencode, Provider.ID.make("opencode-go")])
            // 删除所有输入价格为 0（免费）的模型
            byProvider.get(providerID)?.forEach((model, id, models) => {
              // 没有任何 input>0 的价格档视为免费
              if (!model.cost.some((cost) => cost.input > 0)) models.delete(id)
            })
        // Non-chat models (image, decision…) only show up when listed by type, so nothing that
        // picks or resolves a session model can reach them.
        // other：把非 chat 类型模型从 byProvider 中移出，按类型分组存放
        const other = new Map<Model.Type, Info[]>()
        // 遍历每个供应商的映射
        byProvider.forEach((models) =>
          // 遍历每个模型
          models.forEach((model, id) => {
            // chat 类型（或缺省）保留在原映射
            if ((model.type ?? "chat") === "chat") return
            // 非_chat 类型从供应商映射删除
            models.delete(id)
            // 已启用的非 chat 模型按类型归入 other
            if (model.enabled) other.set(model.type!, [...(other.get(model.type!) ?? []), model])
          }),
        )
        // all：展平所有模型并按发布时间倒序排序（新模型在前）
        const all = Array.from(byProvider.values())
          .flatMap((models) => Array.from(models.values()))
          .sort((left, right) => right.time.released - left.time.released)
        // 非_chat 分组内部也按发布时间倒序排序
        other.forEach((models) => models.sort((left, right) => right.time.released - left.time.released))
        // 深度冻结快照并缓存，保证对外只读
        cached = freeze(
          { data, all, available: preferFree(all.filter((model) => model.enabled)), other, byProvider },
          true,
        )
        // 返回构建好的快照
        return cached
      }
    })
    // prepare：读取供应商快照，并在其变化时使状态失效（供变换/重载前对齐输入）
    const prepare = providers.snapshot().pipe(
      // 附加副作用：检查并同步输入
      Effect.tap((current) =>
        Effect.sync(() => {
          // 输入未变则无事发生
          if (input === current) return
          // 记录新输入
          input = current
          // 使状态失效
          state.invalidate()
        }),
      ),
    )
    // reload：对齐输入后重载状态（重新执行 initial 与变换）
    const reload = () => prepare.pipe(Effect.andThen(state.reload()))
    // published：上次已广播事件对应的快照
    let published: typeof cached
    // notify：重新读取快照，变化时发布模型更新事件
    const notify: Effect.Effect<void> = Effect.gen(function* () {
      // 读取最新快照
      const value = yield* read()
      // 快照未变则不重复广播
      if (value === published) return
      // 记录已广播的快照
      published = value
      // 通过总线发布 Updated 事件
      yield* bus.publish(
        Model.Event.Updated,
        // 事件负载为空（详情由客户端拉取）
        {},
        {
          // 携带目录与工作区 ID 的位置信息
          location: { directory: location.directory, workspaceID: location.workspaceID },
        },
      )
    })
    // 订阅供应商更新事件：供应商变化时触发模型重新通知
    yield* bus.subscribe(Provider.Event.Updated).pipe(
      // 对每条事件执行 notify
      Stream.runForEach(() => notify),
      // 在当前作用域立即启动后台协程
      Effect.forkScoped({ startImmediately: true }),
    )
    // 返回服务实现
    return Service.of({
      // transform：在状态变换中修改模型（先对齐供应商输入）
      transform: (update) => prepare.pipe(Effect.andThen(state.transform(update))),
      // reload：重载状态
      reload,
      // get：按 providerID + modelID 取合并后的模型信息
      get: Effect.fn("Model.get")((providerID, modelID) =>
        read().pipe(Effect.map((value) => value.byProvider.get(providerID)?.get(modelID))),
      ),
      // all：返回全部模型
      all: Effect.fn("Model.all")(() => read().pipe(Effect.map((value) => value.all))),
      // available：按类型返回可用模型；缺省或空数组返回 chat 模型
      available: Effect.fn("Model.available")((types?: readonly Model.Type[]) =>
        read().pipe(
          Effect.map((value) =>
            // 未指定类型或空数组时返回 chat 模型
            types === undefined || types.length === 0
              ? value.available
              // 否则按请求的类型去重后拼接对应分组（chat 用 available，其余用 other）
              : [...new Set(types)].flatMap((type) =>
                  type === "chat" ? value.available : (value.other.get(type) ?? []),
                ),
          ),
        ),
      ),
      // default：返回默认模型
      default: Effect.fn("Model.default")(function* () {
        // 读取快照
        const value = yield* read()
        // 取用户设置的默认模型引用
        const requested = value.data.defaultModel
        // 按引用查找模型定义
        const model = requested && value.byProvider.get(requested.providerID)?.get(requested.modelID)
        // 默认模型仍启用则用它，否则回退到第一个支持文本的可用模型
        return model?.enabled ? model : value.available.find(supportsText)
      }),
      // small：返回指定供应商下的"小模型"
      small: Effect.fn("Model.small")(function* (providerID) {
        // 读取快照
        const value = yield* read()
        // 过滤出该供应商下活跃且支持文本输入/输出的模型
        const models = value.available.filter(
          (model) =>
            // 供应商匹配
            model.providerID === providerID &&
            // 状态为活跃（active）
            model.status === "active" &&
            // 输入能力含文本
            model.capabilities.input.some((item) => item.startsWith("text")) &&
            // 输出能力含文本
            model.capabilities.output.some((item) => item.startsWith("text")),
        )
        // 按偏好家族顺序找到第一个匹配的模型；找不到则返回 undefined
        return ["gpt-luna", "gemini-flash-lite", "gemini-flash", "claude-haiku"].flatMap(
          (family) => models.find((model) => model.family === family) ?? [],
        )[0]
      }),
    })
  }),
)

// 导出 node：把 Model 服务挂到位置（location）节点，依赖 Provider/Bus/Location 节点
export const node = makeLocationNode({ service: Service, layer, deps: [Provider.node, Bus.node, Location.node] })

// Signed out, only free OpenCode models are enabled. Clients default to the first available model, so keep
// these free models ahead of each new free launch instead of letting release order pick the default.
// 未登录时仅启用 OpenCode 官方免费模型；客户端默认取第一个可用模型，
// 因此把这几款免费模型排在发布顺序之前，避免新模型上线即成为默认。
const PREFERRED_FREE = [
  // 偏好顺序：big-pickle 最优先
  "big-pickle",
  // 其次 deepseek-v4.1-flash-free
  "deepseek-v4.1-flash-free",
  // 再次 glm-5.3-flash-free
  "glm-5.3-flash-free",
  // 最后 muse-spark-1.3-contributor-free
  "muse-spark-1.3-contributor-free",
]

// preferFree：当模型列表全部是 OpenCode 官方免费模型时，按偏好顺序重排
function preferFree(models: Info[]) {
  // 判断是否"全为官方免费模型"：每个模型都属于 opencode 供应商且输入价格为 0
  const freeOnly = models.every(
    (model) => model.providerID === Provider.ID.opencode && !model.cost.some((cost) => cost.input > 0),
  )
  // 混有付费或非官方模型时不重排
  if (!freeOnly) return models
  // 按偏好顺序挑出存在的模型
  const picks = PREFERRED_FREE.flatMap((id) => models.find((model) => model.id === id) ?? [])
  // 偏好模型在前，其余模型按原顺序跟在后面
  return [...picks, ...models.filter((model) => !picks.includes(model))]
}

// supportsText：判断模型是否支持文本输入与输出（能力列表为空视为不限制）
export function supportsText(model: Pick<Info, "capabilities">) {
  // 输入与输出两侧都需通过：能力为空或包含以 "text" 开头的媒体类型
  return (
    // 输入侧：无输入限制或含文本输入
    (model.capabilities.input.length === 0 || model.capabilities.input.some((item) => item.startsWith("text"))) &&
    // 输出侧：无输出限制或含文本输出
    (model.capabilities.output.length === 0 || model.capabilities.output.some((item) => item.startsWith("text")))
  )
}

// compatibility：把用户配置里的兼容性字段解析为 Compatibility（旧格式为字符串）
export function compatibility(input: unknown): Compatibility | undefined {
  // 字符串形式：直接当作推理字段（reasoning field）名
  if (typeof input === "string") return { reasoningField: input }
  // 非对象、null、数组或缺少 "field" 键时视为无效
  if (typeof input !== "object" || input === null || Array.isArray(input) || !("field" in input)) return undefined
  // 对象形式：取 field 字符串作为推理字段名
  return typeof input.field === "string" ? { reasoningField: input.field } : undefined
}

// parse：把 "provider/model" 形式的字符串拆成 providerID 与 modelID
export function parse(input: string): { providerID: Provider.ID; modelID: ID } {
  // 查找第一个 "/" 的位置
  const index = input.indexOf("/")
  // 无 "/" 时整个字符串作为 providerID，modelID 为空
  return {
    // 供应商 ID：取 "/" 前的部分（无分隔符则为整串）
    providerID: Provider.ID.make(index === -1 ? input : input.slice(0, index)),
    // 模型 ID：取 "/" 后的部分（无分隔符则为空串）
    modelID: ID.make(index === -1 ? "" : input.slice(index + 1)),
  }
}

// 末尾自导出：便于其他模块以 `import { Model } from "./model.js"` 引用命名空间
export * as Model from "./model.js"
