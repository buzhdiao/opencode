# TypeScript 高级技法与重要库 100 讲

> 结合 OpenCode 仓库（v2.2.5，dev 分支）的真实代码与 package.json 依赖整理。
> 版本基线（根 package.json 的 workspaces.catalog）：effect 4.1.0、zod 4.6.7、drizzle-orm 1.0.0-rc、solid-js 1.9.17、@opentui 0.8.1、@standard-schema/spec 1.1.0、diff 8.0.4、remeda 2.26.0、hono 4.13.13。
> 所有 `文件:行` 引用都以本仓库当前代码为准。

## 一、TypeScript 语言与类型系统技法（1-15）

### 1. 可辨识联合 + Data.TaggedEnum
用 `_tag` 字段表达"状态的每一种形状"，配 Effect 的 `Data.TaggedEnum` 自动生成构造器与 `$match` 穷尽匹配，消灭 `if/else` 里的魔法字符串。实例：`DrainResult`（packages/core/src/session/runner/index.ts:23-28）、`Outcome` 六分支（packages/core/src/session/runner/step.ts:30-41）。

### 2. 品牌类型（branded type）防串用
`SessionSchema.ID`、`Agent.ID`、`SessionMessage.ID` 都不是普通 string，而是带品牌的一次性 ID 类型——把"会话 ID 传成了消息 ID"这类 bug 挡在编译期。实例：函数签名 `sessionID: SessionSchema.ID`（packages/core/src/session/runner/index.ts:34）。

### 3. `satisfies` 校验而不改变推断
对象字面量既要保留窄类型推断、又要对着接口校验时用 `satisfies` 而非类型注解。实例：Code Mode 检查的返回值 `} satisfies CodeMode.Result`（packages/core/src/tool.ts:326-331）、edit 工具输出 `} satisfies Output`（packages/core/src/tool/plugin/edit.ts:350-353）。

### 4. `Parameters<T>` 抽取函数参数类型
不想重复声明参数形状时，直接从接口"抽"类型。实例：`type DrainInput = Parameters<Interface["drain"]>[0]`（packages/core/src/session/runner/llm.ts:43）。

### 5. 函数重载收敛联合入参
同一函数对不同入参返回不同类型时写重载而非 `any`。实例：`packageName` 的三连重载（packages/core/src/provider.ts:24-28）。

### 6. `Types.Mutable` 深度去 readonly
Effect 类型工具箱提供 `Types.Mutable<T>`，把只读树变成可编辑副本——注册表"读视图/写视图"分离的关键。实例：Editor 的 `update: (id: string, update: (tool: Types.Mutable<Tool.Info>) => void)`（packages/core/src/tool.ts:32）。

### 7. 生成器即控制流（function*）
TS 4.3+ 对生成器类型推断足够强，可以把 `yield*` 当"可等待点"用，实现自定义控制流（Effect 的基础）。实例：整份 packages/core/src/session/runner/llm.ts 都在用 `Effect.gen(function* () {...})`。

### 8. 不可变更新方法 `toReversed()`
替换匹配区间时先 `toReversed()` 从后往前替换，避免前面替换移动后面偏移——ES2023 新方法+算法思维的组合。实例：packages/core/src/tool/plugin/edit.ts:311-316。

### 9. `at(-1)` 与 `findLastIndex`
尾部语义用新数组 API 表达，可读性远胜 `[arr.length - 1]`。实例：`messages.at(-1)`（packages/core/src/session/compaction.ts:440）、`findLastIndex` 定位实测锚点（packages/core/src/session/compaction.ts:364、1130）。

### 10. reduce 做"分组累加"
用 reduce 把消息流按用户消息切成交互组，一行完成分组算法。实例：packages/core/src/session/compaction.ts:738-744。

### 11. `matchAll` 提取全部正则匹配
需要遍历一个正则的所有命中时用 `String.prototype.matchAll`。实例：行切分 `/[^\n]*(?:\n|$)/g`（packages/core/src/tool/plugin/edit.ts:70）、换行符收集（edit.ts:120）。

### 12. 类型化数组写 DP 表
LCS 动态规划用 `Uint32Array((m+1)*(n+1))` 打平成一维——省内存、缓存友好。实例：`alignLines`（packages/core/src/tool/plugin/edit.ts:131-162）。

