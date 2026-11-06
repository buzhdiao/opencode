// 配置提供方插件（Config Provider Plugin）：把配置中的提供方（provider）与模型覆盖应用到运行时注册表。
export * as ConfigProviderPlugin from "./provider.js"

// 导入模型编辑器类型。
import type { ModelEditor } from "@opencode/plugin/effect/model"
// 导入提供方编辑器类型。
import type { ProviderEditor } from "@opencode/plugin/effect/provider"
// 导入插件定义工具。
import { define } from "@opencode/plugin/effect/plugin"
// 导入配置文档与条目类型。
import { Document, type Entry } from "@opencode/schema/config"
// 导入提供方配置模式。
import { ConfigProvider } from "@opencode/schema/config/provider"
// 导入金额类型（费用计算）。
import { Money } from "@opencode/schema/money"
// 导入 Effect。
import { Effect } from "effect"
// 导入配置服务。
import { Config } from "../../config.js"
// 导入模型服务与类型。
import { Model } from "../../model.js"
// 导入提供方服务。
import { Provider } from "../../provider.js"
// 导入变体（variant）工具。
import { Variant } from "../../variant.js"
// 导入配置集成工具。
import { ConfigIntegration } from "../integration.js"
// 导入配置条目观察器。
import { ConfigEntryObserver } from "./entry-observer.js"

