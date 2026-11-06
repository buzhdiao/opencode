// 将本模块以命名空间形式整体导出为 DatabaseBatch，方便调用方以 DatabaseBatch.xxx 引用
export * as DatabaseBatch from "./batch.js"

// 从 drizzle-orm 导入 getTableColumns（取表的全部列定义）以及 Table 类型
import { getTableColumns, type Table } from "drizzle-orm"

/** Durable Object SQLite rejects a statement that binds more than 100 parameters, so every runtime stays under it. */
// 单条语句可绑定的参数上限：Durable Object 的 SQLite 最多接受 100 个绑定参数，因此所有运行时都不得超过该值
export const MaxBoundParameters = 100

/**
 * Splits `items` into batches whose statement binds at most {@link MaxBoundParameters}: `perItem` parameters for each
 * item (a multi-row insert binds one per column) plus `fixed` for the rest of the statement.
 */
// 将 items 切分成若干批，使每批语句的绑定参数总数不超过 MaxBoundParameters：
// perItem 为每个元素占用的参数个数（多行插入时每行每列各占一个），fixed 为语句其余部分固定占用的参数个数
export const batches = <T>(items: ReadonlyArray<T>, perItem: number, fixed = 0): Array<Array<T>> => {
  // 计算每批可容纳的元素个数：可用参数配额（上限减去固定开销）除以每元素参数数，向下取整且至少为 1
  const size = Math.max(1, Math.floor((MaxBoundParameters - fixed) / perItem))
  // 按每批 size 个元素生成批次数组：批数为元素总数除以 size 向上取整，每批用 slice 切出对应区间
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size),
  )
}

/** {@link batches} for a multi-row insert into `table`, which binds one parameter per column of each row. */
// 针对向 table 表做多行插入的 batches 封装：每行绑定的参数数即表的列数（每列一个参数）
export const insertBatches = <T>(table: Table, rows: ReadonlyArray<T>, fixed = 0) =>
  // 以表的列数作为 perItem 调用通用切批逻辑
  batches(rows, Object.keys(getTableColumns(table)).length, fixed)
