// effect 库：Context 引用（依赖注入的可变引用）
import { Context } from "effect"

// 官方 opencode.ai 站点（含子域）的正则
const opencodeOrigin = /^https:\/\/([a-z0-9-]+\.)*opencode\.ai$/

// CORS 配置选项：额外允许的来源列表
export type CorsOptions = { readonly cors?: ReadonlyArray<string> }

// CORS 配置的 Context 引用（默认未配置）
export const CorsConfig = Context.Reference<CorsOptions | undefined>("@opencode/ServerCorsConfig", {
  // 默认值：undefined（无额外来源）
  defaultValue: () => undefined,
})

// 判断 CORS 来源是否被允许（不校验同主机场景）
export function isAllowedCorsOrigin(input: string | undefined, opts?: CorsOptions) {
  // 无 Origin 头（非浏览器请求）放行
  if (!input) return true
  // 本地开发端口放行
  if (input.startsWith("http://localhost:")) return true
  // 回环地址端口放行
  if (input.startsWith("http://127.0.0.1:")) return true
  // 桌面端渲染进程的自定义协议放行
  if (input.startsWith("oc://renderer")) return true
  // Tauri 桌面壳的三种来源放行
  if (input === "tauri://localhost" || input === "http://tauri.localhost" || input === "https://tauri.localhost")
    return true
  // 官方站点（含子域）放行
  if (opencodeOrigin.test(input)) return true
  // 其余来源：仅当出现在配置的 cors 列表中才放行
  return opts?.cors?.includes(input) ?? false
}

// 判断请求来源是否允许：同主机直接放行，否则走通用 CORS 判断
export function isAllowedRequestOrigin(input: string | undefined, host: string | undefined, opts?: CorsOptions) {
  // 无 Origin 放行
  if (!input) return true
  // 与请求目标同主机时放行
  if (host && sameHost(input, host)) return true
  // 其余按通用 CORS 规则
  return isAllowedCorsOrigin(input, opts)
}

// 比较来源的 host 与请求目标 host 是否一致
function sameHost(origin: string, host: string) {
  try {
    // 解析 Origin 并比较 host（含端口）
    return new URL(origin).host === host
  } catch {
    // 解析失败视为不同主机
    return false
  }
}
