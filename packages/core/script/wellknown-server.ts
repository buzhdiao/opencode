// /.well-known/opencode 发现机制的本地测试服务器（fixture）。
// 用途：模拟一个通过 well-known 协议注册的模型提供商集成——返回 auth 命令（打印假令牌）与
// 远端配置下载地址，供 `bun run dev auth login <origin>` 手动联调，也供 well-known 相关测试
// 对照 src/wellknown.ts、src/wellknown/plugin.ts 的实现。启动：`bun script/wellknown-server.ts`。
// 假的认证令牌：登录时 auth 命令会原样输出它，本服务器用它校验后续请求的 Bearer 头
const token = "dummy-wellknown-token"
// 监听端口：默认 8787，可用环境变量 PORT 覆盖
const port = Number(process.env.PORT ?? 8787)
// 将通过 /config/opencode.json 下发的示例 opencode 配置：两个假提供商 + MCP + 权限规则
const config = {
  // 配置 JSON Schema 地址
  $schema: "https://opencode.ai/config.json",
  // 会话分享设为手动
  share: "manual",
  // 默认模型：主提供商的 example-chat
  model: "example-primary/example-chat",
  // 启用的提供商：本 fixture 自带的两个示例提供商
  enabled_providers: ["example-primary", "example-secondary"],
  // 禁用内置的常见提供商，确保测试只看到 fixture 提供的模型
  disabled_providers: ["opencode", "anthropic", "openai", "google", "xai", "amazon-bedrock", "azure"],
  // 提供商定义
  provider: {
    // 示例主提供商：OpenAI 兼容接口
    "example-primary": {
      name: "Example Primary",
      // 使用 @ai-sdk/openai-compatible 适配器
      npm: "@ai-sdk/openai-compatible",
      // 白名单：只暴露列出的两个模型
      whitelist: ["example-chat", "example-code"],
      options: {
        // 假的 API 地址
        baseURL: "https://models.example.com/v1",
        // API key 从环境变量 TOKEN 读取（登录后由 opencode 注入）
        apiKey: "{env:TOKEN}",
      },
      models: {
        // 带推理与多模态的对话模型
        "example-chat": {
          name: "Example Chat",
          // 支持推理
          reasoning: true,
          // 支持工具调用
          tool_call: true,
          // 支持附件
          attachment: true,
          // 输入文本+图像，输出文本
          modalities: {
            input: ["text", "image"],
            output: ["text"],
          },
          // 上下文 128k，输出上限 16k
          limit: {
            context: 128000,
            output: 16000,
          },
        },
        // 代码模型：无附件、无多模态
        "example-code": {
          name: "Example Code",
          reasoning: true,
          tool_call: true,
          limit: {
            context: 200000,
            output: 32000,
          },
        },
      },
    },
    // 示例次提供商
    "example-secondary": {
      name: "Example Secondary",
      npm: "@ai-sdk/openai-compatible",
      // 白名单：只暴露 example-fast
      whitelist: ["example-fast"],
      options: {
        baseURL: "https://inference.example.org/v1",
        apiKey: "{env:TOKEN}",
      },
      models: {
        // 轻量快速模型
        "example-fast": {
          name: "Example Fast",
          tool_call: true,
          limit: {
            context: 64000,
            output: 8000,
          },
        },
      },
    },
  },
  // 示例 MCP 服务器：默认禁用
  mcp: {
    "example-tools": {
      type: "remote",
      url: "https://tools.example.net/mcp",
      enabled: false,
    },
  },
  // 示例权限规则：bash/edit/webfetch 需询问，read 按通配放行但拒绝 .env
  permission: {
    bash: "ask",
    edit: "ask",
    webfetch: "ask",
    read: {
      // 默认允许读取
      "*": "allow",
      // .env 类文件一律拒绝
      "*.env": "deny",
      "*.env.*": "deny",
      // 但 .env.example 明确放行
      "*.env.example": "allow",
    },
  },
}

// 启动 Bun HTTP 服务器：只监听本机回环地址
const server = Bun.serve({
  hostname: "127.0.0.1",
  // 端口来自上面的 port
  port,
  // 请求处理：按路径分发两个端点
  async fetch(request) {
    // 解析请求 URL
    const url = new URL(request.url)
    // 端点一：well-known 发现文档（无需认证）
    if (url.pathname === "/.well-known/opencode") {
      return Response.json({
        // auth 段：告诉客户端如何取得令牌——执行命令，5 秒后打印 token 到 stdout
        auth: {
          command: ["bun", "-e", `await Bun.sleep(5000); process.stdout.write(${JSON.stringify(token)})`],
          // 令牌写入哪个环境变量
          env: "TOKEN",
        },
        // remote_config 段：受保护的配置下载地址，需带 Bearer {env:TOKEN}
        remote_config: {
          url: `${url.origin}/config/opencode.json`,
          headers: { authorization: "Bearer {env:TOKEN}" },
        },
      })
    }
    // 端点二：远端配置文件（需 Bearer 认证）
    if (url.pathname === "/config/opencode.json") {
      // 认证头与令牌不符返回 401
      if (request.headers.get("authorization") !== `Bearer ${token}`) {
        return new Response("Unauthorized", { status: 401 })
      }
      // 认证通过则下发上面的示例配置
      return Response.json(config)
    }
    // 其余路径一律 404
    return new Response("Not found", { status: 404 })
  },
})

// 打印监听地址
console.log(`Well-known fixture listening at ${server.url.origin}`)
// 提示联调命令：用 dev auth login 走完整登录流程
console.log(`Test with: bun run dev auth login ${server.url.origin}`)
