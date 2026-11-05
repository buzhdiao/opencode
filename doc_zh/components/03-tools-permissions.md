# 03 · 工具系统与权限

## 一、工具注册表

所有工具（内置 + 插件 + MCP）统一注册进 `Tool` 服务（packages/core/src/tool.ts）。注册时做校验：名字只允许 `[A-Za-z0-9_-]`（tool.ts:400-401）、`execute` 名字保留给 Code Mode（tool.ts:403-404）、input 必须是 Standard Schema（tool.ts:406-409，兼容 zod/ArkType 等任何 Standard Schema 实现）。校验失败不抛异常，而是记入 errors 并打日志（tool.ts:364-379），保证一个坏插件不拖垮全局。

每次模型请求前，`snapshot(permissions)`（tool.ts:251-323）按权限规则产出"本次可用的工具定义集合"与统一执行入口 `execute`。工具分两类：

- **直接工具**：`codemode: false` 的工具（如 bash/edit/read），直接暴露给模型；
- **Code Mode 工具**：其余工具装进一个名为 `execute` 的元工具，模型写一段 TS 程序来编排多次调用，减少 round-trip 与 token（CodeModeTool.create，tool.ts:272-278）。

执行管线（`executeTool`，tool.ts:131-179）：`execute.before` 插件钩子（可改写入参）→ 工具体 → `execute.after` 钩子（可改写结果）→ 内容规范化（`normalizeImages`，tool.ts:92-119，把 data URL 图片转码/压缩，失败剔除并附计数提示）。

## 二、权限系统

权限核心是 `Permission` 服务（packages/core/src/permission.ts）：接口只有两个方法——`assert`（permission.ts:113）与 `assertNotDenied`（permission.ts:115），规则是带通配符的 `(action, resource, effect)` 列表（Wildcard 匹配，tool.ts:381-384）。"整体禁用"的判定是最后一条匹配规则为 `resource: "*" + deny`。

典型链路以 shell 工具为例（packages/core/src/tool/plugin/shell.ts:114-142）：`ShellParse.scan` 解析出命令串里每一条具体命令与涉及目录 → `access.authorizeExternal` 校验 Location 外目录 → 逐条 `permission.assert` 弹出授权（用户可批准/拒绝/记住）。edit 工具走 `permission: "edit"` 动作并在写授权时展示 diff 预览（packages/core/src/tool/plugin/edit.ts:321）。

## 三、build 与 plan agent

agent 定义来自 Schema（packages/core/src/agent.ts:20-22 的 Info）与用户配置，注册表可增删改（agent.ts 的 Editor）。README 描述的两个内置 agent：

- **build**（默认，`defaultID = "build"`，agent.ts:10）：全权限，正常开发流；
- **plan**：只读探索——默认拒绝文件编辑、bash 命令需批准。这在权限层面表达为 plan agent 携带一组 deny 规则，进入上面 `whollyDisabled`/`assert` 的同一套机制，而不是工具系统里的特判。

另有 **general** 子代理（复杂搜索/多步任务），以 `subagent` 工具形态被调用（崩溃恢复时还会带上其子会话 ID，见 packages/core/src/session/runner/llm.ts:420-421）。

## 四、代表性工具实现

- **shell**（packages/core/src/tool/plugin/shell.ts）：作业（Job）化执行——前台阻塞等待、可被"转后台"（241-253 行），后台命令完成后自动向会话发合成消息唤醒模型继续（notifyWhenDone，144-176 行）；崩溃后凭 recovery 信息找回 shell（226-239 行）。
- **edit**（packages/core/src/tool/plugin/edit.ts）：精确替换——LF 视图匹配 + 偏移回映射保 CRLF（matchView，168-188 行）；三级降级匹配（精确→排版字符归一化→行级忽略行尾空白）；失败时"投票法"提示最接近的行（missHint，199-241 行）；同路径编辑用文件锁互斥（355 行）。
