// 将本模块以命名空间（namespace）形式整体导出；Worktree 表示 git 工作树（worktree）管理
export * as Worktree from "./worktree.js"

// 导入 Effect 核心工具：Context、Effect、Layer、Schema
import { Context, Effect, Layer, Schema } from "effect"
// 导入 drizzle-orm 的查询构造函数：and（与）、asc（升序）、desc（降序）、eq（等于）、isNull（为空）、sql（原始 SQL 片段）
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm"
// 导入 Node 的 path 模块，用于拼接目录路径
import path from "path"
// 导入绝对路径（AbsolutePath）品牌类型
import { AbsolutePath } from "./schema.js"
// 导入文件系统工具服务（FSUtil）
import { FSUtil } from "@opencode/util/fs-util"
// 导入 Git 操作封装
import { Git } from "./git.js"
// 导入全局节点工具（Node）
import { Node } from "@opencode/util/effect/app-node"
// 导入层节点类型（LayerNode），用于声明全局服务的类型
import { LayerNode } from "@opencode/util/effect/layer-node"
// 导入短标识（Slug）生成器，用于生成工作树目录名
import { Slug } from "./util/slug.js"
// 导入事件总线（Bus）
import { Bus } from "./bus.js"
// 导入数据库服务
import { Database } from "./database/database.js"
// 导入位置（Location）服务相关定义
import { Location } from "./location.js"
// 导入文件系统接口类型
import type { FileSystem } from "./filesystem.js"
// 导入位置-服务映射（LocationServiceMap）：按目录取上下文中的服务
import { LocationServiceMap } from "./location-service-map.js"
// 导入项目（Project）服务
import { Project } from "./project.js"
// 导入工作树的 Schema 定义（事件、输入、输出类型）
import { Worktree } from "@opencode/schema/worktree"
// 导入工作树数据库表
import { WorktreeTable } from "./worktree/sql.js"
// 导入目录规范化与"目录不可用"错误
import { canonical, DirectoryUnavailableError } from "./worktree/directory.js"
// 导入 Effect 化的 drizzle SQLite 数据库客户端类型
import type { EffectDrizzleSqlite } from "./database/drizzle.js"
// 导入项目数据库表
import { ProjectTable } from "./project/sql.js"
// 导入应用进程服务（AppProcess）：运行启动命令
import { AppProcess } from "@opencode/util/process"
// 导入 Effect 的子进程构造器
import { ChildProcess } from "effect/process"
// 导入工作树策略（WorktreeStrategies）：列出/创建/删除工作树的具体实现
import { WorktreeStrategies } from "./worktree/strategies.js"

// 重导出策略（Strategy）与编辑器（Editor）类型
export type { Strategy, Editor } from "./worktree/strategies.js"

// 重导出目录不可用错误
export { DirectoryUnavailableError } from "./worktree/directory.js"
// 重导出操作错误（OperationError）
export { OperationError } from "@opencode/schema/worktree"

// 重导出策略 ID 的值与类型
export const StrategyID = Worktree.StrategyID
export type StrategyID = typeof StrategyID.Type

// 重导出创建输入（CreateInput）的值与类型
export const CreateInput = Worktree.CreateInput
export type CreateInput = typeof CreateInput.Type

// 重导出移除输入（RemoveInput）的值与类型
export const RemoveInput = Worktree.RemoveInput
export type RemoveInput = typeof RemoveInput.Type

// 重导出信息（Info）的值与类型
export const Info = Worktree.Info
export type Info = typeof Info.Type

// 重导出列表（List）与列表条目（ListEntry）的值与类型
export const List = Worktree.List
export type List = typeof List.Type

export const ListEntry = Worktree.ListEntry
export type ListEntry = typeof ListEntry.Type

// 定义"源目录不存在"错误：指定的来源目录未登记为工作树
export class SourceDirectoryNotFoundError extends Schema.TaggedError<SourceDirectoryNotFoundError>()(
  "Worktree.SourceDirectoryNotFoundError",
  { projectID: Project.ID, directory: Schema.optional(AbsolutePath) },
) {}

// 定义"目标目录已存在"错误：创建工作树时目标路径已被占用
export class DestinationExistsError extends Schema.TaggedError<DestinationExistsError>()(
  "Worktree.DestinationExistsError",
  { directory: AbsolutePath },
) {}

// 定义"无效目录"错误：目录未登记策略，不属于可管理的工作树
export class InvalidDirectoryError extends Schema.TaggedError<InvalidDirectoryError>()(
  "Worktree.InvalidDirectoryError",
  { directory: AbsolutePath },
) {}

