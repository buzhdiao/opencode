// 将本模块整体导出为 Form 命名空间（自导出，供其他模块以 Form.xxx 的形式引用）
export * as Form from "./form.js"

// 引入 @opencode/schema/form 中定义的表单（form）模式（schema）与各类型
import { Form } from "@opencode/schema/form"
// 引入 Effect 库的缓存（Cache）、上下文（Context）、延迟值（Deferred）、时长、Effect、Exit、Layer、Schema 等工具
import { Cache, Context, Deferred, Duration, Effect, Exit, Layer, Option, Schema } from "effect"
// 引入"按目录（location）装配服务节点"的辅助构造器
import { makeLocationNode } from "@opencode/util/effect/app-node"
// 引入事件总线（bus）服务，用于发布表单生命周期事件
import { Bus } from "./bus.js"

// 已终结表单在缓存中的保留时长：10 分钟（到期后由缓存自动清除）
const RETENTION = Duration.minutes(10)

// 表单 ID 的模式（直接复用 schema 中的定义）
export const ID = Form.ID
// 表单 ID 的 TypeScript 类型
export type ID = typeof ID.Type

// 表单完整信息（标题、所属会话、字段等）的模式
export const Info = Form.Info
// 表单完整信息的类型
export type Info = typeof Info.Type

// 单个表单字段
export const Field = Form.Field
// 单个表单字段的类型
export type Field = Form.Field

// 表单字段列表
export const Fields = Form.Fields
// 表单字段列表的类型
export type Fields = Form.Fields

// 字段显示条件（依据其他字段的取值决定是否展示）
export const When = Form.When
// 字段显示条件的类型
export type When = Form.When

// 表单状态：pending（等待回答）/ answered（已回答）/ cancelled（已取消）
export const State = Form.State
// 表单状态的类型
export type State = typeof State.Type
// 终结状态（terminal state）：State 中去掉 pending 后的子集，即已回答或已取消
export type TerminalState = Exclude<State, { readonly status: "pending" }>

// 用户答案（answer）：字段键到值的映射
export const Answer = Form.Answer
// 用户答案的类型
export type Answer = typeof Answer.Type

// 回复事件负载
export const Reply = Form.Reply
// 回复事件负载的类型
export type Reply = typeof Reply.Type

// 原样转发表单相关事件定义（Created/Replied/Cancelled 等）
export { Event } from "@opencode/schema/form"

// 错误类：找不到指定 ID 的表单
export class NotFoundError extends Schema.TaggedError<NotFoundError>()("Form.NotFoundError", {
  id: ID,
}) {
  // 错误消息：带表单 ID 便于定位
  override get message() {
    return `Form not found: ${this.id}`
  }
}

// 错误类：表单已被回复或取消（已终结），不能再操作
export class AlreadySettledError extends Schema.TaggedError<AlreadySettledError>()("Form.AlreadySettledError", {
  id: ID,
}) {
  override get message() {
    return `Form already settled: ${this.id}`
  }
}

// 错误类：创建时同 ID 表单已存在
export class AlreadyExistsError extends Schema.TaggedError<AlreadyExistsError>()("Form.AlreadyExistsError", {
  id: ID,
}) {
  override get message() {
    return `Form already exists: ${this.id}`
  }
}

// 错误类：答案未通过校验（message 说明具体原因）
export class InvalidAnswerError extends Schema.TaggedError<InvalidAnswerError>()("Form.InvalidAnswerError", {
  id: ID,
  message: Schema.String,
}) {}

// 错误类：表单定义本身非法（message 说明具体原因）
export class InvalidFormError extends Schema.TaggedError<InvalidFormError>()("Form.InvalidFormError", {
  message: Schema.String,
}) {}

// 创建表单的输入：Info 去掉必填 id，id 变为可选（缺省时自动生成）
export type CreateInput = Omit<Form.Info, "id"> & { readonly id?: ID }

// 回复表单的输入：表单 ID + 答案
export interface ReplyInput {
  readonly id: ID
  readonly answer: Answer
}

// 取消表单的可选项
export interface CancelOptions {
  // 取消时可附带说明消息
  readonly message?: string
}

// 列表查询的过滤条件：可按所属会话（session）ID 过滤
export interface ListInput {
  readonly sessionID?: Form.Info["sessionID"]
}