### 13. 交叉类型做"受限扩展"
`Interface extends State.Transformable<Editor>`：把"可热重载"能力以 mixin 接口的形式叠加到任意服务上。实例：packages/core/src/tool.ts:44、packages/core/src/session/compaction.ts:71。

### 14. 判别字段收窄 + `in` 检查
`if ("failure" in execution)` / `"error" in outcome` 在不引入额外类型的情况下区分成功/失败形状。实例：packages/core/src/tool.ts:154、packages/core/src/session/compaction.ts:914。

### 15. 常量对象 `as const` + 映射类型
单位表 `DURATION_UNITS = { ms: 1, s: 1_000, ... } as const` 配 `keyof typeof` 拿到安全的键联合。实例：packages/core/src/session/compaction.ts:984-990。

## 二、Effect 核心技法（16-35）

### 16. Effect 是"惰性的程序描述"
`Effect` 不执行，只是描述；构建后交给 runtime 跑。这让重试/中断/超时成为可组合的一等公民。全仓库的基础范式，见 packages/core/src/tool.ts:84 起的 `Layer.effect`。

### 17. `Effect.gen` + `yield*` 依赖注入
生成器里 `yield* SomeService` 直接取依赖，代码长得像 async/await 但类型全程精确。实例：packages/core/src/session/runner/llm.ts:47-61。

### 18. `Context.Service` 声明服务标识
`class Service extends Context.Service<Service, Interface>()("@opencode/Tool")` 用类静态方法造出"类型安全的 DI 键"。实例：packages/core/src/tool.ts:82、runner/index.ts:44。

### 19. `Layer.effect` 装配实现
把"构造服务"写成 Effect，依赖在生成器里逐个 `yield*`，最终 `Service.of({...})` 返回实现。实例：packages/core/src/session/compaction.ts:253-956。

### 20. `Effect.fn` 带追踪的函数定义
`Effect.fn("SessionRunner.drain", { root: true })` 自动创建 span，`{root:true}` 开新追踪链路——观测性内建在函数定义里。实例：packages/core/src/session/runner/llm.ts:64。

### 21. `uninterruptibleMask` 定制中断窗口
屏蔽中断但用 `restore(...)` 精确开放可中断段：流处理可被打断，落库收尾不可。实例：packages/core/src/session/runner/step.ts:138-293。

### 22. fork 与 `Effect.forkScoped`
把慢工作（起始快照、工具执行、标题生成）fork 成 fiber 并发跑，作用域结束自动回收。实例：step.ts:74、shell.ts 通知 fiber（packages/core/src/tool/plugin/shell.ts:175）。

### 23. `FiberMap` 按 key 去重的并发
`FiberMap.make<SessionSchema.ID, ...>()` 保证"同一会话最多一个标题生成 fiber"。实例：packages/core/src/session/runner/llm.ts:61、199-201。

### 24. `Fiber.join/await/interrupt` 精确编排
`Fiber.join(pendingStartSnapshot)` 在需要时才等快照；`Fiber.interruptAll` 中断所有工具 fiber。实例：step.ts:115、94。

### 25. `Deferred` 一次性信箱
后台命令完成时 `Deferred.succeed(settled, output)`，前台 `Deferred.await(settled)` 取结果。实例：packages/core/src/tool/plugin/shell.ts:209-259。

### 26. `Ref` 原子计数
Code Mode 检查里为每次工具调用生成递增 ID。实例：`Ref.make(0)` + `Ref.getAndUpdate`（packages/core/src/tool.ts:342-356）。

### 27. Stream 消费两板斧
`Stream.runForEach`（逐事件处理，任一失败整体失败，step.ts:110-135）与 `Stream.runFoldEffect`（带状态折叠，compaction.ts:796-839）。

### 28. `Effect.exit` + `Exit` 结果化
把可能失败的 Effect 转成 `Exit` 数据，先检查再决定是否上抛（`Exit.isFailure`、`Exit.hasInterrupts`）。实例：step.ts:140-155。