// 定义"策略不可用"错误：所需的策略实现当前不可获得
export class StrategyUnavailableError extends Schema.TaggedError<StrategyUnavailableError>()(
  "Worktree.StrategyUnavailableError",
  { strategy: StrategyID },
) {}

// 定义本服务全部可能失败的错误联合类型
export type Error =
  | FileSystem.DirectoryNotFoundError
  | Project.NotFoundError
  | SourceDirectoryNotFoundError
  | DestinationExistsError
  | DirectoryUnavailableError
  | InvalidDirectoryError
  | StrategyUnavailableError
  | Worktree.OperationError
  | AppProcess.AppProcessError
  | Git.WorktreeError

// 重导出事件定义（如 Updated）
export const Event = Worktree.Event

// 定义 StoredInput（入库条目）：目录、可选策略与是否允许抢占
interface StoredInput {
  // 工作树目录（绝对路径）
  readonly directory: AbsolutePath
  // 拥有该目录的策略 ID（可选，未登记表示未被认领）
  readonly strategy?: StrategyID
  // 是否允许替换已有的策略归属（可选）
  readonly replace?: boolean
}

// 定义数据库客户端类型与事务（Transaction）类型别名
type DatabaseClient = EffectDrizzleSqlite.EffectSQLiteDatabase
type Transaction = Parameters<Parameters<DatabaseClient["transaction"]>[0]>[0]

// 定义服务接口：列出 / 创建 / 移除 / 刷新工作树
export interface Interface {
  // 列出某项目下的所有工作树
  readonly list: (input: { projectID: Project.ID }) => Effect.Effect<List, Project.NotFoundError>
  // The plugin bridge supplies its registry so canonical-project setup can use registrations made so far.
  // create：创建工作树；可传入"当前策略注册接口"（插件桥用其注入已注册的策略）
  readonly create: (input: CreateInput, current?: WorktreeStrategies.Interface) => Effect.Effect<Info, Error>
  // remove：移除工作树
  readonly remove: (input: RemoveInput, current?: WorktreeStrategies.Interface) => Effect.Effect<void, Error>
  // refresh：重新发现并同步项目下的工作树登记
  readonly refresh: (
    input: { projectID: Project.ID },
    current?: WorktreeStrategies.Interface,
  ) => Effect.Effect<void, Error>
}

// 定义 Effect 服务标记类：以 "@opencode/Worktree" 为标签
export class Service extends Context.Service<Service, Interface>()("@opencode/Worktree") {}

