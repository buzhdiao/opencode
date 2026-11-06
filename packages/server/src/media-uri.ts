// 引入 HTTP 请求类型（仅类型）
import type { HttpServerRequest } from "effect/http"

// 客户端能力声明头：以逗号分隔的能力令牌列表
const CAPABILITIES_HEADER = "x-opencode-capabilities"
// 媒体 URI 能力名：客户端声明接受 `media:` 引用形式
const MEDIA_URI_CAPABILITY = "experimental-media-uri"

/**
 * Whether the client opted into `media:` refs. The session's own location decides whether its stored media is
 * actually left as refs (`experimental.media_blob`), so this only picks which read to call.
 */
// 判断客户端是否声明接受 `media:` 引用。会话自身所在位置决定其媒体是否真的以引用存储（experimental.media_blob），
// 此处仅用于选择调用哪种读取方式。
export const wantsMediaRefs = (request: HttpServerRequest.HttpServerRequest) =>
  // 解析能力头并逐个比对令牌（忽略大小写与空白）；头缺失时返回 false
  request.headers[CAPABILITIES_HEADER]?.split(",").some(
    (token) => token.trim().toLowerCase() === MEDIA_URI_CAPABILITY,
  ) ?? false
