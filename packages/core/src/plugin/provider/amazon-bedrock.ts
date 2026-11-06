// Effect：效果运行时
import { Effect } from "effect"
// path：Node 路径处理
import path from "node:path"
// define：插件定义辅助函数
import { define } from "@opencode/plugin/effect/plugin"
// FSUtil：文件系统工具服务
import { FSUtil } from "@opencode/util/fs-util"
// Global：全局路径服务
import { Global } from "@opencode/util/global"
// Provider：提供商服务与 ID
import { Provider } from "../../provider.js"
// credentialSettings/metadataSettings：凭据配置读取辅助
import { credentialSettings, metadataSettings } from "./credential-settings.js"

// Ambient inputs the AWS default credential chain can turn into credentials
// without any key stored in opencode. Mirrors the presence checks the AWS CLI
// and SDK use before consulting shared config.
// 这些环境变量是 AWS 默认凭据链（credential chain）的输入：无需在 opencode 中存密钥即可形成凭据。
// 与 AWS CLI/SDK 在查共享配置前的存在性检查保持一致。
const CHAIN_ENV = [
  // 逐一列出可触发凭据链的环境变量
  "AWS_PROFILE",
  "AWS_ACCESS_KEY_ID",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
]

// isBedrock：判断提供商是否属于 Amazon Bedrock 包
const isBedrock = (item: { readonly package: string }) =>
  // 包名以该前缀开头即视为 Bedrock
  item.package.startsWith("@opencode/ai/providers/amazon-bedrock")

