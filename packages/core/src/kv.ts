// 将本模块以命名空间（namespace）KV 的形式整体再导出，供其他模块以 KV.xxx 的方式引用
export * as KV from "./kv.js"

// 从 drizzle-orm 引入查询构造辅助函数：and(与)、asc(升序)、eq(等于)、gt(大于)、gte(大于等于)、lt(小于)
import { and, asc, eq, gt, gte, lt } from "drizzle-orm"
// 引入 Effect 库的 Context(上下文)、Effect(效果)、Layer(层) 与 Schema(模式) 工具
import { Context, Effect, Layer, Schema } from "effect"
// 引入数据库服务（Database），为键值存储提供底层连接
import { Database } from "./database/database.js"
// 引入全局节点构造器，用于把本服务注册成应用级单例节点
import { makeGlobalNode } from "@opencode/util/effect/app-node"
// 引入 KV 表定义（KVTable），描述键值表的列结构
import { KVTable } from "./kv/sql.js"

// 定义 Value 类型：Schema.Json 表示任意可序列化为 JSON 的值
export type Value = Schema.Json

// 定义单个键值（key-value）条目（Entry）接口：key 为键名，value 为对应值
export interface Entry {
  readonly key: string
  readonly value: Value
}

// 定义扫描（scan）选项接口：prefix 为键前缀，after 为分页起点（该键之后），limit 为数量上限
export interface ScanOptions {
  readonly prefix: string
  readonly after?: string
  readonly limit?: number
}

// 定义扫描结果接口：entries 为条目列表，next 为下一页游标（cursor），即本页最后一个键
export interface ScanResult {
  readonly entries: readonly Entry[]
  readonly next?: string
}

// 定义服务接口（Interface）：get 读、set 写、remove 删、scan 分页扫描，全部返回 Effect 描述
export interface Interface {
  readonly get: (key: string) => Effect.Effect<Value | undefined>
  readonly set: (key: string, value: Value) => Effect.Effect<void>
  readonly remove: (key: string) => Effect.Effect<void>
  readonly scan: (options: ScanOptions) => Effect.Effect<ScanResult>
}

// 定义 KV 服务类：用 Context.Service 生成标识为 "@opencode/KV" 的服务标记类型
export class Service extends Context.Service<Service, Interface>()("@opencode/KV") {}

// 构建服务实现层（layer）：把 Service 绑定到基于数据库的具体实现
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 从数据库服务中取出底层数据库实例 db
    const db = (yield* Database.Service).db
    // 返回 Service 的具体实现对象，逐个实现四个方法
    return Service.of({
      // get 方法：按 key 查询单个值
      get: Effect.fn("KV.get")(function* (key) {
        // 查询 KVTable 中 key 匹配行的 value 列；orDie 把查询错误转为致命错误（直接失败）
        return (yield* db
          .select({ value: KVTable.value })
          .from(KVTable)
          .where(eq(KVTable.key, key))
          .get()
          .pipe(Effect.orDie))?.value
      }),
      // set 方法：写入键值，键已存在时改为更新
      set: Effect.fn("KV.set")(function* (key, value) {
        // 执行 upsert：插入 {key, value}，主键冲突时仅更新 value 并刷新 time_updated 时间戳
        yield* db
          .insert(KVTable)
          .values({ key, value })
          .onConflictDoUpdate({ target: KVTable.key, set: { value, time_updated: Date.now() } })
          .run()
          .pipe(Effect.orDie)
      }),
      // remove 方法：删除指定 key 的记录
      remove: Effect.fn("KV.remove")(function* (key) {
        // 按 key 条件执行删除语句，错误同样 orDie 处理
        yield* db.delete(KVTable).where(eq(KVTable.key, key)).run().pipe(Effect.orDie)
      }),
      // scan 方法：按前缀分页扫描键值对
      scan: Effect.fn("KV.scan")(function* (options) {
        // 归一化 limit：NaN 时取默认 100；否则向下取整并夹在 [1, 1000] 区间内
        const limit = Number.isNaN(options.limit) ? 100 : Math.min(Math.max(Math.floor(options.limit ?? 100), 1), 1000)
        // 计算前缀的上界（prefixEnd）：字典序中刚好越过该前缀的位置，用于圈定扫描范围
        const end = prefixEnd(options.prefix)
        // 查询 key 与 value 两列；条件为 key >= prefix、key < 上界、key > after（三者均可选）
        const rows = yield* db
          .select({ key: KVTable.key, value: KVTable.value })
          .from(KVTable)
          .where(
            and(
              // 前缀非空时要求 key >= prefix；为空则传 undefined（drizzle 会忽略空条件）
              options.prefix === "" ? undefined : gte(KVTable.key, options.prefix),
              // 上界存在时要求 key < end，排除其他前缀的键
              end === undefined ? undefined : lt(KVTable.key, end),
              // 指定 after 时要求 key > after，实现分页时跳过已读部分
              options.after === undefined ? undefined : gt(KVTable.key, options.after),
            ),
          )
          // 按 key 升序排序，保证扫描顺序稳定
          .orderBy(asc(KVTable.key))
          // 多取一条（limit+1），用于判断是否还有下一页
          .limit(limit + 1)
          .all()
          .pipe(Effect.orDie)
        // 截取前 limit 条作为本页结果
        const entries = rows.slice(0, limit)
        // 若取到的行数不超过 limit，说明数据已读尽，返回结果且不带 next
        if (rows.length <= limit) return { entries }
        // 否则用本页最后一条的 key 作为 next 游标返回
        return { entries, next: entries[entries.length - 1].key }
      }),
    })
  }),
)

// 辅助函数：计算 prefix 的“结束边界”——把最后一个可递增的码点加一，得到字典序刚好越过该前缀的字符串
function prefixEnd(prefix: string) {
  // 按 Unicode 码点把字符串拆成数组（避免代理对 surrogate pair 被拆散）
  const points = Array.from(prefix)
  // 从后往前找第一个码点小于最大值 0x10ffff 的字符位置
  const index = points.findLastIndex((value) => value.codePointAt(0)! < 0x10ffff)
  // 整个前缀全为 0x10ffff 时无法再递增，返回 undefined 表示没有上界
  if (index < 0) return undefined
  // 截取该位置之前的字符，并把该位置码点加一后拼接，得到上界字符串
  return `${points.slice(0, index).join("")}${String.fromCodePoint(points[index].codePointAt(0)! + 1)}`
}

// 导出全局节点（node）：把 KV 服务层与 Database 依赖组装成可挂载的应用节点
export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
