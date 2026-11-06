// 引入文件系统（FileSystem）核心服务：按位置读写、列举文件
import { FileSystem } from "@opencode/core/filesystem"
// 引入文件监听服务（FileWatch）：订阅文件变更事件
import { FileWatch } from "@opencode/core/filesystem/file-watch"
// 引入位置（Location）服务：当前请求的工作目录上下文
import { Location } from "@opencode/core/location"
// 引入 RelativePath：相对路径的校验构造类型
import { RelativePath } from "@opencode/core/schema"
// 引入协议层错误：文件未找到与服务不可用错误
import { FileNotFoundError, ServiceUnavailableError } from "@opencode/protocol/errors"
// 引入 Effect、Option（可选值）与 Stream（流）
import { Effect, Option, Stream } from "effect"
// 引入 HTTP 服务端请求/响应类型
import { type HttpServerRequest, HttpServerResponse } from "effect/http"
// 引入 HTTP API 构建器
import { HttpApiBuilder } from "effect/http-api"
// 引入 Node 的 path 模块：把相对路径解析为绝对路径
import path from "path"
// 引入本服务 API 定义
import { Api } from "../api"
// 引入 response 辅助：响应中附带 location 信息
import { response } from "../location"

// 导出 FileSystemHandler：注册 "server.fs" 分组处理器
export const FileSystemHandler = HttpApiBuilder.group(Api, "server.fs", (handlers) =>
  Effect.gen(function* () {
    // 获取文件监听服务（watch/unwatch 共用）
    const fileWatch = yield* FileWatch.Service
    return handlers
      // handleRaw 处理 fs.read：按 URL 路径读取文件并流式返回原始内容
      .handleRaw("fs.read", (ctx) =>
        Effect.gen(function* () {
          // 从请求 URL 中解码出相对文件路径
          const path = yield* decodeRequestPath(ctx.request.url)
          // 获取文件系统服务
          const fs = yield* FileSystem.Service
          // 读取文件；读取失败一律映射为“文件未找到”错误
          const file = yield* fs
            .read({ path })
            .pipe(
              Effect.mapError(
                (error) => new FileNotFoundError({ path: error.path, message: `File not found: ${error.path}` }),
              ),
            )
          // 以支持缓存校验与 Range 分段的方式返回文件
          return serveFile(ctx.request, file)
        }),
      )
      // 处理 fs.list：列出目录内容
      .handle("fs.list", (ctx) =>
        response(
          Effect.gen(function* () {
            // 获取文件系统服务
            const fs = yield* FileSystem.Service
            // 列出目录；失败映射为“目录未找到”错误
            return yield* fs
              .list(ctx.query)
              .pipe(
                Effect.mapError(
                  (error) => new FileNotFoundError({ path: error.path, message: `Directory not found: ${error.path}` }),
                ),
              )
          }),
        ),
      )
      // 处理 fs.find：按条件查找文件
      .handle("fs.find", (ctx) =>
        response(
          Effect.gen(function* () {
            // 获取文件系统服务
            const fs = yield* FileSystem.Service
            // 执行查找并把查询参数透传
            return yield* fs.find(ctx.query)
          }),
        ),
      )
      // 处理 fs.write：写入文件内容（请求体即数据）
      .handle("fs.write", (ctx) =>
        response(
          Effect.gen(function* () {
            // 获取文件系统服务
            const fs = yield* FileSystem.Service
            // 按查询参数 path 写入请求体数据
            return yield* fs.write({ path: ctx.query.path, data: ctx.payload })
          }),
        ),
      )
      // 处理 fs.watch：为指定文件注册变更监听（WebSocket 推送由 FileWatch 负责）
      .handle("fs.watch", (ctx) =>
        Effect.gen(function* () {
          // 获取文件系统服务
          const fs = yield* FileSystem.Service
          // 获取当前请求的位置（location）
          const location = yield* Location.Service
          // Same confinement as read: the file must exist inside the location.
          // 与 read 相同的边界约束：被监听的文件必须已存在于该位置内，防止越权监听
          yield* fs
            .read({ path: RelativePath.make(ctx.payload.path) })
            .pipe(
              Effect.mapError(
                (error) => new FileNotFoundError({ path: error.path, message: `File not found: ${error.path}` }),
              ),
            )
          // 注册监听：文件路径以位置目录为基准解析成绝对路径；失败映射为服务不可用错误
          yield* fileWatch
            .watch({
              location: { directory: location.directory, workspaceID: location.workspaceID },
              file: path.resolve(location.directory, ctx.payload.path),
            })
            .pipe(
              Effect.mapError(
                (error) => new ServiceUnavailableError({ message: error.message, service: "filewatcher" }),
              ),
            )
        }),
      )
      // 处理 fs.unwatch：取消对指定文件的监听
      .handle("fs.unwatch", (ctx) =>
        Effect.gen(function* () {
          // 获取当前请求的位置（location）
          const location = yield* Location.Service
          // 注销监听：与 watch 相同的方式解析绝对路径
          yield* fileWatch.unwatch({
            location: { directory: location.directory, workspaceID: location.workspaceID },
            file: path.resolve(location.directory, ctx.payload.path),
          })
        }),
      )
  }),
)

