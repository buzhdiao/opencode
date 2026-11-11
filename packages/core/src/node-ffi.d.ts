/**
 * 手写的 ambient 模块声明：给 Node 的 FFI 模块 "node:ffi" 提供类型
 * （Node 官方类型库尚未覆盖它，须自行声明才能通过类型检查）。
 * 调用面与 Bun 的 bun:ffi 对齐：dlopen 加载动态库并注册函数签名，getInt32 读指针处的 32 位整数。
 * 随 "node v2 cli support"（a1b274e6f8）引入，供 node 运行时变体做原生调用
 * （当时的用法：src/util/process-lock-ffi.node.ts 借 libc 的 flock 做进程锁）；
 * 该消费代码后来移除，本声明保留，作为 node 条件下原生绑定的类型基础。
 */

// 声明 "node:ffi" 模块：Node 内置的 C FFI 绑定设施
declare module "node:ffi" {
  // 外部函数的签名描述：用字符串命名 C 类型（如 ["int32", "int32"] → "int32"）
  type Signature = {
    // 参数类型名列表，可省略（无参函数）
    readonly arguments?: readonly string[]
    // 返回值类型名（如 "int32"、"pointer"）
    readonly return?: string
  }

  // 已注册外部函数的运行时形状：参数任意，返回 number 或 BigInt（视声明的返回类型而定）
  type ForeignFunction = (...args: ReadonlyArray<unknown>) => number | bigint

  // 打开动态库，按 definitions 注册各导出函数，返回库句柄与函数表
  export function dlopen(
    // 动态库路径（如 /usr/lib/libSystem.B.dylib、kernel32.dll）
    path: string,
    // 函数名 → 签名 的映射表
    definitions: Readonly<Record<string, Signature>>,
  ): {
    // 库句柄：close() 卸载动态库
    readonly lib: { close(): void }
    // 按 definitions 注册的可调用外部函数集合
    readonly functions: Readonly<Record<string, ForeignFunction>>
  }

  // 读取指针指向内存的 32 位整数（典型用途：取 errno），offset 为字节偏移，默认 0
  export function getInt32(pointer: number | bigint, offset?: number): number
}