// 服务接口：声明 create/ask/get/list/state/reply/cancel/close 各方法的效果（Effect）签名
export interface Interface {
  // 关闭服务：取消所有仍处于 pending 的表单
  readonly close: Effect.Effect<void>
  // 创建表单；ID 已存在或定义非法时报错
  readonly create: (input: CreateInput) => Effect.Effect<Info, AlreadyExistsError | InvalidFormError>
  // 创建表单并等待其终结状态（回答或取消）
  readonly ask: (input: CreateInput) => Effect.Effect<TerminalState, AlreadyExistsError | InvalidFormError>
  // 按 ID 读取表单信息
  readonly get: (id: ID) => Effect.Effect<Info, NotFoundError>
  // 列出（可按会话过滤）当前未终结的表单
  readonly list: (input?: ListInput) => Effect.Effect<ReadonlyArray<Info>>
  // 读取表单当前状态
  readonly state: (id: ID) => Effect.Effect<State, NotFoundError>
  // 提交答案；表单已终结、答案非法或不存在时报错
  readonly reply: (input: ReplyInput) => Effect.Effect<void, AlreadySettledError | InvalidAnswerError | NotFoundError>
  // 取消表单；已终结或不存在时报错
  readonly cancel: (id: ID, options?: CancelOptions) => Effect.Effect<void, AlreadySettledError | NotFoundError>
}

// Effect Context 的服务标签（service tag），用于从环境中取出本服务
export class Service extends Context.Service<Service, Interface>()("@opencode/Form") {}

// 缓存条目：表单信息 + 当前状态 + 用于等待终结状态的延迟值（Deferred）
interface Entry {
  readonly form: Info
  readonly state: State
  readonly deferred: Deferred.Deferred<TerminalState>
}

