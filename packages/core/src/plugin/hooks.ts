// 以命名空间方式整体导出本模块
export * as PluginHooks from "./hooks.js"

// 引入各领域的钩子（hooks）类型：AI SDK / 会话 / Shell / 工具 / 注册选项 / 权限（仅类型引用）
import type { AISDKHooks } from "@opencode/plugin/effect/aisdk"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import type { ShellHooks } from "@opencode/plugin/effect/shell"
import type { ToolFailures, ToolHooks } from "@opencode/plugin/effect/tool"
import type { ModelHookOptions } from "@opencode/plugin/effect/registration"
import type { PermissionHooks } from "@opencode/plugin/effect/permission"
// 引入 Effect 核心模块：Context（服务上下文）、Effect（副作用容器）、Layer（依赖注入层）、Scope（作用域）
import { Context, Effect, Layer, Scope } from "effect"
// 引入"位置节点"构造工具
import { makeLocationNode } from "@opencode/util/effect/app-node"
// 引入状态管理（注册句柄）
import { State } from "../state.js"

// 钩子领域（domains）接口：五个领域各自的钩子事件集合
export interface Domains {
  readonly aisdk: AISDKHooks
  readonly session: SessionHooks
  readonly permission: PermissionHooks
  readonly shell: ShellHooks
  readonly tool: ToolHooks
}

// 类型工具：把规格（Spec）中所有钩子的错误通道置为 never（即这些钩子不会失败）
type NoFailures<Spec> = { readonly [Name in keyof Spec]: never }

// Failure channel for each hook event. Only tool execute.before may fail: a Tool.Error rejects the call before it runs.
// 各领域钩子的失败（错误）通道：只有 tool 的 execute.before 可能失败——Tool.Error 会在工具运行前拒绝调用
interface Failures extends Record<keyof Domains, unknown> {
  readonly aisdk: NoFailures<AISDKHooks>
  readonly session: NoFailures<SessionHooks>
  readonly permission: NoFailures<PermissionHooks>
  readonly shell: NoFailures<ShellHooks>
  readonly tool: ToolFailures
}

// 回调类型：接收事件，返回无值但可失败的 Effect
type Callback<Event, Error> = (event: Event) => Effect.Effect<void, Error>
// 注册条目：回调函数 + 可选的模型钩子选项（如供应商过滤）
type Entry = { readonly callback: Function; readonly options?: ModelHookOptions }

// eventProviderID：从事件对象中提取 model.providerID（用于按供应商过滤钩子回调）
const eventProviderID = (event: unknown) => {
  // 事件不是对象或没有 model 字段则无供应商
  if (typeof event !== "object" || event === null || !("model" in event)) return undefined
  // 取出 model 对象
  const model = event.model
  // model 不是对象或没有 providerID 字段则无供应商
  if (typeof model !== "object" || model === null || !("providerID" in model)) return undefined
  // providerID 是字符串才返回
  return typeof model.providerID === "string" ? model.providerID : undefined
}

// 服务接口：钩子的查询（has）、注册（register）与触发（trigger）
export interface Interface {
  // has：查询某钩子是否已有注册（可按供应商过滤）
  readonly has: <Domain extends keyof Domains>(
    domain: Domain,
    name: keyof Domains[Domain] & keyof Failures[Domain],
    providerID?: string,
  ) => Effect.Effect<boolean>
  // register：注册钩子回调；返回带 dispose 的注册句柄，并绑定到当前作用域
  readonly register: <Domain extends keyof Domains, Name extends keyof Domains[Domain] & keyof Failures[Domain]>(
    domain: Domain,
    name: Name,
    callback: Callback<Domains[Domain][Name], Failures[Domain][Name]>,
    options?: ModelHookOptions,
  ) => Effect.Effect<State.Registration, never, Scope.Scope>
  // trigger：触发钩子；依次调用所有匹配回调后返回事件本身
  readonly trigger: <Domain extends keyof Domains, Name extends keyof Domains[Domain] & keyof Failures[Domain]>(
    domain: Domain,
    name: Name,
    event: Domains[Domain][Name],
  ) => Effect.Effect<Domains[Domain][Name], Failures[Domain][Name]>
}

// Effect 服务类：以 Context.Tag 标识为 "@opencode/PluginHooks"
export class Service extends Context.Service<Service, Interface>()("@opencode/PluginHooks") {}

// 构建服务实现层（Layer）
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 回调注册表：键为 "domain.name"，值为该钩子的条目列表
    const callbacks = new Map<string, Entry[]>()
    // 生成注册表键："domain.name" 字符串
    const key = (domain: keyof Domains, name: PropertyKey) => `${domain}.${String(name)}`

    // register 实现：把回调登记到注册表并挂接到作用域终结器
    const register: Interface["register"] = Effect.fn("PluginHooks.register")(
      function* (domain, name, callback, options) {
        // 获取当前作用域
        const scope = yield* Scope.Scope
        // 计算注册表键
        const id = key(domain, name)
        // 条目是否仍有效（防止重复清理）
        let active = true
        // 构造注册条目
        const entry = { callback, options }
        // 追加到该钩子的条目列表（无则新建）
        callbacks.set(id, [...(callbacks.get(id) ?? []), entry])
        // 清理函数：从注册表移除该条目
        const dispose = Effect.sync(() => {
          // 已清理过则跳过
          if (!active) return
          // 标记为已清理
          active = false
          // 过滤掉自己
          const next = (callbacks.get(id) ?? []).filter((item) => item !== entry)
          // 列表空了就删掉键，否则更新列表
          if (next.length === 0) callbacks.delete(id)
          else callbacks.set(id, next)
        })
        // 作用域关闭时自动执行清理
        yield* Scope.addFinalizer(scope, dispose)
        // 返回手动清理句柄
        return { dispose }
      },
    )

    // trigger 实现：依次执行该事件的所有匹配回调，最后返回事件本身
    const trigger: Interface["trigger"] = Effect.fnUntraced(function* (domain, name, event) {
      // 遍历该钩子的全部注册条目（无则空列表）
      for (const entry of callbacks.get(key(domain, name)) ?? []) {
        // 供应商过滤：条目指定了 providerID 且与事件不匹配则跳过
        if (entry.options?.providerID !== undefined && entry.options.providerID !== eventProviderID(event)) continue
        // 调用回调得到 Effect（钩子可原地修改事件对象）
        const result: Effect.Effect<void, Failures[typeof domain][typeof name]> = entry.callback(event)
        // 执行回调（可能失败并向上传播）
        yield* result
      }
      // 返回事件本身
      return event
    })

    // has 实现：同步检查是否存在任一匹配的注册条目
    const has: Interface["has"] = (domain, name, providerID) =>
      Effect.sync(() =>
        // 条目未限定供应商（全局）或恰好匹配指定供应商即视为已注册
        (callbacks.get(key(domain, name)) ?? []).some(
          (entry) => entry.options?.providerID === undefined || entry.options.providerID === providerID,
        ),
      )

    // 用上述实现组装服务实例
    return Service.of({ has, register, trigger })
  }),
)

// 导出位置全局节点：无额外依赖
export const node = makeLocationNode({ service: Service, layer, deps: [] })
