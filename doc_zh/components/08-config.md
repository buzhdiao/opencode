# 08 · 配置系统

OpenCode 的配置分两层：**机器配置**（opencode.json / opencode.jsonc）与 **指令配置**（AGENTS.md 等 markdown）。前者告诉 agent "你能用什么"，后者告诉 agent "你该怎么干活"。

## 一、opencode.json

文件名与发现逻辑在 packages/core/src/config/discovery.ts:12（`["opencode.json", "opencode.jsonc"]`，jsonc 允许注释），加载与候选查找在 packages/core/src/config.ts（476 行附近从候选目录里挑最后一个存在的配置文件）。配置 Schema 定义在 packages/schema/src/config.ts（含 lsp 等历史键）。解析管线在 packages/core/src/config/normalize.ts（832 行）：负责版本迁移、键归一化、`lsp` 等旧键的兼容解码（501-504 行）。

可配置的主要内容：provider/model、agent（含 steps 上限、权限规则）、权限（allow/deny 规则列表）、MCP server、keybinds、theme、插件、compaction 参数（packages/core/src/session/compaction.ts:42-50 的 `Settings`：auto/keep/precompute/buffer）等。配置支持层级合并：全局（`$HOME/.config/opencode/`）→ 项目 → Location 实例，`Config.node` 在 server 装配时按 options 替换来源（packages/server/src/routes.ts:137-144：project/claude/file/content 四种来源）。

配置还有"监听热更"：packages/core/src/config/watch.ts + `State.reload` 模式（tool.ts/compaction.ts 均实现 `transform/reload`），改配置文件不用重启。

## 二、AGENTS.md（指令系统）

AGENTS.md 是"项目说明书"，等价于 Cursor 的 rules（官方文档 packages/web/src/content/docs/rules.mdx）。`/init` 命令会扫描仓库并生成/改进它（rules.mdx 的 Initialize 一节），内容通常是构建/测试命令、架构说明、项目约定。

源码侧：指令发现（含嵌套 AGENTS.md、全局/项目/目录级）在 packages/core/src/instruction-discovery.ts；装载与状态在 packages/core/src/instructions/ 与 packages/core/src/session/instruction-state.ts；最终通过 `SessionModelRequest.baseTranscript` 注入 system 提示（消费点 packages/core/src/session/compaction.ts:998-1005）。指令还有"就绪状态"机制：被阻塞的指令基线会让已准入输入保持 pending（packages/core/src/session/runner/llm.ts:228 的 `InstructionState.prepare`）。

前端可复用 Cursor/Copilot 规则（rules.mdx 提及引用现有规则源），markdown frontmatter 用 gray-matter 解析（packages/core/package.json:124）。

## 三、变量与环境

配置里可写变量与环境引用（`{env:VAR}` 之类），实现在 packages/core/src/config/variable.ts。shell 命令相关的环境注入在工具层完成（如 shell 工具给子进程加 `OPENCODE_SESSION_ID`，packages/core/src/tool/plugin/shell.ts:200-203）。

## 四、模式化状态：State + Editor

core 里几乎所有可配置子系统都走同一个模式（packages/core/src/state.ts）：

```ts
State.create<Settings, Editor>({ name, initial, editor, notify })
```

- `initial()`：默认值（如 compaction 的 `{ auto: true, keep: 15_000, precompute: false }`，compaction.ts:269）；
- `editor`：受控修改接口（`configure`）；
- `notify`：变更后的副作用（如 tool.ts:232-244 让 Code Mode 目录缓存失效并打印注册错误）；
- `transform/reload`：插件在事务里改配置、热重载。

这保证配置语义一致：默认值集中、修改可审计、重载可撤销。

## 五、学习建议

按顺序读：discovery.ts（找文件）→ normalize.ts（解析与迁移）→ config.ts（合并与加载）→ state.ts（模式）→ 任意一个消费者（如 compaction.ts:267-275）看默认值如何生效。想加自己的配置项，改 packages/schema/src/config.ts 的 Schema，再在 normalize.ts 加兼容逻辑。
