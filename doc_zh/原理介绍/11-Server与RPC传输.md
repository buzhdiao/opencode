# 第十一章 · Server 与 RPC 传输

## 11.1 协议即代码：从 HttpApi 声明到客户端生成

第二章说过 client 是生成物，本章展开"协议即代码"的完整闭环。起点是 packages/protocol/src/api.ts：全部公开端点用 effect 的 HttpApi 与 HttpApiGroup 声明——每个端点声明它的路径、方法、输入 schema、成功 schema、错误 schema，端点按领域分组（Agent、Plugin、Model、Provider、Integration、WebSearch 等组，api.ts:39-45 可见分组与 Location 级中间件的组合）。声明式的直接产出之一是 /openapi.json：HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" })（routes.ts:190-201 的装配行）让 OpenAPI 文档自动生成，永远与契约一致——不存在"文档忘了更新"这个bug 类别。

这个设计消除了三类经典接缝缺陷。其一，**路由手写的拼写漂移**：路径不再是字符串拼接，而是类型化声明。其二，**类型与实现脱节**：handler 的输入输出类型由契约约束，返回不合 schema 的值是编译期错误。其三，**客户端滞后**：packages/client 全部由 httpapi-codegen 从契约生成（CONTRIBUTING.md:72：改协议后必须运行生成命令，禁止手改生成物），前端的调用面与 server 的实现面共享同一 schema 来源（第二章 2.3 的 schema 先行在传输层的兑现）。

端点实现按领域拆在 packages/server/src/handlers/：session、message、event、config、provider、model、agent、permission、mcp、fs、shell、pty、persistent-pty、pty-socket、vcs、worktree、project、skill、command、form、media、artifact、reference、generate、schedule、job、usage、credential、integration、websearch、voice、migration、debug、server 等三十余个 handler 文件，handlers.ts 汇总导出。一个 handler 对应一类领域资源，内部调用 core 服务的 Effect 接口——handler 是薄适配层，业务全部在 core（第二章分层纪律在传输层的体现）。

## 11.2 MakeRoutes：一张依赖图的装配现场

packages/server/src/routes.ts 是全仓库最重要的装配现场。makeRoutes（routes.ts:117-205）做的事情按序是：列出 applicationServiceNodes——约二十九个应用级服务节点（routes.ts:57-88），包括 Database、Bus、EventLogger、FileSystemSearch、Credential、Config、PermissionSaved、PtyTicket、PersistentPty、Project、Worktree、Session、Instance、SessionTransfer、InstructionEntry、ShellSelect、Job、KV、Mcp、InstructionDiscovery、LocationServiceMap、LocationActivity、ModelsDev、ConsoleAccess、SessionRestart、Schedule、PluginUpdate、SdkPlugins、WellKnown、Workspace、Watcher、FileWatch 等——这份清单本身就是系统的"器官总表"；然后 AppNodeBuilder.build（routes.ts:117-164）按部署选项替换实现（数据库路径、PTY 实现、事件持久化、文件监听、MCP clientInfo 等，125-155 行的替换清单），simulation 模式还能动态换上模拟后端（165-173 行，第十四章测试体系的钩子）；最后 HttpApiBuilder.layer 挂载 handlers 与中间件链。

装配层存在的意义值得强调：core 的服务是"零件"（Layer），server 是"总装车间"（把零件按订单组装成整机）。同一批零件可以组装出独立服务器、嵌入桌面应用、跑进 workerd、跑进测试模拟器四种整机——**装配的多样性不增加 core 的复杂性**，这是"组合优于配置"在架构尺度的应用。也让"新形态"（例如未来的远程协作服务）的接入路径清晰：写一套 replacements，复用全部零件。

## 11.3 两种 server 形态与中间件链

createRoutes（routes.ts:90-103）是独立服务器形态：CLI 后台服务，带密码鉴权（ServerAuth.Config）。createEmbeddedRoutes（routes.ts:109-115）是嵌入式形态：桌面/TUI 内嵌进程内 server，无密码（进程内通信天然可信）。两者共用 makeRoutes——**同一张依赖图，两种门禁**。workerd.ts 是第三形态的伏笔：server 可跑进 Cloudflare workerd（packages/sdk 的 workerd.ts 配合，第二章提到的三套 SQLite 后端在此闭环）。

