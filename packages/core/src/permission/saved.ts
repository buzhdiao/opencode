// 以命名空间方式整体导出本模块
export * as PermissionSaved from "./saved.js"

// 引入 drizzle-orm 的等值比较条件构造器（用于 where 子句）
import { eq } from "drizzle-orm"
// 引入 Effect 核心模块：Cause（错误原因）、Context（服务上下文）、DateTime（时间）、Effect（副作用容器）、Layer（依赖注入层）、Schema（校验）
import { Cause, Context, DateTime, Effect, Layer, Schema } from "effect"
// 引入 SQL 错误类型判断工具
import { isSqlError } from "effect/sql/SqlError"
// 引入 drizzle 在 Effect 下的查询错误类型（仅类型引用）
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core/errors"
// 引入项目 ID 类型（仅类型引用）
import type { Project } from "@opencode/schema/project"
// 引入数据库服务（提供 drizzle 实例）
import { Database } from "../database/database.js"
// 引入"全局单例节点"构造工具
import { makeGlobalNode } from "@opencode/util/effect/app-node"
// 引入权限表（PermissionTable）的数据库定义
import { PermissionTable } from "./sql.js"
// 引入"已保存权限"（PermissionSaved）的 schema 定义
import { PermissionSaved } from "@opencode/schema/permission-saved"

// 已保存权限的 ID schema（复用 schema 包中的定义）
export const ID = PermissionSaved.ID
// ID 的 TypeScript 类型
export type ID = typeof ID.Type

// 已保存权限的信息 schema
export const Info = PermissionSaved.Info
// Info 的 TypeScript 类型
export type Info = typeof Info.Type

// 列表查询的入参接口
export interface ListInput {
  // 可选：按项目 ID 过滤
  readonly projectID?: Project.ID
}

// 新增已保存权限的入参接口
export interface AddInput {
  // 所属项目 ID
  readonly projectID: Project.ID
  // 权限动作（如 bash、edit）
  readonly action: string
  // 资源列表（如命令模式、文件路径）
  readonly resources: readonly string[]
}

// 更新已保存权限的入参接口
export interface UpdateInput {
  // 目标记录 ID
  readonly id: ID
  // 可选：新的动作
  readonly action?: string
  // 可选：新的资源
  readonly resource?: string
}

// 未找到错误：指定 ID 的已保存权限不存在
export class NotFoundError extends Schema.TaggedError<NotFoundError>()("PermissionSaved.NotFoundError", {
  id: ID,
}) {}

// 冲突错误：更新后的 (action, resource) 与同项目内另一条已保存权限重复
export class ConflictError extends Schema.TaggedError<ConflictError>()("PermissionSaved.ConflictError", {
  id: ID,
  action: Schema.String,
  resource: Schema.String,
}) {}

// 服务接口：定义 list / add / update / remove 四个操作及其 Effect 签名
export interface Interface {
  readonly list: (input?: ListInput) => Effect.Effect<ReadonlyArray<Info>>
  readonly add: (input: AddInput) => Effect.Effect<void>
  readonly update: (input: UpdateInput) => Effect.Effect<Info, NotFoundError | ConflictError>
  readonly remove: (id: ID) => Effect.Effect<void>
}

// Effect 服务类：以 Context.Tag 标识为 "@opencode/PermissionSaved"，承载上面的接口
export class Service extends Context.Service<Service, Interface>()("@opencode/PermissionSaved") {}

