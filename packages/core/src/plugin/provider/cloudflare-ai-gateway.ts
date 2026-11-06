// 从 effect 库导入 Effect 组合子
import { Effect } from "effect"
// 导入数组工具（判断数组非空）
import { isArrayNonEmpty } from "effect/Array"
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
const providerID = Provider.ID.make("cloudflare-ai-gateway")

// 定义“Cloudflare 账户 ID”表单字段
const accountIdField = Form.StringField.make({
  // 字符串类型
  type: "string",
  // 键名
  key: "accountId",
  // 标题
  title: "Enter your Cloudflare Account ID",
  // 占位提示
  placeholder: "e.g. 1234567890abcdef1234567890abcdef",
  // 必填
  required: true,
})

// 定义“Cloudflare AI Gateway ID”表单字段
const gatewayIdField = Form.StringField.make({
  // 字符串类型
  type: "string",
  // 键名
  key: "gatewayId",
  // 标题
  title: "Enter your Cloudflare AI Gateway ID",
  // 占位提示
  placeholder: "e.g. my-gateway",
  // 必填
  required: true,
})

// 定义 Cloudflare AI Gateway 插件：收集账户/网关 ID 并写入供应商设置
export const CloudflareAIGatewayPlugin = define({
  // 插件唯一标识
  id: "opencode.provider.cloudflare.ai.gateway",
  // 插件主逻辑（Effect 生成器）
  effect: Effect.fn(function* (ctx) {
    // 读取环境变量中的账户 ID
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
    // 读取环境变量中的网关 ID
    const gatewayId = process.env.CLOUDFLARE_GATEWAY_ID
    // 读取配置文件中已设置的供应商配置
    const configured = yield* configuredSettings(providerID)
    // 决定登录表单需要哪些字段：若 baseURL 已配置则无需任何字段
    const fields =
      typeof configured?.baseURL === "string"
        ? []
        : [
            // 账户 ID 已由环境变量或配置提供时，不再询问
            ...(accountId || typeof configured?.accountId === "string" ? [] : [accountIdField]),
            // 网关 ID 同理
            ...(gatewayId || typeof configured?.gatewayId === "string" ? [] : [gatewayIdField]),
          ]
    // 注册集成转换：声明 API token 的 key 登录方法
    yield* ctx.integration.transform((editor) => {
      editor.method.update({
        integrationID: providerID,
        method: {
          // 方法类型：API key
          type: "key",
          // 标签
          label: "Gateway API token",
          // 表单字段：有内容才构建
          form: isArrayNonEmpty(fields) ? Form.Fields.make(fields) : undefined,
        },
      })
    })
    // key 方法的表单答案会作为凭据元数据存储。
    // The key method's form answers are stored as credential metadata.
    const login = yield* credentialSettings(ctx, providerID, (value) =>
      // 凭据类型为 key 时，提取 accountId/gatewayId 两个元数据字段作为设置
      value.type === "key" ? metadataSettings(value.metadata, ["accountId", "gatewayId"]) : {},
    )
    // 注册供应商转换：把账户/网关信息合并进设置
    yield* ctx.provider.transform((evt) => {
      // 获取该供应商的配置项
      const item = evt.get(providerID)
      // 无配置项、或三个来源都为空时无需处理
      if (!item || (!accountId && !gatewayId && Object.keys(login.settings).length === 0)) return
      // 更新供应商设置
      evt.update(item.provider.id, (provider) => {
        // 用户已显式配置 baseURL 时不做覆盖
        if (typeof provider.settings?.baseURL === "string") return
        // 合并设置：环境变量在前，凭据登录信息优先级最高
        provider.settings = {
          ...(accountId ? { accountId } : {}),
          ...(gatewayId ? { gatewayId } : {}),
          ...provider.settings,
          ...login.settings,
        }
      })
    })
  }),
})
