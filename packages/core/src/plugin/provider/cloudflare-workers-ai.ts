// 从 effect 库导入 Effect 组合子
import { Effect } from "effect"
// 导入插件定义工具 define
import { define } from "@opencode/plugin/effect/plugin"
// 导入表单（Form）schema 工具
import { Form } from "@opencode/schema/form"
// 导入 Provider 模块
import { Provider } from "../../provider.js"
// 导入已配置设置读取函数
import { configuredSettings } from "./configured.js"
// 导入凭据设置与元数据设置工具
import { credentialSettings, metadataSettings } from "./credential-settings.js"

// 本插件的供应商 ID
const providerID = Provider.ID.make("cloudflare-workers-ai")

// 定义 Cloudflare Workers AI 插件：收集账户 ID 并设置端点
export const CloudflareWorkersAIPlugin = define({
  // 插件唯一标识
  id: "opencode.provider.cloudflare.workers.ai",
  // 插件主逻辑（Effect 生成器）
  effect: Effect.fn(function* (ctx) {
    // 读取配置文件中已设置的供应商配置
    const configured = yield* configuredSettings(providerID)
    // 决定登录表单：baseURL 已配置或能解析出账户 ID 时无需询问
    const form =
      typeof configured?.baseURL === "string" || resolveAccountId(configured ?? {})
        ? undefined
        : Form.Fields.make([
            {
              // 字符串类型字段
              type: "string",
              // 键名
              key: "accountId",
              // 标题
              title: "Enter your Cloudflare Account ID",
              // 占位提示
              placeholder: "e.g. 1234567890abcdef1234567890abcdef",
              // 必填
              required: true,
            },
          ])
    // 注册集成转换：声明环境变量与 key 两种登录方法
    yield* ctx.integration.transform((editor) => {
      // 方法一：从一组环境变量中读取 API 密钥（按顺序尝试）
      editor.method.update({
        integrationID: providerID,
        method: { type: "env", names: ["CLOUDFLARE_API_KEY", "CLOUDFLARE_WORKERS_AI_TOKEN", "CLOUDFLARE_API_TOKEN"] },
      })
      // 方法二：直接输入 API key（可附账户 ID 表单）
      editor.method.update({
        integrationID: providerID,
        method: {
          // 方法类型：API key
          type: "key",
          // 标签
          label: "API key",
          // 表单（可能为空）
          form,
        },
      })
    })
    // key 方法的表单答案会作为凭据元数据存储。
    // The key method's form answer is stored as credential metadata.
    const login = yield* credentialSettings(ctx, providerID, (value) =>
      // 凭据类型为 key 时，提取 accountId 元数据作为设置
      value.type === "key" ? metadataSettings(value.metadata, ["accountId"]) : {},
    )
    // 注册供应商转换：把账户 ID 写入设置或构造 baseURL
    yield* ctx.provider.transform((evt) => {
      // 获取该供应商的配置项
      const item = evt.get(providerID)
      // 无配置项则无需处理
      if (!item) return
      // 更新供应商设置
      evt.update(item.provider.id, (provider) => {
        // 用户已显式配置 baseURL 时不做覆盖
        if (typeof provider.settings?.baseURL === "string") return
        // 合并现有设置与凭据设置后解析账户 ID
        const accountId = resolveAccountId({ ...provider.settings, ...login.settings })
        // 解析不出账户 ID 则不处理
        if (!accountId) return
        // 按包类型设置账户信息
        provider.settings =
          provider.package === "@opencode/ai/providers/cloudflare-workers-ai"
            // 官方包直接接受 accountId 设置
            ? { ...provider.settings, accountId }
            // 其他包则通过 baseURL 指向 Workers AI 端点
            : { ...provider.settings, baseURL: workersEndpoint(accountId) }
      })
    })
  }),
})

// 解析账户 ID：优先取设置中的值，其次回退到环境变量
function resolveAccountId(options: Record<string, unknown>) {
  return stringOption(options, "accountId") ?? process.env.CLOUDFLARE_ACCOUNT_ID
}

// 构造 Cloudflare Workers AI 的 API 端点 URL（按账户 ID）
function workersEndpoint(accountId: string) {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`
}

// 从选项对象中取出字符串类型的字段值（否则返回 undefined）
function stringOption(options: Record<string, unknown>, key: string) {
  return typeof options[key] === "string" ? options[key] : undefined
}