// 构建服务实现的 Layer：全部真实逻辑都在这里
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 取得事件总线服务，用于发布表单事件
    const bus = yield* Bus.Service
    // 服务关闭标志：置位后新建的表单会被立即取消
    let closed = false
    // 以表单 ID 为键的缓存：
    // - 严禁直接 Cache.get（那是缺陷路径，会 die），必须走 getSuccess/set
    // - TTL 策略：pending 状态永久保留；已终结状态保留 RETENTION（10 分钟）后清除
    const forms = yield* Cache.makeWith<ID, Entry>(
      () => Effect.die(new Error("Form cache must be used via set/getSuccess, never get")),
      {
        capacity: Number.MAX_SAFE_INTEGER,
        timeToLive: (exit) =>
          Exit.isSuccess(exit) && exit.value.state.status === "pending" ? Duration.infinity : RETENTION,
      },
    )

    // 按 ID 取缓存条目；不存在则失败为 NotFoundError
    const requireEntry = Effect.fn("Form.requireEntry")((id: ID) =>
      Cache.getSuccess(forms, id).pipe(
        Effect.flatMap((entry) => Effect.fromOption(entry, () => new NotFoundError({ id }))),
      ),
    )

    // 创建表单（不可中断，保证写缓存与发事件原子完成）
    const create = Effect.fn("Form.create")((input: CreateInput) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          // 未指定 ID 时自动生成
          const id = input.id ?? ID.create()
          // 查重：同 ID 已存在则报错
          const existing = yield* Cache.getSuccess(forms, id)
          if (Option.isSome(existing)) return yield* new AlreadyExistsError({ id })
          // 校验字段定义（重复键、when 引用等），非法则报错
          const invalid = validateFields(input.fields)
          if (invalid) return yield* new InvalidFormError({ message: invalid })
          // 组装表单信息（metadata 仅在显式提供时写入）
          const form: Info = {
            id,
            sessionID: input.sessionID,
            title: input.title,
            ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
            fields: input.fields,
          }
          // 初始条目：pending 状态 + 尚未完成的延迟值
          const entry: Entry = {
            form,
            state: { status: "pending" },
            deferred: yield* Deferred.make<TerminalState>(),
          }
          // 写入缓存
          yield* Cache.set(forms, id, entry)
          // 发布 Created 事件；发布失败则回滚缓存，避免留下不可见的表单
          yield* bus.publish(Form.Event.Created, { form }).pipe(Effect.onError(() => Cache.invalidate(forms, id)))
          // 若服务已关闭，立即取消刚创建的表单
          if (closed) yield* cancel(id).pipe(Effect.orDie)
          return form
        }),
      ),
    )

    // 创建表单并挂起等待其终结状态（回答或取消）
    const ask = Effect.fn("Form.ask")((input: CreateInput) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          // 先创建表单
          const form = yield* create(input)
          // 取回缓存条目（刚创建必然存在，取不到视为缺陷）
          const entry = yield* requireEntry(form.id).pipe(Effect.orDie)
          // 恢复可中断性后等待延迟值完成；被中断（协程被取消）时顺手取消表单
          return yield* restore(Deferred.await(entry.deferred)).pipe(
            Effect.onInterrupt(() => Effect.ignore(cancel(form.id))),
          )
        }),
      ),
    )

    // 按 ID 读取表单信息
    const get = Effect.fn("Form.get")(function* (id: ID) {
      return (yield* requireEntry(id)).form
    })

    // 列出所有未终结的表单，可按会话 ID 过滤
    const list = Effect.fn("Form.list")(function* (input?: ListInput) {
      // 取出缓存中全部条目
      const entries = yield* Cache.values(forms)
      return Array.from(entries)
        // 只保留 pending（未终结）状态
        .filter((entry) => entry.state.status === "pending")
        // 未指定会话 ID 时不过滤
        .filter((entry) => input?.sessionID === undefined || entry.form.sessionID === input.sessionID)
        // 映射为表单信息
        .map((entry) => entry.form)
    })

    // 读取表单当前状态
    const state = Effect.fn("Form.state")(function* (id: ID) {
      return (yield* requireEntry(id)).state
    })

    // 回复表单（不可中断，保证事件发布、状态更新与唤醒等待者的原子性）
    const reply = Effect.fn("Form.reply")((input: ReplyInput) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          // 取条目，不存在报 NotFoundError
          const entry = yield* requireEntry(input.id)
          // 已终结（已回答/已取消）则不能再回复
          if (entry.state.status !== "pending") return yield* new AlreadySettledError({ id: input.id })
          // 校验答案（键存在性、字段可见性、类型与约束）
          const invalid = validateAnswer(entry.form.fields, input.answer)
          if (invalid) return yield* new InvalidAnswerError({ id: input.id, message: invalid })
          // 终结状态：已回答
          const next: TerminalState = { status: "answered", answer: input.answer }
          // 先发布 Replied 事件
          yield* bus.publish(Form.Event.Replied, {
            id: input.id,
            sessionID: entry.form.sessionID,
            answer: input.answer,
          })
          // 更新缓存中的状态
          yield* Cache.set(forms, input.id, { ...entry, state: next })
          // 完成延迟值，唤醒所有等待该表单的 ask 调用
          yield* Deferred.succeed(entry.deferred, next)
        }),
      ),
    )

    // 取消表单（不可中断）
    const cancel = Effect.fn("Form.cancel")((id: ID, options?: CancelOptions) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          // 取条目，不存在报 NotFoundError
          const entry = yield* requireEntry(id)
          // 已终结则不能再取消
          if (entry.state.status !== "pending") return yield* new AlreadySettledError({ id })
          // 终结状态：已取消（可附带说明消息）
          const next: TerminalState = {
            status: "cancelled",
            ...(options?.message === undefined ? {} : { message: options.message }),
          }
          // 发布 Cancelled 事件
          yield* bus.publish(Form.Event.Cancelled, { id, sessionID: entry.form.sessionID })
          // 更新缓存状态
          yield* Cache.set(forms, id, { ...entry, state: next })
          // 唤醒等待者
          yield* Deferred.succeed(entry.deferred, next)
        }),
      ),
    )

    // 关闭服务：先置关闭标志，再取消所有仍 pending 的表单（忽略单个取消失败）
    const close = Effect.sync(() => {
      closed = true
    }).pipe(
      // 取出全部缓存条目
      Effect.andThen(Cache.values(forms)),
      // 逐个取消 pending 表单
      Effect.flatMap((entries) =>
        Effect.forEach(
          Array.from(entries).filter((entry) => entry.state.status === "pending"),
          (entry) => cancel(entry.form.id).pipe(Effect.ignore),
          { discard: true },
        ),
      ),
    )
    // 把 close 注册为本层的终结器（finalizer）：层关闭时自动执行
    yield* Effect.addFinalizer(() => close)

    // 暴露服务实现
    return Service.of({ create, ask, get, list, state, reply, cancel, close })
  }),
)

