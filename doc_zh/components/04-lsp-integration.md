# 04 · LSP 集成

## 一、历史与现状

OpenCode 的 v1 版本曾内置 LSP 客户端（`packages/opencode/src/lsp/`，自动发现并启动 tsserver/gopls/pyright 等 language server，把诊断注入模型上下文）。**当前 v2 代码库（本仓库）已经移除了内置 LSP**：

- 全仓库搜索 `packages/*/src` 下不存在 `lsp/` 目录，也没有 language client 相关代码；
- 只剩两类痕迹：
  1. 配置层残留——`packages/core/src/config/normalize.ts:11` 仍导入 `ConfigLSP`（来自 `@opencode/schema/config/lsp`），501-504 行仍解析 `opencode.json` 里的 `lsp` 配置键（兼容老配置文件不报错）；
  2. 计划中的接缝——edit 工具源码顶部保留着 TODO："Add LSP notification and diagnostics after LSP runtime exists"（packages/core/src/tool/plugin/edit.ts:256-258），说明 LSP 将以独立 runtime/插件的形式回归。

因此本文与其编造"v2 的 LSP 架构"，不如讲清三件事：v1 时代的形态、为什么 v2 移除、未来接缝在哪里。

## 二、v1 时代的形态（供对照）

v1 的 LSP 子系统大致是：启动时扫描工作区文件类型 → 按 matches 规则挑选 server → spawn 对应 language server 进程 → JSON-RPC 通信（initialize/textDocument didOpen/didChange/didSave）→ 收集 hover/diagnostics/definition → 通过事件总线推给 UI，并把诊断摘要注入 agent 的系统提示。CONTRIBUTING.md 至今仍把 "Additional LSPs and formatters" 列为最容易接受的贡献类型（CONTRIBUTING.md:6），这是那段历史的文字化石。

## 三、v2 为什么移除

从架构角度看，v2 的核心变化是把一切都改写成 Effect 服务 + Location 模型（见 01 篇），并引入 Code Mode 与插件体系（packages/plugin）。在这一代架构里：

- LLM 能力大幅增强后，"预注入诊断"的收益下降，而维护几十种 language server 的 spawn/重启/协议兼容成本极高；
- v2 偏向"工具调用按需获取信息"（read/grep/glob 工具 + Code Mode），而非"后台常驻的全量诊断"；
- LSP 的进程管理（每个 Location 一棵服务树）需要重新设计挂载点，所以宁可先摘除。

## 四、未来接缝

如果 LSP 回归，按当前代码看最可能的形态：

- 一个 `@opencode/lsp` 独立包或插件（packages/plugin 的钩子契约已经支持 `tool.execute.before/after` 等域，见 packages/core/src/tool.ts:121-129 的钩子触发）；
- 在 edit 工具提交写入后发 `textDocument/didChange` 并收集诊断（对应 edit.ts 的 TODO 位置）；
- 配置沿用 `opencode.json` 的 `lsp` 键（normalize.ts:501-504 已经在解析）；
- 进程管理复用 v2 的 Job/PersistentPty 设施（packages/core/src/persistent-pty.ts，服务端崩溃后可恢复子进程）。

## 五、给学习者的建议

想在当前代码库里实践"为 OpenCode 加 LSP"，可以：读 `packages/core/src/mcp/`（它是一个完整的"外部进程 + JSON-RPC 客户端"实现，LSP 本质是同构问题）；再读 `packages/core/src/tool/plugin/read.ts` 与 `edit.ts` 理清"模型可见的文件视图"；最后按 edit.ts 的 TODO 接缝做原型。
