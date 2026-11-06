// 将本模块以命名空间方式重新导出为 SkillTool
export * as SkillTool from "./skill.js"

// 导入插件上下文类型（Context）
import type { Context } from "@opencode/plugin/effect/plugin"
// 导入 Effect 化的工具失败类型（ToolFailure）
import { ToolFailure } from "@opencode/ai/effect"
// 导入 Effect 原语：Effect、Schema
import { Effect, Schema } from "effect"
// 导入文件系统工具服务
import { FSUtil } from "@opencode/util/fs-util"
// 导入技能（Skill）服务与工具
import { Skill } from "../../skill.js"
// 导入权限（Permission）服务
import { Permission } from "../../permission.js"

// 工具名
export const name = "skill"

// 工具的输入 Schema：技能 ID
export const Input = Schema.Struct({
  // 要加载的技能 ID（可用的技能或用户明确提到的技能）
  id: Skill.ID.annotate({ description: "The ID of an available skill or a skill explicitly referenced by the user" }),
})

// 工具的输出 Schema：名称、目录、内容输出
export const Output = Schema.Struct({
  // 技能名称
  name: Skill.Name,
  // 技能所在目录
  directory: Schema.String,
  // 技能的内容输出
  output: Schema.String,
})
// 工具描述：说明用途与 ID 约束
export const description = [
  "Load a specialized skill's instructions and resources into the current conversation when the task at hand matches its description.",
  "",
  "The skill ID must match an available skill or a skill explicitly referenced by the user.",
].join("\n")

// 输出转换直接复用 Skill 模块的实现
export const toModelOutput = Skill.toModelOutput

// 构造“无法加载技能”的工具失败
const unableToLoad = (name: string, error?: unknown) =>
  new ToolFailure({ message: `Unable to load skill ${name}`, error })

// 插件定义：注册 skill 工具
export const Plugin = {
  // 插件唯一标识
  id: "opencode.tool.skill",
  // 插件的 Effect 主体
  effect: Effect.fn("SkillTool.Plugin")(function* (ctx: Context) {
    // 注入文件系统工具服务
    const fs = yield* FSUtil.Service
    // 注入技能服务
    const skills = yield* Skill.Service
    // 注入权限服务
    const permission = yield* Permission.Service
    // 向工具注册中心注册 skill 工具
    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          // 工具名
          name,
          // 选项：不启用 codemode
          options: { codemode: false },
          // 工具描述
          description,
          // 输入/输出 Schema
          input: Input,
          output: Output,
          // 执行体：查技能、验权限、准备内容
          execute: (input, context) =>
            Effect.gen(function* () {
              // 按 ID 查找技能
              const skill = yield* skills.get(input.id)
              // 技能不存在：失败
              if (!skill) return yield* unableToLoad(input.id)
              // 加载流程（失败统一映射为“无法加载”）
              return yield* Effect.gen(function* () {
                // 断言技能访问权限
                yield* permission.assert({
                  action: name,
                  resources: [skill.id],
                  save: [skill.id],
                  ...Permission.invocation(context),
                })
                // 取技能附带的文件集合
                const files = yield* skills.files(skill.id)
                // 返回名称与准备好的内容（含目录与输出文本）
                return { name: skill.name, ...(yield* Skill.prepare(fs, skill, files)) }
              }).pipe(Effect.mapError((error) => unableToLoad(input.id, error)))
            }).pipe(
              // 成功后组织工具返回：输出 + 内容 + 元数据
              Effect.map((output) => ({
                output,
                content: output.output,
                metadata: { name: output.name, directory: output.directory },
              })),
            ),
        }),
      )
      // 注册出错则直接中断
      .pipe(Effect.orDie)
  }),
}
