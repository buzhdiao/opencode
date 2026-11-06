/* oxlint-disable */
// 导入 Column（列实体）与 getColumnTable（取列所属的表）
import { Column, getColumnTable } from "drizzle-orm/column"
// 导入 is：drizzle 的运行时实体类型判断工具
import { is } from "drizzle-orm/entity"
// 仅导入类型：JoinNullability（连接可空性映射类型）
import type { JoinNullability } from "drizzle-orm/query-builders/select.types"
// 导入 Param（驱动参数包装）与 SQL（SQL 片段实体）
import { Param, SQL } from "drizzle-orm/sql/sql"
// 仅导入类型：SelectedFieldsOrdered（按顺序排列的选中字段）
import type { SelectedFieldsOrdered } from "drizzle-orm/sqlite-core/query-builders/select.types"
// 仅导入类型：SQLiteUpdateSetSource（SQLite 更新语句的 SET 值来源）
import type { SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core/query-builders/update"
// 仅导入类型：SQLiteTable（SQLite 表实体）
import type { SQLiteTable } from "drizzle-orm/sqlite-core/table"
// 导入 SQLiteViewBase（SQLite 视图基类）
import { SQLiteViewBase } from "drizzle-orm/sqlite-core/view-base"
// 导入 Subquery（子查询实体）
import { Subquery } from "drizzle-orm/subquery"
// 导入 Table（表实体基类）与 getTableName（取表名）
import { Table, getTableName } from "drizzle-orm/table"
// 仅导入类型：UpdateSet（更新集合类型）
import type { UpdateSet } from "drizzle-orm/utils"
// 导入 ViewBaseConfig：视图实体上保存选中字段的符号键
import { ViewBaseConfig } from "drizzle-orm/view-common"

// 取出 Table 类内部的符号表（Columns/IsAlias/Name/BaseName）：
// 这些符号未在公共类型上暴露，只能先把 Table 断言成带 Symbol 字段的对象再读取
const TableSymbol = (
  Table as unknown as {
    Symbol: { Columns: symbol; IsAlias: symbol; Name: symbol; BaseName: symbol }
  }
).Symbol

// 运行时读取表的全部列定义：通过 Table 的 Columns 符号键访问（公共 API 不暴露此映射）
export function getTableColumnsRuntime(table: SQLiteTable) {
  // 把表断言为以 symbol 为键的对象后取列映射
  return (table as unknown as Record<symbol, Record<string, Column>>)[TableSymbol.Columns]
}

// 运行时读取视图的选中字段与名称：通过 ViewBaseConfig 符号键访问视图内部配置
export function getViewSelectedFieldsRuntime(view: SQLiteViewBase) {
  // 断言后按符号键取视图配置对象
  return (view as unknown as Record<symbol, { selectedFields: Record<string, unknown>; name: string }>)[ViewBaseConfig]
}

// 检测运行时是否真的允许用 new Function 动态编译（JIT 映射器依赖它）：
// 某些环境（如 workerd/边缘运行时）禁止动态求值，此时必须退回普通映射器
export function jitCompatCheck(isEnabled: boolean | undefined) {
  // 配置未启用 JIT 时直接返回 false，无需探测
  if (!isEnabled) return false
  try {
    // 尝试动态编译并执行一个恒等函数：能通过说明环境支持动态求值
    return new Function("input", '"use strict"; return input;')(true) === true
  } catch {
    // 动态求值被禁用（抛错）则返回 false，回退到非 JIT 路径
    return false
  }
}

// 把字段对象展平为有序的字段列表：递归处理嵌套对象/子查询/表，路径记录了每层的键名
export function orderSelectedFields<TColumn extends Column>(
  fields: Record<string, unknown>,
  pathPrefix?: string[],
): SelectedFieldsOrdered {
  // 遍历字段的键值对并展平收集
  return Object.entries(fields).flatMap(([name, field]) => {
    // 当前字段的完整路径：前缀路径加上本层键名
    const path = pathPrefix ? [...pathPrefix, name] : [name]
    // 普通列：标记为 Column 类型
    if (is(field, Column)) return [{ path, field, fieldType: "Column", column: field }] as SelectedFieldsOrdered
    // SQL 片段：标记为 SQL 类型
    if (is(field, SQL)) return [{ path, field, fieldType: "SQL" }] as SelectedFieldsOrdered
    // 带别名的 SQL 片段：标记为 SQL.Aliased 类型
    if (is(field, SQL.Aliased)) return [{ path, field, fieldType: "SQL.Aliased" }] as SelectedFieldsOrdered
    // 子查询：标记为 Subquery 类型
    if (is(field, Subquery)) return [{ path, field, fieldType: "Subquery" }] as SelectedFieldsOrdered
    // 表：递归展开该表的列，路径以上一层为前缀
    if (is(field, Table)) return orderSelectedFields(getTableColumnsRuntime(field as SQLiteTable), path)
    // 其余视为嵌套字段对象：继续递归展开
    return orderSelectedFields(field as Record<string, unknown>, path)
  }) as SelectedFieldsOrdered
}

// 计算“因连接可能为空而需要整对象置 null”的顶层键列表：
// columns 为选中字段，joinsNotNullableMap 记录各连接是否可为空
export function resolveNullableObjectPaths(
  columns: SelectedFieldsOrdered,
  joinsNotNullableMap: Record<string, boolean> | undefined,
) {
  // 没有连接可空性信息时无从判断，返回 undefined
  if (!joinsNotNullableMap) return undefined
  // 从多级路径的列字段推导：每个顶层键对应的表名；同一键下出现不同表名则记为 false（不确定）
  const tableOf = columns
    // 只关心嵌套（路径长度>1）且类型为列的字段
    .filter((column) => column.path.length > 1 && column.fieldType === "Column")
    // 用 reduce 归并出 顶层键 -> 表名（或 false）的映射
    .reduce<Record<string, string | false>>((result, column) => {
      // 顶层键为路径首段
      const key = column.path[0]!
      // 取该列所属表的真实表名
      const tableName = getTableName(getColumnTable(column.field as Column))
      // 读取该键当前已记录的表名
      const current = result[key]
      // 首次出现记下表名；与已有表名相同则保持；不同则置 false 表示键下混有多表
      result[key] = current === undefined ? tableName : current === tableName ? current : false
      // 返回累积结果
      return result
    }, {})
  // 过滤出“键对应单一表名，且该表在连接中可为空”的顶层键，返回键名数组
  return Object.entries(tableOf)
    .filter(([, tableName]) => typeof tableName === "string" && !joinsNotNullableMap[tableName])
    .map(([key]) => key)
}

// 把更新语句的 values 对象映射为驱动可接受的 UpdateSet：
// 过滤 undefined 值，普通值包装为 Param 并绑定目标列（以便驱动侧做类型转换）
export function mapUpdateSet<TTable extends SQLiteTable>(table: TTable, values: SQLiteUpdateSetSource<TTable>) {
  // 收集非 undefined 的键值对
  const entries = Object.entries(values).filter(([, value]) => value !== undefined)
  // 一个可写值都没有则直接报错，避免生成非法 SQL
  if (entries.length === 0) throw new Error("No values to set")

  // 逐项包装：SQL 片段或列引用原样保留；普通值包装为 Param 并指定目标列
  return Object.fromEntries(
    entries.map(([key, value]) => [
      key,
      is(value, SQL) || is(value, Column) ? value : new Param(value, getTableColumnsRuntime(table)[key]),
    ]),
  ) as UpdateSet
}

// 把数据库返回的一行原始数据映射为嵌套对象结果：
// columns 为有序字段描述，row 为原始行，joinsNotNullableMap 用于连接空值推断
export function mapResultRow(
  columns: SelectedFieldsOrdered,
  row: unknown[],
  joinsNotNullableMap: Record<string, boolean> | undefined,
) {
  // 空值推断记录：顶层键 -> 表名（或 false 表示混有多表）
  const nullifyMap: Record<string, string | false> = {}
  // 最终的嵌套结果对象
  const result: Record<string, unknown> = {}

  // 按列顺序逐个解码并写入结果对象
  columns.forEach((column, columnIndex) => {
    // 取该字段的解码器：普通列自带；SQL 片段/子查询/别名列从其 sql 字段的 decoder 上取
    const decoder = (
      is(column.field, Column)
        ? column.field
        : is(column.field, SQL)
          ? (column.field as unknown as { decoder: { mapFromDriverValue(value: unknown): unknown } }).decoder
          : is(column.field, Subquery)
            ? (column.field._.sql as unknown as { decoder: { mapFromDriverValue(value: unknown): unknown } }).decoder
            : (column.field.sql as unknown as { decoder: { mapFromDriverValue(value: unknown): unknown } }).decoder
    ) as {
      mapFromDriverValue(value: unknown): unknown
    }
    // 取该列在原始行中的值
    const rawValue = row[columnIndex]
    // NULL 保留为 null，其余经解码器从驱动值映射为应用值
    const value = rawValue === null ? null : decoder.mapFromDriverValue(rawValue)
    // 该字段结果的顶层键名（通常是表别名或根字段名）
    const objectName = column.path[0]
    // 游标：从结果根开始沿路径下钻
    let node = result

    // 沿路径逐段写入：最后一段放值，中间段确保是对象并下钻
    column.path.forEach((pathChunk, pathChunkIndex) => {
      // 已到最后一段：把解码后的值写入该键并结束
      if (pathChunkIndex === column.path.length - 1) {
        node[pathChunk] = value
        return
      }
      // 中间段：若尚未存在则初始化为空对象，然后游标下钻
      node[pathChunk] = (node[pathChunk] ?? {}) as Record<string, unknown>
      node = node[pathChunk] as Record<string, unknown>
    })

    // 对来自连接表、路径为“别名.列”两段的普通列做可空性推断
    if (joinsNotNullableMap && is(column.field, Column) && column.path.length === 2 && objectName) {
      // 取列所属表的真实表名
      const tableName = getTableName(getColumnTable(column.field))
      // 推断规则：首次遇到 null 记下表名；已记录表名但再次遇到不同表名的值则置 false；否则保持原值
      nullifyMap[objectName] =
        !(objectName in nullifyMap) && value === null
          ? tableName
          : typeof nullifyMap[objectName] === "string" && nullifyMap[objectName] !== tableName
            ? false
            : nullifyMap[objectName]
    }
  })

  // 对推断出的可空连接对象做整体置 null：左连接未匹配时整个对象应为 null 而非含 null 字段的对象
  Object.entries(nullifyMap).forEach(([objectName, tableName]) => {
    // 仅当键对应单一表名、且该表在连接可空性表中标记为可空时才置 null
    if (typeof tableName === "string" && !joinsNotNullableMap?.[tableName]) result[objectName] = null
  })

  // 返回组装完成的嵌套结果对象
  return result
}

// 解析表类实体（表/子查询/视图/SQL 片段）对应的名称：
// 子查询取别名，视图取其配置名，SQL 片段无名称，表按是否为别名取 Name 或 BaseName
export function getTableLikeName(table: SQLiteTable | Subquery | SQLiteViewBase | SQL) {
  // 子查询：返回内部别名
  if (is(table, Subquery)) return table._.alias
  // 视图：从视图运行时配置里取名称
  if (is(table, SQLiteViewBase)) return getViewSelectedFieldsRuntime(table).name
  // SQL 片段：没有对应的表名
  if (is(table, SQL)) return undefined
  // 表：按 IsAlias 符号判断是否别名，别名取 Name，否则取 BaseName（原始表名）
  return (table as unknown as Record<symbol, string | boolean>)[
    (table as unknown as Record<symbol, string | boolean>)[TableSymbol.IsAlias]
      ? TableSymbol.Name
      : TableSymbol.BaseName
  ] as string
}

// 转发导出类型 JoinNullability，供外部使用
export type { JoinNullability }
