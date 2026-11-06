// 末尾自导出：便于 `import { Project } from "./project.js"` 引用命名空间
export * as Project from "./project.js"

// 从 effect 库导入：Cache（缓存）、Context（上下文）、Duration（时长）、Effect（效果）、Layer（层）、
// Schedule（调度）、Schema（模式）、Scope（作用域）
import { Cache, Context, Duration, Effect, Layer, Schedule, Schema, Scope } from "effect"
// 导入 ChildProcess：声明式子进程运行（effect/process）
import { ChildProcess } from "effect/process"
// 导入 drizzle-orm 的查询操作符：and/asc/desc/eq/gte/isNotNull/isNull/lt/lte/ne/sql
import { and, asc, desc, eq, gte, isNotNull, isNull, lt, lte, ne, sql } from "drizzle-orm"
// 导入 path：路径拼接与目录名计算
import path from "path"
// 导入 AbsolutePath 类型：绝对路径的标记类型
import { AbsolutePath } from "./schema.js"
// 导入 Bus（事件总线）服务
import { Bus } from "./bus.js"
// 导入 Database 服务：SQLite 数据库访问
import { Database } from "./database/database.js"
// 导入 Worktree 模式：工作树（worktree）策略与事件定义
import { Worktree } from "@opencode/schema/worktree"
// 导入 FSUtil：文件系统工具服务
import { FSUtil } from "@opencode/util/fs-util"
// 导入 Git 服务：git 仓库发现、历史、远端等操作
import { Git } from "./git.js"
// 导入 AppProcess：应用子进程服务（运行 hg 等外部命令）
import { AppProcess } from "@opencode/util/process"
// 导入 makeGlobalNode：全局节点工厂
import { makeGlobalNode } from "@opencode/util/effect/app-node"
// 导入 Hash：快速哈希（派生项目 ID）
import { Hash } from "@opencode/util/hash"
// 导入 ProjectSchema：项目模式（ID、Vcs、Info、事件等）
import { ProjectSchema } from "./project/schema.js"
// 导入 ProjectTable 与 upsertProject：项目表的 SQL 定义与 upsert
import { ProjectTable, upsertProject } from "./project/sql.js"
// 导入 ProjectIcon：项目图标刷新逻辑
import { ProjectIcon } from "./project/icon.js"
// 导入 WorktreeTable：工作树表的 SQL 定义
import { WorktreeTable } from "./worktree/sql.js"

// 导出 ID：项目 ID 校验器
export const ID = ProjectSchema.ID
// 导出 ID 类型别名
export type ID = ProjectSchema.ID

// 导出 Vcs：版本控制（VCS）类型定义（git/hg 等）
export const Vcs = ProjectSchema.Vcs
// 导出 Vcs 类型别名
export type Vcs = ProjectSchema.Vcs

// 导出 Current：当前项目信息结构
export const Current = ProjectSchema.Current
// 导出 Current 类型别名
export type Current = ProjectSchema.Current

// 导出 Info：项目信息的模式定义
export const Info = ProjectSchema.Info
// Info 的接口形式（Schema.Type 推导）
export interface Info extends Schema.Schema.Type<typeof Info> {}

// 导出 UpdateInput：项目更新输入结构
export const UpdateInput = ProjectSchema.UpdateInput
// 导出 UpdateInput 类型别名
export type UpdateInput = ProjectSchema.UpdateInput

// NotFoundError：找不到指定项目时抛出
export class NotFoundError extends Schema.TaggedError<NotFoundError>()("Project.NotFoundError", {
  // 缺失的项目 ID
  projectID: ID,
}) {}

// Resolved：一次项目解析的结果
export interface Resolved {
  // 之前缓存在目录中的项目 ID（可选）
  readonly previous?: ID
  // 解析出的项目 ID
  readonly id: ID
  // 当前目录
  readonly directory: AbsolutePath
  // This checkout's main directory; the stored project canonical may be another clone.
  // 本次检出的主目录；库里存的规范目录（canonical）可能是另一个克隆
  readonly canonical: AbsolutePath
  // 版本控制信息（可选）
  readonly vcs?: Vcs
}