### 29. `Cause` 分析错误树
`Cause.hasInterruptsOnly` 区分"用户取消"与真实错误、`Cause.squash` 还原异常、`Cause.isDieReason` 过滤崩溃。实例：llm.ts:165-167、step.ts:231、324-327。

### 30. `Effect.suspend` 惰性求值
`recoverOverflow: Effect.suspend(() => ...)`：只有真的溢出才构建压缩 Effect，避免每次都付构建成本。实例：packages/core/src/session/runner/llm.ts:307-313。

### 31. `Effect.orDie` 降级不可恢复错误
数据库查询失败属于"不可能/不可恢复"，`orDie` 把它变成 defect（Die）而非错误通道的负担。实例：llm.ts:356、compaction.ts:585。

### 32. `catchTag` 按标签捕获
`Effect.catchTag("Tool.Error", ...)` 只捕获指定标签的错误，其余照常传播。实例：step.ts:126-128。

### 33. `matchEffect` 成败分流
压缩结果成功走 `publish(result)`、失败走 `publish(failure)`，一个算子两条路。实例：packages/core/src/session/compaction.ts:330-335。

### 34. `Effect.ensuring` / `onInterrupt` 收尾
`ensuring(flush())` 保证流结束后必冲刷；`onInterrupt` 在被中断时清理 shell/广播失败。实例：step.ts:134、compaction.ts:946-951、shell.ts:224。

### 35. `Effect.promise` 包裹一次性异步
动态 import 模拟后端：`Effect.promise(() => import("@opencode/simulation/backend"))`。实例：packages/server/src/routes.ts:168。

## 三、Effect 平台与 HTTP 服务（36-45）

### 36. `HttpApi`/`HttpApiGroup` 声明式协议
端点用声明式 API 定义，OpenAPI 文档与 TS client 都从它生成。实例：packages/protocol/src/api.ts:2、39-45。

### 37. `HttpApiBuilder.layer` 一行挂路由
`HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" })` 自动暴露 OpenAPI。实例：packages/server/src/routes.ts:190。

### 38. 中间件分层（authorization/schema-error/location）
鉴权、schema 错误格式化、Location 归属都是独立 Layer，按需 provide。实例：routes.ts:191-197 与 packages/server/src/middleware/。

### 39. `HttpRouter.provideRequest` 请求级服务
给每个请求注入轻量服务子集（数据库、凭据、项目……），避免整棵依赖树进请求作用域。实例：routes.ts:177-188、198。

### 40. `Layer.provideMerge` 合并依赖
`provideMerge(services)` 既提供依赖又把其余服务保留在上下文里——组合 HTTP 层与业务层的惯用法。实例：routes.ts:199-200。

### 41. LayerNode：可替换的 Layer
`LayerNode.group(nodes)` + `node.replace(configured(options))` 让同一套服务在不同部署形态（独立 server/嵌入式/workerd）下替换实现。实例：packages/server/src/routes.ts:88、125-155。

### 42. `AppNodeBuilder.build` 构建依赖图
把服务节点数组 + 替换列表构建成完整 Context。实例：routes.ts:156-164（含"惰性自引用"技巧：私有实例继承完整宿主图）。

### 43. `makeLocationNode` 打包服务节点
每个 core 服务用它把 `service + layer + deps` 打包成 Node，server 侧才能按 Location 复制子树。实例：packages/core/src/session/runner/llm.ts:443-462。

### 44. 事件流（SSE/EventFeed）
领域事件经 Bus 发布，server 的 event-feed 把它们推给客户端订阅——所有 UI 实时一致的根源。实例：packages/server/src/event-feed.ts、packages/core/src/bus.ts。

### 45. 双形态入口：带密码与嵌入式
`createRoutes`（密码鉴权）与 `createEmbeddedRoutes`（无密码）复用同一个 `makeRoutes`。实例：packages/server/src/routes.ts:90-115。

## 四、Bun 运行时与工程化（46-55）

### 46. `Bun.file`/`Bun.write` 高速 IO
直接用 Bun 的文件 API 读写（仓库中 7 处 `Bun.file`、1 处 `Bun.write`），省去 fs 封装。实例：grep `Bun.file` 可见 packages/cli/src、packages/core/src。

