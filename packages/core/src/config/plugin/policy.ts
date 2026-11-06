// 配置策略插件（Config Policy Plugin）：按托管与配置中的策略（policy）裁决提供方、MCP、技能、网络搜索与工具权限。
export * as ConfigPolicyPlugin from "./policy.js"

// 导入插件定义工具。
import { define } from "@opencode/plugin/effect/plugin"
// 导入 Effect 与流工具。
import { Effect, Stream } from "effect"
// 导入事件总线服务。
import { Bus } from "../../bus.js"
// 导入配置服务。
import { Config } from "../../config.js"
// 导入凭据服务。
import { Credential } from "../../credential.js"
// 导入托管策略工具。
import { ManagedPolicy } from "../../managed-policy.js"
// 导入状态批处理工具。
import { State } from "../../state.js"
// 导入通配符匹配工具。
import { Wildcard } from "../../util/wildcard.js"
// 导入网络搜索服务。
import { WebSearch } from "../../websearch.js"
// 导入配置集成工具。
import { ConfigIntegration } from "../integration.js"
// 导入配置条目观察器。
import { ConfigEntryObserver } from "./entry-observer.js"

// 定义插件。
export const Plugin = define({
  // 插件 ID。
  id: "opencode.config.policy",
  // 插件主流程。
  effect: Effect.fn(function* (ctx) {
    // 获取配置服务。
    const config = yield* Config.Service
    // 获取凭据服务。
    const credentials = yield* Credential.Service
    // 获取网络搜索服务。
    const websearch = yield* WebSearch.Service
    // 获取事件总线服务。
    const bus = yield* Bus.Service
    // 重载流程：一次性批量重载提供方、MCP、技能与网络搜索。
    const reload = State.batch(
      Effect.all([ctx.provider.reload(), ctx.mcp.reload(), ctx.skill.reload(), websearch.reload()], {
        discard: true,
      }),
    )
    // 观察配置：更新时触发上述批量重载。
    const loaded = yield* ConfigEntryObserver.observe(config, ctx.event, reload)
    // Documents reverse so earlier-loaded policy wins: managed policy, then a Console config document, then user
    // and project files.
    // 取策略语句：文档倒序使先加载的策略胜出——托管策略最先，其次 Console 配置文档，再次用户与项目文件。
    const policies = () => ManagedPolicy.statements(loaded.entries)
    // `integration.use` names the account behind each integration's active connection. Reading stored metadata
    // never refreshes a credential.
    // 记录各集成当前账户：integration.use 指向每个集成活动连接背后的账户；读取已存元数据不会刷新凭据。
    const current = { accounts: ManagedPolicy.accounts(yield* credentials.all()) }
    // 订阅凭据更新与切换事件。
    yield* bus.subscribe([Credential.Event.Updated, Credential.Event.Switched]).pipe(
      Stream.runForEach(() =>
        Effect.gen(function* () {
          // 重新计算各集成的账户集合。
          const next = ManagedPolicy.accounts(yield* credentials.all())
          // 集合未变化则无需重载。
          if (
            next.size === current.accounts.size &&
            Array.from(next).every(([id, account]) => current.accounts.get(id) === account)
          )
            return
          // 更新缓存的账户集合。
          current.accounts = next
          // 批量重载提供方与网络搜索。
          yield* State.batch(Effect.all([ctx.provider.reload(), websearch.reload()], { discard: true }))
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
    // 判断某集成是否被策略拒绝（按 integration.use 与其账户资源判定）。
    const integrationDenied = (statements: ReturnType<typeof policies>, integrationID: string) =>
      ManagedPolicy.decision(
        statements,
        "integration.use",
        ManagedPolicy.integrationResource(integrationID, current.accounts.get(integrationID)),
      ) === "deny"
    // 以当前上下文构造同步执行器（用于在纯转换里打日志）。
    const runSync = Effect.runSyncWith(yield* Effect.context())
    // 应用提供方策略。
    yield* ctx.provider.transform((providers) => {
      // 取当前策略语句。
      const statements = policies()
      // A provider a well-known origin defines belongs to that origin; others to their own integration.
      // 计算各提供方归属的集成：知名来源定义的提供方属于该来源，其余属于其自身集成。
      const suppliers = ConfigIntegration.suppliers(loaded.entries)
      // 被拒绝的已启用提供方列表。
      const denied: string[] = []
      // 遍历所有提供方记录。
      for (const record of providers.list()) {
        // 直接按提供方 ID 判定，或按其归属集成判定。
        const provider =
          ManagedPolicy.decision(statements, "provider.use", record.provider.id) === "deny" ||
          integrationDenied(
            statements,
            suppliers.get(record.provider.id) ?? record.provider.integrationID ?? record.provider.id,
          )
        // 未被拒绝则保留。
        if (!provider) continue
        // 被拒绝则移除该提供方。
        providers.remove(record.provider.id)
        // Skip unconfigured catalog entries; deny-all policies would otherwise log the whole catalog.
        // 只记录用户显式启用的被拒提供方；否则 deny-all 策略会把整个目录都打进日志。
        if (record.provider.activation === "enabled") denied.push(record.provider.id)
      }
      // 有被拒的启用提供方时记调试日志。
      if (denied.length) runSync(Effect.logDebug("providers denied by policy", { providers: denied }))
    })
    // Every built-in web search provider shares its integration's ID.
    // 应用网络搜索策略：内建搜索提供方与其集成共用同一 ID。
    yield* websearch.transform((editor) => {
      // 取当前策略语句。
      const statements = policies()
      // 逐个检查搜索提供方。
      for (const provider of editor.list()) {
        if (
          // 直接按 ID 拒绝或按集成拒绝时移除。
          ManagedPolicy.decision(statements, "websearch.use", provider.id) === "deny" ||
          integrationDenied(statements, provider.id)
        )
          editor.remove(provider.id)
      }
    })
    // 应用 MCP 策略。
    yield* ctx.mcp.transform((servers) => {
      // 取当前策略语句。
      const statements = policies()
      // 被拒绝的 MCP 服务器移除。
      for (const [name] of servers.list()) {
        if (ManagedPolicy.decision(statements, "mcp.use", name) === "deny") servers.remove(name)
      }
    })
    // 应用技能策略。
    yield* ctx.skill.transform((skills) => {
      // 取当前策略语句。
      const statements = policies()
      // 被拒绝的技能移除。
      for (const skill of skills.list()) {
        if (ManagedPolicy.decision(statements, "skill.use", skill.id) === "deny") skills.remove(skill.id)
      }
    })
    // 挂载工具权限评估钩子。
    yield* ctx.permission.hook("evaluate", (event) =>
      Effect.sync(() => {
        // 取当前策略语句。
        const statements = policies()
        // 为每个资源找最后一条匹配的 tool.use 策略。
        const denied = event.resources
          .map((resource) =>
            statements.findLast(
              (policy) =>
                policy.action === "tool.use" && Wildcard.match(`${event.action}:${resource}`, policy.resource),
            ),
          )
          // 其中存在 deny 效果的即拒绝。
          .find((policy) => policy?.effect === "deny")
        // 没有拒绝项则放行。
        if (!denied) return
        // 标记拒绝并附上策略消息。
        event.effect = "deny"
        event.message = denied.message
      }),
    )
  }),
})
