// 引入技能（Skill）核心服务：可用技能清单
import { Skill } from "@opencode/core/skill"
// 引入 HTTP API 构建器
import { HttpApiBuilder } from "effect/http-api"
// 引入本服务 API 定义
import { Api } from "../api"
// 引入 response 辅助：响应中附带 location 信息
import { response } from "../location"

// 导出 SkillHandler：注册 "server.skill" 分组处理器
export const SkillHandler = HttpApiBuilder.group(Api, "server.skill", (handlers) =>
  // 处理 skill.list：在技能服务上下文中列出技能；响应附带 location 信息
  handlers.handle("skill.list", () => response(Skill.Service.use((skill) => skill.list()))),
)
