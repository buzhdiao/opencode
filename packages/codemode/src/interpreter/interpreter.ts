// 模块职责：Code Mode 的解释器（Interpreter）——在宿主进程内逐语句执行 AI 生成的受限 JavaScript/JSON 程序。
// 在系统中的位置：codemode 包的核心，把 acorn 解析出的 AST 投影为受控求值，工具调用经 ToolReference 桥接到宿主。
// 关键设计：(1) 以生成器/协程形式推进求值（Eval<T>），使 await/工具阻塞/切片让出可被 Runner 调度；
// (2) 严格区分"数据对象（Obj）"与"不透明宿主引用"，操作符对不透明值快速失败，保证边界清晰；
// (3) 大量 WeakMap 记忆化（var 名、闭包检测、参数简单性等），让热路径零重复分析；
// (4) 乐观快路径：无副作用的叶子直接同步返回，只有可能运行程序代码的求值才返回生成器。
// acorn 的 AST 节点类型（解释器处理的表达式/语句/模式全集）
import type {
  AnyNode,
  ArrayExpression,
  ArrayPattern,
  AssignmentPattern,
  ArrowFunctionExpression,
  AssignmentExpression,
  AssignmentProperty,
  AwaitExpression,
  BinaryExpression,
  BlockStatement,
  BreakStatement,
  CallExpression,
  ChainExpression,
  ConditionalExpression,
  ContinueStatement,
  DoWhileStatement,
  Expression,
  ForInStatement,
  ForOfStatement,
  ForStatement,
  FunctionDeclaration,
  FunctionExpression,
  Identifier,
  IfStatement,
  ImportDeclaration,
  ImportExpression,
  LabeledStatement,
  LogicalExpression,
  MemberExpression,
  ModuleDeclaration,
  NewExpression,
  ObjectExpression,
  Pattern,
  Program,
  Property,
  ReturnStatement,
  SequenceExpression,
  SpreadElement,
  Statement,
  Super,
  SwitchStatement,
  TaggedTemplateExpression,
  Literal,
  TemplateLiteral,
  ThrowStatement,
  TryStatement,
  UnaryExpression,
  UpdateExpression,
  VariableDeclaration,
  WhileStatement,
  YieldExpression,
} from "acorn"
// effect 的 Context 类型（宿主服务上下文）
import type { Context } from "effect"
// data.js：JSON 值模型、fromJson（值->数据）、toBoundary（跨边界转 JSON）
import { fromJson, type Json, toBoundary } from "../data.js"
// ToolReference：指向宿主工具路径的引用；ToolRuntime：工具运行时接口
import { ToolReference, type ToolRuntime } from "../tool-runtime.js"
// 解释器的基础模型：错误类型、哨兵值、语句结果等
import {
  type AstNode,
  AsyncIteratorSymbol,
  type Binding,
  GeneratorReturn,
  IteratorSymbol,
  OptionalShortCircuit,
  invalidData,
  PendingThrow,
  syntaxError,
  Throw,
  rangeError,
  type StatementResult,
  typeError,
  unsupportedSyntax,
} from "./model.js"
// 字符串长度上限检查（防止程序拼接超大字符串耗尽内存）
import { checkStringLength } from "./limits.js"
// 错误定位与物化：locate 给错误补调用点位置，materialize 把内部错误转成程序可见的错误对象
import { locate, materialize } from "./errors.js"
// 内建对象表（Function/Array/Object/Generator 原型等）与原始值原型查找
import { type Builtins, primitivePrototype } from "./intrinsics.js"
// 解释器默认注入的全局绑定
import { globals } from "./globals.js"
// 运行时对象机制：Obj/Arr/Fn/Native/GeneratorObj/PromiseObj 等内部对象、
// 属性读写、原型链、迭代器与类型强转
import {
  assign,
  Callable,
  define,
  frozen,
  get,
  hostCursor,
  IteratorObj,
  type Cursor,
  has,
  hasOwn,
  hidden,
  hasPrototype,
  keys,
  Native,
  parseArrayIndex,
  Arguments,
  Arr,
  Fn,
  GeneratorObj,
  Obj,
  PromiseObj,
  iteratorResult,
  remove,
  set,
  coerceToNumber,
  coerceToString,
  entries,
  getOwn,
  type NativeResult,
  type Step,
  type Value,
} from "./objects.js"
// 回调与 ToPrimitive：值转换提示、保留消费者错误的包装
import { type Hint, preserveConsumerError, toPrimitive } from "./callback.js"
// 协程调度原语：Call/Yield/Await/Task/Slice/AsyncBoundary、调用深度上限与 Runner
import {
  AsyncBoundary,
  Await,
  Call,
  type Eval,
  type GeneratorRequest,
  Interruption,
  isEval,
  MAX_CALL_DEPTH,
  Runner,
  Slice,
  Task,
  Yield,
  normal,
} from "./runner.js"
// 模块系统：说明符归一化与受限模块解析（只允许内建与宿主提供的模块）
import { moduleName, resolveModule } from "./modules.js"
// 值的描述/不透明判断/循环插入拒绝/typeof
import { describeValue, isOpaque, rejectCircularInsertion, typeofValue } from "./references.js"
// 内建函数构造器
import { fn } from "./native.js"
// Promise 能力（resolve/reject 对）与"既是值又可 await"的 promiseLike 包装
import { capability, promiseLike } from "./promises.js"
// 词法作用域栈：声明/预留/初始化与 TDZ 处理
import { ScopeStack } from "./scope.js"
// 正则构造（受支持的正则字面量在此物化）
import { constructRegExp } from "../stdlib/regexp.js"
// 枚举自有可枚举属性的源对象构造（对象展开/解构共用）
import { enumerableSource } from "../stdlib/object.js"
// 支持的复合赋值运算符集合
import { compoundOperators } from "../stdlib/value.js"
/** The binary operators that convert object operands through ToPrimitive before acting on primitives. */
// 需要先把操作数经 ToPrimitive 转为原始值再运算的双目运算符集合
const primitiveOperators = new Set([
  "+",
  "-",
  "*",
  "/",
  "%",
  "**",
  "<",
  "<=",
  ">",
  ">=",
  "&",
  "|",
  "^",
  "<<",
  ">>",
  ">>>",
])

/** ToPropertyKey on a primitive (or an opaque value, which keeps its built-in string form). */
// 对原始值做 ToPropertyKey（字符串/数字/symbol 原样返回；不透明值转为其内建字符串形式）
const propertyKey = (value: Value): PropertyKey =>
  typeof value === "string" || typeof value === "number" || typeof value === "symbol" ? value : coerceToString(value)

// What a loop does with its body's result: exit with a StatementResult, or undefined to keep iterating.
// Unlabelled break ends this loop; a label the loop does not carry propagates outward.
// 循环如何处理其体的结果：以 StatementResult 退出，或 undefined 表示继续迭代。
// 不带标签的 break 结束本循环；不属于本循环的标签向外层传播
const loopExit = (result: StatementResult, labels: ReadonlySet<string> | undefined): StatementResult | undefined => {
  // return 直接穿透循环向外返回
  if (result.kind === "return") return result
  if (result.kind === "break") {
    // 带标签的 break 若不是本循环的标签，则继续向外传播；否则吞掉（本循环结束）
    if (result.label !== undefined && !labels?.has(result.label)) return result
    return { kind: "none" }
  }
  // 带标签的 continue 若不属于本循环，同样向外传播；不带标签或属于本循环的 continue 被吞掉
  if (result.kind === "continue" && result.label !== undefined && !labels?.has(result.label)) return result
  return undefined
}

// Native engines name the callee (`search(...).catch is not a function`), including call chains. Returns
// undefined when a link cannot be named, so a chain is either named completely or not at all.
// 像原生引擎一样给被调用者起名（如 `search(...).catch is not a function`），支持调用链。
// 某一环无法命名时返回 undefined：调用链要么完整命名，要么完全不命名
const calleeDescription = (node: Expression | Super | undefined): string | undefined => {
  if (node?.type === "Identifier") return node.name
  if (node?.type === "CallExpression") {
    const target = calleeDescription(node.callee)
    return target === undefined ? undefined : `${target}(...)`
  }
  if (node?.type !== "MemberExpression") return undefined
  const property = node.property
  const key =
    !node.computed && property.type === "Identifier"
      ? property.name
      : property.type === "Literal" && typeof property.value === "string"
        ? property.value
        : undefined
  if (key === undefined) return undefined
  const object = calleeDescription(node.object)
  return object === undefined ? undefined : `${object}.${key}`
}

// OrdinaryHasInstance: walk the left operand's chain looking for the constructor's `prototype`.
// acorn types every literal as possibly a BigInt or RegExp; regex literals become RegExp objects before this is asked.
// 字面量求值：BigInt 字面量不支持；正则字面量在到达这里之前已物化为 RegExp 对象，同样拒绝
const literal = (node: Literal): Value => {
  if (typeof node.value === "bigint") throw typeError("BigInt literals are not supported.", node)
  if (node.value instanceof RegExp) throw unsupportedSyntax("RegExpLiteral", node)
  return node.value
}

// instanceof 语义（OrdinaryHasInstance）：右侧必须是可调用对象且带有 prototype 对象，
// 然后沿左侧值的原型链查找该 prototype
const instanceofValue = (lhs: Value, rhs: Value, node: AstNode): boolean => {
  if (!(rhs instanceof Callable)) {
    throw typeError("The right-hand side of 'instanceof' is not callable.", node)
  }
  // 取右侧构造器的 prototype
  const prototype = get(rhs, "prototype")
  if (!(prototype instanceof Obj)) {
    throw typeError("The right-hand side of 'instanceof' has no 'prototype' object.", node)
  }
  // 沿左侧原型链查找
  return hasPrototype(lhs, prototype)
}

// 收集一个绑定/赋值模式里的全部标识符名（含嵌套解构与 rest 参数）
const collectPatternNames = (pattern: Pattern, out: Array<string> = []): Array<string> => {
  switch (pattern.type) {
    case "Identifier":
      // 直接记录名字
      out.push(pattern.name)
      break
    case "AssignmentPattern":
      // 带默认值的模式：收集其左侧
      collectPatternNames(pattern.left, out)
      break
    case "RestElement":
      // rest 元素：收集其参数
      collectPatternNames(pattern.argument, out)
      break
    case "ArrayPattern":
      // 数组模式：逐个收集非空元素
      for (const element of pattern.elements) {
        if (element !== null) collectPatternNames(element, out)
      }
      break
    case "ObjectPattern":
      // 对象模式：收集各属性的值侧（rest 收集其参数）
      for (const prop of pattern.properties) {
        collectPatternNames(prop.type === "RestElement" ? prop.argument : prop.value, out)
      }
      break
  }
  return out
}

// Whether a function body (or a parameter default) reads `arguments`, looking through arrows but not nested
// functions, which own theirs. Memoized so the object is only built for calls that can observe it.
// 判断函数体（或参数默认值）是否读取了 `arguments`：穿透箭头函数，但不进入拥有自己
// arguments 的嵌套普通函数。按函数体记忆化，只为能观察到该对象的调用构建 arguments 对象
const argumentsUse = new WeakMap<Fn["body"], boolean>()
const usesArguments = (fn: Fn): boolean => {
  // 命中缓存直接返回
  const cached = argumentsUse.get(fn.body)
  if (cached !== undefined) return cached
  // 递归访问：标识符即比对名字；嵌套普通函数是边界
  const found = [...fn.parameters, fn.body].some(function visit(node: AnyNode | null): boolean {
    if (node === null || typeof node !== "object") return false
    if (node.type === "Identifier") return node.name === "arguments"
    if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression") return false
    return Object.values(node).some((child) =>
      Array.isArray(child) ? child.some((item) => visit(item)) : visit(child as AnyNode | null),
    )
  })
  argumentsUse.set(fn.body, found)
  return found
}

// Whether evaluating a node can create a function, which could capture a loop's per-iteration bindings.
// 判断对某节点的求值能否创建函数——只有能创建闭包时，循环才需要为每轮迭代复制 let 绑定
const closures = new WeakMap<AnyNode, boolean>()
const createsClosure = (node: AnyNode): boolean => {
  // 命中缓存直接返回
  const cached = closures.get(node)
  if (cached !== undefined) return cached
  // 递归访问：发现任意函数节点即为真
  const found = (function visit(item: AnyNode | null): boolean {
    if (item === null || typeof item !== "object") return false
    if (
      item.type === "FunctionExpression" ||
      item.type === "ArrowFunctionExpression" ||
      item.type === "FunctionDeclaration"
    )
      return true
    return Object.values(item).some((child) =>
      Array.isArray(child) ? child.some((entry) => visit(entry)) : visit(child as AnyNode | null),
    )
  })(node)
  closures.set(node, found)
  return found
}

// `var` names declared anywhere in a function body except inside nested functions, which own theirs.
// Memoized per body: a function's var names never change, and hoisting runs on every call.
// 收集函数体内声明的全部 `var` 名（嵌套函数拥有自己的 var，不计入）。
// 按函数体记忆化：var 名不会变化，而提升（hoisting）在每次调用时都要执行
const varNames = new WeakMap<ReadonlyArray<Statement | ModuleDeclaration>, ReadonlyArray<string>>()
const collectVarNames = (
  node: Statement | ModuleDeclaration | null | undefined,
  out: Array<string> = [],
): Array<string> => {
  if (!node) return out
  switch (node.type) {
    case "VariableDeclaration":
      // 只收集 var 声明的绑定名
      if (node.kind === "var") for (const declaration of node.declarations) collectPatternNames(declaration.id, out)
      break
    case "BlockStatement":
      // 块内的语句逐个收集
      for (const statement of node.body) collectVarNames(statement, out)
      break
    case "IfStatement":
      collectVarNames(node.consequent, out)
      collectVarNames(node.alternate, out)
      break
    case "ForStatement":
      if (node.init?.type === "VariableDeclaration") collectVarNames(node.init, out)
      collectVarNames(node.body, out)
      break
    case "ForInStatement":
    case "ForOfStatement":
      if (node.left.type === "VariableDeclaration") collectVarNames(node.left, out)
      collectVarNames(node.body, out)
      break
    case "WhileStatement":
    case "DoWhileStatement":
    case "LabeledStatement":
      collectVarNames(node.body, out)
      break
    case "SwitchStatement":
      // 各分支的语句体
      for (const item of node.cases) for (const statement of item.consequent) collectVarNames(statement, out)
      break
    case "TryStatement":
      // try 块、catch 块与 finally 块
      collectVarNames(node.block, out)
      collectVarNames(node.handler?.body, out)
      collectVarNames(node.finalizer, out)
      break
  }
  return out
}

// 解析 for...of / for...in 头部的循环变量声明：必须是单声明；返回模式、可变性与是否词法绑定
const loopDeclaration = (left: VariableDeclaration | Pattern, statement: "for...of" | "for...in") => {
  // 左侧不是声明（直接赋值形式）则无预声明信息
  if (left.type !== "VariableDeclaration") return undefined
  const declaration = left.declarations.length === 1 ? left.declarations[0] : undefined
  if (declaration === undefined) {
    throw typeError(`${statement} supports one declared binding.`, left)
  }
  const kind = left.kind
  return {
    pattern: declaration.id,
    mutable: kind !== "const",
    lexical: kind !== "var",
  }
}