中间件链挂在 HttpApi 装配上，各层职责单一：authorizationLayer（middleware/authorization.ts）做连接鉴权；schemaErrorLayer（middleware/schema-error.ts）把 schema 校验错误统一成协议错误格式（前端拿到的错误结构永远一致）；formLocationLayer 与 sessionLocationLayer（middleware/form-location.ts、session-location.ts）把请求归属到正确的 Location——第二章 Location 模型在请求路径上的落实：每个请求进来先确定"你是哪个目录实例的事"；CorsConfig（cors.ts）管跨域。鉴权细节在 11.6 展开。

## 11.4 事件面：Bus 到浏览器的一条流

第二章讲过信息流的广播结构，本章看它的传输实现。core 的 Bus 事件（第四章：落库、按聚合排序、支持回放）经 server/src/event-feed.ts 暴露为订阅端点：客户端建立 SSE 或 WebSocket 连接，声明自己最后看到的序列号，feed 先从库里补发缺口再接续实时流（Bus 的 log/replay 能力的直接暴露）。这个"先补历史再续实时"的语义是三端一致的最后一块拼图：TUI 重连、桌面从休眠恢复、浏览器刷新页面，都能无损回到事件的完整时间线——订阅者的任意时刻接入性与第四章 4.4 的论证吻合。

事件流的传输选择（SSE 与 WS）各有利弊：SSE 单向但穿透性好、自动重连语义简单；WS 双向但连接管理复杂。OpenCode 的权限弹窗、表单交互等"server 向客户端要输入"的场景靠事件流加回传端点的组合（事件通知 + 常规 POST 回复），而不是依赖 WS 的双向性——**让双向交互退化成单向流加请求**，客户端实现的复杂度显著下降（生成式 client 只需要订阅与请求两类能力）。

## 11.5 鉴权、配对与运维面

独立服务器的鉴权（ServerAuth，auth.ts）有两个形态：配置了密码则要密码，否则无鉴权层。密码从哪来？CLI 管理服务生命周期（packages/cli），密码可以由用户设置，也可以走**配对流**（server/src/pairing.ts 的 ServerPairing）：新客户端（比如用户在另一台终端启动的 TUI）连接已有服务时，通过配对确认（人类在两端确认同一码）建立信任——这是"本地服务、多方连接"场景的经典信任建立模式，避免密码在命令行参数里明传。request-tracing.ts 给请求加追踪标识（跨 handler 的日志串联）；service-status.ts 与 server-info.ts 提供服务状态与信息的查询面（opencode service status / get password 这类命令的后端，根 AGENTS.md 的 Live TUI Testing 一节描述了 TUI 开发时如何用它们直连已装服务）；process.ts 管理 server 自身的进程事务。

区分两层鉴权再强调一次：本节是"client 连 server"的门禁（ServerAuth）；第七章是"引擎连 provider"的凭据（Credential）。前者在 server 层，后者在 core 层，凭据永远不经过 client 侧——客户端请求"跑一个会话"，不需要也不可能拿到 API key。

## 11.6 client：生成物的形态

packages/client 是 httpapi-codegen 的产物，结构镜像契约：每个分组一个命名空间、每个端点一个类型化方法（输入、输出、错误全部类型化）。生成器（packages/httpapi-codegen/src/index.ts）的头部注释概括了它的五个发射器与关键设计，第十四章详述，这里只点传输相关的两条：emitPromise 生成零依赖的 Promise 风格客户端（types/client-error/client/index——给不用 Effect 的生态用）；命名空间迁移生成 deprecated 别名保兼容（端点改名后旧调用不断）。client 的"勿手改"纪律靠生成清单文件执行：清单记录上次产物，重新生成时清理过期文件——生成物的整洁由工具保证而不是靠人记忆。

## 11.7 SDK：把内核变成库

packages/sdk 是"以库的形态使用 OpenCode"的门面（AGENTS.md 的依赖方向注明：sdk 组合 client、core 与 server）。sdk/src 的结构：opencode.ts 主入口（创建或连接 server，暴露类型化 API——嵌入式 server 随库启动，或连接独立 server）；workerd.ts（workerd 形态的装配）；effect/ 与 promise.ts（Effect 与 Promise 双风格 API——深度用户拿 Effect 组合，普通用户拿 Promise 直调）；tool.ts（SDK 侧自定义工具的定义辅助——宿主程序可以给 agent 注入自己的工具，工具执行发生在宿主里，通过 RPC 桥进会话）。SDK 的存在把 OpenCode 从"产品"升维成"平台"：别的工具可以把 OpenCode 内嵌为 agent 引擎（VS Code 插件 sdks/vscode、GitHub Actions 集成 doc_zh/components/07 都是这种嵌入的实例）。

