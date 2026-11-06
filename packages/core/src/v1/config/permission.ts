// 将本文件的所有导出聚合到命名空间 ConfigPermissionV1 下，供统一引入
export * as ConfigPermissionV1 from "./permission.js"

// effect 库：Schema 校验、SchemaGetter 自定义编解码
import { Schema, SchemaGetter } from "effect"

// 权限动作 Schema：询问/允许/拒绝
export const Action = Schema.Literals(["ask", "allow", "deny"]).annotate({ identifier: "PermissionActionConfig" })
// Action 的 TypeScript 类型
export type Action = Schema.Schema.Type<typeof Action>

// Permission rules are last-match-wins, so the order an author writes keys in is policy. Effect
// leaves the key order of decoded objects unspecified but keeps array order, so these objects
// decode to entries read directly from the input.
// 权限规则"后匹配优先"，键的书写顺序即策略；effect 不保证对象键序但保持数组顺序，
// 因此把对象解码为直接来自输入的键值对数组
export const Entries = <A, I>(value: Schema.Codec<A, I>) =>
  // 校验必须是对象（排除数组）
  Schema.ObjectKeyword.check(
    Schema.makeFilter((input) => !globalThis.Array.isArray(input), { expected: "an object" }),
  ).pipe(
    // 解码为 [键, 值] 元组数组，保留输入顺序
    Schema.decodeTo(Schema.Array(Schema.Tuple([Schema.String, value])), {
      // 解码侧：把对象转为键值对数组
      decode: SchemaGetter.transform((input) => globalThis.Object.entries(input)),
      // 编码侧：把键值对数组还原为对象
      encode: SchemaGetter.transform((entries) => globalThis.Object.fromEntries(entries)),
    }),
  )

// 权限对象 Schema：键到动作的有序映射
export const Object = Entries(Action).annotate({ identifier: "PermissionObjectConfig" })
// Object 的 TypeScript 类型
export type Object = Schema.Schema.Type<typeof Object>

// 权限规则 Schema：动作或嵌套的权限对象
export const Rule = Schema.Union([Action, Object]).annotate({ identifier: "PermissionRuleConfig" })
// Rule 的 TypeScript 类型
export type Rule = Schema.Schema.Type<typeof Rule>

// 只支持动作（不支持嵌套对象）的权限键集合
const actionOnly = new Set(["question", "websearch", "doom_loop"])

// 权限配置 Schema：字符串简写或完整的键值规则表
export const Info = Schema.Union([Action, Schema.ObjectKeyword])
  .pipe(
    // 解码为键值对数组：字符串简写展开为 { "*": 动作 }
    Schema.decodeTo(Entries(Rule), {
      // 解码侧：字符串 → 全局通配规则
      decode: SchemaGetter.transform((input) => (typeof input === "string" ? { "*": input } : input)),
      // 编码侧：宽松透传
      encode: SchemaGetter.passthrough({ strict: false }),
    }),
  )
  // 校验：actionOnly 中的键必须是字符串动作（不允许嵌套对象）
  .check(
    Schema.makeFilter((rules) => rules.every(([key, rule]) => !actionOnly.has(key) || typeof rule === "string"), {
      expected: "question, websearch, and doom_loop to be ask, allow, or deny",
    }),
  )
  // 标注 Schema 标识符
  .annotate({ identifier: "PermissionConfig" })
// Info 的 TypeScript 类型
export type Info = Schema.Schema.Type<typeof Info>
