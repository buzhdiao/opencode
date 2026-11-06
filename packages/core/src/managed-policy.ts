// 将本模块以命名空间 ManagedPolicy 的形式整体再导出
export * as ManagedPolicy from "./managed-policy.js"

// 引入 Document 与 Entry 类型：配置中的文档条目与通用条目
import { Document, type Entry } from "@opencode/schema/config"
// 引入集成（integration）配置文档类型
import { ConfigIntegration } from "./config/integration.js"
// 引入通配符（wildcard）匹配工具
import { Wildcard } from "./util/wildcard.js"
// 引入策略（policy）模式定义
import { ConfigPolicy } from "@opencode/schema/config/policy"
// 仅引入类型：凭据（Credential）的值与信息
import type { Credential } from "./credential.js"

/** Every policy statement in config, earliest-loaded first so it wins, each with the message a denial shows. */
// statements：汇总配置中的全部策略声明——最早加载的排在最前（因此优先胜出），并附上拒绝时展示的消息
export function statements(entries: readonly Entry[]) {
  return entries
    // 只保留文档类型条目（用类型谓词收窄为 Document）
    .filter((entry): entry is Document => entry.type === "document")
    // 反转数组：让最早加载的条目排到末尾（配合后面的 findLast 实现“最早者优先”）
    .toReversed()
    // 展开每条文档的 policies 列表，并为每条策略补充拒绝消息
    .flatMap((entry) =>
      (entry.info.policies ?? []).map((policy) => ({
        ...policy,
        // An integration document's policies are those of the organization behind its connection.
        // 集成文档的策略来自其连接背后的组织：是组织文档时用组织名定制消息，否则用通用消息
        message:
          entry instanceof ConfigIntegration.Document ? blocked(entry.organization) : "Blocked by configuration policy",
      })),
    )
}

// 生成集成场景的拒绝消息：有组织名时带上组织名，否则用“你的组织”
function blocked(organization: string | undefined) {
  return organization ? `Blocked by ${organization}'s policy` : "Blocked by your organization's policy"
}

/** The statement deciding `action` on `resource`: the last match, since statements are earliest-loaded last. */
// match：找出对 action + resource 生效的策略——取最后一个匹配项（声明列表中最早加载的排在最后）
export function match<Policy extends ConfigPolicy.Info>(
  policies: readonly Policy[],
  action: ConfigPolicy.Action,
  resource: string,
) {
  // findLast：从后往前找第一条 action 相同且资源通配符匹配的策略
  return policies.findLast((policy) => policy.action === action && Wildcard.match(resource, policy.resource))
}

// decision：得出最终决定——取匹配策略的 effect；没有任何匹配时默认允许（allow）
export function decision(policies: readonly ConfigPolicy.Info[], action: ConfigPolicy.Action, resource: string) {
  return match(policies, action, resource)?.effect ?? "allow"
}

/**
 * The `integration.use` resource for what an integration supplies: `<integration>#<account>` when a connection with
 * a known account backs it, otherwise the bare integration ID (env keys, local config, the signed-out free tier).
 * A bare-ID pattern such as `opencode` therefore matches only connectionless use, never an org account. `#`
 * separates the two because integration IDs can be URLs.
 */
// integrationResource：构造集成使用（integration.use）的资源标识——有已知账号的连接时为 `<integration>#<account>`，否则为裸集成 ID
export function integrationResource(integrationID: string, account?: string) {
  // 有账号时拼接 “#<账号>”；否则返回裸集成 ID（环境变量密钥、本地配置、未登录免费档）
  return account ? `${integrationID}#${account}` : integrationID
}

/** The organization, or failing that the account, a stored credential belongs to. */
// account：从存储的凭据中取所属组织（orgID）；没有组织再退而取账号（accountID）
export function account(value: Credential.Value) {
  // 读取凭据元数据
  const metadata = value.metadata
  // orgID 是非空字符串时返回组织 ID
  if (typeof metadata?.orgID === "string" && metadata.orgID) return metadata.orgID
  // 否则 accountID 是非空字符串时返回账号 ID
  if (typeof metadata?.accountID === "string" && metadata.accountID) return metadata.accountID
  // 两者都没有则返回 undefined
  return undefined
}

/** The account behind each integration's active stored credential. */
// accounts：为每个集成找出其激活凭据背后的账号，构成 integrationID -> 账号 的映射
export function accounts(credentials: readonly Credential.Info[]) {
  // Credentials list each integration's active credential last.
  // 凭据列表中每个集成的最后一条是激活凭据；构造 Map 时后写覆盖先写，正好保留激活那条
  return new Map<string, string | undefined>(
    credentials.map((credential) => [credential.integrationID, account(credential.value)]),
  )
}