与 SDK 密切相关的还有 core/src/rpc.ts 的 Rpc 服务：接口四个动词——register（注册 RPC 定义及处理器）、client（按定义构造类型化客户端）、call（按 ID 与方法直接调用）、close。它服务的是**宿主与插件/SDK 进程之间的双向 RPC**（RpcClient、RpcDomain 类型来自 @opencode/plugin/effect/rpc），事件与失败都有类型（EventPayload、Failure；DeclaredError 让处理器抛带类型标签的业务错误）。HTTP API 面向"前端控制 server"，RPC 面向"进程协作"——两套机制语义不同，不互相替代。

## 11.8 一次端到端调用的协议视图

以"用户在 Web 端批准一个权限请求"串起本章：Web 的 client（生成物）订阅事件流（event-feed）收到 Permission.Request 事件（第八章：权限请求是一等事件）→ 渲染批准界面（diff 预览）→ 用户点击 allow → client 调用 permission 相关端点（HttpApi 声明、authorizationLayer 验证、sessionLocationLayer 归属 Location）→ handler 调 core 的 Permission 服务 → assert 的 ask 分支收到回复 → 工具继续执行 → 后续事件经 Bus 广播回三端。整个链路里 Web 端没有写过一行协议代码——它调用的方法、拿到的事件类型全部来自生成物；server 端没有写过一行路由解析——handler 的签名由契约约束。**协议的每一字节都有单一出处**，这是本章开头的承诺在真实调用里的兑现。

## 11.9 端点组全景与 Location 归属的中间件语义

api.ts 的分组给了一个"系统面积"的俯视图，把分组与代表端点整理成表（分组名来自 protocol/src/api.ts:39-45 的组合与 handlers/ 的领域文件）：

| 领域 | 典型端点职责 | 对应 handler |
| --- | --- | --- |
| 会话与消息 | 创建/列表/发送/停止、子代理 | session.ts、message.ts |
| 事件流 | 订阅、回放 | event.ts、event-feed.ts |
| 工具与权限 | 工具目录、权限请求回复 | permission.ts |
| 模型与 Provider | 目录、解析、凭据 | model.ts、provider.ts、credential.ts |
| 配置与指令 | 读取、归一化视图 | config.ts |
| 文件与终端 | fs、shell、pty、persistent-pty | fs.ts、shell.ts、pty*.ts |
| 版本控制 | 状态、分支、worktree | vcs.ts、worktree.ts |
| 扩展 | MCP、插件、技能、命令 | mcp.ts、plugin.ts、skill.ts、command.ts |
| 系统 | server 信息、配对、迁移、调试 | server.ts、pairing.ts、migration.ts、debug.ts |

Location 归属中间件（sessionLocationLayer、formLocationLayer）的语义值得精确化：请求头或路径携带 Location 标识，中间件解析后把"本次请求该用哪棵服务子树"写入请求上下文，handler 从上下文取 Location 再向 LocationServiceMap 取服务实例。归属失败的请求（指向不存在的 Location）在中间件层就被拒绝——不进业务代码。这个设计让"多目录并存"在传输层就有了硬边界：A 目录的会话请求永远落不到 B 目录的服务实例上，隔离性不依赖业务代码的自觉。与第二章的两级服务树对照：HTTP 层的 Location 归属是树寻址的入口，之后整个调用链都在选定的子树里进行——**请求进子树，如同进程进沙箱**。

## 11.10 嵌入形态的两种用法：随库启动与连接远端

