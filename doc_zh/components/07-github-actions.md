# 07 · GitHub Actions 集成

OpenCode 可以被"住"进你的 GitHub 仓库：在 issue 或 PR 评论里输入 `/opencode`（或简写 `/oc`），OpenCode 就会在你的 GitHub Actions runner 里执行任务——分类 issue、修 bug、实现功能，并自动开分支提 PR。官方文档见 packages/web/src/content/docs/github.mdx（本文内容以它为准）。

## 一、触发机制

workflow 监听两类评论事件（github.mdx 的示例 workflow）：

```yaml
on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
jobs:
  opencode:
    if: |
      contains(github.event.comment.body, '/oc') ||
      contains(github.event.comment.body, '/opencode')
```

- 触发词大小写不敏感，可用 `mentions` 配置改默认列表（默认 `/opencode,/oc`）；
- 命令式任务有约定前缀（如 `/oc fix`、`/oc implement`、`/oc triage`），无前缀则按默认行为处理评论内容；
- `agent` 配置选择主 agent（缺省回退到配置里的 default agent 或 `build`），`model`（`provider/model` 格式）必填，`variant` 选择推理力度（high/max/minimal）。

## 二、自动开分支提 PR

"fix/implement" 类任务的标准流程：OpenCode 在 Actions runner 里运行 → 基于当前仓库开一个新分支 → 完成修改 → push 分支 → 创建 PR 并在原评论处回复链接。这一整套动作依赖 GitHub App 的安装令牌（而非你的个人 token）。

## 三、安全模型

这是该集成最值得学习的部分：

- **在用户自己的 runner 里跑**：模型代码不接触 OpenCode 的服务器，凭据与代码都留在用户环境（github.mdx："OpenCode runs inside your GitHub's runners"）；
- **OIDC 令牌交换**：workflow 只需 `id-token: write` 与 `contents: read` 两个权限；运行时 OpenCode 用 OIDC token 向 `https://api.opencode.ai`（`oidc_base_url` 可覆盖）换取 GitHub App installation token，再由这个短时 token 完成评论/推分支/开 PR——避免了把长期 PAT 存进 secrets；
- **无 App 模式**：`use_github_token: true` 时改用调用方提供的 `GITHUB_TOKEN`（需要 `contents/pull-requests/issues: write`），适合不想安装 OpenCode GitHub App 的场景；
- **最小 checkout**：`fetch-depth: 1` + `persist-credentials: false`（github.mdx 示例高亮行），checkout 不留下可被滥用的凭据。

## 四、安装方式

`opencode github install`（交互式引导：装 GitHub App → 生成 `.github/workflows/opencode.yml` → 配置 secrets），或按文档手动三步：装 App（github.com/apps/opencode-agent）→ 加 workflow → 配 API key secrets（如 `ANTHROPIC_API_KEY`）。

## 五、对照本仓库

本仓库自身的 CI（.github/workflows/）是另一套体系：check.yml（lint/typecheck）、release.yml（发版）、triage-close-issues.yml 等机器人；bot-docs-locale.yml 维护多语言 README。用户侧的 `/oc` 集成以 `anomalyco/opencode/github` 这个 composite action 形式分发（github.mdx 示例的 `uses:` 行），其源码随发行包提供。

## 六、学习要点

1. OIDC 换取短时 App token 是 Actions 集成的最佳实践（对比直接存 PAT）；
2. `if: contains(...)` 的事件过滤 + 可配置触发词，让"bot 行为"完全由仓库主人掌控；
3. runner 内自举 agent 的模式：checkout → 换凭据 → 跑 agent → 产物回写（分支/PR/评论）。
