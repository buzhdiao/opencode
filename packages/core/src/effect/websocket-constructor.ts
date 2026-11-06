// 原有注释：平台统一入口（barrel）还会引出 Redis 及其可选的原生哈希加载器，而 workerd 运行时无法解析它们——因此需要独立的 WebSocket 构造器模块。
// The platform barrel also exposes Redis and its optional native hash loader, which workerd cannot resolve.
// 导入 Node 运行时的 WebSocket 实现（来自 @effect/platform-node 的 NodeWS 封装）
import { WebSocket as NodeWebSocket } from "@effect/platform-node/NodeWS"
// 导入 HTTP 代理代理器（用于 ws:// 目标走代理）
import { HttpProxyAgent } from "http-proxy-agent"
// 导入 HTTPS 代理代理器（用于 wss:// 目标或 https 代理服务器）
import { HttpsProxyAgent } from "https-proxy-agent"
// 从 effect 库导入 Layer（图层组合）
import { Layer } from "effect"
// 导入 Socket 模块中的 WebSocket 客户端选项与构造器服务标签
import { Socket } from "effect/socket"

// 扩展 Effect 的 WebSocket 客户端选项：额外允许 protocols 字段（子协议列表）
interface WebSocketOptions extends Socket.WebSocketClientOptions {
  // 可选的子协议，可以是单个字符串或字符串数组
  readonly protocols?: string | Array<string>
}

// Bun 风格的 WebSocket 构造器类型：在浏览器构造器基础上扩展握手与代理选项
type BunWebSocketConstructor = new (
  url: string,
  options: WebSocketOptions & { readonly proxy?: string },
) => globalThis.WebSocket

// 环境变量集合类型：键到值的只读映射，值可为 undefined
type Environment = Readonly<Record<string, string | undefined>>

// 从环境变量集合中读取指定名称的值：先按原始大小写查找，再退回全小写查找
const environmentValue = (environment: Environment, name: string) =>
  environment[name] ?? environment[name.toLowerCase()]

// 判断目标 URL 是否命中 NO_PROXY 白名单（即应绕过代理）
const bypassesProxy = (url: URL, value: string | undefined) => {
  // 未配置白名单则不绕过
  if (!value) return false
  // 计算 URL 的端口：显式端口优先；wss 默认 443，其余默认 80
  const port = url.port || (url.protocol === "wss:" ? "443" : "80")
  // 主机名统一转小写便于比较
  const hostname = url.hostname.toLowerCase()
  // 白名单按空白或逗号拆分为多个条目，任一命中即返回 true
  return value.split(/[\s,]+/).some((entry) => {
    // 跳过空条目
    if (!entry) return false
    // "*" 表示绕过所有主机
    if (entry === "*") return true
    // 匹配 "host:port" 形式的条目
    const match = entry.match(/^(.+?):(\d+)$/)
    // 条目带端口但与目标端口不一致，则不命中
    if (match?.[2] && match[2] !== port) return false
    // 取条目中的主机部分（无端口则用整个条目），转小写并去掉前导通配符 "*"
    const host = (match?.[1] ?? entry).toLowerCase().replace(/^\*/, "")
    // 以 "." 开头的条目按后缀匹配（含通配子域语义），否则要求主机名完全相等
    return host.startsWith(".") ? hostname.endsWith(host) : hostname === host
  })
}

// 根据目标 URL 与环境变量选出应使用的代理地址；不适用则返回 undefined
const proxy = (value: string, environment: Environment = process.env) => {
  // 解析目标 URL
  const url = new URL(value)
  // 本机回环地址不走代理
  if (["127.0.0.1", "localhost", "::1"].includes(url.hostname)) return undefined
  // 命中 NO_PROXY 白名单则不走代理
  if (bypassesProxy(url, environmentValue(environment, "NO_PROXY"))) return undefined
  // 优先查专用代理变量：wss 用 WSS_PROXY，ws 用 WS_PROXY
  const protocolProxy = url.protocol === "wss:" ? "WSS_PROXY" : "WS_PROXY"
  // 其次查通用协议变量：wss 用 HTTPS_PROXY，ws 用 HTTP_PROXY
  const standardProxy = url.protocol === "wss:" ? "HTTPS_PROXY" : "HTTP_PROXY"
  // 依次回退：专用变量 -> 通用变量 -> ALL_PROXY
  return (
    environmentValue(environment, protocolProxy) ??
    environmentValue(environment, standardProxy) ??
    environmentValue(environment, "ALL_PROXY")
  )
}

// 把 Effect 的构造器选项归一化成统一的 WebSocketOptions
const constructorOptions = (input: Socket.WebSocketConstructorOptions | undefined): WebSocketOptions =>
  // 若传入的是字符串或数组，视为子协议列表；否则只透传 headers
  typeof input === "string" || Array.isArray(input) ? { protocols: input } : { headers: input?.headers }

// 根据目标协议与选中的代理地址，创建对应的代理 agent（Node 环境用）
const proxyAgent = (url: string, selectedProxy: string | undefined) => {
  // 未选中代理则不需要 agent
  if (!selectedProxy) return undefined
  // wss 目标或 https 代理服务器使用 HttpsProxyAgent（建立 CONNECT 隧道）
  if (url.startsWith("wss:") || selectedProxy.startsWith("https:")) return new HttpsProxyAgent(selectedProxy)
  // 其余情况使用 HttpProxyAgent
  return new HttpProxyAgent(selectedProxy)
}

// 构造最终图层：向 DI 容器注册 Socket.WebSocketConstructor 服务的具体实现
const layer = Layer.succeed(Socket.WebSocketConstructor, (url, input) => {
  // 归一化调用方传入的选项
  const config = constructorOptions(input)
  // 依据目标 URL 与环境变量决定使用的代理地址
  const selectedProxy = proxy(url)
  // 原有注释：信任链仍交给运行时自带的证书库，保证 NODE_EXTRA_CA_CERTS 追加的自定义 CA 继续生效。
  // Keep trust on the runtime store so NODE_EXTRA_CA_CERTS remains additive.
  // Bun 运行时分支：直接使用 Bun 内建的 WebSocket（支持 headers/protocols/proxy 选项）
  if (typeof Bun !== "undefined") {
    // 原有注释（oxlint 豁免）：Bun 在浏览器构造器之上扩展了握手与网络选项，故需要类型断言。
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- Bun extends the browser constructor with handshake and network options.
    const WebSocket = globalThis.WebSocket as unknown as BunWebSocketConstructor
    // 以 Bun 风格选项构造 WebSocket：仅在选中代理时附加 proxy 字段
    return new WebSocket(url, {
      headers: config.headers,
      protocols: config.protocols,
      ...(selectedProxy ? { proxy: selectedProxy } : {}),
    })
  }

  // 非 Bun（Node 等）分支：为 NodeWebSocket 组装原生选项对象
  const native = {
    headers: config.headers,
    agent: proxyAgent(url, selectedProxy),
    // 原有注释：禁止跟随重定向，防止握手头跨域泄露；调用方可安全回退到 HTTP 方案。
    // Reject redirects before headers can cross an origin boundary; the caller safely falls back to HTTP.
    followRedirects: false,
  }
  // 有子协议时按 Node 的三参签名构造；否则使用两参签名
  return config.protocols ? new NodeWebSocket(url, config.protocols, native) : new NodeWebSocket(url, native)
})

// 导出本模块的公共 API：layer（图层）与 proxy（代理解析函数，供复用/测试）
export const WebSocketConstructor = { layer, proxy } as const
