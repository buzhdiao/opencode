<!--
doc_zh/translations/CONTRIBUTING.zh.md —— 根 CONTRIBUTING.md 的中文翻译。
仓库目前没有 CONTRIBUTING 的官方中文版（多语言仅覆盖 README），本文件为学习用翻译稿。
原文：CONTRIBUTING.md（翻译时点：v2.2.5，dev 分支）。
-->

# 为 OpenCode 做贡献

最容易被接受的改动类型：

- Bug 修复
- 新增 LSP 与格式化器支持
- LLM 性能改进
- 特定环境下的修复
- 缺失的标准行为
- 文档改进

UI 与核心产品功能在实现之前需要通过设计评审。如果你不确定某个改动是否合适，可以询问维护者，或从带有 [`help wanted`](https://github.com/anomalyco/opencode/issues?q=is%3Aissue%20state%3Aopen%20label%3Ahelp-wanted)、[`good first issue`](https://github.com/anomalyco/opencode/issues?q=is%3Aissue%20state%3Aopen%20label%3A%22good%20first%20issue%22)、[`bug`](https://github.com/anomalyco/opencode/issues?q=is%3Aissue%20state%3Aopen%20label%3Abug)、[`perf`](https://github.com/anomalyco/opencode/issues?q=is%3Aopen%20is%3Aissue%20label%3A%22perf%22) 标签的 issue 中挑选。

想认领某个 issue？留下评论，维护者可能会将其分配给你（除非已有人在处理）。

> [!NOTE]
> 无视以上护栏的 PR 大概率会被直接关闭。

## 新增 Provider

新的模型服务商通常不需要改动 OpenCode 本身。请先把 provider 添加到 [models.dev](https://github.com/anomalyco/models.dev)。

## 开发

OpenCode 需要 Bun 1.3 或更新版本。在仓库根目录：

```bash
bun install
bun dev [directory]
```

`bun dev` 启动 V2 CLI 与 TUI。传入目录可打开另一个项目，传 `.` 则打开本仓库。

要让开发中的 TUI 连接你已安装的 OpenCode V2 后台服务与活动会话：

```bash
bun run dev:live [directory]
```

Web 开发需要分两个终端分别跑后端与前端。其他形态各有根目录脚本：

```bash
bun dev serve --port 4096
bun run dev:web
bun run dev:desktop
bun run dev:www
```

### 包说明

- `packages/schema`：共享的 wire 与存储契约
- `packages/core`：领域行为与持久化
- `packages/protocol`：公开 API 定义
- `packages/server`：HTTP 服务器与运行时装配
- `packages/client`：生成的 TypeScript 客户端
- `packages/cli`：命令行入口与服务生命周期
- `packages/tui`：终端界面
- `packages/app`：共享 Web 界面
- `packages/desktop`：Electron 桌面应用
- `packages/plugin`：插件 API

### 验证

从受影响的包（而不是仓库根目录）运行类型检查与测试：

```bash
cd packages/core
bun run test
bun typecheck
```

遵循附近 `AGENTS.md` 文件中针对各包的说明。修改了公开的 Protocol 或 Server `HttpApi` 之后，在 `packages/client` 下运行 `bun run generate`；永远不要直接编辑生成的客户端文件。

遵循仓库[风格指南](./AGENTS.md)。

## Pull Request

### 必要时关联 Issue

Bug 修复、杂务与测试必须引用一个已存在的 issue。文档、重构与功能类 PR 可豁免“必须关联 issue”的自动检查。需要关联时，在 PR 描述里用 `Fixes #123` 或 `Closes #123`。

在实现新功能之前，先开一个 feature request 描述问题、为什么它属于 OpenCode，以及（如果你有的话）你的实现思路。等设计获批后再开实现 PR。

分支基于 `dev` 创建，并填写 PR 模板。

### 保持聚焦

- PR 保持小而专注。
- 说明问题是什么、你的改动为什么能修复它。
- 先确认该功能是否已经存在。
- UI 改动请附前后截图或视频。
- 逻辑改动请说明你测了什么、评审者如何验证。

### 保持简短

冗长的、AI 生成的 PR 描述与 issue 可能被直接忽略。请用自己的话写简短说明。如果改动无法简短讲清，这个 PR 可能就太大了。

### 使用约定式标题

使用 `type(scope): summary`。支持的类型：`feat`、`fix`、`docs`、`chore`、`refactor`、`test`。scope 可选。

示例：

- `docs: update contributing guide`
- `fix(tui): restore scroll position`
- `feat(app): add workspace search`

## Issue

Bug 报告与功能请求必须使用 issue 模板；不允许空白 issue。支持与使用问题请在 [Discord 社区](https://discord.gg/opencode)提问。

自动检查会标记缺失模板、占位文本、AI 生成的长篇大论以及缺少实质内容的 issue。被标记后你有两小时时间修正，超时将自动关闭。如果你认为标记有误，请询问维护者。
