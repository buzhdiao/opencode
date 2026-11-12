// 功能开关（feature flag）：解析环境变量与配置中的实验性开关，给出每个开关的启用状态与来源。
export * as Flag from "./flag.js"

import { Context, Effect, Layer, Record } from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { ConfigFlag } from "@opencode/schema/config/flag"
import type { Document, Entry } from "@opencode/schema/config"
import { App } from "./app.js"
import { Config } from "./config.js"

// 开关键（Key）类型，复用 schema 注册表中的键
export type Key = ConfigFlag.Key

// 单个开关的状态：是否启用 + 取值来源
export interface State {
  readonly enabled: boolean
  /** Where `enabled` came from, highest priority first. */
  // 来源按优先级从高到低：环境 → 配置 → 默认
  readonly source: "env" | "config" | "default"
}

export interface Interface {
  readonly resolve: (entries: readonly Entry[]) => Record<Key, State>
  readonly all: Effect.Effect<Record<Key, State>>
  readonly enabled: (key: Key) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Flag") {}

/**
 * `OPENCODE_FLAGS`, a comma-separated list such as `schedules,-media_blob`; a leading `-` turns a flag off, and
 * `all` turns every flag on unless the same list opts one out, as in `all,-media_blob`.
 */
// 环境覆盖（Overrides）：来自 OPENCODE_FLAGS 的逗号分隔列表，前导 "-" 表示关闭，"all" 表示全开
export const Overrides = Context.Reference<string | undefined>("@opencode/Flag/Overrides", {
  // 默认取进程环境变量
  defaultValue: () => process.env.OPENCODE_FLAGS,
})

// Any other channel, such as a release or a branch preview build, keeps flags off so none turns on by accident.
// 默认启用判定：仅本地（local）与开发（dev）渠道默认开启，其他渠道（正式发布/分支预览）一律关闭以防误开
const onByDefault = (channel: string) => channel === "local" || channel === "dev"

/**
 * Resolves every flag: `OPENCODE_FLAGS` (`-key`, then `all`), then `experimental.<key>` from the highest-priority
 * document that sets `experimental` (the same document every other `experimental` setting reads), then `all_flags: true`
 * from the highest-priority document that sets `all_flags`, so a global switch survives a project's own `experimental`
 * block, then on for local and dev builds. `all_flags: false` falls through rather than turning flags off.
 * A remote kill switch belongs above `OPENCODE_FLAGS` here.
 */
// 解析所有开关：优先级为 OPENCODE_FLAGS（-key 与 all）→ 最高优先级文档的 experimental.<key> → all_flags → 渠道默认
export function resolve(input: {
  readonly entries: readonly Entry[]
  readonly channel: string
  readonly overrides?: string
}) {
  // 把覆盖列表解析为 键→布尔 的映射；带前导 "-" 的项记为 false
  const env = new Map(
    (input.overrides ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item): [string, boolean] => (item.startsWith("-") ? [item.slice(1), false] : [item, true])),
  )
  // 通配符 "all" 是否开启
  const all = env.get(ConfigFlag.wildcard) === true
  // 最高优先级文档里的 experimental 块
  const experimental = Config.latest(input.entries, "experimental")
  // all_flags：取最高优先级设置了该字段的文档，且仅在其显式为 true 时生效（false 视为未设置）
  const allFlags =
    input.entries.findLast(
      (entry): entry is Document => entry.type === "document" && entry.info.experimental?.all_flags !== undefined,
    )?.info.experimental?.all_flags === true
  // 对注册表中的每个开关逐个判定取值与来源
  return Record.map(ConfigFlag.registry, (_, key): State => {
    // 环境覆盖：显式值，或 "all" 放行
    const override = env.get(key) ?? (all ? true : undefined)
    // 配置值：experimental 显式值，或 all_flags 放行
    const configured = experimental?.[key] ?? (allFlags ? true : undefined)
    const [enabled, source]: [boolean, State["source"]] =
      override !== undefined
        // 环境覆盖优先级最高
        ? [override, "env"]
        : configured !== undefined
          // 其次是配置
          ? [configured, "config"]
          // 最后按渠道默认值
          : [onByDefault(input.channel), "default"]
    return { enabled, source }
  })
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const app = yield* App.Service
    const config = yield* Config.Service
    const overrides = yield* Overrides
    const resolveEntries = (entries: readonly Entry[]) => resolve({ entries, channel: app.channel, overrides })
    const all = Effect.gen(function* () {
      return resolveEntries(yield* config.entries())
    })
    return Service.of({
      resolve: resolveEntries,
      all,
      enabled: (key) => Effect.map(all, (flags) => flags[key].enabled),
    })
  }),
)

export const testLayer = (
  entries: Entry[] = [],
  options?: { readonly app?: Partial<App.Info>; readonly overrides?: string },
) =>
  Layer.fresh(layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        App.layer(options?.app),
        Config.testLayer(entries),
        Layer.succeed(Overrides, options?.overrides),
      ),
    ),
  )

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [App.node, Config.node],
})

/** Every flag with its value and where it came from, read from the location's Config on each call. */
export const all = Service.use((flags) => flags.all)

export const enabled = (key: Key) => Service.use((flags) => flags.enabled(key))
