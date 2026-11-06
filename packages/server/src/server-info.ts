// 引入 Effect 的上下文与 Layer（依赖注入层）
import { Context, Layer } from "effect"
// 引入 Node 的网卡信息接口
import { networkInterfaces } from "node:os"
// 引入服务器选项类型（仅类型导入）
import type { ServerOptions } from "./options"

// ServerInfo 服务：对外暴露连接 URL 列表、应用信息与路径
export class Service extends Context.Service<
  Service,
  {
    // 获取所有可用于连接的 URL
    readonly urls: () => ReadonlyArray<string>
    // 应用信息块（名称/版本/渠道）
    readonly app: NonNullable<ServerOptions["app"]>
    // 路径信息（目前仅临时目录 tmp）
    readonly paths: { readonly tmp: string }
  }
>()("@opencode/server/ServerInfo") {}

// 构建 ServerInfo 服务层：直接以给定值装配实现
export function layer(urls: () => ReadonlyArray<string>, tmp: string, app: ServerOptions["app"] = {}) {
  // Layer.succeed 提供不依赖环境的常量实现
  return Layer.succeed(Service, Service.of({ urls, app, paths: { tmp } }))
}

// 由一个基础 URL 派生所有可用于连接的 URL（回环地址 + 各网卡地址）
export function connectionURLs(value: string, requestedHostname?: string) {
  // 解析基础 URL
  const url = new URL(value)
  // 主机名优先取请求时的 hostname，否则用 URL 自带的
  const hostname = requestedHostname ?? url.hostname
  // 监听通配地址时确定地址族：0.0.0.0 为 IPv4，:: 或 [::] 为 IPv6
  const family = hostname === "0.0.0.0" ? "IPv4" : hostname === "::" || hostname === "[::]" ? "IPv6" : undefined
  // 非通配地址：基础 URL 本身就是唯一可用地址
  if (family === undefined) return [value]

  // 构造回环地址版本的 URL
  const loopback = new URL(value)
  // 按地址族把主机替换为 127.0.0.1 或 [::1]
  loopback.hostname = family === "IPv6" ? "[::1]" : "127.0.0.1"
  // 用 Set 去重后返回全部 URL
  return [
    ...new Set([
      // 回环 URL（去掉末尾斜杠）
      loopback.toString().replace(/\/$/, ""),
      // 遍历所有网卡，为每个同族的非内部地址生成一个 URL
      ...Object.values(networkInterfaces())
        // 过滤掉 undefined 的网卡条目
        .flatMap((entries) => entries ?? [])
        // 只保留非内部（非回环）且地址族匹配的地址
        .filter((entry) => !entry.internal && entry.family === family)
        .map((entry) => {
          // 复制基础 URL
          const result = new URL(value)
          // 把主机替换为该网卡地址（IPv6 需加方括号）
          result.hostname = family === "IPv6" ? `[${entry.address}]` : entry.address
          // 返回去掉末尾斜杠的字符串
          return result.toString().replace(/\/$/, "")
        }),
    ]),
  ]
}

// 以 ServerInfo 命名空间 re-export 本模块
export * as ServerInfo from "./server-info"
