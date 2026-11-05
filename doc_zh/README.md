# OpenCode 中文学习文档（doc_zh）

> 本目录是一套面向"学习/理解源码"的中文文档工程，基于仓库当前代码（`dev` 分支，版本 2.2.5）整理。
> 与官方文档（packages/web/src/content/docs）不同：这里全部为中文原创整理，并带 `file:line` 源码引用，方便对照阅读。
> 注意：OpenCode 迭代极快，行号以本文档提交时的代码为准。

## 文档清单

### 组件原理（doc_zh/components/）

| 编号 | 文章 | 内容 |
| --- | --- | --- |
| 01 | [总体架构](components/01-architecture.md) | monorepo 分层（schema/core/protocol/server/…）、Effect 依赖注入、Location 模型 |
| 02 | [Session 引擎与 Agent 循环](components/02-session-engine.md) | runner.drain 主循环、Step 执行、消息收件箱、compaction 压缩 |
| 03 | [工具系统与权限](components/03-tools-permissions.md) | 工具注册/执行管线、Code Mode、权限断言、build/plan agent 区别 |
| 04 | [LSP 集成](components/04-lsp-integration.md) | LSP 的历史与现状（v2 已移除内置客户端，配置残留与未来接缝） |
| 05 | [Provider 与认证层](components/05-provider-auth.md) | 多模型接入、models.dev 目录、凭据存储、models.dev/auth 细节 |
| 06 | [Server/Client 协议与 SDK](components/06-server-client-protocol.md) | effect HttpApi、OpenAPI 生成 client、SDK 组合、事件流 |
| 07 | [GitHub Actions 集成](components/07-github-actions.md) | `/opencode` 与 `/oc` 评论触发、自动开分支提 PR、安全模型 |
| 08 | [配置系统](components/08-config.md) | opencode.json(c)、AGENTS.md、全局/项目配置合并、变量展开 |

### 翻译（doc_zh/translations/）

- [README.zh.md](translations/README.zh.md) —— 根 README 的中文翻译（仓库已自带 `README.zh.md`，翻译稿与它的差异写在文件头注释里）
- [CONTRIBUTING.zh.md](translations/CONTRIBUTING.zh.md) —— CONTRIBUTING.md 中文翻译

### 技法手册

- [techniques-100.md](techniques-100.md) —— 《TypeScript 高级技法与重要库 100 讲》：恰好 100 条，全部结合本仓库真实代码与 package.json 依赖（Bun、Effect、zod、drizzle、@opentui、Monorepo 实践等）

## Monorepo 包布局速览

这是一个 Bun workspaces + Turborepo 的 monorepo（根 package.json 的 `workspaces.packages` 含 `packages/*`、`packages/plugins/*`、`services/*`、`packages/console/*`、`packages/stats/*`），包间依赖方向受 AGENTS.md 约束：

```
schema ──► core ──► server
   │         │          │
   └──► protocol ──► client ──► sdk（= client + core + server 的组合）
                │
   tui / app / desktop / cli 等各形态入口
```

### packages/ 主要包

| 包 | npm 名 | 角色 |
| --- | --- | --- |
| `packages/schema` | `@opencode/schema` | 共享的 wire 与存储契约（zod/Schema 定义：session、tool、config、agent、错误等） |
| `packages/core` | `@opencode/core` | 领域行为与持久化：session 循环、工具、权限、provider、配置、数据库（`src/` 下 100+ 模块） |
| `packages/protocol` | `@opencode/protocol` | 公开 API 定义（effect `HttpApi` 分组 + client 包装） |
| `packages/server` | `@opencode/server` | HTTP 服务器与运行时装配（`routes.ts` 组装整张服务依赖图） |
| `packages/client` | `@opencode/client` | 由 protocol 生成的 TypeScript 客户端（勿手改，改协议后 `bun run generate`） |
| `packages/sdk` | `@opencode/sdk` | SDK：组合 client/core/server（含 workerd/嵌入式形态） |
| `packages/cli` | `@opencode/cli` | 命令行入口与服务生命周期（`bun dev` 跑的就是它） |
| `packages/tui` | `@opencode/tui` | 终端界面（solid-js + @opentui 终端渲染） |
| `packages/app` | `@opencode/app` | 共享 Web 界面（浏览器端） |
| `packages/desktop` | `@opencode/desktop` | Electron 桌面应用（Beta） |
| `packages/plugin` | `@opencode/plugin` | 插件 API（Effect 风格钩子契约） |
| `packages/ai` | `@opencode/ai` | LLM 抽象层：provider 路由、LLM 事件流、错误分类、Effect 化的 AI SDK |
| `packages/codemode` | `@opencode/codemode` | Code Mode：受限的 TS 程序执行（模型写代码编排工具调用） |
| `packages/ui` | `@opencode/ui` | 共享 UI 组件库 |
| `packages/session-ui` | `@opencode/session-ui` | 会话界面的共享组件（TUI/Web 复用） |
| `packages/util` | `@opencode/util` | 通用工具（含 Effect 辅助） |
| `packages/opencode` | —— | 仅有 `dist/`（旧发布壳/兼容产物，无源码） |
| `packages/console/*` | —— | 控制台（SST 云端部署的管理面/网页） |
| `packages/web` | —— | 官网与文档站（Astro） |

### 其他目录

- `sdks/vscode`：VS Code 插件。
- `packages/plugins/figma`：官方插件示例。
- `services/`：云端服务（www、changelog、files、update）。
- `script/`：仓库脚本（ast-grep 规则、SDK 文档生成、打包等）。
- `.github/workflows/`：CI/CD（check、release、triage 机器人等）。
- `specs/`：设计文档。
- `infra/`、`sst.config.ts`：SST 基础设施定义。

## 快速上手（来自 CONTRIBUTING.md）

```bash
bun install          # Bun 1.3+
bun dev [directory]  # 跑 V2 CLI + TUI
bun run dev:web      # Web 界面
bun run dev:desktop  # 桌面端
```

校验在受影响的包内进行（`cd packages/core && bun run test && bun typecheck`），仓库根不跑测试。