SDK 的两种用法对应两种部署拓扑。**用法一：随库启动（embedded）**。宿主程序 import SDK，createOpencodeClient 内部启动嵌入式 server（createEmbeddedRoutes 的无密码形态），一切在同一进程或本机子进程里——VS Code 插件、桌面应用的典型用法；数据（SQLite、快照）落在宿主指定的目录。**用法二：连接远端（remote）**。宿主连接一个已运行的独立 server（opencode serve 或用户常驻的后台服务）——CI 集成、多端协同的用法；连接走 ServerAuth（密码或配对，11.5）。两种用法共享同一 client API（生成物不变，只是 server 地址与凭据不同），这让"本机开发、CI 验证"的代码可以同构。workerd 形态是第三种部署的入口：server 打包进 Cloudflare worker（packages/sdk/src/workerd.ts），数据库换 sqlite.workerd.ts 后端——边缘部署的可用性依赖第四章 4.1 的三运行时绑定，依赖链在这里闭环。三种形态归纳成一句话：**内核在哪儿跑、数据库在哪儿落、客户端从哪儿连，三个坐标独立可选**——这是分层架构给出的部署自由度，也是"嵌入式优先"产品路线的架构保障。

## 11.12 错误面：协议错误的统一形态

前端要处理的错误有两类来源：传输层错误（网络断、超时——client 与 event-feed 的重连逻辑管）与业务错误（端点执行失败——本节的统一形态管）。业务错误的形状由 schemaErrorLayer 与 HttpApi 的错误声明共同决定：每个端点在契约里声明自己的错误集（类型化错误，第二章 2.4 的"类型化错误通道"在传输层的出口），中间件保证任何未声明错误也以统一结构呈现（不裸奔堆栈）；schema 校验失败（前端发了不合契约的输入）有专门的错误形态（middleware/schema-error.ts 的职责）。统一形态的消费端体验：TUI 的 dialog-error-details 与 error-component 渲染协议错误（12.6 的调试面），SDK 的 Promise 风格客户端把错误映射为语言级异常，Effect 风格客户端保持类型化错误通道。错误面的设计原则可以概括为**"错误也是契约"**：哪些错误可能出现、什么形态出现、怎么映射到用户语言，全部在协议层声明——与成功路径同等对待。这继承自第二章 schema 先行的哲学：契约覆盖全部分支，而不只是 happy path。有一个对比可以帮助理解：很多 API 的错误是"字符串加状态码"，前端拿到后自行猜测语义；类型化错误把语义前移到协议（错误类型是 schema），前端的分支处理由类型系统穷尽检查——错误处理的完备性从纪律问题变成编译问题。

## 11.13 协议演进：版本化与兼容策略

协议一定会演进（加端点、改字段），演进策略决定客户端生态的痛苦程度。OpenCode 的策略由三个机制构成。其一，**生成别名保兼容**（httpapi-codegen 的 namespace/aliases——端点改名或搬家后旧符号以 deprecated 别名继续存在，第十四章 14.4）；其二，**schema 的加载期迁移**（config normalize 的版本迁移思想同样适用于数据结构——老客户端发的老格式由归一化层接住，第九章 9.2）；其三，**事件的结构化版本**（SessionLegacy 的存在——bus.ts 导入——显示事件定义有 legacy 形态的兼容通道，老事件结构在过渡期仍可被解码）。三者合成的演进规则：**加字段自由、改语义要走迁移、删符号留别名**。这与数据库迁移（第四章）构成对称：库结构演进有 migration/，协议演进有 codegen 别名与 schema 兼容——两个演进面都有工程化的载体而不是靠口头纪律。客户端侧的策略补充：client 是生成物，用户升级 client 与升级 server 可以不同步（别名与兼容通道保证交错版本可用），CONTRIBUTING 的"改协议必须重新生成"是对开发者的纪律，对最终用户则完全透明。协议演进策略的验收标准只有一条：**任一版本的 client 连任一近期版本的 server，要么正常工作，要么得到明确的版本错误**——绝不允许静默错解。

## 11.15 传输层的安全与健壮性清单

传输层面向网络，安全与健壮性的清单值得系统列出（多数条目在前面章节出现过，这里收拢成面）。**鉴权面**：独立形态的密码鉴权与配对流（11.5），嵌入式形态的进程内信任（11.3）——两种形态的门禁差异本身就是安全设计（进程间要有门，进程内可以无门）。**凭据隔离**：provider 凭据不进 client 侧（11.5 的两层鉴权区分），传输层永远不转发凭据。**输入面**：一切输入过 schema（HttpApi 契约的校验——schemaErrorLayer 兜底格式化），Location 归属在中间件硬边界（11.9 的"请求进子树如同进沙箱"）。**事件面**：订阅按序列号回放（11.4），跨 Location 的事件隔离（Bus 按聚合分轨——A 目录的事件不进 B 目录的订阅）。**资源面**：请求的并发与超时有 Effect 原语兜底，长连接（事件流）的断线重连是常态路径而非异常路径（reconnecting 组件与重放协议，12.2）。**观测面**：request-tracing 的标识串联（16.2）让网络面的问题可归因。清单的验收方式也值得明确：传输层的安全性质多数可以写成测试（鉴权中间件的行为、归属失败的拒绝、错误格式的统一——server/test 的覆盖范围），这与第八章的立场一致：**安全性质要么可测试，要么等于没有**。

