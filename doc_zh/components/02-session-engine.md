# 02 · Session 引擎与 Agent 循环

Session 引擎是整个产品的"心脏"：把用户输入变成一轮轮"模型请求 → 工具执行 → 结果喂回"的循环，并保证任何时刻崩溃都能恢复。核心代码在 `packages/core/src/session/`（70+ 文件），主循环在 `session/runner/`。

## 一、入口：drain（排空收件箱）

`SessionRunner.drain`（packages/core/src/session/runner/llm.ts:64-221）是一轮对话的主循环，签名见接口定义（packages/core/src/session/runner/index.ts:31-42）。要点：

- 输入存在"收件箱"（SessionInbox）：用户新消息、`/compact`、move 都是收件箱条目，分 `steer`（打断当前意图）与 `queue`（排队下一轮）两种投递方式。
- `advanceToStep`（llm.ts:82-210）循环处理控制项：手动压缩（130-174 行）、move 到其他 Location（125-129 行）、空闲时的 `experimental.idle` 插件钩子（179-186 行），直到返回 `Ready`。
- 每次拿到 Ready 就 `runStep`，然后 `step++` 继续外层循环（llm.ts:212-220）。
- 结果是 `DrainResult` 可辨识联合：Complete / Moved / Reloaded（packages/core/src/session/runner/index.ts:23-28）。

## 二、一步之内：SessionStep.attempt

`runStep`（llm.ts:233-380）负责步间策略：自动压缩（245 行）、步数上限（252 行）、请求组装与钩子（260-285 行），真正执行交给 `SessionStep.attempt`（packages/core/src/session/runner/step.ts:71-295）：

- provider 流逐事件发布（step.ts:110-135），事件翻译由 `createLLMEventPublisher` 完成；
- 每个本地工具调用 fork 一个 fiber 并发执行（step.ts:120-131），互不阻塞、保序发布；
- 收尾段放在 `uninterruptibleMask` 里（step.ts:138）：即使用户按 Esc，Step 事件与工具结算也一定落库；
- 六种 `Outcome`（step.ts:30-41）：Completed / Retry / Continue / RecoverFull / Compacted / OutputLimit，分别对应正常完成、整体重试、断流续写、传输层重试、溢出压缩、输出上限续写。

三类"智能续写"提示词定义在 llm.ts:37-41（断流续写、超长拆分），OutputLimit 连续两次仍截断则判定失败（llm.ts:339-369）。

## 三、上下文压缩（compaction）

接近模型窗口时自动把旧历史总结成"检查点"（摘要 + 最近 `keep` token 原文）。实现在 packages/core/src/session/compaction.ts：

- 触发判定 `due`（compaction.ts:437-446）与上限计算 `calculateCeiling`（1160-1168 行，默认留 15% 且至少 16k 空隙）；
- 后台预计算 `precompute`（348-404 行）：距上限 60k token 时就趁 prompt 缓存还热，在后台把摘要写好存着，到期直接换入（`usePrecomputed`，411-435 行）；
- 收缩策略 `deliver`（615-703 行）："too long" 被拒后按 85%/70%/50%/35% 逐级瞄准更小目标；"payload too large"（字节超限，多为图片）改发纯文本；
- 文本化 `flattenAndDropOldest`（717-785 行）：把要改写的历史压成一条文本消息，交互从旧到新逐级缩短（完整→裁工具输出→去工具输出→只留用户文本→省略），最新交互绝不省略。

## 四、崩溃恢复

drain 开始时先做两次"陈旧结算"：`settleStaleCompactions` 把遗留 `status=running` 的压缩消息判为 interrupted（llm.ts:382-410），`settleStaleToolCalls` 把 streaming/running 的工具调用判为中断（llm.ts:412-435）。配合 `Continuation = { step }`（index.ts:21）与数据库历史，新进程可从任意一步继续。