// 辅助函数：从请求 URL 中解码文件路径（跳过 "/api/experimental/fs/" 前缀的 13 个字符）
function decodeRequestPath(url: string) {
  // 构造 URL 对象并截掉固定前缀，得到原始（可能经 URL 编码的）路径
  const raw = new URL(url, "http://localhost").pathname.slice(13)
  // Effect.try：解码成功得到 RelativePath；解码失败（非法编码）返回“文件未找到”错误
  return Effect.try({
    try: () => RelativePath.make(decodeURIComponent(raw)),
    catch: () => new FileNotFoundError({ path: raw, message: `File not found: ${raw}` }),
  })
}

// 辅助函数：把读取到的文件作为 HTTP 响应返回，支持 ETag/Last-Modified 缓存校验与 Range 分段下载
function serveFile(request: HttpServerRequest.HttpServerRequest, file: FileSystem.File) {
  // 构造弱验证器格式的 ETag：由文件大小（16 进制）与修改时间（16 进制）组合
  const etag = `W/"${file.size.toString(16)}-${Option.match(file.mtime, {
    // 没有修改时间时用 "0"
    onNone: () => "0",
    // 有修改时间时用其毫秒时间戳的 16 进制
    onSome: (mtime) => mtime.getTime().toString(16),
  })}"`
  // 提取 Last-Modified（UTC 字符串）；无修改时间则为 undefined
  const lastModified = Option.getOrUndefined(Option.map(file.mtime, (mtime) => mtime.toUTCString()))
  // Clients must revalidate after agent edits; no-transform keeps compression from changing Content-Length.
  // 缓存策略：no-cache 强制客户端在代理编辑后重新验证；no-transform 防止中间层压缩改变 Content-Length
  const validators = {
    "cache-control": "no-cache, no-transform",
    // 实体标签（ETag），用于 If-None-Match 比对
    etag,
    // 仅在存在修改时间时附带 Last-Modified 头
    ...(lastModified === undefined ? {} : { "last-modified": lastModified }),
  }
  // 若客户端缓存仍有效（If-None-Match/If-Modified-Since 命中），返回 304 Not Modified 空响应
  if (isNotModified(request, etag, lastModified)) return HttpServerResponse.empty({ status: 304, headers: validators })

  // 仅对 GET 请求解析 Range 请求头
  const rangeHeader = request.method === "GET" ? request.headers["range"] : undefined
  // 若存在 Range 头且 If-Range 校验通过（资源未变），解析出分段范围
  const range =
    rangeHeader !== undefined && matchesIfRange(request.headers["if-range"], etag, lastModified)
      ? parseRange(rangeHeader, file.size)
      : undefined
  // 范围无法满足（超出文件大小）时返回 416 Range Not Satisfiable
  if (range === "unsatisfiable")
    return HttpServerResponse.empty({
      status: 416,
      headers: { "accept-ranges": "bytes", "content-range": `bytes */${file.size}` },
    })

  // 分段起点：无 Range 则从 0 开始
  const offset = range?.start ?? 0
  // 分段长度：无 Range 时为整个文件，否则按 end-start+1 计算
  const length = range === undefined ? file.size : range.end - range.start + 1
  // 返回文件流；有 Range 时状态码为 206 Partial Content，并附带相应头
  return HttpServerResponse.stream(length === 0 ? Stream.empty : file.stream({ offset, bytesToRead: length }), {
    // 无 Range 为 200，有 Range 为 206
    status: range === undefined ? 200 : 206,
    // 明确的内容长度
    contentLength: length,
    headers: {
      // 展开缓存校验头
      ...validators,
      // 声明支持字节范围请求
      "accept-ranges": "bytes",
      // 使用文件的 MIME 类型
      "content-type": file.mime,
      // 有 Range 时附带 Content-Range 说明返回的字节区间
      ...(range === undefined ? {} : { "content-range": `bytes ${range.start}-${range.end}/${file.size}` }),
    },
  })
}