// 定义插件。
export const Plugin = define({
  // 插件 ID。
  id: "opencode.config.provider",
  // 插件主流程。
  effect: Effect.fn(function* (ctx) {
    // 获取配置服务。
    const config = yield* Config.Service
    // 观察配置：更新时先重载集成再重载提供方。
    const loaded = yield* ConfigEntryObserver.observe(
      config,
      ctx.event,
      ctx.integration.reload().pipe(Effect.andThen(ctx.provider.reload())),
    )
    // 应用集成层面的注册（认证方式与名称）。
    yield* ctx.integration.transform((integrations) => {
      // 遍历配置中声明的每个提供方。
      for (const [id, provider] of configuredProviders(loaded.entries)) {
        // 集成 ID 即提供方 ID。
        const integrationID = id
        // 集成尚不存在时注册默认的密钥输入方式。
        if (!integrations.get(integrationID)) {
          integrations.method.update({
            integrationID,
            method: { type: "key", label: "Manually enter API Key" },
          })
        }
        // 更新集成名称（提供方有名字才覆盖）。
        integrations.update(integrationID, (integration) => {
          integration.name = provider.name || integration.name
        })
        // 声明了 env 时改用环境变量取密钥方式。
        if (provider.env !== undefined) {
          integrations.method.update({
            integrationID,
            method: { type: "env", names: [...provider.env] },
          })
        }
      }
    })

    // 跨 transform 共享的状态：默认模型与每个配置提供方的模型定义。
    const sources = {
      // 最后声明的默认模型选择。
      defaultModel: undefined as Document["info"]["model"],
      // 配置提供方 → 其模型定义（是否继承、基准模型）。
      models: new Map<
        ConfigProvider.Info,
        {
          readonly providerID: string
          readonly models: ReadonlyMap<string, { readonly inherit: boolean; readonly base?: Model.Info }>
        }
      >(),
    }
    // 应用提供方层面的覆盖。
    yield* ctx.provider.transform((providers) => {
      // 本轮构建的模型定义映射。
      const next: typeof sources.models = new Map()
      // 遍历配置中的每个提供方。
      for (const [id, item] of configuredProviders(loaded.entries)) {
        // 提供方 ID。
        const providerID = id
        // 应用提供方覆盖并取出源提供方信息。
        const { current, source, changed } = overlayProvider(providers, providerID, item)
        // 该提供方的模型定义表。
        const definitions = new Map<string, { readonly inherit: boolean; readonly base?: Model.Info }>()
        // 遍历配置中声明的每个模型。
        for (const [id, config] of Object.entries(item.models ?? {})) {
          // 解析基准模型：按配置的 modelID 或模型 ID 从源提供方查找。
          const base = source?.models.get(config.modelID ?? id) ?? source?.models.get(id)
          // 是否继承：源提供方变化或该模型尚不存在时从基准开始。
          const inherit = changed || !current?.models.has(id)
          // Bind the source at this point in the provider fold. Later source edits/removal
          // and its credential availability must not change an already-defined alias.
          // 在提供方折叠的此刻绑定源模型：之后的源编辑/删除及其凭据可用性都不得改动已定义的别名。
          definitions.set(id, { inherit, base: base && structuredClone(base) })
          // 不需要继承则只记录定义。
          if (!inherit) continue
          // 从基准模型覆盖更新目标模型。
          providers.models.update(providerID, id, (model) => {
            // 有基准时复制其字段。
            if (base) Object.assign(model, structuredClone(base))
            // 提供方配置了 package 时清除模型级 package。
            if (item.package !== undefined) model.package = undefined
          })
        }
        // A configured provider baseURL replaces every catalog per-model endpoint, not only those of configured
        // models. Configured per-model settings are applied later and still win.
        // 配置的提供方级 baseURL 会替换目录中每个模型的端点，而不只是已配置模型；之后应用的模型级设置仍然优先。
        if (item.settings?.baseURL !== undefined)
          for (const [id, model] of providers.get(providerID)?.models ?? [])
            if (model.settings?.baseURL !== undefined)
              providers.models.update(providerID, id, (model) => {
                delete model.settings?.baseURL
              })
        // 记录该提供方的模型定义。
        next.set(item, { providerID, models: definitions })
      }
      // 第二遍：应用各模型的使用限额（limit）。
      for (const [item, definition] of next) {
        for (const [id, config] of Object.entries(item.models ?? {})) {
          // 未声明限额则跳过。
          if (config.limit === undefined) continue
          // 合并写入限额。
          providers.models.update(definition.providerID, id, (model) => {
            model.limit = { ...model.limit, ...config.limit }
          })
        }
      }
      // 记录默认模型与模型定义供模型 transform 使用。
      sources.defaultModel = Config.latest(loaded.entries, "model")
      sources.models = next
    })

    // Keep explicit model overrides in their late registration position, after external
    // model transforms. They can recreate or re-enable a model within an available provider.
    // 应用模型层面的覆盖：保持在外部模型 transform 之后的晚注册位置，
    // 以便在可用提供方内重建或重新启用模型。
    yield* ctx.model.transform((models) => {
      // 应用最后声明的默认模型。
      const configuredDefault = sources.defaultModel
      if (configuredDefault !== undefined) models.default.set(configuredDefault.providerID, configuredDefault.model)
      // 遍历每个配置提供方的模型定义。
      for (const [item, definition] of sources.models) {
        // 提供方 ID。
        const providerID = definition.providerID
        // 遍历该提供方配置的每个模型。
        for (const [id, config] of Object.entries(item.models ?? {})) {
          // 取出此前的定义。
          const source = definition.models.get(id)
          // 现存模型。
          const existing = models.get(providerID, id)
          // 更新前是否已有变体。
          const hadVariants = (existing?.variants.length ?? 0) > 0
          // 是否需要继承：定义标记继承或模型尚不存在。
          const inherit = source?.inherit || !existing
          // 应用模型覆盖（需要继承时带基准模型）。
          overlay(
            models,
            models.provider.get(providerID)?.provider.package,
            item,
            providerID,
            id,
            config,
            inherit && source?.base ? { base: source.base } : undefined,
          )
          // Inherited variants are spelled for the base model's package, so a package override needs fresh ones.
          // A base without variants has no reasoning support to respell.
          // 继承来的变体是按基准模型的 package 拼写的，package 被覆盖时需要重新生成；
          // 基准模型没有变体就无需重拼。
          const repackaged =
            source?.base !== undefined &&
            source.base.variants.length > 0 &&
            models.get(providerID, id)?.package !== source.base.package
          // 未配置变体与推理能力、且（模型本来没有变体或需要重拼）时，按最终 package 重新解析变体。
          if (
            config.variants === undefined &&
            config.capabilities?.reasoning === undefined &&
            // Custom models start without variants, so non-empty variants here came from an earlier transform.
            // 自定义模型初始没有变体，因此此处非空变体只可能来自更早的 transform。
            ((!source?.base && !hadVariants) || repackaged)
          )
            models.update(providerID, id, (model) => {
              model.variants = [
                ...Variant.resolve({
                  ...model,
                  package: model.package ?? models.provider.get(providerID)?.provider.package,
                }),
              ]
            })
        }
      }
    })
  }),
})

