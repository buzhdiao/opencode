# 05 · Provider 与认证层

OpenCode 接入几十家模型服务商，靠的不是硬编码适配器列表，而是"目录（models.dev）+ 按需加载的 provider 包 + Effect 化的统一协议层"。

## 一、模型目录：models.dev

每个 provider 有哪些模型、上下文窗口多大、价格多少、是否支持图片/推理/原生压缩——这些元数据不在本仓库维护，而是来自开源项目 models.dev（CONTRIBUTING.md:19-21 明确说：新增 provider 先加到 models.dev）。core 里的 `ModelsDev` 服务（packages/server/src/routes.ts:31 导入、131-132 行按 options 装配）负责拉取/缓存目录；core 的 `Model` 服务（packages/core/src/model.ts）再按 providerID/modelID 提供查询。压缩模块大量依赖这些元数据：窗口未知时按 200k 假设（packages/core/src/session/compaction.ts:137），图片按 1500 token、PDF 按 2000 估算（compaction.ts:151-152）。

## 二、Provider 包与按需加载

packages/core/src/provider.ts 是 provider 注册表：

- 支持两种入口：原生 provider 包与任意 AI SDK 兼容包——`aisdk:` 前缀（provider.ts:19-23）让用户可以直接接 `@ai-sdk/*` 生态的包；`packageName()` 还做了 npm scope 迁移的兼容（25-28 行）。
- 模块用 `importModule/resolveModule`（provider.ts:10）运行时加载，配合 `Npm` 工具按需安装到用户机器，而不是打进发行包——这就是为什么 core 的 package.json 里只有 `@ai-sdk/provider` 与 `@ai-sdk/provider-utils` 两个基础依赖（packages/core/package.json:96-97）。
- `Service`（provider.ts:361）暴露 provider/model 的增删改查，模型解析结果（`SessionRunnerModel.Resolved`）里带 route/limit/cost/capabilities，整个 runner 与 compaction 都只消费这份解析结果。

## 三、协议层：packages/ai

packages/ai 是自研的"Effect 化 AI 层"，不直接依赖 vercel ai-sdk 的运行时（依赖里只有 aws/google 的鉴权库，packages/ai/package.json），自己实现：

- **providers/**：按服务商的协议实现目录（anthropic、amazon-bedrock、azure、cloudflare-ai-gateway、alibaba……20+ 目录，每个目录含 auth/endpoint/协议编解码）；
- **route/**：请求的统一抽象——auth.ts（各厂商签名/令牌）、executor.ts（执行器）、transport/（HTTP 传输与流解析）、protocol.ts（wire 协议）、decision.ts/decision-client.ts（重试与轮换决策）；
- **llm.ts / effect.ts**：把"一次 LLM 流式调用"建模成 `Stream<LLMEvent>`，事件类型（textDelta/tool-call/stepFinish/finish）被 core 全线消费（packages/core/src/session/runner/step.ts:110-135）；
- **错误分类**：AIError 体系区分 Transport/InvalidRequest/InvalidProviderOutput 等，并给出 `recovery` 标记（"retry-full"/"rotate-and-retry-full"，消费点在 step.ts:193-199）与"上下文溢出"判定 `isContextOverflowFailure`（compaction.ts:680 的收缩循环靠它驱动）。

## 四、凭据与认证

`Credential` 服务（packages/core/src/credential.ts:39-70）统一管理 API key：`get/set/remove` 接口 + 按平台的安全存储（keychain 等），ID 命名空间区分 provider 与 integration。OAuth 流程在 packages/core/src/oauth/。此外：

- `models.auth.json` / `auth` 命令管理登录态；
- Claude Max / Copilot 等特殊认证在 packages/core/src/github-copilot/ 等模块；
- server 侧另有面向客户端连接的鉴权（ServerAuth，packages/server/src/auth.ts，routes.ts:90-103 按是否配置密码选择鉴权层）——注意区分"provider 的 API key"与"client 连 server 的密码"两层。

## 五、一次模型调用的完整路径

`SessionModelRequest.primary`（packages/core/src/session/runner/llm.ts:260-285）→ 请求钩子 → `LLMClient.stream`（step.ts:110）→ route/transport 按 provider 发流 → LLMEvent 流 → publisher 投影成会话事件。重试由 SessionRunnerRetry 决策（packages/core/src/session/runner/retry.ts），provider 级轮换（rotate key）由 route/decision 决策——两层重试各司其职。