// 构建服务层：注入文件系统、数据库、总线、进程与位置服务等依赖
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 取出文件系统工具服务
    const fs = yield* FSUtil.Service
    // 取出数据库服务
    const database = yield* Database.Service
    // 取出底层 drizzle 数据库句柄
    const db = database.db
    // 取出事件总线
    const bus = yield* Bus.Service
    // 取出应用进程服务（运行 start 命令）
    const processService = yield* AppProcess.Service
    // 取出位置-服务映射：用于构造目录上下文
    const locations = yield* LocationServiceMap.Service
    // 定义 project：读取项目行，不存在则失败为 Project.NotFoundError
    const project = Effect.fnUntraced(function* (projectID: Project.ID) {
      // 按主键查询项目行
      const row = yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, projectID)).get().pipe(Effect.orDie)
      // 行不存在则抛出项目未找到错误
      if (!row) return yield* new Project.NotFoundError({ projectID })
      // 返回项目行
      return row
    })

    // 定义 load：校验目录可用，并返回该目录下的策略注册集合
    const load = Effect.fnUntraced(function* (directory: AbsolutePath, current?: WorktreeStrategies.Interface) {
      // 目录不是有效目录则报"目录不可用"
      if (!(yield* fs.isDir(directory))) return yield* new DirectoryUnavailableError({ directory })
      // 调用方已提供与该目录匹配的注册接口时直接复用
      if (current?.directory === directory) return current.get()
      // 动态加载插件模块（避免循环依赖），用于等待插件激活
      const { Plugin } = yield* Effect.promise(() => import("./plugin.js"))
      // 以该目录构造位置上下文
      const context = yield* locations.contextEffect(Location.Ref.make({ directory }))
      // 等待插件完成激活（策略可能由插件注册）
      yield* Context.get(context, Plugin.Service).awaitActivation
      // 返回当前上下文中的工作树策略集合
      return Context.get(context, WorktreeStrategies.Service).get()
    })

    // 定义 changed：需要时向总线发布"工作树已更新"事件
    const changed = Effect.fnUntraced(function* (projectID: Project.ID, update: boolean) {
      // update 为真时才发布事件
      if (update) yield* bus.publish(Event.Updated, { projectID })
    })

    // 定义 ops：对工作树表的基础数据库操作集合
    const ops = {
      // list：按创建时间倒序、目录升序列出某项目的全部登记
      list: Effect.fnUntraced(function* (projectID: Project.ID) {
        // 查询目录与策略两列
        const rows = yield* db
          .select({ directory: WorktreeTable.directory, strategy: WorktreeTable.strategy })
          .from(WorktreeTable)
          .where(eq(WorktreeTable.project_id, projectID))
          .orderBy(desc(WorktreeTable.time_created), asc(WorktreeTable.directory))
          .all()
          .pipe(Effect.orDie)
        // 把策略 null 转为 undefined 后返回
        return rows.map((row) => ({ directory: row.directory, strategy: row.strategy ?? undefined }))
      }),
      // find：按项目 + 目录精确查找一条登记
      find: Effect.fnUntraced(function* (projectID: Project.ID, directory: AbsolutePath) {
        // 查询单行
        const row = yield* db
          .select({ directory: WorktreeTable.directory, strategy: WorktreeTable.strategy })
          .from(WorktreeTable)
          .where(and(eq(WorktreeTable.project_id, projectID), eq(WorktreeTable.directory, directory)))
          .get()
          .pipe(Effect.orDie)
        // 找到则返回规范化后的条目，否则返回 undefined
        return row ? { directory: row.directory, strategy: row.strategy ?? undefined } : undefined
      }),
      // create：插入或更新登记；可传入事务对象
      create: (projectID: Project.ID, input: StoredInput, tx?: Transaction) =>
        // 未提供事务时直接用主连接
        (tx ?? db)
          .insert(WorktreeTable)
          .values({
            project_id: projectID,
            directory: input.directory,
            strategy: input.strategy,
          })
          // 冲突时按 (项目, 目录) 唯一键更新策略归属
          .onConflictDoUpdate({
            target: [WorktreeTable.project_id, WorktreeTable.directory],
            set: {
              strategy: input.strategy ?? null,
            },
            // Discovery may claim an unowned row, but never replace another strategy's ownership.
            // 更新条件：replace 模式无条件更新；否则仅在原行为"无主"（strategy 为空）时认领，绝不抢别的策略
            setWhere: input.replace ? undefined : input.strategy ? isNull(WorktreeTable.strategy) : sql`false`,
          })
          // 返回生效的目录以判断是否真的写入了
          .returning({ directory: WorktreeTable.directory })
          .get()
          .pipe(
            Effect.orDie,
            // 命中 returning 表示写入成功，映射为布尔值
            Effect.map((row) => row !== undefined),
          ),
      // remove：删除登记；返回是否确实删除了行
      remove: (projectID: Project.ID, directory: AbsolutePath, tx?: Transaction) =>
        (tx ?? db)
          .delete(WorktreeTable)
          .where(and(eq(WorktreeTable.project_id, projectID), eq(WorktreeTable.directory, directory)))
          .returning({ directory: WorktreeTable.directory })
          .get()
          .pipe(
            Effect.orDie,
            // returning 命中表示删除成功
            Effect.map((row) => row !== undefined),
          ),
    }

    // 定义 source：规范化源目录并确保其已登记为工作树
    const source = Effect.fnUntraced(function* (projectID: Project.ID, sourceDirectory: AbsolutePath) {
      // 把源目录规范化为绝对路径
      const resolved = yield* canonical(fs, sourceDirectory)
      // 未在数据库中登记过则报"源目录不存在"
      if ((yield* ops.find(projectID, resolved)) === undefined)
        return yield* new SourceDirectoryNotFoundError({ projectID, directory: resolved })
      // 返回规范化后的源目录
      return resolved
    })

    // 定义 getStrategy：从策略映射中取出指定 ID 的策略，缺失则报"策略不可用"
    const getStrategy = Effect.fnUntraced(function* (
      id: StrategyID,
      strategies: ReadonlyMap<StrategyID, WorktreeStrategies.Strategy>,
    ) {
      // 按 ID 查找策略
      const found = strategies.get(id)
      // 找不到则失败
      if (!found) return yield* new StrategyUnavailableError({ strategy: id })
      // 返回策略实现
      return found
    })

    // 定义 create：创建一个新工作树
    const create = Effect.fn("Worktree.create")(function* (input: CreateInput, current?: WorktreeStrategies.Interface) {
      // 读取项目行（拿到项目配置的工作树根目录与命令）
      const row = yield* project(input.projectID)
      // 加载项目工作树根目录下的策略设置
      const settings = yield* load(row.worktree, current)
      // 取当前选中的策略实现
      const selected = yield* getStrategy(settings.selected, settings.strategies)
      // 未显式指定目标目录时使用设置中的默认目录
      const directory = input.directory ?? settings.directory
      // 解析源目录（默认用项目工作树根目录），必须已登记
      const sourceDirectory = yield* source(input.projectID, input.from ?? row.worktree)
      // 递归创建目标父目录
      yield* fs.makeDirectory(directory, { recursive: true }).pipe(Effect.orDie)
      // 未指定名称时生成随机短标识
      const name = input.name ?? Slug.create()
      // 后缀计数从 1 开始，用于目录重名时追加序号
      let suffix = 1
      // 计算工作树目录的候选路径
      let worktreeDirectory = AbsolutePath.make(path.join(directory, name))
      // 目录已存在则追加 -2、-3…… 直到可用或超限
      while (yield* fs.existsSafe(worktreeDirectory)) {
        // 递增后缀
        suffix++
        // 超过 10 次仍冲突则放弃并报"目标已存在"
        if (suffix > 10) return yield* new DestinationExistsError({ directory: worktreeDirectory })
        // 用带后缀的名字重算候选路径
        worktreeDirectory = AbsolutePath.make(path.join(directory, `${name}-${suffix}`))
      }

      // 调用选中策略创建工作树；任何失败包装为 OperationError
      const created = yield* selected
        .create({
          directory: worktreeDirectory,
          sourceDirectory,
          branch: input.branch,
        })
        .pipe(Effect.mapError((error) => operationError(selected.id, "create", error)))
      // 把创建结果目录规范化后作为最终目录
      const result = { directory: yield* canonical(fs, created.directory) }
      // 把新工作树登记进数据库（允许抢占无主行），有变化时发布更新事件
      yield* changed(
        input.projectID,
        yield* ops.create(input.projectID, {
          directory: result.directory,
          strategy: selected.id,
          replace: true,
        }),
      )
      // 读取项目配置的 start 命令（可空）
      const command = row.commands?.start?.trim()
      // 配置了启动命令时在新工作树中执行
      if (command) {
        // 判断是否 Windows 平台
        const windows = process.platform === "win32"
        // 运行命令：Windows 用 shell 直接执行，其他平台用 bash -lc；注入工作树相关环境变量
        yield* processService
          .run(
            ChildProcess.make(windows ? command : "bash", windows ? [] : ["-lc", command], {
              cwd: result.directory,
              env: {
                OPENCODE_WORKTREE_BASE: sourceDirectory,
                OPENCODE_WORKTREE_PATH: result.directory,
              },
              extendEnv: true,
              stdin: "ignore",
              shell: windows,
            }),
          )
          // 命令失败（非零退出）时让创建流程失败
          .pipe(Effect.flatMap(AppProcess.requireSuccess))
      }
      // 返回创建结果（目录）
      return result
      // 整个 create 放在作用域内执行，结束时清理临时资源
    }, Effect.scoped)

    // 定义 remove：移除一个已登记的工作树
    const remove = Effect.fn("Worktree.remove")(function* (input: RemoveInput, current?: WorktreeStrategies.Interface) {
      // 读取项目行
      const row = yield* project(input.projectID)
      // 规范化要移除的目录
      const worktreeDirectory = yield* canonical(fs, input.directory)
      // 查找该目录的登记
      const stored = yield* ops.find(input.projectID, worktreeDirectory)
      // 未登记或无策略归属：不属于本服务管理的工作树，报"无效目录"
      if (!stored?.strategy) return yield* new InvalidDirectoryError({ directory: worktreeDirectory })
      // 加载策略设置（用于取得存储策略的实现）
      const settings = yield* load(row.worktree, current)
      // 取出当初创建该工作树的策略实现
      const strategy = yield* getStrategy(stored.strategy, settings.strategies)
      // 调用策略删除工作树；失败包装为 OperationError
      yield* strategy
        .remove({
          directory: worktreeDirectory,
          force: input.force,
        })
        .pipe(Effect.mapError((error) => operationError(strategy.id, "remove", error)))
      // 删除数据库登记，有变化时发布更新事件
      yield* changed(input.projectID, yield* ops.remove(input.projectID, worktreeDirectory))
      // 作用域内执行，结束时清理
    }, Effect.scoped)

    // 定义 refresh：重新发现磁盘上的工作树并与数据库登记同步
    const refresh = Effect.fn("Worktree.refresh")(function* (
      input: { projectID: Project.ID },
      current?: WorktreeStrategies.Interface,
    ) {
      // 读取项目行
      const row = yield* project(input.projectID)
      // 加载策略设置
      const settings = yield* load(row.worktree, current)
      // 读取现有登记列表
      const stored = yield* ops.list(input.projectID)
      // 并发检查每个登记目录是否仍存在
      const checked = yield* Effect.forEach(
        stored,
        (item) => fs.isDir(item.directory).pipe(Effect.map((exists) => ({ ...item, exists }))),
        { concurrency: "unbounded" },
      )
      // 策略实现列表按注册倒序（后注册的优先探测）
      const strategies = Array.from(settings.strategies.values()).toReversed()
      // 发现结果映射：规范化目录 -> 待写入的条目
      const discovered = new Map<AbsolutePath, StoredInput>()
      // Unowned rows are checkout/discovery roots. Managed children are enumerated by their backend.
      // 探测根集合：项目工作树根目录 + 所有"存在但无主"的登记（它们是检出/发现的根）
      const roots = new Set([
        row.worktree,
        ...checked.filter((item) => item.exists && !item.strategy).map((item) => item.directory),
      ])
      // 逐个根目录进行发现
      for (const directory of roots) {
        // 根目录不存在则跳过
        if (!(yield* fs.isDir(directory))) continue
        // 用每个策略在该根目录下列出它管理的工作树
        for (const strategy of strategies) {
          // 列出条目；失败仅记录警告并按空列表处理
          const entries = yield* strategy.list(directory).pipe(
            Effect.mapError((error) => operationError(strategy.id, "list", error)),
            Effect.catch((error) =>
              Effect.logWarning("worktree discovery failed", { directory, strategy: strategy.id, error }).pipe(
                Effect.as([]),
              ),
            ),
          )
          // 处理每个发现的条目
          for (const entry of entries) {
            // 规范化条目目录；目录已不可访问时按 undefined 处理
            const directory = yield* canonical(fs, entry.directory).pipe(
              Effect.catchTag("Worktree.DirectoryUnavailableError", () => Effect.undefined),
            )
            // 目录无效或已经发现过则跳过
            if (!directory || discovered.has(directory)) continue
            // 记录发现结果：普通 worktree 归发现它的策略所有，其他类型不认领
            discovered.set(directory, {
              directory,
              strategy: entry.type === "worktree" ? strategy.id : undefined,
            })
          }
        }
      }
      // 收集已不存在的登记目录（待从数据库删除）
      const removed = checked.filter((item) => !item.exists).map((item) => item.directory)
      // 在一个事务里完成新增/更新与删除
      const changes = yield* db
        .transaction((tx) =>
          Effect.all({
            // 写入全部发现条目，收集实际生效的目录
            updated: Effect.filter(Array.from(discovered.values()), (item) =>
              ops.create(input.projectID, item, tx),
            ).pipe(Effect.map((items) => items.map((item) => item.directory))),
            // 删除已消失目录的登记，收集实际删除的目录
            removed: Effect.filter(removed, (directory) => ops.remove(input.projectID, directory, tx)),
          }),
        )
        .pipe(Effect.orDie)
      // 有任何实际增删时发布更新事件
      yield* changed(input.projectID, changes.updated.length > 0 || changes.removed.length > 0)
      // 作用域内执行
    }, Effect.scoped)

    // 返回服务实现
    return Service.of({
      // list：先校验项目存在，再返回登记列表
      list: Effect.fn("Worktree.list")(function* (input) {
        // 校验项目存在（不存在会失败）
        yield* project(input.projectID)
        // 返回该项目的全部登记
        return yield* ops.list(input.projectID)
      }),
      // create：暴露上面的创建实现
      create,
      // remove：暴露上面的移除实现
      remove,
      // refresh：暴露上面的刷新实现
      refresh,
    })
  }),
)

// 导出全局服务节点：注册 Worktree 服务并声明其依赖
export const node: LayerNode.Provider<Service, never, typeof Node.tags.values.global> = Node.makeGlobalNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Bus.node, Database.node, AppProcess.node, LocationServiceMap.node],
})

// 定义 operationError：把策略执行中的错误统一为 OperationError（已知类型原样透传）
function operationError(strategy: StrategyID, operation: string, error: unknown) {
  // 这三类错误已带足够上下文，直接返回
  if (
    error instanceof Git.WorktreeError ||
    error instanceof DirectoryUnavailableError ||
    error instanceof Worktree.OperationError
  )
    return error
  // 其他错误包装为带策略名与操作的 OperationError
  return new Worktree.OperationError({
    message: `Worktree strategy ${strategy} failed to ${operation}: ${error instanceof globalThis.Error ? error.message : String(error)}`,
  })
}