// 包装为"按目录装配"的节点，依赖事件总线节点
export const node = makeLocationNode({ service: Service, layer, deps: [Bus.node] })

// 校验答案是否合法；返回 undefined 表示通过，否则返回错误说明字符串
export function validateAnswer(form: ReadonlyArray<Form.Field>, answer: Answer) {
  // 建立字段键到字段的映射
  const fields = new Map(form.map((field) => [field.key, field] as const))
  // 答案里出现的每个键都必须是已定义的字段
  for (const key of Object.keys(answer)) {
    if (!fields.has(key)) return `Unknown form field: ${key}`
  }
  // 逐字段校验
  for (const field of form) {
    // 取该字段的答案值
    const value = answer[field.key]
    // external 字段不是输入控件，只需被确认为 true
    if (field.type === "external") {
      if (value !== true) return `External form field must be acknowledged: ${field.key}`
      continue
    }
    // 判断字段在当前答案下是否可见
    const active = isActive(field, answer)
    // 值缺失时：必填且可见才报错，否则跳过
    if (value === undefined) {
      if (field.required && active) return `Missing required form field: ${field.key}`
      continue
    }
    // 提供了值但字段不可见：答案无效
    if (!active) return `Form field is not active: ${field.key}`
    // 按字段类型校验值本身
    const invalid = validateField(field, value)
    if (invalid) return invalid
  }
}

// 除 external 之外的输入型字段
type InputField = Exclude<Form.Field, Form.ExternalField>

// 字段是否可见：when 条件全部满足才可见；未声明 when 则恒可见
function isActive(field: InputField, answer: Answer) {
  if (!field.when) return true
  return field.when.every((when) => matches(when, answer[when.key]))
}

// An unanswered referenced field makes the condition false for both ops. Combined with inactive
// fields being unanswerable, this cascades: hiding a field falsifies every condition referencing it.
function matches(when: Form.When, value: Form.Value | undefined) {
  // 被引用字段未作答：条件不成立（无论 eq 还是 neq 都为假）
  if (value === undefined) return false
  // 值为数组时任一项命中即可，否则要求严格相等
  const hit = Array.isArray(value) ? value.some((item) => item === when.value) : value === when.value
  // eq 取命中结果，neq 取反
  return when.op === "eq" ? hit : !hit
}

// Create-time validation of `when` references: each condition must point at an earlier field,
// carry a value matching that field's type, and use a declared option when the field's options
// are closed. Rejecting these at creation surfaces authoring mistakes to the caller instead of
// silently never matching.
export function validateFields(fields: ReadonlyArray<Form.Field>) {
  // 至少要有一个字段
  if (fields.length === 0) return "Form must have at least one field"
  // 已出现过的输入字段（供 when 引用检查）
  const earlier = new Map<string, InputField>()
  // 已使用的字段键集合（查重用）
  const keys = new Set<string>()
  for (const field of fields) {
    // 字段键不允许重复
    if (keys.has(field.key)) return `Duplicate form field key: ${field.key}`
    keys.add(field.key)
    // external 字段不参与 when 引用检查
    if (field.type === "external") continue
    // 每个 when 条件都必须指向更早出现的字段，且取值合法
    for (const when of field.when ?? []) {
      // 找不到被引用的更早字段：非法
      const target = earlier.get(when.key)
      if (!target) return `Form field condition must reference an earlier field: ${field.key} -> ${when.key}`
      // 校验条件值与目标字段类型是否匹配
      const invalid = validateWhen(when, target)
      if (invalid) return `${invalid}: ${field.key} -> ${when.key}`
    }
    // 登记当前字段，供后续字段引用
    earlier.set(field.key, field)
  }
}

// 校验单个 when 条件的取值是否与目标字段类型匹配
function validateWhen(when: Form.When, target: InputField) {
  // 布尔字段：条件值必须是布尔
  if (target.type === "boolean") {
    if (typeof when.value !== "boolean") return "Form field condition value must be a boolean"
    return
  }
  // 数字/整数字段：条件值必须是数字
  if (target.type === "number" || target.type === "integer") {
    if (typeof when.value !== "number") return "Form field condition value must be a number"
    return
  }
  // string and multiselect targets both compare against string values
  // 字符串与多选字段都用字符串比较
  if (typeof when.value !== "string") return "Form field condition value must be a string"
  // 判断目标字段是否为"闭集"：多选看 custom 开关，单选看是否声明了选项且不允许自定义
  const closed = target.type === "multiselect" ? !target.custom : target.options !== undefined && !target.custom
  // 闭集字段的条件值必须取自选项列表
  if (closed && !target.options?.some((option) => option.value === when.value)) {
    return "Form field condition value must be one of the field's options"
  }
}

