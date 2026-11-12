// 引入数据库（Database）服务：按内容哈希查询媒体 blob
import { Database } from "@opencode/core/database/database"
// 引入会话媒体 blob（SessionBlob）读写工具
import { SessionBlob } from "@opencode/core/session/blob"
// 引入文件未找到错误（FileNotFoundError）
import { FileNotFoundError } from "@opencode/protocol/errors"
// 引入 Effect 运行时
import { Effect } from "effect"
// 引入 HTTP 请求/响应工具
import { type HttpServerRequest, HttpServerResponse } from "effect/http"
import { ContentHeaders } from "../content-headers"

// 允许内联（inline）展示的图片 MIME 类型集合；其余一律按附件下载
const INLINE_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])
// 缓存策略：私有缓存一年且内容不可变（blob 以哈希寻址，内容永不变）
const CACHE_CONTROL = "private, max-age=31536000, immutable"

/** `media.get` in the `server.experimental` group; serves only blobs a message or inbox item still references. */
/** 构造 `server.experimental` 分组的 `media.get` 处理器；仅提供仍被消息或收件项引用的媒体 blob */
export const makeMediaGet = Effect.gen(function* () {
  // 获取数据库连接
  const { db } = yield* Database.Service
  // 返回处理器函数：入参为内容哈希与原始 HTTP 请求
  return (hash: string, request: HttpServerRequest.HttpServerRequest) =>
    Effect.gen(function* () {
      // 构造该媒体的路径（仅用于错误信息）
      const path = `/api/experimental/media/${hash}`
      // 按哈希读取媒体 blob
      const blob = yield* SessionBlob.read(db, hash)
      // 不存在（已无引用或未写入）则返回文件未找到错误
      if (!blob) return yield* new FileNotFoundError({ path, message: `Media blob not found: ${hash}` })
      // ETag 直接使用内容哈希（内容寻址，天然不可变）
      const etag = `"${hash}"`
      // 判断该 MIME 是否允许内联展示
      const inline = INLINE_IMAGE_MIMES.has(blob.mime)
      // 组装响应头：缓存策略、ETag、安全头；非内联图片强制按附件下载
      const headers = {
        "cache-control": CACHE_CONTROL,
        etag,
        "content-disposition": ContentHeaders.disposition(""),
        "content-security-policy": ContentHeaders.CONTENT_SECURITY_POLICY,
        "x-content-type-options": "nosniff",
      }
      // 客户端缓存命中（If-None-Match 匹配）时返回 304 Not Modified
      if (matchesIfNoneMatch(request.headers["if-none-match"], etag))
        return HttpServerResponse.empty({ status: 304, headers })
      // 返回二进制内容；内联图片用其真实 MIME，其余用通用二进制类型
      return HttpServerResponse.uint8Array(blob.data, {
        status: 200,
        contentType: inline ? blob.mime : "application/octet-stream",
        headers,
      })
    })
})

// 辅助函数：判断 If-None-Match 头是否命中当前 ETag
function matchesIfNoneMatch(ifNoneMatch: string | undefined, etag: string) {
  // 没有该头则视为未命中
  if (ifNoneMatch === undefined) return false
  // 逐个比对标签："*" 匹配任意；去掉弱验证器前缀 W/ 后相等也算命中
  return ifNoneMatch.split(",").some((tag) => {
    const trimmed = tag.trim()
    return trimmed === "*" || trimmed.replace(/^w\//i, "") === etag
  })
}