### 47. `Bun.spawn` 起子进程
环境探测/脚本执行用 Bun 原生 spawn。实例：packages/cli/src 中的 `Bun.spawn`。

### 48. `Bun.sleep` 可中断延时
重试退避直接 `Bun.sleep`（Effect 里也有 `Effect.sleep`，两者按层选用）。实例：`Bun.sleep` 用法见 packages/cli/src。

### 49. `Bun.CryptoHasher` 做内容指纹
快照/缓存键用 CryptoHasher 计算 hash。实例：packages/cli/src 中的 `Bun.CryptoHasher`。

### 50. `Bun.stringWidth` 与终端宽度
TUI 对齐要算"显示宽度"（东亚字符占两列）。仓库同时用 Bun.stringWidth 与 `string-width`、`get-east-asian-width` 包（packages/tui/package.json）。

### 51. workspaces + catalog 统一版本
根 package.json 的 `workspaces.catalog` 把 effect/zod/@opentui 等版本定义一次，子包写 `"effect": "catalog:"`——Bun 版的 pnpm catalog。实例：根 package.json 与 packages/core/package.json:121。

### 52. `workspace:*` 内部依赖
包间引用用 `workspace:*`（如 packages/core/package.json:109-114），发布时才替换成真实版本。

### 53. turbo 编排跨包任务
`bun turbo typecheck --concurrency=3`（根 package.json scripts）用 Turborepo 做依赖感知的并行任务。

### 54. patches/ 目录给三方依赖打补丁
仓库根有 `patches/`，配合 Bun 的 patch 机制修上游 bug（类似 patch-package 的官方路径）。

### 55. 生命周期脚本做环境适配
`postinstall: bun run --cwd packages/core fix-node-pty`（根 package.json）——用 Bun 脚本在安装后修 node-pty 的平台问题。

## 五、zod 4 与 Schema 校验（56-65）

### 56. zod 4 定义跨端契约
packages/schema 用 zod 4.6.7 定义 session/tool/config/agent 契约，一处定义、client/server/存储共用（packages/schema/src/config.ts 等）。

### 57. Standard Schema 通用接口
工具入参接受任何 Standard Schema 实现（zod/ArkType/Effect Schema）——`typeof tool.input !== "object" && typeof tool.input !== "function"` 的判断就是为函数形态的 schema 留的。实例：packages/core/src/tool.ts:405-409 + `@standard-schema/spec` 依赖。

### 58. Effect Schema 的 `Schema.Struct` 定义工具入参
core 运行时用 Effect 自己的 Schema 模块：`Schema.String.annotate({ description })` 把描述直接写进 JSON Schema。实例：packages/core/src/tool/plugin/shell.ts:46-59。

### 59. `Schema.optionalKey` 区分"缺省键"
zod 的 `.optional()` 与 Effect Schema 的 `optionalKey` 都精确区分"键不存在"与"值为 undefined"，对 LLM 工具调用参数尤其重要。实例：shell.ts:48-58。

### 60. `Schema.TaggedError` 错误也走 Schema
`Schema.TaggedError<RegistrationError>()("Tool.RegistrationError", {...})` 让错误可序列化、可跨进程。实例：packages/core/src/tool.ts:22-25。

### 61. `Schema.decodeUnknownSync` 边界解码
不可信输入（如配置 JSON）在边界一次解码成强类型。实例：packages/core/src/provider.ts:39-40。

### 62. SchemaIssue 友好格式化
校验失败不直接 throw，而是用 `SchemaIssue.makeFormatterDefault()` 拼可读信息进 RegistrationError。实例：packages/core/src/tool.ts:386-391。

### 63. 编码兼容层：decodeEncoded
配置归一化用 `decodeEncoded(ConfigLSP.Info, input.lsp, ...)` 兼容老格式（v1 的布尔/编码配置）。实例：packages/core/src/config/normalize.ts:501-504。

### 64. "schema 一次转换"原则
工具注册时把入参 schema 一次性转成 provider 的 ToolDefinition 并缓存，运行期零转换。实例：packages/core/src/tool.ts:38-39 注释与 definitions Map。

### 65. 运行时校验的位置哲学
边界校验（配置、工具入参、wire 数据），内部流转信任类型——packages/schema 管 wire，Effect Schema 管运行时工具，两层不混用。

