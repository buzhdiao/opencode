# 01 · 总体架构

OpenCode 是一个开源 AI coding agent，提供终端（TUI）、Web、桌面（Electron）三种形态，共享同一个后端内核。当前版本（2.2.5，`dev` 分支）是一个 Bun + TypeScript monorepo，整个后端构建在 [Effect](https://effect.website) 之上。

## 一、分层与依赖方向

根目录 AGENTS.md 明确约束了运行时依赖方向：`Schema → Core/Protocol → Server`，`Client` 只依赖 Schema 与 Protocol，`sdk` 负责把 Client、Core、Server 组合起来（见根 AGENTS.md 的 "Keep runtime dependencies directed..." 一节）。

- `packages/schema`：所有跨进程契约——session 消息、工具结果、配置、agent 定义、错误等，全部用 zod/Effect Schema 定义一次，处处复用。这是"wire 与存储契约"层。
- `packages/core`：领域核心，`src/` 下有 100+ 个模块（session/、tool/、permission、config、provider、database、mcp、pty、shell 等），几乎每个模块都是"Effect 服务 + Node 装配"的形态。
- `packages/protocol`：公开 API 的定义层，用 effect `HttpApi` 把端点分组（agent/plugin/model/provider/integration/websearch 等 group 见 packages/protocol/src/api.ts:39-45）。
- `packages/server`：HTTP 服务器与运行时装配（packages/server/src/routes.ts:57-88 列出全部应用服务节点）。
- `packages/client`：由 protocol 生成的 TS 客户端（改协议后运行 `bun run generate`，禁止手改）。
- `packages/cli` / `tui` / `app` / `desktop`：三种用户形态 + CLI 入口；TUI 用 solid-js + @opentui 在终端里渲染响应式 UI（packages/tui/package.json 依赖）。

## 二、Effect 服务与 Location

core 里每个子系统都是一个 `Context.Service`（如 `"@opencode/SessionRunner"`，packages/core/src/session/runner/index.ts:44），由 `Layer.effect` 装配，再用 `makeLocationNode` 包成 Node 挂进依赖图（packages/core/src/session/runner/llm.ts:443-462）。"Location" 是本仓库的核心抽象：一个工作目录实例 = 一棵服务子树，服务器可以同时托管多个 Location；packages/server/src/routes.ts:117-164 里 `AppNodeBuilder.build(applicationServices, replacements)` 就是按 options 替换实现后构建整张图。

## 三、事件与持久化

- 领域事件走进程内 `Bus`（packages/core/src/bus.ts），UI 通过 server 的事件流订阅（EventFeed）。
- 会话历史、消息、压缩记录全部持久化到 SQLite（drizzle-orm 表定义在 packages/core/src/session/sql.ts；查询见 packages/core/src/session/runner/llm.ts:387-399 的 `json_extract` 用法）。
- 一切设计围绕"可恢复"：进程崩溃后，runner 会把遗留的 running 压缩判为中断（packages/core/src/session/runner/llm.ts:382-410）、把未完成的工具调用判为中断（同文件 412-435 行），再从续跑点继续。

## 四、一次请求的旅程

用户在 TUI 输入 → TUI 调 client → server handler → core 的 Session 服务写收件箱 → `SessionRunner.drain` 晋升输入并进入 agent 循环（packages/core/src/session/runner/llm.ts:64-221）→ 组请求（model-request）→ `@opencode/ai` 的 LLM 客户端流式调 provider → 解析出工具调用 → Tool 服务执行（packages/core/src/tool.ts:299-320 的 snapshot.execute）→ 结果写回历史 → 循环直到空闲。每一步都有事件广播，三种 UI 形态因此看到同一份实时画面。

## 五、为什么这样设计

1. **多形态复用**：TUI/Web/桌面连的都是同一个 server，业务只在 core 写一次。
2. **Effect 的可中断/可重试/资源安全**：LLM 流、工具 fiber、超时、中断（Esc 打断）这类需求用原生 Effect 语义表达（packages/core/src/session/runner/step.ts:138 的 `uninterruptibleMask` 保证收尾事件一定落库）。
3. **类型即文档**：错误用可辨识联合（DrainResult，packages/core/src/session/runner/index.ts:23-28），调用方被迫穷尽处理。