// 自定义迭代器的统一表示：迭代器对象、next 方法、是否异步
type CustomIterator = {
  iterator: Obj
  next: Value
  asynchronous: boolean
}

/** A resolved member: the object to read through and the receiver that inherited accessors see. */
// 已解析的成员引用：读取的目标对象，以及继承访问器可见的接收者
type MemberReference = {
  target: Obj
  key: PropertyKey
  receiver: Value
}

// 语句结果的"无事发生"常量
const none: StatementResult = { kind: "none" }

/** Marks an operand a fast path has not evaluated yet, since `undefined` is a value. */
// 哨兵：标记操作数尚未被快路径求值——因为 undefined 本身是一个合法值，不能用 undefined 表示"未算"
const unevaluated: unique symbol = Symbol("codemode.unevaluated")

// 引用的四种形态：成员引用（可写）、工具引用（桥接宿主）、已解析的值（原始属性）、可选链短路
type Reference = MemberReference | ToolReference | { value: Value } | typeof OptionalShortCircuit

// Parameter lists of plain names bind without evaluating anything, so a call needs no binding work.
// 纯标识符参数列表无需任何求值即可绑定，调用时可以跳过绑定工作
const simpleParameters = new WeakMap<ReadonlyArray<Pattern>, boolean>()
const isSimple = (parameters: ReadonlyArray<Pattern>): boolean => {
  // 命中缓存直接返回
  const cached = simpleParameters.get(parameters)
  if (cached !== undefined) return cached
  // 全部是纯标识符才算"简单"
  const simple = parameters.every((parameter) => parameter.type === "Identifier")
  simpleParameters.set(parameters, simple)
  return simple
}

// A block that declares nothing lexically needs no scope of its own.
// 不含任何词法声明的块不需要自己的作用域
const blockScopes = new WeakMap<ReadonlyArray<Statement | ModuleDeclaration>, boolean>()
const declaresLexically = (statements: ReadonlyArray<Statement | ModuleDeclaration>): boolean => {
  // 命中缓存直接返回
  const cached = blockScopes.get(statements)
  if (cached !== undefined) return cached
  // 函数声明或非 var 的变量声明即构成词法声明
  const declares = statements.some(
    (statement) =>
      statement.type === "FunctionDeclaration" ||
      (statement.type === "VariableDeclaration" && statement.kind !== "var"),
  )
  blockScopes.set(statements, declares)
  return declares
}

// 语句结果是否"突然完成"（return/break/continue 之一）
const isAbrupt = (result: StatementResult): boolean =>
  result.kind === "return" || result.kind === "break" || result.kind === "continue"

// A thenable the program's implicit async body adopts before copy-out.
// 判断值是否为 thenable：程序的隐式 async 体会在复制输出（copy-out）之前接管它
const isThenable = (value: Value): boolean =>
  value instanceof PromiseObj || (value instanceof Obj && typeofValue(get(value, "then")) === "function")

/** One program execution: the tool bridge, job queue, captured logs, and the global scope built once. */
// 一次程序执行的宿主：工具桥、作业队列、捕获的日志，以及只构建一次的全局作用域
export class Interpreter<R> {
  // 工具运行时（AI 通过 tools.* 调用宿主工具的通道）
  readonly tools: ToolRuntime<R>
  // 协程调度器：驱动生成器栈、宿主调用与作业队列
  readonly runner: Runner<R>
  // 内建对象表（各全局对象的原型等）
  readonly builtins: Builtins
  // 程序捕获的日志输出
  readonly logs: Array<string>
  /** Template objects by site: a tag sees the same `strings` array every time its literal is evaluated, as in JS. */
  // 模板对象按 AST 节点位置缓存：与 JS 一致，同一标签模板每次求值都看到同一个 `strings` 数组
  readonly templates = new WeakMap<TaggedTemplateExpression, Arr>()
  // 根帧：程序体的常驻激活（回调进入程序时复用它）
  private readonly root: Frame<R>
  // 全局作用域（this + 内建全局）
  private readonly globalScope: ReadonlyMap<string, Binding>
  // 已解析模块的缓存（按 Node 模块名）
  private readonly modules = new Map<string, Value>()
  // 已构建命名空间对象的缓存
  private readonly namespaces = new Map<string, Obj>()

  constructor(options: {
    readonly tools: ToolRuntime<R>
    /** The caller's services, which host work runs with. */
    // 调用方的服务上下文：宿主工作在其上运行
    readonly services: Context.Context<R>
    readonly builtins: Builtins
    readonly logs?: Array<string>
    // 允许宿主注入额外的全局绑定
    readonly globals?: (ctx: Interpreter<R>) => ReadonlyArray<readonly [string, Value]>
  }) {
    // 保存基本配置
    this.tools = options.tools
    this.builtins = options.builtins
    this.logs = options.logs ?? []
    this.runner = new Runner(this, options.services)
    // Program code has no receiver: top-level `this` is undefined, as in a module.
    // 程序代码没有接收者：顶层 `this` 为 undefined，与模块一致
    const globalScope = new Map<string, Binding>([["this", { mutable: false, value: undefined }]])
    // Calling back into the program never reads frame state, so any frame serves; the root is always alive.
    // 回调进入程序从不读取帧状态，任何帧都可以服务；根帧始终存活
    this.root = new Frame(this, new ScopeStack([globalScope]))
    this.globalScope = globalScope
    // 注入内建全局与宿主自定义全局（只读绑定）
    for (const [name, value] of [...globals(this), ...(options.globals?.(this) ?? [])]) {
      globalScope.set(name, { mutable: false, value })
    }
  }

  /** A module, as `require` returns it and a default import binds it: a global, by its Node module name. */
  // 解析模块（require 的返回值、默认导入绑定的对象）：按 Node 模块名解析全局提供的模块
  module(specifier: string, site?: AstNode): Value {
    const name = moduleName(specifier)
    // 命中缓存直接返回
    const cached = this.modules.get(name)
    if (cached !== undefined) return cached
    const module = resolveModule(name, (global) => {
      const binding = this.globalScope.get(global)
      return binding && "value" in binding ? binding.value : undefined
    })
    if (module === undefined)
      throw new PendingThrow(
        "Error",
        `Cannot import "${specifier}": it isn't available in Code Mode, which can't load packages or files. Use the provided globals, or call tools through \`tools\`.`,
        site,
      )
    // 缓存解析结果
    this.modules.set(name, module)
    return module
  }

  /**
   * What `import * as` and `import()` see: the module's own properties, and the module itself as `default`, the way
   * Node presents a CommonJS module.
   */
  // `import * as` 与动态 import() 看到的命名空间对象：模块自身属性 + 以 `default` 暴露模块本身，
  // 与 Node 呈现 CommonJS 模块的方式一致
  namespace(specifier: string, site?: AstNode): Obj {
    const module = this.module(specifier, site)
    const name = moduleName(specifier)
    // 命中缓存直接返回
    const cached = this.namespaces.get(name)
    if (cached) return cached
    // 无原型的命名空间对象：复制模块自有属性 + default 指向模块本身
    const namespace = new Obj(null)
    if (module instanceof Obj) for (const [key, value] of entries(module)) define(namespace, key, value)
    define(namespace, "default", module)
    this.namespaces.set(name, namespace)
    return namespace
  }

  /** The program's body, as the first job: its completion value, copied out for the host. */
  // 程序体作为第一个作业运行：完成值经 toBoundary 复制输出给宿主
  *main(program: Program): Eval<Json | undefined> {
    return yield* toBoundary(this, yield* this.root.run(program))
  }

  /** Calls into the program; a built-in passes its own call site so failures inside are located there. */
  // 从宿主调用进程序；内建函数传入自己的调用点，内部失败在该处定位
  call(callable: Value, thisValue: Value, args: Array<Value>, site?: AstNode): Eval<Value> {
    return this.root.call(callable, thisValue, args, site)
  }

  /** Await: suspends the innermost async body until `value` settles. */
  // await：挂起最内层的 async 体，直到 value 落定
  *awaitValue(value: Value, node?: AstNode): Eval<Value> {
    return (yield new Await(value, node)) as Value
  }

  iterate(value: Value) {
    return this.root.iterate(value)
  }

  iterateDirect(value: Value) {
    return this.root.iterateDirect(value)
  }

  /** Runs one host call to completion before any other job: arguments cross as JSON, the result comes back as values. */
  // 同步式工具调用：先于任何其他作业把一次宿主调用跑完。参数以 JSON 跨界，结果以值返回
  *tool(run: ToolRuntime<R>["search"], args: Array<Value>) {
    const json: Array<Json | undefined> = []
    for (const arg of args) json.push(yield* toBoundary(this, arg))
    return fromJson(this, (yield this.runner.blocking(run(json))) as Json | undefined)
  }

  /** The built-in search: its result is usable directly, and can also be awaited or chained like a Promise. */
  // 内建 search：结果可直接使用，也可以像 Promise 一样被 await 或链式调用
  *search(args: Array<Value>) {
    return promiseLike(this, yield* this.tool(this.tools.search, args))
  }
}

/** One activation: the top-level program or a single function call, evaluating against its own scope chain. */
// 一次激活：顶层程序或单次函数调用，针对自己的作用域链求值
class Frame<R> {
  /** The body of a generator function, where `yield` suspends. */
  // 本帧是否运行生成器函数体（yield 在此挂起）
  private generator = false
  // 本帧是否运行异步生成器函数体（yield/return 前先 await）
  private generatorAsync = false

  constructor(
    private readonly ctx: Interpreter<R>,
    private scopes: ScopeStack,
  ) {}

  *run(program: Program): Eval<Value> {
    // Keep top-level declarations separate so they can shadow builtins.
    // 程序体使用独立作用域，使顶层声明可以遮蔽内建全局
    this.scopes.push()
    try {
      // Imports load before any code runs, as in a module.
      // 与模块一致：任何代码运行之前先加载 import
      for (const statement of program.body) if (statement.type === "ImportDeclaration") this.bindImport(statement)
      // 提升三件套：词法预声明、函数声明提升、var 提升
      this.predeclareLexical(program.body)
      this.hoistFunctions(program.body)
      this.hoistVars(program.body)
      let value: Value = undefined
      for (const [index, statement] of program.body.entries()) {
        if (statement.type === "ImportDeclaration") continue
        // 顶层最后的表达式语句是程序的完成值（REPL 语义）
        if (index === program.body.length - 1 && statement.type === "ExpressionStatement") {
          value = yield* this.evaluateExpression(statement.expression)
          break
        }
        const result = yield* this.evaluateStatement(statement)

        if (result.kind === "return") {
          value = result.value
          break
        }

        if (result.kind === "break" || result.kind === "continue") {
          throw typeError(`Unexpected '${result.kind}' outside of a loop.`, statement)
        }
      }

      // The implicit async body adopts returned promises before copy-out.
      // 程序的隐式 async 体在复制输出之前接管返回的 promise
      return isThenable(value) ? yield* this.awaitValue(value) : value
    } finally {
      this.scopes.pop()
    }
  }

  // 绑定 import 声明：无具名绑定（副作用导入）时只触发模块加载；其余逐个声明局部绑定
  private bindImport(node: ImportDeclaration): void {
    const specifier = String(node.source.value)
    if (node.specifiers.length === 0) this.ctx.module(specifier, node)
    for (const binding of node.specifiers) {
      this.scopes.declare(binding.local.name, this.imported(binding, specifier), false, binding)
    }
  }

  // A default import binds the module itself and a named import one of its properties, as Node imports CommonJS.
  // 默认导入绑定模块本身；具名导入绑定命名空间上的一个属性——与 Node 导入 CommonJS 一致
  private imported(binding: ImportDeclaration["specifiers"][number], specifier: string): Value {
    if (binding.type === "ImportDefaultSpecifier") return this.ctx.module(specifier, binding)
    const namespace = this.ctx.namespace(specifier, binding)
    if (binding.type === "ImportNamespaceSpecifier") return namespace
    const name = binding.imported.type === "Identifier" ? binding.imported.name : String(binding.imported.value)
    if (!hasOwn(namespace, name)) throw syntaxError(`"${specifier}" has no export named "${name}".`, binding)
    return getOwn(namespace, name)
  }

  // The call returns its promise at once. Arguments cross on the caller's stack, since `toJSON` is program code, and a
  // promise argument is awaited first; the host call starts once they have crossed, so admission and hooks happen at
  // the call site, and runs concurrently with the program.
  // 工具调用立刻返回其 promise。参数在调用方栈上跨界——因为 toJSON 是程序代码，
  // promise 参数要先被 await；参数跨完后宿主调用才启动：受理与钩子发生在调用点，
  // 而调用本身与程序并发执行
  private *createToolCallPromise(
    path: ReadonlyArray<string>,
    args: Array<Value>,
    site: AstNode | undefined,
  ): Eval<Value> {
    const ctx = this.ctx
    const runner = ctx.runner
    // 新建 promise 及其 resolve/reject 能力
    const promise = runner.newPromise()
    const resolving = runner.resolving(promise)
    const body = function* (): Eval<void> {
      const json: Array<Json | undefined> = []
      for (const arg of args) json.push(yield* toBoundary(ctx, arg))
      // 宿主侧执行：成功以 JSON 转值 resolve，失败原样 reject
      runner.host(
        ctx.tools.execute(path, json),
        (settled) =>
          settled.ok
            ? resolving.resolve(fromJson(ctx, settled.value as Json | undefined))
            : resolving.reject(settled.error),
        site,
      )
    }
    return (yield new Call(
      body(),
      // 边界：程序侧失败（如调用被中断）时拒绝该 promise，防止悬置
      new AsyncBoundary((completion) => {
        if (!completion.ok) resolving.reject(completion.error)
      }, promise),
    )) as Value
  }

  awaitValue(value: Value, node?: AstNode): Eval<Value> {
    return this.ctx.awaitValue(value, node)
  }

  // 语句求值的生成器形式：同步可完成的语句直接返回结果
  private *evaluateStatement(node: Statement | ModuleDeclaration): Eval<StatementResult> {
    const result = this.execute(node)
    return isEval(result) ? yield* result : result
  }