// 构建服务实现层（Layer）：注入数据库服务并提供四个操作的实现
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 从数据库服务中取出 drizzle 数据库实例
    const db = (yield* Database.Service).db

    // list：查询已保存权限，可按项目 ID 过滤
    const list = Effect.fnUntraced(function* (input?: ListInput) {
      // 执行查询：未提供 projectID 时不加 where 条件；查询失败直接 die（视为不可恢复）
      const rows = yield* db
        .select()
        .from(PermissionTable)
        .where(input?.projectID ? eq(PermissionTable.project_id, input.projectID) : undefined)
        .all()
        .pipe(Effect.orDie)
      // 把数据库行转换为 Info 结构返回
      return rows.map(info)
    })

    // add：为项目批量新增"动作 + 资源"的已保存权限
    const add = Effect.fn("PermissionSaved.add")(function* (input: AddInput) {
      // 资源列表为空时无事可做
      if (!input.resources.length) return
      // 逐个资源生成一行并批量插入；唯一键冲突时跳过（保证幂等）
      yield* db
        .insert(PermissionTable)
        .values(
          input.resources.map((resource) => ({
            id: ID.create(),
            project_id: input.projectID,
            action: input.action,
            resource,
          })),
        )
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
    })

    // update：按 ID 更新动作/资源；未提供的字段沿用当前值
    const update = Effect.fn("PermissionSaved.update")(function* (input: UpdateInput) {
      // 先按 ID 查询当前记录
      const current = yield* db
        .select()
        .from(PermissionTable)
        .where(eq(PermissionTable.id, input.id))
        .get()
        .pipe(Effect.orDie)
      // 记录不存在则抛出未找到错误
      if (!current) return yield* new NotFoundError({ id: input.id })
      // 计算新的动作：入参优先，否则沿用当前值
      const action = input.action ?? current.action
      // 计算新的资源：入参优先，否则沿用当前值
      const resource = input.resource ?? current.resource
      // The unique index rejects an edit that duplicates another saved permission in the project.
      // 执行更新；若与同项目内另一条记录重复，唯一索引会拒绝该修改
      const updated = yield* db
        .update(PermissionTable)
        .set({ action, resource })
        .where(eq(PermissionTable.id, input.id))
        .returning()
        .get()
        .pipe(
          // 唯一约束冲突时转为 ConflictError（带最终的 action/resource）
          Effect.catchIf(isUniqueViolation, () => new ConflictError({ id: input.id, action, resource })),
          // 其他 drizzle 查询错误直接 die（不可恢复）
          Effect.catchTag("EffectDrizzleQueryError", (error) => Effect.die(error)),
        )
      // 更新未返回行说明记录在期间消失，按未找到处理
      if (!updated) return yield* new NotFoundError({ id: input.id })
      // 返回更新后的 Info
      return info(updated)
    })

    // remove：按 ID 删除已保存权限
    const remove = Effect.fn("PermissionSaved.remove")(function* (id: ID) {
      // 执行删除；失败直接 die
      yield* db.delete(PermissionTable).where(eq(PermissionTable.id, id)).run().pipe(Effect.orDie)
    })

    // 用上述实现组装服务实例
    return Service.of({ list, add, update, remove })
  }),
)

// Durable Object SQLite throws a plain Error without SQLite codes, so its unique violation is only in the message.
// 判断错误是否为"唯一约束冲突"（unique violation）；不同运行时抛出的形态不同，需要两种方式都识别
const isUniqueViolation = (error: EffectDrizzleQueryError) => {
  // 从 Effect 错误的 cause 中解出原始错误（是 Cause 则展开，否则原样使用）
  const sql = Cause.isCause(error.cause) ? Cause.squash(error.cause) : error.cause
  // 不是 SQL 错误则肯定不是唯一冲突
  if (!isSqlError(sql)) return false
  return (
    // 标准路径：reason 直接标记为 UniqueViolation
    sql.reason._tag === "UniqueViolation" ||
    // 兜底路径：Durable Object SQLite 抛的是普通 Error，只能在消息里找 SQLite 唯一约束码
    (sql.reason.cause instanceof Error && sql.reason.cause.message.includes("SQLITE_CONSTRAINT_UNIQUE"))
  )
}

// 把数据库行转换为 Info：字段重命名并解析时间戳
const info = (row: typeof PermissionTable.$inferSelect): Info => ({
  id: row.id,
  projectID: row.project_id,
  action: row.action,
  resource: row.resource,
  time: {
    // 创建时间（makeUnsafe：信任数据库中的时间戳格式）
    created: DateTime.makeUnsafe(row.time_created),
    // 更新时间
    updated: DateTime.makeUnsafe(row.time_updated),
  },
})

// 导出全局单例节点：依赖数据库节点，供应用装配时使用
export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