// 定义 Amazon Bedrock 提供商插件
export const AmazonBedrockPlugin = define({
  // 插件唯一标识
  id: "opencode.provider.amazon.bedrock",
  // 插件激活时执行的生成器主体
  effect: Effect.fn(function* (ctx) {
    // 获取文件系统工具服务
    const fs = yield* FSUtil.Service
    // AWS 配置与凭据文件路径（可被环境变量覆盖）
    const paths = [
      // 配置文件路径
      process.env.AWS_CONFIG_FILE ?? path.join(Global.Path.home, ".aws", "config"),
      // 凭据文件路径
      process.env.AWS_SHARED_CREDENTIALS_FILE ?? path.join(Global.Path.home, ".aws", "credentials"),
    ]
    // 并发读取两个文件，读取失败返回 undefined
    const files = yield* Effect.all(
      // 对每个路径安全读取
      paths.map((file) => fs.readFileStringSafe(file).pipe(Effect.orElseSucceed(() => undefined))),
    )
    // Discover names only. Resolving every profile here could run credential helpers or contact AWS.
    // 这里只发现配置档（profile）名称；逐个解析可能触发凭据助手或访问 AWS。
    const profiles = Array.from(
      // 用 Set 去重
      new Set(
        // 展开两个文件的匹配结果
        files.flatMap((content, index) =>
          // 按行匹配 [section] 段头
          Array.from((content ?? "").matchAll(/^\s*\[([^\]\r\n]+)\]/gm)).flatMap((match) => {
            // 取段名并去除空白
            const section = match[1].trim()
            // The credentials file uses bare names; the config file prefixes all but "default" with "profile ".
            // 凭据文件用裸名；配置文件除 "default" 外都以 "profile " 为前缀。
            if (index === 1 || section === "default") return [section]
            // 带 "profile " 前缀的段剥掉前缀；其余（如 sso-session）忽略
            return section.startsWith("profile ") ? [section.slice(8).trim()] : []
          }),
        ),
      ),
    )
      // 过滤空值
      .filter(Boolean)
      // 排序便于稳定展示
      .toSorted()
    // 登记集成的认证方式
    yield* ctx.integration.transform((editor) => {
      // models.dev advertises AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and
      // AWS_REGION alongside the bearer token. Only the bearer token is a key;
      // the rest feed the SigV4 credential chain and must not become one.
      // models.dev 在 bearer token 之外还声明了 AWS_ACCESS_KEY_ID 等；只有 bearer token 算密钥，
      // 其余属于 SigV4 凭据链，不能登记为密钥来源。
      editor.method.update({
        // 集成 ID：Amazon Bedrock
        integrationID: Provider.ID.amazonBedrock,
        // 环境变量方式：仅 bearer token
        method: { type: "env", names: ["AWS_BEARER_TOKEN_BEDROCK"] },
      })
      // 登记密钥方式
      editor.method.update({
        // 集成 ID
        integrationID: Provider.ID.amazonBedrock,
        // 密钥方式，显示标签
        method: { type: "key", label: "Bedrock API key" },
      })
      // 登记外部方式：AWS 配置档
      editor.method.update({
        // 集成 ID
        integrationID: Provider.ID.amazonBedrock,
        // 外部方式定义
        method: {
          // 方式 ID
          id: "aws-profile",
          // 类型：外部
          type: "external",
          // 显示标签
          label: "AWS profile (SSO or named profile)",
          // 表单：配置档选择
          form: [
            {
              // 表单字段键
              key: "profile",
              // 字符串类型
              type: "string",
              // 字段标题
              title: "AWS profile",
              // 描述：发现数量或未发现提示
              description: profiles.length
                // 有配置档时提示数量
                ? `Found ${profiles.length} profile${profiles.length === 1 ? "" : "s"} in your AWS configuration.`
                // 无配置档时的提示
                : "No profiles found in your AWS configuration.",
              // 必填
              required: true,
              // 最小长度
              minLength: 1,
              // 校验模式：至少一个非空白字符
              pattern: "\\S",
              // 占位符
              placeholder: "Profile name",
              // 允许自由输入（非仅从选项中选）
              custom: true,
              // 候选选项：发现的配置档列表
              options: profiles.map((profile) => ({ value: profile, label: profile })),
            },
          ],
        },
      })
    })
    // The AWS profile method stores its form answer as credential metadata.
    // 读取已存的 AWS 配置档凭据（表单答案存于凭据元数据）。
    const login = yield* credentialSettings(ctx, Provider.ID.amazonBedrock, (value) =>
      // 仅外部 aws-profile 方式带元数据
      value.type === "external" && value.methodID === "aws-profile"
        // 从元数据中提取 profile 字段
        ? metadataSettings(value.metadata, ["profile"])
        // 其余无配置
        : {},
    )
    // 调整 Bedrock 提供商的运行设置
    yield* ctx.provider.transform((evt) => {
      // 逐个检查提供商
      for (const item of evt.list()) {
        // 非 Bedrock 提供商跳过
        if (!isBedrock(item.provider)) continue
        // 更新设置
        evt.update(item.provider.id, (provider) => {
          // 合并现有设置与登录凭据设置（仅官方 Bedrock 集成生效）
          const settings = {
            // 展开现有设置
            ...provider.settings,
            // 集成 ID 匹配时叠加登录设置
            ...((provider.integrationID ?? provider.id) === Provider.ID.amazonBedrock ? login.settings : {}),
          }
          // 是否存在凭据链输入：配置了 profile 或任一链环境变量存在
          const chain = typeof settings.profile === "string" || CHAIN_ENV.some((name) => process.env[name])
          // SigV4 authenticates through the AWS default chain rather than a key
          // credential, so ambient AWS configuration is what makes Bedrock usable.
          // SigV4 经 AWS 默认凭据链认证而非密钥，因此存在环境配置即可自动激活。
          if (chain && provider.activation === "auto") provider.activation = "enabled"
          // Same default the native package uses, made explicit here so catalog
          // `${AWS_REGION}` URLs resolve without any region configured.
          // 与原生包一致的默认区域；显式设置后目录中 `${AWS_REGION}` URL 无需额外配置即可解析。
          const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1"
          // 写回设置
          provider.settings = {
            // 展开合并后的设置
            ...settings,
            // 未配置区域时填入默认区域
            ...(typeof settings.region !== "string" ? { region } : {}),
            // Users configure Bedrock private/VPC endpoints as `endpoint`; move it
            // into the catalog base URL once.
            // 用户以 `endpoint` 配置私有/VPC 端点；一次性迁移到目录 baseURL。
            ...(typeof settings.baseURL !== "string" && typeof settings.endpoint === "string"
              // endpoint 转 baseURL
              ? { baseURL: settings.endpoint }
              // 已有 baseURL 则不动
              : {}),
          }
          // 迁移后删除旧的 endpoint 字段
          delete provider.settings.endpoint
        })
      }
    })
  }),
})