  // Like `evaluate`: statements that cannot run program code complete without a generator.
  // 与表达式快路径同理：不可能运行程序代码的语句无需生成器即可完成
  private execute(node: Statement | ModuleDeclaration): StatementResult | Eval<StatementResult> {
    switch (node.type) {
      case "ExpressionStatement": {
        // 表达式语句：值即被丢弃，只需收尾生成器
        const result = this.evaluate(node.expression)
        return isEval(result) ? this.finishExpressionStatement(result) : none
      }
      // 以下各语句分派到对应的求值方法
      case "VariableDeclaration":
        return this.evaluateVariableStatement(node)
      case "ReturnStatement":
        return this.evaluateReturnStatement(node)
      case "BlockStatement":
        return this.evaluateBlock(node)
      case "IfStatement":
        return this.evaluateIfStatement(node)
      case "SwitchStatement":
        return this.evaluateSwitchStatement(node)
      case "LabeledStatement":
        return this.evaluateLabeledStatement(node)
      case "WhileStatement":
        return this.evaluateWhileStatement(node)
      case "DoWhileStatement":
        return this.evaluateDoWhileStatement(node)
      case "ForStatement":
        return this.evaluateForStatement(node)
      case "ForOfStatement":
        return this.evaluateForOfStatement(node)
      case "ForInStatement":
        return this.evaluateForInStatement(node)
      case "BreakStatement":
        return this.evaluateBreakStatement(node)
      case "ContinueStatement":
        return this.evaluateContinueStatement(node)
      case "ThrowStatement":
        return this.evaluateThrowStatement(node)
      case "TryStatement":
        return this.evaluateTryStatement(node)
      case "EmptyStatement":
        // 空语句：无事发生
        return none
      case "FunctionDeclaration":
        // 函数声明在提升阶段已处理，执行时无事发生
        return none
      case "ImportDeclaration":
        // import 只能出现在程序顶层
        throw syntaxError("An import declaration may only appear at the top level of the program.", node)
      default:
        // 其余语句类型（类、with、debugger 等）不支持
        throw unsupportedSyntax(node.type, node)
    }
  }

  // 收尾一个表达式语句的生成器工作：跑完并返回"无事发生"
  private *finishExpressionStatement(work: Eval<Value>): Eval<StatementResult> {
    yield* work
    return none
  }

  private *evaluateVariableStatement(node: VariableDeclaration): Eval<StatementResult> {
    yield* this.evaluateVariableDeclaration(node)
    return none
  }

  // return 语句：无返回值时返回 undefined；异步生成器先 await 返回值
  private *evaluateReturnStatement(node: ReturnStatement): Eval<StatementResult> {
    const argumentNode = node.argument
    if (!argumentNode) return { kind: "return", value: undefined }
    const evaluated = this.evaluate(argumentNode)
    const value = isEval(evaluated) ? yield* evaluated : evaluated
    // An async generator awaits what it returns, as it awaits what it yields.
    // 异步生成器对返回值做 await，正如它对 yield 的值做 await
    return { kind: "return", value: this.generatorAsync ? yield* this.awaitValue(value, node) : value }
  }

  // 执行块语句：含词法声明时压入新作用域并预声明/提升
  private *evaluateBlock(node: BlockStatement): Eval<StatementResult> {
    const body = node.body
    const scoped = declaresLexically(body)
    if (scoped) {
      this.scopes.push()
      this.predeclareLexical(body)
      this.hoistFunctions(body)
    }
    try {
      for (const statement of body) {
        const executed = this.execute(statement)
        const result = isEval(executed) ? yield* executed : executed
        // 非平凡结果（return/break/continue/throw）直接上抛
        if (result.kind !== "none") return result
      }

      return none
    } finally {
      if (scoped) this.scopes.pop()
    }
  }

  // 从 AST 节点物化一个函数对象：捕获当前作用域链、记录 async/generator/箭头属性
  private createFunction(
    node: FunctionDeclaration | FunctionExpression | ArrowFunctionExpression,
    name = node.type === "ArrowFunctionExpression" ? "" : (node.id?.name ?? ""),
  ): Fn {
    const builtins = this.ctx.builtins
    const fn = new Fn(
      builtins.Function,
      name,
      node.params,
      node.body,
      // 捕获当前作用域链（闭包基础）
      this.scopes.capture(),
      node.async,
      node.generator,
      node.type === "ArrowFunctionExpression",
    )
    // Each generator function gets its own prototype, so `g() instanceof g` holds as in JS.
    // 每个生成器函数有自己的 prototype，保证 `g() instanceof g` 与 JS 一致
    if (node.generator)
      define(fn, "prototype", new Obj(node.async ? builtins.AsyncGenerator : builtins.Generator), hidden)
    // The body of a named function expression sees its own name, read-only.
    // 具名函数表达式的体内能看到自己的名字（只读绑定）
    if (node.type === "FunctionExpression" && node.id) {
      fn.capturedScopes.push(new Map([[node.id.name, { mutable: false, value: fn, initialized: true }]]))
    }
    return fn
  }

  // NamedEvaluation: an anonymous function definition takes the name of what it is assigned to.
  // NamedEvaluation：匿名函数定义取得它被赋值目标的名称（const f = () => {} 时 f.name === "f"）
  private *evaluateNamed(node: Expression, name: string): Eval<Value> {
    if (node.type === "ArrowFunctionExpression" || (node.type === "FunctionExpression" && !node.id)) {
      return this.createFunction(node, name)
    }
    return yield* this.evaluateExpression(node)
  }

  // Repeated `function` declarations and `var` clashes are legal: the last declaration wins.
  // 提升函数声明：重复的函数声明与 var 冲突是合法的，最后一条声明胜出
  private hoistFunctions(statements: ReadonlyArray<Statement | ModuleDeclaration>): void {
    for (const node of statements) {
      if (node.type !== "FunctionDeclaration") continue
      this.scopes.current().set(node.id.name, { mutable: true, value: this.createFunction(node), initialized: true })
    }
  }

  // Hoisted `var` bindings start undefined, or copy a same-named parameter. Function bodies hoist
  // into their own scope above the parameters so closures in parameter defaults keep seeing outer names.
  // 提升 var 绑定：初始为 undefined，或复制同名参数的值。函数体提升到参数之上的独立作用域，
  // 这样参数默认值里的闭包仍能看到外层同名变量
  private hoistVars(statements: ReadonlyArray<Statement | ModuleDeclaration>, parameters?: Map<string, Binding>): void {
    // 取缓存的 var 名列表（首次时递归收集）
    const names =
      varNames.get(statements) ??
      statements.reduce<Array<string>>((out, statement) => collectVarNames(statement, out), [])
    varNames.set(statements, names)
    const scope = this.scopes.current()
    for (const name of names) {
      // 已存在的绑定（含参数）不覆盖
      if (scope.has(name)) continue
      scope.set(name, { mutable: true, value: parameters?.get(name)?.value, initialized: true })
    }
  }

  // 预声明词法绑定（let/const/class）：登记进作用域并建立 TDZ（未初始化）状态
  private predeclareLexical(statements: ReadonlyArray<Statement | ModuleDeclaration>): void {
    for (const statement of statements) {
      if (statement.type !== "VariableDeclaration") continue
      const kind = statement.kind
      if (kind === "var") continue
      for (const declaration of statement.declarations) {
        for (const name of collectPatternNames(declaration.id)) {
          this.scopes.reserve(name, kind !== "const", declaration)
        }
      }
    }
  }

  // 为解构模式预声明全部名字
  private predeclarePattern(pattern: Pattern, mutable: boolean, node: AstNode): void {
    for (const name of collectPatternNames(pattern)) this.scopes.reserve(name, mutable, node)
  }

  private *evaluateIfStatement(node: IfStatement): Eval<StatementResult> {
    const test = this.evaluate(node.test)
    // 按 test 真值选择分支；无分支（else 缺失）则无事发生
    const branch = (isEval(test) ? yield* test : test) ? node.consequent : node.alternate
    if (!branch) return none
    const result = this.execute(branch)
    return isEval(result) ? yield* result : result
  }

  // switch 语句：整个 switch 是一个块级作用域；匹配后从该 case 一路执行到末尾（贯穿语义）
  private *evaluateSwitchStatement(node: SwitchStatement): Eval<StatementResult> {
    const discriminant = yield* this.evaluateExpression(node.discriminant)
    this.scopes.push()
    try {
      const cases = node.cases
      // 词法声明作用于整个 switch（各分支合并预声明/提升）
      const statements = cases.flatMap((branch) => branch.consequent)
      this.predeclareLexical(statements)
      this.hoistFunctions(statements)
      let defaultIndex: number | undefined
      let selected: number | undefined
      for (const [index, branch] of cases.entries()) {
        const test = branch.test
        if (!test) {
          // 记录 default 分支的位置
          defaultIndex = index
          continue
        }
        // 严格相等匹配
        if ((yield* this.evaluateExpression(test)) === discriminant) {
          selected = index
          break
        }
      }
      // 选中 case 或回退到 default；都没有则无事发生
      const start = selected ?? defaultIndex
      if (start === undefined) return none
      for (let index = start; index < cases.length; index += 1) {
        for (const statement of cases[index]!.consequent) {
          const result = yield* this.evaluateStatement(statement)
          if (result.kind === "break") {
            // 不带标签的 break 结束 switch；带标签的向外传播
            if (result.label === undefined) return none
            return result
          }
          if (result.kind === "return" || result.kind === "continue") return result
        }
      }
      return none
    } finally {
      this.scopes.pop()
    }
  }

  private *evaluateWhileStatement(node: WhileStatement, labels?: ReadonlySet<string>): Eval<StatementResult> {
    const runner = this.ctx.runner
    while (true) {
      const test = this.evaluate(node.test)
      // 条件为假即退出
      if (!(isEval(test) ? yield* test : test)) break
      const executed = this.execute(node.body)
      const exit = loopExit(isEval(executed) ? yield* executed : executed, labels)
      if (exit !== undefined) return exit
      // 每轮结束给调度器记账；到量则让出切片，防止死循环独占宿主
      if (runner.tick()) yield Slice
    }

    return none
  }

  private *evaluateDoWhileStatement(node: DoWhileStatement, labels?: ReadonlySet<string>): Eval<StatementResult> {
    const runner = this.ctx.runner
    do {
      const exit = loopExit(yield* this.evaluateStatement(node.body), labels)
      if (exit !== undefined) return exit
      if (runner.tick()) yield Slice
    } while (yield* this.evaluateExpression(node.test))

    return none
  }

  private *evaluateForStatement(node: ForStatement, labels?: ReadonlySet<string>): Eval<StatementResult> {
    const runner = this.ctx.runner
    // for 头部的词法声明有自己的作用域
    this.scopes.push()
    try {
      const initNode = node.init
      const testNode = node.test
      const updateNode = node.update

      if (initNode?.type === "VariableDeclaration" && initNode.kind !== "var") {
        this.predeclareLexical([initNode])
      }

      if (initNode) {
        if (initNode.type === "VariableDeclaration") {
          yield* this.evaluateVariableDeclaration(initNode)
        } else {
          yield* this.evaluateExpression(initNode)
        }
      }

      // Each iteration gets fresh copies of the loop's `let` bindings, but only closures can tell them apart.
      // 每轮迭代获得 let 绑定的全新副本，但只有闭包能区分它们——体里没有闭包时不做复制
      const perIterationBindings =
        initNode?.type === "VariableDeclaration" &&
        initNode.kind !== "var" &&
        [node.init, node.test, node.update, node.body].some((part) => part && createsClosure(part))
          ? Array.from(this.scopes.current().keys())
          : []

      // 进入下一轮迭代：重建带新副本的循环作用域
      const nextIteration = () => {
        if (perIterationBindings.length === 0) return
        const current = this.scopes.current()
        this.scopes.pop()
        this.scopes.push(
          new Map(perIterationBindings.map((name): [string, Binding] => [name, { ...current.get(name)! }])),
        )
      }
      nextIteration()

      while (true) {
        if (testNode) {
          const test = this.evaluate(testNode)
          if (!(isEval(test) ? yield* test : test)) break
        }
        const executed = this.execute(node.body)
        const exit = loopExit(isEval(executed) ? yield* executed : executed, labels)
        if (exit !== undefined) return exit

        nextIteration()
        if (updateNode) {
          const update = this.evaluate(updateNode)
          if (isEval(update)) yield* update
        }
        if (runner.tick()) yield Slice
      }

      return none
    } finally {
      this.scopes.pop()
    }
  }

  private *evaluateForOfStatement(node: ForOfStatement, labels?: ReadonlySet<string>): Eval<StatementResult> {
    const runner = this.ctx.runner
    const awaiting = node.await
    const left = node.left
    const declared = loopDeclaration(left, "for...of")
    if (declared?.lexical) this.scopes.push()

    try {
      if (declared?.lexical) this.predeclarePattern(declared.pattern, declared.mutable, left)
      // 先求值右侧可迭代物
      const right = yield* this.evaluateExpression(node.right)

      const builtin = this.builtinCursor(right)
      const custom = builtin === undefined ? yield* this.customIterator(right, node, awaiting) : undefined
      if (custom === undefined && builtin === undefined) {
        throw invalidData(
          `${awaiting ? "for await...of" : "for...of"} requires an iterable value, received ${describeValue(right)}.`,
          node,
        )
      }
      // `for await` over a synchronous iterator drives it through CreateAsyncFromSyncIterator, as JS does.
      // 对同步迭代器做 `for await`：经 CreateAsyncFromSyncIterator 驱动，与 JS 一致
      const iterator = awaiting && !custom?.asynchronous ? this.asyncFromSync(builtin, custom, node) : custom
      const cursor = iterator === undefined ? builtin : undefined
      const self = this
      // 提前退出时关闭迭代器（调用其 return 方法）
      const close = function* (): Eval<void> {
        if (iterator) return yield* self.closeIterator(iterator, node)
        yield* cursor!.close()
      }

      if (left.type === "RestElement" || left.type === "AssignmentPattern") {
        throw typeError("Unsupported for...of binding.", left)
      }
      const assignment = left.type === "VariableDeclaration" ? undefined : left
      // Each iteration gets a fresh binding, but only a closure in the body can tell; without one, a single
      // `for (const x of ...)` binding is reused.
      // 每轮迭代都有新绑定，但只有体内的闭包能察觉；没有闭包时复用单个 `for (const x of ...)` 绑定
      const reused =
        declared?.lexical && declared.pattern.type === "Identifier" && !createsClosure(node.body)
          ? { mutable: declared.mutable, value: undefined as Value, initialized: false }
          : undefined
      if (reused !== undefined) this.scopes.push(new Map([[(declared!.pattern as Identifier).name, reused]]))

      try {
        while (true) {
          // 拉取迭代器的下一个值
          const step: Step = iterator ? yield* this.nextIteratorResult(iterator, node) : yield* cursor!.next()
          // 迭代结束：正常退出循环
          if (step.done) return none
          let result: StatementResult
          try {
            if (reused !== undefined) {
              // 复用绑定：直接写入当前值
              reused.value = step.value
              reused.initialized = true
              const executed = this.execute(node.body)
              result = isEval(executed) ? yield* executed : executed
            } else if (declared?.lexical) {
              // 词法声明：每轮在独立作用域中重新声明并初始化循环变量
              this.scopes.push()
              try {
                this.predeclarePattern(declared.pattern, declared.mutable, left)
                yield* this.declarePattern(declared.pattern, step.value, declared.mutable, left, true)
                result = yield* this.evaluateStatement(node.body)
              } finally {
                this.scopes.pop()
              }
            } else {
              if (declared) yield* this.assignPattern(declared.pattern, step.value, left)
              else if (assignment) yield* this.assignPattern(assignment, step.value, left)
              result = yield* this.evaluateStatement(node.body)
            }
          } catch (error) {
            // 体执行出错：先关闭迭代器再抛出，错误优先于关闭失败
            return yield* preserveConsumerError(close, thrower(error))
          }
          const exit = loopExit(result, labels)
          if (exit !== undefined) {
            yield* close()
            return exit
          }
          if (runner.tick()) yield Slice
        }
      } finally {
        if (reused !== undefined) this.scopes.pop()
      }
    } finally {
      if (declared?.lexical) this.scopes.pop()
    }
  }

