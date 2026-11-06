// 从共享 schema 包导入通用类型与工具
import {
  AbsolutePath,
  DateTimeUtcFromMillis,
  NonNegativeInt,
  optional,
  PositiveInt,
  RelativePath,
  statics,
} from "@opencode/schema/schema"

// 转发导出这些通用 schema 工具，方便同包内以 "./schema.js" 引用
export { AbsolutePath, DateTimeUtcFromMillis, NonNegativeInt, optional, PositiveInt, RelativePath, statics }

/**
 * Strip `readonly` from a nested type. Stand-in for `effect`'s `Types.DeepMutable`
 * until `effect:core/x228my` ("Types.DeepMutable widens unknown to `{}`") lands.
 *
 * The upstream version falls through `unknown` into `{ -readonly [K in keyof T]: ... }`
 * where `keyof unknown = never`, so `unknown` collapses to `{}`. This local
 * version gates the object branch on `extends object` (which `unknown` does
 * not) so `unknown` passes through untouched.
 *
 * Primitive bailout matches upstream — without it, branded strings like
 * `string & Brand<"SessionID">` fall into the object branch and get their
 * prototype methods walked.
 *
 * Tuple branch preserves readonly tuples (e.g. `ConfigPlugin.Spec`'s
 * `readonly [string, Options]`); the general array branch would otherwise
 * widen them to unbounded arrays.
 */
// 说明：递归去除嵌套类型的 readonly 修饰。作为 effect 库 Types.DeepMutable 的
// 临时替代，直到上游修复（unknown 会被上游版本收窄为 {}）合入。
// 上游版本会让 unknown 落入对象分支（keyof unknown = never），从而折叠成 {}；
// 本地版本用 extends object 约束对象分支，unknown 得以原样通过。
// 原始类型短路也与上游一致——否则品牌字符串（branded string）会进入对象
// 分支并被遍历原型方法。
// 元组分支保留只读元组（如 ConfigPlugin.Spec 的 readonly [string, Options]）；
// 若走通用数组分支会被扩大为无界数组。
// eslint-disable-next-line @typescript-eslint/ban-types
// 条件类型：按 T 的形态递归去除 readonly
export type DeepMutable<T> = T extends string | number | boolean | bigint | symbol | Function
  ? T
  : T extends readonly [unknown, ...unknown[]]
    ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
    : T extends readonly (infer U)[]
      ? DeepMutable<U>[]
      : T extends object
        ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
        : T