## 六、数据与持久化（66-73）

### 66. drizzle-orm 构建类型安全 SQL
`db.select({...}).from(SessionMessageTable).where(and(eq(...), inArray(...))).orderBy(desc(...)).limit(3)`——全类型化查询。实例：packages/core/src/session/runner/llm.ts:341-356。

### 67. `sql` 模板直写 JSON 路径查询
SQLite 的 `json_extract(data, '$.status')` 通过 drizzle 的 `sql` 模板嵌入，查询 JSON 字段不丢类型。实例：llm.ts:394、compaction.ts 未用表路径（消息表查询见 sql.ts）。

### 68. SQLite 双驱动（Bun/Node）
`@effect/sql-sqlite-bun` 与 `@effect/sql-sqlite-node` 都在依赖里（packages/core/package.json:100-101），按运行时选择驱动，一套代码双平台。

### 69. 事件溯源式的消息表
消息按 `seq` 单调递增追加（`.orderBy(desc(SessionMessageTable.seq))`，llm.ts:353），崩溃恢复靠"重放+结算"而非内存状态。

### 70. 版本化迁移层
`V1Migration`（packages/core/src/database/v1-migration.ts）与 API 层并行挂载（routes.ts:202），旧版本数据库原地升级。

### 71. immer 的 freeze 划定不可变边界
provider 解析结果用 `freeze`（immer）冻结，防止下游误改共享对象。实例：packages/core/src/provider.ts:16。

### 72. `JSON.parse(JSON.stringify(...))` 诚实深拷贝
provider metadata 可能含 `undefined`，schema 编码器会拒绝，所以原生压缩窗口用普通 JSON 深拷贝。实例：packages/core/src/session/compaction.ts:577-579。

### 73. 大对象出进程：blob 存储
超大工具输出不进消息表，走 blob 存储与"截断+落盘"（ToolOutput.truncate，packages/core/src/session/runner/step.ts:124；packages/core/src/session/blob.ts）。

## 七、TUI 与终端渲染（74-80）

### 74. 用 solid-js 写终端 UI
`@opentui/solid` 让 JSX 直接渲染到终端——TUI 与 Web 共享组件心智。实例：packages/tui/package.json 依赖与 packages/tui/src/routes/。

### 75. 语义化主题 token
"按语义角色选 token，而不是按颜色值"写进了根 AGENTS.md 的 TUI Theme Tokens 一节；`text.feedback`/`formfield`/`action` 等角色见 packages/tui/src/theme/。

### 76. 虚拟化长列表
`@tanstack/solid-virtual` 3.13.37（根 catalog）做会话消息的虚拟滚动——万条消息不掉帧。

### 77. 模糊搜索 fuzzysort
命令面板/文件跳转用 fuzzysort（packages/tui/package.json、packages/core/package.json:122）。

### 78. 宽字符与 ANSI 处理
`string-width` + `get-east-asian-width` + `strip-ansi`（packages/tui/package.json）三件套处理中文/emoji/颜色码的对齐问题。

### 79. 双运行时文件后缀
`editor-zed-sqlite.bun.ts` / `editor-zed-sqlite.node.ts`（packages/tui/src/）——Bun 与 Node 的实现按后缀自动切换，Bun 条件加载。

### 80. 共享会话 UI 层
packages/session-ui 把消息渲染、权限弹窗等做成 TUI/Web 复用组件（配合 packages/ui 基础库）。

## 八、协议、SDK 与 Monorepo 实践（81-90）

### 81. 协议→OpenAPI→client 的生成链
改 `HttpApi` 定义 → `/openapi.json` 自动暴露 → `bun run generate` 重新生成 packages/client——单向生成，禁止手改（CONTRIBUTING.md:72）。

### 82. 依赖方向即架构
AGENTS.md 规定 `Schema → Core/Protocol → Server`、Client 不依赖 Core/Server、sdk 做组合——用"依赖方向"表达分层，而非目录命名。