// Keep this filesystem-only; permission checks use it and should not execute VCS commands.
// root：向上查找项目根目录（含 .git/.hg 标记）。仅做文件系统检查——
// 权限检查会用到它，不能执行 VCS 命令。
export const root = Effect.fn("Project.root")(
  // 生成器：给定 fs.exists、起始目录与标记列表
  function* (
    // 文件系统存在性检查接口
    fs: { readonly exists: (path: string) => Effect.Effect<boolean, unknown> },
    // 起始目录
    input: AbsolutePath,
    // 标记文件/目录名，默认 .git 与 .hg
    markers: readonly string[] = [".git", ".hg"],
  ) {
    // 从当前目录逐级向上
    for (let current: string = input; ; current = path.dirname(current)) {
      // 检查每个标记是否存在
      for (const marker of markers) {
        // 找到标记即返回该目录为根
        if (yield* fs.exists(path.join(current, marker))) return AbsolutePath.make(current)
      }
      // 已到文件系统顶层（dirname 不再变化）则返回 undefined
      if (path.dirname(current) === current) return undefined
    }
  },
  // 任何失败都视为无根目录
  Effect.orElseSucceed(() => undefined),
)

// 激活节流间隔：60 秒内同项目只记录一次活动
export const ACTIVATE_INTERVAL = 60_000
// 归档清扫周期：每 1 小时
const SWEEP_INTERVAL = Duration.hours(1)

// Options：服务可配置项
export interface Options {
  // 覆盖当前时间函数（测试用）
  readonly now?: () => number
}

// Now：当前时间函数的上下文引用（默认 Date.now）
const Now = Context.Reference<() => number>("@opencode/Project/Now", { defaultValue: () => Date.now })

// ListInput：list 的输入
export interface ListInput {
  /** Includes archived Projects when true. */
  // 为 true 时包含已归档的项目
  readonly archived?: boolean
}

// ResolveOptions：resolve 的选项
export interface ResolveOptions {
  /** Discover ownership without persisting or announcing it. */
  // 为 false 时只发现归属，不持久化也不广播
  readonly persist?: boolean
}

// ActivateOptions：activate 的选项
export interface ActivateOptions {
  /** Forks unthrottled persistence writes into `forkIn` instead of blocking the caller. */
  // 提供作用域时，未被节流的持久化写入 fork 到该作用域中，不阻塞调用方
  readonly forkIn?: Scope.Scope
}

// Interface：Project 服务的对外接口
export interface Interface {
  // 列出项目（默认排除已归档）
  readonly list: (input?: ListInput) => Effect.Effect<ReadonlyArray<Info>>
  // 更新项目元数据
  readonly update: (input: UpdateInput) => Effect.Effect<Info, NotFoundError>
  /** Records Project activity for recency ordering, at most once per minute per Project. */
  // activate：记录项目活动（用于按最近使用排序）；每项目每分钟最多一次
  readonly activate: (projectID: ID, options?: ActivateOptions) => Effect.Effect<void>
  /** Resolves the owning Project, persisting it unless `persist` is false. */
  // resolve：解析目录所属项目；persist 为 false 时不持久化
  readonly resolve: (input: AbsolutePath, options?: ResolveOptions) => Effect.Effect<Resolved>
  /** Archives Projects whose known directories are all gone; resolving a Project unarchives it. */
  // sweep：归档所有已知目录都消失的项目；再次 resolve 会取消归档
  readonly sweep: () => Effect.Effect<void>
}

// 定义 Project 服务标识：标签 "@opencode/Project"
export class Service extends Context.Service<Service, Interface>()("@opencode/Project") {}

// fromRow：把数据库行转成项目信息
function fromRow(row: typeof ProjectTable.$inferSelect): Info {
  // 有任意图标字段时才构造图标对象
  const icon =
    // URL、覆盖 URL 或颜色任一存在
    row.icon_url || row.icon_url_override || row.icon_color
      ? {
          // 图标 URL
          url: row.icon_url ?? undefined,
          // 用户覆盖的 URL
          override: row.icon_url_override ?? undefined,
          // 图标颜色
          color: row.icon_color ?? undefined,
        }
      : undefined
  // 返回组装好的信息
  return {
    // 项目 ID
    id: row.id,
    // 规范目录（存的是主工作树路径）
    canonical: row.worktree,
    // 版本控制类型（可选）
    vcs: row.vcs ?? undefined,
    // 显示名（可选）
    name: row.name ?? undefined,
    // 图标（可选）
    icon,
    // 启动命令（可选）
    commands: row.commands ?? undefined,
    // 时间戳组
    time: {
      // 创建时间
      created: row.time_created,
      // 更新时间
      updated: row.time_updated,
      // 最近活动时间
      active: row.time_active,
      // 归档时间（可选）
      archived: row.time_archived ?? undefined,
    },
    // 沙箱（sandbox）目录列表
    sandboxes: row.sandboxes,
  }
}