// 辅助函数：判断客户端缓存是否仍然有效（对应 304 语义）
function isNotModified(request: HttpServerRequest.HttpServerRequest, etag: string, lastModified: string | undefined) {
  // 优先使用 If-None-Match 头（与 ETag 比对）
  const ifNoneMatch = request.headers["if-none-match"]
  // 若存在，逐个比对标签："*" 匹配任意，或弱化比较后相等
  if (ifNoneMatch !== undefined)
    return ifNoneMatch.split(",").some((tag) => tag.trim() === "*" || stripWeak(tag) === stripWeak(etag))
  // 否则退回 If-Modified-Since（与 Last-Modified 比对）
  const ifModifiedSince = request.headers["if-modified-since"]
  return (
    // 需要请求带该头且文件存在修改时间，且文件修改时间不晚于客户端缓存时间
    ifModifiedSince !== undefined &&
    lastModified !== undefined &&
    Date.parse(lastModified) <= Date.parse(ifModifiedSince)
  )
}

// 辅助函数：校验 If-Range 是否与当前资源一致（一致才允许按 Range 返回分段）
function matchesIfRange(ifRange: string | undefined, etag: string, lastModified: string | undefined) {
  // 没有 If-Range 头则默认通过
  if (ifRange === undefined) return true
  // 若值形如引号包裹的 ETag（可带 W/ 前缀），与当前 ETag 弱化比较
  if (/^\s*(w\/)?"/i.test(ifRange)) return stripWeak(ifRange) === stripWeak(etag)
  // 否则按日期比较：与 Last-Modified 完全相等才通过
  return lastModified !== undefined && Date.parse(ifRange) === Date.parse(lastModified)
}

// 辅助函数：去掉 ETag 的弱验证器前缀（W/）与空白，便于比较
function stripWeak(etag: string) {
  // trim 去空白，再移除开头的 W/（大小写不敏感）
  return etag.trim().replace(/^w\//i, "")
}

// 辅助函数：解析 "bytes=start-end" 形式的 Range 头
function parseRange(header: string, size: number) {
  // 用正则捕获起始与结束数字（均可为空）
  const match = /^bytes=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header.trim())
  // 格式不对或两个数字都为空则忽略 Range（按 200 返回整个文件）
  if (match === null || (match[1] === "" && match[2] === "")) return undefined
  // 起始为空表示“后缀范围”：请求最后 N 字节
  if (match[1] === "") {
    // 解析后缀长度
    const suffix = Number(match[2])
    // 后缀为 0 或文件为空则范围不可满足
    if (suffix === 0 || size === 0) return "unsatisfiable"
    // 起点 = 文件大小减去后缀（不小于 0），终点为最后一个字节
    return { start: Math.max(size - suffix, 0), end: size - 1 }
  }
  // 解析显式起点
  const start = Number(match[1])
  // 结束缺省时为文件最后一个字节
  const end = match[2] === "" ? size - 1 : Number(match[2])
  // 起点大于终点或起点超出文件则不可满足
  if (start > end || start >= size) return "unsatisfiable"
  // 终点钳制在文件末尾内
  return { start, end: Math.min(end, size - 1) }
}