  // CreateAsyncFromSyncIterator: an async iterator over a synchronous one. Each `next()` promise settles a job after
  // the value does, and a rejected value closes the synchronous iterator first; `return()` calls the synchronous
  // iterator's own `return`, or settles at once when it has none.
  // CreateAsyncFromSyncIterator：包装同步迭代器为异步迭代器。每个 next() 的 promise 在值落定后
  // 再结算一个作业；值被拒绝时先关闭同步迭代器；return() 调用同步迭代器自己的 return，
  // 没有则立即结算
  private asyncFromSync(
    builtin: Cursor | undefined,
    custom: CustomIterator | undefined,
    node: AstNode | undefined,
  ): CustomIterator {
    const ctx = this.ctx
    const runner = ctx.runner
    const builtins = ctx.builtins
    // 构造迭代器结果对象的便捷函数
    const result = (value: Value, done: boolean) => iteratorResult(builtins.Object, value, done)
    const self = this
    // IteratorNext passes the value `next` received, when it received one.
    // 拉取同步迭代器的下一步：内建迭代器走 hostCursor；自定义迭代器调用其 next 方法
    // （IteratorNext 会把 next 收到的参数传下去）
    const syncNext = function* (args: Array<Value>): Eval<Step> {
      if (!custom) return yield* builtin!.next()
      const object = self.requireIteratorObject(
        yield* self.call(custom.next, custom.iterator, args, node),
        "Iterator next() result",
        node,
      )
      return { done: Boolean(get(object, "done")), value: get(object, "value") }
    }
    // The synchronous iterator's `return`, looked up when it is needed; built-in collection iterators have none.
    // 同步迭代器的 return 方法，按需查找；内建集合迭代器没有
    const syncReturn = (): Value => (custom ? get(custom.iterator, "return") : undefined)
    // 把一步结果结算进异步 capability：值先被包成 promise 落定，再以结果对象 resolve；
    // 拒绝时可选地先关闭底层迭代器
    const settle = (step: Step, closeOnRejection: boolean, made: ReturnType<typeof capability>) => {
      const rejected = (reason: unknown) => {
        if (step.done || !closeOnRejection || reason instanceof Interruption) return made.reject(reason)
        const body = function* (): Eval<void> {
          try {
            if (custom) yield* self.closeIterator(custom, node)
            else yield* builtin!.close()
          } catch {
            // The rejection wins over a failing close.
          }
          made.reject(reason)
        }
        return { task: new Task([{ body: body(), boundary: undefined }]), input: normal(undefined) }
      }
      let wrapper: PromiseObj
      try {
        // 把该步的值包成 promise（调用其 then 可能运行程序代码）
        wrapper = runner.promiseResolve(step.value)
      } catch (error) {
        // 转换立即失败：排一个结算任务去拒绝
        const start = rejected(error)
        if (start !== undefined) runner.enqueue(() => start)
        return
      }
      // 值落定后：成功以结果对象 resolve；失败走 rejected（可选关闭底层迭代器）
      runner.then(wrapper, (settled) =>
        settled.ok ? made.resolve(result(settled.value as Value, step.done)) : rejected(settled.error),
      )
    }
    // 适配器的 next()：拉取同步结果并异步结算
    const next = fn(builtins, "next", 1, function* (_, args) {
      const made = capability(ctx, node)
      try {
        settle(yield* syncNext(args), true, made)
      } catch (error) {
        made.reject(error)
      }
      return made.promise
    })
    // 适配器的 return()：优先委托给同步迭代器的 return；没有则直接以完成值结算
    const close = fn(builtins, "return", 1, function* (_, args) {
      const made = capability(ctx, node)
      try {
        const method = syncReturn()
        if (method === undefined || method === null) {
          if (builtin !== undefined) yield* builtin.close()
          made.resolve(result(args[0], true))
          return made.promise
        }
        const returned = self.requireIteratorObject(
          yield* self.call(self.requireIteratorMethod(method, "Iterator return", node), custom!.iterator, args, node),
          "Iterator return() result",
          node,
        )
        settle({ done: Boolean(get(returned, "done")), value: get(returned, "value") }, false, made)
      } catch (error) {
        made.reject(error)
      }
      return made.promise
    })
    // 适配器的 throw()：委托给同步迭代器的 throw；缺失时关闭迭代器并拒绝
    const raise = fn(builtins, "throw", 1, function* (_, args) {
      const made = capability(ctx, node)
      try {
        const method = custom ? get(custom.iterator, "throw") : undefined
        if (method === undefined || method === null) {
          if (custom) yield* self.closeIterator(custom, node)
          else yield* builtin!.close()
          made.reject(typeError("The delegated iterator does not provide a throw() method.", node))
          return made.promise
        }
        const thrown = self.requireIteratorObject(
          yield* self.call(self.requireIteratorMethod(method, "Iterator throw", node), custom!.iterator, args, node),
          "Iterator throw() result",
          node,
        )
        settle({ done: Boolean(get(thrown, "done")), value: get(thrown, "value") }, true, made)
      } catch (error) {
        made.reject(error)
      }
      return made.promise
    })
    // 组装适配器对象（三个方法都隐藏）
    const adapter = new Obj(builtins.Object)
    define(adapter, "next", next, hidden)
    define(adapter, "return", close, hidden)
    define(adapter, "throw", raise, hidden)
    return { iterator: adapter, next, asynchronous: true }
  }

  // 获取值上的迭代游标：优先内建游标（字符串/内建集合），否则走自定义 [Symbol.iterator]
  *iterate(value: Value, node?: AstNode): Eval<Cursor | undefined> {
    const cursor = this.builtinCursor(value)
    if (cursor !== undefined) return cursor
    const iterator = yield* this.customIterator(value, node, false)
    return iterator === undefined ? undefined : this.customCursor(iterator, node)
  }

  /** GetIteratorDirect: drive an iterator by its own `next`, without asking for `[Symbol.iterator]`. */
  // GetIteratorDirect：直接用迭代器对象自己的 next 驱动，不查 [Symbol.iterator]（迭代器辅助方法语义）
  iterateDirect(value: Value, node?: AstNode): Cursor {
    if (value instanceof IteratorObj) return value.cursor
    if (!(value instanceof Obj)) {
      throw typeError(`An iterator must be an object, received ${describeValue(value)}.`, node)
    }
    return this.customCursor(
      {
        iterator: value,
        next: this.requireIteratorMethod(get(value, "next"), "Iterator next", node),
        asynchronous: false,
      },
      node,
    )
  }

  // 把自定义迭代器包装成 next/close 游标
  private customCursor(iterator: CustomIterator, node: AstNode | undefined): Cursor {
    return {
      next: () => this.nextIteratorResult(iterator, node),
      close: () => this.closeIterator(iterator, node),
    }
  }

  // 内建可迭代物的游标：字符串用其原生迭代器，Obj 查内建迭代器实现
  private builtinCursor(value: Value): Cursor | undefined {
    if (value instanceof IteratorObj) return value.cursor
    const iterator =
      typeof value === "string"
        ? value[Symbol.iterator]()
        : value instanceof Obj
          ? value.iterator(this.ctx.builtins)
          : undefined
    return iterator === undefined ? undefined : hostCursor(iterator)
  }

  // 解析自定义迭代器：查 [Symbol.asyncIterator] 或 [Symbol.iterator]，调用并校验返回的迭代器对象
  private *customIterator(
    value: Value,
    node: AstNode | undefined,
    allowAsync = true,
  ): Eval<CustomIterator | undefined> {
    // 非对象没有自定义迭代器
    if (!(value instanceof Obj)) return undefined
    const asyncMethod = allowAsync ? get(value, AsyncIteratorSymbol) : undefined
    // 优先异步迭代方法
    const method = asyncMethod ?? get(value, IteratorSymbol)
    if (method === undefined || method === null) return undefined
    // 调用迭代方法取得迭代器对象并校验
    const iterator = yield* this.call(this.requireIteratorMethod(method, "Iterator method", node), value, [], node)
    const object = this.requireIteratorObject(iterator, "Iterator method result", node)
    return {
      iterator: object,
      next: this.requireIteratorMethod(get(object, "next"), "Iterator next", node),
      asynchronous: asyncMethod !== undefined && asyncMethod !== null,
    }
  }

  // 调用迭代器的 next 并校验/解包结果对象（异步迭代器先 await）
  private *nextIteratorResult(iterator: CustomIterator, node: AstNode | undefined): Eval<Step> {
    const called = yield* this.call(iterator.next, iterator.iterator, [], node)
    const object = this.requireIteratorObject(
      iterator.asynchronous ? yield* this.awaitValue(called, node) : called,
      "Iterator next() result",
      node,
    )
    return { done: Boolean(get(object, "done")), value: get(object, "value") }
  }

  // 关闭迭代器：调用其 return 方法（存在时），并校验返回值
  private *closeIterator(iterator: CustomIterator, node: AstNode | undefined): Eval<void> {
    const close = get(iterator.iterator, "return")
    if (close === undefined || close === null) return
    const method = this.requireIteratorMethod(close, "Iterator return", node)
    const called = yield* this.call(method, iterator.iterator, [], node)
    this.requireIteratorObject(
      iterator.asynchronous ? yield* this.awaitValue(called, node) : called,
      "Iterator return() result",
      node,
    )
  }

  private requireIteratorObject(value: Value, context: string, node?: AstNode): Obj {
    // 必须是对象
    if (value instanceof Obj) return value
    throw typeError(`${context} must be an object.`, node)
  }

  private requireIteratorMethod(value: Value, context: string, node?: AstNode): Value {
    // 必须是函数
    if (typeofValue(value) === "function") return value
    throw typeError(`${context} must be a function.`, node)
  }

  // for...in over null/undefined iterates nothing, like JS. After the own keys come each prototype's enumerable
  // string keys, skipping any key a nearer level has, even as a non-enumerable property.
  // 收集 for...in 的可枚举字符串键：null/undefined 空迭代（与 JS 一致）。
  // 自有键之后按原型链逐层附加，跳过更近层已有（即使为不可枚举）的键
  private enumerableKeys(value: Value, node: AstNode): Array<string> {
    if (value instanceof ToolReference) return [...this.ctx.tools.keys(value.path)]
    if (value === null || value === undefined) return []
    const source = enumerableSource(this.ctx, "for...in", value, node)
    const chain = [source]
    // A string's characters stand in an array, but its prototype is String.prototype.
    // 字符串的字符以数组形式排列，但其原型是 String.prototype——这里显式纠正
    let proto = primitivePrototype(this.ctx.builtins, value) ?? source.proto
    while (proto !== null) {
      chain.push(proto)
      proto = proto.proto
    }
    return chain.flatMap((target, depth) => {
      const nearer = chain.slice(0, depth)
      return keys(target).filter((key) => !nearer.some((level) => hasOwn(level, key)))
    })
  }

  private *evaluateForInStatement(node: ForInStatement, labels?: ReadonlySet<string>): Eval<StatementResult> {
    const runner = this.ctx.runner
    const left = node.left
    const declared = loopDeclaration(left, "for...in")
    if (declared?.lexical) this.scopes.push()

    try {
      if (declared?.lexical) this.predeclarePattern(declared.pattern, declared.mutable, left)
      // 先求值被枚举的对象
      const right = yield* this.evaluateExpression(node.right)

      // 收集全部可枚举字符串键
      const keys = this.enumerableKeys(right, node.right)

      if (left.type === "RestElement" || left.type === "AssignmentPattern") {
        throw typeError("Unsupported for...in binding.", left)
      }
      const assignment = left.type === "VariableDeclaration" ? undefined : left

      for (const key of keys) {
        let result: StatementResult
        if (declared?.lexical) {
          // 词法声明：每轮独立作用域重新声明
          this.scopes.push()
          try {
            this.predeclarePattern(declared.pattern, declared.mutable, left)
            yield* this.declarePattern(declared.pattern, key, declared.mutable, left, true)
            result = yield* this.evaluateStatement(node.body)
          } finally {
            this.scopes.pop()
          }
        } else {
          if (declared) yield* this.assignPattern(declared.pattern, key, left)
          else if (assignment) yield* this.assignPattern(assignment, key, left)
          result = yield* this.evaluateStatement(node.body)
        }

        const exit = loopExit(result, labels)
        if (exit !== undefined) return exit
        if (runner.tick()) yield Slice
      }

      return none
    } finally {
      if (declared?.lexical) this.scopes.pop()
    }
  }

  private evaluateBreakStatement(node: BreakStatement): StatementResult {
    return node.label ? { kind: "break", label: node.label.name } : { kind: "break" }
  }

  private evaluateContinueStatement(node: ContinueStatement): StatementResult {
    return node.label ? { kind: "continue", label: node.label.name } : { kind: "continue" }
  }

  // 带标签的语句：收集全部标签，把标签集传给循环；命中标签的 break 在此被吞掉
  private *evaluateLabeledStatement(node: LabeledStatement): Eval<StatementResult> {
    const labels = new Set<string>()
    let body: Statement = node
    while (body.type === "LabeledStatement") {
      labels.add(body.label.name)
      body = body.body
    }

    const result =
      body.type === "WhileStatement"
        ? yield* this.evaluateWhileStatement(body, labels)
        : body.type === "DoWhileStatement"
          ? yield* this.evaluateDoWhileStatement(body, labels)
          : body.type === "ForStatement"
            ? yield* this.evaluateForStatement(body, labels)
            : body.type === "ForOfStatement"
              ? yield* this.evaluateForOfStatement(body, labels)
              : body.type === "ForInStatement"
                ? yield* this.evaluateForInStatement(body, labels)
                : yield* this.evaluateStatement(body)

    return result.kind === "break" && result.label !== undefined && labels.has(result.label) ? none : result
  }

  private *evaluateThrowStatement(node: ThrowStatement): Eval<StatementResult> {
    throw new Throw(yield* this.evaluateExpression(node.argument))
  }

  // try/catch/finally：catch 只捕获程序异常（Interruption 与生成器 return 除外）；
  // finally 突然完成时覆盖原结果；被吞掉的失败在 finally 之后再抛出
  private *evaluateTryStatement(node: TryStatement): Eval<StatementResult> {
    const handler = node.handler
    const finalizer = node.finalizer
    let result: StatementResult = none
    let failure: { readonly error: unknown } | undefined

    try {
      // 先执行 try 块
      result = yield* this.evaluateStatement(node.block)
    } catch (error) {
      // 中断（宿主取消）必须继续上抛，catch 不拦
      if (error instanceof Interruption) throw error
      // A generator's return() unwinds through `finally` but is not an exception `catch` sees.
      // 生成器的 return() 会穿过 finally 展开，但对 catch 而言不是异常
      if (error instanceof GeneratorReturn || !handler) {
        if (!finalizer) throw error
        failure = { error }
      } else {
        // 物化为程序可见的错误对象并绑定到 catch 参数
        const caught = materialize(this.ctx, error)
        const parameter = handler.param
        // catch 块有自己的作用域
        this.scopes.push()
        try {
          if (parameter) yield* this.declarePattern(parameter, caught, true, handler)
          result = yield* this.evaluateStatement(handler.body)
        } catch (error) {
          if (!finalizer || error instanceof Interruption) throw error
          failure = { error }
        } finally {
          this.scopes.pop()
        }
      }
    }

    if (!finalizer) return result
    // 再执行 finally 块
    const final = yield* this.evaluateStatement(finalizer)
    // finally 的突然完成覆盖原结果（与 JS 一致）
    if (isAbrupt(final)) return final
    if (failure) throw failure.error
    return result
  }

