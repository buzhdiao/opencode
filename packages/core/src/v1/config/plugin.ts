// 将本文件的所有导出聚合到命名空间 ConfigPluginV1 下，供统一引入
export * as ConfigPluginV1 from "./plugin.js"

// effect 库：Schema 数据校验
import { Schema } from "effect"

// 插件选项 Schema：任意键到未知值的记录
export const Options = Schema.Record(Schema.String, Schema.Unknown)
// Options 的 TypeScript 类型
export type Options = Schema.Schema.Type<typeof Options>

// 插件声明 Schema：字符串（插件名/路径）或 [名称, 选项] 元组
export const Spec = Schema.Union([Schema.String, Schema.mutable(Schema.Tuple([Schema.String, Options]))])
// Spec 的 TypeScript 类型
export type Spec = Schema.Schema.Type<typeof Spec>