### 83. 每包一份 AGENTS.md
packages/*/AGENTS.md 给 agent 与人类 alike 的包级开发须知（如 packages/ai/AGENTS.md、packages/tui/AGENTS.md），仓库级与包级规则分层。

### 84. ast-grep 结构化 lint
`lint:effect-patterns`（根 package.json）用 ast-grep 扫 Effect 反模式——AST 级 lint 比正则 lint 可靠，规则在 script/ast-grep/。

### 85. `bunfig.toml` 与 `turbo.json` 分层配置
仓库根的 bunfig.toml（Bun 行为）与 turbo.json（任务编排）各司其职；包内还有自己的 bunfig（packages/app/bunfig.toml）。

### 86. 嵌入式 server：一个包三种宿主
`createEmbeddedRoutes` + workerd 替换（routes.ts:121 注释、packages/sdk/src/workerd.ts）让同一个 server 跑在 Node CLI、Electron 与 Cloudflare Workers 三种宿主里。

### 87. 语义化提交 + husky 钩子
`type(scope): summary` 约定（CONTRIBUTING.md:98-106）+ 根目录 `prepare: husky`——提交信息即 changelog 输入。

### 88. 分支策略写进 AGENTS.md
默认分支 `dev`、分支名最多三个单词且不用 `feat/` 前缀（根 AGENTS.md Branch Names 一节）——把协作约定文档化在仓库内。

### 89. PR 里的动画 SVG 规范
面向用户的 feat/fix/perf PR 要求 240×72、`currentColor`、<8KB 的动画 SVG（根 AGENTS.md Commits and PR Titles 一节）——用规范保证 UI 演示的一致性。

### 90. script/ 即工具箱
SDK 文档生成（script/sdk-docs.ts）、类型检查画像（script/profile-typecheck.ts）、打包（script/pack.ts）都进版本控制——构建工具链与代码同仓演进。

## 九、其他重要库（91-100）

### 91. diff 8.0.4 生成文件差异
edit/write 工具返回给模型的 diff 由 `diff` 库生成（packages/core/src/tool/plugin/file-diff.ts 配合 FileDiff Schema）。

### 92. @modelcontextprotocol/* 三件套
MCP 的 client/server/core 都在依赖里（packages/core/package.json:105-107），packages/core/src/mcp/ 是学习"外部进程 + JSON-RPC"的现成范本。

### 93. @lydell/node-pty + bun-pty 双 PTY
终端模拟用两个 PTY 实现按运行时切换（packages/core/package.json:104、118），配合 postinstall 修复脚本（第 55 条）。

### 94. @parcel/watcher 跨平台文件监听
fs.watch 的生产级替代（packages/core/package.json:115），装配开关见 packages/server/src/routes.ts:133-134。

### 95. @silvia-odwyer/photon-node 图像处理
工具输出图片的缩放/转码走 photon（packages/core/package.json:116），重活放独立进程（packages/cli/src/photon-worker.ts）避免阻塞事件循环。

### 96. gray-matter 解析 frontmatter
AGENTS.md/技能文件的 YAML 头部解析（packages/core/package.json:124）。

### 97. jsonc-parser 读带注释的 JSON
`opencode.jsonc` 支持注释全靠它（packages/core/package.json:130；文件名列表见 packages/core/src/config/discovery.ts:12）。

### 98. jose 处理 JWT/OIDC
GitHub 集成的 OIDC 令牌交换、控制台鉴权用 jose（packages/core/package.json:129）。

### 99. aws4fetch + google-auth-library 云厂商签名
packages/ai 只带这两个重依赖（packages/ai/package.json）做 Bedrock SIGv4 与 Vertex 认证——按需签名的轻量方案，不引入全家桶。

### 100. hono 4.13.13 做边缘路由
catalog 里的 hono 用于云端控制台/边缘场景（packages/console/* 的 Web 服务），与本体的 effect HttpApi 并存——按部署环境选 Web 框架。

---

## 结语

这份清单的共同主题：**用类型与运行时把"不可靠"关进笼子**（可辨识联合、Schema 校验、Effect 中断语义、事件溯源），**用生成与组合消灭重复**（协议→client、LayerNode 替换、catalog 版本），**让观测与恢复成为默认**（Effect.fn span、崩溃结算、Job recovery）。建议按 16-35（Effect）→ 1-15（TS 技法）→ 56-65（Schema）→ 81-90（工程）的顺序精读源码。
