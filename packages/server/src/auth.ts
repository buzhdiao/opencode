// 将本文件的所有导出聚合到命名空间 ServerAuth 下，供统一引入
export * as ServerAuth from "./auth"

// effect 库：Context 依赖注入、Layer 分层、Option 可选值、Redacted 敏感值封装
import { Context, Layer, Option, Redacted } from "effect"
// Node 加密：HMAC 签名与恒定时间比较
import { createHmac, timingSafeEqual } from "node:crypto"

// 解码后的 Basic 认证凭据：用户名 + 受保护的密码
export type DecodedCredentials = {
  // 用户名
  readonly username: string
  // 密码（Redacted：避免日志泄漏）
  readonly password: Redacted.Redacted
}

// 认证配置信息：用户名与可选密码
export type Info = {
  // 可选的服务器密码
  readonly password: Option.Option<string>
  // 认证用户名
  readonly username: string
}

// 会话令牌的有效期（30 天，单位秒）
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60

// 认证配置服务定义（Context.Service）
export class Config extends Context.Service<Config, Info>()("@opencode/ServerAuthConfig") {
  // 由密码构造配置层（用户名固定为 opencode）
  static configLayer(input: Pick<Info, "password">) {
    // 以固定用户名注入配置
    return Layer.succeed(this, this.of({ ...input, username: "opencode" }))
  }

  // 默认层：未设置密码
  static get layer() {
    // 注入无密码的配置
    return this.configLayer({ password: Option.none() })
  }
}

// 判断是否启用了认证（设置了非空密码）
export function required(config: Info) {
  // 密码存在且非空即视为需要认证
  return Option.isSome(config.password) && config.password.value !== ""
}

// Session tokens issued by pairing links are accepted anywhere the password is.
// 认证判断：密码正确或持有有效会话令牌均可通过
export function authorized(credentials: DecodedCredentials, config: Info) {
  // 未设密码或用户名不匹配则拒绝
  if (Option.isNone(config.password) || credentials.username !== config.username) return false
  // 解包受保护的密码值
  const password = Redacted.value(credentials.password)
  // 密码直接匹配，或按会话令牌校验通过
  return password === config.password.value || verifySession(password, config)
}

// Sessions are signed with a key derived from the server password, so rotating the password revokes every session.
// 签发会话令牌："过期时间.签名"；密钥派生自服务器密码，改密即吊销全部会话
export function issueSession(config: Info, now = Date.now()) {
  // 未设密码时不签发
  if (Option.isNone(config.password)) return
  // 计算过期时间戳（秒级字符串）
  const expires = String(Math.floor(now / 1000) + SESSION_TTL_SECONDS)
  // 返回 "过期时间.签名" 格式的令牌
  return `${expires}.${sign(config.password.value, expires)}`
}

// 校验会话令牌：检查格式、有效期与签名（恒定时间比较）
export function verifySession(token: string, config: Info, now = Date.now()) {
  // 未设密码时一律拒绝
  if (Option.isNone(config.password)) return false
  // 按 "." 拆分令牌
  const parts = token.split(".")
  // 必须恰好两段
  if (parts.length !== 2) return false
  // 解析过期时间戳
  const expires = Number(parts[0])
  // 非安全整数或已过期则拒绝
  if (!Number.isSafeInteger(expires) || expires * 1000 <= now) return false
  // 用相同载荷计算期望签名
  const expected = Buffer.from(sign(config.password.value, parts[0]))
  // 实际提供的签名
  const actual = Buffer.from(parts[1])
  // 长度一致且恒定时间比较相等才算有效
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

// Browsers share cookies across ports on the same host, so the name carries the port to keep local servers apart.
// 会话 Cookie 名：同一主机的浏览器会跨端口共享 Cookie，名称带端口以隔离本地服务器
export function sessionCookieName(host: string | undefined) {
  // 从 Host 头解析端口
  const port = URL.parse(`http://${host ?? ""}`)?.port
  // 有端口则带端口命名，否则用默认名
  return port ? `opencode_session_${port}` : "opencode_session"
}

// 用服务器密码派生密钥并对载荷做 HMAC 签名（base64url 输出）
function sign(password: string, payload: string) {
  // 第一层 HMAC：以密码为密钥、域分隔串为载荷，派生签名密钥
  const key = createHmac("sha256", password).update("opencode-session-v1").digest()
  // 第二层 HMAC：以派生密钥对载荷签名
  return createHmac("sha256", key).update(payload).digest("base64url")
}