  // 变量声明：var 有初始化则赋值（绑定已在函数入口提升）；let/const 声明并初始化
  private *evaluateVariableDeclaration(node: VariableDeclaration): Eval<void> {
    const kind = node.kind
    for (const declaration of node.declarations) {
      if (declaration.type !== "VariableDeclarator") {
        throw typeError("Unsupported variable declaration shape.", declaration)
      }

      const init = declaration.init
      // `var x` alone is a no-op: the binding was hoisted on function entry.
      // 单独的 `var x` 是空操作：绑定已在函数入口提升
      const id = declaration.id
      if (kind === "var") {
        if (init) {
          // var 带初始化：求值后按模式赋值
          const value =
            id.type === "Identifier" ? yield* this.evaluateNamed(init, id.name) : yield* this.evaluateExpression(init)
          yield* this.assignPattern(id, value, declaration)
        }
        continue
      }
      // let/const：无初始化则为 undefined；否则求值（可参与 NamedEvaluation）后声明
      const value = !init
        ? undefined
        : id.type === "Identifier"
          ? yield* this.evaluateNamed(init, id.name)
          : yield* this.evaluateExpression(init)
      yield* this.declarePattern(declaration.id, value, kind !== "const", declaration, true)
    }
  }

  // 声明模式：把值绑定到解构模式的各个名字（Identifier/默认值/对象/数组）
  private *declarePattern(
    pattern: Pattern,
    value: Value,
    mutable: boolean,
    node: AstNode,
    initialize = false,
  ): Eval<void> {
    if (pattern.type === "Identifier") {
      const name = pattern.name
      // initialize 为真表示预声明的绑定此刻补值；否则是全新声明
      if (initialize) this.scopes.initialize(name, value, node)
      else this.scopes.declare(name, value, mutable, node)
      return
    }

    if (pattern.type === "AssignmentPattern") {
      // 值为 undefined 时使用默认值
      const resolved = value === undefined ? yield* this.evaluateDefault(pattern) : value
      yield* this.declarePattern(pattern.left, resolved, mutable, node, initialize)
      return
    }

    if (pattern.type === "ObjectPattern") {
      if (value === null || value === undefined) {
        throw typeError(`Cannot destructure ${describeValue(value)} as it is ${value}.`, pattern)
      }

      // consumed 记录已被具体属性消费的键，rest 收集剩余
      const consumed = new Set<PropertyKey>()
      for (const property of pattern.properties) {
        if (property.type === "RestElement") {
          // rest 属性：收集未消费的可枚举属性到新对象
          const rest = new Obj(this.ctx.builtins.Object)
          assign(rest, enumerableSource(this.ctx, "Object destructuring", value, pattern), consumed)
          yield* this.declarePattern(property.argument, rest, mutable, property, initialize)
          continue
        }

        // 具体属性：记录键并递归声明其值
        const key = yield* this.destructuringPropertyKey(property)
        consumed.add(typeof key === "symbol" ? key : String(key))
        yield* this.declarePattern(
          property.value,
          this.destructuredProperty(value, key, property),
          mutable,
          property,
          initialize,
        )
      }
      return
    }

    if (pattern.type === "ArrayPattern") {
      return yield* this.destructureArrayPattern(pattern, value, (target, item, context) =>
        this.declarePattern(target, item, mutable, context, initialize),
      )
    }

    throw typeError(`Unsupported binding pattern '${pattern.type}'.`, pattern)
  }

  // 赋值模式：把值赋给解构模式的各个目标（变量、成员、嵌套模式）
  private *assignPattern(pattern: Pattern, value: Value, node: AstNode): Eval<void> {
    if (pattern.type === "Identifier") {
      // 变量赋值
      this.scopes.set(pattern.name, value, pattern)
      return
    }

    if (pattern.type === "MemberExpression") {
      // 成员赋值
      yield* this.writeMember(pattern, value)
      return
    }

    if (pattern.type === "AssignmentPattern") {
      // 值为 undefined 时使用默认值
      const resolved = value === undefined ? yield* this.evaluateDefault(pattern) : value
      yield* this.assignPattern(pattern.left, resolved, node)
      return
    }

    if (pattern.type === "ObjectPattern") {
      if (value === null || value === undefined) {
        throw typeError(`Cannot destructure ${describeValue(value)} as it is ${value}.`, pattern)
      }

      const consumed = new Set<PropertyKey>()
      for (const property of pattern.properties) {
        if (property.type === "RestElement") {
          // rest 属性：收集未消费的可枚举属性到新对象
          const rest = new Obj(this.ctx.builtins.Object)
          assign(rest, enumerableSource(this.ctx, "Object destructuring", value, pattern), consumed)
          yield* this.assignPattern(property.argument, rest, property)
          continue
        }
        // 具体属性：记录键并递归赋值
        const key = yield* this.destructuringPropertyKey(property)
        consumed.add(typeof key === "symbol" ? key : String(key))
        yield* this.assignPattern(property.value, this.destructuredProperty(value, key, property), property)
      }
      return
    }

    if (pattern.type === "ArrayPattern") {
      return yield* this.destructureArrayPattern(pattern, value, (target, item, context) =>
        this.assignPattern(target, item, context),
      )
    }

    throw typeError(`Unsupported assignment pattern '${pattern.type}'.`, node)
  }

  // 求值解构默认值（目标名可参与 NamedEvaluation）
  private evaluateDefault(pattern: AssignmentPattern): Eval<Value> {
    return pattern.left.type === "Identifier"
      ? this.evaluateNamed(pattern.right, pattern.left.name)
      : this.evaluateExpression(pattern.right)
  }

  // 数组解构：用游标逐个取元素；null 元素是跳洞；rest 收集剩余全部；
  // 消费出错时先关闭迭代器，与循环语义一致
  private *destructureArrayPattern(
    pattern: ArrayPattern,
    value: Value,
    consume: (target: Pattern, value: Value, context: AstNode) => Eval<void>,
  ): Eval<void> {
    const cursor = yield* this.iterate(value, pattern)
    if (cursor === undefined) {
      throw typeError("Array destructuring requires a supported iterable value.", pattern)
    }
    let done = false
    for (const element of pattern.elements) {
      if (done) {
        // 迭代器已耗尽：普通元素绑定 undefined，rest 绑定空数组
        if (element === null) continue
        yield* consume(
          element.type === "RestElement" ? element.argument : element,
          element.type === "RestElement" ? new Arr(this.ctx.builtins.Array) : undefined,
          element,
        )
        if (element.type === "RestElement") return
        continue
      }
      // 拉取下一个元素
      const step = yield* cursor.next()
      done = step.done
      if (element === null) continue
      if (element.type === "RestElement") {
        // rest 元素：吞掉剩余全部值
        const rest: Array<Value> = []
        if (!step.done) rest.push(step.value)
        while (!done) {
          const next = yield* cursor.next()
          done = next.done
          if (!done) rest.push(next.value)
        }
        yield* consume(element.argument, new Arr(this.ctx.builtins.Array, rest), element)
        return
      }
      // 普通元素：消费取到的值（未耗尽时包一层"出错先关闭迭代器"）
      const consumed = consume(element, step.done ? undefined : step.value, pattern)
      yield* step.done ? consumed : preserveConsumerError(cursor.close, consumed)
    }
    // 元素取完但迭代器未耗尽：补一次关闭
    if (!done) yield* cursor.close()
  }

  // 求值对象解构的属性键：支持计算键、标识符与字面量
  private *destructuringPropertyKey(property: Property | AssignmentProperty): Eval<PropertyKey> {
    if (property.type !== "Property" || property.kind !== "init") {
      throw typeError("Unsupported object destructuring property.", property)
    }
    const keyNode = property.key
    if (property.computed) return yield* this.toPropertyKey(yield* this.evaluateExpression(keyNode), keyNode)
    if (keyNode.type === "Identifier") return keyNode.name
    if (keyNode.type === "Literal") return String(keyNode.value)
    throw unsupportedSyntax(keyNode.type, keyNode)
  }

  // 表达式求值的生成器形式：同步可完成的表达式直接返回值
  private *evaluateExpression(node: Expression): Eval<Value> {
    const result = this.evaluate(node)
    return isEval(result) ? yield* result : result
  }

  // Evaluates leaves directly and returns the work for anything that may run program code, so the common cases cost
  // no generator; callers finish the work with `yield*`.
  // 表达式快路径：叶子直接求值，可能运行程序代码的求值返回工作（Eval），
  // 调用方再以 `yield*` 收尾——常见情况零生成器开销
  private evaluate(node: Expression): Value | Eval<Value> {
    switch (node.type) {
      case "Literal": {
        const regex = node.regex
        // 正则字面量在此物化为受控的 RegExp 对象
        if (regex) return constructRegExp(this.ctx.builtins, [regex.pattern, regex.flags])
        return literal(node)
      }
      case "Identifier":
        return this.scopes.get(node.name, node)
      case "ThisExpression":
        return this.scopes.get("this", node)
      case "BinaryExpression": {
        const operator = node.operator
        if (node.left.type === "PrivateIdentifier") throw unsupportedSyntax(node.left.type, node.left)
        // 左操作数可同步算出则继续；否则交由生成器收尾（保证求值顺序）
        const left = this.evaluate(node.left)
        if (isEval(left)) return this.evaluateBinaryExpression(node, left)
        const right = this.evaluate(node.right)
        if (isEval(right)) return this.evaluateBinaryExpression(node, left, right)
        if (operator === "instanceof") return instanceofValue(left, right, node)
        // 任一操作数是数据对象则走转换路径
        if (left instanceof Obj || right instanceof Obj) return this.applyOperator(operator, left, right, node)
        return this.applyBinaryOperator(operator, left, right, node)
      }
      case "LogicalExpression":
        return this.evaluateLogicalExpression(node)
      case "UnaryExpression":
        return this.evaluateUnaryExpression(node)
      case "AssignmentExpression": {
        const left = node.left
        // 变量赋值的快路径；成员/解构目标走通用路径
        if (left.type !== "Identifier") return this.evaluateAssignmentExpression(node)
        if (node.operator === "=") {
          // 匿名函数赋给变量：按 NamedEvaluation 命名
          const right =
            node.right.type === "ArrowFunctionExpression" ||
            (node.right.type === "FunctionExpression" && !node.right.id)
              ? this.createFunction(node.right, left.name)
              : this.evaluate(node.right)
          return isEval(right) ? this.assignAfter(left, right) : this.scopes.set(left.name, right, left)
        }
        // 不支持的复合运算符交由通用路径报错
        if (!compoundOperators.has(node.operator)) return this.evaluateAssignmentExpression(node)
        // 复合赋值快路径：原值与右侧都是原始值时直接运算写回
        const current = this.scopes.get(left.name, left)
        const right = this.evaluate(node.right)
        if (isEval(right) || current instanceof Obj || right instanceof Obj)
          return this.compoundAfter(node, current, right)
        return this.scopes.set(
          left.name,
          this.applyBinaryOperator(node.operator.slice(0, -1), current, right, node),
          left,
        )
      }
      case "SequenceExpression":
        return this.evaluateSequenceExpression(node)
      case "CallExpression":
        return this.evaluateCallExpression(node)
      case "ArrowFunctionExpression":
      case "FunctionExpression":
        // 函数定义即物化函数对象（无需生成器）
        return this.createFunction(node)
      case "MemberExpression": {
        const objectNode = node.object
        const propertyNode = node.property
        if (objectNode.type === "Super") throw unsupportedSyntax(objectNode.type, objectNode)
        if (propertyNode.type === "PrivateIdentifier") throw unsupportedSyntax(propertyNode.type, propertyNode)
        // 先求值对象
        const object = this.evaluate(objectNode)
        if (isEval(object)) return this.readMember(node, object)
        if (object === OptionalShortCircuit) return OptionalShortCircuit
        // 可选链：对象为空且节点带 optional 时短路
        if ((object === null || object === undefined) && node.optional) return OptionalShortCircuit
        // 非计算属性直接取名字；否则求值键表达式
        const key =
          !node.computed && propertyNode.type === "Identifier" ? propertyNode.name : this.evaluate(propertyNode)
        if (isEval(key)) return this.readMember(node, object, key)
        const reference = this.memberReference(node, object, key)
        return isEval(reference) ? this.readMember(node, object, key) : this.readResolved(node, reference)
      }
      case "ChainExpression":
        return this.evaluateChainExpression(node)
      case "ObjectExpression":
        return this.evaluateObjectExpression(node)
      case "ArrayExpression":
        return this.evaluateArrayExpression(node)
      case "TemplateLiteral":
        return this.evaluateTemplateLiteral(node)
      case "TaggedTemplateExpression":
        return this.evaluateTaggedTemplate(node)
      case "ConditionalExpression":
        return this.evaluateConditionalExpression(node)
      case "UpdateExpression": {
        const argument = node.argument
        // 仅变量目标是原始值时走快路径
        if (argument.type !== "Identifier") return this.evaluateUpdateExpression(node)
        const current = this.scopes.get(argument.name, argument)
        if (current instanceof Obj) return this.evaluateUpdateExpression(node)
        return this.update(node, argument, current)
      }
      case "AwaitExpression":
        return this.evaluateAwaitExpression(node)
      case "YieldExpression":
        return this.evaluateYieldExpression(node)
      case "NewExpression":
        return this.evaluateNewExpression(node)
      case "ImportExpression":
        return this.evaluateImportExpression(node)
      default:
        throw unsupportedSyntax(node.type, node)
    }
  }

  // 逗号表达式：逐个求值，取最后一个结果
  private *evaluateSequenceExpression(node: SequenceExpression): Eval<Value> {
    let result: Value
    for (const expression of node.expressions) {
      const value = this.evaluate(expression)
      result = isEval(value) ? yield* value : value
    }
    return result
  }

  // 可选链表达式：把短路哨兵还原为 undefined
  private *evaluateChainExpression(node: ChainExpression): Eval<Value> {
    const value = yield* this.evaluateExpression(node.expression)
    return value === OptionalShortCircuit ? undefined : value
  }

  // 三元表达式：只求值命中的分支
  private *evaluateConditionalExpression(node: ConditionalExpression): Eval<Value> {
    const test = this.evaluate(node.test)
    const branch = this.evaluate((isEval(test) ? yield* test : test) ? node.consequent : node.alternate)
    return isEval(branch) ? yield* branch : branch
  }

  private *evaluateAwaitExpression(node: AwaitExpression): Eval<Value> {
    // Await always suspends, including for plain values.
    // await 总是挂起，即使对普通值也一样（保持一致的时间线）
    return yield* this.awaitValue(yield* this.evaluateExpression(node.argument), node)
  }

