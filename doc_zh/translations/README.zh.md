<!--
doc_zh/translations/README.zh.md —— 根 README.md 的中文翻译学习稿。

【重要说明】本仓库根目录已经存在官方维护的 README.zh.md（简体中文版）。
本文件是另一份独立翻译稿，用于与官方版对照学习。翻译时与 README.zh.md 逐节对比，差异如下：

1. 结构与内容：两版与英文 README.md 保持同构（安装 / 桌面版 / Agents / 文档 / 贡献 / 基于 OpenCode 开发），差异极小。
2. 社区链接（最大差异）：英文 README.md 结尾是 “Join our community Discord | X.com”；
   官方 README.zh.md 把 Discord 换成了飞书群链接（applink.feishu.cn...）；
   本翻译稿忠实于英文原文，保留 Discord。
3. 措辞差异举例：
   - 英文 “# YOLO” 官方版译作 “# 直接安装 (YOLO)”，本稿保留 “# YOLO”。
   - 官方版 “安装前请先移除 0.1.x 之前的旧版本。”，本稿作 “安装前请先卸载 0.1.x 及更早版本。”。
4. 语言导航列表两版一致（22 种语言，顺序相同）。
5. 维护策略：官方 README.zh.md 随上游同步更新，本翻译稿只作为 doc_zh 学习资料，不参与上游同步。
-->

<div align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</div>
<p align="center">开源的 AI 编码智能体（AI coding agent）。</p>

<p align="center">
  <a href="https://opencode.ai/discord"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
  <a href="https://www.npmjs.com/package/@opencode/cli"><img alt="npm" src="https://img.shields.io/npm/v/@opencode/cli?style=flat-square" /></a>
  <a href="https://github.com/anomalyco/opencode/actions/workflows/release.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/anomalyco/opencode/release.yml?style=flat-square&branch=dev" /></a>
</p>

---

### 安装

```bash
# YOLO
curl -fsSL https://opencode.ai/v2/install | bash

# 包管理器
npm i -g @opencode/cli@latest      # 或 bun/pnpm/yarn
brew install anomalyco/tap/opencode-v2 # macOS 与 Linux（推荐，始终保持最新）
brew install opencode              # macOS 与 Linux（官方 brew formula，更新较慢）
sudo pacman -S opencode            # Arch Linux（稳定版）
paru -S opencode-beta              # Arch Linux（AUR 最新版）
mise use -g opencode               # 任意操作系统
nix run github:anomalyco/opencode  # Nix
```

> [!TIP]
> 安装前请先卸载 0.1.x 及更早版本。

### 桌面应用（BETA）

OpenCode 也提供桌面应用，可从 [opencode.ai/download](https://opencode.ai/download) 下载。

| 平台                  | 下载                             |
| --------------------- | -------------------------------- |
| macOS（Apple Silicon）| `opencode-desktop-mac-arm64.dmg` |
| macOS（Intel）        | `opencode-desktop-mac-x64.dmg`   |
| Windows               | `opencode-desktop-win-x64.exe`   |
| Linux                 | `.deb`、`.rpm` 或 `.AppImage`    |

```bash
# macOS（Homebrew）
brew install --cask opencode-desktop
```

#### 安装目录

安装脚本会把 OpenCode 装到 `$HOME/.opencode/bin`。

### 智能体（Agents）

OpenCode 内置两个智能体，用 `Tab` 键切换：

- **build** —— 默认、拥有完整权限的开发智能体
- **plan** —— 只读智能体，用于分析与代码探索
  - 默认拒绝文件修改
  - 运行 bash 命令前先请求许可
  - 适合探索陌生代码库或规划改动

另有一个 **general** 子智能体，用于复杂搜索与多步任务。它供内部使用，也可以在消息里用 `@general` 调用。

更多内容见 [agents 文档](https://opencode.ai/v2/docs/agents)。

### 文档

想了解如何配置 OpenCode，请移步[**官方文档**](https://opencode.ai/v2/docs)。

### 参与贡献

如果你有兴趣为 OpenCode 做贡献，提交 PR 前请先阅读[贡献指南](./CONTRIBUTING.md)。

### 基于 OpenCode 开发

如果你在做的项目与 OpenCode 相关，并且在名字里使用了 "opencode"（例如 "opencode-dashboard"、"opencode-mobile"），请在你的 README 中注明：该项目并非 OpenCode 团队开发，与我们没有任何隶属关系。

---

**加入我们的社区** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