// layer：Project 服务的层实现
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 获取当前时间函数
    const now = yield* Now
    // 获取文件系统工具服务
    const fs = yield* FSUtil.Service
    // 获取 git 服务
    const git = yield* Git.Service
    // 获取子进程服务
    const proc = yield* AppProcess.Service
    // 获取事件总线服务
    const bus = yield* Bus.Service
    // 获取数据库连接
    const db = (yield* Database.Service).db
    // 获取当前作用域（后台 fork 用）
    const scope = yield* Scope.Scope

    // announcing：正在广播的"项目+目录"键集合（防并发重复广播）
    const announcing = new Set<string>()
    // persist：把解析结果写入数据库并广播必要的事件
    const persist = Effect.fnUntraced(function* (project: Resolved) {
      // 先查当前存储的规范目录
      const previous = yield* db
        // 只取 worktree 列
        .select({ canonical: ProjectTable.worktree })
        // 从项目表
        .from(ProjectTable)
        // 匹配项目 ID
        .where(eq(ProjectTable.id, project.id))
        // 取单行
        .get()
        // 查询失败视为缺陷
        .pipe(Effect.orDie)
      // upsert 项目行
      yield* upsertProject(db, project).pipe(Effect.orDie)
      // 取消归档：如果项目处于归档状态则恢复，且不更新 time_updated
      const unarchived = yield* db
        // 更新项目表
        .update(ProjectTable)
        // 归档时间清空；time_updated 保持原值
        .set({ time_archived: null, time_updated: sql`${ProjectTable.time_updated}` })
        // 仅针对已归档的该项目
        .where(and(eq(ProjectTable.id, project.id), isNotNull(ProjectTable.time_archived)))
        // 返回被更新的行
        .returning()
        // 取单行
        .get()
        // 失败视为缺陷
        .pipe(Effect.orDie)
      // Clones share a project ID; only replace a canonical directory that is gone.
      // replaced：克隆共享项目 ID；仅当旧规范目录已消失时才替换
      const replaced =
        // 存在旧规范目录、且与新目录不同、且旧目录在磁盘上不存在
        previous &&
        previous.canonical !== project.canonical &&
        // 检查失败（读取异常）按"存在"处理，避免误替换
        !(yield* fs.exists(previous.canonical).pipe(Effect.orElseSucceed(() => true)))
          ? yield* db
              // 更新项目的规范目录
              .update(ProjectTable)
              // 设为新的规范目录
              .set({ worktree: project.canonical })
              // 匹配项目 ID
              .where(eq(ProjectTable.id, project.id))
              // 返回更新行
              .returning()
              // 取单行
              .get()
              // 失败视为缺陷
              .pipe(Effect.orDie)
          : undefined
      // changed：本次真正产生变化的行（替换目录或取消归档）
      const changed = replaced ?? unarchived
      // 有变化时广播项目更新事件
      if (changed) yield* bus.publish(ProjectSchema.Event.Updated, fromRow(changed))
      // 异步刷新项目图标；有更新再广播（忽略失败、fork 到服务作用域）
      yield* ProjectIcon.refresh(fs, db, project.id).pipe(
        // 有返回行时广播更新事件
        Effect.flatMap((row) => (row ? bus.publish(ProjectSchema.Event.Updated, fromRow(row)) : Effect.void)),
        // 失败不传播
        Effect.ignoreCause,
        // fork 到服务作用域
        Effect.forkIn(scope),
      )
      // 无版本控制的项目到此结束
      if (!project.vcs) return project
      // directories：要广播归属的目录列表（规范目录必含）
      const directories: Array<{ projectID: ID; directory: AbsolutePath; strategy?: Worktree.StrategyID }> = [
        // 规范目录
        { projectID: project.id, directory: project.canonical },
      ]
      // 当前目录与规范目录不同（子工作树/子克隆）时也广播
      if (project.directory !== project.canonical)
        // 追加当前目录，git 项目附 git 策略
        directories.push({
          // 项目 ID
          projectID: project.id,
          // 目录
          directory: project.directory,
          // git 项目使用 git 策略
          strategy: project.vcs.type === "git" ? Worktree.StrategyID.make("git") : undefined,
        })
      // A missing directory row means this directory's resolution is a new durable
      // fact. The row insert commits atomically with the event, so a crash between
      // checks retries on the next resolve instead of stranding the announcement.
      // The in-flight set keeps concurrent resolves from publishing the same fact
      // twice.
      // 缺少目录行意味着本次解析是新的持久事实。行插入与事件原子提交，
      // 中途崩溃会在下次 resolve 重试而不是搁浅广播；进行中集合防止并发 resolve 重复广播。
      for (const item of directories) {
        // 构造去重键：项目 ID + NUL + 目录
        const key = item.projectID + "\u0000" + item.directory
        // 已在广播中则跳过
        if (announcing.has(key)) continue
        // 登记进行中
        announcing.add(key)
        // 执行归属检查与广播
        yield* Effect.gen(function* () {
          // 查询该目录是否已有行
          const stored = yield* db
            // 只取 directory 列
            .select({ directory: WorktreeTable.directory })
            // 从工作树表
            .from(WorktreeTable)
            // 匹配项目与目录
            .where(and(eq(WorktreeTable.project_id, item.projectID), eq(WorktreeTable.directory, item.directory)))
            // 取单行
            .get()
            // 失败视为缺陷
            .pipe(Effect.orDie)
          // 已有行则无需广播
          if (stored) return
          // 解析目录的真实路径（符号链接等）
          const directory = AbsolutePath.make(yield* fs.resolve(item.directory))
          // 查找"无版本控制且规范目录是本目录的祖先"的项目（候选收养对象）
          const markerless = yield* db
            // 取项目 ID 与规范目录
            .select({ id: ProjectTable.id, directory: ProjectTable.worktree })
            // 从项目表
            .from(ProjectTable)
            // 条件：无 VCS 且 worktree 落在 [directory, directory+\uffff] 前缀区间
            .where(
              and(
                // 无版本控制
                isNull(ProjectTable.vcs),
                // 规范目录 >= directory
                gte(ProjectTable.worktree, directory),
                // 规范目录 <= directory+\uffff（前缀匹配技巧）
                lte(ProjectTable.worktree, AbsolutePath.make(directory + "\uffff")),
              ),
            )
            // 取全部行
            .all()
            // 失败视为缺陷
            .pipe(Effect.orDie)
          // 逐候选验证可收养性：候选必须是本目录内、且其自身 .git/.hg 就在本目录
          const adopted = yield* Effect.filter(markerless, (candidate) =>
            Effect.gen(function* () {
              // 自身不算收养
              if (candidate.id === item.projectID) return false
              // 候选目录不在本目录内则跳过
              if (!FSUtil.contains(directory, candidate.directory)) return false
              // 在候选目录与本目录之间向上找标记（mode=first）
              const found = yield* fs
                // 目标 .git/.hg
                .up({ targets: [".git", ".hg"], start: candidate.directory, stop: directory, mode: "first" })
                // 失败视为未找到
                .pipe(Effect.orElseSucceed(() => []))
              // 没找到标记则不可收养
              if (!found[0]) return false
              // 标记的父目录必须就是本目录
              return (yield* fs.resolve(path.dirname(found[0]))) === directory
            }),
          )
          // 广播工作树归属解析事件（附提交动作：插入行与事件原子提交）
          yield* bus.publish(
            // 事件类型
            Worktree.Event.Resolved,
            // 负载：项目、目录、先前归属（默认全局项目）、被收养的项目
            {
              // 项目 ID
              projectID: item.projectID,
              // 目录
              directory: item.directory,
              // 先前项目 ID（缺省为全局）
              previous: project.previous ?? ID.global,
              // 有收养时附列表
              ...(adopted.length ? { adopted: adopted.map((candidate) => candidate.id) } : {}),
            },
            {
              // 提交钩子：插入工作树行（冲突忽略）
              commit: () =>
                db
                  // 插入工作树表
                  .insert(WorktreeTable)
                  // 行内容：项目、目录、策略
                  .values({ project_id: item.projectID, directory: item.directory, strategy: item.strategy })
                  // 主键冲突时跳过
                  .onConflictDoNothing()
                  // 执行
                  .run()
                  // 失败视为缺陷并转 void
                  .pipe(Effect.orDie, Effect.asVoid),
            },
          )
          // 无论成败都从进行中集合移除
        }).pipe(Effect.ensuring(Effect.sync(() => announcing.delete(key))))
      }
      // 返回解析结果
      return project
    })

    // list：按最近活动倒序列出项目
    const list = Effect.fn("Project.list")(function* (input?: ListInput) {
      // 查询项目表
      const rows = yield* db
        // 全列
        .select()
        // 从项目表
        .from(ProjectTable)
        // 未要求包含归档时排除已归档
        .where(input?.archived ? undefined : isNull(ProjectTable.time_archived))
        // 按活动时间倒序、ID 升序稳定排序
        .orderBy(desc(ProjectTable.time_active), asc(ProjectTable.id))
        // 取全部行
        .all()
        // 失败视为缺陷
        .pipe(Effect.orDie)
      // 转成信息对象
      return rows.map(fromRow)
    })

    // update：更新项目元数据并广播
    const update = Effect.fn("Project.update")(function* (input: UpdateInput) {
      // 更新项目行
      const row = yield* db
        // 项目表
        .update(ProjectTable)
        // 设置字段：undefined 表示不改，空串/null 表示清除
        .set({
          // 规范目录
          worktree: input.canonical,
          // 名称：undefined 不改；空串清空；非空则设置
          name: input.name === undefined ? undefined : input.name || null,
          // 图标覆盖 URL：同上逻辑
          icon_url_override: input.icon?.override === undefined ? undefined : input.icon.override || null,
          // 图标颜色：同上逻辑
          icon_color: input.icon?.color === undefined ? undefined : input.icon.color || null,
          // 启动命令：undefined 不改；有值设置；空串清除
          commands:
            input.commands?.start === undefined
              ? undefined
              : input.commands.start
                ? { start: input.commands.start }
                : null,
          // 更新时间为当前
          time_updated: Date.now(),
        })
        // 匹配项目 ID
        .where(eq(ProjectTable.id, input.projectID))
        // 返回更新行
        .returning()
        // 取单行
        .get()
        // 失败视为缺陷
        .pipe(Effect.orDie)
      // 无行说明项目不存在
      if (!row) return yield* new NotFoundError({ projectID: input.projectID })
      // 转成信息对象
      const project = fromRow(row)
      // 广播更新事件
      yield* bus.publish(ProjectSchema.Event.Updated, project)
      // 返回更新后的信息
      return project
    })

    // activated：项目 ID -> 上次激活时间戳（内存节流表）
    const activated = new Map<ID, number>()
    // persistActivate：实际写入活动时间戳
    const persistActivate = Effect.fn("Project.activate")(function* (projectID: ID, timestamp: number) {
      // 更新项目行
      const row = yield* db
        // 项目表
        .update(ProjectTable)
        // Activity is not a metadata edit, so keep time_updated out of the implicit bump.
        // 设置活动时间；活动不是元数据编辑，time_updated 保持原值（不入隐式更新）
        .set({ time_active: timestamp, time_updated: sql`${ProjectTable.time_updated}` })
        // 匹配项目 ID
        .where(eq(ProjectTable.id, projectID))
        // 返回更新行
        .returning()
        // 取单行
        .get()
        // 失败视为缺陷
        .pipe(Effect.orDie)
      // 有更新行时广播事件
      if (row) yield* bus.publish(ProjectSchema.Event.Updated, fromRow(row))
    })
    // activate：带 60 秒内存节流的激活入口
    const activate = (projectID: ID, options?: ActivateOptions): Effect.Effect<void> =>
      // suspend 保证节流判断在每次运行时求值
      Effect.suspend(() => {
        // 当前时间戳
        const timestamp = now()
        // 上次激活时间
        const last = activated.get(projectID)
        // 节流窗口内直接跳过
        if (last !== undefined && timestamp - last < ACTIVATE_INTERVAL) return Effect.void
        // 记录本次时间
        activated.set(projectID, timestamp)
        // 构造写入效果
        const write = persistActivate(projectID, timestamp)
        // 提供 forkIn 作用域时后台写入，否则同步等待
        return options?.forkIn ? write.pipe(Effect.forkIn(options.forkIn), Effect.asVoid) : write
      })

    // cached：读取目录中的 opencode 标记文件（记录此前解析出的项目 ID）
    const cached = Effect.fnUntraced(function* (dir: string) {
      // 读取 <dir>/opencode 文本
      return yield* fs.readFileString(path.join(dir, "opencode")).pipe(
        // 去除首尾空白
        Effect.map((value) => value.trim()),
        // 非空转成项目 ID，空则 undefined
        Effect.map((value) => (value ? ID.make(value) : undefined)),
        // 文件不存在等失败视为无缓存
        Effect.orElseSucceed(() => undefined),
      )
    })

    // remote：从 git 远端 URL 派生项目 ID
    const remote = Effect.fnUntraced(function* (repo: Git.Repository) {
      // 读取 origin 远端
      const origin = yield* git.remote.get(repo)
      // 无远端则无 ID
      if (!origin) return undefined
      // 规范化远端 URL
      const normalized = url(origin)
      // 无法解析则无 ID
      if (!normalized) return undefined
      // 用快速哈希派生 ID
      return ID.make(Hash.fast(`git-remote:${normalized}`))
    })

    // url：把任意形式的 git 远端 URL 规范成 "host/path" 字符串
    function url(input: string) {
      // 去除首尾空白
      const value = input.trim()
      // 空串无效
      if (!value) return undefined

      // 尝试标准 URL 解析
      const parsed = URL.parse(value)
      // 解析成功（http/ssh/https 等）
      if (parsed) {
        // file:// 协议视为本地仓库，不用于身份
        if (parsed.protocol === "file:") return undefined
        // 用主机名与路径拼身份
        return parts(parsed.hostname, parsed.pathname)
      }
      // scp 形式：[user@]host:path
      const scp = value.match(/^([^@/:]+@)?([^/:]+):(.+)$/)
      // 匹配则用 host 与路径
      if (scp) return parts(scp[2], scp[3])
      // 其他形式无效
      return undefined
    }

    // parts：清洗主机名与路径并拼成 "host/path"
    function parts(host: string, name: string) {
      // 路径清洗：去前导斜杠、去 .git 后缀、去尾部斜杠
      const pathname = name
        // 去前导斜杠
        .replace(/^\/+/, "")
        // 去 .git 后缀（可带尾部斜杠）
        .replace(/\.git\/?$/, "")
        // 去尾部斜杠
        .replace(/\/+$/, "")
      // 主机或路径为空则无效
      if (!host || !pathname) return undefined
      // 主机转小写后拼接
      return `${host.toLowerCase()}/${pathname}`
    }

    // rootCommit：取仓库首个根提交作为备选身份
    const rootCommit = Effect.fnUntraced(function* (repo: Git.Repository) {
      // 取根提交列表的第一个
      const root = (yield* git.history.rootCommits(repo))[0]
      // 有则转 ID，无则 undefined
      return root ? ID.make(root) : undefined
    })

    // Failures resolve like dev (no remote / no root / own worktree) but aren't cached.
    // gitDiscover：从 .git 路径发现项目身份。失败时的回退结果与开发态一致
    // （无远端/无根提交/自身工作树），但不会被缓存。
    const gitDiscover = Effect.fnUntraced(function* (dotGit: AbsolutePath) {
      // 从 .git 父目录发现仓库
      const repo = yield* git.repo.discover(AbsolutePath.make(path.dirname(dotGit)))
      // 发现失败：结果为空且不可缓存
      if (!repo) return { resolved: undefined, cacheable: false }
      // 可缓存标志
      let cacheable = true
      // fallback：把失败转成指定值并标记不可缓存
      const fallback = <A>(value: A) =>
        // 成功值包装
        Effect.orElseSucceed(() => {
          // 标记不可缓存
          cacheable = false
          // 返回回退值
          return value
        })
      // 读目录缓存的旧项目 ID
      const previous = yield* cached(repo.commonDirectory)
      // 身份优先级：远端派生 > 旧缓存 > 根提交
      const id =
        // 远端派生（失败回退 undefined 且不可缓存）
        (yield* remote(repo).pipe(fallback(undefined))) ??
        // 旧缓存 ID
        previous ??
        // 根提交派生
        (yield* rootCommit(repo).pipe(fallback(undefined)))
      // 规范目录：普通仓库用工作树；链接仓库找主工作树
      const canonical =
        // .git 即 common dir 时（非 worktree）直接用工作树
        repo.gitDirectory === repo.commonDirectory
          ? repo.worktree
          : yield* git.worktree.list(repo).pipe(
              // 找 kind=main 的列表项，缺省回退工作树
              Effect.map((items) => items.find((item) => item.kind === "main")?.directory ?? repo.worktree),
              // 列表失败回退工作树且不可缓存
              fallback(repo.worktree),
            )
      // 组装解析结果
      const resolved: Resolved = {
        // 旧缓存 ID
        previous,
        // 身份：各来源皆无时用全局项目
        id: id ?? ID.global,
        // 当前工作树目录
        directory: repo.worktree,
        // 规范目录
        canonical,
        // 版本控制：git，共享存储指向 common dir
        vcs: { type: "git" as const, store: repo.commonDirectory },
      }
      // 返回结果与可缓存性
      return { resolved, cacheable }
    })

    // Keyed by `.git` path plus its metadata fingerprint, so repeat resolves spawn no git.
    // gitCache：按 ".git 路径 + 元数据指纹" 缓存发现结果，重复解析不再启动 git 进程
    const gitCache = yield* Cache.make({
      // 容量 512
      capacity: 512,
      // 查找函数：键前半是 .git 路径
      lookup: (key: string) => gitDiscover(AbsolutePath.make(key.slice(0, key.indexOf("\u0000")))),
    })

    // Mercurial identity uses the cached ID or the first root changeset; remote-derived
    // identity (the git `remote()` path) is a follow-up.
    // hgRoot：Mercurial 身份用缓存的 ID 或首个根变更集；
    // 基于远端的身份（git 的 remote() 路线）留待后续实现。
    const hgRoot = Effect.fnUntraced(function* (worktree: AbsolutePath) {
      // 运行 hg log 取全部根变更集节点，HGPLAIN 保证输出格式稳定
      const result = yield* proc
        .run(
          // hg 命令
          ChildProcess.make("hg", ["log", "-r", "roots(all())", "-T", "{node}\n"], {
            // 在工作树中执行
            cwd: worktree,
            // 严格 plain 模式环境
            env: { HGPLAIN: "1" },
            // 继承外部环境
            extendEnv: true,
            // 忽略标准输入
            stdin: "ignore",
          }),
        )
        // hg 不存在等失败视为无结果
        .pipe(Effect.orElseSucceed(() => undefined))
      // 无结果或非零退出则无身份
      if (!result || result.exitCode !== 0) return undefined
      // 解析输出：按行拆分、去空白、过滤空行、字典序排序后取最小
      const node = result.stdout
        .toString("utf8")
        // 按行拆分
        .split("\n")
        // 去除每行空白
        .map((item) => item.trim())
        // 过滤空行
        .filter(Boolean)
        // 排序保证确定性
        .toSorted()[0]
      // 有节点则转 ID
      return node ? ID.make(node) : undefined
    })

    // hgDiscover：从 .hg 路径发现项目身份（缓存 ID 优先，其次 hgRoot）
    const hgDiscover = Effect.fnUntraced(function* (dotHg: AbsolutePath) {
      // 工作树是 .hg 的父目录
      const worktree = AbsolutePath.make(path.dirname(dotHg))
      // 读缓存 ID
      const previous = yield* cached(dotHg)
      // 身份：缓存优先，其次 hg 根变更集
      const id = previous ?? (yield* hgRoot(worktree))
      // 返回解析结果（canonical 由调用方补全）
      return {
        // 旧缓存 ID
        previous,
        // 身份：无任何来源时用全局项目
        id: id ?? ID.global,
        // 工作树目录
        directory: worktree,
        // 版本控制：hg，存储即 .hg 路径
        vcs: { type: "hg" as const, store: dotHg },
      }
    })

    // resolve：解析目录所属项目的总入口
    const resolve = Effect.fn("Project.resolve")(function* (input: AbsolutePath, options?: ResolveOptions) {
      // save：按选项决定是否持久化
      const save = (project: Resolved) => (options?.persist === false ? Effect.succeed(project) : persist(project))
      // 解析目录的真实路径
      const directory = AbsolutePath.make(yield* fs.resolve(input))
      // 向上查找 .git/.hg 标记
      const native = yield* fs.up({ targets: [".git", ".hg"], start: directory, mode: "first" }).pipe(
        // 只取第一个匹配
        Effect.map((matches) => matches[0]),
        // 失败视为无标记
        Effect.orElseSucceed(() => undefined),
      )
      // 找到 .git 时走 git 发现（含指纹缓存）
      if (native && path.basename(native) === ".git") {
        // .git 路径
        const dotGit = AbsolutePath.make(native)
        // 计算仓库元数据指纹（HEAD 等变化时指纹变化）
        const fingerprint = yield* git.repo.fingerprint(dotGit)
        // 缓存键：路径 + NUL + 指纹
        const key = `${dotGit}\u0000${fingerprint}`
        // 有指纹时查缓存；发现结果不可缓存时顺手失效
        const discovered = fingerprint
          ? yield* Cache.get(gitCache, key).pipe(
              // 不可缓存的条目立即失效
              Effect.tap((entry) => (entry.cacheable ? Effect.void : Cache.invalidate(gitCache, key))),
            )
          // 无指纹（异常仓库）时现场发现
          : yield* gitDiscover(dotGit)
        // 发现成功则保存并返回
        if (discovered.resolved) return yield* save(discovered.resolved)
      }

      // 找到 .hg 时走 hg 发现
      const hg = native && path.basename(native) === ".hg" ? yield* hgDiscover(AbsolutePath.make(native)) : undefined
      // hg 项目：规范目录就是工作树
      if (hg) {
        // 保存并返回
        return yield* save({
          // 展开 hg 结果
          ...hg,
          // 规范目录 = 工作树
          canonical: hg.directory,
        })
      }

      // 无版本控制：按目录哈希派生身份
      return yield* save({
        // ID：目录路径的快速哈希
        id: ID.make(Hash.fast(`directory:${directory}`)),
        // 当前目录
        directory,
        // 规范目录即自身
        canonical: directory,
        // 无版本控制
        vcs: undefined,
      })
    })

    // sweep：归档所有已知目录都消失的项目
    const sweep = Effect.fn("Project.sweep")(function* () {
      // 截止时间：现在减去清扫周期
      const cutoff = Date.now() - Duration.toMillis(SWEEP_INTERVAL)
      // Projects touched since the cutoff are left alone. Checking again in the update means a
      // resolve that moves the canonical directory mid-sweep bumps time_updated and wins.
      // idle：截止后被触碰的项目不动。更新时再查一次条件，
      // 意味着清扫途中移动规范目录的 resolve 会抬高 time_updated 而获胜。
      const idle = and(
        // 未归档
        isNull(ProjectTable.time_archived),
        // 更新时间早于截止
        lt(ProjectTable.time_updated, cutoff),
        // 活动时间早于截止
        lt(ProjectTable.time_active, cutoff),
      )
      // 查询候选空闲项目
      const projects = yield* db
        // 取 ID 与规范目录
        .select({ id: ProjectTable.id, canonical: ProjectTable.worktree })
        // 项目表
        .from(ProjectTable)
        // 空闲且非全局项目
        .where(and(idle, ne(ProjectTable.id, ID.global)))
        // 全部行
        .all()
        // 失败视为缺陷
        .pipe(Effect.orDie)
      // 读取全部工作树行（目录存在性判断用）
      const worktrees = yield* db.select().from(WorktreeTable).all().pipe(Effect.orDie)
      // Treat unreadable paths as present so transient filesystem errors never archive a Project.
      // exists：把不可读路径视为存在，瞬时文件系统错误绝不归档项目
      const exists = (directory: AbsolutePath) => fs.exists(directory).pipe(Effect.orElseSucceed(() => true))
      // 并发 8 个逐项目处理
      yield* Effect.forEach(
        // 项目列表
        projects,
        // 单个项目的清扫
        Effect.fnUntraced(function* (project) {
          // 规范目录还在则跳过
          if (yield* exists(project.canonical)) return
          // 该项目的其他已知目录（不含规范目录本身）
          const known = worktrees.filter(
            // 项目匹配且目录不同
            (item) => item.project_id === project.id && item.directory !== project.canonical,
          )
          // 逐个检查存活
          const surviving = yield* Effect.filter(known, (item) => exists(item.directory))
          // Linked worktrees carry a strategy; only another main checkout can become the canonical directory.
          // main：链接工作树带策略；只有另一个主检出能成为新规范目录
          const main = surviving.find((item) => !item.strategy)
          // 有链接工作树存活但没有主检出：保持现状（不能把链接目录提为规范）
          if (!main && surviving.length) return
          // 更新项目行（条件再次校验 idle，防止清扫途中项目复活）
          const row = yield* db
            // 项目表
            .update(ProjectTable)
            // 有主检出则迁移规范目录；否则归档（time_updated 不动）
            .set(
              main
                ? { worktree: main.directory }
                : { time_archived: Date.now(), time_updated: sql`${ProjectTable.time_updated}` },
            )
            // 匹配 ID 且仍空闲
            .where(and(eq(ProjectTable.id, project.id), idle))
            // 返回更新行
            .returning()
            // 取单行
            .get()
            // 失败视为缺陷
            .pipe(Effect.orDie)
          // 有更新时广播事件
          if (row) yield* bus.publish(ProjectSchema.Event.Updated, fromRow(row))
        }),
        // 并发 8，丢弃结果
        { concurrency: 8, discard: true },
      )
    })

    // 返回服务实现
    return Service.of({ list, update, activate, resolve, sweep })
  }),
)

// configured：按选项构建全局节点
export function configured(options?: Options) {
  // 组装全局节点
  return makeGlobalNode({
    // 服务类型
    service: Service,
    // 有自定义 now 时覆盖 Now 引用
    layer: options?.now ? layer.pipe(Layer.provide(Layer.succeed(Now, options.now))) : layer,
    // 依赖节点
    deps: [Bus.node, Database.node, FSUtil.node, Git.node, AppProcess.node],
  })
}

// node：默认配置的 Project 节点
export const node = configured()

// sweepNode：项目归档清扫节点——启动后每 1 小时后台清扫一次
export const sweepNode = makeGlobalNode({
  // 节点名
  name: "project-archive-sweep",
  // 层：启动后台清扫协程后立即完成
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      // 获取项目服务
      const project = yield* Service
      // 循环清扫
      yield* project
        // 执行清扫
        .sweep()
        .pipe(
          // 失败仅记录日志
          Effect.ignoreCause({ log: "Error", message: "Project archive sweep failed" }),
          // 按 1 小时间隔重复
          Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)),
          // 后台 fork
          Effect.forkScoped,
        )
    }),
  ),
  // 依赖项目节点
  deps: [node],
})