  private *evaluateNewExpression(node: NewExpression): Eval<Value> {
    const callee = yield* this.evaluateExpression(node.callee)
    const construct = callee instanceof Native ? callee.construct : undefined
    if (construct === undefined) {
      // `new` itself is supported, so a non-constructible callee is a TypeError like JS rather than
      // unsupported syntax. Built-ins like Number are real constructors in JS, so do not claim
      // otherwise; say `new` is unsupported for them and point at the plain call.
      // `new` 本身是支持的，因此不可构造的被调用者报 TypeError（与 JS 一致）而非"语法不支持"。
      // Number 之类内建在 JS 中确实是构造器，所以对它们说"new 不支持"并指向普通调用
      const name = calleeDescription(node.callee) ?? "The called value"
      const message =
        callee instanceof Fn
          ? `${name} cannot be constructed: user-defined constructors and classes are not supported. Call it as a function that returns a plain object instead.`
          : callee instanceof Native
            ? `new ${name}(...) is not supported; call ${name}(...) without new instead.`
            : `${name} is not a constructor.`
      throw typeError(message, node)
    }
    const args = yield* this.evaluateCallArguments(node.arguments)
    const result = this.native(() => construct(args, callee as Native, node), node)
    return isEval(result) ? yield* result : result
  }

  // Finishes a binary expression whose left operand (and maybe right) `evaluate` already started.
  // 收尾一个双目表达式：左（或右）操作数的求值已由快路径启动，这里续跑剩余部分
  private *evaluateBinaryExpression(
    node: BinaryExpression,
    leftValue: Value | Eval<Value>,
    started: Value | Eval<Value> | typeof unevaluated = unevaluated,
  ): Eval<Value> {
    const operator = node.operator
    const lhs = isEval(leftValue) ? yield* leftValue : leftValue
    const rightValue = started === unevaluated ? this.evaluate(node.right) : started
    const rhs = isEval(rightValue) ? yield* rightValue : rightValue
    if (operator === "instanceof") return instanceofValue(lhs, rhs, node)
    if (lhs instanceof Obj || rhs instanceof Obj) return yield* this.applyOperator(operator, lhs, rhs, node)
    return this.applyBinaryOperator(operator, lhs, rhs, node)
  }

  /** ToPrimitive for an operand: data objects run their own methods; opaque values stay for the data gates below. */
  // 对操作数做 ToPrimitive：数据对象运行自己的转换方法；不透明值保持原样交给下层的数据门禁
  private *toPrimitive(value: Value, hint: Hint, node: AstNode): Eval<Value> {
    const result = this.native(() => toPrimitive(this.ctx, value, hint), node)
    return isEval(result) ? yield* result : result
  }

  // Arithmetic, relational, and bitwise operators convert both operands first, left then right, so a `valueOf`
  // runs (and throws) in spec order; `+` asks for the default hint and the rest for a number.
  // 双目运算符的对象路径：先左后右把两个操作数转成原始值，valueOf 按规范顺序运行（抛错也在该顺序）；
  // `+` 请求 default 提示，其余请求 number 提示
  private *applyOperator(operator: string, lhs: Value, rhs: Value, node: AstNode): Eval<Value> {
    if (!(lhs instanceof Obj || rhs instanceof Obj)) return this.applyBinaryOperator(operator, lhs, rhs, node)
    // IsLooselyEqual converts only an object facing a non-nullish primitive; two objects (including tool
    // references, which are not Obj) compare by identity.
    // IsLooselyEqual 只有"对象 vs 非空原始值"才转换；两个对象（包括工具引用，它们不是 Obj）按恒等比较
    const equality = operator === "==" || operator === "!="
    // `in` checks the right operand before ToPropertyKey on the left, so a bad right side wins over a bad key.
    // `in` 先检查右操作数，再对左侧做 ToPropertyKey：坏右值优先于坏键报错
    if (operator === "in" && lhs instanceof Obj && !isOpaque(lhs) && rhs instanceof Obj) {
      return has(rhs, yield* this.toPropertyKey(lhs, node))
    }
    const other = lhs instanceof Obj ? rhs : lhs
    const converts =
      primitiveOperators.has(operator) ||
      (equality && other !== null && other !== undefined && typeof other !== "object")
    if (!converts) return this.applyBinaryOperator(operator, lhs, rhs, node)
    const hint = operator === "+" || equality ? "default" : "number"
    const l = yield* this.toPrimitive(lhs, hint, node)
    const r = yield* this.toPrimitive(rhs, hint, node)
    return this.applyBinaryOperator(operator, l, r, node)
  }

  // 纯原始值的双目运算：恒等/相等/in 直接分派；其余按算术、关系、位运算逐个实现
  private applyBinaryOperator(operator: string, lhs: Value, rhs: Value, node: AstNode): Value {
    if (operator === "===") return lhs === rhs
    if (operator === "!==") return lhs !== rhs
    if (operator === "==") return this.looselyEqual(lhs, rhs, node)
    if (operator === "!=") return !this.looselyEqual(lhs, rhs, node)
    if (operator === "in" && rhs instanceof Obj && !isOpaque(lhs)) return has(rhs, propertyKey(lhs))
    if (isOpaque(lhs) || isOpaque(rhs)) {
      throw invalidData("Binary operators require data values.", node)
    }
    // Object operands were already converted by applyOperator; only primitives reach the arithmetic below.
    // 对象操作数已被 applyOperator 转换；能走到下面的算术分支的都是原始值
    switch (operator) {
      case "+": {
        const sum = (lhs as string) + (rhs as string)
        if (typeof sum === "string") checkStringLength(sum.length)
        return sum
      }
      case "-":
        return (lhs as number) - (rhs as number)
      case "*":
        return (lhs as number) * (rhs as number)
      case "/":
        return (lhs as number) / (rhs as number)
      case "%":
        return (lhs as number) % (rhs as number)
      case "**":
        return (lhs as number) ** (rhs as number)
      case "<":
        return (lhs as string) < (rhs as string)
      case "<=":
        return (lhs as string) <= (rhs as string)
      case ">":
        return (lhs as string) > (rhs as string)
      case ">=":
        return (lhs as string) >= (rhs as string)
      case "&":
        return (lhs as number) & (rhs as number)
      case "|":
        return (lhs as number) | (rhs as number)
      case "^":
        return (lhs as number) ^ (rhs as number)
      case "<<":
        return (lhs as number) << (rhs as number)
      case ">>":
        return (lhs as number) >> (rhs as number)
      case ">>>":
        return (lhs as number) >>> (rhs as number)
      case "in":
        throw typeError("The 'in' operator requires a data object on the right-hand side.", node)
      default:
        throw typeError(`Unsupported binary operator '${operator}'.`, node)
    }
  }

  // IsLooselyEqual: objects (including functions and tool references) compare by identity, and a nullish
  // primitive never equals an object.
  // IsLooselyEqual：对象（含函数与工具引用）按恒等比较；空原始值永不等于对象
  private looselyEqual(lhs: Value, rhs: Value, node: AstNode): boolean {
    const lhsObject = lhs !== null && typeof lhs === "object"
    const rhsObject = rhs !== null && typeof rhs === "object"
    if (lhsObject === rhsObject) return lhsObject ? lhs === rhs : lhs == rhs
    const primitive = lhsObject ? rhs : lhs
    if (primitive === null || primitive === undefined) return false
    // Data objects were converted by applyOperator, so only an opaque reference facing a primitive gets here.
    // 数据对象已被 applyOperator 转换；走到这里的只剩"不透明引用 vs 原始值"的组合
    throw invalidData("Binary operators require data values.", node)
  }

  // 逻辑表达式：&& || ?? 的短路语义
  private *evaluateLogicalExpression(node: LogicalExpression): Eval<Value> {
    const operator = node.operator
    const leftValue = this.evaluate(node.left)
    const left = isEval(leftValue) ? yield* leftValue : leftValue
    if (operator === "&&") return left ? yield* this.evaluateExpression(node.right) : left
    if (operator === "||") return left ? left : yield* this.evaluateExpression(node.right)
    if (operator === "??")
      return left !== null && left !== undefined ? left : yield* this.evaluateExpression(node.right)
    throw typeError(`Unsupported logical operator '${operator}'.`, node)
  }

  // 一元运算符：delete/typeof/!/void 与数值转换类（+ - ~）
  private *evaluateUnaryExpression(node: UnaryExpression): Eval<Value> {
    const operator = node.operator
    const argument = node.argument
    if (operator === "delete") return yield* this.evaluateDeleteExpression(argument)
    // Undeclared names short-circuit, but declared TDZ bindings must still throw.
    // 未声明的名字直接返回 "undefined" 短路；已声明但处于 TDZ 的绑定仍须抛错
    if (operator === "typeof" && argument.type === "Identifier" && !this.scopes.resolve(argument.name)) {
      return "undefined"
    }
    const value = yield* this.evaluateExpression(argument)
    // 各一元运算符分派
    if (operator === "typeof") return typeofValue(value)
    if (operator === "!") return !value
    if (operator === "void") return undefined
    // 数值类运算符先转原始值
    const operand = yield* this.toPrimitive(value, "number", node)
    if (isOpaque(operand)) {
      throw invalidData("Unary operators require data values.", node)
    }
    switch (operator) {
      // 数值转换类：+x / -x / ~x
      case "+":
        return +(operand as number)
      case "-":
        return -(operand as number)
      case "~":
        return ~(operand as number)
      default:
        throw typeError(`Unsupported unary operator '${operator}'.`, node)
    }
  }

  // 赋值表达式：= 与复合运算；目标是变量或成员；解构赋值走 assignPattern
  private *evaluateAssignmentExpression(node: AssignmentExpression): Eval<Value> {
    const left = node.left
    const operator = node.operator
    // The binary operator a compound assignment applies: `+=` is `+`.
    // 复合赋值应用的二元运算符：`+=` 就是 `+`
    const binary = operator.slice(0, -1)
    if (operator === "??=" || operator === "||=" || operator === "&&=") {
      return yield* this.evaluateLogicalAssignment(node, left, operator)
    }
    if (operator !== "=" && !compoundOperators.has(operator)) {
      throw typeError(`Unsupported assignment operator '${operator}'.`, node)
    }
    if (operator === "=" && (left.type === "ObjectPattern" || left.type === "ArrayPattern")) {
      // 解构赋值：右侧求值一次后按模式分配
      const rightValue = yield* this.evaluateExpression(node.right)
      yield* this.assignPattern(left, rightValue, node)
      return rightValue
    }
    if (left.type === "Identifier") {
      const name = left.name
      if (operator !== "=") {
        // 复合赋值：取原值、求右侧、运算、写回
        const current = this.scopes.get(name, left)
        const evaluated = this.evaluate(node.right)
        const rightValue = isEval(evaluated) ? yield* evaluated : evaluated
        const next =
          current instanceof Obj || rightValue instanceof Obj
            ? yield* this.applyOperator(binary, current, rightValue, node)
            : this.applyBinaryOperator(binary, current, rightValue, node)
        return this.scopes.set(name, next, left)
      }
      // 普通赋值（右侧可参与 NamedEvaluation）
      const rightValue = yield* this.evaluateNamed(node.right, name)
      return this.scopes.set(name, rightValue, left)
    }
    if (left.type === "MemberExpression") {
      const self = this
      // 成员赋值：modifyMember 保证对象/键只解析一次
      return yield* this.modifyMember(left, function* (current) {
        const rightValue = yield* self.evaluateExpression(node.right)
        if (operator === "=") return { write: true, next: rightValue, result: rightValue }
        const next = yield* self.applyOperator(binary, current, rightValue, node)
        return { write: true, next, result: next }
      })
    }
    throw typeError("Assignment target must be an Identifier or MemberExpression.", left)
  }

  // 收尾"右侧是生成器求值"的普通赋值
  private *assignAfter(left: Identifier, right: Eval<Value>): Eval<Value> {
    return this.scopes.set(left.name, yield* right, left)
  }

  // 收尾"右侧或当前值是对象"的复合赋值
  private *compoundAfter(node: AssignmentExpression, current: Value, started: Value | Eval<Value>): Eval<Value> {
    const left = node.left as Identifier
    const binary = node.operator.slice(0, -1)
    const right = isEval(started) ? yield* started : started
    const next =
      current instanceof Obj || right instanceof Obj
        ? yield* this.applyOperator(binary, current, right, node)
        : this.applyBinaryOperator(binary, current, right, node)
    return this.scopes.set(left.name, next, left)
  }

  // `++`/`--` on a name whose value is already primitive.
  // 对值已是原始值的变量做 `++`/`--`：转换、写回、按前/后缀返回
  private update(node: UpdateExpression, argument: Identifier, current: Value): Value {
    if (isOpaque(current)) throw invalidData(`'${node.operator}' requires a data value.`, argument)
    const before = coerceToNumber(current)
    const next = node.operator === "++" ? before + 1 : before - 1
    this.scopes.set(argument.name, next, argument)
    return node.prefix ? next : before
  }

  // 逻辑赋值（??= ||= &&=）：按条件决定是否求值右侧并写入
  private *evaluateLogicalAssignment(node: AssignmentExpression, left: Pattern, operator: string): Eval<Value> {
    const shouldAssign = (current: Value): boolean =>
      operator === "??=" ? current === null || current === undefined : operator === "||=" ? !current : Boolean(current)
    if (left.type === "Identifier") {
      const name = left.name
      const current = this.scopes.get(name, left)
      // 条件不满足：不求值右侧，返回原值
      if (!shouldAssign(current)) return current
      const rightValue = yield* this.evaluateNamed(node.right, name)
      return this.scopes.set(name, rightValue, left)
    }
    if (left.type === "MemberExpression") {
      const self = this
      // 成员目标：同样按条件决定是否写入
      return yield* this.modifyMember(left, function* (current) {
        if (!shouldAssign(current)) return { write: false, next: current, result: current }
        const rightValue = yield* self.evaluateExpression(node.right)
        return { write: true, next: rightValue, result: rightValue }
      })
    }
    throw typeError("Assignment target must be an Identifier or MemberExpression.", left)
  }

  // 前后缀自增/自减：对象目标经 ToPrimitive 转换；成员目标经 modifyMember 读改写
  private *evaluateUpdateExpression(node: UpdateExpression): Eval<Value> {
    const operator = node.operator
    const argument = node.argument
    const prefix = node.prefix

    const increment = operator === "++" ? 1 : operator === "--" ? -1 : undefined

    if (increment === undefined) {
      throw typeError(`Unsupported update operator '${operator}'.`, node)
    }

    // CodeMode numeric coercion, not host Number(), so opaque runtime references reject clearly.
    // 用 CodeMode 的数值强转而非宿主 Number()，让不透明的运行时引用清晰报错
    const operand = (current: Value): number => {
      if (isOpaque(current)) {
        throw invalidData(`'${operator}' requires a data value.`, argument)
      }
      return coerceToNumber(current)
    }

    if (argument.type === "Identifier") {
      const name = argument.name
      const current = this.scopes.get(name, argument)
      const before = operand(current instanceof Obj ? yield* this.toPrimitive(current, "number", argument) : current)
      const next = before + increment
      this.scopes.set(name, next, argument)
      return prefix ? next : before
    }

    if (argument.type === "MemberExpression") {
      const self = this
      return yield* this.modifyMember(argument, function* (current) {
        const value = operand(yield* self.toPrimitive(current, "number", argument))
        const next = value + increment
        return { write: true, next, result: prefix ? next : value }
      })
    }

    throw typeError("Update target must be an Identifier or MemberExpression.", argument)
  }

