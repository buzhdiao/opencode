// 将本模块以命名空间方式重新导出为 SkillInstructions
export * as SkillInstructions from "./instructions.js"

// 导入辅助函数：把服务打包成位置（location）依赖注入节点
import { makeLocationNode } from "@opencode/util/effect/app-node"
// 导入 Effect 核心原语：Context 依赖注入、Effect 效果类型、Layer 服务层、Schema 数据建模
import { Context, Effect, Layer, Schema } from "effect"
// 导入权限（Permission）模块，用于按规则集过滤可用技能
import { Permission } from "../permission.js"
// 导入技能（Skill）服务
import { Skill } from "../skill.js"
// 导入系统提示词（Instructions）模块
import { Instructions } from "../instructions/index.js"

// 技能摘要（Summary）模式：id、名称、描述，用于注入系统提示词
const Summary = Schema.Struct({
  // 技能唯一标识
  id: Skill.ID,
  // 技能名称
  name: Skill.Name,
  // 技能描述
  description: Schema.String,
})
// 由 Schema 推导出的 Summary 静态类型
type Summary = typeof Summary.Type

// 把技能摘要列表渲染成 <skill> XML 条目行
const entries = (skills: ReadonlyArray<Summary>) =>
  skills.flatMap((skill) => [
    // 每个技能输出一个 <skill> 块
    "  <skill>",
    // 输出技能 id
    `    <id>${skill.id}</id>`,
    // 输出技能名称
    `    <name>${skill.name}</name>`,
    // 输出技能描述
    `    <description>${skill.description}</description>`,
    // 闭合 <skill> 块
    "  </skill>",
  ])

// 渲染完整的技能指引文本：先给出使用说明，再列出可用技能清单
const render = (skills: ReadonlyArray<Summary>) =>
  [
    // 说明技能（skill）的作用：为特定任务提供专门指令和工作流
    "Skills provide specialized instructions and workflows for specific tasks.",
    // 指示模型：任务匹配技能描述时用 skill 工具加载它
    "Use the skill tool to load a skill when a task matches its description.",
    // 说明用户可直接点名调用技能，此时内容会以 <skill_content> 块出现；已出现过的技能无需再次调用
    "The user may also invoke a skill directly. When that happens, its instructions appear in the conversation as a <skill_content> block, the same shape the skill tool returns. A skill that is already present this way does not need to be invoked again.",
    // 没有可用技能时输出提示；否则输出 <available_skills> 包裹的技能清单
    ...(skills.length === 0
      ? ["No skills are currently available."]
      : ["<available_skills>", ...entries(skills), "</available_skills>"]),
  ].join("\n")

// 构造技能清单的增量更新器：对比前后列表，生成“新增/变更/移除”的系统提示词片段
const update = Instructions.listUpdate<Summary>({
  // 以技能 id 作为对比键
  key: (skill) => skill.id,
  // 名称或描述任一变化即视为该技能已变更
  changed: (before, after) => before.name !== after.name || before.description !== after.description,
  // 复用上面的条目渲染
  entries,
  // 复用上面的整体渲染
  render,
  // 各场景下追加给模型的提示文案
  text: {
    // 整个清单被替换时的提示
    replaced: "The available skills have changed. This list supersedes the previous available skills list.",
    // 有新增技能时的提示
    added: "New skills are available in addition to those previously listed:",
    // 有技能变更时的提示（同 id 条目替换旧条目）
    changed: "The following skills have changed. Each entry replaces the previously listed skill with the same ID:",
    // 有技能被移除时的提示（列出失效的 id 并禁止使用）
    removed: (ids) => `The following skill IDs are no longer available and must not be used: ${ids}.`,
  },
})

// 服务接口定义：对外暴露的能力
export interface Interface {
  /** Lists skills the given ruleset does not deny; callers pass the merged agent and Session permissions. */
  // load：列出未被给定权限规则集（Ruleset）拒绝的技能，返回 Instructions 列表
  readonly load: (permissions: Permission.Ruleset) => Effect.Effect<Instructions.List>
}

// Effect 服务标签（Context.Tag）：依赖注入标识 "@opencode/SkillInstructions"
export class Service extends Context.Service<Service, Interface>()("@opencode/SkillInstructions") {}

// 构建 Service 的 Effect 层（Layer）
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 注入技能服务
    const skills = yield* Skill.Service

    // 返回服务实现
    return Service.of({
      // load：根据权限规则生成“技能指引”的 Instructions 条目
      load: Effect.fn("SkillInstructions.load")(function* (permissions) {
        // 取出技能列表，按权限过滤并整理成摘要数组
        const available = Skill.available(yield* skills.list(), permissions)
          // 过滤掉没有描述或明确关闭自动调用的技能
          .flatMap((skill) =>
            skill.description === undefined || skill.autoinvoke === false
              ? []
              : [{ id: skill.id, name: skill.name, description: skill.description }],
          )
          // 按技能 id 排序，保证输出顺序稳定
          .toSorted((a, b) => a.id.localeCompare(b.id))
        // 构造支持增量更新的 Instructions 条目
        return Instructions.make<ReadonlyArray<Summary>>({
          // 唯一键：core/skill-guidance
          key: Instructions.Key.make("core/skill-guidance"),
          // 摘要数组的 JSON 编解码器（codec），用于序列化对比
          codec: Schema.toCodecJson(Schema.Array(Summary)),
          // 当前读取结果：无可用技能时标记为 removed，否则返回摘要列表
          read: Effect.succeed(available.length === 0 ? Instructions.removed : available),
          // 渲染策略
          render: {
            // 首次出现时的整体渲染
            initial: render,
            // 清单变化时的增量更新文案
            changed: update,
            // 技能指引被移除时的提示
            removed: () => "Skill guidance is no longer available. Do not use any previously listed skill.",
          },
        })
      }),
    })
  }),
)

// 以位置节点形式导出服务，并声明依赖 Skill 节点
export const node = makeLocationNode({ service: Service, layer, deps: [Skill.node] })