// Integration documents are left out: their providers authenticate with the integration's connection, so they add no
// integration or method, and the integration's own plugin applies them earlier in the provider chain (`integrate`).
// 取配置中声明的提供方映射；集成文档被排除：其提供方用集成连接鉴权，不添加集成或方式，
// 而是由集成自身的插件在提供方链更早的位置应用（integrate）。
function configuredProviders(entries: readonly Entry[]) {
  return entries
    // 只保留普通文档（排除集成文档）。
    .filter((entry): entry is Document => entry.type === "document" && !(entry instanceof ConfigIntegration.Document))
    // 展开为 [提供方ID, 配置] 对。
    .flatMap((file) => Object.entries(file.info.providers ?? {}))
}

/**
 * Applies an integration document's providers. The integration's plugin calls this at its own position in the
 * provider chain, so provider plugins registered after it treat these providers as configured ones rather than
 * as their canonical provider, while user and project config still overlay them in this plugin's late transform.
 */
// 应用集成文档的提供方。集成的插件在提供方链自己的位置调用它：其后注册的提供方插件把这些提供方视为已配置的，
// 而非其规范提供方；用户与项目配置仍会在本插件的晚 transform 中覆盖它们。
export function integrate(providers: ProviderEditor, document: ConfigIntegration.Document) {
  // 遍历集成文档中的每个提供方。
  for (const [providerID, item] of Object.entries(document.info.providers ?? {})) {
    // 应用提供方覆盖并取出源提供方信息。
    const { source } = overlayProvider(providers, providerID, item, document.integrationID)
    // An integration lists the models it routes: each starts again from the catalog and takes the provider's
    // package and URL. Its models are complete here, so later model transforms and config apply on top.
    // 集成列出它要路由的模型：每个都从目录重新开始并取该提供方的 package 与 URL；
    // 此处模型已完整，后续的模型 transform 与配置在其上叠加。
    for (const [id, config] of Object.entries(item.models ?? {})) {
      overlay(providers.models, providers.get(providerID)?.provider.package, item, providerID, id, config, {
        base: source?.models.get(config.modelID ?? id) ?? source?.models.get(id),
      })
    }
    // 取应用覆盖后的提供方。
    const configured = providers.get(providerID)
    // Bound to the connection so its providers disappear as soon as the account changes or signs out.
    // 绑定到连接：账户变更或登出后这些提供方立即消失。
    if (configured)
      providers.add({
        info: configured.provider,
        models: Array.from(configured.models.values()),
        sourceConnection: document.connection,
      })
  }
}

/** Applies one configured provider, first copying its source when `canonical` points it at another provider. */
// 应用一个已配置的提供方；当 canonical 指向其他提供方时，先把源提供方复制过来。
function overlayProvider(
  providers: ProviderEditor,
  providerID: string,
  item: ConfigProvider.Info,
  integrationID?: ConfigIntegration.Document["integrationID"],
) {
  // 现存提供方。
  const current = providers.get(providerID)
  // 解析源提供方：配置的 canonical 优先，其次现存的 canonical，最后是自己。
  const source = providers.get(item.canonical ?? current?.provider.canonical ?? providerID)
  // canonical 是否发生了变化。
  const changed = item.canonical !== undefined && item.canonical !== current?.provider.canonical
  // 更新提供方。
  providers.update(providerID, (provider) => {
    // canonical 变化且源存在且不是自己：整体复制源提供方（保留自身 ID 与集成 ID）。
    if (changed && source && source.provider !== provider)
      Object.assign(provider, structuredClone(source.provider), {
        id: provider.id,
        integrationID: provider.integrationID,
      })
    // 归属集成 ID（集成文档传入时）。
    if (integrationID) provider.integrationID = integrationID
    // 标记为已启用。
    provider.activation = "enabled"
    // 记录 canonical 指向。
    if (item.canonical !== undefined) provider.canonical = item.canonical
    // 覆盖名称。
    if (item.name) provider.name = item.name
    // 覆盖 package。
    if (item.package !== undefined) provider.package = item.package
    // 合并兼容性选项。
    if (item.compatibility !== undefined) provider.compatibility = { ...provider.compatibility, ...item.compatibility }
    // 合并设置。
    if (item.settings !== undefined) provider.settings = Provider.mergeOverlay(provider.settings, item.settings)
    // 合并请求头。
    if (item.headers !== undefined) provider.headers = Provider.mergeHeaders(provider.headers, item.headers)
    // 合并请求体。
    if (item.body !== undefined) provider.body = Provider.mergeOverlay(provider.body, item.body)
  })
  // 返回覆盖前的信息供调用方使用。
  return { current, source, changed }
}

