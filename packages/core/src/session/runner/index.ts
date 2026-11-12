// =====================================================================
// 文件角色：SessionRunner —— 会话执行器的“对外接口”文件。
// 它只定义类型与契约（drain 的输入/输出/错误），真正的排空逻辑在 ./llm.ts
// 的 Layer 实现里；其它模块（CLI、server、事件循环）只依赖本文件的
// Service 标识符，从而与实现细节解耦（依赖倒置）。
// =====================================================================
export * as SessionRunner from "./index.js"

// 以下全部是“类型导入”，运行时零开销：只为类型检查与文档服务。
import type { FileSystem } from "../../filesystem.js"
// AIError 是 packages/ai 里对 LLM 调用各类故障（网络、鉴权、限流…）的统一封装。
import type { AIError } from "@opencode/ai/effect"
// Effect 的 Context/Data 是构建依赖注入与可辨识联合的基石（见 doc_zh/components/02）。
import { Context, Data, Effect } from "effect"
// 会话相关的 zod/Schema 定义（ID 等基础类型）。
import { SessionSchema } from "../schema.js"
// Promotable：收件箱“待晋升输入”的种类（input / steer 等）。
import type { Promotable } from "../inbox.js"
// 三类会话级错误：找不到 agent、消息解码失败、步骤失败。
import type { AgentNotFoundError, MessageDecodeError, StepFailedError } from "../error.js"
// 模型解析子服务：把会话里配置的模型名解析成可调用的具体模型。
import { SessionRunnerModel } from "./model.js"
// 指令（AGENTS.md 等）加载模块，只用到其错误类型。
import type { Instructions } from "../../instructions/index.js"

// RunError：drain 一次可能失败的所有原因的联合类型。
// 用“类型即文档”的方式枚举错误，让调用方必须穷尽处理。
export type RunError =
  | AIError
  | SessionRunnerModel.Error
  | MessageDecodeError
  | AgentNotFoundError
  | StepFailedError
  | Instructions.InitializationBlocked
  | FileSystem.DirectoryNotFoundError

// Continuation：续跑句柄。进程崩溃/重启后凭 step 序号从历史继续执行。
export type Continuation = { readonly step: number }

// DrainResult：一次 drain（排空收件箱）的三种结局，Data.TaggedEnum 生成
// 可辨识联合 + 构造器 + 类型守卫（Complete/Moved/Reloaded）。
// - Complete：没有待处理输入，会话进入空闲。
// - Moved：会话被 move（转移）到别的 Location（比如切工作区），需要上层换目标续跑。
// - Reloaded：Location 正在关闭/重载，返回是否 force 与续跑信息。
export type DrainResult = Data.TaggedEnum<{
  Complete: {}
  Moved: { readonly continuation?: Continuation; readonly stepped?: true }
  Reloaded: { readonly force: boolean; readonly continuation?: Continuation; readonly stepped?: true }
}>
// 为该联合生成 $match、$is 等工具与 Companion 对象（Effect 惯用法）。
export const DrainResult = Data.taggedEnum<DrainResult>()

/** Runs one local continuation from already-recorded Session history. */
// 接口：只暴露一个 drain 方法——“从已落库的会话历史里跑一次本地续跑”。
// Effect.Effect<成功值, 错误> 的签名把失败也编码进类型。
export interface Interface {
  /** Drains eligible durable work, returning transient state when execution must continue at a new Location. */
  readonly drain: (input: {
    readonly sessionID: SessionSchema.ID
    readonly force: boolean
    readonly continuation?: Continuation
    /** "steer" settles the active intent without promoting queued next-turn work. */
    // promotable="steer"：只结算当前这轮意图，不把排队中的下一轮输入提前拉进来。
    readonly promotable?: Promotable
    /** The previous drain ran a step before handing off, so reaching idle still runs the idle hook. */
    // stepped：上一次 drain 已经跑过至少一步，因此即使本次直接空闲也要触发 idle 钩子。
    readonly stepped?: boolean
    /** Why the execution is being interrupted, once it is: `"user"` when someone stopped it. */
    readonly interruption?: () => "user" | "shutdown" | undefined
  }) => Effect.Effect<DrainResult, RunError>
}

// Effect 服务标识：字符串 "@opencode/SessionRunner" 是全局唯一的依赖键。
// Context.Service 让上层通过 yield* SessionRunner.Service 拿到 Interface 实现。
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRunner") {}
