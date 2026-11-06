// 将本模块以命名空间形式整体导出为 SessionSkill
export * as SessionSkill from "./skill.js"

// 会话信息类型
import type { Session } from "@opencode/schema/session"
// effect：Effect 运行时
import { Effect } from "effect"
// 实例服务：为会话所在实例提供依赖
import { Instance } from "../instance/service.js"
// 插件服务：等待插件激活
import { Plugin } from "../plugin/service.js"
// 技能（Skill）服务
import { Skill } from "../skill.js"
// 技能未找到错误
import { SkillNotFoundError } from "./error.js"

// 获取会话上下文中的某个技能；不存在则报错
export const get = Effect.fn("SessionSkill.get")(function* (input: { session: Session.Info; skill: Skill.ID }) {
  // 获取实例服务
  const instances = yield* Instance.Service
  // 等待插件激活后取得技能服务，并以会话所在实例提供依赖
  const skills = yield* Plugin.awaitActivation.pipe(Effect.andThen(Skill.Service), instances.provide(input.session))
  // 按 ID 查询技能
  const skill = yield* skills.get(input.skill)
  // 技能不存在则抛出专用错误
  if (!skill) return yield* new SkillNotFoundError({ skill: input.skill })
  // 返回技能详情
  return skill
})