  // A module that fails to load rejects the promise, as a failed dynamic import does.
  // 动态 import()：模块加载失败时拒绝 promise，与失败的动态导入一致
  private *evaluateImportExpression(node: ImportExpression): Eval<Value> {
    const specifier = coerceToString(yield* this.evaluateExpression(node.source))
    if (node.options) yield* this.evaluateExpression(node.options)
    const promise = capability(this.ctx, node)
    try {
      promise.resolve(this.ctx.namespace(specifier, node))
    } catch (error) {
      if (!(error instanceof PendingThrow)) throw error
      promise.reject(error)
    }
    return promise.promise
  }

  // EvaluateCall: a member callee supplies its base object as `this`; anything else calls with undefined.
  // 调用表达式：成员被调用者以基础对象作为 `this`；其他情况以 undefined 调用
  private *evaluateCallExpression(node: CallExpression): Eval<Value> {
    const callee = node.callee
    if (callee.type === "Super") throw unsupportedSyntax(callee.type, callee)
    const { callable, thisValue } =
      callee.type === "MemberExpression"
        ? yield* this.readMethod(callee)
        : { callable: yield* this.evaluateExpression(callee), thisValue: undefined }
    if (callable === OptionalShortCircuit) return OptionalShortCircuit
    if ((callable === null || callable === undefined) && node.optional) return OptionalShortCircuit

    const args = yield* this.evaluateCallArguments(node.arguments)
    const result = this.dispatch(callable, thisValue, args, node, callee)
    return isEval(result) ? yield* result : result instanceof Call ? ((yield result) as Value) : result
  }

  // 读取一个将被调用的方法：返回可调用值与接收者（this）
  private *readMethod(node: MemberExpression): Eval<{ callable: Value; thisValue: Value }> {
    const reference = yield* this.getMemberReference(node)
    if (reference === OptionalShortCircuit) return { callable: OptionalShortCircuit, thisValue: undefined }
    if (reference instanceof ToolReference) return { callable: reference, thisValue: undefined }
    if ("value" in reference) return { callable: reference.value, thisValue: undefined }
    return { callable: this.readReference(reference, node), thisValue: reference.receiver }
  }

  *call(callable: Value, thisValue: Value, args: Array<Value>, node?: AstNode, callee?: Expression): Eval<Value> {
    const result = this.dispatch(callable, thisValue, args, node, callee)
    return isEval(result) ? yield* result : result instanceof Call ? ((yield result) as Value) : result
  }

  // The single dispatch for every invocation: call expressions and callbacks share it. A program function is a `Call`
  // for the caller to yield; a built-in that returns a value needs no generator.
  // 所有调用的唯一分派点：调用表达式与回调共用。程序函数返回 `Call` 供调用方 yield；
  // 直接返回值的内建函数无需生成器
  private dispatch(
    callable: Value,
    thisValue: Value,
    args: Array<Value>,
    node?: AstNode,
    callee?: Expression,
  ): Value | Eval<Value> | Call {
    if (callable instanceof Fn) return this.invokeFunction(callable, thisValue, args, node)
    if (callable instanceof Native) {
      // A loop made only of built-in calls has no program call or loop back-edge to count, so count the call.
      // 纯内建调用组成的循环没有程序调用或循环回边可计数，所以把调用本身计入
      if (this.ctx.runner.tick()) return afterSlice(() => this.native(() => callable.call(thisValue, args, node), node))
      return this.native(() => callable.call(thisValue, args, node), node)
    }
    if (callable instanceof ToolReference) {
      if (callable.path.length === 0) {
        throw typeError("The tools root is not callable.", callee ?? node)
      }
      // 工具引用：发起跨边界的工具调用 promise
      return this.createToolCallPromise(callable.path, args, node)
    }
    throw typeError(`${calleeDescription(callee) ?? "The called value"} is not a function.`, callee ?? node)
  }

  // Built-ins throw without a location, synchronously or inside their work; the call site supplies it.
  // 内建函数抛错不带位置（同步或在其工作内部），调用点在这里补充位置信息
  private native(body: () => NativeResult, node?: AstNode): Value | Eval<Value> {
    let result: NativeResult
    try {
      // 同步执行内建函数体
      result = body()
    } catch (error) {
      throw locate(error, node)
    }
    return isEval(result) ? located(result, node) : result
  }

  // 求值调用实参：展开元素经同步迭代逐个收集
  private *evaluateCallArguments(argNodes: ReadonlyArray<Expression | SpreadElement>): Eval<Array<Value>> {
    const args: Array<Value> = []
    for (const argNode of argNodes) {
      if (argNode.type === "SpreadElement") {
        const spread = yield* this.evaluateExpression(argNode.argument)
        const cursor = yield* this.iterate(spread, argNode)
        if (cursor === undefined) throw typeError("Spread arguments require a synchronous iterable.", argNode)
        while (true) {
          // 逐个展开元素
          const step = yield* cursor.next()
          if (step.done) break
          args.push(step.value)
        }
      } else {
        const value = this.evaluate(argNode)
        args.push(isEval(value) ? yield* value : value)
      }
    }
    return args
  }

  // A program call runs as its own activation on the explicit stack, so it is a `Call` for the caller to yield. An
  // async call returns its promise when the body first suspends or ends; a generator call binds its parameters and
  // returns the generator without running the body.
  // 调用程序函数：它在显式栈上作为独立激活运行，因此以 `Call` 返回给调用方 yield。
  // async 调用在体首次挂起或结束时返回 promise；生成器调用只绑定参数并返回生成器对象，不运行体
  invokeFunction(fn: Fn, thisValue: Value, args: Array<Value>, node?: AstNode): Call | Value | Eval<Value> {
    const runner = this.ctx.runner
    // The program's own activation is at the bottom of the stack.
    // 程序自身的激活位于栈底；超出深度限制即栈溢出
    if (runner.depth > MAX_CALL_DEPTH) throw rangeError("Maximum call stack size exceeded", node)
    const invocation = new Frame(this.ctx, new ScopeStack([...fn.capturedScopes, new Map()]))
    const paramScope = invocation.scopes.current()
    // `this` and `arguments` are scope bindings so arrows resolve them lexically; a parameter named
    // `arguments` shadows the object, as in JS.
    // `this` 与 `arguments` 作为作用域绑定存在，箭头函数才能按词法解析它们；
    // 名为 `arguments` 的参数会遮蔽该对象，与 JS 一致
    if (!fn.arrow) paramScope.set("this", { mutable: false, value: thisValue, initialized: true })
    if (!fn.arrow && usesArguments(fn)) {
      paramScope.set("arguments", {
        mutable: true,
        value: new Arguments(this.ctx.builtins.Object, args),
        initialized: true,
      })
    }
    const simple = isSimple(fn.parameters)
    if (simple) {
      // A repeated name takes the last argument for it, as in JS.
      // 重复的参数名取最后一个实参，与 JS 一致
      for (const [index, parameter] of fn.parameters.entries()) {
        paramScope.set((parameter as Identifier).name, { mutable: true, value: args[index], initialized: true })
      }
    } else {
      // Seed all parameters first so defaults cannot fall through to same-named outer bindings.
      // 先播种全部参数名（未初始化），默认值就不会漏到外层同名绑定
      for (const parameter of fn.parameters) {
        for (const name of collectPatternNames(parameter)) {
          paramScope.set(name, { mutable: true, value: undefined, initialized: false })
        }
      }
    }
    if (fn.generator) {
      invocation.generator = true
      invocation.generatorAsync = fn.async
      // The prototype is read after the parameters bind, since a default may replace it.
      // prototype 在参数绑定之后读取，因为默认值可能替换它
      const create = () => {
        const proto = get(fn, "prototype")
        return new GeneratorObj(
          proto instanceof Obj ? proto : fn.async ? this.ctx.builtins.AsyncGenerator : this.ctx.builtins.Generator,
          fn.async,
          generatorBody(invocation.functionBody(fn, paramScope)),
        )
      }
      if (simple) return create()
      return (function* () {
        yield* invocation.bindParameters(fn, args)
        return create()
      })()
    }
    // 同步函数：体作为 Call 返回给调用方 yield
    const body = simple ? invocation.functionBody(fn, paramScope) : invocation.enter(fn, args, paramScope)
    if (!fn.async) return new Call(body)
    // 异步函数：建立返回 promise，体首次挂起/结束时结算
    const promise = runner.newPromise()
    const resolving = runner.resolving(promise)
    return new Call(
      body,
      // 异步边界：体结束/挂起时以完成值结算该调用返回的 promise
      new AsyncBoundary(
        (completion) =>
          completion.ok ? resolving.resolve(completion.value as Value) : resolving.reject(completion.error),
        promise,
      ),
    )
  }

  // 非简单参数的函数体入口：先绑定参数再运行体
  private *enter(fn: Fn, args: Array<Value>, paramScope: Map<string, Binding>): Eval<Value> {
    yield* this.bindParameters(fn, args)
    return yield* this.functionBody(fn, paramScope)
  }

  // 绑定实参到形参：rest 收尾、重复标识符取最后、解构模式逐个声明
  private *bindParameters(fn: Fn, args: Array<Value>): Eval<void> {
    const parameters = fn.parameters
    for (const [index, parameter] of parameters.entries()) {
      if (parameter.type === "RestElement") {
        // rest 参数：收下剩余全部实参
        yield* this.declarePattern(
          parameter.argument,
          new Arr(this.ctx.builtins.Array, args.slice(index)),
          true,
          parameter,
          true,
        )
        break
      }
      if (parameter.type === "Identifier") {
        // A sloppy simple parameter list may repeat a name; the last occurrence wins, as in JS.
        // 宽松模式下的简单参数列表可以重名；最后一次出现胜出，与 JS 一致
        if (parameters.findLastIndex((other) => other.type === "Identifier" && other.name === parameter.name) !== index)
          continue
        this.scopes.initialize(parameter.name, args[index], parameter)
        continue
      }
      yield* this.declarePattern(parameter, args[index], true, parameter, true)
    }
  }

  // 运行函数体：块体先提升 var（复制同名参数）；箭头/表达式体直接求值
  private *functionBody(fn: Fn, paramScope: Map<string, Binding>): Eval<Value> {
    if (fn.body.type === "BlockStatement") {
      this.scopes.push()
      this.hoistVars(fn.body.body, paramScope)
      const result = yield* this.evaluateBlock(fn.body)
      return result.kind === "return" ? result.value : undefined
    }
    const result = this.evaluate(fn.body)
    return isEval(result) ? yield* result : result
  }

  // yield 表达式：只能在生成器内；委托 yield* 走 delegateYield；否则挂起
  private *evaluateYieldExpression(node: YieldExpression): Eval<Value> {
    const argument = node.argument
    if (!this.generator) throw typeError("yield is only valid inside a generator.", node)
    const value = argument ? yield* this.evaluateExpression(argument) : undefined
    if (node.delegate) return yield* this.delegateYield(value, node)
    return yield* this.suspendGenerator(this.generatorAsync ? yield* this.awaitValue(value, node) : value)
  }

  // Yield `value` and continue with the request that resumes the body: `next` supplies the value of the `yield`,
  // `throw` throws there, and `return` unwinds through `finally` blocks (an async generator awaits the value first).
  // 挂起生成器：yield `value` 并以恢复体的请求继续——`next` 提供该 yield 的值，
  // `throw` 在此抛出，`return` 穿过 finally 块展开（异步生成器先 await 该值）
  private *suspendGenerator(value: Value): Eval<Value> {
    const request = (yield new Yield(value)) as GeneratorRequest
    if (request.kind === "next") return request.value
    if (request.kind === "throw") throw new Throw(request.value)
    throw new GeneratorReturn(this.generatorAsync ? yield* this.awaitValue(request.value) : request.value)
  }

  // yield* 委托：把产出转发给内部迭代器，同时转发 next/throw/return 请求
  private *delegateYield(value: Value, node: AstNode): Eval<Value> {
    const builtin = this.builtinCursor(value)
    // 同步生成器委托内建游标的快路径
    if (builtin !== undefined && !this.generatorAsync) {
      // 同步生成器委托内建游标的快路径
      while (true) {
        const step = yield* builtin.next()
        if (step.done) return undefined
        try {
          yield* this.suspendGenerator(step.value)
        } catch (error) {
          if (error instanceof GeneratorReturn) {
            // 外层 return()：先关闭内层迭代器
            yield* builtin.close()
            throw error
          }
          if (error instanceof Throw) {
            yield* builtin.close()
            throw typeError("The delegated iterator does not provide a throw() method.", node)
          }
          throw error
        }
      }
    }

    const custom = builtin === undefined ? yield* this.customIterator(value, node, this.generatorAsync) : undefined
    if (builtin === undefined && !custom) throw typeError("yield* requires a compatible iterable value.", node)
    // An async generator delegates to a synchronous iterator through CreateAsyncFromSyncIterator, as JS does.
    // 异步生成器委托同步迭代器：经 CreateAsyncFromSyncIterator，与 JS 一致
    const iterator = this.generatorAsync && !custom?.asynchronous ? this.asyncFromSync(builtin, custom, node) : custom!
    let kind: GeneratorRequest["kind"] = "next"
    let input: Value = undefined
    while (true) {
      // next 用适配器自带的 next；throw/return 按需从迭代器对象取
      const method = kind === "next" ? iterator.next : get(iterator.iterator, kind)
      if (method === undefined || method === null) {
        if (kind === "return")
          throw new GeneratorReturn(this.generatorAsync ? yield* this.awaitValue(input, node) : input)
        yield* this.closeIterator(iterator, node)
        throw typeError("The delegated iterator does not provide a throw() method.", node)
      }
      // 把请求（next 值 / throw 原因 / return 值）转发给内层迭代器
      const called = yield* this.call(
        this.requireIteratorMethod(method, `Iterator ${kind}`, node),
        iterator.iterator,
        [input],
        node,
      )
      const result = this.requireIteratorObject(
        iterator.asynchronous ? yield* this.awaitValue(called, node) : called,
        `Iterator ${kind}() result`,
        node,
      )
      const done = Boolean(get(result, "done"))
      const resultValue = get(result, "value")
      if (done) {
        // 内层迭代器完成：return 请求以 GeneratorReturn 展开；next 请求返回其值
        if (kind === "return") throw new GeneratorReturn(resultValue)
        return resultValue
      }

      try {
        // Delegated values are yielded as they are; an async generator's inner promise already settled them.
        // 委托的值按原样 yield；异步生成器的内部 promise 已在此前落定
        input = yield* this.suspendGenerator(resultValue)
        kind = "next"
      } catch (error) {
        if (!(error instanceof GeneratorReturn) && !(error instanceof Throw)) throw error
        kind = error instanceof GeneratorReturn ? "return" : "throw"
        input = error.value
      }
    }
  }

