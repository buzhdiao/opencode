// 从 node:fs/promises 导入 readFile：异步读取旧凭据文件内容
import { readFile } from "node:fs/promises"
// 导入 path 模块：用于拼接 auth.json 的绝对路径
import path from "node:path"
// 从 drizzle-orm 导入 sql 标签模板：用于构造参数化的 SQL 查询
import { sql } from "drizzle-orm"
// 导入 Effect（函数式效果运行时）、Option（可选值）与 Schema（数据校验）
import { Effect, Option, Schema } from "effect"
// 导入 Credential（凭据）schema：用于构造合法的凭据对象
import { Credential } from "@opencode/schema/credential"
// 导入 Integration（集成）schema：用于校验认证方式标识
import { Integration } from "@opencode/schema/integration"
// 导入 NonNegativeInt：非负整数校验器，用于过期时间戳
import { NonNegativeInt } from "@opencode/schema/schema"
// 导入 Global 服务：读取全局数据目录，定位 auth.json
import { Global } from "@opencode/util/global"
// 仅导入类型 DatabaseMigration：数据库迁移（migration）的定义接口
import type { DatabaseMigration } from "../migration.js"

// 定义旧版 OAuth（开放授权）凭据的结构：刷新/访问令牌、过期时间，
// accountId 与 enterpriseUrl 为可选字段
const LegacyOAuth = Schema.Struct({
  type: Schema.Literal("oauth"),
  refresh: Schema.String,
  access: Schema.String,
  expires: NonNegativeInt,
  accountId: Schema.optional(Schema.String),
  enterpriseUrl: Schema.optional(Schema.String),
})
// 定义旧版 API key（接口密钥）凭据的结构：密钥值与可选的元数据（metadata）
const LegacyKey = Schema.Struct({
  type: Schema.Literal("api"),
  key: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})
// 定义旧版 well-known 凭据的结构：公钥标识与访问令牌
const LegacyWellKnown = Schema.Struct({
  type: Schema.Literal("wellknown"),
  key: Schema.String,
  token: Schema.String,
})
// LegacyValue：三种旧凭据格式的联合（union）类型，任一格式匹配即可
const LegacyValue = Schema.Union([LegacyOAuth, LegacyKey, LegacyWellKnown])
// decodeJson：把文件文本解码为 JSON（校验失败返回 Option.none）
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
// decodeValue：把 JSON 值进一步解码为上面定义的旧凭据格式
const decodeValue = Schema.decodeUnknownOption(LegacyValue)
// kv 表中的键名：记录使用过 well-known 凭据的来源集成列表
const wellKnownSourcesKey = "wellknown:sources"

// 声明迁移对象，需满足 DatabaseMigration.Migration 接口（id + up）
const migration: DatabaseMigration.Migration = {
  // 迁移唯一 id：由时间戳 + 随机名称组成，用于记录该迁移是否已应用
  id: "20260805200742_import_legacy_credentials",
  // up：迁移的升级（up）函数，tx 为包裹好的数据库事务（transaction）句柄
  up(tx) {
    // 用 Effect.gen 以生成器（generator）写法串联导入流程
    return Effect.gen(function* () {
      // 从依赖注入容器中获取 Global（全局）服务
      const global = yield* Global.Service
      // 调用导入函数：读取数据目录下的 auth.json 并导入其内容
      return yield* importLegacyCredentials(tx, path.join(global.data, "auth.json"))
    })
  },
}

// 以默认导出（default export）暴露迁移，供迁移注册表统一收集
export default migration