## 11.17 公开 API 面的设计评审要点

给"评审公开 API 设计"一个可操作的要点清单（以 OpenCode 的端点面为参照系）。**要点一：资源建模优先于动作建模**——11.9 的端点表按领域资源组织（会话、消息、权限、模型……），每个资源上的操作是有限的动词集合，而不是"什么都用一个 execute 端点"；资源建模让缓存、鉴权、归属（Location 中间件）都能按资源挂载。**要点二：错误即契约**（11.12）——每个端点声明的错误集就是它的"另一份文档"，评审时逐个问：这个失败模式客户端怎么处理？没有答案的错误不该存在。**要点三：事件与查询的一致性**——同一状态既可以从端点查（快照）也可以从事件流推（4.9 的投影），两者的字段必须同源（schema），否则"查到的"与"推到的"漂移。**要点四：分页与游标的显式化**——会话消息这类无限增长的资源必须有游标语义（第四章的消息游标），没有游标的列表端点是延迟炸弹。**要点五：幂等性与重放安全**——事件订阅的补发语义意味着客户端会重复收到事件（重连场景），幂等消费由客户端的投影纯函数保证（4.9），API 侧的写操作则要自声明幂等性。**要点六：生成友好性**——API 面要经得起 codegen（14.4 的可移植性判定与命名推导），过度动态的路径（嵌字符串的路由参数语义）会让生成物质量下降。六个要点综合起来检验的是一个标准：**公开 API 是系统的"人机界面"之二（另一个是 UI），它的评审严格度应当与 UI 同级**——OpenCode 的 HttpApi 声明加 codegen 加 schema 校验的三件套，正是把这种严格度工程化的手段。

## 11.19 多客户端并发：同一会话的多端一致性

多端同时看一个会话（TUI 与 Web 同时开着）引出传输层的一致性细节。**读一致性**：任何端读会话状态都走同一投影路径（回放加实时，4.9），因此读到的序列一致——差异只在延迟（各自的网络路径）。**写一致性**：多个端同时发输入，收件箱的事件溯源保证追加安全（4.3），run-coordinator 保证单 drain（3.7）——写入不丢、不重、不乱序。**交互一致性**：权限请求是事件（8.4），任一端批准后回复经 API 回传（11.8 的链路），其他端通过权限状态事件同步——"谁批准的"在事件里有来源，审计可查。** UX 层面的体验一致**：三端消费同一事件流意味着"画面语义"一致（12 章的投影同构），但交互形态可以各自优化（终端键盘流、桌面鼠标流）——**数据层强一致，表现层自由**。多客户端并发的边界情形也值得点名：同一端断线重连期间的写操作（另一端在动）——回放协议的补发保证重连端追上（4.9 的无缺口），期间它发的新输入照常入箱（写入不依赖读进度）——读进度与写进度解耦，这是事件溯源的又一红利。多客户端一致性在传输层的实现成本出乎意料地低：因为一致性在存储层（第四章）与循环层（第三章）已经做完，传输层只是 faithfully 转发——**一致性是架构性质，不是传输技巧**。

## 11.20 本章小结

传输层的四个关键决策：协议即代码（HttpApi 声明、OpenAPI 与 client 双生成）、装配即图（applicationServiceNodes 与 AppNodeBuilder 的零件-总装分离）、两种门禁一种图（独立/嵌入式共用 makeRoutes）、事件先落库再广播（event-feed 的补历史续实时）。加上 SDK 与 RPC 的进程协作面，OpenCode 的"可编程性"覆盖三个层级：HTTP API（跨语言跨进程）、SDK（同进程嵌入）、RPC（宿主与插件的双向通道）。下一章回到用户看得见的地方：终端界面——所有这些机制最终呈现成的那个交互面。