// 按字段类型校验单个值；返回 undefined 表示通过
function validateField(field: InputField, value: Form.Value): string | undefined {
  // 字符串字段：类型、长度、正则、格式与选项校验
  if (field.type === "string") {
    // 必须是字符串
    if (typeof value !== "string") return `Expected string for form field: ${field.key}`
    // 必填时不能为空串
    if (field.required && value.length === 0) return `Missing required form field: ${field.key}`
    // 最小长度约束
    if (field.minLength !== undefined && value.length < field.minLength) return `Form field is too short: ${field.key}`
    // 最大长度约束
    if (field.maxLength !== undefined && value.length > field.maxLength) return `Form field is too long: ${field.key}`
    // 正则约束（模式本身非法也报错）
    if (field.pattern !== undefined) {
      try {
        if (!new RegExp(field.pattern).test(value)) return `Form field does not match pattern: ${field.key}`
      } catch {
        return `Form field has invalid pattern: ${field.key}`
      }
    }
    // email 格式校验
    if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
      return `Expected email for form field: ${field.key}`
    // uri 格式校验
    if (field.format === "uri" && !URL.canParse(value)) return `Expected URI for form field: ${field.key}`
    // date 格式校验
    if (field.format === "date" && !isDate(value)) return `Expected date for form field: ${field.key}`
    // date-time 格式校验
    if (field.format === "date-time" && !isDateTime(value)) return `Expected date-time for form field: ${field.key}`
    // 闭集选项：不允许自定义时，值必须取自选项列表
    if (field.options && !field.custom && !field.options.some((option) => option.value === value)) {
      return `Invalid option for form field: ${field.key}`
    }
    return
  }
  // 数字/整数字段：类型、有限性、整数性与范围校验
  if (field.type === "number" || field.type === "integer") {
    // 必须是有限数字
    if (typeof value !== "number" || !Number.isFinite(value)) return `Expected number for form field: ${field.key}`
    // 整数字段额外要求整数值
    if (field.type === "integer" && !Number.isInteger(value)) return `Expected integer for form field: ${field.key}`
    // 下界约束
    if (field.minimum !== undefined && value < field.minimum) return `Form field is too small: ${field.key}`
    // 上界约束
    if (field.maximum !== undefined && value > field.maximum) return `Form field is too large: ${field.key}`
    return
  }
  // 布尔字段：类型校验
  if (field.type === "boolean") {
    if (typeof value !== "boolean") return `Expected boolean for form field: ${field.key}`
    return
  }
  // 多选字段：字符串数组、数量与选项校验
  if (field.type === "multiselect") {
    // 必须是字符串数组
    if (!isStringArray(value)) return `Expected string array for form field: ${field.key}`
    // 必填时至少选一项
    if (field.required && value.length === 0) return `Missing required form field: ${field.key}`
    // 最少选择数约束
    if (field.minItems !== undefined && value.length < field.minItems)
      return `Too few selections for form field: ${field.key}`
    // 最多选择数约束
    if (field.maxItems !== undefined && value.length > field.maxItems)
      return `Too many selections for form field: ${field.key}`
    // 不允许自定义时，每一项都必须是合法选项
    if (!field.custom && value.some((item) => !field.options.some((option) => option.value === item))) {
      return `Invalid option for form field: ${field.key}`
    }
  }
}

// 类型守卫：值是否为（只读）字符串数组
function isStringArray(value: Form.Value): value is ReadonlyArray<string> {
  return Array.isArray(value) && value.every((item): item is string => typeof item === "string")
}

// 校验 YYYY-MM-DD 日期：格式匹配且必须是真实存在的日期
function isDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  // 以 UTC 零点解析再序列化回字符串比对，排除"2 月 30 日"之类的假日期
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

// 校验 date-time：能被 Date 解析即视为合法
function isDateTime(value: string) {
  return !Number.isNaN(new Date(value).getTime())
}