/** Applies one configured model, first resetting it to `inherit.base` when it starts again from the catalog. */
// 应用一个已配置的模型；从目录重新开始时先重置为 inherit.base。
function overlay(
  models: Pick<ModelEditor, "update">,
  providerPackage: string | undefined,
  item: ConfigProvider.Info,
  providerID: string,
  id: string,
  config: NonNullable<ConfigProvider.Info["models"]>[string],
  inherit: { readonly base: Model.Info | undefined } | undefined,
) {
  // 第一次更新：应用基础字段。
  models.update(providerID, id, (model) => {
    // 需要继承时从基准模型开始。
    if (inherit) {
      // 复制基准模型字段。
      if (inherit.base) Object.assign(model, structuredClone(inherit.base))
      // 提供方配置了 package 时清除模型级 package。
      if (item.package !== undefined) model.package = undefined
      // 提供方配置了 baseURL 时清除模型级 baseURL。
      if (item.settings?.baseURL !== undefined && model.settings) delete model.settings.baseURL
    }
    // 覆盖模型类型。
    if (config.type !== undefined) model.type = config.type
    // 覆盖模型家族。
    if (config.family !== undefined) model.family = config.family
    // 覆盖显示名。
    if (config.name) model.name = config.name
    // 覆盖真实模型 ID。
    if (config.modelID !== undefined) model.modelID = config.modelID
    // 覆盖发布时间。
    if (config.releaseDate !== undefined) model.time = { released: Date.parse(config.releaseDate) }
    // 合并兼容性选项。
    if (config.compatibility !== undefined) model.compatibility = { ...model.compatibility, ...config.compatibility }
    // 覆盖 package。
    if (config.package !== undefined) model.package = config.package
    // 合并设置。
    if (config.settings !== undefined) model.settings = Provider.mergeOverlay(model.settings, config.settings)
    // 合并请求头。
    if (config.headers !== undefined) model.headers = Provider.mergeHeaders(model.headers, config.headers)
    // 合并请求体。
    if (config.body !== undefined) model.body = Provider.mergeOverlay(model.body, config.body)
    // 合并能力开关。
    if (config.capabilities !== undefined)
      model.capabilities = Model.mergeCapabilities(config.capabilities, model.capabilities)
    // 合并使用限额。
    if (config.limit !== undefined) model.limit = { ...model.limit, ...config.limit }
  })
  // Variants are spelled for the final package, which the update above normalizes from `aisdk:*`.
  // 变体按最终 package 拼写；上面的更新已把 `aisdk:*` 归一化。
  models.update(providerID, id, (model) => {
    // Configured reasoning replaces the base variants; configured variants still overlay them below.
    // 配置的推理能力会替换基准变体；配置的变体随后在其上叠加。
    if (config.capabilities?.reasoning !== undefined)
      model.variants = [
        ...Variant.resolve(
          { ...model, package: model.package ?? providerPackage },
          Variant.supports(config.capabilities.reasoning),
        ),
      ]
    // 应用配置的变体列表。
    if (config.variants !== undefined) {
      // 变体列表不存在时初始化。
      model.variants ??= []
      // 逐个变体合并。
      for (const variant of config.variants) {
        // 查找同 ID 变体。
        let existing = model.variants.find((item) => item.id === variant.id)
        // 不存在则新建并加入列表。
        if (!existing) {
          existing = { id: variant.id }
          model.variants.push(existing)
        }
        // 合并变体设置。
        if (variant.settings !== undefined)
          existing.settings = Provider.mergeOverlay(existing.settings, variant.settings)
        // 合并变体请求头。
        if (variant.headers !== undefined) existing.headers = Provider.mergeHeaders(existing.headers, variant.headers)
        // 合并变体请求体。
        if (variant.body !== undefined) existing.body = Provider.mergeOverlay(existing.body, variant.body)
      }
    }
    // 应用费用配置。
    if (config.cost !== undefined) {
      model.cost = (Array.isArray(config.cost) ? config.cost : [config.cost]).map((cost) => ({
        tier: cost.tier && { ...cost.tier },
        input: cost.input,
        output: cost.output,
        cache: {
          read: cost.cache?.read ?? Money.USDPerMillionTokens.zero,
          write: cost.cache?.write ?? Money.USDPerMillionTokens.zero,
        },
      }))
    }
    // 配置 disabled 时反向写为 enabled。
    if (config.disabled !== undefined) model.enabled = !config.disabled
  })
}
