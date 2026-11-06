// 将本模块整体导出为 SessionEnvironment 命名空间
export * as SessionEnvironment from "./environment.js"

// 导入 effect 核心
import { Context, Effect, Layer } from "effect"
// 导入全局依赖注入节点构造工具
import { makeGlobalNode } from "@opencode/util/effect/app-node"
// 导入会话 schema 类型
import { SessionSchema } from "./schema.js"

// 环境变量集合类型：只读的字符串键值记录
export type Variables = Readonly<Record<string, string>>

// 服务接口：按会话 ID 读取、设置、清除环境变量
export interface Interface {
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<Variables | undefined>
  readonly set: (sessionID: SessionSchema.ID, variables: Variables) => Effect.Effect<void>
  readonly clear: (sessionID: SessionSchema.ID) => Effect.Effect<void>
}

// 声明 effect Context 服务标签（服务标识符）
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionEnvironment") {}

// 构建 Layer：内存中保存每个会话的环境变量
const layer = Layer.sync(Service, () => {
  // 会话 ID → 环境变量的内存映射
  const environments = new Map<SessionSchema.ID, Variables>()

  return Service.of({
    // 读取：返回该会话的环境变量（可能不存在）
    get: (sessionID) => Effect.sync(() => environments.get(sessionID)),
    // 设置：浅拷贝一份变量再存入，避免外部修改影响内部状态
    set: (sessionID, variables) =>
      Effect.sync(() => {
        environments.set(sessionID, { ...variables })
      }),
    // 清除：删除该会话的环境变量
    clear: (sessionID) =>
      Effect.sync(() => {
        environments.delete(sessionID)
      }),
  })
})

// 创建全局依赖注入节点：本服务无外部依赖
export const node = makeGlobalNode({ service: Service, layer, deps: [] })