  // 对象字面量：展开赋值 + init 属性（计算键/标识符/字面量键）；迭代器符号的显示名特殊处理
  private *evaluateObjectExpression(node: ObjectExpression): Eval<Obj> {
    const objectValue = new Obj(this.ctx.builtins.Object)
    for (const property of node.properties) {
      if (property.type === "SpreadElement") {
        const spread = yield* this.evaluateExpression(property.argument)
        if (spread === null || spread === undefined) continue
        assign(objectValue, enumerableSource(this.ctx, "Object spread", spread, property))
        continue
      }

      if (property.kind !== "init") {
        throw typeError("Only init object properties are supported.", property)
      }

      const keyNode = property.key

      let key: PropertyKey

      if (property.computed) {
        key = yield* this.toPropertyKey(yield* this.evaluateExpression(keyNode), keyNode)
      } else if (keyNode.type === "Identifier") {
        key = keyNode.name
      } else if (keyNode.type === "Literal") {
        key = propertyKey(literal(keyNode))
      } else {
        throw typeError("Unsupported object property key shape.", keyNode)
      }

      const name =
        key === IteratorSymbol
          ? "[Symbol.iterator]"
          : key === AsyncIteratorSymbol
            ? "[Symbol.asyncIterator]"
            : String(key)
      define(objectValue, key, yield* this.evaluateNamed(property.value, name))
    }

    return objectValue
  }

  // 数组字面量：跳洞是真实的空洞（只扩 length）；展开经同步迭代收集
  private *evaluateArrayExpression(node: ArrayExpression): Eval<Arr> {
    const values: Array<Value> = []

    for (const element of node.elements) {
      if (element === null) {
        // A literal elision is a real hole, like JS: extend length without an own index.
        // 字面量省略是真实的空洞，与 JS 一致：扩展 length 但不建立自有索引
        values.length += 1
        continue
      }
      if (element.type === "SpreadElement") {
        // 展开元素：经同步迭代逐个收集
        const spread = yield* this.evaluateExpression(element.argument)
        const cursor = yield* this.iterate(spread, element)
        if (cursor === undefined) throw typeError("Array spread requires a synchronous iterable.", element)
        while (true) {
          const step = yield* cursor.next()
          if (step.done) break
          values.push(step.value)
        }
      } else {
        values.push(yield* this.evaluateExpression(element))
      }
    }
    return new Arr(this.ctx.builtins.Array, values)
  }

  // 模板字面量：拼接 cooked 片段与插值（转字符串），全程检查长度上限
  private *evaluateTemplateLiteral(node: TemplateLiteral): Eval<string> {
    const quasis = node.quasis
    const expressions = node.expressions

    let output = ""

    for (let index = 0; index < quasis.length; index += 1) {
      const quasi = quasis[index]!
      // acorn only omits `cooked` for invalid escapes, which are a parse error outside a tagged template.
      // acorn 只在转义无效时省略 `cooked`——在标签模板之外这是解析错误
      if (typeof quasi.value.cooked !== "string") {
        throw typeError("Invalid template literal quasi.", quasi)
      }
      output += quasi.value.cooked
      checkStringLength(output.length)

      if (index < expressions.length) {
        const raw = yield* this.evaluateExpression(expressions[index])
        output += coerceToString(yield* this.toPrimitive(raw, "string", expressions[index]))
        checkStringLength(output.length)
      }
    }

    return output
  }

  // `tag\`a${x}b\`` is `tag(strings, x)`: the tag is read like a callee (a member keeps its receiver), the
  // substitutions are evaluated in order, and `strings` carries the escaped source as `strings.raw`.
  // 标签模板：`tag\`a${x}b\`` 等价于 `tag(strings, x)`——标签按被调用者读取（成员调用保留接收者），
  // 插值按顺序求值，`strings` 以 `strings.raw` 携带转义前的源文本
  private *evaluateTaggedTemplate(node: TaggedTemplateExpression): Eval<Value> {
    const { callable, thisValue } =
      node.tag.type === "MemberExpression"
        ? yield* this.readMethod(node.tag)
        : { callable: yield* this.evaluateExpression(node.tag), thisValue: undefined }
    const strings = this.ctx.templates.get(node) ?? this.createTemplateObject(node)
    const values: Array<Value> = []
    // 插值按出现顺序求值
    for (const expression of node.quasi.expressions) values.push(yield* this.evaluateExpression(expression))
    return yield* this.call(callable, thisValue, [strings, ...values], node, node.tag)
  }

  // 构建标签模板的 strings 数组（按节点缓存，保证同址恒等）
  private createTemplateObject(node: TaggedTemplateExpression): Arr {
    const array = this.ctx.builtins.Array
    // An invalid escape such as `\unicode` cooks to `undefined` and survives only in `raw`.
    // 无效转义（如 `\unicode`）cooked 为 undefined，只保存在 raw 里
    const strings = new Arr(
      array,
      node.quasi.quasis.map((quasi) => quasi.value.cooked ?? undefined),
    )
    define(
      strings,
      "raw",
      new Arr(
        array,
        node.quasi.quasis.map((quasi) => quasi.value.raw),
      ),
      frozen,
    )
    this.ctx.templates.set(node, strings)
    return strings
  }

  // 解析成员引用：对象与键都求值后得到 Reference（可选链短路/工具引用/成员/已解析值）
  private *getMemberReference(
    node: MemberExpression,
    object: Value | Eval<Value> | typeof unevaluated = unevaluated,
    key: Value | Eval<Value> | typeof unevaluated = unevaluated,
  ): Eval<Reference> {
    const objectNode = node.object
    const propertyNode = node.property
    if (objectNode.type === "Super") throw unsupportedSyntax(objectNode.type, objectNode)
    if (propertyNode.type === "PrivateIdentifier") throw unsupportedSyntax(propertyNode.type, propertyNode)
    const evaluated = object === unevaluated ? this.evaluate(objectNode) : object
    const objectValue = isEval(evaluated) ? yield* evaluated : evaluated
    if (objectValue === OptionalShortCircuit) return OptionalShortCircuit
    if ((objectValue === null || objectValue === undefined) && node.optional) return OptionalShortCircuit

    const computed =
      key !== unevaluated
        ? key
        : !node.computed && propertyNode.type === "Identifier"
          ? propertyNode.name
          : this.evaluate(propertyNode)
    const keyValue = isEval(computed) ? yield* computed : computed
    const reference = this.memberReference(node, objectValue, keyValue)
    return isEval(reference) ? yield* reference : reference
  }

  // The reference once the object and key are evaluated: ToPropertyKey on an object key may run program code.
  // GetValue applies ToObject to the base before ToPropertyKey, so a nullish base throws before the key's own
  // toString runs.
  // 对象与键求值后的引用解析：对象键的 ToPropertyKey 可能运行程序代码。
  // GetValue 先对基值做 ToObject 再做键的 ToPropertyKey——空基值先于键的 toString 抛错
  private memberReference(node: MemberExpression, objectValue: Value, keyValue: Value): Reference | Eval<Reference> {
    if (objectValue === null || objectValue === undefined) {
      throw typeError(`Cannot read properties of ${objectValue} (reading '${coerceToString(keyValue)}').`, node.object)
    }
    if (keyValue instanceof Obj) return this.resolveAfterKey(node, objectValue, keyValue)
    return this.resolveProperty(objectValue, propertyKey(keyValue), node.object, node.property)
  }

  // 键本身是对象：先经其 toString 转换再解析属性
  private *resolveAfterKey(node: MemberExpression, objectValue: Value, keyValue: Obj): Eval<Reference> {
    const key = yield* this.toPropertyKey(keyValue, node.property)
    return this.resolveProperty(objectValue, key, node.object, node.property)
  }

  // 从引用读出值（各形态分派）
  private readResolved(node: MemberExpression, reference: Reference): Value {
    if (reference === OptionalShortCircuit) return OptionalShortCircuit
    if (reference instanceof ToolReference) return reference
    if ("value" in reference) return reference.value
    return this.readReference(reference, node)
  }

  // 解析属性归属：工具引用拼接路径；数据对象返回成员引用；
  // 字符串特判 length 与索引；其余原始值经包装原型读取
  private resolveProperty(
    objectValue: Value,
    key: PropertyKey,
    objectNode: AstNode,
    propertyNode: AstNode,
  ): MemberReference | ToolReference | { value: Value } {
    if (objectValue instanceof ToolReference) {
      if (typeof key !== "string") {
        throw typeError("Tool paths must use string property names.", propertyNode)
      }
      return new ToolReference([...objectValue.path, key])
    }

    if (objectValue instanceof Obj) return { target: objectValue, key, receiver: objectValue }

    // Strings own length and indexes; every other primitive property reads through the wrapper prototype.
    // 字符串自有 length 与索引；其余属性经包装原型读取
    if (typeof objectValue === "string") {
      if (key === "length") return { value: objectValue.length }
      const index = typeof key === "symbol" ? undefined : parseArrayIndex(key)
      if (index !== undefined) return { value: objectValue[index] }
    }
    const proto = primitivePrototype(this.ctx.builtins, objectValue)
    if (proto !== undefined) return { target: proto, key, receiver: objectValue }

    if (objectValue === null || objectValue === undefined) {
      throw typeError(`Cannot read properties of ${objectValue} (reading '${String(key)}').`, objectNode)
    }
    throw typeError("Cannot access a property on a non-object value.", objectNode)
  }

  // One destructured property, read the way a member expression would read it (primitives use their prototype).
  // 读取解构的一个属性，读取方式与成员表达式一致（原始值走其原型）
  private destructuredProperty(source: Value, key: PropertyKey, node: AstNode): Value {
    const reference = this.resolveProperty(source, key, node, node)
    if (reference instanceof ToolReference) return reference
    if ("value" in reference) return reference.value
    return this.readProperty(reference.target, reference.key, node, reference.receiver)
  }

  private readReference(reference: MemberReference, node: MemberExpression): Value {
    // Reject unknown promise properties so a missing await cannot hide.
    // 拒绝未 await 的 Promise 上的未知属性，让漏写的 await 无法被悄悄吞掉
    if (reference.target instanceof PromiseObj && !has(reference.target, reference.key)) {
      throw invalidData(
        "This value is an un-awaited Promise; await it first - e.g. `const result = await tools.ns.tool(...)`.",
        node.object,
      )
    }
    return this.readProperty(reference.target, reference.key, node, reference.receiver)
  }

  // Accessors throw without a location; the member or pattern that read them supplies it.
  // 访问器抛错不带位置；读取它的成员表达式或模式在此补充
  private readProperty(target: Obj, key: PropertyKey, node: AstNode, receiver: Value = target): Value {
    try {
      return get(target, key, receiver)
    } catch (error) {
      throw locate(error, node)
    }
  }

  private *readMember(
    node: MemberExpression,
    object: Value | Eval<Value> | typeof unevaluated = unevaluated,
    key: Value | Eval<Value> | typeof unevaluated = unevaluated,
  ): Eval<Value> {
    return this.readResolved(node, yield* this.getMemberReference(node, object, key))
  }

  private writeMember(node: MemberExpression, value: Value): Eval<Value> {
    return this.modifyMember(node, function* () {
      return { write: true, next: value, result: value }
    })
  }

  // delete 表达式：仅允许删除数据对象的自有字段；非引用操作数求值后返回 true
  private *evaluateDeleteExpression(argument: Expression): Eval<boolean> {
    const target = argument.type === "ChainExpression" ? argument.expression : argument
    if (target.type === "Identifier") throw typeError("Only data fields may be deleted.", argument)
    // `delete <non-reference>` evaluates the operand and is true, as in JS.
    // `delete <非引用>`：求值操作数并返回 true，与 JS 一致
    if (target.type !== "MemberExpression") {
      yield* this.evaluateExpression(target)
      return true
    }
    const reference = yield* this.getMemberReference(target)
    if (reference === OptionalShortCircuit) return true
    if (reference instanceof ToolReference || "value" in reference || reference.receiver !== reference.target) {
      throw invalidData("Only data fields may be deleted.", target)
    }
    // 删除自有字段；失败（不可配置）报 TypeError
    if (remove(reference.target, reference.key)) return true
    throw typeError(`Cannot delete property '${String(reference.key)}'.`, target)
  }

  // Resolve side-effecting object and key expressions exactly once.
  // 成员的读改写统一入口：对象与键表达式只求值一次，再由 compute 决定写入与结果
  private *modifyMember(
    node: MemberExpression,
    compute: (current: Value) => Eval<{ write: boolean; next: Value; result: Value }>,
  ): Eval<Value> {
    const reference = yield* this.getMemberReference(node)
    if (reference === OptionalShortCircuit || reference instanceof ToolReference || "value" in reference) {
      throw typeError("Only data fields may be assigned.", node)
    }
    if (reference.receiver !== reference.target) {
      throw typeError(
        `Cannot create property '${String(reference.key)}' on ${typeof reference.receiver} '${String(reference.receiver)}'.`,
        node,
      )
    }
    const key = reference.key
    // 先读当前值再计算；compute 决定是否写回
    const { write, next, result } = yield* compute(this.readReference(reference, node))
    if (write) this.assignToReference(reference.target, key, next, node)
    return result
  }

  // 向数据对象写入字段：先拒绝循环插入；写入失败（只读）报 TypeError
  private assignToReference(target: Obj, key: PropertyKey, next: Value, node: AstNode): void {
    const written = (() => {
      try {
        rejectCircularInsertion(
          target,
          next,
          target instanceof Arr ? "Array assignment result" : "Object assignment result",
        )
        return set(target, key, next)
      } catch (error) {
        throw locate(error, node)
      }
    })()
    if (written) return
    throw typeError(`Cannot assign to read only property '${String(key)}'.`, node)
  }

  // ToPropertyKey: a data object converts through its own `toString`/`valueOf` first; anything else becomes its
  // string form synchronously, so `counts[row.category]` works when the field is null.
  // ToPropertyKey：数据对象先经自己的 toString/valueOf 转换；其余同步取得字符串形式——
  // 字段为 null 时 `counts[row.category]` 也能正常工作
  private *toPropertyKey(value: Value, node: AstNode): Eval<PropertyKey> {
    if (!(value instanceof Obj)) return propertyKey(value)
    return propertyKey(yield* this.toPrimitive(value, "string", node))
  }
}

// The body a generator object resumes: a `return()` request ends it with the returned value.
// 生成器对象恢复运行的包装体：return() 请求使生成器以返回值结束
function* generatorBody(body: Eval<Value>): Eval<Value> {
  try {
    return yield* body
  } catch (error) {
    if (error instanceof GeneratorReturn) return error.value
    throw error
  }
}

// Rethrows inside interpreter work, so a failure already caught can pass through `preserveConsumerError`.
// 在解释器工作内部重新抛出错误，让已被捕获的失败能穿过 `preserveConsumerError` 传递
function* thrower(error: unknown): Eval<never> {
  throw error
}

// Finishes a built-in's work, locating a failure at the call that started it.
// 收尾内建函数的生成器工作：失败定位到发起调用的位置
function* located(work: Eval<Value>, node: AstNode | undefined): Eval<Value> {
  try {
    return yield* work
  } catch (error) {
    throw locate(error, node)
  }
}

// Lets the host run first, then starts the work.
// 先让宿主跑一步（让出切片），再启动工作
function* afterSlice(start: () => Value | Eval<Value>): Eval<Value> {
  yield Slice
  const result = start()
  return isEval(result) ? yield* result : result
}