// 导入旧版凭据的主逻辑：解析 auth.json，把每种凭据写入 credential 表
export function importLegacyCredentials(tx: Parameters<DatabaseMigration.Migration["up"]>[0], filepath: string) {
  return Effect.gen(function* () {
    // 读取凭据文件内容；文件不存在或读取失败时返回 undefined（不视为错误）
    const content = yield* Effect.promise(() => readFile(filepath, "utf8").catch(() => undefined))
    // 文件缺失说明没有旧凭据可导入，直接结束
    if (content === undefined) return
    // 把文本解析为 JSON 对象，解析失败返回 undefined
    const input = Option.getOrUndefined(decodeJson(content))
    // 内容必须是对象（键为集成标识）且不能是数组，否则迁移失败
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return yield* Effect.fail(new Error("Legacy credential file must contain an object"))
    }

    // origins：收集本次导入中出现的 well-known 凭据来源集成
    const origins: string[] = []
    // 遍历 auth.json 的每个条目：id 为集成标识，raw 为原始凭据值
    for (const [id, raw] of Object.entries(input)) {
      // 把原始值按三种旧格式解码，解码失败则跳过该条目
      const value = Option.getOrUndefined(decodeValue(raw))
      if (!value) continue
      // 去掉集成标识末尾的斜杠，得到规范的 integrationID
      const integrationID = id.replace(/\/+$/, "")
      // 空标识（如原始值全为斜杠）无法入库，跳过
      if (!integrationID) continue
      // well-known 凭据需要额外登记来源，先记入 origins 列表
      if (value.type === "wellknown") origins.push(integrationID)
      // 若该集成在 credential 表中已有凭据，说明已导入过，跳过去重
      if (yield* tx.get(sql`SELECT id FROM credential WHERE integration_id = ${integrationID}`)) continue

      // 按旧凭据类型构造新的凭据对象（credential）
      const credential =
        // API key：直接携带密钥与可选元数据
        value.type === "api"
          ? Credential.Key.make({ type: "key", key: value.key, metadata: value.metadata })
          // well-known：令牌即密钥，无需元数据
          : value.type === "wellknown"
            ? Credential.Key.make({ type: "key", key: value.token })
            // OAuth：构造刷新/访问令牌凭据，并按需附加账户或企业地址元数据
            : Credential.OAuth.make({
                type: "oauth",
                methodID: Integration.MethodID.make(methodID(integrationID)),
                refresh: value.refresh,
                access: value.access,
                expires: value.expires,
                metadata:
                  value.accountId || value.enterpriseUrl
                    ? {
                        ...(value.accountId ? { accountID: value.accountId } : {}),
                        ...(value.enterpriseUrl ? { enterpriseUrl: value.enterpriseUrl } : {}),
                      }
                    : undefined,
              })
      // 标签（label）：凭据的展示名称，OAuth 与 API key 分别命名
      const label = credential.type === "oauth" ? "OAuth" : "API key"
      // now：当前时间戳，作为创建与更新时间
      const now = Date.now()
      // 把凭据序列化为 JSON 后插入 credential 表（参数化查询防止注入）
      yield* tx.run(sql`
        INSERT INTO credential (id, integration_id, label, value, time_created, time_updated)
        VALUES (${Credential.ID.create()}, ${integrationID}, ${label}, ${JSON.stringify(credential)}, ${now}, ${now})
      `)
    }

    // 没有 well-known 来源需要登记时，直接结束
    if (!origins.length) return
    // 读取 kv 表中已有的 well-known 来源列表
    const stored = yield* tx.get<{ value: string }>(sql`SELECT value FROM kv WHERE key = ${wellKnownSourcesKey}`)
    // 把存量值解析为 JSON，缺失或解析失败时记为 undefined
    const decoded = stored ? Option.getOrUndefined(decodeJson(stored.value)) : undefined
    // 取出已有来源数组：仅保留其中的字符串元素，异常结构按空数组处理
    const current = Array.isArray(decoded) ? decoded.filter((item): item is string => typeof item === "string") : []
    // 合并新旧来源并用 Set（集合）去重，再序列化为 JSON 字符串
    const value = JSON.stringify(Array.from(new Set([...current, ...origins])))
    // now：本次写入的时间戳
    const now = Date.now()
    // 写入 kv 表：键不存在则插入，冲突（key 已存在）则更新值与更新时间
    yield* tx.run(sql`
      INSERT INTO kv (key, value, time_created, time_updated)
      VALUES (${wellKnownSourcesKey}, ${value}, ${now}, ${now})
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, time_updated = excluded.time_updated
    `)
  })
}

// 根据集成标识推断其 OAuth（开放授权）认证方式（method）标识
function methodID(integrationID: string) {
  // openai 使用 ChatGPT 浏览器登录方式
  if (integrationID === "openai") return "chatgpt-browser"
  // github-copilot、opencode、xai 使用设备授权（device）流程
  if (["github-copilot", "opencode", "xai"].includes(integrationID)) return "device"
  // 其余集成一律按标准 OAuth 方式处理
  return "oauth"
}
