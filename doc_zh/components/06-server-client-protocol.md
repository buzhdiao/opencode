# 06 · Server/Client 协议与 SDK

## 一、协议即代码：effect HttpApi

OpenCode 不手写路由，也不手写 OpenAPI：packages/protocol/src/api.ts 用 effect 的 `HttpApi`/`HttpApiGroup` 声明端点（api.ts:2 导入；39-45 行把 Agent/Plugin/Model/Provider/Integration/WebSearch 等 group 与 Location 级中间件组合）。端点实现按领域拆在 packages/server/src/handlers/（agent.ts、session 相关、fs.ts、event.ts 等，见 handlers.ts 汇总）。

装配在 packages/server/src/routes.ts:190-201：

```text
HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" })
  + handlers（端点实现 + CORS）
  + formLocationLayer / sessionLocationLayer   // 请求归属到哪个 Location
  + authorizationLayer / schemaErrorLayer      // 鉴权与 schema 错误格式化
  + auth                                        // 密码/无密码两种形态
```

`/openapi.json` 由 HttpApi 定义自动生成；`packages/client` 用它生成 TypeScript 客户端（CONTRIBUTING.md:72：改协议后必须 `bun run generate`，禁止手改生成物）。

## 二、两种 server 形态

`createRoutes`（routes.ts:90-103）：独立 server（CLI 后台服务），有密码鉴权（ServerAuth.Config）。`createEmbeddedRoutes`（routes.ts:109-115）：嵌入式无密码形态（桌面/TUI 内嵌、测试）。两者共用 `makeRoutes`（117-205 行）：`applicationServiceNodes` 列出 29 个应用级服务节点（57-88 行），`AppNodeBuilder.build` 按部署替换实现（数据库路径、PTY、事件持久化、文件监听、MCP clientInfo 等，125-155 行），simulation 模式还能动态换上模拟后端（165-173 行）。

## 三、事件流：一处发生，三端可见

所有领域状态变化都通过 `Bus` 发布为会话事件（SessionEvent，packages/core/src/session/event.ts）。server 把事件流暴露为 SSE/WebSocket 端点（packages/server/src/event-feed.ts），TUI/Web/桌面订阅后本地投影出完整会话视图。这个设计让 TUI 的"会话中打字、工具进度流、权限弹窗"与 Web/桌面表现完全一致——因为它们消费的是同一份事件流与同一套消息投影。

## 四、SDK 组合

packages/sdk 把 client（生成物）+ core + server 组合成可编程形态（AGENTS.md 的依赖方向：`sdk` composes Client, Core, and Server）。packages/sdk/src 下：

- `opencode.ts`：主入口（创建/连接 server，暴露类型化 API）；
- `workerd.ts`：Cloudflare workerd 形态（server 可跑在 workerd 里，routes.ts 的 workerd 替换注释即为此服务）；
- `effect/`、`promise.ts`：Effect 与 Promise 双风格 API；
- `tool.ts`：SDK 侧自定义工具的定义辅助。

对使用者来说：`import { createOpencodeClient } from "@opencode/sdk"` 或 CLI 的 `opencode serve` 是两个等价入口。

## 五、会话如何被多端共享

会话 ID（`SessionSchema.ID`）+ 消息表（packages/core/src/session/sql.ts）是唯一事实源。任何 client 只要有 server 地址与凭据就能附着同一个会话：`bun run dev:live` 就是利用这一点让开发中的 TUI 直连已安装的后台服务与活动会话（根 AGENTS.md "Live TUI Testing" 一节：通过 `opencode service status` 发现服务、`opencode service get password` 注入私有凭据）。

## 六、学习建议

读协议三步走：先看 packages/protocol/src/api.ts 的 group 声明（理解端点全貌）；再挑一个 handler 对照（如 packages/server/src/handlers/event.ts 理解事件订阅）；最后看 packages/client 生成物里的类型（与 Schema 一一对应，packages/schema 是所有类型的最终出处）。
